'use strict';
/**
 * 收集端（Cloudflare Worker）测试。
 *
 * Worker 是「失败自动上报」的另一半：客户端只保证 POST 出去，
 * 收不收得住、会不会被刷、邮箱有没有转发，全在这里守住。
 * 用 Node 自带的 Request/Response + 一个内存 KV 就能跑，不需要 wrangler。
 */
const assert = require('assert');

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

/** 最小 KV 替身：只需要 get/put/list */
class MockKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k).value : null; }
  async put(k, v, opts) { this.map.set(k, { value: String(v), opts }); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
    return { keys: keys.map((name) => ({ name })) };
  }
}

const REPORT = {
  signature: 'abc123def456',
  version: '0.6.1',
  at: '2026-11-16T00:00:00.000Z',
  code: 'TIMEOUT',
  title: '没有硬件加速',
  exitCode: null,
  facts: { cpuModel: 'Intel N4100', totalMB: 8192 },
  attempts: [{ plan: 'swangle / 硬件加速', diagnosis: 'TIMEOUT', timeout: true }],
  summary: '### 开机失败报告\n\n| 项目 | 值 |\n| --- | --- |\n| CPU | Intel N4100 |',
};

const post = (body, ip = '1.1.1.1', url = 'https://w.dev/') => new Request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

(async () => {
  const { handle } = await import('../collector/worker.mjs');
  const env = { REPORTS: new MockKV(), ADMIN_TOKEN: 'secret-token' };

  await test('健康检查', async () => {
    const res = await handle(new Request('https://w.dev/health'), env);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
  });

  await test('提交合法报告：入库 + 90 天过期', async () => {
    const res = await handle(post(REPORT, '2.2.2.2'), env);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    const stored = await env.REPORTS.get(`report:${body.id}`);
    assert(stored, '报告没有写进 KV');
    const parsed = JSON.parse(stored);
    assert.strictEqual(parsed.signature, REPORT.signature);
    const entry = env.REPORTS.map.get(`report:${body.id}`);
    assert(entry.opts && entry.opts.expirationTtl >= 86400 * 30, '缺少过期时间，KV 会一直涨');
  });

  await test('缺 summary 直接拒绝', async () => {
    const res = await handle(post({ version: '0.6.1' }, '3.3.3.3'), env);
    assert.strictEqual(res.status, 400);
  });

  await test('非法 JSON 不会把 Worker 打崩', async () => {
    const res = await handle(post('{不是 json', '4.4.4.4'), env);
    assert.strictEqual(res.status, 400);
  });

  await test('超大请求体被拒（413）', async () => {
    const big = { ...REPORT, summary: 'x'.repeat(300 * 1024) };
    const res = await handle(post(big, '5.5.5.5'), env);
    assert.strictEqual(res.status, 413);
  });

  await test('同一 IP 连发被限流（429）', async () => {
    const first = await handle(post(REPORT, '6.6.6.6'), env);
    assert.strictEqual(first.status, 200);
    const second = await handle(post(REPORT, '6.6.6.6'), env);
    assert.strictEqual(second.status, 429);
    // 换一个 IP 不受影响
    const other = await handle(post(REPORT, '7.7.7.7'), env);
    assert.strictEqual(other.status, 200);
  });

  await test('管理接口要 token', async () => {
    const no = await handle(new Request('https://w.dev/reports'), env);
    assert.strictEqual(no.status, 403);
    const ok = await handle(new Request('https://w.dev/reports?token=secret-token'), env);
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert(body.keys.length >= 1, '列表为空');
    assert(body.keys.every((k) => k.startsWith('report:')), '列表里混进了限流键');
  });

  await test('单条报告要 token，拿到的是原文', async () => {
    const listed = await (await handle(new Request('https://w.dev/reports?token=secret-token'), env)).json();
    const key = listed.keys[0];
    const id = key.slice('report:'.length);
    const no = await handle(new Request(`https://w.dev/r/${encodeURIComponent(id)}`), env);
    assert.strictEqual(no.status, 403);
    const ok = await handle(new Request(`https://w.dev/r/${encodeURIComponent(id)}?token=secret-token`), env);
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert(body.summary.includes('开机失败报告'));
  });

  await test('未知路径 404', async () => {
    const res = await handle(new Request('https://w.dev/nope'), env);
    assert.strictEqual(res.status, 404);
  });

  await test('配了 Resend 就转发邮件，没配就静默跳过', async () => {
    const calls = [];
    const env2 = {
      REPORTS: new MockKV(),
      RESEND_API_KEY: 'rk',
      MAIL_TO: 'dev@example.com',
      fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); },
    };
    await handle(post(REPORT, '8.8.8.8'), env2);
    assert.strictEqual(calls.length, 1, '应发一封邮件');
    assert.strictEqual(calls[0].url, 'https://api.resend.com/emails');
    const mail = JSON.parse(calls[0].init.body);
    assert.deepStrictEqual(mail.to, ['dev@example.com']);
    assert(mail.subject.includes('TIMEOUT'), '邮件标题要能一眼看出结论');

    const calls2 = [];
    const env3 = { REPORTS: new MockKV(), fetchImpl: async (u, i) => { calls2.push(u); return new Response(''); } };
    await handle(post(REPORT, '9.9.9.9'), env3);
    assert.strictEqual(calls2.length, 0, '没配 Resend 不该发请求');
  });

  if (fails.length) {
    console.log(`\n收集端测试：${passed} 通过，${fails.length} 失败`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`收集端测试：${passed} 项全部通过`);
})();

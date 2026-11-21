'use strict';
/**
 * 失败上报测试。
 *
 * 守三件事：
 *   1. 脱敏必须真的生效（用户名/家目录不能出现在要发出去的内容里）；
 *   2. 预填的 issue 地址必须能被 GitHub 接受（长度有上限、标题正文都编码）；
 *   3. 同一台机器同一个结论要有稳定签名，供「24 小时内不重复生成」使用。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

const report = require('../src/core/report');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

const facts = {
  cpuModel: 'Intel(R) Celeron(R) N4100 CPU @ 1.10GHz',
  vendor: 'QEMU',
  vm: true,
  cores: 4,
  totalMB: 8192,
  freeMB: 3000,
  arch: 'x64',
  osRelease: '10.0.19045',
  accel: { ok: false, kind: '', note: '' },
  image: { api: '34', tag: 'google_apis_playstore', compat: true },
  freeDiskMB: 20000,
};
const diagnosis = { code: 'TIMEOUT', title: '没有硬件加速，纯软件模拟在 4 分钟内开不完机', hint: '开虚拟机平台或装 AEHD' };
const attempts = [
  { plan: 'swangle / 硬件加速', diagnosis: 'TIMEOUT', timeout: true },
  { plan: '保守冷启动（最小内存 + 清快照）', diagnosis: 'TIMEOUT', timeout: true },
];

test('脱敏：家目录与 C:\\Users\\<name> 都被替换', () => {
  const home = 'C:\\Users\\lenmo';
  const text = `错误发生在 ${home}\\AppData\\Roaming\\apkstart\\logs\\emulator.log\n以及 c:\\users\\LENMO\\x 和 ${home.replace(/\\/g, '/')}/y`;
  const out = report.redact(text, { home, tmp: 'C:\\Users\\lenmo\\AppData\\Local\\Temp' });
  assert(!/lenmo/i.test(out), `仍有用户名：${out}`);
  assert(out.includes('%USERPROFILE%'), '缺少占位符');
});

test('摘要包含关键字段，且不含用户名路径', () => {
  const text = report.buildSummary({ facts, diagnosis, attempts, exitCode: null, logLines: [] });
  for (const key of ['版本', '结论', '系统', 'CPU', '内存', '硬件加速', '运行环境', '系统镜像', '退出码']) {
    assert(text.includes(key), `缺字段：${key}`);
  }
  assert(/虚拟机/.test(text), '应标出虚拟机环境');
  assert(/超时/.test(text), '应保留每轮尝试的超时标记');
});

test('日志裁剪：只留末尾、有上限', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
  const out = report.clipLog(lines);
  assert(out.split('\n').length <= 61, '行数没截住');
  assert(out.length <= 2300, `字符数没截住：${out.length}`);
  assert(out.includes('line 499'), '没保留末尾');
});

test('日志裁剪：剥 ANSI、省略密钥长串，末尾的退出行不会被挤掉', () => {
  // 真实现场：一条 androidboot.qemu.adb.pubkey 约 700 字符，日志里还会出现两次，
  // 2200 字符的预算被它吃掉近 1/3 —— 用户报告里最后一行恰好落在 veritymode，
  // 真正有用的 `emulator exit 1` 反而看不见了。
  const pub = `\u001b[0;39mINFO         |   androidboot.qemu.adb.pubkey=${'A'.repeat(700)}`;
  const lines = [
    pub,
    '\u001b[0;39mINFO         | Userspace boot properties:',
    '\u001b[0;39mINFO         |   androidboot.veritymode=enforcing',
    pub,
    '\u001b[33mWARNING      | No adb private key exists',
    'emulator exit 1（启动参数或环境错误）',
  ];
  const out = report.clipLog(lines);
  assert(!/\u001b\[/.test(out), 'ANSI 颜色码没剥掉');
  assert(out.includes('emulator exit 1'), '末尾的退出行被长行挤掉了');
  assert(!/A{100}/.test(out), 'pubkey 没有省略');
  assert(out.length <= 2300, `字符数没截住：${out.length}`);
});

test('单行压缩：密钥省略、超长行标注省略了多少字符', () => {
  const line = report.shrinkLine(`androidboot.qemu.adb.pubkey=${'B'.repeat(300)}`);
  assert(/pubkey=…/.test(line), `pubkey 应被省略：${line.slice(0, 40)}`);
  const long = report.shrinkLine('x'.repeat(400));
  assert(long.length <= 280, `超长行没截断：${long.length}`);
  assert(/本行还有 \d+ 字符/.test(long), '要标注省略了多少');
});

test('issue 地址：仓库正确、标题正文编码、总长可控', () => {
  const summary = report.buildSummary({ facts, diagnosis, attempts, exitCode: 3221225501, logLines: ['a'.repeat(100)] });
  const url = report.issueUrl({ summary, repo: 'yuchen0x1/apkstart', version: '0.6.1' });
  assert(url.startsWith('https://github.com/yuchen0x1/apkstart/issues/new?'), url.slice(0, 60));
  assert(url.includes('title=') && url.includes('body='));
  assert(url.length < 8000, `地址过长：${url.length}`);
  assert(!/\s/.test(url), '地址里不能有裸空格');
});

test('中文和 emoji 报告按编码后的 URL 长度截断，保留可读正文', () => {
  const summary = '诊断摘要🧪'.repeat(1500);
  const url = report.issueUrl({ summary, repo: 'yuchen0x1/apkstart', version: '1.2.3' });
  assert(url.length <= 7800);
  const body = new URL(url).searchParams.get('body');
  assert(body.length > 500 && summary.startsWith(body));
  assert(!body.includes('\ufffd'));
});

test('邮件兜底：没配邮箱就不给 mailto', () => {
  assert.strictEqual(report.mailtoUrl({ summary: 'x', email: '' }), '');
  const url = report.mailtoUrl({ summary: '内容', email: 'dev@example.com', version: '0.6.1' });
  assert(url.startsWith('mailto:dev%40example.com?'), url);
  assert(url.includes('subject='), '缺主题');
  const clipped = new URL(report.mailtoUrl({ email: 'dev@example.com', summary: 'x'.repeat(3499) + '🧪' })).searchParams.get('body');
  assert.strictEqual(clipped, 'x'.repeat(3499), '不能截断 emoji 产生替代字符');
});

test('签名稳定：同机同结论一致，换结论/换机器就变', () => {
  const a = report.signature({ facts, diagnosis, version: '0.6.1' });
  const b = report.signature({ facts, diagnosis, version: '0.6.1' });
  const c = report.signature({ facts, diagnosis: { code: 'ACCEL' }, version: '0.6.1' });
  const d = report.signature({ facts: { ...facts, cpuModel: 'AMD Ryzen 5' }, diagnosis, version: '0.6.1' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.notStrictEqual(a, d);
});

test('报告包：id 带签名、payload 可直接 POST、摘要已脱敏', () => {
  const home = os.homedir();
  const b = report.buildBundle({
    facts,
    diagnosis,
    attempts,
    exitCode: null,
    logLines: [`ERROR 打不开 ${home}\\AppData\\Local\\apkstart\\emulator.log`],
    home,
    tmp: path.join(home, 'AppData', 'Local', 'Temp'),
    reportFile: '',
  });
  assert(b.id.includes(b.signature), 'id 应包含签名');
  assert.strictEqual(b.code, 'TIMEOUT');
  assert(!b.summary.includes(home), '摘要里还有家目录');
  assert(b.payload && b.payload.signature === b.signature, 'payload 缺签名');
  assert(b.payload.summary === b.summary, 'payload 摘要与提交内容应一致');
  assert(b.issueUrl.includes('/issues/new'), '缺 issue 地址');
});

test('空上下文也能产出（不能因为没日志就崩）', () => {
  const b = report.buildBundle({});
  assert(b.id && b.summary && b.code === 'UNKNOWN');
  assert(b.issueUrl.startsWith('https://github.com/'), '仓库地址应从 package.json 兜底');
});

test('出站结构化字段采用白名单，完整路径和自定义镜像来源仅留本机', () => {
  const privatePath = 'D:\\PrivateVault\\runtime';
  const input = {
    facts: { ...facts, runtimeDir: privatePath, unexpected: 'NOT_FOR_NETWORK', image: { api: '34', custom: true, name: 'Private image', tag: 'private-label', source: 'https://private.example/image?token=short', reason: privatePath } },
    diagnosis: { ...diagnosis, title: `${privatePath} 启动失败` },
    attempts: [{ plan: '软件渲染', diagnosis: `${privatePath} 未就绪`, args: ['SECRET_ARG'], log: 'SECRET_LOG', exitCode: 1, timeout: true }],
    logLines: [`ERROR ${privatePath}\\emulator.log`],
  };
  const before = JSON.stringify(input);
  const b = report.buildBundle(input);
  const outgoing = JSON.stringify(b.payload);
  for (const value of [privatePath, 'NOT_FOR_NETWORK', 'private.example', 'Private image', 'private-label', 'SECRET_ARG', 'SECRET_LOG']) assert(!outgoing.includes(value), value);
  assert.strictEqual(b.payload.attempts[0].exitCode, 1);
  assert(b.payload.attempts[0].timeout);
  assert.strictEqual(b.payload.facts.image.api, '34');
  assert.strictEqual(JSON.stringify(input), before, '不能修改本地完整诊断信息');
});

test('脱敏覆盖 JSON、短凭证、认证头、URL 凭证与私钥', () => {
  const values = ['short-secret', 'short-token', 'abc123', 'bearer-key', 'basic-key', 'credential-user', 'credential-pass', 'signed-value', 'PRIVATE-MATERIAL', 'second-cookie', 'quoted-tail', 'signed-v4'];
  const raw = [
    'password="short-secret"', '{"token":"short-token"}', 'api_key=abc123',
    'Authorization: Bearer bearer-key', 'Authorization: Basic basic-key',
    'Cookie: session=first-cookie; auth=second-cookie',
    '{"password":"prefix\\\" quoted-tail"}',
    'https://example.org/image?X-Amz-Signature=signed-v4',
    'https://credential-user:credential-pass@example.org/file?signature=signed-value&ok=yes',
    '-----BEGIN PRIVATE KEY-----\nPRIVATE-MATERIAL\n-----END PRIVATE KEY-----',
  ].join('\n');
  const out = report.redact(raw);
  for (const value of values) assert(!out.includes(value), value);
  assert(out.includes('ok=yes'), '保留非敏感诊断信息');
  assert(out.includes('[REDACTED]'));
});

test('Cookie 的 JSON 数组、折行和 ANSI 格式在出站摘要前整段擦除', () => {
  const raw = [
    JSON.stringify({ 'set-cookie': ['sid=first-private; HttpOnly', 'sid=second-private; HttpOnly'], keep: 'diagnostic-value' }),
    '{"cookie": [\n  "session=array-private",\n  "other=array-other-private"\n]}',
    'Cookie: first=fold-private;\r\n\tsecond=fold-second-private\r\nnext diagnostic',
    'Cookie\u001b[0m: session=ansi-private',
  ];
  const b = report.buildBundle({ logLines: raw });
  const out = JSON.stringify(b.payload);
  for (const secret of ['first-private', 'second-private', 'array-private', 'array-other-private', 'fold-private', 'fold-second-private', 'ansi-private']) assert(!out.includes(secret), secret);
  assert(out.includes('diagnostic-value'));
  assert(out.includes('next diagnostic'));
});

test('摘要、payload、预填链接全部脱敏且不暴露邮件里的本地附件路径', () => {
  const b = report.buildBundle({
    facts: { ...facts, cpuModel: '/home/alex/private-cpu' },
    diagnosis: { code: 'ERROR', title: 'password=short-value' },
    attempts: [{ plan: 'token=short-token' }],
    logLines: ['https://u:p@example.org/x?access_token=private-token', 'C:/Users/other/AppData/log'],
    reportFile: '/private/LOCAL-FULL-REPORT.txt',
  });
  for (const value of ['alex', 'other', 'short-value', 'short-token', 'private-token', 'LOCAL-FULL-REPORT']) {
    const outgoing = JSON.stringify({ summary: b.summary, payload: b.payload, issue: decodeURIComponent(b.issueUrl), mail: decodeURIComponent(b.mailtoUrl) });
    assert(!outgoing.includes(value), value);
  }
  const mail = report.mailtoUrl({ summary: b.summary, email: 'dev@example.org', reportFile: '/private/LOCAL-FULL-REPORT.txt' });
  assert(!decodeURIComponent(mail).includes('LOCAL-FULL-REPORT'));
  assert.strictEqual(b.reportFile, '/private/LOCAL-FULL-REPORT.txt', '完整本地报告仍可找到');
});

test('报告限制尝试数量、异常字段与非有限数字，支持 Linux 系统名', () => {
  const b = report.buildBundle({ facts: { platform: 'linux', accel: null, image: null, cores: Infinity }, attempts: [null, ...Array.from({ length: 30 }, () => ({ plan: 'x'.repeat(2000), secret: 'never-send' }))], exitCode: NaN });
  assert.strictEqual(b.payload.attempts.length, 12);
  assert.strictEqual(b.payload.facts.cores, 0);
  assert.strictEqual(b.payload.exitCode, null);
  assert(b.summary.includes('Linux'));
  assert(!b.summary.includes('Windows'));
  assert(b.payload.attempts.every((a) => a.plan.length <= 300 && !('secret' in a)));
});

if (fails.length) {
  console.log(`\n失败上报测试：${passed} 通过，${fails.length} 失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`失败上报测试：${passed} 项全部通过`);

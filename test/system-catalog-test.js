'use strict';
/** 系统目录测试：加载、校验、缓存回退、离线降级、不伪造资源。纯 Node，不依赖 Electron/网络。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemCatalog, normalizeCatalog, CACHE_TTL_MS, RETRY_COOLDOWN_MS } = require('../src/core/system-catalog');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ': ' + e.message); console.error('  ✗ ' + name + '\n    ' + e.message); }
}
const asyncTests = [];
function atest(name, fn) { asyncTests.push([name, fn]); }

const ROOT = path.join(__dirname, '..');

test('normalizeCatalog: 合法目录通过', () => {
  const r = normalizeCatalog({
    schema: 1, updatedAt: '2026-01-01', systems: [
      { id: 'x', name: 'X', versions: [{ version: '1', status: 'available', downloadUrl: 'https://a/b.iso', sha256: 'a'.repeat(64) }] },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.catalog.systems.length, 1);
});

test('normalizeCatalog: 标记可下载但无 HTTPS 地址→降级 unavailable（不伪造）', () => {
  const r = normalizeCatalog({
    systems: [{ id: 'x', versions: [{ version: '1', status: 'available', downloadUrl: 'http://insecure/a.iso' }] }],
  });
  assert.strictEqual(r.catalog.systems[0].versions[0].status, 'unavailable');
  assert.ok(r.warnings.length > 0);
});

test('normalizeCatalog: 非法 sha256 被清空', () => {
  const r = normalizeCatalog({
    systems: [{ id: 'x', versions: [{ status: 'available', downloadUrl: 'https://a/b', sha256: 'not-a-hash' }] }],
  });
  assert.strictEqual(r.catalog.systems[0].versions[0].sha256, '');
});

test('内置目录：三个第三方系统齐全，LineageOS 无预构建', () => {
  const cat = new SystemCatalog({ appRoot: ROOT });
  const builtIn = require('../src/system-catalog/catalog.json');
  const ids = builtIn.systems.map((s) => s.id);
  assert.ok(ids.includes('lineageos') && ids.includes('bliss-os') && ids.includes('android-x86'));
  const lin = builtIn.systems.find((s) => s.id === 'lineageos').versions[0];
  assert.strictEqual(lin.status, 'unavailable');
  assert.strictEqual(lin.downloadUrl, '');
});

test('内置目录：Bliss / Android-x86 有真实 HTTPS + 64 位 SHA-256', () => {
  const b = require('../src/system-catalog/catalog.json');
  for (const id of ['bliss-os', 'android-x86']) {
    const v = b.systems.find((s) => s.id === id).versions[0];
    assert.ok(/^https:\/\//.test(v.downloadUrl), id + ' 需 HTTPS');
    assert.strictEqual(v.sha256.length, 64, id + ' sha256 位数');
    assert.ok(v.fileSize > 100 * 1024 * 1024, id + ' 文件大小合理');
  }
});

test('目录 JSON 与内置副本一致', () => {
  const a = require('../system-catalog/catalog.json');
  const b = require('../src/system-catalog/catalog.json');
  assert.strictEqual(a.systems.length, b.systems.length);
  assert.strictEqual(a.updatedAt, b.updatedAt);
});

atest('远程失败→回退内置索引', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-cat-'));
  const cat = new SystemCatalog({
    appRoot: ROOT, dataDir: dir,
    fetchJson: async () => { throw new Error('网络不可达'); },
  });
  const r = await cat.load();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'built-in');
  assert.strictEqual(r.catalog.systems.length, 3);
});

atest('远程成功→写缓存→再次远程失败回退缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-cat-'));
  let call = 0;
  const good = require('../system-catalog/catalog.json');
  const cat = new SystemCatalog({
    appRoot: ROOT, dataDir: dir,
    fetchJson: async () => { call += 1; if (call === 1) return good; throw new Error('down'); },
  });
  const r1 = await cat.load();
  assert.strictEqual(r1.stale, false);
  assert.ok(fs.existsSync(cat.cacheFile));
  const cat2 = new SystemCatalog({
    appRoot: ROOT, dataDir: dir,
    fetchJson: async () => { throw new Error('down'); },
  });
  const r2 = await cat2.load();
  assert.strictEqual(r2.source, cat2.url);
  assert.strictEqual(r2.stale, true);
  assert.strictEqual(r2.catalog.systems.length, 3);
});

atest('getAvailability / getDownloadInfo 语义', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-cat-'));
  const cat = new SystemCatalog({ appRoot: ROOT, dataDir: dir, fetchJson: async () => { throw new Error('x'); } });
  const lineage = await cat.getLatest('lineageos');
  assert.strictEqual(lineage.status, 'unavailable');
  const ax86 = await cat.getLatest('android-x86');
  assert.strictEqual(ax86.status, 'available');
  assert.ok(/^https:/.test(ax86.downloadUrl));
  const all = await cat.listAll();
  assert.strictEqual(all.systems.length, 7); // 4 内置 + 3 目录
});

async function withCatalogClock(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-cat-clock-'));
  let now = Date.parse('2026-11-21T00:00:00Z');
  try {
    await fn({
      dataDir: dir,
      now: () => now,
      advance: (ms) => { now += ms; },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

atest('内存目录在六小时边界过期，状态查询不继续声称新鲜', async () => {
  await withCatalogClock(async ({ dataDir, now, advance }) => {
    let calls = 0;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: async () => ({
      systems: [], updatedAt: `revision-${++calls}`,
    }) });
    const first = await cat.load();
    assert.strictEqual(cat.cacheInfo().stale, false);
    advance(CACHE_TTL_MS - 1);
    assert.strictEqual((await cat.load()).cachedAt, first.cachedAt);
    assert.strictEqual(calls, 1);
    advance(1);
    assert.strictEqual(cat.cacheInfo().stale, true);
    const next = await cat.load();
    assert.strictEqual(calls, 2);
    assert.strictEqual(next.catalog.updatedAt, 'revision-2');
    assert.strictEqual(next.stale, false);
    assert.strictEqual(next.cachedAt, new Date(now()).toISOString());
    const meta = JSON.parse(fs.readFileSync(cat.metaFile, 'utf8'));
    assert.strictEqual(meta.cachedAt, next.cachedAt);
  });
});

atest('离线连续读取只尝试一次，冷却到期自动恢复远程目录', async () => {
  await withCatalogClock(async ({ dataDir, now, advance }) => {
    let calls = 0;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { systems: [], updatedAt: 'recovered' };
    } });
    const first = await cat.load();
    assert.strictEqual(first.source, 'built-in');
    assert.strictEqual(first.stale, true);
    assert.strictEqual(first.error, 'offline');
    for (let i = 0; i < 20; i += 1) await cat.listAll();
    advance(60 * 1000 - 1);
    await cat.load();
    assert.strictEqual(calls, 1, '离线轮询不应反复请求远程目录');
    assert.strictEqual(RETRY_COOLDOWN_MS, 60 * 1000);
    advance(1);
    const recovered = await cat.load();
    assert.strictEqual(calls, 2);
    assert.strictEqual(recovered.catalog.updatedAt, 'recovered');
    assert.strictEqual(recovered.stale, false);
    assert.strictEqual(recovered.error, undefined);
  });
});

atest('显式刷新绕过新鲜缓存和离线冷却', async () => {
  await withCatalogClock(async ({ dataDir, now }) => {
    let calls = 0;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: async () => {
      calls += 1;
      if (calls === 2) throw new Error('temporary failure');
      return { systems: [], updatedAt: `revision-${calls}` };
    } });
    await cat.load();
    const failed = await cat.load({ force: true });
    assert.strictEqual(calls, 2);
    assert.strictEqual(failed.stale, true);
    const retried = await cat.load({ force: true });
    assert.strictEqual(calls, 3);
    assert.strictEqual(retried.stale, false);
    assert.strictEqual(retried.catalog.updatedAt, 'revision-3');
  });
});

atest('缓存不能写盘时，过期刷新失败仍保留最近成功目录而非退回内置', async () => {
  await withCatalogClock(async ({ dataDir, now, advance }) => {
    let calls = 0;
    // 用真实的路径类型冲突触发 mkdir 失败，不依赖管理员/ACL 权限。
    const blocked = path.join(dataDir, 'blocked-cache');
    fs.writeFileSync(blocked, 'keep-existing-file');
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir: blocked, now, fetchJson: async () => {
      if (++calls > 1) throw new Error('offline');
      return { systems: [{ id: 'latest-only', versions: [] }], updatedAt: 'recent' };
    } });
    const first = await cat.load();
    assert.strictEqual(fs.existsSync(cat.cacheFile), false);
    assert.strictEqual(first.stale, false);
    advance(CACHE_TTL_MS);
    const fallback = await cat.load();
    assert.strictEqual(calls, 2);
    assert.strictEqual(fallback.stale, true);
    assert.strictEqual(fallback.error, 'offline');
    assert.strictEqual(fallback.source, cat.url);
    assert.strictEqual(fallback.cachedAt, first.cachedAt);
    assert.strictEqual(fallback.catalog.systems[0].id, 'latest-only');
    assert.strictEqual(fs.readFileSync(blocked, 'utf8'), 'keep-existing-file');
  });
});

atest('同批并发读取与强制刷新共用一个远程请求，结算后仍可再次刷新', async () => {
  await withCatalogClock(async ({ dataDir, now }) => {
    let calls = 0;
    let finish;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    } });
    const readers = Array.from({ length: 20 }, (_, i) => cat.load({ force: i % 2 === 0 }));
    assert.strictEqual(calls, 1);
    finish({ systems: [], updatedAt: 'first' });
    const results = await Promise.all(readers);
    assert.ok(results.every((r) => r.catalog.updatedAt === 'first' && !r.stale));
    const refresh = cat.load({ force: true });
    assert.strictEqual(calls, 2);
    finish({ systems: [], updatedAt: 'second' });
    assert.strictEqual((await refresh).catalog.updatedAt, 'second');
  });
});

atest('新鲜缓存存在时，普通读取等待正在执行的显式刷新', async () => {
  await withCatalogClock(async ({ dataDir, now }) => {
    let calls = 0;
    let finish;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: () => {
      if (++calls === 1) return Promise.resolve({ systems: [], updatedAt: 'initial' });
      return new Promise((resolve) => { finish = resolve; });
    } });
    await cat.load();
    const refresh = cat.load({ force: true });
    const reader = cat.load();
    assert.strictEqual(calls, 2);
    finish({ systems: [], updatedAt: 'refreshed' });
    const results = await Promise.all([refresh, reader]);
    assert.ok(results.every((r) => r.catalog.updatedAt === 'refreshed'));
  });
});

atest('并发失败后清除在途请求，不延长冷却，恢复后清除错误', async () => {
  await withCatalogClock(async ({ dataDir, now, advance }) => {
    let calls = 0;
    let fail;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: () => {
      if (++calls === 1) return new Promise((_, reject) => { fail = reject; });
      return Promise.resolve({ systems: [], updatedAt: `recovered-${calls}` });
    } });
    const readers = Array.from({ length: 20 }, () => cat.load());
    assert.strictEqual(calls, 1);
    fail(new Error('network interrupted'));
    const results = await Promise.all(readers);
    assert.ok(results.every((r) => r.stale && r.error === 'network interrupted'));
    advance(RETRY_COOLDOWN_MS - 1);
    await cat.load();
    assert.strictEqual(calls, 1);
    advance(1);
    const recovered = await cat.load();
    assert.strictEqual(calls, 2, '失败请求必须释放在途锁，读取不能延长冷却');
    assert.strictEqual(recovered.stale, false);
    assert.strictEqual(recovered.error, undefined);
    advance(CACHE_TTL_MS - 1);
    await cat.load();
    assert.strictEqual(calls, 2);
    advance(1);
    assert.strictEqual((await cat.load()).catalog.updatedAt, 'recovered-3');
  });
});

atest('时钟回拨不能让未来时间戳缓存永久保鲜，也不延长离线冷却', async () => {
  await withCatalogClock(async ({ dataDir, now, advance }) => {
    let calls = 0;
    const cat = new SystemCatalog({ appRoot: ROOT, dataDir, now, fetchJson: async () => {
      calls += 1;
      if (calls === 2) throw new Error('offline');
      return { systems: [], updatedAt: `revision-${calls}` };
    } });
    await cat.load();
    advance(-1);
    assert.strictEqual(cat.cacheInfo().stale, true);
    assert.strictEqual((await cat.load()).stale, true);
    assert.strictEqual(calls, 2);
    advance(-1);
    assert.strictEqual((await cat.load()).stale, false);
    assert.strictEqual(calls, 3);
  });
});

(async () => {
  console.log('\n[system-catalog]');
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed += 1; console.log('  ✓ ' + name); }
    catch (e) { fails.push(name + ': ' + e.message); console.error('  ✗ ' + name + '\n    ' + e.message); }
  }
  const total = passed + fails.length;
  console.log(`\n${fails.length ? '✗' : '✓'} system-catalog 测试：${passed}/${total} 通过`);
  if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
})();

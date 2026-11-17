'use strict';
/** 系统目录测试：加载、校验、缓存回退、离线降级、不伪造资源。纯 Node，不依赖 Electron/网络。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemCatalog, normalizeCatalog } = require('../src/core/system-catalog');

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

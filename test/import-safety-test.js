'use strict';
// 纯离线回归；所有 APK/ZIP/镜像夹具均写入唯一临时目录。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-import-safety-'));
process.env.APPDATA = path.join(ROOT, 'data');
process.env.XDG_DATA_HOME = path.join(ROOT, 'data');
const store = require('../src/core/store');
const manifest = require('../src/core/image-manifest');
const { ImageStore, copyDir } = require('../src/core/images');
const { Provisioner } = require('../src/core/provision');
const backup = require('../src/core/backup');
const { buildZip } = require('./lib/zip-writer');
const { buildApkBytes } = require('./lib/make-apk');
const { crc32, ZipFile } = require('../src/core/zip');
const { Writable } = require('stream');
let passed = 0;
let failed = 0;
let seq = 0;
function temp(name) { const p = path.join(ROOT, `${++seq}-${name}`); fs.mkdirSync(p, { recursive: true }); return p; }
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack || e}`); }
}
function image(dir, id = 'safe-image') {
  fs.mkdirSync(dir, { recursive: true });
  const file = (name, size, magic, offset = 0) => {
    const fd = fs.openSync(path.join(dir, name), 'w');
    try { fs.writeSync(fd, magic, 0, magic.length, offset); fs.ftruncateSync(fd, size); }
    finally { fs.closeSync(fd); }
  };
  file('system.img', 66 * 1048576, Buffer.from([0x53, 0xef]), 0x438);
  file('vendor.img', 5 * 1048576, Buffer.from([0x53, 0xef]), 0x438);
  file('kernel-ranchu', 300 * 1024, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
  file('ramdisk.img', 70 * 1024, Buffer.from([0x1f, 0x8b, 8, 0]));
  fs.writeFileSync(path.join(dir, manifest.MANIFEST_NAME), JSON.stringify({ id, name: id, api: 34, abi: 'x86_64' }));
}
function imageStore(root, source) {
  const zip = path.join(root, 'source.zip'); fs.writeFileSync(zip, 'PK-fixture');
  return { zip, st: new ImageStore({ root, extractZip: async (_zip, dest) => copyDir(source, dest) }) };
}
function backupFixture(meta = {}) {
  const dir = temp('backup');
  fs.writeFileSync(path.join(dir, 'app.apk'), buildApkBytes({ packageName: 'com.example.demo' }));
  fs.writeFileSync(path.join(dir, 'data.tar'), Buffer.alloc(4096));
  backup.writeMeta(dir, { package: 'com.example.demo', apk: 'app.apk', data: 'data.tar', ...meta });
  const calls = [];
  return { dir, calls, installer: { async install(file) { calls.push(['install', file]); return { app: { package: 'com.example.demo' } }; } }, client: {
    async shell(cmd) { calls.push(['shell', cmd]); return 'uid=10001'; },
    async push(file, remote) { calls.push(['push', file, remote]); },
    async exec(args) { calls.push(['exec', args]); return { stdout: Buffer.alloc(0) }; },
  } };
}
function poisonedZip(name, data, { deflate = false, badSize = false } = {}) {
  const zip = buildZip([{ name, data }]);
  const cen = 30 + Buffer.byteLength(name) + data.length;
  if (!deflate) {
    if (badSize) zip.writeUInt32LE(data.length + 1, cen + 24);
    else zip[30 + Buffer.byteLength(name)] ^= 1;
    return zip;
  }
  const compressed = zlib.deflateRawSync(data);
  const local = Buffer.from(zip.subarray(0, 30 + Buffer.byteLength(name)));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18);
  const central = Buffer.from(zip.subarray(cen, zip.length - 22));
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
  const end = Buffer.from(zip.subarray(zip.length - 22));
  end.writeUInt32LE(local.length + compressed.length, 16);
  // 重新压缩污染后的正文：deflate 仍有效，只能靠 CRC 检出。
  const changed = Buffer.from(data); changed[0] ^= 1;
  const damaged = zlib.deflateRawSync(changed);
  local.writeUInt32LE(damaged.length, 18); central.writeUInt32LE(damaged.length, 20);
  end.writeUInt32LE(local.length + damaged.length, 16);
  return Buffer.concat([local, damaged, central, end]);
}
(async () => {
  try {
    await test('manifest rejects dot, parent, Windows aliases and index.json', () => {
      for (const id of ['.', '..', '...', 'safe.', 'safe ', 'CON', 'con.txt', 'CON .txt', 'NUL', 'COM1', 'COM¹.log', 'LPT9.log', 'index.json', 'INDEX.JSON.']) {
        assert.equal(manifest.validate(manifest.normalize({ id, api: 34, abi: 'x86_64' })).ok, false, id);
      }
    });
    await test('managed id=.. failure never deletes runtime sentinel', async () => {
      const root = temp('runtime'); const src = temp('source'); image(src, '..');
      const sentinel = path.join(root, 'sentinel'); fs.writeFileSync(sentinel, 'keep');
      const { st, zip } = imageStore(root, src);
      await assert.rejects(st.import(zip), /id/);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
      assert.deepEqual(st.list(), []);
    });
    await test('failed replacement preserves index, previous image and active settings', async () => {
      const root = temp('runtime'); const src = temp('source'); image(src);
      const { st, zip } = imageStore(root, src);
      const first = await st.import(zip); st.activate(first.record.id);
      const index = fs.readFileSync(st.indexFile); const active = store.getSettings().runtime.activeImageId;
      const oldFile = path.join(first.record.dir, 'system.img');
      const write = st._writeRecords; st._writeRecords = () => { throw new Error('injected index failure'); };
      await assert.rejects(st.import(zip, { replace: true }), /injected/);
      st._writeRecords = write;
      assert.deepEqual(fs.readFileSync(st.indexFile), index); assert(fs.existsSync(oldFile));
      assert.equal(store.getSettings().runtime.activeImageId, active);
      st.restoreDefault();
    });
    await test('unindexed same-name directory is never removed on import', async () => {
      const root = temp('runtime'); const src = temp('source'); image(src);
      const existing = path.join(root, 'custom-images', 'safe-image'); fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, 'sentinel'), 'keep');
      const { st, zip } = imageStore(root, src); const r = await st.import(zip);
      assert.notEqual(r.record.id, 'safe-image'); assert.equal(fs.readFileSync(path.join(existing, 'sentinel'), 'utf8'), 'keep');
    });
    await test('custom-images junction/symlink cannot redirect import or delete', async () => {
      const root = temp('runtime'); const src = temp('source'); image(src);
      const outside = temp('outside'); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
      fs.symlinkSync(outside, path.join(root, 'custom-images'), process.platform === 'win32' ? 'junction' : 'dir');
      const { st, zip } = imageStore(root, src); await assert.rejects(st.import(zip), /链接|junction/);
      assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'keep');
      assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
    });
    await test('staging prefix sibling is not treated as owned temporary directory', async () => {
      const root = temp('runtime'); const sibling = path.join(root, '_tmp-other'); image(sibling, '..');
      fs.writeFileSync(path.join(sibling, 'sentinel'), 'keep');
      const src = path.join(root, 'custom.fixture'); fs.writeFileSync(src, 'fixture');
      const st = new ImageStore({ root }); st.register({ id: 'test', probe: () => true, read: () => ({ dir: sibling, managed: true, stagingDir: sibling }) }, { front: true });
      await assert.rejects(st.import(src), /id/); assert(fs.existsSync(path.join(sibling, 'sentinel')));
    });
    await test('explicit avdDir wins even when runtime is inside data directory', () => {
      const avd = path.join(ROOT, 'chosen-avd'); store.saveSettings({ runtime: { dir: path.join(store.DATA_DIR, 'runtime'), avdDir: avd } });
      assert.equal(new Provisioner(ROOT).paths().avdHome, avd);
    });
    await test('data-directory prefix sibling is outside; actual child is inside', () => {
      const p = new Provisioner(ROOT); store.saveSettings({ runtime: { dir: `${store.DATA_DIR}-other`, avdDir: '' } });
      assert.equal(p.paths().avdHome, path.join(store.DATA_DIR, 'avd'));
      store.saveSettings({ runtime: { dir: path.join(store.DATA_DIR, 'runtime'), avdDir: '' } });
      assert.equal(p.paths().avdHome, path.join(store.DATA_DIR, 'runtime', 'avd'));
    });
    for (const [label, bytes] of [
      ['small stored CRC contamination', poisonedZip('component.bin', Buffer.from('original component'))],
      ['small deflate CRC contamination', poisonedZip('component.bin', Buffer.from('original component'), { deflate: true })],
      ['small declared size mismatch', poisonedZip('component.bin', Buffer.from('original component'), { badSize: true })],
    ]) {
      await test(`${label} leaves existing file intact`, async () => {
        const dir = temp('zip'); const out = path.join(dir, 'out'); fs.mkdirSync(out);
        const file = path.join(out, 'component.bin'); fs.writeFileSync(file, 'existing-good');
        const zip = path.join(dir, 'fixture.zip'); fs.writeFileSync(zip, bytes);
        await assert.rejects(new Provisioner(ROOT).extractZip(zip, out), /CRC|大小/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'existing-good'); assert.deepEqual(fs.readdirSync(out), ['component.bin']);
      });
    }
    await test('valid small stored ZIP with directory entry remains usable', async () => {
      const dir = temp('zip'); const zip = path.join(dir, 'good.zip');
      fs.writeFileSync(zip, buildZip([{ name: 'platform-tools/', data: '' }, { name: 'platform-tools/adb.bin', data: 'normal fixture' }]));
      const out = path.join(dir, 'out'); await new Provisioner(ROOT).extractZip(zip, out);
      assert.equal(fs.readFileSync(path.join(out, 'platform-tools/adb.bin'), 'utf8'), 'normal fixture');
    });
    await test('streamed ZIP validation waits for destination close before cleanup', async () => {
      const dir = temp('zip'); const zipPath = path.join(dir, 'bad.zip');
      fs.writeFileSync(zipPath, buildZip([{ name: 'bad', data: 'damaged', crc: 123 }]));
      const zip = new ZipFile(zipPath);
      let closeCompleted = false;
      const dest = new Writable({
        write(_data, _encoding, callback) { callback(); },
        destroy(error, callback) {
          setTimeout(() => { closeCompleted = true; callback(error); }, 25);
        },
      });
      try {
        await assert.rejects(zip.pipeTo('bad', dest, { verify: true }), /CRC/);
        assert.equal(closeCompleted, true);
        assert.equal(dest.closed, true);
      } finally { zip.close(); }
    });
    await test('large streamed entry CRC failure leaves no output or staging files', async () => {
      const dir = temp('zip'); const zip = path.join(dir, 'big.zip'); const data = Buffer.alloc(65 * 1048576, 0x41);
      const bytes = buildZip([{ name: 'system.img', data }]); bytes[30 + Buffer.byteLength('system.img')] ^= 1;
      fs.writeFileSync(zip, bytes); const out = path.join(dir, 'out');
      await assert.rejects(new Provisioner(ROOT).extractZip(zip, out), /CRC/); assert.deepEqual(fs.readdirSync(out), []);
    });
    await test('valid large streamed entry remains usable', async () => {
      const dir = temp('zip'); const zip = path.join(dir, 'big.zip'); const data = Buffer.alloc(65 * 1048576, 0x42);
      fs.writeFileSync(zip, buildZip([{ name: 'system.img', data }])); const out = path.join(dir, 'out');
      await new Provisioner(ROOT).extractZip(zip, out); assert.equal(crc32(fs.readFileSync(path.join(out, 'system.img'))), crc32(data));
    });
    await test('ZIP extraction refuses existing destination junction', async () => {
      const dir = temp('zip'); const out = path.join(dir, 'out'); fs.mkdirSync(out);
      const external = temp('external'); fs.writeFileSync(path.join(external, 'sentinel'), 'keep');
      fs.symlinkSync(external, path.join(out, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const zip = path.join(dir, 'bad.zip'); fs.writeFileSync(zip, buildZip([{ name: 'escape/injected', data: 'bad' }]));
      await assert.rejects(new Provisioner(ROOT).extractZip(zip, out), /链接|junction/);
      assert.deepEqual(fs.readdirSync(external), ['sentinel']);
    });
    await test('backup rejects APK/data traversal before installer or device calls', async () => {
      for (const meta of [{ apk: '../app.apk' }, { apk: 'C:\\outside.apk' }, { data: '../outside.tar' }, { data: '..\\outside.tar' }, { data: '/outside.tar' }, { data: 'data.tar.' }]) {
        const f = backupFixture(meta); await assert.rejects(backup.restoreApp(f), /路径|越界/); assert.deepEqual(f.calls, [], JSON.stringify(meta));
      }
    });
    await test('backup APK package mismatch cannot install or touch another package data', async () => {
      const f = backupFixture({ package: 'com.example.other' });
      await assert.rejects(backup.restoreApp(f), /包名|package/); assert.deepEqual(f.calls, []);
    });
    await test('backup rejects symlink escape before installer or device calls', async () => {
      if (process.platform === 'win32') {
        // junction 无需开发者模式；用真实路径验证备份根的别名仍不会放宽文件名。
        const f = backupFixture({ data: '../outside.tar' });
        const aliasRoot = temp('alias'); const alias = path.join(aliasRoot, 'backup'); fs.symlinkSync(f.dir, alias, 'junction');
        await assert.rejects(backup.restoreApp({ ...f, dir: alias }), /路径|越界/); assert.deepEqual(f.calls, []);
        return;
      }
      for (const name of ['app.apk', 'data.tar', 'meta.json']) {
        const f = backupFixture(); const external = path.join(temp('external'), name);
        fs.renameSync(path.join(f.dir, name), external); fs.symlinkSync(external, path.join(f.dir, name));
        await assert.rejects(backup.restoreApp(f), /链接|越界/); assert.deepEqual(f.calls, []);
      }
    });
    await test('successful replacement publishes new managed root and removes only old copy', async () => {
      const root = temp('runtime'); const src = temp('source'); image(src);
      const { st, zip } = imageStore(root, src); const before = await st.import(zip);
      fs.writeFileSync(path.join(src, 'new-marker'), 'new');
      const after = await st.import(zip, { replace: true });
      assert.equal(after.record.id, before.record.id); assert.notEqual(after.record.dir, before.record.dir);
      assert.equal(fs.readFileSync(path.join(after.record.dir, 'new-marker'), 'utf8'), 'new');
      assert(!fs.existsSync(before.record.dir)); assert.equal(st.list().length, 1);
      st.remove(after.record.id); assert(!fs.existsSync(after.record.dir));
    });
    await test('checksum names cannot read absolute, traversal or junction sources', async () => {
      const dir = temp('checksum'); const external = temp('external'); const secret = path.join(external, 'secret');
      fs.writeFileSync(secret, 'outside'); fs.symlinkSync(external, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const st = new ImageStore({ root: temp('runtime') }); let reads = 0; st._hash = async () => { reads++; return 'a'.repeat(64); };
      for (const name of [secret, '../outside', '..\\outside', 'C:\\outside', 'linked/secret']) {
        const result = await st.verifyChecksums(dir, { [name]: `sha256:${'a'.repeat(64)}` });
        assert.equal(result.ok, false, name);
      }
      assert.equal(reads, 0);
    });
    await test('ZIP commit failure restores already replaced files', async () => {
      const dir = temp('zip'); const out = path.join(dir, 'out'); fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, 'first'), 'old-first'); fs.mkdirSync(path.join(out, 'second'));
      fs.writeFileSync(path.join(out, 'second', 'sentinel'), 'old-second');
      const zip = path.join(dir, 'good.zip'); fs.writeFileSync(zip, buildZip([{ name: 'first', data: 'new-first' }, { name: 'second', data: 'new-second' }]));
      await assert.rejects(new Provisioner(ROOT).extractZip(zip, out), /普通文件/);
      assert.equal(fs.readFileSync(path.join(out, 'first'), 'utf8'), 'old-first');
      assert.equal(fs.readFileSync(path.join(out, 'second', 'sentinel'), 'utf8'), 'old-second');
      assert.deepEqual(fs.readdirSync(out).sort(), ['first', 'second']);
    });
    await test('ZipFile CRC stream failure preserves shared fd for remaining entries', async () => {
      const dir = temp('zip'); const file = path.join(dir, 'bad.zip');
      fs.writeFileSync(file, buildZip([{ name: 'bad', data: 'damaged', crc: 123 }, { name: 'next', data: 'still-readable' }]));
      const zip = new ZipFile(file);
      try {
        await assert.rejects(zip.pipeTo('bad', new Writable({ write(_data, _enc, cb) { cb(); } }), { verify: true }), /CRC/);
        assert.equal(zip.read('next').toString(), 'still-readable');
      } finally { zip.close(); }
    });
    await test('memory ZIP large deflate CRC failure cleans partially streamed output', async () => {
      const dir = temp('zip'); const file = path.join(dir, 'bad.zip');
      fs.writeFileSync(file, poisonedZip('system.img', Buffer.alloc(65 * 1048576, 0x61), { deflate: true }));
      assert(fs.statSync(file).size < 64 * 1048576);
      const out = path.join(dir, 'out');
      await assert.rejects(new Provisioner(ROOT).extractZip(file, out), /CRC/); assert.deepEqual(fs.readdirSync(out), []);
    });
    await test('backup installed-package mismatch stops before any device data access', async () => {
      const f = backupFixture(); f.installer.install = async () => ({ app: { package: 'com.example.other' } });
      await assert.rejects(backup.restoreApp(f), /包名/); assert.deepEqual(f.calls, []);
    });
    await test('successful backup restore only targets the verified package', async () => {
      const f = backupFixture(); const r = await backup.restoreApp(f); assert.equal(r.dataRestored, true);
      const deviceCalls = JSON.stringify(f.calls.filter(([type]) => type !== 'install'));
      assert(deviceCalls.includes('com.example.demo')); assert(!deviceCalls.includes('com.example.other'));
      assert.equal(f.calls.filter(([type]) => type === 'install').length, 1);
    });
  } finally { fs.rmSync(ROOT, { recursive: true, force: true }); }
  console.log(`Import safety tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });

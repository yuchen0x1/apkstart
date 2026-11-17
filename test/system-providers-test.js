'use strict';
/** Provider 架构测试：统一接口、真实状态语义、设备隔离、QEMU 后端参数。纯 Node。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('../src/core/system-providers');
const { SystemCatalog } = require('../src/core/system-catalog');
const { QemuBackend } = require('../src/core/system-providers/qemu-backend');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ': ' + e.message); console.error('  ✗ ' + name + '\n    ' + e.message); }
}
const asyncTests = [];
function atest(name, fn) { asyncTests.push([name, fn]); }

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-provider-'));
const CAT = new SystemCatalog({ appRoot: ROOT, dataDir: path.join(TMP, 'catalog'), fetchJson: async () => { throw new Error('offline'); } });
const shared = {
  catalog: CAT,
  dataDirBase: TMP,
  settingsFn: () => ({ runtime: { installMode: 'guided', downloadConnections: 4 }, engine: {} }),
  onLog: () => {},
};

function mk(id) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  return providers.createProvider(id, Object.assign({}, shared, { dataDir: dir }));
}

test('7 个 Provider 全部可创建', () => {
  const ids = providers.allSystemIds();
  assert.strictEqual(ids.length, 7);
  for (const id of ids) {
    const p = mk(id);
    assert.ok(p, id + ' 可创建');
    assert.strictEqual(p.id, id);
  }
});

test('统一接口契约：每个 Provider 都实现关键方法', () => {
  const methods = ['getVersions', 'getLatestVersion', 'getAvailability', 'getLocalStatus',
    'getDownloadInfo', 'download', 'verify', 'install', 'initialize', 'createDevice',
    'start', 'stop', 'restart', 'getStatus', 'getLogs', 'backup', 'restore', 'remove'];
  for (const id of providers.allSystemIds()) {
    const p = mk(id);
    for (const m of methods) assert.strictEqual(typeof p[m], 'function', `${id}.${m} 应为函数`);
  }
});

test('每个系统有独立数据目录（不混用 userdata）', () => {
  const dirs = providers.allSystemIds().map((id) => mk(id).dataDir);
  assert.strictEqual(new Set(dirs).size, dirs.length, '目录应唯一');
  for (const d of dirs) assert.ok(d.includes(path.join('systems')) || d.includes('apkstart-provider'));
});

atest('LineageOS：getAvailability=false 且 getDownloadInfo=null（不伪造）', async () => {
  const p = mk('lineageos');
  const av = await p.getAvailability();
  assert.strictEqual(av.available, false);
  assert.strictEqual(av.status, 'unavailable');
  assert.ok(av.reason.length > 0);
  assert.strictEqual(await p.getDownloadInfo(), null);
  await assert.rejects(() => p.download(), /无预构建/);
});

atest('Bliss OS：归档状态 + 真实下载信息', async () => {
  const p = mk('bliss-os');
  const av = await p.getAvailability();
  assert.strictEqual(av.available, true);
  assert.strictEqual(av.archive, true);
  const info = await p.getDownloadInfo();
  assert.ok(/^https:/.test(info.url));
  assert.strictEqual(info.sha256.length, 64);
});

atest('Android-x86：可下载 + 真实校验和', async () => {
  const p = mk('android-x86');
  const av = await p.getAvailability();
  assert.strictEqual(av.available, true);
  const info = await p.getDownloadInfo();
  assert.ok(/sourceforge/.test(info.url));
  assert.strictEqual(info.sha256, 'f7eb8fc56f29ad5432335dc054183acf086c539f3990f0b6e9ff58bd6df4604e');
});

atest('安装状态持久化：写 manifest + 真实 ISO 后 getLocalStatus 反映', async () => {
  const p = mk('android-x86');
  fs.mkdirSync(p.downloadsDir, { recursive: true });
  fs.writeFileSync(p.isoPath(), Buffer.alloc(1024)); // 真实文件存在才算已下载
  p.writeManifest({ installed: true, version: '9.0-r2', downloaded: true });
  const st = await p.getLocalStatus();
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.version, '9.0-r2');
  assert.strictEqual(st.downloaded, true);
});

test('QEMU 后端参数：q35 + WHPX/TCG + virtio + adb hostfwd', () => {
  const be = new QemuBackend({ systemId: 'android-x86', onLog: () => {} });
  const args = be.buildArgs({
    disk: 'D:\\disk.qcow2', iso: '', install: false, uefi: false,
    memoryMB: 4096, cores: 4, adbPort: 5555,
    accel: { whpx: true }, display: 'none',
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('q35,accel=whpx'));
  assert.ok(joined.includes('-cpu host'));
  assert.ok(joined.includes('virtio-net-pci'));
  assert.ok(joined.includes('hostfwd=tcp:127.0.0.1:5555-:5555'));
  assert.ok(joined.includes('file=D:\\disk.qcow2,if=virtio'));
  assert.ok(joined.includes('-boot order=c'));
  const args2 = be.buildArgs({ disk: 'x', install: true, iso: 'y.iso', accel: { whpx: false } });
  assert.ok(args2.join(' ').includes('q35,accel=tcg'));
  assert.ok(args2.join(' ').includes('-cdrom y.iso'));
});

test('QEMU 后端：无 q35 的 i440fx 不会被使用（参数强制 q35）', () => {
  const be = new QemuBackend({ onLog: () => {} });
  const args = be.buildArgs({ accel: { whpx: true } });
  assert.ok(!args.join(' ').includes('i440fx'));
});

(async () => {
  console.log('\n[system-providers]');
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed += 1; console.log('  ✓ ' + name); }
    catch (e) { fails.push(name + ': ' + e.message); console.error('  ✗ ' + name + '\n    ' + e.message); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  const total = passed + fails.length;
  console.log(`\n${fails.length ? '✗' : '✓'} system-providers 测试：${passed}/${total} 通过`);
  if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
})();

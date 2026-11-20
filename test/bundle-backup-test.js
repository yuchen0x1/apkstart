'use strict';
/** 拆分包备份闭环：真实合成 APK/ZIP，所有设备和快捷方式均为桩。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-bundle-backup-'));
process.env.APPDATA = path.join(ROOT, 'appdata');
process.env.XDG_DATA_HOME = path.join(ROOT, 'xdgdata');
const { buildApkBytes } = require('./lib/make-apk');
const { buildZip } = require('./lib/zip-writer');
const backup = require('../src/core/backup');
const { Installer, parseBundle } = require('../src/core/installer');
const store = require('../src/core/store');
const PKG = 'com.example.bundle';
let passed = 0;
let seq = 0;
async function test(name, fn) {
  await fn(); passed++; console.log('  ✓ ' + name);
}
function bundle(entries) {
  const dir = path.join(ROOT, 'source-' + ++seq);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'bundle.apks');
  fs.writeFileSync(file, buildZip(entries || [
    { name: 'splits/config.en.apk', data: buildApkBytes({ packageName: PKG, split: 'config.en', abis: [] }) },
    { name: 'splits/base.apk', data: buildApkBytes({ packageName: PKG, abis: [] }) },
  ]));
  return file;
}
function application(apkPath) {
  return { package: PKG, label: '拆分包', versionName: '1.2.3', versionCode: 7, bundle: true, apkPath };
}
function fakeInstaller() {
  const calls = [];
  const client = {
    async shell() { return ''; },
    async install() { throw new Error('拆分包不得走单 APK 安装'); },
    async installMultiple(files) {
      calls.push(files.slice());
      assert.strictEqual(files.length, 2);
      for (const file of files) assert(fs.statSync(file).size > 0);
    },
    async resolveLauncher() { return PKG + '/.Main'; },
    async batteryOptimizeOff() {},
  };
  const runtime = { async ensure() { return { ok: true, client }; }, touch() {} };
  return { calls, client, runtime, installer: new Installer(runtime, { desktopDir: ROOT }) };
}
(async () => {
  store.saveSettings({ createShortcutOnInstall: false });
  await test('配置分片排在前面时仍使用真正 base APK 元数据', async () => {
    const parsed = await parseBundle(bundle());
    try { assert.strictEqual(parsed.meta.isSplit, false); assert.strictEqual(parsed.meta.package, PKG); }
    finally { parsed.cleanup(); }
  });
  await test('拆分安装→缓存→备份→恢复调用真实 installMultiple', async () => {
    const fixture = fakeInstaller();
    const installed = await fixture.installer.install(bundle());
    assert.strictEqual(installed.app.bundle, true);
    assert(/\.apks$/.test(installed.app.apkPath), '新缓存必须保留容器类型');
    const saved = await backup.backupApp({ app: installed.app, dir: path.join(ROOT, 'exports') });
    assert.strictEqual(saved.meta.apk, 'app.apks');
    const restored = await backup.restoreApp({ dir: saved.folder, installer: fixture.installer });
    assert.strictEqual(restored.app.package, PKG);
    assert.strictEqual(restored.dataRestored, false);
    assert.strictEqual(fixture.calls.length, 2);
    for (const files of fixture.calls) for (const file of files) assert(!fs.existsSync(file), '成功后清理解包临时文件');
  });
  await test('含数据的恢复绑定安装 ensure 选中的 client，不触碰调用前的旧 client', async () => {
    const saved = await backup.backupApp({ app: application(bundle()), dir: path.join(ROOT, 'bound-client') });
    fs.writeFileSync(path.join(saved.folder, 'data.tar'), Buffer.alloc(4096));
    backup.writeMeta(saved.folder, { ...saved.meta, data: 'data.tar' });
    const fixture = fakeInstaller();
    const commands = [];
    const oldCalls = [];
    const oldClient = Object.fromEntries(['shell', 'exec', 'push'].map(method => [method, async (...args) => {
      oldCalls.push([method, ...args]); throw new Error('不得使用旧实例');
    }]));
    let ensured = 0;
    fixture.runtime.client = () => oldClient;
    fixture.runtime.ensure = async () => { ensured++; return { ok: true, client: fixture.client }; };
    fixture.client.shell = async cmd => { commands.push(['shell', cmd]); return /run-as .* id$/.test(cmd) ? 'uid=12345' : ''; };
    fixture.client.push = async (local, remote) => { commands.push(['push', local, remote]); };
    fixture.client.exec = async args => { commands.push(['exec', args]); return { stdout: Buffer.alloc(0) }; };
    const r = await backup.restoreApp({ dir: saved.folder, installer: fixture.installer, client: oldClient });
    assert.strictEqual(r.dataRestored, true);
    assert.strictEqual(ensured, 1, '一轮恢复只选择一次安装运行时');
    assert.deepStrictEqual(oldCalls, []);
    assert.strictEqual(fixture.calls.length, 1);
    assert(commands.some(c => c[0] === 'push'));
    assert(commands.some(c => c[0] === 'exec' && c[1][1].includes('tar -xf -')));
    assert(commands.some(c => c[0] === 'shell' && c[1].startsWith('rm -f ')));
    assert(!Object.hasOwn(r, 'client'), '不得把 ADB 对象返回给 IPC');
    const plain = await fixture.installer.install(bundle());
    assert(!Object.hasOwn(plain, 'client'), '默认安装结果不暴露 client');
  });
  await test('安装器没有确认目标实例时拒绝恢复数据，不能回退到调用者 client', async () => {
    const saved = await backup.backupApp({ app: application(bundle()), dir: path.join(ROOT, 'unbound-client') });
    fs.writeFileSync(path.join(saved.folder, 'data.tar'), Buffer.alloc(4096));
    backup.writeMeta(saved.folder, { ...saved.meta, data: 'data.tar' });
    let deviceCalls = 0;
    const client = { async shell() { deviceCalls++; }, async push() { deviceCalls++; }, async exec() { deviceCalls++; } };
    await assert.rejects(backup.restoreApp({ dir: saved.folder, client, installer: {
      async install() { return { app: { package: PKG } }; },
    } }), /实例|停止恢复数据/);
    assert.strictEqual(deviceCalls, 0);
  });
  await test('还原 push 半途失败仍在安装绑定的 client 上清理暂存 tar', async () => {
    const saved = await backup.backupApp({ app: application(bundle()), dir: path.join(ROOT, 'push-failure') });
    fs.writeFileSync(path.join(saved.folder, 'data.tar'), Buffer.alloc(4096));
    backup.writeMeta(saved.folder, { ...saved.meta, data: 'data.tar' });
    const fixture = fakeInstaller();
    let remote;
    const cleaned = [];
    fixture.client.shell = async cmd => { if (cmd.startsWith('rm -f ')) cleaned.push(cmd); return 'uid=12345'; };
    fixture.client.exec = async () => { throw new Error('不应解包'); };
    fixture.client.push = async (_file, dst) => { remote = dst; throw new Error('fake push interrupted'); };
    await assert.rejects(backup.restoreApp({ dir: saved.folder, installer: fixture.installer }), /push interrupted/);
    assert(remote && cleaned.length === 1 && cleaned[0].includes(remote));
  });
  await test('兼容旧版把拆分容器保存为 app.apk 的备份', async () => {
    const dir = path.join(ROOT, 'legacy'); fs.mkdirSync(dir);
    fs.copyFileSync(bundle(), path.join(dir, 'app.apk'));
    backup.writeMeta(dir, { format: 'apkstart-backup/1', package: PKG, apk: 'app.apk', data: null });
    const fixture = fakeInstaller();
    assert.strictEqual((await backup.restoreApp({ dir, installer: fixture.installer })).app.package, PKG);
    assert.strictEqual(fixture.calls.length, 1);
  });
  await test('旧缓存 bundle:true 即使文件名是 .apk，备份也解析容器且不改源文件', async () => {
    const source = bundle();
    const cached = path.join(ROOT, 'legacy-cache', 'cached.apk');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(source, cached);
    const before = fs.readFileSync(cached);
    const saved = await backup.backupApp({
      app: { ...application(cached), bundle: true },
      dir: path.join(ROOT, 'legacy-export'),
    });
    assert.strictEqual(saved.meta.apk, 'app.apks');
    assert.strictEqual(saved.meta.bundle, true);
    assert(fs.readFileSync(cached).equals(before), '不能改写旧 .apk 缓存');
    assert(fs.readFileSync(path.join(saved.folder, 'app.apks')).equals(before));
  });
  await test('bundle 标记不能把普通 APK 当 split', async () => {
    const cached = path.join(ROOT, 'plain-marked.apk');
    fs.writeFileSync(cached, buildApkBytes({ packageName: PKG, abis: [] }));
    await assert.rejects(
      backup.backupApp({ app: { ...application(cached), bundle: true }, dir: path.join(ROOT, 'plain-export') }),
      /普通 APK|拆分包/,
    );
    const plain = await backup.backupApp({
      app: { ...application(cached), bundle: false },
      dir: path.join(ROOT, 'plain-export-ok'),
    });
    assert.strictEqual(plain.meta.apk, 'app.apk');
    assert.strictEqual(plain.meta.bundle, false);
  });
  await test('启动旧 .apk 缓存时按 bundle:true 走真实 installMultiple，不走单 APK', async () => {
    store.removeApp(PKG);
    const source = bundle();
    const cached = path.join(ROOT, 'launch-cache', 'cached.apk');
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(source, cached);
    store.upsertApp({
      ...application(cached), bundle: true, activity: `${PKG}/.Main`, abis: [],
    });
    const calls = [];
    let cancel = false;
    const client = {
      async shell(cmd) {
        calls.push(['shell', cmd]);
        if (cmd.startsWith('pm list packages')) return '';
        if (cmd.startsWith('pidof')) return '123';
        return '';
      },
      async install() { throw new Error('旧 bundle 不能走单 APK 安装'); },
      async installMultiple(files) {
        calls.push(['installMultiple', files.slice()]);
        assert.strictEqual(files.length, 2);
        for (const file of files) assert(fs.existsSync(file));
        cancel = true;
      },
      async grantRuntimePermissions() {},
      async forceStop() {},
      async dismissPermissionDialog() {},
      async clearCache() {},
      async startApp() { calls.push(['startApp']); },
    };
    const runtime = {
      async ensure() { return { ok: true, engine: 'fake', client }; },
      touch() {},
    };
    const installer = new Installer(runtime, { desktopDir: ROOT });
    try {
      await assert.rejects(
        installer.launch(PKG, { shouldCancel: () => cancel }),
        error => error && error.code === 'LAUNCH_CANCELLED',
      );
      const multiple = calls.find(c => c[0] === 'installMultiple');
      assert(multiple, '应调用 installMultiple');
      assert(!calls.some(c => c[0] === 'startApp'), '取消后不能启动应用');
      for (const file of multiple[1]) assert(!fs.existsSync(file), '解包临时文件必须清理');
    } finally { store.removeApp(PKG); }
  });
  await test('拆分包包名与备份元数据不符时不调用安装器', async () => {
    const saved = await backup.backupApp({ app: application(bundle()), dir: path.join(ROOT, 'mismatch') });
    backup.writeMeta(saved.folder, { ...saved.meta, package: 'com.example.other' });
    let called = false;
    await assert.rejects(backup.restoreApp({ dir: saved.folder, installer: { install() { called = true; } } }), /包名/);
    assert.strictEqual(called, false);
  });
  await test('拒绝没有 base 的容器和混入其他应用的分片', async () => {
    await assert.rejects(parseBundle(bundle([
      { name: 'only.apk', data: buildApkBytes({ packageName: PKG, split: 'config.en' }) },
    ])), /base/i);
    await assert.rejects(parseBundle(bundle([
      { name: 'base.apk', data: buildApkBytes({ packageName: PKG }) },
      { name: 'config.apk', data: buildApkBytes({ packageName: 'com.example.other', split: 'config.en' }) },
    ])), /包名|分片/);
  });
  await test('同一容器并发解析使用独立目录，互相清理不会破坏对方', async () => {
    const file = bundle();
    const [a, b] = await Promise.all([parseBundle(file), parseBundle(file)]);
    try {
      assert.notStrictEqual(path.dirname(a.files[0]), path.dirname(b.files[0]));
      a.cleanup();
      assert(b.files.every(f => fs.existsSync(f)));
    } finally { a.cleanup(); b.cleanup(); }
  });
  await test('连续备份不得复用目录并覆盖上一次备份', async () => {
    const app = application(bundle());
    const dir = path.join(ROOT, 'repeated');
    const a = await backup.backupApp({ app, dir });
    const sentinel = path.join(a.folder, 'keep.txt'); fs.writeFileSync(sentinel, 'old backup');
    const b = await backup.backupApp({ app, dir });
    assert.notStrictEqual(a.folder, b.folder);
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'old backup');
  });
  await test('损坏的分片在任何设备安装前拒绝', async () => {
    const file = bundle([
      { name: 'base.apk', data: buildApkBytes({ packageName: PKG }) },
      { name: 'bad.apk', data: 'not an APK' },
    ]);
    const fixture = fakeInstaller();
    await assert.rejects(fixture.installer.install(file));
    assert.strictEqual(fixture.calls.length, 0);
  });
  await test('分片 CRC 被破坏时拒绝并清理解包目录', async () => {
    const file = bundle([{ name: 'base.apk', data: buildApkBytes({ packageName: PKG }), crc: 123 }]);
    await assert.rejects(parseBundle(file), /CRC/);
  });
  await test('ZIP 流式大小上限在写入超额字节之前中止且关闭目标', async () => {
    const { ZipFile } = require('../src/core/zip');
    const file = bundle([{ name: 'large.bin', data: Buffer.alloc(2048, 7) }]);
    const zip = new ZipFile(file);
    const target = path.join(ROOT, 'limited.bin');
    const output = fs.createWriteStream(target);
    try {
      await assert.rejects(zip.pipeTo('large.bin', output, { maxBytes: 10 }), /安全上限/);
      assert.strictEqual(output.closed, true);
      assert(fs.statSync(target).size <= 10);
    } finally { zip.close(); }
  });
  await test('ZIP 两个读取器均拒绝重复名称、截断中央目录与数量不符', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const valid = buildZip([{ name: 'one.txt', data: 'one' }, { name: 'two.txt', data: 'two' }]);
    const eocd = valid.length - 22;
    const cd = valid.readUInt32LE(eocd + 16);
    const second = cd + 46 + Buffer.byteLength('one.txt');
    const variants = [
      ['重复名称', buildZip([{ name: 'same.apk', data: 'a' }, { name: 'same.apk', data: 'b' }])],
      ['目录实际被截断', Buffer.concat([valid.subarray(0, eocd - 1), valid.subarray(eocd)])],
      ['EOCD 被截断', valid.subarray(0, valid.length - 1)],
    ];
    for (const [label, mutate] of [
      ['条目总数过大', bytes => { bytes.writeUInt16LE(3, eocd + 8); bytes.writeUInt16LE(3, eocd + 10); }],
      ['条目总数过小', bytes => { bytes.writeUInt16LE(1, eocd + 8); bytes.writeUInt16LE(1, eocd + 10); }],
      ['磁盘条目数不符', bytes => bytes.writeUInt16LE(1, eocd + 8)],
      ['中央目录签名损坏', bytes => bytes.writeUInt32LE(0, second)],
      ['中央目录名称被截断', bytes => bytes.writeUInt16LE(65535, second + 28)],
      ['中央目录 extra 被截断', bytes => bytes.writeUInt16LE(1, second + 30)],
      ['中央目录 comment 被截断', bytes => bytes.writeUInt16LE(1, second + 32)],
      ['中央目录声明过短', bytes => bytes.writeUInt32LE(46, eocd + 12)],
      ['中央目录偏移越界', bytes => bytes.writeUInt32LE(bytes.length + 100, eocd + 16)],
      ['缺少 Zip64 extra', bytes => bytes.writeUInt32LE(0xffffffff, second + 24)],
      ['EOCD comment 被截断', bytes => bytes.writeUInt16LE(1, eocd + 20)],
    ]) {
      const bytes = Buffer.from(valid); mutate(bytes); variants.push([label, bytes]);
    }
    for (const [label, bytes] of variants) {
      assert.throws(() => new ZipArchive(bytes), /ZIP|中央目录|EOCD|截断/i, label + ' (memory)');
      const file = path.join(ROOT, `bad-directory-${++seq}.zip`); fs.writeFileSync(file, bytes);
      assert.throws(() => new ZipFile(file), /ZIP|中央目录|EOCD|截断/i, label + ' (file)');
      fs.unlinkSync(file); // Windows 上也证明构造失败没有泄漏文件句柄。
    }
    const empty = new ZipArchive(buildZip([]));
    assert.deepStrictEqual(empty.names(), []);
  });
  await test('ZIP64 与最长 ZIP 注释正常读取，缺 locator 和截断目录不能静默接受', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const plain = buildZip([{ name: 'one.txt', data: 'zip64-data' }]);
    const normalEnd = plain.length - 22;
    const cdOffset = plain.readUInt32LE(normalEnd + 16);
    const cdSize = plain.readUInt32LE(normalEnd + 12);
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0); z64.writeBigUInt64LE(44n, 4);
    z64.writeBigUInt64LE(1n, 24); z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(cdSize), 40); z64.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(normalEnd), 8); loc.writeUInt32LE(1, 16);
    const end = Buffer.from(plain.subarray(normalEnd));
    end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    const good = Buffer.concat([plain.subarray(0, normalEnd), z64, loc, end]);
    const commented = Buffer.concat([good, Buffer.alloc(65535, 42)]);
    commented.writeUInt16LE(65535, good.length - 2);
    const variants = [['ZIP64', good, true], ['ZIP64 maximum comment', commented, true],
      ['missing locator', Buffer.concat([plain.subarray(0, normalEnd), end]), false]];
    const unsafe = Buffer.from(good); unsafe.writeBigUInt64LE(9007199254740993n, normalEnd + 32);
    variants.push(['unsafe integer count', unsafe, false]);
    const counts = Buffer.from(good); counts.writeBigUInt64LE(0n, normalEnd + 24);
    variants.push(['ZIP64 count mismatch', counts, false]);
    for (const [label, bytes, ok] of variants) {
      const file = path.join(ROOT, `zip64-${++seq}.zip`); fs.writeFileSync(file, bytes);
      if (!ok) {
        assert.throws(() => new ZipArchive(bytes), /ZIP|中央目录/i, label);
        assert.throws(() => new ZipFile(file), /ZIP|中央目录/i, label);
      } else {
        const mem = new ZipArchive(bytes); const zip = new ZipFile(file);
        try { assert.strictEqual(mem.read('one.txt').toString(), 'zip64-data'); assert(zip.read('one.txt').equals(mem.read('one.txt'))); }
        finally { zip.close(); }
      }
    }
  });
  await test('重复 APK 条目与截断目录在 ensure 和安装前拒绝', async () => {
    const duplicate = bundle([
      { name: 'base.apk', data: buildApkBytes({ packageName: 'com.example.other', abis: [] }) },
      { name: 'base.apk', data: buildApkBytes({ packageName: PKG, abis: [] }) },
    ]);
    const truncated = bundle();
    const bytes = fs.readFileSync(truncated);
    bytes.writeUInt16LE(3, bytes.length - 22 + 8); bytes.writeUInt16LE(3, bytes.length - 22 + 10);
    fs.writeFileSync(truncated, bytes);
    for (const file of [duplicate, truncated]) {
      const fixture = fakeInstaller();
      let ensureCalls = 0;
      fixture.runtime.ensure = async () => { ensureCalls++; throw new Error('不可进入设备阶段'); };
      await assert.rejects(fixture.installer.install(file), /重复|中央目录|数量/);
      assert.strictEqual(ensureCalls, 0);
      assert.strictEqual(fixture.calls.length, 0);
    }
  });
  console.log(`拆分包备份回归：${passed} 通过，0 失败`);
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(ROOT, { recursive: true, force: true }));

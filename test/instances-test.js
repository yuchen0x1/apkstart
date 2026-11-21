'use strict';
/**
 * 多开底层离线回归：只用临时目录 + fake spawn/fs，不启动 Electron、产品 main、
 * 真实 ADB/模拟器，也不读取用户数据。
 */
const assert = require('assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const context = require('../src/core/instance-context');
const { InstanceManager } = require('../src/core/instances');

const PKG = 'com.example.one';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-instances-'));
  const base = path.join(root, 'appdata', 'apkstart');
  const env = process.platform === 'win32'
    ? { APPDATA: path.join(root, 'appdata') }
    : { XDG_DATA_HOME: path.join(root, 'appdata') };
  const ctx = context.resolveContext({ platform: process.platform, env, home: root });
  const apkDir = path.join(base, 'apks');
  fs.mkdirSync(apkDir, { recursive: true });
  const sourceApk = path.join(apkDir, `${PKG}-1.apk`);
  fs.writeFileSync(sourceApk, 'fake-apk-bytes');
  const apps = [{
    package: PKG, label: 'One', versionName: '1.0', versionCode: 1,
    activity: 'com.example.one.Main', apkPath: sourceApk, bundle: false,
  }];
  const store = {
    DATA_DIR: base,
    APK_DIR: apkDir,
    getSettings: () => ({
      autoDeploy: true,
      autoStart: true,
      createShortcutOnInstall: true,
      createStartMenuShortcut: true,
      notifyOnInstall: true,
      runtime: { dir: path.join(base, 'runtime'), avdDir: path.join(root, 'custom-avd') },
      engine: { mode: 'builtin', prewarm: true },
      update: { autoUpdate: true },
      report: { auto: true, autoSend: true },
    }),
    getApp: (pkg) => apps.find((app) => app.package === pkg) || null,
    getApps: () => apps,
  };
  const children = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 40000 + children.length;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    children.push({ file, args, options, child });
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const manager = new InstanceManager({
    store, appRoot: path.join(root, 'app'), executable: path.join(root, 'ApkStart.exe'),
    isPackaged: true, spawn, env: { APPDATA: env.APPDATA || '', PATH: 'x', NODE_OPTIONS: '--evil' },
    context: ctx, isPidAlive: () => true,
  });
  return { root, base, ctx, store, apkDir, sourceApk, apps, manager, children };
}

test('baseDataDir 只接受规范系统目录，忽略相对值', () => {
  const win = context.baseDataDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u');
  assert.equal(win, 'C:\\Users\\u\\AppData\\Roaming\\apkstart');
  assert.equal(context.baseDataDir('win32', { APPDATA: 'relative' }, 'C:\\Users\\u'),
    'C:\\Users\\u\\AppData\\Roaming\\apkstart');
  assert.equal(context.baseDataDir('linux', { XDG_DATA_HOME: '/home/u/.local/share' }, '/home/u'),
    '/home/u/.local/share/apkstart');
  assert.equal(context.baseDataDir('linux', { APPDATA: 'C:\\evil' }, '/home/u'),
    '/home/u/.local/share/apkstart');
  assert.throws(() => context.baseDataDir('win32', { APPDATA: 'C:\\' }, 'C:\\Users\\u'),
    { code: 'INVALID_BASE_DATA_DIR' });
  assert.throws(() => context.baseDataDir('linux', { XDG_DATA_HOME: '/' }, '/home/u'),
    { code: 'INVALID_BASE_DATA_DIR' });
});

test('context 从 base+id 派生，忽略伪造 root 环境变量', () => {
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', APKSTART_DATA_DIR: 'C:\\evil' };
  const parent = context.resolveContext({ platform: 'win32', env, home: 'C:\\Users\\u' });
  assert.equal(parent.isChild, false);
  assert.equal(parent.dataDir, parent.baseDir);
  assert.equal(parent.userDataDir, parent.baseDir);
  assert.equal(parent.avdDir, 'C:\\Users\\u\\AppData\\Roaming\\apkstart\\avd');
  const child = context.resolveContext({ platform: 'win32', env, home: 'C:\\Users\\u', instanceId: 'abc-1' });
  assert.equal(child.isChild, true);
  assert.equal(child.dataDir, 'C:\\Users\\u\\AppData\\Roaming\\apkstart\\instances\\abc-1');
  assert.equal(child.userDataDir, `${child.dataDir}\\chromium`);
  assert.equal(child.avdDir, `${child.dataDir}\\avd`);
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '.', '', 'x'.repeat(200)]) {
    assert.equal(context.validateInstanceId(bad), false, `应拒绝 ${bad}`);
  }
  assert.throws(() => context.resolveContext({ platform: 'win32', env, home: 'C:\\Users\\u', instanceId: '../evil' }),
    { code: 'INVALID_INSTANCE_ID' });
});

test('childEnv 只携带已验证 id，清掉注入与运行时路由变量', () => {
  const out = context.childEnv('abc-1', {
    PATH: '/bin', HOME: '/home/u', NODE_OPTIONS: '--require evil',
    ELECTRON_RUN_AS_NODE: '1', ANDROID_ADB_SERVER_PORT: '5044', ANDROID_HOME: '/evil',
    APKSTART_DATA_DIR: '/evil', APKSTART_INSTANCE_ID: 'spoofed',
  });
  assert.equal(out.APKSTART_INSTANCE_ID, 'abc-1');
  assert.equal(out.PATH, '/bin');
  assert.equal(out.NODE_OPTIONS, undefined);
  assert.equal(out.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(out.ANDROID_ADB_SERVER_PORT, undefined);
  assert.equal(out.ANDROID_HOME, undefined);
  assert.equal(out.APKSTART_DATA_DIR, undefined);
  assert.throws(() => context.childEnv('../x', {}), { code: 'INVALID_INSTANCE_ID' });
});

test('create 只建隔离配置：builtin、无自动部署/更新/快捷方式、独立 AVD', () => {
  const s = sandbox();
  const inst = s.manager.create({ name: '工作号' });
  try {
    assert.equal(inst.isChild, true);
    assert.equal(inst.dataDir, path.join(s.base, 'instances', inst.id));
    assert.equal(inst.userDataDir, path.join(inst.dataDir, 'chromium'));
    assert.equal(inst.avdDir, path.join(inst.dataDir, 'avd'));
    for (const d of [inst.dataDir, inst.userDataDir, inst.avdDir,
      path.join(inst.dataDir, 'apks'), path.join(inst.dataDir, 'logs')]) {
      assert(fs.statSync(d).isDirectory(), d);
    }
    const settings = JSON.parse(fs.readFileSync(path.join(inst.dataDir, 'settings.json'), 'utf8'));
    assert.equal(settings.engine.mode, 'builtin');
    assert.equal(settings.engine.prewarm, false);
    assert.equal(settings.runtime.avdDir, inst.avdDir);
    assert.equal(settings.runtime.dir, path.join(s.base, 'runtime'));
    assert.equal(settings.runtime.systemImageFlavor, 'google_apis_playstore');
    assert.equal(settings.runtime.selectedSystemId, 'google-play');
    assert.equal(settings.runtime.systemCatalogUrl, '');
    assert.equal(settings.runtime.diskPath, '');
    assert.equal(settings.runtime.isoPath, '');
    assert.equal(settings.engine.qemuPath, '');
    assert.equal(settings.engine.systemImage, '');
    assert.equal(settings.adbPath, '');
    assert.equal(settings.device, '');
    assert.deepEqual(settings.peripherals, {
      cameraBack: 'none', cameraFront: 'none', refreshRate: 60, serialPort: '',
    });
    assert.equal(settings.autoDeploy, false);
    assert.equal(settings.autoStart, false);
    assert.equal(settings.createShortcutOnInstall, false);
    assert.equal(settings.update.autoUpdate, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(inst.dataDir, 'apps.json'), 'utf8')), { apps: [] });
    assert.deepEqual(s.manager.list().map((i) => i.id), [inst.id]);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('create 在 catalog 写失败时回滚本次新建目录', () => {
  const s = sandbox();
  const failing = {
    ...fs,
    renameSync: (from, to) => {
      if (path.basename(to) === 'catalog.json') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    },
  };
  const manager = new InstanceManager({
    store: s.store, appRoot: s.root, executable: 'x', isPackaged: true,
    spawn: () => assert.fail('不应 spawn'), fs: failing, context: s.ctx,
  });
  try {
    assert.throws(() => manager.create({ name: 'x' }), /EPERM/);
    assert.equal(fs.existsSync(path.join(s.base, 'instances')), false);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('catalog 结构损坏/未知字段时失败关闭', () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.base, 'instances'), { recursive: true });
  fs.writeFileSync(path.join(s.base, 'instances', 'catalog.json'), JSON.stringify({
    version: 1, instances: [], extra: true,
  }));
  try {
    assert.throws(() => s.manager.list(), { code: 'INSTANCE_CATALOG_INVALID' });
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('launch 缺包时明确报错且不 spawn、不写 catalog', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  try {
    await assert.rejects(s.manager.launch(inst.id, 'com.example.missing'), { code: 'APP_PACKAGE_MISSING' });
    assert.equal(s.children.length, 0);
    assert.equal(s.manager.list()[0].state, 'created');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('launch 拒绝受管目录外的 APK 与 bundle 标记不一致', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  try {
    s.apps[0] = { ...s.apps[0], apkPath: path.join(s.root, 'outside.apk') };
    fs.writeFileSync(path.join(s.root, 'outside.apk'), 'x');
    await assert.rejects(s.manager.launch(inst.id, PKG), { code: 'APP_STORAGE_UNMANAGED' });
    s.apps[0] = { ...s.apps[0], apkPath: s.sourceApk, bundle: true };
    await assert.rejects(s.manager.launch(inst.id, PKG), { code: 'APP_STORAGE_INVALID' });
    assert.equal(s.children.length, 0);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('launch 拷贝受管包、spawn 不 shell、env 带 id 且可幂等复用', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  try {
    const r = await s.manager.launch(inst.id, PKG);
    assert.equal(r.ok, true);
    assert.equal(r.pid, 40000);
    assert.equal(s.children.length, 1);
    const call = s.children[0];
    assert.deepEqual(call.args, ['--launch', PKG]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.APKSTART_INSTANCE_ID, inst.id);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert(fs.existsSync(r.apkPath));
    assert(r.apkPath.startsWith(path.join(inst.dataDir, 'apks')));
    const apps = JSON.parse(fs.readFileSync(path.join(inst.dataDir, 'apps.json'), 'utf8')).apps;
    assert.equal(apps.length, 1);
    assert.equal(apps[0].package, PKG);
    assert.equal(apps[0].apkPath, r.apkPath);

    const again = await s.manager.launch(inst.id, PKG);
    assert.equal(again.reused, true);
    assert.equal(s.children.length, 1, '同 id 不得启动第二个子进程');
    assert.equal(s.manager.list()[0].state, 'running');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('外部记录中的运行中 PID 不被接管、不被杀，也不误报启动成功', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  try {
    const file = path.join(s.base, 'instances', 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    catalog.instances[0] = { ...catalog.instances[0], state: 'running', pid: 99999, package: PKG };
    fs.writeFileSync(file, JSON.stringify(catalog));
    const r = await s.manager.launch(inst.id, PKG);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INSTANCE_STATE_UNKNOWN');
    assert.equal(r.external, true);
    assert.equal(r.state, 'unknown');
    assert.equal(s.children.length, 0);
    const item = s.manager.list()[0];
    assert.equal(item.running, false);
    assert.equal(item.state, 'unknown');
    assert.equal(item.needsVerification, true);
    s.manager.dispose();
    assert.equal(s.children.length, 0);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('spawn 抛错时 catalog 记 error 且 launch 失败', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  const manager = new InstanceManager({
    store: s.store, appRoot: s.root, executable: 'x', isPackaged: true,
    spawn: () => { throw new Error('boom'); }, env: {}, context: s.ctx,
  });
  try {
    await assert.rejects(manager.launch(inst.id, PKG), { code: 'SPAWN_FAILED' });
    const entry = manager.list()[0];
    assert.equal(entry.state, 'error');
    assert.match(entry.lastError, /boom/);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('外部运行中 PID 已消失时释放幂等状态，仍不杀任何进程', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  try {
    const file = path.join(s.base, 'instances', 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    catalog.instances[0] = { ...catalog.instances[0], state: 'running', pid: 99999, package: PKG };
    fs.writeFileSync(file, JSON.stringify(catalog));
    const manager = new InstanceManager({
      store: s.store, appRoot: s.root, executable: 'x', isPackaged: true,
      spawn: s.manager.spawn, env: {}, context: s.ctx, isPidAlive: () => false,
    });
    const r = await manager.launch(inst.id, PKG);
    assert.equal(r.ok, true);
    assert.equal(r.external, undefined);
    assert.equal(manager.list()[0].state, 'running');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('bundle 包按 .apks 复制并保留 bundle 标记供子实例 Installer 自动安装', async () => {
  const s = sandbox();
  const bundlePath = path.join(s.apkDir, `${PKG}-1.apks`);
  fs.writeFileSync(bundlePath, 'fake-bundle');
  s.apps[0] = { ...s.apps[0], apkPath: bundlePath, bundle: true };
  const inst = s.manager.create({ name: 'a' });
  try {
    const r = await s.manager.launch(inst.id, PKG);
    assert(r.apkPath.endsWith('.apks'));
    const apps = JSON.parse(fs.readFileSync(path.join(inst.dataDir, 'apps.json'), 'utf8')).apps;
    assert.equal(apps[0].bundle, true);
    assert.equal(apps[0].apkPath, r.apkPath);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('dispose 不终止自己创建的进程，只释放句柄', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  try {
    await s.manager.launch(inst.id, PKG);
    const child = s.children[0].child;
    s.manager.dispose();
    assert.equal(child.killed, false);
    assert.equal(s.children.length, 1);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('spawn 后无 spawn/error/exit 事件：有界超时 fail closed，且不误报 running', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  let spawns = 0;
  const silentSpawn = () => {
    spawns += 1;
    const child = new EventEmitter();
    child.pid = 41000;
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; };
    return child;
  };
  const manager = new InstanceManager({
    store: s.store, appRoot: s.root, executable: 'x', isPackaged: true,
    spawn: silentSpawn, env: {}, context: s.ctx, isPidAlive: () => true,
    spawnTimeoutMs: 25,
  });
  try {
    await assert.rejects(manager.launch(inst.id, PKG), { code: 'SPAWN_UNCONFIRMED' });
    const item = manager.list()[0];
    assert.equal(item.state, 'unknown');
    assert.equal(item.running, false);
    assert.equal(item.needsVerification, true);
    const again = await manager.launch(inst.id, PKG);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'INSTANCE_STATE_UNKNOWN');
    assert.equal(spawns, 1, '状态未确认时不得重复启动');
    manager.dispose();
    const restarted = new InstanceManager({
      store: s.store, appRoot: s.root, executable: 'x', isPackaged: true,
      spawn: silentSpawn, env: {}, context: s.ctx, isPidAlive: () => true,
    });
    assert.equal(restarted.list()[0].state, 'unknown');
    const afterRestart = await restarted.launch(inst.id, PKG);
    assert.equal(afterRestart.ok, false);
    assert.equal(afterRestart.code, 'INSTANCE_STATE_UNKNOWN');
    assert.equal(spawns, 1, '父管理器重启后也必须保留未确认 PID，不能重复启动');
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('无 spawn 事件接口的测试替身同样 fail closed，不进入 confirmed', async () => {
  const s = sandbox();
  const inst = s.manager.create({ name: 'a' });
  const manager = new InstanceManager({
    store: s.store, appRoot: s.root, executable: 'x', isPackaged: true,
    spawn: () => ({ pid: 42000, killed: false, exitCode: null }),
    env: {}, context: s.ctx, isPidAlive: () => true, spawnTimeoutMs: 25,
  });
  try {
    await assert.rejects(manager.launch(inst.id, PKG), { code: 'SPAWN_UNCONFIRMED' });
    const item = manager.list()[0];
    assert.equal(item.state, 'unknown');
    assert.equal(item.running, false);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('非法 id 不能触发任何 spawn 或路径操作', async () => {
  const s = sandbox();
  try {
    await assert.rejects(s.manager.launch('../evil', PKG), { code: 'INVALID_INSTANCE_ID' });
    assert.equal(s.children.length, 0);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

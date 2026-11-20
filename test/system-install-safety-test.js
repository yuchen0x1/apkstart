'use strict';
/** 安装完成与任务竞态反例：只用稀疏临时盘、假后端，绝不启动虚拟机。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-system-safe-'));
process.env.APPDATA = path.join(ROOT, 'appdata');
process.env.XDG_DATA_HOME = path.join(ROOT, 'xdg');
const { SystemTaskManager, SystemTask, STATUS } = require('../src/core/system-task-manager');
const { SystemManager } = require('../src/core/system-manager');
const { QemuIsoProvider } = require('../src/core/system-providers/qemu-iso-provider');
const { createProvider } = require('../src/core/system-providers');
const { resolveSystemPaths, legacyPathWarnings } = require('../src/core/system-providers/system-paths');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }
async function until(fn) {
  const end = Date.now() + 2000;
  while (!fn()) { if (Date.now() > end) throw new Error('测试等待超时'); await delay(1); }
}
let seq = 0;
function isoProvider(mode = 'guided') {
  const dir = path.join(ROOT, 'provider-' + (++seq));
  const backend = {
    alive: false, starts: 0, stops: 0,
    accelInfo: async () => ({}),
    startVM: async () => { backend.starts += 1; backend.alive = true; return { ok: true }; },
    stop: async () => { backend.stops += 1; backend.alive = false; return { ok: true }; },
    running: () => backend.alive,
  };
  const p = new QemuIsoProvider({ systemId: 'android-x86', dataDir: dir, qemuBackend: backend,
    installWaitIntervalMs: 1, settingsFn: () => ({ runtime: { installMode: mode }, engine: {} }) });
  fs.writeFileSync(p.isoPath(), 'ISO fixture');
  p.createDevice = async () => {
    if (!fs.existsSync(p.diskPath())) fs.writeFileSync(p.diskPath(), Buffer.alloc(128));
    return { ok: true, disk: p.diskPath() };
  };
  p.getAvailability = async () => ({ available: true });
  p.getDownloadInfo = async () => ({ url: 'https://example.invalid/fixture.iso', version: 'fixture', fileSize: 16 });
  p.download = async () => ({ file: p.isoPath(), size: 16 });
  p.verify = async () => ({ ok: true });
  return { p, backend };
}
function taskManager() { return new SystemTaskManager({ dataDir: path.join(ROOT, 'tasks-' + (++seq)) }); }
function manager(p) {
  const m = new SystemManager({ dataDir: path.join(ROOT, 'manager-' + (++seq)),
    store: { DATA_DIR: ROOT, getSettings: () => ({ runtime: {} }) } });
  m._providers.set(p.id, p);
  return m;
}

(async () => {
  await test('磁盘增长超过32MiB仍保持安装器运行，不能确认完成', async () => {
    const { p, backend } = isoProvider();
    const task = new SystemTask({ systemId: p.id });
    const running = p.install(task, { installWaitMs: 100 });
    await until(() => task.status === STATUS.AWAITING_CONFIRMATION);
    fs.truncateSync(p.diskPath(), 34 * 1024 * 1024);
    await delay(5);
    assert.strictEqual(backend.stops, 0);
    assert(backend.running());
    assert.strictEqual(p.readManifest().installed, false);
    assert.strictEqual(p.confirmInstallation(task, { confirmed: true }).code, 'INSTALLER_RUNNING');
    task.aborted = true;
    task._controller.abort();
    assert.strictEqual((await running).interrupted, true);
    assert(backend.running());
    assert.strictEqual(backend.stops, 0);
  });
  await test('关机后还需明确确认，完成流水线只初始化一次', async () => {
    const { p, backend } = isoProvider();
    const m = manager(p);
    const promise = m.installSystem(p.id, { await: true });
    await until(() => backend.running());
    backend.alive = false;
    const started = await promise;
    const task = m.taskManager.getTask(started.taskId);
    assert.strictEqual(task.status, STATUS.AWAITING_CONFIRMATION);
    assert.strictEqual(p.readManifest().installed, false);
    assert.strictEqual((await m.confirmInstallation(task.taskId, {})).ok, false);
    assert.strictEqual((await m.confirmInstallation(task.taskId, { confirmed: true })).ok, true);
    assert.strictEqual(task.status, STATUS.COMPLETED);
    assert.strictEqual((await p.getLocalStatus()).installed, true);
    assert.strictEqual(p.readManifest().installationEvidence.installerStopped, true);
    assert.strictEqual(m.taskManager.getActiveTask(p.id), null);
    assert.strictEqual((await m.confirmInstallation(task.taskId, { confirmed: true })).ok, false);
  });
  await test('auto未实现时明确失败，不启动安装器或进入无法确认的等待', async () => {
    const { p, backend } = isoProvider('auto');
    const m = manager(p);
    const r = await m.installSystem(p.id, { await: true });
    assert.strictEqual(r.result.code, 'AUTO_INSTALL_UNSUPPORTED');
    assert.strictEqual(m.taskManager.getTask(r.taskId).status, STATUS.FAILED);
    assert.strictEqual(backend.starts, 0);
    assert.strictEqual(p.readManifest(), null);
  });
  await test('安装超时不强停虚拟机，也不标已安装', async () => {
    const { p, backend } = isoProvider();
    const task = new SystemTask({ systemId: p.id });
    const r = await p.install(task, { installWaitMs: 5 });
    assert.strictEqual(r.needsUserInstall, true);
    assert(backend.running());
    assert.strictEqual(backend.stops, 0);
    assert.strictEqual(p.readManifest().installed, false);
  });
  await test('暂停期间迟到的拒绝不改为取消，收尾前不能重试', async () => {
    const tm = taskManager();
    let reject;
    const provider = { getDownloadInfo: async () => ({ url: 'https://example.invalid/a', version: '1' }),
      download: async () => new Promise((_r, j) => { reject = j; }) };
    const { task } = tm.createTask({ systemId: 'paused', provider });
    const running = tm.runPipeline({ task, provider });
    await until(() => !!reject);
    assert(tm.pause(task.taskId).ok);
    assert.strictEqual(tm.retry(task.taskId).ok, false);
    reject(new Error('中止下载'));
    assert.strictEqual((await running).paused, true);
    assert.strictEqual(task.status, STATUS.PAUSED);
    task.setStatus(STATUS.INSTALLING, '迟到阶段');
    assert.strictEqual(task.status, STATUS.PAUSED);
    assert.strictEqual(tm.getActiveTask('paused'), task);
    assert(tm.retry(task.taskId).ok);
    assert.strictEqual(task.status, STATUS.WAITING);
  });
  await test('取消收尾前保留锁，迟到结果不能复活任务', async () => {
    const tm = taskManager();
    let resolve;
    const provider = { getDownloadInfo: async () => ({ url: 'https://example.invalid/a', version: '1' }),
      download: async () => new Promise((r) => { resolve = r; }) };
    const { task } = tm.createTask({ systemId: 'cancelled', provider });
    const running = tm.runPipeline({ task, provider });
    await until(() => !!resolve);
    assert(tm.cancel(task.taskId).ok);
    assert.strictEqual(tm.createTask({ systemId: 'cancelled', provider }).reused, true);
    resolve({ file: 'unused' });
    assert.strictEqual((await running).cancelled, true);
    assert.strictEqual(task.status, STATUS.CANCELLED);
    task.setStatus(STATUS.COMPLETED, '迟到成功');
    assert.strictEqual(task.status, STATUS.CANCELLED);
    assert.strictEqual(tm.getActiveTask('cancelled'), null);
  });
  await test('失败任务可显式重试，已完成任务不能取消', () => {
    const tm = taskManager();
    const { task } = tm.createTask({ systemId: 'retry' });
    task.setStatus(STATUS.FAILED, '失败');
    assert(tm.retry(task.taskId).ok);
    assert.strictEqual(task.status, STATUS.WAITING);
    task.setStatus(STATUS.COMPLETED, '完成');
    assert.strictEqual(tm.cancel(task.taskId).ok, false);
    assert.strictEqual(task.status, STATUS.COMPLETED);
  });
  await test('旧失败任务不能抢占同系统的新任务锁', () => {
    const tm = taskManager();
    const old = tm.createTask({ systemId: 'retry-lock' }).task;
    old.setStatus(STATUS.FAILED, '失败');
    tm._release(old);
    const next = tm.createTask({ systemId: 'retry-lock' }).task;
    assert.strictEqual(tm.retry(old.taskId).ok, false);
    assert.strictEqual(tm.getActiveTask('retry-lock'), next);
    assert.strictEqual(old.status, STATUS.FAILED);
  });
  await test('其它系统安装器仍在运行时禁止切换、停止和另起安装', async () => {
    const { p, backend } = isoProvider();
    const m = manager(p);
    p._installSessionActive = true;
    backend.alive = true;
    const next = { id: 'other', getLocalStatus: async () => ({ installed: true }) };
    m._providers.set('other', next);
    assert.strictEqual((await m.switchTo('other')).ok, false);
    assert.strictEqual((await m.installSystem('other')).ok, false);
    assert.strictEqual((await m.stopCurrent()).ok, false);
    assert.strictEqual(backend.stops, 0);
  });
  await test('旧系统停止失败时禁止启动新系统', async () => {
    const { p } = isoProvider();
    const m = manager(p);
    let starts = 0;
    m._current.systemId = 'old-running';
    m._providers.set('old-running', {
      getLocalStatus: async () => ({ running: true }),
      stop: async () => ({ ok: false, error: '仍在线' }),
    });
    m._providers.set('other', {
      getLocalStatus: async () => ({ installed: true }),
      start: async () => { starts += 1; return { ok: true }; },
    });
    assert.strictEqual((await m.switchTo('other')).ok, false);
    assert.strictEqual(starts, 0);
    const builtin = createProvider('google-play', { dataDir: path.join(ROOT, 'stop-failure'),
      backendEngine: { stop: async () => false }, settingsFn: () => ({ runtime: {} }) });
    assert.strictEqual((await builtin.stop()).ok, false);
  });
  await test('旧installed标志不当作完成证据，也不自动重装已有磁盘', async () => {
    const { p, backend } = isoProvider();
    await p.createDevice();
    p.writeManifest({ installed: true, version: 'old' });
    assert.strictEqual((await p.getLocalStatus()).installed, false);
    assert.strictEqual((await p.start()).ok, false);
    const task = new SystemTask({ systemId: p.id });
    const r = await p.install(task);
    assert(r.awaitingConfirmation && r.legacyReview);
    assert.strictEqual(backend.starts, 0);
    assert.strictEqual(fs.statSync(p.diskPath()).size, 128);
  });
  await test('Linux路径尊重XDG，自定义运行时和Provider目录注入保持一致', () => {
    const linux = resolveSystemPaths({ platform: 'linux', env: { XDG_DATA_HOME: path.join(ROOT, 'linux-xdg') },
      homeDir: path.join(ROOT, 'linux-home'), store: { getSettings: () => ({ runtime: {} }) } });
    assert.strictEqual(linux.appDataDir, path.join(ROOT, 'linux-xdg', 'apkstart'));
    const custom = resolveSystemPaths({ store: { DATA_DIR: ROOT, getSettings: () => ({ runtime: { dir: path.join(ROOT, 'custom-runtime') } }) } });
    assert.strictEqual(custom.systemsDir, path.join(ROOT, 'custom-runtime', 'systems'));
    const injected = path.join(ROOT, 'explicit-provider');
    const p = createProvider('android-x86', { dataDir: injected, settingsFn: () => ({ runtime: {} }) });
    assert.strictEqual(p.dataDir, injected);
  });
  await test('旧目录只提示，不静默搬移或覆盖大磁盘', () => {
    const old = path.join(ROOT, 'legacy');
    const target = path.join(ROOT, 'new-data');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'system.qcow2'), 'valuable');
    const warnings = legacyPathWarnings(target, [old]);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].code, 'LEGACY_SYSTEM_DATA');
    assert.strictEqual(fs.readFileSync(path.join(old, 'system.qcow2'), 'utf8'), 'valuable');
    assert(!fs.existsSync(target));
  });
  console.log(`系统安装安全回归：${passed} 通过，0 失败`);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(ROOT, { recursive: true, force: true }));

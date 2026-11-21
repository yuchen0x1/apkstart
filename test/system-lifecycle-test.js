'use strict';
/** QEMU/system-manager 生命周期回归：仅 fake provider/process/socket/ADB，不连接真实设备。 */
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemManager } = require('../src/core/system-manager');
const { QemuBackend } = require('../src/core/system-providers/qemu-backend');
const { EmulatorProvider } = require('../src/core/system-providers/emulator-provider');
const { QemuIsoProvider } = require('../src/core/system-providers/qemu-iso-provider');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-system-lifecycle-'));
let passed = 0;
async function test(name, fn) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture did not settle: ' + name)), 5000);
    })]);
    passed += 1;
    console.log('  ✓ ' + name);
  } finally { clearTimeout(timer); }
}
let seq = 0;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function managerWith(providers) {
  const dataDir = path.join(ROOT, 'manager-' + (++seq));
  const m = new SystemManager({ dataDir, store: { DATA_DIR: ROOT, getSettings: () => ({ runtime: {} }) },
    settingsFn: () => ({ runtime: {} }) });
  m._current = { systemId: '', startedAt: '' };
  for (const p of providers) m._providers.set(p.id, p);
  return m;
}
function fakeQemuProvider(id, options = {}) {
  const backend = {
    alive: false, adbPort: 6123, monitorPort: 6124, starts: 0, stops: 0,
    running() { return this.alive; },
    getEndpoints() { return this.alive ? { pid: 42, adbPort: this.adbPort, monitorPort: this.monitorPort, ownerToken: id } : null; },
    async waitAndroidReady(args) {
      this.lastWaitPort = args.adbPort;
      if (options.throwWait) throw new Error('synthetic ADB wait failure');
      return options.ready
        ? { ok: true, serial: `127.0.0.1:${args.adbPort}` }
        : { ok: false, error: 'synthetic ADB timeout' };
    },
  };
  const p = {
    id, displayName: id, backend,
    async getLocalStatus() { return { installed: true, running: backend.alive }; },
    async createDevice() { return { ok: true }; },
    async start() { backend.starts += 1; backend.alive = true; return {
      ok: true, backend: 'QemuBackend', needsAndroidReadyCheck: true,
      adbPort: backend.adbPort, monitorPort: backend.monitorPort,
    }; },
    async stop() { backend.stops += 1; backend.alive = false; return { ok: true }; },
    writeManifest() {},
  };
  return p;
}
function fakeSocketNet() {
  const calls = [];
  return {
    calls,
    connect(port, host, onConnect) {
      calls.push({ port, host });
      const socket = new EventEmitter();
      socket.write = (text) => { socket.written = text; };
      socket.end = () => {};
      socket.destroy = () => {};
      socket.setTimeout = () => {};
      process.nextTick(onConnect);
      return socket;
    },
  };
}
function fakeChild(pid = 9001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); return true; };
  return child;
}

function builtin(engine, options = {}) {
  return new EmulatorProvider({ systemId: 'google-play', backendEngine: engine,
    dataDir: path.join(ROOT, 'builtin-' + (++seq)), store: { DATA_DIR: ROOT },
    settingsFn: () => ({ runtime: {}, ...options }) });
}
function isoProvider(backend) {
  const p = new QemuIsoProvider({ systemId: 'iso-fixture', backend,
    dataDir: path.join(ROOT, 'iso-' + (++seq)), store: { DATA_DIR: ROOT }, settingsFn: () => ({ runtime: {}, engine: {} }) });
  p.createDevice = async () => ({ ok: true });
  fs.writeFileSync(p.diskPath(), 'synthetic qcow2');
  p.writeManifest({ installed: true, installationEvidence: {
    type: 'user-restored-backup', disk: p.diskPath(), restoredAt: 'fixture' } });
  return p;
}

(async () => {
  await test('内置 Provider 将 signal/timeout 传入 ensure，取消预启动等待后不启动设备', async () => {
    const entered = deferred();
    let spawns = 0;
    let seen;
    const engine = { status: async () => ({ vmRunning: false, deviceOnline: false }),
      ensure: async (ctx) => {
        seen = ctx;
        entered.resolve();
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
        if (!ctx.signal.aborted) spawns++;
        return { ok: false, code: 'START_CANCELLED' };
      } };
    const p = builtin(engine);
    const m = managerWith([p]);
    const pending = m.switchTo(p.id, { timeoutMs: 123 });
    await entered.promise;
    assert.equal((await m.stopCurrent()).ok, true);
    assert.equal((await pending).code, 'START_CANCELLED');
    assert.equal(seen.signal.aborted, true);
    assert.equal(seen.timeoutMs, 123);
    assert.equal(spawns, 0);
  });
  await test('不合作内置 ensure 未结算时绝不提前确认停止', async () => {
    const entered = deferred();
    const release = deferred();
    let alive = false;
    let stops = 0;
    const p = builtin({ status: async () => ({ vmRunning: alive, deviceOnline: false }),
      ensure: async () => { entered.resolve(); await release.promise; alive = true; return { ok: true }; },
      stop: async () => { stops++; alive = false; return true; } });
    const m = managerWith([p]);
    const pending = m.switchTo(p.id);
    await entered.promise;
    let stopped = false;
    const stopping = m.stopCurrent().then((r) => { stopped = true; return r; });
    await flush();
    assert.equal(stopped, false);
    assert.equal(stops, 0);
    release.resolve();
    assert.equal((await pending).code, 'START_CANCELLED');
    assert.equal((await stopping).ok, true);
    assert.equal(stops, 1);
    assert.equal(alive, false);
  });
  await test('内置未知/畸形状态和缺少 stop 方法均 fail closed', async () => {
    const p = builtin({ status: async () => ({ vmRunning: false }) });
    await assert.rejects(p.getRunningState(), /可验证/);
    await assert.rejects(p.getLocalStatus(), /可验证/);
    assert.equal((await p.stop()).ok, false);
    const shared = builtin({ status: async () => ({ vmRunning: true, deviceOnline: false }) },
      { runtime: { systemImageFlavor: 'default' } });
    assert.equal((await shared.getLocalStatus()).running, false);
    assert.equal(await shared.getRunningState(), true);
  });
  await test('内置 stop 后状态查询失败不能切换新系统或抹掉 current', async () => {
    let stopped = false;
    const p = builtin({ status: async () => {
      if (stopped) throw new Error('status unavailable after stop');
      return { vmRunning: true, deviceOnline: false };
    }, stop: async () => { stopped = true; return true; } });
    const next = fakeQemuProvider('after-unknown');
    const m = managerWith([p, next]);
    m._current = { systemId: p.id, running: true, vmStarted: true };
    assert.equal((await m.switchTo(next.id)).ok, false);
    assert.equal(next.backend.starts, 0);
    assert.equal(m._current.running, true);
    assert.equal(m._current.systemId, p.id);
  });
  await test('ISO accel await 期间取消不调用 startVM 或发布 running', async () => {
    const entered = deferred();
    const release = deferred();
    let spawns = 0;
    const p = isoProvider({ running: () => false,
      accelInfo: async () => { entered.resolve(); await release.promise; return {}; },
      startVM: async () => { spawns++; return { ok: true }; } });
    const m = managerWith([p]);
    const pending = m.switchTo(p.id);
    await entered.promise;
    const stopping = m.stopCurrent();
    release.resolve();
    assert.equal((await pending).code, 'START_CANCELLED');
    assert.equal((await stopping).ok, true);
    assert.equal(spawns, 0);
    assert.notEqual(p.readManifest().running, true);
  });
  await test('ISO signal 抵达真实 QEMU 端口分配，取消后零 spawn', async () => {
    const entered = deferred();
    const release = deferred();
    let spawns = 0;
    const backend = new QemuBackend({ portProbe: async (wanted) => {
      entered.resolve(); await release.promise; return wanted;
    }, spawnFn: () => { spawns++; return fakeChild(); } });
    backend.qemuExe = () => 'fake-qemu';
    backend.ovmfFirmware = () => '';
    backend.accelInfo = async () => ({});
    const p = isoProvider(backend);
    const c = new AbortController();
    const pending = p.start({ signal: c.signal });
    await entered.promise;
    c.abort();
    assert.equal((await pending).code, 'START_CANCELLED');
    release.resolve();
    await flush();
    assert.equal(spawns, 0);
    assert.notEqual(p.readManifest().running, true);
  });
  await test('取消未 spawn 的 guided 安装不留下可确认会话', async () => {
    const c = new AbortController();
    const taskAbort = new AbortController();
    let observed;
    const p = isoProvider({ running: () => false, accelInfo: async () => ({}),
      startVM: async ({ signal }) => { observed = signal; taskAbort.abort(); return { ok: false }; } });
    p.writeManifest({ installed: false, installationEvidence: null });
    fs.writeFileSync(p.isoPath(), 'synthetic ISO');
    p.createDevice = async () => ({ ok: true });
    const r = await p.install({ taskId: 'cancelled', signal: taskAbort.signal }, { signal: c.signal });
    assert.equal(r.code, 'START_CANCELLED');
    assert.equal(observed.aborted, true);
    assert.equal(c.signal.aborted, false);
    assert.equal(p.readManifest().installationPending, null);
    assert.equal(p._installSessionActive, false);
  });
  await test('ISO restart 未确认停止时不启动替代实例', async () => {
    let starts = 0;
    const p = isoProvider({ running: () => true, stop: async () => ({ ok: false }),
      startVM: async () => { starts++; return { ok: true }; } });
    assert.equal((await p.restart()).ok, false);
    assert.equal(starts, 0);
  });
  await test('内置 Provider 状态查询失败不能冒充 stopped 或切到新 Provider', async () => {
    const engine = { async status() { throw new Error('synthetic status failure'); }, async stop() { this.stops = (this.stops || 0) + 1; return true; },
      async ensure() { this.starts = (this.starts || 0) + 1; return { ok: true }; } };
    const old = new EmulatorProvider({ systemId: 'google-play', backendEngine: engine,
      store: { DATA_DIR: ROOT, getSettings: () => ({ runtime: {} }) }, settingsFn: () => ({ runtime: {} }) });
    const next = fakeQemuProvider('new-system');
    const m = managerWith([old, next]);
    m._current = { systemId: old.id, running: true, vmStarted: true };
    const result = await m.switchTo(next.id);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /无法确认/);
    assert.strictEqual(engine.stops || 0, 0);
    assert.strictEqual(next.backend.starts, 0);
    assert.strictEqual(m._current.systemId, old.id);
    assert.strictEqual(m._current.running, true);
  });

  await test('ADB 超时后 QEMU 实例仍记录为当前并可停止', async () => {
    const p = fakeQemuProvider('qemu-a');
    const m = managerWith([p]);
    const result = await m.switchTo(p.id, { timeoutMs: 1 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.vmStarted, true);
    assert.strictEqual(m._current.systemId, p.id);
    assert.strictEqual(m._current.running, true);
    assert.strictEqual(m._current.androidReady, false);
    assert.strictEqual(p.backend.lastWaitPort, 6123);
    const stopped = await m.stopCurrent();
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(p.backend.stops, 1);
    assert.strictEqual(m._current.running, false);
    assert.strictEqual(p.backend.alive, false);
  });

  await test('current.json 替换失败保留旧文件和真实进程归属，恢复后可以停机并保存', async () => {
    const p = fakeQemuProvider('qemu-persistence', { ready: true });
    const m = managerWith([p]);
    fs.mkdirSync(m.dataDir, { recursive: true });
    const file = path.join(m.dataDir, 'current.json');
    const previous = '{"systemId":"prior","running":false}';
    fs.writeFileSync(file, previous);
    const renameSync = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === file) throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
      return renameSync(from, to);
    };
    try {
      const start = await m.switchTo(p.id);
      assert.equal(start.ok, false);
      assert.equal(start.androidReady, true);
      assert.match(start.persistenceError, /current\.json.*EIO/);
      assert.equal((await m.getStatus()).current.systemId, p.id);
      assert.equal((await m.getStatus()).current.running, true);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
      const stop = await m.stopCurrent();
      assert.equal(stop.ok, false);
      assert.equal(stop.running, false);
      assert.equal(p.backend.alive, false);
      assert.equal(p.backend.stops, 1);
      assert.equal((await m.getStatus()).current.running, false);
      assert.match((await m.getStatus()).persistenceError, /EIO/);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
      assert.deepEqual(fs.readdirSync(m.dataDir), ['current.json']);
    } finally { fs.renameSync = renameSync; }
    const retry = await m.stopCurrent();
    assert.equal(retry.ok, true);
    assert.equal(p.backend.stops, 1, '已确认退出的进程不应被重复停止');
    assert.equal((await m.getStatus()).persistenceError, undefined);
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(current.systemId, p.id);
    assert.equal(current.stopped, true);
  });

  await test('未就绪实例再次 switch 不重复 spawn，且切到其它系统前先停止旧实例', async () => {
    const a = fakeQemuProvider('qemu-a');
    const b = { id: 'qemu-b', displayName: 'qemu-b', starts: 0, alive: false,
      async getLocalStatus() { return { installed: true, running: this.alive }; },
      async createDevice() { return { ok: true }; },
      async start() { this.starts += 1; this.alive = true; return { ok: true }; },
      async stop() { this.alive = false; return { ok: true }; } };
    const m = managerWith([a, b]);
    await m.switchTo(a.id, { timeoutMs: 1 });
    const retry = await m.switchTo(a.id, { timeoutMs: 1 });
    assert.strictEqual(retry.vmStarted, true);
    assert.strictEqual(a.backend.starts, 1);
    const next = await m.switchTo(b.id);
    assert.strictEqual(next.ok, true);
    assert.strictEqual(a.backend.alive, false);
    assert.strictEqual(a.backend.stops, 1);
    assert.strictEqual(m._current.systemId, b.id);
  });

  await test('等待 ADB 抛异常时登记仍存活实例，stopCurrent 可回收', async () => {
    const p = fakeQemuProvider('qemu-throw', { throwWait: true });
    const m = managerWith([p]);
    const result = await m.switchTo(p.id, { timeoutMs: 1 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.vmStarted, true);
    assert.strictEqual(m._current.systemId, p.id);
    assert.strictEqual(m._current.running, true);
    assert.strictEqual((await m.stopCurrent()).ok, true);
  });

  await test('QEMU 启动端口先探测冲突再分配 loopback 空闲端口，ADB 使用实际转发端口', async () => {
    const probeCalls = [];
    const argsCaptured = [];
    const child = fakeChild();
    const be = new QemuBackend({ systemId: 'port-fixture', portProbe: async (wanted) => {
      probeCalls.push(wanted);
      if (wanted === 5555 || wanted === 5580) return { ok: false, port: 0 };
      const dynamic = [62001, 62001, 62002][probeCalls.filter((n) => n === 0).length - 1];
      return { ok: true, port: wanted === 0 ? dynamic : wanted };
    }, spawnFn: (_exe, args) => { argsCaptured.push(args); return child; },
    adbClientFactory: ({ serial }) => ({ serial, connect: async () => true, isOnline: async () => true,
      shell: async () => '1' }) });
    be.qemuExe = () => 'fake-qemu';
    be.ovmfFirmware = () => '';
    const started = await be.startVM({ startupGraceMs: 0, uefi: false });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.adbPort, 62001);
    assert.strictEqual(started.monitorPort, 62002);
    assert(argsCaptured[0].some((arg) => arg.includes('hostfwd=tcp:127.0.0.1:62001-:5555')));
    assert(argsCaptured[0].some((arg) => arg.includes('tcp:127.0.0.1:62002,server,nowait')));
    const ready = await be.waitAndroidReady({ timeoutMs: 10 });
    assert.strictEqual(ready.ok, true);
    assert.strictEqual(ready.adbPort, 62001);
    assert.strictEqual(ready.serial, '127.0.0.1:62001');
    child.kill();
  });

  await test('stop 只触达归属 monitor，未归属 stop 拒绝且不连接固定端口', async () => {
    const socketNet = fakeSocketNet();
    const child = fakeChild(9002);
    const be = new QemuBackend({ systemId: 'monitor-owner', net: socketNet,
      portProbe: async (wanted) => ({ ok: true, port: wanted || (socketNet.calls.length ? 63002 : 63001) }),
      spawnFn: () => child });
    be.qemuExe = () => 'fake-qemu';
    be.ovmfFirmware = () => '';
    const unowned = await be.stop();
    assert.strictEqual(unowned.ok, false);
    assert.strictEqual(unowned.code, 'NOT_OWNER');
    assert.strictEqual(socketNet.calls.length, 0);
    const started = await be.startVM({ startupGraceMs: 0, adbPort: 63001, monitorPort: 63002, uefi: false });
    assert.strictEqual(started.ok, true);
    const stopped = await be.stop({ graceTimeoutMs: 1, killTimeoutMs: 10, monitorTimeoutMs: 10 });
    assert.strictEqual(stopped.ok, true);
    assert.deepStrictEqual(socketNet.calls.map((x) => x.port), [63002]);
    assert.strictEqual(be.running(), false);
    assert(!socketNet.calls.some((x) => x.port === 5580));
  });

  await test('kill 后未收到退出确认时返回失败并保留进程/端口句柄', async () => {
    const socketNet = fakeSocketNet();
    const child = new EventEmitter();
    child.pid = 9003;
    child.exitCode = null;
    child.stderr = new EventEmitter();
    child.kill = () => true; // 故意不发 exit，模拟 kill 未能确认退出
    const be = new QemuBackend({ systemId: 'stuck', net: socketNet,
      portProbe: async (wanted) => ({ ok: true, port: wanted || 64001 }), spawnFn: () => child });
    be.qemuExe = () => 'fake-qemu';
    be.ovmfFirmware = () => '';
    await be.startVM({ startupGraceMs: 0, uefi: false });
    const failed = await be.stop({ graceTimeoutMs: 1, killTimeoutMs: 1, monitorTimeoutMs: 1 });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.code, 'EXIT_NOT_CONFIRMED');
    assert.strictEqual(be.proc, child);
    assert.strictEqual(be.running(), true);
    assert.strictEqual(be.getEndpoints().monitorPort, failed.monitorPort);
    const endpoint = be.getEndpoints();
    child.emit('error', new Error('kill could not terminate child'));
    const retry = await be.startVM({ startupGraceMs: 0 });
    assert.strictEqual(retry.ok, false);
    assert.strictEqual(be.proc, child);
    assert.deepStrictEqual(be.getEndpoints(), endpoint);
    child.emit('exit', 0);
  });

  for (const late of ['ready', 'error']) {
    await test(`stop cancels pending ADB result (${late}); next switch owns state and manifest`, async () => {
      const a = fakeQemuProvider('old');
      const b = fakeQemuProvider('next', { ready: true });
      const entered = deferred();
      const oldReady = deferred();
      const writes = [];
      a.writeManifest = (patch) => writes.push(patch);
      a.backend.waitAndroidReady = (args) => { entered.resolve(args); return oldReady.promise; };
      const m = managerWith([a, b]);
      const switching = m.switchTo(a.id);
      assert.strictEqual(m.switchTo(a.id), switching);
      assert.strictEqual((await m.getStatus()).switching, true);
      const args = await entered.promise;
      const stop = m.stopCurrent();
      assert.strictEqual(m.stopCurrent(), stop);
      assert.strictEqual((await m.switchTo(b.id)).ok, false);
      assert.strictEqual((await stop).ok, true);
      assert.strictEqual(args.signal.aborted, true);
      assert.strictEqual((await switching).code, 'START_CANCELLED');
      assert.strictEqual(m._current.running, false);
      assert.deepStrictEqual(writes, [{ running: false, androidReady: false }]);
      assert.strictEqual((await m.switchTo(b.id)).ok, true);
      if (late === 'ready') oldReady.resolve({ ok: true, serial: 'old-serial' });
      else oldReady.reject(new Error('late ADB failure'));
      await flush();
      assert.strictEqual(m._current.systemId, b.id);
      assert.strictEqual(m._current.running, true);
      assert.deepStrictEqual(writes, [{ running: false, androidReady: false }, { running: false, androidReady: false }]);
      assert.strictEqual(JSON.parse(fs.readFileSync(m._currentFile(), 'utf8')).systemId, b.id);
    });
  }

  await test('stop fences a Provider.start that has not returned before checking the new child', async () => {
    const p = fakeQemuProvider('late-spawn');
    const entered = deferred();
    const release = deferred();
    const start = p.start.bind(p);
    p.start = async () => { entered.resolve(); await release.promise; return start(); };
    const m = managerWith([p]);
    const switching = m.switchTo(p.id);
    await entered.promise;
    let didStop = false;
    const stopping = m.stopCurrent().then((r) => { didStop = true; return r; });
    await flush();
    assert.strictEqual(didStop, false);
    release.resolve();
    assert.strictEqual((await switching).code, 'START_CANCELLED');
    assert.strictEqual((await stopping).ok, true);
    assert.strictEqual(p.backend.starts, 1);
    assert.strictEqual(p.backend.stops, 1);
    assert.strictEqual(m._current.running, false);
  });

  await test('stop without an exit acknowledgement blocks replacement, restore and remove', async () => {
    const p = fakeQemuProvider('stuck-old', { ready: true });
    const next = fakeQemuProvider('never-started', { ready: true });
    const m = managerWith([p, next]);
    p.stop = async () => undefined;
    p.restore = p.remove = async () => { throw new Error('must not touch live userdata'); };
    assert.strictEqual((await m.switchTo(p.id)).ok, true);
    assert.strictEqual((await m.stopCurrent()).ok, false);
    assert.strictEqual(m._current.running, true);
    assert.strictEqual((await m.switchTo(next.id)).ok, false);
    assert.strictEqual(next.backend.starts, 0);
    assert.match((await m.restore(p.id, ROOT)).error, /先停止/);
    assert.match((await m.removeSystem(p.id)).error, /先停止/);
  });

  await test('only identical starts share the pending promise, including port allocation', async () => {
    const firstProbe = deferred();
    const entered = deferred();
    let probes = 0;
    let spawns = 0;
    const child = fakeChild();
    const be = new QemuBackend({ portProbe: async (wanted) => {
      if (++probes === 1) { entered.resolve(); await firstProbe.promise; }
      return wanted;
    }, spawnFn: () => { spawns++; return child; } });
    be.qemuExe = () => 'fake-qemu';
    be.ovmfFirmware = () => '';
    const opts = { disk: 'fake-disk', startupGraceMs: 0, uefi: false };
    const started = be.startVM(opts);
    await entered.promise;
    assert.strictEqual(be.startVM({ ...opts }), started);
    assert.strictEqual((await be.startVM({ ...opts, install: true })).code, 'START_BUSY');
    firstProbe.resolve();
    assert.strictEqual((await started).ok, true);
    assert.strictEqual(spawns, 1);
    assert.strictEqual(be.proc, child);
    child.kill();
  });

  await test('stop cancels unresolved port allocation; old result cannot spawn or clear next promise', async () => {
    const entered = deferred();
    const portProbe = deferred();
    const child = fakeChild();
    let probeCount = 0;
    let spawns = 0;
    const be = new QemuBackend({ portProbe: async (port) => {
      if (++probeCount === 1) { entered.resolve(); await portProbe.promise; }
      return port;
    }, spawnFn: () => { spawns++; return child; } });
    be.qemuExe = () => 'fake-qemu';
    be.ovmfFirmware = () => '';
    const starting = be.startVM({ startupGraceMs: 0 });
    await entered.promise;
    assert.strictEqual((await be.stop()).ok, true);
    assert.strictEqual((await starting).code, 'START_CANCELLED');
    const next = be.startVM({ startupGraceMs: 0 });
    portProbe.resolve();
    assert.strictEqual((await next).ok, true);
    assert.strictEqual(spawns, 1);
    assert.strictEqual(be.proc, child);
    child.kill();
  });

  await test('ADB result and close from old child cannot affect next process on reused ports', async () => {
    const entered = deferred();
    const bootCompleted = deferred();
    const children = [fakeChild(9010), fakeChild(9011)];
    let spawns = 0;
    const be = new QemuBackend({ net: fakeSocketNet(), portProbe: async (port) => port,
      spawnFn: () => children[spawns++], adbClientFactory: ({ serial }) => ({
        serial, connect: async () => true, isOnline: async () => true,
        shell: () => { entered.resolve(); return bootCompleted.promise; },
      }) });
    be.qemuExe = () => 'fake-qemu';
    be.ovmfFirmware = () => '';
    const opts = { startupGraceMs: 0 };
    const a = await be.startVM(opts);
    assert.strictEqual((await be.waitAndroidReady({ adbPort: a.adbPort + 1 })).code, 'NOT_OWNER');
    const waiting = be.waitAndroidReady({ ownerToken: a.ownerToken });
    await entered.promise;
    assert.strictEqual((await be.stop({ graceTimeoutMs: 1, killTimeoutMs: 1 })).ok, true);
    assert.strictEqual((await waiting).code, 'START_CANCELLED');
    const b = await be.startVM(opts);
    assert.notStrictEqual(b.ownerToken, a.ownerToken);
    children[0].emit('close', 0);
    children[0].emit('error', new Error('late child event'));
    bootCompleted.resolve('1');
    await flush();
    assert.strictEqual(be.proc, children[1]);
    assert.strictEqual(be.getEndpoints().ownerToken, b.ownerToken);
    assert.strictEqual((await be.stop({ ownerToken: a.ownerToken })).code, 'NOT_OWNER');
    children[1].kill();
  });

  console.log(`系统生命周期回归：${passed} 通过，0 失败`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
});

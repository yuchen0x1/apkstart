'use strict';
// Production modules run against memory-only OS/ADB fakes. Never touch a live VM.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = path.join(__dirname, '..', 'src', 'core');
const engineSource = fs.readFileSync(path.join(CORE, 'engine.js'), 'utf8');
const ownerSource = fs.readFileSync(path.join(CORE, 'process-owner.js'), 'utf8');
const forbidden = () => { throw new Error('unexpected host or guest operation'); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function evaluate(source, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: CORE, Buffer,
    process: { platform: 'win32', pid: 999, env: {} },
    setTimeout, clearTimeout, AbortController, Date,
    require: (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`unmocked module: ${name}`);
    },
    ...globals,
  }, { filename: path.join(CORE, 'launch-performance-fixture.js') });
  return module.exports;
}

function runtime({ clock } = {}) {
  const settings = { engine: { mode: 'builtin', priorityMode: 'performance' } };
  const calls = { priority: [], snapshots: [], cancel: 0, idle: [], stop: [], probes: [], watchdogs: [] };
  const processOwner = { listeners: forbidden, getProcessInfos: forbidden };
  const dependencies = {
    fs: {}, path, net: {}, child_process: { spawn: forbidden },
    './adb': {}, './android': {}, './store': {
      DATA_DIR: 'fixture', getSettings: () => settings, getApps: () => [],
    },
    './provision': {}, './emulator': { EmulatorEngine: class {} },
    './doctor': {}, './repair': {}, './container': require('../src/core/container'),
    './guest': {}, './platform': {}, './process-owner': processOwner, './userdata': {},
  };
  const globals = {
    setInterval: (callback) => { calls.watchdogs.push(callback); return { unref() {} }; },
    ...(clock ? { Date: { now: () => clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } : {}),
  };
  const { Runtime } = evaluate(engineSource, dependencies, globals);
  const rt = Object.create(Runtime.prototype);
  Object.assign(rt, {
    _activeApps: new Set(), _foregroundLaunches: new Set(),
    emuSerial: 'emulator-5554', vmProc: null,
    emulator: {
      running: () => true,
      cancelSnapshotSave: () => { calls.cancel += 1; },
      scheduleSnapshotSave: (_adb, options) => { calls.snapshots.push(options); },
      setPriority: async (level) => { calls.priority.push(level); },
      checkNetwork: forbidden, repairWifi: forbidden,
    },
    provisioner: { checkEnv: async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } }) },
    log: () => {}, adbPath: () => 'fixture-adb',
    client: () => ({
      isOnline: forbidden,
      forceStop: async (pkg) => { calls.stop.push(pkg); },
      shell: async (command) => { calls.idle.push(command); },
    }),
  });
  return { rt, settings, calls, processOwner };
}

class Clock {
  now = 100000;
  next = 0;
  timers = new Map();
  setTimeout = (callback, delay = 0) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  async advance(ms) {
    const until = this.now + ms;
    await flush();
    for (;;) {
      const entry = [...this.timers].filter(([, item]) => item.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      const [id, timer] = entry;
      this.now = timer.at;
      this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

function ownerFixture(output) {
  const calls = [];
  const native = (name) => {
    if (!name || name.includes('missing')) throw new Error('missing fixture file');
    return name;
  };
  const owner = evaluate(ownerSource, {
    fs: { realpathSync: { native } }, path: path.win32,
    child_process: {
      spawnSync: forbidden,
      execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        queueMicrotask(() => callback(null, typeof output === 'function' ? output(args) : output));
      },
    },
  });
  return { owner, calls };
}

test('listener inspection uses one helper and rejects missing/unrequested identities', async () => {
  const { owner, calls } = ownerFixture(JSON.stringify([
    { pid: 10, started: 'birth-10', exe: 'C:\\fixture\\emulator.exe', commandLine: 'owned' },
    { pid: 10, started: 'duplicate', exe: 'C:\\fixture\\emulator.exe' },
    { pid: 20, started: '', exe: 'C:\\fixture\\emulator.exe' },
    { pid: 30, started: 'birth-30', exe: 'C:\\missing\\emulator.exe' },
    { pid: 40, started: 'unrequested', exe: 'C:\\fixture\\emulator.exe' },
  ]));
  const controller = new AbortController();
  const infos = await owner.getProcessInfos([10, 20, 10, 30, 0, -1, 999], { timeoutMs: 321, signal: controller.signal });
  assert.equal(calls.length, 1);
  assert(calls[0].args.includes('InspectMany'));
  const encoded = calls[0].args[calls[0].args.indexOf('-TargetPids') + 1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64')), [10, 20, 30]);
  assert.deepEqual(plain(infos).map((info) => [info.pid, info.started]), [[10, 'birth-10']]);
  assert.equal(calls[0].options.timeout, 321);
  assert.equal(calls[0].options.signal, controller.signal);
  controller.abort();
  assert.deepEqual(plain(await owner.getProcessInfos([10], { signal: controller.signal })), []);
  assert.equal(calls.length, 1);
});

test('process and port queries forward cancellation and remaining child timeout', async () => {
  const { owner, calls } = ownerFixture((args) => args.includes('Inspect')
    ? JSON.stringify({ pid: 10, started: 'birth', exe: 'C:\\fixture\\emulator.exe' })
    : '  TCP    127.0.0.1:5554  0.0.0.0:0  LISTENING  10');
  const controller = new AbortController();
  const options = { timeoutMs: 75, signal: controller.signal };
  assert.equal((await owner.getProcessInfo(10, options)).pid, 10);
  assert.equal(await owner.pidOnPort(5554, options), 10);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.timeout, 75);
    assert.equal(call.options.signal, controller.signal);
  }
  controller.abort();
  assert.equal(await owner.getProcessInfo(10, options), null);
  assert.equal(await owner.pidOnPort(5554, options), 0);
  assert.equal(calls.length, 2);
});

test('tree snapshots verify the same root identity around one batched helper call', async () => {
  const root = { pid: 10, started: 'root-birth', exe: 'C:\\fixture\\emulator.exe', commandLine: 'root', priorityClass: 32 };
  const child = { pid: 20, started: 'child-birth', exe: 'C:\\fixture\\qemu.exe', commandLine: 'child', priorityClass: 64 };
  const { owner, calls } = ownerFixture(JSON.stringify({ root, currentRoot: { ...root }, processes: [child, { ...child }, root] }));
  const controller = new AbortController();
  const snapshot = await owner.getProcessTreeSnapshot(10, { timeoutMs: 456, signal: controller.signal });
  assert.equal(calls.length, 1);
  assert(calls[0].args.includes('TreeSnapshot'));
  assert.equal(calls[0].options.timeout, 456);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(snapshot.root.priorityClass, 32);
  assert.deepEqual(plain(snapshot.processes), [{ ...child, exe: child.exe.toLowerCase() }]);
  controller.abort();
  assert.equal(await owner.getProcessTreeSnapshot(10, { signal: controller.signal }), null);
  assert.equal(calls.length, 1);
});

test('tree snapshots fail closed for a wrong, replaced or incomplete root', async () => {
  const root = { pid: 10, started: 'root-birth', exe: 'C:\\fixture\\emulator.exe', commandLine: 'root' };
  for (const change of [{ pid: 11 }, { started: 'new-birth' }, { exe: 'C:\\fixture\\other.exe' }, { commandLine: 'changed' }, { exe: 'C:\\missing\\emulator.exe' }]) {
    const { owner } = ownerFixture(JSON.stringify({ root, currentRoot: { ...root, ...change }, processes: [] }));
    assert.equal(await owner.getProcessTreeSnapshot(10), null);
  }
  const { owner } = ownerFixture(JSON.stringify({ root, currentRoot: root }));
  assert.equal(await owner.getProcessTreeSnapshot(10), null);
});

test('runtime discovery batches all unique listener PIDs and still checks ownership', async () => {
  const { rt, processOwner } = runtime();
  const inspected = [];
  const checked = [];
  processOwner.listeners = async () => [
    { pid: 10, port: 80 }, { pid: 20, port: 5554 }, { pid: 20, port: 5555 }, { pid: 30, port: 6000 },
  ];
  processOwner.getProcessInfos = async (pids) => {
    inspected.push(plain(pids));
    return [{ pid: 10 }, { pid: 20, owned: true }, { pid: 30 }];
  };
  rt.emulator.ownsProcess = (info) => { checked.push(info.pid); return info.owned === true; };
  assert.deepEqual(plain(await rt.emulatorPorts()), [5554]);
  assert.deepEqual(inspected, [[10, 20, 30]]);
  assert.deepEqual(checked, [10, 20, 30]);
});

test('active runtime roots inspect only the current verified runtime', async () => {
  const { rt, processOwner } = runtime();
  const serials = [];
  rt.ownedRuntimeIdentity = async (serial) => {
    serials.push(serial);
    return { exe: 'verified-emulator' };
  };
  processOwner.emulatorRoot = (exe) => exe === 'verified-emulator' ? 'narrow-runtime-root' : '';
  assert.deepEqual(plain(await rt.activeRuntimeRoots()), ['narrow-runtime-root']);
  assert.deepEqual(serials, ['emulator-5554']);
  rt.ownedRuntimeIdentity = async () => null;
  assert.deepEqual(plain(await rt.activeRuntimeRoots()), []);
});

test('a foreground lease prevents prewarm completion from parking the emulator', async () => {
  const { rt, calls } = runtime();
  const ready = deferred();
  rt.ensure = async () => ready.promise;
  const warming = rt.prewarm();
  await flush();
  const lease = rt.acquireForegroundLaunch();
  assert.equal(rt.containerIdle, false);
  ready.resolve({ ok: true });
  assert.equal((await warming).ok, true);
  await lease.promote();
  assert(!calls.priority.includes('idle'));
  rt._activeApps.add('com.ready');
  const beforeRelease = calls.priority.length;
  await lease.release();
  assert.equal(calls.priority.length, beforeRelease, 'active-session release must avoid another PowerShell tree query');
  assert.equal(rt.containerIdle, false);
});

test('priority writes serialize so an earlier idle cannot overwrite foreground promotion', async () => {
  const { rt, calls } = runtime();
  const idle = deferred();
  rt.emulator.setPriority = async (level) => {
    calls.priority.push(level);
    if (level === 'idle') await idle.promise;
  };
  const parking = rt._queueContainerPriority();
  await flush();
  assert.deepEqual(calls.priority, ['idle']);
  const lease = rt.acquireForegroundLaunch();
  const promotion = lease.promote();
  await flush();
  assert.deepEqual(calls.priority, ['idle']);
  idle.resolve();
  await Promise.all([parking, promotion]);
  assert.deepEqual(calls.priority, ['idle', 'normal']);
  rt._activeApps.add('com.ready');
  await lease.release();
});

test('cold early promotion does not cache a no-runtime result', async () => {
  const { rt, calls } = runtime();
  rt.emulator.running = () => false;
  const lease = rt.acquireForegroundLaunch();
  await lease.promote({ onlyIfRunning: true });
  assert.deepEqual(calls.priority, []);
  rt.emulator.running = () => true;
  await lease.promote();
  await lease.promote();
  assert.deepEqual(calls.priority, ['normal']);
  rt._activeApps.add('com.ready');
  await lease.release();
});

test('lease promotion refreshes after the desired priority level changes', async () => {
  const { rt, calls, settings } = runtime();
  const lease = rt.acquireForegroundLaunch();
  await lease.promote();
  await lease.promote();
  assert.deepEqual(calls.priority, ['normal']);
  settings.engine.priorityMode = 'balanced';
  await lease.promote();
  await lease.promote();
  assert.deepEqual(calls.priority, ['normal', 'below']);
  settings.engine.priorityMode = 'game';
  await lease.promote();
  assert.deepEqual(calls.priority, ['normal', 'below'], 'an unchanged target level stays idempotent');
  settings.engine.priorityMode = 'performance';
  await lease.promote();
  assert.deepEqual(calls.priority, ['normal', 'below', 'normal']);
  rt._activeApps.add('com.ready');
  await lease.release();
});

test('snapshot callbacks and release account for in-flight launches and release is idempotent', async () => {
  const { rt, calls } = runtime();
  rt._armSnapshotSave();
  const original = calls.snapshots[0];
  assert.equal(original.isIdle(), true);
  const lease = rt.acquireForegroundLaunch();
  assert.equal(original.isIdle(), false);
  rt._armSnapshotSave();
  assert.equal(calls.snapshots.length, 1);
  await lease.promote();
  await lease.release();
  const count = calls.priority.length;
  const snapshots = calls.snapshots.length;
  await lease.release();
  assert.equal(calls.priority.length, count);
  assert.equal(calls.snapshots.length, snapshots);
  assert.equal(rt.containerIdle, true);
  assert.equal(original.isIdle(), true);
  assert.equal(calls.priority.at(-1), 'idle');
});

test('closing the previous app cannot idle or snapshot an in-flight launch', async () => {
  const { rt, calls } = runtime();
  rt._activeApps.add('com.old');
  const stopped = deferred();
  const client = { forceStop: () => stopped.promise, shell: forbidden };
  const closing = rt.endApp('com.old', { client });
  const lease = rt.acquireForegroundLaunch();
  stopped.resolve();
  await closing;
  await lease.promote();
  assert(!calls.priority.includes('idle'));
  assert.equal(calls.snapshots.length, 0);
  rt._activeApps.add('com.new');
  await lease.release();
});

test('foreground promotion waits for an already-issued Android idle command', async () => {
  const { rt, calls } = runtime();
  rt._activeApps.add('com.old');
  const shell = deferred();
  const closing = rt.endApp('com.old', { client: { forceStop: async () => {}, shell: () => shell.promise } });
  await flush();
  assert(rt._idleTransitionPromise);
  const lease = rt.acquireForegroundLaunch();
  let promoted = false;
  const promotion = lease.promote().then(() => { promoted = true; });
  await flush();
  assert.equal(promoted, false);
  shell.resolve();
  await Promise.all([closing, promotion]);
  assert.equal(promoted, true);
  assert.deepEqual(calls.priority, ['normal']);
  assert.equal(calls.snapshots.length, 0);
  rt._activeApps.add('com.new');
  await lease.release();
});

test('idle watchdog never inspects or stops a foreground launch that outlasts its idle timeout', async () => {
  const clock = new Clock();
  const { rt, calls, settings } = runtime({ clock });
  settings.engine.idleShutdownMinutes = 1;
  const lease = rt.acquireForegroundLaunch();
  rt.lastActivity = 0;
  let queries = 0;
  let stopped = 0;
  rt.client = () => { queries += 1; return { runningPackages: async () => [] }; };
  rt.stop = async () => { stopped += 1; };
  rt.startWatchdog();
  await calls.watchdogs[0]();
  assert.equal(queries, 0);
  assert.equal(stopped, 0);
  rt._activeApps.add('com.ready');
  await lease.release();
});

test('idle watchdog rechecks launch activity after awaiting the package query', async () => {
  for (const withLease of [false, true]) {
    const clock = new Clock();
    const { rt, calls, settings } = runtime({ clock });
    const packages = deferred();
    settings.engine.idleShutdownMinutes = 1;
    rt.lastActivity = 0;
    rt.client = () => ({ runningPackages: () => packages.promise });
    let stopped = 0;
    rt.stop = async () => { stopped += 1; };
    rt.startWatchdog();
    const checking = calls.watchdogs[0]();
    await flush();
    const lease = withLease ? rt.acquireForegroundLaunch() : null;
    if (!lease) rt.touch();
    packages.resolve([]);
    await checking;
    assert.equal(stopped, 0);
    if (lease) {
      rt._activeApps.add('com.ready');
      await lease.release();
    }
  }
});

test('network waiting is read-only and its overall deadline includes slow probes', async () => {
  const clock = new Clock();
  const { rt, calls } = runtime({ clock });
  let probeSignal;
  rt.emulator.checkNetwork = async (_adb, options) => {
    calls.probes.push(options.timeoutMs);
    probeSignal = options.signal;
    return new Promise(() => {});
  };
  const waiting = rt.waitForNetwork({ timeoutMs: 20000 });
  await flush();
  assert.equal(probeSignal.aborted, false);
  await clock.advance(20000);
  assert.deepEqual(plain(await waiting), { ok: false, reason: 'timeout' });
  assert.equal(probeSignal.aborted, true);
  assert.deepEqual(calls.probes, [8000]);
  assert.equal(clock.timers.size, 0);
});

test('offline network probes retry only inside the remaining overall budget', async () => {
  const clock = new Clock();
  const { rt, calls } = runtime({ clock });
  rt.emulator.checkNetwork = async (_adb, options) => {
    calls.probes.push(options.timeoutMs);
    return { ok: false, reason: 'device-offline' };
  };
  const waiting = rt.waitForNetwork({ timeoutMs: 20000 });
  await clock.advance(20000);
  assert.equal((await waiting).reason, 'timeout');
  assert.deepEqual(calls.probes, [8000, 8000, 8000, 8000, 8000, 5000, 2000]);
  assert.equal(clock.now, 120000);
  assert.equal(clock.timers.size, 0);
});

test('network cancellation aborts the current probe and clears every wait timer', async () => {
  const clock = new Clock();
  const { rt } = runtime({ clock });
  const controller = new AbortController();
  let probeSignal;
  rt.emulator.checkNetwork = async (_adb, options) => {
    probeSignal = options.signal;
    return new Promise(() => {});
  };
  const waiting = rt.waitForNetwork({ timeoutMs: 20000, signal: controller.signal });
  const rejection = assert.rejects(waiting, { code: 'START_CANCELLED' });
  await flush();
  controller.abort();
  await rejection;
  assert.equal(probeSignal.aborted, true);
  assert.equal(clock.timers.size, 0);
});

test('a successful network probe returns immediately without a second online/repair pass', async () => {
  const clock = new Clock();
  const { rt } = runtime({ clock });
  rt.emulator.checkNetwork = async () => ({ ok: true, ip: '10.0.2.16' });
  assert.deepEqual(plain(await rt.waitForNetwork({ timeoutMs: 20000 })), { ok: true, ip: '10.0.2.16' });
  assert.equal(clock.now, 100000);
  assert.equal(clock.timers.size, 0);
});

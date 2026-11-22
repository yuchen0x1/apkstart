'use strict';
// VM-only regressions. All process/ADB/network dependencies are synthetic; files
// are private fixtures and image capacities are logical, not multi-GB allocations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const core = path.join(__dirname, '..', 'src', 'core');
const MB = 1048576;

// Only allow the dependency that is intentionally pure and has no host I/O.
// child_process, fs and net remain fixture-owned/forbidden inside the VM.
const PURE_MODULES = new Map([
  ['./peripherals', require('../src/core/peripherals')],
]);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function clock() {
  let now = 1700000000000;
  const timers = new Set();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: FakeDate,
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, at: now + Number(ms), unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        await next.fn();
      }
      now = end;
    },
  };
}

function fixture(t, { canEmbed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-snapshot-partition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const time = clock();
  const sizes = new Map();
  const calls = { spawn: [], tools: [], adb: [], removed: [], terminated: [], prepared: 0, beforeSpawn: 0 };
  const forbidden = () => assert.fail('unexpected real process, network or dependency');
  const safe = (file) => {
    const value = path.resolve(String(file));
    assert(value === root || value.startsWith(root + path.sep), `fixture escaped temp root: ${value}`);
    return file;
  };
  const tempFs = {};
  for (const name of ['existsSync', 'mkdirSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdtempSync', 'openSync']) {
    tempFs[name] = (file, ...args) => fs[name](safe(file), ...args);
  }
  for (const name of ['readSync', 'writeSync', 'closeSync']) tempFs[name] = fs[name].bind(fs);
  tempFs.statSync = (file) => {
    const stat = fs.statSync(safe(file));
    if (sizes.has(file)) Object.defineProperty(stat, 'size', { value: sizes.get(file) });
    return stat;
  };
  tempFs.rmSync = (file, options) => {
    safe(file);
    calls.removed.push(file);
    fs.rmSync(file, options);
    sizes.delete(file);
  };
  tempFs.renameSync = (from, to) => {
    fs.renameSync(safe(from), safe(to));
    if (sizes.has(from)) { sizes.set(to, sizes.get(from)); sizes.delete(from); }
  };
  tempFs.statfsSync = () => ({ bsize: 4096, bavail: 100000000 });
  const put = (file, contents = '') => {
    safe(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  const p = {
    root: path.join(root, 'runtime'), avdHome: path.join(root, 'avd'),
    emulatorExe: path.join(root, 'runtime', 'emulator', 'emulator.exe'),
    adbExe: path.join(root, 'adb.exe'), sysAbi: 'x86_64',
  };
  put(p.emulatorExe);
  put(p.adbExe);
  for (const tool of ['resize2fs.exe', 'e2fsck.exe']) put(path.join(path.dirname(p.emulatorExe), 'bin64', tool));
  const settings = { engine: { mode: 'builtin', keepSnapshot: true }, runtime: {} };
  const writes = [];
  const store = {
    DATA_DIR: path.join(root, 'data'), getSettings: () => settings,
    ensureDirs: () => fs.mkdirSync(path.join(root, 'data'), { recursive: true }),
    saveSettings(patch) {
      writes.push(patch);
      if (patch.engine) Object.assign(settings.engine, patch.engine);
    },
  };
  const owner = { pid: 1234, started: 'fixture-birth', owned: true };
  const state = {
    owner, healthy: true, saveOk: true, toolFailure: null, noResize: false,
    startupLines: [], accel: { ok: true, kind: 'whpx' },
  };
  const processOwner = {
    pidOnPort: async () => state.owner?.pid || 0,
    getProcessInfo: async (pid) => state.owner?.pid === pid ? state.owner : null,
    ownsEmulator: (info) => !!info?.owned,
    sameIdentity: (a, b) => !!a && !!b && a.pid === b.pid && a.started === b.started,
    terminateOwnedProcess: async (info, owns) => {
      assert(owns(info));
      calls.terminated.push(info);
      state.owner = null;
      return true;
    },
  };
  const seed = (bytes = 64 * MB, encrypt = false) => {
    const data = Buffer.alloc(4096);
    data.writeUInt16LE(0xEF53, 1024 + 0x38);
    data.writeUInt32LE(bytes / 4096, 1024 + 0x4);
    data.writeUInt32LE(2, 1024 + 0x18);
    data.writeUInt32LE(encrypt ? 0x10002 : 2, 1024 + 0x60);
    data.write('private-app-data', 2048);
    return data;
  };
  const setFsBytes = (file, bytes) => {
    const fd = fs.openSync(safe(file), 'r+');
    try {
      const data = Buffer.alloc(4);
      data.writeUInt32LE(bytes / 4096);
      fs.writeSync(fd, data, 0, 4, 1024 + 0x4);
    } finally { fs.closeSync(fd); }
  };
  let activeEngine;
  const childProcess = {
    execFileSync: forbidden,
    spawnSync(exe, args, options) {
      calls.tools.push({ exe, args, options });
      const failure = state.toolFailure?.(path.basename(exe), args, calls.tools);
      if (failure) return failure;
      if (/qemu-img(?:\.exe)?$/.test(exe)) {
        assert.equal(args[0], 'resize');
        assert.deepEqual([...args].slice(1, 3), ['-f', 'raw']);
        sizes.set(args[3], Number(args[4]));
      } else if (/resize2fs(?:\.exe)?$/.test(exe)) {
        if (!state.noResize) setFsBytes(args[0], sizes.get(args[0]) || fs.statSync(args[0]).size);
      } else assert.match(exe, /e2fsck(?:\.exe)?$/);
      return { status: 0, stdout: '', stderr: '' };
    },
    spawn(exe, args, options) {
      assert.equal(exe, p.emulatorExe);
      calls.spawn.push({ exe, args: [...args], options });
      const proc = new EventEmitter();
      proc.pid = owner.pid;
      proc.killed = false;
      proc.unref = () => {};
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.setEncoding = proc.stderr.setEncoding = () => {};
      queueMicrotask(() => {
        if (state.startupLines.length) proc.stdout.emit('data', state.startupLines.join('\n') + '\n');
      });
      return proc;
    },
    execFile(exe, args, options, callback) {
      assert.equal(exe, p.adbExe);
      assert.deepEqual([...args].slice(2, 6), ['emu', 'avd', 'snapshot', 'save']);
      calls.adb.push({ exe, args: [...args], options });
      if (state.crashOnSave) activeEngine.proc = null;
      callback(state.saveOk ? null : new Error('synthetic save failure'));
    },
  };
  const host = {
    totalmem: () => 32 * 1024 * MB, freemem: () => 24 * 1024 * MB,
    cpus: () => Array.from({ length: 8 }, () => ({ model: 'fixture CPU' })),
    homedir: () => root, tmpdir: () => root,
  };
  const env = {
    accel: state.accel, emulator: { ok: true, version: '37.4.1' }, sysimg: { ok: true },
    adb: { ok: true }, qemu: { ok: true }, hypervisor: {},
  };
  class Provisioner {
    paths() { return p; }
    ensureDirs() { fs.mkdirSync(p.avdHome, { recursive: true }); return p; }
    systemImageInfo() { return { ok: true, dir: path.join(root, 'system-images', 'android-34', 'default', 'x86_64'), api: 34, tag: 'default', abi: 'x86_64' }; }
    imageProfile() { return { id: 'aosp', api: 34, tag: 'default', abi: 'x86_64', armTranslation: false }; }
    activeImage() { return null; }
    emulatorAccel() { return Promise.resolve(state.accel); }
    emulatorVersion() { return Promise.resolve(env.emulator); }
    checkEnv() { return Promise.resolve(env); }
    invalidateEnvCache() {}
  }
  class AdbClient {
    deviceState() { return Promise.resolve(state.healthy ? 'device' : 'unauthorized'); }
    shell() { return Promise.resolve(state.healthy ? '1' : '0'); }
    isOnline() { return Promise.resolve(false); }
  }
  const deps = {
    fs: tempFs, path, os: host, crypto: require('node:crypto'), net: { connect: forbidden },
    child_process: childProcess, './store': store, './provision': { Provisioner },
    './process-owner': processOwner, './adb': { AdbClient, isUnauthorizedError: () => false },
    './instance-adb': {
      route: () => ({ isChild: false, port: 5044, adbPath: p.adbExe }),
      assertReady() {},
      environment: (_route, source = {}) => ({ ...source, ANDROID_ADB_SERVER_PORT: '5044' }),
      executable: requested => requested,
      clientArgs: args => [...args],
      ensureServer: async () => ({ isChild: false, port: 5044 }),
      restartServer: async () => ({ isChild: false, port: 5044 }),
      registerEmulator: async () => true,
    },
    './platform': { canProvision: true, canEmbed, describe: () => ({}) },
    './android': {}, './repair': {}, './container': {}, './guest': {},
    './logfile': { append: (file, text) => tempFs.appendFileSync(file, text) },
  };
  function load(file) {
    const module = { exports: {} };
    const context = {
      module, Buffer, console, __dirname: core, Date: time.Date,
      process: { platform: 'win32', arch: 'x64', env: {}, pid: 9999 },
      setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
      require(name) {
        if (PURE_MODULES.has(name)) return PURE_MODULES.get(name);
        assert(Object.hasOwn(deps, name), 'unmocked dependency: ' + name);
        return deps[name];
      },
    };
    const source = fs.readFileSync(path.join(core, file), 'utf8');
    vm.runInNewContext(source, context, { filename: path.join(core, file) });
    return module.exports;
  }
  const userdata = load('userdata.js');
  userdata.buildEmptyExt4 = ({ sizeMB, encrypt }) => seed(sizeMB * MB, encrypt);
  deps['./userdata'] = userdata;
  const doctor = load('doctor.js');
  doctor.freeDiskMB = () => 1000000;
  doctor.freeAdbPort = async () => 5044;
  doctor.freePortPair = async (port) => port;
  doctor.shortPath = (value) => value;
  doctor.writeReport = () => ({ file: path.join(root, 'synthetic-report.txt') });
  deps['./doctor'] = doctor;
  const { EmulatorEngine } = load('emulator.js');
  deps['./emulator'] = { EmulatorEngine };
  const { Runtime } = load('engine.js');
  const emu = new EmulatorEngine(root);
  activeEngine = emu;
  emu.proc = { pid: owner.pid, killed: false };
  emu._emuVersion = '37.4.1';
  emu.profile = { gpu: 'software', memoryMB: 2048, snapshot: true };
  emu.hasSnapshot = () => true;
  emu._consoleAlive = async () => false;
  function prepareStart(engine = emu) {
    activeEngine = engine;
    engine.proc = null;
    engine._resetAdbServer = async () => true;
    engine.killOrphanProcesses = async () => 0;
    engine._waitSpawnSettled = async () => false;
    engine.checkNetwork = async () => ({ ok: true });
    engine.onBeforeSpawn = () => { calls.beforeSpawn++; };
  }
  function runtime() {
    const rt = new Runtime(root);
    rt.emulator = emu;
    rt.adbPath = () => p.adbExe;
    rt.ownedRuntimeIdentity = async () => owner;
    rt.prepare = async () => { calls.prepared++; };
    return rt;
  }
  const avdDir = path.join(p.avdHome, 'apkstart.avd');
  const image = path.join(avdDir, 'userdata-qemu.img');
  function existing(bytes = 1024 * MB) {
    put(image, seed(bytes, true));
    sizes.set(image, bytes);
    return fs.readFileSync(image);
  }
  return { root, time, p, settings, store, writes, owner, state, calls, emu, doctor, userdata, avdDir, image,
    sizes, put, seed, existing, prepareStart, runtime, setFsBytes };
}

test('camera/vsync wiring is explicit, defaults keep host cameras off, and snapshot policy is unchanged', (t) => {
  const f = fixture(t);
  f.settings.peripherals = {};
  const defaultAvd = f.emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096 });
  const defaultConfig = fs.readFileSync(path.join(defaultAvd.avdDir, 'config.ini'), 'utf8');
  assert.match(defaultConfig, /^hw\.camera\.back=none$/m);
  assert.match(defaultConfig, /^hw\.camera\.front=none$/m);
  assert.match(defaultConfig, /^hw\.lcd\.vsync=60$/m);
  const defaultArgs = f.emu.buildArgs({ snapshot: true }).join(' ');
  assert.match(defaultArgs, /-camera-back none/);
  assert.match(defaultArgs, /-camera-front none/);
  assert.match(defaultArgs, /-snapshot apkstart/);
  assert.match(defaultArgs, /-no-snapshot-save/);
  assert(!defaultArgs.includes('-no-snapshot '), '默认外设不能关闭快照');
  assert.equal(f.emu.snapshotSaveAllowed(), true);

  f.settings.peripherals = {
    cameraBack: 'webcam0', cameraFront: 'emulated', refreshRate: 90, serialPort: '',
  };
  const configuredAvd = f.emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096 });
  const configured = fs.readFileSync(path.join(configuredAvd.avdDir, 'config.ini'), 'utf8');
  assert.match(configured, /^hw\.camera\.back=webcam0$/m);
  assert.match(configured, /^hw\.camera\.front=emulated$/m);
  assert.match(configured, /^hw\.lcd\.vsync=90$/m);
  const configuredArgs = f.emu.buildArgs({ snapshot: true }).join(' ');
  assert.match(configuredArgs, /-camera-back webcam0/);
  assert.match(configuredArgs, /-camera-front emulated/);
  assert.match(configuredArgs, /-snapshot apkstart/);
  assert.match(configuredArgs, /-no-snapshot-save/);
  assert(!configuredArgs.includes('-no-snapshot '), '外设接线不能改变快照保存策略');
});

for (const disabled of ['setting', 'profile', 'worth']) {
  test(`snapshot ${disabled}=false gates direct, idle, stop and wipe arguments`, async (t) => {
    const f = fixture(t);
    const { emu, settings, calls, time } = f;
    if (disabled === 'setting') settings.engine.keepSnapshot = false;
    if (disabled === 'profile') emu.profile.snapshot = false;
    if (disabled === 'worth') emu.snapshotWorthSaving = false;
    assert.equal(await emu.saveSnapshotNow(f.p.adbExe), false);
    emu.scheduleSnapshotSave(f.p.adbExe, { delay: 10 });
    await time.tick(100000);
    assert.equal(calls.adb.length, 0);
    assert.equal(time.timers.size, 0);
    const args = [...emu.buildArgs({ snapshot: emu.profile.snapshot, wipe: true })];
    assert(args.includes('-no-snapshot'));
    assert(!args.includes('-snapshot'));
    assert.equal(await emu.stop({ adbPath: f.p.adbExe }), true);
    assert.equal(calls.adb.length, 0);
    assert.equal(calls.terminated.length, 1);
  });
}

test('queued idle timer observes live disable, never rearms, and can be explicitly rescheduled', async (t) => {
  const f = fixture(t);
  let idle = false;
  f.emu.scheduleSnapshotSave(f.p.adbExe, { delay: 10, isIdle: () => idle });
  await f.time.tick(10);
  assert.equal(f.calls.adb.length, 0);
  assert.equal(f.time.timers.size, 1);
  f.settings.engine.keepSnapshot = false;
  await f.time.tick(15000);
  assert.equal(f.time.timers.size, 0);
  f.settings.engine.keepSnapshot = true;
  idle = true;
  await f.time.tick(60000);
  assert.equal(f.calls.adb.length, 0, 'old disabled timer must not resurrect');
  f.emu.scheduleSnapshotSave(f.p.adbExe, { delay: 10 });
  await f.time.tick(10);
  assert.equal(f.calls.adb.length, 1);
  assert.equal(f.emu._snapSaved, true);
});

test('cancelled callback cannot write or consume a newer timer; failed save is not marked saved', async (t) => {
  const f = fixture(t);
  f.emu.scheduleSnapshotSave(f.p.adbExe);
  const stale = f.emu._snapTimer;
  f.emu.cancelSnapshotSave();
  f.emu.scheduleSnapshotSave(f.p.adbExe, { delay: 100 });
  const current = f.emu._snapTimer;
  await stale.fn();
  assert.equal(f.emu._snapTimer, current);
  assert.equal(f.calls.adb.length, 0);
  f.state.saveOk = false;
  await f.time.tick(100);
  assert.equal(f.calls.adb.length, 1);
  assert.equal(f.emu._snapSaved, false);
});

test('disable during guest health wait prevents dispatch after await', async (t) => {
  const f = fixture(t);
  const entered = deferred();
  const release = deferred();
  f.emu._adbGuestHealthy = async () => { entered.resolve(); await release.promise; return true; };
  const pending = f.emu.saveSnapshotNow(f.p.adbExe);
  await entered.promise;
  f.settings.engine.keepSnapshot = false;
  release.resolve();
  assert.equal(await pending, false);
  assert.equal(f.calls.adb.length, 0);
});

test('cancelling an idle save during health wait prevents it from dispatching after re-enable', async (t) => {
  const f = fixture(t);
  const entered = deferred();
  const release = deferred();
  f.emu._adbGuestHealthy = async () => { entered.resolve(); await release.promise; return true; };
  f.emu.scheduleSnapshotSave(f.p.adbExe, { delay: 10 });
  const pending = f.time.tick(10);
  await entered.promise;
  f.settings.engine.keepSnapshot = false;
  f.runtime().scheduleSnapshotSave();
  f.settings.engine.keepSnapshot = true;
  release.resolve();
  await pending;
  assert.equal(f.calls.adb.length, 0);
  assert.notEqual(f.emu._snapSaved, true);
});

test('healthy owned stop saves explicitly even when exit auto-save is disabled', async (t) => {
  const f = fixture(t);
  assert([...f.emu.buildArgs()].includes('-no-snapshot-save'));
  assert.equal(await f.emu.stop({ adbPath: f.p.adbExe }), true);
  assert.equal(f.calls.adb.length, 1);
  assert.equal(f.calls.terminated.length, 1);
});

test('save rejects unauthorized guest, unknown owner and changed process birth', async (t) => {
  const f = fixture(t);
  f.state.healthy = false;
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), false);
  f.state.healthy = true;
  f.state.owner = null;
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), false);
  f.state.owner = f.owner;
  f.emu._adbGuestHealthy = async () => { f.state.owner = { ...f.owner, started: 'reused-pid' }; return true; };
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), false);
  assert.equal(f.calls.adb.length, 0);
});

test('snapshot crash memory survives disable and is version-scoped', async (t) => {
  const f = fixture(t);
  f.state.crashOnSave = true;
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), false);
  assert.equal(f.settings.engine.snapshotUnsafe, '37.4.1|software');
  f.emu.proc = { pid: f.owner.pid, killed: false };
  f.state.crashOnSave = false;
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), false);
  assert.equal(f.calls.adb.length, 1);
  f.settings.engine.keepSnapshot = false;
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), false);
  assert.equal(f.settings.engine.snapshotUnsafe, '37.4.1|software');
  f.settings.engine.keepSnapshot = true;
  f.emu._emuVersion = '37.5.0';
  assert.equal(await f.emu.saveSnapshotNow(f.p.adbExe), true);
  assert.equal(f.calls.adb.length, 2);
});

test('Runtime scheduling cancels an already armed save when disabled', async (t) => {
  const f = fixture(t);
  const rt = f.runtime();
  rt.scheduleSnapshotSave(10);
  f.settings.engine.keepSnapshot = false;
  rt.scheduleSnapshotSave(10);
  assert.equal(f.time.timers.size, 0);
  await f.time.tick(10000);
  assert.equal(f.calls.adb.length, 0);
});

for (const rebuilt of [false, true]) {
  for (const failingTool of ['qemu-img.exe', 'resize2fs.exe']) {
    test(`${rebuilt ? 'placeholder rebuild' : 'first create'} ${failingTool} failure propagates without spawn`, async (t) => {
      const f = fixture(t);
      if (rebuilt) f.put(f.image, Buffer.alloc(1024));
      const before = rebuilt ? fs.readFileSync(f.image) : null;
      f.state.toolFailure = (tool) => tool === failingTool ? { status: 1, stderr: 'synthetic partition tool failure' } : null;
      f.prepareStart();
      const rt = f.runtime();
      const result = await rt.bootEmulator({ env: { accel: f.state.accel } });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'DATA_PARTITION_PREPARE_FAILED');
      assert.equal(result.data.operation, rebuilt ? 'rebuild' : 'create');
      assert.equal(result.diagnosis.code, result.code);
      assert.match(result.error, /synthetic partition tool failure/);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].stage, 'data-partition');
      assert.equal(f.calls.spawn.length, 0);
      assert.equal(f.calls.beforeSpawn, 0);
      assert.equal(f.calls.prepared, 0);
      assert.equal(rt.vmStarting, false);
      if (rebuilt) assert.deepEqual(fs.readFileSync(f.image), before);
      else assert(!fs.existsSync(f.image));
      assert(!fs.readdirSync(f.avdDir).some((name) => name.startsWith('.userdata-')));
      assert.equal(f.emu.lastFailure().diagnosis.code, result.code);
    });
  }
}

test('exit-zero resize that did not grow ext4 is rejected, not treated as successful creation', async (t) => {
  const f = fixture(t);
  f.state.noResize = true;
  f.prepareStart();
  const result = await f.emu.start({ headless: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /容量校验失败/);
  assert.equal(f.calls.spawn.length, 0);
  assert(!fs.existsSync(f.image));
});

for (const kind of ['unknown raw data', 'qcow2 overlay']) {
  test(`${kind} is preserved and never implicitly rebuilt or wiped`, async (t) => {
    const f = fixture(t);
    f.put(f.image, kind === 'qcow2 overlay' ? Buffer.alloc(1024) : Buffer.from('encrypted or damaged user saves'));
    const overlay = kind === 'qcow2 overlay' ? f.put(f.image + '.qcow2', 'private overlay') : null;
    const before = fs.readFileSync(f.image);
    f.prepareStart();
    const result = await f.emu.start({ headless: true });
    assert.equal(result.ok, false);
    assert.equal(result.data.reason, overlay ? 'unverified-overlay' : 'unverified-userdata');
    assert.deepEqual(fs.readFileSync(f.image), before);
    if (overlay) assert.equal(fs.readFileSync(overlay, 'utf8'), 'private overlay');
    assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.tools.length, 0);
    assert(!f.calls.removed.includes(f.image));
  });
}

for (const failure of ['qemu', 'resize', 'encrypt']) {
  test(`existing ext4 ${failure} failure is fail-closed and retains private data`, async (t) => {
    const f = fixture(t);
    const before = f.existing();
    if (failure === 'encrypt') f.userdata.setEncryptFlag = () => { throw new Error('synthetic FBE restore failure'); };
    else f.state.toolFailure = (tool) => tool === (failure === 'qemu' ? 'qemu-img.exe' : 'resize2fs.exe')
      ? { status: 1, stderr: 'synthetic growth failure' } : null;
    f.prepareStart();
    const result = await f.emu.start({ headless: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DATA_PARTITION_RESIZE_FAILED');
    assert.equal(result.data.usable, false);
    assert.equal(result.data.created, false);
    assert.equal(f.calls.spawn.length, 0);
    assert.deepEqual(fs.readFileSync(f.image).subarray(2048), before.subarray(2048));
    assert(!f.calls.removed.includes(f.image));
    if (failure !== 'encrypt') assert.equal(fs.readFileSync(f.image).readUInt32LE(1024 + 0x60) & 0x10000, 0x10000);
  });
}

test('dirty existing ext4 repairs once before verified growth, never adds wipe', async (t) => {
  const f = fixture(t);
  const before = f.existing();
  let resizeCalls = 0;
  f.state.toolFailure = (tool) => tool === 'resize2fs.exe' && ++resizeCalls === 1
    ? { status: 1, stderr: 'Please run e2fsck first' } : null;
  f.prepareStart();
  const result = await f.emu.start({ headless: true, probe: async () => 'ok' });
  assert.equal(result.ok, true);
  assert.equal(resizeCalls, 2);
  assert.equal(f.calls.tools.filter(({ exe }) => /e2fsck\.exe$/.test(exe)).length, 1);
  assert.equal(f.calls.spawn.length, 1);
  assert(!f.calls.spawn[0].args.includes('-wipe-data'));
  assert.equal(f.userdata.fsBytes(f.image), f.sizes.get(f.image));
  assert.deepEqual(fs.readFileSync(f.image).subarray(2048), before.subarray(2048));
});

test('first creation succeeds only after size validation and preserves explicit worth=false', async (t) => {
  const f = fixture(t);
  f.emu.snapshotWorthSaving = false;
  f.prepareStart();
  const result = await f.emu.start({ headless: true, probe: async () => 'ok' });
  assert.equal(result.ok, true);
  assert.equal(f.userdata.fsBytes(f.image), f.sizes.get(f.image));
  assert.equal(f.emu.snapshotWorthSaving, false);
  assert(f.calls.spawn[0].args.includes('-no-snapshot'));
  assert.equal(result.profile, f.emu.profile);
});

for (const avd of [{ ok: false, error: 'adapter refused data' }, { data: { ok: false, reason: 'legacy-data-refused' } }]) {
  test('ensureAvd failed result is not ignored, including legacy nested data.ok=false', async (t) => {
    const f = fixture(t);
    f.prepareStart();
    f.emu.ensureAvd = () => avd;
    const result = await f.emu.start({ headless: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DATA_PARTITION_PREPARE_FAILED');
    assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.beforeSpawn, 0);
    assert.equal(result.attempts.length, 1);
  });
}

for (const [name, engine, canEmbed, headless, gpu] of [
  ['auto Windows embedding', { windowMode: 'auto' }, true, false, 'swangle'],
  ['forced embedding ignores the remembered black frame', { windowMode: 'embedded', embeddedBlack: true }, true, false, 'swangle'],
  ['standalone Windows window', { windowMode: 'standalone' }, true, false, 'host'],
  ['auto after an embedded black frame', { windowMode: 'auto', embeddedBlack: true }, true, false, 'host'],
  ['external-only platform', { windowMode: 'auto' }, false, false, 'host'],
  ['headless start', { windowMode: 'auto' }, true, true, 'host'],
  ['manual host selection despite a stale auto failure', { windowMode: 'auto', gpuMode: 'host', badGpu: '37.4.1|host' }, true, false, 'host'],
  ['automatic mode still backs off a known bad host GPU', { windowMode: 'standalone', badGpu: '37.4.1|host' }, true, false, 'swangle'],
]) {
  test(`first emulator GPU argument reflects ${name}`, async (t) => {
    const f = fixture(t, { canEmbed });
    Object.assign(f.settings.engine, engine);
    f.prepareStart();
    const result = await f.emu.start({ headless });
    assert.equal(result.ok, true);
    const { args } = f.calls.spawn[0];
    assert.equal(args[args.indexOf('-gpu') + 1], gpu);
    assert.equal(result.profile.gpu, gpu);
    assert.equal(args.includes('-no-window'), headless);
  });
}

test('standalone launch retries software rendering after a failed host GPU', async (t) => {
  const f = fixture(t);
  f.settings.engine.windowMode = 'standalone';
  f.prepareStart();
  f.emu._waitSpawnSettled = async () => {
    if (f.calls.spawn.length !== 1) return false;
    f.emu.log('Failed to initialize GL emulation');
    f.emu.lastExitCode = 1;
    f.emu.proc = null;
    return true;
  };
  const result = await f.emu.start();
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.spawn.map(({ args }) => args[args.indexOf('-gpu') + 1]), ['host', 'swangle']);
  assert.equal(result.profile.gpu, 'swangle');
  assert.equal(f.settings.engine.badGpu, '37.4.1|host');
});

for (const requested of ['on', 'auto', 'off']) {
  test(`accel=${requested} retains official default/off arguments and corresponding environment`, (t) => {
    const f = fixture(t);
    const args = [...f.emu.buildArgs({ accel: requested, snapshot: true, noVulkan: true })];
    const index = args.indexOf('-accel');
    if (requested === 'off') assert.equal(args[index + 1], 'off');
    else assert.equal(index, -1, 'must not reintroduce -accel on');
    assert.equal(f.emu.env(f.p.root, { accel: requested }).ANDROID_I_WANT_MY_TCG, requested === 'off' ? 'yes' : undefined);
    assert(args.includes('-no-snapshot-save'), 'exit save must not bypass the live setting');
    assert(args.includes('-Vulkan'), 'keep intentional compatibility fallback');
  });
}

for (const confirmed of [false, true]) {
  test(`running profile distinguishes detected acceleration from ${confirmed ? 'confirmed' : 'unconfirmed'} default`, async (t) => {
    const f = fixture(t);
    if (confirmed) f.state.startupLines = ['Windows Hypervisor Platform accelerator is operational'];
    f.prepareStart();
    const result = await f.emu.start({ headless: true });
    assert.equal(result.ok, true);
    assert.equal(result.profile, f.emu.profile);
    const accel = result.profile.acceleration;
    assert.equal(accel.detected.kind, 'whpx');
    assert.equal(accel.requested, 'on');
    assert.equal(accel.argument, null);
    assert.equal(accel.policy, 'emulator-default');
    assert.equal(accel.confirmed, confirmed ? true : null);
    const status = await f.runtime().status();
    assert.equal(status.acceleration, accel);
    assert.match(status.autoProfile, /官方默认加速/);
    assert.match(status.autoProfile, confirmed ? /启动日志已确认/ : /实际加速未确认/);
    assert(!f.calls.spawn[0].args.includes('-accel'));
  });
}

test('current acceleration evidence survives a full 600-line ring without borrowing old evidence', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 600; index++) f.emu.log('previous run line ' + index);
  assert.equal(f.emu._log.length, 600);
  f.state.startupLines = ['Windows Hypervisor Platform accelerator is operational'];
  f.prepareStart();
  const result = await f.emu.start({ headless: true });
  assert.equal(result.ok, true);
  assert.equal(result.profile.acceleration.confirmed, true);
  assert.match(result.profile.acceleration.evidence, /operational/);
  assert(f.emu._log.length <= 600);
});

test('acceleration confirmation rejects negative evidence and never borrows a previous attempt', async (t) => {
  const f = fixture(t);
  assert.equal(f.emu._accelerationState({ accel: 'on' }, ['AEHD is not operational']).confirmed, null);
  for (let index = 0; index < 600; index++) f.emu.log('previous run line ' + index);
  f.prepareStart();
  f.doctor.planVariants = (profile) => [
    { ...profile, label: 'first hardware attempt' }, { ...profile, label: 'second hardware attempt' },
  ];
  let attempt = 0;
  f.emu._waitSpawnSettled = async () => {
    if (attempt++ === 0) f.emu.log('AEHD is operational');
    f.emu.proc = null;
    f.emu.lastExitCode = 1;
    return true;
  };
  await assert.rejects(f.emu.start({ headless: true }));
  assert.equal(f.emu.attempts.length, 2);
  assert.equal(f.emu.attempts[0].acceleration.confirmed, true);
  assert.equal(f.emu.attempts[1].acceleration.confirmed, null);
});

test('unclassified fatal retry does not inherit the preceding GPU diagnosis', async (t) => {
  const f = fixture(t);
  f.prepareStart();
  f.emu._waitSpawnSettled = async () => {
    if (f.calls.spawn.length !== 1) return false;
    f.emu.log('Failed to initialize GL emulation');
    f.emu.lastExitCode = 1;
    f.emu.proc = null;
    return true;
  };
  await assert.rejects(f.emu.start({
    headless: true,
    maxAttempts: 2,
    probe: async () => {
      assert.equal(f.calls.spawn.length, 2);
      f.emu.log('Userspace boot properties');
      f.emu.lastExitCode = 1;
      f.emu.proc = null;
      return 'fatal';
    },
  }), (error) => {
    assert.equal(error.diagnosis.code, 'ACCEL_UNUSABLE');
    return true;
  });
  assert.deepEqual([...f.emu.attempts].map(a => a.diagnosis), ['GPU_INIT', 'ACCEL_UNUSABLE']);
});

test('explicit-off failed attempt cannot be diagnosed as detected accelerator failing to attach', async (t) => {
  const f = fixture(t);
  f.prepareStart();
  let early = 0;
  const diagnose = f.doctor.earlyAccelExit;
  f.doctor.earlyAccelExit = (options) => { early++; return diagnose(options); };
  f.doctor.planVariants = (profile) => [{ ...profile, accel: 'off', snapshot: false, label: 'explicit off' }];
  f.emu._waitSpawnSettled = async () => { f.emu.proc = null; f.emu.lastExitCode = 1; return true; };
  await assert.rejects(f.emu.start({ headless: true }), (error) => {
    assert.notEqual(error.diagnosis.code, 'ACCEL_UNUSABLE');
    return true;
  });
  assert.equal(early, 0);
  assert.equal(f.emu.attempts[0].acceleration.detected.ok, true);
  assert.equal(f.emu.attempts[0].acceleration.argument, 'off');
  assert.equal(f.emu.attempts[0].acceleration.confirmed, false);
  assert.equal(f.calls.spawn[0].args[f.calls.spawn[0].args.indexOf('-accel') + 1], 'off');
});

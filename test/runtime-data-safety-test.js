'use strict';
// Pure Node: only synthetic files under a private temp directory. No real ADB,
// process enumeration, port probes, network downloads, or settings access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const layers = require('../src/core/layers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-runtime-safety-'));
const forbidden = () => { throw new Error('unexpected host operation'); };
const childProcess = { spawn: forbidden, spawnSync: forbidden, execFile: forbidden };
const core = path.join(__dirname, '..', 'src', 'core');
function load(file, deps, globals = {}) {
  const source = fs.readFileSync(path.join(core, file), 'utf8');
  const module = { exports: {} };
  const req = (name) => {
    if (Object.hasOwn(deps, name)) return deps[name];
    if (['fs', 'path', 'zlib', 'crypto'].includes(name)) return require(name);
    if (name === 'child_process') return childProcess;
    throw new Error(`unmocked dependency: ${name}`);
  };
  const wrap = vm.runInThisContext(`(function (require, module, __dirname, Date) {${source}\n})`, { filename: path.join(core, file) });
  wrap(req, module, core, globals.Date || Date);
  return module.exports;
}
function put(file, content = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
let passed = 0;
let failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  let timer;
  try {
    await Promise.race([Promise.resolve().then(() => fn(dir)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture did not settle: ' + name)), 5000);
    })]);
    console.log(`PASS ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error}`);
    failed++;
  } finally { clearTimeout(timer); }
}

function runtime(dir, overrides = {}, globals = {}) {
  const settings = { engine: { mode: 'builtin' }, runtime: {}, device: '' };
  const writes = [];
  const processes = new Map();
  const processOwner = {
    listeners: async () => [...processes].map(([port, p]) => ({ port, pid: p.pid })),
    pidOnPort: async (port) => processes.get(port)?.pid || 0,
    getProcessInfo: async (pid) => [...processes.values()].find((p) => p.pid === pid) || null,
    getProcessInfos: async (pids) => [...new Set(pids)].map((pid) => [...processes.values()].find((p) => p.pid === pid)).filter(Boolean),
    sameIdentity: (a, b) => !!a && !!b && a.pid === b.pid && a.started === b.started,
    terminateOwnedProcess: forbidden,
  };
  const store = {
    DATA_DIR: dir, getSettings: () => settings, ensureDirs: () => {},
    saveSettings: (patch) => {
      writes.push(patch);
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) settings[key] = { ...settings[key], ...value };
        else settings[key] = value;
      }
    },
    saveApps: (apps) => { writes.push(apps); }, getApps: () => [],
  };
  const env = { emulator: { ok: false }, sysimg: { ok: false } };
  const net = { connect: ({ port }) => {
    const sock = new EventEmitter();
    sock.setTimeout = () => sock;
    sock.destroy = () => {};
    queueMicrotask(() => sock.emit(processes.has(port) ? 'connect' : 'error', new Error('mock')));
    return sock;
  } };
  const { Runtime } = load('engine.js', {
    net, './adb': {}, './android': {}, './store': store,
    './provision': {}, './emulator': { EmulatorEngine: class {} }, './doctor': {}, './repair': {},
    './container': require('../src/core/container'), './guest': {}, './platform': { canProvision: true },
    './process-owner': processOwner, './layers': layers, './userdata': require('../src/core/userdata'),
    ...overrides,
  }, globals);
  const rt = Object.create(Runtime.prototype);
  const root = path.join(dir, 'runtime');
  const avdHome = path.join(root, 'avd');
  Object.assign(rt, { vmProc: null, vmStarting: false, emuSerial: 'emulator-5554', _activeApps: new Set(), _bootLog: [] });
  rt.emulator = {
    avdName: 'apkstart', port: 5554, running: () => false, stop: forbidden,
    ownedProcessOnPort: async (p) => processes.get(p)?.owned ? processes.get(p) : null,
    ownsProcess: (p) => !!p?.owned,
  };
  rt.provisioner = { paths: () => ({ root, avdHome }), checkEnv: async () => env, materializeImages: async () => {} };
  const online = new Set();
  const prepared = [];
  rt.client = (serial = settings.engine.mode === 'attach' ? settings.device : rt.emuSerial) => ({
    serial,
    isOnline: async () => online.has(serial),
    devices: async () => [...online].map((serial) => ({ serial, state: 'device' })),
    connect: async () => online.has(serial),
    exec: async (args) => {
      if (args[0] === 'get-state') return { stdout: online.has(serial) ? 'device' : 'offline' };
      assert.equal(args[0], 'devices');
      return { stdout: ['List of devices attached', ...[...online].map((id) => `${id}\tdevice`)].join('\n') };
    },
    shell: async () => '1',
  });
  rt.prepare = async (c) => { prepared.push(c.serial); };
  rt.probe = async () => [{ serial: '127.0.0.1:7555', name: 'another runtime' }];
  rt.stop = async () => true;
  const avdDir = path.join(avdHome, 'apkstart.avd');
  const userdata = put(path.join(avdDir, 'userdata-qemu.img'), 'user data');
  const snapshot = put(path.join(avdDir, 'snapshots', 'boot', 'ram.bin'), 'snapshot');
  const cache = put(path.join(root, '_tmp', 'cache.tmp'));
  return { Runtime, rt, settings, writes, online, prepared, processes, processOwner, root, userdata, snapshot, cache };
}

function provision(dir, download) {
  const { Provisioner } = load('provision.js', {
    './store': { getSettings: () => settings, saveSettings: ({ runtime }) => Object.assign(settings.runtime, runtime) },
    './doctor': {}, './platform': {}, './download': { downloadAnyParallel: download },
    './host/profile': require('../src/core/host/profile'),
    './zip': {}, './sources': {}, './images': {},
  });
  const settings = { runtime: {} };
  const p = Object.create(Provisioner.prototype);
  const imagesDir = path.join(dir, 'runtime', 'images');
  const iso = path.join(imagesDir, 'android-x86.iso');
  fs.mkdirSync(imagesDir, { recursive: true });
  p.ensureDirs = () => ({ root: path.dirname(imagesDir), imagesDir, iso });
  p.paths = p.ensureDirs;
  p.guardDisk = async () => {};
  p.inspectIso = (file) => ({ ok: fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== 'invalid', size: 7, reason: 'bad ISO' });
  return { p, settings, imagesDir, iso };
}

function restorationFixture(dir) {
  const f = runtime(dir);
  const owner = { pid: 42, started: 'restore-birth', owned: true };
  f.processes.set(5554, owner); f.processes.set(5555, owner);
  f.settings.engine.deepTrim = false;
  const state = { online: 'device', restricted: '1', hook: null };
  const disabled = new Set(['com.android.vending', 'com.example.userdisabled']);
  const commands = [];
  const client = {
    serial: 'emulator-5554',
    deviceState: async () => state.online,
    async shell(command) {
      commands.push(command);
      const custom = await state.hook?.(command);
      if (custom !== undefined) return custom;
      if (command === 'pm list packages -d --user 0') return [...disabled].map((pkg) => `package:${pkg}`).join('\n');
      const enable = /^pm enable --user 0 ([\w.]+)$/.exec(command);
      if (enable) { disabled.delete(enable[1]); return `Package ${enable[1]} new state: enabled`; }
      if (command === 'settings put global restricted_background_data 0') { state.restricted = '0'; return ''; }
      if (command === 'settings get global restricted_background_data') return state.restricted;
      throw new Error(`unexpected restore command: ${command}`);
    },
  };
  f.rt.client = () => client;
  f.rt._freeformReady = f.rt._guestDefaultsReady = f.rt._chineseImeReady = f.rt._lcdNormalized = true;
  f.rt.startWatchdog = () => {};
  f.settings.engine.deepTrimRestoreTarget = f.rt._systemAppsRestoreTarget(client);
  const prepare = (options) => f.Runtime.prototype.prepare.call(f.rt, client, options);
  return { ...f, owner, state, disabled, commands, client, prepare };
}

async function main() {
  await test('startup probe never constructs an ADB client for unowned console or guest ports', async (dir) => {
    let clients = 0;
    class ProbeClient { constructor() { clients++; } shell() { return forbidden(); } }
    const { rt, processes } = runtime(dir, { './adb': { AdbClient: ProbeClient } });
    rt.adbPath = () => path.join(dir, 'fixture-adb');
    processes.set(5554, { pid: 42, started: 'foreign', owned: false });
    processes.set(5555, { pid: 42, started: 'foreign', owned: false });
    rt.emulator.running = () => true;
    rt.emulator.start = async ({ probe }) => {
      assert.equal(await probe({ serial: 'emulator-5554' }), 'pending');
      return { ok: false, error: 'fixture ends after probe' };
    };
    assert.equal((await rt.bootEmulator({ env: { accel: { ok: true } } })).ok, false);
    assert.equal(clients, 0);
  });
  await test('startup probe accepts readiness only while both ports retain the same owned identity', async (dir) => {
    let shells = 0;
    class ProbeClient {
      constructor({ serial }) { this.serial = serial; }
      async shell() { shells++; return '1\npackage:/system/framework/framework-res.apk'; }
    }
    const { rt, processes } = runtime(dir, { './adb': { AdbClient: ProbeClient } });
    rt.adbPath = () => path.join(dir, 'fixture-adb');
    const owner = { pid: 42, started: 'owned-birth', owned: true };
    processes.set(5554, owner); processes.set(5555, owner);
    rt.emulator.running = () => true;
    rt.emulator.start = async ({ probe }) => {
      assert.equal(await probe({ serial: 'emulator-5554' }), 'ok');
      return { ok: false, error: 'fixture ends after probe' };
    };
    await rt.bootEmulator({ env: { accel: { ok: true } } });
    assert.equal(shells, 1);
  });
  for (const rejectShell of [false, true]) {
    await test(`startup probe discards ${rejectShell ? 'failed' : 'successful'} shell after guest identity changes`, async (dir) => {
      let shells = 0, repairs = 0, states = 0;
      let processes;
      class ProbeClient {
        constructor({ serial }) { this.serial = serial; }
        async shell() {
          shells++;
          const replacement = { pid: 42, started: 'reused-pid-birth', owned: true };
          processes.set(5554, replacement); processes.set(5555, replacement);
          if (rejectShell) throw new Error('unauthorized');
          return '1\npackage:/system/framework/framework-res.apk';
        }
        async deviceState() { states++; return 'unauthorized'; }
      }
      const f = runtime(dir, { './adb': { AdbClient: ProbeClient, isUnauthorizedError: () => true } });
      const rt = f.rt; processes = f.processes;
      rt.adbPath = () => path.join(dir, 'fixture-adb');
      const owner = { pid: 42, started: 'initial-birth', owned: true };
      processes.set(5554, owner); processes.set(5555, owner);
      rt.emulator.running = () => true;
      rt.emulator.resetAdbServer = async () => { repairs++; };
      rt.emulator.invalidateSnapshot = rt.emulator.forceColdBootOnNextStart = forbidden;
      rt.emulator.start = async ({ probe }) => {
        assert.equal(await probe({ serial: 'emulator-5554' }), 'pending');
        return { ok: false, error: 'fixture ends after probe' };
      };
      await rt.bootEmulator({ env: { accel: { ok: true } } });
      assert.equal(shells, 1);
      assert.equal(states, 0);
      assert.equal(repairs, 0);
    });
  }
  await test('startup rejects unauthorized state read after guest birth changes', async (dir) => {
    let processes, states = 0;
    class ProbeClient {
      constructor({ serial }) { this.serial = serial; }
      async shell() { throw new Error('device offline'); }
      async deviceState() {
        states++;
        const replacement = { pid: 42, started: 'reused-birth', owned: true };
        processes.set(5554, replacement); processes.set(5555, replacement);
        return 'unauthorized';
      }
    }
    const f = runtime(dir, { './adb': { AdbClient: ProbeClient, isUnauthorizedError: () => false } });
    processes = f.processes;
    const owner = { pid: 42, started: 'original-birth', owned: true };
    processes.set(5554, owner); processes.set(5555, owner);
    f.rt.adbPath = () => 'fixture-adb';
    f.rt.emulator.running = () => true;
    f.rt.emulator.invalidateSnapshot = f.rt.emulator.forceColdBootOnNextStart = f.rt.emulator.resetAdbServer = forbidden;
    f.rt.emulator.start = async ({ probe }) => {
      assert.equal(await probe({ serial: 'emulator-5554' }), 'pending');
      return { ok: false };
    };
    await f.rt.bootEmulator({ env: { accel: { ok: true } } });
    assert.equal(states, 1);
  });
  for (const failure of ['construct', 'shell', 'reset-unauthorized', 'reset-offline']) {
    await test(`ADB ${failure} failure is terminal and preserves its original cause`, async (dir) => {
      let now = 1700000000000, constructions = 0, resets = 0;
      class FakeDate extends Date { static now() { return now; } }
      const original = Object.assign(new Error(`fixture ${failure} failed`), { code: 'INSTANCE_ADB_NOT_READY' });
      class ProbeClient {
        constructor({ serial }) { constructions++; if (failure === 'construct') throw original; this.serial = serial; }
        async shell() { throw failure === 'shell' ? original : new Error('device offline'); }
        async deviceState() { return failure === 'reset-unauthorized' ? 'unauthorized' : 'offline'; }
      }
      const f = runtime(dir, { './adb': { AdbClient: ProbeClient, isUnauthorizedError: () => false } }, { Date: FakeDate });
      const owner = { pid: 42, started: 'owned-birth', owned: true };
      f.processes.set(5554, owner); f.processes.set(5555, owner);
      f.rt.adbPath = () => 'fixture-adb';
      f.rt.emulator.running = () => true;
      f.rt.emulator.invalidateSnapshot = f.rt.emulator.forceColdBootOnNextStart = () => {};
      f.rt.emulator.resetAdbServer = async () => { resets++; throw original; };
      f.rt.emulator.start = async ({ probe }) => {
        const count = failure === 'reset-offline' ? 6 : 1;
        for (let i = 0; i < count; i++) {
          now += 31000;
          assert.equal(await probe({ serial: 'emulator-5554' }), i === count - 1 ? 'fatal' : 'pending');
        }
        assert.equal(f.rt.emulator.lastDiagnosis.terminal, true);
        assert.equal(f.rt.emulator.lastDiagnosis.causeCode, original.code);
        // Even a base loop retry cannot construct another client or lose the cause.
        assert.equal(await probe({ serial: 'emulator-5554' }), 'fatal');
        return { ok: false, error: 'generic timeout must not hide original', attempts: [{ stage: 'adb' }] };
      };
      const result = await f.rt.bootEmulator({ env: { accel: { ok: true } } });
      assert.equal(result.ok, false);
      assert.equal(result.terminal, true);
      assert.equal(result.code, original.code);
      assert(result.error.includes(original.message));
      assert.equal(result.diagnosis.code, 'ADB_SERVER_FAILED');
      assert.equal(result.attempts[0].stage, 'adb');
      assert.equal(constructions, 1);
      assert.equal(resets, failure.startsWith('reset-') ? 1 : 0);
    });
  }
  await test('default deepTrim=false never restores packages without a pending request', async (dir) => {
    const f = restorationFixture(dir);
    f.client.shell = forbidden;
    await f.prepare();
    assert.equal(f.writes.length, 0);
    assert.equal(f.commands.length, 0);
    assert(f.disabled.has('com.android.vending'));
  });
  await test('pending restore enables only present optional packages and verifies readback', async (dir) => {
    const f = restorationFixture(dir);
    f.settings.engine.deepTrimRestorePending = true;
    await f.prepare();
    assert.equal(f.settings.engine.deepTrimRestorePending, false);
    assert.equal(f.disabled.has('com.android.vending'), false);
    assert.equal(f.disabled.has('com.example.userdisabled'), true);
    assert.equal(f.state.restricted, '0');
    assert.deepEqual(f.commands.filter((cmd) => cmd.startsWith('pm enable')), ['pm enable --user 0 com.android.vending']);
    assert(f.commands.every((cmd) => !cmd.includes('|| true') && !cmd.includes('2>/dev/null')));
    const count = f.commands.length;
    await f.prepare();
    assert.equal(f.commands.length, count, 'verified restore must not repeat without a new request');
  });
  for (const failure of ['throw', 'empty-enable', 'error-enable', 'empty-setting', 'still-disabled']) {
    await test(`restore ${failure} stays pending and cannot report success`, async (dir) => {
      const f = restorationFixture(dir);
      f.state.hook = (command) => {
        if (command.startsWith('pm enable')) {
          if (failure === 'throw') throw new Error('fixture ADB exit 1');
          if (failure === 'empty-enable') return '';
          if (failure === 'error-enable') return 'Error: Permission denied';
          if (failure === 'still-disabled') return 'Package com.android.vending new state: enabled';
        }
        if (failure === 'empty-setting' && command.startsWith('settings get')) return '';
      };
      await assert.rejects(f.rt.restoreSystemApps());
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
      assert(!f.writes.some((patch) => patch.engine?.deepTrimRestorePending === false));
    });
  }
  await test('prepare retries a failed pending restore on the next verified guest preparation', async (dir) => {
    const f = restorationFixture(dir);
    f.settings.engine.deepTrimRestorePending = true;
    f.state.hook = (command) => { if (command.startsWith('pm enable')) throw new Error('fixture pm service unavailable'); };
    await f.prepare();
    assert.equal(f.settings.engine.deepTrimRestorePending, true);
    f.state.hook = null;
    await f.prepare();
    assert.equal(f.settings.engine.deepTrimRestorePending, false);
    assert.equal(f.disabled.has('com.android.vending'), false);
  });
  for (const reason of ['offline', 'unauthorized', 'unknown-owner', 'attach', 'cancelled']) {
    await test(`restore rejects ${reason} before any guest mutation`, async (dir) => {
      const f = restorationFixture(dir);
      const controller = new AbortController();
      if (reason === 'offline' || reason === 'unauthorized') f.state.online = reason;
      if (reason === 'unknown-owner') f.processes.clear();
      if (reason === 'attach') f.settings.engine.mode = 'attach';
      if (reason === 'cancelled') controller.abort();
      await assert.rejects(f.rt.restoreSystemApps({ signal: controller.signal }));
      assert.equal(f.commands.length, 0);
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
    });
  }
  for (const boundary of ['state', 'list', 'enable', 'readback']) {
    await test(`restore birth change at ${boundary} prevents subsequent mutation and pending acknowledgement`, async (dir) => {
      const f = restorationFixture(dir);
      const replace = () => {
        const owner = { pid: 42, started: 'replacement', owned: true };
        f.processes.set(5554, owner); f.processes.set(5555, owner);
      };
      if (boundary === 'state') f.client.deviceState = async () => { replace(); return 'device'; };
      f.state.hook = (command) => {
        if (boundary === 'list' && command.startsWith('pm list')
          || boundary === 'enable' && command.startsWith('pm enable')
          || boundary === 'readback' && command.startsWith('settings get')) replace();
      };
      await assert.rejects(f.rt.restoreSystemApps(), /归属已变化/);
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
      if (boundary === 'state' || boundary === 'list') assert(!f.commands.some((cmd) => cmd.startsWith('pm enable')));
      if (boundary === 'enable') assert(!f.commands.some((cmd) => cmd.startsWith('settings put')));
    });
  }
  await test('older restore cannot acknowledge a newer request or a re-enabled deep trim', async (dir) => {
    const f = restorationFixture(dir);
    const entered = deferred(), release = deferred();
    let held = false;
    f.state.hook = async (command) => {
      if (!held && command.startsWith('pm list')) { held = true; entered.resolve(); await release.promise; }
    };
    const older = assert.rejects(f.rt.restoreSystemApps(), { code: 'SYSTEM_APPS_RESTORE_CANCELLED' });
    await entered.promise;
    assert.equal(await f.rt.restoreSystemApps(), true);
    f.settings.engine.deepTrimRestorePending = true;
    f.settings.engine.deepTrim = true;
    release.resolve(); await older;
    assert.equal(f.settings.engine.deepTrimRestorePending, true);
  });
  await test('prepare stops all subsequent initialization after restore loses guest ownership', async (dir) => {
    const f = restorationFixture(dir);
    f.settings.engine.deepTrimRestorePending = true;
    f.rt._freeformReady = false;
    f.client.ensureFreeform = forbidden;
    f.state.hook = (command) => {
      if (command.startsWith('pm list')) {
        const replacement = { pid: 42, started: 'replacement', owned: true };
        f.processes.set(5554, replacement); f.processes.set(5555, replacement);
      }
    };
    await assert.rejects(f.prepare(), { code: 'RUNTIME_OWNERSHIP_LOST' });
    assert.equal(f.settings.engine.deepTrimRestorePending, true);
    assert(!f.commands.some((command) => command.startsWith('pm enable')));
  });
  for (const selection of ['avd', 'data-dir', 'image']) {
    await test(`pending restore cannot enable another ${selection} and preserves the original target`, async (dir) => {
      const f = restorationFixture(dir);
      if (selection === 'image') {
        let image = 'original-image';
        f.rt.emulator.imageChoice = () => ({ dir: image, flavor: 'google_apis_playstore', api: 34 });
        f.settings.engine.deepTrimRestoreTarget = f.rt._systemAppsRestoreTarget(f.client);
        image = 'replacement-image';
      } else if (selection === 'data-dir') {
        const prior = f.rt.provisioner.paths;
        f.rt.provisioner.paths = () => ({ ...prior(), avdHome: path.join(dir, 'different-avd-home') });
      } else f.rt.emulator.avdName = 'apkstart-aosp';
      f.settings.engine.deepTrimRestorePending = true;
      const target = f.settings.engine.deepTrimRestoreTarget;
      await assert.rejects(f.rt.restoreSystemApps(), /不属于当前运行时/);
      assert.equal(f.commands.length, 0);
      await f.prepare(); // another selected guest can still complete ordinary preparation
      assert.equal(f.commands.length, 0);
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
      assert.equal(f.settings.engine.deepTrimRestoreTarget, target);
    });
  }
  for (const selection of ['disk', 'iso', 'image']) {
    await test(`QEMU pending restore cannot enable another ${selection} and preserves the original target`, async (dir) => {
      const f = restorationFixture(dir);
      f.client.serial = '127.0.0.1:5555';
      f.settings.runtime.diskPath = path.join(dir, 'original.qcow2');
      f.settings.runtime.isoPath = path.join(dir, 'original.iso');
      f.settings.runtime.activeImageId = 'original-image';
      const target = f.rt._systemAppsRestoreTarget(f.client);
      f.settings.engine.deepTrimRestoreTarget = target;
      f.settings.engine.deepTrimRestorePending = true;
      if (selection === 'disk') f.settings.runtime.diskPath = path.join(dir, 'replacement.qcow2');
      if (selection === 'iso') f.settings.runtime.isoPath = path.join(dir, 'replacement.iso');
      if (selection === 'image') f.settings.runtime.activeImageId = 'replacement-image';
      await assert.rejects(f.rt.restoreSystemApps(), /不属于当前运行时/);
      await f.prepare();
      assert.equal(f.commands.length, 0);
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
      assert.equal(f.settings.engine.deepTrimRestoreTarget, target);
    });
  }
  await test('QEMU restore binds the provisioned default disk and ISO and verifies restoration', async (dir) => {
    const f = restorationFixture(dir);
    f.client.serial = '127.0.0.1:5555';
    const prior = f.rt.provisioner.paths;
    const disk = path.join(dir, 'default.qcow2'), iso = path.join(dir, 'default.iso');
    f.rt.provisioner.paths = () => ({ ...prior(), disk, iso });
    const target = f.rt._systemAppsRestoreTarget(f.client);
    assert.deepEqual(JSON.parse(target), { mode: 'qemu', disk, iso, image: '' });
    f.settings.engine.deepTrimRestoreTarget = target;
    f.settings.engine.deepTrimRestorePending = true;
    await f.prepare();
    assert.equal(f.settings.engine.deepTrimRestorePending, false);
    assert.equal(f.disabled.has('com.android.vending'), false);
    f.rt.provisioner.paths = () => ({ ...prior(), disk: path.join(dir, 'other-default.qcow2'), iso });
    assert.notEqual(f.rt._systemAppsRestoreTarget(f.client), target);
  });
  for (const selection of ['unknown-serial', 'missing-qemu-disk']) {
    await test(`builtin restore with ${selection} never guesses an AVD target`, async (dir) => {
      const f = restorationFixture(dir);
      f.client.serial = selection === 'unknown-serial' ? '127.0.0.1:7555' : '127.0.0.1:5555';
      f.settings.engine.deepTrimRestorePending = true;
      assert.equal(f.rt._systemAppsRestoreTarget(f.client), '');
      const target = f.settings.engine.deepTrimRestoreTarget;
      await f.prepare();
      await assert.rejects(f.rt.restoreSystemApps(), /不属于当前运行时/);
      assert.equal(f.commands.length, 0);
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
      assert.equal(f.settings.engine.deepTrimRestoreTarget, target);
    });
  }
  await test('automatic preparation never guesses the target of a legacy pending request', async (dir) => {
    const f = restorationFixture(dir);
    f.settings.engine.deepTrimRestoreTarget = '';
    f.settings.engine.deepTrimRestorePending = true;
    await f.prepare();
    assert.equal(f.commands.length, 0);
    assert.equal(f.settings.engine.deepTrimRestorePending, true);
    assert.equal(await f.rt.restoreSystemApps(), true); // explicit, online and owned binding
    assert.equal(f.settings.engine.deepTrimRestorePending, false);
  });
  await test('configured attach restoration stays pinned to its explicit serial', async (dir) => {
    const f = restorationFixture(dir);
    f.settings.engine.mode = 'attach'; f.settings.device = f.client.serial;
    f.settings.engine.deepTrimRestoreTarget = f.rt._systemAppsRestoreTarget(f.client);
    f.processes.clear();
    assert.equal(await f.rt.restoreSystemApps(), true);
    assert.equal(f.settings.engine.deepTrimRestorePending, false);
  });
  await test('attach selection changed during restore never writes the replacement guest', async (dir) => {
    const f = restorationFixture(dir);
    f.settings.engine.mode = 'attach'; f.settings.device = f.client.serial;
    f.settings.engine.deepTrimRestoreTarget = f.rt._systemAppsRestoreTarget(f.client);
    f.state.hook = (command) => { if (command.startsWith('pm list')) f.settings.device = '127.0.0.1:7555'; };
    await assert.rejects(f.rt.restoreSystemApps(), { code: 'RUNTIME_OWNERSHIP_LOST' });
    assert.equal(f.settings.engine.deepTrimRestorePending, true);
    assert(!f.commands.some((command) => command.startsWith('pm enable')));
  });
  await test('cancellation during package enumeration prevents enables and pending acknowledgement', async (dir) => {
    const f = restorationFixture(dir);
    const controller = new AbortController();
    f.state.hook = (command) => { if (command.startsWith('pm list')) controller.abort(); };
    await assert.rejects(f.rt.restoreSystemApps({ signal: controller.signal }), { code: 'START_CANCELLED' });
    assert.equal(f.settings.engine.deepTrimRestorePending, true);
    assert(!f.commands.some((command) => command.startsWith('pm enable')));
  });
  for (const priorTarget of ['another-runtime', '']) {
    await test(`new deep trim preserves an outstanding ${priorTarget ? 'other' : 'unbound legacy'} restore request`, async (dir) => {
      const f = restorationFixture(dir);
      f.settings.engine.deepTrim = true;
      f.settings.engine.deepTrimRestorePending = true;
      f.settings.engine.deepTrimRestoreTarget = priorTarget;
      f.rt.emulator.cancelSnapshotSave = () => {};
      f.rt.emulator.setPriority = async () => {};
      f.client.shell = async (command) => { f.commands.push(command); return ''; };
      const result = await f.rt.beginApp('test.app', { client: f.client });
      assert.deepEqual(result.plan.disabled, []);
      assert(!f.commands.some((command) => /pm disable-user|restricted_background_data 1/.test(command)));
      assert.equal(f.settings.engine.deepTrimRestorePending, true);
      assert.equal(f.settings.engine.deepTrimRestoreTarget, priorTarget);
      assert.equal(f.writes.length, 0);
      assert(f.rt._bootLog.some(({ line }) => line.includes('未对当前设备执行新的深度裁剪')));
    });
  }
  await test('cancelled native discovery settles without late prepare or spawn', async (dir) => {
    const { rt, prepared } = runtime(dir);
    const entered = deferred();
    const release = deferred();
    rt.ownedRuntimeIdentity = () => { entered.resolve(); return release.promise; };
    rt.boot = forbidden;
    const controller = new AbortController();
    const pending = rt.ensure({ signal: controller.signal });
    await entered.promise;
    controller.abort();
    assert.equal((await pending).code, 'START_CANCELLED');
    release.resolve({ owned: true });
    await new Promise(setImmediate);
    assert.deepEqual(prepared, []);
    assert.equal(rt._ensurePromise, null);
  });
  await test('ensure cannot share another caller cancellation scope', async (dir) => {
    const { rt } = runtime(dir);
    const entered = deferred();
    const release = deferred();
    rt._ensureInner = async () => { entered.resolve(); await release.promise; return { ok: false }; };
    const a = new AbortController();
    const b = new AbortController();
    const pending = rt.ensure({ signal: a.signal });
    await entered.promise;
    assert.equal(rt.ensure({ signal: a.signal }), pending);
    assert.equal((await rt.ensure({ signal: b.signal })).code, 'START_BUSY');
    release.resolve();
    await pending;
  });
  await test('Runtime fences actual spawn and AVD retry after awaited before-spawn cancellation', async (dir) => {
    const entered = deferred();
    const release = deferred();
    let spawns = 0;
    let avds = 0;
    class BaseEngine {
      async start() {
        this.ensureAvd();
        entered.resolve();
        await release.promise;
        for (let i = 0; i < 2; i++) {
          try { this.spawnOnce(); } catch (_) { /* base retry loop catches errors */ }
          try { this.ensureAvd(); } catch (_) { /* next retry is also fenced */ }
        }
        return { ok: false };
      }
      ensureAvd() { avds++; }
      spawnOnce() { spawns++; }
    }
    const { Runtime } = runtime(dir, { './emulator': { EmulatorEngine: BaseEngine },
      './provision': { Provisioner: class {} } });
    const rt = new Runtime(dir);
    const c = new AbortController();
    const pending = rt.emulator.start({ signal: c.signal });
    await entered.promise;
    c.abort();
    release.resolve();
    await pending;
    assert.equal(spawns, 0);
    assert.equal(avds, 1);
    await rt.emulator.start(); // cancellation scope is not retained by a later start
    assert.equal(spawns, 2);
  });
  for (const boundary of ['priority', 'active-callback', 'shell']) {
    await test(`beginApp cancellation fence at ${boundary} uses captured client`, async (dir) => {
      const { rt, settings } = runtime(dir);
      settings.engine.deepTrim = true;
      let cancelled = false;
      let active = 0;
      let shells = 0;
      let logs = 0;
      const entered = deferred();
      const release = deferred();
      rt.client = forbidden;
      rt.log = () => logs++;
      rt.emulator.cancelSnapshotSave = () => {};
      rt.emulator.setPriority = async () => { if (boundary === 'priority') { entered.resolve(); await release.promise; } };
      const client = { serial: 'emulator-5554', shell: async () => { shells++; if (boundary === 'shell') { entered.resolve(); await release.promise; } } };
      const pending = rt.beginApp('test.app', { client, shouldCancel: () => cancelled,
        onActive: () => { active++; if (boundary === 'active-callback') cancelled = true; } });
      if (boundary !== 'active-callback') { await entered.promise; cancelled = true; release.resolve(); }
      assert.equal((await pending).cancelled, true);
      assert.equal(active, boundary === 'priority' ? 0 : 1);
      assert.equal(shells, boundary === 'shell' ? 1 : 0);
      assert.equal(logs, 0);
    });
  }
  for (const boundary of ['entry', 'forceStop', 'shell', 'priority']) {
    await test(`endApp cancellation fence at ${boundary} does not rearm snapshots or polling`, async (dir) => {
      const { rt } = runtime(dir);
      let cancelled = boundary === 'entry';
      const calls = [];
      const entered = deferred();
      const release = deferred();
      const step = async (name) => { calls.push(name); if (boundary === name) { entered.resolve(); await release.promise; } };
      rt.client = forbidden;
      rt._armSnapshotSave = () => calls.push('snapshot');
      rt.emulator.setPriority = () => step('priority');
      const client = { forceStop: () => step('forceStop'), shell: () => step('shell') };
      const pending = rt.endApp('test.app', { client, shouldCancel: () => cancelled, onIdle: () => calls.push('idle') });
      if (boundary !== 'entry') { await entered.promise; cancelled = true; release.resolve(); }
      assert.equal((await pending).cancelled, true);
      assert.deepEqual(calls, boundary === 'entry' ? [] : ['forceStop', 'shell', 'priority'].slice(0,
        ['forceStop', 'shell', 'priority'].indexOf(boundary) + 1));
    });
  }
  await test('endApp normal captured-client path retains onIdle(true) contract', async (dir) => {
    const { rt } = runtime(dir);
    const calls = [];
    rt.client = forbidden;
    rt.emulator.setPriority = async () => calls.push('priority');
    rt._armSnapshotSave = () => calls.push('snapshot');
    await rt.endApp('test.app', { client: { forceStop: async () => calls.push('stop'), shell: async () => calls.push('shell') },
      onIdle: (idle) => calls.push(idle) });
    assert.deepEqual(calls, ['stop', 'shell', 'priority', 'snapshot', true]);
  });
  for (const serial of ['emulator-5554', 'emulator-5580']) {
    await test(`builtin requires ownership evidence before prepare (${serial})`, async (dir) => {
      const { rt, online, prepared } = runtime(dir);
      online.add(serial);
      const result = await rt.ensure();
      assert.equal(result.ok, false);
      assert.deepEqual(prepared, []);
    });
  }
  await test('builtin still reuses a verified native serial', async (dir) => {
    const { rt, online, prepared, processes } = runtime(dir);
    const owner = { owned: true, pid: 1234, started: 'birth' };
    processes.set(5554, owner);
    processes.set(5555, owner);
    online.add('emulator-5554');
    assert.equal((await rt.ensure()).ok, true);
    assert.deepEqual(prepared, ['emulator-5554']);
  });
  await test('builtin still adopts a verified detached instance on its dynamic port', async (dir) => {
    const { rt, online, prepared, processes } = runtime(dir);
    const owner = { owned: true, pid: 1234, started: 'birth' };
    processes.set(5580, owner);
    processes.set(5581, owner);
    online.add('127.0.0.1:5581');
    const r = await rt.ensure();
    assert.equal(r.reused, true);
    assert.deepEqual(prepared, ['127.0.0.1:5581']);
  });
  await test('builtin rechecks process identity after the online probe', async (dir) => {
    const { rt, prepared, processes } = runtime(dir);
    const first = { owned: true, pid: 1234, started: 'first' };
    const second = { ...first, owned: false, started: 'second' };
    for (const port of [5554, 5555]) processes.set(port, first);
    rt.client = () => ({ isOnline: async () => {
      for (const port of [5554, 5555]) processes.set(port, second);
      return true;
    } });
    assert.equal((await rt.ensure()).ok, false);
    assert.deepEqual(prepared, []);
  });
  await test('attach can use its selected device without builtin ownership', async (dir) => {
    const { rt, settings, online, prepared } = runtime(dir);
    settings.engine.mode = 'attach';
    settings.device = 'selected-serial';
    online.add(settings.device);
    assert.equal((await rt.ensure()).ok, true);
    assert.deepEqual(prepared, [settings.device]);
  });
  await test('attach does not fall back to a different device', async (dir) => {
    const { rt, settings, online, prepared, writes } = runtime(dir);
    settings.engine.mode = 'attach';
    settings.device = 'selected-serial';
    online.add('127.0.0.1:7555');
    assert.equal((await rt.ensure()).ok, false);
    assert.deepEqual(prepared, []);
    assert.deepEqual(writes, []);
  });
  await test('reset and gc previews only enumerate files, even while running', async (dir) => {
    const { rt, writes, userdata, snapshot, cache } = runtime(dir);
    rt.emulator.running = () => true;
    let stops = 0;
    rt.stop = async () => { stops++; return false; };
    const gc = await rt.cleanup({ apply: false, includeSnapshots: true });
    const reset = await rt.resetAndroidData({ apply: false });
    assert(gc.candidates.some((c) => snapshot.startsWith(c.path + path.sep)));
    assert(reset.candidates.some((c) => c.path === userdata));
    assert.equal(stops, 0);
    assert.deepEqual(writes, []);
    for (const file of [userdata, snapshot, cache]) assert(fs.existsSync(file));
  });
  for (const failure of ['stop false', 'stop throws', 'device remains online', 'ADB read fails', 'ADB output invalid', 'startup pending']) {
    await test(`reset and gc fail closed: ${failure}`, async (dir) => {
      const { rt, writes, online, userdata, snapshot, cache } = runtime(dir);
      let stops = 0;
      rt.stop = async () => {
        stops++;
        if (failure === 'stop throws') throw new Error('stop fault');
        return failure !== 'stop false';
      };
      if (failure === 'device remains online') online.add('127.0.0.1:5555');
      if (failure === 'ADB read fails') rt.client = () => ({ exec: async () => { throw new Error('ADB fault'); }, isOnline: async () => false });
      if (failure === 'ADB output invalid') rt.client = () => ({ exec: async () => ({ stdout: '' }), isOnline: async () => false });
      if (failure === 'startup pending') rt._ensurePromise = deferred().promise;
      const reset = await rt.resetAndroidData();
      assert.equal(reset.ok, false);
      await assert.rejects(rt.cleanup({ apply: true, includeSnapshots: true }));
      assert.equal(stops, failure === 'startup pending' ? 0 : 2);
      assert.deepEqual(writes, []);
      for (const file of [userdata, snapshot, cache]) assert(fs.existsSync(file));
    });
  }
  await test('reset only touches current data after successful stop, with concurrent start blocked', async (dir) => {
    const { rt, writes, userdata, snapshot, cache } = runtime(dir);
    const keep = put(path.join(path.dirname(userdata), 'config.ini'));
    const other = put(path.join(path.dirname(path.dirname(userdata)), 'apkstart-custom.avd', 'userdata-qemu.img'));
    const stop = deferred();
    let stops = 0;
    rt.stop = async () => { stops++; return stop.promise; };
    const reset = rt.resetAndroidData();
    try {
      assert.equal((await rt.ensure()).ok, false);
      await assert.rejects(rt.cleanup({ apply: true }), /另一项/);
      assert(fs.existsSync(userdata));
    } finally { stop.resolve(true); }
    assert.equal((await reset).ok, true);
    assert.equal(stops, 1);
    assert(!fs.existsSync(userdata));
    assert(!fs.existsSync(snapshot));
    assert.equal(writes.length, 2);
    for (const file of [keep, other, cache]) assert(fs.existsSync(file));
  });
  await test('failed Wi-Fi repair cannot schedule an implicit wipe or overlap maintenance', async (dir) => {
    const { rt, writes, userdata } = runtime(dir);
    rt.emulator.running = () => true;
    rt.emulator.forceWipeOnNextStart = forbidden;
    const repair = deferred();
    const entered = deferred();
    rt.emulator.repairWifi = () => { entered.resolve(); return repair.promise; };
    rt.adbPath = () => 'fake-adb';
    rt.stop = forbidden;
    const repairing = rt.repairNetwork();
    assert.strictEqual(rt.repairNetwork(), repairing);
    await entered.promise;
    try {
      assert.match((await rt.resetAndroidData()).error, /另一项/);
      assert.match((await rt.resizeDataPartition(8192)).error, /另一项/);
      assert.equal((await rt.ensure()).ok, false);
    } finally { repair.resolve({ ok: false }); }
    assert.match((await repairing).error, /未重置/);
    assert.equal((await repairing).wiped, false);
    assert(fs.existsSync(userdata));
    assert.deepEqual(writes, []);
  });
  await test('a QEMU readiness wait blocks both forms of data maintenance', async (dir) => {
    const { rt, userdata, cache, writes } = runtime(dir);
    const ready = deferred();
    rt._bootQemu = () => ready.promise;
    rt.stop = forbidden;
    const boot = rt.bootQemu();
    try {
      assert.match((await rt.resetAndroidData()).error, /正在启动/);
      await assert.rejects(rt.cleanup({ apply: true }), /正在启动/);
      assert(fs.existsSync(userdata) && fs.existsSync(cache));
      assert.deepEqual(writes, []);
    } finally { ready.resolve({ ok: true }); }
    assert.equal((await boot).ok, true);
    assert.equal(rt.vmStarting, false);
  });
  await test('maintenance discovers and stops an owned detached emulator at its real port', async (dir) => {
    const { rt, processes, userdata } = runtime(dir);
    const owner = { owned: true, pid: 1234, started: 'birth' };
    processes.set(5580, owner);
    processes.set(5581, owner);
    delete rt.stop;
    rt.emulator.stop = async ({ adbPath }) => {
      assert.equal(rt.emulator.port, 5580);
      assert.equal(adbPath, undefined, 'stop must not run snapshot invalidation during maintenance');
      assert(fs.existsSync(userdata));
      processes.clear();
      return true;
    };
    assert.equal((await rt.resetAndroidData()).ok, true);
    assert(!fs.existsSync(userdata));
  });
  await test('maintenance refuses an attached guest and does not stop or probe it', async (dir) => {
    const { rt, settings, userdata, writes } = runtime(dir);
    settings.engine.mode = 'attach';
    rt.stop = forbidden;
    rt.client = forbidden;
    assert.match((await rt.resetAndroidData()).error, /不允许维护/);
    await assert.rejects(rt.cleanup({ apply: true }), /不允许维护/);
    assert(fs.existsSync(userdata));
    assert.deepEqual(writes, []);
  });
  await test('gc frees only owned regenerable candidates; never removes download workspace or unrelated AVDs', async (dir) => {
    const { rt, root, settings, userdata, snapshot, cache } = runtime(dir);
    const lock = put(path.join(path.dirname(userdata), 'multiInstance.lock'));
    const unknownLock = put(path.join(path.dirname(userdata), 'unrelated.lock'));
    const unrelated = put(path.join(root, 'avd', 'someone.avd', 'userdata-qemu.img'));
    const unrelatedLock = put(path.join(root, 'avd', 'someone.avd', 'multiInstance.lock'));
    const staleDownload = put(path.join(root, '_tmp', 'components', 'emulator.zip.part'));
    const oldBase = put(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'));
    put(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'));
    const otherSnapshot = put(path.join(root, 'avd', 'apkstart-aosp.avd', 'snapshots', 'boot', 'ram.bin'));
    const keep = [cache, unknownLock, unrelated, unrelatedLock, staleDownload, oldBase, otherSnapshot];
    const iso = put(path.join(root, 'images', 'android-x86.iso'));
    const disk = put(path.join(root, 'images', 'android.qcow2'));
    settings.runtime.isoPath = iso;
    const externalToImages = put(path.join(root, 'x86_64', 'custom.qcow2'));
    settings.runtime.diskPath = externalToImages;
    const preview = await rt.cleanup({ apply: false });
    for (const f of [iso, disk, externalToImages, snapshot, ...keep]) {
      assert(!preview.candidates.some((c) => c.path === f || f.startsWith(c.path + path.sep)), f);
    }
    let stops = 0;
    rt.stop = async () => { stops++; return true; };
    const gc = await rt.cleanup({ apply: true, includeSnapshots: true });
    assert.equal(gc.ok, true);
    assert.equal(stops, 1);
    assert(!fs.existsSync(lock));
    assert(!fs.existsSync(snapshot));
    for (const f of [iso, disk, externalToImages, userdata, ...keep]) assert(fs.existsSync(f), f);
  });
  await test('grow refuses unconfirmed stop and reports before touching userdata or settings', async (dir) => {
    const { rt, writes, userdata, snapshot } = runtime(dir);
    rt.stop = async () => ({ ok: false });
    rt.emulator.resizeDataPartition = forbidden;
    assert.match((await rt.resizeDataPartition(8192)).error, /未能停止/);
    assert.equal(fs.readFileSync(userdata, 'utf8'), 'user data');
    assert(fs.existsSync(snapshot));
    assert.deepEqual(writes, []);
  });
  await test('async grow holds the offline maintenance lock until it settles', async (dir) => {
    const { rt, writes, userdata } = runtime(dir);
    const ext4 = Buffer.alloc(2048);
    ext4.writeUInt16LE(0xef53, 1024 + 0x38);
    fs.writeFileSync(userdata, ext4);
    const entered = deferred();
    const resize = deferred();
    rt.emulator.resizeDataPartition = (mb) => { entered.resolve(mb); return resize.promise; };
    rt.emulator.dataInfo = () => ({ imageBytes: 8192 * 1048576 });
    const growing = rt.resizeDataPartition(8192);
    assert.equal(await entered.promise, 8192);
    try {
      assert.equal((await rt.ensure()).ok, false);
      assert.equal((await rt.bootQemu()).ok, false);
      assert.match((await rt.resetAndroidData()).error, /另一项/);
      assert.match((await rt.resizeDataPartition(12288)).error, /另一项/);
      await assert.rejects(rt.clearStaleLocks(), /另一项/);
    } finally { resize.resolve({ ok: true, grown: true }); }
    assert.deepEqual(await growing, { ok: true, grown: true, imageBytes: 8192 * 1048576, stoppedVm: false });
    assert.deepEqual(writes, []);
  });
  await test('pending stop blocks launches and maintenance; killed flag is not exit confirmation', async (dir) => {
    const { rt, writes, userdata } = runtime(dir);
    const stopped = deferred();
    const entered = deferred();
    delete rt.stop;
    rt._stop = () => { entered.resolve(); return stopped.promise; };
    rt.vmProc = { pid: 17, killed: true };
    assert.equal(rt.vmRunning, true);
    const stopping = rt.stop();
    assert.strictEqual(rt.stop(), stopping);
    await entered.promise;
    try {
      assert.equal((await rt.bootEmulator()).ok, false);
      assert.equal((await rt.bootQemu()).ok, false);
      assert.equal((await rt.ensure()).ok, false);
      assert.match((await rt.resetAndroidData()).error, /另一项/);
    } finally { stopped.resolve(false); }
    assert.equal(await stopping, false);
    assert.equal(rt.vmProc.pid, 17);
    assert.equal((await rt.bootQemu()).ok, false);
    assert.equal((await rt.bootEmulator()).ok, false);
    rt.installing = true;
    assert.equal(await rt.markInstalled(), false);
    assert.equal(fs.readFileSync(userdata, 'utf8'), 'user data');
    assert.deepEqual(writes, []);
  });
  await test('environment discovery reserves boot before direct backend calls can spawn', async (dir) => {
    const { rt } = runtime(dir);
    const env = deferred();
    rt.provisioner.checkEnv = () => env.promise;
    let starts = 0;
    rt._bootQemu = async () => { starts++; return { ok: true }; };
    const booting = rt.boot();
    try {
      assert.equal((await rt.bootQemu()).ok, false);
      assert.equal((await rt.bootEmulator()).ok, false);
      assert.match((await rt.resetAndroidData()).error, /正在启动/);
    } finally { env.resolve({ emulator: { ok: false }, sysimg: { ok: false } }); }
    assert.equal((await booting).ok, true);
    assert.equal(starts, 1);
  });
  for (const kind of ['invalid ext4', 'qcow2 only', 'hard link', 'reassigned AVD parent']) {
    await test(`grow rejects ambiguous or unsafe userdata: ${kind}`, async (dir) => {
      const { rt, writes, root, userdata } = runtime(dir);
      let preserve = userdata;
      if (kind === 'qcow2 only') {
        preserve = `${userdata}.qcow2`;
        fs.renameSync(userdata, preserve);
      }
      if (kind === 'hard link') fs.linkSync(userdata, path.join(dir, 'shared-userdata.img'));
      if (kind === 'reassigned AVD parent') {
        rt.stop = async () => {
          fs.renameSync(path.join(root, 'avd'), path.join(root, 'avd-original'));
          put(userdata, 'new directory');
          return true;
        };
        preserve = path.join(root, 'avd-original', 'apkstart.avd', 'userdata-qemu.img');
      }
      rt.emulator.resizeDataPartition = forbidden;
      const result = await rt.resizeDataPartition(8192);
      assert.match(result.error, /无法安全|归属不明|覆盖层|目录已变更/);
      assert.equal(fs.readFileSync(preserve, 'utf8'), 'user data');
      assert.deepEqual(writes, []);
    });
  }
  await test('clearStaleLocks scopes to known locks in configured AVD home, without deleting snapshots', async (dir) => {
    const { rt, root } = runtime(dir);
    const avdHome = path.join(dir, 'explicit-avd-home');
    const activeAvd = path.join(avdHome, 'apkstart.avd');
    rt.provisioner.paths = () => ({ root, avdHome });
    const lock = put(path.join(activeAvd, 'hardware-qemu.ini.lock', 'pid'));
    const other = put(path.join(activeAvd, 'other.lock'));
    const snapshot = put(path.join(activeAvd, 'snapshots', 'keep', 'ram.bin'));
    const otherProfile = put(path.join(avdHome, 'apkstart-aosp.avd', 'multiInstance.lock'));
    const result = await rt.clearStaleLocks();
    assert(result.ok);
    assert.deepEqual(result.removed.map(({ path: candidate }) => candidate), [path.dirname(lock)]);
    assert(!fs.existsSync(lock));
    for (const p of [other, snapshot, otherProfile]) assert(fs.existsSync(p));
  });
  await test('cleanup never follows an aliased AVD home outside the runtime', async (dir) => {
    const runtimeRoot = path.join(dir, 'runtime');
    const outside = path.join(dir, 'outside');
    const snapshot = put(path.join(outside, 'apkstart.avd', 'snapshots', 'keep', 'ram.bin'));
    fs.mkdirSync(runtimeRoot);
    fs.symlinkSync(outside, path.join(runtimeRoot, 'avd'), 'junction');
    const result = layers.prune(runtimeRoot, { apply: true });
    assert.deepEqual(result.removed, []);
    assert(fs.existsSync(snapshot));
  });
  for (const legacyName of [false, true]) {
    await test(`download never writes an imported ISO (${legacyName ? 'legacy default filename' : 'external path'})`, async (dir) => {
      const destinations = [];
      const { p, iso, settings, imagesDir } = provision(dir, async (_urls, file) => {
        destinations.push(file);
        put(file, 'download');
        return { file };
      });
      const original = put(legacyName ? iso : path.join(dir, 'borrowed.iso'), 'original');
      p.importIso(original);
      const result = await p.downloadIso();
      assert.equal(fs.readFileSync(original, 'utf8'), 'original');
      assert.notEqual(destinations[0], original);
      assert(result.file.startsWith(imagesDir + path.sep));
      assert.equal(settings.runtime.isoPath, result.file);
      assert.equal(fs.readFileSync(result.file, 'utf8'), 'download');
    });
  }
  await test('failed download does not publish a new ISO or mutate the old reference', async (dir) => {
    const { p, settings } = provision(dir, async (_urls, file) => {
      put(file, 'invalid');
      return { file };
    });
    const original = put(path.join(dir, 'borrowed.iso'), 'original');
    p.importIso(original);
    await assert.rejects(p.downloadIso(), /bad ISO/);
    assert.equal(settings.runtime.isoPath, original);
    assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  });
  await test('an explicit import during download wins; a partial download cannot be imported', async (dir) => {
    const started = deferred();
    const resume = deferred();
    const { p, settings } = provision(dir, async (_urls, file) => {
      put(file, 'download');
      started.resolve(file);
      await resume.promise;
      return { file };
    });
    const downloading = p.downloadIso();
    const partial = await started.promise;
    const original = put(path.join(dir, 'chosen.iso'), 'original');
    try {
      assert.throws(() => p.importIso(partial), /仍在下载/);
      p.importIso(original);
    } finally { resume.resolve(); }
    await assert.rejects(downloading, /选择已变更/);
    assert.equal(settings.runtime.isoPath, original);
    assert.equal(fs.readFileSync(original, 'utf8'), 'original');
    assert(!fs.existsSync(path.dirname(partial)));
  });
  console.log(`\n[runtime-data-safety-test] ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));

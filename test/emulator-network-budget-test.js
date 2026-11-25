'use strict';
// Product code runs in a strict VM: no real ADB, process inspection or filesystem writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto');

async function flush() { for (let i = 0; i < 80; i += 1) await Promise.resolve(); }

function clock() {
  let now = 1700000000000;
  const timers = new Set();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: FakeDate, timers,
    setTimeout(fn, ms) {
      const timer = { fn, at: now + Number(ms), unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    async tick(ms) {
      await flush();
      const end = now + ms;
      for (;;) {
        const timer = [...timers].filter((entry) => entry.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        timers.delete(timer);
        now = timer.at;
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

function fixture() {
  const time = clock();
  const calls = { owner: [], adb: [], cancelled: [], tree: [], priority: [] };
  const original = {
    pid: 4567, started: 'owned-birth', owned: true,
    exe: 'C:\\fixture\\runtime\\emulator\\qemu\\windows-x86_64\\qemu-system-x86_64.exe',
    commandLine: 'qemu-system-x86_64.exe -avd apkstart -datadir C:\\fixture\\avd\\apkstart.avd',
  };
  const state = {
    owner: { ...original }, adbPid: original.pid, ownerDelay: 0, commandDelay: 0,
    ip: '10.0.2.15', wifi: 'Wifi is connected', malformed: false, onCommand: null,
    networkInterface: 'wlan0', linkFlags: 'BROADCAST,MULTICAST,UP,LOWER_UP', networkOutput: null,
    children: [], onTree: null,
  };
  function read(call, delay, value, callback) {
    let done = false;
    let resultTimer;
    let timeoutTimer;
    const signal = call.options.signal;
    const finish = (error) => {
      if (done) return;
      done = true;
      time.clearTimeout(resultTimer);
      time.clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) calls.cancelled.push(call);
      callback(error, error ? null : value());
    };
    const onAbort = () => finish(Object.assign(new Error('fixture aborted'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) queueMicrotask(onAbort);
    else {
      if (delay === 0) queueMicrotask(() => finish(null));
      else if (Number.isFinite(delay)) resultTimer = time.setTimeout(() => finish(null), delay);
      timeoutTimer = time.setTimeout(() => finish(Object.assign(new Error('fixture timeout'), { killed: true })), call.options.timeoutMs ?? call.options.timeout);
    }
  }
  function ownerRead(kind, args, options, value) {
    const call = { kind, args, options: options || {}, at: time.Date.now() };
    calls.owner.push(call);
    const delay = typeof state.ownerDelay === 'function' ? state.ownerDelay(call, calls.owner.length) : state.ownerDelay;
    return new Promise((resolve) => read(call, delay, value, (error, result) => resolve(error ? null : result)));
  }
  const processOwner = {
    pidOnPort(port, options) { return ownerRead('port', port, options, () => port === 5555 ? state.adbPid : state.owner?.pid || 0); },
    getProcessInfo(pid, options) { return ownerRead('process', pid, options, () => pid === state.owner?.pid ? { ...state.owner } : null); },
    async getProcessTreeSnapshot(pid) {
      calls.tree.push(pid);
      const root = state.owner && { ...state.owner };
      state.onTree?.();
      return root ? { root, currentRoot: state.owner && { ...state.owner }, processes: state.children.map((child) => ({ ...child })) } : null;
    },
    ownsEmulator: (info) => !!info?.owned,
    sameIdentity: (a, b) => !!a && !!b && a.pid === b.pid && a.started === b.started,
    realPath: (value) => value,
  };
  const route = { isChild: true, adbPath: 'fixture-adb.exe', port: 49163 };
  const settings = { engine: { keepSnapshot: false }, runtime: {} };
  const doctor = {
    freeDiskMB: () => 100000, freeAdbPort: async () => route.port,
    freePortPair: async () => 5554,
    autoProfile: () => ({ label: 'host', gpu: 'host', accel: 'auto', accelOk: true, snapshot: false, lcd: { w: 720, h: 1280 } }),
    planVariants: (profile) => [profile], orientLcd: (screen) => screen,
    bootTimeoutFor: () => 60000, describeProfile: () => 'fixture profile',
  };
  class Provisioner {
    paths() { return { avdHome: 'C:\\fixture\\avd', root: 'C:\\fixture\\runtime' }; }
    async emulatorAccel() { return { ok: true, kind: 'whpx' }; }
    async emulatorVersion() { return { version: '37.4.2' }; }
    systemImageInfo() { return { ok: true }; }
  }
  const forbidden = (name) => () => assert.fail(`unexpected I/O: ${name}`);
  const childProcess = {
    spawn: forbidden('spawn'), spawnSync: forbidden('spawnSync'),
    execFile(exe, args, options, callback) {
      if (exe === 'powershell.exe') {
        assert(args.some((arg) => arg.endsWith('priority.ps1')));
        const expected = JSON.parse(Buffer.from(args[args.indexOf('-Expected') + 1], 'base64').toString('utf8'));
        calls.priority.push({ expected, level: args[args.indexOf('-Level') + 1] });
        queueMicrotask(() => callback(null, `CHANGED=${expected.length}`, ''));
        return {};
      }
      assert.equal(exe, route.adbPath);
      const call = { exe, args: [...args], options, at: time.Date.now() };
      calls.adb.push(call);
      const output = () => {
        state.onCommand?.(call);
        if (state.malformed) return '';
        if (state.networkOutput !== null) return state.networkOutput;
        return `${state.ip ? `2: ${state.networkInterface} inet ${state.ip}/24 scope global ${state.networkInterface}\n` : ''}__APKSTART_WIFI_STATUS__\n${state.wifi}\n__APKSTART_LINK_STATUS__\n2: ${state.networkInterface}: <${state.linkFlags}> mtu 1500 state UP\n`;
      };
      read(call, state.commandDelay, output, (error, out) => callback(error, out || '', ''));
      return {};
    },
  };
  const dependencies = {
    child_process: childProcess,
    fs: new Proxy({ mkdirSync() {}, existsSync: (file) => file.endsWith('priority.ps1') }, { get: (target, key) => Object.hasOwn(target, key) ? target[key] : forbidden(`fs.${String(key)}`) }),
    path: path.win32, crypto, './store': { DATA_DIR: 'C:\\fixture\\data', getSettings: () => settings },
    './provision': { Provisioner }, './doctor': doctor, './gpu': { probe: async () => null },
    './userdata': {}, './process-owner': processOwner, './peripherals': {},
    './instance-adb': {
      route: () => route, assertReady: (captured) => assert.equal(captured, route),
      executable: (_requested, captured) => { assert.equal(captured, route); return route.adbPath; },
      clientArgs: (args) => ['-H', '127.0.0.1', '-P', String(route.port), ...args],
      environment: () => ({ ANDROID_ADB_SERVER_PORT: String(route.port) }),
    },
    './platform': { canEmbed: true },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8'), {
    module, exports: module.exports, process: { platform: 'win32', env: {} }, Buffer,
    __dirname: 'C:\\fixture\\src\\core',
    require(name) { assert(Object.hasOwn(dependencies, name), `unexpected module ${name}`); return dependencies[name]; },
    Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, queueMicrotask,
  }, { filename: 'emulator.js' });
  const emu = new module.exports.EmulatorEngine('C:\\fixture\\app');
  function prepareStart() {
    emu.locate = () => ({ emulatorExe: 'fixture-emulator.exe', root: 'C:\\fixture\\runtime' });
    emu.imageChoice = () => ({ compat: false });
    emu._resetAdbServer = async () => true;
    emu.killOrphanProcesses = async () => 0;
    emu._logWrite = () => {};
    emu.ensureAvd = () => ({ ok: true });
    emu.spawnOnce = () => { emu.proc = { pid: original.pid, killed: false }; };
    emu._waitSpawnSettled = async () => false;
    emu._clearFailure = () => {};
  }
  return { time, calls, state, emu, prepareStart };
}

test('a network probe reads both status fields in one private, birth-pinned shell', async () => {
  const f = fixture();
  const result = await f.emu.checkNetwork('unrelated-adb.exe', { timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.ip, '10.0.2.15');
  assert.equal(result.gateway, '10.0.2.2');
  assert.equal(f.calls.adb.length, 1);
  const call = f.calls.adb[0];
  assert.deepEqual(call.args.slice(0, 6), ['-H', '127.0.0.1', '-P', '49163', '-s', 'emulator-5554']);
  assert.equal(call.args.at(-1), 'ip -o addr; echo __APKSTART_WIFI_STATUS__; cmd wifi status; echo __APKSTART_LINK_STATUS__; ip -o link');
  assert.equal(f.calls.owner.length, 12, 'initial identity plus pre/post dispatch checks remain intact');
  assert(f.calls.owner.every((entry) => entry.options.timeoutMs === 500));
});

test('read-only status preserves disconnection and unavailable evidence', async () => {
  const f = fixture();
  f.state.wifi = 'Wifi is disconnected';
  assert.equal((await f.emu.checkNetwork()).reason, 'wifi-not-connected');
  f.state.ip = '';
  f.state.wifi = 'Wifi is connected';
  assert.equal((await f.emu.checkNetwork()).reason, 'no-ip-address');
  f.state.malformed = true;
  assert.equal((await f.emu.checkNetwork()).reason, 'network-status-unavailable');
});

test('the observed emulator Ethernet address is ready despite disconnected Wi-Fi when its carrier is up', async () => {
  const f = fixture();
  f.state.networkOutput = [
    '1: lo inet 127.0.0.1/8 scope host lo',
    '2: dummy0 inet6 fe80::7ccb:9aff:fe17:8131/64 scope link',
    '15: eth0 inet 10.0.2.15/8 brd 10.255.255.255 scope global eth0',
    '__APKSTART_WIFI_STATUS__',
    'Wifi is enabled',
    'Wifi scanning is always available',
    '==== Primary ClientModeManager instance ====',
    'Wifi is not connected',
    '__APKSTART_LINK_STATUS__',
    '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN',
    '15: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP',
  ].join('\n');
  const result = await f.emu.checkNetwork('', { waitMs: 20000, timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.ip, '10.0.2.15');
  assert.equal(result.interface, 'eth0');
  assert.equal(result.wifiConnected, false);
  assert.equal(f.calls.adb.length, 1);
  assert.equal(f.calls.owner.length, 12);
  assert.equal(f.time.timers.size, 0);
});

test('independent Ethernet and cellular interfaces require their own active carrier', async () => {
  for (const networkInterface of ['eth0', 'enp0s3', 'rmnet0', 'rmnet_data0', 'ccmni0', 'pdp0']) {
    const f = fixture();
    f.state.networkInterface = networkInterface;
    f.state.wifi = 'Wifi is not connected';
    const result = await f.emu.checkNetwork();
    assert.equal(result.ok, true, networkInterface);
    assert.equal(result.interface, networkInterface);
  }
  const aliased = fixture();
  aliased.state.networkInterface = 'eth0@if23';
  aliased.state.wifi = 'Wifi is disabled';
  assert.equal((await aliased.emu.checkNetwork()).interface, 'eth0');
});

test('stale, down, unrelated and tunnel-only addresses cannot claim network readiness', async () => {
  for (const linkFlags of ['BROADCAST,MULTICAST,UP', 'BROADCAST,MULTICAST,LOWER_UP', 'BROADCAST,MULTICAST,UP,LOWER_UP,NO-CARRIER']) {
    const f = fixture();
    f.state.networkInterface = 'eth0';
    f.state.linkFlags = linkFlags;
    f.state.wifi = 'Wifi is not connected';
    assert.equal((await f.emu.checkNetwork()).ok, false, linkFlags);
  }
  for (const networkInterface of ['lo', 'tun0', 'tap0', 'dummy0', 'veth0', 'unknown0']) {
    const f = fixture();
    f.state.networkInterface = networkInterface;
    assert.equal((await f.emu.checkNetwork()).ok, false, networkInterface);
  }
  const unrelated = fixture();
  unrelated.state.networkOutput = '15: eth0 inet 10.0.2.15/8 scope global eth0\n__APKSTART_WIFI_STATUS__\nWifi is not connected\n__APKSTART_LINK_STATUS__\n2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n';
  assert.equal((await unrelated.emu.checkNetwork()).ok, false);
});

test('loopback, link-local, multicast, invalid and non-global IPv4 evidence is rejected', async () => {
  for (const ip of ['0.0.0.0', '127.0.0.1', '169.254.10.20', '224.0.0.1', '255.255.255.255', '999.0.2.15']) {
    const f = fixture();
    f.state.networkInterface = 'eth0';
    f.state.ip = ip;
    assert.equal((await f.emu.checkNetwork()).ok, false, ip);
  }
  const hostScope = fixture();
  hostScope.state.networkOutput = '15: eth0 inet 10.0.2.15/8 scope host eth0\n__APKSTART_WIFI_STATUS__\nWifi is not connected\n__APKSTART_LINK_STATUS__\n15: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n';
  assert.equal((await hostScope.emu.checkNetwork()).ok, false);
  const unknownWifi = fixture();
  unknownWifi.state.wifi = 'Wifi status unavailable';
  assert.equal((await unknownWifi.emu.checkNetwork()).ok, false);
});

test('all ownership reads and the guest command consume one shrinking total budget', async () => {
  const f = fixture();
  f.state.ownerDelay = 5;
  f.state.commandDelay = 10;
  const started = f.time.Date.now();
  const result = f.emu.checkNetwork('', { timeoutMs: 100 });
  await f.time.tick(100);
  assert.equal((await result).ok, true);
  assert.equal(f.calls.adb.length, 1);
  assert.equal(f.calls.adb[0].options.timeout, 60);
  for (const entry of f.calls.owner) assert.equal(entry.options.timeoutMs, 100 - (entry.at - started));
});

test('an initial ownership timeout cancels its read and cannot dispatch a late shell', async () => {
  const f = fixture();
  f.state.ownerDelay = Infinity;
  const result = f.emu.checkNetwork('', { timeoutMs: 100 });
  await f.time.tick(100);
  assert.equal((await result).reason, 'timeout');
  assert.equal(f.calls.owner.length, 1);
  assert.equal(f.calls.cancelled.length, 1);
  assert.equal(f.calls.adb.length, 0);
  await f.time.tick(60000);
  assert.equal(f.calls.adb.length, 0);
  assert.equal(f.time.timers.size, 0);
});

test('a pre-dispatch ownership timeout never sends the network command', async () => {
  const f = fixture();
  f.state.ownerDelay = (_entry, count) => count === 5 ? Infinity : 0;
  const result = f.emu.checkNetwork('', { timeoutMs: 100 });
  await f.time.tick(100);
  assert.equal((await result).reason, 'timeout');
  assert.equal(f.calls.owner.length, 5);
  assert.equal(f.calls.adb.length, 0);
});

test('a running shell is terminated at the remaining deadline before postflight queries', async () => {
  const f = fixture();
  f.state.ownerDelay = 5;
  f.state.commandDelay = Infinity;
  const result = f.emu.checkNetwork('', { timeoutMs: 100 });
  await f.time.tick(100);
  assert.equal((await result).reason, 'timeout');
  assert.equal(f.calls.adb[0].options.timeout, 60);
  assert(f.calls.cancelled.includes(f.calls.adb[0]));
  assert.equal(f.calls.owner.length, 8);
  assert.equal(f.time.timers.size, 0);
});

test('postflight ownership still rejects a changed process birth', async () => {
  const f = fixture();
  f.state.onCommand = () => { f.state.owner = { ...f.state.owner, started: 'recycled-birth' }; };
  await assert.rejects(f.emu.checkNetwork(), { code: 'RUNTIME_OWNERSHIP_LOST' });
  assert.equal(f.calls.adb.length, 1);
});

test('a postflight ownership timeout stops its read and returns within the original budget', async () => {
  const f = fixture();
  f.state.ownerDelay = (_entry, count) => count === 9 ? Infinity : 0;
  const result = f.emu.checkNetwork('', { timeoutMs: 100 });
  await f.time.tick(100);
  assert.equal((await result).reason, 'timeout');
  assert.equal(f.calls.adb.length, 1);
  assert.equal(f.calls.owner.length, 9);
  assert.equal(f.calls.cancelled.length, 1);
  assert.equal(f.time.timers.size, 0);
});

test('split console and ADB owners fail closed before any command', async () => {
  const f = fixture();
  f.state.adbPid = 9999;
  await assert.rejects(f.emu.checkNetwork(), { code: 'RUNTIME_OWNERSHIP_LOST' });
  assert.equal(f.calls.adb.length, 0);
});

test('cancellation reaches an in-flight ownership subprocess', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.state.ownerDelay = Infinity;
  const result = f.emu.checkNetwork('', { timeoutMs: 5000, signal: controller.signal });
  const rejected = assert.rejects(result, { code: 'NETWORK_CHECK_CANCELLED' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(f.calls.owner[0].options.signal, controller.signal);
  assert.equal(f.calls.cancelled.length, 1);
  assert.equal(f.calls.adb.length, 0);
  assert.equal(f.time.timers.size, 0);
});

test('cancellation terminates an active ADB subprocess without starting later reads', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.state.commandDelay = Infinity;
  const result = f.emu.checkNetwork('', { timeoutMs: 5000, signal: controller.signal });
  const rejected = assert.rejects(result, { code: 'NETWORK_CHECK_CANCELLED' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(f.calls.adb[0].options.signal, controller.signal);
  assert(f.calls.cancelled.includes(f.calls.adb[0]));
  assert.equal(f.calls.owner.length, 8);
  assert.equal(f.time.timers.size, 0);
});

test('polling shares the original deadline and cancels its sleep promptly', async () => {
  const f = fixture();
  f.state.ip = '';
  f.state.wifi = 'Wifi is disconnected';
  const result = f.emu.checkNetwork('', { waitMs: 5000, interval: 30, timeoutMs: 100 });
  await f.time.tick(100);
  assert.equal((await result).reason, 'timeout');
  assert.equal(f.calls.adb.length, 4);
  assert.equal(f.time.timers.size, 0);

  const controller = new AbortController();
  const cancelled = f.emu.checkNetwork('', { waitMs: 5000, signal: controller.signal });
  const rejected = assert.rejects(cancelled, { code: 'NETWORK_CHECK_CANCELLED' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(f.time.timers.size, 0);
});

test('zero budget and an already-cancelled signal perform no ownership or guest I/O', async () => {
  const f = fixture();
  assert.equal((await f.emu.checkNetwork('', { timeoutMs: 0 })).reason, 'timeout');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.emu.checkNetwork('', { signal: controller.signal }), { code: 'NETWORK_CHECK_CANCELLED' });
  assert.equal(f.calls.owner.length + f.calls.adb.length, 0);
});

test('boot-ready returns without a network probe, Wi-Fi repair or settings UI', async () => {
  const f = fixture();
  f.prepareStart();
  f.emu.checkNetwork = () => assert.fail('boot success must not await network');
  f.emu.repairWifi = () => assert.fail('boot success must not mutate guest Wi-Fi');
  const result = await f.emu.start({ probe: async () => 'ok' });
  assert.equal(result.ok, true);
  assert.equal(result.network, null);
  assert.equal(result.profile.gpu, 'host');
  assert.equal(f.calls.adb.length, 0);
});

test('priority promotion includes an adopted QEMU with no descendants', async () => {
  const f = fixture();
  assert.equal(f.emu.proc, null);
  assert.equal(await f.emu.setPriority('normal'), 1);
  assert.deepEqual(f.calls.tree, [f.state.owner.pid]);
  assert.deepEqual(f.calls.owner.map((entry) => entry.kind), ['port'], 'snapshot replaces the two separate process Inspect helpers');
  assert.equal(f.calls.priority.length, 1);
  assert.equal(f.calls.priority[0].level, 'normal');
  assert.deepEqual(f.calls.priority[0].expected, [{
    pid: f.state.owner.pid, started: f.state.owner.started, exe: f.state.owner.exe,
    cmdHash: crypto.createHash('sha256').update(f.state.owner.commandLine, 'utf8').digest('hex'),
  }]);
});

test('priority changes reject a root whose birth changed while enumerating descendants', async () => {
  const f = fixture();
  f.state.onTree = () => { f.state.owner = { ...f.state.owner, started: 'recycled-birth' }; };
  assert.equal(await f.emu.setPriority('normal'), 0);
  assert.equal(f.calls.priority.length, 0);
});

test('priority promotion uses one fresh snapshot per request and never reuses an earlier tree', async () => {
  const f = fixture();
  f.emu.proc = { pid: f.state.owner.pid };
  f.state.children = [{ ...f.state.owner, pid: 7654, started: 'owned-child-birth' },
    { ...f.state.owner, pid: 8765, owned: false }];
  assert.equal(await f.emu.setPriority('below'), 2);
  assert.equal(await f.emu.setPriority('normal'), 2);
  assert.deepEqual(f.calls.tree, [f.state.owner.pid, f.state.owner.pid]);
  assert.equal(f.calls.owner.length, 0, 'a known local process needs no separate process or port query');
  assert.deepEqual(f.calls.priority.map((entry) => entry.level), ['below', 'normal']);
  assert.deepEqual(f.calls.priority[0].expected.map((entry) => entry.pid), [f.state.owner.pid, 7654]);
});

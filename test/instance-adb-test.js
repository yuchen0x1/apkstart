'use strict';
// Host fs is used ONLY to read the requested source files. Business modules run
// under strict VM dependency maps: all filesystem, network and processes are fake.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const core = path.join(__dirname, '..', 'src', 'core');
const win = path.win32;
const binary = 'C:\\fixture\\runtime\\platform-tools\\adb.exe';
const alias = 'C:\\fixture\\alias\\adb.exe';
const emulatorExe = 'C:\\fixture\\runtime\\emulator\\emulator.exe';

async function flush() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }
function clock() {
  let now = 1700000000000;
  const timers = new Set();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  return {
    Date: FakeDate, timers,
    setTimeout(fn, ms) { const timer = { fn, at: now + Number(ms), unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    async tick(ms) {
      await flush();
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next); now = next.at; next.fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function fixture(t, { isChild = true, id = 'child-a', allocator = { next: 49163 }, env = {}, behavior = 'ready' } = {}) {
  const time = clock();
  const calls = { spawn: [], exec: [], kill: [], listen: [], close: [], connect: [], registrations: [], writes: [], fs: [] };
  const owner = { pid: 9001, started: 'owned-birth', owned: true };
  const state = { behavior, owner, adbPid: owner.pid, killMode: 'exit', reserveError: '', execHook: null };
  const processStub = { platform: 'win32', arch: 'x64', env: { ...env } };
  const forbidden = (name) => () => assert.fail(`unmocked I/O: ${String(name)}`);
  const fakeFs = new Proxy({
    statSync(file) {
      calls.fs.push(['stat', file]);
      if (![binary, alias, emulatorExe].includes(file)) throw Object.assign(new Error('fixture ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, size: 4096 };
    },
    realpathSync(file) { calls.fs.push(['realpath', file]); assert([binary, alias].includes(file)); return binary; },
    existsSync(file) { return [binary, alias, emulatorExe].includes(file); },
    mkdirSync(file) { calls.fs.push(['mkdir', file]); },
    writeFileSync(file) { calls.fs.push(['write', file]); },
    appendFileSync(file) { calls.fs.push(['append', file]); },
    rmSync(file) { calls.fs.push(['rm', file]); },
    readdirSync: () => [],
    statfsSync: () => ({ bavail: 10000000, bsize: 4096 }),
    readFileSync: () => { throw Object.assign(new Error('fixture ENOENT'), { code: 'ENOENT' }); },
  }, { get(target, key) { return Object.hasOwn(target, key) ? target[key] : forbidden(key); } });
  let nextPid = 10000;
  function child() {
    const p = new EventEmitter();
    p.pid = ++nextPid; p.exitCode = null; p.signalCode = null; p.killed = false;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdout.setEncoding = p.stderr.setEncoding = () => {};
    p.stdin = new EventEmitter(); p.stdin.writable = true;
    p.stdin.end = () => { p.stdin.writable = false; };
    p.stdin.write = (text) => {
      calls.writes.push({ proc: p, text });
      const token = /echo (__APKSTART_\d+__)/.exec(text)?.[1];
      if (token) queueMicrotask(() => p.stdout.emit('data', token + '\n'));
      return true;
    };
    p.unref = () => {};
    p.exit = (code = 0, signal = null) => { p.exitCode = code; p.signalCode = signal; p.emit('exit', code, signal); };
    p.kill = (signal) => {
      calls.kill.push({ proc: p, signal });
      if (state.killMode === 'refuse') return false;
      p.killed = true;
      if (state.killMode !== 'hang') queueMicrotask(() => p.exit(null, signal || 'SIGTERM'));
      return true;
    };
    return p;
  }
  const childProcess = {
    spawn(exe, args, options) {
      const p = child();
      const call = { exe, args: [...args], options, proc: p };
      calls.spawn.push(call);
      if (args.includes('server') && args.includes('nodaemon')) {
        assert.equal(exe, binary);
        queueMicrotask(() => {
          if (state.behavior === 'ready') p.stderr.emit('data', 'adb D main.cpp: Event loop starting\n');
          else if (state.behavior === 'bind-race') {
            p.stderr.emit('data', 'could not install *smartsocket* listener: address already in use\n');
            p.exit(1);
          } else if (state.behavior === 'spawn-error') {
            p.pid = undefined; p.emit('error', Object.assign(new Error('fixture spawn ENOENT'), { code: 'ENOENT' }));
          }
        });
      }
      return p;
    },
    execFile(exe, args, options, callback) {
      const call = { exe, args: [...args], options };
      calls.exec.push(call);
      let a = [...args];
      if (a[0] === '-H') a = a.slice(4);
      if (a[0] === '-s') a = a.slice(2);
      let out = '';
      if (a[0] === 'devices') out = 'List of devices attached\nemulator-5554\tdevice\n';
      else if (a[0] === 'shell') {
        if (a[1] === 'getprop sys.boot_completed') out = '1\n';
        if (a[1] === 'ip -o addr') out = '2: wlan0 inet 10.0.2.15/24\n';
        if (a[1] === 'cmd wifi status') out = 'Wifi is connected\n';
      }
      const override = state.execHook?.(call, a);
      queueMicrotask(() => callback(override?.error || null, override?.stdout ?? out, override?.stderr || ''));
      return child();
    },
    spawnSync: forbidden('spawnSync'), execFileSync: forbidden('execFileSync'),
  };
  const net = {
    createServer() {
      const server = new EventEmitter();
      server.listening = false;
      server.listen = (options, callback) => {
        calls.listen.push({ ...options });
        queueMicrotask(() => {
          if (state.reserveError) { server.emit('error', Object.assign(new Error('fixture reserve'), { code: state.reserveError })); return; }
          server.port = options.port || allocator.next++;
          server.listening = true; callback();
        });
        return server;
      };
      server.address = () => ({ port: server.port });
      server.close = (callback) => {
        calls.close.push(server.port);
        server.listening = false;
        queueMicrotask(() => callback?.());
      };
      return server;
    },
    connect(options) {
      calls.connect.push({ ...options });
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.destroy = () => { socket.destroyed = true; };
      socket.setTimeout = () => socket;
      socket.end = (request, callback) => { calls.registrations.push({ options, request }); queueMicrotask(callback); };
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  };
  function load(name, deps) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(core, name), 'utf8'), {
      module, exports: module.exports,
      require(dependency) { assert(Object.hasOwn(deps, dependency), `${name}: unmocked dependency ${dependency}`); return deps[dependency]; },
      process: processStub, Buffer, console, Date: time.Date,
      setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, queueMicrotask,
    }, { filename: name });
    return module.exports;
  }
  const helper = load('instance-adb.js', {
    fs: fakeFs, path: win, net, child_process: childProcess,
    './instance-context': { current: () => Object.freeze({ isChild, id }) },
  });
  const osStub = {
    homedir: () => 'C:\\fixture\\home', tmpdir: () => 'C:\\fixture\\tmp',
    cpus: () => Array.from({ length: 8 }, () => ({ model: 'fixture CPU' })),
    totalmem: () => 16 * 1024 ** 3, freemem: () => 12 * 1024 ** 3,
  };
  const adbModule = load('adb.js', {
    child_process: childProcess, fs: fakeFs, os: osStub, path: win, crypto: {},
    './instance-adb': helper, './pointer': { isInputCommand: (cmd) => /^input (?:tap|keyevent) /.test(cmd) },
  });
  const doctor = load('doctor.js', {
    os: osStub, fs: fakeFs, path: win, net, crypto: {}, child_process: childProcess,
    './instance-adb': helper, './platform': { describe: () => ({ supported: true }) },
  });
  const settings = { engine: { keepSnapshot: true, gpuMode: 'auto', mode: 'builtin' }, runtime: {} };
  const p = { root: 'C:\\fixture\\runtime', avdHome: `C:\\fixture\\instances\\${id}\\avd`, adbExe: binary, emulatorExe };
  class Provisioner {
    paths() { return p; }
    adbVersionPath() { return ''; }
    async emulatorAccel() { return { ok: true, kind: 'whpx' }; }
    async emulatorVersion() { return { version: '37.1.0' }; }
    systemImageInfo() { return { ok: true }; }
    playImageInfo() { return { ok: true }; }
    invalidateEnvCache() {}
  }
  const processOwner = {
    pidOnPort: async (port) => port === 5555 ? state.adbPid : state.owner?.pid || 0,
    getProcessInfo: async (pid) => pid === state.owner?.pid ? { ...state.owner } : null,
    ownsEmulator: (info) => !!info?.owned,
    sameIdentity: (a, b) => !!a && !!b && a.pid === b.pid && a.started === b.started,
    terminateOwnedProcess: forbidden('terminateOwnedProcess'),
  };
  const emuModule = load('emulator.js', {
    child_process: childProcess, fs: fakeFs, path: win, net,
    './instance-adb': helper, './doctor': doctor, './userdata': {}, './process-owner': processOwner,
    './peripherals': require('../src/core/peripherals'), './adb': adbModule,
    './platform': { canEmbed: true },
    './logfile': { append: (file) => calls.fs.push(['append', file]) },
    './store': { DATA_DIR: 'C:\\fixture\\data', getSettings: () => settings, saveSettings: () => {} },
    './provision': { Provisioner },
  });
  t.after(async () => { state.killMode = 'exit'; try { await helper.dispose(); } catch (_) { /* explicitly tested stop failures */ } });
  const init = (options = {}) => helper.initialize({ adbPath: binary, ...options });
  const makeEmulator = () => {
    const emu = new emuModule.EmulatorEngine('C:\\fixture\\app');
    emu.locate = () => ({ root: p.root, emulatorExe });
    emu.imageChoice = () => ({ compat: false, custom: false });
    return emu;
  };
  const prepareStart = (emu, { rounds = [[]], dead = [] } = {}) => {
    doctor.freeDiskMB = () => 100000;
    doctor.shortPath = (file) => file;
    doctor.freePortPair = async () => 5554;
    doctor.autoProfile = () => ({
      label: 'fixture', accel: 'auto', accelOk: true, gpu: 'software', snapshot: true,
      memoryMB: 2048, cores: 2, lcd: { w: 720, h: 1280, dpi: 320 }, host: { cores: 8, totalMB: 16384 },
    });
    doctor.planVariants = (profile) => rounds.map((_, i) => ({ ...profile, label: `round-${i}` }));
    emu.ensureAvd = () => ({ ok: true, data: { ok: true } });
    emu.killOrphanProcesses = async () => 0;
    emu.killAttempt = async () => { emu.proc = null; };
    let index = -1;
    emu.spawnOnce = () => { index += 1; emu.proc = { pid: owner.pid, killed: false }; for (const line of rounds[index]) emu.log(line); };
    emu._waitSpawnSettled = async () => {
      if (dead[index]) { emu.proc = null; emu.lastExitCode = 1; return true; }
      return false;
    };
  };
  return { helper, init, calls, state, time, env: processStub.env, AdbClient: adbModule.AdbClient, doctor, makeEmulator, prepareStart, settings, owner, processOwner };
}
function daemonCalls(f) { return f.calls.spawn.filter((c) => c.args.includes('nodaemon')); }
function assertPrivate(call, port) {
  assert.equal(call.exe, binary);
  assert.deepEqual(call.args.slice(0, 4), ['-H', '127.0.0.1', '-P', String(port)]);
  assert.equal(call.options.env.ANDROID_ADB_SERVER_PORT, String(port));
  assert.equal(call.options.env.ANDROID_ADB_SERVER_ADDRESS, '127.0.0.1');
  assert.equal(call.options.env.ADB_SERVER_SOCKET, undefined);
}

test('child route, AdbClient and doctor reject before explicit initialization', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.helper.route(), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.throws(() => new f.AdbClient({ adbPath: 'adb' }), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.throws(() => f.AdbClient.resolveAdb('adb', ''), { code: 'INSTANCE_ADB_NOT_READY' });
  await assert.rejects(f.doctor.freeAdbPort(), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.equal(f.calls.spawn.length + f.calls.exec.length + f.calls.connect.length, 0);
});
test('parent remains lazy, fixed on legacy 5044 without spawning a server', async (t) => {
  const f = fixture(t, { isChild: false });
  const client = new f.AdbClient({ adbPath: binary });
  f.env.ANDROID_ADB_SERVER_PORT = '55555'; f.env.ADB_SERVER_SOCKET = 'tcp:unrelated:5037';
  await client.exec(['version'], { withSerial: false });
  assert.equal(f.helper.route().port, 5044);
  assert.equal(await f.doctor.freeAdbPort(5037), 5044);
  assert.equal(f.calls.exec[0].options.env.ANDROID_ADB_SERVER_PORT, '5044');
  assert.equal(f.calls.exec[0].options.env.ADB_SERVER_SOCKET, undefined);
  assert.equal(f.calls.spawn.length, 0);
});
test('parent captures an explicit legacy port only once', async (t) => {
  const f = fixture(t, { isChild: false, env: { APKSTART_ADB_PORT: '5049' } });
  assert.equal(f.helper.route().port, 5049);
  f.env.APKSTART_ADB_PORT = '5037';
  assert.equal((await f.helper.initialize()).port, 5049);
});
test('two children request OS port zero, never an ID hash or shared parent port', async (t) => {
  const allocator = { next: 54721 };
  const parent = fixture(t, { isChild: false });
  const a = fixture(t, { allocator, id: 'identical-id' });
  const b = fixture(t, { allocator, id: 'identical-id' });
  const [ra, rb] = await Promise.all([a.init(), b.init()]);
  assert.deepEqual([ra.port, rb.port, parent.helper.route().port], [54721, 54722, 5044]);
  for (const f of [a, b]) assert.deepEqual(f.calls.listen, [{ host: '127.0.0.1', port: 0, exclusive: true }]);
});
test('concurrent/repeated initialization launches once and pins the canonical binary', async (t) => {
  const f = fixture(t);
  const a = f.init({ adbPath: alias }); const b = f.init();
  assert.equal(a, b);
  const route = await a;
  assert(Object.isFrozen(route));
  assert.equal(route.adbPath, binary);
  assert.equal(await f.init({ adbPath: 'relative-ignored-after-init' }), route);
  assert.equal(daemonCalls(f).length, 1);
  assert.deepEqual(daemonCalls(f)[0].args, ['-L', `tcp:localhost:${route.port}`, 'server', 'nodaemon']);
  assert.equal(daemonCalls(f)[0].options.detached, false);
});
test('child exec and persistent input share a fixed binary/route despite env drift', async (t) => {
  const f = fixture(t, { env: { ADB_SERVER_SOCKET: 'tcp:parent:5037', ANDROID_ADB_SERVER_ADDRESS: 'remote', ANDROID_SERIAL: 'parent-device' } });
  const route = await f.init();
  const client = new f.AdbClient({ adbPath: 'other-adb', serial: 'emulator-5554' });
  f.env.ANDROID_ADB_SERVER_PORT = '5044'; f.env.ADB_SERVER_SOCKET = 'tcp:sibling:5044';
  f.env.aDb_SeRvEr_SoCkEt = 'tcp:mixed-case:5037'; f.env.ANDROID_SERIAL = 'sibling';
  client.adbPath = 'mutated-path';
  await client.exec(['devices'], { withSerial: false });
  await client.input('input tap 1 2');
  assertPrivate(f.calls.exec[0], route.port);
  const input = f.calls.spawn.find((c) => c.args.includes('shell'));
  assertPrivate(input, route.port);
  assert.equal(input.options.env.aDb_SeRvEr_SoCkEt, undefined);
  assert.equal(input.options.env.ANDROID_SERIAL, undefined);
  client.disposeInput();
});
test('private daemon disables unsolicited USB/emulator/mDNS discovery', async (t) => {
  const f = fixture(t); await f.init();
  const env = daemonCalls(f)[0].options.env;
  for (const name of ['ADB_USB', 'ADB_EMU', 'ADB_LOCAL_TRANSPORT_MAX_PORT', 'ADB_MDNS', 'ADB_MDNS_AUTO_CONNECT']) assert.equal(env[name], '0');
  assert.equal(env.ADB_REJECT_KILL_SERVER, '1');
  assert.equal(env.ADB_TRACE, 'adb');
});
test('readiness requires this ChildProcess binding trace, not an unrelated listener', async (t) => {
  const f = fixture(t, { behavior: 'silent' });
  const pending = f.init({ timeoutMs: 100 });
  const rejected = assert.rejects(pending, { code: 'INSTANCE_ADB_START_TIMEOUT' });
  await flush();
  assert.throws(() => f.helper.route(), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.equal(f.calls.connect.length, 0);
  await f.time.tick(100); await rejected;
  assert.equal(f.calls.kill.length, 1);
  assert.equal(f.calls.kill[0].proc, daemonCalls(f)[0].proc);
});
test('split binding trace is accepted only while the owned daemon is alive', async (t) => {
  const f = fixture(t, { behavior: 'silent' }); const pending = f.init(); await flush();
  const proc = daemonCalls(f)[0].proc;
  proc.stderr.emit('data', 'adb D main.cpp: Event loop sta');
  assert.throws(() => f.helper.route());
  proc.stderr.emit('data', 'rting\n');
  assert.equal((await pending).adbPath, binary);
});
test('stolen reservation fails closed without kill-server, fallback or reallocation', async (t) => {
  const f = fixture(t, { behavior: 'bind-race' });
  await assert.rejects(f.init(), { code: 'INSTANCE_ADB_EXITED' });
  await assert.rejects(f.init(), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.throws(() => new f.AdbClient({ adbPath: binary }));
  assert.equal(f.calls.listen.length, 1);
  assert.equal(f.calls.kill.length + f.calls.exec.length + f.calls.connect.length, 0);
  assert.equal(f.env.ANDROID_ADB_SERVER_PORT, undefined);
});
test('spawn error and OS reservation errors cannot fall back to PATH or 5044', async (t) => {
  const a = fixture(t, { behavior: 'spawn-error' });
  await assert.rejects(a.init(), { code: 'INSTANCE_ADB_SPAWN_FAILED' });
  assert.throws(() => a.helper.route());
  const b = fixture(t); b.state.reserveError = 'EACCES';
  await assert.rejects(b.init(), { code: 'EACCES' });
  assert.equal(b.calls.spawn.length, 0);
  assert.throws(() => b.helper.route());
});
test('relative or missing child binaries are rejected before any socket/process', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.init({ adbPath: 'adb' }), { code: 'INSTANCE_ADB_BINARY_REQUIRED' });
  await assert.rejects(f.init({ adbPath: 'C:\\missing\\adb.exe' }), { code: 'ENOENT' });
  assert.equal(f.calls.listen.length + f.calls.spawn.length, 0);
});
test('daemon death fences existing exec and already-open input before any dispatch', async (t) => {
  const f = fixture(t); await f.init();
  const client = new f.AdbClient({ adbPath: binary, serial: 'emulator-5554' });
  await client.input('input tap 1 2');
  const before = { exec: f.calls.exec.length, spawn: f.calls.spawn.length, writes: f.calls.writes.length };
  daemonCalls(f)[0].proc.exit(1);
  await assert.rejects(client.exec(['shell', 'input tap 3 4']), { code: 'INSTANCE_ADB_NOT_READY' });
  await assert.rejects(client.input('input tap 3 4'), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.deepEqual({ exec: f.calls.exec.length, spawn: f.calls.spawn.length, writes: f.calls.writes.length }, before);
  client.disposeInput();
});
test('startup ensure is idempotent; explicit repair kills only its own handle on the same route', async (t) => {
  const allocator = { next: 55000 }; const a = fixture(t, { allocator }); const b = fixture(t, { allocator });
  const ra = await a.init(); await b.init();
  await a.helper.ensureServer(); await a.helper.ensureServer();
  assert.equal(daemonCalls(a).length, 1); assert.equal(a.calls.kill.length, 0);
  await a.helper.restartServer();
  assert.equal(a.helper.route(), ra);
  assert.equal(a.calls.kill[0].proc, daemonCalls(a)[0].proc);
  assert.deepEqual(daemonCalls(a)[0].args, daemonCalls(a)[1].args);
  assert.equal(b.calls.kill.length, 0); assert.equal(daemonCalls(b).length, 1);
});
test('repair port theft cannot attach to or kill the new listener', async (t) => {
  const f = fixture(t); const route = await f.init(); f.state.behavior = 'bind-race';
  await assert.rejects(f.helper.restartServer(), { code: 'INSTANCE_ADB_EXITED' });
  assert.throws(() => f.helper.route(), { code: 'INSTANCE_ADB_NOT_READY' });
  assert.equal(f.calls.kill.length, 1);
  assert.equal(f.calls.kill[0].proc, daemonCalls(f)[0].proc);
  assert.equal(f.calls.listen.length, 1);
  assert.equal(f.env.ANDROID_ADB_SERVER_PORT, String(route.port));
  assert.equal(f.calls.exec.length + f.calls.connect.length, 0);
});
test('unconfirmed owned-process termination prevents a replacement daemon', async (t) => {
  const f = fixture(t); await f.init(); f.state.killMode = 'hang';
  const repair = f.helper.restartServer();
  const rejected = assert.rejects(repair, { code: 'INSTANCE_ADB_STOP_TIMEOUT' });
  await f.time.tick(5000); await rejected;
  assert.equal(daemonCalls(f).length, 1);
  assert.throws(() => f.helper.route());
  daemonCalls(f)[0].proc.exit(0);
});
test('dispose cancels startup and terminates only the launched daemon once', async (t) => {
  const f = fixture(t, { behavior: 'silent' }); const pending = f.init();
  const rejected = assert.rejects(pending, { code: 'INSTANCE_ADB_DISPOSED' });
  await flush(); await f.helper.dispose(); await rejected; await f.helper.dispose();
  assert.equal(f.calls.kill.length, 1);
  assert.equal(f.calls.kill[0].proc, daemonCalls(f)[0].proc);
  assert.throws(() => f.helper.route());
  await assert.rejects(f.init(), { code: 'INSTANCE_ADB_DISPOSED' });
});
test('dispose during OS reservation closes it without launching a daemon', async (t) => {
  const f = fixture(t); const pending = f.init();
  const rejected = assert.rejects(pending, { code: 'INSTANCE_ADB_DISPOSED' });
  await f.helper.dispose(); await rejected;
  assert.equal(f.calls.close.length, 1); assert.equal(f.calls.spawn.length, 0);
});
test('parent startup/repair leaves an existing unknown legacy listener untouched', async (t) => {
  const f = fixture(t, { isChild: false }); f.state.reserveError = 'EADDRINUSE';
  await f.helper.ensureServer({ adbPath: binary }); await f.helper.restartServer({ adbPath: binary });
  assert.equal(f.helper.route().port, 5044);
  assert.equal(f.calls.spawn.length + f.calls.exec.length + f.calls.kill.length, 0);
});
test('parent starts an owned foreground server only if the legacy port is free', async (t) => {
  const f = fixture(t, { isChild: false });
  await f.helper.ensureServer({ adbPath: binary }); await f.helper.ensureServer({ adbPath: binary });
  assert.equal(daemonCalls(f).length, 1);
  assert.deepEqual(daemonCalls(f)[0].args, ['-L', 'tcp:localhost:5044', 'server', 'nodaemon']);
  assert.equal(f.calls.exec.length + f.calls.kill.length, 0);
});
test('child clients cannot override route or issue server-control commands', async (t) => {
  const f = fixture(t); await f.init(); const client = new f.AdbClient({ adbPath: binary });
  for (const args of [['kill-server'], ['start-server'], ['-P', '5044', 'devices'], ['-L', 'tcp:5037', 'devices']]) {
    await assert.rejects(client.exec(args), { code: 'INSTANCE_ADB_UNSAFE_COMMAND' });
  }
  assert.equal(f.calls.exec.length, 0);
});
test('targeted registration preserves emulator serial and never needs a reply or scan', async (t) => {
  const f = fixture(t); const route = await f.init(); f.env.ANDROID_ADB_SERVER_PORT = '5044';
  assert.equal(await f.helper.registerEmulator(5555), true);
  assert.deepEqual(f.calls.connect, [{ host: '127.0.0.1', port: route.port }]);
  const request = f.calls.registrations[0].request;
  assert.equal(parseInt(request.slice(0, 4), 16), Buffer.byteLength(request.slice(4)));
  assert.equal(request.slice(4), 'host:emulator:5555');
});
test('registration rechecks ownership after connect before writing any request', async (t) => {
  const f = fixture(t); await f.init(); let checks = 0;
  await assert.rejects(f.helper.registerEmulator(5555, { shouldConnect: () => ++checks === 1 }), { code: 'RUNTIME_OWNERSHIP_LOST' });
  assert.equal(f.calls.registrations.length, 0);
});
test('doctor returns the already-initialized private route regardless of later environment', async (t) => {
  const f = fixture(t); const route = await f.init();
  f.env.APKSTART_ADB_PORT = '5044'; f.env.ANDROID_ADB_SERVER_PORT = '5037';
  assert.equal(await f.doctor.freeAdbPort(5044), route.port);
});
test('emulator env and direct snapshot/health commands all use the pinned private route', async (t) => {
  const f = fixture(t); const route = await f.init(); const emu = f.makeEmulator();
  f.env.ADB_SERVER_SOCKET = 'tcp:sibling:5044'; f.env.ANDROID_ADB_SERVER_PORT = '5044';
  const env = emu.env('C:\\fixture\\runtime', { adbPort: 5037 });
  assert.equal(env.ANDROID_ADB_SERVER_PORT, String(route.port)); assert.equal(env.ADB_SERVER_SOCKET, undefined);
  assert.equal(await emu._saveViaAdb('another-adb.exe'), true);
  assert(f.calls.exec.some((c) => c.args.includes('snapshot')));
  for (const call of f.calls.exec) assertPrivate(call, route.port);
});
test('snapshot and guest shells reject split console/ADB owners before any command', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator(); f.state.adbPid = 9999;
  assert.equal(await emu._saveViaAdb(binary), false);
  await assert.rejects(emu.checkNetwork(), { code: 'RUNTIME_OWNERSHIP_LOST' });
  await assert.rejects(emu.repairWifi(), { code: 'RUNTIME_OWNERSHIP_LOST' });
  assert.equal(f.calls.exec.length, 0);
});
test('network and wifi checks stop immediately if birth changes after their first read', async (t) => {
  for (const name of ['checkNetwork', 'repairWifi']) {
    const f = fixture(t); await f.init(); const emu = f.makeEmulator();
    f.state.execHook = () => { f.state.owner = { ...f.owner, started: 'different-birth' }; return { stdout: '' }; };
    await assert.rejects(emu[name]('external-adb'), { code: 'RUNTIME_OWNERSHIP_LOST' });
    assert.equal(f.calls.exec.length, 1);
    assert(!f.calls.exec[0].args.some((arg) => /forget|set-wifi|input tap/.test(arg)));
  }
});
test('network and wifi calls use the same private binary/route as AdbClient', async (t) => {
  const f = fixture(t); const route = await f.init(); const emu = f.makeEmulator();
  assert.equal((await emu.checkNetwork('unrelated-adb')).ok, true);
  assert.equal((await emu.repairWifi('unrelated-adb')).reason, 'already-connected');
  for (const call of f.calls.exec) assertPrivate(call, route.port);
});
test('emulator repair re-registers only the same birth-pinned owned guest', async (t) => {
  const f = fixture(t); const route = await f.init(); const emu = f.makeEmulator();
  assert.equal(await emu.resetAdbServer(), true);
  assert.equal(f.helper.route(), route);
  assert.equal(f.calls.kill.length, 1);
  assert.equal(f.calls.registrations[0].request.slice(4), 'host:emulator:5555');
  assert.equal(f.calls.exec.length, 0);
});
test('emulator repair refuses unknown guest endpoints without killing any daemon', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator(); f.state.adbPid = 9999;
  await assert.rejects(emu.resetAdbServer(), { code: 'RUNTIME_OWNERSHIP_LOST' });
  assert.equal(f.calls.kill.length + f.calls.registrations.length, 0);
});
test('emulator startup retry ensures but does not restart an alive private server', async (t) => {
  const f = fixture(t); const route = await f.init(); const emu = f.makeEmulator();
  await emu._resetAdbServer(route.port); await emu._resetAdbServer(route.port);
  assert.equal(daemonCalls(f).length, 1); assert.equal(f.calls.kill.length, 0);
  await assert.rejects(emu._resetAdbServer(5044), { code: 'INSTANCE_ADB_ROUTE_CHANGED' });
});
test('ADB readiness failure propagates from actual start before AVD preparation/spawn', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator(); f.prepareStart(emu);
  let avd = 0; let spawn = 0;
  emu.ensureAvd = () => { avd += 1; return { ok: true }; };
  emu.spawnOnce = () => { spawn += 1; };
  f.helper.ensureServer = async () => false;
  const result = await emu.start();
  assert.equal(result.ok, false); assert.equal(result.code, 'INSTANCE_ADB_START_FAILED');
  assert.equal(result.attempts[0].stage, 'adb'); assert.equal(avd + spawn, 0);
});
test('a full 600-entry log ring retains current operational evidence in actual start', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator();
  for (let i = 0; i < 600; i += 1) emu.log(`old-${i}`);
  const boundary = emu._logSeq;
  f.prepareStart(emu, { rounds: [['WHPX is operational']] });
  const result = await emu.start();
  assert.equal(result.ok, true); assert.equal(result.profile.acceleration.confirmed, true);
  assert.equal(emu._log.length, 600);
  assert.deepEqual([...emu._attemptLines(boundary, 600)], ['WHPX is operational']);
});
test('empty current attempts cannot borrow earlier operational or crash lines', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator();
  emu.log('WHPX is operational'); emu.log('emulator exit 3221225477');
  for (let i = 0; i < 598; i += 1) emu.log(`old-${i}`);
  const boundary = emu._logSeq; f.prepareStart(emu);
  const result = await emu.start();
  assert.equal(result.profile.acceleration.confirmed, null);
  assert.deepEqual([...emu._attemptLines(boundary)], []);
});
test('retry evidence is per-attempt even while the ring shifts at capacity', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator();
  for (let i = 0; i < 600; i += 1) emu.log(`old-${i}`);
  f.prepareStart(emu, { rounds: [['WHPX is operational'], []], dead: [true, false] });
  const result = await emu.start();
  assert.equal(result.ok, true); assert.equal(result.attempts[0].acceleration.confirmed, true);
  assert.equal(result.profile.acceleration.confirmed, null);
});
test('probe completion and spawn-error summaries use the same monotonic log boundary', async (t) => {
  const f = fixture(t); await f.init(); const emu = f.makeEmulator();
  for (let i = 0; i < 600; i += 1) emu.log(`old-${i}`);
  f.prepareStart(emu);
  const result = await emu.start({ probe: async () => { emu.log('WHPX is operational'); return 'ok'; } });
  assert.equal(result.profile.acceleration.confirmed, true);
  const boundary = emu._logSeq;
  emu.log('AEHD is operational');
  emu._recordSpawnError({ plan: { accel: 'auto' }, logStart: boundary, error: new Error('fixture failure') });
  const attempt = emu.attempts.at(-1);
  assert.equal(attempt.acceleration.confirmed, true);
  assert.equal(attempt.acceleration.evidence, 'AEHD is operational');
});

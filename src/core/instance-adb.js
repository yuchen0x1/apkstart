'use strict';
// One process, one immutable ADB route. Child instances never borrow a listener
// by port number and never run adb kill-server/start-server (including repair).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const context = require('./instance-context').current();

let binding = null;
let owned = null;
let initializing = null;
let restarting = null;
let disposed = false;
let phase = 'uninitialized';
let cancelStart = null;

function fault(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}
function legacyBinding() {
  if (!binding) {
    binding = Object.freeze({
      isChild: false,
      port: validPort(process.env.APKSTART_ADB_PORT) || validPort(process.env.ANDROID_ADB_SERVER_PORT) || 5044,
      adbPath: '',
    });
  }
  return binding;
}
function live(record) {
  return !!record && !record.exited && record.proc.exitCode == null
    && record.proc.signalCode == null && !record.proc.killed;
}
function route() {
  if (!context.isChild) return legacyBinding();
  if (disposed || phase !== 'ready' || !live(owned)) {
    throw fault('INSTANCE_ADB_NOT_READY', '分身私有 ADB 尚未初始化或已退出，已拒绝回退到其他 ADB 服务');
  }
  return binding;
}
function assertReady(captured) {
  if (!context.isChild) return;
  if (captured !== binding || route() !== captured) {
    throw fault('INSTANCE_ADB_ROUTE_CHANGED', '分身 ADB 路由不匹配');
  }
}

const ROUTING_KEYS = new Set([
  'ADB_SERVER_SOCKET', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT',
  'ADB_SERVER_PORT', 'ADB_SERVER_HOST', 'APKSTART_ADB_PORT', 'ANDROID_SERIAL', 'ANDROID_DEVICE_ID',
]);
function cleanEnvironment(source) {
  const env = { ...source };
  // Windows environment names are case insensitive. Remove mixed-case aliases too.
  for (const key of Object.keys(env)) if (ROUTING_KEYS.has(key.toUpperCase())) delete env[key];
  return env;
}
function serverEnvironment(target, source = process.env) {
  const env = cleanEnvironment(source);
  env.ANDROID_ADB_SERVER_ADDRESS = '127.0.0.1';
  env.ANDROID_ADB_SERVER_PORT = String(target.port);
  if (target.isChild) {
    // No USB/mDNS/emulator scanning that could register a parent or sibling guest.
    env.ADB_USB = '0';
    env.ADB_EMU = '0';
    env.ADB_LOCAL_TRANSPORT_MAX_PORT = '0';
    env.ADB_MDNS = '0';
    env.ADB_MDNS_AUTO_CONNECT = '0';
    env.ADB_REJECT_KILL_SERVER = '1';
  }
  return env;
}
function environment(captured = route(), source = process.env) {
  assertReady(captured);
  return serverEnvironment(captured, source);
}
function executable(requested, captured = route()) {
  assertReady(captured);
  // An older adb client may auto-kill a server on version mismatch. Every child
  // command uses the very same executable as the foreground server, never PATH.
  return captured.isChild ? captured.adbPath : requested;
}
function clientArgs(args, captured = route()) {
  assertReady(captured);
  if (!captured.isChild) return [...args];
  if (args.some((arg) => ['-H', '-P', '-L', 'kill-server', 'start-server', 'server', 'nodaemon', 'fork-server'].includes(arg))) {
    throw fault('INSTANCE_ADB_UNSAFE_COMMAND', '分身 ADB 不允许覆盖路由或通过客户端重启/终止服务');
  }
  return ['-H', '127.0.0.1', '-P', String(captured.port), ...args];
}
function publish(target) {
  for (const key of Object.keys(process.env)) if (ROUTING_KEYS.has(key.toUpperCase())) delete process.env[key];
  process.env.ANDROID_ADB_SERVER_ADDRESS = '127.0.0.1';
  process.env.ANDROID_ADB_SERVER_PORT = String(target.port);
}

function reservePort(requested = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: requested, exclusive: true }, () => {
      const port = validPort(server.address()?.port);
      if (!port) { server.close(); reject(fault('INSTANCE_ADB_RESERVE_FAILED', '无法申请私有 ADB 端口')); return; }
      resolve({ server, port });
    });
  });
}
function closeReservation(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function stopOwned(record, timeoutMs = 5000) {
  if (!record || record.exited || record.proc.exitCode != null || record.proc.signalCode != null) return Promise.resolve();
  if (record.stopping) return record.stopping;
  record.stopping = new Promise((resolve, reject) => {
    let timer;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      record.proc.removeListener('exit', exited);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    record.proc.once('exit', exited);
    timer = setTimeout(() => finish(fault('INSTANCE_ADB_STOP_TIMEOUT', '自有 ADB 进程未确认退出，拒绝重用其端口')), timeoutMs);
    try {
      // Only this launch's ChildProcess handle is authority. No PID lookup, port
      // owner guess, taskkill, adb kill-server, or fallback termination command.
      if (!record.proc.killed && !record.proc.kill('SIGTERM')) finish(fault('INSTANCE_ADB_STOP_FAILED', '无法停止自有 ADB 进程'));
    } catch (error) { finish(error); }
  });
  return record.stopping;
}
function startOwned(target, timeoutMs) {
  phase = 'starting';
  return new Promise((resolve, reject) => {
    let record;
    let timer;
    let settled = false;
    let output = '';
    let specIndex = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelStart = null;
      if (error) { phase = 'failed'; reject(error); }
      else { phase = 'ready'; resolve(target); }
    };
    // AOSP client/commandline.cpp accepts `-L SOCKET server nodaemon`, but which
    // loopback spellings are accepted has changed between adb versions:
    // `tcp:127.0.0.1:<port>` is rejected outright, and a few builds also refuse
    // `tcp:localhost:<port>` while accepting the bare `tcp:<port>` form. Both
    // candidates bind loopback only, so try them in order on the SAME port and
    // only when the failure is that explicit listener refusal. Any other failure
    // (bind race, spawn error, timeout) still fails closed on the first attempt.
    const specs = [`tcp:localhost:${target.port}`, `tcp:${target.port}`];
    const spawnAttempt = () => {
      // A superseded attempt must not keep a deadline that could fail the retry.
      clearTimeout(timer);
      try {
        const env = serverEnvironment(target);
        // --reply-fd is a Windows HANDLE, not a Node stdio index: don't fake fd 3.
        // With ADB_TRACE=adb, client/main.cpp emits this process's "Event loop
        // starting" only AFTER install_listener succeeds. An unrelated open port
        // is never sufficient readiness evidence. Bind races therefore fail closed.
        env.ADB_TRACE = 'adb';
        output = '';
        const proc = spawn(target.adbPath, ['-L', specs[specIndex], 'server', 'nodaemon'], {
          cwd: path.dirname(target.adbPath), env, windowsHide: true,
          detached: false, stdio: ['ignore', 'pipe', 'pipe'],
        });
        record = { proc, exited: false };
        owned = record;
        proc.once('exit', (code, signal) => {
          record.exited = true;
          // Only an explicit "listener spec unsupported" refusal may fall back;
          // the next spec must be the only difference.
          const unsupported = /could not install \*?smartsocket\*? listener[\s\S]*hostname currently unsupported/i.test(output);
          if (unsupported && specIndex + 1 < specs.length && !disposed && owned === record) {
            specIndex += 1;
            record = null;
            spawnAttempt();
            return;
          }
          if (owned === record) phase = disposed ? 'disposed' : 'failed';
          finish(fault('INSTANCE_ADB_EXITED', `私有 ADB 在确认就绪前退出（${signal || code}）：${output.slice(-800)}`));
        });
        proc.once('error', (error) => {
          if (!proc.pid) record.exited = true;
          if (owned === record) phase = disposed ? 'disposed' : 'failed';
          finish(fault('INSTANCE_ADB_SPAWN_FAILED', `无法启动私有 ADB：${error.message}`));
        });
        const consume = (chunk) => {
          output = (output + String(chunk)).slice(-8192);
          if (!disposed && live(record) && /\bEvent loop starting\b/.test(output)) finish();
        };
        proc.stdout.on('data', consume);
        proc.stderr.on('data', consume);
        cancelStart = () => finish(fault('INSTANCE_ADB_DISPOSED', '私有 ADB 初始化已取消'));
        timer = setTimeout(() => finish(fault('INSTANCE_ADB_START_TIMEOUT', `私有 ADB 未确认绑定成功：${output.slice(-800)}`)), timeoutMs);
        if (disposed) cancelStart();
      } catch (error) { finish(error); }
    };
    spawnAttempt();
  });
}

function initialize({ adbPath = '', timeoutMs = 15000 } = {}) {
  if (disposed) return Promise.reject(fault('INSTANCE_ADB_DISPOSED', '私有 ADB 已释放'));
  if (!context.isChild) { const target = legacyBinding(); publish(target); return Promise.resolve(target); }
  if (initializing) return initializing;
  if (binding) return Promise.resolve().then(() => route());
  initializing = (async () => {
    if (!path.isAbsolute(adbPath) || !fs.statSync(adbPath).isFile()) {
      throw fault('INSTANCE_ADB_BINARY_REQUIRED', '分身需要已部署运行时内的绝对 ADB 路径');
    }
    const binary = fs.realpathSync(adbPath);
    const reserved = await reservePort();
    try {
      if (disposed) throw fault('INSTANCE_ADB_DISPOSED', '私有 ADB 初始化已取消');
      // Do not expose a route until the daemon proves it bound this port.
      const target = Object.freeze({ isChild: true, port: reserved.port, adbPath: binary });
      binding = target; // Fixed even if bind/startup fails; never silently select a replacement route.
      await closeReservation(reserved.server);
      if (disposed) throw fault('INSTANCE_ADB_DISPOSED', '私有 ADB 初始化已取消');
      try { await startOwned(target, timeoutMs); }
      catch (error) { await stopOwned(owned).catch(() => {}); throw error; }
      if (disposed) throw fault('INSTANCE_ADB_DISPOSED', '私有 ADB 初始化已取消');
      const ready = route(); // Recheck death/dispose races before exposing the route.
      publish(ready);
      return ready;
    } catch (error) {
      try { if (reserved.server.listening) await closeReservation(reserved.server); } catch (_) { /* reservation only */ }
      throw error;
    }
  })();
  initializing = initializing.finally(() => { initializing = null; });
  return initializing;
}
function ensureServer({ adbPath = '', timeoutMs = 15000 } = {}) {
  if (context.isChild) return Promise.resolve().then(() => route());
  if (disposed) return Promise.reject(fault('INSTANCE_ADB_DISPOSED', 'ADB 已释放'));
  if (initializing) return initializing;
  const target = legacyBinding();
  if (live(owned)) return Promise.resolve(target);
  initializing = (async () => {
    let reserved;
    try { reserved = await reservePort(target.port); }
    catch (error) {
      // Legacy 5044 may already have a daemon from an earlier parent. Preserve
      // compatibility without sending any client command that might auto-kill it
      // on version mismatch. An unknown listener is NEVER repair authority.
      if (error.code === 'EADDRINUSE') return target;
      throw error;
    }
    try {
      if (disposed) throw fault('INSTANCE_ADB_DISPOSED', 'ADB 已释放');
      if (!path.isAbsolute(adbPath) || !fs.statSync(adbPath).isFile()) {
        throw fault('INSTANCE_ADB_BINARY_REQUIRED', '启动 ADB 需要已部署运行时的绝对路径');
      }
      const serverTarget = Object.freeze({ ...target, adbPath: fs.realpathSync(adbPath) });
      await closeReservation(reserved.server);
      if (disposed) throw fault('INSTANCE_ADB_DISPOSED', 'ADB 已释放');
      try { await startOwned(serverTarget, timeoutMs); }
      catch (error) { await stopOwned(owned).catch(() => {}); throw error; }
      return target;
    } finally {
      if (reserved.server.listening) await closeReservation(reserved.server);
    }
  })().finally(() => { initializing = null; });
  return initializing;
}
function restartServer({ timeoutMs = 15000, adbPath = '' } = {}) {
  if (!context.isChild) return ensureServer({ adbPath, timeoutMs });
  if (restarting) return restarting;
  if (!binding || disposed || initializing) return Promise.reject(fault('INSTANCE_ADB_NOT_READY', '私有 ADB 未初始化或已释放'));
  restarting = (async () => {
    phase = 'restarting';
    await stopOwned(owned);
    if (disposed) throw fault('INSTANCE_ADB_DISPOSED', '私有 ADB 已释放');
    try { await startOwned(binding, timeoutMs); }
    catch (error) { await stopOwned(owned).catch(() => {}); throw error; }
    publish(binding);
    return route();
  })().finally(() => { restarting = null; });
  return restarting;
}
async function registerEmulator(adbPort, { shouldConnect = () => true, timeoutMs = 3000 } = {}) {
  if (!validPort(adbPort)) throw fault('INSTANCE_ADB_GUEST_PORT', '无效的客机 ADB 端口');
  const captured = route();
  if (!(await shouldConnect())) throw fault('RUNTIME_OWNERSHIP_LOST', '客机归属已变化，拒绝注册');
  assertReady(captured);
  return new Promise((resolve, reject) => {
    let socket;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      if (socket) socket.destroy();
      if (error) reject(error); else resolve(true);
    };
    try {
      socket = net.connect({ host: '127.0.0.1', port: captured.port });
      socket.setTimeout(timeoutMs, () => finish(fault('INSTANCE_ADB_REGISTER_TIMEOUT', '客机 ADB 注册超时')));
      socket.once('error', finish);
      socket.once('close', () => { if (!done) finish(fault('INSTANCE_ADB_REGISTER_CLOSED', '客机 ADB 注册连接已关闭')); });
      socket.once('connect', async () => {
        try {
          if (done || !(await shouldConnect())) throw fault('RUNTIME_OWNERSHIP_LOST', '客机归属已变化，拒绝注册');
          assertReady(captured);
          // AOSP host:emulator takes the guest's ADB port, retains emulator-N
          // serial and intentionally sends NO reply. This only queues a targeted
          // registration; Runtime's identity/health probe still proves readiness.
          const service = `host:emulator:${adbPort}`;
          const request = `${Buffer.byteLength(service).toString(16).padStart(4, '0')}${service}`;
          if (!done) socket.end(request, () => finish());
        } catch (error) { finish(error); }
      });
    } catch (error) { finish(error); }
  });
}
async function dispose() {
  disposed = true;
  phase = 'disposed';
  if (cancelStart) cancelStart();
  await stopOwned(owned);
  if (initializing) await initializing.catch(() => {});
  if (restarting) await restarting.catch(() => {});
  phase = 'disposed';
}

module.exports = { initialize, dispose, route, assertReady, environment, executable, clientArgs, ensureServer, restartServer, registerEmulator };

'use strict';
/**
 * QEMU 后端：为 Bliss OS / Android-x86 等 x86 ISO 系统提供独立的虚拟机能力。
 * ------------------------------------------------------------------
 * 与 engine.js 的 legacy QEMU 路径分开，避免污染现有 Google/AOSP emulator 流程。
 * 关键语义（不得混淆）：
 *   - spawn 成功 = 虚拟机进程已启动；
 *   - adb shell 'getprop sys.boot_completed' === 1 = Android 系统真正就绪；
 *   两者分别返回，system-manager 必须等到后者才算"启动成功"。
 *
 * 硬件加速：优先 WHPX（-machine q35,accel=whpx），不可用时明确降级为 TCG 并记录提示。
 * 不修改任何 Windows 安全设置。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { isDeepStrictEqual } = require('util');
const { setTimeout: delay } = require('timers/promises');
const { AdbClient } = require('../adb');
const peripherals = require('../peripherals');

const MONITOR_PORT_BASE = 5580;
const cancelled = () => ({ ok: false, code: 'START_CANCELLED', error: 'QEMU 启动已取消' });

function untilAborted(signal, run) {
  if (signal.aborted) return Promise.resolve(cancelled());
  let abort;
  const stopped = new Promise((resolve) => {
    abort = () => resolve(cancelled());
    signal.addEventListener('abort', abort, { once: true });
  });
  const pending = Promise.resolve().then(() => signal.aborted ? cancelled() : run());
  return Promise.race([stopped, pending]).finally(() => signal.removeEventListener('abort', abort));
}

/** 绑定并立即释放一个 loopback 端口，返回实际端口。 */
function probePort(port, netModule = net) {
  return new Promise((resolve) => {
    let settled = false;
    let server;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      server = netModule.createServer();
      server.once('error', () => finish({ ok: false, port: 0 }));
      server.once('listening', () => {
        let actual = Number(port) || 0;
        try {
          const address = server.address();
          if (address && typeof address === 'object') actual = Number(address.port) || actual;
        } catch (_) {}
        try {
          server.close(() => finish({ ok: true, port: actual }));
        } catch (_) { finish({ ok: true, port: actual }); }
      });
      server.listen({ host: '127.0.0.1', port: Number(port) || 0 });
    } catch (_) {
      finish({ ok: false, port: 0 });
    }
  });
}

class QemuBackend {
  constructor(opts = {}) {
    this.provisioner = opts.provisioner || null;
    this.settingsFn = opts.settingsFn || (() => ({}));
    this.onLog = opts.onLog || (() => {});
    this.systemId = opts.systemId || 'qemu-system';
    this.proc = null;
    this.adbPort = 0;
    this.monitorPort = 0;
    this._procState = null;
    this._ownerToken = '';
    this._serial = 0;
    this._generation = 0;
    this._startOp = null;
    this._stopPromise = null;
    this._lifecycle = null;

    // 注入点只用于隔离测试；默认仍使用真实 child_process/net。
    this._spawn = opts.spawnFn || spawn;
    this._net = opts.net || net;
    this._portProbe = opts.portProbe || null;
    this._adbClientFactory = opts.adbClientFactory || ((o) => new AdbClient(o));
  }

  log(msg) { try { this.onLog(String(msg)); } catch (_) {} }

  get settings() { return this.settingsFn(); }

  /** 探测 WHPX 是否可用（复用 provision 的权威检测） */
  async accelInfo() {
    let whpx = false;
    let note = '';
    if (this.provisioner) {
      try {
        const a = await this.provisioner.emulatorAccel();
        whpx = !!(a && a.ok && (a.kind === 'whpx' || a.whpx));
        note = (a && a.note) || '';
      } catch (_) {}
      if (!whpx) {
        try {
          const hv = await this.provisioner.hypervisor();
          whpx = !!(hv && hv.dll && hv.hypervisorPresent);
          note = note || (hv && hv.note) || '';
        } catch (_) {}
      }
    }
    if (!whpx) {
      note = note || '未检测到 WHPX 硬件加速：将使用纯软件模拟（TCG），性能会显著下降。请在「启用或关闭 Windows 功能」中勾选「虚拟机平台」并重启。';
      this.log(note);
    }
    return { whpx, note };
  }

  /** 找 qemu-system-x86_64.exe */
  qemuExe() {
    const p = this.provisioner ? this.provisioner.paths() : {};
    const candidates = [
      p.qemuExe,
      this.settings.runtime && this.settings.runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    return '';
  }

  ovmfFirmware() {
    // QEMU Windows 安装包通常带 OVMF.fd；找不到时退回 SeaBIOS（legacy）。
    const candidates = [
      path.join(path.dirname(this.qemuExe() || ''), 'share', 'ovmf', 'OVMF.fd'),
      'C:\\Program Files\\qemu\\share\\ovmf\\OVMF.fd',
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    return '';
  }

  /**
   * 构建 QEMU 参数：q35 + WHPX/TCG + virtio 磁盘/网卡 + USB 平板/键盘 + adb hostfwd。
   * 外围设备参数由 peripherals 模块严格校验；空配置不添加任何摄像头/串口设备。
   * @param {object} o { disk, iso, install, memoryMB, cores, adbPort, monitorPort, uefi, display, peripherals }
   */
  buildArgs(o = {}) {
    const accelInfo = o.accel || { whpx: false };
    const accel = accelInfo.whpx ? 'whpx' : 'tcg';
    const cpu = accelInfo.whpx ? 'host' : 'max';
    const mem = Math.max(1024, Number(o.memoryMB) || 4096);
    const smp = Math.max(1, Number(o.cores) || 4);
    // 直接调用 buildArgs 的旧调用方仍得到原来的默认值；真实启动由 startVM 先选端口。
    const adbPort = Number(o.adbPort) || 5555;
    const monitorPort = Number(o.monitorPort) || MONITOR_PORT_BASE;

    const args = [
      '-name', `ApkStart-${this.systemId}`,
      '-machine', `q35,accel=${accel}`,
      '-cpu', cpu,
      '-smp', String(smp),
      '-m', String(mem),
      '-rtc', 'base=localtime',
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${adbPort}-:5555`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-usb',
      '-device', 'usb-tablet',
      '-device', 'usb-kbd',
      '-monitor', `tcp:127.0.0.1:${monitorPort},server,nowait`,
      '-device', ['AC97', 'audiodev=snd0'].join(','),
      '-audiodev', ['sdl', 'id=snd0'].join(','),
    ];

    // 读取显式传入的启动配置，否则读取同一份 settings.peripherals。
    // buildQemuArgs 对未支持的摄像头/刷新率抛出明确错误，不能静默丢弃。
    const configuredPeripherals = o.peripherals !== undefined
      ? o.peripherals
      : ((this.settings && this.settings.peripherals) || undefined);
    args.push(...peripherals.buildQemuArgs(configuredPeripherals, {
      backend: 'qemu',
      serialId: o.serialId,
    }));

    if (o.display === 'none') args.push('-display', 'none');

    const firmware = this.ovmfFirmware();
    if (o.uefi !== false && firmware) args.push('-drive', `if=pflash,format=raw,readonly=on,file=${firmware}`);

    if (o.install && o.iso) {
      args.push('-boot', 'order=d', '-cdrom', o.iso);
    } else {
      args.push('-boot', 'order=c');
    }
    if (o.disk) args.push('-drive', `file=${o.disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async _probe(port) {
    if (this._portProbe) {
      const result = await this._portProbe(Number(port) || 0);
      if (typeof result === 'number') return { ok: result > 0, port: result };
      if (result && typeof result === 'object') return { ok: !!result.ok, port: Number(result.port) || 0 };
      return { ok: result === true, port: Number(port) || 0 };
    }
    return probePort(Number(port) || 0, this._net);
  }

  async _pickPort(preferred, excluded, signal) {
    const wanted = Number(preferred) || 0;
    // 0 asks the OS for an unused loopback port, avoiding a fixed 5555/5580 pair.
    // 重试 ephemeral 选择，避免两个连续探测被 OS 分配到同一已选端口。
    for (let attempt = 0; attempt < 16; attempt += 1) {
      signal.throwIfAborted();
      const candidate = attempt === 0 && wanted > 0 ? wanted : 0;
      const result = await this._probe(candidate);
      signal.throwIfAborted();
      const port = Number(result && result.port) || (candidate > 0 ? candidate : 0);
      if (result && result.ok && port > 0 && !excluded.has(port)) return port;
    }
    throw new Error('没有可用的 loopback 端口');
  }

  async _allocatePorts(opts, signal) {
    const used = new Set();
    const adbPort = await this._pickPort(opts.adbPort || 5555, used, signal);
    used.add(adbPort);
    const monitorPort = await this._pickPort(opts.monitorPort || MONITOR_PORT_BASE, used, signal);
    return { adbPort, monitorPort };
  }

  _clearProcess(child) {
    if (this.proc !== child) return;
    if (this._procState) {
      this._procState.exited = true;
      this._procState.readyController.abort();
    }
    this.proc = null;
    this.adbPort = 0;
    this.monitorPort = 0;
    this._ownerToken = '';
  }

  _markExited(child) {
    this._clearProcess(child);
  }

  /** 当前后端实际拥有的进程与端口；不返回其它实例的端口。 */
  getEndpoints() {
    if (!this.proc || !this._procState || this._procState.exited) return null;
    return {
      pid: this.proc.pid || 0,
      adbPort: this.adbPort,
      monitorPort: this.monitorPort,
      ownerToken: this._ownerToken,
    };
  }

  isStarting() { return !!this._startOp; }

  /** 同一启动复用 Promise；参数不同的请求不能偷换正在分配端口的启动。 */
  startVM(opts = {}) {
    if (this._stopPromise) return Promise.resolve({ ok: false, error: 'QEMU 正在停止' });
    if (this._startOp) {
      return isDeepStrictEqual(this._startOp.opts, opts) ? this._startOp.promise
        : Promise.resolve({ ok: false, code: 'START_BUSY', error: '另一组 QEMU 启动参数正在使用' });
    }
    if (this.proc) {
      return Promise.resolve(Object.assign({ ok: false, error: 'QEMU 实例已由当前后端启动', vmStarted: true }, this.getEndpoints()));
    }
    const controller = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const op = { generation: ++this._generation, opts: { ...opts }, controller, signal };
    this._startOp = op;
    this._lifecycle = op;
    const promise = Promise.resolve().then(() => this._startVM(op)).catch((e) => ({ ok: false, error: e.message }));
    op.promise = promise;
    const clear = () => { if (this._startOp === op) this._startOp = null; };
    promise.then(clear, clear);
    return promise;
  }

  async _startVM(op) {
    const { opts, signal } = op;
    const valid = () => !signal.aborted && this._lifecycle === op && this._generation === op.generation;
    const ports = await untilAborted(signal, () => this._allocatePorts(opts, signal));
    if (!valid()) return cancelled();
    const exe = this.qemuExe();
    if (!exe) return { ok: false, error: '未安装 QEMU，请先在设置中安装运行时。' };
    const args = this.buildArgs(Object.assign({}, opts, ports));
    this.log('QEMU: ' + exe + ' ' + args.join(' '));
    if (!valid()) return cancelled();
    return new Promise((resolve) => {
      let child;
      let timer;
      let settled = false;
      let stderr = '';
      const ownerToken = `${this.systemId}:${Date.now()}:${++this._serial}`;
      const finish = (ok, error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve({ ok, error: error || '', code, pid: child && child.pid || 0, ...ports, ownerToken });
      };
      const abort = () => finish(false, 'QEMU 启动已取消', 'START_CANCELLED');
      try {
        // No await between the last fence and retaining the handle.
        child = this._spawn(exe, args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = child;
        this.adbPort = ports.adbPort;
        this.monitorPort = ports.monitorPort;
        this._ownerToken = ownerToken;
        this._procState = { exited: false, readyController: new AbortController() };
        const exited = (code) => {
          this._markExited(child);
          finish(false, 'QEMU 进程提前退出（code ' + code + '）：' + stderr.slice(-500));
        };
        child.on('exit', exited);
        child.on('close', exited);
        child.on('error', (e) => {
          // kill() can emit error on a still-live process. Only failed spawn is terminal.
          if (!child.pid) this._markExited(child);
          finish(false, e.message);
        });
        if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (b) => {
          const text = b.toString();
          stderr = (stderr + text).slice(-10000);
          this.log('QEMU: ' + text.trim());
        });
        signal.addEventListener('abort', abort, { once: true });
        if (!valid()) return abort();
        const grace = Number.isFinite(Number(opts.startupGraceMs)) ? Math.max(0, Number(opts.startupGraceMs)) : 1500;
        timer = setTimeout(() => {
          if (!valid()) return abort();
          finish(this.proc === child && this.running(), '');
        }, grace);
      } catch (e) {
        // A setup error after spawn is not proof of exit: retain the owned handle.
        finish(false, e.message);
      }
    });
  }

  /** ADB success is tied to the exact process generation, never just a reusable port. */
  async waitAndroidReady({ adbPath, adbPort, ownerToken, signal, timeoutMs = 180000, onProgress } = {}) {
    const child = this.proc;
    const lifecycle = this._lifecycle;
    const state = this._procState;
    const endpoints = this.getEndpoints();
    if (!child || !endpoints || !lifecycle) return { ok: false, code: 'NOT_OWNER', error: '没有归属的 QEMU 实例' };
    const port = Number(adbPort) || endpoints.adbPort;
    if (port !== endpoints.adbPort || ownerToken && ownerToken !== endpoints.ownerToken) {
      return { ok: false, code: 'NOT_OWNER', error: 'ADB 端口不属于当前 QEMU 实例' };
    }
    if (this._stopPromise) return cancelled();
    const processSignal = state.readyController.signal;
    const waitSignal = signal ? AbortSignal.any([signal, processSignal]) : processSignal;
    if (waitSignal.aborted) return cancelled();
    const valid = () => !waitSignal.aborted && this.proc === child && this._lifecycle === lifecycle
      && this._generation === lifecycle.generation && this._ownerToken === endpoints.ownerToken && this.running();
    const client = this._adbClientFactory({ adbPath, serial: `127.0.0.1:${port}` });
    const start = Date.now();
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(2147483647, Math.round(Number(timeoutMs) || 1))));
    const probeSignal = AbortSignal.any([waitSignal, deadline]);
    const result = await untilAborted(probeSignal, async () => {
      let last = 0;
      while (valid() && !deadline.aborted) {
        try {
          await client.connect().catch(() => false);
          if (!valid() || deadline.aborted) break;
          const online = await client.isOnline();
          if (!valid() || deadline.aborted) break;
          if (online) {
            const out = String(await client.shell('getprop sys.boot_completed', { timeout: 8000 })).trim();
            if (!valid() || deadline.aborted) break;
            if (out.split(/\r?\n/)[0].trim() === '1') {
              return { ok: true, serial: client.serial, adbPort: port, ownerToken: endpoints.ownerToken, elapsedMs: Date.now() - start };
            }
          }
        } catch (_) {}
        if (!valid() || deadline.aborted) break;
        const elapsed = Date.now() - start;
        if (onProgress && elapsed - last > 5000) {
          last = elapsed;
          onProgress({ elapsedMs: elapsed, phase: 'waiting-android', adbPort: port });
        }
        await delay(2000, undefined, { signal: probeSignal }).catch(() => {});
      }
      return cancelled();
    });
    if (!valid()) return cancelled();
    if (result.ok) return result;
    return { ok: false, error: `QEMU 虚拟机已启动，但等待 Android 系统就绪超时（主机转发端口 ${port}）。`,
      serial: client.serial, adbPort: port };
  }

  _sendMonitor(port, timeoutMs = 1500, isOwned = () => true) {
    return new Promise((resolve) => {
      let settled = false;
      let sock;
      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        try { if (sock && typeof sock.destroy === 'function') sock.destroy(); } catch (_) {}
        resolve({ ok, error: error || '' });
      };
      try {
        sock = this._net.connect(port, '127.0.0.1', () => {
          if (!isOwned()) return finish(false, 'QEMU 实例已退出');
          try {
            sock.write('system_powerdown\n');
            setTimeout(() => {
              try { if (typeof sock.end === 'function') sock.end(); } catch (_) {}
              finish(true);
            }, 300);
          } catch (e) { finish(false, e.message); }
        });
        if (sock && typeof sock.on === 'function') sock.on('error', (e) => finish(false, e.message));
        if (sock && typeof sock.setTimeout === 'function') sock.setTimeout(timeoutMs, () => finish(false, 'monitor 超时'));
      } catch (e) { finish(false, e.message); }
    });
  }

  _waitForExit(child, state, timeoutMs) {
    if (state && state.exited) return Promise.resolve(true);
    if (!state || this.proc !== child) return Promise.resolve(false);
    if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode) {
      this._markExited(child);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof child.removeListener === 'function') {
          child.removeListener('exit', onExit);
          child.removeListener('close', onExit);
        }
        resolve(ok);
      };
      const onExit = () => { this._markExited(child); done(true); };
      if (typeof child.on !== 'function') return done(false);
      child.on('exit', onExit);
      child.on('close', onExit);
      timer = setTimeout(() => done(false), Math.max(0, Number(timeoutMs) || 0));
    });
  }

  stop(opts = {}) {
    const op = this._startOp;
    const child = this.proc;
    const state = this._procState;
    const endpoints = this.getEndpoints();
    if ((opts.ownerToken && opts.ownerToken !== endpoints?.ownerToken)
        || (opts.monitorPort && Number(opts.monitorPort) !== endpoints?.monitorPort)) {
      return Promise.resolve({ ok: false, error: 'QEMU 实例归属令牌或 monitor 端口不匹配', code: 'NOT_OWNER' });
    }
    if (this._stopPromise) return this._stopPromise;
    // 无句柄、无启动操作时，绝不按常量端口猜测并停止其它实例。
    if (!endpoints && !op) {
      return Promise.resolve({ ok: false, error: '没有由当前 QEMU 后端归属的运行实例', code: 'NOT_OWNER' });
    }
    const promise = Promise.resolve().then(async () => {
      if (op) await op.promise;
      // The cancellation fence prevents a port allocation from spawning later.
      if (!child) return { ok: true, running: false };
      return this._stopVM(child, state, endpoints, opts);
    });
    this._stopPromise = promise;
    if (op) op.controller.abort();
    if (state) state.readyController.abort();
    const clear = () => {
      if (this._stopPromise !== promise) return;
      // A failed stop leaves the exact process available for a new readiness attempt.
      if (this.proc === child && state && !state.exited) state.readyController = new AbortController();
      this._stopPromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  async _stopVM(child, state, endpoints, opts) {
    const owns = () => this.proc === child && !state.exited;
    if (owns()) {
      // 只对本次 startVM 记录的 monitor 端口发命令，永不回退到 5580。
      await this._sendMonitor(endpoints.monitorPort, opts.monitorTimeoutMs ?? 1500, owns).catch(() => {});
    }
    let exited = await this._waitForExit(child, state, opts.graceTimeoutMs ?? 1500);
    let killError = '';
    if (!exited && owns()) {
      try {
        if (typeof child.kill !== 'function') throw new Error('QEMU 进程没有可用的 kill 句柄');
        child.kill();
      } catch (e) { killError = e.message; }
      exited = await this._waitForExit(child, state, opts.killTimeoutMs ?? 1500);
    }
    // 未观察到 exit/close 前保留 proc 与端口，不能把“发出了 kill”谎报为成功。
    return exited ? { ok: true, ...endpoints }
      : { ok: false, ...endpoints, code: 'EXIT_NOT_CONFIRMED', error: killError || 'QEMU 进程未确认退出，已保留运行句柄' };
  }

  running() {
    return !!(this.proc && this._procState && !this._procState.exited);
  }
}

module.exports = { QemuBackend, MONITOR_PORT_BASE };

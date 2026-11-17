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
const { AdbClient } = require('../adb');

const MONITOR_PORT_BASE = 5580;

class QemuBackend {
  constructor(opts = {}) {
    this.provisioner = opts.provisioner || null;
    this.settingsFn = opts.settingsFn || (() => ({}));
    this.onLog = opts.onLog || (() => {});
    this.systemId = opts.systemId || 'qemu-system';
    this.proc = null;
    this._serial = 0;
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
   * @param {object} o { disk, iso, install, memoryMB, cores, adbPort, monitorPort, uefi, display }
   */
  buildArgs(o = {}) {
    const accelInfo = o.accel || { whpx: false };
    const accel = accelInfo.whpx ? 'whpx' : 'tcg';
    const cpu = accelInfo.whpx ? 'host' : 'max';
    const mem = Math.max(1024, Number(o.memoryMB) || 4096);
    const smp = Math.max(1, Number(o.cores) || 4);
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
      '-device', 'AC97,audiodev=snd0',
      '-audiodev', 'sdl,id=snd0',
    ];
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

  /** 启动虚拟机进程（仅代表 VM 进程运行，不代表 Android 就绪） */
  startVM(opts = {}) {
    const exe = this.qemuExe();
    if (!exe) return Promise.resolve({ ok: false, error: '未安装 QEMU，请先在设置中安装运行时。' });
    const args = this.buildArgs(opts);
    this.log('QEMU: ' + exe + ' ' + args.join(' '));
    return new Promise((resolve) => {
      try {
        const child = spawn(exe, args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = child;
        let stderr = '';
        child.stderr.on('data', (b) => {
          const s = b.toString();
          stderr += s;
          if (stderr.length > 20000) stderr = stderr.slice(-10000);
          this.log('QEMU: ' + s.trim());
        });
        let settled = false;
        const finish = (ok, error) => {
          if (settled) return;
          settled = true;
          resolve({ ok, error: error || '', pid: child.pid || 0 });
        };
        // 进程存活 1.5s 视作 VM 启动成功（后续由 Android 就绪检查兜底）
        const timer = setTimeout(() => finish(true), 1500);
        child.on('error', (e) => { clearTimeout(timer); finish(false, e.message); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          this.proc = null;
          if (!settled) finish(false, 'QEMU 进程提前退出（code ' + code + '）：' + stderr.slice(-500));
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  /**
   * 等待 Android 真正就绪：adb connect + getprop sys.boot_completed===1。
   * 注意 QEMU guest 必须自行开启网络 ADB，否则这里会超时——如实返回 false。
   */
  async waitAndroidReady({ adbPath, adbPort = 5555, timeoutMs = 180000, onProgress } = {}) {
    const client = new AdbClient({ adbPath, serial: `127.0.0.1:${adbPort}` });
    const start = Date.now();
    let last = 0;
    while (Date.now() - start < timeoutMs) {
      try {
        await client.connect().catch(() => false);
        if (await client.isOnline()) {
          const out = String(await client.shell('getprop sys.boot_completed', { timeout: 8000 })).trim();
          const val = out.split(/\r?\n/)[0].trim();
          if (val === '1') {
            return { ok: true, serial: client.serial, elapsedMs: Date.now() - start };
          }
        }
      } catch (_) {}
      const elapsed = Date.now() - start;
      if (onProgress && elapsed - last > 5000) {
        last = elapsed;
        onProgress({ elapsedMs: elapsed, phase: 'waiting-android' });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return {
      ok: false,
      error: 'QEMU 虚拟机已启动，但等待 Android 系统就绪超时。请确认 guest 内已开启网络 ADB（端口 5555）。虚拟机进程启动 ≠ Android 系统启动成功。',
      serial: client.serial,
    };
  }

  async stop() {
    if (!this.proc || !this.proc.pid) return { ok: true };
    // 先尝试 monitor 的 system_powerdown，交给 guest 优雅关机
    try {
      const net = require('net');
      await new Promise((resolve) => {
        const sock = net.connect(MONITOR_PORT_BASE, '127.0.0.1', () => {
          sock.write('system_powerdown\n');
          setTimeout(() => { try { sock.end(); } catch (_) {} resolve(); }, 300);
        });
        sock.on('error', resolve);
        sock.setTimeout(1500, () => { try { sock.destroy(); } catch (_) {} resolve(); });
      });
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if (this.proc && this.proc.pid) process.kill(this.proc.pid);
    } catch (_) {}
    this.proc = null;
    return { ok: true };
  }

  running() { return !!(this.proc && this.proc.pid && !this.proc.killed); }
}

module.exports = { QemuBackend, MONITOR_PORT_BASE };

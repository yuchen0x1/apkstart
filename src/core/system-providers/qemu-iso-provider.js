'use strict';
/**
 * QEMU ISO 系统 Provider 基类（Bliss OS / Android-x86）。
 * ------------------------------------------------------------------
 * 完整链路：download(ISO) → verify(SHA-256) → createDevice(qcow2) →
 *           install(live-boot + 安装到虚拟磁盘) → initialize → start(从磁盘启动) →
 *           waitAndroidReady(ADB)。
 *
 * 安装策略（installMode，来自 settings.runtime.installMode）：
 *   - 'guided'（默认，安全）：ISO 引导进入官方安装器，用户在虚拟机窗口内完成安装；
 *     Provider 负责建盘、挂载、等待磁盘被写入、落盘标记。绝不假装已安装。
 *   - 'auto'（实验）：给内核传自动安装参数尝试无人值守，失败则明确报错并提示改用 guided。
 * 两种方式都只在 qcow2 虚拟磁盘内操作，绝不触碰 Windows 实际磁盘。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BaseProvider, PROVIDER_IDS } = require('./base-provider');
const { QemuBackend } = require('./qemu-backend');

class QemuIsoProvider extends BaseProvider {
  constructor(ctx = {}) {
    super(ctx);
    this.downloadsDir = this.dir('downloads');
    this.disksDir = this.dir('disks');
    this.devicesDir = this.dir('devices');
    this.logsDir = this.dir('logs');
    this.snapshotsDir = this.dir('snapshots');
    this.userdataDir = this.dir('userdata');
    this.backend = ctx.qemuBackend || ctx.backend || new QemuBackend({
      provisioner: this.provisioner,
      settingsFn: () => this.settings,
      onLog: (m) => this.log(m),
      systemId: this.id,
    });
    this._installSessionActive = false;
    this._installWaitIntervalMs = Number(ctx.installWaitIntervalMs) || 1000;
  }

  isoPath() { return path.join(this.downloadsDir, this.isoFileName || (this.id + '.iso')); }
  diskPath() { return path.join(this.disksDir, 'system.qcow2'); }

  async getRunningState() {
    if (!this.backend || typeof this.backend.running !== 'function') throw new Error('无法确认 QEMU 后端运行状态');
    const running = this.backend.running();
    if (typeof running !== 'boolean') throw new Error('QEMU 后端未返回明确运行状态');
    return running;
  }

  async getLocalStatus() {
    const m = this.readManifest() || {};
    let isoSize = 0;
    let diskSize = 0;
    try { isoSize = fs.statSync(this.isoPath()).size; } catch (_) {}
    try { diskSize = fs.statSync(this.diskPath()).size; } catch (_) {}
    return {
      installed: this._hasInstallationEvidence(m),
      installationPending: m.installationPending || null,
      needsInstallationConfirmation: !!m.installed && !this._hasInstallationEvidence(m),
      downloaded: isoSize > 0 && !!m.downloaded,
      running: this.backend.running(),
      version: m.version || '',
      installedMethod: m.installedMethod || '',
      paths: { iso: this.isoPath(), disk: this.diskPath(), downloads: this.downloadsDir, disks: this.disksDir },
      isoSize,
      diskSize,
    };
  }

  /**
   * 下载 ISO。由 taskManager 驱动：这里直接调用 downloadMulti，进度透传给 task。
   * @param {object} task 任务对象（taskManager 传入，含 onProgress/signal 等）
   * @param {object} info getDownloadInfo() 结果
   */
  async download(task, ctx = {}) {
    const info = ctx.info || await this.getDownloadInfo();
    if (!info || !info.url) throw new Error('无合法下载地址');
    const { downloadMulti } = require('../download');
    const dest = this.isoPath();
    const connections = Math.max(2, Math.min(8, Number(os.cpus().length) || 4));
    const urls = [info.url].concat(info.mirrors || []).filter(Boolean);

    this.log(`开始下载 ${info.version}：${info.fileSize} 字节，SHA-256=${info.sha256 || '(下载后计算)'}`);
    const result = await downloadMulti(urls, dest, {
      connections,
      retries: 6,
      // 目录中的可信摘要是跨镜像混拼、断点续传和最终文件唯一可用的内容身份。
      expectSha256: info.sha256 || undefined,
      onProgress: (p) => {
        if (task && typeof task.updateProgress === 'function') {
          task.updateProgress({
            downloadedBytes: p.got, totalBytes: p.total, percent: p.percent,
            speed: p.speed, eta: p.eta,
          });
        }
      },
      signal: task && task.signal ? task.signal : undefined,
    });

    const actual = require('../download').sha256File(dest);
    const sha256 = await actual;
    this.writeManifest({
      version: info.version,
      downloaded: true,
      isoSize: result.size,
      sha256,
      expectedSha256: info.sha256 || '',
    });
    return { file: dest, size: result.size, sha256 };
  }

  /** 校验 ISO：有官方 SHA-256 就比对；没有则计算并记录（不伪造）。 */
  async verify(file, version) {
    const info = (await this.getDownloadInfo()) || {};
    const f = file || this.isoPath();
    if (!fs.existsSync(f)) return { ok: false, error: 'ISO 文件不存在' };
    const sha256 = await require('../download').sha256File(f);
    const expected = info.sha256 || version && version.sha256 || '';
    if (expected && String(expected).toLowerCase() !== sha256.toLowerCase()) {
      return { ok: false, sha256, expected, error: 'SHA-256 校验失败：文件可能损坏或被篡改' };
    }
    return { ok: true, sha256, expected: expected || '', verified: !!expected };
  }

  /** 创建 qcow2 虚拟磁盘（复用 provision.createDisk 的语义，但落到本系统独立目录） */
  async createDevice(ctx = {}) {
    const disk = this.diskPath();
    const sizeGB = Number((this.settings.runtime && this.settings.runtime.diskSizeGB)) || 24;
    if (fs.existsSync(disk) && fs.statSync(disk).size > 1024 * 1024) {
      return { ok: true, disk, reused: true };
    }
    const prov = this.provisioner;
    if (!prov || typeof prov.createDisk !== 'function') {
      return { ok: false, error: 'QEMU 运行时不可用，无法创建虚拟磁盘' };
    }
    try {
      // provision.createDisk 默认写自己的路径；这里用 qemu-img 直接写到本系统目录
      const p = prov.paths();
      const { spawnSync } = require('child_process');
      const r = spawnSync(p.qemuImg, ['create', '-f', 'qcow2', disk, sizeGB + 'G'], { encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'qemu-img 创建失败').slice(-500) };
      return { ok: true, disk, sizeGB };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 只认可与当前虚拟磁盘绑定的明确完成证据。 */
  _hasInstallationEvidence(m) {
    const e = m && m.installationEvidence;
    try {
      const s = fs.statSync(this.diskPath());
      return !!(m.installed && e && e.disk === this.diskPath() && s.isFile() && s.size > 0
        && ((e.type === 'guided-user-confirmation' && e.confirmedAt && e.taskId && e.installerStopped === true)
          || (e.type === 'user-restored-backup' && e.restoredAt)));
    } catch (_) { return false; }
  }

  isInstallerRunning() {
    const m = this.readManifest() || {};
    return !!((this._installSessionActive || m.installationPending) && this.backend.running());
  }

  /** 引导安装绝不因超时、暂停或取消而强行关闭安装器。 */
  async install(task, ctx = {}) {
    const signals = [ctx.signal, task && task.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const stopped = () => !!(signal && signal.aborted || task && task.aborted);
    if (stopped()) return { ok: false, interrupted: true };
    const disk = this.diskPath();
    const iso = this.isoPath();
    const m = this.readManifest() || {};
    if (this._hasInstallationEvidence(m)) return { ok: true, disk, reused: true };
    const installMode = ctx.installMode || (this.settings.runtime && this.settings.runtime.installMode) || 'guided';
    if (installMode !== 'guided') {
      return { ok: false, code: 'AUTO_INSTALL_UNSUPPORTED', needsUserInstall: true,
        error: '尚未实现无人值守安装，请改用引导式安装（installMode=guided）。' };
    }

    // 旧版仅按磁盘大小写出的 installed 不能当证据，也不能因此自动重装已有磁盘。
    if (m.installed && !m.installationPending && fs.existsSync(disk)) {
      this.writeManifest({ installed: false, installationPending: {
        mode: 'guided', taskId: task && task.taskId || '', version: m.version || '',
        startedAt: new Date().toISOString(), legacyReview: true,
      } });
      if (task && task.setStatus) task.setStatus('awaiting_confirmation', '旧安装记录需要确认；请先检查系统已完成安装并正常关机');
      return { ok: true, awaitingConfirmation: true, disk, legacyReview: true };
    }

    // 暂停/取消后接续已有安装器，不重复启动或覆盖正在使用的磁盘。
    if (this.backend.running() && !this.isInstallerRunning()) {
      return { ok: false, error: '虚拟机正在运行，请先正常关闭后安装。' };
    }
    if (!this.backend.running() && !m.installationPending) {
      if (stopped()) return { ok: false, interrupted: true, code: 'START_CANCELLED' };
      const created = await this.createDevice(ctx);
      if (stopped()) return { ok: false, interrupted: true, code: 'START_CANCELLED' };
      if (!created.ok) return created;
      if (!fs.existsSync(iso)) return { ok: false, error: 'ISO 文件不存在' };
      const accel = await this.backend.accelInfo();
      if (stopped()) return { ok: false, interrupted: true, code: 'START_CANCELLED' };
      const pending = this.writeManifest({ installed: false, installationEvidence: null,
        installationPending: { mode: 'guided', taskId: task && task.taskId || '',
          startedAt: new Date().toISOString(), version: ctx.version || m.version || '' } });
      if (!pending) return { ok: false, error: '无法记录安装会话' };
      this._installSessionActive = true;
      let vm;
      try {
        if (stopped()) return { ok: false, interrupted: true, code: 'START_CANCELLED' };
        vm = await this.backend.startVM({
          disk, iso, install: true, uefi: true,
          memoryMB: (this.settings.engine && this.settings.engine.memoryMB) || 4096,
          cores: (this.settings.engine && this.settings.engine.cores) || 4, accel, signal,
        });
        if (stopped()) return { ok: false, interrupted: true, code: 'START_CANCELLED', vmStarted: await this.getRunningState() };
        if (!vm || !vm.ok) return { ok: false, error: 'ISO 引导失败：' + (vm && vm.error || '未返回启动确认') };
      } finally {
        // Cancel before spawn is not a resumable installation session. Keep a
        // live installer untouched, but do not leave confirmation metadata for
        // a VM that never existed. Unknown process state preserves the record.
        if ((!vm || !vm.ok || stopped()) && await this.getRunningState() === false
            && !this.backend.isStarting?.()) {
          this.writeManifest({ installationPending: null });
          this._installSessionActive = false;
        }
      }
    }
    if (stopped()) return { ok: false, interrupted: true };
    const pending = this.readManifest() || {};
    if (!pending.installationPending) return { ok: false, error: '安装会话不存在' };
    this._installSessionActive = true;
    this.writeManifest({ installationPending: Object.assign({}, pending.installationPending, {
      taskId: task && task.taskId || '', version: ctx.version || pending.installationPending.version || '',
    }) });
    if (task && task.setStatus) task.setStatus('awaiting_confirmation',
      '请在虚拟机内完成安装并正常关机，再点击「确认安装完成」');
    // 磁盘增长仅代表写入活动，不能用作安装完成证据。
    const baseline = fs.existsSync(disk) ? fs.statSync(disk).size : 0;
    const deadline = Number(ctx.installWaitMs) > 0 ? Date.now() + Number(ctx.installWaitMs) : Infinity;
    while (!stopped()) {
      if (!this.isInstallerRunning()) {
        return { ok: true, awaitingConfirmation: true, disk, method: 'guided' };
      }
      if (Date.now() >= deadline) return { ok: false, needsUserInstall: true,
        error: '等待安装确认超时；安装器仍保留，请继续完成安装并正常关机。' };
      try {
        const bytes = Math.max(0, fs.statSync(disk).size - baseline);
        if (task && task.updateProgress) task.updateProgress({
          percent: bytes > 0 ? 95 : 90, diskWrittenBytes: bytes,
        });
      } catch (_) {}
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, this._installWaitIntervalMs);
        if (signal) signal.addEventListener('abort', done, { once: true });
        if (stopped()) done();
      });
    }
    return { ok: false, interrupted: true };
  }

  /** 只有安装虚拟机已退出，才接受用户明确确认完成。 */
  confirmInstallation(task, opts = {}) {
    if (opts.confirmed !== true) return { ok: false, error: '需要用户明确确认安装完成' };
    if (!task || task.aborted || task.signal && task.signal.aborted) return { ok: false, error: '任务已暂停或取消，请先继续任务' };
    const m = this.readManifest() || {};
    if (!m.installationPending || m.installationPending.taskId !== task.taskId) {
      return { ok: false, error: '没有与此任务匹配的安装会话' };
    }
    if (this.backend.running()) return { ok: false, code: 'INSTALLER_RUNNING',
      error: '安装器仍在运行，请完成安装并在虚拟机内正常关机后确认；不会自动停止安装器。' };
    let stat;
    try { stat = fs.statSync(this.diskPath()); } catch (_) {}
    if (!stat || !stat.isFile() || stat.size === 0) return { ok: false, error: '安装磁盘不存在或为空' };
    const confirmedAt = new Date().toISOString();
    const evidence = { type: 'guided-user-confirmation', confirmedAt,
      installerStopped: true, disk: this.diskPath(), taskId: task.taskId };
    const saved = this.writeManifest({ installed: true, installationPending: null,
      installationEvidence: evidence, installedAt: confirmedAt, installedMethod: 'guided',
      version: m.installationPending.version || m.version || '', running: false });
    if (!saved) return { ok: false, error: '无法保存安装完成证据' };
    this._installSessionActive = false;
    return { ok: true, disk: this.diskPath(), method: 'guided', installationEvidence: evidence };
  }

  async initialize(task, ctx = {}) {
    // Android-x86 / Bliss 的用户数据随 qcow2 保留；此处仅确保独立目录存在。
    this.dir('userdata');
    this.dir('snapshots');
    this.writeManifest({ initialized: true });
    return { ok: true };
  }

  /** 从已安装的 qcow2 磁盘启动；返回 VM 进程状态 + backend 供上层做 Android 就绪检查 */
  async start(ctx = {}) {
    const signal = ctx.signal;
    const cancelled = () => ({ ok: false, code: 'START_CANCELLED', error: '系统启动已取消' });
    if (signal && signal.aborted) return cancelled();
    const m = this.readManifest() || {};
    if (!this._hasInstallationEvidence(m)) return { ok: false, error: '系统尚未确认安装完成，请先完成安装确认。' };
    const disk = this.diskPath();
    if (!fs.existsSync(disk)) return { ok: false, error: '虚拟磁盘不存在。' };
    const accel = await this.backend.accelInfo();
    if (signal && signal.aborted) return cancelled();
    const vm = await this.backend.startVM({
      disk, iso: '', install: false, uefi: true,
      memoryMB: (this.settings.engine && this.settings.engine.memoryMB) || 4096,
      cores: (this.settings.engine && this.settings.engine.cores) || 4,
      accel, signal,
    });
    if (signal && signal.aborted) return Object.assign(cancelled(), { vmStarted: !!(vm && vm.vmStarted) });
    if (vm.ok) this.writeManifest({ running: true });
    return Object.assign({}, vm, { backend: 'QemuBackend', needsAndroidReadyCheck: true });
  }

  async stop(ctx = {}) {
    if (!this.backend || typeof this.backend.stop !== 'function') return { ok: false, error: '无法确认 QEMU 后端停止状态' };
    const r = await this.backend.stop(ctx);
    if (!(r === true || r && r.ok === true)) return Object.assign({}, r, { ok: false, error: r && r.error || '未确认 QEMU 进程退出' });
    if (await this.getRunningState()) return { ok: false, error: 'QEMU 进程仍在运行' };
    this.writeManifest({ running: false });
    return { ok: true, ...(typeof r === 'object' ? r : {}) };
  }

  async restart(ctx = {}) {
    const stopped = await this.stop(ctx);
    if (!stopped || !stopped.ok) return stopped;
    return this.start(ctx);
  }

  async backup(destDir) {
    if (!destDir) return { ok: false, error: '缺少目标目录' };
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const disk = this.diskPath();
      if (!fs.existsSync(disk)) return { ok: false, error: '虚拟磁盘不存在' };
      const dest = path.join(destDir, path.basename(disk));
      fs.copyFileSync(disk, dest);
      return { ok: true, files: [dest] };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async restore(srcDir) {
    if (this.backend.running()) return { ok: false, error: '系统仍在运行，不能覆盖虚拟磁盘' };
    try {
      const src = path.join(srcDir, 'system.qcow2');
      if (!fs.existsSync(src)) return { ok: false, error: '备份中缺少 system.qcow2' };
      fs.mkdirSync(this.disksDir, { recursive: true });
      const stat = fs.statSync(src);
      if (!stat.isFile() || stat.size === 0) return { ok: false, error: '备份磁盘为空或不是文件' };
      fs.copyFileSync(src, this.diskPath());
      this.writeManifest({ installed: true, installationPending: null, installationEvidence: {
        type: 'user-restored-backup', restoredAt: new Date().toISOString(), disk: this.diskPath(),
      } });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { QemuIsoProvider };

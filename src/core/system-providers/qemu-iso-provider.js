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
    this.backend = new QemuBackend({
      provisioner: this.provisioner,
      settingsFn: () => this.settings,
      onLog: (m) => this.log(m),
      systemId: this.id,
    });
  }

  isoPath() { return path.join(this.downloadsDir, this.isoFileName || (this.id + '.iso')); }
  diskPath() { return path.join(this.disksDir, 'system.qcow2'); }

  async getLocalStatus() {
    const m = this.readManifest() || {};
    let isoSize = 0;
    let diskSize = 0;
    try { isoSize = fs.statSync(this.isoPath()).size; } catch (_) {}
    try { diskSize = fs.statSync(this.diskPath()).size; } catch (_) {}
    return {
      installed: !!m.installed,
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
    const settings = this.settings;
    const connections = Math.max(1, Number(settings.runtime.downloadConnections) || 8);
    const urls = [info.url].concat(info.mirrors || []).filter(Boolean);

    this.log(`开始下载 ${info.version}：${info.fileSize} 字节，SHA-256=${info.sha256 || '(下载后计算)'}`);
    const result = await downloadMulti(urls, dest, {
      connections,
      retries: 6,
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

  /**
   * 首次安装：live-boot ISO + 引导用户/自动脚本把系统写入 qcow2。
   * 真实标记 installed 只在以下条件满足时写入：磁盘已被显著写入（>阈值）。
   */
  async install(task, ctx = {}) {
    const disk = this.diskPath();
    const iso = this.isoPath();
    const created = await this.createDevice(ctx);
    if (!created.ok) return created;

    const accel = await this.backend.accelInfo();
    const installMode = (this.settings.runtime && this.settings.runtime.installMode) || 'guided';
    this.log(`首次安装（${installMode}）：ISO 引导到 qcow2 虚拟磁盘 ${disk}`);

    if (installMode === 'auto') {
      // 实验性无人值守：Android-x86 支持在 cmdline 传 INSTALL 自动安装，
      // 但不同 ISO 行为不一致，不能保证成功。超时后明确失败，不伪造 installed。
      this.log('auto 模式为实验特性；若未能自动完成，请改用引导式安装。');
    }

    const vm = await this.backend.startVM({
      disk, iso, install: true, uefi: true,
      memoryMB: (this.settings.engine && this.settings.engine.memoryMB) || 4096,
      cores: (this.settings.engine && this.settings.engine.cores) || 4,
      accel,
    });
    if (!vm.ok) return { ok: false, error: 'ISO 引导失败：' + vm.error };

    // 等待磁盘被写入。guided 模式给用户时间在安装器内操作；
    // 以磁盘体积相对空 qcow2 的显著增长作为"已写入"的客观证据。
    const baseline = fs.existsSync(disk) ? fs.statSync(disk).size : 0;
    const waitMs = Number(ctx.installWaitMs) || 0; // 由上层/测试注入；默认交给引导模式轮询
    const deadline = Date.now() + (waitMs || (installMode === 'guided' ? 20 * 60 * 1000 : 5 * 60 * 1000));
    let written = false;
    while (Date.now() < deadline) {
      if (task && task.aborted) break;
      try {
        const now = fs.statSync(disk).size;
        if (now > baseline + 32 * 1024 * 1024) { written = true; break; }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    await this.backend.stop();

    if (!written) {
      return {
        ok: false,
        needsUserInstall: true,
        error: installMode === 'guided'
          ? '已在虚拟机中打开官方安装器，但未检测到磁盘被写入。请在虚拟机窗口内完成安装后重试。'
          : '无人值守安装未能完成磁盘写入，请改用引导式安装（installMode=guided）。',
      };
    }
    this.writeManifest({ installed: true, version: (ctx.version || this.readManifest() || {}).version || '', installedMethod: installMode, installedAt: new Date().toISOString() });
    return { ok: true, disk, method: installMode };
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
    const m = this.readManifest() || {};
    if (!m.installed) return { ok: false, error: '系统尚未安装，请先完成安装。' };
    const disk = this.diskPath();
    if (!fs.existsSync(disk)) return { ok: false, error: '虚拟磁盘不存在。' };
    const accel = await this.backend.accelInfo();
    const vm = await this.backend.startVM({
      disk, iso: '', install: false, uefi: true,
      memoryMB: (this.settings.engine && this.settings.engine.memoryMB) || 4096,
      cores: (this.settings.engine && this.settings.engine.cores) || 4,
      accel,
    });
    if (vm.ok) this.writeManifest({ running: true });
    return Object.assign({}, vm, { backend: 'QemuBackend', needsAndroidReadyCheck: true });
  }

  async stop() {
    const r = await this.backend.stop();
    if (r.ok) this.writeManifest({ running: false });
    return r;
  }

  async restart() {
    await this.stop();
    return this.start();
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
    try {
      const src = path.join(srcDir, 'system.qcow2');
      if (!fs.existsSync(src)) return { ok: false, error: '备份中缺少 system.qcow2' };
      fs.mkdirSync(this.disksDir, { recursive: true });
      fs.copyFileSync(src, this.diskPath());
      this.writeManifest({ installed: true });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { QemuIsoProvider };

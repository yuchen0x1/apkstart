'use strict';
/**
 * Provider 基类：所有系统（内置/第三方）实现同一套接口契约。
 * ------------------------------------------------------------------
 * 每个 Provider 只负责自身系统逻辑，统一由 system-manager 协调。
 * 接口契约（子类按需覆盖，方法不存在时返回默认值而非抛错）：
 *
 *   getVersions()        -> Promise<Array<version>>
 *   getLatestVersion()   -> Promise<version|null>
 *   getAvailability()    -> Promise<{available, reason, status}>
 *   getLocalStatus()     -> Promise<{installed, downloaded, running, version, paths}>
 *   getDownloadInfo()    -> Promise<{version, url, mirrors, fileSize, sha256}|null>
 *   download(task, ctx)  -> Promise<{file, size, sha256}>   // 由 taskManager 驱动
 *   verify(file, version)-> Promise<{ok, sha256, error}>
 *   install(task, ctx)   -> Promise<{ok, ...}>              // 下载后→装盘/展开
 *   initialize(task, ctx)-> Promise<{ok}>                   // 首次初始化
 *   createDevice(ctx)    -> Promise<{ok, ...}>
 *   start(ctx)           -> Promise<{ok, ...}>              // 启动引擎（≠Android 就绪）
 *   stop(ctx)            -> Promise<{ok}>
 *   restart(ctx)         -> Promise<{ok}>
 *   getStatus()          -> Promise<object>
 *   getLogs()            -> Promise<Array<string>>
 *   backup(destDir)      -> Promise<{ok, files}>
 *   restore(srcDir)      -> Promise<{ok}>
 *   remove()             -> Promise<{ok}>
 *
 * 语义红线（不得混淆）：
 *   - download 成功 ≠ install 成功；install ≠ 虚拟磁盘启动；虚拟磁盘启动 ≠ Android 就绪。
 *   - 没有合法预构建镜像的系统，getAvailability().available=false 且 getDownloadInfo()=null，
 *     由 UI 显示真实状态，绝不返回伪造地址。
 */
const fs = require('fs');
const path = require('path');
const { resolveSystemPaths, legacyPathWarnings } = require('./system-paths');

const PROVIDER_IDS = {
  GOOGLE_PLAY: 'google-play',
  GOOGLE_APIS: 'google-apis',
  AOSP: 'aosp',
  LINEAGE: 'lineageos',
  BLISS: 'bliss-os',
  ANDROID_X86: 'android-x86',
  CUSTOM: 'custom',
};

class BaseProvider {
  /**
   * @param {object} ctx 共享上下文
   *   - systemId, displayName, catalog(SystemCatalog), store, provisioner, taskManager
   *   - dataDir  该系统独立数据根目录 %APPDATA%\apkstart\runtime\systems\<id>
   *   - settingsFn() 读取当前 settings
   *   - onLog(msg) 日志回调
   */
  constructor(ctx = {}) {
    this.id = ctx.systemId || 'unknown';
    this.displayName = ctx.displayName || this.id;
    this.catalog = ctx.catalog || null;
    this.store = ctx.store || null;
    this.provisioner = ctx.provisioner || null;
    this.taskManager = ctx.taskManager || null;
    this.settingsFn = ctx.settingsFn || (() => ({}));
    this.onLog = ctx.onLog || (() => {});
    const paths = resolveSystemPaths(ctx);
    this.dataDir = ctx.dataDir || path.join(paths.systemsDir, this.id);
    this.pathWarnings = legacyPathWarnings(this.dataDir,
      paths.legacySystemsDirs.map((dir) => path.join(dir, this.id)));
    this._logs = [];
  }

  log(msg) {
    const line = String(msg);
    this._logs.push(line);
    if (this._logs.length > 500) this._logs.shift();
    try { this.onLog(line); } catch (_) {}
  }

  get settings() { return this.settingsFn(); }

  /** 系统子目录，按需创建 */
  dir(name) {
    const p = path.join(this.dataDir, name || '');
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
    return p;
  }

  manifestPath() { return path.join(this.dataDir, 'manifest.json'); }

  readManifest() {
    try {
      const raw = fs.readFileSync(this.manifestPath(), 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  writeManifest(patch) {
    try {
      const prev = this.readManifest() || {};
      const next = Object.assign({ systemId: this.id, updatedAt: new Date().toISOString() }, prev, patch);
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.manifestPath(), JSON.stringify(next, null, 2), 'utf8');
      return next;
    } catch (e) {
      this.log('写入 manifest 失败：' + e.message);
      return null;
    }
  }

  // ---- 默认接口实现（子类覆盖） ----
  async getVersions() {
    if (!this.catalog) return [];
    const s = await this.catalog.getSystem(this.id);
    return s ? s.versions : [];
  }

  async getLatestVersion() {
    if (!this.catalog) return null;
    return this.catalog.getLatest(this.id);
  }

  async getAvailability() {
    const versions = await this.getVersions();
    const usable = versions.find((v) => v.status === 'available' || v.status === 'available-archive');
    if (usable) return { available: true, reason: '', status: usable.status, version: usable };
    const reason = (versions[0] && versions[0].statusReason) ||
      '暂无可用的预构建镜像，请等待后续接入。';
    return { available: false, reason, status: (versions[0] && versions[0].status) || 'unavailable', version: versions[0] || null };
  }

  async getLocalStatus() {
    const m = this.readManifest() || {};
    return {
      installed: !!m.installed,
      downloaded: !!m.downloaded,
      running: !!m.running,
      version: m.version || '',
      paths: m.paths || {},
    };
  }

  async getDownloadInfo() {
    const avail = await this.getAvailability();
    if (!avail.available || !avail.version) return null;
    const v = avail.version;
    return {
      version: v.version,
      url: v.downloadUrl,
      mirrors: v.mirrors || [],
      fileSize: v.fileSize || 0,
      sha256: v.sha256 || '',
    };
  }

  // download/verify/install/initialize/createDevice/start/stop/restart 由子类实现。
  // 这里给出 safety 默认，避免调用方忘记判断。
  async download() { throw new Error(`${this.id}: 该系统的下载未实现（可能无预构建镜像）`); }
  async verify() { return { ok: false, error: '未实现校验' }; }
  async install() { return { ok: false, error: '未实现安装' }; }
  async initialize() { return { ok: true }; }
  async createDevice() { return { ok: true }; }
  async start() { return { ok: false, error: '未实现启动' }; }
  async stop() { return { ok: true }; }
  async restart() { return { ok: false, error: '未实现重启' }; }

  async getStatus() {
    return Object.assign({ id: this.id, name: this.displayName }, await this.getLocalStatus(), await this.getAvailability());
  }

  async getLogs() { return this._logs.slice(); }

  async backup() { return { ok: false, error: '该系统暂不支持备份' }; }
  async restore() { return { ok: false, error: '该系统暂不支持恢复' }; }

  async remove() {
    // 基类删除：仅删本系统独立目录，绝不触碰用户其它系统数据
    try {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = { BaseProvider, PROVIDER_IDS };

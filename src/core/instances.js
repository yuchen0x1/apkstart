'use strict';
/**
 * 多开实例编排器。
 *
 * 每个实例是一个独立的 Electron 子进程，拥有自己的 Chromium userData、
 * settings/apps/APK 缓存和 AVD 数据目录；只读运行时目录可以共享。这个模块
 * 不启动 Android/ADB，也不扫描或终止未知进程，便于离线单元测试和安全审计。
 */
const fsDefault = require('fs');
const path = require('path');
const { spawn: spawnDefault } = require('child_process');
const { randomUUID } = require('crypto');
const instanceContext = require('./instance-context');
const { writeJsonAtomicSync } = require('./atomic-json');

const CATALOG_VERSION = 1;
const CATALOG_FILE_NAME = 'catalog.json';
const STATES = new Set(['created', 'starting', 'running', 'stopped', 'error']);
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const NAME_MAX = 80;
const ERROR_MAX = 2000;

function errorWithCode(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    throw errorWithCode('INVALID_PARENT_SETTINGS', '父实例配置不可复制', e);
  }
}

function packageName(value) {
  return typeof value === 'string' && PACKAGE_RE.test(value);
}

function safePart(value, fallback = 'item') {
  const out = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_').slice(0, 120);
  return out || fallback;
}

function validName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= NAME_MAX
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function now() {
  return Date.now();
}

class InstanceManager {
  /**
   * @param {object} options
   * @param {object} options.store trusted parent store (not renderer input)
   * @param {string} options.appRoot development Electron app root
   * @param {string} options.executable packaged executable, or process.execPath
   * @param {boolean} options.isPackaged choose packaged/dev child argv layout
   * @param {Function} options.spawn injectable child_process.spawn
   * @param {object} options.fs injectable fs for offline tests
   * @param {Function} options.isPidAlive injectable read-only PID existence probe
   * @param {object} options.context injectable already-resolved context for tests
   */
  constructor(options = {}) {
    this.store = options.store || require('./store');
    this.fs = options.fs || fsDefault;
    this.spawn = options.spawn || spawnDefault;
    this.appRoot = options.appRoot || path.resolve(__dirname, '..', '..');
    this.executable = options.executable || process.execPath;
    this.isPackaged = options.isPackaged === true;
    this.env = options.env || process.env;
    // Read-only PID existence probe for catalog records from a previous parent.
    // It never sends a terminating signal; callers may inject it in offline tests.
    this.isPidAlive = typeof options.isPidAlive === 'function' ? options.isPidAlive : null;
    this.spawnTimeoutMs = Number.isSafeInteger(options.spawnTimeoutMs) && options.spawnTimeoutMs > 0
      ? options.spawnTimeoutMs : 5000;
    this.context = options.context || instanceContext.current();
    if (!this.context || typeof this.context.baseDir !== 'string') {
      throw errorWithCode('INVALID_CONTEXT', '缺少受信的多开上下文');
    }
    if (this.context.isChild) {
      throw errorWithCode('INVALID_CONTEXT', '分身进程不能创建其他分身');
    }

    this.platform = this.context.platform || process.platform;
    this.path = this.platform === 'win32' ? path.win32 : path.posix;
    this.baseDir = this.path.normalize(this.context.baseDir);
    this.instancesDir = this.path.join(this.baseDir, 'instances');
    this.catalogFile = this.path.join(this.instancesDir, CATALOG_FILE_NAME);
    this.sharedRuntimeDir = this.path.join(this.baseDir, 'runtime');
    this.owned = new Map();
  }

  _contextFor(id) {
    instanceContext.assertInstanceId(id);
    const dataDir = this.path.join(this.instancesDir, id);
    return Object.freeze({
      version: instanceContext.CONTEXT_VERSION,
      isChild: true,
      id,
      baseDir: this.baseDir,
      dataDir,
      userDataDir: this.path.join(dataDir, 'chromium'),
      avdDir: this.path.join(dataDir, 'avd'),
      instancesDir: this.instancesDir,
      catalogFile: this.catalogFile,
      runtimeDir: this.sharedRuntimeDir,
      sharedRuntimeDir: this.sharedRuntimeDir,
      platform: this.platform,
    });
  }

  _baseContext() {
    return Object.freeze({
      version: instanceContext.CONTEXT_VERSION,
      isChild: false,
      id: null,
      baseDir: this.baseDir,
      dataDir: this.baseDir,
      userDataDir: this.baseDir,
      avdDir: this.path.join(this.baseDir, 'avd'),
      instancesDir: this.instancesDir,
      catalogFile: this.catalogFile,
      runtimeDir: this.sharedRuntimeDir,
      sharedRuntimeDir: this.sharedRuntimeDir,
      platform: this.platform,
    });
  }

  _invalidCatalog(message, cause) {
    return errorWithCode('INSTANCE_CATALOG_INVALID', message, cause);
  }

  _readCatalog() {
    let text;
    try {
      text = this.fs.readFileSync(this.catalogFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { version: CATALOG_VERSION, instances: [] };
      throw e;
    }

    let catalog;
    try {
      catalog = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    } catch (e) {
      throw this._invalidCatalog('多开 catalog.json 格式损坏', e);
    }
    if (!isRecord(catalog) || catalog.version !== CATALOG_VERSION || !Array.isArray(catalog.instances)) {
      throw this._invalidCatalog('多开 catalog.json 版本或结构无效');
    }
    const topKeys = Object.keys(catalog);
    if (topKeys.some((key) => key !== 'version' && key !== 'instances')) {
      throw this._invalidCatalog('多开 catalog.json 含未知顶层字段');
    }

    const ids = new Set();
    const instances = catalog.instances.map((entry) => {
      if (!isRecord(entry)) throw this._invalidCatalog('多开 catalog 含非法实例记录');
      const allowed = new Set([
        'id', 'name', 'createdAt', 'updatedAt', 'state', 'pid', 'package', 'lastError', 'launchToken',
      ]);
      if (Object.keys(entry).some((key) => !allowed.has(key))) {
        throw this._invalidCatalog('多开 catalog 实例记录含未知字段');
      }
      if (!instanceContext.validateInstanceId(entry.id) || ids.has(entry.id)) {
        throw this._invalidCatalog('多开 catalog 含重复或非法实例 ID');
      }
      ids.add(entry.id);
      if (!validName(entry.name)) throw this._invalidCatalog('多开实例名称无效');
      if (!Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
        || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) {
        // Clock rollback (NTP/manual) may make updatedAt < createdAt; only
        // reject values that could not be timestamps at all.
        throw this._invalidCatalog('多开实例时间字段无效');
      }
      if (!STATES.has(entry.state)) throw this._invalidCatalog('多开实例状态无效');
      if (entry.pid !== null && !positivePid(entry.pid)) throw this._invalidCatalog('多开实例 PID 无效');
      if (entry.package !== null && !packageName(entry.package)) {
        throw this._invalidCatalog('多开实例包名无效');
      }
      if (typeof entry.lastError !== 'string' || entry.lastError.length > ERROR_MAX) {
        throw this._invalidCatalog('多开实例错误信息无效');
      }
      if (entry.launchToken !== null && !instanceContext.validateInstanceId(entry.launchToken)) {
        throw this._invalidCatalog('多开实例启动令牌无效');
      }
      return { ...entry };
    });
    return { version: CATALOG_VERSION, instances };
  }

  _writeCatalog(catalog) {
    // writeJsonAtomicSync creates the parent directory and never truncates the
    // previous catalog if a write/rename fails.
    writeJsonAtomicSync(this.catalogFile, catalog, { fs: this.fs });
  }

  _find(catalog, id) {
    return catalog.instances.find((entry) => entry.id === id) || null;
  }

  _update(id, updater) {
    const catalog = this._readCatalog();
    const entry = this._find(catalog, id);
    if (!entry) return null;
    updater(entry);
    entry.updatedAt = now();
    this._writeCatalog(catalog);
    return entry;
  }

  _public(entry) {
    const context = this._contextFor(entry.id);
    const handle = this.owned.get(entry.id);
    const ownedRunning = !!(handle && this._handleAlive(handle));
    const catalogActive = (entry.state === 'running' || entry.state === 'starting')
      && positivePid(entry.pid);
    const unconfirmed = !!(handle && handle.unconfirmed);
    // A live PID from a catalog record is not proof of ownership (PID reuse is
    // possible). Report it as unknown instead of claiming the instance is ready.
    const external = !ownedRunning && catalogActive;
    const needsVerification = unconfirmed || external;
    const { launchToken, ...safe } = entry;
    return {
      ...safe,
      isChild: true,
      state: needsVerification ? 'unknown' : entry.state,
      catalogState: entry.state,
      context,
      baseDir: context.baseDir,
      dataDir: context.dataDir,
      userDataDir: context.userDataDir,
      avdDir: context.avdDir,
      running: ownedRunning && !unconfirmed,
      external,
      unconfirmed,
      needsVerification,
      owned: !!handle,
    };
  }

  _handleAlive(handle) {
    if (!handle || !handle.child || handle.exited) return false;
    const child = handle.child;
    if (child.exitCode !== null && typeof child.exitCode !== 'undefined') return false;
    // A timed-out spawn may still be alive, but it is not confirmed. Keep it
    // tracked so a second launch cannot create a duplicate, while callers see
    // an explicit unknown state instead of a successful start.
    if (handle.unconfirmed) return positivePid(handle.pid);
    if (child.killed === true || handle.error) return false;
    return positivePid(handle.pid);
  }

  _reconcileOwned() {
    for (const [id, handle] of this.owned) {
      if (handle.exited || handle.error) continue;
      if (!this._handleAlive(handle)) {
        handle.exited = true;
        try {
          this._update(id, (entry) => {
            if (entry.launchToken === handle.token) {
              entry.state = 'stopped';
              entry.pid = null;
              entry.launchToken = null;
            }
          });
        } catch (_) { /* status must not kill or mutate an unknown process */ }
      }
    }
  }

  _pidAlive(pid) {
    if (!positivePid(pid)) return false;
    if (this.isPidAlive) return !!this.isPidAlive(pid);
    try {
      // Signal 0 only asks the OS whether the PID exists. It never terminates or
      // signals the process. A permission error still means the PID exists.
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return !!(e && e.code === 'EPERM');
    }
  }

  /**
   * Reconcile catalog records left by a previous parent process. Read-only PID
   * existence is the only evidence available here; an alive unknown PID is
   * reported as external and is never adopted, signalled or killed.
   */
  _reconcileCatalog() {
    const catalog = this._readCatalog();
    let changed = false;
    for (const entry of catalog.instances) {
      if (this.owned.has(entry.id)) continue;
      if (entry.state !== 'running' && entry.state !== 'starting') continue;
      if (!positivePid(entry.pid)) {
        entry.state = 'error';
        entry.lastError = '上次启动未完成且没有进程记录，已停止跟踪';
        entry.launchToken = null;
        changed = true;
      } else if (!this._pidAlive(entry.pid)) {
        entry.state = 'stopped';
        entry.pid = null;
        entry.launchToken = null;
        changed = true;
      }
    }
    if (changed) this._writeCatalog(catalog);
  }

  /** List catalog records with all paths recomputed from the validated id. */
  list() {
    this._reconcileOwned();
    this._reconcileCatalog();
    return this._readCatalog().instances.map((entry) => this._public(entry));
  }

  /** Alias useful to callers that want the same status shape as list(). */
  status() {
    return this.list();
  }

  _nextName(catalog) {
    const used = new Set(catalog.instances.map((entry) => entry.name));
    let n = 1;
    while (used.has(`实例 ${n}`)) n += 1;
    return `实例 ${n}`;
  }

  _parentSettings() {
    if (!this.store || typeof this.store.getSettings !== 'function') return {};
    const settings = this.store.getSettings();
    return isRecord(settings) ? cloneJson(settings) : {};
  }

  _sharedRuntimeDir(settings) {
    const candidate = settings && settings.runtime && typeof settings.runtime.dir === 'string'
      ? settings.runtime.dir.trim() : '';
    // Mirror the parent's resolved default: empty means base/runtime. A value
    // is accepted only when it is an absolute path for this platform; relative
    // or drive-relative paths would be resolved against the child's cwd.
    const usable = candidate && (this.platform === 'win32'
      ? (/^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\[^\\]/.test(candidate))
      : candidate.startsWith('/'));
    return usable ? this.path.normalize(candidate) : this.sharedRuntimeDir;
  }

  _childSettings(context) {
    const parent = this._parentSettings();
    const parentRuntime = isRecord(parent.runtime) ? parent.runtime : {};
    const parentEngine = isRecord(parent.engine) ? parent.engine : {};
    const settings = parent;

    settings.engine = {
      ...parentEngine,
      mode: 'builtin',
      prewarm: false,
      // A child may use the already-installed read-only runtime, but must never
      // automatically deploy, repair, or upgrade it on behalf of the parent.
      autoDeploy: false,
      // No inherited custom QEMU binary/image. Google emulator is the only
      // supported backend for an isolated clone.
      qemuPath: '',
      systemImage: '',
    };
    settings.runtime = {
      ...parentRuntime,
      dir: this._sharedRuntimeDir(parent),
      avdDir: context.avdDir,
      qemuUrl: '',
      isoUrl: '',
      isoPath: '',
      diskPath: '',
      emulatorUrl: '',
      sysimgUrl: '',
      runtimePackUrl: '',
      activeImageId: '',
      // Built-in Google Play emulator image only. Custom catalogs/providers and
      // a shared parent qcow2 are never inherited by a clone.
      selectedSystemId: 'google-play',
      systemImageFlavor: 'google_apis_playstore',
      compatImage: true,
      systemCatalogUrl: '',
      systemInstallMode: 'guided',
      githubToken: '',
      giteeToken: '',
    };
    settings.adbPath = '';
    settings.device = '';
    settings.autoDeploy = false;
    settings.autoStart = false;
    settings.createShortcutOnInstall = false;
    settings.createStartMenuShortcut = false;
    settings.shortcutDir = '';
    settings.notifyOnInstall = false;
    settings.freeform = false;
    settings.hideAfterLaunch = false;
    settings.wizardDone = true;
    settings.wizardVersion = 'instance';
    settings.sharedDir = this.path.join(context.dataDir, 'shared');
    settings.update = { ...(isRecord(parent.update) ? parent.update : {}), autoUpdate: false };
    settings.report = {
      ...(isRecord(parent.report) ? parent.report : {}),
      auto: false,
      autoSend: false,
      autoSendTo: '',
      endpoint: '',
    };
    // Host camera/COM access is never inherited: two instances opening the same
    // webcam or serial device conflict, and a parent permission is not consent
    // for a clone. Refresh rate may stay at the safe default.
    settings.peripherals = {
      cameraBack: 'none',
      cameraFront: 'none',
      refreshRate: 60,
      serialPort: '',
    };
    return settings;
  }

  _mkdir(dir) {
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  _removeNewDirectory(dir) {
    try {
      if (typeof this.fs.rmSync === 'function') this.fs.rmSync(dir, { recursive: true, force: true });
      else if (typeof this.fs.rmdirSync === 'function') this.fs.rmdirSync(dir, { recursive: true });
    } catch (_) { /* rollback is best effort; catalog was not committed */ }
  }

  _initializeInstance(context) {
    // Claim the instance directory without recursive/exists-then-create races.
    // Only a directory created by this call may be removed on rollback.
    this._mkdir(this.instancesDir);
    try {
      this.fs.mkdirSync(context.dataDir, { mode: 0o700 });
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        throw errorWithCode('INSTANCE_ALREADY_EXISTS', '实例数据目录已存在，拒绝覆盖', e);
      }
      throw e;
    }
    try {
      for (const dir of [
        context.userDataDir,
        context.avdDir,
        this.path.join(context.dataDir, 'apks'),
        this.path.join(context.dataDir, 'icons'),
        this.path.join(context.dataDir, 'logs'),
        this.path.join(context.dataDir, 'shared'),
      ]) this._mkdir(dir);
      writeJsonAtomicSync(this.path.join(context.dataDir, 'settings.json'), this._childSettings(context), { fs: this.fs });
      writeJsonAtomicSync(this.path.join(context.dataDir, 'apps.json'), { apps: [] }, { fs: this.fs });
    } catch (e) {
      this._removeNewDirectory(context.dataDir);
      throw e;
    }
  }

  /** Create only isolated child data/config; no APK or login data is copied. */
  create({ name } = {}) {
    const catalog = this._readCatalog();
    const label = typeof name === 'undefined' || name === null || name === ''
      ? this._nextName(catalog) : String(name).trim();
    if (!validName(label)) throw errorWithCode('INVALID_INSTANCE_NAME', '实例名称无效');
    const instancesExisted = this.fs.existsSync(this.instancesDir);

    let id;
    do { id = instanceContext.newInstanceId(); } while (this._find(catalog, id));
    const context = this._contextFor(id);
    try {
      this._initializeInstance(context);
    } catch (e) {
      if (!instancesExisted) {
        try { this.fs.rmdirSync(this.instancesDir); } catch (_) { /* non-empty or absent */ }
      }
      throw e;
    }
    const timestamp = now();
    const entry = {
      id,
      name: label,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'created',
      pid: null,
      package: null,
      lastError: '',
      launchToken: null,
    };
    catalog.instances.push(entry);
    try {
      this._writeCatalog(catalog);
    } catch (e) {
      // Only remove the directory just created in this call; no public delete
      // operation exists and an existing/unknown directory is never touched.
      this._removeNewDirectory(context.dataDir);
      if (!instancesExisted) {
        try { this.fs.rmdirSync(this.instancesDir); } catch (_) { /* non-empty or absent */ }
      }
      throw e;
    }
    return this._public(entry);
  }

  _parentApp(pkg) {
    if (typeof this.store.getApp === 'function') return this.store.getApp(pkg);
    if (typeof this.store.getApps === 'function') {
      return this.store.getApps().find((app) => app && app.package === pkg) || null;
    }
    return null;
  }

  _isWithin(root, target) {
    const p = this.path;
    const r = p.normalize(p.resolve(root));
    const t = p.normalize(p.resolve(target));
    const cmpR = this.platform === 'win32' ? r.toLowerCase() : r;
    const cmpT = this.platform === 'win32' ? t.toLowerCase() : t;
    return cmpT === cmpR || cmpT.startsWith(`${cmpR.endsWith(p.sep) ? cmpR : `${cmpR}${p.sep}`}`);
  }

  _realPath(file) {
    if (typeof this.fs.realpathSync !== 'function') return this.path.normalize(this.path.resolve(file));
    return this.fs.realpathSync.native
      ? this.fs.realpathSync.native(file)
      : this.fs.realpathSync(file);
  }

  _sourceApkDir() {
    const configured = this.store && typeof this.store.APK_DIR === 'string' ? this.store.APK_DIR : '';
    if (configured && this.path.isAbsolute(configured)) return configured;
    return this.path.join(this.baseDir, 'apks');
  }

  _verifyManagedFile(file, pkg, bundle, rootDir) {
    if (typeof file !== 'string' || !this.path.isAbsolute(file)) {
      throw errorWithCode('APP_STORAGE_INVALID', `应用 ${pkg} 缺少受管 APK 存储路径`);
    }
    if (typeof rootDir !== 'string' || !this.path.isAbsolute(rootDir)) {
      throw errorWithCode('APP_STORAGE_UNMANAGED', `应用 ${pkg} 缺少受信缓存目录`);
    }
    const source = this.path.normalize(this.path.resolve(file));
    if (!this._isWithin(rootDir, source)) {
      throw errorWithCode('APP_STORAGE_UNMANAGED', `应用 ${pkg} 的 APK 不在受管缓存目录内`);
    }
    let st;
    try {
      if (typeof this.fs.lstatSync === 'function' && this.fs.lstatSync(source).isSymbolicLink()) {
        throw errorWithCode('APP_STORAGE_INVALID', `应用 ${pkg} 的 APK 不能是符号链接`);
      }
      st = this.fs.statSync(source);
    } catch (e) {
      if (e && e.code && e.code !== 'ENOENT') throw e;
      throw errorWithCode('APP_PACKAGE_MISSING', `应用 ${pkg} 的缓存包不存在`, e);
    }
    if (!st || !st.isFile()) throw errorWithCode('APP_PACKAGE_MISSING', `应用 ${pkg} 的缓存包不是文件`);

    let sourceReal;
    let rootReal;
    try {
      sourceReal = this._realPath(source);
      rootReal = this._realPath(rootDir);
    } catch (e) {
      throw errorWithCode('APP_STORAGE_INVALID', `无法核验应用 ${pkg} 的受管缓存路径`, e);
    }
    if (!this._isWithin(rootReal, sourceReal)) {
      throw errorWithCode('APP_STORAGE_UNMANAGED', `应用 ${pkg} 的缓存路径通过链接逃逸受管目录`);
    }

    const ext = this.path.extname(source).toLowerCase();
    if (bundle ? ext !== '.apks' : ext !== '.apk') {
      throw errorWithCode('APP_STORAGE_INVALID', `应用 ${pkg} 的 Installer bundle 标记与文件类型不一致`);
    }
    const prefix = `${safePart(pkg)}-`.toLowerCase();
    if (!this.path.basename(source).toLowerCase().startsWith(prefix)) {
      throw errorWithCode('APP_STORAGE_INVALID', `应用 ${pkg} 的缓存文件名不是 Installer 生成的格式`);
    }
    return { source, bundle: !!bundle };
  }

  _verifyParentPackage(app, pkg) {
    if (!isRecord(app) || app.package !== pkg) {
      throw errorWithCode('APP_PACKAGE_MISSING', `未找到应用包 ${pkg} 的受管记录`);
    }
    const file = app.apkPath;
    const ext = typeof file === 'string' ? this.path.extname(file).toLowerCase() : '';
    const bundle = app.bundle === true || (typeof app.bundle === 'undefined' && ext === '.apks');
    return this._verifyManagedFile(file, pkg, bundle, this._sourceApkDir());
  }

  _readChildApps(context) {
    const file = this.path.join(context.dataDir, 'apps.json');
    let text;
    try {
      text = this.fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
    let data;
    try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (e) {
      throw errorWithCode('INSTANCE_APPS_INVALID', '实例 apps.json 格式损坏', e);
    }
    if (!isRecord(data) || !Array.isArray(data.apps)) {
      throw errorWithCode('INSTANCE_APPS_INVALID', '实例 apps.json 结构无效');
    }
    const apkDir = this.path.join(context.dataDir, 'apks');
    return data.apps.filter((app) => {
      if (!isRecord(app) || !packageName(app.package) || typeof app.apkPath !== 'string') {
        throw errorWithCode('INSTANCE_APPS_INVALID', '实例 apps.json 含非法应用记录');
      }
      if (!this._isWithin(apkDir, app.apkPath)) {
        throw errorWithCode('INSTANCE_APPS_INVALID', '实例应用路径越出隔离 APK 目录');
      }
      return true;
    });
  }

  _safeChildApp(parent, pkg, destination, bundle, previous) {
    const app = isRecord(parent) ? parent : {};
    const pickString = (key, max = 500) => typeof app[key] === 'string' ? app[key].slice(0, max) : '';
    const versionCode = Number.isSafeInteger(app.versionCode) ? app.versionCode : 0;
    const current = isRecord(previous) ? previous : {};
    return {
      ...current,
      package: pkg,
      label: pickString('label', 300) || pkg,
      versionName: pickString('versionName', 200),
      versionCode,
      activity: pickString('activity', 500),
      orientation: /^(portrait|landscape)$/.test(app.orientation) ? app.orientation : '',
      abis: Array.isArray(app.abis) ? app.abis.filter((abi) => typeof abi === 'string').slice(0, 32) : [],
      minSdk: Number.isSafeInteger(app.minSdk) ? app.minSdk : 0,
      sizeBytes: Number.isSafeInteger(app.sizeBytes) ? app.sizeBytes : 0,
      apkPath: destination,
      bundle: !!bundle,
      accent: pickString('accent', 100),
      installedAt: Number.isSafeInteger(current.installedAt) ? current.installedAt : now(),
      updatedAt: now(),
      launchCount: Number.isSafeInteger(current.launchCount) ? current.launchCount : 0,
      lastLaunchAt: Number.isSafeInteger(current.lastLaunchAt) ? current.lastLaunchAt : 0,
      shortcutPath: null,
      bounds: null,
      pinned: false,
    };
  }

  _copyAtomically(source, destination) {
    const dir = this.path.dirname(destination);
    this._mkdir(dir);
    if (typeof this.fs.lstatSync === 'function') {
      try {
        if (this.fs.lstatSync(destination).isSymbolicLink()) {
          throw errorWithCode('INSTANCE_APK_INVALID', '实例目标 APK 不能是符号链接');
        }
      } catch (e) {
        if (e && e.code !== 'ENOENT') throw e;
      }
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let done = false;
    try {
      this.fs.copyFileSync(source, temporary);
      this.fs.renameSync(temporary, destination);
      done = true;
    } finally {
      if (!done) {
        try { this.fs.unlinkSync(temporary); } catch (_) { /* preserve copy error */ }
      }
    }
  }

  _preparePackage(context, pkg) {
    const parent = this._parentApp(pkg);
    const childApps = this._readChildApps(context);
    const previous = childApps.find((app) => app.package === pkg) || null;
    const childApkDir = this.path.join(context.dataDir, 'apks');
    let sourceInfo;
    if (parent) {
      try {
        sourceInfo = this._verifyParentPackage(parent, pkg);
      } catch (e) {
        // A previously copied child cache is usable only after the same managed
        // file/bundle checks; otherwise surface the parent error instead of spawning.
        try {
          if (!previous) throw e;
          sourceInfo = this._verifyManagedFile(
            previous.apkPath, pkg, previous.bundle === true, childApkDir);
        } catch (_) { throw e; }
      }
    } else if (previous) {
      sourceInfo = this._verifyManagedFile(previous.apkPath, pkg, previous.bundle === true, childApkDir);
    } else {
      throw errorWithCode('APP_PACKAGE_MISSING', `未找到应用包 ${pkg} 的受管缓存`);
    }

    const sourceExt = sourceInfo.bundle ? '.apks' : '.apk';
    const destination = this.path.join(
      context.dataDir,
      'apks',
      `${safePart(pkg)}-${safePart(parent && parent.versionCode != null ? Number(parent.versionCode).toString(36) : 'cur')}${sourceExt}`,
    );
    if (sourceInfo.source !== destination) this._copyAtomically(sourceInfo.source, destination);
    const record = this._safeChildApp(parent || previous, pkg, destination, sourceInfo.bundle, previous);
    const next = childApps.filter((app) => app.package !== pkg);
    next.push(record);
    writeJsonAtomicSync(this.path.join(context.dataDir, 'apps.json'), { apps: next }, { fs: this.fs });
    return { record, destination };
  }

  _spawnArgs(pkg) {
    if (this.isPackaged) return ['--launch', pkg];
    return [this.appRoot, '--dev', '--launch', pkg];
  }

  _recordError(id, token, error) {
    try {
      this._update(id, (entry) => {
        if (entry.launchToken === token) {
          const handle = this.owned.get(id);
          const uncertain = handle?.token === token && !handle.exited && positivePid(handle.pid)
            && handle.child.exitCode == null && handle.child.signalCode == null;
          if (uncertain) handle.unconfirmed = true;
          entry.state = uncertain ? 'starting' : 'error';
          entry.pid = uncertain ? handle.pid : null;
          entry.launchToken = uncertain ? token : null;
          entry.lastError = String(error && (error.message || error)).slice(0, ERROR_MAX);
        }
      });
    } catch (_) { /* never turn a child-process event into an unhandled exception */ }
  }

  _attachChild(id, token, child, pkg) {
    const handle = {
      id, token, child, pkg, pid: Number(child && child.pid),
      error: null, exited: false, confirmed: false,
    };
    this.owned.set(id, handle);
    const onError = (error) => {
      handle.error = errorWithCode('SPAWN_FAILED', `实例进程启动失败：${error && error.message ? error.message : error}`, error);
      this._recordError(id, token, handle.error);
    };
    const onExit = (code, signal) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.signal = signal;
      try {
        this._update(id, (entry) => {
          if (entry.launchToken === token) {
            entry.state = handle.confirmed ? 'stopped' : 'error';
            if (!handle.confirmed) entry.lastError = `实例进程启动后立即退出（code=${code}）`;
            entry.pid = null;
            entry.launchToken = null;
          }
        });
      } catch (_) { /* catalog failure must not cause process control */ }
    };
    if (child && typeof child.once === 'function') {
      child.once('error', onError);
      child.once('exit', onExit);
    } else if (child && typeof child.on === 'function') {
      child.on('error', onError);
      child.on('exit', onExit);
    }
    return handle;
  }

  _busyResult(entry, pkg, external = false, unconfirmed = false) {
    const instance = this._public(entry);
    if (external || unconfirmed) {
      return {
        ok: false,
        code: 'INSTANCE_STATE_UNKNOWN',
        error: external
          ? `实例进程（PID ${entry.pid}）不在当前管理器句柄中，无法确认归属；请手动核验后再启动。`
          : '实例进程启动状态未确认；为避免重复启动，已停止自动操作，请手动核验。',
        id: entry.id,
        package: pkg,
        pid: entry.pid,
        state: 'unknown',
        external: !!external,
        needsVerification: true,
        instance,
      };
    }
    return {
      ok: true,
      reused: true,
      external: false,
      id: entry.id,
      package: pkg,
      pid: entry.pid,
      state: instance.state,
      instance,
    };
  }

  /**
   * Launch one package in one instance. Repeated calls for the same id reuse the
   * owned handle (or conservatively report a catalog-owned unknown process) and
   * never scan/kill another process.
   */
  async launch(id, pkg) {
    instanceContext.assertInstanceId(id);
    if (!packageName(pkg)) throw errorWithCode('INVALID_PACKAGE', '非法应用包名');
    this._reconcileOwned();
    this._reconcileCatalog();
    const catalog = this._readCatalog();
    const entry = this._find(catalog, id);
    if (!entry) throw errorWithCode('INSTANCE_NOT_FOUND', `实例不存在：${id}`);

    const owned = this.owned.get(id);
    if (owned && this._handleAlive(owned)) {
      if (owned.unconfirmed) return this._busyResult(entry, pkg, false, true);
      if (owned.pkg !== pkg) throw errorWithCode('INSTANCE_BUSY', '实例已在运行另一个应用');
      return this._busyResult(entry, pkg, false, false);
    }
    if ((entry.state === 'starting' || entry.state === 'running') && positivePid(entry.pid)) {
      if (entry.package && entry.package !== pkg) throw errorWithCode('INSTANCE_BUSY', '实例已在运行另一个应用');
      // A PID from a previous manager is not a capability. Do not attach to it,
      // probe it, or terminate it; avoid creating a duplicate and report it.
      return this._busyResult(entry, pkg, true);
    }
    if (entry.state === 'starting' && !positivePid(entry.pid)) {
      // A crash between catalog writes leaves an ambiguous starting state. Fail
      // closed rather than starting a duplicate whose ownership we cannot prove.
      throw errorWithCode('INSTANCE_BUSY', '实例仍处于未知启动状态，请先查看实例状态');
    }

    const context = this._contextFor(id);
    const prepared = this._preparePackage(context, pkg);
    const token = instanceContext.newInstanceId();
    this._update(id, (record) => {
      record.state = 'starting';
      record.pid = null;
      record.package = pkg;
      record.lastError = '';
      record.launchToken = token;
    });

    const executable = this.executable;
    const args = this._spawnArgs(pkg);
    const childOptions = {
      cwd: this.isPackaged ? this.path.dirname(executable) : this.appRoot,
      env: instanceContext.childEnv(id, this.env),
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: 'ignore',
    };
    let child;
    try {
      child = this.spawn(executable, args, childOptions);
    } catch (e) {
      this._recordError(id, token, e);
      throw errorWithCode('SPAWN_FAILED', `实例进程启动失败：${e.message || e}`, e);
    }
    if (!child || !positivePid(Number(child.pid))) {
      // A failed spawn can still emit an asynchronous 'error'; consume it here so
      // this expected failure never becomes an unhandled EventEmitter error.
      if (child && typeof child.once === 'function') child.once('error', () => {});
      else if (child && typeof child.on === 'function') child.on('error', () => {});
      const e = errorWithCode('SPAWN_FAILED', '实例进程未返回有效 PID');
      this._recordError(id, token, e);
      throw e;
    }
    const handle = this._attachChild(id, token, child, pkg);
    try {
      this._update(id, (record) => {
        if (record.launchToken === token) {
          record.state = 'starting';
          record.pid = handle.pid;
        }
      });
      // Node's ChildProcess emits 'spawn' only after the OS spawn succeeded.
      // Wait for that explicit event; error/exit before it, a missing event API,
      // or a bounded timeout all fail closed. Test doubles must emit 'spawn'
      // exactly like production.
      const outcome = await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const onSpawn = () => finish('spawn');
        const onError = () => finish('error');
        const onExit = () => finish('exit');
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          timer = null;
          if (child && typeof child.removeListener === 'function') {
            child.removeListener('spawn', onSpawn);
            child.removeListener('error', onError);
            child.removeListener('exit', onExit);
          }
        };
        function finish(value) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }
        if (!child || typeof child.once !== 'function') {
          finish('unobservable');
          return;
        }
        child.once('spawn', onSpawn);
        child.once('error', onError);
        child.once('exit', onExit);
        // Keep the deadline referenced until this awaited launch has a result.
        timer = setTimeout(() => finish('timeout'), this.spawnTimeoutMs);
      });
      if (outcome === 'timeout' || outcome === 'unobservable') {
        const e = errorWithCode(
          'SPAWN_UNCONFIRMED',
          outcome === 'timeout'
            ? `未在 ${Math.round(this.spawnTimeoutMs / 1000)} 秒内确认实例进程已启动；请手动核验后再操作`
            : '无法观察实例进程启动事件；请手动核验后再操作',
        );
        handle.unconfirmed = true;
        handle.error = e;
        this._recordError(id, token, e);
        throw e;
      }
      if (outcome === 'error' || handle.error) throw handle.error || errorWithCode('SPAWN_FAILED', '实例进程启动失败');
      if (outcome === 'exit' || handle.exited) {
        const e = errorWithCode('SPAWN_FAILED', '实例进程启动后立即退出');
        this._recordError(id, token, e);
        throw e;
      }
      handle.confirmed = true;
      this._update(id, (record) => {
        if (record.launchToken === token) record.state = 'running';
      });
      const final = this._find(this._readCatalog(), id);
      if (handle.error || handle.exited || !final || final.state !== 'running') {
        const e = errorWithCode('SPAWN_FAILED', '实例进程启动后未能保持运行');
        this._recordError(id, token, e);
        throw e;
      }
      return {
        ok: true,
        id,
        package: pkg,
        pid: handle.pid,
        state: final.state,
        reused: false,
        instance: this._public(final),
        apkPath: prepared.destination,
      };
    } catch (e) {
      if (!handle.exited && positivePid(handle.pid) && !handle.error) {
        // The child may still be alive but its state could not be recorded.
        // Keep the handle as unknown so a retry cannot spawn a duplicate.
        handle.unconfirmed = true;
        handle.error = e;
      }
      this._recordError(id, token, e);
      throw e;
    }
  }

  /** Do not terminate children; only expose handles owned by this manager. */
  dispose() {
    // Removing listeners/handles is deliberately not a kill operation. A child
    // process spawned by a previous manager is never discovered or terminated.
    this.owned.clear();
  }
}

module.exports = {
  CATALOG_VERSION,
  InstanceManager,
};

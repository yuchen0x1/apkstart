'use strict';
/**
 * 受信的多开运行上下文。
 *
 * 这个模块故意只有一个可配置输入：操作系统提供的 APPDATA/XDG_DATA_HOME
 *（以及 HOME 作为规范回退）。不接受 renderer 传入的目录，也不接受任意
 * APKSTART_* root 环境变量。实例目录永远是 baseDir/instances/<validated id>。
 *
 * 主进程在加载 store 前调用 current()/bootstrap()；子进程只需继承
 * APKSTART_INSTANCE_ID，随后同样由 current() 派生自己的数据目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const INSTANCE_ID_ENV = 'APKSTART_INSTANCE_ID';
const CONTEXT_VERSION = 1;

// UUID 是我们生成的默认格式；同时允许短的、路径安全的 opaque token，便于
// 离线测试/迁移旧 catalog。拒绝 .、..、斜杠、控制字符和过长输入即可保证
// 它只能成为一个目录名，不能改变目录层级。
const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

let cached = null;

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isAbsoluteFor(platform, value) {
  const p = pathApi(platform);
  return p.isAbsolute(value);
}

function normalizeAbsolute(platform, value) {
  const p = pathApi(platform);
  return p.normalize(value);
}

/**
 * Return the application data root used by the parent process.
 *
 * @param {string} platform process.platform-compatible value
 * @param {object} env environment map (only the standard keys are read)
 * @param {string} home home directory fallback
 */
function baseDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  const plat = String(platform || process.platform);
  const e = env && typeof env === 'object' ? env : {};
  const p = pathApi(plat);
  const h = cleanString(home);
  let root = '';

  if (plat === 'win32') {
    const appData = cleanString(e.APPDATA);
    // APPDATA is an OS-provided absolute path. A relative value is ignored rather
    // than resolved against cwd, which would turn a hostile env value into a write
    // outside the normal user profile.
    root = appData && isAbsoluteFor(plat, appData)
      ? appData
      : (isAbsoluteFor(plat, h) ? p.join(h, 'AppData', 'Roaming') : '');
  } else if (plat === 'linux') {
    const xdg = cleanString(e.XDG_DATA_HOME);
    root = xdg && isAbsoluteFor(plat, xdg)
      ? xdg
      : (isAbsoluteFor(plat, h) ? p.join(h, '.local', 'share') : '');
  } else if (plat === 'darwin') {
    const xdg = cleanString(e.XDG_DATA_HOME);
    root = xdg && isAbsoluteFor(plat, xdg)
      ? xdg
      : (isAbsoluteFor(plat, h) ? p.join(h, 'Library', 'Application Support') : '');
  } else {
    const xdg = cleanString(e.XDG_DATA_HOME);
    root = xdg && isAbsoluteFor(plat, xdg)
      ? xdg
      : (isAbsoluteFor(plat, h) ? p.join(h, '.local', 'share') : '');
  }

  // A real process always has an absolute home. Throwing here is safer than
  // silently falling back to cwd if a test or a tampered environment supplies
  // no usable system base.
  const normalized = root ? normalizeAbsolute(plat, root) : '';
  if (!normalized || !isAbsoluteFor(plat, normalized)
    || normalized === p.parse(normalized).root) {
    const error = new Error('无法确定 ApkStart 的系统数据目录');
    error.code = 'INVALID_BASE_DATA_DIR';
    throw error;
  }
  return p.join(normalized, 'apkstart');
}

/** Return true only for an instance id that is safe as one path component. */
function validateInstanceId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 96
    && INSTANCE_ID_RE.test(value)
    && value !== '.'
    && value !== '..';
}

function assertInstanceId(value) {
  if (!validateInstanceId(value)) {
    const error = new TypeError('非法实例 ID');
    error.code = 'INVALID_INSTANCE_ID';
    throw error;
  }
  return value;
}

function cloneEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env && typeof env === 'object' ? env : {})) {
    if (typeof value === 'undefined' || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Remove inherited code-injection and runtime-routing variables before spawning
 * a child instance. The child receives only its validated opaque id; its paths
 * are recomputed from the standard OS base by instance-context itself.
 */
function childEnv(instanceId, env = process.env) {
  const id = assertInstanceId(instanceId);
  const out = cloneEnv(env);

  const blockedExact = [
    INSTANCE_ID_ENV,
    'APKSTART_BASE_DIR',
    'APKSTART_DATA_DIR',
    'APKSTART_ROOT',
    'APKSTART_RUNTIME_DIR',
    'APKSTART_AVD_DIR',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'NODE_REDIRECT_WARNINGS',
    'NODE_V8_COVERAGE',
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'ANDROID_AVD_HOME',
    'ANDROID_EMULATOR_HOME',
    'ANDROID_ADB_SERVER_PORT',
    'ADB_SERVER_SOCKET',
    'ANDROID_SERIAL',
    'ANDROID_DEVICE_ID',
    'QT_PLUGIN_PATH',
    'QT_QPA_PLATFORM_PLUGIN_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'PYTHONPATH',
    'PYTHONHOME',
    'RUBYLIB',
    'PERL5LIB',
    'CLASSPATH',
  ];
  for (const key of blockedExact) delete out[key];

  // Do not carry arbitrary APKSTART_* switches from a parent shell. This also
  // covers future path-like variables added by mistake.
  for (const key of Object.keys(out)) {
    if (/^APKSTART_/i.test(key)) delete out[key];
  }
  out[INSTANCE_ID_ENV] = id;
  return out;
}

function makeContext({ platform = process.platform, env = process.env, home = os.homedir(), instanceId } = {}) {
  const plat = String(platform || process.platform);
  const p = pathApi(plat);
  const baseDir = baseDataDir(plat, env, home);
  const supplied = typeof instanceId === 'undefined'
    ? (env && Object.prototype.hasOwnProperty.call(env, INSTANCE_ID_ENV)
      ? env[INSTANCE_ID_ENV] : '')
    : instanceId;
  const rawId = cleanString(supplied);
  if (rawId && !validateInstanceId(rawId)) {
    const error = new TypeError('APKSTART_INSTANCE_ID 无效');
    error.code = 'INVALID_INSTANCE_ID';
    throw error;
  }
  const id = rawId || null;
  const isChild = !!id;
  const instancesDir = p.join(baseDir, 'instances');
  const dataDir = isChild ? p.join(instancesDir, id) : baseDir;
  const userDataDir = isChild ? p.join(dataDir, 'chromium') : baseDir;
  const avdDir = p.join(dataDir, 'avd');
  // Child share a read-only runtime; parent keeps the canonical default
  // base/runtime location. Never derive this from an APKSTART_* env value.
  const sharedRuntimeDir = p.join(baseDir, 'runtime');
  // All returned paths are derived values. No caller-supplied path is retained
  // in the object, making it safe to pass to trusted main-process wiring.
  const context = {
    version: CONTEXT_VERSION,
    isChild,
    id,
    baseDir,
    dataDir,
    userDataDir,
    avdDir,
    instancesDir,
    catalogFile: p.join(instancesDir, 'catalog.json'),
    runtimeDir: sharedRuntimeDir,
    sharedRuntimeDir,
    platform: plat,
  };
  return Object.freeze(context);
}

/** Resolve a context without changing the process-wide lazy cache. */
function resolveContext(options = {}) {
  if (!options || typeof options !== 'object') options = {};
  return makeContext(options);
}

/** Lazily derive and cache the only context for this process. */
function current() {
  if (!cached) cached = makeContext();
  return cached;
}

/** Explicit bootstrap hook for main/child entrypoints; intentionally idempotent. */
function bootstrap() {
  return current();
}

/** Test-only cache reset; does not mutate process.env or any filesystem state. */
function resetForTests() {
  cached = null;
}

function newInstanceId() {
  let id = randomUUID();
  // randomUUID is already safe; keep the guard in case a test stubs crypto.
  while (!validateInstanceId(id)) id = randomUUID();
  return id;
}

function isPackageName(value) {
  return typeof value === 'string' && PACKAGE_RE.test(value);
}

module.exports = {
  CONTEXT_VERSION,
  INSTANCE_ID_ENV,
  baseDataDir,
  validateInstanceId,
  assertInstanceId,
  isPackageName,
  resolveContext,
  current,
  bootstrap,
  childEnv,
  newInstanceId,
  resetForTests,
};

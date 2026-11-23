'use strict';
/**
 * 运行时自举（Provisioning）
 *
 * ApkStart 不依赖任何第三方模拟器：adb、QEMU、系统镜像全部由自己下载/校验/管理。
 * 所有运行时文件都放在 %APPDATA%\apkstart\runtime 下，保证在任何安装位置都可写。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const platform = require('./platform');
const { download, downloadAny, downloadAnyParallel, head } = require('./download');
const { ZipArchive, ZipFile, crc32 } = require('./zip');
const { Sources } = require('./sources');
const { ImageStore } = require('./images');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
// 宿主 → 官方产物名 / 默认镜像 ABI 的唯一出处（见 src/core/host/profile.js）。
// 之前的写法是 `HOST_TAG = IS_WIN ? 'windows' : IS_LINUX ? 'linux' : 'mac'` 再拼 `_x64`，
// 有两处真实缺陷：macOS 官方前缀是 `darwin` 不是 `mac`；`_x64` 写死导致 Apple Silicon
// 永远解析不到 `emulator-darwin_aarch64-N.zip`。现在统一由 hostProfile 决定。
const hostProfile = require('./host/profile');
const HOST_EMULATOR_PREFIX = hostProfile.emulatorArchivePrefix();
const HOST_SYSIMG_ABI = hostProfile.defaultSysimgAbi() || 'x86_64';

// 提权包的版本和 SHA-256 必须由发布方独立核验并一同固定，不能取自镜像、设置或缓存。
const AEHD_ARCHIVE_URL = 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip';
const AEHD_ARCHIVE_SHA256 = ''; // 尚无可信摘要；保持禁用。

const SOURCES = {
  adbIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Google 官方 SDK 索引：emulator 与系统镜像的真实地址从这里动态解析，不写死版本号
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  ],
  aehdFallback: AEHD_ARCHIVE_URL,
  // 兜底：索引不可用时直接用的已知版本（Linux 版与 Windows 版共用同一版本号，
  // 实测记录见 docs/PLATFORM-LINUX-VALIDATION.md）
  emulatorFallback: IS_WIN
    ? 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip'
    : IS_LINUX
      ? 'https://dl.google.com/android/repository/emulator-linux_x64-16847572.zip'
      : 'https://dl.google.com/android/repository/emulator-darwin_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip',
  // ARM 兼容镜像（Google Play 版，内置 native bridge）
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2（x86_64）：仅在用户已自备 ISO 时使用
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
};

/**
 * SDK 索引里的 <url> 是相对路径，基准目录各不相同：
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * 所以基准目录一律取「索引文件自身所在目录」。此前直接拿文件名当 URL 会抛 Invalid URL。
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

/**
 * Linux 上 emulator 常缺的系统库 → 发行版包名（Ubuntu/Debian 命名）。
 * ldd 点名后按这张表翻译成 apt 命令；表外的库按库名去 .so 后缀兜底。
 */
const LIB_PKG = {
  'libpulse.so.0': 'libpulse0',
  'libX11.so.6': 'libx11-6',
  'libX11-xcb.so.1': 'libx11-xcb1',
  'libXext.so.6': 'libxext6',
  'libXi.so.6': 'libxi6',
  'libXrandr.so.2': 'libxrandr2',
  'libXfixes.so.3': 'libxfixes3',
  'libXdamage.so.1': 'libxdamage1',
  'libXcomposite.so.1': 'libxcomposite1',
  'libXcursor.so.1': 'libxcursor1',
  'libxcb.so.1': 'libxcb1',
  'libGL.so.1': 'libgl1',
  'libEGL.so.1': 'libegl1',
  'libgbm.so.1': 'libgbm1',
  'libasound.so.2': 'libasound2t64',
};

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * 只保留一份「通用基础镜像」。
 * 旧版默认 AOSP API30 + 可选 API34 Play 兼容镜像，导致：
 *   - 用户装国产 ARM 应用时必然失败，还要手动切镜像（实用门槛）；
 *   - 两份镜像各 0.6~3GB，运行时目录动辄十几 GB；
 *   - 切换镜像要 wipe-data，已装应用全丢。
 * 现在默认使用 Android 14 Google Play x86_64：x86 应用、ARM 应用、GMS 都能跑，
 * 全机只存一份只读基础层（容器式共享），按需下载一次即可。Google APIs / AOSP
 * 仍作为可显式选择的独立档位保留。
 */
const IMAGE_PROFILES = Object.freeze({
  google_apis: {
    id: 'google_apis', api: '34', tag: 'google_apis', abi: 'x86_64',
    avd: 'apkstart-googleapis', label: 'Google APIs', shortLabel: 'Google APIs（无 Play 商店）',
    gms: true, playStore: false, armTranslation: true,
    fallback: 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip',
    index: 'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  },
  default: {
    id: 'default', api: '34', tag: 'default', abi: 'x86_64',
    avd: 'apkstart-aosp', label: '纯 AOSP', shortLabel: '纯 AOSP（无 Google）',
    gms: false, playStore: false, armTranslation: false,
    fallback: '',
    index: 'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
  },
  google_apis_playstore: {
    id: 'google_apis_playstore', api: '34', tag: 'google_apis_playstore', abi: 'x86_64',
    avd: 'apkstart', label: 'Google Play', shortLabel: 'Google Play（兼容模式）',
    gms: true, playStore: true, armTranslation: true,
    fallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
    index: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  },
});
const PLAY_SYSIMG = IMAGE_PROFILES.google_apis_playstore;
// 发布运行时、README 与旧版兼容数据都以 Google Play 为默认档位；Google APIs
// 与纯 AOSP 仍可在设置里显式选择，并使用各自独立的 AVD。
const DEFAULT_SYSIMG = IMAGE_PROFILES.google_apis_playstore;

function normalizeImageFlavor(flavor) {
  const key = String(flavor || '').trim().toLowerCase();
  if (key === 'aosp' || key === 'pure' || key === 'default') return 'default';
  if (key === 'play' || key === 'playstore' || key === 'google_play'
    || key === 'google_apis_playstore') return 'google_apis_playstore';
  // 显式选择 Google APIs 时保留它；空值/未知值回到默认 Google Play 档。
  if (key === 'google_apis' || key === 'apis' || key === 'gms') return 'google_apis';
  return 'google_apis_playstore';
}

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    // spawn 本身也可能抛（不只看 callback 里的 err）：Windows 安全软件把 exe 拉黑时
    // execFile 会同步抛 EPERM，`sc query aehd` 这类系统命令在被策略拦截时也会。
    // 以前这会把整条探测链（加速检测 / 版本检测）一起打断，设置页直接空白。
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const fail = (err) => fin({
      ok: false, code: (err && err.code) || 1, stdout: '', stderr: String((err && err.message) || ''), error: err,
    });
    try {
      const cp = execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        fin({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
      });
      if (cp && typeof cp.on === 'function') cp.on('error', fail);
    } catch (e) {
      fail(e);
    }
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * 这个镜像目录里有没有「压缩存放、还没展开」的系统镜像。
 *
 * 完整版（安装包内置运行时）把 system.img 以 .xz 带走，首次启动由
 * materializeImages() 展开。判断「镜像在不在」如果只认 system.img，
 * 就会把「已经随包带来、只是还没解压」误判成「没下载」——用户刚装完新版本
 * 就被引导去 dl.google.com 重下 1.4GB（0.6.13 实测现场）。
 */
function packedImage(dir) {
  for (const name of ['system.img.xz', 'system.img.gz']) {
    const file = path.join(dir, name);
    const size = fileSize(file);
    // 太小的只可能是半截文件/占位，不当作可用镜像
    if (size > 64 * 1024 * 1024) return { file, size };
  }
  return null;
}

/**
 * 环境探测结果的落盘缓存。
 *
 * `emulator -version` 与 `emulator -accel-check` 每次都要新起一个 emulator 进程，
 * 在 Windows 上实测 1~3 秒；而这两项在「引擎/驱动没变」时结果恒定。
 * 以前只在内存里缓存 30 秒，等于每次冷启动都要重付一遍，而且这几秒正好卡在
 * 用户点开应用的那一刻。这里按「exe 大小+修改时间 + AEHD 驱动时间 + WHPX 组件」
 * 做指纹落到 %APPDATA%，软硬件一换自动失效。
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // 加速「不可用」只信 10 分钟：用户可能刚去开了虚拟化
// 加速结论的结构版本：旧缓存里没有 aehd 服务状态 / suspect 标记，
// 升级后必须重新探测一次，否则旧结论会把「驱动在、服务没跑」这个真问题盖住 6 小时。
const ACCEL_CACHE_VER = 2;

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

// 实例角色固定于进程启动；之后清理/修改环境变量不能让子实例变成维护主实例。
// instance-context.current() 只从启动时的此标识派生实例，主实例无需提前加载它。
const HAS_INSTANCE_ID = !!(process.env && Object.prototype.hasOwnProperty.call(process.env, 'APKSTART_INSTANCE_ID'));
function childRuntimeContext() {
  if (!HAS_INSTANCE_ID) return null;
  const context = require('./instance-context').current();
  return context.isChild ? context : null;
}
function runtimeReadOnly(operation) {
  const err = new Error(`子实例的共享运行时只读，不能${operation}；请回主实例维护运行时后重试。`);
  err.code = 'INSTANCE_RUNTIME_READ_ONLY';
  return err;
}
function assertRuntimeWritable(operation) {
  if (childRuntimeContext()) throw runtimeReadOnly(operation);
}
function insidePath(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function canonicalFuturePath(target) {
  let cur = path.resolve(target);
  const tail = [];
  while (!fs.lstatSync(cur, { throwIfNoEntry: false })) {
    const parent = path.dirname(cur);
    if (parent === cur) throw runtimeReadOnly('解析独立数据目录');
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}
function assertPrivateInstancePath(context, target) {
  // 即使旧配置/链接仍指向父实例，也不能利用“准备目录/环境缓存”写穿隔离边界。
  if (!context.dataDir || !context.avdDir || !context.instancesDir
    || !path.isAbsolute(context.dataDir) || !path.isAbsolute(context.avdDir)
    || path.relative(path.resolve(context.dataDir), path.resolve(store.DATA_DIR)) !== ''
    || path.relative(path.resolve(context.instancesDir), path.dirname(path.resolve(context.dataDir))) !== ''
    || !fs.lstatSync(context.instancesDir, { throwIfNoEntry: false })?.isDirectory()
    || !insidePath(context.dataDir, context.avdDir) || !insidePath(context.dataDir, target)) {
    throw runtimeReadOnly('使用非本实例的数据目录');
  }
  const rel = path.relative(path.resolve(context.dataDir), path.resolve(target));
  let cur = path.resolve(context.dataDir);
  const candidates = [path.resolve(context.instancesDir), cur];
  for (const part of rel.split(path.sep).filter(Boolean)) { cur = path.join(cur, part); candidates.push(cur); }
  for (const candidate of candidates) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat && stat.isSymbolicLink()) throw runtimeReadOnly('通过符号链接或 junction 修改数据');
  }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
    this._images = null;
  }

  /** 双源/镜像的统一入口（测速缓存也在这里，多个组件共用一份） */
  get sources() {
    return this._sources;
  }

  /**
   * 自定义镜像适配层。
   * 运行时目录可以被用户在设置里改来改去，所以 root 一变就重建一个实例，
   * 避免记录还指向上一个运行时目录下的 custom-images。
   */
  get images() {
    const root = this.root;
    if (!this._images || this._images.root !== root) {
      this._images = new ImageStore({
        root,
        extractZip: (zipPath, dest, opts) => this.extractZip(zipPath, dest, opts),
      });
    }
    return this._images;
  }

  /**
   * 当前生效的自定义镜像。
   * 没配置 → { ok:true, custom:false }；配了但坏了 → { ok:false, custom:true, reason }。
   * 任何异常都退化成「用默认镜像」，绝不让镜像层的问题挡住开机。
   */
  activeImage() {
    try {
      return this.images.active();
    } catch (e) {
      return { ok: false, custom: false, id: '', reason: e.message };
    }
  }

  /** 缓存指纹：引擎文件与加速驱动任一变化就换 key */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const context = childRuntimeContext();
      if (context) assertPrivateInstancePath(context, envCacheFile());
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const context = childRuntimeContext();
      if (context) assertPrivateInstancePath(context, envCacheFile());
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* 首次 */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* 缓存写不进去不影响主流程 */ }
  }

  /** 开机失败（加速/镜像类问题）时调用：下次启动重新探测，避免一直用错的结论 */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try {
      const context = childRuntimeContext();
      if (context) assertPrivateInstancePath(context, envCacheFile());
      fs.rmSync(envCacheFile(), { force: true });
    } catch (_) { /* 缓存失败不影响探测，但不能写穿实例边界 */ }
  }

  // ---------------- 路径 ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    const explicit = r && r.trim() ? r.trim() : '';
    // Linux 上绝不接受 Windows 风格的运行时目录（盘符开头）—— 那是从 Windows 配置
    // 抄过来/手滑填进来的垃圾值，拿去当根会在 WSL 里解析成相对路径（实测出现
    // "D:/my-runtime"）。一律回落默认数据目录。
    if (IS_LINUX && /^[a-zA-Z]:[\\/]/.test(explicit)) return path.join(store.DATA_DIR, 'runtime');
    return explicit || path.join(store.DATA_DIR, 'runtime');
  }

  /** 当前内置系统镜像档位。自定义镜像仍由 ImageStore 独立管理。 */
  imageProfile(flavor = null) {
    const selected = normalizeImageFlavor(flavor || (store.getSettings().runtime || {}).systemImageFlavor);
    const base = IMAGE_PROFILES[selected] || DEFAULT_SYSIMG;
    // 按宿主架构覆盖 ABI：ARM64 宿主必须用 arm64-v8a 镜像（x86_64 镜像在 arm64
    // 上跑不起来，是指令集问题而不是性能问题）；x64 宿主维持 x86_64（含 ARM 转译层）。
    // Apple silicon 与 ARM64 Linux 都走这条，避免「下载了 x86_64 镜像再黑屏」。
    // 只在档位未显式指定 ABI 时才覆盖，保证已有自定义/旧配置不被静默改写。
    const hostAbi = HOST_SYSIMG_ABI;
    if (!hostAbi || base.abi === hostAbi) return base;
    // 兜底 URL 里的文件名也带 ABI（…/x86_64-34_r14.zip），必须一起换掉，
    // 否则索引不可用时会去下一份架构不对的镜像。
    const arm64 = hostAbi === 'arm64-v8a';
    const fallback = base.fallback && arm64
      ? base.fallback.replace(/\/x86_64-(\d+)/, '/arm64-v8a-$1')
      : base.fallback;
    return {
      ...base,
      abi: hostAbi,
      // ARM 镜像本身就是 ARM，不存在「在 ARM 镜像里转译 ARM」这回事。
      armTranslation: base.armTranslation && hostAbi === 'x86_64',
      fallback,
    };
  }

  imageProfiles() {
    return Object.values(IMAGE_PROFILES).map((p) => ({ ...p }));
  }

  paths() {
    const root = this.root;
    const profile = this.imageProfile();
    const sysTag = profile.tag;
    const sysApi = profile.api;
    const sysAbi = profile.abi;
    // AVD（含用户数据、已装应用、quickboot 快照）必须落在可写且不会被清理的地方。
    // 单文件发行版的运行时是随包解压到临时目录的，把 AVD 放进去等于每次退出都丢应用。
    // 只要运行时目录不在 %APPDATA% 里，就把 AVD 固定指到用户数据目录。
    // 另外：允许在设置里单独指定「安卓数据目录」——它才是真正吃盘的地方
    // （6~24GB 数据分区 + 2~3GB 快照），只挪运行时、不挪它，C 盘一样会满。
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const dataRel = path.relative(path.resolve(store.DATA_DIR), path.resolve(root));
    const insideData = dataRel === '' || (dataRel !== '..'
      && !dataRel.startsWith(`..${path.sep}`) && !path.isAbsolute(dataRel));
    // 系统镜像放哪儿：**运行时目录优先**。
    // 之前的顺序是「用户数据目录优先」，后果是——用户把运行时目录改到 D 盘省 C 盘空间，
    // 1.4GB 的整包解到 D 盘以后，materializeImages 又把 3.3GB 的 system.img 展开回
    // C://Users//...//AppData//Roaming//apkstart//system-images，C 盘照样被吃掉，而且
    // 同一套镜像在两处各存一份（实测 1.2GB + 3.3GB 并存）。
    // 现在：运行时目录里已经有 system-images（整包解压的产物）就用它；
    // 没有才回退到用户数据目录（老版本、单文件发行版都是这种布局）。
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // 三种情况：
    //  1) 运行时目录里已经有镜像（整包解压的产物）→ 用它的；
    //  2) 老用户/单文件发行版把镜像放在用户数据目录 → 用那里的；
    //  3) 全新安装（两处都没有）→ 落在运行时目录，因为用户数据目录可能是被
    //     重定向过的临时目录（CI 组装运行时就是这种情况，写歪会直接校验失败）。
    const sysRoot = fs.existsSync(rootImg) ? rootImg : (fs.existsSync(dataImg) ? dataImg : rootImg);
    // Windows 的可执行文件带 .exe；Linux 的 adb/qemu/emulator 都是裸名
    const exeSuffix = IS_WIN ? '.exe' : '';
    return {
      root,
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', `qemu-system-x86_64${exeSuffix}`),
      qemuImg: path.join(root, 'qemu', `qemu-img${exeSuffix}`),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', `adb${exeSuffix}`),
      // emulator 运行时（Google 官方）：root 同时充当 ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', `emulator${exeSuffix}`),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      // 自定义镜像的索引与（ZIP 导入时）副本都放这里，绝不与默认镜像目录混在一起
      customImagesDir: path.join(root, 'custom-images'),
      avdHome: explicitAvd || (insideData ? path.join(root, 'avd') : writable),
      aehdDir: path.join(root, 'aehd'),
      imagesDir: path.join(root, 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(root, '_tmp'),
      sysTag, sysApi, sysAbi,
      sysFlavor: profile.id,
      sysLabel: profile.shortLabel,
      sysAvd: profile.avd,
    };
  }

  ensureDirs() {
    const p = this.paths();
    const context = childRuntimeContext();
    if (context) {
      assertPrivateInstancePath(context, context.dataDir);
      assertPrivateInstancePath(context, context.avdDir);
      if (path.relative(path.resolve(context.avdDir), path.resolve(p.avdHome)) !== ''
        || insidePath(p.root, context.dataDir) || insidePath(context.dataDir, p.root)
        || !fs.statSync(p.root, { throwIfNoEntry: false })?.isDirectory()) {
        throw runtimeReadOnly('创建或修复共享运行时目录/非独立 AVD');
      }
      const shared = fs.realpathSync(p.root);
      const privateData = canonicalFuturePath(context.dataDir);
      if (insidePath(shared, privateData) || insidePath(privateData, shared)) {
        throw runtimeReadOnly('使用与共享运行时重叠的数据目录');
      }
      // 不为共享 root 创建 qemu/platform-tools/images/_tmp，连 mkdir 的 no-op 也不做。
      fs.mkdirSync(context.dataDir, { recursive: true });
      assertPrivateInstancePath(context, context.avdDir);
      fs.mkdirSync(context.avdDir, { recursive: true });
      return p;
    }
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return p;
  }

  /**
   * 新版 emulator 不再随包带 Qt 的软件 OpenGL 插件。窗口要跨进程嵌入 Electron
   * 时，缺它会回退到系统 OpenGL，失焦/被遮挡后可能整块黑屏。开发目录、便携版
   * 和安装版都把同一份 LGPL DLL 放在 appRoot/build/vendor；组件下载完成后补到
   * emulator 根目录，确保「只下载官方分组件」的用户也得到同样的兼容性修复。
   */
  ensureSoftwareOpenGL() {
    const p = this.paths();
    // opengl32sw.dll 是给「窗口嵌入」兜底用的 Windows DLL；Linux 不做嵌入，无需此补丁
    if (!IS_WIN) return false;
    const target = path.join(p.emulatorDir, 'opengl32sw.dll');
    if (childRuntimeContext()) {
      if (fs.existsSync(p.emulatorExe) && fileSize(target) > 1024 * 1024) return true;
      throw runtimeReadOnly('补齐共享 emulator/OpenGL 组件');
    }
    if (!fs.existsSync(p.emulatorExe)) return false;
    if (fileSize(target) > 1024 * 1024) return true;
    const candidates = [
      path.join(this.appRoot, 'build', 'vendor', 'opengl32sw.dll'),
      path.join(this.appRoot, 'vendor', 'opengl32sw.dll'),
    ];
    const source = candidates.find((f) => fileSize(f) > 1024 * 1024);
    if (!source) return false;
    try {
      fs.mkdirSync(p.emulatorDir, { recursive: true });
      fs.copyFileSync(source, target);
      const notices = [
        path.join(this.appRoot, 'build', 'vendor', 'Qt-LGPL-3.0.txt'),
        path.join(this.appRoot, 'vendor', 'Qt-LGPL-3.0.txt'),
      ];
      const notice = notices.find((f) => fs.existsSync(f));
      if (notice) fs.copyFileSync(notice, path.join(p.emulatorDir, 'Qt-LGPL-3.0.txt'));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 磁盘守卫：在下载 / 解压一份大体积组件之前，先确认目标盘有足够可用空间。
   * 否则会下到一半把系统盘撑爆，或解压阶段直接失败（且残留半截文件）。
   * 预留 1GB 缓冲：模拟器/镜像解压后还有快照、用户数据分区会持续膨胀。
   * @param {string} component 组件名（决定所需空间估算）
   * @param {string} targetDir 写入目录（据此定位所在盘）
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // 运行时整包：1.5GB 压缩包 + 展开后 ~3.3GB 镜像，峰值同时存在
      runtime: 5000,
      // 自定义镜像 ZIP 包：解压后与压缩包峰值同时存在
      image: 4000,
    }[component] || 512; // MB
    const buf = 1024; // 额外预留 1GB（快照 / 数据分区 / 解压中间文件）
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `目标磁盘空间不足：该组件约需 ${need + buf} MB，但「${dir}」所在盘仅剩 ${free} MB。\n`
        + '建议：把「运行时数据目录」改到空间更大的盘（设置 → 系统集成 → 运行时数据目录 → 浏览），'
        + '或先清理磁盘 / 卸载不用的应用后再试。',
      );
    }
    return free;
  }

  // ---------------- 环境检查 ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (IS_LINUX) {
      const kvm = platform.acceleration();
      this._hypervisor = {
        whpx: false,
        kvm: kvm.ok,
        note: kvm.ok
          ? '检测到 /dev/kvm：KVM 硬件加速可用'
          : (kvm.hint || '未检测到 /dev/kvm'),
      };
      return this._hypervisor;
    }
    if (process.platform === 'darwin') {
      // macOS：加速走 Hypervisor.framework（HVF），没有 /dev/kvm、也没有 WHPX/AEHD。
      // 这里只给「机制」结论，可用性仍由 emulatorAccel() 的 -accel-check 裁定。
      this._hypervisor = {
        whpx: false,
        hvf: true,
        note: 'macOS 使用 Hypervisor.framework（HVF）硬件加速（可用性由运行时引擎检测）',
      };
      return this._hypervisor;
    }
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: '当前平台没有已实现的硬件加速检测' }; return this._hypervisor; }
    // 只做毫秒级的文件检查。真正"WHPX 是否可用"由 emulator -accel-check 给出权威答案，
    // 避免在这里拉起 PowerShell（冷启动 1-2 秒）拖慢每次状态轮询。
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // 由 emulatorAccel() 覆盖为真实值
      dll,
      hypervisorPresent: false,
      note: dll
        ? '虚拟机平台组件存在（可用性由运行时引擎检测）'
        : '未检测到 Windows Hypervisor Platform 组件：可在「启用或关闭 Windows 功能」中勾选「虚拟机平台」后重启',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // 30s 缓存，避免状态轮询频繁拉起外部进程
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', path.basename(adbExe))];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // winget 默认安装位置
      path.join(this.appRoot, 'engine', 'qemu', path.basename(p.qemuExe)),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    // Linux：qemu 来自发行版包管理器（qemu-system-x86 / qemu-utils），在 PATH 里
    // 直接探测 —— 没有 .exe 那种固定文件位置可查。
    if (IS_LINUX) {
      const r = await run('qemu-system-x86_64', ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: 'qemu-system-x86_64', version: m ? m[1] : (r.stdout || '').split('\n')[0].trim(), system: true };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** 校验 ISO9660 主卷描述符（偏移 0x8001 处的 "CD001"），防止把错误页/半截文件当镜像 */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: '未下载' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // 用户导入的 raw/已装磁盘镜像不含 ISO 引导区，按尺寸放行
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `文件只有 ${(size / 1048576).toFixed(1)}MB，下载未完成`
        : '文件不是有效的 ISO9660 镜像（可能是下载到错误页或文件已损坏）';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const image = this.systemImageInfo();
    const sysimg = childRuntimeContext() && (!image.ok || image.pendingExtract)
      ? { ...image, ok: false, note: '共享系统镜像尚未就绪，子实例不会下载或展开；请回主实例维护后重试' }
      : image;
    // 自定义镜像的状态单独给出：ok=false + custom=true 表示「用户启用了自定义镜像，
    // 但它现在不可用（目录被移走/文件缺失）」，此时运行时会回落默认镜像。
    const activeImage = this.activeImage();

    // 当前档位必须有自己的镜像才算就绪。Google Play 旧 AVD 仍单独报告，
    // 但不能拿它冒充 Google APIs / AOSP，避免切档后错误接管旧用户数据。
    const compatReady = this.playImageInfo().ok;
    const emulatorReady = emulator.ok && sysimg.ok;
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : '未安装' },
      sysimg: {
        ok: sysimg.ok,
        dir: sysimg.dir,
        size: sysimg.size,
        api: sysimg.api,
        abi: sysimg.abi || this.imageProfile().abi,
        flavor: sysimg.flavor || this.imageProfile().id,
        label: sysimg.label || this.imageProfile().shortLabel,
        // 当前跑的是不是自定义镜像：设置页与修复窗口据此显示镜像来源
        custom: !!sysimg.custom,
        // 镜像随运行时提供、只是还没展开：界面据此显示「首次启动自动展开」，
        // 而不是催用户再下一次 1.4GB。
        pendingExtract: !!sysimg.pendingExtract,
        imageId: sysimg.id || '',
        required: false,
        note: sysimg.custom
          ? sysimg.note
          : (sysimg.ok
            ? (sysimg.pendingExtract
              ? (sysimg.note || '已随运行时提供，首次启动自动展开')
              : `Android ${sysimg.api}（${(sysimg.size / 1073741824).toFixed(2)} GB）`)
            : (sysimg.note || `未下载：${this.imageProfile().shortLabel}`)),
      },
      activeImage,
      playImage: this.playImageInfo(),
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : '未下载',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : '尚未创建',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    assertRuntimeWritable('安装 adb');
    const { resolveAdbComponent, verifyComponent } = require('./runtime-integrity');
    onProgress({ stage: 'resolve', message: '读取 Google 官方 platform-tools 版本及校验值…', percent: 1 });
    // 不读取设置/镜像/旧缓存里的摘要，也不回退到没有摘要的 latest URL。
    const component = await resolveAdbComponent(process.platform, process.arch);
    if (component.size < MIN_SIZE.adb) throw new Error('Google 官方 platform-tools 归档大小异常，已拒绝安装');
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const stage = fs.mkdtempSync(path.join(p.tmp, 'adb-'));
    const zipPath = path.join(stage, 'platform-tools.zip');
    try {
      onProgress({ stage: 'download', message: `下载 Android platform-tools ${component.version}…`, percent: 2 });
      await downloadAny(this._downloadUrls(component.url), zipPath, {
        expectSha1: component.checksum.algorithm === 'sha1' ? component.checksum.value : undefined,
        expectSha256: component.checksum.algorithm === 'sha256' ? component.checksum.value : undefined,
        onProgress: (pr) => onProgress({
          stage: 'download',
          message: `下载 adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
          percent: pr.percent,
          speed: pr.speed,
        }),
      });
      onProgress({ stage: 'extract', message: '校验并解压 adb…', percent: 92 });
      // 在解压边界强制校验，不能只依赖下载器的可选 expectSha* 参数。
      await verifyComponent(zipPath, component);
      await this.extractZip(zipPath, p.root);
      this._adbCache = null;
      const v = await this.adbVersion();
      if (!v.ok || v.path !== p.adbExe) {
        throw new Error(IS_WIN
          ? 'adb 解压后无法运行，请检查是否被杀毒软件拦截'
          : 'adb 解压后无法运行：请确认解压目录可写、文件有执行权限（可重试一次安装）');
      }
      store.saveSettings({ adbPath: v.path });
      this._cache.adbVersion = v.version;
      onProgress({ stage: 'done', message: `adb ${v.version} 就绪`, percent: 100 });
      return v;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  /**
   * 从本地导入运行时整包。适用于离线部署、内网机器和下载反复中断的情况；
   * 导入包与 Release 中的 ApkStart-runtime-<tag>.zip 使用同一目录布局。
   */
  async importRuntimePack(zipPath, onProgress = () => {}) {
    assertRuntimeWritable('导入运行时整包');
    const p = this.ensureDirs();
    const file = path.resolve(String(zipPath || ''));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error('运行时整包文件不存在');
    }
    if (!/\.zip$/i.test(file)) throw new Error('运行时整包必须是 ZIP 文件');
    const size = fileSize(file);
    if (size < 200 * 1024 * 1024) {
      throw new Error(`运行时整包体积过小（${(size / 1048576).toFixed(1)}MB），可能不是完整运行时`);
    }
    await this.guardDisk('runtime', p.root);
    onProgress({ stage: 'extract', message: '正在导入本地运行时整包…', percent: 2 });
    await this.extractZip(file, p.root, {
      onEntry: (_name, done, all) => {
        if (done % 50 === 0 || done === all) {
          onProgress({ stage: 'extract', message: `导入运行时 ${done}/${all}`, percent: Math.min(92, 2 + Math.round((done / Math.max(1, all)) * 90)) });
        }
      },
    });
    onProgress({ stage: 'extract', message: '展开系统镜像…', percent: 94 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 96 }));
    this.ensureSoftwareOpenGL();
    const env = await this.checkEnv();
    if (!env.emulator.ok || !env.sysimg.ok) {
      throw new Error(`导入后校验失败：${!env.emulator.ok ? '模拟器不可用' : ''}${!env.emulator.ok && !env.sysimg.ok ? '，' : ''}${!env.sysimg.ok ? '系统镜像缺失' : ''}`);
    }
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: path.basename(file), imported: true, at: new Date().toISOString(),
      }));
    } catch (_) { /* 标记写不进去不影响使用 */ }
    onProgress({ stage: 'done', message: '本地运行时已就绪', percent: 100 });
    return { ok: true, path: file, root: p.root };
  }

  /**
   * 下载地址候选：直连优先，其次镜像前缀。
   * 走 Sources 统一处理，好处是「自动镜像（ghfast / gh-proxy）」与用户自定义前缀
   * 只在一个地方维护，且能和多线程下载共用同一份测速缓存。
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    assertRuntimeWritable('解压运行时组件');
    // 大包（emulator / 系统镜像）走文件版：不把 1.5GB zip 整包读进内存，
    // 低内存机器也能稳定解压；小包沿用内存版，速度更快。
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    // zip-slip 防护：压缩包条目名是不受信任输入，`../`、绝对路径、盘符都能把
    // 写入点搬到目标目录之外。所有条目一律先规范化并确认落在 destDir 内。
    const destRoot = path.resolve(destDir);
    const within = (root, target) => {
      const rel = path.relative(root, target);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    const assertNoLinks = (target) => {
      let cur = destRoot;
      for (const part of ['', ...path.relative(destRoot, target).split(path.sep).filter(Boolean)]) {
        if (part) cur = path.join(cur, part);
        try {
          if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(`解压路径包含符号链接或 junction：${cur}`);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    };
    const readVerified = (name) => {
      const data = zip.read(name);
      const entry = zip.entries.get(name);
      if (data.length !== entry.uncompSize) throw new Error(`条目大小不符：${name}`);
      if (crc32(data) !== entry.crc) throw new Error(`条目校验失败（CRC 不匹配）：${name}`);
      return data;
    };
    const safeTarget = (name) => {
      const cleaned = String(name).replace(/\\/g, '/');
      if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('/')) {
        throw new Error(`压缩包内含绝对路径条目，已拒绝解压：${name}`);
      }
      const parts = cleaned.split('/').filter((s) => s.length > 0);
      if (parts.some((s) => s === '..' || (IS_WIN && (/[. ]$|[:<>"|?*\x00-\x1f]/.test(s)
        || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(s))))) {
        throw new Error(`压缩包内含不安全的路径条目，已拒绝解压：${name}`);
      }
      const target = path.resolve(destRoot, ...parts);
      if (!within(destRoot, target) || (target === destRoot && !name.endsWith('/'))) {
        throw new Error(`压缩包条目越界，已拒绝解压：${name}`);
      }
      return target;
    };

    const dirs = [];
    const files = [];
    const targets = new Set();
    const key = (p) => IS_WIN ? p.toLowerCase() : p;
    try {
      if (total !== zip.expectedEntries) throw new Error('ZIP 中央目录不完整或包含重复条目');
      assertNoLinks(destRoot);
      fs.mkdirSync(destRoot, { recursive: true });
      const stage = fs.mkdtempSync(path.join(destRoot, '.apkstart-extract-'));
      const committed = [];
      const createdDirs = [];
      let keepStage = false;
      const mkdir = (dir) => {
        if (dir === destRoot) return;
        assertNoLinks(dir);
        mkdir(path.dirname(dir));
        try { fs.mkdirSync(dir); createdDirs.push(dir); }
        catch (e) { if (e.code !== 'EEXIST' || !fs.lstatSync(dir).isDirectory()) throw e; }
      };
      try {
        for (const name of zip.names()) {
          const target = safeTarget(name);
          assertNoLinks(target);
          if (targets.has(key(target))) throw new Error(`压缩包目标路径重复：${name}`);
          targets.add(key(target));
          const e = zip.entries.get(name);
          const temp = path.join(stage, `entry-${done}`);
          if (name.endsWith('/') && !e.uncompSize && !e.symlink) {
            readVerified(name);
            dirs.push(target);
          } else if (name.endsWith('/')) {
            throw new Error(`压缩包目录条目不合法：${name}`);
          } else if (e.symlink && !IS_WIN) {
            const link = String(readVerified(name));
            const resolved = path.resolve(path.dirname(target), link);
            if (!link || /^[a-zA-Z]:/.test(link) || path.isAbsolute(link) || !within(destRoot, resolved)) {
              throw new Error(`压缩包内符号链接越界，已拒绝解压：${name} → ${link}`);
            }
            assertNoLinks(resolved);
            fs.symlinkSync(link, temp);
            files.push({ temp, target });
          } else {
            if (e.uncompSize > STREAM_THRESHOLD) {
              // eslint-disable-next-line no-await-in-loop
              await zip.pipeTo(name, fs.createWriteStream(temp, { flags: 'wx' }), { verify: true });
            } else {
              fs.writeFileSync(temp, readVerified(name), { flag: 'wx' });
            }
            if (!IS_WIN && (e.unixMode & 0o111)) fs.chmodSync(temp, e.unixMode & 0o777);
            files.push({ temp, target });
          }
          done += 1;
          if (opts.onEntry) opts.onEntry(name, done, total);
        }

        // 校验完成才发布；遇到提交错误则还原此前移动的原文件。
        for (const dir of dirs) mkdir(dir);
        for (const { temp, target } of files) {
          assertNoLinks(target);
          mkdir(path.dirname(target));
          const saved = path.join(stage, `old-${committed.length}`);
          const change = { target, saved: '', installed: false };
          committed.push(change);
          let old;
          try { old = fs.lstatSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (old) {
            if (!old.isFile()) throw new Error(`解压目标不是普通文件：${target}`);
            fs.renameSync(target, saved);
            change.saved = saved;
          }
          fs.renameSync(temp, target);
          change.installed = true;
        }
      } catch (e) {
        const rollbackErrors = [];
        for (const { target, saved, installed } of committed.reverse()) {
          try {
            if (installed) fs.rmSync(target, { force: true });
            if (saved) fs.renameSync(saved, target);
          } catch (err) { rollbackErrors.push(err); }
        }
        for (const dir of createdDirs.reverse()) {
          try { fs.rmdirSync(dir); } catch (_) { /* 只删本次新建且仍为空的目录 */ }
        }
        if (rollbackErrors.length) {
          keepStage = true;
          throw new AggregateError([e, ...rollbackErrors], `解压失败且回滚不完整，原文件保留在 ${stage}`);
        }
        throw e;
      } finally {
        if (!keepStage) fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator（Google 官方运行时） ----------------

  /**
   * 抓取一段 XML 文本（带大小上限，索引文件约 400KB）。
   * 必须保证 promise 一定会 settle：res.destroy() 之后 'end'/'error' 都不触发
   * （只发 'close'），没有 close 兜底的话部署向导会永久卡死；同时加整体超时。
   */
  async _fetchText(url, limit = 2 * 1024 * 1024, timeoutMs = 30000, headers = {}) {
    const { openStream } = require('./download');
    const res = await openStream(url, { headers });
    return new Promise((resolve, reject) => {
      let d = '';
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(v);
      };
      const timer = setTimeout(() => {
        try { res.destroy(); } catch (_) { /* ignore */ }
        finish(reject, new Error(`索引下载超时（${timeoutMs}ms）：${url}`));
      }, timeoutMs);
      res.on('data', (c) => {
        d += c;
        if (d.length > limit) {
          try { res.destroy(); } catch (_) { /* ignore */ }
          finish(reject, new Error(`索引响应体超过 ${limit} 字节上限：${url}`));
        }
      });
      res.on('end', () => finish(resolve, d));
      res.on('error', () => finish(resolve, d));
      res.on('close', () => finish(resolve, d));   // destroy 后的兜底
    });
  }

  /**
   * 从一段 <remotePackage> XML 里解析 <complete> 块中的 url + checksum。
   * 官方索引里每个 archive 自带 sha1，校验值就躺在已经解析过的那份文本里 ——
   * 之前只抓 url 把 checksum 丢掉，等于整条供应链裸奔（下载物还要被提权执行）。
   */
  _parseArchiveEntries(blockXml, base) {
    const out = [];
    const re = /<complete>([\s\S]*?)<\/complete>/g;
    let m;
    while ((m = re.exec(String(blockXml || '')))) {
      const seg = m[1];
      const urlM = /<url>([^<]+)<\/url>/.exec(seg);
      if (!urlM) continue;
      const sumM = /<checksum[^>]*>([^<]+)<\/checksum>/.exec(seg);
      out.push({ url: absUrl(urlM[1], base), sha1: sumM ? sumM[1].trim().toLowerCase() : '' });
    }
    return out;
  }

  /** 从 SDK 索引里动态解析最新的 Windows emulator 包地址 */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        // emulator 包按「宿主_架构」分叉，官方真实前缀只有四种：
        //   windows_x64 / linux_x64 / darwin_x64 / darwin_aarch64
        // 用 hostProfile 给出的真实前缀匹配（不再写死 `_x64`，也不再拼错的 `mac`）。
        // 该宿主没有官方 emulator 发行物（例如 linux/arm64）时前缀为空串：
        // 此时**不**去下载别的架构的包，直接落到兜底地址，由调用方按
        // hostFacts.emulatorAvailable=false 给出明确提示。
        const prefixRe = HOST_EMULATOR_PREFIX
          ? new RegExp(`${HOST_EMULATOR_PREFIX}-\\d+\\.zip$`, 'i')
          : null;
        const entries = this._parseArchiveEntries(block[0], base)
          .filter((x) => (prefixRe ? prefixRe.test(x.url) : false));
        const win = entries.find((x) => x.sha1) || entries[0];
        if (win) {
          this._cache.emulatorUrl = win.url;
          this._cache.emulatorSha1 = win.sha1 || '';
          return win.url;
        }
      }
    } catch (_) { /* 落兜底 */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    this._cache.emulatorSha1 = '';
    return SOURCES.emulatorFallback;
  }

  /** 从 sys-img 索引里解析默认 AOSP 系统镜像地址 */
  async resolveSysimgUrl() {
    const profile = this.imageProfile();
    const runtime = store.getSettings().runtime || {};
    const cached = runtime.sysimgUrl;
    // 旧版本只有一个 sysimgUrl；没有 flavor 标记时仅把它视为 Google APIs
    // 的旧缓存，不能让切到 AOSP/Play 后误用另一档下载地址。
    if (cached && cached.trim() && runtime.sysimgFlavor === profile.id) {
      return absUrl(cached, baseOf(profile.index || SOURCES.sysImgIndexes[0]));
    }
    if (this._cache.sysimgUrl && this._cache.sysimgFlavor === profile.id) return this._cache.sysimgUrl;
    const want = `system-images;android-${profile.api};${profile.tag};${profile.abi}`;
    const indexes = [profile.index, ...SOURCES.sysImgIndexes, SOURCES.playImgIndex].filter((x, i, a) => x && a.indexOf(x) === i);
    for (const idx of indexes) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          // 按当前档位的真实 ABI 过滤（arm64 宿主用 arm64-v8a，x64 宿主用 x86_64）。
          // 以前写死 x86_64，ARM64 宿主永远解析不到自己的镜像。
          const abiRe = new RegExp(`${profile.abi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.zip$`, 'i');
          const entries = this._parseArchiveEntries(block[0], base)
            .filter((x) => abiRe.test(x.url));
          // 与 resolveEmulatorUrl 统一：取带校验值的最后一条（即最新版本）
          const hit = entries.filter((x) => x.sha1).pop() || entries[entries.length - 1];
          if (hit) {
            this._cache.sysimgUrl = hit.url;
            this._cache.sysimgSha1 = hit.sha1 || '';
            this._cache.sysimgFlavor = profile.id;
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* 换下一个索引 */ }
    }
    this._cache.sysimgUrl = profile.fallback || '';
    this._cache.sysimgSha1 = '';
    this._cache.sysimgFlavor = profile.id;
    return this._cache.sysimgUrl;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', path.basename(p.emulatorExe))];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // 上一次会话探测过、且引擎文件没变：直接用落盘结果（省掉一次 1s+ 的进程拉起）
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * 首次启动把随包带来的压缩镜像展开到用户目录（只做一次）。
   * 单文件发行版里 system.img 是 .gz（3.1GB→580MB 左右），不展开模拟器没法用。
   * 展开到 %APPDATA% 而不是包里：便携版的运行时目录每次启动都是新的临时目录，
   * 放进去等于每次开机都重解压一遍。
   */
  async materializeImages(onLog = () => {}) {
    if (childRuntimeContext()) {
      const image = this.systemImageInfo();
      if (image.ok && !image.pendingExtract) return 0;
      throw runtimeReadOnly('展开或补齐共享系统镜像');
    }
    const srcRoot = path.join(this.root, 'system-images');
    // 展开目标必须和 paths().sysImgRoot 用同一套规则，否则会出现
    // 「整包解到 D 盘、镜像又展开回 C 盘 APPDATA」的重复占用（实测 1.2GB + 3.3GB）。
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // 压缩镜像之外的文件（kernel-ranchu / ramdisk / 未压缩 .img 等）必须一并落到展开目录
    const found = new Map(); // dest -> job（同镜像 .xz/.gz 并存时优先 .xz）
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // 支持 .img.xz（LZMA2，体积比 .gz 小 ~25%）和旧的 .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // 先补齐非镜像文件（模拟器靠 kernel-ranchu 等定位/引导，缺了会报"还差系统镜像"）
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // 原地展开，无需复制
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`复制镜像组件失败：${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // 判断「已经展开过」不能只看 32MB：旧版没有 .part，被中断后可能留下
      // 几百 MB 的半截镜像，阈值一过就被当成完成，开机时炸在系统镜像损坏上。
      // 真实镜像解压后一定比压缩包大，所以「小于压缩包大小」= 必然没展开完。
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // 先解到 .part，成功后再改名：解压中途被打断（关程序 / 断电 / 磁盘满）
      // 不会留下一个「看着像已完成」的半截 system.img，否则下次会跳过展开、
      // 开机时死在镜像损坏上，用户只能删数据重来。
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`首次启动：正在展开系统镜像 ${path.basename(j.dest)}（约 1 分钟，只需一次）`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2 解压：必须直接引原生绑定 index.js。
            // 包默认入口 main.js / xz.js 内部会 require('stream-polyfill.mjs')，
            // Electron 内置 Node 不一定支持 require(ESM)，而 exports 又不允许
            // 直接写 '@napi-rs/lzma/index.js'，所以用 require.resolve 定位目录后按文件路径引。
            const path0 = require('path');
            const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // 不能再静默吞掉：调用方（一键部署 / 开机）必须知道镜像没展开成功，
        // 否则会「用官方源再下一套 1.4GB」或者直接开机失败。
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`展开镜像失败：${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`系统镜像展开失败（${failures.join('；')}）`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /** 系统镜像是否完整（system.img 是硬指标，缺失或过小都视为没下完） */
  systemImageInfo() {
    const p = this.paths();
    // 自定义镜像优先：用户既然明确启用了它，检查的就是它。
    // 但它不可用时**不在这里报错**，而是静默回落到默认镜像并把原因留在 activeImage() 里 ——
    // 镜像目录被误删/移走不该让整台机器开不了机。
    const act = this.activeImage();
    if (act && act.ok && act.custom) {
      return {
        ok: true, custom: true, id: act.id, name: act.name,
        dir: act.dir, size: act.size, api: act.api, tag: act.tag, abi: act.abi,
        note: `自定义镜像 ${act.name}（Android ${act.api} · ${act.abi}）`,
      };
    }
    const profile = this.imageProfile();
    // 只检查当前选中的内置档位。旧版「随便挑一套已有镜像」会让设置页显示
    // Google APIs、实际却接管 Google Play AVD，导致应用数据和界面状态串台。
    const candidates = [
      p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${profile.api}`, profile.tag, profile.abi),
    ];
    let missing = null;
    for (const dir of candidates) {
      const system = path.join(dir, 'system.img');
      const kernel = path.join(dir, 'kernel-ranchu');
      const size = fileSize(system);
      const api = profile.api;
      const tag = profile.tag;
      const abi = profile.abi;
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return {
          ok: true, dir, size, api, tag, abi,
          flavor: profile.id, label: profile.shortLabel,
          googleServices: { gms: profile.gms, playStore: profile.playStore },
          armTranslation: { enabled: profile.armTranslation },
        };
      }
      // 镜像压缩着、还没展开：算「已提供」，不能算「未下载」。
      // 开机前 engine 会先 materializeImages() 展开，不需要联网。
      const packed = packedImage(dir);
      if (packed && fs.existsSync(kernel)) {
        return {
          ok: true, pendingExtract: true, dir, size: packed.size, api, tag, abi,
          flavor: profile.id, label: profile.shortLabel,
          googleServices: { gms: profile.gms, playStore: profile.playStore },
          armTranslation: { enabled: profile.armTranslation },
          note: `Android ${api}（随运行时提供，首次启动自动展开）`,
        };
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, flavor: profile.id, note: size ? '镜像不完整' : '缺少 system.img' };
      }
    }
    if (missing) return missing;
    return {
      ok: false, dir: p.sysImgDir, size: 0, api: profile.api, tag: profile.tag,
      abi: profile.abi, flavor: profile.id, label: profile.shortLabel, note: '未下载',
    };
  }

  /**
   * 硬件加速状态。
   * emulator 在 Windows 上支持两种加速：WHPX（系统功能，需重启）与 AEHD（Google 自家驱动，装完即用）。
   */
  async emulatorAccel({ force = false } = {}) {
    // 状态轮询每几秒一次，而 -accel-check 要拉起一个 emulator 进程，必须缓存。
    // force：刚做过修复（启动 AEHD 服务 / 开了 WHPX 功能）时必须绕开缓存复测，
    // 否则会拿着 30 秒前的旧结论说「还是不可用」，白让用户再试一次。
    if (!force && this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', path.basename(p.emulatorExe));
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: '未安装 emulator' };

    // 落盘缓存：冷启动时不再为这一项拉起 emulator 进程。
    // 「不可用」结论只信 10 分钟 —— 用户可能刚去开了虚拟化/装了 AEHD，要能立刻反映。
    const cached = force ? null : this.envCacheGet(exe);
    if (cached && cached.accel && cached.accel.v === ACCEL_CACHE_VER) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    // 非 Windows：Linux 用 /dev/kvm，macOS 用 Hypervisor.framework（HVF）。
    // 两者都能复用 emulator 的 `-accel-check`（输出与 Windows 同构），但**种类标签**与
    // 修复提示不同：在 macOS 上把它标成 'kvm' 会给用户一条在 macOS 上根本不存在的
    // 「加入 kvm 组」建议。这里按宿主区分 kind 与提示文案。
    if (!IS_WIN) {
      const r = await run(exe, ['-accel-check'], { timeout: 30000 });
      const text = `${r.stdout}${r.stderr}`;
      const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);
      const isMacHost = process.platform === 'darwin';
      const backend = isMacHost ? 'hvf' : 'kvm';
      const kvm = isMacHost ? null : platform.acceleration();
      let result;
      if (usable) {
        result = {
          ok: true,
          kind: backend,
          note: isMacHost ? 'Hypervisor.framework 硬件加速已启用' : 'KVM 硬件加速已启用',
        };
      } else {
        result = {
          ok: false,
          kind: 'none',
          viaTcg: true,
          kvmOk: kvm ? !!kvm.ok : undefined,
          note: isMacHost
            ? 'Hypervisor.framework 不可用：确认是受支持的 Mac 硬件，且没有把模拟器跑在嵌套虚拟化里'
            : (kvm.ok
              ? 'KVM 就绪但模拟器报告加速不可用（多为权限问题：确认当前用户在 kvm 组里）'
              : (kvm.hint || '没有可用的硬件虚拟化（KVM 不可用），只能走软件模拟')),
        };
      }
      result.v = ACCEL_CACHE_VER;
      this._cache.accel = result;
      this._cache.accelAt = Date.now();
      this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
      return result;
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = await this._accelResult(kind);
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // 部分精简运行时包会漏掉 emulator-check.exe，导致 -accel-check 无法给出结论。
      // 此时只要 AEHD 驱动已安装，就按「可用」处理：启动时 emulator 自己会挂载驱动，
      // 避免被误判成无加速而强行 -accel off（软件模拟在部分机器上会直接崩溃）。
      result = await this._accelResult('aehd', 'AEHD 硬件加速已启用（emulator-check 缺失，按驱动判定）');
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = await this._accelResult('aehd', 'AEHD 硬件加速已启用（仅凭驱动文件判定）');
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX 硬件加速已启用' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: '未启用硬件加速：将回退软件模拟（能跑但很慢）。建议安装 AEHD 驱动或开启「虚拟机平台」',
      };
    }
    result.v = ACCEL_CACHE_VER;
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /**
   * AEHD 驱动服务到底在不在跑。
   *
   * 为什么不能只看 `aehd.sys` 是否存在：AEHD 与 Hyper-V / 内存完整性 / Credential Guard
   * 冲突时，驱动文件齐全、`-accel-check` 也可能给出「可用」，但服务根本没启动。
   * 这种机器的现场是：检测说有加速 → 点开应用 → emulator 打印完 Userspace boot properties
   * 就以退出码 1 静默退出（日志里一条 ERROR 都没有），最后只能报 UNKNOWN。
   *
   * 只查服务状态（毫秒级、不需要管理员）。sc 在中文系统上输出是 GBK，但状态名
   * RUNNING / STOPPED 是 ASCII，按「: 4  RUNNING」这种形态解析不受编码影响。
   */
  async aehdService() {
    if (process.platform !== 'win32') return null;
    for (const name of ['aehd', 'gvm']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await run('sc.exe', ['query', name], { timeout: 6000 });
      const text = `${r.stdout || ''}${r.stderr || ''}`;
      // 服务不存在（1060）时换下一个名字
      if (/1060|does not exist|指定的服务/i.test(text)) continue;
      // sc 本身起不来（极简系统 / 被安全软件拦）：没有结论就不要硬造结论
      if (!/SERVICE_NAME|STATE|状态/i.test(text)) continue;
      const m = /:\s*(\d+)\s+(RUNNING|STOPPED|START_PENDING|STOP_PENDING|PAUSED|CONTINUE_PENDING)/i.exec(text);
      const exit = /WIN32_EXIT_CODE\s*:\s*(\d+)/i.exec(text);
      return {
        name,
        state: m ? m[2].toUpperCase() : 'UNKNOWN',
        code: m ? Number(m[1]) : 0,
        running: m ? m[2].toUpperCase() === 'RUNNING' : false,
        exitCode: exit ? Number(exit[1]) : null,
      };
    }
    return null;
  }

  /**
   * 组装加速结论。
   *
   * AEHD「装了但服务没在跑」时仍然返回 ok:true —— 不能因此让用户白换成软件模拟
   * （部分机器上 TCG 反而必崩），但必须打上 suspect 标记并说清怎么修，
   * 让启动失败时的诊断能直接落到 ACCEL_UNUSABLE，而不是一句 UNKNOWN。
   */
  async _accelResult(kind, note = '') {
    const base = note || (kind === 'whpx' ? 'WHPX 硬件加速已启用' : 'AEHD 硬件加速已启用');
    if (kind !== 'aehd') return { ok: true, kind, note: base };
    const svc = await this.aehdService();
    const result = { ok: true, kind, aehd: svc || null, note: base };
    if (svc && !svc.running) {
      result.suspect = true;
      result.note = `AEHD 驱动已安装但服务未运行（${svc.state}`
        + `${svc.exitCode ? `，退出码 0x${(Number(svc.exitCode) >>> 0).toString(16)}` : ''}）`;
      result.advice = '请在「设置 → 性能与资源」点「一键开启硬件加速」改用 WHPX（Windows 虚拟机平台），'
        + '完成后重启电脑。AEHD 与 Hyper-V / 内存完整性 / Credential Guard 冲突时服务起不来，'
        + '而模拟器的检查阶段看不出这一点 —— 表现就是「说有加速，点开却直接退出」。';
    }
    return result;
  }

  /**
   * Linux：ldd 检查 emulator 与 qemu 后端缺哪些系统库（点名列出，最多 6 个）。
   * 只在 emulator 跑不起来时调用，正常路径零开销。
   */
  _linuxMissingLibs() {
    try {
      const p = this.paths();
      const emuDir = path.dirname(p.emulatorExe);
      const targets = [
        path.join(emuDir, 'emulator'),
        path.join(emuDir, 'qemu', 'linux-x86_64', 'qemu-system-x86_64'),
      ].filter((f) => fs.existsSync(f));
      const missing = new Set();
      for (const f of targets) {
        const r = spawnSync('ldd', [f], { encoding: 'utf8', timeout: 15000 });
        for (const line of String(r.stdout || '').split('\n')) {
          if (!/not found/.test(line)) continue;
          const lib = line.trim().split(/\s+/)[0];
          if (lib) missing.add(lib);
        }
      }
      return [...missing].slice(0, 6);
    } catch (_) {
      return [];
    }
  }

  /** 下载并安装 emulator（zip 顶层就是 emulator/，直接解到 SDK root） */
  async installEmulator(onProgress = () => {}) {
    assertRuntimeWritable('安装 emulator');
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    // 索引里带的官方 sha1：镜像前缀换源不影响内容（同一文件的转发），校验仍有效
    const sha1 = this._cache.emulatorSha1 || '';
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: '下载运行时引擎（约 440MB，走 Google 官方源）…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      expectSha1: sha1 || undefined,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载运行时引擎 ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    if (fileSize(zip) < MIN_SIZE.emulator) throw new Error('运行时引擎下载不完整，可重试续传');

    onProgress({ stage: 'extract', message: '解压运行时引擎…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // 运行时引擎安装完成后补齐 Qt 软件 OpenGL 插件，避免只有官方组件下载路径
    // 时仍然在嵌入窗口里回退到容易失焦黑屏的系统 OpenGL。
    this.ensureSoftwareOpenGL();

    // SDK root 必须同时具备 platform-tools，否则 emulator 拒绝启动
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) {
      if (IS_WIN) {
        throw new Error('emulator 解压后无法运行，请检查是否被杀毒软件拦截');
      }
      // Linux 常见故障是缺系统库（libpulse / X11 / GL...），ldd 一趟就能点名
      const missing = this._linuxMissingLibs();
      if (missing.length) {
        throw new Error('emulator 缺少系统库（' + missing.join('、') + '）：'
          + '请安装后重试，Ubuntu/Debian 对应命令一般为 '
          + '`sudo apt install ' + missing.map((m) => LIB_PKG[m] || m.split('.so')[0]).join(' ') + '`');
      }
      throw new Error('emulator 解压后无法运行：请确认解压目录可写、文件有执行权限（可重试一次安装）');
    }
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `运行时引擎 ${v.version} 就绪`, percent: 100 });
    return v;
  }

  /** emulator 要求 SDK root 下有 platform-tools 目录，否则直接 FATAL */
  ensurePlatformTools() {
    const p = this.paths();
    if (childRuntimeContext()) {
      const files = IS_WIN ? [path.basename(p.adbExe), 'AdbWinApi.dll', 'AdbWinUsbApi.dll'] : [path.basename(p.adbExe)];
      if (files.every((name) => fs.statSync(path.join(p.adbDir, name), { throwIfNoEntry: false })?.isFile())) return true;
      throw runtimeReadOnly('补齐共享 platform-tools');
    }
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const adbName = path.basename(p.adbExe);
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, adbName)));
    if (!src) return false;
    // Windows 版 platform-tools 还要两根 ADB DLL；Linux 版只有一个 adb 可执行文件
    const files = IS_WIN ? [adbName, 'AdbWinApi.dll', 'AdbWinUsbApi.dll'] : [adbName];
    for (const f of files) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** 下载当前选中的内置系统镜像档位。 */
  async installSystemImage(onProgress = () => {}) {
    assertRuntimeWritable('安装系统镜像');
    const profile = this.imageProfile();
    const ready = this.imageInfo(profile.id);
    if (ready.ok) return ready;
    return this.installImage(profile.id, onProgress);
  }

  /** 某个内置系统镜像是否已就位。 */
  imageInfo(flavor = null) {
    const profile = this.imageProfile(flavor);
    const p = this.paths();
    const root = p.sysImgRoot;
    const dir = path.join(root, `android-${profile.api}`, profile.tag, profile.abi);
    const size = fileSize(path.join(dir, 'system.img'));
    if (size > MIN_SIZE.sysimg && fs.existsSync(path.join(dir, 'kernel-ranchu'))) {
      return {
        ok: true, dir, size, api: profile.api, tag: profile.tag, abi: profile.abi,
        flavor: profile.id, label: profile.shortLabel,
        googleServices: { gms: profile.gms, playStore: profile.playStore },
        armTranslation: { enabled: profile.armTranslation },
      };
    }
    // 同上：压缩存放的镜像（.xz / .gz）是「已提供、待展开」，不是「未下载」
    const packed = packedImage(dir);
    if (packed && fs.existsSync(path.join(dir, 'kernel-ranchu'))) {
      return {
        ok: true, pendingExtract: true, dir, size: packed.size, api: profile.api,
        tag: profile.tag, abi: profile.abi,
        flavor: profile.id, label: profile.shortLabel,
        googleServices: { gms: profile.gms, playStore: profile.playStore },
        armTranslation: { enabled: profile.armTranslation },
        note: `Android ${profile.api}（随运行时提供，首次启动自动展开）`,
      };
    }
    return {
      ok: false, dir, size, api: profile.api, tag: profile.tag, abi: profile.abi,
      flavor: profile.id, label: profile.shortLabel, note: size ? '镜像不完整' : '未下载',
    };
  }

  /** ARM 兼容镜像（Google Play 版）是否已就位，保留给旧安装流程。 */
  playImageInfo() { return this.imageInfo('google_apis_playstore'); }

  /** 解析 Google Play 版镜像地址（<url> 相对索引文件所在目录） */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    const profile = this.imageProfile('google_apis_playstore');
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      // 用当前宿主的真实档位（含按架构覆盖后的 ABI），不再引用写死 x86_64 的 PLAY_SYSIMG。
      const want = `system-images;android-${profile.api};${profile.tag};${profile.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const abiRe = new RegExp(`${profile.abi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.zip$`, 'i');
        const entries = this._parseArchiveEntries(block[0], base)
          .filter((x) => abiRe.test(x.url));
        const hit = entries.filter((x) => x.sha1).pop() || entries[entries.length - 1];
        if (hit) {
          this._cache.playUrl = hit.url;
          this._cache.playSha1 = hit.sha1 || '';
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* 落兜底 */ }
    this._cache.playUrl = profile.fallback || SOURCES.playImgFallback;
    this._cache.playSha1 = '';
    return this._cache.playUrl;
  }

  /** 下载并安装指定内置镜像。 */
  async installImage(flavor = null, onProgress = () => {}) {
    assertRuntimeWritable('安装系统镜像');
    const profile = this.imageProfile(flavor);
    const p = this.ensureDirs();
    await this.guardDisk(profile.id === 'google_apis_playstore' ? 'playimg' : 'sysimg', p.sysImgRoot);
    const url = profile.id === 'google_apis_playstore' ? await this.resolvePlayUrl() : await this.resolveSysimgUrl();
    const sha1 = profile.id === 'google_apis_playstore' ? (this._cache.playSha1 || '') : (this._cache.sysimgSha1 || '');
    if (!url) throw new Error(`找不到 ${profile.shortLabel} 的官方系统镜像地址`);
    const zip = path.join(p.tmp, `${profile.id}-sysimg.zip`);
    onProgress({ stage: 'download', message: `下载${profile.shortLabel}（Android ${profile.api}，约 1.5GB）…`, percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      expectSha1: sha1 || undefined,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `下载${profile.shortLabel} ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    if (fileSize(zip) < MIN_SIZE.sysimg) throw new Error('系统镜像下载不完整，可重试续传');

    const dest = path.join(p.sysImgRoot, `android-${profile.api}`, profile.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: `解压${profile.shortLabel}（约 3GB，需十余秒）…`, percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `解压${profile.shortLabel} ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.imageInfo(profile.id);
    if (!info.ok) throw new Error(`${profile.shortLabel} 解压后校验失败`);
    onProgress({ stage: 'done', message: `${profile.shortLabel}就绪，重新启动运行时即可生效`, percent: 100 });
    return info;
  }

  /** 旧 IPC/安装流程仍调用这个名字，语义固定为 Google Play 档。 */
  async installPlayImage(onProgress = () => {}) {
    assertRuntimeWritable('安装 Google Play 镜像');
    return this.installImage('google_apis_playstore', onProgress);
  }

  /** 下载 AEHD 驱动（小文件）；安装需要管理员权限，交给引导流程。Windows 专有。 */
  async installAehd(onProgress = () => {}) {
    assertRuntimeWritable('安装 AEHD 驱动');
    if (!IS_WIN) throw new Error('AEHD 驱动仅限 Windows；Linux 的硬件加速由 /dev/kvm 提供，无需驱动');
    if (!/^[0-9a-f]{64}$/i.test(AEHD_ARCHIVE_SHA256)) {
      const err = new Error('已拒绝安装 AEHD：没有固定的可信 SHA-256，不会下载或准备提权安装器。'
        + '请启用 Windows 虚拟机监控程序平台（WHPX），或按 Google 官方说明手动安装驱动。');
      err.code = 'AEHD_UNVERIFIED';
      throw err;
    }
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const stage = fs.mkdtempSync(path.join(p.tmp, 'aehd-'));
    const zip = path.join(stage, 'aehd.zip');
    const extracted = path.join(stage, 'payload');
    const installer = 'silent_install.bat';
    try {
      onProgress({ stage: 'download', message: '下载 AEHD 驱动…', percent: 10 });
      await downloadAnyParallel(this._downloadUrls(AEHD_ARCHIVE_URL), zip, {
        connections: 2,
        expectSha256: AEHD_ARCHIVE_SHA256,
      });
      // 校验归档后只解到空目录，不能混入旧目录里的脚本/依赖并误认为已校验。
      await this.extractZip(zip, extracted);
      if (![installer, 'aehd.sys'].every((name) => fs.lstatSync(path.join(extracted, name), { throwIfNoEntry: false })?.isFile())) {
        throw new Error('校验后的 AEHD 驱动包缺少安装脚本或驱动文件');
      }
      if (fs.lstatSync(p.aehdDir, { throwIfNoEntry: false })) {
        throw new Error('无法发布已校验的 AEHD 驱动包：请先移走运行时中已有的 AEHD 目录');
      }
      fs.renameSync(extracted, p.aehdDir);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    }
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'AEHD 驱动已就绪，需管理员权限安装', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** 只解析固定可信版本；目录页、用户 URL 或缓存不能决定待执行文件的摘要。 */
  async resolveQemuUrl() {
    const { resolveQemuComponent } = require('./runtime-integrity');
    return resolveQemuComponent((store.getSettings().runtime || {}).qemuUrl, process.platform, process.arch).url;
  }

  async installQemu(onProgress = () => {}) {
    assertRuntimeWritable('安装 QEMU');
    const { resolveQemuComponent, verifyComponent, qemuManualHelp } = require('./runtime-integrity');
    const component = resolveQemuComponent((store.getSettings().runtime || {}).qemuUrl, process.platform, process.arch);
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const stage = fs.mkdtempSync(path.join(p.tmp, 'qemu-'));
    const setup = path.join(stage, 'qemu-setup.exe');
    try {
      onProgress({ stage: 'download', message: `下载已固定校验的 QEMU（${component.version}）…`, percent: 2, url: component.url });
      await download(component.url, setup, {
        onProgress: (pr) => onProgress({
          stage: 'download',
          message: `下载 QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
            + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
          percent: pr.percent,
          canResume: false,
        }),
      });
      if (fileSize(setup) < MIN_SIZE.qemu) throw new Error('QEMU 安装包下载不完整');
      onProgress({ stage: 'install', message: '校验 QEMU 安装器（不申请管理员权限）…', percent: 96 });
      await verifyComponent(setup, component);
      // NSIS /D 必须最后且不加引号。只以当前权限直接创建进程，绝不使用 shell/runas。
      // 安装器若要求提升权限，CreateProcess 失败后交给用户核验并手动安装，不绕过 UAC。
      await new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err); else resolve();
        };
        try {
          const proc = spawn(setup, ['/S', `/D=${p.qemuDir}`], {
            windowsHide: true, stdio: 'ignore', shell: false, cwd: stage,
          });
          proc.once('error', finish);
          proc.once('close', (code, signal) => finish(code === 0 && !signal
            ? null : new Error(`QEMU 安装器未成功退出（${signal || code}）`)));
          timer = setTimeout(() => {
            finish(new Error('QEMU 安装器超时，已拒绝报告安装成功'));
            try { proc.kill(); } catch (_) { /* 保持失败状态 */ }
          }, 600000);
        } catch (e) { finish(e); }
      });
      this._qemuCache = null;
      const v = await this.qemuVersion();
      if (!v.ok || v.path !== p.qemuExe) throw new Error('QEMU 安装后未在目标目录找到可用的 qemu-system-x86_64.exe');
      this._cache.qemuVersion = v.version;
      onProgress({ stage: 'done', message: `QEMU ${v.version} 就绪`, percent: 100 });
      return v;
    } catch (err) {
      const error = new Error(`${err.message}\n${qemuManualHelp(process.platform)}`, { cause: err });
      error.code = err.code || 'QEMU_INSTALL_FAILED';
      throw error;
    } finally {
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // ---------------- 系统镜像 ----------------

  async downloadIso(onProgress = () => {}) {
    assertRuntimeWritable('下载系统 ISO');
    const p = this.ensureDirs();
    const s = store.getSettings();
    // isoPath 是读取引用，不表示写入所有权；旧版默认文件名也可能是用户导入的原件。
    const previous = s.runtime.isoPath;
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;
    const imagesDir = path.join(fs.realpathSync(p.root), 'images');
    const assertManagedDir = () => {
      if (!fs.lstatSync(imagesDir).isDirectory() || path.relative(imagesDir, fs.realpathSync(p.imagesDir)) !== '') {
        throw new Error('运行时 images 目录不是受管目录');
      }
    };
    assertManagedDir();
    await this.guardDisk('iso', imagesDir);
    assertManagedDir();
    const stage = fs.mkdtempSync(path.join(imagesDir, '.iso-download-'));
    const partial = path.join(stage, 'android-x86.iso.part');
    const dest = path.join(stage, 'android-x86.iso');
    const active = this._isoDownloadParts || (this._isoDownloadParts = new Set());
    active.add(partial);
    let r;
    let info;
    let published = false;
    try {
      onProgress({ stage: 'download', message: '下载 Android-x86 9.0-r2（约 900MB，8 线程分块）…', percent: 1 });
      r = await downloadAnyParallel(urls, partial, {
        connections: 8,
        onProgress: (pr) => onProgress({
          stage: 'download',
          message: `下载系统镜像… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
            + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
          percent: pr.percent,
          canResume: false,
        }),
      });
      info = this.inspectIso(partial);
      if (!info.ok) throw new Error(`系统镜像不可用：${info.reason}`);
      if (store.getSettings().runtime.isoPath !== previous) throw new Error('下载期间 ISO 选择已变更，请重试');
      fs.renameSync(partial, dest);
      store.saveSettings({ runtime: { isoPath: dest } });
      published = true;
    } finally {
      active.delete(partial);
      if (!published) {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* 留待人工处理 */ }
      }
    }
    onProgress({ stage: 'done', message: `系统镜像就绪（${(info.size / 1073741824).toFixed(2)} GB）`, percent: 100, path: dest });
    return { ...r, ...info, file: dest };
  }

  /** 校验用户导入的镜像/ISO */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('文件不存在或为空');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    assertRuntimeWritable('导入系统 ISO');
    if (this._isoDownloadParts?.size) {
      const source = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
      for (const partial of this._isoDownloadParts) {
        const target = fs.statSync(partial, { bigint: true, throwIfNoEntry: false });
        if (path.relative(partial, file) === '' || (source && target && source.ino !== 0n
          && source.dev === target.dev && source.ino === target.ino)) {
          throw new Error('不能导入仍在下载的系统镜像');
        }
      }
    }
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || '镜像文件不可用');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    assertRuntimeWritable('导入虚拟磁盘');
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- 虚拟磁盘 ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    assertRuntimeWritable('创建虚拟磁盘');
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `创建 ${sizeGB}GB 虚拟磁盘…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img 创建虚拟磁盘失败：${r.stderr || r.stdout}`);
    } else {
      throw new Error('未找到 qemu-img.exe，请先安装 QEMU');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: '虚拟磁盘已创建', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- 系统镜像可达性预检 ----------------

  async probeSources() {
    const { resolveAdbComponent } = require('./runtime-integrity');
    const unavailable = (err) => ({ status: 0, size: 0, error: err.message });
    const [adb, qemu, iso] = await Promise.all([
      resolveAdbComponent(process.platform, process.arch).then((component) => head(component.url)).catch(unavailable),
      this.resolveQemuUrl().then((url) => head(url)).catch(unavailable),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = {
  Provisioner,
  SOURCES,
  IMAGE_PROFILES,
  PLAY_SYSIMG,
  DEFAULT_SYSIMG,
  normalizeImageFlavor,
  MIN_SIZE,
  absUrl,
  baseOf,
};

'use strict';
/**
 * 本地持久化：应用清单 + 设置
 * 数据目录：Windows %APPDATA%\apkstart；Linux 走 XDG ~/.local/share/apkstart
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { normalizePreference } = require('./theme');
const instanceContext = require('./instance-context').current();
const peripherals = require('./peripherals');

// 每个分身使用独立清单、配置和缓存；基础目录由本机平台约定推导，不接受 IPC 路径。
const DATA_DIR = instanceContext.dataDir;
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let settingsCache = null;
let settingsCacheSignature = null;

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  engine: {
    mode: 'builtin',         // builtin（自带运行时，默认） | attach（连接已有运行时，高级）
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = 由 doctor 按机器内存自动决定
    cores: 0,                // 0 = 自动
    autoMemory: true,        // 零配置：自动推导内存/核心/磁盘/渲染参数
    idleShutdownMinutes: 15,
    startVisible: true,
    // 必须带窗口：无头模式 SurfaceFlinger 不出 VSYNC，应用进程活着但屏幕上什么都没有。
    // 带窗口保留原生输入；客机刷新率可配置，但不代表应用帧率或宿主呈现帧率。
    headless: false,
    gpuMode: 'auto',         // auto = 按 emulator 版本自动挑后端并逐级降级
    // 上次「拉起就崩」的渲染后端（格式 `<emulator版本>|<gpu>`）；auto 模式下下次把它排到最后，
    // 免得每次开机都先白等 20 多秒再退到软件渲染。升级运行时会自动失效。
    badGpu: '',
    // 上次「存快照把模拟器写崩」的组合（格式 `<emulator版本>|<gpu>`，上游 #46）。
    // 命中就跳过保存快照：宁可下次冷启动多等 20 秒，也不让用户的应用窗口突然消失。
    snapshotUnsafe: '',
    forceTcg: false,         // 保留给高级排障；正常路径已由 doctor 自动回退
    // 应用画面显示方式：
    //   auto       先试嵌入，一旦宿主画黑帧就永久改用独立窗口（默认，推荐）
    //   embedded   始终嵌进 ApkStart 的应用窗口（老行为）
    //   standalone 始终用模拟器自己的窗口（画面立刻可见，不折腾 SetParent）
    // 实测在软件渲染 + 无硬件加速的机器上，SetParent 之后宿主必黑：每次都要先给
    // 用户看 3 秒黑屏再摘成独立窗口。auto 学一次就够，之后直接一步到位。
    windowMode: 'auto',
    // auto 模式的记忆位：这台机器嵌入后必然黑帧（由黑帧采样成功后写回）
    embeddedBlack: false,
    audio: true,             // 安卓应用的播放声音（提示音/视频）。关闭可省一点 CPU
    microphone: true,        // 内置 Android Emulator 把电脑麦克风提供给安卓应用
    // ---- 轻量容器（默认全开省资源，用户可逐项关掉）----
    liteMode: true,          // 收敛 vCPU 配额，避免 qemu 占满物理核拖慢 Windows
    // 一句话策略：save（省资源）/ balanced（均衡，自动识别低配机器）/ smooth（流畅，视频·游戏优先）。
    // 界面上只暴露这一个选项，保存时自动翻译成 liteMode / priorityMode / renderSize，
    // 底部仍然保留细项开关给高级用户。
    // balanced 是默认值，也是「自动」档：doctor.machineTier() 判定为低配的机器
    // （没有硬件虚拟化 / 内存小 / CPU 弱）会自动再降一档（内存 2GB、2 个 vCPU、
    // 540x960、软件渲染），不需要用户自己调任何参数。save / smooth 是用户显式
    // 指定的固定档，选中后不再自动降级 —— 手动配置永远优先。
    resourceMode: 'balanced',
    // 数据分区容量（GB）：应用、游戏缓存和它们的更新包都装在这里。
    // 0 = 自动（按磁盘剩余给 4/8/16/24GB，由 doctor.chooseProfile 推导）。
    // 改大后在下次开安卓时**就地扩容**，不丢已装应用。
    dataPartitionGB: 0,
    // 渲染分辨率：越低越流畅、越省电；auto = 按加速状态选 720x1280 / 540x960
    renderSize: 'auto',
    // 网络加速：给模拟器指定国内公共 DNS。安卓默认的 10.0.2.3 要走主机 DNS，
    // VPN / 公司网 / 某些运营商下解析会拖到几百毫秒，视频类应用首屏会明显发卡。
    fastDns: true,
    // 快照：quickboot 内存快照让二次启动只要几秒，代价是磁盘上多一份约 2~3GB 的
    // ram.bin。磁盘紧张时可以关掉（只影响启动速度，不影响应用数据）。
    keepSnapshot: true,
    // 日志上限（KB）：超过就滚动备份一份，避免长期使用把磁盘写满
    logLimitKB: 2048,
    // 鼠标键位：左键由模拟器原生映射为「确认/点击」，无需开关。
    // 右键返回与平滑滚轮需要低级钩子，但只在应用窗口前台时装，失焦即卸载。
    mouseRightBack: true,    // 右键 = 安卓返回（拦下 Qt 默认的「右键也当点击」误触）
    mouseWheelMode: 'smooth', // smooth = 合并后注入一次滑动 | native = 交给 Qt | off = 不处理
    mouseSideButtons: false, // 侧键返回/前进：默认关闭，开启才多装一项映射
    deepTrim: false,         // 深度裁剪系统后台包（Play 商店/向导等），默认不动系统
    deepTrimRestorePending: false, // 仅显式关闭或执行深度裁剪后标记，恢复经验证后清除
    deepTrimRestoreTarget: '', // 待恢复的 AVD/镜像或显式外接设备，不随当前选择漂移
    priorityMode: 'balanced', // balanced=让出前台 | performance=qemu 用 Normal 优先级
    // 预热：启动 ApkStart 后在后台把安卓环境引导好，第一次点应用几乎不用等。
    // 代价是常驻约 1GB 内存（和 WSA / 应用宝电脑版一样的取舍），可随时关掉。
    prewarm: true,
  },
  runtime: {
    dir: '',                 // 空 = %APPDATA%\apkstart\runtime
    // 安卓数据目录（AVD/快照/已装应用，真正吃盘的地方）。空 = 自动推导。
    // 这个键一直在被使用（provision.paths()），但此前没在默认值里声明，
    // 导致设置写入白名单会把用户改的「安卓数据目录」静默丢掉。
    avdDir: '',
    qemuUrl: '',             // 手动指定 QEMU 安装包地址
    isoUrl: '',              // 手动指定系统镜像地址
    isoPath: '',             // 系统镜像（ISO）路径
    diskPath: '',            // 安装系统的虚拟磁盘
    diskSizeGB: 24,
    headless: false,         // 不显示虚拟机窗口（仅调试）
    installMode: 'guided',   // guided（引导手动安装） | auto（实验性自动安装）
    emulatorUrl: '',         // 手动指定 emulator 包地址（空 = 自动从 SDK 索引解析最新版）
    sysimgUrl: '',           // 手动指定系统镜像包地址
    // 自定义镜像（image adapter）：空 = 使用当前内置系统档位。
    // 这个键只是「指向 custom-images/index.json 里的一条记录」——默认镜像、
    // 默认 AVD 与已装应用全程不被改写；清空它即恢复默认镜像。
    activeImageId: '',
    // 内置系统镜像：新安装默认 Google Play；Google APIs 与纯 AOSP 是可选档位，
    // 三档各自使用独立 AVD。发布包随带的系统镜像也是 Google Play。
    systemImageFlavor: 'google_apis_playstore',
    compatImage: true,       // 旧兼容开关保留，并与默认 Google Play 档位一致
    // 轻量版的运行时整包：默认从本项目 GitHub Release 下载，
    // 拿不到时自动退回 dl.google.com 分组件下载。可在这里换成自建镜像地址。
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // 旧版本下载设置保留以免升级覆盖已有配置；软件更新不再读取这些字段。
    mirrorPrefix: '',
    downloadConnections: 8,
    proxyUrl: '',
    githubToken: '',
    sourcePreference: 'github',
    autoMirror: true,
    // 多系统（Provider 架构）：当前选择的系统 id、远程目录地址、系统安装模式。
    // 系统镜像本体永远不写进设置，只在用户主动选择时按需下载到 systems/<id>/。
    selectedSystemId: 'google-play',
    systemCatalogUrl: '',       // 空 = 官方默认 raw.githubusercontent.com/.../system-catalog/catalog.json
    systemInstallMode: 'auto',  // auto = 能自动装就自动装；guided = 引导用户在虚拟机窗口完成安装
  },
  peripherals: {
    cameraBack: 'none',       // none | emulated | webcamN；默认不访问主机摄像头
    cameraFront: 'none',
    refreshRate: 60,           // 客机显示模式请求，必须读回确认，不等于应用 FPS
    serialPort: '',            // 只在明确支持的 QEMU 后端开放
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // 开始菜单快捷方式 = 让 Windows 搜索能搜到应用
  shortcutDir: '',           // 空 = 桌面
  freeform: false,           // 共享一个运行时窗口，不再用 Android freeform 小窗
  hideAfterLaunch: false,    // 主进程必须常驻，否则一退出就把 Android 运行时杀掉了
  notifyOnInstall: true,
  // 开机自启：默认关闭。
  // 以前默认开着，等于替所有人做了「每次登录都拉起一个后台进程」的决定 ——
  // 只在偶尔用的时候，它的代价（拖慢开机、常驻内存）比收益大。
  // 需要的人可以在「设置 → 通用」里打开；老配置里已存的 true 不会被强行改掉。
  autoStart: false,
  // 界面语言（upstream #38）：auto = 跟随系统；zh-CN / en-US = 明确指定。
  // 中文是源语言，英文靠 src/i18n/en-US.json 的词典覆盖；缺条目时回落中文原文。
  language: 'auto',
  theme: 'system',           // system | light | dark：原生标题栏与全部渲染窗口共用
  autoDeploy: true,          // 首次运行自动完成全部部署，不再分 1~5 步
  wizardDone: false,         // 首次运行引导向导：完成或跳过后置 true，不再弹出
  wizardVersion: '',         // 最近一次完成引导的 ApkStart 版本；升级后重新展示关键步骤
  androidVolumeInitialized: false, // 首次接入运行时把媒体音量拉满（100%），之后尊重用户调整
  // 安卓客机自己的语言与预装应用（见 core/guest.js）。
  // locale 空 = 保持镜像默认（英文），不做任何改动；'zh-CN' = 目标语言为中文。
  // 新安装默认中文：首次开机会写入 system_locales 并重启一次安卓使其生效
  // （见 engine.prepare 的首次开机收尾）。老用户升级时 deepMerge 保留他们已存的
  // 空值，不会替他们改语言。
  guest: {
    locale: 'zh-CN',
    localeVerified: false,   // 上一次开机后读回系统语言确认已经是中文
    groups: [],              // 上次勾选的精简分组（只用于回显）
    // 首次开机收尾是否已完成。只对「全新 / 重置过的 /data」执行一次：
    // 老用户升级时这两个键虽是新加的，但 androidVolumeInitialized===true
    // 会把它们挡在门外，不会去动别人正在用的系统。
    localeRebootDone: false, // 写完 system_locales 后已让安卓重启过一次
    autoTrimDone: false,     // 已按默认分组（defaultOn）精简过预装应用
  },
  update: {
    // Default to one quiet check after startup. Users may opt out without affecting Android runtime.
    autoCheck: true,
    // 发现新版本：通知后自动下载；没有应用窗口在前台时自动重启安装，
    // 有应用窗口则等窗口关闭再装（不打断正在玩的应用）。关掉则只通知、手动更新。
    autoUpdate: true,
    // 0.11.0 及以前的默认值是 false，无法与用户主动关闭区分；读取旧配置时迁移为开启。
    // 新版本设置页显式保存的选择通过此版本标记保留。
    autoUpdatePreferenceVersion: 1,
  },
  report: {
    // 开机失败时在本机自动生成一份「脱敏诊断报告」，供用户一键上报。
    // 只落到本地，不会自己发出去 —— 报告里有用户名路径和机器信息，得让用户看一眼再决定。
    auto: true,
    // 自动发送须明确填入同一个 HTTPS 收集地址；旧版默认的 autoSend=true 不代表许可。
    autoSend: false,
    autoSendTo: '',
    // 可选的手动发送地址；没填就走发行版配置或 GitHub Issues 预填页。
    endpoint: '',
  },
  display: {
    mode: 'window',          // window（竖屏窗口，可自由拉伸） | fullscreen（自动适配屏幕）
    portrait: '900x1600',    // 窗口模式的竖屏分辨率，可在设置里调大小
    density: 0,              // 0 = 按分辨率自动推导
    rememberBounds: true,    // 记住每个应用的窗口位置/大小
    autoFullscreenOnLaunch: false,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function readJson(file, fallback, validate = isRecord) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 不存在才是首次使用；权限 / I/O 错误必须向上传递，不能用默认值覆写原配置。
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    // 兼容 UTF-8 BOM；语法正确的 null / 数组也不是合法配置或清单。
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (validate(value)) return value;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  // 先成功保留恢复副本才允许回退。随机后缀避免同毫秒内重复恢复覆盖旧副本。
  fs.renameSync(file, `${file}.bak-${Date.now()}-${randomUUID()}`);
  return fallback;
}

function writeJson(file, data) {
  const text = JSON.stringify(data, null, 2);
  ensureDirs();
  const tmp = `${file}.${randomUUID()}.tmp`;
  // 独占创建同目录暂存文件，不跟随已有 .tmp 链接；写入并刷新后再原子替换。
  let fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* 保留原始写入错误 */ }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* 已替换或清理失败，不掩盖原始错误 */ }
  }
}

function settingsSignature() {
  try {
    const stat = fs.statSync(SETTINGS_FILE);
    const mtime = stat.mtimeNs === undefined ? String(Math.trunc(stat.mtimeMs * 1e6)) : String(stat.mtimeNs);
    const ctime = stat.ctimeNs === undefined ? String(Math.trunc(stat.ctimeMs * 1e6)) : String(stat.ctimeNs);
    return `${stat.size}:${mtime}:${ctime}`;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function cloneSettings(value) {
  return structuredClone(value);
}

function deepMerge(base, patch) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (isRecord(v)) out[k] = deepMerge(v, {});
    else out[k] = Array.isArray(v) ? structuredClone(v) : v;
  }
  for (const [k, v] of Object.entries(filterKnown(base, patch))) {
    out[k] = isRecord(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 只接受默认值声明的自有键和类型，不能把整个分区替换成 null / 数组。 */
function filterKnown(base, patch) {
  const out = {};
  if (!isRecord(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(base, k)) continue;
    if (isRecord(base[k])) {
      if (isRecord(v)) out[k] = filterKnown(base[k], v);
    } else if (Array.isArray(base[k])) {
      if (Array.isArray(v) && v.every((item) => typeof item === 'string')) out[k] = [...v];
    } else if (typeof v === typeof base[k] && (typeof v !== 'number' || Number.isFinite(v))) {
      out[k] = v;
    }
  }
  return out;
}

/** 包名会拼进文件路径（图标 / APK 备份），白名单之外的一律替换成下划线 */
function safePathName(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 150);
}

/**
 * 资源策略 → 具体开关。
 *   save     ：2 vCPU + 低优先级 + 540x960，老笔记本 / 挂机用；
 *   balanced ：vCPU 取物理核的一半（2~4）+ 让出前台 + 720x1280；
 *   smooth   ：不限制 vCPU + 与前台同优先级 + 720x1280，视频与游戏优先。
 * 分辨率先不动 1080p：quickboot 快照指纹与它绑定，改一次就要重冷启动，而 720p
 * 在手机比例的窗口里已经看不出区别，性能却差一档。
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'performance', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
  isChild: instanceContext.isChild,

  getSettings() {
    const signature = settingsSignature();
    if (settingsCache && settingsCacheSignature === signature) return cloneSettings(settingsCache);
    const raw = readJson(SETTINGS_FILE, {});
    const s = deepMerge(DEFAULT_SETTINGS, raw);
    if (!instanceContext.isChild) {
      const storedUpdate = isRecord(raw.update) ? raw.update : {};
      const preferenceVersion = storedUpdate.autoUpdatePreferenceVersion;
      if (!Number.isSafeInteger(preferenceVersion) || preferenceVersion < 1) {
        // 0.11.0 的默认 false 与用户主动关闭无法区分；迁移旧配置时采用新的开箱即用默认值。
        // 只改写 update 分区，保留历史字段及其它所有用户配置。
        if (!isRecord(raw.update)) raw.update = {};
        if (s.update.autoUpdate !== true) raw.update.autoUpdate = true;
        raw.update.autoUpdatePreferenceVersion = 1;
        if (signature !== 'missing') {
          try { writeJson(SETTINGS_FILE, raw); } catch (_) {
            // 迁移是尽力而为；只读配置或短暂 I/O 故障不能阻止应用启动。
          }
        }
        s.update.autoUpdate = true;
      }
    }
    s.theme = normalizePreference(s.theme);
    // 旧版曾把「兼容模式」保存成 google_apis + compatImage=true，实际却应使用
    // Google Play 镜像。只迁移这一种矛盾组合；显式关闭兼容模式的高级档位不改写。
    if (s.runtime && s.runtime.systemImageFlavor === 'google_apis' && s.runtime.compatImage === true) {
      s.runtime.systemImageFlavor = 'google_apis_playstore';
    }
    // 旧版本默认无头运行：应用进程能起来但屏幕上没有窗口，等效于「打不开」。
    // 无条件迁移到带窗口模式，且不再允许通过旧配置把它关掉。
    s.engine.headless = false;
    // 旧版本退出壳层时会杀掉整个 Android 运行时，导致桌面图标点开闪一下就没了。
    s.hideAfterLaunch = false;
    // 旧版本用 Android freeform 小窗，现在整个模拟器窗口就是应用窗口，
    // 应用必须铺满这块屏幕，否则会出现「窗口里再套一个小窗」。
    s.freeform = false;
    s.peripherals = peripherals.normalizeSettings(s.peripherals);
    if (instanceContext.isChild) {
      s.runtime.avdDir = instanceContext.avdDir;
      s.runtime.selectedSystemId = 'google-play';
      s.runtime.systemImageFlavor = 'google_apis_playstore';
      s.runtime.compatImage = true;
      s.runtime.activeImageId = '';
      s.runtime.diskPath = '';
      s.runtime.isoPath = '';
      s.engine.qemuPath = '';
      s.engine.systemImage = '';
      s.engine.mode = 'builtin';
      s.engine.prewarm = false;
      s.autoDeploy = false;
      s.autoStart = false;
      s.createShortcutOnInstall = false;
      s.createStartMenuShortcut = false;
      s.update.autoUpdate = false;
    }
    settingsCache = cloneSettings(s);
    settingsCacheSignature = settingsSignature();
    return cloneSettings(settingsCache);
  },

  saveSettings(patch) {
    // 白名单过滤：settings:set 是渲染层直达的通用写入入口，未知键（或被构造的
    // runtime.*Url 之外的键）一律丢弃，避免配置文件被塞进任意内容。
    const safe = filterKnown(DEFAULT_SETTINGS, patch);
    const previous = this.getSettings();
    if (instanceContext.isChild) {
      // 子实例不能重新选择共享运行时、接管设备或修改全局系统集成。
      delete safe.runtime;
      delete safe.adbPath;
      delete safe.device;
      delete safe.autoStart;
      delete safe.autoDeploy;
      delete safe.createShortcutOnInstall;
      delete safe.createStartMenuShortcut;
      delete safe.update;
      if (safe.engine) {
        delete safe.engine.mode;
        delete safe.engine.qemuPath;
        delete safe.engine.systemImage;
        delete safe.engine.prewarm;
      }
    }
    const next = deepMerge(previous, safe);
    next.theme = normalizePreference(next.theme);
    next.peripherals = peripherals.normalizeSettings(next.peripherals);
    // 只改了「资源策略」时，把它翻译成具体的三个开关，避免两套配置各说各话
    if (safe && safe.engine && safe.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    settingsCache = null;
    settingsCacheSignature = null;
    return this.getSettings();
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] }, (value) => isRecord(value) && Array.isArray(value.apps));
    const apps = data.apps.filter((app) => isRecord(app) && typeof app.package === 'string' && app.package.length > 0);
    if (apps.length !== data.apps.length) {
      // 单条坏记录不隐藏其它应用；先复制原始清单，再原子保存可恢复的记录。
      // 备份或保存失败均报错，原文件仍保留，不能默默丢掉无法识别的元数据。
      fs.copyFileSync(APPS_FILE, `${APPS_FILE}.bak-${Date.now()}-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
      writeJson(APPS_FILE, { ...data, apps });
    }
    return apps;
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    // 包名来自 APK 清单（不受信任输入）。apk.js 已做白名单校验，这里再做一层
    // 路径净化兜底：`..\..\` 这类构造最多变成一个奇怪的文件名，写不出目录外。
    return path.join(ICON_DIR, `${safePathName(pkg)}.png`);
  },

  /** 矢量图标（apk.js 转出的 SVG）落盘路径；UI 的 <img> 直接能显示 */
  svgIconPath(pkg) {
    return path.join(ICON_DIR, `${safePathName(pkg)}.svg`);
  },

  apkPath(pkg, version = 'cur') {
    return path.join(APK_DIR, `${safePathName(pkg)}-${safePathName(version)}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;

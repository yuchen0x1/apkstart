'use strict';
/**
 * ApkStart 主进程
 * 职责：窗口 / 托盘 / 单实例 / 命令行分发（双击 apk、桌面快捷方式启动）/ IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, nativeTheme, screen, globalShortcut, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipcguard = require('./core/ipcguard');

const store = require('./core/store');
const theme = require('./core/theme');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { isBundle, parseBundle } = require('./core/apk-bundle');
const filetype = require('./core/filetype');
const compat = require('./core/compat');
const backup = require('./core/backup');
const { copyDirContents } = require('./core/file-migration');
const repair = require('./core/repair');
const feedback = require('./core/report');
const imageManifest = require('./core/image-manifest');
const { drawAppIcon } = require('./core/png');

// 品牌 Logo（build/render-logo.js 生成）；缺失时回退到程序化绘制的旧版图标
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* 落到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}
const assoc = require('./core/assoc');
const platform = require('./core/platform');
const i18n = require('./i18n');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const lcd = require('./core/lcd');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater } = require('./core/updater');
const guest = require('./core/guest');
// 多系统按需下载/安装/切换：统一目录、Provider、任务管理器、系统管理器
const { SystemCatalog } = require('./core/system-catalog');
const { SystemManager } = require('./core/system-manager');
const { RuntimeActions, channelMode } = require('./core/runtime-actions');
const { createReportDelivery } = require('./core/report-delivery');
const { writeJsonAtomicSync } = require('./core/atomic-json');

// Windows 下窗口被遮挡时 capturePage 会拿到旧帧，自动化截图需要禁用遮挡计算
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Linux：Chromium 沙箱依赖无特权 user namespace + 一组 namespace/seccomp 组合。
// 两类已知必坏的环境：
//   1. Ubuntu 24.04+ 用 AppArmor 限制了未打包应用的 userns（AppImage 的 squashfs
//      又是 nosuid 挂载，setuid 的 chrome-sandbox 无从生效）；
//   2. WSL2 —— userns 单独测是通的，但 Chromium 的沙箱组合（多 namespace +
//      seccomp）仍起不来，GPU 进程直接 FATAL「GPU process isn't usable. Goodbye.」
//      （Ubuntu 26.04 WSL2 实测）。
// 启动前探测：unshare -Ur 失败（AppArmor 限制）或内核带 microsoft 标记（WSL）时，
// 降级 no-sandbox 并写日志（主流 Electron AppImage 的同款做法）。安卓运行时进程
// 是独立进程，不受这层影响。
if (process.platform === 'linux') {
  let sandboxUsable = true;
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('unshare', ['-Ur', 'true'], { timeout: 5000 });
    if (r.status !== 0) sandboxUsable = false;
    const uts = fs.readFileSync('/proc/version', 'utf8');
    if (/microsoft|WSL/i.test(uts)) sandboxUsable = false;
  } catch (_) { /* 读不到就保守认为可用，让沙箱正常路径走 */ }
  if (!sandboxUsable) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    try {
      appLog('Linux 沙箱降级：Chromium 沙箱在此环境起不来（Ubuntu 24.04+ 的 userns 限制或 WSL2），'
        + '已按 no-sandbox 启动 —— 仅少了 Chrome 沙箱这层防护，安卓运行时进程不受影响');
    } catch (_) { /* appLog 尚未就绪时忽略 */ }
  }
}

/**
 * 系统盘快满时，把 Chromium 自己的缓存（Cache / GPUCache / Local Storage …）
 * 挪到「安卓数据目录」所在的盘。
 * 默认这些缓存写在 %APPDATA%\apkstart 里 —— C 盘只剩几百 MB 时，连启动都可能失败，
 * 而用户往往已经把安卓数据挪到别的盘了，缓存却还在 C 盘上挤。
 * 必须在 app ready 之前设置，之后改无效。
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* 放不进去就维持默认，不影响启动 */ }
}
relocateUserDataIfCrowded();

// 应用窗口把模拟器以 SetParent 方式嵌进来当子窗口。Chromium 默认用
// DirectComposition 上半透明图层（Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP）绘制网页，这层由 DWM 在窗口级别合成，
// 会直接盖住嵌入的子窗口——表现就是"画面全黑但安卓其实在跑"。
// 外壳界面只有一条 38px 标题栏和启动遮罩，走软件合成完全不卡，
// 关掉硬件加速后 Chromium 直接画进 HWND，子窗口层级才真正生效。
// 想对比效果时可以设 APKSTART_HWACCEL=1 启动。
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * 构造 VC++ 安装器的 PowerShell 调用。
 * 路径必须通过环境变量传递，不能插进 -Command 的双引号字符串；否则
 * Windows 路径中的 `$()` / 反引号会被 PowerShell 当成表达式执行。
 */
function buildVcRedistLaunch(file) {
  return {
    command: "Start-Process -FilePath $env:APKSTART_VC_REDIST -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait",
    env: { ...process.env, APKSTART_VC_REDIST: String(file) },
  };
}

/**
 * 轻量文件日志：打包后没有控制台，出问题时用户可以把 app.log 发过来。
 * 只记关键节点和异常，正常路径几千行也不会撑爆。
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* 日志失败不能影响主流程 */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * 桌面 / 开始菜单快捷方式：只有 Windows 有这套东西。
 * 其他平台上当成「无事可做」直接返回空数组 —— 不要让它抛错，也不要在日志里刷红。
 */
function ensureShortcuts() {
  if (!platform.canIntegrateShell) return Promise.resolve([]);
  return installer.ensureShortcuts().catch(() => []);
}

/**
 * 这份配置是不是「旧版硬编码默认值」。
 *
 * 旧版本把 memoryMB 写死 4096、gpuMode 写死 swiftshader_indirect（37.x 上已弃用），
 * 升级后必须纠正回自动。但用户手动填过内存（autoMemory === false）时不能再动：
 * 那时候的 4096 是用户自己的选择，「手动配置优先」。
 */
function legacyEngineDefaults(s) {
  const eng = (s && s.engine) || {};
  if (eng.autoMemory === false) return false;
  return eng.gpuMode === 'swiftshader_indirect' || eng.memoryMB === 4096;
}

/**
 * 完整版（内置运行时）自动接管：
 * 发行包里 ApkStart.exe 旁边带有 runtime/（emulator + platform-tools + AEHD + ARM 兼容镜像）。
 * 首次启动（settings.json 尚不存在）时直接把 runtime.dir 指向它并开启兼容模式，
 * 用户无需任何下载与设置，开箱即用。之后用户仍可在设置里改回在线版。
 */
function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // 便携版把运行时放在 exe 旁边；electron-builder 的 portable 会把资源解到
    // resources/ 下，进程 exe 和 resources 同级，所以几个候选位置都看一下。
    const candidates = [
      path.join(exeDir, 'runtime'),
      exeDir + '.preserved-runtime',
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // 内置运行时只要求「有 emulator + 任意一套完整系统镜像」，不写死 API 版本：
    // 单文件发行版带的可能是更小的 AOSP 镜像，写死 API34 会让它误判成没有运行时。
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // 单文件发行版里的镜像是压缩存放的（system.img.xz / .gz），解压在首次启动时做。
            // 这里只认 system.img 会让「包里明明带了镜像」被判成没带，转而去联网下载。
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    // Windows 的 emulator 带 .exe；Linux 裸名。Linux 版目前不带内置运行时
    // （走应用内自动下载），但这张检查表按平台写对，将来带包也不用改。
    const emuExe = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
    const previous = store.getSettings().runtime.dir;
    if (previous && path.basename(previous).toLowerCase() === 'runtime'
      && path.basename(path.dirname(previous)).toLowerCase() === 'resources') {
      candidates.push(path.dirname(path.dirname(previous)) + '.preserved-runtime');
    }
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', emuExe)) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // 旧版只在 settings.json 不存在时接管：用户先装过在线版再解压完整版，
    // 就会一直走「缺组件」的部署向导。现在只要当前运行时目录里没有 emulator 就接管。
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', emuExe);
    // 便携版被移动/升级（解压到新目录）后，settings 里记的还是旧路径：
    // 必须只认「本次 EXE 所在目录下的 runtime」，否则会一直用旧包里的组件
    // （实测踩过：旧包的 emulator 缺 emulator-check → 加速探测失败 → 退回 TCG 软件模拟）。
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // 用户自己挑的目录（不在 EXE 目录树里，例如 D:\ApkStartRuntime 或别的盘）
    // 一律尊重：他可能就是为了省 C 盘空间、或让多个便携版共用一个运行时。
    // 旧版在这里无条件覆盖成 exe 旁边的 bundled runtime，表现就是
    // 「设置里改了运行时数据目录，结果还是下到旧目录 / AppData」（issue #23）。
    // 只有「旧版的硬编码默认值」才需要纠正：老配置里 memoryMB 恒为 4096、
    // gpuMode 恒为已弃用的 swiftshader_indirect，且 autoMemory 是默认的 true。
    // 用户手动填过值（autoMemory === false）就一个字都不能动 —— 手动配置优先。
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (legacyEngineDefaults(s)) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 已有可用运行时（含在线版）就尊重它：AVD 用户数据就在该目录下，不能悄悄搬走
    if (currentOk) {
      // 但仍把自动参数打开，旧配置里的硬编码 4G/4核/弃用 GPU 模式不能继续用
      if (legacyEngineDefaults(s)) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 包里带的是 Google Play 镜像才开兼容模式；AOSP 镜像带的是原生 x86_64 库
    let playBundled = false;
    let googleApisBundled = false;
    let aospBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
          if (/^google_apis$/i.test(tag)) googleApisBundled = true;
          if (/^default$/i.test(tag)) aospBundled = true;
        }
      }
    } catch (_) { /* 忽略 */ }
    const bundledFlavor = playBundled ? 'google_apis_playstore'
      : (googleApisBundled ? 'google_apis' : (aospBundled ? 'default' : 'google_apis_playstore'));
    store.saveSettings({
      runtime: {
        dir: bundled,
        compatImage: bundledFlavor === 'google_apis_playstore',
        systemImageFlavor: bundledFlavor,
      },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
  } catch (_) { /* 接管失败不阻塞启动，走在线引导 */ }
}
bootstrapBundledRuntime();

// 冒烟截图等自动化场景下跳过注册表探测（避免依赖 reg.exe）
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// 「哪些窗口算我们的」由 whenReady 里赋值（见 agentScope）。放模块级是因为
// runLaunch / 预热定时器都早于那段代码定义，闭包里的 const 在它们的作用域外看不到。
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
const windowClients = new WeakMap();
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;
let currentSystemStatus;
const runtimeActions = new RuntimeActions({
  status: () => currentSystemStatus(),
  isQuitting: () => quitting,
});

// ---------------- 命令行解析 ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron 会往 argv 里塞自己的开关和 app 路径，只认形如 com.foo.bar 的包名
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    // 认下载残留后缀：拖到 exe 上的 a.apk.1 也要能装（见 core/filetype.js）
    else if (filetype.isInstallable(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium 能解 WebP，nativeImage 不能；用隐藏窗口把 APK 图标转成 PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const isSvg = raw.slice(0, 256).toString('utf8').includes('<svg');
  const mime = isSvg ? 'image/svg+xml'
    : /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  // SVG 没有位图尺寸，统一光栅化到 256 保证 .ico 清晰；位图保持原尺寸上限
  const target = isSvg ? 256 : 'auto';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = ${target === 'auto'
    ? 'Math.min(256, Math.max(img.naturalWidth, img.naturalHeight))'
    : String(target)};
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** 开机自启：默认关闭（用户可在「设置 → 通用」里打开） */
function applyAutoStart() {
  if (!app.isPackaged) return; // 开发时不写注册表
  const on = store.getSettings().autoStart === true;
  try {
    // 必须显式给 name，否则注册表里的启动项会叫 "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // 清掉旧版本（没传 name）留下的那条，避免重复启动
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* 组策略禁止时忽略 */ }
}

// ---------------- 显示模式：全屏自适应 / 竖屏窗口可调 ----------------

function displaySettings() { return store.getSettings().display || {}; }

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** 滚轮注入需要知道 Android 侧分辨率；缓存一次，转屏/重启运行时后失效 */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* 运行时还没起来 */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/**
 * 窗口该按什么比例：运行时 LCD 优先 —— 横屏应用是拿 1920x1080 起的模拟器，
 * 再用「竖屏基准」去套就会出现两侧黑边 + 点击错位（issue #41）。
 */
function windowBox() {
  const l = runtime && runtime.emulator && runtime.emulator.lcd;
  if (l && l.w && l.h) return { w: l.w, h: l.h };
  return portraitSize();
}

/** 设置页改动鼠标键位后，立刻按当前窗口焦点同步一次钩子配置 */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * 打开（或复用）那个「一个应用一个干净窗口」。
 * @param {object} [box] 模拟器 LCD 尺寸；横屏应用传 1920x1080，窗口按它定比例
 */
function openAppWindow(pkg, tip, box = null, opts = {}) {
  if (quitting) throw new Error('ApkStart 正在退出');
  const rec = store.getApp(pkg);
  appWin.open({
    pkg,
    label: (rec && rec.label) || pkg,
    iconPath: rec && rec.icoPath,
    lcd: box || (runtime && runtime.emulator && runtime.emulator.lcd) || null,
    fullscreen: displaySettings().mode === 'fullscreen',
    // 独立窗口模式下不显示宿主窗口：用户要看的画面在模拟器自己的窗口里
    hidden: !!opts.hidden,
  });
  appWin.setIcon(rec && rec.icoPath);
  appWin.setState({ tip: tip || '正在启动安卓运行时…', ready: false, landscape: appWin.lcdLandscape });
  currentAppPkg = pkg;
  return appWin.win;
}

/**
 * 应用方向与当前运行时不一致时问用户：重启运行时（约 1 分钟）换取铺满，还是保持现状。
 * 不静默重启是底线：那是一次完整冷启动，用户有权拒绝。
 */
async function askLcdSwitch(rec, want, current) {
  const name = (rec && rec.label) || (rec && rec.package) || '这个应用';
  const { response, checkboxChecked } = await dialog.showMessageBox(
    (appWin && appWin.win) || mainWindow,
    {
      type: 'question',
      buttons: ['重启并切换', '保持当前'],
      defaultId: 0,
      cancelId: 1,
      title: '需要重启安卓运行时',
      message: `《${name}》是${lcd.label(want)}应用，当前运行时是${lcd.label(current)}。`,
      detail: '模拟器的画面比例在开机时就固定了（这是让应用铺满窗口的唯一办法）。'
        + `改用${lcd.label(want)}模式需要重启安卓运行时，约 1 分钟；已安装的应用和数据都不受影响。`,
      checkboxLabel: '记住这个应用的选择',
      checkboxChecked: false,
    },
  );
  if (checkboxChecked && rec && rec.package) {
    store.upsertApp({ package: rec.package, lcdPref: response === 0 ? want : 'keep' });
  }
  return response === 0;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  if (appWin && appWin.isOpen) {
    if (next.display.mode === 'fullscreen') {
      appWin.win.maximize();
      // 全屏 = 平板横屏排版：让安卓按宽屏重新排版，而不是只把窗口拉大
      appWin.setLandscape(true, { fullscreen: true }).catch(() => {});
    } else {
      appWin.win.unmaximize();
      appWin.setLandscape(false, { fullscreen: false }).catch(() => {});
    }
    appWin.scheduleFit();
  }
  return next.display.mode;
}

/** 首次运行把 adb / emulator / 系统镜像一次装完，不再分 1~5 步 */
let deploying = false;
// 自动部署失败后的冷却（上游 0.5.0）：运行时整包 1.4GB，失败（断网/限流/磁盘满）后
// 若不冷却，每次启动都会再试一次大下载。30 分钟内只走手动安装，不自动重试。
let deployFailedAt = 0;
const DEPLOY_COOLDOWN_MS = 30 * 60 * 1000;
// 引导向导打开期间暂停后台自动部署：用户正在选「装到哪个盘」，
// 后台却已经往默认目录（C 盘）开下，选择就失去意义了。向导关闭后重新安排。
let wizardOpen = false;
let wizardAutoDeployTimer = null;
function onboardingPending() {
  const s = store.getSettings();
  return s.wizardDone !== true || String(s.wizardVersion || '') !== String(app.getVersion());
}

function scheduleAutoDeploy(delay = 20000) {
  if (wizardAutoDeployTimer) clearTimeout(wizardAutoDeployTimer);
  wizardAutoDeployTimer = setTimeout(() => {
    wizardAutoDeployTimer = null;
    if (onboardingPending()) {
      send('toast', { type: 'info', message: '请先完成首次使用引导；运行环境不会在后台静默下载。' });
      return;
    }
    send('toast', { type: 'info', message: '即将准备运行环境，可在设置 → 运行时查看进度。' });
    autoDeploy().then((r) => {
      if (r && r.ok) send('toast', { type: 'ok', message: '运行时已自动准备完成' });
    }).catch(() => {});
  }, delay);
  if (wizardAutoDeployTimer.unref) wizardAutoDeployTimer.unref();
}

async function autoDeploy({ force = false } = {}) {
  // 向导打开期间拦截的是「后台定时」的自动部署；向导自己点「开始安装」走 force=true
  if (!force && wizardOpen) return { ok: false, error: 'wizard' };
  if (!force && Date.now() - deployFailedAt < DEPLOY_COOLDOWN_MS) {
    return { ok: false, error: 'cooldown' };
  }
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  deploying = true;
  const progress = (p) => send('provision:progress', { ...p, component: p.component || 'all' });
  try {
    const env = await runtime.provisioner.checkEnv();
    if (!env.adb.ok) {
      progress({ message: '正在准备 adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: '正在准备 Android 运行时…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: '正在准备 Android 系统镜像…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    const ok = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    deployFailedAt = ok ? 0 : Date.now();
    return { ok };
  } catch (e) {
    deployFailedAt = Date.now();
    return { ok: false, error: e.message };
  } finally {
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** 以管理员权限启用一个 Windows 可选功能（如 VirtualMachinePlatform / HypervisorPlatform） */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)})`;
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('exit', (code) => resolve({
      ok: code === 0,
      restart: true,
      code,
      error: code === 0 ? '' : (
        /cancel|declined|取消|0x800704c7/i.test(stderr)
          ? '已取消管理员授权：需要在弹窗点「是」'
          : `启用「${feature}」失败（退出码 ${code}）`
      ),
    }));
    proc.on('error', () => resolve({ ok: false, error: '无法启动 PowerShell' }));
  });
}

/**
 * 以管理员权限把 AEHD 驱动服务拉起来（sc start aehd）。
 *
 * 这是「检测说有加速、真正开机却直接退出」（ACCEL_UNUSABLE）最常见的一种修法，
 * 而且**不需要重启**：驱动与内核都对，只是服务没在跑（Windows 更新后没自启、
 * 上次异常关机、或被 Hyper-V / 内存完整性挤掉）。这一步成功就是当场可用。
 *
 * 起不来（1067 / 0xffffffa1）通常意味着 BIOS 虚拟化没开，或与 Hyper-V 冲突 ——
 * 那就只能换 WHPX，由调用方继续处理。
 */
function startAehdService(name = 'aehd') {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: '仅支持 Windows' });
    const inner = '$p = Start-Process -FilePath "$env:SystemRoot\\System32\\sc.exe" '
      + `-ArgumentList @('start','${name}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    const ps = `try { ${inner} } catch { exit 2 }`;
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('exit', (code) => resolve({
      ok: code === 0,
      code,
      error: code === 0 ? '' : (
        code === 2 || /cancel|declined|取消|0x800704c7/i.test(stderr)
          ? '已取消管理员授权（需要在弹窗点「是」才能启动驱动服务）'
          : `启动 AEHD 服务失败（退出码 ${code}）：多半是与 Hyper-V / 内存完整性冲突，或 BIOS 虚拟化没开`
      ),
    }));
    proc.on('error', () => resolve({ ok: false, error: '无法启动 PowerShell' }));
  });
}

/**
 * BIOS 里的 CPU 虚拟化（AMD SVM / Intel VT-x）是否真的开了。
 * WHPX/AEHD 都依赖它；Windows 功能打开得再全，BIOS 没开照样起不来。
 * 只在用户点「一键开启」时查一次，不拖慢日常状态刷新。
 */
function virtualizationFirmwareEnabled() {
  return new Promise((resolve) => {
    const ps = '$v = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1; '
      + 'if ($v -and $v.VirtualizationFirmwareEnabled) { "true" } else { "false" }';
    const { execFile } = require('child_process');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        const text = String(stdout || '');
        if (err && !/\b(true|false)\b/i.test(text)) { resolve(null); return; }
        resolve(/\btrue\b/i.test(text) ? true : (/\bfalse\b/i.test(text) ? false : null));
      });
  });
}

/** 打开 Windows 的「启用或关闭 Windows 功能」对话框（用户手动勾选 WHPX 的兜底入口） */
function openWindowsFeatures() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: '仅支持 Windows' });
  try {
    const { spawn } = require('child_process');
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
    if (fs.existsSync(exe)) {
      const p = spawn(exe, [], { detached: true, stdio: 'ignore' });
      p.unref?.();
      p.once('error', () => { shell.openExternal('ms-settings:optionalfeatures').catch(() => {}); });
      return Promise.resolve({ ok: true, how: 'optionalfeatures' });
    }
    return shell.openExternal('ms-settings:optionalfeatures').then(() => ({ ok: true, how: 'ms-settings' }))
      .catch((e) => ({ ok: false, error: e.message }));
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message });
  }
}

// ---------------- 主窗口 ----------------

function syncTheme(preference) {
  nativeTheme.themeSource = theme.normalizePreference(preference);
  refreshWindowTheme();
}

function refreshWindowTheme() {
  const dark = nativeTheme.shouldUseDarkColors;
  theme.updateWindow(mainWindow, dark, { overlay: process.platform === 'win32' });
  const state = { preference: nativeTheme.themeSource, resolved: dark ? 'dark' : 'light' };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('theme:changed', state);
  }
}

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: theme.nativePalette(nativeTheme.shouldUseDarkColors).background,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.nativePalette(nativeTheme.shouldUseDarkColors).background, symbolColor: theme.nativePalette(nativeTheme.shouldUseDarkColors).foreground, height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--apkstart-role=main'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) {
    mainWindow.once('ready-to-show', () => mainWindow.show());
    // 首帧绘制 -> ready-to-show 这条链路在某些显卡/虚拟显示器组合下不会回来
    // （上游 issue #39：进程驻留、日志停在 prewarm，用户看到的就是「点了没反应」）。
    // 页面其实早就加载好了（--smoke 能截图），所以 3 秒还没显示就直接亮出来。
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
          appLog('force-show fallback fired');
          mainWindow.show();
          mainWindow.focus();
        }
      } catch (_) { /* 窗口可能已销毁 */ }
    }, 3000).unref?.();
  }

  // 冒烟测试时把渲染进程的报错打到 stdout：界面空白、按钮点了没反应，
  // 十有八九是 app.js 里某个 id 改动后抛了异常，正常运行看不到。
  if (process.argv.includes('--smoke')) {
    // Electron 45 起回调只给一个事件对象（旧的多参数形式已废弃，会在控制台告警）
    mainWindow.webContents.on('console-message', (ev) => {
      const lv = ev && ev.level;
      if (lv === 'warning' || lv === 'error') {
        const from = String(ev.sourceId || '').split('/').pop();
        console.log(`[renderer] ${ev.message} (${from}:${ev.lineNumber})`);
      }
    });
  }

  // 外链一律交给系统浏览器（公众号/GitHub 等），绝不把应用窗口导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart 仍在后台运行', '点击托盘图标可重新打开；右键托盘可退出。');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  if (quitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- 托盘 ----------------

function buildTray() {
  const icon = loadBrandIcon(16);
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    const menu = Menu.buildFromTemplate([
      { label: i18n.t('打开 ApkStart'), click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: i18n.t('还没有安装应用'), enabled: false }]),
      { type: 'separator' },
      {
        // 独立窗口模式下宿主窗口是藏起来的，用户没有 × 可点：必须给一个明确的
        // 「关掉现在这个应用」出口，否则只能靠退出整个 ApkStart。
        label: i18n.t('关闭当前应用'),
        click: () => {
          if (!appWin || !appWin.isOpen) {
            notify(i18n.t('当前没有运行中的应用'), '');
            return;
          }
          try { appWin.close({ keepApp: false }); } catch (_) { /* 已关 */ }
        },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? i18n.t('切回竖屏窗口') : i18n.t('全屏（自适应屏幕）'),
        click: () => { toggleDisplayMode(); },
      },
      // 快捷方式 / 文件关联都是 Windows 注册表那套，别的系统上不显示这一项
      ...(platform.canIntegrateShell
        ? [{ label: i18n.t('重建桌面/开始菜单快捷方式'), click: () => { ensureShortcuts(); } }]
        : []),
      { label: i18n.t('同步共享目录'), click: () => sharer.sync() },
      { label: i18n.t('设置'), click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate
          ? i18n.t('发现新版本 {tag}', { tag: updateInfo.tag })
          : i18n.t('检查更新'),
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: i18n.t('发现新版本 {tag}', { tag: info.tag }),
              message: i18n.t('ApkStart {tag} 已发布，当前版本 v{ver}。现在更新吗？',
                { tag: info.tag, ver: app.getVersion() }),
              detail: (info.notes || '').slice(0, 600),
              buttons: [i18n.t('立即更新'), i18n.t('稍后')],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify(i18n.t('已是最新版本'), `ApkStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: i18n.t('退出'),
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip(i18n.t('ApkStart — 安卓应用运行器'));
  // Windows 托盘的惯例是单击就打开主窗口（双击当然也可以）。
  // 之前只绑了 double-click，用户单击没反应，会以为托盘图标坏了。
  // 右键才出菜单，所以这里单击直接 showWindow 不会和菜单冲突。
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- 核心动作 ----------------

let installBusy = null;   // 正在安装的文件路径：双击 APK 连点会走 second-instance，不能并发装
let lastInstallErr = { msg: '', at: 0 };
const APK_META_CACHE = new Map();

function parseApkCached(filePath) {
  if (!filetype.isSingleApk(filePath)) return null;
  const key = path.resolve(filePath).toLowerCase();
  const st = fs.statSync(filePath);
  const hit = APK_META_CACHE.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.meta;
  const meta = parseApk(filePath);
  APK_META_CACHE.set(key, { size: st.size, mtimeMs: st.mtimeMs, meta });
  while (APK_META_CACHE.size > 8) APK_META_CACHE.delete(APK_META_CACHE.keys().next().value);
  return meta;
}

async function runInstall(filePath) {
  if (quitting) throw new Error('ApkStart 正在退出');
  showWindow();
  // 同一个包正在装（用户连点了几次图标 / 拖了好几次）→ 只提示一次，别重复跑一遍安装
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: '这个 APK 正在安装中，请稍等…' });
      return { ok: false, error: '正在安装中' };
    }
    send('toast', { type: 'info', message: '已有安装任务在进行，请等它装完。' });
    return { ok: false, error: '已有安装任务在进行' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    let parsedMeta = null;
    try { parsedMeta = parseApkCached(filePath); } catch (_) { /* installer 会给出统一解析错误 */ }
    const result = await runtimeActions.run('apk:install', () =>
      installer.install(filePath, (p) => send('install:progress', p), { meta: parsedMeta }));
    send('install:done', result);
    // 新建的桌面图标要让资源管理器立刻刷新，否则用户会以为「没创建快捷方式」
    windowctl.refreshShell().catch(() => {});
    notify('安装完成', `${result.app.label} 已安装${result.app.shortcutPath ? '，桌面快捷方式已创建' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // 同一条错误 8 秒内只弹一次系统通知：连续重试时不会在右下角刷屏
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // 窗口在前台时用户已经看到界面里的提示，不必再弹系统通知
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('安装失败', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * 下载并安装新版本，然后由 update-apply 脚本接管「替换 + 重启」。
 * 界面与托盘菜单共用这一条路径。
 */
// ---------------- 在线自动更新 ----------------
// 用户要的是「有新版本 → 通知 → 自动下载 → 自动重启安装」：
//  - prepare（下载+解压）随时可做，不打扰任何人；
//  - apply（重启安装）只在「没有应用窗口在前台」时自动执行 —— 正在玩的应用
//    不能被重启打断，等窗口关闭（onWindowClosed 钩子）再装；
//  - 设置里可整体关掉（update.autoUpdate = false），退回「只通知、手动更新」。
let autoUpdateJob = null;
let autoUpdateTag = '';

/**
 * 更新已经交给升级脚本后退出。
 *
 * 只调 app.quit() 不够：before-quit 里要等窗口代理回包、停模拟器、藏窗口，
 * 清理一旦卡住，进程会一直活着占住 ApkStart.exe —— 安装器拿不到文件锁，
 * 静默安装「什么也没做」，用户看到的就是「点重启并安装，没反应，版本还是旧的」。
 * 所以再加一层硬退出兜底：正常退不掉就直接 exit(0)，文件锁必须让出来。
 */
function quitForUpdate() {
  quitting = true;
  setTimeout(() => { try { app.quit(); } catch (_) { /* ignore */ } }, 900);
  // 留足操作排空与窗口批量关闭的时间，仍短于更新脚本的 60 秒等待。
  setTimeout(() => { try { app.exit(0); } catch (_) { /* ignore */ } }, 45000);
}

/**
 * 上次更新有没有装成功。
 *
 * 升级脚本在失败时会留下 update/failed.json（并保留安装包），这里读出来告诉用户，
 * 而不是让用户对着一模一样的旧界面猜「到底更没更新」。读一次就删，不反复打扰。
 */
function notifyUpdateFailure() {
  // 先看「升级脚本到底跑没跑起来」：
  //   stalled = 脚本连「等到 App 退出」都没写下来 —— 十有八九是启动方式被拦
  //            （App 退出把子进程一起带走了 / 安全软件拦了 PowerShell）。
  //            这种情况重试同一个按钮仍然没用，必须引导用户手动装。
  try {
    const p = typeof updater.pendingApply === 'function' ? updater.pendingApply() : { state: 'none' };
    if (p.state !== 'none' && p.version) updater.blockAutoApply(p.version);
    if (p.state === 'stalled') {
      appLog(`previous update stalled at v${p.version}: apply script never ran`);
      send('toast', {
        type: 'warn',
        sticky: true,
        message: `上次更新到 ${p.version} 没装成：安装程序根本没被拉起来。`
          + '安装包已经下好了，到「设置 → 软件更新」点「手动安装」即可（不会重新下载）。',
      });
      return;
    }
  } catch (_) { /* 凭条读坏了按老逻辑走 */ }
  try {
    const f = path.join(updater.updateDir, 'failed.json');
    if (!fs.existsSync(f)) return;
    // 也兼容旧脚本和便携更新写出的 UTF-8 BOM。
    const raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) || {};
    const v = String(raw.version || '').replace(/^v/i, '');
    if (v) updater.blockAutoApply(v);
    fs.rmSync(f, { force: true });
    updater.clearPending();
    const detail = raw.rollback === 'restored' ? '已恢复旧版程序文件。'
      : raw.rollback === 'not-attempted' ? '安装前检查未通过，未运行安装程序。'
        : raw.rollback === 'not-started' ? '安装程序已取消，旧版文件未改动。'
          : raw.rollback === 'unverified' ? '未能确认旧版已恢复，请查看更新日志。' : '';
    appLog(`previous update failed: v${v} rollback=${raw.rollback || 'unknown'} log=${raw.log || ''}`);
    send('toast', {
      type: 'warn',
      sticky: true,
      message: `上次更新到 ${v || '新版本'} 没有装成功。${detail}`
        + '安装包已经下载好了，可在「设置 → 软件更新」重试或选择手动安装。',
    });
  } catch (_) { /* 标记损坏无关紧要 */ }
}

/**
 * 把「重启并安装」真正启动起来：生成升级脚本 → 脱离父子关系地拉起 → 退出 App。
 *
 * 单独抽出来是因为自动更新和手动点按钮必须走同一条路 —— 以前自动更新那条
 * 在 updateBusy 还是 true 的时候调用 applyAutoUpdate，被守卫直接 return，
 * 于是「下载完成、随时可以重启安装」之后再也不会自己动，用户只能干等。
 */
let applyingUpdate = false;
function startApplyUpdate(job, label) {
  if (!job || applyingUpdate) return false;
  // Linux 发行形态（AppImage/deb）没有自更新通道：升级脚本、explorer、
  // powershell 都是 Windows 的东西，跑了只会坏。明确引导到发布页。
  if (process.platform !== 'win32' && job.mode !== 'appimage') {
    appLog('update apply blocked: platform linux has no auto-update channel');
    send('update:progress', { stage: 'error', percent: 0, message: 'Linux 版暂不支持应用内自动更新，请到项目发布页下载新版本' });
    notify('不支持应用内更新', '请到项目发布页下载 Linux 新版本');
    return false;
  }
  applyingUpdate = true;
  notify('正在自动更新', `即将重启并安装 ApkStart ${label || job.version || ''}`.trim());
  send('update:progress', { stage: 'apply', percent: 100, message: '正在替换程序并重启…' });
  try {
    const r = updater.apply(job);
    appLog(`update apply launched via ${r && r.via ? r.via : 'unknown'} v${job.version || ''}`);
  } catch (e) {
    // 脚本都拉不起来就别退出了：退出去只会留下一个没人管的半截更新
    applyingUpdate = false;
    appLog(`update apply launch failed: ${e.message}`);
    send('update:progress', { stage: 'error', percent: 0, message: e.message });
    notify('自动安装启动失败', `${e.message}；可在「设置 → 软件更新」点「手动安装」`);
    return false;
  }
  quitForUpdate();
  return true;
}

function applyAutoUpdate() {
  if (!autoUpdateJob || applyingUpdate) return false;
  const job = autoUpdateJob;
  autoUpdateJob = null;
  if (updater.autoApplyBlocked(job.version)) return false;
  return startApplyUpdate(job, autoUpdateTag);
}

async function autoUpdateFlow(info) {
  if (updateBusy || autoUpdateJob || updater.autoApplyBlocked(info.version || info.tag)) return;
  notify('发现新版本', `ApkStart ${info.tag}，正在自动下载（完成后自动重启安装）…`);
  send('update:state', info);
  updateBusy = true;
  try {
    const job = await updater.prepare(info);
    autoUpdateJob = job;
    autoUpdateTag = info.tag || info.version;
    appLog(`auto update payload ready: ${job.mode} v${job.version}`);
    // 告诉界面「包已经在本地」：设置页的按钮要变成「重启并安装」，
    // 否则用户看到「立即更新」会以为还得再点一次重新下载。
    send('update:state', { ...info, downloaded: true, downloadedVersion: job.version });
    if (appWin && appWin.isOpen && appWin.pkg) {
      send('toast', {
        type: 'info',
        sticky: true,
        message: `新版本 ${autoUpdateTag} 已下载完成。关闭当前应用窗口后会自动重启安装；也可以在「设置 → 软件更新」里立即安装。`,
      });
    } else {
      applyAutoUpdate();
    }
  } catch (e) {
    appLog(`auto update failed: ${e.message}`);
    notify('自动更新下载失败', `${e.message}（可在「设置 → 软件更新」手动重试）`);
  } finally {
    updateBusy = false;
  }
}

/** 处理一次「查到了新版本」：按设置决定自动更新还是只通知 */
function handleUpdateFound(info) {
  updateInfo = info;
  send('update:state', info);
  if (!info.hasUpdate) return;
  appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
  if (info.canAutoApply && info.flavor !== 'deb' && store.getSettings().update.autoUpdate === true
      && !updater.autoApplyBlocked(info.version || info.tag)) {
    autoUpdateFlow(info).catch((e) => appLog(`auto update error: ${e.message}`));
  } else {
    notify('发现新版本', 'ApkStart ' + info.tag + ' 已发布，可在设置中查看更新详情');
  }
}

async function runUpdate() {
  if (updateBusy) return { ok: false, error: '正在更新中' };
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    let info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: '已经是最新版本' };
    // 自动更新已经把载荷下载好了：直接装，不再重复下载
    if (autoUpdateJob) {
      const job = autoUpdateJob;
      autoUpdateJob = null;
      sendProgress({ stage: 'apply', percent: 100, message: '已下载完成，正在替换程序并重启…' });
      if (!startApplyUpdate(job, info.version || autoUpdateTag)) {
        autoUpdateJob = job;   // 没启动成，载荷还留在本地，下次点「手动安装」直接用它
        return { ok: false, code: 'apply-launch-failed', error: '自动安装没启动起来，请在「设置 → 软件更新」点「手动安装」' };
      }
      return { ok: true, version: info.version || autoUpdateTag, mode: job.mode };
    }
    if (!info.asset) {
      // 发布页先出、安装包后传（CI 打包要 10~20 分钟）。这段时间 check() 会给出
      // hasUpdate=true、asset=null —— 旧实现直接把用户丢去浏览器自己下载，
      // 明明「一键更新」就在眼前却点不动。这里强制重查一次（跳过 10 分钟缓存）：
      // 包已经传完就继续下载安装，没传完就如实告诉用户，别假装成功。
      sendProgress({ stage: 'check', percent: 0, message: '正在重新检查安装包…' });
      info = await updater.check({ force: true });
      updateInfo = info;
      if (!info.hasUpdate) return { ok: false, error: '已经是最新版本' };
    }
    if (!info.asset) {
      const v = String(info.version || info.tag || '').replace(/^v/i, '');
      return {
        ok: false,
        code: 'no-asset',
        error: `v${v} 的安装包还没上传完（构建通常需要 10~20 分钟），稍后再点一次即可；`
          + '也可以点「打开下载页」自己挑安装版或便携版',
      };
    }
    if (!info.canAutoApply) return { ok: false, error: '缺少可验证的更新包，请打开发布页' };
    sendProgress({ stage: 'download', percent: 0, message: '准备下载…' });
    const job = await updater.prepare(info);
    if (job.mode === 'deb') {
      const error = await shell.openPath(job.payload);
      return error ? { ok: false, error } : { ok: true, mode: 'deb', version: job.version };
    }
    sendProgress({ stage: 'apply', percent: 100, message: '正在替换程序并重启…' });
    if (!startApplyUpdate(job, info.version)) {
      autoUpdateJob = job;
      return { ok: false, code: 'apply-launch-failed', error: '自动安装没启动起来，请在「设置 → 软件更新」点「手动安装」' };
    }
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

// 并发启动防护：一次只允许一个 runLaunch 在跑。两个并发（用户手点 + 托盘菜单 /
// 快捷方式 / CDP 驱动等入口同时触发）会互相杀掉对方正在开机的运行时、把未写完的
// 快照标成损坏、触发 4 连重试甚至渲染后端崩溃（实测 0xC0000005），网络也会丢。
let launchBusy = false;

/**
 * 检测「Android 仍在线且已完成开机，但模拟器 Qt 画面窗口已消失」的无头运行时。
 * 不依赖 runtime.vmRunning：跨 ApkStart 进程接管的 emulator 没有本地 child-process 句柄，
 * vmRunning 会是 false；只要 ADB 已在线，就应该继续检查窗口句柄。
 * Attach 模式不管理外部模拟器窗口，绝不自动关停用户自己的运行时。
 */
async function hasHeadlessRuntimeWindow() {
  if (!runtime || !winAgent || runtime.settings.engine.mode === 'attach'
      || runtime.settings.engine.headless || runtime.vmProc) return false;
  const online = await runtime.client().isOnline().catch(() => false);
  if (!online) return false;
  const booted = await runtime.client().shell('getprop sys.boot_completed', { timeout: 6000 })
    .then((s) => String(s || '').trim() === '1').catch(() => false);
  if (!booted) return false;
  const probe = () => winAgent.emuAlive().catch(() => null);
  const first = await probe();
  if (!first || first.ok !== true || first.alive !== false) return false;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await probe();
  return !!(second && second.ok === true && second.alive === false);
}

/**
 * 代理是否两次都确认「模拟器画面窗口不存在」。
 * 单次采样可能是 Qt 窗口还没建好，必须间隔复测；代理连不上（null）不下结论。
 */
async function emuWindowGone() {
  if (!winAgent) return false;
  const probe = () => winAgent.emuAlive().catch(() => null);
  const first = await probe();
  if (!first || first.ok !== true || first.alive !== false) return false;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const second = await probe();
  return !!(second && second.ok === true && second.alive === false);
}

/** 停掉已确认无头的内置模拟器，并跳过一次可能损坏的 Quick Boot 快照。 */async function stopHeadlessRuntime() {
  if (!runtime || runtime.settings.engine.mode === 'attach') return false;
  if (runtime.emulator) {
    // 重启无头实例时不要从故障状态保存 Quick Boot；下一次启动走完整冷启动。
    runtime.emulator.snapshotWorthSaving = false;
    if (runtime.emulator.forceColdBootOnNextStart) runtime.emulator.forceColdBootOnNextStart();
  }
  const stopped = await runtime.stop({ graceful: false });
  if (!stopped) throw new Error('未能停止丢失画面窗口的模拟器，已取消自动重启以避免重复接管');
  // Runtime.stop 对接管实例会按控制台端口强杀，但 Windows 进程退出与 ADB
  // 设备列表更新有竞态。必须确认旧实例已经离线，才允许 installer.launch/ensure，
  // 否则 ensure 可能把刚刚判为无头的同一台 guest 又接管回来。
  for (let i = 0; i < 40; i += 1) {
    // 不能只等 ADB 离线：taskkill 后 ADB 可能先断、QEMU 控制台端口还没释放，
    // ensure() 会在这段竞态里把旧实例重新 adopt 回来。两个信号都确认消失才继续。
    // eslint-disable-next-line no-await-in-loop
    const [online, consoleAlive] = await Promise.all([
      runtime.client().isOnline().catch(() => false),
      runtime.emulator && runtime.emulator._consoleAlive
        ? runtime.emulator._consoleAlive().catch(() => false)
        : Promise.resolve(false),
    ]);
    if (!online && !consoleAlive) {
      if (runtime._activeApps && typeof runtime._activeApps.clear === 'function') {
        runtime._activeApps.clear();
      }
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('旧模拟器仍在线，已取消自动重启以避免重复接管');
}

async function runLaunch(pkg) {
  if (launchBusy) {
    appLog(`launch ${pkg} rejected: another launch in progress`);
    send('toast', { type: 'info', message: '正在启动另一个应用，请等它完成后再试。' });
    if (appWin && appWin.isOpen) {
      try { appWin.win.show(); appWin.win.focus(); } catch (_) { /* 已关 */ }
    }
    return { ok: false, error: 'busy' };
  }
  launchBusy = true;
  try {
    return await runtimeActions.run('app:launch', () => runLaunchInner(pkg));
  } catch (e) {
    send('toast', { type: 'error', message: e.message });
    if (!quitting) showWindow();
    return { ok: false, error: e.message };
  } finally {
    launchBusy = false;
  }
}

/**
 * 模块级的「人话失败说明」。
 * runLaunchInner 不在 registerIpc 作用域里，拿不到那边的 lastDiagnosis()，
 * 这里直接读运行时上的结论（内存里的优先，进程重启过就翻 last-failure.json）。
 */
function plainRuntimeFailure() {
  try {
    const emu = runtime && runtime.emulator;
    if (!emu) return '';
    const d = emu.lastDiagnosis
      || (typeof emu.lastFailure === 'function' && (emu.lastFailure() || {}).diagnosis)
      || null;
    if (!d) return '';
    return repair.explainFailure({ diagnosis: d }).text || '';
  } catch (_) {
    return '';
  }
}

async function runLaunchInner(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  appLog(`launch start ${pkg}`);
  try {
    // 0) 先决定这个应用该用横屏还是竖屏 LCD。
    //    模拟器窗口比例开机锁死（issue #41），所以必须赶在拉起运行时之前定下来；
    //    窗口本身也先按这个比例打开，别等模拟器起来再改（改一次要重排画面）。
    const rec = store.getApp(pkg);
    const want = lcd.desiredOrientation(rec);
    // 显示方式（engine.windowMode）：
    //   auto —— 先试嵌入；一旦这台机器被判定「嵌入必黑」（embeddedBlack），
    //           以后直接走独立窗口，不再让用户每次都先对着一块黑屏等几秒。
    //   standalone —— 始终用模拟器自己的窗口；embedded —— 始终嵌进应用窗口。
    const engCfg = store.getSettings().engine || {};
    const wantStandalone = engCfg.windowMode === 'standalone'
      || (engCfg.windowMode !== 'embedded' && engCfg.embeddedBlack === true);
    if (wantStandalone) appLog(`window mode: standalone (embeddedBlack=${!!engCfg.embeddedBlack})`);
    const launchWindow = openAppWindow(pkg, '正在启动安卓运行时…', want ? lcd.orientBox(portraitSize(), want) : windowBox(),
      { hidden: wantStandalone });
    const launchCancelled = () => quitting || appWin.win !== launchWindow || launchWindow.isDestroyed();
    // 1) 先把「应用窗口」打开显示启动动画：整个过程看不到安卓桌面，也看不到模拟器窗口
    // 开机阶段把模拟器主窗 + qemu / netsimd 的控制台黑窗藏起来，避免任何闪现。
    // 压制是常驻的（embed 后它会自动跳过被嵌入的那一个窗口，见 appwin.embed）。
    // 这里必须 await：不等压制生效就往下走，黑窗会在启动瞬间露出来。
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();

    // 「无头运行时」自愈（上游 issue #42）：即使 qemu 是上一个 ApkStart 进程
    // 接管过来的（没有当前进程的 emulator child handle），只要 ADB 已在线、guest
    // 已启动且 Qt 画面窗口两次探测都不存在，就安全重启；开机中途不做破坏性操作。
    if (await hasHeadlessRuntimeWindow()) {
      mark('headless runtime detected (adb online, emu window gone) -> cold restart');
      appWin.setState({ tip: '检测到安卓显示通道异常，正在重启安卓运行时…', ready: false });
      // 停机未确认完成时必须中止，不能让 ensure() 又把旧的无头实例接管回来。
      await stopHeadlessRuntime();
    }

    // 运行时已经在跑、但 LCD 方向和应用对不上：只有重启运行时才能真的铺满。
    // 不静默重启 —— 那是 1 分钟的等待，用户有权知道并拒绝（拒绝就按现在的
    // 逻辑用 wm size 居中显示，和旧版本一样）。
    let lcdOrientation = want;
    if (want && runtime.vmRunning && lcd.needsRestart(runtime.lcdOrientation, want)) {
      const go = await askLcdSwitch(rec, want, runtime.lcdOrientation).catch(() => false);
      if (go) {
        appWin.setState({ tip: `正在以${lcd.label(want)}模式重启安卓运行时…`, ready: false });
        mark(`lcd switch -> ${want}`);
        await runtime.stop().catch(() => {});
      } else {
        lcdOrientation = '';
        mark(`lcd switch declined (${want})`);
        // 窗口刚才是按「目标方向」开的，用户选了保持现状就得收回去，
        // 否则变成横窗口套竖画面（比原来的居中显示更糟）。
        const cur = runtime.emulator && runtime.emulator.lcd;
        if (cur && cur.w && cur.h) appWin.applyBox(cur);
      }
    }

    const launchOptions = {
      lcdOrientation,
      shouldCancel: launchCancelled,
      onLog: (m) => {
        send('runtime:log', m);
        appLog(`  rt ${m}`);
        // 自动修复硬件加速会弹管理员授权（UAC）。用户这时只看到一个系统弹窗，
        // 不知道是谁弹的、该不该点 —— 必须在应用启动窗口里同步说清楚。
        if (/自动修复|硬件加速已修复|自动修复没能立即生效/.test(String(m || '')) && appWin.isOpen) {
          appWin.setState({ ready: false, tip: m });
        }
        // 首次打开大型 APK 时，安装本身可能持续几十秒；把这段真实状态
        // 传到应用窗口，避免用户把安装等待误认为启动卡死。
        if (/应用尚未安装|正在自动安装|正在安装应用/.test(String(m || '')) && appWin.isOpen) {
          appWin.setState({ ready: false, tip: '首次启动正在安装应用，可能需要几十秒…' });
        }
      },
      onMark: mark,
      beforeStart: async (rt) => {
        if (launchCancelled()) throw new Error('应用窗口已关闭或 ApkStart 正在退出，未打开应用');
        windowClients.set(launchWindow, rt.client);
        mark('engine ready');
        appWin.setState({ tip: '正在打开应用…' });
        // 沉浸式 + 关动画 + 收起锁屏：只做一次，之后每次启动都秒进
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
      },
    };
    let r = await installer.launch(pkg, launchOptions);
    if (launchCancelled()) throw new Error('应用窗口已关闭或 ApkStart 正在退出，已取消窗口接管');
    if (!r || !r.ok) throw new Error((r && r.error) || '应用未能启动');
    mark('app started');

    // ensure() 可能复用了切换运行时目录前留下的 detached 模拟器。此时
    // armAgent 在窗口打开阶段只看到了 settings.runtime.dir，必须在运行时
    // 确认在线后再重发一次作用域，才能让代理找到实际的 emulator 窗口。
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* 诊断性兜底 */ } }

    // 2) 应用真的活下来了，才把画面接上来（否则用户会先看到闪一下的桌面/崩溃页）
    let embedded = false;
    let detached = false;
    if (wantStandalone) {
      // 一步到位：不 SetParent、不采样黑帧，直接把模拟器自己的窗口亮出来。
      // 软件渲染 / 无硬件加速的机器上嵌入必黑，先嵌再摘只会让用户多等一轮。
      detached = await appWin.standalone();
      mark(`standalone=${detached}`);
      if (!detached) {
        appLog(`standalone failed: ${appWin.lastEmbedError || 'unknown'}`);
        // 代理说找不到画面窗口 = qemu 还活着但 Qt 窗口没了（上游 #42）。
        // 这时候再怎么切显示方式都没用，只能重启一次运行时。
        try {
          if (await emuWindowGone()) {
            mark('standalone: emu window gone -> cold restart and relaunch app');
            appWin.setState({ ready: false, tip: '模拟器画面窗口丢失，正在重启安卓并重新打开应用…' });
            await stopHeadlessRuntime();
            r = await installer.launch(pkg, launchOptions);
            if (!r || !r.ok) throw new Error((r && r.error) || '运行时重启后应用未能重新启动');
            if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
            detached = await appWin.standalone();
            appLog(`standalone after runtime restart=${detached}`);
          }
        } catch (e) {
          appLog(`standalone recovery failed: ${e && e.message}`);
        }
      }
    } else {
      embedded = await appWin.embed();
      // 启动阶段仍可能在启动应用后才发现 HWND 丢失（例如 detach/window close 竞态）。
      // 这种情况下现在的 App 已经在 guest 中运行；停掉并重新 ensure 后必须重新启动它，
      // 不能只重启 Android 然后对空桌面尝试 embed。
      if (!embedded && !appWin.external && !appWin.blackDetached
          && (appWin.lastEmbedError || '').startsWith('emu=0')) {
        try {
          if (await hasHeadlessRuntimeWindow()) {
            mark('headless runtime detected after app start -> cold restart and relaunch app');
            appWin.setState({ ready: false, tip: '模拟器画面窗口丢失，正在重启安卓并重新打开应用…' });
            await stopHeadlessRuntime();
            r = await installer.launch(pkg, launchOptions);
            if (!r || !r.ok) throw new Error((r && r.error) || '运行时重启后应用未能重新启动');
            mark('app relaunched after runtime restart');
            if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
            embedded = await appWin.embed().catch(() => false);
            appLog(`embed after runtime restart=${embedded} error=${appWin.lastEmbedError || ''}`);
          }
        } catch (e) {
          appLog(`headless runtime recovery failed: ${e && e.message}`);
        }
      }
      // 嵌入成功但宿主画黑帧时，appwin 会自己摘成独立窗口：这不是「嵌入失败」，
      // 而是「换了一条能看见画面的路」，顶层不能再去重试 SetParent（必然再黑一次）。
      detached = !embedded && !!appWin.blackDetached;
      if (detached) {
        appLog(`embed black frame (mean=${appWin.lastBlackMean}) -> detached standalone window`);
        // 这台机器嵌入必黑：记下来。下次点应用直接走独立窗口，不再让用户先对着
        // 一块黑屏等几秒（实测用户的判断就是「程序没反应 / 一直加载」）。
        if (engCfg.windowMode !== 'embedded' && engCfg.embeddedBlack !== true) {
          try {
            store.saveSettings({ engine: { embeddedBlack: true } });
            appLog('remembered standalone mode for this machine (embeddedBlack=true)');
          } catch (e) { appLog(`save embeddedBlack failed: ${e.message}`); }
        }
      } else if (!embedded) {
        appLog(`embed failed: ${appWin.lastEmbedError || 'unknown'}`);
      }
    }
    mark(`embedded=${embedded} detached=${detached}`);
    // 嵌入完成后把窗口从别的窗口底下抬出来。否则上层窗口（浏览器等）会盖住安卓画面，
    // 用户看到的是「黑屏 / 画面没填满」，鼠标也点不到应用（全被上层窗口吃掉）。
    // 短暂 topmost 再立刻撤销，只借用一次置顶把 Z 序抬到最前，不会长期霸占顶层。
    if (appWin.isOpen) {
      if (detached) {
        // 独立窗口：把这块永远连不上画面的黑壳直接藏起来。代理 detach 时已经把
        // 模拟器窗口亮出来并抢到前台 —— 用户点应用就该看到画面，而不是黑壳。
        try { appWin.win.hide(); } catch (_) { /* 窗口可能刚关 */ }
        send('toast', {
          type: 'success',
          message: `《${(store.getApp(pkg) || {}).label || pkg}》已在「Android Emulator」窗口打开。`,
        });
        appLog('standalone window shown; host window hidden');
      } else {
        try {
          appWin.win.show();
          appWin.win.setAlwaysOnTop(true);
          appWin.win.moveTop();
          appWin.win.focus();
          setTimeout(() => {
            if (!launchCancelled()) {
              try { launchWindow.setAlwaysOnTop(false); } catch (_) { /* 窗口已关 */ }
            }
          }, 700);
        } catch (_) { /* 窗口可能刚关闭 */ }
      }
    }
    appWin.setState(detached
      // 独立窗口：宿主已隐藏，这条状态只在用户从任务栏把它调出来时才看得到
      ? { ready: true, tip: '画面在「Android Emulator」窗口里显示。' }
      : appWin.external
        // 非 Windows：画面只能留在模拟器自己的窗口里。不要显示黑屏，
        // 直接在应用窗口里写明「去哪看画面」（upstream #24）。
        ? { ready: false, tip: platform.supportNote() }
        // Windows 上 embed=false 仍然代表画面句柄尚未接上：启动遮罩必须继续留着，
        // 否则 shell 会把黑底当成「已经就绪」，用户只能看到一块黑屏。
        : embedded
          ? { ready: true, tip: '' }
          : { ready: false, tip: '正在连接安卓画面…' });
    if (appWin.external) appLog(`embed unsupported on ${platform.platform}: external window mode`);
    // 嵌入失败（模拟器窗口还没建好）时按递增间隔有限重试；
    // 每次成功都显式更新 ready，失败则一直保留启动遮罩而不是露出黑屏。
    // 独立窗口模式下不去试嵌入：那台机器的宿主渲染路径本来就是坏的。
    if (!embedded && !appWin.external && !detached && !wantStandalone) {
      // embed() 失败只说明找不到目标 HWND 或 SetParent 失败，不等于运行时坏了。
      // 先让 Qt 窗口有时间建好，按既有策略短暂重试；若 guest 已开机但窗口持续缺失，
      // 下一次启动入口会先识别无头运行时并做完整重启 + 应用重启。
      const delays = [1200, 2400, 4800, 8000];
      (async () => {
        for (let i = 0; i < delays.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, delays[i]));
          if (launchCancelled()) return;
          appWin.setState({ ready: false, tip: `正在连接安卓画面…（${i + 2}/${delays.length + 1}）` });
          // eslint-disable-next-line no-await-in-loop
          const ok = await appWin.embed().catch(() => false);
          if (launchCancelled()) return;
          mark(`embed retry ${i + 1}/${delays.length}=${ok}`);
          if (ok) {
            appWin.setState({ ready: true, tip: '' });
            appLog(`embed recovered on retry ${i + 1}/${delays.length}`);
            return;
          }
        }
        if (!launchCancelled()) {
          appWin.setState({ ready: false, tip: '安卓画面窗口没有连接。请关闭当前窗口后再点开应用，程序会自动重建显示通道。' });
          appLog('embed retries exhausted; keeping startup overlay visible');
        }
      })().catch((e) => appLog(`embed retry loop failed: ${e.message}`));
    }
    // 容器会话：环境已经就绪，这里只做「按应用裁剪 + 打开后台轮询」，
    // 不再为这个 App 重新引导一遍 Android。鼠标键位钩子由窗口 focus 事件
    // 按设置决定，失焦即卸载。
    deviceSize.value = null;
    appWin.refreshPointer();
    if (launchCancelled()) throw new Error('应用窗口已关闭或 ApkStart 正在退出，未启动后台会话');
    await runtime.beginApp(pkg, { client: windowClients.get(launchWindow), onActive: onContainerActive, shouldCancel: launchCancelled }).catch(() => {});
    if (launchCancelled()) throw new Error('应用窗口已关闭或 ApkStart 正在退出');
    // 游戏/低延迟模式：让窗口代理降频扫描，减少全桌面 EnumWindows 造成的整机卡顿
    if (winAgent) {
      const game = store.getSettings().engine && store.getSettings().engine.priorityMode === 'game';
      winAgent.setPerformanceMode(!!game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} embedded=${embedded} detached=${detached}`);
    return { ok: true, embedded, detached };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // 启动失败也把模拟器窗口继续压住（不要让它以「独立的模拟器窗口」形式露出来），
    // 下次点应用还是走同一条隐藏 → embed 的路径。
    if (!quitting && winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    // 运行时起不来时，用户该看到的是人话（哪坏了 + 程序做了什么 + 下一步点哪），
    // 而不是 installer 里那句「运行时多次尝试仍未能启动」。
    const technical = String((e && e.message) || '');
    const plain = /运行时|未能启动|开不完|启动失败|device offline|no devices|模拟器/i.test(technical)
      ? plainRuntimeFailure() : '';
    const msg = plain || technical;
    send('toast', { type: 'error', message: `启动失败：${msg}`, sticky: !!plain });
    return { ok: false, error: msg, technical };
  }
}

/**
 * 容器有/无应用窗口时的后台任务开关。
 * 文件同步每 8 秒要遍历共享目录并走一次 adb find/stat，通知桥也在轮询；
 * 以前从 ApkStart 一启动就无条件开跑，哪怕一个 Android 应用都没打开。
 * 现在只在容器里真的有应用时才开，关掉最后一个窗口立刻停。
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/** 通知桥：只在有应用窗口时轮询，关掉窗口就停，避免空转 */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

/**
 * 无人值守自检：`APKSTART_SELFTEST=1` 启动后自动体检主窗口并退出。
 *
 * 升级 Electron、改 IPC 边界这类改动，单元测试看不出「界面其实已经白屏」。
 * 这里用真实渲染进程走一遍：preload 是否注入、IPC 是否真的通、页面有没有脚本错误。
 * 只在环境变量打开时执行，正常使用完全不受影响。
 */
async function runSelfTestAndExit() {
  const result = { version: app.getVersion(), electron: process.versions.electron, checks: [] };
  const push = (name, ok, detail = '') => result.checks.push({ name, ok, detail });
  const errors = [];
  try {
    const wc = mainWindow.webContents;
    wc.on('console-message', (ev) => {
      if (ev && ev.level === 'error') errors.push(String(ev.message));
    });
    await new Promise((resolve) => {
      if (!wc.isLoading()) return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 15000);
    });
    await new Promise((r) => setTimeout(r, 2500));

    // 这一句能拿到结果，就说明 preload 注入、sandbox、IPC 来源校验三件事同时成立
    const probe = await wc.executeJavaScript(`(async () => {
      const out = { bridge: typeof window.apkstart, info: null, settings: null, err: '' };
      try {
        out.info = await window.apkstart.info();
        out.settings = await window.apkstart.getSettings();
      } catch (e) { out.err = String(e && e.message || e); }
      out.nodes = document.body ? document.body.children.length : 0;
      return out;
    })()`);

    push('preload 注入', probe.bridge === 'object', probe.bridge);
    push('IPC app:info 可用', !!(probe.info && probe.info.version), probe.err || JSON.stringify(probe.info || null));
    push('IPC settings:get 可用', !!probe.settings && typeof probe.settings === 'object', probe.err);
    push('页面已渲染', probe.nodes > 0, `${probe.nodes} 个顶层节点`);
    const real = errors.filter((m) => !/No handler registered|ERR_|Failed to fetch/i.test(m));
    push('无未处理脚本错误', real.length === 0, real.slice(0, 3).join(' | '));
  } catch (e) {
    push('自检执行', false, e && (e.stack || e.message));
  }
  result.ok = result.checks.every((c) => c.ok);
  const json = JSON.stringify(result);
  // 打包后的 Windows 程序没有控制台，stdout 会直接丢掉 —— 同时落一份文件，
  // 这样「安装包到底能不能起来」这件事在 CI 上也能被真实断言。
  try {
    fs.writeFileSync(path.join(require('os').tmpdir(), 'apkstart-selftest.json'), json, 'utf8');
  } catch (_) { /* 写不了文件不影响控制台输出 */ }
  console.log(`SELFTEST_JSON:${json}`);
  app.exit(result.ok ? 0 : 1);
}

/** 只有显式设置 APKSTART_SELFTEST=1 才跑，正常启动完全不进这个分支 */
function scheduleSelfTest() {  if (process.env.APKSTART_SELFTEST !== '1') return;
  runSelfTestAndExit().catch((e) => {
    console.error('SELFTEST_JSON:' + JSON.stringify({ ok: false, error: String(e && (e.stack || e.message)) }));
    app.exit(1);
  });
}

/**
 * 兼容性判定用的运行时环境。
 * 运行时在线时用真实 API 等级；没启动时按内置运行时（Android 14）评估，
 * 并在结果里标出来源，避免用户把「按默认值估的」当成实测结论。
 */
async function compatEnv() {
  let sdk = 34;
  let live = false;
  try {
    const st = await runtime.status();
    if (st && st.sdk) { sdk = Number(st.sdk) || 34; live = true; }
  } catch (_) { /* 运行时还没起来：用默认值 */ }
  let profile = null;
  try { profile = runtime.provisioner.imageProfile(); } catch (_) { /* ignore */ }
  const armTranslation = profile ? !!profile.armTranslation : true;
  const playServices = profile ? !!profile.gms : true;
  return {
    sdk,
    abis: ['x86_64'],
    armTranslation,
    playServices,
    imageFlavor: profile ? profile.id : 'google_apis_playstore',
    source: live
      ? `当前运行时（Android ${compat.sdkName(sdk)} · ${profile ? profile.shortLabel : '系统镜像'}）`
      : `内置运行时（Android 14 · ${profile ? profile.shortLabel : 'Google Play（兼容模式）'}）`,
  };
}

// ---------------- IPC 安全边界 ----------------

/** 只信任 src 目录下自己那几张页面（index.html / shell.html） */
const IPC_TRUSTED_ROOT = path.resolve(__dirname);

/**
 * 给所有 invoke 通道统一校验窗口身份、主框架、页面与角色权限。
 * 窗口代理只能操作自己的界面，不继承主窗口的设置、安装和维护权限。
 */
function installIpcGuards() {
  if (ipcMain.__apkstartGuarded) return;
  ipcMain.__apkstartGuarded = true;
  const changesSession = new Set([
    'system:switch', 'system:stop', 'system:confirmInstall', 'system:restore', 'system:remove',
    'runtime:stop', 'runtime:setImageFlavor', 'runtime:setDataSize', 'runtime:resetData',
    'runtime:repairRun', 'runtime:startInstaller', 'runtime:markInstalled', 'runtime:resetInstall',
    'image:activate', 'image:restore', 'image:remove', 'provision:installAdb',
  ]);
  const wrap = (orig) => function guarded(channel, listener) {
    return orig.call(ipcMain, channel, (event, ...args) => {
      const verdict = ipcguard.authorizeEvent(IPC_TRUSTED_ROOT, event, channel, {
        mainWindow, shellWindow: appWin?.win,
      });
      if (!verdict.ok) {
        console.warn(`[ipc] 拒绝不可信调用 ${channel}：${verdict.reason}`);
        throw new Error('IPC 调用被拒绝：此窗口无权调用该功能');
      }
      const has = (obj, key) => obj != null && typeof obj === 'object' && Object.hasOwn(obj, key);
      const patch = channel === 'settings:set' ? args[0] : null;
      const changesTarget = has(patch, 'device') || has(patch, 'adbPath') || has(patch?.engine, 'mode')
        || ['dir', 'avdDir', 'systemImageFlavor', 'compatImage'].some(key => has(patch?.runtime, key));
      if ((changesTarget || changesSession.has(channel)) && appWin?.isOpen) {
        throw new Error('请先关闭安卓应用窗口，再更改运行时目标或执行系统维护');
      }
      const mode = channelMode(channel) || (changesTarget || channel === 'provision:installAdb' ? { builtin: false } : null);
      return mode ? runtimeActions.run(channel, () => listener(event, ...args), mode) : listener(event, ...args);
    });
  };
  ipcMain.handle = wrap(ipcMain.handle);
  ipcMain.handleOnce = wrap(ipcMain.handleOnce);
}

// ---------------- IPC ----------------

function registerIpc() {
  installIpcGuards();

  // ---- 多系统管理（懒加载单例）：统一目录 + Provider + 任务管理器 ----
  let _systemManager = null;
  const getSystemManager = () => {
    if (_systemManager) return _systemManager;
    const catalog = new SystemCatalog({ appRoot: APP_ROOT });
    const doctor = require('./core/doctor');
    const switchFlavor = async (flavor) => {
      const profile = runtime.provisioner.imageProfile(String(flavor || ''));
      if (runtime.vmRunning || await runtime.client().isOnline()) {
        const stopped = await runtime.stop();
        if (!stopped || runtime.vmRunning || await runtime.client().isOnline()) return { ok: false, error: '当前安卓运行时未能停止，未切换系统' };
      }
      store.saveSettings({ runtime: {
        systemImageFlavor: profile.id,
        compatImage: profile.id === 'google_apis_playstore',
      } });
      appLog(`[system] built-in flavor -> ${profile.id}; AVD=${profile.avd}`);
      return { ok: true, profile };
    };
    _systemManager = new SystemManager({
      store, catalog, doctor,
      provisioner: runtime.provisioner,
      backendEngine: runtime,
      switchFlavor,
      settingsFn: () => store.getSettings(),
      onEvent: (task) => send('system:task', task),
      onLog: (m) => { appLog('[system] ' + m); send('system:log', String(m)); },
    });
    return _systemManager;
  };
  currentSystemStatus = () => getSystemManager().getStatus();

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    avdHome: runtime.provisioner.paths().avdHome,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
    platform: platform.describe(),
  }));

  // 界面文案（upstream #38）：中文是源语言，词典按中文原文索引。
  // 渲染层只拿一次「语言 + 词典」，自己遍历 DOM 翻译 —— 不为每条文案走一次 IPC。
  ipcMain.handle('app:i18n', () => i18n.payload(app.getLocale()));
  ipcMain.handle('app:theme', () => ({ theme: store.getSettings().theme }));

  // 选文件夹（用于把运行时/镜像/已装应用挪到非系统盘）
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择数据存放目录',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* 运行时未启动时忽略 */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要安装的 APK',
      filters: [
        { name: 'Android 应用', extensions: ['apk', 'apks', 'xapk'] },
        // 下载工具留在文件名上的 .1 / .tmp 之类的后缀在系统过滤器里匹配不到，
        // 给一条「所有文件」出口，用户手动挑 a.apk.1 也能装。
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  /**
   * 这个路径算不算安装包（含 a.apk.1 这类下载残留后缀）。
   * 渲染层在沙箱里拿不到 core/filetype，拖放判定走这里，保证两边规则一致。
   */
  ipcMain.handle('apk:kind', (_e, filePath) => ({
    kind: filetype.installKind(filePath),
    name: filetype.displayName(filePath),
  }));

  /** 安装前分析单 APK 或分包；分包仅在临时目录读取，不启动或安装到客机。 */
  ipcMain.handle('apk:compat', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filetype.isInstallable(filePath)) {
      throw new Error('只支持 .apk / .xapk / .apks 文件');
    }
    if (!fs.existsSync(filePath)) throw new Error('文件不存在或已被移动');
    const bundle = filetype.isSingleApk(filePath) ? null : await parseBundle(filePath);
    try {
      const info = bundle ? bundle.meta : parseApkCached(filePath);
      const result = compat.analyze(info, await compatEnv());
      // 图标是 Buffer，跨 IPC 传一次就是几百 KB，这里没必要带出去。
      const { iconPng, iconSvg, ...rest } = info;
      return { info: rest, compat: result };
    } finally {
      bundle?.cleanup();
    }
  });

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('应用不存在');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  // ── 备份 / 导出 ────────────────────────────────────────────
  ipcMain.handle('app:exportApk', async (_e, pkg) => {
    const record = store.getApp(pkg);
    if (!record) throw new Error('应用不存在');
    if (!record.apkPath || !fs.existsSync(record.apkPath)) {
      throw new Error('找不到这个应用的安装包（可能安装后被清理过）');
    }
    let kind = filetype.installKind(record.apkPath);
    if (record.bundle === true && kind === 'apk') {
      // 旧版本把分包容器缓存为 .apk；只检查 ZIP 目录，不为一次导出解压整个包。
      if (!isBundle(record.apkPath)) throw new Error('已缓存安装包与分包记录不匹配');
      kind = 'apks';
    }
    if (!kind) throw new Error('无法识别已缓存安装包的格式');
    const name = `${backup.sanitizeName(record.label || pkg, 40)}-${backup.sanitizeName(record.versionName || '1.0', 20)}.${kind}`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow || undefined, {
      title: '导出 Android 安装包',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: 'Android 安装包', extensions: [kind] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    if (filetype.installKind(filePath) !== kind) throw new Error(`请保留 .${kind} 后缀，以便重新导入安装包`);
    fs.copyFileSync(record.apkPath, filePath);
    return { ok: true, path: filePath };
  });

  ipcMain.handle('app:backup', async (_e, pkg) => {
    const app = store.getApp(pkg);
    if (!app) throw new Error('应用不存在');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择备份保存到哪个文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };

    // 运行时没起来时也要能备份：APK 是本机文件，不依赖设备；
    // 只是私有数据这一部分会明确告诉用户「没拿到」。
    let client = null;
    try {
      const c = runtime.client();
      if (await c.isOnline()) client = c;
    } catch (_) { client = null; }

    const r = await backup.backupApp({ app, client, dir: filePaths[0], onLog: () => {} });
    if (!client) {
      r.dataNote = '运行时未启动，只备份了 APK（应用数据需要设备在线且应用可 run-as）。';
      backup.writeMeta(r.folder, { ...r.meta, dataNote: r.dataNote });
    }
    return { ok: true, ...r };
  });

  ipcMain.handle('app:restore', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择备份文件夹（里面有 meta.json）',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    const client = runtime.client();
    if (!(await client.isOnline())) throw new Error('恢复应用需要先启动运行时');
    const r = await backup.restoreApp({
      dir: filePaths[0], installer, onLog: () => {},
    });
    return { ok: true, ...r };
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    // activeImageId 只能由图像适配层写（image:activate / image:restore）：
    // 那两个入口会先体检镜像。渲染层直接改这个键等于绕过校验，
    // 可能出现「设置里说在用自定义镜像，实际文件早没了」的状态。
    let safePatch = patch;
    if (patch && patch.runtime && 'activeImageId' in patch.runtime) {
      const { activeImageId, ...rest } = patch.runtime;
      safePatch = { ...patch, runtime: rest };
    }
    const next = store.saveSettings(safePatch);
    if (safePatch && safePatch.theme !== undefined) syncTheme(next.theme);
    if (safePatch && safePatch.autoStart !== undefined) applyAutoStart();
    // 语言变了（upstream #38）：主进程的菜单/对话框是下次打开才读到新语言，
    // 托盘菜单得重建一次，否则托盘里还是旧语言直到重启。
    if (patch && patch.language !== undefined) {
      i18n.setLanguage(i18n.resolve(next.language, app.getLocale()));
      appLog(`i18n language switched to ${i18n.getLanguage()}`);
      try { if (tray) tray.destroy(); } catch (_) { /* ignore */ }
      buildTray();
    }
    if (patch && patch.display && appWin && appWin.isOpen) {
      // 竖屏基准尺寸变了：只影响后续打开的窗口大小，不打断正在跑的应用
      appWin.portrait = windowBox();
    }
    // 打开「开始菜单快捷方式」时立刻补齐，不用等下次安装
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      ensureShortcuts();
    }
    // 鼠标键位变了：立刻按当前焦点重装/卸载钩子，不用等下次切窗口
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // 换了更新源 / 镜像前缀 / 整包地址：之前那套「谁最快」的结论不再成立，清掉测速缓存；
    // 运行时整包 / 引擎 / 镜像的地址还缓存在 provisioner._cache 里，不清掉就要重启进程才生效。
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /** 切换内置系统镜像档位：先停掉旧 AVD，再写入选择；其它档位的 AVD/数据保留。 */
  ipcMain.handle('runtime:setImageFlavor', async (_e, flavor) => {
    try {
      const profile = runtime.provisioner.imageProfile(String(flavor || ''));
      const prev = runtime.provisioner.imageProfile();
      if (profile.id === prev.id) {
        return { ok: true, flavor: profile.id, profile, stoppedVm: false, changed: false };
      }
      let stoppedVm = false;
      if (runtime.vmRunning || await runtime.client().isOnline()) {
        const stopped = await runtime.stop();
        if (!stopped || runtime.vmRunning || await runtime.client().isOnline()) throw new Error('当前安卓运行时未能停止，未切换系统镜像');
        stoppedVm = true;
      }
      store.saveSettings({ runtime: {
        systemImageFlavor: profile.id,
        // 旧兼容开关必须与档位保持一致，否则旧配置迁移会把刚选的
        // Google APIs/AOSP 再次改回 Google Play。
        compatImage: profile.id === 'google_apis_playstore',
      } });
      appLog(`built-in image flavor changed: ${prev.id} -> ${profile.id}; AVD=${profile.avd}`);
      return { ok: true, flavor: profile.id, profile, stoppedVm, changed: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ==================== 多系统 Provider 架构 IPC ====================
  /** 系统卡片列表（含可用性/安装状态/目录更新时间） */
  ipcMain.handle('system:list', async () => {
    try { return { ok: true, ...await getSystemManager().listSystems() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /** 单系统详情（版本历史、兼容性、日志、下载信息） */
  ipcMain.handle('system:detail', async (_e, systemId) => {
    try {
      const d = await getSystemManager().getSystemDetail(String(systemId || ''));
      return d ? { ok: true, detail: d } : { ok: false, error: '未知系统' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 强制刷新远程目录 */
  ipcMain.handle('system:catalogRefresh', async () => {
    try {
      const mgr = getSystemManager();
      const r = await mgr.catalog.load({ force: true });
      return { ok: true, source: r.source, stale: r.stale, error: r.error || '', updatedAt: r.catalog.updatedAt };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 触发下载+安装流水线，立即返回 taskId */
  ipcMain.handle('system:install', async (_e, systemId) => {
    try { return await getSystemManager().installSystem(String(systemId || '')); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('system:confirmInstall', async (_e, taskId) => {
    try {
      const mgr = getSystemManager();
      const task = mgr.taskManager.getTask(String(taskId || ''));
      if (!task || task.status !== 'awaiting_confirmation') return { ok: false, error: '此任务不在等待安装确认状态' };
      const { response } = await dialog.showMessageBox(mainWindow || undefined, {
        type: 'question', title: '确认系统安装完成',
        message: '已在虚拟机里完成官方安装器，并正常关闭虚拟机了吗？',
        detail: '磁盘开始写入不代表安装完成。仅在安装器明确提示成功并关机后确认；未完成请取消并返回虚拟机继续。',
        buttons: ['尚未完成', '安装完成并已关机'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return { ok: false, cancelled: true };
      return await mgr.confirmInstallation(task.taskId, { confirmed: true });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 统一切换系统（真实停旧启新 + Android 就绪检查） */
  ipcMain.handle('system:switch', async (_e, payload) => {
    try {
      const p = payload || {};
      return await getSystemManager().switchTo(String(p.systemId || ''), {
        lowspec: !!p.lowspec, timeoutMs: Number(p.timeoutMs) || 0,
      });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('system:stop', async () => {
    try { return await getSystemManager().stopCurrent(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /** 任务控制 */
  ipcMain.handle('system:pause', async (_e, taskId) => {
    try { return getSystemManager().taskManager.pause(String(taskId || '')); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:resume', async (_e, taskId) => {
    try {
      const mgr = getSystemManager();
      const t = mgr.taskManager.getTask(String(taskId || ''));
      if (!t) return { ok: false, error: '任务不存在' };
      if (t.status !== 'paused') return { ok: false, error: '仅暂停的任务可继续' };
      // 继续 = 以同一 Provider/目标重新执行流水线（断点由 downloadMulti 保留）
      const p = mgr.getProvider(t.systemId);
      const r = mgr.taskManager.retry(t.taskId);
      if (!r.ok) return r;
      const info = await p.getDownloadInfo().catch(() => null);
      mgr.taskManager.runPipeline({
        task: t, provider: p, version: t.systemVersion || (info && info.version),
        doctor: mgr.doctor,
        diskRequiredMB: info ? Math.round(info.fileSize / 1048576) + 2048 : 0,
        skipStart: true,
      }).catch(() => {});
      return { ok: true, taskId: t.taskId };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:cancel', async (_e, taskId) => {
    try { return getSystemManager().taskManager.cancel(String(taskId || '')); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:retry', async (_e, taskId) => {
    try {
      const mgr = getSystemManager();
      const p = mgr.taskManager.getTask(String(taskId || ''));
      if (!p) return { ok: false, error: '任务不存在' };
      const r = mgr.taskManager.retry(p.taskId);
      if (!r.ok) return r;
      const provider = mgr.getProvider(p.systemId);
      const info = await provider.getDownloadInfo().catch(() => null);
      mgr.taskManager.runPipeline({
        task: p, provider, version: p.systemVersion || (info && info.version),
        doctor: mgr.doctor,
        diskRequiredMB: info ? Math.round(info.fileSize / 1048576) + 2048 : 0,
        skipStart: true,
      }).catch(() => {});
      return { ok: true, taskId: p.taskId };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('system:tasks', async () => {
    try { return { ok: true, tasks: getSystemManager().taskManager.listTasks(50) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:status', async () => {
    try { return { ok: true, ...await getSystemManager().getStatus() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /** 打开某系统的下载/数据目录 */
  ipcMain.handle('system:openDir', async (_e, payload) => {
    try {
      const p = payload || {};
      const mgr = getSystemManager();
      const provider = mgr.getProvider(String(p.systemId || ''));
      if (!provider) return { ok: false, error: '未知系统' };
      const which = p.which === 'downloads' ? provider.dir('downloads')
        : p.which === 'data' ? provider.dataDir : provider.dataDir;
      await shell.openPath(which);
      return { ok: true, path: which };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 备份/恢复/删除 */
  ipcMain.handle('system:backup', async (_e, payload) => {
    try {
      const p = payload || {};
      const r = await dialog.showSaveDialog(mainWindow, {
        title: '备份系统数据', defaultPath: `apkstart-${p.systemId}-backup.qcow2`,
      });
      if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
      return await getSystemManager().backup(String(p.systemId || ''), path.dirname(r.filePath));
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:restore', async (_e, payload) => {
    try {
      const p = payload || {};
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择备份所在目录', properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true };
      return await getSystemManager().restore(String(p.systemId || ''), r.filePaths[0]);
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('system:remove', async (_e, systemId) => {
    try { return await getSystemManager().removeSystem(String(systemId || '')); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /** 导入 LineageOS 自建 AVD 镜像目录 */
  ipcMain.handle('system:importLineage', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择 LineageOS AVD 系统镜像目录', properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true };
      const p = getSystemManager().getProvider('lineageos');
      return await p.importFrom(r.filePaths[0], { copy: true });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 各系统占用空间 */
  ipcMain.handle('system:diskUsage', async () => {
    try { return { ok: true, rows: await getSystemManager().diskUsage() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /**
   * 修改本机共享目录：把旧目录里已有的文件一次性迁到新目录（best-effort，不删旧文件），
   * 再保存设置。Sharer 每次同步都动态读 store.getSettings().sharedDir，无需重启即可生效。
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: '目录不能为空' };
    if (sharer && sharer.status().busy) return { ok: false, error: '共享同步正在进行，请完成后再迁移目录' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 显示模式 / 快捷方式 / 一键部署 ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = windowBox();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // 全屏 = 平板横屏排版（见 toggleDisplayMode 的说明）
      appWin.setLandscape(full, { fullscreen: full }).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({
    ok: platform.canIntegrateShell,
    fixed: await ensureShortcuts(),
    unsupported: platform.canIntegrateShell ? undefined : platform.supportNote(),
  }));
  ipcMain.handle('runtime:autoDeploy', () => autoDeploy({ force: true }));
  // 关闭「深度裁剪」时把被 pm disable-user 的系统包恢复回来
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // 鼠标键位改变：只同步配置，不再无条件卸载（右键返回/滚轮可能仍需要钩子）
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // 兼容旧界面：语义已改为「按设置重新同步」
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  /* ---------------- 安卓客机：语言与预装应用（core/guest.js） ---------------- */

  /** 设置页需要的事实：目标语言、是否已验证、分组清单、设备上的实时状态 */
  ipcMain.handle('guest:state', async () => {
    const s = store.getSettings();
    const desired = String((s.guest && s.guest.locale) || '');
    const base = {
      desired,
      verified: !!(s.guest && s.guest.localeVerified),
      groups: guest.GROUPS.map((g) => ({
        id: g.id, label: g.label, note: g.note, risk: g.risk,
        defaultOn: !!g.defaultOn, total: g.packages.length, remaining: g.packages.length,
      })),
      online: false,
      live: null,
    };
    if (!runtime) return base;
    const online = await runtime.client().isOnline().catch(() => false);
    if (!online) return base;
    const live = await guest.readState(runtime.client()).catch((e) => ({ error: e.message }));
    return { ...base, online: true, live };
  });

  /** 精简：把勾选分组里的预装应用从当前用户移除（可逆，不动系统分区） */
  ipcMain.handle('guest:trim', async (_e, opts = {}) => {
    const groups = Array.isArray(opts && opts.groups) ? opts.groups.map(String) : [];
    if (!runtime || !(await runtime.client().isOnline().catch(() => false))) {
      return { ok: false, error: '安卓还没启动，先打开一个应用让运行时起来再精简' };
    }
    const r = await guest.trim(runtime.client(), groups);
    store.saveSettings({ guest: { groups } });
    return { ok: true, ...r };
  });

  /** 恢复：把移除过的预装应用装回来 */
  ipcMain.handle('guest:restore', async () => {
    if (!runtime || !(await runtime.client().isOnline().catch(() => false))) {
      return { ok: false, error: '安卓还没启动，先打开一个应用让运行时起来再恢复' };
    }
    return { ok: true, ...(await guest.restore(runtime.client())) };
  });

  /**
   * 切换安卓系统语言。
   * 实测结论（Play 镜像 ro.debuggable=0，不许 root）：
   *   - adb root / setprop persist.sys.locale 都不行；
   *   - 模拟器 -prop 只支持 qemu.* 属性，传 locale 会被丢弃；
   *   - 唯一可用的：`settings put system system_locales zh-CN`（shell 可写）
   *     然后**重启安卓**——这个值只在开机时被读取。
   * 重启走 `adb shell reboot`：安卓自己重启，模拟器进程不动，快照也不受影响，
   * 比关掉整个运行时再冷启动快得多（实测 30 秒内回到桌面）。
   */
  ipcMain.handle('guest:localize', async (_e, opts = {}) => {
    const locale = String((opts && opts.locale) || guest.LOCALE_TAG);
    store.saveSettings({ guest: { locale, localeVerified: false } });
    if (!runtime || !(await runtime.client().isOnline().catch(() => false))) {
      return { ok: false, error: '安卓还没启动，先打开一个应用让运行时起来，再切换语言' };
    }
    const client = runtime.client();
    const applied = await guest.applyLocale(client, locale);
    if (!applied.ok) return { ok: false, error: applied.error, applied };
    send('runtime:log', `系统语言已写入（${locale}），正在重启安卓…`);
    await client.shell('reboot', { timeout: 6000 }).catch(() => {});
    // 先等 adb 真的掉线（reboot 指令下发到内核接手有 1~3 秒延迟）
    let wentOffline = false;
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 800));
      // eslint-disable-next-line no-await-in-loop
      if (!(await client.isOnline().catch(() => false))) { wentOffline = true; break; }
    }
    const ready = await runtime.waitAndroidReady(client, 240000, (m) => send('runtime:log', m));
    // 重启后系统会重新读一遍 system_locales；这里读回真实界面语言，别只看设置值
    const probe = await guest.probeLocale(client, locale).catch(() => null);
    const active = !!(probe && probe.active);
    store.saveSettings({ guest: { localeVerified: active } });
    return {
      ok: true, locale, applied, wentOffline, ready, active, probe,
    };
  });

  /** 兜底入口：直接在安卓里打开语言设置（-prop 万一不生效时手动选一次） */
  ipcMain.handle('guest:openLocaleSettings', async () => {
    if (!runtime || !(await runtime.client().isOnline().catch(() => false))) {
      return { ok: false, error: '安卓还没启动，先打开一个应用' };
    }
    await runtime.client().shell('am start -a android.settings.LOCALE_SETTINGS', { timeout: 15000 });
    return { ok: true };
  });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  /**
   * 回到安卓桌面并展开「所有应用」抽屉。
   * Play 镜像的 Pixel 桌面只把应用放在上滑抽屉里，用户按 Home 看到的是 Google
   * 自带的几个图标，很容易以为「ApkStart 装的应用不见了」。
   */
  ipcMain.handle('runtime:androidHome', async () => {
    try {
      const c = runtime.client();
      if (!(await c.isOnline().catch(() => false))) {
        return { ok: false, error: '安卓还没启动，先打开一个应用再试' };
      }
      await c.androidHome();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  /**
   * 启动运行时。
   * opts.lowspec / opts.timeoutMs 只由「一键修复」传入，且只对本次启动生效 ——
   * 用户点一次修复，不该被永久改掉画质与性能配置。
   * 失败时把诊断结论、每轮尝试、退出码、报告路径一并交回渲染层，
   * 以前这里只回一句 error，UI 只能显示一大段文字，没法给出「点哪个按钮」。
   */
  ipcMain.handle('runtime:start', async (_e, opts = {}) => {
    const r = await runtime.ensure({
      onLog: (m) => send('runtime:log', m),
      lowspec: !!(opts && opts.lowspec),
      timeoutMs: Number(opts && opts.timeoutMs) || 0,
    });
    if (r.ok) return { ok: true, engine: r.engine, lowspec: !!(opts && opts.lowspec) };
    const out = {
      ok: false,
      error: r.error,
      needsSetup: r.needsSetup,
      diagnosis: r.diagnosis || null,
      attempts: r.attempts || [],
      exitCode: r.exitCode == null ? null : r.exitCode,
      report: r.report || '',
    };
    // 人话版结论：toast / 报错框只显示这一句；诊断码、退出码仍留在 diagnosis 里给报告用。
    // 用户不需要知道 ACCEL_UNUSABLE 是什么，只需要知道「哪坏了、程序做了什么、下一步点哪」。
    try {
      const plan = await buildRepairPlan();
      if (plan) {
        out.message = plan.headline || '';
        out.nextStep = (plan.actions && plan.actions[0] && plan.actions[0].label) || '';
        out.autoTried = plan.autoTried || [];
      }
    } catch (_) { /* 文案算不出来不影响诊断本身 */ }
    // 失败即自动落一份脱敏报告：用户不用再翻 %APPDATA% 找文件，
    // 作者也能在用户点「上报」时拿到完整上下文。重复签名 24 小时内不重复写。
    try {
      const rep = await prepareFailureReport({ automatic: true });
      if (rep) {
        out.reportDraft = {
          file: rep.draft,
          sent: !!rep.sent,
          skipped: rep.skipped || '',
          sendError: rep.sendError || '',
        };
      }
    } catch (_) { /* 生成失败不影响开机错误本身 */ }
    return out;
  });

  // ---------------- 一键修复 ----------------

  /** 修复窗口要的事实表：机器、加速、镜像、磁盘、上次退出码 */
  async function repairFacts() {
    const doctor = require('./core/doctor');
    const host = doctor.hostInfo();
    const p = runtime.provisioner.paths();
    const env = await runtime.provisioner.checkEnv().catch(() => ({}));
    let image = null;
    try { image = runtime.emulator.imageChoice(); } catch (_) { image = null; }
    // 自定义镜像的「来源 / 不可用原因」：修复窗口要能直接回答「是不是我换的镜像害的」
    let act = null;
    try { act = runtime.provisioner.activeImage(); } catch (_) { act = null; }
    // BIOS 厂商只在「要判断这是不是云电脑」时读一次：它比 CPU 型号更能识破被遮蔽的虚拟机
    const vendor = doctor.systemVendor();
    // 实跑参数（低配机器上会被自动降级）：修复窗口的体检表里要显示它，
    // 否则用户只会看到「起不来」，不知道自己被降到了 540×960 / 2 核。
    // 进程重启过时内存里已经没有 profile，退回上次落盘的记录 —— 结论要和当时一致。
    const profile = runtime.emulator.profile;
    const lf = runtime.emulator.lastFailure ? runtime.emulator.lastFailure() : null;
    return repair.buildFacts({
      ...host,
      vendor,
      vm: host.vm || doctor.looksVirtual(vendor),
      osRelease: os.release(),
      accel: (env && env.accel) || { ok: false },
      emulatorVersion: env && env.emulator && env.emulator.version,
      image: image && {
        api: image.api,
        tag: image.tag,
        compat: image.compat,
        custom: !!image.custom,
        name: image.name || (act && act.name) || '',
        source: image.custom ? imageManifest.describeSource((act && act.source) || image.source || {}) : '',
        reason: act && act.custom && !act.ok ? act.reason : '',
      },
      freeDiskMB: doctor.freeDiskMB(p.avdHome),
      exitCode: runtime.emulator.lastExitCode,
      runtimeDir: p.root,
      appVersion: app.getVersion(),
      profileText: profile ? doctor.describeProfile(profile) : String((lf && lf.profileText) || ''),
      tuned: profile ? !!profile.tuned : !!(lf && lf.tuned),
    });
  }

  /** 上次失败记录：内存里的优先，进程重启过就翻 last-failure.json */
  function lastDiagnosis() {
    if (runtime.emulator.lastDiagnosis) return runtime.emulator.lastDiagnosis;
    const lf = runtime.emulator.lastFailure ? runtime.emulator.lastFailure() : null;
    return (lf && lf.diagnosis) || null;
  }

  async function buildRepairPlan() {
    const lf = runtime.emulator.lastFailure ? runtime.emulator.lastFailure() : null;
    const attempts = (runtime.emulator.attempts && runtime.emulator.attempts.length
      ? runtime.emulator.attempts
      : ((lf && lf.attempts) || [])) || [];
    const plan = repair.buildPlan({ diagnosis: lastDiagnosis(), facts: await repairFacts(), attempts });
    // 「程序已经自己修过什么」必须如实摊在修复窗口里：
    // 否则用户看到的是「又失败了」，而实际上锁已经清过、渲染也换过了，重复点等于白等。
    plan.autoTried = (runtime.autoRepairLog || []).slice(-6);
    return plan;
  }

  /** 给用户看的一句话（不带诊断码、不带退出码）；算不出来就返回空串，调用方退回原文 */
  function plainFailureText() {
    try {
      const d = lastDiagnosis();
      if (!d) return '';
      return repair.explainFailure({ diagnosis: d }).text || '';
    } catch (_) {
      return '';
    }
  }

  /**
   * 执行一条修复动作。原则：能自动做的直接做，会动数据的必须弹原生确认框，
   * 只能人工处理的如实返回「需要在设置里改」，不假装修好了。
   * @param {string} id 动作 id
   * @param {{auto?:boolean}} opts auto=true 表示这是开机失败后的自动修复路径：
   *   绝不允许弹确认框、绝不允许动用户数据（弹窗会把「自动」变成「卡住等你点」）。
   */
  async function runRepairAction(id, { auto = false } = {}) {
    // 自动路径不替用户做「会丢东西」的决定：这些动作只能在修复窗口里点了才做
    if (auto && ['wipe-data', 'reinstall-image', 'cleanup-disk'].includes(id)) {
      return { ok: false, detail: '这一步会动数据，需要你自己确认后才能做' };
    }
    switch (id) {
      case 'cleanup-safe': {
        // 下载共用 _tmp，后缀无法区分残留与在途内容；仅使用运行时的受管候选清单。
        const r = await runtime.cleanup({ apply: true, aggressive: false, includeSnapshots: false });
        if (!r.ok) return { ok: false, detail: r.error || '未能安全清理缓存' };
        const count = r.removed?.length || 0;
        return count ? { ok: true, detail: `清掉 ${count} 个缓存项，释放约 ${Math.round((r.saved || 0) / 1048576)} MB` }
          : { ok: false, detail: '没有可安全清理的缓存；下载断点和应用数据已保留' };
      }
      case 'clear-locks': {
        const r = await runtime.clearStaleLocks();
        if (!r.ok) return { ok: false, detail: r.error || '无法确认锁文件已失效' };
        const count = r.removed?.length || 0;
        return { ok: true, detail: count ? `清掉 ${count} 个残留锁文件` : '没有发现残留锁文件' };
      }
      case 'gpu-software': {
        store.saveSettings({ engine: { gpuMode: 'swiftshader' } });
        return { ok: true, detail: '渲染后端已切换为 swiftshader（软件渲染）' };
      }
      case 'accel': {
        const r = await enableVirtualizationImpl();
        return {
          ok: !!r.ok,
          detail: r.ok
            ? (r.restartNeeded ? '已开启，需重启电脑后生效' : (r.note || '硬件加速已可用'))
            : (r.error || r.note || '这台机器无法开启硬件加速'),
        };
      }
      case 'vc-redist': {
        const r = await installVcRedistImpl();
        return { ok: !!r.ok, detail: r.ok ? 'VC++ 运行库已安装' : '安装未完成（可能取消了管理员授权）' };
      }
      case 'cleanup-disk': {
        const pass = { apply: false, aggressive: false, includeSnapshots: false };
        const preview = await runtime.cleanup(pass).catch(() => null);
        if (!preview || !preview.candidates || !preview.candidates.length) {
          return { ok: false, detail: '没有可回收的缓存了，请把数据目录换到空间更大的盘' };
        }
        const size = preview.candidates.reduce((n, c) => n + (c.size || 0), 0);
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['取消', '清理'],
          defaultId: 0,
          cancelId: 0,
          title: '清理运行时缓存',
          message: `将释放约 ${(size / 1048576).toFixed(0)} MB`,
          detail: '只删旧镜像、旧快照、锁文件与非活动 AVD 的缓存，已安装的应用会保留。此操作不可撤销。',
        });
        if (response !== 1) return { ok: false, cancelled: true, detail: '已取消清理' };
        const r = await runtime.cleanup({ apply: true, aggressive: false, includeSnapshots: false });
        return { ok: true, detail: `释放约 ${Math.round(((r && r.saved) || 0) / 1048576)} MB` };
      }
      case 'wipe-data': {
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['取消', '重建'],
          defaultId: 0,
          cancelId: 0,
          title: '用干净数据重建',
          message: '会清空安卓里的用户数据（已装应用、登录状态、存档）',
          detail: '应用清单会保留，点开时会自动重装。此操作不可撤销，建议先导出诊断报告。',
        });
        if (response !== 1) return { ok: false, cancelled: true, detail: '已取消' };
        const r = await runtime.resetAndroidData();
        return {
          ok: !!r.ok,
          detail: r.ok ? `已重建，回收 ${Math.round(((r.reclaimed || 0)) / 1048576)} MB` : (r.error || '重建失败'),
        };
      }
      case 'reinstall-image': {
        const r = await runtime.provisioner.installPlayImage(
          (x) => send('provision:progress', { ...x, component: 'play' }),
        );
        runtime.provisioner.invalidateEnvCache();
        return { ok: !!(r && r.ok !== false), detail: '系统镜像已重新下载' };
      }
      case 'redeploy': {
        const r = await autoDeploy({ force: false }).catch((e) => ({ ok: false, error: e.message }));
        const err = String((r && r.error) || '');
        // autoDeploy 的 'skipped' / 'wizard' 是「这次没做」，不是「做了但失败」：
        // 原样透出去会变成「自动修复未生效：skipped」，用户完全看不懂。
        const detail = err === 'wizard' ? '安装向导正开着，关掉后才能补齐文件'
          : (err === 'skipped' ? '自动部署已在设置里关闭，这次不补齐文件'
            : (err || '运行时组件已校验补齐'));
        return { ok: !!(r && r.ok), detail };
      }
      case 'low-spec':
        return { ok: true, detail: '低配参数已就绪，马上重新开机' };
      default:
        return { ok: false, detail: '这个动作需要在设置里手动处理' };
    }
  }

  // ---------------- 失败报告 ----------------

  const REPORTS_DIR = path.join(store.DATA_DIR, 'logs', 'reports');
  const deliveryReceipt = path.join(REPORTS_DIR, '.delivery.json');
  const reportDelivery = createReportDelivery({
    post: postJson,
    loadReceipts: () => JSON.parse(fs.readFileSync(deliveryReceipt, 'utf8')),
    // 回执写失败必须让投递层知道（它会因此取消自动上报），不能吞掉。
    saveReceipts: (receipts) => writeJsonAtomicSync(deliveryReceipt, receipts),
    confirm: async ({ endpoint, payload, previousDelivery }) => {
      const warning = previousDelivery === 'uncertain'
        ? i18n.t('上一次自动上报可能已被接收，再次发送可能产生重复报告。')
        : (previousDelivery === 'sent' ? i18n.t('这份摘要已自动上报，再次发送可能产生重复报告。') : '');
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: i18n.t('发送诊断摘要'),
        message: i18n.t('是否将诊断摘要发送到此收集接口？'),
        detail: `${feedback.redact(endpoint)}\n\n${warning ? `${warning}\n\n` : ''}${JSON.stringify(payload, null, 2)}\n\n${i18n.t('完整报告只保存在本机，不会随摘要上传。')}`,
        buttons: [i18n.t('取消'), i18n.t('发送摘要')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response === 1;
    },
  });

  /** 收集接口：用户设置优先，其次发行版内置（package.json → feedback.endpoint） */
  function resolveReportEndpoint() {
    const s = store.getSettings();
    return String((s.report && s.report.endpoint) || feedback.contact().endpoint || '').trim();
  }

  /** 组装当前失败的报告包：内存里的诊断优先，进程重启过就翻 last-failure.json */
  async function buildFailureBundle() {
    const lf = runtime.emulator.lastFailure ? runtime.emulator.lastFailure() : null;
    const attempts = (runtime.emulator.attempts && runtime.emulator.attempts.length
      ? runtime.emulator.attempts
      : ((lf && lf.attempts) || [])) || [];
    let logLines = [];
    try { logLines = runtime.emulator.recentLog(160) || []; } catch (_) { /* 没有日志也能出摘要 */ }
    return feedback.buildBundle({
      facts: { ...await repairFacts(), platform: process.platform },
      diagnosis: lastDiagnosis() || (lf && lf.diagnosis) || null,
      attempts,
      exitCode: runtime.emulator.lastExitCode != null ? runtime.emulator.lastExitCode : (lf && lf.exitCode),
      logLines,
      reportFile: (lf && lf.report) || '',
      extra: { appVersion: app.getVersion() },
    });
  }

  /** 落盘：摘要 .md + 复制一份完整诊断 .txt（都在 logs/reports 下） */
  function saveFailureDraft(bundle, receipt) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const md = path.join(REPORTS_DIR, `${bundle.id}.md`);
    fs.writeFileSync(md, bundle.summary, 'utf8');
    let txt = '';
    try {
      if (bundle.reportFile && fs.existsSync(bundle.reportFile)) {
        txt = path.join(REPORTS_DIR, `${bundle.id}.txt`);
        fs.copyFileSync(bundle.reportFile, txt);
      }
    } catch (_) { /* 完整报告复制失败不影响摘要 */ }
    try {
      if (receipt) fs.writeFileSync(receipt, JSON.stringify({ at: bundle.at, signature: bundle.signature, file: md }), 'utf8');
    } catch (_) { /* ignore */ }
    return { md, txt };
  }

  /** 同一签名 24 小时内只自动生成一次，避免反复失败把磁盘刷满、把用户烦到 */
  function recentFailureDraft(receipt, signature) {
    try {
      const last = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (last && last.signature === signature && Date.now() - new Date(last.at).getTime() < 24 * 3600e3) return last.file;
    } catch (_) { /* 没有历史记录 */ }
    return '';
  }

  async function prepareFailureReport({ force = false, automatic = false } = {}) {
    if (!force && !store.getSettings().report?.auto) return null;
    const bundle = await buildFailureBundle();
    // 草稿去重与投递去重分开：先前未授权的失败不能阻止后来明确授权的发送。
    const receipt = force ? '' : path.join(REPORTS_DIR, `.draft-${bundle.signature}.json`);
    const recent = receipt ? recentFailureDraft(receipt, bundle.signature) : '';
    const saved = recent ? { md: recent, txt: '' } : saveFailureDraft(bundle, receipt);
    // 只有真实失败事件能进入自动发送；预览、导出和手动提交的准备阶段均只落本机。
    let sent = false;
    let sendError = '';
    let skipped = '';
    const endpoint = resolveReportEndpoint();
    if (automatic) {
      const r = await reportDelivery.send({ bundle, endpoint, automatic: true, settings: store.getSettings().report || {} });
      sent = !!r.ok;
      skipped = r.skipped || '';
      // 回执读写失败要让用户看见原因，其它跳过状态（recent/uncertain）由界面按状态说明。
      sendError = sent || (r.skipped && r.skipped !== 'receipt-error')
        ? '' : (r.error || `HTTP ${r.status || '?'}`);
    }
    return { bundle, draft: saved.md, full: saved.txt, sent, sendError, skipped };
  }

  /** 直传收集接口（配置了 report.endpoint 才会走） */
  function postJson(url, body, timeout = 12000) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(url); } catch (_) { resolve({ ok: false, error: '上报地址不合法' }); return; }
      if (!/^https?:$/.test(u.protocol)) { resolve({ ok: false, error: '上报地址只支持 http(s)' }); return; }
      const mod = u.protocol === 'http:' ? require('http') : require('https');
      const data = Buffer.from(JSON.stringify(body));
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          'user-agent': 'ApkStart-Report/1',
        },
        timeout,
      }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '上报超时' }); });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.write(data);
      req.end();
    });
  }

  ipcMain.handle('report:prepare', async () => {
    const rep = await prepareFailureReport({ force: true }).catch(() => null);
    if (!rep) return { ok: false, error: '还没有可上报的失败记录' };
    return {
      ok: true,
      id: rep.bundle.id,
      summary: rep.bundle.summary,
      issueUrl: rep.bundle.issueUrl,
      mailtoUrl: rep.bundle.mailtoUrl,
      file: rep.draft,
      full: rep.full || '',
      dir: REPORTS_DIR,
    };
  });

  /**
   * 手动上报：预览并确认后才发送；收集端失败时仍可选择 GitHub、邮件或本地报告。
   */
  ipcMain.handle('report:submit', async () => {
    const rep = await prepareFailureReport({ force: true }).catch(() => null);
    if (!rep) return { ok: false, error: '还没有可上报的失败记录' };
    const b = rep.bundle;
    const contact = b.contact || {};
    const repoUrl = contact.repo ? `https://github.com/${contact.repo}` : '';
    const endpoint = resolveReportEndpoint();
    let endpointNote = '';
    if (endpoint) {
      const r = await reportDelivery.send({ bundle: b, endpoint });
      if (r.ok) return { ok: true, channel: 'endpoint', file: rep.draft };
      if (r.cancelled) return r;
      // 结果不确定时不能说“没收到”：服务端可能已经入库，重复提交会产生重复报告。
      const reason = feedback.redact(r.error || `HTTP ${r.status || '?'}`);
      endpointNote = r.uncertain
        ? `收集接口（${feedback.redact(endpoint)}）的投递结果不确定（${reason}），可能已经被接收；`
          + '再从下面任一渠道提交，作者可能收到重复报告。'
        : `未完成向收集接口（${feedback.redact(endpoint)}）发送：${reason}。可以换下面的渠道。`;
    }

    const actions = ['cancel'];
    if (b.issueUrl) actions.push('github');
    if (b.mailtoUrl) actions.push('email');
    actions.push('local');
    const labels = {
      cancel: '取消',
      github: '打开 GitHub 提交页',
      email: '用邮件发送',
      local: '先导出到本地',
    };
    // 摘要已由 report.js 脱敏和限长，这里只做显示上限，超出部分明确告知去哪看。
    const preview = b.summary.slice(0, 2400);
    const hidden = b.summary.length - preview.length;
    const lines = [];
    if (endpointNote) lines.push(endpointNote, '');
    lines.push(
      '目的地：',
      `• 收集接口：${endpoint ? feedback.redact(endpoint) : '未配置'}`,
      `• GitHub：${repoUrl || '未配置'}`
        + `${repoUrl ? `（提交页里的说明最多 ${feedback.MAX_ISSUE_BODY} 字，超出部分不会带进网页）` : ''}`,
      `• 邮件：${contact.email || '未配置'}${contact.email ? '（邮件正文最多 3500 字）' : ''}`,
      '',
      '提交给作者的内容（用户名路径与常见凭证已替换）：',
      preview + (hidden > 0 ? `\n…（还有 ${hidden} 字没显示，完整摘要见下面这份本机报告）` : ''),
      '',
      `本机报告：${rep.draft}`,
      '',
      '注意：打开 GitHub 提交页或邮件，会把上面的摘要预填给对应网站；只有你自己点提交才会发出去。',
    );
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '上报失败报告',
      message: '把这份摘要交给作者',
      detail: lines.join('\n'),
      buttons: actions.map((action) => labels[action]),
      defaultId: actions.length > 1 ? 1 : 0,
      cancelId: 0,
      noLink: true,
    });
    const chosen = actions[response] || 'cancel';
    if (chosen === 'cancel') return { ok: false, cancelled: true };
    if (chosen === 'local') {
      shell.showItemInFolder(rep.draft);
      return { ok: true, channel: 'local', file: rep.draft };
    }
    // 打开网页前把摘要放进剪贴板：浏览器没带上预填内容时还能直接粘贴
    try { clipboard.writeText(b.summary); } catch (_) { /* ignore */ }
    await shell.openExternal(chosen === 'github' ? b.issueUrl : b.mailtoUrl);
    return { ok: true, channel: chosen, file: rep.draft, copied: true, endpointNote };
  });

  ipcMain.handle('report:folder', async () => {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    await shell.openPath(REPORTS_DIR);
    return { ok: true, dir: REPORTS_DIR };
  });

  ipcMain.handle('runtime:repairPlan', async () => {
    const plan = await buildRepairPlan();
    // 弹窗打开时顺手把报告备好（同签名 24h 只写一次），用户点「上报」不用再等
    try {
      const rep = await prepareFailureReport();
      if (rep && rep.draft) plan.reportDraft = { file: rep.draft, skipped: rep.skipped || '' };
    } catch (_) { /* 报告生成失败不影响修复方案 */ }
    return plan;
  });

  /**
   * 一键修复：默认只跑「自动」动作（不动用户数据），全部做完后由渲染层带着
   * 低配参数 + 更长超时重新开机。指定 action 时只跑那一条。
   */
  ipcMain.handle('runtime:repairRun', async (_e, opts = {}) => {
    const plan = await buildRepairPlan();
    const only = opts && opts.action && opts.action !== 'auto' ? opts.action : '';
    const wanted = only
      ? plan.actions.filter((a) => a.id === only)
      : plan.actions.filter((a) => a.kind === 'auto');
    if (!wanted.length) return { ok: true, steps: [], retry: plan.retry, level: plan.level, empty: true };

    // 装驱动、清数据、清锁都要求模拟器先退出；只是切渲染参数则不必打断
    if (wanted.some((a) => ['accel', 'wipe-data', 'clear-locks', 'reinstall-image'].includes(a.id))) {
      if (runtime.emulator.running && runtime.emulator.running()) {
        await runtime.stop().catch(() => {});
      }
    }

    const steps = [];
    for (const a of wanted) {
      // eslint-disable-next-line no-await-in-loop
      const r = await runRepairAction(a.id).catch((e) => ({ ok: false, detail: e.message }));
      steps.push({ id: a.id, label: a.label, ok: r.ok !== false, cancelled: !!r.cancelled, detail: r.detail || '' });
      if (r.ok === false && !r.cancelled) break;
      if (r.cancelled) break;
    }
    return {
      ok: steps.every((s) => s.ok),
      steps,
      retry: plan.retry,
      level: plan.level,
      diagnosis: plan.title,
    };
  });
  ipcMain.handle('runtime:stop', async () => {
    try {
      const stopped = await runtime.stop();
      if (!stopped || runtime.vmRunning || await runtime.client().isOnline()) {
        return { ok: false, error: '运行时未确认停止；未结束无法验证归属的进程。' };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- 诊断 / 瘦身 ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // 设置页展示的是「按当前设置，下次开机会用的参数」：用户刚改完内存/画质就该看到结果。
    // 引擎版本与加速状态走真实探测（checkEnv 有落盘缓存，status 每 6 秒也在用它，代价极小），
    // 否则 37.x 机器上会显示已弃用的 swiftshader_indirect，和实跑对不上。
    const env = await runtime.provisioner.checkEnv().catch(() => null);
    // 探测失败时用「上次开机的加速状态」兜底，别把有加速的机器显示成软件模拟
    const accel = (env && env.accel)
      || (runtime.emulator.profile ? { ok: runtime.emulator.profile.accelOk } : undefined);
    const p = doctor.autoProfile({
      settings: store.getSettings(),
      accel,
      emulatorVersion: (env && env.emulator && env.emulator.version) || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // 运行时正在用另一组参数（改完设置还没重开）时说明一句，避免「改了没反应」的错觉
    const running = runtime.emulator.profile;
    const sig = (x) => (x ? `${x.memoryMB}|${x.cores}|${x.lcd && x.lcd.w}x${x.lcd && x.lcd.h}|${x.gpu}|${x.snapshot !== false}` : '');
    const pending = !!running && sig(running) !== sig(p);
    return {
      profile: p,
      text: doctor.describeProfile(p),
      // 低配降级的原因 / 哪些项是用户手动钉住的：设置页要能解释「为什么变保守了」
      why: [doctor.describeTuning(p), pending ? '当前运行的安卓仍在使用上次的参数，改完重开应用即生效。' : '']
        .filter(Boolean).join(' '),
      manual: doctor.describeManual(p),
      tier: p.tier || '',
      tuned: !!p.tuned,
      running: running ? doctor.describeProfile(running) : '',
    };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * 系统问题自动校验：启动前/运行中自动检查常见导致「装不上、起不来」的根因，
   * 并给出可操作的修复建议（在首页横幅 + 设置面板里展示，按问题一键修复）。
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // 这两个值在 try 内赋值、在 try 外返回，必须在作用域外声明
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: '缺少 VC++ 运行库（x64）',
          hint: '安卓运行时依赖微软 VC++ 2015-2022，缺失会导致模拟器无法启动（0xc0000135）。', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        issues.push({
          code: 'accel', severity: 'warn', title: '未启用硬件加速',
          hint: (accel.note || '将回退软件模拟（能跑但很慢）。开启虚拟化后可获得最佳性能。'), fix: 'virtualization',
        });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: '运行时磁盘空间紧张',
          hint: `「${runtime.provisioner.paths().root}」所在盘仅剩 ${free} MB，运行时与镜像可能撑爆硬盘。`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: '运行时目录含中文/特殊字符',
          hint: '部分运行时组件对中文路径敏感，可能引发启动失败。建议改到纯英文目录。', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'adb 工具链缺失', hint: '无法连接安卓运行时。', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: '运行时引擎未安装', hint: '需要先部署运行时引擎（约 440MB）。', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: '系统镜像未就绪', hint: '需要先下载 Android 系统镜像（约 1.5GB）。', fix: 'deploy' });
      }
      // 残留锁文件：会让下一次启动被判定为「AVD 已被占用」而 FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: '检测到上次残留的锁文件', hint: '可能导致下一次启动被判定为「AVD 已被占用」。', fix: 'lock' });
      }
    } catch (_) { /* 自检失败不阻断使用 */ }
    return { issues, accel, free };
  });

  // 微软 VC++ 2015-2022 x64 运行库：安卓模拟器（Qt6）与 qemu 都依赖它。
  // 缺了在「其他电脑」上会直接起不来（0xc0000135 / MSVCP140 缺失）。
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  async function installVcRedistImpl() {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // 用 RunAs 提权安装（VC++ 是系统级组件，需要管理员）；/quiet 静默 /norestart 不重启。
      // 路径作为环境变量传给 PowerShell，避免路径中的 `$()` / 反引号被解释。
      const launch = buildVcRedistLaunch(file);
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', launch.command], {
        windowsHide: true, stdio: 'ignore', env: launch.env,
      });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  }
  ipcMain.handle('runtime:installVcRedist', () => installVcRedistImpl());

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // 通用确认框（渲染层统一走这里，避免各处自己拼 dialog 文案）
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || '确认',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: [opts.cancelLabel || '取消', opts.okLabel || '确定'],
      // danger：默认焦点落在「取消」上，避免用户连按回车就装了个明知有问题的东西
      defaultId: opts.danger ? 0 : 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  // 数据分区（/data）容量：应用、游戏与它们的更新包都装在这里。
  // 「游戏更新提示空间不足」几乎都是这一项太小，扩容是就地做的，不丢数据。
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const info = runtime.emulator.dataInfo();
    return { ...info, freeDiskMB: doctor.freeDiskMB(runtime.provisioner.paths().root) };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const want = Math.max(0, Math.min(64, Number(gb) || 0));
    try {
      if (!want) {
        store.saveSettings({ engine: { dataPartitionGB: 0 } });
        return { ok: true, auto: true, ...runtime.emulator.dataInfo() };
      }
      // 由运行时在停机维护锁内确认镜像不再被占用；失败不保存容量设置。
      const r = await runtime.resizeDataPartition(Math.round(want * 1024));
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r.ok) {
        store.saveSettings({ engine: { dataPartitionGB: want } });
        notify('数据分区已调整', `安卓可用空间约 ${want} GB${r.stoppedVm ? '（运行时已停止，下次打开应用时启动）' : ''}`);
      }
      return { ...r, stopped: !!r.stoppedVm };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // 明确两次确认：先给清单，用户确认后才真正删；且只清理 ApkStart 自己的运行时目录
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', `清理 ${preview.candidates.length} 项`],
      defaultId: 0,
      cancelId: 0,
      title: '确认清理运行时缓存',
      message: `将释放约 ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? '会先停止运行时，再删除旧镜像、当前 AVD 的快速启动快照、锁文件和非活动 AVD 的缓存。已安装的应用本身保留（只清快照），'
        : '只删除旧镜像、旧快照、锁文件和非活动 AVD 的缓存，已安装的应用会保留。')
        + '此操作不可撤销，建议先导出诊断报告。',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // 重置数据必须由主进程确认，不能信任渲染层传来的确认状态。
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '重置安卓数据',
        message: '要清空安卓应用数据并重置此运行时吗？',
        detail: '已安装的应用、应用登录状态及资料、快速启动快照都会被清除。此操作不可撤销，请先备份重要资料。',
        buttons: ['取消', '重置安卓数据'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return { ok: false, cancelled: true };
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 修复虚拟机网络：重置 /data（保留应用清单，点开应用会自动重装）。
  // 典型场景：安卓里所有联网页面一直黑屏，其实是 wlan0 没起来、没有默认路由。
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { type: 'info', message: m }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 只做网络体检，不动任何数据（设置页用来显示当前状态）
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 运行时自举 ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 旧向导入口继续走 Windows 功能/既有服务，不提权执行缓存的驱动脚本。
  ipcMain.handle('provision:enableAccel', () => enableVirtualizationImpl());

  /**
   * 自动开启/修复硬件加速：用户无需手动去「Windows 功能」面板。
   *
   * 优先启动已安装的 AEHD 服务；否则启用 Windows 自带的虚拟化组件。
   * 不自动执行 AEHD 第三方驱动安装器。BIOS 里虚拟化没开时直接说明。
   */
  async function enableVirtualizationImpl() {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      // 注意 must 同时看 suspect：驱动文件在、-accel-check 也说可用，但服务没跑时
      // 旧实现会直接返回「已可用，无需操作」—— 用户于是永远修不好（实测现场）。
      if (accel.ok && !accel.suspect) return { ok: true, already: true, accel, note: '硬件加速已可用，无需额外操作' };

      // 1) 先试最省事的：把 AEHD 服务拉起来（不重启、当场生效）
      let aehdErr = '';
      if (accel.ok && accel.suspect) {
        const svc = accel.aehd || await runtime.provisioner.aehdService().catch(() => null);
        if (svc && !svc.running) {
          const started = await startAehdService(svc.name);
          if (started.ok) {
            runtime.provisioner.invalidateEnvCache();
            const after = await runtime.provisioner.emulatorAccel({ force: true });
            if (after.ok && !after.suspect) {
              return { ok: true, accel: after, note: 'AEHD 驱动服务已启动，硬件加速当场生效' };
            }
            // 服务起来了但仍报可疑：多半是驱动版本太旧 / 与 Hyper-V 冲突，继续走 WHPX
            aehdErr = '驱动服务已启动，但模拟器仍未报告可用';
          } else {
            aehdErr = started.error || '驱动服务未能启动';
          }
        }
      }

      const firmware = await virtualizationFirmwareEnabled();
      // BIOS 里的虚拟化没开时，开 WHPX / 装 AEHD 都不会生效 —— 提前说清楚。
      if (firmware === false) {
        return {
          ok: false,
          firmwareEnabled: false,
          accel,
          error: aehdErr ? `${aehdErr}；另外 BIOS 里的 CPU 虚拟化（Intel VT-x / AMD SVM）没有开启`
            : 'BIOS 里的 CPU 虚拟化（Intel VT-x / AMD SVM）没有开启',
          note: '开系统功能或装驱动都不会生效：请重启进 BIOS 打开它，回到 Windows 后再试一次。',
        };
      }

      const hv = await runtime.provisioner.hypervisor();
      if (hv.dll) {
        // 系统带 WinHvPlatform.dll：开启「虚拟机平台」功能（可能需要重启）
        const r = await enableWindowsFeature('VirtualMachinePlatform');
        const r2 = await enableWindowsFeature('HypervisorPlatform').catch(() => ({ ok: false }));
        const ok = r.ok || r2.ok;
        // 复测必须绕开缓存：`-accel-check` 与落盘缓存都还留着修复前的结论
        runtime.provisioner.invalidateEnvCache();
        const after = await runtime.provisioner.emulatorAccel({ force: true });
        return {
          ok,
          restartNeeded: r.restart || r2.restart,
          firmwareEnabled: firmware,
          accel: after,
          note: ok
            ? ((r.restart || r2.restart)
              ? '已开启「虚拟机平台」，请重启电脑后生效'
              : '「虚拟机平台」已开启，硬件加速即时生效')
            : (r.error || r2.error || aehdErr || '无法开启系统虚拟化功能'),
        };
      }

      // 尚无可信的 AEHD 包摘要及安全提权暂存链；已有脚本也不是信任凭证。
      return {
        ok: false, accel, firmwareEnabled: firmware,
        error: '未检测到可启用的 Windows 虚拟化组件；已禁用未经可信校验的 AEHD 自动驱动安装。请通过 Android Studio 官方 SDK Manager 手动安装驱动，或升级 Windows 并启用 Windows Hypervisor Platform。',
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  ipcMain.handle('provision:enableVirtualization', () => enableVirtualizationImpl());

  // 启动失败时的全自动修复入口：Runtime 判定 ACCEL / ACCEL_UNUSABLE 后会回调它，
  // 修好（AEHD 服务拉起来 / WHPX 已生效）就自动重试一次开机，用户不必去点「一键修复」。
  if (runtime) runtime.onAccelRepair = () => enableVirtualizationImpl();
  // 非加速类（锁文件、组件缺失、渲染崩溃、磁盘满）自动修复的动作执行器。
  // auto:true 保证这条路径里不会蹦出确认框，也不会动用户数据。
  if (runtime) runtime.onAutoRepair = (action) => runRepairAction(action, { auto: true });

  /** 设置页「硬件加速」状态：只读、带缓存，不触发任何提权或安装 */
  ipcMain.handle('provision:accelStatus', async () => {
    try { return { ok: true, accel: await runtime.provisioner.emulatorAccel() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Android-x86 / Bliss OS 系统镜像',
      filters: [{ name: '系统镜像', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importRuntimePack', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 ApkStart 运行时整包',
      filters: [{ name: '运行时整包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...await runtime.provisioner.importRuntimePack(r.filePaths[0], (p) => send('provision:progress', { ...p, component: 'runtime' })) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择已安装 Android 的虚拟磁盘',
      filters: [{ name: '虚拟磁盘', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  /* ---------------- 自定义镜像（可插拔 image adapter） ---------------- */

  /** 把一条镜像记录压成设置页需要的形状（不要 dir 之外的大字段） */
  function imageItemOut(it) {
    return {
      id: it.id,
      name: it.name,
      api: it.api,
      abi: it.abi,
      tag: it.tag,
      type: it.type,
      vendor: it.vendor,
      dir: it.dir,
      managed: it.managed,
      size: it.size,
      importedAt: it.importedAt,
      active: it.active,
      state: it.state,
      reason: it.reason,
      summary: it.summary,
      sourceText: imageManifest.describeSource(it.source || {}),
      googleServices: it.googleServices,
      armTranslation: it.armTranslation,
    };
  }

  /**
   * 当前镜像状态：默认镜像的健康度 + 已导入的自定义镜像 + 为什么不可用。
   * 设置页只读这一个通道，避免「列表说能用、实际起不来」。
   */
  ipcMain.handle('image:status', async () => {
    try {
      const p = runtime.provisioner;
      const st = p.images.status();
      const selected = p.imageProfile();
      const builtIn = p.imageProfiles().map((profile) => {
        const info = p.imageInfo(profile.id);
        return {
          id: profile.id,
          api: profile.api,
          tag: profile.tag,
          abi: profile.abi,
          label: profile.shortLabel,
          note: info.ok ? `${profile.shortLabel} · Android ${profile.api}（${(info.size / 1073741824).toFixed(2)} GB）` : (info.note || '未下载'),
          ok: !!info.ok,
          dir: info.dir,
          avd: profile.avd,
          gms: profile.gms,
          playStore: profile.playStore,
          armTranslation: profile.armTranslation,
          active: profile.id === selected.id && !st.activeId,
        };
      });
      const current = builtIn.find((x) => x.id === selected.id) || builtIn[0];
      const env = await p.checkEnv().catch(() => null);
      return {
        ok: true,
        activeId: st.activeId,
        active: st.active,
        why: st.why,
        items: st.items.map(imageItemOut),
        dir: st.dir,
        selectedFlavor: selected.id,
        builtInImages: builtIn,
        defaultImage: current,
        emulatorVersion: (env && env.emulator && env.emulator.version) || '',
        runtimeDir: p.paths().root,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 预览一个来源（不导入、不写任何东西）：设置页在确认前先看能不能用 */
  ipcMain.handle('image:inspect', async (_e, src) => {
    try {
      const env = await runtime.provisioner.checkEnv().catch(() => null);
      const report = await runtime.provisioner.images.inspectSource(String(src || ''), {
        emulatorVersion: (env && env.emulator && env.emulator.version) || '',
      });
      return {
        ok: report.ok,
        errors: report.errors,
        warnings: report.warnings,
        summary: report.summary,
        api: report.api,
        abi: report.abi,
        tag: report.tag,
        size: report.size,
        dir: report.dir,
        suggestedId: report.suggestedId,
        provider: report.provider,
      };
    } catch (e) {
      return { ok: false, errors: [e.message], warnings: [] };
    }
  });

  /**
   * 导入自定义镜像。
   * 失败时**不改变当前生效的镜像**：settings.runtime.activeImageId 只在 activate 里写，
   * 导入只往 custom-images/index.json 里加一条记录。
   */
  ipcMain.handle('image:import', async (_e, opts = {}) => {
    try {
      let src = String(opts.path || '').trim();
      if (!src) {
        // Windows 上没法用同一个对话框既选文件夹又选文件，所以先问一句
        const pick = await dialog.showMessageBox(mainWindow || undefined, {
          type: 'question',
          title: '导入自定义安卓镜像',
          message: '要导入哪种形式的镜像？',
          detail: '推荐选镜像文件夹（里面直接放着 system.img / vendor.img / kernel-ranchu / ramdisk.img，'
            + '以及可选的 apkstart-image.json 清单）。也可以选事先打好的 ZIP 包。',
          buttons: ['选择镜像文件夹', '选择 ZIP / 清单文件', '取消'],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        if (pick.response === 2) return { ok: false, canceled: true };
        const dirMode = pick.response === 0;
        const r = await dialog.showOpenDialog(mainWindow || undefined, dirMode
          ? { title: '选择镜像文件夹', properties: ['openDirectory'] }
          : {
            title: '选择镜像 ZIP 包或清单文件',
            filters: [{ name: '镜像包', extensions: ['zip', 'json'] }],
            properties: ['openFile'],
          });
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
        src = r.filePaths[0];
      }

      const p = runtime.provisioner;
      // ZIP 要先解压出来（解压后与压缩包峰值同时占盘），先挡一下磁盘
      if (/\.zip$/i.test(src)) {
        await p.guardDisk('image', p.paths().root);
      }
      const env = await p.checkEnv().catch(() => null);
      const res = await p.images.import(src, {
        emulatorVersion: (env && env.emulator && env.emulator.version) || '',
        onProgress: (x) => send('provision:progress', { ...x, component: 'image' }),
      });
      appLog(`custom image imported: ${res.record.id} (${res.record.dir})`);
      return { ok: true, item: imageItemOut(res.record), warnings: res.warnings, checksums: res.checksums };
    } catch (e) {
      // 把「为什么不行」原样交回去：设置页直接显示，不做二次包装
      return { ok: false, error: e.message, errors: e.errors || [e.message] };
    }
  });

  /**
   * 换镜像前先把正在跑的运行时停掉。
   *
   * 为什么必须停：模拟器是 detached 的独立进程，下次启动走 adoptExisting —— 那是按端口
   * 接管，不认「现在该用哪套镜像」。不停的话旧镜像那台会被原样接管：设置页显示新镜像、
   * 实际还在跑旧的，用户会以为「切换没生效」，接着反复点启用。
   * 停的时候走正常路径，快照照常保存，切回来还是秒开。
   */
  async function stopVmForImageSwitch() {
    if (!runtime) return false;
    if (!runtime.vmRunning && !(await runtime.client().isOnline())) return false;
    try {
      const stopped = await runtime.stop();
      if (!stopped || runtime.vmRunning || await runtime.client().isOnline()) throw new Error('运行时仍在运行');
      return true;
    } catch (e) {
      appLog(`stop before image switch failed: ${e && e.message}`);
      throw e;
    }
  }

  /** 启用一套已导入的镜像（启用前会重新体检；失败则保持当前镜像不变） */
  ipcMain.handle('image:activate', async (_e, id) => {
    try {
      const targetId = String(id || '');
      const current = runtime.provisioner.images.active();
      const changing = !(current && current.custom && current.id === targetId);
      const stoppedVm = changing ? await stopVmForImageSwitch() : false;
      if (changing && runtime.vmRunning) {
        return { ok: false, error: '当前安卓运行时未能停止，未切换镜像。请先关闭正在运行的应用后重试。' };
      }
      const res = runtime.provisioner.images.activate(targetId);
      appLog(`custom image activated: ${res.record.id} → AVD ${runtime.emulator.avdName}`);
      return {
        ok: true,
        item: imageItemOut(res.record),
        avd: runtime.emulator.avdName,
        // 旧镜像那台已经停了；下次开机会按新的 AVD 冷/快启动
        needsRestart: stoppedVm,
        stoppedVm,
      };
    } catch (e) {
      return { ok: false, error: e.message, reason: e.reason || '' };
    }
  });

  /** 恢复默认镜像：只清指针，默认镜像与默认 AVD 全程没被动过 */
  ipcMain.handle('image:restore', async () => {
    try {
      const current = runtime.provisioner.images.active();
      const changing = !!(current && current.custom);
      const stoppedVm = changing ? await stopVmForImageSwitch() : false;
      if (changing && runtime.vmRunning) {
        return { ok: false, error: '当前安卓运行时未能停止，未恢复默认镜像。请先关闭正在运行的应用后重试。' };
      }
      runtime.provisioner.images.restoreDefault();
      appLog('custom image restored to default (Android 14 Play x86_64)');
      return {
        ok: true, needsRestart: stoppedVm, stoppedVm, avd: runtime.emulator.avdName,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 移除一条记录（只删我们自己解出来的副本，绝不删用户的源目录） */
  ipcMain.handle('image:remove', async (_e, id) => {
    try {
      const targetId = String(id || '');
      const current = runtime.provisioner.images.active();
      const removingActive = !!(current && current.custom && current.id === targetId);
      const stoppedVm = removingActive ? await stopVmForImageSwitch() : false;
      if (removingActive && runtime.vmRunning) {
        return { ok: false, error: '当前安卓运行时未能停止，未移除正在使用的镜像。请先关闭正在运行的应用后重试。' };
      }
      const r = runtime.provisioner.images.remove(targetId);
      if (!r.ok) return r;
      // 移除的正好是当前在用的那套：remove() 已经把指针恢复成默认镜像，
      // 但旧进程还跑着已删除的镜像，必须停掉，否则下次会被接管成「幽灵镜像」。
      return {
        ok: true,
        wasActive: r.wasActive,
        keptSourceDir: r.keptSourceDir,
        stoppedVm,
        avd: runtime.emulator.avdName,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 在文件管理器里打开镜像目录（排查「文件是不是被移走了」） */
  ipcMain.handle('image:reveal', async (_e, id) => {
    try {
      const st = runtime.provisioner.images.status();
      const item = st.items.find((x) => x.id === String(id || ''));
      const dir = item ? item.dir : st.dir;
      if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在' };
      shell.openPath(dir);
      return { ok: true, dir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    try {
      if (!await runtime.markInstalled()) return { ok: false, error: '无法确认安装虚拟机已退出；请先在虚拟机内正常关机' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // 冒烟/无 shell 环境：不探测注册表（reg.exe 可能被策略拦截）
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // 优先用随包分发的多尺寸品牌 ICO，缺失时从 Logo PNG 现算
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** 清理上次残留的 AVD 锁文件：会让下次启动被误判为「AVD 已被占用」而 FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const r = await runtime.clearStaleLocks();
      return { ...r, removed: r.removed?.length || 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 一键卸载 ApkStart 本体：
   * 1) 先取消 .apk 文件关联（避免卸载后双击 APK 指向已删除的程序）
   * 2) 安装版：启动 NSIS 卸载程序（它会自行请求管理员/确认），随后退出本程序
   * 3) 便携版（旁加载 / 免安装）：没有卸载器时复制清理脚本到 TEMP，退出后自动删除程序与数据目录
   */
  ipcMain.handle('app:removeSelf', async () => {
    if (process.platform !== 'win32') {
      return { ok: false, error: '请通过系统软件管理器卸载 deb；AppImage 可退出后删除应用文件，用户数据与共享文件不会自动删除。' };
    }
    if (!app.isPackaged) return { ok: false, error: '开发模式不执行自卸载，请手动管理项目目录。' };
    try {
      const exeDir = path.dirname(process.execPath);
      // electron-builder NSIS 默认生成的是「Uninstall ApkStart.exe」，旧版只找
      // uninstaller.exe，导致安装版被误判成便携版、卸载按钮实际什么也没做（#51）。
      // 再兜一层 uninstall.exe / uninst.exe：自定义打包或第三方重打包会改这个名字，
      // 找不到就等于把安装版当便携版处理（会直接删目录，卸载向导却不出现）。
      let entries = [];
      try { entries = fs.readdirSync(exeDir); } catch (_) { entries = []; }
      const uninstallerName = entries.find((name) => /^Uninstall .*\.exe$/i.test(name))
        || entries.find((name) => /^(uninstall|uninst)[^\\/]*\.exe$/i.test(name));
      const uninstaller = uninstallerName ? path.join(exeDir, uninstallerName) : '';
      if (uninstaller) {
        // 清理由卸载向导在确认后执行。不能提前启动旁路脚本，否则取消卸载也会丢数据。
        const error = await shell.openPath(uninstaller);
        if (error) return { ok: false, error };
        return { ok: true, portable: false, awaitingConfirmation: true };
      }
      const { spawn } = require('child_process');
      const paths = runtime.provisioner.paths();
      const cleanupSource = path.join(APP_ROOT, 'build', 'uninstall-data.ps1');
      if (!fs.existsSync(cleanupSource)) throw new Error('缺少卸载清理脚本');
      const cleanupScript = path.join(os.tmpdir(), `apkstart-uninstall-${process.pid}-${Date.now()}.ps1`);
      fs.copyFileSync(cleanupSource, cleanupScript);
      const cleanupArgs = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', cleanupScript,
        '-DataDir', store.DATA_DIR,
        '-RuntimeDir', paths.root,
        '-AvdDir', paths.avdHome,
        '-TempDir', os.tmpdir(),
        '-WaitPid', String(process.pid),
        '-RemoveInstallDir', '-InstallDir', exeDir,
      ];
      try {
        await runtime.stop();
        const online = await runtime.client().isOnline();
        if (online || runtime.vmRunning) throw new Error('运行时仍在运行，请正常关闭安卓后再卸载');
      } catch (e) {
        try { fs.unlinkSync(cleanupScript); } catch (_) { /* 保留原程序与数据 */ }
        return { ok: false, error: e.message || '无法确认运行时已停止，未执行清理' };
      }
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', cleanupArgs, {
          cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      try { await assoc.unregisterAssociation(); } catch (_) { /* 不影响已启动的卸载 */ }
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: true, automatic: true, dataDir: store.DATA_DIR, exeDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => {
    // 只放行 http/https：与 setWindowOpenHandler 的策略一致。
    // file:// / ms-gww 等 scheme 一律交给 shell.openPath / 专用 IPC 处理。
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) throw new Error('只允许打开 http/https 链接');
    return shell.openExternal(u);
  });

  /** 打开 Windows「启用或关闭 Windows 功能」对话框（一键开启失败时的手动兜底） */
  ipcMain.handle('system:openWindowsFeatures', () => openWindowsFeatures());

  /** 打开本地目录（设置页「打开数据目录」等按钮用；window.open('file://') 会被 open 拦截器吞掉） */
  ipcMain.handle('shell:openPath', (_e, p) => {
    const dir = String(p || '');
    if (!path.isAbsolute(dir)) throw new Error('只允许打开绝对路径');
    if (!fs.statSync(dir).isDirectory()) throw new Error('只允许打开现存目录');
    return shell.openPath(dir);
  });

  /**
   * 本机所有盘符与剩余空间（首次运行引导用）。
   * 优先 fs.statfs（Node ≥18.15，毫秒级、无外部进程）；不可用时退回 CIM 查询。
   * recommended：剩余空间最大且 ≥8GB 的非系统盘 —— 运行时 + 安卓数据默认就该去那里，
   * 别再把 C 盘塞爆（用户反馈最集中的问题之一）。
   */
  ipcMain.handle('sys:drives', async () => {
    const drives = [];
    try {
      for (let i = 65; i <= 90; i += 1) {
        const letter = String.fromCharCode(i);
        const root = `${letter}:\\`;
        try {
          // eslint-disable-next-line no-await-in-loop
          const st = await fs.promises.statfs(root);
          const total = Number(st.blocks) * Number(st.bsize);
          const free = Number(st.bavail) * Number(st.bsize);
          if (total > 0) drives.push({ drive: `${letter}:`, root, free, total });
        } catch (_) { /* 不存在的盘符 */ }
      }
    } catch (_) { /* statfs 不可用 */ }
    if (!drives.length) {
      try {
        const { execFile } = require('child_process');
        const ps = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceName,FreeSpace,Size | ConvertTo-Json';
        const r = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
            { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout) => resolve(e ? '' : String(stdout || '')));
        });
        const j = JSON.parse(r.trim() || '[]');
        for (const d of (Array.isArray(j) ? j : [j])) {
          if (!d || !d.DeviceName) continue;
          const total = Number(d.Size) || 0;
          const free = Number(d.FreeSpace) || 0;
          if (total > 0) drives.push({ drive: d.DeviceName, root: d.DeviceName + '\\', free, total });
        }
      } catch (_) { /* 连 CIM 都拿不到就空着，向导不推荐默认盘 */ }
    }
    const systemDrive = String(process.env.SystemDrive || 'C:').toUpperCase();
    const needBytes = 8 * 1024 * 1024 * 1024;
    const sorted = [...drives].sort((a, b) => b.free - a.free);
    const nonSystem = sorted.find((d) => d.drive.toUpperCase() !== systemDrive && d.free >= needBytes);
    const recommended = (nonSystem || sorted.find((d) => d.free >= needBytes) || sorted[0] || null);
    return {
      drives,
      systemDrive,
      recommended: recommended ? recommended.drive : '',
      recommendedRoot: recommended ? recommended.root : '',
    };
  });

  /** 代理探测结果缓存重置（设置页改了 runtime.proxyUrl 后立即生效） */
  ipcMain.handle('proxy:reset', () => {
    require('./core/proxy').resetCache();
    return { ok: true };
  });

  /** 引导向导的开关：打开期间 autoDeploy 直接让路（见 autoDeploy 顶部的 wizardOpen 分支） */
  ipcMain.handle('wizard:open', () => {
    wizardOpen = true;
    if (wizardAutoDeployTimer) { clearTimeout(wizardAutoDeployTimer); wizardAutoDeployTimer = null; }
    return { ok: true };
  });
  ipcMain.handle('wizard:close', () => {
    wizardOpen = false;
    // 向导关掉但没装完时仍然等待版本化引导完成，避免用户刚跳过就被静默下载打断。
    scheduleAutoDeploy();
    return { ok: true };
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- 应用窗口（只有 旋转 / 最小化 / 最大化 / 关闭） ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  ipcMain.handle('shell:minimize', (e) => winOf(e)?.minimize());
  ipcMain.handle('shell:maximize', (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    appWin.scheduleFit();
  });
  ipcMain.handle('shell:close', (e) => {
    const w = winOf(e);
    if (!w) return;
    // 必须走 AppWindow.close() 的完整收尾（摘下并藏好模拟器窗口 + force-stop 安卓应用），
    // 直接 win.close() 会绕过收尾：应用留在后台、模拟器窗口被重新挂回桌面（上游 v0.3.7 同款问题）
    if (appWin && appWin.isOpen && appWin.win === w) appWin.close({ keepApp: false });
    else w.close();
  });
  ipcMain.handle('shell:rotate', () => appWin.rotate());
  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- 安卓系统设置（不用进安卓桌面） ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `未知设置项 ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---------------- 在线更新 ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // 用户主动点「检查更新」→ 跳过缓存，必定重新问一次两个源
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      // 后台已经把包下好了（autoUpdateJob 就绪）：把状态一起带上，
      // 否则重查一次后按钮会从「重启并安装」退回「立即更新」，看着像白下了。
      const downloaded = !!autoUpdateJob;
      return {
        ok: true,
        ...info,
        downloaded: downloaded && info.hasUpdate,
        downloadedVersion: downloaded ? autoUpdateJob.version : undefined,
      };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    const target = /^https:\/\/github\.com\//i.test(String(url || '')) ? url : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  /**
   * 手动安装：自动安装没拉起来时的兜底出口。
   *
   * 只做一件事 —— 把已经下好的安装包交给系统（弹出安装向导/UAC），用户点两下就装完。
   * 不做静默安装、不碰文件锁，因此不受「子进程被 App 退出带走」这类问题影响。
   */
  ipcMain.handle('app:updateRunPayload', async () => {
    try {
      if (process.platform !== 'win32' || updater.flavor !== 'setup') {
        return { ok: false, error: '手动安装仅适用于 Windows 安装版，请打开发布页' };
      }
      if (updateBusy) return { ok: false, error: '正在更新中' };
      updateBusy = true;
      let payload, err;
      try {
        const info = await updater.check({ force: true });
        if (!info.hasUpdate || !info.canAutoApply) throw new Error('缺少可验证的新版本');
        const job = await updater.prepare(info);
        payload = job.payload;
        err = await shell.openPath(payload);
      } finally { updateBusy = false; }
      if (err) return { ok: false, error: err };
      // 用户手里已经有安装向导了，别再反复弹「上次没装成」
      updater.clearPending();
      appLog(`update manual install: ${path.basename(payload)}`);
      return { ok: true, payload };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('app:updateCancel', () => ({ ok: !updateBusy }));

  ipcMain.handle('app:restart', () => {
    // 以前只 app.quit()：界面上写着「重启应用」，实际是直接退出，
    // 用户还得自己去开始菜单点开（首启引导的最后一步因此形同虚设）。
    // Electron 的 relaunch 必须在 quit 之前调用，且要把原有命令行参数带回去
    // （例如 --launch <pkg> / --smoke），否则重启后会丢掉待打开的应用。
    setTimeout(() => {
      quitting = true;
      try { app.relaunch({ args: process.argv.slice(1) }); } catch (_) { /* 开发模式下也允许只退出 */ }
      app.quit();
    }, 200);
    return { ok: true };
  });
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    syncTheme(store.getSettings().theme);
    nativeTheme.on('updated', refreshWindowTheme);
    runtime = new Runtime(APP_ROOT);
    // 启动即留一行痕迹：出问题时用户把 app.log 发过来就能看到版本与数据目录
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);
    // 平台能力一行进日志：跨平台反馈里第一眼就能确认「在什么系统上、支持级别是什么」
    appLog(`platform ${platform.platform} support=${platform.supportLevel()} embed=${platform.canEmbed}`);
    // 生效语言 = 设置里的 language（auto 时看系统语言）。所有 t() 从这里往后都是对的。
    i18n.setLanguage(i18n.resolve(store.getSettings().language, app.getLocale()));
    appLog(`i18n language=${i18n.getLanguage()} (pref=${store.getSettings().language}, system=${app.getLocale()})`);
    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows 搜索索引的是开始菜单里的 .lnk，只放桌面会「搜不到应用」
      startMenuDir: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // 让更新器能读到「只走 GitHub / 只走 Gitee / 自动选快」和镜像前缀设置
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // 滚轮合并器：一个时间窗内的滚动只注入一条 input swipe，走常驻 adb shell。
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // 窗口代理：只负责内嵌模拟器窗口。全局鼠标钩子只在应用窗口前台时按配置安装。
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // 旋转要改 Android 的逻辑分辨率，交给 adb 客户端做
      setOrientation: async (landscape) => {
        const win = appWin?.win;
        const client = win && windowClients.get(win);
        const shouldCancel = () => quitting || !win || appWin.win !== win || win.isDestroyed();
        if (!client || !client.serial || shouldCancel()) return false;
        return runtimeActions.run('app:rotate', () => {
          if (shouldCancel()) return false;
          deviceSize.value = null;
          return client.setOrientation(landscape, { shouldCancel });
        }, { builtin: false });
      },
      // 传 getter：设置页改了键位，下一次窗口 focus / 刷新就生效，不用重启
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
    });
    appWin.onCloseApp((pkg, win) => {
      onContainerActive(false);
      const client = windowClients.get(win);
      if (!client || !client.serial || quitting) return;
      // 立即登记关窗租约，已有操作结束后再清理；不能用届时的设置重选目标。
      runtimeActions.run('app:close', () => {
        const shouldCancel = () => quitting || !!appWin?.isOpen || runtime?.client() !== client;
        if (shouldCancel()) return;
        return runtime.endApp(pkg, { client, shouldCancel });
      }, { builtin: false, afterCurrent: true }).catch(e => appLog(`关窗清理未完成：${e.message}`));
    });
    // 应用窗口关闭：若自动更新已把新版本下载好，此刻是安全的安装时机
    appWin.onWindowClosed(() => {
      if (autoUpdateJob) setTimeout(applyAutoUpdate, 600);
    });

    // 「哪些窗口才算我们的」= 运行时目录 + 随包的 engine 目录。
    // 窗口代理只允许碰这些进程创建的窗口 —— 别的 Qt 应用（微信 4.x 就是 Qt6，
    // 窗口类名和模拟器一模一样）一个都不许动，见 agent.ps1 的 SetScope。
    const agentScope = async () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      // ensure() 可能接管上一进程留下的 detached runtime。它可能来自旧的
      // 便携版目录（例如用户刚把 runtime 从 D: 切到 E:），所以不能只相信当前
      // settings.runtime.dir；把活动 emulator/qemu 的实际目录加入作用域，避免
      // agent.ps1 误把在线但已接管的窗口过滤成 emu=0。
      try {
        const active = await runtime.activeRuntimeRoots();
        if (Array.isArray(active)) dirs.push(...active);
      } catch (_) { /* 进程探测失败不影响正常启动 */ }
      return [...new Set(dirs.filter(Boolean))];
    };
    // 范围存在代理进程的内存里，代理一重建就没了 —— 所以每次开机压制前都重发一次。
    armAgent = async (agent) => {
      if (!agent || quitting) return { ok: false };
      const dirs = await agentScope();
      if (quitting) return { ok: false };
      // 第二个参数是本进程 pid：代理据此拒绝把窗口嵌进「不是我们的」窗口
      await agent.scope(dirs, process.pid).catch(() => null);
      if (quitting) return { ok: false };
      if (!dirs.length) appLog('agent scope 为空：不压制任何窗口（避免误伤其他软件）');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // 代理进程意外退出后会重建，事件监听必须一起重新挂上（旧版会在这里丢掉
    // 右键返回与滚轮，表现是「用一会儿就没反应了」）。
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        if (quitting) return;
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // 新代理没有范围信息，不补这一下它就什么窗口都不敢碰
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // 命令窗压制的「闸门」必须在模拟器进程创建之前打开。
    // 旧实现是「等 ApkStart 起来 4 秒后再藏」，而模拟器在这之前就已经把
    // qemu 控制台窗口创建出来了 —— 用户看到的就是一次一闪而过的黑框。
    runtime.emulator.onBeforeSpawn = async () => {
      if (quitting) throw new Error('ApkStart 正在退出，未启动模拟器');
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // 窗口代理是个 PowerShell 常驻进程，冷启动约 300~600ms。
    // 提前拉起，别等到真正要藏窗口的那一刻才开始等。
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent && process.env.APKSTART_SELFTEST !== '1' });
    if (mainWindow) mainWindow.webContents.once('did-finish-load', () => {
      try { updater.confirmAppImageStartup(app.getVersion()); }
      catch (error) { appLog('AppImage health receipt: ' + error.message); }
    });
    scheduleSelfTest();
    buildTray();
    applyAutoStart();

    // 非 Windows：别让用户点开应用才发现「窗口嵌入没有、运行时也下载不了」。
    // 启动就说清楚支持级别与可行路径（upstream #24）。只提示一次，之后可在日志里查。
    if (platform.supportLevel() !== 'full' && process.env.APKSTART_SELFTEST !== '1') {
      setTimeout(async () => {
        try {
          await dialog.showMessageBox(mainWindow || undefined, {
            type: 'warning',
            buttons: ['知道了'],
            defaultId: 0,
            noLink: true,
            title: '平台支持说明',
            message: `ApkStart 在当前平台上只能部分工作（${platform.platform}）`,
            detail: platform.supportNote(),
          });
        } catch (_) { /* 没有窗口就只写日志 */ }
      }, 1200).unref?.();
    }

    // 磁盘余量：小于 3GB 时安卓根本起不来（写镜像/快照都会失败）。
    // 与其让用户看着「打不开」不明所以，不如开门见山告诉他往哪儿改。
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('磁盘空间不足', `只剩 ${(freeMB / 1024).toFixed(1)} GB。请到「设置 → 系统集成」把安卓数据目录/运行时目录改到其他盘，或先清理磁盘。`);
          send('toast', { type: 'error', message: `磁盘只剩 ${(freeMB / 1024).toFixed(1)} GB，安卓可能无法启动（设置 → 系统集成 可换盘）` });
        }, 3000).unref?.();
      }
    }

    // 老版本只建过桌面快捷方式 / 图标是 null：启动即自动补齐，不用用户操作
    ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('快捷方式已补齐', fixed.join('、'));
      }
    }).catch(() => {});

    // F11 全屏 / 窗口切换；全局快捷键只在 ApkStart 活着时有效
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);

    // 预热：像 WSA / 应用宝电脑版那样把安卓环境常驻。
    // 打开 ApkStart 时就在后台把它引导好（窗口全程隐藏），之后点应用只剩一次 am start。
    // 只有「已经装过应用 + 有可用运行时」才预热，避免第一次使用/纯管理场景白占内存。
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 秒就够窗口画完第一帧了。以前等 4 秒，用户这时已经点了应用，
      // 结果「点开」和「预热」抢同一个 AVD 锁，反而更慢。
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // 开机阶段把模拟器窗口与 qemu 控制台藏起来，用户不该看到任何窗
          // 注意要 await：不等它生效就去 spawn，黑窗一定会露出来。
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtimeActions.run('runtime:prewarm', () =>
            runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) }));
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // 预热失败也继续压住模拟器窗口：它可能只是慢，过一会儿就起来了，
            // 用户不该因为「预热失败」在桌面上看到一台模拟器。
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* 预热失败不影响后续正常打开 */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // 首次运行的组件部署延后 20 秒：冷启动那段时间磁盘/CPU 已经打满，
    // 再并发下载解压只会让桌面更卡。真有应用要打开时 ensure() 自会准备。
    scheduleAutoDeploy();

    // 启动 8 秒后静默查一次新版本（打包后才有意义）：自动更新开启时
    // 「通知 → 自动下载 → 空闲时自动重启安装」一条龙；关闭则退回只通知。
    // 之后每 6 小时再查一次，长期挂着的容器也能收到新版本。
    if (app.isPackaged) {
      // 先看上次更新有没有装成功：失败标记要尽快告诉用户，别等 8 秒后的检查
      notifyUpdateFailure();
      setTimeout(() => {
        updater.check().then((info) => handleUpdateFound(info))
          .catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
      setInterval(() => {
        if (updateBusy || autoUpdateJob) return;   // 上一轮还没处理完就不叠上来
        updater.check().then((info) => handleUpdateFound(info))
          .catch(() => { /* 后台定时检查失败不打扰 */ });
      }, 6 * 3600 * 1000).unref?.();
    }

    // 文件同步 / 通知轮询不再无条件常驻：只在容器里真的有应用窗口时才跑
    // （见 onContainerActive）。

    // 冒烟测试：截图后退出，用于自动化验证界面是否正常渲染
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // 运行时面板已并入设置：--setup 与 --settings 等价，直接打开设置截图
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // 窗口可能被遮挡导致拿到旧帧：强制重绘 + 连拍两帧取后一帧
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--wizard')) {
              // 引导向导第 1 页已在主截图里；翻到第 2 页（选盘）再拍一张。
              // 故意不点「开始安装」——那会真的开始下载运行时。
              await mainWindow.webContents.executeJavaScript(
                "const b=document.getElementById('wizardNext'); if (b && !b.hidden) b.click(); true;",
              );
              await new Promise((r) => setTimeout(r, 1200));
              await snap(out.replace(/\.png$/i, '-wizard.png'));
            }
            if (process.argv.includes('--perf')) {
              // 拍一张「性能与资源占用」区（设置页里控件最多的一块）
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // 拍一张「下载与更新源」区
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // 再拍一张「关于」区（二维码 / GitHub / Powered by）
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] 截图失败', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  let quitReady = false;
  let quitTask = null;
  app.on('window-all-closed', () => {
    // 收尾期间不能 app.exit()：窗口停靠、代理释放仍可能没有完成。
    if (quitting && !quitTask && !quitReady) app.quit();
  });

  app.on('before-quit', (e) => {
    quitting = true;
    if (quitReady) return;
    e.preventDefault();
    if (quitTask) return;
    quitTask = Promise.resolve().then(async () => {
      const safely = (fn) => {
        try { fn(); } catch (err) { console.warn('[quit] 收尾失败', err); }
      };
      const syncDrained = Promise.resolve().then(() => sharer?.stop({ timeoutMs: 5000 }))
        .then(result => result !== false, err => {
          console.warn('[quit] 取消共享同步失败', err);
          return false;
        });
      safely(() => notifier?.stop());
      let runtimeDrained = false;
      try {
        runtimeDrained = await runtimeActions.drain();
        if (!runtimeDrained) console.warn('[quit] 在途操作未在期限内结束，停止等待');
      } catch (err) { console.warn('[quit] 等待在途操作失败', err); }
      // closeAll 也等待已被新窗口替换、但仍在停靠的窗口；内部有有界超时。
      try {
        if (await appWin?.closeAll({ keepApp: true }) === false) console.warn('[quit] 未在期限内确认窗口停靠');
      } catch (err) { console.warn('[quit] 窗口停靠失败', err); }
      safely(() => winAgent?.dispose());
      safely(() => wheelRouter?.dispose());
      if (await syncDrained && runtimeDrained) safely(() => runtime?.dispose());
      else console.warn('[quit] 仍有设备操作未排空，不主动关闭其 ADB 传输');
      safely(() => { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); });
      quitReady = true;
      app.quit();
    });
  });
}

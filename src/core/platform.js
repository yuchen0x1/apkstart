'use strict';
/**
 * 平台能力表 —— 全应用唯一的「这个功能在这台系统上到底能不能用」的出处。
 *
 * 为什么要有这个文件（upstream issue #24）：
 *   窗口嵌入那一整套（SetParent 把模拟器 Qt 窗口挂到 Electron 窗口下面、常驻
 *   PowerShell 代理、DPI 感知、全局鼠标钩子）是纯 Win32 的东西；但代码里到处
 *   散着 `process.platform === 'win32'`，结果是别的系统上「有些地方判断了、有些
 *   没判断」—— 在 Linux 上点开应用会走完整个启动流程，然后卡在 embed 上，
 *   窗口全黑、也没有一句解释。
 *
 * 这里把判断集中成一处：调用方只问能力（canEmbed / canProvision / ...），
 * 不自己写平台判断。以后真要加 Linux 的窗口嵌入，只改这里的 canEmbed 与
 * 对应的后端实现，其他文件不用动。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = process.platform;
const isWin = platform === 'win32';
const isLinux = platform === 'linux';
const isMac = platform === 'darwin';

/**
 * 窗口嵌入：把模拟器的原生窗口嵌进我们的窗口里。
 * 依赖 Win32：SetParent / WS_CHILD / DWM / SetProcessDpiAwareness + 常驻 PowerShell 代理。
 * 其他系统上模拟器窗口只能作为独立窗口显示（见 docs/PLATFORM-LINUX.md 的接法）。
 */
const canEmbed = isWin;

/** 内置运行时（含 AEHD 驱动、vc_redist、Windows 版 emulator 包）只做了 Windows 一套 */
const canProvision = isWin;

/** 桌面快捷方式 / 文件关联 / 托盘菜单图标替换：Windows 注册表与 PowerShell */
const canIntegrateShell = isWin;

/** 全局鼠标钩子（右键返回、滚轮滑动、侧键前进后退） */
const canHookMouse = isWin;

/**
 * 支持级别，用于界面提示与诊断报告。
 *   full          —— 完整支持（Windows）
 *   external      —— 能用，但安卓画面是独立窗口（Linux：需自行准备 SDK 并用「连接已有运行时」）
 *   unsupported   —— 没有实现，启动即提示
 */
function supportLevel() {
  if (isWin) return 'full';
  if (isLinux) return 'external';
  return 'unsupported';
}

/** 给用户看的一句话（英文由 i18n 覆盖，这里是中文原文） */
function supportNote() {
  switch (supportLevel()) {
    case 'full':
      return '';
    case 'external':
      return '当前系统不支持窗口嵌入：安卓应用会在模拟器自己的窗口里运行。'
        + '内置运行时下载也只支持 Windows —— 请用 Android Studio / SDK 装好 emulator 与 platform-tools，'
        + '然后在「设置 → 引擎 → 连接已有运行时」里填地址。';
    default:
      return 'ApkStart 目前只支持 Windows：窗口嵌入、运行时分发与驱动安装都依赖 Win32 与 PowerShell。';
  }
}

/** 可执行文件名：Windows 带 .exe，其他系统不带 */
function exe(name) {
  return isWin ? `${name}.exe` : name;
}

/** 安卓 AVD 的默认目录（各系统约定不同，别硬编码 %USERPROFILE%） */
function avdHomeDefault() {
  const home = os.homedir();
  if (isWin) return path.join(home, '.android', 'avd');
  // Linux / macOS 都是 $HOME/.android/avd（Android Studio 与 emulator 的约定）
  return path.join(home, '.android', 'avd');
}

/** 硬件加速能力（只做「有没有」的判断，具体启用仍由 emulator 自己处理） */
function acceleration() {
  if (isWin) return { kind: 'whpx-or-aehd', ok: null, path: '' };
  if (isLinux) {
    const kvm = '/dev/kvm';
    let ok = false;
    try { ok = fs.existsSync(kvm) && fs.statSync(kvm).isCharacterDevice(); } catch (_) { ok = false; }
    return {
      kind: 'kvm',
      ok,
      path: kvm,
      hint: ok ? '' : '没有 /dev/kvm：把当前用户加入 kvm 组（sudo usermod -aG kvm $USER 后重新登录），'
        + '或在 BIOS 里打开 VT-x/AMD-V。没有它只能纯软件模拟，开机要几分钟。',
    };
  }
  return { kind: 'hvf', ok: null, path: '' };
}

/** 诊断报告用：与具体平台相关、但排障时一定要看到的信息 */
function describe() {
  return {
    platform,
    release: os.release(),
    arch: process.arch,
    support: supportLevel(),
    canEmbed,
    canProvision,
    canIntegrateShell,
    acceleration: acceleration(),
  };
}

module.exports = {
  platform,
  isWin,
  isLinux,
  isMac,
  canEmbed,
  canProvision,
  canIntegrateShell,
  canHookMouse,
  supportLevel,
  supportNote,
  exe,
  avdHomeDefault,
  acceleration,
  describe,
};

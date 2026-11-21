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
 * 不自己写平台判断。能力的**依据**（每条平台 × 能力的等级、障碍代码、实现出处）
 * 全部来自 src/core/platform-capabilities.js 的声明表；本文件只负责把当前平台的
 * 那一行读出来并保持对外 API 稳定。以后真要加 Linux 的窗口嵌入，只改声明表的
 * embed.linux 与对应的后端实现，其他文件不用动。
 *
 * 明确不虚报（upstream #112 / #88）：
 *   - macOS（darwin）：整体 unsupported。窗口嵌入、内置运行时、打包/签名/公证
 *     都没有实现；「连接已有运行时」的 adb 查找表虽已备好 macOS 路径，但接口
 *     未实测，不构成支持承诺。障碍代码见 capability('provision').blockers。
 *   - Linux / GNOME（Wayland 会话）：独立窗口 + 内置运行时可用（external 档），
 *     **不**支持窗口嵌入，也不能声称 X11 方案能覆盖 Wayland —— Wayland 协议
 *     层面客户端不能访问其他客户端的 surface，跨进程 reparent 没有原生方案。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const capabilities = require('./platform-capabilities');

const platform = process.platform;
const isWin = platform === 'win32';
const isLinux = platform === 'linux';
const isMac = platform === 'darwin';

/** 便捷读取：当前平台上某项能力的声明（含等级 / 障碍代码 / 实现出处 / 说明） */
function capability(id) {
  return capabilities.capabilityFor(id, platform);
}

const isFull = (id) => capability(id).level === capabilities.SUPPORT_LEVELS.full;

/**
 * 窗口嵌入：把模拟器的原生窗口嵌进我们的窗口里。
 * 依赖 Win32：SetParent / WS_CHILD / DWM / SetProcessDpiAwareness + 常驻 PowerShell 代理。
 * 其他系统上模拟器窗口只能作为独立窗口显示（Linux 档位见 supportLevel()）；
 * Wayland（GNOME 默认会话）协议层面不允许跨客户端 reparent，没有「换条路」可言。
 */
const canEmbed = isFull('embed');

/**
 * 内置运行时自动部署：
 *   Windows —— 整包（GitHub Release）或官方源逐组件；加速走 WHPX/AEHD。
 *   Linux   —— 官方源逐组件（platform-tools / emulator / 系统镜像都是 Google 官方
 *              Linux 包）；加速走 /dev/kvm；AEHD 与运行时整包不适用（provision 内部
 *              已按 IS_WIN 守卫）。加速检测 /dev/kvm 见 acceleration()。
 *   macOS   —— 无实现（provision 的产物路径、打包与签名/公证链路缺失）。
 */
const canProvision = isFull('provision');

/** 桌面快捷方式 / 文件关联 / 托盘菜单图标替换：Windows 注册表与 PowerShell */
const canIntegrateShell = isFull('shellIntegration');

/** 全局鼠标钩子（右键返回、滚轮滑动、侧键前进后退） */
const canHookMouse = isFull('mouseHook');

/**
 * 支持级别，用于界面提示与诊断报告。
 *   full          —— 完整支持（Windows：含窗口嵌入）
 *   external      —— 能用，但安卓画面是独立窗口（Linux：内置运行时可自动下载，
 *                    窗口嵌入是 Win32 专有；Linux 需要图形会话与 /dev/kvm 才有完整体验）
 *   unsupported   —— 没有实现（当前即 macOS 与其它平台），启动即提示
 */
function supportLevel() {
  return capabilities.platformSupportLevel(platform);
}

/** 给用户看的一句话（英文由 i18n 覆盖，这里是中文原文） */
function supportNote() {
  switch (supportLevel()) {
    case 'full':
      return '';
    case 'external':
      return '当前系统不支持窗口嵌入：安卓应用会在模拟器自己的窗口里运行。'
        + '运行时（adb / 模拟器 / 系统镜像）可以在应用内一键自动下载，'
        + '前提是图形会话可用、且 /dev/kvm 已就绪（把用户加入 kvm 组并在 BIOS 打开虚拟化）。';
    case 'unsupported':
      if (isMac) {
        return 'ApkStart 目前支持 Windows 与 Linux，macOS 还不能使用：窗口嵌入、内置运行时'
          + '自动部署、dmg 打包与签名公证都没有实现（Apple silicon 需要配套的 arm64-v8a'
          + ' 系统镜像与 Hypervisor.framework 加速验证）。'
          + '「设置 → 运行时引擎 → 连接已有运行时」的 adb 通道在原理上可用（Android Studio '
          + '自带的 platform-tools 含 macOS 版 adb），但未经测试，不作为支持承诺。';
      }
      return 'ApkStart 目前支持 Windows 与 Linux：窗口嵌入是 Windows 专有能力，'
        + '其它系统的应用画面会显示在模拟器自己的窗口里。';
    default:
      return 'ApkStart 目前支持 Windows 与 Linux：窗口嵌入是 Windows 专有能力，'
        + '其它系统的应用画面会显示在模拟器自己的窗口里。';
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
  // darwin 与其它平台：Hypervisor.framework 路线从未实现、从未实测。
  // ok 保持 null（未知），不能让诊断报告显示成「可用」。
  return {
    kind: isMac ? 'hvf' : 'none',
    ok: null,
    path: '',
    hint: isMac
      ? 'macOS 尚未受支持：Hypervisor.framework 加速路线未实现也未验证。'
      : '当前平台没有已实现的硬件加速检测。',
  };
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
    // 结构化障碍代码（upstream #112）：诊断报告与 UI 可以据此给出「为什么不行」，
    // 而不是一句含糊的「不支持」。unsupported 平台才有内容。
    blockers: capabilities.platformBlockers(platform),
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
  capability,
  exe,
  avdHomeDefault,
  acceleration,
  describe,
};

'use strict';
/**
 * 平台能力模型 —— 声明式的「哪条平台、哪项能力、什么等级、为什么不行」。
 *
 * 它是 src/core/platform.js 的**依据表**：platform.js 里的 canEmbed / canProvision /
 * supportLevel() / supportNote() 都从这里推导，不允许再出现「本地再写一份平台判断」。
 * 这样回归测试可以只替换 process.platform 重建整张能力表，逐一钉死每条声明；
 * 任何想靠「os:'darwin' 加一行」宣布支持 macOS 的改动都会在这里被测试拦下。
 *
 * 覆盖的上游诉求：
 *   - RoutineMiku/apkstart#112 —— 询问 macOS 支持；
 *   - RoutineMiku/apkstart#24 —— 请求 Linux 支持（已交付：独立窗口 + 内置运行时）；
 *   - RoutineMiku/apkstart#88 —— 询问 GNOME（Wayland 会话）上的可用性。
 *
 * 边界纪律（为什么不写得更「乐观」）：
 *   1. 一切能力声明都以仓库内既有实现为准；没有实现 = absent，哪怕协议上可行。
 *   2. Wayland 协议层面客户端不能访问其他客户端的 surface（Wayland 官方协议文档，
 *      https://wayland.freedesktop.org/docs/book/Protocol.html，2026-11-21 引用），
 *      跨进程 reparent 在 Wayland 上没有原生方案 —— 不能声称 X11 方案能覆盖 GNOME
 *      的 Wayland 会话；X11 路线也只是「候选方向」，仓库里没有对应后端。
 *   3. macOS 交付需要 host 架构匹配的官方镜像（Android 官方文档：VM 加速要求
 *      Apple silicon 用 arm64-v8a 镜像、Intel 用 x86_64，加速走 Hypervisor.framework，
 *      https://developer.android.com/studio/run/emulator-acceleration，2026-11-21 引用）、
 *      macOS 版 provision 产物路径、dmg 打包与 Developer ID 签名/公证（Apple 官方
 *      《Notarizing macOS software before distribution》，2026-11-21 引用）——
 *      这些全部缺失，因此 macOS 整体 unsupported，而不是「加个 os:'darwin' 就支持」。
 *   4. attach（连接已有运行时）走 adb，与桌面系统无关；adb 的平台查找表已按
 *      win32 / Linux / macOS Android Studio 约定分叉（src/core/adb.js）。macOS 侧
 *      属于「接口已备、未实测」：这里声明接口可用，但平台整体门禁仍由
 *      supportLevel() = unsupported 挡住，不构成对 macOS 的支持承诺。
 */

/** 能力支持等级：与 platform.supportLevel() 的取值共用同一词表 */
const SUPPORT_LEVELS = Object.freeze({
  full: 'full',               // 已实现且经过平台实测
  external: 'external',       // 能用，但某项体验明确降级（当前仅 Linux：独立窗口）
  partial: 'partial',         // 接口已备、未在该平台实测（当前仅 macOS attach）
  absent: 'absent',           // 没有实现；必须给出障碍代码与说明
  unsupported: 'unsupported', // 平台整体未发行 / 未受支持
});

/** 平台障碍代码：诊断报告 / UI / 测试共用的稳定字符串，不得随意改名 */
const OBSTACLE_CODES = Object.freeze({
  OK: 'OK',                                      // 无障碍
  NO_NATIVE_BACKEND: 'NO_NATIVE_BACKEND',        // 没有该平台的窗口嵌入后端（Win32 代理之外均为空）
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',  // 平台整体未发行 / 未受支持
  NO_MAC_PACKAGING: 'NO_MAC_PACKAGING',          // electron-builder 未配置 macOS 产物（当前只有 win / AppImage / deb）
  NO_NOTARIZATION: 'NO_NOTARIZATION',            // 没有 Developer ID 签名与公证链路（macOS 对外分发的硬要求）
  NO_MAC_RUNTIME_VALIDATION: 'NO_MAC_RUNTIME_VALIDATION', // 内置运行时从未在 macOS 实测（QEMU 路径 / Hypervisor.framework / 架构匹配镜像）
  HOST_ARCH_IMAGE_MISMATCH: 'HOST_ARCH_IMAGE_MISMATCH',   // 宿主架构与系统镜像 ABI 不匹配（arm64 宿主配 x86_64 镜像等）
  HOST_ARCH_RUNTIME_MISMATCH: 'HOST_ARCH_RUNTIME_MISMATCH', // 宿主架构没有对应的官方运行时构建（当前运行时只发布 x86_64）
});

/**
 * 能力表。source 指向仓库内的实现出处（人可读）；没有实现时 source 为空串。
 * note 只做解释，不参与判断；blockers 是结构化的障碍代码列表（可被 UI/报告引用）。
 */
const CAPABILITIES = Object.freeze({
  /** 把模拟器画面嵌进 ApkStart 窗口：只有 Win32 代理这一条实现 */
  embed: {
    win32: { level: SUPPORT_LEVELS.full, code: OBSTACLE_CODES.OK, source: 'win32-agent (src/core/win/agent.ps1)' },
    linux: {
      level: SUPPORT_LEVELS.absent,
      code: OBSTACLE_CODES.NO_NATIVE_BACKEND,
      source: '',
      note: '嵌入是 Win32（SetParent + 常驻代理）专有实现；X11 的 XReparentWindow 路线'
        + '需要自研后端并处理窗口管理器干预，仓库里没有；Wayland 协议层面不允许跨客户端'
        + ' surface 操作，GNOME 默认 Wayland 会话 —— 不得声称 X11 方案可覆盖 GNOME。',
    },
    darwin: {
      level: SUPPORT_LEVELS.absent,
      code: OBSTACLE_CODES.NO_NATIVE_BACKEND,
      source: '',
      note: '没有 macOS 窗口嵌入实现；Win32 代理方案不可移植。',
    },
  },

  /** 内置运行时（adb / emulator / 系统镜像）自动部署 */
  provision: {
    win32: { level: SUPPORT_LEVELS.full, code: OBSTACLE_CODES.OK, source: 'builtin-runtime-windows (src/core/provision.js)' },
    linux: {
      level: SUPPORT_LEVELS.full,
      code: OBSTACLE_CODES.OK,
      source: 'builtin-runtime-linux (src/core/provision.js, HOST_TAG=linux)',
      note: '官方源逐组件下载 + /dev/kvm 加速；Linux 实测记录见 docs/PLATFORM-LINUX-VALIDATION.md。',
    },
    darwin: {
      level: SUPPORT_LEVELS.absent,
      code: OBSTACLE_CODES.UNSUPPORTED_PLATFORM,
      source: '',
      // 事实核对（2026-11-23 读取 Google 官方索引）：Google **确实**发布了 macOS 版
      // emulator（darwin_x64 / darwin_aarch64，注意前缀是 darwin 不是 mac）与
      // platform-tools（darwin），且索引里有架构匹配的 arm64-v8a / x86_64 系统镜像。
      // 因此「官方运行时产物可获取」为真（见 src/core/host/profile.js 及其测试）。
      // 但产物可得 ≠ 本项目的部署路径、dmg 打包、Developer ID 签名/公证、真机实测已完成；
      // 平台整体门禁仍是 absent，acquirable 仅用于诊断与路线图，禁止当作「已支持」依据。
      acquirable: true,
      blockers: Object.freeze([
        OBSTACLE_CODES.NO_MAC_PACKAGING,
        OBSTACLE_CODES.NO_NOTARIZATION,
        OBSTACLE_CODES.NO_MAC_RUNTIME_VALIDATION,
      ]),
      note: 'macOS 交付需要：host 架构匹配的官方镜像（Apple silicon 用 arm64-v8a、Intel 用'
        + ' x86_64）、macOS 版 provision 产物路径、dmg 打包与 Developer ID 签名/公证，'
        + '目前全部缺失，缺一项就不能宣布支持。',
    },
  },

  /** 桌面快捷方式 / 文件关联 / 托盘图标：Windows 注册表 + PowerShell */
  shellIntegration: {
    win32: { level: SUPPORT_LEVELS.full, code: OBSTACLE_CODES.OK, source: 'win32-registry (src/core/assoc.js)' },
    linux: { level: SUPPORT_LEVELS.absent, code: OBSTACLE_CODES.NO_NATIVE_BACKEND, source: '' },
    darwin: { level: SUPPORT_LEVELS.absent, code: OBSTACLE_CODES.NO_NATIVE_BACKEND, source: '' },
  },

  /** 全局鼠标钩子（右键返回、滚轮、侧键）：WH_MOUSE_LL 低级钩子 */
  mouseHook: {
    win32: { level: SUPPORT_LEVELS.full, code: OBSTACLE_CODES.OK, source: 'win32-agent (src/core/win/agent.ps1)' },
    linux: { level: SUPPORT_LEVELS.absent, code: OBSTACLE_CODES.NO_NATIVE_BACKEND, source: '' },
    darwin: { level: SUPPORT_LEVELS.absent, code: OBSTACLE_CODES.NO_NATIVE_BACKEND, source: '' },
  },

  /** 连接已有运行时（attach）：走 adb，不依赖窗口系统；查找表已按平台分叉 */
  attach: {
    win32: { level: SUPPORT_LEVELS.full, code: OBSTACLE_CODES.OK, source: 'adb (src/core/adb.js)' },
    linux: { level: SUPPORT_LEVELS.full, code: OBSTACLE_CODES.OK, source: 'adb (src/core/adb.js)' },
    darwin: {
      level: SUPPORT_LEVELS.partial,
      code: OBSTACLE_CODES.OK,
      source: 'adb (src/core/adb.js 含 ~/Library/Android/sdk/platform-tools/adb)',
      note: 'adb 查找表已含 macOS 的 Android Studio 路径；接口已备但未实测。'
        + '平台整体门禁仍按 unsupported 处理 macOS，不构成支持承诺。',
    },
  },
});

/** 平台整体支持级别：embed 与 provision 里较高的那档（能力可以互补，不能互相抬轿） */
function platformSupportLevel(hostPlatform) {
  if (hostPlatform === 'win32') return SUPPORT_LEVELS.full;
  if (hostPlatform === 'linux') return SUPPORT_LEVELS.external;
  // darwin 与一切未知平台：整体 unsupported（不因为 attach 接口存在而抬高）
  return SUPPORT_LEVELS.unsupported;
}

/** 平台整体障碍：unsupported 平台返回结构化阻塞列表，其余返回空数组 */
function platformBlockers(hostPlatform) {
  if (hostPlatform === 'darwin') {
    return Object.freeze([
      OBSTACLE_CODES.NO_MAC_PACKAGING,
      OBSTACLE_CODES.NO_NOTARIZATION,
      OBSTACLE_CODES.NO_MAC_RUNTIME_VALIDATION,
    ]);
  }
  return Object.freeze([]);
}

/** 未声明平台的保守缺省：一切能力按「未实现」处理（宁可少说，不可虚报） */
const UNDECLARED_PLATFORM_NOTE = '该平台没有此能力的声明：按「未实现」保守处理，不构成任何支持承诺。';

/** 按 hostPlatform 取某项能力的声明；未知能力 id 抛错（编程错误），未声明平台按 absent 保守缺省 */
function capabilityFor(id, hostPlatform = process.platform) {
  const cap = CAPABILITIES[id];
  if (!cap) throw new Error(`未知能力：${id}`);
  const entry = cap[hostPlatform];
  // 未声明平台（如 freebsd）：给显式的「未实现」，而不是抛错 —— 应用必须能在任何
  // 系统上完成 require 并说清楚「不支持」，不能在启动阶段就崩掉。
  if (!entry) {
    return {
      level: SUPPORT_LEVELS.absent,
      code: OBSTACLE_CODES.UNSUPPORTED_PLATFORM,
      source: '',
      note: UNDECLARED_PLATFORM_NOTE,
      id,
      platform: hostPlatform,
    };
  }
  return { ...entry, id, platform: hostPlatform };
}

/** 全部能力 × 全部平台的展开（诊断报告 / 测试用） */
function capabilityMatrix() {
  const ids = Object.keys(CAPABILITIES);
  const platforms = ['win32', 'linux', 'darwin'];
  return ids.map((id) => ({
    id,
    byPlatform: Object.fromEntries(platforms.map((p) => [p, capabilityFor(id, p)])),
  }));
}

module.exports = {
  SUPPORT_LEVELS,
  OBSTACLE_CODES,
  CAPABILITIES,
  platformSupportLevel,
  platformBlockers,
  capabilityFor,
  capabilityMatrix,
};

'use strict';
/**
 * 宿主画像（纯函数，零依赖）
 * ------------------------------------------------------------------
 * 这个文件只回答一个问题：「在 host/arch 这个组合上，Google 官方到底发布了什么？」
 * 它不碰文件系统、不起子进程、不读设置，因此可以离线单测，也可以在报告里安全调用。
 *
 * 为什么单独抽出来（而不是继续写在 provision.js 里）：
 *   provision.js 原先写的是 `HOST_TAG = IS_WIN ? 'windows' : IS_LINUX ? 'linux' : 'mac'`
 *   再拼 `${HOST_TAG}_x64`。这有两个真实缺陷：
 *     1. macOS 的真实归档前缀是 `darwin`，不是 `mac` —— 拼出来永远匹配不到任何条目；
 *     2. `_x64` 写死，Apple Silicon（arm64）永远解析不到 `emulator-darwin_aarch64-N.zip`。
 *   把「宿主 → 官方产物名」的映射集中到这里，任何平台新增/修正都只改这一张表，
 *   并且用测试逐一钉死，避免再用「加个 os 字段」冒充支持。
 *
 * 事实依据（2026-11-23 实际读取 https://dl.google.com/android/repository/repository2-3.xml 核实）：
 *   emulator 归档实际只发布这四种宿主：
 *     emulator-windows_x64-N.zip / emulator-linux_x64-N.zip
 *     emulator-darwin_x64-N.zip   / emulator-darwin_aarch64-N.zip
 *   → 没有任何 emulator-linux_aarch64-N.zip。所以 ARM64 Linux 的「官方模拟器运行时」
 *     在事实上不存在，不能靠重新打包 ApkStart 得到。该结论写进这里的 EMULATOR_PREFIX 表：
 *     linux/arm64 显式返回空串，由调用方给出明确的「无官方运行时」提示，而不是静默下载 x64 包。
 */

/** Node 的 process.arch → 归一化的宿主架构。未识别的返回空串（保守处理）。 */
const ARCH_ALIASES = Object.freeze({
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
});

/** 归一化宿主架构：'x64' | 'arm64' | ''（未知） */
function normalizeArch(arch) {
  const key = String(arch || '').trim().toLowerCase();
  return Object.hasOwn(ARCH_ALIASES, key) ? ARCH_ALIASES[key] : '';
}

/**
 * emulator 归档前缀（Google 官方 SDK 索引里的真实命名）。
 * 返回 `windows_x64` / `linux_x64` / `darwin_x64` / `darwin_aarch64`；
 * 该宿主没有官方模拟器发行物时返回空串 —— 这是**事实**，不是可以「先支持再说」的占位。
 */
const EMULATOR_PREFIX = Object.freeze({
  'win32/x64': 'windows_x64',
  'linux/x64': 'linux_x64',
  'darwin/x64': 'darwin_x64',
  'darwin/arm64': 'darwin_aarch64',
  // linux/arm64：Google 未发布 emulator-linux_aarch64，故不在此表中。
});

function emulatorArchivePrefix(host = process.platform, arch = process.arch) {
  const key = `${host}/${normalizeArch(arch)}`;
  return Object.hasOwn(EMULATOR_PREFIX, key) ? EMULATOR_PREFIX[key] : '';
}

/**
 * platform-tools 归档的后缀与 host-os（Google 官方索引真实字段）。
 *  - 文件名：platform-tools_r<版本>-<suffix>.zip，suffix ∈ {win, linux, darwin}
 *  - host-os 元素：windows / linux / macosx
 *  - host-arch 元素：x64，或 darwin 下另有 arm64
 * linux/arm64 不在表内：官方索引的 linux 归档只声明 x64 宿主架构。
 */
const PLATFORM_TOOLS_TARGET = Object.freeze({
  'win32/x64': { os: 'windows', suffix: 'win', arch: 'x64' },
  'linux/x64': { os: 'linux', suffix: 'linux', arch: 'x64' },
  'darwin/x64': { os: 'macosx', suffix: 'darwin', arch: 'x64' },
  'darwin/arm64': { os: 'macosx', suffix: 'darwin', arch: 'arm64' },
});

/** 返回 { os, suffix, arch } 或 null（该宿主没有官方 platform-tools） */
function platformToolsTarget(host = process.platform, arch = process.arch) {
  const key = `${host}/${normalizeArch(arch)}`;
  const hit = PLATFORM_TOOLS_TARGET[key];
  return hit ? { ...hit } : null;
}

/**
 * 官方系统镜像的默认 ABI。
 *   Intel/AMD（x64）宿主：x86_64 镜像（可硬件加速，内置 ARM 转译层）。
 *   ARM64 宿主：必须用 arm64-v8a 镜像 —— x86_64 镜像在 arm64 宿主上启动不了，
 *   这不是性能问题而是指令集不同（Android 官方对 Apple silicon 的要求）。
 * 未知架构返回空串，由调用方明确报错，绝不默认回退到 x86_64 造成「装上了但起不来」。
 */
function defaultSysimgAbi(arch = process.arch) {
  const a = normalizeArch(arch);
  if (a === 'x64') return 'x86_64';
  if (a === 'arm64') return 'arm64-v8a';
  return '';
}

/**
 * 宿主硬件加速后端的种类（只描述「这条平台用哪种机制」，不代表已就绪）。
 *   win32  → whpx（Windows Hypervisor Platform）/ aehd（Android Emulator Hypervisor Driver）
 *   linux  → kvm（/dev/kvm）
 *   darwin → hvf（Hypervisor.framework）
 */
function accelerationBackend(host = process.platform) {
  if (host === 'win32') return 'whpx-or-aehd';
  if (host === 'linux') return 'kvm';
  if (host === 'darwin') return 'hvf';
  return 'none';
}

/**
 * 宿主事实总览：一处给出「这套运行时要靠哪些官方产物」。
 * 「可获取」（acquirable）与「已验证」（verified）是两件事：本函数只描述前者。
 * @returns {object}
 */
function hostFacts(host = process.platform, arch = process.arch) {
  const normArch = normalizeArch(arch);
  const emulatorPrefix = emulatorArchivePrefix(host, arch);
  const tools = platformToolsTarget(host, arch);
  const abi = defaultSysimgAbi(arch);
  return Object.freeze({
    platform: host,
    arch: normArch || String(arch || ''),
    knownArch: !!normArch,
    // 官方 emulator 运行时归档前缀；空串表示该宿主没有官方发行物
    emulatorPrefix,
    emulatorAvailable: !!emulatorPrefix,
    // 官方 platform-tools；null 表示没有该宿主的官方包
    platformTools: tools,
    platformToolsAvailable: !!tools,
    // 默认系统镜像 ABI；空串表示架构未知
    sysimgAbi: abi,
    // 加速后端种类（是否就绪需另行探测）
    acceleration: accelerationBackend(host),
  });
}

module.exports = {
  ARCH_ALIASES,
  EMULATOR_PREFIX,
  PLATFORM_TOOLS_TARGET,
  normalizeArch,
  emulatorArchivePrefix,
  platformToolsTarget,
  defaultSysimgAbi,
  accelerationBackend,
  hostFacts,
};

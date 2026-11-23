'use strict';
/**
 * 宿主适配层（Host Adapter）
 * ------------------------------------------------------------------
 * 目标：把「这台机器能做什么、要用哪些官方产物、按哪条路径找文件」收敛成一个接口，
 * 业务代码只问 HostAdapter，不再到处散落 `process.platform === 'win32'`。
 *
 * 边界纪律（与 platform.js / platform-capabilities.js 一致）：
 *   - 能力「有没有实现」由 platform-capabilities.js 的声明表决定，本层不另立一份；
 *   - 本层只负责「官方产物名 / 默认 ABI / 加速后端种类 / 数据目录 / 可执行后缀」这类
 *     纯事实映射，纯函数部分放在 ./profile.js，便于离线回归；
 *   - 不声称任何未实测平台「已支持」：acquirable（能拿到官方产物）≠ verified（跑通过）。
 */
const os = require('os');
const path = require('path');
const profile = require('./profile');
const capabilities = require('../platform-capabilities');

class HostAdapter {
  /**
   * @param {object} [opts]
   *   - platform 宿主平台（默认 process.platform，测试可注入）
   *   - arch     宿主架构（默认 process.arch）
   */
  constructor(opts = {}) {
    this.osPlatform = String(opts.platform || process.platform);
    this.osArch = String(opts.arch || process.arch);
    this.facts = profile.hostFacts(this.osPlatform, this.osArch);
  }

  /** 平台名（win32 / linux / darwin / …） */
  get platform() { return this.osPlatform; }

  /** 归一化架构（x64 / arm64 / ''） */
  get arch() { return this.facts.arch; }

  get isWindows() { return this.osPlatform === 'win32'; }
  get isLinux() { return this.osPlatform === 'linux'; }
  get isMac() { return this.osPlatform === 'darwin'; }

  /** 可执行文件后缀：Windows 带 .exe，其它不带 */
  exeSuffix() { return this.isWindows ? '.exe' : ''; }

  /** 给可执行文件名加后缀：exe('adb') → 'adb.exe' / 'adb' */
  exe(name) { return `${name}${this.exeSuffix()}`; }

  /** 官方 emulator 归档前缀；空串表示该宿主没有官方模拟器发行物 */
  emulatorArchivePrefix() { return this.facts.emulatorPrefix; }

  /** 官方 platform-tools 目标 { os, suffix, arch } 或 null */
  platformToolsTarget() { return this.facts.platformTools; }

  /** 默认系统镜像 ABI（x86_64 / arm64-v8a / ''） */
  sysimgAbi() { return this.facts.sysimgAbi; }

  /** 硬件加速后端种类：whpx-or-aehd / kvm / hvf / none（是否就绪需另探测） */
  accelerationBackend() { return this.facts.acceleration; }

  /**
   * 某项能力在当前平台上的声明（含等级/障碍代码/实现出处），
   * 直接取自 platform-capabilities.js，保证「只有一份判断」。
   */
  capability(id) { return capabilities.capabilityFor(id, this.osPlatform); }

  /** 平台整体支持级别：full / external / unsupported */
  supportLevel() { return capabilities.platformSupportLevel(this.osPlatform); }

  /** 平台整体阻塞代码（unsupported 平台才有内容） */
  blockers() { return capabilities.platformBlockers(this.osPlatform); }

  /**
   * 运行时是否可信地可获得（官方产物存在且架构已知）。
   * 这只说明「能下载到官方产物」，不说明「已在本平台跑通过」。
   */
  runtimeAcquirable() {
    return this.facts.emulatorAvailable && this.facts.platformToolsAvailable;
  }

  /**
   * 面向诊断/报告的一行式事实：不夸大、不含未验证承诺。
   * @returns {object}
   */
  describe() {
    return {
      platform: this.osPlatform,
      arch: this.facts.arch || this.osArch,
      knownArch: this.facts.knownArch,
      support: this.supportLevel(),
      emulatorPrefix: this.facts.emulatorPrefix,
      emulatorAvailable: this.facts.emulatorAvailable,
      platformToolsAvailable: this.facts.platformToolsAvailable,
      sysimgAbi: this.facts.sysimgAbi,
      acceleration: this.facts.acceleration,
      runtimeAcquirable: this.runtimeAcquirable(),
      blockers: [...this.blockers()],
      // 用户目录（AVD 约定）：Windows / Linux / macOS 都是 $HOME/.android/avd
      avdHomeDefault: path.join(os.homedir(), '.android', 'avd'),
    };
  }
}

/** 便捷工厂：按当前进程创建适配器 */
function current(opts = {}) { return new HostAdapter(opts); }

module.exports = { HostAdapter, current, profile };

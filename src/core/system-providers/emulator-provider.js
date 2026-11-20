'use strict';
/**
 * 内置 Android Emulator 档位 Provider（Google Play / Google APIs / 纯 AOSP）。
 * ------------------------------------------------------------------
 * 这三个系统不是"下载第三方镜像"，而是复用 ApkStart 已有的 emulator 运行时与档位机制。
 * 切换档位走现有的 imageProfile（会切换独立 AVD，不共用 userdata）。
 * 启动/停止委托给 system-manager 注入的 backend（即现有 engine.Runtime）。
 */
const { BaseProvider, PROVIDER_IDS } = require('./base-provider');

const FLAVOR_BY_ID = {
  [PROVIDER_IDS.GOOGLE_PLAY]: 'google_apis_playstore',
  [PROVIDER_IDS.GOOGLE_APIS]: 'google_apis',
  [PROVIDER_IDS.AOSP]: 'default',
};

class EmulatorProvider extends BaseProvider {
  constructor(ctx = {}) {
    super(ctx);
    this.flavor = FLAVOR_BY_ID[this.id] || 'google_apis_playstore';
    this.backendEngine = ctx.backendEngine || null; // system-manager 注入的 engine.Runtime
  }

  async getAvailability() {
    return { available: true, status: 'builtin', reason: '', version: { version: '内置档位', status: 'builtin' } };
  }

  async getDownloadInfo() {
    // 内置档位随运行时包部署，不作为第三方镜像下载。
    return null;
  }

  async getRunningState() {
    if (this.backendEngine && typeof this.backendEngine.status === 'function') {
      const env = await this.backendEngine.status();
      if (!env || typeof env.vmRunning !== 'boolean' || typeof env.deviceOnline !== 'boolean') {
        throw new Error('引擎未返回可验证的运行状态');
      }
      // A running guest is shared by the built-in flavor providers. Its selected
      // flavor is presentation/configuration, not proof that the process is stopped.
      return !!(env.vmRunning || env.deviceOnline);
    }
    if (this.backendEngine && typeof this.backendEngine.vmRunning === 'boolean') return this.backendEngine.vmRunning;
    throw new Error('无法确认内置运行时状态');
  }

  async getLocalStatus() {
    let env = {};
    if (this.backendEngine && this.backendEngine.status) {
      // Unknown is not stopped: lifecycle callers must see this failure.
      env = await this.backendEngine.status();
      if (!env || typeof env.vmRunning !== 'boolean' || typeof env.deviceOnline !== 'boolean') {
        throw new Error('引擎未返回可验证的运行状态');
      }
    }
    const settings = this.settings;
    const selected = settings.runtime && settings.runtime.systemImageFlavor;
    const active = !selected || selected === this.flavor;
    return {
      installed: !!(env.installed || env.env && env.env.sysimg && env.env.sysimg.ok),
      downloaded: true,
      running: !!((env.vmRunning || env.deviceOnline) && active),
      version: this.flavor,
      active,
      paths: {},
    };
  }

  async getLogs() {
    if (this.backendEngine && this.backendEngine.bootLog) return this.backendEngine.bootLog.slice();
    return this._logs.slice();
  }

  /** 切换档位：必须走 imageProfile 校验过的入口，由 system-manager 实现具体切换 */
  async activate(ctx = {}) {
    const switcher = ctx.switchFlavor || (this.backendEngine && this.backendEngine.switchFlavor);
    if (typeof switcher !== 'function') {
      return { ok: false, error: '档位切换未接入引擎' };
    }
    return switcher(this.flavor);
  }

  async start(ctx = {}) {
    const signal = ctx.signal;
    if (signal && signal.aborted) return { ok: false, code: 'START_CANCELLED', error: '系统启动已取消' };
    if (!this.backendEngine || typeof this.backendEngine.ensure !== 'function') {
      return { ok: false, error: '引擎未就绪' };
    }
    const r = await this.backendEngine.ensure({
      onLog: (m) => this.log(m),
      lowspec: !!ctx.lowspec,
      timeoutMs: ctx.timeoutMs || 0,
      signal,
    });
    if (signal && signal.aborted) return { ok: false, code: 'START_CANCELLED', error: '系统启动已取消' };
    return Object.assign({ backend: 'AndroidEmulatorBackend' }, r || { ok: !!r });
  }

  async stop(ctx = {}) {
    if (this.backendEngine && typeof this.backendEngine.stop === 'function') {
      const stopped = await this.backendEngine.stop({ cancelSignal: ctx.signal });
      if (!(stopped === true || stopped && stopped.ok === true)) {
        return { ok: false, error: stopped && stopped.error || '未能确认运行时已停止' };
      }
    } else {
      return { ok: false, error: '无法确认内置运行时归属及停止能力' };
    }
    if (await this.getRunningState()) return { ok: false, error: '内置运行时仍在运行' };
    return { ok: true };
  }

  async restart(ctx = {}) {
    const result = await this.stop(ctx);
    if (!result.ok) return result;
    if (ctx.signal && ctx.signal.aborted) return { ok: false, code: 'START_CANCELLED', error: '系统启动已取消' };
    return this.start(ctx);
  }
}

module.exports = { EmulatorProvider, FLAVOR_BY_ID };

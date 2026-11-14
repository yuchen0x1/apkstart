'use strict';
/**
 * 应用窗口：一个正在运行的安卓应用 = 一个干净的 Windows 窗口。
 *
 * 窗口里只有顶部一条 38px 的标题栏（旋转 / 最小化 / 最大化 / 关闭），
 * 下面的整块画面是嵌进来的模拟器窗口（SetParent），所以看不到安卓桌面、
 * 看不到模拟器自带的侧边工具栏，也不会多出第二个任务栏图标。
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const platform = require('./platform');

const TITLEBAR_H = 38;
/**
 * 模拟器窗口四周自带 8px 的灰色内边距（Qt 的边框留白），
 * 而真正的 LCD 画面是从 +8px 开始的。把子窗口整体放大 16px 并向左上偏移 8px，
 * 这圈灰边就正好被推到客户区外面，画面干净地贴满四周。
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // 全局鼠标钩子只在「应用窗口前台 + 至少一项映射开启」时安装。
    // pointerConfig 传函数：设置页改了开关，下一次 focus 就生效，不用重启。
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /**
   * 竖屏 / 横屏下窗口内容的目标尺寸（自动缩放到屏幕内）。
   *
   * `box` 是模拟器 LCD 的尺寸：横屏应用会以 1920x1080 起模拟器，此时 box 本身就是
   * 横的，再按 landscape 交换宽高会把画面塞回竖框（两侧黑边 + 点击错位）。
   * 所以只有「竖屏 LCD 想横过来用」才交换。
   */
  static sizeFor(area, box, landscape) {
    const p = box || { w: 540, h: 960 };
    // 留足边距：标题栏 38 + 上下各 24，左右各 40
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const swap = !!landscape && p.w < p.h;
    const k = swap
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((swap ? p.h : p.w) * k);
    const h = Math.round((swap ? p.w : p.h) * k);
    // 双保险：绝不超过屏幕可用区，否则会被系统裁掉，看起来就是「有黑边 / 没填满」
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  /** 当前 LCD 是不是横的（决定窗口比例与旋转按钮是否还有意义） */
  get lcdLandscape() {
    return !!(this.lcd && this.lcd.w > this.lcd.h);
  }

  /**
   * 换一个 LCD 比例（不重开窗口，只改大小并居中）。
   * 用在「用户拒绝为横屏应用重启运行时」：窗口得跟着回到当前 LCD 的比例，
   * 否则就是横窗口套竖画面，比修之前更难看。
   */
  applyBox(box) {
    if (!this.isOpen || !box || !box.w || !box.h) return;
    this.lcd = { w: box.w, h: box.h };
    this.portrait = { w: box.w, h: box.h };
    const wasMax = this.win.isMaximized();
    if (wasMax) this.win.unmaximize();
    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    this.win.setContentSize(Math.max(320, size.w), Math.max(420, size.h + TITLEBAR_H));
    const b = this.win.getBounds();
    this.win.setPosition(
      Math.round(area.x + (area.w - b.width) / 2),
      Math.round(area.y + (area.h - b.height) / 2),
    );
    if (wasMax) this.win.maximize();
    this.state.landscape = this.lcdLandscape;
    this._push();
    this.scheduleFit();
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * 打开（或复用）应用窗口。
   * @param {object} o { pkg, label, iconPath, lcd, fullscreen, onClosed }
   *   lcd 是模拟器 LCD 尺寸（横屏应用为 1920x1080），窗口按它定比例。
   */
  open(o) {
    const { pkg, label, iconPath, lcd, fullscreen } = o;
    // 保留外部（main）通过 onWindowClosed() 注册的回调：open 可能被反复调用
    this._closedCb = o.onClosed || this._closedCb;
    if (this.isOpen && this.pkg === pkg) {
      this.win.show();
      this.win.focus();
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    this.lcd = lcd || null;
    this.portrait = (lcd && lcd.w && lcd.h) ? { w: lcd.w, h: lcd.h } : { w: 540, h: 960 };
    this.state = {
      label: label || '应用',
      tip: '正在启动安卓运行时…',
      ready: false,
      landscape: this.lcdLandscape,
    };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // 渲染进程只通过 preload 暴露的白名单接口与主进程通信，不需要 Node，
        // 开启沙箱后即使页面被注入脚本也拿不到进程能力。
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // 页面标题会把窗口标题改成 shell.html 的 <title>，任务栏就认不出是哪个应用了，
    // 这里挡住，让 OS 标题一直等于应用名（任务栏悬浮提示、Alt+Tab 都靠它）。
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* 窗口可能已销毁 */ }
    });
    this.win.once('ready-to-show', () => {
      this.win.show();
      this._push();
    });
    // 同主窗口的兜底：首帧事件收不到时不能让用户对着「没反应」猜。
    setTimeout(() => {
      try {
        if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) {
          this.win.show();
          this._push();
        }
      } catch (_) { /* 窗口可能已关 */ }
    }, 3000).unref?.();

    const refit = () => this.scheduleFit();
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit();
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    // 关闭统一收口到 close()：它先 agent.park() 把模拟器窗口从宿主上摘下来藏好，
    // 再销毁宿主。少了这一步，Windows 会连带销毁嵌入的 Qt 子窗口（qemu 还在跑），
    // 之后任何应用再打开都拿不到句柄 —— 日志是 `embed failed: emu=0`、窗口全黑，
    // 只能重启 ApkStart 才恢复（上游 issue #42，实测复现）。
    // 点 × / Alt+F4 / 任务栏关闭 / 系统关机 都走这条。
    this.win.on('close', (e) => {
      if (this._selfClose) return;          // close() 自己收尾时放行
      if (this._closing) return;            // 已经在收尾（park 还没回来）：放行，别卡住用户
      e.preventDefault();
      this._closing = true;
      this.close({ keepApp: false });
    });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() 自己在 park 完成后收尾
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      // 只有「宿主被别的东西直接销毁」才会走到这里（应用退出、系统关机）。
      // 普通关窗已经在 close 事件里 preventDefault 转给 close()，不会重复收尾。
      try { if (this.agent) this.agent.park().catch(() => {}); } catch (_) { /* ignore */ }
      if (this._onCloseApp) { try { this._onCloseApp(pkg); } catch (_) { /* ignore */ } }
      if (this._closedCb) this._closedCb(pkg);
      if (this._windowClosedCb) { try { this._windowClosedCb(pkg); } catch (_) { /* ignore */ } }
    });
    // 只在「应用窗口真正处于前台」且至少一项鼠标映射开启时装全局钩子；
    // 失焦/关闭立即卸载，绝不让 ApkStart 在后台拖慢整个系统的鼠标。
    this.win.on('focus', () => {
      this._syncHook(true);
      // Electron 窗口重新获得焦点时，Qt 子窗口可能还停留在被遮挡后的黑帧；
      // 只做无激活重排/重绘，不抢回焦点，也不把鼠标事件发给模拟器。
      this.agent.refresh?.().catch(() => {});
    });
    this.win.on('blur', () => {
      this._syncHook(false);
      // 失焦本身不应触发任何前台切换；延迟一次无激活刷新，给 DWM 一个
      // 处理遮挡变化的机会，避免用户点击其它窗口后留下黑帧。
      setTimeout(() => {
        if (this.isOpen) this.agent.refresh?.().catch(() => {});
      }, 80).unref?.();
    });

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    const on = !!active && opts.enabled;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** 设置页改了鼠标映射：按当前焦点重新同步一次（不重装钩子线程） */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // 窗口没在前台：只卸载，别让钩子在后台空转
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* 窗口可能刚关闭 */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * 把模拟器窗口嵌进当前窗口，并铺满标题栏以下的区域。
   * 常驻压制不关闭：它会跳过「已经嵌进我们窗口」的那一个，其余窗口（含 qemu /
   * netsimd 的控制台黑窗）继续压住 —— 关了反而会给它们再露一次脸的机会。
   * 模拟器窗口偶尔还没创建好（快照恢复太快的机器上），这里重试两次。
   */
  async embed() {
    if (!this.isOpen) return false;
    // 非 Windows / 没有原生代理：嵌入这条路根本不存在。
    // 以前这里照样进 4 次重试，每次都要等一条 6 秒的 TCP 超时，用户看到的是
    // 「启动卡很久 → 黑屏 → 没有任何提示」。现在直接置 external：画面留在
    // 模拟器自己的窗口里，应用窗口只显示一句说明（upstream #24）。
    if (!platform.canEmbed || !this.agent || this.agent.available === false) {
      this.external = true;
      this.lastEmbedError = platform.canEmbed ? 'no-native-agent' : 'platform-cannot-embed';
      this.lastEmbedFollow = false;
      return false;
    }
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect()).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) {
        // SetParent 被 DPI 不一致拒绝时代理会降级为「窗口跟随」并置 follow=true
        this.lastEmbedFollow = !!r.follow;
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // 把失败原因带出去：上层会写进 app.log，出问题时一眼能看出是「没找到模拟器窗口」
    // 还是「SetParent 失败」，不用再靠猜。
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    this.lastEmbedFollow = false;
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    // 外部窗口模式：画面不在我们窗口里，贴合没有任何意义（也不该调代理）
    if (this.external) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /** 模拟器子窗口应该占据的矩形（物理像素，已把 8px 内边距推出可视区） */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    return {
      x: -EMU_PAD,
      y: Math.round(TITLEBAR_H * sf) - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
    };
  }

  scheduleFit() {
    if (!this.isOpen) return;
    if (this._fitTimer) return;
    this._fitTimer = setTimeout(() => {
      this._fitTimer = null;
      this.fitNow();
    }, 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * 横竖屏切换 = 切换「手机排版 / 平板排版」。
   *
   * 关键：**不再去转模拟器的画面**。以前这里先改 wm size、再让 agent 发 Ctrl+←，
   * 模拟器会把整块画面顺时针/逆时针转 90°，而安卓侧的排版并没有跟着变 ——
   * 用户看到的就是「画面整个躺倒、还摆不正」。
   * 现在只做一件事：改逻辑显示尺寸（wm size）+ 锁 user-rotation=0，
   * 安卓会按新宽度重新排版：360dp 宽是手机，640dp 宽自动进平板/分栏布局。
   */
  async rotate({ fullscreen = null } = {}) {
    if (!this.isOpen) return this.state.landscape;
    // 横屏 LCD：窗口比例就是 LCD 的比例，「把窗口转成横的」已经没意义了。
    // 继续按 wm size 切排版只会让画面在窗口里留边，所以这里直接不做事。
    if (this.lcdLandscape) return this.state.landscape;
    const next = !this.state.landscape;
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    // wm size 会触发全局配置变更，应用要重建一次界面，给足时间再贴窗口
    await sleep(1200);
    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, next);
    // 最大化状态下 setContentSize 无效，必须先退出最大化再改尺寸，
    // 否则窗口仍是竖的，横屏画面被塞进竖窗口 = 黑边 / 未填满。
    //
    // 但「全屏 → 横屏」这条路径上窗口本来就该是最大化的：maximize() 在 Windows 上是
    // 异步的，紧接着调 isMaximized() 可能还是 false，所以这里不接受调用方猜，
    // 由 fullscreen 参数显式指定（null = 沿用当前状态，即标题栏旋转按钮那条路）。
    const wantMax = fullscreen === null ? this.win.isMaximized() : !!fullscreen;
    if (this.win.isMaximized()) this.win.unmaximize();
    this.win.setContentSize(Math.max(320, size.w), Math.max(420, size.h + TITLEBAR_H));
    const b = this.win.getBounds();
    this.win.setPosition(
      Math.round(area.x + (area.w - b.width) / 2),
      Math.round(area.y + (area.h - b.height) / 2),
    );
    // 该是全屏就恢复最大化：否则设置里写着「全屏」，窗口却变成一个居中的小窗
    if (wantMax) this.win.maximize();
    // 改尺寸 / 退出最大化后把窗口抬到最前，别被别的窗口盖住（盖住就是黑屏 / 点不动）
    try { this.win.show(); this.win.focus(); } catch (_) { /* 窗口可能刚关 */ }
    this.state.landscape = next;
    this._push();
    // wm size 改了 guest framebuffer 尺寸后，Qt 会自己重排好几次；每次都可能把
    // 嵌入窗口带回旧尺寸，露出黑边 / 画面没填满。连续贴合几轮收敛，之后由
    // resize 事件的 scheduleFit 兜底。
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
      // eslint-disable-next-line no-await-in-loop
      await this.fitNow();
    }
    return next;
  }

  /** 需要时切到指定方向（全屏=横屏，窗口=竖屏） */
  async setLandscape(want, opts = {}) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate(opts);
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * 关闭窗口。默认同时停掉这个安卓应用（省内存），但保留引擎，下次点开是秒开。
   *
   * 顺序很重要：必须先把模拟器窗口从宿主窗口上「摘下并藏好」，再销毁宿主。
   * 反过来的话 Windows 会把跨进程的子窗口重新挂到桌面、并保持它原来的可见状态，
   * 用户桌面上就会凭空多出一个 "Android Emulator - apkstart5554" 的黑窗。
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
      if (this._windowClosedCb) { try { this._windowClosedCb(pkg); } catch (_) { /* ignore */ } }
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }

  /** 应用窗口关闭（任何路径）后的回调 —— 自动更新的「关窗后安装」钩子用 */
  onWindowClosed(cb) { this._windowClosedCb = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };

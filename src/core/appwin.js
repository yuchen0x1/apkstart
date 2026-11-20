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
const store = require('./store');

const TITLEBAR_H = 38;
/**
 * 模拟器窗口四周自带 8px 的灰色内边距（Qt 的边框留白），
 * 而真正的 LCD 画面是从 +8px 开始的。把子窗口整体放大 16px 并向左上偏移 8px，
 * 这圈灰边就正好被推到客户区外面，画面干净地贴满四周。
 */
const EMU_PAD = 8;
const CLOSE_PARK_TIMEOUT_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bestEffort(fn) {
  try { Promise.resolve(fn()).catch(() => {}); } catch (_) { /* ignore */ }
}
// 宿主侧画面亮度低于这个值（连续多次）就算黑帧。0.6.7 删掉检测后
// 「嵌入成功但一片黑」会被当成启动成功，用户完全不知道发生了什么。
const BLACK_MEAN = Number(process.env.APKSTART_BLACK_MEAN || 40);

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
    this._pendingCloses = new Set();
    this._pendingParks = new Set();
    this._agentTail = new WeakMap();
    this._parkEpoch = 0;
    this._windowGeneration = 0;
    this._closeAllPromise = null;
    // 模拟器窗口已成功嵌入本窗口。显示类事件（show/restore）靠它决定
    // 是否要顺带把被 minimize→agent.hide() 藏掉的模拟器窗口重新亮出来。
    this._embedded = false;
    // 嵌入后检测到宿主画黑帧、已自动摘成独立窗口（上层据此给出明确提示）
    this.blackDetached = false;
    // 当前就用独立窗口显示（没有嵌入宿主）。上层据此决定是否还需要 fit / embed。
    this.standaloneActive = false;
    // 宿主窗口被刻意隐藏（独立窗口模式下不该让用户看到一块黑壳）
    this._hidden = false;
    // 兼容旧日志字段：跟随模式已移除，这些值恒为 false，仅避免上层读取到 undefined
    this.lastEmbedFollow = false;
    this.lastEmbedFollowReason = '';
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  _isCurrent(win, generation) {
    return !!win && this.win === win && this._windowGeneration === generation && !win.isDestroyed();
  }

  // embed/detach/park 都改变同一代理的原生窗口归属，park 又不带 HWND。
  // 关窗把 park 排在旧操作之后、下一窗口接管之前，而不是等旧回包再补发全局 park。
  _queueOwnership(agent, action) {
    const previous = this._agentTail.get(agent);
    const epoch = this._parkEpoch;
    let start;
    const operation = new Promise((resolve, reject) => {
      start = () => {
        // 批量关闭到期后，旧队列里尚未发送的 embed/detach/park 一律作废。
        if (epoch !== this._parkEpoch) { resolve(null); return; }
        try { resolve(action()); } catch (err) { reject(err); }
      };
    });
    this._agentTail.set(agent, operation);
    const clear = () => {
      if (this._agentTail.get(agent) === operation) this._agentTail.delete(agent);
    };
    operation.then(clear, clear);
    if (previous) previous.then(start, start);
    else start();
    return operation;
  }

  _queueWindowCommand(action, win = this.win, generation = this._windowGeneration) {
    const agent = this.agent;
    if (!agent || !this._isCurrent(win, generation)) return Promise.resolve(null);
    return this._queueOwnership(agent, () => {
      if (!this._isCurrent(win, generation) || this.agent !== agent) return null;
      return action(agent);
    });
  }

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
    // 批量关闭一旦开始，不准关窗回调在其期限内再创建宿主。
    if (this._closeAllPromise) return null;
    const { pkg, label, iconPath, lcd, fullscreen, hidden } = o;
    if (this.isOpen && this.pkg === pkg) {
      this._closedCb = o.onClosed || this._closedCb;
      // 独立窗口模式：用户再点一次这个应用，该把模拟器窗口抬到前面，
      // 而不是把藏着黑壳的宿主窗口弹出来。
      if (this.standaloneActive) {
        this.revealStandalone().catch(() => {});
        return this.win;
      }
      this.win.show();
      this.win.focus();
      this._revealEmbedded();
      return this.win;
    }
    this.close({ keepApp: true });
    const generation = ++this._windowGeneration;

    this.pkg = pkg;
    this._closedCb = o.onClosed || null;
    // 独立窗口模式：宿主窗口只作为「这个应用还开着」的状态载体，不显示出来。
    // 用户要看的是模拟器自己的窗口，不是一块永远连不上画面的黑壳。
    this._hidden = !!hidden;
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
        additionalArguments: ['--apkstart-role=shell'],
        contextIsolation: true,
        nodeIntegration: false,
        // 渲染进程只通过 preload 暴露的白名单接口与主进程通信，不需要 Node，
        // 开启沙箱后即使页面被注入脚本也拿不到进程能力。
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    const win = this.win;
    const isCurrent = () => this._isCurrent(win, generation);
    win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // 页面标题会把窗口标题改成 shell.html 的 <title>，任务栏就认不出是哪个应用了，
    // 这里挡住，让 OS 标题一直等于应用名（任务栏悬浮提示、Alt+Tab 都靠它）。
    win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      if (isCurrent()) bestEffort(() => win.setTitle(label || 'ApkStart'));
    });
    win.once('ready-to-show', () => {
      if (!isCurrent()) return;
      if (!this._hidden) win.show();
      this._push();
    });
    // 同主窗口的兜底：首帧事件收不到时不能让用户对着「没反应」猜。
    const showTimer = setTimeout(() => {
      try {
        if (isCurrent() && !this._hidden && !win.isVisible()) {
          win.show();
          this._push();
        }
      } catch (_) { /* 窗口可能已关 */ }
    }, 3000);
    showTimer.unref?.();

    // Electron 的窗口动画 / DPI 重算分几步才稳定（上游实测）：单次 40ms 防抖
    // 常抓到中间态，画面只占左上角一条。连续贴合 6 轮，每轮取最新 bounds。
    const refit = () => { if (isCurrent()) this.scheduleFit(6); };
    win.on('resize', refit);
    win.on('move', refit);
    win.on('maximize', refit);
    win.on('unmaximize', refit);
    win.on('restore', () => {
      if (!isCurrent()) return;
      this._queueWindowCommand(agent => agent.show(), win, generation).catch(() => {});
      this.scheduleFit(6);
    });
    win.on('minimize', () => {
      if (isCurrent()) this._queueWindowCommand(agent => agent.hide(), win, generation).catch(() => {});
    });
    // 程序化 show() 不触发 restore；已嵌入的模拟器也要从隐藏状态恢复。
    win.on('show', () => { if (isCurrent()) this._revealEmbedded(); });
    // 原生 close（× / Alt+F4 / 重复退出）都拦下，由 park 完成后的 destroy() 收尾。
    // 已替换的旧窗口仍能收到 close，但不能借此关闭当前的新窗口。
    win.on('close', (e) => {
      e.preventDefault();
      if (this.win === win) this.close();
    });
    win.once('closed', () => {
      clearTimeout(showTimer);
      // 外部直接 destroy() 时走同一收尾；本类发出的 destroy() 不会再进入关闭流程。
      if (this.win === win) this.close();
    });
    // 只在「应用窗口真正处于前台」且至少一项鼠标映射开启时装全局钩子；
    // 失焦/关闭立即卸载，绝不让 ApkStart 在后台拖慢整个系统的鼠标。
    win.on('focus', () => {
      if (!isCurrent()) return;
      this._syncHook(true);
      // 无激活重绘，不抢回焦点，也不把鼠标事件发给模拟器。
      this._queueWindowCommand(agent => agent.refresh?.(), win, generation).catch(() => {});
      this._revealEmbedded();
    });
    win.on('blur', () => {
      if (!isCurrent()) return;
      this._syncHook(false);
      // 给 DWM 处理遮挡变化的机会，但不能刷新已替换的新窗口。
      setTimeout(() => {
        if (isCurrent()) this._queueWindowCommand(agent => agent.refresh?.(), win, generation).catch(() => {});
      }, 80).unref?.();
    });

    if (fullscreen) win.maximize();
    return win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // 游戏/低延迟模式下完全不装全局鼠标钩子：WH_MOUSE_LL 对桌面每个鼠标事件
    // 都要同步回调一次，会明显增加指针延迟（上游 b8771d0）。
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
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
  /** 窗口重新可见时，把被藏起来的模拟器窗口重新亮出来（只对已嵌入状态生效） */
  _revealEmbedded() {
    if (!this._embedded || !this.isOpen) return;
    this._queueWindowCommand(agent => agent.show()).catch(() => {});
    this.scheduleFit();
  }

  /** 宿主侧模拟器窗口的平均亮度；抓不到返回 null（绝不能据此误判成黑屏） */
  async _frameBrightness() {
    try {
      const r = await this._queueWindowCommand(agent => agent.pixmean());
      if (!r || r.ok === false) return null;
      const v = Number(r.mean);
      return Number.isFinite(v) && v >= 0 ? v : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 嵌入成功后确认宿主真的在画画面。
   * 现场：SetParent 成功、窗口尺寸正确、adb screencap 也有内容，
   * 但 Qt/GL 的交换链在嵌入后死掉，窗口纯黑。连续多次采样都黑才动手，
   * 中间做一次无害重绘；仍黑就把窗口摘成独立窗口，让用户看得见、点得到。
   */
  async _looksBlackAfterEmbed(isCurrent = () => this.isOpen) {
    // 首帧可能还没到，先给它一点时间
    await sleep(600);
    if (!isCurrent()) return false;
    // 5 次跨越约 3 秒：应用刚启动时常挂着全黑启动图，只看一眼就摘窗口会误伤好机器。
    // 只要有一次测到画面就立即收工；中间做一次重绘，顺手救回失焦导致的黑帧。
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const mean = await this._frameBrightness();
      if (!isCurrent()) return false;
      this.lastEmbedMean = mean;
      if (mean === null || mean >= BLACK_MEAN) return false;
      if (i === 1) {
        // eslint-disable-next-line no-await-in-loop
        await this._queueWindowCommand(agent => agent.refresh()).catch(() => {});
        if (!isCurrent()) return false;
      }
      // eslint-disable-next-line no-await-in-loop
      if (i < 4) {
        await sleep(700);
        if (!isCurrent()) return false;
      }
    }
    this.lastBlackMean = this.lastEmbedMean;
    return true;
  }

  async embed() {
    const win = this.win;
    const generation = this._windowGeneration;
    const agent = this.agent;
    const isCurrent = () => this._isCurrent(win, generation) && this.agent === agent;
    if (!isCurrent()) return false;
    // 非 Windows / 没有原生代理：嵌入这条路根本不存在。
    // 以前这里照样进 4 次重试，每次都要等一条 6 秒的 TCP 超时，用户看到的是
    // 「启动卡很久 → 黑屏 → 没有任何提示」。现在直接置 external：画面留在
    // 模拟器自己的窗口里，应用窗口只显示一句说明（upstream #24）。
    if (!platform.canEmbed || !agent || agent.available === false) {
      this.external = true;
      this.lastEmbedError = platform.canEmbed ? 'no-native-agent' : 'platform-cannot-embed';
      return false;
    }
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!isCurrent()) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await this._queueOwnership(agent, () => {
        // 排队等待交接期间，宿主可能又被关闭或替换。
        if (!isCurrent()) return null;
        const hwnd = this._hwnd();
        return hwnd ? agent.embed(hwnd, this._rect()) : null;
      }).catch((e) => ({ ok: false, error: e.message }));
      if (!isCurrent() || !r) return false;
      last = r;
      // 对齐上游：嵌入成功就是成功。黑画面不要在这里用「跟随模式」掩盖 ——
      // 真因是 chrome 渲染层尺寸 / 面板尺寸，由 agent 的 Fit 与 -skin 负责。
      if (r && r.ok) {
        this._embedded = true;
        this.blackDetached = false;
        this.standaloneActive = false;
        // 之前是独立窗口模式（窗口被藏起来了）：现在嵌成了，得让宿主露出来
        if (this._hidden) {
          this._hidden = false;
          try { win.show(); } catch (_) { /* 窗口可能刚关 */ }
        }
        // eslint-disable-next-line no-await-in-loop
        const black = await this._looksBlackAfterEmbed(isCurrent);
        if (!isCurrent()) return false;
        if (black) {
          // 刷新也救不回来：摘成独立窗口。画面还在，只是不能嵌进应用里。
          // eslint-disable-next-line no-await-in-loop
          await this._queueOwnership(agent, () => isCurrent() && agent.detach()).catch(() => {});
          if (!isCurrent()) return false;
          this._embedded = false;
          this.blackDetached = true;
          this.lastEmbedError = 'black-frame-detached';
          return false;
        }
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    if (!isCurrent()) return false;
    // 把失败原因带出去：上层会写进 app.log，出问题时一眼能看出是「没找到模拟器窗口」
    // 还是「SetParent 失败」，不用再靠猜。
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    this._embedded = false;
    return false;
  }

  /**
   * 直接把画面放到模拟器自己的窗口里，完全不碰 SetParent。
   *
   * 为什么需要这条路：在软件渲染 / 无硬件加速的机器上，嵌进宿主后 Qt 的
   * 交换链会失效 —— 安卓侧画得好好的，宿主窗口却是一块黑底。旧逻辑是
   * 「先嵌 → 采样发现黑 → 再摘成独立窗口」，用户每次启动都要先对着黑屏
   * 等三秒，还以为是程序卡死了。这里一步到位：打开应用就把模拟器窗口
   * 亮出来并抢到前台。
   */
  async standalone() {
    const win = this.win;
    const generation = this._windowGeneration;
    const agent = this.agent;
    const isCurrent = () => this._isCurrent(win, generation) && this.agent === agent;
    if (!isCurrent()) return false;
    if (!agent || agent.available === false) {
      this.external = true;
      this.lastEmbedError = 'no-native-agent';
      return false;
    }
    const r = await this._queueOwnership(agent, () => isCurrent() && agent.detach())
      .catch((e) => ({ ok: false, error: e.message }));
    if (!isCurrent()) return false;
    if (!r || !r.ok) {
      // 代理说找不到模拟器窗口：这已经不是「显示方式」的问题，
      // 而是 qemu 活着但 Qt 画面窗口没了（上层会走重启运行时的恢复流程）。
      this.lastEmbedError = (r && r.error) || 'emu-window-missing';
      return false;
    }
    this._embedded = false;
    this.blackDetached = true;
    this.standaloneActive = true;
    // 宿主窗口只留作状态载体，不能挡在画面前面
    this._hidden = true;
    try { win.hide(); } catch (_) { /* 窗口可能刚关 */ }
    return true;
  }

  /** 独立窗口模式下把模拟器窗口重新亮出来并置前（从主界面再点一次应用时用）。 */
  async revealStandalone() {
    const win = this.win;
    const generation = this._windowGeneration;
    const agent = this.agent;
    const isCurrent = () => this._isCurrent(win, generation) && this.agent === agent && this.standaloneActive;
    if (!agent || !isCurrent()) return false;
    const r = await this._queueOwnership(agent, () => isCurrent() && agent.detach()).catch(() => null);
    return isCurrent() && !!(r && r.ok);
  }

  async fitNow() {
    if (!this.isOpen) return;
    // 外部窗口模式：画面不在我们窗口里，贴合没有任何意义（也不该调代理）
    if (this.external) return;
    await this._queueWindowCommand(agent => agent.fit(this._rect())).catch(() => {});
  }

  /** 模拟器子窗口应该占据的矩形（物理像素，已把 8px 内边距推出可视区） */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // 上方溢出的 8px 会压到标题栏上，交给窗口代理裁掉（agent.fit 的 clipTop）
      clipTop: EMU_PAD,
    };
  }

  /** 连续贴合几轮（窗口动画 / DPI 重算会分几步才稳定） */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    const win = this.win;
    clearTimeout(this._fitTimer);
    const schedule = (left, delay) => {
      const timer = setTimeout(async () => {
        if (this.win !== win || this._fitTimer !== timer) return;
        await this.fitNow().catch(() => {});
        // 在途 fit 的回包不能覆盖新窗口或新一轮 resize 的计时器。
        if (this.win !== win || this._fitTimer !== timer) return;
        this._fitTimer = null;
        if (left > 1) schedule(left - 1, 160);
      }, delay);
      this._fitTimer = timer;
    };
    schedule(Math.max(1, rounds), 40);
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
    const win = this.win;
    const generation = this._windowGeneration;
    const isCurrent = () => this._isCurrent(win, generation);
    // 横屏 LCD：窗口比例就是 LCD 的比例，「把窗口转成横的」已经没意义了。
    // 继续按 wm size 切排版只会让画面在窗口里留边，所以这里直接不做事。
    if (this.lcdLandscape) return this.state.landscape;
    const next = !this.state.landscape;
    if (this.setOrientation) {
      try {
        if (await this.setOrientation(next) === false) return false;
      } catch (_) { return false; }
    }
    if (!isCurrent()) return false;
    // wm size 会触发全局配置变更，应用要重建一次界面，给足时间再贴窗口
    await sleep(1200);
    if (!isCurrent()) return false;
    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, next);
    // 最大化状态下 setContentSize 无效，必须先退出最大化再改尺寸，
    // 否则窗口仍是竖的，横屏画面被塞进竖窗口 = 黑边 / 未填满。
    //
    // 但「全屏 → 横屏」这条路径上窗口本来就该是最大化的：maximize() 在 Windows 上是
    // 异步的，紧接着调 isMaximized() 可能还是 false，所以这里不接受调用方猜，
    // 由 fullscreen 参数显式指定（null = 沿用当前状态，即标题栏旋转按钮那条路）。
    const wantMax = fullscreen === null ? win.isMaximized() : !!fullscreen;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(Math.max(320, size.w), Math.max(420, size.h + TITLEBAR_H));
    const b = win.getBounds();
    win.setPosition(
      Math.round(area.x + (area.w - b.width) / 2),
      Math.round(area.y + (area.h - b.height) / 2),
    );
    // 该是全屏就恢复最大化：否则设置里写着「全屏」，窗口却变成一个居中的小窗
    if (wantMax) win.maximize();
    // 改尺寸 / 退出最大化后把窗口抬到最前，别被别的窗口盖住（盖住就是黑屏 / 点不动）
    try { win.show(); win.focus(); } catch (_) { /* 窗口可能刚关 */ }
    if (!isCurrent()) return false;
    this.state.landscape = next;
    this._push();
    // wm size 改了 guest framebuffer 尺寸后，Qt 会自己重排好几次；每次都可能把
    // 嵌入窗口带回旧尺寸，露出黑边 / 画面没填满。连续贴合几轮收敛，之后由
    // resize 事件的 scheduleFit 兜底。
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(500);
      if (!isCurrent()) return false;
      // eslint-disable-next-line no-await-in-loop
      await this.fitNow();
    }
    return isCurrent() && next;
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
    const win = this.win;
    if (!win) return [...this._pendingCloses].at(-1) || Promise.resolve();
    const pkg = this.pkg;
    const onClosed = this._closedCb;
    const onWindowClosed = this._windowClosedCb;
    let resolveClose;
    const closing = new Promise(resolve => { resolveClose = resolve; });
    // 先登记再调用代理/回调：重入者复用同一个 Promise，且不能改写本次 keepApp。
    this._pendingCloses.add(closing);
    this.win = null;
    this._windowGeneration += 1;
    this.pkg = null;
    this._closedCb = null;
    this._embedded = false;
    this.blackDetached = false;
    this.standaloneActive = false;
    this._hidden = false;
    clearTimeout(this._fitTimer);
    this._fitTimer = null;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(parkTimer);
      bestEffort(() => { if (!win.isDestroyed()) win.destroy(); });
      bestEffort(() => onClosed?.(pkg));
      bestEffort(() => onWindowClosed?.(pkg));
      this._pendingCloses.delete(closing);
      resolveClose();
    };
    const parkTimer = setTimeout(finish, CLOSE_PARK_TIMEOUT_MS);
    const agent = this.agent;
    const epoch = this._parkEpoch;
    bestEffort(() => this._syncHook(false));
    const park = agent && agent.available !== false
      ? this._queueOwnership(agent, () => {
        if (this._parkEpoch !== epoch || this.agent !== agent) return null;
        // 即使宿主已到销毁期限，交接前仍须停靠；只有批次超时才作废未发出的 park。
        return agent.park(0);
      }).then(reply => reply?.ok === true, () => false)
      : Promise.resolve(true);
    this._pendingParks.add(park);
    park.then(confirmed => {
      // 失败回包也要保留给 closeAll 汇总，不能因单窗已销毁而误报已停靠。
      if (confirmed) this._pendingParks.delete(park);
      finish();
    });
    if (!keepApp && pkg) bestEffort(() => this._onCloseApp?.(pkg, win));
    return closing;
  }

  /** 关闭所有宿主；在批次期限内未确认停靠则返回 false。 */
  closeAll({ keepApp = false } = {}) {
    if (this._closeAllPromise) return this._closeAllPromise;
    this._closeAllPromise = Promise.resolve().then(async () => {
      let deadline;
      const parks = [...this._pendingParks];
      try {
        // 批次期间 open 被拦截；park 覆盖它之前的原生归属变更。不能无限等待
        // 在途 embed/detach 的回包，也不用等过期的黑帧采样、重试等 JS 任务。
        const drained = Promise.all([
          Promise.all(parks).then(acks => acks.every(Boolean)),
          Promise.all([...this._pendingCloses]),
        ]).then(([confirmed]) => confirmed);
        const cutoff = new Promise(resolve => {
          deadline = setTimeout(() => {
            this._parkEpoch += 1;
            this._pendingParks.clear();
            // 已发送的命令不能撤销，但同一 socket 原生执行为 FIFO。新队列可在
            // 它们之后接管，不再被旧回包阻塞；旧队列醒来也不会补发全局 park。
            this._agentTail = new WeakMap();
            resolve(false);
          }, CLOSE_PARK_TIMEOUT_MS);
        });
        return await Promise.race([drained, cutoff]);
      } finally {
        clearTimeout(deadline);
        for (const park of parks) this._pendingParks.delete(park);
        this._closeAllPromise = null;
      }
    });
    // 在回调可能重入之前登记批次，但同步开始关闭当前窗口。
    if (this.win) this.close({ keepApp });
    return this._closeAllPromise;
  }

  onCloseApp(cb) { this._onCloseApp = cb; }

  /** 应用窗口关闭（任何路径）后的回调 —— 自动更新的「关窗后安装」钩子用 */
  onWindowClosed(cb) { this._windowClosedCb = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };

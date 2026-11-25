'use strict';
/** 双主题真实 Chromium 渲染回归。后端全部内存化，不加载产品 main，不操作 Android。 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFixture } = require('./lib/ui-fixtures');
const { contrastProbe } = require('./lib/ui-probes');
const { runInteractions } = require('./lib/ui-interactions');
const { scriptValue } = require('./lib/renderer-script');
const phase = process.env.UI_AUDIT_PHASE || 'after';
const out = process.env.UI_AUDIT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-ui-audit-'));
fs.mkdirSync(path.join(out, phase), { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-ui-profile-'));
app.setPath('userData', profile);
const interactive = process.env.UI_AUDIT_INTERACTIVE === '1';
const SRC = process.env.UI_AUDIT_SRC ? path.resolve(process.env.UI_AUDIT_SRC) : path.join(__dirname, '..', 'src');
const nativeColors = require('../src/core/theme');
const fixture = createFixture();
const results = { phase, out, screens: [], errors: [], checks: [] };
let currentStage = 'startup';
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ': ' + JSON.stringify(detail) : ''}`);
};
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.whenReady().then(async () => {
  const sendTheme = () => {
    const dark = nativeTheme.shouldUseDarkColors;
    const state = { preference: nativeTheme.themeSource, resolved: dark ? 'dark' : 'light' };
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      if (interactive) nativeColors.updateWindow(window, dark, { overlay: process.platform === 'win32' });
      window.webContents.send('theme:changed', state);
    }
  };
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  for (const ch of new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map(m => m[1]))) {
    ipcMain.handle(ch, async (_e, payload) => {
      const value = await fixture.respond(ch, payload);
      if (ch === 'settings:set' && payload?.theme && value?.theme === payload.theme) {
        nativeTheme.themeSource = value.theme;
        sendTheme();
      }
      return value;
    });
  }
  nativeTheme.on('updated', sendTheme);
  const makeWindow = (role) => {
    const window = new BrowserWindow({ width: 1140, height: 740, useContentSize: true, show: false,
      ...(interactive ? { frame: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f8fa', symbolColor: '#20252d', height:44 } } : {}),
      webPreferences: {
        ...(role ? { preload: path.join(SRC, 'preload.js'), additionalArguments: [`--apkstart-role=${role}`] } : {}),
        sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: !interactive, backgroundThrottling: false, spellcheck: false,
      } });
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('console-message', ev => { if (ev.level === 'error') results.errors.push(ev.message); });
    window.webContents.on('preload-error', (_e, _file, err) => results.errors.push(String(err)));
    return window;
  };
  const mainWin = makeWindow('main');
  let win = mainWin;
  mainWin.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|devtools:)/.test(details.url) }));
  const js = code => win.webContents.executeJavaScript(code).catch((error) => {
    throw new Error(`${error.message}\nRenderer script: ${String(code).slice(0, 500)}`);
  });
  const settle = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const waitFor = expression => js(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const poll = () => {
      if (${expression}) return resolve(true);
      if (performance.now() > deadline) return reject(new Error('UI 条件等待超时：' + ${scriptValue(expression)}));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const shot = async (name, capture = true) => {
    currentStage = 'capture:' + name;
    await settle();
    if (capture) {
      for (let attempt = 0; ; attempt++) {
        try {
          fs.writeFileSync(path.join(out, phase, name + '.png'), (await win.webContents.capturePage()).toPNG());
          break;
        } catch (error) {
          // 离屏缩放时 Chromium 偶发丢帧，只重试无副作用的截图，不重放界面操作。
          if (attempt >= 3 || !String(error).includes('UnknownVizError')) throw error;
          const delay = 2000 * 2 ** attempt + Math.floor(Math.random() * 200);
          console.warn(`截图暂不可用，${delay}ms 后重试：${name}`);
          await new Promise(r => setTimeout(r, delay));
          await settle();
        }
      }
    }
    const metrics = await js(`(() => {
      const shown = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      const active = document.querySelector('#repairMask.on, #wizardMask.on, #settingsMask.on') || document.body;
      const panels = [...active.querySelectorAll('.modal, .set-body, .set-side, .sys-detail, .ctxmenu')].filter(shown);
      return { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme || 'none',
        devicePixelRatio, zoom: window.visualViewport?.scale || 1,
        background: getComputedStyle(document.body).backgroundColor,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        panelOverflow: panels.filter(e => {
          const r=e.getBoundingClientRect();
          const outer = e.matches('.modal,.set-body,.set-side,.ctxmenu');
          return r.left < -1 || r.right > innerWidth+1 || (outer && (r.top < -1 || r.bottom > innerHeight+1)) || e.scrollWidth > e.clientWidth + 1;
        }).map(e => e.className),
        panelMetrics: panels.map(e => { const r=e.getBoundingClientRect(); return {name:e.className,left:r.left,right:r.right,top:r.top,bottom:r.bottom,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}; }),
        unlabelled: [...active.querySelectorAll('input,select,textarea')].filter(shown).filter(e => !e.labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && e.type !== 'hidden').map(e => e.id),
      };
    })()`);
    const contrast = await js('(' + contrastProbe.toString() + ')()');
    results.screens.push({ name, ...metrics, contrast });
  };
  // 沿滚动正文逐屏取样，不把未出现在首屏的设置误记为已检测。
  const scanScrollable = async (name, selector) => {
    const size = await js(`(() => { const el=document.querySelector(${scriptValue(selector)}); return el ? {height:el.clientHeight,max:el.scrollHeight-el.clientHeight} : {height:0,max:0}; })()`);
    for (let top = Math.max(1, size.height * .85), page = 1; top < size.max; top += Math.max(1, size.height * .85), page++) {
      await js(`document.querySelector(${scriptValue(selector)}).scrollTop=${scriptValue(top)}`);
      await shot(`${name}-scroll${page}`, false);
    }
    if (size.max > 1) {
      await js(`document.querySelector(${scriptValue(selector)}).scrollTop=${scriptValue(size.max)}`);
      await shot(name + '-bottom', false);
    }
    await js(`(() => { const el=document.querySelector(${scriptValue(selector)}); if(el) el.scrollTop=0; })()`);
  };
  currentStage = 'load-main-ui';
  await win.loadFile(path.join(SRC, 'ui', 'index.html'));
  check('主界面按 main 角色注入沙箱白名单桥接', await js("typeof window.apkstart?.setSettings==='function' && typeof window.apkstart?.syncShared==='function' && typeof window.require==='undefined' && typeof window.process==='undefined'"));
  const requestedScale = Number(process.env.UI_AUDIT_SCALE || 0);
  if ([1,1.25,1.5,2].includes(requestedScale)) {
    // 离屏窗口可能忽略命令行 DPI 开关，显式模拟像素密度并验证，不能把未生效的参数算作通过。
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width:0, height:0, deviceScaleFactor:requestedScale, mobile:false,
    });
    const observed = await js('devicePixelRatio');
    results.displayScale = { requested:requestedScale, observed, simulated:true };
    check('模拟显示像素密度实际生效', Math.abs(observed-requestedScale)<.01, results.displayScale);
  }
  // 固定截图帧，避免把淡入的中间透明帧误当布局缺失；真实动效另作交互验证。
  if (!interactive) await win.webContents.insertCSS('* { animation: none !important; transition: none !important; scroll-behavior: auto !important; }');
  await js(`(async () => { await refreshApps(); await refreshStatus(); })()`);
  if (interactive) {
    win.showInactive();
    win.on('closed', () => app.quit());
    console.log('UI_DESKTOP_PID=' + process.pid);
    return;
  }
  await shot('initial');
  if (phase !== 'before') {
    await runInteractions({ win, fixture, check });
    currentStage = 'interaction-regressions';
    await js("openSettings({section:'general'})");
    await js("window.apkTheme.save('light')");
    fixture.setResponse('settings:set', () => { throw new Error('UI 测试：外观保存失败'); });
    await js("window.apkTheme.save('dark')");
    check('外观保存失败回滚实际主题、控件与忙碌状态并显示原因', await js("document.documentElement.dataset.theme==='light' && window.apkTheme.preference==='light' && document.getElementById('setTheme').value==='light' && !document.getElementById('setTheme').disabled && !document.getElementById('setTheme').hasAttribute('aria-busy') && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('外观保存失败'))"));
    fixture.clearResponse('settings:set');
    const changeLanguage = async value => {
      await js(`(() => { const select=document.getElementById('setLanguage'); select.value=${scriptValue(value)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await waitFor(`!languageBusy && window.apkI18n.lang===${scriptValue(value)}`);
      await settle();
    };
    let releaseAccel, accelRequested;
    const pendingAccel = new Promise(resolve => { accelRequested=resolve; });
    fixture.setResponse('provision:enableAccel', () => new Promise(resolve => { releaseAccel=resolve; accelRequested(); }));
    const accelStart = fixture.calls.length;
    await js("openSettingsSection('runtime'); document.getElementById('toastWrap').innerHTML=''; window.uiAccelStep=runStep('accel'); runStep('accel'); void 0");
    await pendingAccel;
    check('硬件加速步骤说明检查与启用、仅必要时授权，不声称正在安装驱动', fixture.calls.slice(accelStart).filter(c=>c.channel==='provision:enableAccel').length===1 && await js("state.setupBusy==='accel' && document.querySelector('#toastWrap .t-title-text').textContent==='正在检查并启用硬件加速…' && document.querySelector('#toastWrap .t-body').textContent==='仅在必要时请求系统授权，用于启动已有加速服务或启用 Windows 系统功能；不会自动安装第三方驱动。' && !document.getElementById('toastWrap').textContent.includes('正在安装硬件加速驱动') && !document.getElementById('toastWrap').textContent.includes('请在弹出的是否允许窗口点')"));
    await shot('accel-checking');
    await changeLanguage('en-US');
    check('硬件加速检查和按需授权提示使用对应英文事实表述', await js("document.querySelector('#toastWrap .t-title-text').textContent==='Checking and enabling hardware acceleration…' && document.querySelector('#toastWrap .t-body').textContent==='System authorization is requested only when needed to start an existing acceleration service or enable Windows features. Third-party drivers are not installed automatically.'"));
    await shot('accel-checking-english');
    await changeLanguage('zh-CN');
    check('硬件加速执行中语言往返恢复中文检查提示，不残留驱动安装或强制授权文案', await js("document.querySelector('#toastWrap .t-title-text').textContent==='正在检查并启用硬件加速…' && document.querySelector('#toastWrap .t-body').textContent.includes('仅在必要时请求系统授权') && !document.getElementById('toastWrap').textContent.includes('正在安装硬件加速驱动')"));
    releaseAccel({ok:true,already:true,note:'硬件加速已可用，无需额外操作'});
    const accelResult = await js('window.uiAccelStep');
    check('加速已可用的回执释放部署忙碌且不声称执行驱动安装', accelResult.ok && await js("state.setupBusy===null && document.querySelector('#toastWrap .t-title-text').textContent==='硬件加速已启用' && document.querySelector('#toastWrap .t-body').textContent.includes('不会自动安装第三方驱动')"));
    fixture.clearResponse('provision:enableAccel');
    await js("delete window.uiAccelStep; document.getElementById('toastWrap').innerHTML=''; openSettingsSection('general')");
    await js(`(() => {
      window.uiOriginalTitle=document.title; document.title='设置';
      const probe=document.createElement('span'); probe.id='uiI18nProbe'; probe.hidden=true;
      probe.textContent='设置'; for (const name of ['title','aria-label','alt']) probe.setAttribute(name,'设置');
      document.body.appendChild(probe);
    })()`);
    await changeLanguage('en-US');
    check('真实Chromium英文翻译覆盖标题、按钮名称、动态文本与占位符', await js("document.title==='Settings' && document.getElementById('btnSettings').title==='Settings' && document.getElementById('btnSettings').getAttribute('aria-label')==='Settings' && document.getElementById('search').placeholder==='Search installed apps' && document.getElementById('uiI18nProbe').textContent==='Settings' && ['title','aria-label','alt'].every(name=>document.getElementById('uiI18nProbe').getAttribute(name)==='Settings')"));
    await shot('english-general');
    let releaseSync, syncRequested;
    const pendingSync = new Promise(resolve => { syncRequested = resolve; });
    fixture.setResponse('share:sync', () => new Promise(resolve => { releaseSync = resolve; syncRequested(); }));
    const syncStart = fixture.calls.length;
    await js('window.uiPendingSync=syncSharedNow(); syncSharedNow(); void 0');
    await pendingSync;
    check('同步期间按钮显示忙碌且不会重复提交', fixture.calls.slice(syncStart).filter(c => c.channel === 'share:sync').length === 1 && await js("document.getElementById('btnSyncShared').disabled && document.getElementById('btnSyncShared').getAttribute('aria-busy')==='true'"));
    await changeLanguage('zh-CN');
    releaseSync({ pushed:0, pulled:0, errors:[], error:'UI 测试：运行时未连接' });
    await js('window.uiPendingSync');
    check('英文同步中切回中文不会残留英文按钮或伪报成功', await js("document.getElementById('btnSyncShared').textContent==='立即同步' && !document.getElementById('btnSyncShared').disabled && !document.getElementById('btnSyncShared').hasAttribute('aria-busy') && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('运行时未连接'))"));
    check('语言往返恢复全部属性、标题且三个语言选择器一致', await js("document.title==='设置' && document.getElementById('btnSettings').title==='设置' && document.getElementById('btnSettings').getAttribute('aria-label')==='设置' && document.getElementById('search').placeholder==='搜索已安装应用' && document.getElementById('uiI18nProbe').textContent==='设置' && ['title','aria-label','alt'].every(name=>document.getElementById('uiI18nProbe').getAttribute(name)==='设置') && ['setLanguage','wizLanguageFirst','wizLanguage'].every(id=>document.getElementById(id).value==='zh-CN')"));
    fixture.clearResponse('share:sync');
    fixture.setResponse('settings:set', () => { throw new Error('UI 测试：语言保存失败'); });
    await js("(() => { const select=document.getElementById('wizLanguageFirst'); select.value='en-US'; select.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await waitFor('!languageBusy');
    check('向导语言保存失败明确提示并还原全部语言控件', await js("window.apkI18n.lang==='zh-CN' && ['setLanguage','wizLanguageFirst','wizLanguage'].every(id=>document.getElementById(id).value==='zh-CN' && !document.getElementById(id).disabled && !document.getElementById(id).hasAttribute('aria-busy')) && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('语言保存失败'))"));
    fixture.clearResponse('settings:set');
    await changeLanguage('en-US'); await changeLanguage('zh-CN');
    for (const [response, title, type] of [
      [{skipped:true}, '本次未执行同步', 'info'],
      [{pushed:2,pulled:0,errors:['UI 测试：某文件不可读']}, '共享目录部分同步', 'warn'],
      [{pushed:0,pulled:0,conflicts:1,pendingDeletes:1,errors:[]}, '共享目录有未同步项', 'warn'],
      [{pushed:0,pulled:0,errors:[]}, '已同步共享目录', 'info'],
      [{}, '同步失败', 'error'],
    ]) {
      fixture.setResponse('share:sync', () => response);
      await js("document.getElementById('toastWrap').innerHTML=''; syncSharedNow()");
      check('同步反馈区分：' + title, await js(`(() => { const toast=document.querySelector('#toastWrap .toast'); return toast?.querySelector('.t-title-text').textContent===${scriptValue(title)} && ${type === 'info' ? "!toast.classList.contains('warn') && !toast.classList.contains('error')" : `toast.classList.contains(${scriptValue(type)})`}; })()`));
    }
    fixture.clearResponse('share:sync');
    await js("document.title=window.uiOriginalTitle; delete window.uiOriginalTitle; document.getElementById('uiI18nProbe').remove(); document.getElementById('toastWrap').innerHTML=''; closeSettings()");
    fixture.setResponse('apk:compat', () => ({ compat: null }));
    fixture.setResponse('apk:install', () => { throw new Error('UI 测试：安装 IPC 拒绝，原文件保留'); });
    await js("installFiles(['D:\\\\ui-fixture\\\\no-event.apk'])");
    await waitFor("!document.querySelector('#toastWrap .spinner')");
    check('没有 install:error 推送的安装拒绝仍显示原因并释放安装锁', await js("!state.installing && installToast===null && [...document.querySelectorAll('.toast.error')].filter(e=>e.textContent.includes('安装 IPC 拒绝') && e.textContent.includes('no-event.apk')).length===1"));
    await js("document.getElementById('toastWrap').innerHTML=''");
    fixture.setResponse('apk:install', file => {
      mainWin.webContents.send('install:error', { file, message: 'UI 测试：安装返回失败' });
      throw new Error('UI 测试：安装返回失败');
    });
    await js("installFiles(['D:\\\\ui-fixture\\\\event.apk'])");
    await settle();
    check('安装事件与 invoke 拒绝仅产生一条错误反馈', await js("document.querySelectorAll('#toastWrap .toast.error').length===1 && !state.installing"));
    fixture.setResponse('apk:install', () => ({ app: { label: 'UI 安装成功', package: 'com.example.installed' } }));
    await js("document.getElementById('toastWrap').innerHTML=''; state.filter='missing-installed-app'; document.getElementById('search').value=state.filter; renderGrid(); installFiles(['D:\\\\ui-fixture\\\\success.apk'])");
    check('成功安装同步清除搜索值和内部筛选，安装状态可再次使用', await js("!state.installing && state.filter==='' && document.getElementById('search').value==='' && document.querySelectorAll('.card').length===3 && !document.getElementById('grid').classList.contains('hidden')"));
    fixture.setResponse('apk:compat', () => ({ compat: { level:'risky', label:'需要确认', reasons:[], env:{source:'UI 夹具'} } }));
    fixture.setResponse('app:confirm', () => { throw new Error('UI 测试：确认弹窗不可用'); });
    const confirmStart = fixture.calls.length;
    await js("installFiles(['D:\\\\ui-fixture\\\\confirmation.apk'])");
    check('兼容性确认失败不安装且明确反馈、释放锁', !fixture.calls.slice(confirmStart).some(c=>c.channel==='apk:install') && await js("!state.installing && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('确认弹窗不可用'))"));
    for (const channel of ['apk:compat','apk:install','app:confirm']) fixture.clearResponse(channel);
    await js("document.getElementById('toastWrap').innerHTML=''");
    fixture.setResponse('app:shortcut', () => ({ok:false,error:'UI 测试：快捷方式创建失败'}));
    const shortcutStart = fixture.calls.length;
    await js("showMenu(20,20,'com.example.notes')");
    if (process.env.UI_AUDIT_PLATFORM === 'linux') {
      check('不支持桌面集成时菜单快捷方式标明不可用', await js("document.querySelector('#ctxmenu [data-act=shortcut]').getAttribute('aria-disabled')==='true'"));
      await js("document.querySelector('#ctxmenu [data-act=shortcut]').click(); createShortcut('com.example.notes')");
      check('Linux菜单与直接操作均不会调用桌面快捷方式 IPC', !fixture.calls.slice(shortcutStart).some(c=>c.channel==='app:shortcut'));
    } else {
      await js("document.querySelector('#ctxmenu [data-act=shortcut]').click()");
      await waitFor("[...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('快捷方式创建失败'))");
      check('快捷方式后端返回 ok:false 不伪报创建成功', fixture.calls.slice(shortcutStart).some(c=>c.channel==='app:shortcut') && await js("![...document.querySelectorAll('.toast')].some(e=>e.querySelector('.t-title-text').textContent==='桌面快捷方式已创建')"));
    }
    await js('hideMenu()');
    const cardDoubleClickStart = fixture.calls.length;
    const cardPoint = await js("(() => { const r=document.querySelector('.card-launch').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()");
    for (const clickCount of [1, 2]) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: cardPoint.x, y: cardPoint.y, button: 'left', clickCount });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: cardPoint.x, y: cardPoint.y, button: 'left', clickCount });
    }
    await settle();
    const cardDoubleClickCalls = fixture.calls.slice(cardDoubleClickStart);
    check('应用卡片真实双击不会隐式创建桌面快捷方式', !cardDoubleClickCalls.some(c => c.channel === 'app:shortcut'));
    check('应用卡片双击序列只保留首次普通点击的启动', cardDoubleClickCalls.filter(c => c.channel === 'app:launch').length === 1);
    fixture.clearResponse('app:shortcut');
    await js("hideMenu(); closeSettings(); document.getElementById('settingsMask').classList.remove('on'); document.getElementById('toastWrap').innerHTML=''");
    let releaseLaunch;
    fixture.setResponse('app:launch', () => new Promise(resolve => { releaseLaunch = resolve; }));
    await js("window.uiLaunchPending=launchApp('com.example.notes'); void 0");
    await waitFor('state.launching');
    mainWin.webContents.send('app:launchProgress', { package: 'com.example.notes', message: '正在等待安卓网络就绪（最多 20 秒）…' });
    await waitFor("document.querySelector('#toastWrap .t-body')?.textContent==='正在等待安卓网络就绪（最多 20 秒）…'");
    check('启动阶段同步更新提示与状态栏，不停留在待开机', await js("document.getElementById('engineTag').textContent==='启动中' && document.getElementById('statusText').textContent==='正在等待安卓网络就绪（最多 20 秒）…'"));
    await shot('launch-network-progress');
    releaseLaunch({ ok: false, error: 'UI 测试：启动已取消' });
    await js('window.uiLaunchPending');
    check('启动失败停止转圈并释放重复点击限制', await js("!state.launching && !document.querySelector('#toastWrap .spinner') && document.querySelector('#toastWrap .toast.error')?.textContent.includes('启动已取消')"));
    fixture.clearResponse('app:launch');
    await js("document.getElementById('toastWrap').innerHTML=''");
    const hiddenPollStart = fixture.calls.length;
    await js('pollSystems()');
    const hiddenPollCalls = fixture.calls.slice(hiddenPollStart);
    check('系统设置隐藏时轮询不请求系统目录或任务快照', !hiddenPollCalls.some(c => c.channel === 'system:list' || c.channel === 'system:tasks'));
    const reopenStart = fixture.calls.length;
    await js("openSettings({section:'runtime'}); void 0");
    await waitFor('!sysUI.loading && !!sysUI.data');
    const reopenCalls = fixture.calls.slice(reopenStart);
    check('重新打开运行状态面板立即刷新系统目录与任务快照', reopenCalls.filter(c => c.channel === 'system:list').length === 1 && reopenCalls.filter(c => c.channel === 'system:tasks').length === 1);
    await js('closeSettings()');
    await waitFor('!sysUI.loading');
    await js("openSettings({section:'runtime'}); void 0");
    await waitFor('!sysUI.loading');
    let releaseSnapshot, snapshotRequested;
    const snapshotPending = new Promise(resolve => { snapshotRequested = resolve; });
    fixture.setResponse('system:tasks', () => new Promise(resolve => { releaseSnapshot = resolve; snapshotRequested(); }));
    const pendingPollStart = fixture.calls.length;
    await js('window.uiSnapshotPending=loadSystems(); void 0');
    await snapshotPending;
    await js('pollSystems()');
    check('可见面板的慢快照期间周期轮询不会排队重复刷新', await js('!sysUI.reloadPending') && fixture.calls.slice(pendingPollStart).filter(c=>c.channel==='system:list').length===1 && fixture.calls.slice(pendingPollStart).filter(c=>c.channel==='system:tasks').length===1);
    const pushedTask = { taskId:'ui-new-task', systemId:'android-x86', status:'downloading', progress:77, updatedAt:'2026-01-02T00:00:00Z' };
    mainWin.webContents.send('system:task', pushedTask);
    await settle();
    check('任务快照读取中仍即时显示新的任务推送', await js("sysUI.tasks.some(t=>t.taskId==='ui-new-task'&&t.progress===77)"));
    releaseSnapshot({ok:true,tasks:[{...pushedTask,status:'paused',progress:12,updatedAt:'2026-01-01T00:00:00Z'}]});
    await js('window.uiSnapshotPending');
    check('迟到快照不会覆盖比它更新的任务推送', await js("sysUI.tasks.find(t=>t.taskId==='ui-new-task')?.progress===77"));
    mainWin.webContents.send('system:task', {...pushedTask,progress:1,updatedAt:'2025-12-31T00:00:00Z'});
    for (let i=0;i<16;i++) mainWin.webContents.send('system:task', {taskId:'ui-history-'+i,systemId:'bliss-os',status:'failed',updatedAt:'2026-01-03T00:00:00Z'});
    await settle();
    check('过期任务推送不回退进度，超过十二条历史也不挤掉活动任务', await js("sysUI.tasks.find(t=>t.taskId==='ui-new-task')?.progress===77 && sysUI.tasks.length===17"));
    fixture.clearResponse('system:tasks');
    await js('loadSystems()');
    fixture.setResponse('system:detail', id => ({ok:true,detail:{id,logs:['UI 日志：'+id+' <原样显示>']}}));
    await js("sysUI.selected='android-x86'; renderSysDetail(); refreshSysLogs()");
    mainWin.webContents.send('system:log', '不带系统归属的原始推送');
    await waitFor('sysUI.logTimer===null');
    await js('refreshSysLogs()');
    check('系统日志按 detail.id 获取并转义，不把无归属裸推送归给当前系统', await js("document.getElementById('sysDetailLogs').textContent.includes('android-x86 <原样显示>') && !sysUI.logs.some(x=>x.msg.includes('不带系统归属')) && !document.getElementById('sysDetailLogs').querySelector('原样显示')"));
    await js("sysUI.selected='bliss-os'; renderSysDetail(); refreshSysLogs()");
    check('切换系统详情只呈现所选系统日志', await js("document.getElementById('sysDetailLogs').textContent.includes('bliss-os') && !document.getElementById('sysDetailLogs').textContent.includes('android-x86')"));
    fixture.clearResponse('system:detail');
    await js("sysUI.selected=''; renderSysDetail()");
    currentStage = 'performance-profile-regressions';
    fixture.setResponse('doctor:profile', () => ({
      text: '自动：8.0GB 内存 · 8 核 · 720×1280 · host 渲染',
      running: '自动：6.0GB 内存 · 6 核 · 720×1280 · swangle 渲染 · 硬件加速（运行日志已确认）',
      pending: true,
      fallbackReason: '本次显卡渲染失败，已回退软件渲染。',
      profile: { host: { totalMB: 81920, freeMB: 47820, cores: 32 } },
    }));
    await js("(async () => { await openSettings({section:'performance'}); await refreshProfileText(); document.getElementById('setBody').scrollTop=0; })()");
    check('性能页分开显示实际软件渲染与下次显卡渲染，不把预期当作已生效', await js("document.getElementById('runningProfileText').textContent.includes('swangle') && !document.getElementById('runningProfileText').textContent.includes('host 渲染') && document.getElementById('autoProfileText').textContent.includes('host 渲染')"));
    check('性能页将选档依据明确标为下次启动，不把参数差异声称为设置未生效', await js("!document.getElementById('profileFallbackText').hidden && document.getElementById('profileFallbackText').textContent.startsWith('下次启动选档依据：') && !document.getElementById('profilePendingText').hidden && document.getElementById('profilePendingText').textContent==='当前运行参数与下次启动计划不同；停止运行时后重新启动将按计划重新尝试。'"));
    await shot('performance-actual-and-next');
    fixture.setResponse('doctor:profile', () => ({ text: '自动：8.0GB 内存 · 8 核 · host 渲染', running: '', pending: false }));
    await js('refreshProfileText()');
    check('安卓停止后实际参数不残留，旧回退与重启提示确实隐藏', await js("document.getElementById('runningProfileText').textContent==='安卓尚未运行' && getComputedStyle(document.getElementById('profileFallbackText')).display==='none' && getComputedStyle(document.getElementById('profilePendingText')).display==='none'"));
    fixture.clearResponse('doctor:profile');
    await js('refreshProfileText()');
    currentStage = 'capacity-maintenance-regressions';
    const savedCapacity = Number((await fixture.respond('settings:get')).engine.dataPartitionGB) || 0;
    await js("openSettings({section:'performance'})");
    const capacityStart = fixture.calls.length;
    await js("document.getElementById('setDataGB').value='32'; document.getElementById('setDataGB').dispatchEvent(new Event('change',{bubbles:true}))");
    await settle();
    check('选择容量只预览，不提前保存设置或扩容', !fixture.calls.slice(capacityStart).some(c=>c.channel==='runtime:setDataSize' || (c.channel==='settings:set' && c.payload?.engine?.dataPartitionGB !== undefined)) && await js(`Number(state.settings.engine.dataPartitionGB||0)===${scriptValue(savedCapacity)}`));
    fixture.setResponse('app:confirm', () => ({response:0}));
    await js("document.getElementById('btnGrowData').click()");
    await waitFor('!dataSizeBusy');
    check('取消扩容不调用容量 IPC，控件回到已保存容量', !fixture.calls.slice(capacityStart).some(c=>c.channel==='runtime:setDataSize') && await js(`Number(document.getElementById('setDataGB').value)===${scriptValue(savedCapacity)} && !document.getElementById('btnGrowData').disabled`));
    fixture.setResponse('app:confirm', () => ({response:1}));
    fixture.setResponse('runtime:setDataSize', () => ({ok:false,error:'UI 测试：磁盘被占用，容量未修改'}));
    await js("document.getElementById('setDataGB').value='32'; document.getElementById('btnGrowData').click()");
    await waitFor('!dataSizeBusy');
    check('真实扩容失败保留保存值和实际显示，给出具体错误', await js(`Number(state.settings.engine.dataPartitionGB||0)===${scriptValue(savedCapacity)} && Number(document.getElementById('setDataGB').value)===${scriptValue(savedCapacity)} && !document.getElementById('setDataGB').disabled && !document.getElementById('btnGrowData').hasAttribute('aria-busy') && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('磁盘被占用'))`));
    await js("document.getElementById('btnGrowData').scrollIntoView({block:'center'})");
    await shot('capacity-apply-failed');
    fixture.clearResponse('runtime:setDataSize');
    await js("document.getElementById('setDataGB').value='32'; document.getElementById('btnGrowData').click()");
    await waitFor('!dataSizeBusy');
    check('扩容成功才从设置读回保存容量，不用普通 settings:set 绕过', (await fixture.respond('settings:get')).engine.dataPartitionGB===32 && await js("state.settings.engine.dataPartitionGB===32 && document.getElementById('setDataGB').value==='32' && document.getElementById('wizDataGB').value==='32'") && !fixture.calls.slice(capacityStart).some(c=>c.channel==='settings:set' && c.payload?.engine?.dataPartitionGB !== undefined));
    await js("closeSettings(); openWizard()");
    await js('wizardShowPage(4); wizardFillConfig()');
    fixture.setResponse('runtime:setDataSize', () => ({ok:false,error:'UI 测试：向导扩容未完成'}));
    const wizardCapacityStart = fixture.calls.length;
    await js("document.getElementById('wizDataGB').value='48'; document.getElementById('wizardNext').click()");
    await waitFor('!wizard.saving');
    check('向导容量失败留在资源页，不能保存假容量或进入下一步', await js("wizard.page===4 && state.settings.engine.dataPartitionGB===32 && document.getElementById('wizDataGB').value==='32' && !document.getElementById('wizardNext').disabled") && !fixture.calls.slice(wizardCapacityStart).some(c=>c.channel==='settings:set'));
    fixture.clearResponse('runtime:setDataSize');
    const wizardApplyStart = fixture.calls.length;
    await js("document.getElementById('wizDataGB').value='48'; document.getElementById('wizardNext').click()");
    await waitFor('!wizard.saving');
    const wizardApplyCalls = fixture.calls.slice(wizardApplyStart);
    check('向导先完成容量应用才保存其余设置并前进', await js("wizard.page===5 && state.settings.engine.dataPartitionGB===48") && wizardApplyCalls.findIndex(c=>c.channel==='runtime:setDataSize')>=0 && wizardApplyCalls.findIndex(c=>c.channel==='settings:set')>wizardApplyCalls.findIndex(c=>c.channel==='runtime:setDataSize') && !wizardApplyCalls.some(c=>c.channel==='settings:set' && c.payload?.engine?.dataPartitionGB !== undefined));
    await fixture.respond('settings:set', {engine:{dataPartitionGB:savedCapacity}});
    await js("(async () => { state.settings=await api.getSettings(); document.getElementById('wizardMask').classList.remove('on'); document.getElementById('toastWrap').innerHTML=''; await openSettings({section:'runtime'}); })()");
    fixture.setResponse('runtime:resetData', () => ({ok:false,cancelled:true}));
    const resetStart = fixture.calls.length;
    await js("document.getElementById('btnResetData').click()");
    await waitFor("!document.getElementById('btnResetData').disabled");
    const resetCalls = fixture.calls.slice(resetStart);
    check('重置保留默认取消的意图确认，主进程取消不误报失败或成功', resetCalls.filter(c=>c.channel==='app:confirm').length===1 && resetCalls.some(c=>c.channel==='app:confirm' && c.payload.danger===true) && resetCalls.some(c=>c.channel==='runtime:resetData') && await js("document.querySelectorAll('#toastWrap .toast').length===0"));
    fixture.clearResponse('runtime:resetData');
    fixture.setResponse('runtime:repairNetwork', () => ({ok:false,error:'UI 测试：轻量重连未成功，应用数据保留'}));
    const networkStart = fixture.calls.length;
    await js("document.getElementById('btnRepairNetwork').click()");
    await waitFor("!document.getElementById('btnRepairNetwork').disabled");
    const networkCalls = fixture.calls.slice(networkStart);
    check('修复网络只走轻量入口并明确保留数据，不请求重置', networkCalls.some(c=>c.channel==='app:confirm' && c.payload.detail.includes('不会重置安卓用户数据')) && networkCalls.some(c=>c.channel==='runtime:repairNetwork') && !networkCalls.some(c=>c.channel==='runtime:resetData') && await js("[...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('轻量重连未成功'))"));
    fixture.setResponse('runtime:repairNetwork', () => ({ok:true,wiped:false,network:{gateway:'10.0.2.2'}}));
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnRepairNetwork').click()");
    await waitFor("!document.getElementById('btnRepairNetwork').disabled");
    check('网络恢复反馈不再声称自动重装或数据丢失', await js("document.getElementById('toastWrap').textContent.includes('登录状态和存档均保留') && !document.getElementById('toastWrap').textContent.includes('自动重装')"));
    fixture.clearResponse('runtime:repairNetwork');
    fixture.setResponse('runtime:cleanup', () => ({ok:true,candidates:[]}));
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnCleanup').click()");
    await waitFor("!document.getElementById('btnCleanup').disabled");
    check('清理空结果准确说明受管缓存范围，不声称删除其它镜像和AVD', await js("document.getElementById('toastWrap').textContent.includes('系统镜像和其它 AVD 不会删除')"));
    fixture.setResponse('runtime:cleanup', opts => opts.apply ? {ok:false,error:'UI 测试：清理停机未确认'} : {ok:true,candidates:[{size:1024}]} );
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnCleanup').click()");
    await waitFor("!document.getElementById('btnCleanup').disabled");
    check('清理维护失败显示原因且不伪报释放空间', await js("[...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('清理停机未确认')) && !document.getElementById('toastWrap').textContent.includes('清理完成')"));
    for (const channel of ['app:confirm','runtime:cleanup']) fixture.clearResponse(channel);
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('setupGuide').hidden=false");
    fixture.setResponse('runtime:markInstalled', () => ({ok:false,error:'UI 测试：安装虚拟机尚未退出'}));
    const markFailedStart = fixture.calls.length;
    await js("document.getElementById('btnMarkInstalled').click()");
    await waitFor("!document.getElementById('btnMarkInstalled').disabled");
    check('markInstalled 返回失败时保留当前引导，不停止运行时或误报接管', !fixture.calls.slice(markFailedStart).some(c=>c.channel==='runtime:stop') && await js("!document.getElementById('setupGuide').hidden && !document.getElementById('btnMarkInstalled').hasAttribute('aria-busy') && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('安装虚拟机尚未退出')) && !document.getElementById('toastWrap').textContent.includes('运行时已接管')"));
    await js("document.getElementById('btnMarkInstalled').scrollIntoView({block:'center'})");
    await shot('mark-installed-failed');
    fixture.setResponse('runtime:markInstalled', () => { throw new Error('UI 测试：确认安装 IPC 中断'); });
    const markRejectedStart = fixture.calls.length;
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnMarkInstalled').click()");
    await waitFor("!document.getElementById('btnMarkInstalled').disabled");
    check('markInstalled IPC 拒绝也保留引导并显示可重试错误', !fixture.calls.slice(markRejectedStart).some(c=>c.channel==='runtime:stop') && await js("!document.getElementById('setupGuide').hidden && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('确认安装 IPC 中断'))"));
    fixture.setResponse('runtime:markInstalled', () => ({ok:true}));
    fixture.setResponse('runtime:stop', () => ({ok:false,error:'UI 测试：未确认安全停机'}));
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnMarkInstalled').click()");
    await waitFor("!document.getElementById('btnMarkInstalled').disabled");
    check('安装标记成功但停机失败仍停留当前步骤', await js("!document.getElementById('setupGuide').hidden && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('未确认安全停机')) && !document.getElementById('toastWrap').textContent.includes('运行时已接管')"));
    fixture.setResponse('runtime:stop', () => ({ok:true}));
    const markSuccessStart = fixture.calls.length;
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnMarkInstalled').click()");
    await waitFor("!document.getElementById('btnMarkInstalled').disabled");
    const markSuccessCalls = fixture.calls.slice(markSuccessStart);
    check('仅安装确认与安全停机均成功后隐藏引导并显示接管', markSuccessCalls.findIndex(c=>c.channel==='runtime:stop')>markSuccessCalls.findIndex(c=>c.channel==='runtime:markInstalled') && await js("document.getElementById('setupGuide').hidden && document.getElementById('toastWrap').textContent.includes('安装完成，运行时已接管')"));
    for (const channel of ['runtime:markInstalled','runtime:stop']) fixture.clearResponse(channel);
    await js("document.getElementById('toastWrap').innerHTML=''; closeSettings()");
  }
  const auditSystemSession = async theme => {
    currentStage = 'system-session-regressions:' + theme;
    await waitFor('!sysUI.loading');
    const baseline = JSON.parse(JSON.stringify(await fixture.respond('system:status')));
    const catalog = await fixture.respond('system:list');
    let currentId = baseline.current.systemId, running = true;
    const setSession = patch => {
      if (patch.current?.systemId) currentId = patch.current.systemId;
      if (patch.current?.running !== undefined) running = patch.current.running;
      fixture.setSystemState(patch);
    };
    const stopAccepted = () => {
      setSession({ switching:false, stopping:false, current:{ running:false, vmStarted:false, androidReady:false, stopped:true } });
      return { ok:true, running:false };
    };
    fixture.setResponse('system:list', () => ({ ...catalog, currentSystemId:currentId,
      systems:catalog.systems.map(s => ({ ...s, current:s.id===currentId,
        local:{ ...s.local, installed:s.id==='android-x86' || s.local.installed, running:s.id===currentId && running } })) }));
    fixture.setResponse('system:tasks', () => ({ ok:true, tasks:[] }));
    await js("openSettingsSection('android'); loadSystems()");
    await waitFor("!sysUI.loading && !!document.querySelector('#sysCards [data-sys=android-x86] [data-act=switch]')");
    await js("document.getElementById('toastWrap').innerHTML=''");
    let releaseSwitch, switchRequested;
    const pendingSwitch = new Promise(resolve => { switchRequested = resolve; });
    fixture.setResponse('system:switch', () => {
      setSession({ switching:true });
      return new Promise(resolve => { releaseSwitch = resolve; switchRequested(); });
    });
    const switchStart = fixture.calls.length;
    await js(`(() => {
      const b=document.querySelector('#sysCards [data-sys="android-x86"] [data-act="switch"]');
      b.focus(); b.click(); sysDoAction('android-x86','switch'); sysDoAction('google-play','switch');
    })()`);
    await pendingSwitch;
    check(theme + '切换期间明确提供取消入口，重复或跨系统切换不会重复提交', fixture.calls.slice(switchStart).filter(c=>c.channel==='system:switch').length===1 && await js("document.activeElement.matches('#sysCards [data-sys=android-x86] [data-act=stop]') && document.activeElement.textContent==='取消切换' && document.querySelector('#setupSteps [data-act=vmStop]').textContent==='取消切换' && document.getElementById('btnRuntimeStop').textContent==='取消切换'"));
    await js("document.querySelector('#sysCards [data-sys=android-x86]').scrollIntoView({block:'center'})");
    await shot(theme + '-system-switch-cancel');
    await js("changeLanguage('en-US')"); await settle();
    check(theme + '切换取消入口与任务取消文案英文化且可恢复源文', await js("document.querySelector('#sysCards [data-sys=android-x86] [data-act=stop]').textContent==='Cancel switch' && document.getElementById('btnRuntimeStop').textContent==='Cancel switch'"));
    await js("changeLanguage('zh-CN')"); await settle();
    let releaseStop, stopRequested;
    const pendingStop = new Promise(resolve => { stopRequested = resolve; });
    fixture.setResponse('system:stop', () => {
      setSession({ stopping:true });
      return new Promise(resolve => { releaseStop = resolve; stopRequested(); });
    });
    const cancelStart = fixture.calls.length;
    await js(`(() => {
      document.querySelector('#sysCards [data-sys="android-x86"] [data-act="stop"]').click();
      document.getElementById('btnRuntimeStop').click();
      document.querySelector('#setupSteps [data-act=vmStop]').click();
    })()`);
    await pendingStop;
    check(theme + '取消切换仅调用一次 systemStop，卡片与运行状态停止入口同步忙碌且保留焦点', fixture.calls.slice(cancelStart).filter(c=>c.channel==='system:stop').length===1 && !fixture.calls.slice(cancelStart).some(c=>['runtime:stop','system:cancel'].includes(c.channel)) && await js("sysUI.stopBusy && document.activeElement.matches('#sysCards [data-sys=android-x86] [data-act=stop]') && document.activeElement.getAttribute('aria-busy')==='true' && document.querySelector('#setupSteps [data-act=vmStop]').getAttribute('aria-disabled')==='true' && document.getElementById('btnRuntimeStop').getAttribute('aria-busy')==='true'"));
    setSession({ switching:false });
    releaseSwitch({ ok:false, code:'START_CANCELLED', systemId:'android-x86', error:'系统启动已取消' });
    await waitFor('sysUI.switchOp===null && !sysUI.loading');
    check(theme + '切换取消回执不误报失败，实际停机确认前仍保持停止中', await js("sysUI.stopBusy && document.getElementById('statusText').textContent.includes('正在停止') && !document.getElementById('toastWrap').textContent.includes('切换失败') && !document.getElementById('toastWrap').textContent.includes('当前系统已停止')"));
    setSession({ current:{ systemId:'android-x86', serial:'127.0.0.1:6123' } });
    releaseStop(stopAccepted());
    await waitFor('!sysUI.stopBusy && !sysUI.loading');
    check(theme + '仅收到停机成功才提示切换已取消并恢复忙碌状态', await js("document.getElementById('toastWrap').textContent.includes('切换已取消，当前系统已停止') && !document.getElementById('btnRuntimeStop').hasAttribute('aria-busy') && document.getElementById('btnRuntimeStop').getAttribute('aria-disabled')==='false' && ![...document.querySelectorAll('.t-title-text')].some(e=>e.textContent==='已切换') && document.getElementById('setupStateText').textContent.includes('Android-x86 · 未运行')"));
    fixture.setResponse('system:stop', stopAccepted);
    let releaseLate, lateRequested;
    const pendingLate = new Promise(resolve => { lateRequested=resolve; });
    fixture.setResponse('system:switch', () => {
      setSession({ switching:true });
      return new Promise(resolve => { releaseLate=resolve; lateRequested(); });
    });
    await js("document.getElementById('toastWrap').innerHTML=''; document.querySelector('#sysCards [data-sys=android-x86] [data-act=switch]').click()");
    await pendingLate;
    const stepStopStart = fixture.calls.length;
    await js("openSettingsSection('runtime'); document.querySelector('#setupSteps [data-act=vmStop]').click()");
    await waitFor('!sysUI.stopBusy && !sysUI.loading');
    releaseLate({ ok:true, androidReady:true, systemId:'android-x86' });
    await settle();
    check(theme + '运行状态入口同样取消切换，迟到的成功结果不能复活已停止系统', fixture.calls.slice(stepStopStart).some(c=>c.channel==='system:stop') && !fixture.calls.slice(stepStopStart).some(c=>c.channel==='runtime:stop') && await js("sysUI.switchOp===null && document.getElementById('setupStateText').textContent.includes('Android-x86 · 未运行') && ![...document.querySelectorAll('.t-title-text')].some(e=>e.textContent==='已切换')"));
    setSession({ switching:true, current:{ systemId:'google-play', running:true, vmStarted:true, stopped:false } });
    await js("document.getElementById('toastWrap').innerHTML=''; loadSystems()");
    check(theme + '非本窗口发起的切换也从 systemStatus 识别并提供取消入口', await js("sysUI.switchOp===null && document.querySelector('#setupSteps [data-act=vmStop]').textContent==='取消切换' && document.querySelector('#sysCards [data-sys=google-play] [data-act=stop]').textContent==='取消切换'"));
    await js("document.getElementById('btnRuntimeStop').click()");
    await waitFor('!sysUI.stopBusy && !sysUI.loading');
    check(theme + '高级停止入口取消外部切换也只调用系统管理器', await js("!sysUI.status.switching && document.getElementById('probeResult').textContent==='切换已取消，当前系统已停止'"));
    setSession({ switching:false, stopping:false, current:{ systemId:'android-x86', running:true, vmStarted:true, androidReady:false, stopped:false, serial:'127.0.0.1:6123' } });
    await js("document.getElementById('toastWrap').innerHTML=''; loadSystems()");
    check(theme + '非内置系统状态与停止操作不误指仍在线的旧内置运行时', await js("state.status.deviceOnline && state.status.android==='14' && document.getElementById('statusText').textContent==='Android-x86 · 已启动，等待 Android 就绪' && document.getElementById('setupStateText').textContent==='Android-x86 · 已启动，等待 Android 就绪' && document.getElementById('statusDevice').textContent==='127.0.0.1:6123' && document.getElementById('btnRuntimeStart').disabled && document.querySelector('#setupSteps [data-act=vmStop]').textContent==='停止当前系统'"));
    fixture.setResponse('runtime:status', () => { throw new Error('UI 测试：旧内置运行时状态不可用'); });
    await js('refreshStatus()');
    check(theme + '旧内置运行时查询失败仍能显示并停止当前非内置系统', await js("sysUI.status.current.systemId==='android-x86' && document.getElementById('statusText').textContent==='Android-x86 · 已启动，等待 Android 就绪' && !!document.querySelector('#setupSteps [data-act=vmStop]') && !!document.querySelector('#sysCards [data-sys=android-x86] [data-act=stop]')"));
    fixture.clearResponse('runtime:status');
    await js('refreshStatus()');
    for (const [kind, respond, reason] of [
      ['安装器仍在写入', () => ({ok:false,error:'UI 测试：安装器仍在写入，请在虚拟机内正常关机'}), '安装器仍在写入'],
      ['缺失退出回执', () => undefined, '未能确认当前系统已停止'],
      ['仍在运行', () => ({ok:true,running:true}), '未能确认当前系统已停止'],
      ['IPC拒绝', () => { throw new Error('UI 测试：系统停止 IPC 中断'); }, '系统停止 IPC 中断'],
    ]) {
      fixture.setResponse('system:stop', respond);
      const failedStopStart = fixture.calls.length;
      await js("document.getElementById('toastWrap').innerHTML=''; openSettingsSection('android'); document.querySelector('#sysCards [data-sys=android-x86] [data-act=stop]').click()");
      await waitFor('!sysUI.stopBusy && !sysUI.loading');
      check(theme + '系统停止失败保留真实运行状态并释放忙碌：' + kind, fixture.calls.slice(failedStopStart).filter(c=>c.channel==='system:stop').length===1 && !fixture.calls.slice(failedStopStart).some(c=>c.channel==='runtime:stop') && await js(`sysUI.status.current.running && !document.getElementById('btnRuntimeStop').hasAttribute('aria-busy') && document.querySelector('#sysCards [data-sys=android-x86] [data-act=stop]').getAttribute('aria-busy')!=='true' && [...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes(${scriptValue(reason)})) && ![...document.querySelectorAll('#toastWrap .t-title-text')].some(e=>['当前系统已停止','切换已取消，当前系统已停止'].includes(e.textContent))`));
    }
    await js("document.querySelector('#sysCards [data-sys=android-x86]').scrollIntoView({block:'center'})");
    await shot(theme + '-system-stop-error');
    fixture.setResponse('system:stop', () => ({ ok:false, cancelled:true }));
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnRuntimeStop').click()");
    await waitFor('!sysUI.stopBusy && !sysUI.loading');
    check(theme + '停止被取消不误报成功或失败，也不回退到 runtimeStop', await js("sysUI.status.current.running && document.getElementById('probeResult').textContent==='停止操作已取消' && !document.querySelector('#toastWrap .toast.error') && !document.getElementById('toastWrap').textContent.includes('当前系统已停止')"));
    let releaseStatus, statusRequested;
    const pendingStatus = new Promise(resolve => { statusRequested=resolve; });
    fixture.setResponse('system:status', () => {
      fixture.clearResponse('system:status');
      return new Promise(resolve => { releaseStatus=resolve; statusRequested(); });
    });
    await js('window.uiStaleSystemStatus=refreshStatus(); void 0');
    await pendingStatus;
    let releaseFencedStop, fencedStopRequested;
    const pendingFencedStop = new Promise(resolve => { fencedStopRequested=resolve; });
    fixture.setResponse('system:stop', () => new Promise(resolve => { releaseFencedStop=resolve; fencedStopRequested(); }));
    const fencedStart = fixture.calls.length;
    await js("document.getElementById('toastWrap').innerHTML=''; document.getElementById('btnRuntimeStop').click()");
    await pendingFencedStop;
    releaseStatus(baseline);
    await js('window.uiStaleSystemStatus');
    check(theme + '迟到的旧运行时状态不能覆盖停止中状态或当前系统身份', await js("sysUI.stopBusy && document.getElementById('statusText').textContent==='正在停止当前系统…' && sysUI.status.current.systemId==='android-x86' && document.getElementById('btnRuntimeStop').getAttribute('aria-busy')==='true'"));
    releaseFencedStop(stopAccepted());
    await waitFor('!sysUI.stopBusy && !sysUI.loading');
    check(theme + '非内置系统成功停止后刷新所属 Provider，不假称停止旧内置虚拟机', fixture.calls.slice(fencedStart).filter(c=>c.channel==='system:stop').length===1 && !fixture.calls.slice(fencedStart).some(c=>['runtime:stop','system:cancel'].includes(c.channel)) && await js("!sysUI.status.current.running && document.getElementById('probeResult').textContent==='当前系统已停止' && document.getElementById('statusText').textContent==='Android-x86 · 未运行'"));
    fixture.setResponse('system:status', () => ({ok:false,error:'UI 测试：系统状态读取失败'}));
    await js('refreshStatus()');
    check(theme + '系统归属读取失败时不拿旧内置在线状态冒充当前系统', await js("document.getElementById('statusText').textContent==='无法确认当前系统状态，请刷新后重试' && document.getElementById('statusDevice').textContent==='' && document.getElementById('btnRuntimeStart').disabled"));
    fixture.clearResponse('system:status');
    setSession({ current:{ running:true, vmStarted:true, stopped:false } });
    let cancelledTask = false, releaseCancel, cancelRequested;
    const pendingCancel = new Promise(resolve => { cancelRequested=resolve; });
    let holdCancelSnapshot = false, releaseCancelSnapshot, cancelSnapshotRequested;
    const pendingCancelSnapshot = new Promise(resolve => { cancelSnapshotRequested=resolve; });
    fixture.setResponse('system:tasks', () => {
      const task = {taskId:'ui-cancel-installer',systemId:'android-x86',status:cancelledTask?'cancelled':'awaiting_confirmation',currentStep:cancelledTask?'已取消（不停止安装器，保留当前安装会话）':'等待安装完成确认'};
      if (holdCancelSnapshot) {
        holdCancelSnapshot = false;
        return new Promise(resolve => { releaseCancelSnapshot=resolve; cancelSnapshotRequested(); });
      }
      return {ok:true,tasks:[task]};
    });
    fixture.setResponse('system:cancel', () => new Promise(resolve => { releaseCancel=resolve; cancelRequested(); }));
    await js("document.getElementById('toastWrap').innerHTML=''; loadSystems()");
    await waitFor("!sysUI.loading && sysUI.tasks.some(t=>t.taskId==='ui-cancel-installer' && t.status==='awaiting_confirmation')");
    holdCancelSnapshot = true;
    await js("openSettingsSection('runtime')");
    await pendingCancelSnapshot;
    const taskCancelStart = fixture.calls.length;
    await js(`(() => {
      const b=document.querySelector('#sysTaskList [data-tact=cancel]');
      b.focus(); b.click(); document.querySelector('#sysTaskList [data-tact=cancel]').click();
    })()`);
    await pendingCancel;
    check(theme + '取消安装任务保持原 taskId 与去重忙碌语义，并明确不会停安装器', fixture.calls.slice(taskCancelStart).filter(c=>c.channel==='system:cancel' && c.payload==='ui-cancel-installer').length===1 && await js("document.activeElement.matches('#sysTaskList [data-tact=cancel]') && document.activeElement.getAttribute('aria-busy')==='true' && document.activeElement.title==='仅取消任务，不停止安装器，也不删除系统数据'"));
    cancelledTask=true; releaseCancel({ok:true});
    await waitFor('sysUI.reloadPending===true');
    releaseCancelSnapshot({ok:true,tasks:[{taskId:'ui-cancel-installer',systemId:'android-x86',status:'awaiting_confirmation',currentStep:'等待安装完成确认'}]});
    await waitFor('!sysUI.taskBusy.size && !sysUI.loading && sysUI.tasks[0]?.status===\'cancelled\'');
    check(theme + '任务取消与系统停止严格分离，不停止安装器也不假改运行状态', !fixture.calls.slice(taskCancelStart).some(c=>['system:stop','runtime:stop'].includes(c.channel)) && await js("sysUI.status.current.running && sysUI.tasks[0].status==='cancelled' && document.getElementById('toastWrap').textContent.includes('仅取消任务，不停止安装器，也不删除系统数据') && !!document.querySelector('#sysCards [data-sys=android-x86] [data-act=stop]')"));
    for (const channel of ['system:list','system:tasks','system:switch','system:stop','system:cancel','system:status']) fixture.clearResponse(channel);
    fixture.setSystemState({ ...baseline, current:{...baseline.current,stopped:false}, switching:false, stopping:false });
    await js("delete window.uiStaleSystemStatus; document.getElementById('toastWrap').innerHTML=''; loadSystems()");
  };
  for (const theme of ['light', 'dark']) {
    await js(`(async () => { if (window.apkTheme) await window.apkTheme.save(${scriptValue(theme)}); else { document.documentElement.dataset.theme=${scriptValue(theme)}; document.documentElement.style.colorScheme=${scriptValue(theme)}; } })()`);
    if (phase !== 'before') {
      const colors = await js("({bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),text:getComputedStyle(document.documentElement).getPropertyValue('--text').trim()})");
      const native = nativeColors.nativePalette(theme === 'dark');
      check(`${theme}原生窗口与CSS使用同一背景/文字值`, colors.bg === native.background && colors.text === native.foreground, colors);
    }
    await js("document.getElementById('settingsMask').classList.remove('on'); document.getElementById('wizardMask').classList.remove('on'); document.getElementById('repairMask').classList.remove('on');");
    await shot(theme + '-library');
    await js('openSettings()');
    for (const section of ['general','runtime','performance','display','android','integration','update','advanced','about']) {
      await js(`openSettingsSection(${scriptValue(section)})`);
      await shot(theme + '-settings-' + section);
      if (section === 'update') {
        check(theme + '问题反馈明确默认只保存在本机且不会自动发送', await js("(() => { const group=document.getElementById('reportGroup'); const note=group?.querySelector('.inline-note'); const text=group?.textContent||''; const visible=!!(group && group.getClientRects().length && getComputedStyle(group).visibility!=='hidden'); return visible && note?.textContent.includes('默认只保存在本机，不会自动发送') && text.includes('完整报告只留在本机') && text.includes('确认后才发送'); })()"));
      }
      await scanScrollable(theme + '-settings-' + section, '#settingsMask .set-body');
    }
    await js("openSettingsSection('android'); loadSystems()");
    await js("sysUI.selected='android-x86'; renderSysDetail(); document.getElementById('sysCards').scrollIntoView({block:'start'})");
    await shot(theme + '-systems');
    // 卡片主按钮必须把渲染时绑定的 taskId 原样传给恢复/重试 IPC，不能在主进程状态变化后猜任务。
    const resumeStart = fixture.calls.length;
    await js(`(() => {
      sysUI.tasks = [{ ...sysUI.tasks[0], status: 'paused', taskId: 'ui-download' }];
      renderSysCards();
      document.querySelector('#sysCards [data-sys="android-x86"] button[data-act="resume"]').click();
    })()`);
    await waitFor('!sysUI.taskBusy.size && !sysUI.loading');
    check(theme + '系统卡片继续任务传递准确 taskId', fixture.calls.slice(resumeStart).filter(c => c.channel === 'system:resume' && c.payload === 'ui-download').length === 1 && !fixture.calls.slice(resumeStart).some(c => c.channel === 'system:install'));
    const retryStart = fixture.calls.length;
    await js(`(() => {
      sysUI.tasks = [{ ...sysUI.tasks[0], status: 'failed', taskId: 'ui-download' }];
      renderSysCards();
      document.querySelector('#sysCards [data-sys="android-x86"] button[data-act="retry"]').click();
    })()`);
    await waitFor('!sysUI.taskBusy.size && !sysUI.loading');
    check(theme + '系统卡片重试任务传递准确 taskId', fixture.calls.slice(retryStart).filter(c => c.channel === 'system:retry' && c.payload === 'ui-download').length === 1 && !fixture.calls.slice(retryStart).some(c => c.channel === 'system:install'));
    let releaseTask, taskRequested;
    const pendingTask = new Promise(resolve => { taskRequested = resolve; });
    fixture.setResponse('system:resume', () => new Promise(resolve => { releaseTask = resolve; taskRequested(); }));
    const busyStart = fixture.calls.length;
    await js(`(() => {
      const button = document.querySelector('#sysCards [data-sys="android-x86"] button[data-act="resume"]');
      button.focus(); button.click();
      document.querySelector('#sysCards [data-sys="android-x86"] button[data-act="resume"]').click();
      document.querySelector('#sysTaskList [data-tact="resume"]').click();
    })()`);
    await pendingTask;
    await settle();
    check(theme + '继续任务期间卡片和任务列表保持焦点、忙碌且去重', fixture.calls.slice(busyStart).filter(c => c.channel === 'system:resume').length === 1 && await js("document.activeElement.matches('#sysCards [data-act=resume]') && document.activeElement.getAttribute('aria-busy')==='true' && document.querySelector('#sysTaskList [data-tact=resume]').getAttribute('aria-disabled')==='true'"));
    releaseTask({ ok: false, error: 'UI 测试：任务恢复被拒绝，数据未改动' });
    await waitFor('!sysUI.taskBusy.size');
    check(theme + '任务操作失败显示具体原因并恢复可重试状态', await js("[...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('任务恢复被拒绝')) && !document.querySelector('#sysCards [data-act=resume]').hasAttribute('aria-busy')"));
    await shot(theme + '-task-action-error');
    fixture.clearResponse('system:resume');
    await js("document.getElementById('toastWrap').innerHTML=''");
    // 延迟、失败与恢复只拦截内存 IPC，不读取远程目录或触碰下载任务。
    let releaseCatalog, catalogRequested;
    const requested = new Promise(resolve => { catalogRequested = resolve; });
    fixture.setResponse('system:list', () => new Promise(resolve => { releaseCatalog = resolve; catalogRequested(); }));
    await js('window.uiCatalogPending=loadSystems(); void 0');
    await requested;
    await settle();
    check(theme + '系统目录读取期间有忙碌反馈', await js("document.getElementById('sysCards').getAttribute('aria-busy')==='true'"));
    releaseCatalog({ ok:false, error:'UI 测试：系统目录暂不可用，请重试' });
    await js('window.uiCatalogPending');
    await shot(theme + '-catalog-error');
    check(theme + '目录失败提供明确错误和重试入口', await js("document.querySelector('#sysCards [data-act=retryCatalog]') && /暂不可用/.test(document.getElementById('sysCards').textContent)"));
    fixture.clearResponse('system:list');
    await js('loadSystems()');
    check(theme + '目录重试恢复系统列表', await js("document.querySelectorAll('#sysCards .sys-card').length===3 && document.getElementById('sysCards').getAttribute('aria-busy')!=='true'"));
    fixture.setResponse('system:list', () => { throw new Error('UI 测试：读取连接中断'); });
    await js('loadSystems()');
    check(theme + '刷新异常不会被旧目录静默掩盖', await js("!!document.querySelector('#sysCards [data-act=retryCatalog]') && /读取连接中断/.test(document.getElementById('sysCards').textContent) && document.getElementById('sysDetail').hidden"));
    fixture.clearResponse('system:list');
    await js('loadSystems()');
    await js("openSettingsSection('runtime'); void 0");
    await waitFor('!sysUI.loading');
    await js(`(() => {
      window.uiSavedTasks=sysUI.tasks;
      sysUI.tasks=[{...sysUI.tasks[0],status:'downloading',progress:42,speed:4*2**20,eta:60,currentStep:'正在下载，支持暂停'}];
      renderSysTasks();
    })()`);
    await shot(theme + '-task-progress');
    check(theme + '下载进度具有名称和真实百分比语义', await js("document.querySelector('#sysTaskList [role=progressbar]')?.getAttribute('aria-valuenow')==='42' && !!document.querySelector('#sysTaskList button[data-tact=pause]')"));
    check(theme + '任务状态公告节点具有状态、礼貌播报和原子语义', await js("(() => { const e=document.getElementById('sysTaskAnnouncement'); return e?.getAttribute('role')==='status' && e.getAttribute('aria-live')==='polite' && e.getAttribute('aria-atomic')==='true'; })()"));
    const phaseTask = { ...await js('sysUI.tasks[0]'), status:'verifying', progress:42, updatedAt:'2026-05-01T00:00:00Z', currentStep:'正在校验文件' };
    mainWin.webContents.send('system:task', phaseTask);
    await settle();
    check(theme + '事件驱动的任务阶段更新公告校验状态', await js("document.getElementById('sysTaskAnnouncement').textContent.includes('文件校验中')"));
    const phaseAnnouncement = await js("document.getElementById('sysTaskAnnouncement').textContent");
    mainWin.webContents.send('system:task', { ...phaseTask, progress:43, currentStep:'下载速度变化', updatedAt:'2026-05-01T00:00:01Z' });
    await settle();
    check(theme + '任务仅更新百分比时不重复播报', await js(`document.getElementById('sysTaskAnnouncement').textContent===${scriptValue(phaseAnnouncement)}`));
    mainWin.webContents.send('system:task', { ...phaseTask, status:'completed', progress:100, currentStep:'下载完成', updatedAt:'2026-05-01T00:00:02Z' });
    await settle();
    check(theme + '任务完成阶段会更新状态公告', await js("document.getElementById('sysTaskAnnouncement').textContent.includes('已完成')"));
    mainWin.webContents.send('system:task', { ...phaseTask, status:'failed', error:'UI 测试：连接中断，保留断点', currentStep:'下载失败', updatedAt:'2026-05-01T00:00:03Z' });
    await settle();
    check(theme + '任务失败阶段会公告错误原因', await js("document.getElementById('sysTaskAnnouncement').textContent.includes('连接中断，保留断点')"));
    await js("changeLanguage('en-US')");
    mainWin.webContents.send('system:task', { ...phaseTask, status:'verifying', updatedAt:'2026-05-01T00:00:04Z' });
    await settle();
    check(theme + '任务阶段公告使用当前英文界面语言', await js("document.getElementById('sysTaskAnnouncement').textContent==='Android-x86: Verifying files'"));
    await js("changeLanguage('zh-CN')");
    check(theme + '任务状态公告随语言切换恢复中文', await js("document.getElementById('sysTaskAnnouncement').textContent==='Android-x86：文件校验中'"));
    mainWin.webContents.send('system:task', { ...phaseTask, status:'failed', error:'UI 测试：连接中断，保留断点', updatedAt:'2026-05-01T00:00:05Z' });
    await settle();
    await shot(theme + '-task-failed');
    check(theme + '任务失败有原因和重试动作', await js("/保留断点/.test(document.getElementById('sysTaskList').textContent) && !!document.querySelector('#sysTaskList button[data-tact=retry]')"));
    await js("sysUI.tasks=window.uiSavedTasks; delete window.uiSavedTasks; renderSysTasks()");
    if (phase !== 'before') await auditSystemSession(theme);
    await js("document.getElementById('settingsMask').classList.remove('on'); openWizard()");
    for (let page = 1; page <= 8; page += 1) {
      await js(`wizardShowPage(${scriptValue(page)})`);
      await shot(theme + '-wizard-' + page);
    }
    await js("document.getElementById('wizardMask').classList.remove('on'); openRepair(null)");
    await shot(theme + '-repair');
    await js("document.getElementById('repairWhyBtn').click()");
    await shot(theme + '-repair-expanded');
    await js("document.getElementById('repairMask').classList.remove('on'); showMenu(innerWidth-10,innerHeight-10,'com.example.notes')");
    await shot(theme + '-menu');
    await js("hideMenu(); state.filter='no-result-fixture'; renderGrid()");
    await shot(theme + '-empty-search');
    await js("state.filter=''; renderGrid(); toast({title:'操作未完成',body:'测试错误反馈：保留原文件，请重试。',type:'error',sticky:true}); document.getElementById('dropzone').classList.add('on')");
    await shot(theme + '-drag-toast');
    await js("document.getElementById('dropzone').classList.remove('on'); document.getElementById('toastWrap').innerHTML='';");
    // 使用真实指针移动触发 Chromium 的 :hover，而不是给截图添加模拟样式。
    const hover = await js("(() => { const r=document.querySelector('.card-launch').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()");
    win.webContents.sendInputEvent({ type:'mouseMove', ...hover });
    await shot(theme + '-hover-state');
    win.webContents.sendInputEvent({ type:'mouseMove', x:2, y:2 });
  }
  if (phase !== 'before') {
    for (const theme of ['light','dark']) {
      await js(`window.apkTheme.save(${scriptValue(theme)})`);
      for (const [width,height] of [[1920,1080],[1600,900],[1366,768],[1280,720],[1024,768],[900,560]]) {
        win.setContentSize(width,height);
        await js("document.querySelectorAll('.modal-mask.on,.settings-page.on').forEach(e=>e.classList.remove('on'))");
        await shot(`${theme}-${width}x${height}-library`, width === 900 || width === 1920);
        await js('openSettings()');
        for (const section of ['general','performance','android','integration']) {
          await js(`openSettingsSection(${scriptValue(section)})`);
          await shot(`${theme}-${width}x${height}-${section}`, false);
          await js(`(() => { const body = document.querySelector('#settingsMask .set-body'); if (body) body.scrollTop = body.scrollHeight; })()`);
          await shot(`${theme}-${width}x${height}-${section}-lower`, false);
        }
        await js("(async () => { document.getElementById('settingsMask').classList.remove('on'); await openWizard(); wizardShowPage(2); })()");
        await shot(`${theme}-${width}x${height}-wizard`, width === 900);
        await js("document.getElementById('wizardMask').classList.remove('on'); openRepair(null)");
        await shot(`${theme}-${width}x${height}-repair`, width === 900);
        await js("document.getElementById('repairMask').classList.remove('on')");
      }
      for (const zoom of [1.25,1.5,2]) {
        win.setContentSize(900,560);
        win.webContents.setZoomFactor(zoom);
        await js('openSettings()');
        for (const section of ['general','runtime','performance','display','android','integration','update','advanced','about']) {
          await js(`openSettingsSection(${scriptValue(section)})`);
          await shot(`${theme}-zoom${zoom}-${section}`, zoom === 2 && section === 'general');
          await js(`(() => { const body = document.querySelector('#settingsMask .set-body'); if (body) body.scrollTop = body.scrollHeight; })()`);
          await shot(`${theme}-zoom${zoom}-${section}-lower`, zoom === 2 && section === 'android');
        }
        await js("document.getElementById('settingsMask').classList.remove('on'); openWizard()");
        for (const page of [1,2,4,8]) {
          await js(`wizardShowPage(${scriptValue(page)})`);
          await shot(`${theme}-zoom${zoom}-wizard${page}`, zoom === 2 && page === 2);
        }
        await js("document.getElementById('wizardMask').classList.remove('on'); openRepair(null)");
        await shot(`${theme}-zoom${zoom}-repair`, zoom === 2);
        await js("document.getElementById('repairMask').classList.remove('on')");
        win.webContents.setZoomFactor(1);
      }
    }
    win.setContentSize(1140,740);
  }
  currentStage = 'load-shell-ui';
  // role 是 renderer 启动参数，切换页面不会改变 preload 权限；外壳必须用单独的 shell 窗口。
  win = makeWindow('shell');
  const themeReadStart = fixture.calls.length;
  await win.loadFile(path.join(SRC, 'ui', 'shell.html'));
  await settle();
  check('应用外壳只暴露 shell 能力和只读主题接口', await js("JSON.stringify(Object.keys(window.apkstart).sort())===JSON.stringify(['getSettings','i18n','on','shell']) && typeof window.require==='undefined' && typeof window.process==='undefined'"));
  check('应用外壳通过 app:theme 读取主题，不读取完整设置', fixture.calls.slice(themeReadStart).some(c => c.channel === 'app:theme') && !fixture.calls.slice(themeReadStart).some(c => c.channel === 'settings:get'));
  await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
  for (const shellTheme of ['light','dark']) {
    await mainWin.webContents.executeJavaScript(`window.apkTheme.save(${scriptValue(shellTheme)})`);
    await settle();
    check(shellTheme + '外壳通过主题推送跟随主界面，未写入设置', await js(`window.apkTheme.preference===${scriptValue(shellTheme)} && document.documentElement.dataset.theme===${scriptValue(shellTheme)}`));
    await js("applyState({label:'云端笔记 · 可恢复的加载状态',tip:'正在启动安卓运行时…',ready:false})");
    await shot(shellTheme + '-shell-loading');
    await js("applyState({label:'云端笔记', ready:true});");
    await shot(shellTheme + '-shell-ready');
    await js("applyState({label:'云端笔记',tip:'显示通道中断，正在重新连接…',ready:false})");
    await shot(shellTheme + '-shell-reconnecting');
    if (phase !== 'before') check(shellTheme+'应用外壳断线后恢复可见加载反馈', await js("!document.getElementById('boot').hidden && !document.getElementById('boot').classList.contains('out')"));
    win.setContentSize(320,420);
    await shot(shellTheme + '-shell-minimum');
    win.setContentSize(1140,740);
  }
  currentStage = 'load-site';
  win.destroy();
  win = makeWindow(null);
  await win.loadFile(path.join(__dirname, '..', 'site', 'index.html'));
  check('网站预览不携带产品 preload 桥接', await js("typeof window.apkstart==='undefined'"));
  currentStage = 'site-screenshot';
  await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
  await shot('website');
  if (phase !== 'before') {
    for (const width of [390,768,1024,1920]) {
      win.setContentSize(width,900);
      for (const siteTheme of ['light','dark']) {
        await js(`document.getElementById(${scriptValue('theme-' + siteTheme)}).click()`);
        for (const section of ['top','features','enhance','flow','requirements','download']) {
          await js(`document.getElementById(${scriptValue(section)}).scrollIntoView({block:'start',behavior:'instant'})`);
          await shot(`website-${siteTheme}-${width}-${section}`, width === 390 || width === 1920);
        }
      }
    }
    win.setContentSize(390,844);
    await js("scrollTo({top:0,behavior:'instant'}); document.querySelector('.nav-toggle').click()");
    await shot('website-mobile-menu');
    check('网站移动导航真实打开且有展开语义', await js("document.querySelector('.nav-toggle').getAttribute('aria-expanded')==='true'"));
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await settle();
    check('网站移动导航Esc关闭并恢复入口焦点', await js("document.querySelector('.nav-toggle').getAttribute('aria-expanded')==='false' && document.activeElement===document.querySelector('.nav-toggle')"));
  }
  const summary = { screens: results.screens.length, unlabelled: [...new Set(results.screens.flatMap(s => s.unlabelled))], overflow: results.screens.filter(s => s.overflowX || s.panelOverflow.length).map(s=>s.name), errors: results.errors };
  check('全部设置分类和向导步骤已渲染', results.screens.length >= 45);
  check('页面无未捕获脚本错误', results.errors.length === 0, results.errors);
  if (phase !== 'before') {
    check('所有已渲染表单都有可访问名称', summary.unlabelled.length === 0, summary.unlabelled);
    check('常规窗口无水平或弹窗越界', summary.overflow.length === 0, summary.overflow);
    const contrastFailures = results.screens.flatMap(s => s.contrast.failures.map(f => ({ screen:s.name, ...f })));
    check('双主题可测纯色背景文字满足AA对比度', contrastFailures.length === 0, contrastFailures.slice(0,15));
    check('双主题背景实际不同', results.screens.find(s => s.name === 'light-library').background !== results.screens.find(s => s.name === 'dark-library').background);
  }
  console.log('UI_AUDIT_DIR=' + out);
  console.log('UI_AUDIT_SUMMARY=' + JSON.stringify(summary));
  fs.writeFileSync(path.join(out, phase, 'results.json'), JSON.stringify(results, null, 2));
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(results.checks.some(c => !c.ok) ? 1 : 0);
}).catch(e => { console.error(`UI renderer failed at ${currentStage}:`, e.stack || e); app.exit(1); });

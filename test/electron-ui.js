'use strict';
/** 双主题真实 Chromium 渲染回归。后端全部内存化，不加载产品 main，不操作 Android。 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFixture } = require('./lib/ui-fixtures');
const { contrastProbe } = require('./lib/ui-probes');
const { runInteractions } = require('./lib/ui-interactions');
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
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  for (const ch of new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map(m => m[1]))) {
    ipcMain.handle(ch, async (_e, payload) => {
      const value = await fixture.respond(ch, payload);
      if (ch === 'settings:set' && payload && payload.theme) nativeTheme.themeSource = value.theme;
      return value;
    });
  }
  const win = new BrowserWindow({ width: 1140, height: 740, useContentSize: true, show: false,
    ...(interactive ? { frame: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#f7f8fa', symbolColor: '#20252d', height:44 } } : {}),
    webPreferences: { preload: path.join(SRC, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: !interactive, backgroundThrottling: false, spellcheck: false } });
  nativeTheme.on('updated', () => {
    if (interactive) nativeColors.updateWindow(win, nativeTheme.shouldUseDarkColors, {overlay:process.platform==='win32'});
    if (!win.isDestroyed()) win.webContents.send('theme:changed', {preference:nativeTheme.themeSource,resolved:nativeTheme.shouldUseDarkColors?'dark':'light'});
  });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|devtools:)/.test(details.url) }));
  win.webContents.on('console-message', ev => { if (ev.level === 'error') results.errors.push(ev.message); });
  win.webContents.on('preload-error', (_e, _file, err) => results.errors.push(String(err)));
  const js = code => win.webContents.executeJavaScript(code);
  const settle = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
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
    const size = await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); return el ? {height:el.clientHeight,max:el.scrollHeight-el.clientHeight} : {height:0,max:0}; })()`);
    for (let top = Math.max(1, size.height * .85), page = 1; top < size.max; top += Math.max(1, size.height * .85), page++) {
      await js(`document.querySelector(${JSON.stringify(selector)}).scrollTop=${top}`);
      await shot(`${name}-scroll${page}`, false);
    }
    if (size.max > 1) {
      await js(`document.querySelector(${JSON.stringify(selector)}).scrollTop=${size.max}`);
      await shot(name + '-bottom', false);
    }
    await js(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(el) el.scrollTop=0; })()`);
  };
  currentStage = 'load-main-ui';
  await win.loadFile(path.join(SRC, 'ui', 'index.html'));
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
  if (phase !== 'before') await runInteractions({ win, fixture, check });
  for (const theme of ['light', 'dark']) {
    await js(`(async () => { if (window.apkTheme) await window.apkTheme.save(${JSON.stringify(theme)}); else { document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.style.colorScheme=${JSON.stringify(theme)}; } })()`);
    if (phase !== 'before') {
      const colors = await js("({bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),text:getComputedStyle(document.documentElement).getPropertyValue('--text').trim()})");
      const native = nativeColors.nativePalette(theme === 'dark');
      check(`${theme}原生窗口与CSS使用同一背景/文字值`, colors.bg === native.background && colors.text === native.foreground, colors);
    }
    await js("document.getElementById('settingsMask').classList.remove('on'); document.getElementById('wizardMask').classList.remove('on'); document.getElementById('repairMask').classList.remove('on');");
    await shot(theme + '-library');
    await js('openSettings()');
    for (const section of ['general','runtime','performance','display','android','integration','update','advanced','about']) {
      await js(`openSettingsSection(${JSON.stringify(section)})`);
      await shot(theme + '-settings-' + section);
      await scanScrollable(theme + '-settings-' + section, '#settingsMask .set-body');
    }
    await js("openSettingsSection('android'); loadSystems()");
    await js("sysUI.selected='android-x86'; renderSysDetail(); document.getElementById('sysCards').scrollIntoView({block:'start'})");
    await shot(theme + '-systems');
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
    await js(`(() => {
      window.uiSavedTasks=sysUI.tasks;
      sysUI.tasks=[{...sysUI.tasks[0],status:'downloading',progress:42,speed:4*2**20,eta:60,currentStep:'正在下载，支持暂停'}];
      renderSysTasks(); openSettingsSection('runtime');
    })()`);
    await shot(theme + '-task-progress');
    check(theme + '下载进度具有名称和真实百分比语义', await js("document.querySelector('#sysTaskList [role=progressbar]')?.getAttribute('aria-valuenow')==='42' && !!document.querySelector('#sysTaskList button[data-tact=pause]')"));
    await js("sysUI.tasks=[{...sysUI.tasks[0],status:'failed',error:'UI 测试：连接中断，保留断点',currentStep:'下载失败'}]; renderSysTasks()");
    await shot(theme + '-task-failed');
    check(theme + '任务失败有原因和重试动作', await js("/保留断点/.test(document.getElementById('sysTaskList').textContent) && !!document.querySelector('#sysTaskList button[data-tact=retry]')"));
    await js("sysUI.tasks=window.uiSavedTasks; delete window.uiSavedTasks; renderSysTasks()");
    await js("document.getElementById('settingsMask').classList.remove('on'); openWizard()");
    for (let page = 1; page <= 8; page += 1) {
      await js(`wizardShowPage(${page})`);
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
      await js(`window.apkTheme.save(${JSON.stringify(theme)})`);
      for (const [width,height] of [[1920,1080],[1600,900],[1366,768],[1280,720],[1024,768],[900,560]]) {
        win.setContentSize(width,height);
        await js("document.querySelectorAll('.modal-mask.on,.settings-page.on').forEach(e=>e.classList.remove('on'))");
        await shot(`${theme}-${width}x${height}-library`, width === 900 || width === 1920);
        await js('openSettings()');
        for (const section of ['general','performance','android','integration']) {
          await js(`openSettingsSection(${JSON.stringify(section)})`);
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
          await js(`openSettingsSection(${JSON.stringify(section)})`);
          await shot(`${theme}-zoom${zoom}-${section}`, zoom === 2 && section === 'general');
          await js(`(() => { const body = document.querySelector('#settingsMask .set-body'); if (body) body.scrollTop = body.scrollHeight; })()`);
          await shot(`${theme}-zoom${zoom}-${section}-lower`, zoom === 2 && section === 'android');
        }
        await js("document.getElementById('settingsMask').classList.remove('on'); openWizard()");
        for (const page of [1,2,4,8]) {
          await js(`wizardShowPage(${page})`);
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
  await win.loadFile(path.join(SRC, 'ui', 'shell.html'));
  await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
  for (const shellTheme of ['light','dark']) {
    await js(`window.apkTheme ? window.apkTheme.save(${JSON.stringify(shellTheme)}) : undefined`);
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
  await win.loadFile(path.join(__dirname, '..', 'site', 'index.html'));
  currentStage = 'site-screenshot';
  await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
  await shot('website');
  if (phase !== 'before') {
    for (const width of [390,768,1024,1920]) {
      win.setContentSize(width,900);
      for (const siteTheme of ['light','dark']) {
        await js(`document.getElementById('theme-${siteTheme}').click()`);
        for (const section of ['top','features','enhance','flow','requirements','download']) {
          await js(`document.getElementById('${section}').scrollIntoView({block:'start',behavior:'instant'})`);
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
  win.destroy();
  app.exit(results.checks.some(c => !c.ok) ? 1 : 0);
}).catch(e => { console.error(`UI renderer failed at ${currentStage}:`, e.stack || e); app.exit(1); });

'use strict';
/** 使用真实渲染层与 Chromium 键盘事件，后端调用只记录到内存。 */
const fs = require('fs');
const path = require('path');
async function runInteractions({ win, fixture, check }) {
  const js = code => win.webContents.executeJavaScript(code);
  const settle = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const key = async (keyCode, modifiers = []) => {
    win.webContents.focus();
    const nativeKey = {ArrowDown:'Down',ArrowUp:'Up',ArrowRight:'Right',ArrowLeft:'Left',Enter:'Return'}[keyCode] || keyCode;
    win.webContents.sendInputEvent({ type:'keyDown', keyCode:nativeKey, modifiers });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers});
    win.webContents.sendInputEvent({ type:'keyUp', keyCode:nativeKey, modifiers });
    await settle();
  };
  await js("document.getElementById('btnSettings').focus(); document.getElementById('btnSettings').click()");
  await settle();
  check('打开设置后焦点进入设置，背景不可操作', await js("document.getElementById('settingsMask').contains(document.activeElement) && document.querySelector('main.shell').inert"));
  await js(`(() => {
    const nodes=[...document.querySelectorAll('#settingsMask button, #settingsMask input, #settingsMask select, #settingsMask [tabindex="0"]')].filter(e=>!e.disabled&&e.getClientRects().length&&!e.closest('[hidden],[inert]'));
    nodes[nodes.length-1].focus();
  })()`);
  await key('Tab');
  check('Tab不会离开活动设置层', await js("document.getElementById('settingsMask').contains(document.activeElement)"));
  await js("document.getElementById('setSearch').value='内存'; document.getElementById('setSearch').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('setSearch').focus()");
  await key('Escape');
  check('搜索框首次Esc清除搜索但保留设置', await js("document.getElementById('setSearch').value==='' && document.getElementById('settingsMask').classList.contains('on')"));
  await key('Escape');
  check('再次Esc关闭设置并恢复入口焦点', await js("!document.getElementById('settingsMask').classList.contains('on') && document.activeElement.id==='btnSettings'"));
  await js("document.getElementById('btnSettings').click()"); await settle();
  await js('openRepair(null)'); await settle();
  check('叠加修复弹窗有模态名称且只允许操作顶层', await js("document.querySelector('#repairMask [role=dialog]')?.getAttribute('aria-labelledby') && document.getElementById('settingsMask').inert && document.getElementById('repairMask').contains(document.activeElement)"));
  await key('Escape');
  check('顶层Esc只关闭修复弹窗，设置仍可继续', await js("!document.getElementById('repairMask').classList.contains('on') && document.getElementById('settingsMask').classList.contains('on') && !document.getElementById('settingsMask').inert"));
  await js("document.getElementById('btnCloseSettings').click()"); await settle();
  await js("document.querySelector('.card-launch').focus()");
  const focusedPackage = await js("document.activeElement.closest('.card').dataset.pkg");
  await js('refreshApps()'); await settle();
  check('应用列表自动刷新后保持同一应用的键盘焦点', await js("document.activeElement.closest('.card')?.dataset.pkg") === focusedPackage);
  await key('Enter');
  check('应用卡片可由Enter调用真实启动入口', fixture.calls.some(c=>c.channel==='app:launch'&&c.payload===focusedPackage));
  await js("document.querySelector('.card-menu-btn').focus(); document.querySelector('.card-menu-btn').click()"); await settle();
  const first = await js("document.activeElement.dataset.act");
  await key('ArrowDown');
  check('应用菜单支持方向键选项导航', (await js("document.activeElement.dataset.act")) !== first && await js("document.activeElement.getAttribute('role')==='menuitem'"));
  await key('Escape');
  check('菜单Esc关闭且恢复到菜单按钮', await js("!document.getElementById('ctxmenu').classList.contains('on') && document.activeElement.classList.contains('card-menu-btn')"));
  await js("document.getElementById('search').value='does-not-exist'; document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}))"); await settle();
  check('无搜索结果与首次空库文案不同，可清除搜索恢复', await js("!document.getElementById('emptySearchClear').hidden && /没有|未找到/.test(document.getElementById('appListStateTitle').innerText)"));
  await js("document.getElementById('emptySearchClear').click()"); await settle();
  check('清除搜索恢复完整真实列表', await js("document.getElementById('search').value==='' && document.querySelectorAll('.card-launch').length===3"));
  await js("document.getElementById('engineTag').click()"); await settle();
  check('运行状态入口定位到运行状态分类', await js("document.querySelector('.set-sec.on')?.dataset.sec==='runtime'"));
  await js("document.querySelector('#setupSteps [data-act=vmStop]').focus(); refreshStatus()"); await settle();
  check('运行状态轮询后保留停止按钮的键盘焦点', await js("document.activeElement.matches('#setupSteps [data-act=vmStop]')"));
  if (process.env.UI_AUDIT_PLATFORM === 'linux') {
    await js("openSettingsSection('display')");
    check('Linux只呈现独立窗口选择且禁用Windows鼠标钩子', await js(`(() => {
      const mode=document.getElementById('setWindowMode');
      return mode.value==='standalone' && [...mode.options].filter(o=>['auto','embedded'].includes(o.value)).every(o=>o.disabled)
        && ['setMouseRightBack','setMouseWheelMode','setMouseSideButtons'].every(id=>document.getElementById(id).disabled)
        && !document.getElementById('windowModeSupportNote').hidden;
    })()`));
    await js("openSettingsSection('integration')");
    check('Linux不展示可执行的Windows桌面集成且不请求关联状态', await js("['setAutoShortcut','setStartMenuShortcut','setShortcutDir','btnRebuildShortcuts','btnAssoc'].every(id=>document.getElementById(id).disabled) && !document.getElementById('integrationSupportNote').hidden") && !fixture.calls.some(c=>c.channel==='assoc:status'));
    await js("openSettingsSection('runtime')");
    check('Linux加速说明使用KVM，不提供Windows系统功能动作', await js("document.getElementById('btnEnableAccel').disabled && document.getElementById('btnOpenFeatures').disabled && document.getElementById('accelHelp').hidden && /KVM/.test(document.getElementById('accelSupportNote').textContent)"));
    check('仅加载设置不会为Linux窗口模式回退写入偏好', !fixture.calls.some(c=>c.channel==='settings:set' && c.payload?.engine?.windowMode));
  }
  await js("openSettingsSection('general'); document.getElementById('setTheme').value='dark'; document.getElementById('setTheme').dispatchEvent(new Event('change',{bubbles:true}))"); await settle();
  check('外观控件实际切换深色并保存', await js("document.documentElement.dataset.theme==='dark' && window.apkTheme.preference==='dark' && !document.getElementById('setTheme').disabled"));
  await js("document.getElementById('setTheme').value='system'; document.getElementById('setTheme').dispatchEvent(new Event('change',{bubbles:true}))"); await settle();
  check('跟随系统与真实Chromium媒体查询一致', await js("window.apkTheme.preference==='system' && document.documentElement.dataset.theme===(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')"));
  await js("document.getElementById('btnCloseSettings').click(); openWizard()"); await settle();
  await js('wizard.deploying=true; wizardShowPage(3)');
  await key('Escape');
  check('部署中不能Esc关闭或返回上步重复部署', await js("document.getElementById('wizardMask').classList.contains('on') && document.getElementById('wizardBack').disabled && document.getElementById('wizardNext').disabled"));
  await js("wizard.deploying=false; wizardShowPage(2)");
  if (process.env.UI_AUDIT_PLATFORM === 'linux') {
    check('Linux向导展示数据目录而不是Windows磁盘选择', await js("document.getElementById('fieldDrives').hidden && !document.getElementById('fieldLinuxDir').hidden && document.getElementById('wizardLinuxDirs').textContent.includes('/home/ui-test/.local/share/apkstart')"));
  } else {
    await js("document.querySelector('#wizardDrives input[type=radio]').focus()");
    await key('ArrowRight');
    check('磁盘选择是有可访问名称的原生单选组', await js("document.getElementById('wizardDrives').getAttribute('role')==='radiogroup' && [...document.querySelectorAll('#wizardDrives input[type=radio]')].every(e=>e.labels.length>0)"));
  }
  if (process.env.UI_AUDIT_PLATFORM !== 'linux') {
    await js('wizard.driveSave');
    const savedSettings = await fixture.respond('settings:get');
    fixture.setResponse('runtime:autoDeploy', () => ({ok:true}));
    await js(`(async () => {
      state.settings=await api.setSettings({runtime:{dir:'',avdDir:''}});
      wizard.selectedDrive='D:'; wizard.driveRequested=''; wizard.driveSave=Promise.resolve(null);
      wizardShowPage(2); wizardDirsPreview();
    })()`);
    check('未操作默认盘符时预览采用推荐盘', await js("document.getElementById('wizardDirs').textContent.includes('D:\\\\ApkStart\\\\runtime')"));
    const start = fixture.calls.length;
    await js('wizardStartDeploy()');
    const deployment = fixture.calls.slice(start);
    const saveIndex = deployment.findIndex(c=>c.channel==='settings:set' && c.payload?.runtime?.dir==='D:\\ApkStart\\runtime' && c.payload.runtime.avdDir==='D:\\ApkStart\\avd');
    check('接受默认推荐盘会先保存精确目录再部署', saveIndex>=0 && deployment.findIndex(c=>c.channel==='runtime:autoDeploy')>saveIndex);
    await js(`(async () => {
      state.settings=await api.setSettings({runtime:{dir:'E:\\\\Custom Runtime',avdDir:'F:\\\\Existing Data'}});
      wizard.driveRequested=''; wizardShowPage(2); wizardDirsPreview();
    })()`);
    const customStart = fixture.calls.length;
    await js('wizardStartDeploy()');
    check('重新运行向导保留已有自定义运行时和数据目录', await js("document.getElementById('wizardDirs').textContent.includes('E:\\\\Custom Runtime') && state.settings.runtime.dir==='E:\\\\Custom Runtime' && state.settings.runtime.avdDir==='F:\\\\Existing Data'") && !fixture.calls.slice(customStart).some(c=>c.channel==='settings:set'&&c.payload?.runtime));
    await js("(async () => { state.settings=await api.setSettings({runtime:{dir:'',avdDir:''}}); wizard.driveRequested=''; wizardShowPage(2); })()");
    fixture.setResponse('settings:set', () => { throw new Error('UI 测试：安装位置保存失败'); });
    const failedStart = fixture.calls.length;
    await js('wizardStartDeploy()');
    check('安装位置未保存时明确失败且不启动部署', !fixture.calls.slice(failedStart).some(c=>c.channel==='runtime:autoDeploy') && await js("!document.getElementById('wizardFail').hidden && /安装位置保存失败/.test(document.getElementById('wizardFailMsg').textContent)"));
    fixture.clearResponse('settings:set');
    await fixture.respond('settings:set', savedSettings);
    await js('(async () => { state.settings=await api.getSettings(); })()');
    fixture.clearResponse('runtime:autoDeploy');
  }
  const original = await fixture.respond('settings:get');
  const info = await fixture.respond('app:info');
  const separator = process.env.UI_AUDIT_PLATFORM === 'linux' ? '/' : '\\';
  const implicitRoot = info.dataDir + separator + 'custom-runtime';
  await js(`(async () => {
    state.settings=await api.setSettings(${JSON.stringify({runtime:{dir:implicitRoot,avdDir:''}})});
    document.getElementById('wizardMask').classList.remove('on');
    await openWizard(); wizardShowPage(2);
  })()`);
  const preview = process.env.UI_AUDIT_PLATFORM === 'linux' ? 'wizardLinuxDirs' : 'wizardDirs';
  check('已有运行时的隐式安卓数据目录使用后端解析值', await js(`document.getElementById(${JSON.stringify(preview)}).textContent.includes(${JSON.stringify(implicitRoot + separator + 'avd')})`));
  await fixture.respond('settings:set', original);
  await js('(async () => { state.settings=await api.getSettings(); state.info=await api.info(); })()');
  await js("wizard.deploying=false; document.getElementById('wizardMask').classList.remove('on'); document.getElementById('toastWrap').innerHTML=''");
  const auditRoot = process.env.UI_AUDIT_DIR;
  const capture = async name => {
    if (!auditRoot) return;
    const dir = path.join(auditRoot, process.env.UI_AUDIT_PHASE || 'after');
    fs.mkdirSync(dir, { recursive: true });
    await settle();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.writeFileSync(path.join(dir, `upstream-${name}.png`), (await win.webContents.capturePage()).toPNG());
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
        await settle();
      }
    }
  };
  await runUpstreamFeatures({ win, fixture, check, capture });
  await settle();
}
module.exports = { runInteractions, runUpstreamFeatures };

/**
 * Upstream #102/#110 acceptance: camera configuration, isolated instances and
 * the explicit panel-only recorder. Every request goes to the in-memory fixture;
 * no ADB, QEMU, filesystem picker, camera or network is reached.
 */
async function runUpstreamFeatures({ win, fixture, check, capture = async () => {} }) {
  const js = code => win.webContents.executeJavaScript(code);
  const settle = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const waitFor = async (expression, timeout = 5000) => {
    await js(`new Promise((resolve, reject) => {
      const deadline = performance.now() + ${timeout};
      const poll = () => {
        if (${expression}) return resolve(true);
        if (performance.now() > deadline) return reject(new Error('UI 条件等待超时：' + ${JSON.stringify(expression)}));
        setTimeout(poll, 20);
      };
      poll();
    })`);
  };
  const waitForCall = async (channel, start, predicate = () => true, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const call = fixture.calls.slice(start).find(candidate => candidate.channel === channel && predicate(candidate));
      if (call) return call;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`UI 条件等待超时：未收到 ${channel}`);
  };
  const click = async selector => {
    await js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('缺少界面元素：' + ${JSON.stringify(selector)});
      el.click();
    })()`);
    await settle();
  };
  const open = async section => {
    await js(`openSettings({section:${JSON.stringify(section)}})`);
    await waitFor(`document.getElementById('settingsMask').classList.contains('on')
      && !!document.querySelector(${JSON.stringify(`.set-sec[data-sec="${section}"]`)})
      && document.querySelector(${JSON.stringify(`.set-sec[data-sec="${section}"]`)}).classList.contains('on')
      && document.getElementById('settingsLoading').hidden && !document.getElementById('setBody').inert`);
    await settle();
  };
  const section = async name => { await js(`openSettingsSection(${JSON.stringify(name)})`); await settle(); };
  const setTheme = async theme => {
    await js(`window.apkTheme.save(${JSON.stringify(theme)})`);
    await waitFor(theme === 'system'
      ? "window.apkTheme.preference==='system' && ['light','dark'].includes(document.documentElement.dataset.theme)"
      : `window.apkTheme.preference===${JSON.stringify(theme)} && document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    await settle();
  };
  const changeLanguage = async lang => {
    await js(`changeLanguage(${JSON.stringify(lang)})`);
    await waitFor(`window.apkI18n && window.apkI18n.lang===${JSON.stringify(lang)} && !languageBusy`);
    await settle();
  };
  const selectValue = async (id, value) => {
    await js(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) throw new Error('缺少控件：' + ${JSON.stringify(id)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
  };

  const expectedScale = Number(process.env.UI_AUDIT_SCALE || 1);
  const observedScale = await js('devicePixelRatio');
  check('新增功能面板在默认/指定显示比例下可渲染', Math.abs(observedScale - expectedScale) < 0.01,
    { requested: expectedScale, observed: observedScale });

  await open('automation');
  await waitFor("document.querySelector('#automationPanel [data-automation=target]')?.textContent.includes('检测到')");
  const notice = await js("document.querySelector('#automationPanel [data-automation=notice]')?.textContent || ''");
  check('自动化面板明示仅记录本面板，不监听原生窗口/全局键盘', notice.includes('只记录本面板')
    && notice.includes('不录原生窗口/全局键盘') && notice.includes('不是全局真实输入录制'), notice);
  check('自动化面板自带 tap/swipe/key/text/wait、录制、回放、取消与 JSON 编辑框', await js(
    "['tap-form','swipe-form','key-form','text-form','wait-form','record-start','record-stop','replay','cancel','json'].every(name => !!document.querySelector('[data-automation=\"' + name + '\"]'))"));
  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    await capture(`automation-${theme}`);
    const layout = await js(`(() => {
      const panel = document.getElementById('automationPanel');
      const body = document.getElementById('setBody');
      return { visible: !!panel && panel.getClientRects().length > 0, overflow: !!panel && panel.scrollWidth > panel.clientWidth + 1,
        bodyOverflow: !!body && body.scrollWidth > body.clientWidth + 1 };
    })()`);
    check(`自动化面板${theme}主题可见、无横向溢出`, layout.visible && !layout.overflow && !layout.bodyOverflow, layout);
  }
  await setTheme('light');

  // Camera selection is saved through the real renderer event path and read back
  // after closing/reopening settings. "List host cameras" is fixture-only.
  await section('display');
  const webcamStart = fixture.calls.length;
  await click('#btnListWebcams');
  const listed = await waitForCall('peripherals:webcams', webcamStart);
  await waitFor("[...document.querySelectorAll('#setCameraBack option')].some(option => option.value === 'webcam0')");
  check('列出主机摄像头使用固定夹具设备并仅在用户点击后执行', listed && await js("document.getElementById('setCameraBack').value==='none'"));
  const cameraSaveStart = fixture.calls.length;
  await selectValue('setCameraBack', 'webcam0');
  const cameraSave = await waitForCall('settings:set', cameraSaveStart,
    call => call.payload?.peripherals?.cameraBack === 'webcam0');
  check('摄像头选择保存到 peripherals.cameraBack', !!cameraSave
    && await js("document.getElementById('setCameraBack').value==='webcam0'"), cameraSave?.payload);
  await js("closeSettings()"); await settle();
  await open('display');
  check('重新打开设置读回已保存的摄像头配置', await js("document.getElementById('setCameraBack').value==='webcam0'"));
  const refreshStart = fixture.calls.length;
  await click('#btnVerifyRefresh');
  await waitFor("document.getElementById('refreshRateStatus').textContent.includes('客机 60 Hz')");
  check('刷新率读回显示客机活动值并标注与请求一致', await js("document.getElementById('refreshRateStatus').textContent.includes('与请求一致')"));
  const rateStart = fixture.calls.length;
  await selectValue('setRefreshRate', '120');
  await waitForCall('settings:set', rateStart, call => call.payload?.peripherals?.refreshRate === 120);
  await click('#btnVerifyRefresh');
  await waitFor("document.getElementById('refreshRateStatus').textContent.includes('与请求不一致')");
  check('刷新率请求与实际读回不一致时如实提示', await js("document.getElementById('refreshRateStatus').textContent.includes('与请求不一致')"));
  await js("(async () => { state.settings = await api.setSettings({ peripherals: { cameraBack:'none', cameraFront:'none', refreshRate:60, serialPort:'' } }); fillSettings(state.settings); })()");
  check('摄像头与刷新率夹具调用未触碰真实设备/网络', fixture.calls.slice(webcamStart).every(call =>
    !/^(shell:|adb:|runtime:(start|stop)|app:launch)/.test(call.channel)));

  // Isolated instances: create, launch the selected app, then refresh its state.
  await section('automation');
  await waitFor("!instancesBusy && !!document.querySelector('#instancesList')");
  await waitFor("[...document.querySelectorAll('#instanceApp option')].length >= 3");
  await js(`(() => {
    document.getElementById('instanceName').value = '工作分身';
    const select = document.getElementById('instanceApp');
    select.value = 'com.example.reader';
  })()`);
  const instanceStart = fixture.calls.length;
  await click('#btnCreateInstance');
  const created = await waitForCall('instances:create', instanceStart);
  await waitFor("document.getElementById('instancesList').textContent.includes('工作分身')");
  const instances = await fixture.respond('instances:list');
  const instanceId = instances.find(item => item.name === '工作分身')?.id;
  check('创建分身记录名称并在列表中显示', created?.payload?.name === '工作分身'
    && !!instanceId && await js("document.getElementById('instancesList').textContent.includes('工作分身')"), created?.payload);
  const launchStart = fixture.calls.length;
  await js("document.querySelector('#instancesList button').click()");
  const launched = await waitForCall('instances:launch', launchStart);
  await waitFor("document.querySelector('#toastWrap').textContent.includes('已发送到分身')");
  check('在分身中打开只把当前选择的应用发给指定分身', launched?.payload?.id === instanceId
    && launched?.payload?.package === 'com.example.reader', launched?.payload);
  const refreshInstancesStart = fixture.calls.length;
  await click('#btnRefreshInstances');
  await waitForCall('instances:list', refreshInstancesStart);
  await waitFor("document.getElementById('instancesList').textContent.includes('已启动')");
  check('刷新分身列表读回运行状态且未调用主实例启动入口', !fixture.calls.slice(instanceStart).some(call => call.channel === 'app:launch')
    && await js("document.getElementById('instancesList').textContent.includes('已启动')"));

  fixture.setResponse('instances:list', () => [{ id: instanceId, name: '归属待核验',
    state: 'unknown', running: false, external: true, needsVerification: true }]);
  await click('#btnRefreshInstances');
  await waitFor("!instancesBusy && document.getElementById('instancesList').textContent.includes('需手动核验')");
  const unknownStart = fixture.calls.length;
  await js("document.querySelector('#instancesList button').click()");
  await settle();
  check('分身归属未知时显示需手动核验并阻止重复启动',
    await js("document.querySelector('#instancesList button').disabled && !document.getElementById('instancesList').textContent.includes('未启动')")
    && !fixture.calls.slice(unknownStart).some(call => call.channel === 'instances:launch'));
  fixture.clearResponse('instances:list');
  await click('#btnRefreshInstances');
  await waitFor("!instancesBusy && document.getElementById('instancesList').textContent.includes('工作分身')");

  // Panel-only recording and replay. The local bridge records only actions that
  // this panel successfully sent; it is not a native window or global recorder.
  await section('automation');
  await waitFor("document.querySelector('#automationPanel [data-automation=target]')?.textContent.includes('检测到')");
  await click('#automationPanel [data-automation=bind]');
  await waitFor("document.querySelector('#automationPanel [data-automation=target]')?.textContent.includes('已绑定')");
  const recordStart = fixture.calls.length;
  await click('#automationPanel [data-automation=record-start]');
  await waitFor("document.querySelector('#automationPanel [data-automation=record-state]').textContent.includes('正在录制')");
  await js(`(() => {
    document.querySelector('#automationPanel [data-automation=tap-x]').value = '0.25';
    document.querySelector('#automationPanel [data-automation=tap-y]').value = '0.75';
  })()`);
  const actionStart = fixture.calls.length;
  await click('#automationPanel [data-automation=tap-send]');
  const action = await waitForCall('automation:action', actionStart);
  await waitFor("!document.querySelector('#automationPanel fieldset').disabled");
  check('面板显式点击通过自动化 IPC 发送到绑定目标', action?.payload?.target?.instanceId === 'ui-session-1'
    && action?.payload?.action?.type === 'tap' && action?.payload?.action?.x === 0.25
    && action?.payload?.action?.y === 0.75, action?.payload);
  const keyCount = fixture.calls.filter(call => call.channel === 'automation:action').length;
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); window.dispatchEvent(new MouseEvent('click', { bubbles: true }));");
  await settle();
  check('面板外的全局键盘/点击不会被采集为自动化动作',
    fixture.calls.filter(call => call.channel === 'automation:action').length === keyCount);
  await click('#automationPanel [data-automation=record-stop]');
  await waitFor("document.querySelector('#automationPanel [data-automation=json]').value.length > 0");
  await waitFor("!document.querySelector('#automationPanel [data-automation=json]').disabled");
  const recorded = JSON.parse(await js("document.querySelector('#automationPanel [data-automation=json]').value"));
  check('停止录制得到可导入的 JSON，坐标保持 0..1 规范化值', recorded.version === 1
    && recorded.target?.instanceId === 'ui-session-1'
    && recorded.actions.some(item => item.type === 'tap' && item.x === 0.25 && item.y === 0.75), recorded);

  const importStart = fixture.calls.length;
  await js(`(() => {
    const editor = document.querySelector('#automationPanel [data-automation=json]');
    editor.value = ${JSON.stringify(JSON.stringify(recorded))};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click('#automationPanel [data-automation=import]');
  await waitForCall('automation:validate', importStart);
  await waitFor("!document.querySelector('#automationPanel [data-automation=json]').disabled");
  check('JSON 只校验/导入文本，不会自动执行', !fixture.calls.slice(importStart).some(call => call.channel === 'automation:run'));
  const invalidStart = fixture.calls.length;
  await js(`(() => {
    const editor = document.querySelector('#automationPanel [data-automation=json]');
    editor.value = ${JSON.stringify(JSON.stringify({
      version: 1, target: { packageName: 'com.example.notes', serial: 'ui-fixture', instanceId: 'ui-session-1' },
      actions: [{ type: 'exec', command: 'id' }],
    }))};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click('#automationPanel [data-automation=import]');
  await waitFor("document.querySelector('#automationPanel [data-automation=status]').textContent.includes('仅允许 tap/swipe/key/text/wait')");
  await waitFor("!document.querySelector('#automationPanel [data-automation=json]').disabled");
  check('导入非法 exec 动作被拒绝且没有执行请求', !fixture.calls.slice(invalidStart).some(call => call.channel === 'automation:run'));
  await js(`(() => {
    const editor = document.querySelector('#automationPanel [data-automation=json]');
    editor.value = ${JSON.stringify(JSON.stringify(recorded))};
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click('#automationPanel [data-automation=import]');
  const replayStart = fixture.calls.length;
  await click('#automationPanel [data-automation=replay]');
  const replay = await waitForCall('automation:run', replayStart);
  await waitFor("document.querySelector('#automationPanel [data-automation=status]').textContent.includes('回放已完成')");
  await waitFor("!document.querySelector('#automationPanel [data-automation=json]').disabled");
  check('回放只发送经过校验、绑定同一实例的录制脚本', replay?.payload?.script?.actions?.some(item => item.type === 'tap')
    && replay?.payload?.script?.target?.instanceId === 'ui-session-1');

  let releaseRun, runRequested;
  const pendingRun = new Promise(resolve => { releaseRun = resolve; runRequested = resolve; });
  fixture.setResponse('automation:run', () => new Promise(resolve => {
    releaseRun = resolve; runRequested();
  }));
  const cancelStart = fixture.calls.length;
  await click('#automationPanel [data-automation=replay]');
  await pendingRun;
  await click('#automationPanel [data-automation=cancel]');
  const cancelled = await waitForCall('automation:cancel', cancelStart);
  releaseRun({ ok: false, status: 'cancelled' });
  await settle();
  const cancelFeedback = await js("document.querySelector('#automationPanel [data-automation=status]').textContent");
  check('回放中取消会调用自动化取消入口并保留停止反馈', !!cancelled
    && /已请求停止|回放已取消/.test(cancelFeedback), cancelFeedback);
  fixture.clearResponse('automation:run');

  // Translation coverage of the new settings headings plus the camera labels.
  const expected = {
    'en-US': ['Isolated instance', 'Action scripts and panel recording'],
    'es-ES': ['Instancia aislada', 'Scripts de acciones y grabación del panel'],
    'vi-VN': ['Phiên bản độc lập', 'Tập lệnh thao tác và ghi bảng điều khiển'],
    'ru-RU': ['Изолированный экземпляр', 'Скрипты действий и запись панели'],
  };
  const bindLabels = {
    'en-US': 'Bind current app instance',
    'es-ES': 'Vincular la instancia actual de la aplicación',
    'vi-VN': 'Liên kết phiên bản ứng dụng hiện tại',
    'ru-RU': 'Привязать текущий экземпляр приложения',
  };
  for (const [lang, titles] of Object.entries(expected)) {
    await changeLanguage(lang);
    const actual = await js("[...document.querySelectorAll('.set-sec[data-sec=\"automation\"] .group-title')].map(node => node.textContent)");
    check(`新增面板标题在 ${lang} 下切换为本地译文`, titles.every(title => actual.includes(title)), actual);
    const panel = await js("({bind:document.querySelector('#automationPanel [data-automation=bind]').textContent, notice:document.querySelector('#automationPanel [data-automation=notice]').textContent})");
    check(`自动化内部按钮与安全说明在 ${lang} 下完成翻译`, panel.bind === bindLabels[lang]
      && !!panel.notice && !/[\u3400-\u9fff]/u.test(panel.notice), panel);
  }
  await section('display');
  await changeLanguage('es-ES');
  check('摄像头设置标签切换为西班牙语', await js("document.querySelector('label[for=setCameraBack]').textContent==='Cámara trasera'"));
  await changeLanguage('ru-RU');
  check('摄像头设置标签切换为俄语', await js("document.querySelector('label[for=setCameraBack]').textContent==='Задняя камера'"));
  await changeLanguage('vi-VN');
  check('摄像头设置标签切换为越南语', await js("document.querySelector('label[for=setCameraBack]').textContent==='Camera sau'"));
  await changeLanguage('zh-CN');
  check('新增摄像头设置标签切回中文', await js("document.querySelector('label[for=setCameraBack]').textContent==='后置摄像头'"));

  await js("(async () => { state.settings = await api.setSettings({ peripherals: { cameraBack:'none', cameraFront:'none', refreshRate:60, serialPort:'' } }); fillSettings(state.settings); })()");
  await setTheme('system');
  await js("closeSettings(); document.getElementById('toastWrap').innerHTML=''");
  await settle();
}

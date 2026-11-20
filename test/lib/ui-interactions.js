'use strict';
/** 使用真实渲染层与 Chromium 键盘事件，后端调用只记录到内存。 */
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
  await settle();
}
module.exports = { runInteractions };

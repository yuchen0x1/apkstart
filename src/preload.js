'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const subscribe = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const shell = {
  state: () => invoke('shell:state'),
  minimize: () => invoke('shell:minimize'),
  maximize: () => invoke('shell:maximize'),
  close: () => invoke('shell:close'),
  rotate: () => invoke('shell:rotate'),
  back: () => invoke('shell:back'),
  forward: () => invoke('shell:forward'),
  home: () => invoke('shell:home'),
  recent: () => invoke('shell:recent'),
  onState: (cb) => subscribe('shell:state', cb),
};

// 角色由 BrowserWindow 的 additionalArguments 指定。这里只缩小桥接面，
// 主进程仍独立根据真实 webContents 校验每次调用，不以此参数作为授权依据。
const isShell = process.argv.includes('--apkstart-role=shell');
const isMain = !isShell && process.argv.includes('--apkstart-role=main');
if (isShell) contextBridge.exposeInMainWorld('apkstart', {
  i18n: () => invoke('app:i18n'),
  // theme.js 只读取 theme，保留旧方法名但不暴露完整设置。
  getSettings: () => invoke('app:theme'),
  on: (channel, cb) => channel === 'theme:changed' ? subscribe(channel, cb) : () => {},
  shell,
});

if (isMain) contextBridge.exposeInMainWorld('apkstart', {
  info: () => invoke('app:info'),
  i18n: () => invoke('app:i18n'),
  listApps: () => invoke('apps:list'),
  pickApk: () => invoke('apk:pick'),
  parseApk: (p) => invoke('apk:parse', p),
  fileKind: (p) => invoke('apk:kind', p),
  compatApk: (p) => invoke('apk:compat', p),
  installApk: (p) => invoke('apk:install', p),
  launch: (pkg) => invoke('app:launch', pkg),
  instances: {
    list: () => invoke('instances:list'),
    create: (payload) => invoke('instances:create', payload),
    launch: (id, pkg) => invoke('instances:launch', { id, package: pkg }),
  },
  peripherals: {
    webcams: () => invoke('peripherals:webcams'),
    refresh: () => invoke('peripherals:refresh'),
  },
  automation: {
    target: () => invoke('automation:target'),
    status: () => invoke('automation:status'),
    validate: (payload) => invoke('automation:validate', payload),
    run: (payload) => invoke('automation:run', payload),
    action: (payload) => invoke('automation:action', payload),
    cancel: () => invoke('automation:cancel'),
  },
  uninstall: (pkg) => invoke('app:uninstall', pkg),
  createShortcut: (pkg) => invoke('app:shortcut', pkg),
  clearData: (pkg) => invoke('app:clearData', pkg),
  pin: (pkg, pinned) => invoke('app:pin', { pkg, pinned }),
  revealApk: (pkg) => invoke('app:revealApk', pkg),
  exportApk: (pkg) => invoke('app:exportApk', pkg),
  backupApp: (pkg) => invoke('app:backup', pkg),
  restoreApp: () => invoke('app:restore'),
  revealApkDir: () => invoke('apk:reveal'),
  openDir: () => invoke('dialog:openDir'),

  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  restoreSystemApps: () => invoke('settings:restoreSystem'),
  refreshPointerMapping: () => invoke('settings:refreshPointer'),
  restoreMouseHook: () => invoke('settings:unhook'),

  // 安卓客机：系统语言汉化 + 预装应用精简/恢复
  guestState: () => invoke('guest:state'),
  guestTrim: (groups) => invoke('guest:trim', { groups: groups || [] }),
  guestRestore: () => invoke('guest:restore'),
  guestLocalize: (locale) => invoke('guest:localize', { locale: locale || 'zh-CN' }),
  guestOpenLocaleSettings: () => invoke('guest:openLocaleSettings'),

  runtimeStatus: () => invoke('runtime:status'),
  setImageFlavor: (flavor) => invoke('runtime:setImageFlavor', flavor),
  runtimeProbe: () => invoke('runtime:probe'),
  androidHome: () => invoke('runtime:androidHome'),
  runtimeStart: (opts) => invoke('runtime:start', opts || {}),
  repairPlan: () => invoke('runtime:repairPlan'),
  repairRun: (opts) => invoke('runtime:repairRun', opts || {}),
  reportPrepare: () => invoke('report:prepare'),
  reportSubmit: () => invoke('report:submit'),
  reportFolder: () => invoke('report:folder'),
  runtimeStop: () => invoke('runtime:stop'),
  runtimeLog: () => invoke('runtime:log'),
  doctorProfile: () => invoke('doctor:profile'),
  doctorReport: () => invoke('doctor:report'),
  vcRedist: () => invoke('runtime:vcRedist'),
  installVcRedist: () => invoke('runtime:installVcRedist'),
  runtimeUsage: () => invoke('runtime:usage'),
  runtimeCleanup: (opts) => invoke('runtime:cleanup', opts || {}),
  runtimeResetData: () => invoke('runtime:resetData'),
  runtimeRepairNetwork: () => invoke('runtime:repairNetwork'),
  runtimeCheckNetwork: () => invoke('runtime:checkNetwork'),
  dataInfo: () => invoke('runtime:dataInfo'),
  setDataSize: (gb) => invoke('runtime:setDataSize', gb),
  confirm: (opts) => invoke('app:confirm', opts || {}),
  displayState: () => invoke('display:state'),
  displaySet: (patch) => invoke('display:set', patch || {}),
  displayToggle: () => invoke('display:toggle'),
  rebuildShortcuts: () => invoke('shortcut:rebuild'),
  autoDeploy: () => invoke('runtime:autoDeploy'),
  startInstaller: () => invoke('runtime:startInstaller'),
  markInstalled: () => invoke('runtime:markInstalled'),
  resetInstall: () => invoke('runtime:resetInstall'),

  provisionCheck: () => invoke('provision:check'),
  provisionProbeSources: () => invoke('provision:probeSources'),
  installAdb: () => invoke('provision:installAdb'),
  installQemu: () => invoke('provision:installQemu'),
  installEmulator: () => invoke('provision:installEmulator'),
  installSysimg: () => invoke('provision:installSysimg'),
  installPlayImage: () => invoke('provision:installPlayImage'),
  installAehd: () => invoke('provision:installAehd'),
  enableAccel: () => invoke('provision:enableAccel'),
  enableVirtualization: () => invoke('provision:enableVirtualization'),
  accelStatus: () => invoke('provision:accelStatus'),
  downloadIso: () => invoke('provision:downloadIso'),
  createDisk: (gb) => invoke('provision:createDisk', gb),
  importIso: () => invoke('provision:importIso'),
  importRuntimePack: () => invoke('provision:importRuntimePack'),
  importDisk: () => invoke('provision:importDisk'),

  // 自定义镜像（可插拔 image adapter）：导入 / 启用 / 恢复默认 / 移除
  imageStatus: () => invoke('image:status'),
  imageInspect: (src) => invoke('image:inspect', src),
  imageImport: (opts) => invoke('image:import', opts || {}),
  imageActivate: (id) => invoke('image:activate', id),
  imageRestore: () => invoke('image:restore'),
  imageRemove: (id) => invoke('image:remove', id),
  imageReveal: (id) => invoke('image:reveal', id),

  // 多系统（LineageOS / Bliss OS / Android-x86 / 内置档位）按需下载与切换
  systemList: () => invoke('system:list'),
  systemDetail: (id) => invoke('system:detail', id),
  systemCatalogRefresh: () => invoke('system:catalogRefresh'),
  systemInstall: (id) => invoke('system:install', id),
  systemConfirmInstall: (taskId) => invoke('system:confirmInstall', taskId),
  systemSwitch: (payload) => invoke('system:switch', payload || {}),
  systemStop: () => invoke('system:stop'),
  systemPause: (taskId) => invoke('system:pause', taskId),
  systemResume: (taskId) => invoke('system:resume', taskId),
  systemCancel: (taskId) => invoke('system:cancel', taskId),
  systemRetry: (taskId) => invoke('system:retry', taskId),
  systemTasks: () => invoke('system:tasks'),
  systemStatus: () => invoke('system:status'),
  systemOpenDir: (payload) => invoke('system:openDir', payload || {}),
  systemBackup: (payload) => invoke('system:backup', payload || {}),
  systemRestore: (payload) => invoke('system:restore', payload || {}),
  systemRemove: (id) => invoke('system:remove', id),
  systemImportLineage: () => invoke('system:importLineage'),
  systemDiskUsage: () => invoke('system:diskUsage'),

  selfCheck: () => invoke('doctor:selfCheck'),
  clearLocks: () => invoke('app:clearLocks'),
  removeSelf: () => invoke('app:removeSelf'),
  setSharedDir: (dir) => invoke('settings:setSharedDir', dir),

  // 在线更新（GitHub Releases）
  updateCheck: (opts) => invoke('app:updateCheck', opts || {}),
  updateApply: () => invoke('app:updateApply'),
  updateCancel: () => invoke('app:updateCancel'),
  updateOpenRelease: (url) => invoke('app:updateOpen', url),
  restartApp: () => invoke('app:restart'),

  assocStatus: () => invoke('assoc:status'),
  assocRegister: () => invoke('assoc:register'),
  assocUnregister: () => invoke('assoc:unregister'),

  syncShared: () => invoke('share:sync'),
  openSharedDir: () => invoke('share:open'),

  openExternal: (url) => invoke('shell:open', url),
  openPath: (p) => invoke('shell:openPath', p),
  openWindowsFeatures: () => invoke('system:openWindowsFeatures'),

  // 首次运行引导向导
  sysDrives: () => invoke('sys:drives'),
  wizardOpen: () => invoke('wizard:open'),
  wizardClose: () => invoke('wizard:close'),
  winMinimize: () => invoke('window:minimize'),
  winMaximize: () => invoke('window:maximize'),
  winClose: () => invoke('window:close'),
  winHide: () => invoke('window:hide'),
  bringAppToFront: () => invoke('app:foreground'),

  // 应用窗口（只有 旋转 / 最小化 / 最大化 / 关闭）用到的接口
  shell: {
    state: () => invoke('shell:state'),
    minimize: () => invoke('shell:minimize'),
    maximize: () => invoke('shell:maximize'),
    close: () => invoke('shell:close'),
    rotate: () => invoke('shell:rotate'),
    back: () => invoke('shell:back'),
    forward: () => invoke('shell:forward'),
    home: () => invoke('shell:home'),
    recent: () => invoke('shell:recent'),
    onState: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('shell:state', handler);
      return () => ipcRenderer.removeListener('shell:state', handler);
    },
  },

  // 安卓系统设置（WiFi / 音量 / 显示 / 动画 / 权限 …）
  android: {
    status: () => invoke('android:status'),
    set: (key, value) => invoke('android:set', { key, value }),
    open: (action) => invoke('android:open', action),
    tune: (pkg) => invoke('android:tune', pkg),
    permissions: (pkg) => invoke('android:permissions', pkg),
    grantAll: (pkg) => invoke('android:grantAll', pkg),
  },

  pathForFile: (file) => webUtils.getPathForFile(file),

  on: (channel, cb) => {
    const allowed = [
      'install:start', 'install:progress', 'install:done', 'install:error',
      'app:launched', 'runtime:log', 'toast', 'ui:navigate', 'provision:progress',
      'update:progress', 'update:state', 'system:task', 'system:log', 'theme:changed', 'automation:state',
    ];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

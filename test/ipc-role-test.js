'use strict';
// Execute production registration/preload code in a VM: no Electron, processes or user data.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const ipcguard = require('../src/core/ipcguard');
const ROOT = path.resolve(__dirname, '../src');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const ipcSource = source.slice(source.indexOf('// ---------------- IPC 安全边界'), source.indexOf('// ---------------- 生命周期'));
assert(ipcSource.includes('function registerIpc()'));
function windowFor(page) {
  const mainFrame = { url: pathToFileURL(path.join(ROOT, 'ui', page)).href };
  const win = { destroyed: false, isDestroyed() { return this.destroyed; },
    webContents: { mainFrame, isDestroyed() { return win.destroyed; } },
    minimize() {}, maximize() {}, unmaximize() {}, isMaximized: () => false, close() {} };
  return win;
}
function eventFor(win) { return { sender: win.webContents, senderFrame: win.webContents.mainFrame }; }
function harness() {
  const handlers = new Map();
  const mainWindow = windowFor('index.html');
  const shellWindow = windowFor('shell.html');
  const calls = { reset: 0, dialogs: [], opened: [], patches: [], shell: [] };
  let response = 0;
  let settings = { theme: 'dark', runtime: { secret: 'private' } };
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), handleOnce: (c, fn) => handlers.set(c, fn) };
  const context = vm.createContext({
    path, __dirname: ROOT, ipcguard, ipcMain, console: { warn() {} },
    currentSystemStatus: null,
    instanceContext: { isChild: false, id: null }, automation: null,
    channelMode: require('../src/core/runtime-actions').channelMode,
    createReportDelivery: require('../src/core/report-delivery').createReportDelivery,
    runtimeActions: { run: (_channel, action) => action() },
    mainWindow, appWin: { win: shellWindow, isOpen: false, state: { label: 'App' },
      scheduleFit() {}, rotate: () => calls.shell.push('rotate'), close: () => calls.shell.push('close') },
    BrowserWindow: { fromWebContents: wc => [mainWindow, shellWindow].find(w => w.webContents === wc) },
    runtime: { resetAndroidData: async () => { calls.reset++; return { ok: true, reclaimed: 1048576 }; },
      client: () => ({ keyBack: async () => calls.shell.push('back'), keyForward: async () => calls.shell.push('forward') }) },
    store: { DATA_DIR: path.join(ROOT, 'fake-data'), getSettings: () => settings,
      saveSettings: p => { calls.patches.push(p); return { ...settings, ...p }; } },
    i18n: { payload: () => ({ language: 'zh-CN' }) }, app: { getLocale: () => 'zh-CN' },
    dialog: { showMessageBox: async (win, opts) => { calls.dialogs.push({ win, opts }); return { response }; } },
    fs: { statSync: p => {
      if (p.endsWith('missing')) throw new Error('ENOENT');
      return { isDirectory: () => p.endsWith('directory') };
    } },
    shell: { openPath: p => { calls.opened.push(p); return Promise.resolve(''); } },
  });
  vm.runInContext(ipcSource + '\nregisterIpc();', context, { filename: 'main.js IPC (production)' });
  return { handlers, mainWindow, shellWindow, calls, context,
    setResponse: n => { response = n; },
    setSettings: s => { settings = s; },
    invoke: (win, channel, payload) => Promise.resolve().then(() => handlers.get(channel)(eventFor(win), payload)) };
}

for (const channel of ['runtime:resetData', 'settings:set', 'shell:openPath', 'app:removeSelf',
  'app:updateApply', 'provision:installEmulator', 'image:import', 'system:remove', 'android:grantAll', 'window:close',
  'instances:create', 'instances:launch', 'peripherals:webcams', 'peripherals:refresh', 'automation:run', 'automation:action', 'automation:cancel']) {
  test(`shell cannot invoke privileged channel ${channel}`, async () => {
    const h = harness();
    await assert.rejects(h.invoke(h.shellWindow, channel, {}), /IPC/);
    assert.equal(h.calls.dialogs.length, 0);
    assert.equal(h.calls.reset, 0);
    assert.equal(h.calls.patches.length, 0);
  });
}
test('child instances cannot mutate shared components or global integration', async () => {
  const h = harness();
  h.context.instanceContext.isChild = true;
  for (const channel of ['provision:installQemu', 'system:switch', 'image:import', 'app:removeSelf',
    'app:updateApply', 'assoc:register', 'instances:create', 'shortcut:rebuild']) {
    await assert.rejects(h.invoke(h.mainWindow, channel, {}), /主实例/);
  }
  assert.equal(h.calls.dialogs.length, 0);
  assert.equal(h.calls.patches.length, 0);
  assert.equal((await h.invoke(h.mainWindow, 'settings:get')).theme, 'dark');
});
test('existing main channels remain available and shell-only or future channels fail closed', async () => {
  const h = harness();
  const shellOnly = new Set(['shell:state', 'shell:minimize', 'shell:maximize', 'shell:close',
    'shell:rotate', 'shell:back', 'shell:forward']);
  // Replace the business body only; retain the real guard installed by production registration.
  for (const channel of h.handlers.keys()) {
    h.context.ipcMain.handle(channel, () => 'allowed');
    if (shellOnly.has(channel)) await assert.rejects(h.invoke(h.mainWindow, channel), /IPC/);
    else assert.equal(await h.invoke(h.mainWindow, channel), 'allowed', channel);
  }
  h.context.ipcMain.handle('future:privileged', () => 'unsafe');
  await assert.rejects(h.invoke(h.mainWindow, 'future:privileged'), /IPC/);
  h.context.ipcMain.handleOnce('future:once', () => 'unsafe');
  await assert.rejects(h.invoke(h.shellWindow, 'future:once'), /IPC/);
});
test('shell retains titlebar, Android navigation, i18n and theme read capabilities', async () => {
  const h = harness();
  h.context.appWin.isOpen = true;
  for (const channel of ['shell:state', 'shell:minimize', 'shell:maximize', 'shell:rotate', 'shell:back', 'shell:forward', 'app:i18n']) {
    await h.invoke(h.shellWindow, channel);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await h.invoke(h.shellWindow, 'app:theme'))), { theme: 'dark' });
  await h.invoke(h.shellWindow, 'shell:close');
  assert.deepEqual(h.calls.shell, ['rotate', 'back', 'forward', 'close']);
  await assert.rejects(h.invoke(h.shellWindow, 'settings:get'), /IPC/);
});
test('trusted URL, copied webContents id, or shell navigation to index never grants main privileges', async () => {
  const h = harness();
  const impostor = windowFor('index.html');
  impostor.webContents.id = h.mainWindow.webContents.id = 7;
  await assert.rejects(h.invoke(impostor, 'settings:get'), /IPC/);
  h.shellWindow.webContents.mainFrame.url = h.mainWindow.webContents.mainFrame.url;
  await assert.rejects(h.invoke(h.shellWindow, 'settings:set', {}), /IPC/);
});
test('role is checked against the current live windows, not stale references', async () => {
  const h = harness();
  h.context.mainWindow = windowFor('index.html');
  await assert.rejects(h.invoke(h.mainWindow, 'settings:get'), /IPC/);
  h.context.mainWindow.destroyed = true;
  await assert.rejects(h.invoke(h.context.mainWindow, 'settings:get'), /IPC/);
  h.context.appWin.win = windowFor('shell.html');
  await assert.rejects(h.invoke(h.shellWindow, 'shell:state'), /IPC/);
});
test('iframe, external navigation and unrelated local pages fail even in a known window', async () => {
  const h = harness();
  const event = eventFor(h.mainWindow);
  event.senderFrame = { ...event.senderFrame };
  assert.throws(() => h.handlers.get('settings:get')(event), /IPC/);
  for (const url of ['https://example.invalid/', pathToFileURL(path.join(ROOT, 'ui/shell.html')).href,
    pathToFileURL(path.join(ROOT, 'ui/other.html')).href]) {
    h.mainWindow.webContents.mainFrame.url = url;
    await assert.rejects(h.invoke(h.mainWindow, 'settings:get'), /IPC/);
  }
});
test('main settings:set keeps arbitrary existing patches and the activeImageId protection', async () => {
  const h = harness();
  const patch = { arbitraryFutureSetting: 12, runtime: { dir: 'D:/runtime', activeImageId: 'bypass' } };
  await h.invoke(h.mainWindow, 'settings:set', patch);
  assert.equal(h.calls.patches[0].arbitraryFutureSetting, 12);
  assert.equal(h.calls.patches[0].runtime.dir, 'D:/runtime');
  assert.equal('activeImageId' in h.calls.patches[0].runtime, false);
});
test('reset requires native consent on every direct invocation; defaults to cancel', async () => {
  const h = harness();
  const cancelled = await h.invoke(h.mainWindow, 'runtime:resetData', { confirmed: true });
  assert.equal(cancelled.cancelled, true);
  assert.equal(h.calls.reset, 0);
  const { win, opts } = h.calls.dialogs[0];
  assert.equal(win, h.mainWindow);
  assert.equal(opts.defaultId, 0);
  assert.equal(opts.cancelId, 0);
  assert.equal(opts.type, 'warning');
  h.setResponse(1);
  const result = await h.invoke(h.mainWindow, 'runtime:resetData');
  assert.equal(result.ok, true);
  assert.equal(result.reclaimedMB, 1);
  assert.equal(h.calls.reset, 1);
  h.setResponse(0);
  await h.invoke(h.mainWindow, 'runtime:resetData');
  assert.equal(h.calls.dialogs.length, 3);
  assert.equal(h.calls.reset, 1);
});
test('dialog failure cannot reset data', async () => {
  const h = harness();
  h.context.dialog.showMessageBox = async () => { throw new Error('dialog unavailable'); };
  const result = await h.invoke(h.mainWindow, 'runtime:resetData');
  assert.equal(result.ok, false);
  assert.equal(h.calls.reset, 0);
});
test('shell:openPath opens only existing absolute directories, never executables or shortcuts', async () => {
  const h = harness();
  for (const p of ['relative', path.resolve('/fake/app.exe'), path.resolve('/fake/app.lnk'), path.resolve('/fake/missing')]) {
    await assert.rejects(h.invoke(h.mainWindow, 'shell:openPath', p));
  }
  const dir = path.resolve('/fake/directory');
  assert.equal(await h.invoke(h.mainWindow, 'shell:openPath', dir), '');
  assert.deepEqual(h.calls.opened, [dir]);
});
test('data resize persists settings only after the stopped-runtime maintenance succeeds', async () => {
  const h = harness();
  const runtime = h.context.runtime;
  h.context.appLog = () => {};
  h.context.notify = () => {};
  runtime.resizeDataPartition = async mb => {
    assert.equal(mb, 8192);
    assert.equal(h.calls.patches.length, 0);
    return { ok: false, error: 'stop unconfirmed' };
  };
  let result = await h.invoke(h.mainWindow, 'runtime:setDataSize', 8);
  assert.equal(result.ok, false);
  assert.equal(h.calls.patches.length, 0);
  runtime.resizeDataPartition = async () => { throw new Error('disk busy'); };
  result = await h.invoke(h.mainWindow, 'runtime:setDataSize', 8);
  assert.equal(result.ok, false);
  assert.equal(h.calls.patches.length, 0);
  runtime.resizeDataPartition = async () => ({ ok: true, stoppedVm: true });
  result = await h.invoke(h.mainWindow, 'runtime:setDataSize', 8);
  assert.equal(result.stopped, true);
  assert.equal(h.calls.patches[0].engine.dataPartitionGB, 8);
});
test('restore keeps its device lease across the native picker and blocks target changes', async () => {
  const { RuntimeActions } = require('../src/core/runtime-actions');
  const h = harness();
  h.context.runtimeActions = new RuntimeActions({ status: async () => ({ current: { systemId: 'google-play' } }) });
  let choose;
  h.context.dialog.showOpenDialog = () => new Promise(resolve => { choose = resolve; });
  let selected = 'device-A', restoredOn = '';
  h.context.runtime.client = () => ({ isOnline: async () => true });
  h.context.backup = { restoreApp: async () => { restoredOn = selected; return { restored: true }; } };
  h.context.installer = {};
  const restore = h.invoke(h.mainWindow, 'app:restore');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.invoke(h.mainWindow, 'settings:set', { engine: { mode: 'attach' }, device: 'device-B' }), /正在执行/);
  assert.equal(h.calls.patches.length, 0);
  selected = 'device-A';
  choose({ canceled: false, filePaths: ['/safe/backup'] });
  assert.equal((await restore).ok, true);
  assert.equal(restoredOn, 'device-A');
});
test('an open app window blocks guest retargeting, but not ordinary preferences', async () => {
  const h = harness();
  h.context.appWin.isOpen = true;
  for (const patch of [{ device: 'device-B' }, { adbPath: 'different-adb' }, { engine: { mode: 'attach' } },
    ...['dir', 'avdDir', 'systemImageFlavor', 'compatImage'].map(key => ({ runtime: { [key]: 'changed' } }))]) {
    await assert.rejects(h.invoke(h.mainWindow, 'settings:set', patch), /关闭安卓应用窗口/);
  }
  for (const channel of ['system:switch', 'runtime:stop', 'image:activate', 'image:remove', 'provision:installAdb']) {
    await assert.rejects(h.invoke(h.mainWindow, channel), /关闭安卓应用窗口/);
  }
  assert.equal(h.calls.patches.length, 0);
  await h.invoke(h.mainWindow, 'settings:set', { engine: { priorityMode: 'performance' } });
  assert.equal(h.calls.patches.length, 1);
  h.context.appWin.isOpen = false;
  await h.invoke(h.mainWindow, 'settings:set', { device: 'device-B' });
  assert.equal(h.calls.patches[1].device, 'device-B');
});
test('image removal cannot bypass a pending installation lease', async () => {
  const { RuntimeActions } = require('../src/core/runtime-actions');
  const h = harness();
  h.context.runtimeActions = new RuntimeActions({ status: async () => ({ current: { systemId: 'aosp' } }) });
  let release;
  const install = h.context.runtimeActions.run('apk:install', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  h.context.runtime.stop = () => assert.fail('must not stop a guest under another lease');
  h.context.images = { remove: () => assert.fail('must not remove an image under another lease') };
  await assert.rejects(h.invoke(h.mainWindow, 'image:remove', 'active-image'), /正在执行/);
  release();
  await install;
});
test('neither acceleration entry downloads or elevates a cached script without WHPX', async () => {
  const h = harness();
  h.context.runtime.provisioner = {
    emulatorAccel: async () => ({ ok: false }),
    hypervisor: async () => ({ dll: false }),
    installAehd: () => assert.fail('must not prepare an untrusted driver'),
    paths: () => assert.fail('must not probe a cached installer'),
  };
  h.context.virtualizationFirmwareEnabled = async () => true;
  h.context.require = () => assert.fail('must not spawn a privileged process');
  for (const channel of ['provision:enableAccel', 'provision:enableVirtualization']) {
    const result = await h.invoke(h.mainWindow, channel);
    assert.equal(result.ok, false);
    assert.match(result.error, /已禁用未经可信校验的 AEHD/);
  }
});
test('production close callback retains the original client and queues cleanup under the lease', async () => {
  const { RuntimeActions } = require('../src/core/runtime-actions');
  const windowClients = new WeakMap(), win = {}, stopped = [];
  const a = { serial: 'device-A' }, b = { serial: 'device-B' };
  let selected = a, callback, release;
  const runtimeActions = new RuntimeActions({ status: () => assert.fail() });
  const context = { windowClients, windowSessions: new WeakMap(), automation: null,
    runtimeActions, quitting: false, appLog() {}, onContainerActive() {},
    appWin: { isOpen: false, onCloseApp: fn => { callback = fn; } },
    runtime: { client: () => selected, endApp: async (pkg, opts) => {
      assert.equal(opts.shouldCancel(), false);
      stopped.push([pkg, opts.client.serial]);
    } } };
  const start = source.indexOf('    appWin.onCloseApp(');
  const end = source.indexOf('    // 应用窗口关闭：', start);
  assert(start > 0 && end > start);
  vm.runInNewContext(source.slice(start, end), context);
  windowClients.set(win, a);
  const install = runtimeActions.run('apk:install', () => new Promise(resolve => { release = resolve; }), { builtin: false });
  callback('com.example.app', win);
  assert.equal(stopped.length, 0);
  await assert.rejects(runtimeActions.run('settings:set', () => assert.fail(), { builtin: false }), /等待/);
  release();
  await install;
  assert.equal(await runtimeActions.drain(), true);
  assert.deepEqual(stopped, [['com.example.app', 'device-A']]);
  selected = b;
  callback('com.example.app', win);
  assert.equal(await runtimeActions.drain(), true);
  assert.equal(stopped.length, 1, 'a stale window never force-stops the newly selected device');
  context.quitting = true;
  callback('com.example.app', win);
  assert.equal(stopped.length, 1);
});
test('orientation cancellation stops multi-step guest writes at every await boundary', async () => {
  const { AdbClient } = require('../src/core/adb');
  for (const stopAfter of [0, 1, 2, 3]) {
    let calls = 0;
    const client = { shell: async () => { calls++; return 'Physical size: 720x1280\nPhysical density: 320'; } };
    const result = await AdbClient.prototype.setOrientation.call(client, true, { shouldCancel: () => calls >= stopAfter });
    assert.equal(result, false);
    assert.equal(calls, stopAfter);
  }
});
test('installation confirmation propagates an unconfirmed stop and exceptions without reporting success', async () => {
  const h = harness();
  h.context.runtime.markInstalled = async () => false;
  let result = await h.invoke(h.mainWindow, 'runtime:markInstalled');
  assert.equal(result.ok, false);
  assert.match(result.error, /关机/);
  h.context.runtime.markInstalled = async () => { throw new Error('stop failed'); };
  result = await h.invoke(h.mainWindow, 'runtime:markInstalled');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stop failed');
  h.context.runtime.markInstalled = async () => true;
  assert.equal((await h.invoke(h.mainWindow, 'runtime:markInstalled')).ok, true);
});
test('split-container exports retain their format and can be imported again', async () => {
  for (const kind of ['apk', 'apks', 'xapk']) {
    const h = harness();
    const src = `/cache/app.${kind}`, dst = `/exports/app.${kind}`;
    h.context.store.getApp = () => ({ apkPath: src, label: 'App', versionName: '1' });
    h.context.fs.existsSync = () => true;
    const copies = [];
    h.context.fs.copyFileSync = (...args) => copies.push(args);
    h.context.filetype = require('../src/core/filetype');
    h.context.backup = { sanitizeName: s => s };
    h.context.app.getPath = () => '/exports';
    h.context.dialog.showSaveDialog = async (_win, opts) => {
      assert.equal(path.extname(opts.defaultPath), `.${kind}`);
      assert.equal(opts.filters[0].extensions[0], kind);
      return { filePath: dst };
    };
    assert.equal((await h.invoke(h.mainWindow, 'app:exportApk', 'com.example')).ok, true);
    assert.deepEqual(copies, [[src, dst]]);
    h.context.dialog.showSaveDialog = async () => ({ filePath: '/exports/wrong.txt' });
    await assert.rejects(h.invoke(h.mainWindow, 'app:exportApk', 'com.example'), /后缀/);
    assert.equal(copies.length, 1);
  }
});
test('legacy bundle records export as apks without changing their cached apk files', async () => {
  const os = require('os');
  const { buildStoredZip, buildApkBytes } = require('./lib/make-apk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-export-legacy-'));
  try {
    const src = path.join(root, 'legacy.apk');
    const dst = path.join(root, 'export.apks');
    const bytes = buildStoredZip([{ name: 'base.apk', data: buildApkBytes() }]);
    fs.writeFileSync(src, bytes);
    const h = harness();
    h.context.fs = fs;
    h.context.store.getApp = () => ({ apkPath: src, bundle: true, label: 'Legacy' });
    h.context.filetype = require('../src/core/filetype');
    h.context.isBundle = require('../src/core/apk-bundle').isBundle;
    h.context.backup = { sanitizeName: s => s };
    h.context.app.getPath = () => root;
    h.context.dialog.showSaveDialog = async (_win, opts) => {
      assert.equal(path.extname(opts.defaultPath), '.apks');
      return { filePath: dst };
    };
    assert.equal((await h.invoke(h.mainWindow, 'app:exportApk', 'com.example')).ok, true);
    assert(fs.readFileSync(src).equals(bytes));
    assert(fs.readFileSync(dst).equals(bytes));
    fs.writeFileSync(src, buildApkBytes());
    await assert.rejects(h.invoke(h.mainWindow, 'app:exportApk', 'com.example'), /不匹配/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
function preload(role) {
  let api;
  const invocations = [], subscriptions = [];
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8'), {
    process: { argv: role ? [`--apkstart-role=${role}`] : [] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'apkstart'); api = value; } },
        ipcRenderer: { invoke: (...args) => { invocations.push(args); return Promise.resolve({}); },
          on: (...args) => subscriptions.push(args), removeListener() {} }, webUtils: {} };
    },
  }, { filename: 'preload.js (production)' });
  return { api, invocations, subscriptions };
}
test('shell preload exposes only needed capabilities, including theme without settings disclosure', async () => {
  const { api, invocations, subscriptions } = preload('shell');
  assert.deepEqual(Object.keys(api).sort(), ['getSettings', 'i18n', 'on', 'shell']);
  await api.getSettings();
  assert.equal(invocations[0][0], 'app:theme');
  api.on('runtime:log', () => {});
  api.on('theme:changed', () => {});
  assert.deepEqual(subscriptions.map(s => s[0]), ['theme:changed']);
  await api.shell.rotate();
  assert.equal(invocations[1][0], 'shell:rotate');
});
test('main preload preserves public API; an unspecified preload role is never privileged', () => {
  const { api } = preload('main');
  for (const key of ['setSettings', 'runtimeResetData', 'openPath', 'updateApply', 'shell', 'android', 'on']) {
    assert.equal(typeof api[key], ['shell', 'android'].includes(key) ? 'object' : 'function', key);
  }
  assert.equal(preload().api, undefined, 'an unknown role must not expose the bridge');
});

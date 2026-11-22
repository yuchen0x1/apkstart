'use strict';
/**
 * VM regression for the production launch fast path.
 *
 * This test extracts the current main.js function bodies verbatim; it does not
 * reimplement runLaunch/runLaunchInner or initialize Electron, ADB, PowerShell,
 * an emulator, or the product main process.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MAIN_FILE = path.join(ROOT, 'src', 'main.js');
const mainSource = fs.readFileSync(MAIN_FILE, 'utf8');

function matchingBrace(source, open) {
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === quote) {
        quote = '';
      }
      continue;
    }
    if (c === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced block at ${open}`);
}

function extractBlock(marker) {
  const start = mainSource.indexOf(marker);
  assert(start >= 0, `main.js marker missing: ${marker}`);
  const open = mainSource.indexOf('{', start + marker.length);
  assert(open >= 0, `main.js block missing: ${marker}`);
  return mainSource.slice(start, matchingBrace(mainSource, open) + 1);
}

const RUN_LAUNCH = extractBlock('async function runLaunch(pkg)');
const RUN_LAUNCH_INNER = extractBlock('async function runLaunchInner(pkg)');
const AGENT_SCOPE = extractBlock('const agentScope = async () =>');
const ARM_AGENT = extractBlock('armAgent = async (agent) =>');
const START_NOTIFIER = extractBlock('function startNotifier()');
const FOREGROUND_IPC = extractBlock("ipcMain.handle('app:foreground', () =>") + ');';
const TOGGLE_DISPLAY = extractBlock('async function toggleDisplayMode()');
const SET_DISPLAY = extractBlock("ipcMain.handle('display:set', async (_e, patch) =>") + ');';
const REPAIR_ACTION = extractBlock('async function runRepairAction(id, { auto = false } = {})');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeLaunchVm({
  pkg = 'com.ready',
  ready = true,
  activeApps = ['com.ready'],
  vmRunning = true,
  engineMode = 'builtin',
  windowMode = 'auto',
} = {}) {
  const calls = {
    reveal: 0,
    directShow: 0,
    openAppWindow: 0,
    armAgent: 0,
    installer: 0,
    close: 0,
    state: [],
    settings: [],
    send: [],
    logs: [],
  };
  const appWin = {
    isOpen: true,
    pkg,
    state: { ready },
    standaloneActive: true,
    _hidden: true,
    win: {
      // The busy standalone regression must fail if production code directly shows
      // this hidden host instead of calling AppWindow.reveal().
      show() { calls.directShow += 1; throw new Error('direct host show is forbidden'); },
      focus() { calls.directShow += 1; throw new Error('direct host focus is forbidden'); },
    },
    reveal: async () => { calls.reveal += 1; return true; },
    close: () => { calls.close += 1; },
    setState(patch) { Object.assign(this.state, patch); calls.state.push({ ...patch }); },
    refreshPointer: () => {},
    external: false,
    blackDetached: false,
    lastEmbedError: '',
  };
  const runtime = {
    activeApps,
    vmRunning,
    settings: { engine: { mode: engineMode } },
    emulator: { lcd: { w: 540, h: 960 } },
    beginApp: async () => {},
  };
  const installer = {
    launch: async () => {
      calls.installer += 1;
      throw new Error('FALLBACK_SENTINEL');
    },
  };
  const context = {
    appWin,
    runtime,
    installer,
    mainWindow: null,
    // A truthy agent exercises the normal arm path; quick reuse must skip it.
    winAgent: {},
    quitting: false,
    runtimeActions: { run: async fn => fn() },
    store: {
      getApp: () => ({}),
      getSettings: () => ({ display: { mode: 'window' }, engine: { mode: engineMode, windowMode } }),
      saveSettings: patch => calls.settings.push(patch),
    },
    lcd: {
      desiredOrientation: () => '',
      orientBox: box => box,
    },
    displaySettings: () => ({ mode: 'window', portrait: '540x960' }),
    portraitSize: () => ({ w: 540, h: 960 }),
    windowBox: () => ({ w: 540, h: 960 }),
    openAppWindow: () => {
      calls.openAppWindow += 1;
      appWin.win = { isDestroyed: () => false };
      appWin.standaloneActive = false;
      appWin._hidden = false;
      return appWin.win;
    },
    windowClients: new Map(),
    deviceSize: { value: null },
    onContainerActive: () => {},
    armAgent: async () => { calls.armAgent += 1; return { ok: true }; },
    hasHeadlessRuntimeWindow: async () => false,
    showWindow: () => {},
    send: (...args) => calls.send.push(args),
    appLog: line => calls.logs.push(String(line)),
    plainRuntimeFailure: () => '',
    platform: { supportNote: () => '' },
    setTimeout,
    clearTimeout,
    Date,
    console,
  };
  // Keep these as the production declarations, not copies of their behavior.
  vm.runInNewContext(`let launchBusy = false;\n${RUN_LAUNCH}\n${RUN_LAUNCH_INNER}`, context, {
    filename: MAIN_FILE,
  });
  context.calls = calls;
  return context;
}

test('same ready active package reuses the existing host through reveal only', async () => {
  const h = makeLaunchVm();
  const beforeState = { ...h.appWin.state };
  const result = await h.runLaunchInner('com.ready');

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(h.calls.reveal, 1);
  assert.equal(h.calls.openAppWindow, 0);
  assert.equal(h.calls.armAgent, 0);
  assert.equal(h.calls.installer, 0);
  assert.equal(h.calls.close, 0);
  assert.deepEqual(h.appWin.state, beforeState);
  assert.equal(h.calls.directShow, 0);
});

for (const scenario of [
  ['different package', { pkg: 'com.ready' }, 'com.other'],
  ['not-ready host', { ready: false }, 'com.ready'],
  ['inactive runtime', { vmRunning: false, engineMode: 'builtin' }, 'com.ready'],
]) {
  test(`${scenario[0]} does not take the foreground-reuse shortcut`, async () => {
    const h = makeLaunchVm(scenario[1]);
    const result = await h.runLaunchInner(scenario[2]);

    assert.equal(result.ok, false, 'sentinel should be handled by the real catch path');
    assert.equal(h.calls.reveal, 0);
    assert.equal(h.calls.openAppWindow, 1, 'normal path must create/open through production launch flow');
    assert(h.calls.armAgent >= 1, 'normal path must reach the agent preparation');
    assert.equal(h.calls.installer, 1, 'fallback must reach installer.launch');
    assert.equal(h.calls.directShow, 0);
  });
}

test('launchBusy standalone path calls reveal and never directly shows the hidden host', async () => {
  const h = makeLaunchVm();
  const gate = deferred();
  h.runtimeActions.run = () => gate.promise;

  const first = h.runLaunch('com.first');
  // launchBusy is set synchronously by the real runLaunch before it awaits runtimeActions.
  const busy = await h.runLaunch('com.standalone');

  assert.equal(busy.ok, false);
  assert.equal(busy.error, 'busy');
  assert.equal(h.calls.reveal, 1);
  assert.equal(h.calls.directShow, 0);
  assert.equal(h.appWin._hidden, true);
  assert.equal(h.appWin.standaloneActive, true);
  gate.resolve({ ok: true });
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
});

for (const [retry, windowMode] of [[false, 'auto'], [true, 'auto'], [true, 'embedded']]) {
  test(`${retry ? 'retried' : 'initial'} black-frame detach completes display setup (${windowMode})`, async () => {
    const h = makeLaunchVm({ ready: false, windowMode });
    h.winAgent = null;
    h.installer.launch = async () => ({ ok: true, engine: 'builtin' });
    const timers = [];
    h.setTimeout = (resolve, delay) => { timers.push({ resolve, delay }); };
    let embeds = 0;
    h.appWin.embed = async () => {
      embeds += 1;
      if (!retry || embeds > 1) {
        h.appWin.blackDetached = h.appWin.standaloneActive = h.appWin._hidden = true;
      }
      return false;
    };

    const result = await h.runLaunchInner('com.ready');
    assert.equal(result.ok, true);
    assert.equal(result.detached, !retry);
    assert.equal(h.appWin.state.ready, !retry);
    if (retry) {
      assert.deepEqual(timers.map(t => t.delay), [1200]);
      timers.shift().resolve();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(h.appWin.state.ready, true);
    assert.match(h.appWin.state.tip, /Android Emulator/);
    assert.equal(embeds, retry ? 2 : 1);
    assert.equal(timers.length, 0, 'a confirmed detach must stop re-embedding');
    assert.deepEqual(h.calls.settings.map(p => p.engine.embeddedBlack), windowMode === 'auto' ? [true] : []);
    assert.equal(h.calls.send.filter(([event, data]) => event === 'toast' && data.type === 'success').length, 1);
  });
}

test('notification for the current package reveals the existing window, other packages still launch', async () => {
  const h = makeLaunchVm();
  const launches = [];
  h.notifier = null;
  h.NotifyBridge = class {
    constructor(options) { this.onOpen = options.onOpen; }
    start() {}
  };
  h.runLaunch = async pkg => { launches.push(pkg); };
  vm.runInNewContext(`${START_NOTIFIER}\nstartNotifier();`, h, { filename: MAIN_FILE });
  h.notifier.onOpen('com.ready');
  h.notifier.onOpen('com.other');
  assert.equal(h.calls.reveal, 1);
  assert.equal(h.calls.directShow, 0);
  assert.deepEqual(launches, ['com.other']);
});

test('foreground IPC uses reveal and reports its result without showing a hidden host', async () => {
  const h = makeLaunchVm();
  let foreground;
  h.ipcMain = { handle(channel, fn) { assert.equal(channel, 'app:foreground'); foreground = fn; } };
  vm.runInNewContext(FOREGROUND_IPC, h, { filename: MAIN_FILE });
  assert.equal(await foreground(), true);
  h.appWin.reveal = async () => false;
  assert.equal(await foreground(), false);
  h.appWin.isOpen = false;
  h.appWin.reveal = async () => { assert.fail('closed window must not be revealed'); };
  assert.equal(await foreground(), false);
  assert.equal(h.calls.reveal, 1);
  assert.equal(h.calls.directShow, 0);
});

test('display mode changes save preferences without maximizing or resizing a suppressed host', async () => {
  const h = makeLaunchVm();
  h.appWin.hostSuppressed = true;
  const handlers = new Map();
  h.ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  h.store.saveSettings = patch => {
    h.calls.settings.push(patch);
    return { display: { mode: 'window', ...patch.display } };
  };
  vm.runInNewContext(`${TOGGLE_DISPLAY}\n${SET_DISPLAY}`, h, { filename: MAIN_FILE });
  assert.equal(await h.toggleDisplayMode(), 'fullscreen');
  assert.equal((await handlers.get('display:set')(null, { mode: 'window' })).mode, 'window');
  assert.equal(h.calls.settings.length, 2);
  assert.equal(h.calls.directShow, 0);
  assert.equal(h.appWin._hidden, true);
});

test('VC++ repair cannot elevate on the automatic path; the explicit action remains available', async () => {
  let installs = 0;
  const h = { installVcRedistImpl: async () => { installs += 1; return { ok: true }; } };
  vm.runInNewContext(REPAIR_ACTION, h, { filename: MAIN_FILE });
  const automatic = await h.runRepairAction('vc-redist', { auto: true });
  assert.equal(automatic.ok, false);
  assert.equal(installs, 0);
  const manual = await h.runRepairAction('vc-redist');
  assert.equal(manual.ok, true);
  assert.equal(installs, 1);
});

function makeArmAgentVm(scopeReply) {
  const calls = { scope: [], bootHide: 0, logs: [] };
  const runtime = {
    provisioner: {
      root: 'C:\\shared-runtime\\emulator',
      paths: () => ({ avdHome: 'C:\\instances\\one' }),
    },
    emulator: { avdName: 'apkstart' },
    activeRuntimeRoots: async () => ['C:\\shared-runtime\\emulator'],
  };
  const fakeAgent = {
    scope: async (...args) => { calls.scope.push(args); return scopeReply; },
    bootHide: async () => { calls.bootHide += 1; return { ok: true }; },
  };
  const context = {
    runtime,
    path,
    APP_ROOT: 'C:\\ApkStart',
    process: { pid: 4242 },
    quitting: false,
    appLog: line => calls.logs.push(String(line)),
    console,
  };
  vm.runInNewContext(
    `${AGENT_SCOPE}\nlet armAgent = async () => ({ ok: false });\n${ARM_AGENT}\nglobalThis.__armAgent = armAgent;`,
    context,
    { filename: MAIN_FILE },
  );
  return { ...context, fakeAgent, calls };
}

test('production armAgent passes the complete datadir and does not bootHide after scope failure', async () => {
  const h = makeArmAgentVm({ ok: false, n: 0 });
  const result = await h.__armAgent(h.fakeAgent);

  assert.equal(result.ok, false);
  assert.equal(h.calls.bootHide, 0);
  assert.equal(h.calls.scope.length, 1);
  assert.equal(h.calls.scope[0][1], 4242);
  assert.equal(h.calls.scope[0][2].avdDir, path.join('C:\\instances\\one', 'apkstart.avd'));
  assert.equal(h.calls.scope[0][2].avdName, 'apkstart');
});

test('production armAgent bootHides only after scope succeeds', async () => {
  const h = makeArmAgentVm({ ok: true, n: 2 });
  const result = await h.__armAgent(h.fakeAgent);
  assert.equal(result.ok, true);
  assert.equal(h.calls.bootHide, 1);
});

test('WinAgent.scope sends an explicit empty avdDir for invalid input without starting anything', async () => {
  // Loading the production class is safe: this test replaces call() and never calls ensure/spawn.
  const { WinAgent } = require('../src/core/agent');
  const agent = new WinAgent();
  const requests = [];
  agent.call = async request => { requests.push(request); return { ok: true }; };

  const validDir = path.join(path.parse(process.cwd()).root, 'apkstart-test-instance.avd');
  await agent.scope([], 4242, { avdDir: validDir, avdName: 'apkstart' });
  await agent.scope([], 4242, { avdDir: 'relative-instance.avd', avdName: 'apkstart' });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].cmd, 'scope');
  assert.equal(requests[0].avdDir, path.resolve(validDir));
  assert.equal(requests[0].avdName, 'apkstart');
  assert.equal(requests[1].dirs, '');
  assert.equal(requests[1].avdDir, '', 'invalid input explicitly clears native AVD scope');
  assert.equal(requests[1].avdName, 'apkstart');
});

// Execute the actual whenReady registration and startup prefix through Runtime's
// constructor. Only close the callback at that boundary; no startup logic is copied.
function startupPrefix() {
  const marker = 'app.whenReady().then(async () => {';
  const runtimeStatement = 'runtime = new Runtime(APP_ROOT);';
  const start = mainSource.indexOf(marker);
  assert(start >= 0, 'production whenReady callback missing');
  const end = mainSource.indexOf(runtimeStatement, start);
  assert(end > start, 'production Runtime construction missing');
  return mainSource.slice(start, end + runtimeStatement.length) + '\n});';
}

function makeStartupVm(isChild = true) {
  const events = [], errors = [], initOptions = [], runtimeRoots = [], imports = [];
  const ready = deferred(), init = deferred();
  const appRoot = path.resolve(ROOT);
  const adbExe = path.join(appRoot, 'fixture-runtime', 'platform-tools', 'adb.exe');
  const context = {
    APP_ROOT: appRoot,
    runtime: null,
    instanceContext: { isChild },
    app: {
      whenReady() { events.push('whenReady'); return ready.promise; },
      quit() { events.push('quit'); },
    },
    store: {
      ensureDirs() { events.push('ensureDirs'); },
      getSettings() { events.push('settings'); return { theme: 'dark' }; },
    },
    instanceAdb: {
      initialize(options) {
        events.push('initialize');
        initOptions.push({ ...options });
        return init.promise;
      },
    },
    require(name) {
      imports.push(name);
      assert.equal(name, './core/provision', 'no actual modules may be loaded by startup');
      return { Provisioner: class {
        constructor(root) { assert.equal(root, appRoot); events.push('provisioner'); }
        paths() { events.push('paths'); return { adbExe }; }
      } };
    },
    Runtime: class {
      constructor(root) { events.push('runtime'); runtimeRoots.push(root); }
    },
    syncTheme(theme) { assert.equal(theme, 'dark'); events.push('syncTheme'); },
    nativeTheme: { on(event) { assert.equal(event, 'updated'); events.push('nativeTheme'); } },
    refreshWindowTheme() {},
    dialog: { showErrorBox(title, message) { events.push('errorBox'); errors.push({ title, message }); } },
    appLog(message) { events.push('log'); assert.match(message, /instance adb initialization failed:/); },
  };
  const startup = vm.runInNewContext(startupPrefix(), context, { filename: MAIN_FILE });
  return { context, events, errors, initOptions, runtimeRoots, imports, ready, init, startup, appRoot, adbExe };
}

test('child whenReady waits for private ADB initialization before constructing Runtime', async () => {
  const h = makeStartupVm();
  assert.deepEqual(h.events, ['whenReady'], 'startup must remain gated by app readiness');
  h.ready.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.events, ['whenReady', 'ensureDirs', 'provisioner', 'paths', 'initialize']);
  assert.deepEqual(h.initOptions, [{ adbPath: h.adbExe }]);
  assert.equal(h.context.runtime, null);
  assert.equal(h.runtimeRoots.length, 0, 'pending init must block Runtime and subsequent startup');
  assert.equal(h.errors.length, 0);
  h.init.resolve();
  await h.startup;
  assert.equal(h.runtimeRoots.length, 1);
});

test('successful private ADB initialization resumes the actual startup prefix', async () => {
  const h = makeStartupVm();
  h.ready.resolve();
  h.init.resolve();
  await h.startup;
  assert.deepEqual(h.events, [
    'whenReady', 'ensureDirs', 'provisioner', 'paths', 'initialize',
    'settings', 'syncTheme', 'nativeTheme', 'runtime',
  ]);
  assert.deepEqual(h.runtimeRoots, [h.appRoot]);
  assert(h.context.runtime instanceof h.context.Runtime);
  assert.equal(h.errors.length, 0);
});

test('failed private ADB initialization shows an error and quits without constructing Runtime', async () => {
  const h = makeStartupVm();
  h.ready.resolve();
  await new Promise(resolve => setImmediate(resolve));
  h.init.reject(new Error('private-adb-fixture-failure'));
  await h.startup;
  assert.deepEqual(h.events, [
    'whenReady', 'ensureDirs', 'provisioner', 'paths', 'initialize', 'log', 'errorBox', 'quit',
  ], 'no theme/runtime or subsequent device startup may run after init rejection');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].title, /分身启动失败/);
  assert.match(h.errors[0].message, /private-adb-fixture-failure/);
  assert.equal(h.context.runtime, null);
  assert.equal(h.runtimeRoots.length, 0);
});

test('parent startup constructs Runtime without loading Provisioner or starting a private ADB service', async () => {
  const h = makeStartupVm(false);
  h.ready.resolve();
  await h.startup;
  assert.deepEqual(h.events, ['whenReady', 'ensureDirs', 'settings', 'syncTheme', 'nativeTheme', 'runtime']);
  assert.deepEqual(h.imports, []);
  assert.deepEqual(h.initOptions, []);
  assert.deepEqual(h.runtimeRoots, [h.appRoot]);
  assert.equal(h.errors.length, 0);
});

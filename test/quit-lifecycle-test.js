'use strict';
// Use real AppWindow and production main lifecycle handlers, with fake Electron and clock.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '../src');
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const lifecycle = mainSource.slice(mainSource.indexOf('// ---------------- 生命周期'));
const appwinSource = fs.readFileSync(path.join(ROOT, 'core/appwin.js'), 'utf8');
const sharerSource = fs.readFileSync(path.join(ROOT, 'core/sharer.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const stopEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

function setup({ withMain = true, isChild = false } = {}) {
  const log = [], timers = new Set(), parks = [], windows = [], warnings = [];
  let now = 0, nativeOwner = null;
  const clock = {
    setTimeout(fn, delay) {
      const timer = { fn, at: now + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
  };
  async function advance(ms) {
    const target = now + ms;
    // Let pending microtasks arm timers at the current time before moving the clock.
    await flush();
    for (;;) {
      const next = [...timers].filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.fn();
      await flush();
    }
    now = target;
    await flush();
  }
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => ({ then() { /* Do not initialize Electron or runtime. */ } });
  app.quit = () => {
    const event = stopEvent();
    log.push('quit');
    app.emit('before-quit', event);
    if (!event.prevented) log.push('quit-allowed');
    return event;
  };
  app.exit = () => { log.push('exit'); };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.number = windows.push(this);
    }
    loadFile() {}
    isDestroyed() { return !!this.destroyed; }
    isVisible() { return !!this.visible; }
    show() { this.visible = true; }
    hide() { this.visible = false; this.hideCalls = (this.hideCalls || 0) + 1; }
    focus() {}
    getNativeWindowHandle() { const b = Buffer.alloc(4); b.writeUInt32LE(this.number); return b; }
    getBounds() { return { width: this.options.width, height: this.options.height }; }
    getContentBounds() { return this.getBounds(); }
    isMaximized() { return !!this.maximized; }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    setContentSize(w, h) { this.resizedTo = [w, h]; }
    setPosition(x, y) { this.movedTo = [x, y]; }
    destroy() {
      this.destroyAttempts = (this.destroyAttempts || 0) + 1;
      assert(!this.destroyed, 'native window destroyed twice');
      this.destroyed = true;
      log.push(`destroy:${this.number}`);
      this.emit('closed');
      if (windows.every(w => w.isDestroyed())) app.emit('window-all-closed');
    }
    close() {
      const event = stopEvent();
      this.emit('close', event);
      if (!event.prevented) this.destroy();
      return event;
    }
  }
  const agent = {
    setHook: async () => {},
    embed: async hwnd => { nativeOwner = hwnd; return { ok: true }; },
    detach: async () => { nativeOwner = 'standalone'; return { ok: true }; },
    show: async () => {}, hide: async () => {}, refresh: async () => {},
    fit: async () => {},
    pixmean: async () => ({ ok: true, mean: 100 }),
    park: maxWaitMs => {
      log.push('park');
      const park = deferred();
      parks.push({ ...park, maxWaitMs, resolve(reply = { ok: true }) {
        if (reply.ok) nativeOwner = null;
        park.resolve(reply);
      } });
      return park.promise;
    },
    dispose() { log.push('dispose:agent'); },
  };
  const workArea = { x: 0, y: 0, width: 1600, height: 900 };
  const mod = { exports: {} };
  const dependencies = {
    electron: { BrowserWindow: FakeWindow, screen: { getCursorScreenPoint() {}, getDisplayNearestPoint: () => ({ workArea }) } },
    fs: { existsSync: () => false }, path,
    './pointer': { hookOptions: () => ({ enabled: false }) }, './platform': { canEmbed: true },
    './store': { getSettings: () => ({}) },
  };
  vm.runInNewContext(appwinSource, {
    ...clock, __dirname: path.join(ROOT, 'core'), process: { env: {} }, module: mod,
    require(name) { assert(name in dependencies, `unexpected require: ${name}`); return dependencies[name]; },
  }, { filename: 'appwin.js (production)' });
  const appWin = new mod.exports.AppWindow({ agent });
  appWin.onCloseApp(pkg => log.push(`stop:${pkg}`));
  appWin.onWindowClosed(pkg => log.push(`closed:${pkg}`));
  const context = { ...clock, app, appWin, quitting: false, winAgent: agent, automation: null,
    instanceContext: { isChild }, instanceAdb: { async dispose() { log.push('dispose:owned-adb'); } },
    runtimeActions: { drain: async () => true },
    sharer: { async stop() { log.push('stop:sharer'); return true; } }, notifier: { stop() { log.push('stop:notifier'); } },
    wheelRouter: { dispose() { log.push('dispose:wheel'); } }, runtime: { dispose() { log.push('dispose:runtime'); } },
    decodeWindow: { isDestroyed: () => false, destroy() { log.push('destroy:decode'); } },
    console: { warn(message) { warnings.push(message); } },
  };
  if (withMain) {
    assert(lifecycle.includes('app.requestSingleInstanceLock()'));
    vm.runInNewContext(lifecycle, context, { filename: 'main.js lifecycle (production)' });
  }
  return { app, appWin, context, log, parks, timers, windows, warnings, advance, clock,
    get nativeOwner() { return nativeOwner; }, open: (pkg, options) => appWin.open({ pkg, ...options }) };
}

// Exercise production Sharer.stop/join against an inert in-flight task. No sync(), filesystem
// writes, real runtime, device transport, or application startup is used by this harness.
function pendingSharing(h) {
  const mod = { exports: {} };
  const deps = { fs: {}, path, crypto: {}, './store': {} };
  vm.runInNewContext(sharerSource, {
    ...h.clock, module: mod,
    require(name) { assert(name in deps, `unexpected sharer require: ${name}`); return deps[name]; },
  }, { filename: 'sharer.js stop/join (production)' });
  const sharer = new mod.exports.Sharer({ client() { throw new Error('real device access forbidden'); } },
    { dataDir: ROOT, settings: () => ({}) });
  const pending = deferred();
  sharer._activeSync = pending.promise;
  sharer._run = { cancelled: false };
  const stop = sharer.stop.bind(sharer);
  const calls = [];
  sharer.stop = opts => { calls.push(opts); h.log.push('stop:sharer'); return stop(opts); };
  h.context.sharer = sharer;
  return { pending, sharer, calls };
}

function once(h, ...steps) {
  for (const s of steps) assert.equal(h.log.filter(v => v === s).length, 1, `${s}: ${h.log.join(', ')}`);
}

test('AppWindow blocks repeated native close and shares the in-flight close promise', async () => {
  const h = setup({ withMain: false });
  const win = h.open('guest', { onClosed: pkg => h.log.push(`local:${pkg}`) });
  assert(win.close().prevented);
  const pending = h.appWin.close({ keepApp: true });
  assert.equal(typeof pending?.then, 'function');
  assert.equal(h.appWin.close(), pending);
  assert(win.close().prevented);
  assert.equal(h.parks[0].maxWaitMs, 0);
  await h.advance(650);
  assert(win.close().prevented);
  assert(!win.isDestroyed());
  assert(!h.log.includes('closed:guest'));
  h.parks[0].resolve();
  await pending;
  once(h, 'park', 'stop:guest', 'destroy:1', 'local:guest', 'closed:guest');
  assert.equal(h.timers.size, 0, 'successful park clears the timeout and first-frame timer');
  await h.advance(3000);
  once(h, 'destroy:1', 'local:guest', 'closed:guest');
});

test('AppWindow closeAll serializes same-agent parks and joins both windows with isolated callbacks', async () => {
  const h = setup({ withMain: false });
  const older = h.open('old', { onClosed: pkg => {
    h.log.push(`old-cb:${pkg}`);
    assert.equal(h.open('reentrant'), null, 'batch close must block callback-created hosts');
  } });
  const newer = h.open('new', { onClosed: pkg => h.log.push(`new-cb:${pkg}`) });
  assert(older.close().prevented);
  assert.equal(h.appWin.win, newer);
  assert.equal(h.parks.length, 1);
  const all = h.appWin.closeAll({ keepApp: true });
  assert.equal(h.appWin.closeAll(), all);
  assert.equal(h.parks.length, 1, 'second park must wait for the same agent handoff');
  assert(newer.close().prevented);
  let allDone = false;
  all.then(() => { allDone = true; });
  h.parks[0].resolve();
  await flush();
  assert(older.isDestroyed());
  assert(!newer.isDestroyed());
  assert(!allDone);
  assert.equal(h.parks.length, 2);
  h.parks[1].resolve();
  assert.equal(await all, true);
  assert(allDone);
  for (const step of ['old-cb:old', 'closed:old', 'new-cb:new', 'closed:new', 'destroy:1', 'destroy:2']) once(h, step);
  assert(h.log.indexOf('closed:old') < h.log.indexOf('closed:new'));
  assert.equal(h.windows.length, 2);
  assert.equal(h.timers.size, 0);
});

test('AppWindow park timeout closes only the old window and ignores a late reply', async () => {
  const h = setup({ withMain: false });
  const older = h.open('old', { onClosed: pkg => h.log.push(`local:${pkg}`) });
  const newer = h.open('new', { onClosed: pkg => h.log.push(`local:${pkg}`) });
  assert.equal(h.parks.length, 1);
  await h.advance(1499);
  assert(older.close().prevented);
  assert(!older.isDestroyed());
  await h.advance(1);
  assert(older.isDestroyed());
  assert.equal(h.appWin.win, newer);
  h.parks[0].resolve();
  await h.advance(3000);
  assert.equal(h.appWin.win, newer);
  assert(!newer.isDestroyed());
  assert.deepEqual(h.log, ['park', 'destroy:1', 'local:old', 'closed:old']);
  assert.equal(h.timers.size, 0);
});

test('native handoff orders old embed, closing park, replacement embed without late global compensation', async () => {
  const h = setup({ withMain: false });
  const late = deferred(), calls = [];
  const nativeEmbed = h.appWin.agent.embed;
  h.appWin.agent.embed = hwnd => {
    calls.push(hwnd);
    const reply = nativeEmbed(hwnd);
    return calls.length === 1 ? late.promise : reply;
  };
  h.appWin._looksBlackAfterEmbed = async () => false;
  const older = h.open('old');
  const oldEmbedding = h.appWin.embed();
  const newer = h.open('new');
  const newEmbedding = h.appWin.embed();
  await flush();
  assert.deepEqual(calls, ['1']);
  assert.equal(h.parks.length, 0, 'closing park must queue behind the old embed');
  assert(!older.isDestroyed());
  late.resolve({ ok: true });
  assert.equal(await oldEmbedding, false);
  await flush();
  assert.equal(h.parks.length, 1);
  assert.deepEqual(calls, ['1'], 'replacement cannot overtake the queued park');
  h.parks[0].resolve();
  assert.equal(await newEmbedding, true);
  assert(older.isDestroyed());
  assert.equal(h.appWin.win, newer);
  assert.equal(h.nativeOwner, '2');
  assert.equal(h.appWin._embedded, true);
  await h.advance(3000);
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(h.parks.length, 1, 'late completion must not issue a second global park');
});

test('late old black-frame result cannot park or detach a replacement that already owns the embed', async () => {
  const h = setup({ withMain: false });
  const sample = deferred();
  let samples = 0, detaches = 0;
  h.appWin._looksBlackAfterEmbed = () => ++samples === 1 ? sample.promise : Promise.resolve(false);
  h.appWin.agent.detach = async () => { detaches++; return { ok: true }; };
  h.open('old');
  const oldEmbedding = h.appWin.embed();
  await flush();
  const newer = h.open('new');
  const newEmbedding = h.appWin.embed();
  h.parks[0].resolve();
  assert.equal(await newEmbedding, true);
  assert.equal(h.nativeOwner, '2');
  sample.resolve(true);
  assert.equal(await oldEmbedding, false);
  await h.advance(3000);
  assert.equal(h.appWin.win, newer);
  assert.equal(h.appWin._embedded, true);
  assert.equal(h.nativeOwner, '2');
  assert.equal(detaches, 0);
  assert.equal(h.parks.length, 1);
});
test('closeAll has a hard deadline for a permanently pending embed, even after single-window close expires', async () => {
  const h = setup({ withMain: false });
  h.appWin.agent.embed = () => new Promise(() => {});
  const win = h.open('guest');
  void h.appWin.embed();
  const closing = h.appWin.close({ keepApp: true });
  await h.advance(1500);
  await closing;
  assert(win.isDestroyed());
  assert.equal(h.parks.length, 0, 'park is still queued behind the permanently pending embed');
  let result;
  const batch = h.appWin.closeAll();
  batch.then(value => { result = value; });
  await h.advance(1499);
  assert.equal(result, undefined);
  await h.advance(1);
  assert.equal(await batch, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.parks.length, 0);
});

test('expired batch invalidates unsent embed, detach and park before a replacement takes ownership', async () => {
  const h = setup({ withMain: false });
  const late = deferred(), calls = [];
  const nativeEmbed = h.appWin.agent.embed;
  h.appWin.agent.embed = hwnd => {
    calls.push(`embed:${hwnd}`);
    const reply = nativeEmbed(hwnd); // native effect precedes the delayed JS acknowledgement
    return calls.length === 1 ? late.promise : reply;
  };
  h.appWin.agent.detach = async () => { calls.push('detach'); return { ok: true }; };
  h.appWin._looksBlackAfterEmbed = async () => false;
  h.open('old');
  const oldEmbedding = h.appWin.embed();
  h.open('queued');
  const queuedEmbedding = h.appWin.embed();
  const queuedDetach = h.appWin.standalone();
  const batch = h.appWin.closeAll({ keepApp: true });
  await h.advance(1499);
  assert.equal(h.parks.length, 0);
  assert.equal(h.windows.filter(w => w.isDestroyed()).length, 0);
  await h.advance(1);
  assert.equal(await batch, false);
  assert(h.windows.every(w => w.isDestroyed()));
  const replacement = h.open('replacement');
  assert.equal(await h.appWin.embed(), true, 'new handoff must not wait for an expired queue');
  assert.equal(h.nativeOwner, '3');
  late.resolve({ ok: true });
  assert.equal(await oldEmbedding, false);
  assert.equal(await queuedEmbedding, false);
  assert.equal(await queuedDetach, false);
  await h.advance(3000);
  assert.deepEqual(calls, ['embed:1', 'embed:3']);
  assert.equal(h.parks.length, 0, 'expired parks must never be sent after the new embed');
  assert.equal(h.appWin.win, replacement);
  assert.equal(h.nativeOwner, '3');
  assert.equal(h.appWin._embedded, true);
  assert.equal(h.appWin._hidden, false);
  const normalClose = h.appWin.closeAll({ keepApp: true });
  h.parks[0].resolve();
  assert.equal(await normalClose, true, 'a new batch can confirm normally after an expired batch');
  assert.equal(h.timers.size, 0);
});

test('late detach acknowledgements cannot hide or change an already embedded replacement', async () => {
  for (const method of ['standalone', 'revealStandalone']) {
    const h = setup({ withMain: false });
    const late = deferred();
    let detaches = 0;
    const nativeDetach = h.appWin.agent.detach;
    h.appWin.agent.detach = () => { detaches++; void nativeDetach(); return late.promise; };
    h.appWin._looksBlackAfterEmbed = async () => false;
    h.open('old');
    if (method === 'revealStandalone') h.appWin.standaloneActive = true;
    const detaching = h.appWin[method]();
    const batch = h.appWin.closeAll({ keepApp: true });
    await h.advance(1500);
    assert.equal(await batch, false);
    const replacement = h.open('replacement');
    assert.equal(await h.appWin.embed(), true);
    assert.equal(h.nativeOwner, '2');
    late.resolve({ ok: true });
    assert.equal(await detaching, false);
    await h.advance(3000);
    assert.equal(h.appWin.win, replacement);
    assert.equal(replacement.hideCalls || 0, 0, method);
    assert.equal(h.appWin._hidden, false);
    assert.equal(h.appWin._embedded, true);
    assert.equal(h.appWin.standaloneActive, false);
    assert.equal(h.appWin.blackDetached, false);
    assert.equal(h.nativeOwner, '2');
    assert.equal(h.parks.length, 0);
    assert.equal(detaches, 1);
  }
});

test('closing callbacks identify the actual BrowserWindow even when the same package is reopened', async () => {
  const h = setup({ withMain: false });
  const callbacks = [];
  h.appWin.onCloseApp((pkg, win) => callbacks.push({ pkg, win }));
  const older = h.open('same');
  const oldClose = h.appWin.close();
  const newer = h.open('same');
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].pkg, 'same');
  assert.equal(callbacks[0].win, older);
  assert.notEqual(callbacks[0].win, h.appWin.win);
  h.parks[0].resolve();
  await oldClose;
  const newClose = h.appWin.close();
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks[1].win, newer);
  h.parks[1].resolve();
  await newClose;
});

test('rotation replies and delayed resize work are scoped to their original window generation', async () => {
  for (const phase of ['orientation', 'resize-delay', 'fit']) {
    const h = setup({ withMain: false });
    const orientation = deferred(), fit = deferred();
    h.appWin.setOrientation = () => orientation.promise;
    let fits = 0;
    h.appWin.agent.fit = () => { fits++; return fit.promise; };
    h.open('old');
    const rotating = h.appWin.rotate({ fullscreen: true });
    if (phase !== 'orientation') {
      orientation.resolve(true);
      await h.advance(phase === 'fit' ? 1700 : 600);
    }
    const replacement = h.open('replacement');
    if (phase === 'fit') assert.equal(fits, 1, 'rotation must have an in-flight fit before replacement');
    orientation.resolve(true);
    fit.resolve();
    await flush();
    h.parks[0].resolve();
    await h.advance(5000);
    assert.equal(await rotating, false, phase);
    assert.equal(h.appWin.win, replacement);
    assert.equal(h.appWin.state.landscape, false);
    assert.equal(replacement.resizedTo, undefined);
    assert.equal(replacement.movedTo, undefined);
    assert.equal(replacement.isMaximized(), false);
    assert(fits <= (phase === 'fit' ? 1 : 0), 'old rotation must not fit the replacement');
  }
});

test('confirmed rotation resizes its original host and restores requested maximization', async () => {
  const h = setup({ withMain: false });
  const requested = [];
  let fits = 0;
  h.appWin.setOrientation = async landscape => { requested.push(landscape); return true; };
  h.appWin.agent.fit = async () => { fits++; return { ok: true }; };
  const win = h.open('guest');
  const rotating = h.appWin.rotate({ fullscreen: true });
  await h.advance(4200);
  assert.equal(await rotating, true);
  assert.deepEqual(requested, [true]);
  assert.equal(h.appWin.state.landscape, true);
  assert(win.resizedTo[0] > win.resizedTo[1]);
  assert(win.movedTo);
  assert.equal(win.isMaximized(), true);
  assert.equal(fits, 6);
  assert.equal(h.timers.size, 0);
});

test('rotation that finishes after a standalone handoff leaves the host hidden and unchanged', async () => {
  const h = setup({ withMain: false });
  h.appWin.setOrientation = async () => true;
  const win = h.open('guest');
  const rotating = h.appWin.rotate({ fullscreen: true });
  assert.equal(await h.appWin.standalone(), true);
  await h.advance(4200);
  assert.equal(await rotating, true, 'the guest accepted its layout change');
  assert.equal(h.appWin.state.landscape, true);
  assert.equal(win.isVisible(), false);
  assert.equal(win.resizedTo, undefined);
  assert.equal(win.movedTo, undefined);
  assert.equal(win.isMaximized(), false);
});

test('setOrientation false, rejection or synchronous failure must not report a successful rotation', async () => {
  for (const mode of ['false', 'reject', 'throw']) {
    const h = setup({ withMain: false });
    h.appWin.setOrientation = () => {
      if (mode === 'throw') throw new Error('cancelled');
      return mode === 'false' ? Promise.resolve(false) : Promise.reject(new Error('cancelled'));
    };
    const win = h.open('guest');
    assert.equal(await h.appWin.rotate(), false);
    assert.equal(h.appWin.state.landscape, false);
    assert.equal(win.resizedTo, undefined);
    assert.equal(win.movedTo, undefined);
    assert.equal([...h.timers].length, 1, 'failed orientation should not arm rotation or fit timers');
  }
});

test('show, hide, refresh and fit cannot overtake native ownership handoff or outlive their host', async () => {
  const h = setup({ withMain: false });
  const pending = deferred(), commands = [];
  const nativeEmbed = h.appWin.agent.embed;
  h.appWin.agent.embed = hwnd => {
    void nativeEmbed(hwnd);
    return hwnd === '1' ? pending.promise : Promise.resolve({ ok: true });
  };
  for (const name of ['show', 'hide', 'refresh', 'fit']) {
    h.appWin.agent[name] = async () => { commands.push(name); return { ok: true }; };
  }
  h.appWin._looksBlackAfterEmbed = async () => false;
  const older = h.open('old');
  const oldEmbedding = h.appWin.embed();
  older.emit('restore');
  older.emit('minimize');
  older.emit('focus');
  older.emit('blur');
  h.appWin._embedded = true;
  h.appWin._revealEmbedded();
  const oldFit = h.appWin.fitNow();
  const newer = h.open('new');
  newer.emit('restore');
  const newEmbedding = h.appWin.embed();
  await h.advance(80);
  assert.deepEqual(commands, [], 'display commands must wait for the pending native operation');
  pending.resolve({ ok: true });
  assert.equal(await oldEmbedding, false);
  await oldFit;
  await flush();
  assert.equal(h.parks.length, 1);
  assert.deepEqual(commands, [], 'stale old commands are skipped and new commands wait for park');
  h.parks[0].resolve();
  assert.equal(await newEmbedding, true);
  await flush();
  assert.deepEqual(commands, ['show', 'fit']);
  assert.equal(h.nativeOwner, '2');
  assert.equal(h.appWin.win, newer);
});

test('AppWindow ignores fit replies from a replaced window', async () => {
  const h = setup({ withMain: false });
  const fit = deferred();
  h.appWin.fitNow = () => {
    h.log.push(`fit:${h.appWin.pkg}`);
    return fit.promise;
  };
  const older = h.open('old');
  older.emit('resize');
  await h.advance(40);
  const newer = h.open('new');
  h.parks[0].resolve();
  await flush();
  older.emit('resize');
  fit.resolve();
  await h.advance(1000);
  assert.equal(h.appWin.win, newer);
  assert.deepEqual(h.log.filter(s => s.startsWith('fit:')), ['fit:old']);
});

test('AppWindow external destroy before or during park does not restart closing or destroy twice', async () => {
  for (const alreadyClosing of [false, true]) {
    const h = setup({ withMain: false });
    const win = h.open('guest', { onClosed: pkg => h.log.push(`local:${pkg}`) });
    if (alreadyClosing) win.close();
    win.destroy();
    const pending = h.appWin.close();
    assert.equal(h.parks.length, 1);
    assert(!h.log.includes('closed:guest'));
    h.parks[0].resolve();
    await pending;
    assert.equal(win.destroyAttempts, 1);
    once(h, 'park', 'stop:guest', 'destroy:1', 'local:guest', 'closed:guest');
    assert.equal(h.timers.size, 0);
  }
});

test('AppWindow completes close after park errors and exceptions in shutdown callbacks', async () => {
  for (const sync of [false, true]) {
    const h = setup({ withMain: false });
    h.appWin.agent.setHook = () => { throw new Error('hook'); };
    if (sync) h.appWin.agent.park = () => { throw new Error('park'); };
    let reentrant;
    h.appWin.onCloseApp(pkg => {
      h.log.push(`stop:${pkg}`);
      reentrant = h.appWin.close();
      throw new Error('stop');
    });
    h.open('guest', { onClosed: async pkg => {
      h.log.push(`local:${pkg}`);
      throw new Error('callback');
    } });
    const pending = h.appWin.close();
    assert.equal(reentrant, pending);
    if (!sync) h.parks[0].reject(new Error('no reply'));
    await pending;
    once(h, 'stop:guest', 'destroy:1', 'local:guest', 'closed:guest');
    assert.equal(h.timers.size, 0);
    assert.equal(await h.appWin.closeAll(), false, 'failed park must remain unconfirmed after single-window close');
    assert.equal(h.timers.size, 0);
  }
});

test('AppWindow close and closeAll are awaitable with no windows and do not leave a cached batch', async () => {
  const h = setup({ withMain: false });
  const pending = h.appWin.close();
  assert.equal(typeof pending?.then, 'function');
  const all = h.appWin.closeAll();
  assert.equal(h.appWin.closeAll(), all);
  const [, confirmed] = await Promise.all([pending, all]);
  assert.equal(confirmed, true);
  assert.notEqual(h.appWin.closeAll(), all);
  assert.equal(h.parks.length, 0);
  assert.equal(h.timers.size, 0);
});

test('quit drains real operation leases before parking windows or disposing the runtime', async () => {
  const h = setup();
  const { RuntimeActions } = require('../src/core/runtime-actions');
  const actions = new RuntimeActions({ status: async () => ({ current: { systemId: 'aosp' } }),
    isQuitting: () => h.context.quitting });
  h.context.runtimeActions = actions;
  const pending = deferred();
  const operation = actions.run('apk:install', () => pending.promise);
  await flush();
  const win = h.open('guest');
  assert(h.app.quit().prevented);
  await flush();
  assert.equal(h.parks.length, 0);
  assert(!win.isDestroyed());
  assert(!h.log.includes('dispose:runtime'));
  await assert.rejects(actions.run('app:launch', () => {}), /退出/);
  pending.resolve();
  await operation;
  await flush();
  assert.equal(h.parks.length, 1);
  assert(!h.log.includes('dispose:runtime'));
  h.parks[0].resolve();
  await flush();
  once(h, 'park', 'dispose:runtime', 'quit-allowed');
});
test('child quit awaits only its private ADB disposer after draining runtime', async () => {
  const h = setup({ isChild: true });
  const pending = deferred();
  h.context.instanceAdb.dispose = () => { h.log.push('dispose:owned-adb'); return pending.promise; };
  assert(h.app.quit().prevented);
  await flush();
  once(h, 'dispose:runtime', 'dispose:owned-adb');
  assert(h.log.indexOf('dispose:runtime') < h.log.indexOf('dispose:owned-adb'));
  assert(!h.log.includes('quit-allowed'));
  pending.resolve();
  await flush();
  once(h, 'dispose:owned-adb', 'quit-allowed');

  const parent = setup();
  parent.app.quit();
  await flush();
  once(parent, 'dispose:owned-adb', 'quit-allowed');
});

test('private ADB disposal failure does not skip final child shutdown', async () => {
  const h = setup({ isChild: true });
  h.context.instanceAdb.dispose = async () => { throw new Error('fixture disposal failed'); };
  h.app.quit();
  await flush();
  once(h, 'destroy:decode', 'quit-allowed');
  assert(h.warnings.some(message => message.includes('自有 ADB')));
});

test('quit waits for production Sharer.stop/join to drain before runtime disposal', async () => {
  const h = setup();
  const sharing = pendingSharing(h);
  h.open('guest');
  assert(h.app.quit().prevented);
  await flush();
  assert.equal(sharing.calls.length, 1);
  assert.equal(sharing.calls[0].timeoutMs, 5000);
  assert.equal(sharing.sharer._run.cancelled, true);
  h.parks[0].resolve();
  await h.advance(4200);
  once(h, 'dispose:agent', 'dispose:wheel', 'closed:guest');
  assert(!h.log.includes('dispose:runtime'));
  assert(!h.log.includes('quit-allowed'));
  sharing.pending.resolve();
  await flush();
  once(h, 'stop:sharer', 'dispose:runtime', 'quit-allowed');
  assert.equal(h.timers.size, 0);
});

test('quit bounds pending sharing at 5000ms and skips runtime disposal on false', async () => {
  const h = setup();
  const sharing = pendingSharing(h);
  assert(h.app.quit().prevented);
  await h.advance(4999);
  assert(!h.log.includes('dispose:runtime'));
  assert(!h.log.includes('quit-allowed'));
  await h.advance(1);
  once(h, 'stop:sharer', 'dispose:agent', 'dispose:wheel', 'destroy:decode', 'quit-allowed');
  assert(!h.log.includes('dispose:runtime'));
  assert(h.warnings.some(s => s.includes('ADB')));
  assert.equal(sharing.calls.length, 1);
  assert.equal(sharing.calls[0].timeoutMs, 5000);
  assert.equal(h.timers.size, 0);
  sharing.pending.resolve();
  await flush();
  assert(!h.log.includes('dispose:runtime'), 'late sharing completion must not dispose a skipped transport');
  once(h, 'quit-allowed');
});

test('runtimeActions drain false logs and skips runtime disposal even when sharing drained', async () => {
  const h = setup();
  h.context.runtimeActions.drain = async () => false;
  h.open('guest');
  h.app.quit();
  await flush();
  h.parks[0].resolve();
  await flush();
  once(h, 'stop:sharer', 'closed:guest', 'dispose:agent', 'quit-allowed');
  assert(!h.log.includes('dispose:runtime'));
  assert(h.warnings.some(s => s.includes('在途操作')));
  assert(h.warnings.some(s => s.includes('ADB')));
});

test('quit is bounded with a permanently pending embed and reports unconfirmed parking', async () => {
  const h = setup();
  h.appWin.agent.embed = () => new Promise(() => {});
  const win = h.open('guest');
  void h.appWin.embed();
  h.app.quit();
  await h.advance(1499);
  assert(!win.isDestroyed());
  assert(!h.log.includes('quit-allowed'));
  await h.advance(1);
  assert(win.isDestroyed());
  once(h, 'closed:guest', 'dispose:agent', 'dispose:runtime', 'quit-allowed');
  assert.equal(h.parks.length, 0);
  assert(h.warnings.some(s => s.includes('停靠')));
  assert.equal(h.timers.size, 0);
});

test('quit waits for a 650ms park and completes disposal and real quit exactly once', async () => {
  const h = setup();
  const win = h.open('guest');
  assert.equal(h.app.quit().prevented, true);
  await flush();
  await h.advance(400);
  assert.equal(win.isDestroyed(), false);
  assert(!h.log.some(s => s.startsWith('dispose:') || s === 'quit-allowed' || s === 'exit'));
  await h.advance(250);
  h.parks[0].resolve();
  await flush();
  assert(win.isDestroyed());
  assert(h.log.indexOf('destroy:1') < h.log.indexOf('dispose:agent'));
  assert(h.log.indexOf('dispose:runtime') < h.log.indexOf('quit-allowed'));
  once(h, 'park', 'stop:sharer', 'stop:notifier', 'closed:guest', 'dispose:agent', 'dispose:wheel', 'dispose:runtime', 'destroy:decode', 'quit-allowed');
  assert(!h.log.includes('stop:guest'));
  assert(!h.log.includes('exit'));
  assert.equal(h.log.filter(v => v === 'quit').length, 2);
  await h.advance(3000);
  once(h, 'dispose:agent', 'quit-allowed');
});
test('in-flight quit interception also blocks another quit and window-all-closed', async () => {
  const h = setup();
  h.open('guest');
  assert(h.app.quit().prevented);
  assert(h.app.quit().prevented);
  h.app.emit('window-all-closed');
  assert(!h.log.includes('exit'));
  assert(!h.log.includes('dispose:agent'));
  await flush();
  h.parks[0].resolve();
  await flush();
  once(h, 'park', 'dispose:agent', 'quit-allowed');
});
test('quit joins a close already started elsewhere and duplicate native close cannot destroy early', async () => {
  const h = setup();
  const win = h.open('guest');
  assert.equal(win.close().prevented, true);
  assert.equal(win.close().prevented, true);
  const pending = h.appWin.close({ keepApp: true });
  assert.equal(typeof pending?.then, 'function');
  assert.equal(h.appWin.close(), pending);
  assert(h.app.quit().prevented);
  await h.advance(500);
  assert(!h.log.includes('dispose:runtime'));
  assert(!win.isDestroyed());
  h.parks[0].resolve();
  await pending;
  await flush();
  once(h, 'park', 'stop:guest', 'closed:guest', 'dispose:agent', 'quit-allowed');
});
test('replacement while parking keeps the new window and waits for both closes on quit', async () => {
  const h = setup();
  const older = h.open('old');
  const newer = h.open('new');
  await flush();
  assert.equal(h.parks.length, 1);
  assert.equal(h.appWin.win, newer);
  assert.equal(older.close().prevented, true);
  h.app.quit();
  await flush();
  assert.equal(h.parks.length, 1, 'new close cannot overtake the pending old park');
  assert(!h.log.includes('dispose:agent'));
  h.parks[0].resolve();
  await flush();
  assert(older.isDestroyed());
  assert(!newer.isDestroyed());
  assert.equal(h.parks.length, 2);
  assert(!h.log.includes('dispose:agent'));
  h.parks[1].resolve();
  await flush();
  once(h, 'closed:old', 'closed:new', 'destroy:1', 'destroy:2', 'dispose:agent', 'quit-allowed');
});
test('hanging park cannot block quit forever; late result cannot re-run teardown', async () => {
  const h = setup();
  h.open('guest');
  h.app.quit();
  await h.advance(700);
  assert(!h.log.includes('dispose:agent'));
  await h.advance(800);
  once(h, 'dispose:agent', 'dispose:wheel', 'dispose:runtime', 'quit-allowed');
  h.parks[0].resolve();
  await flush();
  once(h, 'dispose:agent', 'quit-allowed');
});
test('async rejection and synchronous park failure still close and resume without a fixed delay', async () => {
  for (const sync of [false, true]) {
    const h = setup();
    h.open('guest');
    if (sync) h.appWin.agent.park = () => { throw new Error('no agent'); };
    h.app.quit();
    await flush();
    if (!sync) h.parks[0].reject(new Error('no reply'));
    await flush();
    once(h, 'closed:guest', 'destroy:1', 'dispose:agent', 'quit-allowed');
    assert(![...h.timers].some(t => t.at < 3000), 'quit fallback timer was cleared');
  }
});
test('no open window quits immediately; a throwing stop or disposer cannot skip remaining cleanup', async () => {
  const h = setup();
  h.context.sharer.stop = () => { throw new Error('stop'); };
  h.context.runtime.dispose = () => { throw new Error('dispose'); };
  assert(h.app.quit().prevented);
  await flush();
  once(h, 'stop:notifier', 'dispose:agent', 'dispose:wheel', 'destroy:decode', 'quit-allowed');
  assert(!h.log.includes('park'));
  assert.equal(h.timers.size, 0);
});

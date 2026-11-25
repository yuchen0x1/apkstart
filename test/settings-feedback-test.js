'use strict';
// Execute the current production handlers without Electron or an Android device.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function registration(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `missing production handler: ${marker}`);
  const end = source.indexOf('\n  });', start);
  assert(end > start, `missing handler boundary: ${marker}`);
  return source.slice(start, end + '\n  });'.length);
}

function rendererHandler(id, { displaySet, restore, saveError, readSettings } = {}) {
  const handlers = new Map();
  const calls = [];
  const toasts = [];
  const state = { settings: { engine: { deepTrim: true }, display: { mode: 'window', portrait: '900x1600' }, sentinel: 'keep' } };
  const elements = new Map();
  const element = name => {
    if (!elements.has(name)) elements.set(name, { value: '', checked: false, hidden: false, disabled: false,
      addEventListener: (_event, fn) => handlers.set(name, fn) });
    return elements.get(name);
  };
  const h = {
    state, $: element, toast: value => toasts.push(value),
    save: async patch => {
      calls.push({ channel: 'settings:set', patch: copy(patch) });
      if (saveError) throw saveError;
      state.settings = { ...state.settings, engine: { ...state.settings.engine, ...patch.engine } };
    },
    api: {
      displaySet: async patch => { calls.push({ channel: 'display:set', patch: copy(patch) }); return displaySet ? displaySet(patch) : { ...state.settings.display, ...patch }; },
      getSettings: async () => readSettings ? readSettings() : state.settings,
      restoreSystemApps: async () => { calls.push({ channel: 'settings:restoreSystem' }); return restore ? restore() : true; },
      setSettings: async patch => {
        calls.push({ channel: 'settings:set', patch: copy(patch) });
        state.settings = { ...state.settings, display: { ...state.settings.display, ...patch.display } };
        return state.settings;
      },
    },
  };
  vm.runInNewContext(registration(renderer, `$('${id}').addEventListener('change', async (e) => {`), h);
  return { ...h, element, calls, toasts, run: () => handlers.get(id)({ target: element(id) }) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('display mode waits for the live display endpoint and preserves the rest of settings', async () => {
  const applied = deferred();
  const h = rendererHandler('setDisplayMode', { displaySet: () => applied.promise });
  h.element('setDisplayMode').value = 'fullscreen';
  const result = h.run();
  assert.equal(h.element('setDisplayMode').disabled, true);
  assert.equal(h.toasts.length, 0);
  applied.resolve({ mode: 'fullscreen', portrait: '900x1600' });
  await result;
  assert.deepEqual(h.calls, [{ channel: 'display:set', patch: { mode: 'fullscreen' } }]);
  assert.equal(h.state.settings.sentinel, 'keep');
  assert.equal(h.state.settings.engine.deepTrim, true);
  assert.equal(h.state.settings.display.mode, 'fullscreen');
  assert.equal(h.element('portraitField').hidden, true);
  assert.equal(h.element('setDisplayMode').disabled, false);
  assert.equal(h.toasts.at(-1).type, 'ok');
});

test('display application failure reads back saved preferences and never claims success', async () => {
  const h = rendererHandler('setDisplayMode', {
    displaySet: async () => { throw new Error('rotation failed'); },
    readSettings: async () => ({ engine: {}, display: { mode: 'fullscreen', portrait: '720x1280' } }),
  });
  h.element('setDisplayMode').value = 'fullscreen';
  await h.run();
  assert.equal(h.state.settings.display.mode, 'fullscreen');
  assert.equal(h.element('setDisplayMode').value, 'fullscreen');
  assert.equal(h.element('portraitField').hidden, true);
  assert.equal(h.element('setDisplayMode').disabled, false);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].type, 'error');
  assert.match(h.toasts[0].body, /rotation failed/);
});

test('fallback portrait size saves preferences without claiming a live guest resize', async () => {
  const h = rendererHandler('setPortrait');
  h.element('setPortrait').value = '720x1280';
  await h.run();
  assert.deepEqual(h.calls, [{ channel: 'settings:set', patch: { display: { portrait: '720x1280' } } }]);
  assert.equal(h.state.settings.display.mode, 'window');
  assert.equal(h.state.settings.display.portrait, '720x1280');
  assert.equal(h.state.settings.sentinel, 'keep');
  assert.equal(h.element('setPortrait').disabled, false);
  assert.equal(h.toasts.at(-1).title, '备用画面大小已保存');
});

test('deep trim reports restoration only after the awaited recovery succeeds', async () => {
  const restored = deferred();
  const h = rendererHandler('setDeepTrim', { restore: () => restored.promise });
  h.element('setDeepTrim').checked = false;
  const result = h.run();
  await Promise.resolve();
  assert.equal(h.element('setDeepTrim').disabled, true);
  assert.equal(h.toasts.length, 0);
  restored.resolve(true);
  await result;
  assert.equal(h.state.settings.engine.deepTrim, false);
  assert.equal(h.toasts.at(-1).title, '已恢复系统组件');
  assert.equal(h.element('setDeepTrim').disabled, false);
});

test('offline or unconfirmed restoration remains pending and does not report success', async () => {
  for (const restore of [async () => { throw new Error('device offline'); }, async () => false]) {
    const h = rendererHandler('setDeepTrim', { restore });
    await h.run();
    assert.equal(h.state.settings.engine.deepTrim, false);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].title, '深度裁剪已关闭，系统组件待恢复');
    assert.equal(h.toasts[0].type, 'error');
    assert.match(h.toasts[0].body, /连接原运行时后/);
    assert.doesNotMatch(h.toasts[0].body, /下次.*会重试/);
    assert.equal(h.element('setDeepTrim').disabled, false);
  }
});

test('a failed deep-trim settings save restores the control and never starts recovery', async () => {
  const h = rendererHandler('setDeepTrim', { saveError: new Error('disk denied') });
  await h.run();
  assert.equal(h.element('setDeepTrim').checked, true);
  assert.equal(h.calls.some(call => call.channel === 'settings:restoreSystem'), false);
  assert.equal(h.toasts[0].title, '设置未保存');
});

test('settings save atomically marks restoration only for an enabled-to-disabled transition', async () => {
  for (const previous of [true, false, undefined]) {
    let handler;
    const writes = [];
    const h = {
      ipcMain: { handle(channel, fn) { assert.equal(channel, 'settings:set'); handler = fn; } },
      store: {
        getSettings: () => ({ engine: { deepTrim: previous } }),
        saveSettings(patch) { writes.push(copy(patch)); return patch; },
      },
    };
    vm.runInNewContext(registration(main, "ipcMain.handle('settings:set', (_e, patch) => {"), h);
    const result = await handler(null, { engine: { deepTrim: false, cores: 4 }, themeSentinel: 'keep' });
    assert.equal(writes.length, 1);
    assert.equal(result.engine.cores, 4);
    assert.equal(result.themeSentinel, 'keep');
    assert.equal(result.engine.deepTrimRestorePending, previous === true ? true : undefined);
  }
});

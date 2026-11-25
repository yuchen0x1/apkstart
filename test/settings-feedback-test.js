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

function rendererProfile(respond) {
  const elements = new Map(['autoProfileText', 'runningProfileText', 'profilePendingText',
    'profileFallbackText', 'profileFallbackReason', 'hostSpecText', 'autoTierText']
    .map(id => [id, { textContent: '', hidden: false }]));
  elements.get('profileFallbackText').textContent = '下次启动选档依据：';
  const start = renderer.indexOf('let profileRequest = 0;');
  const end = renderer.indexOf('\n/* ---------------- 自定义镜像', start);
  assert(start >= 0 && end > start, 'missing production profile summary');
  const h = { $: id => elements.get(id), api: { doctorProfile: respond } };
  vm.runInNewContext(renderer.slice(start, end), h);
  return { element: id => elements.get(id), run: () => h.refreshProfileText() };
}

test('performance settings label actual runtime separately from the next startup plan', async () => {
  const h = rendererProfile(async () => ({
    text: '自动：8.0GB 内存 · 8 核 · host 渲染',
    running: '自动：6.0GB 内存 · 6 核 · swangle 渲染 · 硬件加速（运行日志已确认）',
    pending: true,
    fallbackReason: '本次显卡渲染失败，已回退软件渲染。',
    profile: { host: { totalMB: 81920, freeMB: 47820, cores: 32 } },
  }));
  await h.run();
  assert.match(h.element('runningProfileText').textContent, /6\.0GB.*swangle.*运行日志已确认/);
  assert.match(h.element('autoProfileText').textContent, /8\.0GB.*host/);
  assert.equal(h.element('profilePendingText').hidden, false);
  assert.equal(h.element('profilePendingText').textContent,
    '当前运行参数与下次启动计划不同；停止运行时后重新启动将按计划重新尝试。');
  assert.equal(h.element('profileFallbackText').hidden, false);
  assert.equal(h.element('profileFallbackText').textContent, '下次启动选档依据：');
  assert.equal(h.element('profileFallbackReason').textContent, '本次显卡渲染失败，已回退软件渲染。');
  assert.match(h.element('hostSpecText').textContent, /80 GB 内存.*32 线程/);
  const html = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8');
  assert.match(html, /当前运行实际参数：<\/span><span id="runningProfileText"/);
  assert.match(html, /下次启动预期参数：<\/span><span id="autoProfileText"/);
  assert.match(html, /id="profileFallbackText" hidden><span>下次启动选档依据：<\/span><span id="profileFallbackReason"><\/span>/);
});

test('automatic software rendering without a failed attempt does not invent a GPU failure', async () => {
  const h = rendererProfile(async () => ({
    text: '自动：2.0GB 内存 · 2 核 · swangle 渲染',
    running: '自动：2.0GB 内存 · 2 核 · swangle 渲染',
    pending: false,
    why: '远程显示会话使用软件渲染。',
  }));
  await h.run();
  assert.equal(h.element('profilePendingText').hidden, true);
  assert.equal(h.element('profilePendingText').textContent, '');
  assert.equal(h.element('profileFallbackText').hidden, true);
  assert.equal(h.element('profileFallbackText').textContent, '下次启动选档依据：');
  assert.equal(h.element('profileFallbackReason').textContent, '');
  assert.equal(h.element('autoTierText').textContent, '远程显示会话使用软件渲染。');
});

test('stopping Android clears the previous actual profile and stale restart warnings', async () => {
  let response = { text: '下次 host', running: '当前 swangle', pending: true, fallbackReason: '本次已回退软件渲染。' };
  const h = rendererProfile(async () => response);
  await h.run();
  response = { text: '下次 host', running: '', pending: false };
  await h.run();
  assert.equal(h.element('runningProfileText').textContent, '安卓尚未运行');
  assert.equal(h.element('profilePendingText').hidden, true);
  assert.equal(h.element('profileFallbackText').hidden, true);
  assert.equal(h.element('profileFallbackText').textContent, '下次启动选档依据：');
  assert.equal(h.element('profileFallbackReason').textContent, '');
});

test('a failed profile read does not claim Android is stopped or retain an old actual backend', async () => {
  let fail = false;
  const h = rendererProfile(async () => {
    if (fail) throw new Error('IPC unavailable');
    return { text: 'host', running: 'swangle', pending: true, fallbackReason: '已回退' };
  });
  await h.run();
  fail = true;
  await h.run();
  assert.equal(h.element('runningProfileText').textContent, '读取失败，暂时无法确认');
  assert.equal(h.element('autoProfileText').textContent, '读取失败，暂时无法确认');
  assert.equal(h.element('profilePendingText').hidden, true);
  assert.equal(h.element('profileFallbackText').hidden, true);
  assert.equal(h.element('profileFallbackReason').textContent, '');
});

test('an adopted Android runtime keeps the backend confirmation message instead of claiming it stopped', async () => {
  const h = rendererProfile(async () => ({
    text: '自动：8.0GB 内存 · 8 核 · host 渲染',
    running: '已连接安卓，实际启动参数待确认',
    pending: false,
  }));
  await h.run();
  assert.equal(h.element('runningProfileText').textContent, '已连接安卓，实际启动参数待确认');
  assert.equal(h.element('profilePendingText').hidden, true);
});

test('a late profile response cannot overwrite a newer settings or runtime refresh', async () => {
  const first = deferred();
  let calls = 0;
  const h = rendererProfile(() => ++calls === 1 ? first.promise : Promise.resolve({
    text: '新的预期 host', running: '新的实际 host', pending: false,
  }));
  const older = h.run();
  await h.run();
  first.resolve({ text: '旧的预期 swangle', running: '旧的实际 swangle', pending: true });
  await older;
  assert.equal(h.element('runningProfileText').textContent, '新的实际 host');
  assert.equal(h.element('autoProfileText').textContent, '新的预期 host');
  assert.equal(h.element('profilePendingText').hidden, true);
});

test('runtime status refresh updates profiles only while the performance settings page is open', async () => {
  const start = renderer.indexOf('async function refreshStatus() {');
  const end = renderer.indexOf('\n}\n', start) + '\n}'.length;
  assert(start >= 0 && end > start, 'missing production runtime status refresh');
  for (const [opened, section, expected] of [[true, 'performance', 1], [false, 'performance', 0], [true, 'runtime', 0]]) {
    let refreshed = 0;
    const h = {
      $: id => id === 'settingsMask' ? { classList: { contains: name => name === 'on' && opened } } : null,
      settingsSec: section, state: {}, sysUI: { statusRequest: 0 },
      api: { runtimeStatus: async () => ({}), systemStatus: async () => ({ ok: true, current: {} }) },
      renderRuntimeStatus() {}, refreshProfileText() { refreshed++; },
    };
    vm.runInNewContext(renderer.slice(start, end), h);
    await h.refreshStatus();
    assert.equal(refreshed, expected, `opened=${opened}, section=${section}`);
  }
});

'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('async function launchApp(pkg) {');
const end = source.indexOf('\nasync function createShortcut(', start);
assert(start >= 0 && end > start);

function harness(launch) {
  const updates = [], listeners = new Map(), initial = [];
  let unsubscribed = 0, calls = 0;
  const context = {
    state: { apps: [{ package: 'com.example', label: 'Example' }] },
    api: {
      launch: async pkg => { calls += 1; return launch(pkg); },
      on: (event, callback) => {
        listeners.set(event, callback);
        return () => { listeners.delete(event); unsubscribed += 1; };
      },
      winHide() {},
    },
    toast: options => {
      initial.push(options);
      return { update: patch => updates.push(patch), dismiss() {} };
    },
    setTimeout() {},
    renderRuntimeStatus() {},
    refreshApps() {},
  };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'app.js (launchApp)' });
  return { context, updates, initial, listeners, counts: () => ({ unsubscribed, calls }) };
}

test('launch toast follows only its own package progress and releases the listener', async () => {
  let done;
  const h = harness(() => new Promise(resolve => { done = resolve; }));
  const pending = h.context.launchApp('com.example');
  assert.doesNotMatch(h.initial[0].body, /首次/);
  const listener = h.listeners.get('app:launchProgress');
  listener({ package: 'com.other', message: 'wrong app' });
  listener({ package: 'com.example', message: '正在启动应用…' });
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].body, '正在启动应用…');
  await h.context.launchApp('com.example');
  assert.equal(h.counts().calls, 1, 'repeated clicks do not create competing requests/toasts');
  done({ ok: true, detached: true });
  await pending;
  assert.equal(h.context.state.launching, false);
  assert.equal(h.counts().unsubscribed, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.updates.at(-1).title, '已在独立窗口打开');
});

test('IPC rejection becomes visible and does not leave the launcher busy', async () => {
  const h = harness(async () => { throw new Error('fixture IPC disconnected'); });
  await h.context.launchApp('com.example');
  assert.equal(h.context.state.launching, false);
  assert.equal(h.counts().unsubscribed, 1);
  assert.equal(h.updates.at(-1).type, 'error');
  assert.match(h.updates.at(-1).body, /IPC disconnected/);
  await h.context.launchApp('com.example');
  assert.equal(h.counts().calls, 2, 'a failed launch remains retryable');
});

test('immediate launch retry owns a fresh spinner and cannot be dismissed by the prior failure', async () => {
  let done;
  const h = harness(() => new Promise(resolve => { done = resolve; }));
  const timers = [];
  const wrap = { children: [], appendChild(el) { this.children.push(el); } };
  const createElement = () => {
    const nodes = new Map([
      ['.t-title-text', { textContent: '' }], ['.t-body', { textContent: '' }],
    ]);
    const classes = new Set();
    return {
      dataset: {}, style: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
      // Only the production toast template needs DOM nodes in this isolated test.
      set innerHTML(value) {
        if (value.includes('class="spinner"')) nodes.set('.spinner', { remove: () => nodes.delete('.spinner') });
      },
      querySelector(selector) { return nodes.get(selector) || null; },
      remove() { wrap.children = wrap.children.filter(el => el !== this); },
    };
  };
  Object.assign(h.context, {
    _toastSeq: 0, esc: String, $: () => wrap, document: { createElement },
    Date: { now: () => 100000 },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
  });
  const toastStart = source.indexOf('function toast(');
  const toastEnd = source.indexOf('\n/* ----------------', toastStart);
  assert(toastStart >= 0 && toastEnd > toastStart);
  vm.runInNewContext(source.slice(toastStart, toastEnd), h.context, { filename: 'app.js (toast)' });

  const first = h.context.launchApp('com.example');
  done({ ok: false, error: 'fixture launch failure' });
  await first;
  const failedToast = wrap.children[0];
  assert.equal(failedToast.querySelector('.spinner'), null);
  assert.equal(failedToast.classList.contains('error'), true);
  const failureDismiss = timers.find(timer => timer.delay === 6000);
  assert(failureDismiss);

  const retry = h.context.launchApp('com.example');
  const retryToast = wrap.children.at(-1);
  assert.notEqual(retryToast, failedToast);
  assert(retryToast.querySelector('.spinner'));
  assert.equal(retryToast.classList.contains('error'), false);
  await h.context.launchApp('com.example');
  assert.equal(h.counts().calls, 2, 'in-flight duplicate clicks still use the launch lock');

  failureDismiss.callback();
  timers.find(timer => timer.delay === 200).callback();
  assert.deepEqual(wrap.children, [retryToast], 'the old failure timer removes only its own toast');
  assert.equal(h.context.state.launching, true);
  assert(retryToast.querySelector('.spinner'));

  done({ ok: true });
  await retry;
  assert.equal(retryToast.querySelector('.spinner'), null);
  assert.equal(retryToast.classList.contains('error'), false);
  assert.equal(h.context.state.launching, false);
});

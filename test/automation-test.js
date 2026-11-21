'use strict';

// Offline tests only: no Electron, child processes, actual ADB, or emulators.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AutomationRunner, AutomationError, validateScript, validateAction,
  validateTarget, abortableSleep, focusedPackage, LIMITS, KEYS, SCRIPT_SCHEMA,
  RECORDING_NOTICE } = require('../src/core/automation');

const target = Object.freeze({ packageName: 'com.example.app', serial: 'emulator-5554', instanceId: 'window-1' });
const tap = Object.freeze({ type: 'tap', x: 0.5, y: 0.5 });
const script = (actions = [tap], binding = target) => ({ version: 1, target: { ...binding }, actions });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('offline test condition did not settle');
}
class FakeClient {
  constructor() {
    this.serial = target.serial;
    this.online = true;
    this.focus = target.packageName;
    this.size = { width: 101, height: 201 };
    this.inputs = [];
    this.execs = [];
    this.gate = null;
  }
  async isOnline() { return this.online; }
  async wmSize() { return this.size; }
  async input(command, options) {
    this.inputs.push({ command, options });
    if (this.gate) await this.gate.promise;
    return true;
  }
  async exec(args, options) {
    this.execs.push({ args, options });
    if (args.join(' ') === 'shell dumpsys window windows') {
      return { stdout: this.focus ? `WINDOW MANAGER WINDOWS\n  mCurrentFocus=Window{abc u0 ${this.focus}/.Main}\n` : 'mCurrentFocus=null' };
    }
    assert.deepEqual(args.slice(0, 3), ['shell', 'input', 'text']);
    if (this.gate) await this.gate.promise;
    return { stdout: '' };
  }
}
function harness(options = {}) {
  const client = new FakeClient();
  const states = [];
  let selected = client;
  let allowed = true;
  const runner = new AutomationRunner({ getClient: () => selected, canRun: () => allowed,
    onState: state => states.push(state), watchIntervalMs: 10, probeTimeoutMs: 100, ...options });
  return { client, runner, states, select: value => { selected = value; }, allow: value => { allowed = value; } };
}
function invalid(value) { assert.throws(() => validateScript(value), error => error instanceof AutomationError && error.code === 'INVALID_SCRIPT'); }

test('strict JSON schema accepts a frozen defensive copy of only five action types', () => {
  const input = script([tap, { type: 'swipe', x1: 0, y1: 1, x2: 1, y2: 0, durationMs: 200 },
    { type: 'key', key: 'BACK' }, { type: 'text', text: 'hello world!' }, { type: 'wait', durationMs: 1 }]);
  const checked = validateScript(JSON.stringify(input));
  assert.deepEqual(checked, input);
  assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.target) && Object.isFrozen(checked.actions[0]));
  input.actions[0] = { type: 'tap', x: 0, y: 0 };
  assert.equal(checked.actions[0].x, 0.5);
  assert.equal(SCRIPT_SCHEMA.additionalProperties, false);
  assert.equal(SCRIPT_SCHEMA.properties.actions.items.oneOf.length, 5);
  assert.equal(SCRIPT_SCHEMA.properties.actions.maxItems, LIMITS.maxActions);
  assert.ok(Object.isFrozen(SCRIPT_SCHEMA.properties.target.properties));
});

test('rejects extra fields, code, paths, arbitrary shell, getters, prototypes and malformed JSON', () => {
  for (const action of [
    { type: 'exec', command: 'id' }, { type: 'shell', text: 'id' },
    { type: 'tap', x: 0, y: 0, command: 'id' }, { type: 'key', key: 'BACK', repeat: 1000 },
    { type: 'wait', durationMs: 1, file: '/etc/passwd' }, { type: 'eval', code: 'process.exit()' },
    { type: 'text', text: 'ok', delay: 0 }, null, [], 'tap',
  ]) invalid(script([action]));
  invalid({ ...script(), path: 'arbitrary.json' });
  invalid({ ...script(), version: '1' });
  invalid({ ...script(), target: { ...target, device: '*' } });
  invalid('{not JSON');
  invalid(JSON.stringify(script()).replace('"version":1', '"__proto__":{},"version":1'));
  invalid(Object.assign(Object.create({ inherited: true }), script()));
  const accessor = { ...tap };
  Object.defineProperty(accessor, 'x', { get() { assert.fail('getter must not run'); }, enumerable: true });
  invalid(script([accessor]));
  const typeAccessor = { get type() { assert.fail('type getter must not run'); } };
  invalid(script([typeAccessor]));
  const sparse = [tap, , tap];
  invalid(script(sparse));
  const decorated = [tap]; decorated.extra = true;
  invalid(script(decorated));
  const cycle = {}; cycle.self = cycle;
  invalid(cycle);
});

test('bounds action count, total duration, normalized coordinates, keys and text', () => {
  invalid(script([]));
  invalid(script(Array(LIMITS.maxActions + 1).fill(tap)));
  invalid(script(Array(21).fill({ type: 'wait', durationMs: LIMITS.maxWaitMs })));
  invalid(' '.repeat(LIMITS.maxJsonBytes + 1));
  for (const n of [-0.1, 1.1, NaN, Infinity, '0.5', null]) invalid(script([{ type: 'tap', x: n, y: 0 }]));
  for (const n of [0, -1, 0.5, LIMITS.maxWaitMs + 1, '10']) invalid(script([{ type: 'wait', durationMs: n }]));
  for (const n of [0, 49, 3001, 100.5]) invalid(script([{ type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, durationMs: n }]));
  for (const key of ['POWER', 'HOME', 'BACK;id', '4', 4, '__proto__', 'constructor']) invalid(script([{ type: 'key', key }]));
  for (const text of ['', '中文', 'a\nb', 'a\0b', 'a\tb', '%s', 'x'.repeat(257)]) invalid(script([{ type: 'text', text }]));
  assert.equal(validateAction({ type: 'text', text: 'x'.repeat(256) }).text.length, 256);
  for (const serial of ['', '*', '-d', 'emulator-5554;id', 'one two']) assert.throws(() => validateTarget({ ...target, serial }));
  assert.throws(() => validateTarget({ ...target, instanceId: '../another' }));
  assert.throws(() => validateTarget({ ...target, packageName: 'com.foo;id' }));
  assert.throws(() => new AutomationRunner(), /getClient/);
});

test('real API-shaped client receives exact normalized tap/swipe/key/text operations in order', async () => {
  const { runner, client } = harness();
  const text = "hi '$(id);`whoami` & | <> \\\"";
  const result = await runner.run({ script: script([
    { type: 'tap', x: 0, y: 1 },
    { type: 'swipe', x1: 1, y1: 0, x2: 0.5, y2: 0.5, durationMs: 250 },
    { type: 'key', key: 'ENTER' }, { type: 'text', text }, { type: 'wait', durationMs: 1 },
  ]) });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 5);
  assert.deepEqual(client.inputs.map(entry => entry.command), [
    'input tap 0 200', 'input swipe 100 0 50 100 250', `input keyevent ${KEYS.ENTER}`,
  ]);
  const textCommand = client.execs.find(entry => entry.args[1] === 'input');
  assert.deepEqual(textCommand.args, ['shell', 'input', 'text', `'${text.replace(/ /g, '%s').replace(/'/g, "'\\''")}'`]);
  assert.ok(client.execs.every(entry => entry.options.withSerial === true));
  assert.ok(client.inputs.every(entry => entry.options.timeout === LIMITS.commandTimeoutMs));
  await runner.dispose();
});

test('no discovery, broadcasting or retries: reject wrong serial/client/focus before input', async () => {
  for (const mutation of [
    h => { h.client.serial = ''; }, h => { h.client.serial = 'emulator-9999'; },
    h => { h.client.focus = 'com.other.app'; }, h => { h.client.focus = ''; },
    h => { h.client.online = false; }, h => { h.allow(false); }, h => { h.allow({ ok: true }); },
  ]) {
    const h = harness(); mutation(h);
    const result = await h.runner.run({ script: script() });
    assert.equal(result.ok, false);
    assert.equal(h.client.inputs.length, 0);
    await h.runner.dispose();
  }
  assert.equal(focusedPackage('mFocusedApp=AppWindowToken{com.example.app/.Main}'), '');
  assert.equal(focusedPackage('mCurrentFocus=null'), '');
  assert.equal(focusedPackage('mCurrentFocus=Window{a u0 com.example.app/.Main}\nmCurrentFocus=Window{b u0 com.other.app/.Main}'), '');
});

test('provider and host predicate are checked again after asynchronous screen probes', async () => {
  for (const change of ['client', 'serial', 'window', 'focus']) {
    const h = harness();
    h.client.wmSize = async () => {
      if (change === 'client') h.select(new FakeClient());
      if (change === 'serial') h.client.serial = 'emulator-9999';
      if (change === 'window') h.allow(false);
      if (change === 'focus') h.client.focus = 'com.other.app';
      return { width: 101, height: 201 };
    };
    const result = await h.runner.run({ script: script() });
    assert.equal(result.ok, false, change);
    assert.equal(h.client.inputs.length, 0, change);
    await h.runner.dispose();
  }
});

test('bad display dimensions fail closed rather than using arbitrary default coordinates', async () => {
  for (const size of [null, { width: 0, height: 100 }, { width: 20000, height: 100 }, { width: '100', height: 100 }]) {
    const h = harness(); h.client.size = size;
    assert.equal((await h.runner.run({ script: script() })).ok, false);
    assert.equal(h.client.inputs.length, 0);
    await h.runner.dispose();
  }
});

test('one runner at a time, including across instances; cancel retains lease for an in-flight write', async () => {
  const h = harness(); const other = harness();
  h.client.gate = deferred();
  const pending = h.runner.run({ script: script([tap, tap]) });
  await until(() => h.client.inputs.length === 1);
  await assert.rejects(h.runner.perform({ target, action: tap }), { code: 'BUSY' });
  await assert.rejects(other.runner.run({ script: script() }), { code: 'BUSY' });
  assert.equal(h.runner.cancel().cancelled, true);
  assert.equal(h.runner.status().status, 'stopping');
  await assert.rejects(other.runner.run({ script: script() }), { code: 'BUSY' });
  h.client.gate.resolve();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.client.inputs.length, 1);
  assert.equal((await other.runner.run({ script: script() })).ok, true);
  await h.runner.dispose(); await other.runner.dispose();
});

test('abort interrupts wait scheduling, and a pre-aborted signal never acquires a client', async () => {
  const h = harness(); const controller = new AbortController();
  const pending = h.runner.run({ script: script([{ type: 'wait', durationMs: 30000 }, tap]) }, { signal: controller.signal });
  await until(() => h.client.execs.length >= 2);
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.client.inputs.length, 0);
  const calls = h.client.execs.length;
  assert.equal((await h.runner.run({ script: script() }, { signal: controller.signal })).status, 'cancelled');
  assert.equal(h.client.execs.length, calls);
  await h.runner.dispose();
});

test('watchdog stops waits on disconnect, focus loss, instance replacement and window closure', async () => {
  for (const cause of ['offline', 'focus', 'window', 'instance']) {
    const h = harness();
    const pending = h.runner.run({ script: script([{ type: 'wait', durationMs: 30000 }, tap]) });
    await until(() => h.client.execs.length >= 2);
    if (cause === 'offline') h.client.online = false;
    if (cause === 'focus') h.client.focus = 'com.other.app';
    if (cause === 'window') h.allow(false);
    if (cause === 'instance') h.select(new FakeClient());
    const result = await pending;
    assert.equal(result.status, 'stopped', cause);
    assert.equal(h.client.inputs.length, 0, cause);
    assert.equal(h.runner.status().running, false);
    await h.runner.dispose();
  }
});

test('read-only probes time out; input failures are not retried or leaked into status', async () => {
  const h = harness({ probeTimeoutMs: 10 });
  h.client.isOnline = () => new Promise(() => {});
  const timeout = await h.runner.run({ script: script() });
  assert.equal(timeout.code, 'PROBE_TIMEOUT');
  assert.equal(h.runner.status().running, false);
  await h.runner.dispose();
  const f = harness();
  f.client.input = async command => { f.client.inputs.push(command); throw new Error('secret typed-text shell path'); };
  const failure = await f.runner.run({ script: script([tap, tap]) });
  assert.equal(failure.code, 'DEVICE_ERROR');
  assert.equal(f.client.inputs.length, 1);
  assert.ok(!JSON.stringify([failure, f.states]).includes('secret'));
  await f.runner.dispose();
});

test('scripts are snapshotted before asynchronous probes and never evaluated', async () => {
  const gate = deferred();
  const h = harness();
  h.client.isOnline = () => gate.promise;
  const input = script();
  const pending = h.runner.run({ script: input });
  input.target.packageName = 'com.other.app';
  input.actions[0] = { type: 'key', key: 'POWER' };
  gate.resolve(true);
  assert.equal((await pending).ok, true);
  assert.equal(h.client.inputs[0].command, 'input tap 50 100');
  await h.runner.dispose();
});

test('recording captures only successful explicit panel actions, normalized coordinates and idle gaps', async () => {
  let clock = 1000;
  const h = harness({ now: () => clock });
  assert.equal((await h.runner.recordStart({ target })).status, 'recording');
  clock += 125;
  assert.equal((await h.runner.perform({ target, action: tap })).ok, true);
  clock += 50;
  await h.runner.perform({ target, action: { type: 'text', text: 'private-value' } });
  clock += 40;
  await h.runner.perform({ target, action: { type: 'key', key: 'BACK' } });
  const recording = h.runner.recordStop();
  assert.deepEqual(recording.script.actions, [
    { type: 'wait', durationMs: 125 }, tap,
    { type: 'wait', durationMs: 90 }, { type: 'key', key: 'BACK' },
  ]);
  assert.deepEqual(validateScript(recording.script), recording.script);
  assert.ok(!JSON.stringify([recording, h.states, h.runner.status()]).includes('private-value'));
  assert.match(RECORDING_NOTICE, /不录原生窗口\/全局键盘/);
  await h.runner.dispose();
});

test('text recording requires explicit opt-in; replay and target rebinding are prohibited during recording', async () => {
  const h = harness();
  await h.runner.recordStart({ target, recordText: true });
  await assert.rejects(h.runner.run({ script: script() }), { code: 'RECORDING' });
  await assert.rejects(h.runner.perform({ target: { ...target, instanceId: 'window-2' }, action: tap }), { code: 'TARGET_CHANGED' });
  await h.runner.perform({ target, action: { type: 'text', text: 'explicit' } });
  const recording = h.runner.recordStop({});
  assert.ok(recording.script.actions.some(action => action.type === 'text' && action.text === 'explicit'));
  await assert.rejects(h.runner.recordStart({ target, recordText: 'true' }), { code: 'INVALID_SCRIPT' });
  await h.runner.dispose();
});

test('recording idle watchdog stops on target loss and preserves completed actions', async () => {
  const h = harness();
  await h.runner.recordStart({ target });
  await h.runner.perform({ target, action: tap });
  h.client.online = false;
  await until(() => !h.runner.status().recording);
  const result = h.runner.recordStop();
  assert.equal(result.reason, 'OFFLINE');
  assert.ok(result.script.actions.some(action => action.type === 'tap'));
  await h.runner.dispose();
});

test('long recording gaps split into bounded waits and action/time limits stop capture safely', async () => {
  let clock = 0;
  const h = harness({ now: () => clock });
  await h.runner.recordStart({ target });
  clock = 65000;
  await h.runner.perform({ target, action: tap });
  assert.deepEqual(h.runner.recordStop().script.actions.map(action => action.durationMs || action.type), [30000, 30000, 5000, 'tap']);
  await h.runner.recordStart({ target });
  for (let i = 0; i <= LIMITS.maxActions; i++) await h.runner.perform({ target, action: tap });
  assert.equal(h.runner.status().recording, false);
  const result = h.runner.recordStop();
  assert.equal(result.reason, 'RECORDING_LIMIT');
  assert.equal(result.script.actions.length, LIMITS.maxActions);
  await h.runner.dispose();
});

test('runtime deadline, cancelled probes and dispose prevent future work', async () => {
  let clock = 0;
  const h = harness({ now: () => clock });
  h.client.wmSize = async () => { clock = LIMITS.maxDurationMs + 1; return h.client.size; };
  assert.equal((await h.runner.run({ script: script() })).code, 'DURATION_LIMIT');
  assert.equal(h.client.inputs.length, 0);
  await h.runner.dispose();
  await assert.rejects(h.runner.run({ script: script() }), { code: 'DISPOSED' });
  const g = harness();
  g.client.wmSize = () => new Promise(() => {});
  const pending = g.runner.run({ script: script() });
  await until(() => g.client.execs.length > 0);
  await g.runner.dispose();
  assert.equal((await pending).status, 'stopped');
  assert.equal(g.client.inputs.length, 0);
});

test('abortable sleep cancels promptly without waiting out its delay', async () => {
  const controller = new AbortController();
  const pending = abortableSleep(30000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  await assert.rejects(abortableSleep(30000, { signal: controller.signal }), { code: 'CANCELLED' });
});

// The browser component tests are added below; its tiny fake DOM is local to
// this file, so importing either module can never reach a real device.

class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.attributes = {}; this.listeners = new Map(); this.textContent = ''; this.className = '';
    this.value = ''; this.checked = false; this.disabled = false; this.type = '';
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  dispatch(name, event = {}) {
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const callback of this.listeners.get(name) || []) callback(event);
    return event;
  }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); }
}
class FakeDocument {
  createElement(tag) { return new FakeNode(this, tag); }
}
function uiHarness() {
  const document = new FakeDocument();
  const root = new FakeNode(document, 'div');
  const calls = [];
  const bridge = {
    run: async payload => { calls.push(['run', payload]); return { ok: true, status: 'completed', completed: payload.script.actions.length, total: payload.script.actions.length }; },
    action: async payload => { calls.push(['action', payload]); return { ok: true, status: 'completed', completed: 1, total: 1 }; },
    cancel: async () => { calls.push(['cancel']); return { ok: true, cancelled: true, status: 'idle' }; },
    status: async () => ({ ok: true, running: false, recording: false, status: 'idle',
      target: { ...target } }),
  };
  const api = { automation: bridge };
  return { document, root, api, calls };
}
function descendants(node, output = []) {
  for (const child of node.children) { output.push(child); descendants(child, output); }
  return output;
}
function byName(root, name) { return descendants(root).find(node => node.dataset.automation === name); }
async function click(node) { node.dispatch('click'); await new Promise(resolve => setTimeout(resolve, 25)); }

test('browser component mounts via apkAutomation.mount, submits only explicit panel actions, and never records text by default', async () => {
  const ui = require('../src/ui/automation');
  const h = uiHarness();
  const mounted = ui.mountAutomation({ root: h.root, api: h.api });
  assert.equal(h.root.children[0], mounted.element);
  await mounted.ready;
  assert.match(byName(h.root, 'target').textContent, /点击“绑定当前应用实例”/);
  byName(h.root, 'tap-form').dispatch('submit');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.calls.filter(call => call[0] === 'action').length, 0);
  await click(byName(h.root, 'bind'));
  assert.match(byName(h.root, 'notice').textContent, /只记录本面板，不录原生窗口\/全局键盘/);
  assert.match(byName(h.root, 'notice').textContent, /不是全局真实输入录制/);
  assert.equal(byName(h.root, 'record-text').checked, false);
  assert.ok(descendants(h.root).every(node => !/keydown|keyup|global/.test([...node.listeners.keys()].join(' '))));
  assert.ok(descendants(h.root).every(node => node.tagName !== 'SCRIPT' && node.tagName !== 'IFRAME'));
  await click(byName(h.root, 'record-start'));
  assert.equal(byName(h.root, 'record-state').textContent.includes('正在录制'), true);
  byName(h.root, 'tap-x').value = '0.25'; byName(h.root, 'tap-y').value = '0.75';
  byName(h.root, 'tap-form').dispatch('submit');
  await until(() => h.calls.some(call => call[0] === 'action'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(h.calls.find(call => call[0] === 'action')[1], { target, action: { type: 'tap', x: 0.25, y: 0.75 } });
  byName(h.root, 'text').value = 'not-recorded';
  byName(h.root, 'text-form').dispatch('submit');
  await new Promise(resolve => setTimeout(resolve, 25));
  await click(byName(h.root, 'record-stop'));
  const script = JSON.parse(byName(h.root, 'json').value);
  assert.ok(script.actions.some(action => action.type === 'tap' && action.x === 0.25));
  assert.ok(script.actions.every(action => action.type !== 'text'));
  assert.equal(byName(h.root, 'record-text').checked, false);
  mounted.destroy();
  assert.equal(h.root.children.length, 0);
});

test('browser import is text-only and never auto-runs; replay requires an exact trusted target and approval is per click', async () => {
  const ui = require('../src/ui/automation');
  const h = uiHarness();
  const mounted = ui.mountAutomation({ container: h.root, api: h.api });
  await mounted.ready;
  await click(byName(h.root, 'bind'));
  const text = byName(h.root, 'json');
  text.value = JSON.stringify(script([tap]));
  await click(byName(h.root, 'import'));
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 0);
  assert.deepEqual(mounted.getScript(), script());
  await click(byName(h.root, 'replay'));
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  text.value = JSON.stringify(script([tap], { ...target, instanceId: 'window-other' }));
  await click(byName(h.root, 'replay'));
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  assert.match(byName(h.root, 'status').textContent, /不匹配/);
  text.value = JSON.stringify({ ...script(), actions: [{ type: 'exec', command: 'id' }] });
  await click(byName(h.root, 'import'));
  assert.match(byName(h.root, 'status').textContent, /仅允许 tap\/swipe\/key\/text\/wait/);
  text.value = JSON.stringify(script([{ type: 'text', text: '中文' }]));
  await click(byName(h.root, 'import'));
  assert.match(byName(h.root, 'status').textContent, /仅支持可打印 ASCII/);
  mounted.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(h.calls.some(call => call[0] === 'cancel'));
});

test('browser text opt-in is explicit, uses no innerHTML, and cleans the textarea on teardown', async () => {
  const ui = require('../src/ui/automation');
  const h = uiHarness();
  const mounted = ui.mountAutomation({ root: h.root, api: h.api });
  await mounted.ready;
  await click(byName(h.root, 'bind'));
  byName(h.root, 'record-text').checked = true;
  await click(byName(h.root, 'record-start'));
  byName(h.root, 'text').value = 'explicit text';
  byName(h.root, 'text-form').dispatch('submit');
  await until(() => h.calls.some(call => call[0] === 'action'));
  await new Promise(resolve => setTimeout(resolve, 25));
  await click(byName(h.root, 'record-stop'));
  const recorded = JSON.parse(byName(h.root, 'json').value);
  assert.ok(recorded.actions.some(action => action.type === 'text' && action.text === 'explicit text'));
  mounted.destroy();
  assert.equal(byName(h.root, 'json'), undefined);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'automation.js'), 'utf8');
  assert.ok(!source.includes('innerHTML') && !source.includes('outerHTML') && !source.includes('insertAdjacentHTML'));
  assert.ok(!/\beval\s*\(|new Function/.test(source));
});

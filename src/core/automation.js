'use strict';

/**
 * Explicit, panel-only automation. No Electron, device discovery, hooks, eval,
 * filesystem access or user-supplied commands. The owner must authenticate IPC
 * senders and bind instanceId to an existing application-window session.
 *
 * getClient(target) must return the existing, window-bound Runtime client.
 * canRun(target, client) must return exactly true while that session is alive.
 * Both are rechecked; the client object AND its serial are pinned for the run.
 * Closing the owning window must also call cancel('window-closed').
 */
const LIMITS = Object.freeze({
  maxJsonBytes: 128 * 1024,
  maxActions: 256,
  maxWaitMs: 30000,
  minSwipeMs: 50,
  maxSwipeMs: 3000,
  maxDurationMs: 10 * 60 * 1000,
  maxTextLength: 256,
  maxScreenSize: 16384,
  commandTimeoutMs: 8000,
});
const KEYS = Object.freeze({
  BACK: 4, ENTER: 66, TAB: 61, DEL: 67, FORWARD_DEL: 112,
  DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
  DPAD_CENTER: 23, SPACE: 62, ESCAPE: 111, MOVE_HOME: 122,
  MOVE_END: 123, PAGE_UP: 92, PAGE_DOWN: 93,
});
const RECORDING_NOTICE = '只记录本面板显式发送的操作和间隔，不录原生窗口/全局键盘，不使用后台 hook；文本默认不记录。';
const TEXT_NOTICE = '文本仅支持可打印 ASCII（不含 %），不支持中文、换行或密码录制；请勿输入敏感信息。';
const PACKAGE_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+$';
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]*$';
const TEXT_PATTERN = '^[\\x20-\\x24\\x26-\\x7e]+$';
const packageRe = new RegExp(PACKAGE_PATTERN);
const idRe = new RegExp(ID_PATTERN);
const textRe = new RegExp(TEXT_PATTERN);

function actionSchema(type, properties, required) {
  return { type: 'object', additionalProperties: false,
    required: ['type', ...required], properties: { type: { const: type }, ...properties } };
}
const coordinateSchema = { type: 'number', minimum: 0, maximum: 1 };
// Machine-readable schema and the dependency-free validator below have the same
// shape/limits. The validator additionally bounds aggregate duration/JSON bytes.
const SCRIPT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['version', 'target', 'actions'],
  properties: {
    version: { const: 1 },
    target: {
      type: 'object', additionalProperties: false,
      required: ['packageName', 'serial', 'instanceId'],
      properties: {
        packageName: { type: 'string', minLength: 3, maxLength: 255, pattern: PACKAGE_PATTERN },
        serial: { type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN },
        instanceId: { type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN },
      },
    },
    actions: {
      type: 'array', minItems: 1, maxItems: LIMITS.maxActions,
      items: { oneOf: [
        actionSchema('tap', { x: coordinateSchema, y: coordinateSchema }, ['x', 'y']),
        actionSchema('swipe', { x1: coordinateSchema, y1: coordinateSchema,
          x2: coordinateSchema, y2: coordinateSchema,
          durationMs: { type: 'integer', minimum: LIMITS.minSwipeMs, maximum: LIMITS.maxSwipeMs } },
        ['x1', 'y1', 'x2', 'y2', 'durationMs']),
        actionSchema('key', { key: { enum: Object.keys(KEYS) } }, ['key']),
        actionSchema('text', { text: { type: 'string', minLength: 1,
          maxLength: LIMITS.maxTextLength, pattern: TEXT_PATTERN } }, ['text']),
        actionSchema('wait', { durationMs: { type: 'integer', minimum: 1, maximum: LIMITS.maxWaitMs } }, ['durationMs']),
      ] },
    },
  },
};
function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}
freezeTree(SCRIPT_SCHEMA);

class AutomationError extends Error {
  constructor(code, message) { super(message); this.name = 'AutomationError'; this.code = code; }
}
function fail(message) { throw new AutomationError('INVALID_SCRIPT', message); }
function object(value, allowed, required = allowed, label = '对象') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label}必须是普通 JSON 对象`);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail(`${label}包含不允许的字段`);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !desc.enumerable || !Object.hasOwn(desc, 'value')) fail(`${label}必须只含 JSON 数据字段`);
  }
  if (required.some(key => !Object.hasOwn(value, key))) fail(`${label}缺少必需字段`);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}必须是 ${min}..${max} 的整数`);
  return value;
}
function coordinate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('坐标必须是 0..1 的有限数字');
  return value;
}
function validateTarget(raw) {
  object(raw, ['packageName', 'serial', 'instanceId'], undefined, '目标');
  if (typeof raw.packageName !== 'string' || raw.packageName.length > 255 || !packageRe.test(raw.packageName)) fail('目标应用包名无效');
  for (const key of ['serial', 'instanceId']) {
    if (typeof raw[key] !== 'string' || raw[key].length > 128 || !idRe.test(raw[key])) fail(`目标 ${key} 无效`);
  }
  return Object.freeze({ packageName: raw.packageName, serial: raw.serial, instanceId: raw.instanceId });
}
function validateAction(raw) {
  if (!raw || typeof raw !== 'object') fail('动作必须是 JSON 对象');
  // Read the type only after rejecting accessors.
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'type');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('动作缺少 type');
  switch (descriptor.value) {
    case 'tap':
      object(raw, ['type', 'x', 'y']);
      return Object.freeze({ type: 'tap', x: coordinate(raw.x), y: coordinate(raw.y) });
    case 'swipe':
      object(raw, ['type', 'x1', 'y1', 'x2', 'y2', 'durationMs']);
      return Object.freeze({ type: 'swipe', x1: coordinate(raw.x1), y1: coordinate(raw.y1),
        x2: coordinate(raw.x2), y2: coordinate(raw.y2),
        durationMs: integer(raw.durationMs, LIMITS.minSwipeMs, LIMITS.maxSwipeMs, '滑动时长') });
    case 'key':
      object(raw, ['type', 'key']);
      if (typeof raw.key !== 'string' || !Object.hasOwn(KEYS, raw.key)) fail('按键不在白名单内');
      return Object.freeze({ type: 'key', key: raw.key });
    case 'text':
      object(raw, ['type', 'text']);
      if (typeof raw.text !== 'string' || !raw.text.length || raw.text.length > LIMITS.maxTextLength || !textRe.test(raw.text)) fail(TEXT_NOTICE);
      return Object.freeze({ type: 'text', text: raw.text });
    case 'wait':
      object(raw, ['type', 'durationMs']);
      return Object.freeze({ type: 'wait', durationMs: integer(raw.durationMs, 1, LIMITS.maxWaitMs, '等待时长') });
    default: fail('动作类型仅允许 tap/swipe/key/text/wait');
  }
}
function validateScript(raw) {
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.maxJsonBytes || Buffer.byteLength(raw, 'utf8') > LIMITS.maxJsonBytes) fail('脚本 JSON 过大');
    try { raw = JSON.parse(raw); } catch (_) { fail('脚本不是有效的 JSON'); }
  }
  object(raw, ['version', 'target', 'actions'], undefined, '脚本');
  if (raw.version !== 1) fail('仅支持脚本 version: 1');
  const target = validateTarget(raw.target);
  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > LIMITS.maxActions) fail(`动作数量必须为 1..${LIMITS.maxActions}`);
  const actions = [];
  let duration = 0;
  for (let i = 0; i < raw.actions.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(raw.actions, String(i));
    if (!desc || !Object.hasOwn(desc, 'value')) fail('动作数组不允许空洞或访问器');
    const action = validateAction(desc.value);
    duration += action.durationMs || 0;
    if (duration > LIMITS.maxDurationMs) fail('脚本总等待/滑动时间不能超过 10 分钟');
    actions.push(action);
  }
  if (Reflect.ownKeys(raw.actions).length !== raw.actions.length + 1) fail('动作数组包含额外字段');
  const script = { version: 1, target, actions: Object.freeze(actions) };
  if (Buffer.byteLength(JSON.stringify(script), 'utf8') > LIMITS.maxJsonBytes) fail('脚本 JSON 过大');
  return Object.freeze(script);
}
function sameTarget(a, b) {
  return a.packageName === b.packageName && a.serial === b.serial && a.instanceId === b.instanceId;
}
function abortError(signal) {
  return signal?.reason instanceof AutomationError ? signal.reason : new AutomationError('CANCELLED', '操作已取消');
}
function abortableSleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    let timer;
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError(signal)); };
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function focusedPackage(output) {
  if (typeof output !== 'string' || output.length > 2 * 1024 * 1024) return '';
  const focus = output.split(/\r?\n/).filter(line => /^\s*mCurrentFocus\s*=/.test(line));
  if (focus.length !== 1) return '';
  const match = /\bu\d+\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\/[^\s}]+/.exec(focus[0]);
  return match ? match[1] : '';
}
function quoteText(text) {
  // adb joins remote arguments before Android's shell parses them. Always quote
  // the ONE text argument, including apostrophes, and never accept a command.
  return `'${text.replace(/ /g, '%s').replace(/'/g, "'\\''")}'`;
}
const STOP_CODES = new Set(['OFFLINE', 'TARGET_CHANGED', 'TARGET_UNAVAILABLE', 'TARGET_NOT_FOREGROUND', 'PROBE_TIMEOUT', 'DURATION_LIMIT', 'DISPOSED']);
let activeLease = null; // one input runner in this process, even across instances

class AutomationRunner {
  constructor({ getClient, canRun, onState = () => {}, now = () => performance.now(),
    sleep = abortableSleep, watchIntervalMs = 500, probeTimeoutMs = 5000 } = {}) {
    if (typeof getClient !== 'function' || typeof canRun !== 'function') throw new TypeError('getClient 与 canRun 必须显式提供');
    if (typeof sleep !== 'function' || typeof now !== 'function' || typeof onState !== 'function') throw new TypeError('无效的自动化依赖');
    if (!Number.isSafeInteger(watchIntervalMs) || watchIntervalMs < 10 || watchIntervalMs > 5000
      || !Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 10 || probeTimeoutMs > 30000) throw new TypeError('无效的检查间隔');
    Object.assign(this, { getClient, canRun, onState, now, sleep, watchIntervalMs, probeTimeoutMs });
    this._active = null;
    this._recording = null;
    this._lastRecording = null;
    this._lastResult = null;
    this._disposed = false;
    this._sequence = 0;
  }

  status() {
    const ctx = this._active;
    return {
      ok: true, running: !!ctx, recording: !!this._recording,
      status: ctx ? (ctx.controller.signal.aborted ? 'stopping' : 'running')
        : this._recording ? 'recording' : this._lastResult?.status || 'idle',
      mode: ctx?.mode || null, runId: ctx?.runId || null,
      target: ctx?.target || this._recording?.target || null,
      completed: ctx?.completed || 0, total: ctx?.actions.length || 0,
      recordedActions: this._recording?.actions.length || 0,
      recordText: this._recording?.recordText === true,
      recordingReason: this._lastRecording?.reason || null,
      code: this._lastResult?.code || null,
    };
  }

  _notify() { try { this.onState(this.status()); } catch (_) { /* observational only */ } }
  _assert(ctx) {
    if (ctx.controller.signal.aborted) throw abortError(ctx.controller.signal);
    if (this._disposed) throw new AutomationError('DISPOSED', '自动化面板已关闭');
    if (this.now() >= ctx.deadline) throw new AutomationError('DURATION_LIMIT', '自动化最长运行/录制 10 分钟');
  }

  // Only read-only probes may be detached on cancellation/timeout. Input writes
  // must settle before releasing the lease (AdbClient does not accept signals).
  _probe(ctx, factory) {
    this._assert(ctx);
    return new Promise((resolve, reject) => {
      const signal = ctx.controller.signal;
      let done = false;
      let timer;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(abortError(signal));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new AutomationError('PROBE_TIMEOUT', '目标状态检查超时，已停止')), this.probeTimeoutMs);
      Promise.resolve().then(() => { this._assert(ctx); return factory(); }).then(value => finish(null, value), error => finish(error));
    });
  }

  async _host(ctx, initial = false) {
    this._assert(ctx);
    const client = await this._probe(ctx, () => this.getClient(ctx.target));
    if (!client || client.serial !== ctx.target.serial || (!initial && client !== ctx.client)) throw new AutomationError('TARGET_CHANGED', '目标运行时实例已变化');
    if (initial) {
      for (const method of ['isOnline', 'exec', 'input', 'wmSize']) {
        if (typeof client[method] !== 'function') throw new AutomationError('TARGET_UNAVAILABLE', '目标客户端不支持自动化');
      }
      ctx.client = client;
    }
    if (await this._probe(ctx, () => this.canRun(ctx.target, client)) !== true) throw new AutomationError('TARGET_UNAVAILABLE', '目标窗口已关闭、退出或不允许操作');
    this._assert(ctx);
    if (client.serial !== ctx.target.serial) throw new AutomationError('TARGET_CHANGED', '目标设备已变化');
  }

  async _guard(ctx, initial = false) {
    await this._host(ctx, initial);
    if (await this._probe(ctx, () => ctx.client.isOnline()) !== true) throw new AutomationError('OFFLINE', '目标客机已断开');
    const result = await this._probe(ctx, () => ctx.client.exec(['shell', 'dumpsys', 'window', 'windows'],
      { timeout: this.probeTimeoutMs, withSerial: true }));
    if (focusedPackage(result?.stdout) !== ctx.target.packageName) throw new AutomationError('TARGET_NOT_FOREGROUND', '指定应用不是客机当前焦点应用，已停止');
    await this._host(ctx);
  }

  async _watch(ctx) {
    try {
      while (!ctx.controller.signal.aborted) {
        await this.sleep(this.watchIntervalMs, { signal: ctx.controller.signal });
        await this._guard(ctx);
      }
    } catch (error) {
      if (!ctx.controller.signal.aborted) {
        ctx.controller.abort(error instanceof AutomationError ? error : new AutomationError('OFFLINE', '目标状态读取失败，已停止'));
        this._notify();
      }
    }
  }

  async _dispatch(ctx, action) {
    let size;
    if (action.type === 'tap' || action.type === 'swipe') {
      size = await this._probe(ctx, () => ctx.client.wmSize());
      if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
        || size.width < 2 || size.height < 2 || size.width > LIMITS.maxScreenSize || size.height > LIMITS.maxScreenSize) throw new AutomationError('TARGET_UNAVAILABLE', '无法确认目标屏幕尺寸');
    }
    await this._guard(ctx); // a fence after asynchronous size/focus probes
    this._assert(ctx);
    const signal = ctx.controller.signal;
    const options = { timeout: LIMITS.commandTimeoutMs, withSerial: true };
    const x = value => Math.round(value * (size.width - 1));
    const y = value => Math.round(value * (size.height - 1));
    switch (action.type) {
      case 'wait': await this.sleep(action.durationMs, { signal }); break;
      case 'tap': await ctx.client.input(`input tap ${x(action.x)} ${y(action.y)}`, options); break;
      case 'swipe': await ctx.client.input(`input swipe ${x(action.x1)} ${y(action.y1)} ${x(action.x2)} ${y(action.y2)} ${action.durationMs}`, options); break;
      case 'key': await ctx.client.input(`input keyevent ${KEYS[action.key]}`, options); break;
      case 'text': await ctx.client.exec(['shell', 'input', 'text', quoteText(action.text)], options); break;
      default: throw new AutomationError('INVALID_SCRIPT', '不允许的动作');
    }
    this._assert(ctx);
  }

  async _execute({ target, actions, mode, signal, recordText = false }) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal 必须是 AbortSignal');
    if (this._disposed) throw new AutomationError('DISPOSED', '自动化面板已关闭');
    if (this._active || activeLease) throw new AutomationError('BUSY', '已有自动化操作正在执行或停止，请稍候');
    if (this._recording && mode !== 'manual') throw new AutomationError('RECORDING', '请先停止面板录制');
    if (this._recording && !sameTarget(this._recording.target, target)) throw new AutomationError('TARGET_CHANGED', '录制已绑定其他应用实例');
    const requestAt = this.now();
    const ctx = { target, actions, mode, completed: 0, client: null,
      runId: ++this._sequence, controller: new AbortController(), deadline: requestAt + LIMITS.maxDurationMs };
    ctx.done = new Promise(resolve => { ctx.resolveDone = resolve; });
    this._active = ctx;
    activeLease = ctx;
    const externalAbort = () => ctx.controller.abort(new AutomationError('CANCELLED', '操作已取消'));
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    let watcher;
    let result;
    this._notify();
    try {
      await this._guard(ctx, true);
      if (this._recording && this._recording.client !== ctx.client) throw new AutomationError('TARGET_CHANGED', '录制目标客户端已变化');
      if (mode === 'record-start') {
        this._recording = { target, client: ctx.client, actions: [], recordText,
          lastEnd: this.now(), deadline: this.now() + LIMITS.maxDurationMs,
          controller: new AbortController() };
        this._lastRecording = null;
        this._watchRecording(this._recording);
        result = { ok: true, status: 'recording', target };
      } else {
        watcher = this._watch(ctx);
        for (const action of actions) {
          await this._dispatch(ctx, action);
          ctx.completed++;
          if (mode === 'manual' && this._recording) this._appendRecording(this._recording, action, requestAt, this.now());
          this._notify();
        }
        await this._guard(ctx);
        result = { ok: true, status: 'completed', target, runId: ctx.runId, completed: ctx.completed, total: actions.length };
      }
    } catch (error) {
      const cause = ctx.controller.signal.aborted ? abortError(ctx.controller.signal) : error;
      const code = cause instanceof AutomationError ? cause.code : 'DEVICE_ERROR';
      result = { ok: false, status: code === 'CANCELLED' ? 'cancelled' : STOP_CODES.has(code) ? 'stopped' : 'failed',
        code, error: cause instanceof AutomationError ? cause.message : '目标操作失败，已停止；未重试或发送后续动作',
        target, runId: ctx.runId, completed: ctx.completed, total: actions.length };
      if (this._recording) this._endRecording(code);
    } finally {
      ctx.controller.abort(new AutomationError('CANCELLED', '操作已结束'));
      if (watcher) await watcher;
      signal?.removeEventListener('abort', externalAbort);
      this._lastResult = result || { ok: false, status: 'failed', code: 'DEVICE_ERROR' };
      if (this._active === ctx) this._active = null;
      if (activeLease === ctx) activeLease = null;
      ctx.resolveDone();
      this._notify();
    }
    return result;
  }

  async run(payload, { signal } = {}) {
    object(payload, ['script'], undefined, '回放请求');
    const script = validateScript(payload.script);
    return this._execute({ target: script.target, actions: script.actions, mode: 'replay', signal });
  }

  async perform(payload, { signal } = {}) {
    object(payload, ['target', 'action'], undefined, '面板操作请求');
    return this._execute({ target: validateTarget(payload.target), actions: [validateAction(payload.action)], mode: 'manual', signal });
  }

  async recordStart(payload) {
    object(payload, ['target', 'recordText'], ['target'], '录制请求');
    if (Object.hasOwn(payload, 'recordText') && typeof payload.recordText !== 'boolean') fail('recordText 必须是布尔值');
    return this._execute({ target: validateTarget(payload.target), actions: [], mode: 'record-start', recordText: payload.recordText === true });
  }

  _appendRecording(recording, action, startedAt, endedAt) {
    // Excluding text excludes its content/action, not elapsed human idle time.
    if (action.type === 'text' && !recording.recordText) return;
    const actions = recording.actions.slice();
    let gap = Math.max(0, Math.round(startedAt - recording.lastEnd));
    // A long idle gap is represented by bounded waits, never an oversized action.
    while (gap > 0 && actions.length < LIMITS.maxActions) {
      const durationMs = Math.min(gap, LIMITS.maxWaitMs);
      actions.push({ type: 'wait', durationMs });
      gap -= durationMs;
    }
    actions.push(action);
    try {
      const checked = validateScript({ version: 1, target: recording.target, actions });
      recording.actions = checked.actions.slice();
      recording.lastEnd = endedAt;
    } catch (_) { this._endRecording('RECORDING_LIMIT'); }
  }

  async _watchRecording(recording) {
    try {
      while (this._recording === recording) {
        await this.sleep(this.watchIntervalMs, { signal: recording.controller.signal });
        await this._guard(recording);
      }
    } catch (error) {
      if (this._recording === recording) this._endRecording(error instanceof AutomationError ? error.code : 'OFFLINE');
    }
  }

  _endRecording(reason) {
    const recording = this._recording;
    if (!recording) return;
    this._recording = null;
    recording.controller.abort(new AutomationError('CANCELLED', '录制已结束'));
    this._lastRecording = { reason, script: recording.actions.length
      ? validateScript({ version: 1, target: recording.target, actions: recording.actions }) : null };
    this._notify();
  }

  recordStop(payload = {}) {
    object(payload, [], [], '停止录制请求');
    if (this._active && ['manual', 'record-start'].includes(this._active.mode)) throw new AutomationError('BUSY', '请等待当前面板操作结束，或先取消');
    this._endRecording('user');
    return { ok: true, script: this._lastRecording?.script || null, reason: this._lastRecording?.reason || 'empty' };
  }

  cancel(reason = 'cancelled') {
    const codes = { cancelled: 'CANCELLED', 'window-closed': 'TARGET_UNAVAILABLE',
      'target-exited': 'TARGET_UNAVAILABLE', 'runtime-changed': 'TARGET_CHANGED' };
    const code = Object.hasOwn(codes, reason) ? codes[reason] : 'CANCELLED';
    const cancelled = !!this._active || !!this._recording;
    if (this._active) this._active.controller.abort(new AutomationError(code,
      code === 'CANCELLED' ? '操作已取消' : '目标窗口、应用或运行时已变化，已停止'));
    this._endRecording(code);
    this._notify();
    return { ok: true, cancelled, status: this.status().status };
  }

  async dispose() {
    this._disposed = true;
    const done = this._active?.done;
    this.cancel('window-closed');
    if (done) await done;
  }
}

module.exports = { AutomationRunner, AutomationError, validateScript, validateTarget,
  validateAction, abortableSleep, focusedPackage, SCRIPT_SCHEMA, LIMITS, KEYS,
  RECORDING_NOTICE, TEXT_NOTICE };

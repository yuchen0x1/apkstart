'use strict';

/* Standalone renderer component. All input is explicit form submission within
 * this panel. No native-window recording, global key listeners, hooks, files,
 * HTML-string injection, clipboard access, or automatic execution of JSON.
 *
 * mountAutomation({ container, api, getTarget }) returns {ready, destroy,
 * refreshTarget, getScript, element}. getTarget() supplies the main-owned
 * {packageName, serial, instanceId}; it may be async. Do not synthesize session
 * identifiers from imported JSON. The main process must enforce sender roles.
 *
 * api methods take ONE object and return {ok,...} promises:
 * automationValidate({script}) -> {ok:true,script}
 * automationRun({script}), automationPerform({target,action}),
 * automationRecordStart({target,recordText}), automationRecordStop({}),
 * automationCancel({}), automationStatus({}).
 * Optional onAutomationState(callback) returns an unsubscribe function.
 */
(function expose(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) {
    root.mountAutomation = exports.mountAutomation;
    root.ApkAutomation = exports;
    root.apkAutomation = { mount: exports.mountAutomation };
  }
})(typeof window === 'object' ? window : null, function createComponent() {
  const MAX_JSON = 128 * 1024;
  const KEYS = ['BACK', 'ENTER', 'TAB', 'DEL', 'FORWARD_DEL', 'DPAD_UP', 'DPAD_DOWN',
    'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER', 'SPACE', 'ESCAPE', 'MOVE_HOME', 'MOVE_END', 'PAGE_UP', 'PAGE_DOWN'];
  const NOTICE = '仅录制本面板显式发送的操作和间隔。只记录本面板，不录原生窗口/全局键盘，不使用后台 hook。文本默认不记录；这不是全局真实输入录制。';
  const TEXT_NOTICE = '仅支持可打印 ASCII（不含 %），不支持中文、换行或密码录制。请勿输入敏感信息。';

  function sameTarget(a, b) {
    return !!a && !!b && a.packageName === b.packageName && a.serial === b.serial && a.instanceId === b.instanceId;
  }
  function targetCopy(value) {
    if (!value || typeof value.packageName !== 'string' || value.packageName.length > 255
      || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value.packageName)
      || ['serial', 'instanceId'].some(key => typeof value[key] !== 'string' || value[key].length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value[key]))) {
      throw new Error('请先打开并绑定一个前台应用实例');
    }
    return Object.freeze({ packageName: value.packageName, serial: value.serial, instanceId: value.instanceId });
  }
  function checkedResult(value) {
    if (!value || value.ok !== true) throw new Error(value?.error || '自动化操作未成功，已停止');
    return value;
  }

  // Main remains the execution authority. This duplicate boundary is needed
  // only for editing/import and local panel recording when preload exposes the
  // minimal automation.{run,cancel,status,action} bridge.
  function validateLocalScript(raw) {
    const exact = (value, keys) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== keys.length
        || keys.some(key => !Object.hasOwn(value, key)
          || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('JSON 对象含未知字段或缺少必需字段');
    };
    if (typeof raw === 'string') {
      if (raw.length > MAX_JSON) throw new Error('脚本 JSON 过大');
      try { raw = JSON.parse(raw); } catch (_) { throw new Error('脚本不是有效 JSON'); }
    }
    exact(raw, ['version', 'target', 'actions']);
    if (raw.version !== 1) throw new Error('仅支持脚本 version: 1');
    exact(raw.target, ['packageName', 'serial', 'instanceId']);
    const target = targetCopy(raw.target);
    if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 256
      || Reflect.ownKeys(raw.actions).length !== raw.actions.length + 1) throw new Error('动作数量必须为 1..256');
    let duration = 0;
    const actions = [];
    for (const action of raw.actions) {
      const descriptor = action && Object.getOwnPropertyDescriptor(action, 'type');
      const type = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : '';
      const shape = { tap: ['type', 'x', 'y'], swipe: ['type', 'x1', 'y1', 'x2', 'y2', 'durationMs'],
        key: ['type', 'key'], text: ['type', 'text'], wait: ['type', 'durationMs'] };
      if (!Object.hasOwn(shape, type)) throw new Error('仅允许 tap/swipe/key/text/wait');
      exact(action, shape[type]);
      for (const key of shape[type].filter(key => /^[xy][12]?$/.test(key))) {
        if (typeof action[key] !== 'number' || !Number.isFinite(action[key]) || action[key] < 0 || action[key] > 1) throw new Error('坐标必须是 0..1 的有限数字');
      }
      if (type === 'wait' || type === 'swipe') {
        const min = type === 'wait' ? 1 : 50, max = type === 'wait' ? 30000 : 3000;
        if (!Number.isSafeInteger(action.durationMs) || action.durationMs < min || action.durationMs > max) throw new Error('动作时长超出允许范围');
        duration += action.durationMs;
      }
      if (type === 'key' && !KEYS.includes(action.key)) throw new Error('按键不在白名单内');
      if (type === 'text' && (typeof action.text !== 'string' || !action.text.length || action.text.length > 256 || !/^[\x20-\x24\x26-\x7e]+$/.test(action.text))) throw new Error(TEXT_NOTICE);
      actions.push(Object.freeze({ ...action }));
    }
    if (duration > 600000) throw new Error('总等待/滑动时长不能超过 10 分钟');
    const script = { version: 1, target, actions: Object.freeze(actions) };
    if (JSON.stringify(script).length > MAX_JSON) throw new Error('脚本 JSON 过大');
    return Object.freeze(script);
  }

  function minimalBridge(source, getTarget) {
    const bridge = source.automation;
    if (['run', 'cancel', 'status', 'action'].some(key => typeof bridge[key] !== 'function')) throw new TypeError('需要 automation.run/cancel/status/action');
    let recording = null, last = null;
    const clock = () => typeof performance === 'object' ? performance.now() : Date.now();
    function stop(reason) {
      if (!recording) return;
      last = { reason, script: recording.actions.length
        ? validateLocalScript({ version: 1, target: recording.target, actions: recording.actions }) : null };
      recording = null;
    }
    function overlay(state) {
      if (recording && clock() >= recording.deadline) stop('DURATION_LIMIT');
      return { ...state, recording: !!recording, recordedActions: recording?.actions.length || 0,
        recordText: recording?.recordText === true, recordingReason: last?.reason || null };
    }
    const adapted = {
      automationValidate: async ({ script }) => {
        const checked = validateLocalScript(script);
        if (typeof bridge.validate !== 'function') return { ok: true, script: checked };
        const result = checkedResult(await bridge.validate({ script: checked }));
        if (!result.script || !Array.isArray(result.script.actions)) throw new Error('主进程未返回已校验的脚本');
        return result;
      },
      automationRun: payload => {
        if (recording) throw new Error('请先停止面板录制');
        return bridge.run(payload);
      },
      automationPerform: async payload => {
        const startedAt = clock();
        if (recording && !sameTarget(recording.target, payload.target)) throw new Error('录制目标实例已变化');
        let result;
        try { result = await bridge.action(payload); }
        catch (error) { stop('DEVICE_ERROR'); throw error; }
        if (result?.ok !== true) { stop(result?.code || 'DEVICE_ERROR'); return result; }
        if (recording && (payload.action.type !== 'text' || recording.recordText)) {
          const actions = recording.actions.slice();
          let gap = Math.max(0, Math.round(startedAt - recording.lastEnd));
          while (gap > 0 && actions.length < 256) {
            const durationMs = Math.min(30000, gap); actions.push({ type: 'wait', durationMs }); gap -= durationMs;
          }
          actions.push(payload.action);
          try {
            if (clock() >= recording.deadline) throw new Error('limit');
            recording.actions = validateLocalScript({ version: 1, target: recording.target, actions }).actions.slice();
            recording.lastEnd = clock();
          } catch (_) { stop('RECORDING_LIMIT'); }
        }
        return result;
      },
      automationRecordStart: async payload => {
        if (recording) throw new Error('面板已在录制');
        const state = checkedResult(await bridge.status());
        if (state.running) throw new Error('请等待当前自动化操作结束');
        const target = targetCopy(payload.target);
        if (!sameTarget(target, targetCopy(await getTarget()))) throw new Error('录制目标实例已变化');
        recording = { target, recordText: payload.recordText === true, actions: [],
          lastEnd: clock(), deadline: clock() + 600000 };
        last = null;
        return { ok: true, status: 'recording', target };
      },
      automationRecordStop: async () => { stop('user'); return { ok: true, script: last?.script || null, reason: last?.reason || 'empty' }; },
      automationCancel: async () => { stop('CANCELLED'); return bridge.cancel(); },
      automationStatus: async () => {
        const state = checkedResult(await bridge.status());
        if (recording) {
          try { if (!sameTarget(recording.target, targetCopy(await getTarget()))) stop('TARGET_CHANGED'); }
          catch (_) { stop('TARGET_UNAVAILABLE'); }
        }
        return overlay(state);
      },
    };
    const subscribe = typeof source.onAutomationState === 'function' ? source.onAutomationState.bind(source)
      : typeof bridge.onState === 'function' ? bridge.onState.bind(bridge) : null;
    if (subscribe) adapted.onAutomationState = callback => subscribe(state => callback(overlay(state)));
    return adapted;
  }

  function mountAutomation({ container, root: rootContainer, api, getTarget } = {}) {
    container = container || rootContainer;
    if (api?.automation) {
      const bridge = api.automation;
      getTarget = getTarget || (async () => {
        const value = typeof bridge.target === 'function' ? await bridge.target() : await bridge.status();
        return value?.target || null;
      });
      api = minimalBridge(api, getTarget);
    }
    const doc = typeof container === 'object' ? container?.ownerDocument
      : typeof document === 'object' ? document : null;
    if (typeof container === 'string') container = doc?.querySelector(container);
    if (!doc || !container || typeof container.appendChild !== 'function') throw new TypeError('需要有效的 automation 容器');
    const methods = ['automationValidate', 'automationRun', 'automationPerform', 'automationRecordStart',
      'automationRecordStop', 'automationCancel', 'automationStatus'];
    if (!api || methods.some(name => typeof api[name] !== 'function') || typeof getTarget !== 'function') throw new TypeError('自动化 API 与 getTarget 必须显式提供');

    let disposed = false;
    let busy = false;
    let remoteBusy = false;
    let recording = false;
    let recoverRecording = false;
    let boundTarget = null;
    let validatedScript = null;
    let unsubscribe = null;
    let timer = null;
    let polling = false;
    const listeners = [];
    const element = doc.createElement('section');
    element.className = 'automation-panel';
    element.setAttribute('aria-label', '应用内脚本与面板操作录制');
    container.appendChild(element);

    function node(tag, text, parent = element) {
      const value = doc.createElement(tag);
      if (text !== undefined) value.textContent = text;
      parent.appendChild(value);
      return value;
    }
    function tag(value, name) { value.dataset.automation = name; return value; }
    function listen(value, event, callback) {
      value.addEventListener(event, callback);
      listeners.push(() => value.removeEventListener(event, callback));
    }
    function button(text, name, parent = element) {
      const value = tag(node('button', text, parent), name);
      value.type = 'button';
      return value;
    }
    function number(label, name, initial, min, max, step, parent) {
      const wrapper = node('label', undefined, parent);
      node('span', label, wrapper);
      const value = tag(node('input', undefined, wrapper), name);
      Object.assign(value, { type: 'number', min: String(min), max: String(max), step: String(step), value: String(initial), required: true });
      return value;
    }
    function readNumber(input, min, max, integral = false) {
      if (!String(input.value).trim()) throw new Error('请填写全部坐标与时长');
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < min || value > max || (integral && !Number.isSafeInteger(value))) throw new Error(`数值必须在 ${min}..${max} 范围内${integral ? '且为整数' : ''}`);
      return value;
    }

    node('h3', '脚本 / 面板操作录制 / 回放');
    tag(node('p', NOTICE), 'notice');
    node('p', '回放和“发送”会真实操作下方指定的客机前台应用。单次最多 256 个动作、10 分钟；取消不会撤销已经发出的单次手势。');
    const targetLine = tag(node('output', '未绑定应用'), 'target');
    targetLine.setAttribute('aria-live', 'polite');
    const refresh = button('绑定当前应用实例', 'bind');

    const manual = node('fieldset');
    node('legend', '手动发送（只有这里的显式操作可被录制）', manual);
    const tapForm = tag(node('form', undefined, manual), 'tap-form');
    node('h4', '点击 tap', tapForm);
    const tapX = number('X（0..1）', 'tap-x', 0.5, 0, 1, 0.001, tapForm);
    const tapY = number('Y（0..1）', 'tap-y', 0.5, 0, 1, 0.001, tapForm);
    const tapSend = button('发送点击', 'tap-send', tapForm); tapSend.type = 'submit';

    const swipeForm = tag(node('form', undefined, manual), 'swipe-form');
    node('h4', '滑动 swipe', swipeForm);
    const swipeX1 = number('起点 X（0..1）', 'swipe-x1', 0.5, 0, 1, 0.001, swipeForm);
    const swipeY1 = number('起点 Y（0..1）', 'swipe-y1', 0.8, 0, 1, 0.001, swipeForm);
    const swipeX2 = number('终点 X（0..1）', 'swipe-x2', 0.5, 0, 1, 0.001, swipeForm);
    const swipeY2 = number('终点 Y（0..1）', 'swipe-y2', 0.2, 0, 1, 0.001, swipeForm);
    const swipeMs = number('时长（毫秒）', 'swipe-ms', 250, 50, 3000, 1, swipeForm);
    const swipeSend = button('发送滑动', 'swipe-send', swipeForm); swipeSend.type = 'submit';

    const keyForm = tag(node('form', undefined, manual), 'key-form');
    node('h4', '按键 key', keyForm);
    const keyLabel = node('label', undefined, keyForm); node('span', '允许的按键', keyLabel);
    const keyInput = tag(node('select', undefined, keyLabel), 'key');
    for (const name of KEYS) { const option = node('option', name, keyInput); option.value = name; }
    keyInput.value = 'BACK';
    const keySend = button('发送按键', 'key-send', keyForm); keySend.type = 'submit';

    const textForm = tag(node('form', undefined, manual), 'text-form');
    node('h4', '文本 text', textForm);
    node('p', TEXT_NOTICE, textForm);
    const textLabel = node('label', undefined, textForm); node('span', '发送文本（最多 256 字符）', textLabel);
    const textInput = tag(node('input', undefined, textLabel), 'text');
    Object.assign(textInput, { type: 'text', value: '', maxLength: 256, required: true, autocomplete: 'off', spellcheck: false });
    const textSend = button('发送文本', 'text-send', textForm); textSend.type = 'submit';

    const waitForm = tag(node('form', undefined, manual), 'wait-form');
    node('h4', '等待 wait', waitForm);
    const waitMs = number('等待（毫秒）', 'wait-ms', 500, 1, 30000, 1, waitForm);
    const waitSend = button('执行等待', 'wait-send', waitForm); waitSend.type = 'submit';

    const recordControls = node('fieldset');
    node('legend', '仅本面板录制', recordControls);
    const optLabel = node('label', undefined, recordControls);
    const recordText = tag(node('input', undefined, optLabel), 'record-text');
    Object.assign(recordText, { type: 'checkbox', checked: false });
    node('span', '主动允许记录本面板发送的文本（可能含敏感信息，不是密码录制）', optLabel);
    const recordStart = button('开始面板录制', 'record-start', recordControls);
    const recordStop = button('停止 / 取回录制 JSON', 'record-stop', recordControls);
    const recordLine = tag(node('output', '未录制；文本默认不记录'), 'record-state', recordControls);
    recordLine.setAttribute('aria-live', 'polite');

    const editorLabel = node('label'); node('span', '脚本 JSON（仅文本导入/导出，不读写任意路径）', editorLabel);
    const editor = tag(node('textarea', undefined, editorLabel), 'json');
    Object.assign(editor, { value: '', rows: 14, cols: 64, maxLength: MAX_JSON, spellcheck: false });
    editor.setAttribute('aria-label', '脚本 JSON 文本');
    const jsonControls = node('div');
    const importButton = button('校验 / 导入文本', 'import', jsonControls);
    const exportButton = button('导出到文本框', 'export', jsonControls);
    const replay = button('回放此 JSON', 'replay', jsonControls);
    const cancel = button('取消 / 停止操作', 'cancel', jsonControls);
    const statusLine = tag(node('p', '准备就绪；导入 JSON 不会自动执行'), 'status');
    statusLine.setAttribute('role', 'status');
    statusLine.setAttribute('aria-live', 'polite');

    function message(text) { if (!disposed) statusLine.textContent = text; }
    function render() {
      if (disposed) return;
      const locked = busy || remoteBusy;
      manual.disabled = locked || !boundTarget;
      refresh.disabled = locked || recording;
      recordStart.disabled = locked || recording || !boundTarget;
      recordStop.disabled = locked || (!recording && !recoverRecording);
      recordText.disabled = locked || recording;
      replay.disabled = locked || recording || !boundTarget;
      importButton.disabled = locked || recording;
      exportButton.disabled = locked;
      editor.disabled = locked || recording;
      cancel.disabled = !locked && !recording;
      recordLine.textContent = recording
        ? `正在录制本面板操作；文本${recordText.checked ? '已主动允许记录' : '不记录'}`
        : recoverRecording ? '录制已停止，可取回已完成操作的 JSON' : '未录制；文本默认不记录';
    }
    async function call(name, payload) {
      const result = await api[name](payload);
      if (disposed) throw new Error('自动化面板已关闭');
      return checkedResult(result);
    }
    async function transact(work) {
      if (disposed || busy || remoteBusy) return;
      busy = true; render();
      try { await work(); }
      catch (error) { message(error?.message || '自动化操作失败，已停止'); }
      finally { busy = false; render(); }
    }
    async function ensureTarget() {
      const current = targetCopy(await getTarget());
      if (disposed) throw new Error('自动化面板已关闭');
      if (!sameTarget(current, boundTarget)) throw new Error('应用实例已变化；请停止当前操作，再明确绑定当前应用');
      return boundTarget;
    }
    async function refreshTarget() {
      if (disposed) return;
      if (recording || remoteBusy) throw new Error('请先停止录制或回放，再重新绑定');
      const current = targetCopy(await getTarget());
      if (disposed) return;
      boundTarget = current;
      targetLine.textContent = `已绑定：${current.packageName} · ${current.serial} · ${current.instanceId}`;
      render();
    }
    // Opening the panel is not enough to authorize an input target: the first
    // binding is an explicit click, and imported JSON can never re-bind it.
    async function detectTarget() {
      if (disposed) return;
      const current = targetCopy(await getTarget());
      if (disposed) return;
      targetLine.textContent = `检测到：${current.packageName} · ${current.serial} · ${current.instanceId}；点击“绑定当前应用实例”后才会发送操作`;
      render();
    }
    async function validateEditor() {
      if (!editor.value.trim()) throw new Error('请粘贴脚本 JSON 或先完成一次面板录制');
      if (editor.value.length > MAX_JSON) throw new Error('脚本 JSON 过大');
      const result = await call('automationValidate', { script: editor.value });
      if (!result.script || !Array.isArray(result.script.actions)) throw new Error('主进程未返回已校验的脚本');
      validatedScript = result.script;
      return result.script;
    }
    function manualForm(form, buildAction, label, after) {
      listen(form, 'submit', event => {
        event.preventDefault();
        void transact(async () => {
          const action = buildAction();
          const target = await ensureTarget();
          const result = await call('automationPerform', { target, action });
          if (result.status !== 'completed') throw new Error('面板操作未完成，已停止');
          after?.();
          message(`${label}已完成${recording ? '；仅面板操作参与录制' : ''}`);
        });
      });
    }
    manualForm(tapForm, () => ({ type: 'tap', x: readNumber(tapX, 0, 1), y: readNumber(tapY, 0, 1) }), '点击');
    manualForm(swipeForm, () => ({ type: 'swipe', x1: readNumber(swipeX1, 0, 1), y1: readNumber(swipeY1, 0, 1),
      x2: readNumber(swipeX2, 0, 1), y2: readNumber(swipeY2, 0, 1), durationMs: readNumber(swipeMs, 50, 3000, true) }), '滑动');
    manualForm(keyForm, () => {
      if (!KEYS.includes(keyInput.value)) throw new Error('请选择白名单内的按键');
      return { type: 'key', key: keyInput.value };
    }, '按键');
    manualForm(textForm, () => {
      if (!textInput.value || textInput.value.length > 256 || !/^[\x20-\x24\x26-\x7e]+$/.test(textInput.value)) throw new Error(TEXT_NOTICE);
      return { type: 'text', text: textInput.value };
    }, '文本发送', () => { textInput.value = ''; });
    manualForm(waitForm, () => ({ type: 'wait', durationMs: readNumber(waitMs, 1, 30000, true) }), '等待');

    listen(refresh, 'click', () => { void transact(async () => { await refreshTarget(); message('已明确绑定当前应用实例；导入脚本不会自动改绑'); }); });
    listen(recordStart, 'click', () => {
      void transact(async () => {
        const target = await ensureTarget();
        await call('automationRecordStart', { target, recordText: recordText.checked === true });
        recording = true; recoverRecording = true;
        message('开始仅本面板录制；不记录原生应用窗口、全局键盘或后台输入');
      });
    });
    listen(recordStop, 'click', () => {
      void transact(async () => {
        const result = await call('automationRecordStop', {});
        recording = false; recoverRecording = false;
        if (result.script) {
          validatedScript = result.script;
          editor.value = JSON.stringify(result.script, null, 2);
          message(`已取回 ${result.script.actions.length} 个动作的面板录制 JSON；停止原因：${result.reason || 'user'}。不会自动回放。`);
        } else message('录制中没有可导出的已完成动作');
      });
    });
    listen(importButton, 'click', () => {
      void transact(async () => { const script = await validateEditor(); message(`已校验 ${script.actions.length} 个动作；未执行，也未自动改绑应用实例`); });
    });
    listen(exportButton, 'click', () => {
      void transact(async () => { const script = await validateEditor(); editor.value = JSON.stringify(script, null, 2); message('已导出为文本框中的 JSON，可手动复制；未写入文件'); });
    });
    listen(editor, 'input', () => { validatedScript = null; });
    listen(replay, 'click', () => {
      void transact(async () => {
        if (recording) throw new Error('请先停止录制');
        const script = await validateEditor();
        const target = await ensureTarget();
        if (!sameTarget(script.target, target)) throw new Error('JSON 绑定的应用/设备/实例不匹配，拒绝回放；不会自动重绑定');
        message(`正在回放 ${script.actions.length} 个动作；可随时取消`);
        const result = await api.automationRun({ script });
        if (!result?.ok) {
          message(result?.status === 'cancelled' ? '回放已取消；未发送后续动作' : result?.error || '回放已停止');
          return;
        }
        message(`回放已完成：${result.completed}/${result.total} 个动作`);
      });
    });
    listen(cancel, 'click', () => {
      // Deliberately not serialized behind the pending replay/wait invocation.
      if (disposed) return;
      void call('automationCancel', {}).then(() => {
        if (recording) recoverRecording = true;
        recording = false;
        message('已请求停止；不再调度新动作，已发出的单次输入结束前仍持有执行锁');
        render();
      }).catch(error => message(error?.message || '停止请求失败，请关闭目标应用窗口'));
    });

    function acceptState(state) {
      if (disposed || !state || state.ok === false) return;
      remoteBusy = state.running === true;
      if (state.recording === true) {
        recording = true; recoverRecording = true;
        if (typeof state.recordText === 'boolean') recordText.checked = state.recordText;
      } else if (recording) {
        recording = false;
        recoverRecording = true;
        if (state.recordingReason && state.recordingReason !== 'user') message(`面板录制已停止（${state.recordingReason}）；可取回已完成操作的 JSON`);
      }
      if (remoteBusy && state.mode === 'replay') message(`正在回放：${state.completed || 0}/${state.total || 0}；可取消`);
      render();
    }
    async function poll() {
      if (disposed || polling) return;
      polling = true;
      try { acceptState(await call('automationStatus', {})); }
      catch (error) { message(error?.message || '无法读取自动化状态'); }
      finally { polling = false; }
    }
    if (typeof api.onAutomationState === 'function') {
      const remove = api.onAutomationState(acceptState);
      if (typeof remove === 'function') unsubscribe = remove;
    }
    // Poll also when subscribed: local recording deadlines/session changes can
    // happen while the main runner is idle and emits no progress event.
    timer = setInterval(() => { void poll(); }, 1000);

    function destroy() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearInterval(timer);
      unsubscribe?.();
      for (const remove of listeners) remove();
      textInput.value = ''; editor.value = ''; validatedScript = null;
      element.remove();
      // Main must also cancel on BrowserWindow/target/runtime lifecycle events;
      // renderer cleanup alone is never the security or lifecycle boundary.
      void Promise.resolve().then(() => api.automationCancel({})).catch(() => {});
    }
    const ownerWindow = doc.defaultView;
    if (ownerWindow?.addEventListener) listen(ownerWindow, 'pagehide', destroy);
    render();
    const ready = (async () => {
      try { await detectTarget(); }
      catch (error) { message(error?.message || '请先打开并绑定前台应用'); }
      await poll();
    })();
    return { element, ready, destroy, refreshTarget, getScript: () => validatedScript };
  }

  return { mountAutomation, validateScript: validateLocalScript, RECORDING_NOTICE: NOTICE, TEXT_NOTICE };
});

'use strict';
/**
 * 外围设备配置、启动参数和离线诊断。
 *
 * 这里故意只描述「可验证的」能力：
 *   - Android Emulator 的摄像头由官方 -camera-* / -webcam-list 选项提供；
 *   - hw.lcd.vsync 只写入 AVD hardware config，启动后必须用 dumpsys display 读回；
 *   - Android Emulator 没有官方主机 COM 串口直通选项，因此明确拒绝；
 *   - QEMU Android-x86/Bliss 只在 QEMU 后端生成一个 isa-serial，且串口路径严格白名单。
 *
 * 本模块不执行 emulator、qemu、adb 或任何宿主设备探测，便于离线单元测试。
 */

const DEFAULT_SETTINGS = Object.freeze({
  cameraBack: 'none',
  cameraFront: 'none',
  refreshRate: 60,
  serialPort: '',
});

const SUPPORTED_REFRESH_RATES = Object.freeze([30, 60, 90, 120, 144]);
const CAMERA_FIELDS = Object.freeze(['cameraBack', 'cameraFront']);

class PeripheralConfigError extends TypeError {
  constructor(code, message, field = '') {
    super(message);
    this.name = 'PeripheralConfigError';
    this.code = code;
    this.field = field;
  }
}

function fail(code, message, field) {
  throw new PeripheralConfigError(code, message, field);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCamera(value, field) {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value !== 'string') {
    fail('INVALID_CAMERA', `${field} 必须是 none、emulated 或 webcamN`, field);
  }
  const camera = value.trim().toLowerCase();
  if (camera === 'none' || camera === 'emulated') return camera;
  const match = /^webcam(\d+)$/.exec(camera);
  if (match && Number.isSafeInteger(Number(match[1]))) return `webcam${Number(match[1])}`;
  fail('INVALID_CAMERA', `${field} 不是受支持的摄像头标识：${value}`, field);
}

function normalizeRefreshRate(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SETTINGS.refreshRate;
  let rate = value;
  if (typeof rate === 'string') {
    const trimmed = rate.trim();
    if (!/^\d+$/.test(trimmed)) {
      fail('INVALID_REFRESH_RATE', 'refreshRate 必须是 30、60、90、120 或 144', 'refreshRate');
    }
    rate = Number(trimmed);
  }
  if (!Number.isSafeInteger(rate) || !SUPPORTED_REFRESH_RATES.includes(rate)) {
    fail('INVALID_REFRESH_RATE', 'refreshRate 必须是 30、60、90、120 或 144', 'refreshRate');
  }
  return rate;
}

/**
 * 只接受 COMN 或 Linux /dev/tty...，不接受 QEMU property 语法中的逗号、等号等字符。
 * 这样返回值可以作为一个完整 argv 元素传给 child_process.spawn，不经过 shell。
 */
function normalizeSerialPort(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    fail('INVALID_SERIAL_PORT', 'serialPort 必须为空、COMN 或 /dev/tty...', 'serialPort');
  }
  const port = value.trim();
  if (!port) return '';

  const win = /^COM([1-9]\d*)$/i.exec(port);
  if (win) return `COM${Number(win[1])}`;

  // 只允许设备节点本身，拒绝 /dev/tty... 后继续拼接 QEMU 属性的输入。
  if (/^\/dev\/tty[A-Za-z0-9._-]+$/.test(port)) return port;

  fail('INVALID_SERIAL_PORT', 'serialPort 只支持 COMN 或 /dev/tty...，且不允许参数分隔符', 'serialPort');
}

/**
 * 规范化 store.peripherals。缺省值显式关闭两个摄像头，避免未选择时访问主机摄像头。
 * 未知字段被丢弃；已知字段的非法显式值会抛 PeripheralConfigError，调用方不得静默忽略。
 */
function normalizeSettings(value = {}) {
  if (value === undefined || value === null) return { ...DEFAULT_SETTINGS };
  if (!isRecord(value)) fail('INVALID_PERIPHERALS', 'peripherals 必须是对象');
  return {
    cameraBack: normalizeCamera(value.cameraBack, 'cameraBack'),
    cameraFront: normalizeCamera(value.cameraFront, 'cameraFront'),
    refreshRate: normalizeRefreshRate(value.refreshRate),
    serialPort: normalizeSerialPort(value.serialPort),
  };
}

/** 非抛出的校验入口，供设置页/IPC 在提交前显示明确错误。 */
function validateSettings(value = {}) {
  try {
    const settings = normalizeSettings(value);
    return { ok: true, settings, value: settings, errors: [] };
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'INVALID_PERIPHERALS',
      field: error.field || '',
      error: error.message,
      errors: [{ code: error.code || 'INVALID_PERIPHERALS', field: error.field || '', message: error.message }],
    };
  }
}

/**
 * 生成可直接写入 AVD config.ini 的键值。值全部是字符串，避免写入 [object Object]。
 * hw.lcd.vsync 是请求/配置值，不是启动后的真实应用 FPS。
 */
function buildEmulatorConfig(value = {}) {
  const settings = normalizeSettings(value);
  return {
    'hw.camera.back': settings.cameraBack,
    'hw.camera.front': settings.cameraFront,
    'hw.lcd.vsync': String(settings.refreshRate),
  };
}

function buildEmulatorConfigLines(value = {}) {
  return Object.entries(buildEmulatorConfig(value)).map(([key, setting]) => `${key}=${setting}`);
}

function unsupported(backend, feature, detail = '') {
  const suffix = detail ? `：${detail}` : '';
  fail('PERIPHERAL_UNSUPPORTED', `${feature} 在 ${backend} 后端不受支持${suffix}`, feature);
}

/**
 * Android Emulator 官方启动参数。刷新率没有在这里伪造一个未核实的 CLI 参数，
 * 它由 buildEmulatorConfig 写入 hw.lcd.vsync；serialPort 则明确拒绝。
 */
function buildEmulatorArgs(value = {}, options = {}) {
  const settings = normalizeSettings(value);
  const backend = String(options.backend || options.engine || 'android-emulator');
  if (settings.serialPort) {
    unsupported(backend, 'serialPort', 'Android Emulator 官方命令行未提供主机 COM 串口直通');
  }
  // 始终显式传两个 camera 选项；默认 none 不能因 AVD 历史配置而意外打开摄像头。
  return [
    '-camera-back', settings.cameraBack,
    '-camera-front', settings.cameraFront,
  ];
}

/**
 * QEMU Android-x86/Bliss 串口参数。
 *
 * 每个返回项都是独立 argv 元素；路径经过 normalizeSerialPort 白名单后不会注入
 * QEMU 的逗号分隔属性。先关闭机器自动创建的串口，再创建一个显式 isa-serial，
 * 因而单串口配置不会和默认串口并存；空值则完全不添加设备。
 * 摄像头/非默认刷新率在此后端没有本模块已核实的实现，必须报错而不是忽略。
 */
function buildQemuArgs(value = {}, options = {}) {
  const settings = normalizeSettings(value);
  const backend = String(options.backend || 'QEMU Android-x86/Bliss');
  if (settings.cameraBack !== 'none' || settings.cameraFront !== 'none') {
    unsupported(backend, 'camera', '当前 QEMU Android-x86/Bliss 接线未提供可验证的摄像头直通');
  }
  if (settings.refreshRate !== DEFAULT_SETTINGS.refreshRate) {
    unsupported(backend, 'refreshRate', '当前 QEMU Android-x86/Bliss 接线未提供可验证的显示模式设置');
  }
  if (!settings.serialPort) return [];
  const id = String(options.serialId || 'apkstart-serial');
  // id 不是用户配置，但也保持属性安全，避免调用方误传 QEMU 分隔符。
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
    fail('INVALID_SERIAL_ID', 'QEMU 串口 id 含有非法字符', 'serialId');
  }
  return [
    '-serial', 'none',
    '-chardev', `serial,id=${id},path=${settings.serialPort}`,
    '-device', `isa-serial,chardev=${id}`,
  ];
}

function parseQuoted(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/^["']|["']$/g, '');
}

/**
 * 解析官方 `emulator @avd -webcam-list` 输出。
 * 返回数组以便调用方直接 map/filter；附加的 ids/cameras/ok 属性是非枚举的，
 * 同时兼容需要数组和需要结果对象属性的调用方。
 */
function parseWebcamList(output) {
  const text = String(output || '');
  const entries = [];
  const byId = new Map();
  const cameraLine = /Camera\s+(['"])([^'"]+)\1\s+is\s+connected\s+to\s+device\s+(['"])([^'"]*)\3/i;
  const detailLine = /on\s+channel\s+(-?\d+)\s+using\s+pixel\s+format\s+(['"])([^'"]*)\2/i;

  for (const line of text.split(/\r?\n/)) {
    const camera = cameraLine.exec(line);
    if (camera) {
      const id = camera[2].trim();
      if (!/^webcam\d+$/i.test(id)) continue;
      const item = { id: id.toLowerCase(), name: camera[4].trim(), device: camera[4].trim() };
      byId.set(item.id, item);
      entries.push(item);
      continue;
    }
    const detail = detailLine.exec(line);
    if (detail && entries.length) {
      const item = entries[entries.length - 1];
      item.channel = Number(detail[1]);
      item.pixelFormat = detail[3].trim();
    }
  }

  // Some emulator builds print only a compact "webcamN" line. Accept it only when
  // it is clearly an identifier, never arbitrary host text.
  if (!entries.length) {
    for (const line of text.split(/\r?\n/)) {
      const compact = /^\s*(webcam\d+)\s*$/i.exec(line);
      if (!compact) continue;
      const id = compact[1].toLowerCase();
      if (byId.has(id)) continue;
      const item = { id, name: id, device: id };
      byId.set(id, item);
      entries.push(item);
    }
  }

  Object.defineProperties(entries, {
    cameras: { value: entries, enumerable: false },
    ids: { value: entries.map((item) => item.id), enumerable: false },
    ok: { value: true, enumerable: false },
  });
  return entries;
}

function parseModeContent(content) {
  // DisplayDeviceInfo prints `modeId 1`, while Display.Mode prints `id=1`.
  const idMatch = /\bid\s*[=:]\s*(-?\d+)/i.exec(content)
    || /\bmodeId\s*(?:[=:]|\s)\s*(-?\d+)/i.exec(content);
  const widthMatch = /\bwidth\s*[=:]\s*(\d+)/i.exec(content);
  const heightMatch = /\bheight\s*[=:]\s*(\d+)/i.exec(content);
  const refreshMatch = /\b(?:refreshRate|fps)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)/i.exec(content);
  if (!refreshMatch || (!widthMatch && !heightMatch)) return null;
  const refreshRate = Number(refreshMatch[1]);
  if (!Number.isFinite(refreshRate) || refreshRate <= 0 || refreshRate > 1000) return null;
  return {
    id: idMatch ? Number(idMatch[1]) : null,
    width: widthMatch ? Number(widthMatch[1]) : null,
    height: heightMatch ? Number(heightMatch[1]) : null,
    refreshRate,
  };
}

function parseDisplayModes(text) {
  const modes = [];
  const seen = new Set();
  // Mode records in dumpsys display are brace-delimited. Parsing each shallow
  // block avoids treating arbitrary "requested" or "default" values as active.
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const mode = parseModeContent(match[1]);
    if (!mode) continue;
    const key = `${mode.id}|${mode.width}|${mode.height}|${mode.refreshRate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    modes.push(mode);
  }
  return modes;
}

function parseActiveSfMode(text) {
  const marker = /mActiveSfDisplayMode\s*=\s*(?:DisplayMode)?\s*\{([^{}]*)\}/i.exec(text);
  return marker ? parseModeContent(marker[1]) : null;
}

/** Strip physical Display Devices blocks; they describe scanout hardware, not a logical display. */
function withoutDisplayDeviceSections(text) {
  let inDevices = false;
  const kept = [];
  for (const line of text.split(/(?<=\n)/)) {
    if (/^[ \t]*(?:Logical[ \t]+)?Display[ \t]+(?:#[ \t]*)?\d+[ \t]*:[ \t]*$/i.test(line.replace(/[\r\n]+$/, ''))
        || /^[ \t]*Logical Displays[ \t]*:/i.test(line)) inDevices = false;
    if (/^[ \t]*Display Devices[ \t]*:/i.test(line)) { inDevices = true; continue; }
    if (!inDevices) kept.push(line);
  }
  return kept.join('');
}

/** Split Android dumpsys display output into independently attributable displays. */
function splitDisplaySections(text) {
  const lines = text.match(/[^\n]*(?:\n|$)/g).filter((line) => line.length > 0);
  const anchors = [
    { kind: 'header', re: /^[ \t]*(?:Logical[ \t]+)?Display[ \t]+(?:#[ \t]*)?(\d+)[ \t]*:[ \t]*$/i },
    { kind: 'displayId', re: /^[ \t]*mDisplayId[ \t]*=[ \t]*(\d+)\b/i },
  ];
  for (const anchor of anchors) {
    const starts = [];
    let offset = 0;
    for (const rawLine of lines) {
      const match = anchor.re.exec(rawLine.replace(/[\r\n]+$/, ''));
      if (match) starts.push({ offset, id: anchor.kind === 'header' || anchor.kind === 'displayId' ? Number(match[1]) : null });
      offset += rawLine.length;
    }
    if (!starts.length) continue;
    const sections = starts.map((start, i) => ({
      id: start.id,
      text: text.slice(start.offset, i + 1 < starts.length ? starts[i + 1].offset : text.length),
    }));
    return { sections, prefix: text.slice(0, starts[0].offset) };
  }
  return { sections: [], prefix: text };
}

function displayIds(section, headingId = null) {
  const ids = new Set();
  if (headingId !== null) ids.add(headingId);
  for (const match of section.matchAll(/\bmDisplayId\s*=\s*(\d+)\b/gi)) ids.add(Number(match[1]));
  // DisplayInfo uses `displayId 0`, while some dumps print `displayId=0`.
  for (const match of section.matchAll(/\bdisplayId(?:\s*=\s*|\s*:\s*|\s+)(\d+)\b/gi)) ids.add(Number(match[1]));
  return [...ids];
}

function hasDisplayModeEvidence(text) {
  return /\bmSupportedModes\s*=|\bmActiveModeId\s*=|\bactiveModeId\s*[=:]|\bmActiveSfDisplayMode\s*=|\bmodeId\s*(?:[=:]\s*|\s+)\d+/i.test(text)
    || parseDisplayModes(text).length > 0;
}

/**
 * When the caller names a display, never use modes from another display. Older
 * single-display dumps without identity fields remain usable for the default id 0;
 * if multiple devices or an unidentifiable mode block are present, fail closed.
 */
function scopedDisplayText(text, displayId) {
  if (!Number.isInteger(displayId) || displayId < 0) return { text: '', ambiguous: true };
  // Explicit physical-device records are not logical displays; ignore only this
  // clearly delimited block. Unknown prefix evidence remains a hard ambiguity.
  const logicalText = withoutDisplayDeviceSections(text);
  const { sections, prefix } = splitDisplaySections(logicalText);
  if (!sections.length) {
    // Legacy/single-display dumps often contain only mActiveModeId and mSupportedModes.
    // They can safely describe the default logical display only when no display
    // identity (and therefore no evidence of multiple displays) is present.
    if (displayId === 0 && !/\bmDisplayId\s*=|\bdisplayId(?:\s*=\s*|\s*:\s*|\s+)\d+|^[ \t]*(?:Logical[ \t]+)?Display[ \t]+(?:#[ \t]*)?\d+[ \t]*:/im.test(logicalText)) {
      return { text: logicalText, ambiguous: false };
    }
    return { text: '', ambiguous: hasDisplayModeEvidence(logicalText) };
  }
  if (hasDisplayModeEvidence(prefix)) return { text: '', ambiguous: true };
  const candidates = [];
  for (const section of sections) {
    if (!hasDisplayModeEvidence(section.text)) continue;
    const ids = displayIds(section.text, section.id);
    if (ids.length !== 1) return { text: '', ambiguous: true };
    if (ids[0] === displayId) candidates.push(section.text);
  }
  if (candidates.length !== 1) return { text: '', ambiguous: true };
  return { text: candidates[0], ambiguous: false };
}

function parseDisplayRefresh(output, options = {}) {
  const text = String(output || '');
  const requestedRaw = options.requestedRate;
  let requestedRate = null;
  let requestedError = '';
  if (requestedRaw !== undefined && requestedRaw !== null && requestedRaw !== '') {
    try { requestedRate = normalizeRefreshRate(requestedRaw); }
    catch (error) { requestedError = error.message; }
  }

  const hasRequestedDisplay = options.displayId !== undefined;
  const displayId = hasRequestedDisplay ? Number(options.displayId) : null;
  const scoped = hasRequestedDisplay
    ? scopedDisplayText(text, displayId)
    : { text, ambiguous: false };
  const evidence = scoped.text;
  const modes = scoped.ambiguous ? [] : parseDisplayModes(evidence);
  const selectorIds = [...new Set([
    ...evidence.matchAll(/\bmActiveModeId\s*[=:]\s*(-?\d+)/gi),
    ...evidence.matchAll(/\bactiveModeId\s*[=:]\s*(-?\d+)/gi),
  ].map((match) => Number(match[1])))];
  // DisplayInfo can repeat the same active mode in base and override records. Keep
  // identical readings, but do not let them hide a conflicting active mode ID.
  const genericIds = [...new Set(
    [...evidence.matchAll(/\bmodeId\s*(?:[:=]|\s)\s*(-?\d+)/gi)].map((match) => Number(match[1])),
  )];
  const activeModeId = selectorIds.length ? selectorIds[0] : genericIds.length === 1 ? genericIds[0] : null;
  let ambiguous = scoped.ambiguous || selectorIds.length > 1 || genericIds.length > 1
    || (selectorIds.length > 0 && genericIds.some((id) => !selectorIds.includes(id)));
  let activeMode = null;
  if (!ambiguous && activeModeId !== null) {
    const matches = modes.filter((mode) => mode.id === activeModeId);
    if (matches.length === 1) activeMode = matches[0];
    else if (matches.length > 1) ambiguous = true;
  }

  // DisplayDeviceInfo's active mode can be exposed without mActiveModeId. This
  // marker is explicit and therefore safe; do not fall back to the first supported mode.
  if (!ambiguous && !activeMode) activeMode = parseActiveSfMode(evidence);

  // A DisplayInfo block can carry the selected mode id and refreshRate in the same
  // record. Only use a block explicitly marked modeId, never a supported-mode list.
  if (!ambiguous && !activeMode) {
    const candidates = [];
    for (const match of evidence.matchAll(/\{([^{}]*\bmodeId\s*(?:[=:]|\s)\s*-?\d+[^{}]*)\}/gi)) {
      const candidate = parseModeContent(match[1]);
      if (candidate) candidates.push(candidate);
    }
    if (candidates.length === 1) activeMode = candidates[0];
    else if (candidates.length > 1) ambiguous = true;
  }

  const activeRate = !ambiguous && activeMode && Number.isFinite(activeMode.refreshRate)
    ? activeMode.refreshRate : null;
  let status = 'unconfirmed';
  if (activeRate !== null) {
    status = requestedRate === null || Math.abs(activeRate - requestedRate) < 0.01
      ? 'confirmed' : 'mismatch';
  }
  const result = {
    ok: status === 'confirmed',
    status,
    requestedRate,
    activeModeId: ambiguous ? null : (activeModeId ?? (activeMode && activeMode.id !== null ? activeMode.id : null)),
    activeRate,
    refreshRate: activeRate,
    modes,
    displayId: Number.isInteger(displayId) ? displayId : null,
  };
  if (requestedError) result.requestedError = requestedError;
  return result;
}

/**
 * 汇总配置、摄像头枚举和显示读回结果；所有现场能力均为可选的纯文本输入。
 */
function diagnose(value = {}, options = {}) {
  const checked = validateSettings(value);
  if (!checked.ok) return checked;
  const settings = checked.settings;
  const backend = String(options.backend || 'android-emulator');
  const result = { ok: true, settings, backend, errors: [], warnings: [] };
  try {
    result.args = backend === 'qemu'
      ? buildQemuArgs(settings, options)
      : buildEmulatorArgs(settings, options);
    result.config = buildEmulatorConfig(settings);
  } catch (error) {
    result.ok = false;
    result.errors.push({ code: error.code || 'PERIPHERAL_ERROR', field: error.field || '', message: error.message });
  }
  if (options.webcamList !== undefined) {
    result.webcams = parseWebcamList(options.webcamList);
    for (const field of CAMERA_FIELDS) {
      const camera = settings[field];
      if (/^webcam\d+$/.test(camera) && !result.webcams.ids.includes(camera)) {
        result.ok = false;
        result.errors.push({ code: 'WEBCAM_NOT_FOUND', field, message: `${field} 指定的 ${camera} 不在 emulator -webcam-list 中` });
      }
    }
  }
  if (options.displayDump !== undefined) {
    result.display = parseDisplayRefresh(options.displayDump, {
      requestedRate: settings.refreshRate,
      displayId: options.displayId,
    });
    if (result.display.status !== 'confirmed') {
      result.ok = false;
      result.errors.push({
        code: result.display.status === 'mismatch' ? 'REFRESH_RATE_MISMATCH' : 'REFRESH_RATE_UNCONFIRMED',
        field: 'refreshRate',
        message: result.display.status === 'mismatch'
          ? `实际 active refreshRate=${result.display.activeRate}，请求值=${settings.refreshRate}`
          : '无法从 dumpsys display 确认 active refreshRate',
      });
    }
  }
  return result;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_PERIPHERALS: DEFAULT_SETTINGS,
  SUPPORTED_REFRESH_RATES,
  PeripheralConfigError,
  normalizeSettings,
  normalizePeripherals: normalizeSettings,
  validateSettings,
  buildEmulatorConfig,
  buildHardwareConfig: buildEmulatorConfig,
  buildEmulatorConfigLines,
  buildEmulatorArgs,
  buildAndroidEmulatorArgs: buildEmulatorArgs,
  buildQemuArgs,
  parseWebcamList,
  parseDisplayRefresh,
  diagnose,
};

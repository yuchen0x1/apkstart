'use strict';
/** 西班牙语、越南语、俄语语言包的离线回归；不启动 Electron、主进程或模拟器。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'src', 'i18n');
const i18n = require(path.join(I18N_DIR, 'index.js'));
const N = '\u0001';
const CJK = /[\u4e00-\u9fa5]/;
const LANGS = ['es-ES', 'vi-VN', 'ru-RU'];
const EXPECTED = {
  'es-ES': { quit: 'Salir', step: 'Paso 2 de 5', language: 'Idioma de la interfaz' },
  'vi-VN': { quit: 'Thoát', step: 'Bước 2 / 5', language: 'Ngôn ngữ giao diện' },
  'ru-RU': { quit: 'Выход', step: 'Шаг 2 из 5', language: 'Язык интерфейса' },
};
const source = JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'en-US.json'), 'utf8'));
const countSlots = (s) => (String(s).match(new RegExp(N, 'g')) || []).length;
const AUTOMATION_DYNAMIC_KEYS = [
  `数值必须在 ${N}..${N} 范围内`,
  `数值必须在 ${N}..${N} 范围内且为整数`,
  `已绑定：${N} · ${N} · ${N}`,
  `检测到：${N} · ${N} · ${N}；点击“绑定当前应用实例”后才会发送操作`,
  `正在录制本面板操作；文本${N}`,
  '点击已完成', '滑动已完成', '按键已完成', '文本发送已完成', '等待已完成',
  '点击已完成；仅面板操作参与录制', '滑动已完成；仅面板操作参与录制',
  '按键已完成；仅面板操作参与录制', '文本发送已完成；仅面板操作参与录制',
  '等待已完成；仅面板操作参与录制',
  `已取回 ${N} 个动作的面板录制 JSON；停止原因：${N}。不会自动回放。`,
  `已校验 ${N} 个动作；未执行，也未自动改绑应用实例`,
  `正在回放 ${N} 个动作；可随时取消`,
  `回放已完成：${N}/${N} 个动作`,
  `面板录制已停止（${N}）；可取回已完成操作的 JSON`,
  `正在回放：${N}/${N}；可取消`,
];

function collectAutomationChineseLiterals(text) {
  const found = new Map();
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const quote = text[i];
    if (quote === "'" || quote === '"') {
      let end = i + 1;
      while (end < text.length) {
        if (text.charCodeAt(end) === 92) { end += 2; continue; }
        if (text[end] === quote) break;
        end += 1;
      }
      const value = text.slice(i + 1, end);
      if (CJK.test(value)) found.set(i18n.normalizeKey(value), value);
      i = end + 1;
      continue;
    }
    i += 1;
  }
  // These fragments are used only as branches inside dynamic template expressions.
  found.delete('且为整数');
  found.delete('；仅面板操作参与录制');
  return found;
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { failures.push(`${name}: ${e.message}`); }
}
function withSettings(language, fn) {
  const storePath = require.resolve(path.join(ROOT, 'src', 'core', 'store.js'));
  const previous = require.cache[storePath];
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: { getSettings: () => ({ language }) },
  };
  try { return fn(); } finally {
    if (previous) require.cache[storePath] = previous;
    else delete require.cache[storePath];
  }
}

test('三种语言包均可解析，key 是英文源词典的子集', () => {
  for (const lang of LANGS) {
    const raw = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8'));
    assert(Object.keys(raw).length >= 200, `${lang} 条目少于核心下限`);
    for (const [key, value] of Object.entries(raw)) {
      assert(Object.prototype.hasOwnProperty.call(source, key), `${lang} 存在未知源 key: ${key}`);
      assert(String(value).trim(), `${lang} 存在空译文: ${key}`);
      assert(!CJK.test(value), `${lang} 译文含中文: ${key}`);
      assert.strictEqual(countSlots(key), countSlots(value), `${lang} 占位符不一致: ${key}`);
    }
  }
});

test('覆盖率按源词典真实统计，不把英文合并回落计入本地译文', () => {
  const total = Object.keys(source).length;
  const report = [];
  for (const lang of LANGS) {
    const local = i18n.loadDict(lang);
    const covered = Object.keys(local).filter((key) => Object.prototype.hasOwnProperty.call(source, key)).length;
    assert.strictEqual(covered, Object.keys(local).length, `${lang} loadDict 混入了源外 key`);
    assert(covered >= 200, `${lang} 只有 ${covered} 条本地译文`);
    report.push(`${lang}=${covered}/${total} (${(covered * 100 / total).toFixed(1)}%)`);
  }
  console.log(`本地语言覆盖率：${report.join(', ')}`);
});

test('明确切换到三语时命中真实译文并保留占位符值', () => {
  for (const lang of LANGS) {
    i18n.setLanguage(lang);
    assert.strictEqual(i18n.getLanguage(), lang);
    assert.strictEqual(i18n.t('退出'), EXPECTED[lang].quit, `${lang} 退出`);
    assert.strictEqual(i18n.t('第 2 步 / 共 5 步'), EXPECTED[lang].step, `${lang} 占位符`);
    assert.strictEqual(i18n.t('界面语言'), EXPECTED[lang].language, `${lang} 界面语言`);
  }
  i18n.setLanguage('zh-CN');
});

test('本地语言缺译文时回落英文，英文也缺失时回落中文源文', () => {
  const unknown = '一条专门用于回落测试的文案 987654';
  for (const lang of LANGS) {
    i18n.setLanguage(lang);
    assert.strictEqual(i18n.t('诊断报告已导出'), 'The diagnostic report has been exported', `${lang} 英文回落`);
    assert.strictEqual(i18n.t(unknown), unknown, `${lang} 中文最终回落`);
  }
  i18n.setLanguage('zh-CN');
});

test('auto 识别西/越/俄语言及区域变体', () => {
  const cases = [
    ['es', 'es-ES'], ['es-MX', 'es-ES'], ['es-419', 'es-ES'],
    ['vi', 'vi-VN'], ['vi-VN', 'vi-VN'], ['vi_VN', 'vi-VN'],
    ['ru', 'ru-RU'], ['ru-KZ', 'ru-RU'], ['ru-RU', 'ru-RU'],
  ];
  for (const [locale, expected] of cases) assert.strictEqual(i18n.resolve('auto', locale), expected, locale);
  assert.strictEqual(i18n.resolve('auto', ['fr-FR', 'ru-RU']), 'ru-RU');
  assert.strictEqual(i18n.resolve('auto', 'fr-FR'), 'en-US');
});

test('payload 为每种支持语言提供可用词典和英文回落', () => {
  for (const lang of ['zh-CN', 'en-US', ...LANGS]) {
    const payload = withSettings(lang, () => i18n.payload('en-US'));
    assert.strictEqual(payload.lang, lang);
    assert(Array.isArray(payload.languages));
    if (lang === 'zh-CN') assert.strictEqual(Object.keys(payload.dict).length, 0);
    else {
      assert.strictEqual(payload.dict['退出'], EXPECTED[lang]?.quit || 'Quit');
      assert.strictEqual(payload.dict['诊断报告已导出'], 'The diagnostic report has been exported');
      assert(Object.keys(payload.dict).length >= Object.keys(source).length);
    }
  }
});

test('automation.js 的所有中文字符串及完整动态模板均有四语词典项', () => {
  const component = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'automation.js'), 'utf8');
  const staticEntries = collectAutomationChineseLiterals(component);
  const allKeys = [...new Set([...staticEntries.keys(), ...AUTOMATION_DYNAMIC_KEYS])];
  for (const key of allKeys) {
    assert(Object.prototype.hasOwnProperty.call(source, key), `英文缺自动化 key: ${JSON.stringify(key)}`);
    for (const lang of LANGS) {
      const local = i18n.loadDict(lang);
      assert(Object.prototype.hasOwnProperty.call(local, key), `${lang} 缺自动化 key: ${JSON.stringify(key)}`);
      assert(!CJK.test(local[key]), `${lang} 自动化译文含中文: ${JSON.stringify(key)}`);
      assert.strictEqual(countSlots(key), countSlots(local[key]), `${lang} 自动化模板占位符不一致: ${JSON.stringify(key)}`);
    }
  }
  console.log(`自动化面板静态词条 ${staticEntries.size} 条，含动态模板共 ${allKeys.length} 条，四语完整覆盖`);
});

test('automation 面板实际静态文案、动态状态句与模板在 renderer 中均可翻译', () => {
  const rendererSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'i18n.js'), 'utf8');
  function makeRenderer(lang) {
    const rootAttrs = new Map();
    const window = {};
    const document = {
      title: '', body: null,
      documentElement: {
        setAttribute: (name, value) => rootAttrs.set(name, value),
        getAttribute: (name) => rootAttrs.get(name) || null,
        classList: { remove() {} },
      },
    };
    vm.runInNewContext(rendererSource, {
      window, document, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
      MutationObserver: class { observe() {} disconnect() {} },
    });
    window.apkI18n.apply({ lang, dict: { ...source, ...i18n.loadDict(lang) } });
    return window.apkI18n;
  }
  const component = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'automation.js'), 'utf8');
  const staticEntries = collectAutomationChineseLiterals(component);
  for (const lang of LANGS) {
    const api = makeRenderer(lang);
    for (const [, original] of staticEntries) {
      const translated = api.translateOne(original);
      assert(!CJK.test(translated), `${lang} renderer 保留静态中文: ${original} -> ${translated}`);
      assert.notStrictEqual(translated, original, `${lang} renderer 未翻译静态文案: ${original}`);
    }
    const cases = [
      ['已绑定：com.example.reader · emulator-5554 · instance-1',
        { 'es-ES': 'Vinculada: com.example.reader · emulator-5554 · instance-1',
          'vi-VN': 'Đã liên kết: com.example.reader · emulator-5554 · instance-1',
          'ru-RU': 'Привязано: com.example.reader · emulator-5554 · instance-1' }],
      ['检测到：com.example.reader · emulator-5554 · instance-1；点击“绑定当前应用实例”后才会发送操作',
        { 'es-ES': 'Detectada: com.example.reader · emulator-5554 · instance-1. Haz clic en «Vincular la instancia actual de la aplicación» para enviar acciones',
          'vi-VN': 'Đã phát hiện: com.example.reader · emulator-5554 · instance-1. Nhấp “Liên kết phiên bản ứng dụng hiện tại” để gửi thao tác',
          'ru-RU': 'Обнаружено: com.example.reader · emulator-5554 · instance-1. Нажмите «Привязать текущий экземпляр приложения», чтобы отправлять действия' }],
      ['正在录制本面板操作；文本已主动允许记录',
        { 'es-ES': 'Grabando acciones del panel; estado del texto: autorizado explícitamente para grabarse',
          'vi-VN': 'Đang ghi thao tác trên bảng này; văn bản được chủ động cho phép ghi',
          'ru-RU': 'Записываются действия панели; текст явно разрешён к записи' }],
      ['正在录制本面板操作；文本不记录',
        { 'es-ES': 'Grabando acciones del panel; estado del texto: no se registra',
          'vi-VN': 'Đang ghi thao tác trên bảng này; văn bản không được ghi',
          'ru-RU': 'Записываются действия панели; текст не записывается' }],
      ['数值必须在 0..1 范围内且为整数',
        { 'es-ES': 'El valor debe ser un entero entre 0 y 1',
          'vi-VN': 'Giá trị phải là số nguyên trong khoảng 0..1',
          'ru-RU': 'Значение должно быть целым числом в диапазоне 0..1' }],
      ['点击已完成；仅面板操作参与录制',
        { 'es-ES': 'Toque completado; solo se graban las acciones del panel',
          'vi-VN': 'Đã chạm xong; chỉ ghi thao tác trên bảng',
          'ru-RU': 'Нажатие выполнено; записываются только действия панели' }],
      ['已取回 3 个动作的面板录制 JSON；停止原因：DEVICE_ERROR。不会自动回放。',
        { 'es-ES': 'Se ha recuperado el JSON de la grabación del panel con 3 acciones; motivo de detención: DEVICE_ERROR. No se reproducirá automáticamente.',
          'vi-VN': 'Đã lấy JSON bản ghi trên bảng gồm 3 thao tác; lý do dừng: DEVICE_ERROR. Sẽ không tự động phát lại.',
          'ru-RU': 'Получен JSON записи панели с действиями: 3; причина остановки: DEVICE_ERROR. Автоматическое воспроизведение не выполняется.' }],
      ['回放已完成：2/3 个动作',
        { 'es-ES': 'Reproducción completada: 2/3 acciones',
          'vi-VN': 'Đã phát lại xong: 2/3 thao tác',
          'ru-RU': 'Воспроизведение завершено: 2 из 3 действий' }],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(api.translateOne(input), expected[lang], `${lang} 模板翻译：${input}`);
    }
  }
});

test('新增进程状态文案在四种界面语言中有准确词条', () => {
  const status = '进程归属或启动状态未确认；请先手动核验，不会重复启动或终止该进程';
  assert.strictEqual(source['需手动核验'], 'Manual verification required');
  assert.strictEqual(source['启动中'], 'Starting');
  for (const lang of LANGS) {
    const dict = i18n.loadDict(lang);
    for (const key of ['需手动核验', '启动中', status]) {
      assert(dict[key], `${lang} 缺状态文案 ${key}`);
      assert(!CJK.test(dict[key]), `${lang} 状态译文含中文`);
    }
  }
});

i18n.setLanguage('zh-CN');
if (failures.length) {
  console.log(`\n语言包测试：${passed} 通过，${failures.length} 失败`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`语言包测试：${passed} 项全部通过`);

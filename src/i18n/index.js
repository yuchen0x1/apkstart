'use strict';
/**
 * 国际化（upstream issue #38）。
 *
 * 设计取舍：**中文是源语言，词典的 key 就是中文原文**。
 *   - 好处一：代码里不用先给几百条文案编 key（`settings.engine.title` 这种），
 *     也就不会出现「key 还在、文案已改，翻译悄悄失效」；
 *   - 新增文案先补英文；其它语言未翻译的条目回落英文，英文也缺失才保留中文原文，
 *     不显示空白或 `__MISSING__`。各语言 JSON 只收录真实译文，不复制英文凑覆盖率。
 *   - 代价：改中文原文等于改 key，对应译文会失配（见 test/i18n-test.js）。
 *
 * 占位符统一用 U+0001：
 *   - 模板里的 `{name}` 与**字面数字**都会先归一成占位符再去查词典，
 *     所以 `共 {n} 个应用` 与运行时的 `共 3 个应用` 命中同一条；
 *   - 英文值里按同样顺序放占位符，回填时依次取实际值 —— 数字、版本号、路径都能还原。
 *   - 用 U+0001 而不是 `%s`/`{}`：正常文案里不可能出现，省掉转义。
 */

const fs = require('fs');
const path = require('path');

const N = '\u0001';
/** 可选项：auto 跟随系统；其余是明确指定（供设置校验和 renderer 共用） */
const LANGUAGES = [
  { id: 'auto', label: '跟随系统' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
  { id: 'es-ES', label: 'Español' },
  { id: 'vi-VN', label: 'Tiếng Việt' },
  { id: 'ru-RU', label: 'Русский' },
];
const IDS = LANGUAGES.map((l) => l.id);
const SYSTEM_LANGUAGES = { zh: 'zh-CN', en: 'en-US', es: 'es-ES', vi: 'vi-VN', ru: 'ru-RU' };
const dictionaries = new Map();
const EMPTY = Object.freeze({});

let current = 'zh-CN';

const countSlots = (s) => String(s).split(N).length - 1;

/** 返回该语言的原始译文（不混入英文，便于准确统计覆盖率）。 */
function loadDict(lang = 'en-US') {
  if (!IDS.includes(lang) || lang === 'auto' || lang === 'zh-CN') return EMPTY;
  if (dictionaries.has(lang)) return dictionaries.get(lang);
  let dict = EMPTY;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, `${lang}.json`), 'utf8'));
    // 坏条目不能吞掉变量；忽略后按英文 → 中文的正常回落链处理。
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      dict = Object.freeze(Object.fromEntries(Object.entries(raw).filter(([key, value]) => (
        typeof value === 'string' && value.trim() && countSlots(key) === countSlots(value)
      ))));
    }
  } catch (_) { /* 缺失或损坏的语言包回落英文，不影响界面启动。 */ }
  dictionaries.set(lang, dict);
  return dict;
}

/** 把一段中文（含可选参数）归一成词典 key：`{name}` 与数字都变占位符 */
function normalizeKey(template) {
  return String(template)
    .replace(/\{(\w+)\}/g, N)
    .replace(/\d+(?:[.,]\d+)?/g, N)
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按顺序收集模板里的「实际值」，用于回填英文里的占位符 */
function collectValues(template, params) {
  const out = [];
  const s = String(template);
  const re = /\{(\w+)\}|(\d+(?:[.,]\d+)?)/g;
  let m = re.exec(s);
  while (m) {
    if (m[1] !== undefined) out.push(params && params[m[1]] !== undefined ? params[m[1]] : '');
    else out.push(m[2]);
    m = re.exec(s);
  }
  return out;
}

function fillZh(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (all, name) => (
    params && params[name] !== undefined ? String(params[name]) : all
  ));
}

function fillEn(value, values) {
  let i = 0;
  return String(value).replace(new RegExp(N, 'g'), () => {
    const v = values[i];
    i += 1;
    return v === undefined ? '' : String(v);
  });
}

/** 按系统语言/设置解析出真正生效的语言 */
function resolve(pref, systemLocale) {
  const want = IDS.includes(pref) ? pref : 'auto';
  if (want !== 'auto') return want;
  const locales = Array.isArray(systemLocale) ? systemLocale : [systemLocale];
  let sawLocale = false;
  for (const value of locales) {
    const loc = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (!loc) continue;
    sawLocale = true;
    const primary = loc.split('-')[0];
    if (SYSTEM_LANGUAGES[primary]) return SYSTEM_LANGUAGES[primary];
  }
  return sawLocale ? 'en-US' : 'zh-CN';
}

function setLanguage(lang) {
  current = IDS.includes(lang) && lang !== 'auto' ? lang : 'zh-CN';
  return current;
}

function getLanguage() { return current; }

/** 中文是 key；没有真实本地化译文时以英文兜底，最终保留可读的中文原文。 */
function t(template, params) {
  const zh = fillZh(template, params);
  if (current === 'zh-CN') return zh;
  const key = normalizeKey(template);
  const source = String(template).trim();
  const values = collectValues(template, params);
  const local = loadDict(current)[key] || loadDict(current)[source];
  if (local) return fillEn(local, values);
  const english = loadDict('en-US')[key] || loadDict('en-US')[source];
  return english ? fillEn(english, values) : zh;
}

/** 每种翻译界面都携带真实译文和英文回落，供 renderer 一次遍历 DOM。 */
function payload(systemLocale) {
  const lang = resolve((require('../core/store').getSettings().language || 'auto'), systemLocale);
  const dict = lang === 'zh-CN' ? EMPTY : { ...loadDict('en-US'), ...loadDict(lang) };
  return { lang, dict, languages: LANGUAGES };
}

module.exports = {
  N, LANGUAGES, IDS, normalizeKey, collectValues, resolve, setLanguage, getLanguage, t, payload, loadDict,
};

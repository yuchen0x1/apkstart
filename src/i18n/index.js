'use strict';
/**
 * 国际化（upstream issue #38）。
 *
 * 设计取舍：**中文是源语言，词典的 key 就是中文原文**。
 *   - 好处一：代码里不用先给几百条文案编 key（`settings.engine.title` 这种），
 *     也就不会出现「key 还在、文案已改，翻译悄悄失效」；
 *   - 好处二：新增文案忘了翻译时，界面显示中文原文而不是 `__MISSING__`，
 *     用户仍然能用 —— 这是「优雅降级」而不是「坏掉」。
 *   - 代价：改中文原文等于改 key，英文那条会失配（测试会报覆盖率下降，见 test/i18n-test.js）。
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
const DICT_FILE = path.join(__dirname, 'en-US.json');

/** 可选项：auto 跟随系统；其余是明确指定 */
const LANGUAGES = [
  { id: 'auto', label: '跟随系统' },
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
];
const IDS = LANGUAGES.map((l) => l.id);

let dict = null;
let current = 'zh-CN';

function loadDict() {
  if (dict) return dict;
  try {
    dict = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
  } catch (_) {
    dict = {};
  }
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
  const loc = String(systemLocale || '').toLowerCase();
  return loc.startsWith('zh') || !loc ? 'zh-CN' : 'en-US';
}

function setLanguage(lang) {
  current = lang === 'en-US' ? 'en-US' : 'zh-CN';
  return current;
}

function getLanguage() { return current; }

/**
 * 翻译一条文案。中文环境原样返回（只填参数）。
 * 词典里没有对应条目时同样返回中文原文 —— 宁可显示中文，也不要显示空串或 key。
 */
function t(template, params) {
  const zh = fillZh(template, params);
  if (current === 'zh-CN') return zh;
  const d = loadDict();
  const key = normalizeKey(template);
  const en = d[key] || d[template] || d[String(template).trim()];
  if (!en) return zh;
  return fillEn(en, collectValues(template, params));
}

/** 给渲染进程用：语言 + 词典（渲染层自己遍历 DOM，不需要每条文案过一次 IPC） */
function payload(systemLocale) {
  const lang = resolve((require('./../core/store').getSettings().language || 'auto'), systemLocale);
  return { lang, dict: lang === 'en-US' ? loadDict() : {}, languages: LANGUAGES };
}

module.exports = {
  N, LANGUAGES, IDS, normalizeKey, collectValues, resolve, setLanguage, getLanguage, t, payload, loadDict,
};

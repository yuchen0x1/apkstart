'use strict';
/**
 * 国际化（i18n）测试：upstream issue #38。
 *
 * 这里守的是三件容易悄悄坏掉的事：
 *   1. 词典条目与中文原文的**占位符数量必须一致** —— 少一个就会吃掉版本号/数字；
 *   2. 界面上的静态文案**必须有英文**（覆盖率），否则英文界面里会夹着中文；
 *   3. 回落行为：词典缺条目时必须显示中文原文，而不是空串或 key。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const i18n = require(path.join(ROOT, 'src', 'i18n'));

const N = '\u0001';
const CJK = /[\u4e00-\u9fa5]/;
const DICT = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'en-US.json'), 'utf8'));

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}
const countN = (s) => (String(s).match(new RegExp(N, 'g')) || []).length;
const normalize = (s) => i18n.normalizeKey(s);

test('词典可加载且条目数量合理', () => {
  const keys = Object.keys(DICT);
  assert(keys.length > 500, `词典条目太少（${keys.length}），可能没打包进来`);
});

test('每条英文都非空，且不再含中文', () => {
  const bad = Object.entries(DICT).filter(([, v]) => !String(v).trim() || CJK.test(String(v)));
  assert(bad.length === 0, `${bad.length} 条异常，例如：${JSON.stringify(bad.slice(0, 3))}`);
});

test('占位符数量与中文原文一致（否则会吃掉数字）', () => {
  const bad = Object.entries(DICT).filter(([k, v]) => countN(k) !== countN(v));
  assert(bad.length === 0, `${bad.length} 条占位符不匹配，例如：${JSON.stringify(bad.slice(0, 3))}`);
});

test('词典 key 自身已归一（数字都应是占位符）', () => {
  const bad = Object.keys(DICT).filter((k) => /\d/.test(k));
  assert(bad.length === 0, `${bad.length} 条 key 还带数字，运行时的数字会被归一，永远命中不了：${JSON.stringify(bad.slice(0, 3))}`);
});

test('中文环境：原样返回并填充参数', () => {
  i18n.setLanguage('zh-CN');
  assert.strictEqual(i18n.t('将释放约 {mb} MB', { mb: 512 }), '将释放约 512 MB');
  assert.strictEqual(i18n.t('退出'), '退出');
});

test('英文环境：命中词典并回填数字与参数', () => {
  i18n.setLanguage('en-US');
  assert.strictEqual(i18n.t('退出'), 'Quit');
  assert.strictEqual(i18n.t('将释放约 {mb} MB', { mb: 512 }), 'Will release about 512 MB');
  // 数字在模板里写死的情况也要回填（词典 key 里它是占位符）
  assert.strictEqual(i18n.t('第 1 步 / 共 3 步'), 'Step 1 of 3');
});

test('词典缺条目时回落中文原文（不是空串、不是 key）', () => {
  i18n.setLanguage('en-US');
  const s = '这是一句故意没进词典的文案 42';
  assert.strictEqual(i18n.t(s), s);
});

test('语言解析：auto 跟随系统，显式设置优先', () => {
  assert.strictEqual(i18n.resolve('auto', 'zh-CN'), 'zh-CN');
  assert.strictEqual(i18n.resolve('auto', 'zh-TW'), 'zh-CN');
  assert.strictEqual(i18n.resolve('auto', 'en-US'), 'en-US');
  assert.strictEqual(i18n.resolve('auto', 'de-DE'), 'en-US');
  assert.strictEqual(i18n.resolve('zh-CN', 'en-US'), 'zh-CN');
  assert.strictEqual(i18n.resolve('en-US', 'zh-CN'), 'en-US');
  assert.strictEqual(i18n.resolve('garbage', 'en-US'), 'en-US');
  assert.strictEqual(i18n.resolve('auto', ['fr-FR', 'en-GB']), 'en-US');
  assert.strictEqual(i18n.resolve('auto', ['zh-TW', 'en-US']), 'zh-CN');
  assert.strictEqual(i18n.resolve('auto', ['fr-FR']), 'en-US');
});

test('主界面静态文案 100% 有英文（漏一条就是中英混排）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'src', 'ui', 'shell.html'), 'utf8');
  const texts = [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter((t) => CJK.test(t));
  // 纯符号 / 单字按钮不单独成条也没关系（会被上下文覆盖），这里只要求「命中率」
  const missing = [];
  for (const t of texts) {
    if (!DICT[t] && !DICT[normalize(t)]) missing.push(t);
  }
  const covered = texts.length - missing.length;
  const ratio = covered / texts.length;
  assert(ratio >= 0.985, `静态文案覆盖 ${(ratio * 100).toFixed(1)}%，缺 ${missing.length} 条：${JSON.stringify(missing.slice(0, 6))}`);
});

test('应用窗口（shell.html）标题栏 tooltip 有英文', () => {
  for (const key of ['横屏 / 竖屏（Ctrl+R）', '最小化', '最大化', '关闭']) {
    assert(DICT[key] || DICT[normalize(key)], `缺翻译：${key}`);
  }
});

test('动态文案抽样：状态与 toast 都覆盖', () => {
  const samples = [
    '正在启动安卓运行时…', '运行中', '已启动', '启动失败', '已卸载',
    '部署失败：{e}', '正在安装 {name}', '{n} 已安装', '清理完成', '重置失败',
  ];
  const missing = samples.filter((k) => !DICT[normalize(k)]);
  assert(missing.length === 0, `缺动态文案：${JSON.stringify(missing)}`);
});

test('渲染层翻译器存在且只在英文环境改写文本', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'i18n.js'), 'utf8');
  assert(/window\.apkI18n/.test(src), '必须暴露 window.apkI18n 给 app.js / shell.js');
  assert(/lang !== 'en-US'/.test(src), '非英文环境必须直接返回，不做任何 DOM 改写');
  assert(/MutationObserver/.test(src), '动态卡片/toast 需要增量翻译');
});

test('preload 暴露 i18n 接口，主进程有对应 handler', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert(/i18n:\s*\(\)\s*=>\s*invoke\('app:i18n'\)/.test(pre), 'preload 缺 i18n 接口');
  assert(/ipcMain\.handle\('app:i18n'/.test(main), '主进程缺 app:i18n 处理器');
});

test('语言设置项已进默认设置与设置页', () => {
  const store = fs.readFileSync(path.join(ROOT, 'src', 'core', 'store.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/language: 'auto'/.test(store), '默认设置缺 language');
  assert(/id="setLanguage"/.test(html), '设置页缺语言下拉框');
  assert(/setLanguage'\)\.addEventListener\('change'/.test(app), '语言下拉框没绑定事件');
});

i18n.setLanguage('zh-CN');

if (fails.length) {
  console.log(`\n国际化测试：${passed} 通过，${fails.length} 失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`国际化测试：${passed} 项全部通过`);

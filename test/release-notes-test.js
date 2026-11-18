'use strict';
/**
 * 发行说明生成（tools/release-notes.js）与更新日志渲染（app.js 的 mdToHtml）的单元测试。
 *
 * 守的是「每个版本的更新日志名称与发布正文」不再乱：
 *   1. 正文开头重复的版本大标题（`# ApkStart vX.Y.Z`）必须被剥掉——
 *      Release 名称 / 应用内「更新日志（vX.Y.Z）」已经写了版本号；
 *   2. 来源优先级：手写 release-notes 文件 → CHANGELOG 段落 → git log 兜底；
 *   3. CHANGELOG 抽取不能把下个版本或页脚链接吃进来；
 *   4. 更新日志渲染把 markdown 记号（#、**、表格竖线）藏好，并且不放过脚本注入。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { buildNotes, stripTitle, fromFile, fromChangelog, fromGit, appendBasics, supportsLinux } = require(path.join(ROOT, 'tools', 'release-notes.js'));

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { fails.push(`${name}: ${e.message}`); console.error(`  ✗ ${name}\n    ${e.message}`); }
}

/** 临时仓库骨架：.github/release-notes-* 与 CHANGELOG.md 都可以按需放进去 */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-notes-'));
  fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return dir;
}

console.log('\n[tools/release-notes.js]');

test('stripTitle 去掉开头的 H1 版本标题（含「发行说明」后缀）', () => {
  assert.strictEqual(
    stripTitle('# ApkStart v0.3.5 发行说明\n\n正文\n').trim(),
    '正文',
  );
  assert.strictEqual(
    stripTitle('# ApkStart v0.6.4\n\n修掉一个问题。\n').trim(),
    '修掉一个问题。',
  );
});

test('stripTitle 不误伤二级标题开头的正文', () => {
  assert.strictEqual(stripTitle('## 这一版解决什么\n\n内容\n').trim(), '## 这一版解决什么\n\n内容');
});

test('手写 release-notes 文件优先，且剥掉重复标题', () => {
  const dir = fixture({
    '.github/release-notes-v9.0.0.md': '# ApkStart v9.0.0 发行说明\n\n来自文件\n',
    'CHANGELOG.md': '## [9.0.0] — 2026-01-01\n\n来自 CHANGELOG\n',
  });
  const r = buildNotes({ tag: 'v9.0.0', root: dir });
  assert.strictEqual(r.source, 'release-notes');
  assert(r.body.startsWith('来自文件\n'), '正文应保留手写内容');
  assert(r.body.includes('ApkStart-v9.0.0-win64-portable.zip'), '应自动补齐下载清单');
  assert(r.body.includes('## 升级'), '应自动补齐升级说明');
  assert(r.body.includes('## 支持范围'), '应自动补齐支持范围');
});

test('已有基础段落不重复，缺失的段落才补齐', () => {
  const body = appendBasics([
    '## 这次升级了什么',
    '',
    '修了一个问题。',
    '',
    '## 下载',
    '',
    '已有下载说明。',
    '',
    '## 升级',
    '',
    '已有升级说明。',
    '',
    '## 支持范围',
    '',
    '本项目仅支持 Windows 10/11 x64。',
  ].join('\n'), 'v9.0.0');
  assert.strictEqual((body.match(/^## 下载$/gm) || []).length, 1, '下载类标题不能重复');
  assert.strictEqual((body.match(/^## 升级$/gm) || []).length, 1, '升级类标题不能重复');
  assert.strictEqual((body.match(/^## 支持范围/gm) || []).length, 1, '支持范围不能重复');
});

test('v0.7.0 起发行说明列出 Linux 资产，历史版本仍保持 Windows-only', () => {
  assert.strictEqual(supportsLinux('v0.6.18'), false);
  assert.strictEqual(supportsLinux('v0.7.0'), true);
  assert.strictEqual(supportsLinux('v1.0.0'), true);

  const current = appendBasics('## 更新内容\n\n增加 Linux 支持。', 'v0.7.0');
  assert(current.includes('ApkStart-0.7.0-x86_64.AppImage'), '应列出 Linux AppImage');
  assert(current.includes('ApkStart-0.7.0-amd64.deb'), '应列出 Linux deb');
  assert(current.includes('Windows 10/11 x64 与 Linux x86_64'), '应声明双平台支持范围');

  const historical = appendBasics('## 更新内容\n\n修复一个问题。', 'v0.6.18');
  assert(!historical.includes('AppImage'), '历史版本不能补上后来的 Linux 资产');
  assert(historical.includes('本项目仅支持 Windows 10/11 x64。'), '历史范围保持不变');
});

test('没有文件时抽取 CHANGELOG 段落（不含标题行、不吞下个版本）', () => {
  const dir = fixture({
    'CHANGELOG.md': [
      '# 更新日志',
      '',
      '## [9.0.0] — 2026-01-02',
      '',
      '> 主题一句话',
      '',
      '### 修复',
      '- 修了甲',
      '',
      '## [8.0.0] — 2026-01-01',
      '',
      '上个版本的内容',
      '',
      '[9.0.0]: https://example.invalid/9',
    ].join('\n'),
  });
  const r = buildNotes({ tag: 'v9.0.0', root: dir });
  assert.strictEqual(r.source, 'changelog');
  assert(r.body.includes('修了甲'), '应包含本版本内容');
  assert(r.body.includes('主题一句话'), '应保留主题引导行');
  assert(!r.body.includes('上个版本的内容'), '不能吞掉下个版本');
  assert(!r.body.includes('example.invalid'), '不能吞掉页脚链接');
  assert(r.body.includes('ApkStart-v9.0.0-win64-portable.zip'), 'CHANGELOG 兜底也应补齐下载清单');
  assert(r.body.includes('## 升级'), 'CHANGELOG 兜底也应补齐升级说明');
});

test('合并标题（[8.0.0] / [7.0.0]）里任一版本都能命中', () => {
  const dir = fixture({
    'CHANGELOG.md': '## [8.0.0] / [7.0.0] — 2026-01-01\n\n两个版本一起发\n',
  });
  assert.strictEqual(fromChangelog(dir, 'v7.0.0').trim(), '两个版本一起发');
  assert.strictEqual(fromChangelog(dir, 'v8.0.0').trim(), '两个版本一起发');
});

test('三级兜底：都没有时用 git log 生成提交列表（不是 Full Changelog 一行）', () => {
  let gitOk = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_) { gitOk = false; }
  if (!gitOk) { console.log('    (本机没有 git，跳过)'); return; }
  const dir = fixture({});
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    g(['init', '-q']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    g(['add', 'a.txt']);
    g(['commit', '-q', '-m', '第一个提交']);
    g(['tag', 'v1.0.0']);
    fs.writeFileSync(path.join(dir, 'a.txt'), '2');
    g(['add', 'a.txt']);
    g(['commit', '-q', '-m', '第二个提交']);
    g(['tag', 'v1.1.0']);
    const body = fromGit(dir, 'v1.1.0', 'owner/repo');
    assert(body.includes('第二个提交'), '应包含提交主题');
    assert(body.includes('compare/v1.0.0...v1.1.0'), '应带对比链接');
  } catch (e) {
    assert.fail(`git 夹具构造失败：${e.message}`);
  }
});

test('真实仓库：v0.6.4 走手写文件、正文无重复标题', () => {
  const r = buildNotes({ tag: 'v0.6.4', root: ROOT });
  assert.strictEqual(r.source, 'release-notes');
  assert(!/^#\s/m.test(r.body), '正文不应再有 H1 标题');
  assert.strictEqual((r.body.match(/^## 下载哪个$/gm) || []).length, 1, '下载信息应只出现一次');
  assert(r.body.includes('ApkStart-v0.6.4-win64-portable.zip'), '应保留当前版本下载名');
});

test('真实仓库：当前版本 v0.6.5 有手写发行说明', () => {
  const r = buildNotes({ tag: 'v0.6.5', root: ROOT });
  assert.strictEqual(r.source, 'release-notes');
  assert(r.body.includes('导入本地整包'), '发行说明应包含本版新增能力');
  assert(!/^#\s/m.test(r.body), '正文不应再有 H1 标题');
  assert(r.body.includes('ApkStart-0.6.5-Setup.exe'), '后续版本也必须有完整下载清单');
  assert(r.body.includes('## 升级'), '后续版本也必须有升级说明');
});

test('真实仓库：v0.6.6 保留升级内容并补齐基础信息', () => {
  const r = buildNotes({ tag: 'v0.6.6', root: ROOT });
  assert.strictEqual(r.source, 'release-notes');
  assert(r.body.includes('独立的全屏设置页面'), '发行说明应包含本版新增能力');
  assert(r.body.includes('ApkStart-runtime-v0.6.6.zip'), '应有运行时整包下载项');
  assert(r.body.includes('已装应用、存档、系统镜像和运行时数据都不受影响'), '应保留升级影响说明');
});

console.log('\n[src/ui/app.js mdToHtml]');

/** app.js 是浏览器脚本（无 module 导出），按标记把 mdToHtml 抽出来在 Node 里跑 */
function loadMdToHtml() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  const m = src.match(/function mdToHtml\(md\) \{[\s\S]*?\n\}/);
  assert(m, 'app.js 里找不到 mdToHtml');
  const factory = new Function('esc', `${m[0]}; return mdToHtml;`);
  return factory((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  )));
}

test('标题/加粗/表格/代码块都渲染掉，不再露出 markdown 记号', () => {
  const mdToHtml = loadMdToHtml();
  const html = mdToHtml([
    '# ApkStart v0.6.4',
    '',
    '修掉 **一个** 问题。',
    '',
    '## 下载哪个',
    '',
    '| 文件 | 说明 |',
    '|---|---|',
    '| `a.zip` | 便携版 |',
    '',
    '```',
    'raw <b>code</b>',
    '```',
  ].join('\n'));
  assert(html.includes('<h4>ApkStart v0.6.4</h4>'), 'H1 应渲染成标题');
  assert(html.includes('<strong>一个</strong>'), '加粗应渲染');
  assert(html.includes('<table>') && html.includes('<td><code>a.zip</code></td>'), '表格应渲染且不留竖线');
  assert(!html.includes('| 文件 |'), '不能露出表格竖线');
  assert(html.includes('<pre><code>raw &lt;b&gt;code&lt;/b&gt;</code></pre>'), '代码块应转义');
});

test('HTML 注入与 javascript: 链接都会被拦下', () => {
  const mdToHtml = loadMdToHtml();
  const html = mdToHtml('文字 <script>alert(1)</script>\n\n[点我](javascript:alert(1))\n');
  assert(!html.includes('<script>'), '必须转义尖括号');
  assert(!html.includes('href="javascript:'), 'javascript: 链接不得成为 a 标签');
});

const total = passed + fails.length;
console.log(`\n${fails.length ? '✗' : '✓'} release-notes 测试：${passed}/${total} 通过`);
if (fails.length) {
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}

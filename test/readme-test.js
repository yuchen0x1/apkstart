'use strict';
/**
 * README 版本信息与「最新更新」的回归测试。
 *
 * 起因：0.6.8 已经发布，README 里还写着 0.6.7、「最新更新」也停在上一版，
 * 用户点进仓库看到的是过期信息。现在 README 的版本区块由 tools/update-readme.js
 * 从 package.json + CHANGELOG 生成，这个测试负责保证它不会再次过期。
 *
 * 过期就是失败：发版工作流（.github/workflows/release.yml）会先跑 npm test，
 * 所以「忘了改 README」不会再悄悄发出去。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, renderBlocks, sectionSummary, changelogSection, START, END } = require('../tools/update-readme');

const ROOT = path.join(__dirname, '..');
const results = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`  ✗ ${name}\n      ${e.message}`);
  }
}

(async () => {
  console.log('\n[README]');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  await test('README 带版本区块标记', () => {
    for (const tag of [START.version, END.version, START.latest, END.latest]) {
      assert(readme.includes(tag), `缺少标记 ${tag}`);
    }
  });

  await test('README 版本号与 package.json 一致（发版必须同步）', () => {
    const r = plan({ root: ROOT });
    assert(!r.changed,
      `README 的版本信息已过期（package.json 是 ${pkg.version}）。运行 npm run readme:sync 后提交。`);
  });

  await test('「最新更新」标题对应当前版本', () => {
    const block = new RegExp(`${START.latest}[\\s\\S]*${END.latest}`).exec(readme);
    assert(block, '找不到最新更新区块');
    assert(block[0].includes(`### v${pkg.version}`),
      `「最新更新」标题应为 v${pkg.version}，实际：${block[0].split('\n')[1]}`);
  });

  await test('折行条目被拼回一条，不会截在半句', () => {
    // CHANGELOG 的条目是手动折行的；早期实现只取 `- ` 开头那一行，
    // 结果 README 上每一条都断在半句话（「系统语言」后面直接没了）。
    const { bullets } = sectionSummary([
      '### 新增',
      '- **一号条目**：这一句很长，被手动折行——',
      '  续写部分应该接在上一行后面。',
      '- **二号条目**：短句。',
    ].join('\n'));
    assert(bullets.length === 2, `应解析出 2 条，实际 ${bullets.length}`);
    assert(bullets[0].includes('续写部分应该接在上一行后面'), `续行未合并：${bullets[0]}`);
  });

  await test('导语（CHANGELOG 段首的 > 摘要）会被带进 README', () => {
    const { intro } = sectionSummary('> 一句话总结本版。\n\n### 新增\n- 某条\n');
    assert(intro === '一句话总结本版。', `导语解析失败：${intro}`);
  });

  await test('CHANGELOG 版本标题按标签精确匹配，不解释正则元字符', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-readme-'));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), [
      '## [1.2.3.*] — 2026-01-01',
      '',
      '字面量版本',
      '',
      '## [1.2.3XYZ] — 2026-01-01',
      '',
      '不应被通配符命中',
    ].join('\n'), 'utf8');
    const section = changelogSection(dir, '1.2.3.*');
    assert(section && section.body.includes('字面量版本'));
    assert(!section.body.includes('不应被通配符命中'));
  });

  await test('版本区块只替换标记之间的内容', () => {
    const src = [
      '# 标题',
      '',
      `${START.version}`,
      '> 旧版本：0.0.1',
      `${END.version}`,
      '',
      '中间正文不应被改动',
      '',
      `${START.latest}`,
      '### v0.0.1',
      `${END.latest}`,
      '',
      '尾部',
    ].join('\n');
    const out = src
      .replace(new RegExp(`${START.version}[\\s\\S]*?${END.version}`), `${START.version}\n新版本行\n${END.version}`)
      .replace(new RegExp(`${START.latest}[\\s\\S]*?${END.latest}`), `${START.latest}\n### v9\n${END.latest}`);
    assert(out.includes('中间正文不应被改动') && out.includes('尾部'), '标记之外的内容被改动了');
    assert(out.includes('新版本行'), '版本行未被替换');
  });

  await test('缺少标记时明确报错，而不是静默跳过', () => {
    assert(renderBlocks({ version: '1.0.0', section: null }).latest.includes('### v1.0.0'));
  });

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();

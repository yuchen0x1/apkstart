'use strict';
/**
 * 同步 README.md 里的版本信息（版本行 + 「最新更新」小节）。
 *
 * 为什么要有这个脚本：README 里的版本号是手写的，发版时最容易漏改——0.6.8 发出去以后
 * README 还写着 0.6.7、「最新更新」还停在上一版的条目，用户点进仓库看到的就是过期信息。
 * 现在版本信息只允许有两个来源：
 *
 *   - `package.json` 的 version  → 版本号
 *   - `CHANGELOG.md` 的对应段落   → 发布日期与「最新更新」条目
 *
 * README 里对应两段被标记包起来，脚本只重写标记之间的内容，其余文字一个字节都不动：
 *
 *   <!-- version:start --> ... <!-- version:end -->
 *   <!-- latest:start  --> ... <!-- latest:end  -->
 *
 * 用法：
 *   node tools/update-readme.js            # 按当前 package.json 版本刷新 README
 *   node tools/update-readme.js --check    # 只检查是否过期（CI / npm test 用），过期退出码 1
 *   node tools/update-readme.js --tag v0.6.9  # 指定版本（默认读 package.json）
 */
const fs = require('fs');
const path = require('path');
const { tidy } = require('./release-notes');

const START = { version: '<!-- version:start -->', latest: '<!-- latest:start -->' };
const END = { version: '<!-- version:end -->', latest: '<!-- latest:end -->' };

/** CHANGELOG 里该版本段落的标题行与正文（正文不含标题） */
function changelogSection(root, version) {
  const p = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const hit = new RegExp(`^## .*\\[${version.replace(/\./g, '\\.')}\\]`);
  const i = lines.findIndex((l) => hit.test(l));
  if (i < 0) return null;
  const body = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (/^## /.test(lines[j]) || /^\[\d+\.\d+\.\d+[^\]]*\]:\s/.test(lines[j])) break;
    body.push(lines[j]);
  }
  // 标题形如 `## [0.6.8] — 2026-11-16` / `## [0.6.8] - 2026-11-16` / `## [0.6.8]`
  const date = /—|\s-\s/.test(lines[i]) ? (/(\d{4}-\d{2}-\d{2})/.exec(lines[i]) || [])[1] || '' : '';
  return { heading: lines[i], date, body: body.join('\n') };
}

/**
 * 把 CHANGELOG 段落提炼成 README 的「最新更新」：
 *   - 段落开头的 `> 一句话总结` 当成导语（CHANGELOG 里本来就有，README 直接用）；
 *   - 条目是**换行折行**写的，必须把续行并回上一条（否则会截在句子中间，
 *     0.6.8 首次生成时就是每行断一半）；
 *   - 只取顶层 `- ` 条目，`### 新增` 这类小标题不搬（README 要的是概览）。
 */
function sectionSummary(body, { limit = 6, maxLen = 300 } = {}) {
  const lines = String(body || '').split('\n');
  const intro = [];
  const items = [];
  let cur = null;
  const flush = () => {
    if (cur) items.push(cur);
    cur = null;
  };
  // 折行拼接：中文直接连；下一行以 ASCII/代码开头时补一个空格（原 markdown 的软换行
  // 本来就渲染成空格），否则会出现「一键调用`Enable-WindowsOptionalFeature`」这种黏连。
  const join = (a, b) => (!a || !b ? `${a}${b}` : (/^[A-Za-z0-9`(]/.test(b) || /[A-Za-z0-9`]$/.test(a) ? `${a} ${b}` : `${a}${b}`));
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^>\s?/.test(line)) {
      // 导语只取段落最开头那段（后面出现的引用一般是补充说明，不重要）
      if (!items.length && !cur && intro.length < 3) intro.push(line.replace(/^>\s?/, ''));
      continue;
    }
    if (/^#{2,6}\s+/.test(line)) { flush(); continue; }
    if (/^-\s+/.test(line)) {
      flush();
      cur = line.replace(/^-\s+/, '');
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (cur) cur = join(cur, line.trim());
  }
  flush();

  const bullets = items.slice(0, limit).map((t) => {
    const one = t.replace(/\s+/g, ' ').trim();
    if (one.length <= maxLen) return one;
    // 超长条目在最后一个完整句子处截断，不要切在词中间
    const cut = one.lastIndexOf('。', maxLen);
    return `${one.slice(0, cut > 60 ? cut + 1 : maxLen).trim()}`;
  });
  return { intro: intro.join('').replace(/\s+/g, ' ').trim(), bullets };
}

/** 生成两段标记之间的新内容 */
function renderBlocks({ version, section }) {
  const date = section && section.date ? `（${section.date}）` : '';
  const versionBlock = [
    `> 当前版本：**${version}**${date}。完整变更记录见 [CHANGELOG.md](CHANGELOG.md) `
      + '与 [GitHub Releases](https://github.com/yuchen0x1/apkstart/releases)。',
  ].join('\n');

  const { intro, bullets } = section
    ? sectionSummary(section.body)
    : { intro: '', bullets: [] };
  const lines = [`### v${version}`, ''];
  if (intro) lines.push(`> ${intro}`, '');
  if (bullets.length) lines.push(...bullets.map((b) => `- ${b}`));
  else lines.push('本版本的变更说明见 [CHANGELOG.md](CHANGELOG.md)。');

  return { version: versionBlock, latest: lines.join('\n') };
}

/** 用新内容替换标记区间，返回 { text, changed } */
function applyBlocks(text, blocks) {
  let out = String(text);
  for (const key of ['version', 'latest']) {
    const re = new RegExp(`${escapeRe(START[key])}[\\s\\S]*?${escapeRe(END[key])}`);
    if (!re.test(out)) {
      throw new Error(`README.md 缺少标记 ${START[key]} / ${END[key]}，无法自动同步版本信息`);
    }
    out = out.replace(re, `${START[key]}\n${blocks[key]}\n${END[key]}`);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 计算 README 应有的内容。
 * @returns {{expected:string, current:string, version:string, changed:boolean, missingSection:boolean}}
 */
function plan(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..');
  const readmePath = path.join(root, 'README.md');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(opts.tag || pkg.version || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`版本号不合法：${version}`);
  const section = changelogSection(root, version);
  const current = fs.readFileSync(readmePath, 'utf8');
  const expected = tidy(applyBlocks(current, renderBlocks({ version, section })));
  return {
    expected,
    current: tidy(current),
    version,
    changed: tidy(current) !== expected,
    missingSection: !section,
  };
}

module.exports = { plan, renderBlocks, sectionSummary, changelogSection, START, END };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const ti = argv.indexOf('--tag');
  const root = path.resolve(__dirname, '..');
  try {
    const r = plan({ root, tag: ti >= 0 ? argv[ti + 1] : '' });
    if (check) {
      if (r.missingSection) {
        console.error(`CHANGELOG.md 里没有 [${r.version}] 段落：先补变更记录，README 才能同步。`);
        process.exit(1);
      }
      if (r.changed) {
        console.error(`README.md 的版本信息已过期（应为 v${r.version}）。运行 npm run readme:sync 更新后提交。`);
        process.exit(1);
      }
      console.log(`README.md 版本信息一致（v${r.version}）`);
      process.exit(0);
    }
    if (r.missingSection) {
      console.error(`CHANGELOG.md 里没有 [${r.version}] 段落：先补变更记录，README 才能同步。`);
      process.exit(1);
    }
    if (!r.changed) {
      console.log(`README.md 已是最新（v${r.version}）`);
      process.exit(0);
    }
    fs.writeFileSync(path.join(root, 'README.md'), r.expected, 'utf8');
    console.log(`README.md 已更新到 v${r.version}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

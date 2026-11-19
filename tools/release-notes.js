'use strict';
/**
 * 生成规范化发行说明（GitHub Release body / 应用内「软件更新」共用一份）。
 *
 * 为什么要这个脚本：发行说明的来源曾经有三种——手写 .github/release-notes-*.md、
 * CHANGELOG.md 对应段落、gh --generate-notes 兜底——正文开头的标题有的带「发行说明」、
 * 有的裸标题、有的干脆只剩一句没用的 "Full Changelog"，每个版本发布出去格式都不一样。
 * 这里统一成一条规则：
 *
 *   1. 优先 `.github/release-notes-<tag>.md`（手写的完整发行说明）；
 *   2. 其次 CHANGELOG.md 里该版本的段落（内容原样，去掉标题行）；
 *   3. 最后 git log 兜底（上个 tag 到本 tag 的提交列表，而不是自动生成的废话）；
 *   4. 无论正文来自哪条路，都补齐「下载哪个」「升级」「支持范围」等固定信息；
 *      v0.7.0 起固定列出 Windows 与 Linux 两个平台的发布资产。
 *
 * 产出的正文一律**不带重复的版本大标题**：GitHub Release 名称、
 * 应用内「更新日志（vX.Y.Z）」都已经写了版本号，正文再来一行 `# ApkStart vX.Y.Z`
 * 只会让每个页面上的版本号都出现两遍。
 *
 * 用法：
 *   node tools/release-notes.js v0.6.4 [--out RELEASE_NOTES.md] [--repo owner/repo] [--root 目录]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_REPO = 'yuchen0x1/apkstart';

/** 去掉正文开头重复的 H1 版本标题（`# ApkStart v0.6.4` / `# ApkStart v0.3.5 发行说明`） */
function stripTitle(raw) {
  let s = String(raw || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  s = s.replace(/^#\s+[^\n]*\n+/, '');
  return s;
}

/** 收尾规整：去首尾空白、折叠 3 个以上连续空行、保证单个结尾换行 */
function tidy(raw) {
  let s = String(raw || '').replace(/\r\n?/g, '\n').trim();
  s = s.replace(/\n{3,}/g, '\n\n');
  return s ? `${s}\n` : '';
}

/** 1) 手写发行说明文件 */
function fromFile(root, tag) {
  const p = path.join(root, '.github', `release-notes-${tag}.md`);
  if (!fs.existsSync(p)) return null;
  return tidy(stripTitle(fs.readFileSync(p, 'utf8')));
}

/**
 * 2) CHANGELOG.md 里该版本的段落。
 * 标题形如 `## [0.6.4] — 2026-11-16`，合并条目 `## [0.3.4] / [0.3.3] — 2026-11-14`，
 * 末尾还有 `## [0.2.6] 及更早` 这类打包段——只要标题标签里含 [X.Y.Z] 就算命中。
 */
function fromChangelog(root, tag) {
  const p = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(p)) return null;
  const ver = String(tag).replace(/^v/i, '');
  const lines = fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const hit = new RegExp(`^## .*\\[${ver.replace(/\./g, '\\.')}\\]`);
  const isHeading = (l) => /^## /.test(l);
  const isFooter = (l) => /^\[\d+\.\d+\.\d+[^\]]*\]:\s/.test(l);
  let i = lines.findIndex((l) => hit.test(l));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (isHeading(lines[j]) || isFooter(lines[j])) break;
    out.push(lines[j]);
  }
  return tidy(out.join('\n'));
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return '';
  }
}

/** 3) git log 兜底：上个 tag 到本 tag 的提交列表 */
function fromGit(root, tag, repo) {
  const prev = git(root, ['describe', '--tags', '--abbrev=0', `${tag}^`]);
  const range = prev ? `${prev}..${tag}` : tag;
  const log = git(root, ['log', '--pretty=format:- %s (%h)', range]);
  if (!log) return null;
  const head = '## 更新内容\n\n';
  const url = `https://github.com/${repo}/compare/${prev}...${tag}`;
  const tail = prev ? `\n\n完整变更记录：${url}\n` : `\n\n${url}\n`;
  return `${head}${log}${tail}`;
}

/**
 * 判断一个版本是否属于 v0.7.0 起的双平台发布线。
 * 0.6.x 仍然是历史上的 Windows-only Release，不能回写成 Linux 版本。
 */
function supportsLinux(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag || ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || (major === 0 && minor >= 7);
}

/**
 * 每个 Release 都要有的固定信息。
 *
 * 手写发行说明可以专注于「这版升级了什么、修了什么」，但不能因此把用户
 * 下载和升级时需要的基本信息漏掉。历史正文使用过「下载」「下载与升级」
 * 等不同标题，所以这里只在同类标题不存在时补齐，避免重复显示。
 */
function appendBasics(raw, tag) {
  let body = tidy(raw);
  const version = String(tag).replace(/^v/i, '');
  const dualPlatform = supportsLinux(tag);
  const hasHeading = (pattern) => body.split('\n').some((line) => (
    /^#{2,6}\s+/.test(line) && pattern.test(line)
  ));
  const sections = [];

  if (!hasHeading(/下载/)) {
    const downloads = [
      '## 下载哪个',
      '',
      '| 文件 | 说明 |',
      '|---|---|',
      `| \`ApkStart-v${version}-win64-portable.zip\` | 轻量便携版，运行时首次启动按需下载 |`,
      `| \`ApkStart-${version}-Setup.exe\` | 完整安装包，内置运行时，离线开箱即用 |`,
      `| \`ApkStart-runtime-v${version}.zip\` | 运行时整包（便携版下载源，一般不用手动下载） |`,
    ];
    const [major, minor] = version.split('.').map(Number);
    if (major > 0 || minor >= 8) {
      downloads.splice(-2, 2, '| `ApkStart-' + version + '-Setup.exe` | Windows 在线安装版，支持本地离线导入 |');
    }
    if (dualPlatform) {
      downloads.push(
        `| \`ApkStart-${version}-x86_64.AppImage\` | Linux x86_64 便携版，首次启动按需下载运行时 |`,
        `| \`ApkStart-${version}-amd64.deb\` | Linux x86_64 安装包，适合 Debian / Ubuntu |`,
      );
    }
    sections.push(downloads.join('\n'));
  }

  if (!hasHeading(/升级/)) {
    sections.push([
      '## 升级',
      '',
      '安装版直接覆盖安装，便携版替换程序目录即可。已装应用、存档、系统镜像和运行时数据都不受影响。',
    ].join('\n'));
  }

  if (!hasHeading(/支持范围/)) {
    sections.push([
      '## 支持范围',
      '',
      dualPlatform
        ? '本项目支持 Windows 10/11 x64 与 Linux x86_64（AppImage / deb）；macOS 不支持。'
        : '本项目仅支持 Windows 10/11 x64。',
    ].join('\n'));
  }

  if (sections.length) body = `${body.trim()}\n\n${sections.join('\n\n')}\n`;
  return tidy(body);
}

/**
 * 组装发行说明。返回 { body, source }：
 * source ∈ 'release-notes' | 'changelog' | 'git-log'，CI 日志里能看出用的是哪条路。
 */
function buildNotes(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..');
  const tag = String(opts.tag || '').replace(/^v/i, '');
  const repo = opts.repo || DEFAULT_REPO;
  if (!/^\d+\.\d+\.\d+/.test(tag)) throw new Error(`版本号不合法：${opts.tag}`);
  const vtag = `v${tag}`;
  const attempts = [
    ['release-notes', () => fromFile(root, vtag)],
    ['changelog', () => fromChangelog(root, vtag)],
    ['git-log', () => fromGit(root, vtag, repo)],
  ];
  for (const [source, fn] of attempts) {
    const body = fn();
    if (body && body.trim()) return { body: appendBasics(body, vtag), source };
  }
  throw new Error(`找不到 ${vtag} 的任何发行说明来源（release-notes 文件 / CHANGELOG / git log）`);
}

module.exports = { buildNotes, stripTitle, tidy, fromFile, fromChangelog, fromGit, appendBasics, supportsLinux };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const tag = argv.find((a) => /^v?\d/.test(a)) || '';
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  try {
    const { body, source } = buildNotes({
      tag,
      root: arg('--root', undefined),
      repo: arg('--repo', DEFAULT_REPO),
    });
    const out = arg('--out', '');
    if (out) {
      fs.writeFileSync(out, body, 'utf8');
      console.log(`发行说明已写入 ${out}（来源：${source}，${body.length} 字符）`);
    } else {
      process.stdout.write(body);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

'use strict';
/**
 * 构建体积/内容闸门：确保安装包与源码里不含大型系统镜像。
 * ------------------------------------------------------------------
 * 扫描目录，发现以下可疑文件即报错（退出码 2）：
 *   - 任何 .iso（无论大小）
 *   - >64MB 的 .img/.qcow2/.vmdk/.raw/.vdi/.vhd
 *   - 这三个系统的镜像文件名（lineageos / bliss / android-x86 的 iso）
 * 允许：压缩过的系统镜像 .img.xz / .img.gz（完整版本机运行时需要），以及 <64MB 的 seed 模板。
 *
 * 用法：
 *   node build/check-no-images.js <dir> [<dir2> ...]          扫描指定目录
 *   node build/check-no-images.js --git                        扫描 git 跟踪的大文件
 *   node build/check-no-images.js --self                       扫描仓库源码/构建产物目录
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MIB = 1024 * 1024;
const BIG_IMG_RE = /\.(img|qcow2|vmdk|raw|vdi|vhd|qcow|img\.tmp)$/i;
const ISO_RE = /\.iso$/i;
const COMPRESSED_RE = /\.(xz|gz|zst|lzma)$/i;
const THIRD_PARTY_NAME_RE = /(lineage.?os|bliss|android.?x86|android-x86_64)/i;
const BIG_THRESHOLD = 64 * MIB;

/** 扫描一个目录，返回违规项数组 */
function scanDir(root, opts = {}) {
  const findings = [];
  if (!fs.existsSync(root)) return findings;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) {
        // 跳过 node_modules 的深层遍历（性能），但不跳过系统目录名
        if (e.name === 'node_modules' && opts.skipNodeModules !== false) continue;
        stack.push(p);
        continue;
      }
      if (!st.isFile()) continue;
      const size = st.size;
      const rel = path.relative(opts.base || root, p);
      let reason = '';
      if (ISO_RE.test(e.name)) {
        reason = 'ISO 系统镜像禁止进入安装包/源码';
      } else if (THIRD_PARTY_NAME_RE.test(e.name) && BIG_IMG_RE.test(e.name)) {
        reason = '第三方系统虚拟磁盘禁止内置';
      } else if (BIG_IMG_RE.test(e.name) && !COMPRESSED_RE.test(e.name) && size > BIG_THRESHOLD) {
        reason = `大型磁盘镜像 ${(size / MIB).toFixed(0)}MB（>64MB）`;
      }
      if (reason) findings.push({ path: rel, size, reason });
    }
  }
  return findings;
}

/** 扫描 git 跟踪的文件（用 git ls-files，避免误扫 .git 与 node_modules） */
function scanGit(root, exec = execFileSync) {
  const findings = [];
  let out = '';
  try {
    out = exec('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * MIB });
  } catch (_) { return findings; }
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    const p = path.join(root, rel);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const name = path.basename(rel);
    let reason = '';
    if (ISO_RE.test(name)) reason = 'ISO 系统镜像禁止进入 git 仓库';
    else if (THIRD_PARTY_NAME_RE.test(name) && BIG_IMG_RE.test(name)) reason = '第三方系统虚拟磁盘禁止进入 git';
    else if (BIG_IMG_RE.test(name) && !COMPRESSED_RE.test(name) && st.size > BIG_THRESHOLD) {
      reason = `大型磁盘镜像 ${(st.size / MIB).toFixed(0)}MB`;
    }
    if (reason) findings.push({ path: rel, size: st.size, reason });
  }
  return findings;
}

function report(findings) {
  if (!findings.length) return true;
  console.error('✗ 发现禁止内置的系统镜像文件：');
  for (const f of findings) {
    console.error(`  - ${f.path} (${(f.size / MIB).toFixed(1)}MB) — ${f.reason}`);
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const root = process.cwd();
  let findings = [];
  if (args.includes('--git')) {
    findings = findings.concat(scanGit(root));
  } else if (args.includes('--self')) {
    for (const dir of ['src', 'build', 'system-catalog', 'docs', 'tools', 'engine']) {
      findings = findings.concat(scanDir(path.join(root, dir), { base: root }));
    }
  } else {
    const dirs = args.filter((a) => !a.startsWith('--'));
    if (!dirs.length) {
      console.error('用法：node build/check-no-images.js <dir>... | --git | --self');
      process.exit(1);
    }
    for (const d of dirs) findings = findings.concat(scanDir(path.resolve(d)));
  }
  if (!report(findings)) {
    console.error('系统镜像必须通过远程目录按需下载，不得内置到主程序/仓库/安装包。');
    process.exit(2);
  }
  console.log('✓ 未发现内置的大型系统镜像');
}

if (require.main === module) main();
module.exports = { scanDir, scanGit, report, BIG_THRESHOLD, ISO_RE, BIG_IMG_RE };

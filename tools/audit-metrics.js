'use strict';
/**
 * 跨平台审计用的度量脚本（只读，不改任何文件）。
 * 输出：源码/测试规模、平台耦合点的分布（按文件计数）。
 * 用法：node tools/audit-metrics.js [--json]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'artifacts', 'test', 'coverage']);

function walk(dir, filter, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, acc);
    else if (filter.test(e.name)) acc.push(p);
  }
  return acc;
}

const PATTERNS = {
  'process.platform': /process\.platform/g,
  'powershell.exe': /powershell\.exe/g,
  "reg.exe / reg'": /\breg(?:\.exe)?['",]/g,
  '/dev/kvm': /\/dev\/kvm/g,
  "win32 literal": /'win32'/g,
  "darwin literal": /'darwin'/g,
  IS_WIN: /\bIS_WIN\b/g,
  "'.exe' suffix": /\.exe'/g,
};

function measureSource() {
  const files = walk(path.join(ROOT, 'src'), /\.(js|css|html|json)$/);
  let lines = 0;
  for (const f of files) lines += fs.readFileSync(f, 'utf8').split(/\r?\n/).length;
  return { files: files.length, lines };
}

function measureTests() {
  const dir = path.join(ROOT, 'test');
  const files = fs.readdirSync(dir).filter((n) => /\.js$/.test(n));
  let lines = 0;
  for (const n of files) lines += fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/).length;
  return { files: files.length, lines };
}

function coupling() {
  const files = walk(path.join(ROOT, 'src'), /\.js$/);
  const out = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    let total = 0;
    const perFile = [];
    for (const f of files) {
      const hits = (fs.readFileSync(f, 'utf8').match(re) || []).length;
      if (hits) {
        total += hits;
        perFile.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), hits });
      }
    }
    perFile.sort((a, b) => b.hits - a.hits);
    out[name] = { total, files: perFile.length, top: perFile.slice(0, 6) };
  }
  return out;
}

const report = { source: measureSource(), tests: measureTests(), coupling: coupling() };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`源码: ${report.source.files} 文件 / ${report.source.lines} 行`);
  console.log(`测试: ${report.tests.files} 文件 / ${report.tests.lines} 行`);
  console.log('\n平台耦合点（全 src，按模式统计）：');
  for (const [name, v] of Object.entries(report.coupling)) {
    const top = v.top.map((t) => `${t.file}(${t.hits})`).slice(0, 4).join(', ');
    console.log(`  ${name.padEnd(16)} 总 ${String(v.total).padStart(4)}  涉及 ${v.files} 文件  ${top}`);
  }
}

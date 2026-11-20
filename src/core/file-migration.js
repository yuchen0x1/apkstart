'use strict';
/** 共享目录迁移：先检查整棵树，再只复制新文件，绝不覆盖目标或递归复制自身。 */
const fs = require('fs');
const path = require('path');

function canonical(file) {
  let current = path.resolve(file);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('无法解析目标目录');
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function contains(root, file) {
  const rel = path.relative(root, file);
  return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function sameFile(a, b) {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  const left = fs.openSync(a, 'r');
  const right = fs.openSync(b, 'r');
  try {
    const x = Buffer.alloc(128 * 1024);
    const y = Buffer.alloc(x.length);
    for (;;) {
      const n = fs.readSync(left, x, 0, x.length, null);
      const m = fs.readSync(right, y, 0, y.length, null);
      if (n !== m || !x.subarray(0, n).equals(y.subarray(0, m))) return false;
      if (!n) return true;
    }
  } finally {
    fs.closeSync(left);
    fs.closeSync(right);
  }
}

function copyDirContents(src, dest) {
  if (!path.isAbsolute(dest)) throw new Error('共享目录必须使用绝对路径');
  const target = canonical(dest);
  const source = src ? canonical(src) : '';
  if (source && path.relative(source, target) === '') return { copied: 0 };
  if (source && (contains(source, target) || contains(target, source))) {
    throw new Error('新旧共享目录不能互为父子目录，请选择独立目录');
  }
  if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) throw new Error('目标不是文件夹');
  const plan = [];
  const directories = [target];
  const scan = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`不能迁移符号链接：${a}`);
      let existing = null;
      try { existing = fs.lstatSync(b); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing && existing.isSymbolicLink()) throw new Error(`目标包含符号链接：${b}`);
      if (entry.isDirectory()) {
        if (existing && !existing.isDirectory()) throw new Error(`目标已有同名文件：${b}`);
        if (!existing) directories.push(b);
        scan(a, b);
      } else if (entry.isFile()) {
        if (existing) {
          if (!existing.isFile() || !sameFile(a, b)) throw new Error(`目标已有不同内容的同名文件，请先处理：${b}`);
        } else plan.push({ from: a, to: b });
      } else throw new Error(`不支持迁移此文件类型：${a}`);
    }
  };
  if (source && fs.existsSync(source)) scan(source, target);
  const created = [];
  try {
    for (const dir of directories) fs.mkdirSync(dir, { recursive: true });
    for (const item of plan) {
      fs.mkdirSync(path.dirname(item.to), { recursive: true });
      if (!contains(target, canonical(path.dirname(item.to)))) throw new Error('迁移目标越过共享目录边界');
      fs.copyFileSync(item.from, item.to, fs.constants.COPYFILE_EXCL);
      created.push(item.to);
    }
  } catch (e) {
    for (const file of created.reverse()) {
      try { fs.unlinkSync(file); } catch (_) { /* 保留源文件，下次可继续迁移 */ }
    }
    throw e;
  }
  return { copied: created.length };
}

module.exports = { copyDirContents };

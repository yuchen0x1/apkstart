'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAGE_DIR = 'runtime-store';
const EXTRA_SPACE = 64 * 1024 * 1024;

function executableName(platform = process.platform) {
  return platform === 'win32' ? 'emulator.exe' : 'emulator';
}

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isWindowsAppsPath(value) {
  return /[\\/]WindowsApps(?:[\\/]|$)/i.test(String(value || ''));
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : 0;
  } catch (_) {
    return 0;
  }
}

function hasSystemImage(root) {
  const imageRoot = path.join(root, 'system-images');
  const walk = (dir, depth) => {
    if (depth > 5) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
    const names = new Set(entries.filter(e => e.isFile()).map(e => e.name.toLowerCase()));
    if (names.has('kernel-ranchu') && ['system.img', 'system.img.xz', 'system.img.gz'].some(n => names.has(n))) return true;
    return entries.some(e => e.isDirectory() && !e.isSymbolicLink() && walk(path.join(dir, e.name), depth + 1));
  };
  return walk(imageRoot, 0);
}

function isCompleteRuntime(root, { platform = process.platform } = {}) {
  if (!root || !fs.existsSync(root)) return false;
  const emu = path.join(root, 'emulator', executableName(platform));
  const adb = path.join(root, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
  return fileSize(emu) > 0 && fileSize(adb) > 0 && hasSystemImage(root);
}

function canWriteDirectory(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, `.apkstart-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
    fs.rmSync(probe, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function existingParent(target) {
  let dir = path.resolve(target);
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
  return dir;
}

function freeBytes(target) {
  try {
    const stat = fs.statfsSync(existingParent(target));
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (_) {
    return null;
  }
}

function directoryBytes(root) {
  let total = 0;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file);
      else total += fileSize(file);
    }
  };
  walk(root);
  return total;
}

function runtimeFingerprint(root) {
  const rows = [];
  const walk = (dir, rel = '') => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const name = path.join(rel, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(file, name);
        continue;
      }
      try {
        const stat = fs.lstatSync(file);
        rows.push(`${name}\0${stat.size}\0${Math.round(stat.mtimeMs)}\0${entry.isSymbolicLink() ? 'link' : 'file'}`);
      } catch (_) { /* a concurrently replaced package is handled by final validation */ }
    }
  };
  walk(root);
  rows.sort();
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 24);
}

function writeMarker(root, source, fingerprint, bytes) {
  try {
    fs.writeFileSync(path.join(root, '.runtime-staging.json'), JSON.stringify({
      source: path.resolve(source), fingerprint, bytes, stagedAt: new Date().toISOString(),
    }, null, 2));
  } catch (_) { /* marker is diagnostic; the validated copy remains usable */ }
}

function stageBundledRuntime({ source, dataDir, platform = process.platform } = {}) {
  const sourceRoot = path.resolve(String(source || ''));
  const dataRoot = path.resolve(String(dataDir || ''));
  if (!sourceRoot || !dataRoot) throw new Error('缺少运行时暂存路径');
  if (!isCompleteRuntime(sourceRoot, { platform })) {
    const error = new Error('内置运行时不完整，无法暂存；将回退到在线部署');
    error.code = 'RUNTIME_BUNDLE_INCOMPLETE';
    throw error;
  }
  const stageBase = path.join(dataRoot, STAGE_DIR);
  try { fs.mkdirSync(dataRoot, { recursive: true }); } catch (_) { /* reported by the probe below */ }
  if (!canWriteDirectory(dataRoot)) {
    const error = new Error(`运行时暂存目录不可写：${dataRoot}`);
    error.code = 'RUNTIME_STAGING_NOT_WRITABLE';
    throw error;
  }
  const fingerprint = runtimeFingerprint(sourceRoot);
  const finalRoot = path.join(stageBase, fingerprint);
  if (inside(sourceRoot, finalRoot) || inside(finalRoot, sourceRoot)) {
    const error = new Error('运行时暂存目标不能与内置运行时重叠');
    error.code = 'RUNTIME_STAGING_OVERLAP';
    throw error;
  }
  if (isCompleteRuntime(finalRoot, { platform })) return { ok: true, root: finalRoot, fingerprint, reused: true };

  const bytes = directoryBytes(sourceRoot);
  const free = freeBytes(stageBase);
  const required = Math.ceil(bytes * 1.05) + EXTRA_SPACE;
  if (free != null && free < required) {
    const error = new Error(`运行时暂存需要约 ${Math.ceil(required / 1048576)} MB，可用空间仅 ${Math.floor(free / 1048576)} MB`);
    error.code = 'RUNTIME_STAGING_NO_SPACE';
    throw error;
  }

  fs.mkdirSync(stageBase, { recursive: true });
  const partRoot = `${finalRoot}.part-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(sourceRoot, partRoot, { recursive: true, force: false, errorOnExist: false, dereference: false, preserveTimestamps: true });
    if (!isCompleteRuntime(partRoot, { platform })) {
      const error = new Error('内置运行时复制不完整，未切换到暂存副本');
      error.code = 'RUNTIME_STAGING_INCOMPLETE';
      throw error;
    }
    writeMarker(partRoot, sourceRoot, fingerprint, bytes);
    fs.renameSync(partRoot, finalRoot);
    return { ok: true, root: finalRoot, fingerprint, reused: false };
  } catch (error) {
    try { fs.rmSync(partRoot, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* keep original error */ }
    throw error;
  }
}

module.exports = {
  STAGE_DIR,
  isWindowsAppsPath,
  isCompleteRuntime,
  canWriteDirectory,
  freeBytes,
  directoryBytes,
  runtimeFingerprint,
  stageBundledRuntime,
};

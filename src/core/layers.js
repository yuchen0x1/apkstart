'use strict';
/**
 * 容器式分层：只读基础镜像 + 精简运行时 + 可回收的临时层
 *
 * 比喻（和 Docker 一样）：
 *   system-images/  = 只读 base layer，所有应用、所有会话共享一份，绝不复制
 *   avd/*.avd/      = 可写 thin layer（qcow2 差量 + quickboot 快照），只存改动
 *   snapshots       = 可回收的 scratch layer（_tmp 也供在线下载使用，不能当缓存回收）
 *
 * 本模块只做「盘点」与「按明确清单回收」，默认 dryRun，不碰用户个人文件。
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isSymbolicLink()) continue;
    if (it.isDirectory()) walk(p, out, depth + 1);
    else if (it.isFile()) {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const realPath = (p) => { try { return fs.realpathSync(p); } catch (_) { return ''; } };
const isInside = (rel) => rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);

// A GC candidate must be the actual entry beneath this root, not an alias via a junction.
function isManagedEntry(root, candidate) {
  const rel = path.relative(root, candidate);
  if (!rel || !isInside(rel)) return false;
  try {
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(candidate).isSymbolicLink()) return false;
  } catch (_) { return false; }
  const base = realPath(root);
  const real = realPath(candidate);
  return !!base && !!real && path.relative(path.join(base, rel), real) === '';
}

function protectsPath(candidate, protectedPaths = []) {
  const real = realPath(candidate);
  return protectedPaths.some((p) => {
    if (!p || typeof p !== 'string') return false;
    const target = realPath(p);
    return isInside(path.relative(candidate, p)) || (!!real && !!target && isInside(path.relative(real, target)));
  });
}

/**
 * 归本程序管理的 AVD。内置三档各自隔离，再加自定义镜像：
 *   apkstart.avd            —— Google Play（默认）
 *   apkstart-aosp.avd       —— 纯 AOSP 实验档
 *   apkstart-googleapis.avd —— Google APIs
 *   apkstart-custom.avd     —— 自定义镜像
 * 这些都是持久用户数据。名单之外的 AVD 归属未知，同样不能整目录回收；
 * 名字看起来像旧版本，也不代表其中 userdata 是可再生缓存。
 */
const MANAGED_AVDS = [
  'apkstart-googleapis.avd', 'apkstart-aosp.avd', 'apkstart.avd', 'apkstart-custom.avd',
];

// Only names emitted by the Android Emulator in its own AVD; a suffix alone is not ownership.
const AVD_LOCKS = new Set(['multiinstance.lock', 'hardware-qemu.ini.lock', 'snapshot.lock', 'userdata-qemu.img.lock']);

/** 盘点运行时占用，并列出有明确归属且可再生的候选。 */
function analyze(root, {
  avdHome = path.join(root, 'avd'), keepAvd = 'apkstart.avd',
  aggressive = false, keepSnapshots = false, locksOnly = false, protectedPaths = [],
} = {}) {
  const groups = [];
  const candidates = [];
  const groupOf = (name, dir) => groups.push({ name, size: dirSize(dir) });
  const add = (base, p, reason, type, category) => {
    if (!isManagedEntry(base, p) || protectsPath(p, protectedPaths)) return;
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st || (type === 'dir' ? !st.isDirectory() : type === 'file' ? !st.isFile() : !st.isDirectory() && !st.isFile())) return;
    candidates.push({ path: p, size: st.isDirectory() ? dirSize(p) : st.size, reason,
      kind: st.isDirectory() ? 'dir' : 'file', category });
  };

  groupOf('emulator 引擎', path.join(root, 'emulator'));
  groupOf('QEMU ISO / 虚拟磁盘', path.join(root, 'images'));
  groupOf('系统镜像（只读基础层）', path.join(root, 'system-images'));
  groupOf('AVD 可写层 / 快照', avdHome);
  groupOf('platform-tools', path.join(root, 'platform-tools'));
  groupOf('组件下载 / 解压工作区（仅盘点）', path.join(root, '_tmp'));

  if (!locksOnly) {
    const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
    for (const arch of ['aarch64', 'armel', 'i386']) {
      add(root, path.join(qemuDir, `qemu-system-${arch}.exe`), '运行时用不到的非 x86_64 QEMU 目标', 'file', 'component');
    }
    const docs = path.join(root, 'system-images');
    for (const f of walk(docs)) {
      // source.properties describes the installed package and is not scratch space.
      if (/^NOTICE\.txt$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) add(root, f.path, '镜像包内的大体积说明文件', 'file', 'component');
    }
    if (aggressive) {
      // Qt/DLL, qsn and netsim are runtime dependencies, not optional extras.
      add(root, path.join(root, 'emulator', 'crashreport.exe'), '崩溃上报工具（无头运行不需要）', 'file', 'component');
    }
  }

  // Only the current managed AVD can be pruned. AVD directories themselves, old base
  // images, root-level directories and the shared download workspace are never candidates.
  if (MANAGED_AVDS.includes(keepAvd)) {
    const activeAvd = path.join(avdHome, keepAvd);
    const st = fs.lstatSync(activeAvd, { throwIfNoEntry: false });
    if (st && st.isDirectory() && isManagedEntry(avdHome, activeAvd)) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        const p = path.join(activeAvd, e.name);
        if (AVD_LOCKS.has(e.name.toLowerCase())) add(avdHome, p, '当前 AVD 的残留锁文件', 'either', 'lock');
        else if (!locksOnly && !keepSnapshots && e.isDirectory() && /^snapshots(\.stale-\d+)?$/.test(e.name)) {
          add(avdHome, p, '当前 AVD 的 quickboot 快照（可重建）', 'dir', 'snapshot');
        }
      }
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * 回收。必须显式传 apply:true；调用方（UI/构建脚本）负责先展示清单并取得确认。
 * 安全约束：任何目标都必须在 root 之内，且不允许把 root 自身删掉。
 */
function prune(root, {
  apply = false, avdHome = path.join(root, 'avd'), keepAvd, aggressive = false, keepSnapshots = false, locksOnly = false, protectedPaths = [], onRemove = () => {},
} = {}) {
  const report = analyze(root, { avdHome, keepAvd, aggressive, keepSnapshots, locksOnly, protectedPaths });
  const removed = [];
  let saved = 0;
  if (apply) {
    for (const c of report.candidates) {
      const p = path.resolve(c.path);
      const base = c.category === 'component' ? root : avdHome;
      if (!isManagedEntry(base, p) || protectsPath(p, protectedPaths)) continue;
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* 占用中的文件跳过，下次再清 */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** 给设置页用的简短摘要 */
function summary(root, opts = {}) {
  const a = analyze(root, opts);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // 除了运行时目录，用户最关心「这东西一共占了我多少盘」：
  // AVD（应用数据 + 快照）、APK 缓存、图标、日志都算进来。
  const store = require('./store');
  const extra = [
    { key: 'avd', label: '安卓数据（应用 + 快照）', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'APK 安装包缓存', path: store.APK_DIR },
    { key: 'icons', label: '桌面图标缓存', path: store.ICON_DIR },
    { key: 'logs', label: '日志', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: '运行时（引擎 + 系统镜像）', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize, MANAGED_AVDS, isManagedEntry, protectsPath };

'use strict';
/**
 * 应用备份 / 恢复
 *
 * 能做什么、不能做什么，这里先说清楚（不装样子）：
 *   - APK 本体：一定可以导出。安装时本来就留了一份在本机，直接复制即可。
 *   - 应用私有数据（/data/data/<pkg>）：只有 **debuggable** 的应用能通过
 *     `run-as` 读出。普通应用（微信、游戏）没有 root 就拿不到，这是 Android
 *     的权限设计，不是本工具的缺陷 —— 所以这种情况会明说「数据未导出」，
 *     绝不生成一个空 tar 冒充备份成功。
 *
 * 备份目录结构：
 *   <目标目录>/<应用名>-<版本>-<时间戳>/
 *       app.apk           原始安装包
 *       meta.json         包名/版本/时间/数据是否包含
 *       data.tar          仅 debuggable 应用才有
 *       data-skip.txt     数据未能导出时的原因说明
 */
const fs = require('fs');
const path = require('path');
const { parseApk } = require('./apk');

const PACKAGE_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;

/** 当前备份格式只使用固定文件名，且文件的真实路径必须仍在备份根内。 */
function backupFile(dir, name, expected, { optional = false } = {}) {
  if (name !== expected) throw new Error(`备份路径不安全：${expected} 必须使用固定相对路径`);
  const root = fs.realpathSync(dir);
  const file = path.join(root, expected);
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    if (optional && e.code === 'ENOENT') return '';
    throw new Error(`备份里缺少 ${expected}`);
  }
  const real = fs.realpathSync(file);
  const rel = path.relative(root, real);
  if (st.isSymbolicLink() || !st.isFile() || !rel || rel === '..'
    || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`备份文件越界或包含符号链接：${expected}`);
  }
  return file;
}

/** Windows / POSIX 都不合法的字符，统一换成下划线 */
function sanitizeName(s, max = 60) {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (out || 'app').slice(0, max);
}

function two(n) { return String(n).padStart(2, '0'); }

/** 20261115-033012 */
function stamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-`
    + `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** 备份文件夹名：应用名-版本-时间戳 */
function folderName(app, d = new Date()) {
  const label = sanitizeName((app && app.label) || (app && app.package) || 'app', 40);
  const ver = sanitizeName((app && app.versionName) || '1.0', 20);
  return `${label}-${ver}-${stamp(d)}`;
}

/** 设备端 shell 单引号转义 */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function writeMeta(dir, meta) {
  const file = path.join(dir, 'meta.json');
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), 'utf8');
  return file;
}

function readMeta(dir) {
  const file = backupFile(dir, 'meta.json', 'meta.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!meta || typeof meta.package !== 'string' || !PACKAGE_RE.test(meta.package)) {
    throw new Error('备份信息不完整（缺少合法的 package）');
  }
  return meta;
}

/**
 * 这个应用的数据能不能读出来（只有 debuggable 可以）。
 * @returns {Promise<{ok:boolean, note:string}>}
 */
async function canReadData(client, pkg) {
  try {
    const out = await client.shell(`run-as ${shq(pkg)} id`, { timeout: 15000 });
    if (/uid=\d+/.test(String(out))) return { ok: true, note: '' };
  } catch (_) { /* 下面统一返回原因 */ }
  return {
    ok: false,
    note: '该应用不是 debuggable 应用，Android 不允许非 root 环境读取它的私有数据。'
      + '备份里只包含 APK，重装后应用数据不会恢复。',
  };
}

/**
 * 把一个应用备份到 dir 下的新文件夹。
 * @param {{app:object, client:object, dir:string, onLog?:Function}} opts
 */
async function backupApp({ app, client, dir, onLog = () => {} }) {
  if (!app || !app.package) throw new Error('缺少应用信息');
  if (!dir) throw new Error('没有指定备份目录');
  const apkSrc = app.apkPath;
  if (!apkSrc || !fs.existsSync(apkSrc)) {
    throw new Error('找不到这个应用的安装包（可能安装后被清理过），无法备份');
  }

  const folder = path.join(dir, folderName(app));
  fs.mkdirSync(folder, { recursive: true });

  const apkOut = path.join(folder, 'app.apk');
  fs.copyFileSync(apkSrc, apkOut);
  onLog(`已复制 APK（${(fs.statSync(apkOut).size / 1048576).toFixed(1)} MB）`);

  const meta = {
    format: 'apkstart-backup/1',
    package: app.package,
    label: app.label || app.package,
    versionName: app.versionName || '',
    versionCode: app.versionCode || 0,
    apk: 'app.apk',
    data: null,
    dataNote: '',
    createdAt: Date.now(),
  };

  let dataFile = null;
  if (client) {
    const { ok, note } = await canReadData(client, app.package);
    if (ok) {
      onLog('应用允许 run-as，正在导出私有数据…');
      try {
        const { stdout } = await client.exec(
          ['exec-out', `run-as ${shq(app.package)} tar -cf - .`],
          { binary: true, timeout: 180000 },
        );
        // tar 至少要有 1KB 才算拿到了东西（空 tar 是 1024 字节的结束块）
        if (!stdout || stdout.length <= 1024) throw new Error('导出的数据是空的');
        dataFile = path.join(folder, 'data.tar');
        fs.writeFileSync(dataFile, stdout);
        meta.data = 'data.tar';
        onLog(`已导出应用数据（${(stdout.length / 1048576).toFixed(1)} MB）`);
      } catch (e) {
        meta.dataNote = `应用数据导出失败：${e.message}`;
        fs.writeFileSync(path.join(folder, 'data-skip.txt'), meta.dataNote, 'utf8');
      }
    } else {
      meta.dataNote = note;
      fs.writeFileSync(path.join(folder, 'data-skip.txt'), note, 'utf8');
    }
  }

  writeMeta(folder, meta);
  return { folder, meta, dataIncluded: !!dataFile, dataNote: meta.dataNote };
}

/**
 * 从备份目录恢复：先把 APK 装回去，再尝试还原数据。
 * 数据还原要求「备份里有 data.tar」且「目标应用现在仍然可 run-as」。
 */
async function restoreApp({ dir, installer, client, onLog = () => {} }) {
  const meta = readMeta(dir);
  const apk = backupFile(dir, meta.apk == null || meta.apk === '' ? 'app.apk' : meta.apk, 'app.apk');
  // 所有路径与包名检查必须在安装及任何设备数据操作前完成。
  const tar = meta.data == null ? '' : backupFile(dir, meta.data, 'data.tar', { optional: true });
  const parsed = parseApk(apk);
  if (parsed.package !== meta.package) throw new Error('备份 APK 包名与 meta.package 不一致，已拒绝恢复');

  onLog('正在重新安装应用…');
  const r = await installer.install(apk, (p) => { if (p && p.message) onLog(p.message); });
  if (!r || !r.app || r.app.package !== meta.package) {
    throw new Error('安装结果包名与备份不一致，已停止恢复数据');
  }

  if (!tar) {
    return {
      app: r.app || null,
      dataRestored: false,
      note: meta.dataNote || '这个备份只包含 APK，没有应用数据。',
    };
  }

  const { ok, note } = await canReadData(client, meta.package);
  if (!ok) {
    return { app: r.app || null, dataRestored: false, note: `备份里有数据，但${note}` };
  }

  onLog('正在还原应用数据…');
  const remote = `/data/local/tmp/apkstart-restore-${Date.now()}.tar`;
  await client.push(tar, remote);
  try {
    // shell 里 cat 用 shell 身份读文件、管道喂给 run-as（app 身份），
    // 这样既不用 root，也不需要给 /data/local/tmp 放宽权限。
    await client.exec(['exec-out', `cat ${shq(remote)} | run-as ${shq(meta.package)} tar -xf -`], {
      binary: true, timeout: 180000,
    });
  } finally {
    await client.shell(`rm -f ${shq(remote)}`).catch(() => {});
  }
  return { app: r.app || null, dataRestored: true, note: '应用与数据均已恢复。' };
}

module.exports = {
  sanitizeName,
  stamp,
  folderName,
  writeMeta,
  readMeta,
  canReadData,
  backupApp,
  restoreApp,
};

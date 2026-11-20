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
const crypto = require('crypto');
const { parseApk } = require('./apk');
const { isBundle, parseBundle } = require('./apk-bundle');

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

  // 旧安装记录的 bundle 标记比 .apk 缓存后缀更可信；仍先完整解析容器，
  // 因此陈旧/错误标记不会把普通 APK 当成 split，也不会复制损坏的 bundle。
  let split = false;
  if (app.bundle === true) {
    const parsedBundle = await parseBundle(apkSrc);
    try { split = true; } finally { parsedBundle.cleanup(); }
  } else {
    split = isBundle(apkSrc);
  }
  const apkName = split ? 'app.apks' : 'app.apk';
  fs.mkdirSync(dir, { recursive: true });
  const name = folderName(app);
  let folder = '';
  // 秒级时间戳可能碰撞；原子创建新目录，绝不复用/覆盖旧备份。
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, name + (i ? `-${i}` : ''));
    try { fs.mkdirSync(candidate); folder = candidate; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!folder) throw new Error('备份目录重名过多，请选择其他目标目录');

  const apkOut = path.join(folder, apkName);
  fs.copyFileSync(apkSrc, apkOut, fs.constants.COPYFILE_EXCL);
  onLog(`已复制 APK（${(fs.statSync(apkOut).size / 1048576).toFixed(1)} MB）`);

  const meta = {
    format: 'apkstart-backup/1',
    package: app.package,
    label: app.label || app.package,
    versionName: app.versionName || '',
    versionCode: app.versionCode || 0,
    apk: apkName,
    bundle: split,
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
async function restoreApp({ dir, installer, onLog = () => {} }) {
  const meta = readMeta(dir);
  const name = meta.apk == null || meta.apk === '' ? 'app.apk' : meta.apk;
  if (!['app.apk', 'app.apks', 'app.xapk'].includes(name)) throw new Error('备份路径不安全：安装包必须使用固定相对路径');
  const apk = backupFile(dir, name, name);
  // 所有路径与包名检查必须在安装及任何设备数据操作前完成。
  const tar = meta.data == null ? '' : backupFile(dir, meta.data, 'data.tar', { optional: true });
  // 新备份的 bundle 标记（以及旧安装记录导出的标记）优先于 .apk 名称；
  // 但无论标记来自哪里都必须由真实 ZIP/base 清单验证，普通 APK 不会被拆分。
  let split = meta.bundle === true;
  let parsed;
  if (split) {
    const bundle = await parseBundle(apk);
    try { parsed = bundle.meta; } finally { bundle.cleanup(); }
  } else {
    split = isBundle(apk);
    if (split) {
      const bundle = await parseBundle(apk);
      try { parsed = bundle.meta; } finally { bundle.cleanup(); }
    } else parsed = parseApk(apk);
  }
  if (parsed.package !== meta.package) throw new Error('备份 APK 包名与 meta.package 不一致，已拒绝恢复');

  onLog('正在重新安装应用…');
  // kind 覆盖仅用于兼容旧版将容器命名为 app.apk 的备份；不更改原备份文件。
  const r = await installer.install(apk, (p) => { if (p && p.message) onLog(p.message); }, {
    kind: split ? 'apks' : 'apk', includeClient: !!tar,
  });
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

  // 只能向本次安装真正选中的实例还原，不能重取 runtime.client() 或信任调用前的 client。
  const client = r.client;
  if (!client || typeof client.shell !== 'function' || typeof client.push !== 'function' || typeof client.exec !== 'function') {
    throw new Error('安装器未返回本次安装使用的设备实例，已停止恢复数据');
  }
  const { ok, note } = await canReadData(client, meta.package);
  if (!ok) {
    return { app: r.app || null, dataRestored: false, note: `备份里有数据，但${note}` };
  }

  onLog('正在还原应用数据…');
  const remote = `/data/local/tmp/apkstart-restore-${crypto.randomBytes(16).toString('hex')}.tar`;
  try {
    await client.push(tar, remote);
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

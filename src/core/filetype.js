'use strict';
/**
 * 安装包文件类型判定（主进程 / 安装器 / 界面共用一套规则）
 *
 * 标准后缀只有三种：.apk / .xapk / .apks。
 * 但用户真正拿到的文件名经常带着下载工具留下的尾巴：
 *   QQ、微信、迅雷、各种浏览器会把下载中的文件存成 a.apk.1 / a.apk.tmp /
 *   a.apk.crdownload，下载完成后有的会改回 .apk，有的（被安全软件、多线程下载、
 *   同名文件已存在时）就一直留着。
 * 以前这里只做 /\.apk$/ 匹配，用户把 a.apk.1 拖进窗口，直接被判成「不是 APK」，
 * 于是有了「后缀其实是 .apk.1，只不过你这个不支持 .1」这种反馈。
 *
 * 所以规则改成：先剥掉末尾的临时后缀，再看真正的扩展名。
 */

/** 认得的安装包扩展名（不带点，小写） */
const INSTALL_EXTS = ['apk', 'xapk', 'apks'];

/** 下载器 / 浏览器常用的临时后缀（小写、不带点）。'bc!'、'!ut' 是迅雷/比特彗星的 */
const TEMP_TAILS = new Set([
  'tmp', 'temp', 'part', 'partial', 'download', 'downloading',
  'crdownload', 'filepart', 'opdownload', 'bc!', '!ut', 'td', 'xltd',
]);

/** 同名冲突时的数字后缀：a.apk → a.apk.1 → a.apk.2（QQ / 迅雷 / 部分浏览器） */
const NUMERIC_TAIL = /^\d{1,3}$/;

/** 取路径里的文件名部分，同时兼容 Windows 反斜杠与 posix 斜杠 */
function basenameOf(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 去掉文件名末尾的临时后缀。
 * 'a.apk.1' → 'a.apk'；'a.apk.1.tmp' → 'a.apk'；'a.apk' 原样返回。
 */
function stripTempSuffix(name) {
  let s = String(name || '');
  // 最多剥 3 层：apk.1.tmp / apk.crdownload 这类组合足够，
  // 再多基本是用户自己起的怪名字，不该继续猜下去。
  for (let i = 0; i < 3; i += 1) {
    const dot = s.lastIndexOf('.');
    if (dot <= 0 || dot === s.length - 1) break;
    const tail = s.slice(dot + 1).toLowerCase();
    if (!TEMP_TAILS.has(tail) && !NUMERIC_TAIL.test(tail)) break;
    s = s.slice(0, dot);
  }
  return s;
}

/** 真正的扩展名（小写、带点，已剥掉临时后缀）；没有扩展名时返回 '' */
function extOf(filePath) {
  const name = stripTempSuffix(basenameOf(filePath));
  const dot = name.lastIndexOf('.');
  // dot === 0 是 '.apk' 这种隐藏文件式命名，不算扩展名
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** 'apk' | 'xapk' | 'apks' | '' —— 只认这三类安装包 */
function installKind(filePath) {
  const ext = extOf(filePath).slice(1);
  return INSTALL_EXTS.includes(ext) ? ext : '';
}

/** 能当成安装包处理（含 .apk.1 这类下载残留后缀） */
function isInstallable(filePath) {
  return !!installKind(filePath);
}

/** 单文件 APK；.xapk / .apks 是拆分包，走另一条安装路径 */
function isSingleApk(filePath) {
  return installKind(filePath) === 'apk';
}

/** 展示用文件名：去掉临时后缀，避免界面上出现「抖音.apk.1」 */
function displayName(filePath) {
  const base = basenameOf(filePath);
  return stripTempSuffix(base);
}

module.exports = {
  INSTALL_EXTS,
  stripTempSuffix,
  extOf,
  installKind,
  isInstallable,
  isSingleApk,
  displayName,
};

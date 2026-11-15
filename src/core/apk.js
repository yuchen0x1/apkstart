'use strict';
/**
 * APK 元信息提取：包名 / 版本 / 应用名 / 启动 Activity / 图标 / ABI
 * 全部离线完成，不需要 aapt、不需要 adb、不需要联网。
 */
const fs = require('fs');
const { ZipFile } = require('./zip');
const { parseAxml, attr, attrValue, children } = require('./axml');
const { ResTable } = require('./arsc');

const LAUNCHER_ACTIONS = ['android.intent.action.MAIN'];
const LAUNCHER_CATS = ['android.intent.category.LAUNCHER'];
/**
 * 合法包名：字母/数字/下划线的段，至少两段，段间用点分隔。
 * 这道校验是安全闸门：包名会被拼进本机文件路径（图标、APK 备份）与设备端
 * shell 命令，不校验的话，一个 `..\..\..\` 构造的 manifest 就能任意写文件。
 * 比规范更宽（允许段首是数字）是因为个别真机 APK 就是这么签的；
 * 关键是它排除了斜杠、反斜杠与空段（`..` 无法通过）。
 */
const PKG_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

function isLauncherActivity(node) {
  const filters = children(node, 'intent-filter');
  for (const f of filters) {
    const actions = children(f, 'action').map((a) => attrValue(a, 'name'));
    const cats = children(f, 'category').map((c) => attrValue(c, 'name'));
    const hasMain = actions.some((a) => LAUNCHER_ACTIONS.includes(a));
    const hasLauncher = cats.some((c) => LAUNCHER_CATS.includes(c));
    if (hasMain && hasLauncher) return true;
  }
  return false;
}

function pickIconFromZip(zip) {
  // 兜底：在 res/ 里找最大的、名字像图标的位图（png / webp / jpg 都认）
  const candidates = zip.names().filter((n) => /^res\/.*\.(png|webp|jpe?g)$/i.test(n));
  const scored = candidates.map((n) => {
    const e = zip.entries.get(n);
    let s = e.uncompSize;
    if (/ic_launcher|app_icon|ic_app/i.test(n)) s *= 6;
    if (/_round|_foreground|_background/i.test(n)) s *= 0.4;
    if (/xxxhdpi/i.test(n)) s *= 1.6;
    else if (/xxhdpi/i.test(n)) s *= 1.4;
    else if (/xhdpi/i.test(n)) s *= 1.2;
    return { n, s };
  }).sort((a, b) => b.s - a.s);
  for (const c of scored.slice(0, 30)) {
    try {
      const data = zip.read(c.n);
      if (data && data.length > 100) return { data, file: c.n };
    } catch (_) { /* ignore */ }
  }
  return null;
}

const IMG_RE = /\.(png|webp|jpe?g)$/i;

/** 取节点上的 drawable / src 引用，还原成 APK 内的文件路径 */
function drawableFileOf(node, res) {
  for (const name of ['drawable', 'src']) {
    const a = attr(node, name);
    if (!a) continue;
    if (a.refId && res) {
      const f = res.resolve(a.refId, 'file');
      if (f) return f;
    } else if (typeof a.typed === 'string') {
      return a.typed;
    }
  }
  return null;
}

/**
 * 在图标 XML 的节点树里找可用位图。深度优先、XML 最多再展开 3 层：
 * 现代图标常见 `<adaptive-icon><foreground><inset><drawable/></inset></foreground>`，
 * 或者 `<layer-list><item><bitmap android:src="@drawable/x"/></item></layer-list>`，
 * 只认一层属性会直接落到「品牌占位图」。
 */
function iconFromNode(zip, node, res, depth = 0) {
  const file = drawableFileOf(node, res);
  if (file) {
    if (IMG_RE.test(file) && zip.has(file)) {
      const data = zip.read(file);
      if (data && data.length > 100) return { data, file };
    }
    if (/\.xml$/i.test(file) && depth < 3 && zip.has(file)) {
      const inner = iconFromXml(zip, zip.read(file), res, depth + 1);
      if (inner) return inner;
    }
  }
  for (const c of node.children || []) {
    const hit = iconFromNode(zip, c, res, depth);
    if (hit) return hit;
  }
  return null;
}

/** 从自适应图标 / layer-list / vector 的 XML 里找出可用的图标 */
function iconFromXml(zip, xmlBuffer, res, depth = 0) {
  let root;
  try {
    root = parseAxml(xmlBuffer);
  } catch (_) {
    return null;
  }
  // 前景/背景都是矢量图的应用（抖音等）：整条链上没有任何位图可捡，
  // 转成 SVG 让渲染层显示（主进程无法栅格化矢量图，Chromium 可以）。
  if (root.name === 'vector') {
    const svg = vectorToSvg(root, res);
    if (svg) return { svg, file: null };
  }
  if (root.name === 'adaptive-icon') {
    const layers = [];
    for (const key of ['background', 'foreground']) {
      const node = root.children.find((c) => c.name === key);
      layers.push(node ? iconFromNode(zip, node, res, depth) : null);
    }
    if (layers.some(Boolean)) {
      const composed = composeAdaptiveIcon(layers);
      if (composed) return { svg: composed, file: null };
      const bmp = layers.find((l) => l && l.data);
      if (bmp) return bmp;
    }
    return null;
  }
  // 先按规范顺序找 foreground → background → monochrome
  for (const key of ['foreground', 'background', 'monochrome']) {
    const node = root.children.find((c) => c.name === key) || (root.name === key ? root : null);
    if (!node) continue;
    const hit = iconFromNode(zip, node, res, depth);
    if (hit) return hit;
  }
  // 再整棵树扫一遍（layer-list / bitmap / inset 这类没有固定子节点名的）
  return iconFromNode(zip, root, res, depth);
}

// ---- 矢量图（vector drawable）→ SVG ----
// 主进程没有栅格化能力，但 UI 跑在 Chromium 里，<img> 原生支持 SVG。
// 这里只转图标级别的常见子集：path / group(平移缩放旋转) / clip-path。

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function numAttrOf(node, name) {
  const a = attr(node, name);
  return a && typeof a.typed === 'number' ? a.typed : null;
}

/** 颜色属性（直接值 / arsc 引用）统一成 ARGB 整数 */
function colorAttrOf(node, res, name) {
  const a = attr(node, name);
  if (!a) return null;
  let v = null;
  if (a.refId && res) v = res.resolve(a.refId, 'any');
  else if (a.typed !== null && a.typed !== undefined) v = a.typed;
  if (typeof v === 'string') {
    const m = /^#([0-9a-fA-F]{3,8})$/.exec(v.trim());
    if (!m) return null;
    const h = m[1];
    if (h.length === 3) return (parseInt(h[0] + h[0] + h[1] + h[1] + h[2] + h[2], 16) | 0xff000000) >>> 0;
    if (h.length === 6) return (parseInt(h, 16) | 0xff000000) >>> 0;
    return parseInt(h, 16) >>> 0;
  }
  if (typeof v === 'number') return v >>> 0;
  return null;
}

function hexOf(argb) {
  return '#' + (argb & 0xffffff).toString(16).padStart(6, '0');
}

function svgPathEl(node, res) {
  const d = attrValue(node, 'pathData');
  if (!d) return '';
  const parts = [`d="${escXml(d)}"`];
  const fill = colorAttrOf(node, res, 'fillColor');
  if (fill !== null) {
    parts.push(`fill="${hexOf(fill)}"`);
    const alpha = ((fill >>> 24) & 0xff) / 255;
    const fillAlpha = numAttrOf(node, 'fillAlpha');
    const op = Math.min(1, (fillAlpha === null ? 1 : fillAlpha) * alpha);
    if (op < 0.999) parts.push(`fill-opacity="${op.toFixed(3)}"`);
  } else {
    parts.push('fill="none"');
  }
  const stroke = colorAttrOf(node, res, 'strokeColor');
  if (stroke !== null) {
    parts.push(`stroke="${hexOf(stroke)}"`);
    const strokeAlpha = numAttrOf(node, 'strokeAlpha');
    const sa = Math.min(1, (strokeAlpha === null ? 1 : strokeAlpha) * ((stroke >>> 24) & 0xff) / 255);
    if (sa < 0.999) parts.push(`stroke-opacity="${sa.toFixed(3)}"`);
    const sw = numAttrOf(node, 'strokeWidth');
    if (sw !== null) parts.push(`stroke-width="${sw}"`);
  }
  return `<path ${parts.join(' ')}/>`;
}

function svgGroupTransform(node) {
  const tx = numAttrOf(node, 'translateX') || 0;
  const ty = numAttrOf(node, 'translateY') || 0;
  const rot = numAttrOf(node, 'rotation') || 0;
  const px = numAttrOf(node, 'pivotX') || 0;
  const py = numAttrOf(node, 'pivotY') || 0;
  const sx = numAttrOf(node, 'scaleX');
  const sy = numAttrOf(node, 'scaleY');
  if (!tx && !ty && !rot && !px && !py && (sx === null || sx === 1) && (sy === null || sy === 1)) return '';
  const r = (n) => Number(n.toFixed(3));
  const parts = [`translate(${r(px + tx)} ${r(py + ty)})`];
  if (rot) parts.push(`rotate(${r(rot)})`);
  if ((sx !== null && sx !== 1) || (sy !== null && sy !== 1)) {
    parts.push(`scale(${r(sx === null ? 1 : sx)} ${r(sy === null ? 1 : sy)})`);
  }
  if (px || py) parts.push(`translate(${r(-px)} ${r(-py)})`);
  return ` transform="${parts.join(' ')}"`;
}

let clipSeq = 0;

/** 走一遍子节点；clip-path 生效于其后兄弟节点（与 Android 语义一致） */
function vectorChildrenToSvgEls(list, res, depth, defs) {
  const out = [];
  let clipId = null;
  let bucket = null;
  for (const c of list || []) {
    if (c.name === 'clip-path') {
      const d = attrValue(c, 'pathData');
      if (d && depth < 12) {
        const id = `apkclip${++clipSeq}`;
        defs.push(`<clipPath id="${id}"><path d="${escXml(d)}"/></clipPath>`);
        clipId = id;
        bucket = [];
      }
      continue;
    }
    const el = vectorNodeToSvgEl(c, res, depth + 1, defs);
    if (!el) continue;
    if (clipId && bucket) bucket.push(el);
    else out.push(el);
  }
  if (clipId && bucket && bucket.length) out.push(`<g clip-path="url(#${clipId})">${bucket.join('')}</g>`);
  return out.join('');
}

function vectorNodeToSvgEl(node, res, depth, defs) {
  if (!node || depth > 12) return '';
  if (node.name === 'path') return svgPathEl(node, res);
  if (node.name === 'group') {
    return `<g${svgGroupTransform(node)}>${vectorChildrenToSvgEls(node.children, res, depth, defs)}</g>`;
  }
  return '';
}

function vectorToSvg(root, res) {
  try {
    const vw = numAttrOf(root, 'viewportWidth');
    const vh = numAttrOf(root, 'viewportHeight');
    if (!vw || !vh || vw <= 0 || vh <= 0) return null;
    const defs = [];
    const inner = vectorChildrenToSvgEls(root.children, res, 0, defs);
    if (!inner) return null;
    const defStr = defs.length ? `<defs>${defs.join('')}</defs>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">${defStr}${inner}</svg>`;
  } catch (_) {
    return null;
  }
}

function sniffImageMime(data) {
  if (data.length > 4 && data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.length > 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 自适应图标两层合成：background 在下、foreground 在上，统一 108x108 视口 */
function composeAdaptiveIcon(layers, viewport = 108) {
  let inner = '';
  let ok = false;
  for (const hit of layers) {
    if (!hit) continue;
    if (hit.svg) {
      inner += hit.svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      ok = true;
    } else if (hit.data) {
      const mime = sniffImageMime(hit.data);
      if (!mime) continue;
      inner += `<image href="data:${mime};base64,${hit.data.toString('base64')}" x="0" y="0" width="${viewport}" height="${viewport}" preserveAspectRatio="none"/>`;
      ok = true;
    }
  }
  if (!ok) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport} ${viewport}" width="${viewport}" height="${viewport}">${inner}</svg>`;
}

/**
 * 解析一个 APK 的元信息。
 * 走文件版 ZIP 读取器（只读中央目录 + 按需读条目），因此**不把整个 APK 读进内存**：
 * 旧版 fs.readFileSync 整包读会让 2GB 以上的安装包直接失败（Node 单 Buffer 上限），
 * 低内存机器上大包也容易被 OOM 打断。
 */
function parseApk(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) throw new Error('文件过小，不是有效的 APK');
  const zip = new ZipFile(filePath);
  try {
    return parseApkZip(zip, filePath, stat);
  } finally {
    zip.close();
  }
}

/** parseApk 的主体：调用方负责关闭 zip */
function parseApkZip(zip, filePath, stat) {
  if (!zip.has('AndroidManifest.xml')) {
    throw new Error('缺少 AndroidManifest.xml：这不是单个 APK（可能是 .apks/.xapk 拆分包）');
  }

  const manifestBuf = zip.read('AndroidManifest.xml');
  const manifest = parseAxml(manifestBuf);

  // package 是 manifest 上的**非命名空间**属性（ns=''），必须按「任意命名空间」找：
  // attrValue 默认只认 android 命名空间，传 null 表示不限定命名空间。
  const packageName = attrValue(manifest, 'package', null);
  if (!packageName) throw new Error('清单中未找到 package 名');
  if (!PKG_RE.test(String(packageName))) {
    throw new Error(`APK 的包名不合法（含路径分隔符或非法字符），已拒绝安装：${String(packageName).slice(0, 80)}`);
  }

  const versionName = attrValue(manifest, 'versionName') || '1.0';
  const versionCodeRaw = attrValue(manifest, 'versionCode');
  const versionCode = typeof versionCodeRaw === 'number' ? versionCodeRaw : 0;

  const usesSdk = children(manifest, 'uses-sdk')[0];
  const minSdk = usesSdk ? (attrValue(usesSdk, 'minSdkVersion') | 0) : 0;
  const targetSdk = usesSdk ? (attrValue(usesSdk, 'targetSdkVersion') | 0) : 0;

  const app = children(manifest, 'application')[0] || { children: [], attrs: [] };

  // ---- 资源表（用于解析 @0x7f 引用）----
  let res = null;
  if (zip.has('resources.arsc')) {
    try { res = new ResTable(zip.read('resources.arsc')); } catch (_) { res = null; }
  }

  // ---- 应用名 ----
  let label = null;
  const labelAttr = attr(app, 'label');
  if (labelAttr) {
    if (labelAttr.refId && res) label = res.resolve(labelAttr.refId, 'string');
    else if (typeof labelAttr.typed === 'string') label = labelAttr.typed;
  }
  if (!label || typeof label !== 'string') {
    label = packageName.split('.').pop();
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ---- 启动 Activity ----
  let launchActivity = null;
  const acts = children(app, 'activity').concat(children(app, 'activity-alias'));
  const launcher = acts.find(isLauncherActivity);
  if (launcher) {
    const n = attrValue(launcher, 'name');
    const target = attrValue(launcher, 'targetActivity');
    if (n) {
      if (n.startsWith('.')) launchActivity = packageName + n;
      else if (!n.includes('.')) launchActivity = `${packageName}.${n}`;
      else launchActivity = n;
      if (launcher.name === 'activity-alias' && target) {
        launchActivity = target.startsWith('.') ? packageName + target : target;
      }
    }
  }

  // ---- 屏幕方向 ----
  // 模拟器的窗口比例由 hw.lcd.width/height 在**开机时**决定（wm size 只改逻辑分辨率，
  // 改不了 Qt 窗口比例），所以横屏应用要铺满窗口，必须在启动运行时之前就用横屏 LCD。
  // 这里把清单里的 screenOrientation 归一成 landscape / portrait / ''（未知）。
  // AXML 里的枚举属性通常是 TYPE_INT_DEC，也可能是字符串，两种都认。
  const ORIENT_INT = {
    1: 'landscape', 7: 'landscape', 9: 'landscape', 12: 'landscape',
    2: 'portrait', 8: 'portrait', 10: 'portrait', 13: 'portrait',
  };
  const ORIENT_STR = {
    landscape: 'landscape', sensorLandscape: 'landscape',
    reverseLandscape: 'landscape', userLandscape: 'landscape',
    portrait: 'portrait', sensorPortrait: 'portrait',
    reversePortrait: 'portrait', userPortrait: 'portrait',
  };
  const orientationOf = (node) => {
    if (!node) return '';
    const v = attrValue(node, 'screenOrientation');
    if (typeof v === 'number') return ORIENT_INT[v] || '';
    if (typeof v === 'string') return ORIENT_STR[v] || '';
    return '';
  };
  // 启动 Activity 优先；它没声明就看 <application>（游戏常把方向写在 application 上）
  const orientation = orientationOf(launcher) || orientationOf(app) || '';

  // ---- 图标 ----
  let icon = null;
  const iconAttr = attr(app, 'icon') || attr(app, 'roundIcon');
  if (iconAttr) {
    let file = null;
    if (iconAttr.refId && res) file = res.resolve(iconAttr.refId, 'file');
    else if (typeof iconAttr.typed === 'string') file = iconAttr.typed;

    if (file && zip.has(file)) {
      if (/\.xml$/i.test(file)) {
        icon = iconFromXml(zip, zip.read(file), res);
      } else {
        icon = { data: zip.read(file), file };
      }
    }
  }
  if (!icon) icon = pickIconFromZip(zip);

  // ---- ABI（判断 x86 运行时能否直接跑 ARM 原生库）----
  const abis = [...new Set(zip.names()
    .filter((n) => n.startsWith('lib/'))
    .map((n) => n.split('/')[1])
    .filter(Boolean))];

  // ---- 权限 / 硬件特性 / 依赖库（安装前兼容性分析要用）----
  const permissions = children(manifest, 'uses-permission')
    .concat(children(manifest, 'uses-permission-sdk-23'))
    .map((n) => attrValue(n, 'name', null))
    .filter((x) => typeof x === 'string' && x)
    .slice(0, 200);

  const features = children(manifest, 'uses-feature')
    .map((n) => ({
      name: attrValue(n, 'name', null) || '',
      // 没写 required 时默认是 true（Android 的规则）
      required: attrValue(n, 'required') !== false,
    }))
    .filter((f) => f.name);

  const usesLibraries = children(app, 'uses-library')
    .map((n) => ({
      name: attrValue(n, 'name', null) || '',
      required: attrValue(n, 'required') !== false,
    }))
    .filter((l) => l.name);

  // 拆分 APK：manifest 上有 split 属性，或属于 config.* 分片
  const splitName = attrValue(manifest, 'split', null) || (manifest && manifest.attrs
    ? (manifest.attrs.find((a) => a.name === 'split') || {}).typed : null);
  const isSplit = typeof splitName === 'string' ? !!splitName : false;

  const debuggable = attrValue(app, 'debuggable') === true || attrValue(app, 'debuggable') === 1;

  return {
    ok: true,
    filePath,
    sizeBytes: stat.size,
    package: packageName,
    label: String(label).replace(/\s+/g, ' ').trim().slice(0, 60),
    versionName: String(versionName),
    versionCode,
    minSdk,
    targetSdk,
    launchActivity,
    // 应用的自然方向：横屏游戏据此选择横屏 LCD，避免「画面居中一条 + 两侧黑边」
    orientation,
    abis,
    permissions,
    features,
    usesLibraries,
    isSplit,
    splitName: typeof splitName === 'string' ? splitName : '',
    debuggable,
    iconPng: icon && icon.data ? icon.data : null,
    iconFile: icon && icon.file ? icon.file : null,
    iconSvg: icon && icon.svg ? icon.svg : null,
  };
}

/** 轻量校验：只看头部是不是 PK\x03\x04 */
function quickCheck(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x50 && b[1] === 0x4b;
  } catch (_) {
    return false;
  }
}

module.exports = { parseApk, quickCheck, vectorToSvg, composeAdaptiveIcon };

'use strict';
/**
 * 自定义镜像体检（Image Inspector）
 *
 * 只读字节，绝不写/移动/删除任何文件。分成两层：
 *   1. 单个文件分类（classify*）：靠文件头判断「这到底是什么东西」；
 *   2. 目录体检（scanImageDir）：把 QEMU/emulator 真正需要的四件套找齐并逐个验。
 *
 * 为什么必须靠字节而不是靠文件名：用户从手机论坛下到的「MIUI 14 system.img」里，
 * boot.img（内核 + ramdisk 打成一个 Android boot image）、卡刷包的 system.new.dat.br、
 * 稀疏 ext4 分区镜像，全都叫 .img。只按后缀判断的话，最后一定会有人在 QEMU 里
 * 黑屏，然后来问「为什么 MIUI 接不进去」。这里把每种格式都认出来并给出人话原因。
 */

const fs = require('fs');
const path = require('path');

/**
 * 「下完了」的最低门槛。低于它的一律当成下载中断 / 占位文件。
 * 这几个数不是拍脑袋：Android 14 的 system.img 解压后 2.5~4GB，vendor 200~600MB，
 * 内核 10~30MB，ramdisk 3~8MB。取 1/20 作为「至少像那么回事」的下限。
 */
const MIN_SIZE = {
  system: 64 * 1024 * 1024,
  vendor: 4 * 1024 * 1024,
  kernel: 256 * 1024,
  ramdisk: 64 * 1024,
};

/** 引擎目录里内核的命名：x86_64 用 kernel-ranchu，32 位镜像用 kernel-ranchu-64 */
const KERNEL_NAMES = ['kernel-ranchu', 'kernel-ranchu-64', 'kernel'];
const RAMDISK_NAMES = ['ramdisk.img', 'ramdisk'];
/** 手机卡刷包的分区文件：出现它就说明拿错了东西 */
const PHONE_ONLY_FILES = ['system.new.dat', 'system.new.dat.br', 'system.transfer.list', 'boot.img', 'recovery.img'];
/** Android OTA / A-B 手机升级包的核心载荷文件 */
const OTA_ONLY_FILES = ['payload.bin', 'payload_properties.txt'];

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function exists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

/** 读文件的一段（失败返回空 Buffer，调用方按「读不到」处理） */
function readAt(file, offset, length) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return n === length ? buf : buf.subarray(0, n);
  } catch (_) {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

function isAndroidBoot(head) {
  return head.length >= 8 && head.toString('latin1', 0, 8) === 'ANDROID!';
}

/** Android OTA payload 的固定文件头：CrAU */
function isOtaPayload(file) {
  return readAt(file, 0, 4).toString('latin1') === 'CrAU';
}

/**
 * 内核分类。
 * emulator 只认 ranchu 虚拟平台的内核（ELF / gzip 压缩的 ELF / bzImage），
 * 手机内核虽然也是 Linux，但缺 goldfish/ranchu 的驱动和命令行，进不了桌面。
 */
function classifyKernel(file) {
  const size = sizeOf(file);
  if (!size) return { kind: 'missing', size: 0, ok: false, reason: '缺少内核文件（kernel-ranchu）' };
  const head = readAt(file, 0, 0x220);
  if (isAndroidBoot(head)) {
    return {
      kind: 'android-boot', size, ok: false,
      reason: '这是手机的 boot.img（内核和 ramdisk 打包在一起的 Android boot image），'
        + '模拟器不能用它引导 —— 它既不是 ranchu 内核，也拿不到独立的 ramdisk',
    };
  }
  if (head.length >= 4 && head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') {
    return { kind: 'elf', size, ok: true };
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return { kind: 'gzip', size, ok: true };
  }
  // Linux bzImage 的 "HdrS" 魔数固定在 0x202
  if (head.length >= 0x206 && head.toString('latin1', 0x202, 0x206) === 'HdrS') {
    return { kind: 'bzimage', size, ok: true };
  }
  return {
    kind: 'unknown', size, ok: false,
    reason: `内核文件头无法识别（${head.subarray(0, 4).toString('hex') || '空'}），`
      + '既不是 ELF / bzImage，也不是 gzip 压缩内核',
  };
}

/** ramdisk：emulator 认 gzip / lz4 / 未压缩的 cpio newc */
function classifyRamdisk(file) {
  const size = sizeOf(file);
  if (!size) return { kind: 'missing', size: 0, ok: false, reason: '缺少 ramdisk.img' };
  const head = readAt(file, 0, 512);
  if (isAndroidBoot(head)) {
    return { kind: 'android-boot', size, ok: false, reason: 'ramdisk.img 其实是 boot.img，模拟器需要独立的 ramdisk' };
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return { kind: 'gzip', size, ok: true };
  // Android Emulator images use both the standard LZ4 frame magic
  // (04 22 4D 18) and the legacy Android ramdisk frame magic
  // (02 21 4C 18). The bundled Android 14 Google Play image uses the
  // latter, so rejecting it would also reject a valid copy of our own
  // default runtime when imported as a custom image.
  if (head.length >= 4 && (
    head.readUInt32LE(0) === 0x184d2204
    || head.readUInt32LE(0) === 0x184c2102
  )) return { kind: 'lz4', size, ok: true };
  const magic6 = head.length >= 6 ? head.toString('latin1', 0, 6) : '';
  if (magic6 === '070701' || magic6 === '070707') return { kind: 'cpio', size, ok: true };
  return { kind: 'unknown', size, ok: false, reason: `ramdisk 文件头无法识别（${head.subarray(0, 4).toString('hex') || '空'}）` };
}

/**
 * 分区镜像分类：稀疏 ext4 / raw ext4 / qcow2 / vmdk 都算可用；
 * 手机 boot.img 与「读不出来」的明确拒绝。
 */
function classifyPartition(file, label) {
  const size = sizeOf(file);
  if (!size) return { kind: 'missing', size: 0, ok: false, reason: `缺少 ${label}` };
  const head = readAt(file, 0, 8);
  if (isAndroidBoot(head)) {
    return { kind: 'android-boot', size, ok: false, reason: `${label} 是一个 boot.img（内核镜像），不是分区镜像` };
  }
  if (head.length >= 4) {
    // Android sparse image（simg2img 的输入格式）
    if (head.readUInt32LE(0) === 0xed26ff3a) return { kind: 'sparse', size, ok: true };
    const m4 = head.toString('latin1', 0, 4);
    if (m4 === 'QFI\xfb') return { kind: 'qcow2', size, ok: true };
    if (m4 === 'KDMV') return { kind: 'vmdk', size, ok: true };
  }
  // raw ext4：超级块在 1024 字节处，magic 0xEF53 在 +0x38
  const sb = readAt(file, 0x438, 2);
  if (sb.length === 2 && sb.readUInt16LE(0) === 0xef53) return { kind: 'ext4', size, ok: true };
  // 认不出来但体积够大：当作 raw 镜像放行（部分自制镜像的超级块位置不规范）
  if (size >= MIN_SIZE.system) return { kind: 'raw', size, ok: true };
  return {
    kind: 'unknown', size, ok: false,
    reason: `${label} 不是可识别的文件系统镜像（${size ? `${(size / 1048576).toFixed(1)}MB` : '空文件'}）`,
  };
}

/** 目录里的文件名（小写 → 真实文件名），Windows 上大小写不敏感，这里统一处理 */
function nameMap(dir) {
  const map = new Map();
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return map; }
  for (const it of items) {
    if (it.isDirectory()) continue;
    map.set(it.name.toLowerCase(), it.name);
  }
  return map;
}

/** 按候选名顺序找第一个存在的文件，返回绝对路径或 '' */
function pickFile(dir, names, map = nameMap(dir)) {
  for (const n of names) {
    const hit = map.get(String(n).toLowerCase());
    if (hit) return path.join(dir, hit);
  }
  return '';
}

/**
 * 从目录内容推断 API / ABI / tag。
 * 优先级：source.properties → package.xml → 路径分段。
 * 三者都没有时才认不出来（那时 manifest 必须自己写清楚）。
 */
function inferMeta(dir) {
  const out = { api: 0, abi: '', tag: '', from: '' };
  const sp = pickFile(dir, ['source.properties', 'Source.properties']);
  if (sp) {
    let text = '';
    try { text = fs.readFileSync(sp, 'utf8'); } catch (_) { /* ignore */ }
    const get = (k) => {
      const m = new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'im').exec(text);
      return m ? m[1].trim() : '';
    };
    const api = get('AndroidVersion\\.ApiLevel') || get('SystemImage\\.ApiLevel');
    const abi = get('SystemImage\\.Abi') || get('Abi');
    const tag = get('SystemImage\\.TagId') || get('TagId');
    if (api) out.api = Number(api) || 0;
    if (abi) out.abi = abi;
    if (tag) out.tag = tag;
    if (out.api || out.abi || out.tag) out.from = 'source.properties';
  }
  const pkg = pickFile(dir, ['package.xml']);
  if (pkg && (!out.api || !out.abi || !out.tag)) {
    let text = '';
    try { text = fs.readFileSync(pkg, 'utf8'); } catch (_) { /* ignore */ }
    const grab = (tag) => {
      const m = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text);
      return m ? m[1].trim() : '';
    };
    if (!out.api) out.api = Number(grab('api-level')) || 0;
    if (!out.abi) out.abi = grab('abi');
    if (!out.tag) {
      const p = /<localPackage[^>]*path="([^"]+)"/.exec(text);
      if (p) {
        const seg = p[1].split(';');
        if (seg.length >= 3) out.tag = seg[2];
      }
    }
    if ((out.api || out.abi || out.tag) && !out.from) out.from = 'package.xml';
  }
  const norm = String(dir || '').replace(/\\/g, '/');
  const segs = norm.split('/').filter(Boolean);
  if (!out.abi) {
    const hit = segs.find((s) => /^(x86_64|x86|arm64-v8a|armeabi-v7a|arm64|armeabi)$/i.test(s));
    if (hit) { out.abi = hit; out.from = out.from || '路径'; }
  }
  if (!out.api) {
    const m = /android-(\d+)/i.exec(norm);
    if (m) { out.api = Number(m[1]); out.from = out.from || '路径'; }
  }
  if (!out.tag) {
    const i = segs.findIndex((s) => /^android-\d+$/i.test(s));
    if (i >= 0 && segs[i + 2]) { out.tag = segs[i + 1]; out.from = out.from || '路径'; }
  }
  out.abi = normalizeAbiName(out.abi);
  return out;
}

/** 把 arm64 / arm 之类的别名统一成 SDK 的 ABI 名 */
function normalizeAbiName(abi) {
  const s = String(abi || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'x86_64' || s === 'x64' || s === 'amd64') return 'x86_64';
  if (s === 'x86' || s === 'i386' || s === 'i686') return 'x86';
  if (s === 'arm64' || s === 'aarch64' || s === 'arm64-v8a') return 'arm64-v8a';
  if (s === 'arm' || s === 'armv7' || s === 'armeabi-v7a' || s === 'armeabi') return 'armeabi-v7a';
  return s;
}

/**
 * 目录级体检。
 * @param {string} dir 候选目录
 * @param {object} opts
 * @param {object} opts.minSize 覆盖体积门槛（单测用）
 * @param {object} opts.files   manifest 里显式指定的文件（相对路径或绝对路径）
 * @param {object} opts.meta    manifest 里声明的 api / abi（不覆盖推断，只用于提示差异）
 */
function scanImageDir(dir, opts = {}) {
  const minSize = { ...MIN_SIZE, ...(opts.minSize || {}) };
  const errors = [];
  const warnings = [];
  const map = nameMap(dir);

  if (!isDir(dir)) {
    return { ok: false, errors: ['选择的目录不存在或不是文件夹'], warnings, files: {}, meta: { api: 0, abi: '', tag: '' }, size: 0 };
  }

  const resolve = (declared, candidates) => {
    if (declared) {
      const p = path.isAbsolute(declared) ? declared : path.join(dir, declared);
      if (exists(p)) return p;
      errors.push(`清单里指定的 ${declared} 不存在`);
      return '';
    }
    return pickFile(dir, candidates, map);
  };
  const f = opts.files || {};
  const files = {
    system: resolve(f.system, ['system.img']),
    vendor: resolve(f.vendor, ['vendor.img']),
    kernel: resolve(f.kernel, KERNEL_NAMES),
    ramdisk: resolve(f.ramdisk, RAMDISK_NAMES),
    userdata: pickFile(dir, ['userdata.img'], map),
  };

  // 手机卡刷包特征文件：出现任意一个，基本可以确定拿错了
  const phoneFiles = PHONE_ONLY_FILES.filter((n) => map.has(n.toLowerCase()));
  const superImg = pickFile(dir, ['super.img'], map);
  const otaPayload = pickFile(dir, ['payload.bin'], map);
  const otaFiles = OTA_ONLY_FILES.filter((n) => map.has(n.toLowerCase()));
  const otaDetected = !!otaPayload && isOtaPayload(otaPayload);

  // 小米/Pixel 等手机的 A/B OTA 包。payload.bin 是 update_engine 的增量载荷，
  // 里面不是可直接挂给 QEMU 的 kernel-ranchu / ramdisk / 分区四件套。
  // 只有在缺少模拟器核心文件时才硬拒绝，避免用户把 payload.bin 作为附带文件放进
  // 一个本来完整的模拟器镜像目录时被误伤。
  if (otaDetected && (!files.system || !files.kernel || !files.ramdisk)) {
    errors.push('这是 Android OTA 手机升级包（payload.bin，CrAU），面向真实手机的 A/B 系统更新；'
      + '它不是可启动的 QEMU 模拟器系统镜像，不能直接接入 ApkStart。'
      + '请提供包含 system.img、vendor.img、kernel-ranchu、ramdisk.img 的 x86_64 模拟器镜像');
  }

  if (!files.system && (map.has('system.new.dat') || map.has('system.new.dat.br'))) {
    errors.push('这是手机卡刷包的 system.new.dat（还带 transfer.list），不能直接给模拟器用：'
      + '需要先用 simg2img / brotli 转换并重新打包成原始 system.img，而且手机固件本身也不是 ranchu 内核');
  }
  if (!files.system && superImg) {
    errors.push('只有 super.img（Android 动态分区超级镜像），没有独立的 system.img / vendor.img：'
      + '模拟器的 image.sysdir 需要分开的分区镜像，请先把它拆分成 system / vendor');
  }

  const part = {
    system: files.system ? classifyPartition(files.system, 'system.img') : { kind: 'missing', size: 0, ok: false, reason: '缺少 system.img' },
    vendor: files.vendor ? classifyPartition(files.vendor, 'vendor.img') : { kind: 'missing', size: 0, ok: false, reason: '缺少 vendor.img' },
    kernel: files.kernel ? classifyKernel(files.kernel) : { kind: 'missing', size: 0, ok: false, reason: '缺少内核文件（kernel-ranchu）' },
    ramdisk: files.ramdisk ? classifyRamdisk(files.ramdisk) : { kind: 'missing', size: 0, ok: false, reason: '缺少 ramdisk.img' },
  };

  const meta = inferMeta(dir);
  const api = Number((opts.meta && opts.meta.api) || meta.api) || 0;

  // ---- 硬性检查 ----
  for (const [key, label] of [['system', 'system.img'], ['kernel', 'kernel-ranchu'], ['ramdisk', 'ramdisk.img']]) {
    const info = part[key];
    if (!info.ok) errors.push(info.reason || `缺少 ${label}`);
    else if (info.size < (minSize[key] || 0)) {
      errors.push(`${label} 只有 ${(info.size / 1048576).toFixed(1)}MB，明显没下完或不是完整镜像`);
    }
  }
  // vendor：Android 8（Treble）以后是必需分区，缺了会卡在引导
  if (!part.vendor.ok) {
    const vendorRequired = api === 0 || api >= 26;
    if (vendorRequired) {
      errors.push(`${part.vendor.reason || '缺少 vendor.img'}：`
        + `Android ${api || '8'} 以后 system 与 vendor 必须分开，缺 vendor 会卡在开机动画`);
    } else {
      warnings.push('没有 vendor.img：这个版本的 Android 可以不用它，但兼容性未经验证');
    }
  } else if (part.vendor.size < (minSize.vendor || 0)) {
    warnings.push(`vendor.img 只有 ${(part.vendor.size / 1048576).toFixed(1)}MB，可能不完整`);
  }

  // ---- 提示性检查 ----
  if (part.kernel.ok && part.kernel.size < (minSize.kernel || 0)) {
    warnings.push(`内核只有 ${(part.kernel.size / 1048576).toFixed(1)}MB，偏小`);
  }
  if (part.ramdisk.ok && part.ramdisk.size < (minSize.ramdisk || 0)) {
    warnings.push(`ramdisk 只有 ${(part.ramdisk.size / 1048576).toFixed(1)}MB，偏小`);
  }
  if (!files.userdata) {
    // 不是问题：ApkStart 自己格式化 /data（见 emulator.ensureDataPartition）
    warnings.push('目录里没有 userdata.img：ApkStart 会自己创建数据分区，不影响使用');
  }
  if (phoneFiles.length && !errors.length) {
    warnings.push(`目录里还有手机固件文件（${phoneFiles.join('、')}），已忽略；只要四件套齐全就能用`);
  }
  if (opts.meta && opts.meta.api && meta.api && Number(opts.meta.api) !== meta.api) {
    warnings.push(`清单写的是 Android ${opts.meta.api}，目录里实际是 Android ${meta.api}，以清单为准`);
  }

  const total = Object.values(part).reduce((n, x) => n + (x.size || 0), 0) + (sizeOf(files.userdata) || 0);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    files: {
      system: { path: files.system, ...part.system },
      vendor: { path: files.vendor, ...part.vendor },
      kernel: { path: files.kernel, ...part.kernel },
      ramdisk: { path: files.ramdisk, ...part.ramdisk },
      userdata: files.userdata,
      super: superImg,
    },
    meta: { ...meta, api },
    size: total,
    phoneFiles,
    otaFiles,
    otaDetected,
  };
}

module.exports = {
  MIN_SIZE, KERNEL_NAMES, RAMDISK_NAMES, PHONE_ONLY_FILES, OTA_ONLY_FILES,
  sizeOf, isDir, exists, readAt,
  classifyKernel, classifyRamdisk, classifyPartition, isOtaPayload,
  inferMeta, normalizeAbiName, scanImageDir, nameMap, pickFile,
};

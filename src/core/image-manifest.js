'use strict';
/**
 * 自定义镜像清单（manifest）—— 唯一的「这个镜像是什么」的描述入口。
 *
 * 为什么要有清单，而不是让用户选个文件夹就算接入：
 *   模拟器能不能用一套镜像，取决于 **API 版本 / ABI / 机器类型 / 分区齐不齐**，
 *   这些信息从文件名里看不出来。清单把它们写死成可校验的字段，导入流程就变成
 *   「先读清单再验字节」，而不是「看着像 .img 就塞给 QEMU」。
 *
 * 清单文件名固定为 `apkstart-image.json`，与镜像文件放在同一个目录：
 *
 *   {
 *     "schema": 1,
 *     "id": "aosp-34-x86_64",              // 可选，默认由 name 生成
 *     "name": "AOSP 14 (x86_64)",
 *     "type": "emulator-system-image",     // 关键：手机固件不能填这个
 *     "api": 34,
 *     "abi": "x86_64",
 *     "tag": "google_apis_playstore",      // 可选
 *     "vendor": "Google",
 *     "source": { "kind": "local-dir", "path": "D:/images/aosp-34", "url": "", "license": "AOSP" },
 *     "googleServices": { "gms": true, "playStore": true },
 *     "armTranslation": { "enabled": true, "engine": "libndk" },
 *     "files": { "system": "system.img", "vendor": "vendor.img",
 *                "kernel": "kernel-ranchu", "ramdisk": "ramdisk.img" },
 *     "checksums": { "system.img": "sha256:....", "vendor.img": "sha1:...." },
 *     "qemu": { "machine": "ranchu", "minEmulator": "33.0.0" },
 *     "bootable": true,
 *     "notes": "自建镜像的说明"
 *   }
 */

const TYPE = {
  /** 合法的模拟器系统镜像（SDK system-images 那套布局） */
  EMULATOR: 'emulator-system-image',
  /** 手机线刷/卡刷包里的分区镜像 */
  PHONE_ROM: 'phone-rom',
  /** 第三方手机定制系统（MIUI / HyperOS / ColorOS …） */
  MIUI: 'miui-rom',
  /** recovery.img 一类的恢复系统 */
  RECOVERY: 'recovery-image',
  UNKNOWN: 'unknown',
};

const TYPE_ALIASES = {
  'emulator-system-image': TYPE.EMULATOR,
  'system-image': TYPE.EMULATOR,
  emulator: TYPE.EMULATOR,
  aosp: TYPE.EMULATOR,
  'phone-rom': TYPE.PHONE_ROM,
  phone: TYPE.PHONE_ROM,
  fastboot: TYPE.PHONE_ROM,
  'fastboot-rom': TYPE.PHONE_ROM,
  'miui-rom': TYPE.MIUI,
  miui: TYPE.MIUI,
  hyperos: TYPE.MIUI,
  'recovery-image': TYPE.RECOVERY,
  recovery: TYPE.RECOVERY,
};

/** ABI 支持度：x86_64 是唯一完整支持的；x86 能用但没验证；ARM 一律拒绝 */
const ABI_SUPPORT = {
  x86_64: { level: 'ok', note: '' },
  x86: { level: 'warn', note: '32 位 x86 镜像：能启动，但性能与兼容性都不如 x86_64，且未经验证' },
  'arm64-v8a': { level: 'deny', note: '' },
  'armeabi-v7a': { level: 'deny', note: '' },
};

/** 只支持 ranchu（emulator 的虚拟平台）；goldfish 太老，q35/virt 需要另一套引导 */
const MACHINES = ['ranchu', 'goldfish'];

const SCHEMA = 1;
const MANIFEST_NAME = 'apkstart-image.json';

const CJK = /[\u4e00-\u9fa5]/;

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max = 300) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

/** 目录名只能用安全字符：id 会拼进路径 */
function slug(v) {
  const s = str(v, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return s || 'custom-image';
}

function normalizeType(v) {
  const s = str(v, 60).toLowerCase();
  if (!s) return TYPE.UNKNOWN;
  return TYPE_ALIASES[s] || TYPE.UNKNOWN;
}

/** 校验值统一成 `algo:hex`，非法条目直接丢弃（不猜） */
function normalizeChecksums(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [file, v] of Object.entries(raw)) {
    const s = str(v, 200).toLowerCase();
    if (!s) continue;
    const m = /^(sha256|sha1|md5):([0-9a-f]+)$/.exec(s);
    if (!m) continue;
    const need = { sha256: 64, sha1: 40, md5: 32 }[m[1]];
    if (m[2].length !== need) continue;
    out[str(file, 120)] = `${m[1]}:${m[2]}`;
  }
  return out;
}

/** 清单归一化：只补默认值、只做类型转换，不判断「能不能用」（那是 validate 的事） */
function normalize(raw = {}, fallback = {}) {
  const r = isObj(raw) ? raw : {};
  const gs = isObj(r.googleServices) ? r.googleServices : {};
  const at = isObj(r.armTranslation) ? r.armTranslation : (r.armTranslation === true ? { enabled: true } : {});
  const qemu = isObj(r.qemu) ? r.qemu : {};
  const src = isObj(r.source) ? r.source : {};
  const files = isObj(r.files) ? r.files : {};
  const name = str(r.name || r.id || fallback.name || '自定义镜像', 120) || '自定义镜像';
  return {
    schema: SCHEMA,
    id: slug(r.id || fallback.id || name),
    name,
    // 没写 type 不等于「这是手机固件」：默认按模拟器镜像处理。
    // 真正拦住手机固件的是字节体检（见 image-inspect）与 _scan 里的目录特征判断，
    // 这里过度严格只会让「只想补个 api/abi 的清单」莫名其妙被拒。
    type: normalizeType(r.type || fallback.type || TYPE.EMULATOR),
    api: Number(r.api || fallback.api || 0) || 0,
    abi: str(r.abi || fallback.abi, 20).toLowerCase(),
    tag: str(r.tag || fallback.tag, 60),
    vendor: str(r.vendor, 60),
    source: {
      kind: str(src.kind, 40) || 'local-dir',
      path: str(src.path || src.dir, 500),
      url: str(src.url, 500),
      license: str(src.license, 120),
      note: str(src.note, 300),
    },
    googleServices: { gms: !!gs.gms, playStore: !!gs.playStore },
    armTranslation: {
      enabled: !!at.enabled,
      engine: str(at.engine, 60),
    },
    files: {
      system: str(files.system, 200),
      vendor: str(files.vendor, 200),
      kernel: str(files.kernel, 200),
      ramdisk: str(files.ramdisk, 200),
    },
    checksums: normalizeChecksums(r.checksums),
    qemu: {
      machine: str(qemu.machine, 40).toLowerCase() || 'ranchu',
      minEmulator: str(qemu.minEmulator, 40),
    },
    bootable: r.bootable !== false,
    notes: str(r.notes, 1000),
  };
}

/** 这套镜像「像不像 MIUI / 小米」—— 用于把人话原因说准 */
function looksMiui(m) {
  return /miui|hyperos|xiaomi|redmi|poco|小米|红米/i.test(`${m.name} ${m.vendor} ${m.id} ${m.notes}`);
}

/**
 * 为什么这个类型不能用 —— 每个原因都要能直接回答「那我该怎么办」。
 * MIUI 单独一段：这是用户最常尝试、也最容易以为「成功了」的情况。
 */
function explainType(m) {
  const miui = looksMiui(m);
  if (m.type === TYPE.EMULATOR) return '';
  const miuiTail = miui
    ? 'MIUI / HyperOS 是手机固件：小米只发布 arm64 机型的卡刷包与线刷包，'
      + '从来没有 x86_64 的模拟器系统镜像。把它塞进 QEMU 只会黑屏或卡在引导，'
      + '所以 ApkStart 不会把它标记成「已接入」。'
    : '';
  switch (m.type) {
    case TYPE.PHONE_ROM:
      return `这是手机固件（刷机包 / 分区镜像），不是模拟器系统镜像。${miuiTail}`
        + '手机固件用的是手机自己的内核与分区布局，emulator 需要的是 ranchu 内核 + system/vendor 分区 + 独立 ramdisk。'
        + '能用的替代方案：用 Android Studio 的 sdkmanager 下载 system-images（x86_64），或改用本项目默认的 Android 14 Google Play 镜像。';
    case TYPE.MIUI:
      return `MIUI 官方没有可用于 QEMU 的 x86_64 模拟器镜像，无法接入。${miuiTail}`
        + '想跑 MIUI 只能靠手机真机或云手机；本程序只支持 AOSP / Google Play 一类 x86_64 模拟器系统镜像。';
    case TYPE.RECOVERY:
      return 'recovery.img 是手机的恢复模式（recovery）镜像，不是可启动的系统镜像：'
        + '它没有安卓框架和桌面，模拟器加载它只会停在 recovery 界面。';
    default:
      return `清单里的 type 无法识别（${m.type}）：只接受 emulator-system-image（模拟器系统镜像）。`
        + '如果不确定，请直接指向 system-images/android-XX/<tag>/x86_64 这个目录，本程序会自动识别。';
  }
}

/**
 * 校验清单与机器环境的匹配度。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
function validate(m, ctx = {}) {
  const errors = [];
  const warnings = [];

  // 1) 类型：手机固件 / recovery 一律拒绝
  const typeWhy = explainType(m);
  if (typeWhy) errors.push(typeWhy);

  // 2) ABI：x86_64 才完整支持
  const abi = str(m.abi, 20);
  if (!abi) {
    errors.push('清单没有写 abi：无法确认这是 x86_64 镜像。'
      + '指到 system-images/android-XX/<tag>/x86_64 目录可由目录结构自动识别');
  } else {
    const sup = ABI_SUPPORT[abi];
    if (!sup) {
      errors.push(`不认识的 ABI「${abi}」：本程序只支持 x86_64（x86 32 位仅限试验）`);
    } else if (sup.level === 'deny') {
      errors.push(`ABI 是 ${abi}：Windows 上的 emulator 只有 x86_64 的加速能力，ARM 系统镜像起不来。`
        + '注意「ARM 转译」是在 x86_64 镜像里内置的转译层（libndk/libhoudini），不是加载 ARM 系统镜像');
    } else if (sup.level === 'warn') {
      warnings.push(sup.note);
    }
  }

  // 3) API
  if (!m.api) {
    errors.push('清单没有写 api（Android API 级别，例如 34）');
  } else if (m.api < 21 || m.api > 99) {
    errors.push(`api=${m.api} 不在支持范围（21~99）：Android 5.0 以前没有 x86_64 模拟器镜像`);
  }

  // 4) 机器类型
  if (!MACHINES.includes(m.qemu.machine)) {
    errors.push(`qemu.machine=${m.qemu.machine} 不支持：emulator 只用 ranchu（goldfish 为兼容保留）`);
  }

  // 5) 可启动标记
  if (m.bootable === false) {
    errors.push('清单里标了 bootable: false（镜像作者已声明不可启动），不能作为运行镜像');
  }

  // 6) 引擎版本下限
  if (m.qemu.minEmulator && ctx.emulatorVersion) {
    const need = String(m.qemu.minEmulator).split('.').map((n) => Number(n) || 0);
    const have = String(ctx.emulatorVersion).split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < 3; i += 1) {
      const a = need[i] || 0;
      const b = have[i] || 0;
      if (a === b) continue;
      if (a > b) warnings.push(`清单要求 emulator ≥ ${m.qemu.minEmulator}，当前是 ${ctx.emulatorVersion}`);
      break;
    }
  }

  // 7) 提示项
  if (!m.checksums || !Object.keys(m.checksums).length) {
    warnings.push('清单没有提供校验值：无法验证镜像是否被改坏，建议至少给 system.img 一个 sha256');
  }
  if (m.type === TYPE.EMULATOR && !m.googleServices.gms) {
    warnings.push('没有 Google 服务：依赖 GMS 的应用（地图、Play 商店内购等）会闪退');
  }
  if (m.armTranslation.enabled && !m.googleServices.gms) {
    warnings.push('声明了 ARM 转译但没有 Google 服务：部分国产应用依赖的转译层通常随 GMS 镜像一起提供');
  }

  // 8) 与当前机器环境（E2E 时才传 ctx）
  if (ctx.abi && abi && abi !== ctx.abi) {
    warnings.push(`清单 ABI 是 ${abi}，本机引擎默认按 ${ctx.abi} 配置`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 从目录内容「补全」清单里缺失的字段（api / abi / tag）。
 * 只补空的，绝不覆盖用户写明的值 —— 手写清单优先。
 */
function fillFromInference(m, inferred = {}) {
  const out = { ...m };
  if (!out.api && inferred.api) out.api = Number(inferred.api) || 0;
  if (!out.abi && inferred.abi) out.abi = str(inferred.abi, 20).toLowerCase();
  if (!out.tag && inferred.tag) out.tag = str(inferred.tag, 60);
  if (!out.googleServices.playStore && /playstore/i.test(out.tag)) {
    out.googleServices = { ...out.googleServices, playStore: true, gms: true };
  } else if (!out.googleServices.gms && /google_apis/i.test(out.tag)) {
    out.googleServices = { ...out.googleServices, gms: true };
  }
  return out;
}

/** emulator 的 tag.id 只能是它认识的几个值，自定义清单里的花名要落回合法值 */
function emulatorTag(m) {
  const t = str(m.tag, 60).toLowerCase();
  if (['google_apis', 'google_apis_playstore', 'default', 'aosp_atd', 'google_atd'].includes(t)) return t;
  if (m.googleServices.playStore) return 'google_apis_playstore';
  if (m.googleServices.gms) return 'google_apis';
  return 'default';
}

/** 一行摘要：设置页 / 日志 / 诊断报告共用 */
function describe(m) {
  if (!m) return '';
  const bits = [`Android ${m.api || '?'}`, m.abi || '?'];
  if (m.googleServices.playStore) bits.push('Play 商店');
  else if (m.googleServices.gms) bits.push('Google 服务');
  if (m.armTranslation.enabled) bits.push('ARM 转译');
  return `${m.name}（${bits.join(' · ')}）`;
}

const SOURCE_LABELS = {
  'local-dir': '本地文件夹',
  'local-zip': '本地 ZIP 包',
  'manifest-json': '镜像清单文件',
};

/**
 * 镜像来源的一行说明：给设置页与修复窗口用。
 * 顺序刻意是「先从哪来，再具体到路径」——用户先要知道这是自己导的、还是官方下的。
 */
function describeSource(src = {}) {
  if (!src) return '';
  const bits = [];
  const kind = SOURCE_LABELS[src.kind];
  if (kind) bits.push(kind);
  if (src.vendor) bits.push(src.vendor);
  if (src.license) bits.push(src.license);
  const loc = src.url || src.path || '';
  if (loc) bits.push(loc);
  if (src.provider && SOURCE_LABELS[src.provider] && src.provider !== src.kind) {
    bits.unshift(SOURCE_LABELS[src.provider]);
  }
  return bits.join(' · ');
}

module.exports = {
  SCHEMA, MANIFEST_NAME, TYPE, ABI_SUPPORT, MACHINES, CJK, SOURCE_LABELS,
  normalize, validate, explainType, fillFromInference, normalizeType,
  normalizeChecksums, normalizeAbiName: require('./image-inspect').normalizeAbiName,
  emulatorTag, describe, describeSource, looksMiui, slug, str,
};

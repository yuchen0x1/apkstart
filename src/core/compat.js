'use strict';
/**
 * 安装前兼容性分析
 *
 * 目标：在用户点「安装」之前，就用 APK 清单里能确定的事实告诉他
 * 「这个应用在当前的安卓运行时里大致会怎样」，而不是装完打不开才发现。
 *
 * 原则：
 *   - 只依据能真实解析出来的信息（minSdk / targetSdk / ABI / uses-library / uses-feature）；
 *   - 解析不到的东西一律标成「未知」，**不猜、不编**；
 *   - 结论分四档：ok / partial / risky / unsupported，每档都给得出理由。
 */

/** 运行时环境（由调用方按真实运行环境填入） */
const DEFAULT_ENV = {
  sdk: 34,                              // 内置运行时是 Android 14（API 34）
  abis: ['x86_64'],                     // 运行时支持的 ABI
  armTranslation: true,                 // 是否带 ARM 转译层（libndk/libhoudini）
  playServices: false,                  // 是否内置 Google Play 服务
  backend: 'android-emulator',           // android-emulator | qemu | attached | unknown
  audioInput: true,                      // 只有内置 Android Emulator 的已知路径才为 true
  source: '内置运行时（Android 14）',
};

/** 32 位 x86：x86_64 运行时不带 32 位支持，装了也起不来 */
const ABI_LABEL = {
  'arm64-v8a': 'ARM64',
  'armeabi-v7a': 'ARM32',
  armeabi: 'ARM32(老)',
  x86_64: 'x86_64',
  x86: 'x86(32 位)',
};

/**
 * 已知在「ARM 转译」环境里跑不起来的应用（实测记录见 docs/COMPAT-MATRIX.md）。
 *
 * 只在这些前提同时成立时才判：APK 没有本机原生库 → 必须走转译 → 命中清单。
 * 如果哪天出了 x86_64 版本，这条规则会自动失效，不需要改代码。
 */
const KNOWN_TRANSLATION_BROKEN = {
  'com.smile.gifmaker': '快手',
  'com.kuaishou.nebula': '快手极速版',
  // 微信 8.0.80：libowl.so（自研安全组件）在 System.load 阶段走 JNI_GetMethodID
  // 转译 trampoline 时触发信号探测，libndk_translation 处理不了预期内信号 →
  // 启动即 SIGSEGV（2026-11-15 实测，tombstone_04）。与快手 weapon SDK 同类。
  'com.tencent.mm': '微信',
};

/** 这些硬件特性在桌面运行时里没有真实对应设备 */
const UNSUPPORTED_FEATURES = {
  'android.hardware.nfc': 'NFC',
  'android.hardware.bluetooth': '蓝牙',
  'android.hardware.bluetooth_le': '低功耗蓝牙',
  'android.hardware.camera': '摄像头',
  'android.hardware.camera.autofocus': '摄像头自动对焦',
  'android.hardware.camera.flash': '闪光灯',
  'android.hardware.location.gps': 'GPS',
  'android.hardware.location.network': '网络定位',
  'android.hardware.sensor.accelerometer': '加速度计',
  'android.hardware.sensor.gyroscope': '陀螺仪',
  'android.hardware.sensor.compass': '指南针',
  'android.hardware.sensor.proximity': '距离传感器',
  'android.hardware.sensor.light': '光线传感器',
  'android.hardware.telephony': '蜂窝网络',
  'android.hardware.usb.host': 'USB 主机',
  'android.hardware.microphone': '麦克风',
};

const LEVEL_TEXT = {
  ok: '完全兼容',
  partial: '基本兼容',
  risky: '可能有问题',
  unsupported: '暂不支持',
  unknown: '无法判断',
};

function normSdk(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object} info parseApk 的结果
 * @param {object} env  运行时环境，缺省按内置运行时
 * @returns {{level:string,label:string,reasons:Array,details:object,env:object}}
 */
function analyze(info, env = {}) {
  const e = { ...DEFAULT_ENV, ...env };
  const reasons = [];
  const details = {};

  if (!info || info.ok === false) {
    return {
      level: 'unknown',
      label: LEVEL_TEXT.unknown,
      reasons: [{ kind: 'warn', code: 'parse-failed', text: 'APK 解析失败，无法给出兼容性结论。' }],
      details,
      env: e,
    };
  }

  const minSdk = normSdk(info.minSdk);
  const targetSdk = normSdk(info.targetSdk);
  details.minSdk = minSdk || null;
  details.targetSdk = targetSdk || null;
  details.abis = Array.isArray(info.abis) ? info.abis.slice() : [];
  details.sdk = e.sdk;

  let level = 'ok';
  /** 往下取更差的一档 */
  const degrade = (to) => {
    const order = { ok: 0, partial: 1, risky: 2, unsupported: 3 };
    if (order[to] > order[level]) level = to;
  };
  const add = (kind, code, text) => reasons.push({ kind, code, text });

  // ── 系统版本 ──────────────────────────────────────────────
  if (!minSdk) {
    add('info', 'min-sdk-unknown', '清单里没有声明最低系统版本，按可运行处理。');
  } else if (minSdk > e.sdk) {
    degrade('unsupported');
    add('error', 'min-sdk-too-high',
      `要求 Android API ${minSdk}+，当前运行时是 API ${e.sdk}（Android ${sdkName(e.sdk)}），装上也起不来。`);
  } else if (minSdk <= e.sdk - 20) {
    add('info', 'min-sdk-old', `最低支持到 API ${minSdk}，属于很老的应用，多数仍能运行。`);
  }

  if (targetSdk && targetSdk < 23) {
    // Android 14 默认拒绝安装 targetSdk<23 的应用，ApkStart 安装时会带
    // --bypass-low-target-sdk-block 绕过；能装，但系统行为按兼容模式处理。
    add('warn', 'target-sdk-low',
      `targetSdk 只有 ${targetSdk}，Android 14 默认会拒绝安装（ApkStart 会自动绕过）。运行行为按老版本兼容模式处理。`);
  } else if (targetSdk && targetSdk > e.sdk) {
    add('info', 'target-sdk-new', `targetSdk ${targetSdk} 高于运行时，通常仍可运行，个别新 API 会缺失。`);
  }

  // ── CPU 架构 ──────────────────────────────────────────────
  const apkAbis = details.abis;
  let translated = false;          // 是否只能靠 ARM 转译层运行
  if (!apkAbis.length) {
    add('info', 'no-native', '不含原生库（纯 Java/Kotlin），不挑 CPU 架构。');
  } else {
    const host = new Set(e.abis || []);
    const compatible = apkAbis.filter((a) => host.has(a));
    const armAbis = apkAbis.filter((a) => /^arm/.test(a));
    const x86Only32 = apkAbis.every((a) => a === 'x86');

    if (compatible.length) {
      add('info', 'abi-native', `原生库架构 ${apkAbis.map((a) => ABI_LABEL[a] || a).join('/')}，运行时可直接执行。`);
    } else if (armAbis.length && e.armTranslation) {
      translated = true;
      degrade('partial');
      add('warn', 'abi-arm-translated',
        `只有 ${armAbis.map((a) => ABI_LABEL[a] || a).join('/')} 原生库，需要走 ARM 转译层。常见应用可用，但大型 3D 游戏、加固/反调试应用有闪退风险。`);
    } else if (x86Only32) {
      degrade('risky');
      add('warn', 'abi-x86-32',
        '只有 32 位 x86 原生库，64 位运行时不带 32 位支持，很可能装得上但起不来。');
    } else if (armAbis.length) {
      degrade('unsupported');
      add('error', 'abi-arm-only', `只有 ARM 原生库，当前运行时没有 ARM 转译层，无法执行。`);
    } else {
      degrade('risky');
      add('warn', 'abi-mismatch', `原生库架构（${apkAbis.join('/')}）与运行时（${(e.abis || []).join('/')}）不匹配。`);
    }
  }

  // ── 已知在转译环境崩溃的应用 ─────────────────────────────
  const knownName = KNOWN_TRANSLATION_BROKEN[info.package];
  if (translated && knownName) {
    degrade('unsupported');
    add('error', 'known-translation-crash',
      `${knownName}自带的安全/链接器组件依赖系统底层结构，在 ARM 转译环境下启动即崩溃（已实测复现）。`
      + '当前环境无法运行，请改用真机或 ARM64 设备。');
  }

  // ── Google Play 服务 ─────────────────────────────────────
  const libs = Array.isArray(info.usesLibraries) ? info.usesLibraries : [];
  const needGms = libs.some((l) => /com\.google\.android\.gms|com\.google\.android\.maps/i.test(typeof l === 'string' ? l : l.name));
  if (needGms) {
    details.googlePlay = true;
    if (!e.playServices) {
      degrade('partial');
      add('warn', 'gms-missing',
        '声明依赖 Google Play 服务，当前运行时不内置。依赖账号登录、地图、应用内购买的功能会不可用，主功能通常仍能运行。');
    } else {
      add('info', 'gms-available', '依赖 Google Play 服务，运行时已内置。');
    }
  }

  // ── 硬件特性 ─────────────────────────────────────────────
  const feats = Array.isArray(info.features) ? info.features : [];
  const requiredMissing = [];
  for (const f of feats) {
    const name = typeof f === 'string' ? f : f.name;
    const required = typeof f === 'string' ? true : f.required !== false;
    if (!required) continue;
    if (name === 'android.hardware.microphone' && e.audioInput === true) {
      add('info', 'microphone-available', '运行时支持麦克风输入（仅内置 Android Emulator 路径；是否真正可用还取决于系统隐私权限和主机设备）。');
    } else if (UNSUPPORTED_FEATURES[name]) {
      requiredMissing.push(UNSUPPORTED_FEATURES[name]);
    }
  }
  if (requiredMissing.length) {
    degrade('partial');
    const uniq = [...new Set(requiredMissing)];
    add('warn', 'feature-missing',
      `要求这些硬件：${uniq.join('、')}。桌面运行时没有对应设备，相关功能会不可用（部分应用会因此直接拒绝启动）。`);
  }

  // ── 拆分 APK ─────────────────────────────────────────────
  if (info.isSplit) {
    degrade('risky');
    add('warn', 'split-apk',
      '这是拆分 APK 的一个分片，单独安装会缺资源或原生库。请安装完整的 .apk / .xapk / .apks 包。');
  }

  // ── 老应用/权限 ──────────────────────────────────────────
  const perms = Array.isArray(info.permissions) ? info.permissions : [];
  if (perms.length >= 40) {
    add('info', 'many-permissions', `申请了 ${perms.length} 项权限，属于正常范围但对隐私要求较高。`);
  }

  if (!reasons.length) {
    add('info', 'clean', `未发现兼容性问题（Android ${sdkName(e.sdk)} · ${(e.abis || []).join('/')}）。`);
  }

  return {
    level,
    label: LEVEL_TEXT[level],
    reasons,
    details,
    env: {
      sdk: e.sdk,
      abis: e.abis,
      armTranslation: !!e.armTranslation,
      playServices: !!e.playServices,
      backend: e.backend || 'unknown',
      audioInput: e.audioInput === true,
      source: e.source,
    },
  };
}

function sdkName(sdk) {
  const map = { 21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };
  return map[sdk] || String(sdk);
}

/** 只要需要用户确认的档位（用来决定要不要弹窗） */
function needsConfirm(result) {
  return result.level === 'unsupported' || result.level === 'risky';
}

/** 把结果压成一句话，用于 toast / 安装提示 */
function summary(result) {
  const bad = result.reasons.filter((r) => r.kind === 'error' || r.kind === 'warn');
  if (!bad.length) return result.label;
  return `${result.label}：${bad[0].text}`;
}

module.exports = { analyze, needsConfirm, summary, DEFAULT_ENV, sdkName, LEVEL_TEXT };

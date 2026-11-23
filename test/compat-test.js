'use strict';
/**
 * 兼容性中心测试：用真实合成的 APK（真实 AXML 清单 + 真实 ZIP）驱动，
 * 覆盖 minSdk / targetSdk / ABI / Play 服务 / 硬件特性 / 拆分 APK 六类判定。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseApk } = require('../src/core/apk');
const compat = require('../src/core/compat');
const { buildApkBytes } = require('./lib/make-apk');

let passed = 0;
let failed = 0;
let seq = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-compat-'));
/** 写一个合成 APK 并解析出来 */
function mkApk(opts = {}) {
  seq += 1;
  const file = path.join(TMP, `t${seq}.apk`);
  fs.writeFileSync(file, buildApkBytes(opts));
  return parseApk(file);
}

const hasCode = (r, code) => r.reasons.some((x) => x.code === code);

(async () => {
  console.log('\n[apk.js 新增解析字段]');

  await test('权限 / 硬件特性 / 依赖库 / 拆分 / debuggable 都能解析出来', () => {
    const info = mkApk({
      permissions: ['android.permission.INTERNET', 'android.permission.CAMERA'],
      requiredFeatures: [{ name: 'android.hardware.camera', required: true }],
      usesLibraries: [{ name: 'com.google.android.gms', required: false }],
      debuggable: true,
      split: 'config.arm64_v8a',
    });
    eq(info.permissions.length, 2, `权限数 ${info.permissions.length}`);
    assert(info.permissions.includes('android.permission.INTERNET'), JSON.stringify(info.permissions));
    eq(info.features.length, 1, '硬件特性数');
    eq(info.features[0].name, 'android.hardware.camera');
    eq(info.features[0].required, true);
    eq(info.usesLibraries.length, 1);
    eq(info.usesLibraries[0].name, 'com.google.android.gms');
    eq(info.usesLibraries[0].required, false);
    eq(info.debuggable, true, 'debuggable 应解析为 true');
    eq(info.isSplit, true, 'split 属性应被识别');
    eq(info.splitName, 'config.arm64_v8a');
  });

  await test('普通 APK 不会被误判成拆分包', () => {
    const info = mkApk();
    eq(info.isSplit, false);
    eq(info.debuggable, false);
  });

  console.log('\n[compat.js 判定]');

  await test('x86_64 原生库 → 完全兼容', () => {
    const info = mkApk({ abis: ['x86_64'] });
    const r = compat.analyze(info);
    eq(r.level, 'ok', JSON.stringify(r.reasons));
    eq(r.label, '完全兼容');
  });

  await test('纯 Java（无原生库）→ 完全兼容', () => {
    const r = compat.analyze(mkApk({ abis: [] }));
    eq(r.level, 'ok', JSON.stringify(r.reasons));
    assert(hasCode(r, 'no-native'));
  });

  await test('★ 只有 ARM 库 + 有转译层 → 基本兼容，并说明风险', () => {
    const r = compat.analyze(mkApk({ abis: ['arm64-v8a'] }), { armTranslation: true });
    eq(r.level, 'partial', JSON.stringify(r.reasons));
    assert(hasCode(r, 'abi-arm-translated'), '应给出 ARM 转译层说明');
  });

  await test('★ 只有 ARM 库 + 没有转译层 → 暂不支持', () => {
    const r = compat.analyze(mkApk({ abis: ['armeabi-v7a'] }), { armTranslation: false });
    eq(r.level, 'unsupported', JSON.stringify(r.reasons));
    assert(hasCode(r, 'abi-arm-only'));
  });

  await test('★ 只有 32 位 x86 库 → 可能有问题（64 位运行时不带 32 位）', () => {
    const r = compat.analyze(mkApk({ abis: ['x86'] }));
    eq(r.level, 'risky', JSON.stringify(r.reasons));
    assert(hasCode(r, 'abi-x86-32'));
  });

  await test('★ minSdk 高于运行时 → 暂不支持', () => {
    const r = compat.analyze(mkApk({ minSdk: 35, abis: ['x86_64'] }), { sdk: 34 });
    eq(r.level, 'unsupported', JSON.stringify(r.reasons));
    assert(hasCode(r, 'min-sdk-too-high'));
    assert(/API 35/.test(r.reasons[0].text), r.reasons[0].text);
  });

  await test('targetSdk 低于 23 → 提示系统限制，但不算不支持（会绕过）', () => {
    const r = compat.analyze(mkApk({ targetSdk: 19, abis: ['x86_64'] }), { sdk: 34 });
    assert(r.level !== 'unsupported', `不应判为不支持：${r.level}`);
    assert(hasCode(r, 'target-sdk-low'), JSON.stringify(r.reasons));
  });

  await test('★ 依赖 Google Play 服务且运行时没内置 → 基本兼容', () => {
    const r = compat.analyze(mkApk({ abis: ['x86_64'], usesLibraries: ['com.google.android.gms'] }), { playServices: false });
    eq(r.level, 'partial', JSON.stringify(r.reasons));
    assert(hasCode(r, 'gms-missing'));
  });

  await test('依赖 Play 服务但运行时内置 → 不影响结论', () => {
    const r = compat.analyze(mkApk({ abis: ['x86_64'], usesLibraries: ['com.google.android.gms'] }), { playServices: true });
    eq(r.level, 'ok', JSON.stringify(r.reasons));
    assert(hasCode(r, 'gms-available'));
  });

  await test('★ 要求摄像头等硬件 → 基本兼容并说明具体是哪个硬件', () => {
    const r = compat.analyze(mkApk({
      abis: ['x86_64'],
      requiredFeatures: ['android.hardware.camera', 'android.hardware.location.gps'],
    }));
    eq(r.level, 'partial', JSON.stringify(r.reasons));
    assert(hasCode(r, 'feature-missing'));
    const text = r.reasons.find((x) => x.code === 'feature-missing').text;
    assert(/摄像头/.test(text) && /GPS/.test(text), text);
  });

  await test('内置 Android Emulator 已知支持麦克风输入，不误报为缺少硬件', () => {
    const r = compat.analyze(mkApk({
      abis: ['x86_64'],
      requiredFeatures: ['android.hardware.microphone'],
    }));
    eq(r.level, 'ok', JSON.stringify(r.reasons));
    assert(hasCode(r, 'microphone-available'), JSON.stringify(r.reasons));
    assert(!hasCode(r, 'feature-missing'), JSON.stringify(r.reasons));
    assert(r.env.audioInput === true && r.env.backend === 'android-emulator');
  });

  await test('QEMU 未验证麦克风采集时保留明确的兼容性警告', () => {
    const r = compat.analyze(mkApk({
      abis: ['x86_64'],
      requiredFeatures: ['android.hardware.microphone'],
    }), { backend: 'qemu', audioInput: false });
    eq(r.level, 'partial', JSON.stringify(r.reasons));
    assert(hasCode(r, 'feature-missing'), JSON.stringify(r.reasons));
    assert(r.reasons.find(x => x.code === 'feature-missing').text.includes('麦克风'));
    assert(r.env.audioInput === false && r.env.backend === 'qemu');
  });

  await test('非必需硬件（required=false）不影响结论', () => {
    const r = compat.analyze(mkApk({
      abis: ['x86_64'],
      requiredFeatures: [{ name: 'android.hardware.camera', required: false }],
    }));
    eq(r.level, 'ok', JSON.stringify(r.reasons));
  });

  await test('★ 拆分 APK 单独安装 → 可能有问题（提示装完整包）', () => {
    const r = compat.analyze(mkApk({ abis: ['x86_64'], split: 'config.arm64_v8a' }));
    eq(r.level, 'risky', JSON.stringify(r.reasons));
    assert(hasCode(r, 'split-apk'));
  });

  await test('解析失败 → 明确标为未知，不编结论', () => {
    const r = compat.analyze({ ok: false, error: '坏包' });
    eq(r.level, 'unknown');
    eq(r.label, '无法判断');
    eq(r.reasons[0].code, 'parse-failed');
  });

  await test('多问题时取最严重的一档（minSdk 过高 + ARM 库 + 拆分）', () => {
    const r = compat.analyze(mkApk({ minSdk: 99, abis: ['arm64-v8a'], split: 'config.x' }), { armTranslation: true });
    eq(r.level, 'unsupported', JSON.stringify(r.reasons));
    assert(r.reasons.length >= 3, `应列出多条理由，实际 ${r.reasons.length}`);
  });

  console.log('\n[compat.js 辅助函数]');

  await test('needsConfirm：只有 risky / unsupported 需要二次确认', () => {
    assert(compat.needsConfirm({ level: 'risky' }));
    assert(compat.needsConfirm({ level: 'unsupported' }));
    assert(!compat.needsConfirm({ level: 'ok' }));
    assert(!compat.needsConfirm({ level: 'partial' }));
  });

  await test('summary 优先给最具体的问题', () => {
    const r = compat.analyze(mkApk({ minSdk: 35, abis: ['x86_64'] }));
    const s = compat.summary(r);
    assert(s.startsWith('暂不支持'), s);
    assert(/API 35/.test(s), s);
  });

  await test('已知转译环境崩溃：快手 arm64 包判为不可用', () => {
    const r = compat.analyze(mkApk({ packageName: 'com.smile.gifmaker', abis: ['arm64-v8a'] }),
      { abis: ['x86_64'], armTranslation: true, sdk: 35 });
    eq(r.level, 'unsupported', '应判为暂不支持');
    assert(hasCode(r, 'known-translation-crash'), '应给出已知崩溃理由');
    assert(hasCode(r, 'abi-arm-translated'), '仍应保留 ABI 转译说明');
  });

  await test('同样的包出了 x86_64 原生库就不再命中黑名单', () => {
    const r = compat.analyze(mkApk({ packageName: 'com.smile.gifmaker', abis: ['x86_64'] }),
      { abis: ['x86_64'], armTranslation: true, sdk: 35 });
    assert(!hasCode(r, 'known-translation-crash'), '有本机原生库时不应命中');
    eq(r.level, 'ok', '应判为可用');
  });

  await test('微信 arm64 包同样命中转译黑名单（libowl 安全组件）', () => {
    const r = compat.analyze(mkApk({ packageName: 'com.tencent.mm', abis: ['arm64-v8a'] }),
      { abis: ['x86_64'], armTranslation: true, sdk: 34 });
    eq(r.level, 'unsupported', '应判为暂不支持');
    assert(hasCode(r, 'known-translation-crash'), '应给出已知崩溃理由');
  });

  await test('未知包名的 arm64 应用不会被误判', () => {
    const r = compat.analyze(mkApk({ packageName: 'com.example.other', abis: ['arm64-v8a'] }),
      { abis: ['x86_64'], armTranslation: true, sdk: 35 });
    assert(!hasCode(r, 'known-translation-crash'), '不在清单里不应触发');
    eq(r.level, 'partial', '走转译仍是部分兼容');
  });

  await test('Android 版本号映射', () => {
    eq(compat.sdkName(34), '14');
    eq(compat.sdkName(33), '13');
    eq(compat.sdkName(21), '5.0');
    eq(compat.sdkName(999), '999');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n兼容性测试结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();

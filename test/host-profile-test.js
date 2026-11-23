'use strict';
/**
 * 宿主画像 + 宿主适配层离线回归
 * ------------------------------------------------------------------
 * 目的：把「每个宿主对应哪份 Google 官方产物、哪个系统镜像 ABI」钉死成测试。
 * 起因是 provision.js 里两处真实缺陷（不是假设）：
 *   1. `HOST_TAG = IS_WIN ? 'windows' : IS_LINUX ? 'linux' : 'mac'` —— macOS 的官方
 *      归档前缀是 `darwin`，拼成 `mac_x64` 永远匹配不到任何条目；
 *   2. emulator / sysimg 过滤器写死 `_x64` / `x86_64` —— Apple Silicon 与 ARM64
 *      永远解析不到自己的 arm64 产物。
 * 这两条一旦回退，macOS/ARM64 就会变成「能装但起不来」的假支持，所以必须有测试守住。
 *
 * 方法：纯函数离线校验 + 对 provision.js 的源码做契约检查（不联网、不下载、不起进程）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const profile = require('../src/core/host/profile');
const { HostAdapter } = require('../src/core/host');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`);
  }
}

console.log('\n[架构归一化]');

test('x64 / x86_64 / amd64 → x64；arm64 / aarch64 → arm64；未知 → 空串', () => {
  for (const a of ['x64', 'x86_64', 'amd64', 'X64']) assert.equal(profile.normalizeArch(a), 'x64', a);
  for (const a of ['arm64', 'aarch64', 'ARM64']) assert.equal(profile.normalizeArch(a), 'arm64', a);
  for (const a of ['ia32', 'mips', '', null, undefined]) assert.equal(profile.normalizeArch(a), '', String(a));
});

console.log('\n[emulator 官方归档前缀：只认 Google 真实发布的四种]');

test('Windows x64 / Linux x64 / macOS Intel / macOS Apple Silicon 前缀正确', () => {
  assert.equal(profile.emulatorArchivePrefix('win32', 'x64'), 'windows_x64');
  assert.equal(profile.emulatorArchivePrefix('linux', 'x64'), 'linux_x64');
  // 这是修复的核心：官方前缀是 darwin，不是 mac
  assert.equal(profile.emulatorArchivePrefix('darwin', 'x64'), 'darwin_x64');
  // 这是修复的核心：Apple Silicon 必须命中 aarch64，而不是写死 _x64
  assert.equal(profile.emulatorArchivePrefix('darwin', 'arm64'), 'darwin_aarch64');
});

test('Linux ARM64 没有官方 emulator 发行物 → 空串（不虚报、不回退到 x64）', () => {
  assert.equal(profile.emulatorArchivePrefix('linux', 'arm64'), '',
    'Google 从未发布 emulator-linux_aarch64：必须返回空串，绝不能静默回退 x64 包');
  assert.equal(profile.emulatorArchivePrefix('freebsd', 'x64'), '');
  assert.equal(profile.emulatorArchivePrefix('win32', 'ia32'), '');
});

console.log('\n[platform-tools 官方目标]');

test('四个宿主有官方 platform-tools；Linux ARM64 没有', () => {
  assert.deepEqual(profile.platformToolsTarget('win32', 'x64'), { os: 'windows', suffix: 'win', arch: 'x64' });
  assert.deepEqual(profile.platformToolsTarget('linux', 'x64'), { os: 'linux', suffix: 'linux', arch: 'x64' });
  assert.deepEqual(profile.platformToolsTarget('darwin', 'x64'), { os: 'macosx', suffix: 'darwin', arch: 'x64' });
  assert.deepEqual(profile.platformToolsTarget('darwin', 'arm64'), { os: 'macosx', suffix: 'darwin', arch: 'arm64' });
  assert.equal(profile.platformToolsTarget('linux', 'arm64'), null);
});

console.log('\n[系统镜像 ABI：按宿主架构选，绝不假设 x86_64]');

test('x64 宿主 → x86_64；arm64 宿主 → arm64-v8a；未知 → 空串', () => {
  assert.equal(profile.defaultSysimgAbi('x64'), 'x86_64');
  assert.equal(profile.defaultSysimgAbi('arm64'), 'arm64-v8a');
  assert.equal(profile.defaultSysimgAbi('ia32'), '');
});

test('加速后端种类按平台区分（只描述机制，不声称就绪）', () => {
  assert.equal(profile.accelerationBackend('win32'), 'whpx-or-aehd');
  assert.equal(profile.accelerationBackend('linux'), 'kvm');
  assert.equal(profile.accelerationBackend('darwin'), 'hvf');
  assert.equal(profile.accelerationBackend('freebsd'), 'none');
});

console.log('\n[hostFacts：可获取 ≠ 已验证]');

test('macOS（Intel / Apple Silicon）官方产物齐全；Linux ARM64 假不了', () => {
  const macIntel = profile.hostFacts('darwin', 'x64');
  assert.equal(macIntel.emulatorAvailable, true);
  assert.equal(macIntel.platformToolsAvailable, true);
  assert.equal(macIntel.sysimgAbi, 'x86_64');
  const macArm = profile.hostFacts('darwin', 'arm64');
  assert.equal(macArm.emulatorAvailable, true);
  assert.equal(macArm.emulatorPrefix, 'darwin_aarch64');
  assert.equal(macArm.sysimgAbi, 'arm64-v8a');
  const linuxArm = profile.hostFacts('linux', 'arm64');
  assert.equal(linuxArm.emulatorAvailable, false, 'Linux ARM64 没有官方模拟器运行时');
  assert.equal(linuxArm.platformToolsAvailable, false);
});

console.log('\n[HostAdapter：能力单一出处，支持级别不被 acquire 抬高]');

test('Windows: full + 可获取；Linux arm64 仍按 unsupported/external 不虚报', () => {
  const win = new HostAdapter({ platform: 'win32', arch: 'x64' });
  assert.equal(win.exeSuffix(), '.exe');
  assert.equal(win.exe('adb'), 'adb.exe');
  assert.equal(win.supportLevel(), 'full');
  assert.equal(win.runtimeAcquirable(), true);

  // Linux ARM64：能跑不了官方模拟器，即便 KVM 在也不能声称可用
  const linuxArm = new HostAdapter({ platform: 'linux', arch: 'arm64' });
  assert.equal(linuxArm.exeSuffix(), '');
  assert.equal(linuxArm.runtimeAcquirable(), false, '没有官方 emulator 发行物时 acquire 必须为 false');
  assert.equal(linuxArm.sysimgAbi(), 'arm64-v8a');
  // 平台整体支持级别仍来自声明表，不因新增 host 层抬高
  assert.equal(linuxArm.supportLevel(), 'external');

  const mac = new HostAdapter({ platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.supportLevel(), 'unsupported',
    'macOS 平台整体仍是 unsupported：产物可得不等于打包/签名/公证/实测已完成');
  assert.equal(mac.runtimeAcquirable(), true, 'arm64 macOS 的官方产物确实可以获取');
});

test('HostAdapter.describe() 暴露结构化事实且不含虚假承诺字段', () => {
  const d = new HostAdapter({ platform: 'darwin', arch: 'x64' }).describe();
  assert.equal(d.platform, 'darwin');
  assert.equal(d.emulatorPrefix, 'darwin_x64');
  assert.equal(d.knownArch, true);
  assert.ok(Array.isArray(d.blockers));
  assert.equal(d.acceleration, 'hvf');
  // 不能有「verified: true」这类未实测却声称通过的字段
  assert.ok(!('verified' in d));
});

console.log('\n[provision.js 契约：不再写死 mac / _x64 / x86_64 过滤器]');

test('provision.js 用 hostProfile 决定 emulator 前缀与镜像 ABI', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'core', 'provision.js'), 'utf8');
  // 只检查可执行代码：剥掉块注释与行注释，避免命中说明旧写法的文档注释。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/require\('\.\/host\/profile'\)/.test(src), 'provision.js 必须 require host/profile');
  assert.ok(/emulatorArchivePrefix\(\)/.test(src), '必须用 emulatorArchivePrefix() 而非写死前缀');
  assert.ok(/defaultSysimgAbi\(\)/.test(src), '必须用 defaultSysimgAbi() 而非写死 x86_64');
  // 不允许再出现 `: 'mac'` 这种拼错的前缀
  assert.ok(!/IS_LINUX \? 'linux' : 'mac'/.test(src), '不允许再拼 `mac`（官方前缀是 darwin）');
  // emulator / sysimg 过滤器不允许再写死 x86_64
  assert.ok(!/new RegExp\(`\$\{HOST_TAG\}_x64/.test(src), '不允许再拼 `_x64` 过滤器');
  assert.ok(!/\.filter\(\(x\) => \/x86_64\.\*\\\.zip\$\//.test(src), 'sysimg 过滤器不允许写死 x86_64');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

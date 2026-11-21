'use strict';
/**
 * 平台能力离线回归（upstream RoutineMiku/apkstart#112 / #24 / #88）
 *
 * 目的：把「每条平台到底能做什么、不能做什么」钉死在测试里，防止未来有人靠
 * 「加一个 os:'darwin'」「把 process.platform 判断改一改」就宣布支持了 macOS 或
 * Linux 窗口嵌入 —— 那种声明会直接把用户引向黑屏或装不上的发行物。
 *
 * 方法：用 vm 替换 process.platform（win32 / linux / darwin / freebsd）重建
 * platform-capabilities.js 与 platform.js，并注入桩 fs / os —— 全程不启动模拟器、
 * 不探测本机 /dev/kvm 之外的任何窗口系统、不联网。另加一组源码契约检查（纯文本，
 * 不执行产品代码）：platform.js 必须从声明表推导能力，不允许散落第二份平台判断。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const core = path.join(__dirname, '..', 'src', 'core');
const PLATFORM_CAPS_SOURCE = fs.readFileSync(path.join(core, 'platform-capabilities.js'), 'utf8');
const PLATFORM_SOURCE = fs.readFileSync(path.join(core, 'platform.js'), 'utf8');

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

/**
 * 在给定 process.platform 下重建两个模块（platform.js require('./platform-capabilities')
 * 也走桩 require，保证拿到的是同一份被替换出来的模块，而不是真实平台的）。
 * 真实模块路径名仅用于报错定位；内容来自上面读好的源码字符串。
 *
 * 平台替换的实现：把假 process 作为包装函数的第 4 个形参 —— 形参会遮蔽真实全局
 * process，模块内所有 process.platform / process.arch 读到的都是被替换的平台；
 * 同时代码仍在主域执行，导出对象与断言处于同一 realm，deepStrictEqual 的
 * 原型比较不会踩跨域陷阱。全程不触碰真实文件系统之外的任何全局状态。
 */
function loadWithPlatform(hostPlatform, { fsStub = null, osStub = null } = {}) {
  const capsModule = { exports: {} };
  const platformModule = { exports: {} };
  const req = (name) => {
    if (name === './platform-capabilities') return capsModule.exports;
    if (name === 'fs') return fsStub || fs;
    if (name === 'os') return osStub || os;
    if (name === 'path') return path;
    throw new Error(`unmocked dependency: ${name}`);
  };
  const fakeProcess = {
    platform: hostPlatform,
    arch: process.arch,
    env: {},
    version: process.version,
  };
  const capsWrap = vm.runInThisContext(
    `(function (require, module, __dirname, process) {${PLATFORM_CAPS_SOURCE}\n})`,
    { filename: path.join(core, 'platform-capabilities.js') },
  );
  capsWrap(req, capsModule, core, fakeProcess);
  const platformWrap = vm.runInThisContext(
    `(function (require, module, __dirname, process) {${PLATFORM_SOURCE}\n})`,
    { filename: path.join(core, 'platform.js') },
  );
  platformWrap(req, platformModule, core, fakeProcess);
  return { caps: capsModule.exports, platform: platformModule.exports };
}

/** avdHomeDefault 的桩 home（避免读到真实用户目录） */
function osStubWithHome(home) {
  return {
    homedir: () => home,
    release: () => 'stub-release',
    arch: () => process.arch,
    tmpdir: () => os.tmpdir(),
    platform: () => process.platform,
    cpus: () => [],
    totalmem: () => 0,
    freemem: () => 0,
  };
}

console.log('\n[能力表声明：每条平台 × 能力都有一等声明]');

test('声明表覆盖 win32 / linux / darwin 三个平台，capabilityFor 拒绝未知项', () => {
  const { caps } = loadWithPlatform('win32');
  const ids = Object.keys(caps.CAPABILITIES);
  assert.ok(ids.length >= 5, `能力数量：${ids.length}`);
  assert.deepEqual(
    ids.sort(),
    ['attach', 'embed', 'mouseHook', 'provision', 'shellIntegration'],
    '能力清单变化时必须同步本测试',
  );
  for (const id of ids) {
    for (const p of ['win32', 'linux', 'darwin']) {
      const c = caps.capabilityFor(id, p);
      assert.ok(c.level, `${id}/${p} 必须声明 level`);
      assert.ok(c.code, `${id}/${p} 必须声明障碍代码`);
      assert.equal(typeof c.source, 'string', `${id}/${p} 必须声明实现出处`);
    }
    // 未声明平台（sunos）走保守缺省：absent + UNSUPPORTED_PLATFORM，而不是抛错 ——
    // 应用必须在任何系统上都能完成 require 并如实说「不支持」。
    const sunos = caps.capabilityFor(id, 'sunos');
    assert.equal(sunos.level, 'absent', `${id} 对未声明平台必须保守按 absent`);
    assert.equal(sunos.code, caps.OBSTACLE_CODES.UNSUPPORTED_PLATFORM);
    assert.equal(sunos.platform, 'sunos');
  }
  assert.throws(() => caps.capabilityFor('teleport', 'win32'), /未知能力/, '未知能力必须显式抛错');
});

test('等级与障碍代码词表稳定（诊断报告 / UI 依赖这些字符串）', () => {
  const { caps } = loadWithPlatform('linux');
  assert.deepEqual(
    Object.keys(caps.SUPPORT_LEVELS).sort(),
    ['absent', 'external', 'full', 'partial', 'unsupported'],
    'supportLevel() 词表必须与 platform.js 保持一致',
  );
  assert.equal(caps.SUPPORT_LEVELS.full, 'full');
  assert.equal(caps.SUPPORT_LEVELS.external, 'external');
  assert.equal(caps.SUPPORT_LEVELS.unsupported, 'unsupported');
  assert.equal(caps.OBSTACLE_CODES.OK, 'OK');
  assert.equal(caps.OBSTACLE_CODES.NO_NATIVE_BACKEND, 'NO_NATIVE_BACKEND');
  assert.equal(caps.OBSTACLE_CODES.UNSUPPORTED_PLATFORM, 'UNSUPPORTED_PLATFORM');
  assert.equal(caps.OBSTACLE_CODES.NO_MAC_PACKAGING, 'NO_MAC_PACKAGING');
  assert.equal(caps.OBSTACLE_CODES.NO_NOTARIZATION, 'NO_NOTARIZATION');
  assert.equal(caps.OBSTACLE_CODES.NO_MAC_RUNTIME_VALIDATION, 'NO_MAC_RUNTIME_VALIDATION');
  assert.equal(caps.OBSTACLE_CODES.HOST_ARCH_IMAGE_MISMATCH, 'HOST_ARCH_IMAGE_MISMATCH');
  assert.equal(caps.OBSTACLE_CODES.HOST_ARCH_RUNTIME_MISMATCH, 'HOST_ARCH_RUNTIME_MISMATCH');
});

console.log('\n[平台整体门禁：不虚报、不抬轿]');

test('Windows = full；Linux = external（独立窗口 + 内置运行时）；macOS = unsupported', () => {
  const win = loadWithPlatform('win32');
  assert.equal(win.caps.platformSupportLevel('win32'), 'full');
  assert.deepEqual(win.caps.platformBlockers('win32'), []);
  const linux = loadWithPlatform('linux');
  assert.equal(linux.caps.platformSupportLevel('linux'), 'external');
  assert.deepEqual(linux.caps.platformBlockers('linux'), []);
  const mac = loadWithPlatform('darwin');
  assert.equal(mac.caps.platformSupportLevel('darwin'), 'unsupported');
  assert.deepEqual(mac.caps.platformBlockers('darwin'), [
    mac.caps.OBSTACLE_CODES.NO_MAC_PACKAGING,
    mac.caps.OBSTACLE_CODES.NO_NOTARIZATION,
    mac.caps.OBSTACLE_CODES.NO_MAC_RUNTIME_VALIDATION,
  ]);
  assert.equal(loadWithPlatform('sunos').caps.platformSupportLevel('sunos'), 'unsupported');
});

test('macOS attach 的 partial 不抬轿：平台门禁仍由 embed/provision 的 absent 决定', () => {
  const { caps } = loadWithPlatform('darwin');
  assert.equal(caps.capabilityFor('attach', 'darwin').level, 'partial');
  assert.equal(caps.capabilityFor('embed', 'darwin').level, 'absent');
  assert.equal(caps.capabilityFor('provision', 'darwin').level, 'absent');
  // attach 声明里必须写明「未实测、不构成承诺」，防止未来被当成支持依据
  const attach = caps.capabilityFor('attach', 'darwin');
  assert.ok(/未实测/.test(attach.note || ''), 'macOS attach 声明必须注明未实测');
});

test('能力矩阵展开：3 能力级别 × 3 平台全部可枚举', () => {
  const { caps } = loadWithPlatform('win32');
  const matrix = caps.capabilityMatrix();
  assert.equal(matrix.length, Object.keys(caps.CAPABILITIES).length);
  for (const entry of matrix) {
    assert.deepEqual(Object.keys(entry.byPlatform).sort(), ['darwin', 'linux', 'win32']);
  }
});

console.log('\n[platform.js 推导：行为随平台重建，而不是读真实平台]');

test('win32 重建：canEmbed/canProvision/canIntegrateShell/canHookMouse 全开，supportLevel=full', () => {
  const { platform } = loadWithPlatform('win32');
  assert.equal(platform.platform, 'win32');
  assert.equal(platform.isWin, true);
  assert.equal(platform.isLinux, false);
  assert.equal(platform.isMac, false);
  assert.equal(platform.canEmbed, true);
  assert.equal(platform.canProvision, true);
  assert.equal(platform.canIntegrateShell, true);
  assert.equal(platform.canHookMouse, true);
  assert.equal(platform.supportLevel(), 'full');
  assert.equal(platform.supportNote(), '', 'full 平台不需要降级说明');
  const d = platform.describe();
  assert.equal(d.support, 'full');
  assert.equal(d.canEmbed, true);
  assert.deepEqual(d.blockers, []);
});

test('linux 重建：独立窗口（canEmbed=false）+ 内置运行时（canProvision=true）——这就是 #24 已交付的范围', () => {
  const kvmPresent = { existsSync: (p) => p === '/dev/kvm', statSync: () => ({ isCharacterDevice: () => true }) };
  const { platform } = loadWithPlatform('linux', { fsStub: kvmPresent });
  assert.equal(platform.platform, 'linux');
  assert.equal(platform.canEmbed, false, 'Linux 窗口嵌入是 Win32 专有，必须保持 false');
  assert.equal(platform.canProvision, true, 'Linux 内置运行时已实测交付（PLATFORM-LINUX-VALIDATION.md）');
  assert.equal(platform.canIntegrateShell, false);
  assert.equal(platform.canHookMouse, false);
  assert.equal(platform.supportLevel(), 'external');
  const note = platform.supportNote();
  assert.ok(/不支持窗口嵌入/.test(note), '说明必须点名「不支持窗口嵌入」');
  assert.ok(/独立窗口|自己的窗口/.test(note), '说明必须告诉用户画面在哪里');
  assert.ok(/\/dev\/kvm/.test(note), '说明必须给出 KVM 前提');
  const accel = platform.acceleration();
  assert.equal(accel.kind, 'kvm');
  assert.equal(accel.ok, true);
  assert.equal(accel.path, '/dev/kvm');
  const d = platform.describe();
  assert.equal(d.support, 'external');
  assert.deepEqual(d.blockers, [], 'Linux 不需要平台级阻塞列表（降级但有完整可用的路径）');
});

test('linux 无 /dev/kvm：ok=false 且提示加组；说明不声称完整体验', () => {
  const noKvm = { existsSync: () => false };
  const { platform } = loadWithPlatform('linux', { fsStub: noKvm });
  const accel = platform.acceleration();
  assert.equal(accel.ok, false);
  assert.ok(/kvm 组/.test(accel.hint), 'hint 必须指向可执行的修复');
  assert.equal(platform.supportLevel(), 'external', '缺 KVM 是环境条件，不是能力缺失');
});

test('darwin 重建：全部能力关闭 + 明确说明；attach 通道只描述不承诺', () => {
  const { platform } = loadWithPlatform('darwin');
  assert.equal(platform.platform, 'darwin');
  assert.equal(platform.canEmbed, false);
  assert.equal(platform.canProvision, false, 'macOS 内置运行时未实现，不能放行');
  assert.equal(platform.canIntegrateShell, false);
  assert.equal(platform.canHookMouse, false);
  assert.equal(platform.supportLevel(), 'unsupported', 'upstream #112：macOS 是 unsupported，不是 external');
  const note = platform.supportNote();
  assert.ok(/Windows 与 Linux/.test(note), '说明必须告诉用户可以去哪两个平台');
  assert.ok(/没有实现/.test(note), '说明必须如实列出缺口');
  assert.ok(/未(经测试|验证)|未经测试/.test(note), 'attach 通道必须注明未实测');
  assert.ok(!/运行时（adb \/ 模拟器 \/ 系统镜像）可以在应用内一键自动下载/.test(note),
    'macOS 说明不得复用 Linux 的「一键自动下载」话术 —— macOS 没有这条路径');
  const accel = platform.acceleration();
  assert.equal(accel.kind, 'hvf');
  assert.equal(accel.ok, null, 'Hypervisor.framework 未实现，ok 必须是未知而非可用');
  assert.ok(/未实现|未验证/.test(accel.hint || ''), '加速说明必须承认未验证');
  const d = platform.describe();
  assert.equal(d.support, 'unsupported');
  assert.ok(d.blockers.includes('NO_MAC_PACKAGING'), '诊断报告必须给出打包阻塞');
  assert.ok(d.blockers.includes('NO_NOTARIZATION'), '诊断报告必须给出签名/公证阻塞');
  assert.ok(d.blockers.includes('NO_MAC_RUNTIME_VALIDATION'), '诊断报告必须给出运行时实测阻塞');
});

test('未知平台（sunos）：unsupported + 无加速 + 有解释（不得崩溃、不得误报）', () => {
  const { platform } = loadWithPlatform('sunos');
  assert.equal(platform.supportLevel(), 'unsupported');
  assert.equal(platform.canProvision, false);
  assert.equal(platform.canEmbed, false);
  assert.equal(platform.acceleration().kind, 'none');
  assert.ok(/没有已实现的硬件加速检测/.test(platform.acceleration().hint || ''));
  const note = platform.supportNote();
  assert.ok(/Windows 与 Linux/.test(note));
  assert.ok(/其它系统|其它系统的应用画面/.test(note));
});

test('exe() 与 avdHomeDefault()：Windows 带 .exe，AVD 目录走 $HOME/.android/avd', () => {
  const home = path.join(os.tmpdir(), `apkstart-caps-home-${Date.now()}`);
  const stub = osStubWithHome(home);
  const win = loadWithPlatform('win32', { osStub: stub });
  assert.equal(win.platform.exe('adb'), 'adb.exe');
  assert.equal(win.platform.avdHomeDefault(), path.join(home, '.android', 'avd'));
  const linux = loadWithPlatform('linux', { osStub: stub });
  assert.equal(linux.platform.exe('adb'), 'adb');
  assert.equal(linux.platform.avdHomeDefault(), path.join(home, '.android', 'avd'));
  const mac = loadWithPlatform('darwin', { osStub: stub });
  assert.equal(mac.platform.exe('adb'), 'adb');
  assert.equal(mac.platform.avdHomeDefault(), path.join(home, '.android', 'avd'),
    'macOS 的 AVD 约定与 Linux 相同（Android Studio 惯例）');
});

console.log('\n[能力读取：capability() 带上下文]');

test('capability() 返回平台与能力 id，来源字段指向仓库内实现', () => {
  const { platform } = loadWithPlatform('win32');
  const embed = platform.capability('embed');
  assert.equal(embed.id, 'embed');
  assert.equal(embed.platform, 'win32');
  assert.equal(embed.level, 'full');
  assert.ok(/win32-agent/.test(embed.source), 'Windows 嵌入必须指到 Win32 代理实现');
  const prov = platform.capability('provision');
  assert.ok(/src\/core\/provision\.js/.test(prov.source), '内置运行时必须指到 provision 实现');
});

console.log('\n[源码契约：禁止散落第二份平台判断]');

test('platform.js 不再写 process.platform 比较，能力全部来自声明表', () => {
  // 只检查可执行代码：剥掉块注释与行注释后再匹配，避免命中文档里引用的旧写法。
  const code = PLATFORM_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/process\s*\.\s*platform\s*===/.test(code),
    'platform.js 里不允许出现 process.platform === 比较（统一走 platform 常量与声明表）');
  // 唯一合法的读取点：模块加载时取一次平台常量
  assert.ok(/const\s+platform\s*=\s*process\s*\.\s*platform\s*;/.test(code),
    'platform.js 必须只在加载时读取一次 process.platform');
  assert.ok(/require\('\.\/platform-capabilities'\)/.test(code),
    'platform.js 必须 require 声明表');
  assert.ok(!/canEmbed\s*=\s*isWin\b/.test(code), 'canEmbed 不允许直接由 isWin 推导');
  for (const cap of ['embed', 'provision', 'shellIntegration', 'mouseHook']) {
    assert.ok(new RegExp(`isFull\\('${cap}'\\)`).test(code), `${cap} 必须经声明表推导`);
  }
  assert.ok(!/'darwin'\s*:\s*'external'/.test(code) && !/if \(isMac\) return 'external'/.test(code),
    '禁止把 macOS 抬成 external —— 它是 unsupported');
});

test('声明表：macOS provision 必须带结构化阻塞列表，Linux embed 必须点名 Wayland 约束', () => {
  const macProv = /darwin:\s*\{[\s\S]*?blockers:\s*Object\.freeze\(\[[\s\S]*?\]\)[\s\S]*?\}/.exec(PLATFORM_CAPS_SOURCE);
  assert.ok(macProv, 'macOS provision 声明必须带 blockers');
  for (const code of ['NO_MAC_PACKAGING', 'NO_NOTARIZATION', 'NO_MAC_RUNTIME_VALIDATION']) {
    assert.ok(macProv[0].includes(code), `macOS 阻塞必须包含 ${code}`);
  }
  const linuxEmbed = /linux:\s*\{[\s\S]*?NO_NATIVE_BACKEND[\s\S]*?\}/.exec(PLATFORM_CAPS_SOURCE);
  assert.ok(linuxEmbed, 'Linux embed 必须是 NO_NATIVE_BACKEND');
  assert.ok(/Wayland/.test(linuxEmbed[0]), 'Linux embed 说明必须写明 Wayland 协议约束（#88）');
  assert.ok(/arm64-v8a|Hypervisor\.framework/.test(PLATFORM_CAPS_SOURCE),
    'macOS 说明必须写明架构匹配镜像与 Hypervisor.framework 验证要求（#112）');
});

console.log('\n[对 UI / 主进程现有接线的兼容]');

test('现有调用方的取值假设不被破坏（app.js / main.js / appwin.js 的门禁）', () => {
  // src/ui/app.js: canEmbed ?? windows —— rebuilt table 必须给出显式 boolean
  for (const p of ['win32', 'linux', 'darwin']) {
    const { platform } = loadWithPlatform(p);
    for (const key of ['canEmbed', 'canProvision', 'canIntegrateShell', 'canHookMouse']) {
      assert.equal(typeof platform[key], 'boolean', `${p}.${key} 必须是显式 boolean`);
    }
    assert.ok(typeof platform.supportLevel() === 'string');
    assert.ok(Array.isArray(platform.describe().blockers), `${p}.describe().blockers 必须是数组`);
  }
  // src/core/appwin.js:447 —— canEmbed=false 时 lastEmbedError 必须是 platform-cannot-embed
  const linux = loadWithPlatform('linux');
  assert.equal(linux.platform.canEmbed, false, 'appwin external 降级依赖 canEmbed=false');
  // src/core/engine.js:346 —— 非 attach 模式在 !canProvision 平台上抛 supportNote()
  const mac = loadWithPlatform('darwin');
  assert.equal(mac.platform.canProvision, false);
  assert.ok(mac.platform.supportNote().length > 20, '抛出的 supportNote 必须有实际内容');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

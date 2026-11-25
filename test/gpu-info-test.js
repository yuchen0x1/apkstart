'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('os');
const vm = require('node:vm');
const gpu = require('../src/core/gpu');
const doctor = require('../src/core/doctor');

const HOST = { totalMB: 32768, freeMB: 16384, cores: 16, tmp: os.tmpdir() };

function profileFor(engine, gpuInfo = null, emulatorVersion = '37.4.2.0') {
  return doctor.chooseProfile({
    host: HOST, accel: { ok: true }, emulatorVersion, diskMB: 50000,
    settings: { engine }, overrides: doctor.overridesFromSettings(engine), gpuInfo,
  });
}

function isolatedGpu({ platform = 'win32', sessionName = 'Console', stdout = '', error = null } = {}) {
  const module = { exports: {} };
  let calls = 0;
  const context = {
    module, process: { platform, env: { SESSIONNAME: sessionName } },
    require(name) {
      assert.equal(name, 'child_process');
      return {
        execFile(exe, args, options, callback) {
          calls++;
          assert.equal(exe, 'powershell.exe');
          assert.equal(options.windowsHide, true);
          assert.equal(options.timeout, 8000);
          callback(error, stdout);
        },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/core/gpu'), 'utf8'), context);
  return { gpu: module.exports, calls: () => calls };
}

test('GPU classify: hybrid AMD + NVIDIA stays on hardware rendering', () => {
  const info = gpu.classify([
    { name: 'AMD Radeon(TM) 610M', driverVersion: '32.0.13034.7001', status: 'OK', adapterRam: 536870912 },
    { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driverVersion: '32.0.16.1062', status: 'OK', adapterRam: 4293918720 },
  ], { sessionName: 'Console' });
  assert.equal(info.hardware, true);
  assert.equal(info.capability, 'hardware');
  assert.equal(info.hybrid, true);
  assert.equal(info.preferSoftware, false);
  assert.equal(info.adapters.length, 2);
  assert.match(gpu.summary(info), /混合显卡/);
  assert.match(gpu.summary(info), /32\.0\.13034\.7001/);
});

test('GPU classify: basic display / remote display must prefer software', () => {
  const basic = gpu.classify([{ name: 'Microsoft Basic Display Adapter', status: 'OK' }]);
  assert.equal(basic.hardware, false);
  assert.equal(basic.capability, 'software');
  assert.equal(basic.preferSoftware, true);
  assert.match(basic.reasons[0], /伪显卡|未检测到/);

  const remote = gpu.classify([{ name: 'NVIDIA GeForce RTX 5060', status: 'OK' }], { sessionName: 'RDP-Tcp#2' });
  assert.equal(remote.remoteSession, true);
  assert.equal(remote.preferSoftware, true);
  assert.match(remote.reasons[0], /远程桌面/);
});

test('GPU classify: missing or unknown adapter information does not imply software-only hardware', () => {
  for (const rows of [[], [{ name: 'unknown' }], [{ name: '' }], [null]]) {
    const info = gpu.classify(rows);
    assert.equal(info.capability, 'unknown');
    assert.equal(info.preferSoftware, false);
    assert.equal(info.hardware, false);
    assert.match(gpu.summary(info), /未能确认显卡能力/);
    assert.doesNotMatch(gpu.summary(info), /未检测到可用显卡|伪显卡/);
    assert.equal(profileFor({ gpuMode: 'auto' }, info).gpu, 'host');
  }
});

for (const [name, options, expectedError, calls] of [
  ['Linux unsupported probe', { platform: 'linux' }, 'unsupported-platform', 0],
  ['macOS unsupported probe', { platform: 'darwin' }, 'unsupported-platform', 0],
  ['Windows timeout', { error: new Error('synthetic timeout') }, 'wmi-unavailable', 1],
  ['Windows malformed JSON', { stdout: '{broken json' }, 'wmi-invalid-response', 1],
  ['Windows empty adapter result', { stdout: '[]' }, 'wmi-no-adapters', 1],
]) {
  test(`GPU probe: ${name} preserves unknown capability and the automatic host default`, async () => {
    const fixture = isolatedGpu(options);
    const info = await fixture.gpu.probe();
    assert.equal(info.capability, 'unknown');
    assert.equal(info.preferSoftware, false);
    assert.equal(info.error, expectedError);
    assert.match(info.summary, /未知|未能确认/);
    assert.equal(profileFor({ gpuMode: 'auto' }, info).gpu, 'host');
    assert.equal(await fixture.gpu.probe(), info);
    assert.equal(fixture.calls(), calls);
  });
}

test('GPU probe: independent RDP evidence still prefers software when the adapter probe fails', async () => {
  const fixture = isolatedGpu({ sessionName: 'RDP-Tcp#2', error: new Error('synthetic timeout') });
  const info = await fixture.gpu.probe();
  assert.equal(info.capability, 'unknown');
  assert.equal(info.remoteSession, true);
  assert.equal(info.preferSoftware, true);
  assert.match(info.summary, /远程桌面/);
  assert.equal(profileFor({ gpuMode: 'auto' }, info).gpu, 'swangle');
});

test('auto profile: software-only host starts with swangle, manual pin wins', () => {
  const soft = gpu.classify([{ name: 'Microsoft Basic Display Adapter' }]);
  const p = doctor.autoProfile({
    settings: { engine: { gpuMode: 'auto', autoMemory: true } },
    accel: { ok: true }, emulatorVersion: '37.4.2.0', diskMB: 50000,
    host: HOST, gpuInfo: soft,
  });
  assert.equal(p.gpu, 'swangle', `software-only host should start with swangle, got ${p.gpu}`);
  assert.equal(p.gpuCandidates[0], 'swangle');
  assert.equal(p.gpuInfo.preferSoftware, true);
  assert.match(doctor.describeProfile(p), /自动软件渲染：.*伪显卡/);

  const pinned = doctor.autoProfile({
    settings: { engine: { gpuMode: 'host', autoMemory: true } },
    accel: { ok: true }, emulatorVersion: '37.4.2.0', diskMB: 50000,
    host: HOST, gpuInfo: soft,
  });
  assert.equal(pinned.gpu, 'host', 'manual backend selection must never be overridden');
  assert.equal(pinned.gpuPinned, true);
  assert.match(doctor.describeProfile(pinned), /host 渲染/);
  assert.doesNotMatch(doctor.describeProfile(pinned), /自动软件渲染|未检测到可用显卡/);
});

test('profile descriptions identify an actual software renderer and its remote-session reason', () => {
  const info = gpu.classify([{ name: 'NVIDIA GeForce RTX 5060', status: 'OK' }], { sessionName: 'RDP-Tcp#2' });
  const profile = profileFor({ gpuMode: 'auto' }, info);
  const description = doctor.describeProfile(profile);
  assert.match(description, /swangle 渲染/);
  assert.match(description, /自动软件渲染：当前是远程桌面会话/);
  assert.doesNotMatch(description, /未检测到可用显卡/);
  assert.doesNotMatch(doctor.describeProfile({ ...profile, gpu: 'host' }), /自动软件渲染/);
  assert.doesNotMatch(doctor.describeProfile(profileFor({ gpuMode: 'auto' }, gpu.classify([]))), /自动软件渲染/);
});

for (const version of ['37.4.2.0', '35.3.9']) {
  for (const backend of ['host', 'swangle', 'software', 'swiftshader', 'swiftshader_indirect', 'lavapipe', 'guest']) {
    test(`manual ${backend} stays pinned across all retry plans on emulator ${version}`, () => {
      const profile = profileFor({ gpuMode: backend }, gpu.classify([{ name: 'Microsoft Basic Display Adapter' }]), version);
      assert.equal(profile.gpu, backend);
      assert.equal(profile.gpuPinned, true);
      for (const preferSoftware of [false, true]) {
        const plans = doctor.planVariants(profile, { preferSoftware });
        assert.equal(plans.length, 3);
        assert(plans.every((plan) => plan.gpu === backend && plan.gpuPinned));
        assert.equal(plans[0].accel, 'on');
        assert.equal(plans[1].accel, 'off');
        assert.equal(plans[2].lastResort, true);
      }
    });
  }
}

test('invalid manual GPU values remain excluded from emulator arguments', () => {
  const profile = profileFor({ gpuMode: 'unknown-backend' });
  assert.equal(profile.gpuPinned, false);
  assert.equal(profile.gpu, 'host');
});

test('repeated TCG access violations do not rule out display drivers without evidence', () => {
  const diagnosis = doctor.tcgCrashDiagnosis();
  assert.equal(diagnosis.code, 'TCG_CRASH');
  assert.match(diagnosis.title, /重复访问冲突/);
  assert.match(diagnosis.hint, /不能确定.*显卡驱动/);
  assert.match(diagnosis.hint, /WHPX/);
  assert.match(diagnosis.hint, /AEHD/);
  assert.match(diagnosis.hint, /更新运行时/);
  assert.doesNotMatch(diagnosis.title + diagnosis.hint, /换渲染后端无效|不是显卡驱动|说明崩溃发生在模拟器本身/);
});

test('GPU diagnoses do not claim the selected renderer has already been changed', () => {
  for (const [line, code] of [
    ['emulator exit 3221225477', 'ACCESS_VIOLATION'],
    ['Failed to initialize GL emulation', 'GPU_INIT'],
    ['Unsupported gpu software', 'GPU_MODE'],
  ]) {
    const diagnosis = doctor.diagnose([line]);
    assert.equal(diagnosis.code, code);
    assert.doesNotMatch(diagnosis.hint, /已自动换用|已自动切换|已自动按运行时版本挑选|安卓侧画面本身是好的/);
  }
});

test('auto profile: real hybrid GPU keeps host first', () => {
  const hybrid = gpu.classify([
    { name: 'AMD Radeon 610M', status: 'OK' },
    { name: 'NVIDIA GeForce RTX 5060', status: 'OK' },
  ]);
  const p = doctor.autoProfile({
    settings: { engine: { gpuMode: 'auto', autoMemory: true } },
    accel: { ok: true }, emulatorVersion: '37.4.2.0', diskMB: 50000,
    host: HOST, gpuInfo: hybrid,
  });
  assert.equal(p.gpu, 'host');
  assert.equal(p.gpuInfo.hybrid, true);
});

test('GPU probe returns a stable cached shape on this platform', { skip: process.platform !== 'win32' }, async () => {
  const a = await gpu.probe({ force: true });
  const b = await gpu.probe();
  assert.equal(typeof a.summary, 'string');
  assert.ok(Array.isArray(a.adapters));
  assert.equal(typeof a.preferSoftware, 'boolean');
  assert.equal(a, b, 'second probe inside the cache window should reuse the result');
  if (a.adapters.length) assert.ok(a.adapters.some((x) => x.name && x.driverVersion !== undefined));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const gpu = require('../src/core/gpu');
const doctor = require('../src/core/doctor');

const HOST = { totalMB: 32768, freeMB: 16384, cores: 16, tmp: os.tmpdir() };

test('GPU classify: hybrid AMD + NVIDIA stays on hardware rendering', () => {
  const info = gpu.classify([
    { name: 'AMD Radeon(TM) 610M', driverVersion: '32.0.13034.7001', status: 'OK', adapterRam: 536870912 },
    { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driverVersion: '32.0.16.1062', status: 'OK', adapterRam: 4293918720 },
  ], { sessionName: 'Console' });
  assert.equal(info.hardware, true);
  assert.equal(info.hybrid, true);
  assert.equal(info.preferSoftware, false);
  assert.equal(info.adapters.length, 2);
  assert.match(gpu.summary(info), /混合显卡/);
  assert.match(gpu.summary(info), /32\.0\.13034\.7001/);
});

test('GPU classify: basic display / remote display must prefer software', () => {
  const basic = gpu.classify([{ name: 'Microsoft Basic Display Adapter', status: 'OK' }]);
  assert.equal(basic.hardware, false);
  assert.equal(basic.preferSoftware, true);
  assert.match(basic.reasons[0], /伪显卡|未检测到/);

  const remote = gpu.classify([{ name: 'NVIDIA GeForce RTX 5060', status: 'OK' }], { sessionName: 'RDP-Tcp#2' });
  assert.equal(remote.remoteSession, true);
  assert.equal(remote.preferSoftware, true);
  assert.match(remote.reasons[0], /远程桌面/);

  const none = gpu.classify([]);
  assert.equal(none.preferSoftware, true);
  assert.equal(none.hardware, false);
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
  assert.match(doctor.describeProfile(p), /未检测到可用显卡，已自动软件渲染/);

  const pinned = doctor.autoProfile({
    settings: { engine: { gpuMode: 'host', autoMemory: true } },
    accel: { ok: true }, emulatorVersion: '37.4.2.0', diskMB: 50000,
    host: HOST, gpuInfo: soft,
  });
  assert.equal(pinned.gpu, 'host', 'manual backend selection must never be overridden');
  assert.equal(pinned.gpuPinned, true);
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

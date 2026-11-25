'use strict';
// Execute the production IPC registration with read-only runtime/probe fixtures.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const doctor = require('../src/core/doctor');
const gpu = require('../src/core/gpu');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const start = source.indexOf("  ipcMain.handle('doctor:profile', async () => {");
const end = source.indexOf("\n  ipcMain.handle('doctor:report'", start);
assert(start >= 0 && end > start, 'production doctor:profile handler boundary changed');
const registration = source.slice(start, end);
const NOW = 1700000000000;
const HOST = { totalMB: 32768, freeMB: 24000, cores: 16, tmp: 'fixture' };
const GPU = gpu.classify([{ name: 'Fixture GPU', driverVersion: '1.0', status: 'OK' }]);

function fixture(engine = {}) {
  let handler;
  const state = {
    settings: { engine: { headless: false, windowMode: 'auto', gpuMode: 'auto', ...engine } },
    env: { accel: { ok: true, kind: 'whpx' }, emulator: { version: '37.4.1' } },
    gpuInfo: GPU, running: false, online: false, profile: null,
    envError: false, gpuError: false, onlineError: false,
  };
  const calls = { online: 0, profile: [] };
  const choose = options => doctor.chooseProfile({ ...options, host: HOST, now: NOW,
    overrides: doctor.overridesFromSettings(options.settings.engine) });
  const exposedDoctor = {
    ...doctor,
    freeDiskMB: () => 100000,
    autoProfile(options) {
      calls.profile.push(options);
      return choose(options);
    },
  };
  const h = {
    ipcMain: { handle(channel, callback) { assert.equal(channel, 'doctor:profile'); handler = callback; } },
    store: { DATA_DIR: 'fixture', getSettings: () => state.settings },
    platform: { canEmbed: true },
    runtime: {
      provisioner: { checkEnv: async () => {
        if (state.envError) throw new Error('synthetic environment failure');
        return state.env;
      } },
      emulator: { get profile() { return state.profile; }, running: () => state.running },
      client: () => ({ isOnline: async () => {
        calls.online++;
        if (state.onlineError) throw new Error('synthetic device query failure');
        return state.online;
      } }),
    },
    require(name) {
      if (name === './core/doctor') return exposedDoctor;
      assert.equal(name, './core/gpu');
      return { summary: gpu.summary, probe: async () => {
        if (state.gpuError) throw new Error('synthetic GPU query failure');
        return state.gpuInfo;
      } };
    },
  };
  vm.runInNewContext(registration, h, { filename: 'main.js doctor:profile' });
  assert.equal(typeof handler, 'function');
  const predict = () => choose({ settings: state.settings, accel: state.env.accel,
    emulatorVersion: state.env.emulator.version, diskMB: 100000, gpuInfo: state.gpuInfo,
    headless: state.settings.engine.headless !== false, canEmbed: h.platform.canEmbed });
  return { state, calls, invoke: () => handler(), predict };
}

test('doctor profile IPC predicts bounded GPU backoff and exposes the fallback reason', async () => {
  const f = fixture();
  Object.assign(f.state.settings.engine, { badGpu: '37.4.1|host', badGpuAt: NOW - 1000,
    badGpuReason: 'GPU_INIT', badGpuContext: doctor.gpuFailureContext({ gpuInfo: GPU }) });
  const result = await f.invoke();
  assert.equal(result.profile.gpu, 'swangle');
  assert.match(result.text, /swangle 渲染/);
  assert.match(result.fallbackReason, /host.*swangle.*24/);
  assert.equal(result.pending, false);
  assert.equal(result.running, '');
  assert.equal(f.calls.profile[0].headless, false);
  assert.equal(f.calls.profile[0].canEmbed, true);
});

for (const headless of [false, true]) {
  test(`doctor profile IPC includes forced embedding with headless=${headless}`, async () => {
    const f = fixture({ windowMode: 'embedded', headless });
    assert.equal((await f.invoke()).profile.gpu, headless ? 'host' : 'swangle');
  });
}

test('doctor profile IPC describes the actual current process plan independently from the next plan', async () => {
  const f = fixture();
  f.state.running = true;
  f.state.profile = { ...f.predict(), gpu: 'swangle', memoryMB: 6144,
    acceleration: { policy: 'emulator-default', confirmed: true } };
  const result = await f.invoke();
  assert.match(result.text, /8\.0GB.*host 渲染/);
  assert.match(result.running, /6\.0GB.*swangle 渲染.*运行日志已确认/);
  assert.equal(result.pending, true);
  assert.match(result.why, /停止运行时后重新启动/);
  assert.equal(f.calls.online, 0, 'an owned current process plan does not need an unrelated device query');
});

test('doctor profile IPC drops a stopped process stale plan rather than presenting it as running', async () => {
  const f = fixture();
  f.state.profile = { ...f.predict(), gpu: 'swangle' };
  const result = await f.invoke();
  assert.equal(result.profile.gpu, 'host');
  assert.equal(result.running, '');
  assert.equal(result.pending, false);
  assert.doesNotMatch(result.why, /停止运行时后重新启动/);
  assert.equal(f.calls.online, 1);
});

for (const hasStaleProfile of [false, true]) {
  test(`doctor profile IPC labels online adopted runtime parameters as unknown${hasStaleProfile ? ' despite an old plan' : ''}`, async () => {
    const f = fixture();
    f.state.online = true;
    if (hasStaleProfile) f.state.profile = { ...f.predict(), gpu: 'swangle' };
    const result = await f.invoke();
    assert.match(result.running, /^已连接安卓.*实际启动参数待确认$/);
    assert.doesNotMatch(result.running, /host|swangle|GB/);
    assert.equal(result.pending, false);
  });
}

test('doctor profile IPC preserves unknown running state when the device query fails', async () => {
  const f = fixture();
  f.state.onlineError = true;
  const result = await f.invoke();
  assert.equal(result.running, '安卓运行状态待确认');
  assert.equal(result.pending, false);
});

test('doctor profile IPC handles a live process without a known plan as an online unknown runtime', async () => {
  const f = fixture();
  f.state.running = true;
  f.state.online = true;
  const result = await f.invoke();
  assert.equal(result.running, '已连接安卓，实际启动参数待确认');
  assert.equal(result.pending, false);
});

for (const changed of ['accel', 'lite']) {
  test(`doctor profile IPC includes ${changed} in pending startup differences`, async () => {
    const f = fixture();
    f.state.running = true;
    f.state.profile = { ...f.predict() };
    assert.equal((await f.invoke()).pending, false);
    f.state.profile[changed] = changed === 'accel' ? 'off' : !f.state.profile.lite;
    const result = await f.invoke();
    assert.equal(result.pending, true);
    assert.match(result.why, /当前运行参数与下次启动计划不同/);
  });
}

test('doctor profile IPC falls back to current acceleration evidence when environment and GPU probes fail', async () => {
  const f = fixture();
  f.state.profile = f.predict();
  f.state.running = true;
  f.state.envError = true;
  f.state.gpuError = true;
  const result = await f.invoke();
  assert.equal(result.profile.accelOk, true);
  assert.equal(result.profile.gpu, 'host');
  assert.equal(result.gpu, null);
  assert.match(result.running, /host 渲染/);
});

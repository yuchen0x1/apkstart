'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RuntimeActions, channelMode } = require('../src/core/runtime-actions');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('device operations only target supported selected systems, including stopped selection', async () => {
  let state = { current: { systemId: 'google-play' } };
  const gate = new RuntimeActions({ status: async () => state });
  assert.equal(await gate.run('apk:install', () => 7), 7);
  for (const systemId of ['bliss-os', 'android-x86', 'custom', 'unknown']) {
    state = { current: { systemId, running: false } };
    let ran = false;
    await assert.rejects(gate.run('apk:install', () => { ran = true; }), /尚未接入/);
    assert.equal(ran, false);
  }
  for (const stateKey of ['switching', 'stopping']) {
    state = { current: { systemId: 'aosp' }, [stateKey]: true };
    await assert.rejects(gate.run('app:launch', () => assert.fail()), /切换或停止/);
  }
});
test('gate is acquired before status await and held through the actual device operation', async () => {
  const status = deferred(), work = deferred();
  const gate = new RuntimeActions({ status: () => status.promise });
  const install = gate.run('apk:install', () => work.promise);
  await assert.rejects(gate.run('system:switch', () => assert.fail(), { builtin: false }), /等待/);
  status.resolve({ current: { systemId: 'google-apis' } });
  await Promise.resolve();
  await assert.rejects(gate.run('system:switch', () => assert.fail(), { builtin: false }), /等待/);
  work.resolve('installed');
  assert.equal(await install, 'installed');
  assert.equal(await gate.run('system:switch', () => 'switched', { builtin: false }), 'switched');
});
test('stop can cancel a provider switch without allowing app actions until both settle', async () => {
  const switching = deferred(), stopping = deferred();
  const gate = new RuntimeActions({ status: () => assert.fail() });
  const first = gate.run('system:switch', () => switching.promise, { builtin: false });
  const stop = gate.run('system:stop', () => stopping.promise, { builtin: false });
  await assert.rejects(gate.run('apk:install', () => assert.fail()), /等待/);
  switching.resolve();
  await first;
  await assert.rejects(gate.run('app:launch', () => assert.fail()), /等待/);
  stopping.resolve();
  await stop;
  assert.equal(gate.active.size, 0);
});
test('quitting before or during status read prevents new device work and errors release the lease', async () => {
  let quitting = false;
  const status = deferred();
  const gate = new RuntimeActions({ status: () => status.promise, isQuitting: () => quitting });
  const action = gate.run('app:launch', () => assert.fail());
  quitting = true;
  status.resolve({ current: { systemId: 'aosp' } });
  await assert.rejects(action, /退出/);
  await assert.rejects(gate.run('system:switch', () => assert.fail(), { builtin: false }), /退出/);
  assert.equal(gate.active.size, 0);
  quitting = false;
  await assert.rejects(gate.run('app:launch', () => { throw new Error('device offline'); }), /offline/);
  assert.equal(gate.active.size, 0);
});
test('queued window cleanup is not dropped during an install or overtaken by a route change', async () => {
  const gate = new RuntimeActions({ status: async () => ({ current: { systemId: 'aosp' } }) });
  const install = deferred(), finishClose = deferred();
  const events = [];
  const installing = gate.run('apk:install', () => install.promise);
  const closing = gate.run('app:close', () => { events.push('close'); return finishClose.promise; },
    { builtin: false, afterCurrent: true });
  assert.deepEqual(events, []);
  await assert.rejects(gate.run('settings:set', () => assert.fail(), { builtin: false }), /等待/);
  install.resolve();
  await installing;
  await Promise.resolve();
  assert.deepEqual(events, ['close']);
  await assert.rejects(gate.run('settings:set', () => assert.fail(), { builtin: false }), /等待/);
  finishClose.resolve();
  await closing;
  assert.equal(gate.active.size, 0);
});
test('queued cleanup does not start touching the guest after quit', async () => {
  let quitting = false;
  const gate = new RuntimeActions({ status: () => assert.fail(), isQuitting: () => quitting });
  const work = deferred();
  const active = gate.run('apk:install', () => work.promise, { builtin: false });
  const closing = gate.run('app:close', () => assert.fail(), { builtin: false, afterCurrent: true });
  quitting = true;
  work.resolve();
  await active;
  await assert.rejects(closing, /退出/);
  assert.equal(await gate.drain(), true);
});
test('production IPC applies the same gate to mutations without locking read-only polling', () => {
  for (const channel of ['app:restore', 'app:clearData', 'runtime:setDataSize', 'runtime:resetData', 'share:sync', 'android:grantAll']) {
    assert.deepEqual(channelMode(channel), { builtin: true });
  }
  assert.deepEqual(channelMode('system:switch'), { builtin: false });
  for (const channel of ['settings:get', 'app:theme', 'apps:list', 'system:tasks', 'system:status']) assert.equal(channelMode(channel), null);
});

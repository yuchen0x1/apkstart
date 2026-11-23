'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const staging = require('../src/core/runtime-staging');

function fixture(root) {
  fs.mkdirSync(path.join(root, 'emulator'), { recursive: true });
  fs.mkdirSync(path.join(root, 'platform-tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator'), 'emulator');
  fs.writeFileSync(path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'), 'adb');
  fs.writeFileSync(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 'kernel');
  fs.writeFileSync(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 'image');
}

test('Windows Store paths are treated as package-owned read-only locations', () => {
  assert.equal(staging.isWindowsAppsPath('C:\\Program Files\\WindowsApps\\RoutineMiku.ApkStart\\runtime'), true);
  assert.equal(staging.isWindowsAppsPath('D:\\Apps\\ApkStart\\runtime'), false);
  assert.equal(staging.isWindowsAppsPath('/opt/windowsapps/runtime'), true);
});

test('bundled runtime staging is complete, reusable and never accepts a partial copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-runtime-stage-'));
  const source = path.join(root, 'source');
  const data = path.join(root, 'data');
  try {
    fixture(source);
    fs.mkdirSync(data, { recursive: true });
    assert.equal(staging.isCompleteRuntime(source), true);
    const first = staging.stageBundledRuntime({ source, dataDir: data });
    assert.equal(first.ok, true);
    assert.equal(first.reused, false);
    assert.equal(staging.isCompleteRuntime(first.root), true);
    assert.equal(fs.readFileSync(path.join(first.root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'), 'utf8'), 'adb');
    assert.equal(fs.existsSync(path.join(first.root, '.runtime-staging.json')), true);
    const second = staging.stageBundledRuntime({ source, dataDir: data });
    assert.equal(second.root, first.root);
    assert.equal(second.reused, true);

    fs.rmSync(path.join(source, 'system-images'), { recursive: true, force: true });
    assert.equal(staging.isCompleteRuntime(source), false);
    assert.throws(() => staging.stageBundledRuntime({ source, dataDir: data }), /内置运行时不完整/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';
// A separate Node process loads only store's pure dependencies, never Electron or ADB.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('child settings retain private routing and cannot change shared runtime or global integration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-instance-settings-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    const base = path.join(root, 'apkstart');
    const data = path.join(base, 'instances', id);
    const runtime = path.join(base, 'runtime');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(runtime);
    const parent = path.join(base, 'settings.json');
    fs.writeFileSync(parent, '{"sentinel":"parent-settings-untouched"}');
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
      runtime: { dir: runtime, avdDir: path.join(base, 'parent-avd'), selectedSystemId: 'android-x86', diskPath: path.join(base, 'parent.qcow2') },
      engine: { mode: 'attach', prewarm: true, qemuPath: 'untrusted-qemu' },
      autoStart: true, autoDeploy: true, update: { autoUpdate: true },
    }));
    const script = `
      const assert = require('node:assert/strict');
      const store = require(${JSON.stringify(path.resolve(__dirname, '../src/core/store.js'))});
      const context = require(${JSON.stringify(path.resolve(__dirname, '../src/core/instance-context.js'))}).current();
      assert.equal(store.isChild, true);
      assert.equal(store.DATA_DIR, context.dataDir);
      const initial = store.getSettings();
      assert.equal(initial.runtime.avdDir, context.avdDir);
      assert.equal(initial.runtime.selectedSystemId, 'google-play');
      assert.equal(initial.runtime.diskPath, '');
      assert.equal(initial.engine.qemuPath, '');
      assert.equal(initial.engine.mode, 'builtin');
      assert.equal(initial.engine.prewarm, false);
      assert.equal(initial.autoStart, false);
      assert.equal(initial.autoDeploy, false);
      assert.equal(initial.update.autoUpdate, false);
      store.saveSettings({runtime:{dir:'elsewhere',avdDir:'elsewhere',selectedSystemId:'bliss-os'},
        engine:{mode:'attach',qemuPath:'elsewhere',prewarm:true},adbPath:'elsewhere',device:'other-device',
        autoStart:true,autoDeploy:true,update:{autoUpdate:true},language:'es-ES',theme:'dark',
        peripherals:{refreshRate:90}});
      const after = store.getSettings();
      assert.equal(after.runtime.dir, initial.runtime.dir);
      assert.equal(after.runtime.avdDir, context.avdDir);
      assert.equal(after.runtime.selectedSystemId, 'google-play');
      assert.equal(after.engine.mode, 'builtin');
      assert.equal(after.adbPath, initial.adbPath);
      assert.equal(after.device, initial.device);
      assert.equal(after.autoStart, false);
      assert.equal(after.autoDeploy, false);
      assert.equal(after.update.autoUpdate, false);
      assert.equal(after.language, 'es-ES');
      assert.equal(after.theme, 'dark');
      assert.equal(after.peripherals.refreshRate, 90);
      assert.throws(() => store.saveSettings({peripherals:{cameraBack:'webcam0,-no-window'}}));
    `;
    execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), timeout: 15000,
      env: { ...process.env, APPDATA: root, XDG_DATA_HOME: root, APKSTART_INSTANCE_ID: id },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    assert.equal(fs.readFileSync(parent, 'utf8'), '{"sentinel":"parent-settings-untouched"}');
    assert(!fs.existsSync(path.join(base, 'parent-avd')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

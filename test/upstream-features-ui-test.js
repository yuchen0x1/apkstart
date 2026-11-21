'use strict';
/**
 * Focused Electron acceptance for the upstream #102/#110 UI.
 * All IPC is handled by test/lib/ui-fixtures.js: no product main, ADB, QEMU,
 * camera, filesystem picker, network request, child process or real device.
 *
 * Run: node test/run-electron.js upstream
 * Optional: UI_AUDIT_SCALE=1.25, UPSTREAM_UI_DIR=<directory>
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFixture } = require('./lib/ui-fixtures');
const { runUpstreamFeatures } = require('./lib/ui-interactions');

const SRC = path.join(__dirname, '..', 'src');
const out = process.env.UPSTREAM_UI_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upstream-ui-'));
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upstream-profile-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const fixture = createFixture();
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  for (const channel of new Set([...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map(match => match[1]))) {
    ipcMain.handle(channel, async (_event, payload) => fixture.respond(channel, payload));
  }
  const window = new BrowserWindow({
    width: 1140, height: 740, useContentSize: true, show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'), additionalArguments: ['--apkstart-role=main'],
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false, spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !/^(file:|data:|devtools:)/.test(details.url) });
  });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.on('preload-error', (_event, _file, error) => errors.push(String(error)));
  const js = code => window.webContents.executeJavaScript(code).catch(error => {
    throw new Error(`${error.message}\nRenderer script: ${String(code).slice(0, 400)}`);
  });
  const waitFor = async (expression, timeout = 8000) => {
    await js(`new Promise((resolve, reject) => {
      const deadline = performance.now() + ${timeout};
      const poll = () => {
        if (${expression}) return resolve(true);
        if (performance.now() > deadline) return reject(new Error('等待超时：' + ${JSON.stringify(expression)}));
        setTimeout(poll, 20);
      };
      poll();
    })`);
  };
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  };
  const capture = async name => {
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.writeFileSync(path.join(out, `${name}.png`), (await window.webContents.capturePage()).toPNG());
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  };

  await window.loadFile(path.join(SRC, 'ui', 'index.html'));
  const requestedScale = Number(process.env.UI_AUDIT_SCALE || 0);
  if ([1, 1.25, 1.5, 2].includes(requestedScale)) {
    // Offscreen windows may ignore CLI DPI switches; match the full UI harness
    // by explicitly emulating density. runUpstreamFeatures verifies the result.
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 0, height: 0, deviceScaleFactor: requestedScale, mobile: false,
    });
  }
  await waitFor("typeof window.apkAutomation?.mount === 'function' && !!document.getElementById('btnSettings') && document.querySelectorAll('.card').length >= 3");
  await js('(async () => { await refreshApps(); await refreshStatus(); })()');
  await runUpstreamFeatures({ win: window, fixture, check, capture });

  check('上游功能验收无渲染层错误', errors.length === 0, errors);
  const failed = checks.filter(item => !item.ok);
  console.log(`UPSTREAM_UI_SCREENSHOTS=${out}`);
  console.log(`UPSTREAM_UI_SUMMARY=${JSON.stringify({ checks: checks.length, failed: failed.length, screenshots: out })}`);
  for (const item of failed) console.log(`FAILED: ${item.name}${item.detail === undefined ? '' : ' ' + JSON.stringify(item.detail)}`);
  for (const browserWindow of BrowserWindow.getAllWindows()) browserWindow.destroy();
  app.exit(failed.length ? 1 : 0);
}).catch(error => {
  console.error('UPSTREAM_UI_FAILED:', error.stack || error);
  app.exit(1);
});

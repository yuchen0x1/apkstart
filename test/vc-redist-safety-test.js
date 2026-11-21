'use strict';
/**
 * VC++ repair launch safety.
 * The production helper and handler are evaluated in isolation. The live
 * PowerShell test replaces Start-Process with a recorder and never launches
 * an installer or UAC prompt.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

function extractFunction(signature, endMarker) {
  const start = MAIN.indexOf(signature);
  assert.ok(start >= 0, `main.js must contain ${signature}`);
  const end = MAIN.indexOf(endMarker, start);
  assert.ok(end > start, `${signature} must have a bounded body`);
  return MAIN.slice(start, end).trim();
}

const BUILD_SOURCE = extractFunction(
  'function buildVcRedistLaunch(file) {',
  '\n\n/**\n * 轻量文件日志',
);
const INSTALL_SOURCE = extractFunction(
  'async function installVcRedistImpl() {',
  "\n  ipcMain.handle('runtime:installVcRedist'",
);

function makeLaunchBuilder() {
  return vm.runInNewContext(`(${BUILD_SOURCE})`, {
    process: { env: {} },
  }, { filename: 'main.js VC++ launch builder' });
}

function makeInstallFunction(file, buildVcRedistLaunch) {
  let captured = null;
  const fakeSpawn = (command, args, options) => {
    captured = { command, args, options };
    return {
      on(event, callback) {
        // Resolve the production promise without creating any child process.
        if (event === 'exit') callback(0);
        return this;
      },
    };
  };
  const fakeRequire = (request) => {
    if (request === 'child_process') return { spawn: fakeSpawn };
    if (request === './core/doctor') return { vcRedistOk: () => true };
    throw new Error(`unexpected require: ${request}`);
  };
  const install = vm.runInNewContext(`(${INSTALL_SOURCE})`, {
    buildVcRedistLaunch,
    vcRedistInstaller: () => file,
    require: fakeRequire,
    process: { env: {} },
  }, { filename: 'main.js VC++ installer handler' });
  return { install, getCaptured: () => captured };
}

function adversarialPath(root) {
  // Every character below is legal in a Windows path component. If the old
  // command interpolates this path into PowerShell source, the $() expression
  // writes the injection marker.
  return path.join(
    root,
    "$(Set-Content (Get-Variable injection -ValueOnly) injected) `tick` 'quote' 空间",
    'vc_redist.x64.exe',
  );
}

function powershellPath() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
}

function runPowerShellRecorder(command, record, injection, extraEnv = {}) {
  const powershell = powershellPath();
  const script = [
    '$record = $env:APKSTART_VC_RECORD',
    '$injection = $env:APKSTART_VC_INJECTION',
    'function Start-Process {',
    '  param([string]$FilePath, [object[]]$ArgumentList, [string]$Verb, [switch]$Wait)',
    '  $payload = [ordered]@{',
    '    filePath = $FilePath',
    '    argumentList = @($ArgumentList)',
    '    verb = $Verb',
    '    wait = $Wait.IsPresent',
    '  }',
    '  [IO.File]::WriteAllText($record, ($payload | ConvertTo-Json -Compress))',
    '}',
    '& ([scriptblock]::Create($env:APKSTART_VC_COMMAND))',
  ].join('\r\n');
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    env: {
      ...process.env,
      ...extraEnv,
      APKSTART_VC_COMMAND: command,
      APKSTART_VC_RECORD: record,
      APKSTART_VC_INJECTION: injection,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function readRecording(file) {
  assert.equal(fs.existsSync(file), true, 'stubbed Start-Process must record a call');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('VC++ installer handler wires the production path as PowerShell data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-vc-wiring-'));
  try {
    const file = adversarialPath(root);
    const build = makeLaunchBuilder();
    const { install, getCaptured } = makeInstallFunction(file, build);

    const result = await install();
    assert.equal(result.ok, true);
    const call = getCaptured();
    assert.ok(call, 'production handler must call spawn');
    assert.equal(call.command, 'powershell.exe');
    assert.equal(call.args[0], '-NoProfile');
    assert.equal(call.args[1], '-Command');
    assert.equal(call.args[2], build(file).command);
    assert.equal(call.args[2].includes(file), false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.stdio, 'ignore');
    assert.equal(call.options.env.APKSTART_VC_REDIST, file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PowerShell negative control: old interpolation injects, fixed command preserves path', (t) => {
  if (process.platform !== 'win32') {
    t.skip('actual PowerShell semantics are Windows-only');
    return;
  }
  const powershell = powershellPath();
  if (!fs.existsSync(powershell)) {
    t.skip('Windows PowerShell is unavailable');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-vc-powershell-'));
  try {
    const file = adversarialPath(root);
    const oldRecord = path.join(root, 'old-record.json');
    const oldInjection = path.join(root, 'old-injection.txt');
    const oldCommand = `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`;

    // The old production form is executed only against the local recorder.
    runPowerShellRecorder(oldCommand, oldRecord, oldInjection);
    assert.equal(fs.readFileSync(oldInjection, 'utf8').trim(), 'injected');
    readRecording(oldRecord);

    const fixedRecord = path.join(root, 'fixed-record.json');
    const fixedInjection = path.join(root, 'fixed-injection.txt');
    const fixed = makeLaunchBuilder()(file);
    runPowerShellRecorder(fixed.command, fixedRecord, fixedInjection, fixed.env);
    const seen = readRecording(fixedRecord);
    assert.equal(seen.filePath, file);
    assert.deepEqual(seen.argumentList, ['/quiet', '/norestart']);
    assert.equal(seen.verb, 'RunAs');
    assert.equal(seen.wait, true);
    assert.equal(fs.existsSync(fixedInjection), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

/** 卸载清理脚本的 Windows 夹具测试：确认运行时、AVD、共享目录和 TEMP 残留都会被删除。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('卸载清理测试：非 Windows，跳过');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-uninstall-test-'));
const data = path.join(root, 'data');
const runtime = path.join(root, 'runtime');
const avd = path.join(root, 'avd');
const shared = path.join(root, 'shared');
const tempRoot = path.join(root, 'temp');
const desktop = path.join(root, 'desktop');
const startMenu = path.join(root, 'Start Menu', 'Programs', 'ApkStart');
const iconDir = path.join(data, 'icons');
const script = path.join(root, 'uninstall-data.ps1');
const shortcutCreator = path.join(root, 'create-shortcut.ps1');
const leftover = path.join(tempRoot, 'apkstart-leftover-fixture');
const desktopShortcut = path.join(desktop, 'Sample App.lnk');
const startMenuShortcut = path.join(startMenu, 'Sample App.lnk');
const legacyDesktopShortcut = path.join(desktop, 'Legacy App.lnk');
const legacyStartMenuShortcut = path.join(startMenu, 'Legacy App.lnk');
const unrelatedShortcut = path.join(desktop, 'Keep Me.lnk');
const source = path.join(__dirname, '..', 'build', 'uninstall-data.ps1');

try {
  for (const dir of [data, runtime, avd, shared, tempRoot, leftover, desktop, startMenu, iconDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(desktopShortcut, 'desktop shortcut', 'utf8');
  fs.writeFileSync(startMenuShortcut, 'start menu shortcut', 'utf8');
  fs.writeFileSync(shortcutCreator, [
    'param([string]$Path, [string]$Target, [string]$Arguments, [string]$Icon)',
    '$shell = New-Object -ComObject WScript.Shell',
    '$s = $shell.CreateShortcut($Path)',
    '$s.TargetPath = $Target',
    '$s.Arguments = $Arguments',
    '$s.IconLocation = $Icon',
    '$s.Save()',
  ].join('\n'), 'utf8');
  const createShortcut = (shortcutPath, targetPath, args, iconPath) => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shortcutCreator,
      '-Path', shortcutPath, '-Target', targetPath, '-Arguments', args, '-Icon', iconPath,
    ], { windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  createShortcut(legacyDesktopShortcut, path.join(root, 'ApkStart.exe'), '--launch "legacy.desktop"', path.join(iconDir, 'legacy.ico'));
  createShortcut(legacyStartMenuShortcut, path.join(root, 'ApkStart.exe'), '--launch "legacy.start"', path.join(iconDir, 'legacy.ico'));
  createShortcut(unrelatedShortcut, 'C:\\Windows\\notepad.exe', '--open "keep-me"', 'C:\\Windows\\notepad.exe,0');
  fs.writeFileSync(path.join(data, 'apps.json'), JSON.stringify({
    apps: [{ shortcutPath: desktopShortcut, startMenuPath: startMenuShortcut }],
  }), 'utf8');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    runtime: { dir: runtime, avdDir: avd },
    sharedDir: shared,
  }), 'utf8');
  fs.copyFileSync(source, script);
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DataDir', data, '-TempDir', tempRoot, '-DesktopDir', desktop,
    '-StartMenuDir', path.dirname(startMenu),
  ], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.error, undefined, r.error && r.error.message);
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  for (const dir of [data, runtime, avd, shared, leftover, desktopShortcut, startMenuShortcut, legacyDesktopShortcut, legacyStartMenuShortcut]) {
    assert(!fs.existsSync(dir), `卸载后仍残留：${dir}`);
  }
  assert(fs.existsSync(unrelatedShortcut), `误删了非 ApkStart 快捷方式：${unrelatedShortcut}`);
  console.log('卸载清理测试：1 通过，0 失败');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(leftover, { recursive: true, force: true });
}

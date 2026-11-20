'use strict';

/** 卸载清理只删除应用管理的文件，保留共享目录与自选目录的其它资料。 */
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
  const ownedRuntime = path.join(runtime, 'emulator');
  const ownedAvd = path.join(avd, 'apkstart.avd');
  for (const dir of [ownedRuntime, ownedAvd]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(ownedRuntime, 'emulator.exe'), 'fixture');
  fs.writeFileSync(path.join(ownedAvd, 'userdata-qemu.img'), 'fixture');
  fs.writeFileSync(path.join(runtime, 'keep-runtime-notes.txt'), 'personal');
  fs.writeFileSync(path.join(avd, 'keep-avd-notes.txt'), 'personal');
  fs.writeFileSync(path.join(shared, 'valuable.txt'), 'personal');
  fs.writeFileSync(path.join(leftover, 'active-session.txt'), 'personal');
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
  for (const dir of [data, ownedRuntime, ownedAvd, desktopShortcut, startMenuShortcut, legacyDesktopShortcut, legacyStartMenuShortcut]) {
    assert(!fs.existsSync(dir), `卸载后仍残留：${dir}`);
  }
  for (const file of [path.join(runtime, 'keep-runtime-notes.txt'), path.join(avd, 'keep-avd-notes.txt'), path.join(shared, 'valuable.txt'), path.join(leftover, 'active-session.txt')]) {
    assert(fs.existsSync(file), `误删了用户资料或其它会话：${file}`);
  }
  assert(fs.existsSync(unrelatedShortcut), `误删了非 ApkStart 快捷方式：${unrelatedShortcut}`);

  // 共享文件夹嵌在缓存内、受管目录是 junction 时，也不能跟随删除用户资料。
  const nestedData = path.join(root, 'nested-data');
  const nestedShared = path.join(nestedData, 'cache', 'shared');
  const external = path.join(root, 'outside');
  fs.mkdirSync(nestedShared, { recursive: true });
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(nestedShared, 'keep.txt'), 'shared');
  fs.writeFileSync(path.join(external, 'keep.txt'), 'outside');
  fs.writeFileSync(path.join(nestedData, 'settings.json'), JSON.stringify({ sharedDir: nestedShared }), 'utf8');
  fs.symlinkSync(external, path.join(nestedData, 'icons'), 'junction');
  const nested = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DataDir', nestedData, '-TempDir', tempRoot, '-DesktopDir', desktop,
    '-StartMenuDir', path.dirname(startMenu),
  ], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(nested.status, 0, `${nested.stdout}\n${nested.stderr}`);
  assert(fs.existsSync(path.join(nestedShared, 'keep.txt')), '嵌在缓存内的共享文件必须保留');
  assert(fs.existsSync(path.join(external, 'keep.txt')), '不能跟随 junction 删除外部文件');
  assert(!fs.existsSync(path.join(nestedData, 'settings.json')), '受管设置应被删除');
  console.log('卸载清理测试：2 通过，0 失败');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(leftover, { recursive: true, force: true });
}

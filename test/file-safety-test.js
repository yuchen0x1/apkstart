'use strict';
/** 文件迁移和真实 IPC 回归，不启动 Electron 或模拟器。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { copyDirContents } = require('../src/core/file-migration');
const backup = require('../src/core/backup');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-files-test-'));
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('  ✓ ' + name);
}
function pair(name) {
  const oldDir = path.join(ROOT, name, 'old');
  const newDir = path.join(ROOT, name, 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  return { oldDir, newDir };
}
function handler(channel, next, context) {
  const start = source.indexOf(`  ipcMain.handle('${channel}',`);
  const end = source.indexOf(`  ipcMain.handle('${next}',`, start + 1);
  assert(start >= 0 && end > start, '找不到真实 IPC 实现');
  let callback;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_channel, fn) => { callback = fn; } },
    fs, path, os, backup, filetype: require('../src/core/filetype'), ...context,
  });
  return callback;
}

(async () => {
  await test('迁移保留源和目标原文件，并复制空目录', () => {
    const { oldDir, newDir } = pair('normal');
    fs.writeFileSync(path.join(oldDir, 'copy.txt'), 'source');
    fs.mkdirSync(path.join(oldDir, 'empty'));
    fs.writeFileSync(path.join(newDir, 'keep.txt'), 'destination');
    assert.strictEqual(copyDirContents(oldDir, newDir).copied, 1);
    assert.strictEqual(fs.readFileSync(path.join(oldDir, 'copy.txt'), 'utf8'), 'source');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'copy.txt'), 'utf8'), 'source');
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'keep.txt'), 'utf8'), 'destination');
    assert(fs.statSync(path.join(newDir, 'empty')).isDirectory());
  });
  await test('冲突在复制前拒绝，不覆盖目标也不改源', () => {
    const { oldDir, newDir } = pair('conflict');
    fs.writeFileSync(path.join(oldDir, 'a.txt'), 'new file');
    fs.writeFileSync(path.join(oldDir, 'z.txt'), 'source');
    fs.writeFileSync(path.join(newDir, 'z.txt'), 'valuable');
    assert.throws(() => copyDirContents(oldDir, newDir), /同名/);
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'z.txt'), 'utf8'), 'valuable');
    assert(!fs.existsSync(path.join(newDir, 'a.txt')));
  });
  await test('复制中途失败回收本次新文件，不损坏源和目标已有文件', () => {
    const { oldDir, newDir } = pair('rollback');
    for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(oldDir, name), name);
    fs.writeFileSync(path.join(newDir, 'keep.txt'), 'keep');
    const copy = fs.copyFileSync;
    let calls = 0;
    fs.copyFileSync = (...args) => { if (++calls === 2) throw new Error('模拟磁盘已满'); return copy(...args); };
    try { assert.throws(() => copyDirContents(oldDir, newDir), /磁盘已满/); }
    finally { fs.copyFileSync = copy; }
    assert(!fs.existsSync(path.join(newDir, 'a.txt')));
    assert(!fs.existsSync(path.join(newDir, 'b.txt')));
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'keep.txt'), 'utf8'), 'keep');
    assert(fs.existsSync(path.join(oldDir, 'a.txt')) && fs.existsSync(path.join(oldDir, 'b.txt')));
  });
  await test('相同内容不会冲突，重复迁移幂等', () => {
    const { oldDir, newDir } = pair('equal');
    fs.writeFileSync(path.join(oldDir, 'same.txt'), 'same');
    fs.writeFileSync(path.join(newDir, 'same.txt'), 'same');
    assert.strictEqual(copyDirContents(oldDir, newDir).copied, 0);
    assert.strictEqual(copyDirContents(oldDir, oldDir).copied, 0);
  });
  await test('拒绝子目录、父目录和相对路径，不开始递归', () => {
    const { oldDir } = pair('nested');
    const child = path.join(oldDir, 'child');
    assert.throws(() => copyDirContents(oldDir, child), /父子/);
    assert(!fs.existsSync(child));
    assert.throws(() => copyDirContents(oldDir, path.dirname(oldDir)), /父子/);
    assert.throws(() => copyDirContents(oldDir, 'relative'), /绝对路径/);
  });
  await test('拒绝目录 junction，不能写进外部位置', () => {
    const { oldDir, newDir } = pair('links');
    const outside = path.join(ROOT, 'external');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(oldDir, 'linked'));
    fs.writeFileSync(path.join(oldDir, 'linked', 'secret.txt'), 'source');
    fs.symlinkSync(outside, path.join(newDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => copyDirContents(oldDir, newDir), /符号链接/);
    assert(!fs.existsSync(path.join(outside, 'secret.txt')));
  });
  await test('导出 APK 使用 Electron app 路径并真正写出文件', async () => {
    const apk = path.join(ROOT, 'fixture.apk');
    const out = path.join(ROOT, 'export.apk');
    fs.writeFileSync(apk, 'APK fixture');
    let opened = false;
    const callback = handler('app:exportApk', 'app:backup', {
      store: { getApp: () => ({ label: 'Sample', versionName: '1', apkPath: apk }) },
      app: { getPath: (key) => { assert.strictEqual(key, 'downloads'); return ROOT; } },
      dialog: { showSaveDialog: async (_win, opts) => {
        opened = true;
        assert.strictEqual(opts.defaultPath, path.join(ROOT, 'Sample-1.apk'));
        return { canceled: false, filePath: out };
      } },
      mainWindow: null,
    });
    assert((await callback(null, 'com.example.test')).ok);
    assert(opened);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'APK fixture');
  });
  await test('安装版自卸载只打开确认向导，不提前清数据或取消关联', async () => {
    const install = path.join(ROOT, 'installed');
    fs.mkdirSync(install);
    const uninstaller = path.join(install, 'Uninstall ApkStart.exe');
    fs.writeFileSync(uninstaller, 'fixture');
    let opened = '';
    const callback = handler('app:removeSelf', 'shell:open', {
      process: { platform: 'win32', execPath: path.join(install, 'ApkStart.exe') },
      app: { isPackaged: true },
      shell: { openPath: async (file) => { opened = file; return ''; } },
      require: () => { throw new Error('不能提前启动清理进程'); },
      assoc: { unregisterAssociation: () => { throw new Error('不能提前取消关联'); } },
    });
    const result = await callback();
    assert(result.ok && result.awaitingConfirmation);
    assert.strictEqual(opened, uninstaller);
    assert(fs.existsSync(uninstaller));
  });
  await test('安装完成必须经过默认取消的确认框，再调用管理器', async () => {
    let confirmed = 0;
    const manager = {
      taskManager: { getTask: () => ({ taskId: 'test-task', status: 'awaiting_confirmation' }) },
      confirmInstallation: async (taskId, opts) => {
        assert.strictEqual(taskId, 'test-task');
        assert.strictEqual(opts.confirmed, true);
        confirmed += 1;
        return { ok: true };
      },
    };
    let response = 0;
    const callback = handler('system:confirmInstall', 'system:switch', {
      getSystemManager: () => manager, mainWindow: null,
      dialog: { showMessageBox: async (_win, opts) => {
        assert.strictEqual(opts.defaultId, 0);
        assert.strictEqual(opts.cancelId, 0);
        return { response };
      } },
    });
    assert.strictEqual((await callback(null, 'test-task')).cancelled, true);
    assert.strictEqual(confirmed, 0);
    response = 1;
    assert.strictEqual((await callback(null, 'test-task')).ok, true);
    assert.strictEqual(confirmed, 1);
    manager.taskManager.getTask = () => ({ status: 'downloading' });
    assert.strictEqual((await callback(null, 'test-task')).ok, false);
    assert.strictEqual(confirmed, 1);
  });
  await test('停止失败或设备仍在线时，IPC不能报告成功', async () => {
    let stopped = false, online = false;
    const callback = handler('runtime:stop', 'runtime:log', {
      runtime: { stop: async () => stopped, vmRunning: false, client: () => ({ isOnline: async () => online }) },
    });
    assert.strictEqual((await callback()).ok, false);
    stopped = true; online = true;
    assert.strictEqual((await callback()).ok, false);
    online = false;
    assert.strictEqual((await callback()).ok, true);
  });
  await test('接管来的在线设备停不掉时，不写入新的镜像档位', async () => {
    let saved = false;
    const callback = handler('runtime:setImageFlavor', 'system:list', {
      runtime: {
        vmRunning: false, stop: async () => false,
        client: () => ({ isOnline: async () => true }),
        provisioner: { imageProfile: (value) => ({ id: value || 'old', avd: value || 'old' }) },
      },
      store: { saveSettings: () => { saved = true; } }, appLog: () => {},
    });
    assert.strictEqual((await callback(null, 'new')).ok, false);
    assert.strictEqual(saved, false);
  });
  await test('Linux 与开发模式不调用 Windows 自卸载脚本', async () => {
    for (const [platform, packaged] of [['linux', true], ['win32', false]]) {
      const callback = handler('app:removeSelf', 'shell:open', {
        process: { platform }, app: { isPackaged: packaged },
      });
      assert.strictEqual((await callback()).ok, false);
    }
  });
  console.log(`文件安全回归：${passed} 通过，0 失败`);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(ROOT, { recursive: true, force: true }));

'use strict';
/** 只加载构建包中的 store，不启动产品主进程或真实模拟器。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const rel of ['dist/ApkStart-win64-portable', 'dist/release/win-unpacked']) {
  test(`构建包关键源码与版本一致且配置模块可在内置 Node 中运行：${rel}`, { skip: process.platform !== 'win32' }, () => {
    const dir = path.join(ROOT, rel);
    assert.ok(fs.existsSync(dir), '先运行 npm run pack 和 npm run build:exe');
    const app = path.join(dir, 'resources', 'app');
    for (const source of [
      'src/core/store.js', 'src/core/system-catalog.js', 'src/main.js',
      'src/ui/app.js', 'src/ui/index.html',
    ]) {
      assert.equal(digest(path.join(app, source)), digest(path.join(ROOT, source)), `构建包源码不同：${source}`);
    }
    assert.equal(require(path.join(app, 'package.json')).version, require('../package.json').version);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-packaged-store-'));
    try {
      const code = `
        const assert = require('node:assert/strict');
        const store = require(${JSON.stringify(path.join(app, 'src', 'core', 'store.js'))});
        store.saveSettings({ theme: 'dark', engine: { memoryMB: 3072 } });
        assert.equal(store.getSettings().engine.memoryMB, 3072);
        store.saveSettings({ engine: null });
        assert.equal(store.getSettings().engine.memoryMB, 3072);
        store.upsertApp({ package: 'com.example.packaged', name: 'packaged smoke' });
        assert.equal(store.getApps().length, 1);
        console.log('PACKAGED_STORE_OK');
      `;
      const result = spawnSync(path.join(dir, 'ApkStart.exe'), ['-e', code], {
        env: { ...process.env, APPDATA: data, XDG_DATA_HOME: data, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PACKAGED_STORE_OK/);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
}

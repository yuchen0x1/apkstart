'use strict';
/**
 * Electron 冒烟测试（真实启动一个 Chromium 渲染进程）
 *
 * 验证升级 Electron 后最容易坏的三件事：
 *   1. preload 在 sandbox: true 下能否正常执行（能坏到「整个界面白屏且没有任何报错」）；
 *   2. 渲染层拿到的确实是白名单接口，而不是完整的 Node.js；
 *   3. 页面本身能否加载完成、有没有未捕获的脚本错误。
 *
 * 运行：npx electron test/electron-smoke.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const PAGE = path.join(SRC, 'ui', 'index.html');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name} ${detail}`); }
  else { failed += 1; console.error(`  ✗ ${name} ${detail}`); }
}

/** 把 preload 里声明的通道全部 mock 掉，避免「No handler registered」干扰判断 */
function mockChannels() {
  const src = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const chans = new Set();
  for (const m of src.matchAll(/invoke\(\s*'([^']+)'/g)) chans.add(m[1]);
  for (const m of src.matchAll(/ipcRenderer\.(?:on|send)\(\s*'([^']+)'/g)) chans.add(m[1]);
  for (const ch of chans) {
    if (ipcMain.listenerCount(ch) === 0) {
      try { ipcMain.handle(ch, () => ({})); } catch (_) { /* 已注册过就跳过 */ }
    }
  }
  return chans.size;
}

app.whenReady().then(async () => {
  console.log('\n[Electron 冒烟测试]');
  console.log(`  Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`);

  const mocked = mockChannels();
  const consoleErrors = [];
  const pageErrors = [];
  let preloadError = null;

  const win = new BrowserWindow({
    show: false,
    width: 1140,
    height: 740,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.webContents.on('preload-error', (_e, file, err) => {
    preloadError = `${file}: ${err && err.message}`;
  });
  win.webContents.on('console-message', (ev) => {
    // Electron 45 起只传一个事件对象：{ level: 'info'|'warning'|'error'|'debug', message, sourceId, lineNumber }
    if (ev && ev.level === 'error') consoleErrors.push(`${ev.message} (${ev.sourceId}:${ev.lineNumber})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    pageErrors.push(`渲染进程崩溃: ${d.reason}`);
  });

  await win.loadFile(PAGE);
  // 页面脚本要跑几轮 IPC 才会把 UI 画出来，给它一点时间
  await new Promise((r) => setTimeout(r, 2500));

  const probe = await win.webContents.executeJavaScript(`(() => ({
    bridge: typeof window.apkstart,
    fnCount: window.apkstart ? Object.keys(window.apkstart).filter(k => typeof window.apkstart[k] === 'function').length : 0,
    hasPathForFile: !!(window.apkstart && window.apkstart.pathForFile),
    nodeRequire: typeof window.require,
    nodeProcess: typeof window.process,
    bodyChildren: document.body ? document.body.children.length : 0,
    title: document.title,
    contentLength: (document.body && document.body.innerText || '').trim().length,
  }))()`);

  check('preload 在 sandbox 下执行成功', !preloadError, preloadError || '');
  check('window.apkstart 已注入', probe.bridge === 'object', `实际 ${probe.bridge}`);
  check('暴露的接口数量正常', probe.fnCount >= 40, `实际 ${probe.fnCount} 个`);
  check('拖拽取路径接口可用（webUtils 在沙箱里仍可用）', probe.hasPathForFile === true);
  check('渲染层拿不到 Node（require 不存在）', probe.nodeRequire === 'undefined', `实际 ${probe.nodeRequire}`);
  check('渲染层拿不到 process', probe.nodeProcess === 'undefined', `实际 ${probe.nodeProcess}`);
  check('页面已渲染出内容', probe.bodyChildren > 0 && probe.contentLength > 20, `${probe.bodyChildren} 个节点 / ${probe.contentLength} 字`);

  // 页面自己的脚本错误才算失败；「某个通道没实现」属于本次 mock 环境的预期噪音
  const realErrors = consoleErrors.filter((m) => !/No handler registered|net::ERR|Failed to fetch/i.test(m));
  check('页面没有未捕获的脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  check('渲染进程没有崩溃', pageErrors.length === 0, pageErrors.join(' | '));

  console.log(`  （mock 了 ${mocked} 个 IPC 通道，用于让界面完成首屏渲染）`);
  console.log(`\n冒烟测试结果：${passed} 通过，${failed} 失败`);
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('冒烟测试异常：', e && (e.stack || e.message));
  app.exit(1);
});

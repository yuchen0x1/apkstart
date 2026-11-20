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
const { createFixture } = require('./lib/ui-fixtures');
const fixture = createFixture();

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
      try { ipcMain.handle(ch, (_e, payload) => fixture.respond(ch, payload)); } catch (_) { /* 已注册过就跳过 */ }
    }
  }
  return chans.size;
}

app.whenReady().then(async () => {
  console.log('\n[Electron 冒烟测试]');
  console.log(`  Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`);

  // 一键修复窗口：给一份真实形状的方案，验证它真的能渲染出来（不能只是「不报错」）
  ipcMain.handle('runtime:repairPlan', () => ({
    code: 'TIMEOUT',
    level: 'slow',
    title: '没有硬件加速，纯软件模拟在 4 分钟内开不完机',
    headline: '这台机器没有硬件加速，纯软件模拟开 Android 14 常常要 8~15 分钟，之前只等了 4 分钟。',
    why: [
      '这台电脑是 Intel(R) Celeron(R) N4100（4 核 / 8 GB 内存），没有可用的硬件加速。',
      '有硬件加速时开机像打开普通程序；没有时每条指令都要逐条翻译执行。',
      '换 Android 12 镜像解决不了这一类问题。',
    ],
    checks: [
      { label: '处理器', value: 'Intel N4100 · 4 核', state: 'ok' },
      { label: '内存', value: '8 GB（当前可用 3 GB）', state: 'warn' },
      { label: '硬件加速', value: '不可用（纯软件模拟）', state: 'warn' },
      { label: '系统镜像', value: 'Android 34 · 含 ARM 转译', state: 'ok' },
    ],
    actions: [
      { id: 'low-spec', label: '低配模式再试一次（等 15 分钟）', kind: 'auto', hint: '540×960 / 2 核 / 2 GB，不存快照' },
      { id: 'accel', label: '尝试开启硬件加速', kind: 'auto', hint: '会弹出管理员授权窗口' },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
    canAutoFix: true,
    reportDraft: { file: 'C:////Users////x////logs////reports////demo.md' },
  }));
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
      additionalArguments: ['--apkstart-role=main'],
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

  // 一键修复窗口：真渲染一遍，确认结论 / 体检表 / 按钮都在
  // （先把首次运行向导收掉：正常流程里用户已经在用了，不会两个弹窗同时开着）
  await win.webContents.executeJavaScript(
    "document.getElementById('wizardMask').classList.remove('on'); window.openRepair && window.openRepair(null)",
  );
  await new Promise((r) => setTimeout(r, 600));
  const repair = await win.webContents.executeJavaScript(`(() => {
    const mask = document.getElementById('repairMask');
    const q = (id) => document.getElementById(id);
    return {
      open: !!(mask && mask.classList.contains('on')),
      title: q('repairTitle') && q('repairTitle').textContent,
      headline: q('repairHeadline') && q('repairHeadline').textContent,
      checks: document.querySelectorAll('#repairChecks .repair-check').length,
      whyHidden: q('repairWhy') ? q('repairWhy').hidden : null,
      whyCount: document.querySelectorAll('#repairWhy p').length,
      runLabel: q('repairRunBtn') && q('repairRunBtn').textContent,
      actions: document.querySelectorAll('#repairActions .repair-action').length,
      draftHint: !document.getElementById('repairDraft').hidden,
      sendLabel: document.getElementById('repairSendBtn') && document.getElementById('repairSendBtn').textContent,
      badge: q('repairBadge') && q('repairBadge').textContent,
    };
  })()`);
  check('一键修复窗口能打开', repair.open === true);
  check('窗口有结论标题与一句话结论', !!(repair.title && repair.headline), `${repair.title} / ${String(repair.headline).slice(0, 24)}…`);
  check('体检表渲染出 4 项', repair.checks === 4, `实际 ${repair.checks}`);
  check('修复动作逐条列出（可单独执行）', repair.actions === 2, `实际 ${repair.actions}`);
  check('能修的情况默认收起长解释（避免一屏字压人）', repair.whyHidden === true && repair.whyCount === 3);
  check('主按钮文案正确', /一键修复/.test(String(repair.runLabel)), String(repair.runLabel));
  check('等级徽标正确', repair.badge === '能修，但会慢', String(repair.badge));
  check('自动生成的报告会明示（不会偷偷发送）', repair.draftHint === true);
  check('上报按钮就位', repair.sendLabel === '上报给作者', String(repair.sendLabel));

  // 截图前再压一次向导：首次运行流程会在状态刷新后把它重新打开，会挡住修复窗口
  const covered = await win.webContents.executeJavaScript(`(() => {
    const w = document.getElementById('wizardMask');
    const wasOn = w.classList.contains('on');
    w.classList.remove('on');
    document.getElementById('settingsMask').classList.remove('on');
    return { wasOn, repairOn: document.getElementById('repairMask').classList.contains('on') };
  })()`);
  check('修复窗口不会被向导弹窗盖住', covered.repairOn === true, `向导当时${covered.wasOn ? '是' : '不是'}打开状态`);

  // 存一张截图，人工核对排版（CI 里也可以直接看）
  // 隐藏窗口不会重绘，capturePage 会拿到第一帧（.off 的向导）：截图前必须真显示一下
  try {
    win.showInactive();
    await new Promise((r) => setTimeout(r, 500));
    const shot = await win.webContents.capturePage();
    const out = path.join(app.getPath('temp'), 'apkstart-repair-modal.png');
    fs.writeFileSync(out, shot.toPNG());
    console.log(`  截图：${out}`);
    // 再把「为什么跑不了」展开截一张：这段长解释是最容易被排版挤坏的地方
    await win.webContents.executeJavaScript("document.getElementById('repairWhyBtn').click()");
    await new Promise((r) => setTimeout(r, 400));
    const whyOpen = await win.webContents.executeJavaScript(
      "!document.getElementById('repairWhy').hidden && document.querySelectorAll('#repairWhy p').length",
    );
    check('「为什么跑不了」可以展开', whyOpen === 3, `实际 ${whyOpen}`);
    const shot2 = await win.webContents.capturePage();
    const out2 = path.join(app.getPath('temp'), 'apkstart-repair-why.png');
    fs.writeFileSync(out2, shot2.toPNG());
    console.log(`  截图：${out2}`);
    win.hide();
  } catch (_) { /* 截图失败不影响结论 */ }

  console.log(`  （mock 了 ${mocked} 个 IPC 通道，用于让界面完成首屏渲染）`);
  console.log(`\n冒烟测试结果：${passed} 通过，${failed} 失败`);
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('冒烟测试异常：', e && (e.stack || e.message));
  app.exit(1);
});

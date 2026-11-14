'use strict';
/**
 * 英文界面的真实渲染验证（upstream issue #38）。
 *
 * 单元测试只能证明「词典和 DOM 翻译函数都在」，证明不了「英文界面真的翻出来了」。
 * 这里真起一个 Chromium 渲染进程加载 index.html，把 app:i18n 换成真实英文载荷，
 * 然后数一遍页面上还剩多少中文、截图留档。
 *
 * 运行：npx electron test/i18n-render.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const PAGE = path.join(SRC, 'ui', 'index.html');
const i18n = require(path.join(SRC, 'i18n'));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name} ${detail}`); }
  else { failed += 1; console.error(`  ✗ ${name} ${detail}`); }
};

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  // 所有通道先给个空实现，再用真实 i18n 覆盖 —— app.js 的 init 会因为空数据抛错，
  // 但翻译在 init 的最前面，不影响我们要看的东西。
  const src = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const chans = new Set();
  for (const m of src.matchAll(/invoke\(\s*'([^']+)'/g)) chans.add(m[1]);
  for (const ch of chans) {
    try { ipcMain.handle(ch, () => ({})); } catch (_) { /* 已有 */ }
  }
  ipcMain.removeHandler('app:i18n');
  ipcMain.handle('app:i18n', () => i18n.payload('en-US'));

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const e = args[0];
    const level = e && e.level !== undefined ? e.level : args[1];
    const msg = e && e.message !== undefined ? e.message : args[2];
    if (level === 'error' || level === 3 || /error/i.test(String(level))) errors.push(String(msg));
  });

  await win.loadFile(PAGE);
  await new Promise((r) => setTimeout(r, 1500));

  const report = await win.webContents.executeJavaScript(`(() => {
    const CJK = /[\\u4e00-\\u9fa5]/;
    const skip = new Set(['SCRIPT', 'STYLE']);
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      const p = n.parentElement;
      if (p && !skip.has(p.tagName) && CJK.test(n.nodeValue) && n.nodeValue.trim().length > 1) {
        const st = getComputedStyle(p);
        if (st.display !== 'none' && st.visibility !== 'hidden') out.push(n.nodeValue.trim().slice(0, 40));
      }
      n = walker.nextNode();
    }
    return { lang: document.documentElement.lang, total: out.length, sample: out.slice(0, 12) };
  })()`);

  check('页面语言已切换为 en', report.lang === 'en', `lang=${report.lang}`);
  check('可见中文文本基本清零', report.total <= 3, `剩 ${report.total} 处：${JSON.stringify(report.sample)}`);
  check('没有未捕获的脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 抽查几个关键控件真的变成英文了
  const probe = await win.webContents.executeJavaScript(`({
    tag: document.getElementById('engineTag').textContent,
    install: document.querySelector('[data-drop]') ? 'has' : 'none',
    hasLangSelect: !!document.getElementById('setLanguage'),
  })`);
  check('顶栏状态文案已翻译', /[A-Za-z]/.test(probe.tag) && !/[\u4e00-\u9fa5]/.test(probe.tag), probe.tag.slice(0, 40));
  check('语言下拉框存在', probe.hasLangSelect === true);

  const shot = path.join(os.tmpdir(), 'apkstart-en.png');
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    console.log(`  截图：${shot}`);
  } catch (_) { /* 截图失败不影响结论 */ }

  console.log(`\n英文界面渲染：${passed} 通过，${failed} 失败`);
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('渲染验证异常：', e && e.stack);
  app.exit(1);
});

'use strict';
/**
 * IPC 安全边界测试：路径边界、页面来源、iframe 冒充。
 * 这些用例覆盖「渲染层被注入脚本后能否越权调 IPC」这条攻击链的第一道闸。
 */
const path = require('path');
const { isInside, isTrustedFrameUrl, checkEvent } = require('../src/core/ipcguard');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }

const ROOT = path.resolve(__dirname, '..', 'src');
const url = (rel) => `file:///${path.join(ROOT, rel).replace(/\\/g, '/')}`;

/** 伪造一个 ipcMain.handle 收到的 event */
function fakeEvent(frameUrl, { iframe = false, noFrame = false } = {}) {
  const mainFrame = { url: frameUrl };
  const frame = iframe ? { url: frameUrl } : mainFrame;
  const sender = { mainFrame };
  if (noFrame) return { sender };
  return { sender, senderFrame: frame };
}

(async () => {
  console.log('\n[ipcguard 路径边界]');

  await test('应用目录内的页面被放行', () => {
    assert(isInside(ROOT, path.join(ROOT, 'ui', 'index.html')), 'ui/index.html 应在应用目录内');
    assert(isInside(ROOT, path.join(ROOT, 'ui', 'shell.html')), 'shell.html 应在应用目录内');
  });

  await test('★ 前缀相同的兄弟目录不能被当成内部（旧 startsWith 漏洞）', () => {
    const evil = `${ROOT}-evil`;
    assert(!isInside(ROOT, path.join(evil, 'ui', 'index.html')), '同级目录必须被拒绝');
  });

  await test('上级目录、根目录本身、盘符根都被拒绝', () => {
    assert(!isInside(ROOT, path.join(ROOT, '..', 'secret.txt')), '上级目录必须被拒绝');
    assert(!isInside(ROOT, ROOT), '目录本身不算内部文件');
    assert(!isInside(ROOT, path.parse(ROOT).root), '盘符根必须被拒绝');
  });

  console.log('\n[ipcguard 页面来源]');

  await test('本应用页面：file:// + 目录内 → 可信', () => {
    assert(isTrustedFrameUrl(ROOT, url('ui/index.html')), 'index.html 应可信');
    assert(isTrustedFrameUrl(ROOT, url('ui/shell.html')), 'shell.html 应可信');
  });

  await test('★ 外部网页（http/https）一律不可信', () => {
    assert(!isTrustedFrameUrl(ROOT, 'https://evil.example/x.html'), 'https 必须被拒绝');
    assert(!isTrustedFrameUrl(ROOT, 'http://localhost:3000/'), 'http 必须被拒绝');
    assert(!isTrustedFrameUrl(ROOT, 'about:blank'), 'about:blank 必须被拒绝');
  });

  await test('★ 目录外的本地文件不可信（../ 逃逸、兄弟目录、其他磁盘）', () => {
    assert(!isTrustedFrameUrl(ROOT, url('../package.json')), '../ 逃逸必须被拒绝');
    assert(!isTrustedFrameUrl(ROOT, `file:///${ROOT}-evil/x.html`.replace(/\\/g, '/')), '兄弟目录必须被拒绝');
    assert(!isTrustedFrameUrl(ROOT, 'file:///C:/Windows/System32/drivers/etc/hosts'), '系统文件必须被拒绝');
  });

  await test('畸形 URL / 空值不抛异常，直接判不可信', () => {
    assert(!isTrustedFrameUrl(ROOT, ''), '空串不可信');
    assert(!isTrustedFrameUrl(ROOT, null), 'null 不可信');
    assert(!isTrustedFrameUrl(ROOT, 'not a url'), '非 URL 不可信');
    assert(!isTrustedFrameUrl('', url('ui/index.html')), '缺少根目录时不可信');
  });

  console.log('\n[ipcguard 事件校验]');

  await test('主框架 + 本应用页面 → 放行', () => {
    const v = checkEvent(ROOT, fakeEvent(url('ui/index.html')));
    assert(v.ok, v.reason);
  });

  await test('★ iframe 冒充（子框架发起）→ 拒绝', () => {
    const v = checkEvent(ROOT, fakeEvent(url('ui/index.html'), { iframe: true }));
    assert(!v.ok && /子框架/.test(v.reason), JSON.stringify(v));
  });

  await test('★ 页面已销毁 / 没有 sender → 拒绝而不是崩溃', () => {
    const v1 = checkEvent(ROOT, fakeEvent(url('ui/index.html'), { noFrame: true }));
    assert(!v1.ok, '没有 senderFrame 必须拒绝');
    const v2 = checkEvent(ROOT, {});
    assert(!v2.ok, '没有 sender 必须拒绝');
    const v3 = checkEvent(ROOT, null);
    assert(!v3.ok, '空事件必须拒绝');
  });

  await test('★ 主窗口被导航到外部站点后，IPC 立即失效', () => {
    const v = checkEvent(ROOT, fakeEvent('https://evil.example/'));
    assert(!v.ok && /不在应用目录/.test(v.reason), JSON.stringify(v));
  });

  console.log(`\nIPC 安全测试结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();

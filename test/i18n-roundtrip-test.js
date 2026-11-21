'use strict';
/** 直接运行渲染层翻译器，验证文字与无障碍属性双向切换。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'i18n.js'), 'utf8');
function element(attrs = {}, children = []) {
  const values = new Map(Object.entries(attrs));
  const node = { nodeType: 1, tagName: 'BUTTON', children,
    hasAttribute: key => values.has(key), getAttribute: key => values.get(key) ?? null,
    setAttribute: (key, value) => values.set(key, value), removeAttribute: key => values.delete(key),
    classList: { remove() {} },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const text = { nodeType: 3, nodeValue: '设置' };
const button = element({ title: '设置', 'aria-label': '设置', placeholder: '搜索应用', alt: '设置' }, [text]);
const body = element({}, [button]);
let observer;
const document = {
  body, title: '设置', documentElement: element(),
  createTreeWalker(root, filter) {
    const nodes = [];
    function visit(node) { for (const child of node.children || []) { if (filter & (child.nodeType === 1 ? 1 : 4)) nodes.push(child); visit(child); } }
    visit(root); let index = 0;
    return { nextNode: () => nodes[index++] || null };
  },
};
const context = { document, window: {}, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
  MutationObserver: class { constructor(callback) { observer = this; this.callback = callback; } observe() {} disconnect() { this.disconnected = true; } },
};
vm.runInNewContext(source, context);
const api = context.window.apkI18n;
const english = { lang: 'en-US', dict: { '设置': 'Settings', '搜索应用': 'Search apps' } };
const chinese = { lang: 'zh-CN', dict: {} };
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }
test('英文翻译覆盖文字、窗口标题及四类属性', () => {
  api.apply(english);
  assert.strictEqual(text.nodeValue, 'Settings');
  assert.strictEqual(document.title, 'Settings');
  for (const key of ['title', 'aria-label', 'alt']) assert.strictEqual(button.getAttribute(key), 'Settings');
  assert.strictEqual(button.getAttribute('placeholder'), 'Search apps');
});
test('切回中文恢复无障碍属性和窗口标题', () => {
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, '设置');
  assert.strictEqual(document.title, '设置');
  for (const key of ['title', 'aria-label', 'alt']) assert.strictEqual(button.getAttribute(key), '设置');
  assert.strictEqual(button.getAttribute('placeholder'), '搜索应用');
});
test('英文期间业务更新的文本、属性和标题不得被旧原文覆盖', () => {
  api.retranslate(english);
  text.nodeValue = 'New application'; button.setAttribute('title', 'New title'); document.title = 'New window';
  button.removeAttribute('alt');
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, 'New application');
  assert.strictEqual(button.getAttribute('title'), 'New title');
  assert.strictEqual(document.title, 'New window');
  assert.strictEqual(button.hasAttribute('alt'), false);
});
test('增量更新的中文属性还原最新值，重复切换不残留英文', () => {
  api.retranslate(english);
  button.setAttribute('aria-label', '搜索应用');
  observer.callback([{ type: 'attributes', target: button, attributeName: 'aria-label' }]);
  assert.strictEqual(button.getAttribute('aria-label'), 'Search apps');
  api.retranslate(chinese);
  assert.strictEqual(button.getAttribute('aria-label'), '搜索应用');
  api.retranslate(english); api.retranslate(chinese);
  assert.strictEqual(button.getAttribute('aria-label'), '搜索应用');
});
test('直接 apply 中文也必须停止英文 observer', () => {
  api.apply(english); const previous = observer; api.apply(chinese);
  assert.strictEqual(previous.disconnected, true);
});
test('重复英文载荷从源文重新翻译，不保留旧词典结果', () => {
  text.nodeValue = '设置'; button.setAttribute('title', '设置'); document.title = '设置';
  api.retranslate(english);
  api.retranslate({ lang: 'en-US', dict: { '设置': 'Preferences', '搜索应用': 'Find apps' } });
  assert.strictEqual(text.nodeValue, 'Preferences');
  assert.strictEqual(button.getAttribute('title'), 'Preferences');
  assert.strictEqual(document.title, 'Preferences');
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, '设置');
  assert.strictEqual(button.getAttribute('title'), '设置');
  assert.strictEqual(document.title, '设置');
});
test('代码与 data-i18n-skip 整棵子树在初译、增量更新和往返中保持原样', () => {
  for (const tag of ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'DIV']) {
    const content = { nodeType: 3, nodeValue: '设置' };
    const child = element({ title: '设置' }, [content]);
    const root = element(tag === 'DIV' ? { 'data-i18n-skip': '' } : {}, [child]);
    root.tagName = tag; root.parentElement = body; body.children.push(root);
    api.retranslate(english);
    observer.callback([{ type: 'characterData', target: content }, { type: 'attributes', target: child, attributeName: 'title' }, { type: 'childList', addedNodes: [child] }]);
    assert.strictEqual(content.nodeValue, '设置', tag + ' 的文本');
    assert.strictEqual(child.getAttribute('title'), '设置', tag + ' 的属性');
    api.retranslate(chinese);
    assert.strictEqual(content.nodeValue, '设置', tag + ' 往返后文本');
    body.children.pop();
  }
});
test('混合中英文译文不会被 observer 二次翻译而丢失真正原文', () => {
  text.nodeValue = '设置';
  api.retranslate({ lang: 'en-US', dict: { '设置': 'Settings 设置', 'Settings 设置': 'Wrong' } });
  assert.strictEqual(text.nodeValue, 'Settings 设置');
  observer.callback([{ type: 'characterData', target: text }]);
  assert.strictEqual(text.nodeValue, 'Settings 设置');
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, '设置');
});
test('系统切换与任务取消的安全文案支持英中往返及主词典覆盖', () => {
  text.nodeValue = '取消切换';
  button.setAttribute('title', '仅取消任务，不停止安装器，也不删除系统数据');
  api.retranslate(english);
  assert.strictEqual(text.nodeValue, 'Cancel switch');
  assert.strictEqual(button.getAttribute('title'), 'Cancels only the task; does not stop the installer or delete system data');
  assert.strictEqual(api.translateOne('Android-x86 · 已启动，等待 Android 就绪'), 'Android-x86 · Started; waiting for Android');
  api.retranslate({ lang: 'en-US', dict: { '取消切换': 'Cancel system switch' } });
  assert.strictEqual(text.nodeValue, 'Cancel system switch');
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, '取消切换');
  assert.strictEqual(button.getAttribute('title'), '仅取消任务，不停止安装器，也不删除系统数据');
});
test('硬件加速检查与按需授权提示英中往返，不再声称自动安装驱动', () => {
  const detail = '仅在必要时请求系统授权，用于启动已有加速服务或启用 Windows 系统功能；不会自动安装第三方驱动。';
  text.nodeValue = '正在检查并启用硬件加速…';
  button.setAttribute('title', detail);
  api.retranslate(english);
  assert.strictEqual(text.nodeValue, 'Checking and enabling hardware acceleration…');
  assert.strictEqual(button.getAttribute('title'), 'System authorization is requested only when needed to start an existing acceleration service or enable Windows features. Third-party drivers are not installed automatically.');
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, '正在检查并启用硬件加速…');
  assert.strictEqual(button.getAttribute('title'), detail);
});
test('西/越/俄载荷切换都从中文源文重新翻译，并回到中文原文', () => {
  text.nodeValue = '设置'; button.setAttribute('title', '设置'); document.title = '设置';
  const payloads = {
    'es-ES': { lang: 'es-ES', dict: { '设置': 'Ajustes', '搜索应用': 'Buscar aplicaciones' } },
    'vi-VN': { lang: 'vi-VN', dict: { '设置': 'Cài đặt', '搜索应用': 'Tìm ứng dụng' } },
    'ru-RU': { lang: 'ru-RU', dict: { '设置': 'Настройки', '搜索应用': 'Поиск приложений' } },
  };
  const expected = { 'es-ES': 'Ajustes', 'vi-VN': 'Cài đặt', 'ru-RU': 'Настройки' };
  for (const lang of ['es-ES', 'vi-VN', 'ru-RU']) {
    api.retranslate(payloads[lang]);
    assert.strictEqual(text.nodeValue, expected[lang], `${lang} 文本`);
    assert.strictEqual(button.getAttribute('title'), expected[lang], `${lang} 属性`);
    assert.strictEqual(document.title, expected[lang], `${lang} 标题`);
    assert.strictEqual(document.documentElement.getAttribute('lang'), lang, `${lang} HTML lang`);
  }
  api.retranslate(chinese);
  assert.strictEqual(text.nodeValue, '设置');
  assert.strictEqual(button.getAttribute('title'), '设置');
  assert.strictEqual(document.title, '设置');
  assert.strictEqual(document.documentElement.getAttribute('lang'), 'zh-CN');
});
test('三语词典条目在 renderer 中回填数字，缺本地词时用英文载荷条目', () => {
  const payload = { lang: 'es-ES', dict: {
    '第 \u0001 步 / 共 \u0001 步': 'Paso \u0001 de \u0001',
    '\u0001 已安装': '\u0001 instalado',
    '诊断报告已导出': 'The diagnostic report has been exported',
  } };
  api.retranslate(payload);
  assert.strictEqual(api.translateOne('第 2 步 / 共 5 步'), 'Paso 2 de 5');
  assert.strictEqual(api.translateOne('诊断报告已导出'), 'The diagnostic report has been exported');
  assert.strictEqual(api.translateOne('设置'), '设置');
  api.retranslate(chinese);
});
test('apply 直接切到西语也会先恢复中文源文，而不是把旧译文当源文跳过', () => {
  text.nodeValue = '设置'; button.setAttribute('title', '设置'); document.title = '设置';
  api.apply(english);
  assert.strictEqual(text.nodeValue, 'Settings');
  api.apply({ lang: 'es-ES', dict: { '设置': 'Ajustes' } });
  assert.strictEqual(text.nodeValue, 'Ajustes');
  assert.strictEqual(button.getAttribute('title'), 'Ajustes');
  assert.strictEqual(document.title, 'Ajustes');
  api.apply(chinese);
  assert.strictEqual(text.nodeValue, '设置');
  assert.strictEqual(button.getAttribute('title'), '设置');
  assert.strictEqual(document.title, '设置');
});
test('observer 新增节点立即翻译，skip 子树内新增节点保持原文', () => {
  const freshText = { nodeType: 3, nodeValue: '设置' };
  const fresh = element({ title: '设置' }, [freshText]);
  fresh.parentElement = body; body.children.push(fresh);
  const skippedText = { nodeType: 3, nodeValue: '设置' };
  const skippedChild = element({ title: '设置' }, [skippedText]);
  const skippedRoot = element({ 'data-i18n-skip': '' }, [skippedChild]);
  skippedRoot.tagName = 'DIV'; skippedRoot.parentElement = body; body.children.push(skippedRoot);
  api.retranslate(english);
  observer.callback([{ type: 'childList', addedNodes: [fresh, skippedRoot] }]);
  assert.strictEqual(freshText.nodeValue, 'Settings');
  assert.strictEqual(fresh.getAttribute('title'), 'Settings');
  assert.strictEqual(skippedText.nodeValue, '设置');
  assert.strictEqual(skippedChild.getAttribute('title'), '设置');
  api.retranslate(chinese);
  assert.strictEqual(freshText.nodeValue, '设置');
  assert.strictEqual(fresh.getAttribute('title'), '设置');
  body.children.pop(); body.children.pop();
});
console.log(`界面语言往返回归：${passed} 通过，0 失败`);

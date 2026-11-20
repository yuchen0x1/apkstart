'use strict';

/* 渲染层焦点管理；激活按键仍交给原生控件处理。 */
(() => {
  const layers = [...document.querySelectorAll('[data-dialog-layer]')];
  const background = [...document.querySelectorAll('[data-dialog-background]')];
  const sessions = new WeakMap();
  const markup = new WeakMap();
  const focusable = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';

  function available(el) {
    return el?.isConnected && !el.matches(':disabled') && !el.closest('[inert]')
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
  }

  function focus(target, preventScroll = true) {
    const el = typeof target === 'function' ? target() : target;
    if (!available(el) || !el.matches(focusable)) return false;
    if (document.activeElement !== el) el.focus({ preventScroll });
    return document.activeElement === el;
  }

  // 弹窗打开期间，轮询刷新可能替换原入口节点。
  function bookmark(el = document.activeElement) {
    const key = el?.dataset.focusKey;
    const id = el?.id;
    return () => el?.isConnected ? el : key
      ? [...document.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === key)
      : id ? document.getElementById(id) : null;
  }

  function replace(container, html, fallback) {
    if (markup.get(container) === html) return;
    const active = document.activeElement;
    const resume = container.contains(active) ? bookmark(active) : null;
    container.innerHTML = html;
    markup.set(container, html);
    if (resume && !focus(resume) && fallback) focus(() => fallback(active));
  }

  function stops(root) {
    return [...root.querySelectorAll(focusable)].filter((el) => el.tabIndex >= 0 && available(el));
  }

  function scroll(el, block = 'center') {
    el?.scrollIntoView({ block, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  // 与文档和 CSS 的层级一致：修复在设置之上，设置在引导之上。
  function top() {
    return layers.findLast((layer) => layer.classList.contains('on'));
  }

  function sync() {
    const active = top();
    for (const el of background) el.inert = !!active;
    for (const layer of layers) {
      layer.inert = layer !== active;
      const dialog = layer.querySelector('[role="dialog"]');
      if (layer === active) dialog.setAttribute('aria-modal', 'true');
      else dialog.removeAttribute('aria-modal');
    }
  }

  function focusLayer(layer, resume) {
    const session = sessions.get(layer);
    if (resume && focus(session?.last)) return;
    if (focus(session?.initial || layer.querySelector('[data-dialog-focus]'))) return;
    focus(stops(layer)[0]);
  }

  function open(layer, { initial, opener } = {}) {
    if (layer.classList.contains('on')) return;
    sessions.set(layer, { initial, opener: typeof opener === 'function' ? opener : bookmark(opener) });
    layer.classList.add('on');
    sync();
    if (top() === layer) focusLayer(layer);
  }

  function close(layer) {
    if (!layer.classList.contains('on')) return;
    const wasTop = top() === layer;
    const opener = sessions.get(layer)?.opener;
    layer.classList.remove('on');
    sessions.delete(layer);
    sync();
    if (!wasTop) return;
    const next = top();
    const target = opener?.();
    if ((!next || next.contains(target)) && focus(target)) return;
    if (next) focusLayer(next, true);
    else focus(document.getElementById('btnSettings'));
  }

  document.addEventListener('focusin', (e) => {
    const layer = top();
    if (!layer) return;
    if (!layer.contains(e.target)) { focusLayer(layer, true); return; }
    const session = sessions.get(layer);
    if (session) session.last = bookmark(e.target);
  });

  document.addEventListener('keydown', (e) => {
    const layer = top();
    if (!layer || e.key !== 'Tab' || e.defaultPrevented) return;
    const controls = stops(layer);
    const active = document.activeElement;
    const direction = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    if (layer.contains(active) && controls.some((el) => active.compareDocumentPosition(el) & direction)) return;
    e.preventDefault();
    const wrap = e.shiftKey ? controls.at(-1) : controls[0];
    if (!focus(wrap)) focusLayer(layer);
  });

  // 渲染测试直接切换旧类名时，也保持模态语义同步。
  const observer = new MutationObserver(sync);
  for (const layer of layers) observer.observe(layer, { attributes: true, attributeFilter: ['class'] });
  sync();

  window.apkA11y = { focus, bookmark, replace, stops, scroll, top, open, close };
})();

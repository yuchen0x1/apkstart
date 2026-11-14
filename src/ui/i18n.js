'use strict';
/**
 * 渲染层的界面翻译（upstream issue #38）。
 *
 * 为什么不给每个元素加 `data-i18n="key"`：
 *   界面里有 250 多条静态文案、再加上动态生成的卡片与 toast，逐个加 key 意味着
 *   几百处改动，改漏一处就是一句中文夹在英文界面里；而且以后新写的文案默认就没 key。
 *   这里改成「按中文原文查词典」：遍历文本节点 + 几个常见属性，命中的换成英文，
 *   没命中的保持中文。新文案自然降级为中文，不会显示成 key 或空白。
 *
 * 数字与模板：运行时文本里的数字会被归一成占位符再查表，
 * 所以 `共 3 个应用` 能命中词典里 `共 {n} 个应用` 那条，回填时数字原样还原。
 *
 * 性能：只在英文环境启用；一次遍历 + MutationObserver 增量翻译，
 * 命中不了的文本直接跳过（不写 DOM，避免 observer 自激）。
 */
(() => {
  const N = '\u0001';
  const CJK = /[\u4e00-\u9fa5]/;
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE']);

  let dict = {};
  let lang = 'zh-CN';
  let observer = null;
  /** 只含占位符的 key 拆成段，用于「变量拼进句子中间」的模板匹配 */
  let templates = [];

  const norm = (s) => String(s).replace(/\d+(?:[.,]\d+)?/g, N).replace(/\s+/g, ' ').trim();

  function buildTemplates() {
    templates = Object.keys(dict)
      .filter((k) => k.includes(N) && k.length > 6)
      .map((k) => ({ segs: k.split(N), val: dict[k] }));
  }

  /**
   * 模板匹配：词典 key `还差 {x}；点下面「一键完成」…` 在运行时会变成
   * `还差 adb 工具链、Android 运行时、系统镜像；点下面「一键完成」…` ——
   * 数字归一帮不上忙（中间不是数字）。这里按占位符把 key 切成段，
   * 让运行时文本按段首/段尾匹配，截出的中段回填进英文，并对中段递归翻译一次。
   */
  function matchTemplate(s) {
    for (const t of templates) {
      const segs = t.segs;
      if (segs.length < 2 || !s.startsWith(segs[0])) continue;
      let pos = segs[0].length;
      const caps = [];
      let ok = true;
      for (let i = 1; i < segs.length; i += 1) {
        const seg = segs[i];
        if (i === segs.length - 1) {
          if (seg === '') { caps.push(s.slice(pos)); pos = s.length; break; }
          const idx = s.lastIndexOf(seg);
          if (idx < pos) { ok = false; break; }
          caps.push(s.slice(pos, idx));
          pos = idx + seg.length;
        } else {
          const idx = s.indexOf(seg, pos);
          if (idx < pos) { ok = false; break; }
          caps.push(s.slice(pos, idx));
          pos = idx + seg.length;
        }
      }
      if (ok && pos === s.length) return { val: t.val, caps };
    }
    return null;
  }

  /** 顿号连接的枚举值（如「adb 工具链、Android 运行时、系统镜像」）逐个翻再拼回去 */
  function translateList(s) {
    if (s.includes('、')) {
      const parts = s.split('、');
      const done = parts.map((p) => translateOne(p));
      return done.join('、');
    }
    return translateOne(s);
  }

  /** 单条文本翻译：命中返回英文（保留原有首尾空白），否则返回原串 */
  function translateOne(input) {
    if (typeof input !== 'string' || !input || !CJK.test(input)) return input;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(input);
    if (!m) return input;
    const core = m[2];
    let hit = dict[core] || dict[norm(core)];
    let caps = null;
    if (!hit) {
      const mt = matchTemplate(core);
      if (mt) { hit = mt.val; caps = mt.caps; }
    }
    if (!hit) return input;
    const nums = core.match(/\d+(?:[.,]\d+)?/g) || [];
    let i = 0;
    const out = String(hit).replace(new RegExp(N, 'g'), () => {
      // 模板匹配截出来的是「中文中段」，先对它递归翻译一次（数字在 nums 里时走原路）
      if (caps && i < caps.length) {
        const cap = caps[i];
        i += 1;
        if (cap.includes('、')) return translateList(cap);
        return translateOne(cap) || cap;
      }
      const v = nums[i];
      i += 1;
      return v === undefined ? '' : v;
    });
    return m[1] + out + m[3];
  }

  function translateTextNode(node) {
    const next = translateOne(node.nodeValue);
    // 没变就不写：写回同样的值也会触发 characterData，白白自激一次
    if (next !== node.nodeValue) node.nodeValue = next;
  }

  function translateElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.hasAttribute && el.hasAttribute('data-i18n-skip')) return;
    for (const name of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(name)) continue;
      const v = el.getAttribute(name);
      const next = translateOne(v);
      if (next !== v) el.setAttribute(name, next);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1) return;
    translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      if (n.nodeType === 3) translateTextNode(n);
      else if (!SKIP_TAGS.has(n.tagName) && !(n.hasAttribute && n.hasAttribute('data-i18n-skip'))) {
        translateElement(n);
      }
      n = walker.nextNode();
    }
  }

  function reveal() {
    document.documentElement.classList.remove('i18n-pending');
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') translateTextNode(m.target);
        else if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType === 3) translateTextNode(node);
            else if (node.nodeType === 1) walk(node);
          }
        } else if (m.type === 'attributes' && m.target && m.attributeName) {
          if (ATTRS.includes(m.attributeName)) translateElement(m.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  /** 初次翻译整页（由 main 的 i18n 载荷驱动） */
  function apply(payload) {
    try {
      lang = (payload && payload.lang) === 'en-US' ? 'en-US' : 'zh-CN';
      dict = (payload && payload.dict) || {};
      buildTemplates();
      document.documentElement.setAttribute('lang', lang === 'en-US' ? 'en' : 'zh-CN');
      if (lang !== 'en-US') { reveal(); return; }
      if (document.title) document.title = translateOne(document.title);
      walk(document.body);
      startObserver();
    } catch (_) {
      // 翻译失败绝不能让界面卡在隐藏状态
      reveal();
    }
  }

  /** 语言切换后重新走一遍（先清 observer，避免边改边触发） */
  function retranslate(payload) {
    if (observer) { observer.disconnect(); observer = null; }
    apply(payload);
    reveal();
  }

  window.apkI18n = { apply, retranslate, translateOne, get lang() { return lang; } };
})();

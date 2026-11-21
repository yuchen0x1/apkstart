'use strict';
/**
 * 渲染层的界面翻译（upstream issue #38）。
 *
 * 为什么不给每个元素加 `data-i18n="key"`：
 *   界面里有 250 多条静态文案、再加上动态生成的卡片与 toast，逐个加 key 意味着
 *   几百处改动，改漏一处就是一句中文夹在英文界面里；而且以后新写的文案默认就没 key。
 *   这里改成「按中文原文查词典」：遍历文本节点 + 几个常见属性，命中的换成目标语言，
 *   没命中的保持中文或英文回落。新文案不会显示成 key 或空白。
 *
 * 数字与模板：运行时文本里的数字会被归一成占位符再查表，
 * 所以 `共 3 个应用` 能命中词典里 `共 {n} 个应用` 那条，回填时数字原样还原。
 *
 * 性能：只在翻译环境启用；一次遍历 + MutationObserver 增量翻译，
 * 命中不了的文本直接跳过（不写 DOM，避免 observer 自激）。
 */
(() => {
  const N = '\u0001';
  const CJK = /[\u4e00-\u9fa5]/;
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE']);
  // 当前 renderer 的交互文案；主词典可覆盖，中文往返仍统一记忆源文。
  const SESSION_EN = {
    '正在检查并启用硬件加速…': 'Checking and enabling hardware acceleration…',
    '仅在必要时请求系统授权，用于启动已有加速服务或启用 Windows 系统功能；不会自动安装第三方驱动。': 'System authorization is requested only when needed to start an existing acceleration service or enable Windows features. Third-party drivers are not installed automatically.',
    '停止当前系统': 'Stop current system',
    '取消切换': 'Cancel switch',
    '正在停止…': 'Stopping…',
    '正在停止当前系统…': 'Stopping the current system…',
    '正在切换系统，可取消切换…': 'Switching systems; you can cancel…',
    '无法确认当前系统状态，请刷新后重试': 'Cannot confirm the current system status. Refresh and try again.',
    '切换中': 'Switching',
    '停止中': 'Stopping',
    '当前系统已停止': 'Current system stopped',
    '切换已取消，当前系统已停止': 'Switch cancelled; current system stopped',
    '系统切换已取消': 'System switch cancelled',
    '停止操作已取消': 'Stop operation cancelled',
    '未能确认当前系统已停止': 'Could not confirm that the current system stopped',
    '请查看当前系统的实际运行状态。': 'Check the actual status of the current system.',
    '下载与安装任务不会因此取消；安装器运行时请先在虚拟机内正常关机。': 'Download and installation tasks are not cancelled. If an installer is running, shut it down normally inside the VM first.',
    '取消任务': 'Cancel task',
    '任务已取消': 'Task cancelled',
    '仅取消任务，不停止安装器，也不删除系统数据': 'Cancels only the task; does not stop the installer or delete system data',
    [N + ' · 正在运行']: N + ' · Running',
    [N + ' · 已启动，等待 Android 就绪']: N + ' · Started; waiting for Android',
    [N + ' · 未运行']: N + ' · Not running',
    [N + ' · 已停止']: N + ' · Stopped',
  };

  const LANG_TAGS = { 'zh-CN': 'zh-CN', 'en-US': 'en', 'es-ES': 'es-ES', 'vi-VN': 'vi-VN', 'ru-RU': 'ru-RU' };
  let dict = {};
  let lang = 'zh-CN';
  let observer = null;
  /** 原文记忆：英文化时把中文原文存起来，切回中文时还原（否则 en→zh 现场切换回不去） */
  const originals = new WeakMap();
  const originalAttrs = new WeakMap();
  let originalTitle = null;
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
      return done.join(lang === 'zh-CN' ? '、' : ', ');
    }
    return translateOne(s);
  }

  /** 单条文本翻译：命中返回译文（保留原有首尾空白），否则原样作为清晰回落 */
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

  function skipped(node) {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-i18n-skip')) return true;
    }
    return false;
  }

  function translateTextNode(node) {
    if (skipped(node)) return;
    const v = node.nodeValue;
    if (originals.get(node)?.translated === v) return;
    const next = translateOne(v);
    if (next !== v) {
      originals.set(node, { original: v, translated: next });
      node.nodeValue = next;
    } else if (originals.has(node) && originals.get(node).translated !== v) {
      // 业务代码已改成其他内容，不能在切回中文时恢复过期原文。
      originals.delete(node);
    }
  }

  function translateElement(el) {
    if (!el || el.nodeType !== 1 || skipped(el)) return;
    for (const name of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(name)) continue;
      const v = el.getAttribute(name);
      if (originalAttrs.get(el)?.get(name)?.translated === v) continue;
      const next = translateOne(v);
      if (next !== v) {
        let attrs = originalAttrs.get(el);
        if (!attrs) { attrs = new Map(); originalAttrs.set(el, attrs); }
        attrs.set(name, { original: v, translated: next });
        el.setAttribute(name, next);
      } else {
        const attrs = originalAttrs.get(el);
        if (attrs && attrs.has(name) && attrs.get(name).translated !== v) attrs.delete(name);
      }
    }
  }

  function walk(root) {
    if (!root || skipped(root)) return;
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

  /** 切回中文：把英文化时记下的中文原文写回去（restore 之后再走 reveal） */
  function restoreAll(root) {
    if (!root) return;
    const restore = (node) => {
      if (node.nodeType === 3 && originals.has(node)) {
        const saved = originals.get(node);
        if (node.nodeValue === saved.translated) node.nodeValue = saved.original;
        originals.delete(node);
      } else if (node.nodeType === 1 && originalAttrs.has(node)) {
        for (const [name, saved] of originalAttrs.get(node)) {
          if (node.getAttribute(name) === saved.translated) node.setAttribute(name, saved.original);
        }
        originalAttrs.delete(node);
      }
    };
    restore(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) { restore(n); n = walker.nextNode(); }
    if (originalTitle && document.title === originalTitle.translated) document.title = originalTitle.original;
    originalTitle = null;
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

  /** 初次翻译整页（由 main 的 i18n 载荷驱动）；有效 locale 均以中文原文为查找源。 */
  function apply(payload) {
    try {
      const requested = payload && payload.lang;
      // apply 也可能由宿主直接调用；先停掉旧 observer，再恢复源文，避免恢复动作自触发。
      if (observer) { observer.disconnect(); observer = null; }
      // 直接 apply 新语言也要从中文源文重来；否则已翻译过的节点会被当成源文跳过。
      if (lang !== 'zh-CN') restoreAll(document.body);
      lang = Object.prototype.hasOwnProperty.call(LANG_TAGS, requested) ? requested : 'zh-CN';
      // SESSION_EN 覆盖 renderer 临时文案；IPC 载荷中 locale 译文覆盖英语基线。
      dict = lang === 'zh-CN' ? {} : { ...SESSION_EN, ...(payload && payload.dict) };
      buildTemplates();
      document.documentElement.setAttribute('lang', LANG_TAGS[lang]);
      if (lang === 'zh-CN') {
        if (observer) { observer.disconnect(); observer = null; }
        restoreAll(document.body); reveal(); return;
      }
      if (document.title) {
        const next = translateOne(document.title);
        if (next !== document.title) {
          originalTitle = { original: document.title, translated: next };
          document.title = next;
        }
      }
      walk(document.body);
      startObserver();
      reveal();
    } catch (_) {
      // 翻译失败绝不能让界面卡在隐藏状态
      reveal();
    }
  }

  /** 语言切换后重新走一遍（先清 observer，避免边改边触发） */
  function retranslate(payload) {
    if (observer) { observer.disconnect(); observer = null; }
    // 先恢复源文，重复英文载荷或词典更新也必须从中文重新翻译。
    restoreAll(document.body);
    apply(payload);
    reveal();
  }

  window.apkI18n = { apply, retranslate, translateOne, get lang() { return lang; } };
})();

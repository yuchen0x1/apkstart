'use strict';

const api = window.apkstart;
const a11y = window.apkA11y;
const $ = (id) => document.getElementById(id);

function setText(el, text) {
  const rendered = window.apkI18n?.translateOne(text) ?? text;
  if (el.textContent !== text && el.textContent !== rendered) el.textContent = text;
}

const state = {
  apps: [],
  appList: 'loading',
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
  syncingShared: false,
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 发行说明的 markdown → 简单 HTML（更新日志面板用）。
 * 只做展示需要的几件事：标题、加粗、行内代码、代码块、列表、引用、表格、链接、分隔线。
 * 所有文本先过 esc()，链接只放行 http(s)——Release 正文不该变成脚本注入面。
 * 以前是 textContent 原样整段贴出来，界面上会露出「# 标题」「**加粗**」「| 表格 |」
 * 这些记号，发布说明写得越认真、面板里看着越乱。
 */
function mdToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let code = null, table = null, list = false;
  let quote = [], para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push('</ul>'); list = false; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`); quote = []; } };
  const flushTable = () => {
    if (!table) return;
    out.push(`<table>${table.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join('')}</tr>`).join('')}</table>`);
    table = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (code !== null) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code.push(raw);
      continue;
    }
    if (/^```/.test(line)) { flushAll(); code = []; continue; }
    if (/^\|/.test(line) && /\|$/.test(line)) {
      flushPara(); flushList(); flushQuote();
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // 表头分隔行
      (table = table || []).push(cells);
      continue;
    }
    flushTable();
    if (/^#{1,6}\s+/.test(line)) { flushAll(); out.push(`<h4>${inline(line.replace(/^#{1,6}\s+/, ''))}</h4>`); continue; }
    if (/^>\s?/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^>\s?/, '')); continue; }
    flushQuote();
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      flushPara();
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(line.replace(/^(?:[-*]|\d+\.)\s+/, ''))}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('');
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

/** 应用配色由设置提供（HSL 或十六进制），根据实际亮度挑选占位字颜色。 */
const _inkCache = new Map();
function readableInk(accent) {
  const key = String(accent || '#9aa6b2');
  if (_inkCache.has(key)) return _inkCache.get(key);
  let ink = '#fff';
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#9aa6b2';
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const lin = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const white = 1.05 / (lum + 0.05);
    const dark = (lum + 0.05) / 0.056;
    ink = white >= dark ? '#fff' : '#111827';
  } catch (_) { /* Canvas 不可用时保留默认颜色 */ }
  _inkCache.set(key, ink);
  return ink;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 迷你 toast
 *
 * 同一类消息做去重 + 数量上限：
 * 安装失败时里面有「运行时启动日志」在持续推送，以前每条都新建一个 toast，
 * 于是屏幕上会不停叠加同一条错误，看起来像「失败信息一直循环」。
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① 去重：同样的标题 + 正文（4 秒内）只刷新那一条，不叠加
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② 上限：同时最多 4 条，超出先挤掉最旧的
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}${type === 'warn' ? 'warn' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- 渲染 ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  const trulyEmpty = state.appList === 'ready' && !hasAny;
  const noMatches = state.appList === 'ready' && hasAny && !apps.length;
  const listError = state.appList === 'error';
  const statePanel = $('appListState');
  const clear = $('emptySearchClear');
  const retry = $('retryApps');
  // 隐藏按钮或替换卡片前先转移焦点。
  if ((!noMatches && document.activeElement === clear) || (!listError && document.activeElement === retry)) a11y.focus($('search'));
  clear.hidden = !noMatches;
  retry.hidden = !listError;
  grid.classList.toggle('hidden', !apps.length);
  empty.classList.toggle('hidden', !trulyEmpty);
  statePanel.classList.toggle('hidden', !!apps.length || trulyEmpty);
  if (noMatches) {
    setText($('appListStateTitle'), '没有找到匹配的应用');
    setText($('appListStateNote'), '试试搜索应用名称或包名。');
  } else if (listError) {
    setText($('appListStateTitle'), '读取应用列表失败');
    setText($('appListStateNote'), '应用列表暂时不可用，请重试。');
  } else if (state.appList === 'loading') {
    setText($('appListStateTitle'), '正在读取应用…');
    setText($('appListStateNote'), '');
  }
  if (trulyEmpty) {
    const s = state.status;
    setText($('emptyHint'), s && s.adbOk === false
      ? '首次使用：打开右上角设置 → 运行时 → 一键完成，再回来安装应用即可。'
      : '提示：所有应用共享同一个 Android 运行时，所以第二个应用的启动几乎是瞬时的。');
  }
  if (state.menuPkg && !apps.some((app) => app.package === state.menuPkg)) hideMenu();

  const html = apps.map((a) => {
    const accent = a.accent || '#9aa6b2';
    const run = a.running ? '运行中' : '';
    return `
    <div class="card" role="listitem" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      <button type="button" class="card-launch" data-focus-key="app:${esc(a.package)}"
        aria-label="${esc(a.label)} · ${esc(a.package)}${run ? ` · ${run}` : ''}">
        ${a.pinned ? '<span class="pin" aria-hidden="true">★</span>' : ''}
        ${a.running ? '<span class="badge-run" title="正在运行" aria-hidden="true"></span>' : ''}
        <div class="icon">
          ${a.iconUrl
            ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
            : `<div class="fallback" style="background:${esc(accent)};color:${readableInk(accent)}">${esc(initialOf(a.label))}</div>`}
        </div>
        <div class="name">${esc(a.label)}</div>
        <div class="meta">${a.running ? '运行中' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
        <div class="open-hint" aria-hidden="true">${a.running ? '切换到前台' : '打开'}</div>
      </button>
      <button type="button" class="icon-btn card-menu-btn" data-focus-key="menu:${esc(a.package)}"
        aria-label="更多操作：${esc(a.label)}" aria-haspopup="menu" aria-controls="ctxmenu" aria-expanded="${state.menuPkg === a.package}">
        <span aria-hidden="true">⋯</span>
      </button>
    </div>`;
  }).join('');
  a11y.replace(grid, html, () => grid.querySelector('.card-launch') || $('search'));
}

/* ---------------- 数据刷新 ---------------- */

async function refreshApps() {
  try {
    const apps = await api.listApps();
    if (!Array.isArray(apps)) throw new Error('Invalid apps:list response');
    state.apps = apps;
    state.appList = 'ready';
  } catch (e) {
    // 轮询暂时失败时不移除已经加载的应用。
    if (state.appList !== 'ready') state.appList = 'error';
    console.error(e);
  }
  renderGrid();
  const n = state.apps.length;
  setText($('statusStats'), state.appList === 'ready' ? (n ? `${n} 个应用` : '暂无应用') : '');
}

async function refreshStatus() {
  const request = ++sysUI.statusRequest;
  try {
    let runtimeError = '';
    const [runtime, system] = await Promise.all([
      api.runtimeStatus().catch((e) => { runtimeError = e.message; return null; }),
      api.systemStatus().catch((e) => ({ ok: false, error: e.message })),
    ]);
    if (request !== sysUI.statusRequest) return;
    state.status = runtime || {};
    sysUI.runtimeError = runtimeError;
    sysUI.status = system?.ok && system.current ? system : null;
    sysUI.statusError = sysUI.status ? '' : (system?.error || '无法确认当前系统状态');
    renderRuntimeStatus();
  } catch (e) {
    if (request === sysUI.statusRequest) $('statusText').textContent = `状态检查失败：${e.message}`;
  }
}

function renderRuntimeStatus() {
    const s = state.status || {};
    const session = sysSession();
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (session.message) {
      dot.className = 'dot' + (session.stopping || session.switching ? ' warn' : session.running ? ' ok' : '');
      setText(text, session.message);
      setText(tag, session.stopping ? '停止中' : session.switching ? '切换中' : session.name || '运行状态');
      tag.className = 'brand-tag';
    } else if (sysUI.runtimeError) {
      dot.className = 'dot err';
      text.textContent = `状态检查失败：${sysUI.runtimeError}`;
      setText(tag, '运行状态');
      tag.className = 'brand-tag';
    } else if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = '运行时未部署 —— 打开设置 → 运行时，一键完成';
      tag.textContent = '需要部署';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `运行时已就绪 · Android ${s.android || '?'}${s.freeform ? ' · 独立窗口已启用' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = '正在引导 Android…';
      tag.textContent = '引导中';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      text.textContent = '未检测到硬件加速：已自动回退软件模拟（首次开机较慢）';
      tag.textContent = '软件模拟';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = '缺少 Android 14 通用系统镜像 —— 设置 → 运行时里下载（约 1.5GB，只下一次）';
      tag.textContent = '待下载镜像';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = '运行时引擎未安装 —— 打开设置 → 运行时一键完成';
      tag.textContent = '需要部署';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = '运行时已就绪 —— 安装 APK 或双击桌面图标会自动开机';
      tag.textContent = '待开机';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = '安装程序运行中 —— 请在虚拟机窗口里完成安装';
      tag.textContent = '安装中';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? '运行时待机（安装或打开应用时会自动拉起）'
        : '运行时尚未安装 Android 系统 —— 打开设置 → 运行时继续';
      tag.textContent = s.installed ? '待机' : '待安装';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = session.message
      ? (!session.switching && !session.stopping && session.running ? session.current.serial || '' : '')
      : s.deviceOnline ? (s.serial || '') : '';

    renderSetup(s);
    const stop = $('btnRuntimeStop');
    if (stop) {
      setText(stop, session.stopping ? '正在停止…' : session.switching ? '取消切换' : '停止当前系统');
      stop.setAttribute('aria-disabled', String(session.stopping));
      if (session.stopping) stop.setAttribute('aria-busy', 'true');
      else stop.removeAttribute('aria-busy');
    }
    const start = $('btnRuntimeStart');
    if (start) start.disabled = !session.builtin || session.switching || session.stopping || !!sysUI.statusError;
    if (sysUI.data) renderSysCards();
}

function systemPanelVisible() {
  if (!$('settingsMask')?.classList.contains('on')) return false;
  return ['runtime', 'android'].some((sec) => {
    const panel = document.querySelector(`.set-sec[data-sec="${sec}"]`);
    return panel && !panel.hidden;
  });
}

/* ---------------- 运行时部署（固定在设置里） ---------------- */

/**
 * 运行时/部署/自检面板现在都收在「设置」里，主界面只留已安装应用。
 * 保留 showSetup 给托盘菜单与 ui:navigate 复用，语义改为「打开设置并定位到运行时」。
 */
function showSetup(on, opener) {
  if (!on) { $('setupGuide').hidden = true; return; }
  return openSettings({ section: 'runtime', opener, focusId: 'setTitle' });
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const session = sysSession();
  const canStop = session.switching || session.stopping || session.running
    || (session.builtin && !session.current.stopped && s.deviceOnline);
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // 启动即见已安装应用：不再用部署向导整屏接管主界面，
  // 状态只在设置里的运行时面板 + 底部状态条上体现。
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('引擎');
    if (!imgDone0) missing.push('系统镜像');
    stateText.textContent = session.message || (s.deviceOnline
      ? `已就绪 · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? '正在引导 Android…'
        : allDone0
          ? '组件齐全 · 待开机（打开应用时自动拉起）'
          : `缺少 ${missing.join('、')}${accelOk ? '' : '（无硬件加速，将回退软件模拟）'}`);
    stateText.title = session.message ? '' : s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // 只保留一个步骤：下载、参数自适应、开机全部由「一键完成」串起来，
  // 且首次启动会在后台自动跑，用户不需要逐步点击。
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('adb 工具链');
  if (!emuDone) left.push('Android 运行时');
  if (!imgDone) left.push('系统镜像');
  const step = {
    key: 'all',
    index: 1,
    title: !session.builtin ? session.name : allDone ? '一切就绪' : '一键完成',
    tag: !session.builtin ? '运行状态' : allDone ? '已自动完成' : '自动',
    done: allDone,
    busy: !!busy,
    desc: session.message || (s.deviceOnline
      ? `Android ${s.android || ''} 已就绪 · 应用窗口会按屏幕自动适配`
      : booting
        ? '正在引导 Android…'
        : allDone
          ? '组件齐全，双击任意 APK 或桌面图标即会自动开机'
          : `还差 ${left.join('、')}；点下面「一键完成」，会在后台一次装好并自动开机`),
    actions: canStop
      ? `<button type="button" class="btn ghost sm" data-act="vmStop" data-focus-key="runtime:stop" ${session.stopping ? 'aria-disabled="true" aria-busy="true"' : ''}>${session.stopping ? '正在停止…' : session.switching ? '取消切换' : '停止当前系统'}</button>`
      : '',
  };

  a11y.replace($('setupSteps'), stepRow(step), () => $('btnDeployAll'));
  $('btnDeployAll').disabled = !!busy || !session.builtin || session.switching || session.stopping;
  $('btnDeployAll').textContent = busy ? '准备中…' : (allDone ? '已完成 · 点此复查' : '一键完成');
  // 「上次为什么没起来」优先显示落盘的失败记录：进程重启后内存里的 diagnosis 是空的，
  // 只显示 autoProfile 会让用户完全看不出原因（issue #20/#25 的报告就是这样）。
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `上次启动失败：${lf.diagnosis.title}`
    : (s.diagnosis ? `上次启动自动诊断：${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || '全自动：无需选择镜像、无需启用加速、无需调内存';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // 五步已合并成一行，所有子步骤的进度都落在这唯一的进度条上
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

/**
 * 部署实时日志：把 provision:progress 的每一步都落成一行（带时间戳），
 * 让用户清楚看见「在下载、在流动、在干活」——测速、下载速度、解压进度、
 * 换源/慢速逃生全部可见，而不是只盯着一条百分比。
 */
function appendDeployLog(p) {
  const box = $('deployLog');
  const wrap = $('deployLogWrap');
  if (!box || !wrap) return;
  const msg = String((p && p.message) || '').trim();
  if (!msg) return;
  const line = document.createElement('div');
  line.className = 'dl-line';
  if (p && p.stage === 'done') line.classList.add('ok');
  if (p && p.stage === 'error') line.classList.add('err');
  const t = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${t}] ${msg}`;
  wrap.hidden = false;
  // 先看追加前的位置：只有本来就在底部附近时才跟随新日志。
  const follow = box.scrollHeight - box.clientHeight - box.scrollTop <= 2;
  box.appendChild(line);
  // 长会话防膨胀：最多保留 400 行
  while (box.children.length > 400) box.removeChild(box.firstChild);
  if (follow) box.scrollTop = box.scrollHeight;
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  appendDeployLog({ stage: 'info', message: '—— 开始部署运行时（手动触发）——' });
  try {
    // 一次调用把 adb / 引擎 / 系统镜像全装完，进度统一显示在唯一那一行
    const r = await api.autoDeploy();
    if (!r || !r.ok) {
      appendDeployLog({ stage: 'error', message: `部署失败：${(r && (r.message || r.error)) || '请检查网络后重试'}` });
      toast({ title: '准备失败', body: (r && (r.message || r.error)) || '请检查网络后重试', type: 'error', sticky: true });
      return;
    }
    appendDeployLog({ stage: 'done', message: '运行时组件部署完成' });
    await refreshStatus();
    toast({ title: '组件已就绪，正在自动开机…', body: '首次约 1-3 分钟，之后几秒即可。', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    if (started && started.ok) {
      toast({ title: '运行时已就绪', body: '现在把 APK 拖进窗口，或双击桌面图标即可。', type: 'ok' });
    } else {
      // 不再丢一大段错误文本：直接给「一键修复」窗口
      openRepair(started);
    }
  } catch (e) {
    toast({ title: '准备失败', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: '已有部署任务进行中' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: '正在检查并启用硬件加速…',
        body: '仅在必要时请求系统授权，用于启动已有加速服务或启用 Windows 系统功能；不会自动安装第三方驱动。',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: '硬件加速已启用', type: 'ok' });
      else t.update({ title: '加速未启用', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: '未知步骤' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: '无法启动安装环境', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: '虚拟机窗口已打开', body: '按下方 6 步完成安装；装好后点「我已安装完成」。', type: 'ok', sticky: true });
}

async function markInstalled() {
  const btn = $('btnMarkInstalled');
  if (btn.disabled) return false;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const r = await api.markInstalled();
    if (!r?.ok) {
      toast({ title: '无法确认安装完成', body: r?.error || '请先在虚拟机内完成安装并正常关机，再重试。', type: 'error' });
      return false;
    }
    const stopped = await api.runtimeStop().catch((e) => ({ ok: false, error: e.message }));
    if (!stopped?.ok) {
      toast({ title: '停止失败', body: stopped?.error || '请在虚拟机内正常关机', type: 'error' });
      return false;
    }
    $('setupGuide').hidden = true;
    await refreshStatus();
    toast({ title: '安装完成，运行时已接管', body: '现在可以直接把 APK 拖进来安装了。', type: 'ok' });
    return true;
  } catch (e) {
    toast({ title: '无法确认安装完成', body: e?.message || '请稍后重试。', type: 'error' });
    return false;
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}



/* ---------------- 安装 ---------------- */

/** 把安装失败翻译成「下一步该做什么」，只对最常见的几种做提示，其它原样显示 */
function friendlyInstallErrorText(msg, filePath) {
  const s = String(msg || '未知错误');
  // 文件名是 a.apk.1 / a.apk.tmp 这种下载残留，又解析不出来 → 通常就是没下完。
  // 直接说「不是有效的 APK」会让人以为是文件选错了，白折腾一遍重新拖。
  if (filePath && /\.[a-z]+\.(\d{1,3}|tmp|temp|part|partial|download|crdownload|filepart)$/i.test(String(filePath))
    && /EOCD|过小|不是有效的|截断|越界|损坏|中央目录/.test(s)) {
    return `${s}\n文件名末尾的 .1 / .tmp 是下载工具留下的临时后缀，这个安装包可能还没下载完。`
      + '等下载完成（或重新下载一份完整的）再装。';
  }
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|ENOSPC/i.test(s)) {
    return `${s}\n安卓数据分区不够用：设置 → 性能与资源占用 → 安卓数据分区调大后点「立即扩容」。`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\n这个包只有 ARM 库，正在自动切换兼容镜像后重试。`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\n同包名但签名不同（常见于从别的渠道装过）。在应用卡片右键「卸载」后再装。`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\n已装版本更高，先在右键菜单里卸载再装。`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\n这个安装包过大或内存不足，解析被系统拒绝了。请确认磁盘与内存充足后重试；`
      + '仍失败请把安装包路径换成纯英文短路径（如 D:\\a.apk）。';
  }
  return s;
}

/* 当前那条「正在安装…」的 sticky 提示。install:error 事件要能把它收掉：
 * 主进程是先 send('install:error') 再让 invoke 失败的，两者都可能到得很晚，
 * 只靠 catch 收会出现「报错了右下角还在转圈」。 */
let installToast = null;
const installErrors = new Map();
function showInstallError(file, message) {
  const reason = String(message || '未知错误').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const body = friendlyInstallErrorText(reason, file);
  const key = `${file || ''}\n${body}`;
  const now = Date.now();
  for (const [k, at] of installErrors) if (now - at >= 8000) installErrors.delete(k);
  if (installErrors.has(key)) return;
  installErrors.set(key, now);
  const name = file ? String(file).split(/[\\/]/).pop() : '';
  toast({ title: name ? `安装失败：${name}` : '安装失败', body, type: 'error' });
  maybeOpenRepair(body);
}

async function installFiles(paths) {
  if (!paths?.length) return;
  if (state.installing) {
    toast({ title: '已有安装任务在进行', body: '请等当前应用装完再继续。' });
    return;
  }
  state.installing = true;
  try {
    await installBatch(paths);
  } finally {
    state.installing = false;
  }
}

async function installBatch(paths) {
  let ok = 0;
  let skipped = 0;
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    for (const key of installErrors.keys()) if (key.startsWith(`${p}\n`)) installErrors.delete(key);
    // 装之前先做兼容性检查：只有「基本兼容」以上才直接装；
    // 明确有问题的（架构不匹配、系统版本不够、拆分分片）先问用户一句，
    // 让他在装之前就知道「大概率打不开」，而不是装完再猜为什么。
    let comp = null;
    try { comp = (await api.compatApk(p)).compat; } catch (_) { comp = null; }
    if (comp && (comp.level === 'risky' || comp.level === 'unsupported')) {
      const why = comp.reasons.filter((r) => r.kind !== 'info').map((r) => `• ${r.text}`).join('\n');
      let confirmation;
      try {
        confirmation = await api.confirm({
          type: 'warning',
          title: `${name}：${comp.label}`,
          message: '安装前的兼容性检查发现这个包可能跑不起来。',
          detail: `${why}\n\n评估环境：${comp.env.source}\n\n仍然要继续安装吗？`,
          okLabel: '仍然安装',
          danger: true,
        });
      } catch (e) {
        toast({ title: `未安装 ${name}`, body: `无法确认安装：${e.message || '请重试'}`, type: 'error' });
        continue;
      }
      if (confirmation?.response !== 1) { skipped += 1; continue; }
    } else if (comp && comp.level === 'partial') {
      const why = comp.reasons.filter((r) => r.kind === 'warn').map((r) => r.text).join(' ');
      const onlyArmTranslation = comp.reasons
        .filter((r) => r.kind !== 'info')
        .every((r) => r.code === 'abi-arm-translated');
      if (why && !onlyArmTranslation) toast({ title: `${name}：${comp.label}`, body: why, type: 'warn' });
    }

    const t = toast({ title: `正在安装 ${name}`, body: '解析 APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `正在安装 ${pr.meta.label}` : `正在安装 ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      if (!r?.app) throw new Error(r?.error || '没有收到有效的安装结果。');
      t.update({ title: `${r.app.label} 已安装`, body: !shellSupported() ? '可在应用库中打开应用；桌面快捷方式当前仅支持 Windows。' : r.app.shortcutPath ? '桌面快捷方式已创建，双击即可直接打开。' : '可在应用卡片右键创建桌面快捷方式。', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} 兼容性提示`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      // 先把那条「正在安装…」的 sticky 提示收掉，否则它会一直转圈、还继续被
      // 运行时日志刷新 —— 用户看到的就是「失败信息一直在循环」。
      // IPC 本身拒绝时可能没有 install:error 推送，仍要显示文件名与原因；
      // 和推送共用去重入口，避免同一次失败弹两条。
      t.dismiss();
      showInstallError(p, e?.message || '未知错误');
    } finally {
      try { off(); } catch (_) { /* ignore */ }
      if (installToast === t) installToast = null;
    }
  }

  if (ok) {
    $('search').value = state.filter = '';
    renderGrid();
  }
  await refreshApps();
  // 用户因为兼容性提示主动取消的，给一句明确回执，避免「点了安装却什么都没发生」
  if (skipped) toast({ title: `已跳过 ${skipped} 个安装`, body: '兼容性检查未通过，按你的选择没有继续安装。' });
}

/* ---------------- 应用操作 ---------------- */

function sharedSyncFeedback(r) {
  if (r?.skipped === true) return { title: '本次未执行同步', body: r.error || '已有同步正在进行，请稍后再试。', type: 'info' };
  const errors = Array.isArray(r?.errors) ? r.errors : [];
  const counts = [
    ['pushed', '上传'], ['pulled', '下载'], ['deleted', '移入回收目录'],
    ['conflicts', '冲突'], ['pendingDeletes', '待确认删除'], ['skipped', '跳过'],
  ];
  const summary = counts.filter(([k]) => Number.isFinite(r?.[k]) && r[k] > 0)
    .map(([k, label]) => `${label} ${r[k]} 项`).join(' · ');
  const transferred = r?.pushed > 0 || r?.pulled > 0 || r?.deleted > 0;
  if (r?.error || r?.ok === false || errors.length) {
    const reason = [r.error, errors.length && `${errors.length} 项出错：${errors[0]}`].filter(Boolean).join('；');
    return {
      title: transferred ? '共享目录部分同步' : '同步失败',
      body: [summary, reason || '同步未完成，请稍后重试。'].filter(Boolean).join('。'),
      type: transferred ? 'warn' : 'error',
    };
  }
  // 当前 sharer 成功时返回计数，没有 ok 字段。
  if (r?.ok !== true && !counts.some(([k]) => Number.isFinite(r?.[k]))) {
    return { title: '同步失败', body: '没有收到有效的同步结果。', type: 'error' };
  }
  if (r.conflicts > 0 || r.pendingDeletes > 0 || r.skipped > 0) {
    return { title: '共享目录有未同步项', body: summary, type: 'warn' };
  }
  return { title: '已同步共享目录', body: summary || '没有需要同步的变更。', type: 'ok' };
}

async function syncSharedNow() {
  if (state.syncingShared) return;
  const btn = $('btnSyncShared');
  state.syncingShared = btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  setText(btn, '正在同步…');
  try {
    toast(sharedSyncFeedback(await api.syncShared()));
  } catch (e) {
    toast({ title: '同步失败', body: e?.message || '请稍后重试。', type: 'error' });
  } finally {
    // 写回源语言，避免在英文期间缓存的按钮文字跨语言残留。
    setText(btn, '立即同步');
    btn.removeAttribute('aria-busy');
    state.syncingShared = btn.disabled = false;
  }
}

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `正在打开 ${app ? app.label : pkg}`,
    body: '首次启动需要预热运行时，请稍候…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // 嵌入后宿主画黑帧时，程序会摘成独立窗口：必须说清楚，别让用户对着黑底以为又坏了
    t.update(r.detached
      ? {
        title: '已在独立窗口打开',
        body: '画面在「Android Emulator」窗口里，这里不再显示黑屏；下次启动会直接用它。',
        type: 'ok',
      }
      : { title: '已启动', body: '应用正在独立窗口中运行（顶部可旋转屏幕）。', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: '启动失败', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  if (!shellSupported()) {
    toast({ title: '当前平台不支持桌面快捷方式', body: '桌面快捷方式当前仅支持 Windows，请从应用库打开应用。', type: 'info' });
    return;
  }
  try {
    const r = await api.createShortcut(pkg);
    if (!r?.ok) throw new Error(r?.error || '未能创建快捷方式');
    toast({ title: '桌面快捷方式已创建', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: '创建快捷方式失败', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`确定卸载「${app.label}」？\n\n应用数据会一并被清除，桌面快捷方式也会被删除。`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: '已卸载', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: '卸载失败', body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: '打开应用', kbd: 'Enter' },
  { key: 'shortcut', label: '创建桌面快捷方式' },
  { key: 'pin', label: '固定到顶部' },
  { divider: true },
  { key: 'reveal', label: '打开 APK 所在位置' },
  { key: 'exportApk', label: '导出 APK…' },
  { key: 'backup', label: '备份应用…' },
  { key: 'restore', label: '从备份恢复…' },
  { key: 'clear', label: '清除应用数据' },
  { divider: true },
  { key: 'uninstall', label: '卸载', danger: true },
];

let menuOpener = null;
let menuPoint = null;

function cardMenuButton(pkg) {
  return [...$('grid').querySelectorAll('.card-menu-btn')].find((b) => b.closest('.card').dataset.pkg === pkg);
}

function positionMenu() {
  if (!menuPoint) return;
  const menu = $('ctxmenu');
  const { x, y } = menuPoint;
  const margin = 8;
  menu.style.maxHeight = `${Math.max(0, window.innerHeight - margin * 2)}px`;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
}

function showMenu(x, y, pkg, opener = cardMenuButton(pkg)) {
  if (a11y.top()) return;
  const menu = $('ctxmenu');
  hideMenu(false);
  state.menuPkg = pkg;
  menuOpener = a11y.bookmark(opener);
  const app = state.apps.find((a) => a.package === pkg);
  menu.innerHTML = MENU_ITEMS.map((it) => {
    if (it.divider) return '<div class="divider" role="separator"></div>';
    const unsupported = it.key === 'shortcut' && !shellSupported();
    const label = unsupported ? '桌面快捷方式（仅 Windows）' : it.key === 'pin' ? (app && app.pinned ? '取消固定' : '固定到顶部') : it.label;
    return `<button type="button" class="item ${it.danger ? 'danger' : ''}" role="menuitem" tabindex="-1" data-act="${it.key}" ${unsupported ? 'aria-disabled="true" title="当前平台不支持桌面快捷方式"' : ''}>
      <span>${esc(label)}</span>${it.kbd ? `<span class="k" aria-hidden="true">${it.kbd}</span>` : ''}
    </button>`;
  }).join('');
  menuPoint = { x, y };
  menu.classList.add('on');
  cardMenuButton(pkg)?.setAttribute('aria-expanded', 'true');
  positionMenu();
  a11y.focus(menu.querySelector('.item'));
}

function hideMenu(restore = true) {
  const menu = $('ctxmenu');
  if (!menu.classList.contains('on')) return false;
  menu.classList.remove('on');
  cardMenuButton(state.menuPkg)?.setAttribute('aria-expanded', 'false');
  state.menuPkg = null;
  menuPoint = null;
  const opener = menuOpener;
  menuOpener = null;
  if (restore && !a11y.focus(opener)) a11y.focus($('search'));
  return true;
}

function openCardMenu(button, opener = button) {
  if (!button) return;
  const rect = button.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, button.closest('.card').dataset.pkg, opener);
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'reveal': return api.revealApk(pkg);
    case 'exportApk': {
      try {
        const r = await api.exportApk(pkg);
        if (r && r.ok) toast({ title: 'APK 已导出', body: r.path, type: 'ok' });
      } catch (e) {
        toast({ title: '导出失败', body: e.message, type: 'error' });
      }
      return undefined;
    }
    case 'backup': {
      const t = toast({ title: `正在备份 ${app.label}`, body: '准备中…', sticky: true, spinner: true });
      try {
        const r = await api.backupApp(pkg);
        t.dismiss();
        if (!r || r.canceled) return undefined;
        toast({
          title: `${app.label} 已备份`,
          body: r.dataIncluded
            ? `APK 与数据都已保存到 ${r.folder}`
            : `已保存到 ${r.folder}\n${r.dataNote || ''}`,
          type: r.dataIncluded ? 'ok' : 'warn',
          sticky: false,
        });
      } catch (e) {
        t.dismiss();
        toast({ title: '备份失败', body: e.message, type: 'error' });
      }
      return undefined;
    }
    case 'restore': {
      const t = toast({ title: '正在从备份恢复', body: '安装 APK…', sticky: true, spinner: true });
      try {
        const r = await api.restoreApp();
        t.dismiss();
        if (!r || r.canceled) return undefined;
        toast({
          title: r.dataRestored ? '应用与数据已恢复' : '应用已恢复',
          body: r.note || '',
          type: r.dataRestored ? 'ok' : 'warn',
        });
        await refreshApps();
      } catch (e) {
        t.dismiss();
        toast({ title: '恢复失败', body: e.message, type: 'error' });
      }
      return undefined;
    }
    case 'clear': {
      if (!window.confirm(`清除「${app.label}」的全部数据？此操作不可撤销。`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: '数据已清除', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: '清除失败', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/* ---------------- 设置 ---------------- */

// ---------------- 安卓系统设置 ----------------

let volumeTimer = null;
// 刚拖过滑杆的时刻：这段时间内不让状态刷新把滑杆拽回去（拖完到设备回读有 1~2 秒延迟）
let volumeTouchedAt = 0;
let volumeBusy = false;
let volumePending = null;

/** 只改滑杆和百分比文字，两个地方永远同步 */
function renderVolume(percent) {
  const slider = $('setAndroidVolume');
  if (!slider) return;
  slider.value = String(percent);
  $('androidVolumeText').textContent = `${percent}%`;
}

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = '读取中…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `运行时未就绪（${String(r.error).slice(0, 36)}）` : '运行时未启动';
    return;
  }
  // 音量读不出来（镜像差异）时显示「未知」，绝不兜成 0 —— 否则滑杆会被拽回最左边
  const volText = typeof r.volume === 'number' ? `音量 ${r.volume}%` : '音量未知';
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi 已开' : 'Wi-Fi 已关'}` +
    `${r.airplane ? ' · 飞行模式' : ''} · ${volText}`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  if (typeof r.volume === 'number' && !volumeBusy && Date.now() - volumeTouchedAt > 1500) {
    renderVolume(r.volume);
  }
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

/** 提交音量：用设备回读的真实百分比回填滑杆，而不是用户拖到的理论值 */
async function applyVolume(percent) {
  // 调整期间用户可能又拖了一次：只记最后一个值，等这一轮结束再补跑，
  // 免得几次 adb 调用互相叠加（有些镜像要走音量键，一次要好几百毫秒到几秒）
  if (volumeBusy) {
    volumePending = percent;
    return;
  }
  volumeBusy = true;
  $('androidVolumeText').textContent = `${percent}% …`;
  try {
    const r = await api.android.set('volume', percent).catch(() => null);
    volumeTouchedAt = Date.now();
    if (!r || !r.ok) {
      renderVolume(percent);
      toast({ type: 'error', title: `音量调整失败：${(r && r.error) || '运行时未就绪'}` });
      return;
    }
    const actual = typeof r.actualVolume === 'number' ? r.actualVolume : null;
    // 三种结果分开说清楚，别一边显示 100% 一边设备还是原样：
    //   1) 回读等于目标      → 正常
    //   2) 回读到别的档位    → 设备没接受（这类镜像上 --set 被 AudioService 拒绝）
    //   3) 回读不到          → 保留用户拖到的值，不猜
    if (actual === null) {
      renderVolume(percent);
      toast({ type: 'ok', title: '音量已调整' });
    } else {
      renderVolume(actual);
      if (r.verified === false && actual !== Number(percent)) {
        toast({ type: 'warn', title: `设备没有接受音量调整（当前 ${actual}%）` });
      } else {
        toast({ type: 'ok', title: '音量已调整' });
      }
    }
    await refreshAndroid();
  } finally {
    volumeBusy = false;
    volumeTouchedAt = Date.now();
    const next = volumePending;
    volumePending = null;
    if (next !== null) applyVolume(next);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || '已生效') : `失败：${(r && r.error) || '运行时未就绪'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi 已开启' : 'Wi-Fi 已关闭'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? '已进入飞行模式' : '已退出飞行模式'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? '系统动画已开启' : '系统动画已关闭，界面更快'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), '字体大小已调整'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), '显示大小已调整'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    // 拖动过程中只更新本地显示，停手 260ms 再提交，避免把 adb 打满
    $('androidVolumeText').textContent = `${v}%`;
    volumeTouchedAt = Date.now();
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => applyVolume(v), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? '已优化：动画关闭、后台放宽、电池白名单' : '优化失败，运行时可能未启动' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: '需要先打开一次应用，让运行时启动' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/* ---------------- 安卓客机：中文界面 + 预装应用精简 ---------------- */
// guest:state 每次都会问一遍设备（pm list packages -u 有点慢），所以缓存 15 秒，
// 用户点了精简/恢复之后再强制刷新。
let guestCache = null;
let guestFetchedAt = 0;

function guestCheckedIds(r) {
  const saved = (state.settings && state.settings.guest && state.settings.guest.groups) || [];
  const source = saved.length ? saved : (r.groups || []).filter((g) => g.defaultOn).map((g) => g.id);
  return new Set(source);
}

function renderGuest(r) {
  const note = $('guestLocaleText');
  if (!note) return;
  const desired = r.desired || '';
  const live = r.live || null;
  const liveZh = !!(live && live.localeChinese);
  const liveTag = (live && live.locale) || '';
  const parts = [];
  if (desired === 'zh-CN') {
    if (liveZh) parts.push('已生效：系统界面为简体中文');
    else if (!r.online) parts.push('已保存设置；安卓现在没运行，下次启动时会应用');
    else parts.push(`还没生效（当前 ${liveTag || '系统默认'}）——点下面的按钮会重启一次安卓来完成切换`);
  } else {
    parts.push(`当前是镜像默认语言（${liveTag || '英文'}），未做汉化`);
  }
  if (r.online && live && !live.error) {
    const gone = (live.trimmed || []).length;
    parts.push(gone ? `已移除 ${gone} 个预装应用` : '预装应用未做精简');
  } else {
    parts.push('安卓未运行，预装应用状态未知');
  }
  note.textContent = parts.join(' · ');

  const wrap = $('guestTrimList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!r.online || !live || live.error) {
    const tip = document.createElement('div');
    tip.className = 'guest-empty';
    tip.textContent = '打开任意一个应用让安卓运行起来，这里会显示可以精简的预装应用。';
    wrap.appendChild(tip);
    return;
  }
  const checked = guestCheckedIds(r);
  for (const g of (live.groups || r.groups || [])) {
    const row = document.createElement('label');
    row.className = `guest-item${g.risk === 'danger' ? ' danger' : ''}${g.remaining === 0 ? ' gone' : ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = g.id;
    box.checked = checked.has(g.id);
    const body = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'gt';
    t.textContent = g.label;
    const d = document.createElement('div');
    d.className = 'gd';
    d.textContent = g.note;
    const c = document.createElement('div');
    c.className = 'gcount';
    const total = Number(g.total || 0);
    const left = Number(g.remaining || 0);
    c.textContent = total === 0
      ? '当前系统里没有这一组应用'
      : (left === 0 ? `已全部移除（${total} 个，可一键恢复）` : `还有 ${left} / ${total} 个在系统里`);
    body.append(t, d, c);
    row.append(box, body);
    wrap.appendChild(row);
  }
}

async function refreshGuest(force = false) {
  if (!guestCache || force || Date.now() - guestFetchedAt > 15000) {
    guestCache = await api.guestState().catch(() => null);
    guestFetchedAt = Date.now();
  }
  if (guestCache) renderGuest(guestCache);
}

function fillSettings(s) {
  $('setEngineMode').value = s.engine.mode;
  $('setAdbPath').value = s.adbPath || '';
  $('setDevice').value = s.device || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  // 内存 / 核心是下拉框：老配置里可能存着不在选项里的数值（旧版是数字输入框），
  // 补一条「自定义」再选中，否则会显示成空白，用户以为设置丢了。
  fillChoice($('setMemory'), Number(s.engine.memoryMB) || 0,
    (v) => `${Math.round((Number(v) / 1024) * 10) / 10} GB（自定义）`);
  fillChoice($('setCores'), Number(s.engine.cores) || 0, (v) => `${v} 核（自定义）`);
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGithubToken')) $('setGithubToken').value = (s.runtime && s.runtime.githubToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setProxyUrl')) $('setProxyUrl').value = (s.runtime && s.runtime.proxyUrl) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  if ($('setMicrophone')) $('setMicrophone').checked = s.engine.microphone !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  if ($('setImageFlavor')) {
    $('setImageFlavor').value = (s.runtime && s.runtime.systemImageFlavor) || 'google_apis_playstore';
  }
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  // 默认关闭：开机自启只对「每天都用」的人有意义，其他人白等一次登录启动。
  // 老版本默认是 true，所以这里必须写 === true，不能再用 !== false。
  $('setAutoStart').checked = s.autoStart === true;
  if ($('setLanguage')) $('setLanguage').value = s.language || 'auto';
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setGpuMode')) $('setGpuMode').value = eng.gpuMode || 'auto';
  if ($('setWindowMode')) $('setWindowMode').value = eng.windowMode || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  const peripheral = s.peripherals || {};
  for (const [id, key] of [['setCameraBack', 'cameraBack'], ['setCameraFront', 'cameraFront']]) {
    const select = $(id);
    const value = peripheral[key] || 'none';
    if (select) {
      if (![...select.options].some(option => option.value === value)) select.add(new Option(value, value));
      select.value = value;
    }
  }
  if ($('setRefreshRate')) $('setRefreshRate').value = String(peripheral.refreshRate || 60);
  if ($('setSerialPort')) $('setSerialPort').value = peripheral.serialPort || '';
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  $('setPortrait').value = d.portrait || '900x1600';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
  refreshGuest();
}

/** 数据分区实际大小 + 磁盘余量，显示在设置页容量选择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = '读取数据分区信息失败'; return; }
  const auto = !Number(state.settings?.engine?.dataPartitionGB || 0);
  const img = info.imageGB ? `${info.imageGB} GB` : '尚未创建';
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : '未知';
  el.textContent = `当前数据分区镜像：${img}${auto ? '（自动）' : ''} · 所在磁盘剩余 ${free}。`
    + '游戏提示「存储空间不足」就把这里调大后点「立即扩容」——扩容是就地做的，已装应用与存档都保留。';
}

let dataSizeBusy = false;
async function applyDataCapacity(gb) {
  if (dataSizeBusy) return false;
  dataSizeBusy = true;
  const controls = ['setDataGB', 'wizDataGB', 'btnGrowData'].map($).filter(Boolean);
  const disabled = controls.map((el) => el.disabled);
  controls.forEach((el) => { el.disabled = true; el.setAttribute('aria-busy', 'true'); });
  try {
    if (gb) {
      const confirmation = await api.confirm({
        title: '立刻把安卓数据分区扩容？',
        message: `将把 /data 调整为 ${gb} GB（就地扩容，已装应用和存档都会保留）。`,
        detail: '扩容需要先关掉正在运行的安卓应用，完成后下次打开应用会重新引导，约多花十几秒。只有扩容成功才会保存容量设置。',
        okLabel: '开始扩容', danger: true,
      });
      if (confirmation?.response !== 1) return false;
    }
    setText($('btnGrowData'), '扩容中…');
    const r = await api.setDataSize(gb);
    if (r?.cancelled) return false;
    if (!r?.ok) throw new Error(r?.error || '扩容未完成，容量设置未保存。');
    state.settings = await api.getSettings().catch(() => ({
      ...state.settings, engine: { ...state.settings?.engine, dataPartitionGB: gb },
    }));
    toast({ title: r.auto ? '已恢复自动容量' : '数据分区已扩容',
      body: r.auto ? '现有数据分区保留，后续容量由软件按磁盘余量决定。' : `现在约 ${r.imageGB || gb} GB 可用`, type: 'ok' });
    return true;
  } catch (e) {
    toast({ title: '扩容失败', body: e?.message || '请稍后重试。', type: 'error' });
    return false;
  } finally {
    for (const id of ['setDataGB', 'wizDataGB']) if ($(id)) $(id).value = String(state.settings?.engine?.dataPartitionGB || 0);
    setText($('btnGrowData'), '立即扩容');
    controls.forEach((el, i) => { el.disabled = disabled[i]; el.removeAttribute('aria-busy'); });
    dataSizeBusy = false;
    refreshDataInfo();
  }
}

/**
 * 拉一次「自动参数摘要」：实跑参数 + 低配降级原因 + 哪些项被手动钉住。
 * 设置页展示、切换资源策略/内存/核心/渲染后端之后都走这里 ——
 * 只维护一个来源，界面上就不可能和实跑参数对不上。
 */
async function refreshProfileText() {
  const r = await api.doctorProfile().catch(() => null);
  if ($('autoProfileText')) $('autoProfileText').textContent = (r && r.text) || '自动模式';
  // 把「你的电脑有多少内存/多少线程」直接摆出来：只写「自动：3GB」用户没法判断
  // 是程序没看配置，还是这就是它算出来的结果。
  const hostEl = $('hostSpecText');
  const host = r && r.profile && r.profile.host;
  if (hostEl && host) {
    const gb = (mb) => `${(Number(mb) / 1024).toFixed(Number(mb) % 1024 === 0 ? 0 : 1)} GB`;
    hostEl.textContent = `你的电脑：${gb(host.totalMB)} 内存 · ${host.cores} 线程`
      + `（当前可用 ${gb(host.freeMB)}）`;
  }
  const tierEl = $('autoTierText');
  if (tierEl) {
    const why = [r && r.why, r && r.manual].filter(Boolean).join(' ');
    tierEl.textContent = why || (r ? '这台机器不需要降级，参数按均衡档自动选择。' : '自动模式');
  }
  return r;
}

/* ---------------- 自定义镜像（可插拔 image adapter） ---------------- */

/**
 * 拉一次镜像状态，把「当前用的是哪套 / 从哪来 / 为什么不可用」画到设置页。
 * 只读 image:status 一个通道：列表、默认镜像健康度、不可用原因都来自同一份数据，
 * 不会出现「列表说能用、实际起不来」。
 */
async function refreshImagePanel() {
  const box = $('setActiveImage');
  const r = await api.imageStatus().catch(() => null);
  const items = (r && Array.isArray(r.items)) ? r.items : [];
  const def = (r && r.defaultImage) || null;
  const builtIns = (r && Array.isArray(r.builtInImages)) ? r.builtInImages : [];
  const selectedBuiltIn = builtIns.find((x) => x.id === (r && r.selectedFlavor)) || def;
  state.images = items;
  state.imageStatus = r;

  if ($('setImageFlavor')) {
    $('setImageFlavor').value = (r && r.selectedFlavor)
      || (state.settings && state.settings.runtime && state.settings.runtime.systemImageFlavor)
      || 'google_apis_playstore';
  }
  if ($('imageFlavorStatus')) {
    if (selectedBuiltIn) {
      const readiness = selectedBuiltIn.ok ? '已下载，可直接启动' : `尚未下载（${selectedBuiltIn.note || '需要下载'}）`;
      const services = selectedBuiltIn.playStore ? '含 Google Play 商店'
        : (selectedBuiltIn.gms ? '含 Google 服务，不含 Play 商店' : '不含 Google 服务');
      $('imageFlavorStatus').textContent = `${selectedBuiltIn.label} · ${services} · ${readiness} · 独立 AVD：${selectedBuiltIn.avd}`;
    } else {
      $('imageFlavorStatus').textContent = '系统镜像状态读取失败，请稍后刷新。';
    }
  }

  if (box) {
    box.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = `内置镜像：${(def && def.label) || 'Android 14 · Google Play · x86_64'}`
      + (def && def.ok === false ? `（当前不可用：${def.note || '未下载'}）` : '');
    box.appendChild(opt0);
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.id;
      // 不可用的镜像也允许选中：只有选中了才看得到「为什么不可用」。
      // 真正拦住的是启用按钮（paintImageSelection 里按 state 灰掉），
      // 用 disabled 选项挡住的话，用户永远读不到原因。
      o.textContent = `${it.name} · Android ${it.api || '?'} · ${it.abi || '?'}`
        + (it.state === 'ok' ? '' : '（不可用）');
      box.appendChild(o);
    }
    const want = (r && r.activeId) || '';
    box.value = want;
    if (box.value !== want) box.value = '';
  }

  const act = r && r.active;
  const activeText = $('imageActiveText');
  if (activeText) {
    if (act && act.custom && act.ok) {
      activeText.textContent = `自定义镜像：${act.name}（Android ${act.api} · ${act.abi}）`;
    } else if (act && act.custom && !act.ok) {
      activeText.textContent = `自定义镜像「${act.name || act.id}」当前不可用，正在使用默认镜像`;
    } else {
      activeText.textContent = `内置镜像：${(def && def.note) || 'Android 14 · Google Play · x86_64'}`;
    }
  }
  paintImageSelection();
  return r;
}

/**
 * 按下拉框当前选中项刷新「来源 / 不可用原因 / 启用按钮」。
 * 上方「当前使用的系统镜像」那一行永远只描述**正在跑**的镜像；
 * 这里描述的是下拉里**被选中**的那条，两者分开写，避免「标题说当前、内容说别的」。
 */
function paintImageSelection() {
  const box = $('setActiveImage');
  const r = state.imageStatus || {};
  const items = state.images || [];
  const sel = (box && box.value) || '';
  const cur = sel ? items.find((x) => x.id === sel) : null;
  const act = r.active;

  // 当前真正在用的镜像的来源（与上面的 imageActiveText 同一条数据）
  const activeItem = items.find((x) => x.id === ((r && r.activeId) || ''));
  const srcEl = $('imageSourceText');
  if (srcEl) {
    srcEl.textContent = activeItem && activeItem.sourceText
      ? `来源：${activeItem.sourceText}`
      : `来源：内置 ${((r && r.defaultImage && r.defaultImage.label) || 'Google Play')} 官方镜像，随运行时一起下载`;
  }

  // 选中项的来源：只在下拉里选了某条自定义镜像时才出现
  const pickEl = $('imagePickText');
  if (pickEl) {
    pickEl.textContent = cur ? `来源：${cur.sourceText || '未知'}` : '';
    pickEl.hidden = !cur;
  }

  // 选中一条坏镜像 → 显示它自己的原因；没选中 → 显示当前运行时为什么没在用自定义镜像
  const why = cur
    ? (cur.state === 'ok' ? '' : (cur.reason || '镜像文件不完整，暂时不能启用'))
    : ((r.why || (act && act.custom && !act.ok ? act.reason : '')) || '');
  if ($('imageWhyField')) $('imageWhyField').hidden = !why;
  if ($('imageWhy')) $('imageWhy').textContent = why;

  // 坏镜像只能看不能启用；移除/打开目录仍然可用，方便用户清掉或去修文件
  const enable = $('btnImageEnable');
  if (enable) enable.disabled = !!(cur && cur.state !== 'ok');
}

/** 切换镜像后必须让用户知道「什么时候真的换过去」 */
function imageRestartNote(res) {
  // 主进程已经把旧镜像那台停掉了：下一次打开应用就会按新 AVD 开机
  if (res && res.stoppedVm) return '已停止当前运行的安卓；下次打开应用时会用这套镜像启动。';
  return (res && res.needsRestart)
    ? '正在运行的安卓仍在使用上一次的镜像，关掉应用窗口后重新打开即可生效。'
    : '下次打开应用时生效。';
}

/* ---------------- 设置：分类导航 / 搜索 ---------------- */

/** 当前打开的分类（关闭再打开时回到上次看的那一页） */
let settingsSec = 'general';

/**
 * 切到某个分类页。
 * 标题与副标题不在 data-* 里，而是从每个 section 里那份隐藏的 `.set-sec-meta`
 * 复制过来 —— 那份文字也在 DOM 里，所以英文界面下 i18n 已经把它翻译过了。
 */
function openSettingsSection(secId) {
  const secs = [...document.querySelectorAll('.set-sec')];
  const target = secs.find((s) => s.dataset.sec === secId) || secs[0];
  if (!target) return;
  settingsSec = target.dataset.sec;
  for (const s of secs) {
    s.id ||= `settings-section-${s.dataset.sec}`;
    s.classList.toggle('on', s === target);
    s.hidden = s !== target;
  }
  for (const b of document.querySelectorAll('.set-nav-item')) {
    const current = b.dataset.sec === settingsSec;
    b.classList.toggle('on', current);
    b.setAttribute('aria-controls', `settings-section-${b.dataset.sec}`);
    if (current) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const meta = target.querySelector('.set-sec-meta');
  const h = meta && meta.querySelector('h2');
  const p = meta && meta.querySelector('p');
  if ($('setTitle')) $('setTitle').textContent = h ? h.textContent : '';
  if ($('setSub')) $('setSub').textContent = p ? p.textContent : '';
  // 搜索命中页开着时切分类 = 退出搜索
  if ($('setSearch')) $('setSearch').value = '';
  if ($('setHits')) { $('setHits').hidden = true; $('setHits').innerHTML = ''; }
  if ($('setBody')) $('setBody').scrollTop = 0;
  if (['runtime', 'android'].includes(settingsSec) && systemPanelVisible()) loadSystems();
  if (settingsSec === 'automation') refreshInstances();
}

/** 每次使用当前语言的标签，避免语言切换后还搜旧文案。 */
function settingsIndex() {
  const out = [];
  for (const sec of document.querySelectorAll('.set-sec')) {
    const meta = sec.querySelector('.set-sec-meta h2');
    const secName = meta ? meta.textContent : (sec.dataset.sec || '');
    for (const field of sec.querySelectorAll('.field, .group-title')) {
      for (const el of field.classList.contains('two') ? field.children : [field]) {
        const labelEl = el.querySelector('label');
        const label = (labelEl ? labelEl.textContent : el.textContent) || '';
        const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        out.push({
          sec: sec.dataset.sec, secName, el, hasLabel: !!labelEl,
          label: label.replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim(),
          text,
        });
      }
    }
  }
  return out;
}

/** 高亮命中的关键字（只处理纯文本，先转义） */
function markHits(s, q) {
  const safe = esc(s);
  if (!q) return safe;
  const re = new RegExp(`(${esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return safe.replace(re, '<mark>$1</mark>');
}

/**
 * 搜索：不隐藏任何设置项，而是给一份「命中列表」——
 * 点一条就跳到对应分类并把那一项闪一下。
 * 之所以不是「过滤当前页的字段」：用户找的是「内存」，他不知道内存属于哪一页，
 * 直接把命中的几项摊开给他最省事。
 */
function runSettingsSearch(q) {
  const box = $('setHits');
  if (!box) return;
  const query = String(q || '').trim().toLowerCase();
  const body = $('setBody');
  if (!query) {
    openSettingsSection(settingsSec);
    return;
  }
  const hits = settingsIndex().filter((it) => it.label.toLowerCase().includes(query)
    || it.text.toLowerCase().includes(query));
  // 命中项多的时候优先显示「标题就有这个词」的：搜「内存」时，先给出「内存」那一项，
  // 而不是一堆正文里顺便提到内存的段落。
  hits.sort((a, b) => Number(b.hasLabel && b.label.toLowerCase().includes(query))
    - Number(a.hasLabel && a.label.toLowerCase().includes(query)));
  box.innerHTML = '';
  if (!hits.length) {
    box.innerHTML = '<div class="set-hit-empty">没有找到匹配的设置项，换个词试试？</div>';
  } else {
    for (const h of hits.slice(0, 24)) {
      const b = document.createElement('button');
      b.className = 'set-hit';
      // 没写 label 的字段（只有一段说明的那种）用正文前几十个字当代称，单行截断，
      // 不然一整段话会把结果列表撑成一大坨。
      const title = (h.hasLabel ? h.label : h.text.slice(0, 56));
      b.innerHTML = `<span class="hit-text">${markHits(title, q)}</span>`
        + `<span class="hit-sec">${esc(h.secName)}</span>`;
      b.addEventListener('click', () => {
        openSettingsSection(h.sec);
        const field = h.el.querySelector('label[for]')?.control || a11y.stops(h.el)[0];
        if (!a11y.focus(field)) {
          h.el.tabIndex = -1;
          a11y.focus(h.el);
        }
        a11y.scroll(h.el);
        h.el.classList.remove('flash');
        void h.el.offsetWidth;
        h.el.classList.add('flash');
        setTimeout(() => h.el.classList.remove('flash'), 1400);
      });
      box.appendChild(b);
    }
  }
  // 标题也换成「搜索结果」：不然会出现「关于」标题下面列着内存设置项这种错位感
  if ($('setTitle')) $('setTitle').textContent = '搜索结果';
  if ($('setSub')) {
    $('setSub').textContent = hits.length ? `找到 ${hits.length} 项匹配` : '没有匹配的设置项';
  }
  box.hidden = false;
  // 结果页不属于任何分类：把左栏高亮清掉，否则会出现「通用」亮着却列着各页结果
  for (const b of document.querySelectorAll('.set-nav-item')) {
    b.classList.remove('on');
    b.removeAttribute('aria-current');
  }
  document.querySelectorAll('.set-sec').forEach((s) => { s.classList.remove('on'); s.hidden = true; });
  if (body) body.scrollTop = 0;
}

function bindSettingsNav() {
  if ($('settingsNav')) {
    $('settingsNav').addEventListener('click', (e) => {
      const btn = e.target.closest('.set-nav-item');
      if (!btn) return;
      openSettingsSection(btn.dataset.sec);
    });
  }
  if ($('setSearch')) {
    $('setSearch').addEventListener('input', (e) => runSettingsSearch(e.target.value));
    $('setSearch').addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape' && e.target.value) {
        e.preventDefault();
        runSettingsSearch('');
      }
      // 回车直接跳到第一条命中
      if (e.key === 'Enter') {
        const first = $('setHits')?.querySelector('.set-hit');
        if (first) { e.preventDefault(); first.click(); }
      }
    });
  }
  openSettingsSection(settingsSec);
}

/** 下拉框回填：值不在选项里时补一条「自定义」，避免旧配置显示成空白 */
function fillChoice(sel, value, fmt) {
  if (!sel) return;
  const v = String(value == null ? '' : value);
  if (![...sel.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = fmt ? fmt(v) : v;
    sel.appendChild(o);
  }
  sel.value = v;
}

function shellSupported(info = state.info) {
  const p = info?.platform;
  return p?.canIntegrateShell ?? (!p?.platform || p.platform === 'win32');
}

function applyPlatformCapabilities(info) {
  state.info = info || state.info;
  const p = (info && info.platform) || {};
  if (!p.platform) return;
  const windows = p.platform === 'win32';
  const canEmbed = p.canEmbed ?? windows;
  const canShell = shellSupported(info);
  const canHook = p.canHookMouse === undefined ? windows : p.canHookMouse === true;
  const note = (id, visible, text) => {
    const el = $(id);
    if (!el) return;
    el.hidden = !visible;
    if (visible) setText(el, text);
  };
  const disable = (id, disabled) => { const el = $(id); if (el) el.disabled = disabled; };
  const isChild = info?.instance?.isChild === true;
  if ($('instancesGroup')) $('instancesGroup').hidden = isChild;
  if (isChild) {
    for (const id of ['setAutoStart', 'setPrewarm', 'setAutoShortcut', 'setStartMenuShortcut',
      'setEngineMode', 'setAdbPath', 'setDevice', 'setRuntimeDir', 'setAvdDir', 'setImageFlavor',
      'btnAssoc', 'btnRebuildShortcuts', 'btnCreateInstance', 'btnRefreshInstances']) disable(id, true);
  }

  for (const value of ['auto', 'embedded']) {
    const option = [...$('setWindowMode').options].find((o) => o.value === value);
    if (option) option.disabled = !canEmbed;
  }
  note('windowModeSupportNote', !canEmbed, '当前平台不支持把安卓画面嵌入 ApkStart；应用将在 Android Emulator 独立窗口中显示。');

  for (const id of ['setMouseRightBack', 'setMouseWheelMode', 'setMouseSideButtons']) disable(id, !canHook);
  note('mouseHookSupportNote', !canHook, '右键、滚轮和侧键映射依赖 Windows 鼠标钩子，当前平台不支持。');

  for (const id of ['setAutoShortcut', 'setStartMenuShortcut', 'setShortcutDir', 'btnRebuildShortcuts', 'btnAssoc']) disable(id, isChild || !canShell);
  note('shortcutSupportNote', !canShell, '桌面快捷方式、开始菜单和 APK 文件关联当前仅支持 Windows。');
  note('integrationSupportNote', !canShell, 'APK 文件关联由 Windows 文件类型注册表提供，当前平台不支持。');
  $('emptyWindowsHelp').hidden = !canShell;
  if (!canEmbed) $('setWindowMode').value = 'standalone';
  const linux = p.platform === 'linux';
  $('accelHelp').hidden = linux;
  $('wizAccelHelp').hidden = linux;

  for (const id of ['btnEnableAccel', 'btnOpenFeatures', 'wizEnableAccel']) disable(id, !windows);
  note('accelSupportNote', p.platform === 'linux', 'Linux 使用 /dev/kvm 硬件加速；请在 BIOS 启用虚拟化并将当前用户加入 kvm 组。ApkStart 不能代替系统管理员配置 KVM。');
  note('wizAccelSupportNote', p.platform === 'linux', 'Linux 使用 /dev/kvm；请在 BIOS 启用虚拟化并将当前用户加入 kvm 组。此步骤不能由 ApkStart 自动开启。');
}

let settingsRequest = 0;
async function openSettings({ section = settingsSec, opener, focusId } = {}) {
  const request = ++settingsRequest;
  const mask = $('settingsMask');
  const body = $('setBody');
  const loading = $('settingsLoading');
  const restore = opener || menuOpener || a11y.bookmark();
  hideMenu(false);
  openSettingsSection(section);
  a11y.open(mask, { opener: restore, initial: focusId ? $(focusId) : undefined });
  if (['runtime', 'android'].includes(settingsSec)) loadSystems();
  loading.hidden = false;
  loading.textContent = '正在读取设置…';
  body.inert = true;
  body.setAttribute('aria-busy', 'true');
  try {
    const infoRequest = state.info?.platform ? Promise.resolve(state.info) : api.info().catch(() => ({}));
    const assocRequest = infoRequest.then((info) => shellSupported(info) ? api.assocStatus().catch(() => null) : null);
    const [s, info, di, assoc] = await Promise.all([
      api.getSettings(), infoRequest, api.dataInfo().catch(() => null), assocRequest,
    ]);
    if (request !== settingsRequest) return false;
    state.settings = s;
    state.info = info;
    fillSettings(s);
    applyPlatformCapabilities(info);
    $('setRuntimeDir').value = info.runtimeDir || info.dataDir || '';
    $('setAvdDir').value = di?.avdDir || '';
    if (info.version) {
      $('aboutVer').textContent = `v${info.version}`;
      $('updateCurrent').textContent = `v${info.version}`;
    }
    $('aboutDataDir').textContent = info.dataDir || '—';
    $('aboutRuntimeDir').textContent = info.runtimeDir || '—';
    const btn = $('btnAssoc');
    btn.textContent = !shellSupported(info) ? '当前平台不支持'
      : assoc ? (assoc.registered ? '已关联 · 点击取消' : '未关联 · 点击开启') : '无法读取关联状态';
    btn.dataset.on = assoc?.registered ? '1' : '0';
    btn.disabled = !assoc;
    loading.hidden = true;
    body.inert = false;
    refreshProfileText();
    refreshImagePanel();
    api.runtimeUsage().then((u) => {
      $('usageText').textContent = u
        ? `共 ${u.totalText}${u.reclaimable ? ` · 可回收 ${u.reclaimableText}（${u.count} 项）` : ' · 已是精简状态'}`
        : '统计不可用';
    }).catch(() => { $('usageText').textContent = '统计不可用'; });
    refreshAndroid();
    refreshDataInfo();
    refreshAccelStatus();
    return true;
  } catch (e) {
    if (request === settingsRequest) {
      loading.textContent = '读取设置失败，请关闭后重试。';
      body.inert = false;
      console.error(e);
    }
    return false;
  } finally {
    if (request === settingsRequest) body.removeAttribute('aria-busy');
  }
}

function closeSettings() {
  settingsRequest += 1;
  $('setBody').inert = false;
  $('setBody').removeAttribute('aria-busy');
  $('settingsLoading').hidden = true;
  a11y.close($('settingsMask'));
  // 引导保留在下层但不可操作，关闭设置后可恢复到原入口。
  if (wizard.suspended) {
    const page = wizard.suspended;
    wizard.suspended = 0;
    $('btnBackToWizard').hidden = true;
    wizardShowPage(page);
  }
}

/* ---------------- 软件更新 ---------------- */

let lastUpdate = null;

/**
 * 主按钮该是什么状态。三种情况必须分开，否则用户点下去不知道会发生什么：
 *   ready  → 安装包已经在本地，「重启并安装」
 *   auto   → 有可下载的安装包，「立即更新」会下载 + 自动重启安装
 *   retry  → 只看到发布页、安装包还没传上来（CI 构建 10~20 分钟），
 *            点一下会强制重查，传完了就直接下载安装
 */
function updateAction(info) {
  if (info && info.downloaded) return { text: '重启并安装', mode: 'ready' };
  if (info && info.asset) return { text: '立即更新', mode: 'auto' };
  return { text: '重新检查并下载', mode: 'retry' };
}

/** 「已下载，可立即重启安装」那一行 */
function renderUpdateReady(info) {
  const row = $('updateReady');
  const txt = $('updateReadyText');
  if (!row || !txt) return;
  const on = !!(info && info.downloaded);
  row.hidden = !on;
  row.style.display = on ? '' : 'none';
  if (on) {
    txt.textContent = `v${String(info.downloadedVersion || info.version || '').replace(/^v/i, '')} 已下载完成`
      + '，随时可以重启安装（正在用的安卓应用会被一起关掉）';
  }
}

/** 把一次检查结果画到设置面板（也用于启动时静默检查推送过来的状态） */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;
  // 每次重画都先清掉「已下载」提示，避免上次的残留一直挂着
  renderUpdateReady(info.hasUpdate && info.downloaded ? info : null);
  const pendingRow = $('updatePending');
  if (pendingRow) { pendingRow.hidden = true; pendingRow.style.display = 'none'; }

  if (info.ok === false) {
    st.textContent = `检查失败：${info.error || '网络不可用'}`;
    showUpdateBtn(false);
    showPageBtn(false);
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // 如实说明这次是哪个源给出的版本、另一个源为什么没参与 ——
    // 用户排查「为什么检查更新很慢」时，这一行比任何日志都直接。
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join('、');
    const stale = info.stale ? '（离线缓存，可能不是最新）' : '';
    st.textContent = `发现新版本 ${info.tag}${src ? `（${src}）` : ''}${bad ? `；${bad} 不可达` : ''}${stale}`;
    showUpdateBtn(true);
    const a = updateAction(info);
    btn.textContent = a.text;
    btn.dataset.mode = a.mode;
    // 已下载时下面那行自带「重启并安装」，主按钮就不再重复出现同一个动作
    showUpdateBtn(info.canAutoApply && !info.downloaded);
    if (!info.canAutoApply) st.textContent += ' · 请通过发布页下载';
    // 发布页兜底入口：不管能不能自动更新，用户都得有一条自己拿包的路
    showPageBtn(true);
    // 只看得到发布页 = 安装包还在上传：把「为什么点不到自动更新」直接写在面板上
    if (pendingRow && !info.asset && !info.proof) { pendingRow.hidden = false; pendingRow.style.display = ''; }
    // 更新日志 = 该版本的发布说明（GitHub Release body），完整展示（可滚动）。
    // 按轻量 markdown 渲染成 HTML，面板里不再露出 #、**、表格竖线这些记号。
    const note = $('updateNote');
    if (note) {
      const body = String(info.notes || '').trim();
      if (body) {
        note.innerHTML = `<div class="n-title">更新日志（${esc(info.tag)}）</div>${mdToHtml(body)}`;
        note.classList.add('notes');
      } else {
        note.classList.remove('notes');
        note.innerHTML = '';
      }
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? '（离线缓存）' : '';
    st.textContent = `已是最新版本（v${info.current}）${src ? ` · 经由 ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    showPageBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn 自带 display:inline-flex，会盖掉 hidden 属性，所以这里直接改 display */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function showPageBtn(on) {
  const btn = $('btnUpdatePage');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `更新失败：${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: '更新失败', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || '正在更新…';
  if (bar && fill) {
    bar.hidden = false;
    const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
    fill.style.width = `${percent}%`;
    if (p.percent == null) bar.removeAttribute('aria-valuenow');
    else bar.setAttribute('aria-valuenow', String(percent));
  }
  // 下载校验完 → 载荷在本地等着装：主按钮让位给下面那行「重启并安装」，
  // 不然用户会以为还得再点一次「立即更新」重新下载一遍
  if (p.stage === 'ready') {
    showUpdateBtn(false);
    if (lastUpdate) {
      lastUpdate = { ...lastUpdate, downloaded: true, downloadedVersion: lastUpdate.version };
      renderUpdateReady(lastUpdate);
    }
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = '检查中…';
      $('updateState').textContent = '正在连接 GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `发现新版本 ${info.tag}`, body: info.canAutoApply ? '可在软件更新中下载已验证的安装包' : '请打开发布页查看详情', type: 'info' });
        else if (info && info.ok !== false) toast({ title: '已是最新版本', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `检查失败：${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  const applyNow = async () => {
    if (go.disabled) return;
    const label = go.textContent;
    go.disabled = true;
    go.textContent = '更新中…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      // 失败后按「当前是否已有安装包」还原文案，而不是永远回到「立即更新」
      const a = updateAction(lastUpdate);
      go.textContent = a.text;
      go.dataset.mode = a.mode;
      if (r && r.code === 'no-asset') {
        // 用固定句式，别把长错误串直接糊到界面上（也更方便英文界面翻译）
        const msg = '安装包还没上传完，稍后再试一次';
        $('updateState').textContent = msg;
        toast({ title: '安装包还没上传完', body: msg, type: 'warn' });
      } else if (r && r.error && !r.manual) {
        $('updateState').textContent = `更新失败：${r.error}`;
        toast({ title: '更新失败', body: r.error, type: 'error' });
      }
      if (label === '重启并安装') go.textContent = '重启并安装';
      return;
    }
    if (r.mode === 'deb') { go.disabled = false; go.textContent = label; $('updateState').textContent = '请在系统安装器中确认升级'; return; }
    $('updateState').textContent = `已下载 v${r.version}，正在重启完成安装…`;
  };

  go.addEventListener('click', applyNow);

  // 「已下载」那一行的重启按钮：和主按钮走同一条路径（不会重新下载）
  const restart = $('btnUpdateRestart');
  if (restart) restart.addEventListener('click', applyNow);

  // 手动安装：自动安装拉不起来时的兜底出口。
  // 直接运行已经下好的安装包（弹安装向导），不依赖后台脚本，点了就一定有反应。
  const manual = $('btnUpdateManual');
  if (manual) {
    manual.addEventListener('click', async () => {
      manual.disabled = true;
      try {
        const r = await api.updateRunPayload().catch((e) => ({ ok: false, error: e.message }));
        if (r && r.ok) {
          toast({
            title: '已启动安装向导',
            body: '按提示完成安装即可。安装前建议先退出正在使用的安卓应用。',
            type: 'info',
          });
        } else {
          toast({ title: '手动安装失败', body: (r && r.error) || '没找到已下载的安装包', type: 'error' });
        }
      } finally {
        manual.disabled = false;
      }
    });
  }

  // 发布页：始终保留的手动出口（安装包还在上传、或想自己挑安装版/便携版时用）
  const page = $('btnUpdatePage');
  if (page) {
    page.addEventListener('click', () => {
      api.updateOpenRelease((lastUpdate && lastUpdate.htmlUrl)
        || 'https://github.com/yuchen0x1/apkstart/releases');
    });
  }

  // 失败报告开关：默认开（只落本机），关掉后连摘要也不生成
  const ra = $('setReportAuto');
  if (ra) {
    ra.addEventListener('change', async () => {
      const s = await api.setSettings({ report: { auto: ra.checked } }).catch(() => null);
      if (s) state.settings = s;
      toast({
        title: ra.checked ? '已开启失败报告' : '已关闭失败报告',
        body: ra.checked ? '开机失败时会自动生成脱敏摘要，等你决定是否上报' : '不再自动生成摘要（仍可手动导出诊断报告）',
        type: 'ok',
      });
    });
  }
  const rf = $('btnReportFolder');
  if (rf) {
    rf.addEventListener('click', () => {
      api.reportFolder().catch(() => toast({ title: '打开失败', body: '请稍后重试', type: 'error' }));
    });
  }

  // 自动更新开关：状态在 init() 里按设置回填；这里只负责把改动写回去
  const au = $('setAutoUpdate');
  if (au) {
    au.addEventListener('change', async () => {
      const s = await api.setSettings({ update: { autoUpdate: au.checked } }).catch(() => null);
      if (s) state.settings = s;
      toast({
        title: au.checked ? '已开启自动更新' : '已关闭自动更新',
        body: au.checked
          ? '发现新版本会自动下载并重启安装；正在使用的应用不会被重启打断'
          : '发现新版本时只通知，更新需在设置里手动进行',
        type: 'ok',
      });
    });
  }
  // 更新日志按钮：有新版本看该版本发布页，否则看仓库的 CHANGELOG
  const logBtn = $('btnUpdateLog');
  if (logBtn) {
    logBtn.addEventListener('click', () => {
      const u = lastUpdate;
      if (u && u.hasUpdate && u.htmlUrl) api.updateOpenRelease(u.htmlUrl);
      else api.updateOpenRelease('https://github.com/yuchen0x1/apkstart/blob/main/CHANGELOG.md');
    });
  }

  // 打开设置时如果还没结果，就顺手查一次（放后台，不打扰）
  runCheck(true).catch(() => {});
}

let languageBusy = false;
async function changeLanguage(value) {
  const controls = ['setLanguage', 'wizLanguageFirst', 'wizLanguage'].map($).filter(Boolean);
  const fill = () => controls.forEach((el) => { el.value = state.settings?.language || 'auto'; });
  if (languageBusy) { fill(); return; }
  languageBusy = true;
  const disabled = controls.map((el) => el.disabled);
  controls.forEach((el) => { el.disabled = true; el.setAttribute('aria-busy', 'true'); });
  try {
    const settings = await api.setSettings({ language: value });
    if (settings?.language !== value) throw new Error('语言设置未保存');
    state.settings = settings;
    const payload = await api.i18n();
    window.apkI18n?.retranslate(payload);
    refreshSysTaskAnnouncement();
  } catch (err) {
    toast({ title: '切换语言失败', body: err?.message || '请稍后重试。', type: 'error' });
  } finally {
    fill();
    controls.forEach((el, i) => { el.disabled = disabled[i]; el.removeAttribute('aria-busy'); });
    languageBusy = false;
  }
}

let instancesBusy = false;
async function refreshInstances() {
  if (!$('instancesList') || !api.instances || instancesBusy) return;
  instancesBusy = true;
  try {
    const select = $('instanceApp');
    const selected = select.value;
    select.replaceChildren(...state.apps.map(app => new Option(app.label || app.package, app.package)));
    if (state.apps.some(app => app.package === selected)) select.value = selected;
    const list = await api.instances.list();
    $('instancesList').replaceChildren();
    for (const item of list) {
      const row = document.createElement('div'); row.className = 'field row';
      const label = document.createElement('span');
      const needsVerification = item.needsVerification === true;
      label.textContent = `${item.name} · ${needsVerification ? '需手动核验' : item.running ? '已启动' : item.state === 'starting' ? '启动中' : '未启动'}`;
      const button = document.createElement('button'); button.className = 'btn ghost sm';
      button.textContent = '在此分身打开';
      button.disabled = needsVerification;
      if (needsVerification) button.title = '进程归属或启动状态未确认；请先手动核验，不会重复启动或终止该进程';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          if (!select.value) throw new Error('请先在主实例安装一个有本地安装包的应用');
          const result = await api.instances.launch(item.id, select.value);
          if (result?.ok !== true) throw new Error(result?.error || '启动失败');
          toast({ title: '已发送到分身', body: '首次打开需创建独立安卓数据，进度在分身窗口显示', type: 'ok' });
          await refreshInstances();
        } catch (error) { toast({ title: '分身启动失败', body: error.message, type: 'error' }); }
        finally { button.disabled = false; }
      });
      row.append(label, button); $('instancesList').append(row);
    }
    if (!list.length) $('instancesList').textContent = '尚未创建分身';
  } catch (error) { $('instancesList').textContent = error.message; }
  finally { instancesBusy = false; }
}

function bindExtendedSettings() {
  const failed = error => toast({ title: '操作失败', body: error.message, type: 'error' });
  for (const [id, key] of [['setCameraBack', 'cameraBack'], ['setCameraFront', 'cameraFront'], ['setRefreshRate', 'refreshRate'], ['setSerialPort', 'serialPort']]) {
    $(id)?.addEventListener('change', async event => {
      try {
        const value = key === 'refreshRate' ? Number(event.target.value) : event.target.value.trim();
        state.settings = await api.setSettings({ peripherals: { [key]: value } });
        toast({ title: '配置已保存', body: '下次完整启动安卓生效，不会中断当前应用', type: 'ok' });
      } catch (error) { failed(error); }
      finally { if (state.settings) fillSettings(state.settings); }
    });
  }
  $('btnListWebcams')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try {
      const result = await api.peripherals.webcams();
      for (const id of ['setCameraBack', 'setCameraFront']) {
        const select = $(id);
        for (const device of result.devices || []) {
          if (![...select.options].some(option => option.value === device.id)) select.add(new Option(`${device.id} · ${device.name || device.id}`, device.id));
        }
      }
      toast({ title: '摄像头枚举完成', body: `发现 ${(result.devices || []).length} 个设备；选择后才启用映射`, type: 'ok' });
    } catch (error) { failed(error); }
    finally { event.target.disabled = false; }
  });
  $('btnVerifyRefresh')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try {
      const result = await api.peripherals.refresh();
      $('refreshRateStatus').textContent = result.activeRate
        ? `客机 ${result.activeRate} Hz · ${result.status === 'confirmed' ? '与请求一致' : '与请求不一致'}`
        : `未确认：${result.error || '运行时未返回可识别的活动显示模式'}`;
    } catch (error) { $('refreshRateStatus').textContent = `未确认：${error.message}`; }
    finally { event.target.disabled = false; }
  });
  $('btnRefreshInstances')?.addEventListener('click', refreshInstances);
  $('btnCreateInstance')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try { await api.instances.create({ name: $('instanceName').value.trim() }); $('instanceName').value = ''; await refreshInstances(); }
    catch (error) { failed(error); }
    finally { event.target.disabled = false; }
  });
  window.apkAutomation?.mount({ root: $('automationPanel'), api });
}

function bindSettings() {
  bindExtendedSettings();
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  $('setEngineMode').addEventListener('change', (e) => save({ engine: { mode: e.target.value } }));
  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setDevice').addEventListener('change', async (e) => {
    await save({ device: e.target.value.trim() });
    refreshStatus();
  });
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // 内存 / 核心：填了具体值就关掉「自动」，填 0 又回到自动。
  // 旧代码只写 memoryMB，而 overridesFromSettings 只在 autoMemory=false 时才认它，
  // 于是「手动填了内存」一直被忽略 —— 这是设置页最容易被当成“没用”的一项。
  // 改完立刻刷新参数摘要：用户要能马上看到「我的值被采纳了」。
  //
  // 注意：内存与核数共用 autoMemory 这一个「手动」标记（overridesFromSettings 按它判断），
  // 所以清空某一项时**不能**把 autoMemory 翻回 true —— 那会把另一项手动值一起作废。
  // 实测：填了内存 3072、再把核数改回自动，结果实跑回到 2048，而界面还显示 3072。
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0 } })
      .then(() => refreshProfileText());
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0 } })
      .then(() => refreshProfileText());
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // 资源策略会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: '资源策略已切换', body: '下一次打开应用生效', type: 'ok' });
      // 「流畅」会让低配机器不再自动降级，摘要要跟着变
      refreshProfileText();
    });
  }
  if ($('setWindowMode')) {
    $('setWindowMode').addEventListener('change', async (e) => {
      const patch = { engine: { windowMode: e.target.value } };
      // 用户明确选「嵌入」时清掉「这台机器嵌入必黑」的记忆：否则他选完
      // 还是走独立窗口，会以为设置根本没生效。
      if (e.target.value === 'embedded') patch.engine.embeddedBlack = false;
      state.settings = await api.setSettings(patch);
      fillSettings(state.settings);
      toast({ title: '显示方式已保存', body: '下一次打开应用生效', type: 'ok' });
    });
  }
  if ($('setImageFlavor')) {
    $('setImageFlavor').addEventListener('change', async (e) => {
      const old = (state.settings && state.settings.runtime && state.settings.runtime.systemImageFlavor) || 'google_apis_playstore';
      const requested = e.target.value;
      const r = await api.setImageFlavor(requested).catch((err) => ({ ok: false, error: err.message }));
      if (!r || !r.ok) {
        e.target.value = old;
        toast({ title: '系统镜像切换失败', body: (r && r.error) || '未知错误', type: 'error' });
        return;
      }
      state.settings = await api.getSettings().catch(() => state.settings);
      const label = (r.profile && (r.profile.shortLabel || r.profile.label)) || requested;
      toast({
        title: '系统镜像已切换',
        body: `${label} 使用独立 AVD；${r.stoppedVm ? '当前安卓已停止，' : ''}下次启动时按新档位运行。其它档位的数据不会删除。`,
        type: 'ok',
      });
      await refreshImagePanel();
      refreshStatus().catch(() => {});
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } })
      .then(() => refreshProfileText()));
  }
  // 渲染后端：选「自动」交还 doctor 逐级降级；手动选一个就固定用它（排障用）
  if ($('setGpuMode')) {
    $('setGpuMode').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { gpuMode: e.target.value } });
      toast({
        title: e.target.value === 'auto' ? '渲染后端已交还自动' : '渲染后端已固定',
        body: e.target.value === 'auto'
          ? '下次开机会按机器性能重新挑选，失败自动降级'
          : '下次开机固定使用这个后端，不再自动切换',
        type: 'ok',
      });
      refreshProfileText();
    });
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    // 这里只预选容量；落盘必须经过 setDataSize 的真实扩容成功回执。
    $('setDataGB').addEventListener('change', refreshDataInfo);
  }
  if ($('btnEnableAccel')) $('btnEnableAccel').addEventListener('click', runEnableVirtualization);

  /* ---- 安卓客机：中文界面 ---- */
  if ($('btnGuestZh')) {
    $('btnGuestZh').addEventListener('click', async () => {
      const { response } = await api.confirm({
        title: '把安卓系统切换成简体中文？',
        message: '会把语言写进安卓设置，并让安卓自己重启一次（大约半分钟）。',
        detail: '• 已安装的应用、登录状态和存档都保留，只是把系统界面语言换成中文\n'
          + '• 重启时模拟器窗口会短暂断开，随后自动恢复，不用管它\n'
          + '• 如果之后又变回英文，用「在安卓里手动改语言」在设置里选一次简体中文即可',
        okLabel: '切换为中文',
      });
      if (response !== 1) return;
      const t = toast({ title: '正在切换安卓系统语言…', body: '安卓会重启一次，大约半分钟', sticky: true, spinner: true });
      const r = await api.guestLocalize('zh-CN').catch((e) => ({ ok: false, error: e.message }));
      if (!r || !r.ok) { t.update({ title: '切换失败', body: (r && r.error) || '请稍后重试' }); return; }
      t.dismiss();
      if (r.active) {
        toast({ title: '已切换为简体中文', body: '桌面、设置和系统应用都已经变成中文。', type: 'ok', sticky: true });
      } else {
        toast({
          title: '语言已写入，但还没生效',
          body: `重启后系统仍是 ${(r.probe && r.probe.config) || '英文'}，可以用「在安卓里手动改语言」手动选一次简体中文。`,
          type: 'warn', sticky: true,
        });
      }
      refreshGuest(true);
    });
  }
  if ($('btnGuestLocaleSettings')) {
    $('btnGuestLocaleSettings').addEventListener('click', async () => {
      const r = await api.guestOpenLocaleSettings().catch((e) => ({ ok: false, error: e.message }));
      if (!r || !r.ok) {
        toast({ title: '需要先打开一次应用', body: (r && r.error) || '让安卓运行起来后再试', type: 'error' });
      } else {
        toast({ title: '已打开安卓语言设置', body: '在模拟器窗口里点「＋」添加语言，选「简体中文」后拖到第一位。', type: 'info', sticky: true });
      }
    });
  }
  if ($('btnGuestTrim')) {
    $('btnGuestTrim').addEventListener('click', async () => {
      const groups = [...document.querySelectorAll('#guestTrimList input[type=checkbox]:checked')].map((n) => n.value);
      if (!groups.length) {
        toast({ title: '先勾选要精简的分组', type: 'info' });
        return;
      }
      const { response } = await api.confirm({
        title: `从安卓里移除这 ${groups.length} 组预装应用？`,
        message: '只对当前用户移除，系统分区不动，随时可以一键恢复。',
        detail: '你的应用、桌面布局和其它设置都不受影响；被移除的应用不再占桌面、也不再后台运行。',
        okLabel: '开始精简',
      });
      if (response !== 1) return;
      const t = toast({ title: '正在精简预装应用…', sticky: true, spinner: true });
      const r = await api.guestTrim(groups).catch((e) => ({ ok: false, error: e.message }));
      if (!r || !r.ok) { t.update({ title: '精简失败', body: (r && r.error) || '请稍后重试' }); return; }
      t.dismiss();
      const failed = (r.failed || []).length;
      toast({
        title: `已移除 ${(r.removed || []).length} 个预装应用`,
        body: failed ? `有 ${failed} 个被系统保护、没有移除（不影响使用）。` : '桌面图标会随之消失，随时可以一键恢复。',
        type: failed ? 'warn' : 'ok',
      });
      refreshGuest(true);
    });
  }
  if ($('btnGuestRestore')) {
    $('btnGuestRestore').addEventListener('click', async () => {
      const t = toast({ title: '正在恢复预装应用…', sticky: true, spinner: true });
      const r = await api.guestRestore().catch((e) => ({ ok: false, error: e.message }));
      if (!r || !r.ok) { t.update({ title: '恢复失败', body: (r && r.error) || '请稍后重试' }); return; }
      t.dismiss();
      const n = (r.restored || []).length;
      toast({ title: n ? `已恢复 ${n} 个预装应用` : '没有需要恢复的应用', type: n ? 'ok' : 'info' });
      refreshGuest(true);
    });
  }
  if ($('btnOpenFeatures')) {
    $('btnOpenFeatures').addEventListener('click', async () => {
      const r = await api.openWindowsFeatures().catch(() => ({ ok: false }));
      if (r && r.ok) {
        toast({
          title: '已打开 Windows 功能',
          body: '请勾选「Windows 虚拟机监控程序平台」和「虚拟机平台」，确定后重启电脑。',
          type: 'info', sticky: true,
        });
      } else {
        toast({
          title: '打不开 Windows 功能',
          body: (r && r.error) || '请从开始菜单搜索「启用或关闭 Windows 功能」后手动开启。',
          type: 'error',
        });
      }
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', () => applyDataCapacity(Number($('setDataGB').value) || 0));
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setProxyUrl')) {
    $('setProxyUrl').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      save({ runtime: { proxyUrl: v } });
      // 主进程的代理探测结果有 10 分钟缓存：设置改完立即失效重测
      api.proxyReset().catch(() => {});
      toast({
        title: '代理设置已更新',
        body: v === 'off' ? '已强制直连（不使用任何代理）'
          : (v ? `代理已设为 ${v}，立即生效` : '将自动检测系统代理 / 环境变量'),
        type: 'ok',
      });
    });
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGithubToken')) {
    $('setGithubToken').addEventListener('change', (e) => save({ runtime: { githubToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  if ($('setMicrophone')) {
    $('setMicrophone').addEventListener('change', (e) => save({ engine: { microphone: e.target.checked } }));
  }
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // 立刻按当前窗口焦点重装/卸载钩子，不用等下次切窗口
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // 关掉深度裁剪必须把之前 pm disable-user 的包恢复回来，否则影响是持久的
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: '已恢复系统组件', body: '深度裁剪关闭，后台包正在恢复', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM 兼容模式已开启', body: '还需要下载 Google Play 兼容镜像（Android 14，约 1.5GB），点击下方按钮开始', type: 'info' });
    else if (on) toast({ title: 'ARM 兼容模式已开启', body: '重启运行时后生效', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  // 语言切换（upstream #38）：主进程先落设置并重建托盘菜单，再让本页整体重译。
  // 不做整页 reload：窗口里可能正有安装进度、日志在滚动，重载会把它们丢掉。
  if ($('setLanguage')) {
    $('setLanguage').addEventListener('change', (e) => changeLanguage(e.target.value));
  }
  $('wizLanguage')?.addEventListener('change', (e) => changeLanguage(e.target.value));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? '已切全屏' : '已切竖屏窗口', type: 'ok' });
  });
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: '画面大小已更新', body: '下次打开应用或切换应用时生效', type: 'ok' });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? '已补齐快捷方式' : '快捷方式都还在',
      body: r && r.fixed && r.fixed.length ? r.fixed.join('、') : '桌面与开始菜单入口正常',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: '诊断报告已导出', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: '导出失败', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!Array.isArray(preview?.candidates)) throw new Error(preview?.error || '无法读取可回收文件清单。');
      if (!preview.candidates.length) {
        toast({ title: '已经是精简状态', body: '没有可回收的受管缓存、锁文件或已选快照。系统镜像和其它 AVD 不会删除。', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r?.cancelled) return;
      if (r?.ok === false || !Array.isArray(r?.removed)) throw new Error(r?.error || '清理未完成。');
      toast({
        title: '清理完成',
        body: `释放约 ${(r.saved / 1048576).toFixed(0)} MB（${r.removed.length} 项），已安装应用保留。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `共 ${u.totalText} · 可回收 ${u.reclaimableText}（${u.count} 项）`;
    } catch (e) {
      toast({ title: '清理失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 先确认意图；真正删除前主进程还会给出不可绕过、默认取消的原生确认。
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: '重置安卓数据？',
        message: '这会把安卓系统还原成「刚装好系统」的干净状态：',
        detail: '• 删除全部已安装的第三方 app 及其数据、登录态\n'
          + '• 删除当前 AVD 的快速启动快照\n'
          + '• 系统镜像本身不受影响，重新打开应用会再次冷启动建数据\n\n'
          + '此操作不可撤销。是否继续？',
        okLabel: '继续', danger: true,
      });
      if (first?.response !== 1) return;
      const r = await api.runtimeResetData();
      if (r?.cancelled) return;
      if (!r || !r.ok) {
        toast({ title: '重置失败', body: (r && r.error) || '请重试', type: 'error' });
        return;
      }
      toast({
        title: '安卓数据已重置',
        body: `释放约 ${r.reclaimedMB} MB，已安装应用记录已清空。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `共 ${u.totalText} · 可回收 ${u.reclaimableText}（${u.count} 项）`;
    } catch (e) {
      toast({ title: '重置失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 只做轻量 Wi-Fi 重连，不把网络故障升级为重置 /data。
  // 仍未恢复时保留应用与登录状态，由用户检查代理/防火墙或另行明确重置数据。
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: '修复虚拟机网络？',
        message: '应用里需要联网的页面一直黑屏/转圈，通常是安卓虚拟机没有网络。',
        detail: '仅尝试重新建立安卓 Wi-Fi 连接。不会重置安卓用户数据，也不会删除应用、登录状态或存档。\n\n'
          + '若轻量修复无效，请检查本机网络、代理与防火墙；如确需重置数据，请先备份后单独选择「重置安卓数据」。',
        okLabel: '开始修复', danger: true,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (r?.cancelled) return;
      if (!r || !r.ok) {
        toast({
          title: '网络仍未恢复',
          body: (r && r.error) || '轻量修复未能恢复网络，安卓数据未重置。请检查本机网络、代理与防火墙。',
          type: 'error',
        });
        return;
      }
      toast({
        title: '网络已恢复',
        body: `网关 ${(r.network && r.network.gateway) || '可达'}。已重新连接网络，应用、登录状态和存档均保留。`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: '修复失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // 重建快捷方式：桌面图标被误删 / 被安全软件拦掉时的兜底入口
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: '快捷方式已重建', body: fixed.join('、'), type: 'ok' }
        : { title: '快捷方式都在', body: '没有需要重建的入口', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // 共享目录：先浏览选目录，再「保存并迁移」把旧文件一次性搬到新目录
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: '已选新目录', body: '点「保存并迁移」把旧文件搬过去', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: '请先填写或浏览目录', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: '共享目录已更新', body: moved ? '旧目录里已有的文件已迁移到新目录' : '已保存', type: 'ok' });
    } else {
      toast({ title: '保存失败', body: r.error, type: 'error' });
    }
  });

  // 一键卸载 ApkStart 本体（取消 .apk 关联 + 清理程序及其数据）
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('确定卸载 ApkStart？\n\n将取消 .apk 文件关联，并删除本程序管理的应用、运行时、快照、日志、设置和程序文件。共享目录及自选目录里的其它文件会保留。安装版还需要在系统卸载向导中确认。');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable && !r.automatic) {
      btn.disabled = false;
      toast({
        title: '便携版无法自动卸载',
        body: `请手动删除程序目录（${r.exeDir}）与数据目录（${r.dataDir}）`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: '卸载失败', body: r.error, type: 'error' });
      return;
    }
    if (r.awaitingConfirmation) {
      btn.disabled = false;
      toast({ title: '已打开卸载向导', body: '确认后才会清理程序数据；取消卸载不会删除数据。共享文件保留。', type: 'info' });
      return;
    }
    toast({ title: '正在卸载…', body: '正在清理本程序管理的数据，ApkStart 即将退出；共享文件会保留', type: 'ok', sticky: true });
  });

  // ARM 兼容镜像下载（带进度 toast）
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: '开始下载 Google Play 兼容镜像', body: '准备中…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: '下载 Google Play 兼容镜像', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM 兼容镜像就绪', body: '重启运行时后生效', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: '兼容镜像下载失败', body: (r && r.error) || '未知错误', progress: null });
        t.dismiss();
        toast({ title: '兼容镜像下载失败', body: (r && r.error) || '未知错误', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: '兼容镜像下载失败', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // 兼容镜像状态显示
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `已就绪（${(env.playImage.size / 1073741824).toFixed(2)} GB）` : '未下载';
    }
  })();

  /* ---------------- 自定义镜像：导入 / 启用 / 恢复 / 移除 ---------------- */

  if ($('setActiveImage')) {
    // 下拉只是浏览：选中哪条就显示哪条的来源与不可用原因，不点「启用」不会换镜像
    $('setActiveImage').addEventListener('change', paintImageSelection);
  }

  if ($('btnImageImport')) {
    $('btnImageImport').addEventListener('click', async () => {
      const btn = $('btnImageImport');
      btn.disabled = true;
      const t = toast({ title: '正在读取镜像…', body: '检查文件是否齐全、ABI 是否匹配', sticky: true, spinner: true, progress: 5 });
      const un = api.on('provision:progress', (p) => {
        if (p && p.component !== 'image') return;
        t.update({ title: '正在导入自定义镜像', body: (p && p.message) || '', progress: p && p.percent });
      });
      try {
        const r = await api.imageImport();
        if (r && r.canceled) { t.dismiss(); return; }
        if (!r || !r.ok) {
          const why = (r && (r.errors && r.errors.length ? r.errors.join('\n') : r.error)) || '未知错误';
          t.dismiss();
          // 失败时明确说「当前镜像没变」，否则用户会以为默认运行时被搞坏了
          toast({
            title: '这个镜像不能用作模拟器镜像',
            body: `${why}\n\n当前使用的镜像没有任何改动。`,
            type: 'error',
            sticky: true,
          });
          return;
        }
        t.update({ title: '镜像已导入', body: (r.item && r.item.name) || '', progress: 100 });
        setTimeout(() => t.dismiss(), 2500);
        const warn = (r.warnings && r.warnings.length) ? `\n\n注意：${r.warnings[0]}` : '';
        toast({
          title: `已导入 ${(r.item && r.item.name) || '镜像'}`,
          body: `点「启用选中的镜像」后才会使用它。当前仍在用默认镜像。${warn}`,
          type: 'ok',
        });
        await refreshImagePanel();
      } catch (e) {
        t.dismiss();
        toast({ title: '导入失败', body: `${e.message}\n\n当前使用的镜像没有任何改动。`, type: 'error', sticky: true });
      } finally {
        un();
        btn.disabled = false;
      }
    });
  }

  if ($('btnImageEnable')) {
    $('btnImageEnable').addEventListener('click', async () => {
      const id = ($('setActiveImage') || {}).value || '';
      if (!id) {
        toast({ title: '当前已经是内置镜像', body: '当前内置档位是 Google Play；如需无 Play 商店的 Google APIs，请在上方选择。', type: 'info' });
        return;
      }
      const r = await api.imageActivate(id);
      if (!r || !r.ok) {
        toast({ title: '启用失败', body: (r && (r.error || r.reason)) || '未知错误', type: 'error' });
        await refreshImagePanel();
        return;
      }
      toast({
        title: '已切换到自定义镜像',
        body: `已用独立的安卓数据目录（${r.avd || 'apkstart-custom'}）运行，默认镜像里已装的应用与存档不受影响。\n${imageRestartNote(r)}`,
        type: 'ok',
        sticky: true,
      });
      await refreshImagePanel();
      refreshStatus().catch(() => {});
    });
  }

  if ($('btnImageRestore')) {
    $('btnImageRestore').addEventListener('click', async () => {
      const r = await api.imageRestore();
      if (!r || !r.ok) {
        toast({ title: '恢复默认镜像失败', body: (r && r.error) || '未知错误', type: 'error' });
        return;
      }
      toast({
        title: '已恢复默认镜像',
        body: `已恢复当前选择的内置系统档位（Android 14 · Google APIs / AOSP / Google Play）。${imageRestartNote(r)}`,
        type: 'ok',
      });
      await refreshImagePanel();
      refreshStatus().catch(() => {});
    });
  }

  if ($('btnImageRemove')) {
    $('btnImageRemove').addEventListener('click', async () => {
      const id = ($('setActiveImage') || {}).value || '';
      if (!id) {
        toast({ title: '请先选中一条已导入的镜像', body: '默认镜像不能移除。', type: 'info' });
        return;
      }
      const item = (state.images || []).find((x) => x.id === id);
      const c = await api.confirm({
        title: '移除自定义镜像',
        message: `确定移除「${(item && item.name) || id}」的记录吗？`,
        detail: (item && item.managed)
          ? '这份镜像是导入 ZIP 时解出来的副本，会一并删除。'
          : '只删除记录，你自己的镜像文件夹不会被删除。',
        okLabel: '移除',
        danger: true,
      });
      if (!c || c.response !== 1) return;
      const r = await api.imageRemove(id);
      if (!r || !r.ok) {
        toast({ title: '移除失败', body: (r && r.error) || '未知错误', type: 'error' });
        return;
      }
      toast({
        title: '已移除',
        body: r.wasActive
          ? '这条镜像正在使用，已自动恢复默认镜像。'
          : (r.keptSourceDir ? `你的镜像文件夹仍然在：${r.keptSourceDir}` : '记录已删除。'),
        type: 'ok',
      });
      await refreshImagePanel();
    });
  }

  if ($('btnImageReveal')) {
    $('btnImageReveal').addEventListener('click', async () => {
      const id = ($('setActiveImage') || {}).value || '';
      const r = await api.imageReveal(id);
      if (!r || !r.ok) toast({ title: '打不开目录', body: (r && r.error) || '目录不存在', type: 'error' });
    });
  }

  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    // 以前 window.open('file:///…')：setWindowOpenHandler 只放行 http(s)，
    // 这个按钮点了永远没反应。改走专用的 openPath IPC。
    await api.openPath(dir).catch(() => {});
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({
      title: '运行时组件目录已更新',
      body: '请重启 ApkStart 使其生效。现有安卓应用、存档和快照不会自动搬移；如要一起迁移，请先复制旧目录里的 apkstart.avd，再单独设置下面的安卓数据目录。',
      type: 'ok', sticky: true,
    });
  });

  // 安卓数据目录（AVD + 快照）：真正吃盘的那块，单独指到别的盘
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: '安卓数据目录已更新',
        body: '请重启 ApkStart 使其生效。旧目录里的 apkstart.avd 可以整体搬到新目录，再删掉旧的。',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      await api.openPath(String(dir)).catch(() => {});
    });
  }

  $('btnProbe').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = '探测中…';
    const found = await api.runtimeProbe();
    if (!found.length) {
      el.textContent = '未发现已运行的运行时';
      return;
    }
    el.textContent = `发现：${found.map((f) => f.name).join('、')}`;
    await api.setSettings({ device: found[0].serial });
    $('setDevice').value = found[0].serial;
    refreshStatus();
  });

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = '正在启动…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `已就绪：${r.engine}` : '启动失败，已打开修复窗口';
    refreshStatus();
    if (!r.ok) openRepair(r);
  });

  $('btnRuntimeStop').addEventListener('click', sysStopCurrent);

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = '未关联 · 点击开启';
      btn.dataset.on = '0';
      toast({ title: '.apk 关联已取消' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = '已关联 · 点击取消';
      btn.dataset.on = '1';
      toast({ title: '.apk 关联已开启', body: r.ok ? '现在双击 APK 会直接安装到 ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 链接统一走系统浏览器
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', (e) => openSettings({ opener: e.currentTarget }));
  // 状态标签也当入口：点「需要部署 / 引导中 / Android 14」直接进设置的运行时面板
  $('engineTag').addEventListener('click', (e) => showSetup(true, e.currentTarget));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // 运行时部署：入口已收进设置，这里只处理面板内的按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnImportRuntimePack').addEventListener('click', async () => {
    const btn = $('btnImportRuntimePack');
    btn.disabled = true;
    try {
      const r = await api.importRuntimePack();
      if (r.ok) {
        toast({ title: '本地运行时已导入', body: r.root || '', type: 'ok' });
        refreshStatus();
      } else if (!r.canceled) {
        toast({ title: '导入失败', body: r.error, type: 'error', sticky: true });
      }
    } finally {
      btn.disabled = false;
    }
  });
  const clr = $('btnClearDeployLog');
  if (clr) clr.addEventListener('click', () => { const b = $('deployLog'); if (b) b.innerHTML = ''; });
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    openSettingsSection('advanced');
    a11y.focus($('setEngineMode'));
  });

  // 状态条上的自检计数：点开就是设置里的运行时面板
  $('envChip').addEventListener('click', async (e) => {
    const opened = await showSetup(true, e.currentTarget);
    if (!opened || a11y.top() !== $('settingsMask') || settingsSec !== 'runtime' || $('setSearch').value) return;
    const box = $('envCheck');
    if (!box.hidden) a11y.scroll(box);
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: '操作失败', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: '系统镜像已导入', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: '导入失败', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: '虚拟磁盘已导入', body: '可直接启动运行时', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: '导入失败', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: '正在启动运行时…', body: '首次启动需要引导 Android 系统', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: '运行时已就绪', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else { t.dismiss(); openRepair(r); }
      refreshStatus();
      return;
    }
    if (act === 'vmStop') await sysStopCurrent();
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // 「安卓桌面」：Play 镜像的 Pixel 桌面把已装应用放在上滑抽屉里，用户按 Home
  // 只看到 Google 自带图标，会以为应用丢了。这里一步到位：HOME → 上滑 → 抽屉。
  const btnHome = $('btnAndroidHome');
  if (btnHome) btnHome.addEventListener('click', async () => {
    btnHome.disabled = true;
    try {
      const r = await api.androidHome();
      if (!r || !r.ok) toast({ title: '打不开安卓桌面', body: (r && r.error) || '安卓还没启动', type: 'error' });
    } catch (e) {
      toast({ title: '打不开安卓桌面', body: e.message, type: 'error' });
    } finally {
      btnHome.disabled = false;
    }
  });
  // 共享目录入口移到设置里：同步 + 打开都在「文件互通」组内
  $('btnSyncShared')?.addEventListener('click', syncSharedNow);

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });
  $('emptySearchClear').addEventListener('click', () => {
    $('search').value = state.filter = '';
    a11y.focus($('search'));
    renderGrid();
  });
  $('retryApps').addEventListener('click', refreshApps);

  $('grid').addEventListener('click', (e) => {
    const button = e.target.closest('.card-menu-btn');
    if (button) {
      if (state.menuPkg === button.closest('.card').dataset.pkg) hideMenu();
      else openCardMenu(button);
      return;
    }
    const card = e.target.closest('.card');
    if (card && e.detail <= 1) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    if (e.clientX === 0 && e.clientY === 0) openCardMenu(card.querySelector('.card-menu-btn'), e.target);
    else showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    openCardMenu(card.querySelector('.card-menu-btn'), e.target);
  });

  const menu = $('ctxmenu');
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item && item.getAttribute('aria-disabled') !== 'true') handleMenu(item.dataset.act);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      hideMenu();
      return;
    }
    const items = [...menu.querySelectorAll('.item')];
    const index = items.indexOf(document.activeElement);
    const next = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index + items.length - 1) % items.length,
      Home: 0, End: items.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    a11y.focus(items[next], false);
  });
  window.addEventListener('resize', positionMenu);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu, .card-menu-btn')) hideMenu(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const layer = a11y.top();
    if (e.key === 'Escape') {
      if (hideMenu()) e.preventDefault();
      else if (layer) {
        e.preventDefault();
        if (layer.id === 'settingsMask') closeSettings();
        else if (layer.id === 'repairMask') closeRepair();
        else if (layer.id === 'wizardMask' && !wizard.deploying && !wizard.saving) wizardFinish();
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!layer || layer.id === 'settingsMask') a11y.focus($(layer ? 'setSearch' : 'search'));
    }
  });

  // 拖放安装
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter(Boolean);
    // 判定交给主进程（core/filetype）：下载工具留下的 a.apk.1 / a.apk.tmp 也算安装包，
    // 这里不再自己写一份正则，免得两边规则慢慢跑偏。
    const kinds = await Promise.all(paths.map((p) => api.fileKind(p).catch(() => null)));
    const accepted = paths.filter((_, i) => kinds[i] && kinds[i].kind);
    if (accepted.length) installFiles(accepted);
    else toast({ title: '只能拖入 .apk / .xapk / .apks 文件', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让「正在安装…」那条一直转圈（可能来自双击 APK 的另一条链路）
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    // 装不上可能是「安卓还没起来」的下游症状，由统一入口提供修复提示。
    showInstallError(p?.file, p?.message);
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => { updateStepProgress(p.component, p); appendDeployLog(p); });
  api.on('update:state', (info) => { if (info) renderUpdate(info); });
  api.on('update:progress', (p) => renderUpdateProgress(p));
}

/* ---------------- 启动 ---------------- */

/* ---------------- 首次运行引导向导 ---------------- */

const wizard = {
  page: 1,
  suspended: 0,          // 跳进设置页细调时记住引导停在第几步
  drives: [],
  selectedDrive: '',
  recommendedDrive: '',
  systemDrive: 'C:',
  saving: false,
  deploying: false,
  driveRequested: '',
  driveSave: Promise.resolve(null),
  bar: 0,
  version: '',
  configDirty: false,
  configLoad: 0,
};

/** 向导进度条的阶段映射：把各阶段（adb / 引擎 / 镜像 / 整包）的 percent 折算成单调递增的 0-100 */
function wizardMapPercent(p) {
  const msg = String(p.message || '');
  const pct = Number(p.percent) || 0;
  let mapped = null;
  if (/adb/i.test(msg)) mapped = 2 + pct * 0.08;
  else if (/引擎/.test(msg)) mapped = 10 + pct * 0.30;
  else if (/镜像|展开/.test(msg)) mapped = 45 + pct * 0.50;
  else if (/下载运行时/.test(msg)) mapped = 5 + pct * 0.45;   // GitHub 整包：一个文件含全部组件
  return mapped;
}

function wizardUpdateProgress(p) {
  if (!wizard.deploying) return;
  const mapped = wizardMapPercent(p);
  if (mapped != null) wizard.bar = Math.max(wizard.bar, Math.min(99, mapped));
  const bar = $('wizardBar');
  const text = $('wizardProgressText');
  if (bar) {
    bar.style.width = `${wizard.bar.toFixed(1)}%`;
    bar.parentElement.setAttribute('aria-valuenow', String(Math.round(wizard.bar)));
  }
  if (text && p.message && text.textContent !== p.message) text.textContent = p.message;
}

const WIZARD_PAGES = 8;
const WIZARD_TITLES = {
  1: '欢迎使用 ApkStart', 2: '选择安装位置', 3: '正在准备运行时',
  4: '虚拟机资源', 5: '硬件加速', 6: '画面与存储', 7: '系统镜像与语言', 8: '设置完成',
};

function wizardShowPage(n) {
  if (wizard.deploying && n !== 3) return;
  const moved = wizard.page !== n;
  wizard.page = n;
  for (let i = 1; i <= WIZARD_PAGES; i += 1) $(`wizardPage${i}`).hidden = i !== n;
  const title = $('wizardTitle');
  if (moved || !($('wizardMask').classList.contains('on'))) {
    $('wizardStep').textContent = `第 ${n} 步 / 共 ${WIZARD_PAGES} 步`;
    title.textContent = WIZARD_TITLES[n] || 'ApkStart';
  }
  const busy = wizard.deploying || wizard.saving;
  const back = $('wizardBack');
  const next = $('wizardNext');
  const skip = $('wizardSkip');
  const closeBtn = $('wizardCloseBtn');
  back.hidden = n === 1;
  back.disabled = busy;
  closeBtn.hidden = n !== 3 || wizard.deploying;
  closeBtn.disabled = busy;
  skip.hidden = n === 3 && wizard.deploying;
  skip.disabled = busy;
  skip.textContent = n === WIZARD_PAGES ? '完成，稍后重启' : '跳过引导';
  next.disabled = busy;
  if (n === 2) next.textContent = '开始安装';
  else if (n === 3) next.textContent = wizard.deploying ? '正在安装…' : ($('wizardDone').hidden ? '返回修改' : '下一步：设置');
  else if (n === WIZARD_PAGES) next.textContent = '完成设置并重启';
  else next.textContent = '下一步';
  if (moved && a11y.top() === $('wizardMask')) {
    $('wizardMask').querySelector('.modal-body').scrollTop = 0;
    a11y.focus(title);
  }
  if (moved && n === 4) wizardSetupConfigPage();
}

/** 把当前设置回填到引导里的控件；每次进设置页都刷新，避免用户在外面改过又被覆盖 */
async function wizardFillConfig(loadId = wizard.configLoad) {
  const s = await api.getSettings().catch(() => null) || state.settings || {};
  // 这次设置读取回来时，用户可能已经改了下拉框（或已经离开本页重新回填）：
  // 此时绝不能用读到的旧值覆盖用户刚做的选择。
  const stale = loadId !== wizard.configLoad || wizard.configDirty;
  if (!stale) {
    const eng = s.engine || {};
    const rt = s.runtime || {};
    const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v == null ? '' : v); };
    put('wizMemory', eng.memoryMB || 0);
    put('wizCores', eng.cores || 0);
    put('wizResourceMode', eng.resourceMode || 'balanced');
    put('wizRenderSize', eng.renderSize || 'auto');
    // 引导页默认给出推荐值，而不是「自动」那个 6GB 的老默认
    put('wizDataGB', eng.dataPartitionGB || 0);
    // 没手动指定过就按最大剩余空间给推荐值。必须在 getSettings 返回后再算，
    // 否则会被这次异步回填覆盖掉（用户看到「自动」、最终却存了旧值）。
    const data = document.getElementById('wizDataGB');
    if (data && !Number(data.value)) {
      // 推荐值要按「本次安装的那个盘」算，不是随便拿剩余最大的盘（可能根本没往那儿装）
      const picked = (wizard.drives || []).find((d) => d.drive === wizard.selectedDrive);
      const free = picked ? (Number(picked.free) || 0)
        : (wizard.drives || []).reduce((max, d) => Math.max(max, Number(d.free) || 0), 0);
      const gb = !free || free < 12 * 1073741824 ? 4
        : free < 32 * 1073741824 ? 8
          : free < 60 * 1073741824 ? 16 : 24;
      data.value = String(gb);
    }
    put('wizGpuMode', eng.gpuMode || 'auto');
    put('wizImageFlavor', rt.systemImageFlavor || 'google_apis_playstore');
    put('wizLanguage', s.language || 'auto');
  }
  // 硬件加速是「当场探测」的只读文案，不涉及用户输入，任何情况下都刷新。
  const accelText = document.getElementById('wizAccelText');
  if (accelText) {
    const response = await api.accelStatus().catch(() => null);
    const a = response?.accel;
    accelText.textContent = !a ? '暂时无法检测，可在设置页查看'
      : (a.ok
        ? (a.suspect ? `已启用 · ${a.kind === 'whpx' ? 'WHPX' : 'AEHD'}（驱动服务未运行，可能开不了机）`
          : `已启用 · ${a.kind === 'whpx' ? 'WHPX' : (a.kind === 'aehd' ? 'AEHD' : '硬件加速')}`)
        : a.kind === 'kvm' ? 'KVM 未就绪 · 请检查系统虚拟化配置' : '未启用 · 当前是纯软件模拟（开机慢，可能直接崩）');
  }
}

/** 进入资源页时用当前设置 + 磁盘余量回填控件 */
function wizardSetupConfigPage() {
  wizard.configDirty = false;
  const loadId = ++wizard.configLoad;
  wizardFillConfig(loadId).catch(() => {});
}

function markWizardConfigDirty() {
  if (wizard.page >= 4 && wizard.page <= 7) wizard.configDirty = true;
}

/** 引导页点击下一步才应用设置；容量必须先经过真实扩容，失败留在当前页。 */
async function wizardCollectConfig() {
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };
  const gb = Number(val('wizDataGB')) || 0;
  if (gb !== Number(state.settings?.engine?.dataPartitionGB || 0) && !await applyDataCapacity(gb)) return false;
  const mode = val('wizResourceMode') || 'balanced';
  const patch = {
    engine: {
      memoryMB: Number(val('wizMemory')) || 0,
      cores: Number(val('wizCores')) || 0,
      renderSize: val('wizRenderSize') || 'auto',
      gpuMode: val('wizGpuMode') || 'auto',
    },
    language: val('wizLanguage') || 'auto',
  };
  // 手动填了内存/核心就关掉自动；两项都留空时自动标记不该被误改
  patch.engine.autoMemory = !patch.engine.memoryMB && !patch.engine.cores;
  // 资源策略必须在另一个 patch 里先写：store.saveSettings 会用预设覆盖 renderSize，
  // 放一起会把用户刚选的画质悄悄改回「自动」。
  try {
    await api.setSettings({ engine: { resourceMode: mode } });
    state.settings = await api.setSettings(patch);
    wizard.configDirty = false;
    return true;
  } catch (e) {
    toast({ title: '保存设置失败', body: e?.message || '请稍后重试。', type: 'error' });
    return false;
  }
}

function wizardShowSummary() {
  const el = document.getElementById('wizSummary');
  if (!el) return;
  const t = (id) => {
    const node = document.getElementById(id);
    return node && node.selectedOptions.length ? node.selectedOptions[0].textContent.trim() : '自动';
  };
  el.innerHTML = ''
    + `<div>内存 / CPU：${esc(t('wizMemory'))} · ${esc(t('wizCores'))}</div>`
    + `<div>数据分区：${esc(t('wizDataGB'))}</div>`
    + `<div>画质 / 渲染：${esc(t('wizRenderSize'))} · ${esc(t('wizGpuMode'))}</div>`
    + `<div>系统镜像：${esc(t('wizImageFlavor'))}</div>`
    + `<div>界面语言：${esc(t('wizLanguage'))}</div>`;
}

function wizardSelectedPaths() {
  const runtime = state.settings?.runtime || {};
  const drive = wizard.selectedDrive || '';
  const defaultAvd = state.info?.avdHome || '';
  const dir = drive ? `${drive}\\ApkStart\\runtime` : (state.info?.runtimeDir || '');
  const avdDir = drive ? `${drive}\\ApkStart\\avd` : defaultAvd;
  if (wizard.driveRequested) return { dir, avdDir };
  // 重新打开向导不代表同意改动已有自选路径，预览也必须显示实际配置。
  return { dir: runtime.dir || dir, avdDir: runtime.avdDir || (runtime.dir ? defaultAvd : avdDir) };
}

function wizardDirsPreview() {
  const box = document.getElementById('wizardDirs');
  if (!box) return;
  const { dir: runtime, avdDir: avd } = wizardSelectedPaths();
  box.innerHTML = ''
    + `<div>运行时（引擎 + 系统镜像）：<b>${esc(runtime || '未选择')}</b></div>`
    + `<div>安卓数据（应用、存档、快照）：<b>${esc(avd || '未选择')}</b></div>`;
}

function renderWizardDrives() {
  const box = $('wizardDrives');
  if (!wizard.drives.length) {
    box.innerHTML = '<div class="sub">未读取到可用磁盘（可以在设置里手动填路径）</div>';
    return;
  }
  box.innerHTML = wizard.drives.map((d) => {
    const freeGB = (d.free / 1073741824).toFixed(0);
    const totalGB = (d.total / 1073741824).toFixed(0);
    const sys = d.drive.toUpperCase() === wizard.systemDrive.toUpperCase();
    const rec = d.drive === wizard.recommendedDrive;
    const pct = d.total ? Math.max(2, Math.round((d.free / d.total) * 100)) : 0;
    const low = d.free < 8 * 1073741824;
    const selected = d.drive === wizard.selectedDrive;
    return `<label class="drive-item${selected ? ' on' : ''}" data-drive="${esc(d.drive)}" title="剩余 ${freeGB} GB / 共 ${totalGB} GB">`
      + `<input class="drive-radio" type="radio" name="wizardDrive" value="${esc(d.drive)}" ${selected ? 'checked' : ''}>`
      + `<span class="d-letter">${esc(d.drive)}${sys ? '<span class="d-tag sys">系统盘</span>' : ''}</span>`
      + `<span class="d-free">剩余 ${freeGB} GB（${pct}%）${rec ? '<span class="d-tag">推荐</span>' : ''}</span>`
      + `${low ? '<span class="d-free low">空间不足（需 8GB+）</span>' : ''}`
      + `</label>`;
  }).join('');
}

function selectWizardDrive(e) {
  const radio = e.target;
  if (!radio.matches('input[name="wizardDrive"]') || !radio.checked || wizard.deploying || wizard.saving) return;
  const drive = radio.value;
  if (wizard.driveRequested === drive) return;
  wizard.selectedDrive = wizard.driveRequested = drive;
  for (const item of $('wizardDrives').querySelectorAll('.drive-item')) item.classList.toggle('on', item.dataset.drive === drive);
  wizardDirsPreview();
  // 选盘仍然立即保存，部署前等待最后一次选择落盘。
  wizard.driveSave = wizard.driveSave.then(async () => {
    try {
      state.settings = await api.setSettings({
        runtime: { dir: `${drive}\\ApkStart\\runtime`, avdDir: `${drive}\\ApkStart\\avd` },
      });
      return null;
    } catch (e) {
      if (wizard.driveRequested === drive) wizard.driveRequested = '';
      return e.message || '无法保存安装位置';
    }
  });
  wizard.driveSave.then((error) => { if (error) toast({ title: '无法保存安装位置', body: error, type: 'error' }); });
}

async function wizardStartDeploy() {
  if (wizard.deploying || wizard.saving || wizard.page !== 2) return;
  wizard.deploying = true;
  wizard.bar = 0;
  const done = $('wizardDone');
  const fail = $('wizardFail');
  const failMsg = $('wizardFailMsg');
  const bar = $('wizardBar');
  const text = $('wizardProgressText');
  done.hidden = true;
  fail.hidden = true;
  failMsg.textContent = '';
  bar.style.width = '0%';
  bar.parentElement.removeAttribute('aria-valuenow');
  text.textContent = '准备中…';
  wizardShowPage(3);
  let driveError = await wizard.driveSave;
  if (!driveError && state.info?.platform?.platform === 'win32' && wizard.selectedDrive && !state.settings?.runtime?.dir) {
    try {
      // 首次接受默认推荐盘不会触发 radio change，必须在部署前提交预览路径。
      state.settings = await api.setSettings({ runtime: wizardSelectedPaths() });
    } catch (e) {
      driveError = e.message || '无法保存安装位置';
    }
  }
  const r = driveError ? { ok: false, error: driveError }
    : await api.autoDeploy().catch((e) => ({ ok: false, error: e.message }));
  wizard.deploying = false;
  if (r?.ok) {
    bar.style.width = '100%';
    bar.parentElement.setAttribute('aria-valuenow', '100');
    text.textContent = '运行时已就绪';
    done.hidden = false;
  } else {
    text.textContent = '部署失败';
    failMsg.textContent = `部署未完成：${r?.error || '未知原因'}`;
    fail.hidden = false;
  }
  wizardShowPage(3);
}

async function wizardFinish({ restart = false } = {}) {
  if (wizard.deploying || wizard.saving || a11y.top() !== $('wizardMask')) return;
  wizard.saving = true;
  wizardShowPage(wizard.page);
  try {
    await wizard.driveSave;
    // 必须等「引导已完成」落盘后再让主进程退出，否则重启后又会弹一遍引导
    state.settings = await api.setSettings({ wizardDone: true, wizardVersion: wizard.version });
    if (restart) {
      await api.restartApp();
      return;
    }
    wizard.suspended = 0;
    $('btnBackToWizard').hidden = true;
    api.wizardClose().catch(() => {});
    a11y.close($('wizardMask'));
    refreshStatus().catch(() => {});
  } catch (e) {
    toast({ title: '无法完成引导', body: e.message, type: 'error' });
  } finally {
    wizard.saving = false;
    wizardShowPage(wizard.page);
  }
}

async function openWizard() {
  const mask = $('wizardMask');
  if (!mask || mask.classList.contains('on') || wizard.saving) return;
  const opener = menuOpener || a11y.bookmark();
  // 平台差异（Linux：无盘符可选、不走 GitHub 整包、没有双击 APK 关联）
  const info = await api.info().catch(() => state.info);
  if (info) state.info = info;
  const isLinux = !!(info && info.platform && info.platform.platform === 'linux');
  patchWizardForPlatform(isLinux, info);
  const drv = isLinux ? { drives: [], recommended: '' } : await api.sysDrives().catch(() => null);
  const configured = String((state.settings && state.settings.runtime && state.settings.runtime.dir) || '');
  const configuredDrive = /^[A-Za-z]:/.test(configured) ? `${configured.slice(0, 1).toUpperCase()}:` : '';
  if (drv) {
    wizard.drives = drv.drives || [];
    wizard.recommendedDrive = drv.recommended || '';
    wizard.selectedDrive = configured ? configuredDrive : (drv.recommended || '');
    wizard.systemDrive = drv.systemDrive || 'C:';
  }
  // 向导第 1 页的语言选择器（与第 7 页的 wizLanguage、设置页的 setLanguage 同一设置）
  const firstLanguage = document.getElementById('wizLanguageFirst');
  if (firstLanguage) firstLanguage.value = (state.settings && state.settings.language) || 'auto';
  renderWizardDrives();
  wizard.driveRequested = '';
  wizard.driveSave = Promise.resolve(null);
  wizardDirsPreview();
  wizard.bar = 0;
  hideMenu(false);
  api.wizardOpen().catch(() => {});
  wizardShowPage(1);
  a11y.open(mask, { opener });
}

/**
 * 首启引导的平台化：Windows 文案是源语言默认值，Linux 上替换成对应说法
 * （渲染层替换的文本节点带进 i18n 词典，en 界面同样有英文）。
 */
function patchWizardForPlatform(isLinux, info) {
  applyPlatformCapabilities(info);
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  if (!isLinux) {
    show('fieldDrives', true);
    show('fieldDirs', true);
    show('fieldLinuxDir', false);
    return;
  }
  set('wizardLead', '三步开始：<b>自动下载运行时</b> → 在 ApkStart 里安装 APK → 即用。');
  set('wizardHowLong', '<b>要多久</b>：会从 Google 官方源分组件下载 adb、运行时引擎与 Android 14 系统镜像（合计约 1.6 GB）。官方源实测可达每秒数十 MB，通常几分钟。');
  set('wizardWhere', '<b>装在哪里</b>：默认安装到用户数据目录（~/.local/share/apkstart），以后随时可以在「设置 → 系统集成」里改。');
  set('wizardReq', '<b>配置要求</b>：Linux 64 位（x86_64），需要图形会话与 /dev/kvm（把用户加入 kvm 组并在 BIOS 打开虚拟化）。建议 8 GB 内存、至少 30 GB 可用空间。没开硬件加速也能用，但首次开机会慢很多。');
  show('fieldDrives', false);
  show('fieldDirs', false);
  show('fieldLinuxDir', true);
  const dirs = document.getElementById('wizardLinuxDirs');
  if (dirs) {
    const runtimeDir = (info && info.runtimeDir) || state.settings?.runtime?.dir || '—';
    const avdDir = (info && info.avdHome) || state.settings?.runtime?.avdDir || '—';
    dirs.innerHTML = `<div>运行时（引擎 + 系统镜像）：<b>${esc(runtimeDir)}</b></div>`
      + `<div>安卓数据（应用、存档、快照）：<b>${esc(avdDir)}</b></div>`;
  }
}

async function bindWizard() {
  if (!document.getElementById('wizardMask')) return;
  document.getElementById('wizardSkip').addEventListener('click', () => wizardFinish());
  document.getElementById('wizardCloseBtn').addEventListener('click', () => wizardFinish());
  $('wizardBack').addEventListener('click', () => {
    if (!wizard.deploying && !wizard.saving) wizardShowPage(Math.max(1, wizard.page - 1));
  });
  $('wizardDrives').addEventListener('change', selectWizardDrive);
  $('wizardDrives').addEventListener('click', selectWizardDrive);
  for (const id of ['wizMemory', 'wizCores', 'wizResourceMode', 'wizRenderSize', 'wizDataGB',
    'wizGpuMode', 'wizImageFlavor', 'wizLanguage']) {
    document.getElementById(id)?.addEventListener('change', markWizardConfigDirty);
  }
  // 第 1 页的语言选择：保存设置 + 现场重翻整页（与设置页 setLanguage 同一机制）
  const langFirst = document.getElementById('wizLanguageFirst');
  if (langFirst) langFirst.addEventListener('change', () => changeLanguage(langFirst.value || 'auto'));
  $('wizardNext').addEventListener('click', async () => {
    if (wizard.deploying || wizard.saving) return;
    const page = wizard.page;
    if (page === 1) wizardShowPage(2);
    else if (page === 2) await wizardStartDeploy();
    else if (page === 3) wizardShowPage($('wizardDone').hidden ? 2 : 4);
    else {
      wizard.saving = true;
      wizardShowPage(page);
      let saved = false;
      try { saved = await wizardCollectConfig(); }
      finally { wizard.saving = false; }
      if (!saved) { wizardShowPage(page); return; }
      if (page === WIZARD_PAGES) await wizardFinish({ restart: true });
      else {
        if (page === WIZARD_PAGES - 1) wizardShowSummary();
        wizardShowPage(page + 1);
      }
    }
  });

  // 每一步都能跳到设置面板细调，关掉设置后回到同一步
  document.querySelectorAll('[data-wizsec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (wizard.saving || wizard.deploying) return;
      const section = btn.dataset.wizsec || 'performance';
      wizard.suspended = wizard.page;
      $('btnBackToWizard').hidden = false;
      openSettings({ section, opener: btn, focusId: 'setTitle' });
    });
  });
  $('btnBackToWizard')?.addEventListener('click', () => closeSettings());

  // 镜像档位要走带校验的专用入口（直接写 systemImageFlavor 会绕过 AVD 切换）
  document.getElementById('wizImageFlavor')?.addEventListener('change', async (e) => {
    const wanted = e.target.value;
    const r = await api.setImageFlavor(wanted).catch((err) => ({ ok: false, error: err.message }));
    if (r && r.ok) {
      state.settings = await api.getSettings().catch(() => state.settings);
      toast({ title: '系统镜像已选择', body: '使用独立 AVD，下次开机生效；其它档位的数据不会删除', type: 'ok' });
    } else {
      e.target.value = (state.settings && state.settings.runtime && state.settings.runtime.systemImageFlavor) || 'google_apis_playstore';
      toast({ title: '切换失败', body: (r && r.error) || '请稍后在设置里重试', type: 'error' });
    }
  });
  document.getElementById('wizEnableAccel')?.addEventListener('click', async () => {
    const t = toast({ title: '正在开启硬件加速…', body: '如弹出管理员授权请点「是」', sticky: true, spinner: true });
    const r = await api.enableVirtualization().catch((e) => ({ ok: false, note: e.message }));
    t.update(r && r.ok
      ? { title: '硬件加速已就绪', body: r.note || '可以继续下一步', type: 'ok' }
      : { title: '还没能自动开启', body: (r && r.note) || '可以在设置里查看原因', type: 'warn' });
    wizardFillConfig().catch(() => {});
  });
  document.getElementById('wizGuestZh')?.addEventListener('click', async () => {
    const t = toast({ title: '正在切换安卓系统语言…', body: '安卓会重启一次，约半分钟', sticky: true, spinner: true });
    const r = await api.guestLocalize('zh-CN').catch((e) => ({ ok: false, error: e.message }));
    t.update(r && r.ok
      ? { title: '已提交简体中文', body: r.active ? '系统界面已切换完成' : '下次开机后生效', type: 'ok' }
      : { title: '切换失败', body: (r && r.error) || '可在设置里重试', type: 'warn' });
  });

  document.getElementById('btnOpenWizard')?.addEventListener('click', () => {
    closeSettings();
    openWizard();
  });
  api.on('provision:progress', (p) => wizardUpdateProgress(p));

  const info = await api.info().catch(() => ({}));
  applyPlatformCapabilities(info);
  wizard.version = String(info.version || '');
  const s = state.settings || {};
  // 新安装和版本升级都显示引导，避免旧配置里的 wizardDone 永久跳过关键说明。
  if (s.wizardDone === true && wizard.version && s.wizardVersion === wizard.version) return;
  await openWizard();
}

async function init() {
  // 先定语言再渲染：否则英文环境下会先闪一屏中文
  await initI18n();
  bindEvents();
  bindSettings();
  bindSettingsNav();
  bindUpdate();
  bindAndroid();
  state.settings = await api.getSettings();
  // 自动更新开关按设置回填（bindUpdate 在 settings 加载前绑定，只能在这里回填）
  const au = $('setAutoUpdate');
  if (au) au.checked = !!(state.settings && state.settings.update && state.settings.update.autoUpdate !== false);
  const ra = $('setReportAuto');
  if (ra) ra.checked = !!(state.settings && state.settings.report && state.settings.report.auto !== false);
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  await bindWizard();
  bindSystems();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ==================== 多系统选择 + 运行状态任务（Provider 架构） ==================== */

const sysUI = {
  data: null,          // system:list 的结果
  selected: '',        // 当前展开详情的 systemId
  tasks: [],           // 近期任务
  logs: [],
  logRequest: 0,
  logTimer: null,
  snapshotPushes: null,
  taskBusy: new Set(),
  status: null,
  statusError: '',
  runtimeError: '',
  statusRequest: 0,
  lastAnnouncedTaskId: '',
  switchOp: null,
  stopBusy: false,
  bound: false,
  loading: false,
  loadPromise: null,
  reloadPending: false,
  error: '',
};
const sysTaskAnnouncements = new Map();

// system:status 决定当前 Provider；runtime:status 只描述旧内置运行时，不能冒充非内置系统。
function sysSession() {
  const current = sysUI.status?.current || {};
  const id = current.systemId || sysUI.data?.currentSystemId
    || sysUI.data?.systems?.find((s) => s.current)?.id || '';
  const nameOf = (sid) => sysUI.data?.systems?.find((s) => s.id === sid)?.name || sid;
  const name = nameOf(id);
  const builtin = !id || ['google-play', 'google-apis', 'aosp'].includes(id);
  const switching = !!sysUI.switchOp || !!sysUI.status?.switching;
  const stopping = sysUI.stopBusy || !!sysUI.status?.stopping;
  const running = !!(current.running || current.vmStarted);
  const message = stopping ? '正在停止当前系统…'
    : switching ? '正在切换系统，可取消切换…'
      : sysUI.statusError ? '无法确认当前系统状态，请刷新后重试'
        : !builtin ? `${name} · ${running ? current.androidReady ? '正在运行' : '已启动，等待 Android 就绪' : '未运行'}`
          : current.stopped ? `${name} · 已停止` : '';
  return { current, id, name, builtin, switching, stopping, running, message };
}

async function sysStopCurrent() {
  const session = sysSession();
  if (session.stopping) return;
  const op = sysUI.switchOp;
  const cancelling = session.switching;
  if (op) op.stopRequested = true;
  sysUI.stopBusy = true;
  ++sysUI.statusRequest; // 先前在途状态读取不能把停机中的界面回滚。
  setText($('probeResult'), '正在停止当前系统…');
  renderRuntimeStatus();
  try {
    // 无参数：停止/取消由 manager 持有的当前会话，绝不按所选卡片猜运行时。
    const r = await api.systemStop();
    if (r?.cancelled) {
      setText($('probeResult'), '停止操作已取消');
      toast({ title: '停止操作已取消', body: '请查看当前系统的实际运行状态。', type: 'info' });
    } else if (r?.ok !== true || r.running === true) {
      throw new Error(r?.error || '未能确认当前系统已停止');
    } else {
      if (sysUI.switchOp === op) sysUI.switchOp = null;
      const title = cancelling ? '切换已取消，当前系统已停止' : '当前系统已停止';
      setText($('probeResult'), title);
      toast({ title, body: '下载与安装任务不会因此取消；安装器运行时请先在虚拟机内正常关机。', type: 'ok' });
    }
    return r;
  } catch (e) {
    const error = e?.message || '未能确认当前系统已停止';
    setText($('probeResult'), `停止失败：${error}`);
    toast({ title: '停止失败', body: error, type: 'error' });
    return { ok: false, error };
  } finally {
    // 刷新期间也保持忙碌，所有停止入口共用同一把锁。
    await refreshStatus();
    await loadSystems();
    sysUI.stopBusy = false;
    renderRuntimeStatus();
  }
}

async function sysSwitchSystem(systemId) {
  const session = sysSession();
  if (session.switching || session.stopping) return;
  const op = { systemId, stopRequested: false };
  sysUI.switchOp = op;
  ++sysUI.statusRequest;
  renderRuntimeStatus();
  try {
    const r = await api.systemSwitch({ systemId });
    // stop 的实际退出回执才决定是否已停，迟到的 switch 结果不得再提示「已切换」。
    if (op.stopRequested) return r;
    if (r?.code === 'START_CANCELLED' || r?.cancelled) {
      toast({ title: '系统切换已取消', body: '请查看当前系统的实际运行状态。', type: 'info' });
    } else if (r?.ok) {
      toast({ title: '已切换', body: r.androidReady === false ? '虚拟机已启动，但 Android 尚未就绪' : `${r.systemId || systemId} 已进入可用状态`, type: r.androidReady === false ? 'warn' : 'ok' });
    } else {
      toast({ title: '切换失败', body: r?.error || '未知错误', type: 'error' });
    }
    return r;
  } catch (e) {
    if (!op.stopRequested) toast({ title: '切换失败', body: e?.message || '请稍后重试。', type: 'error' });
  } finally {
    if (sysUI.switchOp === op) {
      sysUI.switchOp = null;
      await refreshStatus();
      await loadSystems();
      renderRuntimeStatus();
    }
  }
}

const SYS_LOGO = {
  'google-play': 'google', 'google-apis': 'google', aosp: 'aosp',
  lineageos: 'lineage', 'bliss-os': 'bliss', 'android-x86': 'androidx86', custom: 'custom',
};

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  return Math.round(bps / 1024) + ' KB/s';
}
function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `约 ${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `约 ${Math.ceil(sec / 60)} 分钟`;
  return `约 ${(sec / 3600).toFixed(1)} 小时`;
}
const SYS_STATUS_LABEL = {
  waiting: '等待中', preparing: '准备中', downloading: '下载中', verifying: '文件校验中',
  extracting: '解压中', installing: '安装中', initializing: '初始化中', starting: '启动中',
  completed: '已完成', failed: '失败', paused: '已暂停', cancelled: '已取消',
  awaiting_confirmation: '等待确认安装完成',
};
const ACTIVE_TASK_STATUS = ['waiting', 'preparing', 'downloading', 'verifying', 'extracting', 'installing', 'initializing', 'starting', 'awaiting_confirmation'];
const SYS_TASK_LIMIT = 50; // 与 system:tasks 的快照上限一致
const liveSysTask = (t) => t.status === 'paused' || ACTIVE_TASK_STATUS.includes(t.status);

function mergeSysTasks(tasks, updates = []) {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const t of updates) {
    const previous = byId.get(t.taskId);
    if (!previous || (t.updatedAt || '') >= (previous.updatedAt || '')) byId.set(t.taskId, t);
  }
  const sorted = [...byId.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // 不让历史任务挤掉仍可继续或正在运行的任务。
  let historySlots = Math.max(0, SYS_TASK_LIMIT - sorted.filter(liveSysTask).length);
  return sorted.filter((t) => liveSysTask(t) || historySlots-- > 0).slice(0, SYS_TASK_LIMIT);
}

/** 根据真实状态计算卡片主按钮文案与动作（绝不显示点了也完不成的按钮） */
function sysPrimaryAction(s) {
  const l = s.local || {};
  const av = s.availability || {};
  const tasks = sysUI.tasks.filter((t) => t.systemId === s.id);
  const activeTask = tasks.find(liveSysTask);
  const builtin = ['google-play', 'google-apis', 'aosp'].includes(s.id);
  const session = sysSession();
  if (session.switching && (sysUI.switchOp?.systemId === s.id || s.current)) {
    return { label: session.stopping ? '正在停止…' : '取消切换', act: 'stop', cls: 'ghost' };
  }
  if ((s.current && l.running) || (session.id === s.id && session.running)) {
    return { label: session.stopping ? '正在停止…' : '停止当前系统', act: 'stop', cls: 'ghost' };
  }
  if (s.id === 'custom') return { label: '管理镜像', act: 'custom', cls: 'ghost' };
  if (activeTask?.status === 'paused') {
    return { label: '继续任务', act: 'resume', cls: 'primary', taskId: activeTask.taskId };
  }
  if (activeTask) {
    const label = activeTask.status === 'downloading' ? '查看下载进度'
      : activeTask.status === 'awaiting_confirmation' ? '查看待确认任务' : '查看进度';
    return { label, act: 'progress', cls: 'ghost', taskId: activeTask.taskId };
  }
  if (builtin) {
    if (s.current && l.running) return { label: '正在运行', act: 'none', cls: 'ghost', disabled: true };
    return { label: '切换到此系统', act: 'switch', cls: 'primary' };
  }
  if (s.id === 'lineageos' && av.status === 'unavailable' && !l.downloaded) {
    return { label: '导入自建镜像', act: 'import', cls: 'ghost' };
  }
  if (l.installed) {
    if (s.current && l.running) return { label: '正在运行', act: 'none', cls: 'ghost', disabled: true };
    return { label: '启动系统', act: 'switch', cls: 'primary' };
  }
  const latest = tasks[0];
  if (latest?.status === 'failed') return { label: '重试任务', act: 'retry', cls: 'primary', taskId: latest.taskId };
  if (av.available === false && !l.downloaded) {
    return { label: '查看原因', act: 'detail', cls: 'ghost' };
  }
  if (l.downloaded) return { label: '安装系统', act: 'install', cls: 'primary' };
  return { label: '下载并安装', act: 'install', cls: 'primary' };
}

function sysStatusBadges(s) {
  const l = s.local || {};
  const av = s.availability || {};
  const out = [];
  if (s.current && l.running) out.push('<span class="sys-badge run">● 运行中</span>');
  else if (l.installed) out.push('<span class="sys-badge ok">已安装</span>');
  else if (l.downloaded) out.push('<span class="sys-badge warn">已下载未安装</span>');
  else out.push('<span class="sys-badge">未下载</span>');
  if (av.status === 'unavailable') out.push('<span class="sys-badge err">无预构建镜像</span>');
  else if (av.archive) out.push('<span class="sys-badge warn">归档快照</span>');
  else if (av.available) out.push('<span class="sys-badge ok">可下载</span>');
  const v = s.version && s.version.version;
  if (v) out.push(`<span class="sys-badge">${esc(v)}</span>`);
  return out.join('');
}

function renderSysCards() {
  const box = $('sysCards');
  if (!box) return;
  if (!sysUI.data) {
    if (sysUI.error) a11y.replace(box, `<div class="sys-empty" role="status">读取系统目录失败：${esc(sysUI.error)} <button type="button" class="btn ghost sm" data-act="retryCatalog" data-focus-key="retryCatalog">重试</button></div>`, () => $('setTitle'));
    return;
  }
  const systems = sysUI.data.systems || [];
  if (!systems.length) {
    a11y.replace(box, '<div class="sys-empty" role="status">暂无系统目录</div>', () => $('setTitle'));
    return;
  }
  const html = systems.map((s) => {
    const a = sysPrimaryAction(s);
    const logo = SYS_LOGO[s.id] || 'custom';
    const ver = (s.versions && s.versions[0]) || {};
    const meta = [
      ver.androidVersion ? 'Android ' + esc(ver.androidVersion) : '',
      ver.architecture ? esc(ver.architecture) : '',
      ver.fileSize ? fmtSize(ver.fileSize) : '',
    ].filter(Boolean).join(' · ');
    const selected = sysUI.selected === s.id;
    const session = sysSession();
    const busy = (a.taskId && a.act !== 'progress' && sysUI.taskBusy.has(a.taskId))
      || (a.act === 'stop' && session.stopping);
    const blocked = a.act === 'switch' && (session.switching || session.stopping);
    return `<div class="sys-card ${selected ? 'selected' : ''} ${s.current && s.local && s.local.running ? 'sel-running' : ''}" data-sys="${esc(s.id)}" role="listitem">
      <button type="button" class="sys-card-select" data-act="select" data-focus-key="sys:${esc(s.id)}"
        aria-expanded="${selected}" aria-controls="sysDetail">
        ${s.current ? '<span class="sys-card-flag">当前</span>' : ''}
        <span class="sys-card-head">
          <span class="sys-logo ${logo}" aria-hidden="true">${esc(initialOf(s.name))}</span>
          <span><span class="sys-name">${esc(s.name)}</span><span class="sys-brand">${esc(s.brand || '')}</span></span>
        </span>
        <span class="sys-badges">${sysStatusBadges(s)}</span>
        ${meta ? `<span class="sys-detail-note" style="margin-top:8px">${meta}</span>` : ''}
      </button>
      <div class="sys-card-action">
        <button type="button" class="btn ${a.cls} sm" data-act="${a.act}" data-tid="${esc(a.taskId)}" data-focus-key="sys-action:${esc(s.id)}" ${a.disabled ? 'disabled' : ''} ${busy ? 'aria-disabled="true" aria-busy="true"' : blocked ? 'aria-disabled="true"' : ''}>${esc(busy && a.act !== 'stop' ? '正在处理…' : a.label)}</button>
        ${a.act === 'detail' ? '' : `<button type="button" class="btn ghost sm" data-act="detail" data-focus-key="sys-detail:${esc(s.id)}" aria-controls="sysDetail" aria-expanded="${selected}">详情</button>`}
      </div>
    </div>`;
  }).join('');
  a11y.replace(box, html, () => $('setTitle'));
  const ci = sysUI.data.catalogInfo || {};
  const t = $('sysCatalogTime');
  if (t) {
    const when = ci.cachedAt ? relTime(new Date(ci.cachedAt).getTime()) : '';
    t.textContent = '目录更新时间：' + (when || (ci.source === 'built-in' ? '内置索引' : '未知'))
      + (ci.stale ? '（离线缓存）' : '') + (ci.error ? ' · 远程不可用' : '');
    const warnings = sysUI.data.pathWarnings || [];
    t.title = warnings.map((w) => w.message || '').join('\n');
    if (warnings.length) t.textContent += ' · 检测到旧数据目录（悬停查看迁移提示）';
  }
}

function renderSysDetail() {
  const box = $('sysDetail');
  if (!box) return;
  if (!sysUI.selected) {
    if (box.contains(document.activeElement)) a11y.focus($('setTitle'));
    box.hidden = true;
    return;
  }
  const s = (sysUI.data && (sysUI.data.systems || []).find((x) => x.id === sysUI.selected));
  if (!s) {
    if (box.contains(document.activeElement)) a11y.focus($('setTitle'));
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const v = (s.versions && s.versions[0]) || {};
  const av = s.availability || {};
  const l = s.local || {};
  const reason = av.reason || (v.statusReason || '');
  const rows = [
    ['系统', s.name],
    ['版本', v.version || '—'],
    ['Android 基础', v.androidVersion ? 'Android ' + v.androidVersion + (v.androidApi ? ` (API ${v.androidApi})` : '') : '—'],
    ['架构', v.architecture || '—'],
    ['下载大小', v.fileSize ? fmtSize(v.fileSize) : '—'],
    ['启动后端', s.bootBackend || '—'],
    ['安装状态', l.installed ? '已安装' : (l.downloaded ? '已下载' : '未下载')],
    ['兼容性', v.source ? '见官方来源' : '—'],
  ];
  const html = `<h3 id="sysDetailTitle">${esc(s.name)} · 详情</h3>
    <div class="sys-detail-grid">${rows.map(([k, val]) => `<div><b>${esc(k)}：</b>${esc(val)}</div>`).join('')}</div>
    ${reason ? `<div class="sys-detail-note ${av.available === false ? 'warn' : ''}">${esc(reason)}</div>` : ''}
    <div class="sys-detail-act">
      ${s.id === 'lineageos' ? '<button type="button" class="btn ghost sm" data-dact="import" data-focus-key="detail:import">导入自建 AVD 镜像</button>' : ''}
      <button type="button" class="btn ghost sm" data-dact="openDir" data-focus-key="detail:openDir">打开数据目录</button>
      ${l.installed ? '<button type="button" class="btn ghost sm" data-dact="backup" data-focus-key="detail:backup">备份数据</button><button type="button" class="btn ghost sm" data-dact="remove" data-focus-key="detail:remove">删除系统</button>' : ''}
      <button type="button" class="btn ghost sm" data-dact="refresh" data-focus-key="detail:refresh">刷新目录</button>
    </div>
    <div class="sys-detail-note" id="sysDetailLogs" hidden></div>`;
  a11y.replace(box, html, () => box.querySelector('button[data-dact]') || $('setTitle'));
  renderSysLogs();
}

function renderSysLogs() {
  const box = $('sysDetailLogs');
  if (!box) return;
  const logs = sysUI.logs.filter((x) => x.sid === sysUI.selected).slice(-20);
  box.hidden = !logs.length;
  box.innerHTML = logs.length ? '<b>最近日志：</b><br>' + logs.map((x) => esc(x.msg)).join('<br>') : '';
}

function scheduleSysLogs() {
  if (!sysUI.selected || sysUI.logTimer) return;
  sysUI.logTimer = setTimeout(() => {
    sysUI.logTimer = null;
    refreshSysLogs();
  }, 250);
}

async function refreshSysLogs() {
  const sid = sysUI.selected;
  if (!sid) return;
  const request = ++sysUI.logRequest;
  try {
    // system:log 只有裸字符串，没有 provider/systemId，不能按当前运行系统猜归属。
    const r = await api.systemDetail(sid);
    if (request !== sysUI.logRequest || sid !== sysUI.selected) return;
    if (!r?.ok || r.detail?.id !== sid || !Array.isArray(r.detail.logs)) return;
    sysUI.logs = [...sysUI.logs.filter((x) => x.sid !== sid),
      ...r.detail.logs.slice(-100).map((msg) => ({ sid, msg: String(msg) }))].slice(-200);
    renderSysLogs();
  } catch (_) { /* 保留该系统上次成功读取的日志 */ }
}

const SYS_STATUS_ANNOUNCEMENT_EN = {
  waiting: 'Waiting', preparing: 'Preparing', downloading: 'Downloading', verifying: 'Verifying files',
  extracting: 'Extracting', installing: 'Installing', initializing: 'Initialising', starting: 'Starting',
  completed: 'Completed', failed: 'Failed', paused: 'Paused', cancelled: 'Cancelled',
  awaiting_confirmation: 'Waiting for installation confirmation',
};

function announceSysTask(task, previous, force = false) {
  const live = $('sysTaskAnnouncement');
  if (!live || !task) return;
  const phaseChanged = !previous || task.status !== previous.status;
  const errorChanged = !!task.error && task.error !== previous?.error;
  if (!force && !phaseChanged && !errorChanged) return;
  const system = (sysUI.data?.systems || []).find((item) => item.id === task.systemId);
  const english = window.apkI18n?.lang === 'en-US';
  const translate = (text) => window.apkI18n?.translateOne(text) || text;
  const name = translate(system?.name || task.systemId);
  const label = english
    ? (SYS_STATUS_ANNOUNCEMENT_EN[task.status] || translate(SYS_STATUS_LABEL[task.status] || task.status || '状态已更新'))
    : (SYS_STATUS_LABEL[task.status] || task.status || '状态已更新');
  const error = task.error ? `, ${translate(task.error)}` : '';
  live.textContent = english ? `${name}: ${label}${error}` : `${name}：${label}${task.error ? `，${task.error}` : ''}`;
}

function refreshSysTaskAnnouncement() {
  const task = sysUI.tasks.find((item) => item.taskId === sysUI.lastAnnouncedTaskId);
  if (task) announceSysTask(task, task, true);
}

function renderSysTasks() {
  const wrap = $('sysTaskWrap');
  const list = $('sysTaskList');
  if (!wrap || !list) return;
  const tasks = sysUI.tasks || [];
  if (!tasks.length) {
    if (list.contains(document.activeElement)) a11y.focus($('setTitle'));
    sysTaskAnnouncements.clear();
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const taskIds = new Set(tasks.map((task) => task.taskId));
  for (const taskId of sysTaskAnnouncements.keys()) {
    if (!taskIds.has(taskId)) sysTaskAnnouncements.delete(taskId);
  }
  const html = tasks.map((t) => {
    const name = (sysUI.data && (sysUI.data.systems || []).find((s) => s.id === t.systemId)) || {};
    const running = ACTIVE_TASK_STATUS.includes(t.status);
    const statusCls = t.status === 'failed' ? 'err' : t.status === 'completed' ? 'ok' : running ? 'running' : '';
    const meta = [
      `<span>下载：<b>${esc(fmtSize(t.downloadedBytes))}${t.totalBytes ? ' / ' + esc(fmtSize(t.totalBytes)) : ''}</b></span>`,
      `<span>速度：<b>${esc(fmtSpeed(t.speed))}</b></span>`,
      `<span>剩余：<b>${esc(fmtEta(t.eta))}</b></span>`,
      `<span>阶段：<b>${esc(SYS_STATUS_LABEL[t.status] || t.status)}</b></span>`,
    ].join('');
    const actions = [];
    const action = (kind, label, cls = 'ghost') => `<button type="button" class="btn ${cls} sm" data-tact="${kind}" data-tid="${esc(t.taskId)}" data-focus-key="task:${esc(t.taskId)}:${kind}" ${kind === 'cancel' ? 'title="仅取消任务，不停止安装器，也不删除系统数据"' : ''} ${sysUI.taskBusy.has(t.taskId) ? 'aria-disabled="true" aria-busy="true"' : ''}>${label}</button>`;
    if (t.status === 'paused') actions.push(action('resume', '继续'));
    if (t.status === 'awaiting_confirmation') actions.push(action('confirmInstall', '确认安装完成', 'primary'));
    if (['downloading', 'preparing', 'verifying', 'installing'].includes(t.status)) actions.push(action('pause', '暂停'));
    if (running || t.status === 'paused') actions.push(action('cancel', '取消任务'));
    if (t.status === 'failed') actions.push(action('retry', '重试'));
    actions.push(`<button type="button" class="btn ghost sm" data-tact="openDir" data-tid="${esc(t.taskId)}" data-sid="${esc(t.systemId)}" data-focus-key="task:${esc(t.taskId)}:openDir">打开目录</button>`);
    const progress = Math.max(0, Math.min(100, Number(t.progress) || 0));
    return `<div class="sys-task-item" data-task="${esc(t.taskId)}" role="listitem">
      <div class="sys-task-top">
        <span class="sys-task-sys">${esc(name.name || t.systemId)}</span>
        <span class="sys-task-ver">${esc(t.systemVersion || '')}</span>
        <span class="sys-task-status ${statusCls}">${esc(SYS_STATUS_LABEL[t.status] || t.status)}</span>
      </div>
      <div class="sys-task-step">${esc(t.currentStep || '')}${t.error ? ' · ' + esc(t.error) : ''}</div>
      <div class="sys-task-bar" role="progressbar" aria-label="${esc(name.name || t.systemId)} 下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div>
      <div class="sys-task-meta">${meta}</div>
      <div class="sys-task-actions">${actions.join('')}</div>
    </div>`;
  }).join('');
  a11y.replace(list, html, () => $('btnSysTaskRefresh'));
}

async function loadSystemsSnapshot() {
  // system:task 可能在目录/任务快照 IPC 之间到达，先暂存推送，避免快照把新任务抹掉。
  const pushes = new Map();
  sysUI.snapshotPushes = pushes;
  const catalogTime = $('sysCatalogTime');
  try {
    const r = await api.systemList();
    if (r && r.ok) { sysUI.data = r; sysUI.error = ''; }
    else {
      sysUI.data = null;
      sysUI.error = (r && r.error) || '暂时无法读取系统目录';
    }
    const tr = await api.systemTasks().catch(() => null);
    await refreshStatus();
    if (tr?.ok && Array.isArray(tr.tasks)) {
      const snapshotIds = new Set(tr.tasks.map((t) => t.taskId));
      const omitted = tr.tasks.length >= SYS_TASK_LIMIT
        ? sysUI.tasks.filter((t) => liveSysTask(t) && !snapshotIds.has(t.taskId)) : [];
      sysUI.tasks = mergeSysTasks([...tr.tasks, ...omitted], [...pushes.values()]);
    }
    renderSysCards();
    renderSysDetail();
    renderSysTasks();
    scheduleSysLogs();
  } catch (e) {
    sysUI.data = null;
    sysUI.error = e && e.message || '暂时无法读取系统目录';
    renderSysCards();
    renderSysDetail();
  } finally {
    sysUI.snapshotPushes = null;
    if (sysUI.error && catalogTime) catalogTime.textContent = '读取系统目录失败';
  }
}

async function loadSystems() {
  if (sysUI.loading) {
    // Keep mutations/reopens from being lost behind an older in-flight snapshot.
    sysUI.reloadPending = true;
    return sysUI.loadPromise;
  }
  sysUI.loading = true;
  const cards = $('sysCards');
  cards?.setAttribute('aria-busy', 'true');
  if (!sysUI.data && cards) a11y.replace(cards, '<div class="sys-loading" role="status">正在读取系统目录…</div>', () => $('setTitle'));
  const catalogTime = $('sysCatalogTime');
  if (catalogTime) catalogTime.textContent = '正在读取系统目录…';
  sysUI.loadPromise = (async () => {
    do {
      sysUI.reloadPending = false;
      await loadSystemsSnapshot();
    } while (sysUI.reloadPending);
  })();
  try {
    await sysUI.loadPromise;
  } finally {
    sysUI.loading = false;
    sysUI.loadPromise = null;
    cards?.setAttribute('aria-busy', 'false');
  }
}

async function sysDoAction(systemId, act, taskId) {
  if (act === 'stop') return sysStopCurrent();
  if (act === 'switch') return sysSwitchSystem(systemId);
  if (act === 'resume' || act === 'retry') {
    const t = sysUI.tasks.find((t) => t.systemId === systemId && t.taskId === taskId);
    if (!t) { await loadSystems(); return; }
    return sysTaskAction(t.taskId, act);
  }
  let r;
  if (act === 'download' || act === 'install') {
    r = await api.systemInstall(systemId).catch((e) => ({ ok: false, error: e.message }));
    if (r?.ok) toast({ title: r.reused ? '已存在系统任务' : '已提交安装任务', body: '请在「运行状态」查看任务进度或继续暂停的任务。', type: 'info' });
    else toast({ title: '安装未开始', body: r?.error || '请检查系统状态后重试', type: 'error' });
  } else if (act === 'import') {
    r = await api.systemImportLineage();
    if (r && r.ok) toast({ title: '导入成功', body: 'LineageOS AVD 镜像已纳入管理', type: 'ok' });
    else if (r && !r.cancelled) toast({ title: '导入失败', body: r.error || '未知错误', type: 'error' });
  } else if (act === 'detail' || act === 'openDir') {
    sysUI.selected = systemId;
    renderSysCards();
    renderSysDetail();
    scheduleSysLogs();
    if (act === 'openDir') await api.systemOpenDir({ systemId, which: 'data' });
  } else if (act === 'custom') {
    // 自定义镜像仍走原有的 image:* 入口（设置 → 高级）
    toast({ title: '自定义镜像', body: '请在「设置 → 高级 → 自定义系统镜像」导入并启用', type: 'info' });
  } else if (act === 'progress') {
    openSettingsSection('runtime');
    const row = [...$('sysTaskList').querySelectorAll('[data-task]')].find((el) => el.dataset.task === taskId);
    a11y.focus(row?.querySelector('button') || $('btnSysTaskRefresh') || $('setTitle'));
    a11y.scroll(row || $('sysTaskWrap'));
  }
  await loadSystems();
  return r;
}

async function sysTaskAction(tid, act) {
  const task = sysUI.tasks.find((t) => t.taskId === tid);
  if (!task) return;
  const operations = {
    pause: api.systemPause, resume: api.systemResume, cancel: api.systemCancel,
    retry: api.systemRetry, confirmInstall: api.systemConfirmInstall,
  };
  const openDir = act === 'openDir';
  if (!openDir && (!Object.hasOwn(operations, act) || sysUI.taskBusy.has(tid))) return;
  if (!openDir) {
    sysUI.taskBusy.add(tid);
    renderSysCards();
    renderSysTasks();
  }
  try {
    const r = openDir ? await api.systemOpenDir({ systemId: task.systemId, which: 'downloads' }) : await operations[act](tid);
    if (!r?.ok && !r?.cancelled) throw new Error(r?.error || '请稍后重试。');
    if (r?.ok && act === 'cancel') toast({ title: '任务已取消', body: '仅取消任务，不停止安装器，也不删除系统数据', type: 'info' });
    if (!openDir) await loadSystems();
  } catch (e) {
    toast({ title: '操作失败', body: e?.message || '请稍后重试。', type: 'error' });
  } finally {
    if (!openDir) {
      sysUI.taskBusy.delete(tid);
      renderSysCards();
      renderSysTasks();
    }
  }
}

function pollSystems() {
  if (!systemPanelVisible() || sysUI.loading) return Promise.resolve(false);
  return loadSystems();
}

function bindSystems() {
  if (sysUI.bound) return;
  sysUI.bound = true;
  const cards = $('sysCards');
  if (cards) {
    cards.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn?.dataset.act === 'retryCatalog') { loadSystems(); return; }
      const card = e.target.closest('.sys-card');
      if (!card) return;
      const id = card.getAttribute('data-sys');
      if (btn && btn.dataset.act !== 'select') {
        if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          e.stopPropagation();
          sysDoAction(id, btn.dataset.act, btn.dataset.tid).catch((e) => {
            toast({ title: '操作失败', body: e?.message || '请稍后重试。', type: 'error' });
          });
        }
        return;
      }
      sysUI.selected = id;
      renderSysCards();
      renderSysDetail();
      scheduleSysLogs();
    });
  }
  const detail = $('sysDetail');
  if (detail) {
    detail.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-dact]');
      if (!b || !sysUI.selected) return;
      const act = b.getAttribute('data-dact');
      const id = sysUI.selected;
      try {
        if (act === 'import') { await sysDoAction(id, 'import'); return; }
        let r;
        if (act === 'openDir') r = await api.systemOpenDir({ systemId: id, which: 'data' });
        else if (act === 'refresh') r = await api.systemCatalogRefresh();
        else if (act === 'backup') r = await api.systemBackup({ systemId: id });
        else if (act === 'remove') r = await api.systemRemove(id);
        else return;
        if (r?.cancelled) return;
        if (!r?.ok) throw new Error(r?.error || '请稍后重试。');
        if (act === 'refresh') {
          await loadSystems();
          if (r.error || r.stale) toast({ title: '无法刷新远程目录', body: r.error || '当前使用缓存目录。', type: 'warn' });
          else if (!sysUI.error) toast({ title: '目录已刷新', type: 'ok' });
        } else if (act === 'backup') toast({ title: '备份完成', type: 'ok' });
        else if (act === 'remove') {
          toast({ title: '已删除', body: id + ' 的系统文件已移除', type: 'ok' });
          await loadSystems();
        }
      } catch (e) {
        const titles = { refresh: '刷新目录失败', backup: '备份失败', remove: '删除失败', openDir: '打开目录失败', import: '导入失败' };
        toast({ title: titles[act] || '操作失败', body: e?.message || '请稍后重试。', type: 'error' });
      }
    });
  }
  const taskList = $('sysTaskList');
  if (taskList) taskList.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tact]');
    if (!b) return;
    sysTaskAction(b.getAttribute('data-tid'), b.getAttribute('data-tact'));
  });
  const rf = $('btnSysTaskRefresh');
  if (rf) rf.addEventListener('click', loadSystems);

  if (api.on) {
    api.on('system:task', (task) => {
      if (!task || !task.taskId) return;
      if (sysUI.snapshotPushes) {
        const pending = sysUI.snapshotPushes.get(task.taskId);
        if (!pending || (task.updatedAt || '') >= (pending.updatedAt || '')) sysUI.snapshotPushes.set(task.taskId, task);
      }
      const previous = sysTaskAnnouncements.get(task.taskId)
        || sysUI.tasks.find((item) => item.taskId === task.taskId);
      const current = sysUI.tasks.find((item) => item.taskId === task.taskId);
      const isCurrent = !current || (task.updatedAt || '') >= (current.updatedAt || '');
      if (isCurrent) {
        announceSysTask(task, previous);
        sysUI.lastAnnouncedTaskId = task.taskId;
      }
      sysUI.tasks = mergeSysTasks(sysUI.tasks, [task]);
      if (isCurrent) sysTaskAnnouncements.set(task.taskId, { status: task.status, error: task.error || '' });
      renderSysCards();
      renderSysTasks();
    });
    api.on('system:log', scheduleSysLogs);
  }
  setInterval(pollSystems, 12000);
}

/* ---------------- 环境自检 ---------------- */

let envBusy = false;

/** 拉取 doctor:selfCheck：把问题渲染到设置里的自检面板，并在状态条上留一个计数 */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* 自检失败不阻断主流程 */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // 「组件缺失」在同一个面板的一键完成里已经覆盖，不再重复列出
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // 主界面不再放横幅：只在底部状态条上留一个可点的计数，点开就是设置里的自检面板
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} 项待修复` : `${issues.length} 项提示`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>环境自检通过，没有发现会影响运行的问题。</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">重新检查</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">环境自检</span>
      ${errs ? `<span class="ec-count">${errs} 个严重</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} 个提示</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">重新检查</button>
      <button class="btn primary sm" id="btnEnvFixAll">一键修复全部</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">修复</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

/** 设置页「硬件加速」状态：只读探测（带缓存），失败也不能挡住设置页 */
async function refreshAccelStatus() {
  const el = $('accelStatusText');
  if (!el) return;
  const r = await api.accelStatus().catch(() => null);
  const a = r && r.accel;
  if (!r || !a) { el.textContent = '无法检测硬件加速状态'; return; }
  const kindName = ({ whpx: 'WHPX', aehd: 'AEHD', kvm: 'KVM' })[a.kind] || '硬件加速';
  // suspect：驱动文件在、检查也过，但服务根本没跑。这种状态在本机「点开应用直接退出」，
  // 设置页必须提前说清楚，不能只显示一个绿色的「已启用」。
  if (a.ok && a.suspect) {
    el.textContent = `已启用 · ${kindName}（驱动服务未运行，可能开不了机）`;
    el.title = [a.note, a.advice].filter(Boolean).join('\n');
    return;
  }
  el.textContent = a.ok
    ? `已启用 · ${kindName}`
    : '未启用 · 当前是纯软件模拟（开机慢，可能直接崩）';
}

/**
 * 一键开启硬件加速：设置页按钮与环境自检的「修复」共用一套提示。
 * 主要由主进程决定走 WHPX 还是 AEHD；这里负责把「要重启」「BIOS 还没开」
 * 这两件真正影响结果的事说清楚。
 */
async function runEnableVirtualization() {
  const t = toast({ title: '正在开启硬件加速…', body: '请在弹出的窗口点「是」', sticky: true, spinner: true });
  const r = await api.enableVirtualization().catch(() => ({ ok: false }));
  if (r.ok) {
    const biosPending = r.firmwareEnabled === false;
    t.update({
      title: biosPending ? '还需在 BIOS 开启虚拟化' : '硬件加速已启用',
      body: biosPending
        ? '系统功能已开启，但 BIOS 里的 SVM / VT-x 还没打开。请重启进 BIOS 开启，再回 Windows 重启一次。'
        : (r.restartNeeded ? '已开启，请重启电脑后生效。' : (r.note || '已生效')),
      type: 'ok', sticky: true,
    });
  } else {
    t.update({
      title: '未能自动开启',
      body: `${r.error || r.note || '请重试。'}也可以点「打开 Windows 功能」手动勾选；弹窗要点「是」才会执行。`,
      type: 'error', sticky: true,
    });
  }
  setTimeout(refreshAccelStatus, 800);
  setTimeout(selfCheck, 1000);
  return r;
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: '未找到内置安装包', body: '已打开微软官方下载页，请下载 x64 版本', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'VC++ 运行库已安装', type: 'ok' }
        : { title: '安装未完成', body: r.error || '请重试', type: 'error' });
      break;
    }
    case 'virtualization': {
      await runEnableVirtualization();
      break;
    }
    case 'disk': {
      // 主进程会弹出原生确认框（含可释放空间预览），这里不再重复 confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: '清理失败', body: '请重试', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: '清理完成', body: `释放约 ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: '建议改到纯英文目录', body: '在 设置 → 系统集成 里修改「运行时数据目录」，再重启软件。', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: '正在补齐缺失的运行时组件…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: '已清理残留锁文件', type: 'ok' } : { title: '清理失败', body: r.error, type: 'error' });
      break;
    }
    default:
      toast({ title: '暂不支持自动修复', body: issue.hint || '', type: 'info' });
  }
  // 修复后重新自检，刷新横幅与状态
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

/* ---------------- 一键修复 ---------------- */

/**
 * 开机失败时弹这个窗：一句结论 + 体检表 + 能点的按钮。
 * 修不了的时候（CPU 太老、Windows 7、内存太小）就把「为什么」摊开讲清楚，
 * 而不是丢一句「CPU 缺少指令集」让用户去换系统镜像 —— 那条路永远走不通。
 */
let repairPlan = null;
let repairRunning = false;

const REPAIR_BADGE = {
  blocked: { text: '这台机器跑不了', cls: 'bad' },
  slow: { text: '能修，但会慢', cls: 'warn' },
  auto: { text: '可以自动修复', cls: 'ok' },
};

async function openRepair(started) {
  // 组件还没装（首次部署没走完）不是「开机失败」，别用修复窗口盖住部署引导
  if (started && started.needsSetup) {
    toast({ title: '还差运行时组件', body: '请在「设置 → 运行时」里点「一键完成」把组件补齐。', type: 'info', sticky: true });
    return;
  }
  if (repairRunning) return;
  const opener = menuOpener || a11y.bookmark();
  const plan = await api.repairPlan().catch(() => null);
  if (!plan) {
    const msg = started && (started.message || started.error);
    if (msg) toast({ title: '开机未完成', body: msg, type: 'error', sticky: true });
    return;
  }
  if (repairRunning) return;
  hideMenu(false);
  renderRepairPlan(started?.reportDraft ? { ...plan, reportDraft: started.reportDraft } : plan);
  a11y.open($('repairMask'), { opener });
}

/** 把方案画出来（也用于「单独执行一条」之后刷新状态） */
function renderRepairPlan(plan) {
  repairPlan = plan;
  const badge = REPAIR_BADGE[plan.level] || REPAIR_BADGE.auto;
  const badgeEl = $('repairBadge');
  badgeEl.textContent = badge.text;
  badgeEl.className = `repair-badge ${badge.cls}`;
  $('repairTitle').textContent = plan.level === 'blocked' ? '为什么这台电脑跑不了' : '运行不起来的解决办法';
  $('repairHeadline').textContent = plan.headline || plan.title || '';
  $('repairChecks').innerHTML = (plan.checks || []).map((c) => `
    <div class="repair-check ${esc(c.state || '')}">
      <span class="rc-label">${esc(c.label)}</span>
      <span class="rc-value">${esc(c.value)}</span>
    </div>`).join('');
  // 程序已经自动做过什么：不写出来的话，用户会以为「什么都没试」，重复点一遍白等
  const autoEl = $('repairAuto');
  if (autoEl) {
    const tried = plan.autoTried || [];
    autoEl.hidden = !tried.length;
    autoEl.textContent = tried.length
      ? `启动失败后程序已经自动处理：${tried.join('、')}。`
        + '如果这次仍没起来，说明问题不在这里，点下面的动作即可。'
      : '';
  }
  renderRepairActions(plan);
  // 报告是自动生成的（脱敏、只落本机）：说清楚它已经在哪、什么时候发出去由用户决定
  const draft = $('repairDraft');
  if (draft) {
    const info = plan.reportDraft || {};
    const has = !!info.file;
    draft.hidden = !has;
    let text = '';
    if (has) {
      if (info.sent) {
        // 自动上报只带机器信息、加速状态和尝试记录，不含日志末尾，别把范围说大。
        text = '失败报告摘要已自动上报给配置的收集接口（已脱敏）：作者会收到机器信息、加速状态和尝试记录，不含日志末尾。';
      } else if (info.skipped === 'uncertain') {
        text = '上一次自动上报的结果不确定，可能已经被接收；为避免重复，这次没有重发。摘要已保存在本机。';
      } else if (info.skipped === 'recent') {
        text = '这份失败报告 24 小时内已经自动上报过，这次没有重复发送。摘要已保存在本机。';
      } else if (info.skipped === 'receipt-error' || info.sendError) {
        text = '自动上报没有完成，摘要已保存在本机：' + (info.sendError || '投递回执无法读写，已停止自动上报。');
      } else {
        text = '失败报告已自动生成并保存在本机（路径里的用户名已替换为 %USERPROFILE%）。点「上报给作者」才会发送。';
      }
    }
    draft.textContent = text;
  }
  $('repairWhy').innerHTML = (plan.why || []).map((t) => `<p>${esc(t)}</p>`).join('');
  // 跑不了的情况，默认就把原因摊开；能修的先收起，别让人一上来读六百字
  $('repairWhy').hidden = plan.level !== 'blocked';
  updateRepairWhyButton();
  const steps = $('repairSteps');
  steps.hidden = true;
  steps.innerHTML = '';
  const btn = $('repairRunBtn');
  btn.disabled = false;
  btn.textContent = plan.canAutoFix ? '一键修复并重试' : '仍然尝试一次';
  $('repairLaterBtn').disabled = false;
}

/**
 * 逐条列出修复动作。
 * 「一键修复」只会自动跑 kind=auto 的那几条；开 Hyper-V、重下镜像这种
 * 需要 UAC 或动数据的事，用户想单独做时点右边的按钮，不会被一键流程替做决定。
 */
function renderRepairActions(plan) {
  const box = $('repairActions');
  if (!box) return;
  const acts = plan.actions || [];
  if (!acts.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = acts.map((a) => `
    <div class="repair-action ${esc(a.kind || '')}">
      <div class="ra-body">
        <div class="ra-label">${esc(a.label)}${a.kind === 'auto' ? '<span class="ra-tag">随一键修复执行</span>' : ''}</div>
        ${a.hint ? `<div class="ra-hint">${esc(a.hint)}</div>` : ''}
      </div>
      <button class="btn ghost sm ra-run" data-id="${esc(a.id)}">执行</button>
    </div>`).join('');
  box.querySelectorAll('.ra-run').forEach((b) => {
    b.addEventListener('click', () => runSingleRepair(b.dataset.id));
  });
}

/** 单独执行一条修复动作（会动数据的仍由主进程弹原生确认框） */
async function runSingleRepair(id) {
  if (repairRunning) return;
  const act = (repairPlan && repairPlan.actions || []).find((a) => a.id === id);
  const label = act ? act.label : '修复动作';
  const t = toast({ title: `正在执行：${label}`, sticky: true, spinner: true });
  const r = await api.repairRun({ action: id }).catch((e) => ({ ok: false, error: e.message }));
  const step = (r.steps || [])[0] || {};
  const ok = step.ok !== false && r.ok !== false;
  t.update({
    title: ok ? '已完成' : '未完成',
    body: step.detail || r.error || (ok ? '' : '可以导出诊断报告发给我'),
    type: ok ? 'ok' : 'error',
    sticky: !ok,
  });
  if (ok && id !== 'report') setTimeout(t.dismiss, 3200);
  const fresh = await api.repairPlan().catch(() => null);
  if (fresh) renderRepairPlan(fresh);
}

function closeRepair() {
  if (!repairRunning) a11y.close($('repairMask'));
}

function updateRepairWhyButton() {
  const expanded = !$('repairWhy').hidden;
  const btn = $('repairWhyBtn');
  btn.setAttribute('aria-expanded', String(expanded));
  setText(btn, expanded ? '收起说明' : '为什么跑不了');
}

/** 一键修复：跑自动动作 → 关窗 → 用低配参数重新开机 → 失败就再弹回来 */
async function runRepair() {
  const plan = repairPlan;
  if (!plan || repairRunning) return;
  repairRunning = true;
  const btn = $('repairRunBtn');
  const later = $('repairLaterBtn');
  const close = $('repairCloseBtn');
  btn.disabled = later.disabled = close.disabled = true;
  a11y.focus($('repairTitle'));
  btn.textContent = '正在修复…';
  const box = $('repairSteps');
  box.hidden = false;
  box.innerHTML = '';
  const line = (text, cls) => {
    const d = document.createElement('div');
    d.className = `rs-line${cls ? ` ${cls}` : ''}`;
    d.textContent = text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  };
  line('正在执行修复动作…', 'run');
  const r = await api.repairRun({ action: 'auto' }).catch((e) => ({ ok: false, steps: [], error: e.message })) || {};
  repairRunning = false;
  close.disabled = false;
  box.innerHTML = '';
  (r.steps || []).forEach((st) => line(`${st.ok ? '✓' : '✕'} ${st.label}${st.detail ? ` — ${st.detail}` : ''}`, st.ok ? 'ok' : 'bad'));
  if (r.empty) line('这套问题没有可自动执行的动作，直接换低配参数再试一次。', 'run');
  // 开启硬件加速要重启才生效：别在这里立刻重试，那只会再崩一次还白等十几分钟
  if (r.retry && r.retry.needsReboot) {
    closeRepair();
    toast({
      title: '请重启电脑后生效',
      body: '硬件加速功能已经开启。重启电脑再打开应用，安卓就会走硬件加速，不再崩在软件模拟上。',
      type: 'info', sticky: true,
    });
    return;
  }

  const retry = r.retry || plan.retry || {};
  closeRepair();
  const t = toast({
    title: retry.lowspec ? '正在以低配模式重新开机…' : '正在重新开机…',
    body: '这台机器可能比较慢，最多需要 15 分钟；期间可以先做别的事，不用等在这里。',
    sticky: true,
    spinner: true,
  });
  const started = await api.runtimeStart({
    lowspec: !!retry.lowspec,
    timeoutMs: Number(retry.timeoutMs) || 0,
  }).catch((e) => ({ ok: false, error: e.message }));
  await refreshStatus();
  if (started && started.ok) {
    t.update({ title: '已经开起来了', body: '现在可以把 APK 拖进窗口，或双击桌面图标。', type: 'ok' });
    setTimeout(t.dismiss, 4000);
    return;
  }
  t.update({ title: '还是没起来', body: '这次的结果已记进诊断报告，可以点「查看原因」换个办法。', type: 'error', sticky: true });
  setTimeout(() => openRepair(started), 400);
}

function bindRepairUI() {
  const run = $('repairRunBtn');
  if (!run) return;
  run.addEventListener('click', runRepair);
  $('repairCloseBtn').addEventListener('click', closeRepair);
  $('repairLaterBtn').addEventListener('click', closeRepair);
  $('repairMask').addEventListener('click', (e) => { if (e.target === $('repairMask')) closeRepair(); });
  $('repairWhyBtn').addEventListener('click', () => {
    const why = $('repairWhy');
    why.hidden = !why.hidden;
    updateRepairWhyButton();
  });
  const exportBtn = $('repairExportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      api.doctorReport().catch(() => toast({ title: '导出失败', body: '请稍后再试', type: 'error' }));
    });
  }
  const sendBtn = $('repairSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', sendFailureReport);
}

/**
 * 上报失败报告。
 * 主进程先显示预览，用户确认后才发送摘要或打开 GitHub 提交页。
 */
async function sendFailureReport() {
  const t = toast({ title: '正在准备失败报告…', sticky: true, spinner: true });
  const r = await api.reportSubmit().catch((e) => ({ ok: false, error: e.message }));
  if (!r || r.ok === false) {
    if (r && r.cancelled) { t.dismiss(); return; }
    t.update({ title: '上报未完成', body: (r && r.error) || '请稍后重试', type: 'error', sticky: true });
    return;
  }
  if (r.channel === 'endpoint') {
    t.update({ title: '摘要已发送', body: '报告已发送给作者，感谢反馈。', type: 'ok' });
  } else if (r.channel === 'local') {
    t.update({ title: '已导出报告', body: '文件已在资源管理器中打开，可手动发给我。', type: 'ok' });
  } else {
    t.update({ title: '已打开提交页', body: '摘要已复制到剪贴板，点页面上的「Submit new issue」即可。', type: 'ok' });
  }
  setTimeout(() => t.dismiss(), 4200);
}

bindRepairUI();

/** 安装/开机失败时，判断要不要给修复入口 */
function maybeOpenRepair(message) {
  const msg = String(message || '');
  if (!/运行时.*(未能启动|开不完|启动失败)|CPU 缺少|开机未完成|device offline|no devices\/emulators/i.test(msg)) return false;
  setTimeout(() => openRepair(null), 500);
  return true;
}

/**
 * 界面语言（upstream #38）：先取语言与词典，再渲染界面 —— 否则会先闪一屏中文。
 * 取不到（IPC 异常 / i18n.js 没加载）就按中文继续，界面不能因为翻译而打不开。
 */
async function initI18n() {
  try {
    if (!window.apkI18n || !api.i18n) return;
    const payload = await api.i18n();
    window.apkI18n.apply(payload);
  } catch (_) { /* 回落中文 */ }
}

init().catch((e) => {
  console.error(e);
  toast({ title: '初始化失败', body: e.message, type: 'error', sticky: true });
});

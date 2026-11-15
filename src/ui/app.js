'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
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
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? '首次使用：打开右上角设置 → 运行时 → 一键完成，再回来安装应用即可。'
      : '提示：所有应用共享同一个 Android 运行时，所以第二个应用的启动几乎是瞬时的。';
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="正在运行"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? '运行中' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? '切换到前台' : '打开'}</div>
    </div>
  `).join('');
}

/* ---------------- 数据刷新 ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} 个应用` : '暂无应用';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
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
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `状态检查失败：${e.message}`;
  }
}

/* ---------------- 运行时部署（固定在设置里） ---------------- */

/**
 * 运行时/部署/自检面板现在都收在「设置」里，主界面只留已安装应用。
 * 保留 showSetup 给托盘菜单与 ui:navigate 复用，语义改为「打开设置并定位到运行时」。
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    const box = $('runtimeGroup');
    if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(() => {});
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
    stateText.textContent = s.deviceOnline
      ? `已就绪 · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? '正在引导 Android…'
        : allDone0
          ? '组件齐全 · 待开机（打开应用时自动拉起）'
          : `缺少 ${missing.join('、')}${accelOk ? '' : '（无硬件加速，将回退软件模拟）'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
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
    title: allDone ? '一切就绪' : '一键完成',
    tag: allDone ? '已自动完成' : '自动',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} 已就绪 · 应用窗口会按屏幕自动适配`
      : booting
        ? '正在引导 Android…'
        : allDone
          ? '组件齐全，双击任意 APK 或桌面图标即会自动开机'
          : `还差 ${left.join('、')}；点下面「一键完成」，会在后台一次装好并自动开机`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">停止运行时</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
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
  box.appendChild(line);
  // 长会话防膨胀：最多保留 400 行
  while (box.children.length > 400) box.removeChild(box.firstChild);
  wrap.hidden = false;
  box.scrollTop = box.scrollHeight;
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  appendDeployLog({ stage: 'info', message: '—— 开始部署运行时（手动触发）——' });
  try {
    // 一次调用把 adb / 引擎 / 系统镜像全装完，进度统一显示在唯一那一行
    const r = await api.autoDeploy();
    if (!r || !r.ok) {
      appendDeployLog({ stage: 'error', message: `部署失败：${(r && r.error) || '请检查网络后重试'}` });
      toast({ title: '准备失败', body: (r && r.error) || '请检查网络后重试', type: 'error', sticky: true });
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
        title: '正在安装硬件加速驱动…',
        body: '请在弹出的是否允许窗口点「是」',
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
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: '安装完成，运行时已接管', body: '现在可以直接把 APK 拖进来安装了。', type: 'ok' });
}



/* ---------------- 安装 ---------------- */

/** 把安装失败翻译成「下一步该做什么」，只对最常见的几种做提示，其它原样显示 */
function friendlyInstallErrorText(msg) {
  const s = String(msg || '未知错误');
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

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: '已有安装任务在进行', body: '请等当前应用装完再继续。' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    // 装之前先做兼容性检查：只有「基本兼容」以上才直接装；
    // 明确有问题的（架构不匹配、系统版本不够、拆分分片）先问用户一句，
    // 让他在装之前就知道「大概率打不开」，而不是装完再猜为什么。
    let comp = null;
    try { comp = (await api.compatApk(p)).compat; } catch (_) { comp = null; }
    if (comp && (comp.level === 'risky' || comp.level === 'unsupported')) {
      const why = comp.reasons.filter((r) => r.kind !== 'info').map((r) => `• ${r.text}`).join('\n');
      const { response } = await api.confirm({
        type: 'warning',
        title: `${name}：${comp.label}`,
        message: '安装前的兼容性检查发现这个包可能跑不起来。',
        detail: `${why}\n\n评估环境：${comp.env.source}\n\n仍然要继续安装吗？`,
        okLabel: '仍然安装',
        danger: true,
      });
      if (response !== 1) { skipped += 1; continue; }
    } else if (comp && comp.level === 'partial') {
      const why = comp.reasons.filter((r) => r.kind === 'warn').map((r) => r.text).join(' ');
      if (why) toast({ title: `${name}：${comp.label}`, body: why, type: 'warn' });
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
      t.update({ title: `${r.app.label} 已安装`, body: r.app.shortcutPath ? '桌面快捷方式已创建，双击即可直接打开。' : '可在应用卡片右键创建桌面快捷方式。', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} 兼容性提示`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // 先把那条「正在安装…」的 sticky 提示收掉，否则它会一直转圈、还继续被
      // 运行时日志刷新 —— 用户看到的就是「失败信息一直在循环」。
      // 错误提示统一由下面的 install:error 监听器负责（带文件名与中文原因），
      // 这里不再重复弹一条。
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
  // 用户因为兼容性提示主动取消的，给一句明确回执，避免「点了安装却什么都没发生」
  if (skipped) toast({ title: `已跳过 ${skipped} 个安装`, body: '兼容性检查未通过，按你的选择没有继续安装。' });
}

/* ---------------- 应用操作 ---------------- */

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
    // 应用有自己的窗口，主界面自动收起；这里只留一句提示，然后隐藏窗口
    t.update({ title: '已启动', body: '应用正在独立窗口中运行（顶部可旋转屏幕）。', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: '启动失败', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
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

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  menu.innerHTML = MENU_ITEMS.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? '取消固定' : '固定到顶部') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
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

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = '读取中…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `运行时未就绪（${String(r.error).slice(0, 36)}）` : '运行时未启动';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi 已开' : 'Wi-Fi 已关'}` +
    `${r.airplane ? ' · 飞行模式' : ''} · 音量 ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
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
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), '音量已调整'), 260);
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

function fillSettings(s) {
  $('setEngineMode').value = s.engine.mode;
  $('setAdbPath').value = s.adbPath || '';
  $('setDevice').value = s.device || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGithubToken')) $('setGithubToken').value = (s.runtime && s.runtime.githubToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setProxyUrl')) $('setProxyUrl').value = (s.runtime && s.runtime.proxyUrl) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = s.engine.priorityMode === 'performance' ? 'performance' : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  if ($('setLanguage')) $('setLanguage').value = s.language || 'auto';
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  $('setPortrait').value = d.portrait || '900x1600';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** 数据分区实际大小 + 磁盘余量，显示在设置页容量选择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = '读取数据分区信息失败'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  const img = info.imageGB ? `${info.imageGB} GB` : '尚未创建';
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : '未知';
  el.textContent = `当前数据分区镜像：${img}${auto ? '（自动）' : ''} · 所在磁盘剩余 ${free}。`
    + '游戏提示「存储空间不足」就把这里调大后点「立即扩容」——扩容是就地做的，已装应用与存档都保留。';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? '已关联 · 点击取消' : '未关联 · 点击开启';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = '自动模式'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `共 ${u.totalText}${u.reclaimable ? ` · 可回收 ${u.reclaimableText}（${u.count} 项）` : ' · 已是精简状态'}`
      : '统计不可用';
  }).catch(() => { $('usageText').textContent = '统计不可用'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- 软件更新 ---------------- */

let lastUpdate = null;

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

  if (info.ok === false) {
    st.textContent = `检查失败：${info.error || '网络不可用'}`;
    showUpdateBtn(false);
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
    btn.textContent = info.asset ? '立即更新' : '打开下载页';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    // 更新日志 = 该版本的发布说明（GitHub Release body），完整展示（可滚动）
    const note = $('updateNote');
    if (note) {
      const body = String(info.notes || '').trim();
      if (body) {
        note.textContent = `更新日志（${info.tag}）：\n\n${body}`;
        note.classList.add('notes');
      } else {
        note.classList.remove('notes');
      }
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? '（离线缓存）' : '';
    st.textContent = `已是最新版本（v${info.current}）${src ? ` · 经由 ${src}` : ''}${stale}`;
    showUpdateBtn(false);
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
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
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
        if (info && info.hasUpdate) toast({ title: `发现新版本 ${info.tag}`, body: '点「立即更新」自动下载安装', type: 'info' });
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

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = '更新中…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = '立即更新';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `更新失败：${r.error}`;
        toast({ title: '更新失败', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `已下载 v${r.version}，正在重启完成安装…`;
    }
  });

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

function bindSettings() {
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
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // 资源策略会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: '资源策略已切换', body: '下一次打开应用生效', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: '先选一个容量', body: '「自动」表示由软件按磁盘余量决定，不需要扩容', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: '立刻把安卓数据分区扩容？',
        message: `将把 /data 调整为 ${gb} GB（就地扩容，已装应用和存档都会保留）。`,
        detail: '扩容需要先关掉正在运行的安卓应用，完成后下次打开应用会重新引导，约多花十几秒。',
        okLabel: '开始扩容',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = '扩容中…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? '数据分区已扩容' : '扩容失败',
        body: r && r.ok ? `现在约 ${r.imageGB || gb} GB 可用` : (r && r.error) || '未知错误',
      });
      refreshDataInfo();
    });
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
    $('setLanguage').addEventListener('change', async (e) => {
      try {
        state.settings = await api.setSettings({ language: e.target.value });
        const payload = await api.i18n();
        if (window.apkI18n) window.apkI18n.retranslate(payload);
      } catch (err) {
        toast({ title: '切换语言失败', body: err.message, type: 'error' });
      }
    });
  }
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
      if (!preview.candidates.length) {
        toast({ title: '已经是精简状态', body: '没有可回收的旧镜像或快照。', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
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

  // 重置安卓数据：二级确认（先确认意图，再确认不可撤销），清完刷新占用统计
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
        buttons: ['取消', '继续'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: '再确认一次',
        message: '已安装的 app 和它们的数据将被永久删除，确定要重置吗？',
        detail: '可放心的是：系统镜像、其它 AVD、本机的 APK 缓存和图标都不会动。',
        buttons: ['取消', '确定重置'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
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

  // 修复网络：安卓里联网页面一直黑屏（点「同意并继续」后整屏黑）时用。
  // 根因是虚拟机 /data 里的 Wi-Fi 配置坏了，wlan0 没起来、没有默认路由。
  // 镜像不允许 root，只能整体重置 /data；应用清单保留，点开时会自动重装。
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: '修复虚拟机网络？',
        message: '应用里需要联网的页面一直黑屏/转圈，通常是安卓虚拟机没有网络。',
        detail: '修复方式：重置安卓用户数据，让虚拟机重新获得网络。\n\n'
          + '• 应用清单会保留，点开应用会自动重装，不用手动装\n'
          + '• 应用内的登录态、追剧记录等运行时数据会丢失，需要重新登录\n'
          + '• 只影响当前 AVD，系统镜像和本机 APK 缓存都不动\n\n'
          + '整个过程约 30–90 秒（要重新冷启动一次）。是否继续？',
        buttons: ['取消', '开始修复'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: '网络仍未恢复',
          body: (r && r.error) || '重置后虚拟机还是没网，请检查本机网络/防火墙是否拦住了模拟器。',
          type: 'error',
        });
        return;
      }
      toast({
        title: '网络已恢复',
        body: `网关 ${(r.network && r.network.gateway) || '可达'}。点开应用会自动重装，联网页面不会再黑屏。`,
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

  // 一键卸载 ApkStart 本体（取消 .apk 关联 + 启动卸载程序；便携版手动删除）
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('确定卸载 ApkStart？\n\n将取消 .apk 文件关联并移除程序。此操作不可撤销。');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
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
    toast({ title: '正在卸载…', body: '卸载程序已启动，ApkStart 即将退出', type: 'ok', sticky: true });
  });

  // ARM 兼容镜像下载（带进度 toast）
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: '开始下载 ARM 兼容镜像', body: '准备中…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: '下载 ARM 兼容镜像', body: p.message || '', progress: p.percent });
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
    toast({ title: '数据目录已更新', body: '请重启 ApkStart 使其生效（旧数据不会自动搬移）', type: 'ok', sticky: true });
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

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = '已停止内置虚拟机';
    refreshStatus();
  });

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

  $('btnSettings').addEventListener('click', openSettings);
  // 状态标签也当入口：点「需要部署 / 引导中 / Android 14」直接进设置的运行时面板
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // 运行时部署：入口已收进设置，这里只处理面板内的按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  const clr = $('btnClearDeployLog');
  if (clr) clr.addEventListener('click', () => { const b = $('deployLog'); if (b) b.innerHTML = ''; });
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // 状态条上的自检计数：点开就是设置里的运行时面板
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else $('runtimeGroup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(() => {});
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
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: '运行时会话已结束' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // 共享目录入口移到设置里：同步 + 打开都在「文件互通」组内
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: '已同步共享目录', type: 'ok' });
    } catch (_) {
      toast({ title: '同步失败', body: '运行时未就绪时会跳过同步', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
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
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: '只能拖入 .apk 文件', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让「正在安装…」那条一直转圈（可能来自双击 APK 的另一条链路）
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    const body = friendlyInstallErrorText((p && p.message) || '未知错误');
    toast({
      title: name ? `安装失败：${name}` : '安装失败',
      body,
      type: 'error',
    });
    // 装不上常常只是「安卓还没起来」的下游症状：给修复入口，别让人对着安装失败发愣
    maybeOpenRepair(body);
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
  drives: [],
  selectedDrive: '',
  recommendedDrive: '',
  deploying: false,
  bar: 0,
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
  const bar = document.getElementById('wizardBar');
  const text = document.getElementById('wizardProgressText');
  if (bar) bar.style.width = `${wizard.bar.toFixed(1)}%`;
  if (text && p.message) text.textContent = p.message;
}

function wizardShowPage(n) {
  wizard.page = n;
  for (let i = 1; i <= 3; i += 1) {
    const el = document.getElementById(`wizardPage${i}`);
    if (el) el.hidden = i !== n;
  }
  const step = document.getElementById('wizardStep');
  const titles = { 1: '欢迎使用 ApkStart', 2: '选择安装位置', 3: '正在准备运行时' };
  if (step) step.textContent = `第 ${n} 步 / 共 3 步`;
  const title = document.getElementById('wizardTitle');
  if (title) title.textContent = titles[n] || 'ApkStart';
  const back = document.getElementById('wizardBack');
  const next = document.getElementById('wizardNext');
  const closeBtn = document.getElementById('wizardCloseBtn');
  if (back) back.hidden = n === 1;
  if (closeBtn) closeBtn.hidden = n !== 3;
  if (next) {
    next.hidden = false;
    next.textContent = n === 1 ? '下一步' : n === 2 ? '开始安装' : '完成';
    next.disabled = false;
  }
  const skip = document.getElementById('wizardSkip');
  if (skip) skip.hidden = n === 3 && wizard.deploying;
  // 第 3 页完成/失败态下「完成」才可点；部署中不允许点
  if (n === 3 && wizard.deploying && next) next.disabled = true;
  if (n === 3 && !wizard.deploying && next) {
    const okBox = document.getElementById('wizardDone');
    next.disabled = !(okBox && !okBox.hidden);
    next.textContent = okBox && !okBox.hidden ? '开始使用' : '返回修改';
  }
}

function wizardDirsPreview() {
  const box = document.getElementById('wizardDirs');
  if (!box) return;
  const drive = wizard.selectedDrive || '';
  const runtime = drive ? `${drive}\\ApkStart\\runtime` : '';
  const avd = drive ? `${drive}\\ApkStart\\avd` : '';
  box.innerHTML = ''
    + `<div>运行时（引擎 + 系统镜像）：<b>${esc(runtime || '未选择')}</b></div>`
    + `<div>安卓数据（应用、存档、快照）：<b>${esc(avd || '未选择')}</b></div>`;
}

function renderWizardDrives() {
  const box = document.getElementById('wizardDrives');
  if (!box) return;
  if (!wizard.drives.length) {
    box.innerHTML = '<div class="sub">未读取到可用磁盘（可以在设置里手动填路径）</div>';
    return;
  }
  box.innerHTML = wizard.drives.map((d) => {
    const freeGB = (d.free / 1073741824).toFixed(0);
    const totalGB = (d.total / 1073741824).toFixed(0);
    const sys = d.drive.toUpperCase() === String((state.settings && state.settings.__systemDrive) || 'C:').toUpperCase();
    const rec = d.drive === wizard.recommendedDrive;
    const pct = d.total ? Math.max(2, Math.round((d.free / d.total) * 100)) : 0;
    const low = d.free < 8 * 1073741824;
    return `<div class="drive-item${d.drive === wizard.selectedDrive ? ' on' : ''}" data-drive="${esc(d.drive)}" title="剩余 ${freeGB} GB / 共 ${totalGB} GB">`
      + `<div class="d-letter">${esc(d.drive)}${sys ? '<span class="d-tag sys">系统盘</span>' : ''}</div>`
      + `<div class="d-free">剩余 ${freeGB} GB（${pct}%）${rec ? '<span class="d-tag">推荐</span>' : ''}</div>`
      + `${low ? '<div class="d-free" style="color:#c23b3b">空间不足（需 8GB+）</div>' : ''}`
      + `</div>`;
  }).join('');
  for (const item of box.querySelectorAll('.drive-item')) {
    item.addEventListener('click', () => {
      wizard.selectedDrive = item.getAttribute('data-drive') || '';
      renderWizardDrives();
      wizardDirsPreview();
      // 选盘即保存：就算用户之后跳过向导，选择也已生效（改目录在部署前不需要重启）
      const drive = wizard.selectedDrive;
      if (drive) {
        api.setSettings({
          runtime: { dir: `${drive}\\ApkStart\\runtime`, avdDir: `${drive}\\ApkStart\\avd` },
        }).then((s) => { state.settings = s; }).catch(() => {});
      }
    });
  }
}

async function wizardStartDeploy() {
  const src = document.getElementById('wizardSource');
  if (src) {
    await api.setSettings({ runtime: { preferGithubRuntime: src.value !== 'official' } })
      .then((s) => { state.settings = s; }).catch(() => {});
  }
  wizard.deploying = true;
  wizard.bar = 0;
  wizardShowPage(3);
  const r = await api.autoDeploy().catch((e) => ({ ok: false, error: e.message }));
  wizard.deploying = false;
  const done = document.getElementById('wizardDone');
  const fail = document.getElementById('wizardFail');
  const failMsg = document.getElementById('wizardFailMsg');
  const bar = document.getElementById('wizardBar');
  const text = document.getElementById('wizardProgressText');
  if (r && r.ok) {
    if (bar) bar.style.width = '100%';
    if (text) text.textContent = '运行时已就绪';
    if (done) done.hidden = false;
    if (fail) fail.hidden = true;
  } else {
    if (failMsg) failMsg.textContent = `部署未完成：${(r && r.error) || '未知原因'}`;
    if (fail) fail.hidden = false;
    if (done) done.hidden = true;
  }
  wizardShowPage(3);
}

function wizardFinish() {
  api.setSettings({ wizardDone: true }).then((s) => { state.settings = s; }).catch(() => {});
  api.wizardClose().catch(() => {});
  const mask = document.getElementById('wizardMask');
  if (mask) mask.classList.remove('on');
  refreshStatus().catch(() => {});
}

async function bindWizard() {
  if (!document.getElementById('wizardMask')) return;
  document.getElementById('wizardSkip').addEventListener('click', wizardFinish);
  document.getElementById('wizardCloseBtn').addEventListener('click', wizardFinish);
  document.getElementById('wizardBack').addEventListener('click', () => wizardShowPage(wizard.page === 3 ? 2 : 1));
  document.getElementById('wizardNext').addEventListener('click', () => {
    if (wizard.page === 1) wizardShowPage(2);
    else if (wizard.page === 2) wizardStartDeploy();
    else wizardFinish();   // 完成态才可点（wizardShowPage 已控制 disabled）
  });
  api.on('provision:progress', (p) => wizardUpdateProgress(p));

  // 首次运行才弹：已完成向导、或运行时已经就绪（老用户升级）都不打扰
  const s = state.settings || {};
  if (s.wizardDone === true) return;
  if (state.status && state.status.needsSetup === false) {
    api.setSettings({ wizardDone: true }).then((x) => { state.settings = x; }).catch(() => {});
    return;
  }
  // 拉磁盘列表：推荐 = 剩余最多且 ≥8GB 的非系统盘
  const drv = await api.sysDrives().catch(() => null);
  if (drv) {
    wizard.drives = drv.drives || [];
    wizard.recommendedDrive = drv.recommended || '';
    wizard.selectedDrive = drv.recommended || '';
    state.settings = { ...(state.settings || {}), __systemDrive: drv.systemDrive || 'C:' };
  }
  renderWizardDrives();
  wizardDirsPreview();
  api.wizardOpen().catch(() => {});
  wizardShowPage(1);
  document.getElementById('wizardMask').classList.add('on');
}

async function init() {
  // 先定语言再渲染：否则英文环境下会先闪一屏中文
  await initI18n();
  bindEvents();
  bindSettings();
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
  bindWizard();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
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
      const t = toast({ title: '正在开启硬件加速…', body: '请在弹出的窗口点「是」', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: '硬件加速已启用', body: r.restartNeeded ? '请重启电脑以获得最佳性能' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else {
        t.update({ title: '未能开启', body: r.error || '请重试', type: 'error', sticky: true });
      }
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
  const plan = await api.repairPlan().catch(() => null);
  if (!plan) {
    if (started && started.error) toast({ title: '开机未完成', body: started.error, type: 'error', sticky: true });
    return;
  }
  renderRepairPlan(plan);
  $('repairMask').classList.add('on');
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
  renderRepairActions(plan);
  // 报告是自动生成的（脱敏、只落本机）：说清楚它已经在哪、什么时候发出去由用户决定
  const draft = $('repairDraft');
  if (draft) {
    const has = !!(plan.reportDraft && plan.reportDraft.file);
    draft.hidden = !has;
    draft.textContent = !has ? ''
      : (plan.reportDraft.sent
        ? '失败报告已自动上报（已脱敏）：作者会收到这次的机器信息、尝试记录与日志末尾。'
        : '失败报告已自动生成并保存在本机（路径里的用户名已替换为 %USERPROFILE%）。点「上报给作者」才会发送。');
  }
  $('repairWhy').innerHTML = (plan.why || []).map((t) => `<p>${esc(t)}</p>`).join('');
  // 跑不了的情况，默认就把原因摊开；能修的先收起，别让人一上来读六百字
  $('repairWhy').hidden = plan.level !== 'blocked';
  $('repairWhyBtn').textContent = $('repairWhy').hidden ? '为什么跑不了' : '收起说明';
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
  $('repairMask').classList.remove('on');
}

/** 一键修复：跑自动动作 → 关窗 → 用低配参数重新开机 → 失败就再弹回来 */
async function runRepair() {
  const plan = repairPlan;
  if (!plan) return;
  const btn = $('repairRunBtn');
  const later = $('repairLaterBtn');
  btn.disabled = true;
  later.disabled = true;
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
  const r = await api.repairRun({ action: 'auto' }).catch((e) => ({ ok: false, steps: [], error: e.message }));
  box.innerHTML = '';
  (r.steps || []).forEach((st) => line(`${st.ok ? '✓' : '✕'} ${st.label}${st.detail ? ` — ${st.detail}` : ''}`, st.ok ? 'ok' : 'bad'));
  if (r.empty) line('这套问题没有可自动执行的动作，直接换低配参数再试一次。', 'run');

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
    $('repairWhyBtn').textContent = why.hidden ? '为什么跑不了' : '收起说明';
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
 * 配了收集接口 → 直接 POST；没配 → 弹出摘要让用户看一眼，再打开 GitHub 提交页
 * （客户端里不能塞 token，所以最后一下必须由用户点）。
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
    t.update({ title: '已自动上报', body: '报告已发送给作者，感谢反馈。', type: 'ok' });
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

'use strict';
/**
 * 一键修复 / 「为什么跑不了」说明
 *
 * 分工：
 *  - doctor.js  负责「日志 → 结论」（code / title / hint）；
 *  - repair.js  负责「结论 + 本机实况 → 能点的按钮 + 人话解释」（本文件，纯函数）；
 *  - main.js    负责真正执行（开 Hyper-V、装驱动、清锁、清盘、重试开机）。
 *
 * 为什么要把解释写得这么细：这类问题（缺加速、CPU 太老、云主机没嵌套虚拟化）
 * 用户无法自己判断，也不该被一句「CPU 缺少指令集」推去换系统镜像 —— 那是南辕北辙。
 * 所以每个结论都必须回答三件事：这台机器是什么、卡在哪一层、换什么才有用。
 */

/** 修复动作的三种性质：能自动做、要用户确认（会动数据）、只能人工处理 */
const KIND = { AUTO: 'auto', CONFIRM: 'confirm', MANUAL: 'manual' };

/** 结论等级：能修 / 修完还是慢 / 这台机器就是跑不了 */
const LEVEL = { AUTO: 'auto', SLOW: 'slow', BLOCKED: 'blocked' };

const gb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${Math.round(mb)} MB`);

/**
 * 把各处探到的原始值整理成统一的事实表。
 * 所有字段都允许缺失 —— 修复窗口可能在「还没部署完」时就被打开。
 */
function buildFacts(raw = {}) {
  const accel = raw.accel || {};
  const image = raw.image || {};
  const osRelease = String(raw.osRelease || '');
  return {
    cpuModel: String(raw.cpuModel || '').trim(),
    vendor: String(raw.vendor || '').trim(),
    vm: !!raw.vm,
    cores: Number(raw.cores) || 0,
    totalMB: Number(raw.totalMB) || 0,
    freeMB: Number(raw.freeMB) || 0,
    arch: String(raw.arch || ''),
    osRelease,
    osMajor: Number((/(\d+)\./.exec(osRelease) || [])[1] || 0),
    accel: { ok: !!accel.ok, kind: accel.kind || '', note: accel.note || '' },
    emulatorVersion: String(raw.emulatorVersion || ''),
    image: { api: image.api || '', tag: image.tag || '', compat: !!image.compat },
    freeDiskMB: Number(raw.freeDiskMB) || 0,
    exitCode: raw.exitCode == null ? null : Number(raw.exitCode),
    runtimeDir: String(raw.runtimeDir || ''),
    appVersion: String(raw.appVersion || ''),
  };
}

/** 「这台电脑是什么」—— 所有解释的第一句都用它，避免每段各写一遍 */
function machineSentence(f) {
  const cpu = f.cpuModel || '未识别的 CPU';
  const mem = f.totalMB ? `${f.cores} 核 / ${gb(f.totalMB)} 内存` : `${f.cores} 核`;
  if (f.accel.ok) {
    const kind = f.accel.kind === 'whpx' ? 'WHPX' : (f.accel.kind === 'aehd' ? 'AEHD' : '硬件加速');
    return `这台电脑是 ${cpu}（${mem}），${kind} 已启用。`;
  }
  return `这台电脑是 ${cpu}（${mem}），没有可用的硬件加速，安卓只能跑在纯软件模拟上。`;
}

/** 检测项：给用户看的「体检表」，也是唯一能让作者远程判断的依据 */
function buildChecks(f) {
  const out = [];
  if (f.cpuModel) {
    out.push({ label: '处理器', value: `${f.cpuModel}${f.cores ? ` · ${f.cores} 核` : ''}`, state: 'ok' });
  }
  if (f.totalMB) {
    out.push({
      label: '内存',
      value: `${gb(f.totalMB)}${f.freeMB ? `（当前可用 ${gb(f.freeMB)}）` : ''}`,
      state: f.totalMB < 4096 ? 'bad' : (f.totalMB < 8192 ? 'warn' : 'ok'),
    });
  }
  out.push({
    label: '硬件加速',
    value: f.accel.ok
      ? `${f.accel.kind === 'whpx' ? 'WHPX' : 'AEHD'} 已启用`
      : '不可用（纯软件模拟，开机会慢很多）',
    state: f.accel.ok ? 'ok' : 'warn',
  });
  if (f.vm) {
    out.push({ label: '运行环境', value: `虚拟机 / 云电脑${f.vendor ? `（${f.vendor}）` : ''}`, state: f.accel.ok ? 'warn' : 'bad' });
  }
  if (f.image.api) {
    out.push({
      label: '系统镜像',
      value: `Android ${f.image.api}${f.image.compat ? ' · 含 ARM 转译' : ''}`,
      state: 'ok',
    });
  }
  if (f.freeDiskMB) {
    out.push({
      label: '磁盘余量',
      value: gb(f.freeDiskMB),
      state: f.freeDiskMB < 3072 ? 'bad' : (f.freeDiskMB < 8192 ? 'warn' : 'ok'),
    });
  }
  return out;
}

/**
 * 这台机器是否「结构上就跑不了」。
 * 只有这几种情况才敢对用户说「换镜像/调参数都没用」，别的都先让他试。
 */
function blocker(f) {
  if (f.osMajor && f.osMajor < 10) {
    return `系统是 Windows ${f.osMajor < 10 && f.osMajor >= 6 ? '7 / 8' : '旧版本'}：`
      + '新版 Android 模拟器与 Electron 都要求 Windows 10 64 位以上，这台机器无法运行。';
  }
  if (f.totalMB && f.totalMB < 3072) {
    return `物理内存只有 ${gb(f.totalMB)}：Android 14 镜像本身就要 2 GB 以上，`
      + '扣掉 Windows 之后开不起来，即使勉强开机也会被系统反复换页拖死。';
  }
  return '';
}

/** 虚拟机里没开嵌套虚拟化 —— 这不是用户操作问题，必须说清楚 */
function vmNote(f) {
  if (!f.vm || f.accel.ok) return '';
  return `而且这台机器本身就在虚拟机里${f.vendor ? `（${f.vendor}）` : ''}：虚拟机默认不把 VT-x / AMD-V 透传给里面的系统，`
    + '所以 WHPX 和 AEHD 都装不上。这不是你操作的问题，需要在宿主机的虚拟化设置里开启「嵌套虚拟化」，或换实体机。';
}

/** 把「换 Android 12 有用吗」这件事一次讲透，防止用户继续往这个方向试 */
const IMAGE_MYTH = '换 Android 12 镜像解决不了这一类问题：真正执行指令、调用 CPU 的是 Windows 上的 emulator.exe，'
  + '镜像只是它加载的安卓系统，决定开机后有多重，不决定能不能跑。'
  + '而且这个程序运行国产 arm64 应用（抖音、B 站等）依赖 Android 14 镜像里的 ARM 转译层，退回 12 只会让兼容性变差。';

const PLANS = {
  TIMEOUT: (f) => ({
    level: LEVEL.SLOW,
    headline: f.accel.ok
      ? '模拟器在这段时间内没开完机，最可能是渲染卡住或首次冷启动太慢。'
      : '这台机器没有硬件加速，纯软件模拟开 Android 14 常常要 8~15 分钟，之前只等了 4 分钟。',
    why: [
      machineSentence(f),
      '安卓不是原生跑在 Windows 上的：它运行在一台模拟出来的 x86 虚拟机里。有硬件加速时，开机像打开一个普通程序（20~60 秒）；'
        + '没有加速时，每条指令都要由 CPU 逐条翻译执行，冷启动时间会涨到十几分钟。',
      '之前失败时连续换了 4 组参数，每组都是从零开始冷启动、只等 4 分钟 —— 谁都没等到开完就被判失败，所以看起来像「怎么都起不来」。',
      IMAGE_MYTH,
    ],
    actions: [
      { id: 'low-spec', label: '低配模式再试一次（等 15 分钟）', kind: KIND.AUTO, hint: '540×960 / 2 核 / 2 GB，不存快照' },
      ...(f.accel.ok ? [] : [{ id: 'accel', label: '尝试开启硬件加速', kind: KIND.AUTO, hint: '会弹出管理员授权窗口' }]),
      ...(f.accel.ok ? [{ id: 'gpu-software', label: '改用软件渲染后重试', kind: KIND.AUTO, hint: '排除显卡驱动把渲染卡住' }] : []),
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  ACCEL: (f) => ({
    level: LEVEL.SLOW,
    headline: '没有可用的硬件加速：能跑，但开机和操作都会明显变慢。',
    why: [
      machineSentence(f),
      'x86_64 的安卓镜像要靠 Windows 自带的「虚拟机平台（WHPX）」或 Google 的 AEHD 驱动才能真正加速。'
        + '两者都用不了时，模拟器会退回纯软件模拟，开一次机要十几分钟，视频类应用基本没法看。',
      vmNote(f),
      IMAGE_MYTH,
    ].filter(Boolean),
    actions: [
      { id: 'accel', label: '一键开启硬件加速', kind: KIND.AUTO, hint: '开启「虚拟机平台」或安装 AEHD 驱动' },
      { id: 'low-spec', label: '低配模式再试一次', kind: KIND.AUTO, hint: '先保证能开机，性能以后再说' },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  CPU_FEATURE: (f) => ({
    level: LEVEL.BLOCKED,
    headline: '这台 CPU 缺少模拟器需要的指令，程序在它上面跑不起来。',
    why: [
      machineSentence(f),
      f.exitCode === 3221225501
        ? '模拟器以 0xC000001D（非法指令）退出：它执行到了这台 CPU 不认识的指令。'
        : '日志里出现了明确的「非法指令 / CPU 不支持」错误，说明模拟器用到的指令这台 CPU 没有。',
      'Android 模拟器（x86_64）要求 CPU 支持 SSE4.2，通常还需要 AVX，并且要有 VT-x / AMD-V。'
        + '这些是 2011 年之后的中高端 Intel / AMD 处理器才齐备的，早期的赛扬、Atom、奔腾和至强服务器 CPU 常常缺。',
      IMAGE_MYTH,
      f.vm ? vmNote(f) : '',
      '可行的路只有两条：换一台 CPU 较新的电脑；或者在云电脑/虚拟机里开启嵌套虚拟化（把 VT-x 透传进来）。',
    ].filter(Boolean),
    actions: [
      { id: 'low-spec', label: '仍然尝试一次（低配 + 等待 15 分钟）', kind: KIND.MANUAL, hint: '希望渺茫，但可以排除超时' },
      { id: 'report', label: '导出诊断报告', kind: KIND.MANUAL, hint: '把 CPU 型号和退出码发给我确认' },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  GPU_INIT: (f) => ({
    level: LEVEL.AUTO,
    headline: '显卡的渲染后端初始化失败，把模拟器带崩了 —— 不是安卓镜像的问题。',
    why: [
      machineSentence(f),
      '模拟器默认会用你的显卡（Vulkan / OpenGL）来渲染安卓画面。驱动版本旧、混合显卡（核显+独显）、'
        + '远程桌面或虚拟机显卡直通，都会让这一步失败，表现是黑屏、闪退或直接以 0xC0000005 退出。',
      '换成纯软件渲染（SwiftShader / lavapipe）可以绕过显卡，代价是画面刷新变慢，但能开机。',
    ],
    actions: [
      { id: 'gpu-software', label: '改用软件渲染并重试', kind: KIND.AUTO, hint: '写入设置，下次开机生效' },
      { id: 'low-spec', label: '低配模式再试一次', kind: KIND.AUTO, hint: '同时降低分辨率，减少渲染压力' },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  ACCESS_VIOLATION: (f) => ({
    level: LEVEL.AUTO,
    headline: '渲染后端在开机瞬间崩了（0xC0000005 访问冲突），换软件渲染通常就能过。',
    why: [
      machineSentence(f),
      '这类崩溃几乎都发生在显卡驱动 / Vulkan 后端初始化的一瞬间，与 CPU、内存、系统镜像都无关。'
        + '同一台机器换成软件渲染往往一次就过。',
      '如果反复出现，请更新显卡驱动，或关掉远程桌面、虚拟机显卡直通后再试。',
    ],
    actions: [
      { id: 'gpu-software', label: '改用软件渲染并重试', kind: KIND.AUTO, hint: '最有效的第一步' },
      { id: 'low-spec', label: '低配模式再试一次', kind: KIND.AUTO, hint: '降低分辨率减轻渲染压力' },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  MEMORY: (f) => ({
    level: LEVEL.AUTO,
    headline: '内存不够，模拟器申请不到开机需要的内存。',
    why: [
      machineSentence(f),
      `模拟器要一次性预留 2~3 GB 连续内存，当前可用只有 ${f.freeMB ? gb(f.freeMB) : '不多'}。`
        + '浏览器开一堆标签页、其它模拟器（夜神 / MuMu / 蓝叠）没退出，都会抢走这块内存。',
      '低配模式会把分配降到 2 GB、2 个 vCPU，先保证能开起来。',
    ],
    actions: [
      { id: 'low-spec', label: '低配模式再试一次', kind: KIND.AUTO, hint: '2 GB / 2 核' },
      { id: 'report', label: '导出诊断报告', kind: KIND.MANUAL, hint: '仍失败时发我' },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  DISK_FULL: (f) => ({
    level: LEVEL.AUTO,
    headline: '磁盘空间不足，模拟器写不下数据分区或快照。',
    why: [
      `运行时与安卓数据目录所在磁盘只剩 ${f.freeDiskMB ? gb(f.freeDiskMB) : '很少'}，`
        + '开机至少要 2.5 GB 可用（数据分区 + 快照）。',
      '清理旧快照、旧日志可以立刻腾出空间；把「安卓数据目录」改到空间充足的盘更彻底。已装的应用和存档不会被自动删除。',
    ],
    actions: [
      { id: 'cleanup-disk', label: '清理可回收空间', kind: KIND.AUTO, hint: '旧快照 / 旧日志 / 临时文件' },
      { id: 'open-settings', label: '打开设置改数据目录', kind: KIND.MANUAL },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),

  IMAGE: (f) => ({
    level: LEVEL.AUTO,
    headline: '系统镜像或用户数据不完整，安卓起不来。',
    why: [
      '日志显示 system.img / kernel 缺失或损坏，或者旧的用户数据与当前镜像不兼容。'
        + '常见原因是上次下载中断、解压时磁盘写满，或者从旧版本升级时残留了旧数据。',
      '先用干净的用户数据重建一次（已装应用清单会保留，点开时会自动重装）；仍然失败再重新下载镜像。',
    ],
    actions: [
      { id: 'wipe-data', label: '用干净数据重建（会清安卓数据）', kind: KIND.CONFIRM, hint: '应用清单保留，点开时自动重装' },
      { id: 'reinstall-image', label: '重新下载系统镜像', kind: KIND.CONFIRM, hint: '约 1.5 GB，只下一次' },
    ],
    retry: { lowspec: false, timeoutMs: 600000 },
  }),

  AVD_LOCK: (f) => ({
    level: LEVEL.AUTO,
    headline: '上一次运行没有正常退出，留下了锁文件，模拟器以为还有一台在跑。',
    why: [
      '模拟器被强制结束（关机、任务管理器、ApkStart 崩溃）时，AVD 目录里的 .lock 不会被清掉。'
        + '下次启动时模拟器看到锁就拒绝开机，报出来的话还容易被误读成 CPU 问题。',
    ],
    actions: [
      { id: 'clear-locks', label: '清理残留锁并重试', kind: KIND.AUTO },
    ],
    retry: { lowspec: false, timeoutMs: 600000 },
  }),

  DLL: (f) => ({
    level: LEVEL.AUTO,
    headline: '缺少 VC++ 运行库，或运行时组件被杀毒软件删掉了。',
    why: [
      '模拟器（Qt6）与 qemu 都依赖微软 VC++ 2015-2022 x64 运行库，缺了会在启动瞬间报 0xc0000135 / 找不到 MSVCP140.dll。',
      '部分安全软件会把 qemu 的 DLL 当成可疑文件隔离，表现相同。',
    ],
    actions: [
      { id: 'vc-redist', label: '安装 VC++ 运行库', kind: KIND.AUTO, hint: '会弹出管理员授权' },
      { id: 'redeploy', label: '校验并补齐运行时文件', kind: KIND.AUTO, hint: '重新解压缺失组件' },
    ],
    retry: { lowspec: false, timeoutMs: 600000 },
  }),

  PORT_BUSY: (f) => ({
    level: LEVEL.AUTO,
    headline: '模拟器要用的端口被别的程序占了。',
    why: [
      '夜神 / MuMu / 蓝叠等模拟器、或另一个 adb 服务会占用 5554-5584 与 adb 端口。'
        + '程序会自动换一对空闲端口重试，仍失败时多半是别的模拟器正在运行。',
    ],
    actions: [
      { id: 'clear-locks', label: '清理锁并换端口重试', kind: KIND.AUTO },
      { id: 'report', label: '导出诊断报告', kind: KIND.MANUAL },
    ],
    retry: { lowspec: false, timeoutMs: 600000 },
  }),

  NON_ASCII: (f) => ({
    level: LEVEL.AUTO,
    headline: '安装路径含中文或特殊字符，模拟器找不到自己的文件。',
    why: [
      'QEMU 对非 ASCII 路径很敏感。程序会自动改用 Windows 短路径兜底，兜不住时需要把运行时目录换成纯英文路径（例如 C:\\ApkStart）。',
    ],
    actions: [
      { id: 'open-settings', label: '打开设置改运行时目录', kind: KIND.MANUAL },
    ],
    retry: { lowspec: false, timeoutMs: 600000 },
  }),

  UNKNOWN: (f) => ({
    level: LEVEL.SLOW,
    headline: '模拟器没能开机，日志里没有明确原因 —— 先用最保守的参数试一次。',
    why: [
      machineSentence(f),
      '这种情况多半是「机器比较慢 + 参数组合不合适」。低配模式会降低分辨率与内存、关掉快照加载，并把等待时间放宽到 15 分钟。',
      '如果仍然失败，导出诊断报告发给我：报告里现在会带上 CPU 型号、是否虚拟机、加速状态和每一轮尝试的结论。',
    ],
    actions: [
      { id: 'low-spec', label: '低配模式再试一次', kind: KIND.AUTO },
      ...(f.accel.ok ? [{ id: 'gpu-software', label: '改用软件渲染', kind: KIND.AUTO }] : [{ id: 'accel', label: '尝试开启硬件加速', kind: KIND.AUTO }]),
      { id: 'report', label: '导出诊断报告', kind: KIND.MANUAL },
    ],
    retry: { lowspec: true, timeoutMs: 900000 },
  }),
};

const FALLBACK = PLANS.UNKNOWN;

/**
 * 生成修复方案。
 * @param {{code?:string}} diagnosis doctor.diagnose() 的结论
 * @param {object} facts buildFacts() 的结果
 * @param {Array} attempts 每轮尝试记录（用于解释「试过什么」）
 */
function buildPlan({ diagnosis, facts, attempts = [] } = {}) {
  const f = facts && facts.cpuModel !== undefined ? facts : buildFacts(facts || {});
  const code = (diagnosis && diagnosis.code) || 'UNKNOWN';
  const make = PLANS[code] || FALLBACK;
  const base = make(f);

  // 「换镜像」这条误区只在与硬件相关时强调，镜像类问题自己会讲清
  const block = blocker(f);
  let level = base.level;
  const why = base.why.slice();
  if (diagnosis && diagnosis.title) {
    why.unshift(`程序给出的结论是「${diagnosis.title}」。`);
  }
  // 结构性原因永远排在最前：用户先要知道「这台机器行不行」，再听程序报了什么
  if (block) {
    level = LEVEL.BLOCKED;
    why.unshift(block);
  }
  const tried = (attempts || []).filter(Boolean);
  if (tried.length) {
    why.push(`本次已经试过 ${tried.length} 组参数：`
      + tried.map((a) => `${a.plan || '未知'} → ${a.diagnosis || '未判定'}${a.timeout ? '（超时）' : ''}`).join('；') + '。');
  }

  // blocked 时把「一键修复」降级为「仍然尝试」，避免给用户「点了就能好」的错觉
  const actions = base.actions.map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    hint: a.hint || '',
    // 会动数据的动作永远要二次确认
    destructive: a.id === 'wipe-data' || a.id === 'reinstall-image',
  }));

  return {
    code,
    level,
    title: (diagnosis && diagnosis.title) || '运行时未能完成开机',
    headline: block ? block : base.headline,
    why,
    checks: buildChecks(f),
    actions,
    retry: base.retry || null,
    // 只有「能自动做」或「确认后能做」的动作才配得上「一键修复」按钮；
    // 全是人工建议时（比如 CPU 太老），按钮应该说「仍然尝试一次」。
    canAutoFix: actions.some((a) => a.kind === KIND.AUTO || a.kind === KIND.CONFIRM),
    facts: f,
  };
}

module.exports = { buildFacts, buildPlan, buildChecks, machineSentence, blocker, KIND, LEVEL };

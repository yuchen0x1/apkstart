'use strict';
/**
 * 设备自适应 / 自动诊断（零配置底座）
 *
 * 目标：不同机器上都不需要用户调任何参数。
 *  - chooseProfile()  根据物理内存、CPU、磁盘、加速状态、emulator 版本推导启动参数；
 *  - planVariants()   给出「启动失败后依次降级」的重试方案（GPU → 加速 → 内存 → 冷启动）；
 *  - diagnose()       把 emulator 的英文 stderr 翻译成可执行的修复建议；
 *  - shortPath()      处理中文/空格安装路径（emulator 的 QEMU 对非 ASCII 路径极其敏感）。
 *
 * 本模块是纯函数 + 只读探测，不写设置、不拉起 Android，方便单测。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * 机型的虚拟化线索：只读 CPU 型号，**不起子进程**。
 *
 * 这份画像会在状态刷新、诊断报告里被反复取用，任何 spawn（哪怕是 reg.exe）
 * 都可能被杀软拦下、也拖慢首屏；所以 BIOS 厂商单独放到 systemVendor()，
 * 只在真的要判断「这是不是云电脑」时取一次。
 */
const VM_RE = /virtual|qemu|vmware|hyper-v|kvm|bochs|parallels|xen/i;
function looksVirtual(text) { return VM_RE.test(String(text || '')); }

let _branding = null;
function hostBranding() {
  if (_branding) return _branding;
  const cpuModel = String(((os.cpus() || [])[0] || {}).model || '').trim();
  _branding = { cpuModel, vendor: '', vm: looksVirtual(cpuModel) };
  return _branding;
}

/**
 * BIOS 厂商（Windows 注册表，只读一次）。
 * VMware / innotek / QEMU / Microsoft Corporation（Hyper-V）是云电脑与虚拟机的强信号，
 * CPU 型号被宿主遮蔽时只剩它还能看出问题 —— 但它是「可选增强」，
 * 读不到（被杀软拦、注册表权限）就返回空串，绝不阻塞主流程。
 */
let _vendor = null;
function systemVendor() {
  if (_vendor !== null) return _vendor;
  _vendor = '';
  if (process.platform !== 'win32') return _vendor;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS', '/v', 'SystemManufacturer'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /SystemManufacturer\s+REG_SZ\s+(.+)/i.exec(out);
    if (m) _vendor = m[1].trim();
  } catch (_) { /* 读不到就算了，CPU 型号已经够用 */ }
  return _vendor;
}

/** 本机画像（毫秒级，只读） */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    ...hostBranding(),
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
    // 支持级别与加速能力：跨平台反馈里第一眼就能看出「这台系统到底能干什么」
    support: require('./platform').describe(),
  };
}

/** 目录所在盘可用空间（MB）；取不到返回 0 */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * emulator 36.4.9 起把 swiftshader_indirect 标记为弃用，新增 -gpu software。
 * 37.x 上传 swiftshader_indirect 会出现 GL 初始化失败/直接退出（设备差异很大）。
 * 因此必须按版本挑候选，且每个候选都有退路。
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    // 顺序即「自动模式的尝试优先级」：
    // 1) host        —— 用真实显卡渲染，最省 CPU、最跟手；
    // 2) swangle     —— ANGLE 跑在 SwiftShader 之上的软件渲染。比裸 software/swiftshader
    //                  对 Android WebView 的合成层友好得多（红果/抖音这类「点同意后进主界面
    //                  黑屏」就是裸软件渲染过不了 WebView 合成导致的），因此排在第二顺位；
    // 3) software    —— 纯 SwiftShader 兜底，兼容性 OK 但 WebView 合成易黑屏，仅最后才用；
    // 4) swiftshader —— 旧名兜底；
    // 5) lavapipe    —— SwiftShader 之外的另一条软件 Vulkan 路径。issue #29 那类
    //                  「带窗口就起不来、无窗口正常」的机器多半是宿主 Vulkan/GL 驱动初始化
    //                  失败；换一条完全不同的软件 Vulkan 实现有机会绕过，也让用户多一个
    //                  可手动指定的后端（设置 → 渲染后端）。
    ? ['host', 'swangle', 'software', 'swiftshader', 'lavapipe', 'guest']
    : ['host', 'swiftshader_indirect', 'swiftshader', 'lavapipe'];
}

/** Windows 8.3 短路径：中文用户名 / 中文安装目录时 emulator 会找不到文件 */
/** 屏幕规格：有硬件加速就上 720x1280（清晰），纯软件模拟降到 540x960（流畅优先） */
function lcdFor({ accelOk = true, crisp = true } = {}) {
  return accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
}

/**
 * 按应用的自然方向把 LCD 转 90°（像素数与 dpi 不变）。
 *
 * 模拟器窗口的宽高比由 hw.lcd.width/height 在**开机时**锁死：把子窗口强设成
 * 1280x720，Qt 会立刻弹回 405x720（= 720×(720/1280)）；`adb emu rotate` 只把
 * 窗口转过去、安卓侧 rotation 仍是 0（实测，画面整屏横躺）；`resize-display`
 * 只支持内置预设档且在这台机器上直接 KO。所以横屏应用要铺满窗口，只能按方向
 * 选 LCD 冷启动 —— 这是 issue #41 的根因，也是唯一可行的那条路。
 */
function orientLcd(lcd, orientation) {
  if (!lcd || !lcd.w || !lcd.h) return lcd;
  const wantLandscape = orientation === 'landscape';
  const isLandscape = lcd.w > lcd.h;
  if (wantLandscape === isLandscape) return lcd;
  return { ...lcd, w: lcd.h, h: lcd.w };
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 被关闭时保持原路径 */ }
  return p;
}

/**
 * 「轻量容器」配额：只约束最影响主机手感的那一项 —— vCPU 数。
 *
 * 旧逻辑给 16 核机器分 4 核，qemu 的 4 个 vCPU 线程会长期占满物理核，
 * Windows 桌面、鼠标、浏览器只能抢剩下的时间片，表现就是「一打开就卡」。
 * 实际跑一个 Android App 2 个 vCPU 已经绰绰有余，多给只是拖慢主机。
 *
 * 内存、分辨率刻意不动：内存上限本来就是 2~3G，降分辨率还会让 quickboot
 * 快照指纹变化、每次切模式都要重新冷启动，得不偿失。
 *
 * 纯函数，settings 为 null 时返回 null（保持旧调用方/单测的行为不变）。
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // 老逻辑是 floor(核数/4) 再夹到 2~3 —— 8 核机器只给 2 个 vCPU，软件解码视频
    // （红果/抖音这类）直接卡成幻灯片。改成「一半物理核、上限 4」：
    // 8 核给 4、4 核给 2，桌面仍有富余核，视频也够用。
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

/**
 * 机器档位：把「没有硬件虚拟化 / 内存小 / CPU 弱」翻译成一档可执行的策略。
 *
 * 只看 hostInfo() 已经采到的只读信息（CPU 型号、内存、核数、加速状态、磁盘余量），
 * 不新增任何 WMI / 注册表查询 —— 这段逻辑会在设置页、开机前、诊断报告里反复跑。
 *
 * 用打分而不是写死 `if (mem < 8G)`，是为了让每条扣分都能说清「这台机器差在哪」：
 * 设置页要能解释为什么降级，诊断报告要能复现同一个结论，单测也能逐个阈值验证。
 */
const TIER_SCORE = { tinyRam: 3, weakRam: 2, tinyCpu: 3, weakCpu: 1, noAccel: 3, tightDisk: 1 };

function machineTier({ host = hostInfo(), accel = null, diskMB = 0 } = {}) {
  const totalMB = Number(host.totalMB) || 0;
  const cores = Number(host.cores) || 0;
  const accelOk = !!(accel && accel.ok);
  const reasons = [];
  let score = 0;
  if (totalMB) {
    if (totalMB <= 4096) { score += TIER_SCORE.tinyRam; reasons.push(`物理内存只有 ${(totalMB / 1024).toFixed(1)}GB`); }
    else if (totalMB <= 6144) { score += TIER_SCORE.weakRam; reasons.push(`物理内存 ${(totalMB / 1024).toFixed(1)}GB，余量不大`); }
  }
  if (cores) {
    // 2 核以下不能只靠「一半核」收敛：那会算出 1 个 vCPU，Android 反而起不来，
    // 所以弱 CPU 的判定放在这里，具体给几个核由 lowSpecProfile() 决定。
    if (cores <= 2) { score += TIER_SCORE.tinyCpu; reasons.push(`CPU 只有 ${cores} 核`); }
    else if (cores <= 4) { score += TIER_SCORE.weakCpu; reasons.push(`CPU ${cores} 核`); }
  }
  if (!accelOk) {
    score += TIER_SCORE.noAccel;
    reasons.push('没有可用的硬件虚拟化（WHPX / AEHD 都不可用），只能走软件模拟');
  }
  if (diskMB && diskMB < 8192) {
    score += TIER_SCORE.tightDisk;
    reasons.push(`安卓数据盘只剩 ${(diskMB / 1024).toFixed(1)}GB`);
  }
  // 内存和 CPU 都富余时，即使没有 VT 也不砍画质：那种机器缺的只是速度，
  // 降分辨率只会让它白白变丑，换不来能不能开机。
  let tier = score >= 4 ? 'low' : (score >= 2 ? 'balanced' : 'high');
  if (tier === 'low' && totalMB >= 16384 && cores >= 8) tier = 'balanced';
  return { tier, score, reasons, accelOk, totalMB, cores };
}

/**
 * 低配档的保守参数（纯函数）。
 *
 * 只覆盖「最影响能不能开机、会不会把主机拖死」的四项：内存、vCPU、分辨率、
 * 渲染后端，外加一项快照策略。每一项都只往下调，绝不抬高自动值；
 * 用户在设置里手动填的值由 chooseProfile() 在其后覆盖，永远优先。
 */
function lowSpecProfile({ host = hostInfo(), emulatorVersion = '', diskMB = 0 } = {}) {
  const totalMB = Number(host.totalMB) || 0;
  // Android 14 镜像自身就要 2GB：再往下砍会在开机阶段就 OOM / 反复 GC，
  // 结果是「更慢甚至起不来」，所以 2GB 是底线（<3GB 的机器 blocker 会直接劝退）。
  const memoryMB = totalMB && totalMB < 3072 ? 1536 : 2048;
  // 2 个 vCPU：给 1 个 Android 引导不起来；给 4 个在 2~4 核的机器上会和
  // Windows 桌面抢核，用户感受就是「一打开整机就卡」。
  const cores = 2;
  // 540×960：像素量只有 720×1280 的 56%。软件渲染最先撞到的是填充率，
  // 而手机比例的窗口里肉眼几乎看不出差别。
  const lcd = { w: 540, h: 960, dpi: 240 };
  const all = gpuCandidates(emulatorVersion);
  // 软件渲染优先：低配机器多半是旧显卡 + 旧驱动，host 后端初始化失败要白等
  // 二十多秒才降级，几次重试下来开机时间就彻底不可用了。swangle（ANGLE +
  // SwiftShader）同样是软件渲染，但合成路径对 WebView 友好，比裸 software 稳
  // （裸 software 会出现「点同意后一直黑屏」）。老引擎没有 swangle 时退回
  // swiftshader_indirect。
  const soft = all.filter((g) => /swangle|swiftshader|software|lavapipe/.test(g));
  const gpu = soft.find((g) => /swangle/.test(g)) || soft[0] || all[0];
  const gpus = gpu ? [gpu, ...all.filter((g) => g !== gpu)] : all;
  // 快照：低配机器冷启动最贵（TCG 8~15 分钟），quickboot 是唯一能让「第二次
  // 打开就能用」的东西，所以默认保留；只有磁盘放不下（ram.bin ≈ 分配内存，
  // 再叠加数据分区）时才关掉 —— 磁盘写满会让下一次开机直接失败。
  const snapshot = !(diskMB > 0 && diskMB < 8192);
  return { memoryMB, cores, lcd, gpu, gpuCandidates: gpus, snapshot };
}

/**
 * 推导零配置启动参数。
 *
 * 三层，从下往上覆盖：
 *   1. 按机器实况算基线（内存取物理内存的 22%、vCPU 取一半物理核、加速状态决定分辨率）；
 *   2. 低配档（machineTier → lowSpecProfile）只往下压，且只压内存 / 核数 / 分辨率 /
 *      渲染后端 / 快照策略这五项；
 *   3. 用户手动指定（autoMemory=false 时的内存与核数、gpuMode、renderSize、
 *      keepSnapshot、liteMode）永远最后生效、永远优先。
 * 同一个函数既给设置页展示、也给 emulator 实跑，两边不会各说各话。
 */
function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  const engine = (settings && settings.engine) || {};
  const disk = diskMB || freeDiskMB(host.tmp);

  // 低配识别只做一次：设置页展示、开机实跑、诊断报告都读这一份结论，三处永远一致。
  // 用户把「资源策略」调成「流畅」等于明确要性能，此时不自动降级。
  const tier = machineTier({ host, accel, diskMB: disk });
  const lowTier = tier.tier === 'low' && engine.resourceMode !== 'smooth';
  const spec = lowTier ? lowSpecProfile({ host, emulatorVersion, diskMB: disk }) : null;

  // 3GB 足够 Android 14 与主流应用；再高只会放大内存占用和 quickboot 快照体积
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // 物理可用内存不够时下调；Android 14 最低 2G，低于此只能靠 TCG 慢速跑
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  // 低配档只往下压，不会把上面的自动值抬高
  if (spec) memoryMB = Math.min(memoryMB, spec.memoryMB);
  // 手动值永远最后生效、永远优先
  if (overrides.memoryMB) memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, 8192);

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) cores = clamp(Number(overrides.cores) || cores, 1, 8);
  // 用户没手动指定核数时才由轻量模式收敛，手动值永远优先
  const lite = settings ? liteProfile({ host, engine }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);
  // 低配档再压一层。用户显式关掉轻量容器（liteMode:false）属于手动配置，
  // 那种情况下低配档也不越过用户。
  if (spec && lite && !overrides.cores) cores = Math.min(cores, spec.cores);

  // /data 容量：应用本体、游戏资源包和它们的「更新包」都占这里，4GB 太容易满
  // （表现就是应用内更新时提示「磁盘空间不足」）。默认按磁盘余量给 6/8GB，
  // 用户也可以直接在设置里指定（改大后下次开机就地扩容，不丢数据）。
  const wantGB = Number(engine.dataPartitionGB || 0);
  const autoDataMB = disk && disk < 12288 ? 4096 : 6144;
  const dataMB = wantGB > 0 ? clamp(Math.round(wantGB * 1024), 2048, 65536) : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpuPinned = !!(overrides.gpuMode && overrides.gpuMode !== 'auto' && gpus.includes(overrides.gpuMode));
  // 低配档把软件渲染排到最前；用户手动指定后端（gpuPinned）时完全不干预
  const orderedGpus = !gpuPinned && spec ? [spec.gpu, ...gpus.filter((g) => g !== spec.gpu)] : gpus;
  const gpu = gpuPinned ? overrides.gpuMode : orderedGpus[0];

  // 渲染分辨率：auto 时按加速状态选（软件模拟降到 540x960 保流畅）。
  // 低配档即使有硬件加速也降一档：这类机器最先撞到的是填充率，不是内存带宽。
  const wantLcd = String(engine.renderSize || 'auto');
  const lcdByUser = /^\d{3,4}x\d{3,4}$/.test(wantLcd);
  const lcd = lcdByUser
    ? { ...lcdFor({ accelOk }), ...(() => {
      const [w, h] = wantLcd.split('x').map(Number);
      return { w, h, dpi: w <= 540 ? 240 : (w <= 720 ? 320 : 420) };
    })() }
    : (spec ? { ...spec.lcd } : lcdFor({ accelOk }));

  // 快照策略：用户关掉就不存；低配档按磁盘余量决定；其余保持「退出时按需存」
  const snapshot = engine.keepSnapshot === false ? false : (spec ? spec.snapshot : true);

  // 被用户手动钉住的项：设置页据此说明「自动降级没有覆盖你的设置」，
  // 诊断报告也能一眼看出这组参数里哪些是人为指定的。
  const manual = [];
  if (overrides.memoryMB) manual.push('memoryMB');
  if (overrides.cores) manual.push('cores');
  if (gpuPinned) manual.push('gpuMode');
  if (lcdByUser) manual.push('renderSize');
  if (engine.keepSnapshot === false) manual.push('keepSnapshot');
  if (engine.liteMode === false) manual.push('liteMode');
  if (engine.resourceMode === 'smooth') manual.push('resourceMode');

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: orderedGpus,
    gpuPinned,
    // Windows emulator 37.x 不应依赖隐式默认值：检测到 WHPX/AEHD 时明确
    // 传 `-accel on`，否则某些环境会悄悄走 TCG，开机时间从几十秒变成数分钟。
    // 没有硬件加速时保留 `off` 作为诊断/重试状态，但由 emulator.js 不再强制
    // 传 `-accel off`；让官方 emulator 自己选择可用的 TCG 路径，避免部分机器
    // 因显式 `-accel off` 在 guest 刚启动时触发 0xC0000005。
    accel: accelOk ? 'on' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot,
    lite: !!lite,
    // 机器档位与「为什么是这组参数」：设置页、一键修复、诊断报告三处共用
    tier: tier.tier,
    tierReasons: tier.reasons,
    tuned: !!spec,
    manual,
    // 无加速的纯软件模拟在 Windows 上确实能起来，但 Android 14 冷启动可能 5-10 分钟；
    // 低配档即使有加速（弱 CPU）也要多给两分钟，别让它在快开完时被砍。
    bootTimeoutMs: accelOk ? (spec ? 420000 : 240000) : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * 把「高级参数」里的用户设置转成 overrides。
 * 0 / auto / 未设置一律视为「不覆盖」，仍然走自动推导；
 * 只有用户主动关掉自动内存并填了具体数值才生效。
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * 展示 / 诊断用的统一入口：不启动 Android 也能算出与真实开机一致的参数。
 * 之前设置页直接调 chooseProfile()（不带版本和加速状态），会在 37.x 机器上
 * 错误地显示已弃用的 swiftshader_indirect / 软件模拟，和实跑参数对不上。
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044 } = {}) {
  return chooseProfile({
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * 失败重试矩阵：从「最优」到「最保守」，最多 4 次。
 * 依次换 GPU 后端 → 关硬件加速走 TCG → 降内存并强制冷启动清快照。
 */
function planVariants(profile, { preferSoftware = false } = {}) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const fallbackGpus = gpus.filter((g) => g !== firstGpu && /software|swiftshader|swangle|lavapipe/.test(g));
  const ordered = [firstGpu, ...fallbackGpus].slice(0, 2);
  if (preferSoftware && !profile.gpuPinned) {
    // 可见窗口优先「ANGLE + SwiftShader」(swangle)：它同样是软件渲染，不会出现 host
    // 后端失焦后交换链丢失导致的全黑，但合成路径对 WebView 友好得多。
    // 上游实测：裸 software 会让「点同意后进主界面」黑屏，swangle 不会。
    const pref = gpus.find((g) => /swangle/.test(g))
      || gpus.find((g) => /software|swiftshader/.test(g));
    if (pref) {
      if (!ordered.includes(pref)) ordered.splice(1, 0, pref);
      ordered.splice(ordered.indexOf(pref), 1);
      ordered.unshift(pref);
      ordered.length = Math.min(ordered.length, 2);
    }
  }
  for (const gpu of ordered) {
    // snapshot 跟随 profile：低配档在磁盘紧张时会关掉快照（ram.bin 放不下），
    // 这里若硬写 true，等于把那个判断又抹掉了。
    out.push({
      ...profile, gpu, label: `${gpu} / ${profile.accel === 'on' ? '硬件加速' : '软件模拟'}`,
      wipe: false, snapshot: profile.snapshot !== false,
    });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    // 关掉加速就是 TCG 纯软件模拟：Android 14 冷启动 8~15 分钟是常态，
    // 而 profile.bootTimeoutMs 是按「有加速」算出来的 4 分钟 —— 直接套用等于
    // 让兜底方案必然超时（用户干等 16 分钟、四组参数全失败，最后还被误诊成 CPU 问题）。
    // 这里给 TCG 单独放宽，兜底才真的兜得住。
    bootTimeoutMs: Math.max(profile.bootTimeoutMs || 0, 600000),
    label: '关闭加速的软件模拟（慢，但兼容性最好）',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    // 最小内存 + 清快照是最后一档，通常也最慢：多给 5 分钟，别让它在快要开完时被砍
    bootTimeoutMs: Math.max(profile.bootTimeoutMs || 0, 900000),
    label: '保守冷启动（最小内存 + 清快照）',
    // 这里**绝对不能** wipe：以前写的是 wipe:true，而磁盘写满时每次尝试都会失败，
    // 于是连续重试把用户已装的应用和存档一起「清快照 + 清数据」了 ——
    // 「磁盘满了，结果打开 ApkStart 应用全没了」就是这么发生的。
    // 需要重建 userdata 时由 ensureDataPartition 自己判断（它只在镜像损坏时重建），
    // 不靠启动参数里的 -wipe-data。
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // 去重（相同 gpu/accel/wipe 组合不重复试）——但「最后一档」必须保留：
  // 它是唯一「不加载快照」的方案，小内存机器上可能和前一档参数完全一样。
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 检测一对空闲端口（emulator console + adb 注册端口必须相邻偶数/奇数） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * adb server 端口：固定不复用探测。
 * 之前是"从 5044 往上找一个空闲端口"，但 adb server 本身是常驻进程，占着这个端口，
 * 于是每启动一次 ApkStart 就会多一个 adb server（实测一次会话跑出 6 个），
 * 而且端口老是变，下次启动想接管上次的模拟器时对不上号。
 * 5044 是 ApkStart 专用端口（用户自己的 adb 在 5037），直接固定用。
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * 配置指纹：只有「镜像 / 数据分区 / 引擎版本」变化才作废快照。
 * 故意不包含 GPU、加速方式、内存 —— 那些是自动重试会频繁切换的参数，
 * 若纳入会让每次重试都触发 -wipe-data，把用户已装的应用清空。
 */
/**
 * quickboot 快照的「配置指纹」：只有这些变化会让旧快照失效（加载后黑屏/起不来）。
 *
 * 刻意**不包含 dataMB**：数据分区调大以后旧快照照样能用（qemu 会按新的分区大小
 * 重新挂载），把它算进指纹的后果是「用户只想扩个容，结果快照作废 + 冷启动 +
 * 数据被删」—— 实测踩过一次，代价是整机应用全丢。
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * 系统镜像的「身份」：只保留 `system-images/...` 之后的部分。
 *
 * 镜像放哪个盘都无所谓，同一套镜像换个目录不该被当成「换了镜像」——
 * 否则用户把运行时从 C 盘挪到 D 盘（我们自己在设置里就建议这么做）以后，
 * AVD 里的 sysdir 与新路径不一致 → 判定镜像变了 → -wipe-data → 已装应用全丢。
 * 这个坑在实测中真的会踩到，所以两个地方（AVD 配置、快照指纹）都必须用身份而不是绝对路径。
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // Windows 上 emulator/qemu 以 0xC0000005（十进制 3221225477）退出。
    // 只能说明「模拟器进程崩了」——常见诱因有显卡/Vulkan，也可能是 TCG、
    // 运行时与系统不兼容。实测存在 swiftshader / swangle / software 三种
    // 软件后端全部同一退出码的情况，那时换后端毫无意义（见 tcgCrashDiagnosis）。
    // 必须排在 GPU_INIT 前面：崩溃日志里通常也带着渲染初始化信息，先判崩溃更准。
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: '模拟器进程崩溃（0xC0000005 访问冲突）',
    hint: '访问冲突只说明模拟器进程崩了，不一定是显卡：已自动换用其他渲染后端重试。'
      + '若多个软件后端都崩在同一退出码，说明问题在模拟器/TCG 层，'
      + '请启用 WHPX/AEHD 硬件加速或更新运行时，而不是反复调画质。',
  },
  {
    code: 'GPU_INIT',
    // 只匹配「失败」语境：正常日志里也会出现 Vulkan/EGL/ANGLE 字样，不能误判为致命错误
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|Failed to create Vulkan instance|vulkan.*(failed|error)|Platform does not support Guest Angle|UpdateLayeredWindowIndirect failed|emuglConfig_init.*failed|initOpenglesEmulation.*failed|No OpenGL ES (driver|renderer)|ANGLE.*(fail|error)/i,
    title: '显卡渲染后端初始化失败',
    hint: '日志里出现了 GL / Vulkan / ANGLE 初始化失败（本机现场：VK_ERROR_INCOMPATIBLE_DRIVER、'
      + 'Platform does not support Guest Angle）。已自动切换软件渲染重试；'
      + '若仍黑屏，这是宿主渲染层的问题，安卓侧画面本身是好的。',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: '当前运行时不接受该 GPU 模式',
    hint: '已自动按运行时版本挑选可用的 GPU 模式重试（老版本用 swiftshader_indirect，新版本用 software）。',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: '硬件加速不可用',
    hint: '已自动回退软件模拟（首次启动会明显变慢）。'
      + '在「设置 → 性能与资源」点「一键开启硬件加速」即可自动开启 WHPX 或安装 AEHD；'
      + '需要重启。',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
    title: '内存分配失败',
    hint: '已自动下调分配给 Android 的内存与核心数。请关闭占内存的程序后重试。',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: '模拟器端口被占用',
    hint: '已自动换用空闲端口。若反复出现，请退出夜神/MuMu/蓝叠等模拟器，或重启电脑。',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: '上次运行残留了锁文件',
    hint: '已自动清理 AVD 锁文件并重新拉起。',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: '系统镜像缺失或损坏 / 与旧用户数据不兼容',
    hint: '已自动用干净的用户数据重新开机。若仍失败，请在「运行时」里删除镜像后重新下载。',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: '运行时组件被杀毒软件删除或缺少 VC++ 运行库',
    hint: '请把 ApkStart 目录加入杀毒软件白名单后重新解压安装包，并安装微软 VC++ 2015-2022 运行库。',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足/i,
    title: '磁盘空间不足，无法启动安卓',
    hint: '请把运行时目录（设置 → 系统集成 → 运行时数据目录）改到空间充足的盘，'
      + '或在设置里关掉「保留快速启动快照」/ 调小数据分区。安卓数据不会被自动清除。',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: '安装路径含中文或特殊字符',
    hint: '已自动改用 Windows 短路径。若仍失败，请把 ApkStart 移到纯英文目录（如 C:\\ApkStart）。',
  },
  {
    // 上次被强制结束后 AVD 目录会留下 hardware-qemu.ini.lock / multiinstance.lock，
    // 模拟器一律拒绝启动，报出来的却是容易被误读成 CPU 问题的话。必须排在 CPU 规则前。
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: '上一次运行没有正常退出，残留了锁文件',
    hint: 'ApkStart 会自动清掉残留锁并重试；若反复出现，请检查是否有别的模拟器正在用同一套运行时。',
  },
  {
    code: 'CPU_FEATURE',
    // 只认「真的跑不下去」的信号：非法指令、明确说 CPU 不支持。
    // 以前这里是 /host doesn't support requested feature|missing.*(AVX|SSE4|xsave)/，
    // 而 QEMU 在绝大多数正常机器上都会打印一句
    // "warning: host doesn't support requested feature: CPUID.01H:ECX.avx"，
    // 于是「超时」被误诊成「CPU 缺指令集」，把用户引向换镜像这条死路（#15 类反馈）。
    // 无害的 CPUID 警告改由 notes() 单独摘出来，只作说明、不参与结论。
    re: /Illegal instruction|3221225501|0xC000001D|unsupported CPU|CPU (is )?not supported|requires (a )?CPU with (AVX|SSE4)|CPU lacks (AVX|SSE4)/i,
    title: 'CPU 缺少运行时要求的指令集',
    hint: '这台 CPU 太老，模拟器用到的指令（常见是 SSE4.2 / AVX）它没有。'
      + '换 Android 12/14 镜像都解决不了 —— 执行指令的是宿主侧的 emulator，镜像只决定开机后有多重。'
      + '只能换一台 CPU 较新的电脑，或用带嵌套虚拟化的云主机。',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: '快速启动快照损坏',
    hint: '已自动丢弃旧快照走冷启动；下一次正常退出会重新生成快照。',
  },
];

/** 把日志翻译成 {code,title,hint}，供 UI 展示与自动重试决策 */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: '运行时未能完成开机',
    hint: '已自动按多种参数组合重试。可点「导出诊断报告」把日志发给作者定位。',
  };
}

/**
 * 日志里的「良性噪音」：只用于解释，不参与诊断结论。
 * 用户最容易被这几句吓到（"host doesn't support requested feature" 尤甚），
 * 修复窗口和诊断报告都该主动说明「这是警告，不是原因」。
 */
function notes(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  const out = [];
  if (/host doesn't support requested feature/i.test(text)) {
    out.push('日志里的 "host doesn\'t support requested feature" 是 QEMU 的警告：'
      + '模拟器想启用某个 CPU 特性（例如 AVX）而宿主没提供，它会自己降级，不影响开机。');
  }
  if (/does not have the requested snapshot|Failed to load snapshot/i.test(text)) {
    out.push('"Failed to load snapshot" 说明快速启动快照失效，程序会自动改为冷启动，不是故障。');
  }
  return out;
}

/**
 * 「等到超时」的结论。
 *
 * 以前这种情况会掉进 UNKNOWN，或者被 CPUID 警告抢走结论，用户只看到一句
 * 「CPU 缺少指令集」—— 而他真正需要知道的是「这台机器有多慢、还差多久」。
 */
function timeoutDiagnosis({ accelOk = true, seconds = 0 } = {}) {
  const wait = seconds ? `${Math.round(seconds / 60)} 分钟` : '设定时间';
  if (accelOk) {
    return {
      code: 'TIMEOUT',
      title: `等了 ${wait} 也没开完机`,
      hint: '这台机器有硬件加速，但安卓在这段时间内没起来：可能是显卡/驱动把渲染卡住了，'
        + '也可能是第一次冷启动特别慢。点「一键修复」会换软件渲染 + 低配参数，并给足开机时间。',
    };
  }
  return {
    code: 'TIMEOUT',
    title: `没有硬件加速，纯软件模拟在 ${wait} 内开不完机`,
    hint: '这台机器没有可用的 WHPX/AEHD，安卓只能跑在纯软件模拟（QEMU TCG）上，'
      + 'Android 14 冷启动常要 8~15 分钟，远超当前等待时间。'
      + '「一键修复」会用低配参数（540x960 / 2 核 / 2G）并把等待延长到 15 分钟；'
      + '想彻底变快，到「设置 → 性能与资源」点「一键开启硬件加速」，开启后重启电脑。',
  };
}

/**
 * 没有硬件加速、又试完全部参数组合时的结论。
 *
 * issue #20 / #6 / #15 / #31 / #29 都是这一类：机器上 WHPX 与 AEHD 都不可用，
 * 日志里没有任何可匹配的关键字，最后只剩一句「UNKNOWN · 已自动尝试多组参数」，
 * 用户完全不知道该做什么。实际情况很明确：x86_64 镜像在多数 CPU 上必须有加速。
 */
function noAccelDiagnosis() {
  return {
    code: 'ACCEL',
    title: '本机没有可用的硬件加速，软件模拟没能起来',
    hint: 'x86_64 安卓镜像在多数 CPU 上必须有 WHPX 或 AEHD 才能开机。'
      + '打开「设置 → 性能与资源」点「一键开启硬件加速」，程序会自动申请管理员权限并开启对应功能；'
      + '完成后重启电脑。BIOS 里的 SVM / VT-x 也需要是开启状态。',
  };
}

/**
 * 「换了多种软件渲染后端，仍然全部 0xC0000005」的专用结论。
 *
 * 这时继续换 -gpu 参数是无效的：崩溃发生在模拟器/TCG 层，而不是 GLES 后端。
 * 典型现场：没有 WHPX/AEHD 的 Windows 机器被强制走 TCG，guest 内核命令行
 * 已经打印出来（说明镜像和引导没问题），随后 qemu 进程直接访问冲突。
 * 给出能真正改变结果的步骤：开硬件虚拟化、升级运行时、排查安全软件/RDP。
 */
function tcgCrashDiagnosis() {
  return {
    code: 'TCG_CRASH',
    title: '纯软件模拟（TCG）崩溃，换渲染后端无效',
    hint: 'swiftshader / swangle / software 等多个软件后端都以 0xC0000005 退出，'
      + '说明崩溃发生在模拟器本身而不是显卡驱动。请到「设置 → 性能与资源」点「一键开启硬件加速」，'
      + '程序会自动开启 WHPX 或安装 AEHD（会弹管理员授权，完成后重启电脑）；'
      + '若提示 BIOS 虚拟化未开，需先重启进 BIOS 打开 AMD SVM / Intel VT-x。'
      + '仍失败再更新运行时引擎并导出诊断报告。',
  };
}

/** 人类可读的一行摘要，放在设置页让高级用户知道自动选了什么 */
function describeProfile(p) {
  if (!p || !p.memoryMB) return '正在检测本机参数…';
  const lcd = p.lcd && p.lcd.w ? `${p.lcd.w}×${p.lcd.h}` : '';
  const snap = p.snapshot === false ? '冷启动（不存快照）' : 'quickboot 快照';
  return `${p.tuned ? '低配自动降级' : '自动'}：${(p.memoryMB / 1024).toFixed(1)}GB 内存 · ${p.cores} 核`
    + `${lcd ? ` · ${lcd}` : ''} · ${p.gpu} 渲染 · ${p.accelOk ? '硬件加速' : '软件模拟'} · ${snap}`
    + `${p.lite ? ' · 轻量容器' : ''} · 端口 ${p.port}`;
}

/** 手动钉住的项 → 中文名（设置页 / 报告共用） */
const MANUAL_LABELS = {
  memoryMB: '内存',
  cores: 'CPU 核心数',
  gpuMode: '渲染后端',
  renderSize: '画质',
  keepSnapshot: '快速启动快照',
  liteMode: '轻量容器',
  resourceMode: '资源策略',
};

/**
 * 「为什么是这组参数」。
 * 低配降级最容易被误解成「软件偷偷把画质调低了」，所以必须把触发原因摊开说；
 * 用户选了「流畅」而机器又是低配时也要讲清楚「这次按你的选择不降级」。
 */
function describeTuning(p) {
  if (!p) return '';
  const why = Array.isArray(p.tierReasons) ? p.tierReasons.filter(Boolean) : [];
  if (p.tuned) return `已按低配机器自动降级：${why.join('；') || '机器性能偏低'}。`;
  if (p.tier === 'low') return `检测到低配机器（${why.join('；') || '性能偏低'}），但资源策略是「流畅」，本次不降级。`;
  return '';
}

/** 「哪些是你自己指定的」——降低「为什么我的设置没生效」这类困惑 */
function describeManual(p) {
  const list = (p && Array.isArray(p.manual)) ? p.manual : [];
  if (!list.length) return '';
  return `手动指定：${list.map((k) => MANUAL_LABELS[k] || k).join('、')}（手动值优先，自动降级不会覆盖）。`;
}

/**
 * 单轮尝试的参数摘要：失败时贴给用户看的就是它。
 * 只保留一眼能判断「这组参数到底保守到什么程度」的几项。
 */
function describeAttempt(plan) {
  if (!plan) return '';
  const parts = [plan.gpu, `${plan.memoryMB}MB`, `${plan.cores}核`];
  if (plan.lcd && plan.lcd.w) parts.push(`${plan.lcd.w}x${plan.lcd.h}`);
  if (plan.snapshot === false) parts.push('不存快照');
  if (plan.accel === 'off') parts.push('软件模拟');
  if (plan.wipe) parts.push('清数据');
  return parts.filter(Boolean).join(' / ');
}

/** 导出诊断报告（纯文本，便于发邮件/贴 issue） */
/** 报告里要写清是哪个版本导出的 —— 跨版本比对时这一步省不掉 */
function pkgVersion() {
  try { return require('../../package.json').version; } catch (_) { return ''; }
}

/**
 * 报告为空时（没有尝试记录、没有 emulator 日志）该怎么说。
 *
 * issue #25 / #20 的情形：用户附上的报告里只有 `attempts: []` 和一句 UNKNOWN，
 * 因为「开机是懒启动」—— 没点开过应用，就一次都没拉过模拟器；或者 ApkStart
 * 重启过，上次失败的记录被清掉了。报告本身不该在这种情况下沉默：它应该告诉
 * 用户「这份报告什么也没记到，以及怎么导一份有内容的」。
 */
function emptyReportNote(extra) {
  const attempts = extra && Array.isArray(extra.attempts) ? extra.attempts : [];
  const hadFailure = !!(extra && extra.lastFailure);
  if (attempts.length || hadFailure) return [];
  return [
    '',
    '== 这份报告为什么是空的 ==',
    '本次导出时，ApkStart 没有过任何一次开机尝试记录，也没有上次失败的落盘记录。',
    '常见原因（都在 app.log 里能看到对应轨迹）：',
    '  1. 还没打开过任何应用 —— 安卓运行时是「点开应用才开机」的懒启动，没点就不会有尝试记录；',
    '  2. ApkStart 刚重启过 —— 内存里的尝试记录只在本次运行内有效，上一次的失败记录会被清掉；',
    '  3. 问题发生在「装 APK」或「窗口嵌入」阶段，根本没走到开机 —— 那时看下面的会话日志。',
    '想导出一份有内容的报告，请按顺序做：',
    '  1. 在 ApkStart 里打开那个出问题的应用，等到报错（或黑屏 30 秒以上）；',
    '  2. 不要关闭、不要重启 ApkStart，立刻右键托盘图标 →「导出诊断报告」；',
    '  3. 如果 ApkStart 直接崩了，重启后再导出：它会把上次失败的记录（last-failure.json）一起带上。',
  ];
}

function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  // 报告里的结论必须和界面上的结论一致：调用方已经给出诊断时直接采用，
  // 否则重新跑一遍正则很容易得出另一个结论（比如把超时说成 UNKNOWN）。
  const d = (extra && extra.diagnosis) || diagnose(logLines);
  const sessionLog = Array.isArray(extra.sessionLog) ? extra.sessionLog : [];
  const benign = Array.isArray(extra.notes) ? extra.notes : notes(logLines);
  const body = [
    'ApkStart 诊断报告',
    `生成时间：${new Date().toLocaleString()}`,
    `应用版本：${extra.appVersion || pkgVersion()}`,
    '',
    '== 本机 ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== 自动配置 ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    // 低配降级会改变分辨率与渲染后端，报告里必须写清「为什么」，否则用户会
    // 以为软件偷偷把画质调低了（而且换台机器复现不出来）。
    ...[describeTuning(profile), describeManual(profile)].filter(Boolean),
    '',
    '== 诊断 ==',
    `${d.code}：${d.title}`,
    d.hint,
    ...(benign.length
      ? ['', '== 日志里这些「像错误」的行其实无害 ==', ...benign.map((t) => `- ${t}`)]
      : []),
    ...emptyReportNote(extra),
    '',
    '== 附加信息 ==',
    JSON.stringify(extra, null, 2),
    '',
    '== 运行时日志（末尾 300 行）==',
    ...(Array.isArray(logLines) && logLines.length
      ? logLines.slice(-300)
      : ['（没有 emulator.log：本次还没有拉起过模拟器）']),
    '',
    '== 应用日志（app.log 末尾 200 行：点开应用 → 引导 → 安装 的轨迹）==',
    ...(sessionLog.length ? sessionLog.slice(-200) : ['（app.log 为空或被轮转）']),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * 检测微软 VC++ 2015-2022 x64 运行库是否安装。
 * 安卓模拟器（Qt6）与 qemu 都依赖它；缺了在「其他电脑」上会直接起不来
 * （报 0xc0000135 / MSVCP140 缺失）。安装版我们已内置 vc_redist.x64.exe，
 * 这里只做检测，供启动前给出明确提示与一键安装入口。
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // 先看 DLL：msvcp140 / vcruntime140 正是 Qt6 与 qemu 真正依赖的两个文件。
  // 用文件判断既不用起 reg.exe（部分安全软件会拦、也会拖慢每 60s 的自检），
  // 也不会因为注册表项被清理工具删掉而误报「没装」。
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* 走注册表兜底 */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* 键不存在 = 没装 */ }
  }
  return false;
}

module.exports = {
  hostInfo, hostBranding, systemVendor, looksVirtual, freeDiskMB, isAsciiPath, shortPath, lcdFor, orientLcd, liteProfile,
  versionNumbers, gpuCandidates, machineTier, lowSpecProfile, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, notes, timeoutDiagnosis, noAccelDiagnosis, tcgCrashDiagnosis,
  describeProfile, describeTuning, describeManual, describeAttempt,
  writeReport, vcRedistOk,
};

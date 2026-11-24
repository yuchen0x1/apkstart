'use strict';
/**
 * Emulator 引擎：驱动 Google 官方 Android Emulator 作为 ApkStart 的运行时。
 *
 * 与旧版最大的不同：这里不再假设「一套参数在所有电脑上都能跑」。
 *  1. 用 doctor.chooseProfile() 按内存/CPU/磁盘/加速状态/引擎版本自动推导参数；
 *  2. 启动失败时按 planVariants() 自动降级重试（GPU 后端 → 软件模拟 → 最小内存冷启动）；
 *  3. 动态挑空闲端口、清 AVD 锁、中文路径转短路径、镜像变更后自动作废快照；
 *  4. quickboot 快照 + 小数据分区，做到「像容器一样」共享只读基础层、秒级恢复。
 *
 * probe 回调由上层（Runtime）提供，用于判断 Android 是否真正就绪。
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const userdata = require('./userdata');
const processOwner = require('./process-owner');
const peripherals = require('./peripherals');
const instanceAdb = require('./instance-adb');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';
/**
 * 自定义镜像单独一套 AVD。
 *
 * 为什么不复用 apkstart：模拟器发现 image.sysdir 变了就会给旧 userdata 做
 * -wipe-data（APEX 不兼容会引导循环），那等于「换镜像 = 已装应用全丢」。
 * 换成一个独立 AVD 以后，默认 AVD（应用、存档、快照）一个字节都不动，
 * 用户在设置里「恢复默认镜像」就能原样回来。
 */
const CUSTOM_AVD_NAME = 'apkstart-custom';
/** 两个 AVD 都归我们管：清理逻辑必须把它们都当成「活动 AVD」保护起来 */
const BUILTIN_AVD_NAMES = ['apkstart-googleapis', 'apkstart-aosp'];
const MANAGED_AVDS = [`${AVD_NAME}.avd`, ...BUILTIN_AVD_NAMES.map((x) => `${x}.avd`), `${CUSTOM_AVD_NAME}.avd`];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 上把 emulator/qemu 的退出码翻译成人话。
 * 0xC0000005（3221225477）最常见：进程访问冲突。诱因可能是显卡/Vulkan，
 * 也可能是 TCG 或运行时与系统不兼容——换渲染后端不总能绕过，别下死结论。
 */
function describeExitCode(code) {
  // 被信号结束时 code 是 null（Windows 上走 taskkill / adb emu kill 都会这样），
  // 不能当成 0 报「正常退出」，但也谈不上异常，返回空串让调用方原样显示。
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return '正常退出';
    case 1: return '启动参数或环境错误';
    case 3221225477: return '0xC0000005 访问冲突（模拟器进程崩溃）';
    case 3221225725: return '0xC00000FD 栈溢出';
    // 0xC000001D：CPU 执行到它不认识的指令。这才是「真·缺指令集」的唯一硬证据，
    // 以前没映射，报告里是一片空白，只能靠日志里那句无害的 CPUID 警告去猜。
    case 3221225501: return '0xC000001D 非法指令（CPU 缺少模拟器要求的指令集）';
    case 3221225781: return '0xC0000135 依赖 DLL 加载失败（具体组件未确认）';
    case 3221225506: return '0xC0000022 拒绝访问（驱动或权限问题）';
    case 3221225595: return '0xC000007B 镜像位数不匹配或 DLL 损坏';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this._logSeq = 0;
    this.port = 5554;
    this._adbRoute = instanceAdb.route();
    this.adbPort = this._adbRoute.port;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    // 快照的 ram.bin ≈ 分配给虚拟机的内存（2-4GB）。
    // 冷启动本来就快的机器不该为它付出几个 GB 的磁盘，只在「真慢」时才保存。
    this.snapshotWorthSaving = null;
    // 「下一次启动强制 -wipe-data」的一次性标记：只由「修复网络」设置。
    this._forceWipe = false;
    // 「下一次启动不加载快照」的一次性标记（上游同款）：快照可能是在虚拟机没网时
    // 存的，恢复出来依旧没网；网络修复流程设置它后强制冷启一次。
    this._coldBoot = false;
  }

  /** 让下一次启动跳过快照、冷启动一次（对齐上游 forceColdBootOnNextStart） */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * 让「下一次启动」带上 -wipe-data（仅「修复网络」在等待超时后使用）。
   *
   * 实测：这个 Android 镜像的 Wi-Fi，在已有用户数据上冷启时经常一直
   * NO-CARRIER、拿不到 IP；而重置数据后的那次开机是能连上的。
   * 注意「删掉 userdata 镜像文件」与 emulator 的 `-wipe-data` 并不等价，必须走后者。
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  log(line) {
    this._logSeq = (this._logSeq || 0) + 1;
    this._log.push({ t: Date.now(), seq: this._logSeq, line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * 把「最后一次启动失败」落盘。
   * 旧版只放在内存里（this.attempts），用户重启 ApkStart 后再导出诊断报告，
   * 报告里就是 attempts: []、bootLog: [] 一片空白，只能在日志里翻 —— 这也是
   * issue #20/#25 里「附了报告却看不出原因」的直接原因。
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* 落盘失败不影响主流程 */ }
  }

  /** 读回上一次失败记录（诊断报告 / 开机前提示用） */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** accel 是选档依据，不等于命令行已传 on，更不等于本轮真的挂上了加速器。 */
  _accelerationState(plan = {}, logLines = []) {
    const argument = plan.accel === 'off' ? 'off' : null;
    const evidence = logLines.find((line) => /hypervisor platform accelerator is operational|(?:WHPX|AEHD|KVM|HAXM)[^\n]*operational/i.test(line)
      && !/\bnot\b|\bnon-operational\b/i.test(line)) || '';
    return {
      detected: this._detectedAccel ? { ...this._detectedAccel } : null,
      requested: plan.accel || 'auto',
      argument, // null = 有意不传 -accel，使用官方默认；只有 off 显式传参
      policy: argument === 'off' ? 'explicit-off' : 'emulator-default',
      confirmed: argument === 'off' ? false : (evidence ? true : null),
      evidence: argument === 'off' ? '' : evidence,
    };
  }

  describeProfile(profile = this.profile) {
    const text = doctor.describeProfile(profile);
    const accel = profile?.acceleration;
    if (!accel) return text;
    const actual = accel.argument === 'off' ? '软件模拟（显式 -accel off）'
      : `官方默认加速（不传 -accel；${accel.confirmed ? '启动日志已确认' : '实际加速未确认'}）`;
    return `${text} · ${actual}`;
  }

  /**
   * 取「当前生效的自定义镜像」。
   * 单独抽一层是因为单测与早期调用会塞进来一个只实现了几个方法的 provisioner：
   * 拿不到就当没有自定义镜像，绝不让它把选镜像这条主路径搞崩。
   */
  _activeImageInfo() {
    try {
      return typeof this.provisioner.activeImage === 'function' ? this.provisioner.activeImage() : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * AVD 名回到上游的常量 apkstart；只有自定义镜像用独立的 apkstart-custom。
   * 之前从 imageProfile() 动态取名让默认路径也变成「按镜像拼名字」，
   * 和上游的快照 / AVD 清理逻辑越走越远。
   */
  get avdName() {
    const act = this._activeImageInfo();
    return (act && act.ok && act.custom) ? CUSTOM_AVD_NAME : AVD_NAME;
  }

  /**
   * 快照名跟着 AVD 走：自定义 AVD 用 apkstart-custom-apkstart，
   * 绝不和默认 AVD 共用一份 apkstart 快照（切换镜像后加载旧快照 = 应用全丢）。
   */
  get snapshotName() {
    return this.avdName === AVD_NAME ? SNAPSHOT_NAME : `${this.avdName}-${SNAPSHOT_NAME}`;
  }

  /** emulator（Windows 带 .exe）与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emuName = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', emuName)];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, custom: !!img.custom, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /**
   * 选镜像：
   *   1. 用户在「自定义镜像」里启用了某套 → 用它（导入时已经过了清单 + 字节体检）；
   *   2. 否则用当前选择的内置镜像（新安装默认 API 34 Google Play）；
   *   3. 再退到任意一套可用的系统镜像，保证有兜底。
   */
  imageChoice() {
    const act = this._activeImageInfo();
    if (act && act.ok && act.custom) {
      return {
        compat: false,
        custom: true,
        id: act.id,
        name: act.name,
        api: act.api,
        tag: act.tag,
        dir: act.dir,
        abi: act.abi,
        gms: !!(act.googleServices && act.googleServices.gms),
        playStore: !!(act.googleServices && act.googleServices.playStore),
        armTranslation: !!(act.armTranslation && act.armTranslation.enabled),
        source: act.source || {},
      };
    }
    const base = this.provisioner.systemImageInfo();
    let profile = null;
    try { profile = this.provisioner.imageProfile(); } catch (_) { profile = null; }
    // 兼容旧版测试/外接 provisioner：没有档位接口时仍按旧逻辑认 Play 镜像。
    if (!profile && typeof this.provisioner.playImageInfo === 'function') {
      const legacyPlay = this.provisioner.playImageInfo();
      if (legacyPlay && legacyPlay.ok) {
        return {
          compat: true, builtIn: true, flavor: 'google_apis_playstore',
          api: legacyPlay.api, tag: legacyPlay.tag, dir: legacyPlay.dir, abi: 'x86_64',
          name: 'Google Play（兼容模式）', gms: true, playStore: true, armTranslation: true,
        };
      }
    }
    return {
      compat: !!(profile && profile.armTranslation),
      builtIn: true,
      flavor: (profile && profile.id) || base.flavor || 'google_apis_playstore',
      api: base.api || (profile && profile.api),
      tag: base.tag || (profile && profile.tag),
      dir: base.dir,
      abi: base.abi || (profile && profile.abi) || this.provisioner.paths().sysAbi,
      name: (profile && profile.shortLabel) || base.label || 'Google Play（兼容模式）',
      gms: !!(profile && profile.gms),
      playStore: !!(profile && profile.playStore),
      armTranslation: !!(profile && profile.armTranslation),
    };
  }

  /**
   * 作废 quickboot 快照。
   * 快照同时保存内存和磁盘镜像，装完新应用/清了数据后如果还加载旧快照，
   * 用户会看到「刚刚装好的应用重启后又不见了」。
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 清掉上次异常退出留下的锁。
   * 注意 hardware-qemu.ini.lock 是**目录**不是文件，bsdtar 式的 rmSync(force) 删不掉它，
   * 于是模拟器会一直报 "Running multiple emulators with the same AVD" 起不来
   * （被强杀过一次就会这样），必须递归删。
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* 被占用就跳过，下次再清 */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * AVD 目录里是否真的有一份**完整**的 quickboot 快照。
   * 只判断「目录非空」是不够的：保存被中断时会留下一个只有 12 字节 snapshot.pb 的空壳，
   * emulator 会尝试加载、失败（日志 "does not have the requested snapshot"）再回退冷启动，
   * 白等几秒。这里按文件大小校验，顺手清掉空壳和旧版遗留的 default_boot（单个 3GB）。
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`, 'snapshots', this.snapshotName);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // 新版 emulator（37.x）写的是 ram.bin，老版本写 ram.img。
    // 只认 ram.img 的后果非常严重：刚存好的 3GB 快照会被当成空壳删掉，
    // 于是每次都带 -no-snapshot-load，永远冷启动 —— 这是「打开很慢」的一半原因。
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // 目录本来就没有，别白删
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** 清掉旧版遗留/失败重命名留下的快照目录（default_boot 里的 ram.img 可达 3GB） */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`, 'snapshots', this.snapshotName));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === this.snapshotName) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /** Only a canonical emulator executable AND this exact AVD directory establish ownership. */
  ownsProcess(info, { discoverRoot = false } = {}) {
    const p = this.provisioner.paths();
    const exe = p.emulatorExe || (p.root ? path.join(p.root, 'emulator', 'emulator') : '');
    return processOwner.ownsEmulator(info, {
      avdName: this.avdName,
      avdDir: path.join(p.avdHome, `${this.avdName}.avd`),
      emulatorDirs: discoverRoot ? null : [exe && path.dirname(exe), path.join(this.appRoot, 'engine', 'emulator')].filter(Boolean),
    });
  }

  async ownedProcessOnPort(port = this.port) {
    const pid = await processOwner.pidOnPort(port);
    const info = await processOwner.getProcessInfo(pid);
    return this.ownsProcess(info, { discoverRoot: true }) ? info : null;
  }

  /** Console and ADB endpoints must belong to this exact, birth-pinned AVD. */
  async _ownedAdbTarget(expected = null, port = this.port) {
    const target = await this.ownedProcessOnPort(port);
    if (!target || (expected && !processOwner.sameIdentity(expected, target))) return null;
    const pid = await processOwner.pidOnPort(Number(port) + 1);
    if (pid !== target.pid || port !== this.port) return null;
    const current = await processOwner.getProcessInfo(pid);
    return processOwner.sameIdentity(target, current) ? current : null;
  }

  async _requireAdbTarget(expected = null, port = this.port) {
    const target = await this._ownedAdbTarget(expected, port);
    if (target) return target;
    const error = new Error('运行时 console/ADB 端口归属无法确认或已变化，已停止向客机发送命令');
    error.code = 'RUNTIME_OWNERSHIP_LOST';
    throw error;
  }

  _adbInvocation(adbPath, args) {
    const route = this._adbRoute;
    instanceAdb.assertReady(route);
    let candidate = adbPath || '';
    if (!route.isChild && !candidate) {
      try { candidate = this.provisioner.adbVersionPath() || ''; } catch (_) { /* try bundled below */ }
      if (!candidate) {
        try { candidate = this.provisioner.paths().adbExe || ''; } catch (_) { /* legacy PATH */ }
      }
      if (!candidate || !fs.existsSync(candidate)) candidate = 'adb';
    }
    return {
      adb: instanceAdb.executable(candidate || 'adb', route),
      args: instanceAdb.clientArgs(args, route),
      env: instanceAdb.environment(route),
    };
  }

  async _guestShell(adbPath, cmd, target, port, { timeout = 8000, includeErrors = false } = {}) {
    await this._requireAdbTarget(target, port);
    const call = this._adbInvocation(adbPath, ['-s', `emulator-${port}`, 'shell', cmd]);
    const result = await new Promise((resolve) => {
      try {
        execFile(call.adb, call.args, { timeout, windowsHide: true, env: call.env }, (error, out, err) => {
          resolve(includeErrors ? String(out || '') + String(err || '') : (error ? '' : String(out || '')));
        });
      } catch (_) { resolve(''); }
    });
    await this._requireAdbTarget(target, port);
    return result;
  }

  /** Lock PIDs are candidates, never proof. Do not collect other listening QEMUs. */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    const avdDir = path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`);
    const pids = new Set();
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { /* absent AVD */ }
    for (const lock of locks) {
      for (const file of [path.join(avdDir, lock, 'pid'), path.join(avdDir, lock)]) {
        try {
          if (!fs.statSync(file).isFile()) continue;
          const text = fs.readFileSync(file, 'utf8').trim();
          if (/^[1-9]\d*$/.test(text)) pids.add(Number(text));
        } catch (_) { /* unsupported/stale lock format is not authority */ }
      }
    }
    let killed = 0;
    for (const pid of pids) {
      const info = await processOwner.getProcessInfo(pid);
      if (await processOwner.terminateOwnedProcess(info, (p) => this.ownsProcess(p))) killed += 1;
    }
    // Unknown ownership/access errors must not remove a live instance's locks.
    if (killed) onLog(`已清理 ${killed} 个经归属验证的残留模拟器进程`);
    return killed;
  }

  /** 5554~5620 里是否有 emulator 控制台端口在监听（连接被拒会立刻返回，代价极小） */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * 准备 AVD：写 config.ini。每次启动按当前自动配置重写，保证降级重试即时生效。
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const peripheralSettings = peripherals.normalizeSettings(this.settings?.peripherals);
    // 不支持的串口映射必须在改写 AVD 之前明确拒绝，不能保存后静默忽略。
    peripherals.buildEmulatorArgs(peripheralSettings);
    const peripheralConfig = peripherals.buildEmulatorConfig(peripheralSettings);
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${this.avdName}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // 屏幕分辨率：有硬件加速时 720x1280@320 画面清晰、文字不糊；
    // 纯软件模拟时降到 540x960，帧率优先（面积只有 56%，肉眼差距远小于流畅度差距）。
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    // 自定义镜像的 tag.display 用清单里的名字：AVD 列表里一眼能看出「这套不是默认镜像」。
    // config.ini 声明了 UTF-8 编码，中文名可以直接写。
    const tagDisplay = choice.custom
      ? (choice.name || '自定义镜像')
      : (choice.name || (choice.compat ? 'Google APIs' : '纯 AOSP'));

    fs.writeFileSync(
      path.join(home, `${this.avdName}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // 比较「镜像身份」而不是绝对路径：同一套镜像换盘/换目录不算换镜像，
      // 否则用户一改运行时目录就会被清掉所有已装应用（见 doctor.imageIdentity 注释）。
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // 旧 userdata 与新镜像不兼容（APEX 引导循环），必须重建
        this.wipePending = true;
      }
    }

    // 配置指纹变化 → 旧 quickboot 快照必然加载失败或产生黑屏，主动作废。
    // 注意：这里只作废**快照**，绝不能顺手 -wipe-data —— 用户数据里是已装的应用和存档。
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}|${JSON.stringify(peripheralSettings)}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* 首次 */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // 删除可能被系统/安全软件拦截（快照目录常有几个 GB）。
      // 失败就改名让 emulator 不再加载它，绝不因为清理失败而中断启动。
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // 只有「镜像换了」（tag / sysdir 变化）才需要 -wipe-data：旧 userdata 与新镜像
    // 的 APEX 不兼容，不重建会一直卡在引导循环。改容量 / 改分辨率 / 换渲染后端都不算。
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch 必须是 ABI 本身（x86_64 不能截成 x86）
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${this.avdName}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // 旧版写死 16G，会在小硬盘/配额环境下生成巨型文件并拖慢首次开机
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      // guest 内部的 Wi-Fi 网卡必须显式拉起（上游 a0d3b8e）：没有这行，
      // QEMU 用户态 NAT 参数都正常，guest 里却没有 wlan0 —— dumpsys connectivity
      // 显示 Active default network: none，应用里就是一直「网络错误，请稍后再试」。
      'hw.wifi=yes',
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      // 自定义镜像按清单里的 googleServices 决定：没有 Play 商店就不能声称有，
      // 否则安卓会去拉起不存在的商店包，设置页里点「Play 商店」直接闪退。
      `PlayStore.enabled=${!!choice.playStore}`,
      // 快照完全由命令行 -snapshot apkstart 控制：用独立名字，绝不误加载
      // 旧版遗留的 default_boot（那是 API30 镜像的内存状态，加载必进引导循环）。
      'hw.sdCard=no',
      // 内置 Android Emulator 可以把主机麦克风暴露给安卓；默认开启，
      // 显式关闭才写 no。QEMU 后端不走这里，不能把这项 UI 误写成 QEMU 已支持。
      `hw.audioInput=${this.settings?.engine?.microphone === false ? 'no' : 'yes'}`,
      ...Object.entries(peripheralConfig).map(([name, value]) => `${name}=${value}`),
      'hw.gps=no',
      // 方向/加速度传感器必须开：关掉之后安卓拒绝旋转，横竖屏只能靠"转画面"糊弄，
      // 表现就是画面躺倒、排版不变。开了才能用 wm size 做真正的手机/平板排版切换。
      'hw.sensors.orientation=yes',
      'hw.sensors.accelerometer=yes',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    // /data 分区必须先「真的能用」，否则后面一切都是白等（见 ensureDataPartition 注释）
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      ok: data?.ok === true,
      ...(data?.ok === true ? {} : {
        code: data?.code || 'DATA_PARTITION_PREPARE_FAILED',
        error: `安卓 /data 分区准备失败：${data?.error || data?.reason || '无法确认分区可用'}；已停止启动，未清空用户数据`,
      }),
      home, avdDir, ini: path.join(home, `${this.avdName}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * 保证 userdata 分区是一个**真正可用**的 ext4 —— 这是「点开应用 30 秒进桌面」的地基。
   *
   * 为什么必须自己做（三条都是实测踩出来的）：
   *  1. 系统镜像包里的 userdata.img 是 1MB 全零占位，真正格式化靠 avdmanager 调 SDK 的
   *     mke2fs。ApkStart 直接写 config.ini 拉 emulator，跳过那一步 → /data 全零 →
   *     内核 "Invalid ext4 superblock on /dev/block/vdc" → guest 掉进 recovery 重启循环 →
   *     adbd 永远不上线 → 上层 probe 一直 pending，最后 240s 超时。原表现：点开要等好几分钟。
   *  2. emulator 自带的 e2fsck/resize2fs 是 cygwin 版 e2fsprogs 1.42.12，**不认识 encrypt
   *     特性**，带这个位它直接 exit 8 拒绝干活，所以「扩文件系统」必须排在补位之前。
   *  3. 文件系统必须 ≥ 分区大小：只给 64MB 的话，APEX 解压 + dexopt 立刻写满，
   *     之后所有 setxattr 返回 ENOSPC → SELinux 标签写不进去 → netd/media/tombstoned
   *     一起 exit 1 → 开机卡在启动动画，adb 永远 offline。
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    const fail = (operation, reason, error, extra = {}) => {
      const message = String(error?.message || error || reason);
      this.log(`userdata ${operation} 失败（已停止启动，未清空用户数据）：${message}`);
      return {
        ok: false, usable: false, operation, reason, error: message,
        code: operation === 'grow' ? 'DATA_PARTITION_RESIZE_FAILED' : 'DATA_PARTITION_PREPARE_FAILED',
        image: img, requestedBytes: wantBytes, ...extra,
      };
    };
    // 工具退出码为 0 也不能代替容量检查：文件扩了但 ext4 仍只有 64MB 同样不能开机。
    const verified = (file) => {
      const size = fs.statSync(file).size;
      const fsBytes = userdata.fsBytes(file);
      if (!userdata.hasExt4Superblock(file) || size < wantBytes
          || fsBytes < wantBytes * 0.95 || fsBytes > size) {
        throw new Error(`分区容量校验失败：需要 ${wantBytes} 字节，镜像 ${size} 字节，ext4 ${fsBytes} 字节`);
      }
      return { size, fsBytes };
    };
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) {
      return fail('prepare', 'no-emulator', '缺少模拟器运行时，无法准备 /data 分区');
    }
    let size = 0;
    let exists = false;
    try {
      fs.mkdirSync(avdDir, { recursive: true });
      try { size = fs.statSync(img).size; exists = true; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    } catch (e) { return fail('prepare', 'data-access', e); }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      const fsBytes = userdata.fsBytes(img);
      if (size >= wantBytes && fsBytes >= wantBytes * 0.95 && fsBytes <= size) {
        return { ok: true, usable: true, created: false, size, fsBytes, requestedBytes: wantBytes };
      }
      // 就地扩容只操作已有 ext4；无论工具在哪一步失败，都把 FBE 特性位补回去。
      // 失败后的文件系统未必仍一致，因此不再把「可能可用的旧容量」冒充成功继续启动。
      let failure = null;
      let repaired = false;
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        try { this._resize2fs(img); }
        catch (e) {
          if (!/e2fsck|run .*e2fsck|exit 8/i.test(String(e.message || e))) throw e;
          this._e2fsck(img);
          this._resize2fs(img);
          repaired = true;
        }
      } catch (e) { failure = e; }
      finally {
        try { userdata.setEncryptFlag(img); }
        catch (e) { failure = new Error(`${failure ? `${failure.message}；` : ''}恢复 FBE 特性位失败：${e.message}`); }
      }
      try {
        if (failure) throw failure;
        const actual = verified(img);
        this.log(`userdata 扩容完成：文件 ${size} → ${actual.size}，文件系统 ${fsBytes} → ${actual.fsBytes}`);
        return { ok: true, usable: true, created: false, grown: true, repaired, ...actual, requestedBytes: wantBytes };
      } catch (e) {
        return fail('grow', 'resize-failed', e, { created: false, size, fsBytes });
      }
    }

    // 不认识的旧镜像可能是加密/受损数据，不能因魔数检查失败就删掉它或其 qcow2。
    // 仅首次安装和已确认的小型全零占位允许自动建种子；未知数据交给显式修复流程。
    try {
      if (fs.existsSync(`${img}.qcow2`)) {
        return fail('prepare', 'unverified-overlay', '存在 userdata qcow2 数据但无法确认基础分区，已保留原文件', { created: false, size });
      }
      if (exists && size > 0 && (size > 1024 * 1024 || fs.readFileSync(img).some((byte) => byte !== 0))) {
        return fail('prepare', 'unverified-userdata', '现有 userdata 无法确认为 ext4 或空占位，已保留原文件；请先备份并检查运行时数据', { created: false, size });
      }
    } catch (e) { return fail('prepare', 'data-access', e, { created: false, size }); }

    // 在独立临时目录中完成首建/占位重建，全部校验成功才替换；失败不会留下可被误用的半成品。
    let staging = '';
    try {
      staging = fs.mkdtempSync(path.join(avdDir, '.userdata-'));
      const seed = path.join(staging, 'userdata-qemu.img');
      fs.writeFileSync(seed, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', seed, wantBytes);
      this._resize2fs(seed);
      userdata.setEncryptFlag(seed);
      const actual = verified(seed);
      fs.renameSync(seed, img);
      this.log(`已准备 userdata：${(actual.fsBytes / 1073741824).toFixed(1)}GB ext4（支持 FBE）`);
      return { ok: true, usable: true, created: true, rebuilt: exists, ...actual, requestedBytes: wantBytes };
    } catch (e) {
      return fail(exists ? 'rebuild' : 'create', 'create-failed', e, { created: true, size });
    } finally {
      if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* only our staging directory */ } }
    }
  }

  /** qemu-img：Windows 用 emulator 自带的；Linux 用系统的 qemu-utils（PATH）
   *  注意参数顺序：`qemu-img <命令> -f raw <文件> <大小>`。
   *  把 -f 放命令前面会被它当成全局参数直接报 unrecognized option。 */
  _qemuImg(op, ...rest) {
    const IS_WIN = process.platform === 'win32';
    const dir = path.dirname(this.locate().emulatorExe);
    const exe = IS_WIN ? path.join(dir, 'qemu-img.exe') : 'qemu-img';
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: IS_WIN ? dir : undefined, windowsHide: true, encoding: 'utf8',
    });
    if (r.error || r.status !== 0) throw new Error(`qemu-img ${op} 失败: ${r.error?.message || (r.stderr || '').trim() || r.signal || r.status}`);
  }

  /** e2fsck：修复异常中断留下的 dirty userdata 后再扩容。
   *  Windows 用 emulator 自带的 cygwin 版；Linux 用系统 e2fsprogs（几乎所有发行版都预装）。 */
  _e2fsck(img) {
    const IS_WIN = process.platform === 'win32';
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = IS_WIN ? path.join(bin, 'e2fsck.exe') : 'e2fsck';
    if (IS_WIN && !fs.existsSync(exe)) throw new Error('缺少 e2fsck.exe');
    const r = spawnSync(exe, ['-fy', img], {
      cwd: IS_WIN ? bin : undefined, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    // e2fsck: 0=clean, 1=修复完成；2/4/8 都表示不能安全继续。
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`e2fsck 失败: ${(r.stderr || r.stdout || '').trim() || r.status}`);
    }
  }

  /** resize2fs：Windows 用 emulator 自带的 cygwin 版（必须在 bin64 下找 DLL）；
   *  Linux 用系统 e2fsprogs，没装时给出明确的安装指引。 */
  _resize2fs(img) {
    const IS_WIN = process.platform === 'win32';
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = IS_WIN ? path.join(bin, 'resize2fs.exe') : 'resize2fs';
    if (IS_WIN && !fs.existsSync(exe)) throw new Error('缺少 resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: IS_WIN ? bin : undefined, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.error && r.error.code === 'ENOENT') {
      throw new Error('缺少 resize2fs：请安装 e2fsprogs（sudo apt install e2fsprogs）');
    }
    if (r.error || r.status !== 0) throw new Error(`resize2fs 失败: ${r.error?.message || (r.stderr || r.stdout || '').trim() || r.signal || r.status}`);
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读运行时（EXE 旁
    // resources/runtime）时 root/avd 不存在也不可写，AVD 要落到用户数据目录。
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbEnv = instanceAdb.environment(this._adbRoute);
    // opengl32sw.dll（Qt 软件 OpenGL 渲染器）在新版 Google emulator 包里已不再附带。
    // 缺失时 Qt 动态 GL 回退到系统 opengl32.dll —— 在部分显卡驱动上绘制全黑
    // （实测：窗口全黑但输入正常，安卓侧 screencap 有内容），或画面错乱。
    // 修复：deploy 时从 build/vendor/opengl32sw.dll 补位（Qt 5.15 官方组件，LGPL）；
    // 就位后强制 QT_OPENGL=software（CPU 渲染，任何 GPU 都稳定）。
    // 不要用 QT_OPENGL=angle：D3D11 交换链与 SetParent 嵌入冲突（失焦即黑屏、画面错乱）。
    const emuDir = path.dirname(this.locate().emulatorExe || '');
    const hasSwGL = emuDir && fs.existsSync(path.join(emuDir, 'opengl32sw.dll'));
    return {
      ...adbEnv,
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: String(this._adbRoute.port),
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(hasSwGL ? { QT_OPENGL: 'software' } : {}),
    };
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null, noVulkan = false,
  } = {}) {
    const args = [
      '-avd', this.avdName,
      // Carry unambiguous AVD-directory evidence into both launcher and QEMU command lines.
      '-datadir', path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`),
      '-port', String(port),
      // 音频：只有播放声音和麦克风都关闭时才禁用整个音频子系统。
      // emulator 没有一条已验证的「只关输出、保留输入」参数；不能为保留麦克风而误传 -no-audio。
      ...(this.settings?.engine?.audio === false && this.settings?.engine?.microphone === false
        ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // 关掉崩溃上报：一旦历史崩溃报告存在，emulator 会弹「同意上传」模态框，
      // 主线程被卡住、永远不开机（日志表现为 Showing crashdialog to get consent）。
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // 网络：AOSP 模拟器默认走 QEMU 用户态 NAT（-netdev user），安卓侧拿到
    // 10.0.2.x 的虚拟地址，出口直接复用主机的物理网卡 NAT 出去。
    // 这种模式【不会】在 Windows 上创建任何虚拟网卡 / 虚拟交换机
    // （那必须 -netdev tap 或桥接才会发生，我们全程不启用）。
    // 所以安卓应用用的是"一台挂在主机 NAT 后面的设备"，主机网络栈完全不动，
    // 不需要装驱动、也不多一个网络适配器。
    // 显式声明不限速：默认值虽然是 full，但某些 -gpu / -net 组合下会被带上
    // 模拟器的保守配置，视频类应用（红果、抖音）首屏就会明显慢半拍。
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // DNS：安卓默认用 10.0.2.3（转发到主机 DNS）。主机走 VPN / 公司网 / 某些运营商
    // 时，一次解析能拖到几百毫秒，表现为「页面转圈半天才开始加载」。给一份国内公共
    // DNS 作为首选，失败时系统仍会回退。用户可在设置里关掉（内网域名场景）。
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // 不能再传 -no-skin：上游实测它会覆盖上面的 -skin，让面板尺寸退回 config.ini
      // 的旧值 —— 表现就是「画面只占左上角一条 / 黑边 / 比例不对」。
      // 设备外壳本来就不会画（ShowDeviceFrame=no + 这组 style 参数）。
      // 注意：不能用 -qt-hide-window。它会让模拟器**根本不创建**那个 Qt 窗口，
      // 而窗口代理正是靠 SetParent 把这个窗口嵌进应用窗口来显示画面的 ——
      // 用了它之后 probe 永远找不到窗口，用户看到的是一个全黑的应用窗口。
      // 窗口的隐藏改由窗口代理常驻压制完成（见 win/agent.ps1 的 QuietSweep）。
    }
    // 快照统一由健康检查后的显式保存负责，禁止 emulator 退出时绕过运行中的开关
    // 自动保存。-no-snapshot-save 只禁退出保存，不影响控制台 snapshot save。
    // 冷启/重置仍使用同一个快照名，但 snapshot:false 必须优先于 wipe。
    const wantSnapshot = this.snapshotSaveAllowed({ snapshot });
    if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else {
      args.push('-snapshot', this.snapshotName, '-no-snapshot-save');
      if (wipe || !this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    }
    if (wipe) args.push('-wipe-data');
    // 系统语言**不在这里**改：实测 emulator 37.x 的 -prop 只接受 qemu.* 属性
    // （日志会写 `unexpected '-prop' value ... only 'qemu.*' properties are supported`），
    // 传 persist.sys.locale 会被直接丢弃。安卓 13+ 的系统语言走
    // `settings put system system_locales` + 重启，见 core/guest.js。
    // 对齐上游：只在明确关闭硬件加速时传 `-accel off`（配合 env 里的
    // ANDROID_I_WANT_MY_TCG）。绝不传 `-accel on` —— 上游实测 37.x 在部分
    // Windows/显卡组合下会因此以 0xC0000005 崩溃；不传参数走官方默认路径即可。
    if (accel === 'off') args.push('-accel', 'off');
    // 关掉 guest Vulkan 通道。英特尔核显 + 旧驱动在 Vulkan 初始化时会让 qemu 直接
    // 0xC0000005；-gpu 换的只是呈现方式，Vulkan 通道还是同一份代码，所以换后端绕不过。
    // 只在「上一轮崩在 Vulkan」时临时加，不影响正常机器（正常机器仍用 Vulkan）。
    if (noVulkan) args.push('-feature', '-Vulkan');
    args.push(...peripherals.buildEmulatorArgs(this.settings?.peripherals));
    return args;
  }

  /** 拉起单个进程（不做开机等待，开机等待在 start() 的 probe 循环里） */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
      noVulkan: plan.noVulkan,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: 让模拟器独立于 ApkStart 进程组。
      // Electron 退出时会把自己创建的 job 对象关掉，顺带把子进程一起杀掉——
      // 表现就是"关掉 ApkStart 再打开又要冷启动 20 多秒"。独立出去之后模拟器留着，
      // 下次启动直接接管（见 Runtime.adoptExisting），点开就是秒进。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`运行时已退出（code=${code}${meaning ? `，${meaning}` : ''}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu 是 detached 的独立进程，等它真正起来再把优先级降下来。
    // 不降的话 2~4 个 vCPU 线程会以 Normal 优先级和 Windows 桌面抢 CPU，
    // 用户最直观的感受就是「一打开 ApkStart，鼠标就发飘、整机变卡」。
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** 写模拟器日志：带大小滚动，避免长期使用把磁盘写满 */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** 当前 /data 镜像的实际情况（设置页展示用，不启动安卓也能取） */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* 还没建 */ }
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      configuredGB: Number(this.settings?.engine?.dataPartitionGB || 0),
    };
  }

  /**
   * 立即把 /data 分区扩容到指定大小（必须保证模拟器已停止，否则镜像被占用）。
   * 走的是 ensureDataPartition 的就地扩容路径：qemu-img resize + resize2fs，
   * 不重建、不丢已装应用与存档。
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`);
    return this.ensureDataPartition(dir, dataMB);
  }

  /**
   * 调整本实例运行时进程的优先级。
   *
   * 先枚举本实例进程树，再逐个用「真实模拟器路径 + 本 AVD 的
   * -datadir/-android-hw + 出生时间」验证，只把通过验证的 PID 交给脚本。
   * 绝不按进程名 / 命令行子串扫描：同机另一个模拟器可能用同一个 AVD 名。
   * level: idle（容器停放）| below（有应用在前台）| normal（性能优先）。
   */
  async setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return 0;
    let rootPid = this.proc && this.proc.pid ? Number(this.proc.pid) : 0;
    if (!rootPid) {
      const target = await this.ownedProcessOnPort().catch(() => null);
      rootPid = target ? Number(target.pid) : 0;
    }
    if (!rootPid) return 0;
    const tree = await processOwner.getProcessTree(rootPid);
    const verified = tree.filter((p) => this.ownsProcess(p));
    if (!verified.length) return 0;
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Pids', verified.map((p) => p.pid).join(','), '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Terminate verified processes only; a stale ChildProcess PID is not a capability. */
  async killAttempt() {
    const proc = this.proc;
    if (proc && proc.pid) {
      const info = await processOwner.getProcessInfo(proc.pid);
      if (await processOwner.terminateOwnedProcess(info, (p) => this.ownsProcess(p))) {
        if (this.proc === proc) this.proc = null;
      }
    }
    await this.killOrphanProcesses().catch(() => {});
  }

  /** Repair may terminate only this process's own foreground daemon handle. */
  async resetAdbServer() {
    const port = this.port;
    const target = await this._requireAdbTarget(null, port);
    const adbPath = this._adbRoute.isChild ? this._adbRoute.adbPath : this._adbInvocation('', []).adb;
    await instanceAdb.restartServer({ adbPath });
    await this._requireAdbTarget(target, port);
    // Child scanners are disabled: explicitly re-register only this birth-pinned
    // guest, retaining emulator-N rather than adding a generic TCP serial.
    await instanceAdb.registerEmulator(port + 1, {
      shouldConnect: async () => !!(await this._ownedAdbTarget(target, port)),
    });
    await this._requireAdbTarget(target, port);
    return true;
  }

  /** Startup/retry is ensure-only, never a reset of parent/sibling/unknown ADB. */
  async _resetAdbServer(adbPort = this.adbPort) {
    if (Number(adbPort) !== this._adbRoute.port) {
      const error = new Error('ADB 路由已固定，拒绝启动时改端口');
      error.code = 'INSTANCE_ADB_ROUTE_CHANGED';
      throw error;
    }
    const ready = await instanceAdb.ensureServer({ adbPath: this._adbInvocation('', []).adb });
    if (!ready) {
      const error = new Error('ADB 服务未确认就绪');
      error.code = 'INSTANCE_ADB_START_FAILED';
      throw error;
    }
    return true;
  }

  /**
   * 等待「spawn 后马上退」的情况。
   * 参数错误/DLL 缺失时 emulator 通常 1 秒内就退；进程还在则立刻返回，
   * 不必再干等固定 2.5 秒 —— 快照恢复时这段时间足够开机跑完一半。
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * 把「某一轮在拉起模拟器时抛的异常」记成一条 attempt。
   *
   * 单独抽出来有两个原因：
   *   1. 必须和正常失败分支写同样结构的记录，否则报告里缺 plan / params，
   *      作者只看得到一句异常消息；
   *   2. 可单测 —— start() 整条流程要真起模拟器，纯 Node 测试里跑不动。
   */
  _recordSpawnError({ plan = {}, logStart = 0, error, onLog = () => {} } = {}) {
    const msg = String((error && error.message) || error || '未知错误').replace(/\s+/g, ' ').slice(0, 300);
    this.log(`启动异常（${plan.label || '未知参数'}）：${msg}`);
    onLog(`启动异常（${msg}），换一组参数重试…`);
    // 异常消息本身也可能带可识别特征（DLL 缺失 / 路径含中文 / AVD 锁）
    const fromLog = doctor.diagnose([...this._attemptLines(logStart, 60), msg]);
    const d = fromLog.code === 'UNKNOWN' ? doctor.spawnErrorDiagnosis(msg) : fromLog;
    this.attempts.push({
      plan: plan.label || '未知参数', diagnosis: d.code, exitCode: this.lastExitCode,
      params: doctor.describeAttempt(plan), gpu: plan.gpu, accel: plan.accel,
      acceleration: this._accelerationState(plan, this._attemptLines(logStart, 600)), error: msg,
    });
    this.lastDiagnosis = d;
    return d;
  }

  /**
   * 体检虚拟机内是否真的能联网。
   *
   * 为什么需要这一步：安卓虚拟机的 Wi-Fi 配置存在 /data 里，一旦写坏（典型表现是
   * `cmd wifi list-networks` 里同一个 AndroidWifi 出现两条、网络 id 撞车），
   * wlan0 就会一直 NO-CARRIER、拿不到 IP。这时「需要联网的页面」在应用里就是一块
   * 黑屏 —— 用户看到的「红果点同意后黑屏」就是这么来的，跟 GPU/渲染完全无关。
   *
   * @param {string} [adbPath] 显式指定 adb 可执行文件（Runtime 有更权威的解析）
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const port = this.port;
    const target = await this._requireAdbTarget(null, port);
    const sh = (cmd, timeout = 8000) => this._guestShell(adbPath, cmd, target, port, { timeout });
    // 安卓的多路由表会让 `ip route` 的主表看起来是空的（默认路由在 per-interface 表里），
    // 而且 shell 的 uid 不在应用的 network 组里，`ping` 经常误报 "Network is unreachable"，
    // 哪怕 Wi-Fi 其实已经连上、应用也能正常上网。所以这里只认「有没有拿到 IPv4 地址」，
    // 再叠加 `cmd wifi status` 的连接状态做交叉确认，不用 ping 判断。
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wi[- ]?Fi\s+is\s+connected/i.test(wifi);
    const disconnected = /(?:Wi[- ]?Fi|wifi)\s+(?:is\s+)?(?:disconnected|disabled|unavailable|not\s+connected)/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi 关联 + DHCP 往往比 sys.boot_completed 晚几十秒才完成。
      // 调用方给了 waitMs 就继续等，不要在这一刻就断定「没有网络」。
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    if (disconnected) return { ok: false, reason: 'wifi-not-connected', addrs: ips };
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected };
  }

  /**
   * 轻量修复虚拟机的 Wi-Fi 关联 —— 不抹数据、不重装应用。
   *
   * 病根（实测）：模拟器被强杀 / 异常退出后，`/data` 里的 WifiConfigStore 会被写坏
   * （典型样本：同一个 AndroidWifi 存了两份、network id 撞车）。此时扫描明明能看到
   * AP（RSSI -50），wpa_supplicant 却永远停在 disconnected——wlan0 一直 NO-CARRIER、
   * 拿不到 IP，联网应用打开就是一块黑屏。
   *
   * 修法（由轻到重）：
   *   1. 关/开 wifi 电台，逼系统重扫重连（够用就到此为止）；
   *   2. 清掉保存网络（forget 掉撞车的 id），在 WLAN 设置页点一下该 AP 重新保存关联。
   *      uiautomator dump 拿列表项的精确 bounds 再点，不靠猜坐标。
   *
   * @returns {Promise<{ok:boolean, fixed:boolean, reason?:string}>}
   */
  async repairWifi(adbPath = '', onLog = () => {}) {
    const port = this.port;
    const target = await this._requireAdbTarget(null, port);
    // Preserve stderr on command failure (SecurityException triggers the UI
    // fallback), but ownership loss rejects immediately instead of continuing.
    const sh = (cmd, timeout = 10000) => this._guestShell(adbPath, cmd, target, port, { timeout, includeErrors: true });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 0) 已经连着就不用修
    const before = await sh('cmd wifi status');
    if (/Wifi is connected/i.test(before)) {
      const ip = await this.checkNetwork(adbPath).catch(() => null);
      if (ip && ip.ok) return { ok: true, fixed: false, reason: 'already-connected' };
    }

    // 1) 先试最便宜的一招：关掉再打开 wifi 电台，逼系统重扫重连。
    //    多数「只是没关联上」的情况这一步就够（不用动车上的保存网络）。
    await sh('cmd wifi set-wifi-enabled disabled');
    await sleep(1500);
    await sh('cmd wifi set-wifi-enabled enabled');
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500);
      // eslint-disable-next-line no-await-in-loop
      const st = await this.checkNetwork(adbPath).catch(() => null);
      if (st && st.ok) return { ok: true, fixed: true, reason: 'radio-cycle' };
    }

    // 2) 还是不行：清掉保存网络重新关联。
    //    实测病态样本：list-networks 里同一条 AndroidWifi 存了两份、network id 撞车，
    //    系统会一直停在 disconnected。forget 掉那个 id 会把同 id 的记录一起清掉，
    //    然后走设置页点一下重新保存（开放网络无需密码）。
    const list = await sh('cmd wifi list-networks');
    const ids = new Set();
    for (const line of String(list).split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+\S/.exec(line);
      if (m) ids.add(m[1]);
    }
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await sh(`cmd wifi forget-network ${id}`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }

    // 3) 重新保存并关联：优先用 shell 命令（部分镜像开放权限）
    const conn = await sh('cmd wifi connect-network AndroidWifi open', 8000);
    if (/SecurityException|Exception|doesn't exist/i.test(conn)) {
      // 4) 回退到 UI：打开 WLAN 设置 → 等扫描出 AndroidWifi → 按节点 bounds 点它。
      //    实测坑：刚 forget 完、设置页刚打开时列表还是空的（等扫描 3~8 秒），
      //    所以这里必须轮询重试，dump 太早会拿不到节点。
      await sh('am start -a android.settings.WIFI_SETTINGS');
      await sleep(3000);
      let tapped = false;
      for (let attempt = 0; attempt < 10 && !tapped; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(2500);
        // eslint-disable-next-line no-await-in-loop
        const dump = await sh('rm -f /sdcard/wifi_ui.xml; uiautomator dump /sdcard/wifi_ui.xml >/dev/null 2>&1; cat /sdcard/wifi_ui.xml', 15000);
        const m = /text="AndroidWifi"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump)
          || /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="AndroidWifi"/.exec(dump);
        onLog(`Wi-Fi 修复：第 ${attempt + 1} 次查找${m ? '命中' : '未命中'}（界面 ${dump.length} 字节）`);
        if (!m) continue;
        const cx = Math.round((Number(m[1]) + Number(m[3])) / 2);
        const cy = Math.round((Number(m[2]) + Number(m[4])) / 2);
        // eslint-disable-next-line no-await-in-loop
        await sh(`input tap ${cx} ${cy}`);
        onLog(`Wi-Fi 修复：已点击 AndroidWifi（${cx},${cy}）`);
        tapped = true;
        // eslint-disable-next-line no-await-in-loop
        await sleep(1500);
        // 开放网络通常直接连；个别镜像会弹确认框，有就点掉
        // eslint-disable-next-line no-await-in-loop
        const dump2 = await sh('uiautomator dump /sdcard/wifi_ui2.xml >/dev/null 2>&1; cat /sdcard/wifi_ui2.xml', 12000);
        const btn = /text="Connect"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(dump2);
        if (btn) {
          // eslint-disable-next-line no-await-in-loop
          await sh(`input tap ${Math.round((Number(btn[1]) + Number(btn[3])) / 2)} ${Math.round((Number(btn[2]) + Number(btn[4])) / 2)}`);
          // eslint-disable-next-line no-await-in-loop
          await sleep(1200);
        }
      }
    }

    // 4) 等 DHCP 完成再判定（association + DHCP 通常 2~8 秒，慢的时候 20 秒）
    for (let i = 0; i < 14; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500);
      // eslint-disable-next-line no-await-in-loop
      const st = await this.checkNetwork(adbPath).catch(() => null);
      if (st && st.ok) {
        // 回到桌面 / 关掉设置页，别把用户停在设置里
        await sh('input keyevent KEYCODE_HOME');
        return { ok: true, fixed: true };
      }
    }
    await sh('input keyevent KEYCODE_HOME');
    return { ok: false, fixed: true, reason: 'still-no-ip' };
  }

  /**
   * 启动 + 自动重试。
   * @param {Function} probe 异步回调，返回 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4, lcdOrientation = '', lowspec = false, timeoutMs = 0 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('未安装运行时引擎，请先在「运行时」页完成部署');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('系统镜像未就绪，请先在「运行时」页下载 Android 系统镜像');
    }

    const s = this.settings;
    // 开机前先看一眼磁盘：模拟器写的是 AVD（数据分区 + 快照，几个 GB），
    // 只有它所在磁盘的余量才决定能不能开机；运行时目录只写日志，要求低得多。
    // 之前把两者的余量取最小值，结果「数据目录已经挪到 D 盘、C 盘只剩 400MB」
    // 会被误判成磁盘不足 —— 挪盘等于白挪。
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `磁盘空间不足：安卓数据目录（${avdHome}）所在磁盘只剩 ${(avdFreeMB / 1024).toFixed(1)} GB，`
        + `运行时至少要 ${(needMB / 1024).toFixed(1)} GB 可用。请在「设置 → 系统集成 → 安卓数据目录」`
        + '把它改到空间充足的盘（例如 D:），或先清理磁盘。你的应用与存档不会被自动删除。';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `运行时目录（${loc.root}）所在磁盘只剩 ${(diskMB / 1024).toFixed(1)} GB，`
        + '连日志和临时文件都写不下。请清理磁盘，或把「运行时数据目录」也换到别的盘。';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    let adbPort;
    let accelInfo;
    let verInfo;
    let startPort;
    try {
      adbPort = await doctor.freeAdbPort();
      this.adbPort = adbPort;
      // Independent read-only checks + ensure-only ADB readiness. Retry never
      // resets a live service or issues kill-server against an unknown listener.
      const results = await Promise.all([
        this.provisioner.emulatorAccel(),
        this.provisioner.emulatorVersion(),
        doctor.freePortPair(5554),
        this._resetAdbServer(adbPort),
      ]);
      [accelInfo, verInfo, startPort] = results;
      if (results[3] === false) throw new Error('ADB 服务未就绪');
    } catch (error) {
      const code = error.code || 'INSTANCE_ADB_START_FAILED';
      const message = `ADB 服务准备失败，已停止启动：${error.message || error}`;
      const diagnosis = { code, title: 'ADB 服务未就绪', hint: message };
      this.lastDiagnosis = diagnosis;
      this.attempts = [{ stage: 'adb', diagnosis: code, error: message }];
      this.log(message);
      onLog(message);
      this._persistFailure({ why: 'adb' });
      return { ok: false, code, error: message, diagnosis, attempts: this.attempts, exitCode: null };
    }
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;
    this._detectedAccel = accelInfo;

    // 与设置页共用选档入口；检测结果只影响选档，实际传参与日志确认另行记录。
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    // 「低配模式」：一键修复里由用户点一下才启用，只对本次启动生效，不写进设置。
    // 目的不是让机器变快，而是让「本来就慢但能跑」的机器有机会开完机：
    // 降分辨率/减 vCPU 少抢资源，关快照避免加载失败后白等，并给足超时。
    // 具体数值复用 doctor.lowSpecProfile()，别再在这里写第二份「2 核 / 2G」。
    if (lowspec) {
      const tuned = doctor.lowSpecProfile({
        host: profile.host, emulatorVersion: emuVersion, diskMB,
      });
      profile.memoryMB = Math.min(profile.memoryMB, tuned.memoryMB);
      profile.cores = Math.min(profile.cores, tuned.cores);
      profile.lcd = doctor.lcdFor({ accelOk: false });
      profile.snapshot = false;
      profile.lowspec = true;
      onLog(`已切到低配模式：${profile.lcd.w}x${profile.lcd.h} · ${profile.cores} 核 · ${profile.memoryMB}MB · 不存快照`);
    }
    if (Number(timeoutMs) > 0) {
      profile.bootTimeoutMs = Math.max(profile.bootTimeoutMs || 0, Number(timeoutMs));
    }
    profile.acceleration = this._accelerationState(profile);
    this.profile = profile;
    // 只有明确选择「始终嵌入」时才为跨进程 SetParent 保留 swangle 优先级。
    // auto 模式先用自动档的 host 后端，避免视频应用默认走软件渲染而卡顿；
    // 如果宿主画黑，appwin 会摘出为独立窗口并记住 embeddedBlack，下一次不再嵌入。
    // standalone 同样遵循自动档选出的 GPU，不强行走 CPU 软件渲染。
    const { windowMode } = s.engine;
    const preferSoftware = !headless && require('./platform').canEmbed && windowMode === 'embedded';
    const variants = doctor.planVariants(profile, { preferSoftware }).slice(0, maxAttempts);
    // 报告里要写清这次是「带窗口」还是「无窗口」跑的：同一台机器上两者结果常常不同，
    // 少了这一个 bit，报告就没法区分「模拟器起不来」和「带窗口渲染起不来」（issue #29）。
    this.headlessMode = !!headless;

    // 记住「上次拉起就崩」的 GPU 后端，下次把它排到最后。
    // 实测：AMD Radeon 780M 上 `-gpu host` 能通过 emulator 自己的硬件检查，
    // 但 VM 起来十几秒后进程直接 exit 1（日志里只有 "AEHD is operational"），
    // 每次都要白等 20 多秒再退到 swangle。key 里带上 emulator 版本，
    // 升级运行时后自动重新给它一次机会。
    const badGpuKey = s.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (!profile.gpuPinned && badGpu && badVer === emuVersion) {
      const firstGpu = variants[0]?.gpu;
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (firstGpu === badGpu && variants[0].gpu !== badGpu) {
        onLog(`上次 ${badGpu} 渲染后端启动即崩溃，本次改用 ${variants[0].gpu} 先试`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${this.describeProfile(this.profile || profile)} ===\n`);

    // 屏幕规格在整个启动过程中保持一致，否则每次重试都换分辨率会狂清快照。
    // 分辨率来自 doctor 的 profile（设置里可改「画质」），auto 时按加速状态选。
    // 横屏应用（清单里 screenOrientation=landscape）转 90°：模拟器窗口比例由 LCD
    // 决定、开机锁死，这是唯一能让游戏铺满窗口的办法（issue #41）。
    const baseScreen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    const screen = doctor.orientLcd(baseScreen, lcdOrientation);
    this.lcd = { ...screen };
    if (lcdOrientation && screen !== baseScreen) {
      onLog(`按应用方向使用${screen.w > screen.h ? '横屏' : '竖屏'} LCD：${screen.w}x${screen.h}`);
    }
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // 冷启前先清孤儿：上一次运行留下的 qemu 仍占着 AVD 锁时，
    // 所有尝试都会立刻 FATAL "Running multiple emulators with the same AVD"。
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    // 「修复网络」要求抹掉用户数据。这个标记只对本次 start() 有效：
    // 在循环外取快照并立刻清掉一次性标记，既保证重试轮次仍然带着 -wipe-data，
    // 又保证用户下次正常点开应用时绝不会莫名其妙被清数据。
    const forceWipe = !!this._forceWipe;
    this._forceWipe = false;
    let lastLogStart = this._logSeq;

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // 端口占用也会导致失败，每次重试重新探测一次
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      plan.acceleration = this._accelerationState(plan);
      // 关加速的兜底不能沿用自动档里「检测通过」的 accelOk 当作本轮实际状态。
      if (plan.accel === 'off') plan.accelOk = false;
      this.port = port;
      // 本轮可能因完全不同的原因失败；只通过 attempts 保留上一轮的结论。
      this.lastDiagnosis = null;
      this.lastExitCode = null;
      // 日志也按轮切分：环形缓冲区满后不能用数组长度作为分界。
      const logStart = this._logSeq;
      lastLogStart = logStart;
      onLog(`启动运行时（第 ${i + 1}/${variants.length} 次：${plan.label}）…`);

      try {
        const avd = this.ensureAvd({
          ...plan,
          // forceWipe 也要参与「删旧快照」：重置数据后旧快照必然加载失败
          // （实测报 Failed to load snapshot 后退回冷启动），必须先清掉再重建。
          wipe: plan.wipe || !!this.wipePending || forceWipe,
        });
        // /data 准备失败不是 GPU/加速降级能修好的问题，必须在任何 spawn 前收工。
        // 同时检查顶层和分区结果，避免旧适配器只返回 data.ok:false 时被忽略。
        if (!avd || avd.ok === false || avd.data?.ok === false) {
          const error = avd?.error || `安卓 /data 分区准备失败：${avd?.data?.error || avd?.data?.reason || '无法确认分区可用'}`;
          const code = avd?.code || avd?.data?.code || 'DATA_PARTITION_PREPARE_FAILED';
          const diagnosis = { code, title: '安卓数据分区准备失败', hint: error };
          this.lastDiagnosis = diagnosis;
          this.attempts.push({
            plan: plan.label, stage: 'data-partition', diagnosis: code, error,
            params: doctor.describeAttempt(plan), gpu: plan.gpu, accel: plan.accel,
            data: avd?.data || null,
          });
          onLog(`${error}；已停止启动，不会通过切换参数或清空数据重试。`);
          this._persistFailure({ profile: plan, why: 'data-partition', data: avd?.data || null });
          return { ok: false, code, error, diagnosis, data: avd?.data || null, attempts: this.attempts, exitCode: null };
        }
        // 埋点：上层（main）用它在拉起模拟器**之前**打开黑窗压制。
        // 控制台窗口在 spawn 之后几十毫秒就冒出来，事后再补一次扫描必然闪一下，
        // 所以这里必须先把它打开、再拉起进程。
        if (this.onBeforeSpawn) {
          // eslint-disable-next-line no-await-in-loop
          try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
        }
        // eslint-disable-next-line no-await-in-loop
        this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
        this.profile = plan;
        // _coldBoot 只对这次 spawn 生效，避免之后每次开机都退化成长时间冷启动
        this._coldBoot = false;
        // 参数错误 / DLL 缺失会立刻退出
        // eslint-disable-next-line no-await-in-loop
        const dead = await this._waitSpawnSettled(2200);
        plan.acceleration = this._accelerationState(plan, this._attemptLines(logStart, 600));
        if (dead || !this.proc) {
          const earlyLines = this._attemptLines(logStart, 60);
          let d = doctor.diagnose(earlyLines);
          // 检测说有加速、日志里却连「accelerator ... operational」都没有就退了：
          // 这不是渲染/镜像问题，是驱动没接管。旧逻辑在这里只能给 UNKNOWN
          // （日志里一条错误都没有，所有正则都落空），用户拿着报告也无从下手。
          const early = plan.accel === 'off' ? null : doctor.earlyAccelExit({
            accel: accelInfo, logLines: earlyLines, exitCode: this.lastExitCode,
          });
          if (early && ['UNKNOWN', 'ACCEL'].includes(d.code)) d = early;
          this.attempts.push({
            plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode,
            // 实际参数：失败后用户/作者都要能看出「这一轮到底用了多保守的配置」，
            // 只看 label（gpu / 加速方式）是不够的。
            params: doctor.describeAttempt(plan),
            gpu: plan.gpu, accel: plan.accel, acceleration: plan.acceleration,
          });
          this.lastDiagnosis = d;
          lastError = `${d.title}：${d.hint}`;
          // 磁盘写满不是「换组参数就能好」的问题：继续重试只会反复失败，
          // 而且历史上最后那组参数带 wipe，会把用户数据一起抹掉。直接收工、如实报错。
          if (d.code === 'DISK_FULL') {
            onLog('磁盘空间不足，已停止重试（不会动你的应用与存档）。');
            this._persistFailure({
              profile, profileText: this.describeProfile(this.profile || profile),
              tuning: doctor.describeTuning(profile), why: 'disk-full',
            });
            return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
          }
          // 加速/镜像类结论可能是缓存里的旧数据，作废掉，下次启动重新探测
          if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
          }
          // 先判断严重崩溃熔断，再考虑 Vulkan/GPU 方向的普通降级：一旦同一个
          // 访问冲突已经跨参数重复，继续换端口只会再启动一个可能不稳定的实例。
          const tcgCrash = this._softwareTcgCrashed(plan, d);
          const repeatedCrash = !tcgCrash && this._repeatedAccessViolation(d);
          if (tcgCrash || repeatedCrash) {
            d = tcgCrash ? doctor.tcgCrashDiagnosis() : doctor.repeatedCrashDiagnosis();
            this.lastDiagnosis = d;
            lastError = `${d.title}：${d.hint}`;
            onLog(`${d.title}，本轮不会继续换端口或启动更多实例。`);
            await this.killAttempt().catch(() => {});
            break;
          }
          // 崩在 Vulkan：下一轮改成「同后端 + 关 Vulkan」，比继续换后端更有针对性
          if (this._preferNoVulkan(variants, i, d, earlyLines)) {
            onLog('日志里有 Vulkan 初始化痕迹，下一轮关掉 Vulkan 再试…');
          }
          onLog(`${d.title}，自动换一组参数重试…`);
          this._noteGpuFailure(plan);
          continue;
        }

        if (!probe) {
          // The visible-window path may have selected a fallback plan (for example
          // swangle after host rendering fails). Keep the plan that actually got
          // spawned so status/doctor:profile can distinguish the running VM from
          // the next-start profile shown in Settings.
          this.profile = plan;
          return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile: plan, attempts: this.attempts };
        }

        const started = Date.now();
        const timeout = doctor.bootTimeoutFor(plan);
        let ok = false;
        let fatal = false;
        let sawBooting = false;
        // 快照恢复往往几秒内就能起，固定 3 秒一次意味着平均要多等 1.5 秒才「发现」
        // 它已经好了。这里从 200ms 起步逐步放宽到 1.2 秒：开机早期能立刻抓到，
        // 长引导过程也不会把 CPU 花在轮询上。
        let interval = 200;
        let lastNotice = 0;
        // eslint-disable-next-line no-await-in-loop
        while (Date.now() - started < timeout) {
          if (!this.proc) { fatal = true; break; }
          let state = 'pending';
          try {
            // eslint-disable-next-line no-await-in-loop
            state = await probe({ serial: this.serial, port, adbPort });
          } catch (_) { state = 'pending'; }
          if (state === 'ok') { ok = true; break; }
          if (state === 'fatal') { fatal = true; break; }
          // 只要 adb 能执行 shell，说明内核已经在引导，日志里的普通 Vulkan/EGL 信息不算失败
          if (state === 'booting') sawBooting = true;
          // 45 秒仍完全没连上，且日志出现明确致命错误 → 提前换方案，不干等 4 分钟
          if (!sawBooting && Date.now() - started > 45000) {
            const d = doctor.diagnose(this._attemptLines(logStart, 80));
            if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
              this.lastDiagnosis = d;
              try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
              fatal = true;
              break;
            }
          }
          // 每 15 秒一条进度：以前用「取模」判断，自适应间隔下会连着打两三条重复的
          if (Date.now() - lastNotice > 15000) {
            lastNotice = Date.now();
            onLog(`正在开机… ${Math.round((Date.now() - started) / 1000)}s`);
          }
          // eslint-disable-next-line no-await-in-loop
          await sleep(interval);
          interval = Math.min(1200, Math.round(interval * 1.6));
        }

        plan.acceleration = this._accelerationState(plan, this._attemptLines(logStart, 600));
        if (ok) {
          const bootMs = Date.now() - started;
          // `profile` is the desired auto profile, while `plan` is the concrete
          // attempt that reached Android. A visible launch can fall back from
          // host to swangle/software without changing the user's settings; keep
          // the concrete plan for runtime status and diagnostics.
          this.profile = plan;
          // 这一次真的起来了：清掉上次的失败记录，避免以后「诊断」翻出旧账
          this._clearFailure();
          // 快照只在设置、实际运行档与保存策略均允许时保存；显式 false 不因开机成功被覆盖。
          // 装完新应用时 installer 会作废旧快照，避免恢复后应用消失。
          if (this.snapshotWorthSaving !== false) this.snapshotWorthSaving = true;
          onLog(`运行时就绪（${Math.round(bootMs / 1000)}s，${plan.label}）`);
          // 开机成功不等于能用：顺手体检网络。虚拟机没网时，需要联网的页面会一直黑屏，
          // 用户只会说「这个应用黑屏」，很难联想到是网络。这里主动查一次并说清楚。
          let network = null;
          try { network = await this.checkNetwork(); } catch (_) { /* 体检失败不算启动失败 */ }
          // 没网时先自动修一次 Wi-Fi 关联（清撞车的保存网络 + 点一下重新关联），
          // 修好了用户就完全无感；修不好才提示，且不再劝用户「重置数据」——
          // 那会白丢已装应用，而真正的病根只是一份写坏的 wifi 配置。
          if (network && !network.ok) {
            onLog('检测到虚拟机网络异常，正在自动修复 Wi-Fi 关联…');
            const rep = await this.repairWifi('', onLog).catch(() => null);
            if (rep && rep.ok) {
              onLog('虚拟机网络已恢复');
              network = await this.checkNetwork().catch(() => network);
            } else if (rep) {
              onLog(`Wi-Fi 自动修复未成功（${rep.reason || 'unknown'}）`);
            }
          }
          if (network && !network.ok) {
            onLog('⚠ 安卓虚拟机当前没有网络：需要联网的应用打开后会一直黑屏。'
              + '可在「设置 → 修复网络」重置安卓数据来修（应用清单会保留，点开时会自动重装）。');
          }
          return {
            ok: true, serial: this.serial, port, accel: accelInfo, logFile,
            profile: plan, attempts: this.attempts, bootMs, quickBoot: true, network,
          };
        }

        const attemptLines = this._attemptLines(logStart, 80);
        // 先看本轮尾部日志。若未识别，可回用本轮提前检测到的故障，不能借上一轮的结论。
        let d = doctor.diagnose(attemptLines);
        if (fatal && (!d || d.code === 'UNKNOWN') && this.lastDiagnosis) d = this.lastDiagnosis;
        // 进程没崩、只是等到超时：结论就该是「太慢」，不能被日志里的 CPUID 警告
        // 或 UNKNOWN 抢走。否则用户拿着「CPU 缺少指令集」去换镜像，永远修不好。
        if (!fatal && ['UNKNOWN', 'CPU_FEATURE'].includes(d.code)) {
          d = doctor.timeoutDiagnosis({
            accelOk: !!(accelInfo && accelInfo.ok),
            seconds: Math.round((Date.now() - started) / 1000),
          });
        }
        // 进程死了却没有任何可识别的错误行，而本机号称有加速：落到「加速器没接管」。
        // 用户报的那份报告正好走这条路径（日志停在 Userspace boot properties，退出码 1）。
        if (fatal && d.code === 'UNKNOWN') {
          const early = plan.accel === 'off' ? null : doctor.earlyAccelExit({
            accel: accelInfo, logLines: attemptLines, exitCode: this.lastExitCode,
          });
          if (early) d = early;
        }
        this.attempts.push({
          plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode,
          params: doctor.describeAttempt(plan),
          gpu: plan.gpu, accel: plan.accel, acceleration: plan.acceleration,
        });
        // 访问冲突熔断必须在 Vulkan/GPU 普通降级之前判断；否则会先标记显卡失败，
        // 下一轮换端口继续启动 QEMU，正是上游 #127 报告的高风险循环。
        const tcgCrash = this._softwareTcgCrashed(plan, d);
        const repeatedCrash = !tcgCrash && this._repeatedAccessViolation(d);
        if (tcgCrash || repeatedCrash) {
          d = tcgCrash ? doctor.tcgCrashDiagnosis() : doctor.repeatedCrashDiagnosis();
          this.lastDiagnosis = d;
          lastError = `${d.title}：${d.hint}`;
          onLog(`${d.title}，本轮不会继续换端口或启动更多实例。`);
        } else {
          this.lastDiagnosis = d;
          lastError = `${d.title}：${d.hint}`;
          onLog(`${lastError}，自动换一组参数重试…`);
          this._noteGpuFailure(plan);
          // 同上：崩在 Vulkan 时优先关 Vulkan，而不是继续换呈现后端
          if (this._preferNoVulkan(variants, i, d, attemptLines)) {
            onLog('日志里有 Vulkan 初始化痕迹，下一轮关掉 Vulkan 再试…');
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await this.killAttempt();
        if (tcgCrash || repeatedCrash) break;
      } catch (e) {
        // 这一轮连模拟器都没拉起来：AVD 目录不可写、运行时文件被杀软删掉、参数构造失败…
        // 旧实现让异常直接冒到上层 —— start() 整个 reject，重试循环停在第 1 轮，
        // 报告里只剩一条 attempt，却仍然写着「已自动按多种参数组合重试」（用户实测现场）。
        // 现在把它也记成一次失败的尝试，继续下一组参数。
        const d = this._recordSpawnError({ plan, logStart, error: e, onLog });
        lastError = `${d.title}：${d.hint}`;
        // 异常轮也可能留下 detached 的 qemu，下一轮会被 AVD 锁挡死
        // eslint-disable-next-line no-await-in-loop
        await this.killAttempt().catch(() => {});
        continue;
      }
    }

    // 全部组合都失败、而且本机根本没有加速：给一句能照做的结论，
    // 别再让用户对着「UNKNOWN + 已自动重试」猜（issue #20/#6/#15/#31）。
    const lastAttemptLines = this._attemptLines(lastLogStart, 300);
    let d = this.lastDiagnosis || doctor.diagnose(lastAttemptLines);
    if ((!d || d.code === 'UNKNOWN') && accelInfo && !accelInfo.ok) d = doctor.noAccelDiagnosis();
    // 兜底也只看最后一轮，不能借之前的加速日志判断这次是否接管。
    if ((!d || d.code === 'UNKNOWN') && this.profile?.accel !== 'off') {
      d = doctor.earlyAccelExit({
        accel: accelInfo, logLines: lastAttemptLines, exitCode: this.lastExitCode,
      }) || d;
    }
    this.lastDiagnosis = d;
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        // 加速探测的原始结论：AEHD「装了但服务没跑」时这里带 suspect 标记，
        // 报告里能直接看出「程序当时以为有加速」，而不是反复怀疑显卡。
        accel: accelInfo || null,
        acceleration: this.profile?.acceleration || null,
        actualProfile: this.profile,
        // 日志里那些「看着像错误、其实无害」的行，报告里主动解释一句，
        // 省得用户拿 "host doesn't support requested feature" 去查错方向。
        notes: doctor.notes(this.recentLog(300)),
        image: choice,
        lowspec: !!profile.lowspec,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        sessionLog: this.tailAppLog(200),
        runtimeState: { visible: !this.headlessMode, attempts: this.attempts.length },
      },
    });
    // 带窗口模式全挂时，把「这是可见模式的失败」说清楚（issue #29）：
    // 那台机器 headless 正常、带窗口 vCPU 不启动，用户看报告只看到一堆 GPU 变体，
    // 完全分不清是模拟器坏了还是「窗口渲染」这条链路坏了。
    const visibleHint = headless ? '' : (
      '\n\n本次是带窗口模式（画面上要嵌进应用窗口）。如果同一台机器上「无窗口模式」能起来、'
      + '只有带窗口起不来，那是宿主 GPU/Vulkan 驱动与模拟器 Qt 窗口的冲突，不是安卓镜像的问题：'
      + '在「设置 → 渲染后端」手动指定 swangle 或 software 再试一次。'
    );
    const customHint = choice && choice.custom
      ? `\n当前使用的是自定义镜像「${choice.name}」（${choice.dir}）。`
        + '如果它在这台机器上起不来，请在「设置 → 自定义安卓镜像」里点「恢复默认镜像」再试 —— '
        + '默认的 Android 14 Google Play 镜像与它的数据是分开存放的，切换不会丢已装应用。'
      : '';
    const err = new Error(
      `运行时多次尝试仍未能启动（${d.title}）。\n${d.hint}\n\n`
      // 低配机器上最常被问的一句是「你到底给我分配了什么」。这行就是实跑参数，
      // 与设置页展示、诊断报告里的是同一份（doctor.describeProfile）。
      + `实际参数：${this.describeProfile(this.profile || profile)}\n`
      + `已尝试：${this.attempts.map((a) => `${a.plan}${a.params ? `（${a.params}）` : ''} → ${a.diagnosis}`).join('；')}\n`
      + `${customHint ? `${customHint.trim()}\n` : ''}`
      + `诊断报告：${report.file}${visibleHint}`,
    );
    err.diagnosis = d;
    err.terminal = d && d.terminal === true;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({
      profile, profileText: this.describeProfile(this.profile || profile),
      tuning: doctor.describeTuning(profile), why: 'boot-failed', report: report.file,
      // 本次用的是哪套镜像：进程重启后仍要能回答「是不是我换的镜像导致的」
      image: choice && {
        custom: !!choice.custom, id: choice.id || '', name: choice.name || '',
        api: choice.api || '', abi: choice.abi || '', dir: choice.dir || '',
      },
    });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * 当前运行时的 LCD 方向。未知（还没启动过）按竖屏处理 —— 那是绝大多数应用的方向，
   * 也是老版本一直以来的行为，不能因为「读不到」就把窗口弄成横的。
   */
  get lcdOrientation() {
    return this.lcd && this.lcd.w > this.lcd.h ? 'landscape' : 'portrait';
  }

  /** 从已运行的设备读回真实 LCD（接管上一会话遗留的模拟器时，不知道当时的启动参数） */
  learnLcd(size) {
    if (!size || !size.width || !size.height) return;
    this.lcd = { w: size.width, h: size.height, dpi: (this.lcd && this.lcd.dpi) || 0 };
  }

  /**
   * 保存 quickboot 快照（下次开机直接恢复内存状态，像 WSA/应用宝的快速启动）。
   *
   * 时机很重要：以前的实现是开机后 6 秒就存，正好和用户点开应用抢磁盘 I/O
   * （快照要写 1~3GB），体感反而更慢。改成「空闲时再存」，并由 Runtime 在
   * 最后一个应用窗口关闭时触发；关机前若还没来得及存，也会补一次。
   */
  snapshotSaveAllowed(profile = this.profile) {
    return this.settings?.engine?.keepSnapshot !== false
      && profile?.snapshot !== false && this.snapshotWorthSaving !== false;
  }

  async saveSnapshotNow(adbPath, { timeout = 45000, shouldSave = () => true } = {}) {
    if (!this.snapshotSaveAllowed()) { this.cancelSnapshotSave(); return false; }
    if (!adbPath || !shouldSave()) return false;
    // 「存快照把模拟器写崩」的记忆位（上游 #46）：在一台已稳定跑了几分钟的模拟器上，
    // 只执行 `adb emu avd snapshot save`，60 秒后进程就 0xC0000005 消失。
    // 学过一次就不再试 —— 用户宁可下次冷启动多等 20 秒，也不要应用窗口用的过程中突然没了。
    const unsafe = this._snapshotUnsafe();
    if (unsafe) {
      this.log(`跳过快照保存：上次在本机用 ${unsafe} 存快照把模拟器写崩了（上游 #46）`);
      return false;
    }
    const alive = this.running();
    const ok = await this._saveViaAdb(adbPath, { timeout, shouldSave });
    if (alive && !this.running()) {
      this._noteSnapshotUnsafe();
      this.log('快照保存导致模拟器退出，已记录：本机后续不再保存快照');
      return false;
    }
    // emulator 的 save 命令可能在写盘中途就回 OK，这里按文件完整性再确认一次，
    // 只有 snapshot.pb 真正落盘才算数（否则下次加载会失败并白等几秒）。
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /** 「这台机器 + 这个运行时版本上，存快照会把模拟器写崩」的记忆位（空串=可以存） */
  _snapshotUnsafe() {
    const key = String((this.settings.engine || {}).snapshotUnsafe || '');
    if (!key || !key.includes('|')) return '';
    const [ver, gpu] = key.split('|');
    // 升级运行时后重新给一次机会：新版 emulator 可能已经修了这个崩溃
    if (ver !== (this._emuVersion || '')) return '';
    return gpu || 'unknown';
  }

  _noteSnapshotUnsafe() {
    const gpu = (this.profile && this.profile.gpu) || 'unknown';
    try { store.saveSettings({ engine: { snapshotUnsafe: `${this._emuVersion || ''}|${gpu}` } }); } catch (_) { /* ignore */ }
  }

  /**
   * 安排一次「空闲时保存快照」。
   * 只排一次；如果到点时容器还有应用在前台，就推迟到真正空闲。
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    this.cancelSnapshotSave();
    if (!adbPath || !this.snapshotSaveAllowed()) return;
    this._snapSaved = false;
    const request = {};
    this._snapSaveRequest = request;
    const current = () => this._snapSaveRequest === request && this.snapshotSaveAllowed();
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        if (this._snapSaveRequest !== request) return;
        this._snapTimer = null;
        if (!this.snapshotSaveAllowed()) { this._snapSaveRequest = null; return; }
        if (!this.running()) return;
        if (!isIdle()) { if (current()) arm(15000); return; }
        // 磁盘余量不够写快照（内存大小 + 1GB 余量）就跳过：硬写只会把磁盘写满，
        // 进而让下一次开机直接失败。快照只影响启动速度，不写也不影响数据。
        const freeMB = doctor.freeDiskMB(this.provisioner.paths().avdHome);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`跳过快照保存：磁盘剩余 ${(freeMB / 1024).toFixed(1)}GB < 需要 ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        if (!current()) return;
        const saved = await this.saveSnapshotNow(adbPath, { shouldSave: current }).catch(() => false);
        if (current()) this._snapSaved = saved === true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
    this._snapSaveRequest = null;
  }

  /**
   * guest 是否处于「可以安全存快照」的健康状态：adb authorized + boot 完成（上游 b7c4f06）。
   * 冷启动时若「允许 USB 调试吗？」对话框还挂着，state 是 unauthorized —— 这时存下
   * 内存 + 磁盘，guest 里就没有 host 的 adbkey.pub，下次恢复还是 unauthorized，
   * 每轮探测的 shell 都抛异常，干等 240s 还被误诊成显卡/虚拟化问题。
   */
  async _adbGuestHealthy(adbPath) {
    if (!adbPath) return false;
    try {
      const port = this.port;
      const target = await this._requireAdbTarget(null, port);
      const { AdbClient } = require('./adb');
      const probe = new AdbClient({ adbPath, serial: this.serial });
      const state = await probe.deviceState();
      await this._requireAdbTarget(target, port);
      const out = await probe.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      await this._requireAdbTarget(target, port);
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false;
    }
  }

  /** Save a healthy snapshot, then stop only a verified, birth-pinned runtime. */
  async stop({ adbPath } = {}) {
    this.cancelSnapshotSave();
    let target = await this.ownedProcessOnPort();
    if (!target && this.proc?.pid) {
      const info = await processOwner.getProcessInfo(this.proc.pid);
      if (this.ownsProcess(info)) target = info;
    }
    if (!target) return !this.running() && !(await this._consoleAlive());
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath).catch(() => false) : true;
    if (adbPath && this.snapshotSaveAllowed() && healthy) {
      await this.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
    }
    // An adb serial/console port can be reassigned between validation and `emu kill`.
    // Do not send a destructive command by serial: the OS helper pins this exact birth.
    const owns = (p) => this.ownsProcess(p, { discoverRoot: true });
    let stopped = await processOwner.terminateOwnedProcess(target, owns, 'SIGTERM');
    if (!stopped && process.platform === 'linux') stopped = await processOwner.terminateOwnedProcess(target, owns, 'SIGKILL');
    if (!stopped) return false;
    if (this.proc?.pid === target.pid) this.proc = null;
    if (await this._consoleAlive()) return false;
    // A launcher may have exited while its detached QEMU was still running.
    if (this.running()) return false;
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * 当前启动会话里重复出现同一个 0xC0000005：停止自动换端口/换参数。
   *
   * 判据只使用本轮 attempts 和精确退出码，不依赖长日志里的 GPU 文本；这样
   * WHPX/TCG 混合失败、不同 GPU 后端失败，甚至只有 QEMU 崩溃行而没有完整诊断时，
   * 也不会继续把同一个不稳定运行时拉起到更多端口。attempts 在每次 start() 开始时清空，
   * 不会把上一次成功前的历史崩溃带进本轮。
   */
  _repeatedAccessViolation(d) {
    if (!d || !['ACCESS_VIOLATION', 'GPU_INIT', 'ACCEL_UNUSABLE'].includes(d.code)) return false;
    const exit = Number(this.lastExitCode);
    if (exit !== 3221225477) return false;
    return this.attempts.filter((a) => a && Number(a.exitCode) === exit).length >= 2;
  }

  /**
   * 纯软件模拟下的重复访问冲突：换 GPU 后端已经救不了，别再耗完 4 轮。
   *
   * 判据用 attempts（每轮独立记录）而不是日志文本，避免上一轮的崩溃串味。
   * 典型现场：机器没有 WHPX/AEHD，swiftshader / swangle / software 全部
   * 以 0xC0000005 退出——病根在 TCG/模拟器本身，继续换后端只会白等十几分钟。
   */
  _softwareTcgCrashed(plan, d) {
    if (!d) return false;
    // 只认「进程真的崩了」的结论；端口占用 / 超时这类不能被算进崩溃次数
    if (!['ACCESS_VIOLATION', 'GPU_INIT', 'TCG_CRASH'].includes(d.code)) return false;
    if (!plan || plan.accel !== 'off' || !this._isTcgGpu(plan.gpu)) return false;
    // 不能只认 ACCESS_VIOLATION：日志里只要带 Vulkan / ANGLE 字样，同一场崩溃就可能被
    // 判成 GPU_INIT（用户实测：4 组参数 4 次全崩，报告却还写着「已自动换用其他渲染后端」）。
    // 判据回到事实本身 ——「关加速的软件路径 + 同一个非 0 退出码」出现两次，就说明换后端无效。
    // issue #5：host / lavapipe / guest 同样是 accel=off 下的 TCG 呈现路径（老版本 emulator
    // 的候选里 swangle 根本不存在，第一组就是 swiftshader_indirect，随后 host/lavapipe）。
    // 旧正则只数 software/swiftshader/swangle，host 轮同码崩溃被漏算，导致多白等一轮。
    const exit = this.lastExitCode;
    if (!exit) return false;
    return this.attempts.filter((a) => a && a.accel === 'off'
      && this._isTcgGpu(a.gpu) && a.exitCode === exit).length >= 2;
  }

  /** 是否属于「关加速后的软件/TCG 呈现路径」。统一给止损与去重使用，避免正则各写各的漏项。 */
  _isTcgGpu(gpu) {
    return /software|swiftshader|swangle|lavapipe|host|guest/i.test(gpu || '');
  }

  /**
   * 崩溃且日志里有 Vulkan 痕迹时，把下一轮改成「关掉 Vulkan 再试」。
   *
   * 英特尔核显（UHD 730/770 这类）+ 旧驱动在 emulator 37.x 上会在 Vulkan 初始化阶段
   * 让 qemu 直接 0xC0000005。此时换 -gpu 只是换呈现方式，Vulkan 通道照样会崩
   * （实测现场：swangle / software / host 三种后端全崩在同一退出码）。
   * `-feature -Vulkan` 关掉 guest Vulkan 通道通常能直接开机，代价只是少数游戏退回 GLES。
   */
  _preferNoVulkan(variants, index, d, lines) {
    const next = variants && variants[index + 1];
    if (!next || next.noVulkan) return false;
    if (!d || !['GPU_INIT', 'ACCESS_VIOLATION'].includes(d.code)) return false;
    const text = String((lines || []).join('\n'));
    // issue #5：不能用裸 /vulkan/ 判断 —— androidboot.hardware.vulkan=ranchu 是 guest
    // 内核命令行的固定属性，正常启动也会打印，会把它当成「崩在 Vulkan」（歪打正着地
    // 关了 Vulkan，但判断依据本身是错的）。先把这类 androidboot.* 属性行剔掉，
    // 再看剩下的日志里有没有真正的 Vulkan / Guest Angle 初始化痕迹。
    const meaningful = String((lines || []))
      .split(/\r?\n/)
      .filter((line) => !/androidboot\.hardware\.vulkan|androidboot\.[^\s]*vulkan/i.test(line))
      .join('\n');
    if (!/vulkan|guest angle/i.test(meaningful)) return false;
    next.noVulkan = true;
    next.label = `${next.gpu} / 关 Vulkan`;
    return true;
  }

  /**
   * 记下「拉起就崩」的 GPU 后端，下次启动把它排到最后。
   * 只对 auto 模式生效：用户显式指定后端时尊重用户选择，不偷偷改。
   */
  _noteGpuFailure(plan) {
    try {
      // 授权对话框卡住不是渲染后端的问题，别把当前 GPU 记进「启动即崩」黑名单
      // （上游 b7c4f06），否则下次启动会无缘无故跳过这台机器本来能用的后端。
      if (this.lastDiagnosis && this.lastDiagnosis.code === 'ADB_UNAUTHORIZED') return;
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // 软件渲染是兜底项，它已经是最慢/最稳的选择，没有更差的替代品可退
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** 本实例的控制台端口（5554）上是否还有机器在跑 —— 判断「到底关干净了没有」 */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /** 用 adb 保存前仍需验证健康与端口归属；直接调用和定时保存也不能绕过。 */
  async _saveViaAdb(adbPath, { timeout = 45000, shouldSave = () => true } = {}) {
    const allowed = () => this.snapshotSaveAllowed() && shouldSave();
    if (!adbPath || !allowed()) return false;
    const serial = this.serial;
    const port = this.port;
    const target = await this._ownedAdbTarget(null, port);
    if (!target || !allowed()) return false;
    if (!(await this._adbGuestHealthy(adbPath)) || !allowed()) return false;
    const current = await this._ownedAdbTarget(target, port);
    if (!processOwner.sameIdentity(target, current) || serial !== this.serial || !allowed()) return false;
    const call = this._adbInvocation(adbPath, ['-s', serial, 'emu', 'avd', 'snapshot', 'save', this.snapshotName]);
    return new Promise((resolve) => {
      execFile(call.adb, call.args, { timeout, windowsHide: true, env: call.env }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * 只取「本轮启动尝试」产生的日志行。
   * 内存日志是跨轮累积的（诊断报告要看到全部尝试），但诊断结论必须只看本轮：
   * 否则第 1 轮的 `emulator exit 3221225477` 会让第 2 轮的任何失败都被判成同一个崩溃。
   * 用单调序号而不是会因 shift() 变化的数组下标；本轮没有日志就返回空，
   * 绝不借上轮的 operational/崩溃证据来填空。
   */
  _attemptLines(from, max = 80) {
    const boundary = Math.max(0, from || 0);
    return this._log.filter((entry) => entry.seq > boundary).slice(-max).map((entry) => entry.line);
  }

  /**
   * 从 emulator.log 文件尾部读最近 n 行（内存缓冲为空时用）。
   * 用户重启 ApkStart 再导出诊断报告时，内存里的 this._log 已经空了，
   * 旧版报告因此只剩一句 UNKNOWN —— 真实崩溃原因全在日志文件里。
   */
  /** 读任意日志文件的末尾 n 行（诊断报告用它带出 app.log 里的启动轨迹） */
  static tailFile(file, n = 300) {
    try {
      const size = fs.statSync(file).size;
      if (!size) return [];
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }

  tailLogFile(n = 300) {
    return EmulatorEngine.tailFile(path.join(store.DATA_DIR, 'logs', 'emulator.log'), n);
  }

  /** app.log 的尾部：里面是「点开应用 → 引导 → 装 APK」的主进程轨迹 */
  tailAppLog(n = 200) {
    return EmulatorEngine.tailFile(path.join(store.DATA_DIR, 'logs', 'app.log'), n);
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME, CUSTOM_AVD_NAME, MANAGED_AVDS };

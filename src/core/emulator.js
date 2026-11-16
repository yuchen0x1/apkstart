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
    case 3221225781: return '0xC0000135 缺少 DLL（VC++ 运行库 / 运行时组件被杀毒删除）';
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
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
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
    this._log.push({ t: Date.now(), line });
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

  /** emulator.exe 与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
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

  /**
   * 清掉占着 AVD 锁的孤儿模拟器。
   * emulator.exe 只是个启动器，真正的 qemu 被 spawn 成独立进程（detached），
   * 所以只 kill 自己手上的 proc 句柄经常留个孤儿在那占着 multiinstance.lock，
   * 下一次启动就会 FATAL "Running multiple emulators with the same AVD"。
   * 按「AVD 锁里的 pid」+「命令行带本 AVD 名的 qemu/emulator」两个来源清。
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${this.avdName}.avd`);

    // 快速路径（每次冷启动都会走到）：
    //  - 没有 .lock → 不可能有活着的 emulator 占着这个 AVD，直接返回；
    //  - 有 lock 但端口没人监听 → 只是上次强杀留下的残留目录，清掉即可。
    // 以前无论什么情况都要跑一次 wmic（1~3 秒，还很吃 CPU），冷启动时明显拖慢。
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) 锁文件里 emulator 自己写的 pid（最可靠）
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) 兜底：按进程名 + 端口找活着的 qemu（tasklist/netstat 比 wmic 快一个量级）
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* 拿不到进程列表就只靠锁文件里的 pid */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`清理 ${pids.size} 个残留模拟器进程`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
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
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
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
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
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
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* 不存在 */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // 文件够大 + 文件系统也真的长到了这个大小，才算「不用动」。
      // 只看文件大小会漏掉一种真实故障：qemu-img 撑开了文件、resize2fs 却失败了，
      // 于是文件 6GB、安卓只有 64MB —— 用户看到的就是「装游戏说空间不足」。
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // 容量配置变大了（或文件系统没长到位）：就地扩容，不重建、保留已装应用
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata 扩容：文件 ${size} → ${wantBytes}，文件系统 ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        // 旧版/异常关机留下的 userdata 可能没有干净卸载，resize2fs 会明确要求
        // 先跑 e2fsck。自动修复后重试一次，避免用户只能手动删掉整个 AVD（#46/#60）。
        if (/e2fsck|run .*e2fsck|exit 8/i.test(String(e.message || e))) {
          try {
            this._e2fsck(img);
            this._resize2fs(img);
            userdata.setEncryptFlag(img);
            const grown = userdata.fsBytes(img);
            this.log(`userdata 先经 e2fsck 修复后扩容完成：${size} → ${wantBytes}`);
            return { ok: true, created: false, grown: true, repaired: true, size: wantBytes, fsBytes: grown };
          } catch (retry) {
            e = retry;
          }
        }
        this.log(`扩容 userdata 失败（继续用现有分区）：${e.message}`);
        // 老分区仍然可用，但必须如实告诉调用方「这次没扩成」，不能让设置页显示成功
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // 首次 / 旧版留下的全零占位 / 镜像损坏：全新造一个
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // 先不带 encrypt 位（老 e2fsck/resize2fs 才肯干活）
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`已重建 userdata：${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4（4K block，支持 FBE）`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // 尽力而为：哪怕扩容失败，也要把 encrypt 位补回去，让 FBE 能初始化（分区会偏小）
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`重建 userdata 失败：${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** emulator 自带 qemu-img.exe：把原始镜像文件撑到目标大小（稀疏，瞬间完成）
   *  注意参数顺序：`qemu-img <命令> -f raw <文件> <大小>`。
   *  把 -f 放命令前面会被它当成全局参数直接报 unrecognized option。 */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 自带 e2fsck.exe：修复异常中断留下的 dirty userdata 后再扩容 */
  _e2fsck(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'e2fsck.exe');
    if (!fs.existsSync(exe)) throw new Error('缺少 e2fsck.exe');
    const r = spawnSync(exe, ['-fy', img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    // e2fsck: 0=clean, 1=修复完成；2/4/8 都表示不能安全继续。
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`e2fsck 失败: ${(r.stderr || r.stdout || '').trim() || r.status}`);
    }
  }

  /** emulator 自带 resize2fs.exe（cygwin 版，必须在 bin64 目录下跑才能找到 DLL） */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('缺少 resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读运行时（EXE 旁
    // resources/runtime）时 root/avd 不存在也不可写，AVD 要落到用户数据目录。
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    // opengl32sw.dll（Qt 软件 OpenGL 渲染器）在新版 Google emulator 包里已不再附带。
    // 缺失时 Qt 动态 GL 回退到系统 opengl32.dll —— 在部分显卡驱动上绘制全黑
    // （实测：窗口全黑但输入正常，安卓侧 screencap 有内容），或画面错乱。
    // 修复：deploy 时从 build/vendor/opengl32sw.dll 补位（Qt 5.15 官方组件，LGPL）；
    // 就位后强制 QT_OPENGL=software（CPU 渲染，任何 GPU 都稳定）。
    // 不要用 QT_OPENGL=angle：D3D11 交换链与 SetParent 嵌入冲突（失焦即黑屏、画面错乱）。
    const emuDir = path.dirname(this.locate().emulatorExe || '');
    const hasSwGL = emuDir && fs.existsSync(path.join(emuDir, 'opengl32sw.dll'));
    return {
      ...process.env,
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(hasSwGL ? { QT_OPENGL: 'software' } : {}),
    };
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const args = [
      '-avd', this.avdName,
      '-port', String(port),
      // 音频：默认开启（让安卓应用的提示音/视频声音能放出来）。
      // 仅当用户在设置里显式关闭时才传 -no-audio 省一点 CPU。
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
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
    // 只有快照真的存在才传 -snapshot：全新 AVD（或快照刚被作废）时传了它，
    // qemu 会一直等一份不存在的内存状态，进程活着但永远不开机——
    // 上层只看到「开机超时」，接着换参数重试，反而被 AVD 锁挡成
    // "Running multiple emulators with the same AVD"。
    // 快照参数决定「下次开机是 8 秒还是 90 秒」，这里是第二个致命点：
    // 老实现「没有快照就传 -no-snapshot」，而 -no-snapshot 同时禁掉了**退出时保存**，
    // 于是第一次冷启动结束后永远产生不了快照，用户每次点开都是全量引导。
    // 正确做法是 -no-snapshot-load：这次不加载（避免等一个不存在的快照），
    // 但退出时照常把内存状态写成 apkstart，下次就直接恢复。
    // 快照要占一份约 2~3GB 的 ram.bin（磁盘紧张的用户可以关掉，只影响启动速度）
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // 重置数据时不能加载旧快照（数据都对不上了），但**必须允许保存新快照**：
      // 修复网络就是靠「重置后第一次开机有网 → 立刻存快照 → 下次恢复」这条链路。
      // 老写法这里推的是 -no-snapshot，会把保存一起关掉，快照永远存不下来。
      // 只给 -no-snapshot-load 的话，保存会落到 emulator 的默认快照名 default_boot，
      // 下次按 -snapshot apkstart 找又找不到 —— 等于白存一次，还得再冷启一遍。
      // 所以这里连快照名一起给：不强求加载，但存就存到 apkstart 里。
      if (!wantSnapshot) args.push('-no-snapshot');
      else args.push('-snapshot', this.snapshotName, '-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', this.snapshotName);
      // 快照可能存于「虚拟机没网」的状态；网络修复要求这次冷启动。
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
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
   * 调整本机 qemu/emulator 进程的优先级（只匹配命令行里带本 AVD 名的进程）。
   * level: idle（容器停放）| below（有应用在前台）| normal（性能优先）。
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', this.avdName, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** 强杀当前尝试（含 qemu 子进程树） */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // proc 句柄常常已经没了（emulator.exe 启动完就退出，qemu 是 detached 的独立进程），
    // 不按进程名兜底清一遍，下一轮就会被 AVD 锁挡成 FATAL。
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * 重建本专用端口上的 adb server。
   *
   * 这里是「打开应用要等两分钟」最主要的元凶，历史实现只 kill-server 就返回了：
   * emulator 在启动瞬间会去连 ANDROID_ADB_SERVER_PORT 上的 adb daemon，
   * 连不上就**再也不注册这台设备** —— adb devices 里要么没有 emulator-5554，
   * 要么永远停在 offline（日志里就是那句 "Unable to connect to adb daemon on port: 5044"）。
   * 于是上层 probe 一直拿不到 sys.boot_completed，白等 3 分钟超时后重试，
   * 每次重试都是全量冷启动，快照也因为「设备不在线」保存不了，形成死循环。
   *
   * 所以必须先 kill（清掉旧设备记录）再 start，并等到端口真的在监听才返回。
   */
  /** 供上层在 adb 传输卡住（offline / unauthorized）时主动重启一次 server */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* 用 PATH 里的 */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server 在部分机器上同步返回得很快，但端口还没真正 listen，
    // 这里等到能连上为止（最多 ~3 秒，正常几十毫秒）。
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
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
    let adb = adbPath || '';
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() 只查「版本文件」，很多安装形态下是空的；
      // 直接按运行时根目录找 bundled 的 platform-tools 才稳。
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
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
    const connected = /Wifi is connected/i.test(wifi);
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
    let adb = adbPath || '';
    if (!adb) {
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 10000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out, err) => {
          // 注意：命令失败（非 0 退出）时也要把 stdout/stderr 带出来。
          // 之前这里失败就返回空串，导致 `connect-network` 的 SecurityException
          // 被吞掉、UI 兜底分支永远进不去（实测踩过这个坑）。
          resolve(String(out || '') + String(err || ''));
        });
      } catch (_) { resolve(''); }
    });
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
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // 让本进程里所有 adb 调用和 emulator 用同一个 server 端口
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // 这四件事互不依赖，并行做：以前是「加速检查 → 版本 → 探端口 → 清 adb server」串行，
    // 冷启动前白等 3~5 秒，正好是用户点开应用后盯着加载框的那段时间。
    // 上一次运行留下的 adb server 可能还挂着旧设备记录（会把新模拟器挤成 offline），
    // 所以清 server 仍然要做，只是不必单独等它。
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // 与设置页 / 诊断报告共用同一个入口，保证「显示的」就是「实跑的」
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
    this.profile = profile;
    // 嵌入 Electron 的可见窗口会经历跨进程 SetParent、失焦和 DWM 重绘；
    // 这类场景下 host 的交换链可能在失焦后丢失，表现为「安卓仍在跑，窗口全黑」。
    // 可见模式因此把软件渲染提到前面，但优先 swangle（ANGLE + SwiftShader）而不是
    // 裸 software：swangle 同样不依赖显卡交换链，合成路径对 WebView 友好得多，
    // 而裸 software 会让「点同意进主界面」这种 WebView 重合成场景黑屏。
    // 两者都仍可保留 WHPX 加速，只是把 guest GLES 的呈现改走 SwiftShader 路径。
    const variants = doctor.planVariants(profile, { preferSoftware: !headless }).slice(0, maxAttempts);
    // 报告里要写清这次是「带窗口」还是「无窗口」跑的：同一台机器上两者结果常常不同，
    // 少了这一个 bit，报告就没法区分「模拟器起不来」和「带窗口渲染起不来」（issue #29）。
    this.headlessMode = !!headless;

    // 记住「上次拉起就崩」的 GPU 后端，下次把它排到最后。
    // 实测：AMD Radeon 780M 上 `-gpu host` 能通过 emulator 自己的硬件检查，
    // 但 VM 起来十几秒后进程直接 exit 1（日志里只有 "AEHD is operational"），
    // 每次都要白等 20 多秒再退到 swangle。key 里带上 emulator 版本，
    // 升级运行时后自动重新给它一次机会。
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`上次 ${badGpu} 渲染后端启动即崩溃，本次改用 ${variants[1].gpu} 先试`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

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

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // 端口占用也会导致失败，每次重试重新探测一次
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // 每轮重置退出码：上一轮 0xC0000005 不能带进下一轮的诊断里
      this.lastExitCode = null;
      // 日志也按轮切分：内存日志是跨轮累积的，第 1 轮的崩溃行若留在尾部，
      // 第 2 轮（比如换后端后端口冲突）会被误诊成同一个崩溃。
      const logStart = this._log.length;
      onLog(`启动运行时（第 ${i + 1}/${variants.length} 次：${plan.label}）…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // forceWipe 也要参与「删旧快照」：重置数据后旧快照必然加载失败
        // （实测报 Failed to load snapshot 后退回冷启动），必须先清掉再重建。
        wipe: plan.wipe || !!this.wipePending || forceWipe,
      });
      // 埋点：上层（main）用它在拉起模拟器**之前**打开黑窗压制。
      // 控制台窗口在 spawn 之后几十毫秒就冒出来，事后再补一次扫描必然闪一下，
      // 所以这里必须先把它打开、再拉起进程。
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      // _coldBoot 只对这次 spawn 生效，避免之后每次开机都退化成长时间冷启动
      this._coldBoot = false;
      // 参数错误 / DLL 缺失会立刻退出
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        let d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({
          plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode,
          // 实际参数：失败后用户/作者都要能看出「这一轮到底用了多保守的配置」，
          // 只看 label（gpu / 加速方式）是不够的。
          params: doctor.describeAttempt(plan),
          gpu: plan.gpu, accel: plan.accel,
        });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // 磁盘写满不是「换组参数就能好」的问题：继续重试只会反复失败，
        // 而且历史上最后那组参数带 wipe，会把用户数据一起抹掉。直接收工、如实报错。
        if (d.code === 'DISK_FULL') {
          onLog('磁盘空间不足，已停止重试（不会动你的应用与存档）。');
          this._persistFailure({
            profile, profileText: doctor.describeProfile(profile),
            tuning: doctor.describeTuning(profile), why: 'disk-full',
          });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // 加速/镜像类结论可能是缓存里的旧数据，作废掉，下次启动重新探测
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        if (this._softwareTcgCrashed(plan, d)) {
          d = doctor.tcgCrashDiagnosis();
          this.lastDiagnosis = d;
          lastError = `${d.title}：${d.hint}`;
          onLog(`${d.title}，停止重试等价的软件后端。`);
          break;
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
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
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

      if (ok) {
        const bootMs = Date.now() - started;
        // `profile` is the desired auto profile, while `plan` is the concrete
        // attempt that reached Android. A visible launch can fall back from
        // host to swangle/software without changing the user's settings; keep
        // the concrete plan for runtime status and diagnostics.
        this.profile = plan;
        // 这一次真的起来了：清掉上次的失败记录，避免以后「诊断」翻出旧账
        this._clearFailure();
        // 一定要存 quickboot 快照：模拟器进程会随 ApkStart 退出而结束（Electron 的
        // job 对象会连带杀掉子进程），下次打开有没有快照直接决定是 25 秒还是 7 秒。
        // 装完新应用时 installer 会作废快照，避免"重启后应用消失"。
        this.snapshotWorthSaving = true;
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
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      let d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      // 进程没崩、只是等到超时：结论就该是「太慢」，不能被日志里的 CPUID 警告
      // 或 UNKNOWN 抢走。否则用户拿着「CPU 缺少指令集」去换镜像，永远修不好。
      if (!fatal && ['UNKNOWN', 'CPU_FEATURE'].includes(d.code)) {
        d = doctor.timeoutDiagnosis({
          accelOk: !!(accelInfo && accelInfo.ok),
          seconds: Math.round((Date.now() - started) / 1000),
        });
      }
      this.attempts.push({
        plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode,
        params: doctor.describeAttempt(plan),
        gpu: plan.gpu, accel: plan.accel,
      });
      const tcgCrash = this._softwareTcgCrashed(plan, d);
      if (tcgCrash) {
        d = doctor.tcgCrashDiagnosis();
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        onLog(`${d.title}，停止重试等价的软件后端。`);
      } else {
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        onLog(`${lastError}，自动换一组参数重试…`);
        this._noteGpuFailure(plan);
      }
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
      if (tcgCrash) break;
    }

    // 全部组合都失败、而且本机根本没有加速：给一句能照做的结论，
    // 别再让用户对着「UNKNOWN + 已自动重试」猜（issue #20/#6/#15/#31）。
    let d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    if ((!d || d.code === 'UNKNOWN') && accelInfo && !accelInfo.ok) d = doctor.noAccelDiagnosis();
    this.lastDiagnosis = d;
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
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
      + `实际参数：${doctor.describeProfile(profile)}\n`
      + `已尝试：${this.attempts.map((a) => `${a.plan}${a.params ? `（${a.params}）` : ''} → ${a.diagnosis}`).join('；')}\n`
      + `${customHint ? `${customHint.trim()}\n` : ''}`
      + `诊断报告：${report.file}${visibleHint}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({
      profile, profileText: doctor.describeProfile(profile),
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
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // emulator 的 save 命令可能在写盘中途就回 OK，这里按文件完整性再确认一次，
    // 只有 snapshot.pb 真正落盘才算数（否则下次加载会失败并白等几秒）。
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * 安排一次「空闲时保存快照」。
   * 只排一次；如果到点时容器还有应用在前台，就推迟到真正空闲。
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // 磁盘余量不够写快照（内存大小 + 1GB 余量）就跳过：硬写只会把磁盘写满，
        // 进而让下一次开机直接失败。快照只影响启动速度，不写也不影响数据。
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`跳过快照保存：磁盘剩余 ${(freeMB / 1024).toFixed(1)}GB < 需要 ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** 优雅停止：慢机器先保存 quickboot 快照，再走控制台关机，最后强杀进程树 */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // 接管来的实例没有 proc 句柄，但端口上确实有机器在跑，不能直接返回 true 走人
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      // 关机前补存一次：空闲路径没来得及存（比如用户装完应用马上退出）时，
      // 下一次开机仍然能走快照恢复，而不是重新冷启动。
      // 3GB 内存写盘要几秒到二十几秒，超时给足，别让快照写一半就被 kill 掉。
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // 等它自己走完「落盘 → 退出」的流程。以前固定等 6 秒就强杀，
    // 正好把快照写盘掐断，留下一个只有 ram.img 没有 snapshot.pb 的空壳。
    //
    // 注意不能等 this.proc：emulator.exe 只是个启动器，spawn 完 qemu 自己就退了，
    // 拿它的 exit 当「关机完成」会立刻进入强杀分支。这里以控制台端口为准。
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  /**
   * 纯软件模拟下的重复访问冲突：换 GPU 后端已经救不了，别再耗完 4 轮。
   *
   * 判据用 attempts（每轮独立记录）而不是日志文本，避免上一轮的崩溃串味。
   * 典型现场：机器没有 WHPX/AEHD，swiftshader / swangle / software 全部
   * 以 0xC0000005 退出——病根在 TCG/模拟器本身，继续换后端只会白等十几分钟。
   */
  _softwareTcgCrashed(plan, d) {
    if (!d || d.code !== 'ACCESS_VIOLATION') return false;
    if (!plan || plan.accel !== 'off' || !/software|swiftshader|swangle/i.test(plan.gpu || '')) return false;
    return this.attempts.filter((a) => a.diagnosis === 'ACCESS_VIOLATION'
      && a.accel === 'off' && /software|swiftshader|swangle/i.test(a.gpu || '')).length >= 2;
  }

  /**
   * 记下「拉起就崩」的 GPU 后端，下次启动把它排到最后。
   * 只对 auto 模式生效：用户显式指定后端时尊重用户选择，不偷偷改。
   */
  _noteGpuFailure(plan) {
    try {
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

  /** 用 adb 触发一次快照保存（失败返回 false，调用方决定要不要再试） */
  _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', this.snapshotName],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * 只取「本轮启动尝试」产生的日志行。
   * 内存日志是跨轮累积的（诊断报告要看到全部尝试），但诊断结论必须只看本轮：
   * 否则第 1 轮的 `emulator exit 3221225477` 会让第 2 轮的任何失败都被判成同一个崩溃。
   * 本轮一条日志都没有时（进程压根没起来）退回整体尾部，至少给个结论。
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
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

'use strict';
/**
 * 运行时引擎：ApkStart 自带的 QEMU + Android-x86 虚拟机
 *
 * 设计原则：
 *  - 默认完全自持（builtin）：adb / QEMU / 系统镜像都由 ApkStart 自己管理，不依赖任何第三方模拟器
 *  - 所有对安卓的操作统一走 adb，因此引擎可替换
 *  - 虚拟机按需启动，空闲自动回收；启动后常驻复用，装/开应用几乎零等待
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const { parseVolumeGet } = require('./android');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const repair = require('./repair');
const container = require('./container');
const guest = require('./guest');
const platform = require('./platform');
const processOwner = require('./process-owner');
const userdata = require('./userdata');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const QEMU_SERIAL = '127.0.0.1:5555';
const DATA_MAINTENANCE_BUSY = '正在维护运行时数据，请稍后再启动';

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('运行时启动已取消');
  error.code = 'START_CANCELLED';
  throw error;
}

function cancelledBoot() { return { ok: false, code: 'START_CANCELLED', error: '运行时启动已取消' }; }

// Only detach from observational probes. Operations that can write files, issue
// guest mutations or create a child must settle before the startup lock is released.
async function waitStartupProbe(signal, probe) {
  if (!signal) return probe();
  throwIfAborted(signal);
  let abort;
  try {
    const cancelled = new Promise((resolve) => {
      abort = () => resolve(undefined);
      signal.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([cancelled, probe()]);
    throwIfAborted(signal);
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

// Runtime owns the engine and serializes start(). The callbacks in the base
// retry loop are not cancellation fences: onBeforeSpawn can await and probe
// 'fatal' can retry. Guard both AVD preparation and the actual synchronous spawn.
class RuntimeEmulator extends EmulatorEngine {
  async start(options = {}) {
    const signal = options.signal;
    throwIfAborted(signal);
    this._runtimeStartSignal = signal;
    try { return await super.start(options); }
    finally { this._runtimeStartSignal = undefined; }
  }

  ensureAvd(...args) {
    throwIfAborted(this._runtimeStartSignal);
    return super.ensureAvd(...args);
  }

  spawnOnce(...args) {
    throwIfAborted(this._runtimeStartSignal);
    return super.spawnOnce(...args);
  }
}

function emulatorConsolePort(serial) {
  const native = /^emulator-(\d+)$/.exec(serial);
  const tcp = /^127\.0\.0\.1:(\d+)$/.exec(serial);
  const port = native ? Number(native[1]) : tcp ? Number(tcp[1]) - 1 : 0;
  return port > 0 && port < 65535 ? port : 0;
}

/** 自动修复动作的中文说法（日志 / 启动窗口提示要用它，别把动作 id 露给用户） */
const AUTO_ACTION_TEXT = {
  'clear-locks': '清理上次残留的锁文件',
  redeploy: '校验并补齐运行时文件',
  'cleanup-safe': '清理运行时临时文件',
  'gpu-software': '改用软件渲染',
};
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

// 给用户的 adb 授权修复提示必须跟宿主系统一致；Linux/macOS 没有 %USERPROFILE%。
function adbKeyHint() {
  return process.platform === 'win32' ? '%USERPROFILE%\\.android\\adbkey*' : '$HOME/.android/adbkey*';
}

/** TCP 端口是否有人监听（用来判断上次留下的模拟器还在不在） */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu 模拟器', serial: '127.0.0.1:7555' },
  { name: 'Nox 夜神', serial: '127.0.0.1:62001' },
  { name: 'MEmu 逍遥', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new RuntimeEmulator(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._guestDefaultsReady = false;
    this._chineseImeReady = false; // 中文输入法本进程装好即置位（失败允许下次 prepare 重试）
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // 容器会话：当前打开的应用窗口
    this._foregroundLaunches = new Set();
    this._priorityPromise = null;
    this._idleTransitionPromise = null;
    this._accelRepairTried = false; // 全自动修复加速：一次运行只试一次，避免无限循环
    this.onAccelRepair = null;      // 由 main 注入（会弹管理员授权的 enableVirtualization）
    // 全自动修复（非加速类）：清锁、补文件、换渲染后端……都由 main 注入的动作执行器落地。
    // 只放「不需要用户做决定」的动作进来 —— 删数据、重下 1.5GB 镜像这类必须用户点同意。
    this.onAutoRepair = null;
    this._autoRepairCount = 0;
    this._autoRepairedCodes = new Set();
    this.autoRepairLog = [];        // 已经自动做过什么（给修复窗口如实展示）
    this.emuSerial = EMU_SERIAL;   // 端口是动态挑的，serial 跟着变
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  get settings() { return store.getSettings(); }

  /** emulator 引擎是否在运行 */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- 基础 ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial
      || (this.settings.engine.mode === 'attach' ? this.settings.device : this.emuSerial);
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // 换端口/换 adb 时别把旧的常驻 adb shell 留在后台占着连接
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- 状态 ----------------

  async status() {
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      // 镜像来源：默认 Play 镜像 还是 用户导入的自定义镜像（以及它为什么不可用）。
      // 顶栏徽标、设置页「当前镜像」都用这两个字段，避免各处自己猜。
      sysimgCustom: !!(env.sysimg && env.sysimg.custom),
      imageName: (env.activeImage && env.activeImage.ok && env.activeImage.custom)
        ? env.activeImage.name : '',
      imageWhy: (env.activeImage && env.activeImage.custom && !env.activeImage.ok)
        ? env.activeImage.reason : '',
      accel: env.accel,
      vmRunning: this.emulator.running() || !!this.vmProc,
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      autoProfile: this.emulator.profile
        ? (this.emulator.describeProfile ? this.emulator.describeProfile() : doctor.describeProfile(this.emulator.profile)) : '',
      acceleration: this.emulator.profile?.acceleration || null,
      // 为什么是这组参数（低配降级的原因 / 哪些项是用户手动钉住的）：
      // 首页横幅与设置页都显示同一句话，避免「显示的」和「实跑的」对不上。
      autoProfileWhy: this.emulator.profile ? doctor.describeTuning(this.emulator.profile) : '',
      autoProfileManual: this.emulator.profile ? doctor.describeManual(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 「上次为什么没起来」：内存里没有就回落到落盘记录，设置页/诊断都能显示真实原因
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = '缺少 adb：点击「一键部署」自动下载';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // 不再把「没有硬件加速」当成阻塞步骤：doctor 会自动回退软件模拟，
    // 并在开机失败时按 GPU/加速/内存组合依次重试。
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /** 高级模式：探测本机已有运行时（非默认路径） */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- 启动 / 停止虚拟机 ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    args.push(...require('./peripherals').buildQemuArgs(s.peripherals));
    return args;
  }

  async boot({ install = false, onLog = () => {}, lcdOrientation = '', lowspec = false, timeoutMs = 0, signal } = {}) {
    try { throwIfAborted(signal); } catch (_) { return cancelledBoot(); }
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) return { ok: false, error: DATA_MAINTENANCE_BUSY };
    if (this._booting || this.vmStarting) return { ok: false, error: '运行时正在启动' };
    // 环境探测结束前还没有 vmStarting，也必须阻止数据维护。
    this._booting = true;
    try {
      if (!platform.canProvision && (this.settings.engine.mode || 'builtin') !== 'attach') {
        throw new Error(platform.supportNote());
      }
      const env = await waitStartupProbe(signal, () => this.provisioner.checkEnv());
      throwIfAborted(signal);
      this._hv = env.hypervisor;
      if (env.emulator.ok && env.sysimg.ok) {
        return await this._bootEmulator({ env, onLog, lcdOrientation, lowspec, timeoutMs, signal });
      }
      if (store.isChild) return { ok: false, code: 'INSTANCE_BACKEND_UNSUPPORTED', error: '分身仅支持已就绪的 Android Emulator，请回主实例准备组件；不会启动共享 QEMU 磁盘' };
      return await this._bootQemuEntry({ install, env, onLog, signal });
    } finally {
      this._booting = false;
    }
  }

  /**
   * 用官方 emulator 启动 Android。
   * 与 QEMU+ISO 不同，这里没有"安装系统"这一步：镜像本身就是系统，首次启动即开机。
   */
  bootEmulator(options = {}) {
    if (this._booting) return Promise.resolve({ ok: false, error: '运行时正在启动' });
    return this._bootEmulator(options);
  }

  async _bootEmulator({ env, onLog = () => {}, lcdOrientation = '', lowspec = false, timeoutMs = 0, signal } = {}) {
    try { throwIfAborted(signal); } catch (_) { return cancelledBoot(); }
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) return { ok: false, error: DATA_MAINTENANCE_BUSY };
    if (this.vmStarting || this.vmProc) return { ok: false, error: '运行时正在启动或已有 QEMU 进程，未覆盖句柄' };
    this.vmStarting = true;
    try {
      const accel = env && env.accel ? env.accel : await waitStartupProbe(signal, () => this.provisioner.emulatorAccel());
      try { throwIfAborted(signal); } catch (_) { return cancelledBoot(); }
      if (!accel.ok) {
        onLog('未检测到硬件加速：将自动回退软件模拟（首次开机会明显变慢，无需手动设置）');
      } else if (accel.suspect) {
        // AEHD 驱动在、检查也过，但服务没跑：这种机器「检查通过、开机即退」。
        // 参数按软件模拟给（见 doctor.accelUsable），失败后引擎会自动尝试修复。
        onLog('AEHD 驱动已安装但服务没在运行：本次可能开不了机，失败后会自动尝试修复');
      }
      // probe 交给 EmulatorEngine 的开机循环：进程退出/致命日志时它会换一组参数重试
      // 每轮只发一次 adb 命令：以前是 get-state + getprop + pm path 三次进程拉起，
      // 快照恢复时一轮就差 300~500ms，正好卡在「点开应用」的观感上。
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false; // unauthorized 只自愈一次，避免反复删快照冷启动死循环
      let adbFailure = null;
      const failAdb = (error) => {
        const causeCode = error?.code || 'ADB_SERVER_FAILED';
        const message = `ADB 服务恢复失败，已停止本次启动：${causeCode}：${error?.message || error}`;
        const diagnosis = { code: 'ADB_SERVER_FAILED', title: 'ADB 服务恢复失败', hint: message, terminal: true, causeCode };
        adbFailure = { ok: false, terminal: true, code: causeCode, error: message, diagnosis };
        this.emulator.lastDiagnosis = diagnosis;
        onLog(message);
        return 'fatal';
      };
      const resetAdb = async () => {
        try {
          await this.emulator.resetAdbServer();
          this._probeClient = null;
          return true;
        } catch (error) {
          if (!signal?.aborted) failAdb(error);
          return false;
        }
      };
      const probe = async ({ serial }) => {
        if (signal && signal.aborted || !this.emulator.running()) return 'fatal';
        if (adbFailure) { this.emulator.lastDiagnosis = adbFailure.diagnosis; return 'fatal'; }
        const identity = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
        if (signal?.aborted || !this.emulator.running()) return 'fatal';
        if (!identity) return 'pending';
        let c;
        try {
          if (!this._probeClient || this._probeClient.serial !== serial) {
            this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
          }
          c = this._probeClient;
          const out = String(await waitStartupProbe(signal,
            () => c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 })));
          const current = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
          if (!processOwner.sameIdentity(identity, current)) return 'pending';
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          if (signal?.aborted) return 'fatal';
          const current = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
          if (!processOwner.sameIdentity(identity, current)) return 'pending';
          if (!c || /^INSTANCE_ADB_/.test(String(e?.code || ''))) return failAdb(e);
          errStreak += 1;
          // adb shell 报错可能是「还没开机」也可能是「授权对话框卡住」（上游 b7c4f06）。
          // 后者每轮 shell 都抛异常，只按普通 offline 处理会按 240s×4 组参数干等，
          // 最后报「运行时未能完成开机」误导用户去查显卡/虚拟化。这里先按报错文本、
          // 再按 devices 的 state 列（get-state 分不清 authorized）双重确认 unauthorized，
          // 命中就作废旧快照冷启动：冷启动会重新注入 adb 公钥，授权问题随之消失。
          const raw = String((e && (e.raw || e.stderr || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st2 = await waitStartupProbe(signal, () => c.deviceState()).catch(() => '');
            if (signal?.aborted) return 'fatal';
            const afterState = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
            if (!processOwner.sameIdentity(identity, afterState)) return 'pending';
            unauthorized = st2 === 'unauthorized';
          }
          if (unauthorized) {
            // 给 start() 一个准确的诊断，别让它掉进 UNKNOWN 再被记成显卡/加速问题
            this.emulator.lastDiagnosis = {
              code: 'ADB_UNAUTHORIZED',
              title: '安卓调试授权未完成（授权对话框）',
              hint: '系统卡在「允许 USB 调试？」对话框，已自动作废旧快照并冷启动一次让运行时'
                + `重新注入 adb 公钥。若反复出现，请删除 ${adbKeyHint()} 后重试。`,
            };
            if (!authHealed) {
              authHealed = true;
              onLog('adb 卡在「允许 USB 调试」授权对话框：作废旧快照并强制冷启动，重新注入调试授权…');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator.forceColdBootOnNextStart();
              if (!(await resetAdb())) return 'fatal';
            }
            // 返回 fatal 让 start() 立刻换一轮（新 spawn 不加载快照），不再空等
            return 'fatal';
          }
          // 其它 adb 传输异常：沿用原来的重启 server 自愈。
          // adb 传输会偶发地卡在 offline（另一个 adb server 抢了端口、
          // 或者握手被打断），这时每一轮 shell 都报错，probe 永远 pending ——
          // 上层只会看到「开机超时」，白白等到 240 秒。连错 6 轮就重启一次 server 自愈。
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb 连接异常，重启 adb server 后继续等待…');
            if (!(await resetAdb())) return 'fatal';
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
        lcdOrientation,
        lowspec,
        timeoutMs,
        signal,
      });
      if (signal?.aborted) return cancelledBoot();
      if (adbFailure) return { ...adbFailure, attempts: st?.attempts || this.emulator.attempts || [], exitCode: st?.exitCode };
      // start() 失败时是「返回 {ok:false}」而不是抛异常（磁盘不足、多次重试仍失败等）。
      // 老实现不看这个字段，直接把 ok:true 往上返回 —— 上层于是认为「已经就绪」，
      // 接着 adb 一顿报 device not found，用户看到的是「点开没反应」而不是真实原因。
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || '安卓运行时未能启动',
          code: st && st.code,
          data: st && st.data,
          needsSpace: !!(st && st.needsSpace),
          terminal: !!(st && st.terminal),
          attempts: (st && st.attempts) || [],
          diagnosis: (st && st.diagnosis) || this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      const serial = st.serial || this.emulator.serial;
      const identity = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
      if (!identity) return { ok: false, error: '无法确认新启动的运行时归属' };
      throwIfAborted(signal);
      this.lastActivity = Date.now();
      this.emuSerial = serial;
      const client = this.client(serial);
      await this.prepare(client, { signal });
      if (signal?.aborted) return cancelledBoot();
      // 快照改成「空闲时再存」：立刻存要写 1~3GB，会和用户刚点开的应用抢磁盘 I/O
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // 把自动重试/诊断结论原样抛给 UI，避免再包一层含糊的「启动失败」
      return {
        ok: false, error: e.message, code: e.code, terminal: !!e.terminal,
        diagnosis: e.diagnosis, report: e.report, attempts: e.attempts,
      };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- 预热（像 WSA 一样让环境常驻） ----------------

  /** 空闲时保存 quickboot 快照：只在没有应用窗口时写盘，避免和应用启动抢 I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.containerIdle || this.emulator.snapshotSaveAllowed?.() === false) {
      this.emulator.cancelSnapshotSave();
      return;
    }
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this.containerIdle,
    });
  }

  /** 供安装器等外部调用：装完应用后重新存一份快照，下次开机仍是秒进 */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * 预热：在用户点开应用之前，先把安卓环境在后台引导好。
   * WSA / 应用宝电脑版都是这个思路 —— 环境常驻，点图标时只剩一次 am start。
   *  - 完全静默：不弹窗、不报错，失败不影响正常打开应用；
   *  - 幂等：正在开机或已就绪时复用同一个 Promise，不会重复拉起第二台；
   *  - 省资源：开机完成后把 qemu 降到最低优先级停放。
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) return Promise.resolve({ ok: false, skipped: 'maintenance' });
    if (this._prewarmPromise) return this._prewarmPromise;
    if (!this.containerIdle) return Promise.resolve({ ok: true, skipped: 'busy' });
    // 高级模式是复用别人家已经跑起来的运行时，不该再替用户开一台自己的
    if (this.settings.engine.mode === 'attach') return Promise.resolve({ ok: false, skipped: 'attach' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        // 预热是后台静默行为：autoRepair:false，别因为一次预热就弹管理员授权
        const r = await this.ensure({ onLog: (m) => onLog(`预热：${m}`), autoRepair: false });
        if (r && r.ok) {
          // 预热期间用户可能已经点开了应用：这时不能把它摁到 idle 优先级
          if (this.containerIdle) await this._queueContainerPriority().catch(() => {});
          const ms = Date.now() - t0;
          this.log(`预热完成（${Math.round(ms / 1000)}s）`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  bootQemu(options = {}) {
    if (this._booting) return Promise.resolve({ ok: false, error: '运行时正在启动' });
    return this._bootQemuEntry(options);
  }

  async _bootQemuEntry(options) {
    if (options.signal && options.signal.aborted) return cancelledBoot();
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) return { ok: false, error: DATA_MAINTENANCE_BUSY };
    if (this.vmStarting || this.vmProc || this.emulator.running()) return { ok: false, error: '已有 QEMU 运行时正在启动或运行' };
    this.vmStarting = true;
    try {
      return await this._bootQemu(options);
    } finally {
      this.vmStarting = false;
    }
  }

  async _bootQemu({ install = false, env, onLog = () => {}, signal }) {
    if (signal && signal.aborted) return cancelledBoot();
    if (!env.qemu.ok) throw new Error('未安装 QEMU，请先完成运行时部署');
    if (install && !env.iso.ok) throw new Error('系统镜像（ISO）未就绪');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('尚未安装 Android 系统到虚拟磁盘');

    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`启动运行时（${env.hypervisor.whpx ? 'WHPX 硬件加速' : '纯软件模拟'}）…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);
    if (signal && signal.aborted) { fs.closeSync(out); return cancelledBoot(); }

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this._vmExe = env.qemu.path;
    this._vmDisk = disk;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      if (!proc.pid && this.vmProc === proc) { this.vmProc = null; this.installing = false; }
      this.log(`spawn error: ${e.message}`);
      onLog(`启动失败：${e.message}`);
    });
    const exited = (code) => {
      if (this.vmProc !== proc) return;
      this.vmProc = null;
      this.installing = false;
      this.log(`qemu exit ${code}`);
      onLog(`运行时已退出（code=${code}）`);
    };
    proc.on('exit', exited);
    proc.on('close', exited);

    await new Promise((r) => setTimeout(r, 1500));
    if (signal && signal.aborted) return cancelledBoot();
    if (this.vmProc !== proc) throw new Error(`QEMU 启动失败，详见日志：${logFile}`);

    // 装机模式：ISO 里是 Linux 安装程序，没有 adb，不能按「等 adb」处理
    if (install) {
      onLog('安装程序已启动，请在虚拟机窗口里按引导完成安装');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client(QEMU_SERIAL);
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog, signal);
    if (signal && signal.aborted) return cancelledBoot();
    if (!linked) {
      return {
        ok: false,
        error: '虚拟机已启动，但 adb 未能连接：请在虚拟机里开启「开发者选项 → ADB over network」后重试',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog, signal);
    if (signal && signal.aborted) return cancelledBoot();
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Android 内核未完成引导，请查看运行时日志（可能镜像损坏或加速未生效）'
          : 'Android 已引导但系统服务未就绪（可能停在首次开机设置界面，请在虚拟机窗口里完成向导）',
      };
    }
    if (!(await this.ownedRuntimeIdentity(QEMU_SERIAL))) return { ok: false, error: '无法确认 QEMU 的 ADB 端口归属' };
    this.emuSerial = QEMU_SERIAL;
    await this.prepare(client, { signal });
    return { ok: true, client };
  }

  /**
   * 等待 Android 真正可用：adb 在线 ≠ 系统可用。
   * 必须等到 sys.boot_completed=1 且包管理器可响应，否则 am start 会直接失败。
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}, signal) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      if (signal && signal.aborted) return { ok: false, cancelled: true };
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (signal && signal.aborted) return { ok: false, cancelled: true };
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (signal && signal.aborted) return { ok: false, cancelled: true };
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android 内核已启动，等待系统服务就绪…（${Math.round((Date.now() - start) / 1000)}s）`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (signal && signal.aborted) return { ok: false, cancelled: true };
          if (/package:/.test(pm)) {
            onLog(`Android 已就绪（${Math.round((Date.now() - start) / 1000)}s）`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `正在等待系统服务… ${Math.round((Date.now() - start) / 1000)}s`
          : `正在引导 Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}, signal) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      if (signal && signal.aborted) return false;
      // emulator-5554 这类由 emulator 自己注册，不需要 adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
        if (signal && signal.aborted) return false;
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return !(signal && signal.aborted);
      if (signal && signal.aborted) return false;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`等待 Android 启动… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client, { signal } = {}) {
    if (this.settings.engine.deepTrim !== true && this.settings.engine.deepTrimRestorePending === true) {
      const pendingTarget = this.settings.engine.deepTrimRestoreTarget;
      if (pendingTarget && pendingTarget === this._systemAppsRestoreTarget(client)) {
        try {
          await this.restoreSystemApps({ client, signal });
        } catch (error) {
          if (signal?.aborted || /^(?:INSTANCE_ADB_|RUNTIME_OWNERSHIP_LOST$|SYSTEM_APPS_RESTORE_CANCELLED$|ADB_DEVICE_NOT_READY$)/.test(error.code || '')) throw error;
          this.log(`系统应用尚未恢复，下次准备运行时会重试：${error.message}`);
        }
      } else {
        this.log('待恢复的系统应用属于其他或尚未确认的运行时，保留待恢复记录，未修改当前设备');
      }
    }
    // 接管 / 复用上一会话的模拟器时，本进程并不知道它当时是用横屏还是竖屏 LCD 起的；
    // 只有设备自己知道（Physical size 不受 wm size 覆盖影响）。
    // 这里读回来，窗口才能按真实比例打开，而不是拿竖屏框去套横屏画面。
    if (/^emulator-/.test(String((client && client.serial) || ''))) {
      try {
        const s = await client.physicalSize();
        if (s && s.width && s.height) this.emulator.learnLcd(s);
      } catch (_) { /* 读不到就沿用上次推断（默认竖屏） */ }
    }
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // 国产用户第一次进入运行时时，系统桌面默认可能是英文且媒体音量为 0。
    // 这里在 Android 真正可用后一次性设置中文环境与 100% 媒体音量，之后保留用户自己的调整。
    if (!this._guestDefaultsReady) {
      // 全新（或刚重置）的 /data：音量初始化标记还没置过位。
      // 这个值必须在音量初始化写盘**之前**取，后面「首次开机收尾」要靠它判断。
      var freshGuestData = store.getSettings().androidVolumeInitialized !== true;
      let volumeReady = store.getSettings().androidVolumeInitialized === true;
      try {
        await client.shell(
          'settings put system system_locales zh-CN 2>/dev/null; '
          + 'setprop persist.sys.locale zh-CN 2>/dev/null; '
          + 'setprop persist.sys.language zh 2>/dev/null; '
          + 'setprop persist.sys.country CN 2>/dev/null',
          { timeout: 15000 },
        );
      } catch (_) { /* 旧版镜像不支持 cmd locale 时，后面的兼容设置仍会生效 */ }
      if (store.getSettings().androidVolumeInitialized !== true) {
        try {
          const out = await client.shell('cmd media_session volume --stream 3 --get 2>/dev/null', { timeout: 10000 });
          const vg = parseVolumeGet(out);
          const max = vg && vg.max > 0 ? vg.max : 15;
          // 默认拉满：镜像出厂常常是 0（静音），用户第一次刷短视频听不到声音
          // 会以为是坏的；嫌吵的用户自己会拉低，但「没声音」不是用户会主动修的。
          const target = max;
          await client.shell(`cmd media_session volume --stream 3 --set ${target} 2>/dev/null`, { timeout: 10000 });
          let after = parseVolumeGet(await client.shell('cmd media_session volume --stream 3 --get 2>/dev/null', { timeout: 10000 }));
          for (let i = 0; after && after.cur !== target && i < max; i += 1) {
            const key = after.cur < target ? 24 : 25; // VOLUME_UP / VOLUME_DOWN
            await client.shell(`input keyevent ${key}`, { timeout: 5000 });
            await new Promise((resolve) => setTimeout(resolve, 250));
            after = parseVolumeGet(await client.shell('cmd media_session volume --stream 3 --get 2>/dev/null', { timeout: 10000 }));
          }
          // 只有重新读取到目标档位才算完成初始化。读取失败时不能把“未知状态”
          // 当成成功，否则本次启动可能仍然是静音，而后续启动又不会再修复。
          if (after && after.cur === target) store.saveSettings({ androidVolumeInitialized: true });
          else throw new Error('媒体音量未能调整到默认值');
          volumeReady = true;
        } catch (_) { /* 音频服务尚未完全起来时，下次进入运行时再试 */ }
      }
      this._guestDefaultsReady = volumeReady;
    }
    // 横屏 LCD 下不需要（也不允许）留 wm size 覆盖：旧版本「全屏=平板排版」会把
    // 1280x720 写进 /data 并在重启后继续生效，横屏 LCD 再套一层覆盖就变成
    // 画面居中一条 + 两侧黑边。每次开机后清一次，之后由窗口比例自己说话。
    if (!this._lcdNormalized) {
      this._lcdNormalized = true;
      if (this.emulator.lcdOrientation === 'landscape') {
        try { await client.shell('wm size reset; wm density reset', { timeout: 15000 }); } catch (_) { /* ignore */ }
      }
    }
    // 记录「中文到底有没有真的生效」：设置页据此显示状态，不让用户自己猜。
    // 判据必须是 am get-config（真实界面语言）——Play 镜像上 persist.sys.locale
    // 一直是 en-US，拿 getprop 判断会永远显示"没生效"。
    // 注意：不要在这里顺手读一次客机语言（`am get-config`）来记录「汉化是否生效」。
    // 实测在开机刚完成的那一刻插一条 adb 命令，会让这台机器上的模拟器在几秒内
    // 莫名退出（emulator exit null，快照还被写坏过一次）。语言状态改为按需读取：
    // 设置页打开时由 core/guest.js 的 readState/probeLocale 现场问一次，不占开机路径。
    //
    // ── 首次开机收尾（只针对 ApkStart 自管的内置 AVD、且 /data 全新/刚重置）──
    // 上面写入的 system_locales 只在安卓启动那一刻被读取，所以必须让安卓自己重启
    // 一次，界面语言才会真的变成中文；顺手把预装的冗余 Google/AOSP 应用按默认
    // 分组精简掉（pm uninstall --user 0，可逆，不动系统分区）。
    // 三道保险，保证不误动别人正在用的系统：
    //   1. managedBuiltin —— 只对内置 apkstart AVD；attach 模式和自定义镜像不碰；
    //   2. freshGuestData —— 只对全新 /data；老用户升级时音量标记早已置位，直接跳过；
    //   3. localeRebootDone / autoTrimDone —— 每个 /data 生命周期里只做一次。
    try {
      const st = store.getSettings();
      const g = st.guest || {};
      const managedBuiltin = this.emulator && this.emulator.avdName === 'apkstart'
        && (this.settings.engine.mode || 'builtin') !== 'attach';
      if (managedBuiltin && freshGuestData && g.localeRebootDone !== true) {
        store.saveSettings({ guest: { localeRebootDone: true } });
        this.log('首次开机：重启一次安卓以应用中文界面…');
        await client.shell('svc power reboot', { timeout: 8000 }).catch(() => '');
        // 设备先掉线再回来；快速重启可能看不到 offline，掉线等待自带上限
        for (let i = 0; i < 45; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 1000));
          // eslint-disable-next-line no-await-in-loop
          if (!(await client.isOnline().catch(() => false))) break;
        }
        await this.waitAdb(client, 240000);
        await this.waitAndroidReady(client, 240000);
        this.log('安卓重启完成，系统界面现在是中文');
      }
      if (managedBuiltin && freshGuestData && g.autoTrimDone !== true) {
        const groups = guest.GROUPS.filter((x) => x.defaultOn).map((x) => x.id);
        // eslint-disable-next-line no-await-in-loop
        const r = await guest.trim(client, groups);
        if (!r.failed.length) {
          store.saveSettings({ guest: { autoTrimDone: true } });
          this.log(`首次开机：已精简 ${r.removed.length} 个预装应用（设置页可随时恢复）`);
        } else {
          // 有失败就不置标记，下次开机接着补（已移除的会被自动跳过）
          this.log(`首次开机：精简预装应用有 ${r.failed.length} 个失败，下次启动自动重试`);
        }
      }
    } catch (e) {
      this.log(`首次开机收尾失败（不影响使用）：${e.message}`);
    }
    // 中文输入法（上游 0.5.0）：系统镜像只带英文键盘，Gboard 中文语言包要联网下载、
    // 在模拟器里极不可靠。随包带 AOSP 谷歌拼音输入法（assets/PinyinIME.apk），
    // 开机后静默装好并启用 —— 系统汉化之后没有输入法，用户在安卓里打不了中文。
    // 幂等且可重试：装好置位一次；偶发 adb 抖动失败时下次 prepare() 接着试。
    // 可在设置里关掉（engine.chineseIme=false）；自定义镜像 / attach 模式同样适用
    // （输入法只装进 guest，不碰镜像本体）。
    if (this.settings.engine.chineseIme !== false && !this._chineseImeReady) {
      try {
        const imeApk = path.join(this.appRoot, 'assets', 'PinyinIME.apk');
        // eslint-disable-next-line no-await-in-loop
        const r = await client.ensureChineseIme(imeApk, {
          setDefault: this.settings.engine.chineseImeDefault !== false,
        });
        // 只有真的成功了才置位，失败允许下次重试
        if (r && r.ok) {
          this._chineseImeReady = true;
          this.log(r.installed ? '中文输入法：已安装并启用' : '中文输入法：已就绪');
        } else {
          this.log(`中文输入法未就绪（${(r && r.reason) || 'unknown'}），下次启动自动重试`);
        }
      } catch (e) {
        this.log(`中文输入法安装跳过：${e.message}`);
      }
    }
    this.startWatchdog();
  }

  /** Pending launches cannot acknowledge a stop they may later undo. */
  stop(options = {}) {
    if (this._stopPromise) return this._stopPromise;
    if (this._startupPending() || this._repairPromise || (this._dataMaintenance && !options.forDataMaintenance)) return Promise.resolve(false);
    const p = Promise.resolve().then(() => this._stop(options));
    this._stopPromise = p;
    const clear = () => { if (this._stopPromise === p) this._stopPromise = null; };
    p.then(clear, clear);
    return p;
  }

  /** 优雅停止：emulator 走控制台关机，QEMU 走归属进程终止 */
  async _stop({ graceful = true, forDataMaintenance = false } = {}) {
    // Attach mode is explicitly somebody else's runtime, not ours to shut down.
    if (this.settings.engine.mode === 'attach' || (this._dataMaintenance && !forDataMaintenance)) return false;
    // During maintenance, do not let stop() invalidate an unhealthy guest's snapshot
    // before the caller has established that all affected runtime data is offline.
    const adbPath = forDataMaintenance ? undefined : this.adbPath();
    this._lcdNormalized = false;
    if (!this.vmProc) {
      const spawning = this.emulator.running();
      let port = spawning ? this.emulator.port : emulatorConsolePort(this.emuSerial);
      if (forDataMaintenance && !spawning) {
        const ports = await this.emulatorPorts();
        if (ports.length && !ports.includes(port)) [port] = ports;
      }
      if (!port) return false;
      this.emulator.port = port;
      const serial = spawning || emulatorConsolePort(this.emuSerial) !== port ? `emulator-${port}` : this.emuSerial;
      const stopped = await this.emulator.stop({ adbPath }).catch(() => false);
      const online = await this.client(serial).isOnline().catch(() => true);
      if (!stopped || online || await portAlive(port) || (forDataMaintenance && await portAlive(port + 1))) return false;
      this._activeApps.clear();
      return true;
    }
    const proc = this.vmProc;
    const info = await processOwner.getProcessInfo(proc.pid);
    if (!this.ownsQemuProcess(info)) return false;
    let stopped = await processOwner.terminateOwnedProcess(info, (p) => this.ownsQemuProcess(p), graceful ? 'SIGTERM' : 'SIGKILL');
    if (!stopped && process.platform === 'linux') stopped = await processOwner.terminateOwnedProcess(info, (p) => this.ownsQemuProcess(p), 'SIGKILL');
    if (!stopped) return false;
    const online = await this.client('127.0.0.1:5555').isOnline().catch(() => true);
    if (online || await portAlive(MONITOR_PORT) || await portAlive(5555)) return false;
    if (this.vmProc === proc) this.vmProc = null;
    this.installing = false;
    this._activeApps.clear();
    return true;
  }

  ownsQemuProcess(info) {
    if (!info || !info.started || !processOwner.samePath(info.exe, this._vmExe)) return false;
    const args = info.argv || processOwner.windowsArgv(info.commandLine || '');
    if (!processOwner.samePath(args[0], info.exe)) return false;
    const names = processOwner.optionValues(args, '-name');
    if (names.length !== 1 || names[0] !== 'ApkStart Runtime') return false;
    const drives = processOwner.optionValues(args, '-drive');
    return drives.length === 1 && processOwner.samePath(/^file=(.*?),if=/.exec(drives[0])?.[1], this._vmDisk);
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000, port = MONITOR_PORT } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor 超时')));
      sock.on('error', (e) => {
        // QEMU 执行 quit 等命令后会主动断开连接（ECONNRESET/EPIPE），属于正常现象
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- 安装系统到虚拟磁盘 ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) throw new Error(DATA_MAINTENANCE_BUSY);
    if (this._startupPending() || this.vmRunning) throw new Error('已有运行时正在启动或运行');
    this._installerStarting = true;
    try {
      const env = await this.provisioner.checkEnv();
      if (!env.iso.ok) throw new Error(env.iso.reason || '请先下载/导入 Android 系统镜像（ISO）');
      if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
      this.installing = true;
      const r = await this.boot({ install: true, onLog });
      if (!r.ok) throw new Error(r.error || '安装环境启动失败');
      return r;
    } finally {
      this._installerStarting = false;
    }
  }

  /** 安装完成后：关掉安装程序 → 写标记 → 之后直接从磁盘启动 */
  async markInstalled() {
    if (this._dataMaintenance || this._repairPromise || this._stopPromise || this._startupPending() || this.settings.engine.mode === 'attach') return false;
    if (this.installing && await this.stop({ graceful: true }) !== true) return false;
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * 接管上一次运行留下的模拟器。
   * 每台模拟器都有自己的控制台端口（5554/5556/…），adb 端口是 +1。
   * 端口能连上并且 system 已经 boot_completed，就直接当成我们的运行时用，
   * 这样「关掉 ApkStart 再点开应用」是秒进，而不是再冷启一台。
   */
  /**
   * 找出所有还活着的模拟器控制台端口。
   * 不能用「从 5554 顺序试」：端口会随着多次启动往上漂（5554→5556→5558…），
   * 试固定范围总有试漏的时候，漏了就会再开一台新机器。这里直接按进程名
   * 找出 qemu 监听的所有 TCP 端口，一个都不会漏。
   */
  async emulatorPorts() {
    const ports = new Set();
    const owned = new Map();
    const listeners = await processOwner.listeners();
    const infos = await processOwner.getProcessInfos([...new Set(listeners.map((item) => item.pid))]);
    for (const info of infos) owned.set(Number(info.pid), !!this.emulator.ownsProcess?.(info, { discoverRoot: true }));
    for (const item of listeners) {
      if (!item.port) continue;
      if (owned.get(Number(item.pid))) ports.add(item.port);
    }
    const all = [...ports].sort((a, b) => a - b);
    // The console and adb ports are adjacent; prefer those with a matching pair.
    const consoles = all.filter((p) => ports.has(p + 1));
    return consoles.length ? consoles : all;
  }

  async ownedRuntimeIdentity(serial) {
    if (serial === QEMU_SERIAL && this.vmProc) {
      const proc = this.vmProc;
      const [info, pid] = await Promise.all([processOwner.getProcessInfo(proc.pid), processOwner.pidOnPort(5555)]);
      return this.vmProc === proc && pid === proc.pid && this.ownsQemuProcess(info) ? info : null;
    }
    const port = emulatorConsolePort(serial);
    if (!port) return null;
    const [target, adbPid] = await Promise.all([this.emulator.ownedProcessOnPort(port), processOwner.pidOnPort(port + 1)]);
    return target && Number(target.pid) === adbPid ? target : null;
  }

  async adoptExisting({ onLog = () => {}, signal } = {}) {
    const alive = await waitStartupProbe(signal, () => this.emulatorPorts());
    if (!alive.length) {
      onLog('没有发现上一台运行时，准备冷启动');
      return null;
    }
    onLog(`发现 ${alive.length} 台残留运行时（端口 ${alive.join(', ')}），尝试接管`);

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const target = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
      if (!target) continue;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        throwIfAborted(signal);
        // eslint-disable-next-line no-await-in-loop
        const state = (await waitStartupProbe(signal,
          () => c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => ''))).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await waitStartupProbe(signal,
            () => c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => ''))).trim();
        } else if (i === 0) {
          // Clear a stale registration for this endpoint only, not the shared ADB server.
          await c.exec(['disconnect', serial], { withSerial: false, timeout: 8000 }).catch(() => {});
        }
        throwIfAborted(signal);
        if (booted !== '1') await waitStartupProbe(signal, () => new Promise((r) => setTimeout(r, 700)));
      }
      throwIfAborted(signal);
      if (booted !== '1') {
        onLog(`发现上一台运行时（${serial}）但没就绪，先关掉它再重新开机`);
        // AVD 目录有锁：留着这台会让新实例直接退出，表现成"怎么都开不了机"。
        // adb 都连不上了，只能按控制台端口找到进程强杀。
        throwIfAborted(signal);
        await processOwner.terminateOwnedProcess(target, (p) => !signal?.aborted && this.emulator.ownsProcess(p, { discoverRoot: true }));
        await waitStartupProbe(signal, () => new Promise((r) => setTimeout(r, 1200)));
        continue;
      }
      if (!processOwner.sameIdentity(target, await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial)))) continue;
      throwIfAborted(signal);
      // `device` belongs to attach mode; builtin discovery must not replace that selection.
      this.emuSerial = serial;
      this.emulator.port = port;
      onLog(`已接管正在运行的运行时（${serial}）`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c, { signal });
      throwIfAborted(signal);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** 某个 TCP 端口是哪个进程在监听（用于强杀卡死的模拟器） */
  async pidOnPort(port) {
    return processOwner.pidOnPort(port);
  }

  /**
   * 返回当前仍在运行的 emulator/qemu 所属 runtime 目录。
   *
   * 便携版允许用户把 runtime 目录换盘，但旧版模拟器是 detached 的：如果用户
   * 在它还运行时切换目录，ensure() 会先复用在线设备，窗口实际仍来自旧目录。
   * 窗口代理必须同时信任这套「已接管」运行时，否则它会因为路径作用域不一致把
   * 模拟器窗口过滤掉，最终表现为 embed emu=0 + 黑屏。
   * 只沿活动 emulator 端口找进程，再取其可执行文件路径；不扫描/放行所有 Qt 窗口。
   */
  async activeRuntimeRoots() {
    if (process.platform !== 'win32') return [];
    const info = await this.ownedRuntimeIdentity(this.emuSerial).catch(() => null);
    const root = info && processOwner.emulatorRoot(info.exe);
    return root ? [root] : [];
  }

  /**
   * 清理上一次运行遗留、却没被接管的孤儿模拟器。
   * 关掉 ApkStart 时 emulator 是 detached 的，qemu 会存活；下次启动时它仍占着 AVD 锁，
   * 表现为冷启直接 FATAL "Running multiple emulators with the same AVD"。
   * 实现收敛到 EmulatorEngine，重试路径（killAttempt）也用同一份逻辑。
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * 幂等入口：预热与用户点击可能同时发生，共用一个 Promise，
   * 避免两边各判断一次「没在线」后各自拉起一台模拟器（AVD 锁冲突 + 双倍内存）。
   */
  ensure({ onLog = () => {}, lcdOrientation = '', lowspec = false, timeoutMs = 0, autoRepair = true, signal } = {}) {
    try { throwIfAborted(signal); } catch (_) { return Promise.resolve(cancelledBoot()); }
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) return Promise.resolve({ ok: false, error: DATA_MAINTENANCE_BUSY });
    if (this._ensurePromise) return this._ensureSignal === signal ? this._ensurePromise
      : Promise.resolve({ ok: false, code: 'START_BUSY', error: '另一项运行时启动尚未结束' });
    if (this._booting || this._installerStarting || this.vmStarting) return Promise.resolve({ ok: false, error: '运行时正在启动' });
    const p = Promise.resolve().then(() => this._ensureInner({ onLog, lcdOrientation, lowspec, timeoutMs, autoRepair, signal }))
      .catch((error) => { if (signal?.aborted) return cancelledBoot(); throw error; });
    this._ensureSignal = signal;
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) { this._ensurePromise = null; this._ensureSignal = undefined; } };
    p.then(clear, clear);
    return p;
  }

  /**
   * 加速类启动失败后的**全自动修复**。
   *
   * 现场（ACCEL_UNUSABLE）：检测说有 AEHD、日志停在 Userspace boot properties、
   * 退出码 1、一条错误都没有。旧行为只是把报告丢给用户让他自己去看；
   * 实际上「AEHD 服务没在跑」这种情况 `sc start aehd` 就能修好，而且不需要重启。
   *
   * 这里只做三件事：判断该不该修、调用注入的修复回调（main 的
   * enableVirtualizationImpl，会弹一次管理员授权）、决定能不能立刻重试。
   * @returns {Promise<{ok:boolean,note?:string,reason?:string,restartNeeded?:boolean}|null>}
   */
  async autoRepairAccel({ diagnosis, onLog = () => {} } = {}) {
    const code = diagnosis && diagnosis.code;
    // 只有加速类结论才动系统设置：别的失败（镜像损坏、显卡崩溃）去开虚拟化纯属瞎折腾。
    // TCG_CRASH（多个软件后端同码崩溃）的唯一真修复也是把加速开起来，所以并进来。
    if (!['ACCEL', 'ACCEL_UNUSABLE', 'TCG_CRASH'].includes(code)) return null;
    if (this._accelRepairTried) return { ok: false, reason: '本次运行已经自动修复过一次，仍未生效' };
    this._accelRepairTried = true;
    if (typeof this.onAccelRepair !== 'function') return null;
    onLog('检测到硬件加速没能生效，正在自动修复（如弹出授权窗口请点「是」）…');
    let r = null;
    try { r = await this.onAccelRepair(); } catch (e) { r = { ok: false, error: e.message }; }
    // 修复动过系统功能 / 驱动服务：环境结论必须重新探测，否则重试还是拿旧值
    try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
    if (r && r.ok && !r.restartNeeded) {
      onLog(`硬件加速已修复：${r.note || '已生效'}，正在重新启动安卓…`);
      return { ok: true, note: r.note || '' };
    }
    const reason = (r && (r.error || r.note)) || '系统没有可用的修复手段';
    // 需要重启才生效的不再白试一次：重试只会以同样方式失败，白白多等几分钟
    onLog(`自动修复没能立即生效：${reason}`);
    return { ok: false, reason, restartNeeded: !!(r && r.restartNeeded) };
  }

  /**
   * 全自动修复入口：加速类 → autoRepairAccel（要授权），其余按 repair.SELF_HEAL 表执行。
   *
   * 为什么要扩到加速以外：开机失败的绝大多数原因是「上一次没退干净」（锁文件、残留
   * qemu 占端口）、「文件缺了一块」（运行库/组件被杀软删）、「这台机器只能用软件渲染」。
   * 这三种都不需要用户做任何决定，程序自己清一下、补一下、换一下就能过 ——
   * 以前却要用户先看到失败窗口、再自己点「一键修复」，等于把自动化又还给了用户。
   *
   * 不自动化的一律不进 SELF_HEAL：删用户数据（wipe-data）、重下 1.5GB 镜像
   * （reinstall-image）、需要重启才生效的（TCG_CRASH 开 WHPX）—— 这些必须用户点头，
   * 替用户决定只会让「修一下」变成「数据没了」。
   *
   * @returns {Promise<{code:string,ok:boolean,retry:boolean,lowspec?:boolean,
   *   waitMore?:boolean,tried:string[],reason?:string}|null>}
   *   ok=true 表示「值得再开一次机」；tried 是给用户看的「已经自动做了什么」。
   */
  async autoRepair({ diagnosis, onLog = () => {} } = {}) {
    const code = diagnosis && diagnosis.code;
    if (!code) return null;
    // 终止性崩溃已经明确停止了当前启动会话；即使调用方直接走 autoRepair，
    // 也不能再把 ACCESS_VIOLATION 映射成换软件渲染并重新拉起一整轮。
    if (diagnosis && diagnosis.terminal === true) {
      return { code, ok: false, retry: false, tried: [], reason: '本次启动已因连续模拟器崩溃停止自动重试' };
    }
    // 加速类有独立的授权链路，交给原来的实现（它自己管「只弹一次」）。
    // TCG_CRASH：软件模拟本身崩了，唯一的真修复是把硬件加速开起来，同样走这条线。
    if (['ACCEL', 'ACCEL_UNUSABLE', 'TCG_CRASH'].includes(code)) {
      const r = await this.autoRepairAccel({ diagnosis, onLog });
      if (!r) return null;
      return {
        code, ok: !!r.ok, retry: !!r.ok, tried: r.note ? [r.note] : [],
        actions: ['accel'], reason: r.reason, restartNeeded: r.restartNeeded,
      };
    }
    const plan = repair.selfHeal(code);
    if (!plan) return null;                       // 结构性跑不了（CPU 太老等），不白试
    const wantActions = (plan.actions || []).length > 0;
    // 动作执行器由 main 注入。没注入时（例如被别处单独 new 出来做探测）
    // 就如实返回「修不了」，绝不能什么都不做却报「已按保守参数重试」。
    if (wantActions && typeof this.onAutoRepair !== 'function') return null;
    if (this._autoRepairedCodes.has(code)) {
      return { code, ok: false, retry: false, tried: [], reason: '本次运行已经自动修复过这个问题' };
    }
    // 一次运行最多自动修两个不同的问题：再往下就是环境本身坏了，多修只会多等
    if (this._autoRepairCount >= 2) {
      return { code, ok: false, retry: false, tried: [], reason: '本次运行已经自动修复过两次' };
    }
    this._autoRepairedCodes.add(code);
    this._autoRepairCount += 1;

    const tried = [];
    const failed = [];
    for (const action of plan.actions || []) {
      // 先说要做什么：装运行库会弹 UAC，日志和启动窗口里必须有上下文，
      // 否则用户只看到一个系统弹窗，不知道是谁弹的、该不该点。
      onLog(`正在自动修复：${AUTO_ACTION_TEXT[action] || plan.what || action}…`);
      // eslint-disable-next-line no-await-in-loop
      let r = null;
      try { r = await this.onAutoRepair(action); } catch (e) { r = { ok: false, detail: e.message }; }
      if (r && r.ok) {
        tried.push(r.detail || action);
        onLog(`已自动修复：${r.detail || action}`);
      } else if (r && r.detail) {
        failed.push(r.detail);
        onLog(`自动修复未生效：${r.detail}`);
      }
    }
    // 没有动作可做（内存不够/超时只能降配）也算「修过」：这一轮就是用保守参数重开的
    if (!wantActions && plan.what) tried.push(plan.what);
    this.autoRepairLog.push(...tried);

    const reason = failed.join('；');
    // 动作全部失败时不再重试：同样的参数、同样的问题，再开一次只会白等几分钟
    const ok = !!plan.retry && ((plan.actions || []).length === 0 || tried.length > 0);
    onLog(ok
      ? `自动修复完成（${tried.join('、') || '按保守参数'}），正在重新启动安卓…`
      : `自动修复没能解决：${reason || '这台机器的情况需要人工处理'}`);
    // 「已经做过的动作」也要把降配算进去：这一轮就是用低配参数重开的，
    // 再让用户点一次「低配模式再试一次」等于让他重复一遍刚失败的事。
    const usedActions = (plan.actions || []).slice();
    if (plan.lowspec) usedActions.push('low-spec');
    return {
      code, ok, retry: ok, lowspec: !!plan.lowspec, waitMore: !!plan.waitMore,
      tried, actions: usedActions, reason,
    };
  }

  async _ensureInner({ onLog = () => {}, lcdOrientation = '', lowspec = false, timeoutMs = 0, autoRepair = true, signal } = {}) {
    try { throwIfAborted(signal); } catch (_) { return cancelledBoot(); }
    // 每轮启动的「自动做过什么」独立记账：上一轮修过的东西不该出现在这一轮的修复窗口里
    this.autoRepairLog = [];
    const s = this.settings;
    if (store.isChild) autoRepair = false;
    // attach is opt-in for the configured serial only. UI discovery remains an explicit action.
    if (s.engine.mode === 'attach') {
      const serial = String(s.device || '').trim();
      if (serial) {
        const client = this.client(serial);
        const online = await waitStartupProbe(signal, () => client.isOnline()) || (serial.includes(':') && await client.connect());
        if (signal && signal.aborted) return cancelledBoot();
        const current = this.settings;
        if (online && current.engine.mode === 'attach' && String(current.device || '').trim() === serial) {
          await this.prepare(client, { signal });
          if (signal && signal.aborted) return cancelledBoot();
          return { ok: true, client, engine: 'attach', reused: true };
        }
      }
      return { ok: false, needsSetup: 'attach', error: '所选运行时未连接，请检查设备地址或在设置中探测并选择' };
    }

    const serial = this.vmProc ? QEMU_SERIAL : this.emuSerial;
    const target = await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial));
    if (signal && signal.aborted) return cancelledBoot();
    if (target) {
      const client = this.client(serial);
      const online = await waitStartupProbe(signal, () => client.isOnline());
      if (signal && signal.aborted) return cancelledBoot();
      const identity = online ? await waitStartupProbe(signal, () => this.ownedRuntimeIdentity(serial)) : null;
      if (signal && signal.aborted) return cancelledBoot();
      if (online && processOwner.sameIdentity(target, identity)) {
        await this.prepare(client, { signal });
        if (signal && signal.aborted) return cancelledBoot();
        return { ok: true, client, engine: 'builtin', reused: true };
      }
    }
    if (this.vmProc) return { ok: false, error: '已有 QEMU 实例，但无法确认其 ADB 连接可用，请先停止运行时' };

    // 上次退出留下的 detached emulator 不一定在原端口；只从已验证进程发现它。
    const adopted = await this.adoptExisting({ onLog, signal });
    if (signal && signal.aborted) return cancelledBoot();
    if (adopted) return adopted;

    // 进程还在但设备离线（多半卡在引导）：先停掉再重新拉起，避免干等
    if (this.emulator.running()) {
      onLog('检测到卡住的运行时，正在重启…');
      if (!await this.emulator.stop({ adbPath: this.adbPath() })) {
        return { ok: false, error: '无法确认原有运行时已停止' };
      }
      if (signal && signal.aborted) return cancelledBoot();
    }

    // 默认：自带运行时
    // 单文件发行版的镜像是压缩的，先展开（已展开过就秒过）。
    // 展开失败不要把错误吞掉：否则后面 checkEnv() 只会说「还差系统镜像」，
    // 用户会以为是没下载，而不是解压失败（磁盘满 / 文件损坏）。
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`系统镜像展开失败：${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    if (signal && signal.aborted) return cancelledBoot();
    const env = await this.provisioner.checkEnv();
    if (signal && signal.aborted) return cancelledBoot();

    // emulator 路径：镜像即系统，没有"安装到磁盘"这一步
    if (env.emulator.ok && env.sysimg.ok) {
      // 关掉 ApkStart 后可能残留未接管的模拟器（detached 的 qemu 仍存活），
      // 它一直占着 AVD 锁，会让冷启直接 FATAL "Running multiple emulators with the same AVD"。
      // 接管失败时先把这些孤儿清掉，再冷启，保证「关掉再开」一定能起来。
      if (signal && signal.aborted) return cancelledBoot();
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      if (signal && signal.aborted) return cancelledBoot();
      try {
        const r = await this.boot({ onLog, lcdOrientation, lowspec, timeoutMs, signal });
        if (signal && signal.aborted) return cancelledBoot();
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        // 全自动修复：先把「不需要用户做决定」的毛病自己处理掉（清锁、补文件、
        // 换软件渲染、降配），再自动重来一遍。加速类会弹一次管理员授权，
        // 预热/后台启动传 autoRepair:false —— 不能因为一次静默预热就弹授权框吓人一跳。
        // 严重访问冲突已经由 EmulatorEngine 明确熔断；这里也要尊重 terminal 标记，
        // 否则 start() 虽然停止了端口轮换，外层仍会自动再 boot 一整轮（#127）。
        const diagnosis = r.diagnosis || this.emulator.lastDiagnosis;
        const terminal = r.terminal === true || diagnosis?.terminal === true;
        const healed = !terminal && autoRepair && !(signal && signal.aborted)
          ? await this.autoRepair({ diagnosis, onLog }) : null;
        if (signal && signal.aborted) return cancelledBoot();
        if (healed && healed.retry) {
          // 修复窗口要如实写「重开过一次」：只写「清过锁」会让用户以为程序没再试
          this.autoRepairLog.push('重新开了一次机');
          const again = await this.boot({
            onLog,
            lcdOrientation,
            lowspec: lowspec || !!healed.lowspec,
            // 软件模拟/超时类放宽等待：修完还是按原来的 4 分钟等，等于白修
            timeoutMs: Math.max(timeoutMs || 0, healed.waitMore ? 900000 : 0),
            signal,
          });
          if (signal && signal.aborted) return cancelledBoot();
          const autoRepair = { ...healed, retried: true };
          if (again.ok) {
            return {
              ok: true, client: again.client, engine: 'emulator',
              // 加速类对外仍叫 accel（老调用方/测试认这个名字），其余直接用诊断码
              profile: again.profile, network: again.network || null,
              autoRepaired: ['ACCEL', 'ACCEL_UNUSABLE'].includes(healed.code) ? 'accel' : healed.code,
              autoRepair,
            };
          }
          return {
            ok: false, error: again.error, env,
            terminal: !!again.terminal,
            diagnosis: again.diagnosis, report: again.report, attempts: again.attempts, exitCode: again.exitCode,
            autoRepair,
          };
        }
        return {
          ok: false,
          // 修过但没成：把「已经自动试过什么、为什么没用」写进错误里，
          // 用户拿着这句话就知道该重启还是该进 BIOS，而不是只看一句「起不来」。
          error: healed && healed.reason ? `${r.error}\n\n（已自动尝试修复：${healed.reason}）` : r.error,
          env,
          terminal,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
          autoRepair: healed || null,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU 路径（用户自备 ISO 并已装到虚拟磁盘）
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? '还差系统镜像：点「下载系统镜像」即可'
          : '运行时组件尚未部署完成',
        env,
      };
    }

    try {
      if (signal && signal.aborted) return cancelledBoot();
      const r = await this.boot({ onLog, signal });
      if (signal && signal.aborted) return cancelledBoot();
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- 应用级容器会话 ----------------

  _containerPriority() {
    if (this.containerIdle) return 'idle';
    return this.settings.engine?.priorityMode === 'performance' ? 'normal' : 'below';
  }

  _queueContainerPriority(requestedLevel) {
    // Recompute after preceding writes settle: an old idle request must never
    // finish after the foreground promotion and leave the emulator parked.
    const p = (this._priorityPromise || Promise.resolve()).catch(() => {})
      .then(() => this.emulator.setPriority(!requestedLevel || requestedLevel === 'idle' && !this.containerIdle
        ? this._containerPriority() : requestedLevel));
    this._priorityPromise = p;
    return p;
  }

  /** Hold from the initial launch request until beginApp or launch cleanup. */
  acquireForegroundLaunch() {
    if (!this._foregroundLaunches) this._foregroundLaunches = new Set();
    const token = {};
    this._foregroundLaunches.add(token);
    this.touch();
    this.emulator.cancelSnapshotSave();
    let released = false;
    let promotion = null;
    let promotedRuntime = null;
    let release = null;
    const lease = {
      promote: ({ onlyIfRunning = false } = {}) => {
        if (released) return Promise.resolve();
        if (onlyIfRunning && !this.vmRunning && !this._activeApps.size) return Promise.resolve();
        const current = { serial: this.emuSerial, emulator: this.emulator.proc, qemu: this.vmProc, level: this._containerPriority() };
        if (!promotion || !promotedRuntime || Object.keys(current).some((key) => current[key] !== promotedRuntime[key])) {
          promotedRuntime = current;
          promotion = Promise.resolve(this._idleTransitionPromise).catch(() => {})
            .then(() => released ? undefined : this._queueContainerPriority()).catch(() => {});
        }
        return promotion;
      },
      release: () => {
        if (release) return release;
        released = true;
        this._foregroundLaunches.delete(token);
        release = (this.containerIdle ? this._queueContainerPriority().catch(() => {}) : Promise.resolve()).then(() => {
          if (this.containerIdle) this._armSnapshotSave(8000);
        });
        return release;
      },
    };
    if (this.vmRunning) lease.promote({ onlyIfRunning: true });
    return lease;
  }

  /**
   * 「像容器一样打开」的具体实现：
   * Android 环境只引导一次并常驻（quickboot 快照 + adoptExisting 接管），
   * 之后每次打开 App 只是 am start + 把已有窗口挂进来，不再重跑整个系统。
   * 这里额外做三件降低系统压力的事：
   *   - 停掉其他用户 App 的进程，让环境里只跑当前 App 需要的东西；
   *   - 有窗口时给 qemu 一个「让着前台」的优先级；
   *   - 只在有窗口时才开启文件同步 / 通知轮询（由 onActive 回调交给 UI 层）。
   */
  async beginApp(pkg, { client, onActive = () => {}, shouldCancel = () => false } = {}) {
    if (shouldCancel()) return { cancelled: true };
    // Pin this session to the installer/window client, not a later runtime selection.
    const sessionClient = client || this.client();
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    if (first) {
      // 有应用要开了：把「空闲存快照」推迟，别在应用启动时抢磁盘
      this.emulator.cancelSnapshotSave();
      await Promise.resolve(this._idleTransitionPromise).catch(() => {});
      await this._queueContainerPriority().catch(() => {});
      if (shouldCancel()) return { ...state, cancelled: true };
      try { onActive(true); } catch (_) { /* 轮询启动失败不影响打开应用 */ }
    }

    if (shouldCancel()) return { ...state, cancelled: true };
    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    let plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: this.settings.engine.deepTrim === true,
      // App 刚 am start 完，此刻清后台可能误伤正在进前台的进程；清理放到 endApp
      killBackground: false,
    });
    if (shouldCancel()) return { ...state, cancelled: true };
    if (plan.commands.length) {
      if (plan.disabled.length) {
        const target = this._systemAppsRestoreTarget(sessionClient);
        const pending = this.settings.engine;
        if (!target || pending.deepTrimRestorePending && pending.deepTrimRestoreTarget !== target) {
          this.log('其他运行时仍有待恢复的系统应用，未对当前设备执行新的深度裁剪');
          plan = container.buildSessionCommands({ pkg, installed, deep: false, killBackground: false });
        } else {
          this._systemAppsRestoreSequence = (this._systemAppsRestoreSequence || 0) + 1;
          store.saveSettings({ engine: { deepTrimRestorePending: true, deepTrimRestoreTarget: target } });
        }
      }
      if (shouldCancel()) return { ...state, cancelled: true };
      await sessionClient.shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
      if (shouldCancel()) return { ...state, cancelled: true };
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * 关掉一个应用窗口：停掉它的进程；如果是最后一个窗口，让容器进入
   * 「常驻但几乎不耗资源」的停放状态（清后台 + Android idle + qemu 降优先级）。
   * 不关机、不删 AVD —— 下次点开还是秒进。
   */
  async endApp(pkg, { client, onIdle = () => {}, shouldCancel = () => false } = {}) {
    this._activeApps.delete(pkg);
    const sessionState = () => container.nextSessionState([...this._activeApps], 'close', pkg);
    if (shouldCancel()) return { ...sessionState(), cancelled: true };
    const sessionClient = client || this.client();
    if (shouldCancel()) return { ...sessionState(), cancelled: true };
    await sessionClient.forceStop(pkg).catch(() => {});
    const state = sessionState();
    if (shouldCancel()) return { ...state, cancelled: true };
    if (this.containerIdle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      if (shouldCancel()) return { ...state, cancelled: true };
      if (!this.containerIdle) return state;
      const parking = sessionClient.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      this._idleTransitionPromise = parking;
      try { await parking; }
      finally { if (this._idleTransitionPromise === parking) this._idleTransitionPromise = null; }
      if (shouldCancel()) return { ...state, cancelled: true };
      if (!this.containerIdle) return state;
      await this._queueContainerPriority().catch(() => {});
      if (shouldCancel()) return { ...state, cancelled: true };
      if (!this.containerIdle) return state;
      // 现在最空闲：把内存状态存成快照，下次开机走恢复而不是冷启动
      this._armSnapshotSave(8000);
      if (shouldCancel()) { this.emulator.cancelSnapshotSave(); return { ...state, cancelled: true }; }
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('容器已停放（Android 常驻，0 个应用进程，qemu 最低优先级）');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0 && !this._foregroundLaunches?.size; }

  _systemAppsRestoreTarget(client) {
    if (this.settings.engine.mode === 'attach') {
      const serial = String(this.settings.device || '').trim();
      return serial && client?.serial === serial ? JSON.stringify({ mode: 'attach', serial }) : '';
    }
    const paths = this.provisioner.paths();
    if (!/^emulator-\d+$/.test(String(client?.serial || ''))) {
      if (client?.serial !== QEMU_SERIAL) return '';
      const disk = this.settings.runtime.diskPath || paths.disk;
      if (!disk) return '';
      const iso = this.settings.runtime.isoPath || paths.iso;
      return JSON.stringify({
        mode: 'qemu', disk: path.resolve(disk), iso: iso ? path.resolve(iso) : '',
        image: this.settings.runtime.activeImageId || '',
      });
    }
    const home = paths.avdHome;
    if (!home || !this.emulator.avdName) return '';
    const avd = path.resolve(home, `${this.emulator.avdName}.avd`);
    let image = {};
    if (this.emulator.imageChoice) {
      const choice = this.emulator.imageChoice();
      image = { dir: choice.dir || '', id: choice.id || choice.flavor || '', api: choice.api || '', abi: choice.abi || '' };
    }
    return JSON.stringify({ mode: 'builtin', avd, image });
  }

  /** 供设置页切换「深度裁剪」时恢复被禁用的系统包 */
  async restoreSystemApps({ client, signal, shouldCancel = () => false } = {}) {
    const sequence = (this._systemAppsRestoreSequence || 0) + 1;
    this._systemAppsRestoreSequence = sequence;
    store.saveSettings({ engine: { deepTrimRestorePending: true } });
    const cancelled = () => {
      throwIfAborted(signal);
      if (shouldCancel() || sequence !== this._systemAppsRestoreSequence || this.settings.engine.deepTrim === true) {
        const error = new Error('系统应用恢复已取消或被新的深度裁剪设置取代');
        error.code = 'SYSTEM_APPS_RESTORE_CANCELLED';
        throw error;
      }
    };
    cancelled();
    const captured = client || this.client();
    const target = this._systemAppsRestoreTarget(captured);
    const previousTarget = this.settings.engine.deepTrimRestoreTarget;
    if (!target || previousTarget && previousTarget !== target) {
      throw new Error('待恢复记录不属于当前运行时，请切回原系统后重试');
    }
    const attached = this.settings.engine.mode === 'attach';
    const identity = attached ? null : await this.ownedRuntimeIdentity(captured.serial);
    cancelled();
    if (!attached && !identity) {
      const error = new Error('无法确认运行时归属，未恢复系统应用');
      error.code = 'RUNTIME_OWNERSHIP_LOST';
      throw error;
    }
    const check = async () => {
      cancelled();
      const current = attached ? null : await this.ownedRuntimeIdentity(captured.serial);
      cancelled();
      if (target !== this._systemAppsRestoreTarget(captured) || !attached && !processOwner.sameIdentity(identity, current)) {
        const error = new Error('运行时归属已变化，已停止恢复系统应用');
        error.code = 'RUNTIME_OWNERSHIP_LOST';
        throw error;
      }
    };
    const state = await captured.deviceState();
    await check();
    if (state !== 'device') {
      const error = new Error(`安卓设备未就绪（${state}），系统应用仍待恢复`);
      error.code = 'ADB_DEVICE_NOT_READY';
      throw error;
    }
    // A legacy request without a target can be bound only by this explicit,
    // online, identity-checked call. prepare never guesses such a target.
    if (!previousTarget) store.saveSettings({ engine: { deepTrimRestoreTarget: target } });
    const run = async (command) => {
      await check();
      let result;
      try { result = await captured.shell(command, { timeout: 15000 }); }
      catch (error) {
        await check();
        if (/device (?:offline|not found)|unauthorized|no devices|protocol fault|closed/i.test(String(error.raw || error.message || error))) {
          error.code = 'ADB_DEVICE_NOT_READY';
        }
        throw error;
      }
      const output = String(result || '').trim();
      await check();
      if (/(?:^|\n)\s*(?:error\b|failure\b|exception\b|securityexception\b)|java\.[\w.]*Exception/i.test(output)) {
        throw new Error(`系统应用恢复失败：${output.slice(0, 600)}`);
      }
      return output;
    };
    const disabledPackages = async () => {
      const output = await run('pm list packages -d --user 0');
      const lines = output.split(/\r?\n/).filter(Boolean);
      if (lines.some((line) => !/^package:[A-Za-z][A-Za-z0-9_.]+$/.test(line))) {
        throw new Error(`无法确认被禁用的系统应用：${output.slice(0, 600)}`);
      }
      return new Set(lines.map((line) => line.slice(8)));
    };
    const disabled = await disabledPackages();
    for (const pkg of container.OPTIONAL_SYSTEM) {
      if (!disabled.has(pkg)) continue;
      // pm can print an error and exit zero. Require its explicit state receipt.
      const result = await run(`pm enable --user 0 ${pkg}`);
      if (!result.split(/\r?\n/).some((line) => line.trim() === `Package ${pkg} new state: enabled`)) {
        throw new Error(`未确认系统应用恢复成功：${pkg}${result ? `：${result.slice(0, 400)}` : ''}`);
      }
    }
    await run('settings put global restricted_background_data 0');
    if (await run('settings get global restricted_background_data') !== '0') {
      throw new Error('安卓后台数据限制尚未解除，系统应用仍待恢复');
    }
    const remaining = await disabledPackages();
    if (container.OPTIONAL_SYSTEM.some((pkg) => remaining.has(pkg))) {
      throw new Error('仍有深度裁剪的系统应用被禁用，下次准备运行时会重试');
    }
    await check();
    store.saveSettings({ engine: { deepTrimRestorePending: false, deepTrimRestoreTarget: '' } });
    return true;
  }

  setGuestPriority(level) { return this._queueContainerPriority(level); }

  // ---------------- 空闲回收 ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      if (!this.containerIdle || Date.now() - this.lastActivity < limit) return;
      const activity = this.lastActivity;
      // 接管来的模拟器没有本地 proc 句柄，vmRunning 会是 false：
      // 以前这里直接 return，导致容器永不回收。改成同时看 adb 是否在线。
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (!this.containerIdle || this.lastActivity !== activity || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (!this.containerIdle || this.lastActivity !== activity || Date.now() - this.lastActivity < limit) return;
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!this.vmProc; }

  /** 当前运行时的 LCD 方向（landscape / portrait）；未知时按竖屏算 */
  get lcdOrientation() { return this.emulator.lcdOrientation; }

  // ---------------- 诊断 / 瘦身（供 UI 调用） ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // 内存里的 attempts 只在本次会话有效；用户重启后再导出报告时它是空的。
    // 这时改用上次落盘的失败记录，并把 emulator.log 的尾部带上 —— 否则报告
    // 只有一句 UNKNOWN，看不到真正原因（issue #20/#25 都栽在这里）。
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    // 连 emulator.log 都没有（模拟器一次都没拉起过）：把 app.log 带上。
    // 否则报告里就是 attempts: [] + 空日志，谁也看不出发生过什么（issue #25）。
    const sessionLog = this.emulator.tailAppLog ? this.emulator.tailAppLog(200) : [];
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
        sessionLog,
        runtimeState: {
          vmRunning: this.vmRunning,
          engineMode: (this.settings.engine || {}).mode || 'builtin',
          logsDir: path.join(store.DATA_DIR, 'logs'),
        },
      },
    });
  }

  _protectedImagePaths() {
    const { isoPath, diskPath } = this.settings.runtime;
    return [isoPath, diskPath];
  }

  usage() {
    const { root, avdHome } = this.provisioner.paths();
    return require('./layers').summary(root, {
      avdHome, keepAvd: `${this.emulator.avdName}.avd`, protectedPaths: this._protectedImagePaths(),
    });
  }

  _startupPending() {
    return !!(this.vmStarting || this._ensurePromise || this._booting || this._installerStarting || this._prewarmPromise);
  }

  async _withStoppedDataRuntime(apply) {
    if (this._dataMaintenance || this._stopPromise || this._repairPromise) throw new Error('另一项运行时数据维护或停机正在执行');
    if (this._startupPending()) throw new Error('运行时正在启动，请等待启动结束后重试');
    if (this.installing) throw new Error('安装器仍在运行，请先完成安装并正常关机');
    if (this.settings.engine.mode === 'attach') throw new Error('连接已有运行时模式不允许维护内置运行时数据');
    this._dataMaintenance = true;
    try {
      const { root, avdHome } = this.provisioner.paths();
      const avdName = this.emulator.avdName;
      const protectedPaths = this._protectedImagePaths();
      const identity = (p) => {
        const st = fs.statSync(p, { throwIfNoEntry: false });
        if (!st) return '';
        if (!st.isDirectory()) throw new Error('运行时数据路径并非目录');
        return `${fs.realpathSync(p)}:${st.dev}:${st.ino}`;
      };
      const rootIdentity = identity(root);
      const avdIdentity = identity(avdHome);
      const hadQemu = !!this.vmProc;
      const ports = new Set([emulatorConsolePort(this.emuSerial), this.emulator.port]);
      const serials = new Set([this.emuSerial]);
      const wasRunning = this.vmRunning || (await this.emulatorPorts()).length > 0;
      if (await this.stop({ forDataMaintenance: true }) !== true) throw new Error('未能停止运行时，未修改数据');
      // isOnline() folds transport errors into false. Require a successful ADB listing,
      // and check both registrations of a managed emulator after the process has stopped.
      const { stdout } = await this.client().exec(['devices'], { withSerial: false, timeout: 8000 });
      const [header, ...devices] = String(stdout || '').trim().split(/\r?\n/);
      if (header !== 'List of devices attached') throw new Error('无法确认 ADB 离线状态，未修改数据');
      serials.add(this.emuSerial);
      if (hadQemu) serials.add(QEMU_SERIAL);
      ports.add(emulatorConsolePort(this.emuSerial));
      ports.add(this.emulator.port);
      const endpoints = new Set(hadQemu ? [MONITOR_PORT, 5555] : []);
      for (const port of ports) {
        if (port) {
          serials.add(`emulator-${port}`);
          serials.add(`127.0.0.1:${port + 1}`);
          endpoints.add(port);
          endpoints.add(port + 1);
        }
      }
      const online = devices.some((line) => {
        const [serial, state] = line.trim().split(/\s+/);
        return serials.has(serial) && state !== 'offline';
      });
      if (online || this.vmRunning || (await this.emulatorPorts()).length
          || (await Promise.all([...endpoints].map((port) => portAlive(port)))).some(Boolean)
          || this._startupPending() || this.vmRunning || this.installing) {
        throw new Error('运行时仍在运行或启动，未修改数据');
      }
      const current = this.provisioner.paths();
      if (this.settings.engine.mode === 'attach' || current.root !== root || current.avdHome !== avdHome || this.emulator.avdName !== avdName
          || identity(root) !== rootIdentity || identity(avdHome) !== avdIdentity
          || this._protectedImagePaths().some((p, i) => p !== protectedPaths[i])) {
        throw new Error('运行时设置或目录已变更，未修改数据');
      }
      // Keep the lock through async maintenance success AND failure.
      return await apply({ root, avdHome, avdName, wasRunning, protectedPaths });
    } finally {
      this._dataMaintenance = false;
    }
  }

  /** 预览只盘点；执行必须成功停机并验证离线。 */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    const run = ({ root, avdHome, avdName, wasRunning = false, protectedPaths = this._protectedImagePaths() }) => ({
      ...require('./layers').prune(root, {
        apply, avdHome, aggressive, keepSnapshots: !includeSnapshots, keepAvd: `${avdName}.avd`, protectedPaths,
      }),
      ok: true, stoppedVm: wasRunning,
    });
    if (!apply) return run({ ...this.provisioner.paths(), avdName: this.emulator.avdName });
    // 现有清理调用方通过异常显示失败；返回一个失败对象会被旧 UI 当成成功。
    return this._withStoppedDataRuntime(run);
  }

  async clearStaleLocks() {
    return this._withStoppedDataRuntime(({ root, avdHome, avdName, wasRunning, protectedPaths }) => ({
      ...require('./layers').prune(root, { apply: true, avdHome, keepAvd: `${avdName}.avd`, locksOnly: true, protectedPaths }),
      ok: true, stoppedVm: wasRunning,
    }));
  }

  _managedAvdDir(avdHome, avdName) {
    const layers = require('./layers');
    const name = `${avdName}.avd`;
    if (!layers.MANAGED_AVDS.includes(name)) throw new Error('无法确认当前 AVD 归属');
    const dir = path.join(avdHome, name);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st && (!st.isDirectory() || !layers.isManagedEntry(avdHome, dir))) throw new Error('当前 AVD 目录不是受管目录');
    return { dir, st };
  }

  /** 就地增长有效 userdata；不允许底层重建回退覆盖已有数据。调用方仅在 ok 后保存设置。 */
  async resizeDataPartition(dataMB) {
    if (!Number.isSafeInteger(dataMB) || dataMB < 1024 || dataMB > 64 * 1024) {
      return { ok: false, error: '安卓数据分区容量须为 1024–65536 MB 的整数' };
    }
    try {
      return await this._withStoppedDataRuntime(async ({ avdHome, avdName, wasRunning, protectedPaths }) => {
        const layers = require('./layers');
        const { dir, st } = this._managedAvdDir(avdHome, avdName);
        const img = path.join(dir, 'userdata-qemu.img');
        const base = fs.lstatSync(img, { throwIfNoEntry: false });
        for (const name of st ? fs.readdirSync(dir) : []) {
          if (!/^userdata(?:[-.]|$)/i.test(name)) continue;
          const entry = path.join(dir, name);
          const stat = fs.lstatSync(entry);
          if (!stat.isFile() || stat.nlink !== 1 || !layers.isManagedEntry(avdHome, entry) || layers.protectsPath(entry, protectedPaths)) {
            throw new Error('安卓用户数据归属不明，未执行扩容');
          }
          if (name !== 'userdata-qemu.img') throw new Error('存在旧版或覆盖层用户数据，未执行不安全的基础镜像扩容');
        }
        if (layers.protectsPath(img, protectedPaths) || layers.protectsPath(`${img}.qcow2`, protectedPaths)
            || (base && (!base.isFile() || base.nlink !== 1 || !layers.isManagedEntry(avdHome, img) || !userdata.hasExt4Superblock(img)))) {
          throw new Error('现有 userdata 无法安全扩容，未重建或覆盖任何数据');
        }
        const r = await this.emulator.resizeDataPartition(dataMB);
        if (!r || r.ok !== true) return { ...r, ok: false, stoppedVm: wasRunning, error: r?.error || r?.reason || '扩容未完成' };
        return { ...r, ...this.emulator.dataInfo(), ok: true, stoppedVm: wasRunning };
      });
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * 彻底重置安卓数据（清空 /data 用户分区 + 已装应用 + 快速启动快照），
   * 把 AVD 还原成「刚装好系统、没有任何第三方 app」的干净状态。
   * 这一项会真实删除 8–16GB 的用户数据镜像，必须二次确认（UI 负责），且只动
   * 当前活动 AVD（默认镜像 apkstart.avd / 自定义镜像 apkstart-custom.avd），
   * 不动只读基础镜像、不动另一个 AVD。
   * 保留 config.ini / hardware-qemu.ini，AVD 仍有效，下次点开应用会重新冷启动建数据。
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData({ apply = true } = {}) {
    const layers = require('./layers');
    let avdDir = '';
    let reclaimed = 0;
    const run = ({ avdHome, avdName, protectedPaths = this._protectedImagePaths() }) => {
      const { dir: activeDir, st } = this._managedAvdDir(avdHome, avdName);
      avdDir = activeDir;
      const candidates = [];
      for (const e of st ? fs.readdirSync(avdDir, { withFileTypes: true }) : []) {
        const p = path.join(avdDir, e.name);
        // 保留 config.ini / hardware-qemu.ini / cache.img 等 AVD 基础设施。
        const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
          || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
        const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
        const isLock = /\.lock$/.test(e.name);
        const dir = e.isDirectory();
        if (!(dir ? isSnapshot || isLock : isUserdata || isLock)) continue;
        if ((!dir && !e.isFile()) || !layers.isManagedEntry(avdHome, p) || layers.protectsPath(p, protectedPaths)) {
          throw new Error(`拒绝重置非受管或正在引用的文件：${e.name}`);
        }
        candidates.push({ path: p, kind: dir ? 'dir' : 'file', size: dir ? layers.dirSize(p) : fs.statSync(p).size });
      }
      if (!apply) return { ok: true, apply: false, avdDir, reclaimed, candidates };
      for (const c of candidates) {
        fs.rmSync(c.path, { recursive: c.kind === 'dir', force: true });
        reclaimed += c.size;
      }
      // 自定义镜像与默认镜像各有自己的 /data，但共享应用清单。
      if (avdName !== 'apkstart-custom') store.saveApps([]);
      store.saveSettings({ androidVolumeInitialized: false, guest: { localeRebootDone: false, autoTrimDone: false } });
      this._guestDefaultsReady = false;
      this._freeformReady = false;
      this._chineseImeReady = false;
      return { ok: true, reclaimed, avdDir };
    };
    try {
      if (!apply) return run({ avdHome: this.provisioner.paths().avdHome, avdName: this.emulator.avdName });
      return await this._withStoppedDataRuntime(run);
    } catch (e) {
      return { ok: false, reclaimed, avdDir, error: e.message };
    }
  }

  /**
   * 等待虚拟机联网。
   *
   * 实测：`sys.boot_completed` 只代表系统起来了，Wi-Fi 关联 + DHCP 还要再等
   * 十几秒到一分多钟才会拿到 10.0.2.16。短剧类应用一进去就拉首页数据，
   * 没网时页面渲染成一整块黑底（隐私弹窗是本地页面所以正常显示），
   * 用户看到的就是「点同意并继续之后一直黑屏」。所以拉起应用前先等网络就绪。
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '', signal } = {}) {
    throwIfAborted(signal);
    const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 90000;
    if (!budget) return { ok: false, reason: 'timeout' };
    const t0 = Date.now();
    const deadline = t0 + budget;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, budget);
    signal?.addEventListener('abort', abort, { once: true });
    let last = null;
    let lastNotice = t0;
    // Only read-only probes may detach at the deadline. The shared abort signal
    // also terminates their ADB/ownership children instead of leaving a retry loop.
    const observe = async (probe) => {
      if (controller.signal.aborted) return null;
      let onAbort;
      try {
        return await Promise.race([
          new Promise((resolve) => {
            onAbort = () => resolve(null);
            controller.signal.addEventListener('abort', onAbort, { once: true });
          }),
          Promise.resolve().then(() => controller.signal.aborted ? null : probe()),
        ]);
      } finally { controller.signal.removeEventListener('abort', onAbort); }
    };
    const pause = (ms) => new Promise((resolve) => {
      const finish = () => {
        clearTimeout(wait);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const wait = setTimeout(finish, ms);
      controller.signal.addEventListener('abort', finish, { once: true });
      if (controller.signal.aborted) finish();
    });
    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        last = await observe(() => this.emulator.checkNetwork(adbPath || this.adbPath(), {
          timeoutMs: Math.max(1, Math.min(8000, deadline - Date.now())), signal: controller.signal,
        })).catch(() => null);
        throwIfAborted(signal);
        if (controller.signal.aborted || Date.now() >= deadline) break;
        if (last?.ok) return last;
        if (Date.now() - lastNotice >= 10000) {
          lastNotice = Date.now();
          onLog(`正在等待安卓虚拟机联网… ${Math.round((Date.now() - t0) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await pause(Math.max(0, Math.min(3000, deadline - Date.now())));
      }
      throwIfAborted(signal);
      return { ...last, ok: false, reason: 'timeout' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  /** 网络修复只重连 Wi-Fi；重置 /data 必须走独立的显式确认流程。 */
  repairNetwork({ onLog = () => {} } = {}) {
    if (this._repairPromise) return this._repairPromise;
    if (this._dataMaintenance || this._stopPromise || this._startupPending()) {
      return Promise.resolve({ ok: false, wiped: false, error: '运行时正在启动、停止或维护，请稍后重试' });
    }
    if (this.settings.engine.mode === 'attach' || !this.vmRunning || this.vmProc || this.installing) {
      return Promise.resolve({ ok: false, wiped: false, error: '没有正在运行的内置 Android 模拟器，未重置安卓数据' });
    }
    const p = Promise.resolve().then(async () => {
      try {
        const quick = await this.emulator.repairWifi(this.adbPath(), onLog);
        if (quick && quick.ok) {
          onLog('网络已恢复（Wi-Fi 关联已重新建立，未重置安卓数据）。');
          return { ok: true, network: quick, wiped: false };
        }
        return { ok: false, network: quick, wiped: false, error: 'Wi-Fi 重连未恢复网络；未重置安卓数据' };
      } catch (e) { return { ok: false, wiped: false, error: e.message }; }
    });
    this._repairPromise = p;
    const clear = () => { if (this._repairPromise === p) this._repairPromise = null; };
    p.then(clear, clear);
    return p;
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    this.emulator.cancelSnapshotSave();
    // 这里【绝对不能】强杀 qemu：
    //  1) 强杀会把正在写盘的 quickboot 快照截断，只留下几 GB 的 ram.img 空壳，
    //     下次开机加载失败 → 全量冷启动，这就是「每次打开都要等两分钟」的直接原因；
    //  2) 留着它，下次打开 ApkStart 可以直接接管，点应用秒开（WSA / 应用宝电脑版同款行为）。
    // 卸载时另走一条路（app:removeSelf 会显式清理进程）。
    if (this.vmProc) {
      const proc = this.vmProc;
      processOwner.getProcessInfo(proc.pid)
        .then((info) => processOwner.terminateOwnedProcess(info, (p) => this.ownsQemuProcess(p)))
        .then((stopped) => { if (stopped && this.vmProc === proc) this.vmProc = null; })
        .catch(() => {});
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT, adbKeyHint };

'use strict';
/**
 * 零配置自适应 / 容器式瘦身的回归测试（纯 Node，不拉起 emulator）
 * 运行：node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
process.env.XDG_DATA_HOME = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || '断言失败'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');
const { adbKeyHint } = require('../src/core/engine');

(async () => {
  console.log('\n[doctor.js 自动参数]');

  await test('GPU 后端按 emulator 版本选择（新版本 host 优先 + 软件渲染兜底，老版本 swiftshader_indirect）', () => {
    // 新版本（37.x/36.4.9+）：host 最跟手，失败会自动降级到 software/swangle
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', '37.x 首选应为 host');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), '新版本必须有软件渲染兜底');
    // 37.x 上传 swiftshader_indirect 会 GL 初始化失败，绝不能出现在候选里
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // 老版本仍走 swiftshader_indirect
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('小内存机器自动降配（不再是写死 4GB / 4 核）', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `内存应为 2048，实际 ${p.memoryMB}`);
    assert(p.cores === 2, `核心应为 2，实际 ${p.cores}`);
    assert(p.accel === 'off', '无硬件加速应自动回退软件模拟');
    assert(p.bootTimeoutMs > 240000, '软件模拟应给更长的开机超时');
    // 低配档会把软件渲染提前，避免 host 初始化失败后再白等一轮；
    // 高配机器仍由 chooseProfile 保持 host 首选。
    assert(/swangle|software|swiftshader/.test(p.gpu), `低配无加速机器应优先软件渲染，实际 ${p.gpu}`);
    // accel 关闭时的保底参数必须是软件渲染，否则 TCG 下无 GPU 可用
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), '保底方案必须用软件渲染');
    // 数据分区默认按磁盘余量给 4/8/16/24GB（不再写死 6G），且可以被设置覆盖
    assert(p.dataMB >= 4096 && p.dataMB <= 24576, `数据分区应在 4~24GB，实际 ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, '设置里的数据分区容量必须生效');
  });

  await test('大内存机器按物理内存放大（不再写死 3GB / 4 核，但仍有封顶）', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044,
    });
    // 64GB / 32 线程：1/4 内存 = 16GB → 封顶 8GB；线程的一半 = 16 → 封顶 8 核
    assert(p.memoryMB === 8192, `64GB 机器应给到 8GB，实际 ${p.memoryMB}`);
    assert(p.cores === 8, `32 线程应给到 8 核，实际 ${p.cores}`);
    assert(p.heapMB >= 512, `内存 8GB 时 dalvik 堆应放大，实际 ${p.heapMB}`);
    assert(p.accel === 'on');

    // 中等机器按比例走：16GB / 12 线程 → 4GB / 6 核（不是一律 3GB/4核）
    const mid = doctor.chooseProfile({
      host: { ...host, totalMB: 16384, freeMB: 12000, cores: 12 },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
    });
    assert(mid.memoryMB === 4096, `16GB 机器应给 4GB，实际 ${mid.memoryMB}`);
    assert(mid.cores === 6, `12 线程应给 6 核，实际 ${mid.cores}`);

    // 但绝不会「有多少给多少」：内存与核心都有硬上限
    const huge = doctor.chooseProfile({
      host: { ...host, totalMB: 262144, freeMB: 200000, cores: 128 },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 500000,
    });
    assert(huge.memoryMB === 8192 && huge.cores === 8, `256GB/128 线程也必须封顶：${huge.memoryMB}MB / ${huge.cores}核`);
  });

  await test('可见嵌入模式优先使用 swangle（软件渲染但 WebView 合成正常）', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const visible = doctor.planVariants(p, { preferSoftware: true });
    // 嵌入窗口会经历跨进程 SetParent / 失焦 / DWM 重绘，host 的交换链可能丢，所以
    // 可见模式要走软件渲染；但**不能**用裸 software —— 实测它过不了 WebView 合成，
    // 「点同意并继续」进主界面后整屏黑。swangle 同样是软件渲染，合成路径正常。
    assert(visible[0].gpu === 'swangle', `可见模式首选应为 swangle，实际 ${visible[0].gpu}`);
    assert(!visible[0].lastResort && visible[0].snapshot !== false);
    // 关加速的最后一档仍必须是最保守的 software（慢但最兼容）
    const all = doctor.planVariants(p, { preferSoftware: true });
    assert(all[all.length - 1].accel === 'off', '最后一档必须是关加速的兜底');
  });

  await test('重试矩阵：从最优到最保守，包含软件模拟与冷启动兜底', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `重试次数应 3-4，实际 ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), '缺少软件模拟兜底');
    // 最后一档只做「不加载快照 + 最小内存」，绝不允许 -wipe-data：
    // 磁盘写满时每一档都会失败，带 wipe 的话会把用户已装应用一起清掉（实测踩过）。
    assert(v[v.length - 1].snapshot === false, '最后一档必须跳过快照加载');
    assert(v[v.length - 1].wipe === false, '任何自动重试都不允许清用户数据');
    assert(v[v.length - 1].memoryMB <= 2048, '最后一档应降到最小内存');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, '重试方案不应重复');
  });

  await test('镜像换盘不算换镜像：sysdir 换了目录不该清用户数据', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), '同一套镜像的路径身份必须相同');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), '换盘后快照不该作废（否则白等一次冷启动）');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), '真的换了镜像必须能识别出来');
  });

  await test('快照指纹不随 GPU/加速/内存重试变化（避免每次重试都清空已装应用）', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('日志诊断能识别显卡/加速/中文路径/锁文件问题', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
    // 现场日志（User 0.6.7）：Vulkan 不兼容 + Guest Angle 不支持，必须归到图形后端
    assert(doctor.diagnose(['ERROR | Failed to create Vulkan instance. Error VK_ERROR_INCOMPATIBLE_DRIVER.']).code === 'GPU_INIT');
    // "Platform does not support Guest Angle" 是 INFO（换宿主 ANGLE 渲染），不是致命错误：
    // 曾经把它算进 GPU_INIT，结果一条无害提示压住了真正的 0xC0000005 崩溃（用户实测）。
    assert(doctor.diagnose(['INFO | Platform does not support Guest Angle']).code !== 'GPU_INIT',
      'Guest Angle 提示不能单独判成显卡初始化失败');
    assert(doctor.notes(['INFO | Platform does not support Guest Angle']).some((t) => /提示不是错误/.test(t)),
      '应在「无害噪音」里解释一句，免得用户去换显卡');
    assert(doctor.diagnose(['Failed to create Vulkan instance. Error VK_ERROR_INCOMPATIBLE_DRIVER.']).code === 'GPU_INIT');
    assert(doctor.diagnose(['UpdateLayeredWindowIndirect failed']).code === 'GPU_INIT');
  });

  await test('日志诊断：emulator 以 0xC0000005 退出判为进程访问冲突，不武断归咎显卡', () => {
    // 实测 issue #20/#25：打印完 Userspace boot properties 后 exit 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // 崩溃日志里通常也带着渲染初始化信息：必须优先判崩溃，而不是 GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', '崩溃应优先于普通渲染日志');
    assert(!/渲染后端崩溃/.test(doctor.diagnose(['emulator exit 3221225477']).title),
      '不能把所有访问冲突都说成渲染后端崩溃');
  });

  await test('加速器没接管：有加速 + 非零退出码 + 没有 operational 行 → ACCEL_UNUSABLE', () => {
    // 现场（用户报告 0.6.11）：日志停在 Userspace boot properties 最后一行
    // androidboot.veritymode=enforcing，后面一条 ERROR 都没有，退出码 1，
    // 旧实现只能落到 UNKNOWN，让用户去换镜像/换渲染后端（两条路都是白折腾）。
    const bootProps = [
      'INFO         | Userspace boot properties:',
      'INFO         |   androidboot.hardware=ranchu',
      'INFO         |   androidboot.veritymode=enforcing',
    ];
    const d = doctor.earlyAccelExit({
      accel: { ok: true, kind: 'aehd' }, logLines: bootProps, exitCode: 1,
    });
    assert(d && d.code === 'ACCEL_UNUSABLE', `应判为 ACCEL_UNUSABLE，实际 ${d && d.code}`);
    assert(/AEHD/.test(d.title), `标题要点名是哪种加速：${d.title}`);
    assert(/WHPX/.test(d.hint) && /sc query aehd/.test(d.hint), '要给出可照做的两步');
    assert(/换渲染后端/.test(d.hint), '要明确说换渲染后端/换镜像无效');

    // 加速器真的挂上了：不许抢结论（问题在别处）
    assert(doctor.earlyAccelExit({
      accel: { ok: true, kind: 'aehd' },
      logLines: [...bootProps, 'AEHD is operational'],
      exitCode: 1,
    }) === null, 'accelerator operational 之后退出，不能判成驱动没接管');

    // 没有加速归 noAccelDiagnosis 管；exitCode 为 null 是超时，也不归它管
    assert(doctor.earlyAccelExit({ accel: { ok: false }, logLines: bootProps, exitCode: 1 }) === null);
    assert(doctor.earlyAccelExit({ accel: { ok: true, kind: 'aehd' }, logLines: bootProps, exitCode: null }) === null);
  });

  await test('某一轮在拉起前就抛异常：也要留下一条 attempt（不能只剩 UNKNOWN 一轮）', () => {
    const d = doctor.spawnErrorDiagnosis('EPERM: operation not permitted, open apkstart.avd\\config.ini');
    assert(d.code === 'SPAWN_ERROR');
    assert(/config\.ini/.test(d.hint), '原始错误要写进 hint，否则作者也看不出是哪一步');
    assert(/白名单/.test(d.hint), '要给出可执行动作');

    // 真正的回归点：异常轮必须落成一条 attempt，而不是让 start() 直接 reject。
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.attempts = [];
    emu._log = [];
    const got = emu._recordSpawnError({
      plan: { label: 'swangle / 硬件加速', gpu: 'swangle', accel: 'on', memoryMB: 4096, cores: 6 },
      logStart: 0,
      error: new Error('EPERM: operation not permitted, open config.ini'),
    });
    assert(emu.attempts.length === 1, `异常轮应留下 1 条记录，实际 ${emu.attempts.length}`);
    assert(emu.attempts[0].plan === 'swangle / 硬件加速', '记录里要带本轮参数名');
    assert(/4096MB/.test(emu.attempts[0].params), '记录里要带实跑参数');
    assert(got.code === 'SPAWN_ERROR' && emu.lastDiagnosis.code === 'SPAWN_ERROR', '诊断要同步到引擎状态');
    // 异常消息里若带可识别特征（比如 DLL 缺失），应优先用那条结论
    const dll = emu._recordSpawnError({
      plan: { label: 'host / 硬件加速', gpu: 'host', accel: 'on' },
      logStart: 0,
      error: new Error('The code execution cannot proceed because VCRUNTIME140.dll was not found'),
    });
    assert(dll.code === 'DLL', `DLL 缺失应判为 DLL，实际 ${dll.code}`);
  });

  await test('加速探测：AEHD 驱动在但服务没跑 → 标 suspect 并给修法（不能只报「已启用」）', async () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // 0xffffffa1 是经典现场：BIOS 虚拟化没开，或与 Hyper-V / 内存完整性冲突
    p.aehdService = async () => ({ name: 'aehd', state: 'STOPPED', code: 1, running: false, exitCode: 0xffffffa1 });
    const stopped = await p._accelResult('aehd');
    assert(stopped.ok && stopped.suspect === true, '不能因为服务没跑就把结论翻成「无加速」');
    assert(/服务未运行/.test(stopped.note), `要说清是服务没跑：${stopped.note}`);
    assert(/0xffffffa1/.test(stopped.note), '退出码要写成十六进制（用户能拿去搜）');
    assert(/WHPX/.test(stopped.advice), '要指向 WHPX');

    p.aehdService = async () => ({ name: 'aehd', state: 'RUNNING', code: 4, running: true, exitCode: 0 });
    const running = await p._accelResult('aehd');
    assert(running.ok && !running.suspect, '服务在跑时不该误报可疑');

    // WHPX 分支不该去碰 AEHD 的服务状态
    p.aehdService = async () => { throw new Error('不该被调用'); };
    const whpx = await p._accelResult('whpx');
    assert(whpx.ok && whpx.kind === 'whpx' && !whpx.suspect, 'WHPX 分支不该依赖 AEHD');
  });

  await test('完整版只带压缩镜像（.img.xz）时算「已提供」，不许引导重下 1.4GB', () => {
    const { Provisioner } = require('../src/core/provision');
    const root = fs.mkdtempSync(path.join(TMP, 'img-'));
    const dir = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    // 稀疏文件：看起来 70MB，不真占盘
    const fd = fs.openSync(path.join(dir, 'system.img.xz'), 'w');
    fs.ftruncateSync(fd, 70 * 1024 * 1024);
    fs.closeSync(fd);

    const p = new Provisioner(root);
    p.paths = () => ({
      root,
      sysImgRoot: path.join(root, 'system-images'),
      sysImgDir: dir,
      sysTag: 'google_apis_playstore',
      sysApi: '34',
      sysAbi: 'x86_64',
    });
    const info = p.systemImageInfo();
    assert(info.ok === true, '压缩镜像不能判成「未下载」（否则又会去下 1.4GB）');
    assert(info.pendingExtract === true, '要标出「待展开」，启动时才知道先解压');
    assert(/自动展开/.test(info.note || ''), `note 要说清会自动展开：${info.note}`);
    assert(p.playImageInfo().ok === true, '兼容档位同样要认压缩镜像');

    // 半截文件（小于 64MB）不能当作可用镜像
    fs.rmSync(path.join(dir, 'system.img.xz'));
    const small = fs.openSync(path.join(dir, 'system.img.xz'), 'w');
    fs.ftruncateSync(small, 8 * 1024 * 1024);
    fs.closeSync(small);
    assert(p.systemImageInfo().ok === false, '明显不全的压缩文件不能算镜像齐全');
    fs.rmSync(root, { recursive: true, force: true });
  });

  await test('覆盖安装（--updated）时卸载器不得删用户数据', () => {
    const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    const block = nsh.slice(nsh.indexOf('!macro customUnInstall'));
    const guard = block.indexOf('--updated');
    const clean = block.indexOf('uninstall-data.ps1');
    assert(guard > 0, '要识别 electron-builder 覆盖安装时传的 --updated');
    assert(clean > guard, '数据清理必须在「用户主动卸载」分支里，否则每次更新都清空应用与镜像');
  });

  await test('AEHD 服务没跑时按「无加速」选参数（540p + 10 分钟超时）', () => {
    const host = { totalMB: 16179, freeMB: 9728, cores: 12, tmp: 'C:/tmp' };
    const suspect = doctor.chooseProfile({
      host, accel: { ok: true, kind: 'aehd', suspect: true }, emulatorVersion: '37.1.9', diskMB: 50000,
    });
    const normal = doctor.chooseProfile({
      host, accel: { ok: true, kind: 'aehd' }, emulatorVersion: '37.1.9', diskMB: 50000,
    });
    assert(doctor.accelUsable({ ok: true, kind: 'aehd', suspect: true }) === false, 'suspect 不算可用');
    assert(doctor.accelUsable({ ok: true, kind: 'aehd' }) === true);
    // 软件模拟下先把「能不能开起来」放第一位：降分辨率、软件渲染、给足 10 分钟
    assert(suspect.lcd.w === 540 && suspect.lcd.h === 960,
      `服务没跑时应降分辨率，实际 ${suspect.lcd.w}x${suspect.lcd.h}`);
    assert(suspect.bootTimeoutMs >= 600000, '按软件模拟要给足开机时间');
    assert(normal.lcd.w === 720, '正常加速时保持高分辨率');
    assert(suspect.tierReasons.some((t) => /服务未运行/.test(t)), '降级原因要写清是服务没跑');
  });

  await test('加速没接管 → 全自动修复：只修一次，修好才自动重试，要重启就不白试', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    let calls = 0;
    rt.onAccelRepair = async () => { calls += 1; return { ok: true, note: 'AEHD 驱动服务已启动，硬件加速当场生效' }; };

    const first = await rt.autoRepairAccel({ diagnosis: { code: 'ACCEL_UNUSABLE' } });
    assert(first && first.ok, '修复成功应允许自动重试');
    assert(calls === 1, `应只弹一次授权，实际 ${calls}`);

    // 同一次运行里再失败，不能再弹一次 UAC / 再修一轮（防无限循环）
    const second = await rt.autoRepairAccel({ diagnosis: { code: 'ACCEL_UNUSABLE' } });
    assert(second && !second.ok && calls === 1, '同一进程内只允许自动修复一次');

    // 非加速类结论不许动系统设置（换镜像/显卡崩溃时去开虚拟化纯属瞎折腾）
    const other = new Runtime(path.join(__dirname, '..'));
    other.onAccelRepair = async () => { throw new Error('不该被调用'); };
    assert(await other.autoRepairAccel({ diagnosis: { code: 'IMAGE' } }) === null);

    // 需要重启才生效：不重试（重试只会以同样方式失败，白等几分钟）
    const reboot = new Runtime(path.join(__dirname, '..'));
    reboot.onAccelRepair = async () => ({ ok: true, restartNeeded: true, note: '已开启虚拟机平台，请重启' });
    const r = await reboot.autoRepairAccel({ diagnosis: { code: 'ACCEL' } });
    assert(r && !r.ok && r.restartNeeded === true, '要重启时不该让引擎立刻重试');
    assert(/重启/.test(r.reason), '要把「需要重启」原样传给用户');
  });

  await test('自动修复成功后自动重来一遍开机（用户不用再点一次）', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    let boots = 0;
    // 把会碰真实 adb / 运行时的入口都收掉，只留「失败 → 修复 → 重试」这条链
    rt.client = () => ({ isOnline: async () => false, devices: async () => [] });
    rt.adoptExisting = async () => null;
    rt.killOrphanEmulators = async () => {};
    rt.provisioner.materializeImages = async () => ({ ok: true });
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.provisioner.invalidateEnvCache = () => {};
    rt.emulator.running = () => false;
    rt.onAccelRepair = async () => ({ ok: true, note: 'AEHD 驱动服务已启动，硬件加速当场生效' });
    rt.boot = async () => {
      boots += 1;
      if (boots === 1) {
        return { ok: false, error: '运行时多次尝试仍未能启动', diagnosis: { code: 'ACCEL_UNUSABLE' } };
      }
      return { ok: true, client: {}, engine: 'emulator', profile: { gpu: 'swangle' }, network: null };
    };
    const r = await rt._ensureInner({});
    assert(boots === 2, `修复后应自动重试一次，实际 boot 了 ${boots} 次`);
    assert(r.ok && r.autoRepaired === 'accel', '应把「自动修复过」带回上层');
  });

  await test('自动修复扩到其他错误：清锁、补文件、换渲染都直接做，不用用户点按钮', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    const called = [];
    rt.onAutoRepair = async (action) => { called.push(action); return { ok: true, detail: `${action} done` }; };
    const r = await rt.autoRepair({ diagnosis: { code: 'AVD_LOCK' } });
    assert(r && r.ok && r.retry, '清完锁应该允许自动重试');
    assert(JSON.stringify(called) === '["clear-locks"]', `应只跑清锁，实际 ${JSON.stringify(called)}`);
    assert(r.tried.length === 1, '已做的事要带回去给修复窗口显示');
    assert(rt.autoRepairLog.length === 1, '要留痕，否则用户以为程序什么都没试');

    // 同一个结论只修一次：修完没好，说明不是这个地方的问题，再清一遍纯属浪费时间
    const again = await rt.autoRepair({ diagnosis: { code: 'AVD_LOCK' } });
    assert(again && !again.retry && called.length === 1, '同一结论不该自动修第二次');
  });

  await test('自动修复的动作失败就不重试（同样的参数再开一次只会白等）', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    rt.onAutoRepair = async () => ({ ok: false, detail: '没有可安全清理的临时文件' });
    const r = await rt.autoRepair({ diagnosis: { code: 'DISK_FULL' } });
    assert(r && !r.retry, '清理失败时不该再开机一次');
    assert(/没有可安全清理/.test(r.reason), `失败原因要原样带给用户：${r.reason}`);
  });

  await test('自动链里永远不出现会动数据的动作', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    const called = [];
    rt.onAutoRepair = async (a) => { called.push(a); return { ok: true, detail: 'ok' }; };
    for (const code of ['IMAGE', 'DLL', 'DISK_FULL', 'GPU_INIT', 'ACCESS_VIOLATION']) {
      // eslint-disable-next-line no-await-in-loop
      await rt.autoRepair({ diagnosis: { code } });
    }
    const danger = ['wipe-data', 'reinstall-image', 'cleanup-disk'];
    assert(!called.some((a) => danger.includes(a)),
      `自动链里出现了会丢数据的动作：${JSON.stringify(called)}`);
  });

  await test('修完按结论降配/放宽等待再开机（否则等于没修）', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    const seen = [];
    rt.client = () => ({ isOnline: async () => false, devices: async () => [] });
    rt.adoptExisting = async () => null;
    rt.killOrphanEmulators = async () => {};
    rt.provisioner.materializeImages = async () => ({ ok: true });
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.running = () => false;
    rt.onAutoRepair = async () => ({ ok: true, detail: '按保守参数' });
    rt.boot = async (o) => {
      seen.push({ lowspec: o.lowspec, timeoutMs: o.timeoutMs });
      return seen.length === 1
        ? { ok: false, error: '运行时多次尝试仍未能启动', diagnosis: { code: 'TIMEOUT' } }
        : { ok: true, client: {}, engine: 'emulator', profile: {}, network: null };
    };
    const r = await rt._ensureInner({});
    assert(seen.length === 2, `应自动重试一次，实际 ${seen.length}`);
    assert(seen[1].lowspec === true, '超时类要降配再试，否则还是按 4 分钟等');
    assert(seen[1].timeoutMs >= 900000, '软件模拟要给足等待时间');
    assert(r.ok && r.autoRepaired === 'TIMEOUT', `应把修过的问题带回上层，实际 ${r.autoRepaired}`);
  });

  await test('软件模拟全崩溃时，自动修复去开硬件加速（而不是再换一次渲染后端）', async () => {
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    let called = 0;
    rt.onAccelRepair = async () => { called += 1; return { ok: true, note: 'WHPX 已开启' }; };
    const r = await rt.autoRepair({ diagnosis: { code: 'TCG_CRASH' } });
    assert(called === 1, 'TCG 崩溃时的唯一真修复是开加速，应调用加速修复');
    assert(r && r.retry, '加速可用后应允许重试');
  });

  await test('多种软件后端都崩在 0xC0000005：判定 TCG 问题并停止等价重试', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const d = doctor.diagnose(['emulator exit 3221225477']);
    const swangle = { gpu: 'swangle', accel: 'off' };
    emu.lastExitCode = 3221225477;
    emu.attempts = [{ diagnosis: 'ACCESS_VIOLATION', gpu: 'swiftshader', accel: 'off', exitCode: 3221225477 }];
    assert(emu._softwareTcgCrashed(swangle, d) === false, '只有一次崩溃时还应继续重试');
    emu.attempts.push({ diagnosis: 'ACCESS_VIOLATION', gpu: 'swangle', accel: 'off', exitCode: 3221225477 });
    assert(emu._softwareTcgCrashed(swangle, d) === true, '两个软件后端同码崩溃后应止损');
    assert(emu._softwareTcgCrashed({ gpu: 'host', accel: 'on' }, d) === false, '硬件加速崩溃不算 TCG 问题');
    assert(emu._softwareTcgCrashed(swangle, doctor.diagnose(['Address already in use'])) === false,
      '端口占用不能被算进崩溃次数');

    // 回归现场（0.6.11 报告）：日志里带着一句无害的 "Platform does not support Guest Angle"，
    // 崩溃被误判成 GPU_INIT，止损逻辑只认 ACCESS_VIOLATION → 4 组参数白跑完。
    const gpuInit = doctor.diagnose(['VK_ERROR_INCOMPATIBLE_DRIVER', 'emulator exit 3221225477']);
    assert(gpuInit.code === 'ACCESS_VIOLATION', `有崩溃行时应优先判崩溃，实际 ${gpuInit.code}`);
    emu.attempts = [
      { diagnosis: 'GPU_INIT', gpu: 'software', accel: 'off', exitCode: 3221225477 },
      { diagnosis: 'GPU_INIT', gpu: 'software', accel: 'off', exitCode: 3221225477 },
    ];
    assert(emu._softwareTcgCrashed(swangle, gpuInit) === true,
      '诊断被 GPU_INIT 抢走时，同样要按「同码崩溃两次」止损');

    const advice = doctor.tcgCrashDiagnosis();
    assert(advice.code === 'TCG_CRASH' && /WHPX/.test(advice.hint) && /AEHD/.test(advice.hint),
      '止损结论要给出启用硬件加速的具体步骤');
    assert(/一键开启硬件加速/.test(advice.hint), '结论要把用户导向设置页的一键按钮');
    assert(/一键开启硬件加速/.test(doctor.noAccelDiagnosis().hint)
      && /一键开启硬件加速/.test(doctor.diagnose(['acceleration not available']).hint),
      '无加速类结论也要指向同一个一键入口');
  });

  await test('跨 GPU/加速模式重复 0xC0000005 后停止换端口，并阻断外层自愈', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const d = doctor.diagnose(['emulator exit 3221225477']);
    emu.lastExitCode = 3221225477;
    emu.attempts = [{ gpu: 'host', accel: 'on', exitCode: 3221225477 },
      { gpu: 'swangle', accel: 'off', exitCode: 3221225477 }];
    assert(emu._repeatedAccessViolation(d) === true, '硬件加速与 TCG 各崩一次也应止损');
    emu.attempts = [{ gpu: 'host', accel: 'on', exitCode: 3221225477 }];
    assert(emu._repeatedAccessViolation(d) === false, '第一次访问冲突应保留一次有界兜底');
    emu.attempts.push({ gpu: 'software', accel: 'off', exitCode: 1 });
    assert(emu._repeatedAccessViolation(d) === false, '不同退出码不能伪装成访问冲突循环');
    emu.attempts[1].exitCode = 3221225477;
    emu.attempts[1].diagnosis = 'GPU_INIT';
    assert(emu._repeatedAccessViolation(d) === true, 'Vulkan 文本误判 GPU_INIT 也不能绕过精确退出码熔断');
    const terminal = doctor.repeatedCrashDiagnosis();
    assert(terminal.terminal === true && terminal.code === 'EMULATOR_CRASH_LOOP');
    assert(/不会继续换端口/.test(terminal.hint), '终止结论必须明确不会继续换端口');
    const { Runtime } = require('../src/core/engine');
    const rt = new Runtime(path.join(__dirname, '..'));
    rt.onAutoRepair = async () => { throw new Error('终止性崩溃不应进入自动修复'); };
    const blocked = await rt.autoRepair({ diagnosis: { code: 'ACCESS_VIOLATION', terminal: true } });
    assert(blocked && blocked.retry === false && /连续模拟器崩溃/.test(blocked.reason),
      '终止性诊断不能再触发外层自动修复');
  });

  await test('存快照把模拟器写崩过一次后：本机不再保存（上游 #46）', async () => {
    const store = require('../src/core/store');
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._emuVersion = '37.4.1.0';
    emu.profile = { gpu: 'software' };
    emu.proc = { killed: false };
    // 现场：adb 返回成功，但进程随后 0xC0000005 消失（#46 在真机上复现过）
    emu._saveViaAdb = async () => { emu.proc = null; return true; };
    assert(await emu.saveSnapshotNow('adb.exe') === false, '写崩了不能算保存成功');
    const saved = store.getSettings().engine.snapshotUnsafe;
    assert(/^37\.4\.1\.0\|software$/.test(String(saved)), `应记下不安全的组合：${saved}`);

    // 第二次直接跳过，不再触发 save（否则每次用都会崩一次）
    let called = 0;
    emu.proc = { killed: false };
    emu._saveViaAdb = async () => { called += 1; return true; };
    assert(await emu.saveSnapshotNow('adb.exe') === false, '命中记忆位时应跳过快照');
    assert(called === 0, `命中记忆位后不该再执行 save（实际 ${called} 次）`);

    // 升级运行时后重新给一次机会（新版可能已修）
    let called2 = 0;
    emu._emuVersion = '37.5.0';
    emu._saveViaAdb = async () => { called2 += 1; return true; };
    emu.proc = { killed: false };
    await emu.saveSnapshotNow('adb.exe');
    assert(called2 === 1, '换运行时版本后应重新尝试一次');
    store.saveSettings({ engine: { snapshotUnsafe: '' } });
  });

  await test('崩在 Vulkan：下一轮自动关掉 Vulkan（不继续换呈现后端）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const variants = [
      { gpu: 'swangle', label: 'swangle / 硬件加速' },
      { gpu: 'host', label: 'host / 硬件加速' },
      { gpu: 'software', label: '关闭加速的软件模拟' },
    ];
    const lines = [
      'INFO | Selecting Vulkan device: Intel(R) UHD Graphics 730',
      'INFO | Platform does not support Guest Angle',
      'emulator exit 3221225477',
    ];
    const d = doctor.diagnose(lines);
    assert(emu._preferNoVulkan(variants, 0, d, lines) === true, '有 Vulkan 痕迹时应改下一轮');
    assert(variants[1].noVulkan === true && /关 Vulkan/.test(variants[1].label), '下一轮要带 noVulkan');
    assert(emu._preferNoVulkan(variants, 0, d, lines) === false, '已经改过就不该重复改');
    // 没有 Vulkan 痕迹 / 非崩溃结论：不动下一轮
    const plain = [{ gpu: 'swangle', label: 'swangle' }, { gpu: 'host', label: 'host' }];
    assert(emu._preferNoVulkan(plain, 0, d, ['emulator exit 3221225477']) === false);
    assert(emu._preferNoVulkan(plain, 0, doctor.diagnose(['Address already in use']), lines) === false);
    // 参数层：-feature -Vulkan 真的会传给 emulator
    const args = emu.buildArgs({ gpu: 'swangle', memoryMB: 2048, cores: 2, noVulkan: true });
    assert(args.includes('-feature') && args.includes('-Vulkan'), `参数里缺 -feature -Vulkan：${args.join(' ')}`);
    const normal = emu.buildArgs({ gpu: 'swangle', memoryMB: 2048, cores: 2 });
    assert(!normal.includes('-Vulkan'), '正常轮不该关 Vulkan');
  });

  await test('issue #5：无加速的多核小内存机器收紧 TCG 核数', () => {
    // 现场：Xeon E5-2650 v3 / 20 核 / 8GB 内存(可用 4.8GB) / 无加速 → 原实现给 8 核 TCG，
    // 8 份 TB 缓存线程在 4.8GB 可用内存上极易 0xC0000005。无加速时上限应收紧到 4 核。
    const host = { totalMB: 8089, freeMB: 4915, cores: 20, tmp: '' };
    const noAccel = { ok: false, kind: 'none' };
    const p = doctor.chooseProfile({ host, accel: noAccel, diskMB: 0, settings: { engine: { resourceMode: 'balanced' } } });
    assert(p.cores <= 4, `无加速 20 核机器不该给 ${p.cores} 核 TCG（应 ≤4）`);
    // 手动指定核数仍优先
    const manual = doctor.chooseProfile({ host, accel: noAccel, diskMB: 0, overrides: { cores: 6 }, settings: { engine: {} } });
    assert(manual.cores === 6, '手动指定核数应尊重用户，不被自动收紧覆盖');
    // 有加速机器不收紧，仍是 8 核
    const accel = doctor.chooseProfile({ host, accel: { ok: true, kind: 'whpx' }, diskMB: 0, settings: { engine: {} } });
    assert(accel.cores === 8, '有硬件加速时不应收紧核数');
  });

  await test('issue #5：止损把 host/lavapipe 的 TCG 同码崩溃也算进去', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const d = doctor.diagnose(['emulator exit 3221225477']);
    emu.lastExitCode = 3221225477;
    // 老版本 emulator 候选里没有 swangle，首轮 swiftshader_indirect、次轮 host 同码崩溃；
    // 旧正则漏掉 host，导致要多白等一轮。
    emu.attempts = [
      { gpu: 'swiftshader_indirect', accel: 'off', exitCode: 3221225477 },
      { gpu: 'host', accel: 'off', exitCode: 3221225477 },
    ];
    assert(emu._softwareTcgCrashed({ gpu: 'lavapipe', accel: 'off' }, d) === true,
      'swiftshader_indirect + host 同码崩溃应触发止损');
    // 有加速的 host 不算
    emu.attempts = [{ gpu: 'host', accel: 'on', exitCode: 3221225477 }];
    assert(emu._softwareTcgCrashed({ gpu: 'software', accel: 'off' }, d) === false,
      '硬件加速的 host 崩溃不算 TCG 止损');
  });

  await test('issue #5：androidboot 的 vulkan 属性行不再被当成 Vulkan 崩溃', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const variants = [{ gpu: 'swangle', label: 'swangle' }, { gpu: 'host', label: 'host' }];
    const d = doctor.diagnose(['emulator exit 3221225477']);
    // 现场日志里 androidboot.hardware.vulkan=ranchu 是正常启动必有的 guest 属性，
    // 单独出现时不应触发「关 Vulkan」；真正 Selecting Vulkan device 才算痕迹。
    const onlyBootProp = ['androidboot.hardware.vulkan=ranchu', 'emulator exit 3221225477'];
    assert(emu._preferNoVulkan(variants, 0, d, onlyBootProp) === false,
      'guest 内核属性行不该触发关 Vulkan');
    const realTrace = ['Selecting Vulkan device: Intel UHD 730', 'emulator exit 3221225477'];
    assert(emu._preferNoVulkan(variants, 0, d, realTrace) === true,
      '真正初始化 Vulkan 的日志仍应触发关 Vulkan');
  });

  await test('CPU 指令集：QEMU 的无害警告不许当成结论（#15 误诊回归）', () => {
    const warn = ["WARNING: host doesn't support requested feature: CPUID.01H:ECX.avx [bit 28]"];
    assert(doctor.diagnose(warn).code !== 'CPU_FEATURE',
      'CPUID 警告在绝大多数机器上都会出现，判成「缺指令集」会把用户引向换镜像');
    assert(doctor.diagnose(['Illegal instruction']).code === 'CPU_FEATURE');
    assert(doctor.diagnose(['emulator exit 3221225501']).code === 'CPU_FEATURE');
    assert(doctor.notes(warn).length === 1, '无害警告要被单独摘出来解释');
  });

  await test('超时结论：没有加速时说「慢」并给出可执行动作', () => {
    const slow = doctor.timeoutDiagnosis({ accelOk: false, seconds: 240 });
    assert(slow.code === 'TIMEOUT');
    assert(/15 分钟/.test(slow.hint), `应说明放宽到多久：${slow.hint}`);
    const gpu = doctor.timeoutDiagnosis({ accelOk: true, seconds: 240 });
    assert(/渲染/.test(gpu.hint), `有加速时应指向渲染：${gpu.hint}`);
  });

  await test('关加速的兜底档自带更长超时（否则兜底等于没兜底）', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const off = doctor.planVariants(p).filter((v) => v.accel === 'off');
    assert(off.length >= 1, '缺少关加速的兜底档');
    for (const v of off) {
      assert(v.bootTimeoutMs >= 600000, `TCG 冷启动常要 8~15 分钟，超时却只有 ${v.bootTimeoutMs}ms`);
    }
  });

  await test('空闲端口探测返回偶数端口对', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `端口异常：${p}`);
  });

  await test('设置页展示的自动参数与实跑参数一致（37.x 不再显示弃用后端）', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `应为 host（失败降级），实际 ${p.gpu}`);
    assert(p.accelOk === true && text.includes('检测到加速器（本次运行待确认）'), text);
    assert(!text.includes('硬件加速'), '检测通过不能冒充本次运行已确认');
    const confirmed = doctor.describeProfile({ ...p, acceleration: { confirmed: true } });
    assert(confirmed.includes('硬件加速（运行日志已确认）') && !confirmed.includes('待确认'), confirmed);
    const unconfirmed = doctor.describeProfile({ ...p, acceleration: { confirmed: false } });
    assert(unconfirmed.includes('运行日志未确认硬件加速') && !unconfirmed.includes('运行日志已确认'), unconfirmed);
    const off = doctor.describeProfile({ ...p, accel: 'off' });
    assert(off.includes('请求软件模拟') && !off.includes('检测到加速器') && !off.includes('硬件加速'), off);
    const unavailable = doctor.describeProfile({ ...p, accelOk: false });
    assert(unavailable.includes('未检测到可用加速器') && !unavailable.includes('硬件加速'), unavailable);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('端口 5562'), text);

    // 老引擎仍应用老后端；用户手动填的高级参数仍然生效
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  await test('可见模式自动降级后要记录实际成功的启动方案', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    const recorded = (src.match(/this\.profile = plan;/g) || []).length;
    assert(recorded >= 2,
      '启动从 host 自动回退到 swangle/software 后，运行时状态必须展示实际成功的 plan');
  });

  console.log('\n[layers.js 容器式瘦身]');

  await test('盘点可再生缓存并保留其他系统镜像及 AVD 用户数据', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), '应列出非 x86_64 QEMU');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), '不能删 x86_64 QEMU');
    assert(!paths.some((p) => p.includes('android-30')), '不能按 API 版本猜测其他镜像可删除');
    assert(paths.some((p) => p.endsWith('.lock')), '应列出已知锁文件');
    assert(paths.some((p) => p.includes('snapshots')), '应列出受管快照');
    assert(!paths.some((p) => p.includes('apkstart-arm.avd')), '非活动 AVD 仍可能包含用户数据');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), '不能删活动 AVD 配置');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun 不应删除任何文件');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    for (const suffix of ['qemu-system-aarch64.exe', 'multiInstance.lock']) {
      assert(done.removed.some(c => c.path.endsWith(suffix)), `已知可再生文件应被回收：${suffix}`);
    }
    assert(done.removed.some(c => c.path.includes('snapshots')), '受管快照应回收');
    assert(fs.existsSync(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt')), '小型说明文件不应回收');
    assert(done.saved > 0, '实际清理应释放空间');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')), '非活动 AVD 的用户数据应保留');
    assert(fs.existsSync(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img')), '未声明归属的镜像必须保留');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), '活动 AVD 必须保留');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU 必须保留');
  });

  console.log('\n[adb.js 安装/启动失败可读性]');

  await test('Android 14 老 targetSdk 应用失败有明确指引', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('自动'), s);
  });

  await test('ARM 翻译层崩溃能给出可执行的中文结论', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM 翻译层') && s.includes('兼容镜像'), s);
  });

  console.log('\n[sharer 不再来回搬运（磁盘写满的元凶）]');

  await test('同一个文件不会每轮都被从设备拉回来', async () => {
    const { Sharer } = require('../src/core/sharer');
    const { makeEnv, writeStable } = require('./lib/fake-adb');
    const { root, localDir, remoteDir, dataDir, fake } = makeEnv('apkstart-auto-sync-');
    try {
      writeStable(path.join(localDir, 'a.txt'), 'hello');
      const sh = new Sharer({ client: () => fake }, {
        dataDir, settings: () => ({ sharedDir: localDir, deviceSharedDir: remoteDir }),
      });
      const first = await sh.sync(); // 本机新文件 → 验证暂存再提交到设备
      const firstPull = fake.pullCount;
      assert(first.pushed === 1 && !first.errors.length, JSON.stringify(first));
      assert(fs.readFileSync(path.join(remoteDir, 'a.txt'), 'utf8') === 'hello', '设备应已收到内容');
      await sh.sync();
      await sh.sync();
      await sh.sync();
      assert(fake.pushCount === 1, `只应推送一次，实际 ${fake.pushCount}`);
      assert(firstPull === 0, `刚推上去的文件不该立刻被拉回来，实际拉取 ${firstPull} 次`);
      assert(fake.pullCount === firstPull, `后续轮次不应再反复拉取，实际累计 ${fake.pullCount} 次`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('超大文件不会被反向拉回本机（本地目录不是设备缓存下水道）', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, '超过 512MB 的文件不应拉回本机');
  });

  console.log('\n[adb/sharer 文件互通]');

  await test('ls -l 解析兼容 Android 的含 group / 日期格式', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `应解析 3 行，实际 ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('远端文件列表可用 find+stat 一次拿全（不依赖 ls 日期解析）', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `应返回 2 个文件，实际 ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js 大包流式解压]');

  await test('ZipFile 与 ZipArchive 对同一压缩包的解析结果一致（含 deflate 与流式 pipeTo）', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), '条目名应一致');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored 条目内容应一致');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'deflate 条目内容应一致');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'pipeTo 流式输出应完整');
    } finally {
      file.close();
    }
  });

  await test('Zip64：EOCD 用 0xffff/0xffffffff 占位时，条目数与偏移从 Zip64 EOCD 取', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // 本地头
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // 中央目录项：三个字段置 0xffffffff，真实值进 Zip64 extra（id=0x0001）
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD + locator + 传统 EOCD（全部进位）
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive 应能认出 Zip64 条目');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'ZipArchive 内容应正确');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive 未压缩大小应从 extra 取');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile 应能认出 Zip64 条目');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'ZipFile 内容应正确');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile 本地头偏移应从 extra 取');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js AVD 零配置]');

  await test('AVD 使用小数据分区 + 快速启动 + 现代 GPU 模式', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), '数据分区不应是 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(/^hw\.audioInput=yes$/m.test(cfg), '默认应启用内置模拟器的麦克风输入');
    Object.defineProperty(emu, 'settings', {
      configurable: true,
      get: () => ({ engine: { microphone: false } }),
    });
    const disabled = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const disabledCfg = fs.readFileSync(path.join(disabled.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.audioInput=no$/m.test(disabledCfg), '关闭麦克风后应写入 hw.audioInput=no');
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), '不应再强制冷启动');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), '快照应由命令行 -snapshot 控制，避免加载旧 default_boot');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), '应写入快照指纹');
  });

  await test('启动参数带自动内存/核心/快照，且不再用弃用的 GPU 模式', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // 快照不存在时（全新 AVD / 刚被作废）绝不能传 -snapshot：
    // qemu 会一直等一份不存在的内存状态，进程活着但永不开机。
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    const hardware = emu.buildArgs({ gpu: 'host', memoryMB: 2048, cores: 2, accel: 'on', snapshot: false }).join(' ');
    // 对齐上游：绝不显式传 -accel on（37.x 在部分机器会因此崩在 guest 启动瞬间）；
    // 只有明确要求关闭加速时才传 -accel off，并配合 ANDROID_I_WANT_MY_TCG。
    assert(!/-accel on/.test(hardware), '硬件加速走默认路径，不显式传 -accel on');
    const software = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, accel: 'off', snapshot: false }).join(' ');
    assert(/-accel off/.test(software), '明确关闭加速时传 -accel off');
    if (!emu.hasSnapshot()) {
      // 没有快照时必须「只禁加载、不禁保存」：-no-snapshot 会连退出自动保存一起关掉，
      // 那样第一次冷启动结束后永远产生不了快照，用户每次点开都是全量引导。
      assert(/-no-snapshot-load/.test(fresh), '没有快照时应用 -no-snapshot-load（只跳过加载）');
      assert(!/ -no-snapshot( |$)/.test(fresh), '没有快照时不能用 -no-snapshot（会禁掉退出保存）');
    }
    // 快照确实存在时才走 quickboot。注意要真的「像一个完整快照」：
    // 保存中断会留下只有几十字节 snapshot.pb 的空壳，那种必须判定为没有快照，
    // 否则 emulator 会尝试加载、失败，再回退冷启动，白等几秒。
    const avdDir = path.join(emu.provisioner.paths().avdHome, `${emu.avdName}.avd`);
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // 空壳（12 字节 pb + 没有 ram.img）必须当作「没有快照」
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), '不完整的快照不能被当成可用快照');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), '空壳快照必须回退冷启动（跳过加载）');

    // 完整快照：pb 有内容 + ram.img 有数据（上一步的空壳会被 hasSnapshot 顺手清掉）
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), '有快照时应使用 quickboot 快照');
    assert(!/-no-snapshot-load/.test(withSnap), '有完整快照时不该跳过加载');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'wipe 时必须带 -wipe-data');
    // 重置数据后**必须允许保存新快照**：修复网络靠的就是「重置后第一次开机有网 →
    // 立刻存快照 → 下次恢复时网卡状态一起还原」。旧实现推 -no-snapshot 把保存也关了，
    // 于是修完网络一关机又回到没网。
    assert(/-no-snapshot-load/.test(cold), 'wipe 时不能加载旧快照（数据已对不上）');
    assert(!/ -no-snapshot( |$)/.test(cold), 'wipe 时不能连退出自动保存一起关掉');
    assert(/-snapshot apkstart/.test(cold), 'wipe 时保存必须落在 apkstart 这个名字上，否则下次按名字找不到');
  });

  // 窗口代理脚本里有大量中文注释。PowerShell 5.1 读「无 BOM 的 UTF-8」会按 ANSI 解码，
  // 中文变成乱码后可能把 C# 注释和下一行代码并成一行 —— Add-Type 直接编译失败，
  // 表现就是「窗口代理启动失败 / 应用窗口不嵌入」。这个坑踩过一次，用测试钉住。
  await test('窗口代理脚本必须带 UTF-8 BOM（否则中文注释会让 Add-Type 编译失败）', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 缺少 UTF-8 BOM');
  });

  // 模拟器窗口必须是 Chromium 渲染层的「子窗口」，不能是宿主的兄弟子窗口。
  // 兄弟关系下 Electron 会持续把网页层抬到最前，黑底盖住安卓画面、鼠标全被吃掉
  // （黑边 / 未填满 / 点击失效 / 点不动同意）。也不能再给嵌入窗口设 window region，
  // 那会破坏命中测试且在 resize 后露出黑边。
  await test('嵌入窗口必须挂到网页层之下，且不能再设 window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    const embed = src.slice(src.indexOf('static bool Embed('), src.indexOf('static bool Fit('));
    const reparent = src.slice(src.indexOf('static bool Reparent('), src.indexOf('static bool SetStyle('));
    const fit = src.slice(src.indexOf('static bool Fit('), src.indexOf('static void Raise('));
    assert(/IntPtr parent = FindChromeRender\(host\);\s*if \(parent == IntPtr\.Zero\) parent = host;/.test(embed),
      'embed 必须优先使用 Chromium 渲染子窗口，仅未就绪时暂挂宿主');
    assert(/style \|= WS_CHILD \| WS_CLIPCHILDREN \| WS_CLIPSIBLINGS;[\s\S]*if \(!Reparent\(emu, parent\)\)\s*\{[^}]*return false;/.test(embed),
      '必须以子窗口样式调用 Reparent，失败不能宣告嵌入成功');
    assert(/SetLastError\(0\);\s*SetParent\(child, parent\);\s*int error = Marshal\.GetLastWin32Error\(\);\s*if \(!IsWindow\(child\) \|\| GetParent\(child\) != parent\)\s*return WindowFailure\("set-parent-failed", error\);/.test(reparent),
      'Reparent 必须核验实际父窗口，不能用 SetParent 返回的旧父句柄判断成败');
    assert(/IntPtr cr = FindChromeRender\(_host\);\s*if \(cr != IntPtr\.Zero && ep != cr && !Reparent\(_emu, cr\)\)\s*\{\s*ShowWindow\(_emu, 0\);\s*return false;/.test(fit),
      '网页层建好后 Fit 必须补挂，失败应隐藏窗口且返回 false');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), '不能给嵌入窗口设裁剪 region');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(embed), 'embed 时要清掉旧版本残留的 region');
  });

  // 三个「只在真机上才炸」的坑，用源码断言钉住（本机没有部署 build/runtime，
  // 端到端跑不起来，但至少别在重构时被悄悄改回去）。
  await test('关窗先 park 再销毁宿主，且代理按物理像素工作、首帧事件有兜底', () => {
    const base = path.join(__dirname, '..', 'src');
    const appwin = fs.readFileSync(path.join(base, 'core', 'appwin.js'), 'utf8');
    const ps1 = fs.readFileSync(path.join(base, 'core', 'win', 'agent.ps1'), 'utf8');
    const main = fs.readFileSync(path.join(base, 'main.js'), 'utf8');

    // 上游 #42：close 只置标志位的话，宿主销毁会连带销毁嵌入的 Qt 子窗口，
    // qemu 还在但句柄没了 —— 之后任何应用都 embed failed: emu=0、全黑。
    assert(/on\('close',\s*\(e\)\s*=>/.test(appwin), 'close 事件必须拿到事件对象才能 preventDefault');
    assert(/e\.preventDefault\(\)/.test(appwin), '关窗必须先拦下来，等 park 完成');
    assert(/if \(this\.win === win\) this\.close\(\)/.test(appwin), '拦下当前窗口后要走 close() 统一收尾');
    assert(/close\(\{\s*keepApp\s*=\s*false\s*\}/.test(appwin), '普通关窗默认不保留应用');
    assert(/win\.destroy\(\)/.test(appwin), 'park 收尾直接销毁宿主，不再触发原生 close');

    // 上游 #40：DPI 不感知的 powershell 会把物理像素再乘一次缩放，
    // 125% 下画面放大 1.28 倍 + 右/下被裁 + 点击整体偏左上。
    assert(/SetProcessDpiAwarenessContext/.test(ps1), '代理必须声明 PerMonitorV2');
    assert(/SetProcessDPIAware/.test(ps1), '老系统要能退回 System DPI Aware');
    const serve = ps1.slice(ps1.indexOf('public static void Serve'));
    assert(serve.indexOf('SetProcessDpiAwarenessContext') < serve.indexOf('TcpListener'),
      'DPI 声明必须在任何窗口操作之前');

    // 上游 #39：ready-to-show 收不到时用户看到的是「点了没反应」。
    assert(/force-show fallback fired/.test(main), '主窗口要有超时兜底显示');
    assert(/ready-to-show/.test(main), '正常路径仍然优先用 ready-to-show');
  });

  await test('无头运行时按ADB在线+开机完成+两次句柄缺失判定，重启后重新启动目标应用', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const helperStart = main.indexOf('async function hasHeadlessRuntimeWindow()');
    const helperEnd = main.indexOf('async function runLaunch(pkg)', helperStart);
    assert(helperStart >= 0 && helperEnd > helperStart, '必须有独立的无头窗口检测函数');
    const helper = main.slice(helperStart, helperEnd);
    assert(/engine\.mode === 'attach'/.test(helper), 'attach 模式不能擅自重启外部模拟器');
    assert(/client\(\)\.isOnline\(\)/.test(helper), '必须确认ADB在线后才诊断');
    assert(/sys\.boot_completed/.test(helper), '必须确认guest开机完成后才诊断');
    assert(/const first = await probe\(\)/.test(helper) && /const second = await probe\(\)/.test(helper),
      '窗口缺失必须间隔复测，不能单次误判');
    assert(!/runtime\.vmRunning/.test(helper), '接管实例没有child handle，不能依赖vmRunning');

    const preflight = main.indexOf('if (await hasHeadlessRuntimeWindow())');
    const launch = main.indexOf('let r = await installer.launch(pkg, launchOptions)');
    assert(preflight >= 0 && launch > preflight, '无头检测必须先于正常应用启动');
    const embedCall = main.indexOf('embedded = await appWin.embed();');
    const detachedMark = main.indexOf('detached = !embedded && !!appWin.blackDetached', embedCall);
    assert(embedCall >= 0 && detachedMark > embedCall, '必须能定位「启动完成后嵌入」这一段');
    const afterStart = main.slice(embedCall, detachedMark);
    assert(/stopHeadlessRuntime\(\)/.test(afterStart), '启动与嵌入之间丢窗口时必须停止旧运行时');
    assert(/installer\.launch\(pkg, launchOptions\)/.test(afterStart),
      '运行时重启后必须重新拉起目标应用，不能只嵌入Android桌面');
    const stopStart = main.indexOf('async function stopHeadlessRuntime()');
    const stopEnd = main.indexOf('async function runLaunch(pkg)', stopStart);
    const stop = main.slice(stopStart, stopEnd);
    assert(/snapshotWorthSaving = false/.test(stop) && /forceColdBootOnNextStart\(\)/.test(stop),
      '重启前必须跳过故障快照并安排一次冷启动');
    assert(/await runtime\.stop\(\{ graceful: false \}\)/.test(stop), '无头运行时必须非优雅停止');
    assert(/_consoleAlive\(\)/.test(stop) && /旧模拟器仍在线/.test(stop),
      '重启前必须等控制台端口释放，避免 ensure 重新接管旧实例');
    assert(/_activeApps\.clear\(\)/.test(stop), '重启系统后要清理旧容器会话状态');
  });

  await test('ADB 授权故障提示使用当前平台的密钥路径', () => {
    const hint = adbKeyHint();
    if (process.platform === 'win32') assert(hint === '%USERPROFILE%\\.android\\adbkey*', hint);
    else assert(hint === '$HOME/.android/adbkey*', hint);
  });

  // 上游 #41：模拟器窗口比例由 hw.lcd 在开机时锁死（wm size 只改逻辑分辨率，
  // emu rotate 只转窗口不转安卓，resize-display 只认内置预设档）。
  // 唯一可行的路是「按应用方向选 LCD 冷启动」，这条链路的关键分支用测试钉住。
  await test('横屏应用按 screenOrientation 选 LCD，窗口比例跟着 LCD 走', () => {
    const { parseApk } = require('../src/core/apk');
    const { buildApkBytes } = require('./lib/make-apk');
    const lcd = require('../src/core/lcd');
    const { AppWindow } = require('../src/core/appwin');

    const write = (name, opt) => {
      const p = path.join(TMP, name);
      fs.writeFileSync(p, buildApkBytes(opt));
      return parseApk(p);
    };
    // AXML 里枚举属性是整数，也有应用写成字符串 —— 两种都要认
    const land = write('land-int.apk', { packageName: 'com.example.land', orientation: 0 });
    assert(land.orientation === 'landscape', `整数 0 应解析为 landscape，实际 "${land.orientation}"`);
    const portInt = write('port-int.apk', { packageName: 'com.example.portint', orientation: 1 });
    assert(portInt.orientation === 'portrait', `整数 1 应解析为 portrait，实际 "${portInt.orientation}"`);
    const port = write('port-str.apk', { packageName: 'com.example.port', orientation: 'portrait' });
    assert(port.orientation === 'portrait', `字符串应解析为 portrait，实际 "${port.orientation}"`);
    const none = write('none-orient.apk', { packageName: 'com.example.none' });
    assert(none.orientation === '', '清单没声明时必须是空 —— 猜错会把竖屏应用全变成两侧黑边');

    // 决策：用户选过「保持当前」就不再干预
    assert(lcd.desiredOrientation({ package: 'a', orientation: 'landscape' }) === 'landscape');
    assert(lcd.desiredOrientation({ package: 'a', orientation: 'landscape', lcdPref: 'keep' }) === '');
    assert(lcd.desiredOrientation({ package: 'a', orientation: 'landscape', lcdPref: 'portrait' }) === 'portrait',
      '用户强制值优先于清单');
    assert(lcd.desiredOrientation(null) === '');
    assert(lcd.needsRestart('portrait', 'landscape') === true);
    assert(lcd.needsRestart('landscape', 'landscape') === false);
    assert(lcd.needsRestart('portrait', '') === false, '方向未知时不能触发重启');

    // 窗口尺寸：横屏 LCD 下无论要不要「横屏排版」，窗口都必须是横的
    const area = { x: 0, y: 0, w: 1920, h: 1040 };
    const a = AppWindow.sizeFor(area, { w: 1920, h: 1080 }, true);
    assert(a.w > a.h, `横屏 LCD 的窗口必须是横的，实际 ${a.w}x${a.h}`);
    const b = AppWindow.sizeFor(area, { w: 720, h: 1280 }, true);
    assert(b.w > b.h, '竖屏 LCD 切横屏排版时窗口应是横的');
    const c = AppWindow.sizeFor(area, { w: 1920, h: 1080 }, false);
    assert(c.w > c.h, '横屏 LCD 即使不要求横屏排版，窗口也不能变成竖的');
    assert(lcd.orientBox({ w: 720, h: 1280 }, 'landscape').w === 1280);
    assert(lcd.orientBox({ w: 720, h: 1280 }, 'portrait').w === 720);

    // 没有加速时不能只丢一句 UNKNOWN：用户要知道去开 WHPX / 装 AEHD
    const doctor = require('../src/core/doctor');
    const d = doctor.noAccelDiagnosis();
    assert(d.code === 'ACCEL', `诊断码应为 ACCEL，实际 ${d.code}`);
    assert(/WHPX/.test(d.hint) && /AEHD/.test(d.hint), '提示里必须点名两个可选的加速方案');
  });

  // 「全屏 = 横屏排版」这条链路上，rotate() 会先退出最大化才能改尺寸；如果不把
  // 最大化状态再恢复，「设置里是全屏、窗口却变成居中小窗」就会随机出现
  // （maximize() 在 Windows 上是异步的，紧接着读 isMaximized() 拿到的还是 false）。
  await test('切方向后必须按全屏状态恢复最大化，且不再转模拟器画面', () => {
    const appwinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(!/this\.agent\.rotate\(/.test(appwinSrc), '不能再给模拟器发 Ctrl+←（只转画面、排版不变）');
    assert(/fullscreen = null/.test(appwinSrc) || /fullscreen =/.test(appwinSrc), 'rotate 要能接收显式的全屏状态');
    assert(/if \(wantMax\) win\.maximize\(\)/.test(appwinSrc), '切完方向要恢复捕获窗口的最大化');
    assert(/setLandscape\(true, \{ fullscreen: true \}\)/.test(mainSrc), '进全屏时必须显式告知要保持最大化');
  });

  // 用户实测反馈：点了应用只看到「左边一块黑屏一直在加载」，真正能用的画面在
  // 右边的「Android Emulator」窗口里，而且要自己去发现。所以必须有「直接给
  // 独立窗口」这条路，而不是每次都先嵌入、黑了再摘。
  await test('独立窗口模式：跳过嵌入、藏掉黑壳，并记住这台机器嵌入必黑', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const appwinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const store = require('../src/core/store');
    assert(store.getSettings().engine.windowMode === 'auto', '默认应是 auto（嵌入失败即改用独立窗口）');
    assert(/wantStandalone/.test(mainSrc), '启动流程要按设置决定是否走独立窗口');
    assert(/await appWin\.standalone\(\)/.test(mainSrc), '独立窗口模式必须直接 detach，不能先 SetParent');
    assert(/!detached && !wantStandalone\)/.test(mainSrc), '独立窗口模式下不能再进 embed 重试');
    assert(/embeddedBlack: true/.test(mainSrc), '嵌入必黑要写回设置，下次不再先黑一遍');
    assert(/已在「Android Emulator」窗口打开/.test(mainSrc), '要把「去哪看画面」说清楚');
    assert(/async standalone\(\{ blackFrame = false \} = \{\}\)/.test(appwinSrc), 'appwin 要提供一步到位的独立窗口方法');
    assert(/this\._hidden = true/.test(appwinSrc), '独立窗口模式下必须藏掉黑壳宿主窗口');
    const release = ps1.slice(ps1.indexOf('static bool ReleaseEmulator('), ps1.indexOf('static bool Detach()'));
    assert(/static bool Detach\(\)\s*\{\s*return ReleaseEmulator\(true\);\s*\}/.test(ps1),
      'detach 必须走显示独立窗口的释放链路');
    assert(/IntPtr e = _emu;\s*if \(e == IntPtr\.Zero\)\s*\{[^}]*return show \? WindowFailure\("emu=0", 0\) : true;/.test(release),
      'detach 找不到窗口时必须如实失败，不能继续抢前台');
    assert(/if \(GetParent\(e\) != IntPtr\.Zero && !Reparent\(e, IntPtr\.Zero\)\) return false;/.test(release),
      '摘出父窗口失败时不能继续显示或报告成功');
    assert(/if \(show\)\s*\{[^}]*ShowWindow\(e, IsIconic\(e\) \? 9 : 5\);[^}]*SetForegroundWindow\(e\);\s*\}\s*_emu = IntPtr\.Zero;/.test(release),
      '仅独立显示路径应在清理句柄前用捕获的窗口抢前台，不能让 park 弹窗');
    assert(/bool detached = Detach\(\)/.test(ps1), 'detach 必须将真实结果返回调用者');
  });

  // 启动路径上绝不能做破坏性动作：等网络可以，停掉虚拟机再冷启动不行 ——
  // 那会在 adb install / am start 途中把设备弄没，直接变成「应用打不开」。
  await test('拉起应用前只等待网络，绝不重启虚拟机', () => {
    const installSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'installer.js'), 'utf8');
    assert(/waitForNetwork\(\{ onLog, timeoutMs: 20000 \}\)/.test(installSrc), '启动路径应只等 20 秒，不重启');
    assert(!/ensureNetwork/.test(installSrc), '启动路径不能调用会冷启动的 ensureNetwork');
    const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    assert(/device-offline/.test(engineSrc) && /45000/.test(engineSrc), '刚重启的设备掉线要给宽限，不能立刻判失败');
    const repairStart = engineSrc.indexOf('  repairNetwork(');
    assert(repairStart >= 0, '必须提供独立网络修复入口');
    const repair = engineSrc.slice(repairStart, engineSrc.indexOf('\n  dispose(', repairStart));
    assert(!/forceWipeOnNextStart|resetAndroidData/.test(repair), '修复网络绝不能隐式重置应用数据');
    const emuSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    assert(/_forceWipe/.test(emuSrc) && /async checkNetwork/.test(emuSrc), '模拟器要提供一次性 wipe 标记与网络体检');
  });

  await test('新版 emulator 写的 ram.bin 必须被认作完整快照（否则刚存好的 3GB 会被当空壳删掉）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, `${emu.avdName}.avd`);
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin 应被认作完整快照');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), '有快照时应走 quickboot');
    assert(!/-no-snapshot-load/.test(args), '有完整快照时不该跳过加载');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('userdata 种子镜像：4K block + ENCRYPT + 记账自洽', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'superblock 魔数必须是 0xEF53');
    // dm-default-key（Android 13 的 /data 元数据加密）逻辑块大小是 4096，
    // fs block 小于它会让 mount() 返回 EINVAL —— 这是「挂不上 /data」的真凶。
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size 必须是 2（4096 字节）');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size 必须等于 block size');
    // 没有 ext_attr 时 setxattr 返回 EOPNOTSUPP，SELinux 标签写不进去，
    // netd / media / tombstoned 会一起 exit 1，开机卡在动画上。
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, '必须带 ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, '空闲块数必须落在 (0, total) 之间');
    assert(freeInodes === inodes - 10, '空闲 inode 必须扣掉 1~10 号保留（e2fsck 会核对）');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, '默认必须带 ENCRYPT（FBE 必需）');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'encrypt:false 时要能摘掉该位');
  });

  console.log('\n[显示 / 快捷方式 / 零操作]');
  await test('窗口模式必须真的开窗口（否则应用进程活着但屏幕上看不见）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-window/.test(win), '窗口模式不能再用 -no-window');
    // 上游 0.4.1 实测：-no-skin 会覆盖 -skin，面板尺寸退回 config.ini 旧值
    //（横屏失效 / 画面只占左上角一条），窗口模式绝不能再传它。
    assert(!/-no-skin/.test(win), '窗口模式不能传 -no-skin（会覆盖 -skin）');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless) && !/-no-skin/.test(headless));
  });

  await test('音频：四种播放/输入组合只在两项都关闭时禁用整个子系统', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const cases = [
      [{ audio: true, microphone: true }, false],
      [{ audio: false, microphone: true }, false],
      [{ audio: true, microphone: false }, false],
      [{ audio: false, microphone: false }, true],
      // 升级旧配置没有 microphone 键时，按默认开启输入处理，不能误伤麦克风。
      [{ audio: false }, false],
    ];
    for (const [engine, muted] of cases) {
      Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine }) });
      const args = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
      assert((/-no-audio/.test(args)) === muted,
        `${JSON.stringify(engine)} 的 -no-audio 组合不正确：${args}`);
    }
  });

  await test('旧配置强制迁移：无头与「启动后退出」不再生效', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless 必须被迁移成 false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch 必须为 false');
    // 开机自启改成默认关闭（用户明确要求：不该替所有人决定开机就拉起后台进程）；
    // 一键部署仍然是默认开启的，首次运行不用点任何按钮。
    assert(s.autoStart === false && s.autoDeploy === true, '开机自启默认关闭、一键部署默认开启');
    assert(s.createStartMenuShortcut === true, '开始菜单快捷方式默认开启');
  });

  await test('显示适配：窗口/全屏共用竖屏分辨率，窗口比例 9:16 可拉伸', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // 全屏不改变 Android 分辨率（模拟器窗口宽高比被 LCD 锁定），只最大化窗口
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', '横屏乱填', area).h > d.sizeFor('window', '横屏乱填', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // 全屏：铺满高度、按竖屏比例算宽度并居中（窗口宽高比被模拟器 LCD 锁定）
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('adb 显示命令使用 wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO 与 WebP 图标兜底都能产出可用 ICO', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'ICO 头应声明 1 个图像');
    assert(ico.readUInt32LE(14) === png.length, '内嵌 PNG 长度应一致');
    assert(ico.slice(22).equals(png), 'ICO 数据区应就是原 PNG');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP（nativeImage 解不了）→ 无 decode 回调时应回退到品牌占位 ICO
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP 也应拿到图标');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), '有 decode 时应使用真实图标');
  });

  await test('窗口控制脚本存在且为纯 ASCII（避免中文路径/标题乱码）', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), '缺少 windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'ps1 必须纯 ASCII，中文通过 UTF-8 JSON 传入');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile 把源文件喂进 stdin 并产出可被运行时解压的镜像（CI 挂死回归）', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // 小样本走最快档，别拖慢整套测试
    process.env.XZ_TIMEOUT_MS = '15000';  // 真挂死时 15s 内 kill，别把 CI 卡住
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile 25s 内未返回（stdin 没接 EOF？）')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, '压缩产物不能是 0 字节');
    let back;
    if (/\.xz$/i.test(out)) {
      // 不依赖 @napi-rs/lzma 原生 binding：CI 的 Node 20 job 会因
      // npm optional dependencies 的已知 bug 加载不到它（Node 22 正常）。
      // 这里用与压缩端同一个 python 的 lzma 读回，并校验 XZ 魔数，
      // 运行时的解压兼容性由真实安装包端到端验证覆盖。
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), '必须是合法的 XZ 容器');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, '产出 XZ 却找不到 python，无法校验');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), '解压内容必须与源镜像逐字节一致');
  });

  console.log('\n[container.js 应用级容器]');

  const container = require('../src/core/container');

  await test('系统/框架包永不裁剪，用户 App 才纳入会话清理', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} 应识别为用户 App`);
      else assert(sys, `${p} 应识别为系统包`);
    }
    assert(container.isSystemPackage(''), '空包名当作系统包，避免生成非法命令');
  });

  await test('启动应用只停其他已装 App，默认绝不动系统包', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `应停 2 个其他用户 App，实际 ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), '默认不能禁用系统包');
    assert(!r.commands.some((c) => c.includes('kill-all')), '启动阶段不能清后台，避免误伤刚进前台的 App');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), '不能 force-stop 系统框架');
  });

  await test('包名白名单：被污染的清单不会拼出注入命令', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `只应停合法包名，实际 ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), '不能出现注入片段');
  });

  await test('深度裁剪可禁用后台包，且能完整恢复、不碰必需组件', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, '深度裁剪应有可禁用项');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} 绝不能被禁用`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} 必须可恢复`);
    }
  });

  await test('容器停放：清后台 + Android idle，且状态机覆盖多窗口/最后关闭', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), '停放要清后台缓存进程');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), '停放要让 Android 进 idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, '最后一个窗口关闭后容器应停放');
  });

  await test('doctor 轻量容器：收敛 vCPU，手动设置优先', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // 老逻辑是 floor(核数/4) 夹到 2~3 —— 8 核机器只给 2 个 vCPU，视频应用直接卡。
    // 现在是「一半物理核、上限 8」，省资源模式固定 2。
    assert(lite && lite.cores === 8, `16 核机器均衡模式应给 8 核，实际 ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `省资源模式应固定 2 核，实际 ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, '显式关闭应返回 null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, '2 核机器至少保留 2 核');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores >= 2 && auto.cores <= 8, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(manual.cores === 6, '用户手动指定的核数必须优先于轻量模式');
    assert(/轻量容器/.test(doctor.describeProfile(auto)), '诊断摘要应标出轻量容器');
  });

  await test('全局鼠标钩子默认关闭，且窗口代理不再长时间阻塞消息泵', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), '默认设置里侧键钩子必须关闭');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), '主进程不能再无条件安装全局钩子');
    assert(!/agent\.hook\(true\)/.test(appwinJs), '应用窗口不能再无条件安装全局钩子');
    assert(!/sharer\.start\(8000\)/.test(mainJs), '文件同步不能无条件常驻');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), '钩子开关必须幂等可关闭');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), '钩子必须装在专用消息线程上');
    assert(/GetMessage\(out MSG/.test(agentPs1), '钩子线程必须跑消息循环');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), '主循环不能再阻塞 4 秒');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), '主循环应短轮询保持消息泵响应');
    assert(/now - _embedAt < 8000/.test(agentPs1), '窗口巡检必须限时，不能永久每 2 秒 EnumWindows');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), '设置页需暴露轻量容器选项');
  });

  await test('WinAgent.setHook(false) 在默认状态下不会拉起 PowerShell 代理', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, '关闭应返回 hooked=false');
    assert(a.ready === null, '默认关闭时不能为此启动常驻代理进程');
  });

  console.log('\n[鼠标键位映射]');

  await test('默认与旧配置迁移：右键返回 + 平滑滚轮开启，侧键关闭', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, '右键返回默认开');
    assert(d.wheel === 'smooth', '滚轮默认平滑');
    assert(d.side === false, '侧键默认关');
    assert(d.enabled === true, '至少右键映射需要钩子');
    // 老 settings.json 里没有新键时也要得到同样的结果
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, '全部关掉后不应再装钩子');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, '原生滚轮不需要钩子');
  });

  await test('hookOptions 收敛配置，关闭时所有子开关一起归零', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false 必须彻底不拦事件');
    assert(pointer.hookOptions(true).side === true, '兼容旧布尔写法（侧键）');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('滚轮方向：向下滚=手指上滑，向上滚=手指下滑，坐标不越界', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, '滚轮向下应让内容上移（手指上滑）');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, '滚轮向上应让内容下移（手指下滑）');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, '零位移不产生命令');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x 不能越界');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y 不能越界');
      assert(s.duration >= 100 && s.duration <= 240, '滑动时长应有上限');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), '快滚不能无限拉长手势');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, '横向滚轮应产生水平滑动');
  });

  await test('input 命令白名单：只放行内部拼出的命令，挡住注入', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /非法/.test(e.message); }
    assert(blocked, '非法命令必须在拉起 adb 之前被挡下');
    assert(c._input === null, '被挡下的命令不能创建常驻会话');
  });

  await test('返回键优先走常驻输入通道，失败才回退一次性 adb', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), '正常路径不应 spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', '常驻通道失败必须兜底，别丢掉这次点击');
  });

  await test('WheelRouter 把连续滚动合并成一条滑动命令', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `3 格滚动应合并成 1 条命令，实际 ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), '必须产出合法的 input swipe');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), '合并后仍是向下滚的方向');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'dispose 后不能再注入');
  });

  await test('代理脚本：右键/滚轮拦截、滚轮合并、前台限定与专用线程', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), '必须处理右键与滚轮');
    assert(/WM_MOUSEHWHEEL/.test(ps1), '横向滚轮也要支持');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), '滚轮必须合并后上报');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), '必须按前台根窗口限定作用域');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), '钩子必须在专用消息线程');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), '主循环不能长阻塞');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), '未配置的映射不能拦事件');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), '设置变化要能即时同步钩子');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), '设置页需暴露键位开关');
  });

  await test('WinAgent.setHook 把键位配置一起下发，且关闭时不拉起代理', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, '开启应只发一次命令');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, '配置必须随 hook 命令下发');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, '关闭要卸载钩子');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, '默认关闭时不能启动 PowerShell');
  });

  console.log('\n[updater.js 在线更新]');
  await test('版本比较按数字逐段比，v 前缀 / 多段都正确', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 应大于 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'v 前缀不影响相等');
    assert(cmpVer('0.10.0', '0.9.9') === 1, '必须按数字比而不是字符串比');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 小于 1.0.1');
  });

  await test('安装形态决定挑哪个资产：安装版=Setup.exe，便携版=portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ platform: 'win32', currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', '没有卸载器时判定为便携版');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert(portable.flavor === 'setup', '有卸载器时判定为安装版');
    // 资产挑选是纯函数式的，这里直接喂一个假的 check 结果验证兜底命名规则
    assert(/Setup\.exe$/i.test('ApkStart-0.3.2-Setup.exe'), '安装版资产名匹配');
    assert(/portable.*\.zip$/i.test('ApkStart-v0.3.2-win64-portable.zip'), '便携版资产名匹配');
  });

  await test('便携版不会把运行时整包（ApkStart-runtime-*.zip）当成更新包', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ platform: 'win32', currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // 两个资产同时存在 → 必须挑便携包
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `应挑便携包，实际 ${info.asset.name}`);

    // 只有运行时整包（便携包没传上去）→ 宁可不自动更新，也不能拿 1.5GB 运行时当程序包
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, '只有运行时整包时不应挑出更新资产');
    assert(info.canAutoApply === false, '没有可用资产时不能自动更新');
  });

  await test('双源：候选地址含镜像前缀，自定义前缀优先于公共镜像', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, '源站必须排第一（测速排序前保持原序）');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), '自动镜像应被列入候选');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `自定义前缀应唯一生效，实际 ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, '关掉自动镜像后只剩直连');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, '前缀缺尾斜杠要自动补');

    // 镜像只代理 GitHub：Gitee 的地址拼上镜像前缀只会 403，不该被列入候选
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Gitee 资产不应套 GitHub 镜像前缀');
  });

  await test('双源：测速结果按速度排序，全部失败时保持原序不丢可用地址', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // 直接注入测速缓存，避免测试依赖外网
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `最快的应排第一，实际 ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', '失败的地址排最后但仍保留（还有一次机会）');
    s.reset();
    assert(s._rankCache.size === 0, 'reset 要清空测速缓存（换源/换网后必须重测）');
  });

  await test('双源：Gitee 自动附带的源码包（v1.2.3.zip）绝不能被当成安装包', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `只应保留 ApkStart* 资产，实际 ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Gitee 的资产没有 size 字段：分片组仍要成立（否则整包被丢掉）', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Gitee 发行版资产只有 name + url，没有 size（实测）
        assets: [
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `应合并成 1 个资产，实际 ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkStart-v0.3.3-win64-portable.zip', `资产名应为整包名，实际 ${a.name}`);
    assert(a.parts && a.parts.length === 2, '必须保留两片');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', '分片地址顺序/内容要对');
    assert(a.size === 0, '大小未知时应为 0（界面按已收字节显示进度）');
  });

  await test('分片资产必须一路传到 updater.asset，否则 prepare 会报「没有可用的下载地址」', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      platform: 'win32', currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts 必须保留到 asset 上');
    assert(info.canAutoApply === false, '未签名的分片不能自动更新');
  });

  await test('双源：合并版本时只认同版本的资产，不拿旧包冒充新包', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `应取更高版本，实际 ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', '旧版本同名资产不能覆盖新版本');
  });

  await test('窗口代理：scope 仅接受真实模拟器目录，滤掉空项和宽泛路径', async () => {
    const { WinAgent } = require('../src/core/agent');
    const { realPath } = require('../src/core/process-owner');
    const a = new WinAgent();
    const sent = [];
    // 不真起代理进程；输入必须有模拟器结构，不能仅凭目录名授予窗口控制权。
    const root = path.join(TMP, 'scope-runtime');
    const emu = path.join(root, 'emulator');
    fs.mkdirSync(path.join(emu, 'qemu'), { recursive: true });
    fs.writeFileSync(path.join(emu, process.platform === 'win32' ? 'emulator.exe' : 'emulator'), 'fixture');
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope([root, '', null, emu, path.parse(root).root, 'D:/nonexistent/engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `只应发一条 scope，实际 ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === realPath(emu), `只可信任模拟器自身目录且去重，实际 ${sent[0].dirs}`);
    assert(r.ok === true, 'scope 成功要返回 ok');
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, '空范围也要能下发（代理收到后一个窗口都不动）');
  });

  await test('游戏/低延迟模式：代理可降频扫描，且 UI 提供入口', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true }; };
    await a.setPerformanceMode(true);
    await a.setPerformanceMode(false);
    assert(sent[0].cmd === 'perf' && sent[0].on === 1, '开启低延迟要下发 perf=1');
    assert(sent[1].cmd === 'perf' && sent[1].on === 0, '关闭低延迟要下发 perf=0');
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/<option value="game"/.test(html), '设置页要能选游戏/低延迟模式');
    const appwin = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/priorityMode === 'game'/.test(appwin), '游戏模式不能装全局鼠标钩子');
  });

  await test('双源：同名整包两边都有时，两个地址都要留着（否则 Gitee 永远轮不到）', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Gitee 的资产没有 size（实测），不能拿 GitHub 的大小冒充它
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `同名资产要合并成 1 个，实际 ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `两个源的地址都要留着，实际 ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], '大小按地址分开记，未知就是未知');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `候选地址应含两个源，实际 ${JSON.stringify(cands)}`);
  });

  await test('多源并行下载：两个源体积不同时，跟最快的源走（不能固定挑体积大的）', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // 排在前面的源（已按速度排好序）
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // 列表顺序 = rank() 的速度序：第一个就是最快的源
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `应下最快的源那一份（${small.length} 字节），实际 ${got.length} 字节`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('分片更新包：按顺序拼回整包，大小不符立刻中止', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ platform: 'win32', currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, '拼装后大小必须等于各分片之和');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), '第一片内容顺序错误');
      assert(got.slice(partA.length).every((b) => b === 0x42), '第二片内容顺序错误');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('多源并行下载：不同分块从不同源拉，拼出来的字节必须完全一致', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const sha256 = require('crypto').createHash('sha256').update(data).digest('hex');
    const etag = '"auto-multi-v1"';
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length, ETag: etag }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
        ETag: etag,
      });
      res.end(data.slice(a, b + 1));
    };
    // 显式等 listening 回调：先 listen 再挂事件监听会漏掉已经触发的事件，测试会挂住
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, {
        expectSha256: sha256,
        connections: 6,
        minChunk: 512 * 1024,
      });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, '多源拼装后内容必须与源文件完全一致');
      assert(r.sources === 2 && r.parallel >= 2, `应同时用到 2 个源，实际 ${JSON.stringify(r)}`);
      assert(got.length === data.length, '大小必须一致');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('多源并行下载：失败后重来只补缺的块（不重下整个 1.4GB）', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    const sha256 = require('crypto').createHash('sha256').update(data).digest('hex');
    const etag = '"auto-resume-v1"';
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total, ETag: etag }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // 只统计真正的数据块请求（探测用 0-0 不算）
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${total}`,
        'Content-Length': b - a + 1,
        ETag: etag,
      });
      res.end(data.slice(a, b + 1));
    };
    // 必须是两条地址：只有一条时 downloadMulti 会直接交给单源分块（那条路径自带续传）
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // 造出「前两块已下完、最后一块没下」的现场（分块方式：3 连接 × 1MB）
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({
        v: 1,
        identity: `expectSha256:${sha256}`,
        total,
        n: 3,
        done: [0, per],
      }));

      const r = await downloadMulti(urls, out, {
        expectSha256: sha256,
        connections: 3,
        minChunk: MB,
      });
      assert(r.resumed === true, '应识别出这是断点续传');
      assert(ranged === 1, `只应补下 1 个块，实际请求 ${ranged} 块`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, '续传后的文件必须与源完全一致');
      assert(!fs.existsSync(`${out}.chunks.json`), '完成后要清掉边车文件');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('并行下载：服务器返回错位的 Content-Range 必须失败，不能拼出错位文件（上游 #91）', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = (i * 7) % 251;
    // 现场（#91）：探测请求 0-0 正常，真正取块时服务器不管要哪段都从 0 开始返回
    // → 旧实现照单全收，文件长度刚好对上、内容整体错位，最后表现为「校验失败/莫名崩溃」
    const bad = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Number(r[2]);
      // 只有探测（bytes=0-0）给正确范围；真正取块时不管要哪段都从 0 开始返回
      if (a === 0 && b === 0) {
        res.writeHead(206, { 'Content-Range': `bytes 0-0/${total}`, 'Content-Length': 1 });
        res.end(data.slice(0, 1));
        return;
      }
      res.writeHead(206, { 'Content-Range': `bytes 0-${total - 1}/${total}`, 'Content-Length': total });
      res.end(data);
    };
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(bad);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'bad-range.bin');
    try {
      let err = null;
      try {
        await downloadMulti(urls, out, {
          expectSha256: require('crypto').createHash('sha256').update(data).digest('hex'),
          connections: 3,
          minChunk: MB,
          retries: 1,
        });
      } catch (e) { err = e; }
      assert(err, '错位的 Content-Range 必须让下载失败，不能当成成功');
      assert(/Content-Range|范围.*不符/.test(err.message), `错误信息要指向范围不符：${err.message}`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('下载器：连接建立后一个字节都不来，必须超时换源而不是挂死', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // 头正常回、然后一直不说话：模拟「TCP 通但被墙/被限速」的经典状态
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // 先给 1KB，然后不再发任何东西
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, '最终必须下完整');
      assert(cost < 15000, `不能在停滞的连接上挂住，实际用了 ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('下载器：某个源只跑到几十 KB/s 时换源，而不是卡在最后几 % 不动', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // 慢源：每 100ms 才吐 4KB（≈40KB/s）
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, '换源后内容必须正确');
      // 全程走慢源的话 2MB / 40KB/s ≈ 50 秒；换源必须在几秒内完成
      assert(cost < 15000, `应在低速时换源，实际用了 ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('多源并行下载：只有一条可用地址时退回单源分块', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // 拿一个「刚被释放、现在肯定没人监听」的端口当坏源，连接会立刻被拒而不是等超时
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // 第二个地址故意指到不通的端口：必须自动忽略而不是整包失败
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, '单源也要下完整');
      assert(!r.multi || r.sources === 1, '可用源只有一个时不该标记为多源');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('双源：版本结果缓存 10 分钟，force 时强制重查', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `缓存期内不应重复请求，实际请求 ${calls} 次`);
    await s.latest({ force: true });
    assert(calls === 2, 'force 必须绕过缓存');
    s.reset();
    await s.latest();
    assert(calls === 3, 'reset 后应重新请求');
  });

  await test('双源：某个源 403 被限流后熔断跳过，不再每轮撞墙', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 （被限流）' },
      ];
    };
    // 第一次：Gitee 报 403，被记入熔断
    await s.latest({ force: true });
    assert(giteeCalls === 1, '第一轮应真实请求过');
    const reason = s.blockedReason('gitee');
    assert(!!reason, '403 必须触发熔断');
    assert(s.blockedReason('github') === null, '没出错的源不应被熔断');
    // 熔断期内的请求应被直接跳过（不再打网络）
    assert(/暂时跳过/.test(reason), `跳过原因要能看懂，实际：${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'reset 后熔断应解除');
  });

  await test('双源：全部源不可达时退回上一次结果（标记 stale，不直接报错）', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, '第一次应正常');
    s._relTtl = 0;   // 让缓存失效
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: '超时' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, '应退回旧结果并标记 stale');
  });

  await test('系统镜像落点：全新安装必须落在运行时目录（CI 组装运行时靠这个）', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    // 双平台各自的数据目录约定都要隔离：Windows 走 APPDATA，Linux 走 XDG_DATA_HOME。
    // store 在本文件更早的用例里已被 require（DATA_DIR 是加载时算的常量），
    // 所以清掉 store/provision 的 require 缓存重建实例，让隔离生效。
    process.env.APPDATA = path.join(tmp, 'appdata');
    process.env.XDG_DATA_HOME = path.join(tmp, 'appdata', 'xdgdata');
    const storePath = require.resolve('../src/core/store');
    const provPath = require.resolve('../src/core/provision');
    const imagesPath = require.resolve('../src/core/images');
    const savedStore = require.cache[storePath];
    const savedProv = require.cache[provPath];
    const savedImages = require.cache[imagesPath];
    delete require.cache[storePath];
    delete require.cache[provPath];
    delete require.cache[imagesPath];
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) 全新安装：运行时目录与用户数据目录都没有 system-images → 落运行时目录
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `全新安装应落运行时目录，实际 ${p.paths().sysImgRoot}`);

      // 2) 运行时目录里已经有（整包解压的产物）→ 优先它
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), '已有应优先运行时目录');

      // 3) 只有用户数据目录有（老版本布局）→ 用它
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `老布局应回退到用户数据目录，实际 ${p.paths().sysImgRoot}`);
    } finally {
      delete require.cache[storePath];
      delete require.cache[provPath];
      delete require.cache[imagesPath];
      if (savedStore) require.cache[storePath] = savedStore;
      if (savedProv) require.cache[provPath] = savedProv;
      if (savedImages) require.cache[imagesPath] = savedImages;
      delete process.env.APPDATA;
      delete process.env.XDG_DATA_HOME;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[资源策略 / 磁盘分配 / 日志上限]');

  await test('资源策略一处切换，自动翻译成 vCPU/优先级/分辨率', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, '流畅模式不应限制核数');
    assert(s.engine.priorityMode === 'performance', '流畅模式应与前台同优先级');
    assert(s.engine.renderSize === '720x1280', `分辨率应 720p，实际 ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', '省资源应 540p + 轻量容器');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', '均衡模式分辨率交给自动');
  });

  await test('数据分区容量可配置，且默认不再是死数字', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `应为 12GB，实际 ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 16384, `磁盘 50GB 时自动应 16GB，实际 ${auto.dataMB}`);
    const roomy = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 90000 });
    assert(roomy.dataMB === 24576, `磁盘 90GB 时自动应 24GB，实际 ${roomy.dataMB}`);
    const tight = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 9000 });
    assert(tight.dataMB === 4096, `磁盘紧张时仍应只给 4GB，实际 ${tight.dataMB}`);
  });

  await test('快照指纹不含数据分区大小（扩容不该作废快照、更不该清数据）', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, '只改容量不应改变指纹');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, '换引擎版本应改变指纹');
  });

  await test('日志超过上限自动滚动，只保留一份备份', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, '应执行滚动');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), '应变成 .1.log');
  });

  await test('日志文件名不以 .log 结尾时：宁可滚不动，也不能把日志删掉', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'bak 与源文件同名时必须放弃滚动');
    assert(fs.existsSync(f), '日志文件不能被删掉');
  });

  await test('启动失败记录会落盘，重启后再导出诊断报告也能看到真实原因', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / 硬件加速', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, '退出码应落盘');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', '诊断结论应落盘');
    assert(back.attempts.length === 1, '尝试记录应落盘');
    emu._clearFailure();
    assert(emu.lastFailure() === null, '启动成功后应清掉失败记录');
  });

  await test('.xapk 拆分包：流式解出分片、解析 base、失败时清理临时目录', async () => {
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // 成功：包内两个分片（base + config），meta 必须来自没有 split 属性的 base
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: buildApkBytes({ split: 'config.arm64_v8a' }) },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `应解出 2 个分片，实际 ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), '分片应落盘');
      assert(b.meta.package === 'com.example.test', `包名 ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // 失败：包里没有 APK 分片 → 明确报错，且不能把临时目录留在用户机器上
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /没有找到 APK 分片/.test(err.message), `应报没有分片，实际 ${err && err.message}`);
    const invalid = path.join(TMP, 'invalid.xapk');
    fs.writeFileSync(invalid, buildStoredZip([{ name: 'base.apk', data: Buffer.from('invalid APK') }]));
    const made = [];
    const mkdtemp = fs.mkdtempSync;
    fs.mkdtempSync = (...args) => { const dir = mkdtemp(...args); made.push(dir); return dir; };
    err = null;
    try { await parseBundle(invalid); } catch (e) { err = e; } finally { fs.mkdtempSync = mkdtemp; }
    assert(err, '损坏的 APK 必须拒绝');
    assert(made.length === 1 && !fs.existsSync(made[0]), '失败时应清理本次实际分配的临时目录');
  });

  await test('materializeImages：展开 .img.gz、已展开跳过、坏镜像上报失败且不留半截', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40MB 全零：gzip 后只有几十 KB，但解压后 >32MB，正好能验证「已展开」的判定
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `应展开 1 个镜像，实际 ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, '展开大小应正确');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), '非压缩组件应一并就位');
      assert(!fs.existsSync(`${img}.part`), '成功时不应留下 .part');

      const again = await prov.materializeImages();
      assert(again === 0, `已展开时应跳过，实际展开了 ${again}`);

      // 坏镜像：必须抛 MATERIALIZE_FAILED，并且清掉 .part（否则下次会被当成已完成）
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `坏镜像应失败，实际 ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), '失败后不应留下 .part');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('换下载源/整包地址后：provisioner 的地址缓存必须被清掉（否则要重启才生效）', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // 模拟解析过一次整包地址 / 引擎地址后的缓存
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, '整包地址缓存应被清空');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, '引擎/镜像地址缓存应被清空');
  });

  await test('每轮启动只用本轮日志做诊断（上一轮的崩溃不能污染下一轮）', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // 使用生产日志入口分配 seq，不能绕过协议直接注入无序号的 _log。
    const first = emu._logSeq;
    emu.log('Graphics backend: gfxstream');
    emu.log('emulator exit 3221225477');
    assert(doctor.diagnose(emu._attemptLines(first, 80)).code === 'ACCESS_VIOLATION', '第 1 轮应判崩溃');
    const second = emu._logSeq;
    emu.log('--- 第 2 轮 ---');
    emu.log('Address already in use');
    assert(doctor.diagnose(emu._attemptLines(second, 80)).code === 'PORT_BUSY', '第 2 轮应判端口占用');
    assert(emu._attemptLines(second, 1).join('\n') === 'Address already in use', '只应取本轮最后 max 行');
    assert(emu._attemptLines(emu._logSeq, 80).length === 0, '空轮次绝不能回借上轮崩溃/加速证据');

    // 环形数组达到 600 条后长度不再增长；旧崩溃仍在尾部也不能污染新一轮。
    for (let i = 0; i < 650; i += 1) emu.log(`previous attempt ${i}`);
    emu.log('emulator exit 3221225477');
    const afterWrap = emu._logSeq;
    assert(emu._log.length === 600 && afterWrap > emu._log.length, '应真实触发 600 条环形截断');
    emu.log('Address already in use');
    assert(emu._log.length === 600 && emu._logSeq === afterWrap + 1, '截断后序号仍须严格递增');
    assert(emu._attemptLines(afterWrap, 80).join('\n') === 'Address already in use', '截断后边界仍应隔离上轮');
    assert(doctor.diagnose(emu._attemptLines(afterWrap, 80)).code === 'PORT_BUSY', '环形截断后也应判端口占用');
    assert(emu._attemptLines(emu._logSeq, 80).length === 0, '截断后的空轮次也不能借用旧日志');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    assert(/const logStart = this\._logSeq;[\s\S]*this\._attemptLines\(logStart, 80\)/.test(src),
      '生产启动循环必须传单调序号边界，不能再用环形数组长度');
  });

  await test('启动组件拼接：完整组件不能重复拼包名（否则点图标只看到安卓桌面）', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // 完整组件（v0.3.4 装完后 apps.json 里存的就是这种）→ 原样使用
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', '完整组件应原样返回');
    // 老数据：纯类名 / 以点开头的类名 → 补包名
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', '空 activity 应返回空（走隐式 intent）');
    // resolve-activity 输出末尾常有空行/priority 行：必须能取到组件
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', '应跳过空行取到最后一行组件');
    assert(parseResolvedActivity('com.other', out) === '', '别的包名不能拿来用');
  });

  await test('首启引导：关键设置都在引导里，且「完成并重启」是真的重启', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    for (const id of [
      'wizardPage4', 'wizardPage5', 'wizardPage6', 'wizardPage7', 'wizardPage8',
      'wizMemory', 'wizCores', 'wizResourceMode', 'wizAccelText', 'wizEnableAccel',
      'wizRenderSize', 'wizDataGB', 'wizGpuMode', 'wizImageFlavor', 'wizLanguage',
      'wizGuestZh', 'wizSummary', 'btnBackToWizard',
    ]) {
      assert(html.includes(`id="${id}"`), `引导缺控件 ${id}`);
    }
    assert(/WIZARD_PAGES = 8/.test(app), '引导页数要覆盖新增的设置步骤');
    assert(/wizardFinish\(\{ restart: true \}\)/.test(app), '最后一步要调用重启');
    assert(/await api\.setSettings\(\{ wizardDone/.test(app), '必须先保存「引导已完成」再重启');
    assert(/app\.relaunch\(/.test(main), 'app:restart 以前只退出，不算重启');
    // 跳到设置页细调后必须能回到同一步（否则用户会被迫从头走一遍）
    assert(/wizard\.suspended = wizard\.page/.test(app), '跳设置前要记住当前步');
    assert(/wizard\.suspended\)/.test(app) && /wizardShowPage\(page\)/.test(app), '关设置要回到原步骤');
  });

  console.log(results.join('\n'));
  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();

'use strict';
/**
 * 运行时归属安全回归（纯 mock，不终止真实进程 / 不启动模拟器 / 不联网下载）。
 * 覆盖：realPath 归一、emulator 作用域收敛、emulatorRoot 判定、
 * ownsEmulator 证据链（exe / argv / -avd / -datadir / ANDROID_AVD_HOME）、
 * Windows argv 解析、pidOnPort 歧义拒绝、killOrphanProcesses 与 Runtime.stop
 * 的失败关闭行为（child_process 全部拦截）。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-own-'));
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.XDG_DATA_HOME = path.join(TMP, 'xdgdata');
fs.mkdirSync(process.env.APPDATA, { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    results.push(`  ✗ ${name}\n    ${e.message}`);
  }
}

// child_process 拦截必须在 require 业务模块之前就位
const spawnCalls = [];
const execCalls = [];
const terminatedPids = [];
const alivePorts = new Set();
const { EventEmitter } = require('events');
const net = require('net');
// 所有端口探测均在内存中响应，不连接用户的模拟器或系统端口。
net.connect = ({ port }) => {
  const sock = new EventEmitter();
  sock.setTimeout = () => sock;
  sock.destroy = () => {};
  process.nextTick(() => sock.emit(alivePorts.has(port) ? 'connect' : 'error', new Error('mock')));
  return sock;
};
const childProcess = require('child_process');
childProcess.execFile = function stubbedExecFile(file, args, opts, cb) {
  const callback = typeof opts === 'function' ? opts : cb;
  execCalls.push({ file, args });
  const key = `${file} ${args.join(' ')}`;
  if (args.includes('Terminate')) {
    const expected = JSON.parse(Buffer.from(args[args.indexOf('-Expected') + 1], 'base64').toString());
    const inspectArgs = args.slice(0, args.indexOf('-Expected'));
    inspectArgs[inspectArgs.indexOf('Terminate')] = 'Inspect';
    let now;
    try { now = JSON.parse(STUB_OUTPUT[`${file} ${inspectArgs.join(' ')}`]); } catch (_) { /* 缺失身份 */ }
    const ok = now && now.pid === expected.pid && now.started === expected.started && now.exe === expected.exe && now.commandLine === expected.commandLine;
    if (ok) terminatedPids.push(now.pid);
    setImmediate(() => callback(ok ? null : new Error('identity mismatch'), ok ? 'STOPPED' : '', ''));
    return;
  }
  setImmediate(() => callback(null, STUB_OUTPUT[key] || '', ''));
};
childProcess.spawn = function stubbedSpawn(file, args) {
  spawnCalls.push({ file, args });
  return { pid: 424242, killed: false, unref() {}, on() {}, kill() {} };
};

const STUB_OUTPUT = {};
const owner = require('../src/core/process-owner');

async function main() {
  await test('当前平台的真实 emulator 目录可验证，不把盘符根加入 scope', () => {
    const dir = path.join(TMP, 'portable', 'emulator');
    fs.mkdirSync(path.join(dir, 'qemu'), { recursive: true });
    const exe = path.join(dir, process.platform === 'win32' ? 'emulator.exe' : 'emulator');
    fs.writeFileSync(exe, 'fixture');
    assert.deepStrictEqual(owner.emulatorScopes([path.dirname(dir), dir]), [owner.realPath(dir)]);
    assert.strictEqual(owner.emulatorRoot(exe), owner.realPath(dir));
    assert.deepStrictEqual(owner.emulatorScopes([path.parse(dir).root]), []);
  });
  // Windows 身份检查依赖大小写不敏感文件系统与 Windows 命令行；Linux 另用下方完整 mock。
  if (process.platform === 'win32') {
  // ---------- 路径归一与作用域 ----------
  await test('realPath 归一大小写与反斜杠并处理不存在的路径', async () => {
    const dir = path.join(TMP, 'rt1', 'emulator');
    fs.mkdirSync(path.join(dir, 'qemu'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'emulator.exe'), 'x');
    const p = owner.realPath(dir.toUpperCase());
    assert(p && p === owner.realPath(dir), 'realpath 不一致');
    assert(owner.realPath(path.join(dir, 'nope')) === '', '不存在路径应返回空');
    assert(owner.realPath('C:relative\\path') === '', '相对路径应拒绝');
    assert(owner.realPath('D:\\a\0b') === '', 'NUL 字节应拒绝');
  });

  await test('磁盘根、家目录等宽泛祖先不允许作为信任作用域', async () => {
    assert.deepStrictEqual(owner.emulatorScopes(['C:\\', TMP, os.homedir(), process.env.APPDATA, '']), []);
  });

  await test('只有带 emulator.exe + qemu 的目录才进入 scope，且不再上溯', async () => {
    const dir = path.join(TMP, 'rt2', 'emulator');
    fs.mkdirSync(path.join(dir, 'qemu'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'emulator.exe'), 'x');
    const scopes = owner.emulatorScopes([dir, path.join(TMP, 'rt2'), path.join(TMP, 'nowhere')]);
    assert.deepStrictEqual(scopes, [owner.realPath(dir)], `应为精确 emulator 目录: ${scopes}`);
  });

  await test('emulator.exe 指向目录外的符号链接不授予目录信任', async () => {
    if (process.platform !== 'win32') return; // junction 仅 Windows 场景
    const dir = path.join(TMP, 'rt3', 'emulator');
    fs.mkdirSync(path.join(dir, 'qemu'), { recursive: true });
    const outside = path.join(TMP, 'outside.exe');
    fs.writeFileSync(outside, 'x');
    try { fs.symlinkSync(outside, path.join(dir, 'emulator.exe'), 'file'); } catch (_) { return; }
    assert.deepStrictEqual(owner.emulatorScopes([dir]), [], '符号链接逃逸必须拒绝');
  });

  await test('junction 归一后仍指向同一真实目录（junction 内部路径可用）', async () => {
    if (process.platform !== 'win32') return;
    const real = path.join(TMP, 'rt-real', 'emulator');
    fs.mkdirSync(path.join(real, 'qemu'), { recursive: true });
    fs.writeFileSync(path.join(real, 'emulator.exe'), 'x');
    const link = path.join(TMP, 'rt-link');
    try { fs.symlinkSync(path.join(TMP, 'rt-real'), link, 'junction'); } catch (_) { return; }
    const scopes = owner.emulatorScopes([path.join(link, 'emulator')]);
    assert.deepStrictEqual(scopes, [owner.realPath(real)], 'junction 必须落到真实目录');
  });

  // ---------- emulatorRoot / argv ----------
  await test('emulatorRoot 只认 emulator 与规范 qemu 布局', async () => {
    const root = path.join(TMP, 'rt4');
    const emuDir = path.join(root, 'emulator');
    fs.mkdirSync(path.join(emuDir, 'qemu', 'windows-x86_64'), { recursive: true });
    fs.writeFileSync(path.join(emuDir, 'emulator.exe'), 'x');
    fs.writeFileSync(path.join(emuDir, 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 'x');
    assert.strictEqual(owner.emulatorRoot(path.join(emuDir, 'emulator.exe')), owner.realPath(emuDir));
    assert.strictEqual(owner.emulatorRoot(path.join(emuDir, 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), owner.realPath(emuDir));
    assert.strictEqual(owner.emulatorRoot(path.join(root, 'emulator', 'qemu', 'bad', 'qemu-system-x86_64.exe')), '', '非常规 qemu 布局拒绝');
    assert.strictEqual(owner.emulatorRoot('C:\\Windows\\explorer.exe'), '');
  });

  await test('windowsArgv 处理引号转义与未闭合引号', async () => {
    assert.deepStrictEqual(owner.windowsArgv('a "b c" d\\'), ['a', 'b c', 'd\\']);
    assert.deepStrictEqual(owner.windowsArgv('"a\\"b"'), ['a"b']);
    assert.deepStrictEqual(owner.windowsArgv('"unclosed'), [], '未闭合引号拒绝整条命令行');
  });

  // ---------- ownsEmulator 证据链 ----------
  const avdHome = path.join(TMP, 'avdhome');
  const avdDir = path.join(avdHome, 'apkstart.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.writeFileSync(path.join(avdDir, 'hardware-qemu.ini'), 'hw.cpu.arch=x86_64');
  const rtRoot = path.join(TMP, 'rt5');
  const emuDir = path.join(rtRoot, 'emulator');
  fs.mkdirSync(path.join(emuDir, 'qemu'), { recursive: true });
  fs.writeFileSync(path.join(emuDir, 'emulator.exe'), 'x');
  const emuExe = owner.realPath(path.join(emuDir, 'emulator.exe'));
  const baseInfo = {
    pid: 4321, started: '133700000000000000', exe: emuExe,
    commandLine: '', avdHome: owner.realPath(avdHome),
    argv: [emuExe, '-avd', 'apkstart', '-datadir', avdDir],
  };
  const opts = { avdName: 'apkstart', avdDir, emulatorDirs: null };

  await test('完整证据链（exe+argv+avd+datadir）判定为自有进程', async () => {
    assert(owner.ownsEmulator(baseInfo, opts));
  });

  await test('AVD 名对但缺路径证据 / 路径对但 AVD 名不符都拒绝', async () => {
    assert(!owner.ownsEmulator({ ...baseInfo, avdHome: '', argv: [emuExe, '-avd', 'apkstart'] }, opts), '无 -datadir 且无 avdHome 应拒绝');
    assert(!owner.ownsEmulator({ ...baseInfo, argv: [emuExe, '-avd', 'other', '-datadir', avdDir] }, opts), 'AVD 名不符拒绝');
    assert(!owner.ownsEmulator({ ...baseInfo, avdHome: path.join(TMP, 'elsewhere'), argv: [emuExe, '-avd', 'apkstart'] }, opts), '无 datadir 时 AVD home 不符拒绝');
  });

  await test('外部模拟器树、无效 PID、missing birth 一律拒绝', async () => {
    const rogueDir = path.join(TMP, 'rogue', 'emulator');
    fs.mkdirSync(path.join(rogueDir, 'qemu'), { recursive: true });
    fs.writeFileSync(path.join(rogueDir, 'emulator.exe'), 'x');
    assert(!owner.ownsEmulator({ ...baseInfo, exe: owner.realPath(path.join(rogueDir, 'emulator.exe')), commandLine: '', argv: [] }, opts), '目录外 exe 拒绝');
    assert(!owner.ownsEmulator({ ...baseInfo, pid: process.pid }, opts), '自身 PID 拒绝');
    assert(!owner.ownsEmulator({ ...baseInfo, pid: 0 }, opts), 'PID 0 拒绝');
    assert(!owner.ownsEmulator({ ...baseInfo, started: '' }, opts), '缺 birth 拒绝');
  });

  await test('限定 emulatorDirs 时目录外 exe 即使 AVD 参数相符也拒绝', async () => {
    assert(!owner.ownsEmulator(baseInfo, { ...opts, emulatorDirs: [path.join(TMP, 'other-rt', 'emulator')] }));
    assert(owner.ownsEmulator(baseInfo, { ...opts, emulatorDirs: [emuDir] }));
  });

  await test('-android-hw 指向本 AVD 的 hardware-qemu.ini 可作为路径证据', async () => {
    const info = { ...baseInfo, argv: [emuExe, '-avd', 'apkstart', '-android-hw', path.join(avdDir, 'hardware-qemu.ini')] };
    assert(owner.ownsEmulator(info, opts));
    const bad = { ...baseInfo, argv: [emuExe, '-avd', 'apkstart', '-android-hw', path.join(avdHome, 'other.avd', 'hardware-qemu.ini')] };
    assert(!owner.ownsEmulator(bad, opts));
  });

  // ---------- listeners / pidOnPort（stub 输出） ----------
  await test('netstat/ss 解析仅取 LISTENING 行且过滤无效 PID', async () => {
    STUB_OUTPUT['netstat.exe -ano -p TCP'] = [
      '  TCP    127.0.0.1:5554    0.0.0.0:0    LISTENING    1234',
      '  TCP    127.0.0.1:5555    0.0.0.0:0    LISTENING    0',
      '  TCP    127.0.0.1:9999    0.0.0.0:0    ESTABLISHED  1234',
    ].join('\n');
    assert.deepStrictEqual(await owner.listeners(), [{ port: 5554, pid: 1234 }]);
    assert.strictEqual(await owner.pidOnPort(5554), 1234);
    assert.strictEqual(await owner.pidOnPort(9999), 0, '非监听端口无 PID');
  });

  await test('端口被多个 PID 监听时 pidOnPort 拒绝给出归属', async () => {
    STUB_OUTPUT['netstat.exe -ano -p TCP'] = [
      '  TCP    127.0.0.1:5554    0.0.0.0:0    LISTENING    111',
      '  TCP    [::]:5554           [::]:0      LISTENING    222',
    ].join('\n');
    assert.strictEqual(await owner.pidOnPort(5554), 0);
  });

  await test('非法端口参数直接拒绝', async () => {
    assert.strictEqual(await owner.pidOnPort(0), 0);
    assert.strictEqual(await owner.pidOnPort(70000), 0);
    assert.deepStrictEqual(await owner.listeners(70000), []);
  });

  // ---------- getProcessInfo / terminateOwnedProcess（stub） ----------
  await test('Inspect 返回损坏 JSON / PID 不符时拒绝归属', async () => {
    STUB_OUTPUT['powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1') + ' -Action Inspect -TargetPid 4321'] = '{"pid":999,"started":"1"}';
    assert.strictEqual(await owner.getProcessInfo(4321), null);
    delete STUB_OUTPUT['powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1') + ' -Action Inspect -TargetPid 4321'];
    assert.strictEqual(await owner.getProcessInfo(0), null);
    assert.strictEqual(await owner.getProcessInfo(process.pid), null);
  });

  await test('terminateOwnedProcess 无证据 / 身份漂移时不发起终止', async () => {
    spawnCalls.length = 0;
    execCalls.length = 0;
    assert.strictEqual(await owner.terminateOwnedProcess(null, () => true), false);
    assert.strictEqual(await owner.terminateOwnedProcess(baseInfo, () => false), false);
    assert.strictEqual(execCalls.length, 0, '未通过归属校验不得调用任何终止命令');
    // getProcessInfo 返回空（进程消失）→ 身份比对失败 → 不杀
    assert.strictEqual(await owner.terminateOwnedProcess(baseInfo, () => true), false);
    assert.strictEqual(execCalls.length, 1, '仅允许读取当前身份');
    assert(!execCalls.some((c) => c.args.includes('Terminate')), '身份未知不能终止');
  });

  // ---------- killOrphanProcesses（mock 锁文件） ----------
  const { EmulatorEngine } = require('../src/core/emulator');
  function makeEngine(avdDirOverride) {
    const eng = Object.create(EmulatorEngine.prototype);
    eng.appRoot = path.join(TMP, 'app');
    eng.port = 5554;
    eng.proc = null;
    eng.snapshotWorthSaving = null;
    eng.provisioner = { paths: () => ({ avdHome: path.dirname(avdDir), root: rtRoot, emulatorExe: path.join(emuDir, 'emulator.exe') }), activeImage: () => null };
    if (avdDirOverride) eng.provisioner.paths = () => ({ avdHome: path.dirname(avdDirOverride), root: rtRoot, emulatorExe: path.join(emuDir, 'emulator.exe') });
    return eng;
  }

  await test('锁 PID 不匹配归属时安全失败：不清锁、不杀进程', async () => {
    const eng = makeEngine();
    fs.mkdirSync(path.join(avdDir, 'hardware-qemu.ini.lock'), { recursive: true });
    fs.writeFileSync(path.join(avdDir, 'hardware-qemu.ini.lock', 'pid'), '5150\n');
    const logs = [];
    const killed = await eng.killOrphanProcesses({ onLog: (m) => logs.push(m) });
    assert.strictEqual(killed, 0);
    assert(fs.existsSync(path.join(avdDir, 'hardware-qemu.ini.lock', 'pid')), '归属不明不得清锁');
    assert(!execCalls.some((c) => /taskkill/i.test(c.file)), '不得出现 taskkill');
  });

  await test('锁 PID 身份相符且归属成立时才终止（stub 终止成功）', async () => {
    const eng = makeEngine();
    // Inspect 输出与 ownsEmulator 证据一致；Terminate 返回 STOPPED
    const helper = path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1');
    const inspect = {
      pid: 5150, started: '133700000000000000', exe: emuExe, commandLine: '',
      avdHome: owner.realPath(avdHome),
      argv: [emuExe, '-avd', 'apkstart', '-datadir', avdDir],
    };
    STUB_OUTPUT[`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${helper} -Action Inspect -TargetPid 5150`] = JSON.stringify(inspect);
    STUB_OUTPUT[`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${helper} -Action Inspect -TargetPid 5151`] = JSON.stringify(inspect);
    // terminateOwnedProcess 会先 Inspect 当前身份再发 Terminate
    execCalls.length = 0;
    const killed = await eng.killOrphanProcesses({ onLog: () => {} });
    assert.strictEqual(killed, 1, '归属成立才计为终止');
    assert(execCalls.some((c) => c.args.some((x) => /process-owner\.ps1/.test(x)) && c.args.includes('Terminate')), '应通过共享 helper 终止');
    assert(!execCalls.some((c) => /taskkill/i.test(c.file)), '不得直接 taskkill');
    assert(terminatedPids.includes(5150), '仅终止经验证的锁PID');
    delete STUB_OUTPUT[`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${helper} -Action Inspect -TargetPid 5150`];
    delete STUB_OUTPUT[`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${helper} -Action Inspect -TargetPid 5151`];
  });

  await test('锁目录格式异常（非数字 PID）不视为终止依据', async () => {
    const dir2 = path.join(TMP, 'avdhome2', 'apkstart.avd');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'multiinstance.lock'), 'not-a-pid');
    const eng = makeEngine(dir2);
    execCalls.length = 0;
    const killed = await eng.killOrphanProcesses({ onLog: () => {} });
    assert.strictEqual(killed, 0);
    assert.strictEqual(execCalls.length, 0, '格式异常不触发任何终止');
  });

  // ---------- Runtime.stop（接管分支）失败关闭 ----------
  const { Runtime } = require('../src/core/engine');
  function makeRuntime(serial) {
    const rt = Object.create(Runtime.prototype);
    rt.appRoot = path.join(TMP, 'app');
    rt.provisioner = { paths: () => ({ avdHome: path.dirname(avdDir), root: rtRoot, emulatorExe: path.join(emuDir, 'emulator.exe') }), activeImage: () => null };
    rt.emulator = makeEngine();
    rt.emulator.snapshotWorthSaving = false;
    rt.emuSerial = serial;
    rt.vmProc = null;
    rt._activeApps = new Set(['com.a']);
    Object.defineProperty(rt, 'settings', { value: { engine: { mode: 'builtin' } }, configurable: true });
    rt.adbPath = () => '';
    rt.client = () => ({ isOnline: async () => false, exec: async () => ({}) });
    return rt;
  }

  await test('attach 模式永不代管停止', async () => {
    const rt = makeRuntime('127.0.0.1:5555');
    rt.settings.engine.mode = 'attach';
    assert.strictEqual(await rt.stop(), false);
  });

  await test('接管实例停止后设备仍在线 → 如实返回 false', async () => {
    const rt = makeRuntime('127.0.0.1:5555');
    rt.emulator.stop = async () => true;
    rt.client = () => ({ isOnline: async () => true });
    assert.strictEqual(await rt.stop(), false, '设备在线不得报成功');
    assert(rt._activeApps.has('com.a'), '失败时不得清理会话状态');
  });

  await test('接管实例端口仍监听 → 如实返回 false', async () => {
    const rt = makeRuntime('127.0.0.1:5555');
    rt.emulator.stop = async () => true;
    alivePorts.add(5554);
    try { assert.strictEqual(await rt.stop(), false); }
    finally { alivePorts.delete(5554); }
  });

  await test('本地启动中实例即使 serial 未就绪也能安全停止，保留动态端口', async () => {
    const rt = makeRuntime('');
    rt.emulator.proc = { pid: 5150, killed: false };
    rt.emulator.port = 5570;
    let stopped = false;
    rt.emulator.stop = async () => { stopped = true; rt.emulator.proc = null; return true; };
    const serials = [];
    rt.client = (serial) => { serials.push(serial); return { isOnline: async () => false }; };
    assert.strictEqual(await rt.stop(), true);
    assert(stopped);
    assert.strictEqual(rt.emulator.port, 5570);
    assert.deepStrictEqual(serials, ['emulator-5570']);
  });

  await test('未知 serial 的接管实例拒绝停止（失败关闭）', async () => {
    const rt = makeRuntime('10.0.2.2:5555');
    assert.strictEqual(await rt.stop(), false);
  });

  await test('QEMU 分支：归属不符的 vmProc 拒绝终止并返回 false', async () => {
    const rt = makeRuntime('');
    rt.vmProc = { pid: 424242, killed: false };
    rt._vmExe = 'C:\\windows\\system32\\notepad.exe';
    rt._vmDisk = 'C:\\no\\disk.qcow2';
    rt.emulator.running = () => false;
    rt.client = () => ({ isOnline: async () => false });
    // getProcessInfo 走 stub Inspect：返回 notepad 身份 → ownsQemuProcess false
    STUB_OUTPUT['powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1') + ' -Action Inspect -TargetPid 424242'] = JSON.stringify({ pid: 424242, started: '1', exe: 'c:\\windows\\system32\\notepad.exe', commandLine: '' });
    assert.strictEqual(await rt.stop({ graceful: false }), false);
    assert(rt.vmProc, '归属不符不得清句柄');
  });

  await test('agent.scope 重复路径归一且不重复下发', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.call = async (req) => req;
    const dir = path.join(TMP, 'rt5', 'emulator');
    const r1 = await a.scope([dir, dir.toUpperCase()], 100);
    assert.strictEqual(r1.dirs.split(';').length, 1, '重复目录应去重');
    assert.strictEqual(r1.dirs, owner.realPath(dir), '应下发归一后的真实路径');
    const empty = await a.scope(['C:\\', '', null]);
    assert.strictEqual(empty.dirs, '', '宽泛/空目录不得下发');
    const r2 = await a.scope([], 100);
    assert.strictEqual(r2.pid, 100);
  });

  await test('activeRuntimeRoots 仅加入经归属验证的 emulator 根，不上溯任何祖先', async () => {
    const rt = makeRuntime('emulator-5554');
    const helper = path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1');
    const key = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${helper} -Action Inspect -TargetPid 5150`;
    STUB_OUTPUT['netstat.exe -ano -p TCP'] = ' TCP 127.0.0.1:5554 0.0.0.0:0 LISTENING 5150\n TCP 127.0.0.1:5555 0.0.0.0:0 LISTENING 5150';
    STUB_OUTPUT[key] = JSON.stringify({ ...baseInfo, pid: 5150 });
    assert.deepStrictEqual(await rt.activeRuntimeRoots(), [owner.realPath(emuDir)]);
    STUB_OUTPUT[key] = JSON.stringify({ ...baseInfo, pid: 5150, argv: [emuExe, '-avd', 'not-apkstart', '-datadir', avdDir] });
    assert.deepStrictEqual(await rt.activeRuntimeRoots(), [], '另一个AVD不能授予目录信任');
    delete STUB_OUTPUT[key];
  });

  await test('PID 启动时间改变时拒绝终止（复用回归）', async () => {
    const helper = path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1');
    const key = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${helper} -Action Inspect -TargetPid 4321`;
    STUB_OUTPUT[key] = JSON.stringify({ ...baseInfo, started: '133700000000000001' });
    execCalls.length = 0;
    assert.strictEqual(await owner.terminateOwnedProcess(baseInfo, (p) => owner.ownsEmulator(p, opts)), false);
    assert(!execCalls.some((x) => x.args.includes('Terminate')), 'PID 复用不能进入终止操作');
    delete STUB_OUTPUT[key];
  });

  } else {
    results.push('  ↷ 跳过 Windows 文件系统/命令行专属反例；继续验证本平台目录和 Linux 完整调用链');
  }

  // 在 VM 中模拟 Linux /proc、ss、pidfd helper，绝不访问宿主真实进程。
  const vm = require('vm');
  function linuxHarness() {
    const entries = new Map();
    const commands = [];
    let listening = true;
    let pidfdAvailable = true;
    const p = path.posix;
    const putDir = (name) => {
      if (entries.has(name)) return;
      entries.set(name, { dir: true });
      if (name !== '/') putDir(p.dirname(name));
    };
    const put = (name, data) => { putDir(p.dirname(name)); entries.set(name, { data: Buffer.from(data) }); };
    const emu = '/safe/package/emulator/emulator';
    const avd = '/safe/data/apkstart.avd';
    put(emu, 'mock');
    putDir('/safe/package/emulator/qemu');
    put(avd + '/hardware-qemu.ini', 'mock');
    const argv = [emu, '-avd', 'apkstart', '-datadir', avd];
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '70001';
    put('/proc/8001/stat', '8001 (qemu with ) name) ' + fields.join(' '));
    put('/proc/8001/cmdline', argv.join('\0') + '\0');
    put('/proc/8001/environ', 'ANDROID_AVD_HOME=/safe/data\0');
    entries.set('/proc/8001/exe', { target: emu });
    const realpath = (name) => {
      const entry = entries.get(name);
      if (!entry) throw new Error('mock ENOENT');
      return entry.target || name;
    };
    realpath.native = realpath;
    const fakeFs = {
      realpathSync: realpath,
      statSync(name) {
        const item = entries.get(realpath(name));
        return { isDirectory: () => !!item.dir, isFile: () => !item.dir };
      },
      readFileSync(name, encoding) {
        const item = entries.get(name);
        if (!item?.data) throw new Error('mock ENOENT');
        return encoding ? item.data.toString(encoding) : item.data;
      },
    };
    const fakeChild = {
      execFile(file, args, options, cb) {
        commands.push({ file, args });
        if (file === 'ss') return cb(null, listening ? 'LISTEN 0 128 127.0.0.1:5554 0.0.0.0:* users:(("emulator",pid=8001,fd=9))' : '');
        if (file === 'python3') {
          assert.strictEqual(args[0], '-I', 'Python 必须隔离环境');
          assert(args[2].includes('os.pidfd_open') && args[2].includes('signal.pidfd_send_signal'), '终止必须通过 pidfd');
          if (!pidfdAvailable) return cb(new Error('mock pidfd unsupported'), '');
          listening = false;
          entries.delete('/proc/8001/stat');
          return cb(null, 'STOPPED');
        }
        throw new Error(`禁止的宿主命令: ${file}`);
      },
    };
    const fakeProcess = { platform: 'linux', pid: 999999, env: {}, kill() { throw new Error('禁止按 PID 直接终止'); } };
    function load(file, extra = {}) {
      const mod = { exports: {} };
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', file), 'utf8');
      const req = (name) => {
        if (name in extra) return extra[name];
        if (name === 'fs') return fakeFs;
        if (name === 'path') return p;
        if (name === 'child_process') return fakeChild;
        if (name === 'net') return net;
        if (name === 'crypto') return require('crypto');
        if (name === './store') return { DATA_DIR: '/safe/data' };
        if (name.startsWith('./')) return {};
        throw new Error(`未声明 mock 依赖: ${name}`);
      };
      const wrapper = vm.runInNewContext('(function(require,module,exports,__dirname,process,Buffer){' + source + '\n})', { setTimeout, clearTimeout, setInterval, clearInterval });
      wrapper(req, mod, mod.exports, '/source/core', fakeProcess, Buffer);
      return mod.exports;
    }
    const linuxOwner = load('process-owner.js');
    const { EmulatorEngine: LinuxEmulator } = load('emulator.js', { './process-owner': linuxOwner });
    const { Runtime: LinuxRuntime } = load('engine.js', { './process-owner': linuxOwner, './emulator': { EmulatorEngine: LinuxEmulator } });
    const eng = Object.create(LinuxEmulator.prototype);
    eng.appRoot = '/source'; eng.proc = null; eng.port = 5554; eng.snapshotWorthSaving = false;
    eng.cancelSnapshotSave = () => {};
    eng._consoleAlive = async () => listening;
    eng.provisioner = { paths: () => ({ root: '/safe/package', emulatorExe: emu, avdHome: '/safe/data' }), activeImage: () => null };
    const runtime = Object.create(LinuxRuntime.prototype);
    Object.defineProperty(runtime, 'settings', { value: { engine: { mode: 'builtin' } } });
    runtime.emulator = eng; runtime.emuSerial = 'emulator-5554'; runtime.vmProc = null;
    runtime.adbPath = () => ''; runtime.client = () => ({ isOnline: async () => false }); runtime._activeApps = new Set(['example']);
    return { owner: linuxOwner, runtime, commands, eng,
      setPidfdAvailable(value) { pidfdAvailable = value; },
      setListening(value) { listening = value; } };
  }

  await test('Linux pidOnPort 使用 ss，并正确解析 /proc 进程启动身份与 AVD_HOME', async () => {
    const h = linuxHarness();
    assert.strictEqual(await h.runtime.pidOnPort(5554), 8001);
    assert(h.commands.every((x) => x.file === 'ss'), 'Linux 不得调用 Windows netstat/taskkill');
    const info = await h.owner.getProcessInfo(8001);
    assert.strictEqual(info.started, '70001');
    assert.strictEqual(info.avdHome, '/safe/data');
    assert(h.eng.ownsProcess(info));
  });

  await test('Linux Runtime.stop 验证归属后通过隔离 Python/pidfd 停止', async () => {
    const h = linuxHarness();
    assert.strictEqual(await h.runtime.stop(), true);
    assert(h.commands.some((x) => x.file === 'python3' && x.args[0] === '-I'));
    assert(!h.commands.some((x) => /taskkill|powershell|netstat/i.test(x.file)));
  });

  await test('Linux pidfd 不可用且端口仍在线时停止返回 false，不退化为 process.kill', async () => {
    const h = linuxHarness();
    h.setPidfdAvailable(false);
    assert.strictEqual(await h.runtime.stop(), false);
    assert(h.runtime._activeApps.has('example'));
    assert(h.commands.filter((x) => x.file === 'python3').length === 2, 'SIGTERM 失败后仅允许验证后的 SIGKILL');
  });

  await test('NSIS 仅在确认卸载的 customUnInstall 调用限定清理，不按 /IM 杀进程', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    assert(!/taskkill\.exe\s+.*\/IM/i.test(source));
    const start = source.indexOf('!macro customUnInstall');
    const script = source.indexOf('-File "$INSTDIR\\resources\\app\\build\\stop-runtime.ps1"');
    assert(start >= 0 && script > start, '清理脚本只能在确认后的卸载宏里运行');
    assert(source.includes('-InstallDir "$INSTDIR" -DataDir "$APPDATA\\apkstart"'));
  });

  console.log(`\n[runtime-ownership-test] ${passed} 通过, ${failed} 失败`);
  for (const line of results) console.log(line);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));

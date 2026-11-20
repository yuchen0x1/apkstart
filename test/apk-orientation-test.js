'use strict';
/** APK → Installer → 磁盘 store → LCD，以及 ARM 取证回归。纯临时文件/mock，禁止真实进程和网络。 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-orientation-'));
process.env.APPDATA = TMP;
process.env.XDG_DATA_HOME = TMP;

// 即使产品代码误走下载/ADB/模拟器分支，也不能真的联网或启动进程；记录被吞掉的异常。
const forbidden = [];
const restores = [];
for (const [obj, names] of [
  [require('child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
  [require('http'), ['request', 'get']],
  [require('https'), ['request', 'get']],
  [require('net'), ['connect', 'createConnection']],
  [global, ['fetch']],
]) {
  for (const name of names) {
    const original = obj[name];
    obj[name] = () => { forbidden.push(name); throw new Error(`禁止真实进程/网络：${name}`); };
    restores.push(() => { obj[name] = original; });
  }
}

const { parseApk } = require('../src/core/apk');
const { Installer } = require('../src/core/installer');
const store = require('../src/core/store');
const lcd = require('../src/core/lcd');
const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');

let passed = 0;
let failed = 0;
let seq = 0;
const PKG = 'com.example.orientation';
const DATA_FILE = path.join(store.DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(store.DATA_DIR, 'settings.json');

function writeApk(options = {}) {
  const file = path.join(TMP, `fixture-${++seq}.apk`);
  fs.writeFileSync(file, buildApkBytes({ packageName: PKG, abis: [], ...options }));
  return file;
}

function writeBundle(options = {}) {
  const file = path.join(TMP, `fixture-${++seq}.apks`);
  fs.writeFileSync(file, buildStoredZip([
    { name: 'base.apk', data: buildApkBytes({ packageName: PKG, ...options }) },
  ]));
  return file;
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n${e.stack || e}`);
  }
}

async function rejection(fn) {
  let error;
  await assert.rejects(fn, (e) => { error = e; return true; });
  return error;
}

async function withClock(fn) {
  const now = Date.now;
  const timeout = global.setTimeout;
  let clock = now();
  Date.now = () => clock;
  global.setTimeout = (cb, ms, ...args) => {
    clock += Number(ms) || 0;
    queueMicrotask(() => cb(...args));
    return { unref() {} };
  };
  try { return await fn(); } finally { Date.now = now; global.setTimeout = timeout; }
}

function fixture(options = {}) {
  store.saveApps([]);
  store.saveSettings({
    createShortcutOnInstall: false,
    runtime: { activeImageId: options.custom ? 'custom-test' : '', systemImageFlavor: 'google_apis_playstore' },
  });
  const state = {
    abis: 'x86_64,arm64-v8a,armeabi-v7a', bridge: 'libndk_translation.so', legacyAbi: '',
    installed: true, resolved: `${PKG}/.Resolved`, ...options,
  };
  const calls = { shell: [], install: [], multiple: [], start: 0, cache: 0, stop: 0, download: 0,
    wipe: 0, invalidations: 0, snapshots: 0, network: 0, ensure: 0, touch: 0, metadata: 0, unexpected: [] };
  const client = {
    async shell(cmd) {
      calls.shell.push(cmd);
      if (cmd.startsWith('getprop ')) {
        if (state.propFailure) throw new Error('mock getprop unavailable');
        if (cmd === 'getprop ro.product.cpu.abilist') return state.abis;
        if (cmd === 'getprop ro.dalvik.vm.native.bridge') return state.bridge;
        if (cmd === 'getprop ro.product.cpu.abi') return state.legacyAbi;
      }
      if (cmd === 'df -k /data') return '/dev/block/dm-0 67108864 1024 67107840 1% /data\n';
      if (cmd.startsWith('pm list packages ')) return state.installed ? `package:${PKG}\n` : '';
      if (cmd.startsWith('pidof ')) return '1234\n';
      calls.unexpected.push(cmd);
      throw new Error(`未预期的客机命令：${cmd}`);
    },
    async install(file) { calls.install.push(file); if (state.installError) throw state.installError; },
    async installMultiple(files) { calls.multiple.push([...files]); if (state.installError) throw state.installError; },
    clearLauncherCache() {},
    async resolveLauncher() { return state.resolved; },
    async batteryOptimizeOff() {},
    async grantRuntimePermissions() {},
    async dismissPermissionDialog() {},
    async forceStop() {},
    async clearCache() { calls.cache += 1; },
    async startApp() { calls.start += 1; if (state.launchError) throw state.launchError; },
  };
  const runtime = {
    provisioner: {
      systemImageInfo() { calls.metadata += 1; return { ok: true, armTranslation: { enabled: state.imageArm !== false } }; },
      activeImage() { calls.metadata += 1; return { ok: true, custom: !!state.custom, name: 'mock custom' }; },
      playImageInfo() { return { ok: true }; },
      async installPlayImage() { calls.download += 1; throw new Error('禁止镜像下载'); },
    },
    emulator: {
      invalidateSnapshot() { calls.invalidations += 1; },
      forceWipeOnNextStart() { calls.wipe += 1; throw new Error('禁止自动 wipe'); },
    },
    async ensure() { calls.ensure += 1; return { ok: true, engine: 'emulator', client }; },
    client: () => client,
    async stop() { calls.stop += 1; throw new Error('禁止自动停止/切换镜像'); },
    async waitForNetwork() { calls.network += 1; return { ok: true, ip: '10.0.2.15' }; },
    touch() { calls.touch += 1; },
    scheduleSnapshotSave() { calls.snapshots += 1; },
  };
  const installer = new Installer(runtime, { desktopDir: path.join(TMP, 'desktop'), decodeIcon: async (raw) => raw });
  return { installer, runtime, client, state, calls, settingsBefore: fs.readFileSync(SETTINGS_FILE, 'utf8') };
}

function noSwitch(f) {
  assert.equal(f.calls.stop, 0, '不能自动停机/换镜像');
  assert.equal(f.calls.download, 0, '不能重复下载镜像');
  assert.equal(f.calls.wipe, 0, '不能清空 AVD');
  assert.deepEqual(f.calls.unexpected, [], '不能执行未知或清数据命令');
  assert.equal(fs.readFileSync(SETTINGS_FILE, 'utf8'), f.settingsBefore, '不能改镜像/全局设置');
}

function noRetryPromise(error, progress = []) {
  const text = [error.message, ...progress.map((p) => typeof p === 'string' ? p : p.message)].join('\n');
  assert(!/会自动.*(?:切换|重试)|正在.*(?:重试|切换|下载)|已切换|已自动.*重试/.test(text), text);
}

function sameRecord(result) {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).apps.find((a) => a.package === PKG);
  assert.deepEqual(JSON.parse(JSON.stringify(result.app)), saved);
  assert.deepEqual(store.getApp(PKG), saved);
  return saved;
}

async function main() {
  try {
    store.ensureDirs();
    assert.equal(path.dirname(store.DATA_DIR), TMP, '持久化必须隔离到临时目录');
    console.log('\n[AXML screenOrientation]');
    const orientations = new Map([
      [-1, ''], [0, 'landscape'], [1, 'portrait'], [2, ''], [3, ''], [4, ''], [5, ''],
      [6, 'landscape'], [7, 'portrait'], [8, 'landscape'], [9, 'portrait'], [10, ''],
      [11, 'landscape'], [12, 'portrait'], [13, ''], [14, ''], [99, ''],
    ]);
    for (const [value, expected] of orientations) {
      await test(`整数 ${value} → ${expected || 'unknown'}`, () => {
        assert.equal(parseApk(writeApk({ orientation: value })).orientation, expected);
      });
    }
    for (const [expected, values] of [
      ['landscape', ['landscape', 'sensorLandscape', 'reverseLandscape', 'userLandscape']],
      ['portrait', ['portrait', 'sensorPortrait', 'reversePortrait', 'userPortrait']],
      ['', ['unspecified', 'user', 'behind', 'sensor', 'nosensor', 'fullSensor', 'fullUser', 'locked', 'toString', 'constructor', '0', '1']],
    ]) {
      await test(`字符串方向 ${expected || 'unknown'}（${values.join(', ')}）`, () => {
        for (const orientation of values) assert.equal(parseApk(writeApk({ orientation })).orientation, expected, orientation);
      });
    }
    await test('未声明方向时不猜；application=0 可回退，Activity=0 优先', () => {
      assert.equal(parseApk(writeApk()).orientation, '');
      assert.equal(parseApk(writeApk({ appOrientation: 0 })).orientation, 'landscape');
      assert.equal(parseApk(writeApk({ orientation: 0, appOrientation: 'portrait' })).orientation, 'landscape');
      assert.equal(parseApk(writeApk({ orientation: 1, appOrientation: 'landscape' })).orientation, 'portrait');
    });
    await test('Activity 显式未知方向不能被 application 方向覆盖', () => {
      for (const orientation of [-1, 2, 3, 4, 5, 10, 13, 14, 'sensor', 'locked', 'toString']) {
        assert.equal(parseApk(writeApk({ orientation, appOrientation: 'landscape' })).orientation, '', String(orientation));
      }
    });

    console.log('\n[install → store → LCD]');
    await test('全部整数经真实安装编排落盘并驱动 LCD；升级更新元数据、不遗留旧方向', async () => {
      const f = fixture();
      for (const [value, expected] of orientations) {
        const versionCode = ++seq;
        f.state.resolved = `${PKG}/.Resolved${versionCode}`;
        const file = writeApk({ orientation: value, versionCode, versionName: `2.${versionCode}`, label: `App ${versionCode}` });
        const result = await f.installer.install(file);
        const saved = sameRecord(result);
        assert.equal(saved.orientation, expected);
        assert.equal(lcd.desiredOrientation(saved), expected);
        assert.equal(lcd.desiredOrientation(result.app), expected);
        assert.equal(saved.versionCode, versionCode);
        assert.equal(saved.versionName, `2.${versionCode}`);
        assert.equal(saved.label, `App ${versionCode}`);
        assert.equal(saved.activity, f.state.resolved);
        assert.equal(parseApk(saved.apkPath).orientation, expected, '备份 APK 必须是新版');
      }
      assert.equal(f.calls.install.length, orientations.size);
      noSwitch(f);
    });
    await test('覆盖安装保留 lcdPref、窗口、置顶、统计、自定义偏好；返回值与磁盘一致', async () => {
      const f = fixture();
      await f.installer.install(writeApk({ orientation: 0 }));
      const prefs = { bounds: { x: 11, y: 22, width: 800, height: 600 }, pinned: true,
        accent: 'user-color', installedAt: 12345, launchCount: 9, lastLaunchAt: 67890,
        startMenuPath: 'remembered-shortcut', userDisplay: { scale: 0.75 } };
      for (const lcdPref of ['keep', 'landscape', 'portrait']) {
        store.upsertApp({ package: PKG, ...prefs, lcdPref });
        const file = writeApk({ orientation: 1, versionCode: ++seq, minSdk: 28, abis: ['x86_64'] });
        const result = await f.installer.install(file);
        const saved = sameRecord(result);
        for (const [key, value] of Object.entries({ ...prefs, lcdPref })) {
          assert.deepEqual(saved[key], value, key);
          assert.deepEqual(result.app[key], value, `返回值 ${key}`);
        }
        assert.equal(saved.orientation, 'portrait');
        assert.equal(saved.minSdk, 28);
        assert.deepEqual(saved.abis, ['x86_64']);
        assert.equal(lcd.desiredOrientation(saved), lcdPref === 'keep' ? '' : lcdPref);
      }
      const result = await f.installer.install(writeApk({ versionCode: ++seq }));
      assert.equal(sameRecord(result).orientation, '', '新版删掉方向声明时不能继续用旧值');
      assert.equal(result.app.lcdPref, 'portrait');
      assert.equal(lcd.desiredOrientation(result.app), 'portrait', '用户偏好仍然优先');
      noSwitch(f);
    });
    await test('安装进行中刚修改的用户偏好也不能被旧记录覆盖', async () => {
      const f = fixture();
      await f.installer.install(writeApk({ orientation: 0 }));
      store.upsertApp({ package: PKG, lcdPref: 'landscape', launchCount: 1 });
      const install = f.client.install;
      f.client.install = async (file) => {
        await install(file);
        store.upsertApp({ package: PKG, lcdPref: 'keep', pinned: true, launchCount: 5 });
      };
      const result = await f.installer.install(writeApk({ orientation: 1, versionCode: ++seq }));
      const saved = sameRecord(result);
      assert.equal(saved.orientation, 'portrait');
      assert.equal(saved.lcdPref, 'keep');
      assert.equal(saved.pinned, true);
      assert.equal(saved.launchCount, 5);
      assert.equal(lcd.desiredOrientation(result.app), '');
      noSwitch(f);
    });
    await test('拆分包同样持久化 landscape=0，且解包临时文件在成功后清理', async () => {
      const f = fixture();
      const result = await f.installer.install(writeBundle({ orientation: 0, abis: ['x86_64'] }));
      assert.equal(lcd.desiredOrientation(sameRecord(result)), 'landscape');
      assert.equal(result.app.bundle, true);
      assert.equal(f.calls.multiple.length, 1);
      assert(f.calls.multiple[0].every((p) => !fs.existsSync(p)));
      noSwitch(f);
    });

    console.log('\n[ARM runtime evidence / truthful failures]');
    for (const bridge of ['0', 'libndk_translation.so']) {
      await test(`镜像称支持 ARM，但旧快照只报 x86（bridge=${bridge}）→ 阻止误用，不下载/清数据`, async () => {
        const f = fixture({ abis: 'x86_64,x86', bridge, imageArm: true });
        const progress = [];
        const e = await rejection(() => f.installer.install(writeApk({ abis: ['arm64-v8a'] }), (p) => progress.push(p)));
        assert.equal(e.code, 'NO_MATCHING_ABIS');
        assert.deepEqual(e.abiEvidence.abis, ['x86_64', 'x86']);
        assert.match(e.message, /旧快照/);
        noRetryPromise(e, progress);
        assert.equal(f.calls.install.length, 0);
        assert.equal(f.calls.invalidations, 0);
        assert.equal(f.calls.touch, 0);
        assert.deepEqual(store.getApps(), []);
        noSwitch(f);
      });
    }
    for (const custom of [false, true]) {
      await test(`实际 ABI 支持 ARM（custom=${custom}），不依赖镜像 armTranslation 标签`, async () => {
        const f = fixture({ custom, imageArm: false });
        await f.installer.install(writeApk({ abis: ['arm64-v8a'] }));
        assert.equal(f.calls.install.length, 1);
        assert.equal(f.calls.metadata, 0, '不能以镜像元信息代替运行中能力');
        assert(f.calls.shell.includes('getprop ro.product.cpu.abilist'));
        assert(f.calls.shell.includes('getprop ro.dalvik.vm.native.bridge'));
        noSwitch(f);
      });
    }
    await test('原生 ARM 客机无转译层也可运行；32 位 ARM 能力不冒充 ARM64', async () => {
      const native = fixture({ abis: 'arm64-v8a,armeabi-v7a', bridge: '0', custom: true });
      await native.installer.install(writeApk({ abis: ['arm64-v8a'] }));
      noSwitch(native);
      const arm32 = fixture({ abis: 'armeabi-v7a,armeabi' });
      const e = await rejection(() => arm32.installer.install(writeApk({ abis: ['arm64-v8a'] })));
      assert.equal(e.code, 'NO_MATCHING_ABIS');
      assert.equal(arm32.calls.install.length, 0);
      noSwitch(arm32);
    });
    await test('旧客机 abilist 缺失时可只读回退 cpu.abi，不猜转译已启用', async () => {
      const f = fixture({ abis: '', legacyAbi: 'arm64-v8a', bridge: '0' });
      await f.installer.install(writeApk({ abis: ['arm64-v8a'] }));
      assert.equal(f.calls.install.length, 1);
      assert(f.calls.shell.includes('getprop ro.product.cpu.abi'));
      noSwitch(f);
    });
    await test('只读到主 x86 ABI 不等于拿到完整列表，不误拦截潜在转译支持', async () => {
      const f = fixture({ abis: '', legacyAbi: 'x86_64', bridge: 'libndk_translation.so' });
      await f.installer.install(writeApk({ abis: ['arm64-v8a'] }));
      assert.equal(f.calls.install.length, 1, '完整 abilist 未知时交由实际安装结果裁决');
      noSwitch(f);
    });
    await test('getprop 未知/失败不武断拦截安装；实际 ABI 失败不虚假承诺重试', async () => {
      for (const props of [{ propFailure: true }, { abis: 'error: device offline', bridge: '' }]) {
        const f = fixture(props);
        const file = writeApk({ abis: ['arm64-v8a'] });
        await f.installer.install(file);
        const oldError = Object.assign(new Error('会自动切换到兼容镜像并重试 INSTALL_FAILED_NO_MATCHING_ABIS'), { code: 'NO_MATCHING_ABIS' });
        f.state.installError = oldError;
        const before = store.getApps();
        const e = await rejection(() => f.installer.install(file));
        assert.equal(e.code, 'NO_MATCHING_ABIS');
        assert.equal(e.cause, oldError);
        assert.match(e.message, /未能确认/);
        noRetryPromise(e);
        assert.equal(f.calls.install.length, 2, '每次请求只安装一次');
        assert.deepEqual(store.getApps(), before, '失败不能覆盖已有元数据');
        noSwitch(f);
      }
    });
    await test('ABI 列表声称匹配但安装仍失败：保留失败码/原始原因，不重下同一镜像', async () => {
      const original = Object.assign(new Error('会自动切换并重试'), { code: 'NO_MATCHING_ABIS' });
      const f = fixture({ installError: original });
      const progress = [];
      const e = await rejection(() => f.installer.install(writeApk({ abis: ['arm64-v8a'] }), (p) => progress.push(p)));
      assert.equal(e.cause, original);
      assert.equal(e.code, 'NO_MATCHING_ABIS');
      assert.equal(f.calls.install.length, 1);
      assert(!progress.some((p) => p.stage === 'done'));
      assert.deepEqual(store.getApps(), []);
      noRetryPromise(e, progress);
      noSwitch(f);
    });
    await test('MIPS/混合 ABI 安装失败不冒充 ARM-only；其他错误保持原样', async () => {
      for (const abis of [['mips'], ['arm64-v8a', 'x86_64'], []]) {
        const f = fixture({ abis: 'x86_64', bridge: '0', imageArm: false });
        f.state.installError = Object.assign(new Error('INSTALL_FAILED_NO_MATCHING_ABIS'), { code: 'NO_MATCHING_ABIS' });
        const e = await rejection(() => f.installer.install(writeApk({ abis })));
        assert.equal(e.code, 'NO_MATCHING_ABIS');
        assert(!/只提供 ARM|没有 ARM 转译层/.test(e.message));
        noRetryPromise(e);
        noSwitch(f);
      }
      const original = Object.assign(new Error('mock storage error'), { code: 'INSUFFICIENT_STORAGE' });
      const f = fixture({ installError: original });
      assert.equal(await rejection(() => f.installer.install(writeApk())), original);
      noSwitch(f);
    });
    await test('拆分包 ABI 失败同样不谎称重试，失败后清理全部解包文件', async () => {
      const f = fixture({ installError: Object.assign(new Error('会自动切换并重试'), { code: 'NO_MATCHING_ABIS' }) });
      const e = await rejection(() => f.installer.install(writeBundle({ abis: ['arm64-v8a'] })));
      assert.equal(e.code, 'NO_MATCHING_ABIS');
      assert.equal(f.calls.multiple.length, 1);
      assert(f.calls.multiple[0].every((p) => !fs.existsSync(p)));
      noRetryPromise(e);
      noSwitch(f);
    });
    await test('安装后客机能力变化，启动必须重新取证，不复用镜像标签/安装时结果', async () => {
      const f = fixture();
      await f.installer.install(writeApk({ abis: ['arm64-v8a'] }));
      f.state.abis = 'x86_64';
      f.state.bridge = '0';
      const logs = [];
      const e = await rejection(() => f.installer.launch(PKG, { onLog: (m) => logs.push(m) }));
      assert.equal(e.code, 'NEEDS_ARM_TRANSLATION');
      assert.equal(f.calls.start, 0);
      assert.equal(f.calls.network, 0, '已知 ABI 不匹配时不再白等网络');
      assert.equal(f.calls.cache, 0);
      assert.equal(f.calls.shell.filter((c) => c === 'getprop ro.product.cpu.abilist').length, 2);
      noRetryPromise(e, logs);
      noSwitch(f);
    });
    await test('自定义镜像有实际 ARM ABI 时正常启动并累计次数，不无故判断无转译层', async () => {
      const f = fixture({ custom: true, imageArm: false, abis: 'arm64-v8a', bridge: '0' });
      store.upsertApp({ package: PKG, abis: ['arm64-v8a'], launchCount: 2 });
      const result = await withClock(() => f.installer.launch(PKG));
      assert.equal(result.ok, true);
      assert.equal(f.calls.start, 1);
      assert.equal(store.getApp(PKG).launchCount, 3);
      assert.equal(f.calls.metadata, 0);
      noSwitch(f);
    });
    for (const custom of [false, true]) {
      await test(`转译层崩溃有日志才提 ARM；没有已确定的安全修复就不重试（custom=${custom}）`, async () => {
        const original = Object.assign(new Error('会自动切换到兼容镜像后重试'), {
          code: 'APP_CRASHED', crash: 'F DEBUG: DoBadTrampoline libndk_translation SIGABRT',
        });
        const f = fixture({ custom, launchError: original });
        store.upsertApp({ package: PKG, label: 'ARM App', abis: ['arm64-v8a'] });
        const logs = [];
        const e = await rejection(() => withClock(() => f.installer.launch(PKG, { onLog: (m) => logs.push(m) })));
        assert.equal(e.code, 'APP_CRASHED');
        assert.equal(e.cause, original);
        assert.equal(e.crash, original.crash);
        assert.match(e.message, /日志涉及 ARM 转译层/);
        assert.equal(f.calls.start, 1);
        assert.equal(f.calls.cache, 0, 'ABI/转译错误不盲目清缓存');
        assert.equal(store.getApp(PKG).launchCount, undefined);
        noRetryPromise(e, logs);
        noSwitch(f);
      });
    }
    await test('x86 原生库加载失败不武断判成 ARM/自定义镜像缺少转译层', async () => {
      const original = Object.assign(new Error('会自动切换并重试'), {
        code: 'APP_CRASHED', crash: 'java.lang.UnsatisfiedLinkError: dlopen failed: libapp_dependency.so not found',
      });
      const f = fixture({ custom: true, abis: 'x86_64', bridge: '0', launchError: original });
      store.upsertApp({ package: PKG, abis: ['x86_64'] });
      const e = await rejection(() => withClock(() => f.installer.launch(PKG)));
      assert.equal(e.code, 'APP_CRASHED');
      assert.match(e.message, /不能据此断言缺少 ARM/);
      assert.equal(f.calls.start, 1);
      assert.equal(f.calls.cache, 0);
      noRetryPromise(e);
      noSwitch(f);
    });
    await test('没有原始崩溃证据时不谎称 ARM 故障/切换/重试，也不误报为启动慢', async () => {
      const original = Object.assign(new Error('会自动切换到兼容镜像后重试'), { code: 'APP_CRASHED' });
      const f = fixture({ launchError: original });
      store.upsertApp({ package: PKG, abis: ['arm64-v8a'] });
      const logs = [];
      const e = await rejection(() => f.installer.launch(PKG, { onLog: (m) => logs.push(m) }));
      assert.equal(e.code, 'APP_CRASHED');
      assert.equal(e.cause, original);
      assert.match(e.message, /证据不足/);
      assert.equal(f.calls.start, 1);
      assert.equal(f.calls.cache, 0);
      noRetryPromise(e, logs);
      noSwitch(f);
    });
    await test('普通 Java 崩溃保留原错误，仅保留原有的一次安全缓存重试，不切镜像', async () => {
      const original = Object.assign(new Error('Java crash'), { code: 'APP_CRASHED', crash: 'AndroidRuntime: java.lang.NullPointerException' });
      const f = fixture({ custom: true, abis: 'x86_64', bridge: '0', launchError: original });
      store.upsertApp({ package: PKG, abis: ['x86_64'] });
      assert.equal(await rejection(() => withClock(() => f.installer.launch(PKG))), original);
      assert.equal(f.calls.start, 2);
      assert.equal(f.calls.cache, 1);
      assert.equal(f.calls.metadata, 0);
      noSwitch(f);
    });
    await test('启动时自动补装的 ABI 失败也不泄露底层虚假重试承诺', async () => {
      const f = fixture({ installed: false, installError: Object.assign(new Error('会自动切换并重试'), { code: 'NO_MATCHING_ABIS' }) });
      store.upsertApp({ package: PKG, abis: ['arm64-v8a'], apkPath: writeApk({ abis: ['arm64-v8a'] }) });
      const logs = [];
      const e = await rejection(() => f.installer.launch(PKG, { onLog: (m) => logs.push(m) }));
      assert.equal(e.code, 'NO_MATCHING_ABIS');
      assert.equal(f.calls.install.length, 1);
      assert.equal(f.calls.start, 0);
      noRetryPromise(e, logs);
      noSwitch(f);
    });
    await test('启动时补装拆分包使用 installMultiple 并在退出后清理临时文件', async () => {
      const f = fixture({ installed: false });
      store.upsertApp({ package: PKG, abis: ['x86_64'], apkPath: writeBundle({ abis: ['x86_64'] }), bundle: true });
      const result = await withClock(() => f.installer.launch(PKG));
      assert.equal(result.ok, true);
      assert.equal(f.calls.install.length, 0);
      assert.equal(f.calls.multiple.length, 1);
      assert(f.calls.multiple[0].every((p) => !fs.existsSync(p)));
      noSwitch(f);
    });
    await test('安全哨兵：全套用例未尝试真实 ADB/模拟器/进程/网络', () => assert.deepEqual(forbidden, []));
  } finally {
    for (const restore of restores.reverse()) restore();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed (temp/mock only)`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });

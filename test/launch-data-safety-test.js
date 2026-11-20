'use strict';
// 纯离线启动回归：fake client + 虚拟时钟，绝不连接真实 Android 或读写用户数据。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-launch-data-safety-'));
process.env.APPDATA = path.join(ROOT, 'appdata');
process.env.XDG_DATA_HOME = path.join(ROOT, 'xdgdata');
const { Installer } = require('../src/core/installer');
const PKG = 'com.example.launchsafety';
let passed = 0;

async function test(name, mode, check) {
  const originalNow = Date.now;
  const originalTimeout = global.setTimeout;
  let clock = 1700000000000;
  Date.now = () => clock;
  global.setTimeout = (fn, ms, ...args) => {
    clock += ms;
    queueMicrotask(() => fn(...args));
    return { unref() {} };
  };
  const sentinel = path.join(ROOT, `private-data-${passed}`);
  fs.writeFileSync(sentinel, 'login-token-and-unsaved-draft');
  const commands = [];
  const logs = [];
  let starts = 0;
  let probes = 0;
  let touches = 0;
  const client = {
    async shell(cmd) {
      commands.push(cmd);
      if (/^pm clear\b/.test(cmd)) { fs.unlinkSync(sentinel); return 'Success'; }
      if (cmd.startsWith('pidof ')) {
        probes++;
        if (mode === 'slow') return '';
        if (mode === 'stable') return '12345';
        return probes % 2 ? '12345' : '';
      }
      throw new Error('Unexpected fake command: ' + cmd);
    },
    async startApp() { starts++; },
    async grantRuntimePermissions() {},
    async forceStop() {},
    async dismissPermissionDialog() {},
    async clearCache() { throw new Error('非崩溃证据路径不应清缓存'); },
  };
  const runtime = { async ensure() { return { ok: true, engine: 'fake', client }; }, touch() { touches++; } };
  const installer = new Installer(runtime, { desktopDir: ROOT });
  let error;
  let result;
  try {
    try { result = await installer.launch(PKG, { onLog: message => logs.push(message) }); }
    catch (e) { error = e; }
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'login-token-and-unsaved-draft', '普通启动不能删除应用私有数据');
    assert(!commands.some(cmd => /^pm clear\b/.test(cmd)), '不能下发 pm clear（即使执行失败也不行）');
    assert(!logs.some(message => /重置应用数据|清空应用数据/.test(message)), '进度文案不能承诺未经授权的数据重置');
    await check({ error, result, starts, probes, touches });
    passed++;
    console.log('  PASS ' + name);
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalTimeout;
  }
}

(async () => {
  await test('反复进程退出：三次重试后 APP_UNSTABLE，保留登录和草稿', 'unstable', ({ error, starts, touches }) => {
    assert(error);
    assert.strictEqual(error.code, 'APP_UNSTABLE');
    assert(/已保留应用数据/.test(error.message));
    assert(!/已.*重置/.test(error.message));
    assert.strictEqual(starts, 3, '不能清数据后偷偷进行第四次启动');
    assert.strictEqual(touches, 0);
  });
  await test('从未出现进程：APP_SLOW 且保留数据、不伪装启动成功', 'slow', ({ error, starts, touches }) => {
    assert(error);
    assert.strictEqual(error.code, 'APP_SLOW');
    assert(/已保留应用数据/.test(error.message));
    assert.strictEqual(starts, 3);
    assert.strictEqual(touches, 0);
  });
  await test('持续存活的进程仍正常启动，只执行一次 start', 'stable', ({ error, result, starts, touches }) => {
    assert.ifError(error);
    assert.deepStrictEqual(result, { ok: true, engine: 'fake' });
    assert.strictEqual(starts, 1);
    assert.strictEqual(touches, 1);
  });
  let cancelled = false;
  const installer = new Installer({ ensure: async () => {
    cancelled = true;
    return { ok: true, engine: 'fake', client: new Proxy({}, { get: () => assert.fail('退出后不得再访问客机') }) };
  } }, { desktopDir: ROOT });
  await assert.rejects(installer.launch(PKG, { shouldCancel: () => cancelled }), { code: 'LAUNCH_CANCELLED' });
  passed++;
  console.log('  PASS 退出期间迟到的运行时就绪不能触发应用启动');
  console.log(`启动数据安全回归：${passed} 通过，0 失败`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(ROOT, { recursive: true, force: true }));

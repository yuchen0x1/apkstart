'use strict';
/**
 * 备份 / 恢复测试
 *
 * 用真实的临时目录 + 真实的 APK 文件字节，配合假的 adb 客户端，
 * 验证：目录与命名、meta 完整性、能否导出数据的分支、恢复时下发的命令。
 * 说明：设备端的 run-as / tar 行为需要真实运行时，属于未覆盖部分（报告里已标注）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const backup = require('../src/core/backup');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-backup-'));
let seq = 0;

function mkApp(overrides = {}) {
  seq += 1;
  const apkPath = path.join(ROOT, `cache-${seq}`, 'base.apk');
  fs.mkdirSync(path.dirname(apkPath), { recursive: true });
  fs.writeFileSync(apkPath, Buffer.from('PK\u0003\u0004fake-apk-bytes'));
  return {
    package: 'com.example.demo',
    label: '示例 应用',
    versionName: '1.2.3',
    versionCode: 7,
    apkPath,
    ...overrides,
  };
}

/** falsy=true 表示设备不支持 run-as（普通应用） */
function mkdClient({ debuggable = false, dataBytes = 4096 } = {}) {
  const calls = [];
  return {
    calls,
    async shell(cmd) {
      calls.push(`shell:${cmd}`);
      if (/run-as .* id$/.test(cmd)) {
        if (!debuggable) throw new Error('run-as: package not debuggable');
        return 'uid=10123(u0_a123) gid=10123(u0_a123)';
      }
      return '';
    },
    async exec(args) {
      calls.push(`exec:${args.join(' ')}`);
      if (args[0] === 'exec-out' && /tar -cf/.test(args[1])) {
        return { stdout: Buffer.alloc(dataBytes, 7) };
      }
      return { stdout: Buffer.alloc(0) };
    },
    async push(local, remote) { calls.push(`push:${local}->${remote}`); },
  };
}

function mkInstaller() {
  const seen = [];
  return {
    seen,
    async install(file, onProgress) {
      seen.push(file);
      if (onProgress) onProgress({ stage: 'parse', message: '正在解析…' });
      return { app: { package: 'com.example.demo', label: '示例 应用' } };
    },
  };
}

(async () => {
  console.log('\n[backup.js 命名与清洗]');

  await test('文件名清洗：非法字符替换、中文保留、长度截断', () => {
    eq(backup.sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    eq(backup.sanitizeName('报告 2026'), '报告 2026');
    eq(backup.sanitizeName('   '), 'app');
    eq(backup.sanitizeName('x'.repeat(100), 10).length, 10);
    eq(backup.sanitizeName('..hidden'), 'hidden', '开头的点要去掉，避免生成隐藏目录');
  });

  await test('备份文件夹名：应用名-版本-时间戳', () => {
    const d = new Date(2026, 10, 15, 3, 30, 12);
    eq(backup.folderName({ label: '示例 应用', versionName: '1.2.3' }, d), '示例 应用-1.2.3-20261115-033012');
    assert(/^X-1\.0-\d{8}-\d{6}$/.test(backup.folderName({ label: 'X' }, d)), '缺版本时用 1.0');
  });

  console.log('\n[backup.js 备份]');

  await test('没有设备客户端：只备份 APK，并写明数据未包含', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out1');
    fs.mkdirSync(dir, { recursive: true });
    const r = await backup.backupApp({ app, client: null, dir });
    assert(fs.existsSync(path.join(r.folder, 'app.apk')), 'APK 应被复制');
    const meta = backup.readMeta(r.folder);
    eq(meta.package, app.package);
    eq(meta.versionName, '1.2.3');
    eq(meta.data, null);
    eq(r.dataIncluded, false);
    assert(fs.existsSync(path.join(r.folder, 'meta.json')));
  });

  await test('★ 普通应用（不可 run-as）：不生成假数据，写出原因', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out2');
    fs.mkdirSync(dir, { recursive: true });
    const client = mkdClient({ debuggable: false });
    const r = await backup.backupApp({ app, client, dir });
    eq(r.dataIncluded, false);
    assert(!fs.existsSync(path.join(r.folder, 'data.tar')), '不能凭空造一个 data.tar');
    assert(fs.existsSync(path.join(r.folder, 'data-skip.txt')), '应写明为什么没导出');
    assert(/debuggable/.test(r.dataNote), r.dataNote);
  });

  await test('★ debuggable 应用：导出 data.tar 并记录在 meta 里', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out3');
    fs.mkdirSync(dir, { recursive: true });
    const client = mkdClient({ debuggable: true });
    const r = await backup.backupApp({ app, client, dir });
    eq(r.dataIncluded, true);
    const tar = path.join(r.folder, 'data.tar');
    eq(fs.statSync(tar).size, 4096);
    const meta = backup.readMeta(r.folder);
    eq(meta.data, 'data.tar');
    assert(client.calls.some((c) => /run-as 'com\.example\.demo' tar -cf -/.test(c)), client.calls.join('\n'));
  });

  await test('应用数据为空（只有 tar 结束块）时明确记为失败，不冒充成功', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out4');
    fs.mkdirSync(dir, { recursive: true });
    const client = mkdClient({ debuggable: true, dataBytes: 1024 });
    const r = await backup.backupApp({ app, client, dir });
    eq(r.dataIncluded, false);
    assert(/空/.test(r.dataNote), r.dataNote);
  });

  await test('找不到 APK 时给出可理解的错误', async () => {
    const app = mkApp({ apkPath: path.join(ROOT, 'nope.apk') });
    let err = null;
    try { await backup.backupApp({ app, client: null, dir: ROOT }); } catch (e) { err = e; }
    assert(err && /安装包/.test(err.message), err && err.message);
  });

  console.log('\n[backup.js 恢复]');

  await test('只有 APK 的备份：装回去，并说明数据没恢复', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out5');
    fs.mkdirSync(dir, { recursive: true });
    const r0 = await backup.backupApp({ app, client: null, dir });
    const installer = mkInstaller();
    const r = await backup.restoreApp({ dir: r0.folder, installer, client: mkdClient() });
    eq(installer.seen.length, 1, '应调用一次安装');
    eq(r.dataRestored, false);
    assert(/只包含 APK/.test(r.note), r.note);
  });

  await test('★ 带数据的备份：push 到设备 → run-as tar 解包 → 清理临时文件', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out6');
    fs.mkdirSync(dir, { recursive: true });
    const client = mkdClient({ debuggable: true });
    const r0 = await backup.backupApp({ app, client, dir });

    const installer = mkInstaller();
    const c2 = mkdClient({ debuggable: true });
    const r = await backup.restoreApp({ dir: r0.folder, installer, client: c2 });
    eq(r.dataRestored, true);
    assert(c2.calls.some((c) => c.startsWith('push:')), '应把 data.tar 推到设备');
    const pipeline = c2.calls.find((c) => /cat .*apkstart-restore.* \| run-as 'com\.example\.demo' tar -xf -/.test(c));
    assert(pipeline, `应下发 run-as 解包命令，实际：\n${c2.calls.join('\n')}`);
    assert(c2.calls.some((c) => /rm -f/.test(c)), '临时 tar 必须清理');
  });

  await test('★ 备份里有数据但目标应用已不可 run-as：不硬来，如实说明', async () => {
    const app = mkApp();
    const dir = path.join(ROOT, 'out7');
    fs.mkdirSync(dir, { recursive: true });
    const r0 = await backup.backupApp({ app, client: mkdClient({ debuggable: true }), dir });
    const r = await backup.restoreApp({ dir: r0.folder, installer: mkInstaller(), client: mkdClient({ debuggable: false }) });
    eq(r.dataRestored, false);
    assert(/debuggable/.test(r.note), r.note);
  });

  await test('目录不是备份目录时给出明确错误', async () => {
    const empty = path.join(ROOT, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    let err = null;
    try { backup.readMeta(empty); } catch (e) { err = e; }
    assert(err && /meta\.json/.test(err.message), err && err.message);
  });

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n备份恢复测试结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();

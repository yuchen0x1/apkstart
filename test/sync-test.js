'use strict';
/**
 * 共享目录双向同步的端到端测试。
 *
 * 用一个「假 adb 客户端」把 Android 侧目录映射成临时目录，并实现 sharer 真正用到的
 * 那几条 shell 命令（mkdir / find+stat / sha256sum / mv / rm / stat -c %s）。
 * 这样测的是真实代码路径（含哈希、临时文件、原子替换、冲突副本），不是 mock 出来的假逻辑。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Sharer, planSync, conflictName, normalizeRel } = require('../src/core/sharer');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`);
  }
}

async function testAsync(name, fn) {
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

const { FakeAdb, makeEnv, writeStable, walkFiles } = require('./lib/fake-adb');

const readLocal = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** 建一套「Windows 目录 + Android 目录 + Sharer」的测试环境 */
function setup() {
  const env = makeEnv('apkstart-sync-');
  const sharer = new Sharer({ client: () => env.fake }, {
    dataDir: env.dataDir,
    settings: () => ({ sharedDir: env.localDir, deviceSharedDir: env.remoteDir }),
  });
  return { ...env, sharer };
}

const writeFile = writeStable;


async function main() {
  console.log('\n[sharer.js 纯逻辑]');
  test('冲突副本命名保留扩展名与目录', () => {
    const n = conflictName('sub/报告 2026.docx', 'Android', new Date(2026, 10, 15, 3, 15, 0));
    assert(n.startsWith('sub/报告 2026 (Android 冲突 2026-11-15 031500)'), n);
    assert(n.endsWith('.docx'), n);
  });

  test('planSync：Android 改过、Windows 没改 → 必须拉回（旧 bug 回归）', () => {
    const state = {
      'a.txt': {
        baseHash: 'H1', localHash: 'H1', remoteHash: 'H1', localKey: '3:1', remoteKey: '3:1:1', migrated: false,
      },
    };
    const local = [{ rel: 'a.txt', size: 3, mtime: 1000, hash: 'H1', key: '3:1000' }];
    const remote = [{ rel: 'a.txt', size: 3, mtime: 5000, hash: 'H2', key: '3:5:5' }];
    const plan = planSync({ local, remote, state });
    eq(plan.pull.length, 1, '应当拉取 1 个文件');
    eq(plan.push.length, 0, '不应推送');
    eq(plan.conflicts.length, 0, '不应判冲突');
  });

  test('planSync：只有 Windows 改过 → 推送', () => {
    const state = { 'b.txt': { baseHash: 'H1', localHash: 'H1', remoteHash: 'H1' } };
    const local = [{ rel: 'b.txt', size: 3, mtime: 2000, hash: 'H2', key: '3:2000' }];
    const remote = [{ rel: 'b.txt', size: 3, mtime: 1000, hash: 'H1', key: '3:1:1' }];
    const plan = planSync({ local, remote, state });
    eq(plan.push.length, 1);
    eq(plan.pull.length, 0);
  });

  test('planSync：两侧都改且内容不同 → 冲突（不静默覆盖）', () => {
    const state = { 'c.txt': { baseHash: 'H0', localHash: 'H0', remoteHash: 'H0' } };
    const local = [{ rel: 'c.txt', size: 3, mtime: 2000, hash: 'HA', key: '3:2000' }];
    const remote = [{ rel: 'c.txt', size: 3, mtime: 3000, hash: 'HB', key: '3:3:3' }];
    const plan = planSync({ local, remote, state });
    eq(plan.conflicts.length, 1);
    eq(plan.push.length, 0);
    eq(plan.pull.length, 0);
    assert(plan.state['c.txt'].conflict, '状态应标记 conflict');
  });

  test('planSync：冲突后用户改了 Windows 侧 → 以 Windows 为准推送', () => {
    const state = { 'd.txt': { conflict: true, localHash: 'HA', remoteHash: 'HB' } };
    const local = [{ rel: 'd.txt', size: 3, mtime: 9000, hash: 'HC', key: '3:9000' }];
    const remote = [{ rel: 'd.txt', size: 3, mtime: 3000, hash: 'HB', key: '3:3:3' }];
    const plan = planSync({ local, remote, state });
    eq(plan.push.length, 1, '应推送用户的新版本');
    eq(plan.conflicts.length, 0);
  });

  test('planSync：两侧内容相同（大小也相同）→ 视为已同步，不传输', () => {
    const state = { 'e.txt': { baseHash: 'H1', localHash: 'H1', remoteHash: 'H1' } };
    const local = [{ rel: 'e.txt', size: 3, mtime: 1000, hash: 'H2', key: '3:1000' }];
    const remote = [{ rel: 'e.txt', size: 3, mtime: 7000, hash: 'H2', key: '3:7:7' }];
    const plan = planSync({ local, remote, state });
    eq(plan.push.length, 0);
    eq(plan.pull.length, 0);
    eq(plan.conflicts.length, 0);
  });

  test('planSync：Android 删除、Windows 未改 → 默认不删本地，只报告', () => {
    const state = { 'f.txt': { baseHash: 'H1', localHash: 'H1', remoteHash: 'H1' } };
    const local = [{ rel: 'f.txt', size: 3, mtime: 1000, hash: 'H1', key: '3:1000' }];
    const plan = planSync({ local, remote: [], state, deletes: false });
    eq(plan.pendingDeletes.length, 1);
    eq(plan.deletions.length, 0);
  });

  test('planSync：Android 删除、Windows 改过 → 从 Windows 恢复回去（不丢新改动）', () => {
    const state = { 'g.txt': { baseHash: 'H1', localHash: 'H1', remoteHash: 'H1' } };
    const local = [{ rel: 'g.txt', size: 4, mtime: 2000, hash: 'H2', key: '4:2000' }];
    const plan = planSync({ local, remote: [], state });
    eq(plan.push.length, 1);
  });

  test('旧版状态结构可迁移，不丢历史记录', () => {
    const { migrateState } = require('../src/core/sharer');
    const s = migrateState({ 'x/y.txt': { size: 10, lmtime: 111, rmtime: 222, dir: 'up' } });
    assert(s['x/y.txt'].migrated, '应标记 migrated');
    eq(s['x/y.txt'].baseHash, '', 'baseHash 置空（交给哈希判定）');
  });

  console.log('\n[sharer.js 端到端：Windows ↔ Android]');

  await testAsync('Windows 新建文件 → Android 收到', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'hello.txt'), 'hello android');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, `不应有错误：${r.errors.join('; ')}`);
    eq(readLocal(t.remoteDir, 'hello.txt'), 'hello android');
    eq(r.pushed, 1);
  });

  await testAsync('第二轮幂等：没有变化就不传输', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'hello.txt'), 'hello');
    await t.sharer.sync();
    const before = t.fake.pushCount + t.fake.pullCount;
    const r = await t.sharer.sync();
    eq(t.fake.pushCount + t.fake.pullCount, before, '不应新增传输');
    eq(r.pushed + r.pulled, 0);
  });

  await testAsync('★ 回归：Windows 上传过的文件，Android 改内容（大小不变）必须同步回来', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'note.txt'), 'AAAA');
    await t.sharer.sync();
    eq(readLocal(t.remoteDir, 'note.txt'), 'AAAA');
    // Android 侧改成同样长度的内容（旧实现会永远跳过）
    writeFile(path.join(t.remoteDir, 'note.txt'), 'BBBB');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, r.errors.join('; '));
    eq(readLocal(t.localDir, 'note.txt'), 'BBBB', '本机应拿到 Android 的修改');
    eq(r.pulled, 1);
  });

  await testAsync('★ Android 修改后，Windows 的旧版本不会被再次推回去（无回弹）', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'n2.txt'), 'AAAA');
    await t.sharer.sync();
    writeFile(path.join(t.remoteDir, 'n2.txt'), 'BBBB');
    await t.sharer.sync();
    const r2 = await t.sharer.sync();
    eq(r2.pushed, 0);
    eq(readLocal(t.remoteDir, 'n2.txt'), 'BBBB');
  });

  await testAsync('★ 两侧同时修改 → 保留两份，生成冲突副本，绝不静默覆盖', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'doc.txt'), 'base');
    await t.sharer.sync();
    writeFile(path.join(t.localDir, 'doc.txt'), 'windows-edit');
    writeFile(path.join(t.remoteDir, 'doc.txt'), 'android-edit');
    const r = await t.sharer.sync();
    eq(r.conflicts, 1, '应记录 1 个冲突');
    eq(readLocal(t.localDir, 'doc.txt'), 'windows-edit', '本机文件保持本机版本');
    eq(readLocal(t.remoteDir, 'doc.txt'), 'android-edit', 'Android 文件保持 Android 版本');
    const copies = fs.readdirSync(t.localDir).filter((n) => n.includes('冲突'));
    eq(copies.length, 1, '应生成 1 个冲突副本');
    eq(readLocal(t.localDir, copies[0]), 'android-edit', '副本内容是 Android 版本');
    const remoteCopies = fs.readdirSync(t.remoteDir).filter((n) => n.includes('冲突'));
    eq(remoteCopies.length, 1, '冲突副本也应同步到 Android');
  });

  await testAsync('冲突未处理时反复同步不会重复生成副本', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'c.txt'), 'base');
    await t.sharer.sync();
    writeFile(path.join(t.localDir, 'c.txt'), 'win');
    writeFile(path.join(t.remoteDir, 'c.txt'), 'and');
    await t.sharer.sync();
    await t.sharer.sync();
    await t.sharer.sync();
    const copies = fs.readdirSync(t.localDir).filter((n) => n.includes('冲突'));
    eq(copies.length, 1, `副本应只有 1 个，实际 ${copies.length}`);
  });

  await testAsync('Android → Windows 新建文件被拉回', async () => {
    const t = setup();
    writeFile(path.join(t.remoteDir, 'from-android.txt'), 'hi windows');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, r.errors.join('; '));
    eq(readLocal(t.localDir, 'from-android.txt'), 'hi windows');
  });

  await testAsync('中文 + 空格 + 特殊字符文件名', async () => {
    const t = setup();
    const name = '我的 报告 (最终版) & 副本.txt';
    writeFile(path.join(t.localDir, name), '中文内容');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, r.errors.join('; '));
    eq(readLocal(t.remoteDir, name), '中文内容');
    writeFile(path.join(t.remoteDir, name), '安卓改过');
    await t.sharer.sync();
    eq(readLocal(t.localDir, name), '安卓改过');
  });

  await testAsync('子目录与深层路径', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'a/b/c/deep.txt'), 'deep');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, r.errors.join('; '));
    eq(readLocal(t.remoteDir, 'a/b/c/deep.txt'), 'deep');
  });

  await testAsync('删除同步默认关闭：Android 删除不会删掉本机文件', async () => {
    const t = setup();
    writeFile(path.join(t.localDir, 'keep.txt'), 'important');
    await t.sharer.sync();
    fs.rmSync(path.join(t.remoteDir, 'keep.txt'));
    const r = await t.sharer.sync();
    assert(fs.existsSync(path.join(t.localDir, 'keep.txt')), '本机文件必须保留');
    eq(r.pendingDeletes, 1);
  });

  await testAsync('删除同步开启：移进回收目录而不是硬删除', async () => {
    const t = setup();
    const sharer = new Sharer({ client: () => t.fake }, {
      dataDir: t.dataDir,
      settings: () => ({ sharedDir: t.localDir, deviceSharedDir: t.remoteDir, sharedSyncDeletes: true }),
    });
    writeFile(path.join(t.localDir, 'trash-me.txt'), 'bye');
    await sharer.sync();
    fs.rmSync(path.join(t.remoteDir, 'trash-me.txt'));
    await sharer.sync();
    assert(!fs.existsSync(path.join(t.localDir, 'trash-me.txt')), '原位置应已移除');
    const trashRoot = path.join(t.localDir, '.apkstart-trash');
    assert(fs.existsSync(trashRoot), '应创建回收目录');
    const found = walkFiles(trashRoot).length;
    eq(found, 1, '回收目录里应有 1 个文件');
  });

  await testAsync('设备不支持 stat 时退回 ls 兜底仍能同步', async () => {
    const t = setup();
    t.fake.supportsStat = false;
    writeFile(path.join(t.remoteDir, 'fallback.txt'), 'via ls');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, r.errors.join('; '));
    eq(readLocal(t.localDir, 'fallback.txt'), 'via ls');
  });

  await testAsync('设备没有 sha256sum：不崩溃，仍能完成基本同步', async () => {
    const t = setup();
    t.fake.supportsSha = false;
    writeFile(path.join(t.localDir, 'nosha.txt'), 'aaa');
    const r = await t.sharer.sync();
    eq(r.errors.length, 0, r.errors.join('; '));
    eq(readLocal(t.remoteDir, 'nosha.txt'), 'aaa');
  });

  await testAsync('中断/半截文件：已同步过的文件刚被改写时，本轮先跳过', async () => {
    const t = setup();
    const f = path.join(t.localDir, 'writing.bin');
    writeFile(f, 'v1');
    await t.sharer.sync();                       // 第一轮：正常推上去
    eq(readLocal(t.remoteDir, 'writing.bin'), 'v1', '首轮应推送成功');

    // 模拟「程序正在写这个文件」：内容变了、mtime 就是现在
    fs.writeFileSync(f, 'v2-being-written');
    const r = await t.sharer.sync();
    eq(r.pushed, 0, '刚被改写、可能还在写的文件不应被推送');
    eq(readLocal(t.remoteDir, 'writing.bin'), 'v1', '设备端不能出现半截内容');

    // 等它稳定下来（把 mtime 推回 3 秒前代表写完了），下一轮必须补上
    const old = new Date(Date.now() - 3000);
    fs.utimesSync(f, old, old);
    const r2 = await t.sharer.sync();
    eq(r2.pushed, 1, '文件稳定后应当补同步');
    eq(readLocal(t.remoteDir, 'writing.bin'), 'v2-being-written', '最终内容必须一致');
  });

  await testAsync('新建文件第一轮就会同步（不需要空转一轮）', async () => {
    const t = setup();
    // 刚写进去、mtime 就是现在：从没见过的新文件不该被当成「还在写」
    fs.writeFileSync(path.join(t.localDir, 'brand-new.txt'), 'hello');
    const r = await t.sharer.sync();
    eq(r.pushed, 1, '新文件应当第一轮就推送');
    eq(readLocal(t.remoteDir, 'brand-new.txt'), 'hello');
  });

  await testAsync('远端列表同时兼容两种 stat 输出格式', async () => {
    const t = setup();
    const fake = {
      shell: async (cmd) => (cmd.includes('stat')
        ? '1700000000|1700000001|5|./a.txt\n7|1700000002|./sub/b.txt\n'
        : ''),
      listRemote: async () => [],
    };
    const rows = await t.sharer.listRemoteRecursive(fake, '/sdcard/x');
    eq(rows.length, 2, `应解析 2 条，实际 ${JSON.stringify(rows)}`);
    eq(rows[0].rel, 'a.txt');
    eq(rows[0].size, 5);
    eq(rows[1].rel, 'sub/b.txt', '老格式 size|mtime|name 也要能解析');
    eq(rows[1].size, 7);
    assert(rows[1].mtime > 1e12, 'mtime 必须换算成毫秒');
  });

  await testAsync('运行时未连接：返回明确错误而不是抛异常', async () => {
    const t = setup();
    const offline = { client: () => ({ isOnline: async () => false }) };
    const s = new Sharer(offline, {
      dataDir: t.dataDir,
      settings: () => ({ sharedDir: t.localDir, deviceSharedDir: t.remoteDir }),
    });
    const r = await s.sync();
    assert(r.error && /未连接/.test(r.error), `应带 error，实际 ${JSON.stringify(r)}`);
  });

  console.log(`\n同步测试结果：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

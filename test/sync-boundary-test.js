'use strict';
// 只使用临时目录与 fakeADB；不连接设备，也不读取用户共享目录。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Sharer } = require('../src/core/sharer');
const { makeEnv, writeStable, walkFiles } = require('./lib/fake-adb');

let passed = 0;
async function test(name, fn) {
  const t = makeEnv('apkstart-sync-boundary-');
  t.outside = path.join(t.root, 'outside');
  fs.mkdirSync(t.outside);
  writeStable(path.join(t.outside, 'sentinel.txt'), 'OUTSIDE-UNCHANGED');
  let settings = { sharedDir: t.localDir, deviceSharedDir: t.remoteDir, sharedSyncDeletes: true };
  t.settings = (patch) => { settings = { ...settings, ...patch }; };
  t.sharer = new Sharer({ client: () => t.fake }, { dataDir: t.dataDir, settings: () => settings });
  try {
    await fn(t);
    assert.strictEqual(fs.readFileSync(path.join(t.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE-UNCHANGED');
    assert.deepStrictEqual(walkFiles(t.outside).map((f) => f.rel), ['sentinel.txt'], '根外不能落临时文件或冲突副本');
    passed++;
    console.log('  PASS ' + name);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
}
const junction = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const denied = (r) => assert(r.error || r.errors.length, '应报告边界错误');

(async () => {
  await test('stat 列表拒绝遍历、绝对路径、Windows 别名和反斜杠；正常文件仍同步', async (t) => {
    const bad = [
      '../outside/sentinel.txt', 'a/../../outside/sentinel.txt', '/absolute.txt', '//server/share/file',
      'C:/outside.txt', 'C:outside.txt', '\\outside.txt', '\\\\?\\C:\\outside.txt', 'a\\..\\outside.txt',
      'a/./file.txt', 'a//file.txt', 'a/../file.txt', 'NUL.txt', 'con', 'COM1.txt', 'LPT¹.txt',
      'con .txt', 'file.txt:stream', 'dir./file.txt', 'dir /file.txt', 'sentinel.txt ', 'sentinel.txt.',
      'wild*.txt', 'bad\x00.txt', '././bad.txt',
    ];
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async (cmd) => cmd.includes("find . -type f -exec stat")
      ? [...bad, './正常 (a).txt'].map((name) => `1700000000|1700000001|4|${name}|:end:`).join('\n')
      : shell(cmd);
    t.fake.pull = async (_remote, local) => { t.fake.pullCount++; fs.writeFileSync(local, 'SAFE'); };
    const r = await t.sharer.sync();
    assert.strictEqual(r.pulled, 1, JSON.stringify(r));
    assert.strictEqual(t.fake.pullCount, 1);
    assert.strictEqual(fs.readFileSync(path.join(t.localDir, '正常 (a).txt'), 'utf8'), 'SAFE');
    const rows = await t.sharer.listRemote(t.fake);
    assert.deepStrictEqual(rows.map((row) => row.rel), ['正常 (a).txt']);
  });
  await test('ls fallback 在递归前拒绝恶意目录名', async (t) => {
    const visited = [];
    t.fake.listRemote = async (dir) => {
      visited.push(dir);
      return [
        { name: '../outside', isDir: true }, { name: '/abs', isDir: true },
        { name: 'a\\b', isDir: true }, { name: 'dir.', isDir: true }, { name: '$(touch x)', isDir: true },
        { name: 'ok.txt', size: 4 }, { name: 'NUL', size: 4 }, { name: 'x:ads', size: 4 },
      ];
    };
    const rows = await t.sharer.listRemoteFallback(t.fake);
    assert.deepStrictEqual(visited, [t.remoteDir]);
    assert.deepStrictEqual(rows.map((r) => r.rel), ['ok.txt']);
  });
  await test('目标 parent junction：mkdir 和 ADB pull 前拒绝，不写根外', async (t) => {
    junction(t.outside, path.join(t.localDir, 'escape'));
    writeStable(path.join(t.remoteDir, 'escape/new/deep.txt'), 'guest');
    const r = await t.sharer.sync();
    denied(r);
    assert.strictEqual(t.fake.pullCount, 0);
    assert(!fs.existsSync(path.join(t.outside, 'new')));
  });
  await test('宿主根本身是 junction 时整轮拒绝', async (t) => {
    fs.rmdirSync(t.localDir);
    junction(t.outside, t.localDir);
    writeStable(path.join(t.remoteDir, 'sentinel.txt'), 'guest');
    const r = await t.sharer.sync();
    denied(r);
    assert.strictEqual(t.fake.pullCount + t.fake.pushCount, 0);
    assert.strictEqual(t.fake.commands.length, 0, '根验证失败前不发设备写操作');
  });
  await test('列表后替换宿主根为 junction：执行时再次拒绝', async (t) => {
    writeStable(path.join(t.remoteDir, 'sentinel.txt'), 'guest');
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async (cmd) => {
      const out = await shell(cmd);
      if (cmd.includes('&& sha256sum --')) {
        fs.renameSync(t.localDir, t.localDir + '-original');
        junction(t.outside, t.localDir);
      }
      return out;
    };
    denied(await t.sharer.sync());
    assert.strictEqual(t.fake.pullCount, 0);
  });
  await test('pull 期间把目标父目录替换成 junction：只写独立暂存区，rename 被拒绝', async (t) => {
    writeStable(path.join(t.remoteDir, 'parent/new/deep.txt'), 'guest');
    const pull = t.fake.pull.bind(t.fake);
    t.fake.pull = async (remote, local) => {
      assert(path.dirname(local).startsWith(path.join(t.localDir, '.apkstart-pull-')));
      junction(t.outside, path.join(t.localDir, 'parent'));
      await pull(remote, local);
    };
    denied(await t.sharer.sync());
    assert(!fs.existsSync(path.join(t.outside, 'new')));
    assert(!fs.readdirSync(t.localDir).some((name) => name.startsWith('.apkstart-pull-')), '清理已验证的暂存区');
  });
  await test('push 的 adb mkdir 等待后父目录被替换：不能读取根外文件', async (t) => {
    writeStable(path.join(t.localDir, 'parent/sentinel.txt'), 'local');
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async (cmd) => {
      if (cmd.startsWith('mkdir -p ') && cmd.includes('parent')) {
        fs.renameSync(path.join(t.localDir, 'parent'), path.join(t.localDir, 'parent-old'));
        junction(t.outside, path.join(t.localDir, 'parent'));
      }
      return shell(cmd);
    };
    denied(await t.sharer.sync());
    assert.strictEqual(t.fake.pushCount, 0);
  });
  await test('删除同步拒绝回收目录 junction，保留本机原件', async (t) => {
    writeStable(path.join(t.localDir, 'keep.txt'), 'keep');
    await t.sharer.sync();
    fs.unlinkSync(path.join(t.remoteDir, 'keep.txt'));
    junction(t.outside, path.join(t.localDir, '.apkstart-trash'));
    denied(await t.sharer.sync());
    assert.strictEqual(fs.readFileSync(path.join(t.localDir, 'keep.txt'), 'utf8'), 'keep');
  });
  await test('冲突副本在列表后遇到父目录 junction 时不能落到根外', async (t) => {
    writeStable(path.join(t.localDir, 'parent/doc.txt'), 'local');
    writeStable(path.join(t.remoteDir, 'parent/doc.txt'), 'guest');
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async (cmd) => {
      const out = await shell(cmd);
      if (cmd.includes('&& sha256sum --')) {
        fs.renameSync(path.join(t.localDir, 'parent'), path.join(t.localDir, 'parent-old'));
        junction(t.outside, path.join(t.localDir, 'parent'));
      }
      return out;
    };
    denied(await t.sharer.sync());
    assert.strictEqual(t.fake.pullCount + t.fake.pushCount, 0);
  });
  await test('已有宿主 hardlink 拒绝读取/覆盖；不把根外内容上传', async (t) => {
    fs.linkSync(path.join(t.outside, 'sentinel.txt'), path.join(t.localDir, 'link.txt'));
    writeStable(path.join(t.remoteDir, 'link.txt'), 'guest');
    denied(await t.sharer.sync());
    assert.strictEqual(t.fake.pullCount + t.fake.pushCount, 0);
  });
  await test('异步期间设置变化不重定向本轮宿主根', async (t) => {
    writeStable(path.join(t.remoteDir, 'new/sub.txt'), 'guest');
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async (cmd) => {
      const out = await shell(cmd);
      if (cmd.includes('&& sha256sum --')) t.settings({ sharedDir: t.outside });
      return out;
    };
    const r = await t.sharer.sync();
    assert.strictEqual(r.pulled, 1, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.localDir, 'new/sub.txt'), 'utf8'), 'guest');
  });
  await test('推送同长损坏暂存文件：替换前拒绝，设备原件与同步基线保留', async (t) => {
    const local = path.join(t.localDir, 'keep.txt');
    const remote = path.join(t.remoteDir, 'keep.txt');
    writeStable(local, 'BASE');
    await t.sharer.sync();
    const before = t.sharer.loadState()['keep.txt'];
    writeStable(local, 'NEXT');
    const push = t.fake.push.bind(t.fake);
    t.fake.push = async (src, dst) => { await push(src, dst); fs.writeFileSync(dst, 'BAD!'); };
    const r = await t.sharer.sync();
    denied(r);
    assert.strictEqual(r.pushed, 0);
    assert.strictEqual(fs.readFileSync(remote, 'utf8'), 'BASE');
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'NEXT');
    assert.deepStrictEqual(t.sharer.loadState()['keep.txt'], before);
    assert(!fs.readdirSync(t.remoteDir).some(n => n.includes('apkstart-tmp')));
    const moves = t.fake.commands.filter(c => c.startsWith('mv -f '));
    assert.strictEqual(moves.length, 1, '只有首轮成功的替换');
  });
  for (const sizeReply of ['0', '', 'unknown']) {
    await test(`无哈希工具且暂存大小为 ${JSON.stringify(sizeReply)}：不能覆盖设备原件`, async (t) => {
      t.fake.supportsSha = false;
      const local = path.join(t.localDir, 'keep.txt');
      writeStable(local, 'BASE');
      await t.sharer.sync();
      writeStable(local, 'changed-length');
      // 无远端哈希时在纯推送入口覆盖校验分支；正常同步不会拿弱哈希覆盖已有版本。
      const shell = t.fake.shell.bind(t.fake);
      t.fake.shell = async cmd => cmd.startsWith("stat -c '%s'") ? sizeReply : shell(cmd);
      const { walkLocal } = require('../src/core/sharer');
      let host;
      const ensure = t.sharer.ensureDirs.bind(t.sharer);
      t.sharer.ensureDirs = async (client, boundary, remoteDir) => { host = boundary; return ensure(client, boundary, remoteDir); };
      await t.sharer.sync();
      const meta = (await walkLocal(t.localDir))[0];
      await assert.rejects(t.sharer._pushOne(t.fake, 'keep.txt', meta, { host, remoteDir: t.remoteDir }), /校验失败/);
      assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'keep.txt'), 'utf8'), 'BASE');
      assert(!fs.readdirSync(t.remoteDir).some(n => n.includes('apkstart-tmp')));
    });
  }
  await test('大文件暂存被截成零字节时必须在替换前拒绝', async (t) => {
    const local = path.join(t.localDir, 'large.bin');
    writeStable(local, Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    writeStable(path.join(t.remoteDir, 'large.bin'), 'ORIGINAL');
    const push = t.fake.push.bind(t.fake);
    t.fake.push = async (src, dst) => { await push(src, dst); fs.truncateSync(dst, 0); };
    // 新文件的两侧内容本来不同，用一个正常的同步基线明确指定本轮是本机修改。
    const { sha256 } = require('./lib/fake-adb');
    t.sharer.saveState({ 'large.bin': { baseHash: sha256(Buffer.from('ORIGINAL')) } });
    const r = await t.sharer.sync();
    denied(r);
    assert.strictEqual(r.pushed, 0);
    assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'large.bin'), 'utf8'), 'ORIGINAL');
    assert(!t.fake.commands.some(c => c.startsWith('mv -f ')));
  });
  await test('空文件暂存大小为零可以正常验证并推送', async (t) => {
    t.fake.supportsSha = false;
    writeStable(path.join(t.localDir, 'empty.txt'), '');
    const r = await t.sharer.sync();
    assert.strictEqual(r.pushed, 1, JSON.stringify(r));
    assert.strictEqual(fs.statSync(path.join(t.remoteDir, 'empty.txt')).size, 0);
  });
  await test('设备哈希工具存在但返回空值时保留原件而不是未校验替换', async (t) => {
    const local = path.join(t.localDir, 'keep.txt');
    writeStable(local, 'BASE');
    await t.sharer.sync();
    writeStable(local, 'NEXT');
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async cmd => cmd.includes('&& sha256sum --') && cmd.includes('apkstart-tmp') ? '' : shell(cmd);
    const r = await t.sharer.sync();
    denied(r);
    assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'keep.txt'), 'utf8'), 'BASE');
  });
  await test('已知文件正在写入且允许删除同步：不得删除远端、覆盖本机或遗忘基线', async (t) => {
    const local = path.join(t.localDir, 'writing.txt');
    writeStable(local, 'BASE');
    await t.sharer.sync();
    const before = t.sharer.loadState()['writing.txt'];
    fs.writeFileSync(local, 'writing-in-progress');
    const r = await t.sharer.sync();
    assert.strictEqual(r.deleted + r.pulled + r.pushed, 0, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'writing.txt'), 'utf8'), 'BASE');
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'writing-in-progress');
    assert.deepStrictEqual(t.sharer.loadState()['writing.txt'], before);
    writeStable(local, 'FINISHED');
    const done = await t.sharer.sync();
    assert.strictEqual(done.pushed, 1, JSON.stringify(done));
  });
  await test('远端删除后，本机等长改写并恢复 mtime：重新哈希、保留本机修改并推回远端', async (t) => {
    const rel = 'same-size.txt';
    const local = path.join(t.localDir, rel);
    const remote = path.join(t.remoteDir, rel);
    fs.writeFileSync(local, 'BASE');
    // 用整秒的旧时间，保证 mtime 可精确还原，也不会触发正在写入的暂缓逻辑。
    const stamp = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(local, stamp, stamp);
    const first = await t.sharer.sync();
    assert.strictEqual(first.pushed, 1, JSON.stringify(first));
    const before = fs.statSync(local);
    const baseline = t.sharer.loadState()[rel];
    assert.strictEqual(fs.readFileSync(remote, 'utf8'), 'BASE');
    fs.unlinkSync(remote);
    // 给文件系统的 ctime 时钟留出至少一个刻度；使用真实文件系统而非模拟 stat。
    await new Promise(resolve => setTimeout(resolve, 40));
    fs.writeFileSync(local, 'EDIT');
    fs.utimesSync(local, stamp, stamp);
    const edited = fs.statSync(local);
    assert.strictEqual(edited.size, before.size);
    assert.strictEqual(edited.mtimeMs, before.mtimeMs);
    assert.notStrictEqual(edited.ctimeMs, before.ctimeMs);

    const r = await t.sharer.sync();
    assert.strictEqual(r.deleted, 0, JSON.stringify(r));
    assert.strictEqual(r.pushed, 1, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'EDIT');
    assert.strictEqual(fs.readFileSync(remote, 'utf8'), 'EDIT');
    assert(!fs.existsSync(path.join(t.localDir, '.apkstart-trash')));
    const after = t.sharer.loadState()[rel];
    assert.notStrictEqual(after.localKey, baseline.localKey, '同大小及 mtime 的修改应使缓存失效');
    assert.notStrictEqual(after.baseHash, baseline.baseHash, '重新哈希后应记录修改后的共同基线');
  });
  await test('本机哈希读取失败不传播删除、不覆盖当前文件且保留基线', async (t) => {
    const local = path.join(t.localDir, 'unreadable.txt');
    writeStable(local, 'BASE');
    await t.sharer.sync();
    const before = t.sharer.loadState()['unreadable.txt'];
    writeStable(local, 'new-content');
    const read = fs.createReadStream;
    fs.createReadStream = function(file, ...args) {
      if (file !== local) return read.call(this, file, ...args);
      const stream = new (require('stream').PassThrough)();
      process.nextTick(() => stream.destroy(new Error('simulated EACCES')));
      return stream;
    };
    let r;
    try { r = await t.sharer.sync(); } finally { fs.createReadStream = read; }
    denied(r);
    assert.strictEqual(r.deleted + r.pulled + r.pushed, 0, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'unreadable.txt'), 'utf8'), 'BASE');
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'new-content');
    assert.deepStrictEqual(t.sharer.loadState()['unreadable.txt'], before);
  });
  await test('本机子目录枚举失败不认成删除，其他完整子树仍能正常同步', async (t) => {
    writeStable(path.join(t.localDir, 'blocked/keep.txt'), 'BASE');
    await t.sharer.sync();
    const before = t.sharer.loadState()['blocked/keep.txt'];
    writeStable(path.join(t.localDir, 'healthy.txt'), 'new');
    const readdir = fs.promises.readdir;
    fs.promises.readdir = async function(dir, ...args) {
      if (dir === path.join(t.localDir, 'blocked')) throw new Error('simulated directory EACCES');
      return readdir.call(this, dir, ...args);
    };
    let r;
    try { r = await t.sharer.sync(); } finally { fs.promises.readdir = readdir; }
    assert.strictEqual(r.deleted + r.pulled, 0, JSON.stringify(r));
    assert.strictEqual(r.pushed, 1, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'blocked/keep.txt'), 'utf8'), 'BASE');
    assert.deepStrictEqual(t.sharer.loadState()['blocked/keep.txt'], before);
  });
  await test('ls 兜底列表不完整时不能把本机原件移到回收目录', async (t) => {
    writeStable(path.join(t.localDir, 'keep.txt'), 'BASE');
    await t.sharer.sync();
    t.fake.supportsStat = false;
    t.fake.listRemote = async () => [];
    const r = await t.sharer.sync();
    assert.strictEqual(r.deleted + r.pushed, 0, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.localDir, 'keep.txt'), 'utf8'), 'BASE');
  });
  await test('ls 兜底没有时间戳时必须重算哈希，不能按同长度缓存误删远端修改', async (t) => {
    t.fake.supportsStat = false;
    writeStable(path.join(t.remoteDir, 'keep.txt'), 'BASE');
    const first = await t.sharer.sync();
    assert.strictEqual(first.pulled, 1, JSON.stringify(first));
    const second = await t.sharer.sync();
    assert.strictEqual(second.deleted, 0);
    writeStable(path.join(t.remoteDir, 'keep.txt'), 'EDIT');
    fs.unlinkSync(path.join(t.localDir, 'keep.txt'));
    const r = await t.sharer.sync();
    assert.strictEqual(r.deleted, 0, JSON.stringify(r));
    assert.strictEqual(r.pulled, 1, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.remoteDir, 'keep.txt'), 'utf8'), 'EDIT');
    assert.strictEqual(fs.readFileSync(path.join(t.localDir, 'keep.txt'), 'utf8'), 'EDIT');
  });
  await test('部分 stat 列表含截断行时不能从缺失项传播删除', async (t) => {
    writeStable(path.join(t.localDir, 'keep.txt'), 'BASE');
    await t.sharer.sync();
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async cmd => cmd.includes('find . -type f -exec stat')
      ? '1700000000|1700000001|1|./other.txt|:end:\ntruncated-row' : shell(cmd);
    t.fake.pull = async (_remote, local) => fs.writeFileSync(local, 'x');
    const r = await t.sharer.sync();
    assert.strictEqual(r.deleted, 0, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(path.join(t.localDir, 'keep.txt'), 'utf8'), 'BASE');
  });
  await test('stop 在远端 push 写入暂存后取消：不 rename、不删除原件、清理暂存并可 join', async (t) => {
    const local = path.join(t.localDir, 'push-stop.txt');
    const remote = path.join(t.remoteDir, 'push-stop.txt');
    writeStable(local, 'BASE');
    await t.sharer.sync();
    const baseline = t.sharer.loadState()['push-stop.txt'];
    writeStable(local, 'EDIT');
    let releasePush;
    let announcePush;
    const pushGate = new Promise(resolve => { releasePush = resolve; });
    const pushStarted = new Promise(resolve => { announcePush = resolve; });
    const push = t.fake.push.bind(t.fake);
    t.fake.push = async (src, dst) => { await push(src, dst); announcePush(); await pushGate; };
    const beforeMoves = t.fake.commands.filter(cmd => cmd.startsWith('mv -f ')).length;
    const active = t.sharer.sync();
    await pushStarted;
    assert.strictEqual(fs.readFileSync(remote, 'utf8'), 'BASE');
    assert.strictEqual(await t.sharer.stop({ timeoutMs: 5 }), false, '未完成的 adb push 应触发有界 drain 超时');
    assert.deepStrictEqual(await t.sharer.sync(), { skipped: true, stopped: true }, 'stop 后不能启动新一轮');
    releasePush();
    const result = await active;
    assert.strictEqual(result.cancelled, true, JSON.stringify(result));
    assert.strictEqual(await t.sharer.join(100), true, '在途工作结束后 join 应完成');
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'EDIT');
    assert.strictEqual(fs.readFileSync(remote, 'utf8'), 'BASE', '取消后不得提交覆盖设备原件');
    assert.strictEqual(t.fake.commands.filter(cmd => cmd.startsWith('mv -f ')).length, beforeMoves);
    assert(!walkFiles(t.remoteDir).some(file => file.rel.includes('apkstart-tmp')), '取消后只清理本轮暂存文件');
    assert.deepStrictEqual(t.sharer.loadState()['push-stop.txt'], baseline, '取消的轮次不得发布新同步基线');
  });
  await test('stop 在设备 pull 写入本机暂存区时取消：不 rename 到目标且清理暂存目录', async (t) => {
    const remote = path.join(t.remoteDir, 'pull-stop.txt');
    writeStable(remote, 'REMOTE');
    let releasePull;
    let announcePull;
    const pullGate = new Promise(resolve => { releasePull = resolve; });
    const pullStarted = new Promise(resolve => { announcePull = resolve; });
    const pull = t.fake.pull.bind(t.fake);
    t.fake.pull = async (src, dst) => { await pull(src, dst); announcePull(); await pullGate; };
    const active = t.sharer.sync();
    await pullStarted;
    assert(!fs.existsSync(path.join(t.localDir, 'pull-stop.txt')));
    assert.strictEqual(await t.sharer.stop({ timeoutMs: 5 }), false);
    releasePull();
    const result = await active;
    assert.strictEqual(result.cancelled, true, JSON.stringify(result));
    assert.strictEqual(await t.sharer.join(100), true);
    assert(!fs.existsSync(path.join(t.localDir, 'pull-stop.txt')), '取消后不能提交本机目标文件');
    assert(!fs.readdirSync(t.localDir).some(name => name.startsWith('.apkstart-pull-')), '取消后清理本地 staging');
    assert.strictEqual(fs.readFileSync(remote, 'utf8'), 'REMOTE', '源设备文件保持不变');
  });
  await test('stop 在设备列表 I/O 期间取消待执行的本机回收 rename', async (t) => {
    const local = path.join(t.localDir, 'trash-stop.txt');
    const remote = path.join(t.remoteDir, 'trash-stop.txt');
    writeStable(local, 'BASE');
    await t.sharer.sync();
    const baseline = t.sharer.loadState()['trash-stop.txt'];
    fs.unlinkSync(remote);
    let releaseList;
    let announceList;
    const listGate = new Promise(resolve => { releaseList = resolve; });
    const listStarted = new Promise(resolve => { announceList = resolve; });
    const shell = t.fake.shell.bind(t.fake);
    t.fake.shell = async cmd => {
      const out = await shell(cmd);
      if (cmd.includes('find . -type f -exec stat')) { announceList(); await listGate; }
      return out;
    };
    const active = t.sharer.sync();
    await listStarted;
    assert.strictEqual(await t.sharer.stop({ timeoutMs: 5 }), false);
    releaseList();
    const result = await active;
    assert.strictEqual(result.cancelled, true, JSON.stringify(result));
    assert.strictEqual(await t.sharer.join(100), true);
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'BASE', '被发现的远端缺失不能在取消后回收本机原件');
    assert(!fs.existsSync(path.join(t.localDir, '.apkstart-trash')));
    assert.deepStrictEqual(t.sharer.loadState()['trash-stop.txt'], baseline);
  });
  console.log(`同步边界回归：${passed} 通过，0 失败`);
})().catch((e) => { console.error(e); process.exitCode = 1; });

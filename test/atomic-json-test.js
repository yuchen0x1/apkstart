'use strict';
/** 原子写回归：用真实文件系统 + 注入故障，验证失败不会留下半截或删掉别人的文件。 */
const assert = require('assert/strict');
const { test } = require('node:test');
const fsn = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomicSync } = require('../src/core/atomic-json');

function tmpdir() {
  return fsn.mkdtempSync(path.join(os.tmpdir(), 'apkstart-atomic-'));
}

function failing(overrides = {}) {
  return { ...fsn, ...overrides };
}

test('写入成功：内容完整替换旧文件，且不留临时文件', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'current.json');
  fsn.writeFileSync(file, JSON.stringify({ old: true }));
  writeJsonAtomicSync(file, { systemId: 'qemu', running: true });
  assert.deepEqual(JSON.parse(fsn.readFileSync(file, 'utf8')), { systemId: 'qemu', running: true });
  assert.deepEqual(fsn.readdirSync(dir), ['current.json']);
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('目录不存在时自动创建（日志目录首次写入）', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'logs', 'reports', '.delivery.json');
  writeJsonAtomicSync(file, [{ key: 'a', state: 'sent', at: 1 }]);
  assert.equal(JSON.parse(fsn.readFileSync(file, 'utf8')).length, 1);
  fsn.rmSync(dir, { recursive: true, force: true });
});

for (const [name, patch] of [
  ['writeFileSync 抛错', { writeFileSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } }],
  ['fsyncSync 抛错', { fsyncSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }],
  ['closeSync 抛错', () => {
    let calls = 0;
    return { closeSync: (fd) => {
      if (++calls === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      fsn.closeSync(fd);
    } };
  }],
  ['renameSync 抛错', { renameSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } }],
]) {
  test(`写入中途失败（${name}）时保留旧文件并清掉临时文件`, () => {
    const dir = tmpdir();
    const file = path.join(dir, 'current.json');
    fsn.writeFileSync(file, JSON.stringify({ keep: 'old' }));
    const overrides = typeof patch === 'function' ? patch() : patch;
    assert.throws(() => writeJsonAtomicSync(file, { keep: 'new' }, { fs: failing(overrides) }));
    assert.deepEqual(JSON.parse(fsn.readFileSync(file, 'utf8')), { keep: 'old' }, '旧文件不能被截断');
    assert.deepEqual(fsn.readdirSync(dir), ['current.json'], '临时文件必须清理干净');
    fsn.rmSync(dir, { recursive: true, force: true });
  });
}

test('临时文件已被别人占用（EEXIST）时报错，且不删除对方的文件', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'current.json');
  fsn.writeFileSync(file, JSON.stringify({ keep: 'old' }));
  const foreign = path.join(dir, '.current.json.fixed.tmp');
  fsn.writeFileSync(foreign, 'someone else');
  const io = failing({
    openSync: () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
  });
  assert.throws(() => writeJsonAtomicSync(file, { keep: 'new' }, { fs: io, uuid: () => 'fixed' }));
  assert.equal(fsn.readFileSync(foreign, 'utf8'), 'someone else', '不属于本次的临时文件不能删');
  assert.deepEqual(JSON.parse(fsn.readFileSync(file, 'utf8')), { keep: 'old' });
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('临时文件名每次随机，不覆盖同目录其它写入者的中间文件', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'current.json');
  const seen = [];
  const io = failing({
    openSync: (tmp, flag) => { seen.push(path.basename(tmp)); return fsn.openSync(tmp, flag); },
  });
  writeJsonAtomicSync(file, { a: 1 }, { fs: io });
  writeJsonAtomicSync(file, { a: 2 }, { fs: io });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert(seen.every((name) => name.startsWith('.current.json.') && name.endsWith('.tmp')));
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('并发写入同一文件时结果总是完整的某一份，不会出现半截 JSON', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'current.json');
  const payloads = Array.from({ length: 12 }, (_, i) => ({ index: i, filler: 'x'.repeat(4000) }));
  await Promise.all(payloads.map((payload, i) => new Promise((resolve) => {
    setImmediate(() => { writeJsonAtomicSync(file, payload); resolve(); });
  })));
  const parsed = JSON.parse(fsn.readFileSync(file, 'utf8'));
  assert(payloads.some((payload) => payload.index === parsed.index));
  assert.equal(parsed.filler.length, 4000);
  fsn.rmSync(dir, { recursive: true, force: true });
});

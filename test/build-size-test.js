'use strict';
/** 构建体积闸门测试：检测 ISO/大型镜像被拒绝，压缩镜像/小文件放行。纯 Node。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanDir, BIG_THRESHOLD } = require('../build/check-no-images');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ': ' + e.message); console.error('  ✗ ' + name + '\n    ' + e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-size-')); }
function touch(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  if (bytes > 0) fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

test('空目录：无违规', () => {
  const d = tmpDir();
  assert.strictEqual(scanDir(d).length, 0);
});

test('检测 ISO（任意大小）', () => {
  const d = tmpDir();
  touch(path.join(d, 'android-x86_64-9.0-r2.iso'), 1024);
  const f = scanDir(d);
  assert.strictEqual(f.length, 1);
  assert.ok(/ISO/.test(f[0].reason));
});

test('检测第三方系统命名的大 qcow2', () => {
  const d = tmpDir();
  touch(path.join(d, 'bliss-os.qcow2'), 10 * 1024 * 1024);
  const f = scanDir(d);
  assert.strictEqual(f.length, 1);
  assert.ok(/虚拟磁盘/.test(f[0].reason));
});

test('检测 >64MB 的 raw img', () => {
  const d = tmpDir();
  touch(path.join(d, 'bigdisk.img'), BIG_THRESHOLD + 1024);
  const f = scanDir(d);
  assert.strictEqual(f.length, 1);
  assert.ok(/大型磁盘镜像/.test(f[0].reason));
});

test('放行压缩镜像 .img.xz（完整版运行时需要）', () => {
  const d = tmpDir();
  touch(path.join(d, 'system.img.xz'), 200 * 1024 * 1024);
  assert.strictEqual(scanDir(d).length, 0);
});

test('放行小体积 seed 模板', () => {
  const d = tmpDir();
  touch(path.join(d, 'userdata.img'), 4 * 1024 * 1024);
  assert.strictEqual(scanDir(d).length, 0);
});

test('递归扫描子目录', () => {
  const d = tmpDir();
  touch(path.join(d, 'a', 'b', 'nested.iso'), 1024);
  const f = scanDir(d);
  assert.strictEqual(f.length, 1);
  assert.ok(f[0].path.includes('nested.iso'));
});

test('真实仓库 --self 场景：src/build 无违规镜像', () => {
  const root = path.join(__dirname, '..');
  let findings = [];
  for (const dir of ['src', 'build', 'system-catalog']) {
    findings = findings.concat(scanDir(path.join(root, dir), { base: root }));
  }
  assert.strictEqual(findings.length, 0, '仓库源码/构建目录不应含大型系统镜像');
});

console.log('\n[build-size]');
const total = passed + fails.length;
console.log(`\n${fails.length ? '✗' : '✓'} build-size 测试：${passed}/${total} 通过`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }

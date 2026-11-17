'use strict';
/** 任务管理器测试：状态机、去重锁、进度字段、暂停/取消/重试、持久化恢复。纯 Node。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SystemTaskManager, STATUS } = require('../src/core/system-task-manager');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ': ' + e.message); console.error('  ✗ ' + name + '\n    ' + e.message); }
}

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-task-'));
  const events = [];
  const m = new SystemTaskManager({ dataDir: dir, onEvent: (j) => events.push(j) });
  return { m, dir, events };
}

test('createTask：字段齐全', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'bliss-os', systemVersion: '16.9.7', type: 'system-download' });
  const j = task.toJSON();
  for (const k of ['taskId', 'systemId', 'systemVersion', 'status', 'progress', 'downloadedBytes',
    'totalBytes', 'speed', 'eta', 'currentStep', 'startedAt', 'updatedAt', 'error', 'retryCount']) {
    assert.ok(k in j, '缺少字段 ' + k);
  }
  assert.strictEqual(j.status, STATUS.WAITING);
  assert.ok(j.taskId.includes('bliss-os'));
});

test('同一系统去重：重复创建返回同一任务', () => {
  const { m } = mk();
  const a = m.createTask({ systemId: 'android-x86', type: 'system-download' });
  const b = m.createTask({ systemId: 'android-x86', type: 'system-install' });
  assert.strictEqual(b.reused, true);
  assert.strictEqual(a.task.taskId, b.task.taskId);
});

test('不同系统各自独立任务', () => {
  const { m } = mk();
  const a = m.createTask({ systemId: 'android-x86' });
  const b = m.createTask({ systemId: 'bliss-os' });
  assert.notStrictEqual(a.task.taskId, b.task.taskId);
});

test('进度更新：percent / 速度 / ETA / 字节数', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'bliss-os', totalBytes: 1000 });
  task.updateProgress({ percent: 42.5, downloadedBytes: 425, speed: 12 * 1048576, eta: 45 });
  assert.strictEqual(task.progress, 42.5);
  assert.strictEqual(task.downloadedBytes, 425);
  assert.strictEqual(task.speed, 12 * 1048576);
  assert.strictEqual(task.eta, 45);
  task.updateProgress({ downloadedBytes: 900 }); // 无 percent 时按字节算
  assert.ok(Math.abs(task.progress - 90) < 0.1);
});

test('percent 夹在 0-100', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'x' });
  task.updateProgress({ percent: 150 });
  assert.strictEqual(task.progress, 100);
  task.updateProgress({ percent: -10 });
  assert.strictEqual(task.progress, 0);
});

test('状态机：setStatus 记录步骤与时间', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'x' });
  task.setStatus(STATUS.DOWNLOADING, '正在下载系统镜像');
  task.setStatus(STATUS.VERIFYING, '文件校验中');
  assert.strictEqual(task.status, STATUS.VERIFYING);
  assert.strictEqual(task.steps.length, 2);
  assert.ok(task.updatedAt);
});

test('pause：仅下载/安装中可暂停，AbortSignal 触发', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'x' });
  assert.strictEqual(m.pause(task.taskId).ok, false); // waiting 不能暂停
  task.setStatus(STATUS.DOWNLOADING, '下载中');
  let aborted = false;
  task.signal.addEventListener('abort', () => { aborted = true; });
  assert.strictEqual(m.pause(task.taskId).ok, true);
  assert.strictEqual(task.status, STATUS.PAUSED);
  assert.strictEqual(aborted, true);
});

test('cancel：释放锁，允许重新创建', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'x' });
  assert.strictEqual(m.cancel(task.taskId).ok, true);
  assert.strictEqual(task.status, STATUS.CANCELLED);
  const again = m.createTask({ systemId: 'x' });
  assert.strictEqual(again.reused, false, '取消后应可新建任务');
});

test('retry：仅失败/暂停可重试，次数受限', () => {
  const { m } = mk();
  const { task } = m.createTask({ systemId: 'x', maxRetries: 1 });
  assert.strictEqual(m.retry(task.taskId).ok, false); // waiting 不可重试
  task.setStatus(STATUS.FAILED, '下载失败', { error: 'boom' });
  assert.strictEqual(m.retry(task.taskId).ok, true);
  assert.strictEqual(task.retryCount, 1);
  task.setStatus(STATUS.FAILED, '再次失败');
  assert.strictEqual(m.retry(task.taskId).ok, false, '超过重试上限');
});

test('事件推送：onEvent 收到任务 JSON', () => {
  const { m, events } = mk();
  const { task } = m.createTask({ systemId: 'x' });
  task.updateProgress({ percent: 10 });
  assert.ok(events.length >= 2);
  assert.ok(events.some((e) => e.taskId === task.taskId && e.progress === 10));
});

test('持久化恢复：未终结任务恢复为 paused，已终结保留', () => {
  const { m, dir } = mk();
  const a = m.createTask({ systemId: 'a' });
  a.task.setStatus(STATUS.DOWNLOADING, '下载中');
  a.task.updateProgress({ percent: 55, downloadedBytes: 550, totalBytes: 1000 });
  const b = m.createTask({ systemId: 'b' });
  b.task.setStatus(STATUS.COMPLETED, '完成');
  const m2 = new SystemTaskManager({ dataDir: dir, onEvent: () => {} });
  const ra = m2.getTask(a.task.taskId);
  const rb = m2.getTask(b.task.taskId);
  assert.strictEqual(ra.status, STATUS.PAUSED, '未终结任务应恢复为 paused');
  assert.strictEqual(ra.downloadedBytes, 550);
  assert.strictEqual(rb.status, STATUS.COMPLETED, '已完成任务保留状态');
});

console.log('\n[system-task-manager]');
const total = passed + fails.length;
console.log(`\n${fails.length ? '✗' : '✓'} system-task-manager 测试：${passed}/${total} 通过`);
if (fails.length) { for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }

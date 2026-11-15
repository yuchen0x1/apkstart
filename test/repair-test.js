'use strict';
/**
 * 一键修复方案测试。
 *
 * 守两件事：
 *   1. 每个诊断码都能生成「有结论、有解释、有下一步」的方案（不能是空壳）；
 *   2. 结构性跑不了的情况（老系统 / 内存太小）必须被标成 blocked，
 *      不能还让用户以为「点一下就能好」。
 */
const assert = require('assert');
const { buildFacts, buildPlan } = require('../src/core/repair');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

const facts = (over = {}) => buildFacts({
  cpuModel: 'AMD Ryzen 5 5600',
  vendor: 'ASUSTeK COMPUTER INC.',
  vm: false,
  cores: 12,
  totalMB: 16384,
  freeMB: 6000,
  arch: 'x64',
  osRelease: '10.0.19045',
  accel: { ok: true, kind: 'whpx', note: 'WHPX 硬件加速已启用' },
  emulatorVersion: '37.2.13',
  image: { api: '34', tag: 'google_apis_playstore', compat: true },
  freeDiskMB: 51200,
  exitCode: null,
  ...over,
});

const planOf = (code, over = {}) => buildPlan({ diagnosis: { code, title: `诊断-${code}` }, facts: facts(over), attempts: [] });

test('每个诊断码都能出方案（有结论、有解释、有动作）', () => {
  const codes = ['TIMEOUT', 'ACCEL', 'CPU_FEATURE', 'GPU_INIT', 'ACCESS_VIOLATION', 'MEMORY',
    'DISK_FULL', 'IMAGE', 'AVD_LOCK', 'DLL', 'PORT_BUSY', 'NON_ASCII', 'UNKNOWN', '不存在的码'];
  for (const code of codes) {
    const p = planOf(code);
    assert(p.headline && p.headline.length > 6, `${code} 缺结论`);
    assert(Array.isArray(p.why) && p.why.length >= 2, `${code} 缺解释段落`);
    assert(Array.isArray(p.checks) && p.checks.length >= 2, `${code} 缺体检表`);
    assert(Array.isArray(p.actions) && p.actions.length >= 1, `${code} 缺下一步动作`);
    assert(['auto', 'slow', 'blocked'].includes(p.level), `${code} 等级不合法：${p.level}`);
  }
});

test('超时 + 无加速：判为「慢」，给出低配重试，并要求 15 分钟级超时', () => {
  const p = planOf('TIMEOUT', { accel: { ok: false, kind: '', note: '' } });
  assert.strictEqual(p.level, 'slow');
  assert(p.actions.some((a) => a.id === 'low-spec'), '缺低配重试');
  assert(p.retry && p.retry.lowspec === true && p.retry.timeoutMs >= 900000, '低配重试没延长超时');
  assert(p.why.some((t) => /Android 12/.test(t)), '必须说明「换 12 也没用」，否则用户会继续试错方向');
});

test('超时 + 有加速：优先怀疑渲染，动作里要有换软件渲染', () => {
  const p = planOf('TIMEOUT');
  assert(p.actions.some((a) => a.id === 'gpu-software'), '缺换渲染后端的动作');
});

test('真·非法指令：判为跑不了，且不能给「一键修复」的错觉', () => {
  const p = planOf('CPU_FEATURE', { exitCode: 3221225501 });
  assert.strictEqual(p.level, 'blocked');
  assert.strictEqual(p.canAutoFix, false, 'CPU 缺指令集不该出现「一键修复」按钮');
  assert(p.why.some((t) => /0xC000001D|非法指令/.test(t)), '要指出非法指令这个硬证据');
});

test('内存 2GB：判为跑不了，且第一条原因就是内存', () => {
  const p = planOf('UNKNOWN', { totalMB: 2048, freeMB: 900 });
  assert.strictEqual(p.level, 'blocked');
  assert(/内存/.test(p.why[0]), `第一条原因应是内存：${p.why[0]}`);
});

test('Windows 7：判为跑不了', () => {
  const p = planOf('UNKNOWN', { osRelease: '6.1.7601' });
  assert.strictEqual(p.level, 'blocked');
  assert(/Windows/.test(p.why[0]), `第一条原因应是系统版本：${p.why[0]}`);
});

test('虚拟机 + 无加速：解释里要点明「嵌套虚拟化」，不能怪用户', () => {
  const p = planOf('ACCEL', { vm: true, vendor: 'VMware, Inc.', accel: { ok: false, kind: '' } });
  assert(p.why.some((t) => /嵌套虚拟化/.test(t)), '缺嵌套虚拟化的说明');
  assert(p.checks.some((c) => c.label === '运行环境' && c.state === 'bad'), '体检表要标出虚拟机 + 无加速');
});

test('镜像损坏：给重建数据与重下镜像，且都标记为「会动数据」', () => {
  const p = planOf('IMAGE');
  const acts = p.actions.filter((a) => a.destructive);
  assert(acts.length >= 2, '重建/重下的动作必须带 destructive 标记，UI 才能二次确认');
  assert.strictEqual(p.canAutoFix, true);
});

test('空事实表不抛错（还没部署完就点修复）', () => {
  const p = buildPlan({ diagnosis: null });
  assert(p.headline && Array.isArray(p.why) && Array.isArray(p.actions));
  assert.strictEqual(p.code, 'UNKNOWN');
});

test('尝试记录会写进解释，方便用户/作者对着看', () => {
  const p = buildPlan({
    diagnosis: { code: 'TIMEOUT', title: '等了 4 分钟也没开完机' },
    facts: facts({ accel: { ok: false } }),
    attempts: [
      { plan: 'swangle / 硬件加速', diagnosis: 'TIMEOUT', timeout: true },
      { plan: '保守冷启动（最小内存 + 清快照）', diagnosis: 'TIMEOUT', timeout: true },
    ],
  });
  const last = p.why[p.why.length - 1];
  assert(/本次已经试过 2 组参数/.test(last), `缺尝试记录：${last}`);
  assert(/超时/.test(last), '超时的尝试要标出来');
});

if (fails.length) {
  console.log(`\n一键修复测试：${passed} 通过，${fails.length} 失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`一键修复测试：${passed} 项全部通过`);

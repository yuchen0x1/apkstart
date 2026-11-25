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
  const codes = ['TIMEOUT', 'ACCEL', 'ACCEL_UNUSABLE', 'TCG_CRASH', 'EMULATOR_CRASH_LOOP', 'CPU_FEATURE', 'GPU_INIT', 'ACCESS_VIOLATION', 'MEMORY',
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

test('TCG 模式下连续崩溃：保留加速入口，不断言根因或承诺修复', () => {
  const p = planOf('TCG_CRASH', { accel: { ok: false, kind: '', note: '' } });
  assert.strictEqual(p.level, 'slow');
  assert(p.actions.some((a) => a.id === 'accel' && a.kind === 'auto'), '缺「一键开启硬件加速」动作');
  assert.strictEqual(p.canAutoFix, true, '应当可以一键修复');
  assert(p.retry && p.retry.needsReboot === true, '开启后要重启，不能立刻重试');
  const text = [p.headline, ...p.why].join('；');
  assert(/TCG/.test(text), '要保留发生崩溃时的软件模拟模式');
  assert(/0xC0000005/.test(text), '要保留已记录的访问冲突退出码');
  assert(/不能确认故障模块/.test(text), text);
  assert(/不能保证修复访问冲突/.test(text), text);
  assert(!/崩溃点在模拟器|而不是显卡驱动|唯一的真修复|才(?:能)?稳定开机/.test(text), text);
});

test('跨 GPU/加速组合连续崩溃：只导出报告，不自动再开机', () => {
  const p = planOf('EMULATOR_CRASH_LOOP');
  assert.strictEqual(p.level, 'blocked');
  assert.strictEqual(p.canAutoFix, false, '终止性崩溃结论不能提供自动重试');
  assert(p.actions.some((a) => a.id === 'report'), '必须保留导出诊断报告入口');
  assert(p.why.some((t) => /不会修复|停止自动/.test(t)), `要说明已停止自动循环：${p.why.join('；')}`);
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

test('ACCEL_UNUSABLE：修复动作指向「启动驱动服务」，并说明换渲染/换镜像无效', () => {
  const p = planOf('ACCEL_UNUSABLE', {
    accel: { ok: true, kind: 'aehd', note: 'AEHD 驱动已安装但服务未运行（STOPPED）', suspect: true },
  });
  assert(p.level === 'slow', `等级应为 slow，实际 ${p.level}`);
  assert(p.actions.some((a) => a.id === 'accel'), '必须给「自动修复硬件加速」按钮');
  assert(p.actions.some((a) => a.id === 'low-spec'), '要保留一条「先用软件模拟开起来」的退路');
  assert(p.why.some((t) => /sc start aehd/.test(t)), '要写出具体动作，别只说「去检查驱动」');
  assert(p.why.some((t) => /换渲染后端|换系统镜像/.test(t)), '要明确说换渲染/换镜像无效');
  // 体检表不能把它显示成「已启用」——那正是用户被误导的地方
  const row = p.checks.find((c) => c.label === '硬件加速');
  assert(row && row.state === 'bad', `体检表应标红，实际 ${JSON.stringify(row)}`);
  assert(/服务未运行/.test(row.value), `体检表要说清服务没跑：${row.value}`);
});

test('检测结果 ok 但可疑（suspect）：各方案仍要给「开启硬件加速」按钮', () => {
  const suspect = { ok: true, kind: 'aehd', note: 'AEHD 驱动已安装但服务未运行（STOPPED）', suspect: true };
  for (const code of ['ACCEL', 'TIMEOUT', 'UNKNOWN']) {
    const p = planOf(code, { accel: suspect });
    assert(p.actions.some((a) => a.id === 'accel'),
      `${code}：accel.ok=true 但服务没跑时，仍然必须给修复入口，否则用户无路可走`);
  }
});

test('只有 DLL 退出码时指出加载失败，不能断言缺 VC++ 或被杀毒隔离', () => {
  const { diagnose } = require('../src/core/doctor');
  const { explainFailure, selfHeal } = require('../src/core/repair');
  for (const log of ['emulator exit 3221225781', 'emulator exit 3221225781（0xC0000135）']) {
    const diagnosis = diagnose([log]);
    assert.strictEqual(diagnosis.code, 'DLL');
    assert(/DLL.*加载失败/.test(diagnosis.title), diagnosis.title);
    assert(/(?:无法|不能)确认/.test(diagnosis.hint), diagnosis.hint);
    assert(!/白名单/.test(diagnosis.hint), diagnosis.hint);
    const plan = buildPlan({ diagnosis, facts: facts() });
    assert(/DLL.*加载失败/.test(plan.headline), plan.headline);
    assert.deepStrictEqual(plan.actions.map(({ id }) => id), ['redeploy', 'report']);
    const { summary } = explainFailure({ diagnosis, facts: facts() });
    assert(/尚未确认/.test(summary), summary);
  }
  assert.deepStrictEqual(selfHeal('DLL').actions, ['redeploy'], '未知原因不能触发系统运行库安装');
});

test('访问冲突的修复说明保留未知归因，不把显卡当成已确认原因', () => {
  const { diagnose } = require('../src/core/doctor');
  const { explainFailure } = require('../src/core/repair');
  const diagnosis = diagnose(['emulator exit 3221225477']);
  assert.strictEqual(diagnosis.code, 'ACCESS_VIOLATION');
  const plan = buildPlan({ diagnosis, facts: facts() });
  assert(/不能确定/.test(plan.headline), plan.headline);
  assert(plan.why.some((text) => /不能直接归因于显卡/.test(text)), plan.why.join('；'));
  assert(plan.actions.some(({ id }) => id === 'gpu-software'), '保留软件渲染排查入口');
  assert(!/几乎都|都无关|一次就过|通常就能过|最有效/.test(JSON.stringify(plan)), JSON.stringify(plan));
  const { summary } = explainFailure({ diagnosis, facts: facts() });
  assert(/尚未确认/.test(summary), summary);
  assert(!/显卡渲染那一层/.test(summary), summary);
});

test('渲染初始化失败的修复说明不保证软件渲染能开机或排除镜像', () => {
  const plan = planOf('GPU_INIT');
  const text = [plan.headline, ...plan.why].join('；');
  assert(/初始化失败/.test(plan.headline), plan.headline);
  assert(/不能排除/.test(text), text);
  assert(/不能保证开机成功/.test(text), text);
  assert(!/不是安卓镜像的问题|但能开机/.test(text), text);
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

test('自愈表只收「不用用户做决定」的动作', () => {
  const { selfHeal } = require('../src/core/repair');
  // 全自动路径的底线：只能做这些动作。删数据（wipe-data）、重下 1.5GB 镜像
  // （reinstall-image）、清缓存（cleanup-disk）都必须用户点同意。
  const safe = new Set(['clear-locks', 'redeploy', 'vc-redist', 'cleanup-safe', 'gpu-software']);
  const codes = ['AVD_LOCK', 'PORT_BUSY', 'DLL', 'IMAGE', 'DISK_FULL', 'GPU_INIT',
    'ACCESS_VIOLATION', 'MEMORY', 'TIMEOUT', 'UNKNOWN'];
  for (const c of codes) {
    const p = selfHeal(c);
    assert(p, `${c} 应该能自愈，否则用户又得自己点按钮`);
    for (const a of p.actions || []) {
      assert(safe.has(a), `${c} 里的 ${a} 不在白名单里：自动链不许做会丢数据的动作`);
    }
  }
  assert.strictEqual(selfHeal('CPU_FEATURE'), null, 'CPU 缺指令修不了，不该进自愈表白试一轮');
  assert.strictEqual(selfHeal('NON_ASCII'), null, '路径含中文只能由用户改目录');
  assert.strictEqual(selfHeal('ACCEL_UNUSABLE'), null, '加速类有独立授权链路，不在这张表里');
});

test('人话说明：不带诊断码，说清「已自动做了什么」', () => {
  const { explainFailure } = require('../src/core/repair');
  const one = explainFailure({
    diagnosis: { code: 'AVD_LOCK' },
    facts: facts(),
    autoRepair: { code: 'AVD_LOCK', tried: ['清理了残留锁文件'], retried: true },
  });
  assert(/上次没有正常退出/.test(one.summary), one.summary);
  assert(/清理了残留锁文件/.test(one.did) && /重新开了一次机/.test(one.did), one.did);
  assert(!/AVD_LOCK|0xC0000005|ACCEL_|_UNUSABLE/.test(one.text), `人话里不该出现诊断码：${one.text}`);
  assert(/下一步：/.test(one.text), '要给出一个可点的动作');

  // 没修过的时候不该硬编「已自动处理」
  const plain = explainFailure({ diagnosis: { code: 'CPU_FEATURE' }, facts: facts() });
  assert(!/程序已经自动/.test(plain.text), `没修过却写了「已自动」：${plain.text}`);
});

if (fails.length) {
  console.log(`\n一键修复测试：${passed} 通过，${fails.length} 失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`一键修复测试：${passed} 项全部通过`);

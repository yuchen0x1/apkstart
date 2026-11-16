'use strict';
/**
 * 低配电脑运行优化测试（纯 Node，不拉起 emulator、不联网）
 *
 * 守四件事：
 *   1. 低配识别：没有硬件虚拟化 / 内存小 / CPU 弱的机器要能被识别出来，
 *      而内存和 CPU 都富余的机器不能被误伤（没 VT 不等于要砍画质）；
 *   2. 低配档选出的内存 / vCPU / 分辨率 / 渲染后端 / 快照策略都是「更保守」的那一档；
 *   3. 用户手动配置永远优先：内存、核心数、画质、渲染后端、快照都不会被自动降级覆盖；
 *   4. 失败时要能交出「实际采用的参数」（摘要文案 / 单轮参数 / 修复窗口体检表），
 *      而且默认运行时仍是 Android 14 Google Play x86_64。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-lowspec-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

const doctor = require('../src/core/doctor');
const repair = require('../src/core/repair');
const { EmulatorEngine } = require('../src/core/emulator');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

/** 造一台「指定的机器」：只填 chooseProfile 真正会读的字段 */
const hostOf = (totalMB, cores) => ({
  totalMB,
  freeMB: Math.round(totalMB * 0.6),
  cores,
  home: 'C:\\Users\\x',
  homeAscii: true,
  tmp: TMP,
  platform: 'win32',
  arch: 'x64',
  rdp: false,
});

/** 低配机器：4GB / 2 核 / 没有硬件虚拟化（最典型的「跑得起来但很慢」） */
const LOW = hostOf(4096, 2);
const profileOf = (over = {}) => doctor.chooseProfile({
  host: LOW,
  accel: { ok: false },
  emulatorVersion: '37.3.8.0',
  diskMB: 50000,
  port: 5554,
  adbPort: 5044,
  ...over,
});

console.log('\n[doctor.js 低配识别]');

test('没有硬件虚拟化 + 4GB + 2 核 → 判定为低配，并说明差在哪', () => {
  const t = doctor.machineTier({ host: LOW, accel: { ok: false }, diskMB: 50000 });
  assert(t.tier === 'low', `应判为 low，实际 ${t.tier}（score ${t.score}）`);
  assert(t.reasons.some((r) => /硬件虚拟化/.test(r)), `缺加速理由：${JSON.stringify(t.reasons)}`);
  assert(t.reasons.some((r) => /内存/.test(r)), `缺内存理由：${JSON.stringify(t.reasons)}`);
  assert(t.reasons.some((r) => /2 核/.test(r)), `缺 CPU 理由：${JSON.stringify(t.reasons)}`);
});

test('普通办公本（8GB / 4 核 / 有加速）不降级', () => {
  const t = doctor.machineTier({ host: hostOf(8192, 4), accel: { ok: true }, diskMB: 200000 });
  assert(t.tier !== 'low', `8GB/4 核有加速不该判为低配，实际 ${t.tier}`);
});

test('高分机器即使没有硬件虚拟化也不砍画质（不误伤）', () => {
  // 16GB / 8 核但没有 WHPX：缺的只是速度，降分辨率换不来能开机，画面却白白变丑
  const t = doctor.machineTier({ host: hostOf(16384, 8), accel: { ok: false }, diskMB: 200000 });
  assert(t.tier !== 'low', `高内存多核不该因缺加速被判低配，实际 ${t.tier}`);
  const p = profileOf({ host: hostOf(16384, 8), accel: { ok: false } });
  assert(p.tuned === false && p.gpu === 'host', '非低配机器仍应先试显卡渲染');
});

console.log('\n[doctor.js 低配档参数]');

test('内存 / vCPU / 分辨率 / 渲染后端 / 快照 全部取保守值', () => {
  const p = profileOf();
  assert(p.tuned === true && p.tier === 'low', '应标记为低配自动降级');
  assert(p.memoryMB === 2048, `内存应为 2048（Android 14 底线），实际 ${p.memoryMB}`);
  assert(p.cores === 2, `vCPU 应为 2，实际 ${p.cores}`);
  assert(p.lcd.w === 540 && p.lcd.h === 960, `分辨率应为 540x960，实际 ${p.lcd.w}x${p.lcd.h}`);
  assert(/swangle|software|swiftshader/.test(p.gpu), `应优先软件渲染，实际 ${p.gpu}`);
  assert(p.snapshot === true, '磁盘充足时应保留 quickboot 快照（冷启动太贵）');
});

test('弱 CPU 但有硬件虚拟化：仍然降分辨率，并给足开机时间', () => {
  const p = profileOf({ accel: { ok: true }, host: hostOf(4096, 4) });
  assert(p.tier === 'low' && p.tuned === true, `4GB/4 核也应判低配，实际 ${p.tier}`);
  assert(p.accel === 'on', '有加速就该用加速');
  assert(p.lcd.w === 540, `有加速也要降一档分辨率（填充率瓶颈），实际 ${p.lcd.w}`);
  assert(p.bootTimeoutMs >= 420000, `低配机器要给足开机时间，实际 ${p.bootTimeoutMs}ms`);
});

test('老引擎没有 swangle：低配档退回 swiftshader_indirect', () => {
  const p = profileOf({ emulatorVersion: '35.1.4.0' });
  assert(p.gpu === 'swiftshader_indirect', `老引擎应退 swiftshader_indirect，实际 ${p.gpu}`);
  assert(!/swangle/.test(p.gpuCandidates.join(',')), '老引擎的候选表里不该出现 swangle');
});

test('磁盘紧张（<8GB）时关掉快照，且重试矩阵同样不加载快照', () => {
  const p = profileOf({ diskMB: 6000 });
  assert(p.snapshot === false, 'ram.bin 放不下时必须关掉快照，否则写满磁盘会让下次开机直接失败');
  const first = doctor.planVariants(p)[0];
  assert(first.snapshot === false, 'GPU 轮次也必须尊重快照策略（否则等于没关）');
});

console.log('\n[用户手动配置优先]');

test('内存 / 核心 / 画质 / 渲染后端 / 快照 都由用户说了算', () => {
  const engine = {
    autoMemory: false, memoryMB: 4096, cores: 4,
    gpuMode: 'host', renderSize: '720x1280', keepSnapshot: false,
  };
  const p = doctor.chooseProfile({
    host: LOW, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 50000,
    settings: { engine }, overrides: doctor.overridesFromSettings(engine),
  });
  assert(p.memoryMB === 4096, `用户填的 4096MB 必须生效，实际 ${p.memoryMB}`);
  assert(p.cores === 4, `用户填的 4 核必须生效，实际 ${p.cores}`);
  assert(p.gpu === 'host' && p.gpuPinned === true, '用户指定的渲染后端必须钉住');
  assert(p.lcd.w === 720 && p.lcd.h === 1280, `用户选的画质必须生效，实际 ${p.lcd.w}x${p.lcd.h}`);
  assert(p.snapshot === false, '用户关掉快照就必须关掉');
  for (const k of ['memoryMB', 'cores', 'gpuMode', 'renderSize', 'keepSnapshot']) {
    assert(p.manual.includes(k), `应记录手动项 ${k}，实际 ${JSON.stringify(p.manual)}`);
  }
  assert(/手动指定：内存、CPU 核心数、渲染后端、画质、快速启动快照/.test(doctor.describeManual(p)),
    `摘要应说明哪些项是手动钉住的：${doctor.describeManual(p)}`);
});

test('资源策略选「流畅」：低配机器也不再自动降级（手动诉求优先）', () => {
  const p = profileOf({ accel: { ok: true }, settings: { engine: { resourceMode: 'smooth' } } });
  assert(p.tier === 'low', '机器档位仍然算低配');
  assert(p.tuned === false, '但用户选了流畅，就不降级');
  assert(p.lcd.w === 720, `流畅档按 720x1280，实际 ${p.lcd.w}`);
  assert(/本次不降级/.test(doctor.describeTuning(p)), `应说明为什么没降级：${doctor.describeTuning(p)}`);
});

test('轻量容器被手动关掉时，低配档不再压 vCPU', () => {
  const p = profileOf({ host: hostOf(4096, 8), accel: { ok: true }, settings: { engine: { liteMode: false } } });
  // 8 核 → 均衡基线 4 核；liteMode:false 是手动指定，低配档不该越过它去压到 2
  assert(p.cores === 4, `手动关闭轻量容器后应保留基线核数，实际 ${p.cores}`);
});

console.log('\n[运行时失败时显示实际参数]');

test('摘要里能直接读到实跑的内存 / 分辨率 / 渲染后端 / 快照', () => {
  const p = profileOf();
  const text = doctor.describeProfile(p);
  assert(/低配自动降级/.test(text), `应标出走了降级：${text}`);
  assert(/2\.0GB 内存/.test(text) && /2 核/.test(text), text);
  assert(/540×960/.test(text), text);
  assert(/quickboot 快照/.test(text), text);
  assert(/软件模拟/.test(text), text);
});

test('单轮尝试参数：一行看清这一轮到底有多保守', () => {
  const one = doctor.describeAttempt({
    gpu: 'swangle', memoryMB: 2048, cores: 2, lcd: { w: 540, h: 960 }, snapshot: false, accel: 'off', wipe: false,
  });
  assert(/swangle/.test(one) && /2048MB/.test(one) && /2核/.test(one), one);
  assert(/540x960/.test(one) && /不存快照/.test(one) && /软件模拟/.test(one), one);
  assert(!/清数据/.test(one), '普通尝试不该带 -wipe-data');
  assert(/清数据/.test(doctor.describeAttempt({ gpu: 'software', memoryMB: 2048, cores: 2, wipe: true })), '清数据必须标出来');
});

test('修复窗口的体检表列出「本次实跑参数」', () => {
  const text = doctor.describeProfile(profileOf());
  const facts = repair.buildFacts({
    cpuModel: 'Intel Celeron N4100', cores: 2, totalMB: 4096, accel: { ok: false },
    profileText: text, tuned: true,
  });
  const row = repair.buildChecks(facts).find((c) => c.label === '本次实跑参数');
  assert(row, '体检表缺少实跑参数一行');
  assert(row.value === text, '实跑参数要原样展示');
  assert(row.state === 'warn', '走了降级应标成 warn，让用户一眼看到');
  // 没走降级时是正常态
  const okFacts = repair.buildFacts({ cpuModel: 'X', cores: 8, totalMB: 32768, profileText: text, tuned: false });
  assert(repair.buildChecks(okFacts).find((c) => c.label === '本次实跑参数').state === 'ok');
});

console.log('\n[默认运行时不变]');

test('默认镜像是 Android 14 Google Play x86_64，Google APIs 仍可单独选择', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'provision.js'), 'utf8');
  assert(/const PLAY_SYSIMG = IMAGE_PROFILES\.google_apis_playstore/.test(src),
    'Google Play 兼容档位必须保留');
  assert(/const DEFAULT_SYSIMG = IMAGE_PROFILES\.google_apis_playstore/.test(src), '默认镜像应指向 Google Play');
});

test('有 Play 镜像时 imageChoice 优先用它（不因低配降级换镜像）', () => {
  const emu = new EmulatorEngine(ROOT);
  emu.provisioner = {
    playImageInfo: () => ({
      ok: true, api: '34', tag: 'google_apis_playstore',
      dir: 'D:/rt/system-images/android-34/google_apis_playstore/x86_64',
    }),
    systemImageInfo: () => ({ ok: false }),
    paths: () => ({ sysAbi: 'x86_64' }),
  };
  const ch = emu.imageChoice();
  assert(ch.api === '34' && ch.tag === 'google_apis_playstore' && ch.abi === 'x86_64',
    `应继续使用 Android 14 Play x86_64，实际 ${JSON.stringify(ch)}`);
});

test('低配档只改参数、不改镜像与数据分区（不会顺手抹数据）', () => {
  const p = profileOf();
  assert(p.dataMB >= 4096, `低配档不该压缩数据分区，实际 ${p.dataMB}MB`);
  assert(p.wipe === undefined && p.lastResort === undefined, '自动降级不该带清数据类标记');
  const variants = doctor.planVariants(p);
  assert(variants.every((v) => v.wipe === false), '任何自动重试都不允许清用户数据');
});

if (fails.length) {
  console.log(`\n低配优化测试：${passed} 通过，${fails.length} 失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`低配优化测试：${passed} 项全部通过`);

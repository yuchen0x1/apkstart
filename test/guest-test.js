'use strict';
/**
 * 安卓客机设置（语言 / 预装应用精简）测试。
 *
 * 这里守的是三件真机上很容易出事、但本地能先兜住的事：
 *   1. 精简目录里不能混进"删了就黑屏"的包（systemui / 桌面 / 输入法 …）；
 *   2. 包名要拼进 adb shell，非法字符必须在生成计划前就被丢掉（注入防护）；
 *   3. 语言启动参数只接受合法的 BCP-47 片段 —— 否则一个手滑的
 *      `-prop persist.sys.locale=` 会把模拟器启动参数拼坏，直接开不了机。
 */
const assert = require('assert');
const guest = require('../src/core/guest');

let passed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

test('精简目录结构完整（分组 id 唯一、文案不为空）', () => {
  const ids = guest.GROUPS.map((g) => g.id);
  assert.strictEqual(new Set(ids).size, ids.length, '分组 id 重复');
  for (const g of guest.GROUPS) {
    assert(g.label && g.label.length > 1, `${g.id} 缺 label`);
    assert(g.note && g.note.length > 2, `${g.id} 缺说明`);
    assert(Array.isArray(g.packages) && g.packages.length > 0, `${g.id} 没有包`);
    assert(['safe', 'danger'].includes(g.risk), `${g.id} risk 非法`);
  }
});

test('目录里所有包名合法，且不包含任何"删了就黑屏"的包', () => {
  for (const g of guest.GROUPS) {
    for (const p of g.packages) {
      assert(guest.isSafePackage(p), `${g.id} 里的包名不合法：${p}`);
      assert(!guest.NEVER_TOUCH.includes(p), `${g.id} 里混进了禁动包：${p}`);
    }
  }
});

test('任何分组都不会删掉桌面 / 系统界面 / 输入法 / WebView', () => {
  const all = new Set();
  for (const g of guest.GROUPS) g.packages.forEach((p) => all.add(p));
  for (const must of guest.NEVER_TOUCH) {
    assert(!all.has(must), `禁动包被列进了精简目录：${must}`);
  }
});

test('语言判定：只认 am get-config 里的真实界面语言', () => {
  const cfg = 'config: zh-rCN-ldltr-sw360dp-w360dp-h592dp-normal-notlong-nowidecg-port-notnight-xhdpi-finger-keysexposed-qwerty-navexposed-dpad-1232x720-v34';
  assert.strictEqual(guest.configLocale(cfg), 'zh-rCN');
  assert.strictEqual(guest.configLocale('config: en-rUS-ldltr-v34'), 'en-rUS');
  assert.strictEqual(guest.configLocale(''), '');
  assert(guest.localeActive(guest.configLocale(cfg), 'zh-CN'));
  assert(!guest.localeActive('en-rUS', 'zh-CN'));
  assert(!guest.localeActive('', 'zh-CN'));
});

test('写入语言的命令里有 settings put system system_locales（唯一不需要 root 的那条）', () => {
  const cmds = guest.localeCommands('zh-CN');
  assert(cmds.some((c) => /settings put system system_locales zh-CN/.test(c)), '缺 settings put system_locales');
  // setprop 那几条在 Play 镜像上会失败，属于加分项，不能当成唯一手段
  assert(cmds.length >= 2);
});

test('parsePackages 只认 package: 行，其它输出全部忽略', () => {
  const out = 'package:com.google.android.youtube\nWarning: something\npackage:a.b\n\npackage:';
  const set = guest.parsePackages(out);
  assert(set.has('com.google.android.youtube'));
  assert(set.has('a.b'));
  assert.strictEqual(set.size, 2);
});

test('精简计划：分清楚 移除 / 早已移除 / 系统里没有', () => {
  const installed = ['com.google.android.youtube', 'com.google.android.gm', 'com.android.chrome'];
  const present = [...installed, 'com.google.android.apps.photos'];
  const plan = guest.buildTrimPlan({ installed, present, groups: ['google_media'] });
  assert(plan.remove.includes('com.google.android.youtube'));
  assert(plan.remove.includes('com.google.android.gm'));
  assert(plan.remove.includes('com.android.chrome'));
  // photos 之前就被移除过
  assert(plan.alreadyGone.includes('com.google.android.apps.photos'));
  // 镜像上没有的包不能当成"移除成功"
  assert(plan.missing.includes('com.google.android.apps.youtube.music'));
  assert(!plan.remove.some((p) => p === 'com.google.android.apps.photos'));
});

test('精简计划：未知分组被单独报出来，不会静默吞掉', () => {
  const plan = guest.buildTrimPlan({ installed: [], present: [], groups: ['不存在的组'] });
  assert.deepStrictEqual(plan.unknownGroups, ['不存在的组']);
  assert.deepStrictEqual(plan.remove, []);
});

test('恢复计划：只恢复"存在但当前用户看不见"的包', () => {
  const present = ['com.google.android.youtube', 'com.google.android.gm', 'com.android.chrome'];
  const installed = ['com.android.chrome'];
  const plan = guest.buildRestorePlan({ installed, present });
  assert(plan.includes('com.google.android.youtube'));
  assert(plan.includes('com.google.android.gm'));
  assert(!plan.includes('com.android.chrome'));
  // 镜像上不存在的包不产生恢复动作
  assert(!plan.includes('com.google.android.apps.youtube.music'));
});

test('运行时语言命令仍保留 language/country（root 镜像与老镜像吃这两个）', () => {
  const cmds = guest.localeCommands('zh-CN').join('\n');
  assert(/persist\.sys\.locale zh-CN/.test(cmds));
  assert(/persist\.sys\.language zh/.test(cmds));
  assert(/persist\.sys\.country CN/.test(cmds));
});

if (fails.length) {
  console.log(`\n安卓客机设置测试：${passed} 通过，${fails.length} 失败`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`安卓客机设置测试：${passed} 项全部通过`);

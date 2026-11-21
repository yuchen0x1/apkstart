'use strict';
/**
 * 用真实 Electron 跑测试的启动器。
 *
 * 为什么需要它：
 *   - 直接 `electron xxx.js` 在某些环境里会因为 ELECTRON_RUN_AS_NODE=1 变成纯 Node 进程，
 *     require('electron') 拿到的是可执行文件路径而不是 API，测试会莫名其妙地报错；
 *   - 各平台 shell 清环境变量的写法不一样，塞进 package.json 的 script 里会不可移植。
 *
 * 用法：
 *   node test/run-electron.js smoke      # 界面冒烟（preload / 沙箱 / 首屏）
 *   node test/run-electron.js ui         # 双主题、键盘、窗口尺寸的隔离渲染回归
 *   node test/run-electron.js upstream   # 多开、外设与面板录放的隔离验收
 *   node test/run-electron.js selftest   # 主进程自检（真实 IPC 通道）
 */
const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron'); // 在纯 node 下这就是 electron 可执行文件路径
const mode = process.argv[2] || 'smoke';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;   // 否则 Electron 会按 Node 模式跑，拿不到 GUI API
delete env.ELECTRON_NO_ATTACH_CONSOLE;

let args;
if (mode === 'smoke') {
  args = [path.join(__dirname, 'electron-smoke.js')];
} else if (mode === 'ui') {
  args = [path.join(__dirname, 'electron-ui.js')];
} else if (mode === 'upstream') {
  args = [path.join(__dirname, 'upstream-features-ui-test.js')];
} else if (mode === 'selftest') {
  env.APKSTART_SELFTEST = '1';
  args = [path.join(__dirname, '..')];
} else {
  console.error(`未知模式：${mode}`);
  process.exit(2);
}

const scale = process.env.UI_AUDIT_SCALE;
if (scale && ['1', '1.25', '1.5', '2'].includes(scale)) args.unshift('--force-device-scale-factor=' + scale);
const child = spawn(electron, args, { env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron 被信号终止：${signal}`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});

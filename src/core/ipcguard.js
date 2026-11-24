'use strict';
/**
 * IPC 调用来源校验（纯函数，便于单元测试）
 *
 * 渲染层能发起的 IPC 有 90 多个通道，逐个 handler 里写校验既啰嗦又容易漏。
 * 这里把「这个页面是不是我们自己的页面」判定抽出来，主进程在注册 handler 前
 * 统一套一层，脚本注入/页面被导航到外部站点后都拿不到 IPC 能力。
 */
const path = require('path');
const { fileURLToPath } = require('url');

/**
 * child 是否在 parent 目录内部（真正的路径边界判断）
 * 不能用 startsWith：`C:\app-evil` 也以 `C:\app` 开头。
 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 页面 URL 是否属于本应用（file:// 且落在 root 目录内）。
 * @param {string} root 应用源码目录（绝对路径）
 * @param {string} raw  待判定的 URL
 */
function isTrustedFrameUrl(root, raw) {
  if (!root || typeof raw !== 'string' || !raw) return false;
  let url;
  try { url = new URL(raw); } catch (_) { return false; }
  if (url.protocol !== 'file:') return false;
  let file;
  try { file = fileURLToPath(url); } catch (_) { return false; }
  return isInside(root, file);
}

/**
 * 校验一次 IPC 事件的来源：必须是主框架，且页面在本应用目录内。
 * @returns {{ok:boolean, reason?:string, url?:string}}
 */
function checkEvent(root, event) {
  let frame = null;
  try { frame = event && event.senderFrame; } catch (_) { frame = null; }
  const wc = event && event.sender;
  const url = (frame && frame.url) || '';
  if (!wc) return { ok: false, reason: '没有关联的 webContents', url };
  if (!frame) return { ok: false, reason: '没有 senderFrame（页面已销毁）', url };
  let mainFrame = null;
  try { mainFrame = wc.mainFrame; } catch (_) { mainFrame = null; }
  if (!mainFrame || frame !== mainFrame) return { ok: false, reason: '来自子框架（iframe）', url };
  if (!isTrustedFrameUrl(root, url)) return { ok: false, reason: `来源不在应用目录内：${url || '(空)'}`, url };
  return { ok: true, url };
}

// 权限不能从 file: origin 推导。新增通道必须明确加入对应角色，默认拒绝。
const SHELL_CHANNELS = new Set([
  'app:i18n', 'app:theme',
  'shell:state', 'shell:minimize', 'shell:maximize', 'shell:close',
  'shell:rotate', 'shell:back', 'shell:forward', 'shell:home', 'shell:recent',
]);
const MAIN_CHANNELS = new Set([
  'app:info', 'app:i18n', 'app:theme', 'dialog:openDir', 'apps:list',
  'instances:list', 'instances:create', 'instances:launch',
  'peripherals:webcams', 'peripherals:refresh',
  'automation:target', 'automation:status', 'automation:validate',
  'automation:run', 'automation:action', 'automation:cancel',
  'apk:pick', 'apk:parse', 'apk:kind', 'apk:compat', 'apk:install', 'apk:reveal',
  'app:launch', 'app:uninstall', 'app:shortcut', 'app:clearData', 'app:pin',
  'app:revealApk', 'app:exportApk', 'app:backup', 'app:restore',
  'settings:get', 'settings:set', 'settings:setSharedDir', 'settings:restoreSystem',
  'settings:refreshPointer', 'settings:unhook',
  'system:list', 'system:detail', 'system:catalogRefresh', 'system:install',
  'system:confirmInstall', 'system:switch', 'system:stop', 'system:pause',
  'system:resume', 'system:cancel', 'system:retry', 'system:tasks', 'system:status',
  'system:openDir', 'system:backup', 'system:restore', 'system:remove',
  'system:importLineage', 'system:diskUsage', 'system:openWindowsFeatures',
  'display:state', 'display:set', 'display:toggle', 'shortcut:rebuild',
  'guest:state', 'guest:trim', 'guest:restore', 'guest:localize', 'guest:openLocaleSettings',
  'runtime:setImageFlavor', 'runtime:autoDeploy', 'runtime:status', 'runtime:probe',
  'runtime:androidHome', 'runtime:start', 'runtime:stop', 'runtime:log',
  'runtime:repairPlan', 'runtime:repairRun', 'runtime:vcRedist', 'runtime:installVcRedist',
  'runtime:usage', 'runtime:dataInfo', 'runtime:setDataSize', 'runtime:cleanup',
  'runtime:resetData', 'runtime:repairNetwork', 'runtime:checkNetwork',
  'runtime:startInstaller', 'runtime:markInstalled', 'runtime:resetInstall',
  'report:prepare', 'report:submit', 'report:folder',
  'doctor:profile', 'doctor:report', 'doctor:selfCheck', 'app:confirm',
  'provision:installEmulator', 'provision:installSysimg', 'provision:installPlayImage',
  'provision:installAehd', 'provision:enableAccel', 'provision:enableVirtualization',
  'provision:accelStatus', 'provision:installAdb', 'provision:installQemu',
  'provision:downloadIso', 'provision:createDisk', 'provision:importIso',
  'provision:importRuntimePack', 'provision:importDisk', 'provision:check', 'provision:probeSources',
  'image:status', 'image:inspect', 'image:import', 'image:activate',
  'image:restore', 'image:remove', 'image:reveal',
  'assoc:status', 'assoc:register', 'assoc:unregister', 'share:sync', 'share:open',
  'app:clearLocks', 'app:removeSelf', 'shell:open', 'shell:openPath', 'sys:drives',
  'wizard:open', 'wizard:close',
  'window:minimize', 'window:maximize', 'window:close', 'window:hide',
  'android:status', 'android:set', 'android:open', 'android:tune',
  'android:permissions', 'android:grantAll', 'app:foreground',
  'app:updateCheck', 'app:updateOpen', 'app:updateApply',
  'app:updateCancel', 'app:restart',
]);

/** 先验来源，再按主进程持有的实际窗口引用授权；绝不相信渲染层传来的角色或 id。 */
function authorizeEvent(root, event, channel, { mainWindow = null, shellWindow = null } = {}) {
  const origin = checkEvent(root, event);
  if (!origin.ok) return origin;
  const sender = event.sender;
  const owns = (win) => {
    try { return !!win && !win.isDestroyed() && win.webContents === sender && !sender.isDestroyed(); }
    catch (_) { return false; }
  };
  const role = owns(mainWindow) ? 'main' : owns(shellWindow) ? 'shell' : null;
  if (!role) return { ...origin, ok: false, reason: '未授权的 webContents' };
  // 同一个受信窗口导航到其它本地页面，也不能沿用它原来的页面权限。
  const expected = path.resolve(root, 'ui', role === 'main' ? 'index.html' : 'shell.html');
  let actual;
  try { actual = path.resolve(fileURLToPath(new URL(origin.url))); } catch (_) { actual = ''; }
  if (actual !== expected) return { ...origin, ok: false, reason: '页面与窗口角色不匹配' };
  const allowed = role === 'main' ? MAIN_CHANNELS : SHELL_CHANNELS;
  if (!allowed.has(channel)) return { ...origin, ok: false, reason: `${role} 角色无权调用 ${channel}` };
  return { ...origin, role };
}

module.exports = { isInside, isTrustedFrameUrl, checkEvent, authorizeEvent };

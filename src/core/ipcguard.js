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

module.exports = { isInside, isTrustedFrameUrl, checkEvent };

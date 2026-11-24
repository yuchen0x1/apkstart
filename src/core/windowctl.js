'use strict';
/**
 * 把 Android Emulator 的 Qt 窗口打扮成「一个应用一个原生窗口」。
 *
 * 为什么不投屏：无头模式下 SurfaceFlinger 不出 VSYNC（实测 screenrecord 3 秒只有 2 帧），
 * 软件投屏既卡又吃 CPU。带窗口的模拟器本身就是原生 60fps + 原生鼠标键盘，
 * 这里只做「改标题 / 换图标 / 设尺寸 / 全屏」这几下 Win32 操作，成本近乎为零。
 *
 * PowerShell 是 Windows 自带组件，脚本为纯 ASCII，中文标题通过 UTF-8 JSON 传入，
 * 避免 Windows PowerShell 5.1 按 ANSI 读 .ps1 造成乱码。
 * 任何失败都静默降级：窗口照样能用，只是没有改名/全屏。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');
const TIMEOUT = 8000;

function parseOut(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** @param {object} params { pid, action, title, icon, bounds } */
function call(params) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(SCRIPT) || !params || params.pid === undefined) {
      resolve(null);
      return;
    }
    const json = path.join(os.tmpdir(),
      `apkstart-wctl-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      fs.writeFileSync(json, JSON.stringify(params), 'utf8');
    } catch (_) { resolve(null); return; }

    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, json,
    ], { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 64 }, (err, stdout) => {
      try { fs.unlinkSync(json); } catch (_) { /* ignore */ }
      if (err) { resolve(null); return; }
      const r = parseOut(stdout);
      resolve(r.OK === '1' ? r : null);
    });
  });
}

function validIdentity(identity) {
  return !!identity && typeof identity === 'object'
    && !!String(identity.started || '')
    && !!String(identity.exe || '')
    && /^[0-9a-f]{64}$/i.test(String(identity.cmdHash || ''));
}

/** 读取当前窗口位置，用于「记住每个应用的窗口大小」 */
async function getBounds(pid, identity) {
  if (!validIdentity(identity)) return null;
  const r = await call({ pid, identity, action: 'get' });
  if (!r || !Number(r.W) || !Number(r.H)) return null;
  return {
    x: Number(r.X) || 0, y: Number(r.Y) || 0,
    w: Number(r.W), h: Number(r.H),
    maximized: r.MAX === '1',
  };
}

/**
 * 让运行时窗口表现为当前应用。
 * @param {object} o { pid, label, icon, mode:'window'|'fullscreen', bounds, screen }
 */
async function present(o) {
  const { pid, identity, label, icon, mode, bounds, screen } = o || {};
  // 只接受已验证的 PID。没有 PID 时宁可什么都不做，也不能按进程名去猜窗口 ——
  // 那会改到别的用户/别的实例的模拟器窗口。
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  // PID 会在调用间隙被系统复用；必须把调用方刚验证过的出生时间、真实路径
  // 与命令行哈希一起交给脚本，由脚本在持有一份进程句柄时复核。
  if (!validIdentity(identity)) return null;
  return call({
    pid,
    identity: {
      started: String(identity.started),
      exe: String(identity.exe),
      cmdHash: String(identity.cmdHash).toLowerCase(),
    },
    action: mode === 'fullscreen' ? 'fullscreen' : 'window',
    title: label || '',
    icon: icon && fs.existsSync(icon) ? icon : '',
    bounds: bounds || null,
    screen: mode === 'fullscreen' ? (screen || null) : null,
  });
}

async function focus(pid, identity) {
  if (!validIdentity(identity)) return null;
  return call({ pid, identity, action: 'focus' });
}

/** 通知资源管理器刷新图标/快捷方式，避免新建的桌面图标要按 F5 才出现 */
async function refreshShell() { return call({ pid: 0, action: 'refresh' }); }

module.exports = { call, getBounds, present, focus, refreshShell, SCRIPT };

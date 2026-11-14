'use strict';
/**
 * 本地代理检测与隧道（零依赖）。
 *
 * 很多用户挂着 Clash / v2rayN 这类代理工具（通常已写入系统代理），而 Node 的
 * http/https 模块【不会】自动走系统代理 —— 直连 GitHub 只有几十 KB/s 的机器，
 * 走代理实测能到十几 MB/s。这里统一解决「下载与查新走代理」：
 *
 * 检测顺序（命中即停）：
 *   1. 设置 runtime.proxyUrl 显式指定（填 off 强制直连）；
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY；
 *   3. Windows 系统代理（注册表 Internet Settings，Clash 开系统代理就会写这里）。
 *
 * 检测结果缓存 10 分钟：reg query 一次几十毫秒，而代理开关不会每分钟变。
 * 连接层提供 CONNECT 隧道（https）与绝对路径转发（http），供 download.js /
 * sources.js 在发起请求时选用；代理连接失败时由调用方回退直连。
 */
const http = require('http');
const tls = require('tls');
const { execFile } = require('child_process');
// 惰性引入会破坏缓存一致性，直接引：store 不依赖任何网络模块，无环
const store = require('./store');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const CACHE_TTL = 10 * 60 * 1000;

let _cache = { at: 0, proxy: '' };

/** 规范成 http://host:port 形式（缺协议时补 http://；代理工具基本都是 http 入口） */
function normalize(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

/** 解析注册表 ProxyServer：可能是 "127.0.0.1:7890" 或 "http=...;https=...;ftp=..." */
function parseProxyServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.includes(';') || s.includes('=')) {
    const m = /(?:^|;)\s*(?:https?|socks)\s*=\s*(?:https?:\/\/)?([^;]+)/i.exec(s);
    return m ? normalize(m[1]) : '';
  }
  return normalize(s);
}

/** 环境变量优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy > ALL_PROXY */
function fromEnv() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy || '';
}

/** 读 Windows 系统代理（reg query 两次；非 Windows / 读不到都返回空） */
function fromRegistry() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY, '/v', 'ProxyEnable'], { windowsHide: true, timeout: 4000 }, (e1, o1) => {
      if (e1 || !/0x1/.test(String(o1 || ''))) return resolve('');
      execFile('reg', ['query', REG_KEY, '/v', 'ProxyServer'], { windowsHide: true, timeout: 4000 }, (e2, o2) => {
        const m = /ProxyServer\s+REG_SZ\s+(.*)/i.exec(String(o2 || ''));
        resolve(m ? parseProxyServer(m[1]) : '');
      });
    });
  });
}

/** 把 "http://127.0.0.1:7890" 解析成 {host, port, protocol}；解析不了返回 null */
function toProxyObj(s) {
  try {
    const u = new URL(normalize(s));
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (!host || !port) return null;
    return { host, port, protocol: u.protocol.replace(':', '') };
  } catch (_) {
    return null;
  }
}

/**
 * 当前应使用的代理（{host, port, protocol} 或 null）。
 * @param {object} [settings] store.getSettings()（检测显式 runtime.proxyUrl 用）
 * @param {{force?:boolean}} [opts] force=true 跳过缓存（设置改完立即生效）
 */
async function getActiveProxy(settings, opts = {}) {
  const now = Date.now();
  if (!opts.force && _cache.at && now - _cache.at < CACHE_TTL) return _cache.proxy;
  // 调用方（download.js）没带 settings 时自己读：保证显式 runtime.proxyUrl 生效
  if (settings === undefined) settings = store.getSettings();
  let proxy = '';
  const explicit = String((settings && settings.runtime && settings.runtime.proxyUrl) || '').trim();
  if (explicit) {
    proxy = /^off$/i.test(explicit) ? '' : normalize(explicit);
  } else {
    proxy = fromEnv() || await fromRegistry();
  }
  const obj = toProxyObj(proxy);
  _cache = { at: now, proxy: obj };
  return obj;
}

/** 用户改了代理设置后调用：下一次请求立即重新检测 */
function resetCache() { _cache = { at: 0, proxy: '' }; }

/**
 * 通过 HTTP 代理对目标 host:port 发起 CONNECT 隧道，返回裸 socket。
 * 失败（代理拒绝/超时/目标不通）会 reject，调用方回退直连。
 */
function tunnel(proxy, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host, port: proxy.port,
      method: 'CONNECT', path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('代理 CONNECT 超时')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`));
      }
      socket.setTimeout(0);
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { getActiveProxy, tunnel, parseProxyServer, normalize, resetCache, fromEnv, toProxyObj };

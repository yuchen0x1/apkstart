'use strict';
/**
 * 下载器：支持重定向、断点续传、进度回调、SHA-256 校验
 * 只依赖 http/https，主进程与纯 Node 测试都可使用。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'ApkStart/0.3 (Windows; +https://github.com/yuchen0x1/apkstart)';
const proxyMod = require('./proxy');

/** 分块先停止所有请求并等待 worker 收尾，再允许调用方关闭共享文件。 */
async function runWorkers(chunks, worker, signal) {
  const controller = new AbortController();
  require('events').setMaxListeners(0, controller.signal);
  const abort = () => controller.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  if (signal && signal.aborted) abort();
  let failure = null;
  try {
    await Promise.allSettled(chunks.map(async (chunk) => {
      try { await worker(chunk, controller.signal); }
      catch (e) { if (!failure) failure = e; abort(); }
    }));
    if (failure) throw failure;
    if (controller.signal.aborted) throw new Error('下载已取消');
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
  }
}

function waitRetry(ms, signal) {
  if (signal && signal.aborted) return Promise.reject(new Error('下载已取消'));
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (err) reject(err); else resolve();
    };
    const abort = () => finish(new Error('下载已取消'));
    const timer = setTimeout(() => finish(), ms);
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function assertSecureUrl(target, previous = null) {
  if (target.protocol === 'https:') return;
  if (target.protocol === 'http:') {
    if (previous && previous.protocol === 'https:') {
      throw new Error(`下载安全策略拒绝 HTTPS 重定向降级到 HTTP：${target.href}`);
    }
    // 只给本地服务/测试保留 HTTP；绝不允许公网 HTTP。
    if (isLoopbackHost(target.hostname)) return;
  }
  throw new Error(`下载安全策略只允许 HTTPS 或回环 HTTP：${target.href}`);
}

function writeAllAt(fd, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const remaining = buffer.length - written;
    const count = fs.writeSync(fd, buffer, written, remaining, position + written);
    if (!Number.isInteger(count) || count <= 0 || count > remaining) {
      throw new Error(`文件写入返回无效字节数（返回 ${count}，剩余 ${remaining}）`);
    }
    written += count;
  }
  return written;
}

function assertChunkBytes(received, written, expected) {
  if (received !== expected || written !== expected) {
    throw new Error(`分块字节数不符（收到 ${received}，写入 ${written}，声明 ${expected}）`);
  }
}

function assertDownloadBytes(written, size, total) {
  // 分块文件预先截断到 total，仅凭文件长度无法发现未写入的空洞。
  if (written !== total || size !== total) {
    throw new Error(`下载不完整（写入 ${written}，文件长度 ${size}，应有 ${total} 字节）`);
  }
}

function openStream(url, {
  method = 'GET', headers = {}, redirects = 0, noProxy = false, timeout = 30000, signal, redirectAllowlist,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('下载已取消'));
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    let req;
    let u;
    try {
      u = new URL(url);
      assertSecureUrl(u);
    } catch (e) { reject(e); return; }
    const cleanup = () => { if (signal) signal.removeEventListener('abort', abort); };
    const abort = () => {
      cleanup();
      if (req) req.destroy(new Error('下载已取消'));
      reject(new Error('下载已取消'));
    };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const mod = u.protocol === 'http:' ? http : https;

    (async () => {
      // 自动检测本地代理（系统代理/环境变量）：有就走代理，
      // 代理本身连不上再回退直连 —— 挂着 Clash 的机器直连 GitHub 只有几十 KB/s，
      // 走代理实测十几 MB/s。noProxy 用于这次回退，避免死循环。
      // 回环地址（本地测试服务器/本地服务）永不走代理（标准 NO_PROXY 语义）
      const loopback = isLoopbackHost(u.hostname);
      const bypassProxy = loopback || proxyMod.isNoProxy(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80));
      let proxy = null;
      if (!noProxy && !bypassProxy) {
        try { proxy = await proxyMod.getActiveProxy(); } catch (_) { proxy = null; }
      }
      if (signal && signal.aborted) { cleanup(); return; }
      const base = { method, headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers } };
      if (proxy && u.protocol === 'https:') {
        // https 经代理：CONNECT 隧道上做端到端 TLS。
        // 注意：agent:false 时 Node 会忽略 options.createConnection（agent:false 新建的
        // 默认 Agent 不带它）→ 直接对代理端口做 TLS 握手 → 必然失败。必须显式传一个
        // 自定义 Agent；隧道内是端到端请求，path 用纯路径、Host 用目标域名。
        const tunnelAgent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        // 关键：https.Agent 构造函数【不读】options.createConnection（那是 http.Agent 的行为），
        // 默认的 createConnection 会拿请求里的 host:port（代理地址）直接做 TLS 握手 —— 必挂。
        // 覆盖实例方法：先 CONNECT 隧道，再在隧道上 TLS（servername=目标域名），返回已握手的 TLSSocket。
        tunnelAgent.createConnection = (opts2, cb2) => {
          // 隧道/TLS 握手阶段没有 socket，request 层的 timeout 事件不会触发，
          // 必须自己设死线，否则 CONNECT 挂死会让整块下载永久卡住。
          let done2 = false;
          const deadline = setTimeout(() => {
            if (done2) return;
            done2 = true;
            cb2(new Error('代理隧道建立超时'));
          }, timeout);
          const ok2 = (sock) => { if (!done2) { done2 = true; clearTimeout(deadline); cb2(null, sock); } };
          const fail2 = (e) => { if (!done2) { done2 = true; clearTimeout(deadline); cb2(e); } };
          proxyMod.tunnel(proxy, u.hostname, 443).then((raw) => {
            const ts = tls.connect({ socket: raw, servername: u.hostname });
            ts.once('secureConnect', () => ok2(ts));
            ts.once('error', fail2);
          }, fail2);
        };
        req = https.request({
          host: proxy.host, port: proxy.port, method,
          path: u.pathname + u.search,
          headers: { ...base.headers, Host: u.host }, agent: tunnelAgent, timeout,
        }, (res) => finishReq(res, req));
      } else {
        // HTTP 只允许直连回环，不使用代理或通过 DNS 解析 localhost。
        const localHttp = u.protocol === 'http:' ? {
          agent: false,
          ...(u.hostname === 'localhost' ? { hostname: '127.0.0.1' } : {}),
        } : {};
        req = mod.request(u, { ...base, ...localHttp, timeout }, (res) => finishReq(res, req));
      }
      // 连接阶段的兜底：timeout 事件没人监听就不会销毁请求 —— TCP 建立但
      // 响应不来（被墙/隧道挂死）时 fetchChunk 的空闲看门狗还没启动（它要等
      // 响应头回来才创建），整块下载会永久挂住（实测踩过：8 块下完 7 块，
      // 剩一块挂着 12 分钟无任何网络活动）。所以必须在请求层 destroy。
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (e) => {
        cleanup();
        if (signal && signal.aborted) return reject(new Error('下载已取消'));
        // 代理连不通（没开代理软件/端口变了）：立即回退直连，不能让用户卡死。
        // 注意不能用宽泛的 /connect/i —— 'disconnected' 里也有 connect，会误匹配。
        const etext = `${(e && e.code) || ''}${(e && e.name) || ''}${(e && e.message) || ''}`;
        if (proxy && !noProxy && /代理 CONNECT|ECONNREFUSED|ETIMEDOUT|AggregateError/i.test(etext)) {
          return resolve(openStream(url, {
            method, headers, redirects, noProxy: true, timeout, signal, redirectAllowlist,
          }));
        }
        reject(e);
      });
      req.end();
    })().catch((e) => { cleanup(); reject(e); });

    function finishReq(res, req) {
      cleanup();
      if (signal && signal.aborted) { res.destroy(); return reject(new Error('下载已取消')); }
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let next;
        try {
          const target = new URL(res.headers.location, u);
          assertSecureUrl(target, u);
          if (redirectAllowlist && !redirectAllowlist(target)) {
            throw new Error(`下载安全策略拒绝跳转到未授权主机：${target.hostname}`);
          }
          next = target.href;
        } catch (e) {
          res.destroy();
          return reject(e);
        }
        res.resume();
        return resolve(openStream(next, {
          method, headers, redirects: redirects + 1, noProxy, timeout, signal, redirectAllowlist,
        }));
      }
      res.downloadUrl = url; // strong ETag 只在同一最终资源 URL 内有意义。
      resolve(res);
    }
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return hashFile(file, 'sha256');
}

/** 流式计算文件哈希（sha256 / sha1 都用这一份实现） */
function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 下载完成后的完整性校验；失败时删文件并抛错（expectSha256 / expectSha1 二选一） */
async function verifyChecksum(dest, opt) {
  const { expectSha256, expectSha1 } = opt || {};
  if (expectSha256) {
    const actual = await hashFile(dest, 'sha256');
    if (actual.toLowerCase() !== String(expectSha256).toLowerCase()) {
      fs.rmSync(dest, { force: true });
      throw new Error(`SHA-256 校验失败：期望 ${String(expectSha256).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
    }
  }
  if (expectSha1) {
    const actual = await hashFile(dest, 'sha1');
    if (actual.toLowerCase() !== String(expectSha1).toLowerCase()) {
      fs.rmSync(dest, { force: true });
      throw new Error(`SHA-1 校验失败（下载内容与官方索引不符）：期望 ${String(expectSha1).slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
    }
  }
}

// weak ETag / Last-Modified / 长度 / 尾部抽样均不能证明内容身份。
function strongETag(headers) {
  const tag = headers.etag;
  return typeof tag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(tag) ? tag : '';
}

function responseETag(res) {
  return !res.headers['content-encoding'] || res.headers['content-encoding'].toLowerCase() === 'identity'
    ? strongETag(res.headers) : '';
}

function checksumIdentity(opt) {
  const hashes = [];
  for (const [name, len] of [['expectSha256', 64], ['expectSha1', 40]]) {
    if (!opt[name]) continue;
    const value = String(opt[name]).toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${len}}$`).test(value)) throw new Error(`${name} 格式无效`);
    hashes.push(`${name}:${value}`);
  }
  return hashes.join('|');
}

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeMeta(file, value) {
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
    fs.renameSync(`${file}.tmp`, file);
  } catch (_) {
    // 元数据失败不能导致下一轮误用旧的身份。
    fs.rmSync(file, { force: true });
  }
}

function discardPartial(dest) {
  for (const file of [dest, `${dest}.download.json`, `${dest}.chunks.json`]) fs.rmSync(file, { force: true });
}

function contentRange(res) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
  if (!m) return null;
  const [start, end, total] = m.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total
    ? { start, end, total } : null;
}

/**
 * 下载到本地文件（自动续传）。
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, expectSha1, idleMs, retries }
 */
async function download(url, dest, opt = {}) {
  if (opt.signal && opt.signal.aborted) throw new Error('下载已取消');
  opt = { ...opt };
  const { onProgress = () => {}, signal, retries = 2 } = opt;
  const checksum = checksumIdentity(opt);
  const meta = `${dest}.download.json`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(`${dest}.chunks.json`)) discardPartial(dest);

  let attempt = 0;
  for (;;) {
    attempt++;
    const st = fs.existsSync(dest) ? fs.statSync(dest) : null;
    const m = readMeta(meta);
    const sameFile = st && m && m.v === 1 && m.url === url && typeof m.finalUrl === 'string'
      && m.size === st.size && m.mtimeMs === st.mtimeMs && m.ctimeMs === st.ctimeMs
      && m.ino === st.ino && m.dev === st.dev;
    const resumable = sameFile && strongETag({ etag: m.etag });
    const trustedChecksumPartial = sameFile && checksum && m.checksum === checksum;
    const existing = st && (resumable || trustedChecksumPartial) ? st.size : 0;
    const headers = {};
    if (existing) {
      headers.Range = `bytes=${existing}-`;
      if (resumable) headers['If-Range'] = m.etag;
    }

    const res = await openStream(url, { headers, signal, redirectAllowlist: opt.redirectAllowlist });
    if (signal && signal.aborted) { res.destroy(); throw new Error('下载已取消'); }

    const etag = responseETag(res);
    const cr = res.statusCode === 206 ? contentRange(res) : null;
    const contentLength = res.headers['content-length'] === undefined ? null : Number(res.headers['content-length']);
    const validResume = existing && cr && cr.start === existing && cr.end === cr.total - 1
      && (contentLength === null || Number.isSafeInteger(contentLength) && contentLength === cr.end - cr.start + 1)
      && (checksum ? m && m.checksum === checksum && m.finalUrl === res.downloadUrl
        && (!m.total || m.total === cr.total) : (resumable && m.finalUrl === res.downloadUrl
          && m.etag === etag && (!m.total || m.total === cr.total)));
    if (existing && (res.statusCode === 416 || (res.statusCode === 206 && !validResume))) {
      // 416 不等于已完整；无身份、换版或范围不符时改用完整 GET，不耗网络重试额度。
      res.destroy();
      discardPartial(dest);
      attempt--;
      continue;
    }
    if (res.statusCode !== 200 && !(res.statusCode === 206 && validResume)) {
      res.destroy();
      if (attempt <= retries) { await waitRetry(1500, signal); continue; }
      throw new Error(`下载失败 HTTP ${res.statusCode}: ${url}`);
    }

    const total = cr ? cr.total : contentLength;
    const startSize = cr ? existing : 0;
    const expectedBody = cr ? cr.end - cr.start + 1 : contentLength;
    // 先移除旧身份，成功关闭写流后再记录新的部分文件；崩溃时宁可重下。
    fs.rmSync(meta, { force: true });
    if (!startSize) fs.rmSync(dest, { force: true });

    const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
    const savePartialMeta = () => {
      if (!fs.existsSync(dest) || (!etag && !checksum)) {
        fs.rmSync(meta, { force: true });
        return;
      }
      try {
        const partialStat = fs.statSync(dest);
        if (!partialStat.size) return;
        writeMeta(meta, {
          v: 1, url, finalUrl: res.downloadUrl, etag, checksum,
          total: total || 0, size: partialStat.size,
          mtimeMs: partialStat.mtimeMs, ctimeMs: partialStat.ctimeMs,
          ino: partialStat.ino, dev: partialStat.dev,
        });
      } catch (_) { fs.rmSync(meta, { force: true }); }
    };

    try {
      await new Promise((resolve, reject) => {
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        let responseEnded = false;
        let settled = false;
        let idle = null;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });
        const clear = () => {
          if (idle) clearTimeout(idle);
          if (signal) signal.removeEventListener('abort', onAbort);
        };
        const fail = (err) => {
          if (settled) return;
          settled = true;
          clear();
          res.unpipe(ws);
          res.destroy();
          // flush bytes already accepted by the file stream so a strong validator or
          // trusted digest can make the partial file safely resumable on the next try.
          let done = false;
          const finish = () => { if (!done) { done = true; reject(err); } };
          ws.once('close', finish);
          ws.once('error', () => {});
          try { ws.end(); } catch (_) { finish(); }
          if (ws.closed) finish();
        };
        const succeed = () => {
          if (settled) return;
          settled = true;
          clear();
          resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => fail(new Error('连接停滞（长时间无数据）')), idleMs);
        };
        const onAbort = () => fail(new Error('下载已取消'));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        kick();

        res.on('data', (c) => {
          if (settled) return;
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        res.on('end', () => {
          responseEnded = true;
          const bodyBytes = got - startSize;
          if (expectedBody !== null && bodyBytes !== expectedBody) {
            fail(new Error(`响应字节数不符（收到 ${bodyBytes}，声明 ${expectedBody}）`));
            return;
          }
          if (total !== null && got !== total) {
            fail(new Error(`下载不完整（收到 ${got}，声明 ${total}）`));
          }
        });
        ws.on('finish', () => {
          if (!responseEnded) fail(new Error('响应在文件写入完成前结束'));
          else if (!settled) succeed();
        });
        ws.on('error', (e) => fail(e));
        res.on('error', (e) => fail(e));
        res.on('close', () => { if (!responseEnded && !res.complete) fail(new Error('连接被中断')); });
      });
    } catch (e) {
      savePartialMeta();
      throw e;
    }
    fs.rmSync(meta, { force: true });
    break;
  }

  if (signal && signal.aborted) throw new Error('下载已取消');
  // 收尾：确保进度条走到 100%
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  await verifyChecksum(dest, opt);
  return { file: dest, size: fs.statSync(dest).size };
}

/**
 * 并行分块下载（大文件专用）。
 * 单条 TCP 连接在部分镜像上会被限速到几十 KB/s，分块并发能显著提升实际吞吐。
 * 仅在「目标文件不存在」时并行；已有部分文件时退回单流续传，避免分块状态丢失。
 */
async function downloadParallel(url, dest, opt = {}) {
  if (opt.signal && opt.signal.aborted) throw new Error('下载已取消');
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
    signal,
  } = opt;

  // 分块下载留下的「带洞」文件（边车元数据还在）绝不能走单流续传：
  // Range 只知道文件大小，不知道中间哪些块还没下，续出来必然是坏文件。
  // 删掉整套残骸，让分块流程带元数据重来（它只会补缺的块）。
  if (fs.existsSync(`${dest}.chunks.json`)) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(`${dest}.chunks.json`, { force: true });
  }

  // 已有部分文件 → 交给单流续传
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // 探测是否支持 Range，并固定所有并行请求所对应的同一资源身份。
  const checksum = checksumIdentity(opt);
  let total = 0;
  let supportsRange = false;
  let identity = null;
  try {
    const probe = await openStream(url, {
      headers: { Range: 'bytes=0-0' }, signal, redirectAllowlist: opt.redirectAllowlist,
    });
    const cr = probe.statusCode === 206 ? contentRange(probe) : null;
    const length = probe.headers['content-length'] === undefined ? null : Number(probe.headers['content-length']);
    if (cr && cr.start === 0 && cr.end === 0 && (length === null || length === 1)) {
      supportsRange = true;
      total = cr.total;
      identity = { finalUrl: probe.downloadUrl, etag: responseETag(probe) };
    }
    probe.destroy();
  } catch (_) { /* 探测失败则走单流 */ }

  if (!supportsRange || !total || total < minChunk * 2 || (!checksum && !identity.etag)) {
    return download(url, dest, opt);
  }

  if (signal && signal.aborted) throw new Error('下载已取消');
  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // 先建空文件并定位到末字节，避免后续 write 越界
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c, signal) => {
    if (signal && signal.aborted) throw new Error('下载已取消');
    const requestHeaders = { Range: `bytes=${c.pos}-${c.end}` };
    if (identity.etag) requestHeaders['If-Range'] = identity.etag;
    const res = await openStream(url, {
      headers: requestHeaders, signal, redirectAllowlist: opt.redirectAllowlist,
    });
    if (signal && signal.aborted) { res.destroy(); throw new Error('下载已取消'); }
    if (res.statusCode !== 206) {
      res.destroy();
      throw new Error(`分块请求被拒绝 HTTP ${res.statusCode}`);
    }
    // 并行的所有范围必须来自探测时的同一最终 URL 和同一强 ETag。
    const responseTag = responseETag(res);
    if (res.downloadUrl !== identity.finalUrl || (identity.etag && responseTag !== identity.etag)) {
      res.destroy();
      throw new Error('分块资源身份变化（最终 URL 或 strong ETag 不一致）');
    }
    const range = contentRange(res);
    const contentLength = res.headers['content-length'] === undefined ? null : Number(res.headers['content-length']);
    if (!range || range.start !== c.pos || range.end > c.end || range.total !== total
      || (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength !== range.end - range.start + 1))) {
      res.destroy();
      throw new Error(`分块范围或字节长度不符（请求 ${c.pos}-${c.end}，返回 ${res.headers['content-range'] || '无 Content-Range'}）`);
    }
    // 服务器可能只返回请求范围的前一截：剩下的下一轮接着取。
    await new Promise((resolve, reject) => {
      // 必须自己兜住「promise 永远不 settle」：res.destroy(err) 在某些情况下只发
      // close 不发 error，没有这个 guard 的话一整块会挂死，整个下载停在那里不动。
      let settled = false;
      let received = 0;
      let written = 0;
      const expectedBytes = range.end - range.start + 1;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (signal) signal.removeEventListener('abort', onAbort);
        res.destroy();
        if (err) reject(err); else resolve();
      };
      // 外部中断（上层判定这个源太慢、要换路）：立刻断流抛出，别在坏源上耗着。
      // abort 触发后 close/error 都会来，但 finish 已 settle，重复无害。
      const onAbort = () => { res.destroy(); finish(new Error('下载已取消')); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let idle = setTimeout(() => { res.destroy(); finish(new Error('连接停滞（长时间无数据）')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('连接停滞（长时间无数据）')); }, idleMs);
      };
      res.on('data', (buf) => {
        if (settled || (signal && signal.aborted)) return;
        received += buf.length;
        // 响应实体必须严格匹配声明范围；多字节不能悄悄截断后冒充有效分块。
        if (received > expectedBytes) return finish(new Error('分块响应超过 Content-Range 声明长度'));
        let count;
        try {
          count = writeAllAt(fd, buf, c.pos);
        } catch (e) {
          // 没写完的 buffer 不推进断点，下次从原位置完整重写。
          return finish(e);
        }
        written += count;
        c.pos += count;
        got += count;
        kick();
        tick();
      });
      res.on('end', () => {
        try { assertChunkBytes(received, written, expectedBytes); }
        catch (e) { return finish(e); }
        finish();
      });
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('连接被中断')));
    });
    return c.pos > c.end;
  };

  let size;
  try {
    await runWorkers(chunks, async (c, workerSignal) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c, workerSignal);
          if (ok) return;
          throw new Error('分块未完整返回');
        } catch (e) {
          if (workerSignal.aborted) throw e;
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`分块下载失败（${c.start}-${c.end}）：${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await waitRetry(800 * c.tries, workerSignal);
        }
      }
    }, signal);
    size = fs.fstatSync(fd).size;
    assertDownloadBytes(got, size, total);
  } catch (e) {
    fs.closeSync(fd);
    // 预分配的稀疏文件在这里就是「全零毒丸」：不删掉的话，上层换源重试会把它
    // 当成「已下载的部分文件」去续传，远端回 416，一份内容全零、大小正确的
    // 坏文件就完成了。失败必须连残骸一起清掉。
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    throw e;
  }
  fs.closeSync(fd);

  onProgress({ got, total, percent: 100, speed: 0, eta: 0 });
  await verifyChecksum(dest, opt);
  return { file: dest, size, parallel: n };
}

/** 依次尝试多个源，任一成功即返回 */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      if (opt.signal && opt.signal.aborted) throw e;
      errors.push(`${u} → ${e.message}`);
    }
  }
  throw new Error(`所有下载源均失败：\n${errors.join('\n')}`);
}

/**
 * 多源同时下载：把文件切成若干块，**不同块同时从不同源拉**，带宽叠加。
 *
 * 为什么需要：GitHub 单连接限速很常见，而镜像站通常也各自限速；
 * 8 条连接都指向同一个地址时，天花板就是那个地址的上限。把 4 条给 GitHub、
 * 4 条给镜像，两者上限相加，实测能快一倍以上。
 *
 * 安全前提：只有调用方提供可信 SHA-256/SHA-1 时才跨源混块；仅长度相等不证明内容相同。
 * 任一源中途失败，它的分块会自动换到下一条可用地址重试，最终摘要验证整包。
 */
async function downloadMulti(urls, dest, opt = {}) {
  if (opt.signal && opt.signal.aborted) throw new Error('下载已取消');
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    signal,
    // 每个分块的重试次数。3 次在「三个源里有两个偶尔停摆」的链路上不够用：
    // 1.4GB 的运行时包一旦有块耗尽重试，整包作废重下。给到 6 次（每源两轮）。
    // 重试是从断点继续的（c.pos 保留），不会重复下载已收到的字节。
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  const checksum = checksumIdentity(opt);

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('没有可用的下载地址');
  if (list.length === 1) return downloadParallel(list[0], dest, opt);
  // 没有可信摘要时，多个镜像只能作为故障转移，不能把不同镜像的块拼在一起。
  // downloadAnyParallel 仍保留单个源的 ETag/final URL 锁定与分块能力。
  if (!checksum) return downloadAnyParallel(list, dest, opt);

  // 1) 并行探测：总大小 + Range + 每个响应最终 URL 与 strong ETag。
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, {
        headers: { Range: 'bytes=0-0' }, signal, redirectAllowlist: opt.redirectAllowlist,
      });
      const cr = res.statusCode === 206 ? contentRange(res) : null;
      const length = res.headers['content-length'] === undefined ? null : Number(res.headers['content-length']);
      const valid = cr && cr.start === 0 && cr.end === 0
        && (length === null || Number.isSafeInteger(length) && length === 1);
      const probe = {
        url: u, total: valid ? cr.total : 0, ranged: !!valid,
        finalUrl: res.downloadUrl, etag: responseETag(res),
      };
      res.destroy();
      return probe;
    } catch (_) {
      return { url: u, total: 0, ranged: false, finalUrl: '', etag: '' };
    }
  }));

  if (signal && signal.aborted) throw new Error('下载已取消');
  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // 只混用「声明总大小一致」的源，否则会拼出坏文件。
  // 基准取**实测最快那个源的总大小**（usable 的顺序就是 rank() 排好的速度序，
  // 探测是 Promise.all 但结果按输入顺序返回）：
  // 不同镜像或历史载荷可能声明不同大小；固定取 Math.max 会把更快的
  // 地址排除，因此基准必须取测速后排在最前面的可用地址。
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) 切块，轮转分配源
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 分块断点续传：1.4GB 的包在「镜像偶尔停摆」的链路上很容易有块耗尽重试，
  // 一旦整包作废重下，用户要再等十几分钟。这里把「哪些块已经下完」记在
  // 边车文件里，下次（同一路径、同一分块方式）只补缺的块。
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  const starts = new Set(Array.from({ length: n }, (_, i) => i * per));
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    const done = Array.isArray(m && m.done) ? m.done : [];
    if (m && m.v === 1 && m.identity === checksum && m.total === total && m.n === n
      && done.every((start) => Number.isSafeInteger(start) && starts.has(start))
      && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(done);
      resume = true;
    }
  } catch (_) { /* 没有边车就全新下 */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // 必须显式初始化：undefined < 2 是 false，换源永远不会触发
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ v: 1, identity: checksum, total, n, done: [...doneSet] }));
    } catch (_) { /* 边车写不进去不影响下载 */ }
  };

  // 续传时把已完成的块算进进度，用户看到的百分比不会从 0 重来
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // 低速换源：某一块从某个源只跑到几十 KB/s 时，光等它下完会把整个下载拖成
  // 「卡在 95% 不动」。跑够 slowAfterMs 且平均速度低于 slowBps 就中断、换下一个源
  // （从断点继续，不丢数据）。每块最多换 2 次，避免在几个慢源之间来回横跳。
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c, signal) => {
    if (signal && signal.aborted) throw new Error('下载已取消');
    const url = same[c.src % same.length].url;
    const res = await openStream(url, {
      headers: { Range: `bytes=${c.pos}-${c.end}` }, signal, redirectAllowlist: opt.redirectAllowlist,
    });
    if (signal && signal.aborted) { res.destroy(); throw new Error('下载已取消'); }
    if (res.statusCode !== 206) {
      res.destroy();
      throw new Error(`分块被拒绝 HTTP ${res.statusCode}`);
    }
    // 只检查 206 不够（上游 issue #91）：服务器返回一个错位/越界的 Content-Range 时，
    // 下面的 fs.writeSync 仍按 c.pos 写 —— 文件长度刚好对上，内容却整体错位，
    // 最后表现为「镜像/安装包校验失败」或运行时莫名崩溃，极难定位。
    // 所以起点必须与请求一致，总长必须与整包一致；终点以两者交集为界。
    const range = contentRange(res);
    const contentLength = res.headers['content-length'] === undefined ? null : Number(res.headers['content-length']);
    if (!range || range.start !== c.pos || range.end > c.end || range.total !== total
      || (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength !== range.end - range.start + 1))) {
      res.destroy();
      throw new Error(`分块范围或字节长度不符（请求 ${c.pos}-${c.end}，返回 ${res.headers['content-range'] || '无 Content-Range'}）`);
    }
    // 服务器可能只返回了请求范围的前一截：写到声明终点为止，剩下的下一轮接着取
    const limit = range.end;
    const startPos = c.pos;
    const startedAt = Date.now();
    // 同一条连接 destroy 之后仍可能再收到已缓冲的包，会重复触发换源、把源跳过头，
    // 所以每次请求只允许换一次。
    let rotated = false;
    await new Promise((resolve, reject) => {
      // 空闲看门狗 + 「保证 settle」：连接建立了但一个字节都不来（常见的
      // 「TCP 通但被墙/被限」），光等 socket 超时要 30 秒；而 res.destroy(err)
      // 可能只发 close 不发 error，promise 就永远不会 reject —— 表现是一块挂死、
      // 整个下载停在那里（实测踩过）。所以看门狗自己调用 finish。
      let settled = false;
      let received = 0;
      let written = 0;
      const expectedBytes = range.end - range.start + 1;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (signal) signal.removeEventListener('abort', onAbort);
        res.destroy();
        if (err) reject(err); else resolve();
      };
      // 外部中断：立刻断流抛出（保留了 c.pos 断点，换路重下不浪费已收字节）
      const onAbort = () => { res.destroy(); finish(new Error('下载已取消')); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      let idle = setTimeout(() => { res.destroy(); finish(new Error('连接停滞（长时间无数据）')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('连接停滞（无数据超时）')); }, idleMs);
      };
      res.on('data', (buf) => {
        if (settled || (signal && signal.aborted)) return;
        received += buf.length;
        if (received > expectedBytes) return finish(new Error('分块响应超过 Content-Range 声明长度'));
        let count;
        try {
          count = writeAllAt(fd, buf, c.pos);
        } catch (e) {
          // 没写完的 buffer 不推进断点，下次从原位置完整重写。
          return finish(e);
        }
        written += count;
        c.pos += count;
        got += count;
        kick();
        tick(false);
        // 还没下完就慢到不可接受 → 换源（c.pos 已前进，下次从断点继续）
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // 这里不推进 c.src：换源统一由下面的 catch 做，否则一次失败会跳两个源
            res.destroy();
            finish(new Error(`该源速度过低（${(bps / 1024).toFixed(0)} KB/s），换源重试`));
          }
        }
      });
      res.on('end', () => {
        try { assertChunkBytes(received, written, expectedBytes); }
        catch (e) { return finish(e); }
        finish();
      });
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('连接被中断')));
    });
    return c.pos > c.end;
  };

  let size;
  try {
    await runWorkers(chunks, async (c, workerSignal) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c, workerSignal)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error('分块未完整返回');
        } catch (e) {
          if (workerSignal.aborted) {
            saveMeta();
            throw new Error(`分块失败（${c.start}-${c.end}）：${e.message}`);
          }
          c.tries += 1;
          if (c.tries >= retries) {
            saveMeta();
            throw new Error(`分块失败（${c.start}-${c.end}）：${e.message}`);
          }
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await waitRetry(600 * c.tries, workerSignal);
        }
      }
    }, signal);
    size = fs.fstatSync(fd).size;
    assertDownloadBytes(got, size, total);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  tick(true);
  await verifyChecksum(dest, opt);
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** 依次尝试多个源（并行分块版），任一成功即返回 */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      if (opt.signal && opt.signal.aborted) throw e;
      errors.push(`${u} → ${e.message}`);
    }
  }
  throw new Error(`所有下载源均失败：\n${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti, head, sha256File, hashFile, openStream,
};

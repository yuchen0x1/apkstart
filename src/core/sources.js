'use strict';
/**
 * Signed Release manifest metadata and verified download source selection.
 *
 * Version metadata comes from the signed latest.json asset; the REST API is a
 * controlled fallback. Downloads never trust user-configured or public relays.
 */
const https = require('https');
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { cmpVer } = require('./version');
const proxyMod = require('./proxy');
const {
  assetNames, readManifest, matchAsset, marker, repo,
  verifyLatestManifest, latestManifestName,
} = require('./release-manifest');

const OWNER = 'yuchen0x1';
const REPOSITORY = 'apkstart';
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPOSITORY}`;

const MANIFEST_URL = `https://github.com/${OWNER}/${REPOSITORY}/releases/latest/download/${latestManifestName}`;
const CACHE_TTL = 30 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

/**
 * 一次测速的采样字节数。
 * 128KB 太小：握手 + TLS 就有几百毫秒，测出来的「速度」其实主要在测延迟，
 * 会把「延迟高但带宽大」的源误判成慢。256KB 能把两者分开，流量也可以接受。
 */
const SAMPLE_BYTES = 256 * 1024;

class HttpStatusError extends Error {
  constructor(url, response) {
    const status = Number(response.status) || 0;
    super(`${new URL(url).host} HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.headers = response.headers || {};
    this.body = response.body;
    this.url = url;
  }
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function responseJson(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return JSON.parse(Buffer.from(body).toString('utf8').replace(/^\uFEFF/, ''));
  }
  if (typeof body === 'string') return JSON.parse(body.replace(/^\uFEFF/, ''));
  if (body && typeof body === 'object') return body;
  throw new Error('更新服务器返回空数据');
}

function rateLimitUntil(response, now, floorMs) {
  const retryAfter = header(response.headers, 'retry-after').trim();
  let retryAt = 0;
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) retryAt = now + Math.ceil(Number(retryAfter) * 1000);
  else if (retryAfter) {
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) retryAt = date;
  }
  const reset = Number(header(response.headers, 'x-ratelimit-reset'));
  const resetAt = Number.isSafeInteger(reset) && reset > 0 ? reset * 1000 : 0;
  return Math.max(now + floorMs, retryAt, resetAt);
}

function isRateLimited(response) {
  if (Number(response.status) === 429) return true;
  if (Number(response.status) !== 403) return false;
  const remaining = header(response.headers, 'x-ratelimit-remaining');
  const message = typeof response.body === 'string'
    ? response.body
    : response.body && typeof response.body.message === 'string' ? response.body.message : '';
  return remaining === '0' || !!header(response.headers, 'retry-after')
    || /rate limit exceeded|secondary rate limit/i.test(message);
}

function classifyFailure(error, response) {
  const status = response ? Number(response.status) : Number(error && error.status) || 0;
  if (status === 403) return isRateLimited(response || error) ? 'rate-limit' : 'forbidden';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'not-found';
  if (status >= 500) return 'server';
  if (error && (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')) return 'dns';
  if (error && (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED'
    || /timeout|timed out|超时/i.test(error.message || ''))) return 'timeout';
  if (status) return 'http';
  return 'network';
}

function allowlistedManifestRedirect(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'github.com' || host === 'api.github.com'
    || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')
    || /^github-production-release-asset-[a-f0-9]+\.s3\.amazonaws\.com$/.test(host);
}

function openUrl(url, {
  method = 'GET', timeout = 10000, headers = {}, redirects = 0, noProxy = false, redirectAllowlist,
} = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('地址无效')); }
    const mod = u.protocol === 'http:' ? http : https;

    (async () => {
      // 与 download.js 同一套代理策略：检测到本地代理（系统代理/环境变量）就走，
      // 代理连不通自动回退直连。查新 API 与测速都从这里走，挂 Clash 的机器
      // 「检查更新」从几十秒降到几百毫秒，测速结果也反映代理的真实带宽。
      // 回环地址（本地测试服务器/本地服务）永不走代理（标准 NO_PROXY 语义）
      const loopback = /^(127\.|localhost$|\[::1\]|::1$)/i.test(u.hostname);
      const bypassProxy = loopback || proxyMod.isNoProxy(u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80));
      let proxy = null;
      if (!noProxy && !bypassProxy) {
        try { proxy = await proxyMod.getActiveProxy(); } catch (_) { proxy = null; }
      }
      const base = {
        method,
        headers: {
          'User-Agent': 'ApkStart/0.3 (Windows)',
          'Accept-Encoding': 'identity',
          ...headers,
        },
      };
      let req;
      if (proxy && u.protocol === 'https:') {
        // agent:false 会忽略 options.createConnection（Node 新建默认 Agent 不带它），
        // 必须显式给自定义 Agent；隧道内是端到端请求，path 用纯路径、Host 用目标域名。
                const tunnelAgent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        // 关键：https.Agent 构造函数【不读】options.createConnection（那是 http.Agent 的行为），
        // 默认的 createConnection 会拿请求里的 host:port（代理地址）直接做 TLS 握手 —— 必挂。
        // 覆盖实例方法：先 CONNECT 隧道，再在隧道上 TLS（servername=目标域名），返回已握手的 TLSSocket。
        tunnelAgent.createConnection = (opts2, cb2) => {
          proxyMod.tunnel(proxy, u.hostname, 443).then((raw) => {
            const ts = tls.connect({ socket: raw, servername: u.hostname });
            ts.once('secureConnect', () => cb2(null, ts));
            ts.once('error', (e) => cb2(e));
          }, (e) => cb2(e));
        };
        req = https.request({
          host: proxy.host, port: proxy.port, method,
          path: u.pathname + u.search,
          headers: { ...base.headers, Host: u.host }, agent: tunnelAgent, timeout,
        }, finishReq);
      } else if (proxy && u.protocol === 'http:') {
        req = http.request({
          host: proxy.host, port: proxy.port, method,
          path: u.href, headers: { ...base.headers, Host: u.host },
          agent: false, timeout,
        }, finishReq);
      } else {
        req = mod.request(url, { ...base, timeout }, finishReq);
      }
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (e) => {
        // 不能用宽泛的 /connect/i —— 'disconnected' 里也有 connect，会误匹配
        const etext = `${(e && e.code) || ''}${(e && e.name) || ''}${(e && e.message) || ''}`;
        if (proxy && !noProxy && /代理 CONNECT|ECONNREFUSED|ETIMEDOUT|AggregateError/i.test(etext)) {
          return resolve(openUrl(url, {
            timeout, headers, redirects, noProxy: true, redirectAllowlist,
          }));
        }
        reject(e);
      });
      req.end();

      function finishReq(res) {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let target;
          try {
            target = new URL(res.headers.location, u);
          } catch (_) {
            return reject(new Error('更新请求包含无效重定向地址'));
          }
          if (redirectAllowlist && !redirectAllowlist(target)) {
            return reject(new Error(`更新请求重定向到未授权主机：${target.hostname}`));
          }
          if (target.protocol !== 'https:' && u.protocol === 'https:') {
            return reject(new Error('下载源重定向到非 HTTPS 地址'));
          }
          const nextHeaders = { ...headers };
          if (target.origin !== u.origin) {
            for (const key of Object.keys(nextHeaders)) {
              if (key.toLowerCase() === 'authorization') delete nextHeaders[key];
            }
          }
          openUrl(target.href, {
            timeout, headers: nextHeaders, redirects: redirects + 1, noProxy, redirectAllowlist,
          }).then(resolve, reject);
          return;
        }
        res.responseUrl = url;
        resolve(res);
      }
    })().catch(reject);
  });
}

/** 取 JSON 响应及状态、响应头（带重定向、超时、大小上限）。 */
async function getJsonResponse(url, { timeout = 10000, headers = {}, redirectAllowlist } = {}) {
  const res = await openUrl(url, { timeout, headers, redirectAllowlist });
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > MAX_JSON_BYTES) {
        res.destroy(new Error('更新服务器响应超过大小限制'));
        reject(new Error('更新服务器响应超过大小限制'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  let body = text;
  try { body = JSON.parse(text); } catch (_) { /* keep text for useful HTTP error classification */ }
  return { status: res.statusCode, headers: res.headers, body, finalUrl: res.responseUrl || url };
}

/**
 * 真下载一小段字节来测速度。
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // 吞吐只算「开始收到字节之后」的时间：TLS 握手 + DNS 那几百毫秒是固定开销，
      // 对 1.4GB 的包几乎不影响总耗时，混进速度里会把判断带偏。
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // 资产本身比样本还小：读到 EOF 也算成功
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

function atomicWriteJson(file, value) {
  if (!file) return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (_) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* keep the original error */ }
    }
    try { fs.rmSync(temp, { force: true }); } catch (_) { /* cache failure is non-fatal */ }
  }
}

class Sources {
  constructor(settingsFn, options = {}) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this.publicKey = options.publicKey;
    this.manifestUrl = options.manifestUrl || MANIFEST_URL;
    this.apiBase = options.apiBase || API_BASE;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.requestJson = typeof options.requestJson === 'function'
      ? options.requestJson
      : (url, init) => getJsonResponse(url, init);
    this.cacheFile = options.cacheFile || '';
    this.apiRetryFloorMs = Math.max(1000, Number(options.apiRetryFloorMs) || 60 * 1000);
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    this._cachedAt = 0;
    this._latest = null;
    this._latestFlight = null;
    this._apiRetryAt = 0;
    this._apiFailures = 0;
    this._cacheRecord = { schemaVersion: 1, cachedAt: 0, latest: null, apiRetryAt: 0, apiFailures: 0 };
    this._loadCache();
  }

  _loadCache() {
    if (!this.cacheFile) return;
    try {
      const record = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (!record || record.schemaVersion !== 1) return;
      this._cacheRecord = record;
      this._apiRetryAt = Number(record.apiRetryAt) || 0;
      this._apiFailures = Math.max(0, Number(record.apiFailures) || 0);
      let result = null;
      if (record.latest && record.latest.kind === 'manifest') {
        const manifest = verifyLatestManifest(record.latest.value, this.publicKey);
        result = this._fromManifest(manifest);
      } else if (record.latest && record.latest.kind === 'api' && record.latest.value) {
        result = this._fromApiRelease(record.latest.value);
      }
      if (result) {
        this._latest = result;
        this._cachedAt = Number(record.cachedAt) || 0;
      }
    } catch (_) {
      // A damaged cache is ignored. It never replaces settings or blocks startup.
    }
  }

  _persistCache(latest = this._cacheRecord.latest, cachedAt = this._cacheRecord.cachedAt || 0) {
    this._cacheRecord = {
      schemaVersion: 1,
      cachedAt,
      latest,
      apiRetryAt: this._apiRetryAt,
      apiFailures: this._apiFailures,
    };
    atomicWriteJson(this.cacheFile, this._cacheRecord);
  }

  _fromManifest(manifest) {
    const assets = manifest.assets.map((entry) => ({
      name: entry.name,
      size: entry.fileSize,
      digest: `sha256:${entry.sha256}`,
      url: entry.downloadUrl,
      urls: [entry.downloadUrl],
      sizes: { [entry.downloadUrl]: entry.fileSize },
      source: 'github',
      platform: entry.platform,
      architecture: entry.architecture,
      flavor: entry.flavor,
    }));
    return {
      version: manifest.version,
      tag: manifest.tag,
      name: `ApkStart ${manifest.tag}`,
      notes: manifest.releaseNotes,
      htmlUrl: `${repo}/releases/tag/${manifest.tag}`,
      publishedAt: manifest.publishedAt,
      assets,
      sources: [{ source: 'github-static', name: 'GitHub signed manifest', tag: manifest.tag }],
      unreachable: [],
      bySource: 'github-static',
      verified: true,
      manifestKind: 'latest',
      manifest,
      proof: '',
    };
  }

  _fromApiRelease(release) {
    if (!release || release.draft || release.prerelease) throw new Error('GitHub latest release 无效');
    const tag = String(release.tag_name || '');
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
      throw new Error('GitHub latest release tag 无效');
    }
    const names = new Set(Object.values(assetNames(tag)));
    const tagUrl = `${repo}/releases/tag/${tag}`;
    const expectedProof = new Map();
    try {
      const signed = readManifest(String(release.body || ''), tag, this.publicKey);
      for (const entry of signed.assets) expectedProof.set(entry.name, entry);
    } catch (_) {
      // Unsigned or old-format-invalid metadata may be displayed, but cannot authorize install.
    }
    const assets = [];
    for (const raw of Array.isArray(release.assets) ? release.assets : []) {
      if (!raw || !names.has(raw.name)) continue;
      const name = raw.name;
      const url = `${repo}/releases/download/${tag}/${name}`;
      const size = Number(raw.size) || 0;
      const rawUrl = String(raw.browser_download_url || '');
      const signedEntry = expectedProof.get(name);
      if (rawUrl !== url || !Number.isSafeInteger(size) || size <= 0) continue;
      let digest = String(raw.digest || '');
      if (!/^sha256:[a-f0-9]{64}$/.test(digest) && signedEntry && signedEntry.size === size) {
        digest = `sha256:${signedEntry.sha256}`;
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) continue;
      const asset = {
        name, size, digest, url, urls: [url], sizes: { [url]: size }, source: 'github',
      };
      if (signedEntry && matchAsset(expectedProof.size ? { assets: [...expectedProof.values()] } : null, tag, asset)) {
        asset.verified = true;
      }
      assets.push(asset);
    }
    const body = String(release.body || '');
    const proof = (marker.exec(body) || [])[0] || '';
    const verified = assets.some((asset) => asset.verified);
    const result = {
      version: tag.slice(1),
      tag,
      name: release.name || tag,
      notes: body,
      htmlUrl: tagUrl,
      publishedAt: release.published_at || release.created_at || '',
      assets,
      sources: [{ source: 'github-api', name: 'GitHub API', tag }],
      unreachable: [],
      bySource: 'github-api',
      verified,
      manifestKind: 'legacy',
      manifest: null,
      proof,
      _apiRelease: release,
    };
    return result;
  }

  _persistLatest(result, at) {
    this._latest = result;
    this._cachedAt = at;
    const latest = result.manifest
      ? { kind: 'manifest', value: result.manifest }
      : result.verified && result._apiRelease
        ? { kind: 'api', value: result._apiRelease }
        : this._cacheRecord.latest;
    const cachedAt = result.manifest || result.verified ? at : this._cacheRecord.cachedAt;
    this._persistCache(latest, cachedAt);
  }

  async _readResponse(url, timeout, headers, redirectAllowlist) {
    const response = await this.requestJson(url, { timeout, headers, redirectAllowlist });
    if (!response || !Number.isInteger(Number(response.status))) {
      throw new Error('更新服务器没有返回有效 HTTP 状态');
    }
    return { ...response, status: Number(response.status) };
  }

  async _fetchManifest() {
    const response = await this._readResponse(this.manifestUrl, 12000, {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    }, allowlistedManifestRedirect);
    if (response.status < 200 || response.status >= 300) throw new HttpStatusError(this.manifestUrl, response);
    if (response.finalUrl && !allowlistedManifestRedirect(response.finalUrl)) {
      throw new Error('更新清单重定向到不受信任的地址');
    }
    const manifest = verifyLatestManifest(responseJson(response.body), this.publicKey);
    return this._fromManifest(manifest);
  }

  _backoff(error, response) {
    const now = this.now();
    const kind = classifyFailure(error, response);
    if (kind === 'rate-limit') {
      this._apiRetryAt = rateLimitUntil(response || error, now, this.apiRetryFloorMs);
    } else {
      this._apiFailures += 1;
      const base = kind === 'not-found' || kind === 'forbidden' ? 5 * 60 * 1000 : 30 * 1000;
      const wait = Math.min(MAX_BACKOFF_MS, base * (2 ** Math.min(10, this._apiFailures - 1)));
      this._apiRetryAt = now + wait;
    }
    this._persistCache();
    return kind;
  }

  async _fetchApiFallback() {
    const now = this.now();
    if (now < this._apiRetryAt) {
      const waitMs = Math.max(1, this._apiRetryAt - now);
      throw new Error(`GitHub API ${Math.ceil(waitMs / 1000)} 秒后重试`);
    }
    const url = `${this.apiBase}/releases/latest`;
    try {
      const response = await this._readResponse(url, 9000, {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Cache-Control': 'no-cache',
      }, (target) => {
        try {
          const final = target instanceof URL ? target : new URL(target);
          return final.protocol === 'https:' && final.hostname.toLowerCase() === new URL(this.apiBase).hostname.toLowerCase();
        } catch (_) { return false; }
      });
      if (response.status < 200 || response.status >= 300) {
        const error = new HttpStatusError(url, response);
        const kind = this._backoff(error, response);
        error.kind = kind;
        throw error;
      }
      if (response.finalUrl) {
        const final = new URL(response.finalUrl);
        if (final.protocol !== 'https:' || final.hostname.toLowerCase() !== new URL(this.apiBase).hostname.toLowerCase()) {
          throw new Error('GitHub API 重定向到不受信任的地址');
        }
      }
      const result = this._fromApiRelease(responseJson(response.body));
      this._apiFailures = 0;
      this._apiRetryAt = 0;
      return result;
    } catch (error) {
      if (!error.kind) this._backoff(error);
      throw error;
    }
  }

  async _resolveLatest() {
    let manifestError = null;
    try {
      const result = await this._fetchManifest();
      this._persistLatest(result, this.now());
      return result;
    } catch (error) {
      manifestError = error;
    }

    try {
      const result = await this._fetchApiFallback();
      result.unreachable = [{
        source: 'github-static',
        name: 'Signed manifest',
        error: String(manifestError.message || manifestError),
        kind: classifyFailure(manifestError),
      }];
      this._persistLatest(result, this.now());
      return result;
    } catch (apiError) {
      const cached = this._latest;
      if (cached) {
        return {
          ...cached,
          stale: true,
          staleReason: `${manifestError.message}; ${apiError.message}`,
          unreachable: [
            { source: 'github-static', name: 'Signed manifest', error: manifestError.message },
            { source: 'github-api', name: 'GitHub API', error: apiError.message, kind: apiError.kind || classifyFailure(apiError) },
          ],
        };
      }
      const kind = apiError.kind || classifyFailure(apiError);
      const error = new Error(`${apiError.message}（静态清单: ${manifestError.message}）`);
      error.kind = kind;
      error.status = apiError.status;
      error.headers = apiError.headers;
      throw error;
    }
  }

  async latest({ force = false } = {}) {
    const now = this.now();
    if (!force && this._latest && now - this._cachedAt < CACHE_TTL) return this._latest;
    if (this._latestFlight) return this._latestFlight;
    this._latestFlight = this._resolveLatest();
    try {
      return await this._latestFlight;
    } finally {
      this._latestFlight = null;
    }
  }

  /** Return only the declared download URLs; metadata and transport stay separate. */
  candidates(assetOrUrl) {
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    for (const url of urls) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { continue; }
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /^(localhost|127\.|::1|\[::1\])/i.test(parsed.hostname))) continue;
      if (!out.includes(parsed.href)) out.push(parsed.href);
    }
    return out;
  }

  /**
   * 按实测速度排序候选地址。测速结果缓存 30 分钟；
   * 全部测速失败就退回原始顺序（保证「最坏情况还是能下」）。
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `正在测速 ${need.length} 个下载源…` });
      // 顺序测而不是并发测：并发会互相抢带宽，测出来的名次变成「谁抢得凶」，
      // 而不是「谁真的快」。每个源 256KB，正常也就一秒左右。
      // 单个源最多等 6 秒就放弃（旧版 9 秒 × 4 个源 = 最长 36 秒没有任何字节进度，
      // 用户看到的就是「卡在准备运行时」）；测速失败只会排到最后，不影响能下载。
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* 地址不合法就原样显示 */ }
        onProgress?.({ stage: 'probe', message: `正在测速第 ${i}/${need.length} 个源：${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `已选最快的源：${new URL(best).host}（约 ${(s / 1048576).toFixed(2)} MB/s）`,
      });
    }
    return sorted;
  }

  /** 某个候选地址的实测速度（B/s）。没测过或失败返回 -1（预检「整包是否太慢」用） */
  speedOf(url) {
    const c = this._rankCache.get(url);
    return c && c.ok ? c.speed : -1;
  }

  /** 测速缓存清空（网络变化后调用）。 */
  reset() {
    this._rankCache.clear();
  }
}

module.exports = {
  Sources, measure, openUrl, getJsonResponse, HttpStatusError,
  rateLimitUntil, isRateLimited, classifyFailure,
};

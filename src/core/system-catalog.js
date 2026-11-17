'use strict';
/**
 * 远程系统目录（system catalog）
 * ------------------------------------------------------------------
 * 只保存元数据，绝不保存系统镜像本体。职责：
 *   1. 远程加载 catalog.json（HTTPS），校验 schema 与条目合法性；
 *   2. 成功结果落盘缓存，远程不可用时回退到「最后一次成功缓存」；
 *   3. 缓存也没有时，回退到随包内置索引（src/system-catalog/catalog.json）；
 *   4. 全程暴露 cachedAt / source / stale，让 UI 显示目录更新时间。
 *
 * 安全：不伪造 URL / SHA-256。加载时会过滤掉 downloadUrl 缺失但 status 又标成
 * available 的条目（防止目录本身被篡改后诱导下载）。纯 Node 可用，不依赖 Electron。
 */
const fs = require('fs');
const path = require('path');
const { openStream } = require('./download');

const DEFAULT_URL = 'https://raw.githubusercontent.com/yuchen0x1/apkstart/main/system-catalog/catalog.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const MAX_BYTES = 2 * 1024 * 1024;       // 目录本身不应超过 2MB

function appDataDir() {
  return process.env.APPDATA || path.join(require('os').homedir(), '.apkstart');
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/** 内置索引：优先从 appRoot/src/system-catalog 读，测试时也可传 builtInPath。 */
function builtInCatalog(appRoot, builtInPath) {
  const candidates = [
    builtInPath,
    builtInPath && path.join(appRoot, builtInPath),
    path.join(appRoot, 'src', 'system-catalog', 'catalog.json'),
    path.join(__dirname, '..', 'system-catalog', 'catalog.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    const obj = readJsonSafe(p);
    if (obj && Array.isArray(obj.systems)) return obj;
  }
  return { schema: 1, updatedAt: '', systems: [], builtinSystems: [] };
}

/**
 * 校验并规范化目录对象。返回 { ok, catalog, warnings }。
 * available 但无合法下载 URL 的条目降级为 unavailable（不伪造可下载资源）。
 */
function normalizeCatalog(obj) {
  const warnings = [];
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.systems)) {
    return { ok: false, warnings: ['目录结构无效：缺少 systems 数组'] };
  }
  const systems = obj.systems.map((s) => {
    if (!s || typeof s.id !== 'string') return null;
    const versions = Array.isArray(s.versions) ? s.versions.map((v) => {
      const vv = Object.assign({}, v);
      const hasUrl = typeof vv.downloadUrl === 'string' && /^https:\/\//i.test(vv.downloadUrl);
      const isAvailable = vv.status === 'available' || vv.status === 'available-archive';
      if (isAvailable && !hasUrl) {
        warnings.push(`${s.id} ${vv.version || ''}: 标记可下载但无 HTTPS 地址，已降级为 unavailable`);
        vv.status = 'unavailable';
        vv.statusReason = '目录未提供合法的 HTTPS 下载地址';
      }
      // 有 sha256 必须是 64 位十六进制；否则清空，绝不把可疑值当官方校验和。
      if (vv.sha256 && !/^[0-9a-fA-F]{64}$/.test(vv.sha256)) {
        warnings.push(`${s.id} ${vv.version || ''}: sha256 格式非法，已忽略`);
        vv.sha256 = '';
      }
      return vv;
    }).filter(Boolean) : [];
    return Object.assign({}, s, { versions });
  }).filter(Boolean);

  return {
    ok: true,
    warnings,
    catalog: {
      schema: obj.schema || 1,
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
      note: typeof obj.note === 'string' ? obj.note : '',
      systems,
      builtinSystems: Array.isArray(obj.builtinSystems) ? obj.builtinSystems : [],
    },
  };
}

class SystemCatalog {
  /**
   * @param {object} opts
   *   - url        远程目录地址（默认官方 raw.githubusercontent）
   *   - appRoot    应用根目录（用于定位内置索引）
   *   - dataDir    缓存目录（默认 %APPDATA%\apkstart\system-catalog）
   *   - builtInPath 内置索引相对路径（可选）
   *   - fetchJson  自定义读取函数（测试注入），签名 async (url)=>obj
   */
  constructor(opts = {}) {
    this.url = opts.url || DEFAULT_URL;
    this.appRoot = opts.appRoot || path.join(__dirname, '..', '..');
    this.dataDir = opts.dataDir || path.join(appDataDir(), 'apkstart', 'system-catalog');
    this.cacheFile = path.join(this.dataDir, 'catalog.json');
    this.metaFile = path.join(this.dataDir, 'meta.json');
    this.builtInPath = opts.builtInPath || null;
    this._fetchJson = opts.fetchJson || null;
    this._memory = null; // { catalog, cachedAt, source, stale }
    this._inflight = null;
  }

  /** 从远程读取 JSON（带 UA / 超时 / 体积上限 / 重定向，复用 download.openStream） */
  async _remoteJson() {
    if (this._fetchJson) return await this._fetchJson(this.url);
    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve(val);
      };
      openStream(this.url, { timeout: 20000 })
        .then((res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return done(new Error('HTTP ' + res.statusCode));
          }
          let size = 0;
          const chunks = [];
          res.on('data', (b) => {
            size += b.length;
            if (size > MAX_BYTES) {
              res.destroy(new Error('目录文件过大'));
              return;
            }
            chunks.push(b);
          });
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
              done(null, JSON.parse(text));
            } catch (e) {
              done(new Error('目录 JSON 解析失败：' + e.message));
            }
          });
          res.on('error', done);
        })
        .catch(done);
    });
  }

  _writeCache(catalog) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(catalog, null, 2), 'utf8');
      fs.writeFileSync(this.metaFile, JSON.stringify({
        cachedAt: new Date().toISOString(),
        source: this.url,
        updatedAt: catalog.updatedAt || '',
      }, null, 2), 'utf8');
    } catch (_) { /* 缓存写失败不影响使用 */ }
  }

  _loadCache() {
    const catalog = readJsonSafe(this.cacheFile);
    if (!catalog || !Array.isArray(catalog.systems)) return null;
    const meta = readJsonSafe(this.metaFile) || {};
    return {
      catalog: normalizeCatalog(catalog).catalog || catalog,
      cachedAt: meta.cachedAt || '',
      source: meta.source || this.url,
      stale: true,
    };
  }

  _loadBuiltIn() {
    const catalog = builtInCatalog(this.appRoot, this.builtInPath);
    const n = normalizeCatalog(catalog);
    return {
      catalog: n.catalog || catalog,
      cachedAt: '',
      source: 'built-in',
      stale: true,
      warnings: n.warnings,
    };
  }

  /**
   * 加载目录：优先远程（成功即刷新缓存），失败回退缓存，再失败回退内置索引。
   * @param {object} opts { force=false }
   * @returns {Promise<{ok, catalog, cachedAt, source, stale, warnings, error}>}
   */
  async load(opts = {}) {
    const force = !!(opts && opts.force);
    if (!force && this._memory && !this._memory.stale) {
      return Object.assign({ ok: true, warnings: [] }, this._memory);
    }
    if (this._inflight) return this._inflight;

    this._inflight = (async () => {
      try {
        const obj = await this._remoteJson();
        const n = normalizeCatalog(obj);
        if (!n.ok) throw new Error(n.warnings.join('; '));
        this._writeCache(n.catalog);
        const result = {
          ok: true,
          catalog: n.catalog,
          cachedAt: new Date().toISOString(),
          source: this.url,
          stale: false,
          warnings: n.warnings,
        };
        this._memory = result;
        return result;
      } catch (e) {
        const cache = this._loadCache();
        const result = cache
          ? Object.assign({ ok: true, warnings: [], error: e.message }, cache)
          : Object.assign({ ok: true, warnings: [], error: e.message }, this._loadBuiltIn());
        this._memory = result;
        return result;
      } finally {
        this._inflight = null;
      }
    })();

    return this._inflight;
  }

  /** 取某个系统的全部版本（含 availability 语义） */
  async getSystem(systemId, opts = {}) {
    const r = await this.load(opts);
    const s = (r.catalog.systems || []).find((x) => x.id === systemId);
    return s || null;
  }

  /** 最新可用版本（status 为 available / available-archive） */
  async getLatest(systemId, opts = {}) {
    const s = await this.getSystem(systemId, opts);
    if (!s) return null;
    return s.versions.find((v) => v.status === 'available' || v.status === 'available-archive') || s.versions[0] || null;
  }

  /** 合并内置系统列表（Google/AOSP/自定义）与目录系统，供 UI 渲染卡片 */
  async listAll(opts = {}) {
    const r = await this.load(opts);
    const catalogSystems = (r.catalog.systems || []).map((s) => ({
      id: s.id,
      name: s.name,
      brand: s.brand,
      bootBackend: (s.versions[0] || {}).bootBackend || '',
      status: 'catalog',
      versions: s.versions,
    }));
    const builtins = (r.catalog.builtinSystems || []).map((b) => Object.assign({}, b));
    return { systems: builtins.concat(catalogSystems), catalogInfo: {
      updatedAt: r.catalog.updatedAt,
      cachedAt: r.cachedAt,
      source: r.source,
      stale: r.stale,
      error: r.error || '',
      warnings: r.warnings || [],
    } };
  }

  /** 缓存新鲜度（供 UI 显示"目录更新时间"） */
  cacheInfo() {
    const mem = this._memory;
    if (mem) return { cachedAt: mem.cachedAt, source: mem.source, stale: mem.stale, updatedAt: mem.catalog.updatedAt };
    const cache = this._loadCache();
    if (cache) return { cachedAt: cache.cachedAt, source: cache.source, stale: true, updatedAt: cache.catalog.updatedAt };
    return { cachedAt: '', source: 'built-in', stale: true, updatedAt: '' };
  }
}

module.exports = {
  SystemCatalog,
  DEFAULT_URL,
  CACHE_TTL_MS,
  normalizeCatalog,
  builtInCatalog,
};

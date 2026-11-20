'use strict';
/**
 * 自定义镜像适配层（Image Providers / Adapters）
 *
 * 目标：在**不碰默认运行时**的前提下，允许用户接入一套自己的 x86_64 模拟器系统镜像。
 *
 * 设计要点（每一条都对应一个真实的坑）：
 *  1. **可插拔**：`register(provider)` 注册来源适配器（本地文件夹 / ZIP 包 / 单清单文件），
 *     新增一种来源不用改导入流程；导入流程只认 provider.read() 返回的「目录 + 清单」。
 *  2. **清单先行**：manifest（image-manifest.js）描述 API / ABI / 类型 / 来源 / GMS /
 *     ARM 转译 / 校验值，字节体检（image-inspect.js）验证四件套。两者都过才算可用。
 *  3. **导入是「加一条记录」**，不写 settings.runtime.activeImageId —— 也就是说
 *     导入失败、甚至导入成功但没启用，默认运行时（Android 14 Google Play x86_64）
 *     一个字节都不会变。启用是独立的一步，且启用前会重新体检。
 *  4. **不复制用户的大文件**：本地目录直接引用（managed:false）；只有 ZIP 解出来的
 *     副本才归我们管（managed:true），remove() 只删自己那份。
 *  5. **运行在独立 AVD 里**：由 emulator 按 activeImageId 切到 `apkstart-custom`，
 *     默认 AVD（已装应用、存档、快照）完全不动，恢复默认镜像即可原样回来。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const inspect = require('./image-inspect');
const manifestLib = require('./image-manifest');

const DIR_NAME = 'custom-images';
const INDEX_NAME = 'index.json';
/** ZIP 解压后的暂存目录：要么整体搬到 custom-images/<id>，要么整个删掉 */
const STAGING_PREFIX = '.staging-';

function inside(root, target, allowRoot = false) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (!rel ? allowRoot : rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 不只比字符串：所有现有路径组件必须不经过 symlink / Windows junction。 */
function safePath(root, target, allowRoot = false) {
  if (!inside(root, target, allowRoot)) throw new Error('镜像路径越界，已拒绝操作');
  const base = path.resolve(root);
  let cur = base;
  const realRoot = fs.realpathSync(base);
  for (const part of path.relative(base, path.resolve(target)).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink() || !inside(realRoot, fs.realpathSync(cur), true)) {
      throw new Error('镜像路径包含符号链接或 junction，已拒绝操作');
    }
  }
  return path.resolve(target);
}

/** 托管副本不能夹带会在移动后失效/越界的链接。 */
function checkManagedTree(dir) {
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('镜像暂存目录不能是符号链接或 junction');
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error('托管镜像不能包含符号链接或 junction');
    if (st.isDirectory()) checkManagedTree(p);
  }
}


/* ---------------- 来源适配器（可插拔） ---------------- */

/** 在一棵浅目录里找「真正含 system.img 的那一层」（ZIP 常带一层同名顶级目录） */
function findImageRoot(dir, depth = 0) {
  if (!inspect.isDir(dir)) return '';
  const hasSystem = !!inspect.pickFile(dir, ['system.img']);
  if (hasSystem) return dir;
  if (depth >= 3) return '';
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ''; }
  const subs = items.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  // 优先找带 system-images/<api>/<tag>/<abi> 结构的目录
  for (const e of subs) {
    const sub = path.join(dir, e.name);
    const m = /^android-(\d+)$/i.exec(e.name);
    if (m) {
      let tags = [];
      try { tags = fs.readdirSync(sub, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch (_) { tags = []; }
      for (const t of tags) {
        const abis = path.join(sub, t.name);
        let abiDirs = [];
        try { abiDirs = fs.readdirSync(abis, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch (_) { abiDirs = []; }
        for (const a of abiDirs) {
          const cand = path.join(abis, a.name);
          if (inspect.pickFile(cand, ['system.img'])) return cand;
        }
      }
    }
  }
  for (const e of subs) {
    const hit = findImageRoot(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return '';
}

const PROVIDERS = [
  {
    id: 'manifest-json',
    label: '镜像清单文件',
    probe: (p) => /\.(json)$/i.test(p) && inspect.exists(p),
    read: (p) => ({ dir: path.dirname(p), manifestPath: p, managed: false }),
  },
  {
    id: 'local-dir',
    label: '本地文件夹',
    probe: (p) => inspect.isDir(p),
    read: (p) => {
      const dir = findImageRoot(p) || p;
      return { dir, managed: false };
    },
  },
  {
    id: 'local-zip',
    label: '本地 ZIP 包',
    probe: (p) => /\.zip$/i.test(p) && inspect.exists(p),
    read: (p, ctx) => {
      if (!ctx.extractZip) {
        const e = new Error('当前环境不能解压 ZIP 包，请先把包解压成文件夹，再选择那个文件夹');
        e.code = 'NO_EXTRACTOR';
        throw e;
      }
      const dest = fs.mkdtempSync(path.join(ctx.ensureStagingRoot(), `${STAGING_PREFIX}zip-`));
      return { dir: dest, managed: true, stagingDir: dest, async prepare() {
        try {
          await ctx.extractZip(p, dest, {});
        } catch (e) {
          // 解压中途失败（磁盘满 / 包损坏）不能留半截目录：它可能已经占了几个 GB
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) { /* ignore */ }
          throw e;
        }
        const root = findImageRoot(dest) || dest;
        return { dir: root, managed: true, stagingDir: dest };
      } };
    },
  },
];

class ImageStore {
  /**
   * @param {object} opts
   * @param {string} opts.root 运行时根目录（custom-images 落在它下面）
   * @param {Function} [opts.extractZip] 解压函数 (zipPath, destDir, opts) => Promise
   */
  constructor({ root, extractZip = null } = {}) {
    this.root = String(root || '');
    this.extractZip = typeof extractZip === 'function' ? extractZip : null;
    this.providers = PROVIDERS.slice();
    this._active = null;
  }

  /** 注册一个新的来源适配器（顺序即优先级，靠前的先被尝试） */
  register(provider, { front = false } = {}) {
    if (!provider || !provider.id || typeof provider.probe !== 'function' || typeof provider.read !== 'function') {
      throw new Error('provider 需要 { id, probe(path), read(path, ctx) }');
    }
    this.providers = this.providers.filter((p) => p.id !== provider.id);
    if (front) this.providers.unshift(provider);
    else this.providers.push(provider);
    return this;
  }

  get dir() { return path.join(this.root, DIR_NAME); }
  get indexFile() { return path.join(this.dir, INDEX_NAME); }
  get stagingRoot() { return path.join(this.root, '_tmp'); }

  _ensureDir(dir = this.dir) {
    fs.mkdirSync(this.root, { recursive: true });
    safePath(this.root, dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _records({ strict = false } = {}) {
    try {
      safePath(this.root, this.indexFile);
      const j = JSON.parse(fs.readFileSync(this.indexFile, 'utf8').replace(/^\uFEFF/, ''));
      const list = Array.isArray(j) ? j : j && j.records;
      if (!Array.isArray(list)) throw new Error('自定义镜像索引格式无效');
      return list.filter((r) => r && manifestLib.isSafeId(r.id));
    } catch (e) {
      if (strict && e.code !== 'ENOENT') throw e;
      return [];
    }
  }

  _writeRecords(records) {
    this._ensureDir();
    safePath(this.root, this.indexFile);
    const tmp = path.join(this.dir, `${STAGING_PREFIX}${crypto.randomUUID()}.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify({ schema: 1, records }, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, this.indexFile);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    }
  }

  _managedRoot(rec) {
    if (!rec || !rec.managed || !rec.dir || !manifestLib.isSafeId(rec.id)) return '';
    safePath(this.root, this.dir);
    safePath(this.dir, rec.dir);
    const first = path.relative(path.resolve(this.dir), path.resolve(rec.dir)).split(path.sep)[0];
    if (first !== rec.id && !new RegExp(`^${STAGING_PREFIX.replace('.', '\\.')}[0-9a-f-]{36}$`).test(first)) return '';
    return path.join(this.dir, first);
  }

  _cleanupStaging(resolved) {
    if (!resolved.managed) return;
    try {
      const dest = safePath(this.root, this.stagingRoot);
      const target = safePath(dest, resolved.stagingDir || resolved.dir);
      fs.rmSync(target, { recursive: true, force: true });
    } catch (_) { /* 不清理无法证实在暂存区内的路径 */ }
  }

  _record(id) {
    return this._records().find((r) => r.id === id) || null;
  }

  _activeId() {
    try {
      const s = store.getSettings();
      return String((s.runtime && s.runtime.activeImageId) || '');
    } catch (_) { return ''; }
  }

  _invalidate() { this._active = null; this._activeKey = undefined; }

  /* ---------------- 体检 ---------------- */

  /** 重新体检一条已导入的记录（不哈希，只查文件在不在、格式对不对） */
  verify(record) {
    if (!record || !record.dir) return { ok: false, reason: '镜像没有目录记录' };
    if (!inspect.exists(record.dir)) {
      return { ok: false, reason: `镜像目录已不存在：${record.dir}（被移动、改名或删除了？）` };
    }
    const scan = inspect.scanImageDir(record.dir, { files: record.files || {} });
    if (!scan.ok) return { ok: false, reason: scan.errors[0] || '镜像文件不完整', scan };
    return { ok: true, scan, size: scan.size };
  }

  /** 每条记录对外展示的形态（含不可用原因） */
  describe(record) {
    const v = this.verify(record);
    const activeId = this._activeId();
    return {
      id: record.id,
      name: record.name,
      api: record.api,
      abi: record.abi,
      tag: record.tag,
      type: record.type,
      vendor: record.vendor || '',
      dir: record.dir,
      managed: !!record.managed,
      source: record.source || {},
      googleServices: record.googleServices || { gms: false, playStore: false },
      armTranslation: record.armTranslation || { enabled: false, engine: '' },
      size: v.ok ? v.size : (record.size || 0),
      importedAt: record.importedAt || '',
      active: !!record.id && record.id === activeId,
      state: v.ok ? 'ok' : 'invalid',
      reason: v.ok ? '' : v.reason,
      summary: manifestLib.describe({
        name: record.name, api: record.api, abi: record.abi,
        googleServices: record.googleServices, armTranslation: record.armTranslation,
      }),
    };
  }

  list() {
    return this._records().map((r) => this.describe(r));
  }

  /**
   * 当前生效的自定义镜像。
   * @returns {{ok:boolean, custom:boolean, id:string, reason?:string, ...}}
   *   没有配置自定义镜像 → { ok:true, custom:false }
   *   配了但坏了 → { ok:false, custom:true, reason }（调用方据此回落默认镜像并展示原因）
   */
  active() {
    const id = this._activeId();
    // 缓存按「当前 activeImageId」作键：设置被别处改掉时也能立刻反映，不会用旧结论
    if (this._active && this._activeKey === id) return this._active;
    if (!id) {
      this._activeKey = id;
      this._active = { ok: true, custom: false, id: '' };
      return this._active;
    }
    const rec = this._record(id);
    this._activeKey = id;
    if (!rec) {
      this._active = {
        ok: false, custom: true, id,
        name: '', reason: '设置里指定的自定义镜像已不在列表里（可能被移除），已回到默认镜像',
      };
      return this._active;
    }
    const v = this.verify(rec);
    this._active = v.ok
      ? {
        ok: true,
        custom: true,
        id: rec.id,
        name: rec.name,
        dir: rec.dir,
        api: rec.api,
        abi: rec.abi,
        tag: rec.tag,
        type: rec.type,
        size: v.size,
        source: rec.source || {},
        googleServices: rec.googleServices || { gms: false, playStore: false },
        armTranslation: rec.armTranslation || { enabled: false, engine: '' },
      }
      : {
        ok: false, custom: true, id: rec.id, name: rec.name,
        reason: v.reason, source: rec.source || {},
      };
    return this._active;
  }

  /* ---------------- 解析与预览 ---------------- */

  _pickProvider(src) {
    for (const p of this.providers) {
      let ok = false;
      try { ok = !!p.probe(src); } catch (_) { ok = false; }
      if (ok) return p;
    }
    return null;
  }

  /** 把任意来源解析成「一个目录（+ 可选清单路径）」 */
  async _resolve(src) {
    const p = path.resolve(String(src || ''));
    if (!p) throw new Error('没有选择镜像');
    if (!inspect.exists(p)) throw new Error(`路径不存在：${p}`);
    const provider = this._pickProvider(p);
    if (!provider) {
      throw new Error('无法识别的来源：请选择镜像文件夹、ZIP 包，或 apkstart-image.json 清单文件');
    }
    const out = await provider.read(p, {
      extractZip: this.extractZip,
      stagingRoot: this.stagingRoot,
      ensureStagingRoot: () => this._ensureDir(this.stagingRoot),
    });
    if (out && typeof out.prepare === 'function') {
      const prepared = await out.prepare();
      Object.assign(out, prepared);
    }
    return { ...out, provider: provider.id, sourcePath: p };
  }

  /**
   * 只读预览 / 导入前的完整校验。
   * ZIP 会解到临时目录，预览结束后立刻删掉 —— 预览不留下任何东西。
   */
  async inspectSource(src, { emulatorVersion = '', keepStaging = false } = {}) {
    const resolved = await this._resolve(src);
    const cleanup = () => this._cleanupStaging(resolved);
    try {
      const report = this._scan(resolved, { emulatorVersion });
      if (!keepStaging) cleanup();
      return { ...report, resolved };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  /** 核心：清单 + 字节双重校验 */
  _scan(resolved, { emulatorVersion = '' } = {}) {
    // 允许用户指到「上一层」：自动往下找到真正含 system.img 的那一级
    const dir = findImageRoot(resolved.dir || '') || resolved.dir || '';
    const errors = [];
    const warnings = [];

    // 1) 读清单（存在就必须是合法 JSON —— 静默忽略等于拿用户的清单当不存在）
    let raw = {};
    const manifestPath = resolved.manifestPath || path.join(dir, manifestLib.MANIFEST_NAME);
    if (inspect.exists(manifestPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        errors.push(`清单文件不是合法 JSON（${manifestLib.MANIFEST_NAME}）：${e.message}`);
        raw = {};
      }
    }

    // 2) 目录内容推断（api / abi / tag）
    const inferred = inspect.inferMeta(dir);
    const scan0 = inspect.scanImageDir(dir, { files: raw && raw.files ? raw.files : {} });

    // 3) 清单归一化。没写类型时按目录特征猜：
    //    有 boot.img / recovery.img / system.new.dat* → 手机固件；否则按模拟器镜像处理
    let guessType = 'emulator-system-image';
    const names = inspect.nameMap(dir);
    const phoneMark = ['boot.img', 'recovery.img', 'system.new.dat', 'system.new.dat.br', 'system.transfer.list']
      .some((n) => names.has(n));
    if (phoneMark) guessType = 'phone-rom';

    let m = manifestLib.normalize(raw, {
      id: path.basename(dir) || 'custom-image',
      name: path.basename(dir) || '自定义镜像',
      type: guessType,
      api: inferred.api,
      abi: inferred.abi,
      tag: inferred.tag,
    });
    m = manifestLib.fillFromInference(m, { ...inferred, ...(scan0.meta || {}) });

    // 4) 清单校验（类型 / ABI / API / 机器类型）
    const why = manifestLib.validate(m, { emulatorVersion });
    errors.push(...why.errors);
    warnings.push(...why.warnings);

    // 5) 「清单说的 ABI」与「目录里实际的 ABI」不一致 → 直接拒绝。
    //    这是最常见的「假装成功」路径：arm64 的 MIUI 包配一份写着 x86_64 的清单。
    const realAbi = inspect.normalizeAbiName((scan0.meta && scan0.meta.abi) || '');
    if (realAbi && m.abi && realAbi !== m.abi) {
      errors.push(`清单声明 ABI 是 ${m.abi}，但镜像目录结构表明是 ${realAbi}：`
        + '清单与实际内容不一致，不能用（多半是把手机 arm64 固件当成 x86_64 模拟器镜像了）');
    }

    // 6) 字节体检结果
    errors.push(...scan0.errors);
    warnings.push(...scan0.warnings);

    // 7) 去重（同一句原因既可能来自清单也可能来自体检）
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const finalErrors = uniq(errors);
    const finalWarnings = uniq(warnings).filter((w) => !finalErrors.includes(w));

    return {
      ok: finalErrors.length === 0,
      errors: finalErrors,
      warnings: finalWarnings,
      manifest: m,
      manifestPath: inspect.exists(manifestPath) ? manifestPath : '',
      dir,
      provider: resolved.provider || '',
      managed: !!resolved.managed,
      api: m.api,
      abi: m.abi,
      tag: manifestLib.emulatorTag(m),
      size: scan0.size,
      files: scan0.files,
      meta: scan0.meta,
      summary: manifestLib.describe(m),
      suggestedId: m.id,
    };
  }

  /* ---------------- 校验值 ---------------- */

  _hash(file, algo) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash(algo);
      const rs = fs.createReadStream(file);
      rs.on('data', (c) => h.update(c));
      rs.on('error', reject);
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }

  /**
   * 按清单里的 checksums 逐个校验。没声明的文件跳过（不强求用户先算三个 GB 的哈希）。
   * @returns {Promise<{ok:boolean, errors:string[], checked:number}>}
   */
  async verifyChecksums(dir, checksums, onProgress = () => {}) {
    const entries = Object.entries(checksums || {});
    if (!entries.length) return { ok: true, errors: [], checked: 0 };
    const errors = [];
    let i = 0;
    for (const [name, spec] of entries) {
      i += 1;
      const [algo, want] = String(spec).split(':');
      let file;
      try {
        const normalized = String(name).replace(/\\/g, '/');
        if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) {
          throw new Error('校验文件路径越界');
        }
        file = safePath(dir, path.resolve(dir, normalized));
      } catch (e) {
        errors.push(`${name} 校验路径不安全：${e.message}`);
        continue;
      }
      onProgress({
        stage: 'verify',
        message: `校验 ${path.basename(name)}（${algo}）…`,
        percent: Math.round((i / entries.length) * 100),
      });
      if (!inspect.exists(file)) {
        errors.push(`校验清单里的 ${name} 不存在，无法校验`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const got = await this._hash(file, algo).catch((e) => { errors.push(`${name} 校验失败：${e.message}`); return ''; });
      if (!got) continue;
      if (got !== want) {
        errors.push(`${path.basename(name)} 校验值不匹配（期望 ${algo}:${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）：`
          + '文件可能损坏或被替换过，已拒绝导入');
      }
    }
    return { ok: errors.length === 0, errors, checked: entries.length };
  }

  /* ---------------- 导入 / 启用 / 恢复 / 移除 ---------------- */

  /**
   * 导入一套自定义镜像。
   * 成功 = 在 custom-images/index.json 里多一条记录；**不改变当前生效的镜像**。
   * 失败 = 抛错，settings 与默认运行时都不动，暂存目录清掉。
   */
  async import(src, { onProgress = () => {}, replace = false, emulatorVersion = '' } = {}) {
    const resolved = await this._resolve(src);
    let pending = '';
    try {
      const report = this._scan(resolved, { emulatorVersion });
      if (!report.ok) {
        const e = new Error(report.errors.join('；'));
        e.errors = report.errors;
        e.report = report;
        throw e;
      }

      // 校验值：清单声明了就必须对得上
      const sums = await this.verifyChecksums(report.dir, report.manifest.checksums, onProgress);
      if (!sums.ok) {
        const e = new Error(sums.errors.join('；'));
        e.errors = sums.errors;
        e.report = report;
        throw e;
      }

      // 先完整安置新副本，再原子提交索引；替换失败时旧记录/旧目录始终可用。
      const previous = this._records({ strict: true });
      const sameId = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      let id = report.suggestedId || 'custom-image';
      if (!manifestLib.isSafeId(id)) throw new Error('清单 id 不是安全目录名');
      const old = previous.find((r) => sameId(r.id, id));
      const taken = (x) => previous.some((r) => sameId(r.id, x)) || fs.existsSync(path.join(this.dir, x));
      if (!replace || !old) {
        const base = id;
        let n = 2;
        while (taken(id)) id = `${base.slice(0, 70)}-${n++}`;
      } else {
        id = old.id;
      }

      let finalDir = report.dir;
      let managed = false;
      if (report.managed) {
        const moveRoot = safePath(this.stagingRoot, resolved.stagingDir || report.dir);
        safePath(moveRoot, report.dir, true);
        checkManagedTree(moveRoot);
        for (const file of Object.values(report.manifest.files || {})) {
          if (file) safePath(moveRoot, path.resolve(report.dir, file));
        }
        const target = safePath(this._ensureDir(), old && replace ? path.join(this.dir, `${STAGING_PREFIX}${crypto.randomUUID()}`) : path.join(this.dir, id));
        // 绝不预先 rm(target)，它可能是未收录的现有目录或 junction。
        if (fs.existsSync(target)) throw new Error('镜像目标路径已存在，已拒绝覆盖');
        onProgress({ stage: 'move', message: '正在安置镜像文件…', percent: 96 });
        try {
          fs.renameSync(moveRoot, target);
          pending = target;
        } catch (e) {
          if (e.code !== 'EXDEV') throw e;
          fs.mkdirSync(target);
          pending = target;
          copyDir(moveRoot, target);
        }
        finalDir = path.join(target, path.relative(moveRoot, report.dir));
        managed = true;
      }

      const record = {
        id,
        name: report.manifest.name,
        type: report.manifest.type,
        api: report.manifest.api,
        abi: report.manifest.abi,
        tag: report.tag,
        vendor: report.manifest.vendor,
        dir: finalDir,
        managed,
        source: {
          ...report.manifest.source,
          provider: report.provider,
          path: resolved.sourcePath,
        },
        googleServices: report.manifest.googleServices,
        armTranslation: report.manifest.armTranslation,
        files: report.manifest.files,
        checksums: report.manifest.checksums,
        size: report.size,
        warnings: report.warnings,
        importedAt: new Date().toISOString(),
      };
      const records = previous.filter((r) => !sameId(r.id, id));
      records.push(record);
      this._writeRecords(records);
      pending = '';
      if (old && replace && old.managed) {
        try {
          const oldRoot = this._managedRoot(old);
          if (oldRoot && !inside(oldRoot, finalDir, true)) fs.rmSync(oldRoot, { recursive: true, force: true });
        } catch (_) { /* 索引已提交；旧副本不安全时保留，绝不越界删除 */ }
      }
      this._invalidate();
      onProgress({ stage: 'done', message: `已导入「${record.name}」，点「启用」后生效`, percent: 100 });
      return { ok: true, record: this.describe(record), warnings: report.warnings, checksums: sums.checked };
    } finally {
      if (pending) {
        try {
          safePath(this.root, this.dir);
          fs.rmSync(safePath(this.dir, pending), { recursive: true, force: true });
        } catch (_) { /* 不清理无法证实在托管目录内的路径 */ }
      }
      this._cleanupStaging(resolved);
    }
  }

  /** 启用：先重新体检，通过了才写 settings；失败抛错且设置不变 */
  activate(id) {
    const rec = this._record(String(id || ''));
    if (!rec) throw new Error('镜像不存在或已被移除');
    const v = this.verify(rec);
    if (!v.ok) {
      const e = new Error(`镜像不可用：${v.reason}`);
      e.reason = v.reason;
      throw e;
    }
    store.saveSettings({ runtime: { activeImageId: rec.id } });
    this._invalidate();
    return { ok: true, record: this.describe(rec) };
  }

  /**
   * 恢复默认镜像（Android 14 · Google Play · x86_64）。
   * 只是把指针清空：默认镜像、默认 AVD、已装应用与存档全程没被动过。
   */
  restoreDefault() {
    store.saveSettings({ runtime: { activeImageId: '' } });
    this._invalidate();
    return { ok: true, activeId: '' };
  }

  _drop(id) {
    const records = this._records({ strict: true });
    const rec = records.find((r) => r.id === id);
    if (!rec) return false;
    this._writeRecords(records.filter((r) => r.id !== id));
    // 只删对应 id 的托管副本；不跟随已有目录中的链接或 junction。
    try {
      const target = this._managedRoot(rec);
      if (target) fs.rmSync(target, { recursive: true, force: true });
    } catch (_) { /* 占用或不安全时保留 */ }
    return true;
  }

  /** 移除一条记录（若正在使用，先自动恢复默认镜像） */
  remove(id) {
    const key = String(id || '');
    if (!key) return { ok: false, error: '没有指定镜像' };
    const rec = this._record(key);
    if (!rec) return { ok: false, error: '镜像不存在' };
    const wasActive = this._activeId() === key;
    if (wasActive) this.restoreDefault();
    this._drop(key);
    this._invalidate();
    return { ok: true, removed: key, wasActive, keptSourceDir: !rec.managed ? rec.dir : '' };
  }

  /** 给设置页用的整体状态（不涉及默认运行时的健康度，那部分由 provision 提供） */
  status() {
    const items = this.list();
    const active = this.active();
    return {
      activeId: this._activeId(),
      active,
      items,
      dir: this.dir,
      // 有自定义镜像但坏了：调用方（设置页 / 修复窗口）要能直接说出原因
      why: active.custom && !active.ok ? active.reason : '',
    };
  }
}

/** 递归复制（跨盘符搬镜像用） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

module.exports = {
  ImageStore, PROVIDERS, DIR_NAME, INDEX_NAME, STAGING_PREFIX, findImageRoot, copyDir,
};

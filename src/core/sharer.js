'use strict';
/**
 * 本机 ↔ 安卓 的共享目录双向同步
 *
 * 没有 root 的情况下无法真正「挂载」目录，所以采用增量同步：
 * 任何一侧新增/修改的文件都会在几秒内同步到另一侧，语义上等价于共享文件夹。
 *
 * ── 一致性模型（v2）──────────────────────────────────────────────
 * 旧实现只用「大小 + 修改时间」判断，并且把 `dir === 'up'`（历史上从本机推上去过）
 * 当成文件永久一致的证据。结果是：从 Windows 上传过的文件，之后在 Android 侧被
 * 修改（大小不变）就再也不会同步回来 —— 用户看到的是「安卓里改了，电脑上还是旧的」。
 *
 * 现在每个文件都记录三份内容哈希：
 *     baseHash    上次两侧达成一致时的内容（三方合并的祖先）
 *     localHash   上次看到的 Windows 侧内容
 *     remoteHash  上次看到的 Android 侧内容
 * 判定规则（哈希一致才算一致，大小/时间只用来跳过重复计算）：
 *   - 只有一侧变了        → 把变的那一侧传给另一侧
 *   - 两侧都变了但内容相同 → 直接记为已同步
 *   - 两侧都变了且内容不同 → **冲突**：本机文件保留为准，把 Android 版本落成
 *                            「xxx (Android 冲突 YYYY-MM-DD HHMMSS).ext」副本，
 *                            两侧都不删，等用户处理（绝不静默覆盖）
 *   - 一侧删除、另一侧改过 → 不删任何东西，把被删的一侧从另一侧恢复回来
 *   - 一侧删除、另一侧没变 → 默认只提示（保护性），开启「删除同步」后移进回收目录
 *
 * 写入一律「临时文件 + 原子替换」，推送前先传临时名再 mv，避免另一侧看到半截文件。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const MAX_FILE = 512 * 1024 * 1024;   // 单文件 512MB 上限
const MAX_FILES = 20000;              // 单轮扫描文件数上限（防止误选巨大目录卡死）
const STABLE_MS = 1500;               // 1.5 秒内还在改的文件本轮跳过
const HASH_BATCH = 24;                // 每次 adb shell 里最多算多少个哈希
const HASH_BATCH_CHARS = 2600;        // 命令行总长度上限（安卓端 ARG_MAX 很小）
const VERIFY_PUSH_MAX = 8 * 1024 * 1024; // 小文件优先校验远端暂存文件的哈希

/** 两侧都要忽略的东西：隐藏文件、编辑器临时文件、下载中间态 */
const SKIP_NAME = /^(\.|~\$)|\.(tmp|temp|crdownload|part|partial|download|swp)$/i;

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

// 不要先 normalize：Android 的反斜杠是文件名字符，在 Windows 却会变成路径分隔符。
function safeComponent(name) {
  return !!name && name !== '.' && name !== '..'
    && !/[\\/<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³]) *$/i.test(name.split('.')[0]);
}

function safeRel(rel) {
  return typeof rel === 'string' && rel.split('/').every(safeComponent);
}

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const sameEntry = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
// size/mtime 可以在等长写入或原子替换后保持不变。ctime 与文件身份必须一起参与缓存判定；
// 版本前缀让旧的 size:mtime 缓存自动失效，时间戳不能先四舍五入丢掉变更精度。
const localIdentity = (st) => `local-v2:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const boundaryError = (file) => new Error(`共享路径不安全（链接、别名或类型不符）：${file}`);
function stoppedError() {
  const error = new Error('共享同步已停止');
  error.code = 'SHARER_STOPPED';
  return error;
}
function assertRunning(run) { if (run && run.cancelled) throw stoppedError(); }

/** 一轮只授权一个宿主根。逐级检查，不能在未检查的路径上 recursive mkdir。 */
class HostBoundary {
  constructor(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw boundaryError(dir);
    this.root = path.resolve(dir);
  }

  prepare() {
    const { root } = path.parse(this.root);
    let cur = root;
    let st = lstat(cur);
    for (const part of this.root.slice(root.length).split(path.sep).filter(Boolean)) {
      if (process.platform === 'win32' && !safeComponent(part)) throw boundaryError(part);
      cur = path.join(cur, part);
      st = lstat(cur);
      if (!st) { fs.mkdirSync(cur); st = lstat(cur); }
      if (!st || !st.isDirectory() || st.isSymbolicLink()
        || path.relative(cur, fs.realpathSync.native(cur)) !== '') throw boundaryError(cur);
    }
    if (!st || !st.isDirectory() || st.isSymbolicLink()) throw boundaryError(cur);
    this.root = fs.realpathSync.native(cur);
    this.entry = st;
  }

  checkRoot() {
    const root = lstat(this.root);
    if (!sameEntry(root, this.entry) || !root.isDirectory() || root.isSymbolicLink()
      || fs.realpathSync.native(this.root) !== this.root) throw boundaryError(this.root);
  }

  check(rel, { directory = false, mkdir = false } = {}) {
    if (!safeRel(rel)) throw boundaryError(rel);
    this.checkRoot();
    const parts = rel.split('/');
    let file = this.root;
    let st;
    for (const [i, part] of parts.entries()) {
      file = path.join(file, part);
      const parent = i < parts.length - 1;
      st = lstat(file);
      if (!st && parent && mkdir) { fs.mkdirSync(file); st = lstat(file); }
      if (!st) {
        if (parent && mkdir) throw boundaryError(file);
        return { file: path.join(this.root, ...parts), st: null };
      }
      // Junction/symlink 不跟随；native realpath 再排除重解析重定向、Windows 短名和大小写别名。
      if (st.isSymbolicLink() || ((parent || directory) ? !st.isDirectory() : !st.isFile() || st.nlink > 1)
        || fs.realpathSync.native(file) !== file) throw boundaryError(file);
    }
    return { file, st };
  }
}

/** 安卓端 shell 单引号转义（文件名可能带空格/单引号/中文） */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 冲突副本名：`报告.docx` → `报告 (Android 冲突 2026-11-15 031500).docx` */
function conflictName(rel, side, at = new Date()) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const ts = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    + ` ${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}${String(at.getSeconds()).padStart(2, '0')}`;
  const name = `${stem} (${side} 冲突 ${ts})${ext}`;
  return normalizeRel(dir === '.' ? name : `${dir}/${name}`);
}

// 缺少快照条目并不等于删除：扫描可能跳过了文件、子树，或未可靠完成整棵树的枚举。
class ScanCoverage {
  constructor() { this.unknown = new Set(); }

  exclude(rel) { this.unknown.add(rel); }

  uncertain(rel) {
    if (this.unknown.has('')) return true;
    for (let cur = rel; cur; cur = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '') {
      if (this.unknown.has(cur)) return true;
    }
    return false;
  }
}

/**
 * 扫描本机目录。
 * @returns {Promise<Array<{rel:string,size:number,mtime:number,hash:string,key:string}>>}
 */
async function walkLocal(dir, { hashCache = {}, knownKeys = {}, onWarn = () => {}, boundary, coverage = new ScanCoverage() } = {}) {
  boundary = boundary || new HostBoundary(dir);
  if (!boundary.entry) boundary.prepare();
  dir = boundary.root;
  const out = [];
  const walk = async (cur, prefix, depth) => {
    if (depth > 8) { coverage.exclude(prefix); return; }
    let items;
    boundary.checkRoot();
    try { items = await fsp.readdir(cur, { withFileTypes: true }); }
    catch (e) { coverage.exclude(prefix); onWarn(`${cur}: ${e.message}`); return; }
    for (const it of items) {
      if (out.length >= MAX_FILES) { coverage.exclude(prefix); break; }
      if (SKIP_NAME.test(it.name) || !safeComponent(it.name)) continue;
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      try {
        if (it.isDirectory()) {
          const { file, st } = boundary.check(rel, { directory: true });
          if (st) await walk(file, rel, depth + 1);
          else coverage.exclude(rel);
          continue;
        }
        if (!it.isFile()) { coverage.exclude(rel); continue; }
        const { file, st } = boundary.check(rel);
        if (!st || st.size > MAX_FILE) { coverage.exclude(rel); continue; }
        const key = localIdentity(st);
        // 已知文件刚发生变化：不传半截内容，也不认成删除。新文件仍可在首轮同步。
        if (Date.now() - st.mtimeMs < STABLE_MS && knownKeys[rel] && knownKeys[rel] !== key) {
          coverage.exclude(rel);
          continue;
        }
        let hash = hashCache[rel] && hashCache[rel].key === key ? hashCache[rel].hash : '';
        if (!hash) {
          hash = await hashFile(file);
          const after = boundary.check(rel).st;
          if (!after || localIdentity(after) !== key) { coverage.exclude(rel); continue; }
        }
        out.push({ rel, size: st.size, mtime: Math.round(st.mtimeMs), hash, key });
      } catch (e) { coverage.exclude(rel); onWarn(`${rel}: ${e.message}`); }
    }
  };
  await walk(dir, '', 0);
  return out;
}

function hashFile(file, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algorithm);
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 纯函数：根据两侧快照与历史状态，算出这一轮要做什么。
 * 不碰文件系统，便于单元测试（见 test/sync-test.js）。
 *
 * @param {object} o
 * @param {Array} o.local   本机文件 [{rel,size,mtime,hash}]
 * @param {Array} o.remote  设备文件 [{rel,size,mtime,hash}]
 * @param {object} o.state  历史状态 { rel: {baseHash,localHash,remoteHash,...} }
 * @param {boolean} [o.deletes] 是否允许同步删除（默认 false）
 * @param {ScanCoverage} [o.localCoverage] 本机未完成扫描的路径
 * @param {ScanCoverage} [o.remoteCoverage] 设备未完成扫描的路径
 * @returns {{push:Array,pull:Array,conflicts:Array,deletions:Array,pendingDeletes:Array,state:object,converged:number}}
 */
function planSync({ local, remote, state, deletes = false, localCoverage = new ScanCoverage(), remoteCoverage = new ScanCoverage() }) {
  const lm = new Map(local.map((f) => [f.rel, f]));
  const rm = new Map(remote.map((f) => [f.rel, f]));
  const next = { __proto__: null, ...(state || {}) };
  const push = [];
  const pull = [];
  const conflicts = [];
  const deletions = [];
  const pendingDeletes = [];
  let converged = 0;

  const rels = new Set([...lm.keys(), ...rm.keys(), ...Object.keys(next)]);

  for (const rel of rels) {
    const l = lm.get(rel) || null;
    const r = rm.get(rel) || null;
    const st = next[rel] || null;

    // 任一缺失侧不确定时，保留基线；也不能拿另一侧版本覆盖一个正在写的文件。
    if ((!l && localCoverage.uncertain(rel)) || (!r && remoteCoverage.uncertain(rel))) continue;
    if (!l && !r) { delete next[rel]; continue; }

    const base = st && st.baseHash ? st.baseHash : '';
    // 哈希失败不是「没改」的证据；未知内容不能覆盖已有文件或触发删除。
    if (r && r.weak && (l || st)) continue;

    // ── 只有一侧存在 ────────────────────────────────────────────
    if (l && !r) {
      if (base && base === l.hash) {
        // 上次同步后 Android 侧删掉了：默认只提示，绝不动本机文件
        if (deletes) { deletions.push({ rel, deletedOn: 'remote', reason: 'deleted-on-android' }); }
        else pendingDeletes.push({ rel, deletedOn: 'remote' });
        continue;
      }
      push.push({ rel, local: l });
      continue;
    }
    if (!l && r) {
      if (base && base === r.hash) {
        if (deletes) { deletions.push({ rel, deletedOn: 'local', reason: 'deleted-on-windows' }); }
        else pendingDeletes.push({ rel, deletedOn: 'local' });
        continue;
      }
      pull.push({ rel, remote: r });
      continue;
    }

    // ── 两侧都有 ────────────────────────────────────────────────
    if (l.hash === r.hash) {
      next[rel] = {
        baseHash: l.hash, localHash: l.hash, remoteHash: r.hash,
        localKey: l.key, remoteKey: r.key, localMtime: l.mtime, remoteMtime: r.mtime,
        size: l.size, syncedAt: Date.now(),
      };
      converged += 1;
      continue;
    }

    // 上一轮已经判过冲突：谁动过就以谁为准，两侧又都动了才是新冲突
    if (st && st.conflict) {
      const localMoved = l.hash !== st.localHash;
      const remoteMoved = r.hash !== st.remoteHash;
      if (localMoved && !remoteMoved) { push.push({ rel, local: l }); continue; }
      if (!localMoved && remoteMoved) { pull.push({ rel, remote: r }); continue; }
      conflicts.push({ rel, local: l, remote: r, carried: !localMoved && !remoteMoved });
      next[rel] = {
        ...st, conflict: true, localHash: l.hash, remoteHash: r.hash,
        localKey: l.key, remoteKey: r.key, localMtime: l.mtime, remoteMtime: r.mtime,
      };
      continue;
    }

    // 老版本状态里没有哈希（升级后的第一轮）：用大小/时间做一次性判定。
    // 大小相同但内容可能不同 → 走冲突分支，宁可多一个副本，也不静默覆盖。
    if (st && st.migrated) {
      const newer = (l.mtime || 0) - (r.mtime || 0);
      if (l.size !== r.size && Math.abs(newer) > 2000) {
        if (newer > 0) { push.push({ rel, local: l }); } else { pull.push({ rel, remote: r }); }
        continue;
      }
      conflicts.push({ rel, local: l, remote: r, carried: false, fromMigration: true });
      next[rel] = {
        conflict: true, localHash: l.hash, remoteHash: r.hash,
        localKey: l.key, remoteKey: r.key, localMtime: l.mtime, remoteMtime: r.mtime,
        size: l.size, at: Date.now(),
      };
      continue;
    }

    const localChanged = !base || base !== l.hash;
    const remoteChanged = !base || base !== r.hash;

    if (localChanged && !remoteChanged) { push.push({ rel, local: l }); continue; }
    if (!localChanged && remoteChanged) { pull.push({ rel, remote: r }); continue; }

    // 两侧都改过且内容不同 → 冲突（本机为准，安卓版本留副本）
    conflicts.push({ rel, local: l, remote: r, carried: false });
    next[rel] = {
      ...(st || {}), conflict: true, localHash: l.hash, remoteHash: r.hash,
      localKey: l.key, remoteKey: r.key, localMtime: l.mtime, remoteMtime: r.mtime,
      size: l.size, at: Date.now(),
    };
  }

  return { push, pull, conflicts, deletions, pendingDeletes, state: next, converged };
}

/** 老版本状态迁移：{size,lmtime,rmtime,dir} → 新结构（baseHash 未知，让哈希去判） */
function migrateState(raw) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== 'object' || !safeRel(k)) continue;
    const rel = k;
    if (v.baseHash !== undefined || v.localHash !== undefined) { out[rel] = v; continue; }
    out[rel] = {
      migrated: true,
      baseHash: '',
      localHash: '',
      remoteHash: '',
      localMtime: Number(v.lmtime || v.mtime || 0),
      remoteMtime: Number(v.rmtime || 0),
      size: Number(v.size || 0),
      dir: v.dir || '',
      at: Number(v.at || 0),
    };
  }
  return out;
}

class Sharer {
  /**
   * @param {object} runtime 运行时（提供 client()）
   * @param {{dataDir?:string, settings?:Function}} [opts] 测试用注入点：
   *        默认读写真实数据目录/设置，单测可换成临时目录。
   */
  constructor(runtime, opts = {}) {
    this.runtime = runtime;
    this._dataDir = opts.dataDir || store.DATA_DIR;
    this._settings = typeof opts.settings === 'function' ? opts.settings : () => store.getSettings();
    this.stateFile = path.join(this._dataDir, 'shared-state.json');
    this._busy = false;
    this._activeSync = null;
    this._run = null;
    this._stopped = false;
    this._timer = null;
    this._lastError = '';
    this._last = null;          // 最近一轮结果摘要，供 UI 显示
    this._hashTool = null;      // 'sha256' | 'md5' | 'none'
    this._conflictNotice = new Set();
  }

  get localDir() { return this._settings().sharedDir; }
  get remoteDir() { return this._settings().deviceSharedDir; }
  get syncDeletes() { return this._settings().sharedSyncDeletes === true; }

  loadState() {
    try { return migrateState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); } catch (_) { return {}; }
  }

  saveState(s) {
    try {
      // 原子写：写到临时文件再 rename，进程被杀不会留下半个 JSON
      const tmp = `${this.stateFile}.tmp`;
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (_) { /* 状态丢失只会导致下一轮重算，不影响文件安全 */ }
  }

  async ensureDirs(client = this.runtime.client(), host = new HostBoundary(this.localDir), remoteDir = this.remoteDir, run = null) {
    if (!(await client.isOnline())) return false;
    assertRunning(run);
    host.prepare();
    assertRunning(run);
    await client.shell(`mkdir -p ${q(remoteDir)}`);
    assertRunning(run);
    return true;
  }

  /** 设备端有哪些可用的哈希工具（toybox 一般带 sha256sum） */
  async _detectHashTool(client, run = null) {
    assertRunning(run);
    if (this._hashTool) return this._hashTool;
    for (const tool of ['sha256sum', 'md5sum']) {
      try {
        assertRunning(run);
        // eslint-disable-next-line no-await-in-loop
        const out = await client.shell(`command -v ${tool} 2>/dev/null`);
        assertRunning(run);
        if (String(out).trim()) {
          this._hashTool = tool === 'md5sum' ? 'md5' : 'sha256';
          return this._hashTool;
        }
      } catch (error) {
        if (run && run.cancelled) throw stoppedError();
        /* 试下一个 */
      }
    }
    assertRunning(run);
    this._hashTool = 'none';
    return 'none';
  }

  /** 设备端批量算哈希；返回 { rel: hash } */
  async _remoteHashes(client, base, rels, run = null) {
    const out = Object.create(null);
    const tool = await this._detectHashTool(client, run);
    if (tool === 'none' || !rels.length) return out;
    const bin = tool === 'sha256' ? 'sha256sum' : 'md5sum';
    let batch = [];
    let chars = 0;
    const flush = async () => {
      if (!batch.length) return;
      const list = batch.map((r) => q(`./${r}`)).join(' ');
      try {
        assertRunning(run);
        const text = await client.shell(`cd ${q(base)} && ${bin} -- ${list} 2>/dev/null`, { timeout: 60000 });
        assertRunning(run);
        for (const line of String(text).split('\n')) {
          // GNU: "<hash>  <name>"；toybox 同样是两空格分隔
          const m = /^([0-9a-f]{32,64})\s+\*?(.+)$/i.exec(line.trim());
          if (!m) continue;
          const rel = m[2].replace(/^\.\//, '');
          if (safeRel(rel) && batch.includes(rel)) out[rel] = m[1].toLowerCase();
        }
      } catch (error) {
        if (run && run.cancelled) throw stoppedError();
        /* 这一批算不出来就留空，按未知处理 */
      }
      batch = [];
      chars = 0;
    };
    for (const r of rels) {
      if (!safeRel(r)) throw boundaryError(r);
      if (batch.length >= HASH_BATCH || chars + r.length > HASH_BATCH_CHARS) {
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
      batch.push(r);
      chars += r.length + 3;
    }
    await flush();
    return out;
  }

  /**
   * 设备端列表（带 mtime/ctime/size）；返回 null 表示不支持 stat。
   *
   * 解析时同时认两种 stat 输出，不同 ROM 的 toybox/busybox 排版不一样：
   *   A: `%Y|%Z|%s|%n` → mtime|ctime|size|name（现在默认用这个，ctime 用来识别内容变更）
   *   B: `%s|%Y|%n`    → size|mtime|name（老格式，缺 ctime，退化但不报错）
   */
  async listRemote(client, dir = this.remoteDir, coverage = new ScanCoverage(), run = null) {
    try {
      assertRunning(run);
      const text = await client.shell(
        `cd ${q(dir)} 2>/dev/null && find . -type f -exec stat -c '%Y|%Z|%s|%n|:end:' {} +`,
        { timeout: 60000 },
      );
      assertRunning(run);
      const rows = [];
      let parsed = false;
      for (const line of String(text).split(/\r?\n/)) {
        // 只去行结束符，不 trim 文件名（例如 Windows 会把末尾空格当成别名）。
        const cols = line.split('|');
        if (cols.length < 3) { if (line.trim()) coverage.exclude(''); continue; }
        let size; let mtime; let ctime; let name;
        if (cols.length >= 4 && /^\d{9,}$/.test(cols[0]) && /^\d{9,}$/.test(cols[1])) {
          mtime = Number(cols[0]); ctime = Number(cols[1]); size = Number(cols[2]);
          // 尾标记保护文件名免受 adb.shell() 的末尾 trim；兼容旧格式输出。
          name = cols.slice(3, cols.length >= 5 && cols.at(-1) === ':end:' ? -1 : undefined).join('|');
        } else if (/^\d+$/.test(cols[0]) && /^\d{9,}$/.test(cols[1])) {
          size = Number(cols[0]); mtime = Number(cols[1]); ctime = mtime;
          name = cols.slice(2).join('|');
        } else {
          coverage.exclude('');
          continue;
        }
        parsed = true;
        const rel = name.replace(/^\.\//, '');
        if (!safeRel(rel) || rel.split('/').some((part) => SKIP_NAME.test(part))) continue;
        if (!/^\.\//.test(name) || !Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime)
          || !Number.isFinite(ctime)) { coverage.exclude(''); continue; }
        if (size > MAX_FILE) { coverage.exclude(rel); continue; }
        rows.push({
          rel, size,
          mtime: mtime * 1000,
          ctime: ctime * 1000,
          key: `${size}:${mtime}:${ctime}`,
        });
      }
      // 不安全的条目已被过滤，不必再用另一套解析器尝试。
      if (parsed) return rows;
      if (String(text).trim() === '') {
        // 空目录和「stat 不可用」都是空输出：再确认一次目录里到底有没有文件，
        // 否则不支持 stat 的设备会被当成「空目录」，两端永远同步不了。
        try {
          // 不能让 head 的成功掩盖 find 的枚举错误。
          const probe = await client.shell(`cd ${q(dir)} 2>/dev/null && find . -type f 2>/dev/null | head -n 1 && find . -type f >/dev/null`, { timeout: 15000 });
          if (!String(probe).trim()) return [];
        } catch (_) { /* 探测失败按不支持处理 */ }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /** 兼容旧接口：递归列出设备端文件（历史 API 名，内部走 listRemote） */
  async listRemoteRecursive(client, dir = this.remoteDir) {
    const rows = await this.listRemote(client, dir);
    return rows || [];
  }

  /** 老设备兜底：ls -l（只能拿大小，哈希仍然会算，所以正确性不受影响） */
  async listRemoteFallback(client, remoteDir = this.remoteDir, run = null) {
    const rows = [];
    const walk = async (prefix, depth) => {
      assertRunning(run);
      if (depth > 5) return;
      let items = [];
      try { items = await client.listRemote(prefix ? `${remoteDir}/${prefix}` : remoteDir); }
      catch (error) { if (run && run.cancelled) throw stoppedError(); return; }
      assertRunning(run);
      for (const it of items) {
        assertRunning(run);
        if (!it || typeof it.name !== 'string' || !safeComponent(it.name) || SKIP_NAME.test(it.name)) continue;
        const rel = prefix ? `${prefix}/${it.name}` : it.name;
        if (it.isDir) {
          // adb.listRemote 将目录嵌入双引号，不能允许 guest 文件名触发 shell 展开。
          if (/[$`]/.test(it.name)) continue;
          await walk(rel, depth + 1);
        } else if (Number.isSafeInteger(it.size) && it.size >= 0 && it.size <= MAX_FILE) {
          rows.push({ rel, size: it.size, mtime: 0, ctime: 0, key: `${it.size}:0:0` });
        }
      }
    };
    await walk('', 0);
    return rows;
  }

  sync(opts = {}) {
    if (this._stopped) return Promise.resolve({ skipped: true, stopped: true });
    if (this._busy) return Promise.resolve({ skipped: true });
    this._busy = true;
    const run = { cancelled: false };
    this._run = run;
    const active = this._sync(opts, run).finally(() => {
      this._busy = false;
      if (this._run === run) this._run = null;
      if (this._activeSync === active) this._activeSync = null;
    });
    this._activeSync = active;
    return active;
  }

  async _sync({ onLog = () => {} } = {}, run) {
    const result = {
      pushed: 0, pulled: 0, conflicts: 0, deleted: 0, errors: [], skipped: 0,
      pendingDeletes: 0, at: Date.now(),
    };
    try {
      assertRunning(run);
      const client = this.runtime.client();
      if (!(await client.isOnline())) throw new Error('运行时未连接');
      assertRunning(run);
      const host = new HostBoundary(this.localDir);
      const remoteDir = this.remoteDir;
      await this.ensureDirs(client, host, remoteDir, run);
      assertRunning(run);
      // 设置即使在异步 adb 调用期间变化，也不能改变本轮已经授权的根。
      const context = { host, remoteDir };

      const state = this.loadState();
      // 本机哈希缓存绑定完整文件身份（dev/ino/size/mtime/ctime），旧 key 不会命中。
      const hashCache = Object.create(null);
      for (const [rel, st] of Object.entries(state)) {
        if (st && st.localHash && st.localKey) hashCache[rel] = { key: st.localKey, hash: st.localHash };
      }
      const localCoverage = new ScanCoverage();
      const remoteCoverage = new ScanCoverage();
      const local = await walkLocal(host.root, {
        coverage: localCoverage,
        boundary: host,
        hashCache,
        knownKeys: Object.fromEntries(
          Object.entries(state).filter(([, st]) => st && st.localKey).map(([rel, st]) => [rel, st.localKey]),
        ),
        onWarn: (m) => result.errors.push(`本机 ${m}`),
      });
      assertRunning(run);

      let remote = await this.listRemote(client, remoteDir, remoteCoverage, run);
      assertRunning(run);
      if (!remote) {
        onLog('设备不支持 stat，改用 ls -l 兜底（会把大目录扫得慢一些）');
        // ls -l 可能丢行、改写文件名或超过递归上限，不能用它证明文件不存在。
        remoteCoverage.exclude('');
        remote = await this.listRemoteFallback(client, remoteDir, run);
        assertRunning(run);
      }
      // 在进入计划前挡住现有的链接/别名，执行时仍需复查（列表之后目录可能变了）。
      remote = remote.filter(({ rel }) => {
        try { host.check(rel); return true; }
        catch (e) {
          localCoverage.exclude(rel);
          remoteCoverage.exclude(rel);
          result.errors.push(`↓ ${rel}: ${e.message}`);
          return false;
        }
      });

      // ls 兜底没有真实时间戳，不能拿大小不变推断文件未改（尤其不能据此删除）。
      const cachedRemoteHash = (r) => {
        const st = state[r.rel];
        return r.mtime && st && st.remoteKey === r.key ? st.remoteHash : '';
      };
      const needHash = remote.filter((r) => !cachedRemoteHash(r));
      const hashes = await this._remoteHashes(client, remoteDir, needHash.map((r) => r.rel), run);
      assertRunning(run);
      for (const r of remote) r.hash = hashes[r.rel] || cachedRemoteHash(r) || '';
      // 算不出哈希的文件按「大小 + 时间」视作身份，标记 weak（宁可少同步也不误删）
      for (const r of remote) {
        if (!r.hash) { r.hash = `weak:${r.size}:${r.mtime}`; r.weak = true; }
      }

      const plan = planSync({ local, remote, state, deletes: this.syncDeletes, localCoverage, remoteCoverage });

      // ── 推送：Windows → Android ─────────────────────────────
      for (const item of plan.push) {
        try {
          assertRunning(run);
          // eslint-disable-next-line no-await-in-loop
          await this._pushOne(client, item.rel, item.local, context, run);
          assertRunning(run);
          const st = plan.state[item.rel] || {};
          plan.state[item.rel] = {
            ...st, conflict: false,
            baseHash: item.local.hash, localHash: item.local.hash,
            remoteHash: item.local.hash,   // 推送后两侧应当一致（下面会校验）
            localKey: item.local.key, remoteKey: '',
            localMtime: item.local.mtime, remoteMtime: Date.now(),
            size: item.local.size, syncedAt: Date.now(),
          };
          result.pushed += 1;
        } catch (e) {
          if (run.cancelled) throw stoppedError();
          result.errors.push(`↑ ${item.rel}: ${e.message}`);
        }
      }

      // ── 拉取：Android → Windows ─────────────────────────────
      for (const item of plan.pull) {
        try {
          assertRunning(run);
          // eslint-disable-next-line no-await-in-loop
          const got = await this._pullOne(client, item.rel, item.rel, context, { run });
          assertRunning(run);
          const st = plan.state[item.rel] || {};
          plan.state[item.rel] = {
            ...st, conflict: false,
            baseHash: got.hash, localHash: got.hash, remoteHash: got.hash,
            localKey: got.key, remoteKey: item.remote.key,
            localMtime: got.mtime, remoteMtime: item.remote.mtime,
            size: got.size, syncedAt: Date.now(),
          };
          result.pulled += 1;
        } catch (e) {
          if (run.cancelled) throw stoppedError();
          result.errors.push(`↓ ${item.rel}: ${e.message}`);
        }
      }

      // ── 冲突：保留两侧，落一份 Android 版本副本 ──────────────
      for (const c of plan.conflicts) {
        if (c.carried) { result.conflicts += 1; continue; }
        try {
          assertRunning(run);
          host.check(c.rel);
          const copyRel = this._freeName(host, conflictName(c.rel, 'Android'));
          // eslint-disable-next-line no-await-in-loop
          const copy = await this._pullOne(client, c.rel, copyRel, context, { newFile: true, run });
          assertRunning(run);
          // eslint-disable-next-line no-await-in-loop
          await this._pushOne(client, copyRel, copy, context, run);
          assertRunning(run);
          result.conflicts += 1;
          const key = `${c.rel}:${c.remote.hash}`;
          if (!this._conflictNotice.has(key)) {
            this._conflictNotice.add(key);
            onLog(`⚠ ${c.rel} 在两侧都被修改：已保留本机版本，并把 Android 版本另存为「${path.basename(copyRel)}」`);
          }
        } catch (e) {
          if (run.cancelled) throw stoppedError();
          result.errors.push(`⚠ ${c.rel}: 冲突副本创建失败（${e.message}），已跳过以保护原文件`);
        }
      }

      // ── 删除（仅显式开启，且只移进回收目录）──────────────────
      if (this.syncDeletes) {
        for (const d of plan.deletions) {
          try {
            assertRunning(run);
            // eslint-disable-next-line no-await-in-loop
            await this._trashOne(client, d, context, run);
            assertRunning(run);
            delete plan.state[d.rel];
            result.deleted += 1;
          } catch (e) {
            if (run.cancelled) throw stoppedError();
            result.errors.push(`🗑 ${d.rel}: ${e.message}`);
          }
        }
      } else {
        result.pendingDeletes = plan.pendingDeletes.length;
      }

      assertRunning(run);
      this._pruneState(plan.state);
      assertRunning(run);
      this.saveState(plan.state);
      this._lastError = result.errors[0] || '';
      this._last = result;
      return result;
    } catch (e) {
      if (e.code === 'SHARER_STOPPED' || run.cancelled) {
        result.cancelled = true;
        this._lastError = '';
        this._last = result;
        return result;
      }
      this._lastError = e.message;
      this._last = { ...result, error: e.message };
      return { ...result, error: e.message };
    }
  }

  /** 同名副本已存在（同一秒内多次冲突）：加序号 */
  _freeName(host, rel) {
    const ext = path.posix.extname(rel);
    const stem = ext ? rel.slice(0, rel.length - ext.length) : rel;
    let candidate = rel;
    for (let i = 2; i < 100; i += 1) {
      if (!host.check(candidate).st) return candidate;
      candidate = `${stem}-${i}${ext}`;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  /** 推送单文件：远端暂存文件验证通过后才能替换原件，失败只清理暂存文件。 */
  async _pushOne(client, rel, meta, { host, remoteDir }, run = null) {
    assertRunning(run);
    if (!host.check(rel).st) throw boundaryError(rel);
    const remote = `${remoteDir}/${rel}`;
    const dir = path.posix.dirname(remote);
    const tmpRel = `${rel.slice(0, rel.lastIndexOf('/') + 1)}.apkstart-tmp-${crypto.randomBytes(8).toString('hex')}`;
    const tmp = `${remoteDir}/${tmpRel}`;
    let tempMayExist = false;
    try {
      await client.shell(`mkdir -p ${q(dir)}`);
      assertRunning(run);
      const availableTool = await this._detectHashTool(client, run);
      assertRunning(run);
      const { file, st } = host.check(rel);
      if (!st) throw boundaryError(file);
      const expectedSize = meta && meta.size != null ? meta.size : st.size;
      if (expectedSize !== st.size) throw new Error('推送前文件已变化，已保留设备原件');
      const tool = expectedSize <= VERIFY_PUSH_MAX ? availableTool : 'none';
      let expectedHash = '';
      if (tool !== 'none') {
        expectedHash = tool === 'sha256' && meta && /^[a-f0-9]{64}$/i.test(meta.hash || '')
          ? meta.hash : await hashFile(file, tool);
        if (!sameEntry(st, host.check(rel).st)) throw boundaryError(file);
      }
      assertRunning(run);
      tempMayExist = true;
      await client.push(file, tmp);
      assertRunning(run);
      const after = host.check(rel).st;
      if (!sameEntry(st, after) || st.size !== after.size || st.mtimeMs !== after.mtimeMs
        || st.ctimeMs !== after.ctimeMs) throw new Error('推送期间文件已变化，已保留设备原件');

      // 没有哈希工具的旧设备退到大小校验；工具已可用却未返回哈希则必须中止。
      if (tool !== 'none') {
        const got = await this._remoteHashes(client, remoteDir, [tmpRel], run);
        assertRunning(run);
        if (!got[tmpRel] || got[tmpRel] !== expectedHash) {
          throw new Error('推送暂存文件校验失败（设备端内容不一致或无法校验），已保留设备原件');
        }
      } else {
        const text = String(await client.shell(`stat -c '%s' ${q(tmp)} 2>/dev/null`)).trim();
        assertRunning(run);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) !== expectedSize) {
          throw new Error(`推送暂存文件大小校验失败（${text || '未知'} ≠ ${expectedSize}），已保留设备原件`);
        }
      }
      assertRunning(run);
      await client.shell(`mv -f ${q(tmp)} ${q(remote)}`);
    } catch (e) {
      if (tempMayExist) await client.shell(`rm -f ${q(tmp)}`).catch(() => {});
      throw e;
    }
  }

  /** 拉取单文件：ADB 只写根下的独立暂存目录，不接触 guest 指定的宿主父目录。 */
  async _pullOne(client, rel, target, { host, remoteDir }, { newFile = false, run = null } = {}) {
    assertRunning(run);
    if (!safeRel(rel)) throw boundaryError(rel);
    const remote = `${remoteDir}/${rel}`;
    const checkTarget = (opts) => {
      const dst = host.check(target, opts);
      if (newFile && dst.st) throw boundaryError(dst.file);
      return dst;
    };
    checkTarget();
    assertRunning(run);
    const stage = fs.mkdtempSync(path.join(host.root, '.apkstart-pull-'));
    const stageRel = path.basename(stage);
    const tmpRel = `${stageRel}/payload`;
    const entry = host.check(stageRel, { directory: true }).st;
    const checkStage = () => {
      if (!sameEntry(entry, host.check(stageRel, { directory: true }).st)) throw boundaryError(stage);
      return host.check(tmpRel);
    };
    try {
      const { file: tmp } = checkStage();
      assertRunning(run);
      // 已存在的普通文件也让 ADB 拒绝把设备目录作为拉取源。
      fs.closeSync(fs.openSync(tmp, 'wx'));
      await client.pull(remote, tmp);
      assertRunning(run);
      const { st } = checkStage();
      if (!st || st.size > MAX_FILE) throw boundaryError(tmp);
      const key = localIdentity(st);
      const hash = await hashFile(tmp);
      assertRunning(run);
      const after = checkStage().st;
      if (!after || localIdentity(after) !== key) throw boundaryError(tmp);
      const dst = checkTarget({ mkdir: true });
      assertRunning(run);
      fs.renameSync(tmp, dst.file);
      // 只缓存实际哈希过的版本；若 rename 更新了 ctime，下轮重新验证。
      return { size: st.size, mtime: Math.round(st.mtimeMs), hash, key };
    } finally {
      // 若路径已被换成链接，宁可留下暂存残骸，也不能沿着链接删除其它文件。
      try {
        const tmp = checkStage();
        if (tmp.st) fs.unlinkSync(tmp.file);
        fs.rmdirSync(stage);
      } catch (_) { /* ignore */ }
    }
  }

  /** 删除同步：移到回收目录（两侧都可找回），不做硬删除 */
  async _trashOne(client, d, { host, remoteDir }, run = null) {
    assertRunning(run);
    if (!safeRel(d.rel)) throw boundaryError(d.rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // deletedOn 表示「哪一侧把它删了」：被删的是另一侧的那份文件
    if (d.deletedOn === 'remote') {
      const dst = host.check(`.apkstart-trash/${stamp}/${d.rel}`, { mkdir: true });
      const src = host.check(d.rel);
      if (!src.st || dst.st) throw boundaryError(d.rel);
      assertRunning(run);
      fs.renameSync(src.file, dst.file);
      return;
    }
    host.check(d.rel);
    const src = `${remoteDir}/${d.rel}`;
    const dst = `${remoteDir}/.apkstart-trash/${stamp}/${d.rel}`;
    await client.shell(`mkdir -p ${q(path.posix.dirname(dst))}`);
    assertRunning(run);
    await client.shell(`mv -f ${q(src)} ${q(dst)}`);
  }

  /** 状态表只保留「两侧都还存在」或 30 天内活跃过的条目，防止无限增长 */
  _pruneState(state) {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 3600 * 1000;
    for (const [rel, st] of Object.entries(state)) {
      if (!st) { delete state[rel]; continue; }
      if (st.conflict) continue;
      const at = st.syncedAt || st.at || 0;
      if (at && at < cutoff) delete state[rel];
    }
  }

  /** UI 用的状态摘要 */
  status() {
    return {
      localDir: this.localDir,
      remoteDir: this.remoteDir,
      busy: this._busy,
      running: !!this._timer,
      stopped: this._stopped,
      lastError: this._lastError,
      last: this._last,
      syncDeletes: this.syncDeletes,
      hashTool: this._hashTool || 'unknown',
    };
  }

  start(intervalMs = 8000) {
    if (this._timer) return;
    this._stopped = false;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * 等待当前同步结束，最多等待 timeoutMs；true=已完全排空，false=超时仍有在途 I/O。
   * 超时不会强杀 adb 请求；调用者在 false 时应避免关闭其依赖的运行时/ADB 传输。
   */
  async join(timeoutMs = 5000) {
    const pending = this._activeSync;
    if (!pending) return true;
    const limit = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(Math.floor(timeoutMs), 30000)) : 5000;
    let timer;
    try {
      return await Promise.race([
        pending.then(() => true, () => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), limit); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * 停掉周期任务并合作式取消当前一轮；不会中断文件/adb 操作，也不会删除原件。
   * 返回 join 的 boolean，默认最多等待 5 秒；false 表示 I/O 尚未排空。
   * 再次 start() 是显式恢复，会放行新一轮，但已取消的旧轮仍不会提交。
   */
  stop({ timeoutMs = 5000 } = {}) {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._stopped = true;
    if (this._run) this._run.cancelled = true;
    return this.join(timeoutMs);
  }

  get lastError() { return this._lastError; }
}

module.exports = {
  Sharer, planSync, migrateState, conflictName, normalizeRel, walkLocal, SKIP_NAME, MAX_FILE,
};

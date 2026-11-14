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
const VERIFY_PUSH_MAX = 8 * 1024 * 1024; // 推送后回读校验哈希的大小上限

/** 两侧都要忽略的东西：隐藏文件、编辑器临时文件、下载中间态 */
const SKIP_NAME = /^(\.|~\$)|\.(tmp|temp|crdownload|part|partial|download|swp)$/i;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
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

/**
 * 扫描本机目录。
 * @returns {Promise<Array<{rel:string,size:number,mtime:number,hash:string,key:string}>>}
 */
async function walkLocal(dir, { hashCache = {}, knownKeys = {}, onWarn = () => {} } = {}) {
  const out = [];
  const walk = async (cur, depth) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let items = [];
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (SKIP_NAME.test(it.name)) continue;
      const full = path.join(cur, it.name);
      if (it.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full, depth + 1);
      } else if (it.isFile()) {
        let st;
        try { st = await fsp.stat(full); } catch (_) { continue; }
        if (st.size > MAX_FILE) continue;
        const rel = normalizeRel(path.relative(dir, full));
        const key = `${st.size}:${Math.round(st.mtimeMs)}`;
        // 正在写入的文件：本轮跳过，别把半截内容当成新版本传出去。
        // 判定条件是「我们之前见过它，而且它刚刚才被改动」——
        // 从没见过的文件（用户刚放进共享目录）照常同步，否则新文件要空转一轮；
        // 已知文件在毫秒级内又变了，才说明有程序正在写它。
        if (Date.now() - st.mtimeMs < STABLE_MS && knownKeys[rel] && knownKeys[rel] !== key) {
          continue;
        }
        let hash = hashCache[rel] && hashCache[rel].key === key ? hashCache[rel].hash : '';
        if (!hash) {
          try { hash = await hashFile(full); } catch (e) { onWarn(`${rel}: ${e.message}`); continue; }
        }
        out.push({ rel, size: st.size, mtime: Math.round(st.mtimeMs), hash, key });
      }
    }
  };
  await walk(dir, 0);
  return out;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
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
 * @returns {{push:Array,pull:Array,conflicts:Array,deletions:Array,pendingDeletes:Array,state:object,converged:number}}
 */
function planSync({ local, remote, state, deletes = false }) {
  const lm = new Map(local.map((f) => [f.rel, f]));
  const rm = new Map(remote.map((f) => [f.rel, f]));
  const next = { ...(state || {}) };
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

    if (!l && !r) { delete next[rel]; continue; }

    const base = st && st.baseHash ? st.baseHash : '';

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
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== 'object') continue;
    const rel = normalizeRel(k);
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

  async ensureDirs() {
    if (!fs.existsSync(this.localDir)) fs.mkdirSync(this.localDir, { recursive: true });
    const client = this.runtime.client();
    if (!(await client.isOnline())) return false;
    await client.shell(`mkdir -p ${q(this.remoteDir)}`);
    return true;
  }

  /** 设备端有哪些可用的哈希工具（toybox 一般带 sha256sum） */
  async _detectHashTool(client) {
    if (this._hashTool) return this._hashTool;
    for (const tool of ['sha256sum', 'md5sum']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await client.shell(`command -v ${tool} 2>/dev/null`);
        if (String(out).trim()) {
          this._hashTool = tool === 'md5sum' ? 'md5' : 'sha256';
          return this._hashTool;
        }
      } catch (_) { /* 试下一个 */ }
    }
    this._hashTool = 'none';
    return 'none';
  }

  /** 设备端批量算哈希；返回 { rel: hash } */
  async _remoteHashes(client, base, rels) {
    const out = {};
    const tool = await this._detectHashTool(client);
    if (tool === 'none' || !rels.length) return out;
    const bin = tool === 'sha256' ? 'sha256sum' : 'md5sum';
    let batch = [];
    let chars = 0;
    const flush = async () => {
      if (!batch.length) return;
      const list = batch.map((r) => q(`./${r}`)).join(' ');
      try {
        const text = await client.shell(`cd ${q(base)} && ${bin} -- ${list} 2>/dev/null`, { timeout: 60000 });
        for (const line of String(text).split('\n')) {
          // GNU: "<hash>  <name>"；toybox 同样是两空格分隔
          const m = /^([0-9a-f]{32,64})\s+\*?(.+)$/i.exec(line.trim());
          if (!m) continue;
          out[normalizeRel(m[2])] = m[1].toLowerCase();
        }
      } catch (_) { /* 这一批算不出来就留空，按未知处理 */ }
      batch = [];
      chars = 0;
    };
    for (const r of rels) {
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
  async listRemote(client, dir = this.remoteDir) {
    try {
      const text = await client.shell(
        `cd ${q(dir)} 2>/dev/null && find . -type f -exec stat -c '%Y|%Z|%s|%n' {} + 2>/dev/null`,
        { timeout: 60000 },
      );
      const rows = [];
      for (const line of String(text).split('\n')) {
        const cols = line.trim().split('|');
        if (cols.length < 3) continue;
        let size; let mtime; let ctime; let name;
        if (cols.length >= 4 && /^\d{9,}$/.test(cols[0]) && /^\d{9,}$/.test(cols[1])) {
          mtime = Number(cols[0]); ctime = Number(cols[1]); size = Number(cols[2]);
          name = cols.slice(3).join('|');
        } else if (/^\d+$/.test(cols[0]) && /^\d{9,}$/.test(cols[1])) {
          size = Number(cols[0]); mtime = Number(cols[1]); ctime = mtime;
          name = cols.slice(2).join('|');
        } else {
          continue;
        }
        if (!Number.isFinite(size) || !Number.isFinite(mtime)) continue;
        const rel = normalizeRel(name);
        if (!rel || rel.endsWith('/') || SKIP_NAME.test(path.posix.basename(rel))) continue;
        if (size > MAX_FILE) continue;
        rows.push({
          rel, size,
          mtime: mtime * 1000,
          ctime: ctime * 1000,
          key: `${size}:${mtime}:${ctime}`,
        });
      }
      // 有输出但一行都没解析出来 → 设备不支持这套 stat 格式
      if (rows.length) return rows;
      if (String(text).trim() === '') {
        // 空目录和「stat 不可用」都是空输出：再确认一次目录里到底有没有文件，
        // 否则不支持 stat 的设备会被当成「空目录」，两端永远同步不了。
        try {
          const probe = await client.shell(`cd ${q(dir)} 2>/dev/null && find . -type f 2>/dev/null | head -n 1`, { timeout: 15000 });
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
  async listRemoteFallback(client) {
    const rows = [];
    const walk = async (prefix, depth) => {
      if (depth > 5) return;
      let items = [];
      try { items = await client.listRemote(prefix ? `${this.remoteDir}/${prefix}` : this.remoteDir); } catch (_) { return; }
      for (const it of items) {
        if (!it || it.name === '.' || it.name === '..') continue;
        if (SKIP_NAME.test(it.name)) continue;
        const rel = prefix ? `${prefix}/${it.name}` : it.name;
        if (it.isDir) {
          // eslint-disable-next-line no-await-in-loop
          await walk(rel, depth + 1);
        } else if (it.size <= MAX_FILE) {
          rows.push({ rel: normalizeRel(rel), size: it.size, mtime: 0, ctime: 0, key: `${it.size}:0:0` });
        }
      }
    };
    await walk('', 0);
    return rows;
  }

  async sync({ onLog = () => {} } = {}) {
    if (this._busy) return { skipped: true };
    this._busy = true;
    const result = {
      pushed: 0, pulled: 0, conflicts: 0, deleted: 0, errors: [], skipped: 0,
      pendingDeletes: 0, at: Date.now(),
    };
    try {
      const client = this.runtime.client();
      if (!(await client.isOnline())) throw new Error('运行时未连接');
      await this.ensureDirs();

      const state = this.loadState();
      // 本机哈希缓存：只在 (size,mtime) 变化时重算
      const hashCache = {};
      for (const [rel, st] of Object.entries(state)) {
        if (st && st.localHash && st.localKey) hashCache[rel] = { key: st.localKey, hash: st.localHash };
      }
      const local = await walkLocal(this.localDir, {
        hashCache,
        knownKeys: Object.fromEntries(
          Object.entries(state).filter(([, st]) => st && st.localKey).map(([rel, st]) => [rel, st.localKey]),
        ),
        onWarn: (m) => result.errors.push(`本机 ${m}`),
      });

      let remote = await this.listRemote(client);
      if (!remote) {
        onLog('设备不支持 stat，改用 ls -l 兜底（会把大目录扫得慢一些）');
        remote = await this.listRemoteFallback(client);
      }

      // 设备端哈希：只对「key 变了」或没有缓存的文件算
      const needHash = remote.filter((r) => {
        const st = state[r.rel];
        return !(st && st.remoteKey === r.key && st.remoteHash);
      });
      const hashes = await this._remoteHashes(client, this.remoteDir, needHash.map((r) => r.rel));
      for (const r of remote) {
        const st = state[r.rel];
        r.hash = hashes[r.rel]
          || (st && st.remoteKey === r.key ? st.remoteHash : '')
          || '';
      }
      // 算不出哈希的文件按「大小 + 时间」视作身份，标记 weak（宁可少同步也不误删）
      for (const r of remote) {
        if (!r.hash) { r.hash = `weak:${r.size}:${r.mtime}`; r.weak = true; }
      }

      const plan = planSync({ local, remote, state, deletes: this.syncDeletes });

      // ── 推送：Windows → Android ─────────────────────────────
      for (const item of plan.push) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await this._pushOne(client, item.rel, path.join(this.localDir, item.rel), item.local);
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
          result.errors.push(`↑ ${item.rel}: ${e.message}`);
        }
      }

      // ── 拉取：Android → Windows ─────────────────────────────
      for (const item of plan.pull) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const got = await this._pullOne(client, item.rel, path.join(this.localDir, item.rel));
          const st = plan.state[item.rel] || {};
          plan.state[item.rel] = {
            ...st, conflict: false,
            baseHash: got.hash, localHash: got.hash, remoteHash: got.hash,
            localKey: `${got.size}:${got.mtime}`, remoteKey: item.remote.key,
            localMtime: got.mtime, remoteMtime: item.remote.mtime,
            size: got.size, syncedAt: Date.now(),
          };
          result.pulled += 1;
        } catch (e) {
          result.errors.push(`↓ ${item.rel}: ${e.message}`);
        }
      }

      // ── 冲突：保留两侧，落一份 Android 版本副本 ──────────────
      for (const c of plan.conflicts) {
        if (c.carried) { result.conflicts += 1; continue; }
        try {
          const copyRel = this._freeName(this.localDir, conflictName(c.rel, 'Android'));
          // eslint-disable-next-line no-await-in-loop
          await this._pullOne(client, c.rel, path.join(this.localDir, copyRel));
          // eslint-disable-next-line no-await-in-loop
          await this._pushOne(client, copyRel, path.join(this.localDir, copyRel), { hash: '' });
          result.conflicts += 1;
          const key = `${c.rel}:${c.remote.hash}`;
          if (!this._conflictNotice.has(key)) {
            this._conflictNotice.add(key);
            onLog(`⚠ ${c.rel} 在两侧都被修改：已保留本机版本，并把 Android 版本另存为「${path.basename(copyRel)}」`);
          }
        } catch (e) {
          result.errors.push(`⚠ ${c.rel}: 冲突副本创建失败（${e.message}），已跳过以保护原文件`);
        }
      }

      // ── 删除（仅显式开启，且只移进回收目录）──────────────────
      if (this.syncDeletes) {
        for (const d of plan.deletions) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await this._trashOne(client, d);
            delete plan.state[d.rel];
            result.deleted += 1;
          } catch (e) {
            result.errors.push(`🗑 ${d.rel}: ${e.message}`);
          }
        }
      } else {
        result.pendingDeletes = plan.pendingDeletes.length;
      }

      this._pruneState(plan.state);
      this.saveState(plan.state);
      this._lastError = result.errors[0] || '';
      this._last = result;
      return result;
    } catch (e) {
      this._lastError = e.message;
      this._last = { ...result, error: e.message };
      return { ...result, error: e.message };
    } finally {
      this._busy = false;
    }
  }

  /** 同名副本已存在（同一秒内多次冲突）：加序号 */
  _freeName(dir, rel) {
    const ext = path.posix.extname(rel);
    const stem = ext ? rel.slice(0, rel.length - ext.length) : rel;
    let candidate = rel;
    for (let i = 2; i < 100; i += 1) {
      if (!fs.existsSync(path.join(dir, candidate))) return candidate;
      candidate = `${stem}-${i}${ext}`;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  /** 推送单文件：先传临时名，再原子 mv，避免对端看到半截文件 */
  async _pushOne(client, rel, localAbs, meta) {
    const remote = `${this.remoteDir}/${rel}`;
    const dir = path.posix.dirname(remote);
    await client.shell(`mkdir -p ${q(dir)}`);
    const tmp = `${remote}.apkstart-tmp-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await client.push(localAbs, tmp);
      await client.shell(`mv -f ${q(tmp)} ${q(remote)}`);
    } catch (e) {
      await client.shell(`rm -f ${q(tmp)}`).catch(() => {});
      throw e;
    }
    // 推送后校验：小文件回读哈希（adb push 偶发静默截断），大文件至少核对大小
    if (meta && meta.size != null) {
      const solid = meta.hash && !String(meta.hash).startsWith('weak:');
      if (solid && meta.size <= VERIFY_PUSH_MAX) {
        const got = await this._remoteHashes(client, this.remoteDir, [rel]);
        if (got[rel] && got[rel] !== meta.hash) {
          await client.shell(`rm -f ${q(remote)}`).catch(() => {});
          throw new Error('推送后校验失败（设备端内容不一致），已删除损坏副本并中止该文件');
        }
      } else {
        const sizeText = await client.shell(`stat -c '%s' ${q(remote)} 2>/dev/null`).catch(() => '');
        const gotSize = Number(String(sizeText).trim());
        if (Number.isFinite(gotSize) && gotSize > 0 && gotSize !== meta.size) {
          await client.shell(`rm -f ${q(remote)}`).catch(() => {});
          throw new Error(`推送后大小不一致（${gotSize} ≠ ${meta.size}），已删除损坏副本`);
        }
      }
    }
  }

  /** 拉取单文件：先拉到同目录临时文件，校验哈希后再原子替换 */
  async _pullOne(client, rel, localAbs) {
    const remote = `${this.remoteDir}/${rel}`;
    fs.mkdirSync(path.dirname(localAbs), { recursive: true });
    const tmp = `${localAbs}.apkstart-tmp-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await client.pull(remote, tmp);
      const st = await fsp.stat(tmp);
      const hash = await hashFile(tmp);
      fs.renameSync(tmp, localAbs);
      return { size: st.size, mtime: Math.round(st.mtimeMs), hash };
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  /** 删除同步：移到回收目录（两侧都可找回），不做硬删除 */
  async _trashOne(client, d) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // deletedOn 表示「哪一侧把它删了」：被删的是另一侧的那份文件
    if (d.deletedOn === 'remote') {
      const src = path.join(this.localDir, d.rel);
      const dst = path.join(this.localDir, '.apkstart-trash', stamp, d.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return;
    }
    const src = `${this.remoteDir}/${d.rel}`;
    const dst = `${this.remoteDir}/.apkstart-trash/${stamp}/${d.rel}`;
    await client.shell(`mkdir -p ${q(path.posix.dirname(dst))}`);
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
      lastError: this._lastError,
      last: this._last,
      syncDeletes: this.syncDeletes,
      hashTool: this._hashTool || 'unknown',
    };
  }

  start(intervalMs = 8000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  get lastError() { return this._lastError; }
}

module.exports = {
  Sharer, planSync, migrateState, conflictName, normalizeRel, walkLocal, SKIP_NAME, MAX_FILE,
};

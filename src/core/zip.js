'use strict';
/**
 * 极简 ZIP 读取器（仅依赖 Node 内置 zlib）
 * 只解析中央目录，按需解压单个条目，避免大 APK 全量解压撑爆内存。
 *
 * 注意：本文件只做「读」，不做「写」。两处「大小」相关的不变量：
 *  - 单个 Buffer 有上限（Node 约 2GB），所以 GB 级条目一律走 ZipFile + pipeTo；
 *  - ZIP 的传统 EOCD 用 16/32 位存条目数与偏移，超过就进位成 0xffff/0xffffffff，
 *    真正的值在 Zip64 EOCD（0x06064b50）与 Zip64 扩展字段（id=0x0001）里。
 *    两条路径都必须识别，否则大镜像包会被「静默截断条目」或直接越界。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Readable, Transform, pipeline } = require('stream');

function waitForClose(stream) {
  if (!stream || stream.closed || stream.emitClose === false
    || stream.autoClose === false || stream.autoDestroy === false) return Promise.resolve();
  return new Promise((resolve) => {
    if (stream.closed) resolve();
    else stream.once('close', resolve);
  });
}

function rejectDestination(dest, error) {
  if (dest && typeof dest.destroy === 'function' && !dest.destroyed) dest.destroy();
  return waitForClose(dest).then(() => { throw error; });
}

/** pipeline 错误时关闭所有流；CRC/长度通过且目标关闭后才算完成。 */
function pipeEntry(source, entry, dest, opts = {}) {
  let crc = 0;
  let bytes = 0;
  const verify = new Transform({
    transform(chunk, _encoding, cb) {
      if (opts.verify) crc = crc32(chunk, crc);
      bytes += chunk.length;
      cb(null, chunk);
    },
    flush(cb) {
      if (opts.verify && (crc >>> 0) !== (entry.crc >>> 0)) return cb(new Error(`条目校验失败（CRC 不匹配）: ${entry.name}`));
      if (opts.verify && bytes !== entry.uncompSize) return cb(new Error(`条目大小不符（${bytes} ≠ ${entry.uncompSize}）: ${entry.name}`));
      return cb();
    },
  });
  const streams = [source];
  if (entry.method === 8) streams.push(zlib.createInflateRaw());
  else if (entry.method !== 0) {
    source.destroy();
    return rejectDestination(dest, new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`));
  }
  streams.push(verify, dest);
  return new Promise((resolve, reject) => {
    const closed = waitForClose(dest);
    pipeline(...streams, (err) => {
      closed.then(() => (err ? reject(err) : resolve(entry.uncompSize)), reject);
    });
  });
}


const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOC_SIG = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// read() 单条目上限：超过就要求调用方走 pipeTo（流式），避免整块进内存
const MAX_READ = 256 * 1024 * 1024;

/** ZIP 条目里「用了什么压缩方式 + 是不是符号链接」都要判：符号链接能绕过目录边界检查 */
const S_IFLNK = 0xA000;
const HOST_UNIX = 3;

/** CRC-32（ZIP 内建校验）。查表法，解压时边解边算，用来发现损坏/篡改的条目。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** 把 BigInt 偏移安全地转成 Number（ZIP 不可能大过 2^53 字节） */
function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }

/**
 * 计算 ZIP 条目解压后的落盘路径，并拒绝一切逃逸写法。
 *
 * 只做字符串 startsWith 是不够的：`dest = C:\app\payload` 时，
 * 条目 `..\payload-evil\x.dll` 拼出来是 `C:\app\payload-evil\x.dll`，
 * 恰好以 `C:\app\payload` 开头，检查会通过 —— 文件就落到目录外面去了。
 * 这里用 path.resolve + path.relative 判真正包含关系，并额外拒绝
 * 绝对路径、盘符、UNC、以及任何 `..` 段。
 *
 * @param {string} destRoot 解压根目录
 * @param {string} entryName ZIP 内的条目名
 * @returns {string|null} 安全时返回绝对路径；目录类条目返回 null
 * @throws {Error} 条目名不安全时抛出
 */
function safeEntryPath(destRoot, entryName) {
  const raw = String(entryName == null ? '' : entryName);
  const name = raw.replace(/\\/g, '/');
  if (!name || name === '.' || name.endsWith('/')) return null;
  if (name.startsWith('/') || name.startsWith('//') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`更新包含非法绝对路径条目：${raw}`);
  }
  if (name.split('/').some((seg) => seg === '..')) {
    throw new Error(`更新包含路径穿越条目：${raw}`);
  }
  const norm = path.posix.normalize(name);
  if (norm === '.' || norm.startsWith('../') || path.posix.isAbsolute(norm)) {
    throw new Error(`更新包含路径穿越条目：${raw}`);
  }
  const root = path.resolve(destRoot);
  const target = path.resolve(root, norm);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`更新条目落在目标目录之外：${raw}`);
  }
  return target;
}

/**
 * 解析 Zip64 扩展字段（0x0001），补全中央目录里被置成 0xffffffff 的字段。
 * 字段顺序固定：未压缩大小、压缩大小、本地头偏移、起始磁盘号；只出现「被置位」的那些。
 * @param {Buffer} extra 中央目录项的扩展字段
 * @param {{uncompSize:number, compSize:number, localOffset:number}} fields
 */
function applyZip64Extra(extra, fields) {
  if (!extra || extra.length < 4) return fields;
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    const dataStart = off + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > extra.length) break;
    if (id === 0x0001) {
      let p = dataStart;
      const take64 = () => {
        if (p + 8 > dataEnd) return null;
        const v = toNum(extra.readBigUInt64LE(p));
        p += 8;
        return v;
      };
      if (fields.uncompSize === MAX32) { const v = take64(); if (v !== null) fields.uncompSize = v; }
      if (fields.compSize === MAX32) { const v = take64(); if (v !== null) fields.compSize = v; }
      if (fields.localOffset === MAX32) { const v = take64(); if (v !== null) fields.localOffset = v; }
      break;
    }
    off = dataEnd;
  }
  return fields;
}

/**
 * 从 EOCD 位置解出条目数 / 中央目录大小 / 中央目录偏移，自动跟进 Zip64。
 * @param {Buffer} buf 包含 EOCD 的缓冲区
 * @param {number} eocd EOCD 在 buf 内的下标
 * @param {number} base buf[0] 对应的文件绝对偏移（ZipFile 的尾部窗口用）
 * @returns {{total:number, cdSize:number, cdOffset:number, eocdAbs:number}}
 */
function readEndOfCentralDirectory(buf, eocd, base) {
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const eocdAbs = base + eocd;

  const needsZip64 = total === MAX16 || cdSize === MAX32 || cdOffset === MAX32;
  if (!needsZip64) return { total, cdSize, cdOffset, eocdAbs };

  // Zip64 EOCD locator 固定紧挨在 EOCD 前面 20 字节
  const loc = eocd - 20;
  if (loc < 0) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(loc) !== ZIP64_LOC_SIG) return { total, cdSize, cdOffset, eocdAbs };
  const z64Abs = toNum(buf.readBigUInt64LE(loc + 8));
  const z64 = z64Abs - base;
  if (z64 < 0 || z64 + 56 > buf.length) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) return { total, cdSize, cdOffset, eocdAbs };

  total = toNum(buf.readBigUInt64LE(z64 + 32));
  cdSize = toNum(buf.readBigUInt64LE(z64 + 40));
  cdOffset = toNum(buf.readBigUInt64LE(z64 + 48));
  return { total, cdSize, cdOffset, eocdAbs };
}

class ZipArchive {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    let eocd = -1;
    const maxScan = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= maxScan; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');

    const { total, cdOffset } = readEndOfCentralDirectory(buf, eocd, 0);
    this.expectedEntries = total;
    let offset = cdOffset;

    for (let i = 0; i < total; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const nameEnd = offset + 46 + nameLen;
      if (nameEnd > buf.length) break;
      const fields = applyZip64Extra(
        buf.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: buf.readUInt32LE(offset + 24),
          compSize: buf.readUInt32LE(offset + 20),
          localOffset: buf.readUInt32LE(offset + 42),
        },
      );
      const name = buf.toString('utf8', offset + 46, nameEnd);
      const madeBy = buf.readUInt16LE(offset + 4);
      const extAttr = buf.readUInt32LE(offset + 38);
      this.entries.set(name, {
        name, flags, method,
        crc: buf.readUInt32LE(offset + 16),
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
        unixMode: (extAttr >>> 16) & 0xffff,
        symlink: (madeBy >>> 8) === HOST_UNIX && ((extAttr >>> 16) & S_IFLNK) === S_IFLNK,
      });
      offset = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) throw new Error(`本地文件头越界: ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`本地文件头损坏: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (start + e.compSize > buf.length) throw new Error(`条目数据越界: ${name}`);
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  }

  /** 列出匹配某个前缀/正则的条目名 */
  find(re) {
    return [...this.entries.keys()].filter((n) => re.test(n));
  }

  /**
   * 流式解压单个条目到可写流。
   * @param {string} name 条目名
   * @param {import('stream').Writable} dest 目标可写流
   * @param {{verify?:boolean}} [opts] verify=true 时校验 CRC32 与解压后大小
   */
  pipeTo(name, dest, opts = {}) {
    const e = this.entries.get(name);
    if (!e) return rejectDestination(dest, new Error(`条目不存在: ${name}`));
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) return rejectDestination(dest, new Error(`本地文件头越界: ${name}`));
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      return rejectDestination(dest, new Error(`本地文件头损坏: ${name}`));
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const end = start + e.compSize;
    if (end > buf.length) return rejectDestination(dest, new Error(`条目数据越界: ${name}`));
    const raw = buf.subarray(start, end);
    return pipeEntry(Readable.from([raw]), e, dest, opts);
  }
}

/**
 * 文件版 ZIP 读取器：只把尾部中央目录读进内存，条目按需从 fd 流式读。
 * 用于 emulator / 系统镜像这类 GB 级安装包——旧版 fs.readFileSync 整包读会
 * 在低内存机器上直接 OOM，表现为「下载完了却装不上」。
 */
class ZipFile {
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.statSync(filePath).size;
    this.entries = new Map();
    try { this._parse(); } catch (e) { this.close(); throw e; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } }
    this.fd = null;
  }

  _readAt(pos, len) {
    const n = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(n);
    if (n > 0) {
      let got = 0;
      while (got < n) {
        // readSync 可能短读（尤其大块），必须循环到读满
        const r = fs.readSync(this.fd, b, got, n - got, pos + got);
        if (r <= 0) break;
        got += r;
      }
    }
    return b;
  }

  _parse() {
    if (this.size < 22) throw new Error('不是有效的 ZIP/APK 文件（文件过小）');
    const tailLen = Math.min(this.size, 22 + 65557 + 4096);
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');

    const { total, cdSize, cdOffset, eocdAbs } = readEndOfCentralDirectory(tail, eocd, tailBase);
    this.expectedEntries = total;
    if (cdOffset + cdSize > this.size) {
      throw new Error('ZIP 中央目录偏移异常');
    }

    let cd = tail;
    let cdBase = tailBase;
    if (cdOffset < tailBase || cdOffset + cdSize > eocdAbs) {
      // 中央目录不在尾部缓冲里（超大注释 / 多分卷），按声明大小精确读一段
      const len = Math.min(cdSize, 256 * 1024 * 1024);
      if (len <= 0) throw new Error('ZIP 中央目录偏移异常');
      cd = this._readAt(cdOffset, len);
      cdBase = cdOffset;
    }

    let off = cdOffset - cdBase;
    for (let i = 0; i < total; i += 1) {
      if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const nameEnd = off + 46 + nameLen;
      if (nameEnd > cd.length) break;
      const fields = applyZip64Extra(
        cd.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: cd.readUInt32LE(off + 24),
          compSize: cd.readUInt32LE(off + 20),
          localOffset: cd.readUInt32LE(off + 42),
        },
      );
      const name = cd.toString('utf8', off + 46, nameEnd);
      const madeBy = cd.readUInt16LE(off + 4);
      const extAttr = cd.readUInt32LE(off + 38);
      this.entries.set(name, {
        name, flags, method,
        crc: cd.readUInt32LE(off + 16),
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
        unixMode: (extAttr >>> 16) & 0xffff,
        symlink: (madeBy >>> 8) === HOST_UNIX && ((extAttr >>> 16) & S_IFLNK) === S_IFLNK,
      });
      off = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }
  find(re) { return this.names().filter((n) => re.test(n)); }

  _range(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`条目不存在: ${name}`);
    const head = this._readAt(e.localOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`本地文件头损坏: ${name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name) {
    const { e, start } = this._range(name);
    // read() 会把整个条目解到内存：给一个明确上限，避免未来某个调用点顺手
    // 拿来读 GB 级镜像（那正是 issue #21 里「大包必炸」的形态）。
    if (e.compSize > MAX_READ) {
      throw new Error(`条目过大（${(e.compSize / 1048576).toFixed(0)}MB），请改用 pipeTo: ${name}`);
    }
    const raw = this._readAt(start, e.compSize);
    if (raw.length < e.compSize) throw new Error(`条目数据被截断: ${name}`);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  }

  /**
   * 流式解压单个条目到可写流（文件版：不把整条目读进内存）。
   * @param {string} name 条目名
   * @param {import('stream').Writable} dest 目标可写流
   * @param {{verify?:boolean}} [opts] verify=true 时校验 CRC32 与解压后大小
   */
  pipeTo(name, dest, opts = {}) {
    let r;
    try { r = this._range(name); } catch (e) { return rejectDestination(dest, e); }
    const { e, start, end } = r;
    if (end >= this.size) {
      return rejectDestination(dest, new Error(`条目数据被截断: ${name}`));
    }
    const src = e.compSize === 0 ? Readable.from([]) : fs.createReadStream(null, {
      fd: this.fd, autoClose: false, start, end,
      // pipeline 失败会 destroy 读流；共享 fd 仍只由 ZipFile.close() 管理。
      fs: { read: fs.read, close: (_fd, cb) => cb(null) },
    });
    return pipeEntry(src, e, dest, opts);
  }
}

module.exports = {
  ZipArchive, ZipFile, safeEntryPath, crc32, S_IFLNK,
};

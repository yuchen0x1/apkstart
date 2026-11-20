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
      if (Number.isFinite(opts.maxBytes) && bytes > opts.maxBytes) return cb(new Error(`条目解压大小超过安全上限: ${entry.name}`));
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

function readLimit(entry, opts) {
  const limit = opts.maxBytes == null ? MAX_READ : Math.min(MAX_READ, opts.maxBytes);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('ZIP 读取上限无效');
  if (entry.compSize > MAX_READ || entry.uncompSize > limit) throw new Error(`条目解压大小超过安全上限，请改用 pipeTo: ${entry.name}`);
  return limit;
}

function decodeEntry(raw, entry, limit) {
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) {
    // 不能只相信中央目录：声明很小的条目也可能解出巨量内容。
    try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, limit) }); }
    catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`条目解压大小超过安全上限: ${entry.name}`);
      throw error;
    }
  } else { throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`); }
  if (data.length > limit) throw new Error(`条目解压大小超过安全上限: ${entry.name}`);
  return data;
}

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
  const required = Object.keys(fields).filter(key => fields[key] === MAX32);
  let found = false;
  let off = 0;
  while (off < extra.length) {
    if (off + 4 > extra.length) throw new Error('ZIP 中央目录扩展字段被截断');
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    const dataStart = off + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > extra.length) throw new Error('ZIP 中央目录扩展字段被截断');
    if (id === 0x0001) {
      if (found) throw new Error('ZIP 中央目录含重复 Zip64 扩展字段');
      found = true;
      let p = dataStart;
      for (const key of ['uncompSize', 'compSize', 'localOffset']) {
        if (!required.includes(key)) continue;
        if (p + 8 > dataEnd) throw new Error('ZIP 中央目录 Zip64 扩展字段被截断');
        fields[key] = toNum(extra.readBigUInt64LE(p));
        p += 8;
      }
    }
    off = dataEnd;
  }
  if (required.length && !found) throw new Error('ZIP 中央目录缺少 Zip64 扩展字段');
  if (Object.values(fields).some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error('ZIP 条目大小或偏移异常');
  return fields;
}

/** 找到真正位于文件尾部的 EOCD，避免把注释中的普通签名误认为目录结束。 */
function findEndOfCentralDirectory(tail) {
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 65557); i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tail.length) return i;
  }
  throw new Error('不是有效的 ZIP/APK 文件（未找到完整 EOCD）');
}

/** 从 EOCD 解出条目数 / 中央目录区间；Zip64 格式也必须是单磁盘且完整。 */
function readEndOfCentralDirectory(buf, eocd, base, readAt) {
  const eocdAbs = base + eocd;
  const end = {
    onDisk: buf.readUInt16LE(eocd + 8), total: buf.readUInt16LE(eocd + 10),
    cdSize: buf.readUInt32LE(eocd + 12), cdOffset: buf.readUInt32LE(eocd + 16),
  };
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new Error('不支持多磁盘 ZIP');

  let cdEnd = eocdAbs;
  const needsZip64 = end.onDisk === MAX16 || end.total === MAX16 || end.cdSize === MAX32 || end.cdOffset === MAX32;
  const loc = eocd - 20;
  const hasLocator = loc >= 0 && buf.readUInt32LE(loc) === ZIP64_LOC_SIG;
  if (needsZip64 || (hasLocator && end.cdOffset + end.cdSize !== eocdAbs)) {
    if (!hasLocator) throw new Error('ZIP64 中央目录结束记录被截断');
    const locAbs = base + loc;
    const z64Abs = toNum(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(loc + 4) !== 0 || buf.readUInt32LE(loc + 16) !== 1) throw new Error('不支持多磁盘 ZIP64');
    if (!Number.isSafeInteger(z64Abs) || z64Abs + 56 > locAbs) throw new Error('ZIP64 中央目录结束记录偏移异常');
    const z64 = readAt(z64Abs, 56);
    if (z64.length !== 56 || z64.readUInt32LE(0) !== ZIP64_EOCD_SIG
      || z64.readBigUInt64LE(4) !== BigInt(locAbs - z64Abs - 12)) throw new Error('ZIP64 中央目录结束记录损坏或被截断');
    if (z64.readUInt32LE(16) !== 0 || z64.readUInt32LE(20) !== 0) throw new Error('不支持多磁盘 ZIP64');
    for (const [key, off, sentinel] of [['onDisk', 24, MAX16], ['total', 32, MAX16], ['cdSize', 40, MAX32], ['cdOffset', 48, MAX32]]) {
      const value = toNum(z64.readBigUInt64LE(off));
      if (end[key] !== sentinel && end[key] !== value) throw new Error('ZIP64 与 EOCD 的中央目录信息不符');
      end[key] = value;
    }
    cdEnd = z64Abs;
  }

  const { onDisk, total, cdSize, cdOffset } = end;
  if (Object.values(end).some(v => !Number.isSafeInteger(v) || v < 0)
    || cdOffset > cdEnd || cdSize !== cdEnd - cdOffset) throw new Error('ZIP 中央目录偏移异常或被截断');
  if (onDisk !== total || total > Math.floor(cdSize / 46)) throw new Error('ZIP 中央目录条目数量不符');
  return { total, cdSize, cdOffset };
}

/** 内存与文件版共用同一套校验；绝不能返回只解析到一部分的目录。 */
function parseCentralDirectory(cd, { total, cdSize, cdOffset }, entries) {
  if (cd.length !== cdSize) throw new Error('ZIP 中央目录被截断');
  let off = 0;
  for (let i = 0; i < total; i++) {
    if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) {
      throw new Error('ZIP 中央目录被截断、损坏或条目数量不符');
    }
    const nameEnd = off + 46 + cd.readUInt16LE(off + 28);
    const extraEnd = nameEnd + cd.readUInt16LE(off + 30);
    const next = extraEnd + cd.readUInt16LE(off + 32);
    if (next > cd.length) throw new Error('ZIP 中央目录条目被截断');
    if (cd.readUInt16LE(off + 34) !== 0) throw new Error('不支持多磁盘 ZIP 条目');
    const fields = applyZip64Extra(cd.subarray(nameEnd, extraEnd), {
      uncompSize: cd.readUInt32LE(off + 24),
      compSize: cd.readUInt32LE(off + 20),
      localOffset: cd.readUInt32LE(off + 42),
    });
    const name = cd.toString('utf8', off + 46, nameEnd);
    if (entries.has(name)) throw new Error(`ZIP 中央目录包含重复条目：${name}`);
    if (fields.localOffset > cdOffset - 30) throw new Error(`ZIP 条目本地文件头越界：${name}`);
    const madeBy = cd.readUInt16LE(off + 4);
    const extAttr = cd.readUInt32LE(off + 38);
    entries.set(name, {
      name, flags: cd.readUInt16LE(off + 8), method: cd.readUInt16LE(off + 10),
      crc: cd.readUInt32LE(off + 16), ...fields,
      unixMode: (extAttr >>> 16) & 0xffff,
      symlink: (madeBy >>> 8) === HOST_UNIX && ((extAttr >>> 16) & S_IFLNK) === S_IFLNK,
    });
    off = next;
  }
  // 标准允许目录最后附一个数字签名记录；其它尾部数据（包括多出的目录项）一律拒绝。
  if (off !== cd.length && (off + 6 > cd.length || cd.readUInt32LE(off) !== 0x05054b50
    || off + 6 + cd.readUInt16LE(off + 4) !== cd.length)) throw new Error('ZIP 中央目录大小或条目数量不符');
}

class ZipArchive {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    const readAt = (pos, len) => buf.subarray(pos, pos + len);
    const end = readEndOfCentralDirectory(buf, findEndOfCentralDirectory(buf), 0, readAt);
    parseCentralDirectory(readAt(end.cdOffset, end.cdSize), end, this.entries);
    this.expectedEntries = end.total;
    this._cdOffset = end.cdOffset;
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name, opts = {}) {
    const e = this.entries.get(name);
    if (!e) return null;
    const limit = readLimit(e, opts);
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) throw new Error(`本地文件头越界: ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`本地文件头损坏: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (e.compSize > this._cdOffset - start) throw new Error(`条目数据越界: ${name}`);
    const raw = buf.subarray(start, start + e.compSize);
    const data = decodeEntry(raw, e, limit);
    return e.method === 0 ? Buffer.from(data) : data;
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
    if (end > this._cdOffset) return rejectDestination(dest, new Error(`条目数据越界: ${name}`));
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
    this.entries = new Map();
    try { this.size = fs.fstatSync(this.fd).size; this._parse(); }
    catch (e) { this.close(); throw e; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } }
    this.fd = null;
  }

  _readAt(pos, len) {
    if (!Number.isSafeInteger(pos) || pos < 0 || !Number.isSafeInteger(len) || len < 0) throw new Error('ZIP 读取范围异常');
    const n = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(n);
    if (n > 0) {
      let got = 0;
      while (got < n) {
        // readSync 可能短读（尤其大块），必须循环到读满
        const r = fs.readSync(this.fd, b, got, n - got, pos + got);
        if (r <= 0) throw new Error('ZIP 文件在读取期间被截断');
        got += r;
      }
    }
    return b;
  }

  _parse() {
    if (this.size < 22) throw new Error('不是有效的 ZIP/APK 文件（文件过小）');
    const tailLen = Math.min(this.size, 65557 + 20); // 最长注释也要留出 Zip64 locator
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    const end = readEndOfCentralDirectory(tail, findEndOfCentralDirectory(tail), tailBase,
      (pos, len) => this._readAt(pos, len));
    // 不能像旧实现那样只读前 256MB 然后把剩下条目静默丢掉。
    if (end.cdSize > 256 * 1024 * 1024) throw new Error('ZIP 中央目录大小超过安全上限');
    const cd = end.cdOffset >= tailBase
      ? tail.subarray(end.cdOffset - tailBase, end.cdOffset - tailBase + end.cdSize)
      : this._readAt(end.cdOffset, end.cdSize);
    parseCentralDirectory(cd, end, this.entries);
    this.expectedEntries = end.total;
    this._cdOffset = end.cdOffset;
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
    if (e.compSize > this._cdOffset - start) throw new Error(`条目数据越界: ${name}`);
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name, opts = {}) {
    const { e, start } = this._range(name);
    const limit = readLimit(e, opts);
    const raw = this._readAt(start, e.compSize);
    if (raw.length < e.compSize) throw new Error(`条目数据被截断: ${name}`);
    return decodeEntry(raw, e, limit);
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

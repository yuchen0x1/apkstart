'use strict';
/**
 * 测试用的最小 ZIP 写入器（stored，不压缩）。
 * 用来构造各种「恶意/异常」更新包：路径穿越、绝对路径、符号链接、CRC 损坏……
 * 只服务于测试，不参与打包。
 */
const fs = require('fs');
const { crc32 } = require('../../src/core/zip');

/**
 * @param {Array<{name:string, data?:Buffer|string, unixMode?:number, symlink?:boolean, crc?:number}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8');
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc != null ? e.crc : crc32(data);
    const mode = e.unixMode != null ? e.unixMode : (e.symlink ? 0o120777 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);   // time
    local.writeUInt16LE(0, 12);   // date
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4);   // made by Unix
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE((mode << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + data.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cd, eocd]);
}

function writeZip(file, entries) {
  fs.writeFileSync(file, buildZip(entries));
  return file;
}

module.exports = { buildZip, writeZip };

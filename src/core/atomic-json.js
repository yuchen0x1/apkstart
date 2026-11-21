'use strict';
/**
 * 原子写 JSON（同步）：同目录随机临时文件 → wx 独占创建 → write → fsync → close → rename。
 * 半截写入、进程被杀、磁盘写失败都不会截断已有的有效文件；
 * 失败时抛错，调用方必须自己决定怎么对外说明，不能静默吞掉。
 */
const fsDefault = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function writeJsonAtomicSync(file, data, options = {}) {
  const io = options.fs || fsDefault;
  const uuid = options.uuid || randomUUID;
  const text = JSON.stringify(data);
  const dir = path.dirname(file);
  io.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${uuid()}.tmp`);
  // 独占创建失败时不进入清理：同名文件不属于本次写入。
  let fd = io.openSync(tmp, 'wx', 0o600);
  let renamed = false;
  try {
    io.writeFileSync(fd, text, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, file);
    renamed = true;
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch (_) { /* 保留原始写入错误 */ }
    }
    if (!renamed) {
      try { io.unlinkSync(tmp); } catch (_) { /* 保留原始写入错误 */ }
    }
  }
}

module.exports = { writeJsonAtomicSync };

'use strict';
/**
 * 官方 ISO 源在线探针（真实网络，非单测）。
 * 用法：node test/iso-source-probe.js [bliss-os|android-x86]
 *
 * 只下载 ISO 的几个字节（不占用磁盘、不下载整镜像），验证：
 *   1. 项目自己的下载器（download.head / openStream，含代理/重定向）能连通官方源；
 *   2. HTTP 206 + Content-Range 总长与 system-catalog 里记录的文件大小一致；
 *   3. 偏移 0x8001 读到 ISO9660 主卷描述符魔数 "CD001"（证明是合法 ISO 而非错误页）。
 *
 * 这是"地址有效 + 格式正确 + 目录元数据没造假"的真实证据。
 * 它不等同于完整下载、SHA-256 全文件校验或真机启动 —— 那三件事需要用户主动选择系统后
 * 由应用按需完成（见 docs/DOWNLOAD-MANAGER.md）。
 */
const { head, openStream } = require('../src/core/download');
const catalog = require('../src/system-catalog/catalog.json');

const TARGETS = {
  'bliss-os': {
    name: 'Bliss OS 16.9.7',
    url: 'https://downloads.sourceforge.net/project/blissos-x86/Official/BlissOS16/Gapps/Generic/Bliss-v16.9.7-x86_64-OFFICIAL-gapps-20241011.iso',
  },
  'android-x86': {
    name: 'Android-x86 9.0-r2',
    url: 'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  },
};

async function probe(systemId) {
  const t = TARGETS[systemId];
  if (!t) throw new Error('未知系统：' + systemId);
  const entry = catalog.systems.find((s) => s.id === systemId);
  const v = entry && entry.versions[0];
  if (!v) throw new Error('目录中无此系统：' + systemId);

  const h = await head(t.url);
  if (h.status !== 200 || !h.size) throw new Error('官方源不可达：' + JSON.stringify(h));
  if (h.size !== v.fileSize) {
    throw new Error(`文件大小不一致：目录记录 ${v.fileSize}，官方源实际 ${h.size}`);
  }

  // ISO9660 主卷描述符：0x8000=类型码(0x01)，0x8001..0x8005="CD001"
  const res = await openStream(t.url, { headers: { Range: 'bytes=32769-32773' } });
  if (res.statusCode !== 206) {
    res.resume();
    throw new Error('服务器不支持 Range 请求（HTTP ' + res.statusCode + '）');
  }
  const chunks = [];
  for await (const b of res) chunks.push(b);
  const magic = Buffer.concat(chunks).toString('latin1');
  if (magic !== 'CD001') throw new Error('ISO9660 魔数不符：' + JSON.stringify(magic));

  return {
    ok: true,
    system: t.name,
    httpStatus: h.status,
    rangeStatus: res.statusCode,
    fileSize: h.size,
    magic,
    sha256InCatalog: v.sha256,
    note: '目录元数据（大小）与官方源一致；ISO 格式合法。完整下载/全文件 SHA-256/真机启动需用户主动选择系统后由应用完成。',
  };
}

if (require.main === module) {
  const id = process.argv[2] || 'bliss-os';
  probe(id)
    .then((r) => {
      console.log('系统：' + r.system);
      console.log('HTTP：' + r.httpStatus + '（HEAD）/ ' + r.rangeStatus + '（Range）');
      console.log('文件大小：' + r.fileSize + ' 字节（与目录记录一致）');
      console.log('ISO9660 魔数 @0x8001：' + r.magic);
      console.log('目录 SHA-256：' + r.sha256InCatalog);
      console.log('\n✓ 官方源在线探针 PASS：' + r.note);
    })
    .catch((e) => { console.error('✗ 探针失败：' + e.message); process.exit(1); });
}

module.exports = { probe, TARGETS };

'use strict';
/** 拆分包离线解析；不加载 store、运行时或 Electron。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ZipFile } = require('./zip');
const { parseApk } = require('./apk');

const MAX_APKS = 1024;
const MAX_BYTES = 8 * 1024 * 1024 * 1024;

/** 旧缓存把整个容器命名为 .apk，不能只看后缀判断备份类型。 */
function isBundle(filePath) {
  const zip = new ZipFile(filePath);
  try {
    // 普通 APK 也是 ZIP，且可能把别的 APK 放在 assets/；根清单是可靠的
    // 单 APK 标志，不能只因 ZIP 里出现 .apk 就升级成 split 容器。
    return !zip.has('AndroidManifest.xml') && zip.names().some(n => /\.apk$/i.test(n));
  } finally { zip.close(); }
}

/** 每次解析独立暂存目录，成功和失败均由调用方/本函数收尾。 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  let dir = '';
  const cleanup = () => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    // 即使调用方带有旧的 bundle 标记，也不能把普通 APK（一个 ZIP，
    // 甚至可能含 assets/*.apk）拆成 split；容器不得拥有根 AndroidManifest.xml。
    if (zip.has('AndroidManifest.xml')) throw new Error('普通 APK 不能作为拆分包容器');
    const names = zip.names().filter(n => /\.apk$/i.test(n));
    if (!names.length) throw new Error('这个安装包里没有找到 APK 分片（可能不是 .apks/.xapk）');
    if (names.length > MAX_APKS) throw new Error('拆分包的 APK 分片数量超过安全上限');
    let total = 0;
    for (const name of names) {
      const entry = zip.entries.get(name);
      total += entry.uncompSize;
      if (!Number.isSafeInteger(entry.uncompSize) || entry.uncompSize < 0 || total > MAX_BYTES) {
        throw new Error('拆分包的解压大小超过安全上限');
      }
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-bundle-'));
    const files = [];
    const metadata = [];
    for (let i = 0; i < names.length; i++) {
      const file = path.join(dir, `split-${i}.apk`);
      // 包名、版本和 base 身份必须从真实清单读取，不能认文件名或 ZIP 排序。
      await zip.pipeTo(names[i], fs.createWriteStream(file), { verify: true, maxBytes: zip.entries.get(names[i]).uncompSize });
      files.push(file);
      metadata.push(parseApk(file));
    }
    const bases = metadata.filter(meta => !meta.isSplit);
    if (bases.length !== 1) throw new Error('拆分包必须包含且仅包含一个 base APK');
    const meta = bases[0];
    const splits = new Set();
    for (const item of metadata) {
      if (item.package !== meta.package || item.versionCode !== meta.versionCode) {
        throw new Error('拆分包的分片包名或版本与 base APK 不一致');
      }
      if (item.isSplit) {
        if (splits.has(item.splitName)) throw new Error('拆分包包含重复的分片');
        splits.add(item.splitName);
      }
    }
    return { meta, files, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  } finally { zip.close(); }
}

module.exports = { isBundle, parseBundle };

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = 'https://github.com/yuchen0x1/apkstart';
const marker = /<!-- apkstart-manifest ([A-Za-z0-9+/=]+) ([A-Za-z0-9+/=]+) -->/;
function assetNames(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw Error('发行版本号无效');
  const v = tag.slice(1);
  return { setup: 'ApkStart-' + v + '-Setup.exe', portable: 'ApkStart-' + tag + '-win64-portable.zip',
    deb: 'ApkStart-' + v + '-amd64.deb', appimage: 'ApkStart-' + v + '-x86_64.AppImage' };
}
function readManifest(notes, tag, publicKey) {
  const match = marker.exec(notes);
  if (!match) return null;
  const data = Buffer.from(match[1], 'base64');
  const key = publicKey || fs.readFileSync(path.join(__dirname, 'release-public.pem'));
  if (!crypto.verify(null, data, key, Buffer.from(match[2], 'base64'))) throw Error('更新清单签名校验失败');
  const m = JSON.parse(data);
  if (m.schema !== 1 || m.tag !== tag || m.repository !== repo || !Array.isArray(m.assets)) throw Error('更新清单与发行版本不匹配');
  return m;
}
function matchAsset(manifest, tag, asset) {
  if (!manifest || !asset) return false;
  const entry = manifest.assets.find(a => a.name === asset.name);
  return !!entry && entry.size === asset.size && Number.isSafeInteger(entry.size) && entry.size > 0
    && /^[a-f0-9]{64}$/.test(entry.sha256) && asset.digest === 'sha256:' + entry.sha256
    && asset.url === repo + '/releases/download/' + tag + '/' + asset.name;
}
module.exports = { assetNames, readManifest, matchAsset, marker, repo };

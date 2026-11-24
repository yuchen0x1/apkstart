'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  assetNames, releaseAssetDescriptors, releaseFileNames, createLatestManifest,
  verifyLatestManifest, matchLatestAsset, readManifest, repo,
} = require('../src/core/release-manifest');
const { sha256File } = require('../src/core/download');

function isExpectedAssetUrl(value, tag, name, allowDraft) {
  const expected = `${repo}/releases/download/${tag}/${name}`;
  if (value === expected) return true;
  if (!allowDraft || typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const draftPath = new RegExp(`^/yuchen0x1/apkstart/releases/download/untagged-[A-Za-z0-9-]+/${escapedName}$`);
  return url.origin === 'https://github.com' && !url.username && !url.password
    && !url.search && !url.hash && draftPath.test(url.pathname);
}

async function run(command, dir, arg, uploadedLatestPath) {
  if (command === '--check-upload' || command === '--check-draft') {
    const checkDraft = command === '--check-draft';
    const tag = process.env.TAG;
    if (!tag) throw Error('TAG 未设置，不能验证上传清单');
    const uploaded = JSON.parse(fs.readFileSync(arg, 'utf8')).assets;
    const names = fs.readdirSync(dir).sort();
    if (JSON.stringify(names) !== JSON.stringify(releaseFileNames(tag))) throw Error('Unexpected release files');
    if (!Array.isArray(uploaded) || uploaded.length !== names.length) throw Error('Unexpected number of uploaded assets');
    for (const name of names) {
      const file = path.join(dir, name);
      const asset = uploaded.find((entry) => entry.name === name);
      if (!asset || asset.size !== fs.statSync(file).size
        || asset.digest !== 'sha256:' + await sha256File(file)) {
        throw Error('上传校验失败 ' + name);
      }
      if (!isExpectedAssetUrl(asset.url, tag, name, checkDraft)) {
        if (checkDraft) throw Error('草稿资产 URL 无效 ' + name);
        throw Error('上传校验失败 ' + name);
      }
    }

    const latestBytes = fs.readFileSync(uploadedLatestPath || path.join(dir, 'latest.json'));
    const latest = verifyLatestManifest(latestBytes);
    const latestAsset = uploaded.find((entry) => entry.name === 'latest.json');
    if (!latestAsset || latestAsset.digest !== 'sha256:' + await sha256FileBuffer(latestBytes)) {
      throw Error('已上传 latest.json 与签名校验文件不一致');
    }
    if (latest.tag !== tag) throw Error('latest.json tag 与发布 tag 不一致');
    const assets = uploaded.filter((entry) => ![
      'ApkStart-update.json', 'ApkStart-update.json.sig', 'SHA256SUMS', 'latest.json',
    ].includes(entry.name));
    if (assets.length !== latest.assets.length || latest.assets.some((entry) => {
      const uploadedAsset = assets.find((asset) => asset.name === entry.name);
      return !uploadedAsset || uploadedAsset.size !== entry.fileSize
        || uploadedAsset.digest !== 'sha256:' + entry.sha256
        || entry.downloadUrl !== `${repo}/releases/download/${tag}/${entry.name}`
        || (!checkDraft && !matchLatestAsset(latest, uploadedAsset));
    })) {
      throw Error('latest.json 与已上传 Release 资产不一致');
    }

    const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'ApkStart-update.json'), 'utf8'));
    if (legacy.tag !== tag || legacy.repository !== repo || legacy.assets.length !== latest.assets.length) {
      throw Error('旧客户端更新清单与 latest.json 不一致');
    }
    for (const current of latest.assets) {
      const previous = legacy.assets.find((asset) => asset.name === current.name);
      if (!previous || previous.size !== current.fileSize || previous.sha256 !== current.sha256) {
        throw Error('旧客户端更新清单资产与 latest.json 不一致 ' + current.name);
      }
    }
    return;
  }
  const tag = command;
  const names = Object.values(assetNames(tag)).sort();
  if (JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify(names)) throw Error('Unexpected release files');
  const assets = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    if (!size) throw Error('Empty asset ' + name);
    assets.push({ name, size, sha256: await sha256File(file) });
  }
  const bytes = Buffer.from(JSON.stringify({ schema: 1, repository: repo, tag, assets }));
  const privateKey = crypto.createPrivateKey(process.env.APKSTART_RELEASE_KEY || '');
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('APKSTART_RELEASE_KEY 必须是 Ed25519 私钥');
  const sig = crypto.sign(null, bytes, privateKey);
  const comment = '<!-- apkstart-manifest ' + bytes.toString('base64') + ' ' + sig.toString('base64') + ' -->';
  readManifest(comment, tag);
  fs.appendFileSync(arg, '\n' + comment + '\n');
  fs.writeFileSync(path.join(dir, 'ApkStart-update.json'), bytes);
  fs.writeFileSync(path.join(dir, 'ApkStart-update.json.sig'), sig);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), assets.map(a => a.sha256 + '  ' + a.name).join('\n') + '\n');

  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const latestAssets = releaseAssetDescriptors(tag).map((descriptor) => {
    const asset = byName.get(descriptor.name);
    if (!asset) throw Error('Release 缺少资产 ' + descriptor.name);
    return {
      ...descriptor,
      fileSize: asset.size,
      sha256: asset.sha256,
      downloadUrl: `${repo}/releases/download/${tag}/${asset.name}`,
    };
  });
  const notes = fs.readFileSync(arg, 'utf8').replace(/\n<!-- apkstart-manifest [\s\S]*?-->\s*$/, '').trim();
  const latest = createLatestManifest({
    tag,
    releaseNotes: notes,
    publishedAt: new Date().toISOString(),
    assets: latestAssets,
  }, privateKey);
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  verifyLatestManifest(fs.readFileSync(path.join(dir, 'latest.json')));
}

async function sha256FileBuffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = { isExpectedAssetUrl };

if (require.main === module) {
  run(...process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
}

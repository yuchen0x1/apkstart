'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repo = 'https://github.com/yuchen0x1/apkstart';
const marker = /<!-- apkstart-manifest ([A-Za-z0-9+/=]+) ([A-Za-z0-9+/=]+) -->/;
const latestManifestName = 'latest.json';
const latestManifestKeys = [
  'schemaVersion', 'repository', 'version', 'tag', 'releaseNotes', 'publishedAt',
  'assets', 'manifestSignature',
];
const latestBodyKeys = latestManifestKeys.filter((key) => key !== 'manifestSignature');
const metadataNames = ['ApkStart-update.json', 'ApkStart-update.json.sig', 'SHA256SUMS', latestManifestName];

function assetNames(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw Error('发行版本号无效');
  const v = tag.slice(1);
  return { setup: 'ApkStart-' + v + '-Setup.exe', portable: 'ApkStart-' + tag + '-win64-portable.zip',
    deb: 'ApkStart-' + v + '-amd64.deb', appimage: 'ApkStart-' + v + '-x86_64.AppImage' };
}

function releaseAssetDescriptors(tag) {
  const names = assetNames(tag);
  return [
    { name: names.setup, platform: 'win32', architecture: 'x64', flavor: 'setup' },
    { name: names.portable, platform: 'win32', architecture: 'x64', flavor: 'portable' },
    { name: names.appimage, platform: 'linux', architecture: 'x64', flavor: 'appimage' },
    { name: names.deb, platform: 'linux', architecture: 'x64', flavor: 'deb' },
  ];
}

function releaseFileNames(tag) {
  return [...Object.values(assetNames(tag)), ...metadataNames].sort();
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Error('清单含无效数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (!value || typeof value !== 'object'
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw Error('清单含不支持的数据类型');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    throw Error('清单不能包含非 JSON 属性');
  }
  return '{' + keys.sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(descriptors[key].value)).join(',') + '}';
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw Error(`${label}格式无效`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string'
    || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    throw Error(`${label}不能包含非 JSON 属性`);
  }
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(descriptors, key))) {
    throw Error(`${label}字段不符合 schema`);
  }
}

function parseLatestDocument(doc) {
  if (Buffer.isBuffer(doc) || doc instanceof Uint8Array) {
    try { doc = JSON.parse(Buffer.from(doc).toString('utf8')); } catch (_) { throw Error('latest.json JSON 无效'); }
  } else if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); } catch (_) { throw Error('latest.json JSON 无效'); }
  }
  exactKeys(doc, latestManifestKeys, 'latest.json');
  return doc;
}

function validateLatestBody(body) {
  exactKeys(body, latestBodyKeys, 'latest.json');
  if (body.schemaVersion !== 1) throw Error('latest.json schemaVersion 不支持');
  if (body.repository !== repo) throw Error('latest.json 仓库地址无效');
  if (typeof body.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(body.version)
    || body.tag !== 'v' + body.version) throw Error('latest.json 版本与 tag 不匹配');
  const expected = releaseAssetDescriptors(body.tag);
  if (typeof body.releaseNotes !== 'string' || !body.releaseNotes.trim() || body.releaseNotes.length > 2 * 1024 * 1024) {
    throw Error('latest.json releaseNotes 无效');
  }
  if (typeof body.publishedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.publishedAt)
    || new Date(body.publishedAt).toISOString() !== body.publishedAt) throw Error('latest.json publishedAt 无效');
  if (!Array.isArray(body.assets) || body.assets.length !== expected.length) throw Error('latest.json assets 数量无效');
  const assetKeys = ['name', 'fileSize', 'sha256', 'platform', 'architecture', 'flavor', 'downloadUrl'];
  const seen = new Set();
  for (let i = 0; i < expected.length; i += 1) {
    const actual = body.assets[i];
    const required = expected[i];
    exactKeys(actual, assetKeys, 'latest.json asset');
    if (seen.has(actual.name)) throw Error('latest.json asset 重复');
    seen.add(actual.name);
    if (actual.name !== required.name || actual.platform !== required.platform
      || actual.architecture !== required.architecture || actual.flavor !== required.flavor) {
      throw Error('latest.json asset 名称或平台类型无效');
    }
    if (!Number.isSafeInteger(actual.fileSize) || actual.fileSize <= 0) throw Error('latest.json asset 大小无效');
    if (typeof actual.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(actual.sha256)) {
      throw Error('latest.json asset SHA-256 无效');
    }
    const expectedUrl = `${repo}/releases/download/${body.tag}/${actual.name}`;
    if (actual.downloadUrl !== expectedUrl) throw Error('latest.json asset 下载地址无效');
  }
  return body;
}

function publicKeyOrPinned(publicKey) {
  const input = publicKey || fs.readFileSync(path.join(__dirname, 'release-public.pem'));
  const key = input && input.type === 'public' ? input : crypto.createPublicKey(input);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('更新清单公钥必须为 Ed25519');
  return key;
}

function createLatestManifest(input, privateKey) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('latest.json 输入无效');
  const tag = input.tag;
  const body = {
    schemaVersion: 1,
    repository: repo,
    version: input.version || (typeof tag === 'string' ? tag.slice(1) : ''),
    tag,
    releaseNotes: input.releaseNotes,
    publishedAt: input.publishedAt || new Date().toISOString(),
    assets: input.assets,
  };
  validateLatestBody(body);
  const key = privateKey && privateKey.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('更新清单私钥必须为 Ed25519');
  const signature = crypto.sign(null, Buffer.from(canonicalJson(body), 'utf8'), key).toString('base64');
  return { ...body, manifestSignature: { algorithm: 'Ed25519', value: signature } };
}

function verifyLatestManifest(doc, publicKey) {
  const parsed = parseLatestDocument(doc);
  const { manifestSignature, ...body } = parsed;
  validateLatestBody(body);
  exactKeys(manifestSignature, ['algorithm', 'value'], 'latest.json manifestSignature');
  if (manifestSignature.algorithm !== 'Ed25519' || typeof manifestSignature.value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(manifestSignature.value)) {
    throw Error('latest.json 签名格式无效');
  }
  const signature = Buffer.from(manifestSignature.value, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== manifestSignature.value) {
    throw Error('latest.json 签名长度无效');
  }
  const bytes = Buffer.from(canonicalJson(body), 'utf8');
  if (!crypto.verify(null, bytes, publicKeyOrPinned(publicKey), signature)) throw Error('latest.json 签名校验失败');
  return parsed;
}

function matchLatestAsset(manifest, releaseAsset) {
  if (!manifest || !Array.isArray(manifest.assets) || !releaseAsset) return false;
  const entry = manifest.assets.find((asset) => asset.name === releaseAsset.name);
  return !!entry && entry.fileSize === releaseAsset.size && Number.isSafeInteger(entry.fileSize) && entry.fileSize > 0
    && entry.sha256 === (releaseAsset.digest || '').replace(/^sha256:/, '')
    && /^[a-f0-9]{64}$/.test(entry.sha256)
    && entry.downloadUrl === `${repo}/releases/download/${manifest.tag}/${entry.name}`
    && releaseAsset.url === entry.downloadUrl;
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
module.exports = {
  assetNames, releaseAssetDescriptors, releaseFileNames, createLatestManifest,
  verifyLatestManifest, matchLatestAsset, canonicalJson, readManifest, matchAsset,
  marker, repo, latestManifestName,
};

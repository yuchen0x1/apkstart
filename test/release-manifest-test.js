'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  createLatestManifest, verifyLatestManifest, matchLatestAsset, canonicalJson,
  releaseAssetDescriptors, releaseFileNames, repo,
} = require('../src/core/release-manifest');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

function validInput(tag = 'v9.8.7') {
  const assets = releaseAssetDescriptors(tag).map((asset, index) => ({
    ...asset,
    fileSize: 1000 + index,
    sha256: crypto.createHash('sha256').update(`${tag}:${asset.name}`).digest('hex'),
    downloadUrl: `${repo}/releases/download/${tag}/${asset.name}`,
  }));
  return {
    tag,
    releaseNotes: '## 修复\n\n更新说明。',
    publishedAt: '2026-11-24T12:00:00.000Z',
    assets,
  };
}

function sign(input) {
  return createLatestManifest(input, privateKey);
}

test('canonical JSON sorts object keys recursively but preserves array order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ z: 1, a: 2 }] }),
    '{"a":{"b":3,"y":2},"list":[{"a":2,"z":1}],"z":1}');
});

test('latest manifest signs canonical body and verifies pinned Ed25519 signature', () => {
  const manifest = sign(validInput());
  const verified = verifyLatestManifest(JSON.stringify(manifest), publicKey);
  assert.equal(verified.schemaVersion, 1);
  assert.equal(verified.repository, repo);
  assert.equal(verified.version, '9.8.7');
  assert.equal(verified.tag, 'v9.8.7');
  assert.equal(verified.manifestSignature.algorithm, 'Ed25519');
  assert.equal(Buffer.from(verified.manifestSignature.value, 'base64').length, 64);

  const reordered = JSON.parse(JSON.stringify(manifest));
  reordered.assets.reverse();
  assert.throws(() => verifyLatestManifest(reordered, publicKey), /asset 名称或平台类型无效/);
});

test('latest manifest rejects signature tampering and unknown schema fields', () => {
  const manifest = sign(validInput());
  const changed = structuredClone(manifest);
  changed.releaseNotes += 'tampered';
  assert.throws(() => verifyLatestManifest(changed, publicKey), /签名校验失败/);

  const extra = structuredClone(manifest);
  extra.untrusted = true;
  assert.throws(() => verifyLatestManifest(extra, publicKey), /字段不符合 schema/);
});

test('latest manifest strictly binds version, asset name, platform, size, hash and official URL', () => {
  const base = validInput();
  const cases = [
    (input) => { input.tag = 'v9.8.6'; },
    (input) => { input.assets[0].fileSize = 0; },
    (input) => { input.assets[0].sha256 = 'A'.repeat(64); },
    (input) => { input.assets[0].downloadUrl = 'https://mirror.example/asset'; },
    (input) => { input.assets[0].name = 'ApkStart-9.8.7-Other.exe'; },
    (input) => { input.assets[0].platform = 'linux'; },
  ];
  for (const mutate of cases) {
    const input = structuredClone(base);
    mutate(input);
    assert.throws(() => sign(input));
  }
});

test('latest manifest rejects malformed timestamps, asset sets and non-Ed25519 keys', () => {
  const invalidDate = validInput();
  invalidDate.publishedAt = 'yesterday';
  assert.throws(() => sign(invalidDate), /publishedAt/);

  const missingAsset = validInput();
  missingAsset.assets.pop();
  assert.throws(() => sign(missingAsset), /assets 数量/);

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => createLatestManifest(validInput(), rsa.privateKey), /Ed25519/);
  assert.throws(() => verifyLatestManifest(sign(validInput()), rsa.publicKey), /Ed25519/);
});

test('release assets match only when GitHub metadata exactly matches the signed manifest', () => {
  const manifest = verifyLatestManifest(sign(validInput()), publicKey);
  const asset = manifest.assets[0];
  const metadata = {
    name: asset.name,
    size: asset.fileSize,
    digest: `sha256:${asset.sha256}`,
    url: asset.downloadUrl,
  };
  assert.equal(matchLatestAsset(manifest, metadata), true);
  assert.equal(matchLatestAsset(manifest, { ...metadata, size: metadata.size + 1 }), false);
  assert.equal(matchLatestAsset(manifest, { ...metadata, url: 'https://example.invalid/file' }), false);
});

test('release file contract includes legacy manifests and the canonical static asset', () => {
  assert.deepEqual(releaseFileNames('v9.8.7'), [
    'ApkStart-9.8.7-Setup.exe',
    'ApkStart-9.8.7-amd64.deb',
    'ApkStart-9.8.7-x86_64.AppImage',
    'ApkStart-update.json',
    'ApkStart-update.json.sig',
    'ApkStart-v9.8.7-win64-portable.zip',
    'SHA256SUMS',
    'latest.json',
  ]);
});

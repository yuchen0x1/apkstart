'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isExpectedAssetUrl, run: runReleaseTool } = require('../tools/sign-release');
const { publishRelease, isRetryable } = require('../tools/publish-release');
const { repo, releaseFileNames, releaseAssetDescriptors, createLatestManifest } = require('../src/core/release-manifest');

test('release asset URLs accept final tag paths and only GitHub draft asset paths', () => {
  const tag = 'v0.11.2';
  const name = 'ApkStart-0.11.2-Setup.exe';
  assert.equal(isExpectedAssetUrl(`${repo}/releases/download/${tag}/${name}`, tag, name, false), true);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-4ab61e113949ca4f4f29/${name}`,
    tag, name, true,
  ), true);
  assert.equal(isExpectedAssetUrl(
    `https://github.com.evil.invalid/yuchen0x1/apkstart/releases/download/untagged-4ab61e113949ca4f4f29/${name}`,
    tag, name, true,
  ), false);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-abc/${name}?token=secret`,
    tag, name, true,
  ), false);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-abc/Other.exe`,
    tag, name, true,
  ), false);
  assert.equal(isExpectedAssetUrl(
    `https://github.com/yuchen0x1/apkstart/releases/download/untagged-abc/${name}`,
    tag, name, false,
  ), false);
});

function httpError(status, message = 'fixture error') {
  return Object.assign(new Error(message), { stderr: `HTTP ${status}: ${message}` });
}

function publication(t, initial = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-publish-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'artifacts');
  const notesPath = path.join(root, 'RELEASE_NOTES.md');
  const tag = 'v9.8.7';
  const expectedTarget = 'a'.repeat(40);
  const notes = 'Release notes\n<!-- apkstart-manifest fixture signed proof -->\n';
  const latest = 'fixture signed static manifest';
  const names = releaseFileNames(tag);
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(notesPath, notes);
  for (const name of names) fs.writeFileSync(path.join(artifactDir, name), name === 'latest.json' ? latest : name);
  const assets = names.map((name) => ({ name, size: fs.statSync(path.join(artifactDir, name)).size, digest: 'sha256:fixture', url: `${repo}/releases/download/${tag}/${name}` }));
  const release = (overrides = {}) => ({ tagName: tag, targetCommitish: expectedTarget, isDraft: true, isPrerelease: false, body: notes, assets: [], ...overrides });
  const state = {
    release: initial ? release(initial) : null,
    calls: [], events: [], sleeps: [], failures: {}, verifyError: null,
  };
  async function run(args) {
    assert.deepEqual(args.slice(-2), ['--repo', 'yuchen0x1/apkstart']);
    assert.equal(args[0], 'release');
    assert.equal(args[2], tag);
    const kind = args[1] === 'edit' ? (args.includes('--draft=false') ? 'publish' : 'notes') : args[1];
    state.calls.push({ kind, args });
    const failure = state.failures[kind]?.shift();
    if (failure && !failure.after) throw failure.error;
    let output = '';
    if (kind === 'view') {
      if (!state.release) throw httpError(404, 'Not Found');
      output = JSON.stringify(state.release);
    } else if (kind === 'create') {
      assert.equal(state.release, null);
      assert.equal(args[args.indexOf('--target') + 1], expectedTarget);
      assert(args.includes('--draft') && args.includes('--verify-tag'));
      assert(!args.some((arg) => arg.startsWith(artifactDir)), 'creation does not mix in asset uploads');
      state.events.push('create');
      state.release = release();
    } else if (kind === 'notes') {
      assert.equal(state.release.isDraft, true);
      state.events.push('notes');
      state.release.body = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
    } else if (kind === 'upload') {
      assert.equal(state.release.isDraft, true);
      assert(args.includes('--clobber'));
      assert.deepEqual(args.filter((arg) => arg.startsWith(artifactDir)), names.map((name) => path.join(artifactDir, name)));
      state.events.push('upload');
      state.release.assets = assets;
    } else if (kind === 'download') {
      assert(args.includes('--clobber'));
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'latest.json'), latest);
    } else if (kind === 'publish') {
      assert.equal(state.release.isDraft, true);
      assert(args.includes('--latest'));
      state.events.push('publish');
      state.release.isDraft = false;
    } else assert.fail(`unexpected operation ${kind}`);
    if (failure?.after) throw failure.error;
    return output;
  }
  async function verify(mode, dir, uploaded, downloaded) {
    assert.equal(dir, artifactDir);
    assert.equal(fs.readFileSync(downloaded, 'utf8'), latest);
    assert.deepEqual(JSON.parse(fs.readFileSync(uploaded, 'utf8')).assets, assets);
    state.events.push(mode);
    if (state.verifyError) throw state.verifyError;
  }
  return {
    state, assets,
    publish: (overrides = {}) => publishRelease({ tag, artifactDir, notesPath, expectedTarget, version: '9.8.7', run, verify, sleep: async (ms) => state.sleeps.push(ms), ...overrides }),
  };
}

test('publication retries only rate limits, server failures and transport failures', () => {
  for (const code of [429, 500, 502, 503, 504]) assert.equal(isRetryable(httpError(code)), true);
  for (const code of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryable(httpError(code)), false);
  assert.equal(isRetryable(Object.assign(new Error('socket failed'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryable(new Error('Post https://api.github.com: unexpected EOF')), true);
  assert.equal(isRetryable(new Error('Post https://api.github.com: EOF')), true);
  assert.equal(isRetryable(new Error('certificate has expired')), false);
});

test('package version and exact target are validated before reading or modifying GitHub', async (t) => {
  const f = publication(t);
  await assert.rejects(f.publish({ version: '9.8.6' }), /package version/);
  await assert.rejects(f.publish({ expectedTarget: 'main' }), /exact commit SHA/);
  assert.equal(f.state.calls.length, 0);
});

test('transient create failure retries after reading back an absent tag', async (t) => {
  const f = publication(t);
  f.state.failures.create = [{ error: httpError(504) }];
  const result = await f.publish();
  assert.equal(result.alreadyPublished, false);
  assert.equal(f.state.calls.filter((call) => call.kind === 'create').length, 2);
  assert.deepEqual(f.state.sleeps, [1000]);
  assert.deepEqual(f.state.events, ['create', 'notes', 'upload', '--check-draft', 'publish', '--check-upload']);
});

test('create timeout after server success resumes its matching draft without another creation', async (t) => {
  const f = publication(t);
  f.state.failures.create = [{ error: httpError(502), after: true }];
  await f.publish();
  assert.equal(f.state.calls.filter((call) => call.kind === 'create').length, 1);
  assert.equal(f.state.calls.filter((call) => call.kind === 'upload').length, 1);
  assert.deepEqual(f.state.sleeps, []);
});

test('initial lookup server errors cannot be mistaken for a missing release', async (t) => {
  const f = publication(t, {});
  f.state.failures.view = [{ error: httpError(503) }];
  await f.publish();
  assert.equal(f.state.calls.filter((call) => call.kind === 'create').length, 0);
  assert.deepEqual(f.state.sleeps, [1000]);
});

test('a matching draft can resume an interrupted upload with bounded retries', async (t) => {
  const f = publication(t, { body: 'older draft notes' });
  f.state.failures.upload = [{ error: Object.assign(new Error('fixture connection reset'), { code: 'ECONNRESET' }), after: true }];
  await f.publish();
  assert.equal(f.state.calls.filter((call) => call.kind === 'create').length, 0);
  assert.equal(f.state.calls.filter((call) => call.kind === 'upload').length, 2);
  assert.deepEqual(f.state.sleeps, [1000]);
  assert.equal(f.state.release.isDraft, false);
});

test('draft scope mismatches fail before any remote mutation', async (t) => {
  for (const change of [{ targetCommitish: 'main' }, { tagName: 'v9.8.6' }, { isPrerelease: true }]) {
    const f = publication(t, change);
    await assert.rejects(f.publish(), /tag, target or state differs/);
    assert(f.state.calls.every((call) => call.kind === 'view'));
  }
});

test('an already published matching release is verified without uploads, edits or deletion', async (t) => {
  const f = publication(t, { isDraft: false });
  f.state.release.assets = f.assets;
  assert.equal((await f.publish()).alreadyPublished, true);
  assert.deepEqual(f.state.events, ['--check-upload']);
  assert(f.state.calls.every((call) => ['view', 'download'].includes(call.kind)));
});

test('published notes or asset verification failures never rewrite a published release', async (t) => {
  const notes = publication(t, { isDraft: false, body: 'different signed notes' });
  await assert.rejects(notes.publish(), /notes differ/);
  assert(notes.state.calls.every((call) => call.kind === 'view'));
  const assets = publication(t, { isDraft: false });
  assets.state.release.assets = assets.assets;
  assets.state.verifyError = new Error('uploaded asset digest mismatch');
  await assert.rejects(assets.publish(), /digest mismatch/);
  assert(assets.state.calls.every((call) => ['view', 'download'].includes(call.kind)));
});

test('draft asset verification failure prevents publication and leaves a recoverable draft', async (t) => {
  const f = publication(t);
  f.state.verifyError = new Error('draft asset digest mismatch');
  await assert.rejects(f.publish(), /draft asset digest mismatch/);
  assert.equal(f.state.release.isDraft, true);
  assert.equal(f.state.calls.filter((call) => call.kind === 'publish').length, 0);
  assert.equal(f.state.events.at(-1), '--check-draft');
});

test('a transient publish error reconciles server success before retrying publication', async (t) => {
  const f = publication(t);
  f.state.failures.publish = [{ error: httpError(502), after: true }];
  await f.publish();
  assert.equal(f.state.calls.filter((call) => call.kind === 'publish').length, 1);
  assert.deepEqual(f.state.events.slice(-3), ['--check-draft', 'publish', '--check-upload']);
});

test('a transient publish failure while still a draft repeats validation before publication', async (t) => {
  const f = publication(t);
  f.state.failures.publish = [{ error: httpError(504) }];
  await f.publish();
  assert.equal(f.state.calls.filter((call) => call.kind === 'publish').length, 2);
  assert.deepEqual(f.state.events.slice(-4), ['--check-draft', '--check-draft', 'publish', '--check-upload']);
  assert.deepEqual(f.state.sleeps, [1000]);
});

test('permanent lookup and creation errors are not retried or treated as absence', async (t) => {
  const lookup = publication(t);
  lookup.state.failures.view = [{ error: httpError(403) }];
  await assert.rejects(lookup.publish(), /fixture error/);
  assert.equal(lookup.state.calls.length, 1);
  const create = publication(t);
  create.state.failures.create = [{ error: httpError(403) }];
  await assert.rejects(create.publish(), /fixture error/);
  assert.equal(create.state.calls.filter((call) => call.kind === 'create').length, 1);
  assert.deepEqual(create.state.sleeps, []);
});

test('creation server errors exhaust a fixed retry budget without uploads', async (t) => {
  const f = publication(t);
  f.state.failures.create = Array.from({ length: 4 }, () => ({ error: httpError(502) }));
  await assert.rejects(f.publish(), /fixture error/);
  assert.equal(f.state.calls.filter((call) => call.kind === 'create').length, 4);
  assert.equal(f.state.calls.filter((call) => call.kind === 'upload').length, 0);
  assert.deepEqual(f.state.sleeps, [1000, 2000, 4000]);
});

function signedUpload(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-signed-upload-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, 'artifacts');
  const metadataPath = path.join(root, 'uploaded.json');
  const downloadedLatest = path.join(root, 'downloaded-latest.json');
  const tag = 'v9.8.7';
  const keys = crypto.generateKeyPairSync('ed25519');
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(artifactDir);
  const assets = releaseAssetDescriptors(tag).map((descriptor) => {
    const bytes = Buffer.from(`fixture binary ${descriptor.name}`);
    fs.writeFileSync(path.join(artifactDir, descriptor.name), bytes);
    return { ...descriptor, fileSize: bytes.length, sha256: hash(bytes), downloadUrl: `${repo}/releases/download/${tag}/${descriptor.name}` };
  });
  const legacy = Buffer.from(JSON.stringify({ schema: 1, repository: repo, tag, assets: assets.map((asset) => ({ name: asset.name, size: asset.fileSize, sha256: asset.sha256 })) }));
  fs.writeFileSync(path.join(artifactDir, 'ApkStart-update.json'), legacy);
  fs.writeFileSync(path.join(artifactDir, 'ApkStart-update.json.sig'), crypto.sign(null, legacy, keys.privateKey));
  fs.writeFileSync(path.join(artifactDir, 'SHA256SUMS'), assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n');
  const input = { tag, releaseNotes: 'Signed release notes.', publishedAt: '2026-11-25T12:00:00.000Z', assets };
  function setRemote(changes = {}, privateKey = keys.privateKey) {
    const remote = Buffer.from(JSON.stringify(createLatestManifest({ ...input, ...changes }, privateKey)) + '\n');
    fs.writeFileSync(downloadedLatest, remote);
    const uploaded = releaseFileNames(tag).map((name) => {
      const bytes = name === 'latest.json' ? remote : fs.readFileSync(path.join(artifactDir, name));
      return { name, size: bytes.length, digest: `sha256:${hash(bytes)}`, url: `${repo}/releases/download/${tag}/${name}` };
    });
    fs.writeFileSync(metadataPath, JSON.stringify({ assets: uploaded }));
  }
  fs.writeFileSync(path.join(artifactDir, 'latest.json'), JSON.stringify(createLatestManifest({ ...input, publishedAt: '2026-11-26T12:00:00.000Z' }, keys.privateKey)) + '\n');
  setRemote();
  return {
    artifactDir, assets, setRemote,
    check: (mode = '--check-upload') => runReleaseTool(mode, artifactDir, metadataPath, downloadedLatest, { tag, publicKey: keys.publicKey }),
  };
}

test('real signed published assets verify after a rerun changes only the latest manifest timestamp', async (t) => {
  const f = signedUpload(t);
  await f.check();
});

test('draft checks still require the exact freshly signed latest manifest bytes', async (t) => {
  const f = signedUpload(t);
  await assert.rejects(f.check('--check-draft'), /\u4e0a\u4f20\u6821\u9a8c\u5931\u8d25 latest\.json/);
});

test('published rerun verification rejects other signed manifest changes and an untrusted key', async (t) => {
  const f = signedUpload(t);
  f.setRemote({ releaseNotes: 'Other signed notes.' });
  await assert.rejects(f.check(), /\u672c\u5730\u7b7e\u540d\u8f7d\u8377\u4e0d\u4e00\u81f4/);
  f.setRemote({ assets: f.assets.map((asset, index) => index ? asset : { ...asset, sha256: 'b'.repeat(64) }) });
  await assert.rejects(f.check(), /\u672c\u5730\u7b7e\u540d\u8f7d\u8377\u4e0d\u4e00\u81f4/);
  f.setRemote({}, crypto.generateKeyPairSync('ed25519').privateKey);
  await assert.rejects(f.check(), /\u7b7e\u540d\u6821\u9a8c\u5931\u8d25/);
});

test('published rerun verification still hashes every local binary', async (t) => {
  const f = signedUpload(t);
  fs.appendFileSync(path.join(f.artifactDir, f.assets[0].name), 'tampered');
  await assert.rejects(f.check(), /\u4e0a\u4f20\u6821\u9a8c\u5931\u8d25/);
});

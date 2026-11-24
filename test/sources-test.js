'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const {
  Sources, classifyFailure, getJsonResponse, rateLimitUntil,
} = require('../src/core/sources');
const {
  createLatestManifest,
  releaseAssetDescriptors,
  repo,
} = require('../src/core/release-manifest');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-sources-test-'));
  tempRoots.push(root);
  return root;
}
after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

const apiBase = 'https://api.fixture.invalid/repos/yuchen0x1/apkstart';
const manifestUrl = 'https://static.fixture.invalid/latest.json';
const releaseUrl = (tag, name) => `${repo}/releases/download/${tag}/${name}`;

function keys() {
  return crypto.generateKeyPairSync('ed25519');
}

function signedManifest(privateKey, tag = 'v1.2.3') {
  const assets = releaseAssetDescriptors(tag).map((asset, index) => ({
    ...asset,
    fileSize: 1000 + index,
    sha256: crypto.createHash('sha256').update(`${tag}:${asset.name}`).digest('hex'),
    downloadUrl: releaseUrl(tag, asset.name),
  }));
  return createLatestManifest({
    tag,
    releaseNotes: `Release ${tag}\n\nFixes and improvements.`,
    publishedAt: '2026-11-24T12:00:00.000Z',
    assets,
  }, privateKey);
}

function response(body, status = 200, headers = {}) {
  return { status, headers, body };
}

function makeSources(opts = {}) {
  const pair = opts.keys || keys();
  const calls = [];
  const steps = opts.steps ? opts.steps.slice() : [];
  const requestJson = async (url, init) => {
    calls.push({ url, init });
    if (!steps.length) throw new Error(`unexpected request: ${url}`);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    return step;
  };
  const now = opts.now || (() => 1795521600000);
  const sources = new Sources(
    () => ({ runtime: { githubToken: 'ghp_old-user-setting-must-not-be-sent' } }),
    {
      requestJson,
      publicKey: pair.publicKey,
      manifestUrl: opts.manifestUrl === false ? undefined : (opts.manifestUrl || manifestUrl),
      apiBase,
      now,
      cacheFile: opts.cacheFile,
      apiRetryFloorMs: opts.apiRetryFloorMs || 1000,
    },
  );
  return { sources, calls, pair, steps };
}

function legacySignedRelease(privateKey, tag = 'v1.2.3') {
  const asset = releaseAssetDescriptors(tag)[0];
  const sha256 = crypto.createHash('sha256').update(`${tag}:${asset.name}`).digest('hex');
  const proofBody = Buffer.from(JSON.stringify({
    schema: 1,
    repository: repo,
    tag,
    assets: [{ name: asset.name, size: 1000, sha256 }],
  }));
  const signature = crypto.sign(null, proofBody, privateKey).toString('base64');
  return {
    tag_name: tag,
    name: `ApkStart ${tag}`,
    body: `<!-- apkstart-manifest ${proofBody.toString('base64')} ${signature} -->\n\nRelease notes.`,
    html_url: `${repo}/releases/tag/${tag}`,
    published_at: '2026-11-24T12:00:00.000Z',
    assets: [{
      name: asset.name,
      size: 1000,
      digest: `sha256:${sha256}`,
      browser_download_url: releaseUrl(tag, asset.name),
    }],
  };
}

test('signed static latest.json is preferred and maps verified assets to the updater shape', async () => {
  const pair = keys();
  const manifest = signedManifest(pair.privateKey);
  const { sources, calls } = makeSources({
    keys: pair,
    steps: [response(manifest)],
  });

  const latest = await sources.latest();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, manifestUrl);
  assert.equal(latest.version, '1.2.3');
  assert.equal(latest.tag, 'v1.2.3');
  assert.equal(latest.notes, manifest.releaseNotes);
  assert.equal(latest.publishedAt, manifest.publishedAt);
  assert.equal(latest.assets.length, 4);
  for (const entry of manifest.assets) {
    const asset = latest.assets.find((item) => item.name === entry.name);
    assert.ok(asset, `missing ${entry.name}`);
    assert.equal(asset.size, entry.fileSize);
    assert.equal(asset.digest, `sha256:${entry.sha256}`);
    assert.equal(asset.url, entry.downloadUrl);
    assert.deepEqual(asset.urls, [entry.downloadUrl]);
    assert.equal(asset.source, 'github');
  }
  assert.ok(calls.every(({ init }) => !Object.keys(init.headers || {})
    .some((key) => key.toLowerCase() === 'authorization')));
});

test('static DNS failure falls back to one signed GitHub API release response without credentials', async () => {
  const pair = keys();
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND static.fixture.invalid'), { code: 'ENOTFOUND' });
  const { sources, calls } = makeSources({
    keys: pair,
    steps: [
      dns,
      response(legacySignedRelease(pair.privateKey)),
    ],
  });
  const latest = await sources.latest();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, manifestUrl);
  assert.equal(calls[1].url, `${apiBase}/releases/latest`);
  assert.equal(latest.version, '1.2.3');
  assert.equal(latest.assets[0].digest.startsWith('sha256:'), true);
  assert.ok(calls.every(({ init }) => !Object.keys(init.headers || {})
    .some((key) => key.toLowerCase() === 'authorization')));
});

test('default static URL is the official Release latest.json endpoint', async () => {
  const pair = keys();
  const calls = [];
  const sources = new Sources(() => ({}), {
    requestJson: async (url) => {
      calls.push(url);
      return response(signedManifest(pair.privateKey));
    },
    publicKey: pair.publicKey,
    apiBase,
  });
  await sources.latest();
  assert.deepEqual(calls, [`${repo}/releases/latest/download/latest.json`]);
});

test('static timeout falls back to exactly one GitHub latest-release request', async () => {
  const pair = keys();
  const timeout = Object.assign(new Error('fixture request timeout'), { code: 'ETIMEDOUT' });
  const { sources, calls } = makeSources({
    keys: pair,
    steps: [timeout, response(legacySignedRelease(pair.privateKey))],
  });
  const latest = await sources.latest();
  assert.equal(latest.tag, 'v1.2.3');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, manifestUrl);
  assert.equal(calls[1].url, `${apiBase}/releases/latest`);
});

test('invalid JSON and a bad Ed25519 signature are rejected before API fallback', async (t) => {
  for (const [name, invalidBody] of [
    ['invalid JSON', '{not json'],
    ['wrong signing key', signedManifest(keys().privateKey)],
  ]) {
    await t.test(name, async () => {
      const pair = keys();
      const { sources, calls } = makeSources({
        keys: pair,
        steps: [
          response(invalidBody),
          response(legacySignedRelease(pair.privateKey)),
        ],
      });
      const latest = await sources.latest();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, manifestUrl);
      assert.equal(calls[1].url, `${apiBase}/releases/latest`);
      assert.equal(latest.tag, 'v1.2.3');
    });
  }
});

test('API 403 and 429 are classified and rate limits prevent immediate forced retries', async (t) => {
  const cases = [
    {
      name: '403 uses X-RateLimit-Reset',
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1795521660',
      },
      retryAt: 1795521660000,
    },
    {
      name: '429 uses Retry-After seconds',
      status: 429,
      headers: { 'retry-after': '90' },
      retryAt: 1795521690000,
    },
    {
      name: '429 uses Retry-After HTTP-date',
      status: 429,
      headers: { 'retry-after': 'Tue, 24 Nov 2026 12:03:00 GMT' },
      retryAt: Date.parse('2026-11-24T12:03:00.000Z'),
    },
  ];
  for (const row of cases) {
    await t.test(row.name, async () => {
      let clock = 1795521600000;
      const pair = keys();
      const limited = response({ message: 'API rate limit exceeded' }, row.status, row.headers);
      const apiCalls = (calls) => calls.filter((call) => call.url === `${apiBase}/releases/latest`).length;
      const { sources, calls } = makeSources({
        keys: pair,
        now: () => clock,
        steps: [
          response(null, 503), limited,
          response(null, 503),
          response(null, 503),
          response(null, 503), response(legacySignedRelease(pair.privateKey)),
        ],
      });
      await assert.rejects(sources.latest({ force: true }), new RegExp(String(row.status)));
      assert.equal(calls.length, 2, 'static failure and exactly one API request');
      assert.equal(calls[1].url, `${apiBase}/releases/latest`);

      await assert.rejects(sources.latest({ force: true }));
      assert.equal(apiCalls(calls), 1, 'force must not bypass a rate-limit not-before');

      clock = row.retryAt - 1;
      await assert.rejects(sources.latest({ force: true }));
      assert.equal(apiCalls(calls), 1, 'do not retry before the server reset time');

      clock = row.retryAt + 1;
      const latest = await sources.latest({ force: true });
      assert.equal(latest.tag, 'v1.2.3');
      assert.equal(apiCalls(calls), 2, 'retry after reset gets exactly one API request');
    });
  }
});

test('successful static checks do not clear a separate GitHub API rate-limit cooldown', async () => {
  let clock = 1795521600000;
  const pair = keys();
  const limited = response({ message: 'API rate limit exceeded' }, 429, {
    'retry-after': '90',
  });
  const { sources, calls } = makeSources({
    keys: pair,
    now: () => clock,
    steps: [
      response(null, 503), limited,
      response(signedManifest(pair.privateKey)),
      response(null, 503),
      response(legacySignedRelease(pair.privateKey)),
    ],
  });

  await assert.rejects(sources.latest({ force: true }), /429/);
  const staticLatest = await sources.latest({ force: true });
  assert.equal(staticLatest.manifestKind, 'latest');

  clock += 1000;
  const stale = await sources.latest({ force: true });
  assert.equal(stale.stale, true, 'cooldown keeps the last verified manifest available offline');
  assert.equal(stale.tag, staticLatest.tag);
  assert.equal(calls.filter((call) => call.url === `${apiBase}/releases/latest`).length, 1,
    'a good static check must not reset API Retry-After');
  assert.equal(calls.length, 4, 'static failure during cooldown must not issue another API request');
});

test('API 500 and 404 stay distinct and do not trigger duplicate release-list calls', async (t) => {
  for (const status of [404, 500]) {
    await t.test(String(status), async () => {
      const pair = keys();
      const { sources, calls } = makeSources({
        keys: pair,
        steps: [
          response(null, 503),
          response({ message: `fixture ${status}` }, status),
          response(legacySignedRelease(pair.privateKey)),
        ],
      });
      await assert.rejects(sources.latest({ force: true }), new RegExp(String(status)));
      assert.equal(calls.length, 2, 'API failure must not immediately query /releases');
    });
  }
  assert.equal(classifyFailure(null, response({ message: 'Forbidden' }, 403)), 'forbidden');
});

test('verified manifest cache survives a new Sources instance and serves offline state without fetching', async () => {
  const root = tempRoot();
  const cacheFile = path.join(root, 'latest-cache.json');
  const pair = keys();
  const now = () => 1795521600000;
  const first = makeSources({
    keys: pair,
    now,
    cacheFile,
    steps: [response(signedManifest(pair.privateKey))],
  });
  const online = await first.sources.latest();
  assert.equal(online.tag, 'v1.2.3');
  assert.ok(fs.existsSync(cacheFile), 'verified manifest cache should be persisted');

  const offline = makeSources({
    keys: pair,
    now: () => now() + 1000,
    cacheFile,
    steps: [],
  });
  const cached = await offline.sources.latest();
  assert.equal(cached.tag, 'v1.2.3');
  assert.equal(offline.calls.length, 0, 'fresh verified cache should avoid network calls');
});

test('concurrent checks share one static manifest request', async () => {
  const pair = keys();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const sources = new Sources(() => ({}), {
    requestJson: async (url) => {
      calls.push(url);
      return pending;
    },
    publicKey: pair.publicKey,
    manifestUrl,
    apiBase,
  });
  const one = sources.latest();
  const two = sources.latest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [manifestUrl]);
  finish(response(signedManifest(pair.privateKey)));
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.tag, 'v1.2.3');
  assert.equal(b.tag, 'v1.2.3');
  assert.equal(calls.length, 1);
});

test('empty static manifest and API DNS failure remain a recoverable update-check error', async () => {
  const networkError = Object.assign(new Error('getaddrinfo ENOTFOUND api.fixture.invalid'), { code: 'ENOTFOUND' });
  const { sources, calls } = makeSources({
    steps: [
      response({ message: 'not a manifest' }),
      networkError,
    ],
  });
  await assert.rejects(sources.latest({ force: true }), (error) => {
    assert.match(error.message, /ENOTFOUND|DNS|api\.fixture\.invalid/i);
    assert.equal(error.kind, 'dns');
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, manifestUrl);
  assert.equal(calls[1].url, `${apiBase}/releases/latest`);
});

test('real HTTP response headers, timeout classification and redirect allowlist are enforced', async (t) => {
  const server = require('node:http').createServer((req, res) => {
    if (req.url === '/limited') {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '12',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1795521660',
      });
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'https://untrusted.invalid/latest.json' });
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const limited = await getJsonResponse(`${base}/limited`);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.message, 'API rate limit exceeded');
  assert.equal(classifyFailure(null, limited), 'rate-limit');
  assert.equal(rateLimitUntil(limited, 1795521600000, 1000), 1795521660000);

  await assert.rejects(
    getJsonResponse(`${base}/timeout`, { timeout: 30 }),
    (error) => classifyFailure(error) === 'timeout',
  );
  await assert.rejects(
    getJsonResponse(`${base}/redirect`, { redirectAllowlist: () => false }),
    /未授权主机/,
  );
});

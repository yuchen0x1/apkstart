'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { downloadWithFallback } = require('../src/core/download');

const roots = [];
const servers = new Set();
const allowLocalRedirects = (target) => target.protocol === 'http:' && target.hostname === '127.0.0.1';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-download-acceleration-'));
  roots.push(root);
  return root;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.add(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function releaseServer(data, { slow = false, fail = false, onRequest = () => {} } = {}) {
  return listen((req, res) => {
    onRequest(req);
    if (fail) {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
    if (!Number.isSafeInteger(start) || start > end || start >= data.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
      res.end();
      return;
    }
    const body = data.subarray(start, end + 1);
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': body.length,
      ETag: '"fixture-release-v1"',
    };
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    res.writeHead(match ? 206 : 200, headers);
    if (!slow) {
      res.end(body);
      return;
    }
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const next = Math.min(body.length, offset + 4096);
      res.write(body.subarray(offset, next));
      offset = next;
      if (offset === body.length) {
        clearInterval(timer);
        res.end();
      }
    }, 50);
    res.once('close', () => clearInterval(timer));
  });
}

function options(data, extra = {}) {
  return {
    retries: 0,
    connections: 1,
    minChunk: 64 * 1024,
    idleMs: 2000,
    expectSha256: crypto.createHash('sha256').update(data).digest('hex'),
    expectedSize: data.length,
    redirectAllowlist: allowLocalRedirects,
    ...extra,
  };
}

after(async () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('official route is used first and a successful download never contacts the proxy', async () => {
  const data = Buffer.alloc(256 * 1024, 0x5a);
  let officialCalls = 0;
  let proxyCalls = 0;
  let authorizationSeen = false;
  const official = await releaseServer(data, {
    onRequest: (req) => {
      officialCalls += 1;
      authorizationSeen ||= Boolean(req.headers.authorization);
    },
  });
  const proxy = await releaseServer(data, { onRequest: () => { proxyCalls += 1; } });
  const dest = path.join(tempRoot(), 'release.zip');
  fs.writeFileSync(dest, 'old verified cache');

  const result = await downloadWithFallback([
    { source: 'github', name: 'GitHub official', url: official },
    { source: 'gh-proxy', name: 'GH-Proxy', url: proxy },
  ], dest, options(data));

  assert.equal(result.source, 'github');
  assert.ok(officialCalls > 0);
  assert.equal(proxyCalls, 0);
  assert.equal(authorizationSeen, false);
  assert.deepEqual(fs.readFileSync(dest), data);
});

test('sustained low throughput switches once to the fallback route', async () => {
  const data = Buffer.alloc(256 * 1024, 0x35);
  let slowCalls = 0;
  let proxyCalls = 0;
  const slow = await releaseServer(data, { slow: true, onRequest: () => { slowCalls += 1; } });
  const proxy = await releaseServer(data, { onRequest: () => { proxyCalls += 1; } });
  const routes = [];
  const dest = path.join(tempRoot(), 'slow-release.zip');

  const result = await downloadWithFallback([
    { source: 'github', name: 'official', url: slow },
    { source: 'gh-proxy', name: 'fallback', url: proxy },
  ], dest, options(data, {
    // Two parallel chunks each emit about 80 KB/s in this fixture; use an
    // aggregate threshold high enough to exercise the route switch.
    slowBps: 512 * 1024,
    slowWindowMs: 100,
    slowWindows: 2,
    onRoute: ({ index }) => routes.push(index),
  }));

  assert.ok(slowCalls > 0);
  assert.ok(proxyCalls > 0);
  assert.deepEqual(routes, [0, 1], 'routes must not switch back to official within one attempt');
  assert.equal(result.source, 'gh-proxy');
  assert.deepEqual(fs.readFileSync(dest), data);
});

test('an official HTTP failure falls back, while two failed routes leave no installable file', async () => {
  const data = Buffer.alloc(128 * 1024, 0x44);
  const official = await releaseServer(data, { fail: true });
  const proxy = await releaseServer(data);
  const dest = path.join(tempRoot(), 'fallback-release.zip');
  const result = await downloadWithFallback([
    { source: 'github', name: 'official', url: official },
    { source: 'gh-proxy', name: 'proxy', url: proxy },
  ], dest, options(data));
  assert.equal(result.source, 'gh-proxy');
  assert.deepEqual(fs.readFileSync(dest), data);

  const deadOfficial = await releaseServer(data, { fail: true });
  const deadProxy = await releaseServer(data, { fail: true });
  const failedDest = path.join(tempRoot(), 'failed-release.zip');
  await assert.rejects(downloadWithFallback([
    { source: 'github', name: 'official', url: deadOfficial },
    { source: 'gh-proxy', name: 'proxy', url: deadProxy },
  ], failedDest, options(data)), /official[\s\S]*proxy|proxy[\s\S]*official/);
  assert.equal(fs.existsSync(failedDest), false);
});

test('a partial download resumes only from the same route on the next attempt', async () => {
  const data = Buffer.alloc(256 * 1024, 0x29);
  let interrupted = false;
  const requestedStarts = [];
  const url = await listen((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && range[1] === '0' && range[2] === '0') {
      res.writeHead(206, {
        'Content-Length': 1,
        'Content-Range': `bytes 0-0/${data.length}`,
        ETag: '"resume-v1"',
      });
      res.end(data.subarray(0, 1));
      return;
    }
    if (!interrupted) {
      interrupted = true;
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      const body = data.subarray(start, end + 1);
      res.writeHead(range ? 206 : 200, {
        'Content-Length': body.length,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
        ETag: '"resume-v1"',
      });
      res.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    assert.ok(range, 'resumed request must include Range');
    const start = Number(range[1]);
    requestedStarts.push(start);
    const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    const body = data.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Length': body.length,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      ETag: '"resume-v1"',
    });
    res.end(body);
  });
  const dest = path.join(tempRoot(), 'resumed-release.zip');
  const routes = [{ source: 'github', name: 'official', url }];

  await assert.rejects(downloadWithFallback(routes, dest, options(data, {
    minChunk: 64 * 1024,
  })), /线路均失败/);
  assert.ok(fs.existsSync(`${dest}.route-1.part`), 'same-route partial must be retained');
  assert.ok(fs.existsSync(`${dest}.route-1.part.chunks.json`), 'completed chunks must have an identity-bound sidecar');
  const firstAttemptStarts = [...requestedStarts];
  requestedStarts.length = 0;
  const result = await downloadWithFallback(routes, dest, options(data, {
    minChunk: 64 * 1024,
  }));
  assert.equal(result.source, 'github');
  const reusableStart = firstAttemptStarts.find((start) => start > 0);
  assert.ok(reusableStart !== undefined, 'at least one completed chunk should be reusable');
  assert.equal(requestedStarts.includes(reusableStart), false, 'completed chunk must not be downloaded again');
  assert.deepEqual(fs.readFileSync(dest), data);
  assert.equal(fs.existsSync(`${dest}.route-1.part`), false);
});

test('external cancellation preserves route state and never starts the proxy route', async () => {
  const data = Buffer.alloc(1024 * 1024, 0x62);
  let officialCalls = 0;
  let proxyCalls = 0;
  const official = await releaseServer(data, {
    slow: true,
    onRequest: () => { officialCalls += 1; },
  });
  const proxy = await releaseServer(data, {
    onRequest: () => { proxyCalls += 1; },
  });
  const dest = path.join(tempRoot(), 'cancelled-release.zip');
  const controller = new AbortController();
  let signalled = false;
  await assert.rejects(downloadWithFallback([
    { source: 'github', name: 'official', url: official },
    { source: 'gh-proxy', name: 'proxy', url: proxy },
  ], dest, options(data, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (!signalled && progress.got > 0) {
        signalled = true;
        controller.abort();
      }
    },
  })), /取消/);

  assert.equal(signalled, true);
  assert.ok(officialCalls > 0);
  assert.equal(proxyCalls, 0);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.route-1.part.chunks.json`), true);
});

test('signed SHA-256 and manifest size mismatches are rejected before publishing the destination', async () => {
  const data = Buffer.alloc(128 * 1024, 0x71);
  const first = await releaseServer(data);
  const second = await releaseServer(data);
  const badHashDest = path.join(tempRoot(), 'bad-hash.zip');
  await assert.rejects(downloadWithFallback([
    { source: 'github', name: 'official', url: first },
    { source: 'gh-proxy', name: 'proxy', url: second },
  ], badHashDest, options(data, { expectSha256: '0'.repeat(64) })), /SHA-256|所有下载线路均失败/);
  assert.equal(fs.existsSync(badHashDest), false);

  const wrongSizeDest = path.join(tempRoot(), 'wrong-size.zip');
  await assert.rejects(downloadWithFallback([
    { source: 'github', name: 'official', url: first },
    { source: 'gh-proxy', name: 'proxy', url: second },
  ], wrongSizeDest, options(data, { expectedSize: data.length + 1 })), /大小不符|所有下载线路均失败/);
  assert.equal(fs.existsSync(wrongSizeDest), false);
});

test('download staging refuses symlink/junction and hard-link aliases before contacting a route', async () => {
  const data = Buffer.alloc(128 * 1024, 0x7c);
  let requests = 0;
  const server = await releaseServer(data, { onRequest: () => { requests += 1; } });

  const outside = path.join(tempRoot(), 'outside.bin');
  fs.writeFileSync(outside, Buffer.from('must remain unchanged'));
  const linkedDest = path.join(tempRoot(), 'linked-dest.zip');
  const staged = `${linkedDest}.route-1.part`;
  fs.linkSync(outside, staged);
  await assert.rejects(downloadWithFallback([
    { source: 'github', name: 'official', url: server },
  ], linkedDest, options(data)), /硬链接/);
  assert.equal(requests, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must remain unchanged');

  const junctionRoot = tempRoot();
  const junctionTarget = path.join(junctionRoot, 'target');
  const junctionDest = path.join(junctionRoot, 'nested', 'release.zip');
  fs.mkdirSync(junctionTarget);
  if (process.platform === 'win32') {
    fs.symlinkSync(junctionTarget, path.dirname(junctionDest), 'junction');
  } else {
    fs.symlinkSync(junctionTarget, path.dirname(junctionDest), 'dir');
  }
  await assert.rejects(downloadWithFallback([
    { source: 'github', name: 'official', url: server },
  ], junctionDest, options(data)), /符号链接|junction/);
  assert.equal(requests, 0);
});

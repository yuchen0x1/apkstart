'use strict';
/** 失败/取消必须等全部分块收尾，不能在返回后写共享 fd 或继续换源。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { download, downloadParallel, downloadMulti, downloadAnyParallel } = require('../src/core/download');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-download-life-'));
const SAMPLE = Buffer.alloc(8192, 7);
const SAMPLE_SHA256 = crypto.createHash('sha256').update(SAMPLE).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }
async function serverFor(handler, fn) {
  const timers = new Set();
  let requests = 0;
  const server = http.createServer((req, res) => { requests += 1; handler(req, res, timers); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, () => requests); }
  finally {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
function range(req) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  return match ? match.slice(1).map(Number) : null;
}
function respond(res, start, end, total) {
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': end - start + 1,
    ETag: '"lifecycle-v1"',
  });
}
function respondFull(res, body = SAMPLE) {
  res.writeHead(200, { 'Content-Length': body.length, ETag: '"lifecycle-v1"' });
  res.end(body);
}

(async () => {
  await test('单个分块失败会取消仍在等响应头的分块，不留后续重试', async () => {
    await serverFor((req, res, timers) => {
      const pair = range(req);
      if (!pair) { respondFull(res, Buffer.alloc(4096)); return; }
      const [start, end] = pair;
      if (start === 0 && end === 0) { respond(res, 0, 0, 4096); res.end(Buffer.alloc(1)); return; }
      if (start === 0) timers.add(setTimeout(() => { res.writeHead(500); res.end(); }, 40));
      // 另一个分块故意永不返回响应头，必须由失败信号销毁请求。
    }, async (url, count) => {
      const dest = path.join(ROOT, 'failed.bin');
      const started = Date.now();
      await assert.rejects(downloadParallel(url, dest, { minChunk: 1024, connections: 2, retries: 1 }), /分块/);
      assert(Date.now() - started < 2000, '不能等连接超时才返回');
      assert(!fs.existsSync(dest), '失败的预分配文件必须清理');
      const before = count();
      await delay(120);
      assert.strictEqual(count(), before, '返回后不能再发分块重试');
    });
  });
  await test('多源下载取消后保留断点，返回后不再写入', async () => {
    await serverFor((req, res, timers) => {
      const pair = range(req);
      if (!pair) { respondFull(res, SAMPLE); return; }
      const [start, end] = pair;
      respond(res, start, end, SAMPLE.length);
      if (start === 0 && end === 0) { res.end(SAMPLE.subarray(0, 1)); return; }
      let pos = start;
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return; }
        const next = Math.min(pos + 16, end + 1);
        res.write(SAMPLE.subarray(pos, next));
        pos = next;
        if (pos >= end + 1) { clearInterval(timer); res.end(); }
      }, 10);
      timers.add(timer);
    }, async (url, count) => {
      const dest = path.join(ROOT, 'paused.bin');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60);
      try {
        await assert.rejects(downloadMulti([url + '/a', url + '/b'], dest, {
          expectSha256: SAMPLE_SHA256,
          minChunk: 1024, connections: 4, signal: controller.signal,
        }), /取消|失败/);
      } finally { clearTimeout(timer); }
      assert(fs.existsSync(dest + '.chunks.json'), '取消后保留分块续传凭据');
      const before = fs.readFileSync(dest);
      const requested = count();
      await delay(120);
      assert(fs.readFileSync(dest).equals(before), '返回后内容不应再变');
      assert.strictEqual(count(), requested);
    });
  });
  await test('已经取消的信号不会建立连接或尝试其它源', async () => {
    await serverFor((_req, res) => res.end('unexpected'), async (url, count) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(downloadAnyParallel([url + '/a', url + '/b'], path.join(ROOT, 'cancelled.bin'), {
        signal: controller.signal,
      }), /取消/);
      assert.strictEqual(count(), 0);
    });
  });
  await test('单流收到数据后取消，写流关闭且文件不再变化', async () => {
    await serverFor((_req, res, timers) => {
      res.writeHead(200, { 'Content-Length': 8192 });
      res.write(Buffer.alloc(16));
      timers.add(setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(16, 3)); }, 10));
    }, async (url) => {
      const dest = path.join(ROOT, 'single.bin');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60);
      try { await assert.rejects(download(url, dest, { signal: controller.signal }), /取消/); }
      finally { clearTimeout(timer); }
      const before = fs.readFileSync(dest);
      await delay(100);
      assert(fs.readFileSync(dest).equals(before));
      fs.renameSync(dest, dest + '.closed');
    });
  });
  console.log(`下载生命周期回归：${passed} 通过，0 失败`);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(ROOT, { recursive: true, force: true }));

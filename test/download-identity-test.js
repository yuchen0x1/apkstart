'use strict';
// 下载内容仅作为字节比较；服务仅绑定回环，不执行下载数据。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const vm = require('vm');
const { createRequire } = require('module');
const crypto = require('crypto');
const downloadModule = require('../src/core/download');
const {
  download, downloadParallel, downloadMulti, downloadAny, downloadAnyParallel, openStream,
} = downloadModule;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-download-identity-'));
const A = Buffer.alloc(32 * 1024, 65);
const B = Buffer.alloc(A.length, 66);
const WRITE_SAMPLE = Buffer.from(Array.from({ length: A.length }, (_, i) => i % 251));
const digest = (buf, algo = 'sha256') => crypto.createHash(algo).update(buf).digest('hex');
const options = { minChunk: 4096, connections: 4, retries: 1 };
let passed = 0;
let failed = 0;
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'case-'));
  try { await fn(path.join(dir, 'file.bin')); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n' + e.stack); }
}
async function serverFor(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, ...req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
function serve(req, res, data, etag, { ignoreIfRange = false, omitResponseTag = false } = {}) {
  const headers = etag && !omitResponseTag ? { ETag: etag } : {};
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag || ignoreIfRange)) {
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
    if (start >= data.length) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${data.length}` });
      res.end(); return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
    res.end(data.subarray(start, end + 1)); return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.length });
  res.end(data);
}
// 第一遍单流只收前缀后断流，生成真实的续传状态。
async function interruptSingle(url, dest, opt = {}) {
  await assert.rejects(download(url, dest, { ...opt, retries: 0 }), /中断|aborted|reset|socket|字节数|不完整/i);
  assert(fs.statSync(dest).size > 0 && fs.statSync(dest).size < A.length);
}
function partial(res, data, etag) {
  res.writeHead(200, { 'Content-Length': data.length, ...(etag ? { ETag: etag } : {}) });
  res.write(data.subarray(0, 8192));
  const timer = setTimeout(() => res.destroy(), 25);
  res.once('close', () => clearTimeout(timer));
}

async function withFakeRequests(redirects, fn) {
  const originalHttp = http.request;
  const originalHttps = https.request;
  const requested = [];
  http.request = https.request = (url, _options, callback) => {
    const href = String(url);
    requested.push(href);
    assert(Object.hasOwn(redirects, href), `unexpected network request: ${href}`);
    const response = Readable.from([]);
    response.statusCode = 302;
    response.headers = { location: redirects[href] };
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => callback(response));
    request.destroy = () => response.destroy();
    return request;
  };
  try { return await fn(requested); }
  finally { http.request = originalHttp; https.request = originalHttps; }
}

async function withPositionalWrites(write, fn) {
  const original = fs.writeSync;
  fs.writeSync = (...args) => {
    if (Buffer.isBuffer(args[1]) && Number.isInteger(args[4])) return write(original, ...args);
    return original(...args); // 不拦截分块边车等顺序写入。
  };
  try { return await fn(); } finally { fs.writeSync = original; }
}

async function withShortWrites(fn) {
  let shortWrites = 0;
  let written = 0;
  const result = await withPositionalWrites((original, fd, buffer, offset, length, position) => {
    const count = original(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
    if (count < length) shortWrites++;
    written += count;
    return count;
  }, fn);
  assert(shortWrites > 0, '必须实际触发短写');
  assert.strictEqual(written, result.size);
  return result;
}

// 加载 Windows 分支，不改变宿主平台；provision 的下载与所有子进程入口均由 fake 提供。
function fakeWindowsProvisioner(downloadAnyParallel, testPin) {
  const filename = require.resolve('../src/core/provision');
  const localRequire = createRequire(filename);
  const fakeModule = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8');
  // 测试替换发布时的固定摘要，不在产品里开放可注入的 pin。
  const pin = /^const AEHD_ARCHIVE_SHA256 = '[0-9a-f]*';/im;
  assert(pin.test(source));
  const fakeSource = testPin === undefined ? source
    : source.replace(pin, `const AEHD_ARCHIVE_SHA256 = ${JSON.stringify(testPin)};`);
  const fakeRequire = (id) => {
    if (id === './download') return { downloadAnyParallel };
    if (id === 'child_process') {
      const forbidden = () => assert.fail('unexpected child process');
      return { spawn: forbidden, spawnSync: forbidden, execFile: forbidden };
    }
    return localRequire(id);
  };
  vm.compileFunction(fakeSource, ['require', 'module', 'process'], { filename })(fakeRequire, fakeModule, { platform: 'win32' });
  return fakeModule.exports;
}

(async () => {
  await test('无 validator 的任意已有 A 前缀不得和同长 B 尾部拼接', async (dest) => {
    fs.writeFileSync(dest, A.subarray(0, 8192));
    await serverFor((req, res) => serve(req, res, B), async (url, requests) => {
      await download(url, dest);
      assert(fs.readFileSync(dest).equals(B), '必须安全重下完整 B，不能 A+B');
      assert(!requests[0].range, '无身份不发送续传请求');
    });
  });
  await test('无摘要多源同长 A/B 不得成功返回混合内容（相同 ETag 也不能跨 URL 证明身份）', async (dest) => {
    await serverFor((req, res) => serve(req, res, req.url === '/a' ? A : B, '"same-tag"'), async (url) => {
      const r = await downloadMulti([url + '/a', url + '/b'], dest, options);
      const actual = fs.readFileSync(dest);
      assert(actual.equals(A) || actual.equals(B), '禁止同长 A/B 混合成功');
      assert(!r.multi, '没有可信摘要不允许多源拼接');
      assert(r.parallel > 1, '可靠单源仍应保留并行能力');
    });
  });
  await test('没有 ETag 或只有 weak ETag 的中断单流，下次重下而非续传', async (dest) => {
    for (const tag of [undefined, 'W/"weak"']) {
      let first = true;
      await serverFor((req, res) => {
        if (first) { first = false; partial(res, A, tag); } else serve(req, res, B, tag);
      }, async (url, requests) => {
        await interruptSingle(url, dest);
        await download(url, dest);
        assert(fs.readFileSync(dest).equals(B));
        assert(!requests[1].range, '没有 strong ETag 不能复用旧字节');
      });
      fs.rmSync(dest, { force: true });
    }
  });
  await test('单流声明长度与实际字节不符时拒绝完成', async (dest) => {
    await serverFor((_req, res) => {
      res.writeHead(200, { 'Content-Length': A.length, ETag: '"short"' });
      res.end(A.subarray(0, A.length - 1));
    }, async (url) => {
      await assert.rejects(download(url, dest, { retries: 0 }), /字节数|中断|不完整|aborted/);
      assert(!fs.existsSync(dest + '.download.json') || fs.statSync(dest).size < A.length);
    });
  });
  await test('strong ETag 单流中断后使用 If-Range 续传，不重复已有字节', async (dest) => {
    let first = true;
    await serverFor((req, res) => {
      if (first) { first = false; partial(res, A, '"A"'); } else serve(req, res, A, '"A"');
    }, async (url, requests) => {
      await interruptSingle(url, dest);
      const size = fs.statSync(dest).size;
      await download(url, dest);
      assert.strictEqual(requests[1].range, `bytes=${size}-`);
      assert.strictEqual(requests[1]['if-range'], '"A"');
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('strong ETag 改变且 If-Range 返回 200 时替换旧前缀', async (dest) => {
    let first = true;
    await serverFor((req, res) => {
      if (first) { first = false; partial(res, A, '"A"'); } else serve(req, res, B, '"B"');
    }, async (url) => {
      await interruptSingle(url, dest);
      await download(url, dest);
      assert(fs.readFileSync(dest).equals(B));
    });
  });
  await test('服务器忽略 If-Range 或 206 丢失 ETag 时不能拼接成功', async (dest) => {
    for (const omitResponseTag of [false, true]) {
      let first = true;
      await serverFor((req, res) => {
        if (first) { first = false; partial(res, A, '"A"'); }
        else serve(req, res, B, '"B"', { ignoreIfRange: true, omitResponseTag });
      }, async (url) => {
        await interruptSingle(url, dest);
        try { await download(url, dest); }
        catch (_) { return; } // 明确拒绝也是安全结果，不能把混合文件报告成功。
        assert(fs.readFileSync(dest).equals(B));
      });
      fs.rmSync(dest, { force: true });
    }
  });
  await test('同长、同末尾 4KiB 的已有坏文件不通过 416/tail 猜测复用', async (dest) => {
    const wrong = Buffer.from(A);
    B.subarray(0, 8192).copy(wrong);
    fs.writeFileSync(dest, wrong);
    await serverFor((req, res) => serve(req, res, A), async (url) => {
      await download(url, dest);
      assert(fs.readFileSync(dest).equals(A), '只比较尾部不足以证明文件身份');
    });
  });
  await test('换源即使 ETag 相同也不续接上一个 URL 的前缀', async (dest) => {
    await serverFor((req, res) => {
      if (req.url === '/a') partial(res, A, '"same"'); else serve(req, res, B, '"same"');
    }, async (url, requests) => {
      await downloadAny([url + '/a', url + '/b'], dest, { retries: 0 });
      assert(fs.readFileSync(dest).equals(B));
      assert(!requests.find((r) => r.url === '/b').range);
    });
  });
  await test('可信 SHA256 边车绑定摘要后允许无 ETag 单流续传', async (dest) => {
    let first = true;
    const expectedSha256 = digest(A);
    await serverFor((req, res) => {
      if (first) { first = false; partial(res, A); } else serve(req, res, A);
    }, async (url, requests) => {
      await interruptSingle(url, dest, { expectSha256: expectedSha256 });
      const meta = JSON.parse(fs.readFileSync(dest + '.download.json', 'utf8'));
      assert.strictEqual(meta.checksum, `expectSha256:${expectedSha256}`);
      await download(url, dest, { expectSha256: expectedSha256 });
      assert(requests[1].range);
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('可信 SHA1 保留同内容多源并行，最终校验通过', async (dest) => {
    await serverFor((req, res) => serve(req, res, A), async (url) => {
      const r = await downloadMulti([url + '/a', url + '/b'], dest, { ...options, expectSha1: digest(A, 'sha1') });
      assert(r.multi && r.sources === 2 && r.parallel > 1);
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('可信摘要下 A/B 混合必须校验失败并删除产物', async (dest) => {
    await serverFor((req, res) => serve(req, res, req.url === '/a' ? A : B), async (url) => {
      await assert.rejects(downloadMulti([url + '/a', url + '/b'], dest, { ...options, expectSha256: digest(A) }), /SHA-256/);
      assert(!fs.existsSync(dest));
      assert(!fs.existsSync(dest + '.chunks.json'));
    });
  });
  await test('旧 total/n/done 元数据不能把同长历史块当成当前版本', async (dest) => {
    fs.writeFileSync(dest, B);
    fs.writeFileSync(dest + '.chunks.json', JSON.stringify({ total: A.length, n: 4, done: [0] }));
    await serverFor((req, res) => serve(req, res, A), async (url) => {
      const r = await downloadMulti([url + '/a', url + '/b'], dest, { ...options, expectSha256: digest(A) });
      assert(!r.resumed, '旧 sidecar 无内容 identity 必须丢弃');
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('已完成块带摘要身份保存，取消后可继续；摘要变化时同长文件安全重下', async (dest) => {
    let pausing = true;
    let data = A;
    let controller;
    await serverFor((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (pausing && m && Number(m[1]) > 0) {
        const timer = setTimeout(() => controller.abort(), 80);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      serve(req, res, data);
    }, async (url, requests) => {
      const urls = [url + '/a', url + '/b'];
      const opt = { ...options, expectSha256: digest(A) };
      controller = new AbortController();
      await assert.rejects(downloadMulti(urls, dest, { ...opt, signal: controller.signal }), /取消|失败/);
      const meta = JSON.parse(fs.readFileSync(dest + '.chunks.json', 'utf8'));
      assert(meta.done.includes(0), '第一块应已完成');
      const begin = requests.length;
      pausing = false;
      const r = await downloadMulti(urls, dest, opt);
      assert(r.resumed, '同摘要应复用已完成块');
      assert(!requests.slice(begin).some((req) => req.range === 'bytes=0-8191'), '不能重复下载已完成块');
      assert(fs.readFileSync(dest).equals(A));
      // 再生成 A 的真实 sidecar，下一轮改成同长 B 和新的可信摘要。
      fs.rmSync(dest);
      pausing = true;
      controller = new AbortController();
      await assert.rejects(downloadMulti(urls, dest, { ...opt, signal: controller.signal }));
      pausing = false;
      data = B;
      const changed = await downloadMulti(urls, dest, { ...options, expectSha256: digest(B) });
      assert(!changed.resumed, '摘要改变不能沿用 A 的 doneSet');
      assert(fs.readFileSync(dest).equals(B));
    });
  });
  await test('单源分块在探测后版本改变，不可输出同长混合文件', async (dest) => {
    let count = 0;
    await serverFor((req, res) => {
      count++;
      serve(req, res, count <= 2 ? A : B, count <= 2 ? '"A"' : '"B"');
    }, async (url) => {
      await assert.rejects(downloadParallel(url, dest, options), /分块|身份|版本/);
      assert(!fs.existsSync(dest));
    });
  });
  await test('单源并行即使 ETag 相同，最终 URL 改变也必须中止', async (dest) => {
    await serverFor((req, res) => {
      if (req.url === '/source') {
        res.writeHead(302, { Location: req.headers.range === 'bytes=0-0' ? '/v1' : '/v2' });
        res.end();
      } else serve(req, res, req.url === '/v1' ? A : B, '"same-tag"');
    }, async (url) => {
      await assert.rejects(downloadParallel(url + '/source', dest, options), /身份/);
      assert(!fs.existsSync(dest));
    });
  });
  await test('不可靠单源保留完整下载但不跨请求拼接分块', async (dest) => {
    await serverFor((req, res) => serve(req, res, A, 'W/"weak"'), async (url, requests) => {
      const r = await downloadParallel(url, dest, options);
      assert(!r.parallel, 'weak ETag 不足以固定多个分块请求的版本');
      assert(requests.some((req) => !req.range));
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('允许直连字面 IP 和 localhost 的回环 HTTP', async (dest) => {
    await serverFor((req, res) => serve(req, res, A, '"loopback"'), async (url) => {
      await download(url, dest);
      await download(url.replace('127.0.0.1', 'localhost'), dest);
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('HTTPS（含 localhost）每一跳均拒绝降级，且不得发出 HTTP 请求', async () => {
    for (const from of ['https://localhost/package', 'https://example.com/package']) {
      for (const to of ['http://example.com/public.zip', 'http://127.0.0.1/local.zip', 'http://localhost/local.zip']) {
        await withFakeRequests({ [from]: to }, async (requested) => {
          await assert.rejects(openStream(from, { noProxy: true }), /降级|HTTPS|安全策略/);
          assert.deepStrictEqual(requested, [from]);
        });
      }
    }
    const first = 'https://localhost/start';
    const second = 'https://localhost/relative';
    const third = 'https://example.com/secure';
    await withFakeRequests({ [first]: '/relative', [second]: third, [third]: 'http://example.com/public' }, async (requested) => {
      await assert.rejects(openStream(first, { noProxy: true }), /降级|HTTPS|安全策略/);
      assert.deepStrictEqual(requested, [first, second, third]);
    });
  });
  await test('回环 HTTP 允许本地相对重定向，但拒绝公网 HTTP 与其他协议', async (dest) => {
    await serverFor((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { Location: '/local' }); res.end(); }
      else serve(req, res, A);
    }, async (url) => {
      await download(url + '/start', dest);
      assert(fs.readFileSync(dest).equals(A));
    });
    const source = 'http://127.0.0.1/start';
    await withFakeRequests({ [source]: 'http://example.com/public.zip' }, async (requested) => {
      await assert.rejects(openStream(source, { noProxy: true }), /HTTPS|安全策略/);
      assert.deepStrictEqual(requested, [source]);
    });
    for (const url of ['http://example.com/file', 'http://localhost.example.com/file', 'http://128.0.0.1/file', 'http://[::ffff:127.0.0.1]/file', 'ftp://127.0.0.1/file']) {
      await withFakeRequests({}, async (requested) => {
        await assert.rejects(openStream(url, { noProxy: true }), /HTTPS|安全策略/);
        assert.deepStrictEqual(requested, []);
      });
    }
  });
  await test('单源分块在底层 writeSync 短写时仍写出完整内容', async (dest) => {
    await serverFor((req, res) => serve(req, res, WRITE_SAMPLE, '"short-write"'), async (url) => {
      const result = await withShortWrites(() => downloadParallel(url, dest, options));
      assert(result.parallel > 1, '必须测试无摘要的单源分块路径');
      assert.strictEqual(result.size, WRITE_SAMPLE.length);
      assert(fs.readFileSync(dest).equals(WRITE_SAMPLE), 'buffer offset 和绝对写入位置均必须随短写推进');
    });
  });
  await test('多源分块在底层 writeSync 短写时仍写出完整内容', async (dest) => {
    await serverFor((req, res) => serve(req, res, WRITE_SAMPLE, '"short-write"'), async (url) => {
      await withShortWrites(async () => {
        const r = await downloadMulti([url + '/a', url + '/b'], dest, {
          ...options, expectSha256: digest(WRITE_SAMPLE),
        });
        assert(r.multi && r.sources === 2);
        return r;
      });
      assert(fs.readFileSync(dest).equals(WRITE_SAMPLE));
    });
  });
  await test('分块写入零字节或无效返回值必须失败，不能把稀疏文件报告成功', async (dest) => {
    await serverFor((req, res) => serve(req, res, A, '"write-failure"'), async (url) => {
      for (const invalid of [0, -1, NaN, 0.5, Infinity, '1', undefined, 1000000]) {
        for (const multi of [false, true]) {
          let completions = 0;
          let writes = 0;
          await withPositionalWrites(() => { writes++; return invalid; }, async () => {
            const opt = { ...options, onProgress: (p) => { if (p.percent === 100) completions++; } };
            if (multi) opt.expectSha256 = digest(A);
            await assert.rejects(multi ? downloadMulti([url + '/a', url + '/b'], dest, opt)
              : downloadParallel(url, dest, opt), /写入.*无效字节数/);
          });
          assert(writes > 0, '必须触发底层写入');
          assert.strictEqual(completions, 0, '失败不能报告完成');
          if (multi) {
            const meta = JSON.parse(fs.readFileSync(dest + '.chunks.json', 'utf8'));
            assert.deepStrictEqual(meta.done, [], '未写入的块不能记录为完成');
          } else assert(!fs.existsSync(dest), '无摘要单源失败必须删除稀疏文件');
          for (const file of [dest, dest + '.chunks.json']) fs.rmSync(file, { force: true });
        }
      }
    });
  });
  await test('短写中途磁盘失败不推进未完成 buffer，重试从原位置安全重写', async (dest) => {
    await serverFor((req, res) => serve(req, res, A, '"retry-write"'), async (url, requests) => {
      let writes = 0;
      let retryStart;
      await withPositionalWrites((original, fd, buffer, offset, length, position) => {
        writes++;
        if (writes === 1) {
          retryStart = position;
          return original(fd, buffer, offset, Math.floor(length / 2), position);
        }
        if (writes === 2) throw new Error('fake disk failure');
        return original(fd, buffer, offset, length, position);
      }, () => downloadParallel(url, dest, { ...options, retries: 2 }));
      const retried = `bytes=${retryStart}-${retryStart + A.length / options.connections - 1}`;
      assert.strictEqual(requests.filter((r) => r.range === retried).length, 2);
      assert(fs.readFileSync(dest).equals(A));
    });
  });
  await test('分块残骸进入单流时不能把稀疏文件按长度当成成品', async (dest) => {
    fs.writeFileSync(dest, Buffer.alloc(A.length));
    fs.writeFileSync(dest + '.chunks.json', JSON.stringify({ total: A.length, n: 4, done: [] }));
    await serverFor((req, res) => serve(req, res, A, '"A"'), async (url) => {
      await downloadAnyParallel([url], dest, options);
      assert(fs.readFileSync(dest).equals(A));
      assert(!fs.existsSync(dest + '.chunks.json'));
    });
  });
  await test('单流取消后等待文件流关闭，返回后不再写入', async (dest) => {
    let timer;
    await serverFor((_req, res) => {
      res.writeHead(200, { 'Content-Length': 1024 * 1024 });
      res.write(Buffer.alloc(32, 1));
      timer = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(32, 2)); }, 5);
      res.once('close', () => clearInterval(timer));
    }, async (url) => {
      const controller = new AbortController();
      const cancel = setTimeout(() => controller.abort(), 35);
      try { await assert.rejects(download(url, dest, { signal: controller.signal, retries: 0 }), /取消/); }
      finally { clearTimeout(cancel); if (timer) clearInterval(timer); }
      const before = fs.readFileSync(dest);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert(fs.readFileSync(dest).equals(before));
    });
  });
  await test('Windows AEHD 缺少可信 pin 时不下载、不解压，也不接受运行时传入的摘要', async () => {
    const forbidden = () => assert.fail('missing pin must block every provisioning side effect');
    const { Provisioner, SOURCES } = fakeWindowsProvisioner(forbidden);
    SOURCES.aehdSha256 = digest(A); // 可变配置不可作为提权包的信任根。
    const provisioner = new Provisioner(ROOT);
    provisioner.ensureDirs = provisioner.extractZip = forbidden;
    await assert.rejects(provisioner.installAehd(forbidden), {
      code: 'AEHD_UNVERIFIED', message: /SHA-256.*WHPX/,
    });
  });
  await test('Windows AEHD 固定摘要校验先于解压，且不能把已有文件混入验证后的包', async (dest) => {
    let archive = B;
    await serverFor((req, res) => serve(req, res, archive), async (url) => {
      const expected = digest(A);
      const { Provisioner } = fakeWindowsProvisioner(async (urls, target, opt) => {
        assert.deepStrictEqual(urls, ['https://dl.google.com/android/repository/aehd-windows_v2.2.zip']);
        assert.strictEqual(opt.expectSha256, expected);
        return download(url, target, { ...opt, retries: 0 });
      }, expected);
      const root = path.dirname(dest);
      const paths = { tmp: path.join(root, 'tmp'), aehdDir: path.join(root, 'aehd') };
      fs.mkdirSync(paths.tmp);
      const provisioner = new Provisioner(root);
      provisioner.ensureDirs = () => paths;
      provisioner.guardDisk = async () => {};
      provisioner._downloadUrls = (canonicalUrl) => [canonicalUrl];
      let extracted = 0;
      provisioner.extractZip = async (zip, output) => {
        extracted += 1;
        assert(fs.readFileSync(zip).equals(A));
        assert(!fs.existsSync(output), '只在新目录中解压已校验的包');
        fs.mkdirSync(output);
        // 只写测试数据，不是真正的批处理或驱动；任何子进程调用都被禁止。
        for (const name of ['silent_install.bat', 'aehd.sys']) fs.writeFileSync(path.join(output, name), A);
      };
      await assert.rejects(provisioner.installAehd(), /SHA-256/);
      assert.strictEqual(extracted, 0);
      assert(!fs.existsSync(paths.aehdDir));
      assert.deepStrictEqual(fs.readdirSync(paths.tmp), []);

      archive = A;
      fs.mkdirSync(paths.aehdDir);
      const existing = path.join(paths.aehdDir, 'silent_install.bat');
      fs.writeFileSync(existing, B);
      await assert.rejects(provisioner.installAehd(), /已有的 AEHD 目录/);
      assert(fs.readFileSync(existing).equals(B), '不能覆盖或误标已有安装文件');
      fs.rmSync(paths.aehdDir, { recursive: true });

      const result = await provisioner.installAehd();
      assert.strictEqual(result.installer, existing);
      assert(fs.readFileSync(result.installer).equals(A));
      assert.deepStrictEqual(fs.readdirSync(paths.tmp), []);
    });
  });
  await test('QEMU ISO provider 将目录摘要传给下载器执行绑定校验', async (dest) => {
    const original = downloadModule.downloadMulti;
    const backendPath = require.resolve('../src/core/system-providers/qemu-backend');
    const previousBackend = require.cache[backendPath];
    require.cache[backendPath] = {
      id: backendPath, filename: backendPath, loaded: true,
      exports: { QemuBackend: class QemuBackendStub {} },
    };
    const { QemuIsoProvider } = require('../src/core/system-providers/qemu-iso-provider');
    const actualFile = path.join(path.dirname(dest), 'downloads', 'android-x86.iso');
    let optionsSeen;
    downloadModule.downloadMulti = async (_urls, target, opt) => {
      optionsSeen = opt;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, A);
      return { size: A.length, multi: true };
    };
    try {
      const provider = new QemuIsoProvider({
        systemId: 'android-x86', dataDir: path.dirname(dest),
        settingsFn: () => ({ runtime: { downloadConnections: 3 } }),
      });
      const expectedSha256 = digest(A);
      const result = await provider.download({}, { info: {
        version: 'test', url: 'http://127.0.0.1/archive.iso', mirrors: ['http://127.0.0.1/mirror.iso'],
        sha256: expectedSha256,
      } });
      assert.strictEqual(optionsSeen.expectSha256, expectedSha256);
      assert.strictEqual(result.sha256, expectedSha256);
      assert.strictEqual(fs.readFileSync(actualFile).length, A.length);
    } finally {
      downloadModule.downloadMulti = original;
      if (previousBackend) require.cache[backendPath] = previousBackend;
      else delete require.cache[backendPath];
    }
  });
  console.log(`下载身份回归：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(ROOT, { recursive: true, force: true }));

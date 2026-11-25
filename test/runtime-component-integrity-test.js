'use strict';
// 只使用临时目录、回环 HTTP、内存 metadata 和依赖替身。绝不运行下载物、真实 adb/QEMU 或提权命令。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');

const CORE = path.resolve(__dirname, '../src/core');
const GOOGLE = 'https://dl.google.com/android/repository/repository2-3.xml';
const BASE = 'https://dl.google.com/android/repository/';
const QEMU_URL = 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe';
const ADB = Buffer.alloc(5 * 1024 * 1024 + 1, 65);
const QEMU = Buffer.alloc(60 * 1024 * 1024 + 1, 81);
const digest = (data, algorithm) => crypto.createHash(algorithm).update(data).digest('hex');
const ADB_SHA1 = digest(ADB, 'sha1');
const QEMU_SHA512 = digest(QEMU, 'sha512');
const TAMPERED_QEMU_SHA512 = crypto.createHash('sha512').update(Buffer.from([0])).update(QEMU.subarray(1)).digest('hex');
const TEST_QEMU_RECORD = `${QEMU_SHA512}  qemu-w64-setup-20260811.exe`;
const forbidden = () => assert.fail('forbidden dependency/child process/network access');

function load(name, dependencies, { host = 'win32', arch = 'x64', pin, timers = {} } = {}) {
  const filename = path.join(CORE, name);
  let source = fs.readFileSync(filename, 'utf8');
  if (pin !== undefined && name === 'runtime-integrity.js') {
    // 仅在测试编译的源副本中替换静态清单，不在产品 API/设置中开放 pin 注入。
    const marker = /^const QEMU_WINDOWS_SHA512_RECORD = '[^']*';/m;
    assert(marker.test(source));
    source = source.replace(marker, `const QEMU_WINDOWS_SHA512_RECORD = ${JSON.stringify(pin)};`);
  }
  const module = { exports: {} };
  const localRequire = (id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith('.') || id === 'child_process') throw new Error(`unstubbed dependency: ${id}`);
    return require(id);
  };
  vm.compileFunction(source, ['require', 'module', 'process', 'setTimeout', 'clearTimeout'], { filename })(
    localRequire, module, { platform: host, arch, env: {} }, timers.setTimeout || setTimeout, timers.clearTimeout || clearTimeout,
  );
  return module.exports;
}

function archive(host, { version = '37.0.3', sum = ADB_SHA1, type = 'sha1', url, size = ADB.length, extra = '' } = {}) {
  const suffix = { windows: 'win', linux: 'linux', macosx: 'darwin' }[host];
  return `<archive><complete><size>${size}</size>`
    + (sum === null ? '' : `<checksum type="${type}">${sum}</checksum>`)
    + `<url>${url || `platform-tools_r${version}-${suffix}.zip`}</url></complete>`
    + `<host-os>${host}</host-os>${extra}</archive>`;
}
function pkg(archives, { version = '37.0.3', channel = 'channel-0', attrs = '', name = 'platform-tools', preview = '' } = {}) {
  const [major, minor, micro] = version.split('.');
  return `<remotePackage path="${name}" ${attrs}><revision><major>${major}</major><minor>${minor}</minor><micro>${micro}</micro>${preview}</revision>`
    + `<channelRef ref="${channel}"/><archives>${archives}</archives></remotePackage>`;
}
const sdk = (...packages) => `<?xml version="1.0"?><sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">${packages.join('')}</sdk:sdk-repository>`;
const metadata = (options = {}) => sdk(pkg(archive('windows', options)));
function response(xml, { status = 200, finalUrl = GOOGLE, headers = {}, stream } = {}) {
  const body = Buffer.from(xml);
  const res = stream || Readable.from([body]);
  Object.assign(res, { statusCode: status, downloadUrl: finalUrl, headers: { 'content-length': String(body.length), ...headers } });
  return res;
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-component-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
function integrity(options = {}, download = { openStream: forbidden }) {
  return load('runtime-integrity.js', { './download': download }, options);
}
function harness(t, options = {}) {
  const root = temp(t);
  const settings = { runtime: { dir: path.join(root, 'runtime'), avdDir: path.join(root, 'avd'), ...options.runtime } };
  const calls = { metadata: [], downloads: [], extract: [], versions: [], spawn: [], saves: [], heads: [] };
  const downloader = {
    openStream: async (url, requestOptions) => {
      calls.metadata.push({ url, options: requestOptions });
      assert.equal(url, GOOGLE, 'metadata 只能请求固定的 Google 官方 URL');
      if (options.openStream) return options.openStream(url, requestOptions);
      return response(options.xml || metadata());
    },
    downloadAny: async (urls, dest, opt) => {
      calls.downloads.push({ urls, dest, opt });
      assert.deepEqual(fs.readdirSync(path.dirname(dest)), [], '每次下载必须使用新的空目录');
      if (options.downloadAdb) return options.downloadAdb(urls, dest, opt);
      fs.writeFileSync(dest, ADB);
      return { file: dest };
    },
    download: async (url, dest, opt) => {
      calls.downloads.push({ urls: [url], dest, opt });
      assert.deepEqual(fs.readdirSync(path.dirname(dest)), [], '安装器不能混入旧下载目录的依赖');
      if (options.downloadQemu) return options.downloadQemu(url, dest, opt);
      fs.writeFileSync(dest, QEMU);
      return { file: dest };
    },
    downloadAnyParallel: forbidden,
    head: async (url) => { calls.heads.push(url); return { status: 200, size: 123 }; },
  };
  const helper = integrity(options, downloader);
  const children = {
    spawnSync: forbidden,
    execFile: forbidden,
    spawn: (file, args, spawnOptions) => {
      calls.spawn.push({ file, args, options: spawnOptions });
      if (options.spawn) return options.spawn(file, args, spawnOptions);
      const child = new EventEmitter();
      child.kill = forbidden;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  };
  const { Provisioner } = load('provision.js', {
    child_process: children,
    './store': { DATA_DIR: path.join(root, 'data'), getSettings: () => settings, saveSettings: (value) => calls.saves.push(value) },
    './doctor': { freeDiskMB: () => 100000 },
    './platform': {},
    './host/profile': require('../src/core/host/profile'),
    './download': downloader,
    './zip': {},
    './sources': { Sources: class { candidates(url) { return options.transports || [url]; } } },
    './images': {},
    './runtime-integrity': helper,
  }, options);
  const provisioner = new Provisioner(path.join(root, 'app'));
  const paths = provisioner.paths();
  provisioner._fetchText = forbidden; // 不能通过旧的可返回部分文本的索引读取逻辑绕过检查。
  provisioner.extractZip = async (file, dest) => { calls.extract.push({ file, dest }); };
  provisioner.adbVersion = async () => {
    calls.versions.push('adb');
    assert.equal(provisioner._adbCache, null, '安装后必须使旧版本缓存失效');
    return { ok: true, path: paths.adbExe, version: '1.0.fixture' };
  };
  provisioner.qemuVersion = async () => {
    calls.versions.push('qemu');
    assert.equal(provisioner._qemuCache, null);
    return { ok: true, path: paths.qemuExe, version: 'fixture' };
  };
  return { provisioner, paths, calls, settings, helper };
}
function noInstall(calls) {
  assert.equal(calls.extract.length, 0);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.versions.length, 0);
  assert.equal(calls.saves.length, 0);
}
function noStaging(paths) {
  if (fs.existsSync(paths.tmp)) assert.deepEqual(fs.readdirSync(paths.tmp), []);
}

// 加载真实 HTTP 下载器但替换代理及外网入口；只允许回环数据，不读真实用户设置。
function loopbackDownloader() {
  return load('download.js', {
    './proxy': { getActiveProxy: forbidden, tunnel: forbidden },
    https: { request: forbidden, Agent: forbidden },
    http: { ...http, request: (url, ...args) => {
      assert.equal(new URL(url).hostname, '127.0.0.1');
      return http.request(url, ...args);
    } },
  });
}
async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('静态 QEMU 信任根是官网所链接发布方的固定 SHA-512 记录，不在线信任镜像摘要', () => {
  const helper = integrity();
  const component = helper.resolveQemuComponent('', 'win32', 'x64');
  assert.equal(component.url, QEMU_URL);
  assert.equal(component.checksumSource, 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.sha512');
  assert.equal(component.checksum.algorithm, 'sha512');
  assert.match(component.checksum.value, /^[a-f0-9]{128}$/);
  assert(Object.isFrozen(component));
  assert(Object.isFrozen(component.checksum));
});

test('官方 metadata 按稳定版、host-os、revision 和对应 checksum 成对选择', () => {
  const helper = integrity();
  const xml = sdk(
    pkg(archive('windows', { version: '99.0.0' }), { version: '99.0.0', channel: 'channel-3', preview: '<preview>1</preview>' }),
    pkg(archive('windows', { version: '90.0.0' }), { version: '90.0.0', attrs: 'obsolete="true"' }),
    pkg(archive('windows', { version: '36.0.0' }), { version: '36.0.0' }),
    pkg(archive('linux', { sum: '1'.repeat(40) }) + archive('macosx', { sum: '2'.repeat(40) }) + archive('windows', { sum: ADB_SHA1.toUpperCase() })),
  );
  for (const [host, arch, suffix, checksum] of [
    ['win32', 'x64', 'win', ADB_SHA1], ['linux', 'x64', 'linux', '1'.repeat(40)],
    ['darwin', 'x64', 'darwin', '2'.repeat(40)], ['darwin', 'arm64', 'darwin', '2'.repeat(40)],
  ]) {
    const component = helper.parsePlatformTools(xml, host, arch);
    assert.equal(component.url, `${BASE}platform-tools_r37.0.3-${suffix}.zip`);
    assert.equal(component.checksum.value, checksum);
    assert.equal(component.size, ADB.length);
  }
});

for (const [label, xml] of [
  ['缺 checksum', metadata({ sum: null })],
  ['空 checksum', metadata({ sum: '' })],
  ['无效 checksum', metadata({ sum: '0'.repeat(39) + 'g' })],
  ['未知摘要算法', metadata({ type: 'md5' })],
  ['错误宿主不能借用 Linux checksum', sdk(pkg(archive('linux') + archive('windows', { sum: null })))],
  ['滚动 latest URL', metadata({ url: 'platform-tools-latest-windows.zip' })],
  ['不同 revision 的 URL', metadata({ url: 'platform-tools_r36.0.0-win.zip' })],
  ['URL 指向外域', metadata({ url: 'https://mirror.invalid/platform-tools_r37.0.3-win.zip' })],
  ['宿主架构不一致', metadata({ extra: '<host-arch>arm64</host-arch>' })],
  ['重复宿主归档', sdk(pkg(archive('windows') + archive('windows')))],
  ['重复稳定版本', sdk(pkg(archive('windows')), pkg(archive('windows')))],
  ['仅 preview', sdk(pkg(archive('windows'), { channel: 'channel-1' }))],
  ['仅注释里的包', sdk(`<!--${pkg(archive('windows'))}-->`)],
  ['未闭合注释', sdk(`<!--${pkg(archive('windows'))}`)],
  ['注释嵌套残留', sdk(`<!-- outer <!--${pkg(archive('windows'))}-->`)],
  ['HTML 风格无效注释结束标记', sdk(`<!--${pkg(archive('windows'))}--!>`)],
  ['缺少根结束标记', metadata().replace('</sdk:sdk-repository>', '')],
  ['实体声明', '<!DOCTYPE sdk [<!ENTITY external SYSTEM="file:///private">]>' + metadata()],
]) {
  test(`ADB ${label}：下载前失败关闭，设置及旧缓存不能补上信任根`, async (t) => {
    const { provisioner, paths, calls } = harness(t, { xml, runtime: {
      adbUrl: 'https://mirror.invalid/adb.zip', adbSha1: ADB_SHA1, adbChecksum: ADB_SHA1,
    } });
    provisioner._cache.adbSha1 = ADB_SHA1;
    await assert.rejects(provisioner.installAdb());
    assert.equal(calls.downloads.length, 0);
    assert.equal(fs.existsSync(paths.root), false);
    noInstall(calls);
  });
}

test('ADB 摘要与 metadata 配对传给下载器；自定义 URL/镜像/缓存不能覆盖可信 checksum', async (t) => {
  const h = harness(t, { transports: ['https://custom.invalid/adb.zip'], runtime: { adbUrl: 'https://evil.invalid/other.zip', adbSha1: '0'.repeat(40) } });
  h.provisioner._adbCache = { at: Date.now(), value: { ok: true, path: 'old' } };
  const result = await h.provisioner.installAdb();
  assert.equal(result.path, h.paths.adbExe);
  assert.equal(h.calls.downloads[0].opt.expectSha1, ADB_SHA1);
  assert.equal(h.calls.extract.length, 1);
  assert.equal(h.calls.metadata[0].url, GOOGLE);
  assert.deepEqual(h.calls.saves, [{ adbPath: h.paths.adbExe }]);
  noStaging(h.paths);
});

test('ADB 即使下载替身忽略 expectSha1，边界校验仍拒绝同尺寸错误内容', async (t) => {
  const untrusted = Buffer.alloc(ADB.length, 66);
  const h = harness(t, { runtime: { adbUrl: 'https://custom.invalid/adb.zip', adbSha1: digest(untrusted, 'sha1') },
    downloadAdb: async (_urls, dest) => fs.writeFileSync(dest, untrusted),
  });
  await assert.rejects(h.provisioner.installAdb(), { code: 'RUNTIME_COMPONENT_INTEGRITY' });
  noInstall(h.calls);
  noStaging(h.paths);
});

test('ADB 完整 checksum 但 metadata size 不符仍不得解压或执行', async (t) => {
  const h = harness(t, { xml: metadata({ size: ADB.length + 1 }) });
  await assert.rejects(h.provisioner.installAdb(), /大小不符/);
  noInstall(h.calls);
  noStaging(h.paths);
});

test('ADB 每次独立新目录，不复用或删除旧缓存/用户文件；失败后可安全重试', async (t) => {
  let count = 0;
  const h = harness(t, { downloadAdb: async (_urls, dest) => {
    fs.writeFileSync(dest, ADB);
    if (count++ === 0) throw new Error('fixture interruption');
  } });
  fs.mkdirSync(h.paths.tmp, { recursive: true });
  const old = path.join(h.paths.tmp, 'platform-tools.zip');
  fs.writeFileSync(old, 'unrelated previous download');
  await assert.rejects(h.provisioner.installAdb(), /interruption/);
  await h.provisioner.installAdb();
  assert.notEqual(path.dirname(h.calls.downloads[0].dest), path.dirname(h.calls.downloads[1].dest));
  assert.equal(fs.readFileSync(old, 'utf8'), 'unrelated previous download');
  assert.deepEqual(fs.readdirSync(h.paths.tmp), ['platform-tools.zip']);
});

for (const [host, arch] of [['linux', 'arm64'], ['win32', 'arm64'], ['win32', 'ia32'], ['freebsd', 'x64']]) {
  test(`ADB ${host}/${arch} 不得下载其他平台包`, async (t) => {
    const h = harness(t, { host, arch });
    await assert.rejects(h.provisioner.installAdb(), new RegExp(`${host}/${arch}`));
    assert.equal(h.calls.metadata.length, 0);
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(fs.existsSync(h.paths.root), false);
    noInstall(h.calls);
  });
}

for (const [host, osName] of [['linux', 'linux'], ['darwin', 'macosx']]) {
  test(`ADB 安装时确实使用 ${host} metadata，而不是测试机的 Windows 包`, async (t) => {
    const h = harness(t, { host, xml: sdk(pkg(archive('windows') + archive(osName))) });
    await h.provisioner.installAdb();
    const suffix = host === 'linux' ? 'linux' : 'darwin';
    assert.deepEqual(h.calls.downloads[0].urls, [`${BASE}platform-tools_r37.0.3-${suffix}.zip`]);
    assert.equal(h.calls.spawn.length, 0);
  });
}

test('回环 HTTP：缺 hash 不请求归档，摘要不符不解压，正确 metadata 才成功', async (t) => {
  const real = loopbackDownloader();
  for (const mode of ['missing', 'mismatch', 'valid']) {
    await withServer((req, res) => {
      if (req.url === '/metadata') res.end(metadata({ sum: mode === 'missing' ? null : ADB_SHA1 }));
      else if (req.url === '/payload') {
        const data = mode === 'mismatch' ? Buffer.alloc(ADB.length, 66) : ADB;
        res.writeHead(200, { 'Content-Length': data.length }); res.end(data);
      } else { res.writeHead(404); res.end(); }
    }, async (base, requests) => {
      const h = harness(t, {
        openStream: async () => { const res = await real.openStream(base + '/metadata'); res.downloadUrl = GOOGLE; return res; },
        downloadAdb: (urls, dest, opt) => {
          assert.deepEqual(urls, [`${BASE}platform-tools_r37.0.3-win.zip`]);
          assert.equal(opt.expectSha1, ADB_SHA1);
          return real.downloadAny([base + '/payload'], dest, { ...opt, retries: 0 });
        },
      });
      if (mode === 'valid') await h.provisioner.installAdb();
      else { await assert.rejects(h.provisioner.installAdb()); noInstall(h.calls); }
      assert.deepEqual(requests, mode === 'missing' ? ['/metadata'] : ['/metadata', '/payload']);
      noStaging(h.paths);
    });
  }
});

for (const [label, makeResponse] of [
  ['HTTP 错误即使包含完整 XML', () => response(metadata(), { status: 503 })],
  ['跨站重定向即使包含完整 XML', () => response(metadata(), { finalUrl: 'https://mirror.invalid/repository2-3.xml' })],
  ['被篡改 Content-Length', () => response(metadata(), { headers: { 'content-length': '9999999' } })],
  ['未知响应编码', () => response(metadata(), { headers: { 'content-encoding': 'gzip' } })],
  ['超大 XML', () => response(' '.repeat(2 * 1024 * 1024) + metadata())],
  ['收到完整包片段但流出错', () => {
    const stream = new PassThrough();
    setImmediate(() => { stream.write(metadata()); stream.destroy(new Error('fixture reset')); });
    return response(metadata(), { stream });
  }],
  ['流未 end 即 close', () => {
    const stream = new PassThrough();
    setImmediate(() => { stream.write(metadata()); stream.destroy(); });
    return response(metadata(), { stream });
  }],
]) {
  test(`官方 metadata ${label}：不得落到滚动 URL 或设置 URL`, async (t) => {
    const h = harness(t, { openStream: async () => makeResponse(), runtime: { adbUrl: 'https://mirror.invalid/adb.zip' } });
    await assert.rejects(h.provisioner.installAdb());
    assert.equal(h.calls.downloads.length, 0);
    noInstall(h.calls);
  });
}

test('官方 metadata 请求失败或超时也必须 settle 并失败关闭', async (t) => {
  for (const mode of ['throw', 'timeout']) {
    const stream = new PassThrough();
    const h = harness(t, { openStream: async () => {
      if (mode === 'throw') throw new Error('fixture TLS failure');
      return response('', { stream });
    }, timers: { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} } });
    await assert.rejects(h.provisioner.installAdb());
    assert.equal(h.calls.downloads.length, 0);
    noInstall(h.calls);
    if (mode === 'timeout') assert(stream.destroyed);
  }
});

for (const pin of ['', 'bad checksum', '0'.repeat(127) + '  qemu-w64-setup-20260811.exe', QEMU_SHA512 + '  different.exe']) {
  test(`QEMU 缺少/错误 pin（${pin.length} 字符）时禁用下载及执行并给出手动入口`, async (t) => {
    const h = harness(t, { pin, runtime: { qemuUrl: 'https://custom.invalid/qemu.exe', qemuSha512: QEMU_SHA512 } });
    await assert.rejects(h.provisioner.installQemu(), { code: 'QEMU_UNVERIFIED', message: /官方入口.*验证后手动安装/ });
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(h.calls.metadata.length, 0);
    assert.equal(fs.existsSync(h.paths.root), false);
    noInstall(h.calls);
  });
}

for (const custom of ['', 'https://custom.invalid/qemu.exe']) {
  test(`QEMU ${custom ? '自定义 URL' : '默认 URL'} 的同尺寸错误摘要不能执行（忽略用户/缓存自报 hash）`, async (t) => {
    const h = harness(t, { pin: TEST_QEMU_RECORD, runtime: { qemuUrl: custom, qemuSha512: TAMPERED_QEMU_SHA512 }, downloadQemu: async (_url, dest) => {
      fs.writeFileSync(dest, QEMU);
      const fd = fs.openSync(dest, 'r+');
      try { fs.writeSync(fd, Buffer.from([0]), 0, 1, 0); } finally { fs.closeSync(fd); }
    } });
    h.provisioner._cache.qemuSha512 = TAMPERED_QEMU_SHA512;
    await assert.rejects(h.provisioner.installQemu(), { code: 'RUNTIME_COMPONENT_INTEGRITY', message: /SHA512.*手动安装/s });
    noInstall(h.calls);
    noStaging(h.paths);
  });
}

test('回环 HTTP：QEMU 必须在 SHA-512 完整校验之后才调用子进程替身', async (t) => {
  const real = loopbackDownloader();
  await withServer((_req, res) => { res.writeHead(200, { 'Content-Length': QEMU.length }); res.end(QEMU); }, async (base, requests) => {
    const h = harness(t, { pin: TEST_QEMU_RECORD, runtime: { qemuUrl: 'https://custom.invalid/qemu.exe' },
      downloadQemu: (url, dest, opt) => {
        assert.equal(url, 'https://custom.invalid/qemu.exe');
        return real.download(base + '/fixture', dest, { ...opt, retries: 0 });
      }, spawn: (file, args, options) => {
        assert.equal(digest(fs.readFileSync(file), 'sha512'), QEMU_SHA512);
        assert.equal(options.cwd, path.dirname(file));
        assert.equal(options.shell, false);
        assert.equal(options.env, undefined, '不注入提权/兼容层环境变量');
        assert.deepEqual(args, ['/S', `/D=${h.paths.qemuDir}`]);
        assert(!/powershell|runas|cmd\.exe|winget|sudo/i.test([file, ...args].join(' ')));
        const child = new EventEmitter();
        child.kill = forbidden;
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });
    h.provisioner._qemuCache = { at: Date.now(), value: { ok: true, path: 'old' } };
    await h.provisioner.installQemu();
    assert.equal(h.calls.spawn.length, 1);
    assert.deepEqual(requests, ['/fixture']);
    assert.equal(h.calls.metadata.length, 0, '不能在线从镜像/目录抓取另一个摘要或最新文件名');
    assert.deepEqual(h.calls.versions, ['qemu']);
    noStaging(h.paths);
  });
});

for (const mode of ['throw', 'error', 'nonzero', 'signal', 'timeout']) {
  test(`QEMU 安装器 ${mode} 不得吞错、使用旧版本缓存或报告成功`, async (t) => {
    let killed = false;
    const h = harness(t, { pin: TEST_QEMU_RECORD,
      timers: mode === 'timeout' ? { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} } : {},
      spawn: () => {
        if (mode === 'throw') throw Object.assign(new Error('fixture elevation required'), { code: 'EACCES' });
        const child = new EventEmitter();
        child.kill = () => { killed = true; child.emit('close', 0, null); };
        queueMicrotask(() => {
          if (mode === 'error') child.emit('error', Object.assign(new Error('fixture elevation required'), { code: 'EACCES' }));
          if (mode === 'nonzero') child.emit('close', 1, null);
          if (mode === 'signal') child.emit('close', null, 'SIGTERM');
        });
        return child;
      },
    });
    h.provisioner._qemuCache = { at: Date.now(), value: { ok: true, path: h.paths.qemuExe } };
    const progress = [];
    await assert.rejects(h.provisioner.installQemu((item) => progress.push(item)), /手动安装/);
    assert.equal(h.calls.versions.length, 0);
    assert(!progress.some((item) => item.stage === 'done'));
    assert.equal(killed, mode === 'timeout');
    noStaging(h.paths);
  });
}

for (const [host, arch, advice] of [
  ['linux', 'x64', /发行版签名仓库.*apt install/], ['darwin', 'arm64', /macOS.*brew install/],
  ['win32', 'arm64', /适合宿主/], ['win32', 'ia32', /适合宿主/],
]) {
  test(`QEMU ${host}/${arch} 只提供正确的手动/系统包管理建议，不下载 Windows 安装器`, async (t) => {
    const h = harness(t, { host, arch });
    await assert.rejects(h.provisioner.installQemu(), { code: 'QEMU_MANUAL_INSTALL_REQUIRED', message: advice });
    assert.equal(h.calls.downloads.length, 0);
    assert.equal(h.calls.metadata.length, 0);
    assert.equal(fs.existsSync(h.paths.root), false);
    noInstall(h.calls);
  });
}

for (const url of ['http://evil.invalid/qemu.exe', 'file:///C:/qemu.exe', 'https://name@custom.invalid/qemu.exe', 'not a URL']) {
  test('QEMU 自定义非 HTTPS/含凭据/无效 URL 不能绕过来源策略', async (t) => {
    const h = harness(t, { pin: TEST_QEMU_RECORD, runtime: { qemuUrl: url } });
    await assert.rejects(h.provisioner.installQemu(), /HTTPS/);
    assert.equal(h.calls.downloads.length, 0);
    noInstall(h.calls);
  });
}

test('组件校验函数本身也拒绝缺失或错误格式 hash，不把 size 当完整性证明', async (t) => {
  const helper = integrity();
  const file = path.join(temp(t), 'fixture.data');
  fs.writeFileSync(file, 'inert fixture');
  for (const checksum of [undefined, { algorithm: 'sha256', value: '' }, { algorithm: 'md5', value: '0'.repeat(32) }]) {
    await assert.rejects(helper.verifyComponent(file, { checksum }), { code: 'RUNTIME_COMPONENT_UNVERIFIED' });
  }
});

test('AEHD 保持禁用：不能下载、解压、执行或准备提权安装器', async (t) => {
  const h = harness(t);
  await assert.rejects(h.provisioner.installAehd(), { code: 'AEHD_UNVERIFIED' });
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(fs.existsSync(h.paths.root), false);
  noInstall(h.calls);
});

test('来源预检也只探测已绑定 metadata/可信 pin 的 URL，不再探测 latest', async (t) => {
  const h = harness(t);
  await h.provisioner.probeSources();
  assert(h.calls.heads.includes(`${BASE}platform-tools_r37.0.3-win.zip`));
  assert(h.calls.heads.includes(QEMU_URL));
  assert(!h.calls.heads.some((url) => url.includes('latest')));
  noInstall(h.calls);
});

'use strict';
// 纯 VM + 内存文件系统：不落地运行时数据、不联网、不读取真实用户配置、不创建子进程。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.resolve(__dirname, '../src/core/provision.js');
const SOURCE = fs.readFileSync(filename, 'utf8');
const ROOT = path.resolve(__dirname, '.vm-instance-runtime'); // 仅作内存 map 的键，绝不 mkdir。
const READ_ONLY = { code: 'INSTANCE_RUNTIME_READ_ONLY', message: /请回主实例维护/ };
const forbidden = () => assert.fail('unexpected download/process/foreign dependency');
const inside = (root, file) => {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function memoryFs() {
  const nodes = new Map();
  const writes = [];
  const reads = [];
  const key = (file) => path.resolve(String(file));
  function error(file, code = 'ENOENT') { return Object.assign(new Error(`${code}: ${file}`), { code }); }
  function resolve(file, followLast = true) {
    let target = key(file);
    for (let count = 0; count < 20; count++) {
      const chain = [];
      let cur = target;
      while (true) { chain.push(cur); const parent = path.dirname(cur); if (parent === cur) break; cur = parent; }
      const link = chain.reverse().find((part) => nodes.get(part)?.kind === 'link' && (followLast || part !== target));
      if (!link) return target;
      target = path.resolve(nodes.get(link).target, path.relative(link, target));
    }
    throw error(file, 'ELOOP');
  }
  function seedDir(file) {
    const p = key(file);
    const parent = path.dirname(p);
    if (parent !== p && !nodes.has(parent)) seedDir(parent);
    nodes.set(p, { kind: 'dir', size: 0 });
    return p;
  }
  function seedFile(file, data = 'inert fixture', size = Buffer.byteLength(data)) {
    const p = key(file);
    if (!nodes.has(path.dirname(p))) seedDir(path.dirname(p));
    nodes.set(p, { kind: 'file', data: String(data), size });
    return p;
  }
  function seedLink(file, target) {
    const p = key(file);
    if (!nodes.has(path.dirname(p))) seedDir(path.dirname(p));
    nodes.set(p, { kind: 'link', target: key(target), size: 0 });
  }
  function stat(file, options, follow) {
    const node = nodes.get(resolve(file, follow));
    if (!node) { if (options?.throwIfNoEntry === false) return undefined; throw error(file); }
    return { size: node.size, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1,
      isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'dir', isSymbolicLink: () => node.kind === 'link' };
  }
  const api = {
    statSync: (file, options) => stat(file, options, true),
    lstatSync: (file, options) => stat(file, options, false),
    existsSync: (file) => nodes.has(resolve(file)),
    realpathSync: (file) => { const p = resolve(file); if (!nodes.has(p)) throw error(file); return p; },
    readFileSync: (file, encoding) => {
      const p = resolve(file);
      reads.push({ file: key(file), resolved: p });
      const node = nodes.get(p);
      if (!node || node.kind !== 'file') throw error(file);
      return encoding ? node.data : Buffer.from(node.data);
    },
    mkdirSync: (file) => {
      writes.push({ op: 'mkdir', file: key(file) });
      const p = resolve(file);
      if (nodes.has(p) && nodes.get(p).kind !== 'dir') throw error(file, 'ENOTDIR');
      seedDir(p);
    },
    writeFileSync: (file, data) => {
      writes.push({ op: 'write', file: key(file) });
      seedFile(resolve(file), String(data));
    },
    copyFileSync: (source, dest) => {
      writes.push({ op: 'copy', file: key(dest), source: key(source) });
      const node = nodes.get(resolve(source));
      if (!node || node.kind !== 'file') throw error(source);
      seedFile(resolve(dest), node.data, node.size);
    },
    rmSync: (file) => {
      writes.push({ op: 'rm', file: key(file) });
      const p = resolve(file, false);
      for (const name of nodes.keys()) if (inside(p, name)) nodes.delete(name);
    },
    readdirSync: (dir, options) => {
      const p = resolve(dir);
      if (nodes.get(p)?.kind !== 'dir') throw error(dir);
      return [...nodes].filter(([name]) => name !== p && path.dirname(name) === p).map(([name, node]) => (
        options?.withFileTypes ? { name: path.basename(name), isDirectory: () => node.kind === 'dir', isFile: () => node.kind === 'file' } : path.basename(name)
      ));
    },
    mkdtempSync: forbidden, renameSync: forbidden, createReadStream: forbidden, createWriteStream: forbidden,
    openSync: forbidden, readSync: forbidden, closeSync: forbidden, rmdirSync: forbidden, symlinkSync: forbidden, chmodSync: forbidden,
  };
  function snapshot(root, exclude = null) {
    return JSON.stringify([...nodes].filter(([name]) => inside(root, name) && !(exclude && inside(exclude, name))).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { api, nodes, reads, writes, seedDir, seedFile, seedLink, snapshot, key };
}

function harness({ child = true, host = 'win32', marker = child, missingRoot = false, ready = false, contextError = false } = {}) {
  const disk = memoryFs();
  // Linux 分支会有意拒绝带盘符的 runtime.dir；即使在 Windows 跑 VM 也给它无盘符根。
  const fixtureRoot = host === 'linux' ? path.join(path.sep, 'apkstart-vm-instance-runtime') : ROOT;
  const parentData = path.join(fixtureRoot, 'parent-data');
  const sharedRoot = path.join(fixtureRoot, 'shared-runtime');
  const instancesDir = path.join(parentData, 'instances');
  const dataDir = child ? path.join(instancesDir, 'child-1') : parentData;
  const avdDir = path.join(dataDir, 'avd');
  const context = { isChild: child, id: child ? 'child-1' : null, baseDir: parentData, instancesDir, dataDir, avdDir, sharedRuntimeDir: sharedRoot };
  disk.seedDir(parentData);
  disk.seedDir(instancesDir);
  disk.seedFile(path.join(parentData, 'apps.json'), 'PARENT APPS');
  disk.seedFile(path.join(parentData, 'settings.json'), 'PARENT SETTINGS');
  disk.seedFile(path.join(parentData, 'avd', 'parent.avd', 'userdata-qemu.img'), 'PARENT USERDATA');
  if (!missingRoot) disk.seedDir(sharedRoot);
  const settings = { runtime: { dir: sharedRoot, avdDir, systemImageFlavor: 'google_apis_playstore' }, engine: { mode: 'builtin' } };
  const store = { DATA_DIR: dataDir, getSettings: () => settings, saveSettings: forbidden };
  const fakeProcess = { platform: host, arch: 'x64', env: marker ? { APKSTART_INSTANCE_ID: 'child-1' } : {} };
  const requires = [];
  const dependencies = {
    fs: disk.api, path, zlib: {},
    child_process: { spawn: forbidden, spawnSync: forbidden, execFile: forbidden },
    './instance-context': { current: () => { if (contextError) throw new Error('context unavailable'); return context; } },
    './store': store, './doctor': { freeDiskMB: forbidden }, './platform': {},
    // 纯函数宿主画像（无 fs / 无子进程），直接注入真实实现即可，不改变本用例的「只读」边界。
    './host/profile': require('../src/core/host/profile'),
    './download': { download: forbidden, downloadAny: forbidden, downloadAnyParallel: forbidden, head: forbidden, openStream: forbidden },
    './runtime-integrity': { resolveAdbComponent: forbidden, resolveQemuComponent: forbidden, verifyComponent: forbidden },
    './zip': { ZipArchive: class { constructor() { forbidden(); } }, ZipFile: class { constructor() { forbidden(); } } },
    './sources': { Sources: class {} },
    './images': { ImageStore: class { active() { return { ok: true, custom: false }; } } },
  };
  const module = { exports: {} };
  vm.compileFunction(SOURCE, ['require', 'module', 'process'], { filename })(
    (id) => { requires.push(id); if (!Object.hasOwn(dependencies, id)) throw new Error(`unstubbed ${id}`); return dependencies[id]; }, module, fakeProcess,
  );
  const p = new module.exports.Provisioner(path.join(ROOT, 'app'));
  const paths = p.paths();
  p.adbVersion = async () => ({ ok: disk.api.existsSync(paths.adbExe), path: paths.adbExe, version: 'fixture' });
  p.qemuVersion = async () => ({ ok: false, path: '', version: '' });
  p.emulatorVersion = async () => ({ ok: disk.api.existsSync(paths.emulatorExe), path: paths.emulatorExe, version: 'fixture' });
  p.emulatorAccel = async () => ({ ok: true, kind: host === 'win32' ? 'whpx' : 'kvm' });
  p.hypervisor = async () => ({ whpx: host === 'win32', kvm: host === 'linux' });
  function seedReady() {
    disk.seedFile(paths.adbExe);
    if (host === 'win32') {
      disk.seedFile(path.join(paths.adbDir, 'AdbWinApi.dll'));
      disk.seedFile(path.join(paths.adbDir, 'AdbWinUsbApi.dll'));
      disk.seedFile(path.join(paths.emulatorDir, 'opengl32sw.dll'), 'INERT OPENGL', 2 * 1024 * 1024);
    }
    disk.seedFile(paths.emulatorExe);
    disk.seedFile(path.join(paths.sysImgDir, 'system.img'), 'INERT SYSTEM IMAGE', module.exports.MIN_SIZE.sysimg + 1);
    disk.seedFile(path.join(paths.sysImgDir, 'kernel-ranchu'));
  }
  if (ready) seedReady();
  const protectedSnapshot = () => ({ shared: disk.snapshot(sharedRoot), parent: disk.snapshot(parentData, instancesDir) });
  return { p, paths, context, settings, store, fakeProcess, disk, requires, parentData, sharedRoot, instancesDir, seedReady, protectedSnapshot };
}

const maintenance = [
  ['installAdb', [forbidden]], ['installQemu', [forbidden]], ['installEmulator', [forbidden]],
  ['installSystemImage', [forbidden]], ['installImage', ['default', forbidden]], ['installPlayImage', [forbidden]],
  ['installAehd', [forbidden]], ['importRuntimePack', [path.join(ROOT, 'foreign.zip'), forbidden]],
  ['downloadIso', [forbidden]], ['createDisk', [24, forbidden]],
  ['extractZip', [path.join(ROOT, 'foreign.zip'), path.join(ROOT, 'foreign-output')]],
  ['importIso', [path.join(ROOT, 'foreign.iso')]], ['importDisk', [path.join(ROOT, 'foreign.qcow2')]],
];
for (const [name, args] of maintenance) {
  test(`子实例 ${name} 在任何下载/读用户文件/版本检测/创建目录之前失败关闭`, async () => {
    const h = harness({ ready: true });
    const before = h.protectedSnapshot();
    h.p.ensureDirs = h.p.guardDisk = h.p.imageProfile = h.p.inspectIso = h.p.inspectImage = forbidden;
    const readCount = h.disk.reads.length;
    await assert.rejects(async () => h.p[name](...args), READ_ONLY);
    assert.equal(h.disk.writes.length, 0);
    assert.equal(h.disk.reads.length, readCount);
    assert(!h.requires.includes('./runtime-integrity'), '只读守卫应先于原有哈希/网络流程，且不改动它');
    assert.deepEqual(h.protectedSnapshot(), before);
  });
}

for (const host of ['win32', 'linux']) {
  test(`${host} 已就绪的子实例启动准备/环境检查只写本实例 data/AVD，缺可选共享目录也不 mkdir`, async () => {
    const h = harness({ host, ready: true });
    const before = h.protectedSnapshot();
    assert.equal(h.disk.writes.length, 0, 'paths 必须只读');
    assert.equal(h.p.ensureDirs().avdHome, h.context.avdDir);
    assert.equal(await h.p.materializeImages(forbidden), 0);
    assert.equal(h.p.ensurePlatformTools(), true);
    assert.equal(h.p.ensureSoftwareOpenGL(), host === 'win32');
    const env = await h.p.checkEnv();
    assert.equal(env.ready, true);
    assert.equal(env.engine, 'emulator');
    assert(h.disk.api.existsSync(h.context.dataDir));
    assert(h.disk.api.existsSync(h.context.avdDir));
    assert(h.disk.writes.every((entry) => inside(h.context.dataDir, entry.file)));
    for (const optional of [h.paths.qemuDir, h.paths.imagesDir, h.paths.tmp]) assert.equal(h.disk.api.existsSync(optional), false);
    assert.deepEqual(h.protectedSnapshot(), before);
  });
}

for (const badRoot of ['missing', 'file']) {
  test(`共享 root ${badRoot} 时不创建或修复它，也不提前写本实例目录`, () => {
    const h = harness({ missingRoot: true });
    if (badRoot === 'file') h.disk.seedFile(h.sharedRoot);
    const before = h.protectedSnapshot();
    assert.throws(() => h.p.ensureDirs(), READ_ONLY);
    assert.equal(h.disk.writes.length, 0);
    assert.deepEqual(h.protectedSnapshot(), before);
  });
}

for (const absent of ['adb', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'opengl32sw.dll', 'emulator']) {
  test(`缺少共享 ${absent} 时即使有 app/vendor 可复制源也只提示主实例维护`, () => {
    const h = harness({ ready: true });
    const target = absent === 'adb' ? h.paths.adbExe : absent === 'emulator' ? h.paths.emulatorExe
      : path.join(absent === 'opengl32sw.dll' ? h.paths.emulatorDir : h.paths.adbDir, absent);
    h.disk.nodes.delete(h.disk.key(target));
    for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) h.disk.seedFile(path.join(h.p.appRoot, 'tools', 'platform-tools', name));
    h.disk.seedFile(path.join(h.p.appRoot, 'build', 'vendor', 'opengl32sw.dll'), 'INERT AVAILABLE DLL', 2 * 1024 * 1024);
    const before = h.protectedSnapshot();
    assert.throws(() => absent === 'opengl32sw.dll' || absent === 'emulator' ? h.p.ensureSoftwareOpenGL() : h.p.ensurePlatformTools(), READ_ONLY);
    assert.equal(h.disk.writes.length, 0);
    assert.deepEqual(h.protectedSnapshot(), before);
  });
}

test('已展开镜像旁仍有压缩源时不重写/清理；只有压缩源时不会把它报告为子实例可启动', async () => {
  const h = harness({ ready: true });
  const compressed = path.join(h.paths.sysImgDir, 'system.img.xz');
  h.disk.seedFile(compressed, 'INERT COMPRESSED SOURCE', 100 * 1024 * 1024);
  const before = h.protectedSnapshot();
  assert.equal(await h.p.materializeImages(forbidden), 0);
  assert.equal(h.disk.writes.length, 0);
  assert.deepEqual(h.protectedSnapshot(), before);
  h.disk.nodes.delete(h.disk.key(path.join(h.paths.sysImgDir, 'system.img')));
  const packedBefore = h.protectedSnapshot();
  await assert.rejects(h.p.materializeImages(forbidden), READ_ONLY);
  const env = await h.p.checkEnv();
  assert.equal(env.ready, false);
  assert.equal(env.sysimg.ok, false);
  assert.equal(env.sysimg.pendingExtract, true);
  assert.match(env.sysimg.note, /请回主实例维护/);
  assert(h.disk.writes.every((entry) => inside(h.context.dataDir, entry.file)));
  assert.deepEqual(h.protectedSnapshot(), packedBefore);
});

for (const missing of ['system.img', 'kernel-ranchu']) {
  test(`系统镜像缺 ${missing} 时不会补齐、复制、解压或清理共享基础层`, async () => {
    const h = harness({ ready: true });
    h.disk.nodes.delete(h.disk.key(path.join(h.paths.sysImgDir, missing)));
    const before = h.protectedSnapshot();
    await assert.rejects(h.p.materializeImages(forbidden), READ_ONLY);
    assert.equal(h.disk.writes.length, 0);
    assert.deepEqual(h.protectedSnapshot(), before);
  });
}

test('不存在的镜像不会触发子实例遍历/落地空的共享 system-images', async () => {
  const h = harness();
  const before = h.protectedSnapshot();
  await assert.rejects(h.p.materializeImages(forbidden), READ_ONLY);
  assert.equal(h.disk.writes.length, 0);
  assert.deepEqual(h.protectedSnapshot(), before);
});

test('环境缓存只读写/删除子实例 cache，父清单、快照及共享 runtime 保持不变', () => {
  const h = harness({ ready: true });
  const before = h.protectedSnapshot();
  h.p.envCacheSet(h.paths.emulatorExe, { version: { ok: true, version: 'fixture' } });
  const cache = path.join(h.context.dataDir, 'cache', 'env.json');
  assert(h.disk.api.existsSync(cache));
  assert.equal(h.p.envCacheGet(h.paths.emulatorExe).version.version, 'fixture');
  h.p.invalidateEnvCache();
  assert.equal(h.disk.api.existsSync(cache), false);
  assert(h.disk.writes.every((entry) => inside(h.context.dataDir, entry.file)));
  assert.deepEqual(h.protectedSnapshot(), before);
});

for (const alias of ['instancesDir', 'dataDir', 'avdDir', 'cacheDir', 'cacheFile']) {
  test(`隔离路径 ${alias} 是指向父数据的 symlink/junction 时不跟随写入或删除`, () => {
    const h = harness({ ready: true });
    const parentCache = path.join(h.parentData, 'cache', 'env.json');
    h.disk.seedFile(parentCache, 'PARENT CACHE');
    const link = { instancesDir: h.context.instancesDir, dataDir: h.context.dataDir, avdDir: h.context.avdDir,
      cacheDir: path.join(h.context.dataDir, 'cache'), cacheFile: path.join(h.context.dataDir, 'cache', 'env.json') }[alias];
    h.disk.seedLink(link, alias === 'cacheFile' ? parentCache : alias === 'cacheDir' ? path.dirname(parentCache) : h.parentData);
    const before = h.protectedSnapshot();
    if (!alias.startsWith('cache')) assert.throws(() => h.p.ensureDirs(), READ_ONLY);
    // AVD 别名阻止 AVD 创建；其余别名专门验证 cache 路径不能写穿。独立 cache 不依赖 AVD。
    if (alias !== 'avdDir') {
      h.p.envCacheSet(h.paths.emulatorExe, { version: 'must not be written' });
      assert.equal(h.p.envCacheGet(h.paths.emulatorExe), null);
      h.p.invalidateEnvCache();
    }
    assert.equal(h.disk.writes.length, 0);
    assert.deepEqual(h.protectedSnapshot(), before);
  });
}

test('实例父目录尚未由主流程准备时，不递归 mkdir 穿入父 data 创建 instances', () => {
  const h = harness({ ready: true });
  h.disk.nodes.delete(h.disk.key(h.context.instancesDir));
  const before = h.protectedSnapshot();
  assert.throws(() => h.p.ensureDirs(), READ_ONLY);
  h.p.envCacheSet(h.paths.emulatorExe, { version: 'not initialized' });
  h.p.invalidateEnvCache();
  assert.equal(h.disk.writes.length, 0);
  assert.deepEqual(h.protectedSnapshot(), before);
});

test('父 DATA_DIR 或父 AVD 的旧配置不能通过 ensureDirs/cache 修改父实例', () => {
  for (const mismatch of ['data', 'avd']) {
    const h = harness({ ready: true });
    if (mismatch === 'data') h.store.DATA_DIR = h.parentData;
    else h.settings.runtime.avdDir = path.join(h.parentData, 'avd');
    const before = h.protectedSnapshot();
    assert.throws(() => h.p.ensureDirs(), READ_ONLY);
    if (mismatch === 'data') {
      h.p.envCacheSet(h.paths.emulatorExe, { version: 'wrong data root' });
      assert.equal(h.p.envCacheGet(h.paths.emulatorExe), null);
      h.p.invalidateEnvCache();
    }
    assert.equal(h.disk.writes.length, 0);
    assert.deepEqual(h.protectedSnapshot(), before);
  }
});

test('共享 root 与本实例 data 重叠时 fail closed，不利用 recursive mkdir 改共享目录', () => {
  const h = harness({ ready: true });
  h.settings.runtime.dir = h.parentData;
  const before = h.protectedSnapshot();
  assert.throws(() => h.p.ensureDirs(), READ_ONLY);
  assert.equal(h.disk.writes.length, 0);
  assert.deepEqual(h.protectedSnapshot(), before);
});

test('共享 root 是指向父 data 的链接时，也按真实路径拒绝与本实例数据重叠', () => {
  const h = harness({ ready: true });
  h.disk.seedLink(h.sharedRoot, h.parentData);
  const before = h.protectedSnapshot();
  assert.throws(() => h.p.ensureDirs(), READ_ONLY);
  assert.equal(h.disk.writes.length, 0);
  assert.deepEqual(h.protectedSnapshot(), before);
});

test('已就绪的自定义镜像也只读返回，不要求再导入/展开基础镜像', async () => {
  const h = harness();
  h.p.systemImageInfo = () => ({ ok: true, custom: true, dir: path.join(h.sharedRoot, 'custom-images', 'fixture') });
  assert.equal(await h.p.materializeImages(forbidden), 0);
  assert.equal(h.disk.writes.length, 0);
});

test('启动后删改实例环境标识/伪造设置不能关闭已绑定的子实例守卫', async () => {
  const h = harness({ ready: true });
  delete h.fakeProcess.env.APKSTART_INSTANCE_ID;
  h.settings.runtime.isChild = false;
  await assert.rejects(h.p.installAdb(forbidden), READ_ONLY);
  assert.equal(h.disk.writes.length, 0);
});

test('上下文获取失败不能降级为主实例并继续维护', async () => {
  const h = harness({ ready: true, contextError: true });
  await assert.rejects(h.p.installAdb(forbidden), /context unavailable/);
  assert.equal(h.disk.writes.length, 0);
});

test('最终角色以 current().isChild 为准，存在标识但不是 child 不会误封主实例', async () => {
  const h = harness({ child: false, marker: true });
  h.disk.seedFile(h.paths.disk, 'INERT EXISTING QCOW', 2 * 1024 * 1024);
  const result = await h.p.createDisk();
  assert.equal(result.existed, true);
  assert(h.disk.writes.some((entry) => entry.file === h.sharedRoot));
});

test('主实例保留原有目录准备和组件补齐能力，不提前加载子实例上下文', () => {
  const h = harness({ child: false });
  h.p.ensureDirs();
  assert(h.disk.writes.some((entry) => entry.file === h.paths.tmp));
  assert(h.disk.writes.some((entry) => entry.file === h.paths.qemuDir));
  assert(!h.requires.includes('./instance-context'));
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) h.disk.seedFile(path.join(h.p.appRoot, 'tools', 'platform-tools', name));
  assert.equal(h.p.ensurePlatformTools(), true);
  h.disk.seedFile(h.paths.emulatorExe);
  h.disk.seedFile(path.join(h.p.appRoot, 'build', 'vendor', 'opengl32sw.dll'), 'INERT AVAILABLE DLL', 2 * 1024 * 1024);
  assert.equal(h.p.ensureSoftwareOpenGL(), true);
  assert(h.disk.writes.some((entry) => entry.op === 'copy' && entry.file === path.join(h.paths.emulatorDir, 'opengl32sw.dll')));
});

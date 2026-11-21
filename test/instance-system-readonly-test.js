'use strict';
// Production IPC/catalog/provider code with memory-only filesystem and transport.
const assert = require('node:assert/strict');
const realFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const core = path.join(root, 'src', 'core');
const mainSource = realFs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const ipcSource = mainSource.slice(mainSource.indexOf('// ---------------- IPC 安全边界'),
  mainSource.indexOf('// ---------------- 生命周期'));
const catalogData = {
  schema: 1, updatedAt: '2026-11-21T00:00:00Z', builtinSystems: [],
  systems: ['lineageos', 'bliss-os', 'android-x86'].map(id => ({ id, versions: [] })),
};
const inside = (base, file) => {
  const rel = path.win32.relative(base, file);
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.win32.sep) && !path.win32.isAbsolute(rel));
};

function harness(isChild) {
  const writes = [], nodes = new Map();
  const key = file => path.win32.resolve(String(file));
  const absent = file => Object.assign(new Error('ENOENT: ' + file), { code: 'ENOENT' });
  const fs = {
    readFileSync(file) {
      const node = nodes.get(key(file));
      if (!node || node.dir) throw absent(file);
      return node.text;
    },
    statSync(file) {
      const node = nodes.get(key(file));
      if (!node) throw absent(file);
      return { size: node.text?.length || 0, isDirectory: () => !!node.dir, isFile: () => !node.dir };
    },
    existsSync: file => nodes.has(key(file)), readdirSync: () => [],
    mkdirSync(file) { writes.push({ op: 'mkdir', file: key(file) }); nodes.set(key(file), { dir: true }); },
    writeFileSync(file, text) { writes.push({ op: 'write', file: key(file) }); nodes.set(key(file), { text: String(text) }); },
    renameSync(from, to) {
      writes.push({ op: 'rename', file: key(to) });
      nodes.set(key(to), nodes.get(key(from))); nodes.delete(key(from));
    },
  };
  const parentData = 'C:/fixture/appdata/apkstart';
  const runtimeRoot = 'C:/fixture/shared-runtime';
  const dataDir = isChild ? path.win32.join(parentData, 'instances', 'child-one') : parentData;
  const store = { isChild, DATA_DIR: dataDir,
    getSettings: () => ({ runtime: { dir: runtimeRoot, systemImageFlavor: 'google_apis_playstore' }, engine: { mode: 'builtin' } }),
  };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = realFs.readFileSync(file, 'utf8');
    function req(name) {
      if (name === 'fs') return fs;
      if (name === 'path') return path.win32;
      if (name === 'os') return { homedir: () => 'C:/fixture' };
      if (['crypto', 'util'].includes(name)) return require(name);
      if (['child_process', 'net'].includes(name)) return {};
      if (name === 'timers/promises') return { setTimeout: () => assert.fail('no timers needed') };
      const target = path.resolve(path.dirname(file), name);
      if (target === path.join(core, 'store')) return store;
      if (target === path.join(core, 'adb')) return { AdbClient: class {} };
      if (target === path.join(core, 'download')) return { openStream: () => assert.fail('network forbidden') };
      if (target === path.join(core, 'image-inspect')) throw new Error('not needed');
      assert.ok(name.startsWith('.'), 'unexpected dependency ' + name);
      return load(realFs.existsSync(target + '.js') ? target + '.js' : path.join(target, 'index.js'));
    }
    vm.compileFunction(code, ['require', 'module', 'process', '__dirname'], { filename: file + ' (VM only)' })(
      req, module, { platform: 'win32', env: { APPDATA: 'C:/fixture/appdata' } }, path.dirname(file));
    return module.exports;
  }
  const { SystemManager } = load(path.join(core, 'system-manager.js'));
  const { SystemCatalog } = load(path.join(core, 'system-catalog.js'));
  const catalogOptions = [];
  class FixtureCatalog extends SystemCatalog {
    constructor(options) { catalogOptions.push(options); super({ ...options, fetchJson: async () => catalogData }); }
  }
  const handlers = new Map();
  const mainFrame = { url: pathToFileURL(path.join(root, 'src', 'ui', 'index.html')).href };
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame, isDestroyed: () => false } };
  const context = vm.createContext({ __dirname: path.join(root, 'src'), path, console, store,
    ipcguard: require('../src/core/ipcguard'), instanceContext: { isChild },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), handleOnce: (channel, fn) => handlers.set(channel, fn) },
    channelMode: require('../src/core/runtime-actions').channelMode,
    runtimeActions: { run: (_channel, action) => action() }, currentSystemStatus: null,
    mainWindow, appWin: { isOpen: false }, automation: null, createReportDelivery: () => ({}),
    require: name => { assert.equal(name, './core/doctor'); return {}; },
    APP_ROOT: 'C:/inert-product', SystemManager, SystemCatalog: FixtureCatalog,
    runtime: { provisioner: { paths: () => ({ root: runtimeRoot }), images: {} } }, appLog() {}, send() {},
  });
  vm.runInContext(ipcSource + '\nregisterIpc();', context);
  return { writes, dataDir, runtimeRoot, catalogOptions,
    invoke: (channel, payload) => handlers.get(channel)({ sender: mainWindow.webContents, senderFrame: mainFrame }, payload),
  };
}

for (const isChild of [true, false]) {
  for (const channel of ['system:list', 'system:detail', 'system:status', 'system:tasks', 'system:diskUsage']) {
    test(`${isChild ? 'child' : 'parent'} ${channel} keeps catalog/provider writes in the intended data namespace`, async () => {
      const h = harness(isChild);
      const result = await h.invoke(channel, channel === 'system:detail' ? 'android-x86' : undefined);
      assert.equal(result.ok, true, result.error);
      if (isChild) {
        assert.ok(h.writes.every(entry => inside(h.dataDir, entry.file)), `${channel}: foreign write`);
        assert.ok(h.writes.every(entry => !inside(h.runtimeRoot, entry.file)), `${channel}: shared runtime write`);
        assert.equal(path.win32.normalize(h.catalogOptions[0].dataDir), path.win32.join(h.dataDir, 'system-catalog'));
      } else {
        assert.equal(Object.hasOwn(h.catalogOptions[0], 'dataDir'), false, 'parent must retain its existing default');
        if (['system:list', 'system:detail'].includes(channel)) {
          assert.ok(h.writes.some(entry => inside(h.runtimeRoot, entry.file)), 'parent provider path changed');
        }
      }
    });
  }
}

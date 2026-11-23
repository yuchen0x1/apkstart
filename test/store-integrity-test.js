'use strict';
/** 持久化回归只使用独立临时数据目录，不读写用户配置或真实运行时。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-store-test-'));
process.env.APPDATA = root;
process.env.XDG_DATA_HOME = root;
const store = require('../src/core/store');
const settingsFile = path.join(store.DATA_DIR, 'settings.json');
const appsFile = path.join(store.DATA_DIR, 'apps.json');
after(() => fs.rmSync(root, { recursive: true, force: true }));

function reset() {
  fs.rmSync(store.DATA_DIR, { recursive: true, force: true });
  store.ensureDirs();
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function denied() { return Object.assign(new Error('fixture access denied'), { code: 'EACCES' }); }

test('BOM、旧配置、资源策略与清单格式保持兼容', () => {
  reset();
  fs.writeFileSync(settingsFile, '\uFEFF' + JSON.stringify({
    theme: 'dark', runtime: { avdDir: 'custom-avd', systemImageFlavor: 'google_apis', compatImage: true },
    engine: { memoryMB: 4096 }, autoStart: true,
  }));
  const settings = store.getSettings();
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.runtime.avdDir, 'custom-avd');
  assert.equal(settings.runtime.systemImageFlavor, 'google_apis_playstore');
  assert.equal(settings.engine.memoryMB, 4096);
  assert.equal(settings.engine.microphone, true, '旧配置缺少 microphone 时默认应开启');
  assert.equal(settings.autoStart, true);
  assert.equal(store.saveSettings({ engine: { resourceMode: 'save' } }).engine.renderSize, '540x960');
  const app = { package: 'com.example.app', name: '保留名称', extraMetadata: { a: 1 } };
  store.upsertApp(app);
  assert.deepEqual(store.getApp(app.package), app);
  assert.deepEqual(JSON.parse(fs.readFileSync(appsFile)), { apps: [app] });
});

test('麦克风开关可持久化，且非法类型不会覆盖默认值', () => {
  reset();
  assert.equal(store.getSettings().engine.microphone, true);
  assert.equal(store.saveSettings({ engine: { microphone: false } }).engine.microphone, false);
  assert.equal(store.saveSettings({ engine: { microphone: 'off' } }).engine.microphone, false);
  assert.equal(store.saveSettings({ engine: { microphone: true } }).engine.microphone, true);
});

test('错误的设置分区/叶值回退默认，合法同级值保留', () => {
  reset();
  write(settingsFile, { engine: null, runtime: [], display: 'broken', update: false, theme: 'dark',
    guest: { groups: ['optional'], locale: 123 }, autoStart: 'false' });
  const settings = store.getSettings();
  assert.equal(settings.engine.headless, false);
  assert.equal(settings.runtime.downloadConnections, 8);
  assert.equal(settings.display.mode, 'window');
  assert.equal(settings.update.autoUpdate, false);
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.autoStart, false);
  assert.equal(settings.guest.locale, 'zh-CN');
  assert.deepEqual(settings.guest.groups, ['optional']);
});

test('补丁不能改变设置类型或注入继承键', () => {
  reset();
  store.saveSettings({ engine: { memoryMB: 3072 }, runtime: { dir: 'keep-me' }, autoStart: true });
  const patch = JSON.parse('{"__proto__":{"storeMarker":true},"constructor":{"prototype":{"storeMarker":true}},"engine":null,"runtime":{"dir":false,"downloadConnections":null},"guest":{"groups":"wrong"},"autoStart":{},"unknown":1}');
  const result = store.saveSettings(patch);
  assert.equal(result.engine.memoryMB, 3072);
  assert.equal(result.runtime.dir, 'keep-me');
  assert.equal(result.runtime.downloadConnections, 8);
  assert.equal(result.autoStart, true);
  assert.deepEqual(result.guest.groups, []);
  const persisted = JSON.parse(fs.readFileSync(settingsFile));
  for (const key of ['__proto__', 'constructor', 'unknown']) assert.equal(Object.hasOwn(persisted, key), false);
  assert.equal(Object.prototype.storeMarker, undefined);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('读取结果与补丁数组不共享默认对象或调用者引用', () => {
  reset();
  const first = store.getSettings();
  first.runtime.dir = 'not-saved';
  first.guest.groups.push('not-saved');
  assert.equal(store.getSettings().runtime.dir, '');
  assert.deepEqual(store.getSettings().guest.groups, []);
  assert.equal(store.DEFAULT_SETTINGS.runtime.dir, '');
  assert.deepEqual(store.DEFAULT_SETTINGS.guest.groups, []);
  const groups = ['one'];
  const saved = store.saveSettings({ guest: { groups } });
  groups.push('two');
  assert.deepEqual(saved.guest.groups, ['one']);
});

test('非法 JSON/顶层设置保留唯一恢复副本，下一次保存不覆盖副本', () => {
  reset();
  for (const text of ['{broken', 'null', '[]']) {
    fs.writeFileSync(settingsFile, text);
    assert.equal(store.getSettings().theme, 'system');
    const backups = fs.readdirSync(store.DATA_DIR).filter((name) => name.startsWith('settings.json.bak-'));
    assert.ok(backups.some((name) => fs.readFileSync(path.join(store.DATA_DIR, name), 'utf8') === text));
  }
  assert.equal(fs.readdirSync(store.DATA_DIR).filter((name) => name.startsWith('settings.json.bak-')).length, 3);
  store.saveSettings({ theme: 'light' });
  assert.equal(store.getSettings().theme, 'light');
});

test('异常清单保留原始内容，不把 null 或无效记录当成正常清单', () => {
  reset();
  for (const value of [null, [], { apps: null }, { apps: [null] }, { apps: [{}] }]) {
    write(appsFile, value);
    assert.deepEqual(store.getApps(), []);
    const backups = fs.readdirSync(store.DATA_DIR).filter((name) => name.startsWith('apps.json.bak-'));
    assert.ok(backups.some((name) => fs.readFileSync(path.join(store.DATA_DIR, name), 'utf8') === JSON.stringify(value)));
  }
});

test('混合损坏清单备份原文并保留健康记录，重复读取不再生成备份', () => {
  reset();
  const app = { package: 'com.example.healthy', name: '不能消失', metadata: { keep: true } };
  const original = JSON.stringify({ apps: [null, app, {}], futureMetadata: 123 });
  fs.writeFileSync(appsFile, original);
  assert.deepEqual(store.getApps(), [app]);
  assert.deepEqual(store.getApps(), [app]);
  assert.deepEqual(JSON.parse(fs.readFileSync(appsFile)), { apps: [app], futureMetadata: 123 });
  const backups = fs.readdirSync(store.DATA_DIR).filter((name) => name.startsWith('apps.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(store.DATA_DIR, backups[0]), 'utf8'), original);
});

for (const method of ['copyFileSync', 'renameSync']) {
  test(`清单恢复 ${method} 失败不改写原文件`, (t) => {
    reset();
    const original = JSON.stringify({ apps: [null, { package: 'com.example.healthy' }] });
    fs.writeFileSync(appsFile, original);
    const mock = t.mock.method(fs, method, () => { throw denied(); });
    assert.throws(() => store.getApps(), { code: 'EACCES' });
    mock.mock.restore();
    assert.equal(fs.readFileSync(appsFile, 'utf8'), original);
  });
}

test('读取权限错误直接报错，不能用默认配置覆盖原文件', (t) => {
  reset();
  const original = JSON.stringify({ theme: 'dark' });
  fs.writeFileSync(settingsFile, original);
  const read = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === settingsFile) throw denied();
    return read.call(this, file, ...args);
  });
  assert.throws(() => store.saveSettings({ autoStart: true }), { code: 'EACCES' });
  mock.mock.restore();
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
});

test('损坏配置备份失败时拒绝继续保存，而不是吞错后覆写', (t) => {
  reset();
  fs.writeFileSync(settingsFile, '{broken');
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', function (from, to) {
    if (from === settingsFile) throw denied();
    return rename.call(this, from, to);
  });
  assert.throws(() => store.saveSettings({ theme: 'light' }), { code: 'EACCES' });
  mock.mock.restore();
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{broken');
});

test('原子保存不跟随旧 .tmp 链接，失败不破坏当前配置', (t) => {
  reset();
  store.saveSettings({ theme: 'dark' });
  const original = fs.readFileSync(settingsFile, 'utf8');
  const sentinel = path.join(root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep');
  fs.linkSync(sentinel, settingsFile + '.tmp');
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === settingsFile) throw denied();
    return rename.call(this, from, to);
  });
  assert.throws(() => store.saveSettings({ theme: 'light' }), { code: 'EACCES' });
  mock.mock.restore();
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(store.DATA_DIR).filter((name) => name.endsWith('.tmp')), ['settings.json.tmp']);
  store.saveSettings({ theme: 'light' });
  assert.equal(store.getSettings().theme, 'light');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

for (const method of ['writeFileSync', 'fsyncSync', 'closeSync']) {
  test(`${method} 失败保留旧清单，关闭句柄并清理本次暂存文件`, (t) => {
    reset();
    const app = { package: 'com.example.old', name: 'original' };
    store.saveApps([app]);
    const original = fs.readFileSync(appsFile, 'utf8');
    const operation = fs[method];
    let injected = false;
    const mock = t.mock.method(fs, method, function (...args) {
      if (!injected && typeof args[0] === 'number') {
        injected = true;
        throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
      }
      return operation.apply(this, args);
    });
    assert.throws(() => store.saveApps([{ package: 'com.example.new' }]), { code: 'EIO' });
    mock.mock.restore();
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(appsFile, 'utf8'), original);
    assert.deepEqual(store.getApps(), [app]);
    assert.deepEqual(fs.readdirSync(store.DATA_DIR).filter((name) => name.endsWith('.tmp')), []);
  });
}

test('拒绝非有限数、错误数组项及非对象补丁，不修改已保存值', () => {
  reset();
  store.saveSettings({ engine: { memoryMB: 4096 }, guest: { groups: ['keep'] } });
  for (const patch of [null, [], 'bad', { engine: { memoryMB: NaN }, guest: { groups: [null] } },
    { engine: { memoryMB: Infinity }, guest: { groups: [123] } }]) {
    const settings = store.saveSettings(patch);
    assert.equal(settings.engine.memoryMB, 4096);
    assert.deepEqual(settings.guest.groups, ['keep']);
  }
});

test('写入先独占创建、刷新并关闭暂存文件，再替换目标', (t) => {
  reset();
  const steps = [];
  let descriptor;
  for (const name of ['openSync', 'fsyncSync', 'closeSync', 'renameSync']) {
    const original = fs[name];
    t.mock.method(fs, name, function (...args) {
      if (name === 'openSync') {
        assert.equal(args[1], 'wx');
        assert.equal(args[2], 0o600);
        descriptor = original.apply(this, args);
        steps.push(name);
        return descriptor;
      }
      if ((name === 'fsyncSync' || name === 'closeSync') && args[0] === descriptor) steps.push(name);
      if (name === 'renameSync' && args[1] === settingsFile) steps.push(name);
      return original.apply(this, args);
    });
  }
  store.saveSettings({ theme: 'dark' });
  assert.deepEqual(steps, ['openSync', 'fsyncSync', 'closeSync', 'renameSync']);
});

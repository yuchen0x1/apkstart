'use strict';
/** 外观、原生标题栏及断线恢复回归：VM/内存夹具，不启动应用主进程。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-ui-theme-'));
process.env.APPDATA = TMP;
process.env.XDG_DATA_HOME = TMP;
const theme = require('../src/core/theme');
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('  ✓ ' + name); }
const tick = () => new Promise(r => setImmediate(r));
function renderer({ cached = null, dark = false, saveError = false } = {}) {
  const callbacks = {};
  const media = { matches: dark, addEventListener: (_event, cb) => { callbacks.media = cb; } };
  const select = { value: '', disabled: false, attrs: {}, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; }, addEventListener: (_event, cb) => { callbacks.change = cb; } };
  const root = { dataset: {}, style: {} };
  const doc = { documentElement: root, getElementById: id => id === 'setTheme' ? select : null, addEventListener: (_event, cb) => { callbacks.ready = cb; } };
  const saved = [], warnings = [];
  const api = { getSettings: async () => ({ theme: 'system' }), setSettings: async patch => { saved.push(patch); if (saveError) throw new Error('disk full'); return patch; }, on: (_event, cb) => { callbacks.changed = cb; } };
  const window = { matchMedia: () => media, apkstart: api, dispatchEvent: () => {}, toast: value => warnings.push(value) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/theme.js'), 'utf8'), {
    window, document: doc, localStorage: { getItem: () => cached, setItem: () => {} }, CustomEvent: class {}, console,
  });
  return { window, api, callbacks, media, select, root, saved, warnings };
}
(async () => {
  await test('仅接受system/light/dark，未知配置安全回落', () => {
    for (const pref of ['system','light','dark']) assert.strictEqual(theme.normalizePreference(pref), pref);
    for (const pref of ['',null,{},true,'auto','DARK']) assert.strictEqual(theme.normalizePreference(pref), 'system');
  });
  await test('原生窗口底色与标题栏同步，已销毁窗口不访问', () => {
    const changes = [];
    theme.updateWindow({ isDestroyed: () => false, setBackgroundColor: v => changes.push(v), setTitleBarOverlay: v => changes.push(v) }, true, {overlay:true});
    assert.strictEqual(changes[0], '#1b1f26');
    assert.strictEqual(changes[1].symbolColor, '#e9edf3');
    theme.updateWindow({ isDestroyed: () => true }, false);
    theme.updateWindow(null, false);
  });
  await test('非覆盖标题栏平台只更新背景，不调用Windows覆盖API', () => {
    let calls = 0;
    theme.updateWindow({isDestroyed:()=>false,setBackgroundColor:()=>{calls++;},setTitleBarOverlay:()=>{throw new Error('不得调用');}},false);
    assert.strictEqual(calls,1);
  });
  await test('主题配置纳入存储白名单，保存与重读都校验枚举', () => {
    const store = require('../src/core/store');
    assert.strictEqual(store.getSettings().theme,'system');
    for (const pref of ['dark','light','system']) {
      assert.strictEqual(store.saveSettings({theme:pref}).theme,pref);
      assert.strictEqual(store.getSettings().theme,pref);
    }
    assert.strictEqual(store.saveSettings({theme:'unsafe'}).theme,'system');
    store.saveSettings({theme:'dark',notASetting:'ignored'});
    assert.strictEqual(store.getSettings().notASetting,undefined);
  });
  await test('首帧缓存与系统深色初始化，不等待DOM或网络', () => {
    assert.strictEqual(renderer({cached:'dark'}).root.dataset.theme,'dark');
    assert.strictEqual(renderer({dark:true}).root.dataset.theme,'dark');
    assert.strictEqual(renderer({cached:'light',dark:true}).root.dataset.theme,'light');
  });
  await test('跟随系统实时更新，手动主题不被系统变化覆盖', () => {
    const r=renderer();
    r.media.matches=true; r.callbacks.media();
    assert.strictEqual(r.root.dataset.theme,'dark');
    r.window.apkTheme.apply('light'); r.callbacks.media();
    assert.strictEqual(r.root.dataset.theme,'light');
    r.window.apkTheme.apply('system');
    assert.strictEqual(r.root.style.colorScheme,'dark');
  });
  await test('保存外观通过既有API，等待时禁用控件，完成后恢复', async () => {
    const r=renderer();
    const promise=r.window.apkTheme.save('dark');
    assert(r.select.disabled);
    assert.strictEqual(r.select.attrs['aria-busy'],'true');
    await promise;
    assert.strictEqual(r.saved[0].theme,'dark');
    assert.strictEqual(r.window.apkTheme.preference,'dark');
    assert(!r.select.disabled);
    assert.strictEqual(r.select.attrs['aria-busy'],undefined);
  });
  await test('主题保存失败回滚且明确反馈，拒绝并发重复保存', async () => {
    const r=renderer({saveError:true});
    const promise=r.window.apkTheme.save('dark');
    await r.window.apkTheme.save('light');
    await promise;
    assert.strictEqual(r.saved.length,1);
    assert.strictEqual(r.window.apkTheme.preference,'system');
    assert.strictEqual(r.warnings[0].type,'error');
    assert(!r.select.disabled);
  });
  await test('跨窗口主题事件及重新打开设置保持当前偏好', async () => {
    const r=renderer(); r.callbacks.ready(); await tick();
    r.callbacks.changed({preference:'dark',resolved:'dark'});
    assert.strictEqual(r.root.dataset.theme,'dark');
    assert.strictEqual(r.select.value,'dark');
    r.select.value='light'; r.callbacks.change(); await tick();
    assert.strictEqual(r.window.apkTheme.preference,'light');
  });
  await test('迟到的初次设置读取不能覆盖用户刚切换的外观', async () => {
    const r=renderer(); let resolve;
    r.api.getSettings=()=>new Promise(done=>{resolve=done;});
    r.callbacks.ready();
    await r.window.apkTheme.save('dark');
    resolve({theme:'light'}); await tick();
    assert.strictEqual(r.window.apkTheme.preference,'dark');
    assert.strictEqual(r.root.dataset.theme,'dark');
  });
  await test('应用外壳ready/断线/ready竞态不遗留隐藏加载层', () => {
    const elements = {};
    for (const id of ['btnRotate','btnMin','btnMax','btnClose','appName','bootName','appIcon','bootIcon','bootTip','boot','stage']) elements[id]={textContent:'',src:'',hidden:false,attrs:{},classList:{on:new Set(),add(x){this.on.add(x);},remove(x){this.on.delete(x);}},setAttribute(k,v){this.attrs[k]=v;},addEventListener(){}};
    const timers=new Map(); let seq=0;
    const context={document:{getElementById:id=>elements[id],body:{style:{}}}, window:{apkstart:{shell:{onState(){},state:async()=>null},i18n:async()=>({})},addEventListener(){}},setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/shell.js'),'utf8'),context);
    vm.runInContext('applyState({ready:true,label:"Notes"}); applyState({ready:false,tip:"Reconnecting"})',context);
    assert.strictEqual(timers.size,0);
    assert.strictEqual(elements.boot.hidden,false);
    assert(!elements.boot.classList.on.has('out'));
    assert.strictEqual(elements.stage.attrs['aria-busy'],'true');
    vm.runInContext('applyState({ready:true})',context);
    for (const cb of timers.values()) cb();
    assert.strictEqual(elements.boot.hidden,true);
    vm.runInContext('applyState({ready:false})',context);
    assert.strictEqual(elements.boot.hidden,false);
  });
  await test('应用外壳初始快照迟到时不能覆盖更新的推送状态', async () => {
    for (const ready of [true,false]) {
      const elements = {};
      for (const id of ['btnRotate','btnMin','btnMax','btnClose','appName','bootName','appIcon','bootIcon','bootTip','boot','stage']) elements[id]={textContent:'',src:'',hidden:false,attrs:{},classList:{on:new Set(),add(x){this.on.add(x);},remove(x){this.on.delete(x);}},setAttribute(k,v){this.attrs[k]=v;},addEventListener(){}};
      let resolveInitial, push;
      const timers=new Map(); let seq=0;
      const context={document:{getElementById:id=>elements[id]},window:{apkstart:{shell:{onState:fn=>{push=fn;},state:()=>new Promise(resolve=>{resolveInitial=resolve;})},i18n:async()=>({})},addEventListener(){}},setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)};
      vm.createContext(context);
      vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/shell.js'),'utf8'),context);
      push({ready,label:'较新的推送'});
      for (const fn of timers.values()) fn();
      resolveInitial({ready:!ready,label:'迟到的旧快照'});
      await tick();
      assert.strictEqual(elements.appName.textContent,'较新的推送');
      assert.strictEqual(elements.stage.attrs['aria-busy'],String(!ready));
      assert.strictEqual(elements.boot.hidden,ready);
    }
  });
  console.log(`UI主题与窗口回归：${passed} 通过，0 失败`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(TMP,{recursive:true,force:true}));

'use strict';
/** UI 专用内存夹具。只读静态词典，不导入 engine/store/main，不接触用户文件、设备或网络。 */
function createFixture() {
  const calls = [];
  const english = require('../../src/i18n/en-US.json');
  const dictionaries = { 'en-US': english,
    'es-ES': { ...english, ...require('../../src/i18n/es-ES.json') },
    'vi-VN': { ...english, ...require('../../src/i18n/vi-VN.json') },
    'ru-RU': { ...english, ...require('../../src/i18n/ru-RU.json') } };
  const languages = [{ id: 'auto', label: '跟随系统' }, { id: 'zh-CN', label: '简体中文' },
    { id: 'en-US', label: 'English' }, { id: 'es-ES', label: 'Español' },
    { id: 'vi-VN', label: 'Tiếng Việt' }, { id: 'ru-RU', label: 'Русский' }];
  const instances = [];
  const automationTarget = { packageName: 'com.example.notes', serial: 'ui-fixture', instanceId: 'ui-session-1' };
  const platform = process.env.UI_AUDIT_PLATFORM || 'win32';
  const isWin = platform === 'win32';
  const path = require('path')[isWin ? 'win32' : 'posix'];
  const dataDir = isWin ? 'D:\\ApkStart' : '/home/ui-test/.local/share/apkstart';
  let imageGB = 24;
  let systemState = {
    current: { systemId: 'google-play', running: true, vmStarted: true, androidReady: true, serial: 'ui-fixture' },
    switching: false, stopping: false,
  };
  let settings = {
    theme: 'light', language: 'zh-CN', wizardDone: true, wizardVersion: '0.8.0',
    engine: { mode: 'builtin', idleShutdownMinutes: 15, resourceMode: 'balanced', gpuMode: 'auto', windowMode: 'auto', memoryMB: 4096, cores: 4, autoMemory: true, audio: true, fastDns: true, liteMode: true, keepSnapshot: true, prewarm: false, mouseRightBack: true, mouseWheelMode: 'smooth' },
    runtime: { dir: 'D:\\ApkStart\\runtime', avdDir: 'D:\\ApkStart\\avd', systemImageFlavor: 'google_apis_playstore', selectedSystemId: 'google-play', downloadConnections: 8, installMode: 'guided', systemInstallMode: 'guided', autoMirror: true },
    display: { mode: 'window', size: 'auto', portrait: true, scale: 1 },
    peripherals: { cameraBack: 'none', cameraFront: 'none', refreshRate: 60, serialPort: '' },
    update: { autoUpdate: false }, report: { auto: false, autoSend: false }, guest: { locale: 'zh-CN', groups: [] },
    sharedDir: 'D:\\ApkStartShared', deviceSharedDir: '/sdcard/ApkStartShared', device: '127.0.0.1:5555',
    autoConnect: true, createShortcutOnInstall: true, notifyOnInstall: true, autoStart: false,
  };
  if (!isWin) {
    settings.runtime.dir = '/home/ui-test/.local/share/apkstart/runtime';
    settings.runtime.avdDir = '/home/ui-test/.local/share/apkstart/avd';
    settings.sharedDir = '/home/ui-test/ApkStartShared';
  }
  const resolvedPaths = () => {
    const runtimeDir = settings.runtime.dir || path.join(dataDir, 'runtime');
    const relative = path.relative(dataDir, runtimeDir);
    const inside = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    return { runtimeDir, avdHome: settings.runtime.avdDir || path.join(inside ? runtimeDir : dataDir, 'avd') };
  };
  const apps = [
    { package: 'com.example.notes', label: '云端笔记', versionName: '1.2.0', pinned: true, running: true, accent: '#b45309', lastLaunchAt: 1700000000000 },
    { package: 'com.example.reader', label: '阅读空间 · 一本很长的书名与多语言 Notes', versionName: '3.0.1', pinned: false, running: false, accent: '#3d57a0' },
    { package: 'com.example.music', label: '音乐', versionName: '2.6', pinned: false, running: false, accent: '#6d489a' },
  ];
  const systems = [
    { id: 'google-play', name: 'Google Play', brand: 'Google', current: true, bootBackend: 'emulator', local: { running: true, installed: true, downloaded: true }, availability: { available: true }, versions: [{ version: '34', androidVersion: '14', androidApi: 34, architecture: 'x86_64', fileSize: 2 ** 30 }] },
    { id: 'android-x86', name: 'Android-x86', brand: 'Android-x86', current: false, bootBackend: 'qemu', local: { running: false, installed: false, downloaded: false }, availability: { available: true }, versions: [{ version: '9.0-r2', androidVersion: '9', architecture: 'x86_64', fileSize: 800 * 2 ** 20 }] },
    { id: 'bliss-os', name: 'Bliss OS', brand: 'Bliss', current: false, bootBackend: 'qemu', local: { running: false, installed: false, downloaded: false }, availability: { available: false, reason: '需要手动选择官方安装镜像' }, versions: [] },
  ];
  const tasks = [{ taskId: 'ui-download', systemId: 'android-x86', systemVersion: '9.0-r2', status: 'paused', progress: 42, downloadedBytes: 336 * 2 ** 20, totalBytes: 800 * 2 ** 20, speed: 0, eta: 60, currentStep: '已暂停，可继续下载', name: 'Android-x86' }];
  const merge = (base, patch) => {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch || {})) out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base[key] || {}, value) : value;
    return out;
  };
  const overrides = new Map();
  return {
    calls,
    setResponse(channel, respond) { overrides.set(channel, respond); },
    clearResponse(channel) { overrides.delete(channel); },
    setSystemState(patch) { systemState = merge(systemState, patch); },
    async respond(channel, payload) {
      calls.push({ channel, payload });
      if (overrides.has(channel)) return overrides.get(channel)(payload);
      switch (channel) {
        case 'app:i18n': return { lang: dictionaries[settings.language] ? settings.language : 'zh-CN', dict: dictionaries[settings.language] || {}, languages };
        case 'instances:list': return instances;
        case 'instances:create': {
          const item = { id: `00000000-0000-4000-8000-${String(instances.length + 1).padStart(12, '0')}`, name: payload?.name || '测试分身', running: false };
          instances.push(item); return { ok: true, ...item };
        }
        case 'instances:launch': {
          const item = instances.find(value => value.id === payload?.id);
          if (!item) return { ok: false, error: '分身不存在' };
          item.running = true; return { ok: true, id: item.id };
        }
        case 'peripherals:webcams': return { ok: true, devices: [{ id: 'webcam0', name: 'Fixture camera' }] };
        case 'peripherals:refresh': return { ok: true, status: Number(settings.peripherals.refreshRate) === 60 ? 'confirmed' : 'mismatch', activeRate: 60, modes: [{ id: 1, rate: 60 }] };
        case 'automation:target': return { ok: true, target: automationTarget };
        case 'automation:status': return { ok: true, running: false, status: 'idle', target: automationTarget };
        case 'automation:validate': return { ok: true, script: payload?.script };
        case 'automation:run': return { ok: true, status: 'completed', completed: payload?.script?.actions?.length || 0, target: automationTarget };
        case 'automation:action': return { ok: true, status: 'completed', completed: 1, target: automationTarget };
        case 'automation:cancel': return { ok: true, status: 'cancelled' };
        case 'app:theme': return { theme: settings.theme };
        case 'app:info': return { version: '0.8.0', name: 'ApkStart', platform: { platform, canEmbed:isWin, canIntegrateShell:isWin, canProvision:true, support:isWin?'full':'external', acceleration:{kind:isWin?'whpx':'kvm',ok:true} }, dataDir, ...resolvedPaths(), sharedDir: settings.sharedDir };
        case 'settings:get': return settings;
        case 'settings:set': settings = merge(settings, payload); return settings;
        case 'apps:list': return apps;
        case 'runtime:status': return { env: { adb: {ok:true}, emulator: {ok:true}, sysimg: {ok:true}, accel: {ok:true,kind:isWin?'whpx':'kvm'} }, adbOk: true, deviceOnline: true, android: '14', serial: 'ui-fixture', installed: true, freeform: true, vmRunning: true, mode: 'builtin' };
        case 'android:status': return { ok: true, sdk: 34, wifi: true, airplane: false, animationsOff: false, volume: 60, fontScale: 1, density: 320, brightness: 70 };
        case 'android:permissions': return { ok: true, permissions: [{ name: 'android.permission.CAMERA', granted: false, label: '相机' }] };
        case 'runtime:dataInfo': return { imageGB, freeDiskMB: 64000, avdDir: path.join(resolvedPaths().avdHome, 'apkstart.avd') };
        case 'runtime:setDataSize': {
          const gb = Number(payload);
          if (!Number.isSafeInteger(gb) || gb < 0 || gb > 64 || (gb && gb < imageGB)) return { ok:false, error:'UI 夹具：容量无效或不能缩小现有数据分区' };
          if (gb) imageGB = gb;
          settings = merge(settings, { engine: { dataPartitionGB: gb } });
          return { ok:true, imageGB, auto:gb === 0 };
        }
        case 'runtime:usage': return { total: 8.2 * 2 ** 30, totalText: '8.2 GB', reclaimable: 540 * 2 ** 20, reclaimableText: '540 MB', count: 2 };
        case 'assoc:status': return { registered: false };
        case 'provision:check': return { adb: true, emulator: true, sysimg: true, allReady: true, ready: true, paths: { root: settings.runtime.dir }, components: [] };
        case 'provision:accelStatus': return { ok: true, available: true, whpx: true, accel:{ok:true,kind:isWin?'whpx':'kvm'} };
        case 'runtime:vcRedist': return { installed: true, ok: true };
        case 'runtime:log': return 'UI 夹具：未启动模拟器，未访问网络。\nAndroid 运行时状态仅用于渲染测试。';
        case 'doctor:profile': return { text: '自动 · 4 GB / 4 核', profile: { host: { totalMB: 16384, freeMB: 9500, cores: 8 } }, memoryMB: 4096, cores: 4, renderSize: '720x1280', accel: 'WHPX', recommended: {} };
        case 'doctor:selfCheck': return { ok: true, issues: [], checks: [{ name: 'UI 隔离测试', ok: true, detail: '未操作真实运行时' }] };
        case 'sys:drives': return { drives: [{ drive: 'C:', free: 32 * 2 ** 30, total: 256 * 2 ** 30 }, { drive: 'D:', free: 128 * 2 ** 30, total: 512 * 2 ** 30 }], recommended: 'D:', systemDrive: 'C:' };
        case 'image:status': return { ok: true, selectedFlavor:'google_apis_playstore', defaultImage:{id:'google_apis_playstore',ok:true,label:'Android 14 · Google Play',playStore:true,gms:true,avd:'apkstart.avd'}, items:[{id:'fixture',name:'测试 AVD 镜像',api:34,abi:'x86_64',state:'ok'}], images: [], active: null, activeId: '', default: true };
        case 'system:list': return {
          ok: true, currentSystemId: systemState.current.systemId,
          systems: systems.map(s => ({ ...s, current: s.id === systemState.current.systemId,
            local: { ...s.local, running: s.id === systemState.current.systemId && !!systemState.current.running } })),
          catalogInfo: { source: 'built-in' }, pathWarnings: [],
        };
        case 'system:detail': return { ok: true, detail: { ...(systems.find(s => s.id === payload) || systems[0]), logs: [] } };
        case 'system:tasks': return { ok: true, tasks };
        case 'system:resume': case 'system:retry': return { ok: true, taskId: payload };
        case 'system:status': return { ok: true, ...systemState, tasks: tasks.slice(0, 10) };
        case 'system:stop':
          systemState = { ...systemState, switching: false, stopping: false,
            current: { ...systemState.current, running: false, vmStarted: false, androidReady: false, stopped: true } };
          return { ok: true, running: false };
        case 'system:diskUsage': return { ok: true, totalText: '8.2 GB', systems: [] };
        case 'guest:state': return { ok: true, online: true, desired:'zh-CN', live:{localeChinese:true,locale:'zh-CN',groups:[{id:'demo',label:'示例预装应用',note:'仅用于界面测试',total:3,remaining:3}]}, locale: 'zh-CN', groups: [] };
        case 'display:state': return { ok: true, mode: 'window', size: '720x1280', portrait: true, width: 720, height: 1280 };
        case 'app:updateCheck': return { ok: true, available: false, current: '0.8.0', latest: '0.8.0' };
        case 'app:confirm': return false;
        case 'apk:pick': case 'dialog:openDir': return null;
        case 'shell:state': return { label:'云端笔记', tip:'正在启动安卓运行时…', title: '云端笔记', package: 'com.example.notes', portrait: true, loading: true, ready: false };
        case 'runtime:repairPlan': return {
          code: 'TIMEOUT', level: 'slow', title: '运行环境需要调整', headline: '纯软件模拟启动较慢，可以保留应用数据并调整运行参数。',
          why: ['没有可用的硬件加速时，首次启动可能需要更久。', '不会自动删除应用数据或切换系统镜像。'],
          checks: [{ label: '处理器', value: '4 核', state: 'ok' }, { label: '内存', value: '8 GB（可用 3 GB）', state: 'warn' }, { label: '硬件加速', value: '不可用（纯软件模拟）', state: 'warn' }, { label: '系统镜像', value: 'Android 14', state: 'ok' }],
          actions: [{ id: 'low-spec', label: '低配模式再试一次', kind: 'auto', hint: '540×960 / 2 核 / 2 GB，保留应用数据' }], retry: { lowspec: true }, canAutoFix: true,
          reportDraft: { file: 'D:\\ApkStart\\logs\\reports\\ui-test.md' },
        };
        default: return { ok: false, error: 'UI 隔离测试：此操作未连接真实后端', cancelled: true };
      }
    },
  };
}
module.exports = { createFixture };

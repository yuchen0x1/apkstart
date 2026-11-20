'use strict';
/**
 * 安装 / 启动 / 卸载 编排层
 * 把「解析 APK → 安装进运行时 → 落本地元数据 → 生成桌面快捷方式」串成一条流水线。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const filetype = require('./filetype');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');
const { shellQuote } = require('./adb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARM_ABIS = new Set(['armeabi', 'armeabi-v7a', 'arm64-v8a']);
const ANDROID_ABIS = new Set([...ARM_ABIS, 'x86', 'x86_64', 'mips', 'mips64', 'riscv64']);
const TRANSLATION_CRASH = /DoBadTrampoline|libndk_translation|libhoudini|\bhoudini\b/i;
const NATIVE_LOAD_FAILURE = /UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i;

/** 只有明确的 ARM ABI 才算 ARM-only；MIPS 等未知架构不能误诊为缺少转译层。 */
function isArmOnly(meta) {
  return !!(Array.isArray(meta && meta.abis) && meta.abis.length && meta.abis.every((a) => ARM_ABIS.has(a)));
}

/** 每次从运行中的客机取证，不缓存，也不把磁盘镜像标签当作旧快照的能力。 */
async function runtimeAbiEvidence(client) {
  const prop = async (key) => {
    try { return String(await client.shell(`getprop ${key}`, { timeout: 6000 }) || '').trim(); }
    catch (_) { return ''; }
  };
  const parse = (raw) => {
    const values = raw.split(',').map((a) => a.trim()).filter(Boolean);
    return values.length && values.every((a) => ANDROID_ABIS.has(a)) ? [...new Set(values)] : [];
  };
  const [abiList, nativeBridge] = await Promise.all([
    prop('ro.product.cpu.abilist'), prop('ro.dalvik.vm.native.bridge'),
  ]);
  let abis = parse(abiList);
  const abiListKnown = abis.length > 0;
  if (!abiListKnown) abis = parse(await prop('ro.product.cpu.abi'));
  return { abis, abiListKnown, nativeBridge: nativeBridge.replace(/[\r\n]/g, ' ').slice(0, 80) };
}

function missingArmAbi(meta, evidence) {
  // 旧版 cpu.abi 只报主 ABI，不能凭它排除次要 ABI / 转译支持；完整列表未知时让安装器裁决。
  return isArmOnly(meta) && evidence.abiListKnown
    && !meta.abis.some((a) => evidence.abis.includes(a));
}

function describeAbi(evidence) {
  return `运行中客机实际 ABI：${evidence.abis.join(', ') || '未能确认'}`
    + (evidence.abiListKnown ? '；' : '（完整 ABI 列表未能确认）；')
    + `native bridge 属性：${evidence.nativeBridge || '未能确认'}（属性不代表转译已可用）。`;
}

function abiMismatchError(meta, evidence, cause = null, launching = false) {
  const err = new Error(
    `${launching ? '启动' : '安装'}失败：应用原生库 ABI 与当前运行时不匹配`
    + `（安装包 ABI：${(meta && meta.abis || []).join(', ') || '未知'}）。`
    + describeAbi(evidence)
    + '请先保留应用数据冷启动，排除不兼容的旧快照；仍不匹配时，在设置中选择支持所需 ABI 的镜像（可复用已下载镜像）。'
    + '本次未自动下载或切换镜像，也未清空安卓数据。'
    + (launching ? '' : '（INSTALL_FAILED_NO_MATCHING_ABIS）'),
  );
  err.code = launching ? 'NEEDS_ARM_TRANSLATION' : 'NO_MATCHING_ABIS';
  err.abiEvidence = evidence;
  if (cause) err.cause = cause;
  return err;
}

/**
 * 拆分安装包（.apks / .xapk）：解出里面的分片 APK 到纯 ASCII 临时目录。
 * 用文件版 ZIP 读取器 + 流式落盘：拆分包动辄 2GB+，整包读内存会失败。
 * 返回 { meta, files, cleanup }；meta 来自带 AndroidManifest 的 base APK。
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('这个安装包里没有找到 APK 分片（可能不是 .apks/.xapk）');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // 单个分片也可能是几百 MB：流式解压，不经过 Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* 分片里没有清单 */ }
    }
    if (!meta) throw new Error('拆分包的 base APK 解析失败');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${safeFileName(pkg)}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}.lnk`);
  }

  /**
   * 桌面 + 开始菜单两份。
   * Windows 搜索索引的是「开始菜单 \ 程序」里的 .lnk，只放桌面会搜不到；
   * 有些机器的桌面被 OneDrive 重定向，开始菜单这份也保证入口不丢。
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // 放在独立子目录：既能被 Windows 搜索索引到，又不会覆盖同名第三方应用的快捷方式
      // （实测「红果免费短剧」在开始菜单里已被另一个桌面助手占用）
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}.lnk`));
    }
    return [...new Set(out)];
  }

  async install(filePath, onProgress = () => {}, { meta: cachedMeta = null } = {}) {
    onProgress({ stage: 'parse', message: '正在解析 APK…' });
    let meta = cachedMeta;
    let bundle = null;
    const kind = filetype.installKind(filePath);
    if (kind === 'apks' || kind === 'xapk') {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else if (!meta) {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `已识别 ${meta.label}（${meta.package}）`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    try {
      // 先准备运行时，再核对客机的实际 ABI。镜像元数据不能证明当前实例/快照带转译层。
      // 安装失败不能擅自换镜像、重灌应用或下载同一套镜像；先给出可核实的诊断。
      onProgress({ stage: 'runtime', message: '正在准备安卓运行时…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || '运行时不可用');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** 安装本体 + 落盘元数据 + 快捷方式；兼容性检查不自动切镜像或改用户数据。 */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    let existing = store.getApp(meta.package);
    const abiEvidence = isArmOnly(meta) ? await runtimeAbiEvidence(client) : null;
    if (abiEvidence && missingArmAbi(meta, abiEvidence)) throw abiMismatchError(meta, abiEvidence);
    // 装完之后旧 quickboot 快照里的磁盘状态就过期了，留着会导致「装好的应用重启后又不见了」
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }

    // 安装前磁盘预检（上游 f6a2a19）：几十 GB 的大包装到一半才报
    // INSTALL_INSUFFICIENT_STORAGE，用户看到的仍是一句干巴巴的「失败」。
    // 按「安装包 ×1.8 + 2GB」估算实际写入量（解压 + dexopt 膨胀），不足就提前拦下说明白。
    // 系统镜像下载早有同类预检（system-task-manager），APK 安装链路之前漏了。
    try {
      const apkBytes = bundle
        ? bundle.files.reduce((n, f) => n + (fs.statSync(f).size || 0), 0)
        : (fs.statSync(filePath).size || 0);
      if (apkBytes > 0) {
        const needBytes = Math.round(apkBytes * 1.8) + 2 * 1024 * 1024 * 1024;
        const df = await client.shell('df -k /data').catch(() => '');
        // df 输出：Filesystem 1K-blocks Used Available Use% Mounted on —— 取 Available 列
        const m = /\s(\d+)\s+\d+\s+(\d+)\s+\d+%\s+\/data\s*$/m.exec(String(df));
        if (m) {
          const availBytes = Number(m[2]) * 1024;
          if (availBytes > 0 && availBytes < needBytes) {
            throw new Error(`安装失败：安卓数据分区空间不足（安装包约 ${(apkBytes / 1073741824).toFixed(1)}GB，`
              + `预计需要 ${(needBytes / 1073741824).toFixed(1)}GB，/data 仅剩 ${(availBytes / 1073741824).toFixed(1)}GB）。`
              + ' INSTALL_FAILED_INSUFFICIENT_STORAGE');
          }
        }
      }
    } catch (e) {
      // 只有我们自己抛的「空间不足」才往外抛；df 拿不到这类工具性小问题直接放行，不挡安装
      if (/INSUFFICIENT_STORAGE/.test(String(e && e.message))) throw e;
    }

    onProgress({ stage: 'install', message: existing ? '正在更新应用…' : '正在安装应用…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      if (e.code === 'NO_MATCHING_ABIS' || /INSTALL_FAILED_NO_MATCHING_ABIS/.test(e.message || '')) {
        // 底层错误文案可能承诺了自动切换/重试；这里只有实际取证，没有安排这些动作。
        throw abiMismatchError(meta, abiEvidence || await runtimeAbiEvidence(client), e);
      }
      throw e;
    }
    this.runtime.touch();

    // 图标落盘。APK 图标大量是 WebP，nativeImage 解不了，交给渲染进程解码 +
    // 品牌占位图兜底，保证 .lnk 一定带图标（之前 icoPath 一直是 null）。
    // iconFallback 记录「真实图标解不出来、用了占位图」——这种要作为软警告告诉用户，
    // 否则桌面上只有一片绿色三角，用户会以为是 ApkStart 弄错了图标。
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
    } else if (meta.iconSvg) {
      // 矢量图标（adaptive-icon 全矢量，如抖音）：存成 .svg，UI 的 <img>
      // 走 Chromium 原生渲染。.ico 这边交给 decode 回调光栅化，失败落到品牌占位图。
      try {
        iconPath = store.svgIconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconSvg);
      } catch (_) { /* ignore */ }
    }
    if (meta.iconPng || meta.iconSvg) {
      try {
        const ico = await iconToIco(meta.iconPng || Buffer.from(meta.iconSvg), {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* 图标失败不影响安装 */ }
    }

    // 备份 APK，便于日后重装/找回
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // 启动入口以系统解析结果为准：APK 里解析到的「主 Activity」经常不是
    // 真正的 LAUNCHER 入口，直接用它启动会跳过应用的初始化页导致闪退。
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* 保留 APK 解析结果 */ }

    // 安装/图标解码期间用户可能刚改过显示偏好，落盘前重读，不能用旧记录盖回去。
    existing = store.getApp(meta.package) || existing;
    const app = {
      // 覆盖安装只更新 APK 元数据，保留 lcdPref、显示偏好及其他用户设置；
      // 返回给调用方/进度事件的记录也必须和 store 一致，不能仅依赖 upsert 合并。
      ...existing,
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      orientation: meta.orientation === 'landscape' || meta.orientation === 'portrait' ? meta.orientation : '',
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: '正在创建桌面快捷方式…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `快捷方式创建失败：${e.message}` });
      }
    }

    // 兼容性提示：只有 ARM 原生库时，x86 运行时需要转译层
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`此应用要求 Android ${meta.minSdk}+，高于当前运行时，可能无法正常运行。`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('应用图标无法解析（可能是特殊格式的自适应图标），快捷方式暂时使用占位图标。');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('应用图标（WebP）解码失败，快捷方式暂时使用占位图标。');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // 装应用时作废了旧快照，这里补排一次：空闲时把「已装好新应用」的状态存下来，
    // 否则下次开机要重新冷启动（20 多秒）。
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} 安装完成`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      description: `${app.label} — 由 ApkStart 运行`,
      cwd: this.ctx.cwd,
      // 每个应用一个 AUMID：任务栏上按应用分组，不会全挤到 ApkStart 里
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // 主路径全失败（自定义快捷方式目录不可写 / 被安全软件拦截）：
    // 退回桌面再试一次——桌面上有图标，用户才找得到应用。
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}.lnk`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || '创建快捷方式失败');
    // 开始菜单那份的路径也存下来，卸载时一起删
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** 补全缺失的快捷方式与图标：老版本只建了桌面那份，且 WebP 图标当时没转成功 */
  async ensureShortcuts() {
    const made = [];
    // 用户明确关掉「安装后自动创建」、且这个应用本来就没有任何入口时不要擅自补，
    // 否则开关关掉了也挡不住启动时被重建。
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* 图标补建失败不影响入口 */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // 图标刚补出来时，即使 .lnk 存在也要重建，让快捷方式换上真实应用图标
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* 单个失败不阻塞启动 */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    // 卸载不再强制开机：以前无条件 ensure()，为了删一个应用要先冷启动几十秒，
    // 用户在「还没开机」时点卸载，看到的是长时间的白等。
    // 运行时在跑就直接卸；没在跑就只清理本地元数据 / 快捷方式 / 图标，
    // 设备上的残留等下次开机后由 launcher 侧的「应用不存在」路径自然兜底。
    const online = await this.runtime.client().devices()
      .then((ds) => ds.some((d) => /^emulator-\d+$/.test(d.serial)))
      .catch(() => false);
    if (online) {
      await this.runtime.ensure().then((rt) => rt.ok && rt.client.uninstall(pkg)).catch(() => {});
    }
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, lcdOrientation = '' } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog, lcdOrientation });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || '运行时不可用');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    const abiEvidence = isArmOnly(app) ? await runtimeAbiEvidence(rt.client) : null;
    if (abiEvidence && missingArmAbi(app, abiEvidence)) {
      throw abiMismatchError(app, abiEvidence, null, true);
    }
    // 分辨率要在拉起应用之前改，避免 wm size 触发配置变更把刚启动的 Activity 重建
    if (beforeStart) await beforeStart(rt).catch((e) => onLog(`显示适配跳过：${e.message}`));
    // 拉起来之前先看一眼网络：**只等，不重启**。
    // 冷启动时 Wi-Fi 关联往往比 sys.boot_completed 晚几十秒，而短剧类应用一进去就拉
    // 首页数据，没网时首页渲染成整块黑底 —— 这就是「点同意并继续后一直黑屏」的真正原因。
    // 但启动路径上绝不能做破坏性动作（以前这里调过带冷启动重试的版本，结果 adb 设备
    // 在安装途中消失，直接变成「应用打不开」）：等不到就先启动，大不了页面稍后加载。
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      const net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`虚拟机网络就绪（${net.ip || ''}）`);
      } else {
        onLog('虚拟机网络还没就绪，先启动应用（联网页面可能稍后才加载出来）');
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // 应用可能还没装进当前运行时（镜像重建 / 清过数据 / 首次），直接拉起会报
    // "Invalid packageName"。先在本地缓存里把它装上再启动，这样「点开应用」永远能进，
    // 不用先手动装一遍——这正是「点击已安装应用直接进入系统」想要的体验。
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      const pkgs = await rt.client.shell(`pm list packages ${shellQuote(pkg)}`, { timeout: 8000 }).catch(() => '');
      if (!new RegExp(`package:${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pkgs)) {
        onLog('应用尚未安装，正在自动安装…');
        try {
          if (app.bundle) {
            const b = await parseBundle(app.apkPath);
            try { await rt.client.installMultiple(b.files); } finally { b.cleanup(); }
          } else {
            await rt.client.install(app.apkPath);
          }
        } catch (e) {
          if (e.code === 'NO_MATCHING_ABIS' || /INSTALL_FAILED_NO_MATCHING_ABIS/.test(e.message || '')) {
            throw abiMismatchError(app, abiEvidence || await runtimeAbiEvidence(rt.client), e);
          }
          onLog(`自动安装失败：${e.message}`);
        }
      }
    }
    // 观察一段时间并要求「连续存活 4 秒」才算启动成功。
    // 关键：进程"还没起来"和"起来过又没了"必须分开看。以前一看到 pidof 为空就判失败，
    // 结果大型应用（红果、抖音这种首启要十几秒的）在加载途中就被 force-stop 重启，
    // 反复三轮才勉强起来，用户感知就是"点了要等一分钟"。
    //
    // 观察窗口按机器能力给：没有硬件加速（纯 TCG）或已被自动降级的低配机上，
    // 抖音这种应用的进程可能要几十秒才出现，25 秒必然误判成"启动失败"。
    const prof = (this.runtime && this.runtime.emulator && this.runtime.emulator.profile) || null;
    const slowMachine = !!(prof && (prof.accelOk === false || prof.tuned));
    const aliveBudgetMs = slowMachine ? 45000 : 25000;
    let everSeen = false;
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < aliveBudgetMs) {
        // 先查再睡：常驻容器里热启动往往 1 秒内就能看到进程，
        // 先 sleep 1 秒等于把最快的那条路径硬生生拖慢一秒。
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${shellQuote(pkg)}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // 起来过又消失 = 真的崩了
        } else {
          seen = true;
          everSeen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // 一直没见过进程才算失败
    };
    try {
      // 先确保运行时权限齐备：安装时的 -g 在清过数据后可能失效，
      // 缺权限时应用会被系统授权框挡住，用户看到的就是「点了没反应/打不开」。
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      let cacheRetried = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // 授权框挡在最前面时，应用看起来就是「打不开」；先补授权再收掉弹窗
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // 转译/原生库错误先交给外层给出有证据的提示；清缓存并不能补齐 ABI，
          // 更不能在尚未决定下一步动作时声称正在切镜像或重试。
          if (e.code === 'APP_CRASHED') {
            if (!e.crash || TRANSLATION_CRASH.test(e.crash) || NATIVE_LOAD_FAILURE.test(e.crash)) throw e;
            if (!cacheRetried && attempt < 3) {
              cacheRetried = true;
              onLog('检测到应用启动异常，正在清理临时缓存并重试（不会删除个人数据）…');
              await rt.client.clearCache(pkg).catch(() => {});
              await sleep(700);
            } else {
              throw e;
            }
          }
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`应用启动后退出（第 ${attempt} 次），正在自动重试…`);
      }
      if (!ok) {
        // 兜底：异常退出会留下「半初始化」的数据，导致之后每次都崩。
        // 清一次应用数据再拉起来，成功率最高（用户不必自己去设置里清缓存）。
        //
        // 但**只有「进程真的起来过又死了」才算数据可疑**。如果进程从头到尾没出现过
        // （低配机 / 无硬件加速时抖音首启要几十秒），那只是慢，不是数据坏了 ——
        // 这时候 pm clear 会把登录态、草稿、离线缓存一起删掉，是最不该发生的事。
        if (!everSeen) {
          const err = new Error(
            `应用在 ${Math.round(aliveBudgetMs / 1000)} 秒内还没起来（机器较慢，首次启动尤其明显）。`
            + '已保留应用数据，稍后再点一次通常就能进。',
          );
          err.code = 'APP_SLOW';
          throw err;
        }
        onLog('应用连续退出，正在重置应用数据后重试…');
        await rt.client.shell(`pm clear ${shellQuote(pkg)}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear 会把运行时权限一并清掉，必须重新授，否则会卡在系统授权框
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('应用启动后立即退出，已自动重试并重置应用数据仍未成功');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      const crash = String(e.crash || '');
      const unplannedRetry = /(?:会自动|正在自动|已自动).*(?:切换|重试)/.test(e.message || '');
      if (e.code === 'APP_CRASHED' && (!crash || unplannedRetry || TRANSLATION_CRASH.test(crash) || NATIVE_LOAD_FAILURE.test(crash))) {
        const evidence = abiEvidence || await runtimeAbiEvidence(rt.client);
        const reason = TRANSLATION_CRASH.test(crash)
          ? '崩溃日志涉及 ARM 转译层，应用与当前运行时可能不兼容；尚不能确认切换镜像能否解决。'
          : NATIVE_LOAD_FAILURE.test(crash)
            ? '原生库加载失败，也可能是应用自身缺少依赖，不能据此断言缺少 ARM 转译层。'
            : '现有崩溃证据不足以确认 ARM 转译层故障，尚无已确定的安全镜像修复方案。';
        const err = new Error(
          `「${(app && app.label) || pkg}」启动失败：${reason}` + describeAbi(evidence)
          + '请检查崩溃日志及镜像兼容性；若实际 ABI 与所选镜像不符，可先保留数据冷启动以排除旧快照。'
          + '本次未自动下载或切换镜像，也未清空安卓数据。',
        );
        err.code = e.code;
        err.crash = e.crash;
        err.cause = e;
        err.abiEvidence = evidence;
        throw err;
      }
      throw e;
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };

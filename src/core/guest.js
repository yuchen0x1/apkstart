'use strict';
/**
 * 安卓客机（guest）的系统级设置：界面语言 + 预装应用精简 / 恢复。
 *
 * 语言这条路是真机实测出来的，绕了不少弯，记在这里免得以后又走回头路：
 *   官方 Google Play 镜像的 adbd 是 production build（ro.debuggable=0），实测：
 *     - `adb root`                        → adbd cannot run as root in production builds
 *     - `setprop persist.sys.locale zh-CN` → Failed to set property（SELinux 拦住）
 *     - 模拟器 `-prop persist.sys.locale`  → 日志明确拒绝：只支持 qemu.* 属性
 *   能用的只有一条：安卓 13+（API 33+）把「系统语言」存在 Settings.System 的
 *   system_locales 里，这个值**shell 用户就能写**：
 *       settings put system system_locales zh-CN
 *   而且它只在**开机**时被读取，所以必须重启一次安卓才会真正换成中文。
 *   重启后 `am get-config` 的输出会从 `en-rUS` 变成 `zh-rCN`，这也是本文件
 *   唯一的"到底有没有生效"判据（persist.sys.locale 可能一直是 en-US，不能拿它判断）。
 *
 * 精简走 `pm uninstall --user 0`：只对当前用户生效，系统分区不动，随时能
 * `cmd package install-existing` 装回来，同样不需要 root。
 */

/** 目标语言：只支持简体中文这一档，多语言选择对「能不能看懂」没有帮助 */
const LOCALE_TAG = 'zh-CN';

/**
 * 精简目录。
 * 包名不是拍脑袋写的：按 API 34 / google_apis_playstore 镜像上
 * `pm list packages -s` 的真实输出核对过，不存在的包在 trim 时会被跳过。
 * 分组方式和「会不会影响应用运行」严格分开：
 *   safe   —— 只是图标占位，删掉不影响任何东西
 *   danger —— 删掉可能让依赖 Google 登录/推送的应用报错
 */
const GROUPS = [
  {
    id: 'google_media',
    label: 'Google 影音与办公',
    note: 'YouTube、YouTube Music、Gmail、Chrome、地图、相册、云端硬盘、日历、Google 搜索',
    risk: 'safe',
    defaultOn: true,
    packages: [
      'com.google.android.youtube',
      'com.google.android.apps.youtube.music',
      'com.google.android.gm',
      'com.android.chrome',
      'com.google.android.apps.maps',
      'com.google.android.apps.photos',
      'com.google.android.apps.docs',
      'com.google.android.calendar',
      'com.google.android.googlequicksearchbox',
    ],
  },
  {
    id: 'google_extra',
    label: 'Google 其它预装',
    note: '数字健康、问题反馈、打印推荐、车机投影、健康连接、手写标注',
    risk: 'safe',
    defaultOn: true,
    packages: [
      'com.google.android.apps.wellbeing',
      'com.google.android.feedback',
      'com.google.android.printservice.recommendation',
      'com.google.android.projection.gearhead',
      'com.google.android.healthconnect.controller',
      'com.google.android.markup',
    ],
  },
  {
    id: 'aosp_extra',
    label: '放电脑上用不上的系统应用',
    note: '相机、时钟、音乐特效、动态壁纸、书签提供器、内置打印、屏保、系统跟踪、安卓彩蛋',
    risk: 'safe',
    defaultOn: true,
    packages: [
      'com.android.camera2',
      'com.google.android.deskclock',
      'com.android.musicfx',
      'com.android.wallpaper.livepicker',
      'com.android.bookmarkprovider',
      'com.android.providers.partnerbookmarks',
      'com.android.bips',
      'com.android.printspooler',
      'com.android.dreams.basic',
      'com.android.traceur',
      'com.android.egg',
    ],
  },
  {
    id: 'google_core',
    label: 'Play 商店与 Google 服务（不建议移除）',
    note: '移除后无法再从商店装应用，依赖 Google 登录 / 推送的应用会弹错',
    risk: 'danger',
    defaultOn: false,
    packages: [
      'com.android.vending',
      'com.google.android.gms',
      'com.google.android.gsf',
      'com.google.android.partnersetup',
      'com.google.android.configupdater',
    ],
  },
];

/** 任何情况下都不许动的包：删了会黑屏 / 起不来 */
const NEVER_TOUCH = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.phone',
  'com.google.android.dialer',
  'com.google.android.apps.messaging',
  'com.google.android.contacts',
  'com.google.android.inputmethod.latin',
  'com.android.inputmethod.pinyin', // 随包安装的谷歌拼音输入法（中文输入全靠它），不许精简
  'com.google.android.webview',
  'com.android.shell',
  'com.android.providers.settings',
  'com.android.server.telecom',
  'com.google.android.apps.nexuslauncher',
  'com.google.android.documentsui',
  'com.google.android.packageinstaller',
  'com.google.android.permissioncontroller',
];

/** 包名会拼进 adb shell 命令，只接受合法包名，防止清单被污染后注入 */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function isSafePackage(pkg) {
  const p = String(pkg || '').trim();
  return SAFE_PKG.test(p) && p.length <= 128;
}

/** 目录里所有可精简的包（去重、过滤掉 NEVER_TOUCH 与非法名） */
function catalogPackages() {
  const out = new Set();
  for (const g of GROUPS) {
    for (const p of g.packages) {
      if (!isSafePackage(p) || NEVER_TOUCH.includes(p)) continue;
      out.add(p);
    }
  }
  return [...out];
}

/**
 * 从 `am get-config` 的输出里取出当前系统语言（形如 `zh-rCN` / `en-rUS`）。
 * 这是判断「界面到底是不是中文」唯一靠得住的信号：
 * 语言真的切过去以后 `am get-config` 第一条就是 `config: zh-rCN-...`。
 */
function configLocale(text) {
  const m = /config:\s*([A-Za-z]{2,3}(?:-r[A-Z]{2})?)/.exec(String(text || ''));
  return m ? m[1] : '';
}

/** `am get-config` 里读到的语言是否就是目标语言（zh-CN ↔ zh-rCN） */
function localeActive(config, locale = LOCALE_TAG) {
  const want = String(locale || '').replace('-', '-r');
  const got = String(config || '').trim();
  if (!want || !got) return false;
  return got.toLowerCase() === want.toLowerCase();
}

/** 解析 `pm list packages` 输出（一行一个 package:xxx） */
function parsePackages(text) {
  const out = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^package:(\S+)\s*$/.exec(line.trim());
    if (m && isSafePackage(m[1])) out.add(m[1]);
  }
  return out;
}

/**
 * 生成一次精简计划（纯函数，可单测）。
 * @param {object} o
 * @param {Iterable<string>} o.installed 设备上「当前用户可见」的包
 * @param {Iterable<string>} o.present   设备上实际存在的包（含已对用户 0 移除的）
 * @param {string[]} o.groups            勾选的分组 id
 * @returns {{remove:string[], alreadyGone:string[], missing:string[], unknownGroups:string[]}}
 */
function buildTrimPlan({ installed = [], present = [], groups = [] } = {}) {
  const have = new Set(installed);
  const exist = new Set(present);
  const unknownGroups = [];
  const remove = [];
  const alreadyGone = [];
  const missing = [];
  const picked = new Set();
  for (const id of groups) {
    const g = GROUPS.find((x) => x.id === id);
    if (!g) { unknownGroups.push(id); continue; }
    for (const p of g.packages) {
      if (picked.has(p) || !isSafePackage(p) || NEVER_TOUCH.includes(p)) continue;
      picked.add(p);
      if (have.has(p)) remove.push(p);
      else if (exist.has(p)) alreadyGone.push(p);
      else missing.push(p);
    }
  }
  return { remove, alreadyGone, missing, unknownGroups };
}

/** 需要恢复的包：目录里存在、但当前用户看不见的那些 */
function buildRestorePlan({ installed = [], present = [] } = {}) {
  const have = new Set(installed);
  const exist = new Set(present);
  return catalogPackages().filter((p) => exist.has(p) && !have.has(p));
}

/**
 * 写入系统语言的命令。
 * 只有 `settings put system system_locales` 是可靠的（shell 可写、重启后系统会读它）；
 * 前面三行 setprop 在 root 镜像上是加分项，Play 镜像会被拒——失败不算错。
 */
function localeCommands(locale = LOCALE_TAG) {
  return [
    `setprop persist.sys.locale ${locale}`,
    'setprop persist.sys.language zh',
    'setprop persist.sys.country CN',
    `settings put system system_locales ${locale}`,
  ];
}

/* ---------------- 以下是需要 adb 客户端的部分 ---------------- */

async function readState(client) {
  const shell = (cmd, ms = 15000) => client.shell(cmd, { timeout: ms }).catch(() => '');
  const raw = await shell(
    'am get-config; echo ---; getprop persist.sys.locale; echo ---; '
    + 'settings get system system_locales; echo ---; pm list packages; echo ---; pm list packages -u',
    40000,
  );
  const [configRaw = '', localeProp = '', sysLocales = '', installedRaw = '', presentRaw = ''] = String(raw).split('---');
  const installed = parsePackages(installedRaw);
  const present = parsePackages(presentRaw);
  const trimmed = buildRestorePlan({ installed, present });
  // 界面真实语言只认 am get-config（persist.sys.locale 在 Play 镜像上一直是 en-US）
  const config = configLocale(configRaw);
  return {
    online: true,
    locale: config,
    localeTag: config.replace('-r', '-'),
    localeChinese: localeActive(config, LOCALE_TAG),
    persistLocale: localeProp.trim(),
    systemLocales: sysLocales.trim(),
    installedCount: installed.size,
    trimmed,
    groups: GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      note: g.note,
      risk: g.risk,
      defaultOn: !!g.defaultOn,
      total: g.packages.filter((p) => present.has(p)).length,
      remaining: g.packages.filter((p) => installed.has(p)).length,
    })),
  };
}

/**
 * 精简：逐包 `pm uninstall --user 0`。
 * 失败不中断（某些包被厂商保护），最后按实际结果回报，不谎报成功。
 */
async function trim(client, groups = []) {
  const installed = parsePackages(await client.shell('pm list packages', { timeout: 30000 }).catch(() => ''));
  const present = parsePackages(await client.shell('pm list packages -u', { timeout: 30000 }).catch(() => ''));
  const realPlan = buildTrimPlan({ installed, present, groups });
  const removed = [];
  const failed = [];
  for (const p of realPlan.remove) {
    /* eslint-disable no-await-in-loop */
    const out = String(await client.shell(`pm uninstall --user 0 ${p}`, { timeout: 30000 }).catch((e) => String(e && e.message)));
    if (/Success/i.test(out)) removed.push(p);
    else failed.push({ pkg: p, error: out.trim().slice(0, 160) });
  }
  return {
    removed,
    failed,
    alreadyGone: realPlan.alreadyGone,
    missing: realPlan.missing,
    unknownGroups: realPlan.unknownGroups,
  };
}

/** 恢复：把目录里被移除的预装应用装回来（不重装用户自己的应用） */
async function restore(client, packages = null) {
  const installed = parsePackages(await client.shell('pm list packages', { timeout: 30000 }).catch(() => ''));
  const present = parsePackages(await client.shell('pm list packages -u', { timeout: 30000 }).catch(() => ''));
  const wanted = Array.isArray(packages) && packages.length
    ? packages.filter(isSafePackage)
    : buildRestorePlan({ installed, present });
  const restored = [];
  const failed = [];
  for (const p of wanted) {
    /* eslint-disable no-await-in-loop */
    const out = String(await client.shell(`cmd package install-existing --user 0 ${p}`, { timeout: 30000 }).catch((e) => String(e && e.message)));
    if (/installed for user/i.test(out)) restored.push(p);
    else failed.push({ pkg: p, error: out.trim().slice(0, 160) });
  }
  return { restored, failed };
}

/**
 * 把语言写进系统设置（真正生效还要重启一次安卓，见 main.js 的 guest:localize）。
 * 只认 system_locales 是否写成功 —— setprop 在 Play 镜像上必然失败，不能当判据。
 */
async function applyLocale(client, locale = LOCALE_TAG) {
  const results = [];
  for (const cmd of localeCommands(locale)) {
    /* eslint-disable no-await-in-loop */
    const out = String(await client.shell(cmd, { timeout: 15000 }).catch((e) => String(e && e.message)));
    results.push({ cmd, ok: !/Failed|error|denied/i.test(out), out: out.trim().slice(0, 120) });
  }
  const setting = String(await client.shell('settings get system system_locales', { timeout: 10000 })
    .catch(() => '')).trim();
  const want = String(locale);
  const ok = setting.split(',').map((x) => x.trim()).includes(want);
  return { ok, setting, results, error: ok ? '' : `系统语言写入失败（当前值：${setting || '空'}）` };
}

/** 读当前客机语言：am get-config 才是界面真实语言，persist 属性不可靠 */
async function probeLocale(client, locale = LOCALE_TAG) {
  const [config, setting] = await Promise.all([
    client.shell('am get-config', { timeout: 15000 }).catch(() => ''),
    client.shell('settings get system system_locales', { timeout: 10000 }).catch(() => ''),
  ]);
  const cur = configLocale(config);
  return {
    active: localeActive(cur, locale),
    config: cur,
    setting: String(setting || '').trim(),
  };
}

module.exports = {
  LOCALE_TAG, GROUPS, NEVER_TOUCH,
  isSafePackage, catalogPackages, parsePackages,
  buildTrimPlan, buildRestorePlan, localeCommands,
  configLocale, localeActive, applyLocale, probeLocale,
  readState, trim, restore,
};

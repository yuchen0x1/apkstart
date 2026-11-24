'use strict';
/**
 * 纯 Node 单元测试（不依赖 Electron / adb / 网络）
 * 运行：npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('能解析自身所在项目的 package.json 压缩包结构', () => {
  // 用一个内存里构造的最小 zip（stored 模式）验证解析
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // 中央目录总大小
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // 中央目录偏移

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), '应能找到 hello.txt');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', '内容应一致');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('PNG 编码器输出合法签名与 IHDR', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'PNG 签名');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, '长度合理');
});
test('应用图标可按任意尺寸绘制', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `宽度应为 ${s}，实际 ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// 仅读取明确指定或仓库内的夹具，不隐式扫描用户 Documents。
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  （夹具：${fixture}）`);
  test('quickCheck 识别 PK 头', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('解析出包名 / 版本 / 启动 Activity', () => {
    assert(/^[\w.]+$/.test(meta.package), `包名异常: ${meta.package}`);
    assert(meta.versionName, '缺少 versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `启动 Activity 异常: ${meta.launchActivity}`);
  });
  test('解析出可用图标', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, '图标为空或过小');
    assert(meta.label, '应用名为空');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('AXML 根节点是 manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc 可解析', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, '应至少有一个 package');
    }
  });
} else {
  console.log('  （跳过：未找到 APK 夹具，可设置 APKSTART_TEST_APK）');
}

// 合成 APK 的构造器放在 test/lib/make-apk.js：真实夹具缺失时也能覆盖解析栈，
// 且 run-tests / auto-test 共用同一份（避免两处各写一套字节拼装）。
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[合成 APK：axml + apk 全链路]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('attrValue 的命名空间语义：传 null = 不限定，默认只认 android', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: '测试' },
      ],
    };
    // 非命名空间属性（如 package）必须传 null 才能取到；这是 parseApk 的关键前提
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package 需要 ns=null');
    assert(attrValue(node, 'package') === null, '默认只认 android 命名空间');
    assert(attrValue(node, 'label') === '测试', 'android 属性走默认命名空间');
    assert(attrValue(node, 'label', null) === '测试', 'ns=null 时应能找到 android 属性');
  });
}
{
  const tmp = path.join(os.tmpdir(), `apkstart-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('包名：manifest 上的 package 是非命名空间属性', () => {
      assert(meta.package === 'com.example.test', `实际 ${meta.package}`);
    });
    test('应用名 / 版本 / SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('启动 Activity 从 intent-filter 解析', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('ABI 目录与图标资源', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, '图标应是 PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, '文件大小应回填');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

/* ---------------- 必跑的 ARSC 资源引用（无外部 APK / Android SDK） ---------------- */
console.log('\n[合成 APK：resources.arsc 包身份与别名]');
{
  const strict = require('assert/strict');
  const { attr, children } = require('../src/core/axml');
  const LABEL = 0x7f010000;
  const ICON = 0x7f020000;
  const LABEL_ALIAS = 0x7f010001;
  const ICON_ALIAS = 0x7f020001;
  const OTHER_LABEL = 0x80010000;
  const OTHER_ICON = 0x80020000;
  const LABEL_TEXT = 'ARSC Fixture App';
  const ICON_PATH = 'res/mipmap-hdpi/ic_launcher.png';
  const OTHER_PATH = 'res/mipmap-mdpi/ic_other.png';
  const DECOY_PATH = 'res/drawable-xxxhdpi/app_icon_decoy.png';
  const resources = [{ id: LABEL, value: LABEL_TEXT }, { id: ICON, value: ICON_PATH }];
  const otherResources = [{ id: OTHER_LABEL, value: 'Other package' }, { id: OTHER_ICON, value: OTHER_PATH }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-arsc-'));
  let seq = 0;
  // 较大的 decoy 必须在引用失效时胜出，避免错误的 ZIP 启发式“碰巧”通过正例。
  function inspect(options = {}) {
    const bytes = buildApkBytes({
      abis: [], labelRef: LABEL, iconRef: ICON, resources, ...options,
      extraEntries: [
        { name: OTHER_PATH, data: drawAppIcon(48) },
        { name: DECOY_PATH, data: drawAppIcon(256) },
      ],
    });
    const file = path.join(dir, `resource-${++seq}.apk`);
    fs.writeFileSync(file, bytes);
    const zip = new ZipArchive(bytes);
    const app = children(parseAxml(zip.read('AndroidManifest.xml')), 'application')[0];
    // 同时直接构造生产 ResTable，不能把解析失败后被 parseApk 吞掉的异常当成成功。
    const table = zip.has('resources.arsc') ? new ResTable(zip.read('resources.arsc')) : null;
    return { zip, app, table, meta: parseApk(file) };
  }
  function expectMetadata(f, label = LABEL_TEXT, icon = ICON_PATH) {
    strict.equal(f.meta.package, 'com.example.test');
    strict.equal(f.meta.label, label);
    strict.equal(f.meta.iconFile, icon);
    strict.deepEqual(f.meta.iconPng, f.zip.read(icon));
  }
  try {
    test('ARSC：TYPE_REFERENCE 清单经 ZIP/AXML/ResTable 得到名称和指定图标，不取 decoy', () => {
      const f = inspect();
      strict.deepEqual(f.table.packages.map(p => p.id), [0x7f]);
      strict.ok(f.zip.read('resources.arsc').length > 100);
      strict.ok(f.zip.read(DECOY_PATH).length > f.zip.read(ICON_PATH).length);
      for (const [name, ref] of [['label', LABEL], ['icon', ICON]]) {
        const a = attr(f.app, name);
        strict.equal(a.dataType, 0x01);
        strict.equal(a.refId >>> 0, ref);
        strict.equal(a.typed, null);
      }
      strict.equal(f.table.resolve(LABEL, 'string'), LABEL_TEXT);
      strict.equal(f.table.resolve(ICON, 'file'), ICON_PATH);
      strict.equal(f.table.resolve(0x7f030000, 'string'), null, '缺失 type');
      strict.equal(f.table.resolve(0x7f010099, 'string'), null, '缺失 entry');
      expectMetadata(f);
      strict.notDeepEqual(f.meta.iconPng, f.zip.read(DECOY_PATH));
    });
    test('ARSC：同包 TYPE_REFERENCE 别名保留 label/icon 解析', () => {
      expectMetadata(inspect({ labelRef: LABEL_ALIAS, iconRef: ICON_ALIAS, resources: [
        ...resources, { id: LABEL_ALIAS, value: LABEL }, { id: ICON_ALIAS, value: ICON },
      ] }));
    });
    for (const pkgId of [0x01, 0x80]) {
      for (const [name, ref, prefer] of [['label', LABEL, 'string'], ['icon', ICON, 'file']]) {
        test(`ARSC：${name} 引用缺失包 0x${pkgId.toString(16)} 时不借用首包同号资源`, () => {
          const missing = ((pkgId << 24) | (ref & 0xffffff)) >>> 0;
          const f = inspect({ [`${name}Ref`]: missing });
          expectMetadata(f, name === 'label' ? 'Test' : LABEL_TEXT, name === 'icon' ? DECOY_PATH : ICON_PATH);
          strict.equal(f.table.resolve(missing, prefer), null);
        });
      }
    }
    for (const [name, alias, missing, prefer] of [
      ['label', LABEL_ALIAS, 0x01010000, 'string'], ['icon', ICON_ALIAS, 0x01020000, 'file'],
    ]) {
      test(`ARSC：${name} 别名指向缺失包时返回 null，不回借首包`, () => {
        const f = inspect({ labelRef: LABEL_ALIAS, iconRef: ICON_ALIAS, resources: [
          ...resources,
          { id: LABEL_ALIAS, value: name === 'label' ? missing : LABEL },
          { id: ICON_ALIAS, value: name === 'icon' ? missing : ICON },
        ] });
        expectMetadata(f, name === 'label' ? 'Test' : LABEL_TEXT, name === 'icon' ? DECOY_PATH : ICON_PATH);
        strict.equal(f.table.resolve(alias, prefer), null);
      });
    }
    test('ARSC：多包按实际 ID 选择非首包，高位 package ID 也可解析', () => {
      const both = [...otherResources, ...resources];
      const app = inspect({ resources: both });
      strict.deepEqual(app.table.packages.map(p => p.id), [0x80, 0x7f]);
      expectMetadata(app);
      expectMetadata(inspect({ resources: both, labelRef: OTHER_LABEL, iconRef: OTHER_ICON }), 'Other package', OTHER_PATH);
    });
    test('ARSC：静态跨包别名可解析确实存在的非首包', () => {
      expectMetadata(inspect({ labelRef: LABEL_ALIAS, iconRef: ICON_ALIAS, resources: [
        ...resources, ...otherResources,
        { id: LABEL_ALIAS, value: OTHER_LABEL }, { id: ICON_ALIAS, value: OTHER_ICON },
      ] }), 'Other package', OTHER_PATH);
    });
    test('ARSC：已有多个包也不能用首包代替缺失包，别名同样失败关闭', () => {
      const f = inspect({ labelRef: LABEL_ALIAS, iconRef: ICON_ALIAS, resources: [
        ...otherResources, ...resources,
        { id: LABEL_ALIAS, value: 0x01010000 }, { id: ICON_ALIAS, value: 0x01020000 },
      ] });
      expectMetadata(f, 'Test', DECOY_PATH);
      for (const [ref, prefer] of [[0x01010000, 'string'], [0x01020000, 'file'], [LABEL_ALIAS, 'string'], [ICON_ALIAS, 'file']]) {
        strict.equal(f.table.resolve(ref, prefer), null);
      }
    });
    test('ARSC 负控制：没有资源表时必须走名称/图标兜底', () => {
      const f = inspect({ resources: undefined });
      strict.equal(f.table, null);
      expectMetadata(f, 'Test', DECOY_PATH);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- 矢量图标（vector drawable → SVG） ---------------- */
console.log('\n[apk.js 矢量图标转 SVG]');
{
  const { vectorToSvg, composeAdaptiveIcon } = require('../src/core/apk');
  const AN = 'http://schemas.android.com/apk/res/android';
  const n = (name, attrs, children = []) => ({
    name,
    attrs: attrs.map(([k, typed]) => ({ ns: AN, name: k, typed, dataType: 4 })),
    children,
  });

  test('vector：viewport + path 颜色/描边转成合法 SVG', () => {
    const root = n('vector', [['viewportWidth', 108], ['viewportHeight', 108]], [
      n('path', [['fillColor', 0xff0b0b16], ['pathData', 'M0,0h108v108h-108z']]),
      n('path', [['fillColor', 0x80ff0000], ['fillAlpha', 0.5], ['pathData', 'M10,10 L50,50 Z']]),
    ]);
    const svg = vectorToSvg(root, null);
    assert(svg && svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), '应有 SVG 根');
    assert(svg.includes('viewBox="0 0 108 108"'), '应有 viewBox');
    assert(svg.includes('fill="#0b0b16"'), '不透明色直接输出');
    assert(svg.includes('fill-opacity="0.251"'), 'fillAlpha 与 alpha 相乘');
    assert(svg.includes('fill="#ff0000"'), '红色填充');
  });

  test('vector：group 变换与 clip-path 语义', () => {
    const root = n('vector', [['viewportWidth', 24], ['viewportHeight', 24]], [
      n('group', [['pivotX', 12], ['pivotY', 12], ['scaleX', 2], ['rotation', 45]], [
        n('clip-path', [['pathData', 'M2,2h20v20h-20z']]),
        n('path', [['fillColor', 0xff00ff00], ['pathData', 'M4,4h8v8h-8z']]),
      ]),
    ]);
    const svg = vectorToSvg(root, null);
    assert(svg && svg.includes('<clipPath id='), 'clip-path 应进 defs');
    assert(svg.includes('clip-path="url(#'), '后续兄弟节点应被裁剪');
    assert(svg.includes('translate(12 12) rotate(45) scale(2 1) translate(-12 -12)'), 'group 变换序列');
    assert(svg.includes('fill="#00ff00"'), '绿色填充');
  });

  test('vector：viewport 缺失 / 无内容时返回 null', () => {
    assert(vectorToSvg(n('vector', []), null) === null, '缺 viewport 应为 null');
    assert(vectorToSvg(n('vector', [['viewportWidth', 24], ['viewportHeight', 24]]), null) === null,
      '无子节点应为 null');
  });

  test('adaptive-icon 两层合成：svg 在下、位图 image data-uri 在上反之亦可', () => {
    const bg = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108"><path d="M0,0h108v108h-108z" fill="#123456"/></svg>' };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, 1, 2, 3, 4]);
    const svg = composeAdaptiveIcon([bg, { data: png }]);
    assert(svg && svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"'), '根元素 108 视口');
    assert(svg.includes('fill="#123456"'), '背景层内容被内联');
    assert(svg.includes('data:image/png;base64,'), '位图层转 data-uri');
    assert(svg.indexOf('<svg') === 0 && svg.lastIndexOf('<svg') === 0, '内层 svg 标签应被剥离，只留根');
  });

  test('adaptive-icon：两层都无效时返回 null，单层位图直接可用', () => {
    assert(composeAdaptiveIcon([null, null]) === null, '全空应为 null');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
    const only = composeAdaptiveIcon([null, { data: jpg }]);
    assert(only && only.includes('data:image/jpeg;base64,'), '仅位图也能合成');
  });
}

/* ---------------- 自动更新设置与更新日志 ---------------- */
console.log('[update]');
test('update.autoUpdate 默认开启自动下载与安装', () => {
  const { DEFAULT_SETTINGS } = require('../src/core/store');
  assert(DEFAULT_SETTINGS.update && DEFAULT_SETTINGS.update.autoUpdate === true,
    'update.autoUpdate 应默认为 true');
});
test('settings 写入白名单放行 update.autoUpdate', () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-set-'));
  // store 的 DATA_DIR 在首次 require 时确定，这里用子进程方式隔离验证
  // （注意 -e 模式没有 __dirname，store 路径要在父进程算好再注入）
  const { execFileSync } = require('child_process');
  const storePath = path.join(__dirname, '..', 'src', 'core', 'store.js');
  const script = [
    'const fs = require("fs");',
    'const path = require("path");',
    'process.env.APPDATA = ' + JSON.stringify(tmpAppData) + ';',
    'const store = require(' + JSON.stringify(storePath) + ');',
    'store.saveSettings({ update: { autoUpdate: false }, bogusKey: 1 });',
    // store 没有导出 SETTINGS_FILE，按其实现用 DATA_DIR 拼接
    'const settingsFile = path.join(store.DATA_DIR, "settings.json");',
    'const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));',
    'if (raw.update.autoUpdate !== false) throw new Error("autoUpdate 未写入");',
    'if ("bogusKey" in raw) throw new Error("未知键不应落盘");',
    'console.log("PASS");',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert(out.includes('PASS'), '子进程验证失败：' + out);
  fs.rmSync(tmpAppData, { recursive: true, force: true });
});
test('CHANGELOG.md 存在且覆盖当前版本', () => {
  const cl = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert(/## \[0\.3\.7\]/.test(cl), 'CHANGELOG 应包含 0.3.7 条目');
  // 发版后 [Unreleased] 会被转正成具体版本号，所以不能只认 Unreleased：
  // 断言「当前 package.json 的版本在 CHANGELOG 里有条目」，发版前后都成立。
  const ver = require('../package.json').version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert(new RegExp(`## \\[${ver}\\]`).test(cl),
    `CHANGELOG 应包含当前版本 ${ver} 的条目（或发版前保留 [Unreleased]）`);
});

/* ---------------- android.js：音量输出解析（#33 回归） ---------------- */
console.log('[android.js]');
const { parseVolumeGet } = require('../src/core/android');
test('media_session volume --get 输出解析出「当前/上限」', () => {
  assert(JSON.stringify(parseVolumeGet('volume: 8/15')) === '{"cur":8,"max":15}', '8/15 形式');
  assert(JSON.stringify(parseVolumeGet('Volume: 8 of 15 on stream 3')) === '{"cur":8,"max":15}', 'of 形式（后面的 stream 3 不参与）');
  assert(JSON.stringify(parseVolumeGet('15 (max 15)')) === '{"cur":15,"max":15}', '最大档');
});
test('旧 media 工具的报错 / 单数字 / 异常输出都解析为 null', () => {
  assert(parseVolumeGet('media: inaccessible or not found') === null, 'Android 11+ 报错必须回退 dumpsys');
  assert(parseVolumeGet('') === null, '空输出');
  assert(parseVolumeGet('5') === null, '只有一个数字无法判定上限');
  assert(parseVolumeGet('12 4') === null, '当前比上限还大 = 输出不像音量信息');
});
test('真机日志噪音不能当音量（滑杆被拽回 0% 的回归）', () => {
  // 真机（Android 11+）输出带 [V] 日志，第一行就有 stream=3。
  // 旧实现取「前两个整数」→ cur=3 / max=9 → 显示 33%，设置也落到 60% 档。
  const real = '[V] will control stream=3 (STREAM_MUSIC)\n'
    + '[V] will get volume\n'
    + '[V] Connecting to AudioService\n'
    + '[V] volume is 9 in range [0..15]';
  assert(JSON.stringify(parseVolumeGet(real)) === '{"cur":9,"max":15}', '真机输出应解析成 9/15');
  // status() 里整段被 tr 压成一行后的样子
  const oneLine = real.replace(/\n/g, ' ');
  assert(JSON.stringify(parseVolumeGet(oneLine)) === '{"cur":9,"max":15}', '压成一行后同样成立');
  // 只截到第一行（老实现 echo 的行为）时，宁可解析不出，也不能吐一个假音量
  assert(parseVolumeGet('[V] will control stream=3 (STREAM_MUSIC)') === null, '纯日志行必须为 null');
});
test('dumpsys audio 片段也能解析（media_session 不可用时回退）', () => {
  const block = '- STREAM_MUSIC: Muted: false Min: 0 Max: 15 Current: 11 (speaker): 11, 11 ';
  assert(JSON.stringify(parseVolumeGet(block)) === '{"cur":11,"max":15}', 'dumpsys Current/Max');
  const legacy = '- STREAM_MUSIC: Max: 15 streamVolume:11 ';
  assert(JSON.stringify(parseVolumeGet(legacy)) === '{"cur":11,"max":15}', 'dumpsys streamVolume');
  assert(parseVolumeGet('- STREAM_MUSIC: Muted: false') === null, '没有档位信息 = null，不能兜成 0');
});
test('音量百分比换算：0-15 档映射到 0-100', () => {
  const vg = parseVolumeGet('volume: 8/15');
  const percent = Math.round((vg.cur / vg.max) * 100);
  assert(percent === 53, `8/15 应约为 53%，得到 ${percent}`);
  const maxed = parseVolumeGet('volume: 15/15');
  assert(Math.round((maxed.cur / maxed.max) * 100) === 100, '满档应为 100%');
});
/* ---------------- filetype.js：安装包后缀判定 ---------------- */
console.log('[filetype.js]');
{
  const ft = require('../src/core/filetype');

  test('认标准后缀：.apk / .xapk / .apks（大小写不敏感）', () => {
    assert(ft.installKind('C:\\dl\\抖音.apk') === 'apk', '.apk');
    assert(ft.installKind('C:\\dl\\Game.XAPK') === 'xapk', '.XAPK');
    assert(ft.installKind('/home/u/a.apks') === 'apks', '.apks');
    assert(ft.isSingleApk('a.apk') && !ft.isSingleApk('a.xapk'), '.xapk 不是单 APK');
  });

  test('认下载残留后缀：a.apk.1 / a.apk.2（QQ、迅雷的同名策略）', () => {
    assert(ft.installKind('C:\\Users\\u\\Downloads\\抖音.apk.1') === 'apk', 'a.apk.1');
    assert(ft.installKind('a.apk.2') === 'apk', 'a.apk.2');
    assert(ft.installKind('a.APK.1') === 'apk', '大小写混合');
    assert(ft.installKind('a.xapk.1') === 'xapk', 'a.xapk.1');
    assert(ft.installKind('a.apks.3') === 'apks', 'a.apks.3');
    assert(ft.installKind('a.apk.12') === 'apk', '两位数字后缀');
  });

  test('认下载中的临时后缀：.tmp / .crdownload / .part', () => {
    assert(ft.installKind('a.apk.tmp') === 'apk', '.tmp');
    assert(ft.installKind('a.apk.crdownload') === 'apk', 'Chrome');
    assert(ft.installKind('a.apk.part') === 'apk', 'Firefox');
    assert(ft.installKind('a.apk.1.tmp') === 'apk', '两层叠加');
  });

  test('不误伤：其它后缀、无扩展名、改了名的备份都不算安装包', () => {
    for (const p of ['a.txt', 'a.zip', 'a.apk.bak', 'a.apk1', 'apk', '.apk', '', 'a.1']) {
      assert(!ft.isInstallable(p), `不应认成安装包：${JSON.stringify(p)}`);
    }
  });

  test('displayName 去掉残留后缀（界面上不该出现「抖音.apk.1」）', () => {
    assert(ft.displayName('C:\\dl\\抖音.apk.1') === '抖音.apk', '数字后缀');
    assert(ft.displayName('C:\\dl\\抖音.apk.1.tmp') === '抖音.apk', '两层');
    assert(ft.displayName('C:\\dl\\抖音.apk') === '抖音.apk', '本来就没有后缀');
  });
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);

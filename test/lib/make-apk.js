'use strict';
/**
 * 测试用「合成 APK」构造器（只给 test/ 用，不进产品代码）。
 *
 * 为什么需要它：真实 APK 夹具体积大、不便随仓库分发，缺失时 axml.js / apk.js
 * 在 CI 上等于零覆盖。这里用几十行字节拼出一个**合法的**二进制 AXML 清单 +
 * 最小 ZIP，让解析栈永远有可跑的用例。
 *
 * 默认生成的内容：
 *   <manifest package="com.example.test" android:versionCode="7" android:versionName="1.2.3">
 *     <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34"/>
 *     <application android:label="TestApp" android:icon="res/mipmap-hdpi/ic_launcher.png">
 *       <activity android:name=".Main">
 *         <intent-filter><action android:name="android.intent.action.MAIN"/>
 *           <category android:name="android.intent.category.LAUNCHER"/></intent-filter>
 *       </activity>
 *     </application>
 *   </manifest>
 *
 * buildApkBytes(opts) 可以改：minSdk / targetSdk / abis / permissions /
 * requiredFeatures / usesLibraries / split / debuggable，用来覆盖兼容性判定。
 */
const { drawAppIcon } = require('../../src/core/png');
const { crc32 } = require('../../src/core/zip');

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

function buildStringPool(strings) {
  const data = [];
  const offsets = [];
  let off = 0;
  for (const s of strings) {
    offsets.push(off);
    const chars = Buffer.from(s, 'utf16le');
    data.push(u16(s.length), chars, u16(0));
    off += 2 + chars.length + 2;
  }
  const bodyLen = data.reduce((n, b) => n + b.length, 0);
  const stringsStart = 28 + offsets.length * 4;
  const chunkSize = stringsStart + bodyLen;
  const head = Buffer.concat([
    u16(0x0001), u16(28), u32(chunkSize),
    u32(strings.length), u32(0), u32(0),
    u32(stringsStart), u32(0),
  ]);
  return Buffer.concat([head, ...offsets.map(u32), ...data]);
}

function axmlChunk(type, headerSize, body) {
  return Buffer.concat([u16(type), u16(headerSize), u32(8 + body.length), body]);
}

/** attrs: [{ ns?: number, name, type?=0x03, data }] */
function axmlStartElement(nameIdx, attrs) {
  const attrBufs = attrs.map((a) => Buffer.concat([
    u32(a.ns === undefined ? 0xffffffff : a.ns),
    u32(a.name),
    u32(0xffffffff),
    // typedValue: size(2) res0(1) dataType(1) data(4)
    u16(8), Buffer.from([0]), Buffer.from([a.type === undefined ? 0x03 : a.type]), u32(a.data),
  ]));
  const ext = Buffer.concat([
    u32(0xffffffff), u32(nameIdx),
    u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0),
  ]);
  return axmlChunk(0x0102, 16, Buffer.concat([u32(0), u32(0), ext, ...attrBufs]));
}

function axmlEndElement(nsIdx, nameIdx) {
  return axmlChunk(0x0103, 16, Buffer.concat([u32(0), u32(0), u32(nsIdx), u32(nameIdx)]));
}

const DEFAULTS = {
  packageName: 'com.example.test',
  label: 'TestApp',
  versionCode: 7,
  versionName: '1.2.3',
  minSdk: 21,
  targetSdk: 34,
  icon: 'res/mipmap-hdpi/ic_launcher.png',
  split: '',
  debuggable: false,
  launchActivity: '.Main',
  permissions: [],
  /** [{ name, required }] */
  requiredFeatures: [],
  /** [{ name, required }] */
  usesLibraries: [],
  /** 直接控制 lib/<abi>/ 目录；null = 用默认 arm64-v8a */
  abis: null,
};

/**
 * 生成 AndroidManifest.xml 的二进制 AXML
 * 采用「先登记字符串、再产出 chunk」两段式，避免边写边算索引对不上。
 */
function buildManifestAxml(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const strings = [];
  const add = (s) => {
    const i = strings.indexOf(s);
    if (i >= 0) return i;
    strings.push(s);
    return strings.length - 1;
  };

  // ns=true → android 命名空间；ns=false → 无命名空间（如 package）
  const A = (name, value, extra = {}) => ({ name, value, ...extra });

  const root = {
    name: 'manifest',
    attrs: [
      { name: 'package', value: o.packageName, ns: false },
      { name: 'versionCode', value: o.versionCode, type: 0x10 },
      { name: 'versionName', value: o.versionName },
    ],
    children: [],
  };
  if (o.split) root.attrs.push({ name: 'split', value: o.split, ns: false });

  root.children.push({
    name: 'uses-sdk',
    attrs: [
      { name: 'minSdkVersion', value: o.minSdk, type: 0x10 },
      { name: 'targetSdkVersion', value: o.targetSdk, type: 0x10 },
    ],
    children: [],
  });

  for (const p of o.permissions) {
    root.children.push({ name: 'uses-permission', attrs: [A('name', p, { ns: false })], children: [] });
  }
  for (const f of o.requiredFeatures) {
    const item = typeof f === 'string' ? { name: f, required: true } : f;
    root.children.push({
      name: 'uses-feature',
      attrs: [
        A('name', item.name, { ns: false }),
        { name: 'required', value: item.required !== false, type: 0x12 },
      ],
      children: [],
    });
  }

  const app = {
    name: 'application',
    attrs: [A('label', o.label), A('icon', o.icon)],
    children: [],
  };
  if (o.debuggable) app.attrs.push({ name: 'debuggable', value: true, type: 0x12 });
  // 用于验证「仅在 Activity 未声明时回退」及 landscape=0 不被 falsy 吞掉。
  if (typeof o.appOrientation === 'number' || typeof o.appOrientation === 'string') {
    app.attrs.push(A('screenOrientation', o.appOrientation,
      typeof o.appOrientation === 'number' ? { type: 0x10 } : {}));
  }
  for (const l of o.usesLibraries) {
    const item = typeof l === 'string' ? { name: l, required: true } : l;
    app.children.push({
      name: 'uses-library',
      attrs: [
        A('name', item.name, { ns: false }),
        { name: 'required', value: item.required !== false, type: 0x12 },
      ],
      children: [],
    });
  }
  const activityAttrs = [A('name', o.launchActivity)];
  // screenOrientation：整数按 AXML 枚举（TYPE_INT_DEC）写，字符串按普通字符串写。
  // 两种都要覆盖 —— 真实 APK 里两种都见过，解析端得都能认。
  if (typeof o.orientation === 'number') {
    activityAttrs.push(A('screenOrientation', o.orientation, { type: 0x10 }));
  } else if (typeof o.orientation === 'string') {
    activityAttrs.push(A('screenOrientation', o.orientation));
  }
  app.children.push({
    name: 'activity',
    attrs: activityAttrs,
    children: [{
      name: 'intent-filter',
      attrs: [],
      children: [
        { name: 'action', attrs: [A('name', 'android.intent.action.MAIN')], children: [] },
        { name: 'category', attrs: [A('name', 'android.intent.category.LAUNCHER')], children: [] },
      ],
    }],
  });
  root.children.push(app);

  // 第一遍：把所有字符串登记进池子
  const register = (n) => {
    add(n.name);
    for (const a of n.attrs) {
      add(a.name);
      if (typeof a.value === 'string') add(a.value);
    }
    for (const c of n.children) register(c);
  };
  add('android');
  const nsIdx = add(ANDROID_NS);
  register(root);

  const pool = buildStringPool(strings);

  // 第二遍：索引已固定，产出 chunk
  const emit = (n) => {
    const attrs = n.attrs.map((a) => {
      const isStr = typeof a.value === 'string';
      return {
        ns: a.ns === false ? 0xffffffff : nsIdx,
        name: add(a.name),
        type: a.type === undefined ? (isStr ? 0x03 : 0x10) : a.type,
        data: isStr ? add(a.value) : (a.type === 0x12 ? (a.value ? 0xffffffff : 0) : a.value),
      };
    });
    return Buffer.concat([
      axmlStartElement(add(n.name), attrs),
      ...n.children.map(emit),
      axmlEndElement(0xffffffff, add(n.name)),
    ]);
  };

  const body = emit(root);
  const chunks = Buffer.concat([
    axmlChunk(0x0100, 16, Buffer.concat([u32(0), u32(0), u32(add('android')), u32(nsIdx)])),
    body,
    axmlChunk(0x0101, 16, Buffer.concat([u32(0), u32(0), u32(add('android')), u32(nsIdx)])),
  ]);

  // 注意：emit 里再 add 的都是已登记过的字符串，不会改变已有索引
  const all = Buffer.concat([pool, chunks]);
  // 最外层是 RES_XML_TYPE 文件头（8 字节头 + 总长度）
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + all.length), all]);
}

/** 最小 ZIP（stored，无压缩） */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const it of entries) {
    const name = Buffer.from(it.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    const crc = crc32(it.data);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(it.data.length, 18);
    lh.writeUInt32LE(it.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, it.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(it.data.length, 20);
    ch.writeUInt32LE(it.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += lh.length + name.length + it.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 一个可直接被 parseApk 解析的最小 APK 的字节 */
function buildApkBytes(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const png = drawAppIcon(96);
  const abis = o.abis === null ? ['arm64-v8a'] : o.abis;
  const entries = [
    { name: 'AndroidManifest.xml', data: buildManifestAxml(o) },
    { name: 'res/mipmap-hdpi/ic_launcher.png', data: png },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0') },
  ];
  for (const abi of abis) {
    entries.push({ name: `lib/${abi}/libtest.so`, data: Buffer.from('ELF-fake') });
  }
  return buildStoredZip(entries);
}

module.exports = {
  ANDROID_NS,
  DEFAULTS,
  buildManifestAxml,
  buildStoredZip,
  buildApkBytes,
};

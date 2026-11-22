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
 * labelRef / iconRef 写 TYPE_REFERENCE；resources 构造非空 ARSC，extraEntries 添加图标等条目。
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
    attrs: [
      o.labelRef === undefined ? A('label', o.label) : A('label', o.labelRef, { type: 0x01 }),
      o.iconRef === undefined ? A('icon', o.icon) : A('icon', o.iconRef, { type: 0x01 }),
    ],
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

/**
 * 按二进制格式构造最小 ResTable，不依赖 SDK/aapt 或第三方 APK。
 * resources: [{ id: 0xPPTTEEEE, value: string | number }]；数字值是 TYPE_REFERENCE 别名。
 * 每包独立的类型/键池、默认配置、typeSpec 和普通 32 位 entry offsets；包顺序按输入保留。
 */
function buildResTable(resources) {
  const strings = [];
  const packages = new Map();
  for (const { id, value } of resources) {
    const pkgId = id >>> 24;
    const typeId = (id >>> 16) & 0xff;
    const entryId = id & 0xffff;
    if (!pkgId || !typeId) throw new Error('合成资源必须包含 package/type ID');
    if (!packages.has(pkgId)) packages.set(pkgId, { id: pkgId, keys: [], types: new Map() });
    const pkg = packages.get(pkgId);
    if (!pkg.types.has(typeId)) pkg.types.set(typeId, new Map());
    const entries = pkg.types.get(typeId);
    if (entries.has(entryId)) throw new Error('合成资源 ID 重复');
    let data = value;
    if (typeof value === 'string') {
      data = strings.indexOf(value);
      if (data < 0) { data = strings.length; strings.push(value); }
    } else if (!Number.isInteger(value)) throw new Error('合成资源只支持字符串或引用');
    entries.set(entryId, { key: pkg.keys.length, type: typeof value === 'string' ? 0x03 : 0x01, data });
    pkg.keys.push(`fixture_${typeId}_${entryId}`);
  }
  // ARSC chunk 按 4 字节对齐；不改变原有 AXML 夹具的字符串池字节。
  const pool = (values) => {
    const raw = buildStringPool(values);
    const aligned = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4)]);
    aligned.writeUInt32LE(aligned.length, 4);
    return aligned;
  };
  const chunks = [pool(strings)];
  for (const pkg of packages.values()) {
    const typeNames = Array.from({ length: Math.max(...pkg.types.keys()) }, (_, i) =>
      ['string', 'mipmap'][i] || `fixture_type_${i + 1}`);
    const typePool = pool(typeNames);
    const keyPool = pool(pkg.keys);
    const types = [];
    for (const [typeId, entries] of pkg.types) {
      const count = Math.max(...entries.keys()) + 1;
      const spec = Buffer.alloc(16 + count * 4);
      spec.writeUInt16LE(0x0202, 0);
      spec.writeUInt16LE(16, 2);
      spec.writeUInt32LE(spec.length, 4);
      spec.writeUInt8(typeId, 8);
      spec.writeUInt32LE(count, 12);
      const header = Buffer.alloc(20 + 64); // ResTable_type + 默认 ResTable_config
      const offsets = Buffer.alloc(count * 4, 0xff); // NO_ENTRY
      const values = [];
      for (const [index, entry] of entries) {
        offsets.writeUInt32LE(values.length * 16, index * 4);
        values.push(Buffer.concat([
          u16(8), u16(0), u32(entry.key), // ResTable_entry（非复杂资源）
          u16(8), Buffer.from([0, entry.type]), u32(entry.data), // Res_value
        ]));
      }
      header.writeUInt16LE(0x0201, 0);
      header.writeUInt16LE(header.length, 2);
      header.writeUInt32LE(header.length + offsets.length + values.length * 16, 4);
      header.writeUInt8(typeId, 8);
      header.writeUInt32LE(count, 12);
      header.writeUInt32LE(header.length + offsets.length, 16);
      header.writeUInt32LE(64, 20);
      types.push(spec, header, offsets, ...values);
    }
    const body = Buffer.concat([typePool, keyPool, ...types]);
    const header = Buffer.alloc(288); // ResTable_package，typeIdOffset=0
    header.writeUInt16LE(0x0200, 0);
    header.writeUInt16LE(header.length, 2);
    header.writeUInt32LE(header.length + body.length, 4);
    header.writeUInt32LE(pkg.id, 8);
    Buffer.from(`com.example.resources.p${pkg.id}`, 'utf16le').copy(header, 12);
    header.writeUInt32LE(header.length, 268);
    header.writeUInt32LE(header.length + typePool.length, 276);
    chunks.push(header, body);
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([u16(0x0002), u16(12), u32(12 + body.length), u32(packages.size), body]);
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
  if (o.resources !== undefined) entries.push({ name: 'resources.arsc', data: buildResTable(o.resources) });
  entries.push(...(o.extraEntries || []));
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

'use strict';
/**
 * 自定义 Android / MIUI 镜像适配层测试（纯 Node，不联网、不拉起 emulator）
 *
 * 守的核心是「不要假装成功」：
 *   1. 手机固件（卡刷包 / boot.img / recovery / arm64）必须被明确拒绝，
 *      而不是塞给 QEMU 然后黑屏；
 *   2. MIUI 没有 x86_64 模拟器镜像 —— 导入必须失败，且原因要说清楚；
 *   3. 导入失败不改变当前生效的镜像，默认运行时（Android 14 Google Play x86_64）
 *      与它的 AVD / 已装应用一个字节都不动；
 *   4. 切到自定义镜像后跑在独立 AVD 里，恢复默认即可原样回来。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-image-${Date.now()}`);
const TMP_DATA = path.join(TMP, 'appdata');
const TMP_RT = path.join(TMP, 'runtime');
const TMP_SRC = path.join(TMP, 'src');
process.env.APPDATA = TMP_DATA;
for (const d of [TMP_DATA, TMP_RT, TMP_SRC]) fs.mkdirSync(d, { recursive: true });

const store = require('../src/core/store');
const manifest = require('../src/core/image-manifest');
const inspect = require('../src/core/image-inspect');
const { ImageStore, findImageRoot } = require('../src/core/images');
const { EmulatorEngine, AVD_NAME, CUSTOM_AVD_NAME } = require('../src/core/emulator');
const layers = require('../src/core/layers');
const repair = require('../src/core/repair');

const ROOT = path.join(__dirname, '..');
const MB = 1024 * 1024;

let passed = 0;
const fails = [];
const asyncTests = [];

function test(name, fn) {
  try { fn(); passed += 1; } catch (e) { fails.push(`${name}: ${e.message}`); }
}
/** 异步用例先入队，最后按顺序 await —— 否则断言会跑到汇总之后，失败被吞掉 */
function atest(name, fn) { asyncTests.push([name, fn]); }
async function runAsync() {
  for (const [name, fn] of asyncTests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      passed += 1;
    } catch (e) {
      fails.push(`${name}: ${e.message}`);
    }
  }
}

/* ---------------- 夹具：造一套「长得像」的镜像 ---------------- */

/**
 * 用 ftruncate 把文件拉到目标尺寸：NTFS 上「设置文件末尾」是 O(1) 的，
 * 不会真的写 64MB 零，所以单测里造十几套镜像也不会把磁盘吃掉。
 */
function makeFile(file, size, patch) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    if (patch) fs.writeSync(fd, patch.buf, 0, patch.buf.length, patch.offset || 0);
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
}

const EXT4_MAGIC = { buf: Buffer.from([0x53, 0xef]), offset: 0x438 };
const ELF = { buf: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), offset: 0 };
const GZIP = { buf: Buffer.from([0x1f, 0x8b, 0x08, 0x00]), offset: 0 };
const SPARSE = { buf: Buffer.from([0x3a, 0xff, 0x26, 0xed]), offset: 0 };
const ANDROID_BOOT = { buf: Buffer.concat([Buffer.from('ANDROID!'), Buffer.alloc(64)]), offset: 0 };

/**
 * @param {string} name 目录名（会拼进路径，用来测 ABI 推断）
 */
function makeImage(name, opt = {}) {
  const {
    abi = 'x86_64', api = 34, tag = 'google_apis_playstore',
    vendor = true, kernel = 'elf', system = 'ext4',
    props = true, manifestJson = null, extra = {},
  } = opt;
  const dir = path.join(TMP_SRC, name, `android-${api}`, tag, abi);
  fs.mkdirSync(dir, { recursive: true });
  if (system === 'sparse') makeFile(path.join(dir, 'system.img'), 66 * MB, SPARSE);
  else if (system === 'ext4') makeFile(path.join(dir, 'system.img'), 66 * MB, EXT4_MAGIC);
  else if (system === 'android-boot') makeFile(path.join(dir, 'system.img'), 66 * MB, ANDROID_BOOT);
  if (vendor) makeFile(path.join(dir, 'vendor.img'), 5 * MB, EXT4_MAGIC);
  makeFile(path.join(dir, 'kernel-ranchu'), 300 * 1024, kernel === 'android-boot' ? ANDROID_BOOT : ELF);
  makeFile(path.join(dir, 'ramdisk.img'), 70 * 1024, GZIP);
  if (props) {
    fs.writeFileSync(path.join(dir, 'source.properties'), [
      `AndroidVersion.ApiLevel=${api}`,
      `SystemImage.Abi=${abi}`,
      `SystemImage.TagId=${tag}`,
    ].join('\n'));
  }
  for (const [n, content] of Object.entries(extra)) {
    if (content === null) makeFile(path.join(dir, n), 8 * MB, null);
    else fs.writeFileSync(path.join(dir, n), String(content));
  }
  if (manifestJson) fs.writeFileSync(path.join(dir, manifest.MANIFEST_NAME), JSON.stringify(manifestJson, null, 2));
  return dir;
}

/** 手机卡刷包长相：boot.img + 稀疏 system/vendor + arm64 目录 */
function makePhoneRom(name = 'miui-phone') {
  const dir = path.join(TMP_SRC, name, 'android-13', 'miui', 'arm64-v8a');
  fs.mkdirSync(dir, { recursive: true });
  makeFile(path.join(dir, 'boot.img'), 24 * MB, ANDROID_BOOT);
  makeFile(path.join(dir, 'system.img'), 66 * MB, SPARSE);
  makeFile(path.join(dir, 'vendor.img'), 5 * MB, EXT4_MAGIC);
  fs.writeFileSync(path.join(dir, 'system.transfer.list'), '4\n0\n');
  return dir;
}

const newStore = (extra = {}) => new ImageStore({ root: TMP_RT, ...extra });

console.log('\n[manifest：类型 / ABI / API / 机器类型]');

test('合法模拟器镜像清单通过校验', () => {
  const m = manifest.normalize({ name: 'AOSP 14', api: 34, abi: 'x86_64', type: 'emulator-system-image' });
  const v = manifest.validate(m);
  assert(v.ok, `应通过：${JSON.stringify(v.errors)}`);
});

test('手机刷机包被拒绝，并说清「为什么这不是模拟器镜像」', () => {
  const m = manifest.normalize({ name: 'Pixel 线刷包', api: 34, abi: 'x86_64', type: 'phone-rom' });
  const v = manifest.validate(m);
  assert(!v.ok, '手机固件不能通过');
  const why = v.errors.join(' ');
  assert(/手机固件/.test(why), why);
  assert(/ranchu/.test(why), '要说明模拟器需要 ranchu 内核');
});

test('MIUI 被明确拒绝：不得声称已接入', () => {
  const m = manifest.normalize({ name: 'MIUI 14', api: 33, abi: 'arm64-v8a', type: 'miui-rom', vendor: 'Xiaomi' });
  const v = manifest.validate(m);
  assert(!v.ok, 'MIUI 不能通过');
  const why = v.errors.join(' ');
  assert(/MIUI/.test(why), why);
  assert(/没有/.test(why) && /x86_64/.test(why), `必须说明 MIUI 没有 x86_64 模拟器镜像：${why}`);
});

test('MIUI 就算自称 x86_64 也不行：ARM 系统镜像直接拒', () => {
  const m = manifest.normalize({ name: 'MIUI 14', api: 34, abi: 'arm64-v8a', type: 'emulator-system-image' });
  const v = manifest.validate(m);
  assert(!v.ok, 'arm64 系统镜像起不来');
  const why = v.errors.join(' ');
  assert(/arm64-v8a/.test(why), why);
  assert(/转译/.test(why), '要说清 ARM 转译是 x86_64 镜像里的层，不是 ARM 系统镜像');
});

test('类型别名归一：miui / fastboot / recovery', () => {
  assert(manifest.normalizeType('miui') === manifest.TYPE.MIUI);
  assert(manifest.normalizeType('fastboot') === manifest.TYPE.PHONE_ROM);
  assert(manifest.normalizeType('recovery') === manifest.TYPE.RECOVERY);
  assert(manifest.normalizeType('emulator') === manifest.TYPE.EMULATOR);
  assert(manifest.normalizeType('???') === manifest.TYPE.UNKNOWN);
});

test('x86（32 位）允许但给出警告，未识别的 ABI 拒绝', () => {
  const x86 = manifest.validate(manifest.normalize({ name: 'a', api: 30, abi: 'x86' }));
  assert(x86.ok && x86.warnings.some((w) => /32 位/.test(w)), JSON.stringify(x86));
  const weird = manifest.validate(manifest.normalize({ name: 'b', api: 30, abi: 'mips' }));
  assert(!weird.ok, 'mips 应当拒绝');
});

test('缺 api / api 越界 / 机器类型不对 / bootable:false 都被拒绝', () => {
  assert(!manifest.validate(manifest.normalize({ name: 'a', abi: 'x86_64' })).ok, '缺 api 应拒绝');
  assert(!manifest.validate(manifest.normalize({ name: 'a', abi: 'x86_64', api: 15 })).ok, 'api 15 应拒绝');
  assert(!manifest.validate(manifest.normalize({ name: 'a', abi: 'x86_64', api: 34, qemu: { machine: 'pc' } })).ok,
    'qemu.machine=pc 应拒绝');
  assert(!manifest.validate(manifest.normalize({ name: 'a', abi: 'x86_64', api: 34, bootable: false })).ok,
    'bootable:false 应拒绝');
});

test('清单里的校验值：只接受合法格式，坏条目丢弃', () => {
  const m = manifest.normalize({
    name: 'a', api: 34, abi: 'x86_64',
    checksums: {
      'system.img': `sha256:${'a'.repeat(64)}`,
      'vendor.img': 'sha1:zzz',
      'kernel-ranchu': `md5:${'b'.repeat(32)}`,
    },
  });
  assert(m.checksums['system.img'], '合法 sha256 应保留');
  assert(!m.checksums['vendor.img'], '长度/字符非法的应丢弃');
  assert(m.checksums['kernel-ranchu'], '合法 md5 应保留');
});

test('tag.id 落回 emulator 认识的值', () => {
  const custom = manifest.normalize({ name: 'a', api: 34, abi: 'x86_64', tag: 'my-awesome-tag' });
  assert(['google_apis', 'google_apis_playstore', 'default'].includes(manifest.emulatorTag(custom)),
    `自定义 tag 必须落回合法值，实际 ${manifest.emulatorTag(custom)}`);
  const play = manifest.normalize({ name: 'a', api: 34, abi: 'x86_64', googleServices: { gms: true, playStore: true } });
  assert(manifest.emulatorTag(play) === 'google_apis_playstore', '声明了 Play 商店就该用 playstore tag');
  const gms = manifest.normalize({ name: 'a', api: 34, abi: 'x86_64', googleServices: { gms: true } });
  assert(manifest.emulatorTag(gms) === 'google_apis', '只有 GMS 就该用 google_apis');
});

test('来源说明：先说「从哪来」，再说具体路径', () => {
  const txt = manifest.describeSource({ kind: 'local-dir', path: 'D:/img', vendor: '自建' });
  assert(/本地文件夹/.test(txt), txt);
  assert(/D:\/img/.test(txt), txt);
});

console.log('\n[字节体检：文件到底是什么]');

test('内核：ELF 通过，boot.img 明确拒绝', () => {
  const good = path.join(TMP_SRC, 'k-elf');
  makeFile(good, 300 * 1024, ELF);
  assert(inspect.classifyKernel(good).ok, 'ELF 内核应通过');
  const boot = path.join(TMP_SRC, 'k-boot');
  makeFile(boot, 300 * 1024, ANDROID_BOOT);
  const r = inspect.classifyKernel(boot);
  assert(!r.ok && r.kind === 'android-boot', JSON.stringify(r));
  assert(/boot\.img/.test(r.reason), r.reason);
});

test('ramdisk：gzip 通过，boot.img 拒绝', () => {
  const good = path.join(TMP_SRC, 'r-gz');
  makeFile(good, 70 * 1024, GZIP);
  assert(inspect.classifyRamdisk(good).ok);
  const boot = path.join(TMP_SRC, 'r-boot');
  makeFile(boot, 70 * 1024, ANDROID_BOOT);
  assert(!inspect.classifyRamdisk(boot).ok);
});

test('ramdisk：Android legacy LZ4 魔数通过', () => {
  const file = path.join(TMP, 'ramdisk-legacy-lz4.img');
  const buf = Buffer.alloc(70 * 1024);
  buf.writeUInt32LE(0x184c2102, 0);
  fs.writeFileSync(file, buf);
  assert(inspect.classifyRamdisk(file).ok, 'Android 14 官方 ramdisk 的 legacy LZ4 头应被接受');
});

test('分区镜像：稀疏 ext4 / raw ext4 都认，boot.img 不认', () => {
  const sp = path.join(TMP_SRC, 'p-sparse');
  makeFile(sp, 66 * MB, SPARSE);
  assert(inspect.classifyPartition(sp, 'system.img').kind === 'sparse');
  const ext = path.join(TMP_SRC, 'p-ext4');
  makeFile(ext, 66 * MB, EXT4_MAGIC);
  assert(inspect.classifyPartition(ext, 'system.img').kind === 'ext4');
  const boot = path.join(TMP_SRC, 'p-boot');
  makeFile(boot, 66 * MB, ANDROID_BOOT);
  assert(!inspect.classifyPartition(boot, 'system.img').ok);
});

test('四件套齐全 → 体检通过，并推断出 api / abi / tag', () => {
  const dir = makeImage('full');
  const r = inspect.scanImageDir(dir);
  assert(r.ok, `应通过：${JSON.stringify(r.errors)}`);
  assert(r.meta.api === 34 && r.meta.abi === 'x86_64', JSON.stringify(r.meta));
  assert(r.meta.tag === 'google_apis_playstore', JSON.stringify(r.meta));
});

test('缺 vendor（API 34）→ 拒绝并解释 Treble', () => {
  const dir = makeImage('no-vendor', { vendor: false });
  const r = inspect.scanImageDir(dir);
  assert(!r.ok, '缺 vendor 不能通过');
  assert(/vendor/.test(r.errors.join(' ')), r.errors.join(' '));
});

test('只有 super.img → 拒绝并说明动态分区要拆分', () => {
  const dir = path.join(TMP_SRC, 'super-only', 'android-34', 'google_apis', 'x86_64');
  fs.mkdirSync(dir, { recursive: true });
  makeFile(path.join(dir, 'super.img'), 80 * MB, null);
  makeFile(path.join(dir, 'kernel-ranchu'), 300 * 1024, ELF);
  makeFile(path.join(dir, 'ramdisk.img'), 70 * 1024, GZIP);
  const r = inspect.scanImageDir(dir);
  assert(!r.ok, '只有 super.img 不能通过');
  assert(/super\.img/.test(r.errors.join(' ')), r.errors.join(' '));
});

test('卡刷包的 system.new.dat.br → 拒绝并说明要先转换', () => {
  const dir = path.join(TMP_SRC, 'newdat', 'android-13', 'miui', 'arm64-v8a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'system.new.dat.br'), 'fake');
  fs.writeFileSync(path.join(dir, 'system.transfer.list'), '4\n0\n');
  makeFile(path.join(dir, 'kernel-ranchu'), 300 * 1024, ELF);
  makeFile(path.join(dir, 'ramdisk.img'), 70 * 1024, GZIP);
  const r = inspect.scanImageDir(dir);
  assert(!r.ok, 'new.dat 不能通过');
  assert(/卡刷包|new\.dat/.test(r.errors.join(' ')), r.errors.join(' '));
});

test('Android OTA payload.bin → 明确拒绝为手机升级包', () => {
  const dir = path.join(TMP_SRC, 'ota-payload', 'ishtar-ota');
  fs.mkdirSync(dir, { recursive: true });
  const payload = Buffer.alloc(64);
  payload.write('CrAU', 0, 'latin1');
  fs.writeFileSync(path.join(dir, 'payload.bin'), payload);
  fs.writeFileSync(path.join(dir, 'payload_properties.txt'), 'FILE_HASH=test\n');
  const r = inspect.scanImageDir(dir);
  assert(!r.ok, 'OTA payload 不能通过模拟器镜像体检');
  const why = r.errors.join(' ');
  assert(/OTA/.test(why) && /payload\.bin/.test(why), why);
  assert(r.otaDetected === true, JSON.stringify(r));
});

test('指到上层目录也能找到真正的镜像层', () => {
  const dir = makeImage('nested');
  const top = path.join(TMP_SRC, 'nested');
  const found = findImageRoot(top);
  assert(path.resolve(found) === path.resolve(dir), `应找到 ${dir}，实际 ${found}`);
});

console.log('\n[导入：失败绝不改变当前运行时]');

atest('导入合法镜像 → 只加一条记录，当前镜像仍是默认', async () => {
  const before = newStore().list().length;
  const dir = makeImage('importable');
  const st = newStore();
  const r = await st.import(dir);
  assert(r.ok, `导入应成功：${r.error || ''}`);
  assert(newStore().list().length === before + 1, '应多一条记录');
  assert(store.getSettings().runtime.activeImageId === '', '导入不能自动启用');
  assert(newStore().active().custom === false, '当前仍应是默认镜像');
  const item = newStore().list().find((x) => x.id === r.record.id);
  assert(item.managed === false, '本地目录导入不应复制一份');
  assert(item.state === 'ok', `记录应可用：${item.reason}`);
});

atest('导入手机固件 → 抛错，索引与设置都不变', async () => {
  const before = newStore().list().length;
  const rom = makePhoneRom();
  const st = newStore();
  let err = null;
  try { await st.import(rom); } catch (e) { err = e; }
  assert(err, '手机固件必须导入失败');
  const msg = String(err.message || '');
  assert(/boot\.img|手机|arm64|transfer|ranchu/.test(msg), `原因要具体：${msg}`);
  assert(newStore().list().length === before, '失败不能留下记录');
  assert(store.getSettings().runtime.activeImageId === '', '失败不能改动当前镜像');
});

atest('MIUI 目录（arm64 + boot.img）→ 失败原因里必须出现 MIUI', async () => {
  const rom = makePhoneRom('miui-14-xiaomi');
  fs.writeFileSync(path.join(rom, manifest.MANIFEST_NAME), JSON.stringify({
    name: 'MIUI 14', type: 'miui-rom', api: 33, abi: 'arm64-v8a', vendor: 'Xiaomi',
  }));
  const st = newStore();
  let err = null;
  try { await st.import(rom); } catch (e) { err = e; }
  assert(err, 'MIUI 必须导入失败');
  assert(/MIUI/.test(err.message), err.message);
  assert(/没有/.test(err.message) || /无法/.test(err.message), err.message);
});

atest('清单自称 x86_64 但目录是 arm64 → 拒绝（不能装作成功）', async () => {
  const dir = path.join(TMP_SRC, 'liar', 'android-34', 'google_apis', 'arm64-v8a');
  fs.mkdirSync(dir, { recursive: true });
  makeFile(path.join(dir, 'system.img'), 66 * MB, EXT4_MAGIC);
  makeFile(path.join(dir, 'vendor.img'), 5 * MB, EXT4_MAGIC);
  makeFile(path.join(dir, 'kernel-ranchu'), 300 * 1024, ELF);
  makeFile(path.join(dir, 'ramdisk.img'), 70 * 1024, GZIP);
  fs.writeFileSync(path.join(dir, manifest.MANIFEST_NAME), JSON.stringify({
    name: '假 x86_64', type: 'emulator-system-image', api: 34, abi: 'x86_64',
  }));
  const st = newStore();
  let err = null;
  try { await st.import(dir); } catch (e) { err = e; }
  assert(err, 'ABI 不一致必须拒绝');
  assert(/不一致|arm64-v8a/.test(err.message), err.message);
});

atest('校验值不匹配 → 拒绝导入', async () => {
  const dir = makeImage('badsum', {
    manifestJson: {
      name: '坏校验值', type: 'emulator-system-image', api: 34, abi: 'x86_64',
      checksums: { 'system.img': `sha256:${'0'.repeat(64)}` },
    },
  });
  const st = newStore();
  let err = null;
  try { await st.import(dir); } catch (e) { err = e; }
  assert(err, '校验值不对必须拒绝');
  assert(/校验值不匹配/.test(err.message), err.message);
});

atest('校验值正确 → 正常导入', async () => {
  const crypto = require('crypto');
  const dir = makeImage('goodsum', {
    manifestJson: { name: '好校验值', type: 'emulator-system-image', api: 34, abi: 'x86_64' },
  });
  const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'system.img'))).digest('hex');
  const mf = path.join(dir, manifest.MANIFEST_NAME);
  const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
  j.checksums = { 'system.img': `sha256:${sum}` };
  fs.writeFileSync(mf, JSON.stringify(j));
  const st = newStore();
  const r = await st.import(dir);
  assert(r.ok, `应成功：${r.error || ''}`);
  assert(r.checksums === 1, `应校验 1 个文件，实际 ${r.checksums}`);
});

console.log('\n[启用 / 恢复 / 移除：默认运行时全程不动]');

atest('启用 → activeImageId 落盘；删除镜像文件后自动判定不可用', async () => {
  const dir = makeImage('activatable');
  const st = newStore();
  const { record } = await st.import(dir);
  const act = st.activate(record.id);
  assert(act.ok, '启用应成功');
  assert(store.getSettings().runtime.activeImageId === record.id, '设置里应写入 activeImageId');

  const a = newStore().active();
  assert(a.ok && a.custom && a.api === 34 && a.abi === 'x86_64', JSON.stringify(a));

  // 用户把镜像里的文件删了：不能因此开不了机，而是回落默认镜像 + 说明原因
  fs.rmSync(path.join(dir, 'system.img'), { force: true });
  const broken = newStore().active();
  assert(broken.custom === true && broken.ok === false, JSON.stringify(broken));
  assert(/system\.img/.test(broken.reason), broken.reason);

  newStore().restoreDefault();
  assert(store.getSettings().runtime.activeImageId === '', '恢复默认后指针应清空');
  assert(newStore().active().custom === false, '恢复默认后应回到默认镜像');

  // 复原文件，后面的用例还要用这条记录
  makeFile(path.join(dir, 'system.img'), 66 * MB, EXT4_MAGIC);
});

atest('移除本地目录导入的记录：不删用户自己的文件夹', async () => {
  const dir = makeImage('removable');
  const st = newStore();
  const { record } = await st.import(dir);
  const r = st.remove(record.id);
  assert(r.ok, '移除应成功');
  assert(fs.existsSync(path.join(dir, 'system.img')), '绝不能删用户自己的镜像文件');
  assert(!newStore().list().some((x) => x.id === record.id), '记录应消失');
});

atest('ZIP 导入：副本归我们管，移除时删副本而不是源包', async () => {
  const dir = makeImage('zipped');
  const zip = path.join(TMP_SRC, 'pkg.zip');
  fs.writeFileSync(zip, 'PK-fake');
  const st = newStore({
    // 用桩替代真实解压：把目录拷进目标目录即可（真实路径走 provisioner.extractZip）
    extractZip: async (_zipPath, dest) => {
      const copy = (from, to) => {
        fs.mkdirSync(to, { recursive: true });
        for (const e of fs.readdirSync(from, { withFileTypes: true })) {
          const a = path.join(from, e.name);
          const b = path.join(to, e.name);
          if (e.isDirectory()) copy(a, b); else fs.copyFileSync(a, b);
        }
      };
      // 包里通常还套一层顶层目录
      copy(path.dirname(dir), path.join(dest, 'pkg'));
    },
  });
  const r = await st.import(zip);
  assert(r.ok, `ZIP 导入应成功：${r.error || ''}`);
  assert(r.record.managed === true, 'ZIP 副本应由我们管理');
  const copyDir = r.record.dir;
  assert(fs.existsSync(path.join(copyDir, 'system.img')), `副本应落在 custom-images：${copyDir}`);
  assert(copyDir.includes('custom-images'), copyDir);
  st.remove(r.record.id);
  assert(!fs.existsSync(copyDir), '移除时应删掉自己的副本');
  assert(fs.existsSync(path.join(dir, 'system.img')), '源目录不能被动');
});

atest('没有解压能力时 ZIP 导入给出明确提示（而不是静默失败）', async () => {
  const zip = path.join(TMP_SRC, 'pkg2.zip');
  fs.writeFileSync(zip, 'PK-fake');
  const st = newStore();
  let err = null;
  try { await st.import(zip); } catch (e) { err = e; }
  assert(err && /解压/.test(err.message), err && err.message);
});

atest('无法识别的来源（单张 .img）直接拒绝并说明该选什么', async () => {
  const img = path.join(TMP_SRC, 'system-alone.img');
  makeFile(img, 66 * MB, EXT4_MAGIC);
  const st = newStore();
  let err = null;
  try { await st.import(img); } catch (e) { err = e; }
  assert(err && /文件夹|ZIP|清单/.test(err.message), err && err.message);
});

atest('预览不落盘：inspect 之后 custom-images 里不会多出东西', async () => {
  const dir = makeImage('preview-only');
  const st = newStore();
  const report = await st.inspectSource(dir);
  assert(report.ok, JSON.stringify(report.errors));
  assert(!st.list().some((x) => x.name === 'preview-only'), '预览不能写索引');
});

console.log('\n[与运行时 / 清理 / 诊断的接线]');

test('有自定义镜像时 imageChoice 用它；默认时仍用 Android 14 Play', () => {
  const emu = new EmulatorEngine(ROOT);
  emu.provisioner = {
    activeImage: () => ({
      ok: true, custom: true, id: 'x', name: '我的镜像', api: 33,
      abi: 'x86_64', tag: 'google_apis', dir: 'D:/img', size: 1, type: 'emulator-system-image',
      googleServices: { gms: true, playStore: false }, armTranslation: { enabled: true },
    }),
    playImageInfo: () => ({ ok: true, api: '34', tag: 'google_apis_playstore', dir: 'D:/play' }),
    systemImageInfo: () => ({ ok: true, api: 34, tag: 'google_apis_playstore', abi: 'x86_64', dir: 'D:/play' }),
    paths: () => ({ sysAbi: 'x86_64' }),
  };
  const ch = emu.imageChoice();
  assert(ch.custom && ch.api === 33 && ch.dir === 'D:/img', JSON.stringify(ch));
  assert(ch.playStore === false, '清单说没有 Play 商店就不能假装有');

  emu.provisioner.activeImage = () => ({ ok: true, custom: false, id: '' });
  const def = emu.imageChoice();
  assert(!def.custom && def.api === '34' && def.tag === 'google_apis_playstore',
    `默认必须还是 Android 14 Play x86_64，实际 ${JSON.stringify(def)}`);
});

test('自定义镜像跑在独立 AVD 里（默认 AVD 不受影响）', () => {
  const emu = new EmulatorEngine(ROOT);
  emu.provisioner = { activeImage: () => ({ ok: true, custom: true, id: 'x' }) };
  assert(emu.avdName === CUSTOM_AVD_NAME, `实际 ${emu.avdName}`);
  emu.provisioner.activeImage = () => ({ ok: true, custom: false, id: '' });
  assert(emu.avdName === AVD_NAME, `实际 ${emu.avdName}`);
  // 镜像不可用时也回到默认 AVD，绝不去动自定义那套的数据
  emu.provisioner.activeImage = () => ({ ok: false, custom: true, id: 'x', reason: '坏了' });
  assert(emu.avdName === AVD_NAME);
});

test('清理逻辑不会把 apkstart-custom.avd 当成「非活动 AVD」回收', () => {
  const root = path.join(TMP, 'cleanup-rt');
  const avdHome = path.join(root, 'avd');
  for (const n of ['apkstart.avd', 'apkstart-custom.avd', 'apkstart-houdini.avd']) {
    fs.mkdirSync(path.join(avdHome, n), { recursive: true });
    fs.writeFileSync(path.join(avdHome, n, 'userdata-qemu.img'), 'x');
  }
  const r = layers.analyze(root, { keepAvd: 'apkstart.avd' });
  const names = r.candidates.map((c) => path.basename(c.path));
  assert(!names.includes('apkstart.avd'), '默认 AVD 不能被回收');
  assert(!names.includes('apkstart-custom.avd'), '自定义镜像的 AVD 也不能被回收');
  assert(names.includes('apkstart-houdini.avd'), '真正废弃的 AVD 仍应可回收');
});

test('体检表会列出镜像来源；镜像坏了会列出原因', () => {
  const facts = repair.buildFacts({
    cpuModel: 'X', cores: 4, totalMB: 8192,
    image: {
      api: 34, tag: 'google_apis', custom: true, name: '我的 AOSP',
      source: '本地文件夹 · D:/img', reason: '',
    },
  });
  const checks = repair.buildChecks(facts);
  assert(checks.some((c) => c.label === '系统镜像' && /自定义镜像/.test(c.value)), JSON.stringify(checks));
  assert(checks.some((c) => c.label === '镜像来源' && /D:\/img/.test(c.value)), JSON.stringify(checks));

  const bad = repair.buildFacts({
    cpuModel: 'X', cores: 4, totalMB: 8192,
    image: { api: 34, custom: true, name: '坏的', reason: '镜像目录已不存在：D:/gone' },
  });
  const badChecks = repair.buildChecks(bad);
  const row = badChecks.find((c) => c.label === '镜像不可用');
  assert(row && /D:\/gone/.test(row.value) && row.state === 'bad', JSON.stringify(badChecks));
});

test('默认运行时是 Android 14 Google Play x86_64，Google APIs 档位仍保留', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'provision.js'), 'utf8');
  assert(/const PLAY_SYSIMG = IMAGE_PROFILES\.google_apis_playstore/.test(src),
    'Google Play 兼容档位必须保留');
  assert(/const DEFAULT_SYSIMG = IMAGE_PROFILES\.google_apis_playstore/.test(src), '默认镜像应指向 Google Play');
});

test('设置里新增的 activeImageId 会被保存（不在白名单外）', () => {
  store.saveSettings({ runtime: { activeImageId: 'demo-id' } });
  assert(store.getSettings().runtime.activeImageId === 'demo-id', '白名单把 activeImageId 丢了');
  store.saveSettings({ runtime: { activeImageId: '' } });
});

test('默认镜像目录与自定义镜像目录互不重叠', () => {
  const { Provisioner } = require('../src/core/provision');
  const p = new Provisioner(ROOT);
  const paths = p.paths();
  assert(paths.customImagesDir && paths.customImagesDir.includes('custom-images'), paths.customImagesDir);
  assert(!path.resolve(paths.sysImgRoot).startsWith(path.resolve(paths.customImagesDir)),
    '自定义镜像不能放进默认镜像目录里（否则会被当成系统镜像扫到）');
});

(async () => {
  await runAsync();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  if (fails.length) {
    console.log(`\n镜像适配层测试：${passed} 通过，${fails.length} 失败`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`镜像适配层测试：${passed} 项全部通过`);
})();

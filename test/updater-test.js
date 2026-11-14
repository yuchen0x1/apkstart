'use strict';
/**
 * 更新器安全测试：路径穿越、绝对路径、符号链接、CRC 损坏、载荷校验、失败回滚脚本。
 * 这些用例都是「构造真实字节流的恶意 ZIP」，不是假装失败的桩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Updater } = require('../src/core/updater');
const { safeEntryPath, ZipFile } = require('../src/core/zip');
const { writeZip } = require('./lib/zip-writer');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e && (e.stack || e.message)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }

async function expectThrow(fn, re, msg) {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg || '错误信息不符'}：${e.message}`);
    return e;
  }
  throw new Error(`${msg || '应当抛错'}：但没有抛错`);
}

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upd-')); }

function mkUpdater(root) {
  return new Updater({
    currentVersion: '0.0.1',
    exePath: path.join(root, 'app', 'ApkStart.exe'),
    isPackaged: true,
    dataDir: path.join(root, 'data'),
    settings: () => ({}),
  });
}

async function main() {
  console.log('\n[zip.js 路径边界]');

  await test('safeEntryPath：正常相对路径被解析到目标目录内', () => {
    const root = path.join('C:', 'tmp', 'payload');
    const p = safeEntryPath(root, 'resources/app/main.js');
    assert(p.startsWith(path.resolve(root)), p);
    assert(p.endsWith(path.join('resources', 'app', 'main.js')), p);
  });

  await test('safeEntryPath：拒绝 ../ 穿越', () => {
    let threw = false;
    try { safeEntryPath('C:\\tmp\\payload', '../../evil.dll'); } catch (_) { threw = true; }
    assert(threw, '应拒绝 ../');
  });

  await test('safeEntryPath：★ 拒绝「前缀相同」的兄弟目录绕过（旧 startsWith 检查的漏洞）', () => {
    let threw = false;
    try { safeEntryPath('C:\\tmp\\payload', '..\\payload-evil\\x.dll'); } catch (_) { threw = true; }
    assert(threw, '应拒绝 ..\\payload-evil');
  });

  await test('safeEntryPath：拒绝绝对路径 / 盘符 / UNC', () => {
    for (const name of ['/etc/passwd', 'C:/Windows/System32/x.dll', '\\\\server\\share\\x.exe', '//server/share/x']) {
      let threw = false;
      try { safeEntryPath('C:\\tmp\\payload', name); } catch (_) { threw = true; }
      assert(threw, `应拒绝 ${name}`);
    }
  });

  await test('safeEntryPath：目录类条目返回 null（不需要写文件）', () => {
    eq(safeEntryPath('C:\\tmp\\payload', 'resources/'), null);
  });

  console.log('\n[updater.js 解压安全]');

  await test('正常更新包可以解压并通过 CRC 校验', async () => {
    const root = mkTmp();
    const zip = writeZip(path.join(root, 'ok.zip'), [
      { name: 'ApkStart.exe', data: 'MZ-fake-exe' },
      { name: 'resources/app/main.js', data: 'console.log(1)' },
    ]);
    const dest = path.join(root, 'out');
    const u = mkUpdater(root);
    await u._extract(zip, dest);
    assert(fs.existsSync(path.join(dest, 'ApkStart.exe')), '主程序应存在');
    eq(fs.readFileSync(path.join(dest, 'resources/app/main.js'), 'utf8'), 'console.log(1)');
  });

  await test('★ 恶意 ZIP：../ 路径穿越被拒绝，目录外不会落文件', async () => {
    const root = mkTmp();
    const zip = writeZip(path.join(root, 'evil.zip'), [
      { name: 'ApkStart.exe', data: 'MZ' },
      { name: '../evil-updater.txt', data: 'pwned' },
    ]);
    const dest = path.join(root, 'out');
    const u = mkUpdater(root);
    await expectThrow(() => u._extract(zip, dest), /路径穿越|非法绝对路径|更新包/, '应拒绝穿越条目');
    assert(!fs.existsSync(path.join(root, 'evil-updater.txt')), '目录外不应出现文件');
  });

  await test('★ 恶意 ZIP：..\\payload-evil\\ 兄弟目录写法被拒绝', async () => {
    const root = mkTmp();
    const destName = 'payload';
    const zip = writeZip(path.join(root, 'evil2.zip'), [
      { name: `..\\${destName}-evil\\x.dll`, data: 'pwned' },
    ]);
    const dest = path.join(root, destName);
    const u = mkUpdater(root);
    await expectThrow(() => u._extract(zip, dest), /路径穿越|非法绝对路径|更新包/);
    assert(!fs.existsSync(path.join(root, `${destName}-evil`, 'x.dll')), '兄弟目录不应被写入');
  });

  await test('★ 恶意 ZIP：符号链接条目被拒绝（可指向目录外）', async () => {
    const root = mkTmp();
    const zip = writeZip(path.join(root, 'link.zip'), [
      { name: 'link', data: 'C:\\Windows\\System32', symlink: true },
    ]);
    const zf = new ZipFile(zip);
    const entry = zf.entries.get('link');
    assert(entry && entry.symlink === true, '应识别出符号链接');
    zf.close();
    const u = mkUpdater(root);
    await expectThrow(() => u._extract(zip, path.join(root, 'out')), /符号链接/);
  });

  await test('★ 损坏的 ZIP：CRC 不匹配被拒绝（下载损坏/被篡改）', async () => {
    const root = mkTmp();
    const zip = writeZip(path.join(root, 'badcrc.zip'), [
      { name: 'ApkStart.exe', data: 'MZ-good', crc: 0xDEADBEEF },
    ]);
    const u = mkUpdater(root);
    await expectThrow(() => u._extract(zip, path.join(root, 'out')), /CRC|校验/);
  });

  await test('载荷校验：缺少主程序 → 中止更新', async () => {
    const root = mkTmp();
    const dir = path.join(root, 'payload');
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'not an app');
    const u = mkUpdater(root);
    await expectThrow(() => Promise.resolve(u._assertPayload(dir, { version: '9.9.9' })), /没有找到|内容异常/);
  });

  await test('载荷校验：缺少 resources → 中止更新', async () => {
    const root = mkTmp();
    const dir = path.join(root, 'payload');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ApkStart.exe'), 'MZ');
    const u = mkUpdater(root);
    await expectThrow(() => Promise.resolve(u._assertPayload(dir, { version: '9.9.9' })), /resources/);
  });

  await test('载荷校验：内容套了一层目录时自动摊平', async () => {
    const root = mkTmp();
    const dir = path.join(root, 'payload');
    const inner = path.join(dir, 'ApkStart');
    fs.mkdirSync(path.join(inner, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(inner, 'ApkStart.exe'), 'MZ');
    const u = mkUpdater(root);
    u._flattenPayload(dir);
    u._assertPayload(dir, { version: '1.0.0' });
    assert(fs.existsSync(path.join(dir, 'ApkStart.exe')), '应摊平到载荷根');
    assert(!fs.existsSync(inner), '内层目录应被移除');
  });

  await test('apply 前置校验：载荷不存在时直接拒绝，不生成脚本', async () => {
    const root = mkTmp();
    const u = mkUpdater(root);
    await expectThrow(async () => u.apply({ mode: 'zip', payload: path.join(root, 'nope'), version: '1.0.0' }, { spawn: false }), /载荷不存在/);
  });

  await test('apply 生成的替换脚本包含备份与回滚步骤', async () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'MZ');
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false });
    assert(/\$bak/.test(script), '应有备份路径变量');
    assert(/rolling back/.test(script), '应有回滚分支');
    assert(/Copy-Item -Path \(Join-Path \$bak/.test(script), '失败时应从备份还原');
    assert(/exit 1/.test(script), '失败应返回非 0 退出码');
    // 脚本能被写出来给人工排查，但不能包含未转义的单引号拼接
    assert(!/\$dst = ''/.test(script), '路径应为非空字面量');
  });

  await test('分片包拼装后大小不符 → 中止（不会装上一个损坏的包）', async () => {
    const root = mkTmp();
    const u = mkUpdater(root);
    const target = path.join(root, 'x.zip');
    fs.writeFileSync(target, 'tiny');
    await expectThrow(
      () => u._downloadParts({ name: 'x.zip', size: 999, parts: [] }, target, 1, 999),
      /拼装后大小不对/,
    );
  });

  console.log(`\n更新器安全测试：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

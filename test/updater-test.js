'use strict';
/**
 * 更新器安全测试：路径穿越、绝对路径、符号链接、CRC 损坏、载荷校验、失败回滚脚本。
 * 这些用例都是「构造真实字节流的恶意 ZIP」，不是假装失败的桩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

/** 造一个「结构上像 Windows 程序」的文件：MZ + e_lfanew → PE\0\0，其余填 0 */
function fakeExe(file, size = 400 * 1024, opts = {}) {
  const buf = Buffer.alloc(size);
  buf.write('MZ', 0, 'latin1');
  const peOff = 0x80;
  buf.writeUInt32LE(peOff, 0x3c);
  if (!opts.badPe) buf.write('PE\0\0', peOff, 'latin1');
  fs.writeFileSync(file, buf);
  return file;
}

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

  console.log('\n[安装版 Setup.exe 校验（0.6.3 新增）]');

  await test('★ 安装包是 HTML 错误页 / 半截文件 → 拒绝（此前会直接交给 NSIS 执行）', async () => {
    const root = mkTmp();
    const bad = path.join(root, 'ApkStart-Setup.exe');
    fs.writeFileSync(bad, '<html>502 Bad Gateway</html>'.repeat(12000)); // 够大，但不是 PE
    const u = mkUpdater(root);
    await expectThrow(() => Promise.resolve(u._assertSetup(bad, {})), /MZ 头|PE 头/);
  });

  await test('安装包过小 → 拒绝', async () => {
    const root = mkTmp();
    const bad = path.join(root, 'tiny-setup.exe');
    fs.writeFileSync(bad, 'MZ');
    const u = mkUpdater(root);
    await expectThrow(() => Promise.resolve(u._assertSetup(bad, {})), /体积异常/);
  });

  await test('PE 签名位置损坏（有 MZ 但 PE 头不对）→ 拒绝', async () => {
    const root = mkTmp();
    const bad = fakeExe(path.join(root, 'broken-setup.exe'), 400 * 1024, { badPe: true });
    const u = mkUpdater(root);
    await expectThrow(() => Promise.resolve(u._assertSetup(bad, {})), /PE 头/);
  });

  await test('大小与发布信息不符（下载被截断）→ 拒绝', async () => {
    const root = mkTmp();
    const f = fakeExe(path.join(root, 'short-setup.exe'), 400 * 1024);
    const u = mkUpdater(root);
    await expectThrow(
      () => Promise.resolve(u._assertSetup(f, { size: 999999, sizes: { 'https://x': 888888 } })),
      /大小异常/,
    );
  });

  await test('正常安装包通过校验，并接受 GitHub/Gitee 两个不同大小', async () => {
    const root = mkTmp();
    const f = fakeExe(path.join(root, 'ok-setup.exe'), 400 * 1024);
    const u = mkUpdater(root);
    const r = u._assertSetup(f, { size: 500, sizes: { 'https://gitee': 409600 } });
    eq(r.size, 409600, '应返回真实字节数');
  });

  await test('★ apply(setup) 前置校验：坏安装包直接拒绝，不生成脚本、不启动安装器', async () => {
    const root = mkTmp();
    const bad = path.join(root, 'ApkStart-9.9.9-Setup.exe');
    fs.writeFileSync(bad, Buffer.alloc(500 * 1024, 0x41)); // 500KB 的 'A'，无 PE 头
    const u = mkUpdater(root);
    await expectThrow(
      () => Promise.resolve(u.apply({ mode: 'setup', payload: bad, version: '9.9.9' }, { spawn: false })),
      /MZ 头|PE 头/,
    );
  });

  await test('★ apply(setup) 脚本包含「装前备份 → 装后核对版本 → 失败回滚」', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false });
    // 1) 安装器运行之前就要有备份，且备份必须排除 1.4GB 的 runtime
    const bakAt = script.indexOf('robocopy $dst $bak');
    const runAt = script.indexOf('Start-Process -FilePath');
    assert(bakAt > -1 && runAt > -1 && bakAt < runAt, '备份语句必须在启动安装器之前');
    assert(/\/XD '[^']*resources\\runtime'/.test(script), '备份应排除 resources\\runtime');
    // 2) 装完要核对 package.json 里的版本，不是只看 exit code
    assert(/ConvertFrom-Json/.test(script), '应读取 resources\\app\\package.json 的 version');
    assert(script.includes("$want = '9.9.9'"), '目标版本应写进脚本');
    // 3) 核对失败必须整目录还原，而不是把用户丢在空目录里
    assert(/rolling back to previous version/.test(script), '应有回滚分支');
    assert(/robocopy \$bak \$dst/.test(script), '回滚应把备份复制回安装目录');
    assert(/installer exit/.test(script), '应记录安装器退出码');
  });

  console.log('\n[安装版脚本真机执行：模拟「装完目录被清空」]');

  /**
   * 用真 PowerShell 跑一遍生成的脚本，把 Start-Process 安装器换成「删掉安装目录」，
   * 复现 0.6.1→0.6.2 那次事故（NSIS 卸旧成功、解新失败），验证回滚真的把程序救回来。
   */
  function runScript(script) {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    return spawnSync(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64,
    ], { encoding: 'utf8', timeout: 60000 });
  }

  function makeInstallDir(root, version) {
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'resources', 'app'), { recursive: true });
    fs.mkdirSync(path.join(app, 'resources', 'runtime'), { recursive: true });
    // whoami.exe 是真实 PE，被当成主程序替换后 Start-Process 起来会立刻退出，不打扰测试
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(app, 'ApkStart.exe'));
    fs.writeFileSync(path.join(app, 'resources', 'app', 'package.json'), JSON.stringify({ version }), 'utf8');
    fs.writeFileSync(path.join(app, 'resources', 'runtime', 'big.bin'), 'x'.repeat(1024));
    return app;
  }

  /** 把「跑安装器」换成「删掉安装目录」，模拟安装器失败 */
  function sabotageInstaller(script) {
    return script.replace(/^[ \t]*\$p = Start-Process .*$/m, [
      `  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -ArgumentList '/c exit 0' -PassThru -Wait`,
      `  Remove-Item -LiteralPath $dst -Recurse -Force`,
    ].join('\r\n'));
  }

  await test('★ 安装器把目录删空 → 脚本从备份还原，程序仍可启动', async () => {
    const root = mkTmp();
    const app = makeInstallDir(root, '0.6.2');
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    const script = sabotageInstaller(u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false, waitPid: 999999 }));
    // 防止「替换没生效、其实跑的是真安装器」导致用例假通过
    assert(!/Start-Process -FilePath '[^']*Setup\.exe'/.test(script), '测试应替换掉真实的安装器调用');
    assert(/Remove-Item -LiteralPath \$dst -Recurse/.test(script), '测试应注入「删空目录」的故障');
    const r = runScript(script);
    const log = fs.readFileSync(path.join(root, 'data', 'update', 'update.log'), 'utf8');
    eq(r.status, 0, `脚本应正常退出（实际 ${r.status}）`);
    assert(fs.existsSync(path.join(app, 'ApkStart.exe')), '主程序应被回滚恢复');
    assert(fs.existsSync(path.join(app, 'resources', 'app', 'package.json')), 'resources\\app 应被恢复');
    eq(JSON.parse(fs.readFileSync(path.join(app, 'resources', 'app', 'package.json'), 'utf8')).version, '0.6.2', '回滚后仍是旧版本');
    assert(/rolling back to previous version/.test(log), '日志应记录回滚');
    assert(/backup ok=True/.test(log), '日志应记录备份成功');
  }, 90000);

  await test('★ 安装器成功写入新版本 → 校验通过、备份被清理', async () => {
    const root = mkTmp();
    const app = makeInstallDir(root, '0.6.2');
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    // 模拟成功安装：写入 9.9.9 的 package.json
    const okScript = u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false, waitPid: 999999 })
      .replace(/^[ \t]*\$p = Start-Process .*$/m, [
        `  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -ArgumentList '/c exit 0' -PassThru -Wait`,
        `  '{"version":"9.9.9"}' | Set-Content -LiteralPath $pkg -Encoding UTF8`,
      ].join('\r\n'));
    assert(!/Start-Process -FilePath '[^']*Setup\.exe'/.test(okScript), '测试应替换掉真实的安装器调用');
    const r = runScript(okScript);
    const log = fs.readFileSync(path.join(root, 'data', 'update', 'update.log'), 'utf8');
    eq(r.status, 0, `脚本应正常退出（实际 ${r.status}）`);
    assert(/after install: exe=\d+ ver=9\.9\.9/.test(log), `应识别出新版本（日志：${log}）`);
    assert(!/rolling back/.test(log), '成功路径不应回滚');
    assert(!fs.existsSync(path.join(root, 'data', 'update', 'backup-9.9.9')), '成功后备份应被删除');
  }, 90000);

  console.log(`\n更新器安全测试：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

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

function mkUpdater(root, overrides = {}) {
  return new Updater({
    platform: 'win32',
    ...overrides,
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

  await test('便携版替换脚本语法可解析（新加的大小比对不能把脚本写坏）', async () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'MZ');
    fs.writeFileSync(path.join(payload, 'resources', 'app.asar'), 'asar');
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false });
    // 上游 #98：复制后必须比对真正落地的新文件，不能只看「exe 存在」
    assert(/\$srcExe/.test(script) && /\.Length -ne/.test(script), '要按大小核对新文件是否真的复制成功');
    assert(/app\.asar/.test(script), '只要 exe 换了、界面代码没换，版本仍然对不上');
    assert(/relaunched \(rolled back\)/.test(script), '复制失败回滚后要把旧版本拉起来');
    const file = path.join(root, 'apply-check.ps1');
    fs.writeFileSync(file, script, 'utf8');
    const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8', timeout: 30000,
    });
    if (probe.error && probe.error.code === 'ENOENT') {
      console.log('  跳过：当前环境未提供 ' + powershell + ' 语法解析器');
      return;
    }
    assert(!probe.error, '无法启动 ' + powershell + ': ' + (probe.error ? probe.error.message : ''));
    const r = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      `$err = $null; [void][System.Management.Automation.Language.Parser]::ParseInput(([IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [Text.Encoding]::UTF8)), [ref]$null, [ref]$err); if ($err -and $err.Count) { exit 1 }`,
    ], { encoding: 'utf8', timeout: 30000 });
    assert(r.status === 0, `脚本语法错误：${r.stdout || ''}${r.stderr || ''}`);
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

  await test('apply(setup) 用载荷自身大小校验，不受「latest 漂移」影响', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'), 400 * 1024);
    const u = mkUpdater(root);
    // 下载完之后后台又查到了 10.0.0：latest 的资产大小完全对不上这份载荷
    u.latest = { version: '10.0.0', asset: { name: 'ApkStart-10.0.0-Setup.exe', size: 123, sizes: { 'https://x': 456 } } };
    const script = u.apply({ mode: 'setup', payload: setup, version: '9.9.9', size: 409600 }, { spawn: false });
    assert(/run installer/.test(script), '应正常生成安装脚本，而不是误判大小异常');
  });

  await test('安装形态：卸载器不叫「Uninstall ApkStart.exe」也认得出安装版', async () => {
    const root = mkTmp();
    const app = path.join(root, 'app');
    fs.mkdirSync(app, { recursive: true });
    const u = mkUpdater(root);
    // 没有卸载器 = 便携包
    eq(u.flavor, 'portable', '空目录应判成便携版');
    // NSIS 默认名
    fs.writeFileSync(path.join(app, 'Uninstall ApkStart.exe'), 'x');
    eq(u.flavor, 'setup', '默认卸载器名应判成安装版');
    fs.rmSync(path.join(app, 'Uninstall ApkStart.exe'));
    // 自定义 / 第三方便携重打包常见的名字
    fs.writeFileSync(path.join(app, 'uninstall.exe'), 'x');
    eq(u.flavor, 'setup', 'uninstall.exe 也要认（判错会拿便携 zip 去覆盖安装目录）');
  });

  await test('apply(setup) 会先强制结束没退干净的进程（安装器拿不到文件锁会静默失败）', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'setup', payload: setup, version: '9.9.9', size: 409600 }, { spawn: false });
    assert(/Stop-Process -Id \d+ -Force/.test(script), '必须强制结束残留进程');
    const stopAt = script.indexOf('Stop-Process');
    const runAt = script.indexOf('run installer');
    assert(stopAt > -1 && stopAt < runAt, '强制结束要在启动安装器之前');
    assert(/failed\.json/.test(script), '失败要落标记，下次启动告诉用户');
    assert(/payload kept for manual install/.test(script), '失败时应保留安装包，重试不用重下 1.4GB');
    assert(/if \(-not \$ok\) \{ exit 1 \}[\s\S]*Remove-Item -LiteralPath/.test(script), '验证未通过不得清除载荷');
  });

  await test('已经下好的安装包会被复用，不会因为上次装失败又重下 1.4GB', async () => {
    const root = mkTmp();
    const crypto = require('crypto');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const u = mkUpdater(root, { publicKey });
    fs.mkdirSync(u.installDir, { recursive: true });
    fs.writeFileSync(path.join(u.installDir, 'Uninstall.exe'), 'fixture');
    const version = '9.9.9';
    const dir = path.join(u.dataDir, 'update', version);
    fs.mkdirSync(dir, { recursive: true });
    const setup = fakeExe(path.join(dir, `ApkStart-${version}-Setup.exe`));
    let downloaded = 0;
    u._downloadParts = async () => { downloaded += 1; };
    const info = {
      version,
      tag: `v${version}`,
      asset: { name: `ApkStart-${version}-Setup.exe`, size: fs.statSync(setup).size, urls: [], sizes: {} },
    };
    const { repo } = require('../src/core/release-manifest');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(setup)).digest('hex');
    const data = Buffer.from(JSON.stringify({ schema: 1, repository: repo, tag: info.tag,
      assets: [{ name: info.asset.name, size: info.asset.size, sha256: hash }] }));
    const sig = crypto.sign(null, data, privateKey).toString('base64');
    info.asset.url = repo + '/releases/download/' + info.tag + '/' + info.asset.name;
    info.asset.digest = 'sha256:' + hash;
    await expectThrow(() => u.prepare(info), /签名/);
    info.proof = '<!-- apkstart-manifest ' + data.toString('base64') + ' ' + sig + ' -->';
    await expectThrow(() => u.prepare({ ...info, proof: info.proof.replace(sig, Buffer.alloc(64).toString('base64')) }), /签名/);
    const job = await u.prepare(info);
    eq(job.mode, 'setup', '应识别为安装版');
    eq(downloaded, 0, '文件已存在且大小正确时不该重新下载');
    fs.writeFileSync(setup, Buffer.alloc(info.asset.size, 7));
    await expectThrow(() => u.prepare(info), /SHA-256/);
    assert(!fs.existsSync(setup));

  });

  console.log('\n[Windows PowerShell：用临时目录验证安装判定与回滚]');

  function runInstallFixture(root, script, installer, failCopy) {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const fixture = path.join(root, 'fixture.ps1');
    const prelude = [
      // 不访问宿主进程；仅用系统 cmd 产生确定的退出码。
      'function Wait-Process {}',
      'function Get-Process {}',
      'function Stop-Process { throw "unexpected stop" }',
      'function Start-Sleep {}',
      'function Start-Process {',
      '  param($FilePath, $ArgumentList, [switch]$PassThru, [switch]$Wait, $ErrorAction)',
      '  if (-not $PassThru) { Note "fixture restart"; return }',
      '  Note "fixture installer"',
      ...installer,
      '}',
    ];
    if (failCopy) {
      prelude.push(
        '$script:copyCount = 0',
        'function robocopy {',
        '  $script:copyCount++',
        `  if ($script:copyCount -eq ${failCopy}) { $script:LASTEXITCODE = 8; return }`,
        '  & robocopy.exe @args',
        '  $script:LASTEXITCODE = $LASTEXITCODE',
        '}',
      );
    }
    fs.writeFileSync(fixture, '\ufeff' + prelude.join('\r\n') + '\r\n' + script);
    return spawnSync(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
    ], { encoding: 'utf8', timeout: 60000 });
  }

  const cmdExit = (n) => `  Microsoft.PowerShell.Management\\Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -ArgumentList '/c exit ${n}' -PassThru -Wait`;
  const writeNew = `  [IO.File]::WriteAllText($pkg, '{"version":"9.9.9","description":"安卓应用运行器"}')`;
  const scenarios = [
    { name: '目录被清空', installer: ['Remove-Item -LiteralPath $dst -Recurse -Force', cmdExit(0)], rollback: 'restored' },
    { name: '退出非零，即使版本正确', installer: [writeNew, cmdExit(1)], rollback: 'restored' },
    { name: '退出为零，但无版本文件', installer: ['Remove-Item -LiteralPath $pkg', cmdExit(0)], rollback: 'restored' },
    { name: '退出为零，但版本文件损坏', installer: ["[IO.File]::WriteAllText($pkg, '{')", cmdExit(0)], rollback: 'restored' },
    { name: '无法启动安装器', installer: ["throw 'fixture launch failure'"], rollback: 'restored' },
    { name: '备份复制失败', installer: [writeNew, cmdExit(0)], failCopy: 1, rollback: 'not-attempted' },
    { name: '回滚复制失败', installer: [writeNew, cmdExit(1)], failCopy: 2, rollback: 'unverified' },
    { name: '失败记录无法落盘', installer: ["[void](New-Item -ItemType Directory -Path (Join-Path (Split-Path $log) 'failed.json'))", cmdExit(1)], rollback: 'restored', failMarker: true },
    { name: '退出为零且版本匹配', installer: [writeNew, cmdExit(0)] },
  ];

  if (process.platform !== 'win32') console.log('  跳过：需要 Windows PowerShell 与 robocopy');
  for (const row of process.platform === 'win32' ? scenarios : []) {
    await test(`★ 安装版更新：${row.name}`, () => {
      const root = mkTmp();
      try {
        const u = mkUpdater(root);
        const pkg = path.join(u.installDir, 'resources', 'app', 'package.json');
        const runtime = path.join(u.installDir, 'resources', 'runtime');
        const pending = path.join(u.updateDir, 'pending.json');
        const failure = path.join(u.updateDir, 'failed.json');
        const downloadDir = path.join(u.updateDir, '9.9.9');
        const earlierBackup = 'backup-9.9.9-earlier';
        fs.mkdirSync(path.dirname(pkg), { recursive: true });
        fs.mkdirSync(runtime, { recursive: true });
        fs.mkdirSync(downloadDir, { recursive: true });
        fs.mkdirSync(path.join(u.updateDir, earlierBackup));
        fs.writeFileSync(u.exePath, 'fixture old exe');
        fs.writeFileSync(pkg, '{"version":"0.6.2"}');
        fs.writeFileSync(path.join(runtime, 'big.bin'), 'runtime fixture');
        const payload = fakeExe(path.join(downloadDir, 'ApkStart-9.9.9-Setup.exe'));
        const script = u.apply({ mode: 'setup', payload, version: '9.9.9' }, { spawn: false });
        const r = runInstallFixture(root, script, row.installer, row.failCopy);
        const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
        eq(r.status, row.rollback ? 1 : 0, `${log}\n${r.error || r.stderr}`);
        eq(log.includes('fixture installer'), row.failCopy !== 1, '应只在备份检查通过后启动安装器');
        eq(log.includes('fixture restart'), row.rollback !== 'unverified', '未确认回滚时不得重启');
        eq(fs.existsSync(payload), !!row.rollback, '仅成功时清理下载的安装包');
        eq(fs.existsSync(pending), !!row.rollback, '仅成功时清理待安装凭条');
        eq(fs.existsSync(failure) && fs.statSync(failure).isFile(), !!row.rollback && !row.failMarker, '能写标记时应提供可读的失败记录');
        if (row.failMarker) assert(log.includes('could not write update failure marker'), '应记录写入失败');
        assert(fs.existsSync(path.join(u.updateDir, earlierBackup)), '不得清理上一次尝试的恢复目录');
        if (row.rollback) {
          const backupName = fs.readdirSync(u.updateDir).find(name => /^backup-9\.9\.9-[0-9a-f]{16}$/.test(name));
          if (!row.failMarker) {
            const info = JSON.parse(fs.readFileSync(failure, 'utf8'));
            eq(info.version, '9.9.9');
            eq(info.rollback, row.rollback);
            if (row.failCopy !== 1) eq(info.backup, path.join(u.updateDir, backupName));
          }
          if (row.failCopy !== 1) {
            const backup = path.join(u.updateDir, backupName);
            const backedUpPkg = path.join(backup, 'resources', 'app', 'package.json');
            eq(JSON.parse(fs.readFileSync(backedUpPkg, 'utf8')).version, '0.6.2');
            assert(!fs.existsSync(path.join(backup, 'resources', 'runtime')), '安装备份不应重复复制运行时');
          }
        } else {
          eq(fs.readdirSync(u.updateDir).filter(name => name.startsWith('backup-')).join(','), earlierBackup);
        }
        const expected = !row.rollback || row.rollback === 'unverified' ? '9.9.9' : '0.6.2';
        eq(JSON.parse(fs.readFileSync(pkg, 'utf8')).version, expected, '检查安装目录中的最终版本');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  console.log('\n[升级脚本启动：必须比 App 活得久（0.6.15 用户现场）]');

  /**
   * 用户现场：点「重启并安装」后 update.log 只有一行 `updater start`，再无下文。
   * 根因是 PowerShell 被挂成 App 的子进程，App 退出把它一起带走了。
   * 所以这里钉死三件事：
   *   1) 脚本落到磁盘时带 BOM（-File 读取时中文路径不会按 GBK 读坏）；
   *   2) 生成 apply.cmd 启动器，交给 explorer / 调用方 launch 去拉起；
   *   3) 脚本有心跳行，下次启动能把「根本没跑起来」和「跑了但装失败」分开。
   */
  await test('★ apply 写出带 BOM 的脚本 + .cmd 启动器（不再依赖子进程继承）', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    let r;
    if (process.platform === 'win32') {
      r = u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, {
        launch: (cmdPath) => { eq(path.basename(cmdPath), 'apply.cmd', '应把 .cmd 启动器交给调用方'); return 'ok'; },
      });
    } else {
      // Linux 只验证 Windows 脚本的落盘内容；真正的启动器由 Windows 专属路径负责。
      u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false });
      u._writeLauncher(path.join(u.updateDir, 'apply.cmd'), path.join(u.updateDir, 'apply.log.ps1'));
      r = { ok: true, via: 'test' };
    }
    eq(r.ok, true, 'apply 应返回成功');
    if (process.platform === 'win32') eq(r.via, 'shell', '有 launch 回调时应优先走它');
    const ps1 = path.join(u.updateDir, 'apply.log.ps1');
    const raw = fs.readFileSync(ps1, 'utf8');
    eq(raw.charCodeAt(0), 0xfeff, '脚本必须以 UTF-8 BOM 开头');
    assert(/app exited, applying/.test(raw), '脚本要有「等到 App 退出」的心跳行');
    assert(/pending\.json/.test(raw), '成功后要清掉待安装凭条');
    const cmd = fs.readFileSync(path.join(u.updateDir, 'apply.cmd'), 'utf8');
    assert(/start "" \/b /.test(cmd), 'cmd 启动器要用 start /b 拉起 PowerShell');
    assert(cmd.includes('apply.log.ps1'), 'cmd 启动器要指向 apply.log.ps1');
  });

  await test('★ pendingApply：脚本根本没跑起来 → stalled（这正是用户现场）', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false });
    // 现场日志：只有 updater start
    fs.writeFileSync(path.join(u.updateDir, 'update.log'), '[18:55:53] updater start\r\n', 'utf8');
    const p = u.pendingApply();
    eq(p.state, 'stalled', '只有 updater start 时应判为「脚本没跑起来」');
    eq(p.version, '9.9.9', '应带出目标版本');
    assert(p.payload && p.payload.endsWith('Setup.exe'), '应带出安装包路径供手动安装');
  });

  await test('pendingApply：脚本跑过但装失败 → failed', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false });
    fs.writeFileSync(path.join(u.updateDir, 'update.log'),
      '[18:55:53] updater start\r\n[18:55:55] app exited, applying\r\n[18:56:10] installer exit 1\r\n', 'utf8');
    eq(u.pendingApply().state, 'failed', '有心跳但没装成功时应判 failed');
  });

  await test('pendingApply：版本已追平 → none 并清掉凭条', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false });
    // 已经升到 9.9.9 了
    u.current = '9.9.9';
    eq(u.pendingApply().state, 'none');
    assert(!fs.existsSync(path.join(u.updateDir, 'pending.json')), '追平后凭条应被清理');
  });

  await test('非 Windows 不尝试启动 Windows 更新器', async () => {
    if (process.platform === 'win32') return;
    const root = mkTmp();
    const u = mkUpdater(root);
    let launched = false;
    await expectThrow(
      () => u._launch(path.join(root, 'apply.cmd'), path.join(root, 'apply.log.ps1'), {
        launch: () => { launched = true; return 'ok'; },
      }),
      /Windows|平台/,
      '非 Windows 平台应明确拒绝 Windows 更新启动器',
    );
    assert(!launched, '非 Windows 平台不应调用 Windows 的 launch 回调');
  });

  await test('launch 回调失败时会退到 explorer / spawn，三级都失败才抛错', async () => {
    if (process.platform !== 'win32') return;
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    const r = u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, {
      launch: () => 'no handler',
    });
    // explorer 与 spawn 都是 best-effort，能起来就行；这里只要求「不抛错且给了 via」
    assert(r.ok === true && typeof r.via === 'string', '应当给出实际使用的启动方式');
  });

  console.log(`\n更新器安全测试：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

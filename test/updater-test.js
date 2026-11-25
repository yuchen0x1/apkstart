'use strict';
/**
 * 更新器安全测试：路径穿越、绝对路径、符号链接、CRC 损坏、载荷校验、失败回滚脚本。
 * 这些用例都是「构造真实字节流的恶意 ZIP」，不是假装失败的桩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { windowsPowerShellEnv } = require('./lib/windows-powershell-env');

// download/proxy 会间接载入 store；即使模块初始化查询数据目录也只能看到临时 fixture。
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upd-home-'));
process.env.APPDATA = fixtureHome;
process.env.XDG_DATA_HOME = fixtureHome;
process.once('exit', () => fs.rmSync(fixtureHome, { recursive: true, force: true }));

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

const tmpRoots = [];
function mkTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upd-'));
  tmpRoots.push(root);
  return root;
}

function portablePayload(dir, version = '1.2.3') {
  fs.mkdirSync(path.join(dir, 'resources', 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ApkStart.exe'), 'MZ-new');
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'package.json'), JSON.stringify({ version, main: 'src/main.js' }));
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'src', 'main.js'), 'code-new');
}

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

/** 原样执行替换逻辑，只 stub 宿主进程操作；所有文件都在临时 fixture 下。 */
function runPortableFixture(root, script, fault = '') {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const fixture = path.join(root, 'portable-fixture.ps1');
  const prelude = [
    'function Wait-Process {}',
    'function Get-Process {}',
    'function Stop-Process { throw "unexpected stop" }',
    'function Start-Sleep {}',
    'function Start-Process { param($FilePath); Note ("fixture restart: " + $FilePath) }',
    `$script:fault = '${fault}'`,
    '$script:transient = $false',
    'function Copy-Item {',
    '  [CmdletBinding()] param([string]$LiteralPath, [string]$Destination, [switch]$Force)',
    '  $source = [IO.Path]::GetFullPath($LiteralPath)',
    // .NET Framework 可将 RUNNER~1 展开为长路径；比较两侧必须使用相同的规范化。
    '  $fromPayload = $source.StartsWith([IO.Path]::GetFullPath($src) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)',
    '  $fromBackup = $source.StartsWith([IO.Path]::GetFullPath($bak) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)',
    '  $main = $source.EndsWith("src\\main.js")',
    '  if ($script:fault -eq "unchanged-copy-error" -and ($fromPayload -or $fromBackup)) { Write-Error "fixture unchanged file denied"; return }',
    '  if ($script:fault -eq "backup-error" -and -not $fromPayload -and -not $fromBackup -and $main) { Write-Error "fixture backup error"; return }',
    '  if ($script:fault -eq "rollback-error" -and $fromBackup) { Write-Error "fixture rollback error"; return }',
    '  if ($fromPayload -and $main) {',
    '    if ($script:fault -eq "same-size-old") { return }',
    '    if ($script:fault -in @("copy-error", "rollback-error", "marker-error")) { Write-Error "fixture non-terminating copy error"; return }',
    '    if ($script:fault -eq "transient" -and -not $script:transient) { $script:transient = $true; Write-Error "fixture transient error"; return }',
    '  }',
    '  Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force -ErrorAction Stop',
    '  if ($fromPayload -and $source.EndsWith("app\\package.json")) {',
    '    if ($script:fault -eq "missing-package") { Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $Destination -Force -ErrorAction Stop }',
    `    if ($script:fault -eq "wrong-version") { [IO.File]::WriteAllText($Destination, '{"version":"0.0.1","main":"src/main.js"}') }`,
    '  }',
    '}',
  ];
  fs.writeFileSync(fixture, '\ufeff' + prelude.join('\r\n') + '\r\n' + script);
  return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', fixture], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, env: windowsPowerShellEnv(),
  });
}

function windowsFixturesAllowed() {
  if (process.platform !== 'win32') {
    console.log('  跳过隔离脚本执行：需要 Windows PowerShell 与 robocopy');
    return false;
  }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const probe = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    '@{ policy = [string](Get-ExecutionPolicy); language = [string]$ExecutionContext.SessionState.LanguageMode } | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: windowsPowerShellEnv() });
  assert(probe.status === 0, `无法探测 PowerShell 策略：${probe.error || probe.stderr}`);
  const info = JSON.parse(probe.stdout.trim());
  if (info.language !== 'FullLanguage' || !['RemoteSigned', 'Unrestricted', 'Bypass'].includes(info.policy)) {
    console.log(`  跳过隔离脚本执行：PowerShell ${info.policy}/${info.language}；不覆盖执行策略或语言限制`);
    return false;
  }
  return true;
}

async function main() {
  await test('Windows PowerShell 子进程仅重建模块路径，不污染父环境或改变策略限制', () => {
    const source = Object.freeze({
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      pSmOdUlEpAtH: 'other inherited modules',
      PSExecutionPolicyPreference: 'Restricted',
      __PSLockdownPolicy: '4',
      PATH: 'original path',
      SystemRoot: 'C:\\Windows',
    });
    const before = JSON.stringify(source);
    const env = windowsPowerShellEnv(source);
    assert(env !== source, '必须创建独立子进程环境');
    assert(!Object.keys(env).some(key => key.toLowerCase() === 'psmodulepath'), '应删除全部大小写变体');
    eq(Object.keys(env).length, Object.keys(source).length - 2, '只移除模块路径');
    for (const key of ['PSExecutionPolicyPreference', '__PSLockdownPolicy', 'PATH', 'SystemRoot']) {
      eq(env[key], source[key], `${key} 必须原样保留`);
    }
    eq(JSON.stringify(source), before, '不得修改传入的父环境');
  });

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
    portablePayload(inner, '1.0.0');
    const u = mkUpdater(root);
    u._flattenPayload(dir);
    u._assertPayload(dir, { version: '1.0.0' });
    assert(fs.existsSync(path.join(dir, 'ApkStart.exe')), '应摊平到载荷根');
    assert(!fs.existsSync(inner), '内层目录应被移除');
  });

  for (const row of [
    { name: '缺少 package.json', pkg: null, error: /package\.json/ },
    { name: 'package.json 损坏', pkg: '{', error: /package\.json/ },
    { name: '缺少 version', pkg: '{}', error: /版本不匹配/ },
    { name: 'version 非字符串', pkg: '{"version":123}', error: /版本不匹配/ },
    { name: '目标版本不匹配', pkg: '{"version":"1.2.2"}', error: /版本不匹配/ },
  ]) {
    await test(`便携载荷校验：${row.name}，不生成替换脚本`, async () => {
      const root = mkTmp();
      const payload = path.join(root, 'payload');
      portablePayload(payload);
      const pkg = path.join(payload, 'resources', 'app', 'package.json');
      if (row.pkg === null) fs.rmSync(pkg); else fs.writeFileSync(pkg, row.pkg);
      const u = mkUpdater(root);
      await expectThrow(() => u.apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false }), row.error);
      assert(!fs.existsSync(path.join(u.updateDir, 'apply.log.ps1')), '异常载荷不能交给外部替换脚本');
      assert(fs.existsSync(payload), '前置拒绝不删除可排查的载荷');
    });
  }

  await test('asar:false 载荷清单逐一固定 EXE、应用代码/资源的大小和 SHA-256，排除 runtime/数据', () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    portablePayload(payload);
    const u = mkUpdater(root);
    u.dataDir = path.join(u.installDir, 'user-data');
    for (const rel of ['resources/runtime/avd/user.img', 'user-data/apps.json', 'resources/app/src/.hidden.js', 'resources/app/src/界面[1].js']) {
      fs.mkdirSync(path.dirname(path.join(payload, rel)), { recursive: true });
      fs.writeFileSync(path.join(payload, rel), rel);
    }
    const files = u._assertPayload(payload, { version: 'v1.2.3' });
    eq(files.length, 5, 'EXE、package.json、主代码和两个额外代码文件');
    for (const entry of files) {
      const bytes = fs.readFileSync(path.join(payload, entry.path));
      eq(entry.size, bytes.length);
      eq(entry.sha256, require('crypto').createHash('sha256').update(bytes).digest('hex'));
      assert(!/^(resources\/runtime|user-data)\//i.test(entry.path), '用户内容不属于程序清单');
    }
    assert(!fs.existsSync(path.join(payload, 'resources', 'app.asar')), '实际使用 asar:false fixture');
  });

  await test('已验签便携包固定文件摘要，同大小改写代码不能通过 apply，也不重新下载', async () => {
    const root = mkTmp();
    const crypto = require('crypto');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const u = mkUpdater(root, { publicKey });
    const version = '9.9.9';
    const dir = path.join(u.updateDir, version);
    fs.mkdirSync(dir, { recursive: true });
    const { repo, assetNames } = require('../src/core/release-manifest');
    const name = assetNames('v' + version).portable;
    const zip = writeZip(path.join(dir, name), [
      { name: 'ApkStart.exe', data: 'MZ-new' },
      { name: 'resources/app/package.json', data: JSON.stringify({ version }) },
      { name: 'resources/app/src/main.js', data: 'code-new' },
    ]);
    const size = fs.statSync(zip).size;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const data = Buffer.from(JSON.stringify({ schema: 1, repository: repo, tag: 'v' + version,
      assets: [{ name, size, sha256: hash }] }));
    const sig = crypto.sign(null, data, privateKey).toString('base64');
    const info = { version, tag: 'v' + version, manifestKind: 'legacy',
      proof: '<!-- apkstart-manifest ' + data.toString('base64') + ' ' + sig + ' -->',
      asset: { name, size, digest: 'sha256:' + hash, url: repo + '/releases/download/v' + version + '/' + name } };
    u.sources.rank = () => { throw new Error('fixture must not access network'); };
    const job = await u.prepare(info);
    eq(job.files.length, 3, '摘要来自已验签并解压校验的载荷');
    u.apply(job, { spawn: false });
    fs.rmSync(path.join(u.updateDir, 'apply.log.ps1'));
    fs.writeFileSync(path.join(job.payload, 'resources', 'app', 'src', 'main.js'), 'code-old');
    await expectThrow(() => u.apply(job, { spawn: false }), /SHA-256/);
    assert(!fs.existsSync(path.join(u.updateDir, 'apply.log.ps1')), '同大小代码被改写后不能生成脚本');
    assert(fs.existsSync(zip) && fs.existsSync(job.payload), '拒绝时保留载荷和原始 ZIP');
  });

  await test('Updater.prepare 使用顺序下载线路，并在安装前继续校验签名资产', async () => {
    const root = mkTmp();
    const crypto = require('crypto');
    const http = require('http');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const version = '9.9.9';
    const { repo, assetNames } = require('../src/core/release-manifest');
    const name = assetNames('v' + version).portable;
    const archive = writeZip(path.join(root, name), [
      { name: 'ApkStart.exe', data: 'MZ-new' },
      { name: 'resources/app/package.json', data: JSON.stringify({ version }) },
      { name: 'resources/app/src/main.js', data: 'code-new' },
    ]);
    const bytes = fs.readFileSync(archive);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const proofData = Buffer.from(JSON.stringify({
      schema: 1, repository: repo, tag: 'v' + version,
      assets: [{ name, size: bytes.length, sha256: hash }],
    }));
    const signature = crypto.sign(null, proofData, privateKey).toString('base64');
    const info = {
      version, tag: 'v' + version, manifestKind: 'legacy',
      proof: `<!-- apkstart-manifest ${proofData.toString('base64')} ${signature} -->`,
      asset: {
        name, size: bytes.length, digest: `sha256:${hash}`,
        url: `${repo}/releases/download/v${version}/${name}`,
      },
    };

    let requests = 0;
    let authorizationSeen = false;
    const server = http.createServer((req, res) => {
      requests += 1;
      authorizationSeen ||= Boolean(req.headers.authorization);
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range && range[1] === '0' && range[2] === '0') {
        res.writeHead(206, {
          'Content-Length': 1,
          'Content-Range': `bytes 0-0/${bytes.length}`,
          ETag: '"updater-fixture"',
        });
        res.end(bytes.subarray(0, 1));
        return;
      }
      res.writeHead(200, { 'Content-Length': bytes.length, ETag: '"updater-fixture"' });
      res.end(bytes);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const u = mkUpdater(root, { publicKey });
      const localUrl = `http://127.0.0.1:${server.address().port}/release.zip`;
      u.sources.releaseDownloadRoutes = () => [{
        source: 'github', name: 'GitHub official', url: localUrl,
      }];
      const job = await u.prepare(info);
      eq(job.version, version);
      eq(job.mode, 'zip');
      eq(job.sha256, hash);
      assert(requests >= 2, 'must probe and download the signed release payload');
      eq(authorizationSeen, false);
      assert(fs.existsSync(job.payload), 'only the verified payload is returned for installation');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('apply 前置校验：载荷不存在时直接拒绝，不生成脚本', async () => {
    const root = mkTmp();
    const u = mkUpdater(root);
    await expectThrow(async () => u.apply({ mode: 'zip', payload: path.join(root, 'nope'), version: '1.0.0' }, { spawn: false }), /载荷不存在/);
  });

  await test('apply 生成的替换脚本包含备份与回滚步骤', async () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    portablePayload(payload);
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false });
    assert(/\$bak/.test(script), '应有备份路径变量');
    assert(/rolling back/.test(script), '应有回滚分支');
    assert(/Copy-Item -LiteralPath \(Program-Path \$bak/.test(script), '失败时应逐文件从备份还原');
    assert(/exit 1/.test(script), '失败应返回非 0 退出码');
    // 脚本能被写出来给人工排查，但不能包含未转义的单引号拼接
    assert(!/\$dst = ''/.test(script), '路径应为非空字面量');
  });

  await test('便携版替换脚本语法可解析（SHA-256、版本和带引号/中文路径）', async () => {
    const root = path.join(mkTmp(), "夹具 ' [portable]");
    const payload = path.join(root, 'payload');
    portablePayload(payload);
    fs.writeFileSync(path.join(payload, 'resources', 'app.asar'), 'asar');
    fs.writeFileSync(path.join(payload, 'resources', 'app', 'src', "带'引号[1].js"), 'quoted');
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false });
    // 上游 #98：asar:false 时，EXE/可选 ASAR 与散装应用文件都必须逐项核对摘要。
    assert(/Get-FileHash -LiteralPath .* -Algorithm SHA256 -ErrorAction Stop/.test(script), '应使用 SHA-256');
    assert(/\$actual\.size -ne \$entry\.size/.test(script), '要按大小核对每个新文件');
    assert(script.includes('resources/app/src/main.js') && script.includes('resources/app/package.json'), '应覆盖散装代码和版本文件');
    assert(script.includes('resources/app.asar'), '包里存在 ASAR 时也不得跳过校验');
    assert(/Read-Version \(Join-Path \$dst \$pkgRel\)\) -cne \$want/.test(script), '必须核对目标版本');
    assert(/relaunched \(rolled back\)/.test(script), '复制失败回滚后要把旧版本拉起来');
    const file = path.join(root, 'apply-check.ps1');
    fs.writeFileSync(file, script, 'utf8');
    const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const env = process.platform === 'win32' ? windowsPowerShellEnv() : process.env;
    const probe = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8', timeout: 30000, env,
    });
    if (probe.error && probe.error.code === 'ENOENT') {
      console.log('  跳过：当前环境未提供 ' + powershell + ' 语法解析器');
      return;
    }
    assert(!probe.error, '无法启动 ' + powershell + ': ' + (probe.error ? probe.error.message : ''));
    const r = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      `$err = $null; [void][System.Management.Automation.Language.Parser]::ParseInput(([IO.File]::ReadAllText('${file.replace(/'/g, "''")}', [Text.Encoding]::UTF8)), [ref]$null, [ref]$err); if ($err -and $err.Count) { exit 1 }`,
    ], { encoding: 'utf8', timeout: 30000, env });
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

  await test('便携脚本：非终止复制错误必须失败，完整备份后才覆盖，回滚也须逐项校验', () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    portablePayload(payload);
    const script = mkUpdater(root).apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false });
    const copies = script.split('\r\n').filter(line => /Copy-Item/.test(line));
    eq(copies.length, 3, '备份、安装、回滚均逐文件复制');
    assert(copies.every(line => /-LiteralPath/.test(line) && /-ErrorAction Stop/.test(line)), '不能静默吞掉非终止复制错误或展开通配符');
    assert(script.indexOf("throw 'backup verification failed'") < script.indexOf('$copyStarted = $true'), '备份完整性通过前不得覆盖');
    assert(script.includes('Test-Files $dst $files'), '成功依赖每个目标程序文件，而非 EXE 存在');
    assert(script.includes('Test-Files $dst $original'), '回滚成功依赖每个原文件的哈希和大小');
    assert(script.includes("$rollback = 'unverified'") && script.includes("$rollback = 'restored'"), '必须分别标记真实回滚结果');
    assert(/foreach \(\$rel in \$missing\)[\s\S]*Remove-Item -LiteralPath \$target -Force -ErrorAction Stop/.test(script), '回滚清理本轮新增文件');
    assert(!/Remove-Item -LiteralPath \$target[^\r\n]*-Recurse/.test(script), '不得递归清除用户目录');
    assert(script.includes('ReparsePoint'), '已有联接点不能让逐文件复制越过目标边界');
  });

  await test('便携脚本：失败保留载荷/备份/凭条，成功清理严格位于完整验证之后', () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    portablePayload(payload);
    const script = mkUpdater(root).apply({ mode: 'zip', payload, version: '1.2.3' }, { spawn: false });
    const rollback = script.slice(script.indexOf('if (-not $ok -and $copyStarted)'), script.indexOf('if ($ok) {'));
    assert(!/Remove-Item -LiteralPath \$(src|bak)/.test(rollback), '失败回滚不能删除恢复材料');
    assert(/if \(\$ok\) \{\r\n  Remove-Item -LiteralPath \$bak -Recurse -Force\r\n  Remove-Item -LiteralPath \$src -Recurse -Force/.test(script));
    assert(/if \(-not \$ok\) \{ exit 1 \}[\s\S]*Remove-Item -LiteralPath/.test(script), '失败退出必须位于下载目录清理之前');
    assert(/version = \$want; log = \$log; rollback = \$rollback; backup = \$bak; payload = \$src; error = \$reason/.test(script), '失败记录须包含真实恢复状态和保留路径');
    assert(script.includes('[IO.File]::WriteAllText('), '失败标记无 BOM，主进程可直接 JSON.parse');
    assert(script.includes("$canRestart = $false\r\n  $rollback = 'unverified'"), '回滚未验证时不能启动半新半旧程序');
  });

  await test('便携手动重试使用独立备份；同版本自动重试跨实例阻止，复制次数有限', () => {
    const root = mkTmp();
    const payload = path.join(root, 'payload');
    portablePayload(payload);
    const u = mkUpdater(root);
    const job = { mode: 'zip', payload, version: '1.2.3' };
    const first = u.apply(job, { spawn: false });
    const firstBak = first.match(/^\$bak = '([^']+)'/m)[1];
    fs.mkdirSync(firstBak, { recursive: true });
    fs.writeFileSync(path.join(firstBak, 'recover.txt'), 'earlier recovery material');
    const second = u.apply(job, { spawn: false });
    const secondBak = second.match(/^\$bak = '([^']+)'/m)[1];
    assert(firstBak !== secondBak, '重试不能覆盖之前的恢复备份');
    eq(fs.readFileSync(path.join(firstBak, 'recover.txt'), 'utf8'), 'earlier recovery material');
    assert(new Updater({ dataDir: u.dataDir }).autoApplyBlocked('v1.2.3'), '失败标记尚未写入也能持久阻止自动循环');
    eq(u.autoApplyBlocked('1.2.4'), false, '新版本仍可自动更新');
    eq(JSON.parse(fs.readFileSync(path.join(u.updateDir, 'auto-attempts.json'))).versions.length, 1);
    assert(second.includes('for ($i = 1; $i -le 12; $i++)') && second.includes('if ($i -lt 12)'), '只允许有限重试，最后一次失败不继续等待');
    assert(!/while\s*\(\$true\)/i.test(second), '不得无限复制重试');
  });

  console.log('\n[便携更新：仅临时 fixture，策略允许时执行 PowerShell]');
  const canRunPowerShellFixtures = windowsFixturesAllowed();
  const portableScenarios = [
    { name: 'asar:false 全部文件与目标版本匹配' },
    { name: '同大小旧代码被静默遗漏', fault: 'same-size-old', rollback: 'restored', passes: 12 },
    { name: '非终止部分复制错误', fault: 'copy-error', rollback: 'restored', passes: 12 },
    { name: '临时复制失败第二次成功', fault: 'transient', passes: 1 },
    { name: '目标 package.json 未写入', fault: 'missing-package', rollback: 'restored', passes: 12 },
    { name: '目标 version 仍是旧版', fault: 'wrong-version', rollback: 'restored', passes: 12 },
    { name: '备份复制失败不覆盖原程序', fault: 'backup-error', rollback: 'not-attempted' },
    { name: '载荷在生成脚本之后被同大小改写', fault: 'payload-changed', rollback: 'not-attempted' },
    { name: '复制/回滚均报错但原文件确未变化仍可重启旧版', fault: 'unchanged-copy-error', rollback: 'restored', passes: 12 },
    { name: '回滚复制失败如实标记且不启动混合版本', fault: 'rollback-error', rollback: 'unverified', passes: 12 },
    { name: '失败标记无法写入仍阻止自动循环', fault: 'marker-error', rollback: 'restored', passes: 12 },
  ];
  for (const row of canRunPowerShellFixtures ? portableScenarios : []) {
    await test(`便携更新：${row.name}`, () => {
      const root = path.join(mkTmp(), "portable ' [夹具]");
      const u = mkUpdater(root);
      u.dataDir = path.join(u.installDir, 'user-data');
      const version = '1.2.3';
      const downloadDir = path.join(u.updateDir, version);
      const payload = path.join(downloadDir, 'payload');
      portablePayload(u.installDir, '0.0.1');
      portablePayload(payload, version);
      fs.writeFileSync(u.exePath, 'MZ-old');
      const mainRel = path.join('resources', 'app', 'src', 'main.js');
      fs.writeFileSync(path.join(u.installDir, mainRel), 'code-old');
      // 新旧代码等大小、等修改时间；只比较存在/大小/时间都会误判。
      const sameTime = new Date('2026-01-01T00:00:00Z');
      for (const base of [u.installDir, payload]) fs.utimesSync(path.join(base, mainRel), sameTime, sameTime);
      const newOnly = path.join('resources', 'app', 'new-only.js');
      fs.writeFileSync(path.join(payload, newOnly), 'new file');
      fs.writeFileSync(path.join(payload, 'resources', 'app', 'src', "界面'[1].js"), 'quoted code');
      const protectedFiles = ['resources/runtime/avd/user.img', 'user-data/apps.json', 'legacy.txt'];
      for (const rel of protectedFiles) {
        fs.mkdirSync(path.dirname(path.join(u.installDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(u.installDir, rel), 'keep ' + rel);
        if (rel !== 'legacy.txt') {
          fs.mkdirSync(path.dirname(path.join(payload, rel)), { recursive: true });
          fs.writeFileSync(path.join(payload, rel), 'must not overwrite user contents');
        }
      }
      const zip = path.join(downloadDir, 'fixture.zip');
      fs.writeFileSync(zip, 'retained source archive');
      const earlier = path.join(u.updateDir, 'backup-earlier');
      fs.mkdirSync(earlier, { recursive: true });
      fs.writeFileSync(path.join(earlier, 'recovery.txt'), 'earlier attempt');
      const files = u._assertPayload(payload, { version });
      const script = u.apply({ mode: 'zip', payload, version, files }, { spawn: false });
      if (row.fault === 'payload-changed') fs.writeFileSync(path.join(payload, mainRel), 'code-bad');
      const failure = path.join(u.updateDir, 'failed.json');
      if (row.fault === 'marker-error') fs.mkdirSync(failure);
      const r = runPortableFixture(root, script, row.fault);
      const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
      eq(r.status, row.rollback ? 1 : 0, `${log}\n${r.error || r.stderr}`);
      eq((log.match(/copy pass \d+ failed/g) || []).length, row.passes || 0, '重试次数有限且成功立即停止');
      eq(log.includes('fixture restart:'), row.rollback !== 'unverified', '只启动已验证的新程序或恢复后的旧程序');
      eq(fs.existsSync(payload), !!row.rollback, '失败不得删除载荷');
      eq(fs.existsSync(zip), !!row.rollback, '失败不得清理源 ZIP');
      eq(fs.existsSync(path.join(u.updateDir, 'pending.json')), !!row.rollback, '只在成功后清理待安装凭条');
      assert(new Updater({ dataDir: u.dataDir }).autoApplyBlocked(version), '跨实例阻止同版本自动重试');
      assert(!u.autoApplyBlocked('1.2.4'), '新版本不受阻止');
      eq(fs.readFileSync(path.join(earlier, 'recovery.txt'), 'utf8'), 'earlier attempt', '不得清理或覆盖上一次备份');
      for (const rel of protectedFiles) eq(fs.readFileSync(path.join(u.installDir, rel), 'utf8'), 'keep ' + rel, '用户内容应保持原样');
      if (row.rollback) {
        if (row.fault === 'marker-error') assert(log.includes('could not write update failure marker'));
        else {
          const marker = JSON.parse(fs.readFileSync(failure, 'utf8'));
          eq(marker.version, version);
          eq(marker.rollback, row.rollback);
          eq(marker.payload, payload);
          assert(marker.error, '失败记录应说明实际错误');
          if (row.rollback !== 'not-attempted') {
            assert(fs.existsSync(marker.backup), '失败备份必须保留');
            eq(fs.readFileSync(path.join(marker.backup, mainRel), 'utf8'), 'code-old');
            assert(!fs.existsSync(path.join(marker.backup, 'resources', 'runtime')), '不复制用户运行时');
          }
        }
        if (row.rollback !== 'unverified') {
          eq(fs.readFileSync(path.join(u.installDir, mainRel), 'utf8'), 'code-old');
          eq(fs.readFileSync(u.exePath, 'utf8'), 'MZ-old');
          eq(JSON.parse(fs.readFileSync(path.join(u.installDir, 'resources', 'app', 'package.json'))).version, '0.0.1');
          assert(!fs.existsSync(path.join(u.installDir, newOnly)), '回滚不得残留本次新增代码');
        }
      } else {
        assert(!fs.existsSync(failure), '成功不得留下失败记录');
        for (const entry of files) {
          const bytes = fs.readFileSync(path.join(u.installDir, entry.path));
          eq(bytes.length, entry.size);
          eq(require('crypto').createHash('sha256').update(bytes).digest('hex'), entry.sha256);
        }
        eq(fs.readdirSync(u.updateDir).filter(name => name.startsWith('backup-')).join(','), 'backup-earlier');
      }
    });
  }

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

  await test('apply(setup) 只会按出生凭据结束本程序残留进程（安装器拿不到文件锁会静默失败）', async () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    const script = u.apply({ mode: 'setup', payload: setup, version: '9.9.9', size: 409600 }, { spawn: false });
    // 裸 PID 会在 60 秒等待期内被系统复用，不能作为终止依据。
    assert(!/Stop-Process -Id/.test(script), '不得按 PID 直接强杀（可能误杀复用该 PID 的用户程序）');
    assert(/-Action Inspect -TargetPid \d+/.test(script), '启动时必须先记录本程序的出生凭据');
    assert(/-Action Terminate -TargetPid \d+ -Expected/.test(script), '超时后只能按出生凭据终止同一个进程');
    assert(/no verified identity; force stop skipped/.test(script), '身份不可验证时必须失败关闭，而不是硬杀');
    const inspectAt = script.indexOf('-Action Inspect');
    const stopAt = script.indexOf('-Action Terminate');
    const runAt = script.indexOf('run installer');
    assert(inspectAt > -1 && inspectAt < stopAt && stopAt < runAt, '先取证、再按凭据终止，最后才启动安装器');
    assert(/failed\.json/.test(script), '失败要落标记，下次启动告诉用户');
    assert(/payload kept for manual install/.test(script), '失败时应保留安装包，重试不用重下 1.4GB');
    assert(/if \(-not \$ok\) \{ exit 1 \}[\s\S]*Remove-Item -LiteralPath/.test(script), '验证未通过不得清除载荷');
  });

  await test('apply 在退出前先固化本程序完整身份，PID 复用/同目录另一实例都不能命中', () => {
    const root = mkTmp();
    const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
    const u = mkUpdater(root);
    const identity = {
      pid: 4321, started: '133900000000000000',
      exe: 'c:\\apps\\apkstart\\apkstart.exe',
      commandLine: '"C:\\apps\\ApkStart\\ApkStart.exe" --updated',
    };
    const script = u.apply({ mode: 'setup', payload: setup, version: '9.9.9', size: 409600 }, {
      spawn: false, waitPid: identity.pid, expectedIdentity: identity,
    });
    const encoded = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
    assert(script.includes(`$expectB64 = '${encoded}'`), '脚本必须带退出前捕获的完整身份');
    assert(/FromBase64String\(\$expectB64\)/.test(script), '脚本必须解码预期身份');
    assert(/\[string\]\$obj\.started -ceq \[string\]\$want\.started/.test(script), '出生时间必须精确比较');
    assert(/\[string\]\$obj\.exe -ieq \[string\]\$want\.exe/.test(script), '真实镜像路径必须比较');
    assert(/\[string\]\$obj\.commandLine -ceq \[string\]\$want\.commandLine/.test(script), '命令行必须精确比较');
    assert(/-Action Terminate -TargetPid 4321 -Expected/.test(script), '终止仍走同一份身份凭据');
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
      manifestKind: 'legacy',
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

  function runInstallFixture(root, script, installer, failCopy, denyParent) {
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
    if (denyParent) {
      const parent = `'${root.replace(/'/g, "''")}'`;
      prelude.push(
        "$ErrorActionPreference = 'Stop'",
        // 固定运行 Windows PowerShell 5.1 的 .NET Framework API，不受 pwsh 的 PSModulePath 影响。
        `$aclDir = [IO.DirectoryInfo]::new(${parent})`,
        '$aclAccess = [Security.AccessControl.AccessControlSections]::Access',
        '$savedDacl = $aclDir.GetAccessControl().GetSecurityDescriptorSddlForm($aclAccess)',
        '$parentAcl = $aclDir.GetAccessControl()',
        `$rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.AccessControl.FileSystemRights]::CreateDirectories, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)`,
      );
      // 仅修改此临时夹具父目录的 ACL；设置、探测及生成脚本均在 finally 的保护范围内。
      script = [
        'try {',
        '  $parentAcl.AddAccessRule($rule)',
        '  $aclDir.SetAccessControl($parentAcl)',
        `  $aclProbe = Join-Path ${parent} ('.fixture-acl-' + [guid]::NewGuid().ToString('N'))`,
        '  $denied = $false',
        '  try { [void][IO.Directory]::CreateDirectory($aclProbe) } catch [UnauthorizedAccessException] { $denied = $true }',
        "  if (-not $denied) { [IO.Directory]::Delete($aclProbe); throw 'fixture ACL deny not effective' }",
        "  Write-Output 'fixture ACL deny verified'",
        script,
        '} finally {',
        // 重新载入原 DACL，显式标记修改；原样 SetAccessControl(GetAccessControl()) 不会写回。
        '  $restoreAcl = $aclDir.GetAccessControl()',
        '  $restoreAcl.SetSecurityDescriptorSddlForm($savedDacl, $aclAccess)',
        '  $aclDir.SetAccessControl($restoreAcl)',
        "  if ($aclDir.GetAccessControl().GetSecurityDescriptorSddlForm($aclAccess) -cne $savedDacl) { throw 'fixture ACL restore mismatch' }",
        "  Write-Output 'fixture ACL restored'",
        '}',
      ].join('\r\n');
    }
    fs.writeFileSync(fixture, '\ufeff' + prelude.join('\r\n') + '\r\n' + script);
    return spawnSync(ps, [
      '-NoProfile', '-NonInteractive', '-File', fixture,
    ], { encoding: 'utf8', timeout: 60000, env: windowsPowerShellEnv() });
  }

  const cmdExit = (n) => `  Microsoft.PowerShell.Management\\Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -ArgumentList '/c exit ${n}' -PassThru -Wait`;
  const writeNew = `  [IO.File]::WriteAllText($pkg, '{"version":"9.9.9","description":"安卓应用运行器"}')`;
  const scenarios = [
    { name: '目录被清空', installer: ['Remove-Item -LiteralPath $dst -Recurse -Force', cmdExit(0)], rollback: 'restored' },
    { name: '退出非零，即使版本正确', installer: [writeNew, cmdExit(1)], rollback: 'restored' },
    { name: '退出为零，但无版本文件', installer: ['Remove-Item -LiteralPath $pkg', cmdExit(0)], rollback: 'restored' },
    { name: '退出为零，但版本文件损坏', installer: ["[IO.File]::WriteAllText($pkg, '{')", cmdExit(0)], rollback: 'restored' },
    { name: '无法启动安装器', installer: ["throw 'fixture launch failure'"], rollback: 'restored' },
    { name: '取消 UAC 不回写未变的原文件', installer: ['throw ([ComponentModel.Win32Exception]::new(1223))'], rollback: 'not-started', noRestore: true },
    { name: '原程序只读时不启动安装器', installer: [writeNew, cmdExit(0)], readonly: true, rollback: 'not-attempted' },
    { name: '可写安装目录但父目录不允许重建', installer: [writeNew, cmdExit(0)], denyParent: true, rollback: 'not-attempted' },
    { name: '备份复制失败', installer: [writeNew, cmdExit(0)], failCopy: 1, rollback: 'not-attempted' },
    { name: '回滚复制失败', installer: [writeNew, cmdExit(1)], failCopy: 2, rollback: 'unverified' },
    { name: '失败记录无法落盘', installer: ["[void](New-Item -ItemType Directory -Path (Join-Path (Split-Path $log) 'failed.json'))", cmdExit(1)], rollback: 'restored', failMarker: true },
    { name: '退出为零且版本匹配', installer: [writeNew, cmdExit(0)] },
  ];

  for (const row of canRunPowerShellFixtures ? scenarios : []) {
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
        if (row.readonly) fs.chmodSync(u.exePath, 0o444);
        fs.writeFileSync(pkg, '{"version":"0.6.2"}');
        fs.writeFileSync(path.join(runtime, 'big.bin'), 'runtime fixture');
        const payload = fakeExe(path.join(downloadDir, 'ApkStart-9.9.9-Setup.exe'));
        const script = u.apply({ mode: 'setup', payload, version: '9.9.9' }, { spawn: false });
        const r = runInstallFixture(root, script, row.installer, row.failCopy, row.denyParent);
        if (row.denyParent) {
          assert(r.stdout.includes('fixture ACL deny verified'), `父目录拒绝规则必须实际生效：${r.error || r.stderr}`);
          assert(r.stdout.includes('fixture ACL restored'), `必须读回确认原 DACL 已恢复：${r.error || r.stderr}`);
        }
        const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
        eq(r.status, row.rollback ? 1 : 0, `${log}\n${r.error || r.stderr}`);
        eq(log.includes('fixture installer'), row.failCopy !== 1 && !row.readonly && !row.denyParent, '应只在备份和写权限检查通过后启动安装器');
        if (row.noRestore) assert(!log.includes('rolling back'), '取消 UAC 不应改写安装目录');
        eq(new Updater({ dataDir: u.dataDir }).autoApplyBlocked('9.9.9'), true, '跨进程持久阻止同版本自动重试');
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

  console.log('\n[短路径：8.3 短名与解析长路径混用]');

  /** 直接取目录短名，避免 cmd 的二次引号解析改变返回路径。 */
  function shortPath(p) {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const code = `$ErrorActionPreference = 'Stop'; $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}').ShortPath; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($short))`;
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: windowsPowerShellEnv() });
    eq(r.status, 0, `${r.error || r.stderr}`);
    const result = Buffer.from(String(r.stdout || '').trim(), 'base64').toString('utf8');
    assert(path.isAbsolute(result) && !result.includes('"') && fs.statSync(result).isDirectory(), `无效的短路径：${result}`);
    return result;
  }

  for (const rollback of canRunPowerShellFixtures ? [false, true] : []) {
    const root = mkTmp();
    try {
      const short = shortPath(root);
      if (short.toLowerCase() === fs.realpathSync.native(root).toLowerCase()) {
        assert(!process.env.CI, 'Windows CI 必须实际执行 8.3 短名回归');
        console.log('  跳过：此卷没有 8.3 短名，未执行短路径回归');
        continue;
      }
      await test(`★ 8.3 短名备份根与长名子项：${rollback ? '失败后恢复' : '成功安装'}（CI RUNNER~1 回归）`, () => {
        const u = mkUpdater(short);
        const pkg = path.join(u.installDir, 'resources', 'app', 'package.json');
        const downloadDir = path.join(u.updateDir, '9.9.9');
        const emptyDir = path.join(u.installDir, 'resources', 'empty folder');
        fs.mkdirSync(path.dirname(pkg), { recursive: true });
        fs.mkdirSync(emptyDir);
        fs.mkdirSync(downloadDir, { recursive: true });
        fs.writeFileSync(u.exePath, 'fixture old exe');
        fs.writeFileSync(pkg, '{"version":"0.6.2"}');
        const payload = fakeExe(path.join(downloadDir, 'ApkStart-9.9.9-Setup.exe'));
        let script = u.apply({ mode: 'setup', payload, version: '9.9.9' }, { spawn: false });
        // 确认真实 PowerShell 文件系统提供程序确实触发旧偏移缺陷，不只比较 Node/COM 路径。
        const rootLine = '    $bakRoot = (Get-Item -LiteralPath $bak -Force -ErrorAction Stop).FullName';
        assert(script.includes(rootLine), '应能定位备份根解析语句');
        script = script.replace(rootLine, [rootLine,
          "    $items = @(Get-ChildItem -LiteralPath $bak -Recurse -Force -ErrorAction Stop | Where-Object { $_.Name -in @('package.json', 'empty folder') })",
          "    if ($items.Count -ne 2) { throw 'fixture missing file or empty directory' }",
          '    foreach ($item in $items) {',
          "      $expected = if ($item.Name -eq 'package.json') { 'resources\\app\\package.json' } else { 'resources\\empty folder' }",
          "      if ($item.FullName.Substring($bakRoot.Length).TrimStart('\\') -cne $expected) { throw 'fixture resolved root mismatch' }",
          "      if ($item.FullName.Substring($bak.Length).TrimStart('\\') -ceq $expected) { throw 'fixture did not exercise old offset defect' }",
          '    }',
          "    Note 'fixture short/long mismatch verified'",
        ].join('\r\n'));
        const r = runInstallFixture(root, script, rollback ? ['Remove-Item -LiteralPath $dst -Recurse -Force', cmdExit(1)] : [writeNew, cmdExit(0)]);
        const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
        eq(r.status, rollback ? 1 : 0, `${log}\n${r.error || r.stderr}`);
        assert(log.includes('backup ok=True'), `短名备份必须判为成功：${log}`);
        assert(log.includes('fixture short/long mismatch verified'), '文件与空目录均必须实际触发旧偏移缺陷');
        assert(log.includes('fixture installer'), '写权限预检误判会让安装器根本不运行');
        assert(log.includes('fixture restart'), '成功安装或已确认恢复后应允许重启');
        eq(JSON.parse(fs.readFileSync(pkg, 'utf8')).version, rollback ? '0.6.2' : '9.9.9');
        assert(fs.statSync(emptyDir).isDirectory(), '应保留或恢复空目录');
        eq(fs.existsSync(payload), rollback, '仅成功后删除安装包');
        eq(fs.existsSync(path.join(u.updateDir, 'pending.json')), rollback, '仅成功后清理待安装凭条');
        if (rollback) eq(JSON.parse(fs.readFileSync(path.join(u.updateDir, 'failed.json'), 'utf8')).rollback, 'restored');
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  console.log('\n[启动通知：保留实际恢复状态，兼容旧标记编码]');

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const notifySource = mainSource.match(/function notifyUpdateFailure\(\) \{[\s\S]*?\n\}/);
  assert(notifySource, '应能定位真实启动通知，不加载产品主进程');
  for (const row of [
    { name: '恢复成功', rollback: 'restored', expected: '已恢复旧版程序文件' },
    { name: '回滚未确认', rollback: 'unverified', expected: '未能确认旧版已恢复' },
    { name: '装前中止', rollback: 'not-attempted', expected: '未运行安装程序' },
    { name: '用户取消', rollback: 'not-started', expected: '安装程序已取消' },
    { name: '旧版 BOM 标记', bom: '\ufeff', expected: '没有装成功' },
  ]) {
    await test(`更新失败通知：${row.name}`, () => {
      const root = mkTmp();
      try {
        const u = mkUpdater(root);
        fs.mkdirSync(u.updateDir, { recursive: true });
        fs.writeFileSync(path.join(u.updateDir, 'pending.json'), '{"version":"9.9.9"}');
        fs.writeFileSync(path.join(u.updateDir, 'update.log'), 'app exited, applying');
        const failure = path.join(u.updateDir, 'failed.json');
        fs.writeFileSync(failure, (row.bom || '') + JSON.stringify({ version: '9.9.9', rollback: row.rollback }));
        const notices = [];
        require('vm').runInNewContext(notifySource[0] + '\nnotifyUpdateFailure();', {
          fs, path, updater: u, appLog() {}, send: (channel, value) => notices.push({ channel, value }),
        });
        eq(notices.length, 1, '应显示一次真实的失败通知');
        eq(notices[0].channel, 'toast');
        assert(notices[0].value.message.includes(row.expected), notices[0].value.message);
        if (row.rollback !== 'restored') assert(!notices[0].value.message.includes('已恢复旧版程序文件'));
        assert(!fs.existsSync(failure), '读过后清除失败标记');
        assert(!fs.existsSync(path.join(u.updateDir, 'pending.json')), '读过后清除旧凭条，避免重复提示');
        assert(u.autoApplyBlocked('9.9.9'), '即使消费掉旧失败标记也不应再次自动安装');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  console.log('\n[自动重试限制：持久化阻止循环，保留手动入口]');

  await test('离线缓存中的旧版本只更新界面，不重复弹出后台更新通知', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const found = source.match(/function handleUpdateFound\(info\) \{[\s\S]*?\n\}/);
    assert(found, '应定位真实的更新通知处理函数');
    const notices = [];
    const logs = [];
    const states = [];
    const context = {
      updateInfo: null,
      info: { tag: 'v9.9.9', version: '9.9.9', hasUpdate: true, stale: true, canAutoApply: false },
      send: (channel, value) => states.push({ channel, value }),
      appLog: (message) => logs.push(message),
      app: { getVersion: () => '0.0.1' },
      notify: (...args) => notices.push(args),
      store: { getSettings: () => ({ update: { autoUpdate: true } }) },
      updater: { autoApplyBlocked: () => false },
      autoUpdateFlow: () => { throw new Error('stale cache must not trigger automatic install'); },
    };
    require('vm').runInNewContext(`${found[0]}\nhandleUpdateFound(info);`, context);
    eq(notices.length, 0, '离线 stale 缓存不能弹发现新版本系统通知');
    eq(states.length, 1, '缓存状态仍应发送到更新界面');
    assert(logs.some((message) => /notification suppressed/.test(message)), '应将抑制原因写入本地日志');
  });

  await test('自动更新退避或安装失败时不重复通知，但状态仍送到设置页', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const found = source.match(/function handleUpdateFound\(info\) \{[\s\S]*?\n\}/);
    assert(found, '应定位真实的更新通知处理函数');
    const notices = [];
    const logs = [];
    const states = [];
    const context = {
      updateInfo: null,
      info: { tag: 'v9.9.9', version: '9.9.9', hasUpdate: true, stale: false, canAutoApply: true, flavor: 'setup' },
      send: (channel, value) => states.push({ channel, value }),
      appLog: (message) => logs.push(message),
      app: { getVersion: () => '0.0.1' },
      notify: (...args) => notices.push(args),
      store: { getSettings: () => ({ update: { autoUpdate: true } }) },
      updater: {
        autoApplyBlocked: () => false,
        autoDownloadRetryAt: () => Date.now() + 60000,
      },
      autoUpdateFlow: () => { throw new Error('backoff must defer automatic download'); },
    };
    require('vm').runInNewContext(`${found[0]}\nhandleUpdateFound(info);`, context);
    eq(notices.length, 0, '退避期内不能重复弹更新失败/发现更新通知');
    eq(states.length, 1, '更新状态仍发送到界面');
    assert(logs.some((message) => /deferred by download backoff/.test(message)), '应记录退避状态');
  });

  await test('自动下载失败跨启动退避，重复失败不重复通知，成功后清除记录', () => {
    const root = mkTmp();
    const originalNow = Date.now;
    let now = 1795521600000;
    Date.now = () => now;
    try {
      const u = mkUpdater(root);
      const first = u.recordAutoDownloadFailure('v9.9.9');
      eq(first.shouldNotify, true, '同版本首次失败应通知一次');
      eq(first.retryAt, now + 5 * 60 * 1000, '首次失败退避 5 分钟');
      eq(u.autoDownloadRetryAt('9.9.9'), first.retryAt);

      now = first.retryAt + 1;
      const second = u.recordAutoDownloadFailure('9.9.9');
      eq(second.shouldNotify, false, '同版本后续失败不重复通知');
      eq(second.retryAt, now + 10 * 60 * 1000, '重复失败按指数退避');
      const reopened = mkUpdater(root);
      eq(reopened.autoDownloadRetryAt('v9.9.9'), second.retryAt, '退避跨启动持久化');
      reopened.clearAutoDownloadFailure('9.9.9');
      eq(reopened.autoDownloadRetryAt('9.9.9'), 0, '成功后清除重试凭条');
    } finally {
      Date.now = originalNow;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('自动更新的三个入口均检查重试凭条，手动更新仍可安装', async () => {
    const root = mkTmp();
    try {
      const u = mkUpdater(root);
      u.blockAutoApply('v9.9.9');
      let prepares = 0;
      let installs = 0;
      const job = { mode: 'setup', version: '9.9.9', payload: 'fixture' };
      u.prepare = async () => { prepares++; return job; };
      const info = { version: '9.9.9', tag: 'v9.9.9', hasUpdate: true, canAutoApply: true, flavor: 'setup', asset: { name: 'fixture' } };
      const context = {
        updater: u, updateBusy: false, applyingUpdate: false, autoUpdateJob: null, autoUpdateTag: '', updateInfo: null,
        info, job, notify() {}, send() {}, appLog() {}, app: { getVersion: () => '0.0.1' },
        store: { getSettings: () => ({ update: { autoUpdate: true } }) },
        startApplyUpdate: () => { installs++; return true; },
      };
      const vm = require('vm');
      vm.createContext(context);
      const functions = ['applyAutoUpdate', 'autoUpdateFlow', 'handleUpdateFound', 'runUpdate'].map(name => {
        const found = mainSource.match(new RegExp('(async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
        assert(found, `应定位真实函数 ${name}`);
        return found[0];
      }).join('\n');
      vm.runInContext(functions, context);
      vm.runInContext('handleUpdateFound(info)', context);
      await vm.runInContext('autoUpdateFlow(info)', context);
      context.autoUpdateJob = job;
      eq(vm.runInContext('applyAutoUpdate()', context), false);
      eq(prepares, 0, '启动检查、直接 flow、窗口关闭后的队列都不能重复自动下载');
      eq(installs, 0, '自动入口不应重复安装');
      const result = await vm.runInContext('runUpdate()', context);
      eq(result.ok, true, '显式手动更新应仍可继续');
      eq(prepares, 1);
      eq(installs, 1);
      eq(new Updater({ dataDir: u.dataDir }).autoApplyBlocked('9.9.9'), true, '限制应跨进程保留');
      eq(u.autoApplyBlocked('10.0.0'), false, '新版本不受旧失败版本影响');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('重试凭条损坏时自动路径失败关闭，手动尝试可修复且不重复记录', () => {
    const root = mkTmp();
    try {
      const u = mkUpdater(root);
      fs.mkdirSync(u.updateDir, { recursive: true });
      const file = path.join(u.updateDir, 'auto-attempts.json');
      fs.writeFileSync(file, '{');
      assert(u.autoApplyBlocked('9.9.9'));
      u.blockAutoApply('9.9.9');
      u.blockAutoApply('v9.9.9');
      eq(JSON.parse(fs.readFileSync(file, 'utf8')).versions.length, 1);
      assert(u.autoApplyBlocked('9.9.9'));
      eq(u.autoApplyBlocked('10.0.0'), false);
      const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
      assert(u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false }).includes('run installer'), '手动安装生成不受自动重试限制影响');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('自动重试凭条无法持久化时不生成安装脚本', async () => {
    const root = mkTmp();
    try {
      const u = mkUpdater(root);
      fs.mkdirSync(path.join(u.updateDir, 'auto-attempts.json'), { recursive: true });
      const setup = fakeExe(path.join(root, 'ApkStart-9.9.9-Setup.exe'));
      await expectThrow(() => u.apply({ mode: 'setup', payload: setup, version: '9.9.9' }, { spawn: false }), /EISDIR|EPERM|EACCES/);
      assert(!fs.existsSync(path.join(u.updateDir, 'apply.log.ps1')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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

  await test('launch 回调失败时会退到 explorer / spawn，三级都失败才抛错（不启动任何真实进程）', async () => {
    if (process.platform !== 'win32') return;
    const root = mkTmp();
    const file = path.join(__dirname, '..', 'src', 'core', 'updater.js');
    const localRequire = require('module').createRequire(file);
    const calls = [];
    let failAll = false;
    const context = { module: { exports: {} }, __dirname: path.dirname(file), process, Buffer,
      require: name => name === 'child_process' ? { spawn: (cmd) => {
        calls.push(cmd);
        if (failAll || cmd === 'explorer.exe') throw new Error('fixture unavailable');
        return { unref() {} };
      } } : localRequire(name) };
    require('vm').runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    const launch = context.module.exports.Updater.prototype._launch;
    const u = mkUpdater(root);
    const args = [path.join(root, 'apply.cmd'), path.join(root, 'apply.ps1'), { launch: () => 'no handler' }];
    eq(launch.call(u, ...args).via, 'spawn', 'explorer 失败应继续回退');
    eq(calls.length, 2, '所有启动行为均被隔离 stub 接管');
    failAll = true;
    await expectThrow(() => launch.call(u, ...args), /无法启动升级脚本/);
  });

  if (!canRunPowerShellFixtures) {
    console.log(`\n隔离 PowerShell 执行已跳过：${portableScenarios.length} 个便携用例、${scenarios.length} 个安装版用例、2 个短路径用例（不覆盖系统限制）`);
  }
  console.log(`\n更新器安全测试：${passed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

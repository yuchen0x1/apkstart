# 纯编译/反射回归：不启动 agent、不枚举窗口、不终止任何真实进程。
$ErrorActionPreference = 'Stop'
$base = Split-Path $PSScriptRoot -Parent
foreach ($relative in @('src\core\win\agent.ps1', 'src\core\win\process-owner.ps1', 'build\stop-runtime.ps1')) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $base $relative), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($relative + ': ' + ($errors | Out-String)) }
}

# 仅装载类型和函数，不传 Action，绝不执行 Inspect/Terminate。
. (Join-Path $base 'src\core\win\process-owner.ps1')
$text = Get-Content -LiteralPath (Join-Path $base 'src\core\win\agent.ps1') -Raw -Encoding UTF8
$source = [regex]::Match($text, "(?s)@'\r?\n(.*?)\r?\n'@")
if (-not $source.Success) { throw '找不到 agent C# 源码' }
Add-Type -TypeDefinition $source.Groups[1].Value
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$decoder = [ApkAgent].GetMethod('S', $flags)
$setScope = [ApkAgent].GetMethod('SetScope', $flags)
$scopeField = [ApkAgent].GetField('_scopeDirs', $flags)
function Assert-Equal($Actual, $Expected, $Label) {
  if ($Actual -cne $Expected) { throw "$Label : [$Actual] != [$Expected]" }
}

# JSON 只解码一遍；\n、\t 等路径片段不能被再次反转义。
$native = 'D:\name\new\tabs\folder'
$json = @{ dirs = $native } | ConvertTo-Json -Compress
Assert-Equal ($decoder.Invoke($null, @("$json", 'dirs'))) $native '原生路径往返'
Assert-Equal ($decoder.Invoke($null, @('{"dirs":"D:\\unicode\\\u4e2d"}', 'dirs'))) ('D:\unicode\' + [char]0x4e2d) 'Unicode JSON 转义'

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('apkstart-scope-' + [Guid]::NewGuid().ToString('N'))
try {
  $runtime = Join-Path $fixture 'runtime'
  $emulator = Join-Path $runtime 'emulator'
  [void][IO.Directory]::CreateDirectory((Join-Path $emulator 'qemu'))
  [IO.File]::WriteAllText((Join-Path $emulator 'emulator.exe'), 'mock fixture, not executable')
  $real = [ApkRuntimeProcess]::RealPath($emulator) + '\'
  [void]$setScope.Invoke($null, @(($runtime + ';' + $emulator + ';' + $emulator.ToUpperInvariant())))
  $scopes = $scopeField.GetValue($null)
  Assert-Equal $scopes.Count 1 'scope 去重并收敛到 emulator'
  Assert-Equal $scopes[0] $real 'scope 使用真实目录'

  [void]$setScope.Invoke($null, @([IO.Path]::GetPathRoot($fixture)))
  Assert-Equal ($scopeField.GetValue($null).Count) 0 '拒绝磁盘根'
  [void]$setScope.Invoke($null, @($env:USERPROFILE))
  Assert-Equal ($scopeField.GetValue($null).Count) 0 '拒绝用户根'

  # Windows junction 不需要符号链接权限；仅在我们新建的临时目录中建立。
  $link = Join-Path $fixture 'alias'
  [void](New-Item -ItemType Junction -Path $link -Target $runtime)
  $alias = Join-Path $link 'emulator'
  [void]$setScope.Invoke($null, @("$alias"))
  $scopes = $scopeField.GetValue($null)
  Assert-Equal $scopes.Count 1 'junction scope 数量'
  Assert-Equal $scopes[0] $real 'junction 使用同一真实目录'
  [IO.Directory]::Delete($link)
  'OWNERSHIP_PS_OK: parser, shared native helper, agent C# compile, JSON single decode, narrow scope, junction'
} finally {
  # 只删除本测试创建的临时文件；不运行任何进程或窗口操作。
  if (Test-Path -LiteralPath (Join-Path $fixture 'alias')) { [IO.Directory]::Delete((Join-Path $fixture 'alias')) }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}

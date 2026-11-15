param(
  [string]$DataDir = '',
  [string]$RuntimeDir = '',
  [string]$AvdDir = '',
  [string]$SharedDir = '',
  [string]$TempDir = '',
  [string]$InstallDir = '',
  [string]$DesktopDir = '',
  [string]$StartMenuDir = '',
  [int]$WaitPid = 0,
  [switch]$RemoveInstallDir
)

$ErrorActionPreference = 'SilentlyContinue'

function Resolve-PathText([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  try { return [IO.Path]::GetFullPath($Value).TrimEnd('\') } catch { return '' }
}

function Is-ProtectedPath([string]$Value) {
  $p = Resolve-PathText $Value
  if (-not $p) { return $true }
  $root = [IO.Path]::GetPathRoot($p).TrimEnd('\')
  $protected = @(
    (Resolve-PathText $env:USERPROFILE),
    (Resolve-PathText ([Environment]::GetFolderPath('Desktop'))),
    (Resolve-PathText ([Environment]::GetFolderPath('MyDocuments'))),
    (Resolve-PathText ([Environment]::GetFolderPath('Downloads'))),
    (Resolve-PathText $env:WINDIR),
    (Resolve-PathText $env:ProgramFiles),
    (Resolve-PathText ${env:ProgramFiles(x86)}),
    $root
  ) | Where-Object { $_ }
  foreach ($item in $protected) {
    if ($p.Equals($item, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Add-Target([System.Collections.Generic.List[string]]$List, [string]$Value) {
  $p = Resolve-PathText $Value
  if (-not $p -or (Is-ProtectedPath $p)) { return }
  foreach ($old in $List) {
    if ($p.Equals($old, [StringComparison]::OrdinalIgnoreCase)) { return }
  }
  [void]$List.Add($p)
}

if (-not $DataDir) { $DataDir = Join-Path ($env:APPDATA) 'apkstart' }
if (-not $TempDir) { $TempDir = [IO.Path]::GetTempPath() }
$DataDir = Resolve-PathText $DataDir

# 先读取设置，再删除数据目录；这样用户把运行时、AVD、共享目录换到其它盘时，
# Windows「应用和功能」里的卸载也能把这些目录一起清掉。
$settingsFile = ''
if ($DataDir) { $settingsFile = Join-Path $DataDir 'settings.json' }
if ($settingsFile -and (Test-Path -LiteralPath $settingsFile)) {
  try {
    $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $RuntimeDir) { $RuntimeDir = [string]$settings.runtime.dir }
    if (-not $AvdDir) { $AvdDir = [string]$settings.runtime.avdDir }
    if (-not $SharedDir) { $SharedDir = [string]$settings.sharedDir }
  } catch { }
}

# apps.json 记录了 ApkStart 为每个应用创建的桌面/开始菜单快捷方式。
# 在删数据目录前先清掉，避免卸载后留下指向已删除程序的 .lnk。
$appsFile = ''
if ($DataDir) { $appsFile = Join-Path $DataDir 'apps.json' }
if ($appsFile -and (Test-Path -LiteralPath $appsFile)) {
  try {
    $appState = Get-Content -LiteralPath $appsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($app in @($appState.apps)) {
      $desktopShortcut = [string]$app.shortcutPath
      $startShortcut = [string]$app.startMenuPath
      if ($desktopShortcut -match '(?i)\.lnk$' -and (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)) {
        Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
      }
      if ($startShortcut -match '(?i)\.lnk$' -and (Test-Path -LiteralPath $startShortcut -PathType Leaf)) {
        Remove-Item -LiteralPath $startShortcut -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { }
}

# 旧版可能没有 apps.json，但已经在桌面或开始菜单创建了指向 ApkStart 的快捷方式。
# 只按启动参数、目标程序和 ApkStart 图标目录识别，避免触碰其它桌面软件。
if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath('Desktop') }
if (-not $StartMenuDir) { $StartMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
$iconRoots = New-Object 'System.Collections.Generic.List[string]'
if ($DataDir) { [void]$iconRoots.Add((Join-Path $DataDir 'icons')) }
[void]$iconRoots.Add((Join-Path (Join-Path $env:APPDATA 'apkstart') 'icons'))
$removeShortcutPaths = New-Object 'System.Collections.Generic.List[string]'
Start-Sleep -Milliseconds 500
foreach ($shortcutRoot in @($DesktopDir, $StartMenuDir)) {
  if (-not (Test-Path -LiteralPath $shortcutRoot -PathType Container)) { continue }
  Get-ChildItem -LiteralPath $shortcutRoot -Force -Recurse -File -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $bytes = [IO.File]::ReadAllBytes($_.FullName)
      $shortcutText = ([Text.Encoding]::Unicode.GetString($bytes) + [Text.Encoding]::ASCII.GetString($bytes))
      $isManagedShortcut = $shortcutText -match '(?i)ApkStart\.exe'
      if (-not $isManagedShortcut -and $shortcutText -match '(?i)--launch') {
        foreach ($iconRoot in $iconRoots) {
          $resolvedIconRoot = Resolve-PathText $iconRoot
          if ($resolvedIconRoot -and $shortcutText -match [regex]::Escape($resolvedIconRoot)) {
            $isManagedShortcut = $true
            break
          }
        }
      }
      if ($isManagedShortcut) { [void]$removeShortcutPaths.Add($_.FullName) }
    } catch { }
  }
}
foreach ($shortcutPath in $removeShortcutPaths) {
  Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
}

$targets = New-Object 'System.Collections.Generic.List[string]'
Add-Target $targets $DataDir
Add-Target $targets $RuntimeDir
Add-Target $targets $AvdDir
if (-not $SharedDir) { $SharedDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'ApkStartShared' }
Add-Target $targets $SharedDir

# 下载中断、更新失败和旧版自解压可能在 TEMP 留下残片；只匹配 ApkStart 自己的前缀。
Get-ChildItem -LiteralPath $TempDir -Force -ErrorAction SilentlyContinue | Out-Null
Get-ChildItem -LiteralPath $TempDir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^apkstart([-.]|$)' } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

if ($WaitPid -gt 0) {
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
}

foreach ($target in $targets) {
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($RemoveInstallDir -and $InstallDir) {
  $install = Resolve-PathText $InstallDir
  if ($install -and -not (Is-ProtectedPath $install) -and (Test-Path -LiteralPath $install)) {
    Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 便携版把脚本复制到 TEMP，安装目录删除后这里也要自删；源码和 NSIS 资源脚本保留。
$scriptName = ''
if ($PSCommandPath) { $scriptName = [IO.Path]::GetFileName($PSCommandPath) }
if ($scriptName -like 'apkstart-uninstall-*.ps1') {
  Start-Sleep -Milliseconds 250
  try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch { }
}

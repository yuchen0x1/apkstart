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
    (Resolve-PathText (Join-Path $env:USERPROFILE 'Downloads')),
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

# 等主进程真正退出才开始清理；超时则保留数据，不能边运行边删除。
if ($WaitPid -gt 0) {
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { exit 1 }
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

# 共享目录是用户文件，不属于可自动删除的数据；也不按 TEMP 前缀批量清理其它会话。
if (-not $SharedDir) { $SharedDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'ApkStartShared' }
$sharedPath = Resolve-PathText $SharedDir

# 不跟随 junction/symlink；即使共享目录位于数据树内也必须保留。
function Remove-OwnedTree([string]$Value) {
  $p = Resolve-PathText $Value
  if (-not $p -or (Is-ProtectedPath $p)) { return }
  if ($sharedPath -and ($p.Equals($sharedPath, [StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($sharedPath + '\', [StringComparison]::OrdinalIgnoreCase))) { return }
  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)) {
      Remove-OwnedTree $child.FullName
    }
    try { [IO.Directory]::Delete($p, $false) } catch { }
  } else {
    Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  }
}

function Remove-KnownChildren([string]$Root, [string[]]$Names) {
  $p = Resolve-PathText $Root
  if (-not $p -or (Is-ProtectedPath $p)) { return }
  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if (-not $item -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return }
  foreach ($name in $Names) { Remove-OwnedTree (Join-Path $p $name) }
  try { [IO.Directory]::Delete($p, $false) } catch { }
}

# 自选运行时/AVD 目录可能同时放了其它资料，只删除明确属于 ApkStart 的子项。
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $DataDir 'runtime' }
$avdRoots = @($AvdDir, (Join-Path $RuntimeDir 'avd'), (Join-Path $DataDir 'avd')) | Where-Object { $_ } | Select-Object -Unique
foreach ($avdRoot in $avdRoots) {
  $avd = Resolve-PathText $avdRoot
  if ($avd -and -not (Is-ProtectedPath $avd)) {
    $avdItem = Get-Item -LiteralPath $avd -Force -ErrorAction SilentlyContinue
    if ($avdItem -and (($avdItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
      foreach ($child in @(Get-ChildItem -LiteralPath $avd -Force -ErrorAction SilentlyContinue)) {
        if ($child.Name -match '^apkstart(?:[-_.][a-zA-Z0-9_.-]+)?\.(avd|ini)$') { Remove-OwnedTree $child.FullName }
      }
      try { [IO.Directory]::Delete($avd, $false) } catch { }
    }
  }
}
Remove-KnownChildren $RuntimeDir @('platform-tools', 'emulator', 'qemu', 'system-images', 'custom-images', 'systems', 'aehd', 'images', '_tmp')
Remove-KnownChildren $DataDir @('apps.json', 'settings.json', 'icons', 'apks', 'logs', 'cache', 'update', 'system-images', 'shared-state.json', 'shared-state.json.tmp', 'Cache', 'GPUCache', 'Local Storage', 'Session Storage', 'Preferences', 'Local State')

if ($RemoveInstallDir -and $InstallDir) {
  Remove-KnownChildren $InstallDir @('ApkStart.exe', 'resources', 'locales', 'swiftshader', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'libEGL.dll', 'libGLESv2.dll', 'ffmpeg.dll', 'd3dcompiler_47.dll', 'vulkan-1.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'chrome_crashpad_handler.exe', 'LICENSE', 'LICENSES.chromium.html')
}

# 便携版把脚本复制到 TEMP，安装目录删除后这里也要自删；源码和 NSIS 资源脚本保留。
$scriptName = ''
if ($PSCommandPath) { $scriptName = [IO.Path]::GetFileName($PSCommandPath) }
if ($scriptName -like 'apkstart-uninstall-*.ps1') {
  Start-Sleep -Milliseconds 250
  try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch { }
}

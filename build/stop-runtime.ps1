# Called only from confirmed NSIS customUnInstall. Refuse unknown ownership.
param([Parameter(Mandatory=$true)][string]$InstallDir, [Parameter(Mandatory=$true)][string]$DataDir)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $InstallDir 'resources\app\src\core\win\process-owner.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { exit 0 }
. $helper

function Safe-Directory([string]$Name) {
  $p = [ApkRuntimeProcess]::RealPath($Name)
  if (-not $p -or -not (Test-Path -LiteralPath $p -PathType Container)) { return '' }
  if ($p -eq [IO.Path]::GetPathRoot($p).TrimEnd('\')) { return '' }
  if ([IO.Path]::GetFileName($p) -match '^(Users|Windows|Program Files( \(x86\))?|ProgramData|AppData|Desktop|Downloads|Documents|Temp)$') { return '' }
  foreach ($key in @('USERPROFILE','HOME','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramData','SystemRoot','TEMP','TMP')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value -and $p -eq [ApkRuntimeProcess]::RealPath($value)) { return '' }
  }
  return $p
}
function Canonical-Same([string]$A, [string]$B) {
  $p = [ApkRuntimeProcess]::RealPath($A)
  return $p -and $p -ceq [ApkRuntimeProcess]::RealPath($B)
}
function Values-For($Arguments, [string]$Key) {
  for ($i = 1; $i -lt $Arguments.Count; $i++) {
    if ($Arguments[$i] -ceq $Key) {
      if ($i + 1 -ge $Arguments.Count) { return '' }
      $Arguments[$i + 1]
    }
  }
}

$install = Safe-Directory $InstallDir
$data = Safe-Directory $DataDir
if (-not $install -or -not $data) { exit 0 }
$settings = $null
try { $settings = Get-Content -LiteralPath (Join-Path $data 'settings.json') -Raw | ConvertFrom-Json } catch { }
$runtimeRoots = @((Join-Path $install 'resources\runtime'), (Join-Path $install 'resources\app\engine'), (Join-Path $data 'runtime'))
if ($settings.runtime.dir) { $runtimeRoots += [string]$settings.runtime.dir }
$emulators = @()
$avdHomes = @((Join-Path $data 'avd'))
if ($settings.runtime.avdDir) { $avdHomes += [string]$settings.runtime.avdDir }
foreach ($root in $runtimeRoots) {
  $safe = Safe-Directory $root
  if (-not $safe) { continue }
  $avdHomes += Join-Path $safe 'avd'
  $dir = Safe-Directory (Join-Path $safe 'emulator')
  if (-not $dir) { continue }
  if (-not (Canonical-Same (Join-Path $dir 'emulator.exe') (Join-Path $dir 'emulator.exe'))) { continue }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'qemu') -PathType Container)) { continue }
  if ([IO.Path]::GetDirectoryName([ApkRuntimeProcess]::RealPath((Join-Path $dir 'emulator.exe'))) -cne $dir) { continue }
  $emulators += $dir
}
$avdDirs = @()
foreach ($home in $avdHomes) {
  if (-not (Safe-Directory $home)) { continue }
  foreach ($name in @('apkstart', 'apkstart-custom', 'apkstart-googleapis', 'apkstart-aosp')) {
    $dir = Safe-Directory (Join-Path $home "$name.avd")
    if ($dir) { $avdDirs += [pscustomobject]@{ name = $name; path = $dir } }
  }
}

# Enumeration only nominates candidates. The pinned helper rechecks exe, command line
# and creation time on the SAME handle that is terminated. No /IM or process-tree kill.
try { $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { exit 0 }
foreach ($row in $rows) {
  if ($row.Name -notmatch '^(ApkStart|emulator|qemu-system-(x86_64|i386|aarch64|armel))\.exe$') { continue }
  $identity = Get-ApkRuntimeIdentity ([int]$row.ProcessId)
  if (-not $identity) { continue }
  $owned = Canonical-Same $identity.exe (Join-Path $install 'ApkStart.exe')
  if (-not $owned) {
    $exeRoot = ''
    $leaf = [IO.Path]::GetFileName($identity.exe)
    if ($leaf -ceq 'emulator.exe') { $exeRoot = [IO.Path]::GetDirectoryName($identity.exe) }
    elseif ($leaf -match '^qemu-system-(x86_64|i386|aarch64|armel)\.exe$') {
      $hostDir = [IO.Path]::GetDirectoryName($identity.exe)
      $qemuDir = [IO.Path]::GetDirectoryName($hostDir)
      if ([IO.Path]::GetFileName($hostDir) -match '^windows-(x86_64|aarch64)$' -and [IO.Path]::GetFileName($qemuDir) -ceq 'qemu') { $exeRoot = [IO.Path]::GetDirectoryName($qemuDir) }
    }
    if (-not $exeRoot -or $emulators -cnotcontains $exeRoot) { continue }
    $argv = @($identity.argv)
    if (-not $argv.Count -or -not (Canonical-Same $argv[0] $identity.exe)) { continue }
    $names = @(Values-For $argv '-avd') + @($argv | Where-Object { $_.StartsWith('@') } | ForEach-Object { $_.Substring(1) })
    $dataArgs = @(Values-For $argv '-datadir')
    $hwArgs = @(Values-For $argv '-android-hw')
    foreach ($avd in $avdDirs) {
      if (@($names | Where-Object { $_ -cne $avd.name }).Count) { continue }
      if (@($dataArgs | Where-Object { -not (Canonical-Same $_ $avd.path) }).Count) { continue }
      if (@($hwArgs | Where-Object { -not (Canonical-Same $_ (Join-Path $avd.path 'hardware-qemu.ini')) }).Count) { continue }
      if (($names.Count -gt 0 -and $dataArgs.Count -gt 0) -or $hwArgs.Count -gt 0) { $owned = $true; break }
    }
  }
  if ($owned) { [void](Stop-ApkRuntimeIdentity $identity) }
}

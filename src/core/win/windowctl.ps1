# ApkStart window controller (ASCII-only source; Chinese text comes from UTF-8 JSON).
# Pure Win32 P/Invoke, no compiled binary, no third party dependency.
#
# A PID alone is never authority. The caller must pass the process identity it
# already verified (birth time, real image path, SHA-256 of the command line).
# This script opens ONE process handle, re-verifies that identity on the handle,
# and only then enumerates windows owned by that process (or by a qemu child of
# it that lives inside the same runtime directory). A recycled PID therefore
# cannot make us rename/resize somebody else's window.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File windowctl.ps1 params.json
param([string]$JsonPath)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::ASCII

if (-not (Test-Path -LiteralPath $JsonPath)) { Write-Output 'OK=0'; Write-Output 'ERR=no-json'; exit 0 }
try {
  $j = [System.IO.File]::ReadAllText($JsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
} catch {
  Write-Output 'OK=0'; Write-Output 'ERR=bad-json'; exit 0
}

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ApkWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string s);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int val);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr inst, string file, uint type, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder name, uint size, uint flags);
  public static string RealPath(string name) {
    if (String.IsNullOrWhiteSpace(name) || !System.IO.Path.IsPathRooted(name)) return "";
    IntPtr h = CreateFileW(name, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "";
    try {
      StringBuilder b = new StringBuilder(32768);
      uint n = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
      if (n == 0 || n >= b.Capacity) return "";
      string p = b.ToString();
      if (p.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) p = @"\\" + p.Substring(8);
      else if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) p = p.Substring(4);
      return p.TrimEnd('\\').ToLowerInvariant();
    } finally { CloseHandle(h); }
  }
  public static string Exe(IntPtr h) {
    int n = 32768; StringBuilder b = new StringBuilder(n);
    return QueryFullProcessImageName(h, 0, b, ref n) ? RealPath(b.ToString()) : "";
  }
  public static string Started(IntPtr h) {
    long c, e, k, u;
    return GetProcessTimes(h, out c, out e, out k, out u) ? c.ToString(System.Globalization.CultureInfo.InvariantCulture) : "";
  }
}
'@
try { Add-Type -TypeDefinition $src } catch { Write-Output 'OK=0'; Write-Output 'ERR=add-type'; exit 0 }

function Get-Sha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Find-WindowForPid([int]$ProcId) {
  if ($ProcId -le 0) { return [IntPtr]::Zero }
  $best = [IntPtr]::Zero
  $bestScore = [long]::MinValue
  $callback = [ApkWin+EnumProc]{
    param([IntPtr]$h, [IntPtr]$p)
    [uint32]$owner = 0
    [void][ApkWin]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -ne [uint32]$ProcId) { return $true }
    $r = New-Object ApkWin+RECT
    if (-not [ApkWin]::GetWindowRect($h, [ref]$r)) { return $true }
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -lt 200 -or $hh -lt 200) { return $true }
    $visible = [ApkWin]::IsWindowVisible($h)
    $score = [long]$w * [long]$hh
    if ($visible) { $score += 1000000000L }
    if ($score -gt $bestScore) {
      $script:bestScore = $score
      $script:best = $h
    }
    return $true
  }
  $script:best = [IntPtr]::Zero
  $script:bestScore = [long]::MinValue
  [void][ApkWin]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:best
}

function Test-Identity($Handle, [int]$TargetPid, $Identity, [long]$Started) {
  if (-not $Identity -or $null -eq $Identity.started -or -not $Identity.exe -or -not $Identity.cmdHash) { return $false }
  if ([string]$Identity.started -cne [string]$Started) { return $false }
  $exe = [ApkWin]::Exe($Handle)
  if (-not $exe -or $exe -cne [string]$Identity.exe) { return $false }
  $row = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop
  if (-not $row -or -not $row.CommandLine -or -not $row.CreationDate) { return $false }
  $cimStarted = $row.CreationDate.ToUniversalTime().ToFileTimeUtc()
  if ([Math]::Abs([decimal]$Started - [decimal]$cimStarted) -ge 10) { return $false }
  $hash = Get-Sha256 ([string]$row.CommandLine)
  return $hash -ceq [string]$Identity.cmdHash
}

$action = [string]$j.action
if ($action -eq 'refresh') {
  # No process is touched. Explorer only needs a nudge to re-read icons.
  [void][ApkWin]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output 'OK=1'
  exit 0
}

$targetPid = 0
try { $targetPid = [int]$j.pid } catch { $targetPid = 0 }
if ($targetPid -le 0 -or $targetPid -eq $PID) { Write-Output 'OK=0'; Write-Output 'ERR=no-pid'; exit 0 }
if ($null -eq $j.identity) { Write-Output 'OK=0'; Write-Output 'ERR=identity-required'; exit 0 }

# Other Windows sessions are never part of this ApkStart instance.
$targetSession = 0
$currentSession = 0
if (-not [ApkWin]::ProcessIdToSessionId([uint32]$targetPid, [ref]$targetSession)) { Write-Output 'OK=0'; Write-Output 'ERR=no-session'; exit 0 }
if (-not [ApkWin]::ProcessIdToSessionId([uint32]$PID, [ref]$currentSession)) { Write-Output 'OK=0'; Write-Output 'ERR=no-session'; exit 0 }
if ($targetSession -ne $currentSession) { Write-Output 'OK=0'; Write-Output 'ERR=foreign-session'; exit 0 }

# Hold ONE handle from verification through the window operation: the PID
# cannot be recycled underneath us while this handle is open.
$handle = [ApkWin]::OpenProcess(0x00001000, $false, [uint32]$targetPid)
if ($handle -eq [IntPtr]::Zero) { Write-Output 'OK=0'; Write-Output 'ERR=open-process'; exit 0 }
try {
  $startedText = [ApkWin]::Started($handle)
  if (-not $startedText) { Write-Output 'OK=0'; Write-Output 'ERR=no-identity'; exit 0 }
  $verified = $false
  try { $verified = Test-Identity $handle $targetPid $j.identity ([long]$startedText) } catch { $verified = $false }
  if (-not $verified) { Write-Output 'OK=0'; Write-Output 'ERR=identity-mismatch'; exit 0 }

  $hwnd = Find-WindowForPid $targetPid
  if ($hwnd -eq [IntPtr]::Zero) {
    # The emulator launcher owns no window; the Qt window belongs to a qemu
    # child. Accept only a qemu-system image inside the verified runtime
    # directory, born after its verified parent, in the same session.
    $rootExe = [ApkWin]::Exe($handle)
    $rootDir = [System.IO.Path]::GetDirectoryName($rootExe) + '\'
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$targetPid" -ErrorAction SilentlyContinue)
    foreach ($kid in $kids) {
      $kidPid = [int]$kid.ProcessId
      if ($kidPid -le 0) { continue }
      $kidHandle = [ApkWin]::OpenProcess(0x00001000, $false, [uint32]$kidPid)
      if ($kidHandle -eq [IntPtr]::Zero) { continue }
      try {
        $kidStarted = [long][ApkWin]::Started($kidHandle)
        if ($kidStarted -le 0 -or $kidStarted -lt [long]$startedText) { continue }
        $kidExe = [ApkWin]::Exe($kidHandle)
        if (-not $kidExe -or -not $kidExe.StartsWith($rootDir, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($kidExe -notmatch '\\qemu-system-[a-z0-9_]+\.exe$') { continue }
        $kidSession = 0
        if (-not [ApkWin]::ProcessIdToSessionId([uint32]$kidPid, [ref]$kidSession)) { continue }
        if ($kidSession -ne $currentSession) { continue }
        $hwnd = Find-WindowForPid $kidPid
        if ($hwnd -ne [IntPtr]::Zero) { break }
      } finally {
        [void][ApkWin]::CloseHandle($kidHandle)
      }
    }
  }
  if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'OK=0'; Write-Output 'ERR=no-window'; exit 0 }
  Write-Output ("HWND=" + $hwnd.ToInt64())

  if ($action -eq 'get') {
    $r = New-Object ApkWin+RECT
    [void][ApkWin]::GetWindowRect($hwnd, [ref]$r)
    Write-Output ("X=" + $r.Left)
    Write-Output ("Y=" + $r.Top)
    Write-Output ("W=" + ($r.Right - $r.Left))
    Write-Output ("H=" + ($r.Bottom - $r.Top))
    Write-Output ("MAX=" + $(if ([ApkWin]::IsZoomed($hwnd)) { 1 } else { 0 }))
    Write-Output 'OK=1'
    exit 0
  }

  if ($j.title) { [void][ApkWin]::SetWindowText($hwnd, [string]$j.title) }

  if ($j.icon) {
    try {
      $hicon = [ApkWin]::LoadImage([IntPtr]::Zero, [string]$j.icon, 1, 0, 0, 0x10)
      if ($hicon -ne [IntPtr]::Zero) {
        [void][ApkWin]::SendMessage($hwnd, 0x0080, [IntPtr]0, $hicon)
        [void][ApkWin]::SendMessage($hwnd, 0x0080, [IntPtr]1, $hicon)
      }
    } catch { }
  }

  $style = [ApkWin]::GetWindowLong($hwnd, -16)
  $SWP = 0x0060   # SWP_SHOWWINDOW | SWP_FRAMECHANGED
  if ($action -eq 'fullscreen') {
    $new = $style -band (-bnot 0x00C40000)
    [void][ApkWin]::SetWindowLong($hwnd, -16, $new)
    [void][ApkWin]::ShowWindow($hwnd, 9)
    if ($j.bounds) {
      $b = $j.bounds
      [void][ApkWin]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$b.x, [int]$b.y, [int]$b.w, [int]$b.h, $SWP)
    } else {
      [void][ApkWin]::ShowWindow($hwnd, 3)
    }
  } elseif ($action -eq 'window') {
    $want = 0x00C40000 -bor 0x00080000
    [void][ApkWin]::SetWindowLong($hwnd, -16, $style -bor $want)
    [void][ApkWin]::ShowWindow($hwnd, 9)
    if ($j.bounds) {
      $b = $j.bounds
      [void][ApkWin]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$b.x, [int]$b.y, [int]$b.w, [int]$b.h, $SWP)
    }
  } elseif ($action -eq 'focus') {
    [void][ApkWin]::ShowWindow($hwnd, 9)
  }

  [void][ApkWin]::SetForegroundWindow($hwnd)
  Write-Output 'OK=1'
} finally {
  [void][ApkWin]::CloseHandle($handle)
}

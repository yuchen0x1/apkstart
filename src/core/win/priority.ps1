# ApkStart process priority helper (ASCII only).
#
# QEMU is a CPU-hungry guest. Running it at Normal priority competes with the
# Windows shell, the pointer and every foreground app -- which is exactly what
# makes the whole desktop feel laggy while an Android app is open.
#
# The caller already established ownership (real emulator path + this AVD's
# -datadir/-android-hw + birth time) and passes those exact identities here.
# This script re-verifies every identity on ONE process handle immediately
# before changing priority. A PID recycled between the caller's check and this
# script therefore cannot redirect the operation. Image-name / command-line
# scans are deliberately never used: other people's emulators may share the
# image name or even an AVD name.
#
#   idle   : no app open, container parked (lowest CPU claim)
#   below  : app open, still yield to the Windows foreground
#   normal : user explicitly asked for maximum guest performance
#
# Expected is base64(UTF-8 JSON array) of:
#   { pid, started, exe, cmdHash }
# where started/exe come from process-owner.ps1 and cmdHash is SHA-256 of the
# exact Win32_Process.CommandLine string.
param(
  [string]$Expected = '',
  [ValidateSet('idle', 'below', 'normal')][string]$Level = 'below'
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not ('ApkPriority' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ApkPriority {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetPriorityClass(IntPtr h, uint cls);
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
}

$map = @{ idle = 0x00000040; below = 0x00004000; normal = 0x00000020 }
$want = [uint32]$map[$Level]
$changed = 0
$targets = @()

if ($Expected) {
  try {
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Expected))
    $parsed = $decoded | ConvertFrom-Json
    if ($null -ne $parsed) { $targets = @($parsed) }
  } catch {
    $targets = @()
  }
}

foreach ($entry in $targets) {
  if ($null -eq $entry) { continue }
  $targetPid = 0
  try { $targetPid = [int]$entry.pid } catch { continue }
  if ($targetPid -le 0 -or $targetPid -eq $PID) { continue }
  $expectedStarted = [string]$entry.started
  $expectedExe = [string]$entry.exe
  $expectedHash = [string]$entry.cmdHash
  if (-not $expectedStarted -or -not $expectedExe -or -not $expectedHash) { continue }

  # Other Windows sessions are never part of this ApkStart instance.
  $targetSession = 0
  $currentSession = 0
  if (-not [ApkPriority]::ProcessIdToSessionId([uint32]$targetPid, [ref]$targetSession)) { continue }
  if (-not [ApkPriority]::ProcessIdToSessionId([uint32]$PID, [ref]$currentSession)) { continue }
  if ($targetSession -ne $currentSession) { continue }

  # PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
  $handle = [ApkPriority]::OpenProcess(0x00001200, $false, [uint32]$targetPid)
  if ($handle -eq [IntPtr]::Zero) { continue }
  try {
    $started = [ApkPriority]::Started($handle)
    $exe = [ApkPriority]::Exe($handle)
    if (-not $started -or -not $exe) { continue }
    if ($started -cne $expectedStarted -or $exe -cne $expectedExe) { continue }

    # CIM is read only for this exact PID. CreationDate protects against PID
    # reuse; CommandLine hash protects against the same binary being relaunched
    # with different arguments while we still hold the old handle.
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction Stop
    if (-not $row -or -not $row.CommandLine -or -not $row.CreationDate) { continue }
    $cimStarted = $row.CreationDate.ToUniversalTime().ToFileTimeUtc()
    if ([Math]::Abs([decimal]$started - [decimal]$cimStarted) -ge 10) { continue }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$row.CommandLine))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
    if ($hash -cne $expectedHash) { continue }

    if ([ApkPriority]::SetPriorityClass($handle, $want)) { $changed++ }
  } catch {
  } finally {
    [void][ApkPriority]::CloseHandle($handle)
  }
}

"CHANGED=$changed"

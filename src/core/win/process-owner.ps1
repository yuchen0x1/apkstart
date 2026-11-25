# Shared fail-closed Windows process identity/termination helper. No image-name kills.
param(
  [ValidateSet('', 'Inspect', 'InspectMany', 'Terminate', 'Tree', 'TreeSnapshot')][string]$Action = '',
  [int]$TargetPid = 0,
  [string]$TargetPids = '',
  [string]$Expected = ''
)

if (-not ('ApkRuntimeProcess' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ApkRuntimeProcess {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetPriorityClass(IntPtr h);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder name, uint size, uint flags);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Arguments(string command) {
        int count; IntPtr argv = CommandLineToArgvW(command, out count);
        if (argv == IntPtr.Zero) return new string[0];
        try {
            string[] result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
            return result;
        } finally { LocalFree(argv); }
    }
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

function Get-ApkRuntimeIdentityFromHandle([IntPtr]$Handle, [int]$ProcessId, $Row = $null) {
  try {
    $started = [ApkRuntimeProcess]::Started($Handle)
    $exe = [ApkRuntimeProcess]::Exe($Handle)
    if (-not $started -or -not $exe) { return $null }
    if (-not $Row) { $Row = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop }
    if (-not $row -or -not $row.CommandLine -or -not $row.CreationDate) { return $null }
    # CIM is microsecond precision; GetProcessTimes is 100ns. They must identify the same birth.
    $cimStarted = $row.CreationDate.ToUniversalTime().ToFileTimeUtc()
    if ([Math]::Abs([decimal]$started - [decimal]$cimStarted) -ge 10) { return $null }
    if ([ApkRuntimeProcess]::Started($Handle) -ne $started) { return $null }
    return [pscustomobject]@{ pid = $ProcessId; started = $started; exe = $exe; commandLine = [string]$row.CommandLine; argv = [ApkRuntimeProcess]::Arguments([string]$row.CommandLine); priorityClass = [ApkRuntimeProcess]::GetPriorityClass($Handle) }
  } catch { return $null }
}

function Get-ApkRuntimeIdentities($ProcessIds) {
  $ids = @($ProcessIds | ForEach-Object { [int]$_ } | Where-Object { $_ -gt 0 -and $_ -ne $PID } | Select-Object -Unique)
  if (-not $ids.Count) { return @() }
  $filter = ($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR '
  $rows = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)
  foreach ($row in $rows) {
    $processId = [int]$row.ProcessId
    if ($ids -notcontains $processId) { continue }
    $h = [ApkRuntimeProcess]::OpenProcess(0x1000, $false, [uint32]$processId)
    if ($h -eq [IntPtr]::Zero) { continue }
    try {
      $identity = Get-ApkRuntimeIdentityFromHandle $h $processId $row
      if ($identity) { $identity }
    } finally { [void][ApkRuntimeProcess]::CloseHandle($h) }
  }
}

function Get-ApkRuntimeIdentity([int]$ProcessId) {
  if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return $null }
  $h = [ApkRuntimeProcess]::OpenProcess(0x1000, $false, [uint32]$ProcessId)
  if ($h -eq [IntPtr]::Zero) { return $null }
  try { return Get-ApkRuntimeIdentityFromHandle $h $ProcessId }
  finally { [void][ApkRuntimeProcess]::CloseHandle($h) }
}

function Get-ApkRuntimeTreeSnapshot([int]$Root) {
  if ($Root -le 0 -or $Root -eq $PID) { return $null }
  $rootHandle = [ApkRuntimeProcess]::OpenProcess(0x1000, $false, [uint32]$Root)
  if ($rootHandle -eq [IntPtr]::Zero) { return $null }
  try {
    # One CIM snapshot supplies parent links and command lines. Each identity is
    # still checked against its own live handle, never accepted from CIM alone.
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine -ErrorAction Stop)
    $byPid = @{}
    $children = @{}
    foreach ($row in $rows) {
      $key = [string]$row.ProcessId
      $byPid[$key] = $row
      $parentKey = [string]$row.ParentProcessId
      if (-not $children.ContainsKey($parentKey)) { $children[$parentKey] = New-Object System.Collections.Generic.List[object] }
      $children[$parentKey].Add($row)
    }
    $rootRow = $byPid[[string]$Root]
    if (-not $rootRow) { return $null }
    $rootIdentity = Get-ApkRuntimeIdentityFromHandle $rootHandle $Root $rootRow
    if (-not $rootIdentity) { return $null }
    $found = New-Object System.Collections.Generic.List[object]
    $queue = New-Object System.Collections.Queue
    $seen = @{}
    $queue.Enqueue($Root)
    while ($queue.Count -gt 0 -and $seen.Count -lt 512) {
      $parent = [int]$queue.Dequeue()
      if ($seen[[string]$parent]) { continue }
      $seen[[string]$parent] = $true
      foreach ($row in $children[[string]$parent]) {
        $child = [int]$row.ProcessId
        if ($child -le 0 -or $child -eq $PID -or $seen[[string]$child]) { continue }
        $handle = [ApkRuntimeProcess]::OpenProcess(0x1000, $false, [uint32]$child)
        if ($handle -eq [IntPtr]::Zero) { continue }
        try { $identity = Get-ApkRuntimeIdentityFromHandle $handle $child $row }
        finally { [void][ApkRuntimeProcess]::CloseHandle($handle) }
        if ($identity) { $found.Add($identity); $queue.Enqueue($child) }
      }
    }
    if ($queue.Count -gt 0) { return $null }
    # Re-open by PID and query its current CIM identity after the tree walk.
    # Holding the first handle alone would not detect PID replacement.
    $currentRoot = Get-ApkRuntimeIdentity $Root
    if (-not $currentRoot -or $currentRoot.started -cne $rootIdentity.started -or $currentRoot.exe -cne $rootIdentity.exe -or $currentRoot.commandLine -cne $rootIdentity.commandLine) { return $null }
    return [pscustomobject]@{ root = $rootIdentity; currentRoot = $currentRoot; processes = @($found.ToArray()) }
  } finally { [void][ApkRuntimeProcess]::CloseHandle($rootHandle) }
}

function Get-ApkRuntimeTree([int]$Root) {
  $snapshot = Get-ApkRuntimeTreeSnapshot $Root
  if ($snapshot) {
    return $snapshot.processes
  }
  return @()
}

function Stop-ApkRuntimeIdentity($Identity) {
  if (-not $Identity -or [int]$Identity.pid -le 0 -or [int]$Identity.pid -eq $PID) { return $false }
  # Query + terminate + synchronize on ONE handle: PID recycling cannot redirect termination.
  $h = [ApkRuntimeProcess]::OpenProcess(0x101001, $false, [uint32]$Identity.pid)
  if ($h -eq [IntPtr]::Zero) { return $false }
  try {
    $now = Get-ApkRuntimeIdentityFromHandle $h ([int]$Identity.pid)
    if (-not $now -or $now.started -cne $Identity.started -or $now.exe -cne $Identity.exe -or $now.commandLine -cne $Identity.commandLine) { return $false }
    if (-not [ApkRuntimeProcess]::TerminateProcess($h, 1)) { return $false }
    return [ApkRuntimeProcess]::WaitForSingleObject($h, 2000) -eq 0
  } catch { return $false }
  finally { [void][ApkRuntimeProcess]::CloseHandle($h) }
}

if ($Action -eq 'Inspect') {
  $identity = Get-ApkRuntimeIdentity $TargetPid
  if ($identity) { $identity | ConvertTo-Json -Compress; exit 0 }
  exit 1
}
if ($Action -eq 'InspectMany') {
  try {
    $ids = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetPids)) | ConvertFrom-Json
    $identities = @(Get-ApkRuntimeIdentities $ids)
    ConvertTo-Json -InputObject $identities -Compress
    exit 0
  } catch { }
  exit 1
}
if ($Action -eq 'Terminate') {
  try {
    $identity = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Expected)) | ConvertFrom-Json
    if ([int]$identity.pid -eq $TargetPid -and (Stop-ApkRuntimeIdentity $identity)) { 'STOPPED'; exit 0 }
  } catch { }
  exit 1
}
if ($Action -eq 'Tree') {
  try { Get-ApkRuntimeTree $TargetPid | ConvertTo-Json -Compress; exit 0 } catch { }
  exit 1
}
if ($Action -eq 'TreeSnapshot') {
  try {
    $snapshot = Get-ApkRuntimeTreeSnapshot $TargetPid
    if ($snapshot) { $snapshot | ConvertTo-Json -Depth 5 -Compress; exit 0 }
  } catch { }
  exit 1
}

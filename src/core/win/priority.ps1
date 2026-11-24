# ApkStart process priority helper (ASCII only).
# QEMU is a CPU-hungry guest. Running it at Normal priority competes with the
# Windows shell, the pointer and every foreground app -- which is exactly what
# makes the whole desktop feel laggy while an Android app is open.
#
# We only adjust the exact PID list the caller already verified (real emulator
# path + this AVD's -datadir/-android-hw + process birth time). Image-name or
# command-line scans are deliberately not used: other people's emulators may
# share the image name or even an AVD name.
#   idle   : no app open, container parked (lowest CPU claim)
#   below  : app open, still yield to the Windows foreground
#   normal : user explicitly asked for maximum guest performance
param(
  [string]$Pids = '',
  [ValidateSet('idle', 'below', 'normal')][string]$Level = 'below'
)

$ErrorActionPreference = 'SilentlyContinue'
$map = @{ idle = 'Idle'; below = 'BelowNormal'; normal = 'Normal' }
$want = $map[$Level]
$changed = 0

$targets = @()
foreach ($token in @($Pids -split ',')) {
  if ($token -match '^[1-9]\d*$') { $targets += [int]$token }
}
foreach ($targetPid in ($targets | Select-Object -Unique)) {
  if ($targetPid -eq $PID) { continue }
  $gp = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -ne $gp) {
    try { $gp.PriorityClass = $want; $changed++ } catch { }
  }
}

"CHANGED=$changed"

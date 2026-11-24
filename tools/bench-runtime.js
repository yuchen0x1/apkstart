'use strict';
/**
 * Reproducible real-runtime baseline. Run on a machine with a provisioned
 * Android runtime and AVD:
 *
 *   node tools/bench-runtime.js [--headless] [--stop] [--json out.json]
 *
 * It starts the production EmulatorEngine (same auto profile the app uses),
 * waits for `sys.boot_completed=1`, then samples the verified process tree's
 * working set and CPU time. No numbers are synthesized when a probe fails.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EmulatorEngine } = require('../src/core/emulator');
const processOwner = require('../src/core/process-owner');
const store = require('../src/core/store');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const headless = args.includes('--headless');
const stopAfter = args.includes('--stop');
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(serial, argv, timeout = 12000) {
  const adbPath = store.getSettings().adbPath || 'adb';
  try {
    return execFileSync(adbPath, ['-s', serial, ...argv], {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) { return ''; }
}

async function probe({ port }) {
  const serial = `emulator-${port}`;
  const boot = adb(serial, ['shell', 'getprop', 'sys.boot_completed'], 6000);
  if (boot !== '1') return 'pending';
  const bootanim = adb(serial, ['shell', 'getprop', 'init.svc.bootanim'], 6000);
  if (bootanim && bootanim !== 'stopped') return 'pending';
  return 'ok';
}

function processSnapshot(pids) {
  if (!pids.length) return { rssMB: 0, cpuSec: 0, rows: [] };
  const quoted = pids.map((p) => `Get-Process -Id ${Number(p)} -ErrorAction SilentlyContinue`).join('; ');
  const script = `@(${quoted}) | Select-Object Id,ProcessName,WorkingSet64,TotalProcessorTime | ConvertTo-Json -Compress`;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let rows = [];
  try {
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim();
    const parsed = out ? JSON.parse(out.replace(/^\uFEFF/, '')) : [];
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) { rows = []; }
  let rss = 0;
  let cpuSec = 0;
  for (const row of rows) {
    rss += Number(row.WorkingSet64) || 0;
    const t = String(row.TotalProcessorTime || '');
    const m = /(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
    if (m) cpuSec += (Number(m[1] || 0) * 86400) + (Number(m[2]) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
  }
  return { rssMB: Math.round(rss / 1048576), cpuSec, rows };
}

(async () => {
  const emu = new EmulatorEngine(ROOT);
  const logs = [];
  const onLog = (line) => {
    logs.push(String(line));
    if (logs.length > 200) logs.shift();
  };
  const startedAt = Date.now();
  const result = await emu.start({ headless, probe, onLog, maxAttempts: 2 });
  const bootMs = Date.now() - startedAt;
  if (!result || !result.ok) {
    console.error(JSON.stringify({ ok: false, bootMs, result, logs }, null, 2));
    process.exit(1);
  }
  const serial = `emulator-${result.port}`;
  // Let the freshly booted guest settle before idle sampling.
  await sleep(15000);
  const tree = await processOwner.getProcessTree(emu.proc && emu.proc.pid);
  const pids = [...new Set([emu.proc && emu.proc.pid, ...tree.map((p) => p.pid)].filter(Boolean))];
  const first = processSnapshot(pids);
  const sampleMs = 10000;
  await sleep(sampleMs);
  const second = processSnapshot(pids);
  const cpuPctOneCore = Math.max(0, ((second.cpuSec - first.cpuSec) / (sampleMs / 1000)) * 100);
  const report = {
    ok: true,
    at: new Date().toISOString(),
    host: {
      platform: process.platform,
      cores: require('os').cpus().length,
      totalMemMB: Math.round(require('os').totalmem() / 1048576),
    },
    render: {
      headless,
      gpu: result.profile && result.profile.gpu,
      accel: result.profile && result.profile.accel,
      acceleration: result.profile && result.profile.acceleration,
      gpuInfo: emu.gpuInfo,
    },
    guest: {
      serial,
      abi: adb(serial, ['shell', 'getprop', 'ro.product.cpu.abi']),
      qemu: adb(serial, ['shell', 'getprop', 'ro.kernel.qemu']),
      hardware: adb(serial, ['shell', 'getprop', 'ro.hardware']),
      sdk: adb(serial, ['shell', 'getprop', 'ro.build.version.sdk']),
      surfaceflinger: adb(serial, ['shell', 'dumpsys', 'SurfaceFlinger']).split(/\r?\n/).filter((l) => /GLES|RenderEngine|Vulkan/i.test(l)).slice(0, 8),
    },
    bootMs,
    profile: result.profile,
    processTree: tree.map((p) => ({ pid: p.pid, exe: p.exe })),
    idle: {
      sampleSeconds: sampleMs / 1000,
      cpuPercentOfOneCore: Number(cpuPctOneCore.toFixed(1)),
      cpuPercentOfMachine: Number((cpuPctOneCore / require('os').cpus().length).toFixed(1)),
      rssMB: second.rssMB,
      processes: second.rows.map((r) => ({ pid: r.Id, name: r.ProcessName, rssMB: Math.round((Number(r.WorkingSet64) || 0) / 1048576) })),
    },
    logs: logs.slice(-80),
  };
  console.log(JSON.stringify(report, null, 2));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  if (stopAfter) {
    adb(serial, ['emu', 'kill'], 8000);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e && (e.stack || e.message));
  process.exit(1);
});

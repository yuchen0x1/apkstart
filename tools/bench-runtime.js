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
const attach = args.includes('--attach');
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : '';
const gpuIdx = args.indexOf('--force-gpu');
const forceGpu = gpuIdx >= 0 ? String(args[gpuIdx + 1] || '') : '';
const noSnapshot = args.includes('--no-snapshot');
const argValue = (name, fallback = 0) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) ? value : fallback;
};
const settleSeconds = Math.max(0, Math.min(300, argValue('--settle-seconds', 30)));
const sampleSeconds = Math.max(1, Math.min(60, argValue('--sample-seconds', 10)));
const sampleCount = Math.max(3, Math.min(20, argValue('--samples', 5)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let emu = null;
let startedByScript = false;

function adb(serial, argv, timeout = 12000, adbPort = 0, attempts = 1) {
  const adbPath = store.getSettings().adbPath || 'adb';
  const server = adbPort ? ['-P', String(adbPort)] : [];
  for (let i = 0; i < attempts; i += 1) {
    try {
      return execFileSync(adbPath, [...server, '-s', serial, ...argv], {
        encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: adbPort ? { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) } : process.env,
      }).trim();
    } catch (_) {
      if (i === attempts - 1) return '';
    }
  }
  return '';
}

async function probe({ port, adbPort }) {
  const serial = `emulator-${port}`;
  const out = adb(serial, ['shell', 'getprop sys.boot_completed; getprop init.svc.bootanim'], 6000, adbPort);
  const lines = out.split(/\r?\n/).map((x) => x.trim());
  if (lines[0] !== '1') return 'pending';
  if (lines[1] && lines[1] !== 'stopped') return 'pending';
  return 'ok';
}

function processSnapshot(pids, requiredPid) {
  if (!pids.length) throw new Error('cannot sample an empty process tree');
  const quoted = pids.map((p) => `Get-Process -Id ${Number(p)} -ErrorAction SilentlyContinue`).join('; ');
  // ConvertTo-Json cannot serialize TimeSpan; project plain numbers here.
  const script = `@(${quoted}) | Select-Object Id,ProcessName,`
    + `@{n='rssMB';e={[math]::Round($_.WorkingSet64/1MB,0)}},`
    + `@{n='cpuSec';e={[math]::Round($_.TotalProcessorTime.TotalSeconds,3)}} | ConvertTo-Json -Compress`;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let rows = [];
  try {
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim();
    const parsed = out ? JSON.parse(out.replace(/^\uFEFF/, '')) : [];
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new Error(`process sampling failed: ${error.message || error}`);
  }
  if (!rows.length || (requiredPid && !rows.some((row) => Number(row.Id) === Number(requiredPid)))) {
    throw new Error('process sampling returned no data for the runtime root process');
  }
  let rss = 0;
  let cpuSec = 0;
  for (const row of rows) {
    rss += (Number(row.rssMB) || 0) * 1048576;
    cpuSec += Number(row.cpuSec) || 0;
  }
  return { rssMB: Math.round(rss / 1048576), cpuSec, rows };
}

(async () => {
  if (attach && stopAfter) throw new Error('--stop cannot be used with --attach; attached runtimes are not owned by this benchmark');
  if (forceGpu) {
    const supported = require('../src/core/doctor').gpuCandidates('37.4.2.0');
    if (!supported.includes(forceGpu)) throw new Error(`unsupported GPU backend: ${forceGpu}`);
    store.saveSettings({ engine: { gpuMode: forceGpu, badGpu: '', ...(noSnapshot ? { keepSnapshot: false } : {}) } });
  } else if (noSnapshot) {
    store.saveSettings({ engine: { keepSnapshot: false } });
  }
  emu = new EmulatorEngine(ROOT);
  const logs = [];
  const onLog = (line) => {
    logs.push(String(line));
    if (logs.length > 200) logs.shift();
  };
  let result;
  let bootMs = null;
  let port;
  let adbPort;
  if (attach) {
    port = argValue('--port');
    adbPort = argValue('--adb-port', Number(process.env.APKSTART_ADB_PORT) || 5044);
    if (!port) throw new Error('--attach requires --port');
    result = { ok: true, port };
  } else {
    console.error('[bench] starting runtime...');
    const startedAt = Date.now();
    startedByScript = true;
    result = await emu.start({ headless, probe, onLog, maxAttempts: 2 });
    bootMs = Date.now() - startedAt;
    adbPort = emu.adbPort;
    console.error(`[bench] start returned ok=${!!result && result.ok} after ${bootMs}ms`);
    if (!result || !result.ok) {
      console.error(JSON.stringify({ ok: false, bootMs, result, logs }, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  const serial = `emulator-${result.port}`;
  await sleep(settleSeconds * 1000);
  const rootPid = attach ? await processOwner.pidOnPort(result.port) : (emu.proc && emu.proc.pid);
  if (!rootPid) throw new Error('cannot resolve running qemu PID for this port');
  const tree = await processOwner.getProcessTree(rootPid);
  const pids = [...new Set([rootPid, ...tree.map((p) => p.pid)].filter(Boolean))];
  const qemuInfo = await processOwner.getProcessInfo(rootPid);
  const cmd = (qemuInfo && qemuInfo.commandLine) || '';
  const opt = (name) => {
    const m = new RegExp(`\\s${name}\\s+(?:"([^"]+)"|(\\S+))`).exec(cmd);
    return m ? (m[1] || m[2] || '') : '';
  };
  const gpuInfo = await require('../src/core/gpu').probe().catch(() => null);
  const samples = [];
  let previous = processSnapshot(pids, rootPid);
  for (let i = 0; i < sampleCount; i += 1) {
    await sleep(sampleSeconds * 1000);
    const current = processSnapshot(pids, rootPid);
    const cpuPercentOfOneCore = Math.max(0,
      ((current.cpuSec - previous.cpuSec) / sampleSeconds) * 100);
    samples.push({
      cpuPercentOfOneCore: Number(cpuPercentOfOneCore.toFixed(1)),
      rssMB: current.rssMB,
    });
    previous = current;
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const cpuPctOneCore = median(samples.map((sample) => sample.cpuPercentOfOneCore));
  const rssMB = median(samples.map((sample) => sample.rssMB));
  const finalSnapshot = processSnapshot(pids, rootPid);
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
      gpu: (result.profile && result.profile.gpu) || opt('-gpu'),
      accel: result.profile && result.profile.accel,
      acceleration: result.profile && result.profile.acceleration,
      gpuInfo: emu.gpuInfo || gpuInfo,
    },
    guest: {
      serial,
      abi: adb(serial, ['shell', 'getprop', 'ro.product.cpu.abi'], 15000, adbPort, 3),
      qemu: adb(serial, ['shell', 'getprop', 'ro.kernel.qemu'], 15000, adbPort, 3),
      hardware: adb(serial, ['shell', 'getprop', 'ro.hardware'], 15000, adbPort, 3),
      sdk: adb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], 15000, adbPort, 3),
      surfaceflinger: adb(serial, ['shell', 'dumpsys', 'SurfaceFlinger'], 20000, adbPort, 2)
        .split(/\r?\n/).filter((l) => /GLES|RenderEngine|Vulkan/i.test(l)).slice(0, 8),
    },
    bootMs,
    adbPort,
    profile: result.profile || {
      gpu: opt('-gpu'), memoryMB: Number(opt('-memory')) || null,
      cores: Number(opt('-cores')) || null, attached: true,
    },
    processTree: tree.map((p) => ({ pid: p.pid, exe: p.exe })),
    idle: {
      settleSeconds,
      sampleSeconds,
      sampleCount,
      cpuPercentOfOneCoreSamples: samples.map((sample) => sample.cpuPercentOfOneCore),
      cpuPercentOfOneCore: Number(cpuPctOneCore.toFixed(1)),
      cpuPercentOfMachine: Number((cpuPctOneCore / require('os').cpus().length).toFixed(1)),
      rssMB,
      rssSamplesMB: samples.map((sample) => sample.rssMB),
      processes: finalSnapshot.rows.map((r) => ({ pid: r.Id, name: r.ProcessName, rssMB: Number(r.rssMB) || 0 })),
    },
    logs: logs.slice(-80),
  };
  console.log(JSON.stringify(report, null, 2));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error(e && (e.stack || e.message));
  process.exitCode = 1;
}).finally(async () => {
  if (stopAfter && emu && startedByScript) {
    const stopped = await emu.stop().catch(() => false);
    if (!stopped) {
      console.error('[bench] failed to stop benchmark-owned runtime safely');
      process.exitCode = 1;
    }
  }
});

'use strict';
/**
 * Read-only GPU capability probe.
 *
 * QEMU's `-gpu host` is the best default on a real desktop GPU, but it cannot
 * work on a basic display adapter, a remote desktop virtual display or a
 * headless VM. Waiting 20+ seconds for host rendering to fail before falling
 * back makes boot look broken. This module only classifies what Windows already
 * reports; it never changes a driver or forces a global rendering backend.
 */
const { execFile } = require('child_process');

const CACHE_MS = 10 * 60 * 1000;
// Operating-system placeholders and remote/indirect display drivers. Real
// hardware names (AMD/NVIDIA/Intel/Qualcomm) are deliberately never matched.
const PSEUDO = /microsoft basic display|microsoft remote display|remote display adapter|microsoft hyper-v video|hyper-v video|virtual display|oray idd|parsec virtual|sunlogin virtual|usbmmidd|idddriver/i;

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const name = String(row.name || row.Name || '').trim();
  if (!name) return null;
  return {
    name,
    driverVersion: String(row.driverVersion || row.DriverVersion || '').trim(),
    driverDate: String(row.driverDate || row.DriverDate || '').trim(),
    processor: String(row.processor || row.VideoProcessor || '').trim(),
    status: String(row.status || row.Status || '').trim(),
    vramMB: Math.max(0, Math.round(Number(row.adapterRam || row.AdapterRAM || 0) / 1048576)) || 0,
  };
}

/**
 * Pure classifier. @param rows Win32_VideoController-shaped objects.
 */
function classify(rows, { remoteSession = false, sessionName = '' } = {}) {
  const adapters = (Array.isArray(rows) ? rows : (rows ? [rows] : []))
    .map(normalizeRow).filter(Boolean);
  const physical = adapters.filter((a) => !PSEUDO.test(a.name) && !/^unknown$/i.test(a.name));
  const remote = !!remoteSession || /^rdp-/i.test(String(sessionName || ''));
  const hybrid = new Set(physical.map((a) => a.name.toLowerCase())).size >= 2;
  const reasons = [];
  if (remote) reasons.push('当前是远程桌面会话，宿主 OpenGL/Vulkan 交换链不可靠');
  if (!physical.length) {
    reasons.push(adapters.length
      ? `只检测到系统/远程伪显卡（${adapters.map((a) => a.name).join('、')}）`
      : '未检测到显卡信息');
  } else {
    reasons.push(`检测到 ${physical.map((a) => a.name).join(' + ')}${hybrid ? '（混合显卡）' : ''}`);
    const poor = physical.filter((a) => a.status && !/^ok$/i.test(a.status));
    if (poor.length) reasons.push(`显卡状态异常：${poor.map((a) => `${a.name}(${a.status})`).join('、')}`);
  }
  const preferSoftware = remote || physical.length === 0;
  return {
    adapters,
    physical: physical.map((a) => a.name),
    hybrid,
    remoteSession: remote,
    hardware: physical.length > 0,
    preferSoftware,
    reasons,
  };
}

function summary(info) {
  if (!info) return '未检测';
  if (info.preferSoftware) return info.reasons[0] || '未检测到可用显卡';
  const first = info.adapters.find((a) => !PSEUDO.test(a.name));
  if (!first) return '未检测到可用显卡';
  return `${first.name}${first.driverVersion ? ` · 驱动 ${first.driverVersion}` : ''}`
    + `${info.hybrid ? ' · 混合显卡' : ''}`;
}

function runPowerShell(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}

let cache = null;
let cacheAt = 0;

async function probe({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  let result;
  if (process.platform !== 'win32') {
    result = classify([], {});
    result.platform = process.platform;
  } else {
    const script = [
      '$rows = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |',
      '  ForEach-Object {',
      '    [pscustomobject]@{',
      '      name = [string]$_.Name;',
      '      driverVersion = [string]$_.DriverVersion;',
      "      driverDate = $(if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { '' });",
      '      status = [string]$_.Status;',
      '      processor = [string]$_.VideoProcessor;',
      '      adapterRam = [double]$_.AdapterRAM',
      '    }',
      '  });',
      '$rows | ConvertTo-Json -Compress -Depth 3',
    ].join(' ');
    const text = await runPowerShell(script);
    let rows = [];
    if (text) {
      try {
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) { rows = []; }
    }
    result = classify(rows, {
      sessionName: process.env.SESSIONNAME || '',
      remoteSession: /^rdp-/i.test(process.env.SESSIONNAME || ''),
    });
    result.platform = 'win32';
    if (!text) result.error = 'wmi-unavailable';
  }
  result.at = Date.now();
  result.summary = summary(result);
  cache = result;
  cacheAt = Date.now();
  return result;
}

module.exports = { classify, summary, probe, PSEUDO };

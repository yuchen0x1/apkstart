'use strict';
/**
 * Real Windows process-safety validation (no mocks for the OS boundary).
 *
 * A tiny console executable is compiled as `emulator.exe` so the ownership
 * predicate sees a real PE image, a real command line and a real birth time.
 * It runs beside a same-image "manual QEMU", a second AVD instance, Windows
 * Terminal / PowerShell sentinels and a fake updater callback that throws.
 *
 * Scenarios E (different Windows user session) cannot be created without a
 * second interactive account; it is reported as skipped, never as passed.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const processOwner = require('../src/core/process-owner');
const WINDOWCTL = path.join(__dirname, '..', 'src', 'core', 'win', 'windowctl.ps1');
const PRIORITY = path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1');
const OWNER = path.join(__dirname, '..', 'src', 'core', 'win', 'process-owner.ps1');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const tamperStarted = (value) => String(value).replace(/.$/, (digit) => (digit === '0' ? '1' : '0'));

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function runPs(args, timeout = 30000) {
  return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', timeout, windowsHide: true,
  });
}

async function waitInfo(pid, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const info = await processOwner.getProcessInfo(pid);
    if (info) return info;
    await sleep(100);
  }
  throw new Error(`process ${pid} identity did not become available`);
}

function waitExit(proc, timeout = 8000) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function spawnSentinel(name, file, args) {
  const proc = spawn(file, args, { stdio: 'ignore', windowsHide: true });
  proc.on('error', () => {});
  proc.__label = name;
  return proc;
}

function terminalPids() {
  const r = runPs(['-Command', 'Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id']);
  return String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).sort();
}

function priorityPayload(info, overrides = {}) {
  return Buffer.from(JSON.stringify([{
    pid: Number(info.pid),
    started: String(info.started),
    exe: processOwner.realPath(info.exe),
    cmdHash: sha256(info.commandLine),
    ...overrides,
  }]), 'utf8').toString('base64');
}

function setPriority(info, level, overrides) {
  return runPs(['-File', PRIORITY, '-Expected', priorityPayload(info, overrides), '-Level', level]);
}

function priorityClass(pid) {
  const r = runPs(['-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).PriorityClass.ToString()`]);
  return String(r.stdout || '').trim();
}

test('Windows process safety: coexisting QEMU/terminal/instances never cross-kill', { skip: process.platform !== 'win32', timeout: 240000 }, async (t) => {
  assert(fs.existsSync(CSC), `missing csc.exe: ${CSC}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-proc-safety-'));
  const runtime = path.join(tmp, 'runtime');
  const emulatorDir = path.join(runtime, 'emulator');
  const fakeExe = path.join(emulatorDir, 'emulator.exe');
  const avdRoot = path.join(tmp, 'avds');
  const alphaDir = path.join(avdRoot, 'alpha.avd');
  const betaDir = path.join(avdRoot, 'beta.avd');
  fs.mkdirSync(path.join(emulatorDir, 'qemu'), { recursive: true });
  for (const dir of [alphaDir, betaDir]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hardware-qemu.ini'), '');
  }
  const source = path.join(tmp, 'fake-emu.cs');
  fs.writeFileSync(source, 'public class FakeEmu { public static void Main(string[] args) { System.Threading.Thread.Sleep(120000); } }\n');
  const build = spawnSync(CSC, ['/nologo', '/target:exe', `/out:${fakeExe}`, source], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(build.status, 0, `failed to compile fake emulator: ${build.stdout || build.stderr}`);

  const children = [];
  const track = (p) => { children.push(p); return p; };
  const launchEmu = (label, args) => track(spawn(fakeExe, args, { cwd: emulatorDir, stdio: 'ignore', windowsHide: true }));
  const cmdSentinel = track(spawnSentinel('cmd', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'ping -n 180 127.0.0.1']));
  const psSentinel = track(spawnSentinel('powershell', PS, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 180']));
  const terminalsBefore = terminalPids();

  const avdArgs = (name, dir) => ['-avd', name, '-datadir', dir, '-android-hw', path.join(dir, 'hardware-qemu.ini')];
  const alpha1 = launchEmu('alpha1', avdArgs('alpha', alphaDir));
  const beta1 = launchEmu('beta1', avdArgs('beta', betaDir));
  const manual = launchEmu('manual', ['-port', '5599']);

  t.after(() => {
    for (const p of children) { try { p.kill(); } catch (_) { /* test-owned */ } }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  const infoA1 = await waitInfo(alpha1.pid);
  const infoB1 = await waitInfo(beta1.pid);
  const infoManual = await waitInfo(manual.pid);
  const infoCmd = await waitInfo(cmdSentinel.pid);
  const infoPs = await waitInfo(psSentinel.pid);
  const ownsAlpha = (p) => processOwner.ownsEmulator(p, { avdName: 'alpha', avdDir: alphaDir, emulatorDirs: [runtime] });
  const ownsBeta = (p) => processOwner.ownsEmulator(p, { avdName: 'beta', avdDir: betaDir, emulatorDirs: [runtime] });

  await t.test('ownership predicate distinguishes instance, AVD and manual same-image process', () => {
    assert.equal(ownsAlpha(infoA1), true, 'alpha instance should be owned');
    assert.equal(ownsAlpha(infoB1), false, 'beta AVD must never match alpha');
    assert.equal(ownsAlpha(infoManual), false, 'same-image process without AVD evidence must not match');
    assert.equal(ownsBeta(infoB1), true, 'beta instance should be owned by beta scope');
  });

  await t.test('A: closing one runtime leaves Terminal, PowerShell and cmd sentinels alive', async () => {
    assert.equal(await processOwner.terminateOwnedProcess(infoA1, ownsAlpha), true, 'verified alpha should be terminated');
    assert.equal(await waitExit(alpha1), true, 'alpha process should exit');
    assert.equal(alive(cmdSentinel.pid), true, 'cmd sentinel must survive');
    assert.equal(alive(psSentinel.pid), true, 'PowerShell sentinel must survive');
    assert.equal(alive(infoB1.pid), true, 'second ApkStart instance must survive');
    assert.deepEqual(terminalPids(), terminalsBefore, 'Windows Terminal set must be unchanged');
  });

  await t.test('B: manual same-image QEMU is refused and stays alive', async () => {
    assert.equal(await processOwner.terminateOwnedProcess(infoManual, ownsAlpha), false, 'manual QEMU has no AVD evidence');
    assert.equal(alive(manual.pid), true, 'manual QEMU must stay alive');
  });

  await t.test('C: second ApkStart runtime is independent', async () => {
    assert.equal(await processOwner.terminateOwnedProcess(infoB1, ownsBeta), true, 'verified beta should be terminated');
    assert.equal(await waitExit(beta1), true, 'beta process should exit');
    assert.equal(alive(manual.pid), true, 'manual QEMU must survive sibling termination');
    assert.equal(alive(cmdSentinel.pid), true, 'cmd sentinel must survive sibling termination');
  });

  await t.test('D: stale identity and tampered birth time cannot redirect termination', async () => {
    assert.equal(await processOwner.terminateOwnedProcess(infoA1, () => true), false, 'stale identity must be refused');
    const alpha2 = launchEmu('alpha2', avdArgs('alpha', alphaDir));
    const infoA2 = await waitInfo(alpha2.pid);
    const staleBirth = { ...infoA2, started: tamperStarted(infoA2.started) };
    assert.equal(await processOwner.terminateOwnedProcess(staleBirth, () => true), false, 'tampered birth time must be refused');
    assert.equal(alive(alpha2.pid), true, 'target with tampered identity must stay alive');
    const staleExe = { ...infoA2, exe: infoCmd.exe };
    assert.equal(await processOwner.terminateOwnedProcess(staleExe, () => true), false, 'tampered image path must be refused');
    assert.equal(alive(alpha2.pid), true, 'target with tampered image path must stay alive');

    // The PowerShell helper has its own handle-pinned check, not just the JS caller.
    const forged = Buffer.from(JSON.stringify({ ...infoA2, started: tamperStarted(infoA2.started) }), 'utf8').toString('base64');
    const direct = runPs(['-File', OWNER, '-Action', 'Terminate', '-TargetPid', String(infoA2.pid), '-Expected', forged]);
    assert.notEqual(direct.status, 0, 'helper must reject forged identity');
    assert.equal(alive(alpha2.pid), true, 'helper must not terminate on forged identity');
    assert.equal(await processOwner.terminateOwnedProcess(infoA2, ownsAlpha), true, 'unchanged identity should still terminate');
    assert.equal(await waitExit(alpha2), true, 'alpha2 should exit');
  });

  await t.test('E: different Windows user session (not available in this environment)', { skip: 'needs a second interactive Windows account/session' }, () => {});

  await t.test('F: updater ownership callback failure fails closed', async () => {
    const alpha3 = launchEmu('alpha3', avdArgs('alpha', alphaDir));
    const infoA3 = await waitInfo(alpha3.pid);
    let thrown = false;
    const result = await processOwner.terminateOwnedProcess(infoA3, () => { thrown = true; throw new Error('updater crashed mid-check'); });
    assert.equal(thrown, true, 'callback should have run');
    assert.equal(result, false, 'throwing callback must return false, not kill');
    assert.equal(alive(alpha3.pid), true, 'unrelated program must survive updater failure');
    assert.equal(await processOwner.terminateOwnedProcess(infoA3, ownsAlpha), true, 'verified cleanup still works');
    assert.equal(await waitExit(alpha3), true, 'alpha3 should exit');
  });

  await t.test('priority helper changes only the exact verified process', async (t2) => {
    const victim = track(spawnSentinel('priority-victim', PS, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120']));
    const info = await waitInfo(victim.pid);
    t2.after(() => { try { victim.kill(); } catch (_) { /* ignore */ } });

    const idle = setPriority(info, 'idle');
    assert.equal(idle.status, 0, idle.stderr || idle.stdout);
    assert.match(String(idle.stdout), /CHANGED=1/, 'exact identity should change priority once');
    assert.equal(priorityClass(victim.pid), 'Idle', 'priority should actually be Idle');

    const normal = setPriority(info, 'normal');
    assert.match(String(normal.stdout), /CHANGED=1/, 'priority should be restored');
    assert.equal(priorityClass(victim.pid), 'Normal');

    const wrongBirth = setPriority(info, 'idle', { started: tamperStarted(info.started) });
    assert.match(String(wrongBirth.stdout), /CHANGED=0/, 'tampered birth time must not change priority');
    assert.equal(priorityClass(victim.pid), 'Normal', 'priority must stay unchanged');

    const wrongHash = setPriority(info, 'idle', { cmdHash: '0'.repeat(64) });
    assert.match(String(wrongHash.stdout), /CHANGED=0/, 'tampered command hash must not change priority');
    assert.equal(priorityClass(victim.pid), 'Normal');

    const wrongExe = setPriority(info, 'idle', { exe: processOwner.realPath(infoManual.exe) });
    assert.match(String(wrongExe.stdout), /CHANGED=0/, 'tampered image path must not change priority');
    assert.equal(priorityClass(victim.pid), 'Normal');
    assert.equal(alive(victim.pid), true, 'sentinel must remain alive');

    const empty = runPs(['-File', PRIORITY, '-Expected', '', '-Level', 'idle']);
    assert.match(String(empty.stdout), /CHANGED=0/);
  });

  await t.test('window helper refuses missing or forged identity', async (t2) => {
    const victim = track(spawnSentinel('window-victim', PS, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120']));
    const info = await waitInfo(victim.pid);
    t2.after(() => { try { victim.kill(); } catch (_) { /* ignore */ } });
    const json = path.join(tmp, 'window.json');

    fs.writeFileSync(json, JSON.stringify({ pid: Number(info.pid), action: 'get' }));
    const missing = runPs(['-File', WINDOWCTL, json]);
    assert.match(String(missing.stdout), /ERR=identity-required/);

    fs.writeFileSync(json, JSON.stringify({
      pid: Number(info.pid), action: 'get',
      identity: {
        started: String(info.started).replace(/.$/, (digit) => (digit === '0' ? '1' : '0')),
        exe: info.exe,
        cmdHash: sha256(info.commandLine),
      },
    }));
    const forged = runPs(['-File', WINDOWCTL, json]);
    assert.match(String(forged.stdout), /ERR=identity-mismatch/);
    assert.equal(alive(victim.pid), true);
  });

  await t.test('window helper positive path on a real GUI window', { skip: 'no GUI window is launched by this process-level suite' }, () => {});
});

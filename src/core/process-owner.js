'use strict';
/** 进程归属验证失败即拒绝操作：PID、端口或名称单独都不是终止依据。 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WIN_HELPER = path.join(__dirname, 'win', 'process-owner.ps1');
const validPid = (pid) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0 && Number(pid) !== process.pid;
const validPort = (port) => Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535;

function realPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return '';
  try {
    let p = fs.realpathSync.native(value);
    if (process.platform === 'win32') {
      p = p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
    }
    return path.normalize(p);
  } catch (_) { return ''; }
}

function samePath(a, b) {
  const x = realPath(a);
  return !!x && x === realPath(b);
}

function narrowDirectory(dir) {
  const p = realPath(dir);
  if (!p || p === path.parse(p).root) return '';
  // 即便误放了模拟器二进制，也不能让用户目录、系统目录或磁盘根变成信任范围。
  if (/^(?:users|home|root|usr|bin|sbin|opt|var|tmp|windows|program files(?: \(x86\))?|programdata|appdata|desktop|downloads|documents)$/i.test(path.basename(p))) return '';
  for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key] && samePath(p, process.env[key])) return '';
  }
  try { return fs.statSync(p).isDirectory() ? p : ''; } catch (_) { return ''; }
}

function checkedEmulatorDir(dir) {
  const p = narrowDirectory(dir);
  if (!p) return '';
  const name = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  try {
    const exe = realPath(path.join(p, name));
    // 二进制链接到目录外时，不得授予整个目录的信任。
    if (!exe || path.dirname(exe) !== p || !fs.statSync(exe).isFile()) return '';
    if (!fs.statSync(path.join(p, 'qemu')).isDirectory()) return '';
    return p;
  } catch (_) { return ''; }
}

/** Accept a verified emulator tree, or a runtime/engine containing that tree, never its ancestors. */
function emulatorScopes(dirs) {
  const roots = new Set();
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    if (typeof dir !== 'string' || !dir || dir.includes(';') || !narrowDirectory(dir)) continue;
    const root = checkedEmulatorDir(dir) || checkedEmulatorDir(path.join(dir, 'emulator'));
    if (root) roots.add(root);
  }
  return [...roots];
}

function emulatorRoot(exe) {
  const p = realPath(exe);
  if (!p) return '';
  const name = path.basename(p);
  let root = '';
  if (/^emulator(?:\.exe)?$/i.test(name)) root = path.dirname(p);
  else if (/^qemu-system-(?:x86_64|i386|aarch64|armel)(?:\.exe)?$/i.test(name)) {
    const host = path.dirname(p);
    const qemu = path.dirname(host);
    if (!/^(?:windows|linux|darwin)-(?:x86_64|aarch64)$/i.test(path.basename(host)) || path.basename(qemu).toLowerCase() !== 'qemu') return '';
    root = path.dirname(qemu);
  }
  return root ? checkedEmulatorDir(root) : '';
}

// Windows CRT quoting, not a shell parser: retain ordinary backslashes, decode quotes once.
function windowsArgv(command) {
  const args = [];
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] || '') && i < command.length) i += 1;
    if (i >= command.length) break;
    let arg = '', quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === '\\') { slashes += 1; i += 1; }
      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else quoted = !quoted;
        i += 1;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < command.length) arg += command[i++];
      }
    }
    if (quoted) return [];
    args.push(arg);
  }
  return args;
}

function optionValues(args, key) {
  const values = [];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === key) values.push(args[i + 1] || '');
  }
  return values;
}

function ownsEmulator(info, { avdName, avdDir, emulatorDirs = null } = {}) {
  if (!info || !validPid(info.pid) || !info.started || !avdName) return false;
  const root = emulatorRoot(info.exe);
  if (!root || (emulatorDirs && !emulatorScopes(emulatorDirs).includes(root))) return false;
  const args = info.argv || windowsArgv(info.commandLine || '');
  if (!args.length || !samePath(args[0], info.exe)) return false;
  const names = optionValues(args, '-avd').concat(args.filter((x) => x.startsWith('@')).map((x) => x.slice(1)));
  if (names.some((x) => x !== avdName)) return false;
  const data = optionValues(args, '-datadir');
  const hw = optionValues(args, '-android-hw');
  if (data.some((x) => !samePath(x, avdDir))) return false;
  if (hw.some((x) => !samePath(x, path.join(avdDir, 'hardware-qemu.ini')))) return false;
  const homeMatches = info.avdHome && samePath(info.avdHome, path.dirname(avdDir));
  // AVD names are not globally unique. Require an exact canonical data/home path too.
  return (names.length > 0 && (data.length > 0 || homeMatches)) || hw.length > 0;
}

function sameIdentity(a, b) {
  return !!a && !!b && Number(a.pid) === Number(b.pid) && a.started === b.started
    && a.exe === b.exe && a.commandLine === b.commandLine;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
}

async function getProcessInfo(pid) {
  if (!validPid(pid)) return null;
  if (process.platform === 'win32') {
    try {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_HELPER, '-Action', 'Inspect', '-TargetPid', String(pid)]);
      const data = JSON.parse(out.replace(/^\uFEFF/, ''));
      return data && Number(data.pid) === Number(pid) && data.started && realPath(data.exe)
        ? { ...data, exe: realPath(data.exe) } : null;
    } catch (_) { return null; }
  }
  if (process.platform !== 'linux') return null;
  try {
    const base = `/proc/${Number(pid)}`;
    const start = () => {
      const stat = fs.readFileSync(`${base}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    };
    const started = start();
    const exe = realPath(`${base}/exe`);
    const raw = fs.readFileSync(`${base}/cmdline`);
    const argv = raw.toString('utf8').split('\0').filter(Boolean);
    let avdHome = '';
    try { avdHome = fs.readFileSync(`${base}/environ`, 'utf8').split('\0').find((x) => x.startsWith('ANDROID_AVD_HOME='))?.slice(17) || ''; } catch (_) { /* optional evidence */ }
    if (!started || !exe || !argv.length || start() !== started) return null;
    return { pid: Number(pid), started, exe, argv, avdHome, commandLine: raw.toString('base64') };
  } catch (_) { return null; }
}

// Linux has no race-free process.kill(pid) API in Node. Pin a pidfd before comparing
// /proc identity and signalling; if Python/pidfd is unavailable, refuse to kill.
const PIDFD_STOP = `import os,sys,json,base64,signal,select
try:
 e=json.loads(base64.b64decode(sys.argv[1])); p=int(e['pid'])
 fd=os.pidfd_open(p,0)
 try:
  b='/proc/'+str(p)
  with open(b+'/stat') as f: start=f.read().rsplit(') ',1)[1].split()[19]
  with open(b+'/cmdline','rb') as f: cmd=base64.b64encode(f.read()).decode('ascii')
  if start!=e['started'] or os.path.realpath(b+'/exe')!=e['exe'] or cmd!=e['commandLine']: sys.exit(1)
  signal.pidfd_send_signal(fd,getattr(signal,sys.argv[2]),None,0)
  if not select.select([fd],[],[],2)[0]: sys.exit(1)
  print('STOPPED')
 finally: os.close(fd)
except Exception: sys.exit(1)
`;

async function terminateOwnedProcess(info, owns, signal = 'SIGKILL') {
  if (!info || !validPid(info.pid) || !owns(info)) return false;
  const current = await getProcessInfo(info.pid);
  if (!sameIdentity(info, current) || !owns(current)) return false;
  const expected = Buffer.from(JSON.stringify(current)).toString('base64');
  if (process.platform === 'win32') {
    return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_HELPER,
      '-Action', 'Terminate', '-TargetPid', String(info.pid), '-Expected', expected])) === 'STOPPED';
  }
  if (process.platform === 'linux' && ['SIGTERM', 'SIGKILL'].includes(signal)) {
    return (await run('python3', ['-I', '-c', PIDFD_STOP, expected, signal])) === 'STOPPED';
  }
  return false;
}

function parseListeners(text, windows) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    if (windows) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m) found.push({ port: Number(m[1]), pid: Number(m[2]) });
    } else {
      const cols = line.trim().split(/\s+/);
      const m = /:(\d+)$/.exec(cols[3] || '');
      if (cols[0] !== 'LISTEN' || !m) continue;
      for (const match of line.matchAll(/\bpid=(\d+)\b/g)) found.push({ port: Number(m[1]), pid: Number(match[1]) });
    }
  }
  return found;
}

async function listeners(port = 0) {
  if (port && !validPort(port)) return [];
  let out = '';
  if (process.platform === 'win32') out = await run('netstat.exe', ['-ano', '-p', 'TCP']);
  else if (process.platform === 'linux') out = await run('ss', ['-H', '-ltnp', ...(port ? [`sport = :${Number(port)}`] : [])]);
  else return [];
  return parseListeners(out, process.platform === 'win32').filter((x) => (!port || x.port === Number(port)) && validPid(x.pid));
}

async function pidOnPort(port) {
  if (!validPort(port)) return 0;
  const pids = [...new Set((await listeners(Number(port))).map((x) => x.pid))];
  return pids.length === 1 ? pids[0] : 0;
}

module.exports = { realPath, samePath, emulatorRoot, emulatorScopes, windowsArgv, optionValues,
  ownsEmulator, sameIdentity, getProcessInfo, terminateOwnedProcess, listeners, pidOnPort };

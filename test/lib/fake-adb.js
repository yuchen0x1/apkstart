'use strict';
/**
 * 测试用「假 adb 客户端」：把 Android 侧目录映射到本机临时目录，
 * 并实现 sharer / backup 真正用到的那几条 shell 命令
 * （mkdir / find+stat / sha256sum / mv / rm / stat -c）。
 *
 * 目的：端到端地验证真实代码路径（哈希、临时文件、原子替换、冲突副本），
 * 而不是 mock 出一套「永远正确」的假逻辑。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 从命令串里取出所有单引号参数（按 POSIX 规则还原 '\''） */
function quotedArgs(cmd) {
  const out = [];
  const re = /'((?:[^']|'\\'')*)'/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1].replace(/'\\''/g, "'"));
  return out;
}

function walkFiles(dir, base = dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walkFiles(full, base, out);
    else if (it.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

class FakeAdb {
  constructor(remoteRoot) {
    this.remoteRoot = remoteRoot;
    this.pushCount = 0;
    this.pullCount = 0;
    this.commands = [];
    this.supportsStat = true;
    this.supportsSha = true;
    this.online = true;
  }

  async isOnline() { return this.online; }

  async push(local, remote) {
    this.pushCount += 1;
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    fs.copyFileSync(local, remote);
  }

  async pull(remote, local) {
    this.pullCount += 1;
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.copyFileSync(remote, local);
  }

  listRemote(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).map((it) => {
      const st = fs.statSync(path.join(dir, it.name));
      return { name: it.name, isDir: it.isDirectory(), size: st.size };
    });
  }

  async shell(cmd) {
    this.commands.push(cmd);
    const c = String(cmd).trim();

    if (/^command -v sha256sum/.test(c)) return this.supportsSha ? '/system/bin/sha256sum\n' : '';
    if (/^command -v md5sum/.test(c)) return '';

    if (/^mkdir -p /.test(c)) {
      for (const p of quotedArgs(c)) fs.mkdirSync(p, { recursive: true });
      return '';
    }

    let m = /^cd '((?:[^']|'\\'')*)' 2>\/dev\/null && find \. -type f 2>\/dev\/null \| head -n 1/.exec(c);
    if (m) {
      const root = m[1].replace(/'\\''/g, "'");
      const all = fs.existsSync(root) ? walkFiles(root) : [];
      return all.length ? `./${all[0].rel}` : '';
    }

    m = /^cd '((?:[^']|'\\'')*)' 2>\/dev\/null && find \. -type f -exec stat/.exec(c);
    if (m) {
      if (!this.supportsStat) return '';
      const root = m[1].replace(/'\\''/g, "'");
      if (!fs.existsSync(root)) return '';
      return walkFiles(root).map((f) => {
        const st = fs.statSync(f.full);
        const mt = Math.floor(st.mtimeMs / 1000);
        const ct = Math.floor(st.ctimeMs / 1000);
        return `${mt}|${ct}|${st.size}|./${f.rel}`;
      }).join('\n');
    }

    m = /^cd '((?:[^']|'\\'')*)' && sha256sum -- /.exec(c);
    if (m) {
      if (!this.supportsSha) return '';
      const root = m[1].replace(/'\\''/g, "'");
      const args = quotedArgs(c).slice(1);
      const lines = [];
      for (const a of args) {
        const rel = a.replace(/^\.\//, '');
        const full = path.join(root, rel);
        if (!fs.existsSync(full)) continue;
        lines.push(`${sha256(fs.readFileSync(full))}  ./${rel}`);
      }
      return lines.join('\n');
    }

    m = /^mv -f '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'$/.exec(c);
    if (m) {
      const from = m[1].replace(/'\\''/g, "'");
      const to = m[2].replace(/'\\''/g, "'");
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return '';
    }

    if (/^rm -f /.test(c)) {
      for (const p of quotedArgs(c)) { try { fs.rmSync(p, { force: true }); } catch (_) { /* ignore */ } }
      return '';
    }

    m = /^stat -c '%s' '((?:[^']|'\\'')*)'/.exec(c);
    if (m) {
      const p = m[1].replace(/'\\''/g, "'");
      try { return String(fs.statSync(p).size); } catch (_) { return ''; }
    }

    return '';
  }
}

/** 建一套临时环境：Windows 目录 / Android 目录 / 数据目录 / 假客户端 */
function makeEnv(prefix = 'apkstart-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const localDir = path.join(root, 'win');
  const remoteDir = path.join(root, 'android');
  const dataDir = path.join(root, 'data');
  for (const d of [localDir, remoteDir, dataDir]) fs.mkdirSync(d, { recursive: true });
  const fake = new FakeAdb(remoteDir);
  return { root, localDir, remoteDir, dataDir, fake };
}

/** 写文件并把 mtime 推到 60 秒前（同步器会跳过 1.5 秒内还在改的文件） */
function writeStable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() - 60000);
  fs.utimesSync(file, t, t);
}

module.exports = { FakeAdb, makeEnv, writeStable, walkFiles, quotedArgs, sha256 };

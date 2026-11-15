'use strict';
/**
 * 在线更新：从 GitHub Releases（RoutineMiku/apkstart）取最新版本，下载并原地替换。
 *
 * 三个形态都要照顾到：
 *   - 安装版（NSIS）：下载 `ApkStart-x.y.z-Setup.exe`，静默安装（/S）；
 *   - 轻量版（便携 zip，运行时按需下载）：下载 `ApkStart-vX-win64-portable.zip`，
 *     解压后覆盖程序目录 —— 运行时目录（%APPDATA%\apkstart\runtime）与已装应用、
 *     快照全都在用户目录里，替换程序文件不会动它们；
 *   - 完整版（便携但带 runtime）：同轻量版，只是目录里多了 resources\runtime。
 *
 * 替换不能在本进程里做（exe 正被占用），所以生成一段 PowerShell 脚本，
 * 用 EncodedCommand 交给独立进程：等本进程退出 → 复制文件 → 重新拉起。
 * 用 base64 传脚本而不是写 .ps1 文件，是为了绕开「路径含中文时脚本被按 GBK 解码」
 * 这类老问题（PowerShell 5.1 读无 BOM 脚本会按 ANSI 解释）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti, sha256File } = require('./download');
const { ZipFile, safeEntryPath } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'yuchen0x1';   // 只检查本仓库的发布
const REPO = 'apkstart';

// 更新包解压的硬上限：正常便携包 ~180MB（含运行时整包另算），
// 4GB 足够覆盖任何合理发行版，又能挡住解压炸弹把磁盘写满。
const MAX_EXTRACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const SKIP_ENTRY = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i;

/** PowerShell 单引号字符串：内部的 ' 要写成 '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() 给 sources 用：决定「走 GitHub 还是 Gitee」「有没有镜像前缀」
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** 安装形态：安装版（有卸载器）还是便携包 */
  get flavor() {
    try {
      const un = fs.readdirSync(this.installDir).find((n) => /^Uninstall .*\.exe$/i.test(n));
      if (un) return 'setup';
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * 检查更新：GitHub / Gitee 并发问，取版本号更高的，资产取并集。
   * 具体下载地址在 prepare() 里再做一次真实测速排序。
   */
  /**
   * @param {{force?:boolean}} [opts] force=true 时跳过 10 分钟的版本缓存
   *        （用户主动点「检查更新」应该拿到最新结果；启动时的静默检查走缓存）
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // 发行版里同时挂着「便携包」和「运行时整包」（ApkStart-runtime-*.zip）。
    // 兜底的 .zip 匹配必须把运行时整包排除掉：某次发布如果只有运行时整包、
    // 没有便携包，旧逻辑会把它当更新包解压进程序目录（多出 1.5GB 文件、程序也被换坏）。
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // 注意带上 parts：Gitee 的分片包没有单一 url，丢掉 parts 就变成「有资产但没地址」
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // 同名资产在 GitHub / Gitee 都有：两个地址都带着，prepare() 里测速择快。
          // sizes 是「每个地址各自的大小」——两个源压出来的字节数并不相同。
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // 两个源各自的最新版本 / 谁不可达，界面上可以如实显示「这次走的哪个源」
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * 下载并准备好「载荷」：便携版解压到 update/<ver>/payload，安装版直接留 Setup.exe。
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('这个版本没有可自动安装的安装包，请到 GitHub 发布页手动下载');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Gitee 附件单文件上限 100MB，所以发布时会把包切成 .part1/.part2。
    // 每个分片单独测速选源（可以一部分来自 Gitee、一部分来自 GitHub 镜像），
    // 下完按顺序拼回整包 —— 对用户来说仍然只是「下载 + 解压」。
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `正在下载 ${it.asset.name}…` });
      // 候选地址 = 源站 + 镜像前缀；先各下 256KB 实测速度，再拿最快的那个分块下载。
      // 这是「GitHub 直连几十 KB/s、镜像能跑几 MB/s」时唯一靠谱的选路方式：
      // 按域名猜没用，同一天不同时段差别很大。
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // 进度用的总大小要取「真正在下那个源」的：GitHub 与 Gitee 的包不是同一份字节
      // （压缩器不同，能差好几 MB），拿错就会一直显示 92% 再突然跳到完成。
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti：分块同时从「GitHub 直连」和「镜像」拉，带宽叠加；
      // 只有一个源可用或对方不支持 Range 时，它自己退回单源分块。
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `下载中 ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const st = fs.statSync(file);
      if (!st.size) throw new Error('下载到的更新包是空文件，请重试');
      if (it.asset.size && st.size !== it.asset.size) {
        // GitHub 与 Gitee 压出来的字节数不同：只要等于其中任意一个已知大小即可
        const known = new Set([it.asset.size, ...Object.values(it.asset.sizes || {}).map(Number)]);
        if (!known.has(st.size)) {
          throw new Error(`更新包大小异常（${st.size} 字节，期望 ${it.asset.size}），可能下载不完整，请重试`);
        }
      }
      this.sha256 = await sha256File(file);
      try { fs.writeFileSync(`${file}.sha256`, this.sha256); } catch (_) { /* 校验文件写不了不影响主流程 */ }
      this.onProgress({
        stage: 'verify', percent: 100,
        message: `更新包校验：SHA-256 ${this.sha256.slice(0, 16)}…`,
      });

      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      try {
        await this._extract(file, out);
        this._flattenPayload(out);
        this._assertPayload(out, it);
      } catch (e) {
        fs.rmSync(out, { recursive: true, force: true });
        throw e;
      }
      this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压并通过校验' });
      return { mode: 'zip', payload: out, version: it.version, sha256: this.sha256, zip: file };
    }
    // 安装版：交给外部 NSIS 之前必须先确认「这确实是一份完整的 Windows 程序」。
    // 一个半截下载 / 错误页被当成 Setup.exe 执行时，安装器会先卸旧再解压失败，
    // 结果就是安装目录被清空、程序再也起不来。
    const meta = this._assertSetup(file, it.asset);
    this.sha256 = await sha256File(file);
    try { fs.writeFileSync(`${file}.sha256`, this.sha256); } catch (_) { /* 校验文件写不了不影响主流程 */ }
    this.onProgress({
      stage: 'ready', percent: 100,
      message: `安装包已校验：SHA-256 ${this.sha256.slice(0, 16)}…`,
    });
    // size 带上「这次实际下到的字节数」：apply() 时 this.latest 可能已经指向更新的
    // 版本（后台又查了一次），拿它的 size 校验这份旧载荷会误判成「大小异常」。
    return { mode: 'setup', payload: file, version: it.version, sha256: this.sha256, size: meta.size };
  }

  /**
   * 安装包（Setup.exe）的下载后校验。
   *
   * 便携包有「解压 + 逐条 CRC + 载荷结构」三重校验，安装包此前是裸奔的：
   * 下载完直接 `Start-Process /S`。这里补上最小但有效的几项 ——
   * 体积下限、与发布信息的大小一致、MZ 头、PE 签名位置。
   * 不能覆盖 NSIS 数据区自身损坏（那要靠安装器报错），但能挡住
   * 「下到一半」「拿到 HTML 错误页」「文件被截断」这类真实故障，
   * 剩下的风险由 apply() 里的「装前备份 + 装后校验 + 失败回滚」兜住。
   */
  _assertSetup(file, asset = {}) {
    if (!file || !fs.existsSync(file)) throw new Error('安装包不存在，已取消更新');
    const st = fs.statSync(file);
    if (!st.size) throw new Error('下载到的安装包是空文件，请重试');
    if (st.size < 256 * 1024) {
      throw new Error(`安装包体积异常（${st.size} 字节），可能只下到一半或拿到了错误页，请重试`);
    }
    const known = new Set(
      [asset.size, ...Object.values(asset.sizes || {}).map(Number)].filter((n) => Number(n) > 0),
    );
    // GitHub 与 Gitee 压出来的字节数不同：等于其中任意一个已知大小即可
    if (known.size && !known.has(st.size)) {
      throw new Error(`安装包大小异常（${st.size} 字节，期望 ${[...known].join(' 或 ')}），可能下载不完整，请重试`);
    }
    const head = Buffer.alloc(8192);
    const fd = fs.openSync(file, 'r');
    let n = 0;
    try { n = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    if (n < 64 || head.toString('latin1', 0, 2) !== 'MZ') {
      throw new Error('安装包不是有效的 Windows 程序（缺少 MZ 头），已取消更新');
    }
    const peOff = head.readUInt32LE(0x3c); // e_lfanew
    if (peOff < 0x40 || peOff + 4 > n || head.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') {
      throw new Error('安装包不是有效的 Windows 程序（PE 头损坏），已取消更新');
    }
    return { size: st.size };
  }

  /**
   * 有些打包工具会把内容套一层目录（payload\ApkStart\ApkStart.exe）。
   * 替换脚本是按「载荷根 = 程序根」覆盖的，不摊平就会装到子目录里。
   */
  _flattenPayload(dir) {
    const exeName = path.basename(this.exePath || 'ApkStart.exe');
    if (fs.existsSync(path.join(dir, exeName))) return;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { return; }
    if (entries.length !== 1) return;
    const only = path.join(dir, entries[0]);
    try {
      if (!fs.statSync(only).isDirectory()) return;
      if (!fs.existsSync(path.join(only, exeName))) return;
      for (const name of fs.readdirSync(only)) {
        fs.renameSync(path.join(only, name), path.join(dir, name));
      }
      fs.rmdirSync(only);
    } catch (_) { /* 摊平失败就按原样继续，_assertPayload 会给出明确错误 */ }
  }

  /**
   * 解压后的载荷必须真的是一份 ApkStart：有主程序、有 resources。
   * 没有这一步，一个空的/错发的 zip 会把整个安装目录覆盖成一堆无关文件，
   * 程序下次就起不来了（更新器最怕的「更新完打不开」）。
   */
  _assertPayload(dir, it) {
    const exeName = path.basename(this.exePath || 'ApkStart.exe');
    const rootExe = path.join(dir, exeName);
    let found = fs.existsSync(rootExe);
    if (!found) {
      // 某些打包方式会把内容套一层目录
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.existsSync(path.join(p, exeName))) { found = true; break; }
      }
    }
    if (!found) {
      throw new Error(`更新包内容异常：没有找到 ${exeName}，已中止（原程序未被修改）`);
    }
    if (!fs.existsSync(path.join(dir, 'resources'))) {
      throw new Error('更新包内容异常：缺少 resources 目录，已中止（原程序未被修改）');
    }
    this.latestPayload = { dir, version: it.version };
  }

  /**
   * 下载并拼装分片包。
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `下载中 ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + `（第 ${part.index}/${asset.parts.length} 片）${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`分片 ${part.index} 大小不对（${buf.length} ≠ ${part.size}），已中止，可重试`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`更新包拼装后大小不对（${doneBytes} ≠ ${total}），已中止，可重试`);
    }
  }

  /**
   * 安全解压：
   *  - 每个条目都走 safeEntryPath（path.resolve + path.relative 判真包含关系），
   *    拒绝绝对路径 / 盘符 / UNC / `../` 穿越；
   *  - 拒绝符号链接条目（ZIP 里带 symlink 能指向目录外）；
   *  - 校验 CRC32 与解压后大小（下载损坏或篡改会在这里暴露）；
   *  - 限制条目数与总解压体积（解压炸弹）。
   */
  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/') && !SKIP_ENTRY.test(n));
      if (names.length > MAX_ENTRIES) throw new Error(`更新包条目过多（${names.length}），已中止`);
      let total = 0;
      for (const n of names) {
        const e = zf.entries.get(n);
        if (!e) continue;
        if (e.symlink) throw new Error(`更新包含符号链接条目，已中止：${n}`);
        total += e.uncompSize || 0;
        if (total > MAX_EXTRACT_BYTES) throw new Error('更新包解压后体积异常（超过 4GB），已中止');
      }
      let i = 0;
      for (const n of names) {
        i += 1;
        const target = safeEntryPath(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await zf.pipeTo(n, fs.createWriteStream(target), { verify: true });
        if (i % 20 === 0 || i === names.length) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `正在解压并校验 ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * 生成并启动「替换 + 重启」脚本，然后调用方负责退出应用。
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] 测试时可指定别的 pid / 不真启动
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    // 替换前最后一道闸：载荷必须真的是 ApkStart，否则宁可放弃更新
    if (job.mode === 'zip') {
      if (!job.payload || !fs.existsSync(job.payload)) throw new Error('更新载荷不存在，已取消更新');
      this._assertPayload(job.payload, { version: job.version });
    } else if (job.mode === 'setup') {
      // 用 job.size（这次真正下到的字节数），而不是 this.latest.asset.size ——
      // 后台若又查到了更新的版本，latest 已经换成别人的大小了。
      this._assertSetup(job.payload, { size: job.size });
    }

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // 等本进程真正退出（最多 90 秒），否则 exe/dll 仍被占用
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      const bak = path.join(this.updateDir, `backup-${job.version}`);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$bak = ${psq(bak)}`,
        `$ok = $false`,
        // 1) 先把「将被覆盖的现有文件」备份出来，替换失败时能原样还原
        `$files = @(Get-ChildItem -LiteralPath $src -Recurse -File)`,
        `foreach ($f in $files) {`,
        `  $rel = $f.FullName.Substring($src.Length).TrimStart('\\')`,
        `  $target = Join-Path $dst $rel`,
        `  if (Test-Path -LiteralPath $target) {`,
        `    $b = Join-Path $bak $rel`,
        `    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null`,
        `    Copy-Item -LiteralPath $target -Destination $b -Force`,
        `  }`,
        `}`,
        `Note ("backup " + $files.Count + " files")`,
        // 2) 覆盖（程序文件可能被杀软短暂占用，重试）
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  $probe = Join-Path $dst ${psq(path.basename(exe))}`,
        `  if ((Test-Path -LiteralPath $probe) -and ((Get-Item -LiteralPath $probe).Length -gt 0)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 700`,
        `}`,
        // 3) 失败 → 回滚到备份，并把载荷留在原处供排查
        `if (-not $ok) {`,
        `  Note 'copy failed, rolling back'`,
        `  if (Test-Path -LiteralPath $bak) { Copy-Item -Path (Join-Path $bak '*') -Destination $dst -Recurse -Force; Note 'rollback done' }`,
        `  Remove-Item -LiteralPath $src -Recurse -Force`,
        `  exit 1`,
        `}`,
        // 4) 成功：清掉备份与解压目录（新版本里已删除的文件不会被清理，保留无害）
        `Remove-Item -LiteralPath $bak -Recurse -Force`,
        `Remove-Item -LiteralPath $src -Recurse -Force`,
      );
    } else {
      // 安装版：安装器是外部进程，它「先卸旧、再解新」。中途任何一步失败
      // （磁盘空间不足、杀软拦截、安装包数据区损坏、UAC 被拒）都会把安装目录
      // 留成空的 —— 0.6.1 → 0.6.2 实测事故，用户重启就再也打不开。
      // 所以这里不再「下载完就无脑跑 /S」，而是：
      //   1) 先把现有程序备份出来（跳过 1.4GB 的 resources\runtime，它能重下）
      //   2) 跑安装器，读 exit code
      //   3) 装完核对 exe 是否还在、package.json 的 version 是否等于目标版本
      //   4) 任一不符 → 从备份整目录还原，回到旧版，仍然能启动
      const bak = path.join(this.updateDir, `backup-${job.version}`);
      const runtimeDir = path.join(dir, 'resources', 'runtime');
      const appDir = path.join(dir, 'resources', 'app');
      const pkgJson = path.join(appDir, 'package.json');
      lines.push(
        `$dst = ${psq(dir)}`,
        `$bak = ${psq(bak)}`,
        `$probe = ${psq(exe)}`,
        `$pkg = ${psq(pkgJson)}`,
        `$want = ${psq(String(job.version || '').replace(/^v/i, ''))}`,
        `$ok = $false`,
        `Note 'installer: backup first'`,
        `$null = robocopy $dst $bak /E /XD ${psq(runtimeDir)} /NFL /NDL /NJH /NJS /R:1 /W:1`,
        `$hasBak = Test-Path -LiteralPath (Join-Path $bak ${psq(path.basename(exe))})`,
        // 二级兜底：robocopy 整目录失败时，至少把「能启动」必需的东西留一份
        `if (-not $hasBak -and (Test-Path -LiteralPath $probe)) {`,
        `  New-Item -ItemType Directory -Force -Path $bak | Out-Null`,
        `  Copy-Item -LiteralPath $probe -Destination (Join-Path $bak ${psq(path.basename(exe))}) -Force`,
        `  if (Test-Path -LiteralPath ${psq(appDir)}) { Copy-Item -LiteralPath ${psq(appDir)} -Destination ${psq(path.join(bak, 'resources', 'app'))} -Recurse -Force }`,
        `  $hasBak = Test-Path -LiteralPath (Join-Path $bak ${psq(path.basename(exe))})`,
        `}`,
        `Note ("backup ok=" + $hasBak)`,
        `if ($hasBak -or -not (Test-Path -LiteralPath $probe)) {`,
        `  Note 'run installer'`,
        `  $p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `  Note ("installer exit " + $p.ExitCode)`,
        `  Start-Sleep -Milliseconds 500`,
        `  $gotVer = ''`,
        // 必须显式按 UTF-8 读：Windows PowerShell 5.1 的 Get-Content 默认用 ANSI(GBK)，
        // package.json 里的中文会被解成乱码、连带把 JSON 结构弄坏（实测报
        // 「应为“:”或“}”」），版本号就永远读成空 —— 核对等于没做。
        `  if (Test-Path -LiteralPath $pkg) {`,
        `    try { $gotVer = [string]((ConvertFrom-Json ([IO.File]::ReadAllText($pkg, [Text.Encoding]::UTF8))).version) }`,
        `    catch { Note ("read version failed: " + ($_.Exception.Message -replace '\\r?\\n', ' ')) }`,
        `  }`,
        `  $size = 0`,
        `  if (Test-Path -LiteralPath $probe) { $size = (Get-Item -LiteralPath $probe).Length }`,
        `  Note ("after install: exe=" + $size + " ver=" + $gotVer)`,
        `  if ($size -gt 0 -and ($gotVer.Trim() -eq '' -or $gotVer.Trim() -eq $want)) { $ok = $true }`,
        `  if (-not $ok -and $hasBak) {`,
        `    Note 'verify failed, rolling back to previous version'`,
        `    $null = robocopy $bak $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1`,
        `    Note 'rollback done'`,
        `  }`,
        `} else { Note 'backup unavailable, install skipped' }`,
        `if ($ok) { Remove-Item -LiteralPath $bak -Recurse -Force }`,
      );
    }

    lines.push(
      `if (Test-Path ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Note 'relaunched' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      // 收尾的清理语句失败（目录已被删/被杀软占用）不应该让调用方以为更新失败
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand 走 UTF-16LE base64：脚本里出现中文路径也不会被 GBK 解码搞坏
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 这里**不能**用 detached：某些安全软件 / 沙箱策略会直接拦掉「分离的控制台进程」，
    // 表现为脚本一声不响地根本没跑（更新界面卡在「正在替换程序并重启」）。
    // Windows 上父进程退出并不会杀掉普通子进程，所以用「普通子进程 + unref」同样能在
    // 我们退出之后继续干活，兼容性还更好。
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO };

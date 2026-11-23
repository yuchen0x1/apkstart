'use strict';
/**
 * 在线更新：从本项目 GitHub Releases（yuchen0x1/apkstart）取最新版本，下载并原地替换。
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
const { assetNames, readManifest, matchAsset, marker } = require('./release-manifest');
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
    this.platform = o.platform || process.platform;
    this.arch = o.arch || process.arch;
    this.appImage = o.appImage ?? process.env.APPIMAGE;
    this.publicKey = o.publicKey;
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
    if (this.platform === 'linux') return this.appImage ? 'appimage' : 'deb';
    if (this.platform !== 'win32') return 'unsupported';
    try {
      // 不能只认 NSIS 默认的「Uninstall ApkStart.exe」：自定义打包、第三方重打包、
      // 以及部分中文安装器会把卸载器叫 uninstall.exe / uninst000.exe。判错成便携版
      // 的后果很重 —— 会拿便携 zip 去覆盖 Program Files 目录，复制必然失败，
      // 用户看到的就是「点了重启并安装，没反应，版本还是旧的」（#51 的同一类现场）。
      const names = fs.readdirSync(this.installDir);
      const un = names.find((n) => /^uninstall/i.test(n) && /\.exe$/i.test(n))
        || names.find((n) => /^uninst/i.test(n) && /\.exe$/i.test(n));
      if (un) return 'setup';
      // 兜底：安装版一定有 resources\app\package.json 且旁边有 electron 的 dll 群，
      // 便携包同样有；所以只把「卸载器」当唯一判据，其余都按便携处理。
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /** 一次安装尝试后不自动重试同版本；手动更新仍可调用 apply。 */
  autoApplyBlocked(version) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(this.updateDir, 'auto-attempts.json'), 'utf8'));
      return !Array.isArray(receipt.versions) || receipt.versions.some(v => typeof v !== 'string')
        || receipt.versions.includes(String(version || '').replace(/^v/i, ''));
    } catch (error) { return error.code !== 'ENOENT'; }
  }

  blockAutoApply(version) {
    const want = String(version || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+$/.test(want)) throw new Error('更新尝试版本号无效');
    const file = path.join(this.updateDir, 'auto-attempts.json');
    let versions = [];
    try {
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(receipt.versions)) versions = receipt.versions.filter(v => typeof v === 'string');
    } catch (_) { /* 手动尝试可修复损坏凭条；自动路径对损坏凭条失败关闭 */ }
    if (!versions.includes(want)) versions.push(want);
    fs.mkdirSync(this.updateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ versions }), 'utf8');
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
    const names = assetNames(merged.tag);
    const asset = this.arch === 'x64' && merged.assets.find(a => a.name === names[this.flavor]);
    const proof = (marker.exec(merged.notes || '') || [])[0] || '';
    const verified = matchAsset(readManifest(proof, merged.tag, this.publicKey), merged.tag, asset);

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: String(merged.notes || '').replace(marker, '').trim(),
      proof,
      stale: !!merged.stale,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // 注意带上 parts：Gitee 的分片包没有单一 url，丢掉 parts 就变成「有资产但没地址」
      asset: asset
        ? {
          name: asset.name,
          digest: asset.digest,
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
      canAutoApply: verified && !merged.stale,
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
    const names = assetNames(it.tag);
    if (this.arch !== 'x64' || it.version !== it.tag.slice(1) || cmpVer(it.tag, this.current) <= 0
      || it.asset.name !== names[this.flavor] || it.stale
      || !matchAsset(readManifest(it.proof, it.tag, this.publicKey), it.tag, it.asset)) {
      throw new Error('此更新缺少匹配的发行签名、平台信息或官方摘要，请打开发布页');
    }
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // 上次已经下完的包就不要再下一遍：安装器失败时载荷是故意留着的（见 apply），
    // 用户点「重试」如果又走 1.4GB 下载，这个更新就永远试不完了。
    let reused = false;
    if (!(it.asset.parts && it.asset.parts.length) && fs.existsSync(file)) {
      try {
        const st = fs.statSync(file);
        const known = [it.asset.size, ...Object.values(it.asset.sizes || {}).map(Number)].filter(Boolean);
        // 有官方大小就按大小精确比对（最可靠）；拿不到大小才退回「超过 1MB 就当完整」
        const sizeOk = known.length ? known.includes(st.size) : st.size > 1024 * 1024;
        if (st.size > 0 && sizeOk) {
          reused = true;
          this.onProgress({ stage: 'download', percent: 99, message: '复用上次已下载的更新包…' });
        }
      } catch (_) { /* 读不到就重新下 */ }
    }

    // Gitee 附件单文件上限 100MB，所以发布时会把包切成 .part1/.part2。
    // 每个分片单独测速选源（可以一部分来自 Gitee、一部分来自 GitHub 镜像），
    // 下完按顺序拼回整包 —— 对用户来说仍然只是「下载 + 解压」。
    if (reused) {
      // 跳过下载，直接进入下面的完整性校验 / 解压
    } else if (it.asset.parts && it.asset.parts.length) {
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

    const hash = await sha256File(file);
    if ('sha256:' + hash !== it.asset.digest) {
      fs.rmSync(file, { force: true });
      throw new Error('更新包 SHA-256 与签名清单不符，已丢弃下载文件，请重试');
    }
    if (this.platform === 'linux') {
      return { mode: this.flavor, payload: file, version: it.version, sha256: hash };
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
      this.sha256 = hash;
      try { fs.writeFileSync(`${file}.sha256`, this.sha256); } catch (_) { /* 校验文件写不了不影响主流程 */ }
      this.onProgress({
        stage: 'verify', percent: 100,
        message: `更新包校验：SHA-256 ${this.sha256.slice(0, 16)}…`,
      });

      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      let files;
      try {
        await this._extract(file, out);
        this._flattenPayload(out);
        files = this._assertPayload(out, it);
      } catch (e) {
        fs.rmSync(out, { recursive: true, force: true });
        throw e;
      }
      this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压并通过校验' });
      // 从已验签、校验 CRC 的载荷固定程序文件摘要，apply 不得接受之后被改写的载荷。
      return { mode: 'zip', payload: out, version: it.version, sha256: this.sha256, zip: file, files };
    }
    // 安装版：交给外部 NSIS 之前必须先确认「这确实是一份完整的 Windows 程序」。
    // 一个半截下载 / 错误页被当成 Setup.exe 执行时，安装器会先卸旧再解压失败，
    // 结果就是安装目录被清空、程序再也起不来。
    const meta = this._assertSetup(file, it.asset);
    this.sha256 = hash;
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
   * 当前便携包为 asar:false：除了主程序，还必须有目标版本的 app/package.json。
   * 逐文件固定大小和 SHA-256，不能把「EXE 大小相同」当成应用代码已经更新。
   * resources/runtime 与安装目录内的数据目录不是程序载荷，不覆盖、不备份、不清理。
   */
  _assertPayload(dir, it) {
    const exeName = path.basename(this.exePath || 'ApkStart.exe');
    const rootExe = path.join(dir, exeName);
    if (!fs.existsSync(rootExe) || !fs.lstatSync(rootExe).isFile() || !fs.statSync(rootExe).size) {
      throw new Error(`更新包内容异常：没有找到有效的 ${exeName}，已中止（原程序未被修改）`);
    }
    if (!fs.existsSync(path.join(dir, 'resources')) || !fs.lstatSync(path.join(dir, 'resources')).isDirectory()) {
      throw new Error('更新包内容异常：缺少 resources 目录，已中止（原程序未被修改）');
    }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app', 'package.json'), 'utf8').replace(/^\ufeff/, ''));
    } catch (_) {
      throw new Error('更新包内容异常：缺少或损坏 resources/app/package.json，已中止（原程序未被修改）');
    }
    const want = String(it.version || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+$/.test(want) || !pkg || pkg.version !== want) {
      throw new Error('更新包 package.json 版本不匹配，已中止（原程序未被修改）');
    }
    const protectedPaths = ['resources/runtime'];
    const dataRel = path.relative(this.installDir, this.dataDir || '').replace(/\\/g, '/').toLowerCase();
    if (dataRel && !dataRel.startsWith('../') && dataRel !== '..' && !path.isAbsolute(dataRel)) protectedPaths.push(dataRel);
    const files = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const visit = (rel) => {
      const file = safeEntryPath(dir, rel);
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) throw new Error('更新载荷包含符号链接，已中止：' + rel);
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(file).sort()) {
          const child = rel ? rel + '/' + name : name;
          const lower = child.toLowerCase();
          if (!protectedPaths.some(p => lower === p || lower.startsWith(p + '/'))) visit(child);
        }
      } else {
        if (!st.isFile()) throw new Error('更新载荷包含非普通文件，已中止：' + rel);
        const hash = crypto.createHash('sha256');
        const fd = fs.openSync(file, 'r');
        try {
          let n;
          while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
        } finally { fs.closeSync(fd); }
        files.push({ path: rel, size: st.size, sha256: hash.digest('hex') });
      }
    };
    // 根目录单独检查，safeEntryPath 按设计不会把根目录本身当成文件条目。
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('更新载荷根目录不能是符号链接');
    for (const name of fs.readdirSync(dir).sort()) {
      if (!protectedPaths.includes(name.toLowerCase())) visit(name);
    }
    if (!files.some(f => f.path.toLowerCase() === exeName.toLowerCase())
      || !files.some(f => f.path.toLowerCase() === 'resources/app/package.json')) {
      throw new Error('更新程序文件不能位于受保护的数据目录内');
    }
    this.latestPayload = { dir, version: want };
    return files;
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
  applyAppImage(job) {
    const target = fs.realpathSync(this.appImage);
    const nonce = crypto.randomBytes(12).toString('hex');
    const staged = target + '.update-' + nonce;
    const backup = target + '.previous-' + nonce;
    const receipt = path.join(this.updateDir, 'healthy-' + nonce);
    const helper = path.join(this.updateDir, 'appimage-update.sh');
    if (!/^[a-f0-9]{64}$/.test(job.sha256)) throw new Error('AppImage 缺少文件摘要');
    try {
      fs.copyFileSync(job.payload, staged, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staged, 0o755);
      fs.copyFileSync(path.join(__dirname, 'linux-appimage-update.sh'), helper);
      const child = spawn('/bin/sh', [helper, String(process.pid), target, staged, backup,
        receipt, path.join(this.updateDir, 'update.log'), job.sha256, job.version],
      { detached: true, stdio: 'ignore' });
      child.unref();
      return { via: 'appimage' };
    } catch (error) {
      fs.rmSync(staged, { force: true });
      throw error;
    }
  }

  confirmAppImageStartup(version) {
    const receipt = process.env.APKSTART_HEALTH_RECEIPT;
    if (this.platform === 'linux' && receipt && process.env.APKSTART_HEALTH_VERSION === version
      && path.dirname(receipt) === this.updateDir && /^healthy-[a-f0-9]{24}$/.test(path.basename(receipt))) {
      fs.writeFileSync(receipt, version, { flag: 'wx' });
      delete process.env.APKSTART_HEALTH_RECEIPT;
    }
  }

  apply(job, opts = {}) {
    if (this.platform === 'linux' && job.mode === 'appimage') return this.applyAppImage(job);
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    // 失败标记：升级脚本写到 disk，下次启动由主进程读出来告诉用户
    //「更新没成功、已回到旧版本」，而不是让用户对着一模一样的旧界面猜。
    const failFile = path.join(this.updateDir, 'failed.json');
    fs.mkdirSync(this.updateDir, { recursive: true });
    try { fs.rmSync(failFile, { force: true }); } catch (_) { /* 上次的标记先清掉 */ }
    const waitPid = opts.waitPid || process.pid;

    // 落一张「有活要干」的凭条：下次启动若版本没变、日志里又没有 updater done，
    // 就说明这次自动安装根本没跑起来，必须明确告诉用户而不是让他对着旧界面猜。
    try {
      fs.writeFileSync(path.join(this.updateDir, 'pending.json'), JSON.stringify({
        version: String(job.version || '').replace(/^v/i, ''),
        mode: job.mode,
        payload: job.payload,
        at: Date.now(),
      }), 'utf8');
    } catch (_) { /* 凭条写不进去不影响更新本身 */ }

    // 替换前最后一道闸：载荷必须真的是 ApkStart，否则宁可放弃更新
    let payloadFiles;
    if (job.mode === 'zip') {
      if (!job.payload || !fs.existsSync(job.payload)) throw new Error('更新载荷不存在，已取消更新');
      payloadFiles = this._assertPayload(job.payload, { version: job.version });
      if (job.files && JSON.stringify(job.files) !== JSON.stringify(payloadFiles)) {
        throw new Error('更新载荷文件与已验证的 SHA-256 清单不符，已取消更新');
      }
    } else if (job.mode === 'setup') {
      // 用 job.size（这次真正下到的字节数），而不是 this.latest.asset.size ——
      // 后台若又查到了更新的版本，latest 已经换成别人的大小了。
      this._assertSetup(job.payload, { size: job.size });
    }
    // 先持久化再交给外部脚本；即使脚本没跑起来或故障标记写失败，也不自动循环。
    this.blockAutoApply(job.version);

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // 等本进程真正退出（最多 60 秒），否则 exe/dll 仍被占用
      `try { Wait-Process -Id ${waitPid} -Timeout 60 } catch { }`,
      // 退出被清理流程卡住时（模拟器收尾、窗口代理回包慢），安装器和文件复制都会
      // 因为「文件被占用」而静默失败 —— 用户看到的就是「点了重启并安装，没反应，
      // 版本还是旧的」。这里补一刀强制结束，宁可少存一次现场，也不能让更新白做。
      `try { if (Get-Process -Id ${waitPid} -ErrorAction SilentlyContinue) { Stop-Process -Id ${waitPid} -Force; Note 'app still alive, force stopped' } } catch { }`,
      `Start-Sleep -Milliseconds 1200`,
      // 心跳：脚本能走到这一行，说明它真的活着等到了 App 退出。下次启动检查这段日志，
      // 就能把「没跑起来」和「跑了但装失败」区分开（两者给用户的建议完全不同）。
      `Note 'app exited, applying'`,
    ];

    if (job.mode === 'zip') {
      // 重试不得覆盖上次失败留下的恢复目录。
      const bak = path.join(this.updateDir, `backup-${job.version}-${crypto.randomBytes(8).toString('hex')}`);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$bak = ${psq(bak)}`,
        `$probe = ${psq(exe)}`,
        `$pkgRel = 'resources/app/package.json'`,
        `$want = ${psq(String(job.version || '').replace(/^v/i, ''))}`,
        `$files = ConvertFrom-Json -InputObject ${psq(JSON.stringify(payloadFiles))} -ErrorAction Stop`,
        `$original = New-Object 'System.Collections.Generic.List[object]'`,
        `$missing = New-Object 'System.Collections.Generic.List[string]'`,
        `$ok = $false`,
        `$copyStarted = $false`,
        `$rollback = 'not-attempted'`,
        `$reason = ''`,
        // 固定的相对路径不依赖 Get-ChildItem 的短/长路径形式；拒绝通过目标联接点越界。
        `function Program-Path($root, $rel) {`,
        `  $target = Join-Path $root $rel`,
        `  $check = $target`,
        `  while ($check) {`,
        `    if (Test-Path -LiteralPath $check -ErrorAction Stop) {`,
        `      $item = Get-Item -LiteralPath $check -Force -ErrorAction Stop`,
        `      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('reparse point: ' + $check) }`,
        `    }`,
        `    $parent = Split-Path -Parent $check`,
        `    if ($parent -eq $check) { break }`,
        `    $check = $parent`,
        `  }`,
        `  return $target`,
        `}`,
        `function File-State($file, $rel) {`,
        `  $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop`,
        `  if ($item.PSIsContainer) { throw ('not a program file: ' + $file) }`,
        `  return @{ path = $rel; size = $item.Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }`,
        `}`,
        `function Test-Files($root, $expected) {`,
        `  try {`,
        `    foreach ($entry in $expected) {`,
        `      $file = Program-Path $root $entry.path`,
        `      $actual = File-State $file $entry.path`,
        `      if ($actual.size -ne $entry.size -or $actual.sha256 -cne $entry.sha256) { throw ('size/SHA-256 mismatch: ' + $entry.path) }`,
        `    }`,
        `    return $true`,
        `  } catch { Note ('file verification failed: ' + $_.Exception.Message); return $false }`,
        `}`,
        `function Read-Version($file) {`,
        `  try {`,
        `    $body = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)) -ErrorAction Stop`,
        `    if ($body.version -is [string]) { return $body.version }`,
        `  } catch { Note ('read version failed: ' + $file) }`,
        `  return ''`,
        `}`,
        `$before = Read-Version (Join-Path $dst $pkgRel)`,
        `$beforeReady = ((Test-Path -LiteralPath $probe -PathType Leaf) -and $before -ne '')`,
        `$canRestart = $beforeReady`,
        `try {`,
        // 脚本等 App 退出期间，载荷也可能损坏；不能重新采样后把损坏的内容当成基准。
        `  if (-not (Test-Files $src $files) -or (Read-Version (Join-Path $src $pkgRel)) -cne $want) { throw 'prepared payload changed' }`,
        // 1) 在任何覆盖前收集原文件状态，复制并验证完整备份；备份失败不碰原程序。
        `  foreach ($entry in $files) {`,
        `    $target = Program-Path $dst $entry.path`,
        `    if (Test-Path -LiteralPath $target -ErrorAction Stop) { [void]$original.Add((File-State $target $entry.path)) }`,
        `    else { [void]$missing.Add($entry.path) }`,
        `  }`,
        `  New-Item -ItemType Directory -Path $bak -ErrorAction Stop | Out-Null`,
        `  foreach ($entry in $original) {`,
        `    $b = Program-Path $bak $entry.path`,
        `    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $b))`,
        `    Copy-Item -LiteralPath (Program-Path $dst $entry.path) -Destination $b -Force -ErrorAction Stop`,
        `  }`,
        `  if (-not (Test-Files $bak $original)) { throw 'backup verification failed' }`,
        `  Note ('backup verified: ' + $original.Count + ' files')`,
        // 2) 只复制程序清单；-ErrorAction Stop 将非终止复制错误也纳入本轮失败。
        `  $copyStarted = $true`,
        `  for ($i = 1; $i -le 12; $i++) {`,
        `    try {`,
        `      foreach ($entry in $files) {`,
        `        $target = Program-Path $dst $entry.path`,
        `        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))`,
        `        Copy-Item -LiteralPath (Program-Path $src $entry.path) -Destination $target -Force -ErrorAction Stop`,
        `      }`,
        `      if (-not (Test-Files $dst $files)) { throw 'installed program files differ from payload' }`,
        `      if ((Read-Version (Join-Path $dst $pkgRel)) -cne $want) { throw 'installed package version mismatch' }`,
        `      $ok = $true; Note "copy pass $i ok"; break`,
        `    } catch { $reason = $_.Exception.Message; Note ("copy pass $i failed: " + $reason) }`,
        `    if ($i -lt 12) { Start-Sleep -Milliseconds 700 }`,
        `  }`,
        `  if (-not $ok) { throw ('copy failed after 12 passes: ' + $reason) }`,
        `} catch { $reason = $_.Exception.Message; Note ('portable update failed: ' + $reason) }`,
        // 3) 失败时逐项恢复旧内容，且只删除本次新建的文件；不镜像删除用户文件/运行时。
        `if (-not $ok -and $copyStarted) {`,
        `  Note 'copy failed, rolling back'`,
        `  $canRestart = $false`,
        `  $rollback = 'unverified'`,
        `  foreach ($entry in $original) {`,
        `    try {`,
        `      $target = Program-Path $dst $entry.path`,
        `      [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))`,
        `      Copy-Item -LiteralPath (Program-Path $bak $entry.path) -Destination $target -Force -ErrorAction Stop`,
        `    } catch { Note ('rollback copy failed: ' + $_.Exception.Message) }`,
        `  }`,
        `  foreach ($rel in $missing) {`,
        `    try {`,
        `      $target = Program-Path $dst $rel`,
        `      if (Test-Path -LiteralPath $target -ErrorAction Stop) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }`,
        `    } catch { Note ('rollback cleanup failed: ' + $_.Exception.Message) }`,
        `  }`,
        // 单个恢复复制报错仍继续还原其余文件；最终状态只以实际字节和新增文件缺席为准。
        `  try {`,
        `    foreach ($rel in $missing) {`,
        `      if (Test-Path -LiteralPath (Program-Path $dst $rel) -ErrorAction Stop) { throw ('new file remains: ' + $rel) }`,
        `    }`,
        `    if (-not (Test-Files $dst $original) -or (Read-Version (Join-Path $dst $pkgRel)) -cne $before) { throw 'rollback verification failed' }`,
        `    $rollback = 'restored'; $canRestart = $beforeReady; Note 'rollback done'`,
        `  } catch { Note ('rollback not verified: ' + $_.Exception.Message) }`,
        `}`,
        `if ($ok) {`,
        // 只有全部校验通过才清理本次备份和载荷，旧尝试的备份一律不动。
        `  Remove-Item -LiteralPath $bak -Recurse -Force`,
        `  Remove-Item -LiteralPath $src -Recurse -Force`,
        `} else {`,
        `  try {`,
        `    $failure = @{ version = $want; log = $log; rollback = $rollback; backup = $bak; payload = $src; error = $reason } | ConvertTo-Json -Compress`,
        `    [IO.File]::WriteAllText(${psq(failFile)}, $failure)`,
        `  } catch { Note 'could not write update failure marker' }`,
        `  Note 'update failed, payload kept for manual install'`,
        `}`,
      );
    } else {
      // 安装版：安装器是外部进程，它「先卸旧、再解新」。中途任何一步失败
      // （磁盘空间不足、杀软拦截、安装包数据区损坏、UAC 被拒）都会把安装目录
      // 留成空的 —— 0.6.1 → 0.6.2 实测事故，用户重启就再也打不开。
      // 所以这里不再「下载完就无脑跑 /S」，而是：
      // 每次尝试使用新目录，重试时不能覆盖上一次的恢复备份。
      const bak = path.join(this.updateDir, `backup-${job.version}-${crypto.randomBytes(8).toString('hex')}`);
      const runtimeDir = `${dir}\\resources\\runtime`;
      lines.push(
        `$dst = ${psq(dir)}`,
        `$bak = ${psq(bak)}`,
        `$probe = ${psq(exe)}`,
        `$pkgRel = 'resources\\app\\package.json'`,
        `$pkg = Join-Path $dst $pkgRel`,
        `$want = ${psq(String(job.version || '').replace(/^v/i, ''))}`,
        `$ok = $false`,
        `$rollback = 'not-attempted'`,
        // PowerShell 5.1 的默认文件编码不是 UTF-8。发行包的 manifest 可能含中文。
        `function Read-Version($file) {`,
        `  try {`,
        `    $body = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)) -ErrorAction Stop`,
        `    if ($body.version -is [string]) { return $body.version }`,
        `  } catch { Note ("read version failed: " + $file) }`,
        `  return ''`,
        `}`,
        `function Exe-Size($file) {`,
        `  if (Test-Path -LiteralPath $file -PathType Leaf) { return (Get-Item -LiteralPath $file).Length }`,
        `  return 0`,
        `}`,
        `$before = Read-Version $pkg`,
        `$beforeSize = Exe-Size $probe`,
        `$canRestart = ($beforeSize -gt 0 -and $before -ne '')`,
        // 不改写原文件，先确认当前用户能打开全部程序文件并创建/删除同目录文件。
        // 安装器可能提权，而本 helper 不会；只读 Program Files 不能仅凭可读就放行。
        `function Test-InstallWritable {`,
        `  $dirs = New-Object 'System.Collections.Generic.HashSet[string]'`,
        `  try {`,
        // Get-ChildItem 返回解析后的长路径；$bak 可能是 8.3 短名（RUNNER~1），
        // 直接用 $bak.Length 截相对路径会算错层级。用同来源的解析根。
        `    $bakRoot = (Get-Item -LiteralPath $bak -Force -ErrorAction Stop).FullName`,
        `    foreach ($file in Get-ChildItem -LiteralPath $bak -Recurse -File -Force -ErrorAction Stop) {`,
        `      $rel = $file.FullName.Substring($bakRoot.Length).TrimStart('\\')`,
        `      $target = Join-Path $dst $rel`,
        `      $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)`,
        `      $stream.Dispose()`,
        `      [void]$dirs.Add((Split-Path -Parent $target))`,
        `    }`,
        `    [void]$dirs.Add($dst)`,
        `    [void]$dirs.Add((Split-Path -Parent $dst))`,
        `    foreach ($folder in Get-ChildItem -LiteralPath $bak -Recurse -Directory -Force -ErrorAction Stop) {`,
        `      $rel = $folder.FullName.Substring($bakRoot.Length).TrimStart('\\')`,
        `      [void]$dirs.Add((Join-Path $dst $rel))`,
        `    }`,
        `    foreach ($folder in $dirs) {`,
        `      $testFile = Join-Path $folder ('.apkstart-write-' + [guid]::NewGuid().ToString('N'))`,
        `      $stream = [IO.File]::Open($testFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)`,
        `      $stream.Dispose()`,
        `      Remove-Item -LiteralPath $testFile -Force -ErrorAction Stop`,
        // 根目录可能被提权安装器删掉，恢复还需要在父目录重建，而非仅能写旧文件。
        `      [void][IO.Directory]::CreateDirectory($testFile)`,
        `      [IO.Directory]::Delete($testFile)`,
        `    }`,
        `    return $true`,
        `  } catch { Note ('install directory not writable: ' + $_.Exception.Message); return $false }`,
        `}`,
        `Note ("installer: backup first: " + $bak)`,
        `$LASTEXITCODE = $null`,
        `$null = robocopy $dst $bak /E /XJ /XD ${psq(runtimeDir)} /NFL /NDL /NJH /NJS /R:1 /W:1`,
        `$backupExit = $LASTEXITCODE`,
        `$backupSize = Exe-Size (Join-Path $bak ${psq(path.basename(exe))})`,
        `$backupVersion = Read-Version (Join-Path $bak $pkgRel)`,
        // robocopy 用位标志报告结果，8 以上表示至少一个复制错误。
        `$hasBak = ($null -ne $backupExit -and $backupExit -lt 8 -and $canRestart -and $beforeSize -eq $backupSize -and $before -ceq $backupVersion)`,
        `Note ("backup ok=" + $hasBak + " exit=" + $backupExit)`,
        `$writable = $false`,
        `if ($hasBak) { $writable = Test-InstallWritable }`,
        `if ($hasBak -and $writable) {`,
        `  Note 'run installer'`,
        `  $installerExit = $null`,
        `  $launchCancelled = $false`,
        `  try {`,
        `    $p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait -ErrorAction Stop`,
        `    $installerExit = $p.ExitCode`,
        `  } catch {`,
        `    Note ("installer launch failed: " + $_.Exception.Message)`,
        `    for ($err = $_.Exception; $null -ne $err; $err = $err.InnerException) {`,
        `      if ($err -is [ComponentModel.Win32Exception] -and $err.NativeErrorCode -eq 1223) { $launchCancelled = $true }`,
        `    }`,
        `  }`,
        `  Note ("installer exit " + $installerExit)`,
        `  $gotVer = Read-Version $pkg`,
        `  $size = Exe-Size $probe`,
        `  Note ("after install: exe=" + $size + " ver=" + $gotVer)`,
        `  $ok = (0 -eq $installerExit -and $size -gt 0 -and $want -ne '' -and $gotVer -ceq $want)`,
        `  if ($launchCancelled) {`,
        `    $canRestart = ($size -eq $beforeSize -and $gotVer -ceq $before)`,
        `    if ($canRestart) { $rollback = 'not-started'; Note 'installer cancelled, original files unchanged' }`,
        `    else { $rollback = 'unverified'; Note 'installer cancelled, original files changed' }`,
        `  } elseif (-not $ok) {`,
        `    Note 'verify failed, rolling back to previous version'`,
        `    $LASTEXITCODE = $null`,
        // 即使新旧文件大小和修改时间相同，也用备份覆盖；不镜像清除未知文件。
        `    $null = robocopy $bak $dst /E /XJ /IS /IT /NFL /NDL /NJH /NJS /R:1 /W:1`,
        `    $restoreExit = $LASTEXITCODE`,
        `    $canRestart = ($null -ne $restoreExit -and $restoreExit -lt 8 -and (Exe-Size $probe) -eq $beforeSize -and (Read-Version $pkg) -ceq $before)`,
        `    if ($canRestart) { $rollback = 'restored'; Note 'rollback done' }`,
        `    else { $rollback = 'unverified'; Note ("rollback not verified, exit=" + $restoreExit) }`,
        `  }`,
        `} else { Note 'backup unavailable, install skipped' }`,
        `if ($ok) { Remove-Item -LiteralPath $bak -Recurse -Force }`,
        `else {`,
        `  try {`,
        `    $failure = @{ version = $want; log = $log; rollback = $rollback; backup = $bak } | ConvertTo-Json -Compress`,
        // WriteAllText 默认写 UTF-8 无 BOM，主进程的 JSON.parse 可直接读取。
        `    [IO.File]::WriteAllText(${psq(failFile)}, $failure)`,
        `  } catch { Note 'could not write update failure marker' }`,
        `  Note 'update failed, payload kept for manual install'`,
        `}`,
      );
    }

    lines.push(
      `if ($ok) { Remove-Item -LiteralPath ${psq(path.join(this.updateDir, 'pending.json'))} -Force }`,
      `if (($ok -or $canRestart) -and (Test-Path -LiteralPath ${psq(exe)} -PathType Leaf)) { Start-Process -FilePath ${psq(exe)}; ${job.mode === 'zip' ? "if ($rollback -eq 'restored') { Note 'relaunched (rolled back)' } else { Note 'relaunched' }" : "Note 'relaunched'"} }`,
      `Note 'updater done'`,
      // 只有验证通过才清理载荷；即使失败标记写不出来也必须保留。
      `if (-not $ok) { exit 1 }`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -LiteralPath ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      `exit 0`,
    );

    const script = lines.join('\r\n');
    const scriptPath = path.join(this.updateDir, 'apply.log.ps1');
    // 带 BOM：PowerShell 5.1 用 -File 读「无 BOM 的 UTF-8」会按 ANSI(GBK) 解释，
    // 用户名/安装路径里有中文时整段脚本会被读坏（以前用 -EncodedCommand 没这问题）。
    fs.writeFileSync(scriptPath, '\ufeff' + script, 'utf8');
    if (opts.spawn === false) return script;
    const cmdPath = path.join(this.updateDir, 'apply.cmd');
    this._writeLauncher(cmdPath, scriptPath);
    return this._launch(cmdPath, scriptPath, opts);
  }

  /** 生成 .cmd 启动器：只负责把 PowerShell 拉起来，自身立刻退出 */
  _writeLauncher(cmdPath, scriptPath) {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cmd = [
      '@echo off',
      `start "" /b "${ps}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`,
      'exit /b 0',
    ].join('\r\n');
    fs.writeFileSync(cmdPath, cmd + '\r\n', 'utf8');
    return cmdPath;
  }

  /**
   * 启动升级脚本，必须保证它比 ApkStart 活得久。
   *
   * 旧实现直接用 `spawn(powershell)` 把脚本挂成 App 的子进程 —— App 一退出，
   * 系统会把这个子进程一起收走（作业对象/控制台归属），脚本刚写下第一行日志就没下文，
   * 安装器根本没机会运行。用户看到的就是「点了重启并安装，一点反应都没有，版本还是旧的」。
   *
   * 现在按「脱离父子关系」的强弱分三级退让：
   *   1. opts.launch（Electron 的 shell.openPath）：交给资源管理器启动，最干净；
   *   2. explorer.exe apply.cmd：由已运行的 shell 接管，进程关系立刻断开；
   *   3. 直接 spawn：兼容某些禁用了 shell 关联的精简系统，能用就用。
   * 三级都失败就抛错 —— 宁可让用户看到「自动安装启动失败，请手动运行安装包」，
   * 也不能假装成功。
   */
  _launch(cmdPath, scriptPath, opts = {}) {
    if (process.platform !== 'win32') {
      throw new Error('Windows 更新脚本仅支持 Windows 平台');
    }
    const errors = [];
    if (typeof opts.launch === 'function') {
      try {
        const r = opts.launch(cmdPath);
        if (!r || r === 'ok') return { ok: true, via: 'shell' };
        errors.push(`shell:${r}`);
      } catch (e) { errors.push(`shell:${e.message}`); }
    }
    try {
      const c = spawn('explorer.exe', [cmdPath], { stdio: 'ignore', windowsHide: true });
      c.unref();
      return { ok: true, via: 'explorer' };
    } catch (e) { errors.push(`explorer:${e.message}`); }
    try {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(ps, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden', '-File', scriptPath,
      ], { stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ok: true, via: 'spawn' };
    } catch (e) { errors.push(`spawn:${e.message}`); }
    throw new Error(`无法启动升级脚本（${errors.join('；')}）`);
  }


  /**
   * 上一次「重启并安装」到底跑没跑起来。
   *
   * 三种结果必须分开，给用户的建议完全不同：
   *   none    → 没有待安装的活；
   *   stalled → 脚本没跑起来（日志里连「等到 App 退出」都没有）—— 只能手动装；
   *   failed  → 跑了但装失败（脚本自己会写 failed.json）。
   * @returns {{state:'none'|'stalled'|'failed', version?:string, payload?:string}}
   */
  pendingApply() {
    const pendingFile = path.join(this.updateDir, 'pending.json');
    let pending = null;
    try {
      if (fs.existsSync(pendingFile)) pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } catch (_) { pending = null; }
    if (!pending || !pending.version) return { state: 'none' };
    // 版本已经追上目标 = 上次其实装成功了，只是清理没做完
    if (cmpVer(this.current, pending.version) >= 0) {
      try { fs.rmSync(pendingFile, { force: true }); } catch (_) { /* ignore */ }
      return { state: 'none' };
    }
    let log = '';
    try { log = fs.readFileSync(path.join(this.updateDir, 'update.log'), 'utf8'); } catch (_) { log = ''; }
    const alive = /app exited, applying|installer: backup first|run installer|after install/.test(log);
    if (!alive) return { state: 'stalled', version: pending.version, payload: pending.payload || '' };
    return { state: 'failed', version: pending.version, payload: pending.payload || '' };
  }

  /** 清掉「有待安装的活」凭条（手动安装走完、用户主动放弃时用） */
  clearPending() {
    try { fs.rmSync(path.join(this.updateDir, 'pending.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO };

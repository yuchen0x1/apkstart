'use strict';
/**
 * LineageOS Provider —— 真实状态路线。
 * ------------------------------------------------------------------
 * 事实：LineageOS 官方不提供预构建的 Android Emulator 系统镜像。官方仅支持在 Linux
 * 上从源码构建（sdk_phone_x86_64 + mka emu_img_zip，导出 tag=lineage 的 AVD 镜像）。
 *
 * 因此本 Provider：
 *   - getAvailability() 明确返回 available=false（来自目录 status=unavailable）；
 *   - getDownloadInfo() 永远返回 null —— 绝不伪造下载地址；
 *   - 提供 detectImported() / importFrom()：让用户把自行构建的 AVD 镜像目录纳入管理；
 *   - start() 复用现有 Android Emulator 后端（通过 system-manager 传入的 backend）。
 */
const fs = require('fs');
const path = require('path');
const { BaseProvider, PROVIDER_IDS } = require('./base-provider');

class LineageProvider extends BaseProvider {
  constructor(ctx = {}) {
    super(Object.assign({}, ctx, { systemId: PROVIDER_IDS.LINEAGE, displayName: 'LineageOS' }));
    this.imagesDir = this.dir('images');
  }

  async getAvailability() {
    const versions = await this.getVersions();
    const imported = await this.detectImported();
    const base = await super.getAvailability();
    // 有用户导入的合法 AVD 镜像时，可用性来自本地导入，而非伪造的远程资源。
    if (imported.ok) {
      return {
        available: true,
        localOnly: true,
        reason: '',
        status: 'available-imported',
        version: { version: imported.version || 'imported', status: 'available-imported' },
      };
    }
    return base;
  }

  async getDownloadInfo() { return null; }

  async download() {
    throw new Error('LineageOS 官方无预构建模拟器镜像，无法自动下载。请在 Linux 用 sdk_phone_x86_64 构建后导入。');
  }

  /** 扫描本系统 images 目录里是否有合法的 AVD 系统镜像（复用项目已有的字节体检） */
  async detectImported() {
    let inspect;
    try { inspect = require('../image-inspect'); } catch (_) {}
    try {
      const entries = fs.readdirSync(this.imagesDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = path.join(this.imagesDir, e.name);
        // 一个合法 AVD 系统镜像目录应含 system.img + kernel/ranchu + ramdisk.img
        let ok = false;
        if (inspect && typeof inspect.scanImageDir === 'function') {
          ok = !!inspect.scanImageDir(dir).ok;
        } else {
          const names = fs.readdirSync(dir);
          ok = names.some((n) => /^system\.img$/i.test(n)) &&
               names.some((n) => /ramdisk/i.test(n)) &&
               names.some((n) => /kernel/i.test(n));
        }
        if (ok) {
          let version = e.name;
          try {
            const props = path.join(dir, 'source.properties');
            const txt = fs.readFileSync(props, 'utf8');
            const mv = txt.match(/AndroidVersion.ApiLevel\s*=\s*(\d+)/);
            const rel = txt.match(/Pkg.Revision\s*=\s*([\d.]+)/);
            version = (rel ? 'r' + rel[1] + ' ' : '') + (mv ? 'API ' + mv[1] : e.name);
          } catch (_) {}
          return { ok: true, dir, version };
        }
      }
    } catch (_) {}
    return { ok: false, dir: '', version: '' };
  }

  /**
   * 导入用户自行构建的 AVD 系统镜像目录（复制或引用）。
   * @param {string} srcDir 源目录
   * @param {object} opts { copy=true }
   */
  async importFrom(srcDir, opts = {}) {
    if (!srcDir || typeof srcDir !== 'string') return { ok: false, error: '无效的目录' };
    let stat;
    try { stat = fs.statSync(srcDir); } catch (_) { return { ok: false, error: '目录不存在' }; }
    if (!stat.isDirectory()) return { ok: false, error: '不是目录' };

    let inspect;
    try { inspect = require('../image-inspect'); } catch (_) {}
    if (inspect && typeof inspect.scanImageDir === 'function') {
      const r = inspect.scanImageDir(srcDir);
      if (!r.ok) return { ok: false, error: '不是合法的 AVD 系统镜像：' + (r.errors || []).join('；') };
    }
    const copy = opts.copy !== false;
    const name = path.basename(path.resolve(srcDir)).replace(/[^A-Za-z0-9._-]/g, '_') || 'lineage-avd';
    const dest = path.join(this.imagesDir, name);
    try {
      fs.mkdirSync(this.imagesDir, { recursive: true });
      if (copy) {
        // 用 images.js 提供的 copyDir（跨盘符会自动退化复制）
        let copyDir;
        try { copyDir = require('../images').copyDir; } catch (_) {}
        if (copyDir) copyDir(srcDir, dest);
        else fs.cpSync(srcDir, dest, { recursive: true, force: true });
      } else if (path.resolve(srcDir) !== path.resolve(dest)) {
        fs.symlinkSync(path.resolve(srcDir), dest, 'junction');
      }
      const detected = await this.detectImported();
      this.writeManifest({ downloaded: true, imageDir: dest, version: detected.version || name, source: 'imported' });
      this.log('已导入 LineageOS AVD 镜像：' + dest);
      return { ok: true, dir: dest, version: detected.version || name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getLocalStatus() {
    const m = this.readManifest() || {};
    const detected = await this.detectImported();
    return {
      installed: !!m.installed,
      downloaded: detected.ok || !!m.downloaded,
      running: !!m.running,
      version: m.version || (detected.ok ? detected.version : ''),
      paths: m.paths || {},
      importedDir: detected.dir || '',
    };
  }

  async start() {
    // 真正的启动由 system-manager 交给 AndroidEmulatorBackend 完成；
    // 这里只做前置检查，避免"未导入就启动"的假成功。
    const detected = await this.detectImported();
    if (!detected.ok) return { ok: false, error: '未检测到 LineageOS AVD 系统镜像，请先导入。' };
    return { ok: true, backend: 'AndroidEmulatorBackend', imageDir: detected.dir };
  }
}

module.exports = { LineageProvider };

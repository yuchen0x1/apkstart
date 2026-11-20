'use strict';
// 统一数据路径策略：dataDir 仍指各组件自己的目录，Provider 可单独注入目录。
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveSystemPaths(opts = {}) {
  const store = opts.store || require('../store');
  const settings = opts.settingsFn ? opts.settingsFn() : (store.getSettings ? store.getSettings() : {});
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.homeDir || os.homedir();
  const appDataDir = opts.appDataDir || store.DATA_DIR || (platform === 'linux'
    ? path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'apkstart')
    : path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'apkstart'));
  const provisioned = opts.provisioner && opts.provisioner.paths ? opts.provisioner.paths().root : '';
  let configured = String(settings && settings.runtime && settings.runtime.dir || '').trim();
  if (platform === 'linux' && /^[a-zA-Z]:[\\/]/.test(configured)) configured = '';
  const runtimeRoot = opts.runtimeRoot || provisioned || configured || path.join(appDataDir, 'runtime');
  return {
    appDataDir, runtimeRoot,
    systemsDir: opts.systemsDir || opts.dataDirBase || path.join(runtimeRoot, 'systems'),
    catalogDir: opts.catalogDir || path.join(appDataDir, 'system-catalog'),
    // 仅检测并提示旧目录，不自动合并、搬移或覆盖多 GB 的虚拟磁盘。
    legacySystemsDirs: opts.legacyDataDirs || [
      path.join(env.APPDATA || home, 'apkstart', 'runtime', 'systems'),
      path.join(appDataDir, 'runtime', 'systems'),
    ],
    legacyCatalogDirs: opts.legacyDataDirs || [
      path.join(env.APPDATA || path.join(home, '.apkstart'), 'apkstart', 'system-catalog'),
    ],
  };
}

function legacyPathWarnings(dataDir, candidates) {
  const target = path.resolve(dataDir);
  const seen = new Set([process.platform === 'win32' ? target.toLowerCase() : target]);
  const warnings = [];
  for (const dir of candidates || []) {
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!fs.statSync(dir).isDirectory() || !fs.readdirSync(dir).length) continue;
      warnings.push({
        code: 'LEGACY_SYSTEM_DATA', legacyDir: dir, dataDir,
        message: `检测到旧系统数据目录 ${dir}；当前目录为 ${dataDir}。未自动迁移或覆盖，请在关闭虚拟机后备份并手动迁移（不要覆盖已有文件）。`,
      });
    } catch (_) {}
  }
  return warnings;
}

module.exports = { resolveSystemPaths, legacyPathWarnings };

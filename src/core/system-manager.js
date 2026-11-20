'use strict';
/**
 * 统一系统管理中心（system manager）
 * ------------------------------------------------------------------
 * 负责协调所有 Provider 的切换与生命周期，但不把下载/启动逻辑塞进自己体内。
 *
 * 切换流程（switchTo）：
 *   1. 校验 systemId；2. 检查安装状态；3. 检查是否在下载/安装中；
 *   4. 检查是否有其它虚拟设备在运行；5. 按需停止旧设备；
 *   6. 取 Provider；7. 检查系统文件；8. 创建/加载独立设备；
 *   9. 用正确后端启动（emulator / qemu）；10. 检查 ADB / Android 就绪；
 *   11. 更新运行状态与"当前系统"记录。
 *
 * 红线：
 *   - 切换必须真实停旧启新，不是只改一个 settings 字段；
 *   - 各系统独立 userdata，切换不清空 Google Play 数据；
 *   - VM 进程启动 ≠ Android 就绪，必须 waitAndroidReady 后才标记 running；
 *   - 同一个系统不允许并发安装（由 taskManager 的去重锁保证）。
 */
const fs = require('fs');
const path = require('path');
const providers = require('./system-providers');
const { PROVIDER_IDS } = providers;
const { SystemTaskManager, STATUS } = require('./system-task-manager');
const { resolveSystemPaths, legacyPathWarnings } = require('./system-providers/system-paths');

class SystemManager {
  constructor(opts = {}) {
    this.store = opts.store || require('./store');
    this.catalog = opts.catalog || null;
    this.provisioner = opts.provisioner || null;
    this.backendEngine = opts.backendEngine || null;   // engine.Runtime
    this.switchFlavor = opts.switchFlavor || null;     // (flavor) => {ok,...} 现有一档位切换入口
    this.doctor = opts.doctor || null;
    this.settingsFn = opts.settingsFn || (() => this.store.getSettings());
    const paths = resolveSystemPaths(Object.assign({}, opts, { store: this.store, settingsFn: this.settingsFn }));
    this.dataDir = opts.dataDir || paths.systemsDir;
    this.pathWarnings = legacyPathWarnings(this.dataDir, paths.legacySystemsDirs);
    this.onEvent = opts.onEvent || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.taskManager = new SystemTaskManager({ dataDir: this.dataDir, store: this.store, settingsFn: this.settingsFn, onEvent: this.onEvent });
    this._providers = new Map();
    this._current = this._readCurrent();
    this._switching = false;
  }

  _currentFile() { return path.join(this.dataDir, 'current.json'); }

  _readCurrent() {
    try {
      return JSON.parse(fs.readFileSync(this._currentFile(), 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) { return { systemId: PROVIDER_IDS.GOOGLE_PLAY, startedAt: '' }; }
  }

  _writeCurrent(systemId, extra = {}) {
    this._current = Object.assign({ systemId, updatedAt: new Date().toISOString() }, extra);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this._currentFile(), JSON.stringify(this._current, null, 2), 'utf8');
    } catch (_) {}
    return this._current;
  }

  getProvider(systemId) {
    if (this._providers.has(systemId)) return this._providers.get(systemId);
    const shared = {
      catalog: this.catalog,
      store: this.store,
      provisioner: this.provisioner,
      taskManager: this.taskManager,
      backendEngine: this.backendEngine,
      imageStore: this.provisioner ? this.provisioner.images : null,
      settingsFn: this.settingsFn,
      dataDirBase: this.dataDir,
      onLog: this.onLog,
    };
    const p = providers.createProvider(systemId, shared);
    if (p) this._providers.set(systemId, p);
    return p;
  }

  _activeInstaller() {
    for (const [systemId, provider] of this._providers) {
      if (provider.isInstallerRunning && provider.isInstallerRunning()) return systemId;
    }
    return '';
  }

  /** 系统卡片列表：内置系统 + 目录系统，每个附 availability + localStatus */
  async listSystems() {
    const catalogList = this.catalog
      ? await this.catalog.listAll()
      : { systems: Object.keys(PROVIDER_IDS).map((id) => ({ id, name: providers.DISPLAY_NAMES[id], status: 'builtin' })), catalogInfo: {} };
    const result = [];
    for (const s of catalogList.systems) {
      const p = this.getProvider(s.id);
      let avail = { available: false, status: s.status || 'unknown', reason: '' };
      let local = { installed: false, downloaded: false, running: false };
      if (p) {
        try { avail = await p.getAvailability(); } catch (_) {}
        try { local = await p.getLocalStatus(); } catch (_) {}
      }
      let version = s.versions && s.versions.length ? s.versions[0] : null;
      try {
        const info = p && await p.getDownloadInfo();
        if (info && info.version) version = Object.assign({}, version || {}, { version: info.version });
      } catch (_) {}
      result.push(Object.assign({}, s, {
        name: s.name || (p && p.displayName) || s.id,
        availability: avail,
        local,
        version: version || { version: '' },
        current: this._current.systemId === s.id,
        bootBackend: s.bootBackend || (p && p.backend && p.backend.systemId ? 'QemuBackend' : 'AndroidEmulatorBackend'),
      }));
    }
    return { systems: result, catalogInfo: catalogList.catalogInfo, currentSystemId: this._current.systemId,
      pathWarnings: this.pathWarnings.concat(this.catalog && this.catalog.pathWarnings || []) };
  }

  /** 单系统详情（版本历史、兼容性、日志、状态） */
  async getSystemDetail(systemId) {
    const p = this.getProvider(systemId);
    if (!p) return null;
    const [versions, availability, local, logs, info] = await Promise.all([
      p.getVersions().catch(() => []),
      p.getAvailability().catch(() => ({ available: false })),
      p.getLocalStatus().catch(() => ({})),
      p.getLogs().catch(() => []),
      p.getDownloadInfo().catch(() => null),
    ]);
    return {
      id: systemId,
      name: p.displayName,
      versions,
      availability,
      local,
      info,
      logs: logs.slice(-100),
      dataDir: p.dataDir,
    };
  }

  /**
   * 触发安装/下载流水线（不负责启动切换），返回 taskId 供 UI 跟踪。
   */
  async installSystem(systemId, opts = {}) {
    const installer = this._activeInstaller();
    if (installer && installer !== systemId) return { ok: false, error: '另一个系统仍在安装，请完成安装并正常关机后再安装新系统' };
    const p = this.getProvider(systemId);
    if (!p) return { ok: false, error: '未知系统' };
    const avail = await p.getAvailability();
    if (!avail.available) return { ok: false, error: avail.reason || '该系统暂无可用资源', availability: avail };

    const info = await p.getDownloadInfo().catch(() => null);
    const version = (info && info.version) || '';
    const { task, reused } = this.taskManager.createTask({
      systemId, systemVersion: version, type: 'system-download', provider: p,
      ctx: opts.ctx || {},
    });
    if (reused) return { ok: true, taskId: task.taskId, reused: true, note: '该系统已有进行中的任务' };

    // 异步执行流水线，UI 立即拿到 taskId 并订阅 system:task 事件
    const pipelinePromise = this.taskManager.runPipeline({
      task, provider: p, version,
      doctor: this.doctor,
      diskRequiredMB: Math.round((info && info.fileSize ? info.fileSize / 1048576 : 0)) + 2048,
      skipStart: opts.skipStart !== false, // 默认不在此处启动，启动交给 switchTo 统一编排
      ctx: opts.ctx || {},
    });
    if (opts.await) return { ok: true, taskId: task.taskId, result: await pipelinePromise };
    pipelinePromise.catch((e) => this.onLog('任务异常：' + e.message));
    return { ok: true, taskId: task.taskId };
  }

  /**
   * 统一切换到某系统（真实停旧启新）。
   * @returns {Promise<{ok, error?, androidReady?, serial?, vmStarted?, note?}>}
   */
  async switchTo(systemId, opts = {}) {
    if (this._switching) return { ok: false, error: '另一个系统切换正在进行中' };
    this._switching = true;
    try {
      const p = this.getProvider(systemId);
      if (!p) return { ok: false, error: '未知系统' };

      // 3) 检查下载/安装中
      const active = this.taskManager.getActiveTask(systemId);
      if (active && [STATUS.DOWNLOADING, STATUS.INSTALLING, STATUS.VERIFYING, STATUS.INITIALIZING, STATUS.AWAITING_CONFIRMATION].includes(active.status)) {
        return { ok: false, error: '该系统正在下载、安装或等待安装确认，请先完成安装', taskId: active.taskId };
      }
      if (this._activeInstaller()) {
        return { ok: false, error: '引导式安装器仍在运行；完成安装并正常关机后再切换系统。' };
      }

      // 2) 检查安装状态（内置档位视作已安装）
      const local = await p.getLocalStatus();
      if (!local.installed && systemId !== PROVIDER_IDS.GOOGLE_PLAY) {
        return { ok: false, error: '该系统尚未安装，请先完成下载与安装', needsInstall: true, local };
      }

      // 4-5) 停止当前运行的其它系统（真实停旧，不共用 userdata）
      const currentId = this._current.systemId;
      if (currentId && currentId !== systemId) {
        const old = this.getProvider(currentId);
        if (old) {
          try {
            const oldLocal = await old.getLocalStatus();
            if (oldLocal.running || (old.backend && old.backend.running && old.backend.running())) {
              this.onLog(`切换系统：停止 ${old.displayName}`);
              const stopped = await old.stop();
              if (stopped === false || (stopped && stopped.ok === false)) {
                return { ok: false, error: stopped.error || '旧系统未能停止，未启动新系统' };
              }
              const after = await old.getLocalStatus();
              if (after.running || (old.backend && old.backend.running && old.backend.running())) {
                return { ok: false, error: '旧系统仍在运行，未启动新系统' };
              }
            }
          } catch (e) { return { ok: false, error: '停止旧系统失败：' + e.message }; }
        }
        // 内置 emulator 档位切换：走现有 imageProfile 校验入口（会切独立 AVD）
        if ([PROVIDER_IDS.GOOGLE_PLAY, PROVIDER_IDS.GOOGLE_APIS, PROVIDER_IDS.AOSP].includes(systemId)) {
          if (!this.switchFlavor) return { ok: false, error: '档位切换入口未接入' };
          const sw = await this.switchFlavor({
            [PROVIDER_IDS.GOOGLE_PLAY]: 'google_apis_playstore',
            [PROVIDER_IDS.GOOGLE_APIS]: 'google_apis',
            [PROVIDER_IDS.AOSP]: 'default',
          }[systemId]);
          if (!sw || sw.ok === false) return { ok: false, error: (sw && sw.error) || '切换档位失败' };
        }
      }

      // 8-9) 创建/加载独立设备并用正确后端启动
      const dev = await p.createDevice({}).catch(() => ({ ok: true }));
      if (dev && dev.ok === false) return { ok: false, error: dev.error || '创建设备失败' };
      const sr = await p.start({ lowspec: !!opts.lowspec });
      if (!sr.ok) return { ok: false, error: sr.error || '启动失败' };

      // 10) Android 就绪检查（VM 启动不等于 Android 启动）
      let androidReady = true; // emulator 档位的 ensure() 内部已检查 boot_completed
      let serial = '';
      if (sr.needsAndroidReadyCheck && sr.backend === 'QemuBackend') {
        const settings = this.settingsFn();
        const adbPath = settings.runtime && settings.runtime.adbPath;
        const ready = await p.backend.waitAndroidReady({
          adbPath: adbPath || (this.provisioner ? this.provisioner.paths().adbExe : ''),
          adbPort: 5555,
          timeoutMs: opts.timeoutMs || 180000,
          onProgress: (pr) => this.onEvent({
            type: 'system-start', systemId, status: STATUS.STARTING,
            currentStep: '等待 Android 系统就绪', progress: 99,
            elapsedMs: pr.elapsedMs,
          }),
        });
        androidReady = ready.ok;
        serial = ready.serial || '';
        if (!androidReady) {
          // 如实记录：VM 已启动但 Android 未就绪，不标记 running
          return {
            ok: false, vmStarted: true, androidReady: false,
            error: ready.error,
            note: '虚拟机进程已启动，但 Android 系统未进入可用状态；未标记该系统为运行中。',
          };
        }
      }

      // 11) 更新记录
      this._writeCurrent(systemId, { androidReady, serial, startedAt: new Date().toISOString() });
      try { p.writeManifest && p.writeManifest({ running: true, androidReady }); } catch (_) {}
      return { ok: true, androidReady, serial, vmStarted: true, systemId };
    } finally {
      this._switching = false;
    }
  }

  async confirmInstallation(taskId, opts = {}) {
    const task = this.taskManager.getTask(String(taskId || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status !== STATUS.AWAITING_CONFIRMATION) {
      return { ok: false, error: '当前任务不在等待安装确认状态' };
    }
    if (task._confirming || task._inFlight) return { ok: false, error: '安装器正在收尾，请片刻后确认安装完成' };
    const provider = this.getProvider(task.systemId);
    if (!provider || typeof provider.confirmInstallation !== 'function') {
      return { ok: false, error: '该系统不支持引导式安装确认' };
    }
    task._provider = provider;
    task._confirming = true;
    try {
      const result = await provider.confirmInstallation(task, opts);
      if (!result || !result.ok) return result || { ok: false, error: '安装确认失败' };
      if (task.status === STATUS.CANCELLED || task.status === STATUS.PAUSED || task.aborted) {
        return { ok: false, error: '任务已暂停或取消，未完成安装确认' };
      }
      task.setStatus(STATUS.INITIALIZING, '正在初始化设备');
      const initialized = await provider.initialize(task, { version: task.systemVersion });
      if (initialized && initialized.ok === false) {
        task.setStatus(STATUS.FAILED, '初始化失败', { error: initialized.error || '初始化失败' });
        this.taskManager._release(task);
        return { ok: false, error: task.error };
      }
      task.progress = 100;
      task.setStatus(STATUS.COMPLETED, '安装已确认完成');
      this.taskManager._release(task);
      return Object.assign({}, result, { taskId: task.taskId, status: task.status });
    } catch (e) {
      if (task.status !== STATUS.CANCELLED && task.status !== STATUS.PAUSED) {
        task.setStatus(STATUS.FAILED, '安装确认失败', { error: e.message });
        this.taskManager._release(task);
      }
      return { ok: false, error: e.message };
    } finally {
      task._confirming = false;
    }
  }

  async stopCurrent() {
    if (this._activeInstaller()) return { ok: false, error: '安装器仍在写入，请在虚拟机内完成安装并正常关机' };
    const p = this.getProvider(this._current.systemId);
    if (!p) return { ok: true };
    const r = await p.stop();
    if (r === false || (r && r.ok === false)) return r || { ok: false, error: '系统未能停止' };
    try { this._writeCurrent(this._current.systemId, { stopped: true }); } catch (_) {}
    return r;
  }

  async getStatus() {
    return {
      current: this._current,
      switching: this._switching,
      tasks: this.taskManager.listTasks(10),
      dataDir: this.dataDir,
    };
  }

  async backup(systemId, destDir) {
    const p = this.getProvider(systemId);
    if (!p) return { ok: false, error: '未知系统' };
    return p.backup(destDir);
  }

  async restore(systemId, srcDir) {
    const p = this.getProvider(systemId);
    if (!p) return { ok: false, error: '未知系统' };
    return p.restore(srcDir);
  }

  async removeSystem(systemId) {
    const p = this.getProvider(systemId);
    if (!p) return { ok: false, error: '未知系统' };
    // 正在运行或下载中的系统不允许删除
    const local = await p.getLocalStatus();
    const active = this.taskManager.getActiveTask(systemId);
    if (local.running || (active && ![STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(active.status))) {
      return { ok: false, error: '请先停止系统或等待任务结束再删除' };
    }
    const r = await p.remove();
    if (r.ok) this._providers.delete(systemId);
    return r;
  }

  /** 系统占用空间 */
  async diskUsage() {
    const rows = [];
    function sizeOf(dir) {
      let total = 0;
      try {
        const stack = [dir];
        while (stack.length) {
          const d = stack.pop();
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p2 = path.join(d, e.name);
            try {
              if (e.isDirectory()) stack.push(p2);
              else if (e.isFile()) total += fs.statSync(p2).size;
            } catch (_) {}
          }
        }
      } catch (_) {}
      return total;
    }
    for (const id of providers.allSystemIds()) {
      const dir = path.join(this.dataDir, id);
      rows.push({ systemId: id, bytes: sizeOf(dir) });
    }
    return rows;
  }
}

module.exports = { SystemManager, PROVIDER_IDS };

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
    this._switchGeneration = 0;
    this._switchOp = null;
    this._stopPromise = null;
    this._diskMaintenance = new Set();
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
    if (this._diskMaintenance.has(systemId) || this._switchOp?.systemId === systemId || this._stopPromise) {
      return { ok: false, error: '系统正在切换、停止或维护，请稍后安装' };
    }
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

  async _providerRunning(provider) {
    if (!provider) throw new Error('无法确认系统归属');
    const backend = provider.backend;
    if (backend && typeof backend.running === 'function' && backend.running() === true) return true;
    try {
      const running = typeof provider.getRunningState === 'function'
        ? await provider.getRunningState() : (await provider.getLocalStatus())?.running;
      if (typeof running !== 'boolean') throw new Error('Provider 未返回明确的运行状态');
      return running || (typeof backend?.running === 'function' && backend.running() === true);
    } catch (e) {
      throw new Error('无法确认系统运行/停止状态：' + e.message, { cause: e });
    }
  }

  _backendEndpoints(provider) {
    const backend = provider && provider.backend;
    if (!backend) return null;
    try {
      if (typeof backend.getEndpoints === 'function') {
        const endpoints = backend.getEndpoints();
        if (endpoints) return endpoints;
      }
    } catch (_) {}
    const adbPort = Number(backend.adbPort) || 0;
    const monitorPort = Number(backend.monitorPort) || 0;
    return adbPort || monitorPort ? { adbPort, monitorPort, pid: backend.proc && backend.proc.pid || 0 } : null;
  }

  _recordRunning(systemId, provider, extra = {}) {
    const endpoints = this._backendEndpoints(provider) || {};
    const running = extra.running !== false;
    return this._writeCurrent(systemId, Object.assign({
      androidReady: false,
      serial: '',
      vmStarted: true,
      running,
      adbPort: Number(endpoints.adbPort) || 0,
      monitorPort: Number(endpoints.monitorPort) || 0,
      startedAt: new Date().toISOString(),
    }, extra));
  }

  _recordStopped(systemId, extra = {}) {
    return this._writeCurrent(systemId, Object.assign({
      running: false,
      vmStarted: false,
      stopped: true,
      androidReady: false,
    }, extra));
  }

  /**
   * 统一切换到某系统（真实停旧启新）。
   * @returns {Promise<{ok, error?, androidReady?, serial?, vmStarted?, note?}>}
   */
  switchTo(systemId, opts = {}) {
    if (this._stopPromise || this._diskMaintenance.size) return Promise.resolve({ ok: false, error: '系统正在停止或维护，请稍后重试' });
    const lowspec = !!opts.lowspec;
    const timeoutMs = Number(opts.timeoutMs) || 0;
    if (this._switchOp) {
      const active = this._switchOp;
      return active.systemId === systemId && active.lowspec === lowspec && active.timeoutMs === timeoutMs ? active.promise
        : Promise.resolve({ ok: false, error: '另一项系统切换正在进行中' });
    }
    const op = { systemId, lowspec, timeoutMs, generation: ++this._switchGeneration, controller: new AbortController(), startAttempted: false };
    op.quiesced = new Promise((resolve) => { op.quiesce = resolve; });
    this._switchOp = op;
    this._switching = true;
    const promise = Promise.resolve().then(() => this._switchTo(op));
    op.promise = promise;
    const clear = () => {
      op.quiesce();
      if (this._switchOp === op) { this._switchOp = null; this._switching = false; }
    };
    promise.then(clear, clear);
    return promise;
  }

  _assertSwitch(op) {
    if (op.controller.signal.aborted || this._switchOp !== op || this._switchGeneration !== op.generation) {
      const error = new Error('系统启动已取消');
      error.code = 'START_CANCELLED';
      throw error;
    }
  }

  async _switchTo(op) {
    const { systemId } = op;
    const opts = op;
    const check = () => this._assertSwitch(op);
    // A stale completion must not reach a status/manifest write after stopCurrent.
    try {
      check();
      const p = this.getProvider(systemId);
      if (!p) return { ok: false, error: '未知系统' };

      // 3) 检查下载/安装中
      const active = this.taskManager.getActiveTask(systemId);
      if (active && (active._inFlight || active._confirming || ![STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.PAUSED].includes(active.status))) {
        return { ok: false, error: '该系统正在下载、安装或等待安装确认，请先完成安装', taskId: active.taskId };
      }
      if (this._activeInstaller()) {
        return { ok: false, error: '引导式安装器仍在运行；完成安装并正常关机后再切换系统。' };
      }

      // 2) 检查安装状态（内置档位视作已安装）
      const local = await p.getLocalStatus();
      check();
      if (!local.installed && systemId !== PROVIDER_IDS.GOOGLE_PLAY) {
        return { ok: false, error: '该系统尚未安装，请先完成下载与安装', needsInstall: true, local };
      }

      // 4-5) 停止当前运行的其它系统（真实停旧，不共用 userdata）
      const currentId = this._current.systemId;
      if (currentId && currentId !== systemId) {
        const old = this.getProvider(currentId);
        if (old) {
          const stopped = await this._stopProvider(currentId, old, check);
          check();
          if (!stopped.ok) return stopped;
        } else if (this._current.running || this._current.vmStarted) {
          return { ok: false, error: '无法确认旧系统已停止，未启动新系统' };
        }
        // 内置 emulator 档位切换：走现有 imageProfile 校验入口（会切独立 AVD）
        if ([PROVIDER_IDS.GOOGLE_PLAY, PROVIDER_IDS.GOOGLE_APIS, PROVIDER_IDS.AOSP].includes(systemId)) {
          if (!this.switchFlavor) return { ok: false, error: '档位切换入口未接入' };
          const sw = await this.switchFlavor({
            [PROVIDER_IDS.GOOGLE_PLAY]: 'google_apis_playstore',
            [PROVIDER_IDS.GOOGLE_APIS]: 'google_apis',
            [PROVIDER_IDS.AOSP]: 'default',
          }[systemId]);
          check();
          if (!sw || sw.ok === false) return { ok: false, error: (sw && sw.error) || '切换档位失败' };
        }
      }

      // 已启动但尚未 Android 就绪的 QEMU 不能再次 spawn；复用其自有端口继续管理。
      const targetAlreadyRunning = await this._providerRunning(p);
      check();
      const existingEndpoints = this._backendEndpoints(p);
      let sr;
      if (targetAlreadyRunning && p.backend && typeof p.backend.getEndpoints === 'function' && existingEndpoints) {
        op.startAttempted = true;
        sr = Object.assign({ ok: true }, existingEndpoints, { backend: 'QemuBackend', needsAndroidReadyCheck: true });
      } else {
        if (!targetAlreadyRunning) {
          const dev = await p.createDevice({});
          check();
          if (dev && dev.ok === false) return { ok: false, error: dev.error || '创建设备失败' };
        }
        // stopCurrent 不可只停旧 current：此调用返回前 Provider 仍可能 spawn 新进程。
        op.startAttempted = true;
        try { sr = await p.start({ lowspec: !!opts.lowspec, timeoutMs: opts.timeoutMs, signal: op.controller.signal }); }
        catch (e) { sr = { ok: false, error: e.message }; }
        check();
      }

      if (!sr || sr.ok === false) {
        const stillRunning = await this._providerRunning(p);
        check();
        const error = sr && sr.error || '启动失败';
        if (stillRunning) this._recordRunning(systemId, p, { startupError: error });
        return { ok: false, systemId, vmStarted: stillRunning, androidReady: false, error };
      }

      const endpoints = this._backendEndpoints(p) || {};
      const needsReady = sr.needsAndroidReadyCheck && sr.backend === 'QemuBackend';
      const adbPort = Number(sr.adbPort || endpoints.adbPort) || (needsReady ? 0 : 5555);
      const monitorPort = Number(sr.monitorPort || endpoints.monitorPort) || 0;
      const sameQemu = () => {
        const current = this._backendEndpoints(p);
        const token = sr.ownerToken || endpoints.ownerToken;
        return !!current && !!adbPort && current.adbPort === adbPort
          && (!token || current.ownerToken === token);
      };
      if (needsReady && !sameQemu()) {
        const running = await this._providerRunning(p);
        check();
        if (running) this._recordRunning(systemId, p, { startupError: 'ADB 端口归属无法确认' });
        return { ok: false, systemId, vmStarted: running, androidReady: false, error: '无法确认启动的 QEMU 实例及 ADB 端口' };
      }
      // 进程启动后先登记，再等待 ADB；等待期内 stopCurrent 无需等待 ADB 才能停机。
      this._recordRunning(systemId, p, { adbPort, monitorPort });
      op.quiesce();

      let serial = sr.serial || '';
      if (needsReady) {
        const settings = this.settingsFn();
        const adbPath = settings.runtime && settings.runtime.adbPath;
        const { signal } = op.controller;
        let ready;
        let cancel;
        try {
          const cancelled = new Promise((resolve) => {
            cancel = () => resolve(null);
            signal.addEventListener('abort', cancel, { once: true });
          });
          check();
          ready = await Promise.race([cancelled, p.backend.waitAndroidReady({
            adbPath: adbPath || (this.provisioner ? this.provisioner.paths().adbExe : ''),
            adbPort, ownerToken: sr.ownerToken || endpoints.ownerToken, signal,
            timeoutMs: opts.timeoutMs || 180000,
            onProgress: (pr) => {
              if (!signal.aborted && this._switchOp === op && sameQemu()) this.onEvent({
                type: 'system-start', systemId, status: STATUS.STARTING,
                currentStep: '等待 Android 系统就绪', progress: 99, elapsedMs: pr.elapsedMs,
              });
            },
          })]);
        } catch (e) { ready = { ok: false, error: '等待 Android 就绪异常：' + e.message }; }
        finally { if (cancel) signal.removeEventListener('abort', cancel); }
        check();
        serial = ready && ready.serial || '';
        const owned = sameQemu();
        if (!owned || !ready || !ready.ok) {
          const error = !owned ? 'QEMU 实例已退出或已替换' : ready && ready.error || 'Android 系统未就绪';
          // 旧端口的结果不能更新替代者的 manifest，也不能抹掉现存的归属。
          if (owned || this._backendEndpoints(p)) this._recordRunning(systemId, p, { startupError: error });
          else {
            this._recordStopped(systemId, { startupError: error });
            try { p.writeManifest && p.writeManifest({ running: false, androidReady: false }); } catch (_) {}
          }
          return { ok: false, vmStarted: true, androidReady: false, systemId, serial, adbPort, error,
            note: owned ? '虚拟机仍由当前 Provider 持有，可通过停止当前系统清理。' : '' };
        }
      }

      check();
      this._writeCurrent(systemId, {
        androidReady: true, serial, adbPort, monitorPort,
        vmStarted: true, running: true, startedAt: new Date().toISOString(), stopped: false,
      });
      try { p.writeManifest && p.writeManifest({ running: true, androidReady: true }); } catch (_) {}
      return { ok: true, androidReady: true, serial, adbPort, vmStarted: true, systemId };
    } catch (e) {
      if (op.controller.signal.aborted || e.code === 'START_CANCELLED') {
        return { ok: false, code: 'START_CANCELLED', systemId, error: '系统启动已取消' };
      }
      return { ok: false, systemId, error: e.message };
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

  async _stopProvider(systemId, p, check = () => {}) {
    const active = await this._providerRunning(p);
    check();
    const starting = () => !!(p.backend && p.backend.isStarting && p.backend.isStarting());
    const recordedActive = this._current.systemId === systemId && !!(this._current.running || this._current.vmStarted);
    if (active || starting() || recordedActive) {
      const result = await p.stop();
      check();
      // undefined/null is not an exit acknowledgement.
      if (!(result === true || result && result.ok === true)) {
        return Object.assign({}, result, { ok: false, error: result && result.error || '系统未能确认停止' });
      }
      const remains = await this._providerRunning(p);
      check();
      if (remains || starting()) return { ok: false, error: 'Provider 未能确认虚拟机进程退出；保留当前运行状态' };
    }
    if (this._current.systemId === systemId) this._recordStopped(systemId);
    try { p.writeManifest && p.writeManifest({ running: false, androidReady: false }); } catch (_) {}
    return { ok: true, running: false };
  }

  stopCurrent() {
    if (this._stopPromise) return this._stopPromise;
    if (this._diskMaintenance.size) return Promise.resolve({ ok: false, error: '系统数据正在维护，未执行停机' });
    if (this._activeInstaller()) return Promise.resolve({ ok: false, error: '安装器仍在写入，请在虚拟机内完成安装并正常关机' });
    const op = this._switchOp;
    const promise = Promise.resolve().then(async () => {
      try {
        // Provider.start may still spawn. Fence it, but skip the cancellable readiness wait.
        if (op) await op.quiesced;
        const ids = new Set([op && op.startAttempted && op.systemId, this._current.systemId]);
        for (const systemId of ids) {
          if (!systemId) continue;
          const p = this.getProvider(systemId);
          if (!p) {
            if (this._current.running || this._current.vmStarted) return { ok: false, error: '无法确认当前系统归属及停止状态' };
            continue;
          }
          // A cancelled start can have spawned without yet publishing current.json.
          if (op && op.startAttempted && systemId === op.systemId && this._current.systemId !== systemId
              && await this._providerRunning(p)) this._recordRunning(systemId, p);
          const result = await this._stopProvider(systemId, p);
          if (!result.ok) return result;
        }
        return { ok: true, running: false };
      } catch (e) { return { ok: false, error: '停止系统失败：' + e.message }; }
    });
    this._stopPromise = promise;
    ++this._switchGeneration;
    if (op) op.controller.abort();
    const clear = () => { if (this._stopPromise === promise) this._stopPromise = null; };
    promise.then(clear, clear);
    return promise;
  }

  async getStatus() {
    return {
      current: this._current,
      switching: this._switching,
      stopping: !!this._stopPromise,
      tasks: this.taskManager.listTasks(10),
      dataDir: this.dataDir,
    };
  }

  async backup(systemId, destDir) {
    const p = this.getProvider(systemId);
    if (!p) return { ok: false, error: '未知系统' };
    return p.backup(destDir);
  }

  async _withOfflineProvider(systemId, apply) {
    if (this._switchOp || this._stopPromise || this._diskMaintenance.has(systemId)) {
      return { ok: false, error: '系统正在启动、停止或维护' };
    }
    const p = this.getProvider(systemId);
    if (!p) return { ok: false, error: '未知系统' };
    this._diskMaintenance.add(systemId);
    try {
      const active = this.taskManager.getActiveTask(systemId);
      if (active && ![STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(active.status)
          || p.backend?.isStarting?.() || await this._providerRunning(p)) {
        return { ok: false, error: '请先停止系统或等待任务结束再维护数据' };
      }
      return await apply(p);
    } catch (e) { return { ok: false, error: e.message }; }
    finally { this._diskMaintenance.delete(systemId); }
  }

  async restore(systemId, srcDir) {
    return this._withOfflineProvider(systemId, (p) => p.restore(srcDir));
  }

  async removeSystem(systemId) {
    return this._withOfflineProvider(systemId, async (p) => {
      const r = await p.remove();
      if (r.ok) this._providers.delete(systemId);
      return r;
    });
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

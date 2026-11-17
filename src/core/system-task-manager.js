'use strict';
/**
 * 统一系统任务管理器（system task manager）
 * ------------------------------------------------------------------
 * 所有系统下载/校验/安装/启动任务在此集中管理，进度统一推送到 UI 运行状态区域。
 *
 * 任务字段：taskId, systemId, systemVersion, status, progress, downloadedBytes,
 *   totalBytes, speed, eta, currentStep, startedAt, updatedAt, error, retryCount
 * 状态：waiting/preparing/downloading/verifying/extracting/installing/initializing/
 *   starting/completed/failed/paused/cancelled
 *
 * 主题：
 *   - 单一活跃任务/系统（去重锁），同一系统不允许并发安装；
 *   - 暂停=abort 当前下载（断点保留），继续=以同一目标重新调用 provider.download；
 *   - 取消=abort + 标记 cancelled，不删除已安装系统；
 *   - 校验失败=删除损坏文件后由调用方重试；
 *   - 任务状态持久化到 %APPDATA%\apkstart\runtime\systems\_tasks.json，启动恢复；
 *   - 进度事件通过 onEvent 回调推送（main.js 转成 system:task 给渲染层）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUS = {
  WAITING: 'waiting',
  PREPARING: 'preparing',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  EXTRACTING: 'extracting',
  INSTALLING: 'installing',
  INITIALIZING: 'initializing',
  STARTING: 'starting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
};

const TASK_TYPES = [
  'system-catalog', 'system-download', 'system-verify', 'system-extract',
  'system-install', 'system-initialize', 'system-start', 'system-stop',
  'system-update', 'system-backup', 'system-restore',
];

let seq = 0;
function newTaskId(systemId) {
  seq += 1;
  return `${systemId}-${Date.now().toString(36)}-${seq}-${crypto.randomBytes(2).toString('hex')}`;
}

class SystemTask {
  constructor(opts) {
    this.taskId = opts.taskId || newTaskId(opts.systemId);
    this.type = opts.type || 'system-download';
    this.systemId = opts.systemId;
    this.systemVersion = opts.systemVersion || '';
    this.status = STATUS.WAITING;
    this.progress = 0;
    this.downloadedBytes = 0;
    this.totalBytes = opts.totalBytes || 0;
    this.speed = 0;
    this.eta = null;
    this.currentStep = opts.currentStep || '准备中';
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this.error = '';
    this.retryCount = 0;
    this.steps = [];
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
    this._controller = new AbortController();
    this.signal = this._controller.signal;
    this.aborted = false;
    this._ctx = opts.ctx || {};
    this._provider = opts.provider || null;
    this._onEvent = opts.onEvent || (() => {});
    this._onStatusChange = opts.onStatusChange || (() => {});
    this._done = null;
  }

  updateProgress(p = {}) {
    if (typeof p.downloadedBytes === 'number') this.downloadedBytes = p.downloadedBytes;
    if (typeof p.totalBytes === 'number' && p.totalBytes > 0) this.totalBytes = p.totalBytes;
    if (typeof p.speed === 'number') this.speed = p.speed;
    if (p.eta !== undefined) this.eta = p.eta;
    if (typeof p.percent === 'number') {
      this.progress = Math.max(0, Math.min(100, p.percent));
    } else if (this.totalBytes > 0) {
      this.progress = Math.max(0, Math.min(100, (this.downloadedBytes / this.totalBytes) * 100));
    }
    this.updatedAt = new Date().toISOString();
    this._emit();
  }

  setStatus(status, step, extra = {}) {
    this.status = status;
    if (step) this.currentStep = step;
    if (extra.error !== undefined) this.error = extra.error;
    this.updatedAt = new Date().toISOString();
    if (step) this.steps.push({ at: this.updatedAt, step });
    this._emit();
    // 阶段状态变化落盘，保证关闭程序后能恢复「完成/失败/暂停」等终态。
    // 高频的 updateProgress 不落盘（太频繁），只在阶段切换时持久化。
    try { this._onStatusChange(this); } catch (_) {}
  }

  _emit() {
    try { this._onEvent(this.toJSON()); } catch (_) {}
  }

  toJSON() {
    return {
      taskId: this.taskId, type: this.type, systemId: this.systemId,
      systemVersion: this.systemVersion, status: this.status,
      progress: Math.round(this.progress * 10) / 10,
      downloadedBytes: this.downloadedBytes, totalBytes: this.totalBytes,
      speed: this.speed, eta: this.eta, currentStep: this.currentStep,
      startedAt: this.startedAt, updatedAt: this.updatedAt,
      error: this.error, retryCount: this.retryCount,
    };
  }

  serialize() {
    return Object.assign(this.toJSON(), { steps: this.steps.slice(-50) });
  }
}

class SystemTaskManager {
  /**
   * @param {object} opts { dataDir, onEvent }
   *   onEvent(taskJSON) 进度推送；dataDir 任务持久化目录（默认 systems/）
   */
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.dataDir = opts.dataDir || path.join(
      process.env.APPDATA || require('os').homedir(), 'apkstart', 'runtime', 'systems'
    );
    this.stateFile = path.join(this.dataDir, '_tasks.json');
    this.tasks = new Map();       // taskId -> SystemTask
    this.activeBySystem = new Map(); // systemId -> taskId（单活跃锁）
    this._restore();
  }

  _persist() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const data = {
        savedAt: new Date().toISOString(),
        tasks: Array.from(this.tasks.values()).map((t) => t.serialize()),
        activeBySystem: Array.from(this.activeBySystem.entries()),
      };
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (_) {}
  }

  _restore() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) { return; }
    if (!data || !Array.isArray(data.tasks)) return;
    for (const raw of data.tasks) {
      // 只恢复"未终结"的任务为 paused（可续传），已完成/失败/取消的保留作历史。
      const t = new SystemTask({
        taskId: raw.taskId, type: raw.type, systemId: raw.systemId,
        systemVersion: raw.systemVersion, ctx: {},
      });
      Object.assign(t, {
        status: [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(raw.status)
          ? raw.status : STATUS.PAUSED,
        progress: raw.progress || 0,
        downloadedBytes: raw.downloadedBytes || 0,
        totalBytes: raw.totalBytes || 0,
        speed: 0, eta: null,
        currentStep: raw.currentStep || '已从上次会话恢复',
        startedAt: raw.startedAt || t.startedAt,
        updatedAt: raw.updatedAt || t.updatedAt,
        error: raw.error || '', retryCount: raw.retryCount || 0,
        steps: raw.steps || [],
      });
      this.tasks.set(t.taskId, t);
    }
    // 重建活跃锁：只对 paused 任务占位，避免重复下载
    if (Array.isArray(data.activeBySystem)) {
      for (const [sid, tid] of data.activeBySystem) {
        const t = this.tasks.get(tid);
        if (t && t.status === STATUS.PAUSED) this.activeBySystem.set(sid, tid);
      }
    }
  }

  /**
   * 创建并注册一个任务。若该系统已有活跃任务（downloading/installing/paused 等未终结），
   * 直接返回现有任务（去重，避免重复下载/安装）。
   */
  createTask({ systemId, systemVersion, type, provider, ctx, maxRetries, totalBytes } = {}) {
    const existingId = this.activeBySystem.get(systemId);
    if (existingId) {
      const t = this.tasks.get(existingId);
      if (t && ![STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(t.status)) {
        return { task: t, reused: true };
      }
    }
    const task = new SystemTask({
      systemId, systemVersion, type, provider, ctx, maxRetries,
      totalBytes: totalBytes || 0,
      onEvent: (j) => this.onEvent(j),
      onStatusChange: () => this._persist(),
    });
    this.tasks.set(task.taskId, task);
    this.activeBySystem.set(systemId, task.taskId);
    this._persist();
    task._emit();
    return { task, reused: false };
  }

  getTask(taskId) { return this.tasks.get(taskId) || null; }
  getActiveTask(systemId) {
    const id = this.activeBySystem.get(systemId);
    return id ? this.tasks.get(id) || null : null;
  }
  listTasks(limit = 50) {
    return Array.from(this.tasks.values())
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit).map((t) => t.toJSON());
  }

  /** 释放活跃锁（任务终结时） */
  _release(task) {
    if (this.activeBySystem.get(task.systemId) === task.taskId) {
      this.activeBySystem.delete(task.systemId);
    }
    this._persist();
  }

  pause(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    if (![STATUS.DOWNLOADING, STATUS.PREPARING, STATUS.VERIFYING, STATUS.INSTALLING].includes(t.status)) {
      return { ok: false, error: '当前状态无法暂停' };
    }
    t.aborted = true;
    try { t._controller.abort(); } catch (_) {}
    t.setStatus(STATUS.PAUSED, '已暂停（保留断点）');
    this._persist();
    return { ok: true };
  }

  cancel(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    t.aborted = true;
    try { t._controller.abort(); } catch (_) {}
    t.setStatus(STATUS.CANCELLED, '已取消（不删除已安装系统）');
    this._release(t);
    return { ok: true };
  }

  /**
   * 执行"下载→校验→安装→初始化→启动"流水线。
   * 每个阶段单独 try/catch，失败写入任务 error 并置 FAILED；不在内部吞掉"启动成功"。
   * @param {object} opts { task, provider, version, skipInstall, skipStart, diskRequiredMB, doctor }
   */
  async runPipeline(opts = {}) {
    const task = opts.task;
    const provider = opts.provider || task._provider;
    if (!task || !provider) throw new Error('缺少任务或 Provider');

    // 磁盘空间预检（download.js 自身不检查）
    if (opts.diskRequiredMB && opts.doctor && typeof opts.doctor.freeDiskMB === 'function') {
      try {
        const free = opts.doctor.freeDiskMB(provider.dataDir);
        if (free && free < opts.diskRequiredMB + 1024) {
          task.setStatus(STATUS.FAILED, '磁盘空间不足', {
            error: `需要约 ${opts.diskRequiredMB + 1024} MB 可用空间，当前仅 ${free} MB。`,
          });
          this._release(task);
          return { ok: false, error: task.error };
        }
      } catch (_) {}
    }

    // 下载地址有效性 / 来源合法性（HTTPS）
    task.setStatus(STATUS.PREPARING, '准备下载信息');
    let info;
    try {
      info = await provider.getDownloadInfo();
    } catch (e) { info = null; }
    if (!info || !/^https:\/\//i.test(info.url || '')) {
      const avail = await provider.getAvailability();
      const err = avail.reason || '无合法的 HTTPS 下载地址（不下载未经验证的资源）';
      task.setStatus(STATUS.FAILED, '无可用下载源', { error: err });
      this._release(task);
      return { ok: false, error: err };
    }
    task.systemVersion = task.systemVersion || info.version;
    task.totalBytes = info.fileSize || 0;

    try {
      // 1) 下载
      task.setStatus(STATUS.DOWNLOADING, '正在下载系统镜像');
      const dl = await provider.download(task, { info });
      if (task.aborted) return { ok: false, cancelled: true };

      // 2) 校验
      task.setStatus(STATUS.VERIFYING, '文件校验中');
      const vr = await provider.verify(dl.file, info);
      if (!vr.ok) {
        // 校验失败：删除损坏文件（下次重新下载，不续传毒丸）
        try { fs.rmSync(dl.file, { force: true }); } catch (_) {}
        task.setStatus(STATUS.FAILED, '校验失败', { error: vr.error });
        this._release(task);
        return { ok: false, error: vr.error, verifyFailed: true };
      }
      if (task.aborted) return { ok: false, cancelled: true };

      // 3) 安装（展开/建盘/装机）—— 下载成功绝不冒充安装成功
      if (!opts.skipInstall) {
        task.setStatus(STATUS.INSTALLING, '正在安装系统');
        const ir = await provider.install(task, Object.assign({ version: info.version }, opts.ctx));
        if (!ir.ok) {
          task.setStatus(STATUS.FAILED, '安装失败', { error: ir.error });
          this._release(task);
          return Object.assign({ ok: false }, ir);
        }
        if (task.aborted) return { ok: false, cancelled: true };
      }

      // 4) 初始化
      task.setStatus(STATUS.INITIALIZING, '正在初始化设备');
      await provider.initialize(task, opts.ctx);

      // 5) 启动（可选）—— 仅启动引擎，Android 就绪由 system-manager 另做检查
      if (!opts.skipStart) {
        task.setStatus(STATUS.STARTING, '正在启动 Android');
        const sr = await provider.start(opts.ctx || {});
        if (!sr.ok) {
          task.setStatus(STATUS.FAILED, '启动失败', { error: sr.error || '引擎启动失败' });
          this._release(task);
          return { ok: false, error: sr.error || '引擎启动失败', vmStarted: false };
        }
        // 需要区分：VM 进程启动 vs Android 真正就绪
        task.setStatus(STATUS.COMPLETED, '虚拟机已启动（等待 Android 就绪检查）');
        this._release(task);
        return { ok: true, needsAndroidReadyCheck: !!sr.needsAndroidReadyCheck, startResult: sr };
      }

      task.progress = 100;
      task.setStatus(STATUS.COMPLETED, '已完成');
      this._release(task);
      return { ok: true };
    } catch (e) {
      if (task.aborted) {
        task.setStatus(STATUS.CANCELLED, '已取消');
        this._release(task);
        return { ok: false, cancelled: true };
      }
      task.setStatus(STATUS.FAILED, '任务失败', { error: e.message });
      this._release(task);
      return { ok: false, error: e.message };
    }
  }

  /** 重试：重置失败任务状态后重跑流水线（由调用方重新传入 provider/opts） */
  retry(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== STATUS.FAILED && t.status !== STATUS.PAUSED) {
      return { ok: false, error: '仅失败或暂停的任务可重试' };
    }
    if (t.retryCount >= t.maxRetries) return { ok: false, error: '重试次数已用尽' };
    t.retryCount += 1;
    t.error = '';
    t.aborted = false;
    try { t._controller = new AbortController(); t.signal = t._controller.signal; } catch (_) {}
    t.setStatus(STATUS.WAITING, '等待重试');
    this._persist();
    return { ok: true, task: t };
  }

  clearHistory(beforeMs = 7 * 24 * 3600 * 1000) {
    const cutoff = Date.now() - beforeMs;
    for (const [id, t] of Array.from(this.tasks.entries())) {
      if ([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(t.status)
        && new Date(t.updatedAt).getTime() < cutoff) {
        this.tasks.delete(id);
      }
    }
    this._persist();
  }
}

module.exports = { SystemTaskManager, SystemTask, STATUS, TASK_TYPES, newTaskId };

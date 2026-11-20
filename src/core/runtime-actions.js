'use strict';
const BUILTIN = new Set(['google-play', 'google-apis', 'aosp']);

// Keep device-bound actions and provider switches from silently targeting different guests.
class RuntimeActions {
  constructor({ status, isQuitting = () => false }) {
    this.status = status;
    this.isQuitting = isQuitting;
    this.active = new Set();
  }

  async run(name, action, { builtin = true, afterCurrent = false } = {}) {
    if (this.isQuitting()) throw new Error('ApkStart 正在退出，请稍后重新打开');
    const canStopSwitch = name === 'system:stop' && [...this.active].every(op => op.name === 'system:switch');
    // Runtime.ensure deduplicates a foreground launch/install with an existing prewarm.
    const joinsPrewarm = ['app:launch', 'apk:install'].includes(name)
      && [...this.active].every(op => op.name === 'runtime:prewarm');
    if (this.active.size && !canStopSwitch && !joinsPrewarm && !afterCurrent) throw new Error('正在执行应用或系统操作，请等待完成后再试');
    const preceding = afterCurrent ? [...this.active].map(op => op.done) : [];
    let complete;
    const operation = { name, done: new Promise(resolve => { complete = resolve; }) };
    this.active.add(operation);
    try {
      if (preceding.length) await Promise.all(preceding);
      if (this.isQuitting()) throw new Error('ApkStart 正在退出');
      if (builtin) {
        const state = await this.status();
        if (this.isQuitting()) throw new Error('ApkStart 正在退出');
        if (state.switching || state.stopping) throw new Error('系统正在切换或停止，请等待完成后再试');
        if (!BUILTIN.has(state.current?.systemId)) {
          throw new Error('当前系统尚未接入应用库操作；请在系统自身窗口中操作，或切回内置 Android 档位后重试');
        }
      }
      return await action();
    } finally {
      this.active.delete(operation);
      complete();
    }
  }

  async drain(timeoutMs = 8000) {
    if (!this.active.size) return true;
    let timer;
    try {
      return await Promise.race([
        Promise.all([...this.active].map(op => op.done)).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const DEVICE_CHANNELS = new Set([
  'app:uninstall', 'app:clearData', 'app:backup', 'app:restore', 'app:clearLocks',
  'settings:restoreSystem', 'settings:refreshPointer', 'settings:unhook',
  'guest:trim', 'guest:restore', 'guest:localize', 'guest:openLocaleSettings',
  'runtime:start', 'runtime:stop', 'runtime:setImageFlavor', 'runtime:repairRun',
  'runtime:setDataSize', 'runtime:cleanup', 'runtime:resetData', 'runtime:repairNetwork',
  'runtime:startInstaller', 'runtime:markInstalled', 'runtime:resetInstall',
  'image:activate', 'image:restore', 'image:remove', 'share:sync',
  'android:set', 'android:open', 'android:tune', 'android:grantAll',
]);
const SYSTEM_CHANNELS = new Set(['system:switch', 'system:stop', 'system:confirmInstall', 'system:restore', 'system:remove']);
function channelMode(channel) {
  if (DEVICE_CHANNELS.has(channel)) return { builtin: true };
  if (SYSTEM_CHANNELS.has(channel)) return { builtin: false };
  return null;
}

module.exports = { RuntimeActions, channelMode };

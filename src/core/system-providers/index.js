'use strict';
/**
 * Provider 注册表：统一创建所有系统 Provider。
 * 每个 Provider 收到相同形状的共享上下文（catalog/store/provisioner/taskManager/backendEngine/...），
 * 但各自实现自身逻辑；system-manager 只依赖本表的接口。
 */
const { PROVIDER_IDS } = require('./base-provider');
const { EmulatorProvider } = require('./emulator-provider');
const { LineageProvider } = require('./lineage-provider');
const { BlissProvider } = require('./bliss-provider');
const { AndroidX86Provider } = require('./android-x86-provider');
const { CustomProvider } = require('./custom-provider');

const REGISTRY = {
  [PROVIDER_IDS.GOOGLE_PLAY]: EmulatorProvider,
  [PROVIDER_IDS.GOOGLE_APIS]: EmulatorProvider,
  [PROVIDER_IDS.AOSP]: EmulatorProvider,
  [PROVIDER_IDS.LINEAGE]: LineageProvider,
  [PROVIDER_IDS.BLISS]: BlissProvider,
  [PROVIDER_IDS.ANDROID_X86]: AndroidX86Provider,
  [PROVIDER_IDS.CUSTOM]: CustomProvider,
};

const DISPLAY_NAMES = {
  [PROVIDER_IDS.GOOGLE_PLAY]: 'Google Play',
  [PROVIDER_IDS.GOOGLE_APIS]: 'Google APIs',
  [PROVIDER_IDS.AOSP]: '纯 AOSP',
  [PROVIDER_IDS.LINEAGE]: 'LineageOS',
  [PROVIDER_IDS.BLISS]: 'Bliss OS',
  [PROVIDER_IDS.ANDROID_X86]: 'Android-x86',
  [PROVIDER_IDS.CUSTOM]: '自定义镜像',
};

function createProvider(systemId, sharedCtx = {}) {
  const Cls = REGISTRY[systemId];
  if (!Cls) return null;
  const os = require('os');
  const path = require('path');
  const dataDir = path.join(
    process.env.APPDATA || os.homedir(),
    'apkstart', 'runtime', 'systems', systemId
  );
  return new Cls(Object.assign({
    systemId,
    displayName: DISPLAY_NAMES[systemId] || systemId,
    dataDir,
  }, sharedCtx, {
    // systemId/displayName/dataDir 以注册表为准，避免被共享上下文覆盖
    systemId,
    displayName: DISPLAY_NAMES[systemId] || systemId,
    dataDir,
  }));
}

function allSystemIds() { return Object.keys(REGISTRY); }

module.exports = {
  createProvider,
  allSystemIds,
  REGISTRY,
  DISPLAY_NAMES,
  PROVIDER_IDS,
  BaseProvider: require('./base-provider').BaseProvider,
  QemuBackend: require('./qemu-backend').QemuBackend,
};

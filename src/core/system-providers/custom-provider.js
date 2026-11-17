'use strict';
/**
 * 自定义镜像 Provider —— 复用现有 images.js（ImageStore），不破坏原导入/管理功能。
 * UI 里"自定义系统镜像"卡片由本 Provider 提供状态；导入/启用仍走原有 image:* IPC。
 */
const { BaseProvider, PROVIDER_IDS } = require('./base-provider');

class CustomProvider extends BaseProvider {
  constructor(ctx = {}) {
    super(Object.assign({}, ctx, { systemId: PROVIDER_IDS.CUSTOM, displayName: '自定义镜像' }));
    this.imageStore = ctx.imageStore || null;
  }

  async getAvailability() {
    const status = this.imageStore && this.imageStore.status ? this.imageStore.status() : {};
    const count = (status.items || []).length;
    return {
      available: true,
      status: 'builtin',
      reason: count ? '' : '尚未导入自定义镜像（设置 → 高级 → 自定义系统镜像）',
      version: count ? { version: `${count} 个镜像`, status: 'builtin' } : null,
    };
  }

  async getLocalStatus() {
    const status = this.imageStore && this.imageStore.status ? this.imageStore.status() : {};
    return {
      installed: !!(status.active && status.active.ok),
      downloaded: (status.items || []).length > 0,
      running: false,
      version: (status.active && status.active.name) || '',
      items: (status.items || []).map((it) => ({ id: it.id, name: it.name })),
      paths: {},
    };
  }

  async getDownloadInfo() { return null; }
  async start() { return { ok: false, error: '自定义镜像请通过「设置 → 高级 → 自定义系统镜像」启用后启动。' }; }
}
module.exports = { CustomProvider };

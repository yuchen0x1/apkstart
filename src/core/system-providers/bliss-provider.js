'use strict';
/** Bliss OS Provider —— 独立 QEMU 虚拟机，ISO 归档快照。 */
const { QemuIsoProvider } = require('./qemu-iso-provider');
const { PROVIDER_IDS } = require('./base-provider');

class BlissProvider extends QemuIsoProvider {
  constructor(ctx = {}) {
    super(Object.assign({}, ctx, {
      systemId: PROVIDER_IDS.BLISS,
      displayName: 'Bliss OS',
      isoFileName: 'bliss-os.iso',
    }));
  }
  async getAvailability() {
    const base = await super.getAvailability();
    if (base.status === 'available-archive') {
      return Object.assign({}, base, {
        archive: true,
        reason: 'blissos.org 已停止发布新 ISO；这是 SourceForge 官方归档快照，无 OTA 与官方支持。',
      });
    }
    return base;
  }
}
module.exports = { BlissProvider };

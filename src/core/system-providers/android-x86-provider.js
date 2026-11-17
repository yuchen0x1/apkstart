'use strict';
/** Android-x86 Provider —— 独立 QEMU 虚拟机，官方 9.0-r2 稳定 ISO。 */
const { QemuIsoProvider } = require('./qemu-iso-provider');
const { PROVIDER_IDS } = require('./base-provider');

class AndroidX86Provider extends QemuIsoProvider {
  constructor(ctx = {}) {
    super(Object.assign({}, ctx, {
      systemId: PROVIDER_IDS.ANDROID_X86,
      displayName: 'Android-x86',
      isoFileName: 'android-x86.iso',
    }));
  }
}
module.exports = { AndroidX86Provider };

'use strict';
/** 外围设备纯离线回归：不执行 emulator/qemu/adb，不连接真实客机或真实摄像头。 */
const assert = require('assert');
const peripherals = require('../src/core/peripherals');
const { QemuBackend } = require('../src/core/system-providers/qemu-backend');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error('  ✗ ' + name + '\n    ' + error.message);
  }
}
function throwsCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

console.log('\n[peripherals]');

test('默认配置关闭前后摄像头且刷新率为 60', () => {
  assert.deepStrictEqual(peripherals.normalizeSettings(), {
    cameraBack: 'none', cameraFront: 'none', refreshRate: 60, serialPort: '',
  });
  assert.deepStrictEqual(peripherals.buildEmulatorArgs(), [
    '-camera-back', 'none', '-camera-front', 'none',
  ]);
});

test('规范化合法摄像头、刷新率和串口', () => {
  assert.deepStrictEqual(peripherals.normalizeSettings({
    cameraBack: 'WEBCAM0', cameraFront: 'emulated', refreshRate: '144', serialPort: 'com10',
  }), {
    cameraBack: 'webcam0', cameraFront: 'emulated', refreshRate: 144, serialPort: 'COM10',
  });
  assert.strictEqual(peripherals.normalizeSettings({ serialPort: '/dev/ttyUSB0' }).serialPort, '/dev/ttyUSB0');
});

test('非法摄像头、刷新率和串口不被静默改写', () => {
  throwsCode(() => peripherals.normalizeSettings({ cameraBack: 'webcamX' }), 'INVALID_CAMERA');
  throwsCode(() => peripherals.normalizeSettings({ refreshRate: 59 }), 'INVALID_REFRESH_RATE');
  throwsCode(() => peripherals.normalizeSettings({ serialPort: 'COM1,foo=bar' }), 'INVALID_SERIAL_PORT');
  throwsCode(() => peripherals.normalizeSettings({ serialPort: 'COM1; -device isa-serial' }), 'INVALID_SERIAL_PORT');
  throwsCode(() => peripherals.normalizeSettings({ serialPort: 'COM1\n-next' }), 'INVALID_SERIAL_PORT');
  assert.strictEqual(peripherals.validateSettings({ serialPort: 'COM0' }).ok, false);
});

test('Android Emulator hardware config 和 args 显式保持未选摄像头关闭', () => {
  assert.deepStrictEqual(peripherals.buildEmulatorConfig({ refreshRate: 120 }), {
    'hw.camera.back': 'none',
    'hw.camera.front': 'none',
    'hw.lcd.vsync': '120',
  });
  assert.deepStrictEqual(peripherals.buildEmulatorArgs({ cameraBack: 'webcam2', refreshRate: 90 }), [
    '-camera-back', 'webcam2', '-camera-front', 'none',
  ]);
  throwsCode(() => peripherals.buildEmulatorArgs({ serialPort: 'COM3' }), 'PERIPHERAL_UNSUPPORTED');
});

test('官方 webcam-list 文本解析出 ID、设备名和通道', () => {
  const cameras = peripherals.parseWebcamList([
    'List of web cameras connected to the computer:',
    "Camera 'webcam0' is connected to device 'Integrated Camera'",
    "on channel 0 using pixel format 'UYVY'",
    "Camera 'webcam1' is connected to device 'USB Camera'",
    "on channel 2 using pixel format 'MJPG'",
  ].join('\n'));
  assert.ok(Array.isArray(cameras));
  assert.deepStrictEqual(cameras.ids, ['webcam0', 'webcam1']);
  assert.deepStrictEqual(cameras.map((camera) => camera.name), ['Integrated Camera', 'USB Camera']);
  assert.strictEqual(cameras[1].channel, 2);
  assert.strictEqual(cameras[1].pixelFormat, 'MJPG');
});

test('dumpsys display 用 active mode 读回真实刷新率', () => {
  const dump = [
    'mActiveModeId=2',
    'mSupportedModes=[{id=1, width=1080, height=1920, refreshRate=60.0},',
    ' {id=2, width=1080, height=1920, refreshRate=90.00001}]',
  ].join('\n');
  const result = peripherals.parseDisplayRefresh(dump, { requestedRate: 90 });
  assert.strictEqual(result.status, 'confirmed');
  assert.strictEqual(result.activeModeId, 2);
  assert.ok(Math.abs(result.activeRate - 90.00001) < 0.001);
  assert.strictEqual(result.modes.length, 2);
  const targeted = peripherals.parseDisplayRefresh(dump, { requestedRate: 90, displayId: 0 });
  assert.strictEqual(targeted.status, 'confirmed', 'unlabelled legacy single-display output remains the default display');
  assert.strictEqual(targeted.activeRate, 90.00001);
  assert.strictEqual(targeted.modes.length, 2);
});

test('realistic device and logical sections scope modes and deduplicate repeated DisplayInfo records', () => {
  const dump = [
    'DISPLAY MANAGER (dumpsys display)',
    '  mDisplayDevices:',
    '    Display Devices: size=1',
    '      DisplayDeviceInfo{Built-in Panel, uniqueId="local:0", 720 x 1280, modeId 1, mActiveModeId=1, supportedModes [{id=1, width=720, height=1280, refreshRate=60.0}, {id=2, width=720, height=1280, refreshRate=120.0}]}',
    '  mLogicalDisplays:',
    '    Logical Displays: size=1',
    '      Display 0:',
    '        mDisplayId=0',
    '        mBaseDisplayInfo=DisplayInfo{"Built-in Panel", displayId 0, real 720 x 1280, modeId 2, supportedModes [{id=1, width=720, height=1280, refreshRate=60.0}, {id=2, width=720, height=1280, refreshRate=120.0}]}',
    '        mOverrideDisplayInfo=DisplayInfo{"Built-in Panel", displayId 0, real 720 x 1280, modeId 2, supportedModes [{id=1, width=720, height=1280, refreshRate=60.0}, {id=2, width=720, height=1280, refreshRate=120.0}]}',
    '        mActiveModeId=2',
  ].join('\n');
  const result = peripherals.parseDisplayRefresh(dump, { requestedRate: 120, displayId: 0 });
  assert.strictEqual(result.status, 'confirmed', 'device modes must not override logical active modes');
  assert.strictEqual(result.activeModeId, 2);
  assert.strictEqual(result.activeRate, 120);
  assert.deepStrictEqual(result.modes.map(mode => mode.refreshRate), [60, 120], 'identical base/override mode records are deduplicated');

  const conflict = peripherals.parseDisplayRefresh(
    dump.replace('mOverrideDisplayInfo=DisplayInfo{"Built-in Panel", displayId 0, real 720 x 1280, modeId 2',
      'mOverrideDisplayInfo=DisplayInfo{"Built-in Panel", displayId 0, real 720 x 1280, modeId 1'),
    { requestedRate: 120, displayId: 0 },
  );
  assert.strictEqual(conflict.status, 'unconfirmed', 'conflicting logical active-mode records must fail closed');
  assert.strictEqual(conflict.activeRate, null);
  assert.strictEqual(conflict.ok, false);
});

test('unclassified prefix mode evidence cannot be silently discarded', () => {
  const dump = [
    'mActiveModeId=2',
    'mSupportedModes=[{id=2, width=1920, height=1080, refreshRate=120.0}]',
    'Display 0:',
    '  mDisplayId=0',
    '  mActiveModeId=1',
    '  mSupportedModes=[{id=1, width=720, height=1280, refreshRate=60.0}]',
  ].join('\n');
  const result = peripherals.parseDisplayRefresh(dump, { requestedRate: 60, displayId: 0 });
  assert.strictEqual(result.status, 'unconfirmed');
  assert.strictEqual(result.activeRate, null);
  assert.strictEqual(result.ok, false);
});

test('dumpsys display only uses the requested logical display when display blocks are reversed', () => {
  const dump = [
    'DISPLAY MANAGER (dumpsys display) - 2 displays',
    'Display 1:',
    '  mDisplayId=1',
    '  mBaseDisplayInfo=DisplayInfo{\"External monitor\", displayId 1, real 1920 x 1080, modeId 1}',
    '  mActiveModeId=1',
    '  mSupportedModes=[{id=1, width=1920, height=1080, refreshRate=120.0}]',
    'Display 0:',
    '  mDisplayId=0',
    '  mBaseDisplayInfo=DisplayInfo{\"Built-in Screen\", displayId 0, real 720 x 1280, modeId 1}',
    '  mActiveModeId=1',
    '  mSupportedModes=[{id=1, width=720, height=1280, refreshRate=60.0}]',
  ].join('\n');
  const primary = peripherals.parseDisplayRefresh(dump, { requestedRate: 120, displayId: 0 });
  assert.strictEqual(primary.status, 'mismatch', 'the other display must not falsely confirm 120 Hz');
  assert.strictEqual(primary.ok, false);
  assert.strictEqual(primary.activeModeId, 1);
  assert.strictEqual(primary.activeRate, 60);
  assert.deepStrictEqual(primary.modes.map(mode => mode.refreshRate), [60]);
  assert.strictEqual(primary.displayId, 0);

  const external = peripherals.parseDisplayRefresh(dump, { requestedRate: 120, displayId: 1 });
  assert.strictEqual(external.status, 'confirmed');
  assert.strictEqual(external.activeRate, 120);
  assert.deepStrictEqual(external.modes.map(mode => mode.refreshRate), [120]);
});

test('reused mode IDs across displays stay scoped; duplicate active IDs within target fail closed', () => {
  const dump = [
    'Display 1:',
    '  mDisplayId=1',
    '  mActiveModeId=7',
    '  mSupportedModes=[{id=7, width=1920, height=1080, refreshRate=144.0}]',
    'Display 0:',
    '  mDisplayId=0',
    '  mActiveModeId=7',
    '  mSupportedModes=[{id=7, width=720, height=1280, refreshRate=60.0}]',
  ].join('\n');
  const target = peripherals.parseDisplayRefresh(dump, { requestedRate: 60, displayId: 0 });
  assert.strictEqual(target.status, 'confirmed');
  assert.strictEqual(target.activeModeId, 7);
  assert.strictEqual(target.activeRate, 60);
  assert.deepStrictEqual(target.modes.map(mode => mode.refreshRate), [60]);

  const duplicate = peripherals.parseDisplayRefresh([
    'Display 0:',
    '  mDisplayId=0',
    '  mActiveModeId=7',
    '  mSupportedModes=[{id=7, width=720, height=1280, refreshRate=60.0},',
    '                   {id=7, width=720, height=1280, refreshRate=120.0}]',
  ].join('\n'), { requestedRate: 120, displayId: 0 });
  assert.strictEqual(duplicate.status, 'unconfirmed');
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.activeRate, null);
});

test('target display missing or with conflicting identity stays unconfirmed', () => {
  const dump = [
    'Display 1:',
    '  mDisplayId=1',
    '  mActiveModeId=1',
    '  mSupportedModes=[{id=1, width=1920, height=1080, refreshRate=120.0}]',
  ].join('\n');
  const missing = peripherals.parseDisplayRefresh(dump, { requestedRate: 120, displayId: 0 });
  assert.strictEqual(missing.status, 'unconfirmed');
  assert.strictEqual(missing.activeRate, null);
  assert.deepStrictEqual(missing.modes, []);

  const conflicting = peripherals.parseDisplayRefresh([
    'Display 0:',
    '  mDisplayId=1',
    '  mActiveModeId=1',
    '  mSupportedModes=[{id=1, width=720, height=1280, refreshRate=120.0}]',
  ].join('\n'), { requestedRate: 120, displayId: 0 });
  assert.strictEqual(conflicting.status, 'unconfirmed');
  assert.strictEqual(conflicting.ok, false);
  assert.strictEqual(conflicting.activeRate, null);
});

test('invalid display IDs remain unconfirmed instead of throwing or selecting the default screen', () => {
  const dump = 'mActiveModeId=1 mSupportedModes=[{id=1, width=720, height=1280, refreshRate=60.0}]';
  for (const displayId of [-1, 0.5, 'not-a-display', Infinity]) {
    const result = peripherals.parseDisplayRefresh(dump, { requestedRate: 60, displayId });
    assert.strictEqual(result.status, 'unconfirmed');
    assert.strictEqual(result.activeRate, null);
    assert.strictEqual(result.ok, false);
  }
});

test('真实 active 刷新率不匹配时不误报成功', () => {
  const result = peripherals.parseDisplayRefresh(
    'mActiveModeId=1 mSupportedModes=[{id=1, width=720, height=1280, refreshRate=60.0}]',
    { requestedRate: 120 },
  );
  assert.strictEqual(result.status, 'mismatch');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.activeRate, 60);
});

test('只有 supported modes 或只有请求值时保持 unconfirmed', () => {
  const supportedOnly = peripherals.parseDisplayRefresh(
    'requestedRefreshRate=120 mSupportedModes=[{id=1, width=720, height=1280, refreshRate=60.0}]',
    { requestedRate: 120 },
  );
  assert.strictEqual(supportedOnly.status, 'unconfirmed');
  assert.strictEqual(supportedOnly.activeRate, null);
  const empty = peripherals.parseDisplayRefresh('refreshRate=144', { requestedRate: 144 });
  assert.strictEqual(empty.status, 'unconfirmed');
  assert.strictEqual(empty.ok, false);
});

test('QEMU 只生成一个安全串口，空值不添加设备', () => {
  assert.deepStrictEqual(peripherals.buildQemuArgs({ serialPort: '' }), []);
  const args = peripherals.buildQemuArgs({ serialPort: 'COM10' });
  assert.deepStrictEqual(args, [
    '-serial', 'none',
    '-chardev', 'serial,id=apkstart-serial,path=COM10',
    '-device', 'isa-serial,chardev=apkstart-serial',
  ]);
  assert.strictEqual(args.filter((value) => value === '-chardev').length, 1);
  assert.ok(!args.join(' ').includes(',' + 'foo'));
});

test('QEMU 未核实摄像头/非默认刷新率明确拒绝', () => {
  throwsCode(() => peripherals.buildQemuArgs({ cameraFront: 'emulated' }), 'PERIPHERAL_UNSUPPORTED');
  throwsCode(() => peripherals.buildQemuArgs({ refreshRate: 90 }), 'PERIPHERAL_UNSUPPORTED');
});

test('QemuBackend 保留原有参数并注入 settings.peripherals 串口', () => {
  const backend = new QemuBackend({
    settingsFn: () => ({ peripherals: { serialPort: 'COM3' } }),
    qemuExe: undefined,
  });
  const args = backend.buildArgs({ accel: { whpx: true }, uefi: false, adbPort: 6001 });
  assert.ok(args.includes('-machine'));
  assert.ok(args.includes('q35,accel=whpx'));
  const netdev = args[args.indexOf('-netdev') + 1];
  assert.ok(netdev.includes('hostfwd=tcp:127.0.0.1:6001-:5555'));
  assert.ok(args.includes('-chardev'));
  assert.ok(args.includes('serial,id=apkstart-serial,path=COM3'));
  assert.ok(args.includes('isa-serial,chardev=apkstart-serial'));

  const explicit = new QemuBackend({ settingsFn: () => ({ peripherals: { serialPort: 'COM3' } }) });
  const noSerial = explicit.buildArgs({ peripherals: {}, uefi: false });
  assert.ok(!noSerial.includes('-chardev'));
});

const total = passed + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} peripherals 测试：${passed}/${total} 通过`);
if (failures.length) {
  for (const failure of failures) console.error('  ✗ ' + failure);
  process.exit(1);
}

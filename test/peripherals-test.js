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

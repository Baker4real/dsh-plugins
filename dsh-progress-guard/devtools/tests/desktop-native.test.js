import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeHitTester, hitName } from '../desktop-native.js';

test('native hit testing converts CSS pixels with DPR and uses a bounded Windows message', () => {
  const calls = [];
  const driver = {
    clientToScreen(handle, point) { calls.push({ method: 'clientToScreen', handle, point: { ...point } }); point.x += 100; point.y += 200; },
    windowFromPoint(point) { calls.push({ method: 'windowFromPoint', point }); return 77n; },
    getWindowThreadProcessId(handle) { calls.push({ method: 'pid', handle }); return 42; },
    sendMessageTimeout(handle, message, wParam, lParam, flags, timeout) {
      calls.push({ method: 'send', handle, message, wParam, lParam, flags, timeout });
      return 1;
    },
  };
  const tester = new NativeHitTester({ driver, platform: 'win32', allowedProcessIds: [42] });
  const result = tester.hitTest({ handle: '1234', x: 20, y: 35, devicePixelRatio: 1.5 });
  assert.equal(result.physicalPoint.x, 30);
  assert.equal(result.physicalPoint.y, 53);
  assert.equal(result.screenPoint.x, 130);
  assert.equal(result.screenPoint.y, 253);
  assert.equal(result.processId, 42);
  assert.equal(result.hitWindow, '77');
  assert.equal(result.hitTest, 1);
  assert.equal(result.hitName, 'HTCLIENT');
  const send = calls.find(call => call.method === 'send');
  assert.equal(send.handle, '1234');
  assert.equal(send.message, 0x0084);
  assert.equal(send.timeout, 1000);
  assert.equal(send.lParam, (253 << 16) | 130);
});

test('native driver creation is shared across module instances in the same Host process', () => {
  let creations = 0;
  const cache = {};
  const driver = {
    clientToScreen(_handle, point) {},
    windowFromPoint() { return 1n; },
    getWindowThreadProcessId() { return 42; },
    sendMessageTimeout() { return 2; },
  };
  const createDriver = () => { creations++; return driver; };
  const first = new NativeHitTester({ cache, createDriver, platform: 'win32', allowedProcessIds: [42] });
  const second = new NativeHitTester({ cache, createDriver, platform: 'win32', allowedProcessIds: [42] });
  first.hitTest({ handle: '1', x: 0, y: 0 });
  second.hitTest({ handle: '1', x: 0, y: 0 });
  assert.equal(creations, 1);
});

test('native hit names match the Win32 negative and zero constants', () => {
  assert.deepEqual([-2, -1, 0, 1, 2].map(hitName), ['HTERROR', 'HTTRANSPARENT', 'HTNOWHERE', 'HTCLIENT', 'HTCAPTION']);
});

test('a window outside the Desktop main process is rejected before coordinate or message calls', () => {
  const calls = [];
  const driver = {
    getWindowThreadProcessId() { calls.push('pid'); return 99; },
    clientToScreen() { calls.push('clientToScreen'); },
    windowFromPoint() { calls.push('windowFromPoint'); return 1n; },
    sendMessageTimeout() { calls.push('send'); return 1; },
  };
  const tester = new NativeHitTester({ driver, platform: 'win32', allowedProcessIds: [42] });
  assert.throws(() => tester.hitTest({ handle: '1234', x: 0, y: 0 }), /WINDOW_NOT_OWNED_BY_DESKTOP/);
  assert.deepEqual(calls, ['pid']);
});

test('native hit testing rejects invalid input and unsupported platforms before native calls', () => {
  const tester = new NativeHitTester({ driver: {}, platform: 'linux' });
  assert.throws(() => tester.hitTest({ handle: '1', x: 0, y: 0 }), /UNSUPPORTED_PLATFORM/);
  const windows = new NativeHitTester({ driver: {}, platform: 'win32' });
  assert.throws(() => windows.hitTest({ handle: 'x', x: 0, y: 0 }), /handle/);
  assert.throws(() => windows.hitTest({ handle: '1', x: 0, y: 0, devicePixelRatio: 0 }), /devicePixelRatio/);
});

import { createRequire } from 'node:module';
import { join } from 'node:path';

const HIT_NAMES = new Map([[-2, 'HTERROR'], [-1, 'HTTRANSPARENT'], [0, 'HTNOWHERE'], [1, 'HTCLIENT'], [2, 'HTCAPTION']]);
export const hitName = value => HIT_NAMES.get(value) ?? `HT_${value}`;
const DRIVER_CACHE = Symbol.for('@local/dsh-devtools/desktop-native-driver-v2');

function createKoffiDriver(resourcesPath) {
  const require = createRequire(join(resourcesPath, 'app.asar', 'dsh', 'package.json'));
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  koffi.struct('DSH_DEVTOOLS_POINT_V2', { x: 'int32', y: 'int32' });
  const ClientToScreen = user32.func('bool ClientToScreen(uintptr_t hwnd, _Inout_ DSH_DEVTOOLS_POINT_V2* point)');
  const WindowFromPoint = user32.func('uintptr_t WindowFromPoint(DSH_DEVTOOLS_POINT_V2 point)');
  const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32* processId)');
  const SendMessageTimeoutW = user32.func('intptr_t SendMessageTimeoutW(uintptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam, uint32 flags, uint32 timeout, _Out_ intptr_t* result)');
  return {
    clientToScreen(handle, point) {
      const native = { x: point.x, y: point.y };
      if (!ClientToScreen(BigInt(handle), native)) throw new Error('CLIENT_TO_SCREEN_FAILED');
      point.x = native.x;
      point.y = native.y;
    },
    windowFromPoint(point) {
      const value = WindowFromPoint({ x: point.x, y: point.y });
      return BigInt(value);
    },
    getWindowThreadProcessId(handle) {
      const output = [0];
      GetWindowThreadProcessId(BigInt(handle), output);
      return output[0];
    },
    sendMessageTimeout(handle, message, wParam, lParam, flags, timeout) {
      const output = [0n];
      const ok = SendMessageTimeoutW(BigInt(handle), message, BigInt(wParam), BigInt(lParam), flags, timeout, output);
      if (!ok) throw new Error('NATIVE_MESSAGE_TIMEOUT');
      return Number(output[0]);
    },
  };
}

export class NativeHitTester {
  constructor({ driver, platform = process.platform, resourcesPath = process.resourcesPath, cache = globalThis, createDriver = createKoffiDriver, allowedProcessIds = process.ppid ? [process.ppid] : [] } = {}) {
    this.driver = driver;
    this.platform = platform;
    this.resourcesPath = resourcesPath;
    this.cache = cache;
    this.createDriver = createDriver;
    this.allowedProcessIds = new Set(allowedProcessIds);
  }
  hitTest(input) {
    if (this.platform !== 'win32') throw new Error('UNSUPPORTED_PLATFORM: native hit testing requires Windows');
    if (typeof input.handle !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(input.handle)) throw new Error('handle must be a positive native window handle string');
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error('x and y must be finite CSS pixel coordinates');
    const devicePixelRatio = input.devicePixelRatio ?? 1;
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0 || devicePixelRatio > 4) throw new Error('devicePixelRatio must be greater than zero and at most 4');
    this.driver ??= this.cache[DRIVER_CACHE] ??= this.createDriver(this.resourcesPath);
    const processId = this.driver.getWindowThreadProcessId(input.handle);
    if (!this.allowedProcessIds.has(processId)) throw new Error('WINDOW_NOT_OWNED_BY_DESKTOP');
    const physicalPoint = { x: Math.round(input.x * devicePixelRatio), y: Math.round(input.y * devicePixelRatio) };
    const screenPoint = { ...physicalPoint };
    this.driver.clientToScreen(input.handle, screenPoint);
    const hitWindow = this.driver.windowFromPoint(screenPoint);
    const lParam = ((screenPoint.y & 0xffff) << 16) | (screenPoint.x & 0xffff);
    const hitTest = this.driver.sendMessageTimeout(input.handle, 0x0084, 0, lParam, 2, 1000);
    return { platform: 'host', handle: input.handle, processId, cssPoint: { x: input.x, y: input.y }, devicePixelRatio, physicalPoint, screenPoint, hitWindow: hitWindow.toString(), hitTest, hitName: hitName(hitTest), timeoutMs: 1000 };
  }
}

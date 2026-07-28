import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookRuntime = vi.hoisted(() => {
  type Cleanup = () => void;
  type Effect = () => void | Cleanup;
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    effect?: Effect;
    cleanup?: Cleanup;
    pending?: boolean;
  }

  const slots: HookSlot[] = [];
  let cursor = 0;

  const sameDependencies = (left?: readonly unknown[], right?: readonly unknown[]) => (
    Boolean(left && right)
    && left!.length === right!.length
    && left!.every((value, index) => Object.is(value, right![index]))
  );

  const reset = () => {
    for (const slot of slots) slot.cleanup?.();
    slots.length = 0;
    cursor = 0;
  };

  return {
    reset,
    render<T>(callback: () => T): T {
      cursor = 0;
      return callback();
    },
    useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      }
      const setValue = (next: T | ((current: T) => T)) => {
        const current = slots[index].value as T;
        slots[index].value = typeof next === "function"
          ? (next as (value: T) => T)(current)
          : next;
      };
      return [slots[index].value as T, setValue];
    },
    useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDependencies(existing.deps, deps)) {
        slots[index] = { value: factory(), deps };
      }
      return slots[index].value as T;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]): T {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDependencies(existing.deps, deps)) {
        slots[index] = { value: callback, deps };
      }
      return slots[index].value as T;
    },
    useEffect(effect: Effect, deps?: readonly unknown[]): void {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDependencies(existing.deps, deps)) {
        slots[index] = { ...existing, deps, effect, pending: true };
      }
    },
    flushEffects(): void {
      for (const slot of slots) {
        if (!slot.pending || !slot.effect) continue;
        slot.cleanup?.();
        slot.pending = false;
        const cleanup = slot.effect();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    },
  };
});

vi.mock("react", () => ({
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useMemo: hookRuntime.useMemo,
  useState: hookRuntime.useState,
}));

import { useOutputDevices } from "./useOutputDevices";

const OUTPUT_DEVICE_KEY = "cadilume-output-device";
const globalKeys = ["HTMLMediaElement", "localStorage", "navigator", "window"] as const;
const originalDescriptors = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

class DeniedStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new DOMException("Storage disabled", "SecurityError");
  }

  override removeItem(_key: string): void {
    throw new DOMException("Storage disabled", "SecurityError");
  }

  override setItem(_key: string, _value: string): void {
    throw new DOMException("Storage disabled", "SecurityError");
  }
}

type DeviceChangeListener = EventListenerOrEventListenerObject;

class FakeMediaDevices {
  devices: MediaDeviceInfo[];
  readonly enumerateDevices = vi.fn(async () => this.devices);
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
  private readonly deviceChangeListeners = new Set<DeviceChangeListener>();

  constructor(devices: MediaDeviceInfo[]) {
    this.devices = devices;
  }

  addEventListener(type: string, listener: DeviceChangeListener): void {
    if (type === "devicechange") this.deviceChangeListeners.add(listener);
  }

  removeEventListener(type: string, listener: DeviceChangeListener): void {
    if (type === "devicechange") this.deviceChangeListeners.delete(listener);
  }

  dispatchDeviceChange(): void {
    const event = new Event("devicechange");
    for (const listener of this.deviceChangeListeners) {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
  }

  listenerCount(): number {
    return this.deviceChangeListeners.size;
  }
}

function audioDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "group-a",
    kind: "audiooutput",
    label,
    toJSON: () => ({ deviceId, groupId: "group-a", kind: "audiooutput", label }),
  };
}

function installWindowsEnvironment(
  mediaDevices: FakeMediaDevices,
  storage: Storage,
  options: { secure?: boolean; sinkSelection?: boolean } = {},
): void {
  class FakeHTMLMediaElement {}
  if (options.sinkSelection !== false) {
    Object.defineProperty(FakeHTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: async () => undefined,
    });
  }

  Object.defineProperty(globalThis, "HTMLMediaElement", {
    configurable: true,
    value: FakeHTMLMediaElement,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices,
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      userAgentData: { platform: "Windows" },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { isSecureContext: options.secure !== false },
  });
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function mountOutputDevices(setOutputSinkId: (deviceId: string) => Promise<boolean>) {
  let current = hookRuntime.render(() => useOutputDevices(setOutputSinkId));
  hookRuntime.flushEffects();
  await settleAsyncWork();
  current = hookRuntime.render(() => useOutputDevices(setOutputSinkId));
  hookRuntime.flushEffects();

  return {
    get current() {
      return current;
    },
    render() {
      current = hookRuntime.render(() => useOutputDevices(setOutputSinkId));
      hookRuntime.flushEffects();
    },
  };
}

beforeEach(() => hookRuntime.reset());

afterEach(() => {
  hookRuntime.reset();
  for (const key of globalKeys) {
    const descriptor = originalDescriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  vi.restoreAllMocks();
});

describe("useOutputDevices on Windows", () => {
  it("exposes WebView2 capabilities and selects custom or system-default outputs", async () => {
    const storage = new MemoryStorage();
    const mediaDevices = new FakeMediaDevices([
      audioDevice("default", "Default"),
      audioDevice("speakers", "Built-in Speakers"),
      audioDevice("headset", "USB Headset"),
    ]);
    const systemPicker = vi.fn(async () => audioDevice("headset", "USB Headset"));
    mediaDevices.selectAudioOutput = systemPicker;
    installWindowsEnvironment(mediaDevices, storage);
    const setSink = vi.fn(async (_deviceId: string) => true);

    const mounted = await mountOutputDevices(setSink);

    expect(mounted.current.platform).toBe("windows");
    expect(mounted.current.canSelectSink).toBe(true);
    expect(mounted.current.canUseSystemPicker).toBe(true);
    expect(mounted.current.devices).toEqual([
      { deviceId: "", label: "系统默认", isDefault: true },
      { deviceId: "speakers", label: "Built-in Speakers", isDefault: false },
      { deviceId: "headset", label: "USB Headset", isDefault: false },
    ]);

    await mounted.current.requestSystemDevice();
    mounted.render();
    expect(systemPicker).toHaveBeenCalledWith(undefined);
    expect(setSink).toHaveBeenLastCalledWith("headset");
    expect(mounted.current.selectedDeviceId).toBe("headset");
    expect(storage.getItem(OUTPUT_DEVICE_KEY)).toBe("headset");

    await expect(mounted.current.selectDevice("")).resolves.toBe(true);
    mounted.render();
    expect(setSink).toHaveBeenLastCalledWith("");
    expect(mounted.current.selectedDeviceId).toBe("");
    expect(storage.getItem(OUTPUT_DEVICE_KEY)).toBeNull();
  });

  it("does not advertise application-level routing without secure setSinkId support", async () => {
    const storage = new MemoryStorage();
    storage.setItem(OUTPUT_DEVICE_KEY, "speakers");
    const mediaDevices = new FakeMediaDevices([audioDevice("speakers", "Speakers")]);
    installWindowsEnvironment(mediaDevices, storage, { secure: false, sinkSelection: false });
    const setSink = vi.fn(async (_deviceId: string) => true);

    const mounted = await mountOutputDevices(setSink);

    expect(mounted.current.platform).toBe("windows");
    expect(mounted.current.canSelectSink).toBe(false);
    expect(mounted.current.canUseSystemPicker).toBe(false);
    expect(setSink).not.toHaveBeenCalled();
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  });

  it("restores and revalidates a persisted output preference", async () => {
    const storage = new MemoryStorage();
    storage.setItem(OUTPUT_DEVICE_KEY, "speakers");
    const mediaDevices = new FakeMediaDevices([
      audioDevice("default", "Default"),
      audioDevice("speakers", "Speakers"),
    ]);
    installWindowsEnvironment(mediaDevices, storage);
    const setSink = vi.fn(async (_deviceId: string) => true);

    const mounted = await mountOutputDevices(setSink);

    expect(setSink).toHaveBeenCalledWith("speakers");
    expect(mounted.current.selectedDeviceId).toBe("speakers");
    expect(storage.getItem(OUTPUT_DEVICE_KEY)).toBe("speakers");
    expect(mounted.current.message).toBeUndefined();
  });

  it("falls back to the system default when devicechange removes the selected output", async () => {
    const storage = new MemoryStorage();
    storage.setItem(OUTPUT_DEVICE_KEY, "headset");
    const mediaDevices = new FakeMediaDevices([
      audioDevice("default", "Default"),
      audioDevice("headset", "USB Headset"),
    ]);
    installWindowsEnvironment(mediaDevices, storage);
    const setSink = vi.fn(async (_deviceId: string) => true);
    const mounted = await mountOutputDevices(setSink);

    expect(mediaDevices.listenerCount()).toBe(1);
    mediaDevices.devices = [audioDevice("default", "Default")];
    mediaDevices.dispatchDeviceChange();
    await settleAsyncWork();
    mounted.render();

    expect(setSink.mock.calls.map(([deviceId]) => deviceId)).toEqual(["headset", ""]);
    expect(mounted.current.selectedDeviceId).toBe("");
    expect(storage.getItem(OUTPUT_DEVICE_KEY)).toBeNull();
    expect(mounted.current.message).toBe("原输出设备已断开，已切回系统默认。");

    hookRuntime.reset();
    expect(mediaDevices.listenerCount()).toBe(0);
  });

  it("clears unavailable preferences and handles false or rejected routing without leaking errors", async () => {
    const storage = new MemoryStorage();
    storage.setItem(OUTPUT_DEVICE_KEY, "missing-device");
    const mediaDevices = new FakeMediaDevices([audioDevice("default", "Default")]);
    installWindowsEnvironment(mediaDevices, storage);
    const setSink = vi.fn(async (deviceId: string) => {
      if (deviceId === "missing-device") return false;
      if (deviceId === "also-missing") throw new Error("WebView2 routing failed");
      return true;
    });

    const mounted = await mountOutputDevices(setSink);

    expect(setSink.mock.calls.map(([deviceId]) => deviceId)).toEqual(["missing-device", ""]);
    expect(mounted.current.selectedDeviceId).toBe("");
    expect(storage.getItem(OUTPUT_DEVICE_KEY)).toBeNull();
    expect(mounted.current.message).toBe("上次使用的输出设备不可用，已恢复系统默认。");

    await expect(mounted.current.selectDevice("also-missing")).resolves.toBe(false);
    mounted.render();
    expect(setSink.mock.calls.slice(-2).map(([deviceId]) => deviceId)).toEqual(["also-missing", ""]);
    expect(mounted.current.message).toBe("所选设备当前不可用，已回退到系统默认输出。");
  });

  it("keeps the default device available when enumeration fails", async () => {
    const storage = new MemoryStorage();
    const mediaDevices = new FakeMediaDevices([]);
    mediaDevices.enumerateDevices.mockRejectedValueOnce(new Error("Permission denied"));
    installWindowsEnvironment(mediaDevices, storage);

    const mounted = await mountOutputDevices(vi.fn(async () => true));

    expect(mounted.current.loading).toBe(false);
    expect(mounted.current.devices).toEqual([
      { deviceId: "", label: "系统默认", isDefault: true },
    ]);
    expect(mounted.current.message).toBe("Permission denied");
  });

  it("continues routing when WebView storage access is denied", async () => {
    const mediaDevices = new FakeMediaDevices([audioDevice("speakers", "Speakers")]);
    installWindowsEnvironment(mediaDevices, new DeniedStorage());
    const setSink = vi.fn(async (_deviceId: string) => true);

    const mounted = await mountOutputDevices(setSink);
    await expect(mounted.current.selectDevice("speakers")).resolves.toBe(true);
    mounted.render();

    expect(setSink).toHaveBeenCalledWith("speakers");
    expect(mounted.current.selectedDeviceId).toBe("speakers");
    expect(mounted.current.message).toBeUndefined();
  });
});

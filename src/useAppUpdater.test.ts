import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse } from "./types";

const hookRuntime = vi.hoisted(() => {
  type Effect = () => void | (() => void);
  interface Slot {
    value?: unknown;
    deps?: readonly unknown[];
    effect?: Effect;
    cleanup?: () => void;
    pending?: boolean;
  }

  const slots: Slot[] = [];
  let cursor = 0;
  const sameDependencies = (left?: readonly unknown[], right?: readonly unknown[]) => (
    Boolean(left && right)
    && left!.length === right!.length
    && left!.every((value, index) => Object.is(value, right![index]))
  );

  return {
    reset() {
      for (const slot of slots) slot.cleanup?.();
      slots.length = 0;
      cursor = 0;
    },
    render<T>(callback: () => T): T {
      cursor = 0;
      return callback();
    },
    useState<T>(initial?: T | (() => T)): [T | undefined, (next: T | undefined | ((current: T | undefined) => T | undefined)) => void] {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      }
      const setValue = (next: T | undefined | ((current: T | undefined) => T | undefined)) => {
        const current = slots[index].value as T | undefined;
        slots[index].value = typeof next === "function"
          ? (next as (value: T | undefined) => T | undefined)(current)
          : next;
      };
      return [slots[index].value as T | undefined, setValue];
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value as { current: T };
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]): T {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDependencies(existing.deps, deps)) slots[index] = { value: callback, deps };
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

const apiMocks = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
  setAutoUpdateEnabled: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}));

vi.mock("./api", () => apiMocks);

import { displayAppVersion, updateDownloadPercent, useAppUpdater } from "./useAppUpdater";

function session(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    clientIdentifier: "client-1",
    authenticated: false,
    credentialStatus: "missing",
    appVersion: "0.1.2",
    appUpdateSupported: true,
    autoUpdateEnabled: true,
    statusIconEnabled: true,
    closeBehavior: "panel",
    deviceName: "Test Mac",
    brandPreset: "amber",
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hookRuntime.reset();
  apiMocks.checkAppUpdate.mockReset();
  apiMocks.installAppUpdate.mockReset();
  apiMocks.setAutoUpdateEnabled.mockReset();
});

afterEach(() => hookRuntime.reset());

describe("app update presentation", () => {
  it("normalizes version labels and bounded download progress", () => {
    expect(displayAppVersion("0.2.0")).toBe("v0.2.0");
    expect(displayAppVersion("v0.2.0")).toBe("v0.2.0");
    expect(updateDownloadPercent(512, 1_024)).toBe(50);
    expect(updateDownloadPercent(2_048, 1_024)).toBe(100);
    expect(updateDownloadPercent(10, null)).toBeUndefined();
  });
});

describe("useAppUpdater", () => {
  it("never checks or changes updater preferences in a development build", async () => {
    const notify = vi.fn();
    let updater = hookRuntime.render(() => useAppUpdater(session({ appUpdateSupported: false }), notify));
    hookRuntime.flushEffects();
    await updater.checkForUpdate();
    await updater.changeAutoUpdateEnabled(false);
    updater = hookRuntime.render(() => useAppUpdater(session({ appUpdateSupported: false }), notify));

    expect(updater.supported).toBe(false);
    expect(apiMocks.checkAppUpdate).not.toHaveBeenCalled();
    expect(apiMocks.setAutoUpdateEnabled).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("automatically checks once and exposes an available release", async () => {
    const release = { version: "0.2.0", currentVersion: "0.1.2" };
    const notify = vi.fn();
    const currentSession = session();
    apiMocks.checkAppUpdate.mockResolvedValue(release);

    let updater = hookRuntime.render(() => useAppUpdater(currentSession, notify));
    hookRuntime.flushEffects();
    await settle();
    updater = hookRuntime.render(() => useAppUpdater(currentSession, notify));
    hookRuntime.flushEffects();

    expect(apiMocks.checkAppUpdate).toHaveBeenCalledTimes(1);
    expect(updater.availableUpdate).toEqual(release);
    expect(notify).toHaveBeenCalledWith("发现 Cadilume v0.2.0，可在设置中安装。", "info");
  });

  it("tracks download progress and persists the automatic check switch", async () => {
    const notify = vi.fn();
    const currentSession = session({ autoUpdateEnabled: false });
    const release = { version: "0.2.0", currentVersion: "0.1.2" };
    apiMocks.checkAppUpdate.mockResolvedValue(release);
    apiMocks.installAppUpdate.mockImplementation(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: "progress", downloaded: 768, contentLength: 1_024 });
      onEvent({ event: "downloaded" });
    });
    apiMocks.setAutoUpdateEnabled.mockResolvedValue(true);

    let updater = hookRuntime.render(() => useAppUpdater(currentSession, notify));
    hookRuntime.flushEffects();
    await updater.checkForUpdate();
    updater = hookRuntime.render(() => useAppUpdater(currentSession, notify));
    await updater.installUpdate();
    updater = hookRuntime.render(() => useAppUpdater(currentSession, notify));
    expect(updater.progressPercent).toBe(100);

    await updater.changeAutoUpdateEnabled(true);
    updater = hookRuntime.render(() => useAppUpdater(currentSession, notify));
    expect(apiMocks.setAutoUpdateEnabled).toHaveBeenCalledWith(true);
    expect(updater.autoUpdateEnabled).toBe(true);
  });
});

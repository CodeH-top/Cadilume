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
    useCallback<T>(callback: T, deps?: readonly unknown[]): T {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDependencies(existing.deps, deps)) {
        slots[index] = { value: callback, deps };
      }
      return slots[index].value as T;
    },
    useRef<T>(initial: T): { current: T } {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value as { current: T };
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
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}));

import { useGlobalNotificationQueue } from "./NotificationQueue";
import {
  GLOBAL_NOTIFICATION_AUTO_CLOSE_MS,
  GLOBAL_NOTIFICATION_EXIT_MS,
  GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS,
} from "./notifications";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const windowEventListeners = new Map<string, Set<() => void>>();

function installWindow(reducedMotion = false): void {
  windowEventListeners.clear();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
      addEventListener: (type: string, listener: () => void) => {
        const listeners = windowEventListeners.get(type) ?? new Set<() => void>();
        listeners.add(listener);
        windowEventListeners.set(type, listeners);
      },
      removeEventListener: (type: string, listener: () => void) => {
        windowEventListeners.get(type)?.delete(listener);
      },
      matchMedia: () => ({ matches: reducedMotion }),
      requestAnimationFrame: (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: globalThis.clearTimeout,
    },
  });
}

function dispatchWindowEvent(type: string): void {
  for (const listener of windowEventListeners.get(type) ?? []) listener();
}

function mountQueue() {
  let current = hookRuntime.render(useGlobalNotificationQueue);
  hookRuntime.flushEffects();

  return {
    get current() {
      return current;
    },
    render() {
      current = hookRuntime.render(useGlobalNotificationQueue);
      hookRuntime.flushEffects();
    },
  };
}

beforeEach(() => {
  hookRuntime.reset();
  vi.useFakeTimers();
  installWindow();
});

afterEach(() => {
  hookRuntime.reset();
  vi.useRealTimers();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("useGlobalNotificationQueue", () => {
  it("keeps independent notices and only removes the dismissed message after its exit presence", () => {
    const mounted = mountQueue();
    mounted.current.notify("第一条");
    mounted.current.notify("第二条");
    mounted.render();

    const [second, first] = mounted.current.notices;
    expect(mounted.current.notices.map((notice) => notice.message)).toEqual(["第二条", "第一条"]);

    mounted.current.dismiss(second.id);
    mounted.render();

    expect(mounted.current.notices.find((notice) => notice.id === first.id)?.phase).not.toBe("leaving");
    expect(mounted.current.notices.find((notice) => notice.id === second.id)?.phase).toBe("leaving");

    vi.advanceTimersByTime(GLOBAL_NOTIFICATION_EXIT_MS - 1);
    mounted.render();
    expect(mounted.current.notices).toHaveLength(2);

    vi.advanceTimersByTime(1);
    mounted.render();
    expect(mounted.current.notices).toHaveLength(1);
    expect(mounted.current.notices[0]?.id).toBe(first.id);
  });

  it("keeps its five-second timer running without hover/focus pause state", () => {
    const mounted = mountQueue();
    mounted.current.notify("自动关闭");
    mounted.render();

    vi.advanceTimersByTime(GLOBAL_NOTIFICATION_AUTO_CLOSE_MS - 1);
    mounted.render();
    expect(mounted.current.notices[0]?.phase).not.toBe("leaving");

    vi.advanceTimersByTime(1);
    mounted.render();
    expect(mounted.current.notices[0]?.phase).toBe("leaving");
  });

  it("drops the oldest notice as soon as the sixth notice arrives", () => {
    const mounted = mountQueue();
    for (let index = 1; index <= 6; index += 1) mounted.current.notify(`第 ${index} 条`);
    mounted.render();
    expect(mounted.current.notices).toHaveLength(5);
    expect(mounted.current.notices.map((notice) => notice.message)).not.toContain("第 1 条");
    expect(mounted.current.notices.map((notice) => notice.message)).toContain("第 6 条");
  });

  it("expires an overdue notice on focus even when its background timer was throttled", () => {
    const mounted = mountQueue();
    mounted.current.notify("后台自动关闭");
    mounted.render();

    vi.setSystemTime(Date.now() + GLOBAL_NOTIFICATION_AUTO_CLOSE_MS);
    dispatchWindowEvent("focus");
    mounted.render();

    expect(mounted.current.notices[0]?.phase).toBe("leaving");
  });

  it("keeps a short fade-out presence when reduced motion is enabled", () => {
    installWindow(true);
    const mounted = mountQueue();
    mounted.current.notify("减少动态效果");
    mounted.render();
    const id = mounted.current.notices[0]?.id;
    expect(id).toBeDefined();

    mounted.current.dismiss(id!);
    mounted.render();
    vi.advanceTimersByTime(GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS - 1);
    mounted.render();
    expect(mounted.current.notices[0]?.phase).toBe("leaving");

    vi.advanceTimersByTime(1);
    mounted.render();
    expect(mounted.current.notices).toHaveLength(0);
  });
});

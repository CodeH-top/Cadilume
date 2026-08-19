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

const apiMocks = vi.hoisted(() => ({
  cancelPin: vi.fn(),
  createPin: vi.fn(),
  openPlexLogin: vi.fn(),
  pollPin: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: hookRuntime.useEffect,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}));

vi.mock("./api", () => apiMocks);

import { usePlexLogin } from "./usePlexLogin";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function mountLogin(onAuthenticated: () => void | Promise<void>) {
  let current = hookRuntime.render(() => usePlexLogin("client-id", onAuthenticated));
  hookRuntime.flushEffects();

  return {
    get current() {
      return current;
    },
    render() {
      current = hookRuntime.render(() => usePlexLogin("client-id", onAuthenticated));
      hookRuntime.flushEffects();
    },
  };
}

beforeEach(() => {
  hookRuntime.reset();
  vi.useFakeTimers();
  apiMocks.cancelPin.mockReset();
  apiMocks.createPin.mockReset();
  apiMocks.openPlexLogin.mockReset();
  apiMocks.pollPin.mockReset();
});

afterEach(() => {
  hookRuntime.reset();
  vi.useRealTimers();
});

describe("usePlexLogin", () => {
  it("locks duplicate starts and stays busy while the authenticated session reloads", async () => {
    const sessionReload = deferred<void>();
    apiMocks.createPin.mockResolvedValue({ id: 7, code: "PRIVATE-PIN", expiresIn: 300, authenticated: false });
    apiMocks.openPlexLogin.mockResolvedValue(undefined);
    apiMocks.pollPin.mockResolvedValue({ id: 7, code: "PRIVATE-PIN", expiresIn: 300, authenticated: true });
    const onAuthenticated = vi.fn(() => sessionReload.promise);
    const mounted = mountLogin(onAuthenticated);

    expect(mounted.current).toMatchObject({ status: "idle", busy: false, buttonLabel: "使用 Plex 账号登录" });

    const attempt = mounted.current.start();
    await mounted.current.start();
    await settleAsyncWork();
    mounted.render();

    expect(apiMocks.createPin).toHaveBeenCalledTimes(1);
    expect(apiMocks.openPlexLogin).toHaveBeenCalledWith("client-id", "PRIVATE-PIN");
    expect(mounted.current).toMatchObject({ status: "waiting", busy: true, buttonLabel: "等待浏览器确认" });
    expect(mounted.current).not.toHaveProperty("code");
    expect(mounted.current.buttonLabel).not.toContain("PRIVATE-PIN");

    await vi.advanceTimersByTimeAsync(1500);
    await settleAsyncWork();
    mounted.render();

    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(mounted.current).toMatchObject({ status: "completing", busy: true, buttonLabel: "正在完成登录" });
    expect(mounted.current.buttonLabel).not.toContain("PRIVATE-PIN");

    await mounted.current.start();
    expect(apiMocks.createPin).toHaveBeenCalledTimes(1);

    let attemptFinished = false;
    void attempt.then(() => { attemptFinished = true; });
    await settleAsyncWork();
    expect(attemptFinished).toBe(false);

    sessionReload.resolve();
    await attempt;
    mounted.render();

    expect(mounted.current).toMatchObject({ status: "completing", busy: true, buttonLabel: "正在完成登录" });
  });

  it("re-enables login only when completing the authenticated session fails", async () => {
    apiMocks.createPin.mockResolvedValue({ id: 9, code: "HIDDEN-PIN", expiresIn: 300, authenticated: false });
    apiMocks.openPlexLogin.mockResolvedValue(undefined);
    apiMocks.pollPin.mockResolvedValue({ id: 9, code: "HIDDEN-PIN", expiresIn: 300, authenticated: true });
    const mounted = mountLogin(async () => { throw new Error("刷新认证状态失败"); });

    const attempt = mounted.current.start();
    await settleAsyncWork();
    await vi.advanceTimersByTimeAsync(1500);
    await attempt;
    mounted.render();

    expect(mounted.current).toMatchObject({
      status: "idle",
      busy: false,
      buttonLabel: "使用 Plex 账号登录",
      error: "刷新认证状态失败",
    });
  });

  it("cancels the active PIN and allows a fresh login attempt", async () => {
    apiMocks.createPin.mockResolvedValue({ id: 17, code: "CANCEL-ME", expiresIn: 300, authenticated: false });
    apiMocks.openPlexLogin.mockResolvedValue(undefined);
    apiMocks.pollPin.mockResolvedValue({ id: 17, code: "CANCEL-ME", expiresIn: 300, authenticated: false });
    apiMocks.cancelPin.mockResolvedValue(undefined);
    const mounted = mountLogin(vi.fn());

    const attempt = mounted.current.start();
    await settleAsyncWork();
    mounted.render();
    expect(mounted.current).toMatchObject({ status: "waiting", busy: true });

    await mounted.current.cancel();
    mounted.render();

    expect(apiMocks.cancelPin).toHaveBeenCalledWith(17);
    expect(mounted.current).toMatchObject({ status: "idle", busy: false });

    await vi.advanceTimersByTimeAsync(1500);
    await attempt;
    expect(apiMocks.pollPin).not.toHaveBeenCalled();

    apiMocks.createPin.mockResolvedValueOnce({ id: 18, code: "NEW-PIN", expiresIn: 300, authenticated: false });
    const freshAttempt = mounted.current.start();
    await settleAsyncWork();
    mounted.render();
    expect(apiMocks.createPin).toHaveBeenCalledTimes(2);
    expect(apiMocks.openPlexLogin).toHaveBeenLastCalledWith("client-id", "NEW-PIN");
    await mounted.current.cancel();
    await vi.advanceTimersByTimeAsync(1500);
    await freshAttempt;
  });

  it("invalidates a PIN even when cancellation happens before PIN creation finishes", async () => {
    const pin = deferred<{ id: number; code: string; expiresIn: number; authenticated: boolean }>();
    apiMocks.createPin.mockReturnValue(pin.promise);
    apiMocks.cancelPin.mockResolvedValue(undefined);
    const mounted = mountLogin(vi.fn());

    const attempt = mounted.current.start();
    await settleAsyncWork();
    await mounted.current.cancel();
    pin.resolve({ id: 23, code: "STALE-PIN", expiresIn: 300, authenticated: false });
    await attempt;

    expect(apiMocks.cancelPin).toHaveBeenCalledWith(23);
    expect(apiMocks.openPlexLogin).not.toHaveBeenCalled();
  });

  it("does not continue the login flow after unmount", async () => {
    const pin = deferred<{ id: number; code: string; expiresIn: number; authenticated: boolean }>();
    apiMocks.createPin.mockReturnValue(pin.promise);
    const mounted = mountLogin(vi.fn());

    const attempt = mounted.current.start();
    hookRuntime.reset();
    pin.resolve({ id: 11, code: "UNMOUNTED-PIN", expiresIn: 300, authenticated: false });
    await attempt;

    expect(apiMocks.openPlexLogin).not.toHaveBeenCalled();
    expect(apiMocks.pollPin).not.toHaveBeenCalled();
  });
});

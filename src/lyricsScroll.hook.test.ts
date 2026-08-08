import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LyricLine } from "./lyrics";

const hookRuntime = vi.hoisted(() => {
  type Cleanup = () => void;
  type LayoutEffect = () => void | Cleanup;
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    effect?: LayoutEffect;
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
    useLayoutEffect(effect: LayoutEffect, deps?: readonly unknown[]): void {
      const index = cursor++;
      const existing = slots[index];
      if (!existing || !sameDependencies(existing.deps, deps)) {
        slots[index] = { ...existing, deps, effect, pending: true };
      }
    },
    flushLayoutEffects(): void {
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
  useLayoutEffect: hookRuntime.useLayoutEffect,
  useRef: hookRuntime.useRef,
}));

import { useActiveLyricsScroll } from "./lyricsScroll";

function rectangle(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 320,
    height,
    top,
    right: 320,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  };
}

function timedLine(id: string, text = id): LyricLine {
  return { id, startMs: 1_000, endMs: 2_000, texts: [text] };
}

describe("active lyrics scroll ownership", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let list: HTMLDivElement;
  let scrollTo: Mock<(options: ScrollToOptions) => void>;

  beforeEach(() => {
    hookRuntime.reset();
    frames = new Map();
    nextFrameId = 1;
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });

    const fakeList = {
      scrollTop: 0,
      clientHeight: 200,
      scrollHeight: 1_000,
      getBoundingClientRect: () => rectangle(0, 200),
      scrollTo: (_options: ScrollToOptions): void => {},
    };
    scrollTo = vi.fn((options: ScrollToOptions) => {
      fakeList.scrollTop = options.top ?? fakeList.scrollTop;
    });
    fakeList.scrollTo = scrollTo;
    list = fakeList as unknown as HTMLDivElement;
  });

  afterEach(() => {
    hookRuntime.reset();
    vi.unstubAllGlobals();
  });

  const render = (activeLine: LyricLine, contentTop: number) => {
    const bindings = hookRuntime.render(() => useActiveLyricsScroll({
      trackIdentity: "track-a",
      timed: true,
      activeLine,
    }));
    bindings.listRef.current = list;
    bindings.setLineRef(activeLine.id, {
      getBoundingClientRect: () => rectangle(contentTop - list.scrollTop, 40),
    } as HTMLButtonElement);
    hookRuntime.flushLayoutEffects();
    return bindings;
  };

  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(16));
  };

  it("reclaims the opening lyrics immediately after a wheel scroll", () => {
    const firstBindings = render(timedLine("opening-1"), 20);
    flushFrames();
    scrollTo.mockClear();

    firstBindings.onWheel();
    list.scrollTop = 480;
    render(timedLine("opening-2"), 40);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(0);
  });

  it("does not consume manual ownership on a same-line rerender", () => {
    const bindings = render(timedLine("opening-1"), 20);
    flushFrames();
    scrollTo.mockClear();

    bindings.onWheel();
    list.scrollTop = 420;
    render(timedLine("opening-1"), 20);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(420);

    render(timedLine("opening-2"), 40);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(0);
  });

  it("keeps manual ownership through a clear frame", () => {
    const bindings = render(timedLine("opening-1"), 20);
    flushFrames();
    scrollTo.mockClear();

    bindings.onWheel();
    list.scrollTop = 360;
    render({ ...timedLine("clear"), clear: true, texts: [] }, 30);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(360);

    render(timedLine("opening-2"), 40);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(0);
  });
});

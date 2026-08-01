import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const componentRuntime = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
  }

  const slots: HookSlot[] = [];
  let cursor = 0;

  const sameDependencies = (left?: readonly unknown[], right?: readonly unknown[]) => (
    Boolean(left && right)
    && left!.length === right!.length
    && left!.every((value, index) => Object.is(value, right![index]))
  );

  const useDependencies = (value: unknown, deps?: readonly unknown[]) => {
    const index = cursor++;
    const existing = slots[index];
    if (!existing || !sameDependencies(existing.deps, deps)) slots[index] = { value, deps };
    return slots[index].value;
  };

  return {
    reset() {
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
    useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
      return useDependencies(factory(), deps) as T;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]): T {
      return useDependencies(callback, deps) as T;
    },
    useEffect(_effect: () => unknown, deps?: readonly unknown[]): void {
      useDependencies(undefined, deps);
    },
    useLayoutEffect(_effect: () => unknown, deps?: readonly unknown[]): void {
      useDependencies(undefined, deps);
    },
  };
});

vi.mock("react", () => ({
  useCallback: componentRuntime.useCallback,
  useEffect: componentRuntime.useEffect,
  useLayoutEffect: componentRuntime.useLayoutEffect,
  useMemo: componentRuntime.useMemo,
  useRef: componentRuntime.useRef,
  useState: componentRuntime.useState,
}));

import { GlobalNotificationQueue } from "./NotificationQueue";
import { createGlobalNotification } from "./notifications";

interface ElementNode {
  props: Record<string, unknown>;
}

function elementChildren(value: unknown): ElementNode[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((candidate): candidate is ElementNode => (
    Boolean(candidate) && typeof candidate === "object" && "props" in candidate
  ));
}

function findElement(root: ElementNode, predicate: (element: ElementNode) => boolean): ElementNode | undefined {
  if (predicate(root)) return root;
  for (const child of elementChildren(root.props.children)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function notifications() {
  return [
    createGlobalNotification("notice-1", "第一条", 100, 1),
    createGlobalNotification("notice-2", "第二条", 101, 2),
    createGlobalNotification("notice-3", "第三条", 102, 3),
  ].map((notice) => ({ ...notice, phase: "visible" as const }));
}

function listFrom(tree: ElementNode): ElementNode {
  const list = findElement(tree, (element) => String(element.props.className || "").startsWith("global-notification-list"));
  if (!list) throw new Error("通知列表未渲染");
  return list;
}

function closeButtonFrom(item: ElementNode): ElementNode {
  const button = findElement(item, (element) => element.props.className === "global-notification-close");
  if (!button) throw new Error("通知关闭按钮未渲染");
  return button;
}

beforeEach(() => componentRuntime.reset());
afterEach(() => componentRuntime.reset());

describe("GlobalNotificationQueue collapsed stack", () => {
  it("expands all notices for pointer hover and keeps collapsed previews out of the tab order", () => {
    const onDismiss = vi.fn();
    const onPauseChange = vi.fn();
    const state = notifications();
    const render = () => componentRuntime.render(() => GlobalNotificationQueue({ notices: state, onDismiss, onPauseChange })) as unknown as ElementNode;

    let tree = render();
    let list = listFrom(tree);
    let items = elementChildren(list.props.children);

    expect(tree.props["data-stacked"]).toBe(true);
    expect(list.props.tabIndex).toBe(0);
    expect(items).toHaveLength(3);
    expect(items[1]?.props["aria-hidden"]).toBe(true);
    expect(items[1]?.props.inert).toBe(true);
    expect(closeButtonFrom(items[1]!).props.tabIndex).toBe(-1);

    (list.props.onPointerEnter as () => void)();
    tree = render();
    list = listFrom(tree);
    items = elementChildren(list.props.children);

    expect(tree.props["data-expanded"]).toBe(true);
    expect(tree.props["data-stacked"]).toBeUndefined();
    expect(list.props.tabIndex).toBeUndefined();
    expect(items.every((item) => item.props["aria-hidden"] === undefined && item.props.inert === undefined)).toBe(true);
    expect(items.every((item) => closeButtonFrom(item).props.tabIndex === undefined)).toBe(true);

    (list.props.onPointerLeave as () => void)();
    tree = render();
    expect(tree.props["data-stacked"]).toBe(true);
  });

  it("expands the same stack when keyboard focus enters the list", () => {
    const state = notifications();
    const render = () => componentRuntime.render(() => GlobalNotificationQueue({ notices: state, onDismiss: vi.fn(), onPauseChange: vi.fn() })) as unknown as ElementNode;

    let tree = render();
    const list = listFrom(tree);
    (list.props.onFocusCapture as () => void)();

    tree = render();
    expect(tree.props["data-expanded"]).toBe(true);
    expect(tree.props["data-stacked"]).toBeUndefined();
  });
});

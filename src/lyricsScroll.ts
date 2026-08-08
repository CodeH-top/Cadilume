import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { LyricLine } from "./lyrics";

export interface LyricsScrollMetrics {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
  targetTop: number;
  targetHeight: number;
}

export interface LyricsScrollPlan {
  top: number;
  behavior: ScrollBehavior;
  consumeManualOverride: boolean;
}

interface LyricsScrollPlanInput extends LyricsScrollMetrics {
  activeLine?: LyricLine;
  manuallyScrolled: boolean;
  reducedMotion: boolean;
}

interface ActiveLyricsScrollOptions {
  trackIdentity: string;
  timed: boolean;
  activeLine?: LyricLine;
}

interface ActiveLyricsScrollBindings {
  listRef: RefObject<HTMLDivElement | null>;
  setLineRef: (lineId: string, node: HTMLButtonElement | null) => void;
  onWheel: () => void;
  onTouchMove: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

const LYRICS_SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

/**
 * Keep the active lyric centered whenever the scroll range allows it. Near
 * either edge, clamp to the available range instead of creating blank space.
 * `targetTop` is measured from the list's visible top edge.
 */
export function getCenteredLyricsScrollTop({
  scrollTop,
  viewportHeight,
  contentHeight,
  targetTop,
  targetHeight,
}: LyricsScrollMetrics): number {
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const content = Number.isFinite(contentHeight) ? Math.max(viewport, contentHeight) : viewport;
  const maximum = Math.max(0, content - viewport);
  const current = Number.isFinite(scrollTop) ? Math.min(maximum, Math.max(0, scrollTop)) : 0;
  const offset = Number.isFinite(targetTop) ? targetTop : 0;
  const height = Number.isFinite(targetHeight) ? Math.max(0, targetHeight) : 0;
  const targetCenterInContent = current + offset + height / 2;
  const centeredTop = targetCenterInContent - viewport / 2;
  return Math.min(maximum, Math.max(0, centeredTop));
}

export function getLyricsScrollPlan({
  activeLine,
  manuallyScrolled,
  reducedMotion,
  ...metrics
}: LyricsScrollPlanInput): LyricsScrollPlan | undefined {
  if (!activeLine || activeLine.clear || !activeLine.texts.some((text) => text.trim())) return undefined;
  return {
    top: getCenteredLyricsScrollTop(metrics),
    behavior: manuallyScrolled || reducedMotion ? "instant" : "smooth",
    consumeManualOverride: manuallyScrolled,
  };
}

function scrollLyricsList(list: HTMLDivElement, plan: LyricsScrollPlan): void {
  if (plan.behavior === "instant") {
    list.scrollTop = plan.top;
    return;
  }
  if (typeof list.scrollTo === "function") {
    list.scrollTo({ top: plan.top, behavior: plan.behavior });
  } else {
    list.scrollTop = plan.top;
  }
}

export function useActiveLyricsScroll({
  trackIdentity,
  timed,
  activeLine,
}: ActiveLyricsScrollOptions): ActiveLyricsScrollBindings {
  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const manuallyScrolledRef = useRef(false);
  const previousTrackIdentityRef = useRef(trackIdentity);

  const markManualScroll = useCallback(() => {
    manuallyScrolledRef.current = true;
  }, []);

  const setLineRef = useCallback((lineId: string, node: HTMLButtonElement | null) => {
    if (node) lineRefs.current[lineId] = node;
    else delete lineRefs.current[lineId];
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 0 && event.target === event.currentTarget) markManualScroll();
  }, [markManualScroll]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && LYRICS_SCROLL_KEYS.has(event.key)) markManualScroll();
  }, [markManualScroll]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (previousTrackIdentityRef.current !== trackIdentity) {
      previousTrackIdentityRef.current = trackIdentity;
      manuallyScrolledRef.current = false;
      scrollLyricsList(list, { top: 0, behavior: "instant", consumeManualOverride: false });
    }

    if (!timed) return;
    if (!activeLine || activeLine.clear || !activeLine.texts.some((text) => text.trim())) return;

    const manuallyScrolledAtChange = manuallyScrolledRef.current;
    const scrollToActiveLine = (forceInstant: boolean) => {
      const currentList = listRef.current;
      const node = lineRefs.current[activeLine.id];
      if (!currentList || !node) return;

      const listRect = currentList.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const manuallyScrolled = forceInstant || manuallyScrolledRef.current;
      const plan = getLyricsScrollPlan({
        activeLine,
        manuallyScrolled,
        reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
        scrollTop: currentList.scrollTop,
        viewportHeight: currentList.clientHeight,
        contentHeight: currentList.scrollHeight,
        targetTop: nodeRect.top - listRect.top,
        targetHeight: nodeRect.height,
      });
      if (!plan) return;

      if (Math.abs(plan.top - currentList.scrollTop) >= 0.5) scrollLyricsList(currentList, plan);
      if (plan.consumeManualOverride) manuallyScrolledRef.current = false;
    };

    // A manual override must be reclaimed immediately. The frame pass then
    // remeasures after the active-row styles have reached layout.
    if (manuallyScrolledAtChange) scrollToActiveLine(true);
    const frame = window.requestAnimationFrame(() => scrollToActiveLine(manuallyScrolledAtChange));
    return () => window.cancelAnimationFrame(frame);
  }, [activeLine?.clear, activeLine?.id, timed, trackIdentity]);

  return {
    listRef,
    setLineRef,
    onWheel: markManualScroll,
    onTouchMove: markManualScroll,
    onPointerDown,
    onKeyDown,
  };
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface TooltipState {
  text: string;
  left: number;
  top: number;
  visible: boolean;
}

const TOOLTIP_GAP = 8;
const TOOLTIP_SHOW_DELAY_MS = 60;
const TOOLTIP_MARGIN = 8;

/**
 * Global tooltip layer: reads `data-tooltip` from hovered/focused elements,
 * measures the rendered bubble and flips placement automatically so it is
 * never clipped by scroll containers or window edges.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<TooltipState>({ text: "", left: 0, top: 0, visible: false });
  const bubbleRef = useRef<HTMLDivElement>(null);
  const pendingTargetRef = useRef<HTMLElement | null>(null);
  const currentTargetRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    window.clearTimeout(showTimerRef.current);
    pendingTargetRef.current = null;
    setTip((current) => (current.visible ? { ...current, visible: false } : current));
    if (currentTargetRef.current) currentTargetRef.current = null;
  }, []);

  const show = useCallback((target: HTMLElement) => {
    const text = target.getAttribute("data-tooltip");
    if (!text) {
      hide();
      return;
    }
    window.clearTimeout(showTimerRef.current);
    showTimerRef.current = window.setTimeout(() => {
      if (!document.contains(target)) return;
      pendingTargetRef.current = target;
      setTip({ text, left: 0, top: 0, visible: false });
    }, TOOLTIP_SHOW_DELAY_MS);
  }, [hide]);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble || tip.visible) return;
    const target = pendingTargetRef.current;
    if (!target || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    let top = rect.top - height - TOOLTIP_GAP;
    if (top < TOOLTIP_MARGIN) top = rect.bottom + TOOLTIP_GAP;
    if (top + height > window.innerHeight - TOOLTIP_MARGIN) {
      top = Math.max(TOOLTIP_MARGIN, rect.top - height - TOOLTIP_GAP);
    }
    const left = Math.max(
      TOOLTIP_MARGIN,
      Math.min(window.innerWidth - width - TOOLTIP_MARGIN, rect.left + rect.width / 2 - width / 2),
    );
    setTip({ text: tip.text, left, top, visible: true });
  }, [tip.text, tip.visible]);

  useEffect(() => {
    const onMouseOver = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-tooltip]") ?? null;
      if (target === currentTargetRef.current) return;
      currentTargetRef.current = target;
      if (!target) {
        hide();
        return;
      }
      show(target);
    };
    const onMouseOut = (event: MouseEvent) => {
      const related = event.relatedTarget as Node | null;
      if (!related || !document.contains(related)) {
        // 光标瞬间移出窗口/文档：直接隐藏，避免残留。
        onHide();
        return;
      }
      const nextTarget = (related as Element).closest?.("[data-tooltip]") as HTMLElement | null;
      if (nextTarget === currentTargetRef.current) return;
      onHide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-tooltip]") ?? null;
      if (target && target !== currentTargetRef.current) {
        currentTargetRef.current = target;
        show(target);
      }
    };
    const onHide = () => {
      currentTargetRef.current = null;
      hide();
    };
    const onVisibilityChange = () => {
      if (document.hidden) hide();
    };
    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onHide);
    document.addEventListener("scroll", onHide, true);
    document.addEventListener("pointerleave", onHide);
    window.addEventListener("blur", onHide);
    window.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", onHide);
    return () => {
      window.clearTimeout(showTimerRef.current);
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onHide);
      document.removeEventListener("scroll", onHide, true);
      document.removeEventListener("pointerleave", onHide);
      window.removeEventListener("blur", onHide);
      window.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", onHide);
    };
  }, [hide, show]);

  if (!tip.text) return null;
  return (
    <div
      ref={bubbleRef}
      className="auto-tooltip"
      role="tooltip"
      style={{ left: tip.left, top: tip.top, visibility: tip.visible ? "visible" : "hidden", opacity: tip.visible ? 1 : 0 }}
    >
      {tip.text}
    </div>
  );
}

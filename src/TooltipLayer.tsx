import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface TooltipState {
  text: string;
  left: number;
  top: number;
  visible: boolean;
}

const TOOLTIP_GAP = 8;
const TOOLTIP_SHOW_DELAY_MS = 120;
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
  const showTimerRef = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    window.clearTimeout(showTimerRef.current);
    setTip((current) => (current.visible ? { ...current, visible: false } : current));
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
    const rect = target?.isConnected ? target.getBoundingClientRect() : undefined;
    if (!rect) {
      setTip((current) => (current.text ? { ...current, visible: true } : current));
      return;
    }
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
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-tooltip]");
      if (!target) {
        hide();
        return;
      }
      show(target);
    };
    const onMouseOut = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-tooltip]");
      const related = (event.relatedTarget as Element | null)?.closest<HTMLElement>("[data-tooltip]");
      if (target && target !== related) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-tooltip]");
      if (target) show(target);
    };
    const onHide = () => hide();
    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onHide);
    document.addEventListener("scroll", onHide, true);
    window.addEventListener("resize", onHide);
    return () => {
      window.clearTimeout(showTimerRef.current);
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onHide);
      document.removeEventListener("scroll", onHide, true);
      window.removeEventListener("resize", onHide);
    };
  }, [hide, show]);

  if (!tip.text) return null;
  return (
    <div
      ref={bubbleRef}
      className="auto-tooltip"
      role="tooltip"
      style={{ left: tip.left, top: tip.top, visibility: tip.visible ? "visible" : "hidden" }}
    >
      {tip.text}
    </div>
  );
}

import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import {
  GLOBAL_NOTIFICATION_EXIT_MS,
  GLOBAL_NOTIFICATION_MAX_COUNT,
  GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS,
  createGlobalNotification,
  isActiveGlobalNotification,
  markGlobalNotificationLeaving,
  orderedGlobalNotifications,
  remainingNotificationDuration,
  shouldStackGlobalNotifications,
  type GlobalNotification,
  type GlobalNotificationLevel,
} from "./notifications";

export interface GlobalNotificationQueueController {
  notices: GlobalNotification[];
  notify: (message: string, level?: GlobalNotificationLevel) => void;
  dismiss: (id: string) => void;
  clear: () => void;
  setPaused: (paused: boolean) => void;
}

function notificationExitDuration(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS
    : GLOBAL_NOTIFICATION_EXIT_MS;
}

/**
 * Keeps notification timing separate from the page that happened to raise the
 * message. A new route load can therefore never erase another operation's
 * feedback by replacing one shared string.
 */
export function useGlobalNotificationQueue(): GlobalNotificationQueueController {
  const [notices, setNotices] = useState<GlobalNotification[]>([]);
  const [paused, setPaused] = useState(false);
  const noticeSequenceRef = useRef(0);
  const noticesRef = useRef(notices);
  const autoCloseTimersRef = useRef(new Map<string, number>());
  const deadlinesRef = useRef(new Map<string, number>());
  const exitTimersRef = useRef(new Map<string, number>());
  const leavingNoticeIdsRef = useRef(new Set<string>());

  noticesRef.current = notices;

  const cancelAutoClose = useCallback((id: string) => {
    const timer = autoCloseTimersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    autoCloseTimersRef.current.delete(id);
    deadlinesRef.current.delete(id);
  }, []);

  const dismiss = useCallback((id: string) => {
    if (leavingNoticeIdsRef.current.has(id)) return;
    if (!noticesRef.current.some((notice) => notice.id === id && isActiveGlobalNotification(notice))) return;

    leavingNoticeIdsRef.current.add(id);
    cancelAutoClose(id);
    setNotices((current) => markGlobalNotificationLeaving(current, id));
    const exitTimer = window.setTimeout(() => {
      exitTimersRef.current.delete(id);
      leavingNoticeIdsRef.current.delete(id);
      setNotices((current) => current.filter((notice) => notice.id !== id));
    }, notificationExitDuration());
    exitTimersRef.current.set(id, exitTimer);
  }, [cancelAutoClose]);

  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  const notify = useCallback((message: string, level: GlobalNotificationLevel = "info") => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) return;
    const order = ++noticeSequenceRef.current;
    const createdAt = Date.now();
    setNotices((current) => {
      const next = [
        ...current,
        createGlobalNotification(`notice-${createdAt}-${order}`, normalizedMessage, level, createdAt, order),
      ];
      const active = next.filter(isActiveGlobalNotification);
      if (active.length <= GLOBAL_NOTIFICATION_MAX_COUNT) return next;
      // 超过上限时直接关闭最旧的一条，保持队列最多 5 条。
      const oldestId = active[0].id;
      return next.filter((notice) => notice.id !== oldestId);
    });
  }, []);

  const clear = useCallback(() => {
    for (const timer of autoCloseTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer);
    autoCloseTimersRef.current.clear();
    deadlinesRef.current.clear();
    exitTimersRef.current.clear();
    leavingNoticeIdsRef.current.clear();
    setPaused(false);
    setNotices([]);
  }, []);

  useEffect(() => {
    const frames = notices
      .filter((notice) => notice.phase === "entering")
      .map((notice) => window.requestAnimationFrame(() => {
        setNotices((current) => current.map((candidate) => (
          candidate.id === notice.id && candidate.phase === "entering"
            ? { ...candidate, phase: "visible" }
            : candidate
        )));
      }));
    return () => frames.forEach((frame) => window.cancelAnimationFrame(frame));
  }, [notices]);

  useEffect(() => {
    if (!paused) return;
    const now = Date.now();
    const remainingById = new Map<string, number>();
    for (const [id, timer] of autoCloseTimersRef.current) {
      window.clearTimeout(timer);
      const deadline = deadlinesRef.current.get(id);
      if (deadline !== undefined) remainingById.set(id, remainingNotificationDuration(deadline, now));
    }
    autoCloseTimersRef.current.clear();
    deadlinesRef.current.clear();
    if (!remainingById.size) return;
    setNotices((current) => current.map((notice) => {
      const remainingMs = remainingById.get(notice.id);
      return remainingMs === undefined ? notice : { ...notice, remainingMs };
    }));
  }, [paused]);

  useEffect(() => {
    const activeIds = new Set(notices.map((notice) => notice.id));
    for (const [id, timer] of autoCloseTimersRef.current) {
      if (activeIds.has(id)) continue;
      window.clearTimeout(timer);
      autoCloseTimersRef.current.delete(id);
      deadlinesRef.current.delete(id);
    }
    if (paused) return;

    for (const notice of notices) {
      if (!isActiveGlobalNotification(notice) || autoCloseTimersRef.current.has(notice.id)) continue;
      const delay = Math.max(0, notice.remainingMs);
      if (delay === 0) {
        dismissRef.current(notice.id);
        continue;
      }
      deadlinesRef.current.set(notice.id, Date.now() + delay);
      const timer = window.setTimeout(() => {
        autoCloseTimersRef.current.delete(notice.id);
        deadlinesRef.current.delete(notice.id);
        dismissRef.current(notice.id);
      }, delay);
      autoCloseTimersRef.current.set(notice.id, timer);
    }
  }, [notices, paused]);

  useEffect(() => () => {
    for (const timer of autoCloseTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  return { notices, notify, dismiss, clear, setPaused };
}

function stackLayer(index: number): string {
  if (index === 0) return "is-stack-front";
  if (index === 1) return "is-stack-back-one";
  if (index === 2) return "is-stack-back-two";
  return "is-hidden-in-stack";
}

function notificationIcon(level: GlobalNotificationLevel) {
  const icons = {
    info: Info,
    success: CircleCheck,
    warning: TriangleAlert,
    error: CircleX,
  } as const;
  const Icon = icons[level] ?? Info;
  return <Icon size={17} aria-hidden="true" />;
}

export function GlobalNotificationQueue({
  notices,
  onDismiss,
  onPauseChange,
}: {
  notices: readonly GlobalNotification[];
  onDismiss: (id: string) => void;
  onPauseChange: (paused: boolean) => void;
}) {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [frontHeight, setFrontHeight] = useState(56);
  const listRef = useRef<HTMLUListElement>(null);
  const frontItemRef = useRef<HTMLLIElement>(null);
  const positionsRef = useRef(new Map<string, number>());
  const flipFramesRef = useRef(new Map<HTMLElement, number>());
  const orderedNotices = useMemo(() => orderedGlobalNotifications(notices), [notices]);
  const paused = pointerInside || focusInside;
  const stacked = !paused && shouldStackGlobalNotifications(orderedNotices);
  const frontNotice = orderedNotices[0];

  useEffect(() => {
    if (orderedNotices.length) return;
    setPointerInside(false);
    setFocusInside(false);
  }, [orderedNotices.length]);

  useEffect(() => {
    onPauseChange(paused);
  }, [onPauseChange, paused]);

  useEffect(() => () => onPauseChange(false), [onPauseChange]);

  useEffect(() => {
    if (!focusInside || listRef.current?.contains(document.activeElement)) return;
    setFocusInside(false);
  }, [focusInside, orderedNotices]);

  useLayoutEffect(() => {
    const item = frontItemRef.current;
    if (!item) return;
    const updateHeight = () => {
      const nextHeight = Math.max(56, Math.ceil(item.getBoundingClientRect().height));
      setFrontHeight((current) => current === nextHeight ? current : nextHeight);
      const card = item.querySelector<HTMLElement>(".global-notification-card");
      if (card && listRef.current) {
        listRef.current.style.setProperty(
          "--global-notification-stack-width",
          `${Math.ceil(card.getBoundingClientRect().width)}px`,
        );
      }
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(item);
    return () => observer.disconnect();
  }, [frontNotice?.id]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    for (const [element, frame] of flipFramesRef.current) {
      window.cancelAnimationFrame(frame);
      element.style.transition = "";
      element.style.transform = "";
    }
    flipFramesRef.current.clear();

    const nextPositions = new Map<string, number>();
    const items = Array.from(list.querySelectorAll<HTMLElement>("[data-notification-id]"));
    for (const item of items) {
      const id = item.dataset.notificationId;
      if (!id) continue;
      const top = item.getBoundingClientRect().top;
      nextPositions.set(id, top);
      const previousTop = positionsRef.current.get(id);
      const motion = item.querySelector<HTMLElement>("[data-notification-motion]");
      if (previousTop === undefined || !motion) continue;
      const delta = previousTop - top;
      if (Math.abs(delta) < 1) continue;
      motion.style.transition = "none";
      motion.style.transform = `translateY(${delta}px)`;
      const frame = window.requestAnimationFrame(() => {
        motion.style.transition = "";
        motion.style.transform = "";
        flipFramesRef.current.delete(motion);
      });
      flipFramesRef.current.set(motion, frame);
    }
    positionsRef.current = nextPositions;
  }, [orderedNotices, stacked]);

  useEffect(() => () => {
    for (const [element, frame] of flipFramesRef.current) {
      window.cancelAnimationFrame(frame);
      element.style.transition = "";
      element.style.transform = "";
    }
  }, []);

  if (!orderedNotices.length) return null;

  const handleBlur = (event: FocusEvent<HTMLUListElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setFocusInside(false);
  };

  return (
    <section
      className="global-notification-queue"
      aria-label="通知"
      data-testid="global-notification-queue"
      data-stacked={stacked || undefined}
      data-expanded={paused || undefined}
    >
      <ul
        ref={listRef}
        className={`global-notification-list${stacked ? " is-stacked" : ""}`}
        style={{ "--global-notification-stack-height": `${frontHeight}px` } as CSSProperties}
        tabIndex={stacked ? 0 : undefined}
        aria-label={stacked ? "通知堆叠，按 Tab 展开全部通知" : undefined}
        onPointerEnter={() => setPointerInside(true)}
        onPointerLeave={() => setPointerInside(false)}
        onFocusCapture={() => setFocusInside(true)}
        onBlurCapture={handleBlur}
      >
        {orderedNotices.map((notice, index) => {
          const hiddenInStack = stacked && index > 0;
          const announce = index === 0 && notice.phase === "entering";
          return (
            <li
              ref={index === 0 ? frontItemRef : undefined}
              className={`global-notification-item ${stackLayer(index)} is-${notice.phase}`}
              data-notification-id={notice.id}
              data-notification-phase={notice.phase}
              data-notification-index={index}
              aria-hidden={hiddenInStack || undefined}
              inert={hiddenInStack || undefined}
              key={notice.id}
            >
              <div className="global-notification-motion" data-notification-motion>
                <article
                  className={`global-notification-card is-${notice.level}`}
                  role={announce ? "status" : undefined}
                  aria-live={announce ? "polite" : undefined}
                  aria-atomic={announce || undefined}
                >
                  <span className={`global-notification-icon is-${notice.level}`} aria-hidden="true">
                    {notificationIcon(notice.level)}
                  </span>
                  <span className="global-notification-message">{notice.message}</span>
                  <button
                    className="global-notification-close"
                    type="button"
                    aria-label={`关闭提示：${notice.message}`}
                    tabIndex={hiddenInStack ? -1 : undefined}
                    onClick={() => onDismiss(notice.id)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </article>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

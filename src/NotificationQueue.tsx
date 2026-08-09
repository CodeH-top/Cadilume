import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GLOBAL_NOTIFICATION_AUTO_CLOSE_MS,
  GLOBAL_NOTIFICATION_EXIT_MS,
  GLOBAL_NOTIFICATION_MAX_COUNT,
  GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS,
  createGlobalNotification,
  isActiveGlobalNotification,
  limitGlobalNotifications,
  markGlobalNotificationLeaving,
  orderedGlobalNotifications,
  type GlobalNotification,
  type GlobalNotificationLevel,
} from "./notifications";

export interface GlobalNotificationQueueController {
  notices: GlobalNotification[];
  notify: (message: string, level?: GlobalNotificationLevel) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

function notificationExitDuration(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS
    : GLOBAL_NOTIFICATION_EXIT_MS;
}

/** A bounded, non-pausing queue. Timers are owned by the queue, not the view. */
export function useGlobalNotificationQueue(): GlobalNotificationQueueController {
  const [notices, setNotices] = useState<GlobalNotification[]>([]);
  const noticeSequenceRef = useRef(0);
  const noticesRef = useRef(notices);
  const autoCloseTimersRef = useRef(new Map<string, number>());
  const deadlinesRef = useRef(new Map<string, number>());
  const exitTimersRef = useRef(new Map<string, number>());
  const leavingNoticeIdsRef = useRef(new Set<string>());

  noticesRef.current = notices;

  const dismiss = useCallback((id: string) => {
    if (leavingNoticeIdsRef.current.has(id)) return;
    const target = noticesRef.current.find((notice) => notice.id === id && isActiveGlobalNotification(notice));
    if (!target) return;

    const autoCloseTimer = autoCloseTimersRef.current.get(id);
    if (autoCloseTimer !== undefined) window.clearTimeout(autoCloseTimer);
    autoCloseTimersRef.current.delete(id);
    deadlinesRef.current.delete(id);
    leavingNoticeIdsRef.current.add(id);
    setNotices((current) => markGlobalNotificationLeaving(current, id));

    const exitTimer = window.setTimeout(() => {
      exitTimersRef.current.delete(id);
      leavingNoticeIdsRef.current.delete(id);
      setNotices((current) => current.filter((notice) => notice.id !== id));
    }, notificationExitDuration());
    exitTimersRef.current.set(id, exitTimer);
  }, []);

  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  const notify = useCallback((message: string, level: GlobalNotificationLevel = "info") => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) return;
    const order = ++noticeSequenceRef.current;
    const createdAt = Date.now();
    const next = createGlobalNotification(`notice-${createdAt}-${order}`, normalizedMessage, level, createdAt, order);
    setNotices((current) => {
      const candidates = [...current, next];
      const limited = limitGlobalNotifications(candidates);
      if (candidates.length <= GLOBAL_NOTIFICATION_MAX_COUNT) return limited;
      return limited.map((notice) => (
        notice.phase === "entering"
          ? { ...notice, skipEnterAnimation: true }
          : notice
      ));
    });
  }, []);

  const clear = useCallback(() => {
    for (const timer of autoCloseTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer);
    autoCloseTimersRef.current.clear();
    deadlinesRef.current.clear();
    exitTimersRef.current.clear();
    leavingNoticeIdsRef.current.clear();
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
    const activeIds = new Set(notices.filter(isActiveGlobalNotification).map((notice) => notice.id));
    for (const [id, timer] of autoCloseTimersRef.current) {
      if (activeIds.has(id)) continue;
      window.clearTimeout(timer);
      autoCloseTimersRef.current.delete(id);
      deadlinesRef.current.delete(id);
    }

    for (const notice of notices) {
      if (!isActiveGlobalNotification(notice) || autoCloseTimersRef.current.has(notice.id)) continue;
      const deadline = Date.now() + GLOBAL_NOTIFICATION_AUTO_CLOSE_MS;
      deadlinesRef.current.set(notice.id, deadline);
      const timer = window.setTimeout(() => {
        autoCloseTimersRef.current.delete(notice.id);
        deadlinesRef.current.delete(notice.id);
        dismissRef.current(notice.id);
      }, GLOBAL_NOTIFICATION_AUTO_CLOSE_MS);
      autoCloseTimersRef.current.set(notice.id, timer);
    }
  }, [notices]);

  useEffect(() => {
    const expireOverdue = () => {
      const now = Date.now();
      for (const notice of noticesRef.current) {
        if (!isActiveGlobalNotification(notice)) continue;
        const deadline = deadlinesRef.current.get(notice.id);
        if (deadline !== undefined && deadline <= now) dismissRef.current(notice.id);
      }
    };
    const visibilityTarget = typeof document === "undefined" ? undefined : document;
    visibilityTarget?.addEventListener("visibilitychange", expireOverdue);
    window.addEventListener("focus", expireOverdue);
    return () => {
      visibilityTarget?.removeEventListener("visibilitychange", expireOverdue);
      window.removeEventListener("focus", expireOverdue);
    };
  }, []);

  useEffect(() => () => {
    for (const timer of autoCloseTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of exitTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  return { notices, notify, dismiss, clear };
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
}: {
  notices: readonly GlobalNotification[];
  onDismiss: (id: string) => void;
}) {
  const orderedNotices = orderedGlobalNotifications(notices).slice(0, GLOBAL_NOTIFICATION_MAX_COUNT);
  if (!orderedNotices.length) return null;

  return (
    <section className="global-notification-queue" aria-label="通知" data-testid="global-notification-queue">
      <ul className="global-notification-list">
        {orderedNotices.map((notice, index) => {
          const announce = index === 0 && notice.phase === "entering";
          const enterMotionClass = notice.phase === "entering" && notice.skipEnterAnimation
            ? " is-entering-without-motion"
            : "";
          return (
            <li
              className={`global-notification-item is-${notice.phase}${enterMotionClass}`}
              data-notification-id={notice.id}
              data-notification-phase={notice.phase}
              data-notification-index={index}
              key={notice.id}
            >
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
                <button className="global-notification-close" type="button" aria-label={`关闭提示：${notice.message}`} onClick={() => onDismiss(notice.id)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

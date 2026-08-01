export const GLOBAL_NOTIFICATION_AUTO_CLOSE_MS = 4_200;
export const GLOBAL_NOTIFICATION_EXIT_MS = 220;
export const GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS = 120;
export const GLOBAL_NOTIFICATION_STACK_THRESHOLD = 3;
export const GLOBAL_NOTIFICATION_VISIBLE_STACK_LAYERS = 3;

export type GlobalNotificationPhase = "entering" | "visible" | "leaving";

export interface GlobalNotification {
  id: string;
  message: string;
  createdAt: number;
  order: number;
  remainingMs: number;
  phase: GlobalNotificationPhase;
}

export function createGlobalNotification(
  id: string,
  message: string,
  createdAt: number,
  order: number,
): GlobalNotification {
  return {
    id,
    message,
    createdAt,
    order,
    remainingMs: GLOBAL_NOTIFICATION_AUTO_CLOSE_MS,
    phase: "entering",
  };
}

export function orderedGlobalNotifications(notifications: readonly GlobalNotification[]): GlobalNotification[] {
  return [...notifications].sort((left, right) => right.order - left.order || right.createdAt - left.createdAt);
}

export function isActiveGlobalNotification(notification: GlobalNotification): boolean {
  return notification.phase !== "leaving";
}

export function shouldStackGlobalNotifications(notifications: readonly GlobalNotification[]): boolean {
  return notifications.filter(isActiveGlobalNotification).length >= GLOBAL_NOTIFICATION_STACK_THRESHOLD;
}

export function markGlobalNotificationLeaving(
  notifications: readonly GlobalNotification[],
  id: string,
): GlobalNotification[] {
  return notifications.map((notification) => (
    notification.id === id && notification.phase !== "leaving"
      ? { ...notification, phase: "leaving" }
      : notification
  ));
}

export function remainingNotificationDuration(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

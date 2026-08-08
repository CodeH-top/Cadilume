export const GLOBAL_NOTIFICATION_AUTO_CLOSE_MS = 5_000;
export const GLOBAL_NOTIFICATION_EXIT_MS = 220;
export const GLOBAL_NOTIFICATION_REDUCED_MOTION_EXIT_MS = 120;
export const GLOBAL_NOTIFICATION_MAX_COUNT = 5;

export type GlobalNotificationPhase = "entering" | "visible" | "leaving";
export type GlobalNotificationLevel = "info" | "success" | "warning" | "error";

export interface GlobalNotification {
  id: string;
  message: string;
  level: GlobalNotificationLevel;
  createdAt: number;
  order: number;
  phase: GlobalNotificationPhase;
}

export function createGlobalNotification(
  id: string,
  message: string,
  level: GlobalNotificationLevel,
  createdAt: number,
  order: number,
): GlobalNotification {
  return {
    id,
    message,
    level,
    createdAt,
    order,
    phase: "entering",
  };
}

export function orderedGlobalNotifications(notifications: readonly GlobalNotification[]): GlobalNotification[] {
  return [...notifications].sort((left, right) => right.order - left.order || right.createdAt - left.createdAt);
}

export function isActiveGlobalNotification(notification: GlobalNotification): boolean {
  return notification.phase !== "leaving";
}

/** Keep the render list bounded, including a short leaving presence. */
export function limitGlobalNotifications(notifications: readonly GlobalNotification[]): GlobalNotification[] {
  return [...notifications]
    .sort((left, right) => right.order - left.order || right.createdAt - left.createdAt)
    .slice(0, GLOBAL_NOTIFICATION_MAX_COUNT);
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

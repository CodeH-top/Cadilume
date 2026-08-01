import { describe, expect, it } from "vitest";
import {
  GLOBAL_NOTIFICATION_AUTO_CLOSE_MS,
  createGlobalNotification,
  markGlobalNotificationLeaving,
  orderedGlobalNotifications,
  remainingNotificationDuration,
  shouldStackGlobalNotifications,
} from "./notifications";

describe("global notification queue state", () => {
  it("keeps every message and orders simultaneous additions by insertion order", () => {
    const first = createGlobalNotification("notice-1", "第一条", 100, 1);
    const second = createGlobalNotification("notice-2", "第二条", 100, 2);
    const third = createGlobalNotification("notice-3", "第三条", 100, 3);

    expect(orderedGlobalNotifications([first, second, third]).map((notice) => notice.message)).toEqual([
      "第三条",
      "第二条",
      "第一条",
    ]);
    expect(third.remainingMs).toBe(GLOBAL_NOTIFICATION_AUTO_CLOSE_MS);
  });

  it("enters the collapsed stack at three active messages without discarding older entries", () => {
    const notices = [
      createGlobalNotification("notice-1", "第一条", 100, 1),
      createGlobalNotification("notice-2", "第二条", 101, 2),
      createGlobalNotification("notice-3", "第三条", 102, 3),
      createGlobalNotification("notice-4", "第四条", 103, 4),
    ];

    expect(shouldStackGlobalNotifications(notices.slice(0, 2))).toBe(false);
    expect(shouldStackGlobalNotifications(notices)).toBe(true);
    expect(notices).toHaveLength(4);
  });

  it("only marks the requested notification as leaving", () => {
    const first = createGlobalNotification("notice-1", "第一条", 100, 1);
    const second = createGlobalNotification("notice-2", "第二条", 101, 2);
    const next = markGlobalNotificationLeaving([first, second], first.id);

    expect(next[0].phase).toBe("leaving");
    expect(next[1]).toEqual(second);
  });

  it("preserves the unexpired portion of an auto-close timer while paused", () => {
    expect(remainingNotificationDuration(4_200, 1_000)).toBe(3_200);
    expect(remainingNotificationDuration(1_000, 1_200)).toBe(0);
  });
});

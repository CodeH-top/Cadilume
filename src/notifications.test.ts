import { describe, expect, it } from "vitest";
import {
  GLOBAL_NOTIFICATION_AUTO_CLOSE_MS,
  createGlobalNotification,
  limitGlobalNotifications,
  markGlobalNotificationLeaving,
  orderedGlobalNotifications,
} from "./notifications";

describe("global notification queue state", () => {
  it("auto-closes notices after two seconds", () => {
    expect(GLOBAL_NOTIFICATION_AUTO_CLOSE_MS).toBe(2_000);
  });

  it("keeps every message and orders simultaneous additions by insertion order", () => {
    const first = createGlobalNotification("notice-1", "第一条", "info", 100, 1);
    const second = createGlobalNotification("notice-2", "第二条", "info", 100, 2);
    const third = createGlobalNotification("notice-3", "第三条", "info", 100, 3);

    expect(orderedGlobalNotifications([first, second, third]).map((notice) => notice.message)).toEqual([
      "第三条",
      "第二条",
      "第一条",
    ]);
  });

  it("keeps at most five notices and removes the oldest when a sixth arrives", () => {
    const notices = [
      createGlobalNotification("notice-1", "第一条", "info", 100, 1),
      createGlobalNotification("notice-2", "第二条", "info", 101, 2),
      createGlobalNotification("notice-3", "第三条", "info", 102, 3),
      createGlobalNotification("notice-4", "第四条", "info", 103, 4),
    ];

    const limited = limitGlobalNotifications(notices);
    expect(limited).toHaveLength(4);
    const six = createGlobalNotification("notice-5", "第五条", "info", 104, 5);
    const seven = createGlobalNotification("notice-6", "第六条", "info", 105, 6);
    expect(limitGlobalNotifications([...notices, six, seven]).map((notice) => notice.message)).toEqual([
      "第六条", "第五条", "第四条", "第三条", "第二条",
    ]);
  });

  it("only marks the requested notification as leaving", () => {
    const first = createGlobalNotification("notice-1", "第一条", "info", 100, 1);
    const second = createGlobalNotification("notice-2", "第二条", "info", 101, 2);
    const next = markGlobalNotificationLeaving([first, second], first.id);

    expect(next[0].phase).toBe("leaving");
    expect(next[1]).toEqual(second);
  });

});

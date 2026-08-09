import { describe, expect, it } from "vitest";
import { calculatePopconfirmLayout } from "./popconfirmPosition";

describe("calculatePopconfirmLayout", () => {
  it("keeps the arrow centered over an unconstrained trigger", () => {
    expect(calculatePopconfirmLayout(
      { left: 480, top: 300, width: 28, bottom: 328 },
      { width: 300, height: 120 },
      { width: 1280, height: 820 },
    )).toEqual({
      left: 344,
      top: 172,
      arrowLeft: 150,
      placement: "above",
    });
  });

  it("moves the arrow toward a right-edge trigger when the popover is clamped", () => {
    const layout = calculatePopconfirmLayout(
      { left: 1180, top: 300, width: 28, bottom: 328 },
      { width: 340, height: 120 },
      { width: 1280, height: 820 },
    );

    expect(layout.left).toBe(932);
    expect(layout.arrowLeft).toBe(262);
    expect(layout.arrowLeft).not.toBe(170);
    expect(layout.left + layout.arrowLeft).toBe(1194);
  });

  it("places the popover below when there is no room above", () => {
    expect(calculatePopconfirmLayout(
      { left: 16, top: 20, width: 28, bottom: 48 },
      { width: 232, height: 100 },
      { width: 960, height: 640 },
    )).toMatchObject({
      left: 8,
      top: 56,
      arrowLeft: 22,
      placement: "below",
    });
  });
});

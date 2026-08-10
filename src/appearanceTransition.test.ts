import { describe, expect, it } from "vitest";
import { getCenteredImageDrawPlan, shouldAnimateAppearanceReveal } from "./appearanceTransition";

describe("appearance transition policy", () => {
  it("uses the expensive reveal only for an idle, motion-enabled app", () => {
    expect(shouldAnimateAppearanceReveal(true, false, false)).toBe(true);
    expect(shouldAnimateAppearanceReveal(false, false, false)).toBe(false);
    expect(shouldAnimateAppearanceReveal(true, true, false)).toBe(false);
    expect(shouldAnimateAppearanceReveal(true, false, true)).toBe(false);
  });
});

describe("appearance transition artwork rasterization", () => {
  it("center-crops a wide image for object-fit cover", () => {
    expect(getCenteredImageDrawPlan(400, 200, 100, 100, "cover")).toEqual({
      sourceX: 100,
      sourceY: 0,
      sourceWidth: 200,
      sourceHeight: 200,
      destinationX: 0,
      destinationY: 0,
      destinationWidth: 100,
      destinationHeight: 100,
    });
  });

  it("letterboxes a wide image for object-fit contain", () => {
    expect(getCenteredImageDrawPlan(400, 200, 100, 100, "contain")).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 400,
      sourceHeight: 200,
      destinationX: 0,
      destinationY: 25,
      destinationWidth: 100,
      destinationHeight: 50,
    });
  });

  it("keeps scale-down images at their intrinsic size when they already fit", () => {
    expect(getCenteredImageDrawPlan(40, 20, 100, 100, "scale-down")).toMatchObject({
      destinationX: 30,
      destinationY: 40,
      destinationWidth: 40,
      destinationHeight: 20,
    });
  });

  it("rejects invalid geometry instead of drawing a corrupt snapshot", () => {
    expect(getCenteredImageDrawPlan(0, 200, 100, 100, "cover")).toBeUndefined();
    expect(getCenteredImageDrawPlan(200, 200, Number.NaN, 100, "cover")).toBeUndefined();
  });
});

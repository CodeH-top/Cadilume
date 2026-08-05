import { describe, expect, it } from "vitest";
import { ROUTE_BACK_TO_TOP_MIN_SCROLL, routeScrollBehavior, shouldShowRouteBackToTop } from "./routeScroll";

describe("route-local back-to-top state", () => {
  it("requires both the fixed and one-viewport scroll thresholds", () => {
    expect(shouldShowRouteBackToTop(ROUTE_BACK_TO_TOP_MIN_SCROLL - 1, 180)).toBe(false);
    expect(shouldShowRouteBackToTop(ROUTE_BACK_TO_TOP_MIN_SCROLL, 180)).toBe(true);
    expect(shouldShowRouteBackToTop(420, 520)).toBe(false);
    expect(shouldShowRouteBackToTop(520, 520)).toBe(true);
  });

  it("uses an immediate route-local jump for reduced motion", () => {
    expect(routeScrollBehavior(false)).toBe("smooth");
    expect(routeScrollBehavior(true)).toBe("auto");
  });
});

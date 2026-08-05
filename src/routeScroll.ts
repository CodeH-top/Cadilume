export const ROUTE_BACK_TO_TOP_MIN_SCROLL = 240;

/** Show the route-local return button only after both the fixed and viewport thresholds. */
export function shouldShowRouteBackToTop(scrollTop: number, viewportHeight: number): boolean {
  const normalizedScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const normalizedViewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  return normalizedScrollTop >= Math.max(ROUTE_BACK_TO_TOP_MIN_SCROLL, normalizedViewport);
}

export function routeScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

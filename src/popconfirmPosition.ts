export interface PopconfirmAnchorRect {
  left: number;
  top: number;
  width: number;
  bottom: number;
}

export interface PopconfirmLayout {
  left: number;
  top: number;
  arrowLeft: number;
  placement: "above" | "below";
}

const VIEWPORT_PADDING = 8;
const ANCHOR_GAP = 8;
const ARROW_EDGE_INSET = 16;

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.max(minimum, Math.min(maximum, value))
);

export function calculatePopconfirmLayout(
  anchor: PopconfirmAnchorRect,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
): PopconfirmLayout {
  const anchorCenter = anchor.left + anchor.width / 2;
  const maximumLeft = Math.max(VIEWPORT_PADDING, viewport.width - popover.width - VIEWPORT_PADDING);
  const left = clamp(
    anchorCenter - popover.width / 2,
    VIEWPORT_PADDING,
    maximumLeft,
  );
  const aboveTop = anchor.top - popover.height - ANCHOR_GAP;
  const placement = aboveTop >= VIEWPORT_PADDING ? "above" : "below";
  const requestedTop = placement === "above" ? aboveTop : anchor.bottom + ANCHOR_GAP;
  const maximumTop = Math.max(VIEWPORT_PADDING, viewport.height - popover.height - VIEWPORT_PADDING);
  const top = clamp(requestedTop, VIEWPORT_PADDING, maximumTop);
  const maximumArrowLeft = Math.max(ARROW_EDGE_INSET, popover.width - ARROW_EDGE_INSET);
  const arrowLeft = clamp(anchorCenter - left, ARROW_EDGE_INSET, maximumArrowLeft);

  return { left, top, arrowLeft, placement };
}

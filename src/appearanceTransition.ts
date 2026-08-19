export interface ImageDrawPlan {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  destinationX: number;
  destinationY: number;
  destinationWidth: number;
  destinationHeight: number;
}

export function shouldAnimateAppearanceReveal(
  hasOrigin: boolean,
  reducedMotion: boolean,
  playbackActive: boolean,
  allowDuringPlayback = false,
): boolean {
  return hasOrigin && !reducedMotion && (!playbackActive || allowDuringPlayback);
}

function centeredDestination(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
  scale: number,
): ImageDrawPlan {
  const destinationWidth = sourceWidth * scale;
  const destinationHeight = sourceHeight * scale;
  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    destinationX: (boxWidth - destinationWidth) / 2,
    destinationY: (boxHeight - destinationHeight) / 2,
    destinationWidth,
    destinationHeight,
  };
}

/**
 * Reproduce the app's centered CSS object-fit modes when copying an already
 * decoded image into a transition canvas.
 */
export function getCenteredImageDrawPlan(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
  objectFit: string,
): ImageDrawPlan | undefined {
  if (![sourceWidth, sourceHeight, boxWidth, boxHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return undefined;
  }

  if (objectFit === "contain") {
    return centeredDestination(sourceWidth, sourceHeight, boxWidth, boxHeight, Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight));
  }
  if (objectFit === "none") {
    return centeredDestination(sourceWidth, sourceHeight, boxWidth, boxHeight, 1);
  }
  if (objectFit === "scale-down" && sourceWidth <= boxWidth && sourceHeight <= boxHeight) {
    return centeredDestination(sourceWidth, sourceHeight, boxWidth, boxHeight, 1);
  }
  if (objectFit === "scale-down") {
    return centeredDestination(sourceWidth, sourceHeight, boxWidth, boxHeight, Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight));
  }
  if (objectFit !== "cover") {
    return {
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
      destinationX: 0,
      destinationY: 0,
      destinationWidth: boxWidth,
      destinationHeight: boxHeight,
    };
  }

  const sourceAspectRatio = sourceWidth / sourceHeight;
  const boxAspectRatio = boxWidth / boxHeight;
  if (sourceAspectRatio > boxAspectRatio) {
    const visibleSourceWidth = sourceHeight * boxAspectRatio;
    return {
      sourceX: (sourceWidth - visibleSourceWidth) / 2,
      sourceY: 0,
      sourceWidth: visibleSourceWidth,
      sourceHeight,
      destinationX: 0,
      destinationY: 0,
      destinationWidth: boxWidth,
      destinationHeight: boxHeight,
    };
  }

  const visibleSourceHeight = sourceWidth / boxAspectRatio;
  return {
    sourceX: 0,
    sourceY: (sourceHeight - visibleSourceHeight) / 2,
    sourceWidth,
    sourceHeight: visibleSourceHeight,
    destinationX: 0,
    destinationY: 0,
    destinationWidth: boxWidth,
    destinationHeight: boxHeight,
  };
}

/**
 * A cloned <img> can issue another request even when its live counterpart is
 * already decoded. Cadilume artwork responses are deliberately `no-store`, so
 * transition snapshots copy decoded pixels instead of cloning media requests.
 */
export function rasterizeAppearanceSnapshotImages(
  sourceRoot: HTMLElement,
  snapshotRoot: HTMLElement,
  pixelRatio = window.devicePixelRatio || 1,
): number {
  const sourceImages = Array.from(sourceRoot.querySelectorAll<HTMLImageElement>("img"));
  const snapshotImages = Array.from(snapshotRoot.querySelectorAll<HTMLImageElement>("img"));
  const count = Math.min(sourceImages.length, snapshotImages.length);
  const safePixelRatio = Math.min(2, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1));

  for (let index = 0; index < count; index += 1) {
    const source = sourceImages[index];
    const copy = snapshotImages[index];
    const style = window.getComputedStyle(source);
    const bounds = source.getBoundingClientRect();
    const visible = style.display !== "none"
      && style.visibility !== "hidden"
      && Number.parseFloat(style.opacity) > 0
      && bounds.bottom > 0
      && bounds.right > 0
      && bounds.top < window.innerHeight
      && bounds.left < window.innerWidth;
    const computedWidth = Number.parseFloat(style.width);
    const computedHeight = Number.parseFloat(style.height);
    const boxWidth = Number.isFinite(computedWidth) ? Math.max(0, computedWidth) : Math.max(0, source.offsetWidth);
    const boxHeight = Number.isFinite(computedHeight) ? Math.max(0, computedHeight) : Math.max(0, source.offsetHeight);
    const canvas = document.createElement("canvas");
    canvas.className = copy.className;
    canvas.dataset.appearanceMediaRaster = "";
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = visible ? Math.max(1, Math.ceil(boxWidth * safePixelRatio)) : 1;
    canvas.height = visible ? Math.max(1, Math.ceil(boxHeight * safePixelRatio)) : 1;
    canvas.style.width = `${boxWidth}px`;
    canvas.style.height = `${boxHeight}px`;
    canvas.style.display = style.display;
    canvas.style.objectFit = style.objectFit;
    canvas.style.objectPosition = style.objectPosition;
    canvas.style.borderRadius = style.borderRadius;
    canvas.style.opacity = style.opacity;
    canvas.style.filter = style.filter;

    const plan = visible && source.complete
      ? getCenteredImageDrawPlan(source.naturalWidth, source.naturalHeight, boxWidth, boxHeight, style.objectFit)
      : undefined;
    const context = plan ? canvas.getContext("2d") : null;
    if (context && plan) {
      context.setTransform(safePixelRatio, 0, 0, safePixelRatio, 0, 0);
      try {
        context.drawImage(
          source,
          plan.sourceX,
          plan.sourceY,
          plan.sourceWidth,
          plan.sourceHeight,
          plan.destinationX,
          plan.destinationY,
          plan.destinationWidth,
          plan.destinationHeight,
        );
      } catch {
        // The existing artwork fallback remains visible through a transparent canvas.
      }
    }
    copy.replaceWith(canvas);
  }

  return count;
}

import type { PlexItem } from "./types";

export interface PlaylistRowBounds {
  top: number;
  bottom: number;
}

export interface PlaylistPointerTarget {
  targetIndex: number;
  afterTarget: boolean;
}

const PLAYLIST_AUTO_SCROLL_EDGE_PX = 56;
const PLAYLIST_AUTO_SCROLL_MAX_STEP_PX = 18;

export function playlistAutoScrollDelta(
  pointerY: number,
  containerTop: number,
  containerBottom: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  if (![pointerY, containerTop, containerBottom, scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) return 0;
  if (containerBottom <= containerTop || clientHeight <= 0) return 0;

  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const currentScrollTop = Math.min(maxScrollTop, Math.max(0, scrollTop));
  const edge = Math.min(PLAYLIST_AUTO_SCROLL_EDGE_PX, (containerBottom - containerTop) / 2);
  const upperEdge = containerTop + edge;
  const lowerEdge = containerBottom - edge;
  let direction = 0;
  let intensity = 0;

  if (pointerY < upperEdge) {
    direction = -1;
    intensity = Math.min(1, (upperEdge - pointerY) / edge);
  } else if (pointerY > lowerEdge) {
    direction = 1;
    intensity = Math.min(1, (pointerY - lowerEdge) / edge);
  } else {
    return 0;
  }

  const requested = Math.max(1, Math.round(PLAYLIST_AUTO_SCROLL_MAX_STEP_PX * intensity));
  const available = direction < 0 ? currentScrollTop : maxScrollTop - currentScrollTop;
  if (available <= 0) return 0;
  return direction * Math.min(requested, available);
}

export function playlistPointerTarget(
  pointerY: number,
  rows: readonly PlaylistRowBounds[],
): PlaylistPointerTarget | undefined {
  if (!Number.isFinite(pointerY) || !rows.length) return undefined;
  if (pointerY <= rows[0].top) return { targetIndex: 0, afterTarget: false };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (pointerY < row.bottom) {
      return {
        targetIndex: index,
        afterTarget: pointerY >= row.top + Math.max(0, row.bottom - row.top) / 2,
      };
    }
  }

  return { targetIndex: rows.length - 1, afterTarget: true };
}

export function playlistDropIndex(
  fromIndex: number,
  targetIndex: number,
  afterTarget: boolean,
  length: number,
): number {
  if (length <= 0) return -1;
  const from = Math.min(length - 1, Math.max(0, fromIndex));
  const target = Math.min(length - 1, Math.max(0, targetIndex));
  const insertionIndex = target + (afterTarget ? 1 : 0);
  return Math.min(length - 1, Math.max(0, insertionIndex - (from < insertionIndex ? 1 : 0)));
}

export function reorderPlaylistItems(
  items: readonly PlexItem[],
  fromIndex: number,
  toIndex: number,
): PlexItem[] {
  if (
    fromIndex === toIndex
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= items.length
    || toIndex >= items.length
  ) return [...items];
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function playlistMoveAfterId(items: readonly PlexItem[], movedIndex: number): string | undefined {
  if (movedIndex <= 0 || movedIndex >= items.length) return undefined;
  return items[movedIndex - 1]?.playlistItemID;
}

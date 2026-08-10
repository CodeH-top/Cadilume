import type { PlexItem } from "./types";

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

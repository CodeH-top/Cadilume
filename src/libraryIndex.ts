import type { PlexItem } from "./types";

export const PLEX_ALPHABET_INDEX = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "#",
] as const;

export type PlexAlphabetBucket = typeof PLEX_ALPHABET_INDEX[number];

/**
 * Derive only the navigation bucket locally. Ordering remains PMS-authoritative:
 * `/all?sort=titleSort:asc` already applies the server's locale and sort rules.
 */
export function plexAlphabetBucket(item: Pick<PlexItem, "title" | "titleSort">): PlexAlphabetBucket {
  const sortValue = (item.titleSort || item.title).trim().normalize("NFKD").replace(/\p{Mark}/gu, "");
  const first = sortValue.match(/[\p{Letter}\p{Number}]/u)?.[0]?.toUpperCase();
  return first && /^[A-Z]$/.test(first) ? first as PlexAlphabetBucket : "#";
}

export interface PlexAlphabetGroup {
  bucket: PlexAlphabetBucket;
  items: PlexItem[];
}

/** Preserve the exact server order inside each bucket. */
export function groupPlexItemsByAlphabet(items: readonly PlexItem[]): PlexAlphabetGroup[] {
  const grouped = new Map<PlexAlphabetBucket, PlexItem[]>();
  for (const item of items) {
    const bucket = plexAlphabetBucket(item);
    const bucketItems = grouped.get(bucket) ?? [];
    bucketItems.push(item);
    grouped.set(bucket, bucketItems);
  }
  return PLEX_ALPHABET_INDEX
    .filter((bucket) => grouped.has(bucket))
    .map((bucket) => ({ bucket, items: grouped.get(bucket) ?? [] }));
}

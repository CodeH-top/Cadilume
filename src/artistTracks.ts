import type { PlexItem, PlexItemPage } from "./types";

/** Preserve PMS order while filtering duplicates across and within pages. */
export function appendUniqueArtistTracks(current: readonly PlexItem[], incoming: readonly PlexItem[]): PlexItem[] {
  const seen = new Set(current.map((track) => track.ratingKey));
  const appended = incoming.filter((track) => {
    if (seen.has(track.ratingKey)) return false;
    seen.add(track.ratingKey);
    return true;
  });
  return [...current, ...appended];
}

export class ArtistTrackCollectionCancelledError extends Error {
  constructor() {
    super("歌手歌曲收集已取消");
    this.name = "ArtistTrackCollectionCancelledError";
  }
}

export function isArtistTrackCollectionCancelled(reason: unknown): reason is ArtistTrackCollectionCancelledError {
  return reason instanceof ArtistTrackCollectionCancelledError;
}

export interface ArtistTrackCollection {
  tracks: PlexItem[];
  totalSize: number;
}

export interface CollectArtistTracksOptions {
  signal?: AbortSignal;
  maxPages?: number;
}

function throwIfCollectionCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArtistTrackCollectionCancelledError();
}

function nonNegativeInteger(value: number, fallback = 0): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Fetch every artist-track page in PMS order. The caller owns the page cache,
 * so a visible first page and a bulk action can share the same in-flight read.
 */
export async function collectAllArtistTracks(
  getPage: (start: number) => Promise<PlexItemPage>,
  { signal, maxPages = 1_000 }: CollectArtistTracksOptions = {},
): Promise<ArtistTrackCollection> {
  const seenStarts = new Set<number>();
  let tracks: PlexItem[] = [];
  let start = 0;
  let totalSize = 0;

  for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
    throwIfCollectionCancelled(signal);
    if (seenStarts.has(start)) throw new Error("歌手歌曲分页没有继续前进。");
    seenStarts.add(start);

    const page = await getPage(start);
    throwIfCollectionCancelled(signal);

    const pageItems = page.items.filter((item) => item.type === "track");
    tracks = appendUniqueArtistTracks(tracks, pageItems);

    const nextStart = nonNegativeInteger(page.nextStart, start);
    const reportedTotal = nonNegativeInteger(page.totalSize);
    totalSize = Math.max(totalSize, reportedTotal, nextStart, start + page.items.length);

    if (totalSize === 0 || nextStart >= totalSize) return { tracks, totalSize };
    if (nextStart <= start) throw new Error("歌手歌曲分页没有继续前进。");
    start = nextStart;
  }

  throw new Error("歌手歌曲分页超过安全读取上限。");
}

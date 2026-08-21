import { artworkUrl } from "./api";

interface ArtworkRequestRecord {
  width: number;
  height: number;
  sourcePath: string;
  promise: Promise<string>;
  resolved?: string;
}

const artworkRequests = new Map<string, ArtworkRequestRecord>();
const CANONICAL_SQUARE_SIZE = 420;
const SHARED_SQUARE_MAX_SIZE = 512;

interface ArtworkPathItem {
  parentRatingKey?: string;
  thumb?: string;
  art?: string;
  composite?: string;
}

interface ArtworkPrewarmGroup {
  cacheIdentity?: string;
  path: string;
}

export function artworkCacheIdentity(item?: { parentRatingKey?: string }): string | undefined {
  const albumId = item?.parentRatingKey?.trim();
  return albumId ? `album:${albumId}` : undefined;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.max(1, Math.round(Math.abs(left)));
  let b = Math.max(1, Math.round(Math.abs(right)));
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function normalizedDimensions(width: number, height: number): { width: number; height: number } {
  if (width === height && width <= SHARED_SQUARE_MAX_SIZE) {
    return { width: CANONICAL_SQUARE_SIZE, height: CANONICAL_SQUARE_SIZE };
  }
  return { width, height };
}

function artworkSourceKey(path: string, cacheIdentity?: string): string {
  return cacheIdentity ? `identity:${cacheIdentity}` : `path:${path}`;
}

function artworkVariantKey(
  serverId: string,
  path: string,
  width: number,
  height: number,
  cacheIdentity?: string,
): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${serverId}:${Math.round(width) / divisor}x${Math.round(height) / divisor}:${artworkSourceKey(path, cacheIdentity)}`;
}

/**
 * Share one loopback ticket per album (or fallback path) and aspect ratio.
 * Small square callers reuse the established 420px disk entry through 512px,
 * while a truly larger request atomically upgrades the owner without letting
 * the old Promise write back.
 */
export function requestCachedArtwork(
  serverId: string,
  path: string,
  width: number,
  height = width,
  cacheIdentity?: string,
): Promise<string> {
  const dimensions = normalizedDimensions(width, height);
  const key = artworkVariantKey(serverId, path, dimensions.width, dimensions.height, cacheIdentity);
  const existing = artworkRequests.get(key);
  if (existing
    && existing.sourcePath === path
    && existing.width >= dimensions.width
    && existing.height >= dimensions.height) {
    return existing.promise;
  }

  const promise = cacheIdentity
    ? artworkUrl(serverId, path, dimensions.width, dimensions.height, cacheIdentity)
    : artworkUrl(serverId, path, dimensions.width, dimensions.height);
  const record: ArtworkRequestRecord = {
    width: dimensions.width,
    height: dimensions.height,
    sourcePath: path,
    promise,
  };
  artworkRequests.set(key, record);
  promise.then((url) => {
    if (artworkRequests.get(key) === record) record.resolved = url;
  }).catch(() => {
    if (artworkRequests.get(key) === record) artworkRequests.delete(key);
  });
  return promise;
}

/**
 * Warm every distinct album in a restored queue without blocking the startup
 * frame. Items without an album identity fall back to exact-path deduplication.
 * The caller can stop scheduling new requests when the queue owner changes;
 * in-flight requests remain shared by the normal ticket cache.
 */
export async function prewarmArtwork(
  serverId: string,
  items: readonly ArtworkPathItem[],
  concurrency = 4,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const grouped = new Map<string, ArtworkPrewarmGroup>();
  for (const item of items) {
    const path = item.thumb || item.composite || item.art;
    if (!path) continue;
    const cacheIdentity = artworkCacheIdentity(item);
    const identity = cacheIdentity || `path:${path}`;
    if (!grouped.has(identity)) grouped.set(identity, { cacheIdentity, path });
  }
  const groups = Array.from(grouped.values());
  if (!groups.length || !shouldContinue()) return;

  let cursor = 0;
  const worker = async () => {
    while (shouldContinue()) {
      const group = groups[cursor++];
      if (!group) return;
      const promise = requestCachedArtwork(
        serverId,
        group.path,
        CANONICAL_SQUARE_SIZE,
        CANONICAL_SQUARE_SIZE,
        group.cacheIdentity,
      );
      await promise.catch(() => undefined);
    }
  };
  const workerCount = Math.min(groups.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

export function getResolvedArtwork(
  serverId: string,
  path: string,
  width = SHARED_SQUARE_MAX_SIZE,
  height = width,
  cacheIdentity?: string,
): string | undefined {
  const dimensions = normalizedDimensions(width, height);
  const key = artworkVariantKey(serverId, path, dimensions.width, dimensions.height, cacheIdentity);
  const record = artworkRequests.get(key);
  if (!record?.resolved
    || record.sourcePath !== path
    || record.width < dimensions.width
    || record.height < dimensions.height) return undefined;
  return record.resolved;
}

export function invalidateCachedArtwork(
  serverId: string,
  path: string,
  width?: number,
  height = width,
  cacheIdentity?: string,
): void {
  if (width !== undefined) {
    const dimensions = normalizedDimensions(width, height ?? width);
    artworkRequests.delete(artworkVariantKey(
      serverId,
      path,
      dimensions.width,
      dimensions.height,
      cacheIdentity,
    ));
    return;
  }
  const prefix = `${serverId}:`;
  const suffix = `:${artworkSourceKey(path, cacheIdentity)}`;
  for (const key of artworkRequests.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) artworkRequests.delete(key);
  }
}

export function clearArtworkTicketCache(): void {
  artworkRequests.clear();
}

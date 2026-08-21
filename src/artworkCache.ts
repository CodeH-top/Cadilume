import { artworkUrl } from "./api";

interface ArtworkRequestRecord {
  width: number;
  height: number;
  promise: Promise<string>;
  resolved?: string;
}

const artworkRequests = new Map<string, ArtworkRequestRecord>();
// Keep the full persisted playback queue (up to 500 tracks) plus the small
// startup artwork set resident so queue prewarming does not evict itself.
const MAX_ARTWORK_ENTRIES = 640;
const CANONICAL_SQUARE_SIZE = 420;
const SHARED_SQUARE_MAX_SIZE = 512;

interface ArtworkPathItem {
  thumb?: string;
  art?: string;
  composite?: string;
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

function artworkVariantKey(serverId: string, path: string, width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${serverId}:${Math.round(width) / divisor}x${Math.round(height) / divisor}:${path}`;
}

function touchRecord(key: string, record: ArtworkRequestRecord): void {
  artworkRequests.delete(key);
  artworkRequests.set(key, record);
}

function evictOldestRecords(): void {
  while (artworkRequests.size > MAX_ARTWORK_ENTRIES) {
    const oldest = artworkRequests.keys().next().value;
    if (typeof oldest !== "string") break;
    artworkRequests.delete(oldest);
  }
}

/**
 * Share one bounded loopback ticket per artwork path/aspect ratio. Small square
 * callers reuse the established 420px disk entry through 512px, while a truly
 * larger request atomically upgrades the owner without letting the old Promise
 * write back.
 */
export function requestCachedArtwork(
  serverId: string,
  path: string,
  width: number,
  height = width,
): Promise<string> {
  const dimensions = normalizedDimensions(width, height);
  const key = artworkVariantKey(serverId, path, dimensions.width, dimensions.height);
  const existing = artworkRequests.get(key);
  if (existing
    && existing.width >= dimensions.width
    && existing.height >= dimensions.height) {
    touchRecord(key, existing);
    return existing.promise;
  }

  const promise = artworkUrl(serverId, path, dimensions.width, dimensions.height);
  const record: ArtworkRequestRecord = {
    width: dimensions.width,
    height: dimensions.height,
    promise,
  };
  artworkRequests.set(key, record);
  evictOldestRecords();
  promise.then((url) => {
    if (artworkRequests.get(key) === record) record.resolved = url;
  }).catch(() => {
    if (artworkRequests.get(key) === record) artworkRequests.delete(key);
  });
  return promise;
}

/**
 * Warm every distinct artwork path in a restored queue without blocking the
 * startup frame. The caller can stop scheduling new requests when the queue
 * owner changes; in-flight requests remain shared by the normal ticket cache.
 */
export async function prewarmArtwork(
  serverId: string,
  items: readonly ArtworkPathItem[],
  concurrency = 4,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const paths = Array.from(new Set(
    items
      .map((item) => item.thumb || item.composite || item.art)
      .filter((path): path is string => Boolean(path)),
  ));
  if (!paths.length || !shouldContinue()) return;

  let cursor = 0;
  const worker = async () => {
    while (shouldContinue()) {
      const path = paths[cursor++];
      if (!path) return;
      await requestCachedArtwork(serverId, path, CANONICAL_SQUARE_SIZE, CANONICAL_SQUARE_SIZE)
        .catch(() => undefined);
    }
  };
  const workerCount = Math.min(paths.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, worker));
}

export function getResolvedArtwork(
  serverId: string,
  path: string,
  width = SHARED_SQUARE_MAX_SIZE,
  height = width,
): string | undefined {
  const dimensions = normalizedDimensions(width, height);
  const key = artworkVariantKey(serverId, path, dimensions.width, dimensions.height);
  const record = artworkRequests.get(key);
  if (!record?.resolved
    || record.width < dimensions.width
    || record.height < dimensions.height) return undefined;
  touchRecord(key, record);
  return record.resolved;
}

export function invalidateCachedArtwork(
  serverId: string,
  path: string,
  width?: number,
  height = width,
): void {
  if (width !== undefined) {
    const dimensions = normalizedDimensions(width, height ?? width);
    artworkRequests.delete(artworkVariantKey(serverId, path, dimensions.width, dimensions.height));
    return;
  }
  const prefix = `${serverId}:`;
  const suffix = `:${path}`;
  for (const key of artworkRequests.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) artworkRequests.delete(key);
  }
}

export function clearArtworkTicketCache(): void {
  artworkRequests.clear();
}

import { artworkUrl } from "./api";

const exactArtworkRequests = new Map<string, Promise<string>>();
const pathArtworkRequests = new Map<string, Promise<string>>();
const resolvedArtworkPaths = new Map<string, string>();
const MAX_ARTWORK_ENTRIES = 240;

function pathKey(serverId: string, path: string): string {
  return `${serverId}:${path}`;
}

function exactKey(serverId: string, path: string, width: number, height: number): string {
  return `${serverId}:${width}x${height}:${path}`;
}

/**
 * Request one short-lived loopback ticket per cached artwork path. Rust checks
 * the disk cache before contacting PMS, so callers can use this for both the
 * first visible card and the small player artwork without duplicate downloads.
 */
export function requestCachedArtwork(
  serverId: string,
  path: string,
  width: number,
  height = width,
): Promise<string> {
  const requestKey = exactKey(serverId, path, width, height);
  const scopeKey = pathKey(serverId, path);
  const existing = exactArtworkRequests.get(requestKey) || pathArtworkRequests.get(scopeKey);
  if (existing) {
    exactArtworkRequests.set(requestKey, existing);
    return existing;
  }

  const request = artworkUrl(serverId, path, width, height);
  exactArtworkRequests.set(requestKey, request);
  pathArtworkRequests.set(scopeKey, request);
  request.then((url) => {
    if (pathArtworkRequests.get(scopeKey) === request) resolvedArtworkPaths.set(scopeKey, url);
  }).catch(() => undefined);
  request.catch(() => {
    if (exactArtworkRequests.get(requestKey) === request) exactArtworkRequests.delete(requestKey);
    if (pathArtworkRequests.get(scopeKey) === request) {
      pathArtworkRequests.delete(scopeKey);
      resolvedArtworkPaths.delete(scopeKey);
    }
  });
  while (exactArtworkRequests.size > MAX_ARTWORK_ENTRIES) {
    const oldest = exactArtworkRequests.keys().next().value;
    if (typeof oldest !== "string") break;
    exactArtworkRequests.delete(oldest);
  }
  return request;
}

export function getResolvedArtwork(serverId: string, path: string): string | undefined {
  return resolvedArtworkPaths.get(pathKey(serverId, path));
}

export function invalidateCachedArtwork(serverId: string, path: string, width?: number, height = width): void {
  pathArtworkRequests.delete(pathKey(serverId, path));
  resolvedArtworkPaths.delete(pathKey(serverId, path));
  if (width !== undefined) exactArtworkRequests.delete(exactKey(serverId, path, width, height ?? width));
  const prefix = `${serverId}:`;
  const suffix = `:${path}`;
  for (const key of exactArtworkRequests.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) exactArtworkRequests.delete(key);
  }
}

export function clearArtworkTicketCache(): void {
  exactArtworkRequests.clear();
  pathArtworkRequests.clear();
  resolvedArtworkPaths.clear();
}

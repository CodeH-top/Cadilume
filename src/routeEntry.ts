import type { LibraryRoute } from "./libraryRoute";

export interface RouteEntryLocation {
  key: string;
  state: unknown;
}

export interface CreateCadilumeEntryStateOptions {
  route: LibraryRoute;
  parentEntryId?: string;
  entryId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * React Router's location key is the runtime cache identity. The companion ID
 * is persisted in location.state so child routes can keep a stable parent
 * relationship after a history restore.
 */
export function createCadilumeEntryId(now = Date.now(), random = Math.random()): string {
  return `cadilume-${now.toString(36)}-${Math.floor(random * 0x1000000).toString(36)}`;
}

export function routeEntryId(location: RouteEntryLocation): string {
  return nonEmptyString(asRecord(location.state)?.cadilumeEntryId)
    || `cadilume-location-${location.key || "default"}`;
}

export function routeParentEntryId(state: unknown): string | undefined {
  return nonEmptyString(asRecord(state)?.cadilumeParentEntryId);
}

export function historyEntryCacheKey(locationKey: string): string {
  return `history-${locationKey || "default"}`;
}

export function createCadilumeEntryState(
  current: unknown,
  { route, parentEntryId, entryId = createCadilumeEntryId() }: CreateCadilumeEntryStateOptions,
): Record<string, unknown> {
  const base = asRecord(current);
  const previousSnapshot = asRecord(base?.cadilumeSnapshot);
  const nextState: Record<string, unknown> = {
    ...base,
    cadilumeEntryId: entryId,
    cadilumeSnapshot: {
      ...previousSnapshot,
      route,
    },
  };

  if (parentEntryId) nextState.cadilumeParentEntryId = parentEntryId;
  else delete nextState.cadilumeParentEntryId;

  return nextState;
}

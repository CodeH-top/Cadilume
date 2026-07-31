import type { LibraryView } from "./types";
import type { TrackSortState } from "./trackSort";

export type LibraryDetailType = "artist" | "album" | "playlist";

export interface LibraryRoute {
  view: LibraryView;
  query?: string;
  tracks?: {
    page: number;
    sort?: TrackSortState;
  };
  detail?: {
    type: LibraryDetailType;
    ratingKey: string;
  };
}

const ROUTE_VIEWS = new Set<LibraryView>(["home", "albums", "artists", "tracks", "search", "settings"]);
const DETAIL_ROUTES: Record<string, { type: LibraryDetailType; view: LibraryView }> = {
  artists: { type: "artist", view: "artists" },
  albums: { type: "album", view: "albums" },
  playlists: { type: "playlist", view: "home" },
};

const TRACK_SORT_KEYS = new Set<TrackSortState["key"]>(["title", "album", "duration"]);
const TRACK_SORT_DIRECTIONS = new Set<TrackSortState["direction"]>(["asc", "desc"]);

function decodeRouteSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function parseLibraryRoute(hash: string): LibraryRoute {
  const raw = hash.replace(/^#/, "");
  const [rawPath = "", rawQuery = ""] = raw.split("?", 2);
  const path = rawPath.replace(/^\/+|\/+$/g, "") || "home";
  const segments = path.split("/");
  if (segments.length === 2) {
    const detailRoute = DETAIL_ROUTES[segments[0]];
    const ratingKey = decodeRouteSegment(segments[1]);
    if (detailRoute && ratingKey) {
      return {
        view: detailRoute.view,
        detail: { type: detailRoute.type, ratingKey },
      };
    }
    return { view: "home" };
  }
  const view = ROUTE_VIEWS.has(path as LibraryView) ? path as LibraryView : "home";
  const params = new URLSearchParams(rawQuery);
  if (view === "search") {
    const query = params.get("q")?.trim();
    return query ? { view, query } : { view };
  }
  if (view !== "tracks") return { view };

  const rawPage = Number.parseInt(params.get("page") || "", 10);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const sortKey = params.get("sort");
  const sortDirection = params.get("direction");
  const sort = TRACK_SORT_KEYS.has(sortKey as TrackSortState["key"])
    && TRACK_SORT_DIRECTIONS.has(sortDirection as TrackSortState["direction"])
    ? { key: sortKey as TrackSortState["key"], direction: sortDirection as TrackSortState["direction"] }
    : undefined;
  return page > 1 || sort ? { view, tracks: { page, sort } } : { view };
}

export function libraryDetailRoute(type: LibraryDetailType, ratingKey: string): LibraryRoute {
  const normalizedRatingKey = ratingKey.trim();
  const view: LibraryView = type === "artist" ? "artists" : type === "album" ? "albums" : "home";
  return {
    view,
    detail: { type, ratingKey: normalizedRatingKey },
  };
}

export function libraryTracksRoute(page = 1, sort?: TrackSortState): LibraryRoute {
  return {
    view: "tracks",
    tracks: { page: Math.max(1, Math.floor(Number.isFinite(page) ? page : 1)), sort },
  };
}

export function libraryRouteHash(route: LibraryRoute): string;
export function libraryRouteHash(view: LibraryView, query?: string): string;
export function libraryRouteHash(routeOrView: LibraryRoute | LibraryView, query?: string): string {
  const route = typeof routeOrView === "string" ? { view: routeOrView, query } : routeOrView;
  if (route.detail?.ratingKey) {
    const prefix = route.detail.type === "artist" ? "artists" : route.detail.type === "album" ? "albums" : "playlists";
    return `#/${prefix}/${encodeURIComponent(route.detail.ratingKey)}`;
  }
  const { view } = route;
  if (view === "search") {
    const normalizedQuery = route.query?.trim();
    return normalizedQuery ? `#/search?${new URLSearchParams({ q: normalizedQuery }).toString()}` : "#/search";
  }
  if (view !== "tracks") return `#/${view}`;
  const page = route.tracks?.page ?? 1;
  const sort = route.tracks?.sort;
  if (page <= 1 && !sort) return "#/tracks";
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (sort) {
    params.set("sort", sort.key);
    params.set("direction", sort.direction);
  }
  return `#/tracks?${params.toString()}`;
}

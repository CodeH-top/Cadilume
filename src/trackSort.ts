import type { PlexItem } from "./types";

export type TrackSortKey = "title" | "album" | "duration";
export type TrackSortDirection = "asc" | "desc";

export interface TrackSortState {
  key: TrackSortKey;
  direction: TrackSortDirection;
}

const trackCollator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

export function nextTrackSort(current: TrackSortState | undefined, key: TrackSortKey): TrackSortState | undefined {
  if (current?.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return undefined;
}

/** Keep the incoming PMS order untouched until the user explicitly chooses a table sort. */
export function sortTracks(tracks: readonly PlexItem[], sort: TrackSortState | undefined): PlexItem[] {
  if (!sort) return [...tracks];
  const direction = sort.direction === "asc" ? 1 : -1;

  return tracks
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      let comparison = 0;
      if (sort.key === "title") {
        comparison = trackCollator.compare(
          left.track.titleSort || left.track.title,
          right.track.titleSort || right.track.title,
        );
      } else if (sort.key === "album") {
        comparison = trackCollator.compare(
          left.track.parentTitleSort || left.track.parentTitle || "",
          right.track.parentTitleSort || right.track.parentTitle || "",
        );
      } else {
        comparison = (left.track.duration ?? 0) - (right.track.duration ?? 0);
      }
      return comparison === 0 ? left.index - right.index : comparison * direction;
    })
    .map(({ track }) => track);
}

/** PMS sorts the full paginated singer catalogue so every page participates in the chosen order. */
export function plexSingerTrackSort(sort: TrackSortState | undefined): string {
  if (!sort) return "parentTitleSort:asc,parentIndex:asc,index:asc";
  if (sort.key === "title") return `titleSort:${sort.direction}`;
  if (sort.key === "album") return `parentTitleSort:${sort.direction},parentIndex:asc,index:asc`;
  return `duration:${sort.direction},titleSort:asc`;
}

/** PMS sorts the complete library result before the client receives one 50-track page. */
export function plexLibraryTrackSort(sort: TrackSortState | undefined): string {
  if (!sort) return "titleSort:asc";
  if (sort.key === "title") return `titleSort:${sort.direction}`;
  if (sort.key === "album") return `parentTitleSort:${sort.direction},titleSort:asc`;
  return `duration:${sort.direction},titleSort:asc`;
}

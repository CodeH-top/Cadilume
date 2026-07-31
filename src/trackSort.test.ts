import { describe, expect, it } from "vitest";
import type { PlexItem } from "./types";
import { nextTrackSort, plexLibraryTrackSort, plexSingerTrackSort, sortTracks } from "./trackSort";

const tracks: PlexItem[] = [
  { ratingKey: "2", key: "/2", type: "track", title: "Beta", parentTitle: "Alpha", duration: 220_000 },
  { ratingKey: "1", key: "/1", type: "track", title: "Alpha", parentTitle: "Zulu", duration: 180_000 },
  { ratingKey: "3", key: "/3", type: "track", title: "Gamma", parentTitle: "Middle", duration: 200_000 },
];

describe("track table sorting", () => {
  it("preserves the PMS order until a user chooses a sort", () => {
    expect(sortTracks(tracks, undefined)).toEqual(tracks);
  });

  it("cycles default, ascending, descending, and default while only one column stays active", () => {
    const titleAsc = nextTrackSort(undefined, "title");
    expect(titleAsc).toEqual({ key: "title", direction: "asc" });
    const titleDesc = nextTrackSort(titleAsc, "title");
    expect(titleDesc).toEqual({ key: "title", direction: "desc" });
    expect(nextTrackSort(titleDesc, "title")).toBeUndefined();
    expect(nextTrackSort({ key: "duration", direction: "desc" }, "album")).toEqual({ key: "album", direction: "asc" });
  });

  it("sorts by title, album, and duration without mutating the source list", () => {
    expect(sortTracks(tracks, { key: "title", direction: "desc" }).map((track) => track.ratingKey)).toEqual(["3", "2", "1"]);
    expect(sortTracks(tracks, { key: "album", direction: "asc" }).map((track) => track.ratingKey)).toEqual(["2", "3", "1"]);
    expect(sortTracks(tracks, { key: "duration", direction: "asc" }).map((track) => track.ratingKey)).toEqual(["1", "3", "2"]);
    expect(tracks.map((track) => track.ratingKey)).toEqual(["2", "1", "3"]);
  });

  it("maps singer pagination sorts while preserving the original default", () => {
    expect(plexSingerTrackSort(undefined)).toBe("parentTitleSort:asc,parentIndex:asc,index:asc");
    expect(plexSingerTrackSort({ key: "title", direction: "desc" })).toBe("titleSort:desc");
    expect(plexSingerTrackSort({ key: "album", direction: "desc" })).toBe("parentTitleSort:desc,parentIndex:asc,index:asc");
    expect(plexSingerTrackSort({ key: "duration", direction: "asc" })).toBe("duration:asc,titleSort:asc");
  });

  it("maps main-library pagination sorts without reordering a received page in the browser", () => {
    expect(plexLibraryTrackSort(undefined)).toBe("titleSort:asc");
    expect(plexLibraryTrackSort({ key: "title", direction: "desc" })).toBe("titleSort:desc");
    expect(plexLibraryTrackSort({ key: "album", direction: "asc" })).toBe("parentTitleSort:asc,titleSort:asc");
    expect(plexLibraryTrackSort({ key: "duration", direction: "desc" })).toBe("duration:desc,titleSort:asc");
  });
});

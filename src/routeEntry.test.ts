import { describe, expect, it } from "vitest";
import { createCadilumeEntryId, createCadilumeEntryState, historyEntryCacheKey, routeEntryId, routeParentEntryId } from "./routeEntry";

describe("Cadilume History entry state", () => {
  it("uses React Router location keys as distinct cache identities for the same URL", () => {
    expect(historyEntryCacheKey("artist-entry-a")).toBe("history-artist-entry-a");
    expect(historyEntryCacheKey("artist-entry-b")).toBe("history-artist-entry-b");
    expect(historyEntryCacheKey("artist-entry-a")).not.toBe(historyEntryCacheKey("artist-entry-b"));
  });

  it("derives a stable entry id for direct routes without serialized state", () => {
    expect(routeEntryId({ key: "direct-artists", state: undefined })).toBe("cadilume-location-direct-artists");
    expect(routeEntryId({ key: "direct-artists", state: { cadilumeEntryId: "restored-entry" } })).toBe("restored-entry");
  });

  it("merges a navigation snapshot without losing unrelated state or the parent entry", () => {
    const initialState = {
      fromSearch: true,
      cadilumeSnapshot: { rememberedFilter: "recent" },
    };
    const nextState = createCadilumeEntryState(initialState, {
      entryId: "detail-entry",
      parentEntryId: "artists-entry",
      route: { view: "artists", detail: { type: "artist", ratingKey: "artist-42" } },
    });

    expect(nextState).toEqual({
      fromSearch: true,
      cadilumeEntryId: "detail-entry",
      cadilumeParentEntryId: "artists-entry",
      cadilumeSnapshot: {
        rememberedFilter: "recent",
        route: { view: "artists", detail: { type: "artist", ratingKey: "artist-42" } },
      },
    });
    expect(routeParentEntryId(nextState)).toBe("artists-entry");
    expect(initialState).toEqual({
      fromSearch: true,
      cadilumeSnapshot: { rememberedFilter: "recent" },
    });
  });

  it("creates reproducible entry ids for controlled restore tests", () => {
    expect(createCadilumeEntryId(36, 0.5)).toBe("cadilume-10-4zsow");
  });
});

import { describe, expect, it } from "vitest";
import { orderRecommendationHubs, recommendationHubTitle, recentlyPlayedPlaylists } from "./recommendations";
import type { PlexHub, PlexPlaylist } from "./types";

const hub = (title: string, identifier: string): PlexHub => ({ title, identifier, type: "album", items: [] });
const playlist = (ratingKey: string, lastViewedAt?: number, viewCount?: number): PlexPlaylist => ({
  ratingKey,
  key: `/playlists/${ratingKey}/items`,
  type: "playlist",
  title: ratingKey,
  playlistType: "audio",
  smart: false,
  readOnly: false,
  lastViewedAt,
  viewCount,
});

describe("recommendation ordering", () => {
  it("puts recently played first and recently added last without reordering other PMS hubs", () => {
    const ordered = orderRecommendationHubs([
      hub("Mixes", "music.mixes.1"),
      hub("Recently Added", "music.recentlyadded.1"),
      hub("Top Albums", "music.topalbums.1"),
      hub("Recently Played", "music.recentlyplayed.1"),
    ]);

    expect(ordered.map(({ identifier }) => identifier)).toEqual([
      "music.recentlyplayed.1",
      "music.mixes.1",
      "music.topalbums.1",
      "music.recentlyadded.1",
    ]);
    expect(recommendationHubTitle(ordered[0])).toBe("最近播放的音乐");
    expect(recommendationHubTitle(ordered[3])).toBe("最近加入的音乐");
  });

  it("orders played playlists by Plex lastViewedAt and excludes untouched playlists", () => {
    expect(recentlyPlayedPlaylists([
      playlist("older", 100, 8),
      playlist("untouched"),
      playlist("newer", 300, 2),
      playlist("count-only", undefined, 4),
    ]).map(({ ratingKey }) => ratingKey)).toEqual(["newer", "older", "count-only"]);
  });
});

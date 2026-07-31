import { describe, expect, it } from "vitest";
import { homeRecommendationHubs, orderRecommendationHubs, recommendationHubTitle, recentlyPlayedPlaylists } from "./recommendations";
import type { PlexHub, PlexItem, PlexPlaylist } from "./types";

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

  it("keeps the home page to recent playlists, played tracks, and added music", () => {
    const track: PlexItem = { ratingKey: "track-1", key: "/library/metadata/track-1", type: "track", title: "Song" };
    const artist: PlexItem = { ratingKey: "artist-1", key: "/library/metadata/artist-1", type: "artist", title: "Artist" };
    const album: PlexItem = { ratingKey: "album-1", key: "/library/metadata/album-1", type: "album", title: "Album" };
    const home = homeRecommendationHubs([
      { title: "Top artists", type: "artist", identifier: "music.topartists.1", items: [artist] },
      { title: "Recently Added", type: "album", identifier: "music.recentlyadded.1", items: [album, artist] },
      { title: "Recently Played", type: "artist", identifier: "music.recentlyplayed.artists.1", items: [artist] },
      { title: "Recently Played Tracks", type: "track", identifier: "music.recentlyplayed.1", items: [artist, track] },
    ]);

    expect(home.map(({ identifier }) => identifier)).toEqual([
      "music.recentlyplayed.1",
      "music.recentlyadded.1",
    ]);
    expect(home[0].items.every((item) => item.type === "track")).toBe(true);
    expect(home[1].items.map((item) => item.type)).toEqual(["album"]);
  });
});

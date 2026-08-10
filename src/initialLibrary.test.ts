import { describe, expect, it, vi } from "vitest";
import { loadInitialLibraryData, type InitialLibrarySource } from "./initialLibrary";
import type { LibrarySection, PlexHub, PlexItem, PlexPlaylist, PlexServer } from "./types";

const server = (id: string): PlexServer => ({
  id,
  name: id,
  owned: true,
  home: false,
  connectionUri: `http://${id}`,
  local: true,
  relay: false,
  secure: false,
});

const section = (key: string): LibrarySection => ({ key, title: key, type: "artist" });

const track = (ratingKey: string): PlexItem => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}`,
  type: "track",
  title: ratingKey,
});

const playlist = (ratingKey: string, addedAt: number): PlexPlaylist => ({
  ratingKey,
  key: `/playlists/${ratingKey}/items`,
  type: "playlist",
  title: ratingKey,
  playlistType: "audio",
  smart: false,
  readOnly: false,
  addedAt,
});

function source(overrides: Partial<InitialLibrarySource> = {}): InitialLibrarySource {
  return {
    discoverServers: vi.fn(async () => [server("server-a")]),
    getSections: vi.fn(async () => [section("music")]),
    getPlaylists: vi.fn(async () => []),
    getLibraryItems: vi.fn(async () => []),
    getRecommendationHubs: vi.fn(async () => []),
    getRecentAlbums: vi.fn(async () => []),
    ...overrides,
  };
}

describe("initial library loading", () => {
  it("waits for every first-screen source and returns one coherent preferred-server snapshot", async () => {
    const recentlyPlayed: PlexHub = {
      title: "Recently Played",
      identifier: "recentlyplayed",
      type: "track",
      items: [track("played")],
    };
    const recentAlbum = { ...track("album"), type: "album" };
    const librarySource = source({
      discoverServers: vi.fn(async () => [server("server-a"), server("server-b")]),
      getSections: vi.fn(async () => [section("music-b")]),
      getPlaylists: vi.fn(async () => [playlist("older", 1), playlist("newer", 2)]),
      getLibraryItems: vi.fn(async () => [track("artist-index")]),
      getRecommendationHubs: vi.fn(async () => [recentlyPlayed]),
      getRecentAlbums: vi.fn(async () => [recentAlbum]),
    });

    const result = await loadInitialLibraryData("server-b", librarySource);

    expect(result).toMatchObject({
      serverId: "server-b",
      sectionKey: "music-b",
      playlists: [{ ratingKey: "newer" }, { ratingKey: "older" }],
      libraryArtists: [{ ratingKey: "artist-index" }],
      home: { recentAlbums: [{ ratingKey: "album" }] },
    });
    expect(result.home.hubs.map((hub) => hub.title)).toEqual(["Recently Played", "最近加入的音乐"]);
    expect(librarySource.getSections).toHaveBeenCalledWith("server-b");
    expect(librarySource.getLibraryItems).toHaveBeenCalledWith("server-b", "music-b", 8);
  });

  it("treats no accessible server as a completed empty initialization", async () => {
    const librarySource = source({ discoverServers: vi.fn(async () => []) });

    await expect(loadInitialLibraryData(undefined, librarySource)).resolves.toEqual({
      servers: [],
      sections: [],
      playlists: [],
      libraryArtists: [],
      home: { recentAlbums: [], hubs: [] },
    });
    expect(librarySource.getSections).not.toHaveBeenCalled();
    expect(librarySource.getPlaylists).not.toHaveBeenCalled();
  });

  it("loads playlists but skips library requests when the server exposes no music section", async () => {
    const librarySource = source({
      getSections: vi.fn(async () => []),
      getPlaylists: vi.fn(async () => [playlist("playlist-a", 1)]),
    });

    await expect(loadInitialLibraryData(undefined, librarySource)).resolves.toMatchObject({
      serverId: "server-a",
      sections: [],
      playlists: [{ ratingKey: "playlist-a" }],
      libraryArtists: [],
      home: { recentAlbums: [], hubs: [] },
    });
    expect(librarySource.getLibraryItems).not.toHaveBeenCalled();
    expect(librarySource.getRecommendationHubs).not.toHaveBeenCalled();
  });

  it("falls back to another discovered server when the preferred server cannot load", async () => {
    const getSections = vi.fn(async (serverId: string) => {
      if (serverId === "server-offline") throw new Error("首选服务器离线");
      return [section("music-online")];
    });
    const getPlaylists = vi.fn(async (serverId: string) => (
      serverId === "server-online" ? [playlist("available", 1)] : []
    ));
    const librarySource = source({
      discoverServers: vi.fn(async () => [server("server-online"), server("server-offline")]),
      getSections,
      getPlaylists,
    });

    await expect(loadInitialLibraryData("server-offline", librarySource)).resolves.toMatchObject({
      serverId: "server-online",
      sectionKey: "music-online",
      playlists: [{ ratingKey: "available" }],
    });
    expect(getSections.mock.calls.map(([serverId]) => serverId)).toEqual(["server-offline", "server-online"]);
    expect(getPlaylists.mock.calls.map(([serverId]) => serverId)).toEqual(["server-offline", "server-online"]);
  });

  it("keeps the initialization error when every discovered server fails", async () => {
    const librarySource = source({
      discoverServers: vi.fn(async () => [server("server-a"), server("server-b")]),
      getSections: vi.fn(async (serverId: string) => { throw new Error(`${serverId} 不可用`); }),
    });

    await expect(loadInitialLibraryData("server-b", librarySource)).rejects.toThrow("server-a 不可用");
  });
});

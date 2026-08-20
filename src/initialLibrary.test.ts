import { describe, expect, it, vi } from "vitest";
import {
  isInitialLibrarySnapshotScopeActive,
  loadInitialLibraryData,
  type InitialLibrarySource,
  withStartupTimeout,
} from "./initialLibrary";
import type { LibrarySection, PlexItem, PlexPlaylist, PlexServer } from "./types";

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
  it("does not reactivate a consumed startup snapshot after returning to its original source", () => {
    expect(isInitialLibrarySnapshotScopeActive(false, 0, "server-a", "server-a")).toBe(true);
    expect(isInitialLibrarySnapshotScopeActive(false, 0, "server-b", "server-a")).toBe(false);
    expect(isInitialLibrarySnapshotScopeActive(true, 0, "server-a", "server-a")).toBe(false);
    expect(isInitialLibrarySnapshotScopeActive(false, 1, "server-a", "server-a")).toBe(false);
  });

  it("loads the preferred server and home snapshot without waiting for playlists", async () => {
    const librarySource = source({
      discoverServers: vi.fn(async () => [server("server-a"), server("server-b")]),
      getSections: vi.fn(async () => [section("music-b")]),
      getPlaylists: vi.fn(async () => [playlist("older", 1), playlist("newer", 2)]),
      getLibraryItems: vi.fn(async () => [track("artist-index")]),
    });

    const result = await loadInitialLibraryData("server-b", librarySource);

    expect(result).toMatchObject({
      serverId: "server-b",
      sectionKey: "music-b",
      playlists: [],
      playlistsComplete: false,
      libraryArtists: [],
      libraryArtistsComplete: false,
      home: { recentAlbums: [], hubs: [] },
    });
    expect(librarySource.getSections).toHaveBeenCalledWith("server-b");
    expect(librarySource.getPlaylists).not.toHaveBeenCalled();
    expect(librarySource.getLibraryItems).not.toHaveBeenCalled();
    expect(librarySource.getRecommendationHubs).toHaveBeenCalledWith("server-b", "music-b");
    expect(librarySource.getRecentAlbums).toHaveBeenCalledWith("server-b", "music-b");
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

  it("returns quickly when the server exposes no music section", async () => {
    const librarySource = source({
      getSections: vi.fn(async () => []),
      getPlaylists: vi.fn(async () => [playlist("playlist-a", 1)]),
    });

    await expect(loadInitialLibraryData(undefined, librarySource)).resolves.toMatchObject({
      serverId: "server-a",
      sections: [],
      playlists: [],
      playlistsComplete: false,
      libraryArtists: [],
      home: { recentAlbums: [], hubs: [] },
    });
    expect(librarySource.getLibraryItems).not.toHaveBeenCalled();
    expect(librarySource.getPlaylists).not.toHaveBeenCalled();
    expect(librarySource.getRecommendationHubs).not.toHaveBeenCalled();
  });

  it("falls back to another discovered server when the preferred server cannot load", async () => {
    const getSections = vi.fn(async (serverId: string) => {
      if (serverId === "server-offline") throw new Error("首选服务器离线");
      return [section("music-online")];
    });
    const librarySource = source({
      discoverServers: vi.fn(async () => [server("server-online"), server("server-offline")]),
      getSections,
    });

    await expect(loadInitialLibraryData("server-offline", librarySource)).resolves.toMatchObject({
      serverId: "server-online",
      sectionKey: "music-online",
      playlists: [],
    });
    expect(getSections.mock.calls.map(([serverId]) => serverId)).toEqual(["server-offline", "server-online"]);
  });

  it("keeps the initialization error when every discovered server fails", async () => {
    const librarySource = source({
      discoverServers: vi.fn(async () => [server("server-a"), server("server-b")]),
      getSections: vi.fn(async (serverId: string) => { throw new Error(`${serverId} 不可用`); }),
    });

    await expect(loadInitialLibraryData("server-b", librarySource)).rejects.toThrow("server-a 不可用");
  });

  it("does not enter the main screen when required home data fails", async () => {
    const librarySource = source({
      getInitialLibraryArtists: vi.fn(async () => { throw new Error("artist index stalled"); }),
      getRecommendationHubs: vi.fn(async () => { throw new Error("recommendations unavailable"); }),
      getRecentAlbums: vi.fn(async () => { throw new Error("recent albums unavailable"); }),
    });

    await expect(loadInitialLibraryData(undefined, librarySource)).rejects.toThrow("recommendations unavailable");
  });

  it("turns a stalled startup operation into a retryable timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = withStartupTimeout(
        () => new Promise<never>(() => undefined),
        1000,
        "startup timed out",
      );
      const rejection = expect(pending).rejects.toThrow("startup timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

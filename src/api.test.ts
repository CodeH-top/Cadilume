import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTrackToPlaylist, artworkUrl, canWritePlaylist, createPin, createPlaylist, getArtistTracksPage, getLibraryItems, getPlaylistItems, getPlaylists, getRecommendationHubs, pollPin } from "./api";
import { formatDuration, trackAlbum, trackArtist, type PlexItem } from "./types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: {} },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("music metadata helpers", () => {
  const track: PlexItem = {
    ratingKey: "1",
    key: "/library/metadata/1",
    type: "track",
    title: "Song",
    parentTitle: "Album",
    grandparentTitle: "Artist",
  };

  it("formats Plex millisecond durations", () => {
    expect(formatDuration(185_000)).toBe("3:05");
    expect(formatDuration()).toBe("0:00");
  });

  it("uses Plex parent hierarchy for labels", () => {
    expect(trackArtist(track)).toBe("Artist");
    expect(trackAlbum(track)).toBe("Album");
  });
});

describe("Plex library sorting", () => {
  it("loads every artist/album page in PMS titleSort order and retains titleSort", async () => {
    invokeMock
      .mockResolvedValueOnce({
        MediaContainer: {
          totalSize: 3,
          Metadata: [
            { ratingKey: "1", key: "/library/metadata/1", type: "album", title: "The Album", titleSort: "Album" },
            { ratingKey: "2", key: "/library/metadata/2", type: "album", title: "Bravo", titleSort: "Bravo" },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          totalSize: 3,
          Metadata: [
            { ratingKey: "3", key: "/library/metadata/3", type: "album", title: "陈列", titleSort: "Chen Lie" },
          ],
        },
      });

    const albums = await getLibraryItems("server-a", "15", 9);

    expect(albums.map(({ ratingKey, titleSort }) => [ratingKey, titleSort])).toEqual([
      ["1", "Album"],
      ["2", "Bravo"],
      ["3", "Chen Lie"],
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "server_get", {
      serverId: "server-a",
      path: "/library/sections/15/all",
      query: {
        type: "9",
        sort: "titleSort:asc",
        "X-Plex-Container-Start": "0",
        "X-Plex-Container-Size": "500",
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "server_get", {
      serverId: "server-a",
      path: "/library/sections/15/all",
      query: {
        type: "9",
        sort: "titleSort:asc",
        "X-Plex-Container-Start": "2",
        "X-Plex-Container-Size": "500",
      },
    });
  });

  it("pages an artist's tracks by Plex album sort, disc, and track index", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: "73",
        Metadata: [
          {
            ratingKey: "track-51",
            key: "/library/metadata/track-51",
            type: "track",
            title: "Song",
            parentTitle: "Album",
            parentTitleSort: "Album",
            parentIndex: 2,
            index: 4,
          },
          { ratingKey: "album-ignored", key: "/library/metadata/album-ignored", type: "album", title: "Ignored" },
        ],
      },
    });

    const page = await getArtistTracksPage("server-a", "artist_42-1", 50, 50);

    expect(page).toMatchObject({ start: 50, nextStart: 52, totalSize: 73 });
    expect(page.items.map((item) => item.ratingKey)).toEqual(["track-51"]);
    expect(page.items[0].parentTitleSort).toBe("Album");
    expect(invokeMock).toHaveBeenCalledWith("server_get", {
      serverId: "server-a",
      path: "/library/metadata/artist_42-1/allLeaves",
      query: {
        type: "10",
        sort: "parentTitleSort:asc,parentIndex:asc,index:asc",
        "X-Plex-Container-Start": "50",
        "X-Plex-Container-Size": "50",
      },
    });
  });

  it("rejects an unsafe artist identifier before requesting PMS", async () => {
    await expect(getArtistTracksPage("server-a", "../artist", 0, 50)).rejects.toThrow("无效的 Plex 艺术家标识");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("loads non-empty supported recommendation hubs from the selected music section", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        Hub: [
          {
            title: "Recently Played",
            type: "track",
            hubIdentifier: "music.recentlyplayed.15",
            context: "hub.music.recentlyplayed",
            more: 1,
            Metadata: [{ ratingKey: "track-1", key: "/library/metadata/track-1", type: "track", title: "Song" }],
          },
          { title: "Empty", type: "album", Metadata: [] },
          { title: "Videos", type: "movie", Metadata: [{ ratingKey: "movie-1", type: "movie", title: "Movie" }] },
        ],
      },
    });

    const hubs = await getRecommendationHubs("server-a", "15");

    expect(hubs).toEqual([expect.objectContaining({
      title: "Recently Played",
      type: "track",
      identifier: "music.recentlyplayed.15",
      context: "hub.music.recentlyplayed",
      more: true,
      items: [expect.objectContaining({ ratingKey: "track-1" })],
    })]);
    expect(invokeMock).toHaveBeenCalledWith("server_get", {
      serverId: "server-a",
      path: "/hubs/sections/15",
      query: { count: "18" },
    });
  });
});

describe("Plex audio playlists", () => {
  it("normalizes boolean variants and keeps all readable audio playlists", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: "42",
            key: "/playlists/42/items",
            type: "playlist",
            title: "通勤音乐",
            playlistType: "audio",
            smart: "0",
            readOnly: false,
            leafCount: "12",
            duration: "185000",
          },
          {
            ratingKey: "43",
            key: "/playlists/43/items",
            type: "playlist",
            title: "智能推荐",
            playlistType: "audio",
            smart: 1,
            readOnly: 0,
          },
          {
            ratingKey: "44",
            key: "/playlists/44/items",
            type: "playlist",
            title: "只读收藏",
            playlistType: "audio",
            smart: "0",
            readOnly: "1",
          },
          {
            ratingKey: "45",
            key: "/playlists/45/items",
            type: "playlist",
            title: "动态推荐",
            playlistType: "audio",
            smart: "true",
            readOnly: "false",
          },
          {
            ratingKey: "46",
            key: "/playlists/46/items",
            type: "playlist",
            title: "数字标志",
            playlistType: "AUDIO",
            smart: 0,
            readOnly: "0",
          },
          {
            ratingKey: "47",
            type: "playlist",
            title: "省略可选标志",
            playlistType: "audio",
          },
          {
            ratingKey: "48",
            key: "/playlists/48/items",
            type: "playlist",
            title: "数字只读标志",
            playlistType: "audio",
            smart: false,
            readOnly: 1,
          },
          {
            ratingKey: "video-49",
            type: "playlist",
            title: "电影片单",
            playlistType: "video",
            smart: false,
          },
          {
            ratingKey: "folder-50",
            type: "playlistfolder",
            title: "播放列表目录",
            playlistType: "audio",
            smart: false,
          },
          {
            ratingKey: "invalid-51",
            type: "playlist",
            title: "无效智能标志",
            playlistType: "audio",
            smart: "sometimes",
          },
          {
            ratingKey: "invalid-52",
            type: "playlist",
            title: "无效只读标志",
            playlistType: "audio",
            smart: false,
            readOnly: 2,
          },
          {
            ratingKey: "../invalid-53",
            type: "playlist",
            title: "无效播放列表标识",
            playlistType: "audio",
            smart: false,
            readOnly: false,
          },
        ],
      },
    });

    const playlists = await getPlaylists("server-a");
    expect(playlists.map(({ ratingKey, smart, readOnly }) => ({ ratingKey, smart, readOnly }))).toEqual([
      { ratingKey: "42", smart: false, readOnly: false },
      { ratingKey: "43", smart: true, readOnly: false },
      { ratingKey: "44", smart: false, readOnly: true },
      { ratingKey: "45", smart: true, readOnly: false },
      { ratingKey: "46", smart: false, readOnly: false },
      { ratingKey: "47", smart: false, readOnly: false },
      { ratingKey: "48", smart: false, readOnly: true },
    ]);
    expect(playlists[0]).toMatchObject({ leafCount: 12, duration: 185000 });
    expect(playlists[4].playlistType).toBe("audio");
    expect(playlists[5].key).toBe("/playlists/47/items");
    expect(playlists.filter(canWritePlaylist).map((playlist) => playlist.ratingKey)).toEqual(["42", "46", "47"]);
    expect(invokeMock).toHaveBeenCalledWith("get_playlists", {
      serverId: "server-a",
    });
  });

  it("requests items by clean identifier and ignores non-track rows", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          { ratingKey: "track-1", key: "/library/metadata/track-1", type: "track", title: "One" },
          { ratingKey: "album-1", key: "/library/metadata/album-1", type: "album", title: "Album" },
          null,
          { ratingKey: "track-2", key: "/library/metadata/track-2", type: "track", title: "Two" },
        ],
      },
    });

    const items = await getPlaylistItems("server-a", "playlist_42-1");

    expect(items.map((item) => item.ratingKey)).toEqual(["track-1", "track-2"]);
    expect(invokeMock).toHaveBeenCalledWith("get_playlist_items", {
      serverId: "server-a",
      playlistId: "playlist_42-1",
    });
  });

  it("creates a trimmed regular audio playlist through the scoped Rust command", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [{
          ratingKey: "playlist-99",
          key: "/playlists/playlist-99/items",
          type: "playlist",
          title: "通勤音乐",
          playlistType: "audio",
          smart: false,
          readOnly: false,
          leafCount: 0,
        }],
      },
    });

    const playlist = await createPlaylist("server-a", "  通勤音乐  ");

    expect(playlist).toMatchObject({
      ratingKey: "playlist-99",
      title: "通勤音乐",
      playlistType: "audio",
      smart: false,
      readOnly: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("create_playlist", {
      serverId: "server-a",
      title: "通勤音乐",
    });
  });

  it("rejects invalid playlist creation input before invoking Tauri", async () => {
    for (const title of ["", "   ", "含\n换行", "歌".repeat(256)]) {
      await expect(createPlaylist("server-a", title)).rejects.toThrow("播放列表名称必须为 1–255 个有效字符");
    }
    await expect(createPlaylist("../server", "有效名称")).rejects.toThrow("无效的 Plex 服务器标识");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("creates and refreshes an empty playlist in browser demo mode", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    const created = await createPlaylist("demo-server", "验收新播放列表");
    const playlists = await getPlaylists("demo-server");

    expect(created).toMatchObject({
      title: "验收新播放列表",
      playlistType: "audio",
      smart: false,
      readOnly: false,
      leafCount: 0,
    });
    expect(playlists.some((playlist) => playlist.ratingKey === created.ratingKey)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers before invoking Tauri", async () => {
    for (const playlistId of ["", "../42", "42/items", "42?x=1", "42#items", "42 items", "a".repeat(257)]) {
      await expect(getPlaylistItems("server-a", playlistId)).rejects.toThrow("无效的 Plex 播放列表标识");
    }
    await expect(getPlaylistItems("../server", "playlist-42")).rejects.toThrow("无效的 Plex 播放列表标识");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("provides scroll-sized regular, smart, and read-only demo playlists without invoking Tauri", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    const playlists = await getPlaylists("demo-server");
    expect(playlists.length).toBeGreaterThan(10);

    const regular = playlists.find((playlist) => canWritePlaylist(playlist) && (playlist.leafCount ?? 0) > 0);
    const smart = playlists.find((playlist) => playlist.smart);
    const readOnly = playlists.find((playlist) => playlist.readOnly);
    expect(regular).toBeDefined();
    expect(smart).toBeDefined();
    expect(readOnly).toBeDefined();

    for (const playlist of [regular, smart, readOnly]) {
      const items = await getPlaylistItems("demo-server", playlist!.ratingKey);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.type === "track")).toBe(true);
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("passes the playlist and track identifiers to the Rust command unchanged", async () => {
    await addTrackToPlaylist("server-a", "987654321012345678", "track-17");

    expect(invokeMock).toHaveBeenCalledWith("add_to_playlist", {
      serverId: "server-a",
      playlistId: "987654321012345678",
      ratingKey: "track-17",
    });
  });
});

describe("Plex PIN authentication boundary", () => {
  it("uses only an authenticated flag in browser demo responses", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    const created = await createPin();
    const authenticated = await pollPin(created.id);

    expect(created).toEqual({ id: 1, code: "DEMO", expiresIn: 300, authenticated: false });
    expect(authenticated).toEqual({ id: 1, code: "DEMO", expiresIn: 300, authenticated: true });
    expect(created).not.toHaveProperty("authToken");
    expect(authenticated).not.toHaveProperty("authToken");
  });
});

describe("artworkUrl dimensions and runtime boundary", () => {
  it("uses the artwork ticket command with square or explicit dimensions", async () => {
    const ticketUrl = `http://127.0.0.1:49152/artwork/${"a".repeat(64)}`;
    invokeMock.mockResolvedValue(ticketUrl);

    await expect(artworkUrl("server-a", "/library/metadata/1/thumb", 320)).resolves.toBe(ticketUrl);
    expect(invokeMock).toHaveBeenLastCalledWith("artwork_url", {
      serverId: "server-a",
      path: "/library/metadata/1/thumb",
      width: 320,
      height: 320,
    });

    await artworkUrl("server-a", "/library/metadata/1/art", 1440, 900);
    expect(invokeMock).toHaveBeenLastCalledWith("artwork_url", {
      serverId: "server-a",
      path: "/library/metadata/1/art",
      width: 1440,
      height: 900,
    });
  });

  it("returns the original path without invoking Tauri in the browser demo", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    const path = "/library/metadata/1/thumb";

    await expect(artworkUrl("demo-server", path, 320)).resolves.toBe(path);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTrackToPlaylist, addTracksToPlaylist, artworkUrl, canWritePlaylist, checkAppUpdate, createPin, createPlaylist, deletePlaylist, getArtistTracksPage, getLibraryItems, getLibraryMetadata, getPlaylistItems, getPlaylists, getRecommendationHubs, getTrackMetadata, getTracksPage, installAppUpdate, movePlaylistItem, nativeAudioClearQueue, nativeAudioSetArtwork, normalizePlexContributors, normalizePlexTrackArtists, pollPin, removeTracksFromPlaylist, setAutoUpdateEnabled, setBrandPreset, setCloseBehavior, setDeviceName, setStatusIconEnabled, updatePlaylist } from "./api";
import { formatDuration, trackAlbum, trackArtist, type PlexItem } from "./types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class<T> {
    onmessage: (message: T) => void;

    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage;
    }
  },
}));
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
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });

  it("uses Plex parent hierarchy for labels", () => {
    expect(trackArtist(track)).toBe("Artist");
    expect(trackAlbum(track)).toBe("Album");
  });
});

describe("window close behavior", () => {
  it("persists the selected close behavior through the native command", async () => {
    invokeMock.mockResolvedValueOnce("tray");

    await expect(setCloseBehavior("tray")).resolves.toBe("tray");

    expect(invokeMock).toHaveBeenCalledWith("set_close_behavior", { behavior: "tray" });
  });
});

describe("PMS structured contributors", () => {
  it("normalizes Role and Contributor data without splitting slash names or retaining invalid duplicates", () => {
    const contributors = normalizePlexContributors({
      Role: [
        { tag: "Mira Lin", tagKey: "artist-2" },
        { title: "AC/DC" },
        { name: "Mira Lin", ratingKey: "artist-2" },
        { tag: "  " },
      ],
      Contributor: [{ displayName: "Kobe Bryant" }],
    });

    expect(contributors).toEqual([
      { name: "Mira Lin", ratingKey: "artist-2" },
      { name: "AC/DC", ratingKey: undefined },
      { name: "Kobe Bryant", ratingKey: undefined },
    ]);
  });

  it("uses PMS originalTitle as one exact track-level credit when no structured list exists", () => {
    expect(normalizePlexTrackArtists({
      type: "track",
      grandparentTitle: "Album Artist",
      originalTitle: "AC/DC",
    })).toEqual([{ name: "AC/DC" }]);
  });

  it("uses originalTitle before structured PMS members when both are present", () => {
    expect(normalizePlexTrackArtists({
      type: "track",
      originalTitle: "S.H.E / 飞轮海",
      Role: [{ tag: "S.H.E", tagKey: "artist-she" }, { tag: "飞轮海", tagKey: "artist-fahrenheit" }],
    })).toEqual([{ name: "S.H.E / 飞轮海" }]);
  });

  it("preserves normalized Role members when a PMS track page enters the shared data layer", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 1,
        Metadata: [{
          ratingKey: "track-structured",
          key: "/library/metadata/track-structured",
          type: "track",
          title: "Collaboration",
          Role: [{ tag: "Mira Lin", tagKey: "artist-2" }, { tag: "Guest Artist" }],
        }],
      },
    });

    const page = await getTracksPage("server-a", "15", 0, 50);

    expect(page.items[0].trackArtists).toEqual([
      { name: "Mira Lin", ratingKey: "artist-2" },
      { name: "Guest Artist", ratingKey: undefined },
    ]);
  });

  it("keeps the track artist separate from the album artist in normalized PMS metadata", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 1,
        Metadata: [{
          ratingKey: "track-distinct-artists",
          key: "/library/metadata/track-distinct-artists",
          type: "track",
          title: "Collaboration",
          grandparentTitle: "Album Artist",
          grandparentRatingKey: "album-artist",
          originalTitle: "Track Artist",
        }],
      },
    });

    const page = await getTracksPage("server-a", "15", 0, 50);

    expect(page.items[0]).toMatchObject({
      grandparentTitle: "Album Artist",
      originalTitle: "Track Artist",
      trackArtists: [{ name: "Track Artist" }],
    });
    expect(trackArtist(page.items[0])).toBe("Track Artist");
  });

  it("keeps multi-artist preview metadata intact when the demo track is resolved again", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search: "?multi-artist-preview=1" } },
    });

    await expect(getTrackMetadata("demo-server", "track-0")).resolves.toMatchObject({
      trackArtists: [
        { name: "The Paper Moons", ratingKey: "artist-0" },
        { name: "Kobe Bryant" },
        { name: "AC/DC" },
      ],
    });
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

  it("forwards an explicit singer table sort to the complete PMS pagination query", async () => {
    invokeMock.mockResolvedValueOnce({ MediaContainer: { totalSize: 0, Metadata: [] } });

    await getArtistTracksPage("server-a", "artist_42-1", 0, 50, { key: "duration", direction: "desc" });

    expect(invokeMock).toHaveBeenCalledWith("server_get", {
      serverId: "server-a",
      path: "/library/metadata/artist_42-1/allLeaves",
      query: {
        type: "10",
        sort: "duration:desc,titleSort:asc",
        "X-Plex-Container-Start": "0",
        "X-Plex-Container-Size": "50",
      },
    });
  });

  it("pages the complete main music library through PMS before rendering one page", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: "143",
        Metadata: [
          { ratingKey: "track-51", key: "/library/metadata/track-51", type: "track", title: "Song" },
          { ratingKey: "album-ignored", key: "/library/metadata/album-ignored", type: "album", title: "Ignored" },
        ],
      },
    });

    const page = await getTracksPage("server-a", "15", 50, 50, { key: "album", direction: "desc" });

    expect(page).toMatchObject({ start: 50, nextStart: 52, totalSize: 143 });
    expect(page.items.map((item) => item.ratingKey)).toEqual(["track-51"]);
    expect(invokeMock).toHaveBeenCalledWith("server_get", {
      serverId: "server-a",
      path: "/library/sections/15/all",
      query: {
        type: "10",
        sort: "parentTitleSort:desc,titleSort:asc",
        "X-Plex-Container-Start": "50",
        "X-Plex-Container-Size": "50",
      },
    });
  });

  it("resolves a direct detail route by safe metadata identifier", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [{ ratingKey: "album_42-1", key: "/library/metadata/album_42-1", type: "album", title: "Album" }],
      },
    });

    await expect(getLibraryMetadata("server-a", "album_42-1")).resolves.toMatchObject({ title: "Album" });
    expect(invokeMock).toHaveBeenCalledWith("server_get", {
      serverId: "server-a",
      path: "/library/metadata/album_42-1",
      query: {},
    });
    await expect(getLibraryMetadata("server-a", "../unsafe")).rejects.toThrow("无效的 Plex 媒体标识");
  });

  it("keeps generated artist-density fixtures navigable in the browser demo", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search: "?artist-preview=36" } },
    });

    const artists = await getLibraryItems("demo-server", "1", 8);
    const fixture = artists.find((item) => item.ratingKey === "artist-fixture-1");

    expect(fixture).toMatchObject({ title: "Aster Artist 01" });
    await expect(getLibraryMetadata("demo-server", "artist-fixture-1")).resolves.toMatchObject({
      ratingKey: "artist-fixture-1",
      title: "Aster Artist 01",
    });
  });

  it("rejects an unsafe artist identifier before requesting PMS", async () => {
    await expect(getArtistTracksPage("server-a", "../artist", 0, 50)).rejects.toThrow("无效的 Plex 歌手标识");
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
      query: { count: "12" },
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
            title: "歌单目录",
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
            title: "无效歌单标识",
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

  it("creates a trimmed regular audio playlist with its summary through the scoped Rust command", async () => {
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

    const playlist = await createPlaylist("server-a", "  通勤音乐  ", "  城市移动时听\n保持清醒  ");

    expect(playlist).toMatchObject({
      ratingKey: "playlist-99",
      title: "通勤音乐",
      summary: "城市移动时听\n保持清醒",
      playlistType: "audio",
      smart: false,
      readOnly: false,
    });
    expect(invokeMock).toHaveBeenCalledWith("create_playlist", {
      serverId: "server-a",
      title: "通勤音乐",
      summary: "城市移动时听\n保持清醒",
      seedRatingKey: undefined,
      clearItems: false,
    });
  });

  it("passes a compatibility seed and empty-playlist cleanup request to the Rust command", async () => {
    invokeMock.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [{
          ratingKey: "playlist-100",
          key: "/playlists/playlist-100/items",
          type: "playlist",
          title: "空白歌单",
          playlistType: "audio",
          smart: false,
          readOnly: false,
          leafCount: 0,
        }],
      },
    });

    await createPlaylist("server-a", "空白歌单", "", {
      seedRatingKey: "track-1",
      clearItemsAfterCreate: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("create_playlist", {
      serverId: "server-a",
      title: "空白歌单",
      summary: "",
      seedRatingKey: "track-1",
      clearItems: true,
    });
  });

  it("rejects invalid playlist creation input before invoking Tauri", async () => {
    for (const title of ["", "   ", "含\n换行", "歌".repeat(256)]) {
      await expect(createPlaylist("server-a", title)).rejects.toThrow("歌单名称必须为 1–255 个有效字符");
    }
    await expect(createPlaylist("server-a", "有效名称", "\u0000")).rejects.toThrow("歌单描述最多为 1000 个有效字符");
    await expect(createPlaylist("server-a", "有效名称", "描述".repeat(501))).rejects.toThrow("歌单描述最多为 1000 个有效字符");
    await expect(createPlaylist("../server", "有效名称")).rejects.toThrow("无效的 Plex 服务器标识");
    await expect(createPlaylist("server-a", "有效名称", "", { seedRatingKey: "../track" })).rejects.toThrow("无效的 Plex 歌曲标识");
    await expect(createPlaylist("server-a", "有效名称", "", { clearItemsAfterCreate: true })).rejects.toThrow("创建空歌单缺少兼容用的歌曲");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("creates and refreshes an empty playlist in browser demo mode", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    const created = await createPlaylist("demo-server", "验收新歌单", "用于浏览器演示");
    const playlists = await getPlaylists("demo-server");

    expect(created).toMatchObject({
      title: "验收新歌单",
      summary: "用于浏览器演示",
      playlistType: "audio",
      smart: false,
      readOnly: false,
      leafCount: 0,
    });
    expect(playlists.some((playlist) => playlist.ratingKey === created.ratingKey)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("creates seeded demo playlists, clears compatibility seeds, and removes their tracks", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    const seedTrack = (await getTracksPage("demo-server", "demo-section", 0, 1)).items[0];
    expect(seedTrack).toBeDefined();

    const seeded = await createPlaylist("demo-server", "含一首歌曲", "", { seedRatingKey: seedTrack!.ratingKey });
    expect(seeded.leafCount).toBe(1);
    await expect(getPlaylistItems("demo-server", seeded.ratingKey)).resolves.toMatchObject([
      { ratingKey: seedTrack!.ratingKey },
    ]);

    const empty = await createPlaylist("demo-server", "兼容空歌单", "", {
      seedRatingKey: seedTrack!.ratingKey,
      clearItemsAfterCreate: true,
    });
    expect(empty.leafCount).toBe(0);
    await expect(getPlaylistItems("demo-server", empty.ratingKey)).resolves.toEqual([]);

    const removed = await removeTracksFromPlaylist("demo-server", seeded.ratingKey, [seedTrack!.ratingKey]);
    expect(removed).toEqual({ requested: 1, removed: 1, failedItemIds: [] });
    await expect(getPlaylistItems("demo-server", seeded.ratingKey)).resolves.toEqual([]);
    expect((await getPlaylists("demo-server")).find((playlist) => playlist.ratingKey === seeded.ratingKey)).toMatchObject({ leafCount: 0, duration: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("removes playlist items through the scoped Rust command", async () => {
    invokeMock.mockResolvedValueOnce({ requested: 2, removed: 1, failedItemIds: ["item-2"] });

    const result = await removeTracksFromPlaylist("server-a", "playlist-99", ["item-1", "item-2"]);

    expect(result).toEqual({ requested: 2, removed: 1, failedItemIds: ["item-2"] });
    expect(invokeMock).toHaveBeenCalledWith("remove_playlist_items", {
      serverId: "server-a",
      playlistId: "playlist-99",
      playlistItemIds: ["item-1", "item-2"],
    });
  });

  it("rejects malformed identifiers before invoking Tauri", async () => {
    for (const playlistId of ["", "../42", "42/items", "42?x=1", "42#items", "42 items", "a".repeat(257)]) {
      await expect(getPlaylistItems("server-a", playlistId)).rejects.toThrow("无效的 Plex 歌单标识");
    }
    await expect(getPlaylistItems("../server", "playlist-42")).rejects.toThrow("无效的 Plex 歌单标识");
    await expect(removeTracksFromPlaylist("server-a", "../playlist", ["item-1"])).rejects.toThrow("无效的 Plex 歌单标识");
    await expect(removeTracksFromPlaylist("../server", "playlist-42", ["item-1"])).rejects.toThrow("无效的 Plex 歌单标识");
    await expect(removeTracksFromPlaylist("server-a", "playlist-42", [])).rejects.toThrow("请至少选择一首歌曲");
    await expect(removeTracksFromPlaylist("server-a", "playlist-42", ["../item"])).rejects.toThrow("请至少选择一首歌曲");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("accepts numeric playlist item ids returned by PMS as strings", async () => {
    invokeMock.mockResolvedValueOnce({ requested: 1, removed: 1, failedItemIds: [] });

    const result = await removeTracksFromPlaylist("server-a", "playlist-99", [123 as unknown as string]);

    expect(result).toEqual({ requested: 1, removed: 1, failedItemIds: [] });
    expect(invokeMock).toHaveBeenCalledWith("remove_playlist_items", {
      serverId: "server-a",
      playlistId: "playlist-99",
      playlistItemIds: ["123"],
    });
  });

  it("moves one concrete playlist occurrence through the scoped Rust command", async () => {
    invokeMock.mockResolvedValue(undefined);

    await movePlaylistItem("server-a", "playlist-99", "item-3", "item-1");
    await movePlaylistItem("server-a", "playlist-99", "item-3");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "move_playlist_item", {
      serverId: "server-a",
      playlistId: "playlist-99",
      playlistItemId: "item-3",
      afterPlaylistItemId: "item-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "move_playlist_item", {
      serverId: "server-a",
      playlistId: "playlist-99",
      playlistItemId: "item-3",
      afterPlaylistItemId: undefined,
    });
  });

  it("rejects malformed or self-referential playlist moves before invoking Tauri", async () => {
    await expect(movePlaylistItem("server-a", "playlist-99", "../item", "item-1")).rejects.toThrow("无效的 Plex 歌单排序标识");
    await expect(movePlaylistItem("server-a", "playlist-99", "item-1", "../item")).rejects.toThrow("无效的 Plex 歌单排序标识");
    await expect(movePlaylistItem("server-a", "playlist-99", "item-1", "item-1")).rejects.toThrow("无效的 Plex 歌单排序标识");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("updates playlist title and summary through the scoped Rust command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await updatePlaylist("server-a", "playlist-99", { title: "新标题", summary: "新描述" });

    expect(invokeMock).toHaveBeenCalledWith("update_playlist", {
      serverId: "server-a",
      playlistId: "playlist-99",
      title: "新标题",
      summary: "新描述",
    });
  });

  it("deletes a playlist through the scoped Rust command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await deletePlaylist("server-a", "playlist-99");

    expect(invokeMock).toHaveBeenCalledWith("delete_playlist", {
      serverId: "server-a",
      playlistId: "playlist-99",
    });
  });

  it("rejects malformed playlist ids for update and delete", async () => {
    await expect(updatePlaylist("server-a", "../bad", { title: "x" })).rejects.toThrow("无效的 Plex 歌单标识");
    await expect(deletePlaylist("server-a", "../bad")).rejects.toThrow("无效的 Plex 歌单标识");
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

  it("deduplicates an ordered batch before invoking the native playlist command", async () => {
    invokeMock.mockResolvedValueOnce({ requested: 2, added: 1, failedRatingKeys: ["track-2"] });

    await expect(addTracksToPlaylist("server-a", "playlist-1", ["track-1", "track-2", "track-1"])).resolves.toEqual({
      requested: 2,
      added: 1,
      failedRatingKeys: ["track-2"],
    });
    expect(invokeMock).toHaveBeenCalledWith("add_tracks_to_playlist", {
      serverId: "server-a",
      playlistId: "playlist-1",
      ratingKeys: ["track-1", "track-2"],
    });
  });

  it("rejects an empty or malformed batch before invoking Tauri", async () => {
    await expect(addTracksToPlaylist("server-a", "playlist-1", [])).rejects.toThrow("请至少选择一首歌曲");
    await expect(addTracksToPlaylist("server-a", "playlist-1", ["../track"])).rejects.toThrow("无效的 Plex 歌曲标识");
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

describe("Cadilume visual presets", () => {
  it("persists the fixed visual preset through its dedicated native command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(setBrandPreset("azure")).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("set_brand_preset", { preset: "azure" });
  });
});

describe("Cadilume 系统状态图标", () => {
  it("persists the native status icon preference through its dedicated command", async () => {
    invokeMock.mockResolvedValueOnce(false);

    await expect(setStatusIconEnabled(false)).resolves.toBe(false);

    expect(invokeMock).toHaveBeenCalledWith("set_status_icon_enabled", { enabled: false });
  });
});

describe("Cadilume 应用更新", () => {
  it("checks GitHub release metadata through the dedicated native command", async () => {
    const update = { version: "0.2.0", currentVersion: "0.1.2", notes: "更新说明" };
    invokeMock.mockResolvedValueOnce(update);

    await expect(checkAppUpdate()).resolves.toEqual(update);

    expect(invokeMock).toHaveBeenCalledWith("check_app_update");
  });

  it("passes updater progress through an ordered Tauri channel", async () => {
    const onEvent = vi.fn();
    invokeMock.mockImplementationOnce(async (_command, payload: { onEvent: { onmessage: (message: unknown) => void } }) => {
      payload.onEvent.onmessage({ event: "progress", downloaded: 512, contentLength: 1_024 });
    });

    await installAppUpdate(onEvent);

    expect(invokeMock).toHaveBeenCalledWith("install_app_update", { onEvent: expect.any(Object) });
    expect(onEvent).toHaveBeenCalledWith({ event: "progress", downloaded: 512, contentLength: 1_024 });
  });

  it("persists the automatic update preference in Rust", async () => {
    invokeMock.mockResolvedValueOnce(false);

    await expect(setAutoUpdateEnabled(false)).resolves.toBe(false);

    expect(invokeMock).toHaveBeenCalledWith("set_auto_update_enabled", { enabled: false });
  });
});

describe("Cadilume device name", () => {
  it("normalizes the editable name and persists it through the dedicated native command", async () => {
    invokeMock.mockResolvedValueOnce("客厅 Mac");

    await expect(setDeviceName("  客厅   Mac  ")).resolves.toBe("客厅 Mac");

    expect(invokeMock).toHaveBeenCalledWith("set_device_name", { deviceName: "客厅 Mac" });
  });

  it("rejects unsafe values before they can reach Tauri", async () => {
    await expect(setDeviceName("客厅\nMac")).rejects.toThrow("设备名称需为 1–80 个有效字符");
    await expect(setDeviceName("设".repeat(81))).rejects.toThrow("设备名称需为 1–80 个有效字符");
    expect(invokeMock).not.toHaveBeenCalled();
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

  it("attaches a delayed ticket to the matching native queue item", async () => {
    invokeMock.mockResolvedValue(undefined);
    const ticket = `http://127.0.0.1:49152/artwork/${"b".repeat(64)}`;

    await nativeAudioSetArtwork(3, "track-42", "queue-42", ticket);

    expect(invokeMock).toHaveBeenCalledWith("native_audio_set_artwork", {
      index: 3,
      ratingKey: "track-42",
      occurrenceId: "queue-42",
      artworkUrl: ticket,
    });
  });
});

describe("native playback queue boundary", () => {
  it("clears the playback queue without touching the audio cache command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await nativeAudioClearQueue();

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("native_audio_clear_queue");
  });
});

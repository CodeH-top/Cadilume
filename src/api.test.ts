import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTrackToPlaylist, artworkUrl, createPin, getPlaylists, pollPin } from "./api";
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

describe("Plex audio playlists", () => {
  it("keeps only writable regular audio playlists from the account-scoped response", async () => {
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
            leafCount: "12",
            duration: "185000",
          },
          {
            ratingKey: "43",
            key: "/playlists/43/items",
            type: "playlist",
            title: "智能推荐",
            playlistType: "audio",
            smart: "1",
          },
          {
            ratingKey: "44",
            key: "/playlists/44/items",
            type: "playlist",
            title: "电影片单",
            playlistType: "video",
            smart: "0",
          },
          {
            ratingKey: "45",
            key: "/playlists/45/items",
            type: "playlist",
            title: "别人分享的歌单",
            playlistType: "audio",
            smart: false,
            readOnly: true,
          },
          {
            ratingKey: "46",
            key: "/playlists/46/items",
            type: "playlistfolder",
            title: "歌单目录",
            playlistType: "audio",
            smart: false,
          },
          {
            ratingKey: "47",
            key: "/playlists/47/items",
            type: "playlist",
            title: "属性不完整的歌单",
            playlistType: "audio",
          },
        ],
      },
    });

    const playlist = await getPlaylists("server-a");
    expect(playlist).toHaveLength(1);
    expect(playlist[0]).toMatchObject({
      ratingKey: "42",
      title: "通勤音乐",
      playlistType: "audio",
      smart: false,
      readOnly: false,
      leafCount: 12,
      duration: 185000,
    });
    expect(invokeMock).toHaveBeenCalledWith("get_playlists", {
      serverId: "server-a",
    });
  });

  it("does not invoke Tauri in the browser demo runtime", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    await expect(getPlaylists("demo-server")).resolves.toEqual([]);
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

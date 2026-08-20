import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InitialLibraryData } from "./initialLibrary";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./api", () => ({
  discoverServers: vi.fn(),
  getLibraryItems: vi.fn(),
  getPlaylists: vi.fn(),
  getRecentAlbums: vi.fn(),
  getRecommendationHubs: vi.fn(),
  getSections: vi.fn(),
  isDesktopRuntime: () => true,
}));

import { readInitialLibraryCache, writeInitialLibraryCache } from "./initialLibraryCache";

const library = {
  servers: [{ id: "server-a", name: "Server", owned: true, home: false, connectionUri: "https://server.test", local: true, relay: false, secure: true }],
  serverId: "server-a",
  sections: [{ key: "1", title: "Music", type: "artist" }],
  sectionKey: "1",
  playlists: [],
  playlistsComplete: true,
  libraryArtists: [],
  libraryArtistsComplete: true,
  home: {
    recentAlbums: [{
      ratingKey: "album-a",
      key: "/library/metadata/album-a/children",
      type: "album",
      title: "Album",
      thumb: "/library/metadata/album-a/thumb/1",
      imageUrl: "http://127.0.0.1:4000/artwork/expired",
    }],
    hubs: [],
  },
  homeComplete: true,
} satisfies InitialLibraryData;

describe("initial library cache artwork", () => {
  beforeEach(() => invoke.mockReset());

  it("never persists runtime loopback artwork tickets", async () => {
    invoke.mockResolvedValue(undefined);
    await writeInitialLibraryCache(library);

    const payload = invoke.mock.calls[0]?.[1];
    expect(JSON.stringify(payload)).not.toContain("imageUrl");
    expect(JSON.stringify(payload)).not.toContain("127.0.0.1");
  });

  it("drops stale runtime artwork tickets from older snapshots", async () => {
    invoke.mockResolvedValue(library);
    const restored = await readInitialLibraryCache();

    expect(restored?.home.recentAlbums[0]?.imageUrl).toBeUndefined();
    expect(restored?.home.recentAlbums[0]?.thumb).toBe("/library/metadata/album-a/thumb/1");
  });
});

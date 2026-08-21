import { beforeEach, describe, expect, it, vi } from "vitest";

const { artworkUrl } = vi.hoisted(() => ({
  artworkUrl: vi.fn<(
    serverId: string,
    path: string,
    width: number,
    height?: number,
    cacheIdentity?: string,
  ) => Promise<string>>(),
}));

vi.mock("./api", () => ({ artworkUrl }));

import {
  artworkCacheIdentity,
  clearArtworkTicketCache,
  getResolvedArtwork,
  invalidateCachedArtwork,
  prewarmArtwork,
  requestCachedArtwork,
} from "./artworkCache";

describe("shared artwork ticket cache", () => {
  beforeEach(() => {
    clearArtworkTicketCache();
    artworkUrl.mockReset();
  });

  it("reuses one cached ticket across card, player, and system artwork sizes", async () => {
    artworkUrl.mockResolvedValue("http://127.0.0.1:4000/artwork/ticket");

    const card = requestCachedArtwork("server-a", "/thumb/a", 420, 420);
    const player = requestCachedArtwork("server-a", "/thumb/a", 96, 96);
    const system = requestCachedArtwork("server-a", "/thumb/a", 512, 512);

    await expect(Promise.all([card, player, system])).resolves.toEqual([
      "http://127.0.0.1:4000/artwork/ticket",
      "http://127.0.0.1:4000/artwork/ticket",
      "http://127.0.0.1:4000/artwork/ticket",
    ]);
    expect(artworkUrl).toHaveBeenCalledTimes(1);
    expect(artworkUrl).toHaveBeenCalledWith("server-a", "/thumb/a", 420, 420);
    expect(getResolvedArtwork("server-a", "/thumb/a")).toBe("http://127.0.0.1:4000/artwork/ticket");
  });

  it("prewarms restored queue artwork once per album and aliases every track path", async () => {
    artworkUrl.mockImplementation(async (_serverId, path, width, height) => (
      `http://127.0.0.1:4000/artwork/${path.slice(1)}-${width}x${height}`
    ));

    const firstAlbum = Array.from({ length: 500 }, () => ({
      parentRatingKey: "album-1",
      thumb: "/thumb/album-1",
    }));
    await prewarmArtwork("server-a", [
      ...firstAlbum,
      { parentRatingKey: "album-2", composite: "/composite/album-2" },
    ], 2);

    expect(artworkUrl).toHaveBeenCalledTimes(2);
    expect(artworkUrl).toHaveBeenCalledWith(
      "server-a",
      "/thumb/album-1",
      420,
      420,
      "album:album-1",
    );
    expect(artworkUrl).toHaveBeenCalledWith(
      "server-a",
      "/composite/album-2",
      420,
      420,
      "album:album-2",
    );
    expect(getResolvedArtwork(
      "server-a",
      "/thumb/album-1",
      512,
      512,
      artworkCacheIdentity({ parentRatingKey: "album-1" }),
    ))
      .toContain("/artwork/thumb/album-1-420x420");
    await requestCachedArtwork(
      "server-a",
      "/thumb/album-1",
      96,
      96,
      artworkCacheIdentity({ parentRatingKey: "album-1" }),
    );
    expect(artworkUrl).toHaveBeenCalledTimes(2);
  });

  it("replaces one album record when its PMS artwork revision path changes", async () => {
    artworkUrl
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/album-old")
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/album-new");
    const cacheIdentity = artworkCacheIdentity({ parentRatingKey: "album-1" });

    await requestCachedArtwork("server-a", "/thumb/album-1/old", 96, 96, cacheIdentity);
    await requestCachedArtwork("server-a", "/thumb/album-1/new", 96, 96, cacheIdentity);

    expect(artworkUrl).toHaveBeenCalledTimes(2);
    expect(getResolvedArtwork("server-a", "/thumb/album-1/old", 96, 96, cacheIdentity))
      .toBeUndefined();
    expect(getResolvedArtwork("server-a", "/thumb/album-1/new", 96, 96, cacheIdentity))
      .toBe("http://127.0.0.1:4000/artwork/album-new");
  });

  it("upgrades a path owner when a larger square is actually required", async () => {
    artworkUrl
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/canonical")
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/large");

    await requestCachedArtwork("server-a", "/thumb/a", 96, 96);
    await requestCachedArtwork("server-a", "/thumb/a", 640, 640);

    expect(artworkUrl).toHaveBeenNthCalledWith(1, "server-a", "/thumb/a", 420, 420);
    expect(artworkUrl).toHaveBeenNthCalledWith(2, "server-a", "/thumb/a", 640, 640);
    expect(getResolvedArtwork("server-a", "/thumb/a", 640, 640))
      .toBe("http://127.0.0.1:4000/artwork/large");
  });

  it("requests a fresh ticket only after explicit invalidation", async () => {
    artworkUrl
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/first")
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/second");

    await requestCachedArtwork("server-a", "/thumb/a", 420, 420);
    invalidateCachedArtwork("server-a", "/thumb/a", 420, 420);
    await expect(requestCachedArtwork("server-a", "/thumb/a", 96, 96))
      .resolves.toBe("http://127.0.0.1:4000/artwork/second");
    expect(artworkUrl).toHaveBeenCalledTimes(2);
  });

  it("evicts rejected requests so a later cache retry can recover", async () => {
    artworkUrl
      .mockRejectedValueOnce(new Error("cache unavailable"))
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/recovered");

    await expect(requestCachedArtwork("server-a", "/thumb/a", 420, 420)).rejects.toThrow("cache unavailable");
    await expect(requestCachedArtwork("server-a", "/thumb/a", 96, 96))
      .resolves.toBe("http://127.0.0.1:4000/artwork/recovered");
    expect(artworkUrl).toHaveBeenCalledTimes(2);
  });

  it("does not let an invalidated late success replace the current ticket", async () => {
    let resolveFirst!: (url: string) => void;
    const firstResponse = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    artworkUrl
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/current");

    const stale = requestCachedArtwork("server-a", "/thumb/a", 420, 420);
    invalidateCachedArtwork("server-a", "/thumb/a", 420, 420);
    await requestCachedArtwork("server-a", "/thumb/a", 96, 96);
    resolveFirst("http://127.0.0.1:4000/artwork/stale");
    await stale;

    expect(getResolvedArtwork("server-a", "/thumb/a"))
      .toBe("http://127.0.0.1:4000/artwork/current");
  });

  it("does not let an invalidated late failure clear the current ticket", async () => {
    let rejectFirst!: (reason: Error) => void;
    const firstResponse = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    artworkUrl
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce("http://127.0.0.1:4000/artwork/current");

    const stale = requestCachedArtwork("server-a", "/thumb/a", 420, 420);
    invalidateCachedArtwork("server-a", "/thumb/a", 420, 420);
    await requestCachedArtwork("server-a", "/thumb/a", 96, 96);
    rejectFirst(new Error("stale failure"));
    await expect(stale).rejects.toThrow("stale failure");

    expect(getResolvedArtwork("server-a", "/thumb/a"))
      .toBe("http://127.0.0.1:4000/artwork/current");
  });

  it("retains all path owners and resolved tickets without a total entry limit", async () => {
    artworkUrl.mockImplementation(async (_serverId, path) => (
      `http://127.0.0.1:4000/artwork/${path.split("/").pop()}`
    ));

    await Promise.all(Array.from({ length: 641 }, (_, index) => (
      requestCachedArtwork("server-a", `/thumb/${index}`, 96, 96)
    )));

    expect(getResolvedArtwork("server-a", "/thumb/0"))
      .toBe("http://127.0.0.1:4000/artwork/0");
    expect(getResolvedArtwork("server-a", "/thumb/640"))
      .toBe("http://127.0.0.1:4000/artwork/640");
    await requestCachedArtwork("server-a", "/thumb/0", 96, 96);
    expect(artworkUrl).toHaveBeenCalledTimes(641);
  });
});

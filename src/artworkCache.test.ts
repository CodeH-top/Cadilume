import { beforeEach, describe, expect, it, vi } from "vitest";

const { artworkUrl } = vi.hoisted(() => ({
  artworkUrl: vi.fn<(serverId: string, path: string, width: number, height?: number) => Promise<string>>(),
}));

vi.mock("./api", () => ({ artworkUrl }));

import {
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

  it("prewarms every distinct restored-queue artwork path with bounded workers", async () => {
    artworkUrl.mockImplementation(async (_serverId, path, width, height) => (
      `http://127.0.0.1:4000/artwork/${path.slice(1)}-${width}x${height}`
    ));

    await prewarmArtwork("server-a", [
      { thumb: "/thumb/current" },
      { thumb: "/thumb/next" },
      { thumb: "/thumb/current", art: "/art/ignored" },
      { composite: "/composite/third" },
    ], 2);

    expect(artworkUrl).toHaveBeenCalledTimes(3);
    expect(artworkUrl).toHaveBeenCalledWith("server-a", "/thumb/current", 420, 420);
    expect(artworkUrl).toHaveBeenCalledWith("server-a", "/thumb/next", 420, 420);
    expect(artworkUrl).toHaveBeenCalledWith("server-a", "/composite/third", 420, 420);
    expect(getResolvedArtwork("server-a", "/thumb/next")).toContain("/artwork/thumb/next-420x420");
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

  it("evicts path owners and resolved tickets together at the LRU limit", async () => {
    artworkUrl.mockImplementation(async (_serverId, path) => (
      `http://127.0.0.1:4000/artwork/${path.split("/").pop()}`
    ));

    await Promise.all(Array.from({ length: 641 }, (_, index) => (
      requestCachedArtwork("server-a", `/thumb/${index}`, 96, 96)
    )));

    expect(getResolvedArtwork("server-a", "/thumb/0")).toBeUndefined();
    expect(getResolvedArtwork("server-a", "/thumb/640"))
      .toBe("http://127.0.0.1:4000/artwork/640");
    await requestCachedArtwork("server-a", "/thumb/0", 96, 96);
    expect(artworkUrl).toHaveBeenCalledTimes(642);
  });
});

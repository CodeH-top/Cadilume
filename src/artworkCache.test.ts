import { beforeEach, describe, expect, it, vi } from "vitest";

const { artworkUrl } = vi.hoisted(() => ({
  artworkUrl: vi.fn<(serverId: string, path: string, width: number, height?: number) => Promise<string>>(),
}));

vi.mock("./api", () => ({ artworkUrl }));

import {
  clearArtworkTicketCache,
  getResolvedArtwork,
  invalidateCachedArtwork,
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
    expect(getResolvedArtwork("server-a", "/thumb/a")).toBe("http://127.0.0.1:4000/artwork/ticket");
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
});

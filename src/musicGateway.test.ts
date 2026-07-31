import { describe, expect, it, vi } from "vitest";
import type { PlexItem } from "./types";

const api = vi.hoisted(() => ({
  getLyrics: vi.fn(),
  getTrackMetadata: vi.fn(),
  reportTimeline: vi.fn(),
  scrobble: vi.fn(),
  streamUrl: vi.fn(),
}));

vi.mock("./api", () => api);

import { mapMusicProviderError, plexMusicGateway } from "./musicGateway";

const track: PlexItem = {
  ratingKey: "track-42",
  key: "/library/metadata/track-42",
  type: "track",
  title: "Gateway contract",
  Media: [{ Part: [{ key: "/library/parts/42.m4a" }] }],
};

describe("Plex music gateway", () => {
  it("keeps library, playback, timeline, scrobble, and lyrics behind one adapter", async () => {
    api.getTrackMetadata.mockResolvedValue(track);
    api.streamUrl.mockResolvedValue("http://127.0.0.1:43102/stream/ticket");
    api.reportTimeline.mockResolvedValue(undefined);
    api.scrobble.mockResolvedValue(undefined);
    api.getLyrics.mockResolvedValue({ timed: false, lines: [] });

    await expect(plexMusicGateway.library.getTrack("server-a", "track-42")).resolves.toBe(track);
    await expect(plexMusicGateway.playback.streamUrl("server-a", track, "320")).resolves.toBe("http://127.0.0.1:43102/stream/ticket");
    await plexMusicGateway.playback.reportTimeline("server-a", track, "playing", 19.25);
    await plexMusicGateway.playback.scrobble("server-a", track);
    await expect(plexMusicGateway.lyrics.getLyrics("server-a", track)).resolves.toEqual({ timed: false, lines: [] });

    expect(api.getTrackMetadata).toHaveBeenCalledWith("server-a", "track-42");
    expect(api.streamUrl).toHaveBeenCalledWith("server-a", track, "320");
    expect(api.reportTimeline).toHaveBeenCalledWith("server-a", track, "playing", 19.25);
    expect(api.scrobble).toHaveBeenCalledWith("server-a", "track-42");
    expect(api.getLyrics).toHaveBeenCalledWith("server-a", "track-42");
    expect(plexMusicGateway.capabilities).toMatchObject({
      canAuthenticate: true,
      canBrowseLibrary: true,
      canStream: true,
      canReportPlayback: true,
      canLoadLyrics: true,
      canControlCompanion: false,
    });
  });

  it("maps protocol failures to stable provider-neutral categories", () => {
    expect(mapMusicProviderError("plex", "lyrics", new Error("PMS returned 403 Forbidden"))).toMatchObject({
      provider: "plex",
      operation: "lyrics",
      kind: "unauthorized",
    });
    expect(plexMusicGateway.mapError(new Error("network timeout"), "stream")).toMatchObject({
      provider: "plex",
      operation: "stream",
      kind: "network",
    });
    expect(mapMusicProviderError("jellyfin", "library", new Error("404 not found"))).toMatchObject({
      provider: "jellyfin",
      operation: "library",
      kind: "not-found",
    });
  });
});

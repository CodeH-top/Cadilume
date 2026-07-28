import { describe, expect, it } from "vitest";
import { clamp01, desktopLyricProgress, safeArtworkUrl } from "./desktopLyrics";

describe("desktop lyric progress", () => {
  it("clamps invalid and out-of-range values", () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it("prefers an explicit producer progress", () => {
    expect(desktopLyricProgress({ lineProgress: 0.4, currentStartMs: 0, currentEndMs: 100, positionMs: 90 })).toBe(0.4);
  });

  it("derives progress from active line bounds", () => {
    expect(desktopLyricProgress({ lineProgress: undefined, currentStartMs: 10_000, currentEndMs: 12_000, positionMs: 11_000 })).toBe(0.5);
    expect(desktopLyricProgress({ lineProgress: undefined, currentStartMs: 10_000, currentEndMs: 12_000, positionMs: 14_000 })).toBe(1);
  });
});

describe("desktop artwork URL boundary", () => {
  it("allows image data URLs and strict loopback artwork tickets", () => {
    const ticket = `http://127.0.0.1:49152/artwork/${"a".repeat(64)}`;
    const png = "data:image/png;base64,fixture";
    const svg = "data:image/svg+xml;charset=UTF-8,%3Csvg%3E%3C%2Fsvg%3E";

    expect(safeArtworkUrl(ticket)).toBe(ticket);
    expect(safeArtworkUrl(`http://127.0.0.1:65535/artwork/${"0".repeat(64)}`)).toContain("/artwork/");
    expect(safeArtworkUrl(png)).toBe(png);
    expect(safeArtworkUrl(svg)).toBe(svg);
  });

  it("rejects remote, malformed, credentialed, or decorated artwork URLs", () => {
    const hex = "a".repeat(64);
    for (const value of [
      undefined,
      "data:text/html,fixture",
      "data:image/png;base64",
      `https://127.0.0.1:49152/artwork/${hex}`,
      `http://localhost:49152/artwork/${hex}`,
      `http://user@127.0.0.1:49152/artwork/${hex}`,
      `http://127.0.0.1:0/artwork/${hex}`,
      `http://127.0.0.1:65536/artwork/${hex}`,
      `http://127.0.0.1:49152/artwork/${"A".repeat(64)}`,
      `http://127.0.0.1:49152/artwork/${"a".repeat(63)}`,
      `http://127.0.0.1:49152/artwork/${hex}?size=320`,
      `http://127.0.0.1:49152/artwork/${hex}#cover`,
      `http://127.0.0.1:49152/stream/${hex}`,
      "https://plex.example.test/library/metadata/1/thumb?X-Plex-Token=secret",
    ]) {
      expect(safeArtworkUrl(value)).toBeUndefined();
    }
  });
});

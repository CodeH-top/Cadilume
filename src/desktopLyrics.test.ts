import { describe, expect, it } from "vitest";
import { clamp01, desktopLyricProgress } from "./desktopLyrics";

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

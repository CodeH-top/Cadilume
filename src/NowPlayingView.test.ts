import { describe, expect, it } from "vitest";
import { getLyricProgress, getPlexLyricsScrollTop } from "./NowPlayingView";

describe("expanded player lyric progress", () => {
  const line = { id: "line-1", startMs: 1_000, endMs: 3_000, texts: ["Line"] };

  it("clamps a timed lyric gradient to its exact millisecond window", () => {
    expect(getLyricProgress(line, 900)).toBe(0);
    expect(getLyricProgress(line, 2_000)).toBe(0.5);
    expect(getLyricProgress(line, 3_200)).toBe(1);
  });

  it("keeps untimed lyrics static", () => {
    expect(getLyricProgress({ ...line, startMs: null, endMs: null }, 2_000)).toBe(0);
  });
});

describe("expanded player lyric scrolling", () => {
  it("keeps the list still while the active lyric remains visible", () => {
    expect(getPlexLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: 150,
      targetHeight: 40,
    })).toBe(100);

    expect(getPlexLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -10,
      targetHeight: 40,
    })).toBe(100);
  });

  it("moves an offscreen lyric to the top and clamps the scroll range", () => {
    expect(getPlexLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 220,
      targetHeight: 20,
    })).toBe(320);

    expect(getPlexLyricsScrollTop({
      scrollTop: 550,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 220,
      targetHeight: 30,
    })).toBe(600);
  });

  it("returns zero when the lyrics do not overflow their viewport", () => {
    expect(getPlexLyricsScrollTop({
      scrollTop: 40,
      viewportHeight: 300,
      contentHeight: 180,
      targetTop: 120,
      targetHeight: 24,
    })).toBe(0);
  });
});

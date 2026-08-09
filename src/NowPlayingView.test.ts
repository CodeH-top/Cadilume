import { describe, expect, it } from "vitest";
import { getDominantArtworkColor, getLyricProgress } from "./NowPlayingView";
import { getCenteredLyricsScrollTop, getLyricsScrollPlan } from "./lyricsScroll";

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

describe("expanded player artwork theme", () => {
  it("selects the dominant chromatic mid-tone while ignoring transparent and extreme pixels", () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
      200, 40, 56, 255,
      198, 42, 54, 255,
      40, 80, 190, 80,
    ]);

    expect(getDominantArtworkColor(pixels)).toEqual({ red: 199, green: 41, blue: 55 });
  });

  it("retains a usable neutral theme for monochrome artwork", () => {
    const pixels = new Uint8ClampedArray([
      114, 118, 124, 255,
      116, 120, 126, 255,
      250, 250, 250, 255,
    ]);

    expect(getDominantArtworkColor(pixels)).toEqual({ red: 115, green: 119, blue: 125 });
  });
});

describe("expanded player lyric scrolling", () => {
  const line = { id: "line-1", startMs: 1_000, endMs: 3_000, texts: ["Line"] };

  it("keeps an active lyric centered even when it was already visible", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: 150,
      targetHeight: 40,
    })).toBe(170);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -10,
      targetHeight: 40,
    })).toBe(10);
  });

  it("centers an offscreen lyric and clamps both scroll boundaries", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 0,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 360,
      targetHeight: 40,
    })).toBe(280);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 220,
      targetHeight: 20,
    })).toBe(230);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 550,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 220,
      targetHeight: 30,
    })).toBe(600);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 0,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 12,
      targetHeight: 30,
    })).toBe(0);
  });

  it("returns zero when the lyrics do not overflow their viewport", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 40,
      viewportHeight: 300,
      contentHeight: 180,
      targetTop: 120,
      targetHeight: 24,
    })).toBe(0);
  });

  it("instantly reclaims a manually scrolled list for the opening lyrics", () => {
    expect(getLyricsScrollPlan({
      activeLine: line,
      manuallyScrolled: true,
      reducedMotion: false,
      scrollTop: 480,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -460,
      targetHeight: 40,
    })).toEqual({
      top: 0,
      behavior: "instant",
      consumeManualOverride: true,
    });
  });

  it("preserves manual control through clear frames until a visible lyric arrives", () => {
    const metrics = {
      manuallyScrolled: true,
      reducedMotion: false,
      scrollTop: 400,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -360,
      targetHeight: 20,
    };
    expect(getLyricsScrollPlan({
      ...metrics,
      activeLine: { ...line, clear: true, texts: [] },
    })).toBeUndefined();
    expect(getLyricsScrollPlan({ ...metrics, activeLine: line })).toMatchObject({
      behavior: "instant",
      consumeManualOverride: true,
    });
  });

  it("keeps ordinary middle-line following smooth and reduced motion instant", () => {
    const metrics = {
      activeLine: line,
      manuallyScrolled: false,
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: 150,
      targetHeight: 40,
    };
    expect(getLyricsScrollPlan({ ...metrics, reducedMotion: false })).toMatchObject({
      top: 170,
      behavior: "smooth",
      consumeManualOverride: false,
    });
    expect(getLyricsScrollPlan({ ...metrics, reducedMotion: true })).toMatchObject({
      top: 170,
      behavior: "instant",
      consumeManualOverride: false,
    });
  });
});

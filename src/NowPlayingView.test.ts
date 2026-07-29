import { describe, expect, it } from "vitest";
import { getCenteredLyricsScrollTop } from "./NowPlayingView";

describe("expanded player lyric scrolling", () => {
  it("centers an active lyric inside the existing list scroll position", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: 150,
      targetHeight: 40,
    })).toBe(170);
  });

  it("clamps the target at the beginning and end of the lyric list", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 0,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 10,
      targetHeight: 20,
    })).toBe(0);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 550,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 170,
      targetHeight: 30,
    })).toBe(600);
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
});

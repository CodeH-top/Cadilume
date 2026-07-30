import { describe, expect, it } from "vitest";
import { playbackControlLabel, rangeFillPercent } from "./playerUi";

describe("rangeFillPercent", () => {
  it("maps the beginning, midpoint, and end of a range", () => {
    expect(rangeFillPercent(0, 200)).toBe(0);
    expect(rangeFillPercent(100, 200)).toBe(50);
    expect(rangeFillPercent(200, 200)).toBe(100);
  });

  it("clamps values outside the range", () => {
    expect(rangeFillPercent(-10, 200)).toBe(0);
    expect(rangeFillPercent(240, 200)).toBe(100);
  });

  it("returns zero for invalid values or maxima", () => {
    expect(rangeFillPercent(Number.NaN, 200)).toBe(0);
    expect(rangeFillPercent(20, Number.POSITIVE_INFINITY)).toBe(0);
    expect(rangeFillPercent(20, 0)).toBe(0);
    expect(rangeFillPercent(20, -1)).toBe(0);
  });
});

describe("playbackControlLabel", () => {
  it("prioritizes source loading and buffering over the ordinary transport label", () => {
    expect(playbackControlLabel({ playing: false, loading: true, buffering: false })).toBe("正在加载音频");
    expect(playbackControlLabel({ playing: true, loading: false, buffering: true })).toBe("正在缓冲，点击暂停");
    expect(playbackControlLabel({ playing: true, loading: true, buffering: true })).toBe("正在加载音频");
  });

  it("keeps the normal play and pause labels when media is ready", () => {
    expect(playbackControlLabel({ playing: false, loading: false, buffering: false })).toBe("播放");
    expect(playbackControlLabel({ playing: true, loading: false, buffering: false })).toBe("暂停");
  });
});

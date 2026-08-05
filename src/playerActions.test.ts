import { describe, expect, it } from "vitest";
import { getLyricsActionPresentation } from "./playerActions";

describe("lyrics action presentation", () => {
  it("uses the exact unavailable tooltip only after lyrics are confirmed absent", () => {
    expect(getLyricsActionPresentation({ hasTrack: true, canToggleLyrics: false, lyricsOpen: false })).toEqual({
      ariaLabel: "歌词不可用：暂无歌词",
      tooltip: "暂无歌词",
      disabled: true,
      showsDisabledTooltip: true,
    });
  });

  it("keeps the loading and failure path available to open the lyrics panel", () => {
    expect(getLyricsActionPresentation({ hasTrack: true, canToggleLyrics: true, lyricsOpen: false })).toEqual({
      ariaLabel: "打开歌词",
      tooltip: "打开歌词",
      disabled: false,
      showsDisabledTooltip: false,
    });
  });

  it("does not classify an idle player as a missing-lyrics track", () => {
    expect(getLyricsActionPresentation({ hasTrack: false, canToggleLyrics: false, lyricsOpen: false })).toEqual({
      ariaLabel: "歌词不可用：请先播放歌曲",
      tooltip: "请先播放歌曲",
      disabled: true,
      showsDisabledTooltip: true,
    });
  });
});

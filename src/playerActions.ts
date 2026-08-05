export interface LyricsActionPresentation {
  ariaLabel: string;
  tooltip: string;
  disabled: boolean;
  showsDisabledTooltip: boolean;
}

export function getLyricsActionPresentation({
  hasTrack,
  canToggleLyrics,
  lyricsOpen,
}: {
  hasTrack: boolean;
  canToggleLyrics: boolean;
  lyricsOpen: boolean;
}): LyricsActionPresentation {
  if (!hasTrack) {
    return {
      ariaLabel: "歌词不可用：请先播放歌曲",
      tooltip: "请先播放歌曲",
      disabled: true,
      showsDisabledTooltip: true,
    };
  }

  if (!canToggleLyrics) {
    return {
      ariaLabel: "歌词不可用：暂无歌词",
      tooltip: "暂无歌词",
      disabled: true,
      showsDisabledTooltip: true,
    };
  }

  return lyricsOpen
    ? { ariaLabel: "关闭歌词", tooltip: "关闭歌词", disabled: false, showsDisabledTooltip: false }
    : { ariaLabel: "打开歌词", tooltip: "打开歌词", disabled: false, showsDisabledTooltip: false };
}

export function rangeFillPercent(value: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0) return 0;
  return Math.min(100, Math.max(0, (value / maximum) * 100));
}

export function playbackControlLabel({
  playing,
  loading,
  buffering,
}: {
  playing: boolean;
  loading: boolean;
  buffering: boolean;
}): string {
  if (loading) return "正在加载音频";
  if (buffering) return "正在缓冲，点击暂停";
  return playing ? "暂停" : "播放";
}

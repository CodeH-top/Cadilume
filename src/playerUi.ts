export function rangeFillPercent(value: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0) return 0;
  return Math.min(100, Math.max(0, (value / maximum) * 100));
}

/**
 * WebKit reports `Infinity` for non-seekable HTTP streams (chunked PMS
 * transcodes usually have no Content-Length). A finite track-level duration
 * must replace that value so progress bars and lyric end boundaries keep a
 * usable timeline instead of showing `Infinity:NaN` or an empty bar.
 */
export function usableDurationSeconds(
  mediaDuration: number | undefined,
  fallbackSeconds?: number,
): number {
  if (typeof mediaDuration === "number" && Number.isFinite(mediaDuration) && mediaDuration > 0) {
    return mediaDuration;
  }
  return typeof fallbackSeconds === "number" && Number.isFinite(fallbackSeconds) && fallbackSeconds > 0
    ? fallbackSeconds
    : 0;
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

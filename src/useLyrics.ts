import { useEffect, useMemo, useState } from "react";
import { getLyrics } from "./api";
import { findActiveLyricIndex, normalizePlexLyrics, type LyricsDocument } from "./lyrics";
import type { PlexItem } from "./types";

export function useLyrics(
  serverId: string | undefined,
  track: PlexItem | undefined,
  playbackSeconds: number,
  durationSeconds: number,
) {
  const [document, setDocument] = useState<LyricsDocument>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setDocument(undefined);
    setError(undefined);
    if (!serverId || !track) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    void getLyrics(serverId, track.ratingKey)
      .then((payload) => {
        if (cancelled) return;
        setDocument(payload ? normalizePlexLyrics(payload, track.duration || durationSeconds * 1000) : undefined);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [durationSeconds, serverId, track?.duration, track?.ratingKey]);

  const activeIndex = useMemo(() => {
    if (!document?.timed) return -1;
    return findActiveLyricIndex(document.lines, playbackSeconds * 1000);
  }, [document, playbackSeconds]);

  return { document, activeIndex, loading, error };
}

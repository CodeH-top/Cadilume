import { useEffect, useMemo, useState } from "react";
import { plexMusicGateway } from "./musicGateway";
import { findActiveLyricIndex, normalizeMusicLyrics, type LyricsDocument } from "./lyrics";
import type { PlexItem } from "./types";

export function useLyrics(
  serverId: string | undefined,
  track: PlexItem | undefined,
  playbackSeconds: number,
  durationSeconds: number,
) {
  const sourceKey = serverId && track ? `${serverId}:${track.ratingKey}` : undefined;
  const [document, setDocument] = useState<LyricsDocument>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [resolvedSourceKey, setResolvedSourceKey] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setResolvedSourceKey(sourceKey);
    setDocument(undefined);
    setError(undefined);
    if (!serverId || !track) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    void plexMusicGateway.lyrics.getLyrics(serverId, track)
      .then((payload) => {
        if (cancelled) return;
        setDocument(payload ? normalizeMusicLyrics(payload, track.duration || durationSeconds * 1000) : undefined);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [durationSeconds, serverId, sourceKey, track?.duration, track?.ratingKey]);

  const isCurrentSource = resolvedSourceKey === sourceKey;
  const currentDocument = isCurrentSource ? document : undefined;
  const currentLoading = isCurrentSource ? loading : Boolean(sourceKey);
  const currentError = isCurrentSource ? error : undefined;

  const activeIndex = useMemo(() => {
    if (!currentDocument?.timed) return -1;
    return findActiveLyricIndex(currentDocument.lines, playbackSeconds * 1000);
  }, [currentDocument, playbackSeconds]);

  return {
    document: currentDocument,
    activeIndex,
    loading: currentLoading,
    error: currentError,
  };
}

import { getLyrics, getTrackMetadata, reportTimeline, scrobble, streamUrl } from "./api";
import type { MusicLyricsPayload, PlexItem, StreamQuality } from "./types";

/**
 * Fixed provider identifiers for adapter registration. Visual brand presets are
 * deliberately separate from these identifiers: selecting an Emby/Jellyfin
 * color never changes the active music provider.
 */
export type MusicProviderId = "plex" | "emby" | "jellyfin";

export type MusicProviderOperation = "authentication" | "library" | "stream" | "timeline" | "scrobble" | "lyrics";
export type MusicProviderErrorKind = "unauthorized" | "not-found" | "not-playable" | "network" | "unsupported" | "unknown";

/** A provider-neutral error envelope for future adapters and UI error mapping. */
export interface MusicProviderError {
  provider: MusicProviderId;
  operation: MusicProviderOperation;
  kind: MusicProviderErrorKind;
  message: string;
}

/**
 * Convert protocol-specific failures into a stable small vocabulary without
 * exposing a server URL, access token, or raw request details to the UI.
 */
export function mapMusicProviderError(
  provider: MusicProviderId,
  operation: MusicProviderOperation,
  reason: unknown,
): MusicProviderError {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  const normalized = message.toLowerCase();
  const kind: MusicProviderErrorKind = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|permission|无权|权限/u.test(normalized)
    ? "unauthorized"
    : /\b404\b|not found|不存在|找不到/u.test(normalized)
      ? "not-found"
      : /media|codec|format|playable|播放/u.test(normalized)
        ? "not-playable"
        : /network|offline|timeout|connect|网络|连接/u.test(normalized)
          ? "network"
          : /unsupported|不支持/u.test(normalized)
            ? "unsupported"
            : "unknown";
  return { provider, operation, kind, message };
}

/**
 * Provider-neutral capabilities that keep player and lyrics hooks independent
 * from a specific server protocol. New platforms supply an adapter here rather
 * than duplicating hook state machines.
 */
export interface MusicProviderCapabilities {
  canAuthenticate: boolean;
  canBrowseLibrary: boolean;
  canStream: boolean;
  canReportPlayback: boolean;
  canLoadLyrics: boolean;
  canControlCompanion: boolean;
}

/** Small portable track shape used at future provider adapter boundaries. */
export interface PlayableTrack {
  ratingKey: string;
  key: string;
  type: string;
  title: string;
  duration?: number;
}

export interface PlaybackGateway<Track extends PlayableTrack = PlayableTrack> {
  streamUrl(serverId: string, track: Track, quality: StreamQuality): Promise<string>;
  reportTimeline(serverId: string, track: Track, playbackState: "playing" | "paused" | "stopped", time: number): Promise<void>;
  scrobble(serverId: string, track: Track): Promise<void>;
}

export interface LyricsGateway<Track extends PlayableTrack = PlayableTrack> {
  getLyrics(serverId: string, track: Track): Promise<MusicLyricsPayload | null>;
}

/**
 * Playback callers resolve a fresh provider-owned record at the last possible
 * moment. This keeps future history, search, and library adapters out of the
 * player queue's provider-specific metadata assumptions.
 */
export interface MusicLibraryGateway<Track extends PlayableTrack = PlayableTrack> {
  getTrack(serverId: string, ratingKey: string): Promise<Track>;
}

export interface MusicProviderGateway<Track extends PlayableTrack = PlayableTrack> {
  id: MusicProviderId;
  capabilities: MusicProviderCapabilities;
  library: MusicLibraryGateway<Track>;
  playback: PlaybackGateway<Track>;
  lyrics: LyricsGateway<Track>;
  mapError(reason: unknown, operation: MusicProviderOperation): MusicProviderError;
}

/** The first adapter; future Emby/Jellyfin adapters implement the same ports. */
export const plexMusicGateway: MusicProviderGateway<PlexItem> = {
  id: "plex",
  capabilities: {
    canAuthenticate: true,
    canBrowseLibrary: true,
    canStream: true,
    canReportPlayback: true,
    canLoadLyrics: true,
    canControlCompanion: false,
  },
  library: {
    getTrack: getTrackMetadata,
  },
  playback: {
    streamUrl,
    reportTimeline,
    scrobble: async (serverId, track) => scrobble(serverId, track.ratingKey),
  },
  lyrics: {
    getLyrics: (serverId, track) => getLyrics(serverId, track.ratingKey),
  },
  mapError: (reason, operation) => mapMusicProviderError("plex", operation, reason),
};

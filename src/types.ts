export type StatusIconPlatform = "macos" | "windows";
export type LibraryView = "home" | "albums" | "artists" | "tracks" | "search" | "settings";
export type StreamQuality = "auto" | "original" | "320" | "256" | "192";
export type ThemeMode = "light" | "dark";
/** Fixed Cadilume visual presets. These are visual-only and never change the active media provider. */
export type BrandPreset = "amber" | "verdant" | "azure";

export interface CacheStatus {
  sizeBytes: number;
  fileCount: number;
}

export interface PlexAccount {
  id?: number;
  username: string;
  title: string;
  email: string;
  thumb?: string;
  home: boolean;
  restricted: boolean;
  subscriptionActive: boolean;
}

export interface BootstrapResponse {
  clientIdentifier: string;
  authenticated: boolean;
  account?: PlexAccount;
  statusIconEnabled: boolean;
  statusIconPlatform?: StatusIconPlatform;
  deviceName: string;
  brandPreset: BrandPreset;
  audioCacheLimitGib: number;
}

export interface PlexPin {
  id: number;
  code: string;
  expiresIn: number;
  authenticated: boolean;
}

export interface PlexServer {
  id: string;
  name: string;
  owned: boolean;
  home: boolean;
  sourceTitle?: string;
  connectionUri: string;
  local: boolean;
  relay: boolean;
  secure: boolean;
}

export interface LibrarySection {
  key: string;
  title: string;
  type: string;
  thumb?: string;
}

export interface PlexMedia {
  audioCodec?: string;
  container?: string;
  bitrate?: number;
  Part?: Array<{ key: string; duration?: number; size?: number }>;
}

/** A named performer returned by PMS' structured track contributor metadata. */
export interface PlexContributor {
  name: string;
  /** A PMS artist rating key when the source made one available. */
  ratingKey?: string;
}

export interface PlexItem {
  ratingKey: string;
  key: string;
  type: "artist" | "album" | "track" | string;
  title: string;
  /** PMS' canonical collation value used by `titleSort:asc`. */
  titleSort?: string;
  summary?: string;
  thumb?: string;
  art?: string;
  parentTitle?: string;
  /** PMS' album collation value used when an artist's tracks are sorted by album. */
  parentTitleSort?: string;
  parentRatingKey?: string;
  /** PMS music-track artist text (`originalTitle`), distinct from the album artist. */
  originalTitle?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  /** Normalized performers credited on this track, in PMS order. */
  trackArtists?: PlexContributor[];
  /** Legacy alias retained only for old demo data and persisted sessions. */
  contributors?: PlexContributor[];
  duration?: number;
  year?: number;
  index?: number;
  parentIndex?: number;
  addedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
  /** PMS playlist-item identity; only present on `/playlists/{id}/items` rows. */
  playlistItemID?: string;
  Media?: PlexMedia[];
  imageUrl?: string;
}

export interface PlexItemPage {
  items: PlexItem[];
  start: number;
  nextStart: number;
  totalSize: number;
}

/** An account-scoped Plex playlist candidate; PMS remains authoritative for write ACLs. */
export interface PlexPlaylist {
  ratingKey: string;
  key: string;
  type: "playlist" | string;
  title: string;
  summary?: string;
  playlistType: "audio" | "video" | "photo" | string;
  smart: boolean;
  readOnly: boolean;
  thumb?: string;
  art?: string;
  composite?: string;
  duration?: number;
  leafCount?: number;
  addedAt?: number;
  updatedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
}

export interface PlexHub {
  title: string;
  type: string;
  identifier?: string;
  context?: string;
  more?: boolean;
  promoted?: boolean;
  items: PlexItem[];
}

/** Provider-neutral lyric line after a server adapter has normalized its payload. */
export interface MusicLyricLine {
  startMs?: number;
  endMs?: number;
  text: string;
}

/**
 * Portable lyrics payload consumed by Cadilume's presentation layer.
 * Individual provider adapters are responsible for translating their protocol
 * into this small shape before it reaches `useLyrics`.
 */
export interface MusicLyricsPayload {
  provider?: string;
  timed: boolean;
  author?: string;
  by?: string;
  formatHint?: string;
  rawText?: string;
  lines: MusicLyricLine[];
}

/** Plex terminology is retained as a source-compatibility alias only. */
export type PlexLyricLine = MusicLyricLine;
export type PlexLyricsPayload = MusicLyricsPayload;

export interface NowPlaying {
  track: PlexItem;
  index: number;
}

export function trackArtistContributors(track: Pick<PlexItem, "trackArtists" | "contributors" | "originalTitle">): PlexContributor[] | undefined {
  // PMS preserves the track-credit text in originalTitle. It is Cadilume's
  // display source when available; structured members are only a fallback.
  const originalTitle = track.originalTitle?.trim();
  if (originalTitle) return [{ name: originalTitle }];
  const contributors = track.trackArtists?.length ? track.trackArtists : track.contributors;
  const normalizedContributors = contributors
    ?.flatMap((contributor) => {
      const name = contributor.name.trim();
      return name ? [{ name, ...(contributor.ratingKey ? { ratingKey: contributor.ratingKey } : {}) }] : [];
    });
  if (normalizedContributors?.length) return normalizedContributors;
  return undefined;
}

export function trackArtist(track: PlexItem): string {
  const contributorNames = trackArtistContributors(track)?.map((contributor) => contributor.name);
  if (contributorNames?.length) return contributorNames.join(" / ");
  return track.grandparentTitle || track.parentTitle || "未知歌手";
}

export function trackAlbum(track: PlexItem): string {
  return track.parentTitle || "未知专辑";
}

export function trackPartKey(track: PlexItem): string | undefined {
  return track.Media?.[0]?.Part?.[0]?.key;
}

export function formatDuration(milliseconds?: number): string {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return "0:00";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

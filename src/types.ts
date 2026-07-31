export type CloseBehavior = "tray" | "quit";
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
  closeBehavior: CloseBehavior;
  deviceName: string;
  brandPreset: BrandPreset;
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
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  duration?: number;
  year?: number;
  index?: number;
  parentIndex?: number;
  addedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
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

export function trackArtist(track: PlexItem): string {
  return track.grandparentTitle || track.parentTitle || "未知歌手";
}

export function trackAlbum(track: PlexItem): string {
  return track.parentTitle || "未知专辑";
}

export function trackPartKey(track: PlexItem): string | undefined {
  return track.Media?.[0]?.Part?.[0]?.key;
}

export function formatDuration(milliseconds?: number): string {
  if (!milliseconds || milliseconds < 0) return "0:00";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

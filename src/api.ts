import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { demoAlbums, demoArtists, demoBootstrap, demoPlaylistItems, demoPlaylists, demoRecommendationHubs, demoSections, demoServers, demoTracks } from "./demo";
import { plexLibraryTrackSort, plexSingerTrackSort, sortTracks, type TrackSortState } from "./trackSort";
import type { AppUpdateEvent, AppUpdateInfo, BootstrapResponse, BrandPreset, CacheStatus, LibrarySection, PlexContributor, PlexHub, PlexItem, PlexItemPage, PlexLyricsPayload, PlexPin, PlexPlaylist, PlexServer, StreamQuality } from "./types";

const artworkQueue: Array<() => void> = [];
let activeArtworkRequests = 0;
let demoArtistTrackFailureKey: string | undefined;
let demoPlaylistSequence = 0;
const demoCreatedPlaylists: PlexPlaylist[] = [];
const demoCreatedPlaylistItems = new Map<string, PlexItem[]>();
const demoRemovedPlaylistItemIds = new Set<string>();
const MAX_ARTWORK_REQUESTS = 6;
const MAX_PLAYLIST_TITLE_LENGTH = 255;
const MAX_PLAYLIST_SUMMARY_LENGTH = 1000;
const MAX_DEVICE_NAME_LENGTH = 80;

function drainArtworkQueue(): void {
  while (activeArtworkRequests < MAX_ARTWORK_REQUESTS && artworkQueue.length) {
    activeArtworkRequests += 1;
    artworkQueue.shift()?.();
  }
}

export const isDesktopRuntime = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const container = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const mediaContainer = record.MediaContainer;
  return mediaContainer && typeof mediaContainer === "object" ? mediaContainer as Record<string, unknown> : record;
};

const metadata = (value: unknown): PlexItem[] => {
  const root = container(value);
  const items = root.Metadata ?? root.Directory ?? root.Track;
  return normalizePlexItems(items);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function playlistRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  const root = container(value);
  const items = root.Metadata ?? root.Playlist ?? root.Directory;
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no"].includes(normalized)) return false;
    if (["1", "true", "yes"].includes(normalized)) return true;
  }
  return undefined;
}

function normalizedBooleanFlag(value: unknown): boolean | undefined {
  return value === undefined ? false : optionalBooleanFlag(value);
}

function isCleanPlexIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function contributorRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function normalizedContributorString(value: unknown): string | undefined {
  const normalized = optionalString(value)?.trim();
  return normalized || undefined;
}

/**
 * PMS can return structured performer metadata under Role or Contributor, with
 * either `tag`, `title`, or `name` labels. This helper only normalizes the
 * structured portion; track-level precedence is applied by
 * `normalizePlexTrackArtists` below.
 */
export function normalizePlexContributors(value: Record<string, unknown>): PlexContributor[] | undefined {
  const names = new Set<string>();
  const ratingKeys = new Set<string>();
  const contributors: PlexContributor[] = [];
  const structuredSources = [value.trackArtists, value.Role, value.Contributor, value.contributors, value.roles, value.contributor];

  for (const source of structuredSources) {
    for (const candidate of contributorRecords(source)) {
      const name = [candidate.tag, candidate.title, candidate.name, candidate.artist, candidate.displayName]
        .map(normalizedContributorString)
        .find((candidateName): candidateName is string => Boolean(candidateName));
      if (!name) continue;
      const ratingKey = [candidate.ratingKey, candidate.tagKey, candidate.id]
        .map(normalizedContributorString)
        .find((candidateKey): candidateKey is string => Boolean(candidateKey && isCleanPlexIdentifier(candidateKey)));
      const normalizedName = name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
      if (names.has(normalizedName) || (ratingKey && ratingKeys.has(ratingKey))) continue;
      names.add(normalizedName);
      if (ratingKey) ratingKeys.add(ratingKey);
      contributors.push({ name, ratingKey });
    }
  }
  return contributors.length ? contributors : undefined;
}

/**
 * Normalize the artist credit of one music track. `grandparentTitle` is the
 * album artist in PMS' music model; `originalTitle` is the track artist. Keep
 * that raw text as the display source when available; structured metadata only
 * supplies a display source when PMS omitted the track-credit text.
 */
export function normalizePlexTrackArtists(value: Record<string, unknown>): PlexContributor[] | undefined {
  const originalTitle = normalizedContributorString(value.originalTitle);
  if (originalTitle) return [{ name: originalTitle }];
  return normalizePlexContributors(value);
}

function normalizePlexItems(value: unknown): PlexItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => {
    const trackArtists = item.type === "track" ? normalizePlexTrackArtists(item) : undefined;
    const playlistItemID = optionalString(item.playlistItemID);
    const normalized = playlistItemID
      ? { ...item, playlistItemID } as unknown as PlexItem
      : item as unknown as PlexItem;
    return trackArtists ? { ...normalized, trackArtists } : normalized;
  });
}

function normalizePlaylist(value: Record<string, unknown>): PlexPlaylist | undefined {
  const ratingKey = optionalString(value.ratingKey);
  const title = optionalString(value.title);
  if (!ratingKey || !isCleanPlexIdentifier(ratingKey) || !title) return undefined;
  const playlistType = optionalString(value.playlistType)?.toLowerCase();
  if (!playlistType) return undefined;
  const type = (optionalString(value.type) || "playlist").toLowerCase();
  const smart = normalizedBooleanFlag(value.smart);
  const readOnly = normalizedBooleanFlag(value.readOnly);
  if (type !== "playlist" || smart === undefined || readOnly === undefined) return undefined;
  return {
    ratingKey,
    key: optionalString(value.key) || `/playlists/${ratingKey}/items`,
    type,
    title,
    summary: optionalString(value.summary),
    playlistType,
    smart,
    readOnly,
    thumb: optionalString(value.thumb),
    art: optionalString(value.art),
    composite: optionalString(value.composite),
    duration: optionalNumber(value.duration),
    leafCount: optionalNumber(value.leafCount),
    addedAt: optionalNumber(value.addedAt),
    updatedAt: optionalNumber(value.updatedAt),
    lastViewedAt: optionalNumber(value.lastViewedAt),
    viewCount: optionalNumber(value.viewCount),
  };
}

function normalizePlaylistTitle(title: string): string {
  const normalized = title.trim();
  if (
    !normalized
    || Array.from(normalized).length > MAX_PLAYLIST_TITLE_LENGTH
    || Array.from(normalized).some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new Error("歌单名称必须为 1–255 个有效字符");
  }
  return normalized;
}

function normalizePlaylistSummary(summary: string): string {
  const normalized = summary.trim();
  if (
    Array.from(normalized).length > MAX_PLAYLIST_SUMMARY_LENGTH
    || Array.from(normalized).some((character) => /\p{Cc}/u.test(character) && !["\n", "\r", "\t"].includes(character))
  ) {
    throw new Error("歌单描述最多为 1000 个有效字符");
  }
  return normalized;
}

function normalizePlaylistRatingKeys(ratingKeys: readonly string[]): string[] {
  const uniqueRatingKeys: string[] = [];
  const seen = new Set<string>();
  for (const ratingKey of ratingKeys) {
    if (!isCleanPlexIdentifier(ratingKey)) throw new Error("无效的 Plex 歌曲标识");
    if (!seen.has(ratingKey)) {
      seen.add(ratingKey);
      uniqueRatingKeys.push(ratingKey);
    }
  }
  return uniqueRatingKeys;
}

export function normalizeDeviceName(deviceName: string): string {
  const trimmed = deviceName.trim();
  const normalized = trimmed.replace(/\s+/gu, " ");
  if (
    !normalized
    || Array.from(normalized).length > MAX_DEVICE_NAME_LENGTH
    || Array.from(trimmed).some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new Error("设备名称需为 1–80 个有效字符");
  }
  return normalized;
}

export async function bootstrap(): Promise<BootstrapResponse> {
  return isDesktopRuntime() ? invoke("bootstrap") : demoBootstrap;
}

export async function createPin(): Promise<PlexPin> {
  if (!isDesktopRuntime()) return { id: 1, code: "DEMO", expiresIn: 300, authenticated: false };
  return invoke("create_pin");
}

export async function openPlexLogin(clientIdentifier: string, code: string): Promise<void> {
  const params = new URLSearchParams({
    clientID: clientIdentifier,
    code,
    "context[device][product]": "Cadilume",
  });
  const url = `https://app.plex.tv/auth#?${params.toString()}`;
  if (isDesktopRuntime()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function pollPin(pinId: number): Promise<PlexPin> {
  return isDesktopRuntime() ? invoke("poll_pin", { pinId }) : { id: pinId, code: "DEMO", expiresIn: 300, authenticated: true };
}

export async function logout(): Promise<void> {
  if (isDesktopRuntime()) await invoke("logout");
}

export async function acknowledgeQuit(): Promise<void> {
  if (isDesktopRuntime()) await invoke("acknowledge_quit");
}

export async function discoverServers(): Promise<PlexServer[]> {
  return isDesktopRuntime() ? invoke("discover_servers") : demoServers;
}

export async function getSections(serverId: string): Promise<LibrarySection[]> {
  if (!isDesktopRuntime()) return demoSections;
  const response = await serverGet(serverId, "/library/sections");
  const root = container(response);
  const sections = root.Directory;
  return (Array.isArray(sections) ? sections : []).filter((section): section is LibrarySection => {
    if (!section || typeof section !== "object") return false;
    return (section as LibrarySection).type === "artist";
  });
}

export async function getLibraryItems(serverId: string, sectionKey: string, type: 8 | 9 | 10): Promise<PlexItem[]> {
  if (!isDesktopRuntime()) {
    if (type === 8) return demoLibraryArtists();
    if (type === 9) return demoAlbums;
    return demoLibraryTracks();
  }
  const pageSize = 500;
  const loadCompleteIndex = type === 8 || type === 9;
  const items: PlexItem[] = [];
  let start = 0;
  let totalSize: number | undefined;

  for (let page = 0; page < 100; page += 1) {
    const response = await serverGet(serverId, `/library/sections/${sectionKey}/all`, {
      type: String(type),
      sort: "titleSort:asc",
      "X-Plex-Container-Start": String(start),
      "X-Plex-Container-Size": String(pageSize),
    });
    const pageItems = metadata(response);
    items.push(...pageItems);
    const root = container(response);
    totalSize ??= optionalNumber(root.totalSize);

    if (!loadCompleteIndex || !pageItems.length) break;
    start += pageItems.length;
    if (totalSize !== undefined ? start >= totalSize : pageItems.length < pageSize) break;
  }

  return items;
}

/** Read one server-sorted page from the main music-track library. */
export async function getTracksPage(
  serverId: string,
  sectionKey: string,
  start = 0,
  pageSize = 50,
  sort?: TrackSortState,
): Promise<PlexItemPage> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(sectionKey)) {
    throw new Error("无效的 Plex 音乐资料库标识");
  }
  const normalizedStart = Math.max(0, Math.floor(Number.isFinite(start) ? start : 0));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : 50)));

  if (!isDesktopRuntime()) {
    const allTracks = sortTracks(demoLibraryTracks(), sort);
    const items = allTracks.slice(normalizedStart, normalizedStart + normalizedPageSize);
    return {
      items,
      start: normalizedStart,
      nextStart: Math.min(allTracks.length, normalizedStart + items.length),
      totalSize: allTracks.length,
    };
  }

  const response = await serverGet(serverId, `/library/sections/${sectionKey}/all`, {
    type: "10",
    sort: plexLibraryTrackSort(sort),
    "X-Plex-Container-Start": String(normalizedStart),
    "X-Plex-Container-Size": String(normalizedPageSize),
  });
  const root = container(response);
  const pageItems = metadata(response);
  const items = pageItems.filter((item) => item?.type === "track");
  return {
    items,
    start: normalizedStart,
    nextStart: normalizedStart + pageItems.length,
    totalSize: optionalNumber(root.totalSize) ?? normalizedStart + items.length,
  };
}

/** Resolve a detail route from PMS instead of trusting previously rendered metadata. */
export async function getLibraryMetadata(serverId: string, ratingKey: string): Promise<PlexItem> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(ratingKey)) {
    throw new Error("无效的 Plex 媒体标识");
  }
  if (!isDesktopRuntime()) {
    const item = [...demoLibraryArtists(), ...demoAlbums, ...demoLibraryTracks()].find((candidate) => candidate.ratingKey === ratingKey);
    if (!item) throw new Error("演示资料库中找不到该项目");
    return item;
  }
  const response = await serverGet(serverId, `/library/metadata/${ratingKey}`);
  const item = metadata(response)[0];
  if (!item) throw new Error("Plex 没有返回该项目");
  return item;
}

export async function getRecentAlbums(serverId: string, sectionKey: string): Promise<PlexItem[]> {
  if (!isDesktopRuntime()) return demoAlbums;
  const response = await serverGet(serverId, `/library/sections/${sectionKey}/all`, {
    type: "9",
    sort: "addedAt:desc",
    "X-Plex-Container-Start": "0",
    "X-Plex-Container-Size": "36",
  });
  return metadata(response);
}

/** Return all readable audio playlists visible to the selected server token. */
export async function getPlaylists(serverId: string): Promise<PlexPlaylist[]> {
  if (!isDesktopRuntime()) {
    // Keep the browser/demo adapter's summary in sync with its item tombstones
    // so sidebar counts and confirmation dialogs reflect removals immediately.
    return [...demoCreatedPlaylists, ...demoPlaylists].map((playlist) => {
      const sourceItems = demoCreatedPlaylistItems.get(playlist.ratingKey) ?? demoPlaylistItems[playlist.ratingKey];
      if (!sourceItems) return { ...playlist };
      const remainingItems = sourceItems.filter((item) => !demoRemovedPlaylistItemIds.has(`${playlist.ratingKey}:${item.playlistItemID ?? item.ratingKey}`));
      return {
        ...playlist,
        leafCount: remainingItems.length,
        duration: remainingItems.reduce((total, item) => total + (item.duration ?? 0), 0),
      };
    });
  }
  const response = await invoke<unknown>("get_playlists", { serverId });
  return playlistRecords(response)
    .map(normalizePlaylist)
    .filter((playlist): playlist is PlexPlaylist => (
      playlist !== undefined
      && playlist.playlistType === "audio"
    ));
}

export interface PlaylistCreationOptions {
  seedRatingKey?: string;
  clearItemsAfterCreate?: boolean;
}

/** Create a regular audio playlist through the selected server's scoped PMS token. */
export async function createPlaylist(
  serverId: string,
  title: string,
  summary = "",
  options: PlaylistCreationOptions = {},
): Promise<PlexPlaylist> {
  if (!isCleanPlexIdentifier(serverId)) throw new Error("无效的 Plex 服务器标识");
  const normalizedTitle = normalizePlaylistTitle(title);
  const normalizedSummary = normalizePlaylistSummary(summary);
  const seedRatingKey = options.seedRatingKey?.trim() || undefined;
  if (seedRatingKey && !isCleanPlexIdentifier(seedRatingKey)) throw new Error("无效的 Plex 歌曲标识");
  const clearItems = Boolean(options.clearItemsAfterCreate);
  if (clearItems && !seedRatingKey) throw new Error("创建空歌单缺少兼容用的歌曲");
  if (!isDesktopRuntime()) {
    const ratingKey = `playlist-created-${++demoPlaylistSequence}`;
    const seedTrack = seedRatingKey
      ? demoLibraryTracks().find((track) => track.ratingKey === seedRatingKey)
      : undefined;
    const initialItems = clearItems || !seedTrack ? [] : [seedTrack];
    const playlist: PlexPlaylist = {
      ratingKey,
      key: `/playlists/${ratingKey}/items`,
      type: "playlist",
      title: normalizedTitle,
      summary: normalizedSummary || undefined,
      playlistType: "audio",
      smart: false,
      readOnly: false,
      leafCount: initialItems.length,
      duration: initialItems.reduce((total, track) => total + (track.duration ?? 0), 0),
      addedAt: Date.now() / 1000,
    };
    demoCreatedPlaylists.unshift(playlist);
    demoCreatedPlaylistItems.set(ratingKey, initialItems);
    return { ...playlist };
  }
  const response = await invoke<unknown>("create_playlist", {
    serverId,
    title: normalizedTitle,
    summary: normalizedSummary,
    seedRatingKey,
    clearItems,
  });
  const playlist = playlistRecords(response)
    .map(normalizePlaylist)
    .find((candidate) => candidate?.playlistType === "audio");
  if (!playlist) throw new Error("Plex 没有返回新建的音乐歌单");
  return normalizedSummary ? { ...playlist, summary: normalizedSummary } : playlist;
}

/** PMS remains authoritative, but smart and read-only playlists are never write targets. */
export function canWritePlaylist(playlist: PlexPlaylist): boolean {
  return playlist.type === "playlist"
    && playlist.playlistType === "audio"
    && !playlist.smart
    && !playlist.readOnly;
}

/** Read a playlist by its clean identifier instead of trusting the server-supplied `key`. */
export async function getPlaylistItems(serverId: string, playlistId: string): Promise<PlexItem[]> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(playlistId)) {
    throw new Error("无效的 Plex 歌单标识");
  }
  if (!isDesktopRuntime()) {
    return [...(demoCreatedPlaylistItems.get(playlistId) ?? demoPlaylistItems[playlistId] ?? [])]
      .filter((item) => !demoRemovedPlaylistItemIds.has(`${playlistId}:${item.playlistItemID ?? item.ratingKey}`));
  }
  const response = await invoke<unknown>("get_playlist_items", { serverId, playlistId });
  return metadata(response).filter((item) => item?.type === "track");
}

export async function getChildren(serverId: string, ratingKey: string): Promise<PlexItem[]> {
  if (!isDesktopRuntime()) {
    if (ratingKey.startsWith("artist-")) return demoAlbums.filter((album) => album.ratingKey.endsWith(ratingKey.split("-")[1]));
    return demoTracks.filter((track) => track.parentRatingKey === ratingKey);
  }
  const response = await serverGet(serverId, `/library/metadata/${ratingKey}/children`, {
    "X-Plex-Container-Start": "0",
    "X-Plex-Container-Size": "500",
  });
  return metadata(response);
}

export async function getArtistTracksPage(
  serverId: string,
  ratingKey: string,
  start = 0,
  pageSize = 50,
  sort?: TrackSortState,
): Promise<PlexItemPage> {
  if (!isCleanPlexIdentifier(ratingKey)) throw new Error("无效的 Plex 歌手标识");
  const normalizedStart = Math.max(0, Math.floor(Number.isFinite(start) ? start : 0));
  const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : 50)));

  if (!isDesktopRuntime()) {
    const previewFailureStart = import.meta.env.DEV && typeof window.location?.search === "string"
      ? Number.parseInt(new URLSearchParams(window.location.search).get("artist-track-fail-once") || "", 10)
      : Number.NaN;
    if (normalizedStart === 0) demoArtistTrackFailureKey = undefined;
    const failureKey = `${ratingKey}:${previewFailureStart}`;
    if (Number.isFinite(previewFailureStart) && normalizedStart === previewFailureStart && demoArtistTrackFailureKey !== failureKey) {
      demoArtistTrackFailureKey = failureKey;
      throw new Error("歌手歌曲分页预览失败");
    }
    const allTracks = sortTracks(demoArtistTracks(ratingKey), sort);
    return {
      items: allTracks.slice(normalizedStart, normalizedStart + normalizedPageSize),
      start: normalizedStart,
      nextStart: Math.min(allTracks.length, normalizedStart + normalizedPageSize),
      totalSize: allTracks.length,
    };
  }

  const response = await serverGet(serverId, `/library/metadata/${ratingKey}/allLeaves`, {
    type: "10",
    sort: plexSingerTrackSort(sort),
    "X-Plex-Container-Start": String(normalizedStart),
    "X-Plex-Container-Size": String(normalizedPageSize),
  });
  const root = container(response);
  const pageItems = metadata(response);
  const items = pageItems.filter((item) => item?.type === "track");
  return {
    items,
    start: normalizedStart,
    nextStart: normalizedStart + pageItems.length,
    totalSize: optionalNumber(root.totalSize) ?? normalizedStart + items.length,
  };
}

function demoArtistTracks(ratingKey: string): PlexItem[] {
  const tracks = demoTracks.filter((track) => track.grandparentRatingKey === ratingKey);
  const previewCount = import.meta.env.DEV && typeof window.location?.search === "string"
    ? Number.parseInt(new URLSearchParams(window.location.search).get("artist-track-preview") || "", 10)
    : Number.NaN;
  if (!Number.isFinite(previewCount) || previewCount <= tracks.length || !tracks.length) return tracks;

  return Array.from({ length: Math.min(500, previewCount) }, (_, index) => {
    const template = tracks[index % tracks.length];
    const albumNumber = Math.floor(index / 10) + 1;
    return {
      ...template,
      ratingKey: `${template.ratingKey}-preview-${index}`,
      key: `/library/metadata/${template.ratingKey}-preview-${index}`,
      title: `${template.title} ${index + 1}`,
      parentRatingKey: `${template.parentRatingKey}-preview-${albumNumber}`,
      parentTitle: `${template.parentTitle} ${String(albumNumber).padStart(2, "0")}`,
      parentTitleSort: `${template.parentTitle || "Album"} ${String(albumNumber).padStart(2, "0")}`,
      parentIndex: 1,
      index: (index % 10) + 1,
    };
  });
}

function demoLibraryTracks(): PlexItem[] {
  const previewParams = import.meta.env.DEV && typeof window.location?.search === "string"
    ? new URLSearchParams(window.location.search)
    : undefined;
  const previewCount = import.meta.env.DEV && typeof window.location?.search === "string"
    ? Number.parseInt(previewParams?.get("track-preview") || "", 10)
    : Number.NaN;
  const tracks = !Number.isFinite(previewCount) || previewCount <= demoTracks.length
    ? demoTracks
    : Array.from({ length: Math.min(2_000, previewCount) }, (_, index) => {
      const template = demoTracks[index % demoTracks.length];
      const cycle = Math.floor(index / demoTracks.length) + 1;
      return {
        ...template,
        ratingKey: `${template.ratingKey}-library-${index}`,
        key: `/library/metadata/${template.ratingKey}-library-${index}`,
        title: `${template.title} ${cycle}`,
        titleSort: `${template.title} ${String(cycle).padStart(4, "0")}`,
        parentTitle: `${template.parentTitle} ${String(cycle).padStart(2, "0")}`,
        parentTitleSort: `${template.parentTitle || "Album"} ${String(cycle).padStart(2, "0")}`,
        index: index + 1,
      };
    });
  if (!previewParams?.has("multi-artist-preview")) return tracks;
  return tracks.map((track, index) => index === 0 ? {
    ...track,
    trackArtists: [
      { name: demoArtists[0].title, ratingKey: demoArtists[0].ratingKey },
      { name: "Kobe Bryant" },
      { name: "AC/DC" },
    ],
  } : track);
}

function demoLibraryArtists(): PlexItem[] {
  const previewCount = import.meta.env.DEV && typeof window.location?.search === "string"
    ? Number.parseInt(new URLSearchParams(window.location.search).get("artist-preview") || "", 10)
    : Number.NaN;
  if (!Number.isFinite(previewCount) || previewCount <= demoArtists.length) return demoArtists;
  const total = Math.min(260, previewCount);
  return [
    ...demoArtists,
    ...Array.from({ length: total - demoArtists.length }, (_, index) => {
      const template = demoArtists[index % demoArtists.length];
      const ordinal = index + 1;
      return {
        ...template,
        ratingKey: `artist-fixture-${ordinal}`,
        key: `/library/metadata/artist-fixture-${ordinal}/children`,
        title: `Aster Artist ${String(ordinal).padStart(2, "0")}`,
        titleSort: `Aster Artist ${String(ordinal).padStart(3, "0")}`,
      };
    }),
  ];
}

export async function getRecommendationHubs(serverId: string, sectionKey: string): Promise<PlexHub[]> {
  if (!isDesktopRuntime()) return demoRecommendationHubs.map((hub) => ({ ...hub, items: [...hub.items] }));
  const response = await serverGet(serverId, `/hubs/sections/${sectionKey}`, { count: "18" });
  const root = container(response);
  const hubs = Array.isArray(root.Hub) ? root.Hub.filter(isRecord) : [];
  return hubs.map((hub): PlexHub => {
    const rawItems = hub.Metadata ?? hub.Directory ?? hub.Track;
    return {
      title: optionalString(hub.title) || "推荐",
      type: optionalString(hub.type) || "mixed",
      identifier: optionalString(hub.hubIdentifier),
      context: optionalString(hub.context),
      more: optionalBooleanFlag(hub.more),
      promoted: optionalBooleanFlag(hub.promoted),
      items: normalizePlexItems(rawItems),
    };
  }).filter((hub) => hub.items.length > 0 && ["artist", "album", "track"].includes(hub.type));
}

export async function getTrackMetadata(serverId: string, ratingKey: string): Promise<PlexItem> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(ratingKey)) {
    throw new Error("无效的 Plex 歌曲标识");
  }
  if (!isDesktopRuntime()) {
    const track = demoLibraryTracks().find((item) => item.ratingKey === ratingKey);
    if (!track) throw new Error("演示资料库中找不到这首歌曲");
    return track;
  }
  const response = await serverGet(serverId, `/library/metadata/${ratingKey}`);
  const track = metadata(response).find((item) => item.type === "track");
  if (!track) throw new Error("Plex 没有返回可播放的歌曲");
  return track;
}

export async function searchLibrary(serverId: string, sectionKey: string, queryText: string): Promise<PlexHub[]> {
  if (!isDesktopRuntime()) {
    const term = queryText.toLowerCase();
    const items = [...demoArtists, ...demoAlbums, ...demoTracks].filter((item) =>
      [item.title, item.parentTitle, item.grandparentTitle].some((value) => value?.toLowerCase().includes(term)),
    );
    return [{ title: "搜索结果", type: "mixed", items }];
  }
  const response = await serverGet(serverId, "/hubs/search", { query: queryText, sectionId: sectionKey, limit: "40" });
  const root = container(response);
  const hubs = Array.isArray(root.Hub) ? root.Hub as Array<Record<string, unknown>> : [];
  const result = await Promise.all(
    hubs
      .filter((hub) => ["artist", "album", "track"].includes(String(hub.type)))
      .map(async (hub) => ({
        title: String(hub.title || "搜索结果"),
        type: String(hub.type || "mixed"),
        items: normalizePlexItems(hub.Metadata),
      })),
  );
  return result.filter((hub) => hub.items.length > 0);
}

export async function streamUrl(serverId: string, track: PlexItem, quality: StreamQuality): Promise<string> {
  if (!isDesktopRuntime()) return "";
  const partKey = track.Media?.[0]?.Part?.[0]?.key;
  if (!partKey) throw new Error("这首歌曲没有可播放的媒体文件");
  return invoke("stream_url", { serverId, metadataKey: track.key, partKey, quality });
}

export async function addTrackToPlaylist(serverId: string, playlistId: string, ratingKey: string): Promise<void> {
  if (isDesktopRuntime()) await invoke("add_to_playlist", { serverId, playlistId, ratingKey });
}

export interface PlaylistBatchAddResult {
  requested: number;
  added: number;
  failedRatingKeys: string[];
}

/** Submit a deduplicated, ordered track batch through the native PMS boundary. */
export async function addTracksToPlaylist(
  serverId: string,
  playlistId: string,
  ratingKeys: readonly string[],
): Promise<PlaylistBatchAddResult> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(playlistId)) {
    throw new Error("无效的 Plex 歌单标识");
  }
  const uniqueRatingKeys = normalizePlaylistRatingKeys(ratingKeys);
  if (!uniqueRatingKeys.length) throw new Error("请至少选择一首歌曲");
  if (!isDesktopRuntime()) {
    const createdPlaylist = demoCreatedPlaylists.find((playlist) => playlist.ratingKey === playlistId);
    if (createdPlaylist) {
      const current = demoCreatedPlaylistItems.get(playlistId) ?? [];
      const knownTracks = demoLibraryTracks().filter((track) => uniqueRatingKeys.includes(track.ratingKey));
      const nextItems = [...current];
      const existing = new Set(current.map((track) => track.ratingKey));
      for (const track of knownTracks) {
        if (!existing.has(track.ratingKey)) {
          existing.add(track.ratingKey);
          nextItems.push(track);
        }
        demoRemovedPlaylistItemIds.delete(`${playlistId}:${track.playlistItemID ?? track.ratingKey}`);
      }
      demoCreatedPlaylistItems.set(playlistId, nextItems);
      createdPlaylist.leafCount = nextItems.length;
      createdPlaylist.duration = nextItems.reduce((total, track) => total + (track.duration ?? 0), 0);
    }
    return { requested: uniqueRatingKeys.length, added: uniqueRatingKeys.length, failedRatingKeys: [] };
  }
  return invoke("add_tracks_to_playlist", { serverId, playlistId, ratingKeys: uniqueRatingKeys });
}

export interface PlaylistBatchRemoveResult {
  requested: number;
  removed: number;
  failedItemIds: string[];
}

/** Remove tracks from a writable regular playlist through the scoped Rust command. */
export async function removeTracksFromPlaylist(
  serverId: string,
  playlistId: string,
  playlistItemIds: readonly string[],
): Promise<PlaylistBatchRemoveResult> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(playlistId)) {
    throw new Error("无效的 Plex 歌单标识");
  }
  const uniqueItemIds = [...new Set(
    playlistItemIds
      .map((itemId) => String(itemId))
      .filter((itemId) => itemId && isCleanPlexIdentifier(itemId)),
  )];
  if (!uniqueItemIds.length) throw new Error("请至少选择一首歌曲");
  if (!isDesktopRuntime()) {
    const current = demoCreatedPlaylistItems.get(playlistId) ?? demoPlaylistItems[playlistId] ?? [];
    const matched = current.filter((item) => (
      uniqueItemIds.includes(item.playlistItemID ?? item.ratingKey)
    ));
    for (const item of matched) {
      demoRemovedPlaylistItemIds.add(`${playlistId}:${item.playlistItemID ?? item.ratingKey}`);
    }
    const removed = matched.length;
    const failedItemIds = uniqueItemIds.filter((itemId) => (
      !matched.some((item) => (item.playlistItemID ?? item.ratingKey) === itemId)
    ));
    const createdPlaylist = demoCreatedPlaylists.find((playlist) => playlist.ratingKey === playlistId);
    if (createdPlaylist) {
      createdPlaylist.leafCount = Math.max(0, current.length - removed);
    }
    return { requested: uniqueItemIds.length, removed, failedItemIds };
  }
  return invoke("remove_playlist_items", { serverId, playlistId, playlistItemIds: uniqueItemIds });
}

/** Move one concrete playlist occurrence after another; no `after` means first. */
export async function movePlaylistItem(
  serverId: string,
  playlistId: string,
  playlistItemId: string,
  afterPlaylistItemId?: string,
): Promise<void> {
  if (
    !isCleanPlexIdentifier(serverId)
    || !isCleanPlexIdentifier(playlistId)
    || !isCleanPlexIdentifier(playlistItemId)
    || (afterPlaylistItemId !== undefined && !isCleanPlexIdentifier(afterPlaylistItemId))
    || playlistItemId === afterPlaylistItemId
  ) throw new Error("无效的 Plex 歌单排序标识");
  if (!isDesktopRuntime()) {
    const source = demoCreatedPlaylistItems.get(playlistId) ?? demoPlaylistItems[playlistId];
    if (!source) throw new Error("演示歌单不存在");
    const fromIndex = source.findIndex((item) => (item.playlistItemID ?? item.ratingKey) === playlistItemId);
    if (fromIndex < 0) throw new Error("演示歌单中找不到这首歌曲");
    const [moved] = source.splice(fromIndex, 1);
    const afterIndex = afterPlaylistItemId === undefined
      ? -1
      : source.findIndex((item) => (item.playlistItemID ?? item.ratingKey) === afterPlaylistItemId);
    if (afterPlaylistItemId !== undefined && afterIndex < 0) {
      source.splice(fromIndex, 0, moved);
      throw new Error("演示歌单中找不到排序目标");
    }
    source.splice(afterIndex + 1, 0, moved);
    return;
  }
  await invoke("move_playlist_item", {
    serverId,
    playlistId,
    playlistItemId,
    afterPlaylistItemId,
  });
}

export interface PlaylistChanges {
  title?: string;
  summary?: string;
}

/** Native engine commands (rodio-backed playback in Rust). */
export interface NativeNowPlayingMetadata {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  artworkUrl?: string;
}

export async function nativeAudioLoad(
  source: string,
  cacheKey?: string,
  metadata?: NativeNowPlayingMetadata,
  autoplay = true,
): Promise<number> {
  if (!isDesktopRuntime()) return -1;
  return invoke("native_audio_load", { source, cacheKey, metadata, autoplay });
}

export async function nativeAudioPlay(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_play");
}

export async function nativeAudioStop(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_stop");
}

export async function nativeAudioHeartbeat(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_heartbeat");
}

export async function nativeAudioPause(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_pause");
}

export interface NativeAudioStatus {
  is_playing: boolean;
  is_buffering: boolean;
  position_seconds: number | null;
  duration_seconds: number | null;
  volume: number;
  item_count: number;
  current_index: number | null;
  buffered_chunks: number;
  buffer_capacity: number;
  underflow_events: number;
  underflow_frames: number;
  output_stream_errors: number;
  output_recoveries: number;
  output_recovery_failures: number;
  output_recovery_pending: boolean;
}

export async function nativeAudioStatus(): Promise<NativeAudioStatus | null> {
  if (!isDesktopRuntime()) return null;
  return invoke("native_audio_status");
}

export async function nativeAudioSeek(seconds: number): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_seek", { seconds });
}

export async function nativeAudioSetVolume(volume: number): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_set_volume", { volume });
}

export async function nativeAudioSetArtwork(
  index: number,
  ratingKey: string,
  occurrenceId: string,
  artworkUrl: string,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_set_artwork", { index, ratingKey, occurrenceId, artworkUrl });
}

export async function nativeAudioQueueNextSource(
  index: number,
  source: string,
  cacheKey?: string,
  metadata?: NativeNowPlayingMetadata,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_queue_next_source", { index, source, cacheKey, metadata });
}

export interface NativeAudioCacheStatus {
  size_bytes: number;
  file_count: number;
  partial_size_bytes: number;
  partial_file_count: number;
  limit_bytes: number;
}

export async function nativeAudioCacheStatus(): Promise<NativeAudioCacheStatus> {
  if (!isDesktopRuntime()) {
    return {
      size_bytes: 0,
      file_count: 0,
      partial_size_bytes: 0,
      partial_file_count: 0,
      limit_bytes: 1024 ** 3,
    };
  }
  return invoke("native_audio_cache_status");
}

export async function nativeAudioClearCache(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_clear_cache");
}

export async function nativeAudioClearQueue(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_clear_queue");
}

export async function nativeQueuePeekNext(naturalEnded = true): Promise<number | null> {
  if (!isDesktopRuntime()) return null;
  return invoke("native_queue_peek_next", { naturalEnded });
}

export interface NativeOutputDevice {
  device_id: string;
  label: string;
  is_default: boolean;
}

export async function nativeAudioOutputDevices(): Promise<NativeOutputDevice[]> {
  if (!isDesktopRuntime()) return [];
  return invoke("native_audio_output_devices");
}

export async function nativeAudioSetOutputDevice(deviceId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_audio_set_output_device", { deviceId });
}

export interface NativeQueueTrack {
  rating_key: string;
  occurrence_id: string;
  title: string;
  artist: string;
  album: string;
}

export type NativeRepeatMode = "off" | "all" | "one";

export async function nativeQueueSet(
  tracks: NativeQueueTrack[],
  currentIndex: number,
  repeat: NativeRepeatMode,
  shuffle: boolean,
): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_queue_set", { tracks, currentIndex, repeat, shuffle });
}

export async function nativeQueueNext(): Promise<number> {
  if (!isDesktopRuntime()) return -1;
  return invoke("native_queue_next");
}

export async function nativeQueuePrevious(): Promise<number> {
  if (!isDesktopRuntime()) return -1;
  return invoke("native_queue_previous");
}

export async function nativeQueueSetRepeat(repeat: NativeRepeatMode): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_queue_set_repeat", { repeat });
}

export async function nativeQueueSetShuffle(shuffle: boolean): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("native_queue_set_shuffle", { shuffle });
}

/** Update a regular playlist's title/summary through the scoped Rust command. */
export async function updatePlaylist(
  serverId: string,
  playlistId: string,
  changes: PlaylistChanges,
): Promise<void> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(playlistId)) {
    throw new Error("无效的 Plex 歌单标识");
  }
  const title = changes.title === undefined ? undefined : normalizePlaylistTitle(changes.title);
  const summary = changes.summary === undefined ? undefined : normalizePlaylistSummary(changes.summary);
  if (title === undefined && summary === undefined) return;
  if (!isDesktopRuntime()) {
    const target = [...demoCreatedPlaylists, ...demoPlaylists].find((playlist) => playlist.ratingKey === playlistId);
    if (target) {
      if (title !== undefined) target.title = title;
      if (summary !== undefined) target.summary = summary;
    }
    return;
  }
  await invoke("update_playlist", { serverId, playlistId, title, summary });
}

/** Delete a playlist through the scoped Rust command. */
export async function deletePlaylist(serverId: string, playlistId: string): Promise<void> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(playlistId)) {
    throw new Error("无效的 Plex 歌单标识");
  }
  if (!isDesktopRuntime()) {
    const createdIndex = demoCreatedPlaylists.findIndex((playlist) => playlist.ratingKey === playlistId);
    if (createdIndex >= 0) {
      demoCreatedPlaylists.splice(createdIndex, 1);
      return;
    }
    const demoIndex = demoPlaylists.findIndex((playlist) => playlist.ratingKey === playlistId);
    if (demoIndex >= 0) demoPlaylists.splice(demoIndex, 1);
    return;
  }
  await invoke("delete_playlist", { serverId, playlistId });
}

export async function getLyrics(serverId: string, ratingKey: string): Promise<PlexLyricsPayload | null> {
  if (!isDesktopRuntime()) {
    return {
      provider: "本地歌词",
      timed: true,
      by: "Cadilume 演示",
      lines: [
        { startMs: 0, endMs: 5_000, text: "把你的音乐留在自己的服务器" },
        { startMs: 5_000, endMs: 10_000, text: "在桌面上轻松地播放" },
        { startMs: 10_000, endMs: 15_000, text: "本地直连，也支持远程串流" },
        { startMs: 15_000, text: "Cadilume" },
      ],
    };
  }
  return invoke("lyrics", { serverId, ratingKey });
}

export async function artworkUrl(serverId: string, path: string, width: number, height = width): Promise<string> {
  if (!isDesktopRuntime()) return path;
  return new Promise<string>((resolve, reject) => {
    artworkQueue.push(() => {
      void invoke<string>("artwork_url", { serverId, path, width, height })
        .then(resolve, reject)
        .finally(() => {
          activeArtworkRequests -= 1;
          drainArtworkQueue();
        });
    });
    drainArtworkQueue();
  });
}

export async function getCacheStatus(): Promise<CacheStatus> {
  return isDesktopRuntime() ? invoke("cache_status") : { sizeBytes: 0, fileCount: 0 };
}

export async function clearArtworkCache(): Promise<CacheStatus> {
  return isDesktopRuntime() ? invoke("clear_cache") : { sizeBytes: 0, fileCount: 0 };
}

export async function checkAppUpdate(): Promise<AppUpdateInfo | undefined> {
  if (!isDesktopRuntime()) return undefined;
  return (await invoke<AppUpdateInfo | null>("check_app_update")) ?? undefined;
}

export async function installAppUpdate(onEvent: (event: AppUpdateEvent) => void): Promise<void> {
  if (!isDesktopRuntime()) throw new Error("浏览器预览不支持应用更新");
  const onEventChannel = new Channel<AppUpdateEvent>(onEvent);
  await invoke("install_app_update", { onEvent: onEventChannel });
}

export async function setAutoUpdateEnabled(enabled: boolean): Promise<boolean> {
  if (!isDesktopRuntime()) return enabled;
  return invoke("set_auto_update_enabled", { enabled });
}

export async function setStatusIconEnabled(enabled: boolean): Promise<boolean> {
  if (!isDesktopRuntime()) return enabled;
  return invoke("set_status_icon_enabled", { enabled });
}

export async function setDeviceName(deviceName: string): Promise<string> {
  const normalized = normalizeDeviceName(deviceName);
  if (!isDesktopRuntime()) return normalized;
  return invoke("set_device_name", { deviceName: normalized });
}

export async function setBrandPreset(preset: BrandPreset): Promise<void> {
  if (isDesktopRuntime()) await invoke("set_brand_preset", { preset });
}

export async function quitApplication(): Promise<void> {
  if (isDesktopRuntime()) await invoke("quit_app");
}

export async function showMainWindow(): Promise<void> {
  if (isDesktopRuntime()) await invoke("show_main_window");
}

export async function openWindowsAudioSettings(): Promise<void> {
  if (isDesktopRuntime()) await openUrl("ms-settings:apps-volume");
}

export async function reportTimeline(serverId: string, track: PlexItem, playbackState: "playing" | "paused" | "stopped", time: number): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke("report_timeline", {
    serverId,
    ratingKey: track.ratingKey,
    metadataKey: track.key,
    playbackState,
    time: Math.round(time * 1000),
    duration: track.duration ?? 0,
  });
}

export async function scrobble(serverId: string, ratingKey: string): Promise<void> {
  if (isDesktopRuntime()) await invoke("scrobble", { serverId, ratingKey });
}

async function serverGet(serverId: string, path: string, query: Record<string, string> = {}): Promise<unknown> {
  return invoke("server_get", { serverId, path, query });
}

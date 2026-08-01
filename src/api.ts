import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { demoAlbums, demoArtists, demoBootstrap, demoPlaylistItems, demoPlaylists, demoRecommendationHubs, demoSections, demoServers, demoTracks } from "./demo";
import { plexLibraryTrackSort, plexSingerTrackSort, sortTracks, type TrackSortState } from "./trackSort";
import type { BootstrapResponse, BrandPreset, CacheStatus, LibrarySection, PlexHub, PlexItem, PlexItemPage, PlexLyricsPayload, PlexPin, PlexPlaylist, PlexServer, StreamQuality } from "./types";

const artworkQueue: Array<() => void> = [];
let activeArtworkRequests = 0;
let demoArtistTrackFailureKey: string | undefined;
let demoPlaylistSequence = 0;
const demoCreatedPlaylists: PlexPlaylist[] = [];
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
  return Array.isArray(items) ? items as PlexItem[] : [];
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
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    if (type === 8) return demoArtists;
    if (type === 9) return demoAlbums;
    const previewMultiArtist = import.meta.env.DEV
      && typeof window.location?.search === "string"
      && new URLSearchParams(window.location.search).has("multi-artist-preview");
    return previewMultiArtist
      ? demoTracks.map((track, index) => index === 0 ? { ...track, grandparentTitle: `${demoArtists[0].title} / Kobe Bryant` } : track)
      : demoTracks;
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
    const item = [...demoArtists, ...demoAlbums, ...demoLibraryTracks()].find((candidate) => candidate.ratingKey === ratingKey);
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
  if (!isDesktopRuntime()) return [...demoCreatedPlaylists, ...demoPlaylists];
  const response = await invoke<unknown>("get_playlists", { serverId });
  return playlistRecords(response)
    .map(normalizePlaylist)
    .filter((playlist): playlist is PlexPlaylist => (
      playlist !== undefined
      && playlist.playlistType === "audio"
    ));
}

/** Create an empty regular audio playlist through the selected server's scoped PMS token. */
export async function createPlaylist(serverId: string, title: string, summary = ""): Promise<PlexPlaylist> {
  if (!isCleanPlexIdentifier(serverId)) throw new Error("无效的 Plex 服务器标识");
  const normalizedTitle = normalizePlaylistTitle(title);
  const normalizedSummary = normalizePlaylistSummary(summary);
  if (!isDesktopRuntime()) {
    const ratingKey = `playlist-created-${++demoPlaylistSequence}`;
    const playlist: PlexPlaylist = {
      ratingKey,
      key: `/playlists/${ratingKey}/items`,
      type: "playlist",
      title: normalizedTitle,
      summary: normalizedSummary || undefined,
      playlistType: "audio",
      smart: false,
      readOnly: false,
      leafCount: 0,
      duration: 0,
      addedAt: Date.now() / 1000,
    };
    demoCreatedPlaylists.unshift(playlist);
    return { ...playlist };
  }
  const response = await invoke<unknown>("create_playlist", { serverId, title: normalizedTitle, summary: normalizedSummary });
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
  if (!isDesktopRuntime()) return [...(demoPlaylistItems[playlistId] ?? [])];
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
  const previewCount = import.meta.env.DEV && typeof window.location?.search === "string"
    ? Number.parseInt(new URLSearchParams(window.location.search).get("track-preview") || "", 10)
    : Number.NaN;
  if (!Number.isFinite(previewCount) || previewCount <= demoTracks.length) return demoTracks;

  return Array.from({ length: Math.min(2_000, previewCount) }, (_, index) => {
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
      items: Array.isArray(rawItems) ? rawItems.filter(isRecord) as unknown as PlexItem[] : [],
    };
  }).filter((hub) => hub.items.length > 0 && ["artist", "album", "track"].includes(hub.type));
}

export async function getTrackMetadata(serverId: string, ratingKey: string): Promise<PlexItem> {
  if (!isCleanPlexIdentifier(serverId) || !isCleanPlexIdentifier(ratingKey)) {
    throw new Error("无效的 Plex 歌曲标识");
  }
  if (!isDesktopRuntime()) {
    const track = demoTracks.find((item) => item.ratingKey === ratingKey);
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
  return Promise.all(hubs.filter((hub) => ["artist", "album", "track"].includes(String(hub.type))).map(async (hub) => ({
    title: String(hub.title || "搜索结果"),
    type: String(hub.type || "mixed"),
    items: Array.isArray(hub.Metadata) ? hub.Metadata as PlexItem[] : [],
  })));
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

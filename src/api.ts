import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { demoAlbums, demoArtists, demoBootstrap, demoPlaylistItems, demoPlaylists, demoSections, demoServers, demoTracks } from "./demo";
import type { BootstrapResponse, CacheStatus, CloseBehavior, LibrarySection, PlexHub, PlexItem, PlexLyricsPayload, PlexPin, PlexPlaylist, PlexServer, StreamQuality } from "./types";

const artworkQueue: Array<() => void> = [];
let activeArtworkRequests = 0;
const MAX_ARTWORK_REQUESTS = 6;

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
  };
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
    return type === 8 ? demoArtists : type === 9 ? demoAlbums : demoTracks;
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
  if (!isDesktopRuntime()) return [...demoPlaylists];
  const response = await invoke<unknown>("get_playlists", { serverId });
  return playlistRecords(response)
    .map(normalizePlaylist)
    .filter((playlist): playlist is PlexPlaylist => (
      playlist !== undefined
      && playlist.playlistType === "audio"
    ));
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

export async function setCloseBehavior(behavior: CloseBehavior): Promise<void> {
  if (isDesktopRuntime()) await invoke("set_close_behavior", { behavior });
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

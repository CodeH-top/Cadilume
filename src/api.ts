import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { demoAlbums, demoArtists, demoBootstrap, demoSections, demoServers, demoTracks } from "./demo";
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

function booleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes"].includes(value.trim().toLowerCase());
  return false;
}

function normalizePlaylist(value: Record<string, unknown>): PlexPlaylist | undefined {
  const ratingKey = optionalString(value.ratingKey);
  const title = optionalString(value.title);
  if (!ratingKey || !title) return undefined;
  const playlistType = optionalString(value.playlistType)?.toLowerCase();
  if (!playlistType) return undefined;
  const type = optionalString(value.type) || "playlist";
  if (type !== "playlist") return undefined;
  return {
    ratingKey,
    key: optionalString(value.key) || `/playlists/${ratingKey}/items`,
    type,
    title,
    summary: optionalString(value.summary),
    playlistType,
    smart: booleanFlag(value.smart),
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
  const query: Record<string, string> = {
    type: String(type),
    sort: type === 10 ? "titleSort:asc" : "titleSort:asc",
    "X-Plex-Container-Start": "0",
    "X-Plex-Container-Size": type === 10 ? "500" : "120",
  };
  const response = await serverGet(serverId, `/library/sections/${sectionKey}/all`, query);
  return metadata(response);
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

/**
 * Return only regular audio playlists. The server receives the supported
 * `playlistType=audio` filter, while the client still removes smart playlists
 * because PMS versions may ignore a smart-playlist query parameter.
 */
export async function getPlaylists(serverId: string): Promise<PlexPlaylist[]> {
  if (!isDesktopRuntime()) return [];
  const response = await serverGet(serverId, "/playlists", { playlistType: "audio" });
  return playlistRecords(response)
    .map(normalizePlaylist)
    .filter((playlist): playlist is PlexPlaylist => playlist !== undefined && playlist.playlistType === "audio" && !playlist.smart);
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

export async function artworkDataUrl(serverId: string, path: string, width: number, height = width): Promise<string> {
  if (!isDesktopRuntime()) return path;
  return new Promise<string>((resolve, reject) => {
    artworkQueue.push(() => {
      void invoke<string>("image_data_url", { serverId, path, width, height })
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

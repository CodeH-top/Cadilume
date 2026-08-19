import {
  discoverServers,
  getLibraryItems,
  getPlaylists,
  getRecentAlbums,
  getRecommendationHubs,
  getSections,
} from "./api";
import type { LibrarySection, PlexHub, PlexItem, PlexPlaylist, PlexServer } from "./types";

export interface InitialHomeData {
  recentAlbums: PlexItem[];
  hubs: PlexHub[];
}

export interface InitialLibraryData {
  servers: PlexServer[];
  serverId?: string;
  sections: LibrarySection[];
  sectionKey?: string;
  playlists: PlexPlaylist[];
  /** False when the playlist sidebar needs a background refresh after mounting. */
  playlistsComplete?: boolean;
  libraryArtists: PlexItem[];
  /** False when the startup snapshot intentionally contains only a preview. */
  libraryArtistsComplete?: boolean;
  home: InitialHomeData;
  /** False when the home snapshot needs a background refresh after mounting. */
  homeComplete?: boolean;
}

export interface InitialLibrarySource {
  discoverServers: typeof discoverServers;
  getSections: typeof getSections;
  getPlaylists: typeof getPlaylists;
  getLibraryItems: typeof getLibraryItems;
  getRecommendationHubs: typeof getRecommendationHubs;
  getRecentAlbums: typeof getRecentAlbums;
  getInitialLibraryArtists?: (serverId: string, sectionKey: string) => Promise<PlexItem[]>;
}

export const INITIAL_LIBRARY_ARTIST_LIMIT = 120;
const REQUIRED_STARTUP_REQUEST_TIMEOUT_MS = 15_000;

export function isInitialLibrarySnapshotScopeActive(
  invalidated: boolean,
  sourceRevision: number,
  currentId: string | undefined,
  initialId: string | undefined,
): boolean {
  return !invalidated && sourceRevision === 0 && currentId === initialId;
}

const defaultSource: InitialLibrarySource = {
  discoverServers,
  getSections,
  getPlaylists,
  getLibraryItems,
  getRecommendationHubs,
  getRecentAlbums,
  getInitialLibraryArtists: (serverId, sectionKey) => getLibraryItems(serverId, sectionKey, 8, {
    maxItems: INITIAL_LIBRARY_ARTIST_LIMIT,
  }),
};

/**
 * Tauri invokes cannot be cancelled from the WebView. A bounded promise keeps
 * startup recoverable when a Plex connection or a stale WebView IPC call does
 * not settle; the underlying request may finish later, but it can no longer
 * hold the first screen hostage.
 */
export function withStartupTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (reason) {
      pending = Promise.reject(reason);
    }
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

export function orderPlaylistsByRecency(playlists: readonly PlexPlaylist[]): PlexPlaylist[] {
  return [...playlists].sort((left, right) => {
    const leftTime = left.addedAt ?? left.updatedAt ?? 0;
    const rightTime = right.addedAt ?? right.updatedAt ?? 0;
    return rightTime - leftTime;
  });
}

export async function loadInitialLibraryData(
  preferredServerId?: string,
  source: InitialLibrarySource = defaultSource,
): Promise<InitialLibraryData> {
  const servers = await withStartupTimeout(
    () => source.discoverServers(),
    REQUIRED_STARTUP_REQUEST_TIMEOUT_MS,
    "发现 Plex Media Server 超时，请检查网络连接后重试。",
  );
  if (!servers.length) {
    return {
      servers,
      sections: [],
      playlists: [],
      libraryArtists: [],
      home: { recentAlbums: [], hubs: [] },
    };
  }

  const preferredServer = servers.find((server) => server.id === preferredServerId);
  const orderedServers = preferredServer
    ? [preferredServer, ...servers.filter((server) => server.id !== preferredServer.id)]
    : servers;
  let lastError: unknown;

  for (const selectedServer of orderedServers) {
    try {
      const sections = await withStartupTimeout(
        () => source.getSections(selectedServer.id),
        REQUIRED_STARTUP_REQUEST_TIMEOUT_MS,
        `读取 ${selectedServer.name} 的音乐资料库超时。`,
      );
      const selectedSection = sections[0];
      const playlists: PlexPlaylist[] = [];
      if (!selectedSection) {
        return {
          servers,
          serverId: selectedServer.id,
          sections,
          playlists,
          playlistsComplete: false,
          libraryArtists: [],
          home: { recentAlbums: [], hubs: [] },
        };
      }

      // Artists, recommendation hubs, and recent albums are explicitly
      // optional. Do not hold the first screen hostage while waiting for any
      // of them; MusicShell already hydrates these sources after mounting.
      return {
        servers,
        serverId: selectedServer.id,
        sections,
        sectionKey: selectedSection.key,
        playlists,
        playlistsComplete: false,
        libraryArtists: [],
        libraryArtistsComplete: false,
        home: {
          recentAlbums: [],
          hubs: [],
        },
        homeComplete: false,
      };
    } catch (reason) {
      lastError = reason;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : "无法加载 Plex 资料库。");
}

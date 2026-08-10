import {
  discoverServers,
  getLibraryItems,
  getPlaylists,
  getRecentAlbums,
  getRecommendationHubs,
  getSections,
} from "./api";
import { homeRecommendationHubs, isRecentlyAddedHub } from "./recommendations";
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
  libraryArtists: PlexItem[];
  home: InitialHomeData;
}

export interface InitialLibrarySource {
  discoverServers: typeof discoverServers;
  getSections: typeof getSections;
  getPlaylists: typeof getPlaylists;
  getLibraryItems: typeof getLibraryItems;
  getRecommendationHubs: typeof getRecommendationHubs;
  getRecentAlbums: typeof getRecentAlbums;
}

const defaultSource: InitialLibrarySource = {
  discoverServers,
  getSections,
  getPlaylists,
  getLibraryItems,
  getRecommendationHubs,
  getRecentAlbums,
};

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
  const servers = await source.discoverServers();
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
      const [sections, playlistCatalog] = await Promise.all([
        source.getSections(selectedServer.id),
        source.getPlaylists(selectedServer.id),
      ]);
      const selectedSection = sections[0];
      const playlists = orderPlaylistsByRecency(playlistCatalog);
      if (!selectedSection) {
        return {
          servers,
          serverId: selectedServer.id,
          sections,
          playlists,
          libraryArtists: [],
          home: { recentAlbums: [], hubs: [] },
        };
      }

      const [libraryArtists, recommendationHubs, recentAlbums] = await Promise.all([
        source.getLibraryItems(selectedServer.id, selectedSection.key, 8),
        source.getRecommendationHubs(selectedServer.id, selectedSection.key),
        source.getRecentAlbums(selectedServer.id, selectedSection.key),
      ]);
      const completeHubs = recommendationHubs.some(isRecentlyAddedHub) || !recentAlbums.length
        ? recommendationHubs
        : [
            ...recommendationHubs,
            {
              title: "最近加入的音乐",
              type: "album",
              identifier: "cadilume.recentlyadded",
              items: recentAlbums,
            },
          ];

      return {
        servers,
        serverId: selectedServer.id,
        sections,
        sectionKey: selectedSection.key,
        playlists,
        libraryArtists,
        home: {
          recentAlbums,
          hubs: homeRecommendationHubs(completeHubs),
        },
      };
    } catch (reason) {
      lastError = reason;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(lastError ? String(lastError) : "无法加载 Plex 资料库。");
}

import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./api";
import type { InitialLibraryData } from "./initialLibrary";
import { homeRecommendationHubs } from "./recommendations";

const STARTUP_PLAYLIST_LIMIT = 50;
const STARTUP_RECENT_ALBUM_LIMIT = 18;

function isInitialLibraryData(value: unknown): value is InitialLibraryData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<InitialLibraryData>;
  const home = data.home;
  return Array.isArray(data.servers)
    && Array.isArray(data.sections)
    && Array.isArray(data.playlists)
    && Array.isArray(data.libraryArtists)
    && Boolean(home && typeof home === "object")
    && Array.isArray(home?.recentAlbums)
    && Array.isArray(home?.hubs);
}

/**
 * The desktop cache lives in Rust's SQLite store so dev and release share the
 * same app-cache boundary. The database contains catalog metadata only; the
 * Rust command rejects credential-like keys before writing it. Every command
 * is async and its filesystem/database work runs on a blocking worker.
 */
export async function readInitialLibraryCache(): Promise<InitialLibraryData | undefined> {
  if (!isDesktopRuntime()) return undefined;
  try {
    const data = await invoke<InitialLibraryData | null>("read_initial_library_cache");
    if (!isInitialLibraryData(data)) return undefined;
    return {
      ...data,
      playlists: data.playlists.slice(0, STARTUP_PLAYLIST_LIMIT),
      home: {
        recentAlbums: data.home.recentAlbums.slice(0, STARTUP_RECENT_ALBUM_LIMIT),
        hubs: homeRecommendationHubs(data.home.hubs),
      },
      playlistsComplete: false,
      libraryArtistsComplete: false,
      homeComplete: false,
    };
  } catch {
    return undefined;
  }
}

export async function writeInitialLibraryCache(data: InitialLibraryData): Promise<void> {
  if (!isDesktopRuntime() || !isInitialLibraryData(data) || !data.servers.length || !data.sections.length || !data.serverId || !data.sectionKey) return;
  try {
    await invoke("write_initial_library_cache", { data });
  } catch {
    // A cache is an optimization; startup must remain functional if SQLite
    // is unavailable or the cache path is not writable.
  }
}

export async function clearInitialLibraryCache(): Promise<void> {
  if (!isDesktopRuntime()) return;
  try {
    await invoke("clear_initial_library_cache");
  } catch {
    // Logout must not be blocked by optional cache cleanup.
  }
}

import type { InitialLibraryData } from "./initialLibrary";

const DATABASE_NAME = "cadilume-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "initial-library";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface InitialLibraryCacheRecord {
  version: 1;
  cachedAt: number;
  data: InitialLibraryData;
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前 WebView 不支持 IndexedDB。"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error || new Error("打开本地资料缓存失败。"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function runStoreRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openCache().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error || new Error("本地资料缓存操作失败。"));
    request.onsuccess = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error || new Error("本地资料缓存事务失败。"));
    transaction.oncomplete = () => database.close();
  }));
}

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
 * This cache contains only Plex catalog metadata and never credentials or
 * server tokens. IndexedDB keeps the read/write asynchronous so startup does
 * not synchronously parse a large JSON blob on the WebView thread.
 */
export async function readInitialLibraryCache(): Promise<InitialLibraryData | undefined> {
  try {
    const record = await runStoreRequest<InitialLibraryCacheRecord | undefined>(
      "readonly",
      (store) => store.get(SNAPSHOT_KEY),
    );
    if (!record || record.version !== 1 || !Number.isFinite(record.cachedAt)) return undefined;
    if (Date.now() - record.cachedAt > MAX_CACHE_AGE_MS || !isInitialLibraryData(record.data)) return undefined;
    // Cached data is useful for the first paint, but all network-backed parts
    // must still refresh after MusicShell mounts.
    return {
      ...record.data,
      playlistsComplete: false,
      libraryArtistsComplete: false,
      homeComplete: false,
    };
  } catch {
    return undefined;
  }
}

export async function writeInitialLibraryCache(data: InitialLibraryData): Promise<void> {
  if (!isInitialLibraryData(data) || !data.servers.length || !data.sections.length || !data.serverId || !data.sectionKey) return;
  try {
    await runStoreRequest<IDBValidKey>("readwrite", (store) => store.put({
      version: 1,
      cachedAt: Date.now(),
      data,
    } satisfies InitialLibraryCacheRecord, SNAPSHOT_KEY));
  } catch {
    // A cache is an optimization; startup must remain functional if storage
    // is unavailable or the WebView quota is exhausted.
  }
}

export async function clearInitialLibraryCache(): Promise<void> {
  try {
    await runStoreRequest<undefined>("readwrite", (store) => store.delete(SNAPSHOT_KEY));
  } catch {
    // Logout must not be blocked by an optional cache cleanup failure.
  }
}

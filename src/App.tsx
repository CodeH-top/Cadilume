import {
  Album,
  AudioLines,
  ArrowUp,
  Captions,
  Check,
  CircleUserRound,
  Copy,
  History,
  ListPlus,
  ListMusic,
  LockKeyhole,
  LoaderCircle,
  Minus,
  Mic2,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  Repeat1,
  Search,
  Settings,
  Square,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { KeepAlive, type KeepAliveRef, useKeepAliveContext, useKeepAliveRef } from "keepalive-for-react";
import { createHashRouter, Navigate, RouterProvider, useLocation, useNavigate, useOutlet } from "react-router-dom";
import { createContext, FormEvent, lazy, memo, ReactNode, startTransition, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushSync } from "react-dom";
import { TooltipLayer } from "./TooltipLayer";
import {
  addTracksToPlaylist,
  bootstrap,
  canWritePlaylist,
  clearArtworkCache,
  createPlaylist,
  deletePlaylist,
  discoverServers,
  getArtistTracksPage,
  getCacheStatus,
  getChildren,
  getLibraryItems,
  getTracksPage,
  getPlaylistItems,
  getPlaylists,
  getSections,
  isDesktopRuntime,
  logout,
  markMainUiReady,
  nativeAudioCacheStatus,
  nativeAudioWarmup,
  refreshAccount,
  setCloseBehavior as saveCloseBehavior,
  setStatusIconEnabled as saveStatusIconEnabled,
  setBrandPreset as saveBrandPreset,
  setDeviceName as saveDeviceName,
  updatePlaylist,
  type PlaylistChanges,
  type NativeAudioCacheStatus,
} from "./api";
import "./App.css";
import { appendUniqueArtistTracks } from "./artistTracks";
import {
  isInitialLibrarySnapshotScopeActive,
  loadInitialLibraryData,
  orderPlaylistsByRecency,
  withStartupTimeout,
  type InitialLibraryData,
} from "./initialLibrary";
import { clearInitialLibraryCache, readInitialLibraryCache, writeInitialLibraryCache } from "./initialLibraryCache";
import { libraryDetailRoute, libraryRouteHash, parseLibraryRoute, type LibraryDetailType, type LibraryRoute } from "./libraryRoute";
import { createCadilumeEntryState, historyEntryCacheKey, routeEntryId, routeParentEntryId } from "./routeEntry";
import { routeScrollBehavior, shouldShowRouteBackToTop } from "./routeScroll";
import { hasDisplayableLyrics } from "./lyrics";
import { NowPlayingView, type NowPlayingLyricsState, type NowPlayingMode } from "./NowPlayingView";
import { useActiveLyricsScroll } from "./lyricsScroll";
import { getLyricsActionPresentation } from "./playerActions";
import { playbackControlLabel, rangeFillPercent, usableDurationSeconds } from "./playerUi";
import type {
  BootstrapResponse,
  BrandPreset,
  CacheStatus,
  CloseBehavior,
  LibrarySection,
  LibraryView,
  PlexAccount,
  PlexItem,
  PlexPlaylist,
  PlexServer,
  StreamQuality,
  ThemeMode,
} from "./types";
import { DEFAULT_STREAM_QUALITY, formatDuration, trackArtist } from "./types";
import { queueNavigationAvailability, readPersistedPlaybackSession, usePlayer, type PlaybackFailure } from "./usePlayer";
import { detectOutputPlatform, useOutputDevices } from "./useOutputDevices";
import { useLyrics } from "./useLyrics";
import { usePlexLogin } from "./usePlexLogin";
import { BrandIcon } from "./BrandIcon";
import { applyBrandPreset, BRAND_STORAGE_KEY, normalizeBrandPreset, persistBrandPreset, readInitialBrandPreset } from "./brand";
import { GlobalNotificationQueue, useGlobalNotificationQueue } from "./NotificationQueue";
import type { GlobalNotificationLevel } from "./notifications";
import { applyThemeMode, readInitialThemeMode } from "./theme";
import { SharedVolumeControl } from "./VolumeControl";
import { rasterizeAppearanceSnapshotImages, shouldAnimateAppearanceReveal } from "./appearanceTransition";
import { useAppUpdater, type AppUpdaterController } from "./useAppUpdater";
import { artworkCacheIdentity, clearArtworkTicketCache, getResolvedArtwork, invalidateCachedArtwork, prewarmArtwork, requestCachedArtwork } from "./artworkCache";
import { playbackLog } from "./playbackLog";
import {
  ConnectionIndicator,
  DeviceNameDialog,
  PlaylistSidebar,
  ThemeCycleButton,
  type ConnectionKind,
} from "./LibraryShellComponents";

type Icon = typeof Album;

const navigation: Array<{ id: LibraryView; label: string; icon: Icon }> = [
  { id: "home", label: "推荐", icon: History },
  { id: "albums", label: "专辑", icon: Album },
  { id: "artists", label: "歌手", icon: Mic2 },
  { id: "tracks", label: "歌曲", icon: Music2 },
];

const BRAND_PRESET_OPTIONS: ReadonlyArray<{ preset: BrandPreset; label: string }> = [
  { preset: "amber", label: "琥珀金" },
  { preset: "verdant", label: "雨林绿" },
  { preset: "azure", label: "澄海蓝" },
];

const ArtworkServerContext = createContext<string | undefined>(undefined);
const MusicShellContext = createContext<MusicShellRuntime | undefined>(undefined);
type MusicPlayerActions = Pick<MusicPlayer, "playContext" | "playTracks" | "appendTracks" | "insertTracksNext" | "setShuffle" | "setPrebufferNext">;
interface MusicPlayerState {
  current: MusicPlayer["current"];
  playing: MusicPlayer["playing"];
}
const MusicPlayerActionsContext = createContext<MusicPlayerActions | undefined>(undefined);
const MusicPlayerStateContext = createContext<MusicPlayerState | undefined>(undefined);
const RouteEntryContext = createContext<RoutePageProps | undefined>(undefined);
const NOW_PLAYING_MODE_STORAGE_KEY = "cadilume-now-playing-mode";
const ARTIST_TRACK_PAGE_SIZE = 50;
const SOURCE_SYNC_OVERLAY_MINIMUM_MS = 600;
const SIDE_PANEL_MOTION_MS = 220;
const STARTUP_ARTWORK_LIMIT = 24;
const STARTUP_ARTWORK_CONCURRENCY = 4;
const STARTUP_ARTWORK_BUDGET_MS = 8_000;
const STARTUP_ARTWORK_REQUEST_TIMEOUT_MS = 2_500;
type ResolvedTheme = ThemeMode;
type ThemeTransitionOrigin = { x: number; y: number };
type ThemeModeChange = (mode: ThemeMode, origin?: ThemeTransitionOrigin) => void;
export type BrandPresetChange = (preset: BrandPreset, origin?: ThemeTransitionOrigin) => Promise<void>;
type AppearanceState = { theme: ThemeMode; brand: BrandPreset };

export type MusicPlayer = ReturnType<typeof usePlayer>;
export type OutputDevicesController = ReturnType<typeof useOutputDevices>;
type PlaylistSelection = { tracks: PlexItem[]; label: string };
const BOOTSTRAP_ACCOUNT_PLACEHOLDER: PlexAccount = {
  username: "Plex",
  title: "Plex",
  email: "",
  home: false,
  restricted: false,
  subscriptionActive: false,
};

function hasUsableInitialLibrary(data: InitialLibraryData): boolean {
  return data.servers.length > 0
    && data.sections.length > 0
    && Boolean(data.serverId)
    && Boolean(data.sectionKey);
}

function artworkPathFor(item?: { thumb?: string; art?: string; composite?: string }): string | undefined {
  return item?.thumb || item?.composite || item?.art;
}

function decodeArtwork(url: string): Promise<boolean> {
  if (typeof Image === "undefined") return Promise.resolve(true);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const decode = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      void decode.then(() => resolve(true), () => resolve(true));
    };
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

function startupArtworkItems(data: InitialLibraryData, restoredTrack?: PlexItem): PlexItem[] {
  const candidates = [
    ...(restoredTrack ? [restoredTrack] : []),
    ...data.home.recentAlbums,
    ...data.home.hubs.flatMap((hub) => hub.items),
    ...data.playlists.slice(0, 16),
  ];
  const seen = new Set<string>();
  const unique: PlexItem[] = [];
  for (const item of candidates) {
    const path = artworkPathFor(item);
    if (!path) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(item);
    if (unique.length >= STARTUP_ARTWORK_LIMIT) break;
  }
  return unique;
}

async function prepareInitialLibraryArtwork(
  data: InitialLibraryData,
  restoredTrack?: PlexItem,
): Promise<InitialLibraryData> {
  if (!isDesktopRuntime() || !data.serverId) return data;
  const items = startupArtworkItems(data, restoredTrack);
  if (!items.length) return data;
  const warmed = new Map<string, string>();
  const deadline = Date.now() + STARTUP_ARTWORK_BUDGET_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length && Date.now() < deadline) {
      const item = items[cursor++];
      const path = artworkPathFor(item);
      if (!path) continue;
      try {
        const remaining = Math.max(1, Math.min(
          STARTUP_ARTWORK_REQUEST_TIMEOUT_MS,
          deadline - Date.now(),
        ));
        const trustedImageUrl = item.imageUrl && !isLoopbackArtworkSource(item.imageUrl)
          ? item.imageUrl
          : undefined;
        const url = trustedImageUrl || await withStartupTimeout(
          () => requestCachedArtwork(
            data.serverId as string,
            path,
            420,
            420,
            artworkCacheIdentity(item),
          ),
          remaining,
          "首屏封面缓存准备超时。",
        );
        const decoded = await withStartupTimeout(
          () => decodeArtwork(url),
          Math.max(1, Math.min(STARTUP_ARTWORK_REQUEST_TIMEOUT_MS, deadline - Date.now())),
          "首屏封面解码超时。",
        );
        if (decoded) warmed.set(item.ratingKey, url);
      } catch {
        // A failed cover gets the normal placeholder; it must not block the
        // window forever when a PMS thumbnail is malformed or unavailable.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STARTUP_ARTWORK_CONCURRENCY, items.length) }, worker));
  const withArtwork = <T extends { ratingKey: string; thumb?: string; art?: string; composite?: string }>(item: T): T => {
    const imageUrl = warmed.get(item.ratingKey);
    return imageUrl ? { ...item, imageUrl } as T : item;
  };
  return {
    ...data,
    playlists: data.playlists.map(withArtwork),
    libraryArtists: data.libraryArtists.map(withArtwork),
    home: {
      ...data.home,
      recentAlbums: data.home.recentAlbums.map(withArtwork),
      hubs: data.home.hubs.map((hub) => ({ ...hub, items: hub.items.map(withArtwork) })),
    },
  };
}

export interface MusicShellRuntime {
  initialSession: BootstrapResponse;
  initialLibrary: InitialLibraryData;
  account: PlexAccount;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  brandPreset: BrandPreset;
  onThemeMode: ThemeModeChange;
  onBrandPreset: BrandPresetChange;
  servers: PlexServer[];
  serverId?: string;
  selectedServer?: PlexServer;
  sections: LibrarySection[];
  sectionKey?: string;
  selectedSection?: LibrarySection;
  libraryArtists: PlexItem[];
  connectionAvailable: boolean;
  expandedPlayerOpen: boolean;
  playlists: PlexPlaylist[];
  playlistListLoading: boolean;
  playlistListError?: string;
  loadPlaylistList: (announce?: boolean) => Promise<void>;
  updatePlaylist: (playlist: PlexPlaylist, changes: PlaylistChanges) => Promise<void>;
  deletePlaylist: (playlist: PlexPlaylist) => Promise<void>;
  sourceRevision: number;
  initialSectionSnapshotActive: boolean;
  playlistMutationRevision: number;
  bumpPlaylistMutation: () => void;
  routeAliveRef: RefObject<KeepAliveRef | null>;
  statusIconEnabled: boolean;
  statusIconPlatform?: BootstrapResponse["statusIconPlatform"];
  statusIconSaving: boolean;
  closeBehavior: CloseBehavior;
  appUpdater: AppUpdaterController;
  deviceName: string;
  quality: StreamQuality;
  prebufferNext: boolean;
  cacheStatus?: CacheStatus;
  nativeCacheStatus?: NativeAudioCacheStatus;
  cacheStatusError?: string;
  artworkCacheBusy: boolean;
  audioCacheBusy: boolean;
  sourcesSyncing: boolean;
  playbackSettingsRequest: number;
  outputDevices: OutputDevicesController;
  notify: (message: string, level?: GlobalNotificationLevel) => void;
  playRecommendationItem: (item: PlexItem, context: PlexItem[]) => Promise<void>;
  playRecommendationPlaylist: (playlist: PlexPlaylist) => Promise<void>;
  changeStatusIconEnabled: (enabled: boolean) => Promise<void>;
  changeCloseBehavior: (behavior: CloseBehavior) => Promise<void>;
  changeBrandPreset: BrandPresetChange;
  changeDeviceName: (nextDeviceName: string) => Promise<string>;
  changeQuality: (value: StreamQuality) => void;
  setServerId: (value: string) => void;
  setSectionKey: (value: string) => void;
  setPrebufferNext: (value: boolean) => void;
  clearArtworkDiskCache: () => Promise<void>;
  clearAudioDiskCache: () => Promise<void>;
  syncSources: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshCacheStatus: () => Promise<void>;
  openDeviceNameDialog: () => void;
  openPlaylistCreation: () => void;
  openPlaylistPicker: (tracks: readonly PlexItem[], label?: string) => void;
  setSidePanel: (value: "queue" | "lyrics" | null) => void;
  setNowPlayingOpen: (open: boolean) => void;
  setPlaybackSettingsRequest: React.Dispatch<React.SetStateAction<number>>;
}

export function useMusicShellRuntime(): MusicShellRuntime {
  const runtime = useContext(MusicShellContext);
  if (!runtime) throw new Error("Cadilume 路由必须位于 MusicShellContext 内。");
  return runtime;
}

export function useMusicPlayerActions(): MusicPlayerActions {
  const actions = useContext(MusicPlayerActionsContext);
  if (!actions) throw new Error("Cadilume 路由缺少播放器操作上下文。");
  return actions;
}

export function useMusicPlayerState(): MusicPlayerState {
  const state = useContext(MusicPlayerStateContext);
  if (!state) throw new Error("Cadilume 路由缺少播放器状态上下文。");
  return state;
}

function routePath(route: LibraryRoute): string {
  return libraryRouteHash(route).replace(/^#/, "") || "/home";
}

function usePanelPresence(visible: boolean) {
  const [mounted, setMounted] = useState(visible);
  const exitTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (visible) {
      if (exitTimerRef.current !== undefined) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = undefined;
      }
      setMounted(true);
      return;
    }

    if (!mounted) return;
    const motionDuration = panelMotionDuration();
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = undefined;
      setMounted(false);
    }, motionDuration);

    return () => {
      if (exitTimerRef.current !== undefined) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = undefined;
      }
    };
  }, [mounted, visible]);

  useEffect(() => () => {
    if (exitTimerRef.current !== undefined) window.clearTimeout(exitTimerRef.current);
  }, []);

  return mounted;
}

function panelMotionDuration(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 1 : SIDE_PANEL_MOTION_MS;
}

export function detailTypeForItem(item: PlexItem): LibraryDetailType | undefined {
  if (item.type === "artist") return "artist";
  if (item.type === "album") return "album";
  return undefined;
}

export function LibraryPageTitle({ children }: { children: ReactNode }) {
  return <h1 className="library-page-title">{children}</h1>;
}

function App() {
  const appearance = useAppearance();
  return <MainApplication {...appearance} />;
}

function MainApplication({
  themeMode,
  resolvedTheme,
  brandPreset,
  onThemeMode,
  onBrandPreset,
  syncBrandPreset,
}: {
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  brandPreset: BrandPreset;
  onThemeMode: ThemeModeChange;
  onBrandPreset: BrandPresetChange;
  syncBrandPreset: (preset: BrandPreset) => void;
}) {
  const [session, setSession] = useState<BootstrapResponse>();
  const [initialLibrary, setInitialLibrary] = useState<InitialLibraryData>();
  const [error, setError] = useState<string>();
  const [startupStage, setStartupStage] = useState("正在恢复本地会话");
  const notifications = useGlobalNotificationQueue();
  const appUpdater = useAppUpdater(session, notifications.notify);
  const syncedBrandSessionRef = useRef<BootstrapResponse | undefined>(undefined);
  const accountRefreshRequestRef = useRef(0);
  const startupRequestRef = useRef(0);
  const nativeUiReadyStateRef = useRef<"idle" | "pending" | "done">("idle");
  const requestedUiPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("ui-preview")
    : null;
  const uiPreview = requestedUiPreview === "login" || requestedUiPreview === "splash" || requestedUiPreview === "notifications"
    ? requestedUiPreview
    : null;

  const load = useCallback(async () => {
    const startupRequestId = ++startupRequestRef.current;
    setError(undefined);
    setInitialLibrary(undefined);
    setStartupStage("正在恢复本地会话");
    try {
      const nextSession = await withStartupTimeout(
        () => bootstrap(),
        15_000,
        "恢复 Plex 登录状态超时，请重试。",
      );
      const accountRequestId = ++accountRefreshRequestRef.current;
      if (!nextSession.authenticated) {
        setSession(nextSession);
        return;
      }
      setSession(nextSession);
      setStartupStage("正在初始化播放器与音乐资料库");
      const nativeAudioReady = withStartupTimeout(
        () => nativeAudioWarmup(),
        15_000,
        "播放器初始化超时，请检查系统音频输出设备。",
      );
      const refreshedAccount = withStartupTimeout(
        () => refreshAccount(),
        8_000,
        "读取 Plex 账号信息超时。",
      ).catch(() => undefined);
      const restoredSession = readPersistedPlaybackSession();
      const restoredTrack = restoredSession && restoredSession.currentIndex >= 0
        ? restoredSession.queue[restoredSession.currentIndex] as PlexItem | undefined
        : undefined;
      const cachedLibrary = await withStartupTimeout(
        () => readInitialLibraryCache(),
        500,
        "读取本地资料缓存超时。",
      ).catch(() => undefined);
      if (cachedLibrary && hasUsableInitialLibrary(cachedLibrary)) {
        setStartupStage("正在准备首屏封面与播放器");
        const [preparedCachedLibrary, account] = await Promise.all([
          prepareInitialLibraryArtwork(cachedLibrary, restoredTrack),
          refreshedAccount,
          loadHomeRouteModule(),
          nativeAudioReady,
        ]);
        if (startupRequestRef.current !== startupRequestId) return;
        if (account && accountRequestId === accountRefreshRequestRef.current) {
          setSession({ ...nextSession, account });
        }
        setStartupStage("正在使用本地资料快照，后台更新资料库");
        startTransition(() => setInitialLibrary(preparedCachedLibrary));
        // Do not start server discovery until the cached frame is mounted.
        // Concurrent connection probing can saturate the native runtime and
        // make the first WebView paint look frozen even though the cache is
        // already ready.
        window.requestAnimationFrame(() => {
          if (startupRequestRef.current !== startupRequestId) return;
          const networkLibrary = withStartupTimeout(
            () => loadInitialLibraryData(restoredSession?.serverId),
            12_000,
            "连接音乐资料库超时，请确认 Plex Media Server 在线后重试。",
          );
          void networkLibrary.then((nextLibrary) => {
            if (startupRequestRef.current !== startupRequestId) return;
            if (!hasUsableInitialLibrary(nextLibrary)) {
              console.warn("[资料库] 后台刷新没有返回可用资料库，继续使用本地快照");
              return;
            }
            return prepareInitialLibraryArtwork(nextLibrary, restoredTrack).then((preparedNextLibrary) => {
              if (startupRequestRef.current !== startupRequestId) return;
              const sameScope = preparedNextLibrary.serverId === preparedCachedLibrary.serverId
                && preparedNextLibrary.sectionKey === preparedCachedLibrary.sectionKey;
              const refreshedLibrary = sameScope
                ? {
                  ...preparedNextLibrary,
                  playlists: preparedNextLibrary.playlistsComplete === false
                    ? preparedCachedLibrary.playlists
                    : preparedNextLibrary.playlists,
                  playlistsComplete: preparedNextLibrary.playlistsComplete !== false
                    || preparedCachedLibrary.playlistsComplete !== false,
                  libraryArtists: preparedNextLibrary.libraryArtistsComplete === false
                    ? preparedCachedLibrary.libraryArtists
                    : preparedNextLibrary.libraryArtists,
                  libraryArtistsComplete: preparedNextLibrary.libraryArtistsComplete !== false
                    || preparedCachedLibrary.libraryArtistsComplete !== false,
                  home: preparedNextLibrary.homeComplete === false ? preparedCachedLibrary.home : preparedNextLibrary.home,
                  homeComplete: preparedNextLibrary.homeComplete !== false || preparedCachedLibrary.homeComplete !== false,
                }
                : preparedNextLibrary;
              void writeInitialLibraryCache(refreshedLibrary);
              startTransition(() => setInitialLibrary(refreshedLibrary));
              setStartupStage("资料库已更新");
            });
          }).catch((reason) => {
            if (startupRequestRef.current !== startupRequestId) return;
            console.warn("[资料库] 后台刷新失败，继续使用本地快照", reason);
          });
        });
      } else {
        if (cachedLibrary) {
          console.warn("[资料库] 忽略无服务器的空缓存快照");
          void clearInitialLibraryCache();
        }
        const nextLibrary = await withStartupTimeout(
          () => loadInitialLibraryData(restoredSession?.serverId),
          12_000,
          "连接音乐资料库超时，请确认 Plex Media Server 在线后重试。",
        );
        if (!hasUsableInitialLibrary(nextLibrary)) {
          throw new Error("当前账号没有可访问的 Plex 音乐资料库。");
        }
        setStartupStage("正在准备首页、封面与播放器");
        const [preparedLibrary, account] = await Promise.all([
          prepareInitialLibraryArtwork(nextLibrary, restoredTrack),
          refreshedAccount,
          loadHomeRouteModule(),
          nativeAudioReady,
        ]);
        if (startupRequestRef.current !== startupRequestId) return;
        if (account && accountRequestId === accountRefreshRequestRef.current) {
          setSession({ ...nextSession, account });
        }
        startTransition(() => setInitialLibrary(preparedLibrary));
        void writeInitialLibraryCache(preparedLibrary);
      }
    } catch (reason) {
      const nextError = reason instanceof Error ? reason : new Error(String(reason));
      setError(nextError.message);
      throw nextError;
    }
  }, []);
  const retryLoad = useCallback(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!uiPreview) retryLoad();
  }, [retryLoad, uiPreview]);

  useEffect(() => {
    const readyToRevealNativeUi = Boolean(
      session && (!session.authenticated || initialLibrary || error),
    );
    if (!readyToRevealNativeUi || nativeUiReadyStateRef.current !== "idle") return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        nativeUiReadyStateRef.current = "pending";
        void markMainUiReady().then(
          () => { nativeUiReadyStateRef.current = "done"; },
          () => { nativeUiReadyStateRef.current = "idle"; },
        );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [error, initialLibrary, session]);

  useLayoutEffect(() => {
    // `syncBrandPreset` changes identity when the user chooses a new preset.
    // Do not let that render replay the original bootstrap value and undo the
    // just-persisted manual choice; each session response is authoritative once.
    if (session === syncedBrandSessionRef.current) return;
    syncedBrandSessionRef.current = session;
    if (session?.brandPreset) syncBrandPreset(session.brandPreset);
  }, [session, syncBrandPreset]);

  const withNotifications = (content: ReactNode) => (
    <>
      {content}
      <GlobalNotificationQueue notices={notifications.notices} onDismiss={notifications.dismiss} />
    </>
  );

  if (uiPreview === "splash") return withNotifications(<AppFrame fullBleed brandPreset={brandPreset}><SplashScreen brandPreset={brandPreset} /></AppFrame>);
  if (uiPreview === "login") {
    return withNotifications(<AppFrame fullBleed brandPreset={brandPreset}><LoginScreen brandPreset={brandPreset} clientIdentifier="cadilume-development-preview" onAuthenticated={() => undefined} /></AppFrame>);
  }
  if (uiPreview === "notifications") return withNotifications(<AppFrame brandPreset={brandPreset}><NotificationFixture /></AppFrame>);
  if (!session && !error) return withNotifications(<AppFrame fullBleed brandPreset={brandPreset}><SplashScreen brandPreset={brandPreset} stage={startupStage} /></AppFrame>);
  if (!session) return withNotifications(<AppFrame brandPreset={brandPreset}><FatalError brandPreset={brandPreset} message={error || "无法启动 Cadilume"} retry={retryLoad} /></AppFrame>);
  if (session.credentialStatus === "unavailable") {
    return withNotifications(<AppFrame brandPreset={brandPreset}><FatalError brandPreset={brandPreset} message="无法读取应用数据中的 Plex 登录文件，请检查应用数据目录权限后重试。" retry={retryLoad} /></AppFrame>);
  }
  if (!session.authenticated) {
    return withNotifications(<AppFrame fullBleed brandPreset={brandPreset}><LoginScreen brandPreset={brandPreset} clientIdentifier={session.clientIdentifier} onAuthenticated={load} /></AppFrame>);
  }
  if (error) return withNotifications(<AppFrame brandPreset={brandPreset}><FatalError brandPreset={brandPreset} message={error} retry={retryLoad} /></AppFrame>);
  if (!initialLibrary) return withNotifications(<AppFrame fullBleed brandPreset={brandPreset}><SplashScreen brandPreset={brandPreset} stage={startupStage} /></AppFrame>);
  return withNotifications(<AppFrame integrated brandPreset={brandPreset}><MusicShell initialSession={session} initialLibrary={initialLibrary} themeMode={themeMode} resolvedTheme={resolvedTheme} brandPreset={brandPreset} onThemeMode={onThemeMode} onBrandPreset={onBrandPreset} appUpdater={appUpdater} notify={notifications.notify} /></AppFrame>);
}

function AppFrame({ children, integrated = false, fullBleed = false, brandPreset = "amber" }: {
  children: ReactNode;
  integrated?: boolean;
  fullBleed?: boolean;
  brandPreset?: BrandPreset;
}) {
  const isWindows = detectOutputPlatform(navigator) === "windows";
  const showTitlebar = !integrated && !fullBleed;
  return (
    <div
      className={`app-frame ${integrated ? "is-integrated" : ""} ${fullBleed ? "is-full-bleed" : ""}`.trim()}
      data-platform={isWindows ? "windows" : detectOutputPlatform(navigator)}
    >
      {showTitlebar
        ? <AppTitlebar brandPreset={brandPreset} />
        : fullBleed && (
          <>
            <div className="app-frame__full-bleed-drag-region" data-tauri-drag-region aria-hidden="true" />
            {isWindows && <WindowsWindowControls className="app-frame__full-bleed-window-controls" />}
          </>
        )}
      <div className="app-frame-content">{children}</div>
      <TooltipLayer />
    </div>
  );
}

const NOTIFICATION_FIXTURE_MESSAGES = [
  "资料库同步完成。",
  "已切换为琥珀金。",
  "播放队列已更新。",
  "封面缓存已在后台整理。",
  "歌词已同步。",
  "输出设备已切换。",
];

function NotificationFixture() {
  const queue = useGlobalNotificationQueue();
  const previewParams = new URLSearchParams(window.location.search);
  const requestedTheme = previewParams.get("notification-theme");
  const requestedBrand = previewParams.get("notification-brand");
  const previewTheme = requestedTheme === "light" || requestedTheme === "dark" ? requestedTheme : undefined;
  const previewBrand = requestedBrand === "amber" || requestedBrand === "verdant" || requestedBrand === "azure"
    ? requestedBrand
    : undefined;

  useEffect(() => {
    if (!previewTheme && !previewBrand) return;
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");
    const previousBrand = root.getAttribute("data-brand");
    if (previewTheme) root.dataset.theme = previewTheme;
    if (previewBrand) root.dataset.brand = previewBrand;
    return () => {
      if (previousTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previousTheme);
      if (previousBrand === null) root.removeAttribute("data-brand");
      else root.setAttribute("data-brand", previousBrand);
    };
  }, [previewBrand, previewTheme]);

  const addMessages = (count: number) => {
    for (const message of NOTIFICATION_FIXTURE_MESSAGES.slice(0, count)) queue.notify(message, "error");
  };

  return (
    <main className="notification-fixture" data-testid="notification-fixture">
      <div>
        <p>开发验收</p>
        <h1>通知队列</h1>
      </div>
      <div className="notification-fixture-actions">
        <button type="button" data-testid="notification-fixture-add-one" onClick={() => addMessages(1)}>加入 1 条</button>
        <button type="button" data-testid="notification-fixture-add-three" onClick={() => addMessages(3)}>加入 3 条</button>
        <button type="button" data-testid="notification-fixture-add-four" onClick={() => addMessages(4)}>加入 4 条</button>
        <button type="button" data-testid="notification-fixture-add-six" onClick={() => addMessages(6)}>加入 6 条</button>
        <button type="button" data-testid="notification-fixture-add-long" onClick={() => queue.notify("这是一条用于验证自动换行、固定宽度列表和关闭按钮可访问名称的较长通知文案。")}>加入长文案</button>
        <button type="button" data-testid="notification-fixture-clear" onClick={queue.clear}>清空</button>
      </div>
      <GlobalNotificationQueue notices={queue.notices} onDismiss={queue.dismiss} />
    </main>
  );
}

function AppTitlebar({ children, inactive = false, brandPreset = "amber" }: { children?: ReactNode; inactive?: boolean; brandPreset?: BrandPreset }) {
  const isWindows = detectOutputPlatform(navigator) === "windows";
  return (
    <header
      className={`app-titlebar ${children || isWindows ? "has-toolbar" : "is-standalone"}`}
      aria-label="Cadilume 顶部工具栏"
      aria-hidden={inactive || undefined}
      inert={inactive || undefined}
    >
      <div className="app-titlebar__drag-region" data-tauri-drag-region aria-hidden="true" />
      <div className="app-titlebar__content">
        <div className="app-titlebar__brand">
          <BrandIcon className="app-titlebar__brand-mark" preset={brandPreset} size={25} />
          <strong>Cadilume</strong>
        </div>
        {(children || isWindows) && (
          <div className="app-titlebar__toolbar">
            <div className="app-titlebar__toolbar-main">{children}</div>
            {isWindows && <WindowsWindowControls />}
          </div>
        )}
      </div>
    </header>
  );
}

function WindowsWindowControls({ className = "" }: { className?: string }) {
  const isWindows = detectOutputPlatform(navigator) === "windows";
  const appWindow = useMemo(() => isDesktopRuntime() ? getCurrentWindow() : undefined, []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const syncMaximized = () => {
      void appWindow.isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => undefined);
    };
    syncMaximized();
    void appWindow.onResized(syncMaximized).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  if (!isWindows || !appWindow) return null;

  const runWindowAction = (action: () => Promise<void>) => {
    void action().catch(() => undefined);
  };

  return (
    <div className={`app-titlebar__window-controls ${className}`.trim()} role="group" aria-label="窗口控制">
      <button type="button" className="window-control window-control--minimize" aria-label="最小化" title="最小化" onClick={() => runWindowAction(() => appWindow.minimize())}>
        <Minus size={18} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="window-control window-control--maximize"
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onClick={() => runWindowAction(async () => {
          await appWindow.toggleMaximize();
          setMaximized(await appWindow.isMaximized());
        })}
      >
        {maximized ? <Copy size={18} strokeWidth={1.8} /> : <Square size={18} strokeWidth={1.8} />}
      </button>
      <button type="button" className="window-control window-control--close" aria-label="关闭" title="关闭" onClick={() => runWindowAction(() => appWindow.close())}>
        <X size={18} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function MusicShell({ initialSession, initialLibrary, themeMode, resolvedTheme, brandPreset, onThemeMode, onBrandPreset, appUpdater, notify }: {
  initialSession: BootstrapResponse;
  initialLibrary: InitialLibraryData;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  brandPreset: BrandPreset;
  onThemeMode: ThemeModeChange;
  onBrandPreset: BrandPresetChange;
  appUpdater: AppUpdaterController;
  notify: (message: string, level?: GlobalNotificationLevel) => void;
}) {
  const account = initialSession.account || BOOTSTRAP_ACCOUNT_PLACEHOLDER;
  const [initialPlaybackSession] = useState(() => readPersistedPlaybackSession());
  const [servers, setServers] = useState<PlexServer[]>(initialLibrary.servers);
  const [serverId, setServerId] = useState<string | undefined>(initialLibrary.serverId);
  const [sections, setSections] = useState<LibrarySection[]>(initialLibrary.sections);
  const [sectionKey, setSectionKey] = useState<string | undefined>(initialLibrary.sectionKey);
  const [libraryArtists, setLibraryArtists] = useState<PlexItem[]>(initialLibrary.libraryArtists);
  const [, setLoading] = useState(true);
  const [sidePanel, setSidePanel] = useState<"queue" | "lyrics" | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMode, setNowPlayingMode] = useState<NowPlayingMode>(readNowPlayingMode);
  const [playlistSelection, setPlaylistSelection] = useState<PlaylistSelection>();
  const [playlistCreationOpen, setPlaylistCreationOpen] = useState(false);
  const [deviceNameDialogOpen, setDeviceNameDialogOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>(initialLibrary.playlists);
  const [playlistListLoading, setPlaylistListLoading] = useState(false);
  const [playlistListError, setPlaylistListError] = useState<string>();
  const [statusIconEnabled, setStatusIconEnabled] = useState(initialSession.statusIconEnabled);
  const [statusIconSaving, setStatusIconSaving] = useState(false);
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>(initialSession.closeBehavior);
  const [deviceName, setDeviceName] = useState(initialSession.deviceName);
  const [quality, setQuality] = useState<StreamQuality>(readStoredQuality);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>();
  const [nativeCacheStatus, setNativeCacheStatus] = useState<NativeAudioCacheStatus>();
  const [cacheStatusError, setCacheStatusError] = useState<string>();
  const [artworkCacheBusy, setArtworkCacheBusy] = useState(false);
  const [audioCacheBusy, setAudioCacheBusy] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [initialServerSnapshotInvalidated, setInitialServerSnapshotInvalidated] = useState(false);
  const [initialSectionSnapshotInvalidated, setInitialSectionSnapshotInvalidated] = useState(false);
  const routeAliveRef = useKeepAliveRef();
  const [routeCacheEpoch, setRouteCacheEpoch] = useState(0);
  const [sourcesSyncing, setSourcesSyncing] = useState(false);
  const [playlistMutationRevision, setPlaylistMutationRevision] = useState(0);
  const bumpPlaylistMutation = useCallback(() => {
    setPlaylistMutationRevision((revision) => revision + 1);
  }, []);
  const [connectionAvailable, setConnectionAvailable] = useState(Boolean(initialLibrary.serverId));
  const [playbackSettingsRequest, setPlaybackSettingsRequest] = useState(0);
  const [playbackFailurePreview, setPlaybackFailurePreview] = useState<PlaybackFailure>();
  const nowPlayingTriggerRef = useRef<HTMLButtonElement>(null);
  const playlistListRequestRef = useRef(0);
  const artistDirectoryRequestRef = useRef(0);
  const cacheStatusRequestRef = useRef(0);
  const appliedInitialLibraryRef = useRef(initialLibrary);
  const previousRouteCacheContextRef = useRef<{ serverId: string; sectionKey: string } | undefined>(undefined);
  const deferredQueueOpenTimerRef = useRef<number | undefined>(undefined);
  const preferredPlaybackServerId = initialPlaybackSession?.serverId;
  const player = usePlayer(serverId, quality);

  useEffect(() => {
    if (!isDesktopRuntime() || !serverId || !player.queue.length) return;
    let cancelled = false;
    void prewarmArtwork(serverId, player.queue, STARTUP_ARTWORK_CONCURRENCY, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [player.queue, serverId]);

  const outputDevices = useOutputDevices(player.setOutputSinkId, player.outputSinkId);
  const lyrics = useLyrics(serverId, player.current, player.progress, player.duration);
  const previewLyricsCountParam = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("now-playing-preview-lines")
    : null;
  const previewLyricsModeParam = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("now-playing-preview-lyrics")
    : null;
  const previewLyricsMode = ["timed", "plain", "none", "loading", "error"].includes(previewLyricsModeParam || "")
    ? previewLyricsModeParam as "timed" | "plain" | "none" | "loading" | "error"
    : null;
  const parsedPreviewLyricsCount = previewLyricsCountParam === null
    ? null
    : Number.parseInt(previewLyricsCountParam, 10);
  const previewLyricsCount = parsedPreviewLyricsCount === null || !Number.isFinite(parsedPreviewLyricsCount)
    ? null
    : Math.min(120, Math.max(0, parsedPreviewLyricsCount));
  const previewLineCount = previewLyricsCount ?? 24;
  const previewLyricsEnabled = previewLyricsMode !== null || previewLyricsCount !== null;
  const previewTimedLyrics = previewLyricsMode !== "plain";
  const nowPlayingLyrics = !previewLyricsEnabled ? lyrics : {
    document: previewLyricsMode === "none" || previewLyricsMode === "loading" || previewLyricsMode === "error" ? undefined : {
      format: "plain" as const,
      timed: previewTimedLyrics,
      offsetMs: 0,
      lines: Array.from({ length: previewLineCount }, (_, index) => ({
        id: `layout-preview-${index}`,
        startMs: previewTimedLyrics ? index * 2_000 : null,
        endMs: previewTimedLyrics ? (index + 1) * 2_000 : null,
        texts: [`布局预览歌词第 ${index + 1} 行${index % 4 === 0 ? "，用于验证长文本与独立滚动" : ""}`],
      })),
    },
    loading: previewLyricsMode === "loading",
    error: previewLyricsMode === "error" ? "歌词预览加载失败" : undefined,
    activeIndex: previewTimedLyrics && previewLineCount > 0
      ? Math.min(previewLineCount - 1, Math.max(0, Math.floor(player.progress / 2)))
      : -1,
  };
  const hasCurrentTrack = Boolean(player.current);
  const hasQueue = hasCurrentTrack && player.queue.length > 0;
  const queueNavigation = queueNavigationAvailability(
    player.currentIndex,
    player.queue.length,
    player.repeat,
    player.shuffle,
  );
  const hasLyrics = hasDisplayableLyrics(nowPlayingLyrics.document);
  const lyricsUnavailable = hasCurrentTrack
    && !nowPlayingLyrics.loading
    && !nowPlayingLyrics.error
    && !hasLyrics;
  const canToggleLyrics = hasCurrentTrack && !lyricsUnavailable;
  const expandedPlayerOpen = nowPlayingOpen && hasCurrentTrack;
  const queuePanelOpen = sidePanel === "queue" && hasQueue;
  const lyricsPanelOpen = sidePanel === "lyrics" && canToggleLyrics;
  const queuePanelMounted = usePanelPresence(queuePanelOpen);
  const lyricsPanelMounted = usePanelPresence(lyricsPanelOpen);
  const previewPlaybackFailure = import.meta.env.DEV
    && new URLSearchParams(window.location.search).has("playback-error-preview");
  const previewPlaybackLoading = import.meta.env.DEV
    && new URLSearchParams(window.location.search).has("playback-loading-preview");
  const playbackLoading = player.loading || previewPlaybackLoading;
  const activePlaybackFailure = player.playbackFailure ?? playbackFailurePreview;

  const selectedServer = servers.find((server) => server.id === serverId);
  const selectedSection = sections.find((section) => section.key === sectionKey);
  const initialServerSnapshotActive = isInitialLibrarySnapshotScopeActive(
    initialServerSnapshotInvalidated,
    sourceRevision,
    serverId,
    initialLibrary.serverId,
  );
  const initialSectionSnapshotActive = initialServerSnapshotActive
    && isInitialLibrarySnapshotScopeActive(
      initialSectionSnapshotInvalidated,
      sourceRevision,
      sectionKey,
      initialLibrary.sectionKey,
    );

  useEffect(() => {
    if (appliedInitialLibraryRef.current === initialLibrary) return;
    appliedInitialLibraryRef.current = initialLibrary;
    if (!hasUsableInitialLibrary(initialLibrary)) return;

    const nextServerId = initialLibrary.serverId;
    const nextSectionKey = initialLibrary.sectionKey;
    startTransition(() => {
      setServers(initialLibrary.servers);
      setSections(initialLibrary.sections);
      setServerId(nextServerId);
      setSectionKey(nextSectionKey);
      setConnectionAvailable(true);
      if (initialLibrary.libraryArtistsComplete !== false) {
        setLibraryArtists(initialLibrary.libraryArtists);
      }
      if (initialLibrary.playlistsComplete !== false) {
        setPlaylists(orderPlaylistsByRecency(initialLibrary.playlists));
      }
    });
  }, [initialLibrary]);

  useLayoutEffect(() => {
    const nextContext = serverId && sectionKey ? { serverId, sectionKey } : undefined;
    const previousContext = previousRouteCacheContextRef.current;
    const contextChanged = previousContext
      && (!nextContext || previousContext.serverId !== nextContext.serverId || previousContext.sectionKey !== nextContext.sectionKey);

    if (contextChanged) {
      void routeAliveRef.current?.destroyAll();
      setRouteCacheEpoch((epoch) => epoch + 1);
    }
    previousRouteCacheContextRef.current = nextContext;
  }, [routeAliveRef, sectionKey, serverId]);

  useEffect(() => {
    const shouldHydrateInitialArtists = initialLibrary.libraryArtistsComplete === false;
    if (initialSectionSnapshotActive && !shouldHydrateInitialArtists) return;
    const requestId = ++artistDirectoryRequestRef.current;
    if (!serverId || !sectionKey) {
      setLibraryArtists([]);
      return;
    }
    void getLibraryItems(serverId, sectionKey, 8)
      .then((result) => {
        if (artistDirectoryRequestRef.current === requestId) setLibraryArtists(result);
      })
      .catch(() => {
        if (artistDirectoryRequestRef.current === requestId) setLibraryArtists([]);
      });
    return () => {
      if (artistDirectoryRequestRef.current === requestId) artistDirectoryRequestRef.current += 1;
    };
  }, [initialLibrary.libraryArtistsComplete, initialSectionSnapshotActive, sectionKey, serverId]);

  useEffect(() => {
    if (!previewPlaybackFailure || !player.current) {
      setPlaybackFailurePreview(undefined);
      return;
    }
    setPlaybackFailurePreview({
      message: "音频无法播放。",
      technicalDetails: "MediaError code 4（格式或来源不受支持）；当前音源已经是 320 kbps。",
      attemptedQualities: ["auto", "320", "256", "192"],
    });
  }, [player.current?.ratingKey, previewPlaybackFailure]);

  useEffect(() => {
    if (!activePlaybackFailure) return;
    setPlaylistSelection(undefined);
  }, [activePlaybackFailure]);

  useEffect(() => {
    if (!queuePanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSidePanel((current) => current === "queue" ? null : current);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [queuePanelOpen]);

  useEffect(() => {
    if (player.current) return;
    setNowPlayingOpen(false);
    setPlaylistSelection(undefined);
    setSidePanel((value) => value === "queue" || value === "lyrics" ? null : value);
  }, [player.current]);

  useEffect(() => {
    if (!lyricsUnavailable) return;
    setSidePanel((value) => value === "lyrics" ? null : value);
  }, [lyricsUnavailable]);

  const changeNowPlayingMode = useCallback((mode: NowPlayingMode) => {
    setNowPlayingMode(mode);
    try {
      localStorage.setItem(NOW_PLAYING_MODE_STORAGE_KEY, mode);
    } catch {
      // The selected mode still applies for this session if storage is unavailable.
    }
  }, []);

  const loadServers = useCallback(async (refreshDependents = true): Promise<PlexServer[] | undefined> => {
    setLoading(true);
    try {
      const result = await discoverServers();
      startTransition(() => {
        setServers(result);
        setConnectionAvailable(result.length > 0);
        setServerId((current) => {
          if (result.some((server) => server.id === current)) return current;
          if (result.some((server) => server.id === preferredPlaybackServerId)) return preferredPlaybackServerId;
          return result[0]?.id;
        });
        if (refreshDependents) setSourceRevision((revision) => revision + 1);
      });
      if (!result.length) notify("当前账号没有发现可访问的 Plex Media Server。请先让服务器所有者共享音乐库。", "warning");
      return result;
    } catch (reason) {
      setConnectionAvailable(false);
      notify(reason instanceof Error ? reason.message : String(reason), "error");
      return undefined;
    } finally {
      setLoading(false);
    }
  }, [notify, preferredPlaybackServerId]);

  useEffect(() => {
    if (initialServerSnapshotActive && initialLibrary.servers.length > 0) return;
    if (!serverId) {
      if (sourceRevision === 0) void loadServers();
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getSections(serverId)
      .then((result) => {
        if (cancelled) return;
        setConnectionAvailable(true);
        setSections(result);
        setSectionKey((current) => result.some((section) => section.key === current) ? current : result[0]?.key);
        if (!result.length) notify("这台服务器没有向当前账号开放音乐资料库。", "warning");
      })
      .catch((reason) => {
        if (cancelled) return;
        setConnectionAvailable(false);
        notify(String(reason), "error");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [initialLibrary.servers.length, initialServerSnapshotActive, loadServers, notify, serverId, sourceRevision]);

  const loadPlaylistList = useCallback(async (announce = false) => {
    const requestId = ++playlistListRequestRef.current;
    if (!serverId) {
      setPlaylists([]);
      setPlaylistListError(undefined);
      setPlaylistListLoading(false);
      if (announce) notify("请先在设置中选择音乐服务器。");
      return;
    }
    setPlaylistListLoading(true);
    setPlaylistListError(undefined);
    try {
      const result = await getPlaylists(serverId);
      if (playlistListRequestRef.current === requestId) {
        startTransition(() => setPlaylists(orderPlaylistsByRecency(result)));
        if (announce) notify(result.length ? `歌单已刷新，共 ${result.length} 个。` : "歌单已刷新，当前没有可显示的音乐歌单。", "success");
      }
    } catch (reason) {
      if (playlistListRequestRef.current === requestId) {
        const message = playlistReadErrorMessage(reason);
        startTransition(() => {
          setPlaylists([]);
          setPlaylistListError(message);
        });
        if (announce) notify(message, "error");
      }
    } finally {
      if (playlistListRequestRef.current === requestId) setPlaylistListLoading(false);
    }
  }, [notify, serverId]);

  const updatePlaylistCallback = useCallback(async (playlist: PlexPlaylist, changes: PlaylistChanges) => {
    if (!serverId) {
      const message = "请先在设置中选择音乐服务器。";
      notify(message, "warning");
      throw new Error(message);
    }
    try {
      await updatePlaylist(serverId, playlist.ratingKey, changes);
      notify(`歌单“${playlist.title}”已更新。`, "success");
      void loadPlaylistList();
      bumpPlaylistMutation();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), "error");
      throw reason;
    }
  }, [bumpPlaylistMutation, loadPlaylistList, notify, serverId]);

  const deletePlaylistCallback = useCallback(async (playlist: PlexPlaylist) => {
    if (!serverId) {
      const message = "请先在设置中选择音乐服务器。";
      notify(message, "warning");
      throw new Error(message);
    }
    try {
      await deletePlaylist(serverId, playlist.ratingKey);
      notify(`已删除歌单“${playlist.title}”。`, "success");
      void loadPlaylistList();
      bumpPlaylistMutation();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), "error");
      // Keep the confirmation dialog open so a transient PMS/ACL failure is
      // not mistaken for a successful deletion.
      throw reason;
    }
  }, [bumpPlaylistMutation, loadPlaylistList, notify, serverId]);

  useEffect(() => {
    if (initialServerSnapshotActive && initialLibrary.playlistsComplete !== false) return;
    void loadPlaylistList();
  }, [initialLibrary.playlistsComplete, initialServerSnapshotActive, loadPlaylistList]);

  const syncSources = useCallback(async () => {
    setSourcesSyncing(true);
    const startedAt = performance.now();
    try {
      const refreshedServers = await loadServers(false);
      if (!refreshedServers?.length) return;

      const refreshedServer = refreshedServers.find((server) => server.id === serverId)
        || refreshedServers.find((server) => server.id === preferredPlaybackServerId)
        || refreshedServers[0];
      setLoading(true);
      setPlaylistListLoading(true);
      setPlaylistListError(undefined);

      const [refreshedSections, refreshedPlaylists] = await Promise.all([
        getSections(refreshedServer.id),
        getPlaylists(refreshedServer.id),
      ]);
      const refreshedSection = refreshedSections.find((section) => section.key === sectionKey)
        || refreshedSections[0];
      const refreshedArtists = refreshedSection
        ? await getLibraryItems(refreshedServer.id, refreshedSection.key, 8).catch(() => [])
        : [];
      const refreshedPlaylistSnapshot = orderPlaylistsByRecency(refreshedPlaylists);
      if (refreshedSection) {
        const sameCachedHomeScope = initialLibrary.serverId === refreshedServer.id
          && initialLibrary.sectionKey === refreshedSection.key;
        void writeInitialLibraryCache({
          ...initialLibrary,
          servers: refreshedServers,
          serverId: refreshedServer.id,
          sections: refreshedSections,
          sectionKey: refreshedSection.key,
          playlists: refreshedPlaylistSnapshot,
          playlistsComplete: true,
          libraryArtists: refreshedArtists,
          libraryArtistsComplete: true,
          home: sameCachedHomeScope
            ? initialLibrary.home
            : { recentAlbums: [], hubs: [] },
          homeComplete: sameCachedHomeScope && initialLibrary.homeComplete !== false,
        });
      }

      startTransition(() => {
        setConnectionAvailable(true);
        setServers(refreshedServers);
        setServerId(refreshedServer.id);
        setSections(refreshedSections);
        setSectionKey(refreshedSection?.key);
        setPlaylists(refreshedPlaylistSnapshot);
        artistDirectoryRequestRef.current += 1;
        setLibraryArtists(refreshedArtists);
        setSourceRevision((revision) => revision + 1);
      });
    } catch (reason) {
      setConnectionAvailable(false);
      notify(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setLoading(false);
      setPlaylistListLoading(false);
      const remaining = SOURCE_SYNC_OVERLAY_MINIMUM_MS - (performance.now() - startedAt);
      if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
      setSourcesSyncing(false);
    }
  }, [initialLibrary, loadServers, notify, sectionKey, serverId]);

  const refreshCacheStatus = useCallback(async () => {
    const requestId = ++cacheStatusRequestRef.current;
    setCacheStatusError(undefined);
    try {
      const [status, nativeStatus] = await Promise.all([
        getCacheStatus(),
        nativeAudioCacheStatus(),
      ]);
      if (cacheStatusRequestRef.current === requestId) {
        setCacheStatus(status);
        setNativeCacheStatus(nativeStatus);
      }
    } catch (reason) {
      if (cacheStatusRequestRef.current !== requestId) return;
      setCacheStatus(undefined);
      setCacheStatusError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const changeStatusIconEnabled = useCallback(async (enabled: boolean) => {
    if (statusIconSaving) return;
    const previous = statusIconEnabled;
    setStatusIconEnabled(enabled);
    setStatusIconSaving(true);
    try {
      setStatusIconEnabled(await saveStatusIconEnabled(enabled));
    } catch (reason) {
      setStatusIconEnabled(previous);
      notify(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setStatusIconSaving(false);
    }
  }, [notify, statusIconEnabled, statusIconSaving]);

  const changeCloseBehavior = useCallback(async (behavior: CloseBehavior) => {
    const previous = closeBehavior;
    setCloseBehavior(behavior);
    try {
      setCloseBehavior(await saveCloseBehavior(behavior));
    } catch (reason) {
      setCloseBehavior(previous);
      notify(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [closeBehavior, notify]);

  const changeDeviceName = useCallback(async (nextDeviceName: string) => {
    try {
      const savedDeviceName = await saveDeviceName(nextDeviceName);
      setDeviceName(savedDeviceName);
      return savedDeviceName;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "无法保存 Cadilume 设备名称。");
      throw reason;
    }
  }, [notify]);

  const changeQuality = useCallback((value: StreamQuality) => {
    setQuality(value);
    try {
      localStorage.setItem("cadilume-quality", value);
    } catch {
      // Keep the in-memory preference when storage is restricted.
    }
  }, []);

  const changeServerId = useCallback((value: string) => {
    if (value === serverId) return;
    setInitialServerSnapshotInvalidated(true);
    setInitialSectionSnapshotInvalidated(true);
    setServerId(value);
  }, [serverId]);

  const changeSectionKey = useCallback((value: string) => {
    if (value === sectionKey) return;
    setInitialSectionSnapshotInvalidated(true);
    setSectionKey(value);
  }, [sectionKey]);

  const clearArtworkDiskCache = useCallback(async () => {
    cacheStatusRequestRef.current += 1;
    setArtworkCacheBusy(true);
    setCacheStatusError(undefined);
    try {
      const status = await clearArtworkCache();
      setCacheStatus(status);
      clearArtworkTicketCache();
      notify("封面缓存已清理。", "success");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      notify(message, "error");
    } finally {
      setArtworkCacheBusy(false);
    }
  }, [notify]);

  const clearAudioDiskCache = useCallback(async () => {
    cacheStatusRequestRef.current += 1;
    setAudioCacheBusy(true);
    setCacheStatusError(undefined);
    try {
      await player.clearPlaybackAndCache();
      setNativeCacheStatus(await nativeAudioCacheStatus());
      notify("音频缓存已清理。", "success");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      notify(message, "error");
    } finally {
      setAudioCacheBusy(false);
    }
  }, [notify, player.clearPlaybackAndCache]);

  const signOut = useCallback(async () => {
    try {
      await logout();
      await clearInitialLibraryCache();
      await routeAliveRef.current?.destroyAll();
      player.discardPlaybackSession();
      clearArtworkTicketCache();
      window.location.reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [player.discardPlaybackSession, routeAliveRef]);

  const playRecommendationItem = useCallback(async (item: PlexItem, context: PlexItem[]) => {
    if (!serverId) return;
    try {
      let tracks: PlexItem[];
      if (item.type === "track") {
        tracks = context.filter((candidate) => candidate.type === "track");
      } else if (item.type === "artist") {
        tracks = (await getArtistTracksPage(serverId, item.ratingKey, 0, ARTIST_TRACK_PAGE_SIZE)).items;
      } else {
        tracks = (await getChildren(serverId, item.ratingKey)).filter((candidate) => candidate.type === "track");
      }
      const current = item.type === "track" ? item : tracks[0];
      if (!current || !tracks.length) {
        notify(`“${item.title}”当前没有可播放的歌曲。`, "warning");
        return;
      }
      player.playContext(current, tracks);
      player.setShuffle(false);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), "error");
      throw reason;
    }
  }, [notify, player.playContext, player.setShuffle, serverId]);

  const playRecommendationPlaylist = useCallback(async (playlist: PlexPlaylist) => {
    if (!serverId) return;
    try {
      const tracks = (await getPlaylistItems(serverId, playlist.ratingKey)).filter((item) => item.type === "track");
      if (!tracks[0]) {
        notify(`歌单“${playlist.title}”当前没有可播放的歌曲。`, "warning");
        return;
      }
      player.playContext(tracks[0], tracks);
      player.setShuffle(false);
    } catch (reason) {
      notify(playlistReadErrorMessage(reason), "error");
      throw reason;
    }
  }, [notify, player.playContext, player.setShuffle, serverId]);

  const closeNowPlaying = useCallback(() => {
    setNowPlayingOpen(false);
    window.requestAnimationFrame(() => {
      const trigger = nowPlayingTriggerRef.current;
      if (trigger && !trigger.disabled) trigger.focus();
    });
  }, []);

  const cancelDeferredQueueOpen = useCallback(() => {
    if (deferredQueueOpenTimerRef.current === undefined) return;
    window.clearTimeout(deferredQueueOpenTimerRef.current);
    deferredQueueOpenTimerRef.current = undefined;
  }, []);

  useEffect(() => () => cancelDeferredQueueOpen(), [cancelDeferredQueueOpen]);

  const toggleQueuePanel = useCallback(() => {
    if (!player.current || player.queue.length === 0) return;
    setPlaylistSelection(undefined);
    const queueWasWaitingToOpen = deferredQueueOpenTimerRef.current !== undefined;
    cancelDeferredQueueOpen();
    if (sidePanel === "queue" || queueWasWaitingToOpen) {
      setSidePanel(null);
      return;
    }
    if (lyricsPanelOpen) {
      // Let the lyrics surface finish its exit before mounting a potentially
      // large queue. This prevents two blurred, scrolling panels from animating
      // at once and makes the hand-off deterministic.
      setSidePanel(null);
      deferredQueueOpenTimerRef.current = window.setTimeout(() => {
        deferredQueueOpenTimerRef.current = undefined;
        setSidePanel("queue");
      }, panelMotionDuration());
      return;
    }
    setSidePanel("queue");
  }, [cancelDeferredQueueOpen, lyricsPanelOpen, player.current, player.queue.length, sidePanel]);

  const toggleLyricsPanel = useCallback(() => {
    if (!canToggleLyrics) return;
    cancelDeferredQueueOpen();
    setPlaylistSelection(undefined);
    setSidePanel((value) => value === "lyrics" ? null : "lyrics");
  }, [canToggleLyrics, cancelDeferredQueueOpen]);

  const closeQueuePanel = useCallback(() => {
    cancelDeferredQueueOpen();
    setSidePanel((current) => current === "queue" ? null : current);
  }, [cancelDeferredQueueOpen]);

  const openPlaylistPicker = useCallback((tracks: readonly PlexItem[], label?: string) => {
    const uniqueTracks = appendUniqueArtistTracks([], tracks.filter((track) => track.type === "track"));
    if (!uniqueTracks.length) {
      notify("当前没有可添加到歌单的歌曲。");
      return;
    }
    cancelDeferredQueueOpen();
    setSidePanel(null);
    setPlaylistSelection({
      tracks: uniqueTracks,
      label: label || (uniqueTracks.length === 1
        ? `《${uniqueTracks[0].title}》 · ${trackArtist(uniqueTracks[0])}`
        : `已选择 ${uniqueTracks.length} 首歌曲`),
    });
  }, [cancelDeferredQueueOpen, notify]);

  const openCurrentTrackPlaylistPicker = useCallback(() => {
    if (!player.current) return;
    openPlaylistPicker([player.current]);
  }, [openPlaylistPicker, player.current]);

  const playQueuedTrack = useCallback((track: PlexItem) => {
    player.playContext(track, player.queue);
  }, [player.playContext, player.queue]);

  const removeQueuedTrack = useCallback((index: number) => {
    player.removeFromQueue(index);
  }, [player.removeFromQueue]);

  const clearPlaybackQueue = useCallback(async () => {
    try {
      await player.clearQueue();
      notify("播放队列已清空。", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [notify, player.clearQueue]);

  const dismissPlaybackFailure = useCallback(() => {
    setPlaybackFailurePreview(undefined);
    player.dismissPlaybackFailure();
  }, [player.dismissPlaybackFailure]);

  const retryPlayback = useCallback(() => {
    setPlaybackFailurePreview(undefined);
    player.retryCurrent();
  }, [player.retryCurrent]);

  const router = useMemo(() => createCadilumeRouter(), []);

  const openPlaybackSettings = useCallback(() => {
    dismissPlaybackFailure();
    setNowPlayingOpen(false);
    setPlaylistSelection(undefined);
    setSidePanel(null);
    setPlaybackSettingsRequest((request) => request + 1);
    const location = router.state.location;
    router.navigate("/settings", {
      state: createCadilumeEntryState(location.state, {
        parentEntryId: routeEntryId(location),
        route: { view: "settings" },
      }),
    });
  }, [dismissPlaybackFailure, router]);

  const changeBrandPreset = useCallback<BrandPresetChange>(async (preset, origin) => {
    if (preset === brandPreset) return;
    try {
      await onBrandPreset(preset, origin);
      const label = BRAND_PRESET_OPTIONS.find((option) => option.preset === preset)?.label || "所选配色";
      notify(`已切换为${label}。`);
    } catch {
      notify("无法保存视觉风格，已保留当前配色。");
    }
  }, [brandPreset, notify, onBrandPreset]);

  const playerActions = useMemo<MusicPlayerActions>(() => ({
    playContext: player.playContext,
    playTracks: player.playTracks,
    appendTracks: player.appendTracks,
    insertTracksNext: player.insertTracksNext,
    setShuffle: player.setShuffle,
    setPrebufferNext: player.setPrebufferNext,
  }), [player.appendTracks, player.insertTracksNext, player.playContext, player.playTracks, player.setPrebufferNext, player.setShuffle]);
  const playerState = useMemo<MusicPlayerState>(() => ({
    current: player.current,
    playing: player.playing,
  }), [player.current, player.playing]);

  const openDeviceNameDialog = useCallback(() => setDeviceNameDialogOpen(true), []);
  const openPlaylistCreation = useCallback(() => {
    if (!serverId) {
      notify("请先在设置中选择音乐服务器。");
      return;
    }
    setSidePanel(null);
    setPlaylistSelection(undefined);
    setPlaylistCreationOpen(true);
  }, [notify, serverId]);

  const runtime = useMemo<MusicShellRuntime>(() => ({
    initialSession,
    initialLibrary,
    account,
    themeMode,
    resolvedTheme,
    brandPreset,
    onThemeMode,
    onBrandPreset,
    servers,
    serverId,
    selectedServer,
    sections,
    sectionKey,
    selectedSection,
    libraryArtists,
    connectionAvailable,
    expandedPlayerOpen,
    playlists,
    playlistListLoading,
    playlistListError,
    loadPlaylistList,
    updatePlaylist: updatePlaylistCallback,
    deletePlaylist: deletePlaylistCallback,
    sourceRevision,
    initialSectionSnapshotActive,
    playlistMutationRevision,
    bumpPlaylistMutation,
    routeAliveRef,
    statusIconEnabled,
    statusIconPlatform: initialSession.statusIconPlatform,
    statusIconSaving,
    closeBehavior,
    appUpdater,
    deviceName,
    quality,
    prebufferNext: player.prebufferNext,
    cacheStatus,
    nativeCacheStatus,
    cacheStatusError,
    artworkCacheBusy,
    audioCacheBusy,
    sourcesSyncing,
    playbackSettingsRequest,
    outputDevices,
    notify,
    playRecommendationItem,
    playRecommendationPlaylist,
    changeStatusIconEnabled,
    changeCloseBehavior,
    changeBrandPreset,
    changeDeviceName,
    changeQuality,
    setServerId: changeServerId,
    setSectionKey: changeSectionKey,
    setPrebufferNext: player.setPrebufferNext,
    clearArtworkDiskCache,
    clearAudioDiskCache,
    syncSources,
    signOut,
    refreshCacheStatus,
    openDeviceNameDialog,
    openPlaylistCreation,
    openPlaylistPicker,
    setSidePanel,
    setNowPlayingOpen,
    setPlaybackSettingsRequest,
  }), [account, appUpdater, brandPreset, cacheStatus, cacheStatusError, changeBrandPreset, changeCloseBehavior, changeDeviceName, changeQuality, changeServerId, changeSectionKey, clearArtworkDiskCache, clearAudioDiskCache, closeBehavior, connectionAvailable, deletePlaylistCallback, deviceName, initialLibrary, initialSession, initialSectionSnapshotActive, loadPlaylistList, libraryArtists, nativeCacheStatus, notify, onBrandPreset, onThemeMode, openDeviceNameDialog, openPlaylistCreation, openPlaylistPicker, outputDevices, playbackSettingsRequest, playRecommendationItem, playRecommendationPlaylist, playlists, playlistListError, playlistListLoading, playlistMutationRevision, player.prebufferNext, player.setPrebufferNext, quality, refreshCacheStatus, routeAliveRef, sectionKey, selectedSection, selectedServer, serverId, setSidePanel, setNowPlayingOpen, setPlaybackSettingsRequest, signOut, sourcesSyncing, statusIconEnabled, statusIconSaving, syncSources, themeMode, updatePlaylistCallback, resolvedTheme, sourceRevision, bumpPlaylistMutation]);

  const libraryContent = useMemo(() => (
    <MusicShellContext.Provider value={runtime}>
      <MusicPlayerActionsContext.Provider value={playerActions}>
        <MusicPlayerStateContext.Provider value={playerState}>
          <Suspense fallback={<RouteChunkFallback />}>
            <RouterProvider key={`route-cache-${routeCacheEpoch}`} router={router} />
          </Suspense>
        </MusicPlayerStateContext.Provider>
      </MusicPlayerActionsContext.Provider>
    </MusicShellContext.Provider>
  ), [playerActions, playerState, routeCacheEpoch, router, runtime]);

  return (
    <ArtworkServerContext.Provider value={serverId}>
      <div
        className="app-shell"
        data-playback-active={player.playing || playbackLoading || player.buffering ? "true" : undefined}
      >
        {libraryContent}

      {queuePanelMounted && (
        <div className={`queue-panel-layer ${queuePanelOpen ? "is-open" : "is-closing"}`} aria-hidden={!queuePanelOpen || undefined}>
          <button className="queue-panel-scrim" type="button" aria-label="点击空白处关闭播放队列" onClick={closeQueuePanel} />
          <QueuePanel
            open={queuePanelOpen}
            queue={player.queue}
            currentIndex={player.currentIndex}
            onSelect={playQueuedTrack}
            onRemove={removeQueuedTrack}
            onClear={clearPlaybackQueue}
          />
        </div>
      )}

      {lyricsPanelMounted && (
        <div className={`lyrics-panel-layer ${lyricsPanelOpen ? "is-open" : "is-closing"}`} aria-hidden={!lyricsPanelOpen || undefined}>
          <LyricsPanel
            open={lyricsPanelOpen}
            track={player.current}
            lyrics={nowPlayingLyrics}
            onSeek={player.seek}
          />
        </div>
      )}

      <NowPlayingView
        open={expandedPlayerOpen}
        mode={nowPlayingMode}
        onModeChange={changeNowPlayingMode}
        track={player.current}
        playing={player.playing}
        loading={playbackLoading}
        buffering={player.buffering}
        artwork={(
          <Artwork
            key={player.current?.ratingKey ?? player.current?.key ?? player.current?.title}
            item={player.current}
            size="immersive"
            canvasReadable
          />
        )}
        progressSeconds={player.progress}
        durationSeconds={player.duration}
        shuffle={player.shuffle}
        repeat={player.repeat}
        muted={player.muted}
        volume={player.volume}
        lyrics={nowPlayingLyrics}
        queueOpen={queuePanelOpen}
        queueAvailable={hasQueue}
        canPrevious={queueNavigation.canPrevious}
        canNext={queueNavigation.canNext}
        theme={themeMode}
        headerActions={(
          <>
            <div className="now-playing-header-status-actions" role="group" aria-label="外观与连接状态">
              <ConnectionIndicator server={selectedServer} connected={connectionAvailable} />
              <ThemeCycleButton resolvedTheme={resolvedTheme} onChange={onThemeMode} />
            </div>
            <WindowsWindowControls className="now-playing-window-controls" />
          </>
        )}
        onSeek={player.seek}
        onShuffleChange={player.setShuffle}
        onPrevious={player.previous}
        onTogglePlayback={player.toggle}
        onNext={player.next}
        onRepeatChange={player.setRepeat}
        onMutedChange={player.setMuted}
        onVolumeChange={player.setVolume}
        onToggleQueue={toggleQueuePanel}
        onClose={closeNowPlaying}
        escapeEnabled={!playlistSelection && !activePlaybackFailure && !queuePanelOpen && !lyricsPanelOpen}
        onAddToPlaylist={openCurrentTrackPlaylistPicker}
      />

      {activePlaybackFailure && (
        <PlaybackErrorAlert
          failure={activePlaybackFailure}
          trackTitle={player.current?.title}
          onRetry={retryPlayback}
          onOpenSettings={openPlaybackSettings}
          onClose={dismissPlaybackFailure}
        />
      )}

      {deviceNameDialogOpen && (
        <DeviceNameDialog
          deviceName={deviceName}
          onClose={() => setDeviceNameDialogOpen(false)}
          onSave={changeDeviceName}
        />
      )}

      {playlistSelection && serverId && (
        <PlaylistPicker
          serverId={serverId}
          tracks={playlistSelection.tracks}
          label={playlistSelection.label}
          onClose={() => setPlaylistSelection(undefined)}
          onNotify={notify}
          onPlaylistCreated={(playlist) => {
            setPlaylists((current) => [playlist, ...current.filter((item) => item.ratingKey !== playlist.ratingKey)]);
            void loadPlaylistList();
          }}
          onAdded={(playlist, result) => {
            setPlaylistSelection(undefined);
            notify(result.requested === 1
              ? `已将${playlistSelection.label}添加到“${playlist.title}”。`
              : `已将 ${result.requested} 首歌曲添加到“${playlist.title}”。`, "success");
            bumpPlaylistMutation();
            void loadPlaylistList();
          }}
        />
      )}

      {playlistCreationOpen && serverId && (
        <CreatePlaylistDialog
          serverId={serverId}
          sectionKey={sectionKey}
          onClose={() => setPlaylistCreationOpen(false)}
          onCreated={(playlist) => {
            setPlaylistCreationOpen(false);
            setPlaylists((current) => [playlist, ...current.filter((item) => item.ratingKey !== playlist.ratingKey)]);
            notify(`已创建歌单“${playlist.title}”。`, "success");
            void loadPlaylistList();
          }}
          onError={notify}
        />
      )}

      <PlayerBar
        player={player}
        loading={playbackLoading}
        buffering={player.buffering}
        nowPlayingTriggerRef={nowPlayingTriggerRef}
        expanded={expandedPlayerOpen}
        queueOpen={queuePanelOpen}
        lyricsOpen={lyricsPanelOpen}
        canOpenNowPlaying={hasCurrentTrack}
        canToggleQueue={hasQueue}
        canToggleLyrics={canToggleLyrics}
        onOpenNowPlaying={() => {
          if (!player.current) return;
          cancelDeferredQueueOpen();
          setSidePanel((value) => value === "lyrics" ? null : value);
          setPlaylistSelection(undefined);
          setNowPlayingOpen(true);
        }}
        onToggleQueue={toggleQueuePanel}
        onToggleLyrics={toggleLyricsPanel}
        onAddToPlaylist={openCurrentTrackPlaylistPicker}
      />

      {sourcesSyncing && <SourceSyncOverlay />}
      </div>
    </ArtworkServerContext.Provider>
  );
}

function RouteChunkFallback() {
  return (
    <div className="route-page-scroll route-chunk-fallback" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      <span>正在准备资料库页面…</span>
    </div>
  );
}

const loadHomeRouteModule = () => import("./HomeRoutePage");
const LazyRoutePage = lazy(() => import("./LibraryRoutePage"));
const LazyHomeRouteEntry = lazy(() => loadHomeRouteModule().then((module) => ({ default: module.HomeRouteEntry })));

function createCadilumeRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <MusicRouterLayout />,
      children: [
        { index: true, element: <LazyHomeRouteEntry /> },
        { path: "home", element: <LazyHomeRouteEntry /> },
        { path: "albums", element: <LazyRoutePage /> },
        { path: "albums/:ratingKey", element: <LazyRoutePage /> },
        { path: "artists", element: <LazyRoutePage /> },
        { path: "artists/:ratingKey", element: <LazyRoutePage /> },
        { path: "tracks", element: <LazyRoutePage /> },
        { path: "playlists/:ratingKey", element: <LazyRoutePage /> },
        { path: "search", element: <LazyRoutePage /> },
        { path: "settings", element: <LazyRoutePage /> },
        { path: "*", element: <Navigate to="/home" replace /> },
      ],
    },
  ]);
}

function useRouterRoute(): LibraryRoute {
  const location = useLocation();
  return useMemo(() => parseLibraryRoute(`${location.pathname}${location.search}`), [location.pathname, location.search]);
}

function sameLibraryRoute(left: LibraryRoute, right: LibraryRoute): boolean {
  if (left.view !== right.view || left.query !== right.query) return false;
  const leftTracks = left.tracks;
  const rightTracks = right.tracks;
  if (Boolean(leftTracks) !== Boolean(rightTracks)) return false;
  if (leftTracks && rightTracks) {
    if (
      leftTracks.page !== rightTracks.page
      || leftTracks.sort?.key !== rightTracks.sort?.key
      || leftTracks.sort?.direction !== rightTracks.sort?.direction
    ) return false;
  }
  const leftDetail = left.detail;
  const rightDetail = right.detail;
  if (Boolean(leftDetail) !== Boolean(rightDetail)) return false;
  if (leftDetail && rightDetail) {
    if (leftDetail.type !== rightDetail.type || leftDetail.ratingKey !== rightDetail.ratingKey) return false;
  }
  return true;
}

function useCadilumeNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentRoute = useMemo(
    () => parseLibraryRoute(`${location.pathname}${location.search}`),
    [location.pathname, location.search],
  );
  return useCallback((route: LibraryRoute, options: { replace?: boolean } = {}) => {
    // 重复进入同一路由时不创建新的 History entry，避免 KeepAlive 重建页面/刷新。
    if (sameLibraryRoute(currentRoute, route)) return;
    navigate(routePath(route), {
      replace: options.replace,
      state: createCadilumeEntryState(location.state, {
        parentEntryId: options.replace ? routeParentEntryId(location.state) : routeEntryId(location),
        route,
      }),
    });
  }, [currentRoute, location.key, location.state, navigate]);
}

function MusicRouterLayout() {
  const runtime = useMusicShellRuntime();
  const route = useRouterRoute();
  const navigateRoute = useCadilumeNavigate();
  const location = useLocation();
  const connectionPreviewParam = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("connection-preview")
    : null;
  const connectionPreview = ["local", "remote", "relay", "disconnected"].includes(connectionPreviewParam || "")
    ? connectionPreviewParam as ConnectionKind
    : undefined;

  const selectedPlaylistId = route.detail?.type === "playlist" ? route.detail.ratingKey : undefined;
  const activeView = selectedPlaylistId ? undefined : route.view;

  const openPlaylist = (playlist: PlexPlaylist) => {
    if (selectedPlaylistId === playlist.ratingKey) return;
    navigateRoute(libraryDetailRoute("playlist", playlist.ratingKey));
  };

  return (
    <>
      <AppTitlebar inactive={runtime.expandedPlayerOpen} brandPreset={runtime.brandPreset}>
        <LibrarySearchBox route={route} navigateRoute={navigateRoute} notify={runtime.notify} />
        <div className="topbar-actions">
          <div className="topbar-account" aria-label={`${runtime.account.title || runtime.account.username} 的 Plex 用户信息`}>
            <Avatar account={runtime.account} />
            <span><strong>{runtime.account.title || runtime.account.username}</strong></span>
          </div>
          <ConnectionIndicator server={runtime.selectedServer} connected={runtime.connectionAvailable} kindOverride={connectionPreview} />
          <IconButton label="设置" active={activeView === "settings"} onClick={() => navigateRoute({ view: "settings" })}><Settings size={18} /></IconButton>
          <IconButton label={runtime.sourcesSyncing ? "正在同步资料" : "刷新资料"} disabled={runtime.sourcesSyncing} onClick={() => void runtime.syncSources()}><RefreshCw className={runtime.sourcesSyncing ? "spin" : ""} size={17} /></IconButton>
          <ThemeCycleButton resolvedTheme={runtime.resolvedTheme} onChange={runtime.onThemeMode} />
        </div>
      </AppTitlebar>
      <a className="skip-link" href="#main-content" aria-hidden={runtime.expandedPlayerOpen || undefined} tabIndex={runtime.expandedPlayerOpen ? -1 : undefined}>跳到主要内容</a>
      <aside className="sidebar" aria-label="主导航" aria-hidden={runtime.expandedPlayerOpen || undefined} inert={runtime.expandedPlayerOpen || undefined}>
        <nav>
          <p className="nav-label">资料库</p>
          {navigation.map(({ id, label, icon: NavIcon }) => (
            <a
              className={`nav-item ${activeView === id ? "active" : ""}`}
              href={libraryRouteHash(id)}
              key={id}
              aria-current={activeView === id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (activeView === id) return;
                navigateRoute({ view: id });
              }}
            >
              <NavIcon size={18} strokeWidth={1.8} /><span>{label}</span>
            </a>
          ))}
        </nav>
        <PlaylistSidebar
          playlists={runtime.playlists}
          selectedId={selectedPlaylistId}
          loading={runtime.playlistListLoading}
          error={runtime.playlistListError}
          onOpen={openPlaylist}
          onRetry={() => void runtime.loadPlaylistList(true)}
          onCreate={runtime.openPlaylistCreation}
          onUpdatePlaylist={runtime.updatePlaylist}
          onDeletePlaylist={runtime.deletePlaylist}
        />
      </aside>
      <section className="workspace" aria-hidden={runtime.expandedPlayerOpen || undefined} inert={runtime.expandedPlayerOpen || undefined}>
        <main id="main-content" className="content" tabIndex={-1}>
          <RouteKeepAliveHost location={location} aliveRef={runtime.routeAliveRef} />
        </main>
      </section>
    </>
  );
}

/** Keep typing state outside MusicShell so each key cannot invalidate the player tree. */
function LibrarySearchBox({ route, navigateRoute, notify }: {
  route: LibraryRoute;
  navigateRoute: RouteNavigate;
  notify: MusicShellRuntime["notify"];
}) {
  const [draft, setDraft] = useState(() => route.view === "search" ? route.query || "" : "");

  useEffect(() => {
    if (route.view === "search") setDraft(route.query || "");
  }, [route.query, route.view]);

  const submitQuery = useCallback(() => {
    const query = draft.trim();
    if (!query) {
      notify("搜索内容不能为空", "warning");
      return;
    }
    navigateRoute({ view: "search", query }, { replace: route.view === "search" });
  }, [draft, navigateRoute, notify, route.view]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitQuery();
  };

  return (
    <form className="searchbox" onSubmit={submit} role="search">
      <Search size={17} />
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          submitQuery();
        }}
        placeholder="搜索歌曲、专辑或歌手"
        aria-label="搜索资料库"
      />
      {draft && (
        <button type="button" className="searchbox-clear" aria-label="清除搜索" onClick={() => setDraft("")}>
          <X size={15} />
        </button>
      )}
    </form>
  );
}

type RouteLocationSnapshot = Pick<ReturnType<typeof useLocation>, "key" | "pathname" | "search" | "state">;
type RouteNavigate = (route: LibraryRoute, options?: { replace?: boolean }) => void;

export interface RoutePageProps {
  route: LibraryRoute;
  entryLocation: RouteLocationSnapshot;
  onNavigate: RouteNavigate;
  onBack: () => void;
}

export function useRouteEntry(): RoutePageProps {
  const entry = useContext(RouteEntryContext);
  if (!entry) throw new Error("Cadilume 路由页缺少 History entry 上下文。");
  return entry;
}

function RouteKeepAliveHost({ location, aliveRef }: { location: ReturnType<typeof useLocation>; aliveRef: RefObject<KeepAliveRef | null> }) {
  const activeCacheKey = historyEntryCacheKey(location.key);
  const navigate = useNavigate();
  const outlet = useOutlet();
  const route = useMemo(() => parseLibraryRoute(`${location.pathname}${location.search}`), [location.pathname, location.search]);
  const lastSearchCacheKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (route.view !== "search") return;
    const previous = lastSearchCacheKeyRef.current;
    lastSearchCacheKeyRef.current = activeCacheKey;
    if (previous && previous !== activeCacheKey) {
      void aliveRef.current?.destroy(previous);
    }
  }, [activeCacheKey, aliveRef, route.view]);
  const entryLocation = useMemo<RouteLocationSnapshot>(() => ({
    key: location.key,
    pathname: location.pathname,
    search: location.search,
    state: location.state,
  }), [location.key, location.pathname, location.search, location.state]);
  const navigateFromEntry = useCallback<RouteNavigate>((nextRoute, options = {}) => {
    navigate(routePath(nextRoute), {
      replace: options.replace,
      state: createCadilumeEntryState(location.state, {
        parentEntryId: options.replace ? routeParentEntryId(location.state) : routeEntryId(location),
        route: nextRoute,
      }),
    });
  }, [location.key, location.state, navigate]);
  const backFromEntry = useCallback(() => navigate(-1), [navigate]);
  const entry = useMemo<RoutePageProps>(() => ({
    route,
    entryLocation,
    onNavigate: navigateFromEntry,
    onBack: backFromEntry,
  }), [backFromEntry, entryLocation, navigateFromEntry, route]);
  return (
    <div className="route-cache-host">
    <KeepAlive
      activeCacheKey={activeCacheKey}
      // Every History entry retains its own complete page instance until the
      // account/server/library context is explicitly reset.
      max={Infinity}
      maxAliveTime={0}
      transition={false}
      enableActivity={false}
      aliveRef={aliveRef}
      containerClassName="keep-alive-render"
      cacheNodeClassName="cadilume-route-cache"
    >
      <RouteEntryContext.Provider value={entry}>
        <KeepAliveRoutePage cacheKey={activeCacheKey}>{outlet}</KeepAliveRoutePage>
      </RouteEntryContext.Provider>
    </KeepAlive>
    </div>
  );
}

function KeepAliveRoutePage({ cacheKey, children }: { cacheKey: string; children: ReactNode }) {
  const { active } = useKeepAliveContext();
  const { route } = useRouteEntry();
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Array<{ target: HTMLElement; top: number; left: number }>>([]);
  const restoreFocusTargetRef = useRef<HTMLElement | null>(null);
  const restoreFocusFrameRef = useRef<number | undefined>(undefined);
  const [showBackToTop, setShowBackToTop] = useState(false);
  useLayoutEffect(() => {
    const page = pageRef.current;
    const cacheNode = page?.closest<HTMLElement>(".keepalive-cache-div");
    if (!page || !cacheNode) return;
    const focused = !active && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const restoreScrollPositions = () => {
      scrollPositionsRef.current.forEach(({ target, top, left }) => {
        if (!target.isConnected) return;
        target.scrollTop = Math.min(Math.max(0, top), Math.max(0, target.scrollHeight - target.clientHeight));
        target.scrollLeft = Math.min(Math.max(0, left), Math.max(0, target.scrollWidth - target.clientWidth));
      });
    };

    if (!active) {
      const scrollTargets = [page, ...Array.from(page.querySelectorAll<HTMLElement>("[data-route-scroll-container]"))];
      scrollPositionsRef.current = scrollTargets.map((target) => ({
        target,
        top: target.scrollTop,
        left: target.scrollLeft,
      }));
    }

    cacheNode.hidden = !active;
    cacheNode.toggleAttribute("inert", !active);
    if (active) cacheNode.removeAttribute("aria-hidden");
    else cacheNode.setAttribute("aria-hidden", "true");

    if (!active) {
      if (focused && pageRef.current?.contains(focused)) restoreFocusTargetRef.current = focused;
      return;
    }

    const restoreTarget = restoreFocusTargetRef.current;
    restoreScrollPositions();
    restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
      restoreScrollPositions();
      if (restoreTarget
        && restoreTarget.isConnected
        && pageRef.current?.contains(restoreTarget)
        && !restoreTarget.closest("[inert]")
        && !restoreTarget.matches(":disabled")) restoreTarget.focus({ preventScroll: true });
      restoreFocusFrameRef.current = undefined;
    });
    return () => {
      if (restoreFocusFrameRef.current !== undefined) {
        window.cancelAnimationFrame(restoreFocusFrameRef.current);
        restoreFocusFrameRef.current = undefined;
      }
    };
  }, [active]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || !active) {
      setShowBackToTop(false);
      return;
    }
    const syncBackToTop = () => setShowBackToTop(shouldShowRouteBackToTop(page.scrollTop, page.clientHeight));
    syncBackToTop();
    const frame = window.requestAnimationFrame(syncBackToTop);
    page.addEventListener("scroll", syncBackToTop, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      page.removeEventListener("scroll", syncBackToTop);
    };
  }, [active, cacheKey]);

  const scrollToRouteTop = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    page.scrollTo({ top: 0, behavior: routeScrollBehavior(reducedMotion) });
  }, []);

  return <>
    <div ref={pageRef} className={`route-page-scroll ${route.view === "tracks" ? "is-track-workspace" : ""} ${route.view === "settings" ? "is-settings-workspace" : ""}`.trim()} data-route-entry={cacheKey}>{children}</div>
    {active && showBackToTop && (
      <button className="route-back-to-top" type="button" aria-label="回到顶部" data-tooltip="回到顶部" onClick={scrollToRouteTop}>
        <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
      </button>
    )}
  </>;
}

const QueueItem = memo(function QueueItem({ track, index, active, onSelect, onRemove }: {
  track: PlexItem;
  index: number;
  active: boolean;
  onSelect: (track: PlexItem) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className={`queue-item ${active ? "active" : ""}`}>
      <div className="queue-item-main">
        <span className="queue-item-artwork">
          <Artwork item={track} size="small" />
          <button
            type="button"
            className="queue-item-play-indicator"
            aria-label={active ? `正在播放${track.title}` : `播放${track.title}`}
            disabled={active}
            onClick={() => onSelect(track)}
          >
            {active
              ? <AudioLines size={15} strokeWidth={2.2} aria-hidden="true" />
              : <Play size={14} fill="currentColor" strokeWidth={2.2} aria-hidden="true" />}
          </button>
        </span>
        <span><strong>{track.title}</strong><small>{trackArtist(track)}</small></span>
      </div>
      {!active && <IconButton label="从队列移除" onClick={() => onRemove(index)}><Trash2 size={14} /></IconButton>}
    </div>
  );
});

const QueuePanel = memo(function QueuePanel({ open, queue, currentIndex, onSelect, onRemove, onClear }: { open: boolean; queue: PlexItem[]; currentIndex: number; onSelect: (track: PlexItem) => void; onRemove: (index: number) => void; onClear: () => Promise<void> }) {
  const [clearing, setClearing] = useState(false);
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await onClear();
    } finally {
      setClearing(false);
    }
  };
  return (
    <aside className="queue-panel" data-panel-state={open ? "open" : "closing"} role="dialog" aria-modal="true" aria-hidden={!open || undefined} inert={!open || undefined} aria-label="播放队列">
      <header>
        <h2>{`播放队列(${queue.length})`}</h2>
        <IconButton label="清空播放队列" disabled={clearing || !queue.length} onClick={() => void clear()}>
          {clearing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
        </IconButton>
      </header>
      <div className="queue-list">
        {queue.length ? queue.map((track, index) => (
          <QueueItem
            key={track.queueInstanceId || `${track.ratingKey}-${index}`}
            track={track}
            index={index}
            active={index === currentIndex}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        )) : <EmptyState title="队列为空" description="选择一首歌曲开始播放。" icon={<ListMusic size={25} />} />}
      </div>
    </aside>
  );
});

function LyricsPanel({ open, track, lyrics, onSeek }: {
  open: boolean;
  track?: PlexItem;
  lyrics: NowPlayingLyricsState;
  onSeek: (seconds: number) => void;
}) {
  const trackIdentity = track?.ratingKey || track?.key || track?.title || "";
  const lines = lyrics.document?.lines ?? [];
  const activeIndex = lyrics.activeIndex ?? -1;
  const lyricScroll = useActiveLyricsScroll({
    trackIdentity,
    timed: lyrics.document?.timed === true,
    activeLine: lines[activeIndex],
  });

  return (
    <aside className="lyrics-panel" data-panel-state={open ? "open" : "closing"} aria-hidden={!open || undefined} inert={!open || undefined} aria-label="歌词">
      <div
        ref={lyricScroll.listRef}
        className="lyrics-list"
        tabIndex={0}
        aria-label={`${track?.title || "当前歌曲"}的歌词内容`}
        aria-live="polite"
        aria-busy={lyrics.loading || undefined}
        onWheel={lyricScroll.onWheel}
        onTouchMove={lyricScroll.onTouchMove}
        onPointerDown={lyricScroll.onPointerDown}
        onKeyDown={lyricScroll.onKeyDown}
      >
        {lyrics.loading ? (
          <div className="lyrics-message" role="status"><LoaderCircle className="spin" size={22} /><span>正在读取歌词…</span></div>
        ) : lyrics.error ? (
          <div className="lyrics-message error" role="alert"><Captions size={24} /><span>歌词加载失败</span><small>{lyrics.error}</small></div>
        ) : !track ? (
          <div className="lyrics-message"><Music2 size={24} /><span>播放歌曲后显示歌词</span><small>从资料库选择一首音乐开始。</small></div>
        ) : !lyrics.document || !lines.length ? (
          <div className="lyrics-message"><Captions size={24} /><span>这首歌暂无可用歌词</span><small>只显示服务器授权返回的歌词。</small></div>
        ) : lines.map((line, index) => {
          if (line.clear || !line.texts.length) return <div className="lyric-gap" key={line.id} aria-hidden="true" />;
          const timed = lyrics.document?.timed === true && line.startMs !== null;
          const active = timed && index === activeIndex;
          return (
            <button
              ref={(node) => lyricScroll.setLineRef(line.id, node)}
              className={`lyric-line ${active ? "is-active" : ""} ${timed ? "is-timed" : "is-static"}`}
              key={line.id}
              type="button"
              disabled={!timed}
              aria-current={active ? "true" : undefined}
              onClick={() => timed && onSeek((line.startMs || 0) / 1000)}
            >
              {line.texts.map((text, textIndex) => <span key={`${line.id}-${textIndex}`}>{text}</span>)}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function CreatePlaylistDialog({ serverId, sectionKey, onClose, onCreated, onError }: {
  serverId: string;
  sectionKey?: string;
  onClose: () => void;
  onCreated: (playlist: PlexPlaylist) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTargetRef = useRef<HTMLElement | null>(null);
  const restoreFocusFrameRef = useRef<number | undefined>(undefined);
  const validTitle = Boolean(title.trim()) && Array.from(title.trim()).length <= 255;
  const cancel = useCallback(() => {
    if (busy) return;
    setTitle("");
    setError(undefined);
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    if (restoreFocusFrameRef.current !== undefined) {
      window.cancelAnimationFrame(restoreFocusFrameRef.current);
      restoreFocusFrameRef.current = undefined;
    }
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!restoreFocusTargetRef.current && activeElement !== document.body) {
      restoreFocusTargetRef.current = activeElement;
    }
    inputRef.current?.focus();
    return () => {
      restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
        const restoreTarget = restoreFocusTargetRef.current;
        if (
          restoreTarget?.isConnected
          && !restoreTarget.closest("[inert]")
          && !restoreTarget.matches(":disabled")
        ) restoreTarget.focus();
        restoreFocusFrameRef.current = undefined;
      });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, cancel]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validTitle || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const seedTrack = sectionKey
        ? await getTracksPage(serverId, sectionKey, 0, 1).then((page) => page.items[0]).catch(() => undefined)
        : undefined;
      const playlist = await createPlaylist(serverId, title, "", seedTrack ? {
        seedRatingKey: seedTrack.ratingKey,
        clearItemsAfterCreate: true,
      } : undefined);
      setTitle("");
      onCreated(playlist);
    } catch (reason) {
      const message = playlistCreateErrorMessage(reason);
      setError(message);
      setBusy(false);
      onError(message);
    }
  };

  return (
    <div className="playlist-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <section ref={dialogRef} className="playlist-create-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-create-title" tabIndex={-1}>
        <header>
          <div>
            <h2 id="playlist-create-title">新建歌单</h2>
            <small>在当前 Plex 账号中创建</small>
          </div>
          <IconButton label="关闭新建歌单" tooltip={null} disabled={busy} onClick={cancel}><X size={18} /></IconButton>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="playlist-create-content">
            <label htmlFor="playlist-create-name">歌单名称</label>
            <input
              ref={inputRef}
              id="playlist-create-name"
              value={title}
              maxLength={255}
              required
              placeholder="例如：周末慢听"
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "playlist-create-error" : undefined}
              disabled={busy}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(undefined);
              }}
            />
            {error && <p id="playlist-create-error" className="playlist-create-error" role="alert">{error}</p>}
          </div>
          <footer>
            <button className="secondary-button" type="button" disabled={busy} onClick={cancel}>取消</button>
            <button className="primary-button" type="submit" disabled={!validTitle || busy} aria-busy={busy || undefined}>
              {busy ? <><LoaderCircle className="spin" size={15} />正在创建…</> : "创建"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function PlaylistPicker({ serverId, tracks, label, onClose, onPlaylistCreated, onAdded, onNotify }: {
  serverId: string;
  tracks: readonly PlexItem[];
  label: string;
  onClose: () => void;
  onPlaylistCreated: (playlist: PlexPlaylist) => void;
  onAdded: (playlist: PlexPlaylist, result: { requested: number; added: number; failedRatingKeys: string[] }) => void;
  onNotify: (message: string, level?: GlobalNotificationLevel) => void;
}) {
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [remainingTracks, setRemainingTracks] = useState<PlexItem[]>(() => appendUniqueArtistTracks([], tracks));
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const newPlaylistInputRef = useRef<HTMLInputElement>(null);
  const busy = Boolean(busyId) || creating;
  const validNewPlaylistTitle = Boolean(newPlaylistTitle.trim()) && Array.from(newPlaylistTitle.trim()).length <= 255;
  const closeInlineCreate = useCallback(() => {
    if (busy) return;
    setCreateOpen(false);
    setNewPlaylistTitle("");
    setCreateError(undefined);
  }, [busy]);

  useEffect(() => {
    setRemainingTracks(appendUniqueArtistTracks([], tracks));
    setError(undefined);
  }, [tracks]);

  useEffect(() => {
    if (!createOpen) return;
    const frame = window.requestAnimationFrame(() => newPlaylistInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [createOpen]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void getPlaylists(serverId)
      .then((result) => { if (!cancelled) setPlaylists(result.filter(canWritePlaylist)); })
      .catch((reason) => { if (!cancelled) setError(playlistErrorMessage(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serverId]);

  useEffect(() => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreTarget = activeElement === document.body ? null : activeElement;
    titleRef.current?.focus();
    return () => {
      window.requestAnimationFrame(() => {
        if (
          restoreTarget?.isConnected
          && !restoreTarget.closest("[inert]")
          && !restoreTarget.matches(":disabled")
        ) restoreTarget.focus();
      });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (createOpen) closeInlineCreate();
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        titleRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, closeInlineCreate, createOpen, onClose]);

  const performAdd = async (playlist: PlexPlaylist) => {
    if (!remainingTracks.length) return;
    setBusyId(playlist.ratingKey);
    setError(undefined);
    try {
      const result = await addTracksToPlaylist(serverId, playlist.ratingKey, remainingTracks.map((track) => track.ratingKey));
      const failedRatingKeys = new Set(result.failedRatingKeys);
      if (result.added === result.requested && failedRatingKeys.size === 0) {
        onAdded(playlist, result);
        return;
      }

      const failedTracks = remainingTracks.filter((track) => failedRatingKeys.has(track.ratingKey));
      setRemainingTracks(failedTracks.length ? failedTracks : remainingTracks);
      const failedCount = Math.max(result.requested - result.added, failedTracks.length);
      setError(result.added > 0
        ? `已添加 ${result.added} 首；${failedCount} 首未能写入，可再次选择同一歌单重试。`
        : `未能添加这 ${failedCount || remainingTracks.length} 首歌曲，请检查歌单写入权限后重试。`);
      setBusyId(undefined);
    } catch (reason) {
      setError(playlistErrorMessage(reason));
      setBusyId(undefined);
    }
  };

  const add = async (playlist: PlexPlaylist) => {
    if (!remainingTracks.length) return;
    setBusyId(playlist.ratingKey);
    setError(undefined);
    try {
      const existing = await getPlaylistItems(serverId, playlist.ratingKey);
      const existingKeys = new Set(existing.map((item) => item.ratingKey));
      const duplicates = remainingTracks.filter((track) => existingKeys.has(track.ratingKey));
      setBusyId(undefined);
      if (duplicates.length) {
        const names = duplicates
          .slice(0, 3)
          .map((track) => `《${track.title}》`)
          .join("、");
        const suffix = duplicates.length > 3 ? ` 等 ${duplicates.length} 首` : "";
        onNotify(`歌单“${playlist.title}”已存在歌曲${names}${suffix}`, "warning");
        return;
      }
      await performAdd(playlist);
    } catch {
      // 读取歌单现有内容失败时不阻断添加，直接执行。
      setBusyId(undefined);
      await performAdd(playlist);
    }
  };

  const openCreate = () => {
    if (busy) return;
    setNewPlaylistTitle("");
    setCreateError(undefined);
    setCreateOpen(true);
  };

  const createAndAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validNewPlaylistTitle || busy) return;
    setCreating(true);
    setCreateError(undefined);
    const creationTracks = appendUniqueArtistTracks([], remainingTracks);
    const seedTrack = creationTracks[0];
    if (!seedTrack) {
      setCreating(false);
      setCreateError("当前没有可添加到歌单的歌曲。");
      return;
    }
    let playlist: PlexPlaylist;
    try {
      playlist = await createPlaylist(serverId, newPlaylistTitle, "", { seedRatingKey: seedTrack.ratingKey });
      setPlaylists((current) => [playlist, ...current.filter((item) => item.ratingKey !== playlist.ratingKey)]);
      onPlaylistCreated(playlist);
      setNewPlaylistTitle("");
      setCreateOpen(false);
    } catch (reason) {
      setCreateError(playlistCreateErrorMessage(reason));
      setCreating(false);
      return;
    }

    const tracksToAppend = creationTracks.slice(1);
    try {
      const appended = tracksToAppend.length
        ? await addTracksToPlaylist(serverId, playlist.ratingKey, tracksToAppend.map((track) => track.ratingKey))
        : { requested: 0, added: 0, failedRatingKeys: [] };
      const result = {
        requested: creationTracks.length,
        added: appended.added + 1,
        failedRatingKeys: appended.failedRatingKeys,
      };
      const failedRatingKeys = new Set(result.failedRatingKeys);
      if (result.added === result.requested && failedRatingKeys.size === 0) {
        setCreating(false);
        onAdded(playlist, result);
        return;
      }
      const failedTracks = tracksToAppend.filter((track) => failedRatingKeys.has(track.ratingKey));
      setRemainingTracks(failedTracks.length ? failedTracks : tracksToAppend);
      const failedCount = Math.max(result.requested - result.added, failedTracks.length);
      setError(`歌单已创建并写入 ${result.added} 首；${failedCount} 首未能添加，可选择新歌单重试。`);
      setCreating(false);
    } catch (reason) {
      setRemainingTracks(tracksToAppend);
      setError(`歌单已创建并写入 1 首；其余歌曲添加失败：${playlistErrorMessage(reason)}`);
      setCreating(false);
    }
  };

  return (
    <div className="playlist-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="playlist-picker" role="dialog" aria-modal="true" aria-labelledby="playlist-picker-title">
        <header>
          <div>
            <h2 id="playlist-picker-title" ref={titleRef} tabIndex={-1}>添加到歌单</h2>
            <small>{label}{remainingTracks.length !== tracks.length ? ` · 剩余 ${remainingTracks.length} 首` : ""}</small>
          </div>
          <IconButton label="关闭歌单选择" tooltip={null} disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="playlist-picker-list" aria-busy={loading || undefined}>
          {createOpen && (
            <form className="playlist-picker-create-inline" onSubmit={(event) => void createAndAdd(event)}>
              <label htmlFor="playlist-picker-create-name">新歌单名称</label>
              <div className="playlist-picker-create-fields">
                <input
                  ref={newPlaylistInputRef}
                  id="playlist-picker-create-name"
                  value={newPlaylistTitle}
                  maxLength={255}
                  required
                  placeholder="例如：周末慢听"
                  aria-invalid={Boolean(createError) || undefined}
                  aria-describedby={createError ? "playlist-picker-create-error" : undefined}
                  disabled={busy}
                  onChange={(event) => {
                    setNewPlaylistTitle(event.target.value);
                    setCreateError(undefined);
                  }}
                />
                <button className="primary-button" type="submit" disabled={!validNewPlaylistTitle || busy} aria-busy={creating || undefined}>
                  {creating ? <LoaderCircle className="spin" size={15} /> : <Plus size={16} />}
                  {creating ? "正在创建…" : "创建并添加"}
                </button>
              </div>
              <div className="playlist-picker-create-footer">
                {createError ? <p id="playlist-picker-create-error" role="alert">{createError}</p> : <span>创建后会立即添加当前歌曲。</span>}
                <button className="text-button" type="button" disabled={busy} onClick={closeInlineCreate}>取消</button>
              </div>
            </form>
          )}
          {!createOpen && !loading && (
            <button className="playlist-picker-create-option" type="button" disabled={busy} onClick={openCreate}>
              <span className="playlist-picker-option-icon"><Plus size={18} /></span>
              <span><strong>新建歌单</strong><small>创建后立即添加当前歌曲</small></span>
            </button>
          )}
          {loading ? (
            <div className="playlist-picker-state"><LoaderCircle className="spin" size={22} /><span>正在读取音乐歌单…</span></div>
          ) : error && !playlists.length ? (
            <div className="playlist-picker-state is-error"><ListMusic size={24} /><strong>无法读取歌单</strong><span>{error}</span></div>
          ) : !playlists.length ? (
            <div className="playlist-picker-state"><ListMusic size={24} /><strong>没有可写入的音乐歌单</strong><span>这里只显示当前账号可写入的歌单；共享服务器也可能没有写入权限。</span></div>
          ) : playlists.map((playlist) => (
            <button
              className="playlist-picker-option"
              type="button"
              key={playlist.ratingKey}
              disabled={busy}
              onClick={() => void add(playlist)}
            >
              <span className="playlist-picker-option-icon"><ListMusic size={18} /></span>
              <span><strong>{playlist.title}</strong><small>{playlist.leafCount ?? 0} 首歌曲</small></span>
              {busyId === playlist.ratingKey ? <LoaderCircle className="spin" size={17} /> : <span className="playlist-picker-add">添加</span>}
            </button>
          ))}
        </div>
        {error && playlists.length > 0 && <p className="playlist-picker-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function PlayerBar({ player, loading, buffering, nowPlayingTriggerRef, expanded, queueOpen, lyricsOpen, canOpenNowPlaying, canToggleQueue, canToggleLyrics, onOpenNowPlaying, onToggleQueue, onToggleLyrics, onAddToPlaylist }: {
  player: ReturnType<typeof usePlayer>;
  loading: boolean;
  buffering: boolean;
  nowPlayingTriggerRef: RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  queueOpen: boolean;
  lyricsOpen: boolean;
  canOpenNowPlaying: boolean;
  canToggleQueue: boolean;
  canToggleLyrics: boolean;
  onOpenNowPlaying: () => void;
  onToggleQueue: () => void;
  onToggleLyrics: () => void;
  onAddToPlaylist: () => void;
}) {
  const displayDuration = usableDurationSeconds(player.duration, (player.current?.duration || 0) / 1000);
  const progressFill = rangeFillPercent(player.progress, displayDuration);
  const playbackBusy = loading || buffering;
  const queueLength = player.queue.length;
  const atFirst = player.currentIndex <= 0;
  const atLast = player.currentIndex >= queueLength - 1;
  const anyWrap = player.repeat !== "off" || player.shuffle;
  const canPrevious = queueLength > 1 && (anyWrap || !atFirst);
  const canNext = queueLength > 1 && (anyWrap || !atLast);
  const playbackLabel = playbackControlLabel({ playing: player.playing, loading, buffering });
  const cycleRepeat = () => player.setRepeat(player.repeat === "off" ? "all" : player.repeat === "all" ? "one" : "off");
  return (
    <footer className={`player-bar ${expanded ? "is-expanded" : ""}`} aria-label="播放器" aria-hidden={expanded || undefined} inert={expanded || undefined}>
      <button ref={nowPlayingTriggerRef} className="now-playing now-playing-trigger" type="button" disabled={!canOpenNowPlaying} onClick={onOpenNowPlaying} aria-label={player.current ? `展开正在播放：${player.current.title}` : "尚未播放"}>
        <span className={`mini-vinyl ${player.playing && !playbackBusy ? "is-playing" : ""}`.trim()}>
          <PlayerArtwork item={player.current} />
        </span>
        <span><strong>{player.current?.title || "尚未播放"}</strong><small>{player.current ? trackArtist(player.current) : "从资料库选择音乐"}</small></span>
      </button>
      <div className="player-center">
        <div className="transport-controls">
          <IconButton label={player.shuffle ? "关闭随机播放（当前列表）" : "随机播放当前列表"} tooltip={null} active={player.shuffle} onClick={() => player.setShuffle(!player.shuffle)}><Shuffle size={16} /></IconButton>
          <IconButton label="上一首" tooltip={null} disabled={!canPrevious} onClick={player.previous}><SkipBack size={19} fill="currentColor" /></IconButton>
          <button
            className={`play-button ${playbackBusy ? "is-loading" : ""}`}
            aria-label={playbackLabel}
            aria-busy={playbackBusy || undefined}
            aria-disabled={loading || undefined}
            onClick={player.toggle}
            disabled={!player.current || loading}
          >
            {playbackBusy
              ? <LoaderCircle className="spin playback-spinner" size={19} strokeWidth={2} aria-hidden="true" />
              : player.playing
                ? <Pause className="pause-icon" size={19} fill="currentColor" aria-hidden="true" />
                : <Play className="play-icon" size={19} fill="currentColor" aria-hidden="true" />}
          </button>
          <IconButton label="下一首" tooltip={null} disabled={!canNext} onClick={player.next}><SkipForward size={19} fill="currentColor" /></IconButton>
          <IconButton label={player.repeat === "one" ? "单曲循环" : player.repeat === "all" ? "当前列表循环" : "顺序播放，列表结束后停止"} tooltip={null} active={player.repeat !== "off"} onClick={cycleRepeat}>{player.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}</IconButton>
        </div>
        <div className="progress-row"><span>{formatDuration(player.progress * 1000)}</span><input aria-label="播放进度" type="range" min="0" max={Math.max(1, displayDuration)} step="1" value={Math.min(player.progress, displayDuration || 0)} style={{ "--range-progress": `${progressFill}%` } as CSSProperties} onChange={(event) => player.seek(Number(event.target.value))} /><span>{formatDuration(displayDuration * 1000)}</span></div>
      </div>
      <div className="player-extras">
        <PlayerLyricsAction
          hasTrack={canOpenNowPlaying}
          canToggleLyrics={canToggleLyrics}
          lyricsOpen={lyricsOpen}
          onToggle={onToggleLyrics}
        />
        <IconButton label="添加到歌单" disabled={!canOpenNowPlaying} onClick={onAddToPlaylist}><ListPlus size={19} /></IconButton>
        <IconButton label="播放队列" active={queueOpen} disabled={!canToggleQueue} onClick={onToggleQueue}><ListMusic size={19} /></IconButton>
        <SharedVolumeControl variant="compact" volume={player.volume} muted={player.muted} onMutedChange={player.setMuted} onVolumeChange={player.setVolume} />
      </div>
    </footer>
  );
}

function PlayerLyricsAction({ hasTrack, canToggleLyrics, lyricsOpen, onToggle }: {
  hasTrack: boolean;
  canToggleLyrics: boolean;
  lyricsOpen: boolean;
  onToggle: () => void;
}) {
  const presentation = getLyricsActionPresentation({ hasTrack, canToggleLyrics, lyricsOpen });
  const action = (
    <IconButton
      label={presentation.ariaLabel}
      tooltip={presentation.showsDisabledTooltip ? null : presentation.tooltip}
      active={lyricsOpen}
      disabled={presentation.disabled}
      onClick={onToggle}
    >
      <Captions size={19} />
    </IconButton>
  );

  if (!presentation.showsDisabledTooltip) return action;

  return (
    <span className="player-action-tooltip-anchor is-disabled">
      {action}
      <span className="player-action-tooltip" role="tooltip">{presentation.tooltip}</span>
    </span>
  );
}

function LoginScreen({ brandPreset, clientIdentifier, onAuthenticated }: { brandPreset: BrandPreset; clientIdentifier: string; onAuthenticated: () => void | Promise<void> }) {
  const login = usePlexLogin(clientIdentifier, onAuthenticated);

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-card-heading">
          <div className="login-brand"><BrandIcon className="brand-mark large" preset={brandPreset} size={48} /><span>Cadilume</span></div>
          <span className="login-status"><Radio size={14} />安全连接</span>
        </div>
        <div className="login-title-block">
          <span className="login-eyebrow">桌面音乐空间</span>
          <h1 id="login-title">把你的音乐<br /><em>带回桌面</em></h1>
          <p className="login-copy">使用系统浏览器安全登录 Plex。只要账号获得音乐资料库共享权限，就能在 Cadilume 中浏览和播放。</p>
        </div>
        <div className="login-features" role="list" aria-label="Cadilume 功能">
          <span role="listitem"><Check size={16} />独立播放器音量</span>
          <span role="listitem"><Check size={16} />家庭与共享服务器</span>
          <span role="listitem"><Check size={16} />清晰的托盘退出入口</span>
        </div>
        <div className="login-actions">
          <button className="primary-button login-button" onClick={() => void login.start()} disabled={login.busy} aria-busy={login.busy || undefined}>{login.busy ? <LoaderCircle className="spin" size={18} /> : <CircleUserRound size={18} />}{login.buttonLabel}</button>
          {login.busy && <button className="secondary-button login-cancel-button" type="button" onClick={() => void login.cancel()}><X size={17} />取消登录</button>}
        </div>
        {login.error && <p className="form-error" role="alert">{login.error}</p>}
        <div className="login-trust"><LockKeyhole size={15} /><span>仅请求当前账号已获授权的服务器和音乐库，不绕过 Plex 权限。</span></div>
      </section>
      <aside className="login-art" aria-hidden="true">
        <div className="login-art-grid" />
        <div className="record record-one" /><div className="record record-two" />
        <div className="sound-lines">{Array.from({ length: 34 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 23) % 92)}px` }} />)}</div>
        <div className="login-art-copy"><span>Cadilume</span><strong>把每一首歌<br />放回熟悉的位置</strong><small>连接授权资料库，继续你的播放现场。</small></div>
        <div className="login-art-player"><span className="login-art-player-mark"><Music2 size={16} /></span><span><strong>正在等待你的音乐</strong><small>准备连接资料库</small></span><span className="login-art-player-dot" /></div>
      </aside>
    </main>
  );
}

interface ArtworkItem {
  ratingKey: string;
  title: string;
  parentRatingKey?: string;
  thumb?: string;
  art?: string;
  composite?: string;
  imageUrl?: string;
}

export function Artwork({ item, size, className = "", preferArt = false, stableTransition = false, canvasReadable = false }: {
  item?: ArtworkItem;
  size: "small" | "large" | "hero" | "player" | "immersive" | "backdrop";
  className?: string;
  preferArt?: boolean;
  stableTransition?: boolean;
  canvasReadable?: boolean;
}) {
  const serverId = useContext(ArtworkServerContext);
  const hostRef = useRef<HTMLSpanElement>(null);
  const path = preferArt
    ? item?.art || item?.thumb || item?.composite
    : item?.thumb || item?.composite || item?.art;
  const cacheIdentity = artworkCacheIdentity(item);
  const dimensions = size === "small" || size === "player"
    ? { width: 96, height: 96 }
    : size === "hero"
      ? { width: 480, height: 480 }
      : size === "backdrop"
        ? { width: 1440, height: 900 }
        : size === "immersive"
          ? { width: 640, height: 640 }
          : { width: 420, height: 420 };
  const artworkRequestKey = serverId && path
    ? `${serverId}:${dimensions.width}x${dimensions.height}:${cacheIdentity || path}`
    : undefined;
  const resolvedStartupSource = item?.imageUrl
    || (serverId && path ? getResolvedArtwork(serverId, path, 512, 512, cacheIdentity) : undefined);
  const [visible, setVisible] = useState(!isDesktopRuntime() || Boolean(resolvedStartupSource));
  const [source, setSource] = useState(resolvedStartupSource);
  const [displayedSource, setDisplayedSource] = useState(resolvedStartupSource);
  const [failed, setFailed] = useState(false);
  const [ticketRetryCount, setTicketRetryCount] = useState(0);

  useEffect(() => {
    const nextSource = item?.imageUrl
      || (serverId && path ? getResolvedArtwork(serverId, path, 512, 512, cacheIdentity) : undefined);
    setSource(nextSource);
    if (!stableTransition || (!nextSource && !path)) setDisplayedSource(nextSource);
    setFailed(false);
    setTicketRetryCount(0);
  }, [cacheIdentity, item?.imageUrl, item?.ratingKey, path, serverId, stableTransition]);

  useEffect(() => {
    if (!isDesktopRuntime() || size === "player" || stableTransition || item?.imageUrl || !path || !serverId) {
      if (!isDesktopRuntime() && !item?.imageUrl && path) setSource(path);
      setVisible(true);
      return;
    }
    const element = hostRef.current;
    if (!element || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "96px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item?.imageUrl, path, serverId, size]);

  useEffect(() => {
    if (!visible || source || failed || !path || !serverId || !artworkRequestKey || !isDesktopRuntime()) return;
    let cancelled = false;
    let idleHandle: number | undefined;
    let fallbackTimer: number | undefined;
    const startRequest = () => {
      if (cancelled) return;
      const request = requestCachedArtwork(
        serverId,
        path,
        dimensions.width,
        dimensions.height,
        cacheIdentity,
      );
      void request
        .then((url) => {
          if (cancelled) return;
          setSource(url);
          if (stableTransition) setDisplayedSource((current) => current || url);
        })
        .catch(() => {
          invalidateCachedArtwork(
            serverId,
            path,
            dimensions.width,
            dimensions.height,
            cacheIdentity,
          );
          if (!cancelled && ticketRetryCount < 2) {
            // A ticket can race server discovery or expire while a WebView
            // image is being promoted from the lazy queue. Reissue it a
            // bounded number of times before showing the placeholder.
            setTicketRetryCount((count) => count + 1);
            setFailed(false);
            return;
          }
          if (!cancelled) {
            setFailed(true);
            setDisplayedSource(undefined);
          }
        });
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (stableTransition || size === "player") {
      startRequest();
    } else if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(startRequest, { timeout: 250 });
    } else {
      fallbackTimer = window.setTimeout(startRequest, 80);
    }
    return () => {
      cancelled = true;
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
    };
  }, [artworkRequestKey, cacheIdentity, dimensions.height, dimensions.width, failed, path, serverId, size, source, stableTransition, ticketRetryCount, visible]);

  const handleImageError = () => {
    const canRefreshTicket = !item?.imageUrl || isLoopbackArtworkSource(item.imageUrl);
    if (canRefreshTicket && artworkRequestKey && isDesktopRuntime()) {
      if (path && serverId) invalidateCachedArtwork(
        serverId,
        path,
        dimensions.width,
        dimensions.height,
        cacheIdentity,
      );
      if (ticketRetryCount < 2) {
        setTicketRetryCount((count) => count + 1);
        setFailed(false);
        setSource(undefined);
        return;
      }
    }
    setFailed(true);
    setDisplayedSource(undefined);
  };
  const awaitingTicketRetry = ticketRetryCount > 0 && !failed && !source && Boolean(path);
  const renderedSource = stableTransition ? displayedSource : source;
  const candidateSource = stableTransition && source && source !== displayedSource ? source : undefined;

  return (
    <span ref={hostRef} className={`artwork artwork-${size} ${className}`}>
      {renderedSource && (!failed || stableTransition)
        ? <img
            crossOrigin={canvasReadable && isLoopbackArtworkSource(renderedSource) ? "anonymous" : undefined}
            src={renderedSource}
            alt={`${item?.title || "音乐"} 封面`}
            loading={stableTransition ? "eager" : "lazy"}
            decoding="async"
            onError={() => {
              if (stableTransition && renderedSource !== source) {
                setDisplayedSource(undefined);
                return;
              }
              handleImageError();
            }}
          />
        : awaitingTicketRetry ? null : <Music2 aria-hidden="true" />}
      {candidateSource && !failed && (
        <img
          className="artwork-candidate"
          crossOrigin={canvasReadable && isLoopbackArtworkSource(candidateSource) ? "anonymous" : undefined}
          src={candidateSource}
          alt=""
          aria-hidden="true"
          decoding="async"
          onLoad={() => setDisplayedSource(candidateSource)}
          onError={handleImageError}
        />
      )}
    </span>
  );
}

function PlayerArtwork({ item }: { item?: ArtworkItem }) {
  const serverId = useContext(ArtworkServerContext);
  const path = item?.thumb || item?.composite || item?.art;
  const cacheIdentity = artworkCacheIdentity(item);
  const initialSource = (item?.imageUrl && !isLoopbackArtworkSource(item.imageUrl) ? item.imageUrl : undefined)
    || (serverId && path ? getResolvedArtwork(serverId, path, 512, 512, cacheIdentity) : undefined)
    || item?.imageUrl;
  const artworkIdentity = `${item?.ratingKey || "none"}:${path || item?.imageUrl || "none"}`;
  const artworkIdentityRef = useRef(artworkIdentity);
  const [source, setSource] = useState(initialSource);
  const [domRetryCount, setDomRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (artworkIdentityRef.current !== artworkIdentity) {
      artworkIdentityRef.current = artworkIdentity;
      setSource(undefined);
      setDomRetryCount(0);
    }
    if (!path && !item?.imageUrl) {
      setSource(undefined);
      return;
    }
    if (!isDesktopRuntime()) {
      setSource(item?.imageUrl || path);
      return;
    }

    const load = async () => {
      let candidate = (item?.imageUrl && !isLoopbackArtworkSource(item.imageUrl) ? item.imageUrl : undefined)
        || (serverId && path ? getResolvedArtwork(serverId, path, 512, 512, cacheIdentity) : undefined)
        || item?.imageUrl;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!candidate && serverId && path) {
          try {
            candidate = await withStartupTimeout(
              () => requestCachedArtwork(serverId, path, 420, 420, cacheIdentity),
              STARTUP_ARTWORK_REQUEST_TIMEOUT_MS,
              "底部播放器封面票据准备超时。",
            );
          } catch {
            candidate = undefined;
          }
        }
        if (cancelled) return;
        const decoded = candidate
          ? await withStartupTimeout(
            () => decodeArtwork(candidate as string),
            STARTUP_ARTWORK_REQUEST_TIMEOUT_MS,
            "底部播放器封面解码超时。",
          ).catch(() => false)
          : false;
        if (cancelled) return;
        if (candidate && decoded) {
          setSource(candidate);
          playbackLog("info", "mini_artwork=ready");
          return;
        }
        if (serverId && path) invalidateCachedArtwork(serverId, path, 420, 420, cacheIdentity);
        candidate = undefined;
      }
      if (!cancelled) {
        setSource(undefined);
        playbackLog("warn", "mini_artwork=unavailable_after_retry");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [artworkIdentity, cacheIdentity, domRetryCount, item?.imageUrl, path, serverId]);

  return (
    <span className="player-artwork" aria-hidden="true">
      {source
        ? <img key={source} src={source} alt="" decoding="async" loading="eager" onError={() => {
          playbackLog("warn", "mini_artwork=dom_error");
          if (serverId && path && domRetryCount < 1) {
            invalidateCachedArtwork(serverId, path, 420, 420, cacheIdentity);
            setSource(undefined);
            setDomRetryCount((count) => count + 1);
          } else {
            setSource(undefined);
          }
        }} />
        : <Music2 size={14} />}
    </span>
  );
}

function isLoopbackArtworkSource(source?: string): boolean {
  return typeof source === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(source);
}

export function Avatar({ account }: { account: PlexAccount }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [account.thumb]);
  return account.thumb && !failed
    ? <img className="avatar" src={account.thumb} alt="" onError={() => setFailed(true)} />
    : <span className="avatar fallback">{(account.title || account.username || "P").slice(0, 1).toUpperCase()}</span>;
}

export function IconButton({ label, tooltip, className = "", active = false, disabled = false, onClick, children }: { label: string; tooltip?: string | null; className?: string; active?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  const tooltipText = tooltip === null ? undefined : tooltip ?? label;
  return <button type="button" className={`icon-button ${active ? "active" : ""} ${className}`.trim()} aria-label={label} data-tooltip={tooltipText} disabled={disabled} onClick={onClick}>{children}</button>;
}

function SourceSyncOverlay() {
  return (
    <div className="source-sync-overlay" role="status" aria-live="polite" aria-atomic="true" aria-busy="true">
      <div className="source-sync-overlay-panel">
        <LoaderCircle className="spin" size={20} aria-hidden="true" />
        <span>正在同步Plex资料...</span>
      </div>
    </div>
  );
}

function PlaybackErrorAlert({ failure, trackTitle, onRetry, onOpenSettings, onClose }: {
  failure: PlaybackFailure;
  trackTitle?: string;
  onRetry: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => retryRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [failure.technicalDetails]);
  const attempted = failure.attemptedQualities.map((quality) => {
    if (quality === "auto") return "自动源";
    if (quality === "original") return "原始质量";
    return `${quality} kbps`;
  }).join("、");
  return (
    <section className="playback-alert" role="alert" aria-live="assertive" aria-atomic="true">
      <span className="playback-alert-icon" aria-hidden="true"><TriangleAlert size={21} /></span>
      <div className="playback-alert-content">
        <strong>{trackTitle ? `《${trackTitle}》暂时无法播放` : "这首歌曲暂时无法播放"}</strong>
        <p>Cadilume 已尝试兼容的播放方式。你可以重新尝试，或检查播放质量与服务器连接。</p>
        <div className="playback-alert-actions">
          <button ref={retryRef} className="primary-button" type="button" onClick={onRetry}><RefreshCw size={15} />重试播放</button>
          <button className="secondary-button" type="button" onClick={onOpenSettings}><SlidersHorizontal size={15} />播放设置</button>
        </div>
        <details className="playback-alert-details">
          <summary>诊断信息</summary>
          <code>{failure.technicalDetails}</code>
          {attempted && <small>已尝试：{attempted}</small>}
        </details>
      </div>
      <IconButton label="关闭播放失败提醒" tooltip={null} onClick={onClose}><X size={17} /></IconButton>
    </section>
  );
}

function EmptyState({ title, description, icon = <Music2 size={28} /> }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{description}</p></div>;
}

function SplashScreen({ brandPreset, stage = "正在准备你的音乐空间" }: { brandPreset: BrandPreset; stage?: string }) {
  return (
    <main className="splash-screen" data-testid="splash-screen">
      <section className="splash-content" aria-live="polite" aria-busy="true">
        <div className="splash-header"><div className="splash-brand"><BrandIcon className="brand-mark splash-mark" preset={brandPreset} size={48} /><span><strong>Cadilume</strong><small>桌面音乐空间</small></span></div><span className="splash-stage"><span className="splash-stage-dot" />正在启动</span></div>
        <div className="splash-main">
          <div className="splash-visual" aria-hidden="true">
            <div className="splash-orbit splash-orbit-one" /><div className="splash-orbit splash-orbit-two" />
            <BrandIcon className="splash-disc" preset={brandPreset} size={136} />
            <div className="splash-signal">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 17) % 48)}px` }} />)}</div>
          </div>
          <div className="splash-copy">
            <h1>准备你的音乐空间</h1>
            <p>正在恢复账号、音乐来源与上次播放现场。</p>
            <div className="splash-progress" role="status"><span className="splash-progress-icon"><LoaderCircle className="spin" size={18} /></span><span><strong>{stage}</strong><small>首页和上次播放记录准备完成后进入</small></span><span className="splash-progress-pulse" /></div>
            <div className="splash-checks"><span><Check size={14} />凭据安全恢复</span><span><Check size={14} />连接状态检测</span></div>
          </div>
        </div>
      </section>
    </main>
  );
}

function FatalError({ brandPreset, message, retry }: { brandPreset: BrandPreset; message: string; retry: () => void }) {
  return <main className="fatal-screen"><BrandIcon className="brand-mark large" preset={brandPreset} size={48} /><h1>无法启动 Cadilume</h1><p>{message}</p><button className="primary-button" onClick={retry}><RefreshCw size={17} />重试</button></main>;
}

function readNowPlayingMode(): NowPlayingMode {
  try {
    return localStorage.getItem(NOW_PLAYING_MODE_STORAGE_KEY) === "artwork" ? "artwork" : "vinyl";
  } catch {
    return "vinyl";
  }
}

function readStoredQuality(): StreamQuality {
  try {
    const stored = localStorage.getItem("cadilume-quality");
    return stored === "auto" || stored === "original" || stored === "320" || stored === "256" || stored === "192"
      ? stored
      : DEFAULT_STREAM_QUALITY;
  } catch {
    return DEFAULT_STREAM_QUALITY;
  }
}

function playlistReadErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/\b(?:401|403|404)\b|forbidden|not found|permission|unauthori[sz]ed|无权|权限/iu.test(message)) {
    return "当前账号无法读取这个歌单，或歌单已被服务器移除。共享服务器会继续服从 Plex Media Server 的访问权限。";
  }
  return message;
}

function playlistCreateErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/\b(?:401|403)\b|forbidden|permission|unauthori[sz]ed|无权|权限/iu.test(message)) {
    return "当前账号没有在这台 Plex 服务器创建歌单的权限。";
  }
  return message;
}

function playlistErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/\b(?:401|403|404)\b|forbidden|not found|permission|unauthori[sz]ed|无权|权限/iu.test(message)) {
    return "当前账号没有写入这个歌单的权限，或歌单已被服务器移除。共享账号需要服务器所有者授予写入权限。";
  }
  return message;
}

const APPEARANCE_SNAPSHOT_VARIABLES = [
  "--bg",
  "--sidebar",
  "--panel",
  "--panel-strong",
  "--panel-hover",
  "--border",
  "--border-strong",
  "--text",
  "--muted",
  "--muted-strong",
  "--muted-faint",
  "--accent",
  "--accent-soft",
  "--accent-ink",
  "--danger",
  "--surface-soft",
  "--surface-deep",
  "--side-panel",
  "--topbar",
  "--hover-fill",
  "--row-border",
  "--artwork",
  "--media-shadow",
  "--media-shadow-hover",
  "--range-track",
  "--login-art",
  "--login-art-ink",
] as const;

const APPEARANCE_MEDIA_GEOMETRY_SELECTOR = [
  "img",
  "video",
  ".artwork",
  ".avatar",
  ".now-playing-background-artwork",
  ".now-playing-visual-stage",
  ".now-playing-artwork",
].join(", ");

function applyAppearance({ theme, brand }: AppearanceState) {
  applyThemeMode(theme);
  applyBrandPreset(brand);
}

function preserveSnapshotScrollAndMediaGeometry(appRoot: HTMLElement, snapshot: HTMLElement) {
  const sourceElements = [appRoot, ...Array.from(appRoot.querySelectorAll<HTMLElement>("*"))];
  const snapshotElements = [snapshot, ...Array.from(snapshot.querySelectorAll<HTMLElement>("*"))];
  const count = Math.min(sourceElements.length, snapshotElements.length);

  for (let index = 0; index < count; index += 1) {
    const source = sourceElements[index];
    const copy = snapshotElements[index];
    if (source.scrollTop || source.scrollLeft) {
      copy.scrollTop = source.scrollTop;
      copy.scrollLeft = source.scrollLeft;
    }

    if (!source.matches(APPEARANCE_MEDIA_GEOMETRY_SELECTOR)) continue;
    const style = window.getComputedStyle(source);
    const computedWidth = Number.parseFloat(style.width);
    const computedHeight = Number.parseFloat(style.height);
    const layoutWidth = Number.isFinite(computedWidth) ? computedWidth : source.offsetWidth;
    const layoutHeight = Number.isFinite(computedHeight) ? computedHeight : source.offsetHeight;
    if (layoutWidth <= 0 || layoutHeight <= 0) continue;
    copy.style.width = `${layoutWidth}px`;
    copy.style.height = `${layoutHeight}px`;
    copy.style.minWidth = `${layoutWidth}px`;
    copy.style.minHeight = `${layoutHeight}px`;
    copy.style.maxWidth = `${layoutWidth}px`;
    copy.style.maxHeight = `${layoutHeight}px`;
    copy.style.objectFit = style.objectFit;
    copy.style.objectPosition = style.objectPosition;
    copy.style.filter = style.filter;
    copy.style.transform = style.transform;
    copy.style.transformOrigin = style.transformOrigin;
    copy.style.boxSizing = style.boxSizing;
    copy.style.borderRadius = style.borderRadius;
    copy.style.overflow = style.overflow;
    copy.style.aspectRatio = style.aspectRatio;
    copy.style.clipPath = style.clipPath;
    copy.style.setProperty("-webkit-mask-image", style.getPropertyValue("-webkit-mask-image"));
    copy.style.setProperty("mask-image", style.getPropertyValue("mask-image"));
    copy.style.transition = "none";
    copy.style.animation = "none";
  }
}

function createAppearanceSnapshot(appearance: AppearanceState) {
  const appRoot = document.getElementById("root");
  if (!appRoot) return;

  const rootStyle = window.getComputedStyle(document.documentElement);
  const snapshot = appRoot.cloneNode(true) as HTMLElement;
  rasterizeAppearanceSnapshotImages(appRoot, snapshot);
  snapshot.removeAttribute("id");
  snapshot.classList.add("theme-transition-snapshot");
  snapshot.dataset.theme = appearance.theme;
  snapshot.dataset.brand = appearance.brand;
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.setAttribute("inert", "");
  snapshot.style.color = rootStyle.color;
  snapshot.style.fontFamily = rootStyle.fontFamily;
  snapshot.style.colorScheme = appearance.theme;
  for (const variable of APPEARANCE_SNAPSHOT_VARIABLES) {
    snapshot.style.setProperty(variable, rootStyle.getPropertyValue(variable));
  }
  document.body.append(snapshot);

  // Scroll containers only acquire their real scroll range after the clone is
  // attached. Copying scrollTop before this point makes a scrolled page flash
  // from its top edge during the theme hand-off.
  preserveSnapshotScrollAndMediaGeometry(appRoot, snapshot);
  snapshot.querySelectorAll("audio, video").forEach((media) => media.remove());
  snapshot.querySelectorAll(".route-page-scroll").forEach((content) => content.classList.remove("is-route-entering"));
  snapshot.querySelectorAll<HTMLElement>(".now-playing-view:not([data-theme])").forEach((view) => {
    view.dataset.theme = appearance.theme;
  });
  return { appRoot, snapshot };
}

function nextAppearancePaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function settleAppearanceSnapshot(snapshot: HTMLElement): Promise<void> {
  snapshot.classList.add("is-ready");
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function playAppearanceReveal(origin: ThemeTransitionOrigin, previousAppearance: AppearanceState, applyAppearanceState: () => void): Promise<void> {
  const layers = createAppearanceSnapshot(previousAppearance);
  if (!layers) {
    applyAppearanceState();
    return Promise.resolve();
  }

  const { snapshot } = layers;
  const horizontalDistance = Math.max(origin.x, window.innerWidth - origin.x);
  const verticalDistance = Math.max(origin.y, window.innerHeight - origin.y);
  const radius = Math.hypot(horizontalDistance, verticalDistance);
  const circleStart = `circle(0px at ${origin.x}px ${origin.y}px)`;
  const circleEnd = `circle(${radius}px at ${origin.x}px ${origin.y}px)`;
  return settleAppearanceSnapshot(snapshot).then(() => {
    // Keep the stable old snapshot above the app while the live tree changes
    // theme. Masking #root re-composites every image layer in WebKit and can
    // make artwork flash even when its layout geometry is unchanged.
    flushSync(applyAppearanceState);
    // The snapshot completely covers the live tree at first, then contracts
    // around the trigger. This restores the circular reveal without clipping
    // the live WebKit layer that owns the artwork.
    snapshot.style.clipPath = circleEnd;
    snapshot.style.setProperty("-webkit-clip-path", circleEnd);
    return nextAppearancePaint();
  }).then(() => new Promise((resolve) => {
    let completed = false;
    let animation: Animation | undefined;
    let timeout: number | undefined;
    const release = () => {
      if (completed) return;
      completed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      animation?.cancel();
      snapshot.remove();
      resolve();
    };
    timeout = window.setTimeout(release, 760);
    try {
      animation = snapshot.animate(
        [
          { clipPath: circleEnd, opacity: 1 },
          { clipPath: circleStart, opacity: 1 },
        ],
        { duration: 500, easing: "cubic-bezier(0.2, 0.74, 0.22, 1)", fill: "both" },
      );
      void animation.finished.catch(() => undefined).finally(release);
    } catch {
      release();
    }
  }));
}

function useAppearance() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  const [brandPreset, setBrandPreset] = useState<BrandPreset>(readInitialBrandPreset);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(themeMode);
  const transitionLockRef = useRef(false);
  const brandSaveChainRef = useRef<Promise<void>>(Promise.resolve());

  useLayoutEffect(() => {
    applyAppearance({ theme: themeMode, brand: brandPreset });
    setResolvedTheme((current) => current === themeMode ? current : themeMode);
  }, [brandPreset, themeMode]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "cadilume-theme") {
        const nextTheme = event.newValue;
        if (nextTheme === "light" || nextTheme === "dark") setThemeMode(nextTheme);
        return;
      }
      if (event.key === BRAND_STORAGE_KEY) {
        const preset = normalizeBrandPreset(event.newValue);
        if (preset) setBrandPreset(preset);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const syncBrandPreset = useCallback((next: unknown) => {
    const preset = normalizeBrandPreset(next);
    if (!preset || preset === brandPreset) return;
    persistBrandPreset(preset);
    applyBrandPreset(preset);
    setBrandPreset(preset);
  }, [brandPreset]);

  const updateTheme = useCallback<ThemeModeChange>((next, origin) => {
    if (transitionLockRef.current) return;
    if (next === themeMode) return;
    try {
      localStorage.setItem("cadilume-theme", next);
    } catch {
      // Keep the in-memory preference when storage is restricted.
    }

    const applyAtomically = () => {
      applyAppearance({ theme: next, brand: brandPreset });
      setResolvedTheme(next);
      setThemeMode(next);
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const playbackActive = document.querySelector('.app-shell[data-playback-active="true"]') !== null;
    const isWindows = detectOutputPlatform(navigator) === "windows";
    if (!origin || !shouldAnimateAppearanceReveal(true, reducedMotion, playbackActive, isWindows)) {
      applyAtomically();
      return;
    }

    transitionLockRef.current = true;
    const release = () => {
      transitionLockRef.current = false;
    };
    void playAppearanceReveal(origin, { theme: themeMode, brand: brandPreset }, applyAtomically).finally(release);
  }, [brandPreset, themeMode]);

  const updateBrandPreset = useCallback<BrandPresetChange>(async (next) => {
    if (next === brandPreset) return;

    // Brand presets only change CSS variables. Apply them optimistically and
    // serialize the small native persistence calls so a rapid sequence keeps
    // its final selection instead of waiting on a full-window snapshot.
    persistBrandPreset(next);
    applyAppearance({ theme: themeMode, brand: next });
    setBrandPreset(next);
    const save = brandSaveChainRef.current.then(() => saveBrandPreset(next));
    brandSaveChainRef.current = save.catch(() => undefined);
    await save;
  }, [brandPreset, themeMode]);

  return {
    themeMode,
    resolvedTheme,
    brandPreset,
    onThemeMode: updateTheme,
    onBrandPreset: updateBrandPreset,
    syncBrandPreset,
  };
}

export default App;

import {
  Album,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Cable,
  Captions,
  Check,
  ChevronDown,
  CircleUserRound,
  Cloud,
  Database,
  Globe2,
  Headphones,
  History,
  Laptop,
  ListEnd,
  ListPlus,
  ListMusic,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  Mic2,
  Moon,
  Music2,
  PanelTop,
  Pause,
  Palette,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  Repeat1,
  Search,
  Server,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Speaker,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  WifiOff,
  X,
} from "lucide-react";
import * as Select from "@radix-ui/react-select";
import { KeepAlive, type KeepAliveRef, useKeepAliveContext, useKeepAliveRef } from "keepalive-for-react";
import { createHashRouter, Navigate, RouterProvider, useLocation, useNavigate, useOutlet } from "react-router-dom";
import { createContext, FormEvent, memo, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  artworkUrl,
  addTracksToPlaylist,
  bootstrap,
  canWritePlaylist,
  clearArtworkCache,
  createPlaylist,
  discoverServers,
  getArtistTracksPage,
  getCacheStatus,
  getChildren,
  getLibraryItems,
  getLibraryMetadata,
  getTracksPage,
  getPlaylistItems,
  getPlaylists,
  getRecentAlbums,
  getRecommendationHubs,
  getSections,
  isDesktopRuntime,
  logout,
  normalizeDeviceName,
  openWindowsAudioSettings,
  removeTracksFromPlaylist,
  searchLibrary,
  setStatusIconEnabled as saveStatusIconEnabled,
  setBrandPreset as saveBrandPreset,
  setDeviceName as saveDeviceName,
  showMainWindow,
} from "./api";
import "./App.css";
import { ARTIST_BIOGRAPHY_COLLAPSE_LINES, normalizeArtistBiography, previewArtistBiography, shouldCollapseArtistBiography } from "./artistBiography";
import { appendUniqueArtistTracks, collectAllArtistTracks, isArtistTrackCollectionCancelled } from "./artistTracks";
import { selectRandomContextPlayback } from "./contextPlayback";
import { groupPlexItemsByAlphabet, PLEX_ALPHABET_INDEX, type PlexAlphabetBucket } from "./libraryIndex";
import { isCurrentLibraryDetailRoute, libraryDetailRoute, libraryRouteHash, libraryTracksRoute, parseLibraryRoute, type LibraryDetailType, type LibraryRoute } from "./libraryRoute";
import { createCadilumeEntryState, historyEntryCacheKey, routeEntryId, routeParentEntryId } from "./routeEntry";
import { routeScrollBehavior, shouldShowRouteBackToTop } from "./routeScroll";
import { hasDisplayableLyrics } from "./lyrics";
import { getPlexLyricsScrollTop, NowPlayingView, type NowPlayingLyricsState, type NowPlayingMode } from "./NowPlayingView";
import { getLyricsActionPresentation } from "./playerActions";
import { playbackControlLabel, rangeFillPercent, usableDurationSeconds } from "./playerUi";
import { homeRecommendationHubs, isRecentlyAddedHub, recommendationHubTitle, recentlyPlayedPlaylists } from "./recommendations";
import { createArtistLookup, resolveTrackArtists, type ArtistLookup } from "./trackArtists";
import { nextTrackSort, sortTracks, type TrackSortKey, type TrackSortState } from "./trackSort";
import type {
  BootstrapResponse,
  BrandPreset,
  CacheStatus,
  LibrarySection,
  LibraryView,
  PlexAccount,
  PlexHub,
  PlexItem,
  PlexItemPage,
  PlexPlaylist,
  PlexServer,
  StreamQuality,
  ThemeMode,
} from "./types";
import { formatDuration, trackAlbum, trackArtist } from "./types";
import { readPersistedPlaybackSession, usePlayer, type PlaybackFailure } from "./usePlayer";
import { detectOutputPlatform, useOutputDevices } from "./useOutputDevices";
import { useLyrics } from "./useLyrics";
import { usePlexLogin } from "./usePlexLogin";
import { BrandIcon } from "./BrandIcon";
import { applyBrandPreset, BRAND_STORAGE_KEY, normalizeBrandPreset, persistBrandPreset, readInitialBrandPreset } from "./brand";
import { GlobalNotificationQueue, useGlobalNotificationQueue } from "./NotificationQueue";
import type { GlobalNotificationLevel } from "./notifications";
import { applyThemeMode, readInitialThemeMode } from "./theme";
import { SharedVolumeControl } from "./VolumeControl";

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
const RouteEntryContext = createContext<RoutePageProps | undefined>(undefined);
const artworkCache = new Map<string, Promise<string>>();
const NOW_PLAYING_MODE_STORAGE_KEY = "cadilume-now-playing-mode";
const PLAYBACK_SETTINGS_ID = "playback-settings";
const ARTIST_TRACK_PAGE_SIZE = 50;
const LIBRARY_TRACK_PAGE_SIZE = 50;
const SOURCE_SYNC_OVERLAY_MINIMUM_MS = 600;
const SIDE_PANEL_MOTION_MS = 220;
type ConnectionKind = "local" | "remote" | "relay" | "disconnected";
type ResolvedTheme = ThemeMode;
type ThemeTransitionOrigin = { x: number; y: number };
type ThemeModeChange = (mode: ThemeMode, origin?: ThemeTransitionOrigin) => void;
type BrandPresetChange = (preset: BrandPreset, origin?: ThemeTransitionOrigin) => Promise<void>;
type AppearanceState = { theme: ThemeMode; brand: BrandPreset };

type MusicPlayer = ReturnType<typeof usePlayer>;
type PlaylistSelection = { tracks: PlexItem[]; label: string };

interface MusicShellRuntime {
  initialSession: BootstrapResponse;
  account: PlexAccount;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  brandPreset: BrandPreset;
  onThemeMode: ThemeModeChange;
  onBrandPreset: BrandPresetChange;
  searchText: string;
  setSearchText: (value: string) => void;
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
  sourceRevision: number;
  playlistMutationRevision: number;
  bumpPlaylistMutation: () => void;
  routeAliveRef: RefObject<KeepAliveRef | null>;
  statusIconEnabled: boolean;
  statusIconPlatform?: BootstrapResponse["statusIconPlatform"];
  statusIconSaving: boolean;
  deviceName: string;
  quality: StreamQuality;
  prebufferNext: boolean;
  cacheStatus?: CacheStatus;
  cacheStatusError?: string;
  cacheBusy: boolean;
  sourcesSyncing: boolean;
  playbackSettingsRequest: number;
  player: MusicPlayer;
  notify: (message: string, level?: GlobalNotificationLevel) => void;
  playRecommendationItem: (item: PlexItem, context: PlexItem[]) => Promise<void>;
  playRecommendationPlaylist: (playlist: PlexPlaylist) => Promise<void>;
  changeStatusIconEnabled: (enabled: boolean) => Promise<void>;
  changeBrandPreset: BrandPresetChange;
  changeDeviceName: (nextDeviceName: string) => Promise<string>;
  changeQuality: (value: StreamQuality) => void;
  setServerId: (value: string) => void;
  setSectionKey: (value: string) => void;
  setPrebufferNext: (value: boolean) => void;
  clearCache: () => Promise<void>;
  syncSources: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshCacheStatus: () => Promise<void>;
  openDeviceNameDialog: () => void;
  openPlaylistCreation: () => void;
  openPlaylistPicker: (tracks: readonly PlexItem[], label?: string) => void;
  setSidePanel: (value: "queue" | "lyrics" | "devices" | null) => void;
  setNowPlayingOpen: (open: boolean) => void;
  setPlaybackSettingsRequest: React.Dispatch<React.SetStateAction<number>>;
}

function useMusicShellRuntime(): MusicShellRuntime {
  const runtime = useContext(MusicShellContext);
  if (!runtime) throw new Error("Cadilume 路由必须位于 MusicShellContext 内。");
  return runtime;
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

function detailTypeForItem(item: PlexItem): LibraryDetailType | undefined {
  if (item.type === "artist") return "artist";
  if (item.type === "album") return "album";
  return undefined;
}

function LibraryPageTitle({ children }: { children: ReactNode }) {
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
  const [error, setError] = useState<string>();
  const syncedBrandSessionRef = useRef<BootstrapResponse | undefined>(undefined);
  const requestedUiPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("ui-preview")
    : null;
  const uiPreview = requestedUiPreview === "login" || requestedUiPreview === "splash" || requestedUiPreview === "notifications"
    ? requestedUiPreview
    : null;

  useEffect(() => {
    if (uiPreview) return;
    void showMainWindow().catch(() => undefined);
  }, [uiPreview]);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setSession(await bootstrap());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!uiPreview) void load();
  }, [load, uiPreview]);

  useLayoutEffect(() => {
    // `syncBrandPreset` changes identity when the user chooses a new preset.
    // Do not let that render replay the original bootstrap value and undo the
    // just-persisted manual choice; each session response is authoritative once.
    if (session === syncedBrandSessionRef.current) return;
    syncedBrandSessionRef.current = session;
    if (session?.brandPreset) syncBrandPreset(session.brandPreset);
  }, [session, syncBrandPreset]);

  if (uiPreview === "splash") return <AppFrame><SplashScreen /></AppFrame>;
  if (uiPreview === "login") {
    return <AppFrame><LoginScreen clientIdentifier="cadilume-development-preview" onAuthenticated={() => undefined} /></AppFrame>;
  }
  if (uiPreview === "notifications") return <AppFrame><NotificationFixture /></AppFrame>;
  if (!session && !error) return <AppFrame><SplashScreen /></AppFrame>;
  if (!session || error) return <AppFrame><FatalError message={error || "无法启动 Cadilume"} retry={load} /></AppFrame>;
  if (!session.authenticated || !session.account) {
    return <AppFrame><LoginScreen clientIdentifier={session.clientIdentifier} onAuthenticated={load} /></AppFrame>;
  }
  return <AppFrame integrated><MusicShell initialSession={session} themeMode={themeMode} resolvedTheme={resolvedTheme} brandPreset={brandPreset} onThemeMode={onThemeMode} onBrandPreset={onBrandPreset} /></AppFrame>;
}

function AppFrame({ children, integrated = false }: { children: ReactNode; integrated?: boolean }) {
  return (
    <div
      className={`app-frame ${integrated ? "is-integrated" : ""}`.trim()}
      data-platform={detectOutputPlatform(navigator)}
    >
      {!integrated && <AppTitlebar />}
      <div className="app-frame-content">{children}</div>
    </div>
  );
}

const NOTIFICATION_FIXTURE_MESSAGES = [
  "资料库同步完成。",
  "已切换为琥珀金。",
  "播放队列已更新。",
  "封面缓存已在后台整理。",
];

function NotificationFixture() {
  const queue = useGlobalNotificationQueue();
  const previewParams = new URLSearchParams(window.location.search);
  const holdTimers = previewParams.get("notification-hold") === "1";
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

  const setQueuePaused = useCallback((paused: boolean) => {
    queue.setPaused(holdTimers || paused);
  }, [holdTimers, queue.setPaused]);
  const addMessages = (count: number) => {
    for (const message of NOTIFICATION_FIXTURE_MESSAGES.slice(0, count)) queue.notify(message, "error");
  };

  return (
    <main className="notification-fixture" data-testid="notification-fixture" data-hold-timers={holdTimers || undefined}>
      <div>
        <p>开发验收</p>
        <h1>通知队列</h1>
      </div>
      <div className="notification-fixture-actions">
        <button type="button" data-testid="notification-fixture-add-one" onClick={() => addMessages(1)}>加入 1 条</button>
        <button type="button" data-testid="notification-fixture-add-three" onClick={() => addMessages(3)}>加入 3 条</button>
        <button type="button" data-testid="notification-fixture-add-four" onClick={() => addMessages(4)}>加入 4 条</button>
        <button type="button" data-testid="notification-fixture-add-long" onClick={() => queue.notify("这是一条用于验证自动换行、堆叠高度、展开列表和关闭按钮可访问名称的较长通知文案。")}>加入长文案</button>
        <button type="button" data-testid="notification-fixture-clear" onClick={queue.clear}>清空</button>
      </div>
      <GlobalNotificationQueue notices={queue.notices} onDismiss={queue.dismiss} onPauseChange={setQueuePaused} />
    </main>
  );
}

function AppTitlebar({ children, inactive = false }: { children?: ReactNode; inactive?: boolean }) {
  return (
    <header
      className={`app-titlebar ${children ? "has-toolbar" : "is-standalone"}`}
      aria-label="Cadilume 顶部工具栏"
      aria-hidden={inactive || undefined}
      inert={inactive || undefined}
    >
      <div className="app-titlebar__drag-region" data-tauri-drag-region aria-hidden="true" />
      <div className="app-titlebar__content">
        <div className="app-titlebar__brand">
          <span className="app-titlebar__brand-mark"><BrandIcon size={17} /></span>
          <strong>Cadilume</strong>
        </div>
        {children && <div className="app-titlebar__toolbar">{children}</div>}
      </div>
    </header>
  );
}

function MusicShell({ initialSession, themeMode, resolvedTheme, brandPreset, onThemeMode, onBrandPreset }: {
  initialSession: BootstrapResponse;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  brandPreset: BrandPreset;
  onThemeMode: ThemeModeChange;
  onBrandPreset: BrandPresetChange;
}) {
  const account = initialSession.account as PlexAccount;
  const [initialPlaybackSession] = useState(() => readPersistedPlaybackSession());
  const [servers, setServers] = useState<PlexServer[]>([]);
  const [serverId, setServerId] = useState<string>();
  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [sectionKey, setSectionKey] = useState<string>();
  const [libraryArtists, setLibraryArtists] = useState<PlexItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [, setLoading] = useState(true);
  const {
    notices,
    notify,
    dismiss: dismissNotification,
    setPaused: setNotificationsPaused,
  } = useGlobalNotificationQueue();
  const [sidePanel, setSidePanel] = useState<"queue" | "lyrics" | "devices" | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMode, setNowPlayingMode] = useState<NowPlayingMode>(readNowPlayingMode);
  const [playlistSelection, setPlaylistSelection] = useState<PlaylistSelection>();
  const [playlistCreationOpen, setPlaylistCreationOpen] = useState(false);
  const [deviceNameDialogOpen, setDeviceNameDialogOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [playlistListLoading, setPlaylistListLoading] = useState(false);
  const [playlistListError, setPlaylistListError] = useState<string>();
  const [statusIconEnabled, setStatusIconEnabled] = useState(initialSession.statusIconEnabled);
  const [statusIconSaving, setStatusIconSaving] = useState(false);
  const [deviceName, setDeviceName] = useState(initialSession.deviceName);
  const [quality, setQuality] = useState<StreamQuality>(() => readStoredQuality(initialPlaybackSession?.quality));
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>();
  const [cacheStatusError, setCacheStatusError] = useState<string>();
  const [cacheBusy, setCacheBusy] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const routeAliveRef = useKeepAliveRef();
  const [routeCacheEpoch, setRouteCacheEpoch] = useState(0);
  const [sourcesSyncing, setSourcesSyncing] = useState(false);
  const [playlistMutationRevision, setPlaylistMutationRevision] = useState(0);
  const bumpPlaylistMutation = useCallback(() => {
    setPlaylistMutationRevision((revision) => revision + 1);
  }, []);
  const [connectionAvailable, setConnectionAvailable] = useState(false);
  const [playbackSettingsRequest, setPlaybackSettingsRequest] = useState(0);
  const [playbackFailurePreview, setPlaybackFailurePreview] = useState<PlaybackFailure>();
  const nowPlayingTriggerRef = useRef<HTMLButtonElement>(null);
  const playlistListRequestRef = useRef(0);
  const artistDirectoryRequestRef = useRef(0);
  const cacheStatusRequestRef = useRef(0);
  const previousRouteCacheContextRef = useRef<{ serverId: string; sectionKey: string } | undefined>(undefined);
  const deferredQueueOpenTimerRef = useRef<number | undefined>(undefined);
  const preferredPlaybackServerId = initialPlaybackSession?.serverId;
  const player = usePlayer(serverId, quality);
  const outputDevices = useOutputDevices(player.setOutputSinkId);
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
  }, [sectionKey, serverId, sourceRevision]);

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
      setServers(result);
      setConnectionAvailable(result.length > 0);
      setServerId((current) => {
        if (result.some((server) => server.id === current)) return current;
        if (result.some((server) => server.id === preferredPlaybackServerId)) return preferredPlaybackServerId;
        return result[0]?.id;
      });
      if (refreshDependents) setSourceRevision((revision) => revision + 1);
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

  useEffect(() => { void loadServers(); }, [loadServers]);

  useEffect(() => {
    if (!serverId) return;
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
  }, [notify, serverId, sourceRevision]);

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
        const ordered = [...result].sort((left, right) => {
          const leftTime = left.addedAt ?? left.updatedAt ?? 0;
          const rightTime = right.addedAt ?? right.updatedAt ?? 0;
          return rightTime - leftTime;
        });
        setPlaylists(ordered);
        if (announce) notify(result.length ? `歌单已刷新，共 ${result.length} 个。` : "歌单已刷新，当前没有可显示的音乐歌单。", "success");
      }
    } catch (reason) {
      if (playlistListRequestRef.current === requestId) {
        const message = playlistReadErrorMessage(reason);
        setPlaylists([]);
        setPlaylistListError(message);
        if (announce) notify(message, "error");
      }
    } finally {
      if (playlistListRequestRef.current === requestId) setPlaylistListLoading(false);
    }
  }, [notify, serverId]);

  useEffect(() => {
    void loadPlaylistList();
  }, [loadPlaylistList, sourceRevision]);

  const syncSources = async () => {
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

      setConnectionAvailable(true);
      setServers(refreshedServers);
      setServerId(refreshedServer.id);
      setSections(refreshedSections);
      setSectionKey(refreshedSection?.key);
      setPlaylists(refreshedPlaylists);
      artistDirectoryRequestRef.current += 1;
      setLibraryArtists(refreshedArtists);
      setSourceRevision((revision) => revision + 1);
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
  };

  const refreshCacheStatus = useCallback(async () => {
    const requestId = ++cacheStatusRequestRef.current;
    setCacheStatusError(undefined);
    try {
      const status = await getCacheStatus();
      if (cacheStatusRequestRef.current === requestId) setCacheStatus(status);
    } catch (reason) {
      if (cacheStatusRequestRef.current !== requestId) return;
      setCacheStatus(undefined);
      setCacheStatusError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const changeStatusIconEnabled = async (enabled: boolean) => {
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
  };

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

  const changeQuality = (value: StreamQuality) => {
    setQuality(value);
    try {
      localStorage.setItem("cadilume-quality", value);
    } catch {
      // Keep the in-memory preference when storage is restricted.
    }
  };

  const clearCache = async () => {
    cacheStatusRequestRef.current += 1;
    setCacheBusy(true);
    setCacheStatusError(undefined);
    try {
      setCacheStatus(await clearArtworkCache());
      artworkCache.clear();
      notify("封面磁盘缓存已清理；当前页面已显示的封面会保留到下次加载。");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setCacheStatusError(message);
      notify(message, "error");
    } finally {
      setCacheBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await logout();
      await routeAliveRef.current?.destroyAll();
      player.discardPlaybackSession();
      artworkCache.clear();
      window.location.reload();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), "error");
    }
  };

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
  }, [notify, player, serverId]);

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
  }, [notify, player, serverId]);

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

  const runtime: MusicShellRuntime = {
    initialSession,
    account,
    themeMode,
    resolvedTheme,
    brandPreset,
    onThemeMode,
    onBrandPreset,
    searchText,
    setSearchText,
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
    sourceRevision,
    playlistMutationRevision,
    bumpPlaylistMutation,
    routeAliveRef,
    statusIconEnabled,
    statusIconPlatform: initialSession.statusIconPlatform,
    statusIconSaving,
    deviceName,
    quality,
    prebufferNext: player.prebufferNext,
    cacheStatus,
    cacheStatusError,
    cacheBusy,
    sourcesSyncing,
    playbackSettingsRequest,
    player,
    notify,
    playRecommendationItem,
    playRecommendationPlaylist,
    changeStatusIconEnabled,
    changeBrandPreset,
    changeDeviceName,
    changeQuality,
    setServerId,
    setSectionKey,
    setPrebufferNext: player.setPrebufferNext,
    clearCache,
    syncSources,
    signOut,
    refreshCacheStatus,
    openDeviceNameDialog: () => setDeviceNameDialogOpen(true),
    openPlaylistCreation: () => {
      if (!serverId) {
        notify("请先在设置中选择音乐服务器。");
        return;
      }
      setSidePanel(null);
      setPlaylistSelection(undefined);
      setPlaylistCreationOpen(true);
    },
    openPlaylistPicker,
    setSidePanel,
    setNowPlayingOpen,
    setPlaybackSettingsRequest,
  };

  return (
    <ArtworkServerContext.Provider value={serverId}>
    <MusicShellContext.Provider value={runtime}>
    <div className="app-shell">
      <RouterProvider key={`route-cache-${routeCacheEpoch}`} router={router} />

      {queuePanelMounted && (
        <div className={`queue-panel-layer ${queuePanelOpen ? "is-open" : "is-closing"}`} aria-hidden={!queuePanelOpen || undefined}>
          <button className="queue-panel-scrim" type="button" aria-label="点击空白处关闭播放队列" onClick={closeQueuePanel} />
          <QueuePanel
            open={queuePanelOpen}
            queue={player.queue}
            currentIndex={player.currentIndex}
            onSelect={playQueuedTrack}
            onRemove={removeQueuedTrack}
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

      {sidePanel === "devices" && (
        <DevicesPanel
          output={outputDevices}
          onClose={() => setSidePanel(null)}
        />
      )}

      <NowPlayingView
        open={expandedPlayerOpen}
        mode={nowPlayingMode}
        onModeChange={changeNowPlayingMode}
        track={player.current}
        playing={player.playing}
        loading={playbackLoading}
        buffering={player.buffering}
        artwork={<Artwork item={player.current} size="immersive" />}
        progressSeconds={player.progress}
        durationSeconds={player.duration}
        shuffle={player.shuffle}
        repeat={player.repeat}
        muted={player.muted}
        volume={player.volume}
        lyrics={nowPlayingLyrics}
        queueOpen={queuePanelOpen}
        queueAvailable={hasQueue}
        theme={themeMode}
        headerActions={(
          <div className="now-playing-header-status-actions" role="group" aria-label="外观与连接状态">
            <ConnectionIndicator server={selectedServer} connected={connectionAvailable} />
            <ThemeCycleButton resolvedTheme={resolvedTheme} onChange={onThemeMode} />
          </div>
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
        devicesOpen={sidePanel === "devices"}
        outputPlatform={outputDevices.platform}
        canOpenNowPlaying={hasCurrentTrack}
        canToggleQueue={hasQueue}
        canToggleLyrics={canToggleLyrics}
        onOpenNowPlaying={() => {
          if (!player.current) return;
          cancelDeferredQueueOpen();
          setSidePanel((value) => value === "lyrics" || value === "devices" ? null : value);
          setPlaylistSelection(undefined);
          setNowPlayingOpen(true);
        }}
        onToggleQueue={toggleQueuePanel}
        onToggleLyrics={toggleLyricsPanel}
        onAddToPlaylist={openCurrentTrackPlaylistPicker}
        onOutputAction={() => {
          cancelDeferredQueueOpen();
          setNowPlayingOpen(false);
          setPlaylistSelection(undefined);
          setSidePanel((value) => value === "devices" ? null : "devices");
        }}
      />

      {sourcesSyncing && <SourceSyncOverlay />}
      <GlobalNotificationQueue
        notices={notices}
        onDismiss={dismissNotification}
        onPauseChange={setNotificationsPaused}
      />
    </div>
    </MusicShellContext.Provider>
    </ArtworkServerContext.Provider>
  );
}

function createCadilumeRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <MusicRouterLayout />,
      children: [
        { index: true, element: <RoutePage /> },
        { path: "home", element: <RoutePage /> },
        { path: "albums", element: <RoutePage /> },
        { path: "albums/:ratingKey", element: <RoutePage /> },
        { path: "artists", element: <RoutePage /> },
        { path: "artists/:ratingKey", element: <RoutePage /> },
        { path: "tracks", element: <RoutePage /> },
        { path: "playlists/:ratingKey", element: <RoutePage /> },
        { path: "search", element: <RoutePage /> },
        { path: "settings", element: <RoutePage /> },
        { path: "*", element: <Navigate to="/home" replace /> },
      ],
    },
  ]);
}

function useRouterRoute(): LibraryRoute {
  const location = useLocation();
  return useMemo(() => parseLibraryRoute(`${location.pathname}${location.search}`), [location.pathname, location.search]);
}

function useCadilumeNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback((route: LibraryRoute, options: { replace?: boolean } = {}) => {
    navigate(routePath(route), {
      replace: options.replace,
      state: createCadilumeEntryState(location.state, {
        parentEntryId: options.replace ? routeParentEntryId(location.state) : routeEntryId(location),
        route,
      }),
    });
  }, [location.key, location.state, navigate]);
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

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = runtime.searchText.trim();
    if (!query) {
      runtime.notify("搜索内容不能为空", "warning");
      return;
    }
    navigateRoute({ view: "search", query });
  };

  const selectedPlaylistId = route.detail?.type === "playlist" ? route.detail.ratingKey : undefined;
  const activeView = selectedPlaylistId ? undefined : route.view;

  const openPlaylist = (playlist: PlexPlaylist) => {
    if (selectedPlaylistId === playlist.ratingKey) return;
    navigateRoute(libraryDetailRoute("playlist", playlist.ratingKey));
  };

  return (
    <>
      <AppTitlebar inactive={runtime.expandedPlayerOpen}>
        <form className="searchbox" onSubmit={submitSearch} role="search">
          <Search size={17} />
          <input value={runtime.searchText} onChange={(event) => runtime.setSearchText(event.target.value)} placeholder="搜索歌曲、专辑或歌手" aria-label="搜索资料库" />
          {runtime.searchText && (
            <button type="button" className="searchbox-clear" aria-label="清除搜索" onClick={() => runtime.setSearchText("")}>
              <X size={15} />
            </button>
          )}
        </form>
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

type RouteLocationSnapshot = Pick<ReturnType<typeof useLocation>, "key" | "pathname" | "search" | "state">;
type RouteNavigate = (route: LibraryRoute, options?: { replace?: boolean }) => void;

interface RoutePageProps {
  route: LibraryRoute;
  entryLocation: RouteLocationSnapshot;
  onNavigate: RouteNavigate;
  onBack: () => void;
}

function useRouteEntry(): RoutePageProps {
  const entry = useContext(RouteEntryContext);
  if (!entry) throw new Error("Cadilume 路由页缺少 History entry 上下文。");
  return entry;
}

function RouteKeepAliveHost({ location, aliveRef }: { location: ReturnType<typeof useLocation>; aliveRef: RefObject<KeepAliveRef | null> }) {
  const activeCacheKey = historyEntryCacheKey(location.key);
  const navigate = useNavigate();
  const outlet = useOutlet();
  const route = useMemo(() => parseLibraryRoute(`${location.pathname}${location.search}`), [location.pathname, location.search]);
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
    <div ref={pageRef} className={`route-page-scroll ${route.view === "tracks" ? "is-track-workspace" : ""}`.trim()} data-route-entry={cacheKey}>{children}</div>
    {active && showBackToTop && (
      <button className="route-back-to-top" type="button" aria-label="回到顶部" data-tooltip="回到顶部" title="回到顶部" onClick={scrollToRouteTop}>
        <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
      </button>
    )}
  </>;
}

function RoutePage() {
  const entryRef = useRef(useRouteEntry());
  const { route, entryLocation, onNavigate, onBack } = entryRef.current;
  const runtime = useMusicShellRuntime();
  const [items, setItems] = useState<PlexItem[]>([]);
  const [homeHubs, setHomeHubs] = useState<PlexHub[]>([]);
  const [searchHubs, setSearchHubs] = useState<PlexHub[]>([]);
  const [detail, setDetail] = useState<{ source: PlexItem; children: PlexItem[] }>();
  const [playlist, setPlaylist] = useState<PlexPlaylist>();
  const [playlistItems, setPlaylistItems] = useState<PlexItem[]>([]);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistError, setPlaylistError] = useState<string>();
  const [playlistRetryRequest, setPlaylistRetryRequest] = useState(0);
  const [loading, setLoading] = useState(route.view !== "settings" && route.view !== "tracks");
  const requestRef = useRef(0);
  const query = route.query || "";
  const view = route.view;

  const closeDetail = useCallback(() => {
    const state = entryLocation.state && typeof entryLocation.state === "object" ? entryLocation.state as Record<string, unknown> : undefined;
    if (state?.cadilumeParentEntryId) {
      onBack();
      return;
    }
    onNavigate({ view: route.detail?.type === "playlist" ? "home" : route.view }, { replace: true });
  }, [entryLocation.state, onBack, onNavigate, route.detail?.type, route.view]);

  const navigateToDetail = useCallback((type: LibraryDetailType, ratingKey: string) => {
    if (isCurrentLibraryDetailRoute(route, type, ratingKey)) return;
    onNavigate(libraryDetailRoute(type, ratingKey));
  }, [onNavigate, route]);

  const openItem = useCallback((item: PlexItem) => {
    if (item.type === "track") {
      runtime.player.playContext(item, items);
      return;
    }
    const detailType = detailTypeForItem(item);
    if (detailType) navigateToDetail(detailType, item.ratingKey);
  }, [items, navigateToDetail, runtime.player]);

  const openTrackArtist = useCallback((artist: PlexItem) => {
    if (artist.type === "artist") navigateToDetail("artist", artist.ratingKey);
  }, [navigateToDetail]);

  const openTrackAlbum = useCallback((track: PlexItem) => {
    const albumRatingKey = track.parentRatingKey?.trim();
    if (!albumRatingKey) return;
    navigateToDetail("album", albumRatingKey);
  }, [navigateToDetail]);

  const openPlaylist = useCallback((nextPlaylist: PlexPlaylist) => {
    navigateToDetail("playlist", nextPlaylist.ratingKey);
  }, [navigateToDetail]);

  const shuffleContext = useCallback((context: readonly PlexItem[]) => {
    const selection = selectRandomContextPlayback(context);
    if (!selection) return;
    runtime.player.playContext(selection.current, selection.queue);
    runtime.player.setShuffle(true);
  }, [runtime.player]);

  const playDetail = useCallback(() => {
    const tracks = detail?.children.filter((item) => item.type === "track") || [];
    if (!tracks[0]) return;
    runtime.player.playContext(tracks[0], tracks);
    runtime.player.setShuffle(false);
  }, [detail?.children, runtime.player]);

  const playPlaylist = useCallback(() => {
    const tracks = playlistItems.filter((item) => item.type === "track");
    if (!tracks[0]) return;
    runtime.player.playContext(tracks[0], tracks);
    runtime.player.setShuffle(false);
  }, [playlistItems, runtime.player]);

  const removePlaylistTrack = useCallback(async (track: PlexItem) => {
    if (!runtime.serverId || !playlist || !canWritePlaylist(playlist)) {
      runtime.notify("这个歌单不可编辑。");
      return;
    }
    const playlistItemId = track.playlistItemID;
    if (!playlistItemId) {
      runtime.notify("这首歌曲缺少歌单项标识，无法从歌单移除。");
      return;
    }
    try {
      const result = await removeTracksFromPlaylist(runtime.serverId, playlist.ratingKey, [playlistItemId]);
      if (result.removed > 0) {
        setPlaylistItems((current) => current.filter((item) => item.playlistItemID !== playlistItemId));
        runtime.notify(`已从歌单移除《${track.title}》。`, "success");
        void runtime.loadPlaylistList();
      } else {
        runtime.notify("没有从歌单移除任何歌曲，请刷新后重试。");
      }
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : String(reason), "error");
    }
  }, [playlist, runtime]);

  const handleRouteChange = useCallback((nextRoute: LibraryRoute) => {
    onNavigate(nextRoute);
  }, [onNavigate]);

  useEffect(() => {
    if (view === "search") runtime.setSearchText(query);
  }, [query, runtime.setSearchText, view]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(view !== "settings" && view !== "tracks");
    setPlaylist(undefined);
    setPlaylistItems([]);
    setPlaylistError(undefined);
    setDetail(undefined);
    if (view === "settings") {
      void runtime.refreshCacheStatus();
      setLoading(false);
      return;
    }
    if (view === "tracks") {
      setLoading(false);
      return;
    }
    if (!runtime.serverId || !runtime.sectionKey) {
      setItems([]);
      setHomeHubs([]);
      setSearchHubs([]);
      setLoading(false);
      return;
    }
    const load = async () => {
      let playlistCandidate: PlexPlaylist | undefined;
      try {
        if (route.detail?.type === "playlist") {
          setPlaylistLoading(true);
          const catalog = await getPlaylists(runtime.serverId as string);
          const found = catalog.find((candidate) => candidate.ratingKey === route.detail?.ratingKey);
          if (!found) throw new Error("这个歌单已不存在或当前账号没有访问权限。");
          playlistCandidate = found;
          if (requestRef.current !== requestId) return;
          setPlaylist(found);
          const tracks = await getPlaylistItems(runtime.serverId as string, found.ratingKey);
          if (requestRef.current !== requestId) return;
          setPlaylist(found);
          setPlaylistItems(tracks);
          setPlaylistLoading(false);
          setLoading(false);
          return;
        }
        if (route.detail) {
          const source = await getLibraryMetadata(runtime.serverId as string, route.detail.ratingKey);
          if (source.type !== route.detail.type) throw new Error("该链接指向的媒体类型与目标页面不匹配。");
          const children = await getChildren(runtime.serverId as string, route.detail.ratingKey);
          if (requestRef.current !== requestId) return;
          setDetail({ source, children });
          setLoading(false);
          return;
        }
        if (view === "home") {
          const [hubs, recentAlbums] = await Promise.all([
            getRecommendationHubs(runtime.serverId as string, runtime.sectionKey as string),
            getRecentAlbums(runtime.serverId as string, runtime.sectionKey as string),
          ]);
          const completeHubs = hubs.some(isRecentlyAddedHub) || !recentAlbums.length
            ? hubs
            : [...hubs, { title: "最近加入的音乐", type: "album", identifier: "cadilume.recentlyadded", items: recentAlbums }];
          if (requestRef.current !== requestId) return;
          setItems(recentAlbums);
          setHomeHubs(homeRecommendationHubs(completeHubs));
        } else if (view === "albums" || view === "artists") {
          const result = await getLibraryItems(runtime.serverId as string, runtime.sectionKey as string, view === "artists" ? 8 : 9);
          if (requestRef.current !== requestId) return;
          setItems(result);
        } else if (view === "search") {
          if (!query) setSearchHubs([]);
          else setSearchHubs(await searchLibrary(runtime.serverId as string, runtime.sectionKey as string, query));
        }
      } catch (reason) {
        if (requestRef.current !== requestId) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        if (route.detail?.type === "playlist" && playlistCandidate) {
          setPlaylist(playlistCandidate);
          setPlaylistItems([]);
          setPlaylistError(message);
          return;
        }
        runtime.notify(message, "error");
        if (route.detail) {
          onNavigate({ view: route.detail.type === "playlist" ? "home" : route.detail.type === "artist" ? "artists" : "albums" }, { replace: true });
        }
        setItems([]);
        setHomeHubs([]);
        setSearchHubs([]);
      } finally {
        if (requestRef.current === requestId) {
          setPlaylistLoading(false);
          setLoading(false);
        }
      }
    };
    void load();
    return () => { requestRef.current += 1; };
  }, [onNavigate, playlistRetryRequest, query, route.detail, runtime.notify, runtime.playlistMutationRevision, runtime.refreshCacheStatus, runtime.sectionKey, runtime.serverId, runtime.sourceRevision, view]);

  const content = playlist ? (
    <PlaylistDetailView
      playlist={playlist}
      tracks={playlistItems}
      artists={runtime.libraryArtists}
      loading={playlistLoading}
      error={playlistError}
      onRetry={() => setPlaylistRetryRequest((request) => request + 1)}
      onPlay={playPlaylist}
      onShuffle={() => shuffleContext(playlistItems)}
      onPlayTrack={(track, context) => runtime.player.playContext(track, context)}
      onRemoveTrack={removePlaylistTrack}
      onOpenArtist={openTrackArtist}
      onOpenAlbum={openTrackAlbum}
    />
  ) : loading && view !== "search" ? <LoadingState /> : (
    <ContentView
      view={view}
      route={route}
      loading={loading}
      items={items}
      artists={runtime.libraryArtists}
      homeHubs={homeHubs}
      hubs={searchHubs}
      searchText={query}
      detail={detail}
      account={runtime.account}
      servers={runtime.servers}
      serverId={runtime.serverId}
      server={runtime.selectedServer}
      sections={runtime.sections}
      sectionKey={runtime.sectionKey}
      section={runtime.selectedSection}
      statusIconEnabled={runtime.statusIconEnabled}
      statusIconPlatform={runtime.statusIconPlatform}
      statusIconSaving={runtime.statusIconSaving}
      brandPreset={runtime.brandPreset}
      deviceName={runtime.deviceName}
      quality={runtime.quality}
      prebufferNext={runtime.prebufferNext}
      cacheStatus={runtime.cacheStatus}
      cacheStatusError={runtime.cacheStatusError}
      cacheBusy={runtime.cacheBusy}
      sourcesSyncing={runtime.sourcesSyncing}
      playlists={runtime.playlists}
      onOpen={openItem}
      onTracksRouteChange={handleRouteChange}
      onOpenArtist={openTrackArtist}
      onOpenAlbum={openTrackAlbum}
      onOpenPlaylist={openPlaylist}
      onPlayRecommendationItem={runtime.playRecommendationItem}
      onPlayRecommendationPlaylist={runtime.playRecommendationPlaylist}
      onBack={closeDetail}
      onPlayDetail={playDetail}
      onShuffleDetail={() => shuffleContext(detail?.children || [])}
      onPlayTrack={(track, context) => runtime.player.playContext(track, context)}
      onStatusIconEnabled={runtime.changeStatusIconEnabled}
      onBrandPreset={runtime.changeBrandPreset}
      onEditDeviceName={runtime.openDeviceNameDialog}
      onQuality={runtime.changeQuality}
      onServerChange={runtime.setServerId}
      onSectionChange={runtime.setSectionKey}
      onPrebufferNext={runtime.setPrebufferNext}
      onClearCache={() => void runtime.clearCache()}
      onSyncSources={() => void runtime.syncSources()}
      onLogout={runtime.signOut}
    />
  );

  return <>{content}</>;
}

interface ContentViewProps {
  view: LibraryView;
  route: LibraryRoute;
  loading: boolean;
  items: PlexItem[];
  artists: PlexItem[];
  homeHubs: PlexHub[];
  hubs: PlexHub[];
  searchText: string;
  detail?: { source: PlexItem; children: PlexItem[] };
  account: PlexAccount;
  servers: PlexServer[];
  serverId?: string;
  server?: PlexServer;
  sections: LibrarySection[];
  sectionKey?: string;
  section?: LibrarySection;
  statusIconEnabled: boolean;
  statusIconPlatform?: BootstrapResponse["statusIconPlatform"];
  statusIconSaving: boolean;
  brandPreset: BrandPreset;
  deviceName: string;
  quality: StreamQuality;
  prebufferNext: boolean;
  cacheStatus?: CacheStatus;
  cacheStatusError?: string;
  cacheBusy: boolean;
  sourcesSyncing: boolean;
  playlists: PlexPlaylist[];
  onOpen: (item: PlexItem) => void;
  onTracksRouteChange: (route: LibraryRoute) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onOpenPlaylist: (playlist: PlexPlaylist) => void;
  onPlayRecommendationItem: (item: PlexItem, context: PlexItem[]) => Promise<void>;
  onPlayRecommendationPlaylist: (playlist: PlexPlaylist) => Promise<void>;
  onBack: () => void;
  onPlayDetail: () => void;
  onShuffleDetail: () => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
  onStatusIconEnabled: (enabled: boolean) => void;
  onBrandPreset: BrandPresetChange;
  onEditDeviceName: () => void;
  onQuality: (value: StreamQuality) => void;
  onServerChange: (value: string) => void;
  onSectionChange: (value: string) => void;
  onPrebufferNext: (value: boolean) => void;
  onClearCache: () => void;
  onSyncSources: () => void;
  onLogout: () => void;
}

function PlaylistKindIcons({ playlist, className = "" }: { playlist: PlexPlaylist; className?: string }) {
  const KindIcon = playlist.smart ? Sparkles : ListMusic;
  return (
    <span className={`playlist-kind-icons ${className}`.trim()}>
      <span className="playlist-kind-icon" role="img" aria-label={playlist.smart ? "智能歌单" : "普通歌单"}>
        <KindIcon size={13} strokeWidth={1.9} aria-hidden="true" />
      </span>
      {playlist.readOnly && (
        <span className="playlist-kind-icon" role="img" aria-label="只读">
          <LockKeyhole size={12} strokeWidth={1.9} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

function PlaylistSidebar({ playlists, selectedId, loading, error, onOpen, onRetry, onCreate }: {
  playlists: PlexPlaylist[];
  selectedId?: string;
  loading: boolean;
  error?: string;
  onOpen: (playlist: PlexPlaylist) => void;
  onRetry: () => void;
  onCreate: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <nav className={`sidebar-playlists ${collapsed ? "is-collapsed" : ""}`} aria-label="歌单">
      <div className="sidebar-playlists-toolbar">
        <button className="sidebar-playlists-heading" type="button" aria-expanded={!collapsed} aria-controls="sidebar-playlist-list" onClick={() => setCollapsed((value) => !value)}>
          <span>歌单</span>
          <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <button className="sidebar-playlists-create" type="button" aria-label="新建歌单" data-tooltip="新建歌单" title="新建歌单" onClick={onCreate}>
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div id="sidebar-playlist-list" className="sidebar-playlist-list" aria-busy={loading || undefined} hidden={collapsed}>
        {loading ? (
          <div className="sidebar-playlist-state" role="status"><LoaderCircle className="spin" size={17} /><span>正在同步歌单…</span></div>
        ) : error ? (
          <div className="sidebar-playlist-state is-error" role="alert"><span>歌单读取失败</span><button type="button" onClick={onRetry}>重试</button></div>
        ) : !playlists.length ? (
          <div className="sidebar-playlist-state"><ListMusic size={18} /><span>暂无音乐歌单</span></div>
        ) : playlists.map((playlist) => {
          const capability = [playlist.smart ? "智能" : "普通", playlist.readOnly ? "只读" : undefined].filter(Boolean).join(" · ");
          const active = selectedId === playlist.ratingKey;
          return (
            <button
              type="button"
              className={`sidebar-playlist-item ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={`${playlist.title}，${capability}歌单`}
              title={playlist.title}
              key={playlist.ratingKey}
              onClick={() => onOpen(playlist)}
            >
              <Artwork item={playlist} size="small" className="sidebar-playlist-artwork" />
              <span>
                <strong>{playlist.title}</strong>
                <small className="sidebar-playlist-meta"><PlaylistKindIcons playlist={playlist} /><span>{playlist.leafCount ?? 0} 首</span></small>
              </span>
              <span className="sidebar-playlist-selected-dot" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function ContentView(props: ContentViewProps) {
  if (props.view === "settings") return <SettingsView {...props} />;
  if (props.detail) return <DetailView detail={props.detail} serverId={props.serverId} artists={props.artists} onBack={props.onBack} onPlay={props.onPlayDetail} onShuffle={props.onShuffleDetail} onOpen={props.onOpen} onOpenArtist={props.onOpenArtist} onOpenAlbum={props.onOpenAlbum} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "search") return <SearchResults hubs={props.hubs} query={props.searchText} loading={props.loading} artists={props.artists} onOpen={props.onOpen} onOpenArtist={props.onOpenArtist} onOpenAlbum={props.onOpenAlbum} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "tracks") return <PaginatedTracksView serverId={props.serverId} sectionKey={props.sectionKey} route={props.route} artists={props.artists} onRouteChange={props.onTracksRouteChange} onOpenArtist={props.onOpenArtist} onOpenAlbum={props.onOpenAlbum} onPlay={props.onPlayTrack} />;
  if (props.view === "artists") return <CardCollection title="歌手" items={props.items} artistGrid indexed onOpen={props.onOpen} />;
  if (props.view === "albums") return <CardCollection title="专辑" items={props.items} indexed onOpen={props.onOpen} />;
  return (
    <RecommendationsView
      hubs={props.homeHubs}
      playlists={props.playlists}
      onPlayItem={props.onPlayRecommendationItem}
      onPlayPlaylist={props.onPlayRecommendationPlaylist}
    />
  );
}

function ConnectionIndicator({ server, connected, kindOverride }: { server?: PlexServer; connected: boolean; kindOverride?: ConnectionKind }) {
  const kind = kindOverride ?? (!server || !connected ? "disconnected" : server.local ? "local" : server.relay ? "relay" : "remote");
  const label = kind === "local" ? "本地直连" : kind === "remote" ? "远程直连" : kind === "relay" ? "Plex Relay" : "连接已断开";
  const StatusIcon = kind === "local" ? Cable : kind === "remote" ? Globe2 : kind === "relay" ? Cloud : WifiOff;
  return (
    <span className="connection-tooltip-anchor">
      <span className="connection-indicator" data-connection={kind} role="status" tabIndex={0} aria-label={`连接状态：${label}`} aria-describedby="connection-status-tooltip">
        <StatusIcon size={17} strokeWidth={1.9} aria-hidden="true" />
      </span>
      <span id="connection-status-tooltip" className="connection-tooltip" role="tooltip">{label}</span>
    </span>
  );
}

function RecommendationsView({
  hubs,
  playlists,
  onPlayItem,
  onPlayPlaylist,
}: {
  hubs: PlexHub[];
  playlists: PlexPlaylist[];
  onPlayItem: (item: PlexItem, context: PlexItem[]) => Promise<void>;
  onPlayPlaylist: (playlist: PlexPlaylist) => Promise<void>;
}) {
  const [pendingKey, setPendingKey] = useState<string>();
  const recentPlaylists = recentlyPlayedPlaylists(playlists);
  const orderedHubs = homeRecommendationHubs(hubs);
  const runPlayback = async (key: string, action: () => Promise<void>) => {
    if (pendingKey) return;
    setPendingKey(key);
    try {
      await action();
    } catch {
      // The app-level callback already reports a scoped global toast.
    } finally {
      setPendingKey(undefined);
    }
  };
  return (
    <section className="recommendations-page">
      <div className="page-heading sticky-page-heading"><LibraryPageTitle>推荐</LibraryPageTitle></div>
      {!recentPlaylists.length && !orderedHubs.length ? (
        <EmptyState title="还没有推荐内容" description="开始播放音乐后，这里会显示最近播放和服务器推荐。" icon={<Music2 size={28} />} />
      ) : (
        <div className="recommendation-sections">
          {recentPlaylists.length > 0 && (
            <section className="recommendation-section" aria-labelledby="recent-playlists-heading">
              <div className="section-heading"><h2 id="recent-playlists-heading">最近播放的歌单</h2></div>
              <div className="recommendation-row card-grid" role="list">
                {recentPlaylists.map((playlist) => {
                  const key = `playlist-${playlist.ratingKey}`;
                  const pending = pendingKey === key;
                  return (
                  <button
                    className={`recommendation-card media-card ${pending ? "is-loading" : ""}`}
                    type="button"
                    role="listitem"
                    key={playlist.ratingKey}
                    aria-label={`播放歌单“${playlist.title}”`}
                    aria-busy={pending || undefined}
                    disabled={pending}
                    onClick={() => void runPlayback(key, () => onPlayPlaylist(playlist))}
                  >
                    <span className="recommendation-artwork">
                      <Artwork item={playlist} size="large" />
                      <span className="recommendation-play-indicator" aria-hidden="true">{pending ? <LoaderCircle className="spin" size={21} /> : <Play size={22} fill="currentColor" />}</span>
                    </span>
                    <strong>{playlist.title}</strong>
                    <small className="recommendation-card-meta"><PlaylistKindIcons playlist={playlist} /><span>{playlist.leafCount ?? 0} 首歌曲</span></small>
                  </button>
                  );
                })}
              </div>
            </section>
          )}
          {orderedHubs.map((hub, hubIndex) => (
            <section className="recommendation-section" aria-labelledby={`recommendation-hub-${hubIndex}`} key={`${hub.identifier || hub.title}-${hubIndex}`}>
              <div className="section-heading"><h2 id={`recommendation-hub-${hubIndex}`}>{recommendationHubTitle(hub)}</h2></div>
              <div className="recommendation-row card-grid" role="list">
                {hub.items.map((item, itemIndex) => {
                  const key = `hub-${hubIndex}-${item.ratingKey}-${itemIndex}`;
                  const pending = pendingKey === key;
                  return (
                  <button
                    className={`recommendation-card media-card ${pending ? "is-loading" : ""}`}
                    type="button"
                    role="listitem"
                    key={`${item.ratingKey}-${itemIndex}`}
                    aria-label={`播放“${item.title}”`}
                    aria-busy={pending || undefined}
                    disabled={pending}
                    onClick={() => void runPlayback(key, () => onPlayItem(item, hub.items))}
                  >
                    <span className={`recommendation-artwork ${item.type === "artist" ? "is-round" : ""}`}>
                      <Artwork item={item} className={item.type === "artist" ? "round" : ""} size="large" />
                      <span className="recommendation-play-indicator" aria-hidden="true">{pending ? <LoaderCircle className="spin" size={21} /> : <Play size={22} fill="currentColor" />}</span>
                    </span>
                    <strong>{item.title}</strong>
                    <small>{item.type === "track" ? trackArtist(item) : item.parentTitle || (item.type === "artist" ? "歌手" : item.year || "专辑")}</small>
                  </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function PlaylistDetailView({ playlist, tracks, artists, loading, error, onRetry, onPlay, onShuffle, onPlayTrack, onRemoveTrack, onOpenArtist, onOpenAlbum }: {
  playlist: PlexPlaylist;
  tracks: PlexItem[];
  artists: PlexItem[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onPlay: () => void;
  onShuffle: () => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
  onRemoveTrack: (track: PlexItem) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
}) {
  const trackCount = loading ? playlist.leafCount ?? 0 : tracks.length;
  const removable = canWritePlaylist(playlist);
  return (
    <section className="detail-page playlist-detail-page">
      <header className="detail-hero playlist-detail-hero">
        <Artwork item={playlist} size="hero" />
        <div className="playlist-detail-copy">
          <h1>{playlist.title}</h1>
          <p className="playlist-detail-meta"><PlaylistKindIcons playlist={playlist} /><span>歌单 · {trackCount} 首歌曲</span></p>
          {playlist.summary && <p className="playlist-detail-summary">{playlist.summary}</p>}
          <div className="detail-actions">
            <button className="primary-button" type="button" disabled={loading || Boolean(error) || !tracks.length} onClick={onPlay}><Play size={17} fill="currentColor" />播放全部</button>
            <IconButton className="playlist-action-button" label="随机播放" disabled={loading || Boolean(error) || !tracks.length} onClick={onShuffle}><Shuffle size={18} aria-hidden="true" /></IconButton>
          </div>
        </div>
      </header>
      {loading ? (
        <div className="playlist-detail-state" role="status"><LoaderCircle className="spin" size={22} /><span>正在读取歌单曲目…</span></div>
      ) : error ? (
        <div className="playlist-detail-state is-error" role="alert"><TriangleAlert size={24} /><strong>无法读取这个歌单</strong><span>{error}</span><button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={15} />重试</button></div>
      ) : tracks.length ? (
        <TrackTable title="曲目" tracks={tracks} artists={artists} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlayTrack} onRemoveTrack={removable ? onRemoveTrack : undefined} />
      ) : <EmptyState title="这个歌单还没有歌曲" description={playlist.smart ? "Plex 当前没有返回符合条件的曲目。" : "可以稍后从歌曲菜单向可写歌单添加内容。"} icon={<ListMusic size={28} />} />}
    </section>
  );
}

function CardCollection({ title, items, round = false, compact = false, artistGrid = false, indexed = false, onOpen }: { title: string; items: PlexItem[]; round?: boolean; compact?: boolean; artistGrid?: boolean; indexed?: boolean; onOpen: (item: PlexItem) => void }) {
  const collectionId = `alphabet-${items[0]?.type || title}`;
  const alphabetGroups = indexed ? groupPlexItemsByAlphabet(items) : [];
  const availableBuckets = new Set(alphabetGroups.map(({ bucket }) => bucket));
  const bucketId = (bucket: PlexAlphabetBucket) => `${collectionId}-${bucket === "#" ? "other" : bucket}`;
  const jumpToBucket = (bucket: PlexAlphabetBucket) => {
    const target = document.getElementById(bucketId(bucket));
    if (!target) return;
    target.scrollIntoView({
      block: "start",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  return (
    <section className={`collection-section ${indexed ? "indexed-collection-section" : ""}`}>
      <div className="section-heading"><LibraryPageTitle>{title}</LibraryPageTitle></div>
      {items.length ? (
        indexed ? (
          <div className="indexed-collection-layout">
            <div className="alphabet-groups">
              {alphabetGroups.map(({ bucket, items: bucketItems }) => (
                <section className="alphabet-group" id={bucketId(bucket)} key={bucket} aria-labelledby={`${bucketId(bucket)}-heading`}>
                  <h2 id={`${bucketId(bucket)}-heading`}>{bucket}</h2>
                  {artistGrid ? <ArtistAvatarGrid items={bucketItems} onOpen={onOpen} /> : <MediaCardGrid items={bucketItems} round={round} compact={compact} onOpen={onOpen} />}
                </section>
              ))}
            </div>
            <nav className="alphabet-index" data-route-scroll-container aria-label={`${title}首字母索引`}>
              {PLEX_ALPHABET_INDEX.map((bucket) => (
                <button
                  type="button"
                  key={bucket}
                  disabled={!availableBuckets.has(bucket)}
                  aria-label={`跳到 ${bucket}`}
                  onClick={() => jumpToBucket(bucket)}
                >
                  {bucket}
                </button>
              ))}
            </nav>
          </div>
        ) : artistGrid ? <ArtistAvatarGrid items={items} onOpen={onOpen} /> : <MediaCardGrid items={items} round={round} compact={compact} onOpen={onOpen} />
      ) : <EmptyState title={`没有${title}`} description="当前资料库没有返回可显示的内容。" />}
    </section>
  );
}

function ArtistAvatarGrid({ items, onOpen }: { items: PlexItem[]; onOpen: (item: PlexItem) => void }) {
  return (
    <div className="artist-avatar-grid" data-testid="artist-avatar-grid">
      {items.map((item) => (
        <button className="artist-avatar-card" type="button" key={item.ratingKey} onClick={() => onOpen(item)}>
          <Artwork item={item} className="round" size="large" />
          <strong>{item.title}</strong>
        </button>
      ))}
    </div>
  );
}

function MediaCardGrid({ items, round, compact, onOpen }: { items: PlexItem[]; round: boolean; compact: boolean; onOpen: (item: PlexItem) => void }) {
  return (
    <div className={`card-grid ${compact ? "compact" : ""}`}>
      {items.map((item) => (
        <button className="media-card" key={item.ratingKey} onClick={() => onOpen(item)}>
          <Artwork item={item} className={round ? "round" : ""} size="large" />
          <strong>{item.title}</strong>
          <small>{item.parentTitle || (item.type === "artist" ? "歌手" : item.year || "专辑")}</small>
        </button>
      ))}
    </div>
  );
}

function DetailBackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <IconButton className="detail-back-button" label={label} onClick={onClick}><ArrowLeft size={18} strokeWidth={2} aria-hidden="true" /></IconButton>;
}

function DetailView({ detail, serverId, artists, onBack, onPlay, onShuffle, onOpen, onOpenArtist, onOpenAlbum, onPlayTrack }: {
  detail: { source: PlexItem; children: PlexItem[] };
  serverId?: string;
  artists: PlexItem[];
  onBack: () => void;
  onPlay: () => void;
  onShuffle: () => void;
  onOpen: (item: PlexItem) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
}) {
  const runtime = useMusicShellRuntime();
  if (detail.source.type === "artist") {
    return (
      <ArtistDetailView
        key={detail.source.ratingKey}
        detail={detail}
        serverId={serverId}
        artists={artists}
        onBack={onBack}
        onOpen={onOpen}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        onPlayTrack={onPlayTrack}
      />
    );
  }

  const tracks = detail.children.filter((item) => item.type === "track");
  const albumArtist = detail.source.parentTitle?.trim();
  const albumMetadata = [albumArtist, detail.source.year === undefined ? undefined : String(detail.source.year)].filter(Boolean).join(" · ");
  return (
    <section className="detail-page album-detail-page">
      <DetailBackButton label="返回专辑列表" onClick={onBack} />
      <header className="detail-hero album-detail-hero">
        <Artwork item={detail.source} size="hero" />
        <div className="album-detail-copy">
          <h1>{detail.source.title}</h1>
          {albumMetadata && <p className="album-detail-meta">{albumMetadata}</p>}
          {tracks.length > 0 && (
            <div className="detail-actions">
              <button className="primary-button" type="button" onClick={onPlay}><Play size={17} fill="currentColor" aria-hidden="true" />播放</button>
              <IconButton className="album-action-button" label="随机播放" onClick={onShuffle}><Shuffle size={18} aria-hidden="true" /></IconButton>
              <IconButton className="album-action-button" label="添加到歌单" disabled={!serverId} onClick={() => runtime.openPlaylistPicker(tracks, `${detail.source.title} · ${tracks.length} 首歌曲`)}><ListPlus size={18} /></IconButton>
            </div>
          )}
        </div>
      </header>
      {tracks.length > 0 && <TrackTable title="曲目" tracks={tracks} artists={artists} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlayTrack} />}
    </section>
  );
}

type ArtistDetailTab = "albums" | "tracks";

function ArtistBiography({ summary, id }: { summary?: string; id: string }) {
  const biography = normalizeArtistBiography(summary);
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [collapsible, setCollapsible] = useState(() => shouldCollapseArtistBiography(biography));
  const [expanded, setExpanded] = useState(false);
  const headingId = `${id}-heading`;
  const contentId = `${id}-content`;

  useLayoutEffect(() => {
    setExpanded(false);
    const content = contentRef.current;
    if (!biography || !content) {
      setCollapsible(false);
      return;
    }

    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(content).lineHeight);
      const collapsedHeight = lineHeight * ARTIST_BIOGRAPHY_COLLAPSE_LINES;
      setCollapsible(Number.isFinite(collapsedHeight) && content.scrollHeight > collapsedHeight + 1);
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [biography]);

  return (
    <aside className={`artist-biography ${biography ? "" : "is-empty"}`.trim()} aria-labelledby={headingId}>
      <h2 id={headingId}>歌手资料</h2>
      {biography ? (
        <>
          <p ref={contentRef} id={contentId} className={collapsible && !expanded ? "is-collapsed" : undefined} style={{ "--artist-biography-line-limit": ARTIST_BIOGRAPHY_COLLAPSE_LINES } as CSSProperties}>{biography}</p>
          {collapsible && <button className="artist-biography-toggle" type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : "展开全部"}</button>}
        </>
      ) : <p>暂无可用简介。</p>}
    </aside>
  );
}

type ArtistBulkAction = "append" | "next" | "playlist";

function ArtistDetailView({ detail, serverId, artists, onBack, onOpen, onOpenArtist, onOpenAlbum, onPlayTrack }: {
  detail: { source: PlexItem; children: PlexItem[] };
  serverId?: string;
  artists: PlexItem[];
  onBack: () => void;
  onOpen: (item: PlexItem) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
}) {
  const runtime = useMusicShellRuntime();
  const albums = detail.children.filter((item) => item.type === "album");
  const [activeTab, setActiveTab] = useState<ArtistDetailTab>("albums");
  const [tracks, setTracks] = useState<PlexItem[]>([]);
  const [trackSort, setTrackSort] = useState<TrackSortState>();
  const [totalSize, setTotalSize] = useState<number>();
  const [nextStart, setNextStart] = useState(0);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string>();
  const [bulkAction, setBulkAction] = useState<"play" | ArtistBulkAction>();
  const albumsTabRef = useRef<HTMLButtonElement>(null);
  const tracksTabRef = useRef<HTMLButtonElement>(null);
  const loadSentinelRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const nextStartRef = useRef(0);
  const totalSizeRef = useRef<number | undefined>(undefined);
  const bulkAbortRef = useRef<AbortController | undefined>(undefined);
  const pageCacheRef = useRef<{
    key: string;
    generation: number;
    pages: Map<number, PlexItemPage>;
    requests: Map<number, Promise<PlexItemPage>>;
  }>({ key: "", generation: 0, pages: new Map(), requests: new Map() });
  const tabIdBase = `artist-${detail.source.ratingKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const pageCacheKey = `${serverId || "none"}:${detail.source.ratingKey}:${trackSort?.key || "default"}:${trackSort?.direction || "default"}`;
  const hasMoreTracks = totalSize === undefined || nextStart < totalSize;
  const biographyPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("artist-bio-preview")
    : null;
  const artistBiography = previewArtistBiography(detail.source.summary, biographyPreview);

  const resetPageCache = useCallback(() => {
    const cache = pageCacheRef.current;
    if (cache.key !== pageCacheKey) {
      cache.key = pageCacheKey;
      cache.generation += 1;
      cache.pages.clear();
      cache.requests.clear();
    }
    return cache;
  }, [pageCacheKey]);

  const getArtistPage = useCallback((start: number): Promise<PlexItemPage> => {
    if (!serverId) return Promise.reject(new Error("请先在设置中选择音乐服务器。"));
    const normalizedStart = Math.max(0, Math.floor(Number.isFinite(start) ? start : 0));
    const cache = resetPageCache();
    const cached = cache.pages.get(normalizedStart);
    if (cached) return Promise.resolve(cached);
    const pending = cache.requests.get(normalizedStart);
    if (pending) return pending;

    const generation = cache.generation;
    const request = getArtistTracksPage(serverId, detail.source.ratingKey, normalizedStart, ARTIST_TRACK_PAGE_SIZE, trackSort)
      .then((page) => {
        const activeCache = pageCacheRef.current;
        if (activeCache.key === pageCacheKey && activeCache.generation === generation) {
          activeCache.pages.set(normalizedStart, page);
        }
        return page;
      });
    cache.requests.set(normalizedStart, request);
    void request.finally(() => {
      const activeCache = pageCacheRef.current;
      if (activeCache.key === pageCacheKey && activeCache.generation === generation && activeCache.requests.get(normalizedStart) === request) {
        activeCache.requests.delete(normalizedStart);
      }
    }).catch(() => undefined);
    return request;
  }, [detail.source.ratingKey, pageCacheKey, resetPageCache, serverId, trackSort]);

  const loadNextTrackPage = useCallback(async () => {
    if (!serverId || loadingRef.current) return;
    const start = nextStartRef.current;
    if (totalSizeRef.current !== undefined && start >= totalSizeRef.current) return;
    const requestId = ++requestRef.current;
    loadingRef.current = true;
    setTracksLoading(true);
    setTracksError(undefined);
    try {
      const page = await getArtistPage(start);
      if (requestId !== requestRef.current) return;
      const resolvedNextStart = Number.isFinite(page.nextStart)
        ? Math.max(start, Math.floor(page.nextStart))
        : start;
      const resolvedTotalSize = Math.max(
        0,
        Number.isFinite(page.totalSize) ? Math.floor(page.totalSize) : 0,
        resolvedNextStart,
        start + page.items.length,
      );
      if (resolvedNextStart <= start && resolvedTotalSize > start) {
        throw new Error("歌手歌曲分页没有继续前进。");
      }
      setTracks((current) => appendUniqueArtistTracks(current, page.items));
      nextStartRef.current = resolvedNextStart;
      setNextStart(resolvedNextStart);
      totalSizeRef.current = resolvedTotalSize;
      setTotalSize(resolvedTotalSize);
    } catch (reason) {
      if (requestId === requestRef.current) {
        setTracksError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (requestId === requestRef.current) {
        loadingRef.current = false;
        setTracksLoading(false);
      }
    }
  }, [getArtistPage, serverId]);

  useEffect(() => {
    bulkAbortRef.current?.abort();
    resetPageCache();
    requestRef.current += 1;
    loadingRef.current = false;
    nextStartRef.current = 0;
    totalSizeRef.current = undefined;
    setTracks([]);
    setTotalSize(undefined);
    setNextStart(0);
    setTracksError(undefined);
    setTracksLoading(false);
    void loadNextTrackPage();
    return () => {
      requestRef.current += 1;
      loadingRef.current = false;
      bulkAbortRef.current?.abort();
    };
  }, [loadNextTrackPage, resetPageCache]);

  useEffect(() => {
    const sentinel = loadSentinelRef.current;
    if (activeTab !== "tracks" || !sentinel || tracksLoading || tracksError || !hasMoreTracks) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNextTrackPage();
    }, {
      root: sentinel.closest(".route-page-scroll"),
      rootMargin: "0px 0px 280px",
      threshold: 0.01,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, hasMoreTracks, loadNextTrackPage, tracks.length, tracksError, tracksLoading]);

  const selectTabFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextTab: ArtistDetailTab = event.key === "ArrowLeft" || event.key === "Home" ? "albums" : "tracks";
    setActiveTab(nextTab);
    window.requestAnimationFrame(() => (nextTab === "albums" ? albumsTabRef : tracksTabRef).current?.focus());
  };

  const runArtistAction = useCallback(async (action: "play" | ArtistBulkAction) => {
    if (!serverId || bulkAction) return;
    const controller = new AbortController();
    bulkAbortRef.current?.abort();
    bulkAbortRef.current = controller;
    setBulkAction(action);
    try {
      const collection = await collectAllArtistTracks(getArtistPage, { signal: controller.signal });
      if (!collection.tracks.length) {
        runtime.notify(`“${detail.source.title}”当前没有可操作的歌曲。`, "warning");
        return;
      }
      if (action === "play") {
        runtime.player.playTracks(collection.tracks);
        runtime.player.setShuffle(false);
      } else if (action === "append") {
        runtime.player.appendTracks(collection.tracks);
        runtime.notify(`已将 ${collection.tracks.length} 首歌曲添加到播放队列。`, "success");
      } else if (action === "next") {
        runtime.player.insertTracksNext(collection.tracks);
        runtime.notify(`已安排 ${collection.tracks.length} 首歌曲在下一首后播放。`, "success");
      } else {
        runtime.openPlaylistPicker(collection.tracks, `${detail.source.title} · ${collection.tracks.length} 首歌曲`);
      }
    } catch (reason) {
      if (!isArtistTrackCollectionCancelled(reason)) {
        runtime.notify(reason instanceof Error ? reason.message : String(reason), "error");
      }
    } finally {
      // A rapid second action aborts this collection and takes ownership of
      // the shared busy state. The cancelled request must not re-enable the
      // controls while its replacement is still collecting pages.
      if (bulkAbortRef.current === controller) {
        bulkAbortRef.current = undefined;
        setBulkAction(undefined);
      }
    }
  }, [bulkAction, detail.source.title, getArtistPage, runtime, serverId]);

  const artistActionBusy = Boolean(bulkAction);

  return (
    <section className="detail-page artist-detail-page">
      <DetailBackButton label="返回歌手列表" onClick={onBack} />
      <div className="artist-detail-overview">
        <div className="artist-detail-artwork">
          <Artwork item={detail.source} size="hero" className="round" />
        </div>
        <div className="artist-detail-main">
          <header className="artist-detail-identity"><h1>{detail.source.title}</h1></header>
          <div className="artist-detail-actions" aria-busy={artistActionBusy || undefined}>
            <button className="primary-button artist-play-button" type="button" disabled={!serverId || artistActionBusy} onClick={() => void runArtistAction("play")}>
              {bulkAction === "play" ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Play size={17} fill="currentColor" aria-hidden="true" />}
              {bulkAction === "play" ? "正在准备…" : "播放"}
            </button>
            <IconButton className="artist-action-button" label="添加到播放队列" disabled={!serverId || artistActionBusy} onClick={() => void runArtistAction("append")}><ListEnd size={18} /></IconButton>
            <IconButton className="artist-action-button" label="播放下一个" disabled={!serverId || artistActionBusy} onClick={() => void runArtistAction("next")}><SkipForward size={18} /></IconButton>
            <IconButton className="artist-action-button" label="添加到歌单" disabled={!serverId || artistActionBusy} onClick={() => void runArtistAction("playlist")}><ListPlus size={18} /></IconButton>
          </div>
          <ArtistBiography id={`${tabIdBase}-biography`} summary={artistBiography} />
        </div>
      </div>
      <div className="artist-detail-tabs" role="tablist" aria-label={`${detail.source.title}内容`}>
        <button
          ref={albumsTabRef}
          id={`${tabIdBase}-albums-tab`}
          type="button"
          role="tab"
          aria-selected={activeTab === "albums"}
          aria-controls={`${tabIdBase}-albums-panel`}
          tabIndex={activeTab === "albums" ? 0 : -1}
          onClick={() => setActiveTab("albums")}
          onKeyDown={selectTabFromKeyboard}
        >专辑</button>
        <button
          ref={tracksTabRef}
          id={`${tabIdBase}-tracks-tab`}
          type="button"
          role="tab"
          aria-selected={activeTab === "tracks"}
          aria-controls={`${tabIdBase}-tracks-panel`}
          tabIndex={activeTab === "tracks" ? 0 : -1}
          onClick={() => setActiveTab("tracks")}
          onKeyDown={selectTabFromKeyboard}
        >
          <span>歌曲</span>
          {totalSize !== undefined && <span className="artist-tab-count" aria-label={`共 ${totalSize} 首歌曲`}>{totalSize}</span>}
        </button>
      </div>
      {activeTab === "albums" ? (
        <div id={`${tabIdBase}-albums-panel`} className="artist-detail-panel" role="tabpanel" aria-labelledby={`${tabIdBase}-albums-tab`}>
          {albums.length
            ? <MediaCardGrid items={albums} round={false} compact={false} onOpen={onOpen} />
            : <EmptyState title="没有专辑" description="Plex 当前没有返回可显示的专辑。" />}
        </div>
      ) : (
        <div id={`${tabIdBase}-tracks-panel`} className="artist-detail-panel artist-tracks-panel" role="tabpanel" aria-labelledby={`${tabIdBase}-tracks-tab`} aria-busy={tracksLoading || undefined}>
          {tracks.length ? <ArtistTrackTable tracks={tracks} artists={artists} totalSize={totalSize} sort={trackSort} onSort={setTrackSort} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlayTrack} /> : tracksLoading ? (
            <div className="artist-track-list-state" role="status"><LoaderCircle className="spin" size={21} /><span>正在读取歌曲…</span></div>
          ) : tracksError ? (
            <div className="artist-track-list-state is-error" role="alert"><TriangleAlert size={22} /><strong>无法读取歌曲</strong><button className="secondary-button" type="button" onClick={() => void loadNextTrackPage()}><RefreshCw size={15} />重试</button></div>
          ) : <EmptyState title="没有歌曲" description="Plex 当前没有返回这位歌手的歌曲。" />}
          {tracks.length > 0 && tracksError && (
            <div className="artist-track-page-error" role="alert"><span>后续歌曲加载失败</span><button className="secondary-button" type="button" onClick={() => void loadNextTrackPage()}><RefreshCw size={15} />重试</button></div>
          )}
          {tracks.length > 0 && hasMoreTracks && !tracksError && (
            <div ref={loadSentinelRef} className={`artist-track-sentinel ${tracksLoading ? "is-loading" : ""}`} aria-hidden={!tracksLoading || undefined}>
              {tracksLoading && <><LoaderCircle className="spin" size={18} /><span>正在加载更多歌曲…</span></>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ArtistTrackTable({ tracks, artists, totalSize, sort, onSort, onOpenArtist, onOpenAlbum, onPlay }: {
  tracks: PlexItem[];
  artists: PlexItem[];
  totalSize?: number;
  sort?: TrackSortState;
  onSort: (sort: TrackSortState | undefined) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onPlay: (track: PlexItem, context: PlexItem[]) => void;
}) {
  return <TrackTableGrid label="歌手全部歌曲" tracks={tracks} artists={artists} totalSize={totalSize} sort={sort} onSort={onSort} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlay} />;
}

function TrackSortHeader({ label, accessibleLabel = label, sortKey, sort, onSort, className = "" }: {
  label: string;
  accessibleLabel?: string;
  sortKey: TrackSortKey;
  sort?: TrackSortState;
  onSort: (sort: TrackSortState | undefined) => void;
  className?: string;
}) {
  const activeDirection = sort?.key === sortKey ? sort.direction : undefined;
  const nextState = nextTrackSort(sort, sortKey);
  const currentLabel = activeDirection === "asc" ? "升序" : activeDirection === "desc" ? "降序" : "默认";
  const nextLabel = nextState?.direction === "asc" ? "升序" : nextState?.direction === "desc" ? "降序" : "默认";
  const SortIcon = activeDirection === "asc" ? ArrowUp : activeDirection === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <button
      className={`sortable-column-header ${activeDirection ? "is-active" : "is-default"} ${className}`.trim()}
      type="button"
      role="columnheader"
      aria-sort={activeDirection === "asc" ? "ascending" : activeDirection === "desc" ? "descending" : "none"}
      aria-label={`${accessibleLabel}，当前${currentLabel}排序；点击切换为${nextLabel}`}
      data-sort-state={activeDirection || "default"}
      data-testid={`track-sort-${sortKey}`}
      onClick={() => onSort(nextState)}
    >
      <span>{label}</span><SortIcon size={13} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

function TrackArtistsCell({ track, artistLookup, onOpenArtist }: {
  track: PlexItem;
  artistLookup: ArtistLookup;
  onOpenArtist: (artist: PlexItem) => void;
}) {
  const displayName = trackArtist(track);
  const segments = resolveTrackArtists(track, artistLookup);
  return (
    <span className="track-artists" role="cell" aria-label={`歌手：${displayName}`} title={displayName} data-testid={`track-artists-${track.ratingKey}`} onClick={(event) => event.stopPropagation()}>
      {segments.map((segment, index) => (
        <span className="track-artist-segment" key={`${segment.name}-${index}`}>
          {index > 0 && <span className="track-artist-separator" aria-hidden="true">/</span>}
          {segment.artist ? (
            <button
              className="track-artist-link"
              type="button"
              aria-label={`打开歌手“${segment.name}”`}
              title={`打开歌手“${segment.name}”`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenArtist(segment.artist as PlexItem);
              }}
            >{segment.name}</button>
          ) : (
            <span
              className="track-artist-unavailable"
              aria-disabled="true"
              aria-label={`${segment.name}，资料库中没有独立歌手`}
              title={`${segment.name}，资料库中没有独立歌手`}
            >{segment.name}</span>
          )}
        </span>
      ))}
    </span>
  );
}

function TrackAlbumCell({ track, onOpenAlbum }: { track: PlexItem; onOpenAlbum: (track: PlexItem) => void }) {
  const albumTitle = trackAlbum(track);
  const albumRatingKey = track.parentRatingKey?.trim();
  if (!albumRatingKey) {
    return <span className="track-album-cell track-album-unavailable" role="cell" title={albumTitle}>{albumTitle}</span>;
  }
  return (
    <span className="track-album-cell" role="cell" onClick={(event) => event.stopPropagation()}>
      <button
        className="track-album-link"
        type="button"
        aria-label={`打开专辑“${albumTitle}”`}
        title={`打开专辑“${albumTitle}”`}
        onClick={() => onOpenAlbum(track)}
      >{albumTitle}</button>
    </span>
  );
}

function TrackTableGrid({ label, tracks, artists, totalSize, sort, onSort, onOpenArtist, onOpenAlbum, onPlay, onRemoveTrack, startIndex = 0, selection }: {
  label: string;
  tracks: PlexItem[];
  artists: PlexItem[];
  totalSize?: number;
  sort?: TrackSortState;
  onSort: (sort: TrackSortState | undefined) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onPlay: (track: PlexItem, context: PlexItem[]) => void;
  onRemoveTrack?: (track: PlexItem) => void;
  startIndex?: number;
  selection?: {
    selectedRatingKeys: ReadonlySet<string>;
    onToggleTrack: (ratingKey: string, selected: boolean) => void;
    onTogglePage: (selected: boolean) => void;
  };
}) {
  const artistLookup = useMemo(() => createArtistLookup(artists), [artists]);
  const selectedOnPage = tracks.filter((track) => selection?.selectedRatingKeys.has(track.ratingKey)).length;
  const allPageSelected = tracks.length > 0 && selectedOnPage === tracks.length;
  const [pendingRemove, setPendingRemove] = useState<PlexItem>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const removeAnchorRef = useRef<HTMLButtonElement | null>(null);
  const closeRemoveConfirm = useCallback(() => {
    if (removeBusy) return;
    setPendingRemove(undefined);
    removeAnchorRef.current = null;
  }, [removeBusy]);
  return (
    <>
      <div className={`track-table ${selection ? "has-selection" : ""}`} role="table" aria-label={label} aria-rowcount={(totalSize ?? tracks.length) + 1}>
        <div className="track-row table-head" role="row">
          {selection && <span className="track-selection-heading" role="columnheader"><SelectionCheckbox checked={allPageSelected} indeterminate={selectedOnPage > 0 && !allPageSelected} label="选择当前页全部歌曲" onChange={(checked) => selection.onTogglePage(checked)} /></span>}
          <span className="track-number-heading" role="columnheader">#</span>
          <span className="track-artwork-heading" role="columnheader">封面</span>
          <TrackSortHeader label="标题" accessibleLabel="歌曲名称" sortKey="title" sort={sort} onSort={onSort} />
          <span className="track-artist-heading" role="columnheader">歌手</span>
          <TrackSortHeader label="专辑" sortKey="album" sort={sort} onSort={onSort} />
          <TrackSortHeader className="duration-sort-header" label="时长" sortKey="duration" sort={sort} onSort={onSort} />
        </div>
        {tracks.map((track, index) => (
          <div
            className="track-row track-data-row"
            role="row"
            aria-rowindex={index + 2}
            key={`${track.ratingKey}-${index}`}
          >
            {selection && <span className="track-selection-cell" role="cell"><SelectionCheckbox checked={selection.selectedRatingKeys.has(track.ratingKey)} label={`选择《${track.title}》`} onChange={(checked) => selection.onToggleTrack(track.ratingKey, checked)} /></span>}
            <span className="track-index" role="cell">
              <button className="track-play-button" type="button" aria-label={`播放《${track.title}》`} onClick={() => onPlay(track, tracks)}>
                <span>{startIndex + index + 1}</span><Play size={13} fill="currentColor" aria-hidden="true" />
              </button>
            </span>
            <span className="track-artwork-cell" role="cell"><Artwork item={track} size="small" /></span>
            <span className="track-title" role="cell" title={track.title}><strong>{track.title}</strong></span>
            <TrackArtistsCell track={track} artistLookup={artistLookup} onOpenArtist={onOpenArtist} />
            <TrackAlbumCell track={track} onOpenAlbum={onOpenAlbum} />
            <span className="duration-cell" role="cell">
              <span className="duration-label">{formatDuration(track.duration)}</span>
              {onRemoveTrack && (
                <button
                  className="track-remove-button"
                  type="button"
                  aria-label={`从歌单移除《${track.title}》`}
                  data-tooltip="从歌单移除"
                  title="从歌单移除"
                  onClick={(event) => {
                    removeAnchorRef.current = event.currentTarget;
                    setPendingRemove(track);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {onRemoveTrack && pendingRemove && (
        <Popconfirm
          title={`从歌单移除《${pendingRemove.title}》？`}
          description="只会从当前歌单移除，不会删除歌曲本身。"
          confirmLabel="移除"
          cancelLabel="取消"
          busy={removeBusy}
          danger
          anchor={removeAnchorRef.current}
          onCancel={closeRemoveConfirm}
          onConfirm={async () => {
            setRemoveBusy(true);
            try {
              await onRemoveTrack(pendingRemove);
            } finally {
              setRemoveBusy(false);
              setPendingRemove(undefined);
              removeAnchorRef.current = null;
            }
          }}
        />
      )}
    </>
  );
}

function Popconfirm({ title, description, confirmLabel = "确认", cancelLabel = "取消", busy = false, danger = false, anchor, onConfirm, onCancel }: {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  danger?: boolean;
  anchor: HTMLElement | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const [placement, setPlacement] = useState<"above" | "below">("above");

  useLayoutEffect(() => {
    if (!anchor) return;
    const pop = popRef.current;
    const update = () => {
      if (!pop || !anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const width = pop.offsetWidth || 232;
      const height = pop.offsetHeight || 76;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left + anchorRect.width / 2 - width / 2));
      const above = anchorRect.top - height - 8;
      const top = above >= 8
        ? above
        : Math.min(window.innerHeight - height - 8, anchorRect.bottom + 8);
      setPlacement(above >= 8 ? "above" : "below");
      setStyle({ top, left, visibility: "visible" });
    };
    update();
    const frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    confirmRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target) || anchor.contains(target)) return;
      onCancel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    const onScroll = () => onCancel();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onCancel]);

  return createPortal(
    <div
      ref={popRef}
      className={`popconfirm ${danger ? "is-danger" : ""} ${placement === "below" ? "is-below" : ""}`.trim()}
      role="alertdialog"
      aria-label={title}
      style={style}
    >
      <div className="popconfirm-title">{title}</div>
      {description && <div className="popconfirm-description">{description}</div>}
      <div className="popconfirm-actions">
        <button className="popconfirm-cancel" type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button ref={confirmRef} className="popconfirm-ok" type="button" disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : confirmLabel}</button>
      </div>
    </div>,
    document.body,
  );
}

function SelectionCheckbox({ checked, indeterminate = false, label, onChange }: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={inputRef}
      className="track-selection-checkbox"
      type="checkbox"
      checked={checked}
      aria-label={label}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function paginationSequence(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4, 5].forEach((page) => pages.add(page));
  if (current >= total - 2) [total - 4, total - 3, total - 2, total - 1].forEach((page) => pages.add(page));
  const ordered = [...pages].filter((page) => page >= 1 && page <= total).sort((left, right) => left - right);
  const sequence: Array<number | "ellipsis"> = [];
  for (const page of ordered) {
    const previous = sequence[sequence.length - 1];
    if (typeof previous === "number" && page - previous > 1) sequence.push("ellipsis");
    sequence.push(page);
  }
  return sequence;
}

function PaginatedTracksView({ serverId, sectionKey, route, artists, onRouteChange, onOpenArtist, onOpenAlbum, onPlay }: {
  serverId?: string;
  sectionKey?: string;
  route: LibraryRoute;
  artists: PlexItem[];
  onRouteChange: (route: LibraryRoute) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onPlay: (track: PlexItem, context: PlexItem[]) => void;
}) {
  const runtime = useMusicShellRuntime();
  const page = route.tracks?.page ?? 1;
  const sort = route.tracks?.sort;
  const [tracks, setTracks] = useState<PlexItem[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedRatingKeys, setSelectedRatingKeys] = useState<Set<string>>(() => new Set());
  const requestRef = useRef(0);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const start = (page - 1) * LIBRARY_TRACK_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(totalSize / LIBRARY_TRACK_PAGE_SIZE));
  const selectedTracks = useMemo(
    () => tracks.filter((track) => selectedRatingKeys.has(track.ratingKey)),
    [selectedRatingKeys, tracks],
  );

  useEffect(() => {
    setSelectedRatingKeys(new Set<string>());
    tableScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [page, sectionKey, serverId, sort]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!serverId || !sectionKey) {
      setTracks([]);
      setTotalSize(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    void getTracksPage(serverId, sectionKey, start, LIBRARY_TRACK_PAGE_SIZE, sort)
      .then((result) => {
        if (requestId !== requestRef.current) return;
        const maximumPage = Math.max(1, Math.ceil(result.totalSize / LIBRARY_TRACK_PAGE_SIZE));
        if (page > maximumPage && result.totalSize > 0) {
          onRouteChange(libraryTracksRoute(maximumPage, sort));
          return;
        }
        setTracks(result.items);
        setTotalSize(result.totalSize);
      })
      .catch((reason) => {
        if (requestId !== requestRef.current) return;
        setTracks([]);
        setTotalSize(0);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
    return () => { requestRef.current += 1; };
  }, [onRouteChange, page, sectionKey, serverId, sort, start]);

  const updatePage = (nextPage: number) => onRouteChange(libraryTracksRoute(Math.min(totalPages, Math.max(1, nextPage)), sort));
  const updateSort = (nextSort: TrackSortState | undefined) => onRouteChange(libraryTracksRoute(1, nextSort));
  const toggleTrack = (ratingKey: string, selected: boolean) => {
    setSelectedRatingKeys((current) => {
      const next = new Set(current);
      if (selected) next.add(ratingKey);
      else next.delete(ratingKey);
      return next;
    });
  };
  const togglePage = (selected: boolean) => {
    setSelectedRatingKeys((current) => {
      const next = new Set(current);
      for (const track of tracks) {
        if (selected) next.add(track.ratingKey);
        else next.delete(track.ratingKey);
      }
      return next;
    });
  };
  const playSelectedTracks = () => {
    if (!selectedTracks.length) return;
    runtime.player.playTracks(selectedTracks);
    runtime.player.setShuffle(false);
    setSelectedRatingKeys(new Set<string>());
  };
  const appendSelectedTracks = () => {
    if (!selectedTracks.length) return;
    runtime.player.appendTracks(selectedTracks);
    runtime.notify(`已将 ${selectedTracks.length} 首歌曲添加到播放队列。`, "success");
    setSelectedRatingKeys(new Set<string>());
  };

  if (error) return <EmptyState title="无法读取歌曲" description={error} icon={<TriangleAlert size={28} />} />;
  return (
    <section className="track-section has-accent-heading paginated-track-section" aria-busy={loading || undefined}>
      <div className="page-heading sticky-page-heading track-page-heading">
        <div className="track-page-heading-copy">
          <LibraryPageTitle>歌曲</LibraryPageTitle>
          <span className="track-page-count" aria-live="polite">{totalSize ? `共 ${totalSize} 首歌曲` : loading ? "正在读取歌曲…" : "当前资料库没有歌曲"}</span>
        </div>
        <div className="track-selection-actions" role="group" aria-label="已选歌曲操作">
          {selectedTracks.length > 0 && <span className="track-selection-summary" aria-live="polite">已选择 {selectedTracks.length} 首</span>}
          <button className="primary-button track-selection-action" type="button" disabled={!selectedTracks.length} onClick={playSelectedTracks}>
            <Play size={15} fill="currentColor" aria-hidden="true" />播放
          </button>
          <IconButton className="track-selection-queue-action" label="添加到播放队列" disabled={!selectedTracks.length} onClick={appendSelectedTracks}><ListEnd size={17} aria-hidden="true" /></IconButton>
        </div>
      </div>
      {loading && !tracks.length ? <LoadingState /> : tracks.length ? (
        <div className="paginated-track-workspace">
          <div ref={tableScrollRef} className="paginated-track-table-scroll" data-route-scroll-container>
            <TrackTableGrid label="歌曲" tracks={tracks} artists={artists} totalSize={totalSize} sort={sort} onSort={updateSort} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlay} startIndex={start} selection={{ selectedRatingKeys, onToggleTrack: toggleTrack, onTogglePage: togglePage }} />
          </div>
          <nav className="track-pagination" aria-label="歌曲分页">
            {page > 1 && <button type="button" onClick={() => updatePage(1)} aria-label="首页">首页</button>}
            <button type="button" onClick={() => updatePage(page - 1)} disabled={page <= 1} aria-label="上一页">上一页</button>
            <span className="track-pagination-pages">{paginationSequence(page, totalPages).map((item, index) => item === "ellipsis" ? <span key={`ellipsis-${index}`} aria-hidden="true">…</span> : <button key={item} type="button" className={item === page ? "is-current" : ""} aria-current={item === page ? "page" : undefined} onClick={() => updatePage(item)}>{item}</button>)}</span>
            <button type="button" onClick={() => updatePage(page + 1)} disabled={page >= totalPages} aria-label="下一页">下一页</button>
            {page < totalPages && <button type="button" onClick={() => updatePage(totalPages)} aria-label="末页">末页</button>}
          </nav>
        </div>
      ) : <EmptyState title="没有歌曲" description="当前音乐资料库没有返回可显示的歌曲。" icon={<Music2 size={28} />} />}
    </section>
  );
}

function TrackTable({ title, tracks, artists, accentHeading = false, onOpenArtist, onOpenAlbum, onPlay, onRemoveTrack }: { title: string; tracks: PlexItem[]; artists: PlexItem[]; accentHeading?: boolean; onOpenArtist: (artist: PlexItem) => void; onOpenAlbum: (track: PlexItem) => void; onPlay: (track: PlexItem, context: PlexItem[]) => void; onRemoveTrack?: (track: PlexItem) => void }) {
  const [sort, setSort] = useState<TrackSortState>();
  const displayedTracks = useMemo(() => sortTracks(tracks, sort), [sort, tracks]);
  return (
    <section className={`track-section ${accentHeading ? "has-accent-heading" : ""}`.trim()}>
      <div className="section-heading"><h1>{title}</h1></div>
      <TrackTableGrid label={title} tracks={displayedTracks} artists={artists} sort={sort} onSort={setSort} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlay} onRemoveTrack={onRemoveTrack} />
    </section>
  );
}

function SearchResults({ hubs, query, loading, artists, onOpen, onOpenArtist, onOpenAlbum, onPlayTrack }: { hubs: PlexHub[]; query: string; loading: boolean; artists: PlexItem[]; onOpen: (item: PlexItem) => void; onOpenArtist: (artist: PlexItem) => void; onOpenAlbum: (track: PlexItem) => void; onPlayTrack: (track: PlexItem, context: PlexItem[]) => void }) {
  const total = hubs.reduce((sum, hub) => sum + hub.items.length, 0);
  const navigate = useNavigate();
  const hubTitle = (hub: PlexHub): string => {
    const titles: Record<string, string> = {
      artist: "歌手",
      album: "专辑",
      track: "歌曲",
    };
    return titles[hub.type] ?? hub.title;
  };
  if (!query) return <EmptyState title="搜索音乐资料库" description="输入歌曲、专辑或歌手名称。" icon={<Search size={28} />} />;
  if (loading) return <SearchLoadingState query={query} />;
  if (!total) return <EmptyState title={`没有找到“${query}”`} description="尝试更短的关键词，或切换到其他音乐资料库。" icon={<Search size={28} />} />;
  return (
    <div className="search-results">
      <div className="search-results-toolbar">
        <DetailBackButton label="返回" onClick={() => navigate(-1)} />
        <div className="page-heading"><div><h1>“{query}”的搜索结果</h1><p>共找到 {total} 项内容</p></div></div>
      </div>
      {hubs.map((hub, index) => hub.type === "track"
        ? <TrackTable key={`${hub.type}-${index}`} title={hubTitle(hub)} tracks={hub.items} artists={artists} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlayTrack} />
        : <CardCollection key={`${hub.type}-${index}`} title={hubTitle(hub)} items={hub.items} round={hub.type === "artist"} compact onOpen={onOpen} />)}
    </div>
  );
}

function SettingsView(props: ContentViewProps) {
  const cacheSummary = props.cacheStatus
    ? formatBytes(props.cacheStatus.sizeBytes)
    : props.cacheStatusError ? "暂时无法统计"
      : "正在统计…";
  const cacheDescription = props.cacheStatus ? `${props.cacheStatus.fileCount} 个缓存文件` : undefined;
  return (
    <div className="settings-page">
      <div className="page-heading sticky-page-heading"><h1>设置</h1></div>
      <SettingsGroup icon={<Palette size={18} />} title="视觉风格">
        <div className="field-row">
          <span><strong>配色</strong><small>仅更改配色，不连接服务。</small></span>
          <div className="choice-grid choice-grid--compact choice-grid--visual" role="radiogroup" aria-label="视觉风格">
            {BRAND_PRESET_OPTIONS.map((option) => {
              const active = props.brandPreset === option.preset;
              return <ChoiceCard key={option.preset} radio active={active} title={option.label} icon={<span className="visual-preset-swatch" data-preset={option.preset} aria-hidden="true" />} onClick={(event) => {
                if (active) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                void props.onBrandPreset(option.preset, { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
              }} />;
            })}
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Laptop size={18} />} title="设备">
        <DeviceNameSetting value={props.deviceName} onEdit={props.onEditDeviceName} />
      </SettingsGroup>
      {props.statusIconPlatform && (
        <SettingsGroup icon={<PanelTop size={18} />} title="系统状态图标">
          <div className="toggle-row">
            <span><strong>{props.statusIconPlatform === "macos" ? "显示菜单栏图标" : "显示任务栏图标"}</strong></span>
            <label className="toggle-switch" aria-label={props.statusIconPlatform === "macos" ? "显示菜单栏图标" : "显示任务栏图标"}>
              <input type="checkbox" checked={props.statusIconEnabled} disabled={props.statusIconSaving} onChange={(event) => props.onStatusIconEnabled(event.target.checked)} />
              <span className="toggle-control" aria-hidden="true" />
            </label>
          </div>
        </SettingsGroup>
      )}
      <SettingsGroup id={PLAYBACK_SETTINGS_ID} icon={<SlidersHorizontal size={18} />} title="播放">
        <div className="settings-stack">
          <div className="field-row"><span><strong>音频质量</strong><small>选择 PMS 返回原始流或兼容质量。</small></span><SettingsSelect label="音频质量" value={props.quality} placeholder="选择音频质量" disabled={false} options={[{ value: "auto", label: "自动" }, { value: "original", label: "始终原始质量" }, { value: "320", label: "320 kbps" }, { value: "256", label: "256 kbps" }, { value: "192", label: "192 kbps" }]} onValueChange={(value) => props.onQuality(value as StreamQuality)} /></div>
          <div className="toggle-row">
            <span><strong>预缓冲下一首</strong><small>提前加载队列中的下一首。</small></span>
            <label className="toggle-switch" aria-label="预缓冲下一首"><input type="checkbox" checked={props.prebufferNext} onChange={(event) => props.onPrebufferNext(event.target.checked)} /><span className="toggle-control" aria-hidden="true" /></label>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Database size={18} />} title="封面缓存">
        <div className="cache-row">
          <span aria-live="polite"><strong>{cacheSummary}</strong>{cacheDescription && <small>{cacheDescription}</small>}</span>
          <button className="danger-button" type="button" disabled={props.cacheBusy || !props.cacheStatus?.fileCount} onClick={props.onClearCache}>{props.cacheBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}清理缓存</button>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Server size={18} />} title="音乐来源">
        <div className="settings-stack">
          <div className="field-row">
            <strong>服务器</strong>
            <SettingsSelect
              label="Plex 服务器"
              value={props.serverId}
              placeholder="未发现服务器"
              disabled={props.servers.length <= 1}
              options={props.servers.map((server) => ({ value: server.id, label: server.name }))}
              onValueChange={props.onServerChange}
            />
          </div>
          <div className="field-row">
            <strong>音乐资料库</strong>
            <SettingsSelect
              label="音乐资料库"
              value={props.sectionKey}
              placeholder="未发现音乐资料库"
              disabled={props.sections.length <= 1}
              options={props.sections.map((section) => ({ value: section.key, label: section.title }))}
              onValueChange={props.onSectionChange}
            />
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<CircleUserRound size={18} />} title="Plex 账号">
        <div className="account-settings-row">
          <span className="settings-account-identity"><Avatar account={props.account} /><span><strong>{props.account.title || props.account.username}</strong><small>{props.account.email || props.account.username}</small></span></span>
          <span className="account-settings-actions"><button className="secondary-button" type="button" disabled={props.sourcesSyncing} onClick={props.onSyncSources}><RefreshCw className={props.sourcesSyncing ? "spin" : ""} size={15} />同步资料库</button><button className="danger-button" type="button" onClick={props.onLogout}><LogOut size={16} />退出账号</button></span>
        </div>
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({ id, icon, title, children }: { id?: string; icon: ReactNode; title: string; children: ReactNode }) {
  return <section id={id} className="settings-group"><header><span className="settings-icon">{icon}</span><div><h2>{title}</h2></div></header><div className="settings-body">{children}</div></section>;
}

function DeviceNameSetting({ value, onEdit }: { value: string; onEdit: () => void }) {
  return (
    <div className="field-row device-name-setting">
      <span><strong>Cadilume 设备名称</strong><small>首次使用读取本机名称；Plex 会显示为“Cadilume — 此名称”。</small></span>
      <div className="device-name-display">
        <output title={value}>{value}</output>
        <button className="secondary-button" type="button" onClick={onEdit}>修改</button>
      </div>
    </div>
  );
}

function DeviceNameDialog({ deviceName, onClose, onSave }: { deviceName: string; onClose: () => void; onSave: (value: string) => Promise<string> }) {
  const [draft, setDraft] = useState(deviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTargetRef = useRef<HTMLElement | null>(null);
  const restoreFocusFrameRef = useRef<number | undefined>(undefined);
  const normalizedName = useMemo(() => {
    try {
      return normalizeDeviceName(draft);
    } catch {
      return undefined;
    }
  }, [draft]);
  const canSubmit = Boolean(normalizedName && normalizedName !== deviceName && !busy);

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
    inputRef.current?.select();
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
        onClose();
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
  }, [busy, onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedName || normalizedName === deviceName || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(normalizedName);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 Cadilume 设备名称。");
      setBusy(false);
    }
  };

  return (
    <div className="playlist-picker-backdrop device-name-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="device-name-dialog" role="dialog" aria-modal="true" aria-labelledby="device-name-dialog-title" tabIndex={-1}>
        <header>
          <div>
            <h2 id="device-name-dialog-title">修改设备名称</h2>
            <small>确认后用于后续 Plex 请求。</small>
          </div>
          <IconButton label="关闭修改设备名称" disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="device-name-dialog-content">
            <label htmlFor="cadilume-device-name">设备名称</label>
            <input
              ref={inputRef}
              id="cadilume-device-name"
              value={draft}
              maxLength={80}
              required
              placeholder="例如：我的 MacBook Pro"
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "device-name-dialog-hint device-name-dialog-error" : "device-name-dialog-hint"}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(undefined);
              }}
            />
            <p id="device-name-dialog-hint">Plex 将显示为“Cadilume — {normalizedName || draft.trim() || "设备名称"}”。</p>
            {error && <p id="device-name-dialog-error" className="device-name-dialog-error" role="alert">{error}</p>}
          </div>
          <footer>
            <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={!canSubmit} aria-busy={busy || undefined}>
              {busy ? <><LoaderCircle className="spin" size={15} />正在保存…</> : "确认修改"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function SettingsSelect({ label, value, placeholder, disabled, options, onValueChange }: {
  label: string;
  value?: string;
  placeholder: string;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
}) {
  const selectedValue = options.some((option) => option.value === value) ? value : undefined;
  return (
    <Select.Root value={selectedValue} disabled={disabled || options.length === 0} onValueChange={onValueChange}>
      <Select.Trigger className="settings-select-trigger" aria-label={label}>
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="settings-select-chevron"><ChevronDown size={15} strokeWidth={2} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="settings-select-content" position="popper" sideOffset={6} collisionPadding={12}>
          <Select.Viewport className="settings-select-viewport">
            {options.map((option) => (
              <Select.Item className="settings-select-item" value={option.value} key={option.value}>
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="settings-select-indicator"><Check size={14} strokeWidth={2.2} /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function ChoiceCard({ active, title, icon, onClick, radio = false }: { active: boolean; title: string; icon: ReactNode; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; radio?: boolean }) {
  return <button type="button" className={`choice-card ${active ? "active" : ""}`} role={radio ? "radio" : undefined} aria-checked={radio ? active : undefined} onClick={onClick}>{icon}<strong>{title}</strong>{active && <Check className="choice-check" size={16} />}</button>;
}

function ThemeCycleButton({ resolvedTheme, onChange }: { resolvedTheme: ResolvedTheme; onChange: ThemeModeChange }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nextMode = resolvedTheme === "light" ? "dark" : "light";
  const nextLabel = nextMode === "light" ? "浅色模式" : "深色模式";
  const CurrentIcon = resolvedTheme === "light" ? Sun : Moon;
  const cycle = () => {
    const bounds = triggerRef.current?.getBoundingClientRect();
    onChange(nextMode, bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : undefined);
  };
  return <button ref={triggerRef} className="icon-button theme-cycle-button" type="button" aria-label={`切换为${nextLabel}`} data-tooltip={nextLabel} title={nextLabel} onClick={cycle}><CurrentIcon size={18} strokeWidth={1.9} aria-hidden="true" /></button>;
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
      <button type="button" onClick={() => onSelect(track)}>
        <span className="queue-item-artwork" aria-hidden="true">
          <Artwork item={track} size="small" />
          <span className="queue-item-play-indicator"><Play size={14} fill="currentColor" strokeWidth={2.2} /></span>
        </span>
        <span><strong>{track.title}</strong><small>{trackArtist(track)}</small></span>
      </button>
      {!active && <IconButton label="从队列移除" onClick={() => onRemove(index)}><X size={14} /></IconButton>}
    </div>
  );
});

const QueuePanel = memo(function QueuePanel({ open, queue, currentIndex, onSelect, onRemove }: { open: boolean; queue: PlexItem[]; currentIndex: number; onSelect: (track: PlexItem) => void; onRemove: (index: number) => void }) {
  return (
    <aside className="queue-panel" data-panel-state={open ? "open" : "closing"} role="dialog" aria-modal="true" aria-hidden={!open || undefined} inert={!open || undefined} aria-label="播放队列">
      <header><h2>{`播放队列(${queue.length})`}</h2></header>
      <div className="queue-list">
        {queue.length ? queue.map((track, index) => (
          <QueueItem
            key={`${track.ratingKey}-${index}`}
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
  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const trackIdentity = track?.ratingKey || track?.key || track?.title || "";
  const previousTrackIdentityRef = useRef(trackIdentity);
  const lines = lyrics.document?.lines ?? [];
  const activeIndex = lyrics.activeIndex ?? -1;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    if (previousTrackIdentityRef.current !== trackIdentity) {
      previousTrackIdentityRef.current = trackIdentity;
      lineRefs.current = {};
      list.scrollTop = 0;
      return;
    }

    if (!lyrics.document?.timed) return;
    const activeLine = lines[activeIndex];
    if (!activeLine || activeLine.clear) return;
    const node = lineRefs.current[activeLine.id];
    if (!node || typeof list.scrollTo !== "function") return;
    const listRect = list.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nextScrollTop = getPlexLyricsScrollTop({
      scrollTop: list.scrollTop,
      viewportHeight: list.clientHeight,
      contentHeight: list.scrollHeight,
      targetTop: nodeRect.top - listRect.top,
      targetHeight: nodeRect.height,
    });
    if (Math.abs(nextScrollTop - list.scrollTop) < 0.5) return;
    list.scrollTo({
      top: nextScrollTop,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeIndex, lines, lyrics.document?.timed, trackIdentity]);

  return (
    <aside className="lyrics-panel" data-panel-state={open ? "open" : "closing"} aria-hidden={!open || undefined} inert={!open || undefined} aria-label="歌词">
      <div
        ref={listRef}
        className="lyrics-list"
        tabIndex={0}
        aria-label={`${track?.title || "当前歌曲"}的歌词内容`}
        aria-live="polite"
        aria-busy={lyrics.loading || undefined}
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
              ref={(node) => { lineRefs.current[line.id] = node; }}
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

function DevicesPanel({ output, onClose }: {
  output: ReturnType<typeof useOutputDevices>;
  onClose: () => void;
}) {
  const openWindowsSettings = async () => {
    try {
      await openWindowsAudioSettings();
    } catch (reason) {
      output.setMessage(reason instanceof Error ? reason.message : "无法打开 Windows 音量合成器。");
    }
  };

  return (
    <aside className="devices-panel" role="dialog" aria-label="播放设备">
      <header><h2>播放设备</h2><IconButton label="关闭播放设备" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="devices-content">
        {output.platform === "windows" ? (
          <>
            <div className="device-hero"><span><Speaker size={23} /></span><div><strong>Windows 音频输出</strong><small>仅改变 Cadilume，不修改系统默认设备。</small></div></div>
            {output.canSelectSink ? (
              <>
                <div className="device-toolbar">
                  {output.canUseSystemPicker && <button className="secondary-button" type="button" onClick={() => void output.requestSystemDevice()}><Headphones size={16} />打开系统选择器</button>}
                  <IconButton label="刷新输出设备" onClick={() => void output.refresh()}><RefreshCw className={output.loading ? "spin" : ""} size={16} /></IconButton>
                </div>
                <div className="device-list" role="radiogroup" aria-label="Windows 音频输出设备">
                  {output.devices.map((device) => (
                    <button
                      className={`device-option ${output.selectedDeviceId === device.deviceId ? "active" : ""}`}
                      key={device.deviceId || "system-default"}
                      type="button"
                      role="radio"
                      aria-checked={output.selectedDeviceId === device.deviceId}
                      onClick={() => void output.selectDevice(device.deviceId)}
                    >
                      <span className="device-option-icon">{device.isDefault ? <Laptop size={18} /> : <Speaker size={18} />}</span>
                      <span><strong>{device.label}</strong><small>{device.isDefault ? "跟随 Windows 默认设备" : "Cadilume 专用输出"}</small></span>
                      {output.selectedDeviceId === device.deviceId && <Check size={16} />}
                    </button>
                  ))}
                </div>
              </>
            ) : <div className="device-unavailable"><Speaker size={23} /><strong>当前 WebView2 不支持应用内切换</strong><small>请更新 Microsoft Edge WebView2 Runtime，或在 Windows 音量合成器中单独指定 Cadilume 的输出。</small></div>}
            <button className="secondary-button device-settings-button" type="button" onClick={() => void openWindowsSettings()}><SlidersHorizontal size={16} />打开 Windows 音量合成器</button>
          </>
        ) : (
          <div className="device-unavailable"><Speaker size={23} /><strong>跟随系统音频输出</strong><small>当前平台不提供应用级设备选择，请从系统声音设置切换。</small></div>
        )}
        {output.message && <p className="device-message" role="status">{output.message}</p>}
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
          <IconButton label="关闭新建歌单" disabled={busy} onClick={cancel}><X size={18} /></IconButton>
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

function PlaylistPicker({ serverId, tracks, label, onClose, onPlaylistCreated, onAdded }: {
  serverId: string;
  tracks: readonly PlexItem[];
  label: string;
  onClose: () => void;
  onPlaylistCreated: (playlist: PlexPlaylist) => void;
  onAdded: (playlist: PlexPlaylist, result: { requested: number; added: number; failedRatingKeys: string[] }) => void;
}) {
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");
  const [createError, setCreateError] = useState<string>();
  const [duplicateConfirm, setDuplicateConfirm] = useState<{ playlist: PlexPlaylist; count: number }>();
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
        setDuplicateConfirm({ playlist, count: duplicates.length });
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
          <IconButton label="关闭歌单选择" disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>
        {duplicateConfirm && (
          <div className="playlist-picker-duplicate" role="alert">
            <span>“{duplicateConfirm.playlist.title}”已有 {duplicateConfirm.count} 首相同歌曲，仍要添加吗？</span>
            <span className="playlist-picker-duplicate-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setDuplicateConfirm(undefined)}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  const playlist = duplicateConfirm.playlist;
                  setDuplicateConfirm(undefined);
                  void performAdd(playlist);
                }}
              >
                继续添加
              </button>
            </span>
          </div>
        )}
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

function PlayerBar({ player, loading, buffering, nowPlayingTriggerRef, expanded, queueOpen, lyricsOpen, devicesOpen, outputPlatform, canOpenNowPlaying, canToggleQueue, canToggleLyrics, onOpenNowPlaying, onToggleQueue, onToggleLyrics, onAddToPlaylist, onOutputAction }: {
  player: ReturnType<typeof usePlayer>;
  loading: boolean;
  buffering: boolean;
  nowPlayingTriggerRef: RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  queueOpen: boolean;
  lyricsOpen: boolean;
  devicesOpen: boolean;
  outputPlatform: ReturnType<typeof useOutputDevices>["platform"];
  canOpenNowPlaying: boolean;
  canToggleQueue: boolean;
  canToggleLyrics: boolean;
  onOpenNowPlaying: () => void;
  onToggleQueue: () => void;
  onToggleLyrics: () => void;
  onAddToPlaylist: () => void;
  onOutputAction: () => void;
}) {
  const displayDuration = usableDurationSeconds(player.duration, (player.current?.duration || 0) / 1000);
  const progressFill = rangeFillPercent(player.progress, displayDuration);
  const playbackBusy = loading || buffering;
  const playbackLabel = playbackControlLabel({ playing: player.playing, loading, buffering });
  const cycleRepeat = () => player.setRepeat(player.repeat === "off" ? "all" : player.repeat === "all" ? "one" : "off");
  return (
    <footer className={`player-bar ${expanded ? "is-expanded" : ""}`} aria-label="播放器" aria-hidden={expanded || undefined} inert={expanded || undefined}>
      <button ref={nowPlayingTriggerRef} className="now-playing now-playing-trigger" type="button" disabled={!canOpenNowPlaying} onClick={onOpenNowPlaying} aria-label={player.current ? `展开正在播放：${player.current.title}` : "尚未播放"}>
        <span className={`mini-vinyl ${player.playing && !playbackBusy ? "is-playing" : ""}`.trim()}>
          <Artwork item={player.current} size="player" />
        </span>
        <span><strong>{player.current?.title || "尚未播放"}</strong><small>{player.current ? trackArtist(player.current) : "从资料库选择音乐"}</small></span>
      </button>
      <div className="player-center">
        <div className="transport-controls">
          <IconButton label={player.shuffle ? "关闭随机播放（当前列表）" : "随机播放当前列表"} tooltip={null} active={player.shuffle} onClick={() => player.setShuffle(!player.shuffle)}><Shuffle size={16} /></IconButton>
          <IconButton label="上一首" tooltip={null} onClick={player.previous}><SkipBack size={19} fill="currentColor" /></IconButton>
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
          <IconButton label="下一首" tooltip={null} onClick={player.next}><SkipForward size={19} fill="currentColor" /></IconButton>
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
        {outputPlatform !== "macos" && <IconButton label="播放设备" active={devicesOpen} onClick={onOutputAction}><Speaker size={18} /></IconButton>}
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

function LoginScreen({ clientIdentifier, onAuthenticated }: { clientIdentifier: string; onAuthenticated: () => void | Promise<void> }) {
  const login = usePlexLogin(clientIdentifier, onAuthenticated);

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-card-heading">
          <div className="login-brand"><span className="brand-mark large"><BrandIcon size={28} /></span><span>Cadilume</span></div>
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
        <button className="primary-button login-button" onClick={() => void login.start()} disabled={login.busy} aria-busy={login.busy || undefined}>{login.busy ? <LoaderCircle className="spin" size={18} /> : <CircleUserRound size={18} />}{login.buttonLabel}</button>
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
  thumb?: string;
  art?: string;
  composite?: string;
  imageUrl?: string;
}

function Artwork({ item, size, className = "", preferArt = false }: {
  item?: ArtworkItem;
  size: "small" | "large" | "hero" | "player" | "immersive" | "backdrop";
  className?: string;
  preferArt?: boolean;
}) {
  const serverId = useContext(ArtworkServerContext);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(!isDesktopRuntime());
  const [source, setSource] = useState(item?.imageUrl);
  const [failed, setFailed] = useState(false);
  const [ticketRetryCount, setTicketRetryCount] = useState(0);
  const path = preferArt
    ? item?.art || item?.thumb || item?.composite
    : item?.thumb || item?.composite || item?.art;
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
    ? `${serverId}:${dimensions.width}x${dimensions.height}:${path}`
    : undefined;

  useEffect(() => {
    setSource(item?.imageUrl);
    setFailed(false);
    setTicketRetryCount(0);
  }, [item?.imageUrl, item?.ratingKey, path, serverId]);

  useEffect(() => {
    if (!isDesktopRuntime() || item?.imageUrl || !path || !serverId) {
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
    }, { rootMargin: "320px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item?.imageUrl, path, serverId]);

  useEffect(() => {
    if (!visible || source || failed || !path || !serverId || !artworkRequestKey || !isDesktopRuntime()) return;
    let request = artworkCache.get(artworkRequestKey);
    if (!request) {
      request = artworkUrl(serverId, path, dimensions.width, dimensions.height);
      artworkCache.set(artworkRequestKey, request);
      if (artworkCache.size > 200) artworkCache.delete(artworkCache.keys().next().value as string);
    }
    let cancelled = false;
    void request
      .then((url) => { if (!cancelled) setSource(url); })
      .catch(() => {
        artworkCache.delete(artworkRequestKey);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [artworkRequestKey, dimensions.height, dimensions.width, failed, path, serverId, source, visible]);

  const handleImageError = () => {
    if (!item?.imageUrl && artworkRequestKey && isDesktopRuntime()) {
      artworkCache.delete(artworkRequestKey);
      if (ticketRetryCount < 1) {
        setTicketRetryCount(1);
        setSource(undefined);
        return;
      }
    }
    setFailed(true);
  };
  const awaitingTicketRetry = ticketRetryCount > 0 && !failed && !source && Boolean(path);

  return (
    <span ref={hostRef} className={`artwork artwork-${size} ${className}`}>
      {source && !failed
        ? <img src={source} alt={`${item?.title || "音乐"} 封面`} loading="lazy" onError={handleImageError} />
        : awaitingTicketRetry ? null : <Music2 aria-hidden="true" />}
    </span>
  );
}

function Avatar({ account }: { account: PlexAccount }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [account.thumb]);
  return account.thumb && !failed
    ? <img className="avatar" src={account.thumb} alt="" onError={() => setFailed(true)} />
    : <span className="avatar fallback">{(account.title || account.username || "P").slice(0, 1).toUpperCase()}</span>;
}

function IconButton({ label, tooltip, className = "", active = false, disabled = false, onClick, children }: { label: string; tooltip?: string | null; className?: string; active?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  const tooltipText = tooltip === null ? undefined : tooltip ?? label;
  return <button type="button" className={`icon-button ${active ? "active" : ""} ${className}`.trim()} aria-label={label} data-tooltip={tooltipText} title={tooltipText} disabled={disabled} onClick={onClick}>{children}</button>;
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
      <IconButton label="关闭播放失败提醒" onClick={onClose}><X size={17} /></IconButton>
    </section>
  );
}

function EmptyState({ title, description, icon = <Music2 size={28} /> }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{description}</p></div>;
}

function LoadingState() {
  return <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>正在读取音乐资料库…</span></div>;
}

function SearchLoadingState({ query }: { query: string }) {
  return (
    <div className="search-loading-state" role="status" aria-live="polite" aria-busy="true">
      <span className="search-loading-orbit" aria-hidden="true">
        <Search size={32} />
      </span>
      <span className="search-loading-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      <strong>正在搜索“{query}”…</strong>
      <small>正在查找歌曲、专辑与歌手</small>
    </div>
  );
}

function SplashScreen() {
  return (
    <main className="splash-screen">
      <section className="splash-card" aria-live="polite" aria-busy="true">
        <div className="splash-card-heading"><div className="splash-brand"><span className="brand-mark splash-mark"><BrandIcon size={32} /></span><span><strong>Cadilume</strong><small>桌面音乐空间</small></span></div><span className="splash-stage"><span className="splash-stage-dot" />正在启动</span></div>
        <div className="splash-main">
          <div className="splash-visual" aria-hidden="true">
            <div className="splash-orbit splash-orbit-one" /><div className="splash-orbit splash-orbit-two" />
            <div className="splash-disc"><BrandIcon size={54} /></div>
            <div className="splash-signal">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 17) % 48)}px` }} />)}</div>
          </div>
          <div className="splash-copy">
            <h1>准备你的音乐空间</h1>
            <p>正在恢复账号、音乐来源与上次播放现场。</p>
            <div className="splash-progress" role="status"><span className="splash-progress-icon"><LoaderCircle className="spin" size={18} /></span><span><strong>正在连接你的音乐资料库</strong><small>首次启动可能需要一点时间</small></span><span className="splash-progress-pulse" /></div>
            <div className="splash-checks"><span><Check size={14} />凭据安全恢复</span><span><Check size={14} />连接状态检测</span></div>
          </div>
        </div>
      </section>
    </main>
  );
}

function FatalError({ message, retry }: { message: string; retry: () => void }) {
  return <main className="fatal-screen"><span className="brand-mark large"><BrandIcon size={28} /></span><h1>无法启动 Cadilume</h1><p>{message}</p><button className="primary-button" onClick={retry}><RefreshCw size={17} />重试</button></main>;
}

function readNowPlayingMode(): NowPlayingMode {
  try {
    return localStorage.getItem(NOW_PLAYING_MODE_STORAGE_KEY) === "artwork" ? "artwork" : "vinyl";
  } catch {
    return "vinyl";
  }
}

function readStoredQuality(fallback: StreamQuality = "auto"): StreamQuality {
  try {
    const stored = localStorage.getItem("cadilume-quality");
    return stored === "auto" || stored === "original" || stored === "320" || stored === "256" || stored === "192"
      ? stored
      : fallback;
  } catch {
    return fallback;
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
  ".now-playing-cover-stage",
  ".now-playing-cover-artwork",
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
    const bounds = source.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const style = window.getComputedStyle(source);
    copy.style.width = `${bounds.width}px`;
    copy.style.height = `${bounds.height}px`;
    copy.style.minWidth = `${bounds.width}px`;
    copy.style.minHeight = `${bounds.height}px`;
    copy.style.maxWidth = `${bounds.width}px`;
    copy.style.maxHeight = `${bounds.height}px`;
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
  const images = Array.from(snapshot.querySelectorAll<HTMLImageElement>("img"));
  const decoded = Promise.all(images.map((image) => {
    if (!image.complete || image.naturalWidth <= 0 || typeof image.decode !== "function") return Promise.resolve();
    return image.decode().catch(() => undefined);
  }));
  const maximumWait = new Promise<void>((resolve) => window.setTimeout(resolve, 120));
  return Promise.race([decoded.then(() => undefined), maximumWait]).then(nextAppearancePaint).then(() => {
    snapshot.classList.add("is-ready");
    return nextAppearancePaint();
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
    if (!origin || reducedMotion) {
      applyAtomically();
      return;
    }

    transitionLockRef.current = true;
    const release = () => {
      transitionLockRef.current = false;
    };
    void playAppearanceReveal(origin, { theme: themeMode, brand: brandPreset }, applyAtomically).finally(release);
  }, [brandPreset, themeMode]);

  const updateBrandPreset = useCallback<BrandPresetChange>(async (next, origin) => {
    if (transitionLockRef.current || next === brandPreset) return;
    transitionLockRef.current = true;
    const applyAtomically = () => {
      persistBrandPreset(next);
      applyAppearance({ theme: themeMode, brand: next });
      setBrandPreset(next);
    };
    try {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!origin || reducedMotion) {
        applyAtomically();
      } else {
        await playAppearanceReveal(origin, { theme: themeMode, brand: brandPreset }, applyAtomically);
      }
      await saveBrandPreset(next);
    } finally {
      transitionLockRef.current = false;
    }
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export default App;

import {
  Album,
  ArrowLeft,
  Cable,
  Captions,
  Check,
  ChevronDown,
  CircleUserRound,
  Cloud,
  Database,
  Globe2,
  Headphones,
  Home,
  Laptop,
  ListMusic,
  LoaderCircle,
  LogOut,
  Mic2,
  Minimize2,
  Monitor,
  Moon,
  Music2,
  Pause,
  Play,
  Plus,
  Power,
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
  Sun,
  Trash2,
  TriangleAlert,
  Volume1,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import * as Select from "@radix-ui/react-select";
import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import {
  artworkUrl,
  addTrackToPlaylist,
  bootstrap,
  canWritePlaylist,
  clearArtworkCache,
  createPlaylist,
  discoverServers,
  getArtistTracksPage,
  getCacheStatus,
  getChildren,
  getLibraryItems,
  getPlaylistItems,
  getPlaylists,
  getRecentAlbums,
  getRecommendationHubs,
  getSections,
  isDesktopRuntime,
  logout,
  openWindowsAudioSettings,
  searchLibrary,
  setCloseBehavior as saveCloseBehavior,
  showMainWindow,
} from "./api";
import "./App.css";
import { appendUniqueArtistTracks } from "./artistTracks";
import { selectRandomContextPlayback } from "./contextPlayback";
import { groupPlexItemsByAlphabet, PLEX_ALPHABET_INDEX, type PlexAlphabetBucket } from "./libraryIndex";
import { hasDisplayableLyrics } from "./lyrics";
import { getPlexLyricsScrollTop, NowPlayingView, type NowPlayingLyricsState, type NowPlayingMode } from "./NowPlayingView";
import { playbackControlLabel, rangeFillPercent } from "./playerUi";
import { isRecentlyAddedHub, orderRecommendationHubs, recommendationHubTitle, recentlyPlayedPlaylists } from "./recommendations";
import type {
  BootstrapResponse,
  CacheStatus,
  CloseBehavior,
  LibrarySection,
  LibraryView,
  PlexAccount,
  PlexHub,
  PlexItem,
  PlexPlaylist,
  PlexServer,
  StreamQuality,
  ThemeMode,
} from "./types";
import { formatDuration, trackAlbum, trackArtist } from "./types";
import { readPersistedPlaybackSession, usePlayer, type PlaybackFailure } from "./usePlayer";
import { useOutputDevices } from "./useOutputDevices";
import { useLyrics } from "./useLyrics";
import { usePlexLogin } from "./usePlexLogin";
import { BrandIcon } from "./BrandIcon";

type Icon = typeof Home;

const navigation: Array<{ id: LibraryView; label: string; icon: Icon }> = [
  { id: "home", label: "推荐", icon: Home },
  { id: "albums", label: "专辑", icon: Album },
  { id: "artists", label: "艺术家", icon: Mic2 },
  { id: "tracks", label: "歌曲", icon: Music2 },
];

const ArtworkServerContext = createContext<string | undefined>(undefined);
const artworkCache = new Map<string, Promise<string>>();
const NOW_PLAYING_MODE_STORAGE_KEY = "cadilume-now-playing-mode";
const PLAYBACK_SETTINGS_ID = "playback-settings";
const ARTIST_TRACK_PAGE_SIZE = 50;
type ConnectionKind = "local" | "remote" | "relay" | "disconnected";

function App() {
  const [themeMode, setThemeMode] = useThemeMode();
  return <MainApplication themeMode={themeMode} onThemeMode={setThemeMode} />;
}

function MainApplication({ themeMode, onThemeMode }: { themeMode: ThemeMode; onThemeMode: (mode: ThemeMode) => void }) {
  const [session, setSession] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();
  const requestedUiPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("ui-preview")
    : null;
  const uiPreview = requestedUiPreview === "login" || requestedUiPreview === "splash"
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

  if (uiPreview === "splash") return <SplashScreen />;
  if (uiPreview === "login") {
    return <LoginScreen clientIdentifier="cadilume-development-preview" onAuthenticated={() => undefined} />;
  }
  if (!session && !error) return <SplashScreen />;
  if (!session || error) return <FatalError message={error || "无法启动 Cadilume"} retry={load} />;
  if (!session.authenticated || !session.account) {
    return <LoginScreen clientIdentifier={session.clientIdentifier} onAuthenticated={load} />;
  }
  return <MusicShell initialSession={session} themeMode={themeMode} onThemeMode={onThemeMode} />;
}

function MusicShell({ initialSession, themeMode, onThemeMode }: { initialSession: BootstrapResponse; themeMode: ThemeMode; onThemeMode: (mode: ThemeMode) => void }) {
  const account = initialSession.account as PlexAccount;
  const [initialPlaybackSession] = useState(() => readPersistedPlaybackSession());
  const [servers, setServers] = useState<PlexServer[]>([]);
  const [serverId, setServerId] = useState<string>();
  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [sectionKey, setSectionKey] = useState<string>();
  const [view, setView] = useState<LibraryView>("home");
  const [items, setItems] = useState<PlexItem[]>([]);
  const [homeHubs, setHomeHubs] = useState<PlexHub[]>([]);
  const [searchHubs, setSearchHubs] = useState<PlexHub[]>([]);
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [sidePanel, setSidePanel] = useState<"queue" | "lyrics" | "devices" | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMode, setNowPlayingMode] = useState<NowPlayingMode>(readNowPlayingMode);
  const [playlistTrack, setPlaylistTrack] = useState<PlexItem>();
  const [playlistCreationOpen, setPlaylistCreationOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [playlistListLoading, setPlaylistListLoading] = useState(false);
  const [playlistListError, setPlaylistListError] = useState<string>();
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlexPlaylist>();
  const [playlistItems, setPlaylistItems] = useState<PlexItem[]>([]);
  const [playlistItemsLoading, setPlaylistItemsLoading] = useState(false);
  const [playlistItemsError, setPlaylistItemsError] = useState<string>();
  const [detail, setDetail] = useState<{ source: PlexItem; children: PlexItem[] }>();
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>(initialSession.closeBehavior);
  const [quality, setQuality] = useState<StreamQuality>(() => readStoredQuality(initialPlaybackSession?.quality));
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>();
  const [cacheBusy, setCacheBusy] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [sourcesSyncing, setSourcesSyncing] = useState(false);
  const [connectionAvailable, setConnectionAvailable] = useState(false);
  const [playbackSettingsRequest, setPlaybackSettingsRequest] = useState(0);
  const [playbackFailurePreview, setPlaybackFailurePreview] = useState<PlaybackFailure>();
  const contentRef = useRef<HTMLElement>(null);
  const nowPlayingTriggerRef = useRef<HTMLButtonElement>(null);
  const loadedSectionRef = useRef<string | undefined>(undefined);
  const playlistListRequestRef = useRef(0);
  const playlistItemsRequestRef = useRef(0);
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
  const previewPlaybackFailure = import.meta.env.DEV
    && new URLSearchParams(window.location.search).has("playback-error-preview");
  const previewPlaybackLoading = import.meta.env.DEV
    && new URLSearchParams(window.location.search).has("playback-loading-preview");
  const requestedConnectionPreview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("connection-preview")
    : null;
  const connectionPreview = ["local", "remote", "relay", "disconnected"].includes(requestedConnectionPreview || "")
    ? requestedConnectionPreview as ConnectionKind
    : undefined;
  const playbackLoading = player.loading || previewPlaybackLoading;
  const activePlaybackFailure = player.playbackFailure ?? playbackFailurePreview;

  const selectedServer = servers.find((server) => server.id === serverId);
  const selectedSection = sections.find((section) => section.key === sectionKey);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [detail?.source.ratingKey, selectedPlaylist?.ratingKey, view]);

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
    setPlaylistTrack(undefined);
  }, [activePlaybackFailure]);

  useEffect(() => {
    if (view !== "settings" || playbackSettingsRequest === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const section = document.getElementById(PLAYBACK_SETTINGS_ID);
      section?.scrollIntoView({ block: "start", behavior: "smooth" });
      section?.querySelector<HTMLSelectElement>("select")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [playbackSettingsRequest, view]);

  useEffect(() => {
    if (player.current) return;
    setNowPlayingOpen(false);
    setPlaylistTrack(undefined);
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

  const loadServers = useCallback(async () => {
    setLoading(true);
    setNotice(undefined);
    try {
      const result = await discoverServers();
      setServers(result);
      setConnectionAvailable(result.length > 0);
      setServerId((current) => {
        if (result.some((server) => server.id === current)) return current;
        if (result.some((server) => server.id === preferredPlaybackServerId)) return preferredPlaybackServerId;
        return result[0]?.id;
      });
      setSourceRevision((revision) => revision + 1);
      if (!result.length) setNotice("当前账号没有发现可访问的 Plex Media Server。请先让服务器所有者共享音乐库。" );
      return true;
    } catch (reason) {
      setConnectionAvailable(false);
      setNotice(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setLoading(false);
    }
  }, [preferredPlaybackServerId]);

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
        if (!result.length) setNotice("这台服务器没有向当前账号开放音乐资料库。" );
      })
      .catch((reason) => {
        if (cancelled) return;
        setConnectionAvailable(false);
        setNotice(String(reason));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [serverId, sourceRevision]);

  const loadPlaylistList = useCallback(async (announce = false) => {
    const requestId = ++playlistListRequestRef.current;
    if (!serverId) {
      setPlaylists([]);
      setPlaylistListError(undefined);
      setPlaylistListLoading(false);
      if (announce) setNotice("请先在设置中选择音乐服务器。");
      return;
    }
    setPlaylistListLoading(true);
    setPlaylistListError(undefined);
    try {
      const result = await getPlaylists(serverId);
      if (playlistListRequestRef.current === requestId) {
        setPlaylists(result);
        if (announce) setNotice(result.length ? `播放列表已刷新，共 ${result.length} 个。` : "播放列表已刷新，当前没有可显示的音乐播放列表。");
      }
    } catch (reason) {
      if (playlistListRequestRef.current === requestId) {
        const message = playlistReadErrorMessage(reason);
        setPlaylists([]);
        setPlaylistListError(message);
        if (announce) setNotice(message);
      }
    } finally {
      if (playlistListRequestRef.current === requestId) setPlaylistListLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    playlistItemsRequestRef.current += 1;
    setSelectedPlaylist(undefined);
    setPlaylistItems([]);
    setPlaylistItemsError(undefined);
    setPlaylistItemsLoading(false);
    void loadPlaylistList();
  }, [loadPlaylistList, sourceRevision]);

  const loadView = useCallback(async (nextView: LibraryView) => {
    playlistItemsRequestRef.current += 1;
    setSelectedPlaylist(undefined);
    setPlaylistItems([]);
    setPlaylistItemsError(undefined);
    setPlaylistItemsLoading(false);
    setView(nextView);
    setDetail(undefined);
    if (nextView !== "home") setHomeHubs([]);
    if (nextView === "settings") setSidePanel(null);
    if (!serverId || !sectionKey || nextView === "settings" || nextView === "search") return;
    setLoading(true);
    setNotice(undefined);
    try {
      if (nextView === "home") {
        const [hubs, recentAlbums] = await Promise.all([
          getRecommendationHubs(serverId, sectionKey),
          getRecentAlbums(serverId, sectionKey),
        ]);
        const completeHubs = hubs.some(isRecentlyAddedHub) || !recentAlbums.length
          ? hubs
          : [...hubs, {
            title: "最近加入的音乐",
            type: "album",
            identifier: "cadilume.recentlyadded",
            items: recentAlbums,
          }];
        setItems(recentAlbums);
        setHomeHubs(orderRecommendationHubs(completeHubs));
      }
      if (nextView === "albums") setItems(await getLibraryItems(serverId, sectionKey, 9));
      if (nextView === "artists") setItems(await getLibraryItems(serverId, sectionKey, 8));
      if (nextView === "tracks") setItems(await getLibraryItems(serverId, sectionKey, 10));
      setConnectionAvailable(true);
    } catch (reason) {
      setConnectionAvailable(false);
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [sectionKey, serverId]);

  useEffect(() => {
    if (!sectionKey || loadedSectionRef.current === sectionKey) return;
    loadedSectionRef.current = sectionKey;
    if (view !== "settings") void loadView("home");
  }, [sectionKey, loadView, view]);

  const syncSources = async () => {
    setSourcesSyncing(true);
    const succeeded = await loadServers();
    if (succeeded) setNotice("已重新发现可访问的服务器，音乐资料库正在同步。");
    setSourcesSyncing(false);
  };

  const refreshCacheStatus = useCallback(async () => {
    try {
      setCacheStatus(await getCacheStatus());
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (view === "settings") void refreshCacheStatus();
  }, [refreshCacheStatus, view]);

  const openItem = useCallback(async (item: PlexItem) => {
    if (item.type === "track") {
      player.playContext(item, items);
      return;
    }
    if (!serverId) return;
    setLoading(true);
    try {
      setDetail({ source: item, children: await getChildren(serverId, item.ratingKey) });
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [items, player, serverId]);

  const openPlaylist = useCallback(async (playlist: PlexPlaylist) => {
    if (!serverId) return;
    const requestId = ++playlistItemsRequestRef.current;
    setSelectedPlaylist(playlist);
    setPlaylistItems([]);
    setPlaylistItemsError(undefined);
    setPlaylistItemsLoading(true);
    setDetail(undefined);
    setSidePanel(null);
    setPlaylistTrack(undefined);
    try {
      const result = await getPlaylistItems(serverId, playlist.ratingKey);
      if (playlistItemsRequestRef.current === requestId) setPlaylistItems(result);
    } catch (reason) {
      if (playlistItemsRequestRef.current === requestId) {
        setPlaylistItemsError(playlistReadErrorMessage(reason));
      }
    } finally {
      if (playlistItemsRequestRef.current === requestId) setPlaylistItemsLoading(false);
    }
  }, [serverId]);

  const closePlaylist = useCallback(() => {
    playlistItemsRequestRef.current += 1;
    setSelectedPlaylist(undefined);
    setPlaylistItems([]);
    setPlaylistItemsError(undefined);
    setPlaylistItemsLoading(false);
  }, []);

  const submitSearch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const query = searchText.trim();
    if (!serverId || !sectionKey || !query) return;
    closePlaylist();
    setView("search");
    setDetail(undefined);
    setLoading(true);
    setNotice(undefined);
    try {
      setSearchHubs(await searchLibrary(serverId, sectionKey, query));
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [closePlaylist, searchText, sectionKey, serverId]);

  const changeCloseBehavior = async (behavior: CloseBehavior) => {
    setCloseBehavior(behavior);
    try {
      await saveCloseBehavior(behavior);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const changeQuality = (value: StreamQuality) => {
    setQuality(value);
    try {
      localStorage.setItem("cadilume-quality", value);
    } catch {
      // Keep the in-memory preference when storage is restricted.
    }
  };

  const clearCache = async () => {
    setCacheBusy(true);
    try {
      setCacheStatus(await clearArtworkCache());
      artworkCache.clear();
      setNotice("封面磁盘缓存已清理；当前页面已显示的封面会保留到下次加载。");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCacheBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await logout();
      player.discardPlaybackSession();
      artworkCache.clear();
      window.location.reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const playDetail = () => {
    const tracks = detail?.children.filter((item) => item.type === "track") || [];
    if (!tracks[0]) return;
    player.playContext(tracks[0], tracks);
    player.setShuffle(false);
  };

  const shuffleContext = useCallback((context: readonly PlexItem[]) => {
    const selection = selectRandomContextPlayback(context);
    if (!selection) return;
    player.playContext(selection.current, selection.queue);
    player.setShuffle(true);
  }, [player]);

  const playPlaylist = useCallback(() => {
    const tracks = playlistItems.filter((item) => item.type === "track");
    if (!tracks[0]) return;
    player.playContext(tracks[0], tracks);
    player.setShuffle(false);
  }, [player, playlistItems]);

  const closeNowPlaying = useCallback(() => {
    setNowPlayingOpen(false);
    window.requestAnimationFrame(() => {
      const trigger = nowPlayingTriggerRef.current;
      if (trigger && !trigger.disabled) trigger.focus();
    });
  }, []);

  const dismissPlaybackFailure = useCallback(() => {
    setPlaybackFailurePreview(undefined);
    player.dismissPlaybackFailure();
  }, [player.dismissPlaybackFailure]);

  const retryPlayback = useCallback(() => {
    setPlaybackFailurePreview(undefined);
    player.retryCurrent();
  }, [player.retryCurrent]);

  const openPlaybackSettings = useCallback(() => {
    dismissPlaybackFailure();
    setNowPlayingOpen(false);
    setPlaylistTrack(undefined);
    setSidePanel(null);
    setPlaybackSettingsRequest((request) => request + 1);
    void loadView("settings");
  }, [dismissPlaybackFailure, loadView]);

  return (
    <ArtworkServerContext.Provider value={serverId}>
    <div className={`app-shell ${queuePanelOpen || lyricsPanelOpen ? "side-panel-visible" : ""}`}>
      <a className="skip-link" href="#main-content" aria-hidden={expandedPlayerOpen || undefined} tabIndex={expandedPlayerOpen ? -1 : undefined}>跳到主要内容</a>
      <aside className="sidebar" aria-label="主导航" aria-hidden={expandedPlayerOpen || undefined} inert={expandedPlayerOpen || undefined}>
        <div className="brand"><span className="brand-mark"><BrandIcon /></span><span>Cadilume</span></div>
        <nav>
          <p className="nav-label">资料库</p>
          {navigation.map(({ id, label, icon: NavIcon }) => (
            <button className={`nav-item ${!selectedPlaylist && view === id ? "active" : ""}`} key={id} onClick={() => void loadView(id)}>
              <NavIcon size={18} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <PlaylistSidebar
          playlists={playlists}
          selectedId={selectedPlaylist?.ratingKey}
          loading={playlistListLoading}
          error={playlistListError}
          onOpen={(playlist) => void openPlaylist(playlist)}
          onRetry={() => void loadPlaylistList(true)}
          onCreate={() => {
            if (!serverId) {
              setNotice("请先在设置中选择音乐服务器。");
              return;
            }
            setSidePanel(null);
            setPlaylistTrack(undefined);
            setPlaylistCreationOpen(true);
          }}
        />
      </aside>

      <section className="workspace" aria-hidden={expandedPlayerOpen || undefined} inert={expandedPlayerOpen || undefined}>
        <header className="topbar">
          <form className="searchbox" onSubmit={submitSearch} role="search">
            <Search size={17} />
            <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索歌曲、专辑或艺术家" aria-label="搜索资料库" />
          </form>
          <div className="topbar-actions">
            <ConnectionIndicator server={selectedServer} connected={connectionAvailable} kindOverride={connectionPreview} />
            <button className="topbar-account" type="button" aria-label={`打开 ${account.title || account.username} 的 Plex 账号设置`} onClick={() => void loadView("settings")}>
              <Avatar account={account} />
              <span>
                <strong>{account.title || account.username}</strong>
                <small>{selectedServer ? (selectedServer.owned ? "我的服务器" : "共享资料库") : "选择音乐来源"}</small>
              </span>
            </button>
            <IconButton label="设置" active={!selectedPlaylist && view === "settings"} onClick={() => void loadView("settings")}><Settings size={18} /></IconButton>
            <IconButton label={sourcesSyncing ? "正在同步资料" : "刷新资料"} disabled={sourcesSyncing} onClick={() => void syncSources()}><RefreshCw className={sourcesSyncing ? "spin" : ""} size={17} /></IconButton>
          </div>
        </header>

        <main ref={contentRef} id="main-content" className="content" tabIndex={-1}>
          {selectedPlaylist ? (
            <PlaylistDetailView
              playlist={selectedPlaylist}
              tracks={playlistItems}
              loading={playlistItemsLoading}
              error={playlistItemsError}
              onBack={closePlaylist}
              onRetry={() => void openPlaylist(selectedPlaylist)}
              onPlay={playPlaylist}
              onShuffle={() => shuffleContext(playlistItems)}
              onPlayTrack={(track, context) => player.playContext(track, context)}
            />
          ) : loading && !items.length ? <LoadingState /> : (
            <ContentView
              view={view}
              items={items}
              homeHubs={homeHubs}
              hubs={searchHubs}
              searchText={searchText}
              detail={detail}
              account={account}
              servers={servers}
              serverId={serverId}
              server={selectedServer}
              sections={sections}
              sectionKey={sectionKey}
              section={selectedSection}
              closeBehavior={closeBehavior}
              quality={quality}
              themeMode={themeMode}
              prebufferNext={player.prebufferNext}
              cacheStatus={cacheStatus}
              cacheBusy={cacheBusy}
              playlists={playlists}
              onOpen={openItem}
              onOpenPlaylist={(playlist) => void openPlaylist(playlist)}
              onBack={() => setDetail(undefined)}
              onPlayDetail={playDetail}
              onShuffleDetail={() => shuffleContext(detail?.children || [])}
              onPlayTrack={(track, context) => player.playContext(track, context)}
              onCloseBehavior={changeCloseBehavior}
              onQuality={changeQuality}
              onThemeMode={onThemeMode}
              onServerChange={setServerId}
              onSectionChange={setSectionKey}
              onPrebufferNext={player.setPrebufferNext}
              onClearCache={() => void clearCache()}
              onLogout={signOut}
            />
          )}
        </main>
      </section>

      {queuePanelOpen && (
        <QueuePanel
          queue={player.queue}
          currentIndex={player.currentIndex}
          onSelect={(track) => player.playContext(track, player.queue)}
          onRemove={player.removeFromQueue}
        />
      )}

      {lyricsPanelOpen && (
        <LyricsPanel
          track={player.current}
          lyrics={nowPlayingLyrics}
          onSeek={player.seek}
        />
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
        backgroundArtwork={<Artwork item={player.current} size="backdrop" />}
        progressSeconds={player.progress}
        durationSeconds={player.duration}
        shuffle={player.shuffle}
        repeat={player.repeat}
        muted={player.muted}
        volume={player.volume}
        lyrics={nowPlayingLyrics}
        queue={player.queue}
        currentQueueIndex={player.currentIndex}
        theme={themeMode}
        onSeek={player.seek}
        onShuffleChange={player.setShuffle}
        onPrevious={player.previous}
        onTogglePlayback={player.toggle}
        onNext={player.next}
        onRepeatChange={player.setRepeat}
        onMutedChange={player.setMuted}
        onVolumeChange={player.setVolume}
        onSelectQueueIndex={(index) => {
          const track = player.queue[index];
          if (track) player.playContext(track, player.queue);
        }}
        onClose={closeNowPlaying}
        escapeEnabled={!playlistTrack && !activePlaybackFailure}
        onAddToPlaylist={() => {
          if (!player.current) return;
          setSidePanel(null);
          setPlaylistTrack(player.current);
        }}
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

      {playlistTrack && hasCurrentTrack && serverId && (
        <PlaylistPicker
          serverId={serverId}
          track={playlistTrack}
          onClose={() => setPlaylistTrack(undefined)}
          onAdded={(playlist) => {
            setPlaylistTrack(undefined);
            setNotice(`已将《${playlistTrack.title}》添加到“${playlist.title}”。`);
          }}
        />
      )}

      {playlistCreationOpen && serverId && (
        <CreatePlaylistDialog
          serverId={serverId}
          onClose={() => setPlaylistCreationOpen(false)}
          onCreated={(playlist) => {
            setPlaylistCreationOpen(false);
            setPlaylists((current) => [playlist, ...current.filter((item) => item.ratingKey !== playlist.ratingKey)]);
            setNotice(`已创建播放列表“${playlist.title}”。`);
            void loadPlaylistList();
          }}
          onError={setNotice}
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
          setSidePanel(null);
          setPlaylistTrack(undefined);
          setNowPlayingOpen(true);
        }}
        onToggleQueue={() => {
          if (!player.current || player.queue.length === 0) return;
          setNowPlayingOpen(false);
          setPlaylistTrack(undefined);
          setSidePanel((value) => value === "queue" ? null : "queue");
        }}
        onToggleLyrics={() => {
          if (!canToggleLyrics) return;
          setNowPlayingOpen(false);
          setPlaylistTrack(undefined);
          setSidePanel((value) => value === "lyrics" ? null : "lyrics");
        }}
        onOutputAction={() => {
          setNowPlayingOpen(false);
          setPlaylistTrack(undefined);
          setSidePanel((value) => value === "devices" ? null : "devices");
        }}
      />

      {notice && <GlobalToast message={notice} onClose={() => setNotice(undefined)} />}
    </div>
    </ArtworkServerContext.Provider>
  );
}

interface ContentViewProps {
  view: LibraryView;
  items: PlexItem[];
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
  closeBehavior: CloseBehavior;
  quality: StreamQuality;
  themeMode: ThemeMode;
  prebufferNext: boolean;
  cacheStatus?: CacheStatus;
  cacheBusy: boolean;
  playlists: PlexPlaylist[];
  onOpen: (item: PlexItem) => void;
  onOpenPlaylist: (playlist: PlexPlaylist) => void;
  onBack: () => void;
  onPlayDetail: () => void;
  onShuffleDetail: () => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
  onCloseBehavior: (value: CloseBehavior) => void;
  onQuality: (value: StreamQuality) => void;
  onThemeMode: (value: ThemeMode) => void;
  onServerChange: (value: string) => void;
  onSectionChange: (value: string) => void;
  onPrebufferNext: (value: boolean) => void;
  onClearCache: () => void;
  onLogout: () => void;
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
    <nav className={`sidebar-playlists ${collapsed ? "is-collapsed" : ""}`} aria-label="播放列表">
      <div className="sidebar-playlists-toolbar">
        <button className="sidebar-playlists-heading" type="button" aria-expanded={!collapsed} aria-controls="sidebar-playlist-list" onClick={() => setCollapsed((value) => !value)}>
          <span>播放列表</span>
          <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <button className="sidebar-playlists-create" type="button" aria-label="新建播放列表" title="新建播放列表" onClick={onCreate}>
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div id="sidebar-playlist-list" className="sidebar-playlist-list" aria-busy={loading || undefined} hidden={collapsed}>
        {loading ? (
          <div className="sidebar-playlist-state" role="status"><LoaderCircle className="spin" size={17} /><span>正在同步播放列表…</span></div>
        ) : error ? (
          <div className="sidebar-playlist-state is-error" role="alert"><span>播放列表读取失败</span><button type="button" onClick={onRetry}>重试</button></div>
        ) : !playlists.length ? (
          <div className="sidebar-playlist-state"><ListMusic size={18} /><span>暂无音乐播放列表</span></div>
        ) : playlists.map((playlist) => {
          const capability = [playlist.smart ? "智能" : "普通", playlist.readOnly ? "只读" : undefined].filter(Boolean).join(" · ");
          const active = selectedId === playlist.ratingKey;
          return (
            <button
              type="button"
              className={`sidebar-playlist-item ${active ? "active" : ""}`}
              key={playlist.ratingKey}
              aria-current={active ? "page" : undefined}
              aria-label={`${playlist.title}，${capability}播放列表`}
              title={playlist.title}
              onClick={() => onOpen(playlist)}
            >
              <Artwork item={playlist} size="small" className="sidebar-playlist-artwork" />
              <span><strong>{playlist.title}</strong><small>{capability}</small></span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function ContentView(props: ContentViewProps) {
  if (props.view === "settings") return <SettingsView {...props} />;
  if (props.detail) return <DetailView detail={props.detail} serverId={props.serverId} onBack={props.onBack} onPlay={props.onPlayDetail} onShuffle={props.onShuffleDetail} onOpen={props.onOpen} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "search") return <SearchResults hubs={props.hubs} query={props.searchText} onOpen={props.onOpen} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "tracks") return <TrackTable title="歌曲" tracks={props.items} onPlay={props.onPlayTrack} />;
  if (props.view === "artists") return <CardCollection title="艺术家" items={props.items} round indexed onOpen={props.onOpen} />;
  if (props.view === "albums") return <CardCollection title="专辑" items={props.items} indexed onOpen={props.onOpen} />;
  return <RecommendationsView hubs={props.homeHubs} playlists={props.playlists} onOpen={props.onOpen} onOpenPlaylist={props.onOpenPlaylist} onPlayTrack={props.onPlayTrack} />;
}

function ConnectionIndicator({ server, connected, kindOverride }: { server?: PlexServer; connected: boolean; kindOverride?: ConnectionKind }) {
  const kind = kindOverride ?? (!server || !connected ? "disconnected" : server.local ? "local" : server.relay ? "relay" : "remote");
  const label = kind === "local" ? "本地直连" : kind === "remote" ? "远程直连" : kind === "relay" ? "Plex Relay" : "连接已断开";
  const description = kind === "local"
    ? "本地直连：当前通过局域网直接连接 Plex Media Server。"
    : kind === "remote"
      ? "远程直连：当前通过公网直接连接 Plex Media Server。"
      : kind === "relay"
        ? "Plex Relay：当前由 Plex 中继转发，带宽可能受限。"
        : "连接已断开：当前无法访问所选 Plex Media Server。";
  const StatusIcon = kind === "local" ? Cable : kind === "remote" ? Globe2 : kind === "relay" ? Cloud : WifiOff;
  return (
    <span className="connection-tooltip-anchor">
      <span className="connection-indicator" data-connection={kind} role="status" tabIndex={0} aria-label={`连接状态：${label}`} aria-describedby="connection-status-tooltip">
        <StatusIcon size={17} strokeWidth={1.9} aria-hidden="true" />
      </span>
      <span id="connection-status-tooltip" className="connection-tooltip" role="tooltip">{description}</span>
    </span>
  );
}

function RecommendationsView({ hubs, playlists, onOpen, onOpenPlaylist, onPlayTrack }: {
  hubs: PlexHub[];
  playlists: PlexPlaylist[];
  onOpen: (item: PlexItem) => void;
  onOpenPlaylist: (playlist: PlexPlaylist) => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
}) {
  const recentPlaylists = recentlyPlayedPlaylists(playlists);
  const orderedHubs = orderRecommendationHubs(hubs);
  return (
    <section className="recommendations-page">
      <div className="page-heading"><h1>推荐</h1></div>
      {!recentPlaylists.length && !orderedHubs.length ? (
        <EmptyState title="还没有推荐内容" description="开始播放音乐后，这里会显示最近播放和服务器推荐。" icon={<Music2 size={28} />} />
      ) : (
        <div className="recommendation-sections">
          {recentPlaylists.length > 0 && (
            <section className="recommendation-section" aria-labelledby="recent-playlists-heading">
              <div className="section-heading"><h2 id="recent-playlists-heading">最近播放的播放列表</h2></div>
              <div className="recommendation-row" role="list">
                {recentPlaylists.map((playlist) => (
                  <button className="recommendation-card" type="button" role="listitem" key={playlist.ratingKey} onClick={() => onOpenPlaylist(playlist)}>
                    <Artwork item={playlist} size="large" />
                    <strong>{playlist.title}</strong>
                    <small>{playlist.smart ? "智能播放列表" : `${playlist.leafCount ?? 0} 首歌曲`}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {orderedHubs.map((hub, hubIndex) => (
            <section className="recommendation-section" aria-labelledby={`recommendation-hub-${hubIndex}`} key={`${hub.identifier || hub.title}-${hubIndex}`}>
              <div className="section-heading"><h2 id={`recommendation-hub-${hubIndex}`}>{recommendationHubTitle(hub)}</h2></div>
              <div className="recommendation-row" role="list">
                {hub.items.map((item, itemIndex) => (
                  <button
                    className="recommendation-card"
                    type="button"
                    role="listitem"
                    key={`${item.ratingKey}-${itemIndex}`}
                    onClick={() => item.type === "track" ? onPlayTrack(item, hub.items) : onOpen(item)}
                  >
                    <Artwork item={item} className={item.type === "artist" ? "round" : ""} size="large" />
                    <strong>{item.title}</strong>
                    <small>{item.type === "track" ? trackArtist(item) : item.parentTitle || (item.type === "artist" ? "艺术家" : item.year || "专辑")}</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function PlaylistDetailView({ playlist, tracks, loading, error, onBack, onRetry, onPlay, onShuffle, onPlayTrack }: {
  playlist: PlexPlaylist;
  tracks: PlexItem[];
  loading: boolean;
  error?: string;
  onBack: () => void;
  onRetry: () => void;
  onPlay: () => void;
  onShuffle: () => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
}) {
  const kind = [playlist.smart ? "智能" : "普通", playlist.readOnly ? "只读" : undefined].filter(Boolean).join(" · ") + "播放列表";
  const trackCount = loading ? playlist.leafCount ?? 0 : tracks.length;
  return (
    <>
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回</button>
      <header className="detail-hero playlist-detail-hero">
        <Artwork item={playlist} size="hero" />
        <div>
          <h1>{playlist.title}</h1>
          <p>{kind} · {trackCount} 首歌曲</p>
          <div className="detail-actions">
            <button className="primary-button" type="button" disabled={loading || Boolean(error) || !tracks.length} onClick={onPlay}><Play size={17} fill="currentColor" />播放全部</button>
            <button className="secondary-button" type="button" disabled={loading || Boolean(error) || !tracks.length} onClick={onShuffle}><Shuffle size={16} />随机播放</button>
          </div>
        </div>
      </header>
      {loading ? (
        <div className="playlist-detail-state" role="status"><LoaderCircle className="spin" size={22} /><span>正在读取播放列表曲目…</span></div>
      ) : error ? (
        <div className="playlist-detail-state is-error" role="alert"><TriangleAlert size={24} /><strong>无法读取这个播放列表</strong><span>{error}</span><button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={15} />重试</button></div>
      ) : tracks.length ? (
        <TrackTable title="曲目" tracks={tracks} onPlay={onPlayTrack} />
      ) : <EmptyState title="这个播放列表还没有歌曲" description={playlist.smart ? "Plex 当前没有返回符合智能规则的曲目。" : "可以稍后从歌曲菜单向普通可写播放列表添加内容。"} icon={<ListMusic size={28} />} />}
    </>
  );
}

function CardCollection({ title, items, round = false, compact = false, indexed = false, onOpen }: { title: string; items: PlexItem[]; round?: boolean; compact?: boolean; indexed?: boolean; onOpen: (item: PlexItem) => void }) {
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
    <section className="collection-section">
      <div className="section-heading"><h1>{title}</h1></div>
      {items.length ? (
        indexed ? (
          <div className="indexed-collection-layout">
            <div className="alphabet-groups">
              {alphabetGroups.map(({ bucket, items: bucketItems }) => (
                <section className="alphabet-group" id={bucketId(bucket)} key={bucket} aria-labelledby={`${bucketId(bucket)}-heading`}>
                  <h2 id={`${bucketId(bucket)}-heading`}>{bucket}</h2>
                  <MediaCardGrid items={bucketItems} round={round} compact={compact} onOpen={onOpen} />
                </section>
              ))}
            </div>
            <nav className="alphabet-index" aria-label={`${title}首字母索引`}>
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
        ) : <MediaCardGrid items={items} round={round} compact={compact} onOpen={onOpen} />
      ) : <EmptyState title={`没有${title}`} description="当前资料库没有返回可显示的内容。" />}
    </section>
  );
}

function MediaCardGrid({ items, round, compact, onOpen }: { items: PlexItem[]; round: boolean; compact: boolean; onOpen: (item: PlexItem) => void }) {
  return (
    <div className={`card-grid ${compact ? "compact" : ""}`}>
      {items.map((item) => (
        <button className="media-card" key={item.ratingKey} onClick={() => onOpen(item)}>
          <Artwork item={item} className={round ? "round" : ""} size="large" />
          <strong>{item.title}</strong>
          <small>{item.parentTitle || (item.type === "artist" ? "艺术家" : item.year || "专辑")}</small>
        </button>
      ))}
    </div>
  );
}

function DetailView({ detail, serverId, onBack, onPlay, onShuffle, onOpen, onPlayTrack }: {
  detail: { source: PlexItem; children: PlexItem[] };
  serverId?: string;
  onBack: () => void;
  onPlay: () => void;
  onShuffle: () => void;
  onOpen: (item: PlexItem) => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
}) {
  if (detail.source.type === "artist") {
    return (
      <ArtistDetailView
        key={detail.source.ratingKey}
        detail={detail}
        serverId={serverId}
        onBack={onBack}
        onOpen={onOpen}
        onPlayTrack={onPlayTrack}
      />
    );
  }

  const tracks = detail.children.filter((item) => item.type === "track");
  const detailMeta = detail.source.parentTitle ? `专辑 · ${detail.source.parentTitle}` : "专辑";
  return (
    <section className="detail-page album-detail-page">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回</button>
      <header className="detail-hero">
        <Artwork item={detail.source} size="hero" />
        <div><h1>{detail.source.title}</h1><p>{detailMeta}</p>{tracks.length > 0 && <div className="detail-actions"><button className="primary-button" onClick={onPlay}><Play size={17} fill="currentColor" />播放</button><button className="secondary-button" onClick={onShuffle}><Shuffle size={16} />随机播放</button></div>}</div>
      </header>
      {tracks.length > 0 && <TrackTable title="曲目" tracks={tracks} onPlay={onPlayTrack} />}
    </section>
  );
}

type ArtistDetailTab = "albums" | "tracks";

function ArtistDetailView({ detail, serverId, onBack, onOpen, onPlayTrack }: {
  detail: { source: PlexItem; children: PlexItem[] };
  serverId?: string;
  onBack: () => void;
  onOpen: (item: PlexItem) => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
}) {
  const albums = detail.children.filter((item) => item.type === "album");
  const [activeTab, setActiveTab] = useState<ArtistDetailTab>("albums");
  const [tracks, setTracks] = useState<PlexItem[]>([]);
  const [totalSize, setTotalSize] = useState<number>();
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string>();
  const albumsTabRef = useRef<HTMLButtonElement>(null);
  const tracksTabRef = useRef<HTMLButtonElement>(null);
  const loadSentinelRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const nextStartRef = useRef(0);
  const totalSizeRef = useRef<number | undefined>(undefined);
  const tabIdBase = `artist-${detail.source.ratingKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const hasMoreTracks = totalSize === undefined || tracks.length < totalSize;

  const loadNextTrackPage = useCallback(async () => {
    if (!serverId || loadingRef.current) return;
    const start = nextStartRef.current;
    if (totalSizeRef.current !== undefined && start >= totalSizeRef.current) return;
    const requestId = ++requestRef.current;
    loadingRef.current = true;
    setTracksLoading(true);
    setTracksError(undefined);
    try {
      const page = await getArtistTracksPage(serverId, detail.source.ratingKey, start, ARTIST_TRACK_PAGE_SIZE);
      if (requestId !== requestRef.current) return;
      setTracks((current) => appendUniqueArtistTracks(current, page.items));
      nextStartRef.current = page.nextStart;
      const resolvedTotalSize = page.items.length
        ? Math.max(page.totalSize, nextStartRef.current)
        : nextStartRef.current;
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
  }, [detail.source.ratingKey, serverId]);

  useEffect(() => () => {
    requestRef.current += 1;
    loadingRef.current = false;
  }, []);

  useEffect(() => {
    if (activeTab === "tracks" && !tracks.length && !tracksLoading && !tracksError) {
      void loadNextTrackPage();
    }
  }, [activeTab, loadNextTrackPage, tracks.length, tracksError, tracksLoading]);

  useEffect(() => {
    const sentinel = loadSentinelRef.current;
    if (activeTab !== "tracks" || !sentinel || tracksLoading || tracksError || !hasMoreTracks) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNextTrackPage();
    }, {
      root: sentinel.closest(".content"),
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

  return (
    <section className="detail-page artist-detail-page">
      <button className="back-button artist-back-button" type="button" onClick={onBack}><ArrowLeft size={18} strokeWidth={2} />返回艺术家列表</button>
      <header className="detail-hero artist-detail-hero">
        <Artwork item={detail.source} size="hero" className="round" />
        <div><h1>{detail.source.title}</h1><p>艺术家</p></div>
      </header>
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
        >歌曲</button>
      </div>
      {activeTab === "albums" ? (
        <div id={`${tabIdBase}-albums-panel`} className="artist-detail-panel" role="tabpanel" aria-labelledby={`${tabIdBase}-albums-tab`}>
          {albums.length
            ? <MediaCardGrid items={albums} round={false} compact={false} onOpen={onOpen} />
            : <EmptyState title="没有专辑" description="Plex 当前没有返回可显示的专辑。" />}
        </div>
      ) : (
        <div id={`${tabIdBase}-tracks-panel`} className="artist-detail-panel artist-tracks-panel" role="tabpanel" aria-labelledby={`${tabIdBase}-tracks-tab`} aria-busy={tracksLoading || undefined}>
          {tracks.length ? <ArtistTrackTable tracks={tracks} totalSize={totalSize} onPlay={onPlayTrack} /> : tracksLoading ? (
            <div className="artist-track-list-state" role="status"><LoaderCircle className="spin" size={21} /><span>正在读取歌曲…</span></div>
          ) : tracksError ? (
            <div className="artist-track-list-state is-error" role="alert"><TriangleAlert size={22} /><strong>无法读取歌曲</strong><button className="secondary-button" type="button" onClick={() => void loadNextTrackPage()}><RefreshCw size={15} />重试</button></div>
          ) : <EmptyState title="没有歌曲" description="Plex 当前没有返回这位艺术家的歌曲。" />}
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

function ArtistTrackTable({ tracks, totalSize, onPlay }: {
  tracks: PlexItem[];
  totalSize?: number;
  onPlay: (track: PlexItem, context: PlexItem[]) => void;
}) {
  return (
    <div className="artist-track-table" role="table" aria-label="艺术家全部歌曲" aria-rowcount={totalSize === undefined ? undefined : totalSize + 1}>
      <div className="artist-track-row artist-track-head" role="row">
        <span role="columnheader">序号</span><span role="columnheader" aria-label="专辑封面" /><span role="columnheader">标题</span><span role="columnheader">歌手</span><span role="columnheader">专辑</span><span role="columnheader">时长</span>
      </div>
      {tracks.map((track, index) => (
        <button
          className="artist-track-row"
          type="button"
          role="row"
          aria-rowindex={index + 2}
          key={`${track.ratingKey}-${index}`}
          onClick={() => onPlay(track, tracks)}
        >
          <span className="artist-track-number" role="cell"><span>{index + 1}</span><Play size={13} fill="currentColor" aria-hidden="true" /></span>
          <span role="cell"><Artwork item={track} size="small" /></span>
          <strong className="truncate" role="cell">{track.title}</strong>
          <span className="truncate" role="cell">{trackArtist(track)}</span>
          <span className="truncate" role="cell">{trackAlbum(track)}</span>
          <span className="duration-cell" role="cell">{formatDuration(track.duration)}</span>
        </button>
      ))}
    </div>
  );
}

function TrackTable({ title, tracks, onPlay }: { title: string; tracks: PlexItem[]; onPlay: (track: PlexItem, context: PlexItem[]) => void }) {
  return (
    <section className="track-section">
      <div className="section-heading"><h1>{title}</h1></div>
      <div className="track-table" role="table" aria-label={title}>
        <div className="track-row table-head" role="row"><span>#</span><span>标题</span><span>专辑</span><span>格式</span><span>时长</span></div>
        {tracks.map((track, index) => (
          <button className="track-row" role="row" key={`${track.ratingKey}-${index}`} onDoubleClick={() => onPlay(track, tracks)} onClick={() => onPlay(track, tracks)}>
            <span className="track-index"><span>{track.index || index + 1}</span><Play size={13} fill="currentColor" /></span>
            <span className="track-title"><Artwork item={track} size="small" /><span><strong>{track.title}</strong><small>{trackArtist(track)}</small></span></span>
            <span className="truncate">{trackAlbum(track)}</span>
            <span className="format-badge">{track.Media?.[0]?.audioCodec?.toUpperCase() || "AUDIO"}</span>
            <span className="duration-cell">{formatDuration(track.duration)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SearchResults({ hubs, query, onOpen, onPlayTrack }: { hubs: PlexHub[]; query: string; onOpen: (item: PlexItem) => void; onPlayTrack: (track: PlexItem, context: PlexItem[]) => void }) {
  const total = hubs.reduce((sum, hub) => sum + hub.items.length, 0);
  if (!query) return <EmptyState title="搜索资料库" description="输入歌曲、专辑或艺术家名称。" icon={<Search size={28} />} />;
  if (!total) return <EmptyState title={`没有找到“${query}”`} description="尝试更短的关键词，或切换到其他音乐资料库。" icon={<Search size={28} />} />;
  return (
    <>
      <div className="page-heading"><div><h1>“{query}”的搜索结果</h1><p>共找到 {total} 项内容</p></div></div>
      {hubs.map((hub, index) => hub.type === "track"
        ? <TrackTable key={`${hub.title}-${index}`} title={hub.title} tracks={hub.items} onPlay={onPlayTrack} />
        : <CardCollection key={`${hub.title}-${index}`} title={hub.title} items={hub.items} round={hub.type === "artist"} compact onOpen={onOpen} />)}
    </>
  );
}

function SettingsView(props: ContentViewProps) {
  return (
    <div className="settings-page">
      <div className="page-heading"><h1>设置</h1></div>
      <SettingsGroup icon={<Minimize2 size={18} />} title="关闭主窗口时">
        <div className="choice-grid">
          <ChoiceCard active={props.closeBehavior === "tray"} title="最小化到托盘 / 菜单栏" icon={<Radio size={20} />} onClick={() => props.onCloseBehavior("tray")} />
          <ChoiceCard active={props.closeBehavior === "quit"} title="退出程序" icon={<Power size={20} />} onClick={() => props.onCloseBehavior("quit")} />
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Sun size={18} />} title="外观">
        <div className="choice-grid three-columns">
          <ChoiceCard active={props.themeMode === "system"} title="跟随系统" icon={<Monitor size={20} />} onClick={() => props.onThemeMode("system")} />
          <ChoiceCard active={props.themeMode === "light"} title="浅色" icon={<Sun size={20} />} onClick={() => props.onThemeMode("light")} />
          <ChoiceCard active={props.themeMode === "dark"} title="深色" icon={<Moon size={20} />} onClick={() => props.onThemeMode("dark")} />
        </div>
      </SettingsGroup>
      <SettingsGroup id={PLAYBACK_SETTINGS_ID} icon={<SlidersHorizontal size={18} />} title="播放">
        <div className="settings-stack">
          <label className="field-row"><span>音频质量</span><select value={props.quality} onChange={(event) => props.onQuality(event.target.value as StreamQuality)}><option value="auto">自动（优先直放 / PMS 兼容转码）</option><option value="original">始终原始质量</option><option value="320">320 kbps</option><option value="256">256 kbps</option><option value="192">192 kbps</option></select></label>
          <label className="toggle-row">
            <span><strong>预缓冲下一首</strong><small>提前加载队列中的下一首。</small></span>
            <input type="checkbox" checked={props.prebufferNext} onChange={(event) => props.onPrebufferNext(event.target.checked)} />
            <span className="toggle-control" aria-hidden="true" />
          </label>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Database size={18} />} title="封面缓存">
        <div className="cache-row">
          <span><strong>{props.cacheStatus ? formatBytes(props.cacheStatus.sizeBytes) : "正在统计…"}</strong><small>{props.cacheStatus ? `${props.cacheStatus.fileCount} 个缓存文件` : "读取缓存状态"}</small></span>
          <button className="secondary-button" type="button" disabled={props.cacheBusy || !props.cacheStatus?.fileCount} onClick={props.onClearCache}>{props.cacheBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}清理缓存</button>
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
          <span className="settings-account-library"><strong>{props.section?.title || "未选择音乐资料库"}</strong><small>{props.server ? `${props.server.owned ? "我的服务器" : "共享资料库"} · ${props.server.name}` : "未选择服务器"}</small></span>
          <button className="danger-button" onClick={props.onLogout}><LogOut size={16} />退出账号</button>
        </div>
      </SettingsGroup>
    </div>
  );
}

function SettingsGroup({ id, icon, title, children }: { id?: string; icon: ReactNode; title: string; children: ReactNode }) {
  return <section id={id} className="settings-group"><header><span className="settings-icon">{icon}</span><div><h2>{title}</h2></div></header><div className="settings-body">{children}</div></section>;
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

function ChoiceCard({ active, title, icon, onClick }: { active: boolean; title: string; icon: ReactNode; onClick: () => void }) {
  return <button className={`choice-card ${active ? "active" : ""}`} onClick={onClick}>{icon}<strong>{title}</strong>{active && <Check className="choice-check" size={16} />}</button>;
}

function QueuePanel({ queue, currentIndex, onSelect, onRemove }: { queue: PlexItem[]; currentIndex: number; onSelect: (track: PlexItem) => void; onRemove: (index: number) => void }) {
  return (
    <aside className="queue-panel" aria-label="播放队列">
      <header><h2>接下来播放</h2></header>
      <div className="queue-list">
        {queue.length ? queue.map((track, index) => (
          <div className={`queue-item ${index === currentIndex ? "active" : ""}`} key={`${track.ratingKey}-${index}`}>
            <button onClick={() => onSelect(track)}><Artwork item={track} size="small" /><span><strong>{track.title}</strong><small>{trackArtist(track)}</small></span></button>
            {index !== currentIndex && <IconButton label="从队列移除" onClick={() => onRemove(index)}><X size={14} /></IconButton>}
          </div>
        )) : <EmptyState title="队列为空" description="选择一首歌曲开始播放。" icon={<ListMusic size={25} />} />}
      </div>
    </aside>
  );
}

function LyricsPanel({ track, lyrics, onSeek }: {
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
    <aside className="lyrics-panel" aria-label="歌词">
      <header><h2>歌词</h2></header>
      <div className="lyrics-context">
        <strong>{track?.title || "尚未播放"}</strong>
        <small>{track ? `${trackArtist(track)} · ${trackAlbum(track)}` : "从资料库选择一首音乐"}</small>
      </div>
      <div
        ref={listRef}
        className="lyrics-list"
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

function CreatePlaylistDialog({ serverId, onClose, onCreated, onError }: {
  serverId: string;
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
    if (!validTitle || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await createPlaylist(serverId, title));
    } catch (reason) {
      const message = playlistCreateErrorMessage(reason);
      setError(message);
      setBusy(false);
      onError(message);
    }
  };

  return (
    <div className="playlist-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="playlist-create-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-create-title" tabIndex={-1}>
        <header>
          <div>
            <h2 id="playlist-create-title">新建播放列表</h2>
            <small>在当前 Plex 账号中创建</small>
          </div>
          <IconButton label="关闭新建播放列表" disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="playlist-create-content">
            <label htmlFor="playlist-create-name">播放列表名称</label>
            <input
              ref={inputRef}
              id="playlist-create-name"
              value={title}
              maxLength={255}
              required
              placeholder="例如：周末慢听"
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "playlist-create-description playlist-create-error" : "playlist-create-description"}
              disabled={busy}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(undefined);
              }}
            />
            <p id="playlist-create-description">先创建一个空白普通音乐播放列表，之后可从歌曲菜单继续添加内容。</p>
            {error && <p id="playlist-create-error" className="playlist-create-error" role="alert">{error}</p>}
          </div>
          <footer>
            <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={!validTitle || busy} aria-busy={busy || undefined}>
              {busy ? <><LoaderCircle className="spin" size={15} />正在创建…</> : "创建"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function PlaylistPicker({ serverId, track, onClose, onAdded }: {
  serverId: string;
  track: PlexItem;
  onClose: () => void;
  onAdded: (playlist: PlexPlaylist) => void;
}) {
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

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
      if (event.key === "Escape" && !busyId) {
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
  }, [busyId, onClose]);

  const add = async (playlist: PlexPlaylist) => {
    setBusyId(playlist.ratingKey);
    setError(undefined);
    try {
      await addTrackToPlaylist(serverId, playlist.ratingKey, track.ratingKey);
      onAdded(playlist);
    } catch (reason) {
      setError(playlistErrorMessage(reason));
      setBusyId(undefined);
    }
  };

  return (
    <div className="playlist-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busyId && onClose()}>
      <section ref={dialogRef} className="playlist-picker" role="dialog" aria-modal="true" aria-labelledby="playlist-picker-title">
        <header>
          <div>
            <h2 id="playlist-picker-title" ref={titleRef} tabIndex={-1}>添加到播放列表</h2>
            <small>《{track.title}》 · {trackArtist(track)}</small>
          </div>
          <IconButton label="关闭播放列表选择" disabled={Boolean(busyId)} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="playlist-picker-list" aria-busy={loading || undefined}>
          {loading ? (
            <div className="playlist-picker-state"><LoaderCircle className="spin" size={22} /><span>正在读取音乐播放列表…</span></div>
          ) : error && !playlists.length ? (
            <div className="playlist-picker-state is-error"><ListMusic size={24} /><strong>无法读取播放列表</strong><span>{error}</span></div>
          ) : !playlists.length ? (
            <div className="playlist-picker-state"><ListMusic size={24} /><strong>没有可写入的音乐播放列表</strong><span>智能播放列表不会显示；共享服务器也可能没有写入权限。</span></div>
          ) : playlists.map((playlist) => (
            <button
              className="playlist-picker-option"
              type="button"
              key={playlist.ratingKey}
              disabled={Boolean(busyId)}
              onClick={() => void add(playlist)}
            >
              <span className="playlist-picker-option-icon"><ListMusic size={18} /></span>
              <span><strong>{playlist.title}</strong><small>{playlist.leafCount ?? 0} 首歌曲{playlist.summary ? ` · ${playlist.summary}` : ""}</small></span>
              {busyId === playlist.ratingKey ? <LoaderCircle className="spin" size={17} /> : <span className="playlist-picker-add">添加</span>}
            </button>
          ))}
        </div>
        {error && playlists.length > 0 && <p className="playlist-picker-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function PlayerBar({ player, loading, buffering, nowPlayingTriggerRef, expanded, queueOpen, lyricsOpen, devicesOpen, outputPlatform, canOpenNowPlaying, canToggleQueue, canToggleLyrics, onOpenNowPlaying, onToggleQueue, onToggleLyrics, onOutputAction }: {
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
  onOutputAction: () => void;
}) {
  const volumeIcon = player.muted || player.volume === 0 ? <VolumeX size={18} /> : player.volume < 0.5 ? <Volume1 size={18} /> : <Volume2 size={18} />;
  const progressFill = rangeFillPercent(player.progress, player.duration);
  const volumeFill = rangeFillPercent(player.muted ? 0 : player.volume, 1);
  const playbackBusy = loading || buffering;
  const playbackLabel = playbackControlLabel({ playing: player.playing, loading, buffering });
  const cycleRepeat = () => player.setRepeat(player.repeat === "off" ? "all" : player.repeat === "all" ? "one" : "off");
  return (
    <footer className={`player-bar ${expanded ? "is-expanded" : ""}`} aria-label="播放器" aria-hidden={expanded || undefined} inert={expanded || undefined}>
      <button ref={nowPlayingTriggerRef} className="now-playing now-playing-trigger" type="button" disabled={!canOpenNowPlaying} onClick={onOpenNowPlaying} aria-label={player.current ? `展开正在播放：${player.current.title}` : "尚未播放"}>
        <Artwork item={player.current} size="player" />
        <span><strong>{player.current?.title || "尚未播放"}</strong><small>{player.current ? trackArtist(player.current) : "从资料库选择音乐"}</small></span>
      </button>
      <div className="player-center">
        <div className="transport-controls">
          <IconButton label={player.shuffle ? "关闭随机播放（当前列表）" : "随机播放当前列表"} active={player.shuffle} onClick={() => player.setShuffle(!player.shuffle)}><Shuffle size={16} /></IconButton>
          <IconButton label="上一首" onClick={player.previous}><SkipBack size={19} fill="currentColor" /></IconButton>
          <button
            className={`play-button ${playbackBusy ? "is-loading" : ""}`}
            aria-label={playbackLabel}
            title={playbackLabel}
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
          <IconButton label="下一首" onClick={player.next}><SkipForward size={19} fill="currentColor" /></IconButton>
          <IconButton label={player.repeat === "one" ? "单曲循环" : player.repeat === "all" ? "当前列表循环" : "顺序播放，列表结束后停止"} active={player.repeat !== "off"} onClick={cycleRepeat}>{player.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}</IconButton>
        </div>
        <div className="progress-row"><span>{formatDuration(player.progress * 1000)}</span><input aria-label="播放进度" type="range" min="0" max={Math.max(1, player.duration)} step="1" value={Math.min(player.progress, player.duration || 0)} style={{ "--range-progress": `${progressFill}%` } as CSSProperties} onChange={(event) => player.seek(Number(event.target.value))} /><span>{formatDuration(player.duration * 1000)}</span></div>
      </div>
      <div className="player-extras">
        <IconButton
          label={lyricsOpen ? "关闭歌词" : canToggleLyrics ? "打开歌词" : canOpenNowPlaying ? "这首歌暂无歌词" : "请先播放歌曲"}
          active={lyricsOpen}
          disabled={!canToggleLyrics}
          onClick={onToggleLyrics}
        >
          <Captions size={19} />
        </IconButton>
        <IconButton label="播放队列" active={queueOpen} disabled={!canToggleQueue} onClick={onToggleQueue}><ListMusic size={19} /></IconButton>
        {outputPlatform !== "macos" && <IconButton label="播放设备" active={devicesOpen} onClick={onOutputAction}><Speaker size={18} /></IconButton>}
        <div className="volume-control">
          <IconButton label={player.muted ? "取消静音" : "静音"} onClick={() => player.setMuted(!player.muted)}>{volumeIcon}</IconButton>
          <div className="volume-popover">
            <input aria-label="播放器独立音量" aria-orientation="vertical" aria-valuetext={`${Math.round((player.muted ? 0 : player.volume) * 100)}%`} title={`音量 ${Math.round((player.muted ? 0 : player.volume) * 100)}%`} type="range" min="0" max="1" step="0.01" value={player.muted ? 0 : player.volume} style={{ "--range-progress": `${volumeFill}%` } as CSSProperties} onChange={(event) => player.setVolume(Number(event.target.value))} />
            <output aria-live="polite">{Math.round((player.muted ? 0 : player.volume) * 100)}%</output>
          </div>
        </div>
      </div>
    </footer>
  );
}

function LoginScreen({ clientIdentifier, onAuthenticated }: { clientIdentifier: string; onAuthenticated: () => void | Promise<void> }) {
  const login = usePlexLogin(clientIdentifier, onAuthenticated);

  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand"><span className="brand-mark large"><BrandIcon size={28} /></span><span>Cadilume</span></div>
        <h1>连接 Plex 音乐资料库</h1>
        <p className="login-copy">使用系统浏览器安全登录。免费账号只要获得服务器音乐库共享权限，也可以正常浏览和播放。</p>
        <div className="login-features"><span><Check size={16} />独立播放器音量</span><span><Check size={16} />家庭与共享服务器</span><span><Check size={16} />明确的托盘退出入口</span></div>
        <button className="primary-button login-button" onClick={() => void login.start()} disabled={login.busy} aria-busy={login.busy || undefined}>{login.busy ? <LoaderCircle className="spin" size={18} /> : <CircleUserRound size={18} />}{login.buttonLabel}</button>
        {login.error && <p className="form-error" role="alert">{login.error}</p>}
        <small className="login-legal">仅请求当前账号已获授权的服务器和音乐库，不绕过 Plex 权限。</small>
      </section>
      <aside className="login-art" aria-hidden="true"><div className="record record-one" /><div className="record record-two" /><div className="sound-lines">{Array.from({ length: 34 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 23) % 92)}px` }} />)}</div></aside>
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

function IconButton({ label, active = false, disabled = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  return <button type="button" className={`icon-button ${active ? "active" : ""}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function GlobalToast({ message, onClose }: { message: string; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), 4_200);
    return () => window.clearTimeout(timer);
  }, [message]);
  return <div className="global-toast" role="status" aria-live="polite" aria-atomic="true"><span className="global-toast-mark" aria-hidden="true" /><span>{message}</span><IconButton label="关闭提示" onClick={onClose}><X size={16} /></IconButton></div>;
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
          <button ref={retryRef} className="primary-button" type="button" onClick={onRetry}><RefreshCw size={16} />重试播放</button>
          <button className="secondary-button" type="button" onClick={onOpenSettings}><SlidersHorizontal size={16} />前往播放设置</button>
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

function SplashScreen() {
  return (
    <main className="splash-screen">
      <section className="splash-card" aria-live="polite" aria-busy="true">
        <span className="brand-mark splash-mark"><BrandIcon size={38} /></span>
        <h1>Cadilume</h1>
        <p>正在恢复桌面音乐资料库的账号、音乐来源与上次播放现场。</p>
        <div className="splash-progress" role="status"><LoaderCircle className="spin" size={24} /><span>正在连接你的音乐资料库…</span></div>
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
    return "当前账号无法读取这个播放列表，或播放列表已被服务器移除。共享服务器会继续服从 Plex Media Server 的访问权限。";
  }
  return message;
}

function playlistCreateErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/\b(?:401|403)\b|forbidden|permission|unauthori[sz]ed|无权|权限/iu.test(message)) {
    return "当前账号没有在这台 Plex 服务器创建播放列表的权限。";
  }
  return message;
}

function playlistErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/\b(?:401|403|404)\b|forbidden|not found|permission|unauthori[sz]ed|无权|权限/iu.test(message)) {
    return "当前账号没有写入这个播放列表的权限，或播放列表已被服务器移除。共享账号需要服务器所有者授予写入权限。";
  }
  return message;
}

function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("cadilume-theme");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "light" : "dark") : mode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    if (mode !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "cadilume-theme") return;
      const next = event.newValue;
      if (next === "light" || next === "dark" || next === "system") setMode(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((next: ThemeMode) => {
    localStorage.setItem("cadilume-theme", next);
    setMode(next);
  }, []);

  return [mode, update];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export default App;

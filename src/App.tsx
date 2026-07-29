import {
  Airplay,
  Album,
  ArrowLeft,
  Captions,
  Check,
  CircleUserRound,
  Database,
  HardDrive,
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
  Power,
  Radio,
  RefreshCw,
  Repeat,
  Repeat1,
  Search,
  Server,
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
  X,
} from "lucide-react";
import { createContext, FormEvent, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  artworkUrl,
  addTrackToPlaylist,
  bootstrap,
  clearArtworkCache,
  discoverServers,
  getCacheStatus,
  getChildren,
  getLibraryItems,
  getPlaylists,
  getRecentAlbums,
  getSections,
  isDesktopRuntime,
  logout,
  openWindowsAudioSettings,
  searchLibrary,
  setCloseBehavior as saveCloseBehavior,
  showMainWindow,
} from "./api";
import "./App.css";
import { getCenteredLyricsScrollTop, NowPlayingView, type NowPlayingLyricsState, type NowPlayingMode } from "./NowPlayingView";
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
import { activateOutputControl, useOutputDevices } from "./useOutputDevices";
import { useLyrics } from "./useLyrics";
import { usePlexLogin } from "./usePlexLogin";
import { BrandIcon } from "./BrandIcon";

type Icon = typeof Home;

const navigation: Array<{ id: LibraryView; label: string; icon: Icon }> = [
  { id: "home", label: "主页", icon: Home },
  { id: "albums", label: "专辑", icon: Album },
  { id: "artists", label: "艺术家", icon: Mic2 },
  { id: "tracks", label: "歌曲", icon: Music2 },
];

const ArtworkServerContext = createContext<string | undefined>(undefined);
const artworkCache = new Map<string, Promise<string>>();
const NOW_PLAYING_MODE_STORAGE_KEY = "cadilume-now-playing-mode";
const PLAYBACK_SETTINGS_ID = "playback-settings";

function App() {
  const [themeMode, setThemeMode] = useThemeMode();
  return <MainApplication themeMode={themeMode} onThemeMode={setThemeMode} />;
}

function MainApplication({ themeMode, onThemeMode }: { themeMode: ThemeMode; onThemeMode: (mode: ThemeMode) => void }) {
  const [session, setSession] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void showMainWindow().catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setSession(await bootstrap());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
  const [searchHubs, setSearchHubs] = useState<PlexHub[]>([]);
  const [searchText, setSearchText] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [sidePanel, setSidePanel] = useState<"queue" | "lyrics" | "devices" | null>(null);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMode, setNowPlayingMode] = useState<NowPlayingMode>(readNowPlayingMode);
  const [playlistTrack, setPlaylistTrack] = useState<PlexItem>();
  const [detail, setDetail] = useState<{ source: PlexItem; children: PlexItem[] }>();
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>(initialSession.closeBehavior);
  const [quality, setQuality] = useState<StreamQuality>(() => readStoredQuality(initialPlaybackSession?.quality));
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>();
  const [cacheBusy, setCacheBusy] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [sourcesSyncing, setSourcesSyncing] = useState(false);
  const [playbackSettingsRequest, setPlaybackSettingsRequest] = useState(0);
  const [playbackFailurePreview, setPlaybackFailurePreview] = useState<PlaybackFailure>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const nowPlayingTriggerRef = useRef<HTMLButtonElement>(null);
  const loadedSectionRef = useRef<string | undefined>(undefined);
  const preferredPlaybackServerId = initialPlaybackSession?.serverId;
  const player = usePlayer(serverId, quality);
  const outputDevices = useOutputDevices(player.setOutputSinkId);
  const lyrics = useLyrics(serverId, player.current, player.progress, player.duration);
  const previewLyricsCountParam = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("now-playing-preview-lines")
    : null;
  const parsedPreviewLyricsCount = previewLyricsCountParam === null
    ? null
    : Number.parseInt(previewLyricsCountParam, 10);
  const previewLyricsCount = parsedPreviewLyricsCount === null || !Number.isFinite(parsedPreviewLyricsCount)
    ? null
    : Math.min(120, Math.max(0, parsedPreviewLyricsCount));
  const nowPlayingLyrics = previewLyricsCount === null ? lyrics : {
    document: {
      format: "plain" as const,
      timed: true,
      offsetMs: 0,
      provider: "Cadilume 布局预览",
      lines: Array.from({ length: previewLyricsCount }, (_, index) => ({
        id: `layout-preview-${index}`,
        startMs: index * 2_000,
        endMs: (index + 1) * 2_000,
        texts: [`布局预览歌词第 ${index + 1} 行${index % 4 === 0 ? "，用于验证长文本与独立滚动" : ""}`],
      })),
    },
    loading: false,
    error: undefined,
    activeIndex: previewLyricsCount > 0
      ? Math.min(previewLyricsCount - 1, Math.max(0, Math.floor(player.progress / 2)))
      : -1,
  };
  const hasCurrentTrack = Boolean(player.current);
  const hasQueue = hasCurrentTrack && player.queue.length > 0;
  const expandedPlayerOpen = nowPlayingOpen && hasCurrentTrack;
  const queuePanelOpen = sidePanel === "queue" && hasQueue;
  const lyricsPanelOpen = sidePanel === "lyrics";
  const previewPlaybackFailure = import.meta.env.DEV
    && new URLSearchParams(window.location.search).has("playback-error-preview");
  const activePlaybackFailure = player.playbackFailure ?? playbackFailurePreview;

  const selectedServer = servers.find((server) => server.id === serverId);
  const selectedSection = sections.find((section) => section.key === sectionKey);
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
      setServerId((current) => {
        if (result.some((server) => server.id === current)) return current;
        if (result.some((server) => server.id === preferredPlaybackServerId)) return preferredPlaybackServerId;
        return result[0]?.id;
      });
      setSourceRevision((revision) => revision + 1);
      if (!result.length) setNotice("当前账号没有发现可访问的 Plex Media Server。请先让服务器所有者共享音乐库。" );
      return true;
    } catch (reason) {
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
        setSections(result);
        setSectionKey((current) => result.some((section) => section.key === current) ? current : result[0]?.key);
        if (!result.length) setNotice("这台服务器没有向当前账号开放音乐资料库。" );
      })
      .catch((reason) => !cancelled && setNotice(String(reason)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [serverId, sourceRevision]);

  const loadView = useCallback(async (nextView: LibraryView) => {
    setView(nextView);
    setDetail(undefined);
    if (nextView === "settings") setSidePanel(null);
    if (!serverId || !sectionKey || nextView === "settings" || nextView === "search") return;
    setLoading(true);
    setNotice(undefined);
    try {
      if (nextView === "home") setItems(await getRecentAlbums(serverId, sectionKey));
      if (nextView === "albums") setItems(await getLibraryItems(serverId, sectionKey, 9));
      if (nextView === "artists") setItems(await getLibraryItems(serverId, sectionKey, 8));
      if (nextView === "tracks") setItems(await getLibraryItems(serverId, sectionKey, 10));
    } catch (reason) {
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

  const submitSearch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const query = searchText.trim();
    if (!serverId || !sectionKey || !query) return;
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
  }, [searchText, sectionKey, serverId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const isInteractiveTarget = Boolean(target?.closest("input, textarea, select, button, a, [contenteditable]:not([contenteditable='false'])"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (nowPlayingOpen || playlistTrack) return;
        searchInputRef.current?.focus();
        return;
      }
      if (event.code === "Space" && !playlistTrack && !isInteractiveTarget) {
        event.preventDefault();
        player.toggle();
      }
      if (event.key === "Escape" && !playlistTrack && !nowPlayingOpen) setSidePanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nowPlayingOpen, player, playlistTrack]);

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
    if (tracks[0]) player.playContext(tracks[0], tracks);
  };

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
            <button className={`nav-item ${view === id ? "active" : ""}`} key={id} onClick={() => void loadView(id)}>
              <NavIcon size={18} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className={`account-button ${view === "settings" ? "active" : ""}`} aria-current={view === "settings" ? "page" : undefined} onClick={() => void loadView("settings")}>
            <Avatar account={account} />
            <span><strong>{account.title || account.username}</strong><small>{selectedServer ? (selectedServer.owned ? "我的服务器" : "共享资料库") : "选择音乐来源"}</small></span>
          </button>
        </div>
      </aside>

      <section className="workspace" aria-hidden={expandedPlayerOpen || undefined} inert={expandedPlayerOpen || undefined}>
        <header className="topbar">
          <form className="searchbox" onSubmit={submitSearch} role="search">
            <Search size={17} />
            <input ref={searchInputRef} value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索歌曲、专辑或艺术家" aria-label="搜索资料库" />
            <kbd>{outputDevices.platform === "macos" ? "⌘ K" : "Ctrl K"}</kbd>
          </form>
          <div className="topbar-actions">
            {selectedServer && <span className="connection-pill"><span className="status-dot" />{selectedServer.local ? "本地直连" : selectedServer.relay ? "Plex Relay" : "远程直连"}</span>}
          </div>
        </header>

        <main id="main-content" className="content" tabIndex={-1}>
          {notice && <Notice message={notice} onClose={() => setNotice(undefined)} />}
          {loading && !items.length ? <LoadingState /> : (
            <ContentView
              view={view}
              items={items}
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
              sourcesSyncing={sourcesSyncing}
              closeBehavior={closeBehavior}
              quality={quality}
              themeMode={themeMode}
              prebufferNext={player.prebufferNext}
              cacheStatus={cacheStatus}
              cacheBusy={cacheBusy}
              onOpen={openItem}
              onBack={() => setDetail(undefined)}
              onPlayDetail={playDetail}
              onPlayTrack={(track, context) => player.playContext(track, context)}
              onCloseBehavior={changeCloseBehavior}
              onQuality={changeQuality}
              onThemeMode={onThemeMode}
              onServerChange={setServerId}
              onSectionChange={setSectionKey}
              onSyncSources={() => void syncSources()}
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
          onClose={() => setSidePanel(null)}
          onSelect={(track) => player.playContext(track, player.queue)}
          onRemove={player.removeFromQueue}
        />
      )}

      {lyricsPanelOpen && (
        <LyricsPanel
          track={player.current}
          lyrics={nowPlayingLyrics}
          onClose={() => setSidePanel(null)}
          onSeek={player.seek}
        />
      )}

      {sidePanel === "devices" && (
        <DevicesPanel
          output={outputDevices}
          player={player}
          onClose={() => setSidePanel(null)}
        />
      )}

      <NowPlayingView
        open={expandedPlayerOpen}
        mode={nowPlayingMode}
        onModeChange={changeNowPlayingMode}
        track={player.current}
        playing={player.playing}
        lyrics={nowPlayingLyrics}
        artwork={<Artwork item={player.current} size="immersive" />}
        backgroundArtwork={<Artwork item={player.current} size="backdrop" preferArt />}
        progressSeconds={player.progress}
        durationSeconds={player.duration}
        shuffle={player.shuffle}
        repeat={player.repeat}
        muted={player.muted}
        volume={player.volume}
        theme={themeMode}
        onSeek={player.seek}
        onShuffleChange={player.setShuffle}
        onPrevious={player.previous}
        onTogglePlayback={player.toggle}
        onNext={player.next}
        onRepeatChange={player.setRepeat}
        onMutedChange={player.setMuted}
        onVolumeChange={player.setVolume}
        onClose={closeNowPlaying}
        escapeEnabled={!playlistTrack && !activePlaybackFailure}
        onOpenLyrics={() => {
          setNowPlayingOpen(false);
          setPlaylistTrack(undefined);
          setSidePanel("lyrics");
        }}
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

      <PlayerBar
        player={player}
        nowPlayingTriggerRef={nowPlayingTriggerRef}
        expanded={expandedPlayerOpen}
        queueOpen={queuePanelOpen}
        lyricsOpen={lyricsPanelOpen}
        devicesOpen={sidePanel === "devices"}
        outputPlatform={outputDevices.platform}
        canOpenNowPlaying={hasCurrentTrack}
        canToggleQueue={hasQueue}
        canToggleLyrics={hasCurrentTrack}
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
          if (!player.current) return;
          setNowPlayingOpen(false);
          setPlaylistTrack(undefined);
          setSidePanel((value) => value === "lyrics" ? null : "lyrics");
        }}
        onOutputAction={() => {
          const result = activateOutputControl(
            outputDevices.platform,
            hasCurrentTrack,
            player.showAirPlayPicker,
            () => {
              setNowPlayingOpen(false);
              setPlaylistTrack(undefined);
              setSidePanel((value) => value === "devices" ? null : "devices");
            },
          );
          if (result === "missing-track") {
            setNotice("请先播放一首歌曲，再选择 AirPlay 设备。");
          } else if (result === "airplay-unavailable") {
            setNotice("当前 macOS WebView 没有提供 AirPlay 选择器，请从控制中心的“声音”菜单选择 AirPlay 设备。");
          }
        }}
      />
    </div>
    </ArtworkServerContext.Provider>
  );
}

interface ContentViewProps {
  view: LibraryView;
  items: PlexItem[];
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
  sourcesSyncing: boolean;
  closeBehavior: CloseBehavior;
  quality: StreamQuality;
  themeMode: ThemeMode;
  prebufferNext: boolean;
  cacheStatus?: CacheStatus;
  cacheBusy: boolean;
  onOpen: (item: PlexItem) => void;
  onBack: () => void;
  onPlayDetail: () => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
  onCloseBehavior: (value: CloseBehavior) => void;
  onQuality: (value: StreamQuality) => void;
  onThemeMode: (value: ThemeMode) => void;
  onServerChange: (value: string) => void;
  onSectionChange: (value: string) => void;
  onSyncSources: () => void;
  onPrebufferNext: (value: boolean) => void;
  onClearCache: () => void;
  onLogout: () => void;
}

function ContentView(props: ContentViewProps) {
  if (props.view === "settings") return <SettingsView {...props} />;
  if (props.detail) return <DetailView detail={props.detail} onBack={props.onBack} onPlay={props.onPlayDetail} onOpen={props.onOpen} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "search") return <SearchResults hubs={props.hubs} query={props.searchText} onOpen={props.onOpen} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "tracks") return <TrackTable title="歌曲" subtitle={`${props.items.length} 首已载入`} tracks={props.items} onPlay={props.onPlayTrack} />;
  if (props.view === "artists") return <CardCollection title="艺术家" subtitle="按名字浏览资料库" items={props.items} round onOpen={props.onOpen} />;
  if (props.view === "albums") return <CardCollection title="专辑" subtitle="资料库中的全部专辑" items={props.items} onOpen={props.onOpen} />;
  return (
    <>
      <div className="page-heading home-heading">
        <div><p className="eyebrow">{props.section?.title || "音乐资料库"}</p><h1>{greeting()}，{props.account.title || props.account.username}</h1><p>从最近加入的专辑开始，或使用顶部快捷搜索整个资料库。</p></div>
        <div className="library-stat"><HardDrive size={18} /><span><strong>{props.server?.name || "Plex Server"}</strong><small>{props.server?.owned ? "你拥有的服务器" : sharedSourceLabel(props.server?.sourceTitle)}</small></span></div>
      </div>
      <CardCollection title="最近加入" subtitle="服务器中最新的音乐" items={props.items} onOpen={props.onOpen} compact />
    </>
  );
}

function CardCollection({ title, subtitle, items, round = false, compact = false, onOpen }: { title: string; subtitle: string; items: PlexItem[]; round?: boolean; compact?: boolean; onOpen: (item: PlexItem) => void }) {
  return (
    <section className="collection-section">
      <div className="section-heading"><div><h1>{title}</h1><p>{subtitle}</p></div><span>{items.length} 项</span></div>
      {items.length ? (
        <div className={`card-grid ${compact ? "compact" : ""}`}>
          {items.map((item) => (
            <button className="media-card" key={item.ratingKey} onClick={() => onOpen(item)}>
              <Artwork item={item} className={round ? "round" : ""} size="large" />
              <span className="card-play"><Play size={18} fill="currentColor" /></span>
              <strong>{item.title}</strong>
              <small>{item.parentTitle || (item.type === "artist" ? "艺术家" : item.year || "专辑")}</small>
            </button>
          ))}
        </div>
      ) : <EmptyState title={`没有${title}`} description="当前资料库没有返回可显示的内容。" />}
    </section>
  );
}

function DetailView({ detail, onBack, onPlay, onOpen, onPlayTrack }: { detail: { source: PlexItem; children: PlexItem[] }; onBack: () => void; onPlay: () => void; onOpen: (item: PlexItem) => void; onPlayTrack: (track: PlexItem, context: PlexItem[]) => void }) {
  const tracks = detail.children.filter((item) => item.type === "track");
  const albums = detail.children.filter((item) => item.type === "album");
  return (
    <>
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} />返回</button>
      <header className="detail-hero">
        <Artwork item={detail.source} size="hero" className={detail.source.type === "artist" ? "round" : ""} />
        <div><p className="eyebrow">{detail.source.type === "artist" ? "艺术家" : "专辑"}</p><h1>{detail.source.title}</h1><p>{detail.source.parentTitle || detail.source.summary || `${detail.children.length} 项内容`}</p>{tracks.length > 0 && <button className="primary-button" onClick={onPlay}><Play size={17} fill="currentColor" />播放</button>}</div>
      </header>
      {tracks.length > 0 && <TrackTable title="曲目" tracks={tracks} onPlay={onPlayTrack} />}
      {albums.length > 0 && <CardCollection title="专辑" subtitle={`${detail.source.title} 的作品`} items={albums} onOpen={onOpen} />}
    </>
  );
}

function TrackTable({ title, subtitle, tracks, onPlay }: { title: string; subtitle?: string; tracks: PlexItem[]; onPlay: (track: PlexItem, context: PlexItem[]) => void }) {
  return (
    <section className="track-section">
      <div className="section-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div></div>
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
      <div className="page-heading"><div><p className="eyebrow">搜索结果</p><h1>“{query}”</h1><p>共找到 {total} 项内容</p></div></div>
      {hubs.map((hub, index) => hub.type === "track"
        ? <TrackTable key={`${hub.title}-${index}`} title={hub.title} tracks={hub.items} onPlay={onPlayTrack} />
        : <CardCollection key={`${hub.title}-${index}`} title={hub.title} subtitle="" items={hub.items} round={hub.type === "artist"} compact onOpen={onOpen} />)}
    </>
  );
}

function SettingsView(props: ContentViewProps) {
  return (
    <div className="settings-page">
      <div className="page-heading"><div><p className="eyebrow">偏好设置</p><h1>设置</h1><p>桌面窗口、播放、缓存和账号。</p></div></div>
      <SettingsGroup icon={<Minimize2 size={18} />} title="关闭主窗口时" description="无论选择哪一种，菜单栏或通知区域都会提供明确的退出入口。">
        <div className="choice-grid">
          <ChoiceCard active={props.closeBehavior === "tray"} title="最小化到托盘 / 菜单栏" description="继续后台播放，通过状态图标再次打开或退出。" icon={<Radio size={21} />} onClick={() => props.onCloseBehavior("tray")} />
          <ChoiceCard active={props.closeBehavior === "quit"} title="退出程序" description="点击系统关闭按钮后停止播放并结束进程。" icon={<Power size={21} />} onClick={() => props.onCloseBehavior("quit")} />
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Sun size={18} />} title="外观" description="主窗口会统一使用所选主题；跟随系统会响应 macOS 或 Windows 的外观变化。">
        <div className="choice-grid three-columns">
          <ChoiceCard active={props.themeMode === "system"} title="跟随系统" description="自动切换浅色与深色。" icon={<Monitor size={21} />} onClick={() => props.onThemeMode("system")} />
          <ChoiceCard active={props.themeMode === "light"} title="浅色" description="明亮、柔和的资料库界面。" icon={<Sun size={21} />} onClick={() => props.onThemeMode("light")} />
          <ChoiceCard active={props.themeMode === "dark"} title="深色" description="适合夜间与低光环境。" icon={<Moon size={21} />} onClick={() => props.onThemeMode("dark")} />
        </div>
      </SettingsGroup>
      <SettingsGroup id={PLAYBACK_SETTINGS_ID} icon={<SlidersHorizontal size={18} />} title="播放质量" description="直放保留原始音质；遇到不兼容格式或 Relay 带宽限制时可转码。">
        <div className="settings-stack">
          <label className="field-row"><span>音频质量</span><select value={props.quality} onChange={(event) => props.onQuality(event.target.value as StreamQuality)}><option value="auto">自动（本地直放 / 远程转码）</option><option value="original">始终原始质量</option><option value="320">320 kbps</option><option value="256">256 kbps</option><option value="192">192 kbps</option></select></label>
          <label className="toggle-row">
            <span><strong>预缓冲下一首</strong><small>空闲时只提前加载队列中的下一首，减少远程串流切歌等待；随机播放时不预测。</small></span>
            <input type="checkbox" checked={props.prebufferNext} onChange={(event) => props.onPrebufferNext(event.target.checked)} />
            <span className="toggle-control" aria-hidden="true" />
          </label>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Database size={18} />} title="封面缓存" description="可视区域附近的封面会提前读取并安全缓存到本机，Plex token 不写入图片地址。">
        <div className="cache-row">
          <span><strong>{props.cacheStatus ? formatBytes(props.cacheStatus.sizeBytes) : "正在统计…"}</strong><small>{props.cacheStatus ? `${props.cacheStatus.fileCount} 个缓存文件` : "读取缓存状态"}</small></span>
          <button className="secondary-button" type="button" disabled={props.cacheBusy || !props.cacheStatus?.fileCount} onClick={props.onClearCache}>{props.cacheBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}清理缓存</button>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Server size={18} />} title="音乐来源" description="在这里选择 Cadilume 浏览和播放使用的服务器与音乐资料库；共享服务器始终使用当前账号的专属访问令牌。">
        <div className="settings-stack">
          <label className="field-row">
            <span><strong>服务器</strong><small>当前账号有权访问的 Plex Media Server</small></span>
            <select aria-label="Plex 服务器" value={props.serverId || ""} disabled={!props.servers.length} onChange={(event) => props.onServerChange(event.target.value)}>
              {!props.servers.length && <option value="">未发现服务器</option>}
              {props.servers.map((server) => <option value={server.id} key={server.id}>{server.name}</option>)}
            </select>
          </label>
          <label className="field-row">
            <span><strong>音乐资料库</strong><small>只显示服务器向当前账号开放的 Music 类型资料库</small></span>
            <select aria-label="音乐资料库" value={props.sectionKey || ""} disabled={!props.sections.length} onChange={(event) => props.onSectionChange(event.target.value)}>
              {!props.sections.length && <option value="">未发现音乐资料库</option>}
              {props.sections.map((section) => <option value={section.key} key={section.key}>{section.title}</option>)}
            </select>
          </label>
          <div className="source-sync-row">
            <span>{props.server ? `${props.server.owned ? "所有者" : "家庭 / 共享访问"} · ${props.server.local ? "本地直连" : props.server.relay ? "Plex Relay" : "远程直连"}` : "尚未连接音乐来源"}</span>
            <button className="secondary-button" type="button" disabled={props.sourcesSyncing} onClick={props.onSyncSources}>{props.sourcesSyncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}同步资料</button>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<CircleUserRound size={18} />} title="Plex 账号" description={`${props.account.email} · 账号凭据保存在系统钥匙串，不写入浏览器存储。`}>
        <div className="settings-actions"><button className="danger-button" onClick={props.onLogout}><LogOut size={16} />退出账号</button></div>
      </SettingsGroup>
      <p className="legal-note">Cadilume 是独立客户端原型，与 Plex, Inc. 无隶属关系；只访问服务器已授予当前账号的内容。</p>
    </div>
  );
}

function SettingsGroup({ id, icon, title, description, children }: { id?: string; icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return <section id={id} className="settings-group"><header><span className="settings-icon">{icon}</span><div><h2>{title}</h2><p>{description}</p></div></header><div className="settings-body">{children}</div></section>;
}

function ChoiceCard({ active, title, description, icon, onClick }: { active: boolean; title: string; description: string; icon: ReactNode; onClick: () => void }) {
  return <button className={`choice-card ${active ? "active" : ""}`} onClick={onClick}>{icon}<span><strong>{title}</strong><small>{description}</small></span>{active && <Check className="choice-check" size={16} />}</button>;
}

function QueuePanel({ queue, currentIndex, onClose, onSelect, onRemove }: { queue: PlexItem[]; currentIndex: number; onClose: () => void; onSelect: (track: PlexItem) => void; onRemove: (index: number) => void }) {
  return (
    <aside className="queue-panel" aria-label="播放队列">
      <header><div><p className="eyebrow">接下来播放</p><h2>队列</h2></div><IconButton label="关闭队列" onClick={onClose}><X size={18} /></IconButton></header>
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

function LyricsPanel({ track, lyrics, onClose, onSeek }: {
  track?: PlexItem;
  lyrics: NowPlayingLyricsState;
  onClose: () => void;
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
    list.scrollTo({
      top: getCenteredLyricsScrollTop({
        scrollTop: list.scrollTop,
        viewportHeight: list.clientHeight,
        contentHeight: list.scrollHeight,
        targetTop: nodeRect.top - listRect.top,
        targetHeight: nodeRect.height,
      }),
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeIndex, lines, lyrics.document?.timed, trackIdentity]);

  return (
    <aside className="lyrics-panel" aria-label="歌词">
      <header>
        <div><p className="eyebrow">正在播放</p><h2>歌词</h2></div>
        <IconButton label="关闭歌词" onClick={onClose}><X size={18} /></IconButton>
      </header>
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
      {lyrics.document && (
        <footer className="lyrics-attribution">
          <span>{lyrics.document.timed ? "时间轴歌词" : "纯文本歌词"}</span>
          <small>{lyrics.document.by || lyrics.document.author || lyrics.document.provider || "Plex 服务器"}</small>
        </footer>
      )}
    </aside>
  );
}

function DevicesPanel({ output, player, onClose }: {
  output: ReturnType<typeof useOutputDevices>;
  player: ReturnType<typeof usePlayer>;
  onClose: () => void;
}) {
  const hasTrack = Boolean(player.current);
  const openAirPlay = async () => {
    output.setMessage(undefined);
    if (!hasTrack) {
      output.setMessage("请先播放一首歌曲，再选择 AirPlay 设备。");
      return;
    }
    try {
      const opened = await player.showAirPlayPicker();
      if (!opened) output.setMessage("当前 macOS WebView 没有提供 AirPlay 选择器，请从控制中心的“声音”菜单选择 AirPlay 设备。");
    } catch (reason) {
      output.setMessage(reason instanceof Error ? reason.message : "无法打开 AirPlay 设备列表。");
    }
  };
  const openWindowsSettings = async () => {
    try {
      await openWindowsAudioSettings();
    } catch (reason) {
      output.setMessage(reason instanceof Error ? reason.message : "无法打开 Windows 音量合成器。");
    }
  };

  return (
    <aside className="devices-panel" role="dialog" aria-label="播放设备">
      <header><div><p className="eyebrow">声音输出</p><h2>播放设备</h2></div><IconButton label="关闭播放设备" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="devices-content">
        {output.platform === "macos" ? (
          <>
            <div className="device-hero"><span><Airplay size={23} /></span><div><strong>AirPlay</strong><small>将当前音乐发送到同一网络上的音箱、电视或接收器。</small></div></div>
            <div className="device-list" role="list">
              <div className="device-option active" role="listitem"><span className="device-option-icon">{player.airPlayActive ? <Airplay size={18} /> : <Laptop size={18} />}</span><span><strong>{player.airPlayActive ? "AirPlay 设备" : "此 Mac"}</strong><small>{player.airPlayActive ? "无线播放目标由 macOS 管理" : "当前系统输出"}</small></span><Check size={16} /></div>
            </div>
            <button className="primary-button device-primary" type="button" disabled={!hasTrack} onClick={() => void openAirPlay()}><Airplay size={17} />选择 AirPlay 设备</button>
            <p className="device-hint">{hasTrack ? "如果系统选择器不可用，可在 macOS 控制中心 → 声音中选择 AirPlay；播放队列和控制仍留在 Cadilume。" : "请先播放一首歌曲，再选择 AirPlay 设备。"}</p>
          </>
        ) : output.platform === "windows" ? (
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
      .then((result) => { if (!cancelled) setPlaylists(result); })
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
            <p className="eyebrow">添加歌曲</p>
            <h2 id="playlist-picker-title" ref={titleRef} tabIndex={-1}>选择歌单</h2>
            <small>《{track.title}》 · {trackArtist(track)}</small>
          </div>
          <IconButton label="关闭歌单选择" disabled={Boolean(busyId)} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="playlist-picker-list" aria-busy={loading || undefined}>
          {loading ? (
            <div className="playlist-picker-state"><LoaderCircle className="spin" size={22} /><span>正在读取音乐歌单…</span></div>
          ) : error && !playlists.length ? (
            <div className="playlist-picker-state is-error"><ListMusic size={24} /><strong>无法读取歌单</strong><span>{error}</span></div>
          ) : !playlists.length ? (
            <div className="playlist-picker-state"><ListMusic size={24} /><strong>没有可写入的音乐歌单</strong><span>智能歌单不会显示；共享服务器也可能没有写入权限。</span></div>
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

function PlayerBar({ player, nowPlayingTriggerRef, expanded, queueOpen, lyricsOpen, devicesOpen, outputPlatform, canOpenNowPlaying, canToggleQueue, canToggleLyrics, onOpenNowPlaying, onToggleQueue, onToggleLyrics, onOutputAction }: {
  player: ReturnType<typeof usePlayer>;
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
          <button className="play-button" aria-label={player.playing ? "暂停" : "播放"} onClick={player.toggle} disabled={!player.current}>{player.playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
          <IconButton label="下一首" onClick={player.next}><SkipForward size={19} fill="currentColor" /></IconButton>
          <IconButton label={player.repeat === "one" ? "单曲循环" : player.repeat === "all" ? "当前列表循环" : "顺序播放，列表结束后停止"} active={player.repeat !== "off"} onClick={cycleRepeat}>{player.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}</IconButton>
        </div>
        <div className="progress-row"><span>{formatDuration(player.progress * 1000)}</span><input aria-label="播放进度" type="range" min="0" max={Math.max(1, player.duration)} step="1" value={Math.min(player.progress, player.duration || 0)} onChange={(event) => player.seek(Number(event.target.value))} /><span>{formatDuration(player.duration * 1000)}</span></div>
      </div>
      <div className="player-extras">
        <IconButton label={lyricsOpen ? "关闭歌词" : "打开歌词"} active={lyricsOpen} disabled={!canToggleLyrics} onClick={onToggleLyrics}><Captions size={19} /></IconButton>
        <IconButton label="播放队列" active={queueOpen} disabled={!canToggleQueue} onClick={onToggleQueue}><ListMusic size={19} /></IconButton>
        <IconButton label={outputPlatform === "macos" ? "选择 AirPlay 设备" : "播放设备"} active={outputPlatform === "macos" ? player.airPlayActive : devicesOpen} onClick={onOutputAction}>{outputPlatform === "macos" ? <Airplay size={19} /> : <Speaker size={18} />}</IconButton>
        <div className="volume-control">
          <IconButton label={player.muted ? "取消静音" : "静音"} onClick={() => player.setMuted(!player.muted)}>{volumeIcon}</IconButton>
          <input aria-label="播放器独立音量" type="range" min="0" max="1" step="0.01" value={player.muted ? 0 : player.volume} onChange={(event) => player.setVolume(Number(event.target.value))} />
          <span>{Math.round((player.muted ? 0 : player.volume) * 100)}</span>
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
        <p className="eyebrow">你的音乐，你的桌面</p>
        <h1>连接 Plex 音乐资料库</h1>
        <p className="login-copy">使用系统浏览器安全登录。免费账号只要获得服务器音乐库共享权限，也可以正常浏览和播放。</p>
        <div className="login-features"><span><Check size={16} />独立播放器音量</span><span><Check size={16} />家庭与共享服务器</span><span><Check size={16} />明确的托盘退出入口</span></div>
        <button className="primary-button login-button" onClick={() => void login.start()} disabled={login.busy} aria-busy={login.busy || undefined}>{login.busy ? <LoaderCircle className="spin" size={18} /> : <CircleUserRound size={18} />}{login.buttonLabel}</button>
        {login.error && <p className="form-error" role="alert">{login.error}</p>}
        <small className="login-legal">仅请求当前账号已获授权的服务器和音乐库，不绕过 Plex 权限。</small>
      </section>
      <aside className="login-art" aria-hidden="true"><div className="record record-one" /><div className="record record-two" /><div className="sound-lines">{Array.from({ length: 34 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 23) % 92)}px` }} />)}</div><p>Lightweight.<br />Private.<br />Desktop first.</p></aside>
    </main>
  );
}

function Artwork({ item, size, className = "", preferArt = false }: {
  item?: PlexItem;
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
  const path = preferArt ? item?.art || item?.thumb : item?.thumb || item?.art;
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

function Notice({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="notice" role="status"><span>{message}</span><IconButton label="关闭提示" onClick={onClose}><X size={16} /></IconButton></div>;
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
        <p className="eyebrow">桌面音乐资料库</p>
        <h1>Cadilume</h1>
        <p>正在恢复账号、音乐来源与上次播放现场。</p>
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

function playlistErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "未知错误");
  if (/\b(?:401|403|404)\b|forbidden|not found|permission|unauthori[sz]ed|无权|权限/iu.test(message)) {
    return "当前账号没有写入这个歌单的权限，或歌单已被服务器移除。共享账号需要服务器所有者授予写入权限。";
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

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function sharedSourceLabel(sourceTitle?: string): string {
  if (!sourceTitle) return "家庭 / 共享访问";
  return sourceTitle.includes("共享") ? sourceTitle : `${sourceTitle} 共享`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export default App;

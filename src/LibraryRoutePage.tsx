// Route-level code is loaded only after the authenticated shell mounts.
import {
  AudioLines,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleUserRound,
  DoorClosed,
  Database,
  Download,
  EllipsisVertical,
  Laptop,
  ListEnd,
  ListPlus,
  ListMusic,
  LockKeyhole,
  LoaderCircle,
  LogOut,
  Menu,
  Music2,
  PanelTop,
  Palette,
  Play,
  RefreshCw,
  Search,
  Server,
  Shuffle,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import * as Select from "@radix-ui/react-select";
import { useNavigate } from "react-router-dom";
import { lazy, ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  canWritePlaylist,
  getArtistTracksPage,
  getChildren,
  getLibraryItems,
  getLibraryMetadata,
  getTracksPage,
  getPlaylistItems,
  getPlaylists,
  getRecentAlbums,
  getRecommendationHubs,
  isDesktopRuntime,
  movePlaylistItem,
  removeTracksFromPlaylist,
  searchLibrary,
  type NativeAudioCacheStatus,
} from "./api";
import "./App.css";
import { ARTIST_BIOGRAPHY_COLLAPSE_LINES, normalizeArtistBiography, previewArtistBiography, shouldCollapseArtistBiography } from "./artistBiography";
import { appendUniqueArtistTracks, collectAllArtistTracks, isArtistTrackCollectionCancelled } from "./artistTracks";
import { selectRandomContextPlayback } from "./contextPlayback";
import { groupPlexItemsByAlphabet, PLEX_ALPHABET_INDEX, type PlexAlphabetBucket } from "./libraryIndex";
import { isCurrentLibraryDetailRoute, libraryDetailRoute, libraryTracksRoute, type LibraryDetailType, type LibraryRoute } from "./libraryRoute";
import { calculatePopconfirmLayout } from "./popconfirmPosition";
import { playlistAutoScrollDelta, playlistDropIndex, playlistMoveAfterId, playlistPointerTarget, reorderPlaylistItems } from "./playlistOrder";
import { homeRecommendationHubs, isRecentlyAddedHub } from "./recommendations";
import { createArtistLookup, resolveTrackArtists, type ArtistLookup } from "./trackArtists";
import { nextTrackSort, sortTracks, type TrackSortKey, type TrackSortState } from "./trackSort";
import type {
  BootstrapResponse,
  BrandPreset,
  CacheStatus,
  CloseBehavior,
  LibrarySection,
  LibraryView,
  PlexAccount,
  PlexHub,
  PlexItem,
  PlexItemPage,
  PlexPlaylist,
  PlexServer,
  StreamQuality,
} from "./types";
import { formatDuration, trackAlbum, trackArtist } from "./types";
import { displayAppVersion, type AppUpdaterController } from "./useAppUpdater";


import {
  Avatar,
  Artwork,
  IconButton,
  LibraryPageTitle,
  detailTypeForItem,
  useMusicPlayerActions,
  useMusicPlayerState,
  useMusicShellRuntime,
  useRouteEntry,
  type BrandPresetChange,
  type OutputDevicesController,
} from "./App";

const PLAYBACK_SETTINGS_ID = "playback-settings";
const SYSTEM_OUTPUT_DEVICE_VALUE = "__cadilume_system_default__";
const ARTIST_TRACK_PAGE_SIZE = 50;
const LIBRARY_TRACK_PAGE_SIZE = 50;
const BRAND_PRESET_OPTIONS: ReadonlyArray<{ preset: BrandPreset; label: string }> = [
  { preset: "amber", label: "琥珀金" },
  { preset: "verdant", label: "雨林绿" },
  { preset: "azure", label: "澄海蓝" },
];

const LazyHomeRouteView = lazy(() => import("./HomeRoutePage").then((module) => ({ default: module.HomeRouteView })));

export function RoutePage() {
  // The keep-alive host gives every history entry its own context value. Read it
  // directly so a restored or rapidly switched cache node cannot stay pinned to
  // the first route that happened to mount this component.
  const { route, entryLocation, onNavigate, onBack } = useRouteEntry();
  const runtime = useMusicShellRuntime();
  const player = useMusicPlayerActions();
  const homePreview = !route.detail
    && route.view === "home"
    && runtime.initialSectionSnapshotActive
    && (runtime.initialLibrary.home.recentAlbums.length > 0 || runtime.initialLibrary.home.hubs.length > 0)
      ? runtime.initialLibrary.home
      : undefined;
  const preparedHome = !route.detail
    && route.view === "home"
    && runtime.initialSectionSnapshotActive
    && runtime.initialLibrary.homeComplete !== false
      ? runtime.initialLibrary.home
      : undefined;
  const initialHome = preparedHome || homePreview;
  const [items, setItems] = useState<PlexItem[]>(() => initialHome?.recentAlbums || []);
  const [homeHubs, setHomeHubs] = useState<PlexHub[]>(() => initialHome?.hubs || []);
  const [searchHubs, setSearchHubs] = useState<PlexHub[]>([]);
  const [detail, setDetail] = useState<{ source: PlexItem; children: PlexItem[] }>();
  const [playlist, setPlaylist] = useState<PlexPlaylist>();
  const [playlistItems, setPlaylistItems] = useState<PlexItem[]>([]);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistError, setPlaylistError] = useState<string>();
  const [playlistReorderBusy, setPlaylistReorderBusy] = useState(false);
  const [playlistRetryRequest, setPlaylistRetryRequest] = useState(0);
  const [loading, setLoading] = useState(route.view !== "settings" && route.view !== "tracks" && !initialHome);
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
      player.playContext(item, items);
      return;
    }
    const detailType = detailTypeForItem(item);
    if (detailType) navigateToDetail(detailType, item.ratingKey);
  }, [items, navigateToDetail, player.playContext]);

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
    player.playContext(selection.current, selection.queue);
    player.setShuffle(true);
  }, [player.playContext, player.setShuffle]);

  const playDetail = useCallback(() => {
    const tracks = detail?.children.filter((item) => item.type === "track") || [];
    if (!tracks[0]) return;
    player.playContext(tracks[0], tracks);
    player.setShuffle(false);
  }, [detail?.children, player.playContext, player.setShuffle]);

  const playPlaylist = useCallback(() => {
    const tracks = playlistItems.filter((item) => item.type === "track");
    if (!tracks[0]) return;
    player.playContext(tracks[0], tracks);
    player.setShuffle(false);
  }, [playlistItems, player.playContext, player.setShuffle]);

  const removePlaylistTrack = useCallback(async (track: PlexItem) => {
    if (!runtime.serverId || !playlist || !canWritePlaylist(playlist)) {
      runtime.notify("这个歌单不可编辑。");
      return;
    }
    // Demo playlist entries do not carry Plex's optional playlistItemID. Only
    // the browser adapter may use the track key as its local identity; a real
    // PMS mutation must keep requiring the server-issued playlist item ID.
    const playlistItemId = track.playlistItemID || (!isDesktopRuntime() ? track.ratingKey : undefined);
    if (!playlistItemId) {
      runtime.notify("这首歌曲缺少歌单项标识，无法从歌单移除。");
      return;
    }
    try {
      const result = await removeTracksFromPlaylist(runtime.serverId, playlist.ratingKey, [playlistItemId]);
      if (result.removed > 0) {
        setPlaylistItems((current) => current.filter((item) => (item.playlistItemID || item.ratingKey) !== playlistItemId));
        runtime.notify(`已从歌单移除《${track.title}》。`, "success");
        void runtime.loadPlaylistList();
      } else {
        const message = "没有从歌单移除任何歌曲，请刷新后重试。";
        runtime.notify(message);
        throw new Error(message);
      }
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : String(reason), "error");
      throw reason;
    }
  }, [playlist, runtime]);

  const reorderPlaylistTrack = useCallback(async (fromIndex: number, toIndex: number) => {
    if (playlistReorderBusy || !runtime.serverId || !playlist || !canWritePlaylist(playlist)) return;
    const previous = playlistItems;
    const reordered = reorderPlaylistItems(previous, fromIndex, toIndex);
    const moved = reordered[toIndex];
    const playlistItemId = moved?.playlistItemID || (!isDesktopRuntime() ? moved?.ratingKey : undefined);
    const afterPlaylistItemId = playlistMoveAfterId(reordered, toIndex)
      || (!isDesktopRuntime() && toIndex > 0 ? reordered[toIndex - 1]?.ratingKey : undefined);
    if (!moved || !playlistItemId || (toIndex > 0 && !afterPlaylistItemId)) {
      runtime.notify("这首歌曲缺少歌单项标识，无法调整顺序。", "error");
      return;
    }
    setPlaylistItems(reordered);
    setPlaylistReorderBusy(true);
    try {
      await movePlaylistItem(
        runtime.serverId,
        playlist.ratingKey,
        playlistItemId,
        afterPlaylistItemId,
      );
      runtime.notify("歌单顺序已更新。", "success");
      void runtime.loadPlaylistList();
    } catch (reason) {
      try {
        setPlaylistItems(await getPlaylistItems(runtime.serverId, playlist.ratingKey));
      } catch {
        setPlaylistItems(previous);
      }
      runtime.notify(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setPlaylistReorderBusy(false);
    }
  }, [playlist, playlistItems, playlistReorderBusy, runtime]);

  const handleRouteChange = useCallback((nextRoute: LibraryRoute) => {
    onNavigate(nextRoute);
  }, [onNavigate]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(view !== "settings" && view !== "tracks" && !initialHome);
    setPlaylist(undefined);
    setPlaylistItems([]);
    setPlaylistError(undefined);
    setPlaylistReorderBusy(false);
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
    if (preparedHome) {
      setItems(preparedHome.recentAlbums);
      setHomeHubs(preparedHome.hubs);
      setSearchHubs([]);
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
        if (!homePreview) {
          setItems([]);
          setHomeHubs([]);
        }
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
  }, [homePreview, initialHome, onNavigate, playlistRetryRequest, preparedHome, query, route.detail, runtime.notify, runtime.playlistMutationRevision, runtime.refreshCacheStatus, runtime.sectionKey, runtime.serverId, runtime.sourceRevision, view]);

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
      onPlayTrack={(track, context) => player.playContext(track, context)}
      onRemoveTrack={removePlaylistTrack}
      reorderBusy={playlistReorderBusy}
      onMoveTrack={reorderPlaylistTrack}
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
      closeBehavior={runtime.closeBehavior}
      appUpdater={runtime.appUpdater}
      outputDevices={runtime.outputDevices}
      brandPreset={runtime.brandPreset}
      deviceName={runtime.deviceName}
      quality={runtime.quality}
      prebufferNext={runtime.prebufferNext}
      cacheStatus={runtime.cacheStatus}
      nativeCacheStatus={runtime.nativeCacheStatus}
      cacheStatusError={runtime.cacheStatusError}
      artworkCacheBusy={runtime.artworkCacheBusy}
      audioCacheBusy={runtime.audioCacheBusy}
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
      onPlayTrack={(track, context) => player.playContext(track, context)}
      onStatusIconEnabled={runtime.changeStatusIconEnabled}
      onCloseBehavior={runtime.changeCloseBehavior}
      onBrandPreset={runtime.changeBrandPreset}
      onEditDeviceName={runtime.openDeviceNameDialog}
      onQuality={runtime.changeQuality}
      onServerChange={runtime.setServerId}
      onSectionChange={runtime.setSectionKey}
      onPrebufferNext={runtime.setPrebufferNext}
      onClearArtworkCache={() => void runtime.clearArtworkDiskCache()}
      onClearAudioCache={() => void runtime.clearAudioDiskCache()}
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
  closeBehavior: CloseBehavior;
  appUpdater: AppUpdaterController;
  outputDevices: OutputDevicesController;
  brandPreset: BrandPreset;
  deviceName: string;
  quality: StreamQuality;
  prebufferNext: boolean;
  cacheStatus?: CacheStatus;
  nativeCacheStatus?: NativeAudioCacheStatus;
  cacheStatusError?: string;
  artworkCacheBusy: boolean;
  audioCacheBusy: boolean;
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
  onCloseBehavior: (behavior: CloseBehavior) => void;
  onBrandPreset: BrandPresetChange;
  onEditDeviceName: () => void;
  onQuality: (value: StreamQuality) => void;
  onServerChange: (value: string) => void;
  onSectionChange: (value: string) => void;
  onPrebufferNext: (value: boolean) => void;
  onClearArtworkCache: () => void;
  onClearAudioCache: () => void;
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

function ContentView(props: ContentViewProps) {
  if (props.view === "settings") return <SettingsView {...props} />;
  if (props.detail) return <DetailView detail={props.detail} serverId={props.serverId} artists={props.artists} onBack={props.onBack} onPlay={props.onPlayDetail} onShuffle={props.onShuffleDetail} onOpen={props.onOpen} onOpenArtist={props.onOpenArtist} onOpenAlbum={props.onOpenAlbum} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "search") return <SearchResults hubs={props.hubs} query={props.searchText} loading={props.loading} artists={props.artists} onOpen={props.onOpen} onOpenArtist={props.onOpenArtist} onOpenAlbum={props.onOpenAlbum} onPlayTrack={props.onPlayTrack} />;
  if (props.view === "tracks") return <PaginatedTracksView serverId={props.serverId} sectionKey={props.sectionKey} route={props.route} artists={props.artists} onRouteChange={props.onTracksRouteChange} onOpenArtist={props.onOpenArtist} onOpenAlbum={props.onOpenAlbum} onPlay={props.onPlayTrack} />;
  if (props.view === "artists") return <CardCollection title="歌手" items={props.items} artistGrid indexed onOpen={props.onOpen} />;
  if (props.view === "albums") return <CardCollection title="专辑" items={props.items} indexed onOpen={props.onOpen} />;
  return (
    <Suspense fallback={<LoadingState />}>
      <LazyHomeRouteView
        hubs={props.homeHubs}
        playlists={props.playlists}
        onPlayItem={props.onPlayRecommendationItem}
        onPlayPlaylist={props.onPlayRecommendationPlaylist}
      />
    </Suspense>
  );
}

function PlaylistDetailView({ playlist, tracks, artists, loading, error, onRetry, onPlay, onShuffle, onPlayTrack, onRemoveTrack, reorderBusy, onMoveTrack, onOpenArtist, onOpenAlbum }: {
  playlist: PlexPlaylist;
  tracks: PlexItem[];
  artists: PlexItem[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onPlay: () => void;
  onShuffle: () => void;
  onPlayTrack: (track: PlexItem, context: PlexItem[]) => void;
  onRemoveTrack: (track: PlexItem) => void | Promise<void>;
  reorderBusy: boolean;
  onMoveTrack: (fromIndex: number, toIndex: number) => void | Promise<void>;
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
        <TrackTable
          title="曲目"
          tracks={tracks}
          artists={artists}
          sortable={!removable}
          onOpenArtist={onOpenArtist}
          onOpenAlbum={onOpenAlbum}
          onPlay={onPlayTrack}
          onRemoveTrack={removable ? onRemoveTrack : undefined}
          reorderBusy={reorderBusy}
          onMoveTrack={removable ? onMoveTrack : undefined}
        />
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
  const player = useMusicPlayerActions();
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
              <IconButton className="album-action-button" label="添加到播放队列" onClick={() => {
                if (player.appendTracks(tracks)) runtime.notify(`已将 ${tracks.length} 首歌曲添加到播放队列。`, "success");
              }}><ListEnd size={18} aria-hidden="true" /></IconButton>
              <IconButton className="album-action-button" label="播放下一个" onClick={() => {
                if (player.insertTracksNext(tracks)) runtime.notify(`已安排 ${tracks.length} 首歌曲接下来播放。`, "success");
              }}><SkipForward size={18} aria-hidden="true" /></IconButton>
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
  const player = useMusicPlayerActions();
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
        player.playTracks(collection.tracks);
        player.setShuffle(false);
      } else if (action === "append") {
        player.appendTracks(collection.tracks);
        runtime.notify(`已将 ${collection.tracks.length} 首歌曲添加到播放队列。`, "success");
      } else if (action === "next") {
        player.insertTracksNext(collection.tracks);
        runtime.notify(`已安排 ${collection.tracks.length} 首歌曲接下来播放。`, "success");
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
  }, [bulkAction, detail.source.title, getArtistPage, player.appendTracks, player.insertTracksNext, player.playTracks, player.setShuffle, runtime, serverId]);

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

interface PlaylistPointerDragSession {
  pointerId: number;
  fromIndex: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  targetIndex: number;
  afterTarget: boolean;
  active: boolean;
  previewElement?: HTMLDivElement;
  indicatorElement?: HTMLDivElement;
  previewLeft?: number;
  previewOffsetY?: number;
  previewHeight?: number;
  scrollContainer?: HTMLElement;
  autoScrollFrame?: number;
  lastAutoScrollAt?: number;
}

function removePlaylistPointerVisuals(session?: PlaylistPointerDragSession): void {
  if (session?.autoScrollFrame !== undefined) window.cancelAnimationFrame(session.autoScrollFrame);
  session?.previewElement?.remove();
  session?.indicatorElement?.remove();
}

function TrackTableGrid({ label, tracks, artists, totalSize, sort, sortable = true, onSort, onOpenArtist, onOpenAlbum, onPlay, onRemoveTrack, onMoveTrack, reorderBusy = false, startIndex = 0, selection }: {
  label: string;
  tracks: PlexItem[];
  artists: PlexItem[];
  totalSize?: number;
  sort?: TrackSortState;
  sortable?: boolean;
  onSort: (sort: TrackSortState | undefined) => void;
  onOpenArtist: (artist: PlexItem) => void;
  onOpenAlbum: (track: PlexItem) => void;
  onPlay: (track: PlexItem, context: PlexItem[]) => void;
  onRemoveTrack?: (track: PlexItem) => void | Promise<void>;
  onMoveTrack?: (fromIndex: number, toIndex: number) => void | Promise<void>;
  reorderBusy?: boolean;
  startIndex?: number;
  selection?: {
    selectedRatingKeys: ReadonlySet<string>;
    onToggleTrack: (ratingKey: string, selected: boolean) => void;
    onTogglePage: (selected: boolean) => void;
  };
}) {
  const runtime = useMusicShellRuntime();
  const player = useMusicPlayerActions();
  const playerState = useMusicPlayerState();
  const artistLookup = useMemo(() => createArtistLookup(artists), [artists]);
  const selectedOnPage = tracks.filter((track) => selection?.selectedRatingKeys.has(track.ratingKey)).length;
  const allPageSelected = tracks.length > 0 && selectedOnPage === tracks.length;
  const [actionMenu, setActionMenu] = useState<{ track: PlexItem; anchor: HTMLButtonElement }>();
  const [pendingRemove, setPendingRemove] = useState<PlexItem>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [dragState, setDragState] = useState<{ fromIndex: number; targetIndex: number; afterTarget: boolean }>();
  const [reorderFocusId, setReorderFocusId] = useState<string>();
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const removeAnchorRef = useRef<HTMLButtonElement | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<PlaylistPointerDragSession | undefined>(undefined);

  useEffect(() => () => {
    removePlaylistPointerVisuals(pointerDragRef.current);
    pointerDragRef.current = undefined;
  }, []);

  useEffect(() => {
    if (!reorderFocusId || reorderBusy) return;
    const frame = window.requestAnimationFrame(() => {
      const handle = Array.from(tableRef.current?.querySelectorAll<HTMLButtonElement>(".track-reorder-handle") || [])
        .find((candidate) => candidate.dataset.playlistItemId === reorderFocusId);
      if (!handle || handle.disabled) return;
      handle.focus();
      setReorderFocusId(undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reorderBusy, reorderFocusId, tracks]);

  useEffect(() => {
    if (!actionMenu) return;
    const anchor = actionMenu.anchor;
    if (!anchor?.isConnected) {
      setActionMenu(undefined);
      return;
    }
    const close = (restoreFocus = false) => {
      setActionMenu(undefined);
      if (restoreFocus) window.requestAnimationFrame(() => anchor.isConnected && anchor.focus());
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (actionMenuRef.current?.contains(target) || anchor.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    const onScroll = () => close();
    const focusFrame = window.requestAnimationFrame(() => {
      actionMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [actionMenu]);

  const closeRemoveConfirm = useCallback(() => {
    if (removeBusy) return;
    setPendingRemove(undefined);
    removeAnchorRef.current = null;
  }, [removeBusy]);

  const runQueueAction = (track: PlexItem, mode: "append" | "next") => {
    const changed = mode === "append"
      ? player.appendTracks([track])
      : player.insertTracksNext([track]);
    setActionMenu(undefined);
    if (!changed) return;
    runtime.notify(
      mode === "append"
        ? `已将《${track.title}》添加到播放队列。`
        : `已将《${track.title}》设为下一首播放。`,
      "success",
    );
  };

  const actionMenuAnchor = actionMenu?.anchor;
  const actionMenuPosition = actionMenuAnchor?.isConnected ? (() => {
    const rect = actionMenuAnchor.getBoundingClientRect();
    const width = 198;
    const height = onRemoveTrack ? 150 : 116;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const below = rect.bottom + 5;
    const top = below + height <= window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - height - 5);
    return { left, top };
  })() : undefined;

  function schedulePointerAutoScroll(): void {
    const session = pointerDragRef.current;
    if (!session?.active || session.autoScrollFrame !== undefined) return;
    session.autoScrollFrame = window.requestAnimationFrame((timestamp) => {
      const current = pointerDragRef.current;
      if (!current) return;
      current.autoScrollFrame = undefined;
      if (!current.active || reorderBusy) return;
      const frameDuration = current.lastAutoScrollAt === undefined
        ? 1000 / 60
        : Math.min(32, Math.max(1, timestamp - current.lastAutoScrollAt));
      current.lastAutoScrollAt = timestamp;

      const scrollContainer = current.scrollContainer;
      if (scrollContainer?.isConnected) {
        const bounds = scrollContainer.getBoundingClientRect();
        const delta = playlistAutoScrollDelta(
          current.clientY,
          bounds.top,
          bounds.bottom,
          scrollContainer.scrollTop,
          scrollContainer.scrollHeight,
          scrollContainer.clientHeight,
        );
        if (delta) scrollContainer.scrollTop += delta * frameDuration / (1000 / 60);
      }

      updatePointerReorderAt(current.pointerId, current.clientX, current.clientY);
      schedulePointerAutoScroll();
    });
  }

  function updatePointerReorderAt(pointerId: number, clientX: number, clientY: number): boolean {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== pointerId || reorderBusy) return false;
    session.clientX = clientX;
    session.clientY = clientY;
    if (!session.active && Math.hypot(clientX - session.startX, clientY - session.startY) < 4) return false;

    const rows = Array.from(tableRef.current?.querySelectorAll<HTMLElement>(".track-data-row") || []);
    const rowBounds = rows.map((row) => row.getBoundingClientRect());
    const target = playlistPointerTarget(clientY, rowBounds);
    if (!target) return false;

    let previewElement = session.previewElement;
    let indicatorElement = session.indicatorElement;
    let previewLeft = session.previewLeft;
    let previewOffsetY = session.previewOffsetY;
    let previewHeight = session.previewHeight;
    let scrollContainer = session.scrollContainer;

    if (!session.active) {
      const sourceRow = rows[session.fromIndex];
      const sourceBounds = rowBounds[session.fromIndex];
      if (!sourceRow || !sourceBounds) return false;

      previewElement = sourceRow.cloneNode(true) as HTMLDivElement;
      previewElement.classList.remove("is-current", "is-remove-confirm-open", "is-dragging");
      previewElement.classList.add("track-drag-preview");
      previewElement.setAttribute("aria-hidden", "true");
      previewElement.inert = true;
      previewElement.querySelectorAll<HTMLElement>("[id]").forEach((element) => element.removeAttribute("id"));
      previewElement.querySelectorAll<HTMLElement>("[data-tooltip]").forEach((element) => element.removeAttribute("data-tooltip"));
      previewElement.style.width = `${sourceBounds.width}px`;
      previewElement.style.height = `${sourceBounds.height}px`;
      previewElement.style.gridTemplateColumns = window.getComputedStyle(sourceRow).gridTemplateColumns;

      indicatorElement = document.createElement("div");
      indicatorElement.className = "track-drop-indicator";
      indicatorElement.setAttribute("aria-hidden", "true");

      previewLeft = sourceBounds.left;
      previewOffsetY = Math.max(0, Math.min(sourceBounds.height, session.startY - sourceBounds.top));
      previewHeight = sourceBounds.height;
      scrollContainer = tableRef.current?.closest<HTMLElement>("[data-route-scroll-container], .route-page-scroll") || undefined;
      document.body.append(previewElement, indicatorElement);
    }

    if (!previewElement || !indicatorElement || previewLeft === undefined || previewOffsetY === undefined || previewHeight === undefined) return false;

    const previewTop = Math.max(
      8,
      Math.min(Math.max(8, window.innerHeight - previewHeight - 8), clientY - previewOffsetY),
    );
    previewElement.style.transform = `translate3d(${Math.round(previewLeft)}px, ${Math.round(previewTop)}px, 0)`;

    const targetBounds = rowBounds[target.targetIndex];
    const indicatorInset = 10;
    const indicatorTop = (target.afterTarget ? targetBounds.bottom : targetBounds.top) - 1;
    indicatorElement.style.width = `${Math.max(0, targetBounds.width - indicatorInset * 2)}px`;
    indicatorElement.style.transform = `translate3d(${Math.round(targetBounds.left + indicatorInset)}px, ${Math.round(indicatorTop)}px, 0)`;
    indicatorElement.dataset.dropTargetIndex = String(target.targetIndex);
    indicatorElement.dataset.dropEdge = target.afterTarget ? "after" : "before";

    const targetChanged = !session.active
      || session.targetIndex !== target.targetIndex
      || session.afterTarget !== target.afterTarget;
    const nextSession: PlaylistPointerDragSession = {
      ...session,
      ...target,
      clientX,
      clientY,
      active: true,
      previewElement,
      indicatorElement,
      previewLeft,
      previewOffsetY,
      previewHeight,
      scrollContainer,
    };
    pointerDragRef.current = nextSession;
    if (targetChanged) {
      setDragState({
        fromIndex: nextSession.fromIndex,
        targetIndex: nextSession.targetIndex,
        afterTarget: nextSession.afterTarget,
      });
    }
    schedulePointerAutoScroll();
    return true;
  }

  const updatePointerReorder = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (updatePointerReorderAt(event.pointerId, event.clientX, event.clientY)) event.preventDefault();
  };

  const finishPointerReorder = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const session = pointerDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    removePlaylistPointerVisuals(session);
    pointerDragRef.current = undefined;
    setDragState(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled || !session.active || reorderBusy || !onMoveTrack) return;

    const toIndex = playlistDropIndex(
      session.fromIndex,
      session.targetIndex,
      session.afterTarget,
      tracks.length,
    );
    if (session.fromIndex === toIndex) return;
    const movedTrack = tracks[session.fromIndex];
    if (movedTrack) setReorderFocusId(movedTrack.playlistItemID || movedTrack.ratingKey);
    void onMoveTrack(session.fromIndex, toIndex);
  };

  return (
    <>
      <div ref={tableRef} className={`track-table ${selection ? "has-selection" : ""} ${onMoveTrack ? "has-reorder" : ""} ${dragState ? "is-reordering" : ""}`.trim()} role="table" aria-label={label} aria-rowcount={(totalSize ?? tracks.length) + 1}>
        <div className="track-row table-head" role="row">
          {selection && <span className="track-selection-heading" role="columnheader"><SelectionCheckbox checked={allPageSelected} indeterminate={selectedOnPage > 0 && !allPageSelected} label="选择当前页全部歌曲" onChange={(checked) => selection.onTogglePage(checked)} /></span>}
          {onMoveTrack && <span className="track-reorder-heading" role="columnheader" aria-label="排序" />}
          <span className="track-number-heading" role="columnheader">#</span>
          <span className="track-artwork-heading" role="columnheader">封面</span>
          {sortable
            ? <TrackSortHeader label="标题" accessibleLabel="歌曲名称" sortKey="title" sort={sort} onSort={onSort} />
            : <span className="track-title-heading" role="columnheader">标题</span>}
          <span className="track-artist-heading" role="columnheader">歌手</span>
          {sortable
            ? <TrackSortHeader className="track-album-heading" label="专辑" sortKey="album" sort={sort} onSort={onSort} />
            : <span className="track-album-heading" role="columnheader">专辑</span>}
          {sortable
            ? <TrackSortHeader className="duration-sort-header" label="时长" sortKey="duration" sort={sort} onSort={onSort} />
            : <span className="track-duration-heading" role="columnheader">时长</span>}
          <span className="track-action-heading" role="columnheader" aria-label="歌曲操作" />
        </div>
        {tracks.map((track, index) => {
          const current = playerState.current?.ratingKey === track.ratingKey;
          return (
            <div
              className={`track-row track-data-row ${current ? "is-current" : ""} ${pendingRemove === track ? "is-remove-confirm-open" : ""} ${dragState?.fromIndex === index ? "is-dragging" : ""}`.trim()}
              role="row"
              aria-rowindex={index + 2}
              key={track.playlistItemID || `${track.ratingKey}-${index}`}
            >
              {selection && <span className="track-selection-cell" role="cell"><SelectionCheckbox checked={selection.selectedRatingKeys.has(track.ratingKey)} label={`选择《${track.title}》`} onChange={(checked) => selection.onToggleTrack(track.ratingKey, checked)} /></span>}
              {onMoveTrack && (
                <span className="track-reorder-cell" role="cell">
                  <button
                    className="track-reorder-handle"
                    type="button"
                    disabled={reorderBusy}
                    aria-label={`调整《${track.title}》的顺序`}
                    data-playlist-item-id={track.playlistItemID || track.ratingKey}
                    data-tooltip="拖动调整顺序"
                    onPointerDown={(event) => {
                      if (reorderBusy || event.button !== 0 || !event.isPrimary) return;
                      event.preventDefault();
                      event.currentTarget.focus();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      pointerDragRef.current = {
                        pointerId: event.pointerId,
                        fromIndex: index,
                        startX: event.clientX,
                        startY: event.clientY,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        targetIndex: index,
                        afterTarget: false,
                        active: false,
                      };
                    }}
                    onPointerMove={updatePointerReorder}
                    onPointerUp={(event) => finishPointerReorder(event)}
                    onPointerCancel={(event) => finishPointerReorder(event, true)}
                    onLostPointerCapture={(event) => {
                      const session = pointerDragRef.current;
                      if (session?.pointerId !== event.pointerId) return;
                      removePlaylistPointerVisuals(session);
                      pointerDragRef.current = undefined;
                      setDragState(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && pointerDragRef.current) {
                        event.preventDefault();
                        const session = pointerDragRef.current;
                        const { pointerId } = session;
                        removePlaylistPointerVisuals(session);
                        pointerDragRef.current = undefined;
                        setDragState(undefined);
                        if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
                        return;
                      }
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                      event.preventDefault();
                      const toIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
                      if (toIndex < 0 || toIndex >= tracks.length) return;
                      const playlistItemId = track.playlistItemID || track.ratingKey;
                      setReorderFocusId(playlistItemId);
                      void onMoveTrack(index, toIndex);
                    }}
                  >
                    {reorderBusy ? <LoaderCircle className="spin" size={14} /> : <Menu size={17} strokeWidth={2.1} />}
                  </button>
                </span>
              )}
              <span className="track-index" role="cell">
                <button
                  className={`track-play-button ${current ? "is-current" : ""} ${current && playerState.playing ? "is-playing" : ""}`.trim()}
                  type="button"
                  disabled={current}
                  aria-label={current ? `正在播放《${track.title}》` : `播放《${track.title}》`}
                  onClick={() => onPlay(track, tracks)}
                >
                  {current
                    ? <AudioLines size={15} strokeWidth={2.1} aria-hidden="true" />
                    : <><span>{startIndex + index + 1}</span><Play size={13} fill="currentColor" aria-hidden="true" /></>}
                </button>
              </span>
              <span className="track-artwork-cell" role="cell"><Artwork item={track} size="small" /></span>
              <span className="track-title" role="cell" title={track.title}><strong>{track.title}</strong></span>
              <TrackArtistsCell track={track} artistLookup={artistLookup} onOpenArtist={onOpenArtist} />
              <TrackAlbumCell track={track} onOpenAlbum={onOpenAlbum} />
              <span className="duration-cell" role="cell"><span className="duration-label">{formatDuration(track.duration)}</span></span>
              <span className="track-action-cell" role="cell">
                <button
                  className="track-action-button"
                  type="button"
                  aria-label={`打开《${track.title}》的操作菜单`}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(actionMenuAnchor) && actionMenu?.track === track}
                  data-tooltip="更多操作"
                  onClick={(event) => {
                    const anchor = event.currentTarget;
                    setActionMenu((currentMenu) => currentMenu?.anchor === anchor
                      ? undefined
                      : { track, anchor });
                  }}
                >
                  <EllipsisVertical size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {actionMenu && actionMenuPosition && createPortal(
        <div
          ref={actionMenuRef}
          className="playlist-context-menu track-action-menu"
          style={actionMenuPosition}
          role="menu"
          aria-label={`${actionMenu.track.title} 歌曲操作`}
        >
          <button type="button" role="menuitem" disabled={!runtime.serverId} onClick={() => {
            const track = actionMenu.track;
            setActionMenu(undefined);
            runtime.openPlaylistPicker([track]);
          }}><ListPlus size={15} />添加到歌单</button>
          <button type="button" role="menuitem" onClick={() => runQueueAction(actionMenu.track, "append")}><ListEnd size={15} />添加到播放队列</button>
          <button type="button" role="menuitem" onClick={() => runQueueAction(actionMenu.track, "next")}><SkipForward size={15} />播放下一个</button>
          {onRemoveTrack && <button type="button" role="menuitem" className="is-danger" onClick={() => {
            removeAnchorRef.current = actionMenu.anchor;
            setPendingRemove(actionMenu.track);
            setActionMenu(undefined);
          }}><Trash2 size={15} />从歌单移除</button>}
        </div>,
        document.body,
      )}
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
              setPendingRemove(undefined);
              removeAnchorRef.current = null;
            } catch {
              // Keep the anchor and confirmation visible when PMS rejects the
              // mutation so the user can retry without reopening the row menu.
            } finally {
              setRemoveBusy(false);
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
    if (!pop) return;
    const update = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const width = pop.offsetWidth || 232;
      const height = pop.offsetHeight || 76;
      const layout = calculatePopconfirmLayout(
        anchorRect,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlacement(layout.placement);
      setStyle({
        top: layout.top,
        left: layout.left,
        visibility: "visible",
        "--popconfirm-arrow-left": `${layout.arrowLeft}px`,
      } as CSSProperties);
    };
    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resizeObserver?.observe(anchor);
    resizeObserver?.observe(pop);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      resizeObserver?.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    confirmRef.current?.focus({ preventScroll: true });
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
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
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
  const player = useMusicPlayerActions();
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
    player.playTracks(selectedTracks);
    player.setShuffle(false);
    setSelectedRatingKeys(new Set<string>());
  };
  const appendSelectedTracks = () => {
    if (!selectedTracks.length) return;
    player.appendTracks(selectedTracks);
    runtime.notify(`已将 ${selectedTracks.length} 首歌曲添加到播放队列。`, "success");
    setSelectedRatingKeys(new Set<string>());
  };

  if (error) return <EmptyState title="无法读取歌曲" description={error} icon={<TriangleAlert size={28} />} />;
  return (
    <section className="track-section has-accent-heading paginated-track-section" aria-busy={loading || undefined}>
      <div className="page-heading sticky-page-heading track-page-heading">
        <div className="track-page-heading-copy">
          <LibraryPageTitle>歌曲</LibraryPageTitle>
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
            <span className="track-pagination-total" aria-live="polite">{totalSize ? `共 ${totalSize} 首歌曲` : loading ? "正在读取歌曲…" : "当前资料库没有歌曲"}</span>
            <span className="track-pagination-controls">
              {page > 1 && <button type="button" onClick={() => updatePage(1)} aria-label="首页">首页</button>}
              <button type="button" onClick={() => updatePage(page - 1)} disabled={page <= 1} aria-label="上一页">上一页</button>
              <span className="track-pagination-pages">{paginationSequence(page, totalPages).map((item, index) => item === "ellipsis" ? <span key={`ellipsis-${index}`} aria-hidden="true">…</span> : <button key={item} type="button" className={item === page ? "is-current" : ""} aria-current={item === page ? "page" : undefined} onClick={() => updatePage(item)}>{item}</button>)}</span>
              <button type="button" onClick={() => updatePage(page + 1)} disabled={page >= totalPages} aria-label="下一页">下一页</button>
              {page < totalPages && <button type="button" onClick={() => updatePage(totalPages)} aria-label="末页">末页</button>}
            </span>
            <span className="track-pagination-spacer" aria-hidden="true" />
          </nav>
        </div>
      ) : <EmptyState title="没有歌曲" description="当前音乐资料库没有返回可显示的歌曲。" icon={<Music2 size={28} />} />}
    </section>
  );
}

function TrackTable({ title, tracks, artists, accentHeading = false, sortable = true, onOpenArtist, onOpenAlbum, onPlay, onRemoveTrack, onMoveTrack, reorderBusy = false }: { title: string; tracks: PlexItem[]; artists: PlexItem[]; accentHeading?: boolean; sortable?: boolean; onOpenArtist: (artist: PlexItem) => void; onOpenAlbum: (track: PlexItem) => void; onPlay: (track: PlexItem, context: PlexItem[]) => void; onRemoveTrack?: (track: PlexItem) => void | Promise<void>; onMoveTrack?: (fromIndex: number, toIndex: number) => void | Promise<void>; reorderBusy?: boolean }) {
  const [sort, setSort] = useState<TrackSortState>();
  const displayedTracks = useMemo(() => sortable ? sortTracks(tracks, sort) : tracks, [sort, sortable, tracks]);
  return (
    <section className={`track-section ${accentHeading ? "has-accent-heading" : ""}`.trim()}>
      <div className="section-heading"><h1>{title}</h1></div>
      <TrackTableGrid label={title} tracks={displayedTracks} artists={artists} sort={sort} sortable={sortable} onSort={setSort} onOpenArtist={onOpenArtist} onOpenAlbum={onOpenAlbum} onPlay={onPlay} onRemoveTrack={onRemoveTrack} onMoveTrack={onMoveTrack} reorderBusy={reorderBusy} />
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
  if (!query) return (
    <div className="search-results">
      <div className="search-results-toolbar">
        <DetailBackButton label="返回" onClick={() => navigate(-1)} />
      </div>
      <div className="search-results-fill">
        <EmptyState title="搜索音乐资料库" description="输入歌曲、专辑或歌手名称。" icon={<Search size={28} />} />
      </div>
    </div>
  );
  if (loading) return <SearchLoadingState query={query} />;
  if (!total) return (
    <div className="search-results">
      <div className="search-results-toolbar">
        <DetailBackButton label="返回" onClick={() => navigate(-1)} />
      </div>
      <div className="search-results-fill">
        <EmptyState title={`没有找到“${query}”`} description="尝试更短的关键词，或切换到其他音乐资料库。" icon={<Search size={28} />} />
      </div>
    </div>
  );
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
  const nativeCacheSummary = props.nativeCacheStatus
    ? formatBytes(props.nativeCacheStatus.size_bytes)
    : "正在统计…";
  const update = props.appUpdater;
  const updateStatus = !update.supported
    ? "开发构建不执行更新检查。"
    : update.installing
      ? update.progressPercent === undefined ? "正在下载更新…" : `正在下载更新… ${update.progressPercent}%`
      : update.checking
        ? "正在检查 GitHub Release…"
        : update.error
          ? `上次更新操作失败：${update.error}`
          : update.availableUpdate
            ? `${displayAppVersion(update.availableUpdate.version)} 已可用，安装完成后 Cadilume 会重启。`
            : "可随时检查 GitHub 上的最新正式版本。";
  return (
    <div className="settings-page">
      <div className="page-heading sticky-page-heading"><h1>设置</h1></div>
      <SettingsGroup icon={<Palette size={18} />} title="视觉风格">
        <div className="field-row">
          <span><strong>配色</strong><small>仅更改配色，不连接服务。</small></span>
          <div className="choice-grid choice-grid--compact choice-grid--visual" role="radiogroup" aria-label="视觉风格">
            {BRAND_PRESET_OPTIONS.map((option) => {
              const active = props.brandPreset === option.preset;
              return <ChoiceCard key={option.preset} radio active={active} title={option.label} showCheck={false} icon={<span className="visual-preset-swatch" data-preset={option.preset} aria-hidden="true" />} onClick={(event) => {
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
      <SettingsGroup icon={<DoorClosed size={18} />} title="关闭">
        <div className="close-behavior-options" role="radiogroup" aria-label="关闭">
          {([
            ["tray", "最小化到托盘"],
            ["quit", "退出程序"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`close-behavior-option ${props.closeBehavior === value ? "active" : ""}`}
              role="radio"
              aria-checked={props.closeBehavior === value}
              onClick={() => props.onCloseBehavior(value)}
            >
              <span className="close-behavior-radio" aria-hidden="true" />
              <strong>{label}</strong>
            </button>
          ))}
        </div>
      </SettingsGroup>
      {props.statusIconPlatform && (
        <SettingsGroup icon={<PanelTop size={18} />} title="系统状态图标">
          <div className="toggle-row">
            <span><strong>{props.statusIconPlatform === "macos" ? "显示菜单栏图标" : "显示通知区域图标"}</strong></span>
            <label className="toggle-switch" aria-label={props.statusIconPlatform === "macos" ? "显示菜单栏图标" : "显示通知区域图标"}>
              <input type="checkbox" checked={props.statusIconEnabled} disabled={props.statusIconSaving} onChange={(event) => props.onStatusIconEnabled(event.target.checked)} />
              <span className="toggle-control" aria-hidden="true" />
            </label>
          </div>
        </SettingsGroup>
      )}
      {!import.meta.env.DEV && <SettingsGroup icon={<Download size={18} />} title="应用更新">
        <div className="settings-stack">
          <div className="field-row app-update-row">
            <span>
              <strong>当前版本 {displayAppVersion(update.currentVersion)}</strong>
              <small aria-live="polite">{updateStatus}</small>
              {update.installing && (
                <span className="app-update-progress" aria-hidden="true">
                  <i style={{ width: `${update.progressPercent ?? 0}%` }} />
                </span>
              )}
            </span>
            <button
              className="secondary-button app-update-button"
              type="button"
              disabled={!update.supported || update.checking || update.installing}
              onClick={() => void (update.availableUpdate ? update.installUpdate() : update.checkForUpdate())}
            >
              {update.checking || update.installing
                ? <LoaderCircle className="spin" size={15} />
                : update.availableUpdate ? <Download size={15} /> : <RefreshCw size={15} />}
              {!update.supported
                ? "开发构建不可用"
                : update.installing
                  ? "正在更新…"
                  : update.checking
                    ? "正在检查…"
                    : update.availableUpdate
                      ? `更新至 ${displayAppVersion(update.availableUpdate.version)}`
                      : "检查更新"}
            </button>
          </div>
          <div className="toggle-row">
            <span><strong>自动检查更新</strong></span>
            <label className="toggle-switch" aria-label="自动检查更新">
              <input
                type="checkbox"
                checked={update.autoUpdateEnabled}
                disabled={!update.supported || update.preferenceSaving}
                onChange={(event) => void update.changeAutoUpdateEnabled(event.target.checked)}
              />
              <span className="toggle-control" aria-hidden="true" />
            </label>
          </div>
        </div>
      </SettingsGroup>}
      <SettingsGroup id={PLAYBACK_SETTINGS_ID} icon={<SlidersHorizontal size={18} />} title="播放">
        <div className="settings-stack">
          <div className="field-row"><span><strong>音频质量</strong><small>默认播放原始流；MP3 档位由 PMS 按所选码率转码。</small></span><SettingsSelect label="音频质量" value={props.quality} placeholder="选择音频质量" disabled={false} options={[{ value: "original", label: "原始质量（默认）" }, { value: "auto", label: "自动兼容（原始优先）" }, { value: "320", label: "MP3 · 320 kbps" }, { value: "256", label: "MP3 · 256 kbps" }, { value: "192", label: "MP3 · 192 kbps" }]} onValueChange={(value) => props.onQuality(value as StreamQuality)} /></div>
          {isDesktopRuntime() && props.outputDevices.platform === "windows" && <OutputDeviceSetting output={props.outputDevices} />}
          <div className="toggle-row">
            <span><strong>预缓冲下一首</strong><small>提前加载队列中的下一首。</small></span>
            <label className="toggle-switch" aria-label="预缓冲下一首"><input type="checkbox" checked={props.prebufferNext} onChange={(event) => props.onPrebufferNext(event.target.checked)} /><span className="toggle-control" aria-hidden="true" /></label>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup icon={<Database size={18} />} title="缓存">
        <div className="settings-stack">
          <div className="field-row cache-setting-row">
            <span><strong>封面缓存</strong><small aria-live="polite">{cacheSummary}</small></span>
            <button className="danger-button cache-clear-button" type="button" aria-label="清理封面缓存" disabled={props.artworkCacheBusy || !props.cacheStatus?.sizeBytes} onClick={props.onClearArtworkCache}>{props.artworkCacheBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{props.artworkCacheBusy ? "清理中…" : "清理封面"}</button>
          </div>
          <div className="field-row cache-setting-row">
            <span><strong>音频缓存</strong><small aria-live="polite">{nativeCacheSummary}</small></span>
            <button className="danger-button cache-clear-button" type="button" aria-label="清理音频缓存" disabled={props.audioCacheBusy || !props.nativeCacheStatus?.size_bytes} onClick={props.onClearAudioCache}>{props.audioCacheBusy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{props.audioCacheBusy ? "清理中…" : "清理音频"}</button>
          </div>
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

function ChoiceCard({ active, title, icon, onClick, radio = false, showCheck = true }: { active: boolean; title: string; icon: ReactNode; onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void; radio?: boolean; showCheck?: boolean }) {
  return <button type="button" className={`choice-card ${active ? "active" : ""}`} role={radio ? "radio" : undefined} aria-checked={radio ? active : undefined} onClick={onClick}>{icon}<strong>{title}</strong>{active && showCheck && <Check className="choice-check" size={16} />}</button>;
}

function OutputDeviceSetting({ output }: { output: OutputDevicesController }) {
  const selectedValue = output.selectedDeviceId || SYSTEM_OUTPUT_DEVICE_VALUE;
  const options = output.devices.map((device) => ({
    value: device.deviceId || SYSTEM_OUTPUT_DEVICE_VALUE,
    label: device.label,
  }));
  return (
    <div className="settings-output-setting">
      <div className="field-row settings-output-row">
        <span><strong>播放设备</strong><small>仅改变 Cadilume 的输出；选择“系统默认”时会跟随系统设备。</small></span>
        <div className="settings-output-controls">
          <SettingsSelect
            label="播放设备"
            value={selectedValue}
            placeholder="选择播放设备"
            disabled={!output.canSelectSink}
            options={options}
            onValueChange={(value) => void output.selectDevice(value === SYSTEM_OUTPUT_DEVICE_VALUE ? "" : value)}
          />
          <IconButton label="刷新播放设备" tooltip="刷新播放设备" disabled={output.loading} onClick={() => void output.refresh()}>
            <RefreshCw className={output.loading ? "spin" : ""} size={16} />
          </IconButton>
        </div>
      </div>
      {!output.canSelectSink && <p className="device-hint">当前运行环境不支持应用内切换，请使用“系统默认”输出。</p>}
      {output.message && <p className="device-message" role="status">{output.message}</p>}
    </div>
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
      <span className="search-loading-orbit" aria-hidden="true"><Search size={36} /></span>
      <span className="search-loading-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>
      <strong>正在搜索“{query}”…</strong>
      <small>正在查找歌曲、专辑与歌手</small>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}


export default RoutePage;

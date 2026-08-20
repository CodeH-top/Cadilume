// The authenticated home route is its own async chunk. Detail, search,
// settings, and track-table code stays out of the first visible page.
import { LoaderCircle, Music2, Play } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getRecentAlbums, getRecommendationHubs } from "./api";
import { homeRecommendationHubs, isRecentlyAddedHub, recommendationHubTitle, recentlyPlayedPlaylists } from "./recommendations";
import type { PlexHub, PlexItem, PlexPlaylist } from "./types";
import { trackArtist } from "./types";
import { Artwork, LibraryPageTitle, useMusicShellRuntime, useRouteEntry } from "./App";
import { PlaylistKindIcons } from "./LibraryShellComponents";

function EmptyState({ title, description, icon = <Music2 size={28} /> }: { title: string; description: string; icon?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{description}</p></div>;
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
      // The app-level callback already reports a scoped notification.
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
                    <button className={`recommendation-card media-card ${pending ? "is-loading" : ""}`} type="button" role="listitem" key={playlist.ratingKey} aria-label={`播放歌单“${playlist.title}”`} aria-busy={pending || undefined} disabled={pending} onClick={() => void runPlayback(key, () => onPlayPlaylist(playlist))}>
                      <span className="recommendation-artwork"><Artwork item={playlist} size="large" /><span className="recommendation-play-indicator" aria-hidden="true">{pending ? <LoaderCircle className="spin" size={21} /> : <Play size={22} fill="currentColor" />}</span></span>
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
                    <button className={`recommendation-card media-card ${pending ? "is-loading" : ""}`} type="button" role="listitem" key={`${item.ratingKey}-${itemIndex}`} aria-label={`播放“${item.title}”`} aria-busy={pending || undefined} disabled={pending} onClick={() => void runPlayback(key, () => onPlayItem(item, hub.items))}>
                      <span className={`recommendation-artwork ${item.type === "artist" ? "is-round" : ""}`}><Artwork item={item} className={item.type === "artist" ? "round" : ""} size="large" /><span className="recommendation-play-indicator" aria-hidden="true">{pending ? <LoaderCircle className="spin" size={21} /> : <Play size={22} fill="currentColor" />}</span></span>
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

export function HomeRouteView({ hubs, playlists, onPlayItem, onPlayPlaylist }: {
  hubs: PlexHub[];
  playlists: PlexPlaylist[];
  onPlayItem: (item: PlexItem, context: PlexItem[]) => Promise<void>;
  onPlayPlaylist: (playlist: PlexPlaylist) => Promise<void>;
}) {
  return <RecommendationsView hubs={hubs} playlists={playlists} onPlayItem={onPlayItem} onPlayPlaylist={onPlayPlaylist} />;
}

export function HomeRouteEntry() {
  const { route } = useRouteEntry();
  const runtime = useMusicShellRuntime();
  const preparedHome = route.view === "home"
    && runtime.initialSectionSnapshotActive
    && runtime.initialLibrary.homeComplete !== false
    ? runtime.initialLibrary.home
    : undefined;
  const [hubs, setHubs] = useState<PlexHub[]>(() => preparedHome?.hubs || []);
  const [loading, setLoading] = useState(!preparedHome);

  const load = useCallback(async () => {
    if (preparedHome) {
      setHubs(preparedHome.hubs);
      setLoading(false);
      return;
    }
    if (!runtime.serverId || !runtime.sectionKey) {
      setHubs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextHubs, recentAlbums] = await Promise.all([
        getRecommendationHubs(runtime.serverId, runtime.sectionKey),
        getRecentAlbums(runtime.serverId, runtime.sectionKey),
      ]);
      const completeHubs = nextHubs.some(isRecentlyAddedHub) || !recentAlbums.length
        ? nextHubs
        : [...nextHubs, { title: "最近加入的音乐", type: "album", identifier: "cadilume.recentlyadded", items: recentAlbums }];
      setHubs(homeRecommendationHubs(completeHubs));
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : String(reason), "error");
      setHubs([]);
    } finally {
      setLoading(false);
    }
  }, [preparedHome, runtime.notify, runtime.sectionKey, runtime.serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>正在读取音乐资料库…</span></div>;
  return <HomeRouteView hubs={hubs} playlists={runtime.playlists} onPlayItem={runtime.playRecommendationItem} onPlayPlaylist={runtime.playRecommendationPlaylist} />;
}

export default HomeRouteView;

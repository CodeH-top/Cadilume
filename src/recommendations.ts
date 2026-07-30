import type { PlexHub, PlexPlaylist } from "./types";

function hubIdentity(hub: PlexHub): string {
  return [hub.identifier, hub.context, hub.title].filter(Boolean).join(" ").toLowerCase();
}

export function isRecentlyAddedHub(hub: PlexHub): boolean {
  return /recently\s*added|recentlyadded|recent\.added/.test(hubIdentity(hub));
}

export function isRecentlyPlayedHub(hub: PlexHub): boolean {
  const identity = hubIdentity(hub);
  return !isRecentlyAddedHub(hub) && /recently\s*(played|viewed)|recentlyplayed|recentlyviewed|recent\.played/.test(identity);
}

/** Preserve PMS order inside each priority band and place Recently Added last. */
export function orderRecommendationHubs(hubs: readonly PlexHub[]): PlexHub[] {
  return hubs
    .map((hub, index) => ({ hub, index }))
    .sort((left, right) => {
      const priority = (hub: PlexHub) => isRecentlyPlayedHub(hub) ? 0 : isRecentlyAddedHub(hub) ? 2 : 1;
      return priority(left.hub) - priority(right.hub) || left.index - right.index;
    })
    .map(({ hub }) => hub);
}

export function recommendationHubTitle(hub: PlexHub): string {
  if (isRecentlyPlayedHub(hub)) return "最近播放的音乐";
  if (isRecentlyAddedHub(hub)) return "最近加入的音乐";
  return hub.title;
}

export function recentlyPlayedPlaylists(playlists: readonly PlexPlaylist[], limit = 12): PlexPlaylist[] {
  return playlists
    .filter((playlist) => (playlist.lastViewedAt ?? 0) > 0 || (playlist.viewCount ?? 0) > 0)
    .map((playlist, index) => ({ playlist, index }))
    .sort((left, right) => (
      (right.playlist.lastViewedAt ?? 0) - (left.playlist.lastViewedAt ?? 0)
      || (right.playlist.viewCount ?? 0) - (left.playlist.viewCount ?? 0)
      || left.index - right.index
    ))
    .slice(0, Math.max(0, limit))
    .map(({ playlist }) => playlist);
}

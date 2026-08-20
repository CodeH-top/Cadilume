import type { PlexHub, PlexPlaylist } from "./types";

const HOME_RECENT_PLAYED_LIMIT = 12;
const HOME_RECENT_ADDED_LIMIT = 18;

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

/**
 * The home page intentionally exposes only the two useful recent bands. PMS can
 * return promoted artists, albums, mixes, and other hubs alongside them; those
 * are valid search/library data but are not part of Cadilume's compact home.
 * Recently played must be a track hub so an artist-only PMS response never
 * turns the section into the wrong media type.
 */
export function homeRecommendationHubs(hubs: readonly PlexHub[]): PlexHub[] {
  const recentlyPlayed = hubs.find((hub) => isRecentlyPlayedHub(hub) && hub.items.some((item) => item.type === "track"));
  const recentlyAdded = hubs.find(isRecentlyAddedHub);
  const result: PlexHub[] = [];

  if (recentlyPlayed) {
    const tracks = recentlyPlayed.items
      .filter((item) => item.type === "track")
      .slice(0, HOME_RECENT_PLAYED_LIMIT);
    if (tracks.length) result.push({ ...recentlyPlayed, type: "track", items: tracks });
  }

  if (recentlyAdded) {
    const media = recentlyAdded.items
      .filter((item) => item.type === "track" || item.type === "album")
      .slice(0, HOME_RECENT_ADDED_LIMIT);
    if (media.length) result.push({ ...recentlyAdded, items: media });
  }

  return result;
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

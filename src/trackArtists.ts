import { trackArtist, type PlexItem } from "./types";

export interface ResolvedTrackArtist {
  name: string;
  artist?: PlexItem;
}

export interface ArtistLookup {
  byName: ReadonlyMap<string, PlexItem>;
}

function normalizeArtistName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function createArtistLookup(artists: readonly PlexItem[]): ArtistLookup {
  const byName = new Map<string, PlexItem>();
  artists.forEach((artist) => {
    if (artist.type !== "artist") return;
    const key = normalizeArtistName(artist.title);
    if (key && !byName.has(key)) byName.set(key, artist);
  });
  return { byName };
}

function resolveDisplayName(displayName: string, artistLookup: ArtistLookup): ResolvedTrackArtist[] {
  const normalizedDisplayName = displayName.trim() || "未知歌手";
  return normalizedDisplayName
    // Only a literal space-slash-space separates Cadilume artist credits.
    // This leaves names such as AC/DC and malformed lookalikes untouched.
    .split(" / ")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, artist: artistLookup.byName.get(normalizeArtistName(name)) }));
}

export function resolveTrackArtists(track: PlexItem | string, artistLookup: ArtistLookup): ResolvedTrackArtist[] {
  return resolveDisplayName(typeof track === "string" ? track : trackArtist(track), artistLookup);
}

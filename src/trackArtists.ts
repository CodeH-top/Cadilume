import type { PlexItem } from "./types";

export interface ResolvedTrackArtist {
  name: string;
  artist?: PlexItem;
}

export type ArtistLookup = ReadonlyMap<string, PlexItem>;

function normalizeArtistName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function createArtistLookup(artists: readonly PlexItem[]): ArtistLookup {
  const artistLookup = new Map<string, PlexItem>();
  artists.forEach((artist) => {
    if (artist.type !== "artist") return;
    const key = normalizeArtistName(artist.title);
    if (key && !artistLookup.has(key)) artistLookup.set(key, artist);
  });
  return artistLookup;
}

export function resolveTrackArtists(displayName: string, artistLookup: ArtistLookup): ResolvedTrackArtist[] {
  const normalizedDisplayName = displayName.trim() || "未知歌手";
  const exactArtist = artistLookup.get(normalizeArtistName(normalizedDisplayName));
  if (exactArtist) return [{ name: normalizedDisplayName, artist: exactArtist }];

  return normalizedDisplayName
    .split(/\s*\/\s*/u)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, artist: artistLookup.get(normalizeArtistName(name)) }));
}

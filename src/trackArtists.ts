import type { PlexContributor, PlexItem } from "./types";

export interface ResolvedTrackArtist {
  name: string;
  artist?: PlexItem;
}

export interface ArtistLookup {
  byName: ReadonlyMap<string, PlexItem>;
  byRatingKey: ReadonlyMap<string, PlexItem>;
}

function normalizeArtistName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function createArtistLookup(artists: readonly PlexItem[]): ArtistLookup {
  const byName = new Map<string, PlexItem>();
  const byRatingKey = new Map<string, PlexItem>();
  artists.forEach((artist) => {
    if (artist.type !== "artist") return;
    const key = normalizeArtistName(artist.title);
    if (key && !byName.has(key)) byName.set(key, artist);
    if (artist.ratingKey && !byRatingKey.has(artist.ratingKey)) byRatingKey.set(artist.ratingKey, artist);
  });
  return { byName, byRatingKey };
}

function resolveContributor(contributor: PlexContributor, artistLookup: ArtistLookup): ResolvedTrackArtist {
  const name = contributor.name.trim();
  return {
    name,
    artist: (contributor.ratingKey ? artistLookup.byRatingKey.get(contributor.ratingKey) : undefined)
      || artistLookup.byName.get(normalizeArtistName(name)),
  };
}

function uniqueContributors(contributors: readonly PlexContributor[]): PlexContributor[] {
  const names = new Set<string>();
  const ratingKeys = new Set<string>();
  return contributors.flatMap((contributor) => {
    const name = contributor.name.trim();
    if (!name) return [];
    const normalizedName = normalizeArtistName(name);
    if (names.has(normalizedName) || (contributor.ratingKey && ratingKeys.has(contributor.ratingKey))) return [];
    names.add(normalizedName);
    if (contributor.ratingKey) ratingKeys.add(contributor.ratingKey);
    return [{ name, ratingKey: contributor.ratingKey }];
  });
}

function resolveLegacyDisplayName(displayName: string, artistLookup: ArtistLookup, ratingKey?: string): ResolvedTrackArtist[] {
  const normalizedDisplayName = displayName.trim() || "未知歌手";
  const exactArtist = (ratingKey ? artistLookup.byRatingKey.get(ratingKey) : undefined)
    || artistLookup.byName.get(normalizeArtistName(normalizedDisplayName));
  if (exactArtist) return [{ name: normalizedDisplayName, artist: exactArtist }];

  const segments = normalizedDisplayName
    .split(/\s*\/\s*/u)
    .map((name) => name.trim())
    .filter(Boolean);
  // A bare slash is ambiguous: only split legacy text when a local artist
  // confirms at least one member. This keeps names such as AC/DC intact.
  const canSafelySplit = segments.length > 1
    && segments.some((name) => artistLookup.byName.has(normalizeArtistName(name)));
  return (canSafelySplit ? segments : [normalizedDisplayName])
    .map((name) => ({ name, artist: artistLookup.byName.get(normalizeArtistName(name)) }));
}

export function resolveTrackArtists(track: PlexItem | string, artistLookup: ArtistLookup): ResolvedTrackArtist[] {
  if (typeof track === "string") return resolveLegacyDisplayName(track, artistLookup);
  const contributors = uniqueContributors(track.contributors || []);
  if (contributors.length) return contributors.map((contributor) => resolveContributor(contributor, artistLookup));
  return resolveLegacyDisplayName(
    track.grandparentTitle || track.parentTitle || "未知歌手",
    artistLookup,
    track.grandparentRatingKey,
  );
}

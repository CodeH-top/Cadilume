import type { PlexItem } from "./types";

/** Preserve PMS order while filtering duplicates across and within pages. */
export function appendUniqueArtistTracks(current: readonly PlexItem[], incoming: readonly PlexItem[]): PlexItem[] {
  const seen = new Set(current.map((track) => track.ratingKey));
  const appended = incoming.filter((track) => {
    if (seen.has(track.ratingKey)) return false;
    seen.add(track.ratingKey);
    return true;
  });
  return [...current, ...appended];
}

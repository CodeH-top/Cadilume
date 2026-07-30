import { describe, expect, it } from "vitest";
import { appendUniqueArtistTracks } from "./artistTracks";
import type { PlexItem } from "./types";

const track = (ratingKey: string): PlexItem => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}`,
  type: "track",
  title: ratingKey,
});

describe("artist track pagination", () => {
  it("preserves PMS order and removes duplicates across and within pages", () => {
    expect(appendUniqueArtistTracks(
      [track("1"), track("2")],
      [track("2"), track("3"), track("3"), track("4")],
    ).map(({ ratingKey }) => ratingKey)).toEqual(["1", "2", "3", "4"]);
  });
});

import { describe, expect, it } from "vitest";
import { ArtistTrackCollectionCancelledError, appendUniqueArtistTracks, collectAllArtistTracks } from "./artistTracks";
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

  it("collects every page in stable order and shares the server total", async () => {
    const starts: number[] = [];
    const result = await collectAllArtistTracks(async (start) => {
      starts.push(start);
      if (start === 0) return { items: [track("1"), track("2"), track("2")], start, nextStart: 3, totalSize: 5 };
      return { items: [track("3"), track("4")], start, nextStart: 5, totalSize: 5 };
    });

    expect(starts).toEqual([0, 3]);
    expect(result).toEqual({
      tracks: [track("1"), track("2"), track("3"), track("4")],
      totalSize: 5,
    });
  });

  it("fails instead of treating a non-progressing page as a complete collection", async () => {
    await expect(collectAllArtistTracks(async (start) => ({
      items: [track("1")],
      start,
      nextStart: start,
      totalSize: 2,
    }))).rejects.toThrow("歌手歌曲分页没有继续前进");
  });

  it("stops after the active artist operation is cancelled", async () => {
    const controller = new AbortController();
    await expect(collectAllArtistTracks(async () => {
      controller.abort();
      return { items: [track("1")], start: 0, nextStart: 1, totalSize: 2 };
    }, { signal: controller.signal })).rejects.toBeInstanceOf(ArtistTrackCollectionCancelledError);
  });
});

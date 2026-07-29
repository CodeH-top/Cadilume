import { describe, expect, it } from "vitest";
import { selectRandomContextPlayback } from "./contextPlayback";
import type { PlexItem } from "./types";

function item(ratingKey: string, type: string): PlexItem {
  return {
    ratingKey,
    key: `/library/metadata/${ratingKey}`,
    type,
    title: ratingKey,
  };
}

describe("selectRandomContextPlayback", () => {
  it("returns null for an empty context or a context without tracks", () => {
    expect(selectRandomContextPlayback([], () => 0.5)).toBeNull();
    expect(selectRandomContextPlayback([item("artist-1", "artist"), item("album-1", "album")], () => 0.5)).toBeNull();
  });

  it("keeps only tracks and selects strictly inside that queue", () => {
    const first = item("track-1", "track");
    const second = item("track-2", "track");
    const context = [item("album-1", "album"), first, item("artist-1", "artist"), second];

    const selection = selectRandomContextPlayback(context, () => 0.75);

    expect(selection).toEqual({ current: second, queue: [first, second] });
    expect(selection?.queue).not.toContain(context[0]);
    expect(selection?.queue).not.toContain(context[2]);
  });

  it("selects the sole track regardless of the rng result", () => {
    const onlyTrack = item("track-only", "track");

    for (const sample of [0, 0.5, 1, -100, 100, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(selectRandomContextPlayback([onlyTrack], () => sample)).toEqual({
        current: onlyTrack,
        queue: [onlyTrack],
      });
    }
  });

  it("clamps non-finite and out-of-range rng results to a valid index", () => {
    const tracks = [item("track-1", "track"), item("track-2", "track"), item("track-3", "track")];

    expect(selectRandomContextPlayback(tracks, () => Number.NaN)?.current).toBe(tracks[0]);
    expect(selectRandomContextPlayback(tracks, () => Number.NEGATIVE_INFINITY)?.current).toBe(tracks[0]);
    expect(selectRandomContextPlayback(tracks, () => -0.1)?.current).toBe(tracks[0]);
    expect(selectRandomContextPlayback(tracks, () => 1)?.current).toBe(tracks[2]);
    expect(selectRandomContextPlayback(tracks, () => 10)?.current).toBe(tracks[2]);
    expect(selectRandomContextPlayback(tracks, () => Number.POSITIVE_INFINITY)?.current).toBe(tracks[2]);
  });

  it("does not modify the input array", () => {
    const context = Object.freeze([
      Object.freeze(item("album-1", "album")),
      Object.freeze(item("track-1", "track")),
      Object.freeze(item("track-2", "track")),
    ]);
    const originalOrder = [...context];

    const selection = selectRandomContextPlayback(context, () => 0.4);

    expect(context).toEqual(originalOrder);
    expect(selection?.queue).toEqual(originalOrder.slice(1));
    expect(selection?.queue).not.toBe(context);
  });
});

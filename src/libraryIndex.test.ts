import { describe, expect, it } from "vitest";
import { groupPlexItemsByAlphabet, plexAlphabetBucket } from "./libraryIndex";
import type { PlexItem } from "./types";

const item = (ratingKey: string, title: string, titleSort?: string): PlexItem => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}`,
  type: "album",
  title,
  titleSort,
});

describe("Plex alphabet index", () => {
  it("uses titleSort instead of the display title and folds Latin accents", () => {
    expect(plexAlphabetBucket(item("1", "The Beatles", "Beatles"))).toBe("B");
    expect(plexAlphabetBucket(item("2", "Élan"))).toBe("E");
    expect(plexAlphabetBucket(item("3", "周杰伦"))).toBe("#");
    expect(plexAlphabetBucket(item("4", "1989"))).toBe("#");
  });

  it("orders buckets A-Z then # while preserving PMS order within a bucket", () => {
    const groups = groupPlexItemsByAlphabet([
      item("b2", "Bravo Two", "Bravo Two"),
      item("a1", "Alpha", "Alpha"),
      item("b1", "Bravo One", "Bravo One"),
      item("other", "陈奕迅"),
    ]);

    expect(groups.map((group) => group.bucket)).toEqual(["A", "B", "#"]);
    expect(groups[1].items.map(({ ratingKey }) => ratingKey)).toEqual(["b2", "b1"]);
  });
});

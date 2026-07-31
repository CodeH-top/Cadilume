import { describe, expect, it } from "vitest";
import { createArtistLookup, resolveTrackArtists } from "./trackArtists";
import type { PlexItem } from "./types";

const artist = (ratingKey: string, title: string): PlexItem => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}/children`,
  type: "artist",
  title,
});

describe("resolveTrackArtists", () => {
  const artists = [artist("artist-1", "周杰伦"), artist("artist-2", "Mira Lin")];
  const artistLookup = createArtistLookup(artists);

  it("按斜杠拆分显示名，并只关联资料库中存在的独立歌手", () => {
    const result = resolveTrackArtists("周杰伦 / Kobe Bryant", artistLookup);

    expect(result.map(({ name }) => name)).toEqual(["周杰伦", "Kobe Bryant"]);
    expect(result[0].artist?.ratingKey).toBe("artist-1");
    expect(result[1].artist).toBeUndefined();
  });

  it("匹配时兼容 Unicode、大小写和重复空格", () => {
    const result = resolveTrackArtists("  mira   LIN  ", artistLookup);

    expect(result).toEqual([{ name: "mira   LIN", artist: artists[1] }]);
  });

  it("完整歌手名本身含斜杠时优先保留独立实体", () => {
    const slashArtist = artist("artist-3", "AC/DC");

    expect(resolveTrackArtists("AC/DC", createArtistLookup([...artists, slashArtist]))).toEqual([
      { name: "AC/DC", artist: slashArtist },
    ]);
  });
});

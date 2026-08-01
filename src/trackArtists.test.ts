import { describe, expect, it } from "vitest";
import { createArtistLookup, resolveTrackArtists } from "./trackArtists";
import { trackArtist, type PlexItem } from "./types";

const artist = (ratingKey: string, title: string): PlexItem => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}/children`,
  type: "artist",
  title,
});

describe("resolveTrackArtists", () => {
  const artists = [artist("artist-1", "周杰伦"), artist("artist-2", "Mira Lin")];
  const artistLookup = createArtistLookup(artists);

  it("仅在本地资料库能确认成员时拆分旧式斜杠显示名", () => {
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

  it("结构化贡献者保留完整顺序，只有可定位成员变成链接", () => {
    const track: PlexItem = {
      ratingKey: "track-1",
      key: "/library/metadata/track-1",
      type: "track",
      title: "Duet",
      grandparentTitle: "不应作为优先结果的旧字段",
      contributors: [
        { name: "周杰伦", ratingKey: "artist-1" },
        { name: "Kobe Bryant" },
        { name: "Mira Lin", ratingKey: "unknown-id" },
      ],
    };

    const result = resolveTrackArtists(track, artistLookup);

    expect(result.map(({ name }) => name)).toEqual(["周杰伦", "Kobe Bryant", "Mira Lin"]);
    expect(result.map(({ artist: resolved }) => resolved?.ratingKey)).toEqual(["artist-1", undefined, "artist-2"]);
    expect(trackArtist(track)).toBe("周杰伦 / Kobe Bryant / Mira Lin");
  });

  it("结构化成员即使全都不能匹配资料库也不会被过滤", () => {
    const track: PlexItem = {
      ratingKey: "track-2",
      key: "/library/metadata/track-2",
      type: "track",
      title: "Guests",
      contributors: [{ name: "Guest A" }, { name: "Guest B" }],
    };

    expect(resolveTrackArtists(track, artistLookup)).toEqual([
      { name: "Guest A", artist: undefined },
      { name: "Guest B", artist: undefined },
    ]);
  });

  it("未结构化且无法确认成员的 AC/DC 不会被错误拆开", () => {
    expect(resolveTrackArtists("AC/DC", artistLookup)).toEqual([
      { name: "AC/DC", artist: undefined },
    ]);
  });

  it("兼容旧式 grandparent 字段，并忽略结构化列表中的空值和重复项", () => {
    const legacyTrack: PlexItem = {
      ratingKey: "track-3",
      key: "/library/metadata/track-3",
      type: "track",
      title: "Legacy",
      grandparentTitle: "周杰伦",
      grandparentRatingKey: "artist-1",
    };
    const repeatedStructuredTrack: PlexItem = {
      ratingKey: "track-4",
      key: "/library/metadata/track-4",
      type: "track",
      title: "Repeated",
      contributors: [{ name: "Mira Lin" }, { name: "  " }, { name: "Mira Lin", ratingKey: "artist-2" }],
    };

    expect(resolveTrackArtists(legacyTrack, artistLookup)).toEqual([{ name: "周杰伦", artist: artists[0] }]);
    expect(resolveTrackArtists(repeatedStructuredTrack, artistLookup)).toEqual([{ name: "Mira Lin", artist: artists[1] }]);
  });
});

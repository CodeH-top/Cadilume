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

  it("先按精确空格斜杠拆分，即使所有成员均不在本地资料库", () => {
    const result = resolveTrackArtists("S.H.E / 飞轮海", artistLookup);

    expect(result.map(({ name }) => name)).toEqual(["S.H.E", "飞轮海"]);
    expect(result.map(({ artist: resolved }) => resolved)).toEqual([undefined, undefined]);
  });

  it("分别按本地歌手名匹配拆分成员，保留原始显示文本", () => {
    const she = artist("artist-she", "Ｓ．Ｈ．Ｅ");
    const result = resolveTrackArtists("S.H.E / 飞轮海", createArtistLookup([she]));

    expect(result).toEqual([
      { name: "S.H.E", artist: she },
      { name: "飞轮海", artist: undefined },
    ]);
  });

  it("只把精确的空格斜杠空格识别为分隔符", () => {
    for (const displayName of ["AC/DC", "A/B", "A /B", "A/ B"]) {
      expect(resolveTrackArtists(displayName, artistLookup).map(({ name }) => name)).toEqual([displayName]);
    }
    expect(resolveTrackArtists("A / B", artistLookup).map(({ name }) => name)).toEqual(["A", "B"]);
  });

  it("匹配使用规范化后的完整名称，不做部分匹配", () => {
    const result = resolveTrackArtists("  mira   LIN  ", artistLookup);

    expect(result).toEqual([{ name: "mira   LIN", artist: artists[1] }]);
  });

  it("originalTitle 优先于 PMS 结构化成员，并在拆分前保持原始歌手文本", () => {
    const she = artist("artist-she", "S.H.E");
    const fahrenheit = artist("artist-fahrenheit", "飞轮海");
    const track: PlexItem = {
      ratingKey: "track-original-title",
      key: "/library/metadata/track-original-title",
      type: "track",
      title: "酸甜",
      originalTitle: "S.H.E / 飞轮海",
      trackArtists: [{ name: "PMS 不应覆盖原文", ratingKey: "artist-ignored" }],
    };

    expect(trackArtist(track)).toBe("S.H.E / 飞轮海");
    expect(resolveTrackArtists(track, createArtistLookup([she, fahrenheit]))).toEqual([
      { name: "S.H.E", artist: she },
      { name: "飞轮海", artist: fahrenheit },
    ]);
  });

  it("原始文本缺失时才使用结构化字段作为显示来源，且忽略其 rating key", () => {
    const track: PlexItem = {
      ratingKey: "track-structured-fallback",
      key: "/library/metadata/track-structured-fallback",
      type: "track",
      title: "Collaboration",
      trackArtists: [
        { name: "Mira Lin", ratingKey: "incorrect-pms-key" },
        { name: "Guest Artist", ratingKey: "artist-2" },
      ],
    };

    expect(trackArtist(track)).toBe("Mira Lin / Guest Artist");
    expect(resolveTrackArtists(track, artistLookup)).toEqual([
      { name: "Mira Lin", artist: artists[1] },
      { name: "Guest Artist", artist: undefined },
    ]);
  });

  it("兼容旧式专辑歌手回退，但不使用其 rating key 决定可点击性", () => {
    const legacyTrack: PlexItem = {
      ratingKey: "track-legacy",
      key: "/library/metadata/track-legacy",
      type: "track",
      title: "Legacy",
      grandparentTitle: "周杰伦",
      grandparentRatingKey: "not-the-local-rating-key",
    };

    expect(resolveTrackArtists(legacyTrack, artistLookup)).toEqual([{ name: "周杰伦", artist: artists[0] }]);
  });
});

import { describe, expect, it } from "vitest";
import { ARTIST_BIOGRAPHY_COLLAPSE_LENGTH, ARTIST_BIOGRAPHY_COLLAPSE_LINES, normalizeArtistBiography, previewArtistBiography, shouldCollapseArtistBiography } from "./artistBiography";

describe("artist biography presentation", () => {
  it("keeps a short server biography expanded", () => {
    expect(normalizeArtistBiography("  简短介绍  ")).toBe("简短介绍");
    expect(shouldCollapseArtistBiography("简短介绍")).toBe(false);
  });

  it("collapses a long biography without truncating its source value", () => {
    const longBiography = "长".repeat(ARTIST_BIOGRAPHY_COLLAPSE_LENGTH + 1);
    const multilineBiography = Array.from({ length: ARTIST_BIOGRAPHY_COLLAPSE_LINES + 1 }, () => "分段介绍").join("\n");
    expect(shouldCollapseArtistBiography(longBiography)).toBe(true);
    expect(shouldCollapseArtistBiography(multilineBiography)).toBe(true);
    expect(normalizeArtistBiography(longBiography)).toBe(longBiography);
  });

  it("treats missing and whitespace-only biographies as empty", () => {
    expect(normalizeArtistBiography()).toBeUndefined();
    expect(normalizeArtistBiography(" \n\t ")).toBeUndefined();
    expect(shouldCollapseArtistBiography(" \n\t ")).toBe(false);
  });

  it("normalizes line endings and exposes controlled browser-preview fixtures", () => {
    expect(normalizeArtistBiography("第一行\r\n第二行\r第三行")).toBe("第一行\n第二行\n第三行");
    expect(previewArtistBiography(undefined, "short")).toBe("从服务端返回的简短歌手介绍。");
    expect(previewArtistBiography(undefined, "long")).toBeDefined();
    expect(previewArtistBiography("原始简介", "empty")).toBeUndefined();
    expect(previewArtistBiography(undefined, "multiline")).toContain("\n");
  });
});

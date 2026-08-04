export const ARTIST_BIOGRAPHY_COLLAPSE_LENGTH = 260;
export const ARTIST_BIOGRAPHY_COLLAPSE_LINES = 5;

export type ArtistBiographyPreview = "short" | "long" | "empty" | "multiline";

const previewBiographies: Record<ArtistBiographyPreview, string | undefined> = {
  short: "从服务端返回的简短歌手介绍。",
  long: Array.from({ length: 6 }, () => "这是一段用于验证长介绍折叠行为的受控文本，保留真实资料区的阅读节奏与换行边界。").join("\n"),
  empty: undefined,
  multiline: "第一行介绍保留独立段落。\n第二行继续说明创作与演出经历。\n第三行用于验证换行不会被压成一行。",
};

export function normalizeArtistBiography(summary?: string): string | undefined {
  const normalized = summary?.replace(/\r\n?/gu, "\n").trim();
  return normalized || undefined;
}

export function shouldCollapseArtistBiography(summary?: string): boolean {
  const normalized = normalizeArtistBiography(summary);
  if (!normalized) return false;
  return Array.from(normalized).length > ARTIST_BIOGRAPHY_COLLAPSE_LENGTH || normalized.split("\n").length > ARTIST_BIOGRAPHY_COLLAPSE_LINES;
}

export function previewArtistBiography(summary: string | undefined, preview: string | null): string | undefined {
  if (preview === "short" || preview === "long" || preview === "empty" || preview === "multiline") {
    return previewBiographies[preview];
  }
  return summary;
}

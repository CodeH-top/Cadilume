import type { MusicLyricsPayload } from "./types";

export type LyricFormat = "lrc" | "srt" | "vtt" | "plain";

export interface LyricLine {
  id: string;
  startMs: number | null;
  endMs: number | null;
  texts: string[];
  clear?: boolean;
}

export interface LyricsDocument {
  format: LyricFormat;
  timed: boolean;
  offsetMs: number;
  lines: LyricLine[];
  provider?: string;
  author?: string;
  by?: string;
}

export function hasDisplayableLyrics(document?: LyricsDocument): boolean {
  return document?.lines.some((line) => (
    !line.clear && line.texts.some((text) => text.trim().length > 0)
  )) === true;
}

const LRC_TIME = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLyrics(source: string, formatHint?: string): LyricsDocument {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const format = detectFormat(normalized, formatHint);
  if (!normalized) return { format: "plain", timed: false, offsetMs: 0, lines: [] };
  if (format === "lrc") return parseLrc(normalized);
  if (format === "srt" || format === "vtt") return parseSubtitleLyrics(normalized, format);
  return {
    format: "plain",
    timed: false,
    offsetMs: 0,
    lines: normalized.split("\n").map((text, index) => ({
      id: `plain-${index}`,
      startMs: null,
      endMs: null,
      texts: text ? [text] : [],
      clear: !text,
    })),
  };
}

export function findActiveLyricIndex(lines: readonly LyricLine[], playbackMs: number, delayMs = 0): number {
  if (!Number.isFinite(playbackMs) || !Number.isFinite(delayMs) || !lines.length) return -1;
  const lyricTime = playbackMs - delayMs;
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    const start = lines[middle].startMs;
    if (start !== null && start <= lyricTime) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index < 0) return -1;
  const line = lines[index];
  if (line.endMs !== null && lyricTime >= line.endMs) return -1;
  return index;
}

export function normalizeMusicLyrics(payload: MusicLyricsPayload, durationMs?: number): LyricsDocument {
  if (payload.rawText?.trim()) {
    return {
      ...parseLyrics(payload.rawText, payload.formatHint),
      provider: payload.provider,
      author: payload.author,
      by: payload.by,
    };
  }

  const timedSource = payload.timed
    ? payload.lines.filter((line) => Number.isFinite(line.startMs))
    : [];
  if (!timedSource.length) {
    return {
      format: "plain",
      timed: false,
      offsetMs: 0,
      provider: payload.provider,
      author: payload.author,
      by: payload.by,
      lines: payload.lines.map((line, index) => ({
        id: `provider-plain-${index}`,
        startMs: null,
        endMs: null,
        texts: line.text.trim() ? [line.text.trim()] : [],
        clear: !line.text.trim(),
      })),
    };
  }

  const grouped = new Map<number, { texts: string[]; endMs: number | null }>();
  for (const line of timedSource) {
    const startMs = normalizeProviderOffset(line.startMs as number);
    const current = grouped.get(startMs) || { texts: [], endMs: null };
    const text = line.text.trim();
    if (text && !current.texts.includes(text)) current.texts.push(text);
    if (Number.isFinite(line.endMs)) {
      const endMs = normalizeProviderOffset(line.endMs as number);
      if (endMs > startMs) current.endMs = Math.max(current.endMs || 0, endMs);
    }
    grouped.set(startMs, current);
  }

  const sorted = [...grouped.entries()].sort((left, right) => left[0] - right[0]);
  const lines = sorted.map(([startMs, value], index): LyricLine => {
    const nextStart = sorted[index + 1]?.[0] ?? null;
    const explicitEnd = value.endMs && value.endMs > startMs ? value.endMs : null;
    const fallbackEnd = nextStart ?? (durationMs && durationMs > startMs ? Math.round(durationMs) : null);
    return {
      id: `provider-${startMs}-${index}`,
      startMs,
      endMs: explicitEnd ?? fallbackEnd,
      texts: value.texts,
      clear: value.texts.length === 0,
    };
  });

  return {
    format: "plain",
    timed: true,
    offsetMs: 0,
    lines,
    provider: payload.provider,
    author: payload.author,
    by: payload.by,
  };
}

/** @deprecated Use `normalizeMusicLyrics`; retained for existing Plex-focused callers. */
export const normalizePlexLyrics = normalizeMusicLyrics;

function normalizeProviderOffset(value: number): number {
  return Math.max(0, Math.round(value));
}

function detectFormat(source: string, hint?: string): LyricFormat {
  const value = hint?.toLowerCase();
  if (value?.includes("lrc")) return "lrc";
  if (value?.includes("vtt")) return "vtt";
  if (value?.includes("srt")) return "srt";
  if (/^WEBVTT(?:\s|$)/.test(source)) return "vtt";
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(source)) return "srt";
  if (/^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m.test(source)) return "lrc";
  return "plain";
}

function parseLrc(source: string): LyricsDocument {
  let offsetMs = 0;
  const grouped = new Map<number, { order: number; texts: string[]; clear: boolean }>();
  source.split("\n").forEach((rawLine, sourceIndex) => {
    const offset = rawLine.match(/^\s*\[offset:([+-]?\d+)\]\s*$/i);
    if (offset) {
      offsetMs = Number.parseInt(offset[1], 10) || 0;
      return;
    }
    const tags = [...rawLine.matchAll(LRC_TIME)];
    if (!tags.length || tags[0].index !== rawLine.search(/\S|$/)) return;
    const lastTag = tags[tags.length - 1];
    const text = rawLine
      .slice((lastTag.index || 0) + lastTag[0].length)
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "")
      .trim();
    for (const tag of tags) {
      const second = Number.parseInt(tag[2], 10);
      if (second > 59) continue;
      const fraction = tag[3] ? Number.parseInt(tag[3].padEnd(3, "0"), 10) : 0;
      const rawTime = Number.parseInt(tag[1], 10) * 60_000 + second * 1000 + fraction;
      const current = grouped.get(rawTime) || { order: sourceIndex, texts: [], clear: false };
      if (text && !current.texts.includes(text)) current.texts.push(text);
      if (!text) current.clear = true;
      grouped.set(rawTime, current);
    }
  });

  const entries = [...grouped.entries()]
    .map(([time, value]) => [Math.max(0, time + offsetMs), value] as const)
    .sort((left, right) => left[0] - right[0] || left[1].order - right[1].order);
  const merged = new Map<number, { texts: string[]; clear: boolean }>();
  for (const [time, value] of entries) {
    const current = merged.get(time) || { texts: [], clear: false };
    for (const text of value.texts) if (!current.texts.includes(text)) current.texts.push(text);
    current.clear ||= value.clear;
    merged.set(time, current);
  }
  const sorted = [...merged.entries()].sort((left, right) => left[0] - right[0]);
  return {
    format: "lrc",
    timed: true,
    offsetMs,
    lines: sorted.map(([startMs, value], index) => ({
      id: `lrc-${startMs}-${index}`,
      startMs,
      endMs: sorted[index + 1]?.[0] ?? null,
      texts: value.texts,
      clear: value.clear && !value.texts.length,
    })),
  };
}

function parseSubtitleLyrics(source: string, format: "srt" | "vtt"): LyricsDocument {
  const cleaned = source
    .replace(/^WEBVTT[^\n]*\n/, "")
    .replace(/^(NOTE|STYLE|REGION)(?:.|\n)*?(?=\n\n|$)/gm, "");
  const lines: LyricLine[] = [];
  for (const [blockIndex, block] of cleaned.split(/\n{2,}/).entries()) {
    const rows = block.split("\n").filter(Boolean);
    const timingIndex = rows.findIndex((row) => row.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endWithSettings] = rows[timingIndex].split(/\s+-->\s+/);
    const startMs = parseCueTimestamp(startText);
    const endMs = parseCueTimestamp(endWithSettings?.split(/\s+/)[0] || "");
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const texts = rows.slice(timingIndex + 1).map(cleanCueText).filter(Boolean);
    lines.push({ id: `${format}-${blockIndex}`, startMs, endMs, texts, clear: !texts.length });
  }
  lines.sort((left, right) => (left.startMs || 0) - (right.startMs || 0));
  return { format, timed: true, offsetMs: 0, lines };
}

function parseCueTimestamp(value: string): number | null {
  const match = value.match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1] || "0", 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + Number.parseInt(match[4], 10);
}

function cleanCueText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

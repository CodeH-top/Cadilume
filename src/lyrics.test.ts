import { describe, expect, it } from "vitest";
import { findActiveLyricIndex, normalizePlexLyrics, parseLyrics } from "./lyrics";

describe("lyrics parser", () => {
  it("parses LRC fractions, multiple timestamps and offset", () => {
    const document = parseLyrics("[00:01.07][00:02.007]第一句\n[offset:+500]\n[00:03.7]第二句");
    expect(document.format).toBe("lrc");
    expect(document.lines.map((line) => line.startMs)).toEqual([1570, 2507, 4200]);
    expect(document.lines[0].texts).toEqual(["第一句"]);
  });

  it("groups translations at the same timestamp and keeps clear frames", () => {
    const document = parseLyrics("[00:01.00]Original\n[00:01.00]翻译\n[00:02.00]");
    expect(document.lines).toHaveLength(2);
    expect(document.lines[0].texts).toEqual(["Original", "翻译"]);
    expect(document.lines[1].clear).toBe(true);
  });

  it("parses SRT and respects cue gaps", () => {
    const document = parseLyrics("1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld");
    expect(document.format).toBe("srt");
    expect(findActiveLyricIndex(document.lines, 1500)).toBe(0);
    expect(findActiveLyricIndex(document.lines, 2500)).toBe(-1);
    expect(findActiveLyricIndex(document.lines, 3000)).toBe(1);
  });

  it("parses VTT cue text without markup", () => {
    const document = parseLyrics("WEBVTT\n\n00:01.000 --> 00:02.500 align:center\n<v Alice>Hello &amp; hi</v>");
    expect(document.format).toBe("vtt");
    expect(document.lines[0].texts).toEqual(["Hello & hi"]);
  });

  it("falls back to unsynchronised plain text", () => {
    const document = parseLyrics("Verse one\n\nVerse two");
    expect(document.timed).toBe(false);
    expect(document.lines[1].clear).toBe(true);
  });

  it("applies a user delay without clamping the query", () => {
    const document = parseLyrics("[00:01.00]Line");
    expect(findActiveLyricIndex(document.lines, 1200, 500)).toBe(-1);
    expect(findActiveLyricIndex(document.lines, 1500, 500)).toBe(0);
  });

  it("normalizes Plex XML lines and groups bilingual text", () => {
    const document = normalizePlexLyrics({
      provider: "com.plexapp.agents.localmedia",
      timed: true,
      lines: [
        { startMs: 1000, text: "Original" },
        { startMs: 1000, text: "翻译" },
        { startMs: 3000, text: "Next" },
      ],
    }, 5000);

    expect(document.provider).toBe("com.plexapp.agents.localmedia");
    expect(document.lines).toHaveLength(2);
    expect(document.lines[0]).toMatchObject({ startMs: 1000, endMs: 3000, texts: ["Original", "翻译"] });
    expect(document.lines[1].endMs).toBe(5000);
  });

  it("keeps untimed Plex lyrics as ordinary text", () => {
    const document = normalizePlexLyrics({
      timed: false,
      rawText: "第一段\n\n第二段",
      formatHint: "txt",
      lines: [],
    });

    expect(document.timed).toBe(false);
    expect(document.lines.map((line) => line.texts[0] || "")).toEqual(["第一段", "", "第二段"]);
  });
});

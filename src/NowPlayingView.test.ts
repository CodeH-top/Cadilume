import { describe, expect, it } from "vitest";
import {
  artworkThemeContrastRatio,
  artworkThemeStyle,
  getArtworkThemeFromBlurHash,
  getArtworkThemeFromPalette,
  getArtworkThemeFromPixels,
  getDominantArtworkColor,
  resolveArtworkTheme,
  type ArtworkThemeColor,
} from "./artworkTheme";
import { getLyricProgress } from "./NowPlayingView";
import { getCenteredLyricsScrollTop, getLyricsScrollPlan } from "./lyricsScroll";

describe("expanded player lyric progress", () => {
  const line = { id: "line-1", startMs: 1_000, endMs: 3_000, texts: ["Line"] };

  it("clamps a timed lyric gradient to its exact millisecond window", () => {
    expect(getLyricProgress(line, 900)).toBe(0);
    expect(getLyricProgress(line, 2_000)).toBe(0.5);
    expect(getLyricProgress(line, 3_200)).toBe(1);
  });

  it("keeps untimed lyrics static", () => {
    expect(getLyricProgress({ ...line, startMs: null, endMs: null }, 2_000)).toBe(0);
  });
});

describe("expanded player artwork theme", () => {
  it("selects the dominant chromatic mid-tone while ignoring transparent and extreme pixels", () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
      200, 40, 56, 255,
      198, 42, 54, 255,
      40, 80, 190, 80,
    ]);

    expect(getDominantArtworkColor(pixels)).toEqual({ red: 199, green: 41, blue: 55 });
  });

  it("retains a usable neutral theme for monochrome artwork", () => {
    const pixels = new Uint8ClampedArray([
      114, 118, 124, 255,
      116, 120, 126, 255,
      250, 250, 250, 255,
    ]);

    expect(getDominantArtworkColor(pixels)).toEqual({ red: 115, green: 119, blue: 125 });
  });

  it("decodes PMS BlurHash artwork data and rejects malformed fields", () => {
    const theme = getArtworkThemeFromBlurHash("LEHV6nWB2yk8pyo0adR*.7kCMdnj");

    for (const color of Object.values(theme ?? {})) {
      expect(color).toEqual(expect.objectContaining({
        red: expect.any(Number),
        green: expect.any(Number),
        blue: expect.any(Number),
      }));
    }
    expect(new Set([
      theme?.topLeft,
      theme?.topRight,
      theme?.bottomRight,
      theme?.bottomLeft,
    ].map((color) => color && `${color.red},${color.green},${color.blue}`)).size).toBeGreaterThan(1);
    expect(theme).not.toHaveProperty("backgroundImage");
    expect(getArtworkThemeFromBlurHash("not-a-blurhash")).toBeUndefined();
  });

  it("preserves all source quadrants in the rendered gradient coordinate system", () => {
    const width = 4;
    const height = 4;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const colors = {
      topLeft: [210, 42, 58],
      topRight: [32, 174, 92],
      bottomRight: [42, 82, 212],
      bottomLeft: [214, 166, 34],
    } as const;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const color = y < height / 2
          ? (x < width / 2 ? colors.topLeft : colors.topRight)
          : (x < width / 2 ? colors.bottomLeft : colors.bottomRight);
        pixels.set([...color, 255], (y * width + x) * 4);
      }
    }

    const theme = getArtworkThemeFromPixels(pixels, width, height);
    expect(theme?.topLeft.red).toBeGreaterThan(theme?.topLeft.blue ?? 255);
    expect(theme?.topRight.blue).toBeGreaterThan(theme?.topRight.red ?? 255);
    expect(theme?.bottomRight.green).toBeGreaterThan(theme?.bottomRight.red ?? 255);
    expect(theme?.bottomLeft.red).toBeGreaterThan(theme?.bottomLeft.green ?? 255);
  });

  it("selects spatially diverse mid-tones from a 20-color palette", () => {
    const hex = (value: string): ArtworkThemeColor => ({
      red: Number.parseInt(value.slice(1, 3), 16),
      green: Number.parseInt(value.slice(3, 5), 16),
      blue: Number.parseInt(value.slice(5, 7), 16),
    });
    const palette = [
      "#038ACC", "#034464", "#FFF301", "#493929", "#8FCF03",
      "#0589C7", "#033852", "#653A0E", "#FFFA00", "#BDAB04",
      "#4B3A2E", "#999186", "#9B4103", "#E6AA78", "#C78F2D",
      "#424139", "#887E78", "#A16440", "#EBD9C6", "#C3AB92",
    ].map(hex);

    const theme = getArtworkThemeFromPalette(palette);
    const expectColorNear = (actual: ArtworkThemeColor | undefined, expected: ArtworkThemeColor) => {
      expect(actual).toBeDefined();
      expect(Math.abs(actual!.red - expected.red)).toBeLessThanOrEqual(1);
      expect(Math.abs(actual!.green - expected.green)).toBeLessThanOrEqual(1);
      expect(Math.abs(actual!.blue - expected.blue)).toBeLessThanOrEqual(1);
    };

    expect(theme?.primary).toEqual(hex("#655840"));
    expectColorNear(theme?.topLeft, hex("#9C623F"));
    expectColorNear(theme?.topRight, hex("#5F4516"));
    expectColorNear(theme?.bottomRight, hex("#945514"));
    expectColorNear(theme?.bottomLeft, hex("#026697"));
  });

  it("keeps all four gradient stops readable in dark and light appearances", () => {
    const theme = getArtworkThemeFromPixels(new Uint8ClampedArray([
      228, 34, 48, 255, 24, 178, 94, 255,
      224, 172, 30, 255, 38, 78, 216, 255,
    ]), 2, 2);

    for (const color of [theme?.topLeft, theme?.topRight, theme?.bottomRight, theme?.bottomLeft]) {
      expect(color).toBeDefined();
      expect(artworkThemeContrastRatio(color!, "dark")).toBeGreaterThanOrEqual(4.5);
      expect(artworkThemeContrastRatio(color!, "light")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("emits four independent CSS color stops instead of artwork imagery", () => {
    const red = { red: 180, green: 32, blue: 42 };
    const green = { red: 26, green: 142, blue: 76 };
    const blue = { red: 30, green: 70, blue: 170 };
    const yellow = { red: 182, green: 142, blue: 28 };
    const style = artworkThemeStyle({
      primary: red,
      topLeft: red,
      topRight: green,
      bottomRight: blue,
      bottomLeft: yellow,
    });

    expect(style).toMatchObject({
      "--now-playing-artwork-top-left": "rgb(180 32 42)",
      "--now-playing-artwork-top-right": "rgb(26 142 76)",
      "--now-playing-artwork-bottom-right": "rgb(30 70 170)",
      "--now-playing-artwork-bottom-left": "rgb(182 142 28)",
    });
    expect(style).not.toHaveProperty("backgroundImage");
  });

  it("keeps a usable palette for very dark artwork and transparent quadrants", () => {
    const darkPixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let index = 0; index < darkPixels.length; index += 4) {
      darkPixels.set([4, 8, 14, 255], index);
    }
    const darkTheme = getArtworkThemeFromPixels(darkPixels, 4, 4);
    expect(darkTheme).toBeDefined();
    expect(Object.values(darkTheme ?? {}).every((color) => (
      [color.red, color.green, color.blue].every(Number.isFinite)
    ))).toBe(true);

    const sparsePixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        sparsePixels.set([32, 126, 190, 255], (y * 4 + x) * 4);
      }
    }
    const sparseTheme = getArtworkThemeFromPixels(sparsePixels, 4, 4);
    expect(sparseTheme).toBeDefined();
    expect(Object.values(sparseTheme ?? {}).every((color) => (
      [color.red, color.green, color.blue].every(Number.isFinite)
    ))).toBe(true);
    expect(getArtworkThemeFromPixels(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeUndefined();
  });

  it("prioritizes current artwork, then BlurHash, while retaining the previous palette during loading", () => {
    const theme = (red: number) => ({
      primary: { red, green: 50, blue: 60 },
      topLeft: { red, green: 55, blue: 65 },
      topRight: { red, green: 60, blue: 70 },
      bottomRight: { red, green: 65, blue: 75 },
      bottomLeft: { red, green: 70, blue: 80 },
    });
    const artwork = theme(100);
    const blurHash = theme(120);
    const retained = theme(140);

    expect(resolveArtworkTheme(artwork, blurHash, retained)).toEqual({
      theme: artwork,
      source: "artwork",
      pending: false,
    });
    expect(resolveArtworkTheme(undefined, blurHash, retained)).toEqual({
      theme: blurHash,
      source: "blurhash",
      pending: false,
    });
    expect(resolveArtworkTheme(undefined, undefined, retained)).toEqual({
      theme: retained,
      source: "artwork",
      pending: true,
    });
    expect(resolveArtworkTheme()).toEqual({ source: "fallback", pending: false });
  });
});

describe("expanded player lyric scrolling", () => {
  const line = { id: "line-1", startMs: 1_000, endMs: 3_000, texts: ["Line"] };

  it("keeps an active lyric centered even when it was already visible", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: 150,
      targetHeight: 40,
    })).toBe(170);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -10,
      targetHeight: 40,
    })).toBe(10);
  });

  it("centers an offscreen lyric and clamps both scroll boundaries", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 0,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 360,
      targetHeight: 40,
    })).toBe(280);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 220,
      targetHeight: 20,
    })).toBe(230);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 550,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 220,
      targetHeight: 30,
    })).toBe(600);

    expect(getCenteredLyricsScrollTop({
      scrollTop: 0,
      viewportHeight: 200,
      contentHeight: 800,
      targetTop: 12,
      targetHeight: 30,
    })).toBe(0);
  });

  it("returns zero when the lyrics do not overflow their viewport", () => {
    expect(getCenteredLyricsScrollTop({
      scrollTop: 40,
      viewportHeight: 300,
      contentHeight: 180,
      targetTop: 120,
      targetHeight: 24,
    })).toBe(0);
  });

  it("instantly reclaims a manually scrolled list for the opening lyrics", () => {
    expect(getLyricsScrollPlan({
      activeLine: line,
      manuallyScrolled: true,
      reducedMotion: false,
      scrollTop: 480,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -460,
      targetHeight: 40,
    })).toEqual({
      top: 0,
      behavior: "instant",
      consumeManualOverride: true,
    });
  });

  it("preserves manual control through clear frames until a visible lyric arrives", () => {
    const metrics = {
      manuallyScrolled: true,
      reducedMotion: false,
      scrollTop: 400,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: -360,
      targetHeight: 20,
    };
    expect(getLyricsScrollPlan({
      ...metrics,
      activeLine: { ...line, clear: true, texts: [] },
    })).toBeUndefined();
    expect(getLyricsScrollPlan({ ...metrics, activeLine: line })).toMatchObject({
      behavior: "instant",
      consumeManualOverride: true,
    });
  });

  it("keeps ordinary middle-line following smooth and reduced motion instant", () => {
    const metrics = {
      activeLine: line,
      manuallyScrolled: false,
      scrollTop: 100,
      viewportHeight: 200,
      contentHeight: 1_000,
      targetTop: 150,
      targetHeight: 40,
    };
    expect(getLyricsScrollPlan({ ...metrics, reducedMotion: false })).toMatchObject({
      top: 170,
      behavior: "smooth",
      consumeManualOverride: false,
    });
    expect(getLyricsScrollPlan({ ...metrics, reducedMotion: true })).toMatchObject({
      top: 170,
      behavior: "instant",
      consumeManualOverride: false,
    });
  });
});

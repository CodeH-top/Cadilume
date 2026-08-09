import { decode, isBlurhashValid } from "blurhash";

export interface ArtworkThemeColor {
  red: number;
  green: number;
  blue: number;
}

export interface ArtworkTheme {
  primary: ArtworkThemeColor;
  topLeft: ArtworkThemeColor;
  topRight: ArtworkThemeColor;
  bottomRight: ArtworkThemeColor;
  bottomLeft: ArtworkThemeColor;
}

export type ArtworkThemeSource = "artwork" | "blurhash" | "fallback";

export interface ArtworkThemeResolution {
  theme?: ArtworkTheme;
  source: ArtworkThemeSource;
  pending: boolean;
}

type ArtworkThemeAppearance = "dark" | "light";
type ArtworkQuadrant = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";

interface ArtworkColorBucket {
  count: number;
  redTotal: number;
  greenTotal: number;
  blueTotal: number;
}

interface ArtworkColorCandidate {
  color: ArtworkThemeColor;
  score: number;
  saturation: number;
  value: number;
  hue: number;
}

interface HslColor {
  hue: number;
  saturation: number;
  lightness: number;
}

const ARTWORK_SAMPLE_SIZE = 150;
const BLUR_HASH_SAMPLE_SIZE = 32;
const BLUR_HASH_PUNCH = 1.2;
const CANDIDATES_PER_QUADRANT = 5;
const QUANTIZATION_SHIFT = 4;
const MINIMUM_MEANINGFUL_VALUE = 23.5;
const QUADRANTS: readonly ArtworkQuadrant[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampByte(value: number): number {
  return Math.round(clamp(value, 0, 255));
}

function colorKey(color: ArtworkThemeColor): string {
  return `${color.red},${color.green},${color.blue}`;
}

function rgbToHsl(color: ArtworkThemeColor): HslColor {
  const red = color.red / 255;
  const green = color.green / 255;
  const blue = color.blue / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  let hue = 0;

  if (chroma > 0) {
    if (maximum === red) hue = ((green - blue) / chroma) % 6;
    else if (maximum === green) hue = (blue - red) / chroma + 2;
    else hue = (red - green) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
  }

  const saturation = chroma === 0
    ? 0
    : chroma / Math.max(0.0001, 1 - Math.abs(2 * lightness - 1));
  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

function hslToRgb({ hue, saturation, lightness }: HslColor): ArtworkThemeColor {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const normalizedSaturation = clamp(saturation, 0, 100) / 100;
  const normalizedLightness = clamp(lightness, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const section = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (section < 1) [red, green] = [chroma, secondary];
  else if (section < 2) [red, green] = [secondary, chroma];
  else if (section < 3) [green, blue] = [chroma, secondary];
  else if (section < 4) [green, blue] = [secondary, chroma];
  else if (section < 5) [red, blue] = [secondary, chroma];
  else [red, blue] = [chroma, secondary];

  const match = normalizedLightness - chroma / 2;
  return {
    red: clampByte((red + match) * 255),
    green: clampByte((green + match) * 255),
    blue: clampByte((blue + match) * 255),
  };
}

function hueDistance(first: number, second: number): number {
  const difference = Math.abs(first - second);
  return Math.min(difference, 360 - difference);
}

function rgbDistance(first: ArtworkThemeColor, second: ArtworkThemeColor): number {
  const red = first.red - second.red;
  const green = first.green - second.green;
  const blue = first.blue - second.blue;
  return Math.sqrt(red * red * 0.3 + green * green * 0.59 + blue * blue * 0.11);
}

function colorPercentageDifference(first: ArtworkThemeColor, second: ArtworkThemeColor): number {
  return (
    Math.abs(first.red - second.red)
    + Math.abs(first.green - second.green)
    + Math.abs(first.blue - second.blue)
  ) / (255 * 3) * 100;
}

function candidateFromBucket(bucket: ArtworkColorBucket): ArtworkColorCandidate {
  const color = {
    red: Math.round(bucket.redTotal / bucket.count),
    green: Math.round(bucket.greenTotal / bucket.count),
    blue: Math.round(bucket.blueTotal / bucket.count),
  };
  const maximum = Math.max(color.red, color.green, color.blue) / 255;
  const minimum = Math.min(color.red, color.green, color.blue) / 255;
  const saturation = maximum > 0 ? (maximum - minimum) / maximum * 100 : 0;
  const hsl = rgbToHsl(color);
  const chromaWeight = 0.35 + (saturation / 100) ** 1.5 * 1.65;
  const edgePenalty = maximum < 0.025 || minimum > 0.975 ? 0.4 : 1;
  return {
    color,
    score: bucket.count * chromaWeight * edgePenalty,
    saturation,
    value: maximum * 100,
    hue: hsl.hue,
  };
}

function pixelBelongsToQuadrant(
  pixelIndex: number,
  width: number,
  height: number,
  quadrant: ArtworkQuadrant,
): boolean {
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  const normalizedX = x / Math.max(1, width - 1);
  const normalizedY = y / Math.max(1, height - 1);
  const left = normalizedX <= 0.42;
  const right = normalizedX >= 0.58;
  const top = normalizedY <= 0.42;
  const bottom = normalizedY >= 0.58;
  if (quadrant === "topLeft") return left && top;
  if (quadrant === "topRight") return right && top;
  if (quadrant === "bottomRight") return right && bottom;
  return left && bottom;
}

function extractQuadrantCandidates(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  quadrant: ArtworkQuadrant,
): ArtworkThemeColor[] {
  const buckets = new Map<number, ArtworkColorBucket>();
  const pixelCount = width * height;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (!pixelBelongsToQuadrant(pixelIndex, width, height, quadrant)) continue;
    const index = pixelIndex * 4;
    const alpha = Number(pixels[index + 3]) / 255;
    if (!Number.isFinite(alpha) || alpha < 0.5) continue;
    const red = Number(pixels[index]);
    const green = Number(pixels[index + 1]);
    const blue = Number(pixels[index + 2]);
    if (![red, green, blue].every(Number.isFinite)) continue;

    const key = ((red >> QUANTIZATION_SHIFT) << 8)
      | ((green >> QUANTIZATION_SHIFT) << 4)
      | (blue >> QUANTIZATION_SHIFT);
    const bucket = buckets.get(key) ?? { count: 0, redTotal: 0, greenTotal: 0, blueTotal: 0 };
    bucket.count += alpha;
    bucket.redTotal += red * alpha;
    bucket.greenTotal += green * alpha;
    bucket.blueTotal += blue * alpha;
    buckets.set(key, bucket);
  }

  const allCandidates = Array.from(buckets.values(), candidateFromBucket)
    .sort((first, second) => second.score - first.score);
  if (!allCandidates.length) return [];
  const meaningfulCandidates = allCandidates.filter((candidate) => candidate.value >= MINIMUM_MEANINGFUL_VALUE);
  const ranked = meaningfulCandidates.length ? meaningfulCandidates : allCandidates;

  const selected: ArtworkColorCandidate[] = [];
  for (const minimumDistance of [22, 12, 0]) {
    for (const candidate of ranked) {
      if (selected.length >= CANDIDATES_PER_QUADRANT) break;
      if (selected.some((existing) => colorKey(existing.color) === colorKey(candidate.color))) continue;
      if (selected.every((existing) => rgbDistance(existing.color, candidate.color) >= minimumDistance)) {
        selected.push(candidate);
      }
    }
    if (selected.length >= CANDIDATES_PER_QUADRANT) break;
  }

  while (selected.length < CANDIDATES_PER_QUADRANT) selected.push(selected[0]);
  return selected.map((candidate) => candidate.color);
}

function getCandidateMetadata(color: ArtworkThemeColor): ArtworkColorCandidate {
  const maximum = Math.max(color.red, color.green, color.blue) / 255;
  const minimum = Math.min(color.red, color.green, color.blue) / 255;
  return {
    color,
    score: 0,
    saturation: maximum > 0 ? (maximum - minimum) / maximum * 100 : 0,
    value: maximum * 100,
    hue: rgbToHsl(color).hue,
  };
}

function colorsInRange(
  colors: readonly ArtworkColorCandidate[],
  minimumSaturation: number,
  maximumSaturation: number,
  minimumValue: number,
  maximumValue: number,
): ArtworkColorCandidate[] | undefined {
  const matches = colors.filter((color) => (
    color.saturation >= minimumSaturation
    && color.saturation <= maximumSaturation
    && color.value >= minimumValue
    && color.value <= maximumValue
  ));
  return matches.length ? matches : undefined;
}

function preferDifferentHue(
  colors: ArtworkColorCandidate[] | undefined,
  previous?: ArtworkColorCandidate,
): ArtworkColorCandidate[] | undefined {
  if (!colors || colors.length < 2 || !previous) return colors;
  let mostDifferent: ArtworkColorCandidate | undefined;
  let greatestDistance = -1;
  for (const color of colors) {
    const difference = hueDistance(previous.hue, color.hue);
    if (difference > greatestDistance) {
      greatestDistance = difference;
      mostDifferent = color;
    }
    if (difference > 20) return [color];
  }
  return mostDifferent ? [mostDifferent] : undefined;
}

function selectQuadrantColor(
  colors: readonly ArtworkThemeColor[],
  previous?: ArtworkColorCandidate,
): ArtworkColorCandidate {
  const candidates = colors.slice(0, CANDIDATES_PER_QUADRANT).map(getCandidateMetadata);
  while (candidates.length < CANDIDATES_PER_QUADRANT) candidates.push(candidates[0]);

  let matches = preferDifferentHue(colorsInRange(candidates, 15, 100, 20, 99), previous);
  matches ??= preferDifferentHue(colorsInRange(candidates.slice(0, 2), 2, 40, 30, 95), previous);
  matches ??= colorsInRange(candidates.slice(1, 2), 2, 40, 60, 95);
  matches ??= preferDifferentHue(colorsInRange(candidates.slice(1), 30, 100, 25, 100), previous);
  matches ??= preferDifferentHue(colorsInRange(candidates.slice(1), 15, 100, 25, 100), previous);
  matches ??= preferDifferentHue(colorsInRange(candidates, 5, 90, 5, 90), previous);
  return matches?.[0] ?? candidates[0];
}

function setThemeLightness(color: ArtworkColorCandidate): HslColor {
  const hsl = rgbToHsl(color.color);
  return {
    ...hsl,
    lightness: hsl.saturation > 80 ? 30 : 33,
  };
}

function stretchColorPair(colors: HslColor[], firstIndex: number, secondIndex: number): void {
  const first = hslToRgb(colors[firstIndex]);
  const second = hslToRgb(colors[secondIndex]);
  if (colorPercentageDifference(first, second) >= 15) return;
  if (colors[firstIndex].lightness > colors[secondIndex].lightness) {
    colors[firstIndex].lightness = clamp(colors[firstIndex].lightness + 10, 0, 100);
    colors[secondIndex].lightness = clamp(colors[secondIndex].lightness - 10, 0, 100);
  } else {
    colors[firstIndex].lightness = clamp(colors[firstIndex].lightness - 10, 0, 100);
    colors[secondIndex].lightness = clamp(colors[secondIndex].lightness + 10, 0, 100);
  }
}

function averageColors(colors: readonly ArtworkThemeColor[]): ArtworkThemeColor {
  const totals = colors.reduce((result, color) => ({
    red: result.red + color.red,
    green: result.green + color.green,
    blue: result.blue + color.blue,
  }), { red: 0, green: 0, blue: 0 });
  return {
    red: Math.round(totals.red / colors.length),
    green: Math.round(totals.green / colors.length),
    blue: Math.round(totals.blue / colors.length),
  };
}

export function getArtworkThemeFromPalette(palette: readonly ArtworkThemeColor[]): ArtworkTheme | undefined {
  if (!palette.length) return undefined;
  const normalized = palette.slice(0, CANDIDATES_PER_QUADRANT * QUADRANTS.length);
  while (normalized.length < CANDIDATES_PER_QUADRANT * QUADRANTS.length) {
    normalized.push(normalized[normalized.length - 1] ?? normalized[0]);
  }

  const selected: ArtworkColorCandidate[] = [];
  for (let index = 0; index < QUADRANTS.length; index += 1) {
    const group = normalized.slice(
      index * CANDIDATES_PER_QUADRANT,
      (index + 1) * CANDIDATES_PER_QUADRANT,
    );
    selected.push(selectQuadrantColor(group, selected[selected.length - 1]));
  }

  const themed = selected.map(setThemeLightness);
  stretchColorPair(themed, 0, 1);
  stretchColorPair(themed, 2, 3);
  const [sourceTopLeft, sourceTopRight, sourceBottomRight, sourceBottomLeft] = themed.map(hslToRgb);
  // Canvas scanlines and the reference image analyzer use opposite Y origins.
  // Flip the two rows once so the public fields describe rendered CSS corners.
  const topLeft = sourceBottomLeft;
  const topRight = sourceBottomRight;
  const bottomRight = sourceTopRight;
  const bottomLeft = sourceTopLeft;
  return {
    primary: averageColors([topLeft, topRight, bottomRight, bottomLeft]),
    topLeft,
    topRight,
    bottomRight,
    bottomLeft,
  };
}

export function extractArtworkPalette(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): ArtworkThemeColor[] {
  if (!Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 2
    || height < 2
    || pixels.length < width * height * 4) return [];

  const groups = QUADRANTS.map((quadrant) => extractQuadrantCandidates(pixels, width, height, quadrant));
  const fallback = groups.find((group) => group.length)?.[0];
  if (!fallback) return [];
  return groups.flatMap((group) => (
    group.length ? group : Array.from({ length: CANDIDATES_PER_QUADRANT }, () => fallback)
  ));
}

export function getArtworkThemeFromPixels(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): ArtworkTheme | undefined {
  return getArtworkThemeFromPalette(extractArtworkPalette(pixels, width, height));
}

export function getArtworkThemeFromBlurHash(blurHash?: string): ArtworkTheme | undefined {
  const normalized = blurHash?.trim();
  if (!normalized || !isBlurhashValid(normalized).result) return undefined;
  try {
    const pixels = decode(normalized, BLUR_HASH_SAMPLE_SIZE, BLUR_HASH_SAMPLE_SIZE, BLUR_HASH_PUNCH);
    return getArtworkThemeFromPixels(pixels, BLUR_HASH_SAMPLE_SIZE, BLUR_HASH_SAMPLE_SIZE);
  } catch {
    return undefined;
  }
}

export function resolveArtworkTheme(
  currentArtworkTheme?: ArtworkTheme,
  blurHashTheme?: ArtworkTheme,
  retainedArtworkTheme?: ArtworkTheme,
): ArtworkThemeResolution {
  if (currentArtworkTheme) return { theme: currentArtworkTheme, source: "artwork", pending: false };
  if (blurHashTheme) return { theme: blurHashTheme, source: "blurhash", pending: false };
  if (retainedArtworkTheme) return { theme: retainedArtworkTheme, source: "artwork", pending: true };
  return { source: "fallback", pending: false };
}

export function sampleArtworkTheme(image: HTMLImageElement): ArtworkTheme | undefined {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = ARTWORK_SAMPLE_SIZE;
  canvas.height = ARTWORK_SAMPLE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;

  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return getArtworkThemeFromPixels(pixels, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
}

export function artworkThemeStyle(theme: ArtworkTheme): Record<string, string> {
  const values: Array<[string, ArtworkThemeColor]> = [
    ["primary", theme.primary],
    ["top-left", theme.topLeft],
    ["top-right", theme.topRight],
    ["bottom-right", theme.bottomRight],
    ["bottom-left", theme.bottomLeft],
  ];
  return Object.fromEntries(values.map(([name, color]) => [
    `--now-playing-artwork-${name}`,
    `rgb(${color.red} ${color.green} ${color.blue})`,
  ]));
}

/** Legacy single-color helper retained for callers that only need one swatch. */
export function getDominantArtworkColor(pixels: ArrayLike<number>): ArtworkThemeColor | undefined {
  const buckets = new Map<number, ArtworkColorBucket>();
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const red = Number(pixels[index]);
    const green = Number(pixels[index + 1]);
    const blue = Number(pixels[index + 2]);
    const alpha = Number(pixels[index + 3]) / 255;
    if (![red, green, blue, alpha].every(Number.isFinite) || alpha < 0.5) continue;

    const maximum = Math.max(red, green, blue) / 255;
    const minimum = Math.min(red, green, blue) / 255;
    const lightness = (maximum + minimum) / 2;
    if (lightness < 0.06 || lightness > 0.94) continue;
    const chroma = maximum - minimum;
    const saturation = chroma === 0 ? 0 : chroma / Math.max(0.001, 1 - Math.abs(2 * lightness - 1));
    const middleToneWeight = 1 - Math.min(0.72, Math.abs(lightness - 0.5) * 1.1);
    const score = alpha * (0.45 + saturation * 1.55) * middleToneWeight;
    const key = ((red >> 5) << 6) | ((green >> 5) << 3) | (blue >> 5);
    const bucket = buckets.get(key) ?? { count: 0, redTotal: 0, greenTotal: 0, blueTotal: 0 };
    bucket.count += score;
    bucket.redTotal += red * score;
    bucket.greenTotal += green * score;
    bucket.blueTotal += blue * score;
    buckets.set(key, bucket);
  }

  let dominant: ArtworkColorBucket | undefined;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (!dominant || dominant.count <= 0) return undefined;
  return {
    red: Math.round(dominant.redTotal / dominant.count),
    green: Math.round(dominant.greenTotal / dominant.count),
    blue: Math.round(dominant.blueTotal / dominant.count),
  };
}

export function artworkThemeContrastRatio(
  background: ArtworkThemeColor,
  appearance: ArtworkThemeAppearance,
): number {
  const foreground = appearance === "dark"
    ? { red: 247, green: 248, blue: 251 }
    : { red: 32, green: 38, blue: 49 };
  const base = appearance === "dark"
    ? { red: 10, green: 12, blue: 15 }
    : { red: 245, green: 246, blue: 248 };
  const opacity = appearance === "dark" ? 0.8 : 0.48;
  const composite = {
    red: background.red * opacity + base.red * (1 - opacity),
    green: background.green * opacity + base.green * (1 - opacity),
    blue: background.blue * opacity + base.blue * (1 - opacity),
  };
  const luminance = (color: ArtworkThemeColor) => {
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return channel(color.red) * 0.2126 + channel(color.green) * 0.7152 + channel(color.blue) * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(composite);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

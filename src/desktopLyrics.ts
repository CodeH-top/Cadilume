import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { isDesktopRuntime } from "./api";

export const DESKTOP_LYRICS_EVENT = "player://desktop-lyrics";
export const DESKTOP_LYRICS_VISIBILITY_EVENT = "desktop-lyrics://visibility";

export interface DesktopLyricsPayload {
  trackId?: string;
  title: string;
  artist: string;
  /** Optional album label used by the floating karaoke window. */
  album?: string;
  /** A Rust-served/data URL. Never put a PMS token in this field. */
  artworkUrl?: string;
  currentText: string;
  nextText: string;
  timed: boolean;
  playing: boolean;
  positionMs: number;
  /** Timing for the active line, when the source is timed. */
  currentStartMs?: number | null;
  currentEndMs?: number | null;
  /** Optional precomputed 0..1 active-line progress. */
  lineProgress?: number | null;
}

/** Keep animation values inside the CSS-friendly 0..1 range. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Resolve active-line progress from a payload. A producer may send the
 * already-computed value, otherwise start/end/position are used.
 */
export function desktopLyricProgress(payload: Pick<DesktopLyricsPayload, "lineProgress" | "currentStartMs" | "currentEndMs" | "positionMs">): number {
  if (typeof payload.lineProgress === "number" && Number.isFinite(payload.lineProgress)) {
    return clamp01(payload.lineProgress);
  }
  const start = payload.currentStartMs;
  const end = payload.currentEndMs;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return 0;
  return clamp01((payload.positionMs - start) / (end - start));
}

export async function publishDesktopLyrics(payload: DesktopLyricsPayload): Promise<void> {
  if (isDesktopRuntime()) await emitTo("desktop-lyrics", DESKTOP_LYRICS_EVENT, payload);
}

export async function showDesktopLyrics(): Promise<boolean> {
  return isDesktopRuntime() ? invoke("show_desktop_lyrics") : false;
}

export async function hideDesktopLyrics(): Promise<boolean> {
  return isDesktopRuntime() ? invoke("hide_desktop_lyrics") : false;
}

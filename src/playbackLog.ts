import { emit } from "@tauri-apps/api/event";
import { isDesktopRuntime } from "./api";

/**
 * Development/diagnostic channel for the playback state machine. The message
 * is echoed into the Tauri dev terminal through `playback://log`; it must never
 * contain PMS URIs, media paths, tokens, loopback tickets, or private track
 * identifiers.
 */
export function playbackLog(level: "info" | "warn" | "error", message: string): void {
  if (isDesktopRuntime()) {
    void emit("playback://log", JSON.stringify({ level, message })).catch(() => undefined);
  } else if (level === "error") {
    console.error(`[播放] ${message}`);
  } else if (level === "warn") {
    console.warn(`[播放] ${message}`);
  } else {
    console.info(`[播放] ${message}`);
  }
}

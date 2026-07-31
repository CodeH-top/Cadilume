import type { BrandPreset } from "./types";

export const BRAND_STORAGE_KEY = "cadilume-brand";

export const BRAND_PRESETS: readonly BrandPreset[] = ["plex", "emby", "jellyfin"];

export function isBrandPreset(value: unknown): value is BrandPreset {
  return typeof value === "string" && BRAND_PRESETS.includes(value as BrandPreset);
}

export function readInitialBrandPreset(): BrandPreset {
  let storedPreset: string | null = null;
  try {
    storedPreset = localStorage.getItem(BRAND_STORAGE_KEY);
  } catch {
    // Storage can be unavailable while the app still needs a deterministic palette.
  }

  const preset = isBrandPreset(storedPreset) ? storedPreset : "plex";
  if (storedPreset !== preset) {
    try {
      localStorage.setItem(BRAND_STORAGE_KEY, preset);
    } catch {
      // Keep the current launch usable when persistent storage is restricted.
    }
  }
  return preset;
}

export function persistBrandPreset(preset: BrandPreset) {
  try {
    localStorage.setItem(BRAND_STORAGE_KEY, preset);
  } catch {
    // The native configuration remains authoritative in Tauri.
  }
}

export function applyBrandPreset(preset: BrandPreset) {
  document.documentElement.dataset.brand = preset;
}

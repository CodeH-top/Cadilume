import type { ThemeMode } from "./types";

export const THEME_STORAGE_KEY = "cadilume-theme";

export function resolveInitialThemeMode(storedPreference: string | null | undefined, systemPrefersLight: boolean): ThemeMode {
  if (storedPreference === "light" || storedPreference === "dark") return storedPreference;
  return systemPrefersLight ? "light" : "dark";
}

export function readInitialThemeMode(): ThemeMode {
  const systemPrefersLight = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: light)").matches;
  let storedPreference: string | null = null;
  try {
    storedPreference = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage can be unavailable while the app still needs an initial appearance.
  }

  const theme = resolveInitialThemeMode(storedPreference, systemPrefersLight);
  if (storedPreference !== theme) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Keep the current launch usable when persistent storage is restricted.
    }
  }
  return theme;
}

export function applyThemeMode(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

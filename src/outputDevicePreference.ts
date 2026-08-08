export const OUTPUT_DEVICE_STORAGE_KEY = "cadilume-output-device";
export const LEGACY_OUTPUT_DEVICE_STORAGE_KEY = "cadilume-output-sink-id";

export function readOutputDevicePreference(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    const current = localStorage.getItem(OUTPUT_DEVICE_STORAGE_KEY);
    if (current !== null) return current;

    const legacy = localStorage.getItem(LEGACY_OUTPUT_DEVICE_STORAGE_KEY) || "";
    if (legacy) localStorage.setItem(OUTPUT_DEVICE_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_OUTPUT_DEVICE_STORAGE_KEY);
    return legacy;
  } catch {
    return "";
  }
}

export function writeOutputDevicePreference(deviceId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (deviceId) localStorage.setItem(OUTPUT_DEVICE_STORAGE_KEY, deviceId);
    else localStorage.removeItem(OUTPUT_DEVICE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_OUTPUT_DEVICE_STORAGE_KEY);
  } catch {
    // Restricted WebViews can reject storage access; routing remains usable.
  }
}

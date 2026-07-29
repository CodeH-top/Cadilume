import { useCallback, useEffect, useMemo, useState } from "react";

export type OutputPlatform = "macos" | "windows" | "other";
export type OutputControlResult = "airplay-opened" | "airplay-unavailable" | "missing-track" | "devices-panel";

export interface OutputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

interface NavigatorPlatformInfo {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

interface SelectAudioOutputOptions {
  deviceId?: string;
}

type ExtendedMediaDevices = MediaDevices & {
  selectAudioOutput?: (options?: SelectAudioOutputOptions) => Promise<MediaDeviceInfo>;
};

const OUTPUT_DEVICE_KEY = "cadilume-output-device";

function readOutputDevicePreference(): string {
  try {
    return typeof localStorage === "undefined" ? "" : localStorage.getItem(OUTPUT_DEVICE_KEY) || "";
  } catch {
    return "";
  }
}

function writeOutputDevicePreference(deviceId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (deviceId) localStorage.setItem(OUTPUT_DEVICE_KEY, deviceId);
    else localStorage.removeItem(OUTPUT_DEVICE_KEY);
  } catch {
    // Restricted WebViews can reject storage access; device selection should still work.
  }
}

export function detectOutputPlatform(info: NavigatorPlatformInfo): OutputPlatform {
  const identity = `${info.userAgentData?.platform || ""} ${info.platform || ""} ${info.userAgent || ""}`;
  if (/mac|darwin/i.test(identity)) return "macos";
  if (/win/i.test(identity)) return "windows";
  return "other";
}

export function activateOutputControl(
  platform: OutputPlatform,
  hasTrack: boolean,
  showAirPlayPicker: () => boolean,
  toggleDevicesPanel: () => void,
): OutputControlResult {
  if (platform !== "macos") {
    toggleDevicesPanel();
    return "devices-panel";
  }
  if (!hasTrack) return "missing-track";
  return showAirPlayPicker() ? "airplay-opened" : "airplay-unavailable";
}

export function normalizeOutputDevices(devices: readonly MediaDeviceInfo[]): OutputDevice[] {
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const unique = new Set<string>();
  const normalized: OutputDevice[] = [{ deviceId: "", label: "系统默认", isDefault: true }];

  for (const device of outputs) {
    if (!device.deviceId || device.deviceId === "default" || unique.has(device.deviceId)) continue;
    unique.add(device.deviceId);
    normalized.push({
      deviceId: device.deviceId,
      label: device.label.trim() || `音频输出 ${normalized.length}`,
      isDefault: false,
    });
  }

  return normalized;
}

function supportsSinkSelection(): boolean {
  if (typeof HTMLMediaElement === "undefined") return false;
  return typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function";
}

export function useOutputDevices(setOutputSinkId: (deviceId: string) => Promise<boolean>) {
  const platform = useMemo(() => detectOutputPlatform(navigator as Navigator & NavigatorPlatformInfo), []);
  const mediaDevices = navigator.mediaDevices as ExtendedMediaDevices | undefined;
  const canSelectSink = window.isSecureContext && supportsSinkSelection();
  const canUseSystemPicker = typeof mediaDevices?.selectAudioOutput === "function";
  const [devices, setDevices] = useState<OutputDevice[]>([
    { deviceId: "", label: "系统默认", isDefault: true },
  ]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(readOutputDevicePreference);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();

  const refresh = useCallback(async () => {
    if (!mediaDevices?.enumerateDevices) return;
    setLoading(true);
    try {
      const nextDevices = normalizeOutputDevices(await mediaDevices.enumerateDevices());
      setDevices(nextDevices);
      const persisted = readOutputDevicePreference();
      if (persisted && !nextDevices.some((device) => device.deviceId === persisted)) {
        try {
          await setOutputSinkId("");
        } catch {
          // Keep the UI on the safe default even if WebView2 rejects the routing request.
        }
        writeOutputDevicePreference("");
        setSelectedDeviceId("");
        setMessage("原输出设备已断开，已切回系统默认。");
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "无法读取系统音频输出设备。");
    } finally {
      setLoading(false);
    }
  }, [mediaDevices, setOutputSinkId]);

  const selectDevice = useCallback(async (deviceId: string) => {
    setMessage(undefined);
    let applied = false;
    try {
      applied = await setOutputSinkId(deviceId);
    } catch {
      // Fall through to the same explicit system-default recovery as a false result.
    }
    if (!applied && deviceId) {
      try {
        await setOutputSinkId("");
      } catch {
        // The system mixer remains the final fallback when WebView2 routing is unavailable.
      }
    }
    if (applied) {
      setSelectedDeviceId(deviceId);
      writeOutputDevicePreference(deviceId);
      return true;
    }

    setSelectedDeviceId("");
    writeOutputDevicePreference("");
    setMessage("所选设备当前不可用，已回退到系统默认输出。");
    return false;
  }, [setOutputSinkId]);

  const requestSystemDevice = useCallback(async () => {
    if (!mediaDevices?.selectAudioOutput) {
      setMessage("当前 WebView 不支持系统设备选择器，可直接从下方设备列表选择。");
      return;
    }
    setLoading(true);
    setMessage(undefined);
    try {
      const chosen = await mediaDevices.selectAudioOutput(
        selectedDeviceId ? { deviceId: selectedDeviceId } : undefined,
      );
      await selectDevice(chosen.deviceId);
      await refresh();
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotAllowedError") {
        setMessage("未更改输出设备。");
      } else {
        setMessage(reason instanceof Error ? reason.message : "无法打开系统设备选择器。");
      }
    } finally {
      setLoading(false);
    }
  }, [mediaDevices, refresh, selectDevice, selectedDeviceId]);

  useEffect(() => {
    if (platform !== "windows" || !canSelectSink) return;
    let cancelled = false;
    const restore = async () => {
      const stored = readOutputDevicePreference();
      let restored = true;
      if (stored) {
        try {
          restored = await setOutputSinkId(stored);
        } catch {
          restored = false;
        }
        if (!restored) {
          try {
            await setOutputSinkId("");
          } catch {
            // The system mixer remains available when WebView2 cannot restore a sink.
          }
        }
      }
      if (stored && !restored) {
        if (!cancelled) {
          setSelectedDeviceId("");
          writeOutputDevicePreference("");
          setMessage("上次使用的输出设备不可用，已恢复系统默认。");
        }
      }
      if (!cancelled) await refresh();
    };
    void restore();
    return () => { cancelled = true; };
  }, [canSelectSink, platform, refresh, setOutputSinkId]);

  useEffect(() => {
    if (platform !== "windows" || !mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refresh();
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [mediaDevices, platform, refresh]);

  return {
    platform,
    devices,
    selectedDeviceId,
    loading,
    message,
    canSelectSink,
    canUseSystemPicker,
    refresh,
    selectDevice,
    requestSystemDevice,
    setMessage,
  };
}

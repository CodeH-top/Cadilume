import { useCallback, useEffect, useMemo, useState } from "react";
import { isDesktopRuntime, nativeAudioOutputDevices } from "./api";
import { readOutputDevicePreference, writeOutputDevicePreference } from "./outputDevicePreference";

export type OutputPlatform = "macos" | "windows" | "other";

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

export function detectOutputPlatform(info: NavigatorPlatformInfo): OutputPlatform {
  const identity = `${info.userAgentData?.platform || ""} ${info.platform || ""} ${info.userAgent || ""}`;
  if (/mac|darwin/i.test(identity)) return "macos";
  if (/win/i.test(identity)) return "windows";
  return "other";
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

export function canSelectApplicationOutput(
  desktopRuntime: boolean,
  secureContext: boolean,
  webSinkSelection: boolean,
): boolean {
  return desktopRuntime || (secureContext && webSinkSelection);
}

export function useOutputDevices(
  setOutputSinkId: (deviceId: string) => Promise<boolean>,
  activeOutputDeviceId?: string,
) {
  const platform = useMemo(() => detectOutputPlatform(navigator as Navigator & NavigatorPlatformInfo), []);
  const mediaDevices = navigator.mediaDevices as ExtendedMediaDevices | undefined;
  const desktopRuntime = isDesktopRuntime();
  const canSelectSink = canSelectApplicationOutput(
    desktopRuntime,
    window.isSecureContext,
    supportsSinkSelection(),
  ) && platform !== "macos";
  const canUseSystemPicker = !desktopRuntime && typeof mediaDevices?.selectAudioOutput === "function";
  const [devices, setDevices] = useState<OutputDevice[]>([
    { deviceId: "", label: "系统默认", isDefault: true },
  ]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(readOutputDevicePreference);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (activeOutputDeviceId === undefined) return;
    if (platform === "macos") {
      setSelectedDeviceId("");
      writeOutputDevicePreference("");
      return;
    }
    setSelectedDeviceId(activeOutputDeviceId);
    writeOutputDevicePreference(activeOutputDeviceId);
  }, [activeOutputDeviceId, platform]);

  const refresh = useCallback(async () => {
    if (platform === "macos") {
      setDevices([{ deviceId: "", label: "系统默认", isDefault: true }]);
      setSelectedDeviceId("");
      writeOutputDevicePreference("");
      return;
    }
    if (!desktopRuntime && !mediaDevices?.enumerateDevices) return;
    setLoading(true);
    try {
      const nextDevices = desktopRuntime
        ? (await nativeAudioOutputDevices()).map((device) => ({
            deviceId: device.device_id,
            label: device.label,
            isDefault: device.is_default,
          }))
        : normalizeOutputDevices(await mediaDevices!.enumerateDevices());
      if (!nextDevices.some((device) => device.isDefault)) {
        nextDevices.unshift({ deviceId: "", label: "系统默认", isDefault: true });
      }
      setDevices(nextDevices);
      const persisted = readOutputDevicePreference();
      if (persisted && !nextDevices.some((device) => device.deviceId === persisted)) {
        try {
          await setOutputSinkId("");
        } catch {
          // Keep the UI on the safe default even if the native route rejects it.
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
  }, [desktopRuntime, mediaDevices, platform, setOutputSinkId]);

  const selectDevice = useCallback(async (deviceId: string) => {
    if (platform === "macos") {
      writeOutputDevicePreference("");
      setSelectedDeviceId("");
      return false;
    }
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
  }, [platform, setOutputSinkId]);

  const requestSystemDevice = useCallback(async () => {
    if (platform === "macos") return;
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
  }, [mediaDevices, platform, refresh, selectDevice, selectedDeviceId]);

  useEffect(() => {
    if (desktopRuntime && platform === "macos") {
      writeOutputDevicePreference("");
      setSelectedDeviceId("");
      setDevices([{ deviceId: "", label: "系统默认", isDefault: true }]);
      return;
    }
    if (desktopRuntime && platform === "windows") {
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
              // The system mixer remains the final fallback.
            }
          }
        }
        if (stored && !restored && !cancelled) {
          setSelectedDeviceId("");
          writeOutputDevicePreference("");
          setMessage("上次使用的输出设备不可用，已恢复系统默认。");
        }
        if (!cancelled) await refresh();
      };
      void restore();
      // Revalidate explicit Windows routes so unplugging a device returns to
      // the system default instead of leaving a silent output stream behind.
      const refreshTimer = window.setInterval(() => {
        if (!cancelled) void refresh();
      }, 5_000);
      return () => {
        cancelled = true;
        window.clearInterval(refreshTimer);
      };
    }
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
  }, [canSelectSink, desktopRuntime, platform, refresh, setOutputSinkId]);

  useEffect(() => {
    if (desktopRuntime || platform !== "windows" || !mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refresh();
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [desktopRuntime, mediaDevices, platform, refresh]);

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

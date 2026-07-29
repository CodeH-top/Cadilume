import { describe, expect, it, vi } from "vitest";
import { activateOutputControl, detectOutputPlatform, normalizeOutputDevices } from "./useOutputDevices";

describe("output device helpers", () => {
  it("detects desktop platforms from modern and legacy navigator fields", () => {
    expect(detectOutputPlatform({ userAgentData: { platform: "macOS" } })).toBe("macos");
    expect(detectOutputPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectOutputPlatform({ userAgent: "X11; Linux x86_64" })).toBe("other");
  });

  it("keeps one system default and labels anonymous Windows outputs", () => {
    const devices = [
      { kind: "audioinput", deviceId: "mic", label: "Microphone" },
      { kind: "audiooutput", deviceId: "default", label: "Default" },
      { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
      { kind: "audiooutput", deviceId: "headphones", label: "" },
      { kind: "audiooutput", deviceId: "speakers", label: "Duplicate" },
    ] as MediaDeviceInfo[];

    expect(normalizeOutputDevices(devices)).toEqual([
      { deviceId: "", label: "系统默认", isDefault: true },
      { deviceId: "speakers", label: "Speakers", isDefault: false },
      { deviceId: "headphones", label: "音频输出 2", isDefault: false },
    ]);
  });

  it("opens the current Audio AirPlay picker directly on macOS", () => {
    const showAirPlayPicker = vi.fn(() => true);
    const toggleDevicesPanel = vi.fn();

    expect(activateOutputControl("macos", true, showAirPlayPicker, toggleDevicesPanel)).toBe("airplay-opened");
    expect(showAirPlayPicker).toHaveBeenCalledOnce();
    expect(toggleDevicesPanel).not.toHaveBeenCalled();
  });

  it("does not open the macOS device panel when AirPlay cannot be requested", () => {
    const showAirPlayPicker = vi.fn(() => false);
    const toggleDevicesPanel = vi.fn();

    expect(activateOutputControl("macos", false, showAirPlayPicker, toggleDevicesPanel)).toBe("missing-track");
    expect(showAirPlayPicker).not.toHaveBeenCalled();
    expect(activateOutputControl("macos", true, showAirPlayPicker, toggleDevicesPanel)).toBe("airplay-unavailable");
    expect(showAirPlayPicker).toHaveBeenCalledOnce();
    expect(toggleDevicesPanel).not.toHaveBeenCalled();
  });

  it.each(["windows", "other"] as const)("keeps the %s output button routed to the device panel", (platform) => {
    const showAirPlayPicker = vi.fn(() => true);
    const toggleDevicesPanel = vi.fn();

    expect(activateOutputControl(platform, false, showAirPlayPicker, toggleDevicesPanel)).toBe("devices-panel");
    expect(showAirPlayPicker).not.toHaveBeenCalled();
    expect(toggleDevicesPanel).toHaveBeenCalledOnce();
  });
});

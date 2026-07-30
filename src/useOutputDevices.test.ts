import { describe, expect, it } from "vitest";
import { detectOutputPlatform, normalizeOutputDevices } from "./useOutputDevices";

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
});

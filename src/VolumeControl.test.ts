import { describe, expect, it } from "vitest";
import { effectiveVolume, normalizeVolume, volumePercent } from "./VolumeControl";

describe("shared volume control state", () => {
  it("uses one bounded effective volume for display and range fill", () => {
    expect(normalizeVolume(-0.4)).toBe(0);
    expect(normalizeVolume(0.5)).toBe(0.5);
    expect(normalizeVolume(4)).toBe(1);
    expect(normalizeVolume(Number.NaN)).toBe(1);
    expect(effectiveVolume(0.72, false)).toBe(0.72);
    expect(effectiveVolume(0.72, true)).toBe(0);
  });

  it("reports the exact value exposed to assistive technology", () => {
    expect(volumePercent(0, false)).toBe(0);
    expect(volumePercent(0.01, false)).toBe(1);
    expect(volumePercent(0.5, false)).toBe(50);
    expect(volumePercent(1, false)).toBe(100);
    expect(volumePercent(0.9, true)).toBe(0);
  });
});

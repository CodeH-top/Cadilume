import { describe, expect, it } from "vitest";
import { BRAND_PRESETS, isBrandPreset } from "./brand";

describe("Cadilume visual presets", () => {
  it("only exposes the three fixed visual presets", () => {
    expect(BRAND_PRESETS).toEqual(["plex", "emby", "jellyfin"]);
  });

  it("rejects arbitrary colors and service-shaped values", () => {
    for (const value of ["#38bdf8", "custom", "Plex", "", null, undefined]) {
      expect(isBrandPreset(value)).toBe(false);
    }
  });
});

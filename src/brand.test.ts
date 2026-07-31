import { describe, expect, it } from "vitest";
import { BRAND_PRESETS, isBrandPreset, normalizeBrandPreset } from "./brand";

describe("Cadilume visual presets", () => {
  it("only exposes the three fixed visual presets", () => {
    expect(BRAND_PRESETS).toEqual(["amber", "verdant", "azure"]);
  });

  it("rejects arbitrary colors and service-shaped values", () => {
    for (const value of ["#38bdf8", "custom", "Plex", "", null, undefined]) {
      expect(isBrandPreset(value)).toBe(false);
    }
  });

  it("migrates old local visual-preference values without exposing provider names", () => {
    expect(normalizeBrandPreset("plex")).toBe("amber");
    expect(normalizeBrandPreset("emby")).toBe("verdant");
    expect(normalizeBrandPreset("jellyfin")).toBe("azure");
  });
});

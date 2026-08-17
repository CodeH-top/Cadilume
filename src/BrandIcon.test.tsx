import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandIcon, brandIconUrl } from "./BrandIcon";
import type { BrandPreset } from "./types";

describe("Cadilume brand image", () => {
  it.each([
    ["amber", "/app-icon.svg"],
    ["verdant", "/app-icon-verdant.svg"],
    ["azure", "/app-icon-azure.svg"],
  ] satisfies Array<[BrandPreset, string]>)('uses the %s image resource', (preset, expectedUrl) => {
    expect(brandIconUrl(preset)).toBe(expectedUrl);
    const markup = renderToStaticMarkup(<BrandIcon preset={preset} size={48} className="brand-mark" />);
    expect(markup).toContain("<img");
    expect(markup).toContain(`src="${expectedUrl}"`);
    expect(markup).not.toContain("<svg");
  });
});

import { describe, expect, it } from "vitest";
import { resolveInitialThemeMode } from "./theme";

describe("initial theme mode", () => {
  it("keeps a persisted manual choice", () => {
    expect(resolveInitialThemeMode("light", false)).toBe("light");
    expect(resolveInitialThemeMode("dark", true)).toBe("dark");
  });

  it("uses the current system appearance only when no manual choice exists", () => {
    expect(resolveInitialThemeMode(null, true)).toBe("light");
    expect(resolveInitialThemeMode(undefined, false)).toBe("dark");
    expect(resolveInitialThemeMode("system", true)).toBe("light");
    expect(resolveInitialThemeMode("system", false)).toBe("dark");
  });
});

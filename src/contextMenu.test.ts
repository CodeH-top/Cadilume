import { describe, expect, it, vi } from "vitest";
import { suppressContextMenu } from "./contextMenu";

describe("suppressContextMenu", () => {
  it("prevents the WebView context menu", () => {
    const preventDefault = vi.fn();

    suppressContextMenu({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

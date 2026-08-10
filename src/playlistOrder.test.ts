import { describe, expect, it } from "vitest";
import { playlistDropIndex, playlistMoveAfterId, playlistPointerTarget, reorderPlaylistItems } from "./playlistOrder";
import type { PlexItem } from "./types";

const item = (id: string): PlexItem => ({
  ratingKey: "duplicate-track",
  playlistItemID: id,
  key: `/library/metadata/${id}`,
  type: "track",
  title: id,
});

describe("playlist order", () => {
  it("maps a captured pointer to the visible row half used as the drop edge", () => {
    const rows = [
      { top: 100, bottom: 140 },
      { top: 140, bottom: 180 },
      { top: 180, bottom: 220 },
    ];

    expect(playlistPointerTarget(80, rows)).toEqual({ targetIndex: 0, afterTarget: false });
    expect(playlistPointerTarget(119, rows)).toEqual({ targetIndex: 0, afterTarget: false });
    expect(playlistPointerTarget(120, rows)).toEqual({ targetIndex: 0, afterTarget: true });
    expect(playlistPointerTarget(141, rows)).toEqual({ targetIndex: 1, afterTarget: false });
    expect(playlistPointerTarget(240, rows)).toEqual({ targetIndex: 2, afterTarget: true });
    expect(playlistPointerTarget(Number.NaN, rows)).toBeUndefined();
    expect(playlistPointerTarget(120, [])).toBeUndefined();
  });

  it("resolves before and after drops after removing the dragged row", () => {
    expect(playlistDropIndex(0, 2, false, 4)).toBe(1);
    expect(playlistDropIndex(0, 2, true, 4)).toBe(2);
    expect(playlistDropIndex(3, 0, false, 4)).toBe(0);
    expect(playlistDropIndex(3, 0, true, 4)).toBe(1);
    expect(playlistDropIndex(1, 3, true, 4)).toBe(3);
    expect(playlistDropIndex(2, 2, false, 4)).toBe(2);
    expect(playlistDropIndex(2, 2, true, 4)).toBe(2);
  });

  it("moves the exact playlist occurrence and derives the PMS after identity", () => {
    const reordered = reorderPlaylistItems([item("a"), item("b"), item("c")], 2, 1);
    expect(reordered.map((track) => track.playlistItemID)).toEqual(["a", "c", "b"]);
    expect(playlistMoveAfterId(reordered, 1)).toBe("a");
    expect(playlistMoveAfterId(reordered, 0)).toBeUndefined();
  });

  it("leaves the source unchanged for invalid and no-op moves", () => {
    const source = [item("a"), item("b"), item("c")];
    expect(reorderPlaylistItems(source, 1, 1)).toEqual(source);
    expect(reorderPlaylistItems(source, -1, 1)).toEqual(source);
    expect(reorderPlaylistItems(source, 1, 3)).toEqual(source);
    expect(source.map((track) => track.playlistItemID)).toEqual(["a", "b", "c"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  PLAYBACK_SESSION_MAX_AGE_MS,
  PLAYBACK_SESSION_MAX_QUEUE,
  PLAYBACK_SESSION_STORAGE_KEY,
  NativeQueueCommandBarrier,
  clearPersistedPlaybackSession,
  commitShuffleNext,
  createPersistedPlaybackSession,
  createShuffleBag,
  createShuffleNavigationState,
  effectivePlaybackVolume,
  appendQueueBatch,
  getManualNextIndex,
  getManualPreviousIndex,
  getSequentialNextIndex,
  insertQueueBatchNext,
  mergeFreshTrackMetadata,
  moveShufflePrevious,
  nativeAudioCacheQuality,
  nativeAudioCacheIdentity,
  normalizeRestoredProgress,
  normalizeQueueBatch,
  parsePersistedPlaybackSession,
  playbackFallbackQualities,
  previewShuffleNext,
  readPersistedPlaybackSession,
  sourceStreamQuality,
  shouldScrobblePlayback,
  takeShuffleIndex,
} from "./usePlayer";
import type { PlexItem } from "./types";

const track = (index: number): PlexItem => ({
  ratingKey: `track-${index}`,
  key: `/library/metadata/track-${index}`,
  type: "track",
  title: `Track ${index}`,
  parentTitle: "Album",
  grandparentTitle: "Artist",
  duration: 180_000,
  thumb: `/library/metadata/track-${index}/thumb`,
  Media: [{ Part: [{ key: `/library/parts/${index}.flac`, duration: 180_000, size: 1234 }] }],
});

describe("native audio cache identity", () => {
  it("separates servers, qualities and media revisions deterministically", () => {
    const source = track(1);
    const first = nativeAudioCacheIdentity("server-a", source, "original");
    expect(nativeAudioCacheIdentity("server-a", source, "original")).toBe(first);
    expect(nativeAudioCacheIdentity("server-b", source, "original")).not.toBe(first);
    expect(nativeAudioCacheIdentity("server-a", source, "192")).not.toBe(first);
    expect(nativeAudioCacheIdentity("server-a", {
      ...source,
      Media: [{ ...source.Media![0], Part: [{ ...source.Media![0].Part![0], size: 5678 }] }],
    }, "original")).not.toBe(first);
  });

  it("uses the concrete ticket representation for auto-quality cache entries", () => {
    const loopback = "http://127.0.0.1:49152/stream/ticket";
    expect(nativeAudioCacheQuality("auto", `${loopback}?maxAudioBitrate=320`)).toBe("320");
    expect(nativeAudioCacheQuality("auto", `${loopback}?maxAudioBitrate=192`)).toBe("192");
    expect(nativeAudioCacheQuality("auto", loopback)).toBe("original");
    expect(nativeAudioCacheQuality("original", loopback)).toBe("original");
  });
});

describe("native playback compatibility fallback", () => {
  it("reads only bounded public bitrate markers from loopback URLs", () => {
    expect(sourceStreamQuality("http://127.0.0.1:49152/stream/ticket?maxAudioBitrate=320")).toBe("320");
    expect(sourceStreamQuality("http://127.0.0.1:49152/stream/ticket?maxAudioBitrate=128")).toBeUndefined();
    expect(sourceStreamQuality("not a url")).toBeUndefined();
  });

  it("falls back through strictly lower PMS compatibility streams", () => {
    const autoSource = "http://127.0.0.1:49152/stream/ticket";
    const explicit320 = `${autoSource}?maxAudioBitrate=320`;

    expect(playbackFallbackQualities("auto", "auto", autoSource)).toEqual(["320", "256", "192"]);
    expect(playbackFallbackQualities("original", "original", autoSource)).toEqual(["320", "256", "192"]);
    expect(playbackFallbackQualities("320", "320", explicit320)).toEqual(["256", "192"]);
    expect(playbackFallbackQualities("256", "256", autoSource)).toEqual(["192"]);
    expect(playbackFallbackQualities("192", "192", autoSource)).toEqual([]);
  });

  it("never repeats an already attempted effective quality", () => {
    expect(playbackFallbackQualities(
      "auto",
      "auto",
      "http://127.0.0.1:49152/stream/ticket",
      ["auto", "320"],
    )).toEqual(["256", "192"]);
  });
});

describe("native queue command barrier", () => {
  it("keeps queue edits and navigation ordered under load", async () => {
    const barrier = new NativeQueueCommandBarrier();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = barrier.enqueue(async () => {
      order.push("edit:start");
      await firstGate;
      order.push("edit:end");
    });
    const second = barrier.enqueue(async () => {
      order.push("next");
      return 7;
    });

    await Promise.resolve();
    expect(order).toEqual(["edit:start"]);
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe(7);
    expect(order).toEqual(["edit:start", "edit:end", "next"]);
  });

  it("continues after one rejected native command", async () => {
    const barrier = new NativeQueueCommandBarrier();
    await expect(barrier.enqueue(async () => {
      throw new Error("stale queue");
    })).rejects.toThrow("stale queue");
    await expect(barrier.enqueue(async () => 3)).resolves.toBe(3);
  });
});

describe("persisted playback session", () => {
  it("lets fresh track metadata replace a stale album-artist-only snapshot", () => {
    const restored = track(1);
    const fresh: PlexItem = {
      ...restored,
      originalTitle: "Track Artist",
      trackArtists: [{ name: "Track Artist" }],
      grandparentTitle: "Album Artist",
    };

    expect(mergeFreshTrackMetadata(restored, fresh)).toMatchObject({
      grandparentTitle: "Album Artist",
      originalTitle: "Track Artist",
      trackArtists: [{ name: "Track Artist" }],
    });
  });

  it("stores only a compact queue and keeps the current item when trimming to 500", () => {
    const queue = Array.from({ length: PLAYBACK_SESSION_MAX_QUEUE + 8 }, (_, index) => ({
      ...track(index),
      imageUrl: `https://music.test/cover/${index}?X-Plex-Token=secret-token`,
      thumbBlurHash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      summary: "not persisted",
    }));
    const session = createPersistedPlaybackSession({
      serverId: "server-a",
      quality: "auto",
      queue,
      currentIndex: 507,
      progress: 42.5,
      shuffle: true,
      repeat: "all",
      updatedAt: 1_000,
    });

    expect(session).not.toBeNull();
    expect(session?.queue).toHaveLength(PLAYBACK_SESSION_MAX_QUEUE);
    expect(session?.currentIndex).toBe(PLAYBACK_SESSION_MAX_QUEUE - 1);
    expect(session?.ratingKey).toBe("track-507");
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("imageUrl");
    expect(serialized).not.toContain("stream");
    expect(session?.queue[0]).toMatchObject({ ratingKey: "track-0", title: "Track 0" });
    expect(session?.queue[0].thumbBlurHash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    expect(session?.queue[0]).not.toHaveProperty("summary");
  });

  it("drops malformed or oversized artwork hashes from persisted playback", () => {
    const createWithHash = (thumbBlurHash: string) => createPersistedPlaybackSession({
      serverId: "server-a",
      quality: "auto",
      queue: [{ ...track(1), thumbBlurHash }],
      currentIndex: 0,
      progress: 0,
      shuffle: false,
      repeat: "off",
      updatedAt: 1_000,
    });

    expect(createWithHash("short")?.queue[0]).not.toHaveProperty("thumbBlurHash");
    expect(createWithHash(`valid-prefix-${"x".repeat(260)}`)?.queue[0]).not.toHaveProperty("thumbBlurHash");
    expect(createWithHash("valid\nvalue")?.queue[0]).not.toHaveProperty("thumbBlurHash");
  });

  it("preserves the exact current occurrence when duplicate rating keys exist", () => {
    const duplicate = { ...track(1), title: "Track 1 (second occurrence)" };
    const session = createPersistedPlaybackSession({
      serverId: "server-a",
      quality: "auto",
      queue: [track(1), duplicate, track(2)],
      currentIndex: 1,
      progress: 9,
      shuffle: false,
      repeat: "off",
      updatedAt: 1_000,
    });

    expect(session?.currentIndex).toBe(1);
    expect(session?.ratingKey).toBe("track-1");
    expect(session?.queue[1].title).toBe("Track 1 (second occurrence)");
  });

  it("preserves track-level artist order while restoring a compact queue", () => {
    const collaborativeTrack: PlexItem = {
      ...track(1),
      originalTitle: "Mira Lin / Kobe Bryant / AC/DC",
      trackArtists: [
        { name: "Mira Lin", ratingKey: "artist-2" },
        { name: "Kobe Bryant" },
        { name: "AC/DC" },
      ],
    };
    const session = createPersistedPlaybackSession({
      serverId: "server-a",
      quality: "auto",
      queue: [collaborativeTrack],
      currentIndex: 0,
      progress: 0,
      shuffle: false,
      repeat: "off",
      updatedAt: 1_000,
    });

    expect(session?.queue[0].trackArtists).toEqual(collaborativeTrack.trackArtists);
    expect(parsePersistedPlaybackSession(JSON.stringify(session), 1_000)?.queue[0].trackArtists).toEqual(collaborativeTrack.trackArtists);
    expect(JSON.stringify(session)).toContain("Mira Lin / Kobe Bryant / AC/DC");
  });

  it("migrates legacy contributor snapshots into trackArtists without losing order", () => {
    const legacy = {
      version: 1,
      serverId: "server-a",
      quality: "auto",
      queue: [{
        ...track(1),
        contributors: [{ name: "Mira Lin", ratingKey: "artist-2" }, { name: "Guest Artist" }],
      }],
      currentIndex: 0,
      ratingKey: "track-1",
      progress: 0,
      shuffle: false,
      repeat: "off",
      updatedAt: 1_000,
    };

    expect(parsePersistedPlaybackSession(JSON.stringify(legacy), 1_000)?.queue[0].trackArtists).toEqual([
      { name: "Mira Lin", ratingKey: "artist-2" },
      { name: "Guest Artist" },
    ]);
  });

  it("rejects tampered, stale, mismatched, and invalid-index records", () => {
    const now = 10_000_000;
    const valid = createPersistedPlaybackSession({
      serverId: "server-a",
      quality: "320",
      queue: [track(1), track(2)],
      currentIndex: 1,
      progress: 12,
      shuffle: false,
      repeat: "off",
      updatedAt: now,
    });
    expect(parsePersistedPlaybackSession(JSON.stringify(valid), now)).toMatchObject({
      serverId: "server-a",
      currentIndex: 1,
      ratingKey: "track-2",
    });
    expect(parsePersistedPlaybackSession(JSON.stringify({ ...valid, version: 99 }), now)).toBeNull();
    expect(parsePersistedPlaybackSession(JSON.stringify({ ...valid, updatedAt: now - PLAYBACK_SESSION_MAX_AGE_MS - 1 }), now)).toBeNull();
    expect(parsePersistedPlaybackSession(JSON.stringify({ ...valid, currentIndex: 8 }), now)).toBeNull();
    expect(parsePersistedPlaybackSession(JSON.stringify({ ...valid, ratingKey: "track-1" }), now)).toBeNull();
    expect(parsePersistedPlaybackSession("{not-json", now)).toBeNull();
  });

  it("degrades safely when localStorage is unavailable or throws", () => {
    const originalStorage = globalThis.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(readPersistedPlaybackSession()).toBeNull();
    vi.stubGlobal("localStorage", originalStorage);
  });

  it("clears the persisted queue on logout and tolerates blocked storage", () => {
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { removeItem });
    clearPersistedPlaybackSession();
    expect(removeItem).toHaveBeenCalledWith(PLAYBACK_SESSION_STORAGE_KEY);

    vi.stubGlobal("localStorage", {
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => clearPersistedPlaybackSession()).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("queue transition rules", () => {
  it("keeps a full artist batch ordered, unique, and separate from existing queue entries", () => {
    const incoming = [track(2), track(3), track(2), { ...track(4), type: "album" }];
    expect(normalizeQueueBatch(incoming).map((item) => item.ratingKey)).toEqual(["track-2", "track-3"]);

    const appended = appendQueueBatch([track(1), track(2)], 0, incoming);
    expect(appended).toMatchObject({ currentIndex: 0, addedCount: 2, shouldStart: false });
    expect(appended.queue.map((item) => item.ratingKey)).toEqual(["track-1", "track-2", "track-2", "track-3"]);
  });

  it("inserts the whole batch after the current item without reversing it", () => {
    const inserted = insertQueueBatchNext([track(1), track(4)], 0, [track(2), track(3)]);
    expect(inserted).toMatchObject({ currentIndex: 0, addedCount: 2, shouldStart: false });
    expect(inserted.queue.map((item) => item.ratingKey)).toEqual(["track-1", "track-2", "track-3", "track-4"]);
  });

  it("starts a queued batch only when there is no current track", () => {
    const empty = appendQueueBatch([], -1, [track(1), track(2)]);
    expect(empty).toMatchObject({ currentIndex: 0, addedCount: 2, shouldStart: true });

    const noCurrent = insertQueueBatchNext([track(1)], -1, [track(2)]);
    expect(noCurrent).toMatchObject({ currentIndex: 0, addedCount: 1, shouldStart: true });
    expect(noCurrent.queue.map((item) => item.ratingKey)).toEqual(["track-1", "track-2"]);
  });

  it("never leaves the current queue in sequential mode", () => {
    expect(getSequentialNextIndex(0, 3, "off")).toBe(1);
    expect(getSequentialNextIndex(2, 3, "off")).toBeNull();
    expect(getSequentialNextIndex(2, 3, "all")).toBe(0);
    expect(getSequentialNextIndex(2, 3, "one")).toBe(2);
    expect(getSequentialNextIndex(-1, 3, "off")).toBe(0);
  });

  it("lets manual Next skip a repeat-one track but keeps natural-ended repeat-one", () => {
    expect(getManualNextIndex(0, 3)).toBe(1);
    expect(getManualNextIndex(2, 3)).toBe(0);
    expect(getSequentialNextIndex(1, 3, "one")).toBe(1);
  });

  it("moves Previous backward and wraps only when repeat permits it", () => {
    expect(getManualPreviousIndex(2, 3, "off")).toBe(1);
    expect(getManualPreviousIndex(0, 3, "off")).toBeNull();
    expect(getManualPreviousIndex(0, 3, "all")).toBe(2);
    expect(getManualPreviousIndex(0, 3, "one")).toBe(2);
  });

  it("consumes a shuffle bag once per queue round", () => {
    let bag = createShuffleBag(4, 0);
    expect(bag).toEqual([1, 2, 3]);
    const seen = new Set<number>();
    for (let round = 0; round < 3; round += 1) {
      const selected = takeShuffleIndex(bag, 4, round === 0 ? 0 : round, "off", () => 0);
      expect(selected.index).not.toBeNull();
      if (selected.index != null) seen.add(selected.index);
      bag = selected.bag;
    }
    expect(seen).toEqual(new Set([1, 2, 3]));
    expect(takeShuffleIndex(bag, 4, 3, "off", () => 0).index).toBeNull();
  });

  it("rebuilds only the same queue for repeat-all and supports a one-track queue", () => {
    const afterRound = takeShuffleIndex([], 3, 2, "all", () => 0);
    expect(afterRound.index).toBe(0);
    expect(afterRound.index).toBeLessThan(3);
    expect(takeShuffleIndex([], 1, 0, "all", () => 0)).toEqual({ index: 0, bag: [] });
    expect(takeShuffleIndex([], 1, 0, "off", () => 0).index).toBeNull();
  });

  it("previews without consuming and commits exactly the previewed shuffle item", () => {
    const initial = createShuffleNavigationState(4, 0);
    const preview = previewShuffleNext(initial, 4, 0, "off", () => 0);

    expect(preview.index).toBe(1);
    expect(preview.state.bag).toEqual([1, 2, 3]);
    expect(preview.state.pending).toMatchObject({ index: 1, wrapped: false });

    const committed = commitShuffleNext(preview.state, 4, 0, "off", () => 0.99);
    expect(committed.index).toBe(1);
    expect(committed.state).toMatchObject({ bag: [2, 3], history: [0, 1], cursor: 1, pending: null });
  });

  it("keeps shuffle Previous and Next reversible through a history cursor", () => {
    let state = createShuffleNavigationState(4, 0);
    const first = commitShuffleNext(state, 4, 0, "off", () => 0);
    state = first.state;
    const second = commitShuffleNext(state, 4, first.index ?? -1, "off", () => 0);
    state = second.state;
    expect([first.index, second.index]).toEqual([1, 2]);

    const previous = moveShufflePrevious(state, 4, 2);
    expect(previous.index).toBe(1);
    expect(previous.state.cursor).toBe(1);
    expect(previous.state.bag).toEqual([3]);

    const previewForward = previewShuffleNext(previous.state, 4, 1, "off", () => 0.99);
    expect(previewForward.index).toBe(2);
    const forward = commitShuffleNext(previewForward.state, 4, 1, "off", () => 0.99);
    expect(forward.index).toBe(2);
    expect(forward.state.cursor).toBe(2);
    expect(forward.state.bag).toEqual([3]);
  });

  it("honors repeat boundaries without consuming a wrapped preview", () => {
    const exhausted = {
      bag: [],
      history: [0, 1, 2],
      cursor: 2,
      pending: null,
    };
    expect(previewShuffleNext(exhausted, 3, 2, "off", () => 0).index).toBeNull();
    expect(previewShuffleNext(exhausted, 3, 2, "one", () => 0).index).toBeNull();

    const wrappedPreview = previewShuffleNext(exhausted, 3, 2, "all", () => 0);
    expect(wrappedPreview.index).toBe(0);
    expect(wrappedPreview.state.bag).toEqual([]);
    expect(wrappedPreview.state.pending).toMatchObject({ index: 0, wrapped: true });
    expect(previewShuffleNext(wrappedPreview.state, 3, 2, "off", () => 0).index).toBeNull();

    const wrapped = commitShuffleNext(wrappedPreview.state, 3, 2, "all", () => 0.99);
    expect(wrapped.index).toBe(0);
    expect(wrapped.state.bag).toEqual([1]);
    expect(commitShuffleNext(createShuffleNavigationState(1, 0), 1, 0, "all", () => 0)).toMatchObject({ index: 0 });
  });
});

describe("resume safety", () => {
  it("resets an almost-completed restored track but keeps an earlier breakpoint", () => {
    expect(normalizeRestoredProgress(179, 180)).toBe(0);
    expect(normalizeRestoredProgress(180, 180)).toBe(0);
    expect(normalizeRestoredProgress(177, 180)).toBe(177);
  });
});

describe("native playback state projection", () => {
  it("sends zero gain while muted without losing the slider value", () => {
    expect(effectivePlaybackVolume(0.72, true)).toBe(0);
    expect(effectivePlaybackVolume(0.72, false)).toBe(0.72);
    expect(effectivePlaybackVolume(Number.NaN, false)).toBe(0.5);
  });

  it("scrobbles only after a finite playback position reaches 90 percent", () => {
    expect(shouldScrobblePlayback(89.9, 100)).toBe(false);
    expect(shouldScrobblePlayback(90, 100)).toBe(true);
    expect(shouldScrobblePlayback(Number.NaN, 100)).toBe(false);
    expect(shouldScrobblePlayback(90, 0)).toBe(false);
  });
});

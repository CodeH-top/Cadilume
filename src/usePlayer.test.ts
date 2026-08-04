import { describe, expect, it, vi } from "vitest";
import {
  PLAYBACK_SESSION_MAX_AGE_MS,
  PLAYBACK_SESSION_MAX_QUEUE,
  PLAYBACK_SESSION_STORAGE_KEY,
  DualAudioPool,
  activatePlaybackFallback,
  clearPersistedPlaybackSession,
  commitShuffleNext,
  createPlaybackFallbackState,
  createPlaybackRetryRequest,
  createPersistedPlaybackSession,
  createShuffleBag,
  createShuffleNavigationState,
  decidePlaybackFallback,
  formatMediaError,
  getManualNextIndex,
  getPrebufferTargetIndex,
  getSequentialNextIndex,
  mergeFreshTrackMetadata,
  moveShufflePrevious,
  normalizeRestoredProgress,
  parsePersistedPlaybackSession,
  previewShuffleNext,
  readPersistedPlaybackSession,
  rejectPendingPlaybackFallback,
  seekAfterMetadata,
  setAudioCurrentTimeSafely,
  sourceAlreadyUses320Kbps,
  takeShuffleIndex,
  type AudioPreparation,
} from "./usePlayer";
import type { PlexItem } from "./types";

class FakeAudio {
  preload = "";
  src = "";
  volume = 1;
  muted = false;
  paused = true;
  currentTime = 0;
  loadCount = 0;
  pauseCount = 0;
  sinkCalls: string[] = [];
  failSinkId?: string;

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  load(): void {
    this.loadCount += 1;
  }

  async play(): Promise<void> {
    this.paused = false;
  }

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkCalls.push(sinkId);
    if (sinkId && sinkId === this.failSinkId) throw new Error("device disappeared");
  }
}

class DeferredMetadataAudio extends FakeAudio {
  readyState = 0;
  duration = Number.NaN;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(name) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(name)?.delete(listener);
  }

  resolveMetadata(duration: number): void {
    this.readyState = 1;
    this.duration = duration;
    for (const listener of this.listeners.get("loadedmetadata") ?? []) {
      if (typeof listener === "function") listener(new Event("loadedmetadata"));
      else listener.handleEvent(new Event("loadedmetadata"));
    }
  }
}

const asAudio = (audio: FakeAudio): HTMLAudioElement => audio as unknown as HTMLAudioElement;

const preparation = (overrides: Partial<AudioPreparation> = {}): AudioPreparation => ({
  index: 1,
  ratingKey: "track-2",
  serverId: "server-a",
  quality: "auto",
  ...overrides,
});

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
    expect(session?.queue[0]).not.toHaveProperty("summary");
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

  it("does not seek an Audio element until it has a source", () => {
    const audio = new FakeAudio();
    expect(setAudioCurrentTimeSafely(asAudio(audio), 42)).toBe(false);
    expect(audio.currentTime).toBe(0);
    audio.src = "https://music.test/current";
    expect(setAudioCurrentTimeSafely(asAudio(audio), 42)).toBe(true);
    expect(audio.currentTime).toBe(42);
  });

  it("reads the latest seek target only after metadata becomes available", async () => {
    const audio = new DeferredMetadataAudio();
    audio.src = "https://music.test/current";
    let latestTarget = 0;

    const pendingSeek = seekAfterMetadata(asAudio(audio), () => latestTarget);
    latestTarget = 73;
    audio.resolveMetadata(180);
    await pendingSeek;

    expect(audio.currentTime).toBe(73);
  });
});

describe("playback retry", () => {
  it("retries the current queue item from its tracked progress", () => {
    expect(createPlaybackRetryRequest(1, 3, 42.75, null)).toEqual({
      index: 1,
      resumeProgress: 42.75,
    });
  });

  it("preserves a pending restored seek and rejects a stale queue index", () => {
    expect(createPlaybackRetryRequest(1, 3, 8, 57.5)).toEqual({
      index: 1,
      resumeProgress: 57.5,
    });
    expect(createPlaybackRetryRequest(3, 3, 8, null)).toBeNull();
    expect(createPlaybackRetryRequest(-1, 3, 8, null)).toBeNull();
  });

  it("normalizes an invalid stored progress before retrying", () => {
    expect(createPlaybackRetryRequest(0, 1, Number.NaN, null)).toEqual({
      index: 0,
      resumeProgress: 0,
    });
    expect(createPlaybackRetryRequest(0, 1, -3, null)).toEqual({
      index: 0,
      resumeProgress: 0,
    });
  });
});

describe("next-track prebuffer selection", () => {
  it("only predicts a deterministic next track", () => {
    expect(getPrebufferTargetIndex(0, 3, false, "off")).toBe(1);
    expect(getPrebufferTargetIndex(2, 3, false, "all")).toBe(0);
    expect(getPrebufferTargetIndex(2, 3, false, "off")).toBeNull();
    expect(getPrebufferTargetIndex(0, 3, true, "all")).toBeNull();
    expect(getPrebufferTargetIndex(0, 3, false, "one")).toBeNull();
    expect(getPrebufferTargetIndex(0, 1, false, "all")).toBeNull();
  });
});

describe("media playback diagnostics", () => {
  it("keeps MediaError code and safe message details without exposing a token URL", () => {
    const diagnostic = formatMediaError({
      code: 3,
      message: "Decoder failed for https://music.test/library/parts/1.flac?X-Plex-Token=secret-token&download=1; decoder unavailable",
    });

    expect(diagnostic).toContain("MediaError code 3");
    expect(diagnostic).toContain("音频解码失败");
    expect(diagnostic).toContain("decoder unavailable");
    expect(diagnostic).toContain("[媒体地址已隐藏]");
    expect(diagnostic).not.toContain("https://music.test");
    expect(diagnostic).not.toContain("secret-token");
  });

  it("reports when WebView provides no MediaError details", () => {
    expect(formatMediaError(null)).toBe("MediaError：浏览器未提供 code/message");
    expect(formatMediaError({ code: 2, message: "" })).toContain("浏览器未提供 message");
  });

  it("recognizes the public 320 kbps marker without exposing the ticket target", () => {
    const auto320 = "https://music.test/music/:/transcode/universal/start.mp3?maxAudioBitrate=320&X-Plex-Token=secret-token";

    expect(sourceAlreadyUses320Kbps(auto320)).toBe(true);
    expect(sourceAlreadyUses320Kbps("https://music.test/library/parts/1.flac?X-Plex-Token=secret-token")).toBe(false);
  });

  it("falls back from direct play through a finite descending compatibility chain", () => {
    const initial = createPlaybackFallbackState("original");
    const directFailure = decidePlaybackFallback(initial, "https://music.test/library/parts/1.flac");
    expect(directFailure).toMatchObject({
      action: "retry",
      quality: "320",
      state: { activeQuality: "original", attemptedQualities: ["original"], pendingQuality: "320" },
    });
    expect(initial).toEqual({ requestedQuality: "original", activeQuality: "original", attemptedQualities: [] });
    if (directFailure.action !== "retry") throw new Error("expected 320 retry");

    expect(decidePlaybackFallback(directFailure.state, "https://music.test/library/parts/1.flac")).toMatchObject({
      action: "wait",
    });

    const at320 = activatePlaybackFallback(directFailure.state, "320");
    const failure320 = decidePlaybackFallback(at320, "http://127.0.0.1/stream/ticket?maxAudioBitrate=320");
    expect(failure320).toMatchObject({
      action: "retry",
      quality: "256",
      state: { attemptedQualities: ["original", "320"], pendingQuality: "256" },
    });
    if (failure320.action !== "retry") throw new Error("expected 256 retry");

    const at256 = activatePlaybackFallback(failure320.state, "256");
    const failure256 = decidePlaybackFallback(at256, "http://127.0.0.1/stream/another-ticket");
    expect(failure256).toMatchObject({ action: "retry", quality: "192" });
    if (failure256.action !== "retry") throw new Error("expected 192 retry");

    const at192 = activatePlaybackFallback(failure256.state, "192");
    expect(decidePlaybackFallback(at192, "http://127.0.0.1/stream/final-ticket")).toMatchObject({
      action: "stop",
      state: { attemptedQualities: ["original", "320", "256", "192"] },
    });
  });

  it("skips the duplicate 320 retry when auto already resolved to 320", () => {
    const remoteAuto = decidePlaybackFallback(
      createPlaybackFallbackState("auto"),
      "http://127.0.0.1/stream/ticket?maxAudioBitrate=320",
    );
    expect(remoteAuto).toMatchObject({
      action: "retry",
      quality: "256",
      state: { attemptedQualities: ["auto", "320"], pendingQuality: "256" },
    });

    const localAuto = decidePlaybackFallback(
      createPlaybackFallbackState("auto"),
      "http://127.0.0.1/stream/direct-ticket",
    );
    expect(localAuto).toMatchObject({ action: "retry", quality: "320" });
    if (localAuto.action !== "retry") throw new Error("expected 320 retry");

    const rejected320 = rejectPendingPlaybackFallback(localAuto.state, "320");
    expect(decidePlaybackFallback(rejected320, "")).toMatchObject({
      action: "retry",
      quality: "256",
      state: { attemptedQualities: ["auto", "320"], pendingQuality: "256" },
    });
  });

  it("never upgrades an auto source whose effective transcode quality is known", () => {
    expect(decidePlaybackFallback(
      createPlaybackFallbackState("auto"),
      "http://127.0.0.1/stream/ticket?maxAudioBitrate=256",
    )).toMatchObject({
      action: "retry",
      quality: "192",
      state: { attemptedQualities: ["auto", "256"] },
    });
    expect(decidePlaybackFallback(
      createPlaybackFallbackState("auto"),
      "http://127.0.0.1/stream/ticket?maxAudioBitrate=192",
    )).toMatchObject({
      action: "stop",
      state: { attemptedQualities: ["auto", "192"] },
    });
  });

  it("only descends below an explicitly selected transcode quality", () => {
    expect(decidePlaybackFallback(createPlaybackFallbackState("320"), "")).toMatchObject({
      action: "retry",
      quality: "256",
    });
    expect(decidePlaybackFallback(createPlaybackFallbackState("256"), "")).toMatchObject({
      action: "retry",
      quality: "192",
    });
    expect(decidePlaybackFallback(createPlaybackFallbackState("192"), "")).toMatchObject({
      action: "stop",
      state: { attemptedQualities: ["192"] },
    });
  });

  it("always reaches stop without yielding a duplicate fallback quality", () => {
    for (const requestedQuality of ["auto", "original", "320", "256", "192"] as const) {
      let state = createPlaybackFallbackState(requestedQuality);
      const retries: string[] = [];
      for (let step = 0; step < 4; step += 1) {
        const decision = decidePlaybackFallback(state, "");
        state = decision.state;
        if (decision.action === "stop") break;
        expect(decision.action).toBe("retry");
        if (decision.action !== "retry") throw new Error("unexpected pending retry");
        retries.push(decision.quality);
        state = activatePlaybackFallback(decision.state, decision.quality);
      }
      expect(new Set(retries).size).toBe(retries.length);
      expect(retries.length).toBeLessThanOrEqual(3);
      expect(decidePlaybackFallback(state, "").action).toBe("stop");
    }
  });
});

describe("DualAudioPool", () => {
  it("configures both slots for eager buffering", () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    new DualAudioPool([asAudio(first), asAudio(second)]);

    for (const audio of [first, second]) {
      expect(audio.preload).toBe("auto");
    }
  });

  it("swaps to a matching prepared slot without reloading its buffered URL", () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    first.src = "https://music.test/current";
    const pool = new DualAudioPool([asAudio(first), asAudio(second)]);
    const key = preparation();

    const buffered = pool.prepare(key, "https://music.test/next");
    expect(buffered).toBe(asAudio(second));
    expect(second.loadCount).toBe(1);
    expect(pool.hasPrepared(key)).toBe(true);

    expect(pool.takePrepared(preparation({ ratingKey: "wrong" }))).toBeNull();
    const active = pool.takePrepared(key);

    expect(active).toBe(asAudio(second));
    expect(pool.active).toBe(asAudio(second));
    expect(pool.isActive(asAudio(first))).toBe(false);
    expect(second.src).toBe("https://music.test/next");
    expect(second.loadCount).toBe(1);
    expect(first.src).toBe("");
  });

  it("discards a failed standby slot so it cannot become active later", () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    const pool = new DualAudioPool([asAudio(first), asAudio(second)]);
    const key = preparation();

    pool.prepare(key, "https://music.test/unplayable");

    expect(pool.discardPreparedAudio(asAudio(second))).toBe(true);
    expect(pool.hasPrepared(key)).toBe(false);
    expect(pool.takePrepared(key)).toBeNull();
    expect(pool.active).toBe(asAudio(first));
  });

  it("keeps gain and mute synchronized across active and standby slots", () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    const pool = new DualAudioPool([asAudio(first), asAudio(second)]);

    pool.setGain(0.38, true);

    expect([first.volume, second.volume]).toEqual([0.38, 0.38]);
    expect([first.muted, second.muted]).toEqual([true, true]);
  });

  it("applies an output device to both slots and falls back to default on failure", async () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    first.src = "https://music.test/current";
    const pool = new DualAudioPool([asAudio(first), asAudio(second)]);

    await expect(pool.setOutputSinkId("speakers-a")).resolves.toBe(true);
    expect(first.sinkCalls).toEqual(["speakers-a"]);
    expect(second.sinkCalls).toEqual(["speakers-a"]);

    second.failSinkId = "speakers-b";
    await expect(pool.setOutputSinkId("speakers-b")).resolves.toBe(false);
    expect(first.sinkCalls[first.sinkCalls.length - 1]).toBe("");
    expect(second.sinkCalls[second.sinkCalls.length - 1]).toBe("");
    expect(first.src).toBe("https://music.test/current");
    expect(first.pauseCount).toBe(0);
    expect(first.loadCount).toBe(0);
  });

  it("stops and clears both slots when the queue changes servers", () => {
    const first = new FakeAudio();
    const second = new FakeAudio();
    first.src = "https://music.test/current";
    second.src = "https://music.test/next";
    const pool = new DualAudioPool([asAudio(first), asAudio(second)]);

    pool.clearSources();

    expect([first.src, second.src]).toEqual(["", ""]);
    expect(first.pauseCount).toBe(1);
    expect(second.pauseCount).toBe(1);
    expect(first.loadCount).toBe(1);
    expect(second.loadCount).toBe(1);
  });
});

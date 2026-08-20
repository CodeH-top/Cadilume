import { listen } from "@tauri-apps/api/event";
import { isBlurhashValid } from "blurhash";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acknowledgeQuit, isDesktopRuntime, nativeAudioClearCache, nativeAudioClearQueue, nativeAudioLoad, nativeAudioPause, nativeAudioPlay, nativeAudioQueueNextSource, nativeAudioSeek, nativeAudioSetArtwork, nativeAudioSetOutputDevice, nativeAudioSetVolume, nativeAudioStatus, nativeAudioStop, nativeQueueNext, nativeQueuePeekNext, nativeQueuePrevious, nativeQueueSet } from "./api";
import { plexMusicGateway } from "./musicGateway";
import { readOutputDevicePreference, writeOutputDevicePreference } from "./outputDevicePreference";
import { playbackLog } from "./playbackLog";
import { getResolvedArtwork, requestCachedArtwork } from "./artworkCache";
import { trackAlbum, trackArtist, type PlexContributor, type PlexItem, type StreamQuality } from "./types";

export type RepeatMode = "off" | "all" | "one";

/** Serializes every Rust queue decision while preserving each caller's result. */
export class NativeQueueCommandBarrier {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  wait(): Promise<void> {
    return this.tail;
  }
}

const VOLUME_STORAGE_KEY = "cadilume-volume";
const PREBUFFER_STORAGE_KEY = "cadilume-prebuffer-next";
export const PLAYBACK_SESSION_STORAGE_KEY = "cadilume-playback-session";
export const PLAYBACK_SESSION_VERSION = 1 as const;
export const PLAYBACK_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PLAYBACK_SESSION_MAX_QUEUE = 500;
const PLAYBACK_SESSION_WRITE_THROTTLE_MS = 5_000;
/** Keep the transport button visibly busy during quick prebuffered switches. */
const MIN_LOADING_VISIBLE_MS = 250;
/** Reuse an in-flight stream ticket briefly so bursty track switching does not
 *  issue a second PMS connection for the same track/quality. */
const STREAM_URL_INFLIGHT_CACHE_MS = 5_000;

const STREAM_QUALITY_VALUES: readonly StreamQuality[] = ["auto", "original", "320", "256", "192"];
const FALLBACK_QUALITY_ORDER: readonly FallbackStreamQuality[] = ["320", "256", "192"];

/**
 * Only this deliberately small shape is written to localStorage. In
 * particular, it never contains a PMS access token or a resolved stream URL.
 */
export interface PersistedPlaybackTrack {
  ratingKey: string;
  queueInstanceId?: string;
  key: string;
  type: "track";
  title: string;
  parentTitle?: string;
  parentRatingKey?: string;
  originalTitle?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  trackArtists?: PlexContributor[];
  /** Legacy snapshots used this name before R14 separated track credits. */
  contributors?: PlexContributor[];
  duration?: number;
  year?: number;
  index?: number;
  parentIndex?: number;
  thumb?: string;
  thumbBlurHash?: string;
  art?: string;
  Media?: Array<{ Part: Array<{ key: string; duration?: number; size?: number }> }>;
}

export interface PersistedPlaybackSession {
  version: typeof PLAYBACK_SESSION_VERSION;
  serverId: string;
  quality: StreamQuality;
  queue: PersistedPlaybackTrack[];
  currentIndex: number;
  ratingKey?: string;
  progress: number;
  shuffle: boolean;
  repeat: RepeatMode;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const finiteNumber = (value: unknown): value is number => (
  typeof value === "number" && Number.isFinite(value)
);

let queueInstanceSequence = 0;

function validQueueInstanceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 128 && /^[a-z\d._:-]+$/iu.test(normalized)
    ? normalized
    : undefined;
}

function createQueueInstanceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  queueInstanceSequence += 1;
  return `queue-${Date.now().toString(36)}-${queueInstanceSequence.toString(36)}`;
}

/** Preserve existing queue occurrences while repairing legacy or duplicate IDs. */
export function ensureQueueInstanceIds(items: readonly PlexItem[]): PlexItem[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let queueInstanceId = validQueueInstanceId(item.queueInstanceId);
    if (!queueInstanceId || seen.has(queueInstanceId)) queueInstanceId = createQueueInstanceId();
    seen.add(queueInstanceId);
    return item.queueInstanceId === queueInstanceId ? item : { ...item, queueInstanceId };
  });
}

/** A newly queued item is always a new occurrence, even when it is the same song. */
function createQueueInstances(items: readonly PlexItem[]): PlexItem[] {
  return items.map((item) => ({ ...item, queueInstanceId: createQueueInstanceId() }));
}

/**
 * Versioned identity for the native disk cache. Rust hashes this value before
 * using it as a filename, preventing identifier leakage and separating server,
 * quality and concrete media-part variants of the same rating key.
 */
export function nativeAudioCacheIdentity(
  serverId: string,
  track: PlexItem,
  quality: StreamQuality,
): string {
  const media = track.Media?.[0];
  const part = media?.Part?.[0];
  const boundedNumber = (value: number | undefined): number => (
    finiteNumber(value) && value >= 0 ? value : 0
  );
  return JSON.stringify([
    "cadilume-native-audio-v2",
    serverId,
    track.ratingKey,
    track.key,
    quality,
    media?.audioCodec || "",
    media?.container || "",
    boundedNumber(media?.bitrate),
    part?.key || "",
    boundedNumber(part?.size),
    boundedNumber(part?.duration ?? track.duration),
  ]);
}

/** Plex paths are relative and must never be turned into persisted URLs. */
function safePersistedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2_048) return undefined;
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(value)) return undefined;
  if (/(?:x-plex-token|access[_-]?token|auth_token|\btoken\b)\s*(?:=|%3d)/iu.test(value)) return undefined;
  return value;
}

function safePersistedBlurHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length < 6 || normalized.length > 256) return undefined;
  return isBlurhashValid(normalized).result ? normalized : undefined;
}

function compactPersistedContributors(value: readonly PlexContributor[] | undefined): PlexContributor[] | undefined {
  const contributors = value?.flatMap((contributor) => {
    const name = typeof contributor?.name === "string" ? contributor.name.trim() : "";
    if (!name || name.length > 2_048) return [];
    const ratingKey = safePersistedPath(contributor.ratingKey);
    return [{ name, ...(ratingKey ? { ratingKey } : {}) }];
  });
  return contributors?.length ? contributors : undefined;
}

function compactPersistedTrack(item: PlexItem): PersistedPlaybackTrack | null {
  if (!item || item.type !== "track") return null;
  const ratingKey = safePersistedPath(item.ratingKey);
  const key = safePersistedPath(item.key);
  if (!ratingKey || !key || typeof item.title !== "string" || !item.title || item.title.length > 2_048) return null;

  const compact: PersistedPlaybackTrack = {
    ratingKey,
    key,
    type: "track",
    title: item.title,
  };
  const queueInstanceId = validQueueInstanceId(item.queueInstanceId);
  if (queueInstanceId) compact.queueInstanceId = queueInstanceId;
  const copyString = (name: "parentTitle" | "parentRatingKey" | "originalTitle" | "grandparentTitle" | "grandparentRatingKey" | "thumb" | "art") => {
    const value = safePersistedPath(item[name]);
    if (value) compact[name] = value;
  };
  copyString("parentTitle");
  copyString("parentRatingKey");
  copyString("originalTitle");
  copyString("grandparentTitle");
  copyString("grandparentRatingKey");
  copyString("thumb");
  copyString("art");
  const thumbBlurHash = safePersistedBlurHash(item.thumbBlurHash);
  if (thumbBlurHash) compact.thumbBlurHash = thumbBlurHash;
  const trackArtists = compactPersistedContributors(
    item.trackArtists || item.contributors || (item.originalTitle ? [{ name: item.originalTitle }] : undefined),
  );
  if (trackArtists) compact.trackArtists = trackArtists;

  for (const name of ["duration", "year", "index", "parentIndex"] as const) {
    const value = item[name];
    if (finiteNumber(value) && value >= 0 && value <= 1e12) compact[name] = value;
  }

  const part = item.Media?.[0]?.Part?.[0];
  const partKey = safePersistedPath(part?.key);
  if (partKey) {
    compact.Media = [{
      Part: [{
        key: partKey,
        ...(finiteNumber(part?.duration) && part.duration >= 0 ? { duration: part.duration } : {}),
        ...(finiteNumber(part?.size) && part.size >= 0 ? { size: part.size } : {}),
      }],
    }];
  }
  return compact;
}

function restorePersistedTrack(value: unknown): PersistedPlaybackTrack | null {
  if (!isRecord(value) || value.type !== "track") return null;
  const item = {
    ratingKey: value.ratingKey,
    queueInstanceId: value.queueInstanceId,
    key: value.key,
    type: "track" as const,
    title: value.title,
    parentTitle: value.parentTitle,
    parentRatingKey: value.parentRatingKey,
    originalTitle: value.originalTitle,
    grandparentTitle: value.grandparentTitle,
    grandparentRatingKey: value.grandparentRatingKey,
    trackArtists: Array.isArray(value.trackArtists)
      ? value.trackArtists
      : Array.isArray(value.contributors) ? value.contributors : undefined,
    duration: value.duration,
    year: value.year,
    index: value.index,
    parentIndex: value.parentIndex,
    thumb: value.thumb,
    thumbBlurHash: value.thumbBlurHash,
    art: value.art,
    Media: value.Media,
  } as PlexItem;
  return compactPersistedTrack(item);
}

/** Fresh PMS metadata wins over a restored snapshot without losing safe queue fields. */
export function mergeFreshTrackMetadata(restored: PlexItem, fresh: PlexItem): PlexItem {
  if (restored.ratingKey !== fresh.ratingKey || fresh.type !== "track") return restored;
  return {
    ...restored,
    ...fresh,
    trackArtists: fresh.trackArtists?.length ? fresh.trackArtists : restored.trackArtists,
  };
}

/** Build a sanitized, versioned session object without touching browser storage. */
export function createPersistedPlaybackSession(input: {
  serverId: string;
  quality: StreamQuality;
  queue: PlexItem[];
  currentIndex: number;
  progress: number;
  shuffle: boolean;
  repeat: RepeatMode;
  updatedAt?: number;
}): PersistedPlaybackSession | null {
  if (!safePersistedPath(input.serverId) || !STREAM_QUALITY_VALUES.includes(input.quality)) return null;
  const requestedIndex = Number.isInteger(input.currentIndex) ? input.currentIndex : -1;
  const compactEntries = ensureQueueInstanceIds(input.queue)
    .map((item, originalIndex) => ({ originalIndex, track: compactPersistedTrack(item) }))
    .filter((entry): entry is { originalIndex: number; track: PersistedPlaybackTrack } => Boolean(entry.track));
  const requestedEntry = compactEntries.find((entry) => entry.originalIndex === requestedIndex);
  let retainedEntries = compactEntries.slice(0, PLAYBACK_SESSION_MAX_QUEUE);
  if (
    requestedEntry
    && retainedEntries.length === PLAYBACK_SESSION_MAX_QUEUE
    && !retainedEntries.some((entry) => entry.originalIndex === requestedIndex)
  ) {
    retainedEntries[PLAYBACK_SESSION_MAX_QUEUE - 1] = requestedEntry;
  }
  const compactQueue = retainedEntries.map((entry) => entry.track);
  const currentIndex = retainedEntries.findIndex((entry) => entry.originalIndex === requestedIndex);
  const progress = finiteNumber(input.progress) ? Math.max(0, Math.min(input.progress, 24 * 60 * 60)) : 0;
  const updatedAt = finiteNumber(input.updatedAt) && input.updatedAt > 0 ? input.updatedAt : Date.now();
  const current = currentIndex >= 0 ? compactQueue[currentIndex] : undefined;
  return {
    version: PLAYBACK_SESSION_VERSION,
    serverId: input.serverId,
    quality: input.quality,
    queue: compactQueue,
    currentIndex,
    ...(current ? { ratingKey: current.ratingKey } : {}),
    progress,
    shuffle: Boolean(input.shuffle),
    repeat: input.repeat === "one" || input.repeat === "all" ? input.repeat : "off",
    updatedAt,
  };
}

/** Parse and strictly validate a raw persisted session; invalid/stale data is ignored. */
export function parsePersistedPlaybackSession(raw: string | null | undefined, now = Date.now()): PersistedPlaybackSession | null {
  if (!raw || raw.length > 2_000_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== PLAYBACK_SESSION_VERSION) return null;
    if (!safePersistedPath(value.serverId) || !STREAM_QUALITY_VALUES.includes(value.quality as StreamQuality)) return null;
    if (!finiteNumber(value.updatedAt) || value.updatedAt <= 0 || value.updatedAt > now + 5 * 60 * 1000 || now - value.updatedAt > PLAYBACK_SESSION_MAX_AGE_MS) return null;
    if (!Array.isArray(value.queue) || value.queue.length > PLAYBACK_SESSION_MAX_QUEUE) return null;
    const queue = value.queue.map(restorePersistedTrack);
    if (queue.some((item): item is null => item === null)) return null;
    const restoredQueue = ensureQueueInstanceIds(queue as PersistedPlaybackTrack[]) as PersistedPlaybackTrack[];
    if (!Number.isInteger(value.currentIndex) || (value.currentIndex as number) < -1 || (value.currentIndex as number) >= restoredQueue.length) return null;
    if (!finiteNumber(value.progress) || value.progress < 0 || value.progress > 24 * 60 * 60) return null;
    if (typeof value.shuffle !== "boolean" || !["off", "all", "one"].includes(String(value.repeat))) return null;
    const currentIndex = value.currentIndex as number;
    const ratingKey = typeof value.ratingKey === "string" ? value.ratingKey : undefined;
    if (currentIndex >= 0 && ratingKey !== restoredQueue[currentIndex].ratingKey) return null;
    if (currentIndex < 0 && ratingKey !== undefined) return null;
    return {
      version: PLAYBACK_SESSION_VERSION,
      serverId: value.serverId as string,
      quality: value.quality as StreamQuality,
      queue: restoredQueue,
      currentIndex,
      ...(ratingKey ? { ratingKey } : {}),
      progress: value.progress as number,
      shuffle: value.shuffle,
      repeat: value.repeat as RepeatMode,
      updatedAt: value.updatedAt as number,
    };
  } catch {
    return null;
  }
}

export function readPersistedPlaybackSession(now = Date.now()): PersistedPlaybackSession | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return parsePersistedPlaybackSession(localStorage.getItem(PLAYBACK_SESSION_STORAGE_KEY), now);
  } catch {
    return null;
  }
}

/** Remove account-scoped playback metadata before another account signs in. */
export function clearPersistedPlaybackSession(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(PLAYBACK_SESSION_STORAGE_KEY);
  } catch {
    // Restricted WebViews may reject storage access; logout must still proceed.
  }
}

function writePersistedPlaybackSession(session: PersistedPlaybackSession): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PLAYBACK_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private/restricted WebViews may reject localStorage; playback remains usable.
  }
}

/** Return a fresh queue of valid indexes, excluding the currently playing item. */
export function createShuffleBag(queueLength: number, currentIndex = -1): number[] {
  if (!Number.isInteger(queueLength) || queueLength <= 0) return [];
  return Array.from({ length: queueLength }, (_, index) => index).filter((index) => index !== currentIndex);
}

/**
 * Consume one index from a shuffle bag. A repeat-all cycle rebuilds the bag
 * inside the same queue; repeat-off stops after every item has been consumed.
 */
export function takeShuffleIndex(
  bag: readonly number[],
  queueLength: number,
  currentIndex: number,
  repeat: RepeatMode,
  random = Math.random,
): { index: number | null; bag: number[] } {
  let nextBag = bag.filter((index) => Number.isInteger(index) && index >= 0 && index < queueLength && index !== currentIndex);
  if (!nextBag.length) {
    if (repeat !== "all") return { index: null, bag: [] };
    nextBag = createShuffleBag(queueLength, currentIndex);
  }
  if (!nextBag.length) {
    // A one-track queue can only repeat itself in repeat-all mode.
    return repeat === "all" && queueLength === 1 ? { index: currentIndex >= 0 ? currentIndex : 0, bag: [] } : { index: null, bag: [] };
  }
  const raw = Number(random());
  const position = Math.min(nextBag.length - 1, Math.max(0, Number.isFinite(raw) ? Math.floor(raw * nextBag.length) : 0));
  const [index] = nextBag.splice(position, 1);
  return { index: index ?? null, bag: nextBag };
}

export interface ShufflePendingSelection {
  index: number;
  /** The bag snapshot to commit only when playback actually advances. */
  bag: number[];
  /** True when this candidate starts a new repeat-all round. */
  wrapped: boolean;
}

export interface ShuffleNavigationState {
  bag: number[];
  /** Includes the current item at `cursor`, plus reversible past/future items. */
  history: number[];
  cursor: number;
  pending: ShufflePendingSelection | null;
}

const validQueueIndex = (index: number, queueLength: number): boolean => (
  Number.isInteger(index) && index >= 0 && index < queueLength
);

export interface QueueBatchTransition {
  queue: PlexItem[];
  currentIndex: number;
  addedCount: number;
  /** A queue without a current item starts from its first available track. */
  shouldStart: boolean;
}

/** Keep one artist-level action stable even when PMS repeats a rating key across pages. */
export function normalizeQueueBatch(items: readonly PlexItem[]): PlexItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.type !== "track" || !item.ratingKey || seen.has(item.ratingKey)) return false;
    seen.add(item.ratingKey);
    return true;
  });
}

/** Append a batch without replacing or advancing an active queue. */
export function appendQueueBatch(
  queue: readonly PlexItem[],
  currentIndex: number,
  incoming: readonly PlexItem[],
): QueueBatchTransition {
  const tracks = createQueueInstances(normalizeQueueBatch(incoming));
  if (!tracks.length) return { queue: [...queue], currentIndex, addedCount: 0, shouldStart: false };

  const nextQueue = [...ensureQueueInstanceIds(queue), ...tracks];
  const hasCurrent = validQueueIndex(currentIndex, queue.length);
  return {
    queue: nextQueue,
    currentIndex: hasCurrent ? currentIndex : 0,
    addedCount: tracks.length,
    shouldStart: !hasCurrent,
  };
}

/** Insert a batch directly after the active item while preserving its order. */
export function insertQueueBatchNext(
  queue: readonly PlexItem[],
  currentIndex: number,
  incoming: readonly PlexItem[],
): QueueBatchTransition {
  const tracks = createQueueInstances(normalizeQueueBatch(incoming));
  if (!tracks.length) return { queue: [...queue], currentIndex, addedCount: 0, shouldStart: false };

  if (!validQueueIndex(currentIndex, queue.length)) {
    const nextQueue = [...ensureQueueInstanceIds(queue), ...tracks];
    return {
      queue: nextQueue,
      currentIndex: 0,
      addedCount: tracks.length,
      shouldStart: true,
    };
  }

  const insertAt = currentIndex + 1;
  return {
    queue: [...queue.slice(0, insertAt), ...tracks, ...queue.slice(insertAt)],
    currentIndex,
    addedCount: tracks.length,
    shouldStart: false,
  };
}

/** Start a shuffle traversal without consuming any candidate. */
export function createShuffleNavigationState(queueLength: number, currentIndex: number): ShuffleNavigationState {
  const hasCurrent = validQueueIndex(currentIndex, queueLength);
  return {
    bag: createShuffleBag(queueLength, hasCurrent ? currentIndex : -1),
    history: hasCurrent ? [currentIndex] : [],
    cursor: hasCurrent ? 0 : -1,
    pending: null,
  };
}

function normalizeShuffleNavigationState(
  state: ShuffleNavigationState,
  queueLength: number,
  currentIndex: number,
): ShuffleNavigationState {
  if (!validQueueIndex(currentIndex, queueLength)) return createShuffleNavigationState(queueLength, -1);
  const cursorIsCurrent = Number.isInteger(state.cursor)
    && state.cursor >= 0
    && state.cursor < state.history.length
    && state.history[state.cursor] === currentIndex;
  if (!cursorIsCurrent) return createShuffleNavigationState(queueLength, currentIndex);

  const bag = state.bag.filter((index, position, values) => (
    validQueueIndex(index, queueLength)
    && index !== currentIndex
    && values.indexOf(index) === position
  ));
  const pending = state.pending
    && validQueueIndex(state.pending.index, queueLength)
    && (state.pending.index !== currentIndex || queueLength === 1)
    ? {
        ...state.pending,
        bag: state.pending.bag.filter((index, position, values) => (
          validQueueIndex(index, queueLength)
          && index !== currentIndex
          && values.indexOf(index) === position
        )),
      }
    : null;
  return { ...state, bag, pending };
}

/**
 * Select a stable shuffle candidate for prebuffering without consuming it.
 * Forward history always wins, so Previous followed by Next is reversible.
 */
export function previewShuffleNext(
  state: ShuffleNavigationState,
  queueLength: number,
  currentIndex: number,
  repeat: RepeatMode,
  random = Math.random,
): { index: number | null; state: ShuffleNavigationState } {
  let normalized = normalizeShuffleNavigationState(state, queueLength, currentIndex);
  if (!validQueueIndex(currentIndex, queueLength) || repeat === "one") {
    return { index: null, state: { ...normalized, pending: null } };
  }

  const forwardIndex = normalized.history[normalized.cursor + 1];
  if (validQueueIndex(forwardIndex, queueLength)) {
    return { index: forwardIndex, state: { ...normalized, pending: null } };
  }

  if (normalized.pending && (!normalized.pending.wrapped || repeat === "all")) {
    return { index: normalized.pending.index, state: normalized };
  }
  normalized = { ...normalized, pending: null };

  let candidateBag = normalized.bag;
  let wrapped = false;
  if (!candidateBag.length) {
    if (repeat !== "all") return { index: null, state: normalized };
    candidateBag = createShuffleBag(queueLength, currentIndex);
    wrapped = true;
  }
  if (!candidateBag.length) {
    if (queueLength !== 1) return { index: null, state: normalized };
    const pending = { index: currentIndex, bag: [], wrapped: true };
    return { index: currentIndex, state: { ...normalized, pending } };
  }

  const raw = Number(random());
  const position = Math.min(candidateBag.length - 1, Math.max(0, Number.isFinite(raw) ? Math.floor(raw * candidateBag.length) : 0));
  const index = candidateBag[position] ?? null;
  if (index == null) return { index: null, state: normalized };
  const pending = { index, bag: [...candidateBag], wrapped };
  return { index, state: { ...normalized, pending } };
}

/** Commit a previewed/random next item only when playback actually advances. */
export function commitShuffleNext(
  state: ShuffleNavigationState,
  queueLength: number,
  currentIndex: number,
  repeat: RepeatMode,
  random = Math.random,
): { index: number | null; state: ShuffleNavigationState } {
  const preview = previewShuffleNext(state, queueLength, currentIndex, repeat, random);
  const index = preview.index;
  if (index == null) return preview;
  const normalized = preview.state;
  const forwardIndex = normalized.history[normalized.cursor + 1];
  if (forwardIndex === index) {
    return {
      index,
      state: { ...normalized, cursor: normalized.cursor + 1, pending: null },
    };
  }

  if (queueLength === 1 && index === currentIndex) {
    return { index, state: { ...normalized, bag: [], pending: null } };
  }

  let history = [...normalized.history.slice(0, normalized.cursor + 1), index];
  let cursor = history.length - 1;
  if (history.length > PLAYBACK_SESSION_MAX_QUEUE) {
    const overflow = history.length - PLAYBACK_SESSION_MAX_QUEUE;
    history = history.slice(overflow);
    cursor -= overflow;
  }
  const committedBag = (normalized.pending?.bag ?? normalized.bag).filter((candidate) => candidate !== index);
  return {
    index,
    state: { bag: committedBag, history, cursor, pending: null },
  };
}

/** Move backward through the exact played shuffle order without changing its bag. */
export function moveShufflePrevious(
  state: ShuffleNavigationState,
  queueLength: number,
  currentIndex: number,
): { index: number | null; state: ShuffleNavigationState } {
  const normalized = normalizeShuffleNavigationState(state, queueLength, currentIndex);
  if (normalized.cursor <= 0) return { index: null, state: normalized };
  const cursor = normalized.cursor - 1;
  const index = normalized.history[cursor];
  if (!validQueueIndex(index, queueLength)) return { index: null, state: normalized };
  return { index, state: { ...normalized, cursor, pending: null } };
}

/** Deterministic queue-only transition used when shuffle is disabled. */
export function getSequentialNextIndex(currentIndex: number, queueLength: number, repeat: RepeatMode): number | null {
  if (!Number.isInteger(queueLength) || queueLength <= 0) return null;
  if (repeat === "one") return currentIndex >= 0 && currentIndex < queueLength ? currentIndex : 0;
  const nextIndex = currentIndex + 1;
  if (nextIndex >= 0 && nextIndex < queueLength) return nextIndex;
  return repeat === "all" ? 0 : null;
}

export function queueNavigationAvailability(
  currentIndex: number,
  queueLength: number,
  repeat: RepeatMode,
  shuffle: boolean,
): { canPrevious: boolean; canNext: boolean } {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= queueLength || queueLength <= 1) {
    return { canPrevious: false, canNext: false };
  }
  const canWrap = repeat !== "off" || shuffle;
  return {
    canPrevious: canWrap || currentIndex > 0,
    canNext: canWrap || currentIndex < queueLength - 1,
  };
}

/** Manual Next always advances within the current queue, wrapping at its end. */
export function getManualNextIndex(currentIndex: number, queueLength: number): number | null {
  if (!Number.isInteger(queueLength) || queueLength <= 0) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= queueLength) return 0;
  return (currentIndex + 1) % queueLength;
}

/** Manual Previous follows the queue boundary unless repeat permits wrapping. */
export function getManualPreviousIndex(
  currentIndex: number,
  queueLength: number,
  repeat: RepeatMode,
): number | null {
  if (!Number.isInteger(queueLength) || queueLength <= 0) return null;
  if (Number.isInteger(currentIndex) && currentIndex > 0 && currentIndex < queueLength) {
    return currentIndex - 1;
  }
  return repeat === "off" ? null : queueLength - 1;
}

/** The native engine receives the audible gain, while React retains the slider value. */
export function effectivePlaybackVolume(volume: number, muted: boolean): number {
  if (muted) return 0;
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.5;
}

/** PMS counts a track once playback reaches 90 percent. */
export function shouldScrobblePlayback(position: number, duration: number): boolean {
  return Number.isFinite(position)
    && Number.isFinite(duration)
    && position >= 0
    && duration > 0
    && position / duration >= 0.9;
}

function readStorage(key: string, fallback: string): string {
  try {
    return typeof localStorage === "undefined" ? fallback : localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // A restricted WebView can reject storage writes; playback should still work.
  }
}

const storedVolume = (): number => {
  const value = Number.parseFloat(readStorage(VOLUME_STORAGE_KEY, "0.5"));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
};

const storedPrebufferNext = (): boolean => readStorage(PREBUFFER_STORAGE_KEY, "true") !== "false";
const storedOutputSinkId = (): string => readOutputDevicePreference();

function playbackArtworkTicket(serverId: string, track: PlexItem): Promise<string | undefined> {
  if (track.imageUrl) return Promise.resolve(track.imageUrl);
  if (!track.thumb) return Promise.resolve(undefined);
  return requestCachedArtwork(serverId, track.thumb, 512, 512).catch(() => undefined);
}

function withResolvedArtwork(serverId: string | undefined, track: PlexItem): PlexItem {
  if (!serverId || track.imageUrl || !track.thumb) return track;
  const imageUrl = getResolvedArtwork(serverId, track.thumb);
  return imageUrl ? { ...track, imageUrl } : track;
}

export type FallbackStreamQuality = Exclude<StreamQuality, "auto" | "original">;

export interface PlaybackFailure {
  message: string;
  technicalDetails: string;
  attemptedQualities: StreamQuality[];
}

interface NativePlaybackSource {
  index: number;
  ratingKey: string;
  queueInstanceId: string;
  activeQuality: StreamQuality;
  source: string;
  attemptedQualities: StreamQuality[];
  diagnostics: string[];
  runtimeRetryUsed: boolean;
}

interface NativeLoadRecovery {
  initialQuality: StreamQuality;
  attemptedQualities: StreamQuality[];
  diagnostics: string[];
  runtimeRetryUsed: boolean;
}

/** Read the effective public transcode marker without exposing the loopback ticket. */
export function sourceStreamQuality(source: string): FallbackStreamQuality | undefined {
  try {
    const quality = new URL(source).searchParams.get("maxAudioBitrate");
    return FALLBACK_QUALITY_ORDER.includes(quality as FallbackStreamQuality)
      ? quality as FallbackStreamQuality
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the representation used by a native cache entry from its ticket. */
export function nativeAudioCacheQuality(
  requestedQuality: StreamQuality,
  source: string,
): StreamQuality {
  return sourceStreamQuality(source)
    || (requestedQuality === "auto" ? "original" : requestedQuality);
}

/**
 * Automatic compatibility starts with the original Part and then descends
 * through exact PMS transcode rates. An explicit original/bitrate selection is
 * strict and never silently changes to another representation.
 */
export function playbackFallbackQualities(
  requestedQuality: StreamQuality,
  activeQuality: StreamQuality,
  source: string,
  attemptedQualities: readonly StreamQuality[] = [],
): FallbackStreamQuality[] {
  if (requestedQuality !== "auto") return [];
  const effective = sourceStreamQuality(source);
  const activeFallback = FALLBACK_QUALITY_ORDER.includes(activeQuality as FallbackStreamQuality)
    ? activeQuality as FallbackStreamQuality
    : undefined;
  const current = effective ?? activeFallback;
  const candidates = current
    ? FALLBACK_QUALITY_ORDER.slice(FALLBACK_QUALITY_ORDER.indexOf(current) + 1)
    : FALLBACK_QUALITY_ORDER;
  return candidates.filter((quality) => !attemptedQualities.includes(quality));
}

function appendAttemptedQuality(
  attemptedQualities: StreamQuality[],
  ...qualities: Array<StreamQuality | undefined>
): void {
  for (const quality of qualities) {
    if (quality && !attemptedQualities.includes(quality)) attemptedQualities.push(quality);
  }
}

function playbackAttemptLabel(qualities: readonly StreamQuality[]): string {
  return qualities.map((quality) => {
    if (quality === "auto") return "自动源";
    if (quality === "original") return "原始质量";
    return `${quality} kbps`;
  }).join("、");
}

function boundedResumeSeconds(seconds: number, duration: number): number {
  if (!finiteNumber(seconds) || seconds <= 0) return 0;
  if (!finiteNumber(duration) || duration <= 0) return seconds;
  // Seeking exactly to duration often fires `ended` before play starts.
  return Math.max(0, Math.min(seconds, Math.max(0, duration - 0.05)));
}

export const RESTORED_END_RESET_THRESHOLD_SECONDS = 2;

/** A completed/almost-completed track should restart instead of playing its last instant. */
export function normalizeRestoredProgress(seconds: number, duration: number): number {
  const bounded = boundedResumeSeconds(seconds, duration);
  if (duration > 0 && bounded > 0 && duration - bounded <= RESTORED_END_RESET_THRESHOLD_SECONDS) return 0;
  return bounded;
}

/** Coordinate the Rust playback authority with its React state mirror. */
export function usePlayer(serverId: string | undefined, quality: StreamQuality) {
  const queueRef = useRef<PlexItem[]>([]);
  const indexRef = useRef(-1);
  const progressRef = useRef(0);
  const scrobbledRef = useRef(new Set<string>());
  const playbackLoadingRef = useRef(false);
  const playbackLoadingStartedAtRef = useRef(0);
  const playbackLoadingClearTimerRef = useRef<number | undefined>(undefined);
  const streamUrlInflightRef = useRef(new Map<string, Promise<string>>());
  const streamUrlInflightAtRef = useRef(new Map<string, number>());
  const loadRequestRef = useRef(0);
  const nextSourceRequestRef = useRef(0);
  const activeNativeSourceRef = useRef<NativePlaybackSource | undefined>(undefined);
  const pendingNativeSourceRef = useRef<NativePlaybackSource | undefined>(undefined);
  const serverIdRef = useRef(serverId);
  const qualityRef = useRef(quality);
  const queueServerIdRef = useRef<string | undefined>(undefined);
  const shuffleNavigationRef = useRef<ShuffleNavigationState>(createShuffleNavigationState(0, -1));
  const resumeProgressRef = useRef<number | null>(null);
  const restoredServerRef = useRef<string | undefined>(undefined);
  const persistedSessionTimerRef = useRef<number | undefined>(undefined);
  const playbackSessionDiscardedRef = useRef(false);
  // The queue is restored only after bootstrap identifies its owning server.
  // Rendering an unowned snapshot here can leak a stale queue into another PMS.
  const [queue, setQueue] = useState<PlexItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoadingState] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(storedVolume);
  const [muted, setMutedState] = useState(false);
  // A resumed playlist loops by default so ending it cannot unexpectedly
  // advance into another context. Existing users can still switch to off.
  const [shuffle, setShuffleState] = useState(false);
  const [repeat, setRepeatState] = useState<RepeatMode>("all");
  const [prebufferNext, setPrebufferNextState] = useState(storedPrebufferNext);
  const [outputSinkId, setOutputSinkIdState] = useState(storedOutputSinkId);
  const [error, setError] = useState<string>();
  const [playbackFailure, setPlaybackFailure] = useState<PlaybackFailure>();
  const [gaplessHandoffGeneration, setGaplessHandoffGeneration] = useState(0);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const playingRef = useRef(playing);
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const outputSinkIdRef = useRef(outputSinkId);
  const nativeQueueBarrierRef = useRef<NativeQueueCommandBarrier | null>(null);
  if (nativeQueueBarrierRef.current === null) {
    nativeQueueBarrierRef.current = new NativeQueueCommandBarrier();
  }

  serverIdRef.current = serverId;
  qualityRef.current = quality;
  volumeRef.current = volume;
  mutedRef.current = muted;
  playingRef.current = playing;
  shuffleRef.current = shuffle;
  repeatRef.current = repeat;
  outputSinkIdRef.current = outputSinkId;

  const setPlaybackLoading = useCallback((value: boolean) => {
    const pending = playbackLoadingClearTimerRef.current;
    if (pending !== undefined) {
      window.clearTimeout(pending);
      playbackLoadingClearTimerRef.current = undefined;
    }
    if (value) {
      playbackLoadingStartedAtRef.current = Date.now();
      playbackLoadingRef.current = true;
      setLoadingState(true);
      return;
    }
    const elapsed = Date.now() - playbackLoadingStartedAtRef.current;
    const remaining = MIN_LOADING_VISIBLE_MS - elapsed;
    if (remaining > 0) {
      playbackLoadingClearTimerRef.current = window.setTimeout(() => {
        playbackLoadingClearTimerRef.current = undefined;
        if (!playbackLoadingRef.current) return;
        playbackLoadingRef.current = false;
        setLoadingState(false);
      }, remaining);
      return;
    }
    playbackLoadingRef.current = false;
    setLoadingState(false);
  }, []);

  const requestStreamUrl = useCallback(async (
    serverId: string,
    track: PlexItem,
    quality: StreamQuality,
    forceFresh = false,
  ): Promise<string> => {
    const key = `${serverId}:${track.ratingKey}:${quality}`;
    const now = Date.now();
    const cachedAt = streamUrlInflightAtRef.current.get(key);
    const cached = streamUrlInflightRef.current.get(key);
    if (!forceFresh && cached && cachedAt !== undefined && now - cachedAt < STREAM_URL_INFLIGHT_CACHE_MS) {
      return cached;
    }
    const promise = plexMusicGateway.playback.streamUrl(serverId, track, quality);
    streamUrlInflightRef.current.set(key, promise);
    streamUrlInflightAtRef.current.set(key, now);
    promise.then(
      () => undefined,
      () => {
        streamUrlInflightRef.current.delete(key);
        streamUrlInflightAtRef.current.delete(key);
      },
    );
    return promise;
  }, []);

  const current = currentIndex >= 0 ? queue[currentIndex] : undefined;

  const flushPlaybackSession = useCallback(() => {
    const timer = persistedSessionTimerRef.current;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      persistedSessionTimerRef.current = undefined;
    }
    if (playbackSessionDiscardedRef.current) return;
    const activeServerId = queueServerIdRef.current;
    const activeQueue = queueRef.current;
    if (!activeServerId || !activeQueue.length) return;
    const session = createPersistedPlaybackSession({
      serverId: activeServerId,
      quality: qualityRef.current,
      queue: activeQueue,
      currentIndex: indexRef.current,
      progress: progressRef.current,
      shuffle: shuffleRef.current,
      repeat: repeatRef.current,
    });
    if (session) writePersistedPlaybackSession(session);
  }, []);

  const discardPlaybackSession = useCallback(() => {
    playbackSessionDiscardedRef.current = true;
    const timer = persistedSessionTimerRef.current;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      persistedSessionTimerRef.current = undefined;
    }
    clearPersistedPlaybackSession();
  }, []);

  const schedulePersistedSession = useCallback((immediate = false) => {
    if (playbackSessionDiscardedRef.current) return;
    if (immediate) {
      flushPlaybackSession();
      return;
    }
    if (persistedSessionTimerRef.current !== undefined) return;
    persistedSessionTimerRef.current = window.setTimeout(() => {
      persistedSessionTimerRef.current = undefined;
      flushPlaybackSession();
    }, PLAYBACK_SESSION_WRITE_THROTTLE_MS);
  }, [flushPlaybackSession]);

  const syncNativeQueue = useCallback((before?: () => Promise<void>): Promise<void> => {
    if (!isDesktopRuntime()) return Promise.resolve();
    // Capture an immutable snapshot before entering the serialized IPC chain;
    // later React updates must not rewrite an already-enqueued native mutation.
    const queueSnapshot = ensureQueueInstanceIds(queueRef.current);
    if (queueSnapshot.some((track, index) => track !== queueRef.current[index])) {
      queueRef.current = queueSnapshot;
      setQueue(queueSnapshot);
    }
    const tracks = queueSnapshot.map((track) => ({
        rating_key: track.ratingKey,
        occurrence_id: track.queueInstanceId!,
        title: track.title || "",
        artist: trackArtist(track),
        album: trackAlbum(track),
      }));
    const currentIndex = indexRef.current;
    const repeatMode = repeatRef.current;
    const shuffleMode = shuffleRef.current;
    return nativeQueueBarrierRef.current!.enqueue(async () => {
        if (before) await before();
        await nativeQueueSet(tracks, currentIndex, repeatMode, shuffleMode);
      });
  }, []);

  const loadNativeTrack = useCallback(async (params: {
    index: number;
    autoplay: boolean;
    resumeSeconds: number;
    requestId: number;
    forceFreshTicket: boolean;
    recovery?: NativeLoadRecovery;
  }) => {
    const { index, autoplay, resumeSeconds, requestId, forceFreshTicket, recovery } = params;
    const tracks = queueRef.current;
    const track = tracks[index];
    if (!track || !serverId) return;
    const attemptedQualities: StreamQuality[] = [...(recovery?.attemptedQualities ?? [])];
    const diagnostics: string[] = [...(recovery?.diagnostics ?? [])];
    let lastActiveQuality: StreamQuality = recovery?.initialQuality ?? quality;
    const artworkTicketPromise = playbackArtworkTicket(serverId, track);
    try {
      // Put stop + queue sync in the same frontend barrier. The prebuffer effect
      // cannot peek the old Rust queue while a track switch is being prepared.
      await syncNativeQueue(() => nativeAudioStop().catch(() => undefined));
      // 音量权威始终在前端；即使引擎尚未创建，Rust slot 也会先记住该值，
      // 在创建 Player 的同一轮应用，避免首个采样短暂以 100% 输出。
      await nativeAudioSetVolume(effectivePlaybackVolume(volumeRef.current, mutedRef.current));
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      let activeQuality: StreamQuality | undefined = recovery?.initialQuality ?? quality;
      while (activeQuality) {
        lastActiveQuality = activeQuality;
        const url = await requestStreamUrl(
          serverId,
          track,
          activeQuality,
          forceFreshTicket || attemptedQualities.length > 0,
        );
        if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
        playbackLog("info", `原生流地址已取得：index=${index} 质量=${activeQuality}`);
        try {
          await nativeAudioLoad(url, nativeAudioCacheIdentity(
            serverId,
            track,
            nativeAudioCacheQuality(activeQuality, url),
          ), {
            title: track.title,
            artist: trackArtist(track),
            album: trackAlbum(track),
            durationMs: track.duration,
            artworkUrl: track.imageUrl,
          }, autoplay);
          if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
          const successfulQualities = [...attemptedQualities];
          appendAttemptedQuality(successfulQualities, activeQuality, sourceStreamQuality(url));
          activeNativeSourceRef.current = {
            index,
            ratingKey: track.ratingKey,
            queueInstanceId: track.queueInstanceId || "",
            activeQuality,
            source: url,
            attemptedQualities: successfulQualities,
            diagnostics: [...diagnostics],
            runtimeRetryUsed: recovery?.runtimeRetryUsed ?? false,
          };
          pendingNativeSourceRef.current = undefined;
          if (!track.imageUrl) {
            void artworkTicketPromise.then((artworkTicket) => {
              if (!artworkTicket
                || requestId !== loadRequestRef.current
                || indexRef.current !== index) return;
              return nativeAudioSetArtwork(
                index,
                track.ratingKey,
                track.queueInstanceId || "",
                artworkTicket,
              ).catch(() => undefined);
            });
          }
          break;
        } catch (reason) {
          if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
          const diagnostic = reason instanceof Error ? reason.message : String(reason);
          diagnostics.push(`${activeQuality}: ${diagnostic}`);
          appendAttemptedQuality(attemptedQualities, activeQuality, sourceStreamQuality(url));
          const fallback: FallbackStreamQuality | undefined = playbackFallbackQualities(
            quality,
            activeQuality,
            url,
            attemptedQualities,
          )[0];
          if (!fallback) throw new Error(diagnostics.join("；"));
          playbackLog("warn", `原生音源不可用：index=${index} 质量=${activeQuality}，尝试 ${fallback} kbps`);
          activeQuality = fallback;
        }
      }
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      if (resumeSeconds > 0.5) {
        try {
          await nativeAudioSeek(resumeSeconds);
        } catch {
          // 恢复位置失败不阻断播放。
        }
      }
      if (!autoplay) await nativeAudioPause();
      // `nativeAudioLoad` only means the decoder accepted the source. The
      // playback UI must wait for Rust to confirm that the output callback
      // has consumed PCM from this specific queue item.
      setPlaying(false);
      setBuffering(false);
      setPlaybackLoading(autoplay);
      playbackLog("info", autoplay
        ? `原生音源已就绪，等待实际 PCM 输出：index=${index}`
        : `原生音源已就绪并暂停：index=${index}`);
    } catch (reason) {
      if (requestId !== loadRequestRef.current) return;
      const diagnostic = reason instanceof Error ? reason.message : String(reason);
      activeNativeSourceRef.current = undefined;
      appendAttemptedQuality(attemptedQualities, lastActiveQuality);
      const attemptedLabel = playbackAttemptLabel(attemptedQualities);
      const message = `音频无法播放。${attemptedLabel ? `已尝试 ${attemptedLabel}；` : ""}请检查服务器连接或转码状态。`;
      playbackLog("error", `原生加载异常：index=${index} ${diagnostic}`);
      setPlaybackLoading(false);
      setBuffering(false);
      setPlaying(false);
      setError(message);
      setPlaybackFailure({ message, technicalDetails: diagnostic, attemptedQualities });
    }
  }, [quality, requestStreamUrl, serverId, syncNativeQueue]);

  const loadAt = useCallback(async (
    index: number,
    autoplay = true,
    requestedResume?: number,
    forceFreshTicket = false,
    recovery?: NativeLoadRecovery,
  ) => {
    const tracks = queueRef.current;
    const track = tracks[index];
    if (!track || !serverId) return;
    const requestId = ++loadRequestRef.current;
    activeNativeSourceRef.current = undefined;
    pendingNativeSourceRef.current = undefined;
    playbackLog("info", `加载请求：index=${index} 队列长度=${tracks.length} 自动播放=${autoplay} 质量=${quality} 强制新票据=${forceFreshTicket}`);
    setPlaybackLoading(autoplay);
    setPlaying(false);
    setBuffering(false);
    indexRef.current = index;
    setCurrentIndex(index);
    const resumeSeconds = boundedResumeSeconds(requestedResume ?? 0, (track.duration || 0) / 1000);
    resumeProgressRef.current = resumeSeconds;
    setProgress(resumeSeconds);
    progressRef.current = resumeSeconds;
    setDuration((track.duration || 0) / 1000);
    setError(undefined);
    setPlaybackFailure(undefined);
    queueServerIdRef.current = serverId;
    schedulePersistedSession(true);

    if (!isDesktopRuntime()) {
      resumeProgressRef.current = null;
      setPlaybackLoading(false);
      setPlaying(autoplay);
      return;
    }
    await loadNativeTrack({ index, autoplay, resumeSeconds, requestId, forceFreshTicket, recovery });
  }, [loadNativeTrack, schedulePersistedSession, serverId, setPlaybackLoading]);

  const retryCurrent = useCallback(() => {
    if (indexRef.current < 0 || !queueRef.current.length) return;
    void loadAt(indexRef.current, true, resumeProgressRef.current ?? progressRef.current, true);
  }, [loadAt]);

  const dismissPlaybackFailure = useCallback(() => {
    setPlaybackFailure(undefined);
    setError(undefined);
  }, []);

  const resetShuffleState = useCallback((currentIndex: number) => {
    shuffleNavigationRef.current = createShuffleNavigationState(queueRef.current.length, currentIndex);
  }, []);

  const playContext = useCallback((track: PlexItem, context: PlexItem[] = [track]) => {
    const playable = context.filter((item) => item.type === "track");
    const contextIndex = playable.findIndex((item) => (
      item === track
      || Boolean(track.playlistItemID && item.playlistItemID === track.playlistItemID)
    ));
    const queueSource = contextIndex >= 0 ? playable : [track, ...playable];
    const tracks = createQueueInstances(
      queueSource.map((item) => withResolvedArtwork(serverIdRef.current, item)),
    );
    const index = Math.max(0, contextIndex);
    queueRef.current = tracks;
    queueServerIdRef.current = serverIdRef.current;
    resumeProgressRef.current = null;
    shuffleNavigationRef.current = createShuffleNavigationState(tracks.length, index);
    setQueue(tracks);
    indexRef.current = index;
    setCurrentIndex(index);
    progressRef.current = 0;
    setProgress(0);
    schedulePersistedSession(true);
    void loadAt(index, true);
  }, [loadAt, schedulePersistedSession]);

  const playTracks = useCallback((incoming: readonly PlexItem[]): boolean => {
    const tracks = createQueueInstances(
      normalizeQueueBatch(incoming).map((item) => withResolvedArtwork(serverIdRef.current, item)),
    );
    if (!tracks.length) return false;
    queueRef.current = tracks;
    queueServerIdRef.current = serverIdRef.current;
    resumeProgressRef.current = null;
    shuffleNavigationRef.current = createShuffleNavigationState(tracks.length, 0);
    setQueue(tracks);
    indexRef.current = 0;
    setCurrentIndex(0);
    progressRef.current = 0;
    setProgress(0);
    schedulePersistedSession(true);
    void loadAt(0, true);
    return true;
  }, [loadAt, schedulePersistedSession]);

  const applyQueueBatch = useCallback((transition: QueueBatchTransition): boolean => {
    if (!transition.addedCount) return false;
    queueRef.current = transition.queue;
    queueServerIdRef.current = serverIdRef.current;
    indexRef.current = transition.currentIndex;
    shuffleNavigationRef.current = createShuffleNavigationState(transition.queue.length, transition.currentIndex);
    setQueue(transition.queue);
    setCurrentIndex(transition.currentIndex);
    if (transition.shouldStart) {
      resumeProgressRef.current = null;
      progressRef.current = 0;
      setProgress(0);
    }
    schedulePersistedSession(true);
    if (transition.shouldStart) void loadAt(transition.currentIndex, true);
    else void syncNativeQueue().catch(() => undefined);
    return true;
  }, [loadAt, schedulePersistedSession, syncNativeQueue]);

  const appendTracks = useCallback((incoming: readonly PlexItem[]): boolean => (
    applyQueueBatch(appendQueueBatch(queueRef.current, indexRef.current, incoming))
  ), [applyQueueBatch]);

  const insertTracksNext = useCallback((incoming: readonly PlexItem[]): boolean => (
    applyQueueBatch(insertQueueBatchNext(queueRef.current, indexRef.current, incoming))
  ), [applyQueueBatch]);

  const advance = useCallback((naturalEnded: boolean) => {
    const tracks = queueRef.current;
    if (!tracks.length) return;
    const mode = repeatRef.current;
    const isShuffle = shuffleRef.current;
    const currentIndexValue = indexRef.current;
    // Repeat-one applies to natural media completion only. A deliberate Next
    // always advances to another item in this queue.
    if (naturalEnded && mode === "one") {
      const repeatIndex = getSequentialNextIndex(currentIndexValue, tracks.length, mode);
      if (repeatIndex != null) void loadAt(repeatIndex, true);
      return;
    }
    if (isShuffle) {
      // Manual Next remains useful even when repeat is off/one. Natural ended
      // still honors the selected repeat boundary.
      const shuffleRepeat = naturalEnded ? mode : "all";
      const selected = commitShuffleNext(
        shuffleNavigationRef.current,
        tracks.length,
        currentIndexValue,
        shuffleRepeat,
      );
      shuffleNavigationRef.current = selected.state;
      if (selected.index != null) {
        playbackLog("info", `切歌（随机）：${currentIndexValue} -> ${selected.index} 自然结束=${naturalEnded}`);
        void loadAt(selected.index, true);
      } else {
        setPlaybackLoading(false);
        setBuffering(false);
        setPlaying(false);
        schedulePersistedSession(true);
      }
      return;
    }
    const nextIndex = naturalEnded
      ? getSequentialNextIndex(currentIndexValue, tracks.length, mode)
      : getManualNextIndex(currentIndexValue, tracks.length);
    if (nextIndex != null) void loadAt(nextIndex, true);
    else {
      playbackLog("info", `队列结束：index=${currentIndexValue} 自然结束=${naturalEnded} 循环=${mode}`);
      setPlaybackLoading(false);
      setBuffering(false);
      setPlaying(false);
      schedulePersistedSession(true);
    }
  }, [loadAt, schedulePersistedSession]);

  /** 切歌瞬间的动作：立即停掉旧歌，并把进度状态同步归 0，不等任何引擎 IPC 返回。 */
  const stopCurrentImmediately = useCallback((): Promise<void> => {
    const stop = isDesktopRuntime()
      ? nativeAudioStop().catch(() => undefined)
      : Promise.resolve();
    resumeProgressRef.current = null;
    progressRef.current = 0;
    setProgress(0);
    return stop;
  }, []);

  const resetEmptyQueueMirror = useCallback((resetModes: boolean) => {
    playbackSessionDiscardedRef.current = false;
    clearPersistedPlaybackSession();
    queueRef.current = [];
    queueServerIdRef.current = undefined;
    indexRef.current = -1;
    progressRef.current = 0;
    resumeProgressRef.current = null;
    shuffleNavigationRef.current = createShuffleNavigationState(0, -1);
    scrobbledRef.current.clear();
    setQueue([]);
    setCurrentIndex(-1);
    setProgress(0);
    setDuration(0);
    setPlaying(false);
    setPlaybackLoading(false);
    setBuffering(false);
    if (resetModes) {
      shuffleRef.current = false;
      repeatRef.current = "all";
      setShuffleState(false);
      setRepeatState("all");
    }
    setError(undefined);
    setPlaybackFailure(undefined);
  }, [setPlaybackLoading]);

  const clearQueue = useCallback(async (): Promise<void> => {
    const activeSource = activeNativeSourceRef.current;
    const pendingSource = pendingNativeSourceRef.current;
    loadRequestRef.current += 1;
    nextSourceRequestRef.current += 1;
    activeNativeSourceRef.current = undefined;
    pendingNativeSourceRef.current = undefined;
    const timer = persistedSessionTimerRef.current;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      persistedSessionTimerRef.current = undefined;
    }
    try {
      await (isDesktopRuntime()
        ? nativeQueueBarrierRef.current!.enqueue(nativeAudioClearQueue)
        : Promise.resolve());
    } catch (reason) {
      activeNativeSourceRef.current = activeSource;
      pendingNativeSourceRef.current = pendingSource;
      schedulePersistedSession(true);
      throw reason;
    }
    resetEmptyQueueMirror(false);
  }, [resetEmptyQueueMirror, schedulePersistedSession]);

  const clearPlaybackAndCache = useCallback(async (): Promise<void> => {
    // Invalidate queued load/prefetch continuations before asking Rust to stop
    // and delete files; otherwise a stale WebView promise can recreate a cache
    // entry immediately after the user pressed Clear.
    loadRequestRef.current += 1;
    nextSourceRequestRef.current += 1;
    activeNativeSourceRef.current = undefined;
    pendingNativeSourceRef.current = undefined;
    const timer = persistedSessionTimerRef.current;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      persistedSessionTimerRef.current = undefined;
    }
    try {
      await (isDesktopRuntime()
        ? nativeQueueBarrierRef.current!.enqueue(nativeAudioClearCache)
        : Promise.resolve());
    } finally {
      // Rust stops and detaches the engine before deleting its files. Keep the
      // WebView mirror consistent even when a locked file makes deletion fail;
      // the original error still propagates after this finally block.
      resetEmptyQueueMirror(true);
    }
  }, [resetEmptyQueueMirror]);

  const next = useCallback(() => {
    // 先停旧歌 + 进度归 0，避免 nativeQueueNext IPC 往返期间旧歌继续出声/进度残留。
    const stopped = stopCurrentImmediately();
    if (!isDesktopRuntime()) {
      void advance(false);
      return;
    }
    void (async () => {
      await stopped;
      try {
        const index = await nativeQueueBarrierRef.current!.enqueue(nativeQueueNext);
        if (index >= 0) await loadAt(index, true);
      } catch {
        advance(false);
      }
    })();
  }, [advance, loadAt, stopCurrentImmediately]);

  const previous = useCallback(() => {
    if (!isDesktopRuntime()) {
      if (progressRef.current > 4) {
        progressRef.current = 0;
        setProgress(0);
        resumeProgressRef.current = null;
        schedulePersistedSession(false);
        return;
      }
      if (shuffleRef.current) {
        const selection = moveShufflePrevious(
          shuffleNavigationRef.current,
          queueRef.current.length,
          indexRef.current,
        );
        shuffleNavigationRef.current = selection.state;
        if (selection.index != null) void loadAt(selection.index, true);
        return;
      }
      const previousIndex = getManualPreviousIndex(
        indexRef.current,
        queueRef.current.length,
        repeatRef.current,
      );
      if (previousIndex != null) void loadAt(previousIndex, true);
      return;
    }
    if (progressRef.current > 4) {
      progressRef.current = 0;
      setProgress(0);
      resumeProgressRef.current = null;
      void nativeAudioSeek(0).catch(() => undefined);
      schedulePersistedSession(false);
      return;
    }
    // 切到上一首同样先停旧歌 + 进度归 0，不等引擎 IPC 返回。
    const stopped = stopCurrentImmediately();
    void (async () => {
      await stopped;
      try {
        const index = await nativeQueueBarrierRef.current!.enqueue(nativeQueuePrevious);
        if (index >= 0) await loadAt(index, true);
      } catch {
        // 没有上一首时回落到当前曲目开头重新播放，避免停在“已停止且进度为 0”的状态。
        if (indexRef.current >= 0) await loadAt(indexRef.current, true, 0);
      }
    })();
  }, [loadAt, schedulePersistedSession, stopCurrentImmediately]);

  const toggle = useCallback(() => {
    if (!current || playbackLoadingRef.current) return;
    if (!isDesktopRuntime()) {
      setPlaying((value) => !value);
      schedulePersistedSession(true);
      return;
    }
    if (playing) {
      void nativeAudioPause().catch(() => undefined);
      setPlaying(false);
    } else {
      void (async () => {
        try {
          const status = await nativeAudioStatus();
          if (!status || status.item_count === 0) {
            // 恢复会话/队列结束等引擎没有源的情况：先加载再播放。
            await loadAt(indexRef.current, true, resumeProgressRef.current ?? progressRef.current);
          } else {
            await nativeAudioPlay();
            // A resumed engine may have been rebuilt while paused after an
            // output-device change. Wait for Rust's next PCM confirmation
            // rather than claiming it is playing as soon as the command
            // returns.
            setPlaying(false);
            setBuffering(false);
            setPlaybackLoading(true);
          }
        } catch {
          setPlaying(false);
        }
      })();
    }
    schedulePersistedSession(true);
  }, [current, loadAt, playing, schedulePersistedSession]);

  const seek = useCallback((seconds: number) => {
    const maximum = duration || (current?.duration || 0) / 1000;
    const requested = finiteNumber(seconds) ? seconds : 0;
    const bounded = maximum > 0 ? Math.max(0, Math.min(maximum, requested)) : Math.max(0, requested);
    // Save first: restored sessions deliberately have an Audio element without
    // a source, and some WebViews throw when currentTime is set in that state.
    resumeProgressRef.current = bounded;
    progressRef.current = bounded;
    setProgress(bounded);
    void nativeAudioSeek(bounded).catch(() => undefined);
    schedulePersistedSession(false);
  }, [current?.duration, duration, schedulePersistedSession]);

  const setVolume = useCallback((value: number) => {
    const normalized = Math.min(1, Math.max(0, value));
    volumeRef.current = normalized;
    mutedRef.current = false;
    setVolumeState(normalized);
    setMutedState(false);
    writeStorage(VOLUME_STORAGE_KEY, String(normalized));
    void nativeAudioSetVolume(normalized).catch(() => undefined);
  }, []);

  const setMuted = useCallback((value: boolean) => {
    const normalized = Boolean(value);
    mutedRef.current = normalized;
    setMutedState(normalized);
    void nativeAudioSetVolume(effectivePlaybackVolume(volumeRef.current, normalized)).catch(() => undefined);
  }, []);

  const setPrebufferNext = useCallback((enabled: boolean) => {
    setPrebufferNextState(enabled);
    writeStorage(PREBUFFER_STORAGE_KEY, String(enabled));
  }, []);

  const setShuffle = useCallback((enabled: boolean) => {
    const normalized = Boolean(enabled);
    shuffleRef.current = normalized;
    setShuffleState(normalized);
    shuffleNavigationRef.current = createShuffleNavigationState(queueRef.current.length, indexRef.current);
    void syncNativeQueue().catch(() => undefined);
    schedulePersistedSession(false);
  }, [schedulePersistedSession, syncNativeQueue]);

  const setRepeat = useCallback((mode: RepeatMode) => {
    const normalized: RepeatMode = mode === "one" || mode === "all" ? mode : "off";
    repeatRef.current = normalized;
    setRepeatState(normalized);
    void syncNativeQueue().catch(() => undefined);
    schedulePersistedSession(false);
  }, [schedulePersistedSession, syncNativeQueue]);

  const setOutputSinkId = useCallback((sinkId: string): Promise<boolean> => {
    const normalized = sinkId || "";
    const commit = () => {
      outputSinkIdRef.current = normalized;
      setOutputSinkIdState(normalized);
      writeOutputDevicePreference(normalized);
    };
    if (!isDesktopRuntime()) {
      commit();
      return Promise.resolve(false);
    }
    return nativeAudioSetOutputDevice(normalized)
      .then(() => {
        commit();
        return true;
      })
      .catch(() => false);
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= queueRef.current.length || index === indexRef.current) return;
    const nextQueue = queueRef.current.filter((_, itemIndex) => itemIndex !== index);
    if (index < indexRef.current) {
      indexRef.current -= 1;
      setCurrentIndex(indexRef.current);
    }
    queueRef.current = nextQueue;
    resetShuffleState(indexRef.current);
    setQueue(nextQueue);
    void syncNativeQueue().catch(() => undefined);
    schedulePersistedSession(true);
  }, [resetShuffleState, schedulePersistedSession, syncNativeQueue]);

  useEffect(() => {
    let disposed = false;
    const previousQueueServerId = queueServerIdRef.current;
    if (previousQueueServerId && previousQueueServerId !== serverId) {
      // Persist with the queue's owner before `serverIdRef`/UI context can make
      // the old session look like it belongs to the newly selected PMS.
      flushPlaybackSession();
      loadRequestRef.current += 1;
      nextSourceRequestRef.current += 1;
      activeNativeSourceRef.current = undefined;
      pendingNativeSourceRef.current = undefined;
      if (isDesktopRuntime()) {
        void nativeQueueBarrierRef.current!.enqueue(async () => {
          await nativeAudioStop().catch(() => undefined);
        });
      }
      queueRef.current = [];
      queueServerIdRef.current = undefined;
      indexRef.current = -1;
      progressRef.current = 0;
      resumeProgressRef.current = null;
      shuffleNavigationRef.current = createShuffleNavigationState(0, -1);
      scrobbledRef.current.clear();
      setQueue([]);
      setCurrentIndex(-1);
      setProgress(0);
      setDuration(0);
      setPlaybackLoading(false);
      setBuffering(false);
      setPlaying(false);
      setError(undefined);
      setPlaybackFailure(undefined);
    }

    if (!serverId) {
      restoredServerRef.current = undefined;
      return () => { disposed = true; };
    }
    if (restoredServerRef.current === serverId) return () => { disposed = true; };
    restoredServerRef.current = serverId;
    const persisted = readPersistedPlaybackSession();

    if (!persisted || persisted.serverId !== serverId) {
      return () => { disposed = true; };
    }

    const restoredQueue = ensureQueueInstanceIds(
      persisted.queue.map((item) => withResolvedArtwork(serverId, { ...item } as PlexItem)),
    );
    const restoredIndex = persisted.currentIndex >= 0 && persisted.currentIndex < restoredQueue.length
      ? persisted.currentIndex
      : -1;
    const restoredTrack = restoredIndex >= 0 ? restoredQueue[restoredIndex] : undefined;
    const restoredProgress = restoredTrack
      ? normalizeRestoredProgress(persisted.progress, (restoredTrack.duration || 0) / 1000)
      : 0;
    queueRef.current = restoredQueue;
    queueServerIdRef.current = serverId;
    indexRef.current = restoredIndex;
    progressRef.current = restoredProgress;
    resumeProgressRef.current = restoredTrack ? restoredProgress : null;
    shuffleRef.current = persisted.shuffle;
    repeatRef.current = persisted.repeat;
    shuffleNavigationRef.current = createShuffleNavigationState(restoredQueue.length, restoredIndex);
    setQueue(restoredQueue);
    setCurrentIndex(restoredIndex);
    setProgress(restoredProgress);
    setDuration((restoredTrack?.duration || 0) / 1000);
    setPlaybackLoading(false);
    setBuffering(false);
    setPlaying(false);
    setShuffleState(persisted.shuffle);
    setRepeatState(persisted.repeat);
    setError(undefined);
    setPlaybackFailure(undefined);

    // A persisted queue can predate the track-level artist contract. Refresh
    // the current item once so album-artist fallback data cannot survive a
    // restart as the authoritative display value.
    if (restoredTrack) {
      void plexMusicGateway.library.getTrack(serverId, restoredTrack.ratingKey)
        .then((freshTrack) => {
          if (disposed) return;
          const refreshedTrack = mergeFreshTrackMetadata(restoredTrack, freshTrack);
          const nextQueue = queueRef.current.map((item, itemIndex) => itemIndex === restoredIndex ? refreshedTrack : item);
          queueRef.current = nextQueue;
          setQueue(nextQueue);
          schedulePersistedSession(true);
        })
        .catch(() => undefined);
    }

    return () => { disposed = true; };
  }, [flushPlaybackSession, serverId, setPlaybackLoading]);

  useEffect(() => {
    const flush = () => flushPlaybackSession();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [flushPlaybackSession]);

  // Native events are long-lived IPC subscriptions. Keep the subscription
  // stable while exposing the latest stateful callbacks through this ref.
  const nativeEventHandlersRef = useRef({
    loadAt,
    next,
    previous,
    schedulePersistedSession,
    seek,
    toggle,
  });
  nativeEventHandlersRef.current = {
    loadAt,
    next,
    previous,
    schedulePersistedSession,
    seek,
    toggle,
  };

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("native-audio://event", (event) => {
      const handlers = nativeEventHandlersRef.current;
      const payload = event.payload as { type?: string; position?: number; duration?: number; command?: string; index?: number; ratingKey?: string; occurrenceId?: string; reason?: string; buffering?: boolean; deviceId?: string; playing?: boolean } | null;
      if (!payload) return;
      if (payload.type === "playback-started") {
        const active = activeNativeSourceRef.current;
        const eventIndex = payload.index;
        const currentTrack = Number.isInteger(eventIndex)
          ? queueRef.current[eventIndex as number]
          : undefined;
        if (!active
          || eventIndex !== active.index
          || payload.ratingKey !== active.ratingKey
          || payload.occurrenceId !== active.queueInstanceId
          || currentTrack?.ratingKey !== active.ratingKey
          || currentTrack.queueInstanceId !== active.queueInstanceId
          || eventIndex !== indexRef.current) {
          playbackLog("warn", "已忽略过期的原生实际输出确认事件");
          return;
        }
        if (typeof payload.position === "number" && Number.isFinite(payload.position)) {
          progressRef.current = payload.position;
          setProgress(payload.position);
        }
        setPlaying(true);
        setPlaybackLoading(false);
        setBuffering(false);
        playbackLog("info", `原生实际 PCM 输出已确认：index=${eventIndex}`);
        handlers.schedulePersistedSession(true);
      } else if (payload.type === "progress" && typeof payload.position === "number" && Number.isFinite(payload.position)) {
        // 加载期间忽略旧歌的残留进度事件，保证切歌瞬间进度归 0 不被覆盖。
        if (playbackLoadingRef.current) return;
        progressRef.current = payload.position;
        setProgress(payload.position);
        const track = queueRef.current[indexRef.current];
        const activeServerId = queueServerIdRef.current;
        const reportedDuration = typeof payload.duration === "number"
          && Number.isFinite(payload.duration)
          && payload.duration > 0
          ? payload.duration
          : (track?.duration || 0) / 1000;
        if (typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration > 0) {
          setDuration(payload.duration);
        }
        handlers.schedulePersistedSession(false);
        const scrobbleKey = activeServerId && track
          ? `${activeServerId}:${track.ratingKey}`
          : undefined;
        if (activeServerId
          && track
          && scrobbleKey
          && shouldScrobblePlayback(payload.position, reportedDuration)
          && !scrobbledRef.current.has(scrobbleKey)) {
          scrobbledRef.current.add(scrobbleKey);
          void plexMusicGateway.playback.scrobble(activeServerId, track).catch(() => undefined);
        }
      } else if (payload.type === "playback-error") {
        const eventIndex = payload.index;
        const track = Number.isInteger(eventIndex) ? queueRef.current[eventIndex as number] : undefined;
        const active = activeNativeSourceRef.current;
        const pending = pendingNativeSourceRef.current;
        const failedSource = active
          && active.index === eventIndex
          && active.ratingKey === payload.ratingKey
          && active.queueInstanceId === payload.occurrenceId
          ? active
          : pending
            && pending.index === eventIndex
            && pending.ratingKey === payload.ratingKey
            && pending.queueInstanceId === payload.occurrenceId
            ? pending
            : undefined;
        if (
          typeof eventIndex !== "number"
          || typeof payload.ratingKey !== "string"
          || typeof payload.occurrenceId !== "string"
          || track?.ratingKey !== payload.ratingKey
          || track?.queueInstanceId !== payload.occurrenceId
          || !failedSource
          || (eventIndex !== indexRef.current && failedSource !== pending)
        ) {
          playbackLog("warn", "已忽略过期的原生播放错误事件");
          return;
        }
        const reason = typeof payload.reason === "string" && payload.reason.trim()
          ? payload.reason.trim()
          : "音频流读取失败";
        if (failedSource === pending && eventIndex !== indexRef.current) {
          indexRef.current = eventIndex;
          setCurrentIndex(eventIndex);
          progressRef.current = 0;
          setProgress(0);
          setDuration((track.duration || 0) / 1000);
        }
        const attemptedQualities = [...failedSource.attemptedQualities];
        appendAttemptedQuality(
          attemptedQualities,
          failedSource.activeQuality,
          sourceStreamQuality(failedSource.source),
        );
        const diagnostics = [...failedSource.diagnostics, `${failedSource.activeQuality}: ${reason}`];
        const fallback = playbackFallbackQualities(
          qualityRef.current,
          failedSource.activeQuality,
          failedSource.source,
          attemptedQualities,
        )[0];
        activeNativeSourceRef.current = undefined;
        pendingNativeSourceRef.current = undefined;
        setPlaying(false);
        setBuffering(false);
        const resumeSeconds = boundedResumeSeconds(
          progressRef.current,
          (track.duration || 0) / 1000,
        );
        if (!failedSource.runtimeRetryUsed) {
          playbackLog(
            "warn",
            `原生流中断：index=${eventIndex} 质量=${failedSource.activeQuality}，从当前进度静默重试`,
          );
          void handlers.loadAt(eventIndex, true, resumeSeconds, true, {
            initialQuality: failedSource.activeQuality,
            attemptedQualities,
            diagnostics,
            runtimeRetryUsed: true,
          });
          return;
        }
        if (fallback) {
          playbackLog(
            "warn",
            `原生流中断：index=${eventIndex} 质量=${failedSource.activeQuality}，从当前进度尝试 ${fallback} kbps`,
          );
          void handlers.loadAt(eventIndex, true, resumeSeconds, true, {
            initialQuality: fallback,
            attemptedQualities,
            diagnostics,
            runtimeRetryUsed: true,
          });
          return;
        }
        const attemptedLabel = playbackAttemptLabel(attemptedQualities);
        const message = `音频无法播放。${attemptedLabel ? `已尝试 ${attemptedLabel}；` : ""}请检查服务器连接或转码状态。`;
        setPlaybackLoading(false);
        setError(message);
        setPlaybackFailure({
          message,
          technicalDetails: diagnostics.join("；"),
          attemptedQualities,
        });
        handlers.schedulePersistedSession(true);
      } else if (payload.type === "ended") {
        // Queue authority lives in Rust: it already decided the next item and
        // emits `queue-item` when one exists; here we only settle local state.
        activeNativeSourceRef.current = undefined;
        pendingNativeSourceRef.current = undefined;
        setPlaying(false);
        setPlaybackLoading(false);
        setBuffering(false);
        handlers.schedulePersistedSession(true);
      } else if (payload.type === "playback-protected-stop") {
        // Rust 心跳看门狗判定前端卡死/崩溃后主动停播，前端同步状态。
        playbackLog("warn", `播放保护已停止：${String(payload.reason ?? "unknown")}`);
        activeNativeSourceRef.current = undefined;
        pendingNativeSourceRef.current = undefined;
        setPlaying(false);
        setPlaybackLoading(false);
        setBuffering(false);
        handlers.schedulePersistedSession(true);
      } else if (payload.type === "buffering" && typeof payload.buffering === "boolean") {
        setBuffering(payload.buffering);
      } else if (payload.type === "output-device-recovering") {
        if (payload.playing) {
          setPlaying(false);
          setPlaybackLoading(true);
        }
        setBuffering(false);
        playbackLog("warn", `音频输出正在恢复：${String(payload.reason ?? "unknown")}`);
      } else if (payload.type === "output-device-recovered") {
        const recoveredDeviceId = typeof payload.deviceId === "string"
          ? payload.deviceId
          : outputSinkIdRef.current;
        outputSinkIdRef.current = recoveredDeviceId;
        setOutputSinkIdState(recoveredDeviceId);
        writeOutputDevicePreference(recoveredDeviceId);
        if (payload.playing) {
          setPlaying(false);
          setPlaybackLoading(true);
        }
        setBuffering(false);
        playbackLog("info", `音频输出流已恢复：${recoveredDeviceId ? "所选设备" : "系统默认"}`);
      } else if (payload.type === "queue-item" && typeof payload.index === "number") {
        void handlers.loadAt(payload.index, true);
      } else if (payload.type === "track" && typeof payload.index === "number") {
        // Gapless handoff: Rust already queued and started the next source.
        // Mirror the UI without re-requesting a stream URL or reloading the
        // engine, otherwise the seamless PCM transition would be interrupted.
        const handedOffTrack = queueRef.current[payload.index];
        const pendingSource = pendingNativeSourceRef.current;
        if (!handedOffTrack || handedOffTrack.queueInstanceId !== payload.occurrenceId) {
          playbackLog("warn", "已忽略过期的原生无缝交接事件");
          return;
        }
        activeNativeSourceRef.current = pendingSource
          && pendingSource.index === payload.index
          && pendingSource.ratingKey === handedOffTrack?.ratingKey
          && pendingSource.queueInstanceId === payload.occurrenceId
          && pendingSource.queueInstanceId === handedOffTrack?.queueInstanceId
          ? pendingSource
          : undefined;
        pendingNativeSourceRef.current = undefined;
        indexRef.current = payload.index;
        setCurrentIndex(payload.index);
        progressRef.current = typeof payload.position === "number" && Number.isFinite(payload.position)
          ? Math.max(0, payload.position)
          : 0;
        setProgress(progressRef.current);
        if (typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration > 0) {
          setDuration(payload.duration);
        }
        setPlaying(true);
        setPlaybackLoading(false);
        setBuffering(false);
        setGaplessHandoffGeneration((generation) => generation + 1);
        handlers.schedulePersistedSession(true);
      } else if (payload.type === "remote") {
        const command = typeof payload.command === "string" ? payload.command : "";
        const navigation = queueNavigationAvailability(
          indexRef.current,
          queueRef.current.length,
          repeatRef.current,
          shuffleRef.current,
        );
        if (command === "play") { if (!playingRef.current) handlers.toggle(); }
        else if (command === "toggle") handlers.toggle();
        else if (command === "pause") { if (playingRef.current) handlers.toggle(); }
        else if (command === "next" && navigation.canNext) handlers.next();
        else if (command === "previous" && navigation.canPrevious) handlers.previous();
        else if (command === "seek" && typeof payload.position === "number") handlers.seek(payload.position);
      }
    }).then((disposeFn) => {
      if (disposed) disposeFn();
      else unlisten = disposeFn;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // Restoring a paused queue must not create the native audio engine. The
    // first CoreAudio device open is reserved for an explicit/user-confirmed
    // play; prebuffering starts only after Rust has reported real playback.
    if (!isDesktopRuntime() || !prebufferNext || !playing) return;
    const tracks = queueRef.current;
    if (!tracks.length || currentIndex < 0) return;
    if (!serverId) return;
    const requestId = ++nextSourceRequestRef.current;
    void (async () => {
      try {
        // Rust owns the queue decision. Using the same reserved shuffle
        // candidate for prefetch and natural advance prevents a random frontend
        // preview from disagreeing with the native gapless queue.
        const nextIndex = await nativeQueueBarrierRef.current!.enqueue(() => nativeQueuePeekNext(true));
        if (nextSourceRequestRef.current !== requestId || nextIndex == null) return;
        const nextTrack = tracks[nextIndex];
        if (!nextTrack) return;
        // Only Rust's actual next item gets a second segmented read head. Rust
        // queues it after its bounded PCM buffer is ready; no complete-file
        // download is required before the gapless handoff can be prepared.
        const artworkTicketPromise = playbackArtworkTicket(serverId, nextTrack);
        const attemptedQualities: StreamQuality[] = [];
        const diagnostics: string[] = [];
        let activeQuality: StreamQuality | undefined = quality;
        while (activeQuality) {
          let url = "";
          try {
            url = await requestStreamUrl(
              serverId,
              nextTrack,
              activeQuality,
              attemptedQualities.length > 0,
            );
            if (nextSourceRequestRef.current !== requestId) return;
            const nextCacheIdentity = nativeAudioCacheIdentity(
              serverId,
              nextTrack,
              nativeAudioCacheQuality(activeQuality, url),
            );
            await nativeAudioQueueNextSource(nextIndex, url, nextCacheIdentity, {
              title: nextTrack.title,
              artist: trackArtist(nextTrack),
              album: trackAlbum(nextTrack),
              durationMs: nextTrack.duration,
              artworkUrl: nextTrack.imageUrl,
            });
            if (nextSourceRequestRef.current !== requestId) return;
            const successfulQualities = [...attemptedQualities];
            appendAttemptedQuality(successfulQualities, activeQuality, sourceStreamQuality(url));
            pendingNativeSourceRef.current = {
              index: nextIndex,
              ratingKey: nextTrack.ratingKey,
              queueInstanceId: nextTrack.queueInstanceId || "",
              activeQuality,
              source: url,
              attemptedQualities: successfulQualities,
              diagnostics: [...diagnostics],
              runtimeRetryUsed: false,
            };
            if (!nextTrack.imageUrl) {
              void artworkTicketPromise.then((artworkTicket) => {
                if (!artworkTicket || nextSourceRequestRef.current !== requestId) return;
                return nativeAudioSetArtwork(
                  nextIndex,
                  nextTrack.ratingKey,
                  nextTrack.queueInstanceId || "",
                  artworkTicket,
                ).catch(() => undefined);
              });
            }
            break;
          } catch (reason) {
            if (nextSourceRequestRef.current !== requestId) return;
            diagnostics.push(`${activeQuality}: ${reason instanceof Error ? reason.message : String(reason)}`);
            appendAttemptedQuality(attemptedQualities, activeQuality, sourceStreamQuality(url));
            activeQuality = playbackFallbackQualities(
              quality,
              activeQuality,
              url,
              attemptedQualities,
            )[0];
            if (!activeQuality) throw new Error("下一首没有可用的兼容音源");
          }
        }
      } catch {
        // Prefetch is best-effort and never blocks ordinary playback fallback.
      }
    })();
    return () => {
      if (nextSourceRequestRef.current === requestId) {
        nextSourceRequestRef.current += 1;
      }
    };
  }, [currentIndex, gaplessHandoffGeneration, outputSinkId, playing, prebufferNext, quality, queue, repeat, requestStreamUrl, serverId, shuffle]);

  useEffect(() => {
    if (queueRef.current.length && queueServerIdRef.current === serverId) schedulePersistedSession(false);
  }, [quality, schedulePersistedSession, serverId]);

  useEffect(() => {
    if (isDesktopRuntime() || !playing || !current) return;
    const timer = window.setInterval(() => {
      setProgress((value) => {
        const nextValue = value + 1;
        progressRef.current = nextValue;
        schedulePersistedSession(false);
        if (duration && nextValue >= duration) advance(true);
        return nextValue;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [advance, current, duration, playing, schedulePersistedSession]);

  useEffect(() => {
    if (!current) return;
    const send = () => {
      const activeServerId = queueServerIdRef.current;
      const activeTrack = queueRef.current[indexRef.current];
      if (!activeServerId || activeTrack?.ratingKey !== current.ratingKey) return;
      void plexMusicGateway.playback.reportTimeline(activeServerId, current, playing ? "playing" : "paused", progressRef.current).catch(() => undefined);
    };
    send();
    if (!playing) return;
    const timer = window.setInterval(send, 10_000);
    return () => window.clearInterval(timer);
  }, [current, playing, serverId]);

  useEffect(() => {
    // The native MPNowPlayingInfoCenter/SMTC bridge is the sole desktop owner.
    // A concurrent WebKit MediaSession can overwrite its metadata and artwork.
    if (isDesktopRuntime() || !current || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: trackArtist(current),
      album: trackAlbum(current),
      artwork: current.imageUrl ? [{ src: current.imageUrl, sizes: "512x512" }] : undefined,
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [current, playing]);

  useEffect(() => {
    if (isDesktopRuntime() || !("mediaSession" in navigator)) return;
    const navigation = queueNavigationAvailability(currentIndex, queue.length, repeat, shuffle);
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
      ["play", () => { if (!playing) toggle(); }],
      ["pause", () => { if (playing) toggle(); }],
      ["previoustrack", navigation.canPrevious ? previous : null],
      ["nexttrack", navigation.canNext ? next : null],
      ["seekto", (details) => details.seekTime != null && seek(details.seekTime)],
    ];
    for (const [action, handler] of actions) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* WebView capability varies. */ }
    }
    return () => {
      for (const [action] of actions) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* No-op. */ }
      }
    };
  }, [currentIndex, next, playing, previous, queue.length, repeat, seek, shuffle, toggle]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("tray-player-toggle", () => nativeEventHandlersRef.current.toggle()).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("app://before-exit", () => {
      flushPlaybackSession();
      void acknowledgeQuit().catch(() => undefined);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushPlaybackSession]);

  return useMemo(() => ({
    queue,
    current,
    currentIndex,
    playing,
    loading,
    buffering,
    progress,
    duration,
    volume,
    muted,
    shuffle,
    repeat,
    prebufferNext,
    outputSinkId,
    error,
    playbackFailure,
    retryCurrent,
    dismissPlaybackFailure,
    playContext,
    playTracks,
    appendTracks,
    insertTracksNext,
    toggle,
    next,
    previous,
    seek,
    setVolume,
    setMuted,
    setShuffle,
    setRepeat,
    setPrebufferNext,
    setOutputSinkId,
    removeFromQueue,
    clearQueue,
    flushPlaybackSession,
    discardPlaybackSession,
    clearPlaybackAndCache,
    }), [appendTracks, buffering, clearPlaybackAndCache, clearQueue, current, currentIndex, discardPlaybackSession, dismissPlaybackFailure, duration, error, flushPlaybackSession, insertTracksNext, loading, muted, next, outputSinkId, playContext, playTracks, playbackFailure, playing, prebufferNext, previous, progress, queue, removeFromQueue, repeat, retryCurrent, seek, setMuted, setOutputSinkId, setPrebufferNext, setVolume, shuffle, toggle, volume]);
}

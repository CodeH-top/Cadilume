import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acknowledgeQuit, isDesktopRuntime } from "./api";
import { plexMusicGateway } from "./musicGateway";
import { usableDurationSeconds } from "./playerUi";
import { trackAlbum, trackArtist, type PlexContributor, type PlexItem, type StreamQuality } from "./types";

export type RepeatMode = "off" | "all" | "one";

const VOLUME_STORAGE_KEY = "cadilume-volume";
const PREBUFFER_STORAGE_KEY = "cadilume-prebuffer-next";
const OUTPUT_SINK_STORAGE_KEY = "cadilume-output-sink-id";
export const PLAYBACK_SESSION_STORAGE_KEY = "cadilume-playback-session";
export const PLAYBACK_SESSION_VERSION = 1 as const;
export const PLAYBACK_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PLAYBACK_SESSION_MAX_QUEUE = 500;
const PLAYBACK_SESSION_WRITE_THROTTLE_MS = 5_000;
const PLAYBACK_CLOCK_PUBLISH_INTERVAL_MS = 50;
export const PLAYBACK_START_TIMEOUT_MS = 12_000;

const STREAM_QUALITY_VALUES: readonly StreamQuality[] = ["auto", "original", "320", "256", "192"];

/**
 * Only this deliberately small shape is written to localStorage. In
 * particular, it never contains a PMS access token or a resolved stream URL.
 */
export interface PersistedPlaybackTrack {
  ratingKey: string;
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

/** Plex paths are relative and must never be turned into persisted URLs. */
function safePersistedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2_048) return undefined;
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(value)) return undefined;
  if (/(?:x-plex-token|access[_-]?token|auth_token|\btoken\b)\s*(?:=|%3d)/iu.test(value)) return undefined;
  return value;
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
  const compactEntries = input.queue
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
    const restoredQueue = queue as PersistedPlaybackTrack[];
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
  const tracks = normalizeQueueBatch(incoming);
  if (!tracks.length) return { queue: [...queue], currentIndex, addedCount: 0, shouldStart: false };

  const nextQueue = [...queue, ...tracks];
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
  const tracks = normalizeQueueBatch(incoming);
  if (!tracks.length) return { queue: [...queue], currentIndex, addedCount: 0, shouldStart: false };

  if (!validQueueIndex(currentIndex, queue.length)) {
    return appendQueueBatch(queue, currentIndex, tracks);
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

/** Manual Next always advances within the current queue, wrapping at its end. */
export function getManualNextIndex(currentIndex: number, queueLength: number): number | null {
  if (!Number.isInteger(queueLength) || queueLength <= 0) return null;
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= queueLength) return 0;
  return (currentIndex + 1) % queueLength;
}

type RoutableAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export interface AudioPreparation {
  index: number;
  ratingKey: string;
  serverId: string;
  quality: StreamQuality;
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
  const value = Number.parseFloat(readStorage(VOLUME_STORAGE_KEY, "0.72"));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.72;
};

const storedPrebufferNext = (): boolean => readStorage(PREBUFFER_STORAGE_KEY, "true") !== "false";
const storedOutputSinkId = (): string => readStorage(OUTPUT_SINK_STORAGE_KEY, "");

const samePreparation = (left: AudioPreparation, right: AudioPreparation): boolean => (
  left.index === right.index
  && left.ratingKey === right.ratingKey
  && left.serverId === right.serverId
  && left.quality === right.quality
);

type MediaErrorDetails = Pick<MediaError, "code" | "message">;

export type FallbackStreamQuality = Exclude<StreamQuality, "auto" | "original">;

export interface PlaybackFallbackState {
  /** The setting that produced the current source. */
  requestedQuality: StreamQuality;
  /** The quality requested for the source currently assigned to Audio. */
  activeQuality: StreamQuality;
  /** Every logical/effective quality that has already failed. */
  attemptedQualities: StreamQuality[];
  /** A stream URL request that is already in flight. */
  pendingQuality?: FallbackStreamQuality;
}

export type PlaybackFallbackDecision =
  | { action: "retry"; quality: FallbackStreamQuality; state: PlaybackFallbackState }
  | { action: "wait"; state: PlaybackFallbackState }
  | { action: "stop"; state: PlaybackFallbackState };

export interface PlaybackFailure {
  message: string;
  technicalDetails: string;
  attemptedQualities: StreamQuality[];
}

export interface PlaybackRetryRequest {
  index: number;
  resumeProgress: number;
}

const MEDIA_ERROR_LABELS: Readonly<Record<number, string>> = {
  1: "播放被中止",
  2: "网络读取失败",
  3: "音频解码失败",
  4: "格式或来源不受支持",
};

function redactPlaybackErrorText(value: string): string {
  return value
    .replace(/\b(?:https?|file):\/\/[^\s<>"']+/giu, "[媒体地址已隐藏]")
    .replace(/((?:x-plex-token|access[_-]?token|token)\s*(?:=|%3d)\s*)[^&\s<>"']+/giu, "$1[已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

export function formatMediaError(error: MediaErrorDetails | null | undefined): string {
  if (!error) return "MediaError：浏览器未提供 code/message";
  const code = Number.isFinite(error.code) ? error.code : 0;
  const label = MEDIA_ERROR_LABELS[code] ?? "未知媒体错误";
  const message = redactPlaybackErrorText(error.message || "");
  return message
    ? `MediaError code ${code}（${label}）；message：${message}`
    : `MediaError code ${code}（${label}）；浏览器未提供 message`;
}

/**
 * Media events carry no request identity. Only a non-empty source that still
 * belongs to the active ticket may change playback state; WebKit can emit a
 * late error for an empty or replaced source during the first load.
 */
export function isCurrentPlaybackErrorSource(expectedSource: string, reportedSource: string): boolean {
  if (!expectedSource || !reportedSource) return false;
  try {
    return new URL(expectedSource, "http://localhost").href === new URL(reportedSource, "http://localhost").href;
  } catch {
    return expectedSource === reportedSource;
  }
}

export function sourceAlreadyUses320Kbps(source: string): boolean {
  return sourceStreamQuality(source) === "320";
}

function sourceStreamQuality(source: string): FallbackStreamQuality | undefined {
  if (!source) return undefined;
  try {
    const url = new URL(source, "http://localhost");
    for (const [name, value] of url.searchParams) {
      if (name.toLowerCase() === "maxaudiobitrate" && ["320", "256", "192"].includes(value)) {
        return value as FallbackStreamQuality;
      }
    }
  } catch {
    // An invalid media URL cannot expose a trustworthy public quality marker.
  }
  return undefined;
}

const FALLBACK_QUALITY_ORDER: readonly FallbackStreamQuality[] = ["320", "256", "192"];

export function createPlaybackFallbackState(requestedQuality: StreamQuality): PlaybackFallbackState {
  return {
    requestedQuality,
    activeQuality: requestedQuality,
    attemptedQualities: [],
  };
}

function appendAttemptedQualities(
  attempted: readonly StreamQuality[],
  ...qualities: Array<StreamQuality | undefined>
): StreamQuality[] {
  const result = [...attempted];
  for (const quality of qualities) {
    if (quality && !result.includes(quality)) result.push(quality);
  }
  return result;
}

function fallbackCandidates(
  state: PlaybackFallbackState,
  sourceQuality: FallbackStreamQuality | undefined,
): readonly FallbackStreamQuality[] {
  const activeQuality = sourceQuality
    ?? (FALLBACK_QUALITY_ORDER.includes(state.activeQuality as FallbackStreamQuality)
      ? state.activeQuality as FallbackStreamQuality
      : undefined);
  if (activeQuality) {
    const activeIndex = FALLBACK_QUALITY_ORDER.indexOf(activeQuality);
    return activeIndex < 0 ? [] : FALLBACK_QUALITY_ORDER.slice(activeIndex + 1);
  }
  return state.requestedQuality === "auto" || state.requestedQuality === "original"
    ? FALLBACK_QUALITY_ORDER
    : [];
}

/**
 * Select the next strictly bounded compatibility source. The source marker is
 * important for `auto`: a remote auto stream can already resolve to 320 kbps,
 * so retrying 320 would only issue a fresh ticket for the same source.
 */
export function decidePlaybackFallback(
  state: PlaybackFallbackState,
  source: string,
): PlaybackFallbackDecision {
  if (state.pendingQuality) return { action: "wait", state };

  const sourceQuality = sourceStreamQuality(source);
  const attemptedQualities = appendAttemptedQualities(
    state.attemptedQualities,
    state.activeQuality,
    sourceQuality,
  );
  const quality = fallbackCandidates(state, sourceQuality)
    .find((candidate) => !attemptedQualities.includes(candidate));
  if (!quality) {
    return { action: "stop", state: { ...state, attemptedQualities } };
  }
  return {
    action: "retry",
    quality,
    state: { ...state, attemptedQualities, pendingQuality: quality },
  };
}

/** Mark a resolved fallback URL as the active source before asking Audio to play it. */
export function activatePlaybackFallback(
  state: PlaybackFallbackState,
  quality: FallbackStreamQuality,
): PlaybackFallbackState {
  if (state.pendingQuality !== quality) return state;
  return { ...state, activeQuality: quality, pendingQuality: undefined };
}

/** A URL request can fail before Audio receives a source; consume it once and continue downward. */
export function rejectPendingPlaybackFallback(
  state: PlaybackFallbackState,
  quality: FallbackStreamQuality,
): PlaybackFallbackState {
  if (state.pendingQuality !== quality) return state;
  return {
    ...state,
    attemptedQualities: appendAttemptedQualities(state.attemptedQualities, quality),
    pendingQuality: undefined,
  };
}

/** Resolve a retry target from refs without losing an in-flight restored seek. */
export function createPlaybackRetryRequest(
  currentIndex: number,
  queueLength: number,
  progress: number,
  pendingResume: number | null,
): PlaybackRetryRequest | null {
  if (!validQueueIndex(currentIndex, queueLength)) return null;
  const requestedProgress = pendingResume ?? progress;
  return {
    index: currentIndex,
    resumeProgress: finiteNumber(requestedProgress) ? Math.max(0, requestedProgress) : 0,
  };
}

function formatPlaybackFailure(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return redactPlaybackErrorText(message) || "未知播放错误";
}

export function getPrebufferTargetIndex(
  currentIndex: number,
  queueLength: number,
  shuffle: boolean,
  repeat: RepeatMode,
): number | null {
  if (shuffle || repeat === "one" || currentIndex < 0 || queueLength < 2) return null;
  if (currentIndex + 1 < queueLength) return currentIndex + 1;
  return repeat === "all" ? 0 : null;
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

/** Update a loaded media element without letting an empty/transitioning source throw. */
export function setAudioCurrentTimeSafely(
  audio: Pick<HTMLAudioElement, "currentTime" | "src"> | null | undefined,
  seconds: number,
): boolean {
  if (!audio?.src || !finiteNumber(seconds) || seconds < 0) return false;
  try {
    audio.currentTime = seconds;
    return true;
  } catch {
    return false;
  }
}

/**
 * WebKit/Chromium can ignore currentTime assignments made before metadata is
 * available. Wait for loadedmetadata when restoring a persisted position.
 */
export async function seekAfterMetadata(
  audio: HTMLAudioElement,
  target: number | (() => number),
): Promise<void> {
  const readTarget = typeof target === "function" ? target : () => target;
  if (typeof target !== "function" && (!finiteNumber(target) || target <= 0)) return;
  const seek = () => {
    const latest = readTarget();
    if (!finiteNumber(latest) || latest < 0) return;
    setAudioCurrentTimeSafely(audio, boundedResumeSeconds(latest, audio.duration));
  };
  // Test doubles and older embedded WebViews may not expose readyState; an
  // immediate assignment is the least surprising fallback there.
  if (typeof audio.readyState !== "number" || audio.readyState >= 1 || finiteNumber(audio.duration)) {
    seek();
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("loadedmetadata", finish);
      audio.removeEventListener("durationchange", finish);
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      resolve();
    };
    timeout = globalThis.setTimeout(finish, 2_000);
    audio.addEventListener("loadedmetadata", finish, { once: true });
    audio.addEventListener("durationchange", finish, { once: true });
  });
  seek();
}

/**
 * `play()` can remain pending in WKWebView after a stale media error. Treat a
 * source as started only once it emits `playing` or advances its clock, so the
 * existing bounded compatibility fallback can recover instead of leaving the
 * first selected song silently loading forever.
 */
export function waitForAudioPlaybackStart(
  audio: Pick<HTMLAudioElement, "addEventListener" | "removeEventListener" | "play" | "currentTime">,
  timeoutMs = PLAYBACK_START_TIMEOUT_MS,
): Promise<void> {
  const initialTime = finiteNumber(audio.currentTime) ? audio.currentTime : 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: number | undefined;
    const cleanup = () => {
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    };
    const finish = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) {
        reject(reason instanceof Error ? reason : new Error(formatPlaybackFailure(reason)));
        return;
      }
      resolve();
    };
    const onPlaying = () => finish();
    const onTimeUpdate = () => {
      if (finiteNumber(audio.currentTime) && audio.currentTime > initialTime + 0.01) finish();
    };

    audio.addEventListener("playing", onPlaying, { once: true });
    audio.addEventListener("timeupdate", onTimeUpdate);
    timeout = globalThis.setTimeout(() => finish(new Error("播放启动超时")), Math.max(1, timeoutMs));
    try {
      void Promise.resolve(audio.play()).catch((reason) => finish(reason));
    } catch (reason) {
      finish(reason);
    }
  });
}

async function applyOutputSink(audios: readonly RoutableAudioElement[], sinkId: string): Promise<boolean> {
  const setters = audios.map((audio) => audio.setSinkId?.bind(audio));
  const resetToDefault = async () => {
    await Promise.allSettled(setters.map((setter) => setter?.("") ?? Promise.resolve()));
  };

  if (sinkId && setters.some((setter) => !setter)) {
    await resetToDefault();
    return false;
  }

  try {
    await Promise.all(setters.map((setter) => setter?.(sinkId) ?? Promise.resolve()));
    return true;
  } catch {
    await resetToDefault();
    return false;
  }
}

/**
 * Owns exactly two media elements. Only `active` is allowed to update player
 * state; the other element can resolve and buffer the next deterministic track.
 */
export class DualAudioPool {
  readonly elements: readonly [RoutableAudioElement, RoutableAudioElement];
  private activeIndex = 0;
  private prepared?: AudioPreparation & { audio: RoutableAudioElement; url: string };

  constructor(elements: [HTMLAudioElement, HTMLAudioElement]) {
    this.elements = elements as [RoutableAudioElement, RoutableAudioElement];
    for (const audio of this.elements) {
      audio.preload = "auto";
    }
  }

  get active(): RoutableAudioElement {
    return this.elements[this.activeIndex];
  }

  get standby(): RoutableAudioElement {
    return this.elements[this.activeIndex === 0 ? 1 : 0];
  }

  isActive(audio: HTMLAudioElement): boolean {
    return audio === this.active;
  }

  setGain(volume: number, muted: boolean): void {
    for (const audio of this.elements) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }

  hasPrepared(preparation: AudioPreparation): boolean {
    return Boolean(this.prepared && samePreparation(this.prepared, preparation));
  }

  prepare(preparation: AudioPreparation, url: string): RoutableAudioElement {
    this.cancelPrepared();
    const audio = this.standby;
    audio.pause();
    audio.src = url;
    this.prepared = { ...preparation, audio, url };
    audio.load();
    return audio;
  }

  takePrepared(preparation: AudioPreparation): RoutableAudioElement | null {
    if (!this.prepared || !samePreparation(this.prepared, preparation)) return null;
    const next = this.prepared.audio;
    const previous = this.active;
    this.prepared = undefined;
    this.activeIndex = next === this.elements[0] ? 0 : 1;

    // activeIndex changes before pause/load so listeners can ignore the old slot.
    previous.pause();
    previous.removeAttribute("src");
    previous.load();
    return next;
  }

  cancelPrepared(): void {
    const prepared = this.prepared;
    this.prepared = undefined;
    if (!prepared || prepared.audio === this.active) return;
    prepared.audio.pause();
    prepared.audio.removeAttribute("src");
    prepared.audio.load();
  }

  discardPreparedAudio(audio: HTMLAudioElement): boolean {
    if (!this.prepared || this.prepared.audio !== audio) return false;
    this.cancelPrepared();
    return true;
  }

  setOutputSinkId(sinkId: string): Promise<boolean> {
    return applyOutputSink(this.elements, sinkId);
  }

  clearSources(): void {
    this.prepared = undefined;
    for (const audio of this.elements) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }

  destroy(): void {
    this.clearSources();
  }
}

export function usePlayer(serverId: string | undefined, quality: StreamQuality) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioPoolRef = useRef<DualAudioPool | null>(null);
  const queueRef = useRef<PlexItem[]>([]);
  const indexRef = useRef(-1);
  const endedRef = useRef<() => void>(() => undefined);
  const progressRef = useRef(0);
  const scrobbledRef = useRef(new Set<string>());
  const playbackFallbackRef = useRef<PlaybackFallbackState>(createPlaybackFallbackState(quality));
  const playbackFailureHandlerRef = useRef<(diagnostic: string, source: string) => boolean>(() => false);
  const activePlaybackSourceRef = useRef<{ audio: RoutableAudioElement; requestId: number; source: string } | undefined>(undefined);
  const playbackLoadingRef = useRef(false);
  const loadRequestRef = useRef(0);
  const prebufferRequestRef = useRef(0);
  const outputSinkRequestRef = useRef(0);
  const outputSinkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const serverIdRef = useRef(serverId);
  const qualityRef = useRef(quality);
  const queueServerIdRef = useRef<string | undefined>(undefined);
  const shuffleNavigationRef = useRef<ShuffleNavigationState>(createShuffleNavigationState(0, -1));
  const resumeProgressRef = useRef<number | null>(null);
  const restoredServerRef = useRef<string | undefined>(undefined);
  const persistedSessionTimerRef = useRef<number | undefined>(undefined);
  const playbackSessionDiscardedRef = useRef(false);
  const [initialPersistedSession] = useState<PersistedPlaybackSession | null>(() => readPersistedPlaybackSession());
  const [queue, setQueue] = useState<PlexItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoadingState] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(storedVolume);
  const [muted, setMuted] = useState(false);
  // A resumed playlist loops by default so ending it cannot unexpectedly
  // advance into another context. Existing users can still switch to off.
  const [shuffle, setShuffleState] = useState(() => initialPersistedSession?.shuffle ?? false);
  const [repeat, setRepeatState] = useState<RepeatMode>(() => initialPersistedSession?.repeat ?? "all");
  const [prebufferNext, setPrebufferNextState] = useState(storedPrebufferNext);
  const [outputSinkId, setOutputSinkIdState] = useState(storedOutputSinkId);
  const [error, setError] = useState<string>();
  const [playbackFailure, setPlaybackFailure] = useState<PlaybackFailure>();
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const outputSinkIdRef = useRef(outputSinkId);

  serverIdRef.current = serverId;
  qualityRef.current = quality;
  volumeRef.current = volume;
  mutedRef.current = muted;
  shuffleRef.current = shuffle;
  repeatRef.current = repeat;
  outputSinkIdRef.current = outputSinkId;

  const setPlaybackLoading = useCallback((value: boolean) => {
    playbackLoadingRef.current = value;
    setLoadingState(value);
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

  const loadAt = useCallback(async (
    index: number,
    autoplay = true,
    requestedResume?: number,
    forceFreshTicket = false,
  ) => {
    const tracks = queueRef.current;
    const track = tracks[index];
    if (!track || !serverId) return;
    const requestId = ++loadRequestRef.current;
    activePlaybackSourceRef.current = undefined;
    setPlaybackLoading(autoplay);
    setBuffering(false);
    prebufferRequestRef.current += 1;
    indexRef.current = index;
    setCurrentIndex(index);
    const resumeSeconds = boundedResumeSeconds(requestedResume ?? 0, (track.duration || 0) / 1000);
    resumeProgressRef.current = resumeSeconds;
    setProgress(resumeSeconds);
    progressRef.current = resumeSeconds;
    setDuration((track.duration || 0) / 1000);
    setError(undefined);
    setPlaybackFailure(undefined);
    playbackFallbackRef.current = createPlaybackFallbackState(quality);
    queueServerIdRef.current = serverId;
    schedulePersistedSession(true);

    if (!isDesktopRuntime()) {
      resumeProgressRef.current = null;
      setPlaybackLoading(false);
      setPlaying(autoplay);
      return;
    }

    const finishCurrentLoad = () => {
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      setPlaybackLoading(false);
      setBuffering(false);
    };

    const preparation: AudioPreparation = {
      index,
      ratingKey: track.ratingKey,
      serverId,
      quality,
    };
    const pool = audioPoolRef.current;

    let assignedSource = "";
    try {
      if (!forceFreshTicket) {
        const preparedAudio = pool?.takePrepared(preparation);
        if (preparedAudio) {
          audioRef.current = preparedAudio;
          assignedSource = preparedAudio.currentSrc || preparedAudio.src;
          activePlaybackSourceRef.current = { audio: preparedAudio, requestId, source: assignedSource };
          await seekAfterMetadata(preparedAudio, () => resumeProgressRef.current ?? progressRef.current);
          if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
          resumeProgressRef.current = null;
          if (autoplay) await waitForAudioPlaybackStart(preparedAudio);
          else setPlaying(false);
          finishCurrentLoad();
          return;
        }
      }

      pool?.cancelPrepared();
      const audio = pool?.active ?? audioRef.current;
      if (!audio) {
        finishCurrentLoad();
        return;
      }
      audio.pause();
      if (!autoplay) setPlaying(false);

      const url = await plexMusicGateway.playback.streamUrl(serverId, track, quality);
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      activePlaybackSourceRef.current = { audio, requestId, source: url };
      audio.src = url;
      assignedSource = url;
      audio.load();
      await seekAfterMetadata(audio, () => resumeProgressRef.current ?? progressRef.current);
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      resumeProgressRef.current = null;
      if (autoplay) await waitForAudioPlaybackStart(audio);
      finishCurrentLoad();
    } catch (reason) {
      if (requestId !== loadRequestRef.current) return;
      const audio = audioRef.current;
      const diagnostic = assignedSource && audio?.error
        ? formatMediaError(audio.error)
        : formatPlaybackFailure(reason);
      if (!playbackFailureHandlerRef.current(diagnostic, assignedSource)) {
        const message = `音频无法播放（${diagnostic}）。`;
        setPlaybackLoading(false);
        setBuffering(false);
        setPlaying(false);
        setError(message);
        setPlaybackFailure({ message, technicalDetails: diagnostic, attemptedQualities: [quality] });
      }
    }
  }, [quality, schedulePersistedSession, serverId, setPlaybackLoading]);

  const retryCurrent = useCallback(() => {
    const retry = createPlaybackRetryRequest(
      indexRef.current,
      queueRef.current.length,
      progressRef.current,
      resumeProgressRef.current,
    );
    if (!retry) return;
    // `loadAt` synchronously advances the request id before its first await,
    // so older ticket/fallback promises cannot overwrite this fresh retry.
    void loadAt(retry.index, true, retry.resumeProgress, true);
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
    const tracks = playable.some((item) => item.ratingKey === track.ratingKey) ? playable : [track, ...playable];
    const index = Math.max(0, tracks.findIndex((item) => item.ratingKey === track.ratingKey));
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
    const tracks = normalizeQueueBatch(incoming);
    if (!tracks.length) return false;
    queueRef.current = tracks;
    queueServerIdRef.current = serverIdRef.current;
    resumeProgressRef.current = null;
    shuffleNavigationRef.current = createShuffleNavigationState(tracks.length, 0);
    prebufferRequestRef.current += 1;
    audioPoolRef.current?.cancelPrepared();
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
    prebufferRequestRef.current += 1;
    audioPoolRef.current?.cancelPrepared();
    setQueue(transition.queue);
    setCurrentIndex(transition.currentIndex);
    if (transition.shouldStart) {
      resumeProgressRef.current = null;
      progressRef.current = 0;
      setProgress(0);
    }
    schedulePersistedSession(true);
    if (transition.shouldStart) void loadAt(transition.currentIndex, true);
    return true;
  }, [loadAt, schedulePersistedSession]);

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
      setPlaybackLoading(false);
      setBuffering(false);
      setPlaying(false);
      schedulePersistedSession(true);
    }
  }, [loadAt, schedulePersistedSession]);

  const next = useCallback(() => {
    void advance(false);
  }, [advance]);

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if ((audio && audio.currentTime > 4) || (!audio?.src && progressRef.current > 4)) {
      const applied = setAudioCurrentTimeSafely(audio, 0);
      resumeProgressRef.current = applied ? null : 0;
      progressRef.current = 0;
      setProgress(0);
      schedulePersistedSession(true);
      return;
    }
    if (shuffleRef.current) {
      const previousSelection = moveShufflePrevious(
        shuffleNavigationRef.current,
        queueRef.current.length,
        indexRef.current,
      );
      shuffleNavigationRef.current = previousSelection.state;
      if (previousSelection.index != null) void loadAt(previousSelection.index, true);
      return;
    }
    if (indexRef.current > 0) void loadAt(indexRef.current - 1, true);
    else if ((repeatRef.current === "all" || repeatRef.current === "one") && queueRef.current.length) {
      void loadAt(queueRef.current.length - 1, true);
    }
  }, [loadAt, schedulePersistedSession]);

  const toggle = useCallback(() => {
    if (!current || playbackLoadingRef.current) return;
    if (!isDesktopRuntime()) {
      setPlaying((value) => !value);
      schedulePersistedSession(true);
      return;
    }
    const audio = audioRef.current;
    if (!audio || !audio.src) {
      void loadAt(indexRef.current >= 0 ? indexRef.current : currentIndex, true, resumeProgressRef.current ?? progressRef.current);
      return;
    }
    if (audio.paused) {
      if (audio.ended || (duration > 0 && audio.currentTime >= duration)) {
        void loadAt(indexRef.current >= 0 ? indexRef.current : currentIndex, true, 0);
      } else {
        void audio.play();
      }
    } else audio.pause();
  }, [current, currentIndex, duration, loadAt, schedulePersistedSession]);

  const seek = useCallback((seconds: number) => {
    const maximum = duration || (current?.duration || 0) / 1000;
    const requested = finiteNumber(seconds) ? seconds : 0;
    const bounded = maximum > 0 ? Math.max(0, Math.min(maximum, requested)) : Math.max(0, requested);
    // Save first: restored sessions deliberately have an Audio element without
    // a source, and some WebViews throw when currentTime is set in that state.
    resumeProgressRef.current = bounded;
    progressRef.current = bounded;
    setProgress(bounded);
    if (setAudioCurrentTimeSafely(audioRef.current, bounded)) resumeProgressRef.current = null;
    schedulePersistedSession(false);
  }, [current?.duration, duration, schedulePersistedSession]);

  const setVolume = useCallback((value: number) => {
    const normalized = Math.min(1, Math.max(0, value));
    setVolumeState(normalized);
    setMuted(false);
    writeStorage(VOLUME_STORAGE_KEY, String(normalized));
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
    schedulePersistedSession(false);
  }, [schedulePersistedSession]);

  const setRepeat = useCallback((mode: RepeatMode) => {
    const normalized: RepeatMode = mode === "one" || mode === "all" ? mode : "off";
    repeatRef.current = normalized;
    setRepeatState(normalized);
    schedulePersistedSession(false);
  }, [schedulePersistedSession]);

  const setOutputSinkId = useCallback((sinkId: string): Promise<boolean> => {
    const normalized = sinkId || "";
    const requestId = ++outputSinkRequestRef.current;
    const operation = outputSinkQueueRef.current.then(async () => {
      const pool = audioPoolRef.current;
      const applied = pool ? await pool.setOutputSinkId(normalized) : normalized === "";
      if (requestId === outputSinkRequestRef.current) {
        const selected = applied ? normalized : "";
        outputSinkIdRef.current = selected;
        setOutputSinkIdState(selected);
        writeStorage(OUTPUT_SINK_STORAGE_KEY, selected);
      }
      return applied;
    });
    outputSinkQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
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
    schedulePersistedSession(true);
  }, [resetShuffleState, schedulePersistedSession]);

  useEffect(() => {
    let disposed = false;
    const previousQueueServerId = queueServerIdRef.current;
    if (previousQueueServerId && previousQueueServerId !== serverId) {
      // Persist with the queue's owner before `serverIdRef`/UI context can make
      // the old session look like it belongs to the newly selected PMS.
      flushPlaybackSession();
      loadRequestRef.current += 1;
      prebufferRequestRef.current += 1;
      queueRef.current = [];
      queueServerIdRef.current = undefined;
      indexRef.current = -1;
      progressRef.current = 0;
      resumeProgressRef.current = null;
      shuffleNavigationRef.current = createShuffleNavigationState(0, -1);
      scrobbledRef.current.clear();
      playbackFallbackRef.current = createPlaybackFallbackState(qualityRef.current);
      const pool = audioPoolRef.current;
      pool?.clearSources();
      if (pool) audioRef.current = pool.active;
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

    const restoredQueue = persisted.queue.map((item) => ({ ...item })) as PlexItem[];
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

  useEffect(() => {
    const pool = new DualAudioPool([new Audio(), new Audio()]);
    audioPoolRef.current = pool;
    audioRef.current = pool.active;
    pool.setGain(volumeRef.current, mutedRef.current);
    let disposed = false;

    const isRetryCurrent = (
      audio: RoutableAudioElement,
      requestId: number,
      activeServerId: string,
      ratingKey: string,
    ) => (
      !disposed
      && audioPoolRef.current === pool
      && pool.isActive(audio)
      && loadRequestRef.current === requestId
      && queueServerIdRef.current === activeServerId
      && queueRef.current[indexRef.current]?.ratingKey === ratingKey
    );

    const handlePlaybackFailure = (
      audio: RoutableAudioElement,
      diagnostic: string,
      source: string,
    ): boolean => {
      if (disposed || audioPoolRef.current !== pool || !pool.isActive(audio)) return false;
      const track = queueRef.current[indexRef.current];
      const activeServerId = queueServerIdRef.current;
      if (!track || !activeServerId) return false;

      const decision = decidePlaybackFallback(playbackFallbackRef.current, source);
      playbackFallbackRef.current = decision.state;
      if (decision.action === "wait") return true;

      if (decision.action === "stop") {
        const attemptedQualities = decision.state.attemptedQualities;
        const attemptedLabel = attemptedQualities
          .map((attemptedQuality) => {
            if (attemptedQuality === "auto") return "自动源";
            if (attemptedQuality === "original") return "原始质量";
            return `${attemptedQuality} kbps`;
          })
          .join("、");
        const message = `音频无法播放（${diagnostic}）。${attemptedLabel ? `已尝试 ${attemptedLabel}；` : ""}请检查远程连接或服务器转码状态。`;
        setPlaybackLoading(false);
        setBuffering(false);
        setPlaying(false);
        schedulePersistedSession(true);
        setError(message);
        setPlaybackFailure({ message, technicalDetails: diagnostic, attemptedQualities });
        return true;
      }

      setPlaybackLoading(true);
      setBuffering(false);
      setPlaying(false);
      setPlaybackFailure(undefined);
      setError(`音频播放失败（${diagnostic}），正在自动切换到 ${decision.quality} kbps 兼容串流…`);
      const ratingKey = track.ratingKey;
      const retryLoadRequest = loadRequestRef.current;
      const fallbackQuality = decision.quality;
      let fallbackAssigned = false;
      const isActiveFallback = () => {
        const fallbackState = playbackFallbackRef.current;
        return isRetryCurrent(audio, retryLoadRequest, activeServerId, ratingKey)
          && fallbackState.activeQuality === fallbackQuality
          && fallbackState.pendingQuality === undefined;
      };
      void plexMusicGateway.playback.streamUrl(activeServerId, track, fallbackQuality)
        .then(async (url) => {
          if (!isRetryCurrent(audio, retryLoadRequest, activeServerId, ratingKey)) return;
          if (playbackFallbackRef.current.pendingQuality !== fallbackQuality) return;
          activePlaybackSourceRef.current = { audio, requestId: retryLoadRequest, source: url };
          audio.src = url;
          fallbackAssigned = true;
          playbackFallbackRef.current = activatePlaybackFallback(playbackFallbackRef.current, fallbackQuality);
          audio.load();
          await seekAfterMetadata(audio, () => resumeProgressRef.current ?? progressRef.current);
          if (!isActiveFallback()) return;
          resumeProgressRef.current = null;
          await waitForAudioPlaybackStart(audio);
          if (!isActiveFallback()) return;
          setPlaybackLoading(false);
          setBuffering(false);
          setError(undefined);
          setPlaybackFailure(undefined);
        })
        .catch((reason) => {
          if (!isRetryCurrent(audio, retryLoadRequest, activeServerId, ratingKey)) return;
          if (!fallbackAssigned) {
            playbackFallbackRef.current = rejectPendingPlaybackFallback(
              playbackFallbackRef.current,
              fallbackQuality,
            );
          }
          const retryDiagnostic = fallbackAssigned && audio.error
            ? formatMediaError(audio.error)
            : formatPlaybackFailure(reason);
          handlePlaybackFailure(
            audio,
            retryDiagnostic,
            fallbackAssigned ? audio.currentSrc || audio.src : "",
          );
        });
      return true;
    };

    const dispatchPlaybackFailure = (diagnostic: string, source: string): boolean => (
      handlePlaybackFailure(pool.active, diagnostic, source)
    );
    playbackFailureHandlerRef.current = dispatchPlaybackFailure;

    const bindEvents = (audio: RoutableAudioElement) => {
      const isCurrent = () => audioPoolRef.current === pool && pool.isActive(audio);
      const updateTime = () => {
        if (!isCurrent()) return;
        progressRef.current = audio.currentTime || 0;
        setProgress(audio.currentTime || 0);
        setDuration(usableDurationSeconds(
          audio.duration,
          (queueRef.current[indexRef.current]?.duration || 0) / 1000,
        ));
        schedulePersistedSession(false);
        const track = queueRef.current[indexRef.current];
        const activeServerId = queueServerIdRef.current;
        const scrobbleKey = activeServerId && track ? `${activeServerId}:${track.ratingKey}` : undefined;
        if (track && activeServerId && scrobbleKey && audio.duration > 0 && audio.currentTime / audio.duration >= 0.9 && !scrobbledRef.current.has(scrobbleKey)) {
          scrobbledRef.current.add(scrobbleKey);
          void plexMusicGateway.playback.scrobble(activeServerId, track);
        }
      };
      const onPlay = () => {
        if (isCurrent()) {
          setPlaying(true);
          setError(undefined);
          setPlaybackFailure(undefined);
        }
      };
      const onPlaying = () => {
        if (!isCurrent()) return;
        setPlaybackLoading(false);
        setBuffering(false);
      };
      const onWaiting = () => {
        if (isCurrent() && !audio.paused && !audio.ended) setBuffering(true);
      };
      const onStalled = () => {
        if (isCurrent() && !audio.paused && !audio.ended && audio.readyState < 3) setBuffering(true);
      };
      const onPause = () => {
        if (isCurrent()) {
          setBuffering(false);
          setPlaying(false);
          schedulePersistedSession(true);
        }
      };
      const onEnded = () => {
        if (!isCurrent()) return;
        setPlaybackLoading(false);
        setBuffering(false);
        endedRef.current();
      };
      const onError = () => {
        if (!isCurrent()) {
          pool.discardPreparedAudio(audio);
          return;
        }
        const source = audio.currentSrc || audio.src;
        const activeSource = activePlaybackSourceRef.current;
        if (
          !activeSource
          || activeSource.audio !== audio
          || activeSource.requestId !== loadRequestRef.current
          || !isCurrentPlaybackErrorSource(activeSource.source, source)
        ) return;
        handlePlaybackFailure(audio, formatMediaError(audio.error), source);
      };

      audio.addEventListener("timeupdate", updateTime);
      audio.addEventListener("durationchange", updateTime);
      audio.addEventListener("play", onPlay);
      audio.addEventListener("playing", onPlaying);
      audio.addEventListener("waiting", onWaiting);
      audio.addEventListener("stalled", onStalled);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      return () => {
        audio.removeEventListener("timeupdate", updateTime);
        audio.removeEventListener("durationchange", updateTime);
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("waiting", onWaiting);
        audio.removeEventListener("stalled", onStalled);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
      };
    };

    const disposeEvents = pool.elements.map(bindEvents);
    const initialSinkId = outputSinkIdRef.current;
    const initialSinkOperation = outputSinkQueueRef.current.then(() => pool.setOutputSinkId(initialSinkId));
    outputSinkQueueRef.current = initialSinkOperation.then(() => undefined, () => undefined);
    void initialSinkOperation.then((applied) => {
      if (disposed || applied || outputSinkIdRef.current !== initialSinkId || !initialSinkId) return;
      outputSinkIdRef.current = "";
      setOutputSinkIdState("");
      writeStorage(OUTPUT_SINK_STORAGE_KEY, "");
    });

    return () => {
      disposed = true;
      loadRequestRef.current += 1;
      prebufferRequestRef.current += 1;
      outputSinkRequestRef.current += 1;
      flushPlaybackSession();
      if (playbackFailureHandlerRef.current === dispatchPlaybackFailure) {
        playbackFailureHandlerRef.current = () => false;
      }
      for (const dispose of disposeEvents) dispose();
      pool.destroy();
      if (activePlaybackSourceRef.current && pool.elements.includes(activePlaybackSourceRef.current.audio)) {
        activePlaybackSourceRef.current = undefined;
      }
      if (audioPoolRef.current === pool) audioPoolRef.current = null;
      if (audioRef.current && pool.elements.includes(audioRef.current as RoutableAudioElement)) audioRef.current = null;
    };
  }, [flushPlaybackSession, schedulePersistedSession, setPlaybackLoading]);

  useEffect(() => {
    endedRef.current = () => { void advance(true); };
  }, [advance]);

  useEffect(() => {
    if (!isDesktopRuntime() || !playing || currentIndex < 0) return;
    let animationFrame = 0;
    let lastPublishedAt = Number.NEGATIVE_INFINITY;
    const publishPlaybackClock = (timestamp: number) => {
      const pool = audioPoolRef.current;
      const audio = pool?.active;
      if (audio && pool?.isActive(audio) && timestamp - lastPublishedAt >= PLAYBACK_CLOCK_PUBLISH_INTERVAL_MS) {
        lastPublishedAt = timestamp;
        const nextProgress = audio.currentTime;
        if (Number.isFinite(nextProgress) && Math.abs(nextProgress - progressRef.current) >= 0.01) {
          progressRef.current = nextProgress;
          setProgress(nextProgress);
        }
      }
      animationFrame = window.requestAnimationFrame(publishPlaybackClock);
    };
    animationFrame = window.requestAnimationFrame(publishPlaybackClock);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [currentIndex, playing]);

  useEffect(() => {
    audioPoolRef.current?.setGain(volume, muted);
  }, [muted, volume]);

  useEffect(() => {
    if (queueRef.current.length && queueServerIdRef.current === serverId) schedulePersistedSession(false);
  }, [quality, schedulePersistedSession, serverId]);

  useEffect(() => {
    const requestId = ++prebufferRequestRef.current;
    const pool = audioPoolRef.current;
    const playbackServerId = queueServerIdRef.current;
    if (!prebufferNext || !pool || !playbackServerId || playbackServerId !== serverId || !isDesktopRuntime()) {
      pool?.cancelPrepared();
      return;
    }

    let nextIndex: number | null = null;
    if (shuffle && queue.length > 1) {
      const preview = previewShuffleNext(
        shuffleNavigationRef.current,
        queue.length,
        currentIndex,
        repeat,
      );
      shuffleNavigationRef.current = preview.state;
      nextIndex = preview.index;
    } else {
      nextIndex = getPrebufferTargetIndex(currentIndex, queue.length, false, repeat);
    }
    const nextTrack = nextIndex == null ? undefined : queue[nextIndex];

    if (nextIndex == null || !nextTrack) {
      pool.cancelPrepared();
      return;
    }

    const preparation: AudioPreparation = {
      index: nextIndex,
      ratingKey: nextTrack.ratingKey,
      serverId: playbackServerId,
      quality,
    };
    if (pool.hasPrepared(preparation)) return;
    pool.cancelPrepared();

    void plexMusicGateway.playback.streamUrl(playbackServerId, nextTrack, quality)
      .then((url) => {
        if (
          prebufferRequestRef.current !== requestId
          || audioPoolRef.current !== pool
          || indexRef.current !== currentIndex
          || queueServerIdRef.current !== playbackServerId
          || queueRef.current[nextIndex]?.ratingKey !== nextTrack.ratingKey
        ) return;
        pool.prepare(preparation, url);
        pool.setGain(volumeRef.current, mutedRef.current);
      })
      .catch(() => undefined);

    return () => {
      if (prebufferRequestRef.current === requestId) prebufferRequestRef.current += 1;
    };
  }, [currentIndex, prebufferNext, quality, queue, repeat, serverId, shuffle]);

  useEffect(() => {
    if (isDesktopRuntime() || !playing || !current) return;
    const timer = window.setInterval(() => {
      setProgress((value) => {
        const nextValue = value + 1;
        progressRef.current = nextValue;
        schedulePersistedSession(false);
        if (duration && nextValue >= duration) endedRef.current();
        return nextValue;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [current, duration, playing, schedulePersistedSession]);

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
    if (!current || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: trackArtist(current),
      album: trackAlbum(current),
      artwork: current.imageUrl ? [{ src: current.imageUrl, sizes: "512x512" }] : undefined,
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [current, playing]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
      ["play", () => { if (!playing) toggle(); }],
      ["pause", () => { if (playing) toggle(); }],
      ["previoustrack", previous],
      ["nexttrack", next],
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
  }, [next, playing, previous, seek, toggle]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("tray-player-toggle", toggle).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [toggle]);

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
    flushPlaybackSession,
    discardPlaybackSession,
  }), [appendTracks, buffering, current, currentIndex, discardPlaybackSession, dismissPlaybackFailure, duration, error, flushPlaybackSession, insertTracksNext, loading, muted, next, outputSinkId, playContext, playTracks, playbackFailure, playing, prebufferNext, previous, progress, queue, removeFromQueue, repeat, retryCurrent, seek, setOutputSinkId, setPrebufferNext, setVolume, shuffle, toggle, volume]);
}

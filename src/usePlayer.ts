import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acknowledgeQuit, artworkUrl, isDesktopRuntime, nativeAudioLoad, nativeAudioPause, nativeAudioPlay, nativeAudioPrecache, nativeAudioQueueNextSource, nativeAudioSeek, nativeAudioSetOutputDevice, nativeAudioSetVolume, nativeAudioStatus, nativeAudioStop, nativeQueueNext, nativeQueuePrevious, nativeQueueSet, nativeQueueSetRepeat, nativeQueueSetShuffle } from "./api";
import { plexMusicGateway } from "./musicGateway";
import { playbackLog } from "./playbackLog";
import { trackAlbum, trackArtist, type PlexContributor, type PlexItem, type StreamQuality } from "./types";

export type RepeatMode = "off" | "all" | "one";

const VOLUME_STORAGE_KEY = "cadilume-volume";
const PREBUFFER_STORAGE_KEY = "cadilume-prebuffer-next";
const OUTPUT_SINK_STORAGE_KEY = "cadilume-output-sink-id";
export const PLAYBACK_SESSION_STORAGE_KEY = "cadilume-playback-session";
export const PLAYBACK_SESSION_VERSION = 1 as const;
export const PLAYBACK_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PLAYBACK_SESSION_MAX_QUEUE = 500;
const NATIVE_ENGINE_STORAGE_KEY = "cadilume-native-engine";
const PLAYBACK_SESSION_WRITE_THROTTLE_MS = 5_000;
export const PLAYBACK_START_TIMEOUT_MS = 12_000;
/** Keep the transport button visibly busy during quick prebuffered switches. */
const MIN_LOADING_VISIBLE_MS = 250;
/** Reuse an in-flight stream ticket briefly so bursty track switching does not
 *  issue a second PMS connection for the same track/quality. */
const STREAM_URL_INFLIGHT_CACHE_MS = 5_000;

const STREAM_QUALITY_VALUES: readonly StreamQuality[] = ["auto", "original", "320", "256", "192"];

/** Native engine is on by default; set the storage key to "0" to fall back to WebView audio. */
export function nativeEngineEnabled(): boolean {
  try {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(NATIVE_ENGINE_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

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
const storedOutputSinkId = (): string => readStorage(OUTPUT_SINK_STORAGE_KEY, "");

export type FallbackStreamQuality = Exclude<StreamQuality, "auto" | "original">;

export interface PlaybackFailure {
  message: string;
  technicalDetails: string;
  attemptedQualities: StreamQuality[];
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
  const precacheRequestRef = useRef(0);
  const serverIdRef = useRef(serverId);
  const qualityRef = useRef(quality);
  const queueServerIdRef = useRef<string | undefined>(undefined);
  const shuffleNavigationRef = useRef<ShuffleNavigationState>(createShuffleNavigationState(0, -1));
  const resumeProgressRef = useRef<number | null>(null);
  const restoredServerRef = useRef<string | undefined>(undefined);
  const persistedSessionTimerRef = useRef<number | undefined>(undefined);
  const playbackSessionDiscardedRef = useRef(false);
  const [initialPersistedSession] = useState<PersistedPlaybackSession | null>(() => readPersistedPlaybackSession());
  // 首帧就从持久化会话渲染队列/进度/时长，避免恢复 effect 等待
  // serverId/bootstrap 期间播放器显示空白；恢复 effect 仍会复核并刷新元数据。
  const [queue, setQueue] = useState<PlexItem[]>(() => (
    initialPersistedSession?.queue?.map((item) => ({ ...item })) as PlexItem[] ?? []
  ));
  const [currentIndex, setCurrentIndex] = useState(() => initialPersistedSession?.currentIndex ?? -1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoadingState] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [progress, setProgress] = useState(() => {
    const session = initialPersistedSession;
    const track = session && session.currentIndex >= 0 ? session.queue[session.currentIndex] : undefined;
    return track ? normalizeRestoredProgress(session!.progress, (track.duration || 0) / 1000) : 0;
  });
  const [duration, setDuration] = useState(() => {
    const session = initialPersistedSession;
    const track = session && session.currentIndex >= 0 ? session.queue[session.currentIndex] : undefined;
    return track ? (track.duration || 0) / 1000 : 0;
  });
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

  const requestStreamUrl = useCallback(async (serverId: string, track: PlexItem, quality: StreamQuality): Promise<string> => {
    const key = `${serverId}:${track.ratingKey}:${quality}`;
    const now = Date.now();
    const cachedAt = streamUrlInflightAtRef.current.get(key);
    const cached = streamUrlInflightRef.current.get(key);
    if (cached && cachedAt !== undefined && now - cachedAt < STREAM_URL_INFLIGHT_CACHE_MS) {
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

  const syncNativeQueue = useCallback(() => {
    if (!isDesktopRuntime()) return;
    void nativeQueueSet(
      queueRef.current.map((track) => ({
        rating_key: track.ratingKey,
        title: track.title || "",
        artist: trackArtist(track),
        album: trackAlbum(track),
      })),
      indexRef.current,
      repeatRef.current,
      shuffleRef.current,
    ).catch(() => undefined);
  }, []);

  const loadNativeTrack = useCallback(async (params: { index: number; autoplay: boolean; resumeSeconds: number; requestId: number }) => {
    const { index, autoplay, resumeSeconds, requestId } = params;
    const tracks = queueRef.current;
    const track = tracks[index];
    if (!track || !serverId) return;
    try {
      // 切换即停旧歌：先让引擎清空，避免取流期间旧歌继续播放/进度回跳。
      await nativeAudioStop().catch(() => undefined);
      syncNativeQueue();
      // 引擎可能刚创建（默认 20%），把前端实际音量同步过去，避免
      // UI 显示与真实输出不一致。
      void nativeAudioSetVolume(volumeRef.current).catch(() => undefined);
      const url = await requestStreamUrl(serverId, track, quality);
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      playbackLog("info", `原生流地址已取得：index=${index} 质量=${quality}`);
      // 真实曲目没有预置 imageUrl：用服务器相对路径向代理申请封面票据。
      const artworkTicket = track.imageUrl
        ?? (track.thumb
          ? await artworkUrl(serverId, track.thumb, 512, 512).catch(() => undefined)
          : undefined);
      await nativeAudioLoad(url, track.ratingKey, {
        title: track.title,
        artist: trackArtist(track),
        album: trackAlbum(track),
        artworkUrl: artworkTicket,
      });
      if (requestId !== loadRequestRef.current || indexRef.current !== index) return;
      if (resumeSeconds > 0.5) {
        try {
          await nativeAudioSeek(resumeSeconds);
        } catch {
          // 恢复位置失败不阻断播放。
        }
      }
      if (!autoplay) await nativeAudioPause();
      setPlaying(autoplay);
      setBuffering(false);
      setPlaybackLoading(false);
      playbackLog("info", `原生引擎开始播放：index=${index} 自动播放=${autoplay}`);
    } catch (reason) {
      if (requestId !== loadRequestRef.current) return;
      const diagnostic = reason instanceof Error ? reason.message : String(reason);
      playbackLog("error", `原生加载异常：index=${index} ${diagnostic}`);
      setPlaybackLoading(false);
      setBuffering(false);
      setPlaying(false);
      setError(`音频无法播放（${diagnostic}）。`);
      setPlaybackFailure({ message: `音频无法播放（${diagnostic}）。`, technicalDetails: diagnostic, attemptedQualities: [quality] });
    }
  }, [quality, requestStreamUrl, serverId, syncNativeQueue]);

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
    playbackLog("info", `加载请求：index=${index} 队列长度=${tracks.length} 自动播放=${autoplay} 质量=${quality} 强制新票据=${forceFreshTicket}`);
    setPlaybackLoading(autoplay);
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
    await loadNativeTrack({ index, autoplay, resumeSeconds, requestId });
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
  const stopCurrentImmediately = useCallback(() => {
    if (isDesktopRuntime()) void nativeAudioStop().catch(() => undefined);
    resumeProgressRef.current = null;
    progressRef.current = 0;
    setProgress(0);
  }, []);

  const next = useCallback(() => {
    // 先停旧歌 + 进度归 0，避免 nativeQueueNext IPC 往返期间旧歌继续出声/进度残留。
    stopCurrentImmediately();
    if (!isDesktopRuntime()) {
      void advance(false);
      return;
    }
    void nativeQueueNext()
      .then((index) => {
        if (index >= 0) void loadAt(index, true);
      })
      .catch(() => void advance(false));
  }, [advance, loadAt, stopCurrentImmediately]);

  const previous = useCallback(() => {
    if (!isDesktopRuntime()) {
      stopCurrentImmediately();
      void advance(false);
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
    stopCurrentImmediately();
    void nativeQueuePrevious()
      .then((index) => {
        if (index >= 0) void loadAt(index, true);
      })
      .catch(() => {
        // 没有上一首时回落到当前曲目开头重新播放，避免停在“已停止且进度为 0”的状态。
        if (indexRef.current >= 0) void loadAt(indexRef.current, true, 0);
      });
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
            setPlaying(true);
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
    setVolumeState(normalized);
    setMuted(false);
    writeStorage(VOLUME_STORAGE_KEY, String(normalized));
    void nativeAudioSetVolume(normalized).catch(() => undefined);
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
    if (isDesktopRuntime()) void nativeQueueSetShuffle(normalized).catch(() => undefined);
    schedulePersistedSession(false);
  }, [schedulePersistedSession]);

  const setRepeat = useCallback((mode: RepeatMode) => {
    const normalized: RepeatMode = mode === "one" || mode === "all" ? mode : "off";
    repeatRef.current = normalized;
    setRepeatState(normalized);
    if (isDesktopRuntime()) void nativeQueueSetRepeat(normalized).catch(() => undefined);
    schedulePersistedSession(false);
  }, [schedulePersistedSession]);

  const setOutputSinkId = useCallback((sinkId: string): Promise<boolean> => {
    const normalized = sinkId || "";
    outputSinkIdRef.current = normalized;
    setOutputSinkIdState(normalized);
    writeStorage(OUTPUT_SINK_STORAGE_KEY, normalized);
    if (!isDesktopRuntime()) return Promise.resolve(false);
    return nativeAudioSetOutputDevice(normalized)
      .then(() => true)
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
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("native-audio://event", (event) => {
      const payload = event.payload as { type?: string; position?: number; duration?: number; command?: string; index?: number; reason?: string } | null;
      if (!payload) return;
      if (payload.type === "progress" && typeof payload.position === "number" && Number.isFinite(payload.position)) {
        // 加载期间忽略旧歌的残留进度事件，保证切歌瞬间进度归 0 不被覆盖。
        if (playbackLoadingRef.current) return;
        progressRef.current = payload.position;
        setProgress(payload.position);
        if (typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration > 0) {
          setDuration(payload.duration);
        }
      } else if (payload.type === "ended") {
        // Queue authority lives in Rust: it already decided the next item and
        // emits `queue-item` when one exists; here we only settle local state.
        setPlaying(false);
        setPlaybackLoading(false);
        setBuffering(false);
        schedulePersistedSession(true);
      } else if (payload.type === "playback-protected-stop") {
        // Rust 心跳看门狗判定前端卡死/崩溃后主动停播，前端同步状态。
        playbackLog("warn", `播放保护已停止：${String(payload.reason ?? "unknown")}`);
        setPlaying(false);
        setPlaybackLoading(false);
        setBuffering(false);
        schedulePersistedSession(true);
      } else if (payload.type === "queue-item" && typeof payload.index === "number") {
        void loadAt(payload.index, true);
      } else if (payload.type === "track" && typeof payload.index === "number") {
        // Gapless handoff: Rust already queued and started the next source.
        // Mirror the UI without re-requesting a stream URL or reloading the
        // engine, otherwise the seamless PCM transition would be interrupted.
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
        schedulePersistedSession(true);
      } else if (payload.type === "remote") {
        const command = typeof payload.command === "string" ? payload.command : "";
        if (command === "play" || command === "toggle") toggle();
        else if (command === "pause") { if (playing) toggle(); }
        else if (command === "next") next();
        else if (command === "previous") previous();
        else if (command === "seek" && typeof payload.position === "number") seek(payload.position);
      }
    }).then((disposeFn) => {
      if (disposed) disposeFn();
      else unlisten = disposeFn;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadAt, next, playing, previous, schedulePersistedSession, seek, toggle]);

  useEffect(() => {
    if (!isDesktopRuntime() || !prebufferNext) return;
    const tracks = queueRef.current;
    if (!tracks.length || currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (shuffle && tracks.length > 1) {
      const preview = previewShuffleNext(
        shuffleNavigationRef.current,
        tracks.length,
        currentIndex,
        repeat,
      );
      shuffleNavigationRef.current = preview.state;
      nextIndex = preview.index;
    } else {
      nextIndex = getSequentialNextIndex(currentIndex, tracks.length, repeat === "one" ? "all" : repeat);
    }
    const nextTrack = nextIndex == null ? undefined : tracks[nextIndex];
    if (!nextTrack || !serverId) return;
    const requestId = ++precacheRequestRef.current;
    if (!shuffle && nextIndex != null) {
      // 顺序模式额外预热第二首 ahead（后台限速，不参与 gapless 预排），
      // 让切歌缓存再往深一层，Plexamp 风格的 2–3 首 ahead 预取。
      const secondIndex = getSequentialNextIndex(
        nextIndex,
        tracks.length,
        repeat === "one" ? "all" : repeat,
      );
      const secondTrack =
        secondIndex == null || secondIndex === nextIndex ? undefined : tracks[secondIndex];
      if (secondTrack) {
        void requestStreamUrl(serverId, secondTrack, quality)
          .then((url) => {
            if (precacheRequestRef.current !== requestId) return undefined;
            return nativeAudioPrecache(url, secondTrack.ratingKey, true);
          })
          .catch(() => undefined);
      }
    }
    void requestStreamUrl(serverId, nextTrack, quality)
      .then((url) => {
        if (precacheRequestRef.current !== requestId) return undefined;
        return nativeAudioPrecache(url, nextTrack.ratingKey);
      })
      .then(() => {
        if (precacheRequestRef.current !== requestId || nextIndex == null) return undefined;
        // 下载完成后立即挂到 rodio 队列：当前曲目结束时会无间隙交接。
        return nativeAudioQueueNextSource(nextIndex, nextTrack.ratingKey);
      })
      .catch(() => undefined);
    return () => {
      if (precacheRequestRef.current === requestId) precacheRequestRef.current += 1;
    };
  }, [currentIndex, prebufferNext, quality, queue, repeat, requestStreamUrl, serverId, shuffle]);

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

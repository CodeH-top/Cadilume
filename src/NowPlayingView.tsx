import {
  Captions,
  ChevronDown,
  Disc3,
  ListMusic,
  ListPlus,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { hasDisplayableLyrics, type LyricLine, type LyricsDocument } from "./lyrics";
import { playbackControlLabel } from "./playerUi";
import type { PlexMedia, ThemeMode } from "./types";
import "./NowPlayingView.css";

/**
 * The small, presentation-friendly subset of a Plex track that the view needs.
 * PlexItem values are assignable to this type, while simple test/demonstration
 * objects only need to provide `title` and (optionally) artist/album metadata.
 */
export interface NowPlayingTrack {
  title: string;
  key?: string;
  type?: "artist" | "album" | "track" | string;
  summary?: string;
  thumb?: string;
  art?: string;
  artist?: string;
  album?: string;
  grandparentTitle?: string;
  parentTitle?: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  year?: number;
  /** Plex reports duration in milliseconds. */
  duration?: number;
  durationMs?: number;
  index?: number;
  parentIndex?: number;
  addedAt?: number;
  viewCount?: number;
  Media?: PlexMedia[];
  imageUrl?: string;
  ratingKey?: string | number;
}

export interface NowPlayingLyricsState {
  document?: LyricsDocument;
  loading?: boolean;
  error?: string;
  /** The index supplied by the playback/lyrics hook; -1 means no active line. */
  activeIndex: number;
}

export type NowPlayingTheme = ThemeMode;
export type NowPlayingMode = "vinyl" | "artwork";
export type NowPlayingRepeatMode = "off" | "all" | "one";
type NowPlayingPanel = "queue" | null;

export interface NowPlayingViewProps {
  /** When omitted, the component remains mounted but animates below the window. */
  open?: boolean;
  /** The expanded player can show a turntable or a height-fitted artwork view. */
  mode?: NowPlayingMode;
  onModeChange?: (mode: NowPlayingMode) => void;
  track?: NowPlayingTrack;
  playing: boolean;
  loading?: boolean;
  buffering?: boolean;
  shuffle?: boolean;
  repeat?: NowPlayingRepeatMode;
  muted?: boolean;
  /** Independent player gain in the inclusive range 0...1. */
  volume?: number;
  /** The parent owns artwork loading/caching and may pass an image or fallback node. */
  artwork?: ReactNode;
  /** Optional ambient background used by `mode="artwork"`; the foreground cover stays sharp. */
  backgroundArtwork?: ReactNode;
  /** Optional timeline values are in seconds, matching usePlayer's public API. */
  progressSeconds?: number;
  durationSeconds?: number;
  lyrics?: NowPlayingLyricsState;
  queue?: NowPlayingTrack[];
  currentQueueIndex?: number;
  theme?: NowPlayingTheme;
  onSeek: (seconds: number) => void;
  onShuffleChange?: (enabled: boolean) => void;
  onPrevious?: () => void;
  onTogglePlayback?: () => void;
  onNext?: () => void;
  onRepeatChange?: (mode: NowPlayingRepeatMode) => void;
  onMutedChange?: (muted: boolean) => void;
  onVolumeChange?: (volume: number) => void;
  onSelectQueueIndex?: (index: number) => void;
  onClose: () => void;
  /** Disable this dialog's keyboard/focus handling while a nested dialog is open. */
  escapeEnabled?: boolean;
  onAddToPlaylist?: (track: NowPlayingTrack) => void;
}

/**
 * Return the karaoke fill for one timed lyric line at a playback position.
 * The result is always in [0, 1], making it safe to use as a CSS custom property
 * or a progress value in tests and consumers.
 */
export function getLyricProgress(line: LyricLine, positionMs: number): number {
  if (!Number.isFinite(positionMs) || line.startMs === null || !Number.isFinite(line.startMs)) return 0;
  const start = line.startMs;
  const end = line.endMs;
  if (end === null || !Number.isFinite(end) || end <= start) return positionMs >= start ? 1 : 0;
  return clampUnit((positionMs - start) / (end - start));
}

export interface LyricsScrollMetrics {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
  targetTop: number;
  targetHeight: number;
}

/**
 * Match Plex Web's stable reading position: keep the list still while any part
 * of the active line remains visible, then move an offscreen line to the top.
 * `targetTop` is measured from the list's visible top edge.
 */
export function getPlexLyricsScrollTop({
  scrollTop,
  viewportHeight,
  contentHeight,
  targetTop,
  targetHeight,
}: LyricsScrollMetrics): number {
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const content = Number.isFinite(contentHeight) ? Math.max(viewport, contentHeight) : viewport;
  const maximum = Math.max(0, content - viewport);
  const current = Number.isFinite(scrollTop) ? Math.min(maximum, Math.max(0, scrollTop)) : 0;
  const offset = Number.isFinite(targetTop) ? targetTop : 0;
  const height = Number.isFinite(targetHeight) ? Math.max(0, targetHeight) : 0;
  if (height > 0 && offset + height > 0 && offset < viewport) return current;
  const alignedTop = current + offset;
  return Math.min(maximum, Math.max(0, alignedTop));
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function trackArtist(track?: NowPlayingTrack): string {
  return track?.artist || track?.grandparentTitle || track?.parentTitle || "未知歌手";
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function NowPlayingView({
  open = true,
  mode = "vinyl",
  onModeChange,
  track,
  playing,
  loading = false,
  buffering = false,
  shuffle = false,
  repeat = "off",
  muted = false,
  volume = 1,
  artwork,
  progressSeconds,
  durationSeconds,
  lyrics,
  queue = [],
  currentQueueIndex = -1,
  theme,
  onSeek,
  onShuffleChange,
  onPrevious,
  onTogglePlayback,
  onNext,
  onRepeatChange,
  onMutedChange,
  onVolumeChange,
  onSelectQueueIndex,
  onClose,
  escapeEnabled = true,
  onAddToPlaylist,
}: NowPlayingViewProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const addToPlaylistButtonRef = useRef<HTMLButtonElement>(null);
  const escapeEnabledRef = useRef(escapeEnabled);
  const previousEscapeEnabledRef = useRef(escapeEnabled);
  const [internalMode, setInternalMode] = useState<NowPlayingMode>(mode);
  const [activePanel, setActivePanel] = useState<NowPlayingPanel>(null);
  const visible = Boolean(open && track);
  const displayMode = onModeChange ? mode : internalMode;
  const artist = trackArtist(track);
  const normalizedDuration = durationSeconds ?? durationFromTrack(track);
  const hasTimeline = Number.isFinite(normalizedDuration) && (normalizedDuration || 0) > 0;
  const timelineValue = hasTimeline ? clampUnit((progressSeconds || 0) / (normalizedDuration || 1)) : 0;
  const normalizedVolume = Number.isFinite(volume) ? clampUnit(volume) : 1;
  const effectiveVolume = muted ? 0 : normalizedVolume;
  const volumePercent = Math.round(effectiveVolume * 100);
  const playbackBusy = loading || buffering;
  const activelyPlaying = playing && !playbackBusy;
  const playbackLabel = playbackControlLabel({ playing, loading, buffering });
  const queueAvailable = queue.length > 0;
  const repeatLabel = repeat === "one" ? "单曲循环" : repeat === "all" ? "当前列表循环" : "顺序播放，列表结束后停止";
  const volumeIcon = effectiveVolume === 0
    ? <VolumeX size={18} strokeWidth={1.8} aria-hidden="true" />
    : effectiveVolume < 0.5
      ? <Volume1 size={18} strokeWidth={1.8} aria-hidden="true" />
      : <Volume2 size={18} strokeWidth={1.8} aria-hidden="true" />;
  const themeAttribute = theme;
  const modeClass = displayMode === "artwork" ? "is-artwork-mode" : "is-vinyl-mode";
  escapeEnabledRef.current = escapeEnabled;

  useEffect(() => {
    setInternalMode(mode);
  }, [mode]);

  useEffect(() => {
    if (!visible) setActivePanel(null);
    else if (activePanel === "queue" && !queueAvailable) setActivePanel(null);
  }, [activePanel, queueAvailable, visible]);

  useEffect(() => {
    if (!visible || !escapeEnabledRef.current) return;
    closeButtonRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    const wasEnabled = previousEscapeEnabledRef.current;
    previousEscapeEnabledRef.current = escapeEnabled;
    if (!visible || !escapeEnabled || wasEnabled) return;
    const frame = window.requestAnimationFrame(() => addToPlaylistButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [escapeEnabled, visible]);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!escapeEnabledRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (activePanel === "queue") {
          setActivePanel(null);
          return;
        }
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => (
        element.getAttribute("aria-hidden") !== "true"
        && !element.closest("[inert]")
        && element.getClientRects().length > 0
      ));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePanel, onClose, visible]);

  const handleBackdropMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (visible && event.target === event.currentTarget) onClose();
  };

  const handleModeChange = (nextMode: NowPlayingMode) => {
    if (onModeChange) onModeChange(nextMode);
    else setInternalMode(nextMode);
  };

  const handleVolumeChange = (nextVolume: number) => {
    const normalized = clampUnit(nextVolume);
    onVolumeChange?.(normalized);
    if (muted && normalized > 0) onMutedChange?.(false);
  };

  const cycleRepeat = () => {
    const nextMode: NowPlayingRepeatMode = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
    onRepeatChange?.(nextMode);
  };

  const toggleQueue = () => setActivePanel((current) => current === "queue" ? null : "queue");

  return (
    <section
      ref={dialogRef}
      className={`now-playing-view ${visible ? "is-open" : "is-closed"} ${modeClass}`}
      data-theme={themeAttribute}
      role="dialog"
      aria-modal={visible && escapeEnabled ? true : undefined}
      aria-labelledby={titleId}
      aria-hidden={!visible || !escapeEnabled}
      inert={!visible || !escapeEnabled ? true : undefined}
      tabIndex={-1}
      onMouseDown={handleBackdropMouseDown}
    >
      <div className="now-playing-sheen" aria-hidden="true" />
      <div className="now-playing-frame">
        <header className="now-playing-header">
          <div className="now-playing-header-drag-region" data-tauri-drag-region aria-hidden="true" />
          <button
            ref={closeButtonRef}
            className="now-playing-icon-button now-playing-close-button"
            type="button"
            aria-label="关闭正在播放"
            title="关闭正在播放"
            onClick={onClose}
          >
            <ChevronDown size={22} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="now-playing-header-spacer" aria-hidden="true" />
          <div className="now-playing-header-actions">
            <div className="now-playing-mode-switch" role="group" aria-label="展开播放器模式">
              <button
                className={`now-playing-mode-button ${displayMode === "vinyl" ? "is-selected" : ""}`}
                type="button"
                aria-pressed={displayMode === "vinyl"}
                aria-label="黑胶模式"
                title="黑胶模式"
                onClick={() => handleModeChange("vinyl")}
              >
                <Disc3 size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>黑胶</span>
              </button>
              <button
                className={`now-playing-mode-button ${displayMode === "artwork" ? "is-selected" : ""}`}
                type="button"
                aria-pressed={displayMode === "artwork"}
                aria-label="封面模式"
                title="封面模式"
                onClick={() => handleModeChange("artwork")}
              >
                <Music2 size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>封面</span>
              </button>
            </div>
            <button
              ref={addToPlaylistButtonRef}
              className="now-playing-action-button"
              type="button"
              disabled={!track || !onAddToPlaylist}
              aria-label="添加到歌单"
              onClick={() => track && onAddToPlaylist?.(track)}
            >
              <ListPlus size={17} strokeWidth={1.8} aria-hidden="true" />
              <span>添加到歌单</span>
            </button>
          </div>
        </header>

        <div className="now-playing-content">
          <section className="now-playing-art-column" aria-label="播放视觉与曲目信息">
            {displayMode === "vinyl" ? (
              <div className={`now-playing-record-stage ${activelyPlaying ? "is-playing" : "is-paused"}`}>
                <div className="now-playing-tonearm" aria-hidden="true"><span /></div>
                <div className="now-playing-record" aria-label={`${track?.title || "尚未播放"} 黑胶唱片`} role="img">
                  <div className="now-playing-record-grooves" aria-hidden="true" />
                  <div className="now-playing-record-label">
                    <div className="now-playing-artwork">{artwork || <Disc3 size={38} strokeWidth={1.4} aria-hidden="true" />}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="now-playing-cover-stage">
                <div className="now-playing-cover-artwork">{artwork || <Music2 size={64} strokeWidth={1.2} aria-hidden="true" />}</div>
              </div>
            )}
              <div className="now-playing-track-meta">
                <div className="now-playing-track-heading">
                  <h1 id={titleId}>{track?.title || "尚未播放"}</h1>
                </div>
                <p>{artist}</p>
              </div>
          </section>
          <ExpandedLyricsPanel track={track} lyrics={lyrics} onSeek={onSeek} />
          {activePanel === "queue" && <div className="now-playing-queue-popover">
            <ExpandedQueuePanel queue={queue} currentIndex={currentQueueIndex} onSelect={onSelectQueueIndex} />
          </div>}
        </div>

        <footer className="now-playing-controller" aria-label="完整播放器控制">
          <div className="now-playing-timeline" aria-label="播放进度">
            <span>{formatSeconds(progressSeconds || 0)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, normalizedDuration || 0)}
              step={0.1}
              value={hasTimeline ? Math.min(normalizedDuration || 0, Math.max(0, progressSeconds || 0)) : 0}
              disabled={!hasTimeline}
              aria-label="播放进度"
              style={{ "--now-playing-progress": `${timelineValue * 100}%` } as CSSProperties}
              onChange={(event) => onSeek(Number(event.target.value))}
            />
            <span>{formatSeconds(normalizedDuration || 0)}</span>
          </div>

          <div className="now-playing-control-row">
            <div className="now-playing-panel-actions" role="group" aria-label="展开播放器内容">
              <button
                className={`now-playing-control-button ${activePanel === "queue" ? "is-active" : ""}`}
                type="button"
                disabled={!queueAvailable}
                aria-label={activePanel === "queue" ? "隐藏播放队列" : "显示播放队列"}
                aria-pressed={activePanel === "queue"}
                title={activePanel === "queue" ? "隐藏播放队列" : "显示播放队列"}
                onClick={toggleQueue}
              >
                <ListMusic size={19} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>

            <div className="now-playing-transport" role="group" aria-label="播放控制">
              <button
                className={`now-playing-control-button ${shuffle ? "is-active" : ""}`}
                type="button"
                disabled={!track || !onShuffleChange}
                aria-label={shuffle ? "关闭随机播放（当前列表）" : "随机播放当前列表"}
                aria-pressed={shuffle}
                title={shuffle ? "关闭随机播放（当前列表）" : "随机播放当前列表"}
                onClick={() => onShuffleChange?.(!shuffle)}
              >
                <Shuffle size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <button
                className="now-playing-control-button"
                type="button"
                disabled={!track || !onPrevious}
                aria-label="上一首"
                title="上一首"
                onClick={onPrevious}
              >
                <SkipBack size={21} fill="currentColor" strokeWidth={1.7} aria-hidden="true" />
              </button>
              <button
                className={`now-playing-play-button ${playbackBusy ? "is-loading" : ""}`}
                type="button"
                disabled={!track || !onTogglePlayback || loading}
                aria-label={playbackLabel}
                title={playbackLabel}
                aria-busy={playbackBusy || undefined}
                aria-disabled={loading || undefined}
                onClick={onTogglePlayback}
              >
                {playbackBusy
                  ? <LoaderCircle className="spin playback-spinner" size={22} strokeWidth={2} aria-hidden="true" />
                  : playing
                    ? <Pause size={22} fill="currentColor" strokeWidth={1.7} aria-hidden="true" />
                    : <Play size={22} fill="currentColor" strokeWidth={1.7} aria-hidden="true" />}
              </button>
              <button
                className="now-playing-control-button"
                type="button"
                disabled={!track || !onNext}
                aria-label="下一首"
                title="下一首"
                onClick={onNext}
              >
                <SkipForward size={21} fill="currentColor" strokeWidth={1.7} aria-hidden="true" />
              </button>
              <button
                className={`now-playing-control-button ${repeat !== "off" ? "is-active" : ""}`}
                type="button"
                disabled={!track || !onRepeatChange}
                aria-label={repeatLabel}
                aria-pressed={repeat !== "off"}
                title={repeatLabel}
                onClick={cycleRepeat}
              >
                {repeat === "one"
                  ? <Repeat1 size={18} strokeWidth={1.8} aria-hidden="true" />
                  : <Repeat size={18} strokeWidth={1.8} aria-hidden="true" />}
              </button>
            </div>

            <div className="now-playing-volume" role="group" aria-label="播放器独立音量">
              <button
                className={`now-playing-control-button ${muted ? "is-active" : ""}`}
                type="button"
                disabled={!track || !onMutedChange}
                aria-label={muted ? "取消静音" : "静音"}
                aria-pressed={muted}
                title={muted ? "取消静音" : "静音"}
                onClick={() => onMutedChange?.(!muted)}
              >
                {volumeIcon}
              </button>
              <div className="now-playing-volume-popover">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={effectiveVolume}
                  disabled={!track || !onVolumeChange}
                  aria-label="播放器独立音量"
                  aria-orientation="vertical"
                  aria-valuetext={`${volumePercent}%`}
                  title={`音量 ${volumePercent}%`}
                  style={{ "--now-playing-volume": `${volumePercent}%` } as CSSProperties}
                  onChange={(event) => handleVolumeChange(Number(event.target.value))}
                />
                <output aria-live="polite">{volumePercent}%</output>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}

function ExpandedLyricsPanel({ track, lyrics, onSeek }: {
  track?: NowPlayingTrack;
  lyrics?: NowPlayingLyricsState;
  onSeek: (seconds: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const trackIdentity = track?.ratingKey || track?.key || track?.title || "";
  const previousTrackIdentityRef = useRef(trackIdentity);
  const lines = lyrics?.document?.lines ?? [];
  const activeIndex = lyrics?.activeIndex ?? -1;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (previousTrackIdentityRef.current !== trackIdentity) {
      previousTrackIdentityRef.current = trackIdentity;
      lineRefs.current = {};
      list.scrollTop = 0;
      return;
    }
    if (!lyrics?.document?.timed) return;
    const activeLine = lines[activeIndex];
    if (!activeLine || activeLine.clear) return;
    const node = lineRefs.current[activeLine.id];
    if (!node || typeof list.scrollTo !== "function") return;
    const listRect = list.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nextScrollTop = getPlexLyricsScrollTop({
      scrollTop: list.scrollTop,
      viewportHeight: list.clientHeight,
      contentHeight: list.scrollHeight,
      targetTop: nodeRect.top - listRect.top,
      targetHeight: nodeRect.height,
    });
    if (Math.abs(nextScrollTop - list.scrollTop) < 0.5) return;
    list.scrollTo({
      top: nextScrollTop,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [activeIndex, lines, lyrics?.document?.timed, trackIdentity]);

  return (
    <section className="now-playing-panel now-playing-lyrics-panel" aria-label="展开播放器歌词">
      <div ref={listRef} className="now-playing-lyrics-list" aria-live="polite" aria-busy={lyrics?.loading || undefined}>
        {lyrics?.loading ? (
          <div className="now-playing-panel-message" role="status"><LoaderCircle className="spin" size={22} /><span>正在读取歌词…</span></div>
        ) : lyrics?.error ? (
          <div className="now-playing-panel-message is-error" role="alert"><Captions size={24} /><span>歌词加载失败</span></div>
        ) : !hasDisplayableLyrics(lyrics?.document) ? (
          <div className="now-playing-panel-message"><Captions size={24} /><span>这首歌暂无可用歌词</span></div>
        ) : lines.map((line, index) => {
          if (line.clear || !line.texts.some((text) => text.trim())) {
            return <div className="now-playing-lyric-gap" key={line.id} aria-hidden="true" />;
          }
          const timed = lyrics?.document?.timed === true && line.startMs !== null;
          const active = timed && index === activeIndex;
          return (
            <button
              ref={(node) => { lineRefs.current[line.id] = node; }}
              className={`now-playing-lyric-line ${active ? "is-active" : ""} ${timed ? "is-timed" : "is-static"}`}
              key={line.id}
              type="button"
              disabled={!timed}
              aria-current={active ? "true" : undefined}
              onClick={() => timed && onSeek((line.startMs || 0) / 1000)}
            >
              {line.texts.map((text, textIndex) => <span key={`${line.id}-${textIndex}`}>{text}</span>)}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ExpandedQueuePanel({ queue, currentIndex, onSelect }: {
  queue: NowPlayingTrack[];
  currentIndex: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <section className="now-playing-panel now-playing-queue-panel" aria-label="展开播放器播放队列">
      <h2>播放队列</h2>
      <div className="now-playing-queue-list">
        {queue.map((item, index) => (
          <button
            className={`now-playing-queue-item ${index === currentIndex ? "is-active" : ""}`}
            type="button"
            key={`${item.ratingKey || item.key || item.title}-${index}`}
            aria-current={index === currentIndex ? "true" : undefined}
            disabled={!onSelect}
            onClick={() => onSelect?.(index)}
          >
            <span className="now-playing-queue-index">{index + 1}</span>
            <span><strong>{item.title}</strong><small>{trackArtist(item)}</small></span>
          </button>
        ))}
      </div>
    </section>
  );
}

function durationFromTrack(track?: NowPlayingTrack): number | undefined {
  const value = track?.durationMs ?? track?.duration;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value / 1000 : undefined;
}

export default NowPlayingView;

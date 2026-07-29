import {
  Captions,
  ChevronDown,
  Clock3,
  Disc3,
  ListPlus,
  LoaderCircle,
  MonitorUp,
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
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { LyricLine, LyricsDocument } from "./lyrics";
import type { PlexMedia } from "./types";
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

export type NowPlayingTheme = "system" | "light" | "dark";
export type NowPlayingMode = "vinyl" | "artwork";
export type NowPlayingRepeatMode = "off" | "all" | "one";

export interface NowPlayingViewProps {
  /** When omitted, the component remains mounted but animates below the window. */
  open?: boolean;
  /** The expanded player can show a turntable view or a full-bleed artwork view. */
  mode?: NowPlayingMode;
  onModeChange?: (mode: NowPlayingMode) => void;
  track?: NowPlayingTrack;
  playing: boolean;
  shuffle?: boolean;
  repeat?: NowPlayingRepeatMode;
  muted?: boolean;
  /** Independent player gain in the inclusive range 0...1. */
  volume?: number;
  lyrics?: NowPlayingLyricsState;
  /** The parent owns artwork loading/caching and may pass an image or fallback node. */
  artwork?: ReactNode;
  /** Optional full-bleed artwork used by `mode="artwork"`; falls back to `artwork`. */
  backgroundArtwork?: ReactNode;
  /** Optional timeline values are in seconds, matching usePlayer's public API. */
  progressSeconds?: number;
  durationSeconds?: number;
  theme?: NowPlayingTheme;
  onSeek: (seconds: number) => void;
  onShuffleChange?: (enabled: boolean) => void;
  onPrevious?: () => void;
  onTogglePlayback?: () => void;
  onNext?: () => void;
  onRepeatChange?: (mode: NowPlayingRepeatMode) => void;
  onMutedChange?: (muted: boolean) => void;
  onVolumeChange?: (volume: number) => void;
  onClose: () => void;
  /** Disable this dialog's keyboard/focus handling while a nested dialog is open. */
  escapeEnabled?: boolean;
  onOpenDesktop?: () => void;
  onAddToPlaylist?: (track: NowPlayingTrack) => void;
}

const EMPTY_LYRICS: NowPlayingLyricsState = { activeIndex: -1 };

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
 * Calculate the scroll position that centers one lyric inside its own list.
 * `targetTop` is measured from the list's visible top edge, so this helper does
 * not depend on the target's offsetParent and never needs to scroll an ancestor.
 */
export function getCenteredLyricsScrollTop({
  scrollTop,
  viewportHeight,
  contentHeight,
  targetTop,
  targetHeight,
}: LyricsScrollMetrics): number {
  const current = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const content = Number.isFinite(contentHeight) ? Math.max(viewport, contentHeight) : viewport;
  const offset = Number.isFinite(targetTop) ? targetTop : 0;
  const height = Number.isFinite(targetHeight) ? Math.max(0, targetHeight) : 0;
  const centered = current + offset + (height / 2) - (viewport / 2);
  return Math.min(Math.max(0, content - viewport), Math.max(0, centered));
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function trackArtist(track?: NowPlayingTrack): string {
  return track?.artist || track?.grandparentTitle || track?.parentTitle || "未知艺术家";
}

function trackAlbum(track?: NowPlayingTrack): string {
  return track?.album || track?.parentTitle || "未知专辑";
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function lyricLabel(line: LyricLine): string {
  return line.texts.join(" / ") || "音乐间奏";
}

export function NowPlayingView({
  open = true,
  mode = "vinyl",
  onModeChange,
  track,
  playing,
  shuffle = false,
  repeat = "off",
  muted = false,
  volume = 1,
  lyrics = EMPTY_LYRICS,
  artwork,
  backgroundArtwork,
  progressSeconds,
  durationSeconds,
  theme,
  onSeek,
  onShuffleChange,
  onPrevious,
  onTogglePlayback,
  onNext,
  onRepeatChange,
  onMutedChange,
  onVolumeChange,
  onClose,
  escapeEnabled = true,
  onOpenDesktop,
  onAddToPlaylist,
}: NowPlayingViewProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const lyricsListRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const addToPlaylistButtonRef = useRef<HTMLButtonElement>(null);
  const lyricRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const escapeEnabledRef = useRef(escapeEnabled);
  const previousEscapeEnabledRef = useRef(escapeEnabled);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [internalMode, setInternalMode] = useState<NowPlayingMode>(mode);
  const visible = Boolean(open && track);
  const displayMode = onModeChange ? mode : internalMode;
  const lines = lyrics.document?.lines ?? [];
  const activeIndex = lyrics.activeIndex ?? -1;
  const artist = trackArtist(track);
  const album = trackAlbum(track);
  const normalizedDuration = durationSeconds ?? durationFromTrack(track);
  const hasTimeline = Number.isFinite(normalizedDuration) && (normalizedDuration || 0) > 0;
  const timelineValue = hasTimeline ? clampUnit((progressSeconds || 0) / (normalizedDuration || 1)) : 0;
  const normalizedVolume = Number.isFinite(volume) ? clampUnit(volume) : 1;
  const effectiveVolume = muted ? 0 : normalizedVolume;
  const volumePercent = Math.round(effectiveVolume * 100);
  const repeatLabel = repeat === "one" ? "单曲循环" : repeat === "all" ? "当前列表循环" : "顺序播放，列表结束后停止";
  const volumeIcon = effectiveVolume === 0
    ? <VolumeX size={18} strokeWidth={1.8} aria-hidden="true" />
    : effectiveVolume < 0.5
      ? <Volume1 size={18} strokeWidth={1.8} aria-hidden="true" />
      : <Volume2 size={18} strokeWidth={1.8} aria-hidden="true" />;
  const stateLabel = playing ? "正在播放" : "已暂停";
  const themeAttribute = theme === "system" ? undefined : theme;
  const modeClass = displayMode === "artwork" ? "is-artwork-mode" : "is-vinyl-mode";
  const trackIdentity = track
    ? String(track.ratingKey ?? track.key ?? `${track.title}\u0000${track.duration ?? track.durationMs ?? ""}`)
    : "";
  const previousTrackIdentityRef = useRef(trackIdentity);
  escapeEnabledRef.current = escapeEnabled;

  useEffect(() => {
    setInternalMode(mode);
  }, [mode]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

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

  useLayoutEffect(() => {
    if (!visible) return;
    const list = lyricsListRef.current;
    if (!list) return;

    if (previousTrackIdentityRef.current !== trackIdentity) {
      previousTrackIdentityRef.current = trackIdentity;
      list.scrollTop = 0;
      return;
    }

    const activeLine = lines[activeIndex];
    if (!activeLine || activeLine.clear) return;
    const node = lyricRefs.current[activeLine.id];
    if (!node || typeof list.scrollTo !== "function") return;
    const listRect = list.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    list.scrollTo({
      top: getCenteredLyricsScrollTop({
        scrollTop: list.scrollTop,
        viewportHeight: list.clientHeight,
        contentHeight: list.scrollHeight,
        targetTop: nodeRect.top - listRect.top,
        targetHeight: nodeRect.height,
      }),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeIndex, lines, reducedMotion, trackIdentity, visible]);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!escapeEnabledRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
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
  }, [onClose, visible]);

  const lineCountLabel = useMemo(() => {
    if (lyrics.loading) return "正在读取歌词";
    if (lyrics.error) return "歌词加载失败";
    if (!lines.length) return "暂无歌词";
    return lyrics.document?.timed ? `${lines.length} 行时间轴歌词` : `${lines.length} 行歌词`;
  }, [lines.length, lyrics.document?.timed, lyrics.error, lyrics.loading]);

  const handleBackdropMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (visible && event.target === event.currentTarget) onClose();
  };

  const handleLyricSeek = (line: LyricLine) => {
    if (line.startMs === null || !Number.isFinite(line.startMs)) return;
    onSeek(Math.max(0, line.startMs) / 1000);
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
      {displayMode === "artwork" && (
        <div className="now-playing-background-artwork" aria-hidden="true">
          {backgroundArtwork || artwork || <Disc3 size={180} strokeWidth={1} />}
        </div>
      )}
      <div className="now-playing-sheen" aria-hidden="true" />
      <div className="now-playing-frame">
        <header className="now-playing-header">
          <button
            ref={closeButtonRef}
            className="now-playing-icon-button now-playing-close-button"
            type="button"
            aria-label="关闭正在播放"
            title="关闭正在播放（Esc）"
            onClick={onClose}
          >
            <ChevronDown size={22} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <div className="now-playing-header-title" aria-live="polite">
            <span className="now-playing-kicker">NOW PLAYING</span>
            <span>{stateLabel}</span>
          </div>
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
              className="now-playing-action-button"
              type="button"
              disabled={!track || !onOpenDesktop}
              aria-label="打开桌面歌词"
              onClick={() => track && onOpenDesktop?.()}
            >
              <MonitorUp size={17} strokeWidth={1.8} aria-hidden="true" />
              <span>桌面歌词</span>
            </button>
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
          <section className="now-playing-art-column" aria-label="专辑封面与唱片">
            <div className={`now-playing-record-stage ${playing ? "is-playing" : "is-paused"}`}>
              <div className="now-playing-tonearm" aria-hidden="true"><span /></div>
              <div className="now-playing-record" aria-label={`${track?.title || "尚未播放"} 黑胶唱片`} role="img">
                <div className="now-playing-record-grooves" aria-hidden="true" />
                <div className="now-playing-record-label">
                  <div className="now-playing-artwork">{artwork || <Disc3 size={38} strokeWidth={1.4} aria-hidden="true" />}</div>
                  <span className="now-playing-spindle" aria-hidden="true" />
                </div>
                <span className="now-playing-record-hole" aria-hidden="true" />
              </div>
            </div>
            <div className="now-playing-track-meta">
              <div className="now-playing-track-heading">
                <h1 id={titleId}>{track?.title || "尚未播放"}</h1>
                <span className={`now-playing-status-dot ${playing ? "is-playing" : ""}`} aria-label={stateLabel} />
              </div>
              <p>{artist}</p>
              <small>{album}{track?.year ? ` · ${track.year}` : ""}</small>
            </div>
          </section>

          <section className="now-playing-lyrics-column" aria-label="同步歌词">
            <div className="now-playing-lyrics-heading">
              <div>
                <span className="now-playing-kicker">LYRICS</span>
                <h2>歌词</h2>
              </div>
              <span className="now-playing-lyrics-count" aria-live="polite">{lineCountLabel}</span>
            </div>
            <div
              ref={lyricsListRef}
              className="now-playing-lyrics-list"
              aria-live="polite"
              aria-busy={lyrics.loading || undefined}
              tabIndex={0}
            >
              {lyrics.loading ? (
                <div className="now-playing-lyrics-message"><LoaderCircle className="now-playing-spin" size={22} aria-hidden="true" /><span>正在读取歌词…</span></div>
              ) : lyrics.error ? (
                <div className="now-playing-lyrics-message is-error"><Captions size={28} strokeWidth={1.5} aria-hidden="true" /><strong>歌词加载失败</strong><small>{lyrics.error}</small></div>
              ) : !track ? (
                <div className="now-playing-lyrics-message"><Music2 size={28} strokeWidth={1.5} aria-hidden="true" /><strong>播放歌曲后显示歌词</strong><small>从资料库选择一首音乐开始。</small></div>
              ) : !lines.length ? (
                <div className="now-playing-lyrics-message"><Captions size={28} strokeWidth={1.5} aria-hidden="true" /><strong>这首歌暂无可用歌词</strong><small>只显示 Plex 服务器授权返回的歌词。</small></div>
              ) : (
                lines.map((line, index) => {
                  if (line.clear) return <div className="now-playing-lyric-gap" key={line.id} aria-hidden="true" />;
                  const active = lyrics.document?.timed === true && index === activeIndex;
                  const timed = line.startMs !== null && lyrics.document?.timed === true;
                  return (
                    <button
                      ref={(node) => { lyricRefs.current[line.id] = node; }}
                      className={`now-playing-lyric-line ${active ? "is-active" : ""} ${timed ? "is-timed" : "is-static"}`}
                      key={line.id}
                      type="button"
                      disabled={!timed}
                      aria-current={active ? "true" : undefined}
                      aria-label={timed ? `${lyricLabel(line)}，跳转到 ${formatSeconds((line.startMs || 0) / 1000)}` : lyricLabel(line)}
                      onClick={() => handleLyricSeek(line)}
                    >
                      <span className="now-playing-lyric-text">{line.texts.join(" · ")}</span>
                      {active && <span className="now-playing-lyric-marker" aria-hidden="true" />}
                    </button>
                  );
                })
              )}
            </div>
            {lyrics.document && (
              <footer className="now-playing-lyrics-footer">
                <span>{lyrics.document.timed ? "时间轴歌词" : "纯文本歌词"}</span>
                <small>{lyrics.document.by || lyrics.document.author || lyrics.document.provider || "Plex 服务器"}</small>
              </footer>
            )}
          </section>
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
            <span className="now-playing-control-context" title={repeatLabel}>
              <Clock3 size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{shuffle ? "随机播放当前列表" : repeatLabel}</span>
            </span>

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
                className="now-playing-play-button"
                type="button"
                disabled={!track || !onTogglePlayback}
                aria-label={playing ? "暂停" : "播放"}
                title={playing ? "暂停" : "播放"}
                onClick={onTogglePlayback}
              >
                {playing
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
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={effectiveVolume}
                disabled={!track || !onVolumeChange}
                aria-label="播放器独立音量"
                aria-valuetext={`${volumePercent}%`}
                style={{ "--now-playing-volume": `${volumePercent}%` } as CSSProperties}
                onChange={(event) => handleVolumeChange(Number(event.target.value))}
              />
              <output aria-live="polite">{volumePercent}</output>
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}

function durationFromTrack(track?: NowPlayingTrack): number | undefined {
  const value = track?.durationMs ?? track?.duration;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value / 1000 : undefined;
}

export default NowPlayingView;

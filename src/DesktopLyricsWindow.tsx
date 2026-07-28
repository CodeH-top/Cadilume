import { LockKeyhole, LockKeyholeOpen, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { isDesktopRuntime } from "./api";
import { BrandIcon } from "./BrandIcon";
import { DESKTOP_LYRICS_EVENT, desktopLyricProgress, hideDesktopLyrics, type DesktopLyricsPayload } from "./desktopLyrics";
import "./DesktopLyricsWindow.css";

const LOCK_STORAGE_KEY = "cadilume-desktop-lyrics-locked";

const EMPTY_PAYLOAD: DesktopLyricsPayload = {
  title: "Cadilume",
  artist: "播放音乐后显示歌词",
  currentText: "",
  nextText: "",
  timed: false,
  playing: false,
  positionMs: 0,
  lineProgress: 0,
};

/**
 * Transparent, always-on-top karaoke overlay.
 *
 * It intentionally does not use Tauri's click-through mode: a click-through
 * window cannot reveal the hover controls or be unlocked. Locking only gates
 * the drag gesture, while the close/unlock buttons remain reachable.
 */
export function DesktopLyricsWindow() {
  const [payload, setPayload] = useState<DesktopLyricsPayload>(EMPTY_PAYLOAD);
  const [locked, setLocked] = useState(() => readLockedPreference());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    document.documentElement.dataset.desktopLyrics = "true";
    return () => {
      delete document.documentElement.dataset.desktopLyrics;
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<DesktopLyricsPayload>(DESKTOP_LYRICS_EVENT, (event) => {
      if (disposed) return;
      const next = { ...EMPTY_PAYLOAD, ...event.payload };
      setPayload(next);
      setReceivedAt(Date.now());
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Parent updates are intentionally coarse (one event per second). A small
  // local clock keeps the karaoke sweep fluid between events without owning
  // playback state or exposing any server credentials.
  useEffect(() => {
    if (!payload.playing || !payload.timed) return;
    const timer = window.setInterval(() => setClock(Date.now()), 50);
    return () => window.clearInterval(timer);
  }, [payload.playing, payload.timed]);

  const interpolatedPayload = useMemo(() => {
    if (!payload.playing || !payload.timed) return payload;
    const elapsed = Math.max(0, clock - receivedAt);
    const hasLineBounds = typeof payload.currentStartMs === "number"
      && typeof payload.currentEndMs === "number"
      && payload.currentEndMs > payload.currentStartMs;
    if (!hasLineBounds) return payload;
    return { ...payload, positionMs: payload.positionMs + elapsed, lineProgress: undefined };
  }, [clock, payload, receivedAt]);
  const progress = desktopLyricProgress(interpolatedPayload);
  const hasTrack = Boolean(payload.trackId);
  const artworkUrl = safeArtworkUrl(payload.artworkUrl);
  const currentText = payload.currentText || (hasTrack ? "这首歌暂时没有可显示的歌词" : "播放音乐后，歌词会显示在这里");
  const nextText = payload.nextText || (payload.timed ? "" : hasTrack ? "纯文本歌词不会自动步进" : "");

  const toggleLock = () => {
    setLocked((current) => {
      const next = !current;
      writeLockedPreference(next);
      return next;
    });
  };

  const startDragging = (event: MouseEvent<HTMLElement>) => {
    if (locked || event.button !== 0 || !isDesktopRuntime()) return;
    const target = event.target as Element | null;
    if (target?.closest("button, a, img, .desktop-karaoke-copy, .desktop-karaoke-art")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  return (
    <main className={`desktop-karaoke-window ${locked ? "is-locked" : "is-unlocked"}`} onMouseDown={startDragging}>
      <div className="desktop-karaoke-surface">
        <div className="desktop-karaoke-art" aria-hidden="true">
          <div className={`desktop-karaoke-record ${payload.playing ? "is-playing" : ""}`}>
            <span className="desktop-karaoke-groove groove-one" />
            <span className="desktop-karaoke-groove groove-two" />
            <span className="desktop-karaoke-label">
              {artworkUrl ? <img src={artworkUrl} alt="" /> : <BrandIcon size={22} />}
            </span>
          </div>
        </div>

        <section className="desktop-karaoke-copy" aria-live="polite" aria-atomic="true">
          <div className="desktop-karaoke-meta">
            <span className="desktop-karaoke-title">{payload.title}</span>
            <span className="desktop-karaoke-artist">{payload.artist}{payload.album ? ` · ${payload.album}` : ""}</span>
            <span className={`desktop-karaoke-status ${payload.playing ? "is-playing" : ""}`} aria-label={payload.playing ? "正在播放" : "已暂停"} />
          </div>
          <div className="desktop-karaoke-lines">
            <div
              className={`desktop-karaoke-line desktop-karaoke-line-current ${currentText ? "" : "is-empty"}`}
              style={{ "--karaoke-progress": `${progress * 100}%` } as CSSProperties}
            >
              <span className="desktop-karaoke-line-base">{currentText}</span>
              <span className="desktop-karaoke-line-fill" aria-hidden="true">{currentText}</span>
            </div>
            <div className={`desktop-karaoke-line desktop-karaoke-line-next ${nextText ? "" : "is-empty"}`}>{nextText || " "}</div>
          </div>
          <div className="desktop-karaoke-progress" aria-hidden="true"><span style={{ width: `${progress * 100}%` }} /></div>
        </section>
      </div>

      <div className="desktop-karaoke-chrome" role="toolbar" aria-label="桌面歌词控制">
        <span className="desktop-karaoke-hint">{locked ? "位置已固定 · 悬停后解除固定" : "拖动空白处调整位置"}</span>
        <button type="button" className="desktop-karaoke-control" onClick={toggleLock} aria-label={locked ? "解除固定桌面歌词位置" : "固定桌面歌词位置"} title={locked ? "解除固定位置" : "固定位置"}>
          {locked ? <LockKeyhole size={15} /> : <LockKeyholeOpen size={15} />}
        </button>
        <button type="button" className="desktop-karaoke-control desktop-karaoke-close" onClick={() => void hideDesktopLyrics()} aria-label="关闭桌面歌词" title="关闭桌面歌词">
          <X size={16} />
        </button>
      </div>
    </main>
  );
}

function readLockedPreference(): boolean {
  try {
    return localStorage.getItem(LOCK_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLockedPreference(value: boolean): void {
  try {
    localStorage.setItem(LOCK_STORAGE_KEY, String(value));
  } catch {
    // Private browsing / restricted WebViews can deny storage. The in-memory
    // preference still works for the current window in that case.
  }
}

function safeArtworkUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // The overlay should only receive a Rust-served/data URL. Avoid rendering a
  // caller-supplied PMS token if an integration accidentally passes a raw URL.
  if (/[?&](?:X-Plex-Token|token)=/i.test(value)) return undefined;
  return value;
}

export default DesktopLyricsWindow;

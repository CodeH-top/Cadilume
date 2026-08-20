import {
  Cable,
  ChevronDown,
  Cloud,
  Globe2,
  ListMusic,
  LoaderCircle,
  LockKeyhole,
  Moon,
  Pencil,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { normalizeDeviceName, type PlaylistChanges } from "./api";
import type { PlexPlaylist, PlexServer, ThemeMode } from "./types";
import { Artwork, IconButton } from "./App";

export type ConnectionKind = "local" | "remote" | "relay" | "disconnected";
type ThemeTransitionOrigin = { x: number; y: number };
type ThemeModeChange = (mode: ThemeMode, origin?: ThemeTransitionOrigin) => void;

export function PlaylistKindIcons({ playlist, className = "" }: { playlist: PlexPlaylist; className?: string }) {
  const KindIcon = playlist.smart ? Sparkles : ListMusic;
  return (
    <span className={`playlist-kind-icons ${className}`.trim()}>
      <span className="playlist-kind-icon" role="img" aria-label={playlist.smart ? "智能歌单" : "普通歌单"}>
        <KindIcon size={13} strokeWidth={1.9} aria-hidden="true" />
      </span>
      {playlist.readOnly && (
        <span className="playlist-kind-icon" role="img" aria-label="只读">
          <LockKeyhole size={12} strokeWidth={1.9} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

export function PlaylistSidebar({ playlists, selectedId, loading, error, onOpen, onRetry, onCreate, onUpdatePlaylist, onDeletePlaylist }: {
  playlists: PlexPlaylist[];
  selectedId?: string;
  loading: boolean;
  error?: string;
  onOpen: (playlist: PlexPlaylist) => void;
  onRetry: () => void;
  onCreate: () => void;
  onUpdatePlaylist: (playlist: PlexPlaylist, changes: PlaylistChanges) => Promise<void>;
  onDeletePlaylist: (playlist: PlexPlaylist) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ playlist: PlexPlaylist; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<PlexPlaylist | null>(null);
  const [deleting, setDeleting] = useState<PlexPlaylist | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (contextMenuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const openContextMenu = (event: ReactMouseEvent, playlist: PlexPlaylist) => {
    event.preventDefault();
    setContextMenu({ playlist, x: event.clientX, y: event.clientY });
  };
  const menuLeft = contextMenu ? Math.max(8, Math.min(window.innerWidth - 176, contextMenu.x)) : 0;
  const menuTop = contextMenu ? Math.max(8, Math.min(window.innerHeight - 132, contextMenu.y)) : 0;

  return (
    <nav className={`sidebar-playlists ${collapsed ? "is-collapsed" : ""}`} aria-label="歌单">
      <div className="sidebar-playlists-toolbar">
        <button className="sidebar-playlists-heading" type="button" aria-expanded={!collapsed} aria-controls="sidebar-playlist-list" onClick={() => setCollapsed((value) => !value)}>
          <span>歌单</span>
          <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
        </button>
        <button className="sidebar-playlists-create" type="button" aria-label="新建歌单" data-tooltip="新建歌单" onClick={onCreate}>
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div id="sidebar-playlist-list" className="sidebar-playlist-list" aria-busy={loading || undefined} hidden={collapsed}>
        {error ? (
          <div className="sidebar-playlist-state is-error" role="alert"><span>歌单读取失败</span><button type="button" onClick={onRetry}>重试</button></div>
        ) : !playlists.length ? (
          <div className="sidebar-playlist-state"><ListMusic size={18} /><span>暂无音乐歌单</span></div>
        ) : playlists.map((playlist) => {
          const capability = [playlist.smart ? "智能" : "普通", playlist.readOnly ? "只读" : undefined].filter(Boolean).join(" · ");
          const active = selectedId === playlist.ratingKey;
          return (
            <button
              type="button"
              className={`sidebar-playlist-item ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={`${playlist.title}，${capability}歌单`}
              title={playlist.title}
              key={playlist.ratingKey}
              onClick={() => onOpen(playlist)}
              onContextMenu={(event) => openContextMenu(event, playlist)}
            >
              <Artwork item={playlist} size="small" className="sidebar-playlist-artwork" />
              <span>
                <strong>{playlist.title}</strong>
                <small className="sidebar-playlist-meta"><PlaylistKindIcons playlist={playlist} /><span>{playlist.leafCount ?? 0} 首</span></small>
              </span>
              <span className="sidebar-playlist-selected-dot" aria-hidden="true" />
            </button>
          );
        })}
        {loading && (
          <div className="sidebar-playlist-loading" role="status">
            <LoaderCircle className="spin" size={17} />
            <span>正在同步歌单…</span>
          </div>
        )}
      </div>
      {contextMenu && createPortal(
        <div ref={contextMenuRef} className="playlist-context-menu" style={{ left: menuLeft, top: menuTop }} role="menu" aria-label={`${contextMenu.playlist.title} 歌单操作`}>
          <button type="button" role="menuitem" disabled={contextMenu.playlist.readOnly} onClick={() => { setEditing(contextMenu.playlist); setContextMenu(null); }}><Pencil size={15} />编辑</button>
          <button type="button" role="menuitem" className="is-danger" disabled={contextMenu.playlist.readOnly} onClick={() => { setDeleting(contextMenu.playlist); setContextMenu(null); }}><Trash2 size={15} />删除</button>
        </div>,
        document.body,
      )}
      {editing && (
        <PlaylistEditDialog
          playlist={editing}
          busy={editBusy}
          onClose={() => setEditing(null)}
          onSave={async (changes) => {
            setEditBusy(true);
            try {
              await onUpdatePlaylist(editing, changes);
              setEditing(null);
            } catch {
              // Keep the dialog open so the user can retry after a server error.
            } finally {
              setEditBusy(false);
            }
          }}
        />
      )}
      {deleting && (
        <PlaylistDeleteDialog
          playlist={deleting}
          busy={deleteBusy}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            setDeleteBusy(true);
            try {
              await onDeletePlaylist(deleting);
              setDeleting(null);
            } catch {
              // Keep the confirmation visible so the user can retry.
            } finally {
              setDeleteBusy(false);
            }
          }}
        />
      )}
    </nav>
  );
}

function PlaylistEditDialog({ playlist, busy, onSave, onClose }: {
  playlist: PlexPlaylist;
  busy: boolean;
  onSave: (changes: PlaylistChanges) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(playlist.title);
  const [summary, setSummary] = useState(playlist.summary ?? "");
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => titleInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const valid = Boolean(title.trim());
  return (
    <div className="playlist-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-edit-title">
        <header>
          <div><h2 id="playlist-edit-title">编辑歌单</h2><small>修改歌单名称与描述</small></div>
          <IconButton label="关闭编辑歌单" tooltip={null} disabled={busy} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onSave({ title: title.trim(), summary: summary.trim() });
        }}>
          <label className="playlist-dialog-field"><span>歌单名称</span><input ref={titleInputRef} value={title} maxLength={255} required disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="playlist-dialog-field"><span>描述</span><textarea value={summary} maxLength={1000} rows={4} disabled={busy} placeholder="选填，介绍这个歌单" onChange={(event) => setSummary(event.target.value)} /></label>
          <footer>
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={!valid || busy} aria-busy={busy || undefined}>{busy ? <><LoaderCircle className="spin" size={15} />正在保存…</> : "保存"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function PlaylistDeleteDialog({ playlist, busy, onConfirm, onClose }: {
  playlist: PlexPlaylist;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>(".secondary-button")?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onClose]);
  return (
    <div className="playlist-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="playlist-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="playlist-delete-title" tabIndex={-1}>
        <div className="playlist-delete-content"><span className="playlist-delete-icon" aria-hidden="true"><Trash2 size={18} /></span><div><h2 id="playlist-delete-title">删除歌单</h2><p>确定删除“{playlist.title}”？其中的 {playlist.leafCount ?? 0} 首歌曲也会从歌单中移除。</p></div></div>
        <div className="playlist-delete-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="danger-button" disabled={busy} aria-busy={busy || undefined} onClick={() => { if (!busy) onConfirm(); }}>{busy ? <><LoaderCircle className="spin" size={15} />正在删除…</> : <><Trash2 size={15} />删除</>}</button>
        </div>
      </section>
    </div>
  );
}

export function ConnectionIndicator({ server, connected, kindOverride }: { server?: PlexServer; connected: boolean; kindOverride?: ConnectionKind }) {
  const kind = kindOverride ?? (!server || !connected ? "disconnected" : server.local ? "local" : server.relay ? "relay" : "remote");
  const label = kind === "local" ? "本地直连" : kind === "remote" ? "远程直连" : kind === "relay" ? "Plex Relay" : "连接已断开";
  const StatusIcon = kind === "local" ? Cable : kind === "remote" ? Globe2 : kind === "relay" ? Cloud : WifiOff;
  return (
    <span className="connection-tooltip-anchor">
      <span className="connection-indicator" data-connection={kind} role="status" tabIndex={0} aria-label={`连接状态：${label}`} aria-describedby="connection-status-tooltip"><StatusIcon size={17} strokeWidth={1.9} aria-hidden="true" /></span>
      <span id="connection-status-tooltip" className="connection-tooltip" role="tooltip">{label}</span>
    </span>
  );
}

export function ThemeCycleButton({ resolvedTheme, onChange }: { resolvedTheme: ThemeMode; onChange: ThemeModeChange }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nextMode = resolvedTheme === "light" ? "dark" : "light";
  const nextLabel = nextMode === "light" ? "浅色模式" : "深色模式";
  const CurrentIcon = resolvedTheme === "light" ? Sun : Moon;
  const cycle = () => {
    const bounds = triggerRef.current?.getBoundingClientRect();
    onChange(nextMode, bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : undefined);
  };
  return <button ref={triggerRef} className="icon-button theme-cycle-button" type="button" aria-label={`切换为${nextLabel}`} data-tooltip={nextLabel} onClick={cycle}><CurrentIcon size={18} strokeWidth={1.9} aria-hidden="true" /></button>;
}

export function DeviceNameDialog({ deviceName, onClose, onSave }: { deviceName: string; onClose: () => void; onSave: (value: string) => Promise<string> }) {
  const [draft, setDraft] = useState(deviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTargetRef = useRef<HTMLElement | null>(null);
  const restoreFocusFrameRef = useRef<number | undefined>(undefined);
  const normalizedName = (() => {
    try {
      return normalizeDeviceName(draft);
    } catch {
      return undefined;
    }
  })();
  const canSubmit = Boolean(normalizedName && normalizedName !== deviceName && !busy);

  useEffect(() => {
    if (restoreFocusFrameRef.current !== undefined) window.cancelAnimationFrame(restoreFocusFrameRef.current);
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!restoreFocusTargetRef.current && activeElement !== document.body) restoreFocusTargetRef.current = activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
        const target = restoreFocusTargetRef.current;
        if (target?.isConnected && !target.closest("[inert]") && !target.matches(":disabled")) target.focus();
        restoreFocusFrameRef.current = undefined;
      });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = document.activeElement instanceof HTMLElement ? focusable.indexOf(document.activeElement) : -1;
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedName || normalizedName === deviceName || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(normalizedName);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 Cadilume 设备名称。");
      setBusy(false);
    }
  };

  return (
    <div className="playlist-picker-backdrop device-name-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="device-name-dialog" role="dialog" aria-modal="true" aria-labelledby="device-name-dialog-title" tabIndex={-1}>
        <header><div><h2 id="device-name-dialog-title">修改设备名称</h2><small>确认后用于后续 Plex 请求。</small></div><IconButton label="关闭修改设备名称" tooltip={null} disabled={busy} onClick={onClose}><X size={18} /></IconButton></header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="device-name-dialog-content">
            <label htmlFor="cadilume-device-name">设备名称</label>
            <input ref={inputRef} id="cadilume-device-name" value={draft} maxLength={80} required placeholder="例如：我的 MacBook Pro" aria-invalid={Boolean(error) || undefined} aria-describedby={error ? "device-name-dialog-hint device-name-dialog-error" : "device-name-dialog-hint"} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError(undefined); }} />
            <p id="device-name-dialog-hint">Plex 将显示为“Cadilume — {normalizedName || draft.trim() || "设备名称"}”。</p>
            {error && <p id="device-name-dialog-error" className="device-name-dialog-error" role="alert">{error}</p>}
          </div>
          <footer><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={!canSubmit} aria-busy={busy || undefined}>{busy ? <><LoaderCircle className="spin" size={15} />正在保存…</> : "确认修改"}</button></footer>
        </form>
      </section>
    </div>
  );
}

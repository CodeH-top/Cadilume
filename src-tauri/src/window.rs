use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use tauri::{
    menu::MenuBuilder, tray::TrayIconBuilder, AppHandle, Emitter, Manager, Runtime, State, Window,
    WindowEvent,
};
use tokio::sync::oneshot;

use crate::plex::PlexState;

const TRAY_ID: &str = "cadilume-tray";
const MAIN_WINDOW_LABEL: &str = "main";
const DESKTOP_LYRICS_WINDOW_LABEL: &str = "desktop-lyrics";
const DESKTOP_LYRICS_VISIBILITY_EVENT: &str = "desktop-lyrics://visibility";
const APP_BEFORE_EXIT_EVENT: &str = "app://before-exit";
const EXIT_ACK_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Default)]
pub(crate) struct QuitCoordinator {
    exiting: AtomicBool,
    pending_ack: Mutex<Option<oneshot::Sender<()>>>,
}

impl QuitCoordinator {
    fn begin(&self) -> Option<oneshot::Receiver<()>> {
        if self
            .exiting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        let Ok(mut pending_ack) = self.pending_ack.lock() else {
            self.exiting.store(false, Ordering::SeqCst);
            return None;
        };
        *pending_ack = Some(sender);
        Some(receiver)
    }

    fn acknowledge(&self) {
        if let Ok(mut pending_ack) = self.pending_ack.lock() {
            if let Some(sender) = pending_ack.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum MainCloseAction {
    HideToTray,
    ExitApplication,
}

fn main_close_action(close_to_tray: bool) -> MainCloseAction {
    if close_to_tray {
        MainCloseAction::HideToTray
    } else {
        MainCloseAction::ExitApplication
    }
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示 Cadilume")
        .text("play-pause", "播放 / 暂停")
        .text("toggle-desktop-lyrics", "显示 / 隐藏桌面歌词")
        .separator()
        .text("quit", "退出 Cadilume")
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .tooltip("Cadilume")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = reveal_main_window(app);
            }
            "play-pause" => {
                let _ = app.emit("tray-player-toggle", ());
            }
            "toggle-desktop-lyrics" => {
                let _ = toggle_desktop_lyrics_window(app);
            }
            "quit" => request_app_quit(app),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    if window.label() == DESKTOP_LYRICS_WINDOW_LABEL {
        api.prevent_close();
        let _ = window.hide();
        let _ = window
            .app_handle()
            .emit(DESKTOP_LYRICS_VISIBILITY_EVENT, false);
        return;
    }

    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let Some(state) = window.app_handle().try_state::<PlexState>() else {
        return;
    };
    api.prevent_close();
    match main_close_action(state.close_to_tray()) {
        MainCloseAction::HideToTray => {
            let _ = window.hide();
        }
        MainCloseAction::ExitApplication => request_app_quit(window.app_handle()),
    }
}

pub(crate) fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    }
    Ok(())
}

fn show_desktop_lyrics_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if let Some(window) = app.get_webview_window(DESKTOP_LYRICS_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        app.emit(DESKTOP_LYRICS_VISIBILITY_EVENT, true)?;
        return Ok(true);
    }
    Ok(false)
}

fn hide_desktop_lyrics_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if let Some(window) = app.get_webview_window(DESKTOP_LYRICS_WINDOW_LABEL) {
        window.hide()?;
    }
    app.emit(DESKTOP_LYRICS_VISIBILITY_EVENT, false)?;
    Ok(false)
}

fn toggle_desktop_lyrics_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if let Some(window) = app.get_webview_window(DESKTOP_LYRICS_WINDOW_LABEL) {
        if window.is_visible()? {
            window.hide()?;
            app.emit(DESKTOP_LYRICS_VISIBILITY_EVENT, false)?;
            return Ok(false);
        } else {
            window.show()?;
            window.unminimize()?;
            app.emit(DESKTOP_LYRICS_VISIBILITY_EVENT, true)?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    reveal_main_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn show_desktop_lyrics(app: AppHandle) -> Result<bool, String> {
    show_desktop_lyrics_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn toggle_desktop_lyrics(app: AppHandle) -> Result<bool, String> {
    toggle_desktop_lyrics_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hide_desktop_lyrics(app: AppHandle) -> Result<bool, String> {
    hide_desktop_lyrics_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quit_app(app: AppHandle, _state: State<'_, PlexState>) {
    request_app_quit(&app);
}

#[tauri::command]
pub fn acknowledge_quit(state: State<'_, QuitCoordinator>) {
    state.acknowledge();
}

fn request_app_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(coordinator) = app.try_state::<QuitCoordinator>() else {
        app.exit(0);
        return;
    };
    let Some(receiver) = coordinator.begin() else {
        return;
    };
    let app_handle = app.clone();
    if app
        .emit_to(MAIN_WINDOW_LABEL, APP_BEFORE_EXIT_EVENT, ())
        .is_err()
    {
        coordinator.acknowledge();
    }
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(EXIT_ACK_TIMEOUT, receiver).await;
        app_handle.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::{main_close_action, MainCloseAction, QuitCoordinator};

    #[test]
    fn main_window_close_behavior_maps_to_an_explicit_process_action() {
        assert_eq!(main_close_action(true), MainCloseAction::HideToTray);
        assert_eq!(main_close_action(false), MainCloseAction::ExitApplication);
    }

    #[test]
    fn quit_coordinator_accepts_only_one_pending_exit_and_acknowledges_it() {
        let coordinator = QuitCoordinator::default();
        let receiver = coordinator.begin().expect("first exit should begin");
        assert!(coordinator.begin().is_none());
        coordinator.acknowledge();
        assert!(receiver.blocking_recv().is_ok());
    }
}

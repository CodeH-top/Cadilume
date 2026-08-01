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

use crate::plex::{status_icon_platform, BrandPreset, PlexState};

const TRAY_ID: &str = "cadilume-tray";
const MAIN_WINDOW_LABEL: &str = "main";
const APP_BEFORE_EXIT_EVENT: &str = "app://before-exit";
const EXIT_ACK_TIMEOUT: Duration = Duration::from_millis(750);

#[cfg(target_os = "macos")]
const MENU_BAR_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-template.png");

#[cfg(target_os = "macos")]
const DOCK_ICON_AMBER_BYTES: &[u8] = include_bytes!("../icons/presets/amber.png");
#[cfg(target_os = "macos")]
const DOCK_ICON_VERDANT_BYTES: &[u8] = include_bytes!("../icons/presets/verdant.png");
#[cfg(target_os = "macos")]
const DOCK_ICON_AZURE_BYTES: &[u8] = include_bytes!("../icons/presets/azure.png");

#[cfg(target_os = "macos")]
fn menu_bar_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(MENU_BAR_ICON_BYTES)
}

#[cfg(target_os = "macos")]
fn dock_icon_bytes(preset: BrandPreset) -> &'static [u8] {
    match preset {
        BrandPreset::Amber => DOCK_ICON_AMBER_BYTES,
        BrandPreset::Verdant => DOCK_ICON_VERDANT_BYTES,
        BrandPreset::Azure => DOCK_ICON_AZURE_BYTES,
    }
}

/// macOS owns its Dock image through AppKit, so changing the current visual
/// preset can update the running application without changing the packaged
/// default. Other platforms silently retain their bundle icon.
#[cfg(target_os = "macos")]
pub(crate) fn update_dock_icon<R: Runtime>(app: &AppHandle<R>, preset: BrandPreset) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let icon_bytes = dock_icon_bytes(preset);
    let _ = app.run_on_main_thread(move || {
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let app = NSApplication::sharedApplication(mtm);
        let data = NSData::with_bytes(icon_bytes);
        if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
            unsafe { app.setApplicationIconImage(Some(&icon)) };
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn update_dock_icon<R: Runtime>(_app: &AppHandle<R>, _preset: BrandPreset) {}

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
enum StatusIconAction {
    Create,
    Remove,
    Noop,
}

fn status_icon_action(enabled: bool, icon_exists: bool) -> StatusIconAction {
    match (enabled, icon_exists) {
        (true, false) => StatusIconAction::Create,
        (false, true) => StatusIconAction::Remove,
        _ => StatusIconAction::Noop,
    }
}

#[cfg(target_os = "macos")]
fn should_reveal_main_window_on_reopen(_has_visible_windows: bool) -> bool {
    // A Dock click must always bring the main window back, even if macOS reports
    // another visible application window.
    true
}

pub fn handle_run_event<R: Runtime>(app: &AppHandle<R>, event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if matches!(&event, tauri::RunEvent::Ready) {
        if let Some(state) = app.try_state::<PlexState>() {
            update_dock_icon(app, state.brand_preset());
        }
    }

    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen {
        has_visible_windows,
        ..
    } = event
    {
        if should_reveal_main_window_on_reopen(has_visible_windows) {
            let _ = reveal_main_window(app);
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

fn build_status_icon<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示 Cadilume")
        .text("play-pause", "播放 / 暂停")
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
            "quit" => request_app_quit(app),
            _ => {}
        });

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon(menu_bar_icon()?).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub fn set_status_icon_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> tauri::Result<()> {
    if status_icon_platform().is_none() {
        return Ok(());
    }

    match status_icon_action(enabled, app.tray_by_id(TRAY_ID).is_some()) {
        StatusIconAction::Create => build_status_icon(app),
        StatusIconAction::Remove => {
            drop(app.remove_tray_by_id(TRAY_ID));
            Ok(())
        }
        StatusIconAction::Noop => Ok(()),
    }
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    api.prevent_close();
    let _ = window.minimize();
}

pub(crate) fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    reveal_main_window(&app).map_err(|error| error.to_string())
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
    use super::{status_icon_action, QuitCoordinator, StatusIconAction};

    #[cfg(target_os = "macos")]
    use super::{dock_icon_bytes, menu_bar_icon, should_reveal_main_window_on_reopen};
    #[cfg(target_os = "macos")]
    use crate::plex::BrandPreset;

    #[test]
    fn status_icon_changes_create_or_remove_only_when_its_native_state_differs() {
        assert_eq!(status_icon_action(true, false), StatusIconAction::Create);
        assert_eq!(status_icon_action(false, true), StatusIconAction::Remove);
        assert_eq!(status_icon_action(true, true), StatusIconAction::Noop);
        assert_eq!(status_icon_action(false, false), StatusIconAction::Noop);
    }

    #[test]
    fn quit_coordinator_accepts_only_one_pending_exit_and_acknowledges_it() {
        let coordinator = QuitCoordinator::default();
        let receiver = coordinator.begin().expect("first exit should begin");
        assert!(coordinator.begin().is_none());
        coordinator.acknowledge();
        assert!(receiver.blocking_recv().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_always_reveals_main_window() {
        assert!(should_reveal_main_window_on_reopen(false));
        assert!(should_reveal_main_window_on_reopen(true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fixed_brand_dock_icons_are_distinct_retina_pngs() {
        let amber = tauri::image::Image::from_bytes(dock_icon_bytes(BrandPreset::Amber))
            .expect("amber Dock icon should decode");
        let verdant = tauri::image::Image::from_bytes(dock_icon_bytes(BrandPreset::Verdant))
            .expect("verdant Dock icon should decode");
        let azure = tauri::image::Image::from_bytes(dock_icon_bytes(BrandPreset::Azure))
            .expect("azure Dock icon should decode");

        for icon in [&amber, &verdant, &azure] {
            assert_eq!((icon.width(), icon.height()), (1024, 1024));
        }
        assert_ne!(amber.rgba(), verdant.rgba());
        assert_ne!(verdant.rgba(), azure.rgba());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn menu_bar_icon_is_a_large_transparent_monochrome_template() {
        let icon = menu_bar_icon().expect("menu bar template icon should decode");
        assert_eq!((icon.width(), icon.height()), (36, 36));

        let mut opaque_bounds = (36_u32, 36_u32, 0_u32, 0_u32);
        let mut opaque_pixels = 0_u32;
        for (index, pixel) in icon.rgba().chunks_exact(4).enumerate() {
            if pixel[3] == 0 {
                continue;
            }
            assert_eq!(&pixel[..3], &[0, 0, 0]);
            let x = index as u32 % icon.width();
            let y = index as u32 / icon.width();
            opaque_bounds.0 = opaque_bounds.0.min(x);
            opaque_bounds.1 = opaque_bounds.1.min(y);
            opaque_bounds.2 = opaque_bounds.2.max(x);
            opaque_bounds.3 = opaque_bounds.3.max(y);
            opaque_pixels += 1;
        }

        assert!(opaque_pixels > 250);
        assert!(opaque_bounds.0 <= 3 && opaque_bounds.1 <= 3);
        assert!(opaque_bounds.2 >= 32 && opaque_bounds.3 >= 32);
        assert_eq!(icon.rgba()[3], 0);
    }
}

mod app_update;
mod audio_cache;
mod audio_engine;
mod diagnostics;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod now_playing;
mod plex;
mod stream_proxy;
mod window;

use std::fs;

use audio_engine::NativeAudioEngineSlot;
use plex::PlexState;
use stream_proxy::StreamProxy;
use tauri::{Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(window::handle_window_event)
        .setup(|app| {
            match app.path().app_log_dir() {
                Ok(log_dir) => {
                    if let Err(error) = diagnostics::initialize(&log_dir) {
                        eprintln!("[启动] 无法初始化诊断日志：{error}");
                    }
                }
                Err(error) => eprintln!("[启动] 无法定位诊断日志目录：{error}"),
            }
            diagnostics::record(
                "启动",
                format_args!(
                    "version={} platform={} profile={}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                    if cfg!(debug_assertions) {
                        "debug"
                    } else {
                        "release"
                    }
                ),
            );
            let config_dir = app.path().app_config_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            fs::create_dir_all(&config_dir)?;
            let plex_state = PlexState::load(config_dir, cache_dir)?;
            let status_icon_enabled = plex_state.status_icon_enabled();
            app.manage(plex_state);
            let native_cache = app.path().app_cache_dir()?.join("native-audio");
            fs::create_dir_all(&native_cache)?;
            app.manage(NativeAudioEngineSlot::new(native_cache));
            #[cfg(target_os = "macos")]
            now_playing::install(app.handle().clone());
            #[cfg(target_os = "windows")]
            now_playing::install(app.handle().clone());
            app.manage(StreamProxy::start(app.handle().clone())?);
            app.manage(window::QuitCoordinator::default());
            app.manage(app_update::AppUpdateState::default());
            app.listen("playback://log", |event| {
                // Development/diagnostic channel only: the WebView player logs
                // sanitized playback decisions through this event so the same
                // terminal can explain a failing source without exposing PMS
                // URIs, paths, tokens, tickets, or private track identifiers.
                eprintln!("[播放] {}", event.payload());
            });
            window::set_status_icon_enabled(app.handle(), status_icon_enabled)?;
            // macOS development keeps the window hidden so a hot reload does
            // not steal focus; Dock Reopen and the status icon reveal it.
            // Windows has no Dock-Reopen equivalent, so the debug window must
            // remain visible in the taskbar for an unambiguous restore path.
            #[cfg(all(debug_assertions, target_os = "macos"))]
            let _ = &app;
            #[cfg(not(all(debug_assertions, target_os = "macos")))]
            window::reveal_main_window(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            plex::bootstrap,
            plex::create_pin,
            plex::poll_pin,
            plex::logout,
            plex::discover_servers,
            plex::server_get,
            plex::create_playlist,
            plex::remove_playlist_items,
            plex::move_playlist_item,
            plex::get_playlists,
            plex::get_playlist_items,
            plex::add_to_playlist,
            plex::add_tracks_to_playlist,
            plex::update_playlist,
            plex::delete_playlist,
            plex::artwork_url,
            stream_proxy::stream_url,
            plex::lyrics,
            plex::cache_status,
            plex::clear_cache,
            plex::report_timeline,
            plex::scrobble,
            audio_engine::native_audio_load,
            audio_engine::native_audio_queue_next_source,
            audio_engine::native_audio_play,
            audio_engine::native_audio_pause,
            audio_engine::native_audio_stop,
            audio_engine::native_audio_heartbeat,
            audio_engine::native_audio_seek,
            audio_engine::native_audio_set_volume,
            audio_engine::native_audio_set_artwork,
            audio_engine::native_audio_status,
            audio_engine::native_audio_device_check,
            audio_engine::native_audio_cache_status,
            audio_engine::native_audio_clear_cache,
            audio_engine::native_audio_clear_queue,
            audio_engine::native_audio_output_devices,
            audio_engine::native_audio_set_output_device,
            audio_engine::native_queue_set,
            audio_engine::native_queue_peek_next,
            audio_engine::native_queue_next,
            audio_engine::native_queue_previous,
            audio_engine::native_queue_set_repeat,
            audio_engine::native_queue_set_shuffle,
            plex::set_status_icon_enabled,
            plex::set_close_behavior,
            plex::set_device_name,
            plex::set_brand_preset,
            app_update::check_app_update,
            app_update::install_app_update,
            app_update::set_auto_update_enabled,
            window::show_main_window,
            window::quit_app,
            window::acknowledge_quit,
        ])
        .build(tauri::generate_context!())
        .expect("Cadilume 启动失败");

    app.run(window::handle_run_event);
}

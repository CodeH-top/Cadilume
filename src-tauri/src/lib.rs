mod app_update;
mod audio_cache;
mod audio_engine;
mod audio_resampler;
mod catalog_cache;
mod diagnostics;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod now_playing;
mod plex;
mod stream_proxy;
mod window;

use audio_engine::NativeAudioEngineSlot;
use plex::PlexState;
use stream_proxy::StreamProxy;
use tauri::{Listener, Manager};

/// The macOS parent process uses a short-lived copy of this executable to
/// probe CoreAudio routes that can otherwise block an in-process HAL thread.
pub fn audio_output_probe_exit_code() -> Option<i32> {
    audio_engine::audio_output_probe_exit_code()
}

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
            // Construct only the in-memory shell on the setup thread. Config,
            // credential restore/migration, artwork-cache recovery, and the
            // macOS computer name are loaded by the worker below so opening
            // the window never waits on filesystem or subprocess I/O.
            let plex_state = PlexState::new(config_dir, cache_dir)?;
            app.manage(plex_state);
            let native_cache = app.path().app_cache_dir()?.join("native-audio");
            app.manage(NativeAudioEngineSlot::new(native_cache));
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
            let initialization_handle = app.handle().clone();
            std::thread::Builder::new()
                .name("cadilume-startup".to_string())
                .spawn(move || {
                    let state = initialization_handle.state::<PlexState>();
                    let result = state.initialize();
                    let error = result.as_ref().err().map(ToString::to_string);
                    state.finish_initialization(error.clone());
                    if let Some(error) = error {
                        diagnostics::record("启动", format_args!("后台初始化失败 error={error}"));
                    }
                })
                .map_err(|error| format!("无法启动后台初始化线程：{error}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            plex::bootstrap,
            plex::refresh_account,
            plex::create_pin,
            plex::cancel_pin,
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
            catalog_cache::read_initial_library_cache,
            catalog_cache::write_initial_library_cache,
            catalog_cache::clear_initial_library_cache,
            plex::report_timeline,
            plex::scrobble,
            audio_engine::native_audio_warmup,
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
            window::mark_main_ui_ready,
            window::quit_app,
            window::acknowledge_quit,
        ])
        .build(tauri::generate_context!())
        .expect("Cadilume 启动失败");

    app.run(window::handle_run_event);
}

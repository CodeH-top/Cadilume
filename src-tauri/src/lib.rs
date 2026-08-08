mod audio_engine;
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
        .on_window_event(window::handle_window_event)
        .setup(|app| {
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
            app.listen("playback://log", |event| {
                // Development/diagnostic channel only: the WebView player logs
                // sanitized playback decisions through this event so the same
                // terminal can explain a failing source without exposing PMS
                // URIs, paths, tokens, tickets, or private track identifiers.
                eprintln!("[播放] {}", event.payload());
            });
            window::set_status_icon_enabled(app.handle(), status_icon_enabled)?;
            // Dev builds start with the window hidden (silent background);
            // the user brings it up via Dock (Reopen) or the tray menu.
            #[cfg(debug_assertions)]
            let _ = &app;
            #[cfg(not(debug_assertions))]
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
            audio_engine::native_audio_precache,
            audio_engine::native_audio_queue_next_source,
            audio_engine::native_audio_play,
            audio_engine::native_audio_pause,
            audio_engine::native_audio_stop,
            audio_engine::native_audio_heartbeat,
            audio_engine::native_audio_seek,
            audio_engine::native_audio_set_volume,
            audio_engine::native_audio_status,
            audio_engine::native_audio_device_check,
            audio_engine::native_audio_cache_status,
            audio_engine::native_audio_clear_cache,
            audio_engine::native_audio_output_devices,
            audio_engine::native_audio_set_output_device,
            audio_engine::native_queue_set,
            audio_engine::native_queue_peek_next,
            audio_engine::native_queue_next,
            audio_engine::native_queue_previous,
            audio_engine::native_queue_set_repeat,
            audio_engine::native_queue_set_shuffle,
            plex::set_status_icon_enabled,
            plex::set_device_name,
            plex::set_brand_preset,
            window::show_main_window,
            window::quit_app,
            window::acknowledge_quit,
        ])
        .build(tauri::generate_context!())
        .expect("Cadilume 启动失败");

    app.run(window::handle_run_event);
}

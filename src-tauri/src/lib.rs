mod plex;
mod stream_proxy;
mod window;

use std::fs;

use plex::PlexState;
use stream_proxy::StreamProxy;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(window::handle_window_event)
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            fs::create_dir_all(&config_dir)?;
            app.manage(PlexState::load(config_dir, cache_dir)?);
            app.manage(StreamProxy::start(app.handle().clone())?);
            app.manage(window::QuitCoordinator::default());
            window::build_tray(&app.handle())?;
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
            plex::get_playlists,
            plex::get_playlist_items,
            plex::add_to_playlist,
            plex::artwork_url,
            stream_proxy::stream_url,
            plex::lyrics,
            plex::cache_status,
            plex::clear_cache,
            plex::report_timeline,
            plex::scrobble,
            plex::set_close_behavior,
            window::show_main_window,
            window::quit_app,
            window::acknowledge_quit,
        ])
        .build(tauri::generate_context!())
        .expect("Cadilume 启动失败");

    app.run(window::handle_run_event);
}

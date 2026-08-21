// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = cadilume_lib::audio_output_probe_exit_code() {
        std::process::exit(exit_code);
    }
    cadilume_lib::run()
}

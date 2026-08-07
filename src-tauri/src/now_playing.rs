//! macOS Now Playing / Remote Command Center integration.

use std::sync::{Mutex, OnceLock};
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPNowPlayingInfoCenter, MPRemoteCommand,
    MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};
use tauri::{AppHandle, Emitter};

static COMMAND_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

const KEY_TITLE: &str = "MPMediaItemPropertyTitle";
const KEY_ARTIST: &str = "MPMediaItemPropertyArtist";
const KEY_ALBUM: &str = "MPMediaItemPropertyAlbumTitle";
const KEY_DURATION: &str = "MPMediaItemPropertyPlaybackDuration";
const KEY_POSITION: &str = "MPNowPlayingInfoPropertyElapsedPlaybackTime";
const KEY_RATE: &str = "MPNowPlayingInfoPropertyPlaybackRate";

fn app_handle() -> Option<AppHandle> {
    COMMAND_APP
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

fn emit_remote(command: &str, position: Option<f64>) {
    if let Some(app) = app_handle() {
        let mut payload = serde_json::json!({ "type": "remote", "command": command });
        if let Some(position) = position {
            payload["position"] = serde_json::json!(position);
        }
        let _ = app.emit("native-audio://event", payload);
    }
}

fn register_command(
    command: &MPRemoteCommand,
    run: impl Fn(&MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus + 'static,
) {
    let block = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
        run(unsafe { event.as_ref() })
    });
    unsafe {
        command.addTargetWithHandler(&block);
    }
}

/// Register remote commands and keep the app handle for event forwarding.
pub fn install(app: AppHandle) {
    *COMMAND_APP
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap() = Some(app);
    let center = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };

    register_command(unsafe { &center.playCommand() }, |_| {
        emit_remote("play", None);
        MPRemoteCommandHandlerStatus::Success
    });
    register_command(unsafe { &center.pauseCommand() }, |_| {
        emit_remote("pause", None);
        MPRemoteCommandHandlerStatus::Success
    });
    register_command(unsafe { &center.togglePlayPauseCommand() }, |_| {
        emit_remote("toggle", None);
        MPRemoteCommandHandlerStatus::Success
    });
    register_command(unsafe { &center.nextTrackCommand() }, |_| {
        emit_remote("next", None);
        MPRemoteCommandHandlerStatus::Success
    });
    register_command(unsafe { &center.previousTrackCommand() }, |_| {
        emit_remote("previous", None);
        MPRemoteCommandHandlerStatus::Success
    });
    register_command(unsafe { &center.changePlaybackPositionCommand() }, |event| {
        let position_event = unsafe {
            &*(event as *const MPRemoteCommandEvent as *const MPChangePlaybackPositionCommandEvent)
        };
        let position = unsafe { position_event.positionTime() };
        emit_remote("seek", Some(position));
        MPRemoteCommandHandlerStatus::Success
    });
}

/// Publish the current track metadata and playback state to the system.
pub fn update_metadata(
    title: &str,
    artist: &str,
    album: &str,
    duration_seconds: Option<f64>,
    position_seconds: f64,
    playing: bool,
) {
    let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
    let mut keys: Vec<Retained<NSString>> = Vec::new();
    let mut values: Vec<Retained<AnyObject>> = Vec::new();
    let mut push_string = |key: &str, value: &str| {
        if !value.is_empty() {
            let text: Retained<NSString> = NSString::from_str(value);
            keys.push(NSString::from_str(key));
            values.push(text.into_super().into_super());
        }
    };
    push_string(KEY_TITLE, title);
    push_string(KEY_ARTIST, artist);
    push_string(KEY_ALBUM, album);
    let mut push_number = |key: &str, value: f64| {
        let number: Retained<NSNumber> = NSNumber::new_f64(value);
        keys.push(NSString::from_str(key));
        values.push(number.into_super().into_super().into_super());
    };
    if let Some(duration) = duration_seconds {
        push_number(KEY_DURATION, duration);
    }
    push_number(KEY_POSITION, position_seconds);
    push_number(KEY_RATE, if playing { 1.0 } else { 0.0 });

    let key_refs: Vec<&NSString> = keys.iter().map(|key| key.as_ref()).collect();
    let dictionary = NSDictionary::from_retained_objects(&key_refs, &values);
    unsafe {
        center.setNowPlayingInfo(Some(&dictionary));
    }
}

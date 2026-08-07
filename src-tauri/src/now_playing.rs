//! System media controls / Now Playing integration.
//! macOS: MPNowPlayingInfoCenter + MPRemoteCommandCenter.
//! Windows: SystemMediaTransportControls (SMTC).

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;
    use std::sync::{Mutex, OnceLock};

    use block2::RcBlock;
    use objc2_core_foundation::CGSize;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSImage;
    use objc2_foundation::{NSData, NSDictionary, NSNumber, NSString};
    use objc2_media_player::{
        MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPNowPlayingInfoCenter,
        MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
    };
    use tauri::{AppHandle, Emitter};

    static COMMAND_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

    const KEY_TITLE: &str = "MPMediaItemPropertyTitle";
    const KEY_ARTIST: &str = "MPMediaItemPropertyArtist";
    const KEY_ALBUM: &str = "MPMediaItemPropertyAlbumTitle";
    const KEY_DURATION: &str = "MPMediaItemPropertyPlaybackDuration";
    const KEY_POSITION: &str = "MPNowPlayingInfoPropertyElapsedPlaybackTime";
    const KEY_RATE: &str = "MPNowPlayingInfoPropertyPlaybackRate";
    const KEY_ARTWORK: &str = "MPMediaItemPropertyArtwork";

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

    /// Build an `MPMediaItemArtwork` from image bytes. AppKit classes are
    /// main-thread-only, so callers must run this on the main thread.
    fn make_artwork(bytes: &[u8]) -> Option<Retained<MPMediaItemArtwork>> {
        let data = NSData::with_bytes(bytes);
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        let block = RcBlock::new(move |_size: CGSize| -> NonNull<NSImage> {
            NonNull::from(&*image)
        });
        Some(unsafe {
            MPMediaItemArtwork::initWithBoundsSize_requestHandler(
                MPMediaItemArtwork::alloc(),
                CGSize::new(512.0, 512.0),
                &block,
            )
        })
    }

    /// Build and publish the now-playing dictionary on the current thread.
    /// `update_metadata` dispatches this to the main thread; tests call it
    /// directly to verify the dictionary content.
    fn build_and_set_now_playing(
        title: &str,
        artist: &str,
        album: &str,
        duration_seconds: Option<f64>,
        position_seconds: f64,
        playing: bool,
        artwork: Option<&[u8]>,
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
        if let Some(bytes) = artwork {
            if let Some(artwork_object) = make_artwork(bytes) {
                keys.push(NSString::from_str(KEY_ARTWORK));
                values.push(artwork_object.into_super().into_super());
            }
        }

        let key_refs: Vec<&NSString> = keys.iter().map(|key| key.as_ref()).collect();
        let dictionary = NSDictionary::from_retained_objects(&key_refs, &values);
        unsafe {
            center.setNowPlayingInfo(Some(&dictionary));
        }
    }

    pub fn update_metadata(
        title: &str,
        artist: &str,
        album: &str,
        duration_seconds: Option<f64>,
        position_seconds: f64,
        playing: bool,
        artwork: Option<&[u8]>,
    ) {
        let Some(app) = app_handle() else {
            return;
        };
        let title = title.to_string();
        let artist = artist.to_string();
        let album = album.to_string();
        let artwork = artwork.map(|bytes| bytes.to_vec());
        let _ = app.run_on_main_thread(move || {
            build_and_set_now_playing(
                &title,
                &artist,
                &album,
                duration_seconds,
                position_seconds,
                playing,
                artwork.as_deref(),
            );
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn now_playing_info_dictionary_roundtrips() {
            build_and_set_now_playing(
                "测试歌名",
                "测试歌手",
                "测试专辑",
                Some(180.0),
                12.5,
                true,
                None,
            );
            let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
            let info = unsafe { center.nowPlayingInfo() };
            let info = info.expect("设置后应能读回 now playing 信息");
            let title = info.objectForKey(&NSString::from_str(KEY_TITLE));
            let title = title.expect("应有标题键");
            let title_string = title
                .downcast::<objc2_foundation::NSString>()
                .expect("标题应为 NSString");
            assert_eq!(title_string.to_string(), "测试歌名");
            let rate = info.objectForKey(&NSString::from_str(KEY_RATE));
            assert!(rate.is_some(), "应有播放速率键");
            // 清掉，避免影响真实运行时的控制中心。
            unsafe {
                center.setNowPlayingInfo(None);
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::sync::{Mutex, OnceLock};

    use tauri::{AppHandle, Emitter};
    use windows::core::HSTRING;
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    };

    static CONTROLS: OnceLock<SystemMediaTransportControls> = OnceLock::new();
    static COMMAND_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

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

    fn seconds_to_timespan(seconds: f64) -> TimeSpan {
        TimeSpan {
            Duration: (seconds.max(0.0) * 10_000_000.0) as i64,
        }
    }

    pub fn install(app: AppHandle) {
        *COMMAND_APP
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = Some(app);
        let Ok(controls) = SystemMediaTransportControls::GetForCurrentView() else {
            return;
        };
        let _ = controls.SetIsPlayEnabled(true);
        let _ = controls.SetIsPauseEnabled(true);
        let _ = controls.SetIsNextEnabled(true);
        let _ = controls.SetIsPreviousEnabled(true);
        let _ = controls.SetIsEnabled(true);
        let _ = CONTROLS.set(controls.clone());

        let handler = TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_sender, args| {
            if let Some(args) = args {
                let Ok(button) = args.Button() else {
                    return Ok(());
                };
                match button {
                    SystemMediaTransportControlsButton::Play => emit_remote("play", None),
                    SystemMediaTransportControlsButton::Pause => emit_remote("pause", None),
                    SystemMediaTransportControlsButton::Next => emit_remote("next", None),
                    SystemMediaTransportControlsButton::Previous => emit_remote("previous", None),
                    _ => {}
                }
            }
            Ok(())
        });
        let _ = controls.ButtonPressed(&handler);
    }

    pub fn update_metadata(
        title: &str,
        artist: &str,
        album: &str,
        duration_seconds: Option<f64>,
        position_seconds: f64,
        playing: bool,
        _artwork: Option<&[u8]>,
    ) {
        let Some(controls) = CONTROLS.get() else {
            return;
        };
        let Ok(updater) = controls.DisplayUpdater() else {
            return;
        };
        let _ = updater.SetType(MediaPlaybackType::Music);
        let Ok(music) = updater.MusicProperties() else {
            return;
        };
        if !title.is_empty() {
            let _ = music.SetTitle(&HSTRING::from(title));
        }
        if !artist.is_empty() {
            let _ = music.SetArtist(&HSTRING::from(artist));
        }
        if !album.is_empty() {
            let _ = music.SetAlbumTitle(&HSTRING::from(album));
        }
        let _ = controls.SetPlaybackStatus(if playing {
            MediaPlaybackStatus::Playing
        } else {
            MediaPlaybackStatus::Paused
        });
        let Ok(timeline) = SystemMediaTransportControlsTimelineProperties::new() else {
            return;
        };
        let _ = timeline.SetStartTime(seconds_to_timespan(0.0));
        let _ = timeline.SetMinSeekTime(seconds_to_timespan(0.0));
        if let Some(duration) = duration_seconds {
            let _ = timeline.SetEndTime(seconds_to_timespan(duration));
            let _ = timeline.SetMaxSeekTime(seconds_to_timespan(duration));
        }
        let _ = timeline.SetPosition(seconds_to_timespan(position_seconds));
        let _ = controls.UpdateTimelineProperties(&timeline);
        let _ = updater.Update();
    }
}

#[cfg(target_os = "macos")]
pub use macos::{install, update_metadata};
#[cfg(target_os = "windows")]
pub use windows::{install, update_metadata};

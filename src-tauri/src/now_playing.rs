//! System media controls / Now Playing integration.
//! macOS: MPNowPlayingInfoCenter + MPRemoteCommandCenter.
//! Windows: SystemMediaTransportControls (SMTC).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlaybackState {
    Playing,
    Paused,
    Stopped,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::PlaybackState;
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::NSImage;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSData, NSDictionary, NSNumber, NSString};
    use objc2_media_player::{
        MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle,
        MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration,
        MPMediaItemPropertyTitle, MPNowPlayingInfoCenter, MPNowPlayingInfoMediaType,
        MPNowPlayingInfoPropertyDefaultPlaybackRate, MPNowPlayingInfoPropertyElapsedPlaybackTime,
        MPNowPlayingInfoPropertyMediaType, MPNowPlayingInfoPropertyPlaybackRate,
        MPNowPlayingPlaybackState, MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent,
        MPRemoteCommandHandlerStatus,
    };
    use tauri::{AppHandle, Emitter};

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

    fn register_command(
        command: &MPRemoteCommand,
        run: impl Fn(&MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus + 'static,
    ) {
        let block = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
            run(unsafe { event.as_ref() })
        });
        unsafe {
            command.setEnabled(true);
            command.addTargetWithHandler(&block);
        }
    }

    pub fn install(app: AppHandle) {
        *COMMAND_APP.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(app);
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
        register_command(
            unsafe { &center.changePlaybackPositionCommand() },
            |event| {
                let position_event = unsafe {
                    &*(event as *const MPRemoteCommandEvent
                        as *const MPChangePlaybackPositionCommandEvent)
                };
                let position = unsafe { position_event.positionTime() };
                emit_remote("seek", Some(position));
                MPRemoteCommandHandlerStatus::Success
            },
        );
    }

    /// Build an `MPMediaItemArtwork` from image bytes. AppKit classes are
    /// main-thread-only, so callers must run this on the main thread.
    fn make_artwork(bytes: &[u8]) -> Option<Retained<MPMediaItemArtwork>> {
        let data = NSData::with_bytes(bytes);
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        let block =
            RcBlock::new(move |_size: CGSize| -> NonNull<NSImage> { NonNull::from(&*image) });
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
        playback_state: PlaybackState,
        artwork: Option<&[u8]>,
    ) {
        // 变更时输出脱敏诊断：确认系统更新确实被调用并带上了内容。
        static LAST_LOGGED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
        let log_key = format!(
            "{title}|{artist}|{album}|state={playback_state:?}|artwork={}",
            artwork.map(|bytes| bytes.len()).unwrap_or(0)
        );
        {
            let mut last = LAST_LOGGED.get_or_init(|| Mutex::new(None)).lock().unwrap();
            if last.as_deref() != Some(&log_key) {
                eprintln!(
                    "[播放] NowPlaying 更新：metadata={} state={playback_state:?} artwork_bytes={}",
                    !title.is_empty() || !artist.is_empty() || !album.is_empty(),
                    artwork.map(|bytes| bytes.len()).unwrap_or(0),
                );
                *last = Some(log_key);
            }
        }
        let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
        // MediaPlayer exports NSString constants whose values are the actual
        // dictionary keys. The Objective-C symbol names themselves are not
        // valid keys and are silently ignored by Control Center.
        let mut keys: Vec<&'static NSString> = Vec::new();
        let mut values: Vec<Retained<AnyObject>> = Vec::new();
        let mut push_string = |key: &'static NSString, value: &str| {
            if !value.is_empty() {
                let text: Retained<NSString> = NSString::from_str(value);
                keys.push(key);
                values.push(text.into_super().into_super());
            }
        };
        push_string(unsafe { MPMediaItemPropertyTitle }, title);
        push_string(unsafe { MPMediaItemPropertyArtist }, artist);
        push_string(unsafe { MPMediaItemPropertyAlbumTitle }, album);
        let mut push_number = |key: &'static NSString, value: f64| {
            let number: Retained<NSNumber> = NSNumber::new_f64(value);
            keys.push(key);
            values.push(number.into_super().into_super().into_super());
        };
        if let Some(duration) = duration_seconds {
            push_number(unsafe { MPMediaItemPropertyPlaybackDuration }, duration);
        }
        push_number(
            unsafe { MPNowPlayingInfoPropertyElapsedPlaybackTime },
            position_seconds,
        );
        push_number(
            unsafe { MPNowPlayingInfoPropertyPlaybackRate },
            if playback_state == PlaybackState::Playing {
                1.0
            } else {
                0.0
            },
        );
        push_number(unsafe { MPNowPlayingInfoPropertyDefaultPlaybackRate }, 1.0);
        let media_type = NSNumber::new_usize(MPNowPlayingInfoMediaType::Audio.0);
        keys.push(unsafe { MPNowPlayingInfoPropertyMediaType });
        values.push(media_type.into_super().into_super().into_super());
        if let Some(bytes) = artwork {
            if let Some(artwork_object) = make_artwork(bytes) {
                keys.push(unsafe { MPMediaItemPropertyArtwork });
                values.push(artwork_object.into_super().into_super());
            }
        }

        let dictionary = NSDictionary::from_retained_objects(&keys, &values);
        unsafe {
            center.setNowPlayingInfo(Some(&dictionary));
            center.setPlaybackState(match playback_state {
                PlaybackState::Playing => MPNowPlayingPlaybackState::Playing,
                PlaybackState::Paused => MPNowPlayingPlaybackState::Paused,
                PlaybackState::Stopped => MPNowPlayingPlaybackState::Stopped,
            });
        }
    }

    pub fn update_metadata(
        title: &str,
        artist: &str,
        album: &str,
        duration_seconds: Option<f64>,
        position_seconds: f64,
        playback_state: PlaybackState,
        artwork: Option<Arc<Vec<u8>>>,
    ) {
        let Some(app) = app_handle() else {
            return;
        };
        let title = title.to_string();
        let artist = artist.to_string();
        let album = album.to_string();
        if let Err(error) = app.run_on_main_thread(move || {
            build_and_set_now_playing(
                &title,
                &artist,
                &album,
                duration_seconds,
                position_seconds,
                playback_state,
                artwork.as_deref().map(|bytes| bytes.as_slice()),
            );
        }) {
            eprintln!("[播放] NowPlaying 主线程更新失败：{error}");
        }
    }

    pub fn clear() {
        let Some(app) = app_handle() else {
            return;
        };
        let _ = app.run_on_main_thread(|| {
            let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
            unsafe {
                center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
                center.setNowPlayingInfo(None);
            }
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
                PlaybackState::Playing,
                None,
            );
            let center = unsafe { MPNowPlayingInfoCenter::defaultCenter() };
            let info = unsafe { center.nowPlayingInfo() };
            let info = info.expect("设置后应能读回 now playing 信息");
            let title = info.objectForKey(unsafe { MPMediaItemPropertyTitle });
            let title = title.expect("应有标题键");
            let title_string = title
                .downcast::<objc2_foundation::NSString>()
                .expect("标题应为 NSString");
            assert_eq!(title_string.to_string(), "测试歌名");

            for (key, expected) in [
                (unsafe { MPMediaItemPropertyArtist }, "测试歌手"),
                (unsafe { MPMediaItemPropertyAlbumTitle }, "测试专辑"),
            ] {
                let value = info.objectForKey(key).expect("应有文本元数据键");
                let value = value
                    .downcast::<NSString>()
                    .expect("文本元数据应为 NSString");
                assert_eq!(value.to_string(), expected);
            }

            for (key, expected) in [
                (unsafe { MPMediaItemPropertyPlaybackDuration }, 180.0),
                (unsafe { MPNowPlayingInfoPropertyElapsedPlaybackTime }, 12.5),
                (unsafe { MPNowPlayingInfoPropertyPlaybackRate }, 1.0),
                (unsafe { MPNowPlayingInfoPropertyDefaultPlaybackRate }, 1.0),
            ] {
                let value = info.objectForKey(key).expect("应有数值元数据键");
                let value = value
                    .downcast::<NSNumber>()
                    .expect("数值元数据应为 NSNumber");
                assert_eq!(value.as_f64(), expected);
            }

            let media_type = info
                .objectForKey(unsafe { MPNowPlayingInfoPropertyMediaType })
                .expect("应有媒体类型键")
                .downcast::<NSNumber>()
                .expect("媒体类型应为 NSNumber");
            assert_eq!(media_type.as_usize(), MPNowPlayingInfoMediaType::Audio.0);
            assert!(
                info.objectForKey(&NSString::from_str("MPMediaItemPropertyTitle"))
                    .is_none(),
                "不得把 Objective-C 符号名误当作系统字典键",
            );
            assert_eq!(
                unsafe { center.playbackState() },
                MPNowPlayingPlaybackState::Playing,
                "应显式发布 macOS 播放状态",
            );
            // 清掉，避免影响真实运行时的控制中心。
            unsafe {
                center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
                center.setNowPlayingInfo(None);
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::PlaybackState;
    use std::sync::{Arc, Mutex, OnceLock};

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
        *COMMAND_APP.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(app);
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
        playback_state: PlaybackState,
        _artwork: Option<Arc<Vec<u8>>>,
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
        let _ = controls.SetPlaybackStatus(match playback_state {
            PlaybackState::Playing => MediaPlaybackStatus::Playing,
            PlaybackState::Paused => MediaPlaybackStatus::Paused,
            PlaybackState::Stopped => MediaPlaybackStatus::Stopped,
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

    pub fn clear() {
        let Some(controls) = CONTROLS.get() else {
            return;
        };
        let _ = controls.SetPlaybackStatus(MediaPlaybackStatus::Stopped);
        if let Ok(updater) = controls.DisplayUpdater() {
            let _ = updater.ClearAll();
            let _ = updater.Update();
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{clear, install, update_metadata};
#[cfg(target_os = "windows")]
pub use windows::{clear, install, update_metadata};

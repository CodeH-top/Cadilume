use serde::Serialize;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, State};

use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::plex::PlexState;

#[derive(Default)]
pub struct AppUpdateState {
    operation: Mutex<()>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    version: String,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum AppUpdateEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        downloaded: u64,
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Downloaded,
}

pub const fn is_supported() -> bool {
    !cfg!(debug_assertions)
}

fn ensure_supported() -> Result<(), String> {
    if is_supported() {
        Ok(())
    } else {
        Err("开发构建已禁用应用更新".to_string())
    }
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<AppUpdate>, String> {
    ensure_supported()?;
    let _operation = state.operation.lock().await;
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    Ok(update.map(|update| AppUpdate {
        version: update.version.to_string(),
        current_version: update.current_version.to_string(),
        notes: update.body,
    }))
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
    on_event: Channel<AppUpdateEvent>,
) -> Result<(), String> {
    ensure_supported()?;
    let _operation = state.operation.lock().await;
    let Some(update) = app
        .updater_builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("当前已是最新版本".to_string());
    };

    let mut downloaded = 0_u64;
    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(AppUpdateEvent::Started { content_length });
                }
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = on_event.send(AppUpdateEvent::Progress {
                    downloaded,
                    content_length,
                });
            },
            || {
                let _ = on_event.send(AppUpdateEvent::Downloaded);
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    app.restart();
}

#[tauri::command]
pub fn set_auto_update_enabled(enabled: bool, state: State<'_, PlexState>) -> Result<bool, String> {
    ensure_supported()?;
    state
        .save_auto_update_enabled(enabled)
        .map_err(|error| error.to_string())?;
    Ok(state.auto_update_enabled())
}

#[cfg(test)]
mod tests {
    use super::{is_supported, AppUpdateEvent};

    #[test]
    fn debug_builds_never_expose_app_updates() {
        assert_eq!(is_supported(), !cfg!(debug_assertions));
    }

    #[test]
    fn progress_events_use_the_frontend_channel_shape() {
        let event = serde_json::to_value(AppUpdateEvent::Progress {
            downloaded: 512,
            content_length: Some(1_024),
        })
        .expect("progress event should serialize");

        assert_eq!(event["event"], "progress");
        assert_eq!(event["downloaded"], 512);
        assert_eq!(event["contentLength"], 1_024);
        assert!(event.get("content_length").is_none());
    }
}

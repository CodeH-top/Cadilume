//! Spike: rodio-backed native audio engine behind a thin boundary.
//!
//! kithara's firewheel/cpal pipeline stalled after ~1s in the Tauri process
//! (decoder produced fixed 4096-frame chunks then stopped), so this spike
//! uses the simpler, battle-tested rodio path: cpal output + symphonia
//! decoding, with the Plex stream pre-downloaded to a local cache file.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::Serialize;
use tauri::AppHandle;

/// Native playback engine (rodio + cpal) owned by the Tauri app.
pub struct NativeAudioEngine {
    #[allow(dead_code)]
    sink: MixerDeviceSink,
    player: Player,
    cache_root: PathBuf,
    duration_seconds: Mutex<Option<f64>>,
}

/// Lazy engine slot so the device stream opens on first use.
pub struct NativeAudioEngineSlot {
    cache_root: PathBuf,
    inner: Mutex<Option<Arc<NativeAudioEngine>>>,
}

impl NativeAudioEngineSlot {
    pub fn new(cache_root: PathBuf) -> Self {
        Self {
            cache_root,
            inner: Mutex::new(None),
        }
    }

    pub fn ensure(&self) -> Result<Arc<NativeAudioEngine>, String> {
        let mut guard = self.inner.lock().map_err(|_| "原生引擎状态锁失败".to_string())?;
        if let Some(engine) = guard.as_ref() {
            return Ok(Arc::clone(engine));
        }
        let engine = Arc::new(
            NativeAudioEngine::new(self.cache_root.clone())
                .map_err(|e| format!("原生引擎创建失败: {e}"))?,
        );
        *guard = Some(Arc::clone(&engine));
        Ok(engine)
    }
}

impl NativeAudioEngine {
    pub fn new(cache_root: PathBuf) -> anyhow::Result<Self> {
        let builder = DeviceSinkBuilder::from_default_device()
            .map_err(|e| anyhow::anyhow!("打开默认音频设备失败: {e}"))?;
        let sink = builder
            .open_stream()
            .map_err(|e| anyhow::anyhow!("音频流启动失败: {e}"))?;
        let player = Player::connect_new(sink.mixer());
        // 原生引擎默认音量取 20%，避免比 WebView 播放明显更响。
        player.set_volume(0.2);
        Ok(Self {
            sink,
            player,
            cache_root,
            duration_seconds: Mutex::new(None),
        })
    }

    fn player(&self) -> &Player {
        &self.player
    }

    /// Load a local media file and start playing it.
    pub fn load_and_play(&self, path: &str) -> Result<usize, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("打开媒体文件失败: {e}"))?;
        let decoder = Decoder::new(file).map_err(|e| format!("媒体解码失败: {e}"))?;
        let total = decoder.total_duration().map(|d| d.as_secs_f64());
        *self.duration_seconds.lock().map_err(|_| "时长状态锁失败".to_string())? = total;
        self.player.clear();
        self.player.append(decoder);
        self.player.play();
        eprintln!(
            "[原生] rodio 载入媒体成功 队列={} 时长={:?}",
            self.player.len(),
            total,
        );
        Ok(self.player.len())
    }

    /// Spike: download a loopback media URL to the local cache and play the
    /// file through rodio. Doubles as the planned disk-cache strategy.
    pub async fn load_cached_and_play(
        &self,
        source: &str,
        cache_key: Option<String>,
    ) -> Result<usize, String> {
        if !(source.starts_with("http://") || source.starts_with("https://")) {
            return self.load_and_play(source);
        }
        let response = reqwest::Client::new()
            .get(source)
            .send()
            .await
            .map_err(|e| format!("缓存下载请求失败: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("缓存下载返回 HTTP {status}"));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("缓存下载读取失败: {e}"))?;
        let ext = match content_type.split(';').next().unwrap_or("").trim() {
            "audio/flac" => "flac",
            "audio/mpeg" => "mp3",
            "audio/x-wav" | "audio/wav" | "audio/wave" => "wav",
            "audio/mp4" | "audio/aac" | "audio/x-m4a" => "m4a",
            "audio/ogg" => "ogg",
            _ => "bin",
        };
        let key = cache_key
            .filter(|value| {
                !value.is_empty()
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let dir = self.cache_root.join("downloads");
        std::fs::create_dir_all(&dir).map_err(|e| format!("缓存目录创建失败: {e}"))?;
        let final_path = dir.join(format!("{key}.{ext}"));
        let existed = final_path.exists();
        if !existed {
            let part_path = dir.join(format!("{key}.{ext}.part"));
            std::fs::write(&part_path, &bytes)
                .map_err(|e| format!("缓存文件写入失败: {e}"))?;
            std::fs::rename(&part_path, &final_path)
                .map_err(|e| format!("缓存文件提交失败: {e}"))?;
        }
        eprintln!(
            "[原生] 已落盘缓存 key={key} 字节={} 类型={content_type} 命中={existed}",
            bytes.len(),
        );
        self.load_and_play(final_path.to_str().unwrap())
    }
}

#[derive(Serialize)]
pub struct NativeStatus {
    pub is_playing: bool,
    pub position_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub volume: f32,
    pub item_count: usize,
    pub current_index: Option<usize>,
}

/// Spike diagnostic: verify the OS audio device can actually be opened from
/// inside the Tauri process.
#[tauri::command]
pub fn native_audio_device_check() -> serde_json::Value {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let mut result = serde_json::Map::new();
    let Some(device) = host.default_output_device() else {
        result.insert("device".into(), serde_json::Value::String("无默认输出设备".into()));
        eprintln!("[原生] 设备自检：无默认输出设备");
        return serde_json::Value::Object(result);
    };
    result.insert(
        "device".into(),
        serde_json::Value::String(
            device
                .description()
                .map(|description| description.to_string())
                .unwrap_or_else(|_| "未知".into()),
        ),
    );
    match device.default_output_config() {
        Ok(config) => {
            let sample_format = config.sample_format();
            let config: cpal::StreamConfig = config.into();
            result.insert(
                "config".into(),
                serde_json::Value::String(format!(
                    "{}Hz {}ch {:?} buffer={:?}",
                    config.sample_rate,
                    config.channels,
                    sample_format,
                    config.buffer_size,
                )),
            );
            let error = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
            let error_callback = {
                let error = std::sync::Arc::clone(&error);
                move |err: cpal::StreamError| {
                    *error.lock().unwrap() = Some(format!("{err}"));
                }
            };
            let stream = device.build_output_stream(
                &config,
                move |_data: &mut [f32], _info: &cpal::OutputCallbackInfo| {},
                error_callback,
                None,
            );
            match stream {
                Ok(stream) => {
                    if let Err(e) = stream.play() {
                        result.insert("play".into(), serde_json::Value::String(format!("失败: {e}")));
                        return serde_json::Value::Object(result);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    let err = error.lock().unwrap().clone();
                    result.insert(
                        "stream".into(),
                        serde_json::Value::String(if let Some(e) = err {
                            format!("已打开但回调报错: {e}")
                        } else {
                            "已打开且回调正常".into()
                        }),
                    );
                }
                Err(e) => {
                    result.insert(
                        "stream".into(),
                        serde_json::Value::String(format!("打开失败: {e}")),
                    );
                }
            }
        }
        Err(e) => {
            result.insert(
                "config".into(),
                serde_json::Value::String(format!("读取配置失败: {e}")),
            );
        }
    }
    let value = serde_json::Value::Object(result);
    eprintln!("[原生] 设备自检：{}", serde_json::to_string(&value).unwrap_or_default());
    value
}

#[tauri::command]
pub async fn native_audio_load(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    source: String,
    cache_key: Option<String>,
) -> Result<usize, String> {
    let engine = state.ensure()?;
    engine.load_cached_and_play(&source, cache_key).await
}

#[tauri::command]
pub fn native_audio_play(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let engine = state.ensure()?;
    engine.player().play();
    Ok(())
}

#[tauri::command]
pub fn native_audio_pause(_app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    if let Ok(engine) = state.ensure() {
        engine.player().pause();
    }
}

#[tauri::command]
pub fn native_audio_stop(_app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    if let Ok(engine) = state.ensure() {
        engine.player().clear();
    }
}

#[tauri::command]
pub fn native_audio_seek(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    seconds: f64,
) -> Result<(), String> {
    let engine = state.ensure()?;
    engine
        .player()
        .try_seek(Duration::from_secs_f64(seconds.max(0.0)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn native_audio_set_volume(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    volume: f32,
) {
    if let Ok(engine) = state.ensure() {
        engine.player().set_volume(volume.clamp(0.0, 1.0));
    }
}

#[tauri::command]
pub fn native_audio_status(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> NativeStatus {
    let Ok(engine) = state.ensure() else {
        return NativeStatus {
            is_playing: false,
            position_seconds: None,
            duration_seconds: None,
            volume: 1.0,
            item_count: 0,
            current_index: None,
        };
    };
    let player = engine.player();
    NativeStatus {
        is_playing: !player.empty() && !player.is_paused(),
        position_seconds: Some(player.get_pos().as_secs_f64()),
        duration_seconds: engine.duration_seconds.lock().map(|guard| *guard).unwrap_or(None),
        volume: player.volume(),
        item_count: player.len(),
        current_index: None,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn write_test_wav(path: &PathBuf) {
        let sample_rate = 44_100u32;
        let seconds = 3u32;
        let samples = (sample_rate * seconds) as usize;
        let mut pcm = Vec::with_capacity(samples * 2);
        for i in 0..samples {
            let t = i as f32 / sample_rate as f32;
            let v = (t * std::f32::consts::TAU * 440.0).sin() * 0.2;
            let sample = (v * i16::MAX as f32) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        let data_len = pcm.len() as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(&pcm);
        std::fs::write(path, wav).unwrap();
    }

    #[tokio::test]
    async fn play_seek_pause_local_wav() {
        let wav = std::env::temp_dir().join("cadilume-rodio-test.wav");
        write_test_wav(&wav);
        let engine = NativeAudioEngine::new(std::env::temp_dir().join("cadilume-rodio-cache")).unwrap();

        engine.load_and_play(wav.to_str().unwrap()).unwrap();
        engine.player().set_volume(0.0);
        tokio::time::sleep(Duration::from_millis(600)).await;
        let player = engine.player();
        assert!(!player.empty() && !player.is_paused(), "播放应处于进行中");
        let position = player.get_pos().as_secs_f64();
        assert!(position > 0.1, "播放进度应前进，实际 {position}");
        let duration = *engine.duration_seconds.lock().unwrap();
        assert!(duration.unwrap_or(0.0) > 2.5, "时长应约为 3 秒");

        player.try_seek(Duration::from_secs_f64(1.5)).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let position = player.get_pos().as_secs_f64();
        assert!(position >= 1.0, "seek 后进度应跳到约 1.5 秒，实际 {position}");

        player.pause();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(player.is_paused(), "暂停后应处于暂停");

        player.clear();
        let _ = std::fs::remove_file(&wav);
    }

    #[tokio::test]
    async fn play_local_flac_advances() {
        let flac = PathBuf::from("/tmp/sample.flac");
        if !flac.exists() {
            eprintln!("跳过：/tmp/sample.flac 不存在");
            return;
        }
        let engine = NativeAudioEngine::new(std::env::temp_dir().join("cadilume-rodio-cache-flac")).unwrap();
        engine.load_and_play(flac.to_str().unwrap()).unwrap();
        engine.player().set_volume(0.0);
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        let player = engine.player();
        assert!(!player.empty() && !player.is_paused(), "FLAC 应处于播放中");
        let position = player.get_pos().as_secs_f64();
        assert!(position > 0.5, "FLAC 播放进度应前进，实际 {position}");
        let duration = *engine.duration_seconds.lock().unwrap();
        assert!(duration.unwrap_or(0.0) > 60.0, "FLAC 时长应约为 122 秒");
        player.clear();
    }

    #[tokio::test]
    async fn cache_download_then_play() {
        let flac = PathBuf::from("/tmp/sample.flac");
        if !flac.exists() {
            eprintln!("跳过：/tmp/sample.flac 不存在");
            return;
        }
        let data = std::fs::read(&flac).unwrap();
        let app = axum::Router::new().route(
            "/sample.flac",
            axum::routing::get(|| async move {
                (
                    [(axum::http::header::CONTENT_TYPE, "audio/flac")],
                    data.clone(),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let url = format!("http://127.0.0.1:{}/sample.flac", addr.port());
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-http");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.load_cached_and_play(&url, Some("sample-cache-test".into())).await.unwrap();
        engine.player().set_volume(0.0);
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        let position = engine.player().get_pos().as_secs_f64();
        assert!(position > 0.2, "缓存下载后播放进度应前进，实际 {position}");
        let cached = cache_root.join("downloads/sample-cache-test.flac");
        assert!(cached.exists(), "缓存文件应落盘");
        engine.player().clear();
    }
}

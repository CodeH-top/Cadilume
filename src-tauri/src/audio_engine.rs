//! Spike: rodio-backed native audio engine behind a thin boundary.
//!
//! kithara's firewheel/cpal pipeline stalled after ~1s in the Tauri process
//! (decoder produced fixed 4096-frame chunks then stopped), so this spike
//! uses the simpler, battle-tested rodio path: cpal output + symphonia
//! decoding, with the Plex stream pre-downloaded to a local cache file.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Minimum bytes downloaded before progressive playback may start.
const MIN_PROGRESSIVE_PRELOAD_BYTES: u64 = 256 * 1024;
/// Disk cache cap for native audio files (Plexamp desktop default 256MB;
/// Cadilume keeps 512MB to cover FLAC originals).
const AUDIO_CACHE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;

fn audio_cache_dir(cache_root: &Path) -> PathBuf {
    cache_root.join("downloads")
}

fn touch_cache_file(path: &Path) {
    let _ = filetime::set_file_mtime(path, filetime::FileTime::now());
}

/// LRU eviction: when total cached audio exceeds the cap, delete oldest
/// `.audio` files until under the limit. `.part` files are transient and
/// always removed first.
fn enforce_audio_cache_limit(cache_root: &Path) {
    let dir = audio_cache_dir(cache_root);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            if name.ends_with(".part") {
                let _ = std::fs::remove_file(&path);
                return None;
            }
            if !name.ends_with(".audio") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((path, metadata.len()))
        })
        .collect();
    files.sort_by_key(|(path, _)| {
        std::fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    let total: u64 = files.iter().map(|(_, len)| *len).sum();
    if total <= AUDIO_CACHE_LIMIT_BYTES {
        return;
    }
    let mut freed = 0u64;
    for (path, len) in files {
        if total - freed <= AUDIO_CACHE_LIMIT_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed += len;
            eprintln!("[原生] 缓存淘汰：{}", path.file_name().unwrap_or_default().to_string_lossy());
        }
    }
}

/// Shared download state between the background downloader and the
/// progressive reader (pull-driven, kithara-stream style).
struct DownloadProgress {
    downloaded: AtomicU64,
    failed: AtomicBool,
    finished: AtomicBool,
    lock: Mutex<()>,
    notify: Condvar,
}

impl DownloadProgress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            downloaded: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            lock: Mutex::new(()),
            notify: Condvar::new(),
        })
    }

    fn wait_until(&self, bytes: u64) {
        let mut guard = self.lock.lock().unwrap();
        while self.downloaded.load(Ordering::SeqCst) < bytes
            && !self.failed.load(Ordering::SeqCst)
            && !self.finished.load(Ordering::SeqCst)
        {
            let result = self.notify.wait_timeout(guard, Duration::from_millis(150)).unwrap();
            guard = result.0;
        }
    }

    fn wake(&self) {
        self.notify.notify_all();
    }
}

/// Read+Seek over a file that is still being written by the downloader:
/// reads beyond the downloaded frontier wait for more bytes (or EOF/failure).
struct ProgressiveFile {
    file: std::fs::File,
    progress: Arc<DownloadProgress>,
}

impl Read for ProgressiveFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let pos = self.file.stream_position()?;
            let downloaded = self.progress.downloaded.load(Ordering::SeqCst);
            if pos < downloaded {
                let n = self.file.read(buf)?;
                if n > 0 {
                    return Ok(n);
                }
                if downloaded > pos && !self.progress.finished.load(Ordering::SeqCst) {
                    self.progress.wait_until(downloaded + 1);
                    continue;
                }
                return Ok(0);
            }
            if self.progress.failed.load(Ordering::SeqCst)
                || self.progress.finished.load(Ordering::SeqCst)
            {
                return Ok(0);
            }
            self.progress.wait_until(pos + 1);
        }
    }
}

impl Seek for ProgressiveFile {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(p) => p,
            SeekFrom::Current(delta) => {
                (self.file.stream_position()? as i128 + delta as i128).max(0) as u64
            }
            SeekFrom::End(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "progressive seek from end is unsupported",
                ));
            }
        };
        while target > self.progress.downloaded.load(Ordering::SeqCst) {
            if self.progress.failed.load(Ordering::SeqCst)
                || self.progress.finished.load(Ordering::SeqCst)
            {
                break;
            }
            self.progress.wait_until(target + 1);
        }
        self.file.seek(SeekFrom::Start(target))
    }
}

/// Stream the loopback media URL into `part_path`, publishing progress, then
/// atomically promote the completed file to `final_path`.
async fn download_progressive(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    final_path: &Path,
    progress: &DownloadProgress,
) -> Result<u64, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载返回 HTTP {}", response.status()));
    }
    let mut file = std::fs::File::create(part_path).map_err(|e| format!("创建缓存文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut total = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载读取失败: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("缓存写入失败: {e}"))?;
        total += chunk.len() as u64;
        progress.downloaded.store(total, Ordering::SeqCst);
        progress.wake();
    }
    file.flush().map_err(|e| format!("缓存刷新失败: {e}"))?;
    progress.finished.store(true, Ordering::SeqCst);
    progress.wake();
    let _ = std::fs::rename(part_path, final_path);
    Ok(total)
}

/// Native playback engine (rodio + cpal) owned by the Tauri app.
pub struct NativeAudioEngine {
    #[allow(dead_code)]
    sink: MixerDeviceSink,
    player: Arc<Player>,
    cache_root: PathBuf,
    duration_seconds: Arc<Mutex<Option<f64>>>,
    loaded: Arc<AtomicBool>,
    ended_sent: Arc<AtomicBool>,
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

    pub fn cache_root(&self) -> &PathBuf {
        &self.cache_root
    }

    pub fn ensure(&self, app: &AppHandle) -> Result<Arc<NativeAudioEngine>, String> {
        let mut guard = self.inner.lock().map_err(|_| "原生引擎状态锁失败".to_string())?;
        if let Some(engine) = guard.as_ref() {
            return Ok(Arc::clone(engine));
        }
        let engine = Arc::new(
            NativeAudioEngine::new(self.cache_root.clone())
                .map_err(|e| format!("原生引擎创建失败: {e}"))?,
        );
        engine.start_event_forwarder(app.clone());
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
        let player = Arc::new(Player::connect_new(sink.mixer()));
        // 原生引擎默认音量取 20%，避免比 WebView 播放明显更响。
        player.set_volume(0.2);
        Ok(Self {
            sink,
            player,
            cache_root,
            duration_seconds: Arc::new(Mutex::new(None)),
            loaded: Arc::new(AtomicBool::new(false)),
            ended_sent: Arc::new(AtomicBool::new(false)),
        })
    }

    fn player(&self) -> &Player {
        self.player.as_ref()
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
        self.loaded.store(true, Ordering::SeqCst);
        self.ended_sent.store(false, Ordering::SeqCst);
        eprintln!(
            "[原生] rodio 载入媒体成功 队列={} 时长={:?}",
            self.player.len(),
            total,
        );
        Ok(self.player.len())
    }

    /// Stream a loopback media URL into the local cache and start playing
    /// once the head is available (progressive download, kithara-stream
    /// style). Completed downloads are promoted to a reusable cache file.
    pub async fn load_cached_and_play(
        &self,
        source: &str,
        cache_key: Option<String>,
    ) -> Result<usize, String> {
        if !(source.starts_with("http://") || source.starts_with("https://")) {
            return self.load_and_play(source);
        }
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
        let final_path = dir.join(format!("{key}.audio"));
        let final_ready = std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        if final_ready {
            eprintln!("[原生] 命中完整缓存 key={key}");
            touch_cache_file(&final_path);
            enforce_audio_cache_limit(&self.cache_root);
            return self.load_and_play(final_path.to_str().unwrap());
        }

        let part_path = dir.join(format!("{key}.audio.part"));
        let _ = std::fs::remove_file(&part_path);
        let progress = DownloadProgress::new();
        let progress_task = Arc::clone(&progress);
        let part_for_task = part_path.clone();
        let final_for_task = final_path.clone();
        let source_for_task = source.to_string();
        let client = reqwest::Client::new();
        tokio::spawn(async move {
            if let Err(error) = download_progressive(
                &client,
                &source_for_task,
                &part_for_task,
                &final_for_task,
                &progress_task,
            )
            .await
            {
                progress_task.failed.store(true, Ordering::SeqCst);
                progress_task.wake();
                eprintln!("[原生] 渐进下载失败：{error}");
            }
        });

        // Wait for the head bytes (or terminal state) before decoding.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while progress.downloaded.load(Ordering::SeqCst) < MIN_PROGRESSIVE_PRELOAD_BYTES
            && !progress.failed.load(Ordering::SeqCst)
            && !progress.finished.load(Ordering::SeqCst)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if progress.failed.load(Ordering::SeqCst) {
            return Err("下载歌曲失败，无法开始播放".to_string());
        }
        let file = std::fs::File::open(&part_path)
            .map_err(|e| format!("打开渐进缓存失败: {e}"))?;
        let reader = ProgressiveFile {
            file,
            progress: Arc::clone(&progress),
        };
        let decoder = Decoder::new(reader).map_err(|e| format!("媒体解码失败: {e}"))?;
        let total = decoder.total_duration().map(|d| d.as_secs_f64());
        *self.duration_seconds.lock().map_err(|_| "时长状态锁失败".to_string())? = total;
        self.player.clear();
        self.player.append(decoder);
        self.player.play();
        self.loaded.store(true, Ordering::SeqCst);
        self.ended_sent.store(false, Ordering::SeqCst);
        eprintln!(
            "[原生] 渐进播放开始 key={key} 已预载={} 时长={:?}",
            progress.downloaded.load(Ordering::SeqCst),
            total,
        );
        let cache_root = self.cache_root.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            enforce_audio_cache_limit(&cache_root);
        });
        Ok(self.player.len())
    }

    /// Publish sanitized playback progress/ended events to the WebView.
    pub fn start_event_forwarder(&self, app: AppHandle) {
        let player = Arc::clone(&self.player);
        let duration = Arc::clone(&self.duration_seconds);
        let loaded = Arc::clone(&self.loaded);
        let ended_sent = Arc::clone(&self.ended_sent);
        let app_for_task = app.clone();
        let mut last_position = -1.0f64;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let position = player.get_pos().as_secs_f64();
                let ended = loaded.load(Ordering::SeqCst)
                    && !ended_sent.load(Ordering::SeqCst)
                    && player.empty()
                    && position > 0.05;
                if ended {
                    ended_sent.store(true, Ordering::SeqCst);
                    let _ = app_for_task.emit(
                        "native-audio://event",
                        serde_json::json!({ "type": "ended" }),
                    );
                    continue;
                }
                if (position - last_position).abs() >= 0.05 {
                    last_position = position;
                    let duration_value = duration.lock().map(|guard| *guard).unwrap_or(None);
                    let _ = app_for_task.emit(
                        "native-audio://event",
                        serde_json::json!({
                            "type": "progress",
                            "position": position,
                            "duration": duration_value,
                        }),
                    );
                }
            }
        });
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

#[derive(Serialize)]
pub struct NativeCacheStatus {
    pub size_bytes: u64,
    pub file_count: usize,
}

#[tauri::command]
pub fn native_audio_cache_status(
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> NativeCacheStatus {
    let dir = audio_cache_dir(state.cache_root());
    let mut size_bytes = 0u64;
    let mut file_count = 0usize;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".audio") {
                continue;
            }
            if let Ok(metadata) = entry.metadata() {
                size_bytes += metadata.len();
                file_count += 1;
            }
        }
    }
    NativeCacheStatus { size_bytes, file_count }
}

#[tauri::command]
pub fn native_audio_clear_cache(
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let dir = audio_cache_dir(state.cache_root());
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".audio") || name.ends_with(".part") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn native_audio_load(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    source: String,
    cache_key: Option<String>,
) -> Result<usize, String> {
    let engine = state.ensure(&app)?;
    engine.load_cached_and_play(&source, cache_key).await
}

#[tauri::command]
pub fn native_audio_play(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    engine.player().play();
    Ok(())
}

#[tauri::command]
pub fn native_audio_pause(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    if let Ok(engine) = state.ensure(&app) {
        engine.player().pause();
    }
}

#[tauri::command]
pub fn native_audio_stop(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    if let Ok(engine) = state.ensure(&app) {
        engine.player().clear();
    }
}

#[tauri::command]
pub fn native_audio_seek(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    seconds: f64,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    engine
        .player()
        .try_seek(Duration::from_secs_f64(seconds.max(0.0)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn native_audio_set_volume(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    volume: f32,
) {
    if let Ok(engine) = state.ensure(&app) {
        engine.player().set_volume(volume.clamp(0.0, 1.0));
    }
}

#[tauri::command]
pub fn native_audio_status(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> NativeStatus {
    let Ok(engine) = state.ensure(&app) else {
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
        let cached = cache_root.join("downloads/sample-cache-test.audio");
        assert!(cached.exists(), "缓存文件应落盘");
        engine.player().clear();
    }
}

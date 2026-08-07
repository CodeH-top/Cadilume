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
use rodio::source::SeekError;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Minimum bytes downloaded before progressive playback may start.
const MIN_PROGRESSIVE_PRELOAD_BYTES: u64 = 256 * 1024;
/// Disk cache cap for native audio files (Plexamp desktop default 256MB;
/// Cadilume keeps 512MB to cover FLAC originals).
const AUDIO_CACHE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
/// Background prefetch bandwidth cap (Plexamp desktop default ~5 Mbps).
/// Only applies to far-ahead cache warming, never to the immediate next
/// track (gapless handoff must not be delayed by throttling).
const PRECACHE_RATE_LIMIT_BYTES_PER_SEC: u64 = 5 * 1024 * 1024 / 8;

fn audio_cache_dir(cache_root: &Path) -> PathBuf {
    cache_root.join("downloads")
}

fn touch_cache_file(path: &Path) {
    let _ = filetime::set_file_mtime(path, filetime::FileTime::now());
}

/// Wraps a queued source so the engine can detect the exact sample-level
/// handoff: the flag flips the first time the queued source is actually
/// pulled by the output (i.e. the previous track has fully ended). Polling
/// `len()`/position cannot reliably observe a handoff that happens between
/// polls, so this marker is the authoritative transition signal.
struct HandoffMarker<S> {
    inner: S,
    started: Arc<AtomicBool>,
}

impl<S: Source> Iterator for HandoffMarker<S> {
    type Item = S::Item;

    fn next(&mut self) -> Option<Self::Item> {
        let sample = self.inner.next();
        if sample.is_some() {
            self.started.store(true, Ordering::SeqCst);
        }
        sample
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S: Source> Source for HandoffMarker<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)
    }
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
    expected_len: AtomicU64,
    failed: AtomicBool,
    finished: AtomicBool,
    lock: Mutex<()>,
    notify: Condvar,
}

impl DownloadProgress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            downloaded: AtomicU64::new(0),
            expected_len: AtomicU64::new(0),
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

/// One download attempt: stream the loopback media URL into `part_path`,
/// publishing progress, then atomically promote the completed file.
async fn download_progressive_once(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    final_path: &Path,
    progress: &DownloadProgress,
    rate_limit_bytes_per_sec: Option<u64>,
) -> Result<u64, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载返回 HTTP {}", response.status()));
    }
    let expected_total = response.content_length();
    progress
        .expected_len
        .store(expected_total.unwrap_or(0), Ordering::SeqCst);
    let mut file = std::fs::File::create(part_path).map_err(|e| format!("创建缓存文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    let started_at = std::time::Instant::now();
    let mut total = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载读取失败: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("缓存写入失败: {e}"))?;
        total += chunk.len() as u64;
        progress.downloaded.store(total, Ordering::SeqCst);
        progress.wake();
        if let Some(limit) = rate_limit_bytes_per_sec {
            let expected_seconds = total as f64 / limit as f64;
            let elapsed = started_at.elapsed().as_secs_f64();
            if expected_seconds > elapsed {
                tokio::time::sleep(Duration::from_secs_f64(expected_seconds - elapsed)).await;
            }
        }
    }
    if let Some(expected) = expected_total {
        if total != expected {
            let _ = std::fs::remove_file(part_path);
            return Err(format!(
                "下载不完整：期望 {expected} 字节，实际 {total} 字节"
            ));
        }
    }
    file.flush().map_err(|e| format!("缓存刷新失败: {e}"))?;
    let _ = std::fs::rename(part_path, final_path);
    // 先改名再标记完成，保证等待方看到 finished 时 final 已可读。
    progress.finished.store(true, Ordering::SeqCst);
    progress.wake();
    Ok(total)
}

/// Download with bounded retries for transient network/stream failures.
/// `progress` state is reset before each attempt so a partial failure can
/// never be mistaken for a usable head by the progressive reader.
async fn download_progressive(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    final_path: &Path,
    progress: &DownloadProgress,
    rate_limit_bytes_per_sec: Option<u64>,
    max_attempts: u32,
) -> Result<u64, String> {
    let attempts = max_attempts.max(1);
    let mut last_error = None::<String>;
    for attempt in 1..=attempts {
        progress.downloaded.store(0, Ordering::SeqCst);
        progress.finished.store(false, Ordering::SeqCst);
        progress.failed.store(false, Ordering::SeqCst);
        progress.wake();
        match download_progressive_once(
            client,
            url,
            part_path,
            final_path,
            progress,
            rate_limit_bytes_per_sec,
        )
        .await
        {
            Ok(total) => return Ok(total),
            Err(error) => {
                last_error = Some(error.clone());
                if attempt < attempts {
                    eprintln!("[原生] 下载失败，第 {attempt} 次重试：{error}");
                    tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
                }
            }
        }
    }
    progress.failed.store(true, Ordering::SeqCst);
    progress.wake();
    Err(last_error.unwrap_or_else(|| "下载失败".to_string()))
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
    metadata: Arc<Mutex<Option<NowPlayingMetadata>>>,
    queue: Arc<Mutex<QueueState>>,
    pending: Arc<Mutex<Option<PendingTrack>>>,
    current_source: Arc<Mutex<Option<CurrentSource>>>,
    stopped: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct QueueTrack {
    pub rating_key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeRepeatMode {
    #[default]
    Off,
    All,
    One,
}

#[derive(Debug, Default)]
pub struct QueueState {
    tracks: Vec<QueueTrack>,
    current_index: i64,
    repeat: NativeRepeatMode,
    shuffle: bool,
    bag: Vec<usize>,
}

impl QueueState {
    fn next_index(&mut self, natural_ended: bool) -> Option<usize> {
        if self.tracks.is_empty() {
            return None;
        }
        let current = self.current_index.max(0) as usize;
        if natural_ended && self.repeat == NativeRepeatMode::One {
            return Some(current);
        }
        if self.shuffle {
            let mut available: Vec<usize> = (0..self.tracks.len())
                .filter(|index| *index != current)
                .collect();
            if !available.is_empty() {
                if let Some(last) = self.bag.last() {
                    if available.len() > 1 {
                        available.retain(|index| index != last);
                    }
                }
                let index = available[0];
                self.bag.push(index);
                if self.bag.len() > self.tracks.len() {
                    self.bag.remove(0);
                }
                return Some(index);
            }
            return None;
        }
        let next = current + 1;
        if next < self.tracks.len() {
            Some(next)
        } else if self.repeat == NativeRepeatMode::All {
            Some(0)
        } else {
            None
        }
    }

    fn previous_index(&self) -> Option<usize> {
        if self.tracks.is_empty() {
            return None;
        }
        let current = self.current_index.max(0) as usize;
        if self.shuffle {
            let mut used: Vec<usize> = self.bag.iter().rev().copied().collect();
            if let Some(found) = used.iter().position(|index| *index == current) {
                used.remove(found);
            }
            return used.first().copied();
        }
        if current > 0 {
            Some(current - 1)
        } else if self.repeat != NativeRepeatMode::Off {
            Some(self.tracks.len() - 1)
        } else {
            None
        }
    }

    /// Compute the next index for a natural end without mutating the queue.
    /// `queue_next_source` uses this to verify that the frontend's prefetch
    /// target still matches the Rust queue decision before appending it.
    fn peek_next_index(&self, natural_ended: bool) -> Option<usize> {
        if self.tracks.is_empty() {
            return None;
        }
        let current = self.current_index.max(0) as usize;
        if natural_ended && self.repeat == NativeRepeatMode::One {
            return Some(current);
        }
        if self.shuffle {
            let mut available: Vec<usize> = (0..self.tracks.len())
                .filter(|index| *index != current)
                .collect();
            if !available.is_empty() {
                if let Some(last) = self.bag.last() {
                    if available.len() > 1 {
                        available.retain(|index| index != last);
                    }
                }
                return available.first().copied();
            }
            return None;
        }
        let next = current + 1;
        if next < self.tracks.len() {
            Some(next)
        } else if self.repeat == NativeRepeatMode::All {
            Some(0)
        } else {
            None
        }
    }

    /// Commit an already-queued source as the current track. The index was
    /// validated against `peek_next_index` when it was queued, so no further
    /// decision is needed here; keep the shuffle bag in sync with reality.
    fn commit_index(&mut self, index: usize) {
        if index >= self.tracks.len() {
            return;
        }
        self.current_index = index as i64;
        if self.shuffle && self.tracks.len() > 1 {
            self.bag.push(index);
            if self.bag.len() > self.tracks.len() {
                self.bag.remove(0);
            }
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct NowPlayingMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// A fully-downloaded next track already appended to the rodio queue.
#[derive(Clone, Debug)]
struct PendingTrack {
    index: usize,
    duration_seconds: Option<f64>,
    title: String,
    artist: String,
    album: String,
    started: Arc<AtomicBool>,
}

impl PendingTrack {
    fn metadata(&self) -> NowPlayingMetadata {
        NowPlayingMetadata {
            title: Some(self.title.clone()),
            artist: Some(self.artist.clone()),
            album: Some(self.album.clone()),
        }
    }
}

/// Where the current track is being read from, so a device switch can rebuild
/// the player and resume from the same source (cache hit first, otherwise a
/// fresh progressive download).
#[derive(Clone, Debug)]
struct CurrentSource {
    source: String,
    cache_key: Option<String>,
    metadata: NowPlayingMetadata,
}

/// State captured before rebuilding the player on another output device.
#[derive(Clone, Debug)]
struct PlaybackSnapshot {
    playing: bool,
    position: f64,
    volume: f32,
    duration_seconds: Option<f64>,
    metadata: Option<NowPlayingMetadata>,
    source: Option<CurrentSource>,
    queue_tracks: Vec<QueueTrack>,
    queue_index: i64,
    repeat: NativeRepeatMode,
    shuffle: bool,
}

/// Lazy engine slot so the device stream opens on first use.
pub struct NativeAudioEngineSlot {
    cache_root: PathBuf,
    inner: Mutex<Option<Arc<NativeAudioEngine>>>,
    preferred_device: Mutex<Option<String>>,
}

impl NativeAudioEngineSlot {
    pub fn new(cache_root: PathBuf) -> Self {
        Self {
            cache_root,
            inner: Mutex::new(None),
            preferred_device: Mutex::new(None),
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
        let preferred_device = self
            .preferred_device
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(None);
        let engine = Arc::new(
            NativeAudioEngine::new_with_device(
                self.cache_root.clone(),
                preferred_device.as_deref().unwrap_or(""),
            )
                .map_err(|e| format!("原生引擎创建失败: {e}"))?,
        );
        engine.start_event_forwarder(app.clone());
        *guard = Some(Arc::clone(&engine));
        Ok(engine)
    }

    /// Switch the live engine to another output device. The current track is
    /// captured and resumed on the new device from cache (or a fresh
    /// progressive download); the old event forwarder stops cleanly.
    pub async fn set_output_device(
        &self,
        app: &AppHandle,
        device_name: String,
    ) -> Result<(), String> {
        if let Ok(mut preferred) = self.preferred_device.lock() {
            *preferred = Some(device_name.clone());
        }
        let snapshot = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "原生引擎状态锁失败".to_string())?;
            let Some(old) = guard.as_ref() else {
                return Ok(());
            };
            old.capture_playback_snapshot()
        };
        let new_engine = Arc::new(
            NativeAudioEngine::new_with_device(self.cache_root.clone(), &device_name)
                .map_err(|e| format!("切换输出设备失败: {e}"))?,
        );
        new_engine
            .restore_playback_snapshot(&snapshot)
            .await
            .map_err(|e| format!("在新输出设备上恢复播放失败: {e}"))?;
        new_engine.start_event_forwarder(app.clone());
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "原生引擎状态锁失败".to_string())?;
        if let Some(old) = guard.as_ref() {
            old.stopped.store(true, Ordering::SeqCst);
        }
        *guard = Some(new_engine);
        Ok(())
    }
}

/// Advance the queue after a natural end and publish the sanitized
/// `ended`/`queue-item` events. Queue authority lives in Rust: the next index
/// is decided here and only then mirrored to the WebView.
fn publish_natural_ended(
    queue: &Arc<Mutex<QueueState>>,
    ended_sent: &Arc<AtomicBool>,
    app: &AppHandle,
) {
    ended_sent.store(true, Ordering::SeqCst);
    let next_index = queue
        .lock()
        .map(|mut state| {
            let next = state.next_index(true);
            if let Some(index) = next {
                state.current_index = index as i64;
            }
            next
        })
        .unwrap_or(None);
    let _ = app.emit(
        "native-audio://event",
        serde_json::json!({ "type": "ended" }),
    );
    if let Some(index) = next_index {
        let _ = app.emit(
            "native-audio://event",
            serde_json::json!({ "type": "queue-item", "index": index }),
        );
    }
}

impl NativeAudioEngine {
    #[allow(dead_code)]
    pub fn new(cache_root: PathBuf) -> anyhow::Result<Self> {
        Self::new_with_device(cache_root, "")
    }

    fn new_with_device(cache_root: PathBuf, device_name: &str) -> anyhow::Result<Self> {
        use cpal::traits::{DeviceTrait, HostTrait};
        let builder = if device_name.is_empty() {
            DeviceSinkBuilder::from_default_device()
                .map_err(|e| anyhow::anyhow!("打开默认音频设备失败: {e}"))?
        } else {
            let host = cpal::default_host();
            let device = host
                .output_devices()
                .map_err(|e| anyhow::anyhow!("枚举输出设备失败: {e}"))?
                .find(|device| {
                    device
                        .description()
                        .map(|description| description.name() == device_name)
                        .unwrap_or(false)
                })
                .ok_or_else(|| anyhow::anyhow!("找不到输出设备: {device_name}"))?;
            DeviceSinkBuilder::from_device(device)
                .map_err(|e| anyhow::anyhow!("打开所选输出设备失败: {e}"))?
        };
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
            metadata: Arc::new(Mutex::new(None)),
            queue: Arc::new(Mutex::new(QueueState::default())),
            pending: Arc::new(Mutex::new(None)),
            current_source: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(false)),
        })
    }

    fn player(&self) -> &Player {
        self.player.as_ref()
    }

    fn resolve_cache_paths(&self, cache_key: Option<String>) -> Result<(String, PathBuf, PathBuf), String> {
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
        let part_path = dir.join(format!("{key}.audio.part"));
        Ok((key, final_path, part_path))
    }

    /// Load a local media file and start playing it.
    pub fn load_and_play(&self, path: &str) -> Result<usize, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("打开媒体文件失败: {e}"))?;
        let len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        // 必须提供 byte_len（同时开启 seekable）：rodio 默认解码器不能向后
        // seek，且 MP3/FLAC 的时长计算依赖流长度。
        let decoder = Decoder::builder()
            .with_data(file)
            .with_byte_len(len)
            .build()
            .map_err(|e| format!("媒体解码失败: {e}"))?;
        let total = decoder.total_duration().map(|d| d.as_secs_f64());
        let metadata = self
            .metadata
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(None)
            .unwrap_or_default();
        if let Ok(mut current_source) = self.current_source.lock() {
            *current_source = Some(CurrentSource {
                source: path.to_string(),
                cache_key: None,
                metadata,
            });
        }
        *self.duration_seconds.lock().map_err(|_| "时长状态锁失败".to_string())? = total;
        self.player.clear();
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
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
        metadata: Option<NowPlayingMetadata>,
    ) -> Result<usize, String> {
        let metadata_for_source = metadata.clone();
        if let Some(metadata) = metadata {
            *self.metadata.lock().map_err(|_| "元数据状态锁失败".to_string())? = Some(metadata);
        }
        if !(source.starts_with("http://") || source.starts_with("https://")) {
            return self.load_and_play(source);
        }
        let (key, final_path, part_path) = self.resolve_cache_paths(cache_key.clone())?;
        let final_ready = std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        if final_ready {
            match self.load_and_play(final_path.to_str().unwrap()) {
                Ok(len) => {
                    eprintln!("[原生] 命中完整缓存 key={key}");
                    touch_cache_file(&final_path);
                    enforce_audio_cache_limit(&self.cache_root);
                    return Ok(len);
                }
                Err(error) => {
                    // 损坏/截断的缓存文件不能挡住播放：删除后走渐进下载自愈。
                    eprintln!("[原生] 缓存文件损坏，自动重下 key={key}：{error}");
                    let _ = std::fs::remove_file(&final_path);
                }
            }
        }

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
                None,
                3,
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
        if progress.finished.load(Ordering::SeqCst) {
            // 小文件/快速下载可能在等待期间已完整落盘并改名。
            return self.load_and_play(final_path.to_str().unwrap());
        }
        let file = std::fs::File::open(&part_path)
            .map_err(|e| format!("打开渐进缓存失败: {e}"))?;
        let reader = ProgressiveFile {
            file,
            progress: Arc::clone(&progress),
        };
        let expected_len = progress.expected_len.load(Ordering::SeqCst);
        let mut builder = Decoder::builder().with_data(reader).with_seekable(true);
        if expected_len > 0 {
            builder = builder.with_byte_len(expected_len);
        }
        let decoder = builder.build().map_err(|e| format!("媒体解码失败: {e}"))?;
        let total = decoder.total_duration().map(|d| d.as_secs_f64());
        if let Ok(mut current_source) = self.current_source.lock() {
            *current_source = Some(CurrentSource {
                source: source.to_string(),
                cache_key,
                metadata: metadata_for_source.unwrap_or_default(),
            });
        }
        *self.duration_seconds.lock().map_err(|_| "时长状态锁失败".to_string())? = total;
        self.player.clear();
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
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

    /// Pre-download a future track into the cache without playing it, so the
    /// next switch can start from the local file (reduces cross-track gap).
    /// Completes only when the download is fully committed, so callers can
    /// follow it with `queue_next_source` for a gapless handoff.
    pub async fn precache(
        &self,
        source: &str,
        cache_key: Option<String>,
        rate_limit_bytes_per_sec: Option<u64>,
    ) -> Result<(), String> {
        if !(source.starts_with("http://") || source.starts_with("https://")) {
            return Ok(());
        }
        let (_, final_path, part_path) = self.resolve_cache_paths(cache_key)?;
        if std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Ok(());
        }
        let _ = std::fs::remove_file(&part_path);
        let progress = DownloadProgress::new();
        let progress_task = Arc::clone(&progress);
        let part_for_task = part_path;
        let final_for_task = final_path;
        let source_for_task = source.to_string();
        let client = reqwest::Client::new();
        let task = tokio::spawn(async move {
            let outcome = download_progressive(
                &client,
                &source_for_task,
                &part_for_task,
                &final_for_task,
                &progress_task,
                rate_limit_bytes_per_sec,
                3,
            )
            .await;
            if let Err(error) = &outcome {
                progress_task.failed.store(true, Ordering::SeqCst);
                progress_task.wake();
                eprintln!("[原生] 预缓存下载失败：{error}");
            }
            outcome
        });
        task.await
            .map_err(|e| format!("预缓存任务中断: {e}"))??;
        enforce_audio_cache_limit(&self.cache_root);
        Ok(())
    }

    /// Queue a fully-cached next track onto the rodio queue. The current
    /// source keeps playing; when it ends, rodio pulls the queued source in
    /// the same sample loop, producing a gapless PCM handoff. The marker flips
    /// exactly when the handoff happens so the event forwarder can publish a
    /// `track` event without any polling race.
    pub fn queue_next_source(
        &self,
        index: i64,
        cache_key: Option<String>,
    ) -> Result<(), String> {
        if !self.loaded.load(Ordering::SeqCst) {
            return Err("当前没有正在播放的曲目".to_string());
        }
        if self
            .pending
            .lock()
            .map_err(|_| "预排状态锁失败".to_string())?
            .is_some()
        {
            return Ok(());
        }
        let index = usize::try_from(index).map_err(|_| "无效的曲目序号".to_string())?;
        let track = {
            let queue = self
                .queue
                .lock()
                .map_err(|_| "队列状态锁失败".to_string())?;
            if queue.peek_next_index(true) != Some(index) {
                return Err("预排顺序与队列不一致".to_string());
            }
            queue
                .tracks
                .get(index)
                .cloned()
                .ok_or_else(|| "曲目不在队列中".to_string())?
        };
        let (_, final_path, _) = self.resolve_cache_paths(cache_key)?;
        if !std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Err("下一首尚未完整下载".to_string());
        }
        let file =
            std::fs::File::open(&final_path).map_err(|e| format!("打开预排缓存失败: {e}"))?;
        let len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        let decoder = Decoder::builder()
            .with_data(file)
            .with_byte_len(len)
            .build()
            .map_err(|e| format!("预排解码失败: {e}"))?;
        let total = decoder.total_duration().map(|d| d.as_secs_f64());
        let started = Arc::new(AtomicBool::new(false));
        let marker = HandoffMarker {
            inner: decoder,
            started: Arc::clone(&started),
        };
        self.player.append(marker);
        *self
            .pending
            .lock()
            .map_err(|_| "预排状态锁失败".to_string())? = Some(PendingTrack {
            index,
            duration_seconds: total,
            title: track.title,
            artist: track.artist,
            album: track.album,
            started,
        });
        eprintln!(
            "[原生] 已预排下一首 index={index} 时长={total:?} 队列={}",
            self.player.len(),
        );
        Ok(())
    }

    /// Consume a queued source whose gapless handoff has started (the previous
    /// track exhausted and rodio pulled the first sample of the queued one).
    /// Commits it as the current track and returns it so the caller can
    /// publish the `track` event.
    fn consume_started_handoff(&self) -> Option<PendingTrack> {
        let queued = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(queued) = queued else {
            return None;
        };
        if !queued.started.load(Ordering::SeqCst) {
            if let Ok(mut pending) = self.pending.lock() {
                *pending = Some(queued);
            }
            return None;
        }
        if let Ok(mut queue_guard) = self.queue.lock() {
            queue_guard.commit_index(queued.index);
        }
        if let Some(duration_value) = queued.duration_seconds {
            if let Ok(mut duration_guard) = self.duration_seconds.lock() {
                *duration_guard = Some(duration_value);
            }
        }
        if let Ok(mut metadata_guard) = self.metadata.lock() {
            *metadata_guard = Some(queued.metadata());
        }
        self.ended_sent.store(false, Ordering::SeqCst);
        Some(queued)
    }

    /// Consume a queued source that ended without producing any sample (failed
    /// or empty media), committing its index so the queue can advance past it.
    fn consume_failed_handoff(&self) -> Option<PendingTrack> {
        let queued = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(queued) = queued {
            if let Ok(mut queue_guard) = self.queue.lock() {
                queue_guard.commit_index(queued.index);
            }
            return Some(queued);
        }
        None
    }

    /// Capture everything needed to rebuild the player on another device.
    fn capture_playback_snapshot(&self) -> PlaybackSnapshot {
        let queue_state = self
            .queue
            .lock()
            .map(|guard| {
                (
                    guard.tracks.clone(),
                    guard.current_index,
                    guard.repeat,
                    guard.shuffle,
                )
            })
            .unwrap_or_default();
        PlaybackSnapshot {
            playing: !self.player().is_paused() && !self.player().empty(),
            position: self.player().get_pos().as_secs_f64(),
            volume: self.player().volume(),
            duration_seconds: self
                .duration_seconds
                .lock()
                .map(|guard| *guard)
                .unwrap_or(None),
            metadata: self
                .metadata
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or(None),
            source: self
                .current_source
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or(None),
            queue_tracks: queue_state.0,
            queue_index: queue_state.1,
            repeat: queue_state.2,
            shuffle: queue_state.3,
        }
    }

    /// Restore a captured snapshot on a freshly built engine (device switch).
    async fn restore_playback_snapshot(&self, snapshot: &PlaybackSnapshot) -> Result<(), String> {
        if let Ok(mut queue) = self.queue.lock() {
            queue.tracks = snapshot.queue_tracks.clone();
            queue.current_index = snapshot.queue_index;
            queue.repeat = snapshot.repeat;
            queue.shuffle = snapshot.shuffle;
            queue.bag.clear();
        }
        if let Ok(mut metadata) = self.metadata.lock() {
            *metadata = snapshot.metadata.clone();
        }
        if let Ok(mut duration) = self.duration_seconds.lock() {
            *duration = snapshot.duration_seconds;
        }
        self.player().set_volume(snapshot.volume);
        if let Some(source) = snapshot.source.as_ref() {
            if source.source.starts_with("http://") || source.source.starts_with("https://") {
                self.load_cached_and_play(
                    &source.source,
                    source.cache_key.clone(),
                    Some(source.metadata.clone()),
                )
                .await?;
            } else {
                self.load_and_play(&source.source)?;
            }
            if snapshot.position > 0.5 {
                let _ = self
                    .player()
                    .try_seek(Duration::from_secs_f64(snapshot.position));
            }
            if !snapshot.playing {
                self.player().pause();
            }
        }
        Ok(())
    }

    /// Publish sanitized playback progress/ended events to the WebView.
    pub fn start_event_forwarder(self: &Arc<Self>, app: AppHandle) {
        let engine = Arc::clone(self);
        let app_for_task = app.clone();
        let mut last_position = -1.0f64;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if engine.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let position = engine.player().get_pos().as_secs_f64();
                let duration_value = engine
                    .duration_seconds
                    .lock()
                    .map(|guard| *guard)
                    .unwrap_or(None);
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                {
                    let playing = !engine.player().is_paused() && !engine.player().empty();
                    let meta = engine
                        .metadata
                        .lock()
                        .map(|guard| guard.clone())
                        .unwrap_or(None);
                    if let Some(meta) = meta {
                        crate::now_playing::update_metadata(
                            meta.title.as_deref().unwrap_or(""),
                            meta.artist.as_deref().unwrap_or(""),
                            meta.album.as_deref().unwrap_or(""),
                            duration_value,
                            position,
                            playing,
                        );
                    }
                }

                // Gapless handoff: a queued source started (its marker flipped
                // exactly when the previous track exhausted), or it failed
                // without producing a single sample (len dropped to zero).
                let pending_started = engine
                    .pending
                    .lock()
                    .map(|guard| {
                        guard
                            .as_ref()
                            .map(|queued| queued.started.load(Ordering::SeqCst))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                let pending_exists = engine
                    .pending
                    .lock()
                    .map(|guard| guard.is_some())
                    .unwrap_or(false);
                if engine.loaded.load(Ordering::SeqCst) && pending_exists && pending_started {
                    if let Some(queued) = engine.consume_started_handoff() {
                        let _ = app_for_task.emit(
                            "native-audio://event",
                            serde_json::json!({
                                "type": "track",
                                "index": queued.index,
                                "duration": queued.duration_seconds,
                                "position": position,
                            }),
                        );
                        last_position = position;
                        if engine.player().empty() {
                            // The queued source ended inside the same poll
                            // window (very short or failed track): fall back
                            // to the normal ended/advance path immediately.
                            publish_natural_ended(
                                &engine.queue,
                                &engine.ended_sent,
                                &app_for_task,
                            );
                        }
                        continue;
                    }
                }
                if engine.loaded.load(Ordering::SeqCst)
                    && pending_exists
                    && engine.player().empty()
                {
                    // The queued source produced no samples at all. Treat it
                    // as consumed and advance past it, otherwise playback
                    // would sit on silence forever.
                    if engine.consume_failed_handoff().is_some() {
                        publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                        continue;
                    }
                }

                let ended = engine.loaded.load(Ordering::SeqCst)
                    && !engine.ended_sent.load(Ordering::SeqCst)
                    && engine.player().empty()
                    && position > 0.05;
                if ended {
                    publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                    continue;
                }
                if (position - last_position).abs() >= 0.05 {
                    last_position = position;
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

#[derive(Serialize)]
pub struct NativeOutputDevice {
    pub device_id: String,
    pub label: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn native_audio_output_devices() -> Result<Vec<NativeOutputDevice>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| device.description().ok())
        .map(|description| description.name().to_string())
        .unwrap_or_default();
    let devices = host
        .output_devices()
        .map_err(|e| format!("枚举输出设备失败: {e}"))?
        .filter_map(|device| {
            let name = device.description().ok()?.name().to_string();
            Some(NativeOutputDevice {
                device_id: name.clone(),
                label: name.clone(),
                is_default: default_name.is_empty() || name == default_name,
            })
        })
        .collect::<Vec<_>>();
    if devices.is_empty() {
        return Ok(vec![NativeOutputDevice {
            device_id: String::new(),
            label: "系统默认".to_string(),
            is_default: true,
        }]);
    }
    Ok(devices)
}

#[tauri::command]
pub async fn native_audio_set_output_device(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    device_id: String,
) -> Result<(), String> {
    state.set_output_device(&app, device_id).await
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
    metadata: Option<NowPlayingMetadata>,
) -> Result<usize, String> {
    let engine = state.ensure(&app)?;
    engine.load_cached_and_play(&source, cache_key, metadata).await
}

#[tauri::command]
pub async fn native_audio_precache(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    source: String,
    cache_key: Option<String>,
    rate_limit: Option<bool>,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    let limit = if rate_limit.unwrap_or(false) {
        Some(PRECACHE_RATE_LIMIT_BYTES_PER_SEC)
    } else {
        None
    };
    engine.precache(&source, cache_key, limit).await
}

#[tauri::command]
pub fn native_audio_queue_next_source(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    index: i64,
    cache_key: Option<String>,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    engine.queue_next_source(index, cache_key)
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
        engine.loaded.store(false, Ordering::SeqCst);
        engine.ended_sent.store(false, Ordering::SeqCst);
        if let Ok(mut pending) = engine.pending.lock() {
            *pending = None;
        }
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

#[tauri::command]
pub fn native_queue_set(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    tracks: Vec<QueueTrack>,
    current_index: i64,
    repeat: NativeRepeatMode,
    shuffle: bool,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    // A full queue replacement invalidates any queued gapless source. Clear
    // the pending slot before touching the queue to keep lock ordering with
    // the event forwarder (pending -> queue) consistent.
    if let Ok(mut pending) = engine.pending.lock() {
        *pending = None;
    }
    let mut queue = engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?;
    queue.tracks = tracks;
    queue.current_index = current_index;
    queue.repeat = repeat;
    queue.shuffle = shuffle;
    queue.bag.clear();
    Ok(())
}

#[tauri::command]
pub fn native_queue_next(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) -> Result<usize, String> {
    let engine = state.ensure(&app)?;
    let mut queue = engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?;
    let next = queue.next_index(false).ok_or_else(|| "队列已结束".to_string())?;
    queue.current_index = next as i64;
    Ok(next)
}

#[tauri::command]
pub fn native_queue_previous(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) -> Result<usize, String> {
    let engine = state.ensure(&app)?;
    let mut queue = engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?;
    let previous = queue.previous_index().ok_or_else(|| "没有上一首".to_string())?;
    queue.current_index = previous as i64;
    Ok(previous)
}

#[tauri::command]
pub fn native_queue_set_repeat(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    repeat: NativeRepeatMode,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?
        .repeat = repeat;
    Ok(())
}

#[tauri::command]
pub fn native_queue_set_shuffle(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    shuffle: bool,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    let mut queue = engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?;
    queue.shuffle = shuffle;
    queue.bag.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

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

    fn write_test_wav_of_seconds(path: &PathBuf, seconds: u32) {
        let sample_rate = 22_050u32;
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

        // 向后 seek：rodio 默认解码器（无 byte_len）不支持，必须验证回跳生效。
        player.try_seek(Duration::from_secs_f64(0.5)).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let position = player.get_pos().as_secs_f64();
        assert!(
            position < 0.9,
            "向后 seek 后进度应回到约 0.5 秒，实际 {position}"
        );

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
        // 向后 seek 真实 FLAC。
        player.try_seek(Duration::from_secs_f64(1.0)).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let position = player.get_pos().as_secs_f64();
        assert!(
            position < 1.8,
            "FLAC 向后 seek 后进度应接近 1 秒，实际 {position}"
        );
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
        engine
            .load_cached_and_play(&url, Some("sample-cache-test".into()), None)
            .await
            .unwrap();
        engine.player().set_volume(0.0);
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        let position = engine.player().get_pos().as_secs_f64();
        assert!(position > 0.2, "缓存下载后播放进度应前进，实际 {position}");
        let cached = cache_root.join("downloads/sample-cache-test.audio");
        assert!(cached.exists(), "缓存文件应落盘");
        engine.player().clear();
    }

    #[tokio::test]
    async fn download_retries_after_transient_truncation() {
        use axum::response::IntoResponse;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        let wav = std::env::temp_dir().join("cadilume-download-retry.wav");
        write_test_wav_of_seconds(&wav, 1);
        let data = std::fs::read(&wav).unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_server = Arc::clone(&attempts);
        let data_for_server = data.clone();
        let app = axum::Router::new().route(
            "/retry.wav",
            axum::routing::get(move || {
                let attempts = Arc::clone(&attempts_for_server);
                let data = data_for_server.clone();
                async move {
                    let count = attempts.fetch_add(1, AtomicOrdering::SeqCst);
                    if count == 0 {
                        // 第一次：声明完整长度但只发送一半，触发完整性校验失败。
                        let partial = data[..data.len() / 2].to_vec();
                        let mut response = axum::response::Response::new(
                            axum::body::Body::from(partial),
                        );
                        response.headers_mut().insert(
                            axum::http::header::CONTENT_LENGTH,
                            axum::http::HeaderValue::from_str(&data.len().to_string()).unwrap(),
                        );
                        return response;
                    }
                    (
                        [(axum::http::header::CONTENT_TYPE, "audio/wav")],
                        data,
                    )
                        .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let url = format!("http://127.0.0.1:{}/retry.wav", addr.port());
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-retry");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        engine
            .load_cached_and_play(&url, Some("retry-test".into()), None)
            .await
            .expect("首次截断后重试应成功并开始播放");
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !engine.player().empty() && !engine.player().is_paused(),
            "重试成功后应处于播放中"
        );
        assert!(
            attempts.load(AtomicOrdering::SeqCst) >= 2,
            "应至少请求两次"
        );
        let cached = cache_root.join("downloads/retry-test.audio");
        assert_eq!(
            std::fs::metadata(&cached)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            data.len() as u64,
            "重试成功后缓存应完整"
        );
        engine.player().clear();
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_dir_all(&cache_root);
    }

    #[tokio::test]
    async fn precache_honors_rate_limit_and_commits_complete_file() {
        let wav = std::env::temp_dir().join("cadilume-rate-limit.wav");
        write_test_wav_of_seconds(&wav, 1);
        let data = std::fs::read(&wav).unwrap();
        let data_for_server = data.clone();
        let app = axum::Router::new().route(
            "/rate.wav",
            axum::routing::get(|| async move {
                (
                    [(axum::http::header::CONTENT_TYPE, "audio/wav")],
                    data_for_server,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let url = format!("http://127.0.0.1:{}/rate.wav", addr.port());
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-rate");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);

        // 约 44KB 文件、限制 22KB/s：理想耗时约 2 秒，容忍 1.2 秒以上。
        let started = std::time::Instant::now();
        engine
            .precache(&url, Some("rate-limit-test".into()), Some(22 * 1024))
            .await
            .expect("限速预取应完整完成");
        let elapsed = started.elapsed().as_secs_f64();
        assert!(
            elapsed >= 1.2,
            "限速预取应至少耗时 1.2 秒，实际 {elapsed}"
        );
        let cached = cache_root.join("downloads/rate-limit-test.audio");
        assert_eq!(
            std::fs::metadata(&cached).map(|metadata| metadata.len()).unwrap_or(0),
            data.len() as u64,
            "限速预取文件应完整落盘"
        );
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_dir_all(&cache_root);
    }

    #[tokio::test]
    async fn corrupt_cache_file_is_self_healed_and_redownloaded() {
        let wav = std::env::temp_dir().join("cadilume-self-heal.wav");
        write_test_wav_of_seconds(&wav, 1);
        let data = std::fs::read(&wav).unwrap();
        let data_for_server = data.clone();
        let app = axum::Router::new().route(
            "/heal.wav",
            axum::routing::get(|| async move {
                (
                    [(axum::http::header::CONTENT_TYPE, "audio/wav")],
                    data_for_server,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let url = format!("http://127.0.0.1:{}/heal.wav", addr.port());
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-heal");
        let downloads = cache_root.join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        // 预置一个损坏的缓存文件（头合法但内容不是有效媒体）。
        std::fs::write(
            downloads.join("heal-test.audio"),
            b"RIFFxxxxWAVEfmt corrupt garbage that cannot decode",
        )
        .unwrap();

        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        engine
            .load_cached_and_play(&url, Some("heal-test".into()), None)
            .await
            .expect("损坏缓存应自动重下并开始播放");
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !engine.player().empty() && !engine.player().is_paused(),
            "自愈后应处于播放中"
        );
        let healed = downloads.join("heal-test.audio");
        assert_eq!(
            std::fs::metadata(&healed)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            data.len() as u64,
            "损坏缓存应被完整新文件替换"
        );
        engine.player().clear();
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_dir_all(&cache_root);
    }

    fn queue_track(key: &str) -> QueueTrack {
        QueueTrack {
            rating_key: key.to_string(),
            title: key.to_string(),
            artist: String::new(),
            album: String::new(),
        }
    }

    #[test]
    fn queue_peek_next_index_matches_natural_advance() {
        let mut queue = QueueState {
            tracks: vec![queue_track("a"), queue_track("b"), queue_track("c")],
            current_index: 0,
            repeat: NativeRepeatMode::All,
            shuffle: false,
            bag: vec![],
        };
        assert_eq!(queue.peek_next_index(true), Some(1));
        assert_eq!(queue.next_index(true), Some(1));
        queue.current_index = 2;
        assert_eq!(queue.peek_next_index(true), Some(0), "repeat-all 应回绕");
        queue.repeat = NativeRepeatMode::One;
        queue.current_index = 1;
        assert_eq!(queue.peek_next_index(true), Some(1), "repeat-one 自然结束应重播当前曲目");
        assert_eq!(queue.peek_next_index(false), Some(2), "手动 next 不受 repeat-one 约束");
    }

    #[test]
    fn queue_shuffle_peek_is_pure_and_avoids_last() {
        let queue = QueueState {
            tracks: vec![
                queue_track("a"),
                queue_track("b"),
                queue_track("c"),
                queue_track("d"),
            ],
            current_index: 0,
            repeat: NativeRepeatMode::All,
            shuffle: true,
            bag: vec![2],
        };
        let first = queue.peek_next_index(true).unwrap();
        let second = queue.peek_next_index(true).unwrap();
        assert_eq!(first, second, "peek 不应推进 bag");
        assert_ne!(first, 0, "不应选当前曲目");
        assert_ne!(first, 2, "不应重复上一条 bag 记录");

        let mut queue = queue;
        queue.commit_index(first);
        assert_eq!(queue.current_index, first as i64);
        assert_eq!(queue.bag, vec![2, first], "提交后 bag 应记录实际播放的曲目");
    }

    #[tokio::test]
    async fn gapless_queue_next_rejects_stale_or_incomplete_source() {
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-gapless-reject");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        let wav = std::env::temp_dir().join("cadilume-gapless-reject.wav");
        write_test_wav(&wav);
        engine.load_and_play(wav.to_str().unwrap()).unwrap();
        {
            let mut queue = engine.queue.lock().unwrap();
            queue.tracks = vec![queue_track("a"), queue_track("b")];
            queue.current_index = 0;
            queue.repeat = NativeRepeatMode::All;
        }
        // 下一首缓存文件缺失。
        let missing = engine.queue_next_source(1, Some("missing-b".into()));
        assert!(missing.is_err(), "缓存未就绪时不应预排");
        // 队列已前进（与前端预取目标不一致）时拒绝。
        engine.queue.lock().unwrap().current_index = 1;
        let downloads = cache_root.join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::copy(&wav, downloads.join("stale-b.audio")).unwrap();
        let stale = engine.queue_next_source(1, Some("stale-b".into()));
        assert!(stale.is_err(), "预排顺序与队列不一致时应拒绝");
        engine.player().clear();
        let _ = std::fs::remove_file(&wav);
    }

    #[tokio::test]
    async fn gapless_queue_next_handoff_commits_index() {
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-gapless");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        let wav_a = std::env::temp_dir().join("cadilume-gapless-a.wav");
        let wav_b = std::env::temp_dir().join("cadilume-gapless-b.wav");
        write_test_wav(&wav_a);
        write_test_wav(&wav_b);
        engine.load_and_play(wav_a.to_str().unwrap()).unwrap();
        {
            let mut queue = engine.queue.lock().unwrap();
            queue.tracks = vec![queue_track("a"), queue_track("b")];
            queue.current_index = 0;
            queue.repeat = NativeRepeatMode::All;
            queue.shuffle = false;
        }
        let downloads = cache_root.join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::copy(&wav_b, downloads.join("gapless-b.audio")).unwrap();
        engine.queue_next_source(1, Some("gapless-b".into())).unwrap();
        assert_eq!(engine.player().len(), 2, "预排后播放器队列应有两首");

        // A 是 3 秒短曲：等 A 自然结束、B 的握手标记翻转。
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        let started = loop {
            let started = engine
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|queued| queued.started.load(Ordering::SeqCst))
                .unwrap_or(false);
            if started || std::time::Instant::now() >= deadline {
                break started;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(started, "A 结束后 B 的握手标记应翻转");
        let queued = engine.consume_started_handoff().expect("应能消费预排交接");
        assert_eq!(queued.index, 1);
        assert_eq!(engine.queue.lock().unwrap().current_index, 1);
        assert!(!engine.player().empty(), "B 应继续播放");
        let duration = *engine.duration_seconds.lock().unwrap();
        assert!(duration.unwrap_or(0.0) > 2.5, "时长应切换到 B");
        let metadata = engine.metadata.lock().unwrap().clone().expect("应有元数据");
        assert_eq!(metadata.title.as_deref(), Some("b"));

        engine.player().clear();
        let _ = std::fs::remove_file(&wav_a);
        let _ = std::fs::remove_file(&wav_b);
    }

    #[tokio::test]
    async fn gapless_queue_next_handoff_mp3_with_encoder_padding() {
        let mp3_a = PathBuf::from("/tmp/cadilume-gapless-a.mp3");
        let mp3_b = PathBuf::from("/tmp/cadilume-gapless-b.mp3");
        if !mp3_a.exists() || !mp3_b.exists() {
            eprintln!("跳过：/tmp/cadilume-gapless-*.mp3 不存在");
            return;
        }
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-gapless-mp3");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        engine.load_and_play(mp3_a.to_str().unwrap()).unwrap();
        {
            let mut queue = engine.queue.lock().unwrap();
            queue.tracks = vec![queue_track("a"), queue_track("b")];
            queue.current_index = 0;
            queue.repeat = NativeRepeatMode::All;
            queue.shuffle = false;
        }
        let downloads = cache_root.join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::copy(&mp3_b, downloads.join("gapless-b.mp3.audio")).unwrap();
        engine
            .queue_next_source(1, Some("gapless-b.mp3".into()))
            .unwrap();

        // MP3 带编码 padding（约 2 秒曲目）：等 A 结束、B 的握手标记翻转。
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        let started = loop {
            let started = engine
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|queued| queued.started.load(Ordering::SeqCst))
                .unwrap_or(false);
            if started || std::time::Instant::now() >= deadline {
                break started;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(started, "MP3 A 结束后 B 的握手标记应翻转");
        let queued = engine.consume_started_handoff().expect("应能消费 MP3 预排交接");
        assert_eq!(queued.index, 1);
        assert_eq!(engine.queue.lock().unwrap().current_index, 1);
        assert!(!engine.player().empty(), "MP3 B 应继续播放");
        engine.player().clear();
    }

    #[tokio::test]
    async fn output_device_list_contains_the_default_device() {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        if host.default_output_device().is_none() {
            eprintln!("跳过：无默认输出设备");
            return;
        }
        let devices = native_audio_output_devices().expect("枚举输出设备应成功");
        assert!(!devices.is_empty(), "至少应返回系统默认设备");
        assert!(
            devices.iter().any(|device| device.is_default),
            "设备列表应标记默认设备"
        );
    }

    #[tokio::test]
    async fn output_device_switch_resumes_playback_from_position() {
        use cpal::traits::{DeviceTrait, HostTrait};
        let wav = std::env::temp_dir().join("cadilume-device-switch.wav");
        write_test_wav(&wav);
        let cache_root = std::env::temp_dir().join("cadilume-rodio-cache-device");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        engine.load_and_play(wav.to_str().unwrap()).unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        let snapshot = engine.capture_playback_snapshot();
        assert!(snapshot.position > 0.1, "切换前播放进度应已前进");
        assert!(snapshot.playing, "切换前应处于播放中");

        let host = cpal::default_host();
        let device_name = host
            .default_output_device()
            .and_then(|device| device.description().ok())
            .map(|description| description.name().to_string())
            .unwrap_or_default();
        let rebuilt =
            NativeAudioEngine::new_with_device(cache_root.clone(), &device_name).unwrap();
        rebuilt
            .restore_playback_snapshot(&snapshot)
            .await
            .expect("新设备上恢复播放应成功");
        tokio::time::sleep(Duration::from_millis(350)).await;
        let resumed = rebuilt.player().get_pos().as_secs_f64();
        assert!(
            resumed >= snapshot.position - 0.05,
            "切换设备后应从原进度继续，原 {} 现 {}",
            snapshot.position,
            resumed
        );
        assert!(!rebuilt.player().empty(), "切换设备后应继续播放");
        rebuilt.player().clear();
        let _ = std::fs::remove_file(&wav);
    }

    /// 真实 PMS 回归共享的拉取逻辑：读取开发 token → 发现服务器 → 选可达连接
    /// → 音乐媒体库 → 按时长/大小挑出适合回归的小曲目。
    struct PmsRegressionFixture {
        server_uri: String,
        server_token: String,
        tracks: Vec<(u64, u64, String, String, String)>,
    }

    async fn load_pms_regression_fixture() -> Option<PmsRegressionFixture> {
        let Some(home) = std::env::var("HOME").ok() else {
            eprintln!("跳过：无 HOME");
            return None;
        };
        let token_path = PathBuf::from(home).join(".cadilume-dev-token");
        let Ok(raw_token) = std::fs::read_to_string(&token_path) else {
            eprintln!("跳过：{} 不存在", token_path.display());
            return None;
        };
        let token = raw_token.trim().to_string();
        if token.is_empty() {
            eprintln!("跳过：开发 token 为空");
            return None;
        }
        fn plex_headers(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
            request
                .header("X-Plex-Token", token)
                .header("X-Plex-Client-Identifier", "cadilume-pms-regression-test")
                .header("X-Plex-Product", "Cadilume")
                .header("X-Plex-Version", env!("CARGO_PKG_VERSION"))
                .header("X-Plex-Platform", std::env::consts::OS)
                .header("X-Plex-Device-Name", "Cadilume 回归测试")
                .header("X-Plex-Device", "Mac")
                .header(reqwest::header::ACCEPT, "application/json")
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(30))
            .build()
            .ok()?;
        let resources: serde_json::Value = plex_headers(
            client.get("https://plex.tv/api/v2/resources"),
            &token,
        )
        .query(&[("includeHttps", "1"), ("includeRelay", "1"), ("includeIPv6", "1")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
        let mut server = None;
        for resource in resources.as_array().into_iter().flatten() {
            let provides = resource["provides"].as_str().unwrap_or("");
            if !provides.split(',').any(|item| item == "server") {
                continue;
            }
            let Some(access_token) = resource["accessToken"].as_str() else {
                continue;
            };
            // 与应用一致：逐个探测连接，选第一个可用的连接。
            let mut reachable = None;
            for connection in resource["connections"].as_array().into_iter().flatten() {
                let Some(uri) = connection["uri"].as_str() else {
                    continue;
                };
                let identity = plex_headers(
                    client.get(format!("{uri}/identity")),
                    access_token,
                )
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false);
                if identity {
                    reachable = Some(uri.to_string());
                    break;
                }
            }
            if let Some(uri) = reachable {
                server = Some((
                    resource["clientIdentifier"].as_str().unwrap_or("").to_string(),
                    uri,
                    access_token.to_string(),
                ));
                break;
            }
        }
        let Some((_server_id, server_uri, server_token)) = server else {
            eprintln!("跳过：没有可用的 Plex 服务器");
            return None;
        };
        let sections: serde_json::Value = plex_headers(
            client.get(format!("{server_uri}/library/sections")),
            &server_token,
        )
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
        let Some(section_key) = sections["MediaContainer"]["Directory"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|directory| directory["type"].as_str() == Some("artist"))
            .and_then(|directory| directory["key"].as_str())
            .map(str::to_string)
        else {
            eprintln!("跳过：没有音乐媒体库");
            return None;
        };
        let tracks: serde_json::Value = plex_headers(
            client.get(format!("{server_uri}/library/sections/{section_key}/all")),
            &server_token,
        )
        .query(&[("type", "10"), ("limit", "60")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
        let mut candidates: Vec<(u64, u64, String, String, String)> =
            tracks["MediaContainer"]["Metadata"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|track| {
                    let rating_key = track.get("ratingKey")?.as_str()?.to_string();
                    let title = track
                        .get("title")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    let duration_ms = track
                        .get("duration")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(u64::MAX);
                    let part = track.get("Media")?.as_array()?.first()?;
                    let part = part.get("Part")?.as_array()?.first()?;
                    let part_key = part.get("key")?.as_str()?.to_string();
                    let size = part
                        .get("size")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(u64::MAX);
                    let short_enough = (15_000..=240_000).contains(&duration_ms);
                    (short_enough && (500_000..=30_000_000).contains(&size))
                        .then_some((duration_ms, size, rating_key, title, part_key))
                })
                .collect();
        candidates.sort_by_key(|candidate| (candidate.0, candidate.1));
        if candidates.len() < 2 {
            eprintln!("跳过：可用曲目不足两首");
            return None;
        }
        Some(PmsRegressionFixture {
            server_uri,
            server_token,
            tracks: candidates,
        })
    }

    /// 真实 PMS 端到端回归（默认忽略，显式运行：
    /// `cargo test -- --ignored real_pms_engine_regression --nocapture`）。
    /// 使用开发态明文 token，从真实资料库取两首小曲目，静音走完整链路：
    /// 真实下载 → 磁盘缓存 → 渐进播放 → 预排下一首 → 无缝交接 → seek → 暂停/恢复。
    #[tokio::test]
    #[ignore = "需要真实 PMS 与开发 token"]
    async fn real_pms_engine_regression() {
        let Some(fixture) = load_pms_regression_fixture().await else {
            return;
        };
        let track_a = &fixture.tracks[0];
        let track_b = &fixture.tracks[1];
        let stream_url = |part_key: &str| {
            format!(
                "{}{}?X-Plex-Token={}",
                fixture.server_uri, part_key, fixture.server_token
            )
        };
        let cache_root = std::env::temp_dir().join(format!(
            "cadilume-pms-regression-{}",
            uuid::Uuid::new_v4()
        ));
        let downloads_dir = cache_root.join("downloads");
        std::fs::create_dir_all(&downloads_dir).expect("创建回归缓存目录失败");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        // 先串行预缓存 B（引擎每次新建下载客户端、单条活跃流），
        // 避免真实服务器（尤其免费/共享账号）的单流限制打断并发下载。
        engine
            .precache(&stream_url(&track_b.4), Some(track_b.2.clone()), None)
            .await
            .expect("真实 PMS 曲目 B 应完整预缓存");
        engine
            .load_cached_and_play(
                &stream_url(&track_a.4),
                Some(track_a.2.clone()),
                Some(NowPlayingMetadata {
                    title: Some(track_a.3.clone()),
                    artist: None,
                    album: None,
                }),
            )
            .await
            .expect("真实 PMS 曲目 A 应能载入并开始播放");
        {
            let mut queue = engine.queue.lock().unwrap();
            queue.tracks = vec![
                QueueTrack {
                    rating_key: track_a.2.clone(),
                    title: track_a.3.clone(),
                    artist: String::new(),
                    album: String::new(),
                },
                QueueTrack {
                    rating_key: track_b.2.clone(),
                    title: track_b.3.clone(),
                    artist: String::new(),
                    album: String::new(),
                },
            ];
            queue.current_index = 0;
            queue.repeat = NativeRepeatMode::All;
            queue.shuffle = false;
        }
        engine
            .queue_next_source(1, Some(track_b.2.clone()))
            .expect("真实 PMS 曲目 B 应能预排");

        // A 完整落盘后 seek 到结尾附近，让真实曲目在几秒内自然结束。
        let a_final = downloads_dir.join(format!("{}.audio", track_a.2));
        let download_deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !a_final.exists() && std::time::Instant::now() < download_deadline {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(a_final.exists(), "真实 PMS 曲目 A 应完整落盘");
        let a_duration = engine
            .duration_seconds
            .lock()
            .unwrap()
            .unwrap_or(0.0);
        assert!(a_duration > 10.0, "真实 PMS 曲目 A 时长应有效");
        engine
            .player()
            .try_seek(Duration::from_secs_f64((a_duration - 3.0).max(1.0)))
            .expect("真实 PMS 曲目 A 接近结尾 seek 应成功");

        // 等 A 结束、B 无缝交接（seek 后最坏等 30 秒）。
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let started = loop {
            let started = engine
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|queued| queued.started.load(Ordering::SeqCst))
                .unwrap_or(false);
            if started || std::time::Instant::now() >= deadline {
                break started;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        assert!(started, "真实 PMS 曲目 A 结束后 B 应无缝交接");
        let queued = engine
            .consume_started_handoff()
            .expect("应能消费真实 PMS 预排交接");
        assert_eq!(queued.index, 1);
        assert_eq!(engine.queue.lock().unwrap().current_index, 1);
        assert!(!engine.player().empty(), "真实 PMS 曲目 B 应继续播放");

        // B 上做 seek 与暂停/恢复验证。
        tokio::time::sleep(Duration::from_millis(600)).await;
        engine
            .player()
            .try_seek(Duration::from_secs_f64(1.0))
            .expect("真实 PMS 曲目 B seek 应成功");
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            engine.player().get_pos().as_secs_f64() >= 0.8,
            "seek 后进度应接近 1 秒"
        );
        engine.player().pause();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(engine.player().is_paused(), "真实 PMS 暂停应生效");
        engine.player().play();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!engine.player().is_paused(), "真实 PMS 恢复应生效");

        // 两首曲目都应落入缓存。
        let downloads = cache_root.join("downloads");
        let cache_files = std::fs::read_dir(&downloads)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".audio"))
            .count();
        assert!(cache_files >= 2, "真实 PMS 回归后缓存应有至少两首曲目");
        eprintln!("真实 PMS 引擎回归通过：下载/缓存/渐进播放/预排/无缝交接/seek/暂停恢复均正常");

        engine.player().clear();
        let _ = std::fs::remove_dir_all(&cache_root);
    }

    /// 真实 PMS 高频切歌回归（默认忽略，显式运行：
    /// `cargo test -- --ignored real_pms_engine_rapid_switch_regression --nocapture`）。
    /// 串行预缓存多首真实曲目后连续快速加载/切换两轮（≥20 次加载），中途穿插
    /// seek 与暂停/恢复，覆盖历史上 WebView 播放的高频切歌 error4/卡顿场景。
    #[tokio::test]
    #[ignore = "需要真实 PMS 与开发 token"]
    async fn real_pms_engine_rapid_switch_regression() {
        let Some(fixture) = load_pms_regression_fixture().await else {
            return;
        };
        let limit = fixture.tracks.len().min(10);
        if limit < 3 {
            eprintln!("跳过：可用曲目不足三首");
            return;
        }
        let selected = fixture.tracks[..limit].to_vec();
        let stream_url = |part_key: &str| {
            format!(
                "{}{}?X-Plex-Token={}",
                fixture.server_uri, part_key, fixture.server_token
            )
        };
        let cache_root = std::env::temp_dir().join(format!(
            "cadilume-pms-rapid-{}",
            uuid::Uuid::new_v4()
        ));
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);

        // 串行预缓存全部选中曲目（单条活跃流，避免服务器单流限制）。
        for (_, _, rating_key, _title, part_key) in &selected {
            engine
                .precache(&stream_url(part_key), Some(rating_key.clone()), None)
                .await
                .expect("高频切换预缓存应完整");
        }

        // 两轮连续快速加载/切换，模拟用户高频点下一首；第二轮穿插 seek/暂停。
        let mut loads = 0usize;
        for round in 0..2 {
            for (index, (_duration_ms, _size, rating_key, title, part_key)) in
                selected.iter().enumerate()
            {
                engine
                    .load_cached_and_play(
                        &stream_url(part_key),
                        Some(rating_key.clone()),
                        Some(NowPlayingMetadata {
                            title: Some(title.clone()),
                            artist: None,
                            album: None,
                        }),
                    )
                    .await
                    .expect("高频切歌加载应成功");
                loads += 1;
                tokio::time::sleep(Duration::from_millis(250)).await;
                assert!(
                    !engine.player().empty() && !engine.player().is_paused(),
                    "高频切歌后应处于播放中"
                );
                let position = engine.player().get_pos().as_secs_f64();
                assert!(position >= 0.0, "高频切歌后进度应有效");
                if round == 1 && index % 2 == 0 {
                    engine
                        .player()
                        .try_seek(Duration::from_secs_f64(1.0))
                        .expect("高频切歌中 seek 应成功");
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    engine.player().pause();
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    assert!(engine.player().is_paused(), "高频切歌中暂停应生效");
                    engine.player().play();
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    assert!(!engine.player().is_paused(), "高频切歌中恢复应生效");
                }
                eprintln!(
                    "[回归] 高频切歌 #{loads} 曲目={title} 缓存命中"
                );
            }
        }

        let downloads = cache_root.join("downloads");
        let cache_files = std::fs::read_dir(&downloads)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".audio"))
            .count();
        assert!(
            cache_files >= selected.len(),
            "高频切换后缓存应覆盖全部选中曲目"
        );
        assert!(loads >= 20, "高频切换应至少 20 次加载，实际 {loads}");
        eprintln!("真实 PMS 高频切歌回归通过：{loads} 次加载/切换、seek/暂停恢复均无失败");
        engine.player().clear();
        let _ = std::fs::remove_dir_all(&cache_root);
    }
}

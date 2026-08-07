//! Spike: rodio-backed native audio engine behind a thin boundary.
//!
//! kithara's firewheel/cpal pipeline stalled after ~1s in the Tauri process
//! (decoder produced fixed 4096-frame chunks then stopped), so this spike
//! uses the simpler, battle-tested rodio path: cpal output + symphonia
//! decoding, with the Plex stream pre-downloaded to a local cache file.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use rodio::source::SeekError;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

/// Minimum bytes downloaded before progressive playback may start.
const MIN_PROGRESSIVE_PRELOAD_BYTES: u64 = 256 * 1024;
/// Disk cache cap for native audio files (Plexamp desktop default 256MB;
/// Cadilume keeps 512MB to cover FLAC originals).
const AUDIO_CACHE_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
/// Cache identities cross the WebView boundary but are never used as paths.
/// Bound their size before hashing to keep command memory predictable.
const MAX_AUDIO_CACHE_IDENTITY_BYTES: usize = 8 * 1024;
/// A loopback request or a body chunk that makes no progress for this long is
/// treated as transiently failed and retried. This bounds precache tasks too;
/// unlike foreground load they have no separate startup deadline.
const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Background prefetch bandwidth cap (Plexamp desktop default ~5 Mbps).
/// Only applies to far-ahead cache warming, never to the immediate next
/// track (gapless handoff must not be delayed by throttling).
const PRECACHE_RATE_LIMIT_BYTES_PER_SEC: u64 = 5 * 1024 * 1024 / 8;
/// 前端心跳超时：超过该时长没有收到 heartbeat 且引擎正在出声，就自动停止
/// 播放，防止 WebView/主线程卡死或崩溃后音乐停不下来。
const HEARTBEAT_STALL_TIMEOUT: Duration = Duration::from_secs(6);

fn audio_cache_dir(cache_root: &Path) -> PathBuf {
    cache_root.join("downloads")
}

fn audio_cache_key(cache_identity: Option<&str>) -> Result<String, String> {
    let Some(identity) = cache_identity.map(str::trim).filter(|identity| !identity.is_empty())
    else {
        return Ok(uuid::Uuid::new_v4().simple().to_string());
    };
    if identity.len() > MAX_AUDIO_CACHE_IDENTITY_BYTES {
        return Err("音频缓存身份超过 8 KiB 上限".to_string());
    }
    let mut digest = Sha256::new();
    digest.update(b"cadilume-native-audio-cache-v2\0");
    digest.update(identity.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn resolve_audio_cache_paths(
    cache_root: &Path,
    cache_identity: Option<&str>,
) -> Result<(String, PathBuf, PathBuf), String> {
    let key = audio_cache_key(cache_identity)?;
    let dir = audio_cache_dir(cache_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("缓存目录创建失败: {e}"))?;
    let final_path = dir.join(format!("{key}.audio"));
    let part_path = dir.join(format!("{key}.audio.part"));
    Ok((key, final_path, part_path))
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
/// completed `.audio` files until under the limit. Active `.part` files are
/// owned by their download task and must never be touched by an LRU scan.
fn enforce_audio_cache_limit_with_limit(cache_root: &Path, limit_bytes: u64) {
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
                // Partial files can be actively written and read by progressive
                // playback. Their async owner removes them on every terminal
                // path; startup cleanup handles remnants from a crashed process.
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
    if total <= limit_bytes {
        return;
    }
    let mut freed = 0u64;
    for (path, len) in files {
        if total - freed <= limit_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed += len;
            eprintln!(
                "[原生] 缓存淘汰：{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
        }
    }
}

fn enforce_audio_cache_limit(cache_root: &Path) {
    enforce_audio_cache_limit_with_limit(cache_root, AUDIO_CACHE_LIMIT_BYTES);
}

fn remove_orphaned_partial_files(cache_root: &Path) {
    let dir = audio_cache_dir(cache_root);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .ends_with(".audio.part")
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

async fn clear_audio_cache_files(cache_root: &Path) -> Result<(), String> {
    let dir = audio_cache_dir(cache_root);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".audio") || name.ends_with(".audio.part") {
            let path = entry.path();
            let mut last_error = None;
            for _ in 0..20 {
                match tokio::fs::remove_file(&path).await {
                    Ok(()) => {
                        last_error = None;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        last_error = None;
                        break;
                    }
                    Err(error) => {
                        last_error = Some(error);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            if let Some(error) = last_error {
                return Err(format!("清理音频缓存失败: {error}"));
            }
        }
    }
    Ok(())
}

/// Shared download state between the background downloader and the
/// progressive reader (pull-driven, kithara-stream style).
struct DownloadProgress {
    downloaded: AtomicU64,
    expected_len: AtomicU64,
    failed: AtomicBool,
    finished: AtomicBool,
    cancelled: AtomicBool,
    lock: Mutex<()>,
    notify: Condvar,
}

/// A partial cache file must never survive a failed or aborted download. The
/// guard is owned by the async future, so aborting its task also performs the
/// cleanup without relying on a later cache-prune pass.
struct PartialDownloadCleanup {
    path: PathBuf,
}

impl PartialDownloadCleanup {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
        }
    }
}

impl Drop for PartialDownloadCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl DownloadProgress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            downloaded: AtomicU64::new(0),
            expected_len: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            lock: Mutex::new(()),
            notify: Condvar::new(),
        })
    }

    fn wait_until(&self, bytes: u64) {
        let mut guard = self.lock.lock().unwrap();
        while self.downloaded.load(Ordering::SeqCst) < bytes
            && !self.failed.load(Ordering::SeqCst)
            && !self.finished.load(Ordering::SeqCst)
            && !self.cancelled.load(Ordering::SeqCst)
        {
            let result = self
                .notify
                .wait_timeout(guard, Duration::from_millis(150))
                .unwrap();
            guard = result.0;
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake();
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
            if self.progress.cancelled.load(Ordering::SeqCst) {
                return Ok(0);
            }
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
                || self.progress.cancelled.load(Ordering::SeqCst)
            {
                return Ok(0);
            }
            self.progress.wait_until(pos + 1);
        }
    }
}

impl Seek for ProgressiveFile {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        if self.progress.cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "progressive playback was cancelled",
            ));
        }
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
                || self.progress.cancelled.load(Ordering::SeqCst)
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
    if progress.cancelled.load(Ordering::SeqCst) {
        return Err("下载已取消".to_string());
    }
    let response = tokio::time::timeout(DOWNLOAD_IDLE_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "下载请求超时".to_string())?
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载返回 HTTP {}", response.status()));
    }
    let expected_total = response.content_length();
    progress
        .expected_len
        .store(expected_total.unwrap_or(0), Ordering::SeqCst);
    let mut file = tokio::fs::File::create(part_path)
        .await
        .map_err(|e| format!("创建缓存文件失败: {e}"))?;
    let mut stream = response.bytes_stream();
    let started_at = std::time::Instant::now();
    let mut total = 0u64;
    loop {
        let chunk = tokio::time::timeout(DOWNLOAD_IDLE_TIMEOUT, stream.next())
            .await
            .map_err(|_| "下载数据等待超时".to_string())?;
        let Some(chunk) = chunk else {
            break;
        };
        if progress.cancelled.load(Ordering::SeqCst) {
            return Err("下载已取消".to_string());
        }
        let chunk = chunk.map_err(|e| format!("下载读取失败: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("缓存写入失败: {e}"))?;
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
    if total == 0 {
        return Err("下载内容为空".to_string());
    }
    file.flush()
        .await
        .map_err(|e| format!("缓存刷新失败: {e}"))?;
    drop(file);
    tokio::fs::rename(part_path, final_path)
        .await
        .map_err(|e| format!("提交缓存文件失败: {e}"))?;
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
    let _partial_cleanup = PartialDownloadCleanup::new(part_path);
    let attempts = max_attempts.max(1);
    let mut last_error = None::<String>;
    for attempt in 1..=attempts {
        if progress.cancelled.load(Ordering::SeqCst) {
            return Err("下载已取消".to_string());
        }
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
                if progress.cancelled.load(Ordering::SeqCst) {
                    return Err("下载已取消".to_string());
                }
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

struct ActivePrecache {
    cache_key: String,
    rate_limited: bool,
    progress: Arc<DownloadProgress>,
    part_path: PathBuf,
    handle: tauri::async_runtime::JoinHandle<()>,
    completion: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
}

async fn await_precache_completion(
    mut completion: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
) -> Result<(), String> {
    loop {
        if let Some(outcome) = completion.borrow().clone() {
            return outcome;
        }
        completion
            .changed()
            .await
            .map_err(|_| "预缓存已中止".to_string())?;
    }
}

/// Native playback engine (rodio + cpal) owned by the Tauri app.
pub struct NativeAudioEngine {
    #[allow(dead_code)]
    sink: MixerDeviceSink,
    player: Mutex<Arc<Player>>,
    cache_root: PathBuf,
    playback_generation: Arc<AtomicU64>,
    artwork_generation: Arc<AtomicU64>,
    transition_lock: Mutex<()>,
    duration_seconds: Arc<Mutex<Option<f64>>>,
    loaded: Arc<AtomicBool>,
    ended_sent: Arc<AtomicBool>,
    metadata: Arc<Mutex<Option<NowPlayingMetadata>>>,
    queue: Arc<Mutex<QueueState>>,
    pending: Arc<Mutex<Option<PendingTrack>>>,
    current_source: Arc<Mutex<Option<CurrentSource>>>,
    artwork_bytes: Arc<Mutex<Option<Arc<Vec<u8>>>>>,
    stopped: Arc<AtomicBool>,
    last_heartbeat: Arc<Mutex<Option<std::time::Instant>>>,
    /// 真实 PMS 单流限制：同一时刻只允许一条下载，播放优先，预取可被抢占。
    download_permit: Arc<tokio::sync::Semaphore>,
    /// Serializes precache admission. An immediate-next request holds this gate
    /// while it cancels a far-ahead request and acquires the single permit, so
    /// a throttled request cannot slip in and steal playback-critical capacity.
    precache_gate: tokio::sync::Mutex<()>,
    active_download: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    active_precache: Arc<Mutex<Option<ActivePrecache>>>,
    active_progress: Arc<Mutex<Option<Arc<DownloadProgress>>>>,
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
    /// Shuffle playback history (origins), so Previous works even after the
    /// WebView re-syncs the queue on every load.
    history: Vec<usize>,
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
            if self.history.last() != Some(&current) {
                self.history.push(current);
            }
            if self.history.len() > self.tracks.len() {
                self.history.remove(0);
            }
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
            let mut used: Vec<usize> = self.history.iter().rev().copied().collect();
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
        let origin = self.current_index.max(0) as usize;
        self.current_index = index as i64;
        if self.shuffle && self.tracks.len() > 1 {
            if self.history.last() != Some(&origin) {
                self.history.push(origin);
            }
            if self.history.len() > self.tracks.len() {
                self.history.remove(0);
            }
            self.bag.push(index);
            if self.bag.len() > self.tracks.len() {
                self.bag.remove(0);
            }
        }
    }

    /// Re-sync the queue snapshot from the WebView. The shuffle history bag is
    /// only reset when the track list actually changed; keeping it across
    /// ordinary load-time resyncs lets Previous work in shuffle mode.
    pub fn resync(
        &mut self,
        tracks: Vec<QueueTrack>,
        current_index: i64,
        repeat: NativeRepeatMode,
        shuffle: bool,
    ) {
        let tracks_changed = self.tracks.len() != tracks.len()
            || self
                .tracks
                .iter()
                .zip(&tracks)
                .any(|(current, next)| current.rating_key != next.rating_key);
        self.tracks = tracks;
        self.current_index = current_index;
        self.repeat = repeat;
        self.shuffle = shuffle;
        if tracks_changed {
            self.bag.clear();
            self.history.clear();
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    #[serde(default)]
    pub artwork_url: Option<String>,
}

/// A fully-downloaded next track already appended to the rodio queue.
#[derive(Clone, Debug)]
struct PendingTrack {
    index: usize,
    duration_seconds: Option<f64>,
    source: String,
    cache_key: Option<String>,
    metadata: NowPlayingMetadata,
    started: Arc<AtomicBool>,
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
    preferred_volume: Mutex<Option<f32>>,
    output_switch_lock: tokio::sync::Mutex<()>,
}

impl NativeAudioEngineSlot {
    pub fn new(cache_root: PathBuf) -> Self {
        remove_orphaned_partial_files(&cache_root);
        Self {
            cache_root,
            inner: Mutex::new(None),
            preferred_device: Mutex::new(None),
            preferred_volume: Mutex::new(None),
            output_switch_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn cache_root(&self) -> &PathBuf {
        &self.cache_root
    }

    fn current(&self) -> Option<Arc<NativeAudioEngine>> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(Arc::clone))
    }

    fn set_volume(&self, volume: f32) {
        let volume = volume.clamp(0.0, 1.0);
        if let Ok(mut preferred) = self.preferred_volume.lock() {
            *preferred = Some(volume);
        }
        if let Some(engine) = self.current() {
            engine.player().set_volume(volume);
        }
    }

    fn volume(&self) -> f32 {
        self.preferred_volume
            .lock()
            .ok()
            .and_then(|volume| *volume)
            .unwrap_or(1.0)
    }

    /// Stop all media work before deleting account-scoped files. The output
    /// switch lock serializes this with foreground loads/device changes, while
    /// the engine gate prevents a new precache from appearing mid-cleanup.
    pub(crate) async fn reset_and_clear_cache(&self) -> Result<(), String> {
        let _operation = self.output_switch_lock.lock().await;
        if let Some(engine) = self.current() {
            let _precache = engine.precache_gate.lock().await;
            engine.cancel_active_work_and_wait().await;
            engine.clear_session_state();
            clear_audio_cache_files(&self.cache_root).await?;
        } else {
            clear_audio_cache_files(&self.cache_root).await?;
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        crate::now_playing::clear();
        Ok(())
    }

    pub fn ensure(&self, app: &AppHandle) -> Result<Arc<NativeAudioEngine>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "原生引擎状态锁失败".to_string())?;
        if let Some(engine) = guard.as_ref() {
            return Ok(Arc::clone(engine));
        }
        let preferred_device = self
            .preferred_device
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(None);
        let preferred_volume = self
            .preferred_volume
            .lock()
            .map(|guard| *guard)
            .unwrap_or(None);
        let engine = Arc::new(
            NativeAudioEngine::new_with_device(
                self.cache_root.clone(),
                preferred_device.as_deref().unwrap_or(""),
            )
            .map_err(|e| format!("原生引擎创建失败: {e}"))?,
        );
        if let Some(volume) = preferred_volume {
            engine.player().set_volume(volume);
        }
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
        let _switch = self.output_switch_lock.lock().await;
        let old = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "原生引擎状态锁失败".to_string())?;
            let Some(old) = guard.as_ref() else {
                if let Ok(mut preferred) = self.preferred_device.lock() {
                    *preferred = Some(device_name);
                }
                return Ok(());
            };
            Arc::clone(old)
        };
        let snapshot = old.capture_playback_snapshot();
        let new_engine = Arc::new(
            NativeAudioEngine::new_with_device(self.cache_root.clone(), &device_name)
                .map_err(|e| format!("切换输出设备失败: {e}"))?,
        );
        // Stop and cancel the old progressive source before the new engine
        // touches the shared cache path. Merely stopping its event forwarder
        // leaves rodio's output stream audible and can corrupt a shared `.part`.
        let stopped_generation = old.stop_immediately();
        if let Err(error) = new_engine.restore_playback_snapshot(&snapshot).await {
            if old.playback_is_current(stopped_generation) {
                let _ = old.restore_playback_snapshot(&snapshot).await;
            }
            return Err(format!("在新输出设备上恢复播放失败: {error}"));
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "原生引擎状态锁失败".to_string())?;
        let still_current = guard
            .as_ref()
            .map(|current| Arc::ptr_eq(current, &old))
            .unwrap_or(false)
            && old.playback_is_current(stopped_generation);
        if !still_current {
            new_engine.stop_immediately();
            return Err("播放状态在输出设备切换期间发生变化，请重试".to_string());
        }
        old.stopped.store(true, Ordering::SeqCst);
        *guard = Some(Arc::clone(&new_engine));
        drop(guard);
        if let Ok(mut preferred) = self.preferred_device.lock() {
            *preferred = Some(device_name);
        }
        if let Ok(preferred) = self.preferred_volume.lock() {
            if let Some(volume) = *preferred {
                new_engine.player().set_volume(volume);
            }
        }
        new_engine.start_event_forwarder(app.clone());
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
        // 引擎不做默认音量：rodio Player 默认 1.0（100%），实际音量由前端
        // 缓存记录并在加载时同步（见 loadNativeTrack 的 nativeAudioSetVolume）。
        Ok(Self {
            sink,
            player: Mutex::new(player),
            cache_root,
            playback_generation: Arc::new(AtomicU64::new(0)),
            artwork_generation: Arc::new(AtomicU64::new(0)),
            transition_lock: Mutex::new(()),
            duration_seconds: Arc::new(Mutex::new(None)),
            loaded: Arc::new(AtomicBool::new(false)),
            ended_sent: Arc::new(AtomicBool::new(false)),
            metadata: Arc::new(Mutex::new(None)),
            queue: Arc::new(Mutex::new(QueueState::default())),
            pending: Arc::new(Mutex::new(None)),
            current_source: Arc::new(Mutex::new(None)),
            artwork_bytes: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(false)),
            last_heartbeat: Arc::new(Mutex::new(None)),
            download_permit: Arc::new(tokio::sync::Semaphore::new(1)),
            precache_gate: tokio::sync::Mutex::new(()),
            active_download: Arc::new(Mutex::new(None)),
            active_precache: Arc::new(Mutex::new(None)),
            active_progress: Arc::new(Mutex::new(None)),
        })
    }

    fn player(&self) -> Arc<Player> {
        self.player
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn cancel_active_work(&self) {
        if let Ok(mut progress) = self.active_progress.lock() {
            if let Some(progress) = progress.take() {
                progress.cancel();
            }
        }
        if let Ok(mut active) = self.active_download.lock() {
            if let Some(handle) = active.take() {
                handle.abort();
            }
        }
        self.cancel_active_precache();
    }

    async fn cancel_active_work_and_wait(&self) {
        let mut handles = Vec::new();
        if let Ok(mut progress) = self.active_progress.lock() {
            if let Some(progress) = progress.take() {
                progress.cancel();
            }
        }
        if let Ok(mut active) = self.active_download.lock() {
            if let Some(handle) = active.take() {
                handle.abort();
                handles.push(handle);
            }
        }
        if let Ok(mut active) = self.active_precache.lock() {
            if let Some(active) = active.take() {
                active.progress.cancel();
                active.handle.abort();
                handles.push(active.handle);
            }
        }
        for handle in handles {
            let _ = handle.await;
        }
    }

    fn cancel_active_precache(&self) {
        if let Ok(mut active) = self.active_precache.lock() {
            if let Some(active) = active.take() {
                active.progress.cancel();
                active.handle.abort();
                let _ = std::fs::remove_file(active.part_path);
            }
        }
    }

    fn clear_active_precache(&self, progress: &Arc<DownloadProgress>) {
        if let Ok(mut active) = self.active_precache.lock() {
            let is_same = active
                .as_ref()
                .map(|active| Arc::ptr_eq(&active.progress, progress))
                .unwrap_or(false);
            if is_same {
                *active = None;
            }
        }
    }

    /// Replace the rodio control handle instead of calling `Player::clear()`.
    /// rodio's clear waits synchronously for the audio thread; a progressive
    /// source may be waiting for network bytes, which can otherwise freeze a
    /// synchronous Tauri command and the WebView that issued it.
    fn replace_player(&self) {
        let mut player = self
            .player
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let volume = player.volume();
        let replacement = Arc::new(Player::connect_new(self.sink.mixer()));
        replacement.set_volume(volume);
        let previous = std::mem::replace(&mut *player, replacement);
        previous.stop();
    }

    fn begin_playback_transition(&self) -> u64 {
        let _transition = self
            .transition_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let generation = self.playback_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.loaded.store(false, Ordering::SeqCst);
        self.ended_sent.store(true, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending.lock() {
            *pending = None;
        }
        self.cancel_active_work();
        self.replace_player();
        generation
    }

    fn playback_is_current(&self, generation: u64) -> bool {
        self.playback_generation.load(Ordering::SeqCst) == generation
    }

    fn stop_immediately(&self) -> u64 {
        self.begin_playback_transition()
    }

    fn clear_session_state(&self) {
        self.begin_playback_transition();
        self.artwork_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut metadata) = self.metadata.lock() {
            *metadata = None;
        }
        if let Ok(mut source) = self.current_source.lock() {
            *source = None;
        }
        if let Ok(mut artwork) = self.artwork_bytes.lock() {
            *artwork = None;
        }
        if let Ok(mut duration) = self.duration_seconds.lock() {
            *duration = None;
        }
        if let Ok(mut queue) = self.queue.lock() {
            *queue = QueueState::default();
        }
    }

    fn resolve_cache_paths(
        &self,
        cache_key: Option<String>,
    ) -> Result<(String, PathBuf, PathBuf), String> {
        resolve_audio_cache_paths(&self.cache_root, cache_key.as_deref())
    }

    /// Background-fetch the album artwork bytes from the loopback artwork
    /// ticket and cache them for the system now-playing update. The URL never
    /// reaches PMS directly; the proxy validates the ticket.
    fn start_artwork_fetch(&self, artwork_url: &str, generation: u64) {
        if !self.playback_is_current(generation) {
            return;
        }
        let artwork_generation = self.artwork_generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut artwork) = self.artwork_bytes.lock() {
            *artwork = None;
        }
        if artwork_url.is_empty() {
            return;
        }
        let artwork_bytes = Arc::clone(&self.artwork_bytes);
        let playback_generation = Arc::clone(&self.playback_generation);
        let current_artwork_generation = Arc::clone(&self.artwork_generation);
        let url = artwork_url.to_string();
        tauri::async_runtime::spawn(async move {
            let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
            else {
                eprintln!("[播放] NowPlaying 封面客户端创建失败");
                return;
            };
            let response = match client.get(&url).send().await {
                Ok(response) => response,
                Err(error) => {
                    eprintln!("[播放] NowPlaying 封面读取失败：{error}");
                    return;
                }
            };
            if !response.status().is_success() {
                eprintln!("[播放] NowPlaying 封面读取失败：HTTP {}", response.status());
                return;
            }
            const MAX_ARTWORK_BYTES: usize = 12 * 1024 * 1024;
            if response
                .content_length()
                .is_some_and(|length| length > MAX_ARTWORK_BYTES as u64)
            {
                eprintln!("[播放] NowPlaying 封面超过 12 MiB 上限");
                return;
            }
            let mut stream = response.bytes_stream();
            let mut data = Vec::new();
            while let Some(chunk) = stream.next().await {
                if playback_generation.load(Ordering::SeqCst) != generation
                    || current_artwork_generation.load(Ordering::SeqCst) != artwork_generation
                {
                    return;
                }
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        eprintln!("[播放] NowPlaying 封面响应读取失败：{error}");
                        return;
                    }
                };
                if data.len().saturating_add(chunk.len()) > MAX_ARTWORK_BYTES {
                    eprintln!("[播放] NowPlaying 封面超过 12 MiB 上限");
                    return;
                }
                data.extend_from_slice(&chunk);
            }
            if data.is_empty() {
                eprintln!(
                    "[播放] NowPlaying 封面大小无效：artwork_bytes={}",
                    data.len()
                );
                return;
            }
            if playback_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if current_artwork_generation.load(Ordering::SeqCst) != artwork_generation {
                return;
            }
            let data_len = data.len();
            if let Ok(mut artwork) = artwork_bytes.lock() {
                *artwork = Some(Arc::new(data));
            }
            eprintln!("[播放] NowPlaying 封面就绪：artwork_bytes={data_len}");
        });
    }

    /// Mark a queued artwork ticket as active while it is still fresh. Unused
    /// loopback tickets expire after 90 seconds, which is shorter than a normal
    /// track; a HEAD request extends the idle window without publishing the
    /// next cover before its sample-level handoff.
    fn prime_artwork_ticket(&self, artwork_url: &str, generation: u64) {
        if artwork_url.is_empty() || !self.playback_is_current(generation) {
            return;
        }
        let playback_generation = Arc::clone(&self.playback_generation);
        let url = artwork_url.to_string();
        tauri::async_runtime::spawn(async move {
            let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
            else {
                return;
            };
            let outcome = client.head(&url).send().await;
            if playback_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            match outcome {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => eprintln!(
                    "[播放] NowPlaying 预排封面票据激活失败：HTTP {}",
                    response.status()
                ),
                Err(error) => eprintln!("[播放] NowPlaying 预排封面票据激活失败：{error}"),
            }
        });
    }

    /// Load a local media file and start playing it.
    pub fn load_and_play(&self, path: &str) -> Result<usize, String> {
        let generation = self.begin_playback_transition();
        let metadata = self
            .metadata
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(None)
            .unwrap_or_default();
        self.start_artwork_fetch(metadata.artwork_url.as_deref().unwrap_or(""), generation);
        self.load_file_for_generation(
            path,
            generation,
            CurrentSource {
                source: path.to_string(),
                cache_key: None,
                metadata,
            },
        )
    }

    fn load_file_for_generation(
        &self,
        path: &str,
        generation: u64,
        current_source: CurrentSource,
    ) -> Result<usize, String> {
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
        let player = self
            .player
            .lock()
            .map_err(|_| "播放器状态锁失败".to_string())?;
        if !self.playback_is_current(generation) {
            return Err("播放加载已被新操作替代".to_string());
        }
        *self
            .current_source
            .lock()
            .map_err(|_| "媒体来源状态锁失败".to_string())? = Some(current_source);
        *self
            .duration_seconds
            .lock()
            .map_err(|_| "时长状态锁失败".to_string())? = total;
        player.append(decoder);
        player.play();
        self.loaded.store(true, Ordering::SeqCst);
        self.ended_sent.store(false, Ordering::SeqCst);
        eprintln!(
            "[原生] rodio 载入媒体成功 队列={} 时长={:?}",
            player.len(),
            total,
        );
        Ok(player.len())
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
        let generation = self.begin_playback_transition();
        let metadata_for_source = metadata.clone();
        *self
            .metadata
            .lock()
            .map_err(|_| "元数据状态锁失败".to_string())? = metadata;
        if let Some(meta) = metadata_for_source.as_ref() {
            self.start_artwork_fetch(meta.artwork_url.as_deref().unwrap_or(""), generation);
        } else {
            self.start_artwork_fetch("", generation);
        }
        if !(source.starts_with("http://") || source.starts_with("https://")) {
            return self.load_file_for_generation(
                source,
                generation,
                CurrentSource {
                    source: source.to_string(),
                    cache_key,
                    metadata: metadata_for_source.unwrap_or_default(),
                },
            );
        }
        // Foreground playback owns admission priority over all speculative
        // work. Holding the gate until its download task owns the single PMS
        // permit prevents a newly-arriving precache from recreating the same
        // `.part` after the generation transition cancelled the old one.
        let precache_gate = self.precache_gate.lock().await;
        self.cancel_active_precache();
        let (key, final_path, part_path) = self.resolve_cache_paths(cache_key.clone())?;
        let final_ready = std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        if final_ready {
            match self.load_file_for_generation(
                final_path.to_str().unwrap(),
                generation,
                CurrentSource {
                    source: source.to_string(),
                    cache_key: cache_key.clone(),
                    metadata: metadata_for_source.clone().unwrap_or_default(),
                },
            ) {
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
        if !self.playback_is_current(generation) {
            return Err("播放加载已被新操作替代".to_string());
        }
        let permit = self
            .download_permit
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "下载并发控制失败".to_string())?;
        if !self.playback_is_current(generation) {
            return Err("播放加载已被新操作替代".to_string());
        }
        {
            let mut active_progress = self
                .active_progress
                .lock()
                .map_err(|_| "播放下载状态锁失败".to_string())?;
            if !self.playback_is_current(generation) {
                return Err("播放加载已被新操作替代".to_string());
            }
            *active_progress = Some(Arc::clone(&progress));
        }
        let task = tauri::async_runtime::spawn(async move {
            let _permit = permit;
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
        if let Ok(mut active) = self.active_download.lock() {
            if self.playback_is_current(generation) {
                *active = Some(task);
            } else {
                task.abort();
                return Err("播放加载已被新操作替代".to_string());
            }
        }
        drop(precache_gate);

        // Wait for the head bytes (or terminal state) before decoding.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while progress.downloaded.load(Ordering::SeqCst) < MIN_PROGRESSIVE_PRELOAD_BYTES
            && !progress.failed.load(Ordering::SeqCst)
            && !progress.finished.load(Ordering::SeqCst)
            && !progress.cancelled.load(Ordering::SeqCst)
            && self.playback_is_current(generation)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if progress.cancelled.load(Ordering::SeqCst) || !self.playback_is_current(generation) {
            return Err("播放加载已被新操作替代".to_string());
        }
        if progress.downloaded.load(Ordering::SeqCst) < MIN_PROGRESSIVE_PRELOAD_BYTES
            && !progress.finished.load(Ordering::SeqCst)
        {
            progress.cancel();
            if let Ok(mut active) = self.active_download.lock() {
                if let Some(handle) = active.take() {
                    handle.abort();
                }
            }
            return Err("下载歌曲超时，无法开始播放".to_string());
        }
        if progress.failed.load(Ordering::SeqCst) {
            return Err("下载歌曲失败，无法开始播放".to_string());
        }
        if progress.finished.load(Ordering::SeqCst) {
            // 小文件/快速下载可能在等待期间已完整落盘并改名。
            return self.load_file_for_generation(
                final_path.to_str().unwrap(),
                generation,
                CurrentSource {
                    source: source.to_string(),
                    cache_key,
                    metadata: metadata_for_source.unwrap_or_default(),
                },
            );
        }
        let file = std::fs::File::open(&part_path).map_err(|e| format!("打开渐进缓存失败: {e}"))?;
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
        let player = self
            .player
            .lock()
            .map_err(|_| "播放器状态锁失败".to_string())?;
        if !self.playback_is_current(generation) {
            return Err("播放加载已被新操作替代".to_string());
        }
        if let Ok(mut current_source) = self.current_source.lock() {
            *current_source = Some(CurrentSource {
                source: source.to_string(),
                cache_key,
                metadata: metadata_for_source.unwrap_or_default(),
            });
        }
        *self
            .duration_seconds
            .lock()
            .map_err(|_| "时长状态锁失败".to_string())? = total;
        player.append(decoder);
        player.play();
        self.loaded.store(true, Ordering::SeqCst);
        self.ended_sent.store(false, Ordering::SeqCst);
        eprintln!(
            "[原生] 渐进播放开始 key={key} 已预载={} 时长={:?}",
            progress.downloaded.load(Ordering::SeqCst),
            total,
        );
        let cache_root = self.cache_root.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            enforce_audio_cache_limit(&cache_root);
        });
        Ok(player.len())
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
        let generation = self.playback_generation.load(Ordering::SeqCst);
        if !(source.starts_with("http://") || source.starts_with("https://")) {
            return Ok(());
        }
        let (key, final_path, part_path) = self.resolve_cache_paths(cache_key)?;
        if std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            touch_cache_file(&final_path);
            return Ok(());
        }
        let gate = self.precache_gate.lock().await;
        // Recheck after admission: the preceding task may have committed while
        // this caller was waiting for the gate.
        if std::fs::metadata(&final_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            touch_cache_file(&final_path);
            return Ok(());
        }
        let immediate_next = rate_limit_bytes_per_sec.is_none();
        let shared_completion = self
            .active_precache
            .lock()
            .map_err(|_| "预缓存任务状态锁失败".to_string())?
            .as_ref()
            .filter(|active| {
                active.cache_key == key && !(immediate_next && active.rate_limited)
            })
            .map(|active| active.completion.clone());
        if let Some(completion) = shared_completion {
            drop(gate);
            return await_precache_completion(completion).await;
        }
        let permit = if immediate_next {
            // Immediate next is playback-critical. Cancel any throttled
            // far-ahead job, then wait for the single PMS stream permit.
            self.cancel_active_precache();
            self.download_permit
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "下载并发控制失败".to_string())?
        } else {
            // Far-ahead warming is opportunistic and must never queue ahead of
            // either active playback or an immediate-next download.
            let Ok(permit) = self.download_permit.clone().try_acquire_owned() else {
                return Ok(());
            };
            permit
        };
        if !self.playback_is_current(generation) {
            return Ok(());
        }
        let _ = std::fs::remove_file(&part_path);
        let progress = DownloadProgress::new();
        let progress_task = Arc::clone(&progress);
        let part_for_task = part_path.clone();
        let final_for_task = final_path;
        let source_for_task = source.to_string();
        let client = reqwest::Client::new();
        let (completion_tx, completion_rx) =
            tokio::sync::watch::channel::<Option<Result<(), String>>>(None);
        let task = tauri::async_runtime::spawn(async move {
            let _permit = permit;
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
            let _ = completion_tx.send(Some(outcome.map(|_| ())));
        });
        {
            let mut active = self
                .active_precache
                .lock()
                .map_err(|_| "预缓存任务状态锁失败".to_string())?;
            if self.playback_is_current(generation) {
                *active = Some(ActivePrecache {
                    cache_key: key,
                    rate_limited: rate_limit_bytes_per_sec.is_some(),
                    progress: Arc::clone(&progress),
                    part_path,
                    handle: task,
                    completion: completion_rx.clone(),
                });
            } else {
                task.abort();
                return Ok(());
            }
        }
        drop(gate);
        let outcome = await_precache_completion(completion_rx).await;
        self.clear_active_precache(&progress);
        outcome?;
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
        source: &str,
        cache_key: Option<String>,
        metadata: Option<NowPlayingMetadata>,
    ) -> Result<(), String> {
        let generation = self.playback_generation.load(Ordering::SeqCst);
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
        let (_, final_path, _) = self.resolve_cache_paths(cache_key.clone())?;
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
        let mut metadata = metadata.unwrap_or_default();
        if metadata.title.as_deref().unwrap_or("").is_empty() {
            metadata.title = Some(track.title);
        }
        if metadata.artist.as_deref().unwrap_or("").is_empty() {
            metadata.artist = Some(track.artist);
        }
        if metadata.album.as_deref().unwrap_or("").is_empty() {
            metadata.album = Some(track.album);
        }
        let artwork_url = metadata.artwork_url.clone().unwrap_or_default();
        let started = Arc::new(AtomicBool::new(false));
        let marker = HandoffMarker {
            inner: decoder,
            started: Arc::clone(&started),
        };
        let _transition = self
            .transition_lock
            .lock()
            .map_err(|_| "播放切换状态锁失败".to_string())?;
        if !self.playback_is_current(generation) || !self.loaded.load(Ordering::SeqCst) {
            return Err("当前播放已切换".to_string());
        }
        let player = self
            .player
            .lock()
            .map_err(|_| "播放器状态锁失败".to_string())?;
        player.append(marker);
        *self
            .pending
            .lock()
            .map_err(|_| "预排状态锁失败".to_string())? = Some(PendingTrack {
            index,
            duration_seconds: total,
            source: source.to_string(),
            cache_key,
            metadata,
            started,
        });
        eprintln!(
            "[原生] 已预排下一首 index={index} 时长={total:?} 队列={}",
            player.len(),
        );
        drop(player);
        drop(_transition);
        self.prime_artwork_ticket(&artwork_url, generation);
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
        if let Ok(mut duration_guard) = self.duration_seconds.lock() {
            *duration_guard = queued.duration_seconds;
        }
        if let Ok(mut metadata_guard) = self.metadata.lock() {
            *metadata_guard = Some(queued.metadata.clone());
        }
        if let Ok(mut source_guard) = self.current_source.lock() {
            *source_guard = Some(CurrentSource {
                source: queued.source.clone(),
                cache_key: queued.cache_key.clone(),
                metadata: queued.metadata.clone(),
            });
        }
        let generation = self.playback_generation.load(Ordering::SeqCst);
        self.start_artwork_fetch(
            queued.metadata.artwork_url.as_deref().unwrap_or(""),
            generation,
        );
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
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut last_now_playing_signature: Option<(
            NowPlayingMetadata,
            Option<u64>,
            crate::now_playing::PlaybackState,
            Option<(usize, usize)>,
        )> = None;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut last_now_playing_at: Option<std::time::Instant> = None;
        // 引擎可能在同步 Tauri 命令（native_queue_set 等）里首次创建，
        // tokio::spawn 在无运行时上下文的主线程会 panic；用 Tauri 全局
        // 运行时可同时兼容同步/异步调用。
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if engine.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let player = engine.player();
                let position = player.get_pos().as_secs_f64();
                // Commit a sample-level handoff before publishing system media
                // state, otherwise one poll can expose track B's position with
                // track A's metadata and artwork.
                let (pending_exists, pending_started) = engine
                    .pending
                    .lock()
                    .map(|guard| {
                        let started = guard
                            .as_ref()
                            .map(|queued| queued.started.load(Ordering::SeqCst))
                            .unwrap_or(false);
                        (guard.is_some(), started)
                    })
                    .unwrap_or((false, false));
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
                        if player.empty() {
                            publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                            continue;
                        }
                    }
                } else if engine.loaded.load(Ordering::SeqCst) && pending_exists && player.empty() {
                    if engine.consume_failed_handoff().is_some() {
                        publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                        continue;
                    }
                }
                let duration_value = engine
                    .duration_seconds
                    .lock()
                    .map(|guard| *guard)
                    .unwrap_or(None);
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                {
                    let playback_state = if !engine.loaded.load(Ordering::SeqCst) || player.empty()
                    {
                        crate::now_playing::PlaybackState::Stopped
                    } else if player.is_paused() {
                        crate::now_playing::PlaybackState::Paused
                    } else {
                        crate::now_playing::PlaybackState::Playing
                    };
                    let meta = engine
                        .metadata
                        .lock()
                        .map(|guard| guard.clone())
                        .unwrap_or(None);
                    if let Some(meta) = meta {
                        let artwork = engine
                            .artwork_bytes
                            .lock()
                            .map(|guard| guard.clone())
                            .unwrap_or(None);
                        let artwork_identity = artwork
                            .as_ref()
                            .map(|bytes| (Arc::as_ptr(bytes) as usize, bytes.len()));
                        let signature = (
                            meta.clone(),
                            duration_value.map(f64::to_bits),
                            playback_state,
                            artwork_identity,
                        );
                        let periodic_refresh_due = last_now_playing_at
                            .map(|at| at.elapsed() >= Duration::from_secs(2))
                            .unwrap_or(true);
                        if last_now_playing_signature.as_ref() != Some(&signature)
                            || periodic_refresh_due
                        {
                            crate::now_playing::update_metadata(
                                meta.title.as_deref().unwrap_or(""),
                                meta.artist.as_deref().unwrap_or(""),
                                meta.album.as_deref().unwrap_or(""),
                                duration_value,
                                position,
                                playback_state,
                                artwork,
                            );
                            last_now_playing_signature = Some(signature);
                            last_now_playing_at = Some(std::time::Instant::now());
                        }
                    }
                }

                let ended = engine.loaded.load(Ordering::SeqCst)
                    && !engine.ended_sent.load(Ordering::SeqCst)
                    && player.empty()
                    && position > 0.05;
                if ended {
                    publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                    continue;
                }
                // 心跳看门狗：WebView 崩溃或主线程被同步命令卡死时，前端心跳会
                // 停止。只要此时还在出声就立刻清空播放器，绝不让音乐停不下来。
                let heartbeat_lost = engine
                    .last_heartbeat
                    .lock()
                    .map(|heartbeat| {
                        heartbeat
                            .map(|at| at.elapsed() >= HEARTBEAT_STALL_TIMEOUT)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                let audibly_playing = !player.is_paused() && !player.empty();
                if heartbeat_lost && audibly_playing {
                    engine.stop_immediately();
                    eprintln!("[原生] 前端心跳丢失，自动停止播放（保护）");
                    let _ = app_for_task.emit(
                        "native-audio://event",
                        serde_json::json!({
                            "type": "playback-protected-stop",
                            "reason": "heartbeat-lost",
                        }),
                    );
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
        result.insert(
            "device".into(),
            serde_json::Value::String("无默认输出设备".into()),
        );
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
                    config.sample_rate, config.channels, sample_format, config.buffer_size,
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
                        result.insert(
                            "play".into(),
                            serde_json::Value::String(format!("失败: {e}")),
                        );
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
    eprintln!(
        "[原生] 设备自检：{}",
        serde_json::to_string(&value).unwrap_or_default()
    );
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
    NativeCacheStatus {
        size_bytes,
        file_count,
    }
}

#[tauri::command]
pub async fn native_audio_clear_cache(
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    state.reset_and_clear_cache().await
}

#[tauri::command]
pub async fn native_audio_load(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    source: String,
    cache_key: Option<String>,
    metadata: Option<NowPlayingMetadata>,
) -> Result<usize, String> {
    let _operation = state.output_switch_lock.lock().await;
    let engine = state.ensure(&app)?;
    engine
        .load_cached_and_play(&source, cache_key, metadata)
        .await
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
    source: String,
    cache_key: Option<String>,
    metadata: Option<NowPlayingMetadata>,
) -> Result<(), String> {
    let engine = state.ensure(&app)?;
    engine.queue_next_source(index, &source, cache_key, metadata)
}

#[tauri::command]
pub fn native_audio_play(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let engine = state
        .current()
        .ok_or_else(|| "当前没有可恢复的播放".to_string())?;
    engine.player().play();
    Ok(())
}

#[tauri::command]
pub fn native_audio_pause(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    let _ = app;
    if let Some(engine) = state.current() {
        engine.player().pause();
    }
}

#[tauri::command]
pub fn native_audio_stop(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    let _ = app;
    if let Some(engine) = state.current() {
        engine.stop_immediately();
    }
}

#[tauri::command]
pub fn native_audio_heartbeat(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    let _ = app;
    if let Some(engine) = state.current() {
        if let Ok(mut heartbeat) = engine.last_heartbeat.lock() {
            *heartbeat = Some(std::time::Instant::now());
        }
    }
}

#[tauri::command]
pub async fn native_audio_seek(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    seconds: f64,
) -> Result<(), String> {
    let _ = app;
    let _operation = state.output_switch_lock.lock().await;
    let player = state
        .current()
        .ok_or_else(|| "当前没有可定位的播放".to_string())?
        .player();
    tauri::async_runtime::spawn_blocking(move || {
        player
            .try_seek(Duration::from_secs_f64(seconds.max(0.0)))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("定位播放任务失败: {error}"))?
}

#[tauri::command]
pub fn native_audio_set_volume(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    volume: f32,
) {
    let _ = app;
    state.set_volume(volume);
}

#[tauri::command]
pub fn native_audio_status(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> NativeStatus {
    let _ = app;
    let Some(engine) = state.current() else {
        return NativeStatus {
            is_playing: false,
            position_seconds: None,
            duration_seconds: None,
            volume: state.volume(),
            item_count: 0,
            current_index: None,
        };
    };
    let player = engine.player();
    NativeStatus {
        is_playing: !player.empty() && !player.is_paused(),
        position_seconds: Some(player.get_pos().as_secs_f64()),
        duration_seconds: engine
            .duration_seconds
            .lock()
            .map(|guard| *guard)
            .unwrap_or(None),
        volume: player.volume(),
        item_count: player.len(),
        current_index: engine
            .queue
            .lock()
            .ok()
            .and_then(|queue| usize::try_from(queue.current_index).ok()),
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
    queue.resync(tracks, current_index, repeat, shuffle);
    Ok(())
}

#[tauri::command]
pub fn native_queue_next(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<usize, String> {
    let engine = state.ensure(&app)?;
    let mut queue = engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?;
    let next = queue
        .next_index(false)
        .ok_or_else(|| "队列已结束".to_string())?;
    queue.current_index = next as i64;
    Ok(next)
}

#[tauri::command]
pub fn native_queue_previous(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<usize, String> {
    let engine = state.ensure(&app)?;
    let mut queue = engine
        .queue
        .lock()
        .map_err(|_| "队列状态锁失败".to_string())?;
    let previous = queue
        .previous_index()
        .ok_or_else(|| "没有上一首".to_string())?;
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
    queue.history.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
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

    fn unique_temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cadilume-{label}-{}", uuid::Uuid::new_v4()))
    }

    fn test_cache_paths(cache_root: &Path, identity: &str) -> (PathBuf, PathBuf) {
        let (_, final_path, part_path) =
            resolve_audio_cache_paths(cache_root, Some(identity)).unwrap();
        (final_path, part_path)
    }

    #[test]
    fn cache_identity_is_stable_isolated_and_not_exposed_in_paths() {
        let identity = "server-secret:account-a:track-7:original:/library/parts/99.flac";
        let same = audio_cache_key(Some(identity)).unwrap();
        assert_eq!(same, audio_cache_key(Some(identity)).unwrap());
        assert_eq!(same.len(), 64, "SHA-256 key 应为 64 位十六进制");
        assert!(same.chars().all(|character| character.is_ascii_hexdigit()));
        assert!(!same.contains("server") && !same.contains("track"));
        assert_ne!(
            same,
            audio_cache_key(Some("server-b:track-7:original")).unwrap()
        );
        assert_ne!(
            same,
            audio_cache_key(Some("server-secret:track-7:192")).unwrap()
        );
        assert!(audio_cache_key(Some(&"x".repeat(MAX_AUDIO_CACHE_IDENTITY_BYTES + 1))).is_err());
    }

    #[test]
    fn lru_evicts_oldest_complete_file_without_touching_active_partial() {
        let cache_root = unique_temp_path("lru-cache");
        let downloads = audio_cache_dir(&cache_root);
        std::fs::create_dir_all(&downloads).unwrap();
        let old = downloads.join("old.audio");
        let recent = downloads.join("recent.audio");
        let active = downloads.join("active.audio.part");
        std::fs::write(&old, [1u8; 6]).unwrap();
        std::fs::write(&recent, [2u8; 6]).unwrap();
        std::fs::write(&active, [3u8; 64]).unwrap();
        filetime::set_file_mtime(&old, filetime::FileTime::from_unix_time(10, 0)).unwrap();
        filetime::set_file_mtime(&recent, filetime::FileTime::from_unix_time(20, 0)).unwrap();

        enforce_audio_cache_limit_with_limit(&cache_root, 8);

        assert!(!old.exists(), "最旧的完整缓存应先淘汰");
        assert!(recent.exists(), "达到容量后应保留较新的完整缓存");
        assert!(active.exists(), "LRU 不得删除活动 .part");
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[test]
    fn slot_startup_removes_only_orphaned_partial_files() {
        let cache_root = unique_temp_path("startup-cleanup-cache");
        let downloads = audio_cache_dir(&cache_root);
        std::fs::create_dir_all(&downloads).unwrap();
        let complete = downloads.join("keep.audio");
        let orphan = downloads.join("remove.audio.part");
        std::fs::write(&complete, [1u8; 8]).unwrap();
        std::fs::write(&orphan, [2u8; 8]).unwrap();

        let _slot = NativeAudioEngineSlot::new(cache_root.clone());

        assert!(complete.exists());
        assert!(!orphan.exists());
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[test]
    fn now_playing_metadata_accepts_frontend_camel_case_artwork_url() {
        let metadata: NowPlayingMetadata = serde_json::from_value(serde_json::json!({
            "title": "Track",
            "artist": "Artist",
            "album": "Album",
            "artworkUrl": "http://127.0.0.1:1234/artwork/ticket"
        }))
        .unwrap();
        assert_eq!(
            metadata.artwork_url.as_deref(),
            Some("http://127.0.0.1:1234/artwork/ticket")
        );
    }

    #[test]
    fn cancelling_progressive_reader_wakes_it_immediately() {
        let path = unique_temp_path("cancel-reader.part");
        std::fs::write(&path, []).unwrap();
        let progress = DownloadProgress::new();
        let progress_for_reader = Arc::clone(&progress);
        let path_for_reader = path.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = ProgressiveFile {
                file: std::fs::File::open(path_for_reader).unwrap(),
                progress: progress_for_reader,
            };
            let mut byte = [0u8; 1];
            let result = reader.read(&mut byte);
            let _ = done_tx.send(result);
        });

        std::thread::sleep(Duration::from_millis(50));
        let started = std::time::Instant::now();
        progress.cancel();
        let result = done_rx
            .recv_timeout(Duration::from_millis(500))
            .expect("取消后 reader 必须立即醒来")
            .expect("取消按 EOF 结束，不应产生 I/O 错误");
        assert_eq!(result, 0);
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "取消唤醒不应依赖 150ms 轮询超时"
        );
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn stop_does_not_wait_for_a_progressive_reader() {
        let cache_root = unique_temp_path("stop-progressive-cache");
        let full_wav = unique_temp_path("stop-progressive.wav");
        let partial_wav = unique_temp_path("stop-progressive.audio.part");
        write_test_wav_of_seconds(&full_wav, 30);
        let bytes = std::fs::read(&full_wav).unwrap();
        std::fs::write(&partial_wav, &bytes[..8 * 1024]).unwrap();

        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        let progress = DownloadProgress::new();
        progress.downloaded.store(8 * 1024, Ordering::SeqCst);
        progress
            .expected_len
            .store(bytes.len() as u64, Ordering::SeqCst);
        *engine.active_progress.lock().unwrap() = Some(Arc::clone(&progress));
        let reader = ProgressiveFile {
            file: std::fs::File::open(&partial_wav).unwrap(),
            progress,
        };
        let decoder = Decoder::builder()
            .with_data(reader)
            .with_seekable(true)
            .with_byte_len(bytes.len() as u64)
            .build()
            .unwrap();
        engine.player().append(decoder);
        engine.loaded.store(true, Ordering::SeqCst);
        engine.player().play();
        // The short partial body is exhausted well before this deadline, so
        // the audio thread is waiting for bytes when stop is issued.
        tokio::time::sleep(Duration::from_millis(600)).await;

        let started = std::time::Instant::now();
        engine.stop_immediately();
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "stop 必须是非阻塞控制操作，实际 {:?}",
            started.elapsed()
        );
        let _ = std::fs::remove_file(full_wav);
        let _ = std::fs::remove_file(partial_wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn rapid_transitions_accept_only_the_latest_generation() {
        let cache_root = unique_temp_path("generation-cache");
        let wav = unique_temp_path("generation.wav");
        write_test_wav_of_seconds(&wav, 1);
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);

        let stale_generation = engine.begin_playback_transition();
        let mut latest_generation = stale_generation;
        for _ in 0..128 {
            latest_generation = engine.begin_playback_transition();
        }
        let source = CurrentSource {
            source: wav.to_string_lossy().into_owned(),
            cache_key: None,
            metadata: NowPlayingMetadata::default(),
        };
        assert!(
            engine
                .load_file_for_generation(wav.to_str().unwrap(), stale_generation, source.clone(),)
                .is_err(),
            "旧代加载不能反写播放器"
        );
        engine
            .load_file_for_generation(wav.to_str().unwrap(), latest_generation, source)
            .expect("最后一代应能加载");
        assert!(engine.loaded.load(Ordering::SeqCst));
        engine.stop_immediately();
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn immediate_next_preempts_rate_limited_ahead_and_cleans_partial_file() {
        let wav = unique_temp_path("precache-priority.wav");
        write_test_wav_of_seconds(&wav, 1);
        let data = std::fs::read(&wav).unwrap();
        let ahead_data = data.clone();
        let next_data = data.clone();
        let app = axum::Router::new()
            .route(
                "/ahead.wav",
                axum::routing::get(|| async move {
                    (
                        [(axum::http::header::CONTENT_TYPE, "audio/wav")],
                        ahead_data,
                    )
                }),
            )
            .route(
                "/next.wav",
                axum::routing::get(|| async move {
                    ([(axum::http::header::CONTENT_TYPE, "audio/wav")], next_data)
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("precache-priority-cache");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        let ahead_url = format!("http://127.0.0.1:{}/ahead.wav", addr.port());
        let next_url = format!("http://127.0.0.1:{}/next.wav", addr.port());
        let ahead_engine = Arc::clone(&engine);
        let ahead = tokio::spawn(async move {
            ahead_engine
                .precache(&ahead_url, Some("ahead".into()), Some(1024))
                .await
        });
        let active_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while engine.active_precache.lock().unwrap().is_none()
            && std::time::Instant::now() < active_deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            engine.active_precache.lock().unwrap().is_some(),
            "限速 ahead 应先进入活动状态"
        );

        let started = std::time::Instant::now();
        engine
            .precache(&next_url, Some("next".into()), None)
            .await
            .expect("即时下一首应抢占并完成");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "即时下一首不能等待限速 ahead，实际 {:?}",
            started.elapsed()
        );
        let (next_cache, _) = test_cache_paths(&cache_root, "next");
        assert_eq!(std::fs::metadata(next_cache).unwrap().len(), data.len() as u64);
        let (_, ahead_partial) = test_cache_paths(&cache_root, "ahead");
        assert!(
            !ahead_partial.exists(),
            "取消的 ahead 不得遗留 .part"
        );
        assert!(ahead.await.unwrap().is_err(), "被抢占的 ahead 应明确中止");
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn concurrent_same_identity_precache_uses_one_http_request() {
        let wav = unique_temp_path("deduplicated-precache.wav");
        write_test_wav_of_seconds(&wav, 2);
        let data = Arc::new(std::fs::read(&wav).unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new().route(
            "/same.wav",
            axum::routing::get({
                let data = Arc::clone(&data);
                let requests = Arc::clone(&requests);
                move || {
                    let data = Arc::clone(&data);
                    let requests = Arc::clone(&requests);
                    async move {
                        requests.fetch_add(1, AtomicOrdering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        (
                            [(axum::http::header::CONTENT_TYPE, "audio/wav")],
                            data.as_ref().clone(),
                        )
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("deduplicated-precache-cache");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        let url = format!("http://127.0.0.1:{}/same.wav", addr.port());
        let mut callers = Vec::new();
        for _ in 0..64 {
            let engine = Arc::clone(&engine);
            let url = url.clone();
            callers.push(tokio::spawn(async move {
                engine
                    .precache(&url, Some("same-media-identity".into()), None)
                    .await
            }));
        }
        for caller in callers {
            caller.await.unwrap().expect("共享预取调用均应成功");
        }
        assert_eq!(
            requests.load(AtomicOrdering::SeqCst),
            1,
            "64 个同键调用只能触发一次 HTTP 下载"
        );
        let (cached, partial) = test_cache_paths(&cache_root, "same-media-identity");
        assert_eq!(std::fs::metadata(cached).unwrap().len(), data.len() as u64);
        assert!(!partial.exists());
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn immediate_next_promotes_same_identity_out_of_rate_limited_ahead() {
        let wav = unique_temp_path("promoted-precache.wav");
        write_test_wav_of_seconds(&wav, 2);
        let data = std::fs::read(&wav).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new().route(
            "/promote.wav",
            axum::routing::get({
                let data = data.clone();
                let requests = Arc::clone(&requests);
                move || {
                    let data = data.clone();
                    let requests = Arc::clone(&requests);
                    async move {
                        requests.fetch_add(1, AtomicOrdering::SeqCst);
                        ([(axum::http::header::CONTENT_TYPE, "audio/wav")], data)
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("promoted-precache-cache");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        let url = format!("http://127.0.0.1:{}/promote.wav", addr.port());
        let ahead_engine = Arc::clone(&engine);
        let ahead_url = url.clone();
        let ahead = tokio::spawn(async move {
            ahead_engine
                .precache(&ahead_url, Some("same-promoted-media".into()), Some(1024))
                .await
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while (engine.active_precache.lock().unwrap().is_none()
            || requests.load(AtomicOrdering::SeqCst) == 0)
            && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let started = std::time::Instant::now();
        engine
            .precache(&url, Some("same-promoted-media".into()), None)
            .await
            .expect("即时下一首应取消同键限速任务并全速完成");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(ahead.await.unwrap().is_err());
        assert_eq!(requests.load(AtomicOrdering::SeqCst), 2);
        let (cached, partial) = test_cache_paths(&cache_root, "same-promoted-media");
        assert_eq!(std::fs::metadata(cached).unwrap().len(), data.len() as u64);
        assert!(!partial.exists());
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn account_reset_cancels_active_precache_and_removes_all_audio_files() {
        let wav = unique_temp_path("account-reset.wav");
        write_test_wav_of_seconds(&wav, 4);
        let data = std::fs::read(&wav).unwrap();
        let app = axum::Router::new().route(
            "/slow.wav",
            axum::routing::get(move || {
                let data = data.clone();
                async move { ([(axum::http::header::CONTENT_TYPE, "audio/wav")], data) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("account-reset-cache");
        let slot = Arc::new(NativeAudioEngineSlot::new(cache_root.clone()));
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        *slot.inner.lock().unwrap() = Some(Arc::clone(&engine));
        let url = format!("http://127.0.0.1:{}/slow.wav", addr.port());
        let precache_engine = Arc::clone(&engine);
        let precache = tokio::spawn(async move {
            precache_engine
                .precache(&url, Some("account-a-media".into()), Some(1024))
                .await
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while engine.active_precache.lock().unwrap().is_none()
            && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(engine.active_precache.lock().unwrap().is_some());

        slot.reset_and_clear_cache().await.unwrap();

        assert!(precache.await.unwrap().is_err(), "账号清理应取消活动预取");
        let remaining = std::fs::read_dir(audio_cache_dir(&cache_root))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.ends_with(".audio") || name.ends_with(".audio.part")
            })
            .count();
        assert_eq!(remaining, 0, "账号清理后不得残留完整或部分音频缓存");
        assert!(!engine.loaded.load(Ordering::SeqCst));
        assert!(engine.queue.lock().unwrap().tracks.is_empty());
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn latest_artwork_generation_wins_within_one_playback_generation() {
        let app = axum::Router::new()
            .route(
                "/old",
                axum::routing::get(|| async {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    vec![1u8; 16]
                }),
            )
            .route("/new", axum::routing::get(|| async { vec![2u8; 24] }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("artwork-generation-cache");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        let generation = engine.begin_playback_transition();
        engine.start_artwork_fetch(&format!("http://127.0.0.1:{}/old", addr.port()), generation);
        tokio::time::sleep(Duration::from_millis(25)).await;
        engine.start_artwork_fetch(&format!("http://127.0.0.1:{}/new", addr.port()), generation);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let artwork = engine
            .artwork_bytes
            .lock()
            .unwrap()
            .clone()
            .expect("新封面应写入");
        assert_eq!(artwork.as_slice(), &[2u8; 24]);
        engine.stop_immediately();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn queued_artwork_ticket_is_primed_with_head() {
        let methods = Arc::new(Mutex::new(Vec::new()));
        let methods_for_server = Arc::clone(&methods);
        let app = axum::Router::new().route(
            "/ticket",
            axum::routing::any(move |method: axum::http::Method| {
                let methods = Arc::clone(&methods_for_server);
                async move {
                    methods.lock().unwrap().push(method);
                    axum::http::StatusCode::OK
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("artwork-prime-cache");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        let generation = engine.begin_playback_transition();
        engine.prime_artwork_ticket(
            &format!("http://127.0.0.1:{}/ticket", addr.port()),
            generation,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while methods.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            methods.lock().unwrap().as_slice(),
            &[axum::http::Method::HEAD]
        );
        engine.stop_immediately();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn play_seek_pause_local_wav() {
        let wav = std::env::temp_dir().join("cadilume-rodio-test.wav");
        write_test_wav(&wav);
        let engine =
            NativeAudioEngine::new(std::env::temp_dir().join("cadilume-rodio-cache")).unwrap();

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
        assert!(
            position >= 1.0,
            "seek 后进度应跳到约 1.5 秒，实际 {position}"
        );

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

        engine.stop_immediately();
        let _ = std::fs::remove_file(&wav);
    }

    #[tokio::test]
    async fn play_local_flac_advances() {
        let flac = PathBuf::from("/tmp/sample.flac");
        if !flac.exists() {
            eprintln!("跳过：/tmp/sample.flac 不存在");
            return;
        }
        let engine =
            NativeAudioEngine::new(std::env::temp_dir().join("cadilume-rodio-cache-flac")).unwrap();
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
        engine.stop_immediately();
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
        let (cached, _) = test_cache_paths(&cache_root, "sample-cache-test");
        assert!(cached.exists(), "缓存文件应落盘");
        engine.stop_immediately();
    }

    #[tokio::test]
    async fn download_retries_after_transient_truncation() {
        use axum::response::IntoResponse;
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
                        let stream = futures_util::stream::iter(vec![
                            Ok::<_, std::io::Error>(axum::body::Bytes::from(partial)),
                            Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "simulated truncated response",
                            )),
                        ]);
                        let mut response = axum::response::Response::new(
                            axum::body::Body::from_stream(stream),
                        );
                        response.headers_mut().insert(
                            axum::http::header::CONTENT_LENGTH,
                            axum::http::HeaderValue::from_str(&data.len().to_string()).unwrap(),
                        );
                        return response;
                    }
                    ([(axum::http::header::CONTENT_TYPE, "audio/wav")], data).into_response()
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
        assert!(attempts.load(AtomicOrdering::SeqCst) >= 2, "应至少请求两次");
        let (cached, _) = test_cache_paths(&cache_root, "retry-test");
        assert_eq!(
            std::fs::metadata(&cached)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            data.len() as u64,
            "重试成功后缓存应完整"
        );
        engine.stop_immediately();
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_dir_all(&cache_root);
    }

    #[tokio::test]
    async fn chunked_download_without_content_length_commits_complete_cache() {
        let wav = unique_temp_path("chunked-download.wav");
        write_test_wav_of_seconds(&wav, 1);
        let data = std::fs::read(&wav).unwrap();
        let data_for_server = data.clone();
        let app = axum::Router::new().route(
            "/chunked.wav",
            axum::routing::get(move || {
                let split = data_for_server.len() / 2;
                let chunks = vec![
                    Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(
                        &data_for_server[..split],
                    )),
                    Ok(axum::body::Bytes::copy_from_slice(&data_for_server[split..])),
                ];
                async move {
                    axum::response::Response::new(axum::body::Body::from_stream(
                        futures_util::stream::iter(chunks),
                    ))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("chunked-download-cache");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        let url = format!("http://127.0.0.1:{}/chunked.wav", addr.port());

        engine
            .precache(&url, Some("chunked-media".into()), None)
            .await
            .expect("无 Content-Length 的完整响应应可缓存");

        let (cached, partial) = test_cache_paths(&cache_root, "chunked-media");
        assert_eq!(std::fs::read(cached).unwrap(), data);
        assert!(!partial.exists());
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn empty_download_is_rejected_without_cache_residue() {
        let requests = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new().route(
            "/empty",
            axum::routing::get({
                let requests = Arc::clone(&requests);
                move || {
                    requests.fetch_add(1, AtomicOrdering::SeqCst);
                    async { axum::response::Response::new(axum::body::Body::empty()) }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let cache_root = unique_temp_path("empty-download-cache");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        let url = format!("http://127.0.0.1:{}/empty", addr.port());

        let outcome = engine
            .precache(&url, Some("empty-media".into()), None)
            .await;

        assert!(outcome.is_err());
        assert_eq!(requests.load(AtomicOrdering::SeqCst), 3, "空响应应按策略重试");
        let (cached, partial) = test_cache_paths(&cache_root, "empty-media");
        assert!(!cached.exists());
        assert!(!partial.exists());
        let _ = std::fs::remove_dir_all(cache_root);
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
        assert!(elapsed >= 1.2, "限速预取应至少耗时 1.2 秒，实际 {elapsed}");
        let (cached, _) = test_cache_paths(&cache_root, "rate-limit-test");
        assert_eq!(
            std::fs::metadata(&cached)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
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
        let (healed, _) = test_cache_paths(&cache_root, "heal-test");
        std::fs::write(
            &healed,
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
        assert_eq!(
            std::fs::metadata(&healed)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            data.len() as u64,
            "损坏缓存应被完整新文件替换"
        );
        engine.stop_immediately();
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
            history: vec![],
        };
        assert_eq!(queue.peek_next_index(true), Some(1));
        assert_eq!(queue.next_index(true), Some(1));
        queue.current_index = 2;
        assert_eq!(queue.peek_next_index(true), Some(0), "repeat-all 应回绕");
        queue.repeat = NativeRepeatMode::One;
        queue.current_index = 1;
        assert_eq!(
            queue.peek_next_index(true),
            Some(1),
            "repeat-one 自然结束应重播当前曲目"
        );
        assert_eq!(
            queue.peek_next_index(false),
            Some(2),
            "手动 next 不受 repeat-one 约束"
        );
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
            history: vec![],
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

    #[test]
    fn shuffle_previous_survives_queue_resync() {
        let mut queue = QueueState {
            tracks: vec![
                queue_track("a"),
                queue_track("b"),
                queue_track("c"),
                queue_track("d"),
            ],
            current_index: 0,
            repeat: NativeRepeatMode::All,
            shuffle: true,
            bag: vec![],
            history: vec![],
        };
        let next = queue.next_index(false).expect("随机下一首应存在");
        queue.current_index = next as i64;
        assert_eq!(
            queue.previous_index(),
            Some(0),
            "切到下一首后应能回到上一首"
        );
        // 前端每次加载都会 nativeQueueSet 同一队列：bag 不能被清掉。
        let tracks = queue.tracks.clone();
        queue.resync(tracks, queue.current_index, NativeRepeatMode::All, true);
        assert_eq!(queue.previous_index(), Some(0), "队列重同步后上一首仍可用");
        // 队列内容真正变化时才清空历史。
        let mut changed = queue.tracks.clone();
        changed[3].rating_key = "z".to_string();
        queue.resync(changed, queue.current_index, NativeRepeatMode::All, true);
        assert!(
            queue.bag.is_empty() && queue.history.is_empty(),
            "队列变化后应清空 shuffle 历史"
        );
        assert_eq!(queue.previous_index(), None, "历史清空后没有上一首");
    }

    #[test]
    fn sequential_previous_wraps_with_repeat() {
        let mut queue = QueueState {
            tracks: vec![queue_track("a"), queue_track("b"), queue_track("c")],
            current_index: 0,
            repeat: NativeRepeatMode::All,
            shuffle: false,
            bag: vec![],
            history: vec![],
        };
        assert_eq!(
            queue.previous_index(),
            Some(2),
            "repeat-all 首曲上一首应回绕"
        );
        queue.current_index = 1;
        assert_eq!(queue.previous_index(), Some(0));
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
        let missing = engine.queue_next_source(1, "missing", Some("missing-b".into()), None);
        assert!(missing.is_err(), "缓存未就绪时不应预排");
        // 队列已前进（与前端预取目标不一致）时拒绝。
        engine.queue.lock().unwrap().current_index = 1;
        let downloads = cache_root.join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let (stale_cache, _) = test_cache_paths(&cache_root, "stale-b");
        std::fs::copy(&wav, stale_cache).unwrap();
        let stale = engine.queue_next_source(1, "stale", Some("stale-b".into()), None);
        assert!(stale.is_err(), "预排顺序与队列不一致时应拒绝");
        engine.stop_immediately();
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
        let (gapless_cache, _) = test_cache_paths(&cache_root, "gapless-b");
        std::fs::copy(&wav_b, gapless_cache).unwrap();
        engine
            .queue_next_source(
                1,
                wav_b.to_str().unwrap(),
                Some("gapless-b".into()),
                Some(NowPlayingMetadata {
                    title: Some("gapless b".into()),
                    artist: Some("artist b".into()),
                    album: Some("album b".into()),
                    artwork_url: None,
                }),
            )
            .unwrap();
        assert_eq!(engine.player().len(), 2, "预排后播放器队列应有两首");
        *engine.artwork_bytes.lock().unwrap() = Some(Arc::new(vec![9u8; 8]));

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
        assert_eq!(metadata.title.as_deref(), Some("gapless b"));
        assert!(
            engine.artwork_bytes.lock().unwrap().is_none(),
            "B 没有封面时必须清掉 A 的旧封面"
        );
        let source = engine
            .current_source
            .lock()
            .unwrap()
            .clone()
            .expect("交接后应记录 B 的来源");
        assert_eq!(source.source, wav_b.to_string_lossy());
        assert_eq!(source.cache_key.as_deref(), Some("gapless-b"));
        assert_eq!(source.metadata.title.as_deref(), Some("gapless b"));

        engine.stop_immediately();
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
        let (gapless_mp3_cache, _) = test_cache_paths(&cache_root, "gapless-b.mp3");
        std::fs::copy(&mp3_b, gapless_mp3_cache).unwrap();
        engine
            .queue_next_source(
                1,
                mp3_b.to_str().unwrap(),
                Some("gapless-b.mp3".into()),
                None,
            )
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
        let queued = engine
            .consume_started_handoff()
            .expect("应能消费 MP3 预排交接");
        assert_eq!(queued.index, 1);
        assert_eq!(engine.queue.lock().unwrap().current_index, 1);
        assert!(!engine.player().empty(), "MP3 B 应继续播放");
        engine.stop_immediately();
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
        let rebuilt = NativeAudioEngine::new_with_device(cache_root.clone(), &device_name).unwrap();
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
        rebuilt.stop_immediately();
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
        let resources: serde_json::Value =
            plex_headers(client.get("https://plex.tv/api/v2/resources"), &token)
                .query(&[
                    ("includeHttps", "1"),
                    ("includeRelay", "1"),
                    ("includeIPv6", "1"),
                ])
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
                let identity = plex_headers(client.get(format!("{uri}/identity")), access_token)
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
                    resource["clientIdentifier"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
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
        let mut candidates: Vec<(u64, u64, String, String, String)> = tracks["MediaContainer"]
            ["Metadata"]
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
                (short_enough && (500_000..=30_000_000).contains(&size)).then_some((
                    duration_ms,
                    size,
                    rating_key,
                    title,
                    part_key,
                ))
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
        let cache_root =
            std::env::temp_dir().join(format!("cadilume-pms-regression-{}", uuid::Uuid::new_v4()));
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
                    artwork_url: None,
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
            .queue_next_source(
                1,
                &stream_url(&track_b.4),
                Some(track_b.2.clone()),
                Some(NowPlayingMetadata {
                    title: Some(track_b.3.clone()),
                    artist: None,
                    album: None,
                    artwork_url: None,
                }),
            )
            .expect("真实 PMS 曲目 B 应能预排");

        // A 完整落盘后 seek 到结尾附近，让真实曲目在几秒内自然结束。
        let a_final = downloads_dir.join(format!("{}.audio", track_a.2));
        let download_deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !a_final.exists() && std::time::Instant::now() < download_deadline {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(a_final.exists(), "真实 PMS 曲目 A 应完整落盘");
        let a_duration = engine.duration_seconds.lock().unwrap().unwrap_or(0.0);
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

        engine.stop_immediately();
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
        let cache_root =
            std::env::temp_dir().join(format!("cadilume-pms-rapid-{}", uuid::Uuid::new_v4()));
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
                            artwork_url: None,
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
                eprintln!("[回归] 高频切歌 #{loads} 曲目={title} 缓存命中");
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
        engine.stop_immediately();
        let _ = std::fs::remove_dir_all(&cache_root);
    }
}

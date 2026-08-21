//! Spike: rodio-backed native audio engine behind a thin boundary.
//!
//! kithara's firewheel/cpal pipeline stalled after ~1s in the Tauri process
//! (decoder produced fixed 4096-frame chunks then stopped), so this spike
//! uses the simpler, battle-tested rodio path: cpal output + symphonia
//! decoding, with Plex streams backed by a bounded sparse segment cache.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{
    sync_channel, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError,
};
use std::sync::OnceLock;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client};
use rodio::source::SeekError;
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_cache::{
    CachePriority, SegmentCache, SegmentControl, SegmentReader, AUDIO_CACHE_LIMIT_BYTES,
};
use crate::audio_resampler::preprocess_source_for_output;

/// Decoder workers feed fixed, frame-aligned chunks to the real-time output.
const DECODE_CHUNK_FRAMES: usize = 1024;
/// Keep several seconds of decoded PCM ahead without allowing unbounded memory.
const DECODE_BUFFER_SECONDS: usize = 4;
/// After an underflow, wait for a useful amount of PCM before resuming. A
/// single 1024-frame chunk is only ~21ms at 48kHz and would otherwise cause
/// rapid pause/resume oscillation on an unstable connection.
const DECODE_RESUME_BUFFER_MS: usize = 250;
const DECODE_INITIAL_CHUNK_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(target_os = "macos")]
const MACOS_OUTPUT_OPEN_TIMEOUT: Duration = Duration::from_millis(750);
#[cfg(target_os = "macos")]
const MACOS_FALLBACK_OPEN_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Segment-backed containers may need more ranges while probing metadata.
/// Bound the probe + first-PCM preparation so the frontend can try a compatible
/// PMS quality when the original source cannot be prepared promptly.
const SEGMENT_DECODE_PREPARE_TIMEOUT: Duration = Duration::from_secs(6);
const SEGMENT_PREPARE_CANCEL_TIMEOUT: Duration = Duration::from_secs(3);
const PLAYBACK_TASK_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const PLAYBACK_TASK_SHUTDOWN_POLL: Duration = Duration::from_millis(10);
const DECODE_INITIAL_WAIT_POLL: Duration = Duration::from_millis(50);
const DECODE_SEND_WAIT_TIMEOUT: Duration = Duration::from_millis(100);
static NEXT_DECODE_WORKER_ID: AtomicUsize = AtomicUsize::new(1);
/// 前端心跳超时：超过该时长没有收到 heartbeat 且引擎正在出声，就自动停止
/// 播放，防止 WebView/主线程卡死或崩溃后音乐停不下来。
const HEARTBEAT_STALL_TIMEOUT: Duration = Duration::from_secs(6);
/// A stale heartbeat must remain unchanged for a second full interval before
/// playback is stopped. This lets the WebView recover after system sleep or a
/// transient main-thread stall without sacrificing the visible-window guard.
const HEARTBEAT_STALL_CONFIRMATION: Duration = Duration::from_secs(6);
/// System-default output changes are not surfaced portably by cpal, so an
/// auto-routed engine verifies its observed default at a low fixed cadence.
/// Explicit application device choices intentionally bypass this watcher.
const DEFAULT_OUTPUT_FOLLOW_INTERVAL: Duration = Duration::from_secs(1);
/// A native output stream can silently stop delivering callbacks after a long
/// sleep or device-driver transition without invoking cpal's error callback.
/// Rebuild only after a sustained lack of consumed PCM so normal buffering is
/// never mistaken for a dead route.
const OUTPUT_PROGRESS_STALL_TIMEOUT: Duration = Duration::from_secs(8);
/// A long forwarder scheduling gap usually means system sleep/resume. Start a
/// fresh observation then, giving CoreAudio a full recovery window first.
const OUTPUT_PROGRESS_WATCHDOG_RESET_GAP: Duration = Duration::from_secs(2);
static SHUFFLE_NONCE: AtomicU64 = AtomicU64::new(0x6a09_e667_f3bc_c909);

fn loopback_http_client(timeout: Option<Duration>) -> Result<Client, String> {
    let mut builder = Client::builder().redirect(Policy::none());
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| format!("创建本机媒体客户端失败: {error}"))
}

fn http_error_category(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_request() {
        "request"
    } else {
        "unknown"
    }
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

struct DecodedChunk {
    epoch: u64,
    samples: Vec<f32>,
}

enum DecodedChunkSend {
    Sent,
    Superseded(Vec<f32>),
    Disconnected,
}

#[derive(Default)]
struct NativeAudioHealth {
    underflow_events: AtomicU64,
    underflow_frames: AtomicU64,
    output_stream_errors: AtomicU64,
    output_recoveries: AtomicU64,
    output_recovery_failures: AtomicU64,
}

impl NativeAudioHealth {
    fn record_output_stream_error(&self, recovery_pending: &AtomicBool) {
        self.output_stream_errors.fetch_add(1, Ordering::SeqCst);
        recovery_pending.store(true, Ordering::SeqCst);
    }
}

struct DecodeBufferState {
    cancelled: AtomicBool,
    finished: AtomicBool,
    underflowing: AtomicBool,
    buffered_chunks: AtomicUsize,
    buffer_capacity: usize,
    resume_chunks: usize,
    underflow_frames: AtomicU64,
    played_media_frames: AtomicU64,
    /// Monotonic count of frames consumed by the output callback. Unlike
    /// `played_media_frames`, seeking must not reset this because it is used
    /// to prove that a new playback start reached CoreAudio.
    output_media_frames: AtomicU64,
    position_base_micros: AtomicU64,
    sample_rate_hz: u32,
    seek_epoch: AtomicU64,
    seek_target: Mutex<Option<(u64, Duration)>>,
    worker_signal_epoch: AtomicU64,
    worker_signal_lock: Mutex<()>,
    worker_signal: Condvar,
    reader_control: Option<Arc<SegmentControl>>,
    worker_exited: AtomicBool,
    allocated_chunks: AtomicUsize,
    health: Arc<NativeAudioHealth>,
}

impl DecodeBufferState {
    fn new(
        sample_rate: rodio::SampleRate,
        buffer_capacity: usize,
        reader_control: Option<Arc<SegmentControl>>,
        health: Arc<NativeAudioHealth>,
    ) -> Self {
        let resume_frames = (sample_rate.get() as usize)
            .saturating_mul(DECODE_RESUME_BUFFER_MS)
            .div_ceil(1_000);
        let resume_chunks = resume_frames
            .div_ceil(DECODE_CHUNK_FRAMES)
            .clamp(1, buffer_capacity);
        Self {
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            underflowing: AtomicBool::new(false),
            buffered_chunks: AtomicUsize::new(0),
            buffer_capacity,
            resume_chunks,
            underflow_frames: AtomicU64::new(0),
            played_media_frames: AtomicU64::new(0),
            output_media_frames: AtomicU64::new(0),
            position_base_micros: AtomicU64::new(0),
            sample_rate_hz: sample_rate.get(),
            seek_epoch: AtomicU64::new(0),
            seek_target: Mutex::new(None),
            worker_signal_epoch: AtomicU64::new(0),
            worker_signal_lock: Mutex::new(()),
            worker_signal: Condvar::new(),
            reader_control,
            worker_exited: AtomicBool::new(false),
            allocated_chunks: AtomicUsize::new(0),
            health,
        }
    }

    fn promote_reader_to_current(&self) {
        if let Some(control) = self.reader_control.as_ref() {
            control.promote_to_current();
        }
    }

    fn release_buffered_chunk(&self) {
        self.unreserve_buffered_chunk();
        self.notify_worker();
    }

    fn unreserve_buffered_chunk(&self) {
        let _ = self
            .buffered_chunks
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                Some(count.saturating_sub(1))
            });
    }

    fn ready_to_resume(&self) -> bool {
        let buffered = self.buffered_chunks.load(Ordering::SeqCst);
        debug_assert!(buffered <= self.buffer_capacity);
        buffered >= self.resume_chunks || self.finished.load(Ordering::SeqCst)
    }

    fn ready_for_initial_playback(&self) -> bool {
        let buffered = self.buffered_chunks.load(Ordering::SeqCst);
        debug_assert!(buffered <= self.buffer_capacity);
        buffered >= self.buffer_capacity || self.finished.load(Ordering::SeqCst)
    }

    fn reader_failure(&self) -> Option<String> {
        self.reader_control
            .as_ref()
            .and_then(|control| control.failure())
    }

    fn notify_worker(&self) {
        self.worker_signal_epoch.fetch_add(1, Ordering::SeqCst);
        self.worker_signal.notify_all();
    }

    fn cancel_worker(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify_worker();
        if let Some(control) = self.reader_control.as_ref() {
            control.cancel();
        }
    }

    fn wait_for_worker_signal(&self, observed_epoch: u64, timeout: Option<Duration>) {
        let guard = self
            .worker_signal_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.worker_signal_epoch.load(Ordering::SeqCst) != observed_epoch {
            return;
        }
        if let Some(timeout) = timeout {
            let _ = self.worker_signal.wait_timeout(guard, timeout);
        } else {
            let _guard = self
                .worker_signal
                .wait(guard)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    fn add_played_media_samples(&self, samples: usize, channels: usize) {
        let frames = samples / channels.max(1);
        self.played_media_frames
            .fetch_add(frames as u64, Ordering::Relaxed);
        self.output_media_frames
            .fetch_add(frames as u64, Ordering::SeqCst);
    }

    fn set_position_base(&self, position: Duration) {
        let micros = position.as_micros().min(u64::MAX as u128) as u64;
        self.position_base_micros.store(micros, Ordering::SeqCst);
        self.played_media_frames.store(0, Ordering::SeqCst);
    }

    fn position_seconds(&self) -> f64 {
        self.position_base_micros.load(Ordering::SeqCst) as f64 / 1_000_000.0
            + self.played_media_frames.load(Ordering::Relaxed) as f64
                / self.sample_rate_hz.max(1) as f64
    }
}

struct DecodeWorkerExitGuard(Arc<DecodeBufferState>);

impl Drop for DecodeWorkerExitGuard {
    fn drop(&mut self) {
        self.0.worker_exited.store(true, Ordering::SeqCst);
    }
}

struct PlaybackTransition {
    generation: u64,
    decode_states: Vec<Arc<DecodeBufferState>>,
}

/// A non-blocking rodio Source backed by a dedicated decoder worker. The
/// CoreAudio/WASAPI callback only performs `try_recv`; file I/O, codec work and
/// segment-network waits remain on the worker thread.
struct ThreadedDecoderSource {
    receiver: Receiver<DecodedChunk>,
    recycle_sender: SyncSender<Vec<f32>>,
    state: Arc<DecodeBufferState>,
    channels: rodio::ChannelCount,
    sample_rate: rodio::SampleRate,
    total_duration: Option<Duration>,
    current: Option<DecodedChunk>,
    current_index: usize,
    silence_remaining: usize,
}

impl ThreadedDecoderSource {
    fn release_chunk(&self, chunk: DecodedChunk) {
        // Keep allocation/deallocation away from the realtime callback during
        // steady-state playback. The decoder worker reuses these bounded Vecs.
        let _ = self.recycle_sender.try_send(chunk.samples);
        self.state.release_buffered_chunk();
    }

    fn next_ready_chunk(&mut self) -> Option<DecodedChunk> {
        loop {
            match self.receiver.try_recv() {
                Ok(chunk) if chunk.epoch == self.state.seek_epoch.load(Ordering::SeqCst) => {
                    self.state.underflowing.store(false, Ordering::SeqCst);
                    return Some(chunk);
                }
                Ok(stale) => {
                    // Stale PCM belongs to a superseded seek epoch.
                    self.release_chunk(stale);
                    continue;
                }
                Err(TryRecvError::Empty) => return None,
                Err(TryRecvError::Disconnected) => {
                    self.state.finished.store(true, Ordering::SeqCst);
                    return None;
                }
            }
        }
    }
}

impl Drop for ThreadedDecoderSource {
    fn drop(&mut self) {
        if let Some(chunk) = self.current.take() {
            self.release_chunk(chunk);
        }
        while let Ok(chunk) = self.receiver.try_recv() {
            self.release_chunk(chunk);
        }
        self.state.cancel_worker();
    }
}

impl Iterator for ThreadedDecoderSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(chunk) = self.current.as_ref() {
            if self.current_index < chunk.samples.len() {
                let sample = chunk.samples[self.current_index];
                self.current_index += 1;
                if self.current_index == chunk.samples.len() {
                    self.state.add_played_media_samples(
                        chunk.samples.len(),
                        self.channels.get() as usize,
                    );
                    let completed = self.current.take().expect("current chunk must exist");
                    self.release_chunk(completed);
                    self.current_index = 0;
                }
                return Some(sample);
            }
        }
        if self.silence_remaining > 0 {
            self.silence_remaining -= 1;
            return Some(0.0);
        }
        if let Some(chunk) = self.next_ready_chunk() {
            self.current = Some(chunk);
            return self.next();
        }
        if self.state.finished.load(Ordering::SeqCst) || self.state.cancelled.load(Ordering::SeqCst)
        {
            return None;
        }
        // Emit at most one frame of silence before the event forwarder pauses
        // the Player. Completing the whole frame preserves channel alignment.
        if !self.state.underflowing.swap(true, Ordering::SeqCst) {
            self.state
                .health
                .underflow_events
                .fetch_add(1, Ordering::SeqCst);
        }
        self.state.underflow_frames.fetch_add(1, Ordering::SeqCst);
        self.state
            .health
            .underflow_frames
            .fetch_add(1, Ordering::SeqCst);
        self.silence_remaining = self.channels.get() as usize - 1;
        Some(0.0)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (0, None)
    }
}

impl Source for ThreadedDecoderSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> rodio::ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // Keep the target lock across epoch publication and stale-buffer
        // recycling. Otherwise the worker can observe the new epoch before
        // its seek target exists and decode old-position PCM as the new epoch.
        let mut seek_target = self
            .state
            .seek_target
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let epoch = self.state.seek_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(chunk) = self.current.take() {
            self.release_chunk(chunk);
        }
        self.current_index = 0;
        self.silence_remaining = 0;
        while let Ok(chunk) = self.receiver.try_recv() {
            self.release_chunk(chunk);
        }
        self.state.finished.store(false, Ordering::SeqCst);
        self.state.underflowing.store(false, Ordering::SeqCst);
        self.state.set_position_base(pos);
        *seek_target = Some((epoch, pos));
        drop(seek_target);
        self.state.notify_worker();
        if let Some(control) = self.state.reader_control.as_ref() {
            control.interrupt_reader();
        }
        Ok(())
    }
}

fn send_decoded_chunk(
    sender: &SyncSender<DecodedChunk>,
    state: &DecodeBufferState,
    mut chunk: DecodedChunk,
) -> DecodedChunkSend {
    loop {
        if state.cancelled.load(Ordering::SeqCst)
            || state.seek_epoch.load(Ordering::SeqCst) != chunk.epoch
        {
            return DecodedChunkSend::Superseded(chunk.samples);
        }
        let observed_epoch = state.worker_signal_epoch.load(Ordering::SeqCst);
        if state
            .buffered_chunks
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < state.buffer_capacity).then_some(count + 1)
            })
            .is_err()
        {
            state.wait_for_worker_signal(observed_epoch, Some(DECODE_SEND_WAIT_TIMEOUT));
            continue;
        }
        match sender.try_send(chunk) {
            Ok(()) => return DecodedChunkSend::Sent,
            Err(TrySendError::Full(returned)) => {
                state.unreserve_buffered_chunk();
                chunk = returned;
                state.wait_for_worker_signal(observed_epoch, Some(DECODE_SEND_WAIT_TIMEOUT));
            }
            Err(TrySendError::Disconnected(_)) => {
                state.unreserve_buffered_chunk();
                return DecodedChunkSend::Disconnected;
            }
        }
    }
}

#[cfg(test)]
fn spawn_threaded_decoder<S>(
    source: S,
) -> Result<(ThreadedDecoderSource, Arc<DecodeBufferState>), String>
where
    S: Source + Send + 'static,
{
    spawn_threaded_decoder_with_health(source, None, Arc::new(NativeAudioHealth::default()))
}

#[cfg(test)]
fn spawn_threaded_decoder_with_health<S>(
    source: S,
    reader_control: Option<Arc<SegmentControl>>,
    health: Arc<NativeAudioHealth>,
) -> Result<(ThreadedDecoderSource, Arc<DecodeBufferState>), String>
where
    S: Source + Send + 'static,
{
    spawn_threaded_decoder_source_with_health(source, reader_control, health)
}

fn spawn_threaded_decoder_for_output<S>(
    source: S,
    target_channels: rodio::ChannelCount,
    target_sample_rate: rodio::SampleRate,
    reader_control: Option<Arc<SegmentControl>>,
    health: Arc<NativeAudioHealth>,
) -> Result<(ThreadedDecoderSource, Arc<DecodeBufferState>), String>
where
    S: Source<Item = f32> + Send + 'static,
{
    let source = preprocess_source_for_output(source, target_channels, target_sample_rate)?;
    spawn_threaded_decoder_source_with_health(source, reader_control, health)
}

fn spawn_threaded_decoder_source_with_health<S>(
    mut source: S,
    reader_control: Option<Arc<SegmentControl>>,
    health: Arc<NativeAudioHealth>,
) -> Result<(ThreadedDecoderSource, Arc<DecodeBufferState>), String>
where
    S: Source + Send + 'static,
{
    let channels = source.channels();
    let sample_rate = source.sample_rate();
    let total_duration = source.total_duration();
    let chunks_per_second = (sample_rate.get() as usize).div_ceil(DECODE_CHUNK_FRAMES);
    let chunk_capacity = (chunks_per_second * DECODE_BUFFER_SECONDS).clamp(8, 512);
    // The realtime Source keeps one current chunk outside the channel. Reserve
    // that slot so channel + current never exceeds the advertised hard cap.
    let channel_capacity = chunk_capacity.saturating_sub(1).max(1);
    let chunk_samples = DECODE_CHUNK_FRAMES * channels.get() as usize;
    let (sender, receiver) = sync_channel::<DecodedChunk>(channel_capacity);
    // Keep a separate recycle pool large enough to absorb the current/channel
    // buffers and one in-flight chunk while the realtime side drains them
    // during a seek. The active PCM queue remains bounded by `chunk_capacity`.
    let (recycle_sender, recycle_receiver) =
        sync_channel::<Vec<f32>>(chunk_capacity.saturating_mul(2).saturating_add(2));
    let state = Arc::new(DecodeBufferState::new(
        sample_rate,
        chunk_capacity,
        reader_control,
        health,
    ));
    let worker_state = Arc::clone(&state);
    let worker_id = NEXT_DECODE_WORKER_ID.fetch_add(1, Ordering::Relaxed);
    std::thread::Builder::new()
        .name(format!("cadilume-decode-{worker_id}"))
        .spawn(move || {
            let _exit = DecodeWorkerExitGuard(Arc::clone(&worker_state));
            let mut spare_samples: Option<Vec<f32>> = None;
            loop {
                if worker_state.cancelled.load(Ordering::SeqCst) {
                    return;
                }
                let seek = worker_state
                    .seek_target
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                if let Some((epoch, position)) = seek {
                    if worker_state.seek_epoch.load(Ordering::SeqCst) != epoch {
                        continue;
                    }
                    if let Err(error) = source.try_seek(position) {
                        eprintln!("[原生] 解码线程定位失败：{error}");
                    }
                    worker_state.finished.store(false, Ordering::SeqCst);
                }

                let epoch = worker_state.seek_epoch.load(Ordering::SeqCst);
                // Drain returned buffers first so the realtime side keeps a
                // free recycle slot during rapid seeks. The worker-local spare
                // remains the fallback for a superseded in-flight chunk.
                let mut samples = match recycle_receiver
                    .try_recv()
                    .ok()
                    .or_else(|| spare_samples.take())
                {
                    Some(mut samples) => {
                        samples.clear();
                        samples
                    }
                    None => {
                        worker_state
                            .allocated_chunks
                            .fetch_add(1, Ordering::Relaxed);
                        Vec::with_capacity(chunk_samples)
                    }
                };
                let mut exhausted = false;
                while samples.len() < chunk_samples {
                    if worker_state.cancelled.load(Ordering::SeqCst)
                        || worker_state.seek_epoch.load(Ordering::SeqCst) != epoch
                    {
                        break;
                    }
                    match source.next() {
                        Some(sample) => samples.push(sample),
                        None => {
                            exhausted = true;
                            break;
                        }
                    }
                }
                if worker_state.seek_epoch.load(Ordering::SeqCst) != epoch {
                    samples.clear();
                    spare_samples = Some(samples);
                    continue;
                }
                if samples.is_empty() {
                    spare_samples = Some(samples);
                } else {
                    let channel_count = channels.get() as usize;
                    let remainder = samples.len() % channel_count;
                    if remainder != 0 {
                        samples.resize(samples.len() + channel_count - remainder, 0.0);
                    }
                    match send_decoded_chunk(
                        &sender,
                        &worker_state,
                        DecodedChunk { epoch, samples },
                    ) {
                        DecodedChunkSend::Sent => {}
                        DecodedChunkSend::Superseded(mut samples) => {
                            samples.clear();
                            spare_samples = Some(samples);
                            continue;
                        }
                        DecodedChunkSend::Disconnected => return,
                    }
                }
                if exhausted {
                    worker_state.finished.store(true, Ordering::SeqCst);
                    // Keep the decoder object alive while buffered PCM is still
                    // owned by the Player. A later backward seek must be able to
                    // reposition an already-decoded short track instead of
                    // finding that its worker exited at EOF.
                    loop {
                        let observed_epoch =
                            worker_state.worker_signal_epoch.load(Ordering::SeqCst);
                        if worker_state.cancelled.load(Ordering::SeqCst)
                            || worker_state
                                .seek_target
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .is_some()
                        {
                            break;
                        }
                        worker_state.wait_for_worker_signal(observed_epoch, None);
                    }
                }
            }
        })
        .map_err(|error| format!("启动解码线程失败: {error}"))?;

    let initial_deadline = std::time::Instant::now() + DECODE_INITIAL_CHUNK_TIMEOUT;
    let initial = loop {
        if let Some(failure) = state.reader_failure() {
            state.cancel_worker();
            return Err(format!("分段媒体读取失败: {failure}"));
        }
        let now = std::time::Instant::now();
        let remaining = initial_deadline.saturating_duration_since(now);
        if remaining.is_zero() {
            state.cancel_worker();
            return Err("解码线程未能及时产生首个 PCM 缓冲".to_string());
        }
        match receiver.recv_timeout(remaining.min(DECODE_INITIAL_WAIT_POLL)) {
            Ok(chunk) => break chunk,
            Err(RecvTimeoutError::Timeout) => {
                let reader_cancelled = state
                    .reader_control
                    .as_ref()
                    .is_some_and(|control| control.is_cancelled());
                if state.cancelled.load(Ordering::SeqCst) || reader_cancelled {
                    state.cancel_worker();
                    return Err("解码准备已取消".to_string());
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                state.cancel_worker();
                if let Some(failure) = state.reader_failure() {
                    return Err(format!("分段媒体读取失败: {failure}"));
                }
                return Err("解码线程在首个 PCM 缓冲前退出".to_string());
            }
        }
    };
    crate::diagnostics::record(
        "音频",
        format_args!(
            "decoder_first_pcm=true sample_rate={} channels={} samples={}",
            sample_rate,
            channels,
            initial.samples.len()
        ),
    );
    Ok((
        ThreadedDecoderSource {
            receiver,
            recycle_sender,
            state: Arc::clone(&state),
            channels,
            sample_rate,
            total_duration,
            current: Some(initial),
            current_index: 0,
            silence_remaining: 0,
        },
        state,
    ))
}

struct PreparedSegmentDecoder {
    decoder: ThreadedDecoderSource,
    decode_state: Arc<DecodeBufferState>,
    total_seconds: Option<f64>,
}

fn prepare_segment_decoder(
    mut reader: SegmentReader,
    metadata_duration_ms: Option<u64>,
    target_channels: rodio::ChannelCount,
    target_sample_rate: rodio::SampleRate,
    health: Arc<NativeAudioHealth>,
) -> Result<PreparedSegmentDecoder, String> {
    let control = reader.control();
    let logical_len = reader
        .prefetch_head()
        .map_err(|error| format!("准备分段缓存失败: {error}"))?;
    let mut builder = Decoder::builder().with_data(reader).with_seekable(true);
    if let Some(logical_len) = logical_len.filter(|length| *length > 0) {
        builder = builder.with_byte_len(logical_len);
    }
    let decoder = builder
        .build()
        .map_err(|error| format!("媒体解码失败: {error}"))?;
    let total_seconds = decoder
        .total_duration()
        .map(|duration| duration.as_secs_f64())
        .or_else(|| metadata_duration_ms.map(|milliseconds| milliseconds as f64 / 1_000.0));
    let (decoder, decode_state) = spawn_threaded_decoder_for_output(
        decoder,
        target_channels,
        target_sample_rate,
        Some(control),
        health,
    )?;
    Ok(PreparedSegmentDecoder {
        decoder,
        decode_state,
        total_seconds,
    })
}

enum AudioMixerSink {
    Device(MixerDeviceSink),
    #[cfg(test)]
    Test(TestMixerSink),
}

impl AudioMixerSink {
    fn mixer(&self) -> &rodio::mixer::Mixer {
        match self {
            Self::Device(sink) => sink.mixer(),
            #[cfg(test)]
            Self::Test(sink) => &sink.mixer,
        }
    }

    fn output_format(&self) -> (rodio::ChannelCount, rodio::SampleRate) {
        match self {
            Self::Device(sink) => (sink.config().channel_count(), sink.config().sample_rate()),
            #[cfg(test)]
            Self::Test(sink) => (sink.channels, sink.sample_rate),
        }
    }
}

/// Unit tests exercise playback timing without opening CoreAudio/WASAPI.
/// Hosted Windows runners expose a virtual audio endpoint whose native stream
/// can terminate the whole test process, while a clocked mixer preserves the
/// same Player/decoder/gapless behavior deterministically.
#[cfg(test)]
struct TestMixerSink {
    mixer: rodio::mixer::Mixer,
    channels: rodio::ChannelCount,
    sample_rate: rodio::SampleRate,
    shutdown: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}

#[cfg(test)]
impl TestMixerSink {
    fn new() -> anyhow::Result<Self> {
        const CHANNELS: u16 = 2;
        const SAMPLE_RATE: u32 = 48_000;
        const TICK: Duration = Duration::from_millis(10);

        let channels = std::num::NonZeroU16::new(CHANNELS).expect("test channels are non-zero");
        let sample_rate =
            std::num::NonZeroU32::new(SAMPLE_RATE).expect("test sample rate is non-zero");
        let (mixer, mut source) = rodio::mixer::mixer(channels, sample_rate);
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_worker = Arc::clone(&shutdown);
        let worker = std::thread::Builder::new()
            .name("cadilume-test-mixer".to_string())
            .spawn(move || {
                let clock_started = std::time::Instant::now();
                let samples_per_second = CHANNELS as u128 * SAMPLE_RATE as u128;
                let mut emitted_samples = 0u128;
                while !shutdown_for_worker.load(Ordering::SeqCst) {
                    // Derive the target from an absolute clock. Parallel test
                    // load can delay a worker well beyond one tick; catching
                    // up here preserves media time instead of accumulating
                    // scheduler drift and making gapless assertions flaky.
                    let elapsed = clock_started.elapsed();
                    let target_samples = elapsed.as_nanos() * samples_per_second / 1_000_000_000;
                    let due_samples = target_samples.saturating_sub(emitted_samples);
                    for _ in 0..usize::try_from(due_samples).unwrap_or(usize::MAX) {
                        let _ = source.next();
                    }
                    emitted_samples = target_samples;
                    if shutdown_for_worker.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::park_timeout(TICK);
                }
            })?;
        Ok(Self {
            mixer,
            channels,
            sample_rate,
            shutdown,
            worker: Some(worker),
        })
    }
}

#[cfg(test)]
impl Drop for TestMixerSink {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

/// Native playback engine (rodio + cpal) owned by the Tauri app.
pub struct NativeAudioEngine {
    // Player controls must be dropped before the output stream so the native
    // callback cannot observe a partially torn-down playback source.
    player: Mutex<Arc<Player>>,
    #[allow(dead_code)]
    sink: AudioMixerSink,
    output_channels: rodio::ChannelCount,
    output_sample_rate: rodio::SampleRate,
    segment_cache: SegmentCache,
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
    decode_state: Arc<Mutex<Option<Arc<DecodeBufferState>>>>,
    desired_playing: Arc<AtomicBool>,
    /// Becomes true only after the output callback has consumed actual PCM.
    /// Decoder preparation alone must not make the UI claim playback started.
    playback_started: Arc<AtomicBool>,
    /// Output-frame count that was current when playback was last requested.
    /// The next `playback-started` event needs to observe a greater value.
    playback_start_frame: Arc<AtomicU64>,
    buffer_paused: Arc<AtomicBool>,
    accepting_work: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    last_heartbeat: Arc<Mutex<Option<std::time::Instant>>>,
    heartbeat_stale_observation: Arc<Mutex<Option<(std::time::Instant, std::time::Instant)>>>,
    active_segment_prepare: Arc<Mutex<Option<Arc<SegmentControl>>>>,
    health: Arc<NativeAudioHealth>,
    output_recovery_pending: Arc<AtomicBool>,
    /// The default DeviceId observed when this engine was opened in automatic
    /// routing mode. `None` means this engine is pinned to an explicit device.
    observed_default_device_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct QueueTrack {
    pub rating_key: String,
    pub occurrence_id: String,
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

fn shuffle_indices(indices: &mut [usize]) {
    let nonce = SHUFFLE_NONCE.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    let time_seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let mut state = nonce ^ time_seed ^ (indices.len() as u64).rotate_left(17);
    if state == 0 {
        state = 0xa409_3822_299f_31d0;
    }
    for upper in (1..indices.len()).rev() {
        // xorshift64*: sufficient for queue ordering and avoids adding a
        // runtime dependency solely for non-cryptographic shuffle behavior.
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let random = state.wrapping_mul(0x2545_f491_4f6c_dd1d);
        indices.swap(upper, (random as usize) % (upper + 1));
    }
}

#[derive(Clone, Debug)]
pub struct QueueState {
    tracks: Vec<QueueTrack>,
    current_index: i64,
    repeat: NativeRepeatMode,
    shuffle: bool,
    /// Remaining, randomly ordered tracks in the current shuffle round.
    bag: Vec<usize>,
    shuffle_initialized: bool,
    /// Playback path plus cursor, so Previous -> Next is reversible.
    history: Vec<usize>,
    history_cursor: Option<usize>,
}

impl Default for QueueState {
    fn default() -> Self {
        Self {
            tracks: Vec::new(),
            current_index: -1,
            repeat: NativeRepeatMode::Off,
            shuffle: false,
            bag: Vec::new(),
            shuffle_initialized: false,
            history: Vec::new(),
            history_cursor: None,
        }
    }
}

impl QueueState {
    fn current(&self) -> Option<usize> {
        usize::try_from(self.current_index)
            .ok()
            .filter(|index| *index < self.tracks.len())
    }

    fn sync_shuffle_history(&mut self) {
        let Some(current) = self.current() else {
            return;
        };
        if self
            .history_cursor
            .and_then(|cursor| self.history.get(cursor))
            == Some(&current)
        {
            return;
        }
        if let Some(found) = self.history.iter().rposition(|index| *index == current) {
            self.history_cursor = Some(found);
            return;
        }
        if let Some(cursor) = self.history_cursor {
            self.history.truncate(cursor + 1);
        }
        self.history.push(current);
        self.history_cursor = Some(self.history.len() - 1);
    }

    fn refill_shuffle_bag(&mut self, current: usize) {
        self.bag = (0..self.tracks.len())
            .filter(|index| *index != current)
            .collect();
        shuffle_indices(&mut self.bag);
        self.shuffle_initialized = true;
    }

    fn peek_next_index(&mut self, natural_ended: bool) -> Option<usize> {
        let current = self.current()?;
        if natural_ended && self.repeat == NativeRepeatMode::One {
            return Some(current);
        }
        if !self.shuffle {
            let next = current + 1;
            return if next < self.tracks.len() {
                Some(next)
            } else if !natural_ended || self.repeat == NativeRepeatMode::All {
                Some(0)
            } else {
                None
            };
        }

        self.sync_shuffle_history();
        if let Some(forward) = self
            .history_cursor
            .and_then(|cursor| self.history.get(cursor + 1))
            .copied()
        {
            return Some(forward);
        }
        if self.tracks.len() == 1 {
            return (natural_ended && self.repeat == NativeRepeatMode::All).then_some(current);
        }
        if !self.shuffle_initialized {
            self.refill_shuffle_bag(current);
        } else if self.bag.is_empty() {
            if natural_ended && self.repeat != NativeRepeatMode::All {
                return None;
            }
            self.refill_shuffle_bag(current);
        }
        self.bag.last().copied()
    }

    fn next_index(&mut self, natural_ended: bool) -> Option<usize> {
        let next = self.peek_next_index(natural_ended)?;
        self.commit_index(next);
        Some(next)
    }

    fn previous_index(&mut self) -> Option<usize> {
        let current = self.current()?;
        if self.shuffle {
            self.sync_shuffle_history();
            let cursor = self.history_cursor?;
            if cursor == 0 {
                return None;
            }
            let previous_cursor = cursor - 1;
            let previous = *self.history.get(previous_cursor)?;
            self.history_cursor = Some(previous_cursor);
            self.current_index = previous as i64;
            return Some(previous);
        }
        if current > 0 {
            Some(current - 1)
        } else if self.repeat != NativeRepeatMode::Off {
            Some(self.tracks.len() - 1)
        } else {
            None
        }
    }

    fn remote_navigation_availability(&self) -> (bool, bool) {
        let Some(current) = self.current() else {
            return (false, false);
        };
        if self.tracks.len() <= 1 {
            return (false, false);
        }
        let can_wrap = self.repeat != NativeRepeatMode::Off || self.shuffle;
        (
            can_wrap || current > 0,
            can_wrap || current + 1 < self.tracks.len(),
        )
    }

    /// Commit an already-queued source as the current track. The index was
    /// validated against `peek_next_index` when it was queued, so no further
    /// decision is needed here; keep the shuffle bag in sync with reality.
    fn commit_index(&mut self, index: usize) {
        if index >= self.tracks.len() {
            return;
        }
        let origin = self.current();
        if self.shuffle && origin != Some(index) {
            self.sync_shuffle_history();
            let forward_matches = self
                .history_cursor
                .and_then(|cursor| self.history.get(cursor + 1))
                == Some(&index);
            if forward_matches {
                self.history_cursor = self.history_cursor.map(|cursor| cursor + 1);
            } else {
                if let Some(position) = self.bag.iter().position(|candidate| *candidate == index) {
                    self.bag.remove(position);
                }
                if let Some(cursor) = self.history_cursor {
                    self.history.truncate(cursor + 1);
                } else {
                    self.history.clear();
                }
                self.history.push(index);
                self.history_cursor = Some(self.history.len() - 1);
            }
        }
        self.current_index = index as i64;
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
                .any(|(current, next)| current.occurrence_id != next.occurrence_id);
        let shuffle_changed = self.shuffle != shuffle;
        self.tracks = tracks;
        self.current_index = current_index;
        self.repeat = repeat;
        self.shuffle = shuffle;
        if tracks_changed || shuffle_changed {
            self.bag.clear();
            self.shuffle_initialized = false;
            self.history.clear();
            self.history_cursor = None;
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
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub artwork_url: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
type NowPlayingSignature = (
    NowPlayingMetadata,
    Option<u64>,
    crate::now_playing::PlaybackState,
    Option<(usize, usize)>,
    (bool, bool),
);

/// A decoded and buffered next track already appended to the rodio queue.
#[derive(Clone)]
struct PendingTrack {
    index: usize,
    rating_key: String,
    occurrence_id: String,
    duration_seconds: Option<f64>,
    source: String,
    cache_key: Option<String>,
    metadata: NowPlayingMetadata,
    started: Arc<AtomicBool>,
    decode_state: Arc<DecodeBufferState>,
}

/// Re-index a queued source after a queue edit when it is still the exact
/// native next decision. Returning `true` means rodio already owns a stale
/// appended source and the current player must be rebuilt to remove it.
fn reconcile_pending_track(pending: &mut Option<PendingTrack>, queue: &mut QueueState) -> bool {
    let Some(queued) = pending.as_mut() else {
        return false;
    };
    let new_index = queue
        .tracks
        .iter()
        .position(|track| track.occurrence_id == queued.occurrence_id);
    if let Some(index) = new_index {
        if queue.peek_next_index(true) == Some(index) {
            queued.index = index;
            return false;
        }
    }
    *pending = None;
    true
}

/// Where the current track is being read from, so a device switch can rebuild
/// the player and resume from the same source (cached ranges first, otherwise
/// on-demand segment fetches).
#[derive(Clone, Debug)]
struct CurrentSource {
    source: String,
    cache_key: Option<String>,
    metadata: NowPlayingMetadata,
}

#[derive(Clone, Debug)]
struct PendingSourceSnapshot {
    index: usize,
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
    pending: Option<PendingSourceSnapshot>,
    queue: QueueState,
}

/// Lazy engine slot so the device stream opens on first use.
pub struct NativeAudioEngineSlot {
    cache_root: PathBuf,
    segment_cache: OnceLock<Result<SegmentCache, String>>,
    inner: Mutex<Option<Arc<NativeAudioEngine>>>,
    preferred_device: Mutex<Option<String>>,
    preferred_volume: Mutex<Option<f32>>,
    output_switch_lock: tokio::sync::Mutex<()>,
    maintenance_in_progress: AtomicBool,
    health: Arc<NativeAudioHealth>,
}

struct SlotMaintenanceGuard<'a>(&'a AtomicBool);

impl Drop for SlotMaintenanceGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl NativeAudioEngineSlot {
    pub fn new(cache_root: PathBuf) -> Self {
        Self {
            cache_root,
            segment_cache: OnceLock::new(),
            inner: Mutex::new(None),
            preferred_device: Mutex::new(None),
            preferred_volume: Mutex::new(None),
            output_switch_lock: tokio::sync::Mutex::new(()),
            maintenance_in_progress: AtomicBool::new(false),
            health: Arc::new(NativeAudioHealth::default()),
        }
    }

    pub fn cache_limit_bytes(&self) -> u64 {
        AUDIO_CACHE_LIMIT_BYTES
    }

    fn segment_cache_status(&self) -> crate::audio_cache::CacheStatus {
        self.segment_cache
            .get()
            .and_then(|cache| cache.as_ref().ok())
            .map(SegmentCache::status)
            .unwrap_or_default()
    }

    fn segment_cache(&self) -> Result<&SegmentCache, String> {
        self.segment_cache
            .get_or_init(|| SegmentCache::new(self.cache_root.clone()))
            .as_ref()
            .map_err(Clone::clone)
    }

    fn current(&self) -> Option<Arc<NativeAudioEngine>> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(Arc::clone))
    }

    fn try_current(&self) -> Option<Arc<NativeAudioEngine>> {
        self.inner
            .try_lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(Arc::clone))
    }

    fn peek_next(&self, natural_ended: bool) -> Result<Option<usize>, String> {
        let Some(engine) = self.current() else {
            return Ok(None);
        };
        let mut queue = engine
            .queue
            .lock()
            .map_err(|_| "队列状态锁失败".to_string())?;
        Ok(queue.peek_next_index(natural_ended))
    }

    fn begin_maintenance(&self) -> SlotMaintenanceGuard<'_> {
        self.maintenance_in_progress.store(true, Ordering::SeqCst);
        SlotMaintenanceGuard(&self.maintenance_in_progress)
    }

    fn set_volume(&self, volume: f32) {
        if !volume.is_finite() {
            return;
        }
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

    fn follows_system_default(&self) -> bool {
        self.preferred_device
            .lock()
            .map(|device| device.as_deref().unwrap_or("").is_empty())
            .unwrap_or(true)
    }

    /// Stop all media work before deleting account-scoped files. The output
    /// switch lock serializes this with foreground loads/device changes, while
    /// the engine gate prevents a new current/next read head mid-cleanup.
    pub(crate) async fn reset_and_clear_cache(&self) -> Result<(), String> {
        let _operation = self.output_switch_lock.lock().await;
        let _maintenance = self.begin_maintenance();
        let engine = self
            .inner
            .lock()
            .map_err(|_| "原生引擎状态锁失败".to_string())?
            .take();
        if let Some(engine) = engine {
            engine.accepting_work.store(false, Ordering::SeqCst);
            let cleanup = engine.clear_session_state_and_wait().await;
            engine.stopped.store(true, Ordering::SeqCst);
            cleanup?;
        }
        self.segment_cache()?.clear()?;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        crate::now_playing::clear();
        Ok(())
    }

    pub fn ensure(&self, app: &AppHandle) -> Result<Arc<NativeAudioEngine>, String> {
        if self.maintenance_in_progress.load(Ordering::SeqCst) {
            return Err("原生引擎正在切换或清理".to_string());
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "原生引擎状态锁失败".to_string())?;
        if self.maintenance_in_progress.load(Ordering::SeqCst) {
            return Err("原生引擎正在切换或清理".to_string());
        }
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
            NativeAudioEngine::new_with_segment_cache_and_health(
                self.segment_cache()?.clone(),
                preferred_device.as_deref().unwrap_or(""),
                Arc::clone(&self.health),
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
    /// captured and resumed on the new device from cached ranges (or on-demand
    /// segment fetches); the old event forwarder stops cleanly.
    pub async fn set_output_device(
        &self,
        app: &AppHandle,
        device_id: String,
    ) -> Result<(), String> {
        let _switch = self.output_switch_lock.lock().await;
        self.replace_output_device(app, device_id, None)
            .await
            .map(|_| ())
    }

    async fn recover_output_stream(
        &self,
        app: &AppHandle,
        failed_engine: &Arc<NativeAudioEngine>,
    ) -> Result<Option<String>, String> {
        let _switch = self.output_switch_lock.lock().await;
        let preferred = self
            .preferred_device
            .lock()
            .map(|device| device.clone().unwrap_or_default())
            .unwrap_or_default();
        match self
            .replace_output_device(app, preferred.clone(), Some(failed_engine))
            .await
        {
            Ok(true) => Ok(Some(preferred)),
            Ok(false) => Ok(None),
            Err(preferred_error) if !preferred.is_empty() => {
                eprintln!("[原生] 所选输出设备恢复失败，尝试系统默认：{preferred_error}");
                self.replace_output_device(app, String::new(), Some(failed_engine))
                    .await
                    .and_then(|replaced| {
                        replaced
                            .then_some(Some(String::new()))
                            .ok_or_else(|| "输出流已由其他操作恢复".to_string())
                    })
            }
            Err(error) => Err(error),
        }
    }

    /// Rebuild an automatic output route when macOS/Windows changes its
    /// system default. cpal exposes no portable default-device notification,
    /// so the active engine verifies the stable ID at a low cadence.
    async fn reconcile_system_default_output(
        &self,
        app: &AppHandle,
        engine: &Arc<NativeAudioEngine>,
    ) -> Result<bool, String> {
        let current_default = current_default_output_device_id();
        if !should_rebuild_for_system_default(
            self.follows_system_default(),
            engine.observed_default_device_id.as_deref(),
            current_default.as_deref(),
        ) {
            return Ok(false);
        }

        let _switch = self.output_switch_lock.lock().await;
        let current_default = current_default_output_device_id();
        if !should_rebuild_for_system_default(
            self.follows_system_default(),
            engine.observed_default_device_id.as_deref(),
            current_default.as_deref(),
        ) {
            return Ok(false);
        }
        publish_output_device_recovering(engine, app, "system-default-changed");
        self.replace_output_device(app, String::new(), Some(engine))
            .await
    }

    async fn replace_output_device(
        &self,
        app: &AppHandle,
        device_id: String,
        expected_engine: Option<&Arc<NativeAudioEngine>>,
    ) -> Result<bool, String> {
        let _maintenance = self.begin_maintenance();
        let old = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "原生引擎状态锁失败".to_string())?;
            let Some(old) = guard.as_ref() else {
                if expected_engine.is_some() {
                    return Ok(false);
                }
                if let Ok(mut preferred) = self.preferred_device.lock() {
                    *preferred = Some(device_id);
                }
                return Ok(false);
            };
            if expected_engine.is_some_and(|expected| !Arc::ptr_eq(expected, old)) {
                return Ok(false);
            }
            Arc::clone(old)
        };
        if let Some(queued) = old.consume_started_handoff() {
            publish_started_handoff(&old, &queued, app);
        }
        let snapshot = old.capture_playback_snapshot();
        let new_engine = Arc::new(
            NativeAudioEngine::new_with_segment_cache_and_health(
                self.segment_cache()?.clone(),
                &device_id,
                Arc::clone(&self.health),
            )
            .map_err(|e| format!("切换输出设备失败: {e}"))?,
        );
        // Stop the old decoder before the new engine restores from the shared
        // segment cache so only one playback authority remains audible.
        old.accepting_work.store(false, Ordering::SeqCst);
        let stopped_generation = match old.stop_immediately_and_wait().await {
            Ok(generation) => generation,
            Err(error) => {
                old.accepting_work.store(true, Ordering::SeqCst);
                return Err(format!("停止旧输出设备媒体任务失败: {error}"));
            }
        };
        if let Err(error) = new_engine.restore_playback_snapshot(&snapshot).await {
            new_engine.accepting_work.store(false, Ordering::SeqCst);
            let cleanup = new_engine.stop_immediately_and_wait().await;
            new_engine.stopped.store(true, Ordering::SeqCst);
            old.accepting_work.store(true, Ordering::SeqCst);
            if cleanup.is_ok()
                && old.playback_generation.load(Ordering::SeqCst) == stopped_generation
            {
                let _ = old.restore_playback_snapshot(&snapshot).await;
            }
            if let Err(cleanup_error) = cleanup {
                return Err(format!(
                    "在新输出设备上恢复播放失败: {error}；清理新引擎失败: {cleanup_error}"
                ));
            }
            return Err(format!("在新输出设备上恢复播放失败: {error}"));
        }
        let installed = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "原生引擎状态锁失败".to_string())?;
            let still_current = guard
                .as_ref()
                .map(|current| Arc::ptr_eq(current, &old))
                .unwrap_or(false)
                && old.playback_generation.load(Ordering::SeqCst) == stopped_generation;
            if still_current {
                old.stopped.store(true, Ordering::SeqCst);
                *guard = Some(Arc::clone(&new_engine));
            }
            still_current
        };
        if !installed {
            new_engine.accepting_work.store(false, Ordering::SeqCst);
            let cleanup = new_engine.stop_immediately_and_wait().await;
            new_engine.stopped.store(true, Ordering::SeqCst);
            old.accepting_work.store(true, Ordering::SeqCst);
            if let Err(error) = cleanup {
                return Err(format!(
                    "播放状态在输出设备切换期间发生变化，且清理新引擎失败: {error}"
                ));
            }
            return Err("播放状态在输出设备切换期间发生变化，请重试".to_string());
        }
        if let Ok(mut preferred) = self.preferred_device.lock() {
            *preferred = Some(device_id.clone());
        }
        if let Ok(preferred) = self.preferred_volume.lock() {
            if let Some(volume) = *preferred {
                new_engine.player().set_volume(volume);
            }
        }
        new_engine.start_event_forwarder(app.clone());
        if snapshot.source.is_some() {
            let _ = app.emit(
                "native-audio://event",
                serde_json::json!({
                    "type": "output-device-recovered",
                    "deviceId": device_id,
                    "playing": snapshot.playing,
                }),
            );
        }
        Ok(true)
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

fn sanitize_playback_error_reason(reason: &str) -> String {
    let compact = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = compact.to_ascii_lowercase();
    if compact.is_empty()
        || lower.contains("://")
        || lower.contains("x-plex-token")
        || lower.contains("/library/")
        || lower.contains("/stream/")
    {
        return "音频流读取失败".to_string();
    }
    compact.chars().take(240).collect()
}

fn current_queue_identity(queue: &Arc<Mutex<QueueState>>) -> Option<(usize, String, String)> {
    let queue = queue.lock().ok()?;
    let index = queue.current()?;
    let track = queue.tracks.get(index)?;
    Some((index, track.rating_key.clone(), track.occurrence_id.clone()))
}

fn publish_playback_error(
    engine: &NativeAudioEngine,
    item: Option<(usize, String, String)>,
    reason: &str,
    app: &AppHandle,
) {
    let reason = sanitize_playback_error_reason(reason);
    let index = item.as_ref().map(|(index, _, _)| *index);
    let rating_key = item.as_ref().map(|(_, rating_key, _)| rating_key.as_str());
    let occurrence_id = item
        .as_ref()
        .map(|(_, _, occurrence_id)| occurrence_id.as_str());
    engine.stop_immediately();
    eprintln!("[原生] 播放流读取失败：{reason}");
    let _ = app.emit(
        "native-audio://event",
        serde_json::json!({
            "type": "playback-error",
            "index": index,
            "ratingKey": rating_key,
            "occurrenceId": occurrence_id,
            "reason": reason,
        }),
    );
}

fn publish_started_handoff(engine: &NativeAudioEngine, queued: &PendingTrack, app: &AppHandle) {
    let _ = app.emit(
        "native-audio://event",
        serde_json::json!({
            "type": "track",
            "index": queued.index,
            "occurrenceId": queued.occurrence_id.as_str(),
            "duration": queued.duration_seconds,
            "position": engine.playback_position_seconds(),
        }),
    );
}

fn heartbeat_watchdog_should_stop(
    last_heartbeat: Option<std::time::Instant>,
    observation: &mut Option<(std::time::Instant, std::time::Instant)>,
    renderer_visible: bool,
    now: std::time::Instant,
) -> bool {
    let Some(last_heartbeat) = last_heartbeat else {
        *observation = None;
        return false;
    };
    if !renderer_visible || now.saturating_duration_since(last_heartbeat) < HEARTBEAT_STALL_TIMEOUT
    {
        *observation = None;
        return false;
    }
    match *observation {
        Some((observed_heartbeat, first_seen)) if observed_heartbeat == last_heartbeat => {
            now.saturating_duration_since(first_seen) >= HEARTBEAT_STALL_CONFIRMATION
        }
        _ => {
            *observation = Some((last_heartbeat, now));
            false
        }
    }
}

fn renderer_requires_heartbeat(is_visible: bool, is_minimized: bool) -> bool {
    is_visible && !is_minimized
}

fn output_device_label(device: &cpal::Device) -> String {
    use cpal::traits::DeviceTrait;
    device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| "未知输出设备".to_string())
}

fn is_usable_output_device(device: &cpal::Device) -> bool {
    use cpal::traits::DeviceTrait;
    let Ok(description) = device.description() else {
        return false;
    };
    if description
        .driver()
        .is_some_and(|driver| driver.eq_ignore_ascii_case("null"))
        || matches!(description.interface_type(), cpal::InterfaceType::Virtual)
        || matches!(description.device_type(), cpal::DeviceType::Virtual)
    {
        return false;
    }
    let label = description.name().to_ascii_lowercase();
    !["blackhole", "virtual", "loopback"]
        .iter()
        .any(|marker| label.contains(marker))
}

fn current_default_output_device_id() -> Option<String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    cpal::default_host()
        .default_output_device()?
        .id()
        .ok()
        .map(|id| id.to_string())
}

/// Keep the automatic/default route distinct from a user-selected output.
/// A missing current default is not actionable: retaining the active stream is
/// safer than repeatedly tearing it down while CoreAudio is in transition.
fn should_rebuild_for_system_default(
    follows_system_default: bool,
    observed_default: Option<&str>,
    current_default: Option<&str>,
) -> bool {
    follows_system_default && current_default.is_some() && observed_default != current_default
}

/// Playback becomes externally observable only after the output callback has
/// drained at least one decoded PCM chunk. Decoder readiness or a non-empty
/// rodio queue alone is not enough: either can still be silent on a dead
/// output route.
fn output_has_started(
    desired_playing: bool,
    has_player_source: bool,
    decode_state: Option<&Arc<DecodeBufferState>>,
    playback_start_frame: u64,
) -> bool {
    desired_playing
        && has_player_source
        && decode_state.is_some_and(|state| {
            state.output_media_frames.load(Ordering::SeqCst) > playback_start_frame
        })
}

/// Returns true only when a source that should be audible has not advanced its
/// output-callback frame counter for a full watchdog interval. Buffering and
/// user-paused playback deliberately clear the observation instead of
/// rebuilding a healthy stream.
fn output_progress_watchdog_should_recover(
    desired_playing: bool,
    has_player_source: bool,
    buffer_paused: bool,
    output_media_frames: Option<u64>,
    observation: &mut Option<(u64, std::time::Instant)>,
    now: std::time::Instant,
) -> bool {
    if !desired_playing || !has_player_source || buffer_paused {
        *observation = None;
        return false;
    }
    let Some(output_media_frames) = output_media_frames else {
        *observation = None;
        return false;
    };
    match *observation {
        Some((observed_frames, first_seen)) if observed_frames == output_media_frames => {
            now.saturating_duration_since(first_seen) >= OUTPUT_PROGRESS_STALL_TIMEOUT
        }
        _ => {
            *observation = Some((output_media_frames, now));
            false
        }
    }
}

/// As soon as the old route is known to be unusable, retract the prior output
/// confirmation. The WebView must show recovery/loading until the replacement
/// engine emits a fresh `playback-started` after consuming PCM.
fn publish_output_device_recovering(
    engine: &NativeAudioEngine,
    app: &AppHandle,
    reason: &'static str,
) {
    let playing = engine.loaded.load(Ordering::SeqCst)
        && engine.desired_playing.load(Ordering::SeqCst)
        && !engine.player().empty();
    if playing {
        engine.require_fresh_pcm_confirmation();
    }
    let _ = app.emit(
        "native-audio://event",
        serde_json::json!({
            "type": "output-device-recovering",
            "reason": reason,
            "playing": playing,
        }),
    );
}

fn open_device_sink<E>(
    device: cpal::Device,
    error_callback: E,
) -> Result<MixerDeviceSink, rodio::DeviceSinkError>
where
    E: FnMut(cpal::StreamError) + Send + Clone + 'static,
{
    DeviceSinkBuilder::from_device(device)?
        .with_error_callback(error_callback)
        .open_sink_or_fallback()
}

fn open_device_sink_once<E>(
    device: cpal::Device,
    error_callback: E,
) -> Result<MixerDeviceSink, rodio::DeviceSinkError>
where
    E: FnMut(cpal::StreamError) + Send + Clone + 'static,
{
    DeviceSinkBuilder::from_device(device)?
        .with_buffer_size(cpal::BufferSize::Default)
        .with_error_callback(error_callback)
        .open_stream()
}

#[cfg(target_os = "macos")]
fn macos_default_system_output_uid() -> Option<String> {
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultSystemOutputDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioDeviceID, AudioObjectGetPropertyData, AudioObjectPropertyAddress,
    };
    use objc2_core_foundation::{CFRetained, CFString};
    use std::mem::size_of;
    use std::ptr::{null, null_mut, NonNull};

    let mut address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut device_id: AudioDeviceID = 0;
    let mut data_size = size_of::<AudioDeviceID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as u32,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut data_size),
            NonNull::from(&mut device_id).cast(),
        )
    };
    if status != 0 || device_id == 0 {
        return None;
    }

    address.mSelector = kAudioDevicePropertyDeviceUID;
    let mut uid: *mut CFString = null_mut();
    let mut data_size = size_of::<*mut CFString>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut data_size),
            NonNull::from(&mut uid).cast(),
        )
    };
    if status != 0 {
        return None;
    }
    Some(unsafe { CFRetained::from_raw(NonNull::new(uid)?) }.to_string())
}

#[cfg(target_os = "macos")]
fn macos_should_skip_display_default() -> bool {
    use objc2_core_audio::{
        kAudioDevicePropertyTransportType, kAudioDeviceTransportTypeDisplayPort,
        kAudioDeviceTransportTypeHDMI, kAudioHardwarePropertyDefaultOutputDevice,
        kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, AudioDeviceID,
        AudioObjectGetPropertyData, AudioObjectPropertyAddress,
    };
    use std::mem::size_of;
    use std::ptr::{null, NonNull};

    let read_device = |selector| {
        let address = AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut device_id: AudioDeviceID = 0;
        let mut data_size = size_of::<AudioDeviceID>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject as u32,
                NonNull::from(&address),
                0,
                null(),
                NonNull::from(&mut data_size),
                NonNull::from(&mut device_id).cast(),
            )
        };
        (status == 0 && device_id != 0).then_some(device_id)
    };
    let Some(default_device) = read_device(kAudioHardwarePropertyDefaultOutputDevice) else {
        return false;
    };
    let Some(system_device) = read_device(kAudioHardwarePropertyDefaultSystemOutputDevice) else {
        return false;
    };
    if default_device == system_device {
        return false;
    }

    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut transport = 0u32;
    let mut data_size = size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            default_device,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut data_size),
            NonNull::from(&mut transport).cast(),
        )
    };
    status == 0
        && (transport == kAudioDeviceTransportTypeDisplayPort
            || transport == kAudioDeviceTransportTypeHDMI)
}

#[cfg(not(target_os = "macos"))]
fn macos_should_skip_display_default() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn open_device_sink_bounded<E>(
    device: cpal::Device,
    mut error_callback: E,
    exhaustive: bool,
) -> Result<MixerDeviceSink, String>
where
    E: FnMut(cpal::StreamError) + Send + Clone + 'static,
{
    let selected = Arc::new(AtomicBool::new(false));
    let selected_for_callback = Arc::clone(&selected);
    let (sender, receiver) = sync_channel(1);
    std::thread::Builder::new()
        .name("cadilume-output-open".to_string())
        .spawn(move || {
            let guarded_callback = move |error| {
                if selected_for_callback.load(Ordering::SeqCst) {
                    error_callback(error);
                }
            };
            let result = (if exhaustive {
                open_device_sink(device, guarded_callback)
            } else {
                open_device_sink_once(device, guarded_callback)
            })
            .map(|mut sink| {
                sink.log_on_drop(false);
                sink
            })
            .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| format!("无法启动音频设备打开线程: {error}"))?;
    match receiver.recv_timeout(MACOS_OUTPUT_OPEN_TIMEOUT) {
        Ok(Ok(sink)) => {
            selected.store(true, Ordering::SeqCst);
            Ok(sink)
        }
        Ok(Err(error)) => Err(error),
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "打开设备超过 {}ms",
            MACOS_OUTPUT_OPEN_TIMEOUT.as_millis()
        )),
        Err(RecvTimeoutError::Disconnected) => Err("音频设备打开线程提前退出".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn open_fallback_output_sink<E>(
    devices: Vec<cpal::Device>,
    error_callback: E,
) -> Result<(MixerDeviceSink, String), String>
where
    E: FnMut(cpal::StreamError) + Send + Clone + 'static,
{
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut pending = 0usize;
    for device in devices {
        if !is_usable_output_device(&device) {
            continue;
        }
        let label = output_device_label(&device);
        let selected = Arc::new(AtomicBool::new(false));
        let selected_for_callback = Arc::clone(&selected);
        let mut candidate_error_callback = error_callback.clone();
        let candidate_sender = sender.clone();
        let candidate_label = label.clone();
        if std::thread::Builder::new()
            .name("cadilume-output-fallback".to_string())
            .spawn(move || {
                let guarded_callback = move |error| {
                    if selected_for_callback.load(Ordering::SeqCst) {
                        candidate_error_callback(error);
                    }
                };
                let result = open_device_sink(device, guarded_callback)
                    .map(|mut sink| {
                        sink.log_on_drop(false);
                        sink
                    })
                    .map_err(|error| error.to_string());
                let _ = candidate_sender.send((candidate_label, selected, result));
            })
            .is_ok()
        {
            pending += 1;
        }
    }
    drop(sender);

    let deadline = std::time::Instant::now() + MACOS_FALLBACK_OPEN_TIMEOUT;
    while pending > 0 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok((label, selected, Ok(sink))) => {
                selected.store(true, Ordering::SeqCst);
                return Ok((sink, label));
            }
            Ok((label, _, Err(error))) => {
                pending -= 1;
                crate::diagnostics::record(
                    "音频",
                    format_args!("output_device_fallback_failed label={label} error={error}"),
                );
            }
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    Err(format!(
        "没有候选设备在 {}ms 内完成打开",
        MACOS_FALLBACK_OPEN_TIMEOUT.as_millis()
    ))
}

#[cfg(not(target_os = "macos"))]
fn open_device_sink_bounded<E>(
    device: cpal::Device,
    error_callback: E,
    exhaustive: bool,
) -> Result<MixerDeviceSink, String>
where
    E: FnMut(cpal::StreamError) + Send + Clone + 'static,
{
    (if exhaustive {
        open_device_sink(device, error_callback)
    } else {
        open_device_sink_once(device, error_callback)
    })
    .map_err(|error| error.to_string())
}

fn open_output_sink<E>(device_id: &str, error_callback: E) -> anyhow::Result<MixerDeviceSink>
where
    E: FnMut(cpal::StreamError) + Send + Clone + 'static,
{
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    if !device_id.is_empty() {
        let stable_id = device_id.parse::<cpal::DeviceId>().ok();
        let device = stable_id
            .as_ref()
            .and_then(|id| host.device_by_id(id))
            .or_else(|| {
                // One-time migration for preferences written before cpal's
                // stable DeviceId replaced the human-readable name.
                host.output_devices().ok()?.find(|device| {
                    device
                        .description()
                        .map(|description| description.name() == device_id)
                        .unwrap_or(false)
                })
            })
            .ok_or_else(|| anyhow::anyhow!("找不到所选输出设备"))?;
        let label = output_device_label(&device);
        let sink = open_device_sink_bounded(device, error_callback, true)
            .map_err(|error| anyhow::anyhow!("打开所选输出设备失败: {error}"))?;
        crate::diagnostics::record("音频", format_args!("output_device=selected label={label}"));
        return Ok(sink);
    }

    let default_device = host.default_output_device();
    let default_id = default_device
        .as_ref()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());

    // Snapshot every fallback candidate before attempting to open the default
    // route. A timed-out CoreAudio open can keep the HAL command gate busy long
    // after our caller moves on; enumerating devices after that timeout can
    // otherwise block the warmup worker for tens of seconds.
    #[cfg(target_os = "macos")]
    let (system_id, mut fallback_devices) = {
        let system_uid = macos_default_system_output_uid();
        let devices = host
            .output_devices()
            .map_err(|error| anyhow::anyhow!("枚举音频输出设备失败: {error}"))?
            .collect::<Vec<_>>();
        let system_id = system_uid.and_then(|uid| {
            devices.iter().find_map(|device| {
                let id = device.id().ok()?;
                (id.1 == uid).then(|| id.to_string())
            })
        });
        (system_id, devices)
    };

    let skip_display_default = macos_should_skip_display_default();
    let mut first_error = None;
    if skip_display_default {
        crate::diagnostics::record(
            "音频",
            format_args!("output_device_default_skipped reason=display-route"),
        );
    } else if let Some(device) = default_device {
        let label = output_device_label(&device);
        match open_device_sink_bounded(device, error_callback.clone(), false) {
            Ok(sink) => {
                crate::diagnostics::record(
                    "音频",
                    format_args!("output_device=default label={label}"),
                );
                return Ok(sink);
            }
            Err(error) => {
                crate::diagnostics::record(
                    "音频",
                    format_args!("output_device_default_failed label={label} error={error}"),
                );
                first_error = Some(error.to_string());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut candidates = Vec::new();
        if system_id.is_some() && system_id != default_id {
            if let Some(position) = fallback_devices
                .iter()
                .position(|device| device.id().ok().map(|id| id.to_string()) == system_id)
            {
                let device = fallback_devices.remove(position);
                candidates.push(device);
            }
        }
        for device in fallback_devices {
            let id = device.id().ok().map(|id| id.to_string());
            if id.is_some() && (id == default_id || id == system_id) {
                continue;
            }
            candidates.push(device);
        }
        match open_fallback_output_sink(candidates, error_callback) {
            Ok((sink, label)) => {
                crate::diagnostics::record(
                    "音频",
                    format_args!("output_device=fallback label={label}"),
                );
                return Ok(sink);
            }
            Err(error) => first_error.get_or_insert(error),
        };
        return Err(anyhow::anyhow!(
            "没有可打开的音频输出设备: {}",
            first_error.unwrap_or_else(|| "系统未报告可用输出设备".to_string())
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let system_id: Option<String> = None;
        let devices = host
            .output_devices()
            .map_err(|error| anyhow::anyhow!("枚举音频输出设备失败: {error}"))?;
        for device in devices {
            let id = device.id().ok().map(|id| id.to_string());
            if id.is_some() && (id == default_id || id == system_id) {
                continue;
            }
            if !is_usable_output_device(&device) {
                continue;
            }
            let label = output_device_label(&device);
            match open_device_sink_bounded(device, error_callback.clone(), true) {
                Ok(sink) => {
                    crate::diagnostics::record(
                        "音频",
                        format_args!("output_device=fallback label={label}"),
                    );
                    return Ok(sink);
                }
                Err(error) => {
                    crate::diagnostics::record(
                        "音频",
                        format_args!("output_device_fallback_failed label={label} error={error}"),
                    );
                    first_error.get_or_insert_with(|| error.to_string());
                }
            }
        }

        Err(anyhow::anyhow!(
            "没有可打开的音频输出设备: {}",
            first_error.unwrap_or_else(|| "系统未报告可用输出设备".to_string())
        ))
    }
}

impl NativeAudioEngine {
    #[cfg(test)]
    pub fn new(cache_root: PathBuf) -> anyhow::Result<Self> {
        let segment_cache =
            SegmentCache::new(cache_root).map_err(|error| anyhow::anyhow!(error))?;
        let health = Arc::new(NativeAudioHealth::default());
        Self::new_with_mixer_sink(
            segment_cache,
            AudioMixerSink::Test(TestMixerSink::new()?),
            health,
            Arc::new(AtomicBool::new(false)),
            None,
        )
    }

    fn new_with_segment_cache_and_health(
        segment_cache: SegmentCache,
        device_id: &str,
        health: Arc<NativeAudioHealth>,
    ) -> anyhow::Result<Self> {
        let observed_default_device_id = device_id
            .is_empty()
            .then(current_default_output_device_id)
            .flatten();
        let health_for_stream = Arc::clone(&health);
        let output_recovery_pending = Arc::new(AtomicBool::new(false));
        let recovery_pending_for_stream = Arc::clone(&output_recovery_pending);
        // `from_device` starts with rodio's low-latency fixed buffer. CoreAudio
        // can reject that exact size for Bluetooth, aggregate, and some HDMI
        // devices even though the device has a perfectly valid output format.
        // Let rodio retry the device's supported configurations before
        // reporting a hard playback failure. This is especially important in
        // optimized packaged builds where the first stream is opened only when
        // the user starts the first track.
        let mut sink = open_output_sink(device_id, move |error| {
            health_for_stream.record_output_stream_error(&recovery_pending_for_stream);
            eprintln!("[原生] 音频输出流错误，等待自动恢复：{error}");
        })
        .map_err(|e| anyhow::anyhow!("音频流启动失败（已尝试设备支持的配置）: {e}"))?;
        // Engine replacement and app shutdown intentionally drop this owned
        // stream after playback has already been stopped.
        sink.log_on_drop(false);
        Self::new_with_mixer_sink(
            segment_cache,
            AudioMixerSink::Device(sink),
            health,
            output_recovery_pending,
            observed_default_device_id,
        )
    }

    fn new_with_mixer_sink(
        segment_cache: SegmentCache,
        sink: AudioMixerSink,
        health: Arc<NativeAudioHealth>,
        output_recovery_pending: Arc<AtomicBool>,
        observed_default_device_id: Option<String>,
    ) -> anyhow::Result<Self> {
        let (output_channels, output_sample_rate) = sink.output_format();
        let player = Arc::new(Player::connect_new(sink.mixer()));
        crate::diagnostics::record(
            "音频",
            format_args!(
                "mixer_format sample_rate={} channels={}",
                output_sample_rate, output_channels
            ),
        );
        // 引擎不做默认音量：rodio Player 默认 1.0（100%），实际音量由前端
        // 缓存记录并在加载时同步（见 loadNativeTrack 的 nativeAudioSetVolume）。
        Ok(Self {
            player: Mutex::new(player),
            sink,
            output_channels,
            output_sample_rate,
            segment_cache,
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
            decode_state: Arc::new(Mutex::new(None)),
            desired_playing: Arc::new(AtomicBool::new(false)),
            playback_started: Arc::new(AtomicBool::new(false)),
            playback_start_frame: Arc::new(AtomicU64::new(0)),
            buffer_paused: Arc::new(AtomicBool::new(false)),
            accepting_work: Arc::new(AtomicBool::new(true)),
            stopped: Arc::new(AtomicBool::new(false)),
            last_heartbeat: Arc::new(Mutex::new(None)),
            heartbeat_stale_observation: Arc::new(Mutex::new(None)),
            active_segment_prepare: Arc::new(Mutex::new(None)),
            health,
            output_recovery_pending,
            observed_default_device_id,
        })
    }

    fn player(&self) -> Arc<Player> {
        self.player
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    /// Media time excludes the silence emitted while a decoder worker is
    /// temporarily empty. Rodio's own position counts every output sample,
    /// which would otherwise make lyrics, scrobbling and system media state
    /// drift ahead after repeated network underflows.
    fn playback_position_seconds(&self) -> f64 {
        self.decode_state
            .lock()
            .ok()
            .and_then(|state| state.as_ref().map(|state| state.position_seconds()))
            .unwrap_or_else(|| self.player().get_pos().as_secs_f64())
    }

    fn cancel_active_prepare(&self) {
        if let Ok(mut active) = self.active_segment_prepare.lock() {
            if let Some(control) = active.take() {
                control.cancel();
            }
        }
    }

    fn register_segment_prepare(
        &self,
        generation: u64,
        control: Arc<SegmentControl>,
    ) -> Result<(), String> {
        let _transition = self
            .transition_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !self.playback_is_current(generation) {
            control.cancel();
            return Err("播放加载已被新操作替代".to_string());
        }
        let mut active = self
            .active_segment_prepare
            .lock()
            .map_err(|_| "分段缓存准备状态锁失败".to_string())?;
        if let Some(previous) = active.replace(control) {
            previous.cancel();
        }
        Ok(())
    }

    fn clear_segment_prepare(&self, control: &Arc<SegmentControl>) {
        if let Ok(mut active) = self.active_segment_prepare.lock() {
            if active
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, control))
            {
                *active = None;
            }
        }
    }

    /// Replace the rodio control handle instead of calling `Player::clear()`.
    /// The decoder may be waiting on a segment read; replacing the player keeps
    /// synchronous Tauri commands from waiting on the audio thread.
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

    fn prepare_playback_transition(&self) -> PlaybackTransition {
        let _transition = self
            .transition_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let generation = self.playback_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut decode_states = Vec::with_capacity(2);
        self.loaded.store(false, Ordering::SeqCst);
        self.ended_sent.store(true, Ordering::SeqCst);
        self.desired_playing.store(false, Ordering::SeqCst);
        self.playback_started.store(false, Ordering::SeqCst);
        self.playback_start_frame.store(0, Ordering::SeqCst);
        self.buffer_paused.store(false, Ordering::SeqCst);
        if let Ok(mut observation) = self.heartbeat_stale_observation.lock() {
            *observation = None;
        }
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(pending) = pending.take() {
                pending.decode_state.cancel_worker();
                decode_states.push(pending.decode_state);
            }
        }
        if let Ok(mut decode_state) = self.decode_state.lock() {
            if let Some(decode_state) = decode_state.take() {
                decode_state.cancel_worker();
                decode_states.push(decode_state);
            }
        }
        self.cancel_active_prepare();
        self.replace_player();
        PlaybackTransition {
            generation,
            decode_states,
        }
    }

    /// Require new audio to reach the output callback before exposing this
    /// playback request. This also covers a user resuming after a device route
    /// was rebuilt while paused.
    fn require_fresh_pcm_confirmation(&self) {
        let output_frame = self
            .decode_state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .as_ref()
                    .map(|state| state.output_media_frames.load(Ordering::SeqCst))
            })
            .unwrap_or(0);
        self.playback_start_frame
            .store(output_frame, Ordering::SeqCst);
        self.playback_started.store(false, Ordering::SeqCst);
    }

    fn begin_playback_transition(&self) -> u64 {
        self.prepare_playback_transition().generation
    }

    fn playback_is_current(&self, generation: u64) -> bool {
        self.accepting_work.load(Ordering::SeqCst)
            && self.playback_generation.load(Ordering::SeqCst) == generation
    }

    fn ensure_accepting_work(&self) -> Result<(), String> {
        self.accepting_work
            .load(Ordering::SeqCst)
            .then_some(())
            .ok_or_else(|| "原生引擎正在切换或清理".to_string())
    }

    fn stop_immediately(&self) -> u64 {
        self.begin_playback_transition()
    }

    async fn stop_immediately_and_wait(&self) -> Result<u64, String> {
        let transition = self.prepare_playback_transition();
        let deadline = tokio::time::Instant::now() + PLAYBACK_TASK_SHUTDOWN_TIMEOUT;
        loop {
            let active_workers = transition
                .decode_states
                .iter()
                .filter(|state| !state.worker_exited.load(Ordering::SeqCst))
                .count();
            let active_cache_operations = self.segment_cache.active_operations();
            if active_workers == 0 && active_cache_operations == 0 {
                return Ok(transition.generation);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "等待媒体任务退出超时（解码任务 {active_workers}，缓存任务 {active_cache_operations}）"
                ));
            }
            tokio::time::sleep(PLAYBACK_TASK_SHUTDOWN_POLL).await;
        }
    }

    async fn clear_session_state_and_wait(&self) -> Result<(), String> {
        self.stop_immediately_and_wait().await?;
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
        Ok(())
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
            let Ok(client) = loopback_http_client(Some(Duration::from_secs(10))) else {
                eprintln!("[播放] NowPlaying 封面客户端创建失败");
                return;
            };
            let response = match client.get(&url).send().await {
                Ok(response) => response,
                Err(error) => {
                    eprintln!(
                        "[播放] NowPlaying 封面读取失败：{}",
                        http_error_category(&error)
                    );
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
                        eprintln!(
                            "[播放] NowPlaying 封面响应读取失败：{}",
                            http_error_category(&error)
                        );
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

    /// Attach a late artwork ticket without delaying foreground playback. The
    /// queue identity prevents an old WebView request from updating a reused
    /// index after a track or server transition.
    fn set_artwork_for_track(
        &self,
        index: i64,
        rating_key: &str,
        occurrence_id: &str,
        artwork_url: String,
    ) -> Result<(), String> {
        self.ensure_accepting_work()?;
        let index = usize::try_from(index).map_err(|_| "无效的曲目序号".to_string())?;
        let track_matches = self
            .queue
            .lock()
            .map_err(|_| "队列状态锁失败".to_string())?
            .tracks
            .get(index)
            .is_some_and(|track| {
                track.rating_key == rating_key && track.occurrence_id == occurrence_id
            });
        if !track_matches {
            return Err("封面对应的曲目已不在当前队列".to_string());
        }

        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "预排状态锁失败".to_string())?;
            if let Some(queued) = pending.as_mut().filter(|queued| {
                queued.index == index
                    && queued.rating_key == rating_key
                    && queued.occurrence_id == occurrence_id
            }) {
                queued.metadata.artwork_url = Some(artwork_url.clone());
                drop(pending);
                self.prime_artwork_ticket(
                    &artwork_url,
                    self.playback_generation.load(Ordering::SeqCst),
                );
                return Ok(());
            }
        }

        let is_current = self
            .queue
            .lock()
            .map_err(|_| "队列状态锁失败".to_string())?
            .current_index
            == index as i64;
        if !is_current {
            return Err("封面对应的曲目尚未开始播放".to_string());
        }
        let mut metadata = self
            .metadata
            .lock()
            .map_err(|_| "元数据状态锁失败".to_string())?;
        metadata
            .get_or_insert_with(NowPlayingMetadata::default)
            .artwork_url = Some(artwork_url.clone());
        drop(metadata);
        if let Ok(mut source) = self.current_source.lock() {
            if let Some(source) = source.as_mut() {
                source.metadata.artwork_url = Some(artwork_url.clone());
            }
        }
        self.start_artwork_fetch(
            &artwork_url,
            self.playback_generation.load(Ordering::SeqCst),
        );
        Ok(())
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
            let Ok(client) = loopback_http_client(Some(Duration::from_secs(10))) else {
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
                Err(error) => eprintln!(
                    "[播放] NowPlaying 预排封面票据激活失败：{}",
                    http_error_category(&error)
                ),
            }
        });
    }

    /// Load a local media file and start playing it.
    #[cfg(test)]
    pub fn load_and_play(&self, path: &str) -> Result<usize, String> {
        self.load_file(path, true)
    }

    fn load_file(&self, path: &str, start_playing: bool) -> Result<usize, String> {
        self.ensure_accepting_work()?;
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
            start_playing,
        )
    }

    fn load_file_for_generation(
        &self,
        path: &str,
        generation: u64,
        current_source: CurrentSource,
        start_playing: bool,
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
        let total = decoder
            .total_duration()
            .map(|duration| duration.as_secs_f64())
            .or_else(|| {
                current_source
                    .metadata
                    .duration_ms
                    .map(|milliseconds| milliseconds as f64 / 1000.0)
            });
        let (decoder, decode_state) = spawn_threaded_decoder_for_output(
            decoder,
            self.output_channels,
            self.output_sample_rate,
            None,
            Arc::clone(&self.health),
        )?;
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
        *self
            .decode_state
            .lock()
            .map_err(|_| "解码缓冲状态锁失败".to_string())? = Some(decode_state);
        if !start_playing {
            // Pause before attaching the source so restoring a paused session or
            // changing devices cannot leak even a single audible callback.
            player.pause();
        }
        player.append(decoder);
        if start_playing {
            player.play();
        }
        self.desired_playing.store(start_playing, Ordering::SeqCst);
        self.buffer_paused.store(false, Ordering::SeqCst);
        self.loaded.store(true, Ordering::SeqCst);
        self.ended_sent.store(false, Ordering::SeqCst);
        eprintln!(
            "[原生] rodio 载入媒体成功 队列={} 时长={:?}",
            player.len(),
            total,
        );
        Ok(player.len())
    }

    /// Start a loopback media URL from its cached 256 KiB head, then persist
    /// only the later ranges requested by the decoder.
    #[cfg(test)]
    pub async fn load_cached_and_play(
        &self,
        source: &str,
        cache_key: Option<String>,
        metadata: Option<NowPlayingMetadata>,
    ) -> Result<usize, String> {
        self.load_cached(source, cache_key, metadata, true).await
    }

    async fn load_cached(
        &self,
        source: &str,
        cache_key: Option<String>,
        metadata: Option<NowPlayingMetadata>,
        start_playing: bool,
    ) -> Result<usize, String> {
        self.load_cached_with_prepare_timeout(
            source,
            cache_key,
            metadata,
            start_playing,
            SEGMENT_DECODE_PREPARE_TIMEOUT,
        )
        .await
    }

    async fn wait_for_decode_buffer_ready(
        &self,
        state: &Arc<DecodeBufferState>,
        generation: u64,
        deadline: tokio::time::Instant,
        context: &str,
    ) -> Result<(), String> {
        while !state.ready_for_initial_playback()
            && !state.worker_exited.load(Ordering::SeqCst)
            && self.playback_is_current(generation)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if !self.playback_is_current(generation) {
            state.cancel_worker();
            return Err("当前播放已切换".to_string());
        }
        if let Some(failure) = state.reader_failure() {
            state.cancel_worker();
            return Err(format!("{context}分段媒体读取失败: {failure}"));
        }
        if !state.ready_for_initial_playback() {
            state.cancel_worker();
            return Err(format!("{context}未能形成足够的解码缓冲"));
        }
        crate::diagnostics::record(
            "音频",
            format_args!(
                "decoder_buffer_ready=true context={} buffered_chunks={} required_chunks={}",
                context,
                state.buffered_chunks.load(Ordering::SeqCst),
                state.buffer_capacity,
            ),
        );
        Ok(())
    }

    async fn load_cached_with_prepare_timeout(
        &self,
        source: &str,
        cache_key: Option<String>,
        metadata: Option<NowPlayingMetadata>,
        start_playing: bool,
        prepare_timeout: Duration,
    ) -> Result<usize, String> {
        self.ensure_accepting_work()?;
        let generation = self.stop_immediately_and_wait().await?;
        if !self.playback_is_current(generation) {
            return Err("播放加载已被新操作替代".to_string());
        }
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
                start_playing,
            );
        }
        let reader =
            self.segment_cache
                .open_reader(cache_key.as_deref(), source, CachePriority::Current)?;
        let control = reader.control();
        self.register_segment_prepare(generation, Arc::clone(&control))?;
        let metadata_duration_ms = metadata_for_source
            .as_ref()
            .and_then(|metadata| metadata.duration_ms);
        let target_channels = self.output_channels;
        let target_sample_rate = self.output_sample_rate;
        let health = Arc::clone(&self.health);
        let prepare_deadline = tokio::time::Instant::now() + prepare_timeout;
        let mut prepare_task = tauri::async_runtime::spawn_blocking(move || {
            prepare_segment_decoder(
                reader,
                metadata_duration_ms,
                target_channels,
                target_sample_rate,
                health,
            )
        });
        let prepared = match tokio::time::timeout(prepare_timeout, &mut prepare_task).await {
            Ok(Ok(Ok(prepared))) => prepared,
            Ok(Ok(Err(error))) => {
                control.cancel();
                self.clear_segment_prepare(&control);
                return Err(error);
            }
            Ok(Err(error)) => {
                control.cancel();
                self.clear_segment_prepare(&control);
                return Err(format!("分段解码准备任务失败: {error}"));
            }
            Err(_) => {
                control.cancel();
                if tokio::time::timeout(SEGMENT_PREPARE_CANCEL_TIMEOUT, &mut prepare_task)
                    .await
                    .is_err()
                {
                    prepare_task.abort();
                    eprintln!("[原生] 分段解码准备任务取消超时");
                }
                self.clear_segment_prepare(&control);
                return Err(format!(
                    "媒体解码准备超过 {} 秒，尝试兼容质量",
                    prepare_timeout.as_secs_f64()
                ));
            }
        };
        let buffer_result = self
            .wait_for_decode_buffer_ready(
                &prepared.decode_state,
                generation,
                prepare_deadline,
                "当前曲目",
            )
            .await;
        self.clear_segment_prepare(&control);
        buffer_result?;
        let total = prepared.total_seconds;
        let decoder = prepared.decoder;
        let decode_state = prepared.decode_state;
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
        *self
            .decode_state
            .lock()
            .map_err(|_| "解码缓冲状态锁失败".to_string())? = Some(decode_state);
        if !start_playing {
            player.pause();
        }
        player.append(decoder);
        if start_playing {
            player.play();
        }
        self.desired_playing.store(start_playing, Ordering::SeqCst);
        self.buffer_paused.store(false, Ordering::SeqCst);
        self.loaded.store(true, Ordering::SeqCst);
        self.ended_sent.store(false, Ordering::SeqCst);
        let status = self.segment_cache.status();
        eprintln!(
            "[原生] 分段播放开始 实际缓存={} 时长={:?}",
            status.allocated_bytes, total,
        );
        Ok(player.len())
    }

    /// Prepare the actual next track with a second segmented read head. Once
    /// its bounded PCM queue is ready (or the media is already at EOF), append
    /// it to rodio for a sample-contiguous handoff without downloading the
    /// complete source first.
    pub async fn queue_next_source(
        &self,
        index: i64,
        source: &str,
        cache_key: Option<String>,
        metadata: Option<NowPlayingMetadata>,
    ) -> Result<(), String> {
        self.ensure_accepting_work()?;
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
            let mut queue = self
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
        let metadata_duration_ms = metadata.duration_ms;
        let (decoder, decode_state, decoded_total) = if source.starts_with("http://")
            || source.starts_with("https://")
        {
            let reader = self.segment_cache.open_reader(
                cache_key.as_deref(),
                source,
                CachePriority::Next,
            )?;
            let control = reader.control();
            self.register_segment_prepare(generation, Arc::clone(&control))?;
            let health = Arc::clone(&self.health);
            let target_channels = self.output_channels;
            let target_sample_rate = self.output_sample_rate;
            let mut prepare_task = tauri::async_runtime::spawn_blocking(move || {
                prepare_segment_decoder(
                    reader,
                    metadata_duration_ms,
                    target_channels,
                    target_sample_rate,
                    health,
                )
            });
            let prepared =
                match tokio::time::timeout(SEGMENT_DECODE_PREPARE_TIMEOUT, &mut prepare_task).await
                {
                    Ok(Ok(Ok(prepared))) => prepared,
                    Ok(Ok(Err(error))) => {
                        control.cancel();
                        self.clear_segment_prepare(&control);
                        return Err(format!("预排{error}"));
                    }
                    Ok(Err(error)) => {
                        control.cancel();
                        self.clear_segment_prepare(&control);
                        return Err(format!("预排分段解码任务失败: {error}"));
                    }
                    Err(_) => {
                        control.cancel();
                        if tokio::time::timeout(SEGMENT_PREPARE_CANCEL_TIMEOUT, &mut prepare_task)
                            .await
                            .is_err()
                        {
                            prepare_task.abort();
                        }
                        self.clear_segment_prepare(&control);
                        return Err("预排分段解码准备超时".to_string());
                    }
                };
            let buffer_result = self
                .wait_for_decode_buffer_ready(
                    &prepared.decode_state,
                    generation,
                    tokio::time::Instant::now() + SEGMENT_DECODE_PREPARE_TIMEOUT,
                    "下一首",
                )
                .await;
            self.clear_segment_prepare(&control);
            buffer_result?;
            (
                prepared.decoder,
                prepared.decode_state,
                prepared.total_seconds,
            )
        } else {
            let file = std::fs::File::open(source)
                .map_err(|error| format!("打开预排媒体失败: {error}"))?;
            let len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            let decoder = Decoder::builder()
                .with_data(file)
                .with_byte_len(len)
                .build()
                .map_err(|error| format!("预排解码失败: {error}"))?;
            let decoded_total = decoder
                .total_duration()
                .map(|duration| duration.as_secs_f64());
            let (decoder, decode_state) = spawn_threaded_decoder_for_output(
                decoder,
                self.output_channels,
                self.output_sample_rate,
                None,
                Arc::clone(&self.health),
            )
            .map_err(|error| format!("预排{error}"))?;
            (decoder, decode_state, decoded_total)
        };
        let total = decoded_total
            .or_else(|| metadata_duration_ms.map(|milliseconds| milliseconds as f64 / 1000.0));
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
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "预排状态锁失败".to_string())?;
        if pending.is_some() {
            decode_state.cancel_worker();
            return Err("下一首已经由其他操作预排".to_string());
        }
        let queue_matches = {
            let mut queue = self
                .queue
                .lock()
                .map_err(|_| "队列状态锁失败".to_string())?;
            queue.peek_next_index(true) == Some(index)
                && queue
                    .tracks
                    .get(index)
                    .is_some_and(|candidate| candidate.occurrence_id == track.occurrence_id)
        };
        if !queue_matches {
            decode_state.cancel_worker();
            return Err("预排顺序已被队列更新替代".to_string());
        }
        let player = self
            .player
            .lock()
            .map_err(|_| "播放器状态锁失败".to_string())?;
        player.append(marker);
        *pending = Some(PendingTrack {
            index,
            rating_key: track.rating_key,
            occurrence_id: track.occurrence_id,
            duration_seconds: total,
            source: source.to_string(),
            cache_key,
            metadata,
            started,
            decode_state,
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

    /// Replace an already-appended next source when its cache identity changed
    /// (for example after switching stream quality). An identical request is
    /// idempotent; a different request rebuilds the current source first because
    /// rodio cannot remove only the tail of an existing Player queue.
    async fn queue_next_source_replacing(
        &self,
        index: i64,
        source: &str,
        cache_key: Option<String>,
        metadata: Option<NowPlayingMetadata>,
    ) -> Result<(), String> {
        let requested_index = usize::try_from(index).map_err(|_| "无效的曲目序号".to_string())?;
        let replace = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "预排状态锁失败".to_string())?;
            if let Some(queued) = pending.as_ref() {
                let same_identity = queued.index == requested_index
                    && match (&queued.cache_key, &cache_key) {
                        (Some(current), Some(requested)) => current == requested,
                        _ => queued.source == source,
                    };
                if same_identity {
                    return Ok(());
                }
                if queued.started.load(Ordering::SeqCst) {
                    return Err("下一首已经开始交接，请在交接完成后重试".to_string());
                }
                *pending = None;
                true
            } else {
                false
            }
        };
        if replace {
            self.rebuild_after_pending_queue_change().await?;
        }
        self.queue_next_source(index, source, cache_key, metadata)
            .await
    }

    /// Consume a queued source whose gapless handoff has started (the previous
    /// track exhausted and rodio pulled the first sample of the queued one).
    /// Commits it as the current track and returns it so the caller can
    /// publish the `track` event.
    fn consume_started_handoff(&self) -> Option<PendingTrack> {
        let queued = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !pending
                .as_ref()
                .is_some_and(|queued| queued.started.load(Ordering::SeqCst))
            {
                return None;
            }
            pending.take()?
        };
        queued.decode_state.promote_reader_to_current();
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
        if let Ok(mut decode_state) = self.decode_state.lock() {
            *decode_state = Some(Arc::clone(&queued.decode_state));
        }
        self.buffer_paused.store(false, Ordering::SeqCst);
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
        let queue = self
            .queue
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let pending = self.pending.lock().ok().and_then(|guard| {
            guard.as_ref().and_then(|pending| {
                (!pending.started.load(Ordering::SeqCst)).then(|| PendingSourceSnapshot {
                    index: pending.index,
                    source: pending.source.clone(),
                    cache_key: pending.cache_key.clone(),
                    metadata: pending.metadata.clone(),
                })
            })
        });
        PlaybackSnapshot {
            playing: self.desired_playing.load(Ordering::SeqCst) && !self.player().empty(),
            position: self.playback_position_seconds(),
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
            pending,
            queue,
        }
    }

    /// Restore a captured snapshot on a freshly built engine (device switch).
    async fn restore_playback_snapshot(&self, snapshot: &PlaybackSnapshot) -> Result<(), String> {
        if let Ok(mut queue) = self.queue.lock() {
            *queue = snapshot.queue.clone();
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
                self.load_cached(
                    &source.source,
                    source.cache_key.clone(),
                    Some(source.metadata.clone()),
                    snapshot.playing,
                )
                .await?;
            } else {
                self.load_file(&source.source, snapshot.playing)?;
            }
            if snapshot.position > 0.0 {
                let _ = self
                    .player()
                    .try_seek(Duration::from_secs_f64(snapshot.position));
            }
            if !snapshot.playing {
                self.player().pause();
                self.desired_playing.store(false, Ordering::SeqCst);
            }
            if let Some(pending) = snapshot.pending.as_ref() {
                if let Err(error) = self
                    .queue_next_source(
                        pending.index as i64,
                        &pending.source,
                        pending.cache_key.clone(),
                        Some(pending.metadata.clone()),
                    )
                    .await
                {
                    // Current playback recovery is more important than a stale
                    // speculative tail; ordinary queue advance can load it.
                    eprintln!("[原生] 输出设备恢复后重新预排下一首失败：{error}");
                }
            }
        }
        Ok(())
    }

    async fn rebuild_after_pending_queue_change(&self) -> Result<(), String> {
        let snapshot = self.capture_playback_snapshot();
        let generation = self.stop_immediately_and_wait().await?;
        if self.playback_generation.load(Ordering::SeqCst) != generation {
            return Err("播放状态在队列同步期间发生变化".to_string());
        }
        self.restore_playback_snapshot(&snapshot).await
    }

    /// Apply a queue mutation while preserving a still-valid gapless source.
    /// If the appended rodio source no longer matches the native next decision,
    /// rebuild the current player from its media-time snapshot so stale PCM can
    /// never become audible after the queue edit.
    async fn apply_queue_update<F>(&self, app: Option<&AppHandle>, update: F) -> Result<(), String>
    where
        F: FnOnce(&mut QueueState),
    {
        // The output callback can begin a gapless handoff just before a queue
        // mutation reaches Rust. Settle it first so a stale WebView index cannot
        // rebuild or resume the previous track.
        let mut started_handoff = self.consume_started_handoff();
        let rebuild = {
            // Keep this order aligned with the event forwarder and handoff path.
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "预排状态锁失败".to_string())?;
            let mut queue = self
                .queue
                .lock()
                .map_err(|_| "队列状态锁失败".to_string())?;
            update(&mut queue);
            if let Some(queued) = started_handoff.as_mut() {
                if let Some(index) = queue
                    .tracks
                    .iter()
                    .position(|track| track.occurrence_id == queued.occurrence_id)
                {
                    queued.index = index;
                    queue.commit_index(index);
                }
            }
            reconcile_pending_track(&mut pending, &mut queue)
        };
        if rebuild {
            self.rebuild_after_pending_queue_change().await?;
        }
        if let (Some(app), Some(queued)) = (app, started_handoff.as_ref()) {
            publish_started_handoff(self, queued, app);
        }
        Ok(())
    }

    /// Publish sanitized playback progress/ended events to the WebView.
    pub fn start_event_forwarder(self: &Arc<Self>, app: AppHandle) {
        let engine = Arc::clone(self);
        let app_for_task = app.clone();
        let mut last_position = -1.0f64;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut last_now_playing_signature: Option<NowPlayingSignature> = None;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let mut last_now_playing_at: Option<std::time::Instant> = None;
        let mut next_output_recovery_at = std::time::Instant::now();
        let mut output_recovery_delay = Duration::from_secs(1);
        let mut next_default_output_check = std::time::Instant::now();
        let mut output_progress_observation = None;
        let mut last_output_progress_watchdog_poll = std::time::Instant::now();
        // 引擎可能在同步 Tauri 命令（native_queue_set 等）里首次创建，
        // tokio::spawn 在无运行时上下文的主线程会 panic；用 Tauri 全局
        // 运行时可同时兼容同步/异步调用。
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if engine.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let now = std::time::Instant::now();
                if now.saturating_duration_since(last_output_progress_watchdog_poll)
                    >= OUTPUT_PROGRESS_WATCHDOG_RESET_GAP
                {
                    output_progress_observation = None;
                }
                last_output_progress_watchdog_poll = now;
                if now >= next_default_output_check {
                    next_default_output_check = now + DEFAULT_OUTPUT_FOLLOW_INTERVAL;
                    let reconciliation =
                        if let Some(slot) = app_for_task.try_state::<NativeAudioEngineSlot>() {
                            slot.reconcile_system_default_output(&app_for_task, &engine)
                                .await
                        } else {
                            Err("原生引擎状态尚未注册".to_string())
                        };
                    match reconciliation {
                        Ok(true) => {
                            crate::diagnostics::record(
                                "音频",
                                format_args!("system_default_output_changed=recovered"),
                            );
                            // The replacement owns a new forwarder. Do not
                            // publish stale progress from the old route.
                            break;
                        }
                        Ok(false) => {}
                        Err(error) => crate::diagnostics::record(
                            "音频",
                            format_args!("system_default_output_changed=failed error={error}"),
                        ),
                    }
                }
                if engine.output_recovery_pending.load(Ordering::SeqCst)
                    && now >= next_output_recovery_at
                {
                    // Keep the recovery future on Tauri's async runtime; it
                    // rebuilds CPAL without any WebView timer dependency.
                    publish_output_device_recovering(&engine, &app_for_task, "stream-error");
                    let recovery =
                        if let Some(slot) = app_for_task.try_state::<NativeAudioEngineSlot>() {
                            slot.recover_output_stream(&app_for_task, &engine).await
                        } else {
                            Err("原生引擎状态尚未注册".to_string())
                        };
                    match recovery {
                        Ok(Some(device_id)) => {
                            engine
                                .output_recovery_pending
                                .store(false, Ordering::SeqCst);
                            engine
                                .health
                                .output_recoveries
                                .fetch_add(1, Ordering::SeqCst);
                            crate::diagnostics::record(
                                "音频",
                                format_args!(
                                    "output_stream_recovery=success device_id={device_id}"
                                ),
                            );
                            break;
                        }
                        Ok(None) => {
                            engine
                                .output_recovery_pending
                                .store(false, Ordering::SeqCst);
                            break;
                        }
                        Err(error) => {
                            engine
                                .health
                                .output_recovery_failures
                                .fetch_add(1, Ordering::SeqCst);
                            crate::diagnostics::record(
                                "音频",
                                format_args!("output_stream_recovery=failed error={error}"),
                            );
                            next_output_recovery_at = now + output_recovery_delay;
                            output_recovery_delay =
                                (output_recovery_delay * 2).min(Duration::from_secs(30));
                        }
                    }
                }
                let player = engine.player();
                let mut position = engine.playback_position_seconds();
                let active_decode_state = engine
                    .decode_state
                    .lock()
                    .map(|state| state.clone())
                    .unwrap_or(None);
                if let Some(reason) = active_decode_state
                    .as_ref()
                    .and_then(|state| state.reader_failure())
                {
                    let item = current_queue_identity(&engine.queue);
                    publish_playback_error(&engine, item, &reason, &app_for_task);
                    continue;
                }
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
                        position = engine.playback_position_seconds();
                        publish_started_handoff(&engine, &queued, &app_for_task);
                        last_position = position;
                        if player.empty() {
                            publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                            continue;
                        }
                    }
                } else if engine.loaded.load(Ordering::SeqCst) && pending_exists && player.empty() {
                    if let Some(queued) = engine.consume_failed_handoff() {
                        if let Some(reason) = queued.decode_state.reader_failure() {
                            publish_playback_error(
                                &engine,
                                Some((
                                    queued.index,
                                    queued.rating_key.clone(),
                                    queued.occurrence_id.clone(),
                                )),
                                &reason,
                                &app_for_task,
                            );
                        } else {
                            publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                        }
                        continue;
                    }
                }
                let decode_state = engine
                    .decode_state
                    .lock()
                    .map(|state| state.clone())
                    .unwrap_or(None);
                if let Some(decode_state) = decode_state.as_ref() {
                    let desired = engine.desired_playing.load(Ordering::SeqCst);
                    let finished = decode_state.finished.load(Ordering::SeqCst);
                    let buffered_chunks = decode_state.buffered_chunks.load(Ordering::SeqCst);
                    let underflowing = decode_state.underflowing.load(Ordering::SeqCst);
                    if engine.buffer_paused.load(Ordering::SeqCst) {
                        if !desired {
                            engine.buffer_paused.store(false, Ordering::SeqCst);
                            let _ = app_for_task.emit(
                                "native-audio://event",
                                serde_json::json!({ "type": "buffering", "buffering": false }),
                            );
                        } else if decode_state.ready_to_resume() {
                            player.play();
                            engine.buffer_paused.store(false, Ordering::SeqCst);
                            let _ = app_for_task.emit(
                                "native-audio://event",
                                serde_json::json!({ "type": "buffering", "buffering": false }),
                            );
                        }
                    } else if desired
                        && !player.is_paused()
                        && underflowing
                        && buffered_chunks == 0
                        && !finished
                    {
                        player.pause();
                        engine.buffer_paused.store(true, Ordering::SeqCst);
                        eprintln!(
                            "[原生] PCM 缓冲欠载，等待解码线程恢复（累计帧={}）",
                            decode_state.underflow_frames.load(Ordering::SeqCst),
                        );
                        let _ = app_for_task.emit(
                            "native-audio://event",
                            serde_json::json!({ "type": "buffering", "buffering": true }),
                        );
                    }
                }
                if output_progress_watchdog_should_recover(
                    engine.desired_playing.load(Ordering::SeqCst),
                    !player.empty(),
                    engine.buffer_paused.load(Ordering::SeqCst),
                    decode_state
                        .as_ref()
                        .map(|state| state.output_media_frames.load(Ordering::SeqCst)),
                    &mut output_progress_observation,
                    now,
                ) && !engine.output_recovery_pending.swap(true, Ordering::SeqCst)
                {
                    publish_output_device_recovering(
                        &engine,
                        &app_for_task,
                        "output-progress-stalled",
                    );
                    crate::diagnostics::record(
                        "音频",
                        format_args!(
                            "output_progress_stalled=detected timeout_seconds={}",
                            OUTPUT_PROGRESS_STALL_TIMEOUT.as_secs()
                        ),
                    );
                }
                if output_has_started(
                    engine.desired_playing.load(Ordering::SeqCst),
                    !player.empty(),
                    decode_state.as_ref(),
                    engine.playback_start_frame.load(Ordering::SeqCst),
                ) && !engine.playback_started.swap(true, Ordering::SeqCst)
                {
                    let item = current_queue_identity(&engine.queue);
                    let _ = app_for_task.emit(
                        "native-audio://event",
                        serde_json::json!({
                            "type": "playback-started",
                            "index": item.as_ref().map(|(index, _, _)| *index),
                            "ratingKey": item.as_ref().map(|(_, rating_key, _)| rating_key),
                            "occurrenceId": item.as_ref().map(|(_, _, occurrence_id)| occurrence_id),
                            "position": position,
                        }),
                    );
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
                    } else if !engine.desired_playing.load(Ordering::SeqCst)
                        || !engine.playback_started.load(Ordering::SeqCst)
                    {
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
                        let navigation = engine
                            .queue
                            .lock()
                            .map(|queue| queue.remote_navigation_availability())
                            .unwrap_or((false, false));
                        let signature = (
                            meta.clone(),
                            duration_value.map(f64::to_bits),
                            playback_state,
                            artwork_identity,
                            navigation,
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
                                navigation.0,
                                navigation.1,
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
                    engine.desired_playing.store(false, Ordering::SeqCst);
                    publish_natural_ended(&engine.queue, &engine.ended_sent, &app_for_task);
                    continue;
                }
                // Visible-window safety guard: require the exact same stale
                // heartbeat to survive a second full timeout. Hidden playback
                // remains native and independent from WebView timer throttling;
                // system sleep also gets a full recovery window after resume.
                let last_heartbeat = engine
                    .last_heartbeat
                    .lock()
                    .map(|heartbeat| *heartbeat)
                    .unwrap_or(None);
                let now = std::time::Instant::now();
                let heartbeat_is_stale = last_heartbeat
                    .is_some_and(|at| now.saturating_duration_since(at) >= HEARTBEAT_STALL_TIMEOUT);
                let renderer_visible = if heartbeat_is_stale {
                    app_for_task
                        .get_webview_window("main")
                        .and_then(|window| {
                            Some(renderer_requires_heartbeat(
                                window.is_visible().ok()?,
                                window.is_minimized().ok()?,
                            ))
                        })
                        .unwrap_or(true)
                } else {
                    true
                };
                let heartbeat_lost = engine
                    .heartbeat_stale_observation
                    .lock()
                    .map(|mut observation| {
                        heartbeat_watchdog_should_stop(
                            last_heartbeat,
                            &mut observation,
                            renderer_visible,
                            now,
                        )
                    })
                    .unwrap_or(false);
                let audibly_playing =
                    engine.desired_playing.load(Ordering::SeqCst) && !player.empty();
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
    pub is_buffering: bool,
    pub position_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub volume: f32,
    pub item_count: usize,
    pub current_index: Option<usize>,
    pub buffered_chunks: usize,
    pub buffer_capacity: usize,
    pub underflow_events: u64,
    pub underflow_frames: u64,
    pub output_stream_errors: u64,
    pub output_recoveries: u64,
    pub output_recovery_failures: u64,
    pub output_recovery_pending: bool,
}

#[derive(Serialize)]
pub struct NativeOutputDevice {
    pub device_id: String,
    pub label: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn native_audio_output_devices() -> Result<Vec<NativeOutputDevice>, String> {
    if cfg!(target_os = "macos") {
        return Ok(vec![NativeOutputDevice {
            device_id: String::new(),
            label: "系统默认".to_string(),
            is_default: true,
        }]);
    }
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut devices = vec![NativeOutputDevice {
        device_id: String::new(),
        label: "系统默认".to_string(),
        is_default: true,
    }];
    devices.extend(
        host.output_devices()
            .map_err(|e| format!("枚举输出设备失败: {e}"))?
            .filter_map(|device| {
                let name = device.description().ok()?.name().to_string();
                let id = device.id().ok()?.to_string();
                Some(NativeOutputDevice {
                    device_id: id,
                    label: name,
                    is_default: false,
                })
            }),
    );
    Ok(devices)
}

#[tauri::command]
pub async fn native_audio_set_output_device(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    device_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = device_id;
    #[cfg(target_os = "macos")]
    let device_id = String::new();
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
    pub partial_size_bytes: u64,
    pub partial_file_count: usize,
    pub limit_bytes: u64,
}

fn validate_now_playing_metadata(
    proxy: &crate::stream_proxy::StreamProxy,
    metadata: Option<NowPlayingMetadata>,
) -> Result<Option<NowPlayingMetadata>, String> {
    let Some(mut metadata) = metadata else {
        return Ok(None);
    };
    if metadata.duration_ms == Some(0) {
        metadata.duration_ms = None;
    }
    if let Some(artwork_url) = metadata.artwork_url.as_deref() {
        if artwork_url.is_empty() {
            metadata.artwork_url = None;
        } else if !proxy.owns_artwork_url(artwork_url) {
            return Err("封面地址不是当前 Cadilume 本机票据".to_string());
        }
    }
    Ok(Some(metadata))
}

#[tauri::command]
pub fn native_audio_cache_status(
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> NativeCacheStatus {
    let usage = state.segment_cache_status();
    NativeCacheStatus {
        size_bytes: usage.allocated_bytes,
        file_count: usage.complete_entries,
        partial_size_bytes: usage.partial_bytes,
        partial_file_count: usage.partial_entries,
        limit_bytes: state.cache_limit_bytes(),
    }
}

#[tauri::command]
pub async fn native_audio_clear_cache(
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    state.reset_and_clear_cache().await
}

#[tauri::command]
pub async fn native_audio_clear_queue(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let _operation = state.output_switch_lock.lock().await;
    if let Some(engine) = state.current() {
        engine.clear_session_state_and_wait().await?;
        let _ = app.emit(
            "native-audio://event",
            serde_json::json!({ "type": "buffering", "buffering": false }),
        );
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    crate::now_playing::clear();
    Ok(())
}

#[tauri::command]
pub async fn native_audio_load(
    app: AppHandle,
    audio_state: tauri::State<'_, NativeAudioEngineSlot>,
    stream_proxy: tauri::State<'_, crate::stream_proxy::StreamProxy>,
    source: String,
    cache_key: Option<String>,
    metadata: Option<NowPlayingMetadata>,
    autoplay: Option<bool>,
) -> Result<usize, String> {
    if !stream_proxy.owns_audio_url(&source) {
        return Err("音频地址不是当前 Cadilume 本机票据".to_string());
    }
    let metadata = validate_now_playing_metadata(&stream_proxy, metadata)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        // System media frameworks are optional for the first frame. Register
        // them only when the user actually starts native playback, keeping
        // AppKit/SMTC work off the startup path.
        let media_handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::now_playing::install(media_handle));
    }
    let _operation = audio_state.output_switch_lock.lock().await;
    let engine = audio_state.ensure(&app)?;
    engine
        .load_cached(&source, cache_key, metadata, autoplay.unwrap_or(true))
        .await
}

#[tauri::command]
pub async fn native_audio_warmup(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let _operation = state.output_switch_lock.lock().await;
    if state.current().is_none() {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = worker_app.state::<NativeAudioEngineSlot>();
            state.ensure(&worker_app).map(|_| ())
        })
        .await
        .map_err(|error| format!("播放器预热任务失败: {error}"))??;
    }
    crate::diagnostics::record(
        "启动",
        format_args!(
            "native_audio=ready elapsed_ms={}",
            started.elapsed().as_millis()
        ),
    );
    Ok(())
}

#[tauri::command]
pub async fn native_audio_queue_next_source(
    app: AppHandle,
    audio_state: tauri::State<'_, NativeAudioEngineSlot>,
    stream_proxy: tauri::State<'_, crate::stream_proxy::StreamProxy>,
    index: i64,
    source: String,
    cache_key: Option<String>,
    metadata: Option<NowPlayingMetadata>,
) -> Result<(), String> {
    if !stream_proxy.owns_audio_url(&source) {
        return Err("音频地址不是当前 Cadilume 本机票据".to_string());
    }
    let metadata = validate_now_playing_metadata(&stream_proxy, metadata)?;
    let engine = {
        let _operation = audio_state.output_switch_lock.lock().await;
        audio_state.ensure(&app)?
    };
    engine
        .queue_next_source_replacing(index, &source, cache_key, metadata)
        .await
}

#[tauri::command]
pub async fn native_audio_play(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    // Serialize playback controls with device replacement so a command issued
    // during engine construction is applied to the newly installed engine.
    let _operation = state.output_switch_lock.lock().await;
    let engine = state
        .current()
        .ok_or_else(|| "当前没有可恢复的播放".to_string())?;
    engine.require_fresh_pcm_confirmation();
    engine.desired_playing.store(true, Ordering::SeqCst);
    engine.player().play();
    Ok(())
}

#[tauri::command]
pub async fn native_audio_pause(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let _operation = state.output_switch_lock.lock().await;
    if let Some(engine) = state.current() {
        engine.desired_playing.store(false, Ordering::SeqCst);
        if engine.buffer_paused.swap(false, Ordering::SeqCst) {
            let _ = app.emit(
                "native-audio://event",
                serde_json::json!({ "type": "buffering", "buffering": false }),
            );
        }
        engine.player().pause();
    }
    Ok(())
}

#[tauri::command]
pub async fn native_audio_stop(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    let _operation = state.output_switch_lock.lock().await;
    if let Some(engine) = state.current() {
        engine.stop_immediately();
        let _ = app.emit(
            "native-audio://event",
            serde_json::json!({ "type": "buffering", "buffering": false }),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn native_audio_heartbeat(app: AppHandle, state: tauri::State<'_, NativeAudioEngineSlot>) {
    let _ = app;
    // This command is emitted once per second from the visible WebView and can
    // execute on the AppKit message path. Never wait for a background warmup
    // or device replacement that currently owns the engine slot mutex.
    if let Some(engine) = state.try_current() {
        if let Ok(mut heartbeat) = engine.last_heartbeat.lock() {
            *heartbeat = Some(std::time::Instant::now());
        }
        if let Ok(mut observation) = engine.heartbeat_stale_observation.lock() {
            *observation = None;
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
    if !seconds.is_finite() {
        return Err("定位时间必须是有限数字".to_string());
    }
    let position = Duration::try_from_secs_f64(seconds.max(0.0))
        .map_err(|_| "定位时间必须是有限数字".to_string())?;
    let _operation = state.output_switch_lock.lock().await;
    let player = state
        .current()
        .ok_or_else(|| "当前没有可定位的播放".to_string())?
        .player();
    tauri::async_runtime::spawn_blocking(move || {
        player.try_seek(position).map_err(|error| error.to_string())
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
pub fn native_audio_set_artwork(
    state: tauri::State<'_, NativeAudioEngineSlot>,
    stream_proxy: tauri::State<'_, crate::stream_proxy::StreamProxy>,
    index: i64,
    rating_key: String,
    occurrence_id: String,
    artwork_url: String,
) -> Result<(), String> {
    if artwork_url.is_empty() || !stream_proxy.owns_artwork_url(&artwork_url) {
        return Err("封面地址不是当前 Cadilume 本机票据".to_string());
    }
    state
        .current()
        .ok_or_else(|| "当前没有可更新的播放".to_string())?
        .set_artwork_for_track(index, &rating_key, &occurrence_id, artwork_url)
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
            is_buffering: false,
            position_seconds: None,
            duration_seconds: None,
            volume: state.volume(),
            item_count: 0,
            current_index: None,
            buffered_chunks: 0,
            buffer_capacity: 0,
            underflow_events: state.health.underflow_events.load(Ordering::SeqCst),
            underflow_frames: state.health.underflow_frames.load(Ordering::SeqCst),
            output_stream_errors: state.health.output_stream_errors.load(Ordering::SeqCst),
            output_recoveries: state.health.output_recoveries.load(Ordering::SeqCst),
            output_recovery_failures: state.health.output_recovery_failures.load(Ordering::SeqCst),
            output_recovery_pending: false,
        };
    };
    let player = engine.player();
    let decode_state = engine
        .decode_state
        .lock()
        .ok()
        .and_then(|state| state.clone());
    NativeStatus {
        is_playing: !player.empty()
            && engine.desired_playing.load(Ordering::SeqCst)
            && engine.playback_started.load(Ordering::SeqCst),
        is_buffering: engine.buffer_paused.load(Ordering::SeqCst),
        position_seconds: Some(engine.playback_position_seconds()),
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
        buffered_chunks: decode_state
            .as_ref()
            .map(|state| state.buffered_chunks.load(Ordering::SeqCst))
            .unwrap_or(0),
        buffer_capacity: decode_state
            .as_ref()
            .map(|state| state.buffer_capacity)
            .unwrap_or(0),
        underflow_events: state.health.underflow_events.load(Ordering::SeqCst),
        underflow_frames: state.health.underflow_frames.load(Ordering::SeqCst),
        output_stream_errors: state.health.output_stream_errors.load(Ordering::SeqCst),
        output_recoveries: state.health.output_recoveries.load(Ordering::SeqCst),
        output_recovery_failures: state.health.output_recovery_failures.load(Ordering::SeqCst),
        output_recovery_pending: engine.output_recovery_pending.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub async fn native_queue_set(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    tracks: Vec<QueueTrack>,
    current_index: i64,
    repeat: NativeRepeatMode,
    shuffle: bool,
) -> Result<(), String> {
    let _operation = state.output_switch_lock.lock().await;
    let engine = state.ensure(&app)?;
    engine
        .apply_queue_update(Some(&app), move |queue| {
            queue.resync(tracks, current_index, repeat, shuffle);
        })
        .await
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
pub fn native_queue_peek_next(
    _app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    natural_ended: Option<bool>,
) -> Result<Option<usize>, String> {
    // Peeking is a read-only queue operation. Do not create an output stream
    // merely because a restored paused queue has a next item; CoreAudio must
    // remain untouched until the user starts playback.
    state.peek_next(natural_ended.unwrap_or(true))
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
pub async fn native_queue_set_repeat(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    repeat: NativeRepeatMode,
) -> Result<(), String> {
    let _operation = state.output_switch_lock.lock().await;
    let engine = state.ensure(&app)?;
    engine
        .apply_queue_update(Some(&app), move |queue| queue.repeat = repeat)
        .await
}

#[tauri::command]
pub async fn native_queue_set_shuffle(
    app: AppHandle,
    state: tauri::State<'_, NativeAudioEngineSlot>,
    shuffle: bool,
) -> Result<(), String> {
    let _operation = state.output_switch_lock.lock().await;
    let engine = state.ensure(&app)?;
    engine
        .apply_queue_update(Some(&app), move |queue| {
            if queue.shuffle == shuffle {
                return;
            }
            queue.shuffle = shuffle;
            queue.bag.clear();
            queue.shuffle_initialized = false;
            queue.history.clear();
            queue.history_cursor = None;
        })
        .await
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

    fn unique_temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cadilume-{label}-{}", uuid::Uuid::new_v4()))
    }

    struct StallingSource {
        initial_samples: usize,
        stalled_once: bool,
    }

    impl Iterator for StallingSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            if self.initial_samples > 0 {
                self.initial_samples -= 1;
                return Some(0.25);
            }
            if !self.stalled_once {
                self.stalled_once = true;
                std::thread::sleep(Duration::from_millis(300));
                return Some(0.5);
            }
            None
        }
    }

    impl Source for StallingSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }

        fn channels(&self) -> rodio::ChannelCount {
            std::num::NonZeroU16::new(1).unwrap()
        }

        fn sample_rate(&self) -> rodio::SampleRate {
            std::num::NonZeroU32::new(48_000).unwrap()
        }

        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs(1))
        }
    }

    struct EndlessSource;

    impl Iterator for EndlessSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            Some(0.125)
        }
    }

    impl Source for EndlessSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }

        fn channels(&self) -> rodio::ChannelCount {
            std::num::NonZeroU16::new(2).unwrap()
        }

        fn sample_rate(&self) -> rodio::SampleRate {
            std::num::NonZeroU32::new(48_000).unwrap()
        }

        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    struct SeekableLowRateSource;

    impl Iterator for SeekableLowRateSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            Some(0.125)
        }
    }

    impl Source for SeekableLowRateSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }

        fn channels(&self) -> rodio::ChannelCount {
            std::num::NonZeroU16::new(2).unwrap()
        }

        fn sample_rate(&self) -> rodio::SampleRate {
            std::num::NonZeroU32::new(8_000).unwrap()
        }

        fn total_duration(&self) -> Option<Duration> {
            None
        }

        fn try_seek(&mut self, _pos: Duration) -> Result<(), SeekError> {
            Ok(())
        }
    }

    struct FiniteConstantSource {
        remaining_samples: usize,
        channels: rodio::ChannelCount,
        sample_rate: rodio::SampleRate,
        sample: f32,
    }

    impl Iterator for FiniteConstantSource {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            if self.remaining_samples == 0 {
                return None;
            }
            self.remaining_samples -= 1;
            Some(self.sample)
        }
    }

    impl Source for FiniteConstantSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }

        fn channels(&self) -> rodio::ChannelCount {
            self.channels
        }

        fn sample_rate(&self) -> rodio::SampleRate {
            self.sample_rate
        }

        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs_f64(
                self.remaining_samples as f64
                    / self.channels.get() as f64
                    / self.sample_rate.get() as f64,
            ))
        }
    }

    #[test]
    fn player_mixer_preserves_44100_media_duration_at_48000_output() {
        const SOURCE_RATE: u32 = 44_100;
        const OUTPUT_RATE: u32 = 48_000;
        const CHANNELS: u16 = 2;
        let channels = std::num::NonZeroU16::new(CHANNELS).unwrap();
        let source_rate = std::num::NonZeroU32::new(SOURCE_RATE).unwrap();
        let output_rate = std::num::NonZeroU32::new(OUTPUT_RATE).unwrap();
        let (source, state) = spawn_threaded_decoder_for_output(
            FiniteConstantSource {
                remaining_samples: SOURCE_RATE as usize * CHANNELS as usize,
                channels,
                sample_rate: source_rate,
                sample: 0.25,
            },
            channels,
            output_rate,
            None,
            Arc::new(NativeAudioHealth::default()),
        )
        .unwrap();
        let decode_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !state.finished.load(Ordering::SeqCst) && std::time::Instant::now() < decode_deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(state.finished.load(Ordering::SeqCst));

        let (mixer, mut output) = rodio::mixer::mixer(channels, output_rate);
        let player = Player::connect_new(&mixer);
        player.append(source);
        let probe_samples = OUTPUT_RATE as usize * CHANNELS as usize * 2;
        let mut last_media_sample = None;
        for sample_index in 0..probe_samples {
            if output.next().is_some_and(|sample| sample.abs() > 0.01) {
                last_media_sample = Some(sample_index);
            }
        }
        let emitted_media_samples = last_media_sample.map_or(0, |index| index + 1);
        let expected_samples = OUTPUT_RATE as usize * CHANNELS as usize;
        let difference = emitted_media_samples.abs_diff(expected_samples);

        assert!(
            difference <= 512,
            "1 秒 44.1 kHz 媒体经 48 kHz 输出后应仍接近 1 秒：实际 {emitted_media_samples} samples，期望 {expected_samples}"
        );
    }

    #[test]
    fn player_queue_rebuilds_resampling_across_48000_to_44100_handoff() {
        const OUTPUT_RATE: u32 = 48_000;
        const CHANNELS: u16 = 2;
        let channels = std::num::NonZeroU16::new(CHANNELS).unwrap();
        let output_rate = std::num::NonZeroU32::new(OUTPUT_RATE).unwrap();
        let prepare = |sample_rate: u32, sample: f32| {
            let (source, state) = spawn_threaded_decoder_for_output(
                FiniteConstantSource {
                    remaining_samples: sample_rate as usize * CHANNELS as usize,
                    channels,
                    sample_rate: std::num::NonZeroU32::new(sample_rate).unwrap(),
                    sample,
                },
                channels,
                output_rate,
                None,
                Arc::new(NativeAudioHealth::default()),
            )
            .unwrap();
            let decode_deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !state.finished.load(Ordering::SeqCst)
                && std::time::Instant::now() < decode_deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(state.finished.load(Ordering::SeqCst));
            source
        };
        let source_48000 = prepare(48_000, 0.5);
        let source_44100 = prepare(44_100, 0.25);
        let (mixer, mut output) = rodio::mixer::mixer(channels, output_rate);
        let player = Player::connect_new(&mixer);
        player.append(source_48000);
        player.append(source_44100);

        let probe_samples = OUTPUT_RATE as usize * CHANNELS as usize * 3;
        let mut second_track_samples = 0usize;
        for _ in 0..probe_samples {
            if output
                .next()
                .is_some_and(|sample| (sample - 0.25).abs() < 0.01)
            {
                second_track_samples += 1;
            }
        }
        let expected_samples = OUTPUT_RATE as usize * CHANNELS as usize;
        let difference = second_track_samples.abs_diff(expected_samples);

        assert!(
            difference <= 1_024,
            "48 kHz 后续接 44.1 kHz 曲目时必须为后者独立重采样：实际 {second_track_samples} samples，期望 {expected_samples}"
        );
    }

    #[test]
    fn decoder_worker_keeps_realtime_source_nonblocking_during_stall() {
        let (mut source, state) = spawn_threaded_decoder(StallingSource {
            initial_samples: DECODE_CHUNK_FRAMES,
            stalled_once: false,
        })
        .unwrap();
        for _ in 0..DECODE_CHUNK_FRAMES {
            assert_eq!(source.next(), Some(0.25));
        }
        let media_position_before_stall = state.position_seconds();

        let started = std::time::Instant::now();
        for _ in 0..4_096 {
            assert_eq!(source.next(), Some(0.0));
        }
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "实时 Source 不得等待解码线程，实际 {:?}",
            started.elapsed()
        );
        assert!(state.underflowing.load(Ordering::SeqCst));
        assert!(state.underflow_frames.load(Ordering::SeqCst) > 0);
        assert_eq!(
            state.health.underflow_events.load(Ordering::SeqCst),
            1,
            "一次连续欠载只能累计一个事件"
        );
        assert_eq!(
            state.health.underflow_frames.load(Ordering::SeqCst),
            state.underflow_frames.load(Ordering::SeqCst),
            "进程级健康计数必须覆盖解码器欠载帧"
        );
        assert_eq!(
            state.position_seconds(),
            media_position_before_stall,
            "欠载静音不得推进媒体时间轴"
        );

        // The decoder intentionally sleeps for 300 ms, but a loaded CI runner
        // may not schedule it again within an arbitrary extra 50 ms. Poll the
        // non-blocking Source up to a bounded deadline so this assertion tests
        // recovery semantics instead of scheduler timing.
        let recovery_deadline = std::time::Instant::now() + Duration::from_secs(2);
        let recovered_sample = loop {
            match source.next() {
                Some(0.0) if std::time::Instant::now() < recovery_deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                sample => break sample,
            }
        };
        assert_eq!(recovered_sample, Some(0.5), "解码恢复后应继续输出真实 PCM");
    }

    #[test]
    fn threaded_source_seek_admission_is_nonblocking() {
        let (mut source, _) = spawn_threaded_decoder(StallingSource {
            initial_samples: DECODE_CHUNK_FRAMES,
            stalled_once: false,
        })
        .unwrap();
        let started = std::time::Instant::now();
        source.try_seek(Duration::from_millis(500)).unwrap();
        assert!(started.elapsed() < Duration::from_millis(20));
    }

    #[test]
    fn decoder_worker_pcm_queue_is_bounded_and_uses_a_resume_watermark() {
        let (mut source, state) = spawn_threaded_decoder(EndlessSource).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while state.buffered_chunks.load(Ordering::SeqCst) < state.buffer_capacity
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        let buffered = state.buffered_chunks.load(Ordering::SeqCst);
        assert_eq!(
            buffered, state.buffer_capacity,
            "worker 应在有界队列满时背压"
        );
        assert!(
            state.resume_chunks > 1,
            "欠载恢复不能只等待一个短 PCM chunk"
        );
        assert!(state.ready_to_resume());

        let chunk_samples = DECODE_CHUNK_FRAMES * source.channels().get() as usize;
        for _ in 0..(state.buffer_capacity + 16) {
            let ready_deadline = std::time::Instant::now() + Duration::from_secs(1);
            while state.buffered_chunks.load(Ordering::SeqCst) == 0
                && std::time::Instant::now() < ready_deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(state.buffered_chunks.load(Ordering::SeqCst) > 0);
            for _ in 0..chunk_samples {
                assert!(source.next().is_some());
            }
        }
        assert!(
            state.allocated_chunks.load(Ordering::SeqCst) <= state.buffer_capacity + 1,
            "steady-state PCM must reuse the bounded chunk pool"
        );

        drop(source);
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while !state.worker_exited.load(Ordering::SeqCst)
            && std::time::Instant::now() < exit_deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(state.worker_exited.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn current_source_waits_for_full_prefill_before_append() {
        let cache_root = unique_temp_path("initial-pcm-watermark-cache");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        let state = Arc::new(DecodeBufferState::new(
            std::num::NonZeroU32::new(48_000).unwrap(),
            32,
            None,
            Arc::new(NativeAudioHealth::default()),
        ));
        let generation = engine.playback_generation.load(Ordering::SeqCst);

        let early = tokio::time::timeout(
            Duration::from_millis(60),
            engine.wait_for_decode_buffer_ready(
                &state,
                generation,
                tokio::time::Instant::now() + Duration::from_secs(1),
                "当前曲目",
            ),
        )
        .await;
        assert!(early.is_err(), "单个短 PCM chunk 不能提前放行当前曲目");

        state
            .buffered_chunks
            .store(state.resume_chunks, Ordering::SeqCst);
        let resume_only = tokio::time::timeout(
            Duration::from_millis(60),
            engine.wait_for_decode_buffer_ready(
                &state,
                generation,
                tokio::time::Instant::now() + Duration::from_secs(1),
                "当前曲目",
            ),
        )
        .await;
        assert!(
            resume_only.is_err(),
            "运行中恢复水位不能作为首次播放预填充水位"
        );

        state
            .buffered_chunks
            .store(state.buffer_capacity, Ordering::SeqCst);
        engine
            .wait_for_decode_buffer_ready(
                &state,
                generation,
                tokio::time::Instant::now() + Duration::from_millis(100),
                "当前曲目",
            )
            .await
            .expect("达到恢复水位后应允许 append");

        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[test]
    fn decoder_worker_reuses_the_bounded_chunk_pool_across_seek_storms() {
        let (mut source, state) = spawn_threaded_decoder(SeekableLowRateSource).unwrap();
        for seek_index in 0..48u64 {
            let fill_deadline = std::time::Instant::now() + Duration::from_secs(1);
            while state.buffered_chunks.load(Ordering::SeqCst)
                < state.buffer_capacity.saturating_sub(1)
                && std::time::Instant::now() < fill_deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(source.next().is_some(), "seek 前应能取得新的 current chunk");
            while state.buffered_chunks.load(Ordering::SeqCst) < state.buffer_capacity
                && std::time::Instant::now() < fill_deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                state.buffered_chunks.load(Ordering::SeqCst),
                state.buffer_capacity,
                "每次 seek 前解码队列都应重新填满"
            );
            source
                .try_seek(Duration::from_millis(seek_index * 17))
                .unwrap();
        }
        let allocated_chunks = state.allocated_chunks.load(Ordering::SeqCst);
        assert!(
            allocated_chunks <= state.buffer_capacity + 1,
            "seek storm must reuse superseded worker buffers instead of reallocating: allocated {allocated_chunks}, limit {}",
            state.buffer_capacity + 1,
        );

        drop(source);
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while !state.worker_exited.load(Ordering::SeqCst)
            && std::time::Instant::now() < exit_deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(state.worker_exited.load(Ordering::SeqCst));
    }

    #[test]
    fn heartbeat_watchdog_requires_visible_two_phase_staleness() {
        let base = std::time::Instant::now();
        let heartbeat = base;
        let first_check = base + HEARTBEAT_STALL_TIMEOUT;
        let mut observation = None;
        assert!(!heartbeat_watchdog_should_stop(
            Some(heartbeat),
            &mut observation,
            true,
            first_check,
        ));
        assert!(!heartbeat_watchdog_should_stop(
            Some(heartbeat),
            &mut observation,
            false,
            first_check + HEARTBEAT_STALL_CONFIRMATION,
        ));
        assert!(observation.is_none(), "隐藏窗口必须解除失联观察");
        assert!(!heartbeat_watchdog_should_stop(
            Some(heartbeat),
            &mut observation,
            true,
            first_check,
        ));
        assert!(heartbeat_watchdog_should_stop(
            Some(heartbeat),
            &mut observation,
            true,
            first_check + HEARTBEAT_STALL_CONFIRMATION,
        ));
        assert!(renderer_requires_heartbeat(true, false));
        assert!(!renderer_requires_heartbeat(true, true));
        assert!(!renderer_requires_heartbeat(false, false));
        let recovered = first_check + Duration::from_secs(1);
        assert!(!heartbeat_watchdog_should_stop(
            Some(recovered),
            &mut observation,
            true,
            first_check + HEARTBEAT_STALL_CONFIRMATION + Duration::from_millis(1),
        ));
    }

    #[test]
    fn output_stream_errors_are_latched_for_async_recovery() {
        let health = NativeAudioHealth::default();
        let failed_stream = AtomicBool::new(false);
        let healthy_stream = AtomicBool::new(false);
        health.record_output_stream_error(&failed_stream);
        health.record_output_stream_error(&failed_stream);
        assert_eq!(health.output_stream_errors.load(Ordering::SeqCst), 2);
        assert!(failed_stream.load(Ordering::SeqCst));
        assert!(
            !healthy_stream.load(Ordering::SeqCst),
            "旧输出流错误不能把新输出流标记为待恢复"
        );
    }

    #[test]
    fn output_progress_watchdog_recovers_only_after_sustained_silence() {
        let base = std::time::Instant::now();
        let mut observation = None;
        assert!(!output_progress_watchdog_should_recover(
            true,
            true,
            false,
            Some(24),
            &mut observation,
            base,
        ));
        assert!(!output_progress_watchdog_should_recover(
            true,
            true,
            false,
            Some(24),
            &mut observation,
            base + OUTPUT_PROGRESS_STALL_TIMEOUT - Duration::from_millis(1),
        ));
        assert!(output_progress_watchdog_should_recover(
            true,
            true,
            false,
            Some(24),
            &mut observation,
            base + OUTPUT_PROGRESS_STALL_TIMEOUT,
        ));
        assert!(!output_progress_watchdog_should_recover(
            true,
            true,
            false,
            Some(25),
            &mut observation,
            base + OUTPUT_PROGRESS_STALL_TIMEOUT,
        ));
        assert!(!output_progress_watchdog_should_recover(
            true,
            true,
            true,
            Some(25),
            &mut observation,
            base + OUTPUT_PROGRESS_STALL_TIMEOUT * 2,
        ));
        assert!(observation.is_none(), "缓冲期间不能触发输出流重建");
    }

    #[test]
    fn automatic_route_only_rebuilds_when_the_system_default_changes() {
        assert!(!should_rebuild_for_system_default(
            true,
            Some("a"),
            Some("a")
        ));
        assert!(should_rebuild_for_system_default(
            true,
            Some("a"),
            Some("b")
        ));
        assert!(should_rebuild_for_system_default(true, None, Some("b")));
        assert!(!should_rebuild_for_system_default(
            false,
            Some("a"),
            Some("b")
        ));
        assert!(!should_rebuild_for_system_default(true, Some("a"), None));
    }

    #[test]
    fn playback_waits_for_pcm_to_reach_the_output_callback() {
        let state = Arc::new(DecodeBufferState::new(
            std::num::NonZeroU32::new(48_000).unwrap(),
            8,
            None,
            Arc::new(NativeAudioHealth::default()),
        ));
        assert!(!output_has_started(true, true, Some(&state), 0));
        assert!(!output_has_started(false, true, Some(&state), 0));
        assert!(!output_has_started(true, false, Some(&state), 0));
        state.output_media_frames.store(1, Ordering::SeqCst);
        assert!(output_has_started(true, true, Some(&state), 0));
        assert!(!output_has_started(true, true, Some(&state), 1));
        state.output_media_frames.store(2, Ordering::SeqCst);
        assert!(output_has_started(true, true, Some(&state), 1));
    }

    #[test]
    fn now_playing_metadata_accepts_frontend_camel_case_artwork_url() {
        let metadata: NowPlayingMetadata = serde_json::from_value(serde_json::json!({
            "title": "Track",
            "artist": "Artist",
            "album": "Album",
            "durationMs": 180000,
            "artworkUrl": "http://127.0.0.1:1234/artwork/ticket"
        }))
        .unwrap();
        assert_eq!(
            metadata.artwork_url.as_deref(),
            Some("http://127.0.0.1:1234/artwork/ticket")
        );
        assert_eq!(metadata.duration_ms, Some(180_000));
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
                .load_file_for_generation(
                    wav.to_str().unwrap(),
                    stale_generation,
                    source.clone(),
                    true,
                )
                .is_err(),
            "旧代加载不能反写播放器"
        );
        engine
            .load_file_for_generation(wav.to_str().unwrap(), latest_generation, source, true)
            .expect("最后一代应能加载");
        assert!(engine.loaded.load(Ordering::SeqCst));
        engine.stop_immediately();
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn rapid_local_load_stop_stress_keeps_latest_decoder_generation() {
        let cache_root = unique_temp_path("decoder-load-stress-cache");
        let wav = unique_temp_path("decoder-load-stress.wav");
        write_test_wav_of_seconds(&wav, 1);
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        let started = std::time::Instant::now();
        let mut decoder_states = Vec::with_capacity(160);

        for iteration in 0..160 {
            engine
                .load_and_play(wav.to_str().unwrap())
                .expect("高频加载应始终产生首个 PCM 缓冲");
            if iteration % 20 == 0 {
                engine
                    .player()
                    .try_seek(Duration::from_millis(250))
                    .expect("高频加载中的 seek 应被受理");
            }
            decoder_states.push(
                engine
                    .decode_state
                    .lock()
                    .unwrap()
                    .as_ref()
                    .cloned()
                    .expect("加载后应记录解码 worker"),
            );
            engine.stop_immediately();
        }

        assert!(
            started.elapsed() < Duration::from_secs(15),
            "160 次加载/停止不应出现解码线程堆积，实际 {:?}",
            started.elapsed()
        );
        assert!(!engine.loaded.load(Ordering::SeqCst));
        assert!(engine.decode_state.lock().unwrap().is_none());
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while decoder_states
            .iter()
            .any(|state| !state.worker_exited.load(Ordering::SeqCst))
            && std::time::Instant::now() < exit_deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            decoder_states
                .iter()
                .all(|state| state.worker_exited.load(Ordering::SeqCst)),
            "160 个被替换的解码 worker 都必须在有界时间内退出"
        );
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn stop_and_wait_returns_after_current_decoder_worker_exits() {
        let cache_root = unique_temp_path("decoder-stop-wait-cache");
        let wav = unique_temp_path("decoder-stop-wait.wav");
        write_test_wav_of_seconds(&wav, 10);
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        engine
            .load_and_play(wav.to_str().unwrap())
            .expect("长音频应启动 decoder worker");
        let state = engine
            .decode_state
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .expect("加载后应记录 decoder worker");
        assert!(
            !state.worker_exited.load(Ordering::SeqCst),
            "有界 PCM 队列应让长音频 decoder 在停止前保持活动"
        );

        let generation = engine
            .stop_immediately_and_wait()
            .await
            .expect("等待式停止应在超时前完成");

        assert_eq!(
            engine.playback_generation.load(Ordering::SeqCst),
            generation
        );
        assert!(state.worker_exited.load(Ordering::SeqCst));
        assert_eq!(engine.segment_cache.active_operations(), 0);
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
    async fn paused_load_never_advances_before_explicit_play() {
        let wav = unique_temp_path("paused-load.wav");
        let cache_root = unique_temp_path("paused-load-cache");
        write_test_wav(&wav);
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);

        engine.load_file(wav.to_str().unwrap(), false).unwrap();
        assert!(engine.player().is_paused());
        assert!(!engine.desired_playing.load(Ordering::SeqCst));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(engine.playback_position_seconds(), 0.0);

        engine.stop_immediately();
        let _ = std::fs::remove_file(wav);
        let _ = std::fs::remove_dir_all(cache_root);
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
    async fn no_range_http_fallback_downloads_then_plays() {
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
        let status = engine.segment_cache.status();
        assert_eq!(status.complete_entries, 1, "连续兼容下载应完整落盘");
        engine.stop_immediately();
        let _ = std::fs::remove_dir_all(cache_root);
    }

    fn queue_track(key: &str) -> QueueTrack {
        QueueTrack {
            rating_key: key.to_string(),
            occurrence_id: format!("occurrence-{key}"),
            title: key.to_string(),
            artist: String::new(),
            album: String::new(),
        }
    }

    fn pending_track(index: usize, rating_key: &str) -> PendingTrack {
        PendingTrack {
            index,
            rating_key: rating_key.to_string(),
            occurrence_id: format!("occurrence-{rating_key}"),
            duration_seconds: Some(3.0),
            source: format!("source-{rating_key}"),
            cache_key: Some(format!("cache-{rating_key}")),
            metadata: NowPlayingMetadata::default(),
            started: Arc::new(AtomicBool::new(false)),
            decode_state: Arc::new(DecodeBufferState::new(
                std::num::NonZeroU32::new(48_000).unwrap(),
                8,
                None,
                Arc::new(NativeAudioHealth::default()),
            )),
        }
    }

    #[test]
    fn queue_peek_next_index_matches_natural_advance() {
        let mut queue = QueueState {
            tracks: vec![queue_track("a"), queue_track("b"), queue_track("c")],
            current_index: 0,
            repeat: NativeRepeatMode::All,
            ..QueueState::default()
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
    fn peeking_before_playback_does_not_create_native_engine() {
        let cache_root = unique_temp_path("lazy-audio-engine");
        let slot = NativeAudioEngineSlot::new(cache_root.clone());

        assert!(slot.current().is_none());
        assert_eq!(slot.peek_next(true).unwrap(), None);
        assert!(
            slot.current().is_none(),
            "只读预览队列不能隐式创建 CoreAudio 输出引擎"
        );

        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[test]
    fn heartbeat_engine_lookup_never_waits_for_warmup_lock() {
        let cache_root = unique_temp_path("warmup-heartbeat-lock-cache");
        let slot = NativeAudioEngineSlot::new(cache_root.clone());
        let _warmup_guard = slot.inner.lock().unwrap();

        let started = std::time::Instant::now();
        assert!(slot.try_current().is_none());
        assert!(
            started.elapsed() < Duration::from_millis(20),
            "可见 WebView 心跳不能等待播放器初始化锁"
        );

        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[test]
    fn manual_next_wraps_even_when_natural_repeat_is_off() {
        let mut queue = QueueState {
            tracks: vec![queue_track("a"), queue_track("b")],
            current_index: 1,
            repeat: NativeRepeatMode::Off,
            ..QueueState::default()
        };
        assert_eq!(queue.peek_next_index(true), None);
        assert_eq!(queue.next_index(false), Some(0));
        assert_eq!(queue.current_index, 0);
    }

    #[test]
    fn remote_navigation_matches_the_visible_queue_boundaries() {
        let mut queue = QueueState {
            tracks: vec![queue_track("a"), queue_track("b"), queue_track("c")],
            current_index: 0,
            repeat: NativeRepeatMode::Off,
            ..QueueState::default()
        };
        assert_eq!(queue.remote_navigation_availability(), (false, true));
        queue.current_index = 2;
        assert_eq!(queue.remote_navigation_availability(), (true, false));
        queue.repeat = NativeRepeatMode::All;
        assert_eq!(queue.remote_navigation_availability(), (true, true));
        queue.repeat = NativeRepeatMode::Off;
        queue.shuffle = true;
        assert_eq!(queue.remote_navigation_availability(), (true, true));
        queue.tracks.truncate(1);
        queue.current_index = 0;
        assert_eq!(queue.remote_navigation_availability(), (false, false));
    }

    #[test]
    fn queue_shuffle_peek_is_stable_and_visits_a_full_round_without_repeats() {
        let mut queue = QueueState {
            tracks: vec![
                queue_track("a"),
                queue_track("b"),
                queue_track("c"),
                queue_track("d"),
            ],
            current_index: 0,
            repeat: NativeRepeatMode::Off,
            shuffle: true,
            ..QueueState::default()
        };
        let mut visited = std::collections::HashSet::from([0usize]);
        for _ in 0..3 {
            let preview = queue.peek_next_index(true).expect("本轮仍应有候选");
            assert_eq!(
                queue.peek_next_index(true),
                Some(preview),
                "重复 peek 必须保留同一预排候选"
            );
            assert_eq!(queue.next_index(true), Some(preview));
            assert!(visited.insert(preview), "同一 shuffle 轮不得重复曲目");
        }
        assert_eq!(visited.len(), 4);
        assert_eq!(queue.peek_next_index(true), None, "repeat-off 一轮后应结束");

        queue.repeat = NativeRepeatMode::All;
        let previous = queue.current().unwrap();
        let wrapped = queue.next_index(true).expect("repeat-all 应开启新一轮");
        assert_ne!(wrapped, previous, "新一轮第一首不能立即重复当前曲目");
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
            ..QueueState::default()
        };
        let next = queue.next_index(false).expect("随机下一首应存在");
        assert_eq!(
            queue.previous_index(),
            Some(0),
            "切到下一首后应能回到上一首"
        );
        assert_eq!(
            queue.next_index(false),
            Some(next),
            "Previous 后 Next 应可逆"
        );
        // 前端每次加载都会 nativeQueueSet 同一队列：bag 不能被清掉。
        let tracks = queue.tracks.clone();
        queue.resync(tracks, queue.current_index, NativeRepeatMode::All, true);
        assert_eq!(queue.previous_index(), Some(0), "队列重同步后上一首仍可用");
        // 队列内容真正变化时才清空历史。
        let mut changed = queue.tracks.clone();
        changed[3].occurrence_id = "occurrence-z".to_string();
        queue.resync(changed, queue.current_index, NativeRepeatMode::All, true);
        assert!(
            queue.bag.is_empty()
                && queue.history.is_empty()
                && queue.history_cursor.is_none()
                && !queue.shuffle_initialized,
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
            ..QueueState::default()
        };
        assert_eq!(
            queue.previous_index(),
            Some(2),
            "repeat-all 首曲上一首应回绕"
        );
        queue.repeat = NativeRepeatMode::One;
        assert_eq!(
            queue.previous_index(),
            Some(2),
            "repeat-one 只影响自然结束，手动上一首仍应回绕队列"
        );
        queue.repeat = NativeRepeatMode::Off;
        assert_eq!(queue.previous_index(), None, "repeat-off 首曲不能回绕");
        queue.repeat = NativeRepeatMode::All;
        queue.current_index = 1;
        assert_eq!(queue.previous_index(), Some(0));
    }

    #[test]
    fn pending_gapless_source_is_reindexed_or_invalidated_by_queue_identity() {
        let mut queue = QueueState {
            tracks: vec![
                queue_track("removed-before"),
                queue_track("a"),
                queue_track("b"),
            ],
            current_index: 1,
            repeat: NativeRepeatMode::All,
            ..QueueState::default()
        };
        let mut pending = Some(pending_track(2, "b"));

        queue.resync(
            vec![queue_track("a"), queue_track("b"), queue_track("c")],
            0,
            NativeRepeatMode::All,
            false,
        );
        assert!(!reconcile_pending_track(&mut pending, &mut queue));
        assert_eq!(pending.as_ref().map(|track| track.index), Some(1));

        queue.resync(
            vec![queue_track("a"), queue_track("c"), queue_track("b")],
            0,
            NativeRepeatMode::All,
            false,
        );
        assert!(reconcile_pending_track(&mut pending, &mut queue));
        assert!(pending.is_none(), "已不是下一首的底层 Source 必须失效");
    }

    #[test]
    fn pending_gapless_source_tracks_the_exact_duplicate_occurrence() {
        let mut first = queue_track("a");
        first.occurrence_id = "occurrence-a-first".to_string();
        let mut duplicate = queue_track("a");
        duplicate.occurrence_id = "occurrence-a-second".to_string();
        let mut pending = Some(pending_track(2, "a"));
        pending.as_mut().unwrap().occurrence_id = duplicate.occurrence_id.clone();
        let mut queue = QueueState {
            tracks: vec![
                queue_track("removed-before"),
                first.clone(),
                duplicate.clone(),
            ],
            current_index: 1,
            repeat: NativeRepeatMode::All,
            ..QueueState::default()
        };

        queue.resync(
            vec![first, duplicate, queue_track("c")],
            0,
            NativeRepeatMode::All,
            false,
        );

        assert!(!reconcile_pending_track(&mut pending, &mut queue));
        assert_eq!(pending.as_ref().map(|track| track.index), Some(1));
        assert_eq!(
            pending.as_ref().map(|track| track.occurrence_id.as_str()),
            Some("occurrence-a-second")
        );
    }

    #[test]
    fn repeat_change_invalidates_a_pending_repeat_one_source() {
        let mut queue = QueueState {
            tracks: vec![queue_track("a"), queue_track("b")],
            current_index: 0,
            repeat: NativeRepeatMode::One,
            ..QueueState::default()
        };
        let mut pending = Some(pending_track(0, "a"));
        assert_eq!(queue.peek_next_index(true), Some(0));

        queue.repeat = NativeRepeatMode::Off;
        assert!(reconcile_pending_track(&mut pending, &mut queue));
        assert!(pending.is_none());
        assert_eq!(queue.peek_next_index(true), Some(1));
    }

    #[tokio::test]
    async fn started_handoff_wins_over_a_stale_webview_queue_index() {
        let cache_root = unique_temp_path("handoff-resync-cache");
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.queue.lock().unwrap().resync(
            vec![queue_track("a"), queue_track("b")],
            0,
            NativeRepeatMode::All,
            false,
        );
        let mut queued = pending_track(1, "b");
        let reader_control = SegmentControl::new(CachePriority::Next);
        queued.decode_state = Arc::new(DecodeBufferState::new(
            std::num::NonZeroU32::new(48_000).unwrap(),
            8,
            Some(Arc::clone(&reader_control)),
            Arc::new(NativeAudioHealth::default()),
        ));
        queued.started.store(true, Ordering::SeqCst);
        *engine.pending.lock().unwrap() = Some(queued);

        engine
            .apply_queue_update(None, |queue| {
                // This snapshot was captured before the sample-level handoff.
                queue.resync(
                    vec![queue_track("a"), queue_track("b"), queue_track("c")],
                    0,
                    NativeRepeatMode::All,
                    false,
                );
            })
            .await
            .unwrap();

        assert_eq!(engine.queue.lock().unwrap().current_index, 1);
        assert_eq!(reader_control.priority(), CachePriority::Current);
        assert!(engine.pending.lock().unwrap().is_none());
        assert_eq!(
            engine
                .current_source
                .lock()
                .unwrap()
                .as_ref()
                .map(|source| source.source.as_str()),
            Some("source-b")
        );
        let _ = std::fs::remove_dir_all(cache_root);
    }

    #[tokio::test]
    async fn queue_edits_preserve_valid_gapless_pcm_and_rebuild_stale_pcm() {
        let cache_root = unique_temp_path("queue-reconcile-cache");
        let wav_a = unique_temp_path("queue-reconcile-a.wav");
        let wav_b = unique_temp_path("queue-reconcile-b.wav");
        write_test_wav(&wav_a);
        write_test_wav(&wav_b);
        let engine = NativeAudioEngine::new(cache_root.clone()).unwrap();
        engine.player().set_volume(0.0);
        engine.load_and_play(wav_a.to_str().unwrap()).unwrap();
        {
            let mut queue = engine.queue.lock().unwrap();
            queue.resync(
                vec![queue_track("a"), queue_track("b")],
                0,
                NativeRepeatMode::All,
                false,
            );
        }
        engine
            .queue_next_source(
                1,
                wav_b.to_str().unwrap(),
                Some("queue-reconcile-b".into()),
                None,
            )
            .await
            .unwrap();
        let original_player = engine.player();
        assert_eq!(original_player.len(), 2);

        engine
            .apply_queue_update(None, |queue| {
                queue.resync(
                    vec![queue_track("a"), queue_track("b"), queue_track("c")],
                    0,
                    NativeRepeatMode::All,
                    false,
                );
            })
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&original_player, &engine.player()));
        assert_eq!(engine.player().len(), 2, "有效预排不得破坏 gapless");
        assert_eq!(
            engine
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|track| track.index),
            Some(1)
        );

        tokio::time::sleep(Duration::from_millis(250)).await;
        let position_before_quality_change = engine.playback_position_seconds();
        engine
            .queue_next_source_replacing(
                1,
                wav_b.to_str().unwrap(),
                Some("queue-reconcile-b-new-quality".into()),
                None,
            )
            .await
            .unwrap();
        let quality_rebuilt_player = engine.player();
        assert!(!Arc::ptr_eq(&original_player, &quality_rebuilt_player));
        assert_eq!(quality_rebuilt_player.len(), 2);
        assert_eq!(
            engine
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|track| track.cache_key.clone()),
            Some("queue-reconcile-b-new-quality".to_string())
        );
        assert!(
            engine.playback_position_seconds() + 0.1 >= position_before_quality_change,
            "更换预排音质不应重置当前媒体进度"
        );

        let position_before_queue_change = engine.playback_position_seconds();
        engine
            .apply_queue_update(None, |queue| {
                queue.resync(
                    vec![queue_track("a"), queue_track("c"), queue_track("b")],
                    0,
                    NativeRepeatMode::All,
                    false,
                );
            })
            .await
            .unwrap();
        let rebuilt_player = engine.player();
        assert!(!Arc::ptr_eq(&quality_rebuilt_player, &rebuilt_player));
        assert_eq!(rebuilt_player.len(), 1, "重建后不得残留旧预排 Source");
        assert!(engine.pending.lock().unwrap().is_none());
        assert_eq!(engine.queue.lock().unwrap().peek_next_index(true), Some(1));
        assert!(
            engine.playback_position_seconds() + 0.1 >= position_before_queue_change,
            "队列重建应保留媒体进度"
        );
        assert!(engine.desired_playing.load(Ordering::SeqCst));

        engine.stop_immediately();
        let _ = std::fs::remove_file(wav_a);
        let _ = std::fs::remove_file(wav_b);
        let _ = std::fs::remove_dir_all(cache_root);
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
        // 下一首本地来源缺失。
        let missing = engine.queue_next_source(1, "missing", Some("missing-b".into()), None);
        assert!(missing.await.is_err(), "来源未就绪时不应预排");
        // 队列已前进（与前端预取目标不一致）时拒绝。
        engine.queue.lock().unwrap().current_index = 1;
        let stale =
            engine.queue_next_source(1, wav.to_str().unwrap(), Some("stale-b".into()), None);
        assert!(stale.await.is_err(), "预排顺序与队列不一致时应拒绝");
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
        engine
            .queue_next_source(
                1,
                wav_b.to_str().unwrap(),
                Some("gapless-b".into()),
                Some(NowPlayingMetadata {
                    title: Some("gapless b".into()),
                    artist: Some("artist b".into()),
                    album: Some("album b".into()),
                    duration_ms: Some(3_000),
                    artwork_url: None,
                }),
            )
            .await
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
        engine
            .queue_next_source(
                1,
                mp3_b.to_str().unwrap(),
                Some("gapless-b.mp3".into()),
                None,
            )
            .await
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
        assert_eq!(devices[0].device_id, "");
        assert_eq!(devices[0].label, "系统默认");
        assert!(devices[0].is_default);
        assert!(
            devices
                .iter()
                .skip(1)
                .all(|device| !device.device_id.is_empty()),
            "物理设备必须使用稳定 cpal ID"
        );
        let unique_ids = devices
            .iter()
            .map(|device| device.device_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique_ids.len(), devices.len(), "设备 ID 不得重复");
    }

    #[tokio::test]
    async fn output_engine_rebuild_resumes_playback_from_position() {
        let wav = unique_temp_path("device-switch.wav");
        let next_wav = unique_temp_path("device-switch-next.wav");
        write_test_wav(&wav);
        write_test_wav(&next_wav);
        let cache_root = unique_temp_path("rodio-cache-device");
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        {
            let mut queue = engine.queue.lock().unwrap();
            queue.tracks = vec![queue_track("a"), queue_track("b"), queue_track("c")];
            queue.current_index = 1;
            queue.repeat = NativeRepeatMode::All;
            queue.shuffle = true;
            queue.bag = vec![2];
            queue.shuffle_initialized = true;
            queue.history = vec![0, 1];
            queue.history_cursor = Some(1);
        }
        engine.load_and_play(wav.to_str().unwrap()).unwrap();
        engine
            .queue_next_source(
                2,
                next_wav.to_str().unwrap(),
                Some("device-next".into()),
                Some(NowPlayingMetadata {
                    title: Some("next".into()),
                    duration_ms: Some(3_000),
                    ..NowPlayingMetadata::default()
                }),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        let snapshot = engine.capture_playback_snapshot();
        assert!(snapshot.position > 0.1, "切换前播放进度应已前进");
        assert!(snapshot.playing, "切换前应处于播放中");
        assert_eq!(
            snapshot.pending.as_ref().map(|pending| pending.index),
            Some(2)
        );

        let rebuilt = NativeAudioEngine::new(cache_root.clone()).unwrap();
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
        assert_eq!(rebuilt.player().len(), 2, "设备重建后应保留 gapless 预排");
        assert_eq!(
            rebuilt
                .pending
                .lock()
                .unwrap()
                .as_ref()
                .map(|pending| pending.index),
            Some(2)
        );
        {
            let queue = rebuilt.queue.lock().unwrap();
            assert_eq!(queue.current_index, 1);
            assert_eq!(queue.bag, vec![2]);
            assert!(queue.shuffle_initialized);
            assert_eq!(queue.history, vec![0, 1]);
            assert_eq!(queue.history_cursor, Some(1));
        }
        rebuilt.stop_immediately();
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_file(&next_wav);
        let _ = std::fs::remove_dir_all(&cache_root);
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
    /// 分段读取 → 稀疏缓存 → 预排下一首 → 无缝交接 → seek → 暂停/恢复。
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
        let engine = Arc::new(NativeAudioEngine::new(cache_root.clone()).unwrap());
        engine.player().set_volume(0.0);
        engine
            .load_cached_and_play(
                &stream_url(&track_a.4),
                Some(track_a.2.clone()),
                Some(NowPlayingMetadata {
                    title: Some(track_a.3.clone()),
                    artist: None,
                    album: None,
                    duration_ms: Some(track_a.0),
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
                    occurrence_id: "occurrence-a".to_string(),
                    title: track_a.3.clone(),
                    artist: String::new(),
                    album: String::new(),
                },
                QueueTrack {
                    rating_key: track_b.2.clone(),
                    occurrence_id: "occurrence-b".to_string(),
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
                    duration_ms: Some(track_b.0),
                    artwork_url: None,
                }),
            )
            .await
            .expect("真实 PMS 曲目 B 应能预排");

        // 稀疏 reader 会按需拉取 seek 目标区间，无需等待整首完整落盘。
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

        let status = engine.segment_cache.status();
        assert!(
            status.complete_entries + status.partial_entries >= 2,
            "真实 PMS 回归后应记录当前曲目与下一首分段"
        );
        eprintln!("真实 PMS 引擎回归通过：分段缓存/播放/预排/无缝交接/seek/暂停恢复均正常");

        engine.stop_immediately();
        let _ = std::fs::remove_dir_all(&cache_root);
    }

    /// 真实 PMS 高频切歌回归（默认忽略，显式运行：
    /// `cargo test -- --ignored real_pms_engine_rapid_switch_regression --nocapture`）。
    /// 连续快速加载/切换两轮（≥20 次加载），中途穿插 seek 与暂停/恢复，
    /// 覆盖分段缓存复用与历史上 WebView 播放的高频切歌 error4/卡顿场景。
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

        // 两轮连续快速加载/切换，模拟用户高频点下一首；第二轮穿插 seek/暂停。
        let mut loads = 0usize;
        for round in 0..2 {
            for (index, (duration_ms, _size, rating_key, title, part_key)) in
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
                            duration_ms: Some(*duration_ms),
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
                eprintln!("[回归] 高频切歌 #{loads} 分段读取成功");
            }
        }

        let status = engine.segment_cache.status();
        let cache_entries = status.complete_entries + status.partial_entries;
        assert!(
            cache_entries >= selected.len(),
            "高频切换后分段索引应覆盖全部选中曲目"
        );
        assert!(loads >= 20, "高频切换应至少 20 次加载，实际 {loads}");
        eprintln!("真实 PMS 高频切歌回归通过：{loads} 次加载/切换、seek/暂停恢复均无失败");
        engine.stop_immediately();
        let _ = std::fs::remove_dir_all(&cache_root);
    }
}

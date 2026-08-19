use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use reqwest::{redirect::Policy, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::runtime::{Builder as RuntimeBuilder, Runtime};

pub(crate) const AUDIO_CACHE_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;
const LOW_DISK_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
const CACHE_SCHEMA_VERSION: u32 = 2;
const SEGMENT_FETCH_BYTES: u64 = 2 * 1024 * 1024;
const INITIAL_HEAD_BYTES: u64 = 256 * 1024;
const SEQUENTIAL_INDEX_CHECKPOINT_BYTES: u64 = 1024 * 1024;
const NETWORK_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_CANCEL_POLL: Duration = Duration::from_millis(25);
const MAX_CACHE_IDENTITY_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum CachePriority {
    Current,
    Next,
}

impl CachePriority {
    fn from_u8(value: u8) -> Self {
        if value == Self::Next as u8 {
            Self::Next
        } else {
            Self::Current
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CacheStatus {
    pub allocated_bytes: u64,
    pub complete_entries: usize,
    pub partial_bytes: u64,
    pub partial_entries: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct ByteRange {
    start: u64,
    end: u64,
}

impl ByteRange {
    fn new(start: u64, end: u64) -> Option<Self> {
        (start < end).then_some(Self { start, end })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SegmentIndex {
    version: u32,
    logical_len: Option<u64>,
    etag: Option<String>,
    last_modified: Option<String>,
    range_supported: Option<bool>,
    ranges: Vec<ByteRange>,
}

impl SegmentIndex {
    fn empty() -> Self {
        Self {
            version: CACHE_SCHEMA_VERSION,
            logical_len: None,
            etag: None,
            last_modified: None,
            range_supported: None,
            ranges: Vec::new(),
        }
    }

    fn normalize(&mut self) {
        self.ranges.retain(|range| range.start < range.end);
        self.ranges.sort_by_key(|range| range.start);
        let mut merged = Vec::<ByteRange>::with_capacity(self.ranges.len());
        for range in self.ranges.drain(..) {
            if let Some(last) = merged.last_mut() {
                if range.start <= last.end {
                    last.end = last.end.max(range.end);
                    continue;
                }
            }
            merged.push(range);
        }
        self.ranges = merged;
    }

    fn add_range(&mut self, start: u64, end: u64) {
        if let Some(range) = ByteRange::new(start, end) {
            self.ranges.push(range);
            self.normalize();
        }
    }

    fn available_end(&self, position: u64) -> Option<u64> {
        self.ranges
            .iter()
            .find(|range| range.start <= position && position < range.end)
            .map(|range| range.end)
    }

    fn complete(&self) -> bool {
        self.logical_len
            .is_some_and(|length| length > 0 && self.available_end(0) == Some(length))
    }

    fn valid(&self) -> bool {
        if self.version != CACHE_SCHEMA_VERSION {
            return false;
        }
        let mut previous_end = 0;
        for (index, range) in self.ranges.iter().enumerate() {
            if range.start >= range.end || (index > 0 && range.start <= previous_end) {
                return false;
            }
            if self
                .logical_len
                .is_some_and(|logical_len| range.end > logical_len)
            {
                return false;
            }
            previous_end = range.end;
        }
        true
    }
}

struct EntryRuntime {
    index: SegmentIndex,
    sequential_active: bool,
}

struct SegmentEntry {
    key: String,
    data_path: PathBuf,
    index_path: PathBuf,
    runtime: Mutex<EntryRuntime>,
    notify: Condvar,
    fetch_lock: Mutex<()>,
}

impl SegmentEntry {
    fn available_end(&self, position: u64) -> Option<u64> {
        self.runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .index
            .available_end(position)
    }

    fn logical_len(&self) -> Option<u64> {
        self.runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .index
            .logical_len
    }

    fn sequential_active(&self) -> bool {
        self.runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sequential_active
    }
}

#[derive(Default)]
struct GateState {
    active: bool,
    current_waiters: usize,
}

struct NetworkGate {
    state: Mutex<GateState>,
    notify: Condvar,
}

impl NetworkGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(GateState::default()),
            notify: Condvar::new(),
        })
    }

    fn acquire(
        self: &Arc<Self>,
        control: &SegmentControl,
        observed_epoch: u64,
    ) -> io::Result<NetworkPermit> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let mut registered_current = false;
        loop {
            let priority = control.priority();
            if priority == CachePriority::Current && !registered_current {
                state.current_waiters += 1;
                registered_current = true;
            }
            if control.is_interrupted(observed_epoch) {
                if registered_current {
                    state.current_waiters = state.current_waiters.saturating_sub(1);
                    self.notify.notify_all();
                }
                return Err(interrupted_error());
            }
            if !state.active && (priority == CachePriority::Current || state.current_waiters == 0) {
                break;
            }
            let (next, _) = self
                .notify
                .wait_timeout(state, NETWORK_CANCEL_POLL)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
        }
        if registered_current {
            state.current_waiters = state.current_waiters.saturating_sub(1);
        }
        state.active = true;
        Ok(NetworkPermit {
            gate: Arc::clone(self),
        })
    }
}

struct NetworkPermit {
    gate: Arc<NetworkGate>,
}

impl Drop for NetworkPermit {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active = false;
        self.gate.notify.notify_all();
    }
}

struct CacheHttpRuntime {
    inner: Option<Runtime>,
}

impl CacheHttpRuntime {
    fn new() -> Result<Self, String> {
        let runtime = RuntimeBuilder::new_multi_thread()
            .worker_threads(1)
            .thread_name("cadilume-cache-http")
            .enable_all()
            .build()
            .map_err(|error| format!("创建分段媒体网络运行时失败: {error}"))?;
        Ok(Self {
            inner: Some(runtime),
        })
    }

    fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.inner
            .as_ref()
            .expect("cache HTTP runtime is available until cache drop")
            .block_on(future)
    }

    fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.inner
            .as_ref()
            .expect("cache HTTP runtime is available until cache drop")
            .spawn(future);
    }
}

impl Drop for CacheHttpRuntime {
    fn drop(&mut self) {
        let Some(runtime) = self.inner.take() else {
            return;
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            let _ = std::thread::Builder::new()
                .name("cadilume-cache-http-drop".to_string())
                .spawn(move || drop(runtime));
        } else {
            drop(runtime);
        }
    }
}

struct CacheInner {
    cache_root: PathBuf,
    entries_root: PathBuf,
    limit_bytes: u64,
    low_disk_reserve_bytes: u64,
    range_client: Client,
    sequential_client: Client,
    network_runtime: CacheHttpRuntime,
    network_gate: Arc<NetworkGate>,
    open_entries: Mutex<HashMap<String, Weak<SegmentEntry>>>,
    active_operations: AtomicUsize,
}

struct CacheActivityGuard {
    cache: Arc<CacheInner>,
}

impl CacheActivityGuard {
    fn new(cache: &Arc<CacheInner>) -> Self {
        cache.active_operations.fetch_add(1, Ordering::SeqCst);
        Self {
            cache: Arc::clone(cache),
        }
    }
}

impl Drop for CacheActivityGuard {
    fn drop(&mut self) {
        let previous = self.cache.active_operations.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0, "cache activity count must not underflow");
    }
}

#[derive(Clone)]
pub(crate) struct SegmentCache {
    inner: Arc<CacheInner>,
}

pub(crate) struct SegmentControl {
    cancelled: AtomicBool,
    interrupt_epoch: AtomicU64,
    priority: AtomicU8,
    failure: Mutex<Option<String>>,
}

impl SegmentControl {
    pub(crate) fn new(priority: CachePriority) -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            interrupt_epoch: AtomicU64::new(0),
            priority: AtomicU8::new(priority as u8),
            failure: Mutex::new(None),
        })
    }

    pub(crate) fn promote_to_current(&self) {
        self.priority
            .store(CachePriority::Current as u8, Ordering::SeqCst);
    }

    pub(crate) fn priority(&self) -> CachePriority {
        CachePriority::from_u8(self.priority.load(Ordering::SeqCst))
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.interrupt_epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn interrupt_reader(&self) {
        self.interrupt_epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn is_interrupted(&self, observed_epoch: u64) -> bool {
        self.is_cancelled() || self.interrupt_epoch.load(Ordering::SeqCst) != observed_epoch
    }

    fn fail(&self, message: String) {
        *self
            .failure
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(message);
        self.interrupt_reader();
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

pub(crate) struct SegmentReader {
    cache: Arc<CacheInner>,
    entry: Arc<SegmentEntry>,
    source: String,
    control: Arc<SegmentControl>,
    file: File,
    position: u64,
    observed_interrupt_epoch: u64,
    decoder_started: bool,
    _activity: CacheActivityGuard,
}

impl SegmentCache {
    pub(crate) fn new(cache_root: PathBuf) -> Result<Self, String> {
        Self::new_with_policy(cache_root, AUDIO_CACHE_LIMIT_BYTES, LOW_DISK_RESERVE_BYTES)
    }

    fn new_with_policy(
        cache_root: PathBuf,
        limit_bytes: u64,
        low_disk_reserve_bytes: u64,
    ) -> Result<Self, String> {
        let entries_root = cache_root.join("segments-v2");
        std::fs::create_dir_all(&entries_root)
            .map_err(|error| format!("创建分段缓存目录失败: {error}"))?;
        remove_legacy_cache(&cache_root)?;
        recover_entries(&entries_root)?;
        let (range_client, sequential_client) = build_http_clients()?;
        let network_runtime = CacheHttpRuntime::new()?;
        let cache = Self {
            inner: Arc::new(CacheInner {
                cache_root,
                entries_root,
                limit_bytes,
                low_disk_reserve_bytes,
                range_client,
                sequential_client,
                network_runtime,
                network_gate: NetworkGate::new(),
                open_entries: Mutex::new(HashMap::new()),
                active_operations: AtomicUsize::new(0),
            }),
        };
        let _ = cache.inner.ensure_capacity(0, None);
        Ok(cache)
    }

    pub(crate) fn open_reader(
        &self,
        cache_identity: Option<&str>,
        source: &str,
        priority: CachePriority,
    ) -> Result<SegmentReader, String> {
        let key = cache_key(cache_identity)?;
        let entry = self.inner.open_entry(&key)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&entry.data_path)
            .map_err(|error| format!("打开稀疏媒体缓存失败: {error}"))?;
        touch(&entry.index_path);
        let control = SegmentControl::new(priority);
        Ok(SegmentReader {
            cache: Arc::clone(&self.inner),
            entry,
            source: source.to_string(),
            observed_interrupt_epoch: control.interrupt_epoch.load(Ordering::SeqCst),
            control,
            file,
            position: 0,
            decoder_started: false,
            _activity: CacheActivityGuard::new(&self.inner),
        })
    }

    pub(crate) fn status(&self) -> CacheStatus {
        cache_status(&self.inner.entries_root)
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        let active_operations = self.active_operations();
        if active_operations != 0 {
            return Err(format!(
                "仍有 {active_operations} 个媒体缓存任务未退出，无法清理音频缓存"
            ));
        }
        if let Ok(mut entries) = self.inner.open_entries.lock() {
            entries.clear();
        }
        match std::fs::remove_dir_all(&self.inner.entries_root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("清理分段音频缓存失败: {error}")),
        }
        remove_legacy_cache(&self.inner.cache_root)?;
        std::fs::create_dir_all(&self.inner.entries_root)
            .map_err(|error| format!("重建分段缓存目录失败: {error}"))
    }

    pub(crate) fn active_operations(&self) -> usize {
        self.inner.active_operations.load(Ordering::SeqCst)
    }
}

impl CacheInner {
    fn open_entry(&self, key: &str) -> Result<Arc<SegmentEntry>, String> {
        let mut open_entries = self
            .open_entries
            .lock()
            .map_err(|_| "分段缓存状态锁失败".to_string())?;
        if let Some(entry) = open_entries.get(key).and_then(Weak::upgrade) {
            return Ok(entry);
        }
        let dir = self.entries_root.join(key);
        std::fs::create_dir_all(&dir).map_err(|error| format!("创建媒体缓存条目失败: {error}"))?;
        let data_path = dir.join("media.sparse");
        let index_path = dir.join("index.json");
        let mut index = read_index(&index_path).unwrap_or_else(SegmentIndex::empty);
        if !index.valid() || (!data_path.exists() && !index.ranges.is_empty()) {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir)
                .map_err(|error| format!("重建媒体缓存条目失败: {error}"))?;
            index = SegmentIndex::empty();
        }
        let data = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&data_path)
            .map_err(|error| format!("创建稀疏媒体文件失败: {error}"))?;
        mark_sparse_file(&data).map_err(|error| format!("标记稀疏媒体文件失败: {error}"))?;
        if let Some(logical_len) = index.logical_len {
            data.set_len(logical_len)
                .map_err(|error| format!("恢复稀疏媒体长度失败: {error}"))?;
            punch_uncommitted_holes(&data, &index, logical_len)
                .map_err(|error| format!("恢复稀疏媒体区间失败: {error}"))?;
        }
        if !index_path.exists() {
            persist_index_path(&index_path, &index)
                .map_err(|error| format!("初始化分段缓存索引失败: {error}"))?;
        }
        let entry = Arc::new(SegmentEntry {
            key: key.to_string(),
            data_path,
            index_path,
            runtime: Mutex::new(EntryRuntime {
                index,
                sequential_active: false,
            }),
            notify: Condvar::new(),
            fetch_lock: Mutex::new(()),
        });
        open_entries.insert(key.to_string(), Arc::downgrade(&entry));
        Ok(entry)
    }

    fn active_keys(&self) -> HashSet<String> {
        let mut active = HashSet::new();
        if let Ok(mut entries) = self.open_entries.lock() {
            entries.retain(|key, entry| {
                let live = entry.strong_count() > 0;
                if live {
                    active.insert(key.clone());
                }
                live
            });
        }
        active
    }

    fn ensure_capacity(&self, additional_bytes: u64, requesting_key: Option<&str>) -> bool {
        if additional_bytes > self.limit_bytes {
            return false;
        }
        loop {
            let status = cache_status(&self.entries_root);
            let available = fs2::available_space(&self.entries_root).unwrap_or(u64::MAX);
            let within_cache =
                status.allocated_bytes.saturating_add(additional_bytes) <= self.limit_bytes;
            let above_reserve =
                available.saturating_sub(additional_bytes) >= self.low_disk_reserve_bytes;
            if within_cache && above_reserve {
                return true;
            }
            let active = self.active_keys();
            let Some(candidate) =
                eviction_candidates(&self.entries_root)
                    .into_iter()
                    .find(|candidate| {
                        !active.contains(&candidate.key)
                            && requesting_key != Some(candidate.key.as_str())
                    })
            else {
                return false;
            };
            if std::fs::remove_dir_all(&candidate.path).is_err() {
                return false;
            }
            eprintln!("[原生] 分段缓存准入淘汰 key={}", candidate.key);
        }
    }
}

impl SegmentReader {
    pub(crate) fn control(&self) -> Arc<SegmentControl> {
        Arc::clone(&self.control)
    }

    pub(crate) fn logical_len(&self) -> Option<u64> {
        self.entry.logical_len()
    }

    pub(crate) fn prefetch_head(&mut self) -> io::Result<Option<u64>> {
        self.ensure_available(0, INITIAL_HEAD_BYTES)?;
        Ok(self.logical_len())
    }

    fn ensure_available(&mut self, position: u64, minimum_bytes: u64) -> io::Result<()> {
        loop {
            self.check_control()?;
            let available_end = self.entry.available_end(position);
            if available_end.is_some_and(|end| end.saturating_sub(position) >= minimum_bytes) {
                return Ok(());
            }
            let fetch_position = available_end.unwrap_or(position);
            if self
                .entry
                .logical_len()
                .is_some_and(|length| fetch_position >= length)
            {
                return Ok(());
            }
            if self.entry.sequential_active() {
                self.wait_for_entry_change()?;
                continue;
            }
            match self.fetch_missing(fetch_position)? {
                FetchOutcome::Available => continue,
                FetchOutcome::End => return Ok(()),
                FetchOutcome::Waiting => self.wait_for_entry_change()?,
                FetchOutcome::Interrupted => {
                    self.check_control()?;
                    return Ok(());
                }
            }
        }
    }

    fn check_control(&mut self) -> io::Result<()> {
        if self.control.is_cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "分段媒体读取已取消",
            ));
        }
        if let Some(failure) = self.control.failure() {
            return Err(io::Error::new(io::ErrorKind::Other, failure));
        }
        let interrupt_epoch = self.control.interrupt_epoch.load(Ordering::SeqCst);
        if interrupt_epoch != self.observed_interrupt_epoch {
            self.observed_interrupt_epoch = interrupt_epoch;
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "分段媒体读取已被新定位替代",
            ));
        }
        Ok(())
    }

    fn wait_for_entry_change(&mut self) -> io::Result<()> {
        {
            let runtime = self
                .entry
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let _guard = self
                .entry
                .notify
                .wait_timeout(runtime, Duration::from_millis(150))
                .unwrap_or_else(|error| error.into_inner());
        }
        self.check_control()
    }

    fn fetch_missing(&mut self, position: u64) -> io::Result<FetchOutcome> {
        let entry = Arc::clone(&self.entry);
        let _entry_fetch = entry
            .fetch_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.entry.available_end(position).is_some() {
            return Ok(FetchOutcome::Available);
        }
        if self
            .entry
            .logical_len()
            .is_some_and(|length| position >= length)
        {
            return Ok(FetchOutcome::End);
        }
        let observed_epoch = self.control.interrupt_epoch.load(Ordering::SeqCst);
        let permit = match self
            .cache
            .network_gate
            .acquire(self.control.as_ref(), observed_epoch)
        {
            Ok(permit) => permit,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Ok(FetchOutcome::Interrupted);
            }
            Err(error) => return Err(error),
        };

        let (range_supported, logical_len, validator) = {
            let runtime = self
                .entry
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            (
                runtime.index.range_supported,
                runtime.index.logical_len,
                runtime
                    .index
                    .etag
                    .clone()
                    .or_else(|| runtime.index.last_modified.clone()),
            )
        };
        if range_supported == Some(false) && self.control.priority() == CachePriority::Next {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "服务器不支持下一首分段预缓冲",
            ));
        }
        let (mut range_start, range_end) = fetch_range_bounds(position, logical_len);
        if let Some(cached_end) = self.entry.available_end(range_start) {
            range_start = cached_end;
        }
        let mut request = self.cache.range_client.get(&self.source);
        if range_supported != Some(false) {
            request = request.header(
                RANGE,
                format!("bytes={range_start}-{}", range_end.saturating_sub(1)),
            );
            if let Some(validator) = validator {
                request = request.header(IF_RANGE, validator);
            }
        }
        let response = match self.cache.network_runtime.block_on(fetch_range_response(
            request,
            self.control.as_ref(),
            observed_epoch,
            range_end.saturating_sub(range_start),
        )) {
            Ok(response) => response,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Ok(FetchOutcome::Interrupted);
            }
            Err(error) => return Err(error),
        };
        match response.status {
            StatusCode::PARTIAL_CONTENT => self.commit_partial_response(
                response.headers,
                response.body,
                range_start,
                range_end,
                observed_epoch,
            ),
            StatusCode::OK => self.start_sequential_download(permit, observed_epoch),
            StatusCode::RANGE_NOT_SATISFIABLE => {
                self.commit_unsatisfied_length(response.headers.get(CONTENT_RANGE))?;
                Ok(FetchOutcome::End)
            }
            status => Err(io::Error::new(
                io::ErrorKind::Other,
                format!("分段下载返回 HTTP {status}"),
            )),
        }
    }

    fn commit_partial_response(
        &mut self,
        headers: HeaderMap,
        body: Vec<u8>,
        requested_start: u64,
        requested_end: u64,
        observed_epoch: u64,
    ) -> io::Result<FetchOutcome> {
        let content_range = headers
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Range 响应缺少有效 Content-Range",
                )
            })?;
        if content_range.start != requested_start
            || content_range.end > requested_end
            || content_range.total == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Range 响应区间与请求不一致",
            ));
        }
        let response_etag = header_string(headers.get(ETAG));
        let response_last_modified = header_string(headers.get(LAST_MODIFIED));
        let stale = {
            let runtime = self
                .entry
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            !runtime.index.ranges.is_empty()
                && (validator_changed(&runtime.index.etag, &response_etag)
                    || validator_changed(&runtime.index.last_modified, &response_last_modified)
                    || runtime
                        .index
                        .logical_len
                        .is_some_and(|length| length != content_range.total))
        };
        if stale {
            reset_entry(&self.entry)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "媒体校验值或长度已变化，请重新加载",
            ));
        }
        let expected = content_range.end.saturating_sub(content_range.start);
        if self.control.is_interrupted(observed_epoch) {
            return Ok(FetchOutcome::Interrupted);
        }
        if body.len() as u64 > expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Range 响应超过声明区间",
            ));
        }
        if body.len() as u64 != expected {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!(
                    "Range 响应不完整：期望 {expected} 字节，实际 {} 字节",
                    body.len()
                ),
            ));
        }
        if !self
            .cache
            .ensure_capacity(body.len() as u64, Some(&self.entry.key))
        {
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "音频缓存空间不足或磁盘可用空间低于 1 GiB",
            ));
        }
        let mut writer = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.entry.data_path)?;
        writer.set_len(content_range.total)?;
        let committed_index = self
            .entry
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .index
            .clone();
        punch_uncommitted_holes(&writer, &committed_index, content_range.total)?;
        writer.seek(SeekFrom::Start(content_range.start))?;
        writer.write_all(&body)?;
        writer.flush()?;
        writer.sync_data()?;
        {
            let mut runtime = self
                .entry
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            runtime.index.logical_len = Some(content_range.total);
            runtime.index.range_supported = Some(true);
            if response_etag.is_some() {
                runtime.index.etag = response_etag;
            }
            if response_last_modified.is_some() {
                runtime.index.last_modified = response_last_modified;
            }
            runtime
                .index
                .add_range(content_range.start, content_range.end);
            punch_uncommitted_holes(&writer, &runtime.index, content_range.total)?;
            writer.sync_data()?;
            persist_index_path(&self.entry.index_path, &runtime.index)?;
        }
        self.entry.notify.notify_all();
        Ok(FetchOutcome::Available)
    }

    fn start_sequential_download(
        &mut self,
        permit: NetworkPermit,
        observed_epoch: u64,
    ) -> io::Result<FetchOutcome> {
        if self.control.priority() == CachePriority::Next {
            let mut runtime = self
                .entry
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if !runtime.index.ranges.is_empty() {
                drop(runtime);
                reset_entry(&self.entry)?;
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "媒体校验值已变化，已丢弃旧分段",
                ));
            }
            runtime.index.range_supported = Some(false);
            persist_index_path(&self.entry.index_path, &runtime.index)?;
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "服务器未接受 Range，已跳过下一首完整下载",
            ));
        }
        let response = match self.cache.network_runtime.block_on(send_interruptibly(
            self.cache.sequential_client.get(&self.source),
            self.control.as_ref(),
            observed_epoch,
        )) {
            Ok(response) => response,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Ok(FetchOutcome::Interrupted);
            }
            Err(error) => return Err(error),
        };
        if response.status() != StatusCode::OK {
            return Err(io::Error::other(format!(
                "连续下载返回 HTTP {}",
                response.status()
            )));
        }
        let response_etag = header_string(response.headers().get(ETAG));
        let response_last_modified = header_string(response.headers().get(LAST_MODIFIED));
        let expected_len = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        {
            let mut runtime = self
                .entry
                .runtime
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.decoder_started && !runtime.index.ranges.is_empty() {
                drop(runtime);
                reset_entry(&self.entry)?;
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "媒体在播放期间已变化或不再支持 Range，请重新加载",
                ));
            }
            runtime.index = SegmentIndex::empty();
            runtime.index.logical_len = expected_len;
            runtime.index.etag = response_etag;
            runtime.index.last_modified = response_last_modified;
            runtime.index.range_supported = Some(false);
            runtime.sequential_active = true;
            persist_index_path(&self.entry.index_path, &runtime.index)?;
        }
        let data = OpenOptions::new()
            .read(true)
            .write(true)
            .truncate(true)
            .open(&self.entry.data_path)?;
        if let Some(expected_len) = expected_len {
            data.set_len(expected_len)?;
            punch_uncommitted_holes(&data, &SegmentIndex::empty(), expected_len)?;
        }
        let cache = Arc::clone(&self.cache);
        let entry = Arc::clone(&self.entry);
        let control = Arc::clone(&self.control);
        let activity = CacheActivityGuard::new(&self.cache);
        self.cache.network_runtime.spawn(async move {
            let _activity = activity;
            let _permit = permit;
            sequential_download(response, data, cache, entry, control, expected_len).await;
        });
        Ok(FetchOutcome::Waiting)
    }

    fn commit_unsatisfied_length(
        &self,
        value: Option<&reqwest::header::HeaderValue>,
    ) -> io::Result<()> {
        let Some(total) = value
            .and_then(|value| value.to_str().ok())
            .and_then(parse_unsatisfied_content_range)
        else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "416 响应缺少有效媒体长度",
            ));
        };
        let mut runtime = self
            .entry
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if runtime
            .index
            .logical_len
            .is_some_and(|previous| previous != total)
            || runtime.index.ranges.iter().any(|range| range.end > total)
        {
            drop(runtime);
            reset_entry(&self.entry)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "媒体长度已变化，请重新加载",
            ));
        }
        runtime.index.logical_len = Some(total);
        runtime.index.range_supported = Some(true);
        persist_index_path(&self.entry.index_path, &runtime.index)
    }
}

impl Read for SegmentReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let result = self.read_inner(buffer);
        if let Err(error) = &result {
            if error.kind() != io::ErrorKind::Interrupted {
                self.control.fail(error.to_string());
            }
        }
        result
    }
}

impl SegmentReader {
    fn read_inner(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            match self.check_control() {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => return Ok(0),
                Err(error) => return Err(error),
            }
            if self
                .entry
                .logical_len()
                .is_some_and(|length| self.position >= length)
            {
                return Ok(0);
            }
            if let Some(available_end) = self.entry.available_end(self.position) {
                let available = available_end.saturating_sub(self.position);
                let requested = available.min(buffer.len() as u64) as usize;
                self.file.seek(SeekFrom::Start(self.position))?;
                let read = self.file.read(&mut buffer[..requested])?;
                self.position = self.position.saturating_add(read as u64);
                self.decoder_started = true;
                return Ok(read);
            }
            match self.ensure_available(self.position, 1) {
                Ok(()) => continue,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => return Ok(0),
                Err(error) => return Err(error),
            }
        }
    }
}

impl Seek for SegmentReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        match self.check_control() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
        let next = match position {
            SeekFrom::Start(position) => position,
            SeekFrom::Current(delta) => {
                (self.position as i128 + delta as i128).clamp(0, u64::MAX as i128) as u64
            }
            SeekFrom::End(delta) => {
                let length = self.entry.logical_len().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::Unsupported,
                        "媒体总长度未知，暂不支持从文件末尾定位",
                    )
                })?;
                (length as i128 + delta as i128).clamp(0, u64::MAX as i128) as u64
            }
        };
        self.position = next;
        Ok(next)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FetchOutcome {
    Available,
    Waiting,
    Interrupted,
    End,
}

#[derive(Clone, Copy, Debug)]
struct ParsedContentRange {
    start: u64,
    end: u64,
    total: u64,
}

struct RangeResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

async fn send_interruptibly(
    request: reqwest::RequestBuilder,
    control: &SegmentControl,
    observed_epoch: u64,
) -> io::Result<Response> {
    let future = request.send();
    tokio::pin!(future);
    loop {
        if control.is_interrupted(observed_epoch) {
            return Err(interrupted_error());
        }
        tokio::select! {
            result = &mut future => {
                return result.map_err(|error| io::Error::other(range_error(&error)));
            }
            _ = tokio::time::sleep(NETWORK_CANCEL_POLL) => {}
        }
    }
}

async fn fetch_range_response(
    request: reqwest::RequestBuilder,
    control: &SegmentControl,
    observed_epoch: u64,
    maximum_body_bytes: u64,
) -> io::Result<RangeResponse> {
    let response = send_interruptibly(request, control, observed_epoch).await?;
    let status = response.status();
    let headers = response.headers().clone();
    if status != StatusCode::PARTIAL_CONTENT {
        return Ok(RangeResponse {
            status,
            headers,
            body: Vec::new(),
        });
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let chunk = loop {
            tokio::select! {
                item = stream.next() => break item,
                _ = tokio::time::sleep(NETWORK_CANCEL_POLL) => {
                    if control.is_interrupted(observed_epoch) {
                        return Err(interrupted_error());
                    }
                }
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk
            .map_err(|error| io::Error::new(io::ErrorKind::UnexpectedEof, range_error(&error)))?;
        if control.is_interrupted(observed_epoch) {
            return Err(interrupted_error());
        }
        if body.len() as u64 + chunk.len() as u64 > maximum_body_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Range 响应超过声明区间",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(RangeResponse {
        status,
        headers,
        body,
    })
}

async fn sequential_download(
    response: Response,
    mut data: File,
    cache: Arc<CacheInner>,
    entry: Arc<SegmentEntry>,
    control: Arc<SegmentControl>,
    expected_len: Option<u64>,
) {
    let outcome = async {
        let mut stream = response.bytes_stream();
        let mut offset = 0u64;
        let mut persisted_at = 0u64;
        loop {
            if control.is_cancelled() {
                break;
            }
            let chunk = loop {
                tokio::select! {
                    item = stream.next() => break item,
                    _ = tokio::time::sleep(NETWORK_CANCEL_POLL) => {
                        if control.is_cancelled() {
                            break None;
                        }
                    }
                }
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|error| {
                io::Error::new(io::ErrorKind::UnexpectedEof, range_error(&error))
            })?;
            if control.is_cancelled() {
                break;
            }
            if !cache.ensure_capacity(chunk.len() as u64, Some(&entry.key)) {
                return Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "音频缓存空间不足或磁盘可用空间低于 1 GiB",
                ));
            }
            data.seek(SeekFrom::Start(offset))?;
            data.write_all(&chunk)?;
            data.flush()?;
            offset = offset.saturating_add(chunk.len() as u64);
            {
                let mut runtime = entry
                    .runtime
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                runtime.index.add_range(0, offset);
                if offset.saturating_sub(persisted_at) >= SEQUENTIAL_INDEX_CHECKPOINT_BYTES {
                    data.sync_data()?;
                    persist_index_path(&entry.index_path, &runtime.index)?;
                    persisted_at = offset;
                }
            }
            entry.notify.notify_all();
        }
        if control.is_cancelled() {
            return Ok(());
        }
        if expected_len.is_some_and(|expected| expected != offset) {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!(
                    "连续下载不完整：期望 {} 字节，实际 {offset} 字节",
                    expected_len.unwrap_or_default()
                ),
            ));
        }
        if offset == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "连续下载内容为空",
            ));
        }
        data.sync_data()?;
        let mut runtime = entry
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        runtime.index.logical_len = Some(expected_len.unwrap_or(offset));
        runtime.index.add_range(0, offset);
        persist_index_path(&entry.index_path, &runtime.index)
    }
    .await;
    let failure = outcome.err();
    {
        let mut runtime = entry
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        runtime.sequential_active = false;
        if control.is_cancelled() || failure.is_some() {
            runtime.index = SegmentIndex::empty();
            let _ = data.set_len(0);
            let _ = data.sync_data();
        }
        let _ = persist_index_path(&entry.index_path, &runtime.index);
        if let Some(error) = failure {
            control.fail(format!("连续音频下载失败: {error}"));
        }
    }
    entry.notify.notify_all();
}

fn reset_entry(entry: &SegmentEntry) -> io::Result<()> {
    let mut runtime = entry
        .runtime
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let data = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&entry.data_path)?;
    data.set_len(0)?;
    data.sync_data()?;
    runtime.index = SegmentIndex::empty();
    runtime.sequential_active = false;
    persist_index_path(&entry.index_path, &runtime.index)?;
    drop(runtime);
    entry.notify.notify_all();
    Ok(())
}

fn cache_key(identity: Option<&str>) -> Result<String, String> {
    let Some(identity) = identity
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
    else {
        return Ok(uuid::Uuid::new_v4().simple().to_string());
    };
    if identity.len() > MAX_CACHE_IDENTITY_BYTES {
        return Err("音频缓存身份超过 8 KiB 上限".to_string());
    }
    let mut digest = Sha256::new();
    digest.update(b"cadilume-native-audio-segment-cache-v2\0");
    digest.update(identity.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn build_http_clients() -> Result<(Client, Client), String> {
    let range_client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(NETWORK_IDLE_TIMEOUT)
        .timeout(NETWORK_IDLE_TIMEOUT)
        .build()
        .map_err(|error| format!("创建分段媒体客户端失败: {error}"))?;
    let sequential_client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(NETWORK_IDLE_TIMEOUT)
        .read_timeout(NETWORK_IDLE_TIMEOUT)
        .build()
        .map_err(|error| format!("创建连续媒体客户端失败: {error}"))?;
    Ok((range_client, sequential_client))
}

fn persist_index_path(path: &Path, index: &SegmentIndex) -> io::Result<()> {
    let bytes = serde_json::to_vec(index).map_err(io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    match std::fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if path.exists() {
                std::fs::remove_file(path)?;
                std::fs::rename(&temporary, path)
            } else {
                Err(first_error)
            }
        }
    }
}

fn read_index(path: &Path) -> Option<SegmentIndex> {
    let bytes = std::fs::read(path).ok()?;
    let mut index = serde_json::from_slice::<SegmentIndex>(&bytes).ok()?;
    index.normalize();
    index.valid().then_some(index)
}

fn remove_legacy_cache(cache_root: &Path) -> Result<(), String> {
    let legacy = cache_root.join("downloads");
    match std::fs::remove_dir_all(&legacy) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清理旧版音频缓存失败: {error}")),
    }
}

fn recover_entries(entries_root: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(entries_root)
        .map_err(|error| format!("读取分段缓存目录失败: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            let _ = std::fs::remove_file(path);
            continue;
        }
        let index_path = path.join("index.json");
        let data_path = path.join("media.sparse");
        let temporary = path.join("index.json.tmp");
        let _ = std::fs::remove_file(temporary);
        let recovered = (|| -> io::Result<bool> {
            let Some(index) = read_index(&index_path) else {
                return Ok(false);
            };
            let metadata = std::fs::metadata(&data_path)?;
            let length_matches = index
                .logical_len
                .map_or(index.ranges.is_empty() && metadata.len() == 0, |length| {
                    metadata.len() == length
                });
            let resumable = index.range_supported != Some(false) || index.complete();
            if !length_matches || !resumable {
                return Ok(false);
            }
            if let Some(logical_len) = index.logical_len {
                let data = OpenOptions::new().read(true).write(true).open(&data_path)?;
                mark_sparse_file(&data)?;
                punch_uncommitted_holes(&data, &index, logical_len)?;
                data.sync_data()?;
            }
            Ok(true)
        })();
        if !matches!(recovered, Ok(true)) {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    Ok(())
}

fn cache_status(entries_root: &Path) -> CacheStatus {
    let Ok(entries) = std::fs::read_dir(entries_root) else {
        return CacheStatus::default();
    };
    let mut status = CacheStatus::default();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(index) = read_index(&path.join("index.json")) else {
            continue;
        };
        let allocated = entry_allocated_bytes(&path);
        status.allocated_bytes = status.allocated_bytes.saturating_add(allocated);
        if index.complete() {
            status.complete_entries += 1;
        } else if !index.ranges.is_empty() {
            status.partial_entries += 1;
            status.partial_bytes = status.partial_bytes.saturating_add(allocated);
        }
    }
    status
}

fn entry_allocated_bytes(path: &Path) -> u64 {
    [path.join("media.sparse"), path.join("index.json")]
        .into_iter()
        .filter_map(|path| {
            let file = File::open(path).ok()?;
            Some(
                fs2::FileExt::allocated_size(&file)
                    .or_else(|_| file.metadata().map(|metadata| metadata.len()))
                    .unwrap_or(0),
            )
        })
        .fold(0u64, u64::saturating_add)
}

#[cfg(target_os = "windows")]
fn mark_sparse_file(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Ioctl::FSCTL_SET_SPARSE;
    use windows::Win32::System::IO::DeviceIoControl;

    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            HANDLE(file.as_raw_handle()),
            FSCTL_SET_SPARSE,
            None,
            0,
            None,
            0,
            Some(&mut returned),
            None,
        )
        .map_err(|error| io::Error::other(format!("Windows 稀疏文件标记失败: {error}")))
    }
}

#[cfg(not(target_os = "windows"))]
fn mark_sparse_file(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn punch_uncommitted_holes(file: &File, index: &SegmentIndex, logical_len: u64) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let mut cursor = 0u64;
    for range in &index.ranges {
        if cursor < range.start {
            punch_hole(file.as_raw_fd(), cursor, range.start - cursor)?;
        }
        cursor = cursor.max(range.end);
    }
    if cursor < logical_len {
        punch_hole(file.as_raw_fd(), cursor, logical_len - cursor)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn punch_hole(file_descriptor: std::os::fd::RawFd, offset: u64, length: u64) -> io::Result<()> {
    if length == 0 {
        return Ok(());
    }
    let mut request = libc::fpunchhole_t {
        fp_flags: 0,
        reserved: 0,
        fp_offset: offset
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "稀疏区间起点过大"))?,
        fp_length: length
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "稀疏区间长度过大"))?,
    };
    let result = unsafe { libc::fcntl(file_descriptor, libc::F_PUNCHHOLE, &mut request) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn punch_uncommitted_holes(file: &File, index: &SegmentIndex, logical_len: u64) -> io::Result<()> {
    let mut cursor = 0u64;
    for range in &index.ranges {
        if cursor < range.start {
            punch_hole(file, cursor, range.start - cursor)?;
        }
        cursor = cursor.max(range.end);
    }
    if cursor < logical_len {
        punch_hole(file, cursor, logical_len - cursor)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn punch_hole(file: &File, offset: u64, length: u64) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Ioctl::{FILE_ZERO_DATA_INFORMATION, FSCTL_SET_ZERO_DATA};
    use windows::Win32::System::IO::DeviceIoControl;

    if length == 0 {
        return Ok(());
    }
    mark_sparse_file(file)?;
    let range = FILE_ZERO_DATA_INFORMATION {
        FileOffset: offset
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "稀疏区间起点过大"))?,
        BeyondFinalZero: offset
            .checked_add(length)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "稀疏区间终点溢出"))?
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "稀疏区间终点过大"))?,
    };
    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            HANDLE(file.as_raw_handle()),
            FSCTL_SET_ZERO_DATA,
            Some((&range as *const FILE_ZERO_DATA_INFORMATION).cast()),
            std::mem::size_of::<FILE_ZERO_DATA_INFORMATION>() as u32,
            None,
            0,
            Some(&mut returned),
            None,
        )
        .map_err(|error| io::Error::other(format!("Windows 稀疏区间回收失败: {error}")))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn punch_uncommitted_holes(
    _file: &File,
    _index: &SegmentIndex,
    _logical_len: u64,
) -> io::Result<()> {
    Ok(())
}

struct EvictionCandidate {
    key: String,
    path: PathBuf,
    modified: SystemTime,
}

fn eviction_candidates(entries_root: &Path) -> Vec<EvictionCandidate> {
    let Ok(entries) = std::fs::read_dir(entries_root) else {
        return Vec::new();
    };
    let mut candidates = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let key = entry.file_name().to_string_lossy().into_owned();
            let modified = std::fs::metadata(path.join("index.json"))
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            Some(EvictionCandidate {
                key,
                path,
                modified,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| candidate.modified);
    candidates
}

fn touch(path: &Path) {
    let _ = filetime::set_file_mtime(path, filetime::FileTime::now());
}

fn header_string(value: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    value
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validator_changed(previous: &Option<String>, current: &Option<String>) -> bool {
    matches!((previous, current), (Some(previous), Some(current)) if previous != current)
}

fn fetch_range_bounds(position: u64, logical_len: Option<u64>) -> (u64, u64) {
    let (start, end) = if position < INITIAL_HEAD_BYTES {
        (0, INITIAL_HEAD_BYTES)
    } else {
        let aligned_start = position / SEGMENT_FETCH_BYTES * SEGMENT_FETCH_BYTES;
        (
            aligned_start.max(INITIAL_HEAD_BYTES),
            aligned_start.saturating_add(SEGMENT_FETCH_BYTES),
        )
    };
    (start, logical_len.map_or(end, |length| end.min(length)))
}

fn parse_content_range(value: &str) -> Option<ParsedContentRange> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, inclusive_end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let inclusive_end = inclusive_end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    if start > inclusive_end || inclusive_end >= total {
        return None;
    }
    Some(ParsedContentRange {
        start,
        end: inclusive_end.saturating_add(1),
        total,
    })
}

fn parse_unsatisfied_content_range(value: &str) -> Option<u64> {
    value.strip_prefix("bytes */")?.parse::<u64>().ok()
}

fn range_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "分段下载超时".to_string()
    } else if error.is_connect() {
        "分段下载连接失败".to_string()
    } else if error.is_body() {
        "分段下载数据中断".to_string()
    } else {
        "分段下载请求失败".to_string()
    }
}

fn interrupted_error() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "分段媒体网络读取已取消")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    fn temporary_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cadilume-segment-cache-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    fn range_server(
        data: Arc<Vec<u8>>,
        expected_requests: usize,
    ) -> (
        String,
        Arc<Mutex<Vec<(usize, usize)>>>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);
        let handle = std::thread::spawn(move || {
            for _ in 0..expected_requests {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                let range = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .or_else(|| {
                        request
                            .lines()
                            .find_map(|line| line.strip_prefix("Range: bytes="))
                    })
                    .unwrap();
                let (start, end) = range.split_once('-').unwrap();
                let start = start.parse::<usize>().unwrap();
                let end = end
                    .parse::<usize>()
                    .unwrap()
                    .min(data.len().saturating_sub(1));
                requests_for_thread.lock().unwrap().push((start, end));
                let body = &data[start..=end];
                write!(
                    stream,
                    "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nAccept-Ranges: bytes\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\n",
                    body.len(),
                    data.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
                stream.flush().unwrap();
            }
        });
        (format!("http://{address}/audio"), requests, handle)
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8(request).unwrap()
    }

    fn requested_range(request: &str, data_len: usize) -> (usize, usize) {
        let range = request
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("range")
                    .then_some(value.trim())?
                    .strip_prefix("bytes=")
            })
            .unwrap();
        let (start, end) = range.split_once('-').unwrap();
        let start = start.parse::<usize>().unwrap();
        let end = end
            .parse::<usize>()
            .unwrap()
            .min(data_len.saturating_sub(1));
        (start, end)
    }

    fn scripted_server<F>(
        expected_requests: usize,
        handler: F,
    ) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>)
    where
        F: Fn(usize, &str, &mut TcpStream) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);
        let handle = std::thread::spawn(move || {
            for index in 0..expected_requests {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                requests_for_thread.lock().unwrap().push(request.clone());
                handler(index, &request, &mut stream);
            }
        });
        (format!("http://{address}/audio"), requests, handle)
    }

    #[test]
    fn ranges_are_merged_and_complete_only_at_full_coverage() {
        let mut index = SegmentIndex::empty();
        index.logical_len = Some(100);
        index.add_range(40, 60);
        index.add_range(0, 20);
        index.add_range(20, 45);
        assert_eq!(index.ranges, vec![ByteRange { start: 0, end: 60 }]);
        assert!(!index.complete());
        index.add_range(60, 100);
        assert!(index.complete());
    }

    #[test]
    fn sparse_logical_length_is_not_reported_as_allocated_usage() {
        let root = temporary_root("sparse-size");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let entry = cache.inner.open_entry("entry").unwrap();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&entry.data_path)
            .unwrap();
        file.set_len(8 * 1024 * 1024).unwrap();
        let status = cache.status();
        assert!(status.allocated_bytes < 1024 * 1024);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_or_uncommitted_entries_are_removed_on_recovery() {
        let root = temporary_root("recovery");
        let entries = root.join("segments-v2");
        let broken = entries.join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("media.sparse"), b"orphan").unwrap();
        std::fs::write(broken.join("index.json.tmp"), b"partial").unwrap();

        let no_range_partial = entries.join("no-range-partial");
        std::fs::create_dir_all(&no_range_partial).unwrap();
        let no_range_data = File::create(no_range_partial.join("media.sparse")).unwrap();
        no_range_data.set_len(10).unwrap();
        let mut no_range_index = SegmentIndex::empty();
        no_range_index.logical_len = Some(10);
        no_range_index.range_supported = Some(false);
        no_range_index.add_range(0, 5);
        persist_index_path(&no_range_partial.join("index.json"), &no_range_index).unwrap();

        let truncated = entries.join("truncated");
        std::fs::create_dir_all(&truncated).unwrap();
        std::fs::write(truncated.join("media.sparse"), b"short").unwrap();
        let mut truncated_index = SegmentIndex::empty();
        truncated_index.logical_len = Some(10);
        truncated_index.range_supported = Some(true);
        truncated_index.add_range(0, 10);
        persist_index_path(&truncated.join("index.json"), &truncated_index).unwrap();

        let cache = SegmentCache::new_with_policy(root.clone(), 1024 * 1024, 0).unwrap();
        assert!(!broken.exists());
        assert!(!no_range_partial.exists());
        assert!(!truncated.exists());
        assert_eq!(cache.status(), CacheStatus::default());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recovery_punches_bytes_that_were_synced_before_the_index_commit() {
        let root = temporary_root("recovery-uncommitted-range");
        let entry = root.join("segments-v2").join("entry");
        std::fs::create_dir_all(&entry).unwrap();
        let data_path = entry.join("media.sparse");
        let mut data = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&data_path)
            .unwrap();
        let logical_len = 8 * 1024 * 1024;
        data.set_len(logical_len).unwrap();
        data.seek(SeekFrom::Start(0)).unwrap();
        data.write_all(&vec![3u8; 64 * 1024]).unwrap();
        data.seek(SeekFrom::Start(4 * 1024 * 1024)).unwrap();
        data.write_all(&vec![9u8; 64 * 1024]).unwrap();
        data.sync_data().unwrap();
        drop(data);

        let mut index = SegmentIndex::empty();
        index.logical_len = Some(logical_len);
        index.range_supported = Some(true);
        index.add_range(0, 64 * 1024);
        persist_index_path(&entry.join("index.json"), &index).unwrap();

        let _cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let mut recovered = File::open(data_path).unwrap();
        let mut committed = [0u8; 16];
        recovered.read_exact(&mut committed).unwrap();
        assert_eq!(committed, [3u8; 16]);
        recovered.seek(SeekFrom::Start(4 * 1024 * 1024)).unwrap();
        let mut uncommitted = [1u8; 16];
        recovered.read_exact(&mut uncommitted).unwrap();
        assert_eq!(uncommitted, [0u8; 16]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fixed_product_limit_is_one_gibibyte() {
        assert_eq!(AUDIO_CACHE_LIMIT_BYTES, 1_073_741_824);
    }

    #[test]
    fn reader_fetches_only_the_head_and_seek_target_ranges() {
        let root = temporary_root("range-reader");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let data = Arc::new(
            (0..5 * 1024 * 1024)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let (source, requests, server) = range_server(Arc::clone(&data), 2);
        let mut reader = cache
            .open_reader(Some("range-fixture"), &source, CachePriority::Current)
            .unwrap();
        assert_eq!(reader.prefetch_head().unwrap(), Some(data.len() as u64));
        let mut head = [0u8; 32];
        reader.read_exact(&mut head).unwrap();
        assert_eq!(&head, &data[..head.len()]);
        let seek_position = 4 * 1024 * 1024 + 123;
        reader.seek(SeekFrom::Start(seek_position as u64)).unwrap();
        let mut tail = [0u8; 64];
        reader.read_exact(&mut tail).unwrap();
        assert_eq!(&tail, &data[seek_position..seek_position + tail.len()]);
        server.join().unwrap();
        assert_eq!(
            *requests.lock().unwrap(),
            vec![
                (0, INITIAL_HEAD_BYTES as usize - 1),
                (4 * 1024 * 1024, data.len() - 1),
            ]
        );

        let status = cache.status();
        assert_eq!(status.partial_entries, 1);
        assert!(status.allocated_bytes < data.len() as u64);

        let mut cached = cache
            .open_reader(Some("range-fixture"), &source, CachePriority::Current)
            .unwrap();
        cached.seek(SeekFrom::Start(seek_position as u64)).unwrap();
        let mut cached_tail = [0u8; 64];
        cached.read_exact(&mut cached_tail).unwrap();
        assert_eq!(cached_tail, tail);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reader_completes_a_short_partial_head_without_refetching_cached_bytes() {
        let root = temporary_root("short-partial-head");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let data = Arc::new(vec![17u8; 512 * 1024]);
        let data_for_server = Arc::clone(&data);
        let (source, requests, server) = scripted_server(2, move |index, request, stream| {
            let (requested_start, requested_end) = requested_range(request, data_for_server.len());
            let (start, end) = if index == 0 {
                assert_eq!((requested_start, requested_end), (0, 256 * 1024 - 1));
                (0, 128 * 1024 - 1)
            } else {
                assert_eq!(
                    (requested_start, requested_end),
                    (128 * 1024, 256 * 1024 - 1)
                );
                (requested_start, requested_end)
            };
            let body = &data_for_server[start..=end];
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nETag: \"fixture-v1\"\r\nConnection: close\r\n\r\n",
                body.len(),
                data_for_server.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let mut reader = cache
            .open_reader(Some("short-partial-head"), &source, CachePriority::Current)
            .unwrap();
        assert_eq!(reader.prefetch_head().unwrap(), Some(data.len() as u64));
        let mut head = vec![0u8; INITIAL_HEAD_BYTES as usize];
        reader.read_exact(&mut head).unwrap();
        assert_eq!(head, data[..head.len()]);
        server.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn truncated_range_is_rejected_without_committing_bytes() {
        let root = temporary_root("truncated-range");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let (source, _, server) = scripted_server(1, |_index, _request, stream| {
            let body = vec![7u8; 512];
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 0-1023/4096\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        let mut reader = cache
            .open_reader(Some("truncated"), &source, CachePriority::Current)
            .unwrap();
        let error = reader.prefetch_head().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert!(reader.entry.runtime.lock().unwrap().index.ranges.is_empty());
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reader_latches_non_interrupted_network_failures() {
        let root = temporary_root("latched-reader-failure");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let (source, _, server) = scripted_server(1, |_index, _request, stream| {
            let body = vec![7u8; 512];
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 0-1023/4096\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        let mut reader = cache
            .open_reader(
                Some("latched-reader-failure"),
                &source,
                CachePriority::Current,
            )
            .unwrap();
        let control = reader.control();
        let error = reader.read(&mut [0u8; 32]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert!(control.failure().is_some());
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn changed_validator_discards_old_ranges_before_retry() {
        let root = temporary_root("validator-change");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let data = Arc::new(
            (0..4 * 1024 * 1024)
                .map(|index| (index % 239) as u8)
                .collect::<Vec<_>>(),
        );
        let data_for_server = Arc::clone(&data);
        let (source, requests, server) = scripted_server(3, move |index, request, stream| {
            let (start, end) = requested_range(request, data_for_server.len());
            let body = &data_for_server[start..=end];
            let etag = if index == 0 {
                "fixture-v1"
            } else {
                "fixture-v2"
            };
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nETag: \"{etag}\"\r\nConnection: close\r\n\r\n",
                body.len(),
                data_for_server.len()
            )
            .unwrap();
            let _ = stream.write_all(body);
        });
        let mut reader = cache
            .open_reader(Some("validator"), &source, CachePriority::Current)
            .unwrap();
        reader.prefetch_head().unwrap();
        reader.seek(SeekFrom::Start(3 * 1024 * 1024)).unwrap();
        let mut byte = [0u8; 1];
        let error = reader.read(&mut byte).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(reader.entry.runtime.lock().unwrap().index.ranges.is_empty());
        drop(reader);

        let mut retried = cache
            .open_reader(Some("validator"), &source, CachePriority::Current)
            .unwrap();
        retried.prefetch_head().unwrap();
        retried.read_exact(&mut byte).unwrap();
        assert_eq!(byte[0], data[0]);
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("if-range: \"fixture-v1\""));
        assert!(!requests[2].to_ascii_lowercase().contains("if-range:"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn range_not_satisfiable_records_logical_length() {
        let root = temporary_root("range-416");
        let cache = SegmentCache::new_with_policy(root.clone(), 1024 * 1024, 0).unwrap();
        let (source, _, server) = scripted_server(1, |_index, _request, stream| {
            write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */123\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let mut reader = cache
            .open_reader(Some("range-416"), &source, CachePriority::Current)
            .unwrap();
        reader.seek(SeekFrom::Start(200)).unwrap();
        assert_eq!(reader.read(&mut [0u8; 1]).unwrap(), 0);
        assert_eq!(reader.logical_len(), Some(123));
        assert_eq!(
            reader.entry.runtime.lock().unwrap().index.range_supported,
            Some(true)
        );
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn current_track_uses_sequential_fallback_when_range_is_ignored() {
        let root = temporary_root("sequential-fallback");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let data = Arc::new(vec![11u8; 512 * 1024]);
        let data_for_server = Arc::clone(&data);
        let (source, requests, server) = scripted_server(2, move |_index, _request, stream| {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"no-range\"\r\nConnection: close\r\n\r\n",
                data_for_server.len()
            )
            .unwrap();
            let _ = stream.write_all(&data_for_server);
        });
        let mut reader = cache
            .open_reader(Some("no-range-current"), &source, CachePriority::Current)
            .unwrap();
        assert_eq!(reader.prefetch_head().unwrap(), Some(data.len() as u64));
        let mut downloaded = Vec::new();
        reader.read_to_end(&mut downloaded).unwrap();
        assert_eq!(downloaded, *data);
        server.join().unwrap();
        let requests = requests.lock().unwrap();
        assert!(requests[0].to_ascii_lowercase().contains("range: bytes="));
        assert!(!requests[1].to_ascii_lowercase().contains("range: bytes="));
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while cache.status().complete_entries == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(cache.status().complete_entries, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn next_track_never_falls_back_to_a_complete_download() {
        let root = temporary_root("next-no-range");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let (source, requests, server) = scripted_server(1, |_index, _request, stream| {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest"
            )
            .unwrap();
        });
        let mut reader = cache
            .open_reader(Some("no-range-next"), &source, CachePriority::Next)
            .unwrap();
        assert_eq!(
            reader.prefetch_head().unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        server.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(
            reader.entry.runtime.lock().unwrap().index.range_supported,
            Some(false)
        );
        assert_eq!(cache.status().partial_entries, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn promoted_next_reader_uses_current_track_fallback_rules() {
        let root = temporary_root("promoted-next-reader");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let data = Arc::new(vec![13u8; 512 * 1024]);
        let data_for_server = Arc::clone(&data);
        let (source, requests, server) = scripted_server(2, move |_index, _request, stream| {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data_for_server.len()
            )
            .unwrap();
            let _ = stream.write_all(&data_for_server);
        });
        let mut reader = cache
            .open_reader(Some("promoted-next-reader"), &source, CachePriority::Next)
            .unwrap();
        let control = reader.control();
        control.promote_to_current();

        assert_eq!(reader.prefetch_head().unwrap(), Some(data.len() as u64));
        let mut first = [0u8; 32];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(&first, &data[..first.len()]);
        server.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cancellation_interrupts_waiting_reader_and_discards_sequential_partial() {
        let root = temporary_root("cancel-sequential");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut range_stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut range_stream);
            write!(
                range_stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 524288\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            drop(range_stream);

            let (mut sequential_stream, _) = listener.accept().unwrap();
            let request = read_request(&mut sequential_stream);
            assert!(!request.to_ascii_lowercase().contains("range: bytes="));
            write!(
                sequential_stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 524288\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            sequential_stream.write_all(&vec![5u8; 64 * 1024]).unwrap();
            sequential_stream.flush().unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            let _ = sequential_stream.write_all(&vec![5u8; 64 * 1024]);
        });
        let source = format!("http://{address}/audio");
        let second_data = Arc::new(vec![9u8; 512 * 1024]);
        let (second_source, _, second_server) = range_server(second_data, 1);
        let reader = cache
            .open_reader(Some("cancel-sequential"), &source, CachePriority::Current)
            .unwrap();
        assert_eq!(
            cache.active_operations(),
            1,
            "reader lifetime must keep the cache operation active"
        );
        let control = reader.control();
        let entry = Arc::clone(&reader.entry);
        let waiting = std::thread::spawn(move || {
            let mut reader = reader;
            reader.prefetch_head()
        });
        ready_rx.recv().unwrap();
        let activity_start_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while cache.active_operations() < 2 && std::time::Instant::now() < activity_start_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            cache.active_operations(),
            2,
            "the waiting reader and detached sequential download must be tracked independently"
        );
        control.cancel();
        let error = waiting.join().unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        let activity_deadline = std::time::Instant::now() + Duration::from_secs(1);
        while cache.active_operations() != 0 && std::time::Instant::now() < activity_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            cache.active_operations(),
            0,
            "cancel must finish both reader and sequential-download cleanup"
        );
        assert!(
            entry.runtime.lock().unwrap().index.ranges.is_empty(),
            "cancelled sequential partial must be discarded before reload"
        );
        let second_cache = cache.clone();
        let (second_tx, second_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = second_cache
                .open_reader(
                    Some("cancel-sequential"),
                    &second_source,
                    CachePriority::Current,
                )
                .and_then(|mut reader| reader.prefetch_head().map_err(|error| error.to_string()));
            let _ = second_tx.send(result);
        });
        assert_eq!(
            second_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("取消应在旧响应仍挂起时释放唯一网络许可")
                .unwrap(),
            Some(512 * 1024)
        );
        second_server.join().unwrap();
        release_tx.send(()).unwrap();
        server.join().unwrap();
        assert!(
            !entry.runtime.lock().unwrap().index.ranges.is_empty(),
            "old sequential cleanup must not truncate the reloaded cache entry"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lru_evicts_oldest_inactive_segment_entry() {
        let root = temporary_root("lru");
        let cache = SegmentCache::new_with_policy(root.clone(), 80 * 1024, 0).unwrap();
        let old = cache.inner.open_entry("old").unwrap();
        let recent = cache.inner.open_entry("recent").unwrap();
        std::fs::write(&old.data_path, vec![1u8; 64 * 1024]).unwrap();
        std::fs::write(&recent.data_path, vec![2u8; 64 * 1024]).unwrap();
        let old_path = old.index_path.clone();
        let recent_path = recent.index_path.clone();
        let old_dir = old.data_path.parent().unwrap().to_path_buf();
        let recent_dir = recent.data_path.parent().unwrap().to_path_buf();
        drop(old);
        drop(recent);
        filetime::set_file_mtime(&old_path, filetime::FileTime::from_unix_time(1, 0)).unwrap();
        filetime::set_file_mtime(&recent_path, filetime::FileTime::from_unix_time(2, 0)).unwrap();
        assert!(cache.inner.ensure_capacity(0, None));
        assert!(!old_dir.exists());
        assert!(recent_dir.exists());
        assert!(cache.status().allocated_bytes <= 80 * 1024);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn low_disk_reserve_rejects_new_cache_writes() {
        let root = temporary_root("low-disk");
        let cache =
            SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, u64::MAX).unwrap();
        assert!(!cache.inner.ensure_capacity(1, None));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn clear_recreates_v2_root_and_removes_legacy_cache() {
        let root = temporary_root("clear");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let entry = cache.inner.open_entry("entry").unwrap();
        std::fs::write(&entry.data_path, b"cached").unwrap();
        drop(entry);
        let legacy = root.join("downloads");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("old.audio"), b"legacy").unwrap();
        cache.clear().unwrap();
        assert_eq!(cache.status(), CacheStatus::default());
        assert!(root.join("segments-v2").is_dir());
        assert!(!legacy.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_media_file_is_sparse_and_counts_allocated_bytes() {
        let root = temporary_root("windows-sparse-allocation");
        let cache = SegmentCache::new_with_policy(root.clone(), 16 * 1024 * 1024, 0).unwrap();
        let entry = cache.inner.open_entry("entry").unwrap();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&entry.data_path)
            .unwrap();
        file.set_len(8 * 1024 * 1024).unwrap();
        assert!(fs2::FileExt::allocated_size(&file).unwrap() < 8 * 1024 * 1024);
        drop(file);
        drop(entry);
        assert!(cache.status().allocated_bytes < 8 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(root);
    }
}

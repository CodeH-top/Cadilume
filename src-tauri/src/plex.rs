use std::{
    collections::{HashMap, HashSet},
    fs::{self, FileTimes, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, RwLock,
    },
    time::{Duration, SystemTime},
};

use anyhow::{anyhow, Context, Result};
use quick_xml::de::from_str as from_xml_str;
use reqwest::{
    header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE},
    redirect::Policy,
    Client, Method, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use url::Url;
use uuid::Uuid;

use crate::{audio_engine::NativeAudioEngineSlot, stream_proxy::StreamProxy};

const PRODUCT_NAME: &str = "Cadilume";
const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");
const PLEX_TV: &str = "https://plex.tv";
#[cfg(not(debug_assertions))]
const KEYRING_SERVICE: &str = "top.codeh.cadilume";
#[cfg(not(debug_assertions))]
const KEYRING_ACCOUNT: &str = "cadilume-account-token";
const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const MAX_ARTWORK_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_NAMESPACE_DIR: &str = "cadilume";
const ARTWORK_CACHE_DIR: &str = "artwork";
const ARTWORK_CACHE_EXTENSION: &str = "cadart";
const ARTWORK_CACHE_MAGIC: &[u8; 8] = b"CADART01";
const MAX_CACHE_MIME_BYTES: usize = 127;
const MAX_DEVICE_NAME_CHARACTERS: usize = 80;
const MAX_PLAYLIST_BATCH_TRACKS: usize = 10_000;
const FALLBACK_DEVICE_NAME: &str = "Desktop";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistBatchAddResult {
    requested: usize,
    added: usize,
    failed_rating_keys: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistBatchRemoveResult {
    requested: usize,
    removed: usize,
    failed_item_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedConfig {
    client_identifier: String,
    #[serde(default = "default_status_icon_enabled")]
    status_icon_enabled: bool,
    #[serde(default)]
    device_name: String,
    #[serde(default)]
    brand_preset: BrandPreset,
}

impl Default for PersistedConfig {
    fn default() -> Self {
        Self {
            client_identifier: Uuid::new_v4().to_string(),
            status_icon_enabled: default_status_icon_enabled(),
            device_name: default_device_name(),
            brand_preset: BrandPreset::Amber,
        }
    }
}

const fn default_status_icon_enabled() -> bool {
    true
}

fn strip_retired_config_values(value: &mut Value) -> bool {
    let Some(config) = value.as_object_mut() else {
        return false;
    };
    let removed_sync_recent_plays = config.remove("syncRecentPlays").is_some();
    let removed_close_behavior = config.remove("closeBehavior").is_some();
    let removed_audio_cache_limit = config.remove("audioCacheLimitGib").is_some();
    removed_sync_recent_plays || removed_close_behavior || removed_audio_cache_limit
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusIconPlatform {
    #[cfg(target_os = "macos")]
    Macos,
    #[cfg(target_os = "windows")]
    Windows,
}

pub(crate) const fn status_icon_platform() -> Option<StatusIconPlatform> {
    #[cfg(target_os = "macos")]
    {
        Some(StatusIconPlatform::Macos)
    }
    #[cfg(target_os = "windows")]
    {
        Some(StatusIconPlatform::Windows)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Names used in Plex's device UI travel in request headers, so reject control
/// characters and keep the value bounded before it is persisted or sent.
fn normalize_device_name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(anyhow!("设备名称不能为空"));
    }
    if value.chars().any(char::is_control) {
        return Err(anyhow!("设备名称不能包含控制字符"));
    }

    let mut normalized = String::new();
    let mut previous_whitespace = false;
    for character in value.chars() {
        if character.is_whitespace() {
            if !previous_whitespace {
                normalized.push(' ');
            }
            previous_whitespace = true;
        } else {
            normalized.push(character);
            previous_whitespace = false;
        }
    }

    if normalized.is_empty() || normalized.chars().count() > MAX_DEVICE_NAME_CHARACTERS {
        return Err(anyhow!(
            "设备名称需为 1–{MAX_DEVICE_NAME_CHARACTERS} 个有效字符"
        ));
    }
    Ok(normalized)
}

fn default_device_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
        {
            if output.status.success() {
                if let Ok(name) = String::from_utf8(output.stdout) {
                    if let Ok(name) = normalize_device_name(&name) {
                        return name;
                    }
                }
            }
        }
    }

    let environment_key = if cfg!(target_os = "windows") {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    };
    std::env::var(environment_key)
        .ok()
        .and_then(|name| normalize_device_name(&name).ok())
        .unwrap_or_else(|| FALLBACK_DEVICE_NAME.to_string())
}

fn normalize_persisted_device_name(config: &mut PersistedConfig) -> bool {
    let previous = config.device_name.clone();
    let normalized = normalize_device_name(&previous).unwrap_or_else(|_| default_device_name());
    config.device_name = normalized;
    config.device_name != previous
}

fn write_persisted_config(path: &Path, config: &PersistedConfig) -> Result<()> {
    fs::write(path, serde_json::to_vec_pretty(config)?).context("无法保存 Cadilume 配置")
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrandPreset {
    #[serde(alias = "plex")]
    #[default]
    Amber,
    #[serde(alias = "emby")]
    Verdant,
    #[serde(alias = "jellyfin")]
    Azure,
}

#[derive(Debug, Clone)]
struct CachedConnection {
    uri: String,
    local: bool,
    relay: bool,
    secure: bool,
}

#[derive(Debug, Clone)]
struct CachedServer {
    token: String,
    connections: Vec<CachedConnection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerAttemptFailure {
    HttpResponse,
    Connect,
    OtherTransport,
}

#[derive(Debug, Clone)]
pub(crate) struct StreamConnectionSnapshot {
    pub(crate) uri: String,
    pub(crate) local: bool,
    pub(crate) relay: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct StreamServerSnapshot {
    pub(crate) token: String,
    pub(crate) connections: Vec<StreamConnectionSnapshot>,
}

pub struct PlexState {
    protected_client: Client,
    config_path: PathBuf,
    cache_dir: PathBuf,
    cache_lock: RwLock<()>,
    config: Mutex<PersistedConfig>,
    client_identifier: String,
    status_icon_enabled: AtomicBool,
    token: RwLock<Option<String>>,
    servers: RwLock<HashMap<String, CachedServer>>,
}

impl PlexState {
    pub fn load(config_dir: PathBuf, app_cache_dir: PathBuf) -> Result<Self> {
        let config_path = config_dir.join("config.json");
        let cache_dir = initialize_artwork_cache_dir(&app_cache_dir)?;
        let (mut config, mut should_persist_config) = match fs::read_to_string(&config_path) {
            Ok(raw) => {
                let mut value =
                    serde_json::from_str::<Value>(&raw).context("无法解析 Cadilume 配置")?;
                let removed_retired_value = strip_retired_config_values(&mut value);
                (
                    serde_json::from_value::<PersistedConfig>(value)
                        .context("无法解析 Cadilume 配置")?,
                    removed_retired_value,
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (PersistedConfig::default(), true)
            }
            Err(error) => return Err(error).context("无法读取 Cadilume 配置"),
        };
        should_persist_config |= normalize_persisted_device_name(&mut config);
        if should_persist_config {
            write_persisted_config(&config_path, &config)?;
        }

        // Dev builds read only the plaintext fallback file; release builds use
        // the Keychain exclusively. The two credential stores never mix.
        let token = read_account_token();
        let protected_client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .redirect(Policy::none())
            .user_agent(format!("{PRODUCT_NAME}/{PRODUCT_VERSION}"))
            .build()?;

        Ok(Self {
            protected_client,
            config_path,
            cache_dir,
            cache_lock: RwLock::new(()),
            config: Mutex::new(config.clone()),
            client_identifier: config.client_identifier.clone(),
            status_icon_enabled: AtomicBool::new(config.status_icon_enabled),
            token: RwLock::new(token),
            servers: RwLock::new(HashMap::new()),
        })
    }

    pub fn status_icon_enabled(&self) -> bool {
        self.status_icon_enabled.load(Ordering::SeqCst)
    }

    fn token(&self) -> Result<String> {
        self.token
            .read()
            .map_err(|_| anyhow!("登录状态读取失败"))?
            .clone()
            .ok_or_else(|| anyhow!("尚未登录 Plex"))
    }

    fn save_status_icon_enabled(&self, enabled: bool) -> Result<()> {
        self.update_preferences(|config| config.status_icon_enabled = enabled)
    }

    fn save_brand_preset(&self, preset: BrandPreset) -> Result<()> {
        self.update_preferences(|config| config.brand_preset = preset)
    }

    fn save_device_name(&self, device_name: String) -> Result<()> {
        self.update_preferences(|config| config.device_name = device_name)
    }

    fn update_preferences(&self, update: impl FnOnce(&mut PersistedConfig)) -> Result<()> {
        let mut config = self
            .config
            .lock()
            .map_err(|_| anyhow!("配置写入锁定失败"))?;
        let previous = config.clone();
        update(&mut config);
        if let Err(error) = write_persisted_config(&self.config_path, &config) {
            *config = previous;
            return Err(error);
        }
        self.status_icon_enabled
            .store(config.status_icon_enabled, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn brand_preset(&self) -> BrandPreset {
        self.config
            .lock()
            .map(|config| config.brand_preset)
            .unwrap_or_default()
    }

    fn device_name(&self) -> String {
        self.config
            .lock()
            .map(|config| config.device_name.clone())
            .unwrap_or_else(|_| default_device_name())
    }

    pub(crate) fn plex_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        self.plex_identity_headers(request)
            .header(ACCEPT, "application/json")
    }

    pub(crate) fn plex_identity_headers(
        &self,
        request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        let device_name = self.device_name();
        apply_plex_identity_headers(request, &self.client_identifier, &device_name)
    }

    async fn account(&self, token: &str) -> Result<Account> {
        let response = self
            .plex_headers(self.protected_client.get(format!("{PLEX_TV}/api/v2/user")))
            .header("X-Plex-Token", token)
            .send()
            .await?;
        let response = ensure_success(response, "读取 Plex 账号失败").await?;
        let value = response.json::<Value>().await?;
        Ok(Account::from_json(&value))
    }

    async fn server_response(
        &self,
        server_id: &str,
        path: &str,
        query: &HashMap<String, String>,
    ) -> Result<Response> {
        self.server_request_response(server_id, Method::GET, path, query)
            .await
    }

    async fn server_request_response(
        &self,
        server_id: &str,
        method: Method,
        path: &str,
        query: &HashMap<String, String>,
    ) -> Result<Response> {
        let mut server = self
            .servers
            .read()
            .map_err(|_| anyhow!("服务器缓存读取失败"))?
            .get(server_id)
            .cloned()
            .ok_or_else(|| anyhow!("找不到服务器，请重新刷新服务器列表"))?;

        let mut reprioritized_after_500 = false;
        loop {
            let mut last_error = None;
            let mut saw_http_500 = false;
            for (index, connection) in server.connections.iter().enumerate() {
                let endpoint = match server_endpoint(&connection.uri, path) {
                    Ok(endpoint) => endpoint,
                    Err(error) => {
                        last_error = Some(error.to_string());
                        continue;
                    }
                };
                match self
                    .plex_headers(self.protected_client.request(method.clone(), endpoint))
                    .header("X-Plex-Token", &server.token)
                    .query(query)
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {
                        if index > 0 {
                            self.promote_connection(server_id, &connection.uri);
                        }
                        return Ok(response);
                    }
                    Ok(response)
                        if !should_retry_server_connection(
                            &method,
                            ServerAttemptFailure::HttpResponse,
                        ) =>
                    {
                        return ensure_success(response, "Plex 服务器写入失败").await;
                    }
                    Ok(response) => {
                        if response.status() == StatusCode::INTERNAL_SERVER_ERROR {
                            saw_http_500 = true;
                        }
                        last_error = Some(format!("HTTP {}", response.status()));
                    }
                    Err(error)
                        if !should_retry_server_connection(
                            &method,
                            if error.is_connect() {
                                ServerAttemptFailure::Connect
                            } else {
                                ServerAttemptFailure::OtherTransport
                            },
                        ) =>
                    {
                        return Err(error.into());
                    }
                    Err(error) => last_error = Some(error.to_string()),
                }
            }

            // Plexamp re-runs connection testing after a server 500 and retries
            // once; do the same here so a transient server-side hiccup does not
            // permanently stick to a stale preferred connection.
            if saw_http_500 && !reprioritized_after_500 {
                reprioritized_after_500 = true;
                let reorder_input = self
                    .servers
                    .read()
                    .map_err(|_| anyhow!("服务器缓存读取失败"))?
                    .get(server_id)
                    .map(|cached| (cached.token.clone(), cached.connections.clone()));
                if let Some((token, connections)) = reorder_input {
                    let reordered = self
                        .prioritize_reachable_connections(server_id, &token, connections)
                        .await;
                    if let Ok(mut servers) = self.servers.write() {
                        if let Some(cached) = servers.get_mut(server_id) {
                            cached.connections = reordered;
                        }
                    }
                    if let Ok(updated) = self.servers.read() {
                        if let Some(refreshed) = updated.get(server_id) {
                            server = refreshed.clone();
                        }
                    }
                }
                continue;
            }

            return Err(anyhow!(
                "无法连接 Plex 服务器：{}",
                last_error.unwrap_or_else(|| "没有可用连接".to_string())
            ));
        }
    }

    async fn prioritize_reachable_connections(
        &self,
        expected_machine_identifier: &str,
        token: &str,
        connections: Vec<CachedConnection>,
    ) -> Vec<CachedConnection> {
        // Plexamp-style connection ranking: test every non-relay candidate in
        // parallel, verify the server identity (`machineIdentifier` must match
        // this client's server identifier), keep relay as the last-ditch
        // option, and keep unreachable connections at the end so a later
        // request can still retry them after a transient outage.
        let client = self.protected_client.clone();
        let client_identifier = self.client_identifier.clone();
        let device_name = self.device_name();
        let expected_identifier = expected_machine_identifier.to_string();
        let mut pending = Vec::new();
        let mut unparsable = Vec::new();
        for connection in connections {
            match server_endpoint(&connection.uri, "/identity") {
                Ok(endpoint) => pending.push((connection, endpoint)),
                Err(_) => unparsable.push(connection),
            }
        }

        let mut tasks = tokio::task::JoinSet::new();
        for (index, (connection, endpoint)) in pending.into_iter().enumerate() {
            let request =
                apply_plex_identity_headers(client.get(endpoint), &client_identifier, &device_name)
                    .header("X-Plex-Token", token)
                    .timeout(Duration::from_secs(5));
            let expected = expected_identifier.clone();
            tasks.spawn(async move {
                let reachable = match request.send().await {
                    Ok(response) if response.status().is_success() => {
                        match response.json::<Value>().await {
                            Ok(value) => value
                                .pointer("/MediaContainer/machineIdentifier")
                                .and_then(|identifier| identifier.as_str())
                                .is_some_and(|identifier| identifier == expected),
                            Err(_) => false,
                        }
                    }
                    Ok(_) | Err(_) => false,
                };
                (index, connection, reachable)
            });
        }

        let mut results = Vec::with_capacity(tasks.len());
        while let Some(result) = tasks.join_next().await {
            if let Ok(item) = result {
                results.push(item);
            }
        }
        results.sort_by_key(|(index, _, _)| *index);

        let mut reachable = Vec::new();
        let mut reachable_relays = Vec::new();
        let mut unreachable = Vec::new();
        for (_, connection, ok) in results {
            if ok && connection.relay {
                reachable_relays.push(connection);
            } else if ok {
                reachable.push(connection);
            } else {
                unreachable.push(connection);
            }
        }
        reachable.extend(reachable_relays);
        reachable.extend(unreachable);
        reachable.extend(unparsable);
        reachable
    }

    pub(crate) fn promote_connection(&self, server_id: &str, uri: &str) {
        let Ok(mut servers) = self.servers.write() else {
            return;
        };
        let Some(server) = servers.get_mut(server_id) else {
            return;
        };
        let Some(index) = server.connections.iter().position(|item| item.uri == uri) else {
            return;
        };
        server.connections.rotate_left(index);
    }

    /// Move an unreachable connection to the end so later stream requests try
    /// the reachable connection first instead of failing against this one.
    pub(crate) fn demote_connection(&self, server_id: &str, uri: &str) {
        let Ok(mut servers) = self.servers.write() else {
            return;
        };
        let Some(server) = servers.get_mut(server_id) else {
            return;
        };
        let Some(index) = server.connections.iter().position(|item| item.uri == uri) else {
            return;
        };
        demote_cached_connection(&mut server.connections, index);
    }

    pub(crate) fn stream_server(&self, server_id: &str) -> Result<StreamServerSnapshot> {
        let server = cached_server(self, server_id)?;
        Ok(StreamServerSnapshot {
            token: server.token,
            connections: server
                .connections
                .into_iter()
                .map(|connection| StreamConnectionSnapshot {
                    uri: connection.uri,
                    local: connection.local,
                    relay: connection.relay,
                })
                .collect(),
        })
    }

    pub(crate) fn client_identifier(&self) -> &str {
        &self.client_identifier
    }

    pub(crate) fn cached_artwork(&self, cache_key: &str) -> Result<CachedArtwork> {
        let _cache_guard = self
            .cache_lock
            .read()
            .map_err(|_| anyhow!("图片缓存读取锁定失败"))?;
        read_artwork_cache(&self.cache_dir, cache_key)?.ok_or_else(|| anyhow!("封面缓存已失效"))
    }
}

fn demote_cached_connection(connections: &mut [CachedConnection], index: usize) {
    connections.rotate_left(index + 1);
}

fn apply_plex_identity_headers(
    request: reqwest::RequestBuilder,
    client_identifier: &str,
    device_name: &str,
) -> reqwest::RequestBuilder {
    request
        .header("X-Plex-Product", PRODUCT_NAME)
        .header("X-Plex-Client-Title", PRODUCT_NAME)
        .header("X-Plex-Version", PRODUCT_VERSION)
        .header("X-Plex-Client-Identifier", client_identifier)
        .header("X-Plex-Platform", std::env::consts::OS)
        .header("X-Plex-Device", "Desktop")
        .header("X-Plex-Device-Name", device_name)
        .header("X-Plex-Provides", "player,controller")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    client_identifier: String,
    authenticated: bool,
    account: Option<Account>,
    status_icon_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_icon_platform: Option<StatusIconPlatform>,
    device_name: String,
    brand_preset: BrandPreset,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    id: Option<i64>,
    username: String,
    title: String,
    email: String,
    thumb: Option<String>,
    home: bool,
    restricted: bool,
    subscription_active: bool,
}

impl Account {
    fn from_json(value: &Value) -> Self {
        Self {
            id: value.get("id").and_then(Value::as_i64),
            username: string_field(value, "username"),
            title: string_field(value, "title"),
            email: string_field(value, "email"),
            thumb: value
                .get("thumb")
                .and_then(Value::as_str)
                .map(str::to_owned),
            home: value.get("home").and_then(Value::as_bool).unwrap_or(false),
            restricted: value
                .get("restricted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            subscription_active: value
                .get("subscription")
                .and_then(|item| item.get("active"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pin {
    id: i64,
    code: String,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    auth_token: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinResponse {
    id: i64,
    code: String,
    expires_in: i64,
    authenticated: bool,
}

impl PinResponse {
    fn from_pin(pin: Pin, authenticated: bool) -> Self {
        Self {
            id: pin.id,
            code: pin.code,
            expires_in: pin.expires_in,
            authenticated,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resource {
    name: String,
    provides: String,
    client_identifier: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    owned: bool,
    #[serde(default)]
    home: bool,
    #[serde(default)]
    source_title: Option<String>,
    #[serde(default)]
    connections: Vec<ResourceConnection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceConnection {
    uri: String,
    protocol: String,
    #[serde(default)]
    local: bool,
    #[serde(default)]
    relay: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSummary {
    id: String,
    name: String,
    owned: bool,
    home: bool,
    source_title: Option<String>,
    connection_uri: String,
    local: bool,
    relay: bool,
    secure: bool,
}

#[derive(Debug, Clone)]
struct LyricStream {
    key: String,
    provider: Option<String>,
    timed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlexLyricLine {
    #[serde(skip_serializing_if = "Option::is_none")]
    start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_ms: Option<u64>,
    text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlexLyricsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    timed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_text: Option<String>,
    lines: Vec<PlexLyricLine>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    size_bytes: u64,
    file_count: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CachedArtwork {
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename = "MediaContainer")]
struct XmlMediaContainer {
    #[serde(rename = "Lyrics", default)]
    lyrics: Vec<XmlLyrics>,
}

#[derive(Debug, Deserialize)]
#[serde(rename = "Lyrics")]
struct XmlLyrics {
    #[serde(rename = "@provider", default)]
    provider: Option<String>,
    #[serde(rename = "@timed", default)]
    timed: Option<String>,
    #[serde(rename = "@author", default)]
    author: Option<String>,
    #[serde(rename = "@by", default)]
    by: Option<String>,
    #[serde(rename = "Line", default)]
    lines: Vec<XmlLyricLine>,
}

#[derive(Debug, Deserialize)]
struct XmlLyricLine {
    #[serde(rename = "@startOffset", default)]
    start_offset: Option<String>,
    #[serde(rename = "@endOffset", default)]
    end_offset: Option<String>,
    #[serde(rename = "@text", default)]
    text_attribute: Option<String>,
    #[serde(rename = "Span", default)]
    spans: Vec<XmlLyricSpan>,
}

#[derive(Debug, Deserialize)]
struct XmlLyricSpan {
    #[serde(rename = "@text", default)]
    text_attribute: Option<String>,
    #[serde(rename = "$text", default)]
    text: Option<String>,
}

#[tauri::command]
pub async fn bootstrap(state: State<'_, PlexState>) -> Result<BootstrapResponse, String> {
    let token = state.token().ok();
    let account = match token.as_deref() {
        Some(token) => state.account(token).await.ok(),
        None => None,
    };
    Ok(BootstrapResponse {
        client_identifier: state.client_identifier.clone(),
        authenticated: token.is_some(),
        account,
        status_icon_enabled: state.status_icon_enabled(),
        status_icon_platform: status_icon_platform(),
        device_name: state.device_name(),
        brand_preset: state.brand_preset(),
    })
}

#[tauri::command]
pub async fn create_pin(state: State<'_, PlexState>) -> Result<PinResponse, String> {
    let response = state
        .plex_headers(
            state
                .protected_client
                .post(format!("{PLEX_TV}/api/v2/pins")),
        )
        .query(&[("strong", "true")])
        .send()
        .await
        .map_err(display_error)?;
    let pin = ensure_success(response, "创建 Plex 登录码失败")
        .await
        .map_err(display_error)?
        .json::<Pin>()
        .await
        .map_err(display_error)?;
    Ok(PinResponse::from_pin(pin, false))
}

#[tauri::command]
pub async fn poll_pin(
    pin_id: i64,
    state: State<'_, PlexState>,
    stream_proxy: State<'_, StreamProxy>,
    audio_engine: State<'_, NativeAudioEngineSlot>,
) -> Result<PinResponse, String> {
    let response = state
        .plex_headers(
            state
                .protected_client
                .get(format!("{PLEX_TV}/api/v2/pins/{pin_id}")),
        )
        .send()
        .await
        .map_err(display_error)?;
    let pin = ensure_success(response, "检查 Plex 登录状态失败")
        .await
        .map_err(display_error)?
        .json::<Pin>()
        .await
        .map_err(display_error)?;

    let authenticated = if let Some(token) = pin.auth_token.as_deref() {
        audio_engine.reset_and_clear_cache().await?;
        stream_proxy.clear().map_err(display_error)?;
        state
            .servers
            .write()
            .map_err(|_| "服务器缓存写入失败".to_string())?
            .clear();
        let _ = clear_artwork_for_account_change(&state);
        store_account_token(token).map_err(display_error)?;
        *state
            .token
            .write()
            .map_err(|_| "登录状态写入失败".to_string())? = Some(token.to_string());
        true
    } else {
        false
    };
    Ok(PinResponse::from_pin(pin, authenticated))
}

#[tauri::command]
pub async fn logout(
    state: State<'_, PlexState>,
    stream_proxy: State<'_, StreamProxy>,
    audio_engine: State<'_, NativeAudioEngineSlot>,
) -> Result<(), String> {
    // Authentication must still be revoked if a cache file is temporarily
    // undeletable. Return the cleanup error only after clearing credentials,
    // server state and loopback tickets.
    let audio_result = audio_engine.reset_and_clear_cache().await;
    let proxy_result = stream_proxy.clear().map_err(display_error);
    delete_account_token();
    *state
        .token
        .write()
        .map_err(|_| "登录状态写入失败".to_string())? = None;
    state
        .servers
        .write()
        .map_err(|_| "服务器缓存写入失败".to_string())?
        .clear();
    let _ = clear_artwork_for_account_change(&state);
    audio_result?;
    proxy_result?;
    Ok(())
}

#[tauri::command]
pub async fn discover_servers(state: State<'_, PlexState>) -> Result<Vec<ServerSummary>, String> {
    let account_token = state.token().map_err(display_error)?;
    let response = state
        .plex_headers(
            state
                .protected_client
                .get(format!("{PLEX_TV}/api/v2/resources")),
        )
        .header("X-Plex-Token", account_token)
        .query(&[
            ("includeHttps", "1"),
            ("includeRelay", "1"),
            ("includeIPv6", "1"),
        ])
        .send()
        .await
        .map_err(display_error)?;
    let resources = ensure_success(response, "读取 Plex 服务器失败")
        .await
        .map_err(display_error)?
        .json::<Vec<Resource>>()
        .await
        .map_err(display_error)?;

    let mut summaries = Vec::new();
    let mut cache = HashMap::new();
    for resource in resources {
        if !resource.provides.split(',').any(|item| item == "server") {
            continue;
        }
        let Some(token) = resource.access_token else {
            continue;
        };
        let mut connections: Vec<CachedConnection> = resource
            .connections
            .into_iter()
            .filter_map(|connection| {
                let base = validated_connection_base(&connection.uri).ok()?;
                if !connection.protocol.eq_ignore_ascii_case(base.scheme()) {
                    return None;
                }
                Some(CachedConnection {
                    secure: base.scheme() == "https",
                    uri: base.to_string(),
                    local: connection.local,
                    relay: connection.relay,
                })
            })
            .collect();
        connections.sort_by_key(|connection| {
            let mut score = 0;
            if connection.local {
                score -= 8;
            }
            if connection.secure {
                score -= 4;
            }
            if connection.relay {
                score += 3;
            }
            score
        });
        let connections = state
            .prioritize_reachable_connections(&resource.client_identifier, &token, connections)
            .await;
        let Some(preferred) = connections.first() else {
            continue;
        };
        summaries.push(ServerSummary {
            id: resource.client_identifier.clone(),
            name: resource.name,
            owned: resource.owned,
            home: resource.home,
            source_title: resource.source_title,
            connection_uri: preferred.uri.clone(),
            local: preferred.local,
            relay: preferred.relay,
            secure: preferred.secure,
        });
        cache.insert(
            resource.client_identifier,
            CachedServer { token, connections },
        );
    }
    summaries.sort_by_key(|server| (!server.owned, server.name.to_lowercase()));
    *state
        .servers
        .write()
        .map_err(|_| "服务器缓存写入失败".to_string())? = cache;
    Ok(summaries)
}

#[tauri::command]
pub async fn server_get(
    server_id: String,
    path: String,
    query: HashMap<String, String>,
    state: State<'_, PlexState>,
) -> Result<Value, String> {
    if !allowed_server_path(&path) {
        return Err("拒绝访问不在允许列表中的服务器路径".to_string());
    }
    state
        .server_response(&server_id, &path, &query)
        .await
        .map_err(display_error)?
        .json::<Value>()
        .await
        .map_err(display_error)
}

#[tauri::command]
pub async fn create_playlist(
    server_id: String,
    title: String,
    summary: String,
    seed_rating_key: Option<String>,
    clear_items: bool,
    state: State<'_, PlexState>,
) -> Result<Value, String> {
    if clear_items && seed_rating_key.is_none() {
        return Err("创建空歌单缺少兼容用的歌曲".to_string());
    }
    let query = create_audio_playlist_query(&server_id, &title, seed_rating_key.as_deref())
        .map_err(display_error)?;
    let normalized_summary = normalize_playlist_summary(&summary).map_err(display_error)?;
    let mut created = state
        .server_request_response(&server_id, Method::POST, "/playlists", &query)
        .await
        .map_err(display_error)?
        .json::<Value>()
        .await
        .map_err(display_error)?;

    if clear_items {
        let playlist_id = created_playlist_rating_key(&created)
            .ok_or_else(|| "Plex 未返回可清空的歌单标识".to_string())?;
        let path = playlist_items_path(&playlist_id).map_err(display_error)?;
        let empty_query = HashMap::new();
        if let Err(error) = state
            .server_request_response(&server_id, Method::DELETE, &path, &empty_query)
            .await
        {
            let rollback_path = playlist_path(&playlist_id).map_err(display_error)?;
            let _ = state
                .server_request_response(&server_id, Method::DELETE, &rollback_path, &empty_query)
                .await;
            return Err(format!("创建空歌单失败：{}", display_error(error)));
        }
        reset_created_playlist_counts(&mut created);
    }

    if !normalized_summary.is_empty() {
        let playlist_id = created_playlist_rating_key(&created)
            .ok_or_else(|| "Plex 未返回可更新的歌单标识".to_string())?;
        let path = format!("/playlists/{playlist_id}");
        let summary_query = HashMap::from([("summary".to_string(), normalized_summary.clone())]);
        state
            .server_request_response(&server_id, Method::PUT, &path, &summary_query)
            .await
            .map_err(|error| format!("歌单已创建，但保存描述失败：{}", display_error(error)))?;
        set_created_playlist_summary(&mut created, &normalized_summary);
    }

    Ok(created)
}

#[tauri::command]
pub async fn remove_playlist_items(
    server_id: String,
    playlist_id: String,
    playlist_item_ids: Vec<String>,
    state: State<'_, PlexState>,
) -> Result<PlaylistBatchRemoveResult, String> {
    if !valid_plex_identifier(&server_id) {
        return Err("无效的 Plex 服务器标识".to_string());
    }
    let playlist_item_ids =
        normalize_playlist_batch_item_ids(playlist_item_ids).map_err(display_error)?;
    let requested = playlist_item_ids.len();
    let mut removed = 0;
    let mut failed_item_ids = Vec::new();

    // PMS accepts one playlist item per DELETE on the compatible endpoint.
    // Keep it serial so the returned counts describe the real write order.
    for playlist_item_id in playlist_item_ids {
        let path = playlist_item_path(&playlist_id, &playlist_item_id).map_err(display_error)?;
        let empty_query = HashMap::new();
        match state
            .server_request_response(&server_id, Method::DELETE, &path, &empty_query)
            .await
        {
            Ok(_) => removed += 1,
            Err(_) => failed_item_ids.push(playlist_item_id),
        }
    }

    Ok(PlaylistBatchRemoveResult {
        requested,
        removed,
        failed_item_ids,
    })
}

#[tauri::command]
pub async fn update_playlist(
    server_id: String,
    playlist_id: String,
    title: Option<String>,
    summary: Option<String>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    if !valid_plex_identifier(&server_id) {
        return Err("无效的 Plex 服务器标识".to_string());
    }
    let path = playlist_path(&playlist_id).map_err(display_error)?;
    let mut query = HashMap::new();
    if let Some(title) = title {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 255 || title.chars().any(char::is_control) {
            return Err("歌单名称必须为 1–255 个有效字符".to_string());
        }
        query.insert("title".to_string(), title.to_string());
    }
    if let Some(summary) = summary {
        query.insert(
            "summary".to_string(),
            normalize_playlist_summary(&summary).map_err(display_error)?,
        );
    }
    if query.is_empty() {
        return Ok(());
    }
    state
        .server_request_response(&server_id, Method::PUT, &path, &query)
        .await
        .map_err(display_error)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_playlist(
    server_id: String,
    playlist_id: String,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    if !valid_plex_identifier(&server_id) {
        return Err("无效的 Plex 服务器标识".to_string());
    }
    let path = playlist_path(&playlist_id).map_err(display_error)?;
    let empty_query = HashMap::new();
    state
        .server_request_response(&server_id, Method::DELETE, &path, &empty_query)
        .await
        .map_err(display_error)?;
    Ok(())
}

#[tauri::command]
pub async fn get_playlists(
    server_id: String,
    state: State<'_, PlexState>,
) -> Result<Value, String> {
    // `/playlists` is scoped by the per-server token to the signed-in account.
    // `type=15` flattens playlist folders so nested account playlists are not
    // lost when the client ignores directory rows. PMS still enforces every
    // shared-server read and write permission attached to that token.
    state
        .server_response(&server_id, "/playlists", &audio_playlist_query())
        .await
        .map_err(display_error)?
        .json::<Value>()
        .await
        .map_err(display_error)
}

#[tauri::command]
pub async fn get_playlist_items(
    server_id: String,
    playlist_id: String,
    state: State<'_, PlexState>,
) -> Result<Value, String> {
    let path = playlist_items_path(&playlist_id).map_err(display_error)?;
    state
        .server_response(&server_id, &path, &HashMap::new())
        .await
        .map_err(display_error)?
        .json::<Value>()
        .await
        .map_err(display_error)
}

#[tauri::command]
pub async fn add_to_playlist(
    server_id: String,
    playlist_id: String,
    rating_key: String,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let uri = playlist_item_uri(&server_id, &rating_key).map_err(display_error)?;
    let path = playlist_items_path(&playlist_id).map_err(display_error)?;
    let query = HashMap::from([("uri".to_string(), uri)]);
    state
        .server_request_response(&server_id, Method::PUT, &path, &query)
        .await
        .map_err(display_error)?;
    Ok(())
}

#[tauri::command]
pub async fn add_tracks_to_playlist(
    server_id: String,
    playlist_id: String,
    rating_keys: Vec<String>,
    state: State<'_, PlexState>,
) -> Result<PlaylistBatchAddResult, String> {
    if !valid_plex_identifier(&server_id) {
        return Err("无效的 Plex 歌单项目标识".to_string());
    }
    let rating_keys = normalize_playlist_batch_rating_keys(rating_keys).map_err(display_error)?;
    let path = playlist_items_path(&playlist_id).map_err(display_error)?;
    let requested = rating_keys.len();
    let mut added = 0;
    let mut failed_rating_keys = Vec::new();

    // PMS accepts one library URI per mutation on the compatible endpoint.
    // Keep it serial here so the returned counts describe the real write order.
    for rating_key in rating_keys {
        let uri = playlist_item_uri(&server_id, &rating_key).map_err(display_error)?;
        let query = HashMap::from([("uri".to_string(), uri)]);
        match state
            .server_request_response(&server_id, Method::PUT, &path, &query)
            .await
        {
            Ok(_) => added += 1,
            Err(_) => failed_rating_keys.push(rating_key),
        }
    }

    Ok(PlaylistBatchAddResult {
        requested,
        added,
        failed_rating_keys,
    })
}

#[tauri::command]
pub async fn lyrics(
    server_id: String,
    rating_key: String,
    state: State<'_, PlexState>,
) -> Result<Option<PlexLyricsPayload>, String> {
    if rating_key.is_empty()
        || rating_key
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '?' | '#'))
    {
        return Err("无效的歌曲 ratingKey".to_string());
    }

    let metadata_path = format!("/library/metadata/{rating_key}");
    let metadata = state
        .server_response(&server_id, &metadata_path, &HashMap::new())
        .await
        .map_err(display_error)?
        .json::<Value>()
        .await
        .map_err(display_error)?;
    let streams = lyric_streams_from_metadata(&metadata);
    if streams.is_empty() {
        return Ok(None);
    }

    let server = cached_server(&state, &server_id).map_err(display_error)?;
    let mut last_error = None;
    for stream in streams {
        let response = match request_lyric_stream(&state, &server_id, &server, &stream.key).await {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };

        match parse_lyrics_body(&body, content_type.as_deref(), &stream) {
            Ok(Some(payload)) => return Ok(Some(payload)),
            Ok(None) => last_error = Some("歌词响应中没有可识别的内容".to_string()),
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    Err(format!(
        "读取歌词失败：{}",
        last_error.unwrap_or_else(|| "没有可用歌词流".to_string())
    ))
}

#[tauri::command]
pub async fn artwork_url(
    server_id: String,
    path: String,
    width: Option<u32>,
    height: Option<u32>,
    state: State<'_, PlexState>,
    stream_proxy: State<'_, StreamProxy>,
) -> Result<String, String> {
    let cache_key = ensure_artwork_cached(server_id, path, width, height, &state).await?;
    stream_proxy.issue_artwork(cache_key).map_err(display_error)
}

async fn ensure_artwork_cached(
    server_id: String,
    path: String,
    width: Option<u32>,
    height: Option<u32>,
    state: &PlexState,
) -> Result<String, String> {
    if !valid_internal_image_path(&path) {
        return Err("无效的 Plex 图片路径".to_string());
    }
    if !valid_artwork_dimension(width) || !valid_artwork_dimension(height) {
        return Err("图片尺寸必须在 1 到 4096 像素之间".to_string());
    }
    // Resolve the current account's authorized server before consulting disk.
    // A cache hit must never bypass the active PMS ACL boundary.
    let server = cached_server(state, &server_id).map_err(display_error)?;
    let cache_key = artwork_cache_key(&server_id, &path, width, height, &server.token);
    if let Ok(_cache_guard) = state.cache_lock.read() {
        match read_artwork_cache(&state.cache_dir, &cache_key) {
            Ok(Some(_)) => return Ok(cache_key),
            Ok(None) => {}
            Err(_) => discard_artwork_cache_entry(&state.cache_dir, &cache_key),
        }
    }

    let mut last_error = None;

    'connections: for (index, connection) in server.connections.iter().enumerate() {
        let mut endpoint = match server_endpoint(&connection.uri, "/photo/:/transcode") {
            Ok(endpoint) => endpoint,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        {
            let mut query = endpoint.query_pairs_mut();
            query
                .append_pair("url", &path)
                .append_pair("minSize", "1")
                .append_pair("upscale", "1");
            if let Some(width) = width {
                query.append_pair("width", &width.to_string());
            }
            if let Some(height) = height {
                query.append_pair("height", &height.to_string());
            }
        }

        let mut response = match state
            .plex_identity_headers(state.protected_client.get(endpoint))
            .header(ACCEPT, "image/*")
            .header("X-Plex-Token", &server.token)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                last_error = Some(format!("图片接口返回 HTTP {}", response.status()));
                continue;
            }
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        let content_length = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let mime = match validate_image_metadata(content_type, content_length) {
            Ok(mime) => mime,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let initial_capacity = content_length
            .unwrap_or_default()
            .min(MAX_IMAGE_BYTES as u64) as usize;
        let mut bytes = Vec::with_capacity(initial_capacity);
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
                        last_error = Some("Plex 图片超过 12 MiB 限制".to_string());
                        continue 'connections;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) => {
                    last_error = Some(error.to_string());
                    continue 'connections;
                }
            }
        }
        if index > 0 {
            state.promote_connection(&server_id, &connection.uri);
        }
        let _cache_guard = state
            .cache_lock
            .write()
            .map_err(|_| "图片缓存写入锁定失败".to_string())?;
        write_artwork_cache(&state.cache_dir, &cache_key, &mime, &bytes).map_err(display_error)?;
        return Ok(cache_key);
    }

    Err(format!(
        "读取 Plex 图片失败：{}",
        last_error.unwrap_or_else(|| "服务器没有可用连接".to_string())
    ))
}

#[tauri::command]
pub fn cache_status(state: State<'_, PlexState>) -> Result<CacheStatus, String> {
    let _cache_guard = state
        .cache_lock
        .read()
        .map_err(|_| "图片缓存状态读取失败".to_string())?;
    artwork_cache_status(&state.cache_dir).map_err(display_error)
}

#[tauri::command]
pub fn clear_cache(
    state: State<'_, PlexState>,
    stream_proxy: State<'_, StreamProxy>,
) -> Result<CacheStatus, String> {
    stream_proxy.clear_artwork().map_err(display_error)?;
    let _cache_guard = state
        .cache_lock
        .write()
        .map_err(|_| "图片缓存清理锁定失败".to_string())?;
    clear_artwork_cache(&state.cache_dir).map_err(display_error)
}

#[tauri::command]
pub async fn report_timeline(
    server_id: String,
    rating_key: String,
    metadata_key: String,
    playback_state: String,
    time: u64,
    duration: u64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let query = HashMap::from([
        ("ratingKey".to_string(), rating_key),
        ("key".to_string(), metadata_key),
        ("state".to_string(), playback_state),
        ("time".to_string(), time.to_string()),
        ("duration".to_string(), duration.to_string()),
    ]);
    state
        .server_response(&server_id, "/:/timeline", &query)
        .await
        .map_err(display_error)?;
    Ok(())
}

#[tauri::command]
pub async fn scrobble(
    server_id: String,
    rating_key: String,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let query = HashMap::from([
        ("key".to_string(), rating_key),
        (
            "identifier".to_string(),
            "com.plexapp.plugins.library".to_string(),
        ),
    ]);
    state
        .server_response(&server_id, "/:/scrobble", &query)
        .await
        .map_err(display_error)?;
    Ok(())
}

#[tauri::command]
pub fn set_status_icon_enabled(
    enabled: bool,
    state: State<'_, PlexState>,
    app: AppHandle,
) -> Result<bool, String> {
    if status_icon_platform().is_none() {
        return Err("当前平台不支持系统状态图标。".to_string());
    }

    let previous = state.status_icon_enabled();
    if previous == enabled {
        return Ok(enabled);
    }

    crate::window::set_status_icon_enabled(&app, enabled).map_err(display_error)?;
    if let Err(error) = state.save_status_icon_enabled(enabled) {
        let _ = crate::window::set_status_icon_enabled(&app, previous);
        return Err(display_error(error));
    }
    Ok(enabled)
}

#[tauri::command]
pub fn set_device_name(device_name: String, state: State<'_, PlexState>) -> Result<String, String> {
    let device_name = normalize_device_name(&device_name).map_err(display_error)?;
    state
        .save_device_name(device_name.clone())
        .map_err(|_| "无法保存 Cadilume 设备名称。".to_string())?;
    Ok(device_name)
}

#[tauri::command]
pub fn set_brand_preset(
    preset: BrandPreset,
    state: State<'_, PlexState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .save_brand_preset(preset)
        .map_err(|_| "无法保存视觉风格。".to_string())?;
    crate::window::update_dock_icon(&app, preset);
    Ok(())
}

async fn request_lyric_stream(
    state: &PlexState,
    server_id: &str,
    server: &CachedServer,
    key: &str,
) -> Result<Response> {
    let key = key.trim();
    if key.is_empty() {
        return Err(anyhow!("歌词流缺少地址"));
    }

    match Url::parse(key) {
        Ok(url) => {
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(anyhow!("歌词绝对地址不安全"));
            }
            let Some((index, _)) = server
                .connections
                .iter()
                .enumerate()
                .find(|(_, connection)| connection_matches_origin(connection, &url))
            else {
                return Err(anyhow!("歌词地址不属于当前 Plex 服务器"));
            };
            let response = send_lyric_request(state, prepare_lyric_url(url), &server.token).await?;
            if index > 0 {
                state.promote_connection(server_id, &server.connections[index].uri);
            }
            Ok(response)
        }
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            if key.starts_with("//") || key.starts_with('\\') || key.contains('\0') {
                return Err(anyhow!("歌词相对地址不安全"));
            }

            let relative_path = if key.starts_with('/') {
                key.to_string()
            } else {
                format!("/{key}")
            };
            let mut last_error = None;
            for (index, connection) in server.connections.iter().enumerate() {
                let base = match validated_connection_base(&connection.uri) {
                    Ok(base) => base,
                    Err(error) => {
                        last_error = Some(error.to_string());
                        continue;
                    }
                };
                let url = match base.join(&relative_path) {
                    Ok(url) if same_origin(&base, &url) => prepare_lyric_url(url),
                    Ok(_) => {
                        last_error = Some("歌词地址越过了 Plex 服务器边界".to_string());
                        continue;
                    }
                    Err(error) => {
                        last_error = Some(error.to_string());
                        continue;
                    }
                };
                match send_lyric_request(state, url, &server.token).await {
                    Ok(response) => {
                        if index > 0 {
                            state.promote_connection(server_id, &connection.uri);
                        }
                        return Ok(response);
                    }
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
            Err(anyhow!(
                "无法读取歌词流：{}",
                last_error.unwrap_or_else(|| "服务器没有可用连接".to_string())
            ))
        }
        Err(_) => Err(anyhow!("无法解析歌词地址")),
    }
}

async fn send_lyric_request(state: &PlexState, url: Url, token: &str) -> Result<Response> {
    let response = state
        .plex_identity_headers(state.protected_client.get(url))
        .header(
            ACCEPT,
            "application/xml, text/plain;q=0.9, application/json;q=0.8",
        )
        .header("X-Plex-Token", token)
        .send()
        .await?;
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(anyhow!("歌词接口返回 HTTP {}", response.status()))
    }
}

fn prepare_lyric_url(mut url: Url) -> Url {
    let retained_query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| {
            !name.eq_ignore_ascii_case("X-Plex-Token")
                && !name.eq_ignore_ascii_case("format")
                && !name.eq_ignore_ascii_case("includeInlineAttribution")
        })
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    url.set_fragment(None);
    url.set_query(None);
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in retained_query {
            query.append_pair(&name, &value);
        }
        query
            .append_pair("format", "xml")
            .append_pair("includeInlineAttribution", "1");
    }
    url
}

fn connection_matches_origin(connection: &CachedConnection, url: &Url) -> bool {
    validated_connection_base(&connection.uri)
        .map(|connection_url| same_origin(&connection_url, url))
        .unwrap_or(false)
}

fn validated_connection_base(uri: &str) -> Result<Url> {
    let base = Url::parse(uri).context("无法解析 Plex 连接地址")?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(anyhow!("Plex 连接地址不安全"));
    }
    Ok(base)
}

fn server_endpoint(connection_uri: &str, path: &str) -> Result<Url> {
    let lowercase_path = path.to_ascii_lowercase();
    if path.len() > 4096
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '?', '#'])
        || path.chars().any(char::is_control)
        || lowercase_path.contains("%2e")
        || lowercase_path.contains("%2f")
        || lowercase_path.contains("%5c")
        || path.split('/').any(|segment| matches!(segment, "." | ".."))
    {
        return Err(anyhow!("无效的 Plex 服务器路径"));
    }
    let base = validated_connection_base(connection_uri)?;
    let endpoint = base.join(path).context("无法构造 Plex 服务器地址")?;
    if !same_origin(&base, &endpoint) {
        return Err(anyhow!("Plex 请求地址越过了服务器边界"));
    }
    Ok(endpoint)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn should_retry_server_connection(method: &Method, failure: ServerAttemptFailure) -> bool {
    method == Method::GET || failure == ServerAttemptFailure::Connect
}

fn lyric_streams_from_metadata(value: &Value) -> Vec<LyricStream> {
    let root = value.get("MediaContainer").unwrap_or(value);
    let mut streams = Vec::new();
    for metadata in json_children(root, "Metadata") {
        for media in json_children(metadata, "Media") {
            for part in json_children(media, "Part") {
                for stream in json_children(part, "Stream") {
                    if json_u64(stream.get("streamType")) != Some(4) {
                        continue;
                    }
                    let Some(key) = json_string(stream.get("key")) else {
                        continue;
                    };
                    streams.push(LyricStream {
                        key,
                        provider: json_string(stream.get("provider")),
                        timed: json_bool(stream.get("timed")).unwrap_or(false),
                    });
                }
            }
        }
    }
    streams
}

fn parse_lyrics_body(
    body: &str,
    content_type: Option<&str>,
    stream: &LyricStream,
) -> Result<Option<PlexLyricsPayload>> {
    let source = body.trim_start_matches('\u{feff}');
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let media_type = content_type.unwrap_or_default().to_ascii_lowercase();
    if media_type.contains("json") || trimmed.starts_with('{') || trimmed.starts_with('[') {
        return parse_plex_json(source, stream);
    }
    if media_type.contains("xml")
        || trimmed.starts_with("<?xml")
        || trimmed.starts_with("<MediaContainer")
        || trimmed.starts_with("<Lyrics")
    {
        return parse_plex_xml(source, stream).map(Some);
    }
    if media_type.contains("html")
        || trimmed.starts_with("<!DOCTYPE html")
        || trimmed.starts_with("<html")
    {
        return Err(anyhow!("歌词接口返回了网页内容"));
    }

    Ok(Some(PlexLyricsPayload {
        provider: stream.provider.clone(),
        timed: stream.timed,
        author: None,
        by: None,
        format_hint: Some(raw_lyrics_format_hint(&stream.key, &media_type, source)),
        raw_text: Some(source.to_string()),
        lines: Vec::new(),
    }))
}

fn parse_plex_xml(source: &str, stream: &LyricStream) -> Result<PlexLyricsPayload> {
    if let Ok(container) = from_xml_str::<XmlMediaContainer>(source) {
        if let Some(lyrics) = container.lyrics.into_iter().next() {
            return Ok(payload_from_xml(lyrics, stream));
        }
    }
    let lyrics = from_xml_str::<XmlLyrics>(source).context("无法解析 Plex XML 歌词")?;
    Ok(payload_from_xml(lyrics, stream))
}

fn payload_from_xml(lyrics: XmlLyrics, stream: &LyricStream) -> PlexLyricsPayload {
    let lines = lyrics
        .lines
        .into_iter()
        .map(|line| {
            let span_text = line
                .spans
                .into_iter()
                .filter_map(|span| nonempty_string(span.text_attribute.or(span.text)))
                .collect::<Vec<_>>()
                .join("");
            let text = if span_text.trim().is_empty() {
                nonempty_string(line.text_attribute).unwrap_or_default()
            } else {
                span_text
            };
            PlexLyricLine {
                start_ms: parse_milliseconds(line.start_offset.as_deref()),
                end_ms: parse_milliseconds(line.end_offset.as_deref()),
                text,
            }
        })
        .collect::<Vec<_>>();
    PlexLyricsPayload {
        provider: nonempty_string(lyrics.provider).or_else(|| stream.provider.clone()),
        timed: lyrics
            .timed
            .as_deref()
            .and_then(parse_bool_text)
            .unwrap_or(stream.timed),
        author: nonempty_string(lyrics.author),
        by: nonempty_string(lyrics.by),
        format_hint: None,
        raw_text: None,
        lines,
    }
}

fn parse_plex_json(source: &str, stream: &LyricStream) -> Result<Option<PlexLyricsPayload>> {
    let value = serde_json::from_str::<Value>(source).context("无法解析 Plex JSON 歌词")?;
    let root = value.get("MediaContainer").unwrap_or(&value);
    let candidates = if root.get("Lyrics").is_some() {
        json_children(root, "Lyrics")
    } else if root.get("Line").is_some() {
        vec![root]
    } else {
        Vec::new()
    };

    for lyrics in candidates {
        let lines = json_children(lyrics, "Line")
            .into_iter()
            .map(|line| PlexLyricLine {
                start_ms: json_u64(line.get("startOffset").or_else(|| line.get("startMs"))),
                end_ms: json_u64(line.get("endOffset").or_else(|| line.get("endMs"))),
                text: json_lyric_line_text(line),
            })
            .collect::<Vec<_>>();
        let raw_text = json_string(lyrics.get("rawText").or_else(|| lyrics.get("text")));
        if lines.is_empty() && raw_text.is_none() {
            continue;
        }
        return Ok(Some(PlexLyricsPayload {
            provider: json_string(lyrics.get("provider")).or_else(|| stream.provider.clone()),
            timed: json_bool(lyrics.get("timed")).unwrap_or(stream.timed),
            author: json_string(lyrics.get("author")),
            by: json_string(lyrics.get("by")),
            format_hint: json_string(lyrics.get("formatHint").or_else(|| lyrics.get("format")))
                .or_else(|| raw_text.as_ref().map(|_| "txt".to_string())),
            raw_text,
            lines,
        }));
    }
    Ok(None)
}

fn json_lyric_line_text(line: &Value) -> String {
    if let Some(text) = line.as_str() {
        return text.to_string();
    }
    let span_text = json_children(line, "Span")
        .into_iter()
        .filter_map(|span| {
            span.as_str()
                .map(str::to_owned)
                .or_else(|| json_string(span.get("text")))
        })
        .collect::<Vec<_>>()
        .join("");
    if span_text.trim().is_empty() {
        json_string(line.get("text")).unwrap_or_default()
    } else {
        span_text
    }
}

fn json_children<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    match value.get(key) {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(item) => vec![item],
    }
}

fn json_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_str()
                .and_then(|value| value.trim().parse::<u64>().ok())
        })
    })
}

fn json_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(|value| {
        value
            .as_bool()
            .or_else(|| value.as_i64().map(|value| value != 0))
            .or_else(|| value.as_str().and_then(parse_bool_text))
    })
}

fn parse_bool_text(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Some(true),
        "0" | "false" | "no" => Some(false),
        _ => None,
    }
}

fn parse_milliseconds(value: Option<&str>) -> Option<u64> {
    value.and_then(|value| value.trim().parse::<u64>().ok())
}

fn nonempty_string(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn raw_lyrics_format_hint(key: &str, content_type: &str, source: &str) -> String {
    let path = Url::parse(key)
        .ok()
        .map(|url| url.path().to_ascii_lowercase())
        .unwrap_or_else(|| {
            key.split(['?', '#'])
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        });
    for format in ["lrc", "txt", "srt", "vtt"] {
        if path.ends_with(&format!(".{format}")) || content_type.contains(format) {
            return format.to_string();
        }
    }
    if source.trim_start().starts_with("WEBVTT") {
        return "vtt".to_string();
    }
    if source.lines().any(|line| line.contains("-->")) {
        return "srt".to_string();
    }
    if looks_like_lrc(source) {
        return "lrc".to_string();
    }
    "txt".to_string()
}

fn looks_like_lrc(source: &str) -> bool {
    source.lines().take(50).any(|line| {
        let line = line.trim_start();
        let Some(end) = line.find(']') else {
            return false;
        };
        let Some(tag) = line.get(1..end) else {
            return false;
        };
        let mut parts = tag.splitn(2, ':');
        let minutes = parts.next().unwrap_or_default();
        let seconds = parts.next().unwrap_or_default();
        !minutes.is_empty()
            && minutes.chars().all(|character| character.is_ascii_digit())
            && seconds.split(['.', ':']).next().is_some_and(|seconds| {
                seconds.len() == 2 && seconds.chars().all(|character| character.is_ascii_digit())
            })
    })
}

fn initialize_artwork_cache_dir(app_cache_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(app_cache_dir).context("无法创建应用缓存目录")?;
    let namespace_dir = app_cache_dir.join(CACHE_NAMESPACE_DIR);
    ensure_plain_cache_directory(&namespace_dir)?;
    let artwork_dir = namespace_dir.join(ARTWORK_CACHE_DIR);
    ensure_plain_cache_directory(&artwork_dir)?;
    Ok(artwork_dir)
}

fn ensure_plain_cache_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(anyhow!("拒绝使用符号链接作为图片缓存目录"))
        }
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(anyhow!("图片缓存路径不是目录")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure_plain_cache_directory(path)
            }
            Err(error) => Err(anyhow!("无法创建图片缓存目录 {}：{error}", path.display())),
        },
        Err(error) => Err(error).context("无法检查图片缓存目录"),
    }
}

fn ensure_artwork_cache_boundary(cache_dir: &Path) -> Result<()> {
    if cache_dir.file_name().and_then(|value| value.to_str()) != Some(ARTWORK_CACHE_DIR) {
        return Err(anyhow!("图片缓存目录不在允许的 artwork 边界内"));
    }
    let namespace_dir = cache_dir
        .parent()
        .ok_or_else(|| anyhow!("图片缓存目录缺少命名空间"))?;
    if namespace_dir.file_name().and_then(|value| value.to_str()) != Some(CACHE_NAMESPACE_DIR) {
        return Err(anyhow!("图片缓存目录不在 Cadilume 命名空间内"));
    }
    ensure_plain_cache_directory(namespace_dir)?;
    ensure_plain_cache_directory(cache_dir)
}

fn artwork_cache_key(
    server_id: &str,
    path: &str,
    width: Option<u32>,
    height: Option<u32>,
    authorization_token: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"cadilume-artwork-cache\0v1");
    // Keep cached artwork isolated by the current per-server authorization
    // without ever writing the credential itself to disk.
    update_hash_string(&mut hasher, authorization_token);
    update_hash_string(&mut hasher, server_id);
    update_hash_string(&mut hasher, path);
    update_hash_dimension(&mut hasher, width);
    update_hash_dimension(&mut hasher, height);
    format!("{:x}", hasher.finalize())
}

fn update_hash_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn update_hash_dimension(hasher: &mut Sha256, value: Option<u32>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hasher.update(value.to_be_bytes());
        }
        None => hasher.update([0]),
    }
}

fn artwork_cache_path(cache_dir: &Path, key: &str) -> Result<PathBuf> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    {
        return Err(anyhow!("无效的图片缓存键"));
    }
    Ok(cache_dir.join(format!("{key}.{ARTWORK_CACHE_EXTENSION}")))
}

fn encode_artwork_cache(mime: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.is_empty() {
        return Err(anyhow!("拒绝缓存空图片"));
    }
    let mime = validate_image_metadata(Some(mime), Some(bytes.len() as u64))?;
    if mime.len() > MAX_CACHE_MIME_BYTES {
        return Err(anyhow!("图片 MIME 类型过长"));
    }

    let mut encoded = Vec::with_capacity(ARTWORK_CACHE_MAGIC.len() + 2 + mime.len() + bytes.len());
    encoded.extend_from_slice(ARTWORK_CACHE_MAGIC);
    encoded.extend_from_slice(&(mime.len() as u16).to_be_bytes());
    encoded.extend_from_slice(mime.as_bytes());
    encoded.extend_from_slice(bytes);
    Ok(encoded)
}

fn decode_artwork_cache(encoded: &[u8]) -> Result<CachedArtwork> {
    let header_length = ARTWORK_CACHE_MAGIC.len() + 2;
    if encoded.len() < header_length || &encoded[..ARTWORK_CACHE_MAGIC.len()] != ARTWORK_CACHE_MAGIC
    {
        return Err(anyhow!("图片缓存格式无效"));
    }
    let mime_length = u16::from_be_bytes([
        encoded[ARTWORK_CACHE_MAGIC.len()],
        encoded[ARTWORK_CACHE_MAGIC.len() + 1],
    ]) as usize;
    if mime_length == 0 || mime_length > MAX_CACHE_MIME_BYTES {
        return Err(anyhow!("图片缓存 MIME 长度无效"));
    }
    let data_offset = header_length
        .checked_add(mime_length)
        .filter(|offset| *offset < encoded.len())
        .ok_or_else(|| anyhow!("图片缓存内容不完整"))?;
    let mime = std::str::from_utf8(&encoded[header_length..data_offset])
        .context("图片缓存 MIME 编码无效")?;
    let bytes = &encoded[data_offset..];
    let mime = validate_image_metadata(Some(mime), Some(bytes.len() as u64))?;
    Ok(CachedArtwork {
        mime,
        bytes: bytes.to_vec(),
    })
}

fn read_artwork_cache(cache_dir: &Path, key: &str) -> Result<Option<CachedArtwork>> {
    ensure_artwork_cache_boundary(cache_dir)?;
    let path = artwork_cache_path(cache_dir, key)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("无法检查图片缓存"),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!("图片缓存条目不是普通文件"));
    }
    let maximum_file_size = (ARTWORK_CACHE_MAGIC.len() + 2 + MAX_CACHE_MIME_BYTES)
        .saturating_add(MAX_IMAGE_BYTES) as u64;
    if metadata.len() > maximum_file_size {
        return Err(anyhow!("图片缓存条目超过大小限制"));
    }
    let artwork = decode_artwork_cache(&fs::read(&path).context("无法读取图片缓存")?)?;
    if let Ok(file) = OpenOptions::new().write(true).open(path) {
        let _ = file.set_times(FileTimes::new().set_modified(SystemTime::now()));
    }
    Ok(Some(artwork))
}

fn write_artwork_cache(cache_dir: &Path, key: &str, mime: &str, bytes: &[u8]) -> Result<()> {
    ensure_artwork_cache_boundary(cache_dir)?;
    match read_artwork_cache(cache_dir, key) {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(_) => discard_artwork_cache_entry(cache_dir, key),
    }

    let encoded = encode_artwork_cache(mime, bytes)?;
    prune_artwork_cache_to_fit(cache_dir, encoded.len() as u64, MAX_ARTWORK_CACHE_BYTES)?;
    let destination = artwork_cache_path(cache_dir, key)?;
    let temporary = cache_dir.join(format!(".{key}.{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .context("无法创建图片缓存临时文件")?;
        file.write_all(&encoded).context("无法写入图片缓存")?;
        file.sync_all().context("无法同步图片缓存")?;
        drop(file);
        match fs::rename(&temporary, &destination) {
            Ok(()) => Ok(()),
            Err(_) if destination.is_file() => Ok(()),
            Err(error) => Err(error).context("无法原子替换图片缓存"),
        }
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn prune_artwork_cache_to_fit(
    cache_dir: &Path,
    incoming_size: u64,
    maximum_size: u64,
) -> Result<()> {
    ensure_artwork_cache_boundary(cache_dir)?;
    if incoming_size > maximum_size {
        return Err(anyhow!("单个图片缓存条目超过总缓存限制"));
    }

    let mut total_size = 0_u64;
    let mut entries = Vec::new();
    for entry in fs::read_dir(cache_dir).context("无法读取图片缓存配额")? {
        let entry = entry.context("无法读取图片缓存配额条目")?;
        if entry.path().extension().and_then(|value| value.to_str())
            != Some(ARTWORK_CACHE_EXTENSION)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).context("无法检查图片缓存配额条目")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        total_size = total_size
            .checked_add(metadata.len())
            .ok_or_else(|| anyhow!("图片缓存大小统计溢出"))?;
        entries.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            entry.path(),
            metadata.len(),
        ));
    }

    entries.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, size) in entries {
        if total_size.saturating_add(incoming_size) <= maximum_size {
            break;
        }
        fs::remove_file(path).context("无法淘汰过期图片缓存")?;
        total_size = total_size.saturating_sub(size);
    }
    if total_size.saturating_add(incoming_size) > maximum_size {
        return Err(anyhow!("无法为图片缓存释放足够空间"));
    }
    Ok(())
}

fn discard_artwork_cache_entry(cache_dir: &Path, key: &str) {
    let Ok(path) = artwork_cache_path(cache_dir, key) else {
        return;
    };
    let _ = fs::remove_file(path);
}

fn artwork_cache_status(cache_dir: &Path) -> Result<CacheStatus> {
    ensure_artwork_cache_boundary(cache_dir)?;
    let mut status = CacheStatus {
        size_bytes: 0,
        file_count: 0,
    };
    for entry in fs::read_dir(cache_dir).context("无法读取图片缓存目录")? {
        let entry = entry.context("无法读取图片缓存条目")?;
        if entry.path().extension().and_then(|value| value.to_str())
            != Some(ARTWORK_CACHE_EXTENSION)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).context("无法检查图片缓存条目")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        status.size_bytes = status
            .size_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| anyhow!("图片缓存大小统计溢出"))?;
        status.file_count = status
            .file_count
            .checked_add(1)
            .ok_or_else(|| anyhow!("图片缓存文件数量统计溢出"))?;
    }
    Ok(status)
}

fn clear_artwork_cache(cache_dir: &Path) -> Result<CacheStatus> {
    ensure_artwork_cache_boundary(cache_dir)?;
    for entry in fs::read_dir(cache_dir).context("无法读取待清理的图片缓存目录")? {
        let entry = entry.context("无法读取待清理的图片缓存条目")?;
        let file_type = entry.file_type().context("无法检查待清理的图片缓存条目")?;
        let path = entry.path();
        if file_type.is_dir() && !file_type.is_symlink() {
            fs::remove_dir_all(path).context("无法清理图片缓存子目录")?;
        } else {
            fs::remove_file(path).context("无法清理图片缓存文件")?;
        }
    }
    artwork_cache_status(cache_dir)
}

fn valid_internal_image_path(path: &str) -> bool {
    let lowercase = path.to_ascii_lowercase();
    path.len() <= 4096
        && (path.starts_with("/library/") || path.starts_with("/playlists/"))
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && !path.contains(['?', '#'])
        && !lowercase.contains("%2e")
        && !lowercase.contains("%2f")
        && !lowercase.contains("%5c")
        && !path.split('/').any(|segment| matches!(segment, "." | ".."))
}

fn valid_artwork_dimension(value: Option<u32>) -> bool {
    value.is_none_or(|value| (1..=4096).contains(&value))
}

fn validate_image_metadata(
    content_type: Option<&str>,
    content_length: Option<u64>,
) -> Result<String> {
    if content_length.is_some_and(|length| length > MAX_IMAGE_BYTES as u64) {
        return Err(anyhow!("Plex 图片超过 12 MiB 限制"));
    }
    let mime = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| {
            let Some(subtype) = value.strip_prefix("image/") else {
                return false;
            };
            !subtype.is_empty()
                && subtype.chars().all(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(
                            character,
                            '!' | '#' | '$' | '&' | '-' | '^' | '_' | '.' | '+'
                        )
                })
        })
        .ok_or_else(|| anyhow!("Plex 图片响应缺少有效的 image Content-Type"))?;
    Ok(mime)
}

fn cached_server(state: &PlexState, server_id: &str) -> Result<CachedServer> {
    state
        .servers
        .read()
        .map_err(|_| anyhow!("服务器缓存读取失败"))?
        .get(server_id)
        .cloned()
        .ok_or_else(|| anyhow!("找不到服务器，请重新刷新服务器列表"))
}

fn clear_artwork_for_account_change(state: &PlexState) -> Result<()> {
    let _cache_guard = state
        .cache_lock
        .write()
        .map_err(|_| anyhow!("图片缓存清理锁定失败"))?;
    clear_artwork_cache(&state.cache_dir).map(|_| ())
}

fn allowed_server_path(path: &str) -> bool {
    server_endpoint("https://cadilume.invalid", path).is_ok()
        && (path.starts_with("/library/")
            || path.starts_with("/hubs/")
            || path == "/playlists"
            || path.starts_with("/playlists/")
            || path.starts_with("/:/"))
}

fn audio_playlist_query() -> HashMap<String, String> {
    HashMap::from([
        ("type".to_string(), "15".to_string()),
        ("playlistType".to_string(), "audio".to_string()),
    ])
}

fn create_audio_playlist_query(
    server_id: &str,
    title: &str,
    seed_rating_key: Option<&str>,
) -> Result<HashMap<String, String>> {
    if !valid_plex_identifier(server_id) {
        return Err(anyhow!("无效的 Plex 服务器标识"));
    }
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 255 || title.chars().any(char::is_control) {
        return Err(anyhow!("歌单名称必须为 1–255 个有效字符"));
    }
    let mut query = HashMap::from([
        ("type".to_string(), "audio".to_string()),
        ("title".to_string(), title.to_string()),
        ("smart".to_string(), "0".to_string()),
    ]);
    if let Some(rating_key) = seed_rating_key {
        query.insert("uri".to_string(), playlist_item_uri(server_id, rating_key)?);
        query.insert("includeExternalMedia".to_string(), "1".to_string());
    }
    Ok(query)
}

fn normalize_playlist_summary(summary: &str) -> Result<String> {
    let summary = summary.trim();
    if summary.chars().count() > 1000
        || summary
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(anyhow!("歌单描述最多为 1000 个有效字符"));
    }
    Ok(summary.to_string())
}

fn created_playlist_record(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    let root = value.get("MediaContainer").unwrap_or(value);
    if let Some(record) = root
        .as_object()
        .filter(|record| record.contains_key("ratingKey"))
    {
        return Some(record);
    }
    ["Metadata", "Playlist"]
        .into_iter()
        .find_map(|key| root.get(key)?.as_array()?.first()?.as_object())
}

fn created_playlist_record_mut(value: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
    let has_media_container = value.get("MediaContainer").is_some();
    let root = if has_media_container {
        value.get_mut("MediaContainer")?
    } else {
        value
    };
    if root
        .as_object()
        .is_some_and(|record| record.contains_key("ratingKey"))
    {
        return root.as_object_mut();
    }
    if root.get("Metadata").is_some() {
        return root
            .get_mut("Metadata")?
            .as_array_mut()?
            .first_mut()?
            .as_object_mut();
    }
    root.get_mut("Playlist")?
        .as_array_mut()?
        .first_mut()?
        .as_object_mut()
}

fn created_playlist_rating_key(value: &Value) -> Option<String> {
    match created_playlist_record(value)?.get("ratingKey")? {
        Value::String(value) if valid_plex_identifier(value) => Some(value.clone()),
        Value::Number(value) if valid_plex_identifier(&value.to_string()) => {
            Some(value.to_string())
        }
        _ => None,
    }
}

fn set_created_playlist_summary(value: &mut Value, summary: &str) {
    if let Some(record) = created_playlist_record_mut(value) {
        record.insert("summary".to_string(), Value::String(summary.to_string()));
    }
}

fn reset_created_playlist_counts(value: &mut Value) {
    if let Some(record) = created_playlist_record_mut(value) {
        record.insert("leafCount".to_string(), Value::Number(0.into()));
        record.insert("duration".to_string(), Value::Number(0.into()));
    }
}

fn playlist_path(playlist_id: &str) -> Result<String> {
    if !valid_plex_identifier(playlist_id) {
        return Err(anyhow!("无效的 Plex 歌单标识"));
    }
    Ok(format!("/playlists/{playlist_id}"))
}

fn playlist_items_path(playlist_id: &str) -> Result<String> {
    Ok(format!("{}/items", playlist_path(playlist_id)?))
}

fn playlist_item_path(playlist_id: &str, playlist_item_id: &str) -> Result<String> {
    if !valid_plex_identifier(playlist_item_id) {
        return Err(anyhow!("无效的 Plex 歌单项标识"));
    }
    Ok(format!(
        "{}/{}",
        playlist_items_path(playlist_id)?,
        playlist_item_id
    ))
}

fn playlist_item_uri(server_id: &str, rating_key: &str) -> Result<String> {
    if !valid_plex_identifier(server_id) || !valid_plex_identifier(rating_key) {
        return Err(anyhow!("无效的 Plex 歌单项目标识"));
    }
    Ok(format!(
        "server://{server_id}/com.plexapp.plugins.library/library/metadata/{rating_key}"
    ))
}

fn normalize_playlist_batch_rating_keys(rating_keys: Vec<String>) -> Result<Vec<String>> {
    if rating_keys.is_empty() {
        return Err(anyhow!("请至少选择一首歌曲"));
    }
    if rating_keys.len() > MAX_PLAYLIST_BATCH_TRACKS {
        return Err(anyhow!(
            "一次最多可添加 {MAX_PLAYLIST_BATCH_TRACKS} 首歌曲到歌单"
        ));
    }

    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(rating_keys.len());
    for rating_key in rating_keys {
        if !valid_plex_identifier(&rating_key) {
            return Err(anyhow!("无效的 Plex 歌单项目标识"));
        }
        if seen.insert(rating_key.clone()) {
            normalized.push(rating_key);
        }
    }
    if normalized.is_empty() {
        return Err(anyhow!("请至少选择一首歌曲"));
    }
    Ok(normalized)
}

fn normalize_playlist_batch_item_ids(playlist_item_ids: Vec<String>) -> Result<Vec<String>> {
    if playlist_item_ids.is_empty() {
        return Err(anyhow!("请至少选择一首歌曲"));
    }
    if playlist_item_ids.len() > MAX_PLAYLIST_BATCH_TRACKS {
        return Err(anyhow!("一次最多可移除 {MAX_PLAYLIST_BATCH_TRACKS} 首歌曲"));
    }

    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(playlist_item_ids.len());
    for playlist_item_id in playlist_item_ids {
        if !valid_plex_identifier(&playlist_item_id) {
            return Err(anyhow!("无效的 Plex 歌单项标识"));
        }
        if seen.insert(playlist_item_id.clone()) {
            normalized.push(playlist_item_id);
        }
    }
    if normalized.is_empty() {
        return Err(anyhow!("请至少选择一首歌曲"));
    }
    Ok(normalized)
}

fn valid_plex_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, b'-' | b'_'))
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(not(debug_assertions))]
fn keyring_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(Into::into)
}

/// Development-only plaintext fallback: read the Plex account token from a
/// local file outside the repository (default `~/.cadilume-dev-token`, or
/// `CADILUME_DEV_TOKEN_FILE`). It must never be committed or logged; deleting
/// the file restores Keychain-only mode.
#[cfg(debug_assertions)]
fn dev_token_fallback_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CADILUME_DEV_TOKEN_FILE") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_else(|| std::env::temp_dir().into_os_string());
    PathBuf::from(home).join(".cadilume-dev-token")
}

#[cfg(debug_assertions)]
fn read_dev_token_fallback() -> Option<String> {
    let token = fs::read_to_string(dev_token_fallback_path())
        .ok()?
        .trim()
        .to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

#[cfg(unix)]
#[cfg(debug_assertions)]
fn write_dev_token_file(path: &Path, token: &str) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("写入开发 token 文件失败: {e}"))?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("收紧开发 token 文件权限失败: {e}"))?;
    file.write_all(token.as_bytes())
        .map_err(|e| format!("写入开发 token 文件失败: {e}"))?;
    Ok(())
}

#[cfg(unix)]
#[cfg(debug_assertions)]
fn write_dev_token_fallback(token: &str) -> Result<(), String> {
    write_dev_token_file(&dev_token_fallback_path(), token)
}

#[cfg(not(unix))]
#[cfg(debug_assertions)]
fn write_dev_token_fallback(token: &str) -> Result<(), String> {
    use std::io::Write;
    let path = dev_token_fallback_path();
    let mut file =
        std::fs::File::create(&path).map_err(|e| format!("写入开发 token 文件失败: {e}"))?;
    file.write_all(token.as_bytes())
        .map_err(|e| format!("写入开发 token 文件失败: {e}"))?;
    Ok(())
}

/// Dev builds store credentials only in the plaintext fallback file and never
/// touch the Keychain; release builds use the Keychain exclusively.
#[cfg(debug_assertions)]
fn read_account_token() -> Option<String> {
    read_dev_token_fallback()
}

#[cfg(not(debug_assertions))]
fn read_account_token() -> Option<String> {
    keyring_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

#[cfg(debug_assertions)]
fn store_account_token(token: &str) -> Result<(), String> {
    write_dev_token_fallback(token)
}

#[cfg(not(debug_assertions))]
fn store_account_token(token: &str) -> Result<(), String> {
    keyring_entry()
        .map_err(|e| e.to_string())?
        .set_password(token)
        .map_err(|e| e.to_string())
}

#[cfg(debug_assertions)]
fn delete_account_token() {
    let _ = std::fs::remove_file(dev_token_fallback_path());
}

#[cfg(not(debug_assertions))]
fn delete_account_token() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

async fn ensure_success(response: Response, context: &str) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return Err(anyhow!("{context}：登录已失效"));
    }
    Err(anyhow!("{context}：HTTP {status} {detail}"))
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestCache {
        root: PathBuf,
        artwork: PathBuf,
    }

    impl TestCache {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("cadilume-cache-test-{}", Uuid::new_v4()));
            fs::create_dir(&root).expect("test cache root should be created");
            let artwork = initialize_artwork_cache_dir(&root)
                .expect("artwork cache directory should be initialized");
            Self { root, artwork }
        }
    }

    impl Drop for TestCache {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    #[test]
    fn rewriting_existing_dev_token_tightens_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let cache = TestCache::new();
        let path = cache.root.join("dev-token");
        fs::write(&path, "old-token").expect("existing token should be created");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
            .expect("test token permissions should be relaxed");

        write_dev_token_file(&path, "new-token").expect("token rewrite should succeed");

        assert_eq!(fs::read_to_string(&path).unwrap(), "new-token");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn persisted_config_migrates_device_name_and_removes_retired_preferences() {
        let mut raw = serde_json::from_str::<Value>(
            r#"{"clientIdentifier":"client-1","closeBehavior":"tray","syncRecentPlays":true,"audioCacheLimitGib":10,"brandPreset":"plex"}"#,
        )
        .expect("old config should remain readable");
        assert!(strip_retired_config_values(&mut raw));
        assert!(raw.get("closeBehavior").is_none());
        assert!(raw.get("syncRecentPlays").is_none());
        assert!(raw.get("audioCacheLimitGib").is_none());
        let mut config: PersistedConfig =
            serde_json::from_value(raw).expect("retired preference should not block migration");

        assert!(normalize_persisted_device_name(&mut config));
        assert!(!config.device_name.is_empty());
        assert!(normalize_device_name(&config.device_name).is_ok());
        assert_eq!(config.brand_preset, BrandPreset::Amber);
        assert!(config.status_icon_enabled);
        let serialized = serde_json::to_value(config).expect("config should serialize");
        assert_eq!(serialized["statusIconEnabled"], true);
        assert!(serialized.get("audioCacheLimitGib").is_none());
        assert!(serialized.get("closeBehavior").is_none());
        assert!(serialized.get("syncRecentPlays").is_none());
    }

    #[test]
    fn device_name_is_normalized_and_rejects_unsafe_values() {
        assert_eq!(normalize_device_name("  客厅   Mac  ").unwrap(), "客厅 Mac");
        for invalid in ["", "   ", "客厅\nMac"] {
            assert!(normalize_device_name(invalid).is_err());
        }
        assert!(
            normalize_device_name("设".repeat(MAX_DEVICE_NAME_CHARACTERS + 1).as_str()).is_err()
        );
    }

    #[test]
    fn plex_identity_headers_include_the_product_and_editable_device_name() {
        let request = apply_plex_identity_headers(
            reqwest::Client::new().get("https://example.test/"),
            "cadilume-client-id",
            "客厅 Mac",
        )
        .build()
        .expect("identity headers should build");

        assert_eq!(
            request
                .headers()
                .get("X-Plex-Product")
                .and_then(|value| value.to_str().ok()),
            Some(PRODUCT_NAME)
        );
        assert_eq!(
            request
                .headers()
                .get("X-Plex-Client-Title")
                .and_then(|value| value.to_str().ok()),
            Some(PRODUCT_NAME)
        );
        assert_eq!(
            request
                .headers()
                .get("X-Plex-Client-Identifier")
                .and_then(|value| value.to_str().ok()),
            Some("cadilume-client-id")
        );
        assert_eq!(
            request
                .headers()
                .get("X-Plex-Device-Name")
                .map(|value| value.as_bytes()),
            Some("客厅 Mac".as_bytes())
        );
    }

    #[test]
    fn only_expected_server_paths_are_allowed() {
        assert!(allowed_server_path("/library/sections"));
        assert!(allowed_server_path("/hubs/search"));
        assert!(allowed_server_path("/:/timeline"));
        assert!(!allowed_server_path("https://example.com"));
        assert!(!allowed_server_path("/identity"));
    }

    #[test]
    fn account_playlist_query_is_flat_and_includes_all_audio_playlists() {
        let query = audio_playlist_query();

        assert_eq!(query.len(), 2);
        assert_eq!(query.get("type").map(String::as_str), Some("15"));
        assert_eq!(query.get("playlistType").map(String::as_str), Some("audio"));
        assert!(!query.contains_key("smart"));
    }

    #[test]
    fn demote_cached_connection_moves_failed_connection_to_the_end() {
        let mut connections = vec![
            CachedConnection {
                uri: "https://local.test".into(),
                local: true,
                relay: false,
                secure: true,
            },
            CachedConnection {
                uri: "https://remote-a.test".into(),
                local: false,
                relay: false,
                secure: true,
            },
            CachedConnection {
                uri: "https://remote-b.test".into(),
                local: false,
                relay: false,
                secure: true,
            },
        ];

        demote_cached_connection(&mut connections, 0);
        assert_eq!(connections[0].uri, "https://remote-a.test");
        assert_eq!(connections[1].uri, "https://remote-b.test");
        assert_eq!(connections[2].uri, "https://local.test");

        demote_cached_connection(&mut connections, 1);
        assert_eq!(connections[0].uri, "https://local.test");
        assert_eq!(connections[1].uri, "https://remote-a.test");
        assert_eq!(connections[2].uri, "https://remote-b.test");
    }

    #[test]
    fn create_playlist_query_supports_a_seed_track_and_validates_input() {
        let query =
            create_audio_playlist_query("server_A-1", "  通勤音乐  ", Some("track-42")).unwrap();

        assert_eq!(query.len(), 5);
        assert_eq!(query.get("type").map(String::as_str), Some("audio"));
        assert_eq!(query.get("title").map(String::as_str), Some("通勤音乐"));
        assert_eq!(query.get("smart").map(String::as_str), Some("0"));
        assert_eq!(
            query.get("uri").map(String::as_str),
            Some("server://server_A-1/com.plexapp.plugins.library/library/metadata/track-42")
        );
        assert_eq!(
            query.get("includeExternalMedia").map(String::as_str),
            Some("1")
        );

        let blank = create_audio_playlist_query("server_A-1", "空歌单", None).unwrap();
        assert_eq!(blank.len(), 3);
        assert!(!blank.contains_key("uri"));

        for invalid in ["", "   ", "含\n换行"] {
            assert!(create_audio_playlist_query("server_A-1", invalid, None).is_err());
        }
        assert!(
            create_audio_playlist_query("server_A-1", "歌".repeat(256).as_str(), None).is_err()
        );
        assert!(create_audio_playlist_query("server_A-1", "歌".repeat(255).as_str(), None).is_ok());
        assert!(create_audio_playlist_query("../server", "通勤音乐", None).is_err());
        assert!(create_audio_playlist_query("server_A-1", "通勤音乐", Some("../track")).is_err());
    }

    #[test]
    fn playlist_summary_is_trimmed_validated_and_applied_to_created_metadata() {
        assert_eq!(
            normalize_playlist_summary("  城市移动时听\n保持清醒  ").unwrap(),
            "城市移动时听\n保持清醒"
        );
        assert!(normalize_playlist_summary("\0").is_err());
        assert!(normalize_playlist_summary("描述".repeat(501).as_str()).is_err());

        let mut response = serde_json::json!({
            "MediaContainer": {
                "Metadata": [{ "ratingKey": "playlist-99", "title": "通勤音乐" }]
            }
        });
        assert_eq!(
            created_playlist_rating_key(&response).as_deref(),
            Some("playlist-99")
        );
        set_created_playlist_summary(&mut response, "城市移动时听");
        assert_eq!(
            response["MediaContainer"]["Metadata"][0]["summary"].as_str(),
            Some("城市移动时听")
        );
        reset_created_playlist_counts(&mut response);
        assert_eq!(response["MediaContainer"]["Metadata"][0]["leafCount"], 0);
        assert_eq!(response["MediaContainer"]["Metadata"][0]["duration"], 0);
    }

    #[test]
    fn playlist_items_path_accepts_only_clean_identifiers() {
        assert_eq!(
            playlist_path("playlist_A-42").unwrap(),
            "/playlists/playlist_A-42"
        );
        assert_eq!(
            playlist_items_path("playlist_A-42").unwrap(),
            "/playlists/playlist_A-42/items"
        );
        assert_eq!(
            playlist_item_path("playlist_A-42", "item-7").unwrap(),
            "/playlists/playlist_A-42/items/item-7"
        );
        for invalid in ["", "../7", "7/items", "7?x=1", "7#items", "7 items"] {
            assert!(playlist_item_path("playlist_A-42", invalid).is_err());
        }
        for invalid in ["", "../42", "42/items", "42?x=1", "42#items", "42 items"] {
            assert!(playlist_items_path(invalid).is_err());
        }
        assert!(playlist_items_path("a".repeat(257).as_str()).is_err());
    }

    #[test]
    fn playlist_item_uri_is_server_scoped_and_rejects_path_injection() {
        assert_eq!(
            playlist_item_uri("server_A-1", "track-42").unwrap(),
            "server://server_A-1/com.plexapp.plugins.library/library/metadata/track-42"
        );
        for invalid in [
            "",
            "../server",
            "server/id",
            "server?id",
            "server#id",
            "server id",
        ] {
            assert!(playlist_item_uri(invalid, "track-42").is_err());
            assert!(playlist_item_uri("server-1", invalid).is_err());
        }
        assert!(playlist_item_uri("a".repeat(257).as_str(), "track-42").is_err());
    }

    #[test]
    fn playlist_batch_keys_are_bounded_validated_and_stably_deduplicated() {
        assert_eq!(
            normalize_playlist_batch_rating_keys(vec![
                "track-1".to_string(),
                "track-2".to_string(),
                "track-1".to_string(),
            ])
            .unwrap(),
            vec!["track-1", "track-2"]
        );
        assert!(normalize_playlist_batch_rating_keys(Vec::new()).is_err());
        assert_eq!(
            normalize_playlist_batch_item_ids(vec![
                "item-1".to_string(),
                "item-2".to_string(),
                "item-1".to_string(),
            ])
            .unwrap(),
            vec!["item-1", "item-2"]
        );
        assert!(normalize_playlist_batch_item_ids(Vec::new()).is_err());
        assert!(normalize_playlist_batch_item_ids(vec!["../item".to_string()]).is_err());
        assert!(normalize_playlist_batch_item_ids(vec!["a".repeat(257)]).is_err());
        assert!(normalize_playlist_batch_rating_keys(vec!["../track".to_string()]).is_err());
        assert!(normalize_playlist_batch_rating_keys(vec!["track".repeat(100)]).is_err());
    }

    #[test]
    fn config_defaults_keep_required_local_preferences() {
        assert!(PersistedConfig::default().status_icon_enabled);
        assert!(!PersistedConfig::default().device_name.is_empty());
        assert_eq!(PersistedConfig::default().brand_preset, BrandPreset::Amber);
    }

    #[test]
    fn status_icon_platform_matches_the_compiled_native_target() {
        #[cfg(target_os = "macos")]
        assert_eq!(status_icon_platform(), Some(StatusIconPlatform::Macos));
        #[cfg(target_os = "windows")]
        assert_eq!(status_icon_platform(), Some(StatusIconPlatform::Windows));
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(status_icon_platform(), None);
    }

    #[test]
    fn pin_response_never_serializes_the_private_token() {
        let private_pin = Pin {
            id: 42,
            code: "ABCD".to_string(),
            expires_in: 300,
            auth_token: Some("account-secret".to_string()),
        };
        let response = PinResponse::from_pin(private_pin, true);
        let serialized = serde_json::to_value(response).expect("PIN response should serialize");

        assert_eq!(serialized["id"], 42);
        assert_eq!(serialized["code"], "ABCD");
        assert_eq!(serialized["expiresIn"], 300);
        assert_eq!(serialized["authenticated"], true);
        assert!(serialized.get("authToken").is_none());
        assert!(!serialized.to_string().contains("account-secret"));
    }

    #[test]
    fn server_endpoints_stay_on_valid_http_origins() {
        let endpoint = server_endpoint("https://music.example.test:32400", "/library/metadata/42")
            .expect("valid Plex endpoint should be accepted");
        assert_eq!(
            endpoint.as_str(),
            "https://music.example.test:32400/library/metadata/42"
        );

        for connection in [
            "ftp://music.example.test",
            "https://user@music.example.test",
            "https://music.example.test?redirect=https://evil.test",
            "https://music.example.test#fragment",
            "not a url",
        ] {
            assert!(server_endpoint(connection, "/library/metadata/42").is_err());
        }
        for path in [
            "//evil.test/library/metadata/42",
            "/library/../identity",
            "/library/%2e%2e/identity",
            "/library/metadata/42?redirect=https://evil.test",
            "/library/metadata/42\\evil",
        ] {
            assert!(server_endpoint("https://music.example.test", path).is_err());
        }
    }

    #[test]
    fn non_idempotent_writes_retry_only_before_a_connection_is_established() {
        assert!(should_retry_server_connection(
            &Method::GET,
            ServerAttemptFailure::HttpResponse
        ));
        assert!(should_retry_server_connection(
            &Method::PUT,
            ServerAttemptFailure::Connect
        ));
        assert!(!should_retry_server_connection(
            &Method::PUT,
            ServerAttemptFailure::HttpResponse
        ));
        assert!(!should_retry_server_connection(
            &Method::PUT,
            ServerAttemptFailure::OtherTransport
        ));
    }

    #[test]
    fn lyric_stream_selection_preserves_pms_order() {
        let metadata = serde_json::json!({
            "MediaContainer": {
                "Metadata": [{
                    "Media": [{
                        "Part": [{
                            "Stream": [
                                { "streamType": 4, "key": "/first.txt", "provider": "other", "timed": false },
                                { "streamType": 4, "key": "/remote-timed.lrc", "provider": "other", "timed": true },
                                { "streamType": 4, "key": "/local-plain.txt", "provider": "com.plexapp.agents.localmedia", "timed": false },
                                { "streamType": 4, "key": "/local-timed.lrc", "provider": "com.plexapp.agents.localmedia", "timed": true }
                            ]
                        }]
                    }]
                }]
            }
        });

        let keys = lyric_streams_from_metadata(&metadata)
            .into_iter()
            .map(|stream| stream.key)
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            vec![
                "/first.txt".to_string(),
                "/remote-timed.lrc".to_string(),
                "/local-plain.txt".to_string(),
                "/local-timed.lrc".to_string(),
            ]
        );
    }

    #[test]
    fn parses_plex_xml_lyrics_and_inline_attribution() {
        let stream = LyricStream {
            key: "/library/streams/42".to_string(),
            provider: Some("fallback-provider".to_string()),
            timed: false,
        };
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="1">
  <Lyrics provider="com.plexapp.agents.localmedia" timed="1" author="作者" by="来源">
    <Line startOffset="1234" endOffset="5678"><Span text="Hello "/><Span text="&amp; world"/></Line>
    <Line startOffset="5678"><Span text="第二行"/></Line>
  </Lyrics>
</MediaContainer>"#;

        let payload = parse_plex_xml(xml, &stream).expect("XML lyrics should parse");
        assert_eq!(
            payload.provider.as_deref(),
            Some("com.plexapp.agents.localmedia")
        );
        assert!(payload.timed);
        assert_eq!(payload.author.as_deref(), Some("作者"));
        assert_eq!(payload.by.as_deref(), Some("来源"));
        assert_eq!(
            payload.lines,
            vec![
                PlexLyricLine {
                    start_ms: Some(1234),
                    end_ms: Some(5678),
                    text: "Hello & world".to_string(),
                },
                PlexLyricLine {
                    start_ms: Some(5678),
                    end_ms: None,
                    text: "第二行".to_string(),
                },
            ]
        );
    }

    #[test]
    fn image_metadata_requires_image_mime_and_enforces_size_limit() {
        assert_eq!(
            validate_image_metadata(Some("image/jpeg; charset=binary"), Some(1024)).unwrap(),
            "image/jpeg"
        );
        assert!(validate_image_metadata(Some("text/html"), Some(1024)).is_err());
        assert!(
            validate_image_metadata(Some("image/png"), Some(MAX_IMAGE_BYTES as u64 + 1)).is_err()
        );
    }

    #[test]
    fn artwork_inputs_are_internal_and_resource_bounded() {
        assert!(valid_internal_image_path(
            "/library/metadata/42/thumb/12345"
        ));
        assert!(valid_internal_image_path("/playlists/42/composite/12345"));
        for path in [
            "https://evil.test/image.jpg",
            "//evil.test/image.jpg",
            "/library/../identity",
            "/library/%2e%2e/identity",
            "/library/metadata/42/thumb?url=https://evil.test",
            "/:/resources/photo",
        ] {
            assert!(!valid_internal_image_path(path));
        }
        assert!(valid_artwork_dimension(None));
        assert!(valid_artwork_dimension(Some(1)));
        assert!(valid_artwork_dimension(Some(4096)));
        assert!(!valid_artwork_dimension(Some(0)));
        assert!(!valid_artwork_dimension(Some(4097)));
    }

    #[test]
    fn artwork_cache_key_is_stable_and_uses_all_request_fields() {
        let key = artwork_cache_key(
            "server-a",
            "/library/metadata/42/thumb/7",
            Some(512),
            None,
            "token-a",
        );
        assert_eq!(
            key,
            artwork_cache_key(
                "server-a",
                "/library/metadata/42/thumb/7",
                Some(512),
                None,
                "token-a"
            )
        );
        assert_eq!(
            key,
            "e9f2a62e10de143a1c4facaeec3bd471e35e66ee602fe6b210ec2360e40b59ad"
        );
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(
            key,
            artwork_cache_key(
                "server-b",
                "/library/metadata/42/thumb/7",
                Some(512),
                None,
                "token-a"
            )
        );
        assert_ne!(
            key,
            artwork_cache_key(
                "server-a",
                "/library/metadata/43/thumb/7",
                Some(512),
                None,
                "token-a"
            )
        );
        assert_ne!(
            key,
            artwork_cache_key(
                "server-a",
                "/library/metadata/42/thumb/7",
                None,
                None,
                "token-a"
            )
        );
        assert_ne!(
            key,
            artwork_cache_key(
                "server-a",
                "/library/metadata/42/thumb/7",
                Some(512),
                Some(512),
                "token-a"
            )
        );
        assert_ne!(
            key,
            artwork_cache_key(
                "server-a",
                "/library/metadata/42/thumb/7",
                Some(512),
                None,
                "token-b"
            )
        );
    }

    #[test]
    fn artwork_cache_round_trip_hits_and_reports_disk_size() {
        let cache = TestCache::new();
        let key = artwork_cache_key(
            "server-a",
            "/library/metadata/42/thumb/7",
            Some(256),
            Some(256),
            "token-a",
        );
        let bytes = b"fake-image-payload";

        write_artwork_cache(&cache.artwork, &key, "image/png", bytes)
            .expect("artwork should be cached");
        let cached = read_artwork_cache(&cache.artwork, &key)
            .expect("cache read should succeed")
            .expect("cache should hit");
        assert_eq!(cached.mime, "image/png");
        assert_eq!(cached.bytes, bytes);

        let cache_file_size = fs::metadata(
            artwork_cache_path(&cache.artwork, &key).expect("cache key should be safe"),
        )
        .expect("cache file should exist")
        .len();
        assert_eq!(
            artwork_cache_status(&cache.artwork).expect("cache status should be available"),
            CacheStatus {
                size_bytes: cache_file_size,
                file_count: 1,
            }
        );
    }

    #[test]
    fn artwork_cache_prunes_the_oldest_entries_to_its_disk_budget() {
        let cache = TestCache::new();
        let oldest_key = artwork_cache_key(
            "server-a",
            "/library/metadata/1/thumb",
            Some(256),
            Some(256),
            "token-a",
        );
        let newest_key = artwork_cache_key(
            "server-a",
            "/library/metadata/2/thumb",
            Some(256),
            Some(256),
            "token-a",
        );
        write_artwork_cache(&cache.artwork, &oldest_key, "image/png", b"oldest")
            .expect("oldest artwork should be cached");
        write_artwork_cache(&cache.artwork, &newest_key, "image/png", b"newest")
            .expect("newest artwork should be cached");
        let oldest_path = artwork_cache_path(&cache.artwork, &oldest_key).unwrap();
        let newest_path = artwork_cache_path(&cache.artwork, &newest_key).unwrap();
        OpenOptions::new()
            .write(true)
            .open(&oldest_path)
            .unwrap()
            .set_times(
                FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1)),
            )
            .unwrap();
        OpenOptions::new()
            .write(true)
            .open(&newest_path)
            .unwrap()
            .set_times(
                FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(2)),
            )
            .unwrap();
        let incoming_size = fs::metadata(&oldest_path).unwrap().len();
        let maximum_size = fs::metadata(&newest_path).unwrap().len() + incoming_size;

        prune_artwork_cache_to_fit(&cache.artwork, incoming_size, maximum_size)
            .expect("quota pruning should succeed");

        assert!(!oldest_path.exists());
        assert!(newest_path.exists());
    }

    #[test]
    fn clear_artwork_cache_stays_inside_artwork_directory() {
        let cache = TestCache::new();
        let key = artwork_cache_key(
            "server-a",
            "/library/metadata/42/thumb/7",
            None,
            None,
            "token-a",
        );
        write_artwork_cache(&cache.artwork, &key, "image/jpeg", b"cached-image")
            .expect("artwork should be cached");
        fs::write(cache.artwork.join("stale.tmp"), b"temporary")
            .expect("stale cache file should be created");
        let nested = cache.artwork.join("stale");
        fs::create_dir(&nested).expect("stale cache directory should be created");
        fs::write(nested.join("entry"), b"temporary")
            .expect("nested stale cache file should be created");
        let sibling = cache.root.join("keep.txt");
        fs::write(&sibling, b"outside artwork cache").expect("sibling should be created");

        assert_eq!(
            clear_artwork_cache(&cache.artwork).expect("cache clear should succeed"),
            CacheStatus {
                size_bytes: 0,
                file_count: 0,
            }
        );
        assert!(cache.artwork.is_dir());
        assert_eq!(fs::read(sibling).unwrap(), b"outside artwork cache");
        assert_eq!(fs::read_dir(&cache.artwork).unwrap().count(), 0);
    }
}

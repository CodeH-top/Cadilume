use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddrV4, TcpListener as StdTcpListener},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        header::{
            ACCEPT, ACCEPT_ENCODING, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, ETAG, HOST, IF_RANGE, LAST_MODIFIED, RANGE, TRANSFER_ENCODING,
        },
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::Response,
    routing::get,
    Router,
};
use reqwest::{redirect::Policy, Client};
use tauri::{AppHandle, Manager, State as TauriState};
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;
use uuid::Uuid;

use crate::plex::{PlexState, StreamConnectionSnapshot};

const UNUSED_TICKET_TTL: Duration = Duration::from_secs(90);
// A direct-play response can stay open for hours without resolving the ticket
// again. Keep an already-used high-entropy loopback ticket seekable for long
// albums and recordings; logout and the bounded registry still revoke it.
const ACTIVE_TICKET_IDLE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_TICKET_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_AUDIO_TICKETS: usize = 128;
const MAX_ARTWORK_TICKETS: usize = 512;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(15);
// Matches the music profile Plex Web itself advertises for an HTTP single
// MP3 stream. `replace=true` is only used for video `add-limitation` entries
// and is not part of the official music transcode target syntax.
const TRANSCODE_PROFILE: &str = "add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StreamClientTimeoutPolicy {
    connect: Duration,
    response_headers: Duration,
    total: Option<Duration>,
    read: Option<Duration>,
}

const STREAM_CLIENT_TIMEOUTS: StreamClientTimeoutPolicy = StreamClientTimeoutPolicy {
    connect: CONNECT_TIMEOUT,
    response_headers: RESPONSE_HEADER_TIMEOUT,
    // A total/read timeout would keep running while the response body is playing and
    // cut off long tracks. Only connection establishment is bounded here.
    total: None,
    read: None,
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct StreamTarget {
    server_id: String,
    metadata_key: String,
    part_key: String,
    quality: String,
    session_id: String,
    public_bitrate_marker: Option<u16>,
}

impl StreamTarget {
    fn new(
        server_id: String,
        metadata_key: String,
        part_key: String,
        quality: String,
    ) -> Result<Self> {
        if server_id.is_empty() || server_id.len() > 256 || server_id.chars().any(char::is_control)
        {
            return Err(anyhow!("无效的 Plex 服务器标识"));
        }
        if !matches!(
            quality.as_str(),
            "auto" | "original" | "320" | "256" | "192"
        ) {
            return Err(anyhow!("无效的音频质量"));
        }

        let public_bitrate_marker = public_bitrate_marker(&quality);
        Ok(Self {
            server_id,
            metadata_key: sanitize_internal_path(&metadata_key, "/library/metadata/")?,
            part_key: sanitize_internal_path(&part_key, "/library/parts/")?,
            quality,
            session_id: Uuid::new_v4().to_string(),
            public_bitrate_marker,
        })
    }
}

#[derive(Debug, Clone)]
struct TicketRecord<T> {
    target: T,
    created_at: Instant,
    last_used_at: Option<Instant>,
}

impl<T> TicketRecord<T> {
    fn is_expired(&self, now: Instant) -> bool {
        if now.saturating_duration_since(self.created_at) > MAX_TICKET_LIFETIME {
            return true;
        }
        match self.last_used_at {
            Some(last_used_at) => {
                now.saturating_duration_since(last_used_at) > ACTIVE_TICKET_IDLE_TTL
            }
            None => now.saturating_duration_since(self.created_at) > UNUSED_TICKET_TTL,
        }
    }
}

struct TicketRegistry<T> {
    entries: HashMap<String, TicketRecord<T>>,
    capacity: usize,
}

impl<T: Clone> TicketRegistry<T> {
    fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "ticket registry capacity must be positive");
        Self {
            entries: HashMap::new(),
            capacity,
        }
    }

    fn issue(&mut self, target: T) -> String {
        self.issue_at(target, Instant::now())
    }

    fn issue_at(&mut self, target: T, now: Instant) -> String {
        self.prune_at(now);
        while self.entries.len() >= self.capacity {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, record)| record.last_used_at.unwrap_or(record.created_at))
                .map(|(ticket, _)| ticket.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }

        loop {
            let ticket = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            if self.entries.contains_key(&ticket) {
                continue;
            }
            self.entries.insert(
                ticket.clone(),
                TicketRecord {
                    target: target.clone(),
                    created_at: now,
                    last_used_at: None,
                },
            );
            return ticket;
        }
    }

    fn resolve(&mut self, ticket: &str) -> Option<T> {
        self.resolve_at(ticket, Instant::now())
    }

    fn resolve_at(&mut self, ticket: &str, now: Instant) -> Option<T> {
        if !valid_ticket(ticket) {
            return None;
        }
        if self
            .entries
            .get(ticket)
            .is_some_and(|record| record.is_expired(now))
        {
            self.entries.remove(ticket);
            return None;
        }
        let record = self.entries.get_mut(ticket)?;
        record.last_used_at = Some(now);
        Some(record.target.clone())
    }

    fn prune_at(&mut self, now: Instant) {
        self.entries.retain(|_, record| !record.is_expired(now));
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

struct ProxyRuntime {
    app: AppHandle,
    client: Client,
    audio_tickets: Arc<Mutex<TicketRegistry<StreamTarget>>>,
    artwork_tickets: Arc<Mutex<TicketRegistry<String>>>,
    expected_host: String,
}

pub struct StreamProxy {
    port: u16,
    audio_tickets: Arc<Mutex<TicketRegistry<StreamTarget>>>,
    artwork_tickets: Arc<Mutex<TicketRegistry<String>>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl StreamProxy {
    pub fn start(app: AppHandle) -> Result<Self> {
        let listener = StdTcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .context("无法启动本机媒体代理")?;
        listener
            .set_nonblocking(true)
            .context("无法配置本机媒体代理")?;
        let port = listener.local_addr()?.port();
        let audio_tickets = Arc::new(Mutex::new(TicketRegistry::new(MAX_AUDIO_TICKETS)));
        let artwork_tickets = Arc::new(Mutex::new(TicketRegistry::new(MAX_ARTWORK_TICKETS)));
        let client = build_stream_client()?;
        let runtime = Arc::new(ProxyRuntime {
            app,
            client,
            audio_tickets: Arc::clone(&audio_tickets),
            artwork_tickets: Arc::clone(&artwork_tickets),
            expected_host: format!("127.0.0.1:{port}"),
        });
        let router = Router::new()
            .route("/stream/{ticket}", get(proxy_get).head(proxy_head))
            .route("/artwork/{ticket}", get(artwork_get).head(artwork_head))
            .with_state(runtime);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("本机媒体代理启动失败：{error}");
                    return;
                }
            };
            let server = axum::serve(listener, router).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });
            if let Err(error) = server.await {
                eprintln!("本机媒体代理已停止：{error}");
            }
        });

        Ok(Self {
            port,
            audio_tickets,
            artwork_tickets,
            shutdown: Mutex::new(Some(shutdown_tx)),
        })
    }

    fn issue(&self, target: StreamTarget) -> Result<String> {
        let quality_marker = target
            .public_bitrate_marker
            .map(|bitrate| format!("?maxAudioBitrate={bitrate}"))
            .unwrap_or_default();
        let ticket = self
            .audio_tickets
            .lock()
            .map_err(|_| anyhow!("音频代理票据状态读取失败"))?
            .issue(target);
        Ok(format!(
            "http://127.0.0.1:{}/stream/{ticket}{quality_marker}",
            self.port
        ))
    }

    pub(crate) fn issue_artwork(&self, cache_key: String) -> Result<String> {
        if !valid_ticket(&cache_key) {
            return Err(anyhow!("无效的封面缓存标识"));
        }
        let ticket = self
            .artwork_tickets
            .lock()
            .map_err(|_| anyhow!("封面代理票据状态读取失败"))?
            .issue(cache_key);
        Ok(format!("http://127.0.0.1:{}/artwork/{ticket}", self.port))
    }

    pub(crate) fn clear(&self) -> Result<()> {
        {
            self.audio_tickets
                .lock()
                .map_err(|_| anyhow!("音频代理票据状态读取失败"))?
                .clear();
        }
        self.clear_artwork()
    }

    pub(crate) fn clear_artwork(&self) -> Result<()> {
        self.artwork_tickets
            .lock()
            .map_err(|_| anyhow!("封面代理票据状态读取失败"))?
            .clear();
        Ok(())
    }
}

impl Drop for StreamProxy {
    fn drop(&mut self) {
        if let Ok(sender) = self.shutdown.get_mut() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[tauri::command]
pub fn stream_url(
    server_id: String,
    metadata_key: String,
    part_key: String,
    quality: String,
    plex: TauriState<'_, PlexState>,
    proxy: TauriState<'_, StreamProxy>,
) -> Result<String, String> {
    let mut target = StreamTarget::new(server_id, metadata_key, part_key, quality)
        .map_err(|error| error.to_string())?;
    let server = plex
        .stream_server(&target.server_id)
        .map_err(|error| error.to_string())?;
    if server.connections.is_empty() {
        return Err("服务器没有可用连接".to_string());
    }
    let effective = effective_quality(&target.quality, &server.connections[0]);
    let connection_kind = if server.connections[0].local {
        "local"
    } else if server.connections[0].relay {
        "relay"
    } else {
        "remote"
    };
    target.public_bitrate_marker = public_bitrate_marker(&effective);
    eprintln!(
        "[播放] 发行流票据：server={} 请求质量={} 实际质量={} 首选连接={} 连接数={}",
        target.server_id.chars().take(8).collect::<String>(),
        target.quality,
        effective,
        connection_kind,
        server.connections.len(),
    );
    proxy.issue(target).map_err(|error| error.to_string())
}

async fn proxy_get(
    State(runtime): State<Arc<ProxyRuntime>>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    proxy_request(runtime, ticket, Method::GET, headers, uri).await
}

async fn proxy_head(
    State(runtime): State<Arc<ProxyRuntime>>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    proxy_request(runtime, ticket, Method::HEAD, headers, uri).await
}

async fn artwork_get(
    State(runtime): State<Arc<ProxyRuntime>>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    artwork_request(runtime, ticket, Method::GET, headers, uri).await
}

async fn artwork_head(
    State(runtime): State<Arc<ProxyRuntime>>,
    Path(ticket): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    artwork_request(runtime, ticket, Method::HEAD, headers, uri).await
}

async fn proxy_request(
    runtime: Arc<ProxyRuntime>,
    ticket: String,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !valid_host(&headers, &runtime.expected_host) {
        return error_response(StatusCode::FORBIDDEN, "拒绝非本机代理请求");
    }

    let target = match runtime
        .audio_tickets
        .lock()
        .ok()
        .and_then(|mut tickets| tickets.resolve(&ticket))
    {
        Some(target) => target,
        None => return error_response(StatusCode::NOT_FOUND, "音频地址已失效"),
    };
    if !valid_proxy_query(&uri, &target) {
        return error_response(StatusCode::BAD_REQUEST, "无效的音频代理参数");
    }

    let request_range = headers
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("无")
        .to_string();
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("无")
        .to_string();
    eprintln!(
        "[播放] 代理请求 方法={} Range={} User-Agent={}",
        method, request_range, user_agent
    );

    let range = match parse_range_header(&headers) {
        Ok(range) => range,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    let if_range = match parse_if_range_header(&headers, range.is_some()) {
        Ok(if_range) => if_range,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };

    forward_to_plex(&runtime, &target, method, range, if_range).await
}

async fn artwork_request(
    runtime: Arc<ProxyRuntime>,
    ticket: String,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !valid_host(&headers, &runtime.expected_host) {
        return artwork_error_response(&method, StatusCode::FORBIDDEN, "拒绝非本机封面代理请求");
    }
    if !valid_artwork_query(&uri) {
        return artwork_error_response(&method, StatusCode::BAD_REQUEST, "封面代理不接受查询参数");
    }

    let cache_key = match runtime
        .artwork_tickets
        .lock()
        .ok()
        .and_then(|mut tickets| tickets.resolve(&ticket))
    {
        Some(cache_key) => cache_key,
        None => {
            return artwork_error_response(&method, StatusCode::NOT_FOUND, "封面地址已失效");
        }
    };
    let Some(plex) = runtime.app.try_state::<PlexState>() else {
        return artwork_error_response(
            &method,
            StatusCode::SERVICE_UNAVAILABLE,
            "播放器服务尚未就绪",
        );
    };
    let artwork = match plex.cached_artwork(&cache_key) {
        Ok(artwork) => artwork,
        Err(_) => {
            return artwork_error_response(&method, StatusCode::NOT_FOUND, "封面地址已失效");
        }
    };

    artwork_response(artwork.mime, artwork.bytes, &method)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UpstreamAttempt {
    quality: String,
    connection_kind: &'static str,
    endpoint_kind: &'static str,
    status: Option<u16>,
    content_type: Option<String>,
}

impl UpstreamAttempt {
    fn summary(&self) -> String {
        let connection_label = match self.connection_kind {
            "local" => "本地直连",
            "relay" => "Plex Relay",
            _ => "远程直连",
        };
        let endpoint_label = if self.endpoint_kind == "direct" {
            "原始直放"
        } else {
            "PMS 转码"
        };
        let status_label = self
            .status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "连接失败".to_string());
        let content_label = self
            .content_type
            .as_deref()
            .map(|value| format!("（{value}）"))
            .unwrap_or_default();
        format!(
            "{connection_label}/{}/{} HTTP {status_label}{content_label}",
            self.quality, endpoint_label
        )
    }
}

async fn forward_to_plex(
    runtime: &ProxyRuntime,
    target: &StreamTarget,
    method: Method,
    range: Option<HeaderValue>,
    if_range: Option<HeaderValue>,
) -> Response {
    let Some(plex) = runtime.app.try_state::<PlexState>() else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "播放器服务尚未就绪");
    };
    let server = match plex.stream_server(&target.server_id) {
        Ok(server) if !server.connections.is_empty() => server,
        Ok(_) => return error_response(StatusCode::BAD_GATEWAY, "Plex 服务器没有可用连接"),
        Err(_) => return error_response(StatusCode::NOT_FOUND, "Plex 服务器连接已失效"),
    };

    let mut attempts: Vec<UpstreamAttempt> = Vec::new();
    for connection in &server.connections {
        let endpoints = match build_upstream_urls(target, connection, plex.client_identifier()) {
            Ok(endpoints) => endpoints,
            Err(_) => continue,
        };
        let connection_kind = if connection.local {
            "local"
        } else if connection.relay {
            "relay"
        } else {
            "remote"
        };
        let effective_quality = effective_quality(&target.quality, connection);
        let endpoint_kind = if effective_quality == "original" {
            "direct"
        } else {
            "transcode"
        };
        for endpoint in endpoints {
            let mut request = plex
                .plex_identity_headers(runtime.client.request(method.clone(), endpoint))
                .header(ACCEPT, "audio/mpeg,audio/*;q=0.9,*/*;q=0.1")
                .header(ACCEPT_ENCODING, "identity")
                .header("X-Plex-Token", &server.token)
                .header("X-Plex-Session-Identifier", &target.session_id);
            if let Some(range) = range.as_ref() {
                request = request.header(RANGE, range.clone());
            }
            if let Some(if_range) = if_range.as_ref() {
                request = request.header(IF_RANGE, if_range.clone());
            }

            match tokio::time::timeout(STREAM_CLIENT_TIMEOUTS.response_headers, request.send())
                .await
            {
                Ok(Ok(response))
                    if response.status().is_success()
                        || response.status() == StatusCode::RANGE_NOT_SATISFIABLE =>
                {
                    if !is_supported_audio_content_type(response.headers()) {
                        let content_type = response
                            .headers()
                            .get(CONTENT_TYPE)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("(无 Content-Type)")
                            .to_string();
                        eprintln!(
                            "[播放] 上游返回非音频：质量={} 连接={} 端点={} HTTP={} Content-Type={}",
                            effective_quality,
                            connection_kind,
                            endpoint_kind,
                            response.status().as_u16(),
                            content_type,
                        );
                        attempts.push(UpstreamAttempt {
                            quality: effective_quality.clone(),
                            connection_kind,
                            endpoint_kind,
                            status: Some(response.status().as_u16()),
                            content_type: response
                                .headers()
                                .get(CONTENT_TYPE)
                                .and_then(|value| value.to_str().ok())
                                .map(str::to_owned),
                        });
                        continue;
                    }
                    let content_type = response
                        .headers()
                        .get(CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("(无 Content-Type)")
                        .to_string();
                    eprintln!(
                        "[播放] 上游可播放：质量={} 连接={} 端点={} HTTP={} Content-Type={} Range={}",
                        effective_quality,
                        connection_kind,
                        endpoint_kind,
                        response.status().as_u16(),
                        content_type,
                        range.as_ref().map(|value| value.to_str().unwrap_or("?")).unwrap_or("无"),
                    );
                    plex.promote_connection(&target.server_id, &connection.uri);
                    return downstream_response(response, &method);
                }
                Ok(Ok(response)) => {
                    let content_type = response
                        .headers()
                        .get(CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("(无 Content-Type)")
                        .to_string();
                    let status = response.status();
                    eprintln!(
                        "[播放] 上游失败：质量={} 连接={} 端点={} HTTP={} Content-Type={}",
                        effective_quality,
                        connection_kind,
                        endpoint_kind,
                        status.as_u16(),
                        content_type,
                    );
                    attempts.push(UpstreamAttempt {
                        quality: effective_quality.clone(),
                        connection_kind,
                        endpoint_kind,
                        status: Some(status.as_u16()),
                        content_type: response
                            .headers()
                            .get(CONTENT_TYPE)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    });
                    // PMS rate-limits bursty probing (typically `bytes=0-1`
                    // followed by a full-range request) with 503/429. A short
                    // backoff before the next connection/endpoint lets the
                    // server recover instead of failing the whole WebView load.
                    if status == StatusCode::SERVICE_UNAVAILABLE
                        || status == StatusCode::TOO_MANY_REQUESTS
                    {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    eprintln!(
                        "[播放] 上游连接失败：质量={} 连接={} 端点={}",
                        effective_quality, connection_kind, endpoint_kind,
                    );
                    plex.demote_connection(&target.server_id, &connection.uri);
                    attempts.push(UpstreamAttempt {
                        quality: effective_quality.clone(),
                        connection_kind,
                        endpoint_kind,
                        status: None,
                        content_type: None,
                    });
                }
            }
        }
    }

    if let Some(last) = attempts.last() {
        let summary = last.summary();
        let attempts_label = if attempts.len() == 1 {
            "1 个端点".to_string()
        } else {
            format!("{} 个端点", attempts.len())
        };
        eprintln!("[播放] 代理全部尝试失败：{attempts_label}，最后一次为 {summary}");
        error_response(
            StatusCode::BAD_GATEWAY,
            format!("Plex 音频代理失败：已尝试 {attempts_label}，最后一次为 {summary}"),
        )
    } else {
        error_response(StatusCode::BAD_GATEWAY, "无法连接 Plex 音频服务器")
    }
}

fn is_supported_audio_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .is_some_and(|mime| mime.starts_with("audio/"))
}

fn downstream_response(upstream: reqwest::Response, method: &Method) -> Response {
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let content_length = upstream_headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("无")
        .to_string();
    let content_range = upstream_headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("无")
        .to_string();
    let accept_ranges = upstream_headers
        .get(ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("无")
        .to_string();
    let transfer_encoding = upstream_headers
        .get(TRANSFER_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("无")
        .to_string();
    eprintln!(
        "[播放] 转发响应 HTTP={} Content-Type={} Content-Length={} Content-Range={} Accept-Ranges={} Transfer-Encoding={} 方法={}",
        status.as_u16(),
        upstream_headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("无"),
        content_length,
        content_range,
        accept_ranges,
        transfer_encoding,
        method,
    );
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(upstream.bytes_stream())
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    copy_stream_headers(&upstream_headers, response.headers_mut());
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn artwork_response(mime: String, bytes: Vec<u8>, method: &Method) -> Response {
    let content_type = match HeaderValue::from_str(&mime) {
        Ok(content_type) => content_type,
        Err(_) => {
            return artwork_error_response(
                method,
                StatusCode::INTERNAL_SERVER_ERROR,
                "封面缓存类型无效",
            );
        }
    };
    let content_length = bytes.len() as u64;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    response
        .headers_mut()
        .insert(CONTENT_LENGTH, HeaderValue::from(content_length));
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn artwork_error_response(
    method: &Method,
    status: StatusCode,
    message: impl Into<String>,
) -> Response {
    let mut response = error_response(status, message);
    if method == Method::HEAD {
        *response.body_mut() = Body::empty();
    }
    response
}

fn copy_stream_headers(upstream: &HeaderMap, downstream: &mut HeaderMap) {
    for header in [
        CONTENT_TYPE,
        CONTENT_LENGTH,
        CONTENT_RANGE,
        ACCEPT_RANGES,
        ETAG,
        LAST_MODIFIED,
    ] {
        if let Some(value) = upstream.get(&header) {
            downstream.insert(header, value.clone());
        }
    }
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    let mut response = Response::new(Body::from(message.into()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn build_stream_client() -> Result<Client> {
    let mut builder = Client::builder()
        .connect_timeout(STREAM_CLIENT_TIMEOUTS.connect)
        .redirect(Policy::none())
        // 远程 PMS 经反向代理时，复用 keep-alive 连接的大文件流会被截断
        // （IncompleteBody）；每次请求新开连接与 curl 行为一致，最稳。
        .pool_max_idle_per_host(0)
        .user_agent(format!("Cadilume/{}", env!("CARGO_PKG_VERSION")));
    if let Some(timeout) = STREAM_CLIENT_TIMEOUTS.total {
        builder = builder.timeout(timeout);
    }
    if let Some(timeout) = STREAM_CLIENT_TIMEOUTS.read {
        builder = builder.read_timeout(timeout);
    }
    builder.build().map_err(Into::into)
}

fn build_upstream_urls(
    target: &StreamTarget,
    connection: &StreamConnectionSnapshot,
    client_identifier: &str,
) -> Result<Vec<Url>> {
    let base = validated_connection_base(&connection.uri)?;
    let effective_quality = effective_quality(&target.quality, connection);
    let mut candidates = Vec::new();
    // 自动源/原始质量：每条连接先试原始直连（Plex 的 directPlay），失败后再
    // 在同一连接上降级转码。避免“本地直连不通、远程只试转码”导致整体失败。
    if target.quality == "auto" || target.quality == "original" {
        let endpoint = base.join(&target.part_key)?;
        if !same_origin(&base, &endpoint) || !endpoint.path().starts_with("/library/parts/") {
            return Err(anyhow!("音频路径越过了 Plex 服务器边界"));
        }
        candidates.push(endpoint);
    }

    if effective_quality != "original" {
        let bitrate = effective_quality
            .parse::<u16>()
            .map_err(|_| anyhow!("无效的转码码率"))?
            .clamp(64, 320)
            .to_string();
        for path in [
            // Plex Web's own music transcoder uses `/music/:/transcode/universal/start`
            // for `protocol=http` (no extension is appended for http). Keep it first
            // and retain the explicit `.mp3` form as a compatibility fallback.
            "/music/:/transcode/universal/start",
            "/music/:/transcode/universal/start.mp3",
        ] {
            let mut endpoint = base.join(path)?;
            if !same_origin(&base, &endpoint) {
                return Err(anyhow!("转码路径越过了 Plex 服务器边界"));
            }
            endpoint
                .query_pairs_mut()
                .append_pair("hasMDE", "1")
                .append_pair("path", &target.metadata_key)
                .append_pair("mediaIndex", "0")
                .append_pair("partIndex", "0")
                .append_pair("protocol", "http")
                .append_pair("fastSeek", "1")
                .append_pair("directPlay", "0")
                .append_pair("directStream", "0")
                .append_pair("directStreamAudio", "1")
                .append_pair("container", "mp3")
                .append_pair("audioCodec", "mp3")
                .append_pair("audioChannels", "2")
                .append_pair("location", if connection.local { "lan" } else { "wan" })
                .append_pair("musicBitrate", &bitrate)
                .append_pair("maxAudioBitrate", &bitrate)
                .append_pair("session", &target.session_id)
                .append_pair("offset", "0")
                .append_pair("copyts", "1")
                .append_pair("X-Plex-Session-Identifier", &target.session_id)
                .append_pair("X-Plex-Chunked", "1")
                .append_pair("X-Plex-Client-Identifier", client_identifier)
                .append_pair("X-Plex-Client-Profile-Extra", TRANSCODE_PROFILE);
            candidates.push(endpoint);
        }
    }
    if candidates.is_empty() {
        return Err(anyhow!("没有可用的上游端点"));
    }
    Ok(candidates)
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

fn sanitize_internal_path(raw: &str, required_prefix: &str) -> Result<String> {
    if raw.len() > 4096
        || !raw.starts_with(required_prefix)
        || raw.contains(['\\', '#', '\0', '\r', '\n'])
    {
        return Err(anyhow!("无效的 Plex 内部音频路径"));
    }
    let lowercase = raw.to_ascii_lowercase();
    if lowercase.contains("%2e") || lowercase.contains("%2f") || lowercase.contains("%5c") {
        return Err(anyhow!("Plex 音频路径包含不安全的转义"));
    }

    let sentinel = Url::parse("http://cadilume.invalid/")?;
    let mut joined = sentinel.join(raw)?;
    if !same_origin(&sentinel, &joined) || !joined.path().starts_with(required_prefix) {
        return Err(anyhow!("Plex 音频路径越过了允许边界"));
    }
    let retained_query = joined
        .query_pairs()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("X-Plex-Token"))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    joined.set_query(None);
    if !retained_query.is_empty() {
        let mut query = joined.query_pairs_mut();
        for (name, value) in retained_query {
            query.append_pair(&name, &value);
        }
    }
    let mut sanitized = joined.path().to_string();
    if let Some(query) = joined.query() {
        sanitized.push('?');
        sanitized.push_str(query);
    }
    Ok(sanitized)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn effective_quality(quality: &str, connection: &StreamConnectionSnapshot) -> String {
    match quality {
        "auto" if connection.local => "original".to_string(),
        "auto" if connection.relay => "192".to_string(),
        "auto" => "320".to_string(),
        quality => quality.to_string(),
    }
}

fn public_bitrate_marker(quality: &str) -> Option<u16> {
    match quality {
        "320" => Some(320),
        "256" => Some(256),
        "192" => Some(192),
        _ => None,
    }
}

fn valid_ticket(ticket: &str) -> bool {
    ticket.len() == 64
        && ticket
            .bytes()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn valid_host(headers: &HeaderMap, expected_host: &str) -> bool {
    let mut hosts = headers.get_all(HOST).iter();
    hosts
        .next()
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == expected_host)
        && hosts.next().is_none()
}

fn valid_proxy_query(uri: &Uri, target: &StreamTarget) -> bool {
    match uri.query() {
        None => true,
        Some("maxAudioBitrate=320") => target.public_bitrate_marker == Some(320),
        Some("maxAudioBitrate=256") => target.public_bitrate_marker == Some(256),
        Some("maxAudioBitrate=192") => target.public_bitrate_marker == Some(192),
        Some(_) => false,
    }
}

fn valid_artwork_query(uri: &Uri) -> bool {
    uri.query().is_none()
}

fn parse_range_header(
    headers: &HeaderMap,
) -> std::result::Result<Option<HeaderValue>, &'static str> {
    let Some(value) = headers.get(RANGE) else {
        return Ok(None);
    };
    let raw = value.to_str().map_err(|_| "无效的 Range 请求头")?;
    let Some(specification) = raw.strip_prefix("bytes=") else {
        return Err("只支持 bytes Range 请求");
    };
    if specification.is_empty()
        || specification.contains(',')
        || specification.chars().any(char::is_whitespace)
    {
        return Err("只支持单段 Range 请求");
    }
    let Some((start, end)) = specification.split_once('-') else {
        return Err("无效的 Range 范围");
    };
    if start.is_empty() && end.is_empty() {
        return Err("无效的 Range 范围");
    }
    if !start.is_empty() && start.parse::<u64>().is_err() {
        return Err("无效的 Range 起点");
    }
    if !end.is_empty() && end.parse::<u64>().is_err() {
        return Err("无效的 Range 终点");
    }
    if let (Ok(start), Ok(end)) = (start.parse::<u64>(), end.parse::<u64>()) {
        if end < start {
            return Err("Range 终点不能小于起点");
        }
    }
    Ok(Some(value.clone()))
}

fn parse_if_range_header(
    headers: &HeaderMap,
    has_range: bool,
) -> std::result::Result<Option<HeaderValue>, &'static str> {
    if !has_range {
        return Ok(None);
    }
    let Some(value) = headers.get(IF_RANGE) else {
        return Ok(None);
    };
    let raw = value.to_str().map_err(|_| "无效的 If-Range 请求头")?;
    if raw.is_empty() || raw.len() > 1024 {
        return Err("无效的 If-Range 请求头");
    }
    Ok(Some(value.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(quality: &str) -> StreamTarget {
        StreamTarget::new(
            "server-1".to_string(),
            "/library/metadata/42".to_string(),
            "/library/parts/7/song.flac".to_string(),
            quality.to_string(),
        )
        .expect("target should be valid")
    }

    fn connection(uri: &str, local: bool, relay: bool) -> StreamConnectionSnapshot {
        StreamConnectionSnapshot {
            uri: uri.to_string(),
            local,
            relay,
        }
    }

    fn test_proxy() -> StreamProxy {
        StreamProxy {
            port: 49_152,
            audio_tickets: Arc::new(Mutex::new(TicketRegistry::new(MAX_AUDIO_TICKETS))),
            artwork_tickets: Arc::new(Mutex::new(TicketRegistry::new(MAX_ARTWORK_TICKETS))),
            shutdown: Mutex::new(None),
        }
    }

    fn url_ticket(url: &str, prefix: &str) -> String {
        Url::parse(url)
            .expect("proxy URL should be valid")
            .path()
            .strip_prefix(prefix)
            .expect("proxy URL should use the expected path")
            .to_string()
    }

    #[test]
    fn tickets_are_unpredictable_and_expire() {
        let now = Instant::now();
        let mut registry = TicketRegistry::new(MAX_AUDIO_TICKETS);
        let ticket = registry.issue_at(target("original"), now);
        assert!(valid_ticket(&ticket));
        assert_eq!(ticket.len(), 64);
        assert!(registry
            .resolve_at(&ticket, now + UNUSED_TICKET_TTL)
            .is_some());
        assert!(registry
            .resolve_at(&ticket, now + UNUSED_TICKET_TTL + ACTIVE_TICKET_IDLE_TTL)
            .is_some());
        assert!(registry
            .resolve_at(
                &ticket,
                now + UNUSED_TICKET_TTL + ACTIVE_TICKET_IDLE_TTL + Duration::from_secs(1)
            )
            .is_some());

        let unused = registry.issue_at(target("original"), now);
        assert!(registry
            .resolve_at(&unused, now + UNUSED_TICKET_TTL + Duration::from_secs(1))
            .is_none());
        assert!(registry.resolve_at("not-a-ticket", now).is_none());
    }

    #[test]
    fn active_ticket_has_idle_and_absolute_expiry() {
        let now = Instant::now();
        let mut registry = TicketRegistry::new(MAX_AUDIO_TICKETS);
        let idle = registry.issue_at(target("original"), now);
        assert!(registry.resolve_at(&idle, now).is_some());
        assert!(registry
            .resolve_at(&idle, now + ACTIVE_TICKET_IDLE_TTL + Duration::from_secs(1))
            .is_none());

        let absolute = registry.issue_at(target("original"), now);
        assert!(registry.resolve_at(&absolute, now).is_some());
        assert!(registry
            .resolve_at(
                &absolute,
                now + MAX_TICKET_LIFETIME + Duration::from_secs(1)
            )
            .is_none());
    }

    #[test]
    fn clearing_registry_revokes_all_tickets() {
        let now = Instant::now();
        let mut registry = TicketRegistry::new(MAX_AUDIO_TICKETS);
        let first = registry.issue_at(target("original"), now);
        let second = registry.issue_at(target("320"), now);
        registry.clear();
        assert!(registry.resolve_at(&first, now).is_none());
        assert!(registry.resolve_at(&second, now).is_none());
        assert!(registry.entries.is_empty());
    }

    #[test]
    fn auto_quality_tries_direct_before_transcode() {
        let auto = target("auto");
        let local = connection("http://192.168.1.5:32400", true, false);
        let urls = build_upstream_urls(&auto, &local, "client-1").unwrap();
        assert!(
            urls.first().unwrap().path().starts_with("/library/parts/"),
            "自动源本地连接应先试原始直连"
        );

        let remote = connection("http://media.example.com:10324", false, false);
        let urls = build_upstream_urls(&auto, &remote, "client-1").unwrap();
        assert!(
            urls.first().unwrap().path().starts_with("/library/parts/"),
            "自动源远程连接也先试原始直连"
        );
        assert!(
            urls.iter().any(|url| url.path().contains("transcode")),
            "直连之后应保留转码兜底"
        );

        let explicit = target("320");
        let urls = build_upstream_urls(&explicit, &remote, "client-1").unwrap();
        assert!(
            urls.iter().all(|url| url.path().contains("transcode")),
            "显式码率只走转码"
        );
    }

    #[test]
    fn issued_url_only_exposes_loopback_ticket_and_public_quality_marker() {
        let proxy = test_proxy();
        let url = proxy.issue(target("320")).unwrap();
        assert!(url.starts_with("http://127.0.0.1:49152/stream/"));
        assert!(url.ends_with("?maxAudioBitrate=320"));
        assert!(!url.contains("server-1"));
        assert!(!url.contains("library"));
        assert!(!url.to_ascii_lowercase().contains("token="));
        let parsed = Url::parse(&url).unwrap();
        let ticket = parsed.path().trim_start_matches("/stream/");
        assert!(valid_ticket(ticket));

        assert!(proxy
            .issue(target("256"))
            .unwrap()
            .ends_with("?maxAudioBitrate=256"));
        assert!(proxy
            .issue(target("192"))
            .unwrap()
            .ends_with("?maxAudioBitrate=192"));
        assert!(!proxy.issue(target("original")).unwrap().contains('?'));
    }

    #[test]
    fn issued_artwork_url_only_exposes_loopback_ticket() {
        let proxy = test_proxy();
        assert!(proxy.issue_artwork("too-short".to_string()).is_err());
        assert!(proxy.issue_artwork("A".repeat(64)).is_err());
        let cache_key = "a".repeat(64);
        let url = proxy.issue_artwork(cache_key.clone()).unwrap();
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.scheme(), "http");
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert_eq!(parsed.port(), Some(49_152));
        assert!(parsed.query().is_none());
        assert!(!url.contains(&cache_key));

        let ticket = url_ticket(&url, "/artwork/");
        assert!(valid_ticket(&ticket));
        assert_eq!(
            proxy
                .artwork_tickets
                .lock()
                .unwrap()
                .resolve(&ticket)
                .as_deref(),
            Some(cache_key.as_str())
        );
    }

    #[test]
    fn audio_and_artwork_capacities_are_independent() {
        let proxy = test_proxy();
        let audio_ticket = url_ticket(&proxy.issue(target("original")).unwrap(), "/stream/");
        for index in 0..=MAX_ARTWORK_TICKETS {
            proxy.issue_artwork(format!("{index:064x}")).unwrap();
        }
        assert!(proxy
            .audio_tickets
            .lock()
            .unwrap()
            .entries
            .contains_key(&audio_ticket));
        assert_eq!(
            proxy.artwork_tickets.lock().unwrap().entries.len(),
            MAX_ARTWORK_TICKETS
        );

        let artwork_ticket = url_ticket(&proxy.issue_artwork("f".repeat(64)).unwrap(), "/artwork/");
        for _ in 0..=MAX_AUDIO_TICKETS {
            proxy.issue(target("original")).unwrap();
        }
        assert!(proxy
            .artwork_tickets
            .lock()
            .unwrap()
            .entries
            .contains_key(&artwork_ticket));
        assert_eq!(
            proxy.audio_tickets.lock().unwrap().entries.len(),
            MAX_AUDIO_TICKETS
        );
    }

    #[test]
    fn clear_artwork_leaves_audio_tickets_and_clear_revokes_both() {
        let proxy = test_proxy();
        let audio_ticket = url_ticket(&proxy.issue(target("original")).unwrap(), "/stream/");
        proxy.issue_artwork("b".repeat(64)).unwrap();

        proxy.clear_artwork().unwrap();
        assert!(proxy.artwork_tickets.lock().unwrap().entries.is_empty());
        assert!(proxy
            .audio_tickets
            .lock()
            .unwrap()
            .entries
            .contains_key(&audio_ticket));

        proxy.issue_artwork("c".repeat(64)).unwrap();
        proxy.clear().unwrap();
        assert!(proxy.audio_tickets.lock().unwrap().entries.is_empty());
        assert!(proxy.artwork_tickets.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn registry_evicts_oldest_ticket_at_capacity() {
        let now = Instant::now();
        let mut registry = TicketRegistry::new(MAX_AUDIO_TICKETS);
        let oldest = registry.issue_at(target("original"), now);
        for offset in 1..=MAX_AUDIO_TICKETS {
            registry.issue_at(
                target("original"),
                now + Duration::from_millis(offset as u64),
            );
        }
        assert_eq!(registry.entries.len(), MAX_AUDIO_TICKETS);
        assert!(!registry.entries.contains_key(&oldest));
    }

    #[test]
    fn only_single_byte_ranges_are_forwarded() {
        for valid in ["bytes=0-", "bytes=10-99", "bytes=-512"] {
            let mut headers = HeaderMap::new();
            headers.insert(RANGE, HeaderValue::from_str(valid).unwrap());
            assert_eq!(
                parse_range_header(&headers)
                    .expect("range should be valid")
                    .unwrap(),
                valid
            );
        }
        for invalid in [
            "items=0-1",
            "bytes=",
            "bytes=-",
            "bytes=9-4",
            "bytes=0-1,4-5",
            "bytes=0 - 1",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(RANGE, HeaderValue::from_str(invalid).unwrap());
            assert!(parse_range_header(&headers).is_err(), "{invalid}");
        }
    }

    #[test]
    fn if_range_is_only_forwarded_with_a_valid_range() {
        let mut headers = HeaderMap::new();
        headers.insert(IF_RANGE, HeaderValue::from_static("\"track-v1\""));
        assert!(parse_if_range_header(&headers, false).unwrap().is_none());
        assert_eq!(
            parse_if_range_header(&headers, true).unwrap().unwrap(),
            "\"track-v1\""
        );

        headers.insert(IF_RANGE, HeaderValue::from_static(""));
        assert!(parse_if_range_header(&headers, true).is_err());
    }

    #[test]
    fn upstream_urls_stay_on_discovered_server_and_never_include_token() {
        let direct = target("original");
        let urls = build_upstream_urls(
            &direct,
            &connection("https://music.example.test:32400", true, false),
            "client-id",
        )
        .unwrap();
        assert_eq!(
            urls[0].as_str(),
            "https://music.example.test:32400/library/parts/7/song.flac"
        );
        assert!(!urls[0].as_str().contains("X-Plex-Token"));

        let transcoded = target("320");
        let urls = build_upstream_urls(
            &transcoded,
            &connection("https://music.example.test:32400", false, false),
            "client-id",
        )
        .unwrap();
        assert_eq!(urls.len(), 2);
        assert!(urls[0].path().ends_with("/universal/start"));
        assert!(urls[1].path().ends_with("/universal/start.mp3"));
        let query = urls[0].query().unwrap();
        assert!(query.contains("musicBitrate=320"));
        assert!(query.contains("directStreamAudio=1"));
        assert!(query.contains("fastSeek=1"));
        assert!(query.contains("container=mp3"));
        assert!(query.contains("audioCodec=mp3"));
        assert!(query.contains("audioChannels=2"));
        assert!(query.contains("X-Plex-Chunked=1"));
        assert!(!query.contains("X-Plex-Token"));
        assert_eq!(
            urls[0]
                .query_pairs()
                .find(|(name, _)| name == "X-Plex-Client-Profile-Extra")
                .map(|(_, value)| value.into_owned())
                .as_deref(),
            Some(TRANSCODE_PROFILE)
        );
        assert!(!TRANSCODE_PROFILE.contains("replace=true"));
    }

    #[test]
    fn only_audio_content_types_are_forwarded_to_the_webview() {
        let mut headers = HeaderMap::new();
        assert!(!is_supported_audio_content_type(&headers));

        for mime in [
            "audio/mpeg",
            "audio/mp4",
            "audio/flac",
            "audio/ogg; codecs=opus",
            "AUDIO/MPEG",
        ] {
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
            assert!(
                is_supported_audio_content_type(&headers),
                "expected {mime} to be accepted"
            );
        }

        for mime in [
            "text/html; charset=utf-8",
            "application/xml",
            "application/json",
            "application/octet-stream",
            "image/png",
        ] {
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
            assert!(
                !is_supported_audio_content_type(&headers),
                "expected {mime} to be rejected"
            );
        }
    }

    #[test]
    fn upstream_attempt_summaries_never_expose_server_identifiers() {
        let attempt = UpstreamAttempt {
            quality: "320".to_string(),
            connection_kind: "remote",
            endpoint_kind: "transcode",
            status: Some(200),
            content_type: Some("text/html".to_string()),
        };
        let summary = attempt.summary();
        assert!(summary.contains("远程直连/320/PMS 转码 HTTP 200（text/html）"));
        assert!(!summary.contains("http"));
        assert!(!summary.contains("token"));
        assert!(!summary.contains("library"));
        assert!(!summary.contains("127.0.0.1"));

        let transport = UpstreamAttempt {
            quality: "original".to_string(),
            connection_kind: "local",
            endpoint_kind: "direct",
            status: None,
            content_type: None,
        };
        assert_eq!(
            transport.summary(),
            "本地直连/original/原始直放 HTTP 连接失败"
        );
    }

    #[test]
    fn auto_quality_matches_connection_kind() {
        assert_eq!(
            effective_quality("auto", &connection("https://local.test", true, false)),
            "original"
        );
        assert_eq!(
            effective_quality("auto", &connection("https://remote.test", false, false)),
            "320"
        );
        assert_eq!(
            effective_quality("auto", &connection("https://relay.test", false, true)),
            "192"
        );
        assert_eq!(
            public_bitrate_marker(&effective_quality(
                "auto",
                &connection("https://remote.test", false, false)
            )),
            Some(320)
        );
        assert_eq!(
            public_bitrate_marker(&effective_quality(
                "auto",
                &connection("https://relay.test", false, true)
            )),
            Some(192)
        );
        assert_eq!(
            public_bitrate_marker(&effective_quality(
                "auto",
                &connection("https://local.test", true, false)
            )),
            None
        );
    }

    #[test]
    fn internal_paths_and_connection_origins_block_ssrf_shapes() {
        for path in [
            "https://evil.test/library/parts/7",
            "/library/parts/../metadata/1",
            "/library/parts/%2e%2e/:/prefs",
            "/library/parts/7\\evil",
        ] {
            assert!(sanitize_internal_path(path, "/library/parts/").is_err());
        }
        for uri in [
            "file:///tmp/audio",
            "https://user:password@example.test",
            "https://example.test?next=https://evil.test",
        ] {
            assert!(validated_connection_base(uri).is_err());
        }
        let sanitized = sanitize_internal_path(
            "/library/parts/7/song.flac?X-Plex-Token=secret&download=1",
            "/library/parts/",
        )
        .unwrap();
        assert_eq!(sanitized, "/library/parts/7/song.flac?download=1");
    }

    #[test]
    fn response_only_forwards_media_range_headers() {
        let mut upstream = HeaderMap::new();
        upstream.insert(CONTENT_TYPE, HeaderValue::from_static("audio/flac"));
        upstream.insert(CONTENT_LENGTH, HeaderValue::from_static("512"));
        upstream.insert(CONTENT_RANGE, HeaderValue::from_static("bytes 0-511/1024"));
        upstream.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        upstream.insert(ETAG, HeaderValue::from_static("\"track-v1\""));
        upstream.insert(
            LAST_MODIFIED,
            HeaderValue::from_static("Tue, 28 Jul 2026 09:00:00 GMT"),
        );
        upstream.insert("x-plex-token", HeaderValue::from_static("secret"));
        let mut downstream = HeaderMap::new();
        copy_stream_headers(&upstream, &mut downstream);
        assert_eq!(downstream.get(CONTENT_TYPE).unwrap(), "audio/flac");
        assert_eq!(downstream.get(CONTENT_LENGTH).unwrap(), "512");
        assert_eq!(downstream.get(CONTENT_RANGE).unwrap(), "bytes 0-511/1024");
        assert_eq!(downstream.get(ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(downstream.get(ETAG).unwrap(), "\"track-v1\"");
        assert_eq!(
            downstream.get(LAST_MODIFIED).unwrap(),
            "Tue, 28 Jul 2026 09:00:00 GMT"
        );
        assert!(downstream.get("x-plex-token").is_none());
    }

    #[test]
    fn streaming_client_has_no_body_lifetime_timeout() {
        assert_eq!(STREAM_CLIENT_TIMEOUTS.connect, Duration::from_secs(5));
        assert_eq!(
            STREAM_CLIENT_TIMEOUTS.response_headers,
            Duration::from_secs(15)
        );
        assert_eq!(STREAM_CLIENT_TIMEOUTS.total, None);
        assert_eq!(STREAM_CLIENT_TIMEOUTS.read, None);
        build_stream_client().expect("streaming client should build");
    }

    #[test]
    fn artwork_responses_set_safe_headers_and_head_has_no_body() {
        use axum::body::HttpBody as _;

        let get = artwork_response(
            "image/png".to_string(),
            vec![0x89, b'P', b'N', b'G'],
            &Method::GET,
        );
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(get.headers().get(CONTENT_TYPE).unwrap(), "image/png");
        assert_eq!(get.headers().get(CONTENT_LENGTH).unwrap(), "4");
        assert_eq!(
            get.headers().get(CACHE_CONTROL).unwrap(),
            "private, no-store, max-age=0"
        );
        assert_eq!(
            get.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(get.body().size_hint().exact(), Some(4));

        let head = artwork_response(
            "image/jpeg".to_string(),
            vec![0xff, 0xd8, 0xff],
            &Method::HEAD,
        );
        assert_eq!(head.headers().get(CONTENT_TYPE).unwrap(), "image/jpeg");
        assert_eq!(head.headers().get(CONTENT_LENGTH).unwrap(), "3");
        assert_eq!(head.body().size_hint().exact(), Some(0));

        let head_error =
            artwork_error_response(&Method::HEAD, StatusCode::NOT_FOUND, "封面地址已失效");
        assert_eq!(head_error.status(), StatusCode::NOT_FOUND);
        assert_eq!(head_error.body().size_hint().exact(), Some(0));
    }

    #[test]
    fn host_and_public_quality_marker_are_strict() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:49152"));
        assert!(valid_host(&headers, "127.0.0.1:49152"));
        assert!(!valid_host(&headers, "localhost:49152"));
        headers.append(HOST, HeaderValue::from_static("localhost:49152"));
        assert!(!valid_host(&headers, "127.0.0.1:49152"));
        assert!(!valid_host(&HeaderMap::new(), "127.0.0.1:49152"));

        let original = target("original");
        let fallback = target("320");
        assert!(valid_proxy_query(&"/stream/x".parse().unwrap(), &original));
        assert!(!valid_proxy_query(
            &"/stream/x?next=https://evil.test".parse().unwrap(),
            &original
        ));
        assert!(valid_proxy_query(
            &"/stream/x?maxAudioBitrate=320".parse().unwrap(),
            &fallback
        ));
        let fallback_256 = target("256");
        assert!(valid_proxy_query(
            &"/stream/x?maxAudioBitrate=256".parse().unwrap(),
            &fallback_256
        ));
        assert!(!valid_proxy_query(
            &"/stream/x?maxAudioBitrate=192".parse().unwrap(),
            &fallback_256
        ));
        let fallback_192 = target("192");
        assert!(valid_proxy_query(
            &"/stream/x?maxAudioBitrate=192".parse().unwrap(),
            &fallback_192
        ));
        assert!(valid_artwork_query(&"/artwork/x".parse().unwrap()));
        assert!(!valid_artwork_query(&"/artwork/x?".parse().unwrap()));
        assert!(!valid_artwork_query(
            &"/artwork/x?next=https://evil.test".parse().unwrap()
        ));
    }
}

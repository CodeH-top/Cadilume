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
            CONTENT_TYPE, ETAG, HOST, IF_RANGE, LAST_MODIFIED, RANGE,
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
const MAX_TICKETS: usize = 128;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(15);
const TRANSCODE_PROFILE: &str = "add-transcode-target(replace=true&type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3)";

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

        let public_bitrate_marker = (quality == "320").then_some(320);
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
struct TicketRecord {
    target: StreamTarget,
    created_at: Instant,
    last_used_at: Option<Instant>,
}

impl TicketRecord {
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

#[derive(Default)]
struct TicketRegistry {
    entries: HashMap<String, TicketRecord>,
}

impl TicketRegistry {
    fn issue(&mut self, target: StreamTarget) -> String {
        self.issue_at(target, Instant::now())
    }

    fn issue_at(&mut self, target: StreamTarget, now: Instant) -> String {
        self.prune_at(now);
        while self.entries.len() >= MAX_TICKETS {
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

    fn resolve(&mut self, ticket: &str) -> Option<StreamTarget> {
        self.resolve_at(ticket, Instant::now())
    }

    fn resolve_at(&mut self, ticket: &str, now: Instant) -> Option<StreamTarget> {
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
    tickets: Arc<Mutex<TicketRegistry>>,
    expected_host: String,
}

pub struct StreamProxy {
    port: u16,
    tickets: Arc<Mutex<TicketRegistry>>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl StreamProxy {
    pub fn start(app: AppHandle) -> Result<Self> {
        let listener = StdTcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .context("无法启动本机音频代理")?;
        listener
            .set_nonblocking(true)
            .context("无法配置本机音频代理")?;
        let port = listener.local_addr()?.port();
        let tickets = Arc::new(Mutex::new(TicketRegistry::default()));
        let client = build_stream_client()?;
        let runtime = Arc::new(ProxyRuntime {
            app,
            client,
            tickets: Arc::clone(&tickets),
            expected_host: format!("127.0.0.1:{port}"),
        });
        let router = Router::new()
            .route("/stream/{ticket}", get(proxy_get).head(proxy_head))
            .with_state(runtime);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("本机音频代理启动失败：{error}");
                    return;
                }
            };
            let server = axum::serve(listener, router).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });
            if let Err(error) = server.await {
                eprintln!("本机音频代理已停止：{error}");
            }
        });

        Ok(Self {
            port,
            tickets,
            shutdown: Mutex::new(Some(shutdown_tx)),
        })
    }

    fn issue(&self, target: StreamTarget) -> Result<String> {
        let quality_marker = if target.public_bitrate_marker == Some(320) {
            "?maxAudioBitrate=320"
        } else {
            ""
        };
        let ticket = self
            .tickets
            .lock()
            .map_err(|_| anyhow!("音频代理票据状态读取失败"))?
            .issue(target);
        Ok(format!(
            "http://127.0.0.1:{}/stream/{ticket}{quality_marker}",
            self.port
        ))
    }

    pub(crate) fn clear(&self) -> Result<()> {
        self.tickets
            .lock()
            .map_err(|_| anyhow!("音频代理票据状态读取失败"))?
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
    target.public_bitrate_marker =
        (effective_quality(&target.quality, &server.connections[0]) == "320").then_some(320);
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
        .tickets
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

    let mut last_status = None;
    for connection in &server.connections {
        let endpoints = match build_upstream_urls(target, connection, plex.client_identifier()) {
            Ok(endpoints) => endpoints,
            Err(_) => continue,
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
                    plex.promote_connection(&target.server_id, &connection.uri);
                    return downstream_response(response, &method);
                }
                Ok(Ok(response)) => last_status = Some(response.status()),
                Ok(Err(_)) | Err(_) => {}
            }
        }
    }

    match last_status {
        Some(status) => error_response(
            StatusCode::BAD_GATEWAY,
            format!("Plex 音频接口返回 HTTP {status}"),
        ),
        None => error_response(StatusCode::BAD_GATEWAY, "无法连接 Plex 音频服务器"),
    }
}

fn downstream_response(upstream: reqwest::Response, method: &Method) -> Response {
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
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
    response
}

fn build_stream_client() -> Result<Client> {
    let mut builder = Client::builder()
        .connect_timeout(STREAM_CLIENT_TIMEOUTS.connect)
        .redirect(Policy::none())
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
    if effective_quality == "original" {
        let endpoint = base.join(&target.part_key)?;
        if !same_origin(&base, &endpoint) || !endpoint.path().starts_with("/library/parts/") {
            return Err(anyhow!("音频路径越过了 Plex 服务器边界"));
        }
        return Ok(vec![endpoint]);
    }

    let bitrate = effective_quality
        .parse::<u16>()
        .map_err(|_| anyhow!("无效的转码码率"))?
        .clamp(64, 320)
        .to_string();
    [
        "/music/:/transcode/universal/start",
        "/music/:/transcode/universal/start.mp3",
    ]
    .into_iter()
    .map(|path| {
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
            .append_pair("directPlay", "0")
            .append_pair("directStream", "0")
            .append_pair("directStreamAudio", "1")
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
        Ok(endpoint)
    })
    .collect()
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

fn valid_ticket(ticket: &str) -> bool {
    ticket.len() == 64
        && ticket
            .bytes()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn valid_host(headers: &HeaderMap, expected_host: &str) -> bool {
    headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == expected_host)
}

fn valid_proxy_query(uri: &Uri, target: &StreamTarget) -> bool {
    match uri.query() {
        None => true,
        Some("maxAudioBitrate=320") => target.public_bitrate_marker == Some(320),
        Some(_) => false,
    }
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

    #[test]
    fn tickets_are_unpredictable_and_expire() {
        let now = Instant::now();
        let mut registry = TicketRegistry::default();
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
        let mut registry = TicketRegistry::default();
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
        let mut registry = TicketRegistry::default();
        let first = registry.issue_at(target("original"), now);
        let second = registry.issue_at(target("320"), now);
        registry.clear();
        assert!(registry.resolve_at(&first, now).is_none());
        assert!(registry.resolve_at(&second, now).is_none());
        assert!(registry.entries.is_empty());
    }

    #[test]
    fn issued_url_only_exposes_loopback_ticket_and_public_quality_marker() {
        let proxy = StreamProxy {
            port: 49_152,
            tickets: Arc::new(Mutex::new(TicketRegistry::default())),
            shutdown: Mutex::new(None),
        };
        let url = proxy.issue(target("320")).unwrap();
        assert!(url.starts_with("http://127.0.0.1:49152/stream/"));
        assert!(url.ends_with("?maxAudioBitrate=320"));
        assert!(!url.contains("server-1"));
        assert!(!url.contains("library"));
        assert!(!url.to_ascii_lowercase().contains("token="));
        let parsed = Url::parse(&url).unwrap();
        let ticket = parsed.path().trim_start_matches("/stream/");
        assert!(valid_ticket(ticket));
    }

    #[test]
    fn registry_evicts_oldest_ticket_at_capacity() {
        let now = Instant::now();
        let mut registry = TicketRegistry::default();
        let oldest = registry.issue_at(target("original"), now);
        for offset in 1..=MAX_TICKETS {
            registry.issue_at(
                target("original"),
                now + Duration::from_millis(offset as u64),
            );
        }
        assert_eq!(registry.entries.len(), MAX_TICKETS);
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
    fn host_and_public_quality_marker_are_strict() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:49152"));
        assert!(valid_host(&headers, "127.0.0.1:49152"));
        assert!(!valid_host(&headers, "localhost:49152"));

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
    }
}

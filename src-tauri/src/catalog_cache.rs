//! Native persistent cache for the bounded startup catalog snapshot.
//!
//! The cache contains catalog metadata only. Credentials, server access
//! tokens, stream tickets, and playback sources never enter this database.
//! SQLite is opened lazily on a blocking worker so WebView startup does not
//! inherit filesystem or database latency.

use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::State;

use crate::plex::PlexState;

const CACHE_VERSION: i64 = 1;
const CACHE_KEY: &str = "initial-library";
const CREDENTIAL_KEY: &str = "plex-account-token";
const MAX_CACHE_AGE_MS: u128 = 30 * 24 * 60 * 60 * 1_000;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;

fn now_millis() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .map_err(|error| format!("读取本地缓存时间失败: {error}"))
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建本地资料缓存目录失败: {error}"))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("打开本地资料缓存失败: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("设置本地资料缓存锁超时失败: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS cache_entries (
                 cache_key TEXT PRIMARY KEY NOT NULL,
                 version INTEGER NOT NULL,
                 cached_at INTEGER NOT NULL,
                 payload BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS secure_credentials (
                 credential_key TEXT PRIMARY KEY NOT NULL,
                 version INTEGER NOT NULL,
                 payload BLOB NOT NULL
             );",
        )
        .map_err(|error| format!("初始化本地资料缓存表失败: {error}"))?;
    Ok(connection)
}

fn has_forbidden_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase();
            normalized.contains("token")
                || normalized.contains("credential")
                || normalized.contains("password")
                || normalized.contains("secret")
                || has_forbidden_key(value)
        }),
        Value::Array(items) => items.iter().any(has_forbidden_key),
        _ => false,
    }
}

fn read_cache(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let connection = open_database(path)?;
    let row = connection
        .query_row(
            "SELECT version, cached_at, payload FROM cache_entries WHERE cache_key = ?1",
            params![CACHE_KEY],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("读取本地资料缓存失败: {error}"))?;
    let Some((version, cached_at, payload)) = row else {
        return Ok(None);
    };
    let now = now_millis()?;
    if version != CACHE_VERSION
        || cached_at <= 0
        || now.saturating_sub(cached_at) as u128 > MAX_CACHE_AGE_MS
        || payload.len() > MAX_CACHE_BYTES
    {
        return Ok(None);
    }
    let value = serde_json::from_slice::<Value>(&payload)
        .map_err(|error| format!("解析本地资料缓存失败: {error}"))?;
    if has_forbidden_key(&value) {
        return Ok(None);
    }
    Ok(Some(value))
}

fn write_cache(path: &Path, value: Value) -> Result<(), String> {
    if has_forbidden_key(&value) {
        return Err("拒绝把凭据或敏感字段写入资料缓存".to_string());
    }
    let payload =
        serde_json::to_vec(&value).map_err(|error| format!("编码本地资料缓存失败: {error}"))?;
    if payload.len() > MAX_CACHE_BYTES {
        return Err("本地资料缓存超过大小限制".to_string());
    }
    let connection = open_database(path)?;
    connection
        .execute(
            "INSERT INTO cache_entries (cache_key, version, cached_at, payload)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(cache_key) DO UPDATE SET
                 version = excluded.version,
                 cached_at = excluded.cached_at,
                 payload = excluded.payload",
            params![CACHE_KEY, CACHE_VERSION, now_millis()?, payload],
        )
        .map_err(|error| format!("写入本地资料缓存失败: {error}"))?;
    Ok(())
}

fn clear_cache(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let connection = open_database(path)?;
    connection
        .execute(
            "DELETE FROM cache_entries WHERE cache_key = ?1",
            params![CACHE_KEY],
        )
        .map_err(|error| format!("清理本地资料缓存失败: {error}"))?;
    Ok(())
}

pub(crate) fn read_credential_blob(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let connection = open_database(path)?;
    let row = connection
        .query_row(
            "SELECT version, payload FROM secure_credentials WHERE credential_key = ?1",
            params![CREDENTIAL_KEY],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取 Plex 鉴权缓存失败: {error}"))?;
    match row {
        Some((version, payload)) if version == CACHE_VERSION && payload.len() <= 16 * 1024 => {
            Ok(Some(payload))
        }
        _ => Ok(None),
    }
}

pub(crate) fn write_credential_blob(path: &Path, payload: &[u8]) -> Result<(), String> {
    if payload.is_empty() || payload.len() > 16 * 1024 {
        return Err("Plex 鉴权缓存大小无效".to_string());
    }
    let connection = open_database(path)?;
    connection
        .execute(
            "INSERT INTO secure_credentials (credential_key, version, payload)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(credential_key) DO UPDATE SET
                 version = excluded.version,
                 payload = excluded.payload",
            params![CREDENTIAL_KEY, CACHE_VERSION, payload],
        )
        .map_err(|error| format!("写入 Plex 鉴权缓存失败: {error}"))?;
    Ok(())
}

pub(crate) fn delete_credential_blob(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let connection = open_database(path)?;
    connection
        .execute(
            "DELETE FROM secure_credentials WHERE credential_key = ?1",
            params![CREDENTIAL_KEY],
        )
        .map_err(|error| format!("删除 Plex 鉴权缓存失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn read_initial_library_cache(
    state: State<'_, PlexState>,
) -> Result<Option<Value>, String> {
    let path = state.catalog_cache_path();
    tauri::async_runtime::spawn_blocking(move || read_cache(&path))
        .await
        .map_err(|error| format!("读取本地资料缓存任务失败: {error}"))?
}

#[tauri::command]
pub async fn write_initial_library_cache(
    data: Value,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let path = state.catalog_cache_path();
    tauri::async_runtime::spawn_blocking(move || write_cache(&path, data))
        .await
        .map_err(|error| format!("写入本地资料缓存任务失败: {error}"))?
}

#[tauri::command]
pub async fn clear_initial_library_cache(state: State<'_, PlexState>) -> Result<(), String> {
    let path = state.catalog_cache_path();
    tauri::async_runtime::spawn_blocking(move || clear_cache(&path))
        .await
        .map_err(|error| format!("清理本地资料缓存任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_database_path() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("cadilume-catalog-cache-{}", Uuid::new_v4()));
        (root.clone(), root.join("catalog.sqlite3"))
    }

    #[test]
    fn encrypted_credential_blob_round_trips_in_sqlite() {
        let (root, path) = test_database_path();
        let payload = b"CADCRD01-encrypted-payload";
        write_credential_blob(&path, payload).expect("credential blob should be stored");
        assert_eq!(
            read_credential_blob(&path).expect("credential blob should be read"),
            Some(payload.to_vec())
        );
        delete_credential_blob(&path).expect("credential blob should be deleted");
        assert_eq!(read_credential_blob(&path).unwrap(), None);
        let _ = fs::remove_dir_all(root);
    }
}

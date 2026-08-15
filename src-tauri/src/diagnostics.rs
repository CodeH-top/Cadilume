use std::{
    fmt::Arguments,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const LOG_FILE_NAME: &str = "cadilume.log";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

static LOG_FILE: OnceLock<Mutex<File>> = OnceLock::new();

pub fn initialize(log_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(log_dir)?;
    let path = log_dir.join(LOG_FILE_NAME);
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        OpenOptions::new().write(true).truncate(true).open(&path)?;
    }
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let _ = LOG_FILE.set(Mutex::new(file));
    Ok(())
}

pub fn record(scope: &str, message: Arguments<'_>) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let line = format!("{timestamp} [{scope}] {message}");
    eprintln!("{line}");
    if let Some(file) = LOG_FILE.get() {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
    }
}

//! ~/.dxxpcode config + session store — wire-compatible with the TS CLI.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub fn home_dir() -> PathBuf {
    if let Ok(d) = std::env::var("DXXPCODE_HOME") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".dxxpcode")
}

pub fn config_path() -> PathBuf {
    home_dir().join("config.json")
}

/// Mirrors `DxxpConfig` — flat JSON, unknown keys preserved via `extra`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub models: Option<HashMap<String, String>>,
    #[serde(default, rename = "approvalMode")]
    pub approval_mode: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default, rename = "effortAuto")]
    pub effort_auto: Option<bool>,
    /// Active model-variant name — indexes `variants`.
    #[serde(default)]
    pub variant: Option<String>,
    /// Named model variants: name → extra request-body fields each provider
    /// picks the keys it understands (opencode-style `providerOptions`).
    #[serde(default)]
    pub variants: Option<std::collections::BTreeMap<String, Value>>,
    #[serde(default, rename = "maxIterations")]
    pub max_iterations: Option<u32>,
    #[serde(default, rename = "anthropicApiKey")]
    pub anthropic_api_key: Option<String>,
    #[serde(default, rename = "openaiApiKey")]
    pub openai_api_key: Option<String>,
    #[serde(default, rename = "openaiBaseUrl")]
    pub openai_base_url: Option<String>,
    #[serde(default, rename = "installId")]
    pub install_id: Option<String>,
    #[serde(default, rename = "typeSafeApiKey")]
    pub type_safe_api_key: Option<String>,
    #[serde(default, rename = "licenseKey")]
    pub license_key: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub fn load_config() -> Config {
    let path = config_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Config::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_config(cfg: &Config) {
    let dir = home_dir();
    let _ = fs::create_dir_all(&dir);
    let path = config_path();
    if let Ok(mut raw) = serde_json::to_string_pretty(cfg) {
        raw.push('\n');
        let _ = fs::write(&path, raw);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
}

/* ------------------------------ sessions ------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub version: u32,
    pub id: String,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub task: String,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: Vec<Value>,
    #[serde(default, rename = "filesChanged")]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub todos: Option<Vec<Value>>,
    #[serde(default)]
    pub result: Option<String>,
    /// "code" (default) or "chat" — restored on resume.
    #[serde(default)]
    pub mode: Option<String>,
    /// User-set display name; falls back to the task text when absent.
    #[serde(default)]
    pub title: Option<String>,
    /// Pinned sessions sort first in the sidebar.
    #[serde(default)]
    pub pinned: bool,
}

pub fn sessions_dir() -> PathBuf {
    home_dir().join("sessions")
}

use sha1::Digest;

fn slugify(root: &str) -> String {
    let digest = sha1::Sha1::digest(root.as_bytes());
    let hex8: String = digest[..4].iter().map(|b| format!("{:02x}", b)).collect();
    let base = root
        .replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .next_back()
        .unwrap_or("project")
        .to_lowercase();
    let s: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-');
    let s = if s.is_empty() { "project" } else { s };
    format!("{s}-{hex8}")
}

pub fn new_session_id(root: &str) -> String {
    // `${slug}-${ISO ts with :/. → -}-${3 bytes hex}` — same shape as the TS CLI.
    let now = chrono::Utc::now();
    let ts = now
        .format("%Y-%m-%dT%H:%M:%S%.3f")
        .to_string()
        .replace([':', '.'], "-");
    let ts = ts.trim_end_matches('Z').to_string();
    let rand_hex: String = (0..3)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect();
    format!("{}-{}-{}", slugify(root), ts, rand_hex)
}

pub fn save_session(rec: &SessionRecord) {
    let dir = sessions_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut raw) = serde_json::to_vec(rec) {
        raw.push(b'\n');
        let _ = fs::write(dir.join(format!("{}.json", rec.id)), raw);
    }
}

pub fn load_session(id: &str) -> Option<SessionRecord> {
    let path = sessions_dir().join(format!("{id}.json"));
    let raw = fs::read_to_string(path).ok()?;
    let parsed: SessionRecord = serde_json::from_str(&raw).ok()?;
    (parsed.version == 1).then_some(parsed)
}

/// Parsed session files keyed by path → (mtime, len, record). `list_sessions`
/// runs on every sidebar emit; transcripts can be large, so unchanged files
/// are not re-read or re-parsed.
fn session_cache() -> &'static Mutex<HashMap<PathBuf, (std::time::SystemTime, u64, SessionRecord)>>
{
    static CACHE: std::sync::OnceLock<
        Mutex<HashMap<PathBuf, (std::time::SystemTime, u64, SessionRecord)>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn list_sessions() -> Vec<SessionRecord> {
    let dir = sessions_dir();
    let mut out = vec![];
    let mut cache = session_cache().lock().unwrap();
    let mut present: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            present.insert(path.clone());
            let meta = fs::metadata(&path).ok();
            let key = meta.and_then(|m| m.modified().ok().map(|t| (t, m.len())));
            if let Some(key) = key {
                if let Some((t, l, rec)) = cache.get(&path) {
                    if *t == key.0 && *l == key.1 {
                        out.push(rec.clone());
                        continue;
                    }
                }
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(rec) = serde_json::from_str::<SessionRecord>(&raw) {
                    if rec.version == 1 {
                        if let Some((t, l)) = key {
                            cache.insert(path, (t, l, rec.clone()));
                        }
                        out.push(rec);
                    }
                }
            }
        }
    }
    // Drop entries for deleted session files so deletes take effect.
    cache.retain(|p, _| present.contains(p));
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

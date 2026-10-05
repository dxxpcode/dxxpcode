//! Tool registry — port of packages/tools.

use crate::perm::{
    evaluate_command, evaluate_file_action, resolve_within_root, Decision, FileAction, Level,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn str_arg(input: &Value, key: &str) -> Result<String, String> {
    match input.get(key).and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(format!("missing or invalid \"{key}\"")),
    }
}

pub fn opt_str(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub fn opt_num(input: &Value, key: &str) -> Option<f64> {
    input
        .get(key)
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite())
}

/// An image block a tool result returns to a vision-capable model
/// (screenshots from the `browse` tool).
#[derive(Debug, Clone)]
pub struct ToolImage {
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub content: String,
    pub is_error: bool,
    pub changed_file: Option<String>,
    pub diff: Option<String>,
    pub images: Vec<ToolImage>,
}

impl ToolResult {
    fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
            changed_file: None,
            diff: None,
            images: vec![],
        }
    }
    fn err(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
            changed_file: None,
            diff: None,
            images: vec![],
        }
    }
    pub fn with_image(mut self, media_type: &str, data_base64: String) -> Self {
        self.images.push(ToolImage {
            media_type: media_type.to_string(),
            data_base64,
        });
        self
    }
}

pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    pub plan_phase: bool,
    pub permission: fn(&Value, &str) -> Decision,
    pub execute: fn(&Value, &Ctx) -> ToolResult,
}

pub type CtxProcTable = Arc<Mutex<HashMap<String, BgProc>>>;

#[derive(Clone)]
pub struct Ctx {
    pub root: String,
    /// Shared cancel flag — checked by run_command loops.
    pub aborted: Arc<std::sync::atomic::AtomicBool>,
    /// Background process table (run_background/check_process/kill_process).
    pub procs: Arc<Mutex<HashMap<String, BgProc>>>,
    /// While a tool executes, a buffer holding its live partial output —
    /// a drainer thread in the agent streams it to the UI as `tool_delta`.
    /// Installed around `(tool.execute)` by the agent.
    pub live_out: Arc<Mutex<Option<Arc<Mutex<String>>>>>,
    /// Lazily-launched headless Chrome for the `browse` tool (one per run).
    pub browser: Arc<Mutex<Option<crate::browser::Browser>>>,
}

pub struct BgProc {
    pub name: String,
    pub command: String,
    pub pid: u32,
    pub log_file: PathBuf,
    /// Unix seconds when the process was started.
    pub started_unix: u64,
    /// None for processes reattached after `--resume` (we can't wait on them,
    /// but kill(pid, 0) liveness + the log file still work).
    pub child: Option<Arc<Mutex<Child>>>,
    pub exit_code: Arc<Mutex<Option<i32>>>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn procs_file(root: &str) -> PathBuf {
    Path::new(root).join(".dxxpcode").join("procs.json")
}

fn save_procs(root: &str, procs: &HashMap<String, BgProc>) {
    let list: Vec<Value> = procs
        .values()
        .map(|p| {
            json!({"name": p.name, "command": p.command, "pid": p.pid,
            "log_file": p.log_file.display().to_string(), "started_unix": p.started_unix})
        })
        .collect();
    let path = procs_file(root);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&list).unwrap_or_default(),
    );
}

/// Reattach to still-running background processes recorded by earlier
/// sessions (survives `--resume`). Dead pids are pruned.
pub fn load_procs(root: &str) -> CtxProcTable {
    let mut map = HashMap::new();
    if let Ok(raw) = fs::read_to_string(procs_file(root)) {
        if let Ok(list) = serde_json::from_str::<Vec<Value>>(&raw) {
            for e in list {
                let pid = e.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if pid == 0 || !pid_alive(pid) {
                    continue;
                }
                let name = e
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                map.insert(
                    name.clone(),
                    BgProc {
                        name,
                        command: e
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        pid,
                        log_file: PathBuf::from(
                            e.get("log_file").and_then(|v| v.as_str()).unwrap_or(""),
                        ),
                        started_unix: e
                            .get("started_unix")
                            .and_then(|v| v.as_u64())
                            .unwrap_or_else(now_unix),
                        child: None,
                        exit_code: Arc::new(Mutex::new(None)),
                    },
                );
            }
        }
    }
    Arc::new(Mutex::new(map))
}

fn o(pairs: &[(&str, Value)]) -> Value {
    json!(Map::from_iter(
        pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone()))
    ))
}

fn schema(props: &[(&str, Value)], required: &[&str]) -> Value {
    let mut obj = o(&[("type", json!("object"))]);
    let map = Map::from_iter(props.iter().map(|(k, v)| ((*k).to_string(), v.clone())));
    obj["properties"] = Value::Object(map);
    if !required.is_empty() {
        obj["required"] = json!(required);
    }
    obj
}

fn p_str(desc: &str) -> Value {
    json!({"type": "string", "description": desc})
}
fn p_num(desc: &str) -> Value {
    json!({"type": "number", "description": desc})
}
fn p_bool(desc: &str) -> Value {
    json!({"type": "boolean", "description": desc})
}

/* ------------------------------- file tools ------------------------------ */

const MAX_READ_LINES: usize = 2000;
const MAX_READ_BYTES: u64 = 200 * 1024;

fn rel(ctx: &Ctx, path: &str) -> Option<String> {
    resolve_within_root(&ctx.root, path)
}

fn escape_result(path: &str) -> ToolResult {
    ToolResult::err(format!("path escapes project root: {path}"))
}

const DIFF_CTX: usize = 2;
const DIFF_MAX_LINES: usize = 30;

/// Minimal unified-diff preview matching the TS implementation.
pub fn preview_diff(path: &str, old: Option<&str>, new: &str) -> String {
    let a: Vec<&str> = old.map(|s| s.split('\n').collect()).unwrap_or_default();
    let b: Vec<&str> = new.split('\n').collect();
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    if pre == a.len() && pre == b.len() {
        return String::new();
    }
    let del = &a[pre..a.len() - suf];
    let add = &b[pre..b.len() - suf];
    let old_start = pre.saturating_sub(DIFF_CTX);
    let new_start = old_start;
    let old_end = (pre + del.len() + DIFF_CTX).min(a.len());
    let new_end = (pre + add.len() + DIFF_CTX).min(b.len());
    let mut lines = vec![
        format!("--- a/{path}"),
        format!("+++ b/{path}"),
        format!(
            "@@ -{},{} +{},{} @@",
            old_start + 1,
            old_end - old_start,
            new_start + 1,
            new_end - new_start
        ),
    ];
    for l in &a[old_start..pre] {
        lines.push(format!(" {l}"));
    }
    for l in del {
        lines.push(format!("-{l}"));
    }
    for l in add {
        lines.push(format!("+{l}"));
    }
    for l in &a[pre + del.len()..old_end] {
        lines.push(format!(" {l}"));
    }
    if lines.len() > DIFF_MAX_LINES {
        lines.truncate(DIFF_MAX_LINES);
        lines.push(format!(
            "… {} more lines",
            add.len() + del.len() + 2 * DIFF_CTX - DIFF_MAX_LINES + 3
        ));
    }
    lines.join("\n")
}

/// Proposed-change preview for write-family tools: returns (rel path, unified
/// diff) without touching disk. None when nothing meaningful can be previewed
/// (unreadable file, unmatchable edit, no-op write) — the tool's own error or
/// no-op path then applies.
pub fn preview_change(name: &str, input: &Value, ctx: &Ctx) -> Option<(String, String)> {
    let path = input.get("path").and_then(|v| v.as_str())?;
    let r = rel(ctx, path)?;
    let abs = Path::new(&ctx.root).join(&r);
    match name {
        "write_file" => {
            let content = input.get("content").and_then(|v| v.as_str())?;
            let prev = fs::read_to_string(&abs).ok();
            let d = preview_diff(&r, prev.as_deref(), content);
            if d.is_empty() {
                None
            } else {
                Some((r, d))
            }
        }
        "edit_file" => {
            let edits = edits_from(input)?;
            let raw = fs::read_to_string(&abs).ok()?;
            let replace_all = input.get("replace_all").and_then(|v| v.as_bool()) == Some(true);
            let (updated, _) = apply_edits(&raw, &edits, replace_all, &r).ok()?;
            let d = preview_diff(&r, Some(&raw), &updated);
            if d.is_empty() {
                None
            } else {
                Some((r, d))
            }
        }
        "delete_file" => {
            if !abs.exists() {
                return None;
            }
            let raw = fs::read_to_string(&abs).unwrap_or_default();
            let d = preview_diff(&r, Some(&raw), "");
            let d = if d.is_empty() {
                format!("- {r} (delete)")
            } else {
                d
            };
            Some((r, d))
        }
        _ => None,
    }
}

fn exec_list_directory(input: &Value, ctx: &Ctx) -> ToolResult {
    let path = opt_str(input, "path").unwrap_or_else(|| ".".into());
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    let Ok(meta) = fs::metadata(&abs) else {
        return ToolResult::err(format!(
            "not a directory: {}",
            if r.is_empty() { "." } else { &r }
        ));
    };
    if !meta.is_dir() {
        return ToolResult::err(format!(
            "not a directory: {}",
            if r.is_empty() { "." } else { &r }
        ));
    }
    const SKIP: &[&str] = &["node_modules", ".git", "__pycache__"];
    let mut entries: Vec<String> = fs::read_dir(&abs)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !SKIP.contains(&e.file_name().to_string_lossy().as_ref()))
                .map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        format!("{n}/")
                    } else {
                        n
                    }
                })
                .take(500)
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    ToolResult::ok(if entries.is_empty() {
        "(empty)".into()
    } else {
        entries.join("\n")
    })
}

fn exec_read_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(path) = str_arg(input, "path") else {
        return ToolResult::err("missing or invalid \"path\"");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    if !abs.exists() {
        return ToolResult::err(format!("file not found: {r}"));
    }
    let Ok(meta) = fs::metadata(&abs) else {
        return ToolResult::err(format!("not a file: {r}"));
    };
    if !meta.is_file() {
        return ToolResult::err(format!("not a file: {r}"));
    }
    if meta.len() > MAX_READ_BYTES {
        return ToolResult::err(format!(
            "file too large ({} bytes); read a range with offset/limit",
            meta.len()
        ));
    }
    let Ok(raw) = fs::read_to_string(&abs) else {
        return ToolResult::err(format!("binary file not shown: {r}"));
    };
    if raw.contains('\0') {
        return ToolResult::err(format!("binary file not shown: {r}"));
    }
    let all: Vec<&str> = raw.split('\n').collect();
    let offset = (opt_num(input, "offset").unwrap_or(1.0) as usize).max(1);
    let limit =
        (opt_num(input, "limit").unwrap_or(MAX_READ_LINES as f64) as usize).min(MAX_READ_LINES);
    let end = (offset - 1 + limit).min(all.len());
    let start = (offset - 1).min(all.len());
    let slice = &all[start..end];
    let numbered: String = slice
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{}\t{}", offset + i, l))
        .collect::<Vec<_>>()
        .join("\n");
    let truncated = offset - 1 + slice.len() < all.len();
    ToolResult::ok(format!(
        "{}{}",
        numbered,
        if truncated {
            format!("\n… ({} lines total, truncated)", all.len())
        } else {
            String::new()
        }
    ))
}

fn exec_write_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let (Ok(path), Ok(content)) = (str_arg(input, "path"), str_arg(input, "content")) else {
        return ToolResult::err("missing or invalid input");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    if let Some(parent) = abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let prev = fs::read_to_string(&abs).ok();
    let existed = prev.is_some();
    if fs::write(&abs, &content).is_err() {
        return ToolResult::err(format!("failed to write: {r}"));
    }
    let mut res = ToolResult::ok(format!(
        "{} {} ({} lines)",
        if existed { "updated" } else { "created" },
        r,
        content.split('\n').count()
    ));
    res.changed_file = Some(r.clone());
    res.diff = Some(preview_diff(&r, prev.as_deref(), &content)).filter(|d| !d.is_empty());
    res
}

struct Edit {
    old: String,
    new: String,
}

fn edits_from(input: &Value) -> Option<Vec<Edit>> {
    if let Some(arr) = input.get("edits").and_then(|v| v.as_array()) {
        let mut out = Vec::with_capacity(arr.len());
        for e in arr {
            let old = e.get("old_string").and_then(|v| v.as_str())?;
            let new = e.get("new_string").and_then(|v| v.as_str())?;
            out.push(Edit {
                old: old.to_string(),
                new: new.to_string(),
            });
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    let old = input.get("old_string").and_then(|v| v.as_str())?;
    let new = input.get("new_string").and_then(|v| v.as_str())?;
    Some(vec![Edit {
        old: old.to_string(),
        new: new.to_string(),
    }])
}

/// Locate `old` inside `raw` exactly or with per-line whitespace tolerance.
/// Returns (matches, mode) — each match a (start_byte, end_byte) region.
fn find_matches(raw: &str, old: &str) -> (Vec<(usize, usize)>, &'static str) {
    if old.is_empty() {
        return (vec![], "exact");
    }
    let mut hits: Vec<(usize, usize)> = raw
        .match_indices(old)
        .map(|(i, _)| (i, i + old.len()))
        .collect();
    if !hits.is_empty() {
        return (hits, "exact");
    }
    // Whitespace-tolerant: compare lines after trimming each side's edges.
    let old_lines: Vec<&str> = old.lines().map(|l| l.trim()).collect();
    if old_lines.is_empty() || old_lines.iter().all(|l| l.is_empty()) {
        return (vec![], "exact");
    }
    let raw_lines: Vec<&str> = raw.lines().collect();
    let n = old_lines.len();
    for (i, w) in raw_lines.windows(n).enumerate() {
        if w.iter().zip(&old_lines).all(|(a, b)| a.trim() == *b) {
            let start: usize = raw_lines[..i].iter().map(|l| l.len() + 1).sum();
            let end: usize = raw_lines[..i + n]
                .iter()
                .map(|l| l.len() + 1)
                .sum::<usize>()
                .saturating_sub(1)
                .min(raw.len());
            hits.push((start, end));
        }
    }
    if !hits.is_empty() {
        return (hits, "whitespace-tolerant");
    }
    (vec![], "exact")
}

/// Best-effort closest region for a failed match: the contiguous line window
/// sharing the most trimmed lines with `old`, shown to the model so it can
/// self-correct in one retry.
fn closest_region(raw: &str, old: &str) -> Option<String> {
    let old_set: std::collections::HashSet<&str> = old
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if old_set.is_empty() {
        return None;
    }
    let n = old.lines().count().max(2);
    let raw_lines: Vec<&str> = raw.lines().collect();
    let mut best = (0usize, 0usize); // (score, start_line)
    for i in 0..raw_lines.len().saturating_sub(n - 1).max(1) {
        let score = raw_lines[i..(i + n).min(raw_lines.len())]
            .iter()
            .filter(|l| old_set.contains(l.trim()))
            .count();
        if score > best.0 {
            best = (score, i);
        }
    }
    if best.0 == 0 {
        return None;
    }
    let end = (best.1 + n).min(raw_lines.len());
    let body = raw_lines[best.1..end]
        .iter()
        .enumerate()
        .map(|(k, l)| format!("{:>4}| {l}", best.1 + k + 1))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("closest match at line {}:\n{body}", best.1 + 1))
}

/// Apply edits sequentially, enforcing the unique-match guard unless
/// replace_all. Returns (updated content, matched-with-whitespace-tolerance)
/// or an error message for the model.
fn apply_edits(
    raw: &str,
    edits: &[Edit],
    replace_all: bool,
    path: &str,
) -> Result<(String, bool), String> {
    let mut content = raw.to_string();
    let mut used_fallback = false;
    for (i, e) in edits.iter().enumerate() {
        let (hits, mode) = find_matches(&content, &e.old);
        let tag = if edits.len() > 1 {
            format!("edit {}: ", i + 1)
        } else {
            String::new()
        };
        if hits.is_empty() {
            let hint = closest_region(&content, &e.old)
                .map(|h| format!("; {h}"))
                .unwrap_or_default();
            return Err(format!("{tag}old_string not found in {path}{hint}"));
        }
        if hits.len() > 1 && !replace_all {
            return Err(format!(
                "{tag}old_string matches {} times in {path}; provide more context or set replace_all",
                hits.len()
            ));
        }
        used_fallback |= mode != "exact";
        if replace_all {
            for (s, e_) in hits.iter().rev() {
                content.replace_range(*s..*e_, &e.new);
            }
        } else {
            let (s, e_) = hits[0];
            content.replace_range(s..e_, &e.new);
        }
    }
    Ok((content, used_fallback))
}

fn exec_edit_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(path) = str_arg(input, "path") else {
        return ToolResult::err("missing or invalid input");
    };
    let Some(edits) = edits_from(input) else {
        return ToolResult::err("missing \"old_string\"/\"new_string\" or \"edits\"");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    let Ok(raw) = fs::read_to_string(&abs) else {
        return ToolResult::err(format!("file not found: {r}"));
    };
    let replace_all = input.get("replace_all").and_then(|v| v.as_bool()) == Some(true);
    let (updated, tolerant) = match apply_edits(&raw, &edits, replace_all, &r) {
        Ok(u) => u,
        Err(m) => return ToolResult::err(m),
    };
    if fs::write(&abs, &updated).is_err() {
        return ToolResult::err(format!("failed to write: {r}"));
    }
    let mut res = ToolResult::ok(format!(
        "edited {r} ({} edit{}{})",
        edits.len(),
        if edits.len() > 1 { "s" } else { "" },
        if tolerant {
            ", whitespace-tolerant match"
        } else {
            ""
        }
    ));
    res.changed_file = Some(r.clone());
    res.diff = Some(preview_diff(&r, Some(&raw), &updated)).filter(|d| !d.is_empty());
    res
}

fn exec_delete_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(path) = str_arg(input, "path") else {
        return ToolResult::err("missing or invalid \"path\"");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    if !abs.exists() {
        return ToolResult::err(format!("not found: {r}"));
    }
    if fs::remove_file(&abs).map(|_| ()).is_err() && fs::remove_dir(&abs).is_err() {
        return ToolResult::err(format!("failed to delete: {r}"));
    }
    let mut res = ToolResult::ok(format!("deleted {r}"));
    res.changed_file = Some(r);
    res
}

/* -------------------------------- search --------------------------------- */

const SEARCH_SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    ".dxxpcode",
    "coverage",
    ".turbo",
];
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_MATCHES: usize = 100;

fn walk_search(root: &Path, rel: &str, out: &mut Vec<String>) {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let Ok(rd) = fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !SEARCH_SKIP.contains(&name.as_str()) && !crate::perm::is_restricted_path(&p) {
                walk_search(root, &p, out);
            }
        } else if ft.is_file() && !crate::perm::is_restricted_path(&p) {
            out.push(p);
        }
    }
}

fn glob_to_re(glob: &str) -> Option<regex::Regex> {
    let mut pat = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => pat.push_str(".*"),
            '?' => pat.push('.'),
            c if ".+^${}()|[]\\".contains(c) => {
                pat.push('\\');
                pat.push(c);
            }
            c => pat.push(c),
        }
    }
    pat.push('$');
    regex::Regex::new(&pat).ok()
}

fn exec_search_files(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(pattern) = str_arg(input, "pattern") else {
        return ToolResult::err("missing or invalid \"pattern\"");
    };
    let base = opt_str(input, "path").unwrap_or_else(|| ".".into());
    let Some(rel) = resolve_within_root(&ctx.root, &base) else {
        return ToolResult::err(format!("directory not found: {base}"));
    };
    let abs = Path::new(&ctx.root).join(&rel);
    if !abs.exists() {
        return ToolResult::err(format!("directory not found: {base}"));
    }
    let flags = if input.get("case_insensitive").and_then(|v| v.as_bool()) == Some(true) {
        "(?i)"
    } else {
        ""
    };
    let Ok(re) = regex::Regex::new(&format!("{flags}{pattern}")) else {
        return ToolResult::err(format!("invalid regex: {pattern}"));
    };
    let glob_re = opt_str(input, "glob").and_then(|g| glob_to_re(&g));

    let files = if abs.is_dir() {
        let mut v = vec![];
        walk_search(Path::new(&ctx.root), &rel, &mut v);
        v
    } else {
        vec![rel.clone()]
    };
    let mut matches = vec![];
    'outer: for file in files {
        if let Some(gr) = &glob_re {
            let base_name = file.rsplit('/').next().unwrap_or(&file);
            if !gr.is_match(base_name) {
                continue;
            }
        }
        let absf = Path::new(&ctx.root).join(&file);
        let Ok(meta) = fs::metadata(&absf) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(&absf) else {
            continue;
        };
        if text.contains('\0') {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                matches.push(format!(
                    "{file}:{}: {}",
                    i + 1,
                    line.chars().take(200).collect::<String>()
                ));
                if matches.len() >= MAX_MATCHES {
                    break 'outer;
                }
            }
        }
    }
    ToolResult::ok(if matches.is_empty() {
        "no matches".into()
    } else {
        let mut body = matches.join("\n");
        if matches.len() >= MAX_MATCHES {
            body += &format!("\n… (truncated at {MAX_MATCHES})");
        }
        body
    })
}

/* --------------------------------- shell --------------------------------- */

const MAX_OUTPUT: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

#[cfg(unix)]
const SIG_KILL: i32 = libc::SIGKILL;
#[cfg(unix)]
const SIG_TERM: i32 = libc::SIGTERM;
#[cfg(not(unix))]
const SIG_KILL: i32 = 0;
#[cfg(not(unix))]
const SIG_TERM: i32 = 0;

#[cfg(unix)]
fn kill_group(pid: u32, sig: i32) {
    unsafe {
        libc::kill(-(pid as i32), sig);
        libc::kill(pid as i32, sig);
    }
}
#[cfg(not(unix))]
fn kill_group(pid: u32, _sig: i32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F", "/T"])
        .output();
}

fn exec_run_command(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(command) = str_arg(input, "command") else {
        return ToolResult::err("missing or invalid \"command\"");
    };
    let timeout = (opt_num(input, "timeout_ms").unwrap_or(DEFAULT_TIMEOUT_MS as f64) as u64)
        .min(MAX_TIMEOUT_MS);

    let mut cmd = if cfg!(unix) {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", &command]);
        c
    } else {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    };
    cmd.current_dir(&ctx.root)
        .env("CI", "1")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env_remove("NODE_TEST_CONTEXT")
        .env_remove("NODE_V8_COVERAGE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("failed to start: {e}")),
    };
    let pid = child.id();

    let out = Arc::new(Mutex::new(String::new()));
    let mut readers = vec![];
    let mut pipes: Vec<Box<dyn Read + Send>> = vec![];
    if let Some(p) = child.stdout.take() {
        pipes.push(Box::new(p));
    }
    if let Some(p) = child.stderr.take() {
        pipes.push(Box::new(p));
    }
    for mut p in pipes {
        let out = Arc::clone(&out);
        readers.push(std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = p.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut g = out.lock().unwrap();
                if g.len() < MAX_OUTPUT {
                    g.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
                drop(g);
            }
        }));
    }

    let start = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let mut sent = 0usize;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if let Some(live) = ctx.live_out.lock().unwrap().as_ref() {
                    let g = out.lock().unwrap();
                    if g.len() > sent {
                        live.lock().unwrap().push_str(&g[sent..]);
                        sent = g.len();
                    }
                }
                if start.elapsed() > Duration::from_millis(timeout) {
                    timed_out = true;
                    kill_group(pid, SIG_KILL);
                    let _ = child.wait();
                    break;
                }
                if ctx.aborted.load(std::sync::atomic::Ordering::Relaxed) {
                    cancelled = true;
                    kill_group(pid, SIG_KILL);
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break,
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let out = Arc::try_unwrap(out)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    let code = if timed_out || cancelled {
        None
    } else {
        child.try_wait().ok().flatten().and_then(|s| s.code())
    };

    if timed_out {
        return ToolResult::err(format!(
            "command timed out after {timeout}ms\n{}",
            &out[..out.len().min(MAX_OUTPUT)]
        ));
    }
    if cancelled {
        return ToolResult::err("command cancelled");
    }
    let body = if out.len() > MAX_OUTPUT {
        format!("{}\n… (truncated)", &out[..MAX_OUTPUT])
    } else {
        out
    };
    ToolResult {
        content: format!(
            "$ {command}\nexit {}\n{}",
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            body
        )
        .trim_end()
        .to_string(),
        is_error: code != Some(0),
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

/* ------------------------------- background ------------------------------ */

fn bg_dir() -> PathBuf {
    crate::config::home_dir().join("bg")
}

fn log_tail(path: &Path, max: usize) -> String {
    let Ok(raw) = fs::read_to_string(path) else {
        return String::new();
    };
    if raw.len() > max {
        raw[raw.len() - max..].to_string()
    } else {
        raw
    }
}

fn proc_alive(p: &BgProc) -> bool {
    p.exit_code.lock().unwrap().is_none() && pid_alive(p.pid)
}

fn exec_run_background(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(name) = str_arg(input, "name") else {
        return ToolResult::err("missing or invalid \"name\"");
    };
    let Ok(command) = str_arg(input, "command") else {
        return ToolResult::err("missing or invalid \"command\"");
    };
    {
        let procs = ctx.procs.lock().unwrap();
        if let Some(p) = procs.get(&name) {
            if proc_alive(p) {
                return ToolResult::err(format!("'{name}' is already running (pid {})", p.pid));
            }
        }
    }
    let dir = bg_dir();
    let _ = fs::create_dir_all(&dir);
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let log_file = dir.join(format!("{safe_name}.log"));
    let Ok(f) = fs::File::create(&log_file) else {
        return ToolResult::err("failed to open log file");
    };
    let f2 = f.try_clone().unwrap();

    let mut cmd = if cfg!(unix) {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", &command]);
        c
    } else {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    };
    cmd.current_dir(&ctx.root)
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(f))
        .stderr(Stdio::from(f2));
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ToolResult::err(format!("failed to start: {e}")),
    };
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    let exit_code = Arc::new(Mutex::new(None::<i32>));
    {
        let child = Arc::clone(&child);
        let exit_code = Arc::clone(&exit_code);
        std::thread::spawn(move || {
            let status = child.lock().unwrap().wait().ok();
            *exit_code.lock().unwrap() = status.and_then(|s| s.code());
        });
    }
    let log_path = log_file.display().to_string();
    {
        let mut procs = ctx.procs.lock().unwrap();
        procs.insert(
            name.clone(),
            BgProc {
                name: name.clone(),
                command: command.clone(),
                pid,
                log_file,
                started_unix: now_unix(),
                child: Some(child),
                exit_code,
            },
        );
        save_procs(&ctx.root, &procs);
    }
    ToolResult::ok(format!("started '{name}' in the background (pid {pid})\nlog: {log_path}\nuse check_process to read output or kill_process to stop it"))
}

fn exec_check_process(input: &Value, ctx: &Ctx) -> ToolResult {
    let procs = ctx.procs.lock().unwrap();
    let name = opt_str(input, "name");
    let Some(name) = name else {
        if procs.is_empty() {
            return ToolResult::ok("no background processes");
        }
        let lines: Vec<String> = procs
            .values()
            .map(|p| {
                let secs = now_unix().saturating_sub(p.started_unix);
                let state = if proc_alive(p) {
                    format!("running (pid {}, {}s)", p.pid, secs)
                } else if let Some(code) = *p.exit_code.lock().unwrap() {
                    format!("exited ({code})")
                } else {
                    "not running".to_string()
                };
                format!("{}: {} — {}", p.name, state, p.command)
            })
            .collect();
        return ToolResult::ok(lines.join("\n"));
    };
    let Some(p) = procs.get(&name) else {
        return ToolResult::err(format!("no background process named '{name}'"));
    };
    let state = if proc_alive(p) {
        format!("running (pid {})", p.pid)
    } else if let Some(code) = *p.exit_code.lock().unwrap() {
        format!("exited ({code})")
    } else {
        "not running".to_string()
    };
    let tail = log_tail(&p.log_file, 16 * 1024);
    let n = opt_num(input, "tail_lines").unwrap_or(60.0) as usize;
    let lines: Vec<&str> = tail.split('\n').collect();
    let shown = if lines.len() > n {
        lines[lines.len() - n..].join("\n")
    } else {
        tail
    };
    ToolResult::ok(format!(
        "{name}: {state}\n$ {}\n{}",
        p.command,
        if shown.trim_end().is_empty() {
            "(no output yet)".into()
        } else {
            shown.trim_end().to_string()
        }
    ))
}

fn exec_kill_process(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(name) = str_arg(input, "name") else {
        return ToolResult::err("missing or invalid \"name\"");
    };
    let procs = ctx.procs.lock().unwrap();
    let Some(p) = procs.get(&name) else {
        return ToolResult::err(format!("no background process named '{name}'"));
    };
    if !proc_alive(p) {
        return ToolResult::ok(format!("'{name}' is not running"));
    }
    kill_group(p.pid, SIG_TERM);
    ToolResult::ok(format!("sent SIGTERM to '{name}' (pid {})", p.pid))
}

/* ---------------------------------- git ---------------------------------- */

const GIT_MAX_OUTPUT: usize = 64 * 1024;

fn git_cmd(ctx: &Ctx, args: &[&str]) -> (i32, String) {
    let out = Command::new("git")
        .args(args)
        .current_dir(&ctx.root)
        .env("GIT_PAGER", "cat")
        .output();
    match out {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.is_empty() {
                s.push_str(&format!("\n{err}"));
            }
            (
                o.status.code().unwrap_or(1),
                s.chars().take(GIT_MAX_OUTPUT).collect(),
            )
        }
        Err(_) => (1, String::new()),
    }
}

fn exec_git_status(_i: &Value, ctx: &Ctx) -> ToolResult {
    let (code, out) = git_cmd(ctx, &["status", "--short", "--branch"]);
    ToolResult {
        content: if out.trim().is_empty() {
            "clean".into()
        } else {
            out
        },
        is_error: code != 0,
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

fn exec_git_diff(input: &Value, ctx: &Ctx) -> ToolResult {
    let mut args = vec!["diff"];
    if input.get("staged").and_then(|v| v.as_bool()) == Some(true) {
        args.push("--cached");
    }
    let mut owned: Vec<String> = vec![];
    if let Some(path) = opt_str(input, "path") {
        owned.push("--".into());
        owned.push(path);
    }
    let argrefs: Vec<&str> = args
        .iter()
        .copied()
        .chain(owned.iter().map(|s| s.as_str()))
        .collect();
    let (code, out) = git_cmd(ctx, &argrefs);
    ToolResult {
        content: if out.trim().is_empty() {
            "(no diff)".into()
        } else {
            out
        },
        is_error: code != 0,
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

fn exec_git_log(input: &Value, ctx: &Ctx) -> ToolResult {
    let limit = (opt_num(input, "limit").unwrap_or(15.0) as usize).min(30);
    let max = format!("--max-count={limit}");
    let (code, out) = git_cmd(ctx, &["log", &max, "--oneline", "--decorate"]);
    ToolResult {
        content: if out.trim().is_empty() {
            "(no commits)".into()
        } else {
            out
        },
        is_error: code != 0,
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

/* ------------------------------- registry -------------------------------- */

fn perm_file(action: FileAction, default_path: Option<&str>) -> fn(&Value, &str) -> Decision {
    // Can't capture in fn pointers — dispatch via a small wrapper macro instead.
    match (action, default_path) {
        (FileAction::Read, Some(_)) => |i, root| {
            evaluate_file_action(
                root,
                &opt_str(i, "path").unwrap_or_else(|| ".".into()),
                FileAction::Read,
            )
        },
        (FileAction::Read, None) => |i, root| {
            evaluate_file_action(
                root,
                &str_arg(i, "path").unwrap_or_default(),
                FileAction::Read,
            )
        },
        (FileAction::Write, _) => |i, root| {
            evaluate_file_action(
                root,
                &str_arg(i, "path").unwrap_or_default(),
                FileAction::Write,
            )
        },
        (FileAction::Delete, _) => |i, root| {
            evaluate_file_action(
                root,
                &str_arg(i, "path").unwrap_or_default(),
                FileAction::Delete,
            )
        },
        _ => |_, _| Decision {
            level: Level::Safe,
            reason: "read-only".into(),
        },
    }
}

fn perm_safe(_: &Value, _: &str) -> Decision {
    Decision {
        level: Level::Safe,
        reason: "read-only".into(),
    }
}
fn perm_command(input: &Value, _: &str) -> Decision {
    evaluate_command(&str_arg(input, "command").unwrap_or_default())
}
fn perm_bg_command(input: &Value, _: &str) -> Decision {
    evaluate_command(&str_arg(input, "command").unwrap_or_default())
}
fn perm_approval(_: &Value, _: &str) -> Decision {
    Decision {
        level: Level::Approval,
        reason: "killing a background process".into(),
    }
}

/// Hosts the browser must never visit regardless of approval — auth,
/// banking, and account-billing surfaces where clicking has real-world cost.
const BROWSE_DENY: &[&str] = &[
    "accounts.google.com",
    "login.microsoftonline.com",
    "paypal.com",
    "stripe.com",
    "checkout.stripe.com",
    "bank",
    "coinbase.com",
];

fn url_host(url: &str) -> String {
    let u = url.trim_start_matches(|c| c == '/' || c == ' ');
    let rest = u
        .strip_prefix("http://")
        .or_else(|| u.strip_prefix("https://"))
        .unwrap_or(u);
    rest.split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "0.0.0.0"
        || host.ends_with(".local")
}

/// `browse` permission tiers: reads are safe; localhost navigation is safe;
/// external navigation and page interactions need approval; deny-listed hosts
/// are always restricted.
fn perm_browse(input: &Value, _: &str) -> Decision {
    let action = str_arg(input, "action").unwrap_or_default();
    if matches!(
        action.as_str(),
        "snapshot" | "screenshot" | "console" | "wait"
    ) {
        return perm_safe(input, "");
    }
    if action == "navigate" {
        let url = str_arg(input, "url").unwrap_or_default();
        let host = url_host(&url);
        if BROWSE_DENY.iter().any(|d| host.contains(d)) {
            return Decision {
                level: Level::Restricted,
                reason: format!("browsing to {host} is never allowed"),
            };
        }
        if is_local_host(&host) || host.is_empty() {
            return Decision {
                level: Level::Safe,
                reason: "local page".into(),
            };
        }
        return Decision {
            level: Level::Approval,
            reason: format!("open external page {host}"),
        };
    }
    if matches!(action.as_str(), "click" | "type" | "select" | "evaluate") {
        return Decision {
            level: Level::Approval,
            reason: format!("interact with the page ({action})"),
        };
    }
    Decision {
        level: Level::Safe,
        reason: "read-only".into(),
    }
}

/// The `browse` tool — lazy headless Chrome shared across calls in the run.
fn exec_browse(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(action) = str_arg(input, "action") else {
        return ToolResult::err("missing required arg: action");
    };
    let mut guard = ctx.browser.lock().unwrap();
    if guard.is_none() {
        match crate::browser::Browser::launch() {
            Ok(b) => *guard = Some(b),
            Err(e) => return ToolResult::err(e),
        }
    }
    let b = guard.as_mut().unwrap();
    match action.as_str() {
        "navigate" => {
            let url = str_arg(input, "url").unwrap_or_default();
            match b.navigate(&url) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "snapshot" => {
            let max = opt_num(input, "max_nodes").unwrap_or(150.0) as usize;
            let sel = str_arg(input, "selector").ok();
            match b.snapshot(max.max(1), sel.as_deref()) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "click" => {
            let r = str_arg(input, "ref").unwrap_or_default();
            match b.click(&r) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "type" => {
            let r = str_arg(input, "ref").unwrap_or_default();
            let text = str_arg(input, "text").unwrap_or_default();
            let submit = input.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
            match b.type_text(&r, &text, submit) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "wait" => {
            let ms = opt_num(input, "ms").unwrap_or(1000.0) as u64;
            let sel = str_arg(input, "selector").ok();
            match b.wait(sel.as_deref(), ms) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "console" => ToolResult::ok(b.console()),
        "screenshot" => match b.screenshot() {
            Ok(png) => {
                let dir = Path::new(&ctx.root).join(".dxxpcode/shots");
                let _ = fs::create_dir_all(&dir);
                let file = dir.join(format!("browse-{}.png", chrono::Utc::now().timestamp_millis()));
                let _ = fs::write(&file, &png);
                ToolResult::ok(format!("screenshot saved: {}", file.display()))
                    .with_image("image/png", b64_encode(&png))
            }
            Err(e) => ToolResult::err(e),
        },
        "evaluate" => {
            let expr = str_arg(input, "expression").unwrap_or_default();
            match b.eval(&expr) {
                Ok(v) => ToolResult::ok(serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => ToolResult::err(e),
            }
        }
        other => ToolResult::err(format!(
            "unknown action {other} — use navigate|snapshot|click|type|wait|console|screenshot|evaluate"
        )),
    }
}

fn b64_encode(bytes: &[u8]) -> String {
    const B: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |a, &b| (a << 8) | b as u32) << (8 * (3 - chunk.len()));
        let take = chunk.len() + 1;
        for i in 0..4 {
            if i < take {
                out.push(B[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn exec_noop(_i: &Value, _c: &Ctx) -> ToolResult {
    ToolResult::ok("plan recorded")
}
fn exec_todo(_i: &Value, _c: &Ctx) -> ToolResult {
    ToolResult::ok("checklist updated")
}

/// Append one durable note to `.dxxpcode/memory.md` under `## Notes`.
/// The file is metadata, not project code — no changed_file/diff review.
fn exec_remember(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(text) = str_arg(input, "text") else {
        return ToolResult::err("missing required arg: text");
    };
    let line = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if line.is_empty() {
        return ToolResult::err("empty note");
    }
    let path = Path::new(&ctx.root).join(".dxxpcode/memory.md");
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return ToolResult::err(format!("mkdir failed: {e}"));
        }
    }
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    if !content.contains("## Notes") {
        if !content.trim().is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(if content.is_empty() {
            "## Notes\n"
        } else {
            "\n## Notes\n"
        });
    } else if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&format!("- {line}\n"));
    match fs::write(&path, content) {
        Ok(_) => ToolResult::ok(format!("noted: {line}")),
        Err(e) => ToolResult::err(format!("write failed: {e}")),
    }
}

/* ------------------------------ custom tools ----------------------------- */

/// A tool defined by a .toml file in `~/.dxxpcode/tools/` or
/// `<project>/.dxxpcode/tools/` — lets a user (or the agent, with review)
/// extend the toolset without recompiling. Execution runs through the
/// same command plumbing as `run_command`.
#[derive(Clone)]
pub struct CustomSpec {
    pub name: String,
    pub description: String,
    pub command: String,
    pub ask: bool,
    pub enabled: bool,
    pub timeout_ms: u64,
    /// (arg name, arg type) — type is "string" | "number" | "bool".
    pub args: Vec<(String, String)>,
    pub path: PathBuf,
}

fn custom_dirs(root: &str) -> Vec<PathBuf> {
    let mut dirs = vec![crate::config::home_dir().join("tools")];
    if !root.is_empty() {
        dirs.push(Path::new(root).join(".dxxpcode").join("tools"));
    }
    dirs
}

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1]
            .replace("\\n", "\n")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn parse_custom(path: &Path) -> Option<CustomSpec> {
    let raw = fs::read_to_string(path).ok()?;
    let mut spec = CustomSpec {
        name: path.file_stem()?.to_string_lossy().to_string(),
        description: String::new(),
        command: String::new(),
        ask: false,
        enabled: false,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        args: vec![],
        path: path.to_path_buf(),
    };
    let mut in_args = false;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_args = line == "[args]";
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        if in_args {
            spec.args.push((k.to_string(), unquote(v)));
            continue;
        }
        match k {
            "name" => spec.name = unquote(v),
            "description" => spec.description = unquote(v),
            "command" => spec.command = unquote(v),
            "permission" => spec.ask = unquote(v) == "ask",
            "enabled" => spec.enabled = v == "true",
            "timeout_ms" => spec.timeout_ms = v.parse().unwrap_or(DEFAULT_TIMEOUT_MS),
            _ => {}
        }
    }
    // A valid tool name is a safe provider identifier — anything else is skipped.
    if spec.command.is_empty()
        || spec.name.is_empty()
        || !spec
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(spec)
}

/// All custom tool specs found under `~/.dxxpcode/tools/` and
/// `<root>/.dxxpcode/tools/` — enabled and disabled alike (for /tools).
pub fn custom_tools(root: &str) -> Vec<CustomSpec> {
    let mut out = vec![];
    for dir in custom_dirs(root) {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("toml") {
                if let Some(spec) = parse_custom(&p) {
                    out.push(spec);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The enabled spec with this name, if any.
pub fn custom_spec(root: &str, name: &str) -> Option<CustomSpec> {
    custom_tools(root)
        .into_iter()
        .find(|s| s.enabled && s.name == name)
}

/// Flip `enabled = true|false` inside a tool file (inserts the line if absent).
pub fn set_custom_enabled(path: &Path, on: bool) -> Result<(), String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut seen = false;
    let mut out = String::new();
    for line in raw.lines() {
        if line.trim_start().starts_with("enabled") && line.contains('=') {
            out.push_str(&format!("enabled = {on}\n"));
            seen = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !seen {
        out.insert_str(0, &format!("enabled = {on}\n"));
    }
    fs::write(path, out).map_err(|e| e.to_string())
}

/// Substitute `{arg}` placeholders in a tool's command template. String args
/// are single-quoted so injected text can never escape into shell syntax.
fn expand_custom(spec: &CustomSpec, input: &Value) -> Result<String, String> {
    let mut cmd = spec.command.clone();
    for (arg, ty) in &spec.args {
        let placeholder = format!("{{{arg}}}");
        if !cmd.contains(&placeholder) {
            continue;
        }
        let Some(v) = input.get(arg) else {
            return Err(format!("missing arg \"{arg}\""));
        };
        let rep = match ty.as_str() {
            "number" | "bool" => v
                .as_f64()
                .map(|n| n.to_string())
                .or_else(|| v.as_bool().map(|b| b.to_string()))
                .ok_or_else(|| format!("arg \"{arg}\" must be {ty}"))?,
            _ => format!("'{}'", v.as_str().unwrap_or("").replace('\'', "'\\''")),
        };
        cmd = cmd.replace(&placeholder, &rep);
    }
    if let Some(rest) = cmd.split('{').nth(1).and_then(|s| s.split('}').next()) {
        if rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("unknown arg \"{rest}\" in command template"));
        }
    }
    Ok(cmd)
}

/// Permission check for a custom tool — evaluates the expanded command
/// through the normal command rules; `permission = "ask"` forces approval.
pub fn perm_custom(spec: &CustomSpec, input: &Value, _root: &str) -> Decision {
    if spec.ask {
        return Decision {
            level: Level::Approval,
            reason: format!("custom tool \"{}\" asks permission", spec.name),
        };
    }
    match expand_custom(spec, input) {
        Ok(cmd) => evaluate_command(&cmd),
        Err(e) => Decision {
            level: Level::Restricted,
            reason: e,
        },
    }
}

/// Run a custom tool by expanding its template and delegating to the
/// run_command executor (same timeouts, streaming, esc-interrupt).
pub fn exec_custom(spec: &CustomSpec, input: &Value, ctx: &Ctx) -> ToolResult {
    match expand_custom(spec, input) {
        Ok(cmd) => exec_run_command(&json!({"command": cmd, "timeout_ms": spec.timeout_ms}), ctx),
        Err(e) => ToolResult::err(e),
    }
}

fn custom_schema(spec: &CustomSpec) -> Value {
    let mut props = Map::new();
    for (arg, ty) in &spec.args {
        let ty = match ty.as_str() {
            "number" => "number",
            "bool" => "boolean",
            _ => "string",
        };
        props.insert(arg.clone(), json!({"type": ty}));
    }
    json!({"type": "object", "properties": props, "required": spec.args.iter().map(|a| &a.0).collect::<Vec<_>>()})
}

pub fn registry(root: &str) -> Vec<Tool> {
    let mut tools = vec![
        Tool {
            name: "propose_plan",
            description: "Present the implementation plan to the user for approval. Call this once investigation is complete. Set trivial=true only for changes small enough to skip approval (typo fixes, one-line edits).",
            schema: schema(
                &[
                    ("summary", p_str("One-sentence summary of the change")),
                    ("steps", json!({"type": "array", "items": {"type": "string"}, "description": "Ordered implementation steps"})),
                    ("trivial", p_bool("True if the change is small enough to skip approval")),
                ],
                &["summary", "steps"],
            ),
            plan_phase: true,
            permission: perm_safe,
            execute: exec_noop,
        },
        Tool {
            name: "todo_write",
            description: "Maintain a task checklist for the current task. Call early in multi-step work with the full ordered list, then again whenever an item starts or finishes (exactly one in_progress at a time). Keep items concrete and verifiable; remove steps that become irrelevant.",
            schema: schema(
                &[(
                    "todos",
                    json!({
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": p_str("Stable identifier for the item"),
                                "content": p_str("Imperative description of the step"),
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                                "activeForm": p_str("Present-continuous label while in progress"),
                            },
                            "required": ["id", "content", "status"],
                        },
                        "description": "The complete checklist, in order — replaces the previous list",
                    }),
                )],
                &["todos"],
            ),
            plan_phase: false,
            permission: perm_safe,
            execute: exec_todo,
        },
        Tool {
            name: "list_directory",
            description: "List files and directories under a path inside the project. Use '.' for the project root.",
            schema: schema(&[("path", p_str("Project-relative directory path (default: '.')"))], &[]),
            plan_phase: true,
            permission: perm_file(FileAction::Read, Some(".")),
            execute: exec_list_directory,
        },
        Tool {
            name: "read_file",
            description: "Read a file inside the project. Returns numbered lines; truncated beyond 2000 lines or 200KB.",
            schema: schema(
                &[
                    ("path", p_str("Project-relative file path")),
                    ("offset", p_num("1-based starting line")),
                    ("limit", p_num("Max lines to return")),
                ],
                &["path"],
            ),
            plan_phase: true,
            permission: perm_file(FileAction::Read, None),
            execute: exec_read_file,
        },
        Tool {
            name: "write_file",
            description: "Create or overwrite a file inside the project. Parent directories are created.",
            schema: schema(
                &[("path", p_str("Project-relative file path")), ("content", p_str("Full file contents"))],
                &["path", "content"],
            ),
            plan_phase: false,
            permission: perm_file(FileAction::Write, None),
            execute: exec_write_file,
        },
        Tool {
            name: "edit_file",
            description: "Replace exact text in a file. old_string must match exactly once unless replace_all is true; matching tolerates leading/trailing whitespace per line. Pass edits[] for multiple replacements in one call.",
            schema: json!({
                "type": "object",
                "properties": {
                    "path": p_str("Project-relative file path"),
                    "old_string": p_str("Exact text to replace"),
                    "new_string": p_str("Replacement text"),
                    "edits": json!({
                        "type": "array",
                        "description": "Multiple replacements applied in order; alternative to old_string/new_string",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": p_str("Exact text to replace"),
                                "new_string": p_str("Replacement text"),
                            },
                            "required": ["old_string", "new_string"],
                        },
                    }),
                    "replace_all": p_bool("Replace all occurrences (default false)"),
                },
                "required": ["path"],
            }),
            plan_phase: false,
            permission: perm_file(FileAction::Write, None),
            execute: exec_edit_file,
        },
        Tool {
            name: "delete_file",
            description: "Delete a file or empty directory inside the project. Always requires approval.",
            schema: schema(&[("path", p_str("Project-relative path"))], &["path"]),
            plan_phase: false,
            permission: perm_file(FileAction::Delete, None),
            execute: exec_delete_file,
        },
        Tool {
            name: "search_files",
            description: "Search file contents in the project with a regex. Returns `path:line: text` matches (max 100). Protected files are skipped.",
            schema: schema(
                &[
                    ("pattern", p_str("Regular expression to search for")),
                    ("path", p_str("Subdirectory to search (default: project root)")),
                    ("glob", p_str("Optional filename filter like '*.ts'")),
                    ("case_insensitive", p_bool("Case-insensitive match (default false)")),
                ],
                &["pattern"],
            ),
            plan_phase: true,
            permission: perm_file(FileAction::Read, Some(".")),
            execute: exec_search_files,
        },
        Tool {
            name: "run_command",
            description: "Run a shell command inside the project directory. Output is captured and truncated to 64KB. Commands are permission-checked; unrecognized commands require approval.",
            schema: schema(
                &[
                    ("command", p_str("Shell command to run (cwd = project root)")),
                    ("timeout_ms", p_num("Timeout in ms (default 120000, max 600000)")),
                    ("reason", p_str("Why this command is needed (shown at approval prompts)")),
                ],
                &["command"],
            ),
            plan_phase: false,
            permission: perm_command,
            execute: exec_run_command,
        },
        Tool {
            name: "run_background",
            description: "Start a long-running shell command (dev server, watcher, build) in the background and keep working. Output goes to a log file; check it later with check_process, stop it with kill_process. Give each process a short name to reference it.",
            schema: schema(
                &[
                    ("command", p_str("Shell command to run (cwd = project root)")),
                    ("name", p_str("Short handle for this process (e.g. 'dev-server')")),
                    ("reason", p_str("Why this command is needed (shown at approval prompts)")),
                ],
                &["command", "name"],
            ),
            plan_phase: false,
            permission: perm_bg_command,
            execute: exec_run_background,
        },
        Tool {
            name: "check_process",
            description: "Check a background process started with run_background: whether it's still running and its recent output. Omit `name` to list all background processes.",
            schema: schema(
                &[("name", p_str("Process name from run_background")), ("tail_lines", p_num("Log lines to return (default 60)"))],
                &[],
            ),
            plan_phase: false,
            permission: perm_safe,
            execute: exec_check_process,
        },
        Tool {
            name: "kill_process",
            description: "Stop a background process started with run_background (SIGTERM, process group).",
            schema: schema(&[("name", p_str("Process name from run_background"))], &["name"]),
            plan_phase: false,
            permission: perm_approval,
            execute: exec_kill_process,
        },
        Tool {
            name: "remember",
            description: "Append a durable one-line note to this project's memory (.dxxpcode/memory.md) — every future session reads it. Call when you learn something that will still be true later: project conventions, commands that worked, decisions made. Never store secrets, task state, file contents, or anything already in the project instructions.",
            schema: schema(&[("text", p_str("One-line fact worth keeping across sessions"))], &["text"]),
            plan_phase: true,
            permission: perm_safe,
            execute: exec_remember,
        },
        Tool {
            name: "git_status",
            description: "Show git status (branch + working tree changes) for the project.",
            schema: schema(&[], &[]),
            plan_phase: true,
            permission: perm_safe,
            execute: exec_git_status,
        },
        Tool {
            name: "git_diff",
            description: "Show the working-tree diff (optionally for a path). Includes unstaged changes.",
            schema: schema(
                &[("path", p_str("Optional project-relative path to diff")), ("staged", p_bool("Show staged diff instead (default false)"))],
                &[],
            ),
            plan_phase: true,
            permission: perm_safe,
            execute: exec_git_diff,
        },
        Tool {
            name: "browse",
            description: "Control a headless browser (headless Chrome): open pages, read an accessibility snapshot of interactive elements (refs like 'e3'), click, type, take screenshots, and read the console log. Use to verify web UIs you build — start the dev server with run_background, then navigate to its localhost URL. Reads are permission-free; external navigation and page interactions ask first.",
            schema: schema(
                &[
                    ("action", p_str("navigate | snapshot | click | type | wait | console | screenshot | evaluate")),
                    ("url", p_str("URL for navigate (localhost allowed freely; external hosts need approval)")),
                    ("ref", p_str("Element ref from snapshot output, e.g. 'e3'")),
                    ("text", p_str("Text for type")),
                    ("submit", p_bool("Press Enter after typing")),
                    ("selector", p_str("CSS selector — scopes snapshot, or the element to wait for")),
                    ("ms", p_num("Milliseconds for wait (default 1000, max 30000)")),
                    ("max_nodes", p_num("Max snapshot lines (default 150)")),
                    ("expression", p_str("JS expression for evaluate")),
                ],
                &["action"],
            ),
            plan_phase: false,
            permission: perm_browse,
            execute: exec_browse,
        },
        Tool {
            name: "git_log",
            description: "Show recent commit history (oneline, max 30).",
            schema: schema(&[("limit", p_num("Max commits (default 15, max 30)"))], &[]),
            plan_phase: true,
            permission: perm_safe,
            execute: exec_git_log,
        },
    ];
    // Enabled custom tools — dispatch and permission are intercepted by
    // name in the agent loop (custom_spec/perm_custom/exec_custom), so
    // these entries use inert placeholders.
    for spec in custom_tools(root).into_iter().filter(|s| s.enabled) {
        tools.push(Tool {
            name: Box::leak(spec.name.clone().into_boxed_str()),
            description: Box::leak(spec.description.clone().into_boxed_str()),
            schema: custom_schema(&spec),
            plan_phase: false,
            permission: perm_safe,
            execute: exec_noop,
        });
    }
    tools
}

pub fn find_tool<'a>(tools: &'a [Tool], name: &str) -> Option<&'a Tool> {
    tools.iter().find(|t| t.name == name)
}

pub fn tools_for_phase<'a>(tools: &'a [Tool], phase: &str) -> Vec<&'a Tool> {
    match phase {
        "plan" => tools.iter().filter(|t| t.plan_phase).collect(),
        // Chat mode: the read-only plan-phase set minus propose_plan —
        // enforced here so the model can never reach a mutating tool.
        "chat" => tools
            .iter()
            .filter(|t| t.plan_phase && t.name != "propose_plan")
            .collect(),
        _ => tools.iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(old: &str, new: &str) -> Edit {
        Edit {
            old: old.into(),
            new: new.into(),
        }
    }

    #[test]
    fn exact_and_unique() {
        let raw = "a\nb\nc\n";
        assert_eq!(
            apply_edits(raw, &[e("b", "B")], false, "f").unwrap().0,
            "a\nB\nc\n"
        );
        let err = apply_edits("x x", &[e("x", "y")], false, "f").unwrap_err();
        assert!(err.contains("2 times"));
        assert_eq!(
            apply_edits("x x", &[e("x", "y")], true, "f").unwrap().0,
            "y y"
        );
    }

    #[test]
    fn whitespace_tolerant() {
        // old carries the wrong indent (tab vs spaces) — no exact hit, tolerant
        // match replaces the whole line region with new_string verbatim.
        let raw = "fn f() {\n    let x = 1;\n}\n";
        let (out, tol) =
            apply_edits(raw, &[e("\tlet x = 1;", "\tlet x = 2;")], false, "f").unwrap();
        assert!(tol);
        assert!(out.contains("let x = 2;"));
    }

    #[test]
    fn miss_shows_closest() {
        let raw = "alpha\nbeta\ngamma\n";
        let err = apply_edits(raw, &[e("beta\nomitted", "z")], false, "f").unwrap_err();
        assert!(err.contains("closest match at line"), "{err}");
    }

    #[test]
    fn batch_applies_in_order() {
        let raw = "one\ntwo\nthree\n";
        let (out, _) = apply_edits(raw, &[e("one", "1"), e("three", "3")], false, "f").unwrap();
        assert_eq!(out, "1\ntwo\n3\n");
        let err = apply_edits(raw, &[e("one", "1"), e("missing", "x")], false, "f").unwrap_err();
        assert!(err.starts_with("edit 2:"), "{err}");
    }

    #[test]
    fn remember_appends() {
        let dir = std::env::temp_dir().join(format!("dxxp-mem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ctx = Ctx {
            root: dir.to_string_lossy().to_string(),
            aborted: Default::default(),
            procs: Default::default(),
            live_out: Default::default(),
            browser: Default::default(),
        };
        let r = exec_remember(&json!({ "text": "tests run via make check" }), &ctx);
        assert!(!r.is_error, "{}", r.content);
        let mem = fs::read_to_string(dir.join(".dxxpcode/memory.md")).unwrap();
        assert!(mem.contains("## Notes"), "{mem}");
        assert!(mem.contains("- tests run via make check"), "{mem}");
        let r2 = exec_remember(&json!({ "text": "use pnpm" }), &ctx);
        assert!(!r2.is_error);
        let mem = fs::read_to_string(dir.join(".dxxpcode/memory.md")).unwrap();
        assert_eq!(mem.matches("## Notes").count(), 1, "{mem}");
        assert!(mem.contains("- use pnpm"), "{mem}");
        let _ = fs::remove_dir_all(&dir);
    }
}

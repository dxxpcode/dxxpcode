//! Tool registry — port of packages/tools.

mod browse;
mod custom;
mod files;
mod git;
mod proc;

use browse::*;
pub use custom::*;
use files::*;
use git::*;
use proc::*;

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

pub(super) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(super) fn pid_alive(pid: u32) -> bool {
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

pub(super) fn procs_file(root: &str) -> PathBuf {
    Path::new(root).join(".dxxpcode").join("procs.json")
}

pub(super) fn save_procs(root: &str, procs: &HashMap<String, BgProc>) {
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

pub(super) fn o(pairs: &[(&str, Value)]) -> Value {
    json!(Map::from_iter(
        pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone()))
    ))
}

pub(super) fn schema(props: &[(&str, Value)], required: &[&str]) -> Value {
    let mut obj = o(&[("type", json!("object"))]);
    let map = Map::from_iter(props.iter().map(|(k, v)| ((*k).to_string(), v.clone())));
    obj["properties"] = Value::Object(map);
    if !required.is_empty() {
        obj["required"] = json!(required);
    }
    obj
}

pub(super) fn p_str(desc: &str) -> Value {
    json!({"type": "string", "description": desc})
}
pub(super) fn p_num(desc: &str) -> Value {
    json!({"type": "number", "description": desc})
}
pub(super) fn p_bool(desc: &str) -> Value {
    json!({"type": "boolean", "description": desc})
}

/* ------------------------------- file tools ------------------------------ */

const MAX_READ_LINES: usize = 2000;
const MAX_READ_BYTES: u64 = 200 * 1024;

pub(super) fn rel(ctx: &Ctx, path: &str) -> Option<String> {
    resolve_within_root(&ctx.root, path)
}

pub(super) fn escape_result(path: &str) -> ToolResult {
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
    fn whitespace_tolerant_crlf() {
        // CRLF file: tolerant match must splice at real byte offsets —
        // line.len()+1 undercounts by one per line and would corrupt text.
        let raw = "fn f() {\r\n    let x = 1;\r\n    let y = 2;\r\n}\r\n";
        let (out, tol) =
            apply_edits(raw, &[e("\tlet x = 1;", "    let x = 9;")], false, "f").unwrap();
        assert!(tol);
        assert_eq!(out, "fn f() {\r\n    let x = 9;\r\n    let y = 2;\r\n}\r\n");
        // Multi-line match mid-file keeps surrounding CRLF lines intact.
        let (out, _) = apply_edits(
            raw,
            &[e(
                "let x = 1;\nlet y = 2;",
                "    let x = 8;\r\n    let y = 3;",
            )],
            false,
            "f",
        )
        .unwrap();
        assert_eq!(out, "fn f() {\r\n    let x = 8;\r\n    let y = 3;\r\n}\r\n");
    }

    #[test]
    fn whitespace_tolerant_no_trailing_newline() {
        let raw = "a\nlast line";
        let (out, tol) = apply_edits(raw, &[e("  last line", "LAST")], false, "f").unwrap();
        assert!(tol);
        assert_eq!(out, "a\nLAST");
    }

    #[test]
    fn read_file_huge_offset_no_panic() {
        let dir = std::env::temp_dir().join(format!("dxxp-read-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("f.txt"), "one\ntwo\nthree\n").unwrap();
        let ctx = Ctx {
            root: dir.to_string_lossy().to_string(),
            aborted: Default::default(),
            procs: Default::default(),
            live_out: Default::default(),
            browser: Default::default(),
        };
        // A pathological offset saturates the f64→usize cast to usize::MAX;
        // the old `offset - 1 + limit` then overflowed and panicked.
        let r = exec_read_file(&json!({"path": "f.txt", "offset": 1e300}), &ctx);
        assert!(!r.is_error, "{}", r.content);
        assert!(!r.content.contains("one"), "{}", r.content);
        let _ = fs::remove_dir_all(&dir);
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

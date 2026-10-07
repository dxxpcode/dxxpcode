//! Agent runtime — port of packages/agent (runtime + checkpoint + compact).

use crate::config::{home_dir, new_session_id, save_session, Message, SessionRecord};
use crate::perm::Level;
use crate::project::gather_context;
use crate::provider::{Provider, ProviderError, ProviderEvent, Usage};
use crate::tools::{self, Ctx, ToolResult};
use crate::util::redact_secrets;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_MAX_ITERATIONS: u32 = 40;

/* ------------------------------ auto-verify ------------------------------ */

const VERIFY_MAX_ATTEMPTS: u32 = 2;
const VERIFY_OUTPUT_CAP: usize = 8000;

/// The repo's self-check command: npm test when package.json defines a real
/// test script, else cargo test for Rust projects.
fn detect_verify_cmd(root: &str) -> Option<String> {
    let pkg = Path::new(root).join("package.json");
    if let Ok(s) = fs::read_to_string(&pkg) {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            let real_test = v
                .get("scripts")
                .and_then(|x| x.get("test"))
                .and_then(|t| t.as_str())
                .map(|t| !t.is_empty() && !t.contains("no test specified"))
                .unwrap_or(false);
            if real_test {
                return Some("npm test".to_string());
            }
        }
    }
    if Path::new(root).join("Cargo.toml").exists() {
        return Some("cargo test".to_string());
    }
    None
}

/// Run `command` in the project root; returns (passed, tail of combined output).
/// The 300s cap is enforced in-process — `timeout(1)` is GNU coreutils and
/// does not exist on stock macOS, so wrapping the shell command made every
/// verify attempt "fail" on the platform we ship for.
fn run_verify(root: &str, command: &str) -> (bool, String) {
    let mut cmd = if cfg!(unix) {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", command]);
        c
    } else {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    };
    cmd.current_dir(root)
        .env("CI", "1")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
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
        Err(e) => return (false, format!("failed to start verify command: {e}")),
    };
    let pid = child.id();
    // Drain pipes concurrently — a verify command that fills the pipe buffer
    // would otherwise block writing and only the deadline would free it.
    let out = Arc::new(Mutex::new(String::new()));
    let mut readers = vec![];
    let mut pipes: Vec<Box<dyn Read + Send>> = vec![];
    if let Some(p) = child.stdout.take() {
        pipes.push(Box::new(p));
    }
    if let Some(p) = child.stderr.take() {
        pipes.push(Box::new(p));
    }
    for pipe in pipes {
        let out = Arc::clone(&out);
        readers.push(std::thread::spawn(move || {
            let mut p = pipe;
            let mut buf = [0u8; 8192];
            while let Ok(n) = p.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }));
    }
    let start = Instant::now();
    let deadline = Duration::from_secs(300);
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) if start.elapsed() > deadline => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                #[cfg(not(unix))]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F", "/T"])
                        .output();
                }
                let _ = child.wait();
                break true;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break false,
        }
    };
    for r in readers {
        let _ = r.join();
    }
    let mut text = out.lock().unwrap().clone();
    if timed_out {
        text.push_str("\n(verify timed out after 300s)");
    }
    if text.len() > VERIFY_OUTPUT_CAP {
        text = text[text.len() - VERIFY_OUTPUT_CAP..].to_string();
    }
    let status_ok = child
        .try_wait()
        .ok()
        .flatten()
        .map(|s| s.success())
        .unwrap_or(false);
    (status_ok && !timed_out, text)
}

/* ------------------------------ blind review ------------------------------ */

const REVIEW_DIFF_CAP: usize = 60_000;
const REVIEW_MAX_ATTEMPTS: u32 = 1;
const DONE_CHECK_MAX_ATTEMPTS: u32 = 1;

/// A blind end-of-run review: the reviewer gets only the diff (plus the
/// contents of newly created files) in a fresh context — never the chat
/// history or the reasoning that produced the changes. Returns the
/// review text, or Err when the review itself couldn't run.
fn review_changes(
    provider: &mut Provider,
    model: &str,
    root: &str,
    files: &[String],
    aborted: &Arc<AtomicBool>,
) -> Result<String, String> {
    let mut body = String::new();
    for args in [
        vec!["diff", "--"],             // unstaged
        vec!["diff", "--cached", "--"], // staged
    ] {
        let mut argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        argv.extend(files.iter().cloned());
        body.push_str(&crate::util::git_stdout(
            root,
            &argv.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
    }
    // New untracked files never appear in `git diff` — inline them.
    let untracked = crate::util::git_stdout(root, &["ls-files", "--others", "--exclude-standard"]);
    for f in files {
        if untracked.lines().any(|u| u == f) {
            if let Ok(s) = fs::read_to_string(Path::new(root).join(f)) {
                body.push_str(&format!("\n--- new file: {f} ---\n{s}"));
            }
        }
    }
    let mut body = body.trim().to_string();
    if body.is_empty() {
        return Ok("CLEAN".into());
    }
    if body.len() > REVIEW_DIFF_CAP {
        body.truncate(REVIEW_DIFF_CAP);
        body.push_str("\n…(diff truncated)…");
    }
    let msgs = vec![Message {
        role: "user".into(),
        content: vec![text_block(&format!(
            "You are reviewing another agent's code changes. You see ONLY the diff — not the \
             reasoning that produced it.\n\
             Report only concrete defects: correctness bugs, regressions, security holes, broken \
             error handling. No style feedback, no nits, no praise.\n\
             If there is nothing real, reply with exactly: CLEAN\n\
             Otherwise reply with a numbered list of findings, each `file:line — one sentence`.\n\n\
             Diff:\n{body}"
        ))],
    }];
    let mut out = String::new();
    let res = provider.chat(
        "You are a senior engineer doing a strict code review.",
        &msgs,
        &[],
        model,
        Some("low"),
        None,
        aborted,
        |ev| {
            if let ProviderEvent::Text(t) = ev {
                out.push_str(&t);
            }
        },
    );
    res.map(|_| out).map_err(|e| e.to_string())
}

/* ------------------------------ checkpoints ------------------------------ */

const MAX_CHECKPOINTS: i64 = 30;
const CHECKPOINTED_TOOLS: &[&str] = &["write_file", "edit_file", "delete_file"];

fn checkpoints_dir(session_id: &str) -> PathBuf {
    home_dir().join("checkpoints").join(session_id)
}

fn list_seqs(dir: &Path) -> Vec<i64> {
    let mut v: Vec<i64> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_string_lossy().parse::<i64>().ok())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn current_head(root: &str) -> Option<String> {
    crate::util::git_stdout_ok(root, &["rev-parse", "HEAD"]).filter(|s| !s.is_empty())
}

/// Snapshot project-relative paths before mutation; returns (seq, paths).
pub fn take_checkpoint(
    root: &str,
    paths: &[String],
    session_id: &str,
) -> Option<(i64, Vec<String>)> {
    let dir = checkpoints_dir(session_id);
    let seq = list_seqs(&dir).last().copied().unwrap_or(0) + 1;
    let cp_dir = dir.join(seq.to_string());
    let _ = fs::create_dir_all(&cp_dir);
    let root_abs = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    let mut files = vec![];
    let mut n = 0;
    for p in paths {
        let abs = PathBuf::from(root).join(p);
        let abs_c = fs::canonicalize(&abs).unwrap_or(abs.clone());
        if !abs_c.starts_with(&root_abs) && !abs.starts_with(&root_abs) {
            continue;
        }
        let existed = abs.exists();
        let mut entry = json!({"path": p, "existed": existed});
        if existed {
            let blob = format!("blob-{n}");
            // A read/write failure must not record an empty blob — undo
            // would then overwrite the file with nothing. Mark it so
            // undo can report the file as unrestorable.
            let snapshotted = fs::read(&abs)
                .ok()
                .and_then(|data| fs::write(cp_dir.join(&blob), data).ok())
                .is_some();
            entry[if snapshotted {
                "blob"
            } else {
                "snapshotFailed"
            }] = if snapshotted {
                json!(blob)
            } else {
                json!(true)
            };
        }
        files.push(entry);
        n += 1;
    }
    if files.is_empty() {
        let _ = fs::remove_dir_all(&cp_dir);
        return None;
    }
    let mut info = json!({"seq": seq, "at": iso_now(), "files": files});
    if let Some(head) = current_head(root) {
        info["headSha"] = json!(head);
    }
    let _ = fs::write(
        cp_dir.join("manifest.json"),
        serde_json::to_string_pretty(&info).unwrap() + "\n",
    );
    let seqs = list_seqs(&dir);
    for old in &seqs[..seqs.len().saturating_sub(MAX_CHECKPOINTS as usize)] {
        let _ = fs::remove_dir_all(dir.join(old.to_string()));
    }
    let paths_out: Vec<String> = info["files"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| f.get("path").and_then(|p| p.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some((seq, paths_out))
}

/// Restore the most recent checkpoint. Returns the note text or None.
pub fn undo_checkpoint(root: &str, session_id: &str) -> Option<Value> {
    let dir = checkpoints_dir(session_id);
    let seqs = list_seqs(&dir);
    let seq = *seqs.last()?;
    let cp_dir = dir.join(seq.to_string());
    let info: Value = fs::read_to_string(cp_dir.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    if info.get("files").is_none() {
        let _ = fs::remove_dir_all(&cp_dir);
        return None;
    }
    let mut restored = vec![];
    let mut removed = vec![];
    let mut unsnapshotted = vec![];
    for f in info["files"].as_array().unwrap() {
        let Some(p) = f.get("path").and_then(|v| v.as_str()) else {
            continue;
        };
        let abs = PathBuf::from(root).join(p);
        if !abs.starts_with(root) {
            continue;
        }
        if f.get("existed").and_then(|v| v.as_bool()) == Some(true) {
            match f.get("blob").and_then(|v| v.as_str()) {
                Some(blob) => {
                    if let Ok(data) = fs::read(cp_dir.join(blob)) {
                        if let Some(parent) = abs.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        if fs::write(&abs, data).is_ok() {
                            restored.push(p.to_string());
                        }
                    }
                }
                // Existed but never snapshotted — leave the file alone and
                // report it instead of silently skipping the restore.
                None => unsnapshotted.push(p.to_string()),
            }
        } else if abs.exists() && fs::remove_file(&abs).is_ok() {
            removed.push(p.to_string());
        }
    }
    let _ = fs::remove_dir_all(&cp_dir);
    let mut out = json!({"seq": seq, "restored": restored, "removed": removed});
    if !unsnapshotted.is_empty() {
        out["unsnapshotted"] = json!(unsnapshotted);
    }
    if let (Some(old), Some(head)) = (
        info.get("headSha").and_then(|v| v.as_str()),
        current_head(root),
    ) {
        if head != old {
            out["headMoved"] = json!({"from": old, "to": head});
        }
    }
    Some(out)
}

fn iso_now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/* ------------------------------ compaction ------------------------------- */

const CHARS_PER_TOKEN: usize = 4;

/// Serialized length of a JSON value without materializing it — for
/// tool_use inputs, whose `to_string()` would allocate a fresh copy on
/// every estimate call (several times per turn over the full history).
/// Escape inflation (\n → 2 serialized chars) is skipped; the estimate
/// stays within a few percent, which is all the heuristic needs.
fn json_len(v: &Value) -> usize {
    match v {
        Value::Object(m) => {
            2 + m
                .iter()
                .map(|(k, x)| k.len() + 3 + json_len(x))
                .sum::<usize>()
                + m.len().saturating_sub(1)
        }
        Value::Array(a) => 2 + a.iter().map(json_len).sum::<usize>() + a.len().saturating_sub(1),
        Value::String(s) => s.len() + 2,
        Value::Null => 4,
        other => other.to_string().len(),
    }
}

pub fn estimate_tokens(messages: &[Message]) -> usize {
    let mut chars = 0;
    for m in messages {
        for b in &m.content {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("tool_result") => {
                    chars += b
                        .get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .len()
                }
                Some("tool_use") => {
                    chars += b.get("input").map(json_len).unwrap_or(0);
                    chars += b.get("name").and_then(|n| n.as_str()).unwrap_or("").len();
                }
                _ => chars += b.get("text").and_then(|t| t.as_str()).unwrap_or("").len(),
            }
        }
    }
    chars.div_ceil(CHARS_PER_TOKEN)
}

fn preview_lines(content: &str, lines: usize) -> Option<String> {
    let all: Vec<&str> = content.split('\n').collect();
    let keep = lines * 2;
    if all.len() <= keep + 8 {
        return None;
    }
    let omitted = all.len() - keep;
    Some(format!(
        "{}\n… ({} lines omitted — re-run the tool if you need this output again)\n{}",
        all[..lines].join("\n"),
        omitted,
        all[all.len() - lines..].join("\n")
    ))
}

/// Returns Some((before, after, blocks)) when compaction happened.
/// `before_hint` is the caller's current estimate — callers measure the
/// history once per loop iteration and pass it here instead of having
/// this function re-walk every message.
pub fn compact_messages(
    messages: &mut [Message],
    max_tokens: usize,
    force: bool,
    before_hint: Option<usize>,
) -> Option<(usize, usize, usize)> {
    let before = before_hint.unwrap_or_else(|| estimate_tokens(messages));
    if !force && before <= max_tokens {
        return None;
    }
    let cutoff = messages.len().saturating_sub(8);
    let mut blocks = 0usize;
    for m in messages.iter_mut().take(cutoff) {
        for b in m.content.iter_mut() {
            if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            let content = b
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(next) = preview_lines(&content, 20) {
                b["content"] = json!(next);
                blocks += 1;
            }
        }
    }
    (blocks > 0).then(|| (before, estimate_tokens(messages), blocks))
}

/* ------------------------------- runtime --------------------------------- */

/// One outbound agent event — serialized verbatim onto the wire.
pub type Emit<'a> = dyn FnMut(Value) + Send + 'a;

pub struct RunOpts<'a> {
    pub task: String,
    pub provider: &'a mut Provider,
    pub model: String,
    pub project_root: String,
    pub plan_only: bool,
    pub max_iterations: Option<u32>,
    pub approve_plan: &'a mut dyn FnMut(&Value) -> bool,
    pub approve_tool: &'a mut dyn FnMut(&str, &Value, &str, Option<&str>) -> bool,
    /// Pre-write diff review for write-family tools: (tool, input, unified
    /// diff) -> apply?. Called before every write/edit/delete; return false to
    /// discard the change.
    pub review_change: &'a mut dyn FnMut(&str, &Value, &str) -> bool,
    pub session: Option<SessionRecord>,
    /// Chat mode: read-only toolset, no plan/approval phase.
    pub chat: bool,
    pub effort: Option<String>,
    /// Active model-variant option bag — extra request-body fields each
    /// provider picks the keys it understands.
    pub variant_opts: Option<Value>,
    pub aborted: Arc<AtomicBool>,
    pub steer: &'a mut dyn FnMut() -> Option<String>,
    pub procs: tools::CtxProcTable,
}

fn git_diff_stat(root: &str) -> Option<String> {
    let diff = crate::util::git_stdout(root, &["diff", "--stat"])
        .trim()
        .to_string();
    let untracked = crate::util::git_stdout(root, &["ls-files", "--others", "--exclude-standard"])
        .trim()
        .to_string();
    let mut parts = vec![];
    if !diff.is_empty() {
        parts.push(diff);
    }
    if !untracked.is_empty() {
        parts.push(format!("untracked: {} file(s)", untracked.lines().count()));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn last_assistant_text(messages: &[Message]) -> String {
    for m in messages.iter().rev() {
        if m.role == "assistant" {
            let text: String = m
                .content
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    String::new()
}

fn text_block(text: &str) -> Value {
    json!({"type": "text", "text": text})
}

fn tool_result_block(id: &str, content: &str, is_error: bool) -> Value {
    json!({"type": "tool_result", "toolUseId": id, "content": content, "isError": is_error})
}

/// Tool result with optional image blocks — providers that can't view images
/// keep only the text in `tool_result_block` (the images' path is in it).
fn tool_result_block_rich(id: &str, r: &tools::ToolResult, images: bool) -> Value {
    let mut b = tool_result_block(id, &r.content, r.is_error);
    if images && !r.images.is_empty() {
        b["images"] = json!(r
            .images
            .iter()
            .map(|i| json!({"mediaType": i.media_type, "data": i.data_base64}))
            .collect::<Vec<_>>());
    }
    b
}

fn tool_use_block(id: &str, name: &str, input: &Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

fn parse_plan(input: &Value) -> Value {
    let steps: Vec<String> = input
        .get("steps")
        .and_then(|s| s.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    json!({
        "summary": input.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
        "steps": steps,
        "trivial": input.get("trivial").and_then(|v| v.as_bool()) == Some(true),
    })
}

fn parse_todos(input: &Value) -> Result<Vec<Value>, String> {
    let Some(arr) = input.get("todos").and_then(|t| t.as_array()) else {
        return Err("missing or invalid \"todos\"".into());
    };
    let mut items = vec![];
    for raw in arr {
        let Some(it) = raw.as_object() else { continue };
        let Some(content) = it.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        if content.is_empty() {
            continue;
        }
        let status = match it.get("status").and_then(|v| v.as_str()) {
            Some("in_progress") => "in_progress",
            Some("completed") => "completed",
            _ => "pending",
        };
        let mut item = json!({
            "id": it.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                .map(String::from).unwrap_or_else(|| format!("item-{}", items.len() + 1)),
            "content": content,
            "status": status,
        });
        if let Some(af) = it
            .get("activeForm")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            item["activeForm"] = json!(af);
        }
        items.push(item);
    }
    Ok(items)
}

/// Mirrors the checklist to `.dxxpcode/todo.md` so it survives the session.
fn persist_todos_file(root: &str, items: &[Value]) {
    let dir = Path::new(root).join(".dxxpcode");
    let md = format!(
        "# TODO\n\n{}\n",
        items
            .iter()
            .map(|it| {
                let boxx = if it.get("status").and_then(|s| s.as_str()) == Some("completed") {
                    "[x]"
                } else {
                    "[ ]"
                };
                format!(
                    "- {} {}",
                    boxx,
                    it.get("content").and_then(|c| c.as_str()).unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    );
    let _ = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join("todo.md"), md));
}

fn render_todos(items: &[Value]) -> String {
    if items.is_empty() {
        return "checklist cleared".into();
    }
    items
        .iter()
        .map(|it| {
            let boxx = match it.get("status").and_then(|s| s.as_str()) {
                Some("completed") => "[x]",
                Some("in_progress") => "[>]",
                _ => "[ ]",
            };
            format!(
                "{} {}",
                boxx,
                it.get("content").and_then(|c| c.as_str()).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn repair_tail(messages: &mut Vec<Message>) {
    let Some(last) = messages.last() else { return };
    if last.role != "assistant" {
        return;
    }
    let dangling: Vec<String> = last
        .content
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .filter_map(|b| b.get("id").and_then(|i| i.as_str()).map(String::from))
        .collect();
    if dangling.is_empty() {
        return;
    }
    messages.push(Message {
        role: "user".into(),
        content: dangling
            .iter()
            .map(|id| tool_result_block(id, "interrupted before execution", true))
            .collect(),
    });
}

fn finish(result: Value, usage: &Usage, session: &mut SessionRecord) -> Value {
    let mut r = result;
    r["usage"] = usage.to_json();
    session.result = r.get("summary").and_then(|s| s.as_str()).map(String::from);
    session.updated_at = iso_now();
    save_session(session);
    json!({"type": "done", "result": r})
}

struct Stats {
    tool_calls: usize,
}

fn recorded(call_name: &str, input: &Value, is_error: bool, denied: bool) -> Value {
    json!({"name": call_name, "input": input, "isError": is_error, "denied": denied})
}

/// One tool call in the plan phase (read-only tools only).
fn run_plan_tool(
    call: &(String, String, Value),
    tools: &[tools::Tool],
    ctx: &Ctx,
    session: &mut SessionRecord,
    stats: &mut Stats,
    emit: &mut Emit<'_>,
) -> Value {
    let (id, name, input) = call;
    let Some(tool) = tools::find_tool(tools, name) else {
        emit(json!({"type": "denied", "tool": name, "reason": "not available while planning"}));
        return tool_result_block(
            id,
            &format!("tool not available while planning: {name}"),
            true,
        );
    };
    if !tool.plan_phase {
        emit(json!({"type": "denied", "tool": name, "reason": "not available while planning"}));
        return tool_result_block(
            id,
            &format!("tool not available while planning: {name}"),
            true,
        );
    }
    stats.tool_calls += 1;
    let decision = (tool.permission)(input, &ctx.root);
    if decision.level != Level::Safe {
        session.tool_calls.push(recorded(name, input, true, true));
        emit(json!({"type": "denied", "tool": name, "reason": decision.reason}));
        return tool_result_block(id, &format!("denied: {}", decision.reason), true);
    }
    emit(json!({"type": "tool_start", "tool": name, "input": input}));
    let result = exec_streaming(tool, name, input, ctx, emit);
    session
        .tool_calls
        .push(json!({"name": name, "input": input, "isError": result.is_error}));
    emit(json!({"type": "tool_end", "tool": name, "result": tool_result_json(&result)}));
    tool_result_block(id, &result.content, result.is_error)
}

/// Run a tool while streaming its live output to the UI as `tool_delta`
/// events — a scoped drainer thread forwards `ctx.live_out` while the
/// (blocking) `tool.execute` runs on this thread.
fn exec_streaming(
    tool: &tools::Tool,
    name: &str,
    input: &Value,
    ctx: &Ctx,
    emit: &mut Emit<'_>,
) -> ToolResult {
    let live = Arc::new(Mutex::new(String::new()));
    let stop = Arc::new(AtomicBool::new(false));
    *ctx.live_out.lock().unwrap() = Some(Arc::clone(&live));
    let result = std::thread::scope(|s| {
        let drainer = s.spawn(|| {
            let mut sent = 0usize;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let chunk = {
                    let g = live.lock().unwrap();
                    if g.len() > sent {
                        let c = g[sent..].to_string();
                        sent = g.len();
                        Some(c)
                    } else {
                        None
                    }
                };
                if let Some(c) = chunk {
                    emit(json!({"type": "tool_delta", "tool": name, "text": c}));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
        });
        let r = match tools::custom_spec(&ctx.root, name) {
            Some(spec) => tools::exec_custom(&spec, input, ctx),
            None => (tool.execute)(input, ctx),
        };
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = drainer.join();
        r
    });
    *ctx.live_out.lock().unwrap() = None;
    result
}

fn tool_result_json(r: &ToolResult) -> Value {
    let mut v = json!({"content": r.content, "isError": r.is_error});
    if let Some(cf) = &r.changed_file {
        v["changedFile"] = json!(cf);
    }
    if let Some(d) = &r.diff {
        v["diff"] = json!(d);
    }
    v
}

/// Stream one provider turn: appends the assistant message to `messages`,
/// returns its tool calls and whether usage was reported.
fn stream_turn(
    provider: &mut Provider,
    model: &str,
    system: &str,
    messages: &mut Vec<Message>,
    phase: &str,
    effort: Option<&str>,
    provider_opts: Option<&Value>,
    aborted: &Arc<AtomicBool>,
    project_root: &str,
    emit: &mut Emit<'_>,
) -> Result<(Vec<(String, String, Value)>, Option<Usage>), ProviderError> {
    let all = tools::registry(project_root);
    let tool_defs: Vec<Value> = tools::tools_for_phase(&all, phase)
        .iter()
        .map(|t| json!({"name": t.name, "description": t.description, "inputSchema": t.schema}))
        .collect();

    let mut text_parts: Vec<String> = vec![];
    let mut tool_calls: Vec<(String, String, Value)> = vec![];
    let mut usage: Option<Usage> = None;
    let mut err: Option<ProviderError> = None;

    // Stall watchdog: while the provider call is open, a quiet stream
    // (no tokens/events for 15s+) surfaces a status line instead of
    // looking hung.
    let emit_cell = Mutex::new(&mut *emit);
    let last_ev = Arc::new(Mutex::new(Instant::now()));
    let wd_stop = Arc::new(AtomicBool::new(false));
    let res = std::thread::scope(|s| {
        let last_ev2 = Arc::clone(&last_ev);
        let wd_stop2 = Arc::clone(&wd_stop);
        let emit_cell = &emit_cell;
        s.spawn(move || {
            let mut n = 0u64;
            loop {
                std::thread::sleep(Duration::from_secs(2));
                if wd_stop2.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let quiet = last_ev2.lock().unwrap().elapsed().as_secs();
                while quiet >= 15 * (n + 1) {
                    n += 1;
                    (*emit_cell.lock().unwrap())(json!({
                        "type": "status",
                        "message": format!("Waiting on model — no output for {}s…", 15 * n),
                    }));
                }
            }
        });
        let res = provider.chat(
            system,
            messages,
            &tool_defs,
            model,
            effort,
            provider_opts,
            aborted,
            |ev| {
                *last_ev.lock().unwrap() = Instant::now();
                match ev {
                    ProviderEvent::Text(t) => {
                        text_parts.push(t.clone());
                        (*emit_cell.lock().unwrap())(json!({"type": "text", "text": t}));
                    }
                    ProviderEvent::Thinking(t) => {
                        (*emit_cell.lock().unwrap())(json!({"type": "think", "text": t}));
                    }
                    ProviderEvent::ToolUse { id, name, input } => {
                        tool_calls.push((id, name, input))
                    }
                    ProviderEvent::Done { usage: u, .. } => usage = u,
                    ProviderEvent::Status(m) => {
                        (*emit_cell.lock().unwrap())(json!({"type": "status", "message": m}));
                    }
                }
            },
        );
        wd_stop.store(true, std::sync::atomic::Ordering::Relaxed);
        res
    });
    if let Err(e) = res {
        err = Some(e);
    }
    if !text_parts.is_empty() || !tool_calls.is_empty() {
        let mut content = vec![];
        if !text_parts.is_empty() {
            content.push(text_block(&text_parts.join("")));
        }
        for (id, name, input) in &tool_calls {
            content.push(tool_use_block(id, name, input));
        }
        messages.push(Message {
            role: "assistant".into(),
            content,
        });
    }
    match err {
        Some(e) => Err(e),
        None => Ok((tool_calls, usage)),
    }
}

/// The agent run — mirrors runTask(). Emits AgentEvent-shaped JSON objects.
pub fn run_task(opts: &mut RunOpts, emit: &mut Emit<'_>) {
    let max_iterations = opts.max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let (_project, mut system) = gather_context(&opts.project_root);
    if opts.chat {
        system.push_str(
            "\n\nYou are in CHAT MODE — read-only. Answer questions about the codebase \
             using the read/search/git tools. You cannot modify files, run shell commands, \
             or make changes of any kind. If the user asks for a change, explain what you \
             would do and suggest switching to Code mode.",
        );
    }
    emit(json!({"type": "status", "message": "Inspecting project…"}));

    let tools = tools::registry(&opts.project_root);
    let supports_images = opts.provider.supports_images();
    let ctx = Ctx {
        root: opts.project_root.clone(),
        aborted: Arc::clone(&opts.aborted),
        procs: Arc::clone(&opts.procs),
        live_out: Arc::new(Mutex::new(None)),
        browser: Arc::new(Mutex::new(None)),
    };

    let mut session = opts.session.take().unwrap_or_else(|| SessionRecord {
        version: 1,
        id: new_session_id(&opts.project_root),
        project_root: opts.project_root.clone(),
        created_at: iso_now(),
        updated_at: iso_now(),
        task: opts.task.clone(),
        messages: vec![],
        tool_calls: vec![],
        files_changed: vec![],
        commands: vec![],
        todos: None,
        result: None,
        mode: None,
        title: None,
        pinned: false,
    });
    session.mode = Some(if opts.chat { "chat" } else { "code" }.to_string());

    let persist = |session: &mut SessionRecord| {
        session.updated_at = iso_now();
        save_session(session);
    };

    repair_tail(&mut session.messages);
    if !opts.task.is_empty() {
        if let Some(last) = session.messages.last_mut() {
            if last.role == "user" {
                last.content.push(text_block(&format!("\n\n{}", opts.task)));
            } else {
                session.messages.push(Message {
                    role: "user".into(),
                    content: vec![text_block(&opts.task)],
                });
            }
        } else {
            session.messages.push(Message {
                role: "user".into(),
                content: vec![text_block(&opts.task)],
            });
        }
    }

    let mut stats = Stats { tool_calls: 0 };
    let mut usage = Usage::default();
    let base = |status: &str, session: &SessionRecord, stats: &Stats| {
        json!({
            "status": status,
            "summary": "",
            "filesChanged": session.files_changed,
            "commands": session.commands,
            "toolCalls": stats.tool_calls,
            "sessionId": session.id,
        })
    };

    macro_rules! finish_emit {
        ($status:expr, $summary:expr) => {{
            let mut r = base($status, &session, &stats);
            r["summary"] = json!($summary);
            emit(finish(r, &usage, &mut session));
            return;
        }};
        ($status:expr, $summary:expr, $extra:expr) => {{
            let mut r = base($status, &session, &stats);
            r["summary"] = json!($summary);
            for (k, v) in ($extra as Vec<(&str, Value)>) {
                r[k] = v;
            }
            emit(finish(r, &usage, &mut session));
            return;
        }};
    }

    /* ------------------------------ PLAN PHASE ------------------------------ */
    // Chat mode skips plan/approval entirely — there is nothing to approve.
    let mut approved = opts.chat;
    let mut plan: Option<Value> = None;
    let mut iterations = 0u32;
    let mut done_checks = 0u32;

    while !approved {
        if opts.aborted.load(std::sync::atomic::Ordering::Relaxed) {
            finish_emit!("cancelled", "Cancelled");
        }
        if iterations >= max_iterations {
            finish_emit!("max_iterations", "Planning iteration limit reached");
        }
        iterations += 1;
        let ctx_tokens = estimate_tokens(&session.messages);
        if ctx_tokens > 60_000 {
            emit(json!({"type": "status", "message": "Compacting context…"}));
        }
        if let Some((before, after, blocks)) =
            compact_messages(&mut session.messages, 60_000, false, Some(ctx_tokens))
        {
            emit(json!({"type": "compacted", "before": before, "after": after, "blocks": blocks}));
        }
        let (calls, turn_usage) = match stream_turn(
            opts.provider,
            &opts.model,
            &system,
            &mut session.messages,
            "plan",
            opts.effort.as_deref(),
            opts.variant_opts.as_ref(),
            &opts.aborted,
            &opts.project_root,
            emit,
        ) {
            Ok(t) => t,
            Err(e) => {
                emit(crate::errors::event(&e.0, e.1, None));
                let mut r = base("error", &session, &stats);
                r["summary"] = json!("Failed");
                r["error"] = json!(e.0);
                emit(finish(r, &usage, &mut session));
                return;
            }
        };
        if let Some(u) = turn_usage {
            usage.input_tokens += u.input_tokens;
            usage.output_tokens += u.output_tokens;
        }
        emit(json!({"type": "usage", "usage": usage.to_json()}));

        let plan_call = calls.iter().find(|(_, n, _)| n == "propose_plan");
        if let Some(pc) = plan_call {
            let mut results = vec![];
            for call in &calls {
                if call == pc {
                    results.push(tool_result_block(&call.0, "plan presented to user", false));
                } else {
                    results.push(run_plan_tool(
                        call,
                        &tools,
                        &ctx,
                        &mut session,
                        &mut stats,
                        emit,
                    ));
                }
            }
            if !results.is_empty() {
                session.messages.push(Message {
                    role: "user".into(),
                    content: results,
                });
            }
            let p = parse_plan(&pc.2);
            plan = Some(p.clone());
            emit(json!({"type": "plan", "plan": p}));
            if p.get("trivial").and_then(|v| v.as_bool()) == Some(true) {
                approved = true;
            } else if opts.plan_only {
                let mut r = base("plan_only", &session, &stats);
                r["summary"] = p.get("summary").cloned().unwrap_or(json!(""));
                r["plan"] = p.clone();
                emit(finish(r, &usage, &mut session));
                return;
            } else if (opts.approve_plan)(&p) {
                approved = true;
            } else {
                let mut r = base("denied", &session, &stats);
                r["summary"] = json!("Plan not approved");
                r["plan"] = p.clone();
                emit(finish(r, &usage, &mut session));
                return;
            }
        } else if !calls.is_empty() {
            let mut results = vec![];
            for call in &calls {
                results.push(run_plan_tool(
                    call,
                    &tools,
                    &ctx,
                    &mut session,
                    &mut stats,
                    emit,
                ));
            }
            if !results.is_empty() {
                session.messages.push(Message {
                    role: "user".into(),
                    content: results,
                });
            }
        } else {
            let summary = last_assistant_text(&session.messages);
            // Done-gate: text-only finish during planning with no work
            // evidence gets one self-check, then an honest status.
            if !opts.chat
                && session.files_changed.is_empty()
                && !session.tool_calls.iter().any(|t| {
                    t.get("name").and_then(|n| n.as_str()) == Some("run_command")
                        && t.get("isError").and_then(|e| e.as_bool()) == Some(false)
                })
            {
                if summary.trim_start().starts_with("DECLINE:") {
                    let mut r = base("declined", &session, &stats);
                    r["summary"] =
                        json!(summary.trim_start()["DECLINE:".len()..].trim().to_string());
                    emit(finish(r, &usage, &mut session));
                    return;
                }
                if done_checks < DONE_CHECK_MAX_ATTEMPTS {
                    done_checks += 1;
                    emit(
                        json!({"type": "status", "message": "Nothing changed — checking completion…"}),
                    );
                    session.messages.push(Message {
                        role: "user".into(),
                        content: vec![text_block(
                            "The task is not done — nothing changed on disk and no plan was proposed. \
                             Either propose a plan with `propose_plan` now, or reply `DECLINE: <reason>` if the task is impossible, unclear, or already satisfied.",
                        )],
                    });
                    persist(&mut session);
                    continue;
                }
                let mut r = base("incomplete", &session, &stats);
                r["summary"] = json!(if summary.is_empty() {
                    "Finished with no changes".to_string()
                } else {
                    summary
                });
                emit(finish(r, &usage, &mut session));
                return;
            }
            finish_emit!(
                "completed",
                if summary.is_empty() {
                    "Done".to_string()
                } else {
                    summary
                }
            );
        }
    }

    iterations = 0;
    if opts.plan_only {
        let mut r = base("plan_only", &session, &stats);
        r["summary"] = plan
            .as_ref()
            .and_then(|p| p.get("summary").cloned())
            .unwrap_or(json!("Done"));
        if let Some(p) = &plan {
            r["plan"] = p.clone();
        }
        emit(finish(r, &usage, &mut session));
        return;
    }
    if plan.is_some() {
        session.messages.push(Message {
            role: "user".into(),
            content: vec![text_block("Plan approved. Execute it now.")],
        });
    }

    /* ----------------------------- EXECUTE PHASE ---------------------------- */
    let mut verified_upto = 0usize;
    let mut verify_attempts = 0u32;
    let mut review_attempts = 0u32;
    // (tool,args) -> (count, files_changed.len() at last call): repeated
    // identical calls with no file changes between them mean a stuck loop.
    let mut call_counts: HashMap<String, (u32, usize)> = HashMap::new();
    // read cache: args -> file mtime at read time. A re-read whose file
    // hasn't been touched (by anyone — mtime, not files_changed) returns a
    // cached note instead of re-executing, saving the round-trip.
    let mut read_cache: HashMap<String, u128> = HashMap::new();
    // Tool budget: past TOOL_BUDGET calls the model gets one quiet nudge to
    // work economically — most overruns are exploration loops, not work.
    const TOOL_BUDGET: usize = 40;
    let mut budget_warned = false;
    loop {
        if opts.aborted.load(std::sync::atomic::Ordering::Relaxed) {
            finish_emit!("cancelled", "Cancelled");
        }
        let ctx_tokens = estimate_tokens(&session.messages);
        if ctx_tokens > 60_000 {
            emit(json!({"type": "status", "message": "Compacting context…"}));
        }
        if let Some((before, after, blocks)) =
            compact_messages(&mut session.messages, 60_000, false, Some(ctx_tokens))
        {
            emit(json!({"type": "compacted", "before": before, "after": after, "blocks": blocks}));
        }
        let (calls, turn_usage) = match stream_turn(
            opts.provider,
            &opts.model,
            &system,
            &mut session.messages,
            if opts.chat { "chat" } else { "execute" },
            opts.effort.as_deref(),
            opts.variant_opts.as_ref(),
            &opts.aborted,
            &opts.project_root,
            emit,
        ) {
            Ok(t) => t,
            Err(e) => {
                emit(crate::errors::event(&e.0, e.1, None));
                let mut r = base("error", &session, &stats);
                r["summary"] = json!("Failed");
                r["error"] = json!(e.0);
                emit(finish(r, &usage, &mut session));
                return;
            }
        };
        if let Some(u) = turn_usage {
            usage.input_tokens += u.input_tokens;
            usage.output_tokens += u.output_tokens;
        }
        emit(json!({"type": "usage", "usage": usage.to_json()}));

        if calls.is_empty() {
            // Auto-verify: the model says it's done — check the repo still
            // builds/tests. On failure, feed the output back and let it fix.
            if session.files_changed.len() > verified_upto && verify_attempts < VERIFY_MAX_ATTEMPTS
            {
                if let Some(vcmd) = detect_verify_cmd(&opts.project_root) {
                    verify_attempts += 1;
                    emit(json!({"type": "status", "message": format!("Verifying ({vcmd})…")}));
                    let vinput = json!({"command": vcmd});
                    emit(json!({"type": "tool_start", "tool": "run_command", "input": vinput}));
                    stats.tool_calls += 1;
                    let (ok, output) = run_verify(&opts.project_root, &vcmd);
                    let vres = ToolResult {
                        content: if output.is_empty() {
                            "(no output)".into()
                        } else {
                            output.clone()
                        },
                        is_error: !ok,
                        changed_file: None,
                        diff: None,
                        images: vec![],
                    };
                    emit(
                        json!({"type": "tool_end", "tool": "run_command", "result": tool_result_json(&vres)}),
                    );
                    session
                        .tool_calls
                        .push(recorded("run_command", &vinput, !ok, false));
                    persist(&mut session);
                    verified_upto = session.files_changed.len();
                    if !ok {
                        session.messages.push(Message {
                            role: "user".into(),
                            content: vec![text_block(&format!(
                                "Verification failed (`{vcmd}`). Output:\n```\n{output}\n```\nFix the failures, then verify again."
                            ))],
                        });
                        persist(&mut session);
                        continue;
                    }
                } else {
                    verified_upto = session.files_changed.len();
                }
            }
            // Blind review: a fresh context audits only the diff, once.
            // Concrete findings get exactly one repair round.
            if review_attempts < REVIEW_MAX_ATTEMPTS && !session.files_changed.is_empty() {
                review_attempts += 1;
                emit(json!({"type": "status", "message": "Reviewing changes…"}));
                match review_changes(
                    opts.provider,
                    &opts.model,
                    &opts.project_root,
                    &session.files_changed,
                    &opts.aborted,
                ) {
                    Ok(text) => {
                        let findings = text.trim();
                        if findings.is_empty() || findings.starts_with("CLEAN") {
                            emit(json!({"type": "note", "text": "review: clean"}));
                        } else {
                            emit(json!({"type": "note", "text": "review found issues — fixing…"}));
                            session.messages.push(Message {
                                role: "user".into(),
                                content: vec![text_block(&format!(
                                    "A blind review of your changes found these issues:\n{findings}\n\
                                     Fix them. If a finding is wrong, briefly say why and move on."
                                ))],
                            });
                            persist(&mut session);
                            continue;
                        }
                    }
                    Err(e) => {
                        emit(json!({"type": "note", "text": format!("review skipped ({e})")}));
                    }
                }
            }
            // Done-gate: a mutating task ending with no evidence of work
            // (no file changes, no successful command) gets one self-check
            // turn — then reports "incomplete", or "declined" when the
            // model explicitly refuses the task.
            if !opts.chat
                && session.files_changed.is_empty()
                && !session.tool_calls.iter().any(|t| {
                    t.get("name").and_then(|n| n.as_str()) == Some("run_command")
                        && t.get("isError").and_then(|e| e.as_bool()) == Some(false)
                })
            {
                let summary = last_assistant_text(&session.messages);
                if summary.trim_start().starts_with("DECLINE:") {
                    let mut r = base("declined", &session, &stats);
                    r["summary"] =
                        json!(summary.trim_start()["DECLINE:".len()..].trim().to_string());
                    emit(finish(r, &usage, &mut session));
                    return;
                }
                if done_checks < DONE_CHECK_MAX_ATTEMPTS {
                    done_checks += 1;
                    emit(
                        json!({"type": "status", "message": "Nothing changed — checking completion…"}),
                    );
                    session.messages.push(Message {
                        role: "user".into(),
                        content: vec![text_block(
                            "The task is not done — nothing changed on disk and no command ran successfully. \
                             Either make the change now, or reply `DECLINE: <reason>` if the task is impossible, unclear, or already satisfied.",
                        )],
                    });
                    persist(&mut session);
                    continue;
                }
                let mut r = base("incomplete", &session, &stats);
                r["summary"] = json!(if summary.is_empty() {
                    "Finished with no changes".to_string()
                } else {
                    summary
                });
                emit(finish(r, &usage, &mut session));
                return;
            }
            // Thin-completion gate: files changed but nothing was ever run —
            // give one turn to verify or justify before calling it done.
            if !opts.chat
                && !session.files_changed.is_empty()
                && !session.tool_calls.iter().any(|t| {
                    t.get("name").and_then(|n| n.as_str()) == Some("run_command")
                        && t.get("isError").and_then(|e| e.as_bool()) == Some(false)
                })
                && done_checks < DONE_CHECK_MAX_ATTEMPTS
            {
                done_checks += 1;
                emit(json!({"type": "status", "message": "No checks ran — verifying claim…"}));
                session.messages.push(Message {
                    role: "user".into(),
                    content: vec![text_block(
                        "You changed files but ran no checks. Run the repo's build/test/lint \
                         to prove the change works — or reply with one line explaining why no \
                         check applies (e.g. docs-only, no test suite).",
                    )],
                });
                persist(&mut session);
                continue;
            }
            let mut r = base("completed", &session, &stats);
            let summary = last_assistant_text(&session.messages);
            r["summary"] = json!(if summary.is_empty() {
                "Done".to_string()
            } else {
                summary
            });
            if let Some(ds) = git_diff_stat(&opts.project_root) {
                r["diffStat"] = json!(ds);
            }
            emit(finish(r, &usage, &mut session));
            return;
        }

        let mut results = vec![];
        let mut loop_nudge = false;
        // Dispatch must honor the same phase filter as the advertised tool
        // defs — in chat mode a mutating tool name the model emits anyway
        // resolves to None and is denied, never reaching write/approval paths.
        let allowed: Vec<&tools::Tool> =
            tools::tools_for_phase(&tools, if opts.chat { "chat" } else { "execute" });
        for (id, name, input) in &calls {
            stats.tool_calls += 1;
            // Loop detection: the same tool + same args repeating while no
            // file has changed means the agent is stuck. Nudge once, then
            // stop the run on the next identical call.
            let key = format!(
                "{name}:{}",
                serde_json::to_string(input).unwrap_or_default()
            );
            let e = call_counts
                .entry(key)
                .or_insert((0, session.files_changed.len()));
            if e.1 != session.files_changed.len() {
                *e = (0, session.files_changed.len());
            }
            e.0 += 1;
            let repeat = e.0;
            if repeat >= 4 {
                emit(json!({"type": "status", "message": "Stopped a repeated tool loop"}));
                finish_emit!(
                    "error",
                    format!(
                        "Stopped: `{name}` was called with the same arguments repeatedly — the agent was stuck"
                    ),
                    vec![("error", json!("tool loop detected"))]
                );
            }
            if repeat == 3 {
                loop_nudge = true;
            }
            let tool = allowed.iter().find(|t| t.name == *name).copied();
            if tool.is_none() || name == "propose_plan" {
                emit(json!({"type": "denied", "tool": name, "reason": "unknown tool"}));
                session.tool_calls.push(recorded(name, input, true, false));
                results.push(tool_result_block(
                    id,
                    &format!("unknown tool: {name}"),
                    true,
                ));
                continue;
            }
            let tool = tool.unwrap();
            if name == "todo_write" {
                session.tool_calls.push(recorded(name, input, false, false));
                match parse_todos(input) {
                    Ok(items) => {
                        session.todos = Some(items.clone());
                        persist(&mut session);
                        persist_todos_file(&opts.project_root, &items);
                        emit(json!({"type": "todo", "items": items}));
                        results.push(tool_result_block(id, &render_todos(&items), false));
                    }
                    Err(e) => {
                        emit(json!({"type": "denied", "tool": name, "reason": e}));
                        results.push(tool_result_block(id, &e, true));
                    }
                }
                continue;
            }
            let decision = match tools::custom_spec(&ctx.root, name) {
                Some(spec) => tools::perm_custom(&spec, input, &ctx.root),
                None => (tool.permission)(input, &ctx.root),
            };
            if decision.level == Level::Restricted {
                session.tool_calls.push(recorded(name, input, true, true));
                emit(json!({"type": "denied", "tool": name, "reason": decision.reason}));
                results.push(tool_result_block(
                    id,
                    &format!("denied: {}", decision.reason),
                    true,
                ));
                continue;
            }
            if decision.level == Level::Approval {
                let reason = input
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                if !(opts.approve_tool)(name, input, &decision.reason, reason.as_deref()) {
                    session.tool_calls.push(recorded(name, input, true, true));
                    emit(json!({"type": "denied", "tool": name, "reason": "not approved"}));
                    results.push(tool_result_block(id, "denied by user", true));
                    continue;
                }
            }
            if CHECKPOINTED_TOOLS.contains(&name.as_str()) {
                if let Some((_path, diff)) = tools::preview_change(name, input, &ctx) {
                    if !(opts.review_change)(name, input, &diff) {
                        session.tool_calls.push(recorded(name, input, true, true));
                        emit(json!({"type": "denied", "tool": name, "reason": "change discarded"}));
                        results.push(tool_result_block(id, "change discarded by user", true));
                        continue;
                    }
                }
                if let Some(path) = input.get("path").and_then(|v| v.as_str()) {
                    if let Some((seq, paths)) =
                        take_checkpoint(&opts.project_root, &[path.to_string()], &session.id)
                    {
                        emit(json!({"type": "checkpoint", "seq": seq, "paths": paths}));
                    }
                }
            }
            let read_key = serde_json::to_string(input).unwrap_or_default();
            let read_mtime = (name == "read_file")
                .then(|| {
                    input
                        .get("path")
                        .and_then(|v| v.as_str())
                        .and_then(|p| fs::metadata(std::path::Path::new(&ctx.root).join(p)).ok())
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                })
                .flatten();
            if name == "read_file" {
                if let (Some(mt), Some(&cached)) = (read_mtime, read_cache.get(&read_key)) {
                    if cached == mt {
                        session.tool_calls.push(recorded(name, input, false, false));
                        emit(json!({"type": "tool_start", "tool": name, "input": input}));
                        emit(
                            json!({"type": "tool_end", "tool": name, "result": {"content": "unchanged since earlier read", "cached": true}}),
                        );
                        results.push(tool_result_block(
                            id,
                            "Unchanged since your earlier read — the content already in context is still current.",
                            false,
                        ));
                        continue;
                    }
                }
            }
            emit(json!({"type": "tool_start", "tool": name, "input": input}));
            let raw = exec_streaming(tool, name, input, &ctx, emit);
            let result = ToolResult {
                content: redact_secrets(&raw.content),
                ..raw
            };
            if name == "run_command" {
                if let Some(c) = input.get("command").and_then(|v| v.as_str()) {
                    session.commands.push(c.to_string());
                }
            }
            if let Some(cf) = &result.changed_file {
                if !session.files_changed.contains(cf) {
                    session.files_changed.push(cf.clone());
                }
            }
            if name == "read_file" && !result.is_error {
                if let Some(mt) = read_mtime {
                    read_cache.insert(read_key, mt);
                }
            }
            session.tool_calls.push(json!({
                "name": name, "input": input, "isError": result.is_error,
                "changedFile": result.changed_file,
            }));
            persist(&mut session);
            emit(json!({"type": "tool_end", "tool": name, "result": tool_result_json(&result)}));
            results.push(tool_result_block_rich(id, &result, supports_images));
        }
        if !results.is_empty() {
            session.messages.push(Message {
                role: "user".into(),
                content: results,
            });
        }
        if !budget_warned && stats.tool_calls > TOOL_BUDGET {
            budget_warned = true;
            emit(
                json!({"type": "status", "message": format!("{} tool calls — wrapping up", TOOL_BUDGET)}),
            );
            session.messages.push(Message {
                role: "user".into(),
                content: vec![text_block(&format!(
                    "You've made {TOOL_BUDGET} tool calls this run. Wrap up: apply the change now, \
                     verify once, then stop. Don't keep exploring."
                ))],
            });
            persist(&mut session);
        }
        if loop_nudge {
            session.messages.push(Message {
                role: "user".into(),
                content: vec![text_block(
                    "You've repeated the same tool call without any file changing — \
                     try a different approach, or stop and tell the user what's blocking you.",
                )],
            });
            persist(&mut session);
        }

        let mut steered = vec![];
        while let Some(s) = (opts.steer)() {
            steered.push(s);
        }
        if !steered.is_empty() {
            session.messages.push(Message {
                role: "user".into(),
                content: vec![text_block(&format!(
                    "The user sent this while you were working:\n{}",
                    steered.join("\n")
                ))],
            });
            persist(&mut session);
        }

        iterations += 1;
        if iterations >= max_iterations {
            finish_emit!("max_iterations", "Iteration limit reached");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detect_verify_cmd_picks_repo_tool() {
        let dir = std::env::temp_dir().join(format!("dxxp-verify-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(detect_verify_cmd(dir.to_str().unwrap()), None);
        fs::File::create(dir.join("package.json"))
            .unwrap()
            .write_all(br#"{"scripts":{"test":"node --test"}}"#)
            .unwrap();
        assert_eq!(
            detect_verify_cmd(dir.to_str().unwrap()).as_deref(),
            Some("npm test")
        );
        fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#,
        )
        .unwrap();
        fs::File::create(dir.join("Cargo.toml"))
            .unwrap()
            .write_all(b"[package]")
            .unwrap();
        assert_eq!(
            detect_verify_cmd(dir.to_str().unwrap()).as_deref(),
            Some("cargo test")
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn run_verify_runs_command_without_shell_timeout() {
        // Stock macOS has no `timeout(1)` — verify must run the command
        // itself and still report pass/fail correctly.
        let dir = std::env::temp_dir().join(format!("dxxp-runverify-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let (ok, out) = run_verify(root, "echo hello-verify");
        assert!(ok, "{out}");
        assert!(out.contains("hello-verify"), "{out}");
        let (ok, out) = run_verify(root, "exit 3");
        assert!(!ok, "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn json_len_tracks_serialized() {
        // The estimate path counts serialized size without allocating.
        let v = json!({
            "path": "src/main.rs",
            "old_string": "fn f() {\n    x\n}",
            "edits": [{"a": 1}, {"b": true}, {"c": null}],
            "n": 12.5,
        });
        let exact = v.to_string().len();
        let got = json_len(&v);
        assert!(got <= exact, "{got} vs {exact}");
        assert!(got >= exact * 9 / 10, "{got} vs {exact}");
    }
}

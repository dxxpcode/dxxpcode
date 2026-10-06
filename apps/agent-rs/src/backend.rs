//! BYOS backends — drive first-party agent CLIs the user is already
//! signed into (`claude`, `codex`, …) so their subscription does the work
//! and DxxpCode is the surface. Their agent loop owns tools and file
//! edits; we own the transcript, session record, and routing.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::config::{new_session_id, save_session, Message, SessionRecord};

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Static descriptor for one first-party CLI backend.
pub struct CliSpec {
    /// Provider name surfaced everywhere (`/provider <name>`, state event).
    pub name: &'static str,
    /// Executable resolved on PATH.
    pub cli: &'static str,
    /// Human label for pickers/settings.
    pub label: &'static str,
    /// Command the user runs to sign in (shown when `not signed in`).
    pub auth_cmd: &'static str,
    /// Credential file checked for auth state, `~` expanded.
    pub creds: &'static str,
    /// Install hint shown when the CLI isn't on PATH.
    pub install: &'static str,
}

pub const CLAUDE_CODE: CliSpec = CliSpec {
    name: "claude-code",
    cli: "claude",
    label: "Claude Code",
    auth_cmd: "claude auth login",
    creds: "~/.claude/.credentials.json",
    install: "npm install -g @anthropic-ai/claude-code",
};

pub const CODEX_CLI: CliSpec = CliSpec {
    name: "codex-cli",
    cli: "codex",
    label: "Codex CLI",
    auth_cmd: "codex login",
    creds: "~/.codex/auth.json",
    install: "npm install -g @openai/codex",
};

pub const BACKENDS: &[&CliSpec] = &[&CLAUDE_CODE, &CODEX_CLI];

pub fn spec(name: &str) -> Option<&'static CliSpec> {
    BACKENDS.iter().copied().find(|s| s.name == name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendStatus {
    Ready,
    NotAuthed,
    NotInstalled,
}

impl BackendStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::NotAuthed => "not-authed",
            Self::NotInstalled => "not-installed",
        }
    }
}

fn cli_on_path(cli: &str) -> bool {
    let Ok(paths) = std::env::var("PATH") else {
        return false;
    };
    for dir in paths.split(if cfg!(windows) { ';' } else { ':' }) {
        if dir.is_empty() {
            continue;
        }
        let p = std::path::Path::new(dir);
        if p.join(cli).is_file() || (cfg!(windows) && p.join(format!("{cli}.exe")).is_file()) {
            return true;
        }
    }
    false
}

fn creds_present(spec: &CliSpec) -> bool {
    // `~` is the *user's* home — these are the CLI's own credential files,
    // not DxxpCode's `~/.dxxpcode` home.
    let path = spec.creds.strip_prefix("~/").map_or_else(
        || PathBuf::from(spec.creds),
        |rest| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(rest),
    );
    path.is_file()
}

pub fn detect(spec: &CliSpec) -> BackendStatus {
    if !cli_on_path(spec.cli) {
        return BackendStatus::NotInstalled;
    }
    if creds_present(spec) {
        BackendStatus::Ready
    } else {
        BackendStatus::NotAuthed
    }
}

/// Backend statuses for the desktop's provider picker — emitted in `state`.
pub fn statuses() -> Vec<Value> {
    BACKENDS
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "label": s.label,
                "cli": s.cli,
                "auth": s.auth_cmd,
                "install": s.install,
                "status": detect(s).as_str(),
            })
        })
        .collect()
}

/// CLI backends that are installed and signed in — merged into the
/// provider list so the existing picker paths work unchanged.
pub fn ready_names() -> Vec<String> {
    BACKENDS
        .iter()
        .filter(|s| detect(s) == BackendStatus::Ready)
        .map(|s| s.name.to_string())
        .collect()
}

/// Args for one non-interactive turn. `resume` is the CLI's own session id.
fn run_args(spec: &CliSpec, prompt: &str, resume: Option<&str>) -> Vec<String> {
    match spec.name {
        "claude-code" => {
            // stream-json is NDJSON: system init → assistant/user items → result.
            // acceptEdits applies file edits without prompting; the CLI
            // can't ask questions in -p mode anyway.
            let mut a = vec![
                "-p".into(),
                prompt.to_string(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--permission-mode".into(),
                "acceptEdits".into(),
            ];
            if let Some(id) = resume {
                a.push("--resume".into());
                a.push(id.to_string());
            }
            a
        }
        "codex-cli" => {
            // `codex exec --json` streams item lifecycle events.
            let mut a = vec![
                "exec".into(),
                "--json".into(),
                "--full-auto".into(),
                prompt.to_string(),
            ];
            if let Some(id) = resume {
                // `codex exec resume <id> <prompt>` — JSON streaming applies.
                a = vec![
                    "exec".into(),
                    "resume".into(),
                    id.to_string(),
                    "--json".into(),
                    "--full-auto".into(),
                    prompt.to_string(),
                ];
            }
            a
        }
        _ => vec![prompt.to_string()],
    }
}

fn spawn_cli(
    spec: &CliSpec,
    prompt: &str,
    resume: Option<&str>,
    root: &str,
) -> Result<Child, String> {
    Command::new(spec.cli)
        .args(run_args(spec, prompt, resume))
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't launch `{}`: {e}", spec.cli))
}

/// Run one turn on a CLI backend, mapping its event stream onto our
/// transcript events. Saves/updates the session record and emits `done`.
///
/// Owns the whole turn; called from `run_once` in place of `agent::run_task`.
pub fn run_turn(
    spec: &'static CliSpec,
    task: &str,
    root: &str,
    session: Option<SessionRecord>,
    aborted: &Arc<AtomicBool>,
    emit: &mut dyn FnMut(Value),
) {
    let mut session = session.unwrap_or_else(|| SessionRecord {
        version: 1,
        id: new_session_id(root),
        project_root: root.to_string(),
        created_at: iso_now(),
        updated_at: iso_now(),
        task: task.to_string(),
        messages: vec![],
        tool_calls: vec![],
        files_changed: vec![],
        commands: vec![],
        todos: None,
        result: None,
        mode: None,
        backend: Some(spec.name.to_string()),
        cli_session: None,
    });
    session.backend = Some(spec.name.to_string());
    if session.messages.is_empty() || session.result.is_some() {
        session.messages.push(Message {
            role: "user".into(),
            content: vec![json!({"type": "text", "text": task})],
        });
    }

    let done_at =
        |status: &str, summary: String, session: &mut SessionRecord, tool_calls: usize| -> Value {
            session.result = Some(summary.clone());
            session.updated_at = iso_now();
            save_session(session);
            json!({"type": "done", "result": {
                "status": status,
                "summary": summary,
                "filesChanged": session.files_changed,
                "commands": session.commands,
                "toolCalls": tool_calls,
                "sessionId": session.id,
                "backend": spec.name,
            }})
        };

    let mut child = match spawn_cli(spec, task, session.cli_session.as_deref(), root) {
        Ok(c) => c,
        Err(e) => {
            let ev = done_at("error", e, &mut session, 0);
            emit(ev);
            return;
        }
    };

    let mut tool_calls = 0usize;
    // tool_use id → name, so `tool_end` rows keep the right label.
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut saw_result = false;
    let mut result_text = String::new();
    let mut result_err = false;

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            if aborted.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<Value>(line) else {
                emit(json!({"type": "note", "text": line}));
                continue;
            };
            map_event(
                spec,
                &ev,
                &mut tool_names,
                &mut tool_calls,
                &mut saw_result,
                &mut result_text,
                &mut result_err,
                &mut session,
                emit,
            );
        }
    }

    let _ = child.wait();

    if aborted.load(Ordering::Relaxed) && !saw_result {
        let ev = done_at("cancelled", "Stopped".into(), &mut session, tool_calls);
        emit(ev);
        return;
    }

    if saw_result {
        let status = if result_err { "error" } else { "completed" };
        let ev = done_at(status, result_text, &mut session, tool_calls);
        emit(ev);
    } else {
        // Process ended without a result event — surface stderr if any.
        let mut err = String::new();
        if let Some(mut se) = child.stderr.take() {
            use std::io::Read;
            let _ = se.read_to_string(&mut err);
        }
        let msg = if err.trim().is_empty() {
            format!("{} exited without a result", spec.cli)
        } else {
            err.trim().lines().take(3).collect::<Vec<_>>().join(" ")
        };
        let ev = done_at("error", msg, &mut session, tool_calls);
        emit(ev);
    }
}

fn map_event(
    spec: &CliSpec,
    ev: &Value,
    tool_names: &mut HashMap<String, String>,
    tool_calls: &mut usize,
    saw_result: &mut bool,
    result_text: &mut String,
    result_err: &mut bool,
    session: &mut SessionRecord,
    emit: &mut dyn FnMut(Value),
) {
    if spec.name == "claude-code" {
        map_claude(
            ev,
            tool_names,
            tool_calls,
            saw_result,
            result_text,
            result_err,
            session,
            emit,
        );
    } else if spec.name == "codex-cli" {
        map_codex(
            ev,
            tool_names,
            tool_calls,
            saw_result,
            result_text,
            result_err,
            session,
            emit,
        );
    }
}

fn push_text(session: &mut SessionRecord, text: &str, emit: &mut dyn FnMut(Value)) {
    emit(json!({"type": "text", "text": text}));
    session.messages.push(Message {
        role: "assistant".into(),
        content: vec![json!({"type": "text", "text": text})],
    });
}

fn push_tool(
    session: &mut SessionRecord,
    tool_names: &mut HashMap<String, String>,
    tool_calls: &mut usize,
    id: &str,
    name: &str,
    input: &Value,
    emit: &mut dyn FnMut(Value),
) {
    *tool_calls += 1;
    tool_names.insert(id.to_string(), name.to_string());
    emit(json!({"type": "tool_start", "tool": name, "input": input}));
    session
        .tool_calls
        .push(json!({"name": name, "input": input}));
    session.messages.push(Message {
        role: "assistant".into(),
        content: vec![json!({"type": "tool_use", "id": id, "name": name, "input": input})],
    });
}

fn push_tool_end(
    session: &mut SessionRecord,
    tool_names: &HashMap<String, String>,
    id: &str,
    content: &str,
    is_error: bool,
    emit: &mut dyn FnMut(Value),
) {
    let name = tool_names.get(id).cloned().unwrap_or_else(|| "tool".into());
    emit(
        json!({"type": "tool_end", "tool": name, "result": {"content": content, "isError": is_error}}),
    );
    session.messages.push(Message {
        role: "user".into(),
        content: vec![json!({"type": "tool_result", "toolUseId": id, "content": content, "isError": is_error})],
    });
}

#[allow(clippy::too_many_arguments)]
fn map_claude(
    ev: &Value,
    tool_names: &mut HashMap<String, String>,
    tool_calls: &mut usize,
    saw_result: &mut bool,
    result_text: &mut String,
    result_err: &mut bool,
    session: &mut SessionRecord,
    emit: &mut dyn FnMut(Value),
) {
    let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if let Some(sid) = ev.get("session_id").and_then(|s| s.as_str()) {
        session.cli_session = Some(sid.to_string());
    }
    match ty {
        "system" => {}
        "assistant" => {
            let Some(blocks) = ev.pointer("/message/content").and_then(|c| c.as_array()) else {
                return;
            };
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            push_text(session, t, emit);
                        }
                    }
                    Some("tool_use") => {
                        let id = b
                            .get("id")
                            .and_then(|i| i.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                        let input = b.get("input").cloned().unwrap_or(json!({}));
                        push_tool(session, tool_names, tool_calls, &id, name, &input, emit);
                    }
                    _ => {}
                }
            }
        }
        "user" => {
            // tool_result blocks arrive as user-type events.
            let Some(blocks) = ev.pointer("/message/content").and_then(|c| c.as_array()) else {
                return;
            };
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let id = b
                    .get("tool_use_id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                let content = match b.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a
                        .iter()
                        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                let is_error = b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                push_tool_end(session, tool_names, &id, &content, is_error, emit);
            }
        }
        "result" => {
            *saw_result = true;
            *result_err = ev
                .get("is_error")
                .and_then(|e| e.as_bool())
                .unwrap_or(false)
                || ev.get("subtype").and_then(|s| s.as_str()) == Some("error");
            *result_text = ev
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string();
            if result_text.is_empty() {
                *result_text = if *result_err {
                    "Failed".into()
                } else {
                    "Done".into()
                };
            }
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn map_codex(
    ev: &Value,
    tool_names: &mut HashMap<String, String>,
    tool_calls: &mut usize,
    saw_result: &mut bool,
    result_text: &mut String,
    result_err: &mut bool,
    session: &mut SessionRecord,
    emit: &mut dyn FnMut(Value),
) {
    let ty = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let item = ev.get("item").cloned().unwrap_or(json!({}));
    let ity = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match (ty, ity) {
        (_, "agent_message") => {
            if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                push_text(session, t, emit);
            }
        }
        ("item.started", _) | ("item.updated", _) | ("item.completed", _) => {
            // command_execution / file_change / mcp_tool_call items carry a
            // command or file path we surface as a quiet tool row.
            let name = item
                .get("tool_name")
                .or_else(|| item.get("command"))
                .and_then(|n| n.as_str())
                .unwrap_or(ity)
                .to_string();
            let id = item
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            if ty == "item.started" && !ity.is_empty() && ity != "agent_message" {
                let input = json!({"command": item.get("command").and_then(|c| c.as_str()).unwrap_or(&name)});
                push_tool(session, tool_names, tool_calls, &id, ity, &input, emit);
            }
            if ty == "item.completed" {
                let out = item
                    .get("output")
                    .or_else(|| item.get("aggregated_output"))
                    .and_then(|o| o.as_str())
                    .unwrap_or("");
                let is_err = item
                    .get("exit_code")
                    .and_then(|c| c.as_i64())
                    .map(|c| c != 0)
                    .unwrap_or(false);
                push_tool_end(session, tool_names, &id, out, is_err, emit);
            }
        }
        ("turn.failed", _) | ("error", _) => {
            *saw_result = true;
            *result_err = true;
            *result_text = ev
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Failed")
                .to_string();
        }
        ("turn.completed", _) => {
            *saw_result = true;
            *result_err = false;
            if result_text.is_empty() {
                *result_text = "Done".into();
            }
        }
        _ => {}
    }
}

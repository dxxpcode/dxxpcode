//! App mode (`dxxpcode --app`): the shell protocol for the desktop app.
//! Port of apps/cli/src/app.ts.

use crate::agent::{self, compact_messages, estimate_tokens, undo_checkpoint};
use crate::config::{
    list_sessions, load_config, load_session, save_config, save_session, Config, SessionRecord,
};
use crate::project::{detect_git, ProjectInfo};
use crate::provider::{jev_route_effort, resolve_provider, smart_approve, Provider};
use crate::tools::{self, CtxProcTable};
use crate::util::{expand_mentions, file_suggestions, list_project_files, FileIndex};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};

const COMMAND_LIST: &[(&str, &str)] = &[
    (
        "/review",
        "working-tree diff — `/review agent` runs an AI review",
    ),
    ("/model", "pick the model for the next task"),
    ("/status", "session, config, and usage info"),
    ("/settings", "approval mode, provider, model, effort"),
    ("/approval", "approval mode — ask, always, or smart (Jev)"),
    ("/effort", "reasoning effort for the next task"),
    (
        "/setup",
        "guided setup — provider, effort, optional Jev key",
    ),
    ("/providers", "switch between configured providers"),
    ("/undo", "restore files from the last checkpoint"),
    (
        "/compact",
        "compress old tool output in the session context",
    ),
    ("/docs", "reference — install, commands, flags, config"),
    ("/changelog", "release history"),
    ("/clear", "clear the transcript"),
    ("/new", "start a new session — resets context and approvals"),
    ("/resume", "resume a previous session for this project"),
    ("/help", "list available commands"),
    ("/exit", "quit"),
];

pub static DOCS_MD: &str = include_str!(concat!(env!("OUT_DIR"), "/docs.md"));
pub static CHANGELOG_MD: &str = include_str!(concat!(env!("OUT_DIR"), "/changelog.md"));

const KNOWN_MODELS: &[(&str, &[&str])] = &[
    (
        "anthropic",
        &["claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
    ),
    ("openai", &["gpt-6", "gpt-5", "gpt-4o"]),
];

fn emit(v: Value) {
    static OUT: OnceLock<Mutex<std::io::Stdout>> = OnceLock::new();
    let out = OUT.get_or_init(|| Mutex::new(std::io::stdout()));
    let mut g = out.lock().unwrap();
    let _ = g.write_all(v.to_string().as_bytes());
    let _ = g.write_all(b"\n");
    let _ = g.flush();
}

fn emit_note(text: impl Into<String>) {
    emit(json!({"type": "note", "text": text.into()}));
}

fn fmt_tokens(n: usize) -> String {
    if n >= 1000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

fn git_out(root: &str, args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_PAGER", "cat")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

fn describe(tool: &str, input: &Value) -> String {
    if tool == "run_command" || tool == "run_background" {
        return input
            .get("command")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| tool.to_string());
    }
    match input.get("path").and_then(|v| v.as_str()) {
        Some(p) => format!("{tool} {p}"),
        None => tool.to_string(),
    }
}

/// What "always allow" actually grants for the rest of the session.
/// Commands scope to the command head (binary + first arg — `npm test`,
/// `cargo build`); file tools stay scoped to the exact path.
fn approve_scope(tool: &str, input: &Value) -> String {
    if tool == "run_command" || tool == "run_background" {
        let cmd = input
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or(tool);
        let head: Vec<&str> = cmd
            .split_whitespace()
            .take_while(|t| !matches!(*t, "|" | "||" | ";" | "&&" | "&" | ">" | ">>" | "<"))
            .take(2)
            .collect();
        return format!("{tool}:{}", head.join(" "));
    }
    describe(tool, input)
}

/* --------------------------------- state --------------------------------- */

pub struct AppDeps {
    pub version: String,
    pub provider: Provider,
    pub model: String,
    pub effort: Option<String>,
    pub project: ProjectInfo,
    pub root: String,
    pub session: Option<SessionRecord>,
    pub plan_only: bool,
    pub auto_approve: bool,
    pub smart_approve_mode: bool,
    pub max_iterations: Option<u32>,
    pub config: Config,
    pub mode: String,
}

/// State shared between the dispatcher (main thread) and worker threads.
pub struct Shared {
    pub provider_name: Mutex<String>,
    pub model: Mutex<String>,
    pub effort: Mutex<Option<String>>,
    pub auto_approve: AtomicBool,
    pub smart_mode: AtomicBool,
    pub mode: Mutex<String>,
    /// Agent mode toggle: false = code (default), true = read-only chat.
    pub chat_mode: Mutex<bool>,
    pub session: Mutex<Option<SessionRecord>>,
    pub allowlist: Mutex<HashSet<String>>,
    pub next_id: Mutex<u64>,
    pub pending_approvals: Mutex<HashMap<u64, Sender<String>>>,
    pub pending_selects: Mutex<HashMap<u64, Sender<Option<usize>>>>,
    pub pending_prompts: Mutex<HashMap<u64, Sender<Option<String>>>>,
    pub pending_diffs: Mutex<HashMap<u64, Sender<String>>>,
    pub diff_apply_all: AtomicBool,
    pub steer_queue: Mutex<VecDeque<String>>,
    pub task_queue: Mutex<VecDeque<String>>,
    pub running: AtomicBool,
    pub aborted: Arc<AtomicBool>,
    pub turn_tokens: Mutex<usize>,
    /// The live provider — stored so menus can switch it; runs take a snapshot.
    pub provider: Mutex<Option<Provider>>,
    pub procs: CtxProcTable,
}

impl Shared {
    fn emit_state(&self) {
        emit(json!({
            "type": "state",
            "provider": *self.provider_name.lock().unwrap(),
            "model": *self.model.lock().unwrap(),
            "effort": if self.effort_auto() { "auto (Jev)".to_string() } else { self.effort.lock().unwrap().clone().unwrap_or_else(|| "default".into()) },
            "mode": *self.mode.lock().unwrap(),
        }));
    }

    fn effort_auto(&self) -> bool {
        load_config().effort_auto == Some(true)
    }

    fn emit_session(&self) {
        let s = self.session.lock().unwrap();
        emit(json!({
            "type": "session",
            "id": s.as_ref().map(|s| s.id.clone()),
            "tokens": s.as_ref().map(|s| estimate_tokens(&s.messages)).unwrap_or(0),
        }));
    }

    /// Replay a resumed session's stored messages so the app can rebuild
    /// the transcript (user turns, text, tool calls with their results).
    fn emit_history(rec: &SessionRecord) {
        emit(json!({
            "type": "history",
            "task": rec.task,
            "messages": rec.messages,
            "filesChanged": rec.files_changed,
        }));
    }

    fn jev_key(&self) -> Option<String> {
        std::env::var("TYPESAFE_API_KEY")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| load_config().type_safe_api_key)
    }

    /* ---------------------------- blocking asks ---------------------------- */

    fn ask(&self, kind: &str, summary: &str, reason: Option<&str>, tool: Option<&str>) -> String {
        let (tx, rx) = channel::<String>();
        let id = {
            let mut n = self.next_id.lock().unwrap();
            let id = *n;
            *n += 1;
            id
        };
        self.pending_approvals.lock().unwrap().insert(id, tx);
        let mut ev = json!({
            "type": "approval", "id": id, "kind": kind, "summary": summary,
            "reason": reason, "allowAlways": kind == "tool",
        });
        if kind == "plan" {
            ev["extraChoice"] = json!({"choice": "s", "label": "Approve + save plan"});
        }
        if let Some(t) = tool {
            ev["tool"] = json!(t);
        }
        emit(ev);
        rx.recv().unwrap_or_else(|_| "n".into())
    }

    fn menu(&self, title: &str, options: Vec<Value>, current: Option<usize>) -> Option<usize> {
        let (tx, rx) = channel::<Option<usize>>();
        let id = {
            let mut n = self.next_id.lock().unwrap();
            let id = *n;
            *n += 1;
            id
        };
        self.pending_selects.lock().unwrap().insert(id, tx);
        emit(json!({
            "type": "menu", "id": id, "title": title, "options": options,
            "current": current.unwrap_or(0),
        }));
        rx.recv().unwrap_or(None)
    }

    fn prompt(&self, title: &str, secret: bool) -> Option<String> {
        let (tx, rx) = channel::<Option<String>>();
        let id = {
            let mut n = self.next_id.lock().unwrap();
            let id = *n;
            *n += 1;
            id
        };
        self.pending_prompts.lock().unwrap().insert(id, tx);
        emit(json!({"type": "prompt", "id": id, "title": title, "secret": secret}));
        rx.recv().unwrap_or(None)
    }

    /// Emit a diff-review card and block on the user's decision.
    fn review_diff(&self, path: &str, diff: &str) -> String {
        if self.diff_apply_all.load(Ordering::Relaxed) {
            return "apply".into();
        }
        let (tx, rx) = channel::<String>();
        let id = {
            let mut n = self.next_id.lock().unwrap();
            let id = *n;
            *n += 1;
            id
        };
        self.pending_diffs.lock().unwrap().insert(id, tx);
        emit(json!({"type": "diff_review", "id": id, "path": path, "diff": diff}));
        rx.recv().unwrap_or_else(|_| "discard".into())
    }
}

/* ---------------------------- slash commands ----------------------------- */

fn labeled_options(items: &[&str], descs: Option<&[&str]>) -> Vec<Value> {
    items
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let mut o = json!({"label": l});
            if let Some(d) = descs.and_then(|dd| dd.get(i)) {
                o["desc"] = json!(d);
            }
            o
        })
        .collect()
}

fn open_model_menu(sh: &Arc<Shared>) {
    let name = sh.provider_name.lock().unwrap().clone();
    let mut fallback: Vec<String> = KNOWN_MODELS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, m)| m.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default();
    if name == "openai" && load_config().openai_base_url.is_some() {
        fallback.push("grok-4".into());
        fallback.push("gemini-3-pro".into());
    }
    let mut list = sh
        .provider
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|p| p.list_models().ok())
        .unwrap_or_default();
    if list.is_empty() {
        list = fallback;
    }
    let cur_model = sh.model.lock().unwrap().clone();
    let mut opts = if !cur_model.is_empty() && !list.contains(&cur_model) {
        let mut v = vec![cur_model.clone()];
        v.extend(list);
        v
    } else {
        list
    };
    opts.push("custom…".into());
    let current = opts.iter().position(|m| *m == cur_model).unwrap_or(0);
    let menu_opts: Vec<Value> = opts.iter().map(|m| json!({"label": m})).collect();
    let Some(i) = sh.menu(
        &format!("Model — {name} · applies to the next task and is saved"),
        menu_opts,
        Some(current),
    ) else {
        return;
    };
    let mut m = match opts.get(i) {
        Some(s) => s.clone(),
        None => {
            let Some(custom) = sh.prompt("model name:", false) else {
                return;
            };
            let t = custom.trim();
            if t.is_empty() {
                return;
            }
            t.to_string()
        }
    };
    if m == "custom…" {
        let Some(custom) = sh.prompt("model name:", false) else {
            return;
        };
        m = custom.trim().to_string();
        if m.is_empty() {
            return;
        }
    }
    set_model(sh, &m);
}

fn set_model(sh: &Arc<Shared>, m: &str) {
    let m = m.trim();
    if m.is_empty() {
        return;
    }
    *sh.model.lock().unwrap() = m.to_string();
    let mut cfg = load_config();
    cfg.model = Some(m.to_string());
    save_config(&cfg);
    emit_note(format!(
        "model: {m} · effort {} (saved)",
        sh.effort
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "default".into())
    ));
    sh.emit_state();
}

fn model_options(sh: &Arc<Shared>) -> Vec<String> {
    let name = sh.provider_name.lock().unwrap().clone();
    let mut fallback: Vec<String> = KNOWN_MODELS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, m)| m.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default();
    if name == "openai" && load_config().openai_base_url.is_some() {
        fallback.push("grok-4".into());
        fallback.push("gemini-3-pro".into());
    }
    let mut list = sh
        .provider
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|p| p.list_models().ok())
        .unwrap_or_default();
    if list.is_empty() {
        list = fallback;
    }
    let cur_model = sh.model.lock().unwrap().clone();
    if !cur_model.is_empty() && !list.contains(&cur_model) {
        list.insert(0, cur_model);
    }
    list
}

fn open_effort_menu(sh: &Arc<Shared>) {
    let opts = [
        "default",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "auto (Jev)",
    ];
    let descs = [
        "provider default",
        "fastest — quick lookups, simple formatting",
        "modest reasoning — drafting, straightforward tasks",
        "balanced — agentic coding, research, most workloads",
        "hard reasoning — complex debugging, deep planning",
        "larger budget for the hardest multi-step problems",
        "unconstrained budget — high-stakes, hardest tasks",
        "Jev scores each task and picks the tier — needs TYPESAFE_API_KEY",
    ];
    let cfg = load_config();
    let cur = if cfg.effort_auto == Some(true) {
        "auto (Jev)".to_string()
    } else {
        sh.effort
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "default".into())
    };
    let current = opts.iter().position(|o| *o == cur).unwrap_or(0);
    let menu_opts = labeled_options(&opts, Some(&descs));
    let Some(i) = sh.menu(
        "Reasoning effort — applies to the next task",
        menu_opts,
        Some(current),
    ) else {
        return;
    };
    set_effort(sh, opts[i]);
}

fn set_effort(sh: &Arc<Shared>, next: &str) {
    let valid = [
        "default",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "auto (Jev)",
    ];
    if !valid.contains(&next) {
        emit_note(format!("unknown effort level: {next}"));
        return;
    }
    if next == "auto (Jev)" {
        let mut cfg = load_config();
        cfg.effort_auto = Some(true);
        save_config(&cfg);
        emit_note(format!(
            "reasoning effort: auto (Jev) (saved){}",
            if sh.jev_key().is_some() {
                ""
            } else {
                " — set TYPESAFE_API_KEY to enable"
            }
        ));
    } else {
        *sh.effort.lock().unwrap() = if next == "default" {
            None
        } else {
            Some(next.to_string())
        };
        let mut cfg = load_config();
        cfg.effort = sh.effort.lock().unwrap().clone();
        cfg.effort_auto = Some(false);
        save_config(&cfg);
        emit_note(format!("reasoning effort: {next} (saved)"));
    }
    sh.emit_state();
}

fn open_approval_menu(sh: &Arc<Shared>) {
    let opts = ["ask", "always-approve", "smart (Jev)"];
    let cur = if sh.smart_mode.load(Ordering::Relaxed) {
        2
    } else if sh.auto_approve.load(Ordering::Relaxed) {
        1
    } else {
        0
    };
    let Some(i) = sh.menu(
        &format!(
            "Approval mode — applied to the next task and saved{}",
            if sh.jev_key().is_some() {
                ""
            } else {
                " · smart needs TYPESAFE_API_KEY"
            }
        ),
        labeled_options(&opts, None),
        Some(cur),
    ) else {
        return;
    };
    set_approval_mode(sh, i);
}

fn set_approval_mode(sh: &Arc<Shared>, i: usize) {
    let opts = ["ask", "always-approve", "smart (Jev)"];
    sh.smart_mode.store(i == 2, Ordering::Relaxed);
    sh.auto_approve.store(i == 1, Ordering::Relaxed);
    *sh.mode.lock().unwrap() = if i == 2 {
        "smart"
    } else if i == 1 {
        "always-approve"
    } else {
        "ask"
    }
    .into();
    let mut cfg = load_config();
    cfg.approval_mode = Some(
        if i == 2 {
            "smart"
        } else if i == 1 {
            "auto"
        } else {
            "ask"
        }
        .into(),
    );
    save_config(&cfg);
    emit_note(format!(
        "approval mode: {} (saved){}",
        opts[i],
        if i == 2 && sh.jev_key().is_none() {
            " — no TYPESAFE_API_KEY yet; falls back to ask"
        } else {
            ""
        }
    ));
    sh.emit_state();
}

fn set_approval_mode_by_name(sh: &Arc<Shared>, name: &str) {
    let i = match name.trim() {
        "ask" => 0,
        "always-approve" | "always" | "auto" => 1,
        "smart (Jev)" | "smart" => 2,
        other => {
            emit_note(format!("unknown approval mode: {other}"));
            return;
        }
    };
    set_approval_mode(sh, i);
}

fn switch_provider(sh: &Arc<Shared>, name: &str) {
    let fresh = load_config();
    let mut models = fresh.models.clone().unwrap_or_default();
    models.insert(
        sh.provider_name.lock().unwrap().clone(),
        sh.model.lock().unwrap().clone(),
    );
    let model_for = models.get(name).cloned();
    match resolve_provider(Some(name), model_for.as_deref(), &fresh) {
        Ok((provider, model)) => {
            let pname = provider.name().to_string();
            *sh.provider.lock().unwrap() = Some(provider);
            *sh.provider_name.lock().unwrap() = pname.clone();
            *sh.model.lock().unwrap() = model.clone();
            let mut cfg = fresh;
            cfg.provider = Some(name.to_string());
            cfg.model = Some(model.clone());
            cfg.models = Some(models);
            save_config(&cfg);
            emit_note(format!("provider: {name} · {model} (saved)"));
            sh.emit_state();
        }
        Err(e) => emit(crate::errors::event(&e.to_string(), e.1, None)),
    }
}

fn connect_provider(sh: &Arc<Shared>) -> bool {
    let Some(which) = sh.menu(
        "Connect a provider",
        vec![
            json!({"label": "Anthropic", "desc": "Claude models"}),
            json!({"label": "OpenRouter", "desc": "one key — Claude, GPT, Gemini, Llama"}),
            json!({"label": "OpenAI-compatible", "desc": "OpenAI, Gemini, local endpoints"}),
        ],
        None,
    ) else {
        return false;
    };
    let Some(key) = sh.prompt(
        match which {
            0 => "Anthropic API key:",
            1 => "OpenRouter API key:",
            _ => "OpenAI-compatible API key:",
        },
        true,
    ) else {
        return false;
    };
    let key = key.trim().to_string();
    if key.is_empty() {
        return false;
    }
    let mut base_url = None;
    if which == 1 {
        base_url = Some("https://openrouter.ai/api/v1".to_string());
    } else if which == 2 {
        if let Some(b) = sh.prompt("Base URL (blank = api.openai.com):", false) {
            let b = b.trim();
            if !b.is_empty() {
                base_url = Some(b.to_string());
            }
        }
    }
    let mut cfg = load_config();
    if which == 0 {
        cfg.anthropic_api_key = Some(key);
    } else {
        cfg.openai_api_key = Some(key);
        if let Some(b) = base_url {
            cfg.openai_base_url = Some(b);
        }
    }
    save_config(&cfg);
    let name = if which == 0 { "anthropic" } else { "openai" };
    switch_provider(sh, name);
    emit_note(format!(
        "{} key saved",
        match which {
            0 => "Anthropic",
            1 => "OpenRouter",
            _ => "OpenAI-compatible",
        }
    ));
    true
}

/// Onboarding wizard backend: validate the entered key by listing models
/// before saving anything. Replies {"type":"setup_result","ok":bool,...}.
fn run_wizard_setup(sh: &Arc<Shared>, cmd: &Value) {
    let which = cmd.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let done = |ok: bool, provider: &str, model: Option<String>, error: Option<String>| {
        emit(
            json!({"type": "setup_result", "ok": ok, "provider": provider, "model": model, "error": error}),
        );
    };

    if which == "mock" {
        // Demo mode — session-only, nothing persisted. A tiny scripted
        // conversation so the demo isn't a dead end.
        let script = vec![
            json!({"text": "Demo mode — this answer comes from the built-in mock provider, no API key needed.\n\nAsk anything; each reply is canned. To use a real model, connect a provider in Settings → Connect a provider."}),
            json!({"text": "Still in demo mode. Connect a real provider (Anthropic, OpenAI-compatible) via Settings → Connect a provider to run real tasks."}),
            json!({"text": "Demo mode uses a scripted provider — it can't read files or run commands. Connect a provider to unlock the agent."}),
        ];
        *sh.provider.lock().unwrap() = Some(crate::provider::Provider::Mock { script, turn: 0 });
        *sh.provider_name.lock().unwrap() = "mock".to_string();
        *sh.model.lock().unwrap() = "demo".to_string();
        sh.emit_state();
        emit_note("demo mode — nothing is saved; connect a provider anytime");
        done(true, "mock", Some("demo".into()), None);
        return;
    }

    let key = cmd
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if key.is_empty() {
        done(false, which, None, Some("API key is empty".into()));
        return;
    }
    let base_url = cmd
        .get("base_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string());

    let candidate = match which {
        "anthropic" => crate::provider::Provider::Anthropic { key: key.clone() },
        "openai" => crate::provider::Provider::OpenAi {
            key: key.clone(),
            base_url: base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".into()),
        },
        _ => {
            done(
                false,
                which,
                None,
                Some(format!("unknown provider \"{which}\"")),
            );
            return;
        }
    };

    // Live validation — a bad key should fail here, not on the first task.
    let models = match candidate.list_models() {
        Ok(m) if !m.is_empty() => m,
        Ok(_) => {
            done(
                false,
                which,
                None,
                Some("key accepted but no models returned — check the base URL".into()),
            );
            return;
        }
        Err(e) => {
            done(false, which, None, Some(e.0));
            return;
        }
    };

    let mut cfg = load_config();
    if which == "anthropic" {
        cfg.anthropic_api_key = Some(key);
    } else {
        cfg.openai_api_key = Some(key);
        if let Some(b) = &base_url {
            cfg.openai_base_url = Some(b.clone());
        }
    }
    // Pick a model that actually exists on this endpoint: keep a saved
    // per-provider choice, else prefer the built-in default, else fall back
    // to the first model the endpoint returned.
    let mut models_map = cfg.models.clone().unwrap_or_default();
    let existing = models_map.get(which).cloned();
    let builtin_default = if which == "anthropic" {
        "claude-opus-5-5"
    } else {
        "gpt-6"
    };
    let chosen = existing.filter(|m| models.contains(m)).unwrap_or_else(|| {
        if models.iter().any(|m| m == builtin_default) {
            builtin_default.to_string()
        } else {
            models[0].clone()
        }
    });
    models_map.insert(which.to_string(), chosen);
    cfg.models = Some(models_map);
    cfg.model = None; // let switch_provider re-resolve from cfg.models
    save_config(&cfg);
    switch_provider(sh, which);
    let model = sh.model.lock().unwrap().clone();
    emit_note(format!(
        "connected — {} model(s) available, default {model}",
        models.len()
    ));
    done(true, which, Some(model), None);
}

fn run_onboarding(sh: &Arc<Shared>) {
    emit_note("welcome to dxxpcode — connect a provider to get started");
    if !connect_provider(sh) {
        return;
    }
    open_effort_menu(sh);
    if let Some(key) = sh.prompt(
        "Optional: TYPESAFE_API_KEY for smart approvals + auto effort (blank to skip):",
        true,
    ) {
        let k = key.trim();
        if !k.is_empty() {
            let mut cfg = load_config();
            cfg.type_safe_api_key = Some(k.to_string());
            save_config(&cfg);
            emit_note("Jev key saved");
        }
    }
    emit_note("you're all set — ask dxxpcode anything");
}

fn open_provider_menu(sh: &Arc<Shared>) {
    let cfg = load_config();
    let cur = sh.provider_name.lock().unwrap().clone();
    let mut avail: Vec<String> = vec![];
    if std::env::var("ANTHROPIC_API_KEY").is_ok() || cfg.anthropic_api_key.is_some() {
        avail.push("anthropic".into());
    }
    if std::env::var("OPENAI_API_KEY").is_ok() || cfg.openai_api_key.is_some() {
        avail.push("openai".into());
    }
    if std::env::var("DXXPCODE_PROVIDER")
        .map(|v| v == "mock")
        .unwrap_or(false)
        || std::env::var("DXXPCODE_MOCK_SCRIPT").is_ok()
        || cur == "mock"
    {
        avail.push("mock".into());
    }
    let mut opts = vec![cur.clone()];
    for a in avail {
        if !opts.contains(&a) {
            opts.push(a);
        }
    }
    let menu_opts: Vec<Value> = opts
        .iter()
        .map(|p| json!({"label": p}))
        .chain(std::iter::once(json!({"label": "connect a provider…"})))
        .collect();
    let current = opts.iter().position(|p| *p == cur).unwrap_or(0);
    let Some(i) = sh.menu(
        "Provider — switches for the next task and is saved",
        menu_opts,
        Some(current),
    ) else {
        return;
    };
    if i >= opts.len() {
        connect_provider(sh);
        return;
    }
    let name = &opts[i];
    if *name == cur {
        return;
    }
    switch_provider(sh, name);
}

fn open_settings_menu(sh: &Arc<Shared>) {
    let entries = ["Approval mode", "Provider", "Model", "Reasoning effort"];
    let Some(i) = sh.menu("Settings", labeled_options(&entries, None), None) else {
        return;
    };
    match i {
        0 => open_approval_menu(sh),
        1 => open_provider_menu(sh),
        2 => open_model_menu(sh),
        3 => open_effort_menu(sh),
        _ => {}
    }
}

fn show_status(sh: &Arc<Shared>, deps_root: &str, project: &ProjectInfo, version: &str) {
    let git = detect_git(deps_root).or_else(|| project.git.clone());
    let session = sh.session.lock().unwrap();
    let rows: Vec<Value> = vec![
        json!([
            "provider",
            format!(
                "{} · {}",
                *sh.provider_name.lock().unwrap(),
                *sh.model.lock().unwrap()
            )
        ]),
        json!(["mode", *sh.mode.lock().unwrap()]),
        json!([
            "effort",
            if sh.effort_auto() {
                "auto (Jev)".to_string()
            } else {
                sh.effort
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "default".into())
            }
        ]),
        json!(["version", format!("v{version}")]),
        json!(["project", format!("{} — {}", project.name, deps_root)]),
        json!([
            "git",
            git.map(|g| format!(
                "{}{}",
                g.branch,
                if g.dirty { " (dirty)" } else { " (clean)" }
            ))
            .unwrap_or_else(|| "not a repository".into())
        ]),
        json!([
            "session",
            session
                .as_ref()
                .map(|s| s.id.clone())
                .unwrap_or_else(|| "—".into())
        ]),
        json!([
            "context",
            session
                .as_ref()
                .map(|s| format!(
                    "~{} tok / 60k cap",
                    fmt_tokens(estimate_tokens(&s.messages))
                ))
                .unwrap_or_else(|| "—".into())
        ]),
        json!([
            "usage",
            format!(
                "{} tok this turn",
                fmt_tokens(*sh.turn_tokens.lock().unwrap())
            )
        ]),
        json!(["config", crate::config::config_path().display().to_string()]),
    ];
    drop(session);
    emit(json!({"type": "table", "title": "Status", "rows": rows}));
}

/// `/review agent` — spawns this binary as a detached review sub-agent
/// (`--task`), so the review runs in its own session with a fresh context
/// and reports back as a transcript card. Full output stays observable.
fn run_agent_review(deps: &DepsInfo) {
    let diff = git_out(&deps.root, &["diff"]) + &git_out(&deps.root, &["diff", "--cached"]);
    let untracked = git_out(&deps.root, &["ls-files", "--others", "--exclude-standard"]);
    let mut body = diff.trim().to_string();
    if !untracked.trim().is_empty() {
        body += &format!("\n\nuntracked files (not shown): {}", untracked.trim());
    }
    if body.is_empty() {
        emit_note("No changes to review.");
        return;
    }
    body.truncate(60_000);
    let prompt = format!(
        "Review this working-tree diff for: bugs and logic errors, security issues, error-handling gaps. \
         Report findings concisely as markdown with file:line references. Do not modify any files.\n\n{body}"
    );
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            emit_note(format!("can't locate the agent binary: {e}"));
            return;
        }
    };
    let root = deps.root.clone();
    emit_note("code review running — the sub-agent will report back…");
    std::thread::spawn(move || {
        let out = std::process::Command::new(exe)
            .args(["--task", &prompt])
            .current_dir(&root)
            .stdin(std::process::Stdio::null())
            .output();
        match out {
            Ok(o) if !o.stdout.is_empty() => {
                emit(json!({
                    "type": "markdown", "title": "Code review",
                    "text": String::from_utf8_lossy(&o.stdout).to_string(),
                }));
            }
            Ok(o) => emit_note(format!(
                "review failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => emit_note(format!("couldn't spawn review agent: {e}")),
        }
    });
}

fn handle_command(sh: &Arc<Shared>, deps: &DepsInfo, raw: &str) {
    let name = raw.split_whitespace().next().unwrap_or("");
    match name {
        "/review" => {
            let arg = raw.split_whitespace().nth(1);
            if arg == Some("agent") {
                run_agent_review(deps);
            } else {
                let diff =
                    git_out(&deps.root, &["diff"]) + &git_out(&deps.root, &["diff", "--cached"]);
                let untracked =
                    git_out(&deps.root, &["ls-files", "--others", "--exclude-standard"]);
                let untracked = untracked.trim();
                if !diff.trim().is_empty() {
                    emit(json!({"type": "diff_card", "title": "working tree", "diff": diff}));
                    if !untracked.is_empty() {
                        emit_note(format!("untracked: {} file(s)", untracked.lines().count()));
                    }
                } else {
                    emit_note(if untracked.is_empty() {
                        "No changes.".to_string()
                    } else {
                        format!("untracked: {} file(s)", untracked.lines().count())
                    });
                }
            }
        }
        "/status" => show_status(sh, &deps.root, &deps.project, &deps.version),
        "/settings" => open_settings_menu(sh),
        "/approval" => match raw
            .trim()
            .get("/approval".len()..)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(mode) => set_approval_mode_by_name(sh, mode),
            None => open_approval_menu(sh),
        },
        "/model" => match raw
            .trim()
            .get("/model".len()..)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(m) => set_model(sh, m),
            None => open_model_menu(sh),
        },
        "/models" => emit(json!({"type": "models", "items": model_options(sh)})),
        "/effort" => match raw
            .trim()
            .get("/effort".len()..)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(level) => set_effort(sh, level),
            None => open_effort_menu(sh),
        },
        "/provider" | "/providers" => open_provider_menu(sh),
        "/setup" => run_onboarding(sh),
        "/undo" => {
            let out = {
                let s = sh.session.lock().unwrap();
                s.as_ref().and_then(|s| undo_checkpoint(&deps.root, &s.id))
            };
            emit_note(match out {
                Some(o) => {
                    let seq = o.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
                    let restored: Vec<String> = o
                        .get("restored")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let removed: Vec<String> = o
                        .get("removed")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let mut t = format!("restored checkpoint {seq}");
                    if !restored.is_empty() {
                        t.push_str(&format!(" — restored {}", restored.join(", ")));
                    }
                    if !removed.is_empty() {
                        t.push_str(&format!(" — removed {}", removed.join(", ")));
                    }
                    let unsnapshotted: Vec<String> = o
                        .get("unsnapshotted")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    if !unsnapshotted.is_empty() {
                        t.push_str(&format!(
                            " — could not restore {} (no snapshot)",
                            unsnapshotted.join(", ")
                        ));
                    }
                    if let Some(hm) = o.get("headMoved") {
                        let from = hm.get("from").and_then(|v| v.as_str()).unwrap_or("");
                        let to = hm.get("to").and_then(|v| v.as_str()).unwrap_or("");
                        t.push_str(&format!(
                            " — note: HEAD moved ({} → {}) since this checkpoint",
                            &from[..from.len().min(7)],
                            &to[..to.len().min(7)]
                        ));
                    }
                    t
                }
                None => "nothing to undo".into(),
            });
        }
        "/compact" => {
            let mut s = sh.session.lock().unwrap();
            match s.as_mut() {
                Some(sess) if !sess.messages.is_empty() => {
                    match compact_messages(&mut sess.messages, 60_000, true) {
                        Some((before, after, blocks)) => {
                            save_session(sess);
                            emit_note(format!(
                                "compacted context — {blocks} old result(s) summarized (~{} → ~{} tok)",
                                fmt_tokens(before),
                                fmt_tokens(after)
                            ));
                        }
                        None => emit_note(format!(
                            "context already compact (~{} tok)",
                            fmt_tokens(estimate_tokens(&sess.messages))
                        )),
                    }
                }
                _ => emit_note("no session context to compact yet"),
            }
        }
        "/docs" => emit(json!({"type": "markdown", "title": "Docs", "text": DOCS_MD})),
        "/changelog" => {
            emit(json!({"type": "markdown", "title": "Changelog", "text": CHANGELOG_MD}))
        }
        "/resume" => {
            let past: Vec<SessionRecord> = list_sessions()
                .into_iter()
                .filter(|s| s.project_root == deps.root)
                .take(12)
                .collect();
            if past.is_empty() {
                emit_note("no sessions for this project yet");
                return;
            }
            let opts: Vec<Value> = past
                .iter()
                .map(|s| json!({
                    "label": format!("{} — {}", s.updated_at.chars().take(16).collect::<String>().replace('T', " "), s.task.chars().take(60).collect::<String>().replace('\n', " ")),
                    "desc": s.id.chars().take(8).collect::<String>(),
                }))
                .collect();
            let Some(i) = sh.menu("Resume a session", opts, None) else {
                return;
            };
            let Some(picked) = load_session(&past[i].id) else {
                emit(crate::errors::event(
                    &format!("session {} is unreadable", past[i].id),
                    None,
                    None,
                ));
                return;
            };
            *sh.session.lock().unwrap() = Some(picked.clone());
            sh.allowlist.lock().unwrap().clear();
            sh.emit_session();
            Shared::emit_history(&picked);
            emit_note(format!(
                "resumed session {} — {} message(s) restored",
                picked.id.chars().take(8).collect::<String>(),
                picked.messages.len()
            ));
        }
        "/new" => {
            *sh.session.lock().unwrap() = None;
            sh.allowlist.lock().unwrap().clear();
            emit(json!({"type": "session", "id": null, "tokens": 0}));
            emit_note("new session — context and session approvals reset");
        }
        "/help" => emit(json!({
            "type": "markdown",
            "title": "Commands",
            "text": COMMAND_LIST.iter().map(|(n, d)| format!("**`{n}`** — {d}")).collect::<Vec<_>>().join("\n"),
        })),
        "/exit" | "exit" | "quit" => {
            emit(json!({"type": "exit"}));
            std::process::exit(0);
        }
        _ => emit_note(format!("unknown command {name} — /help lists commands")),
    }
}

struct DepsInfo {
    root: String,
    project: ProjectInfo,
    version: String,
    plan_only: bool,
    max_iterations: Option<u32>,
}

/* ------------------------------- task runs ------------------------------- */

fn run_once(sh: &Arc<Shared>, deps: &DepsInfo, task: &str) {
    emit(json!({"type": "user", "text": task}));
    sh.aborted.store(false, Ordering::Relaxed);
    *sh.turn_tokens.lock().unwrap() = 0;

    let mut approve_plan = |plan: &Value| -> bool {
        if sh.auto_approve.load(Ordering::Relaxed) {
            emit_note("auto-approved plan");
            return true;
        }
        let summary = plan.get("summary").and_then(|v| v.as_str()).unwrap_or("");
        let steps: Vec<String> = plan
            .get("steps")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .enumerate()
                    .filter_map(|(i, s)| s.as_str().map(|s| format!("{}. {}", i + 1, s)))
                    .collect()
            })
            .unwrap_or_default();
        let body = std::iter::once(summary.to_string())
            .chain(steps)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let choice = sh.ask("plan", &body, None, None);
        if choice == "s" {
            // Persist the approved plan to the repo so it survives sessions and
            // can be versioned alongside the code.
            let dir = std::path::Path::new(&deps.root).join(".dxxpcode");
            let steps_md: Vec<String> = plan
                .get("steps")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(|s| format!("- [ ] {s}")))
                        .collect()
                })
                .unwrap_or_default();
            let md = format!("# Plan\n\n{summary}\n\n{}\n", steps_md.join("\n"));
            match std::fs::create_dir_all(&dir)
                .and_then(|_| std::fs::write(dir.join("plan.md"), &md))
            {
                Ok(()) => emit_note("plan saved to .dxxpcode/plan.md"),
                Err(e) => emit_note(format!("couldn't save plan: {e}")),
            }
        }
        choice == "y" || choice == "a" || choice == "s"
    };

    let mut approve_tool =
        |tool: &str, input: &Value, reason: &str, model_reason: Option<&str>| -> bool {
            let summary = describe(tool, input);
            let scope = approve_scope(tool, input);
            if sh.allowlist.lock().unwrap().contains(&scope) {
                emit_note(format!("allowed earlier this session: {scope}"));
                return true;
            }
            if sh.auto_approve.load(Ordering::Relaxed) {
                emit_note(format!("auto-approved: {summary}"));
                return true;
            }
            if sh.smart_mode.load(Ordering::Relaxed) {
                if let Some(k) = sh.jev_key() {
                    if let Some((approve, conf)) =
                        smart_approve(tool, input, model_reason, reason, &k)
                    {
                        if approve {
                            emit_note(format!("smart-approved (jev {conf:.2}): {summary}"));
                            return true;
                        }
                        emit_note(format!("jev escalated ({conf:.2})"));
                    }
                }
            }
            let choice = sh.ask(
                "tool",
                &summary,
                Some(model_reason.unwrap_or(reason)),
                Some(tool),
            );
            if choice == "a" {
                sh.allowlist.lock().unwrap().insert(scope);
                return true;
            }
            choice == "y"
        };

    // Pre-write diff review: in "always approve" mode diffs apply silently
    // (the applied diff still lands in the transcript via tool_end).
    let mut review_change = |_tool: &str, input: &Value, diff: &str| -> bool {
        if sh.auto_approve.load(Ordering::Relaxed) {
            return true;
        }
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match sh.review_diff(&path, diff).as_str() {
            "apply" => true,
            "apply_all" => {
                sh.diff_apply_all.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    };

    let mentions = expand_mentions(task, &deps.root);
    for a in &mentions.attached {
        emit_note(format!("attached {a}"));
    }
    for s in &mentions.skipped {
        emit_note(format!("skipped @{}: {}", s.0, s.1));
    }
    let jev = sh.jev_key();
    let effort = if load_config().effort_auto == Some(true) {
        jev.as_deref()
            .and_then(|k| jev_route_effort(&mentions.text, k))
            .or_else(|| sh.effort.lock().unwrap().clone())
    } else {
        sh.effort.lock().unwrap().clone()
    };

    // Take the provider for the duration of the run (menus block on it anyway).
    let provider_opt = sh.provider.lock().unwrap().take();
    let Some(mut provider) = provider_opt else {
        emit(json!({"type": "done", "result": {
            "status": "error", "summary": "Failed", "error": "no provider",
            "filesChanged": [], "commands": [], "toolCalls": 0,
            "sessionId": sh.session.lock().unwrap().as_ref().map(|s| s.id.clone()).unwrap_or_default(),
        }}));
        emit(json!({"type": "idle"}));
        return;
    };

    let session_for_run = sh.session.lock().unwrap().take();
    let sh_steer = Arc::clone(sh);
    let mut steer = move || sh_steer.steer_queue.lock().unwrap().pop_front();

    // A resumed session keeps its own mode; otherwise use the toggle.
    let chat = session_for_run
        .as_ref()
        .and_then(|s| s.mode.as_deref())
        .map(|m| m == "chat")
        .unwrap_or_else(|| *sh.chat_mode.lock().unwrap());

    let mut opts = agent::RunOpts {
        task: mentions.text,
        provider: &mut provider,
        model: sh.model.lock().unwrap().clone(),
        project_root: deps.root.clone(),
        plan_only: deps.plan_only,
        max_iterations: deps.max_iterations,
        approve_plan: &mut approve_plan,
        approve_tool: &mut approve_tool,
        review_change: &mut review_change,
        session: session_for_run,
        chat,
        effort,
        aborted: Arc::clone(&sh.aborted),
        steer: &mut steer,
        procs: Arc::clone(&sh.procs),
    };

    agent::run_task(&mut opts, &mut |ev| {
        if ev.get("type").and_then(|t| t.as_str()) == Some("usage") {
            let u = ev.get("usage").cloned().unwrap_or(json!({}));
            *sh.turn_tokens.lock().unwrap() =
                (u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0)
                    + u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0))
                    as usize;
        }
        if ev.get("type").and_then(|t| t.as_str()) == Some("done") {
            if let Some(sid) = ev.pointer("/result/sessionId").and_then(|v| v.as_str()) {
                if !sid.is_empty() {
                    if let Some(s) = load_session(sid) {
                        *sh.session.lock().unwrap() = Some(s);
                        sh.emit_session();
                    }
                }
            }
        }
        emit(ev);
    });
    *sh.provider.lock().unwrap() = Some(provider);
    emit(json!({"type": "idle"}));
}

fn pump(sh: Arc<Shared>, deps: Arc<DepsInfo>) {
    std::thread::spawn(move || {
        // Guard: single pump thread.
        if sh.running.swap(true, Ordering::SeqCst) {
            return;
        }
        loop {
            let task = sh.task_queue.lock().unwrap().pop_front();
            let Some(task) = task else { break };
            run_once(&sh, &deps, &task);
            // Steering text queued as the run wound down becomes the next task.
            while let Some(next) = sh.steer_queue.lock().unwrap().pop_front() {
                run_once(&sh, &deps, &next);
            }
        }
        sh.running.store(false, Ordering::SeqCst);
        // A submit may have raced the final empty check.
        if !sh.task_queue.lock().unwrap().is_empty() {
            pump(Arc::clone(&sh), Arc::clone(&deps));
        }
    });
}

/* --------------------------------- main ---------------------------------- */

pub fn run_app(deps: AppDeps) -> i32 {
    let mut cfg = deps.config;
    if cfg.install_id.is_none() {
        cfg.install_id = Some(format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u32>(),
            rand::random::<u16>(),
            0x4000u16 | (rand::random::<u16>() & 0x0fff),
            0x8000u16 | (rand::random::<u16>() & 0x3fff),
            rand::random::<u64>() & 0xffffffffffff,
        ));
        save_config(&cfg);
    }

    let needs_setup = std::env::var("ANTHROPIC_API_KEY").is_err()
        && std::env::var("OPENAI_API_KEY").is_err()
        && cfg.anthropic_api_key.is_none()
        && cfg.openai_api_key.is_none();

    let provider_label = deps.provider.name().to_string();
    let sh = Arc::new(Shared {
        provider_name: Mutex::new(provider_label.clone()),
        model: Mutex::new(deps.model.clone()),
        effort: Mutex::new(deps.effort.clone()),
        auto_approve: AtomicBool::new(deps.auto_approve),
        smart_mode: AtomicBool::new(deps.smart_approve_mode),
        mode: Mutex::new(deps.mode.clone()),
        chat_mode: Mutex::new(false),
        session: Mutex::new(deps.session),
        allowlist: Mutex::new(HashSet::new()),
        next_id: Mutex::new(1),
        pending_approvals: Mutex::new(HashMap::new()),
        pending_selects: Mutex::new(HashMap::new()),
        pending_prompts: Mutex::new(HashMap::new()),
        pending_diffs: Mutex::new(HashMap::new()),
        diff_apply_all: AtomicBool::new(false),
        steer_queue: Mutex::new(VecDeque::new()),
        task_queue: Mutex::new(VecDeque::new()),
        running: AtomicBool::new(false),
        aborted: Arc::new(AtomicBool::new(false)),
        turn_tokens: Mutex::new(0),
        provider: Mutex::new(Some(deps.provider)),
        procs: tools::load_procs(&deps.root),
    });

    let dinfo = Arc::new(DepsInfo {
        root: deps.root.clone(),
        project: deps.project.clone(),
        version: deps.version.clone(),
        plan_only: deps.plan_only,
        max_iterations: deps.max_iterations,
    });

    emit(json!({
        "type": "ready",
        "version": deps.version,
        "provider": provider_label,
        "model": deps.model,
        "effort": deps.effort,
        "mode": deps.mode,
        "commands": COMMAND_LIST.iter().map(|(n, d)| json!({"name": n, "desc": d})).collect::<Vec<_>>(),
        "needsSetup": needs_setup,
        "project": deps.project.to_json(),
    }));
    sh.emit_session();

    let inbox: Arc<Mutex<VecDeque<Value>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stdin_inbox = Arc::clone(&inbox);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in BufReader::new(stdin.lock()).lines() {
            match line {
                Ok(l) => {
                    let l = l.trim().to_string();
                    if l.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(&l) {
                        stdin_inbox.lock().unwrap().push_back(v);
                    }
                }
                Err(_) => break,
            }
        }
        // stdin EOF → exit
        emit(json!({"type": "exit"}));
        std::process::exit(0);
    });

    let mut file_index: Option<FileIndex> = None;

    loop {
        let cmd = inbox.lock().unwrap().pop_front();
        let Some(cmd) = cmd else {
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        };
        let ty = cmd.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "submit" => {
                if let Some(text) = cmd.get("text").and_then(|t| t.as_str()) {
                    let text = text.trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    if text.starts_with('/') {
                        let sh2 = Arc::clone(&sh);
                        let d2 = Arc::clone(&dinfo);
                        let t2 = text.clone();
                        std::thread::spawn(move || handle_command(&sh2, &d2, &t2));
                    } else if sh.running.load(Ordering::SeqCst) {
                        sh.steer_queue.lock().unwrap().push_back(text.clone());
                        emit(json!({"type": "steer", "text": text}));
                    } else {
                        sh.task_queue.lock().unwrap().push_back(text);
                        pump(Arc::clone(&sh), Arc::clone(&dinfo));
                    }
                }
            }
            "command" => {
                if let Some(name) = cmd.get("name").and_then(|t| t.as_str()) {
                    let sh2 = Arc::clone(&sh);
                    let d2 = Arc::clone(&dinfo);
                    let n = name.to_string();
                    std::thread::spawn(move || handle_command(&sh2, &d2, &n));
                }
            }
            // Code/chat mode toggle — {type:"mode", mode:"code"|"chat"}.
            "mode" => {
                let m = cmd.get("mode").and_then(|v| v.as_str()).unwrap_or("code");
                let m = if m == "chat" { "chat" } else { "code" };
                *sh.chat_mode.lock().unwrap() = m == "chat";
                if let Some(s) = sh.session.lock().unwrap().as_mut() {
                    s.mode = Some(m.to_string());
                    save_session(s);
                }
                emit(json!({"type": "mode", "mode": m}));
                if sh.running.load(Ordering::SeqCst) {
                    emit_note(format!("mode: {m} — applies to the next task"));
                }
            }
            // Onboarding wizard: validate a provider key (or pick the demo),
            // then save + switch. Replies with {"type":"setup_result", ...}.
            "setup" => {
                let sh2 = Arc::clone(&sh);
                let c = cmd.clone();
                std::thread::spawn(move || run_wizard_setup(&sh2, &c));
            }
            "approve" => {
                if let Some(id) = cmd.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = sh.pending_approvals.lock().unwrap().remove(&id) {
                        let choice = cmd.get("choice").and_then(|v| v.as_str()).unwrap_or("n");
                        let _ = tx.send(choice.to_string());
                    }
                }
            }
            "select" => {
                if let Some(id) = cmd.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = sh.pending_selects.lock().unwrap().remove(&id) {
                        let idx = cmd.get("index").and_then(|v| v.as_i64()).unwrap_or(-1);
                        let _ = tx.send(if idx >= 0 { Some(idx as usize) } else { None });
                    }
                }
            }
            "diff_decide" => {
                if let Some(id) = cmd.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = sh.pending_diffs.lock().unwrap().remove(&id) {
                        let decision = cmd
                            .get("decision")
                            .and_then(|v| v.as_str())
                            .unwrap_or("discard");
                        let _ = tx.send(decision.to_string());
                    }
                }
            }
            "prompt_submit" => {
                if let Some(id) = cmd.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = sh.pending_prompts.lock().unwrap().remove(&id) {
                        let text = cmd.get("text").and_then(|v| v.as_str()).map(String::from);
                        let _ = tx.send(text.filter(|t| !t.is_empty()));
                    }
                }
            }
            "list_files" => {
                if let Some(id) = cmd.get("id").and_then(|v| v.as_u64()) {
                    if file_index.is_none() {
                        file_index = Some(list_project_files(&dinfo.root));
                    }
                    let prefix = cmd.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let items: Vec<Value> = file_suggestions(file_index.as_ref().unwrap(), prefix)
                        .into_iter()
                        .map(|(name, desc)| json!({"name": name, "desc": desc}))
                        .collect();
                    emit(json!({"type": "files", "id": id, "items": items}));
                }
            }
            "cancel" => {
                sh.aborted.store(true, Ordering::SeqCst);
            }
            // Sidebar: emit the project's recent sessions for the picker.
            "sessions" => {
                let past: Vec<SessionRecord> = list_sessions()
                    .into_iter()
                    .filter(|s| s.project_root == dinfo.root)
                    .take(20)
                    .collect();
                let items: Vec<Value> = past
                    .iter()
                    .map(|s| {
                        json!({
                            "id": &s.id,
                            "title": s.task.chars().take(80).collect::<String>().replace('\n', " "),
                            "desc": s.updated_at.chars().take(10).collect::<String>(),
                        })
                    })
                    .collect();
                emit(json!({"type": "sessions", "items": items}));
            }
            "resume" => {
                if let Some(id) = cmd.get("id").and_then(|v| v.as_str()) {
                    match load_session(id) {
                        Some(picked) => {
                            *sh.session.lock().unwrap() = Some(picked.clone());
                            sh.allowlist.lock().unwrap().clear();
                            sh.emit_session();
                            Shared::emit_history(&picked);
                            emit_note(format!(
                                "resumed session {} — {} message(s) restored",
                                picked.id.chars().take(8).collect::<String>(),
                                picked.messages.len()
                            ));
                        }
                        None => emit(crate::errors::event(
                            &format!("session {id} is unreadable"),
                            None,
                            None,
                        )),
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approve_scope_uses_command_head() {
        for (cmd, want) in [
            ("npm test -- --watch", "run_command:npm test"),
            ("cargo build | tail", "run_command:cargo build"),
            ("cargo test", "run_command:cargo test"),
            ("ls -la", "run_command:ls -la"),
        ] {
            let i = json!({"command": cmd});
            assert_eq!(approve_scope("run_command", &i), want, "{cmd}");
        }
        let f = json!({"path": "src/a.rs"});
        assert_eq!(approve_scope("write_file", &f), "write_file src/a.rs");
    }
}

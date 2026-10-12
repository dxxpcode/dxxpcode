//! `dxxpcode serve` — local HTTP API over the agent loop.
//!
//! Bind: 127.0.0.1 by default; `--lan` binds 0.0.0.0 so LAN clients (e.g. a
//! companion phone app) can reach it. Every route requires
//! `Authorization: Bearer <token>` except GET /health; the token is
//! auto-generated (0600) at ~/.dxxpcode/api-token on first run.
//!
//!   GET    /health               {name, version, api} — unauthenticated (pairing)
//!   POST   /tasks                {prompt, cwd?, model?, effort?, variant?, mode?,
//!                                 autoApprove?, planOnly?, approvedPlan?}
//!   GET    /tasks                list
//!   GET    /tasks/:id            status + result
//!   GET    /tasks/:id/events     SSE stream of agent events (replays history;
//!                                honors Last-Event-ID)
//!   POST   /tasks/:id/input      {"type":"steer","text"} |
//!                                {"type":"approve","id"?,"choice":"y"|"n"|"always","plan"?}
//!   DELETE /tasks/:id            interrupt the run (esc equivalent)
//!   GET    /projects             project roots seen in saved sessions, newest first
//!   GET    /sessions             saved-session summaries (newest first, ?limit=)

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::{agent, config, provider, tools};

const PORT: u16 = 8787;

/// An approval answer: allowed yes/no plus an optional edited plan payload
/// (set by {"type":"approve", "plan": ...} on plan-kind approvals).
type ApprovalAnswer = (bool, Option<Value>);

struct TaskState {
    id: String,
    status: Mutex<String>, // queued | running | approval | completed | error | aborted
    events: Mutex<Vec<Value>>,
    cv: Condvar,
    /// Id-less answers, FIFO — preserved semantics for callers that don't send "id".
    approvals: Mutex<VecDeque<ApprovalAnswer>>,
    /// Answers targeted at a specific approval id.
    resolved: Mutex<HashMap<u64, ApprovalAnswer>>,
    approve_cv: Condvar,
    next_approval_id: AtomicU64,
    /// "always" on any approval (or autoApprove at spawn): auto-approve tool and
    /// diff approvals for the rest of this task. Plan approvals still ask.
    auto_rest: AtomicBool,
    steer: Mutex<VecDeque<String>>,
    aborted: Arc<AtomicBool>,
    task_text: Mutex<String>,
    project_root: Mutex<String>,
    result: Mutex<Option<Value>>,
}

impl TaskState {
    fn emit(&self, ev: Value) {
        if ev.get("type").and_then(|t| t.as_str()) == Some("done") {
            if let Some(res) = ev.get("result") {
                *self.result.lock().unwrap() = Some(res.clone());
                *self.status.lock().unwrap() = res
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("completed")
                    .to_string();
            }
        }
        self.events.lock().unwrap().push(ev);
        self.cv.notify_all();
    }

    fn wait_approval(&self, what: Value) -> ApprovalAnswer {
        let id = self.next_approval_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.emit(json!({"type": "approval", "id": id, "detail": what}));
        *self.status.lock().unwrap() = "approval".into();
        self.cv.notify_all();
        let mut q = self.approvals.lock().unwrap();
        loop {
            if self.aborted.load(Ordering::SeqCst) {
                return (false, None);
            }
            if let Some(ans) = self.resolved.lock().unwrap().remove(&id) {
                *self.status.lock().unwrap() = "running".into();
                self.cv.notify_all();
                return ans;
            }
            if let Some(ans) = q.pop_front() {
                *self.status.lock().unwrap() = "running".into();
                self.cv.notify_all();
                return ans;
            }
            q = self.approve_cv.wait(q).unwrap();
        }
    }
}

struct Serve {
    cfg: config::Config,
    tasks: Mutex<HashMap<String, Arc<TaskState>>>,
    root: String,
}

fn token_path() -> std::path::PathBuf {
    config::home_dir().join("api-token")
}

/// The API token, generated (0600) on first run.
pub fn api_token() -> String {
    let path = token_path();
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let _ = std::fs::create_dir_all(config::home_dir());
    let token = format!(
        "dxp_{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    );
    let _ = std::fs::write(&path, &token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    token
}

/// Best-effort primary LAN address for the pair-URL hint; no packets are sent.
fn lan_ip() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

pub fn run(args: &[String]) -> i32 {
    let lan = args.iter().any(|a| a == "--lan");
    let token = api_token();
    let root = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into());
    let srv = Arc::new(Serve {
        cfg: config::load_config(),
        tasks: Mutex::new(HashMap::new()),
        root,
    });

    let bind = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener = match TcpListener::bind((bind, PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("dxxpcode serve: cannot bind {bind}:{PORT}: {e}");
            return 1;
        }
    };
    eprintln!("dxxpcode serve listening on http://{bind}:{PORT}");
    eprintln!("token: {token}  (saved in {})", token_path().display());
    if lan {
        eprintln!("warning: --lan exposes this API to your local network (bearer token required)");
        if let Some(ip) = lan_ip() {
            eprintln!("pair: dxxpcode://pair?host={ip}&port={PORT}&token={token}&v=1");
        }
    }

    for stream in listener.incoming().flatten() {
        let srv = Arc::clone(&srv);
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = handle_conn(stream, srv, token);
        });
    }
    0
}

struct Request {
    method: String,
    path: String,
    auth_ok: bool,
    last_event_id: Option<usize>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream, token: &str) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut auth_ok = false;
    let mut content_len = 0usize;
    let mut last_event_id: Option<usize> = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return None;
        }
        let h = header.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("authorization") {
                auth_ok = v.trim() == format!("Bearer {token}");
            } else if k.eq_ignore_ascii_case("content-length") {
                content_len = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("last-event-id") {
                last_event_id = v.trim().parse().ok();
            }
        }
    }
    let mut body = vec![0u8; content_len.min(1 << 20)];
    if content_len > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    Some(Request {
        method,
        path,
        auth_ok,
        last_event_id,
        body,
    })
}

fn write_resp(stream: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn json_ok(stream: &mut TcpStream, v: Value) {
    write_resp(stream, "200 OK", &v.to_string());
}

fn json_err(stream: &mut TcpStream, status: &str, msg: &str) {
    write_resp(stream, status, &json!({"error": msg}).to_string());
}

fn task_summary(t: &Arc<TaskState>) -> Value {
    json!({
        "task_id": t.id,
        "status": *t.status.lock().unwrap(),
        "task": t.task_text.lock().unwrap().clone(),
        "project_root": t.project_root.lock().unwrap().clone(),
        "result": t.result.lock().unwrap().clone(),
    })
}

fn spawn_task(srv: &Arc<Serve>, body: &Value) -> Result<Arc<TaskState>, String> {
    let prompt = body
        .get("prompt")
        .and_then(|p| p.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("missing \"prompt\"")?
        .to_string();
    let cwd = body
        .get("cwd")
        .and_then(|c| c.as_str())
        .map(String::from)
        .unwrap_or_else(|| srv.root.clone());
    if !Path::new(&cwd).is_dir() {
        return Err(format!("cwd not a directory: {cwd}"));
    }
    let mode = body
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("code")
        .to_string();
    if mode != "code" && mode != "chat" {
        return Err("mode must be \"code\" or \"chat\"".into());
    }
    let chat = mode == "chat";
    let effort = body
        .get("effort")
        .and_then(|e| e.as_str())
        .map(String::from)
        .or_else(|| srv.cfg.effort.clone());
    let variant_opts = body
        .get("variant")
        .and_then(|s| s.as_str())
        .map(String::from)
        .or_else(|| srv.cfg.variant.clone())
        .filter(|s| s != "default")
        .and_then(|n| srv.cfg.variants.as_ref().and_then(|v| v.get(&n).cloned()));
    let model_override = body.get("model").and_then(|m| m.as_str()).map(String::from);
    let auto = body
        .get("autoApprove")
        .and_then(|a| a.as_bool())
        .unwrap_or(false);
    let plan_only = body
        .get("planOnly")
        .and_then(|p| p.as_bool())
        .unwrap_or(false);
    let approved_plan = body.get("approvedPlan").cloned();
    if plan_only && approved_plan.is_some() {
        return Err("approvedPlan can't be combined with planOnly".into());
    }

    let (mut provider, model) =
        provider::resolve_provider(None, model_override.as_deref(), &srv.cfg)
            .map_err(|e| format!("provider: {e}"))?;

    let id = format!(
        "{:08x}-{:04x}",
        rand::random::<u32>(),
        rand::random::<u16>()
    );
    let t = Arc::new(TaskState {
        id: id.clone(),
        status: Mutex::new("queued".into()),
        events: Mutex::new(vec![]),
        cv: Condvar::new(),
        approvals: Mutex::new(VecDeque::new()),
        resolved: Mutex::new(HashMap::new()),
        approve_cv: Condvar::new(),
        next_approval_id: AtomicU64::new(0),
        auto_rest: AtomicBool::new(auto),
        steer: Mutex::new(VecDeque::new()),
        aborted: Arc::new(AtomicBool::new(false)),
        task_text: Mutex::new(prompt.clone()),
        project_root: Mutex::new(cwd.clone()),
        result: Mutex::new(None),
    });
    srv.tasks.lock().unwrap().insert(id.clone(), Arc::clone(&t));

    let t2 = Arc::clone(&t);
    let aborted = Arc::clone(&t.aborted);
    let max_iter = srv.cfg.max_iterations;
    let procs = tools::load_procs(&cwd);
    std::thread::spawn(move || {
        *t2.status.lock().unwrap() = "running".into();
        t2.cv.notify_all();
        let ts_plan = Arc::clone(&t2);
        let ts_tool = Arc::clone(&t2);
        let ts_rev = Arc::clone(&t2);
        let ts_steer = Arc::clone(&t2);
        let mut approve_plan = move |plan: &Value| {
            let (yes, edited) = ts_plan.wait_approval(json!({"kind": "plan", "plan": plan}));
            yes.then(|| edited.unwrap_or_else(|| plan.clone()))
        };
        let mut approve_tool =
            move |name: &str, input: &Value, reason: &str, hint: Option<&str>| {
                ts_tool.auto_rest.load(Ordering::SeqCst)
                    || ts_tool
                        .wait_approval(json!({
                            "kind": "tool", "tool": name, "input": input,
                            "reason": reason, "hint": hint,
                        }))
                        .0
            };
        let mut review_change = move |name: &str, input: &Value, diff: &str| {
            ts_rev.auto_rest.load(Ordering::SeqCst)
                || ts_rev
                    .wait_approval(json!({
                        "kind": "diff", "tool": name, "input": input, "diff": diff,
                    }))
                    .0
        };
        let mut steer = move || ts_steer.steer.lock().unwrap().pop_front();
        let mut opts = agent::RunOpts {
            task: prompt,
            provider: &mut provider,
            model,
            project_root: cwd.clone(),
            plan_only,
            approved_plan,
            max_iterations: max_iter,
            approve_plan: &mut approve_plan,
            approve_tool: &mut approve_tool,
            review_change: &mut review_change,
            session: None,
            chat,
            effort,
            variant_opts,
            aborted,
            steer: &mut steer,
            procs,
        };
        let t3 = Arc::clone(&t2);
        agent::run_task(&mut opts, &mut |ev| t3.emit(ev));
        let mut st = t2.status.lock().unwrap();
        if *st == "running" || *st == "approval" {
            *st = if t2.aborted.load(Ordering::SeqCst) {
                "aborted".into()
            } else {
                "completed".into()
            };
        }
        drop(st);
        t2.emit(json!({"type": "exit"}));
    });
    Ok(t)
}

fn handle_conn(mut stream: TcpStream, srv: Arc<Serve>, token: String) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream, &token) else {
        return Ok(());
    };
    route(&mut stream, &srv, &req);
    Ok(())
}

fn query_param<'a>(path: &'a str, key: &str) -> Option<&'a str> {
    path.split('?').nth(1)?.split('&').find_map(|kv| {
        kv.split_once('=')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v)
    })
}

fn route(stream: &mut TcpStream, srv: &Arc<Serve>, req: &Request) {
    let segs: Vec<&str> = req
        .path
        .split('?')
        .next()
        .unwrap_or("")
        .trim_matches('/')
        .split('/')
        .collect();

    // Pairing probe — unauthenticated by design.
    if req.method == "GET" && segs.as_slice() == ["health"] {
        return json_ok(
            stream,
            json!({"name": "dxxpcode", "version": env!("CARGO_PKG_VERSION"), "api": 1}),
        );
    }
    if !req.auth_ok {
        return json_err(stream, "401 Unauthorized", "missing or bad bearer token");
    }

    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["projects"]) => {
            let mut latest: HashMap<String, String> = HashMap::new();
            for s in config::list_sessions() {
                latest
                    .entry(s.project_root.clone())
                    .and_modify(|u| {
                        if s.updated_at > *u {
                            *u = s.updated_at.clone();
                        }
                    })
                    .or_insert(s.updated_at.clone());
            }
            let mut rows: Vec<_> = latest.into_iter().collect();
            rows.sort_by(|a, b| b.1.cmp(&a.1));
            json_ok(
                stream,
                json!(rows
                    .into_iter()
                    .map(|(root, used)| {
                        let name = root
                            .rsplit('/')
                            .find(|s| !s.is_empty())
                            .unwrap_or(root.as_str());
                        json!({"root": root, "name": name, "last_used": used})
                    })
                    .collect::<Vec<_>>()),
            )
        }
        ("GET", ["sessions"]) => {
            let mut recs = config::list_sessions();
            recs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let limit = query_param(&req.path, "limit")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(50);
            recs.truncate(limit);
            json_ok(
                stream,
                json!(recs
                    .iter()
                    .map(|s| json!({
                        "id": s.id,
                        "project_root": s.project_root,
                        "task": s.task,
                        "title": s.title,
                        "updated_at": s.updated_at,
                        "files_changed": s.files_changed.len(),
                        "result": s.result,
                        "pinned": s.pinned,
                    }))
                    .collect::<Vec<_>>()),
            )
        }
        ("POST", ["tasks"]) => {
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
            match spawn_task(srv, &body) {
                Ok(t) => json_ok(
                    stream,
                    json!({"task_id": t.id, "status": *t.status.lock().unwrap()}),
                ),
                Err(e) => json_err(stream, "400 Bad Request", &e),
            }
        }
        ("GET", ["tasks"]) => {
            let tasks = srv.tasks.lock().unwrap();
            json_ok(
                stream,
                json!(tasks.values().map(task_summary).collect::<Vec<_>>()),
            )
        }
        ("GET", ["tasks", id]) => match srv.tasks.lock().unwrap().get(*id) {
            Some(t) => json_ok(stream, task_summary(t)),
            None => json_err(stream, "404 Not Found", "unknown task"),
        },
        ("DELETE", ["tasks", id]) => {
            let t = srv.tasks.lock().unwrap().get(*id).cloned();
            match t {
                Some(t) => {
                    t.aborted.store(true, Ordering::SeqCst);
                    t.approve_cv.notify_all();
                    t.cv.notify_all();
                    json_ok(stream, json!({"task_id": t.id, "status": "aborting"}))
                }
                None => json_err(stream, "404 Not Found", "unknown task"),
            }
        }
        ("POST", ["tasks", id, "input"]) => {
            let t = srv.tasks.lock().unwrap().get(*id).cloned();
            let Some(t) = t else {
                return json_err(stream, "404 Not Found", "unknown task");
            };
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
            match body.get("type").and_then(|v| v.as_str()) {
                Some("steer") => {
                    let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if text.is_empty() {
                        return json_err(stream, "400 Bad Request", "missing text");
                    }
                    t.steer.lock().unwrap().push_back(text.to_string());
                    json_ok(stream, json!({"ok": true}))
                }
                Some("approve") => {
                    let choice = body.get("choice");
                    let choice_str = choice.and_then(|v| v.as_str());
                    let yes = matches!(
                        choice_str,
                        Some("y") | Some("yes") | Some("always") | Some("a")
                    ) || choice.and_then(|v| v.as_bool()) == Some(true);
                    // "always" auto-approves tool/diff prompts for the rest of
                    // the task (plan approvals still ask).
                    if matches!(choice_str, Some("always") | Some("a")) {
                        t.auto_rest.store(true, Ordering::SeqCst);
                    }
                    let plan = body.get("plan").cloned();
                    match body.get("id").and_then(|v| v.as_u64()) {
                        Some(id) => {
                            t.resolved.lock().unwrap().insert(id, (yes, plan));
                        }
                        None => {
                            t.approvals.lock().unwrap().push_back((yes, plan));
                        }
                    }
                    t.approve_cv.notify_all();
                    json_ok(stream, json!({"ok": true, "approved": yes}))
                }
                _ => json_err(
                    stream,
                    "400 Bad Request",
                    "type must be \"steer\" or \"approve\"",
                ),
            }
        }
        ("GET", ["tasks", id, "events"]) => {
            let t = srv.tasks.lock().unwrap().get(*id).cloned();
            match t {
                Some(t) => sse_events(stream, t, req.last_event_id),
                None => json_err(stream, "404 Not Found", "unknown task"),
            }
        }
        _ => json_err(stream, "404 Not Found", "no such route"),
    }
}

fn sse_events(stream: &mut TcpStream, t: Arc<TaskState>, last_event_id: Option<usize>) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    // Event ids are 0-based indices into the replayed history, so a
    // Last-Event-ID reconnect skips exactly the events already seen.
    let mut sent = last_event_id.map(|i| i + 1).unwrap_or(0);
    let mut finished = false;
    while !finished {
        {
            let mut evs = t.events.lock().unwrap();
            loop {
                while sent < evs.len() {
                    if stream
                        .write_all(format!("id: {sent}\ndata: {}\n\n", evs[sent]).as_bytes())
                        .is_err()
                    {
                        return;
                    }
                    sent += 1;
                }
                let st = t.status.lock().unwrap().clone();
                let terminal = !matches!(st.as_str(), "running" | "queued" | "approval")
                    && evs.iter().any(|e| {
                        matches!(
                            e.get("type").and_then(|v| v.as_str()),
                            Some("exit") | Some("done")
                        )
                    });
                if terminal {
                    finished = true;
                    break;
                }
                evs = t.cv.wait(evs).unwrap();
            }
        }
    }
}

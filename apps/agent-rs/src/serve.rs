//! `dxxpcode serve` — local HTTP API over the agent loop.
//!
//! Bind: 127.0.0.1 only. Every route requires `Authorization: Bearer <token>`;
//! the token is auto-generated (0600) at ~/.dxxpcode/api-token on first run.
//!
//!   POST   /tasks                {prompt, cwd?, model?, effort?, mode?, autoApprove?}
//!   GET    /tasks                list
//!   GET    /tasks/:id            status + result
//!   GET    /tasks/:id/events     SSE stream of agent events (replays history)
//!   POST   /tasks/:id/input      {"type":"steer","text"} | {"type":"approve","choice":"y"|"n"}
//!   DELETE /tasks/:id            interrupt the run (esc equivalent)

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::{agent, config, provider, tools};

const PORT: u16 = 8787;

struct TaskState {
    id: String,
    status: Mutex<String>, // queued | running | approval | completed | error | aborted
    events: Mutex<Vec<Value>>,
    cv: Condvar,
    approvals: Mutex<VecDeque<bool>>,
    approve_cv: Condvar,
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

    fn wait_approval(&self, what: Value) -> bool {
        self.emit(json!({"type": "approval", "detail": what}));
        *self.status.lock().unwrap() = "approval".into();
        self.cv.notify_all();
        let mut q = self.approvals.lock().unwrap();
        loop {
            if self.aborted.load(Ordering::SeqCst) {
                return false;
            }
            if let Some(yes) = q.pop_front() {
                *self.status.lock().unwrap() = "running".into();
                self.cv.notify_all();
                return yes;
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

pub fn run() -> i32 {
    let token = api_token();
    let root = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into());
    let srv = Arc::new(Serve {
        cfg: config::load_config(),
        tasks: Mutex::new(HashMap::new()),
        root,
    });

    let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("dxxpcode serve: cannot bind 127.0.0.1:{PORT}: {e}");
            return 1;
        }
    };
    eprintln!("dxxpcode serve listening on http://127.0.0.1:{PORT}");
    eprintln!("token: {token}  (saved in {})", token_path().display());

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
    let model_override = body.get("model").and_then(|m| m.as_str()).map(String::from);
    let auto = body
        .get("autoApprove")
        .and_then(|a| a.as_bool())
        .unwrap_or(false);

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
        approve_cv: Condvar::new(),
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
        let mut approve_plan =
            move |plan: &Value| ts_plan.wait_approval(json!({"kind": "plan", "plan": plan}));
        let mut approve_tool =
            move |name: &str, input: &Value, reason: &str, hint: Option<&str>| {
                auto || ts_tool.wait_approval(json!({
                    "kind": "tool", "tool": name, "input": input,
                    "reason": reason, "hint": hint,
                }))
            };
        let mut review_change = move |name: &str, input: &Value, diff: &str| {
            auto || ts_rev.wait_approval(json!({
                "kind": "diff", "tool": name, "input": input, "diff": diff,
            }))
        };
        let mut steer = move || ts_steer.steer.lock().unwrap().pop_front();
        let mut opts = agent::RunOpts {
            task: prompt,
            provider: &mut provider,
            model,
            project_root: cwd.clone(),
            plan_only: false,
            max_iterations: max_iter,
            approve_plan: &mut approve_plan,
            approve_tool: &mut approve_tool,
            review_change: &mut review_change,
            session: None,
            chat,
            effort,
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

fn route(stream: &mut TcpStream, srv: &Arc<Serve>, req: &Request) {
    if !req.auth_ok {
        return json_err(stream, "401 Unauthorized", "missing or bad bearer token");
    }
    let segs: Vec<&str> = req
        .path
        .split('?')
        .next()
        .unwrap_or("")
        .trim_matches('/')
        .split('/')
        .collect();

    match (req.method.as_str(), segs.as_slice()) {
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
                    let yes = matches!(
                        choice.and_then(|v| v.as_str()),
                        Some("y") | Some("yes") | Some("always")
                    ) || choice.and_then(|v| v.as_bool()) == Some(true);
                    t.approvals.lock().unwrap().push_back(yes);
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
                Some(t) => sse_events(stream, t),
                None => json_err(stream, "404 Not Found", "unknown task"),
            }
        }
        _ => json_err(stream, "404 Not Found", "no such route"),
    }
}

fn sse_events(stream: &mut TcpStream, t: Arc<TaskState>) {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let mut sent = 0usize;
    let mut finished = false;
    while !finished {
        {
            let mut evs = t.events.lock().unwrap();
            loop {
                while sent < evs.len() {
                    if stream
                        .write_all(format!("data: {}\n\n", evs[sent]).as_bytes())
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

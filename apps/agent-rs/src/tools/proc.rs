use super::*;

const MAX_OUTPUT: usize = 64 * 1024;
pub(super) const DEFAULT_TIMEOUT_MS: u64 = 120_000;
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

pub(super) fn exec_run_command(input: &Value, ctx: &Ctx) -> ToolResult {
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

pub(super) fn exec_run_background(input: &Value, ctx: &Ctx) -> ToolResult {
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

pub(super) fn exec_check_process(input: &Value, ctx: &Ctx) -> ToolResult {
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

pub(super) fn exec_kill_process(input: &Value, ctx: &Ctx) -> ToolResult {
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

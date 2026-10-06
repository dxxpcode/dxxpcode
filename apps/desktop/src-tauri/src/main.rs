use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct Pty {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

/// Events emitted before the webview attached its listener. Flushed on `ui_ready`.
struct Outbox {
    ready: std::sync::atomic::AtomicBool,
    buffered: Mutex<Vec<Vec<u8>>>,
}

#[tauri::command]
fn ui_ready(outbox: State<'_, std::sync::Arc<Outbox>>, app: tauri::AppHandle) {
    let buffered: Vec<Vec<u8>> = std::mem::take(&mut *outbox.buffered.lock().unwrap());
    outbox
        .ready
        .store(true, std::sync::atomic::Ordering::SeqCst);
    for ev in buffered {
        let _ = app.emit("pty-out", ev);
    }
}

#[tauri::command]
fn pty_write(pty: State<'_, Pty>, data: &str) -> Result<(), String> {
    pty.writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

/// Pool of worker sidecars — parallel tasks each rooted in their own git
/// worktree. Emitted on the `worker-out` channel as {id, data}.
struct Workers {
    map: Mutex<HashMap<u32, Pty>>,
    next: std::sync::atomic::AtomicU32,
}

#[tauri::command]
fn pty_resize(pty: State<'_, Pty>, cols: u16, rows: u16) -> Result<(), String> {
    pty.master
        .lock()
        .unwrap()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Native directory picker; resolves to the chosen path or null.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(app
        .dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string()))
}

/// Pick a random image file in `dir` and return it as a data URL.
#[tauri::command]
fn art_image(dir: String) -> Result<serde_json::Value, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            matches!(
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .as_deref(),
                Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "avif")
            )
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return Err("no images in that folder".into());
    }
    let idx = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0))
        % files.len();
    let path = files[idx].clone();
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        _ => "image/jpeg",
    };
    let data_url = format!("data:{};base64,{}", mime, base64_encode(&bytes));
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "dataUrl": data_url,
    }))
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let pad = 3 - c.len();
        for i in 0..4 {
            out.push(if i >= 4 - pad {
                '='
            } else {
                T[(n >> (18 - 6 * i) & 63) as usize] as char
            });
        }
    }
    out
}

fn cli_binary(app: &tauri::AppHandle) -> String {
    if let Ok(p) = std::env::var("DXXPCODE_BIN") {
        return p;
    }
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("binaries"));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.clone());
        dirs.push(res.join("binaries"));
    }
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let mut names: Vec<_> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                // Match the agent sidecar (dxxpcode, dxxpcode.exe,
                // dxxpcode-<triple>[.exe]) but never this app's own exe —
                // "dxxpcode-desktop.exe" starts with "dxxpcode-" and would
                // re-spawn the desktop app in a loop.
                .filter(|n| {
                    let base = n.strip_suffix(".exe").unwrap_or(n);
                    !base.starts_with("dxxpcode-desktop")
                        && (base == "dxxpcode" || base.starts_with("dxxpcode-"))
                })
                .collect();
            names.sort();
            if let Some(name) = names.into_iter().next() {
                return dir.join(name).to_string_lossy().into_owned();
            }
        }
    }
    "dxxpcode".to_string()
}

/// Spawn the sidecar rooted at `cwd`, wiring its stdout into `outbox`/`pty-out`.
fn spawn_sidecar(
    app: &tauri::AppHandle,
    outbox: std::sync::Arc<Outbox>,
    cwd: std::path::PathBuf,
) -> Result<Pty, String> {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let program = cli_binary(app);
    let mut cmd = CommandBuilder::new(program);
    cmd.arg("--app");
    cmd.cwd(cwd);
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    if outbox.ready.load(std::sync::atomic::Ordering::SeqCst) {
                        let _ = handle.emit("pty-out", chunk);
                    } else {
                        outbox.buffered.lock().unwrap().push(chunk);
                    }
                }
            }
        }
    });

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(Pty {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    })
}

/// The directory the current sidecar is rooted at — updated by
/// `restart_sidecar` so the frontend knows the project root.
struct SessionCwd(Mutex<String>);

#[tauri::command]
fn session_cwd(cwd: State<'_, SessionCwd>) -> String {
    cwd.0.lock().unwrap().clone()
}

/// Kill the current sidecar and respawn it rooted at `cwd` — used by
/// "Open a project" to change the working directory without restarting.
#[tauri::command]
fn restart_sidecar(
    app: tauri::AppHandle,
    pty: State<'_, Pty>,
    outbox: State<'_, std::sync::Arc<Outbox>>,
    session_cwd: State<'_, SessionCwd>,
    cwd: String,
) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    *session_cwd.0.lock().unwrap() = cwd.clone();
    // Kill the old process first so it can't emit anything else.
    let _ = pty.child.lock().unwrap().kill();
    let fresh = spawn_sidecar(&app, outbox.inner().clone(), dir)?;
    *pty.writer.lock().unwrap() = fresh.writer.into_inner().unwrap();
    *pty.master.lock().unwrap() = fresh.master.into_inner().unwrap();
    *pty.child.lock().unwrap() = fresh.child.into_inner().unwrap();
    Ok(())
}

/// Spawn a worker sidecar rooted at `cwd`; its output goes to `worker-out`
/// events tagged with the returned worker id.
fn spawn_worker(app: &tauri::AppHandle, id: u32, cwd: std::path::PathBuf) -> Result<Pty, String> {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_height: 0,
            pixel_width: 0,
        })
        .map_err(|e| e.to_string())?;

    let program = cli_binary(app);
    let mut cmd = CommandBuilder::new(program);
    cmd.arg("--app");
    // Workers are fire-and-forget: nobody is watching to approve diffs or
    // tools, so they run with always-approve rather than stalling forever.
    cmd.arg("--yes");
    cmd.cwd(cwd);
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = handle.emit(
                        "worker-out",
                        serde_json::json!({ "id": id, "data": buf[..n].to_vec() }),
                    );
                }
            }
        }
        let _ = handle.emit("worker-exit", id);
    });

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(Pty {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    })
}

#[tauri::command]
fn worker_start(
    app: tauri::AppHandle,
    workers: State<'_, Workers>,
    cwd: String,
) -> Result<u32, String> {
    let dir = std::path::PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    let id = workers
        .next
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let pty = spawn_worker(&app, id, dir)?;
    workers.map.lock().unwrap().insert(id, pty);
    Ok(id)
}

#[tauri::command]
fn worker_write(workers: State<'_, Workers>, id: u32, data: &str) -> Result<(), String> {
    let map = workers.map.lock().unwrap();
    let pty = map.get(&id).ok_or("no such worker")?;
    let r = pty
        .writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string());
    r
}

#[tauri::command]
fn worker_stop(workers: State<'_, Workers>, id: u32) -> Result<(), String> {
    if let Some(pty) = workers.map.lock().unwrap().remove(&id) {
        let _ = pty.child.lock().unwrap().kill();
    }
    Ok(())
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Untrimmed variant — `git diff` output must keep its trailing newline or
/// `git apply` rejects it as a corrupt patch.
fn git_raw(root: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `git worktree add .dxxpcode/trees/<name> -b dxxp/<name>` — returns
/// {dir, branch}; errors when `root` isn't inside a git work tree.
#[tauri::command]
fn worktree_create(root: String, name: String) -> Result<serde_json::Value, String> {
    git(&root, &["rev-parse", "--is-inside-work-tree"])?;
    let dir = format!("{root}/.dxxpcode/trees/{name}");
    let branch = format!("dxxp/{name}");
    git(&root, &["worktree", "add", &dir, "-b", &branch])?;
    Ok(serde_json::json!({ "dir": dir, "branch": branch }))
}

/// Apply the worktree's working-tree diff (incl. untracked files) onto the
/// main checkout, then remove the worktree and its branch.
#[tauri::command]
fn worktree_merge(root: String, dir: String, branch: String) -> Result<String, String> {
    // `add -A` then `diff --cached` so brand-new files appear in the patch.
    git(&dir, &["add", "-A"])?;
    let patch = git_raw(&dir, &["diff", "--cached", "HEAD"])?;
    if patch.trim().is_empty() {
        // Nothing to apply — still clean up.
        let _ = git(&root, &["worktree", "remove", "--force", &dir]);
        let _ = git(&root, &["branch", "-D", &branch]);
        return Ok("no changes".into());
    }
    // stat the patch before applying for the summary
    let stat = {
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["apply", "--stat"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(patch.as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    {
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["apply", "--whitespace=nowarn"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(patch.as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "merge conflicts with current work — kept the worktree at {dir}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    let _ = git(&root, &["worktree", "remove", "--force", &dir]);
    let _ = git(&root, &["branch", "-D", &branch]);
    Ok(stat)
}

/// Remove the worktree and its branch without applying anything.
#[tauri::command]
fn worktree_discard(root: String, dir: String, branch: String) -> Result<(), String> {
    git(&root, &["worktree", "remove", "--force", &dir])?;
    let _ = git(&root, &["branch", "-D", &branch]);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(std::sync::Arc::new(Outbox {
            ready: std::sync::atomic::AtomicBool::new(false),
            buffered: Mutex::new(Vec::new()),
        }))
        .manage(Workers {
            map: Mutex::new(HashMap::new()),
            next: std::sync::atomic::AtomicU32::new(1),
        })
        .manage(SessionCwd(Mutex::new(String::new())))
        .setup(|app| {
            // Spawn dxxpcode: DXXPCODE_BIN overrides for dev; otherwise the
            // bundled sidecar (next to the exe or in the resource dir); finally
            // fall back to a `dxxpcode` on PATH.
            let outbox = app.state::<std::sync::Arc<Outbox>>().inner().clone();
            let cwd = std::env::current_dir().unwrap_or_else(|_| "/tmp".into());
            *app.state::<SessionCwd>().0.lock().unwrap() = cwd.to_string_lossy().into_owned();
            let pty = spawn_sidecar(app.handle(), outbox, cwd)?;
            app.manage(pty);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_write,
            pty_resize,
            ui_ready,
            pick_folder,
            art_image,
            restart_sidecar,
            session_cwd,
            worker_start,
            worker_write,
            worker_stop,
            worktree_create,
            worktree_merge,
            worktree_discard
        ])
        .run(tauri::generate_context!())
        .expect("error while running dxxpcode desktop");
}

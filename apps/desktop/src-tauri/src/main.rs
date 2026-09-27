use portable_pty::{native_pty_system, CommandBuilder, PtySize};
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
    outbox.ready.store(true, std::sync::atomic::Ordering::SeqCst);
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

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
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

/// Kill the current sidecar and respawn it rooted at `cwd` — used by
/// "Open a project" to change the working directory without restarting.
#[tauri::command]
fn restart_sidecar(
    app: tauri::AppHandle,
    pty: State<'_, Pty>,
    outbox: State<'_, std::sync::Arc<Outbox>>,
    cwd: String,
) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    // Kill the old process first so it can't emit anything else.
    let _ = pty.child.lock().unwrap().kill();
    let fresh = spawn_sidecar(&app, outbox.inner().clone(), dir)?;
    *pty.writer.lock().unwrap() = fresh.writer.into_inner().unwrap();
    *pty.master.lock().unwrap() = fresh.master.into_inner().unwrap();
    *pty.child.lock().unwrap() = fresh.child.into_inner().unwrap();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(std::sync::Arc::new(Outbox {
            ready: std::sync::atomic::AtomicBool::new(false),
            buffered: Mutex::new(Vec::new()),
        }))
        .setup(|app| {
            // Spawn dxxpcode: DXXPCODE_BIN overrides for dev; otherwise the
            // bundled sidecar (next to the exe or in the resource dir); finally
            // fall back to a `dxxpcode` on PATH.
            let outbox = app.state::<std::sync::Arc<Outbox>>().inner().clone();
            let cwd = std::env::current_dir().unwrap_or_else(|_| "/tmp".into());
            let pty = spawn_sidecar(app.handle(), outbox, cwd)?;
            app.manage(pty);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pty_write, pty_resize, ui_ready, pick_folder, restart_sidecar])
        .run(tauri::generate_context!())
        .expect("error while running dxxpcode desktop");
}

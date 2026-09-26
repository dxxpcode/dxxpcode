use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct Pty {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    _child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
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
                .filter(|n| n == "dxxpcode" || n.starts_with("dxxpcode-"))
                .collect();
            names.sort();
            if let Some(name) = names.into_iter().next() {
                return dir.join(name).to_string_lossy().into_owned();
            }
        }
    }
    "dxxpcode".to_string()
}

fn main() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(Outbox {
            ready: std::sync::atomic::AtomicBool::new(false),
            buffered: Mutex::new(Vec::new()),
        }))
        .setup(|app| {
            let sys = native_pty_system();
            let pair = sys
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;

            // Spawn dxxpcode: DXXPCODE_BIN overrides for dev; otherwise the
            // bundled sidecar (next to the exe or in the resource dir); finally
            // fall back to a `dxxpcode` on PATH.
            let program = cli_binary(app.handle());
            let mut cmd = CommandBuilder::new(program);
            cmd.arg("--app");
            cmd.cwd(std::env::current_dir().unwrap_or_else(|_| "/tmp".into()));
            let child = pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| e.to_string())?;
            drop(pair.slave);

            let mut reader = pair
                .master
                .try_clone_reader()
                .map_err(|e| e.to_string())?;
            let outbox = app.state::<std::sync::Arc<Outbox>>().inner().clone();
            let handle = app.handle().clone();
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
            app.manage(Pty {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                _child: Mutex::new(child),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pty_write, pty_resize, ui_ready])
        .run(tauri::generate_context!())
        .expect("error while running dxxpcode desktop");
}

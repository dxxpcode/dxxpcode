use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct Pty {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    _child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
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

fn main() {
    tauri::Builder::default()
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

            // Spawn the real dxxpcode CLI (linked install or PATH). DXXPCODE_BIN
            // overrides for dev (e.g. `node ../cli/dist/cli.js`).
            let program = std::env::var("DXXPCODE_BIN").unwrap_or_else(|_| "dxxpcode".to_string());
            let mut cmd = CommandBuilder::new(program);
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
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let _ = handle.emit("pty-out", buf[..n].to_vec());
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
        .invoke_handler(tauri::generate_handler![pty_write, pty_resize])
        .run(tauri::generate_context!())
        .expect("error while running dxxpcode desktop");
}

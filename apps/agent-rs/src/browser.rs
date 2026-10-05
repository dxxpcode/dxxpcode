//! Headless browser driven over CDP — backs the `browse` tool.
//! Sync implementation: raw DevTools protocol over tungstenite, no async runtime.

use serde_json::{json, Value};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tungstenite::{connect, Message as WsMsg};

pub struct Browser {
    child: Child,
    ws: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    next_id: u64,
    /// Buffered console/exception/network-failure entries since page open.
    console: Vec<String>,
    /// Incremented on every navigation — snapshot refs carry the epoch.
    epoch: u64,
    pub url: String,
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn chrome_binary() -> Option<String> {
    if let Ok(p) = std::env::var("DXXPCODE_CHROME") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    for c in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
        "msedge",
    ] {
        if let Ok(out) = Command::new("which").arg(c).output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() {
                    return Some(p);
                }
            }
        }
    }
    // Common macOS path (child sessions run there too).
    for p in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

impl Browser {
    pub fn launch() -> Result<Browser, String> {
        let bin = chrome_binary().ok_or_else(|| {
            "no Chrome/Chromium found — install Chrome or set DXXPCODE_CHROME".to_string()
        })?;
        let port = free_port();
        let profile = std::env::temp_dir().join(format!("dxxpcode-chrome-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let child = Command::new(&bin)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--mute-audio",
                "--window-size=1280,800",
                &format!("--remote-debugging-port={port}"),
                &format!("--user-data-dir={}", profile.display()),
                "about:blank",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("launch chrome: {e}"))?;

        // Wait for the devtools endpoint.
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut ws_url = None;
        while Instant::now() < deadline {
            if let Ok(mut r) = ureq::get(&format!("http://127.0.0.1:{port}/json")).call() {
                if let Ok(list) = r.body_mut().read_json::<Value>() {
                    if let Some(u) = list
                        .as_array()
                        .and_then(|a| {
                            a.iter()
                                .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
                        })
                        .and_then(|t| t.get("webSocketDebuggerUrl"))
                        .and_then(|v| v.as_str())
                    {
                        ws_url = Some(u.to_string());
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(120));
        }
        let Some(ws_url) = ws_url else {
            return Err("chrome devtools endpoint did not come up".into());
        };
        let (mut ws, _) = connect(&ws_url).map_err(|e| format!("ws connect: {e}"))?;
        if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_mut() {
            let _ = s.set_read_timeout(Some(Duration::from_millis(100)));
        }
        let mut b = Browser {
            child,
            ws,
            next_id: 1,
            console: vec![],
            epoch: 0,
            url: "about:blank".into(),
        };
        b.cmd("Page.enable", json!({}))?;
        b.cmd("Runtime.enable", json!({}))?;
        b.cmd("Log.enable", json!({}))?;
        b.cmd("Network.enable", json!({}))?;
        Ok(b)
    }

    /// Send a CDP command; buffer events seen while waiting for the reply.
    fn cmd(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({"id": id, "method": method, "params": params}).to_string();
        self.ws
            .send(WsMsg::Text(msg.into()))
            .map_err(|e| format!("ws send: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() > deadline {
                return Err(format!("cdp {method}: timed out"));
            }
            match self.ws.read() {
                Ok(WsMsg::Text(t)) => {
                    let v: Value = serde_json::from_str(&t).unwrap_or(json!({}));
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                        if let Some(err) = v.get("error") {
                            return Err(format!(
                                "cdp {method}: {}",
                                err.get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("error")
                            ));
                        }
                        return Ok(v.get("result").cloned().unwrap_or(json!({})));
                    }
                    self.buffer_event(&v);
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(format!("ws read: {e}")),
            }
        }
    }

    /// Drain pending events without sending a command (for waits).
    fn drain(&mut self, quiet_ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(quiet_ms);
        while Instant::now() < deadline {
            match self.ws.read() {
                Ok(WsMsg::Text(t)) => {
                    let v: Value = serde_json::from_str(&t).unwrap_or(json!({}));
                    self.buffer_event(&v);
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => return,
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn buffer_event(&mut self, v: &Value) {
        match v.get("method").and_then(|m| m.as_str()) {
            Some("Runtime.consoleAPICalled") => {
                let p = &v["params"];
                let level = p.get("type").and_then(|t| t.as_str()).unwrap_or("log");
                let text = p
                    .get("args")
                    .and_then(|a| a.as_array())
                    .map(|a| {
                        a.iter()
                            .map(|x| {
                                x.get("value")
                                    .map(|v| v.to_string())
                                    .or_else(|| {
                                        x.get("description")
                                            .and_then(|d| d.as_str())
                                            .map(String::from)
                                    })
                                    .unwrap_or_default()
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                self.push_console(format!("{level}: {text}"));
            }
            Some("Runtime.exceptionThrown") => {
                let d = &v["params"]["exceptionDetails"];
                let text = d
                    .pointer("/exception/description")
                    .or_else(|| d.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("exception")
                    .to_string();
                self.push_console(format!("exception: {}", text.lines().next().unwrap_or("")));
            }
            Some("Network.responseReceived") => {
                let r = &v["params"]["response"];
                let status = r.get("status").and_then(|s| s.as_u64()).unwrap_or(0);
                if status >= 400 {
                    let url = r.get("url").and_then(|u| u.as_str()).unwrap_or("");
                    self.push_console(format!("network: {status} {url}"));
                }
            }
            Some("Network.loadingFailed") => {
                let blocked = v["params"]
                    .get("blockedReason")
                    .and_then(|b| b.as_str())
                    .unwrap_or("");
                let err = v["params"]
                    .get("errorText")
                    .and_then(|e| e.as_str())
                    .unwrap_or("");
                if !err.is_empty() && !err.contains("ERR_ABORTED") {
                    self.push_console(
                        format!("network-failed: {err} {blocked}")
                            .trim()
                            .to_string(),
                    );
                }
            }
            _ => {}
        }
    }

    fn push_console(&mut self, line: String) {
        if self.console.len() < 200 && !self.console.contains(&line) {
            self.console.push(line);
        }
    }

    pub fn navigate(&mut self, url: &str) -> Result<String, String> {
        self.cmd("Page.navigate", json!({"url": url}))?;
        self.epoch += 1;
        // Wait for load + a short quiet period for SPA render.
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            self.drain(150);
            if let Ok(ready) = self.eval("document.readyState") {
                if ready.as_str() == Some("complete") {
                    break;
                }
            }
        }
        self.drain(400);
        let title = self
            .eval("document.title")
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        let final_url = self
            .eval("location.href")
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| url.to_string());
        self.url = final_url.clone();
        let errors: Vec<_> = self
            .console
            .iter()
            .filter(|l| l.starts_with("error") || l.starts_with("exception"))
            .take(5)
            .cloned()
            .collect();
        let mut out = format!("{final_url}\ntitle: {title}");
        if !errors.is_empty() {
            out.push_str(&format!("\nerrors: {}", errors.join(" | ")));
        }
        Ok(out)
    }

    /// Evaluate JS in the page; returns the JSON result value.
    pub fn eval(&mut self, expr: &str) -> Result<Value, String> {
        let r = self.cmd(
            "Runtime.evaluate",
            json!({
                "expression": expr,
                "returnByValue": true,
                "awaitPromise": true,
            }),
        )?;
        if r.pointer("/exceptionDetails").is_some() {
            let t = r
                .pointer("/exceptionDetails/exception/description")
                .or_else(|| r.pointer("/exceptionDetails/text"))
                .and_then(|v| v.as_str())
                .unwrap_or("js exception");
            return Err(format!("eval: {}", t.lines().next().unwrap_or("")));
        }
        Ok(r.get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Accessibility-ish snapshot: label interactive + semantic elements with
    /// ref ids, return one line each. Refs live only for this epoch.
    pub fn snapshot(&mut self, max_nodes: usize, selector: Option<&str>) -> Result<String, String> {
        let js = SNAPSHOT_JS
            .replace("__SEL__", &serde_json::to_string(&selector).unwrap())
            .replace("__EPOCH__", &self.epoch.to_string());
        let v = self.eval(&js)?;
        let lines: Vec<String> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .take(max_nodes)
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let title = self
            .eval("document.title")
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        let mut out = format!("{} — {}\n", self.url, title);
        if lines.is_empty() {
            out.push_str("(no interactive elements found)");
        } else {
            let total = v.as_array().map(|a| a.len()).unwrap_or(0);
            out.push_str(&lines.join("\n"));
            if total > max_nodes {
                out.push_str(&format!("\n… {} more elements", total - max_nodes));
            }
        }
        Ok(out)
    }

    /// Resolve a ref to element center coordinates (for CDP input).
    fn ref_point(&mut self, r: &str) -> Result<(f64, f64), String> {
        let v = self.eval(&format!(
            "(() => {{ const el = document.querySelector('[data-dxxp-ref=\"{r}\"][data-dxxp-epoch=\"{}\"]'); if (!el) return null; const b = el.getBoundingClientRect(); el.scrollIntoView({{block:'nearest'}}); const r2 = el.getBoundingClientRect(); return [r2.left + r2.width/2, r2.top + r2.height/2, r2.width, r2.height]; }})()",
            self.epoch
        ))?;
        let a = v
            .as_array()
            .ok_or_else(|| format!("stale or unknown ref {r} — take a new snapshot"))?;
        if a.len() < 2 {
            return Err(format!("ref {r} has no clickable area"));
        }
        Ok((a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0)))
    }

    pub fn click(&mut self, r: &str) -> Result<String, String> {
        let (x, y) = self.ref_point(r)?;
        for t in ["mousePressed", "mouseReleased"] {
            self.cmd(
                "Input.dispatchMouseEvent",
                json!({"type": t, "x": x, "y": y, "button": "left", "clickCount": 1}),
            )?;
        }
        self.drain(500);
        let new_url = self
            .eval("location.href")
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        if new_url != self.url {
            self.url = new_url.clone();
            self.epoch += 1;
            Ok(format!(
                "clicked {r} — navigated to {new_url} (take a new snapshot)"
            ))
        } else {
            Ok(format!("clicked {r}"))
        }
    }

    pub fn type_text(&mut self, r: &str, text: &str, submit: bool) -> Result<String, String> {
        self.ref_point(r)?; // validates ref/epoch
        self.eval(&format!(
            "document.querySelector('[data-dxxp-ref=\"{r}\"][data-dxxp-epoch=\"{}\"]').focus(); 'ok'",
            self.epoch
        ))?;
        self.cmd("Input.insertText", json!({"text": text}))?;
        if submit {
            for t in ["keyDown", "keyUp"] {
                self.cmd(
                    "Input.dispatchKeyEvent",
                    json!({"type": t, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13}),
                )?;
            }
            self.drain(500);
        }
        Ok(format!("typed into {r}"))
    }

    pub fn wait(&mut self, selector: Option<&str>, ms: u64) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_millis(ms.min(30_000));
        if let Some(sel) = selector {
            while Instant::now() < deadline {
                self.drain(200);
                let found = self
                    .eval(&format!(
                        "!!document.querySelector({})",
                        serde_json::to_string(&sel).unwrap()
                    ))
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if found {
                    return Ok(format!("appeared: {sel}"));
                }
            }
            Err(format!("timed out waiting for {sel}"))
        } else {
            self.drain(ms.min(30_000));
            Ok(format!("waited {ms}ms"))
        }
    }

    /// Screenshot → PNG bytes (also saved to disk by the caller).
    pub fn screenshot(&mut self) -> Result<Vec<u8>, String> {
        let r = self.cmd("Page.captureScreenshot", json!({"format": "png"}))?;
        let b64 = r.get("data").and_then(|d| d.as_str()).unwrap_or("");
        Ok(b64_decode(b64))
    }

    pub fn console(&mut self) -> String {
        self.drain(150);
        if self.console.is_empty() {
            "(console is clean — no errors, warnings, or failed requests)".into()
        } else {
            self.console.join("\n")
        }
    }
}

fn b64_decode(s: &str) -> Vec<u8> {
    const T: &[i8; 128] = &{
        let mut t = [-1i8; 128];
        let mut i = 0usize;
        while i < 64 {
            let c = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[i];
            t[c as usize] = i as i8;
            i += 1;
        }
        t
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut nbits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' || c > 127 || T[c as usize] < 0 {
            continue;
        }
        acc = (acc << 6) | T[c as usize] as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
        }
    }
    out
}

const SNAPSHOT_JS: &str = r#"(() => {
  const scope = __SEL__ ? document.querySelector(__SEL__) : document;
  if (!scope) return [];
  const SEL = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[onclick],summary,[tabindex]:not([tabindex="-1"])';
  const els = Array.from(scope.querySelectorAll(SEL)).filter(el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
  });
  const lines = [];
  let n = 0;
  for (const el of els.slice(0, 600)) {
    n++;
    const ref = 'e' + n;
    el.setAttribute('data-dxxp-ref', ref);
    el.setAttribute('data-dxxp-epoch', '__EPOCH__');
    const tag = el.tagName.toLowerCase();
    const kind = el.getAttribute('type') || el.getAttribute('role') || tag;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.name || el.id || '').trim().replace(/\s+/g,' ').slice(0, 80);
    const r = el.getBoundingClientRect();
    lines.push(`[${ref}] ${tag}:${kind} "${label}" @(${Math.round(r.x)},${Math.round(r.y)})`);
  }
  return lines;
})()"#;

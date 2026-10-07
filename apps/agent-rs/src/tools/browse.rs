use super::*;

/// The `browse` tool — lazy headless Chrome shared across calls in the run.

pub(super) fn exec_browse(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(action) = str_arg(input, "action") else {
        return ToolResult::err("missing required arg: action");
    };
    let mut guard = ctx.browser.lock().unwrap();
    if guard.is_none() {
        match crate::browser::Browser::launch() {
            Ok(b) => *guard = Some(b),
            Err(e) => return ToolResult::err(e),
        }
    }
    let b = guard.as_mut().unwrap();
    match action.as_str() {
        "navigate" => {
            let url = str_arg(input, "url").unwrap_or_default();
            match b.navigate(&url) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "snapshot" => {
            let max = opt_num(input, "max_nodes").unwrap_or(150.0) as usize;
            let sel = str_arg(input, "selector").ok();
            match b.snapshot(max.max(1), sel.as_deref()) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "click" => {
            let r = str_arg(input, "ref").unwrap_or_default();
            match b.click(&r) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "type" => {
            let r = str_arg(input, "ref").unwrap_or_default();
            let text = str_arg(input, "text").unwrap_or_default();
            let submit = input.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
            match b.type_text(&r, &text, submit) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "wait" => {
            let ms = opt_num(input, "ms").unwrap_or(1000.0) as u64;
            let sel = str_arg(input, "selector").ok();
            match b.wait(sel.as_deref(), ms) {
                Ok(s) => ToolResult::ok(s),
                Err(e) => ToolResult::err(e),
            }
        }
        "console" => ToolResult::ok(b.console()),
        "screenshot" => match b.screenshot() {
            Ok(png) => {
                let dir = Path::new(&ctx.root).join(".dxxpcode/shots");
                let _ = fs::create_dir_all(&dir);
                let file = dir.join(format!("browse-{}.png", chrono::Utc::now().timestamp_millis()));
                let _ = fs::write(&file, &png);
                ToolResult::ok(format!("screenshot saved: {}", file.display()))
                    .with_image("image/png", b64_encode(&png))
            }
            Err(e) => ToolResult::err(e),
        },
        "evaluate" => {
            let expr = str_arg(input, "expression").unwrap_or_default();
            match b.eval(&expr) {
                Ok(v) => ToolResult::ok(serde_json::to_string_pretty(&v).unwrap_or_default()),
                Err(e) => ToolResult::err(e),
            }
        }
        other => ToolResult::err(format!(
            "unknown action {other} — use navigate|snapshot|click|type|wait|console|screenshot|evaluate"
        )),
    }
}

fn b64_encode(bytes: &[u8]) -> String {
    const B: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |a, &b| (a << 8) | b as u32) << (8 * (3 - chunk.len()));
        let take = chunk.len() + 1;
        for i in 0..4 {
            if i < take {
                out.push(B[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

const BROWSE_DENY: &[&str] = &[
    "accounts.google.com",
    "login.microsoftonline.com",
    "paypal.com",
    "stripe.com",
    "checkout.stripe.com",
    "bank",
    "coinbase.com",
];

fn url_host(url: &str) -> String {
    let u = url.trim_start_matches(|c| c == '/' || c == ' ');
    let rest = u
        .strip_prefix("http://")
        .or_else(|| u.strip_prefix("https://"))
        .unwrap_or(u);
    rest.split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "0.0.0.0"
        || host.ends_with(".local")
}

/// `browse` permission tiers: reads are safe; localhost navigation is safe;
/// external navigation and page interactions need approval; deny-listed hosts
/// are always restricted.
pub(super) fn perm_browse(input: &Value, _: &str) -> Decision {
    let action = str_arg(input, "action").unwrap_or_default();
    if matches!(
        action.as_str(),
        "snapshot" | "screenshot" | "console" | "wait"
    ) {
        return perm_safe(input, "");
    }
    if action == "navigate" {
        let url = str_arg(input, "url").unwrap_or_default();
        let host = url_host(&url);
        if BROWSE_DENY.iter().any(|d| host.contains(d)) {
            return Decision {
                level: Level::Restricted,
                reason: format!("browsing to {host} is never allowed"),
            };
        }
        if is_local_host(&host) || host.is_empty() {
            return Decision {
                level: Level::Safe,
                reason: "local page".into(),
            };
        }
        return Decision {
            level: Level::Approval,
            reason: format!("open external page {host}"),
        };
    }
    if matches!(action.as_str(), "click" | "type" | "select" | "evaluate") {
        return Decision {
            level: Level::Approval,
            reason: format!("interact with the page ({action})"),
        };
    }
    Decision {
        level: Level::Safe,
        reason: "read-only".into(),
    }
}

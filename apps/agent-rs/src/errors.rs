//! User-facing error classification — stable codes plus a one-line next step
//! the desktop renders as an error row.

use serde_json::{json, Value};

/// Classify a provider/run failure into a stable code and an action hint.
/// `status` is the HTTP status when the failure came from the provider.
pub fn classify(msg: &str, status: Option<u32>) -> (&'static str, Option<&'static str>) {
    match status {
        Some(401) | Some(403) => (
            "PROVIDER_AUTH",
            Some("check your API key in Settings → Providers & Models"),
        ),
        Some(429) => (
            "PROVIDER_TRANSIENT",
            Some("rate limited — retry, or switch model via /model"),
        ),
        Some(c) if c >= 500 => (
            "PROVIDER_TRANSIENT",
            Some("provider error — retry, or switch model via /model"),
        ),
        _ => {
            if msg.contains("unreachable") || msg.contains("timed out") {
                (
                    "PROVIDER_UNREACHABLE",
                    Some("check your connection, or /providers to switch"),
                )
            } else if msg.contains("permission denied") || msg.contains("requires approval") {
                (
                    "DENIED",
                    Some("approve the action, or change approval mode in Settings"),
                )
            } else if msg.contains("not found") || msg.contains("no such file") {
                ("NOT_FOUND", None)
            } else {
                ("RUN_FAILED", None)
            }
        }
    }
}

/// The structured error event consumed by the desktop transcript.
pub fn event(msg: &str, status: Option<u32>, detail: Option<&str>) -> Value {
    let (code, hint) = classify(msg, status);
    let mut v = json!({"type": "error", "code": code, "message": msg});
    if let Some(h) = hint {
        v["hint"] = json!(h);
    }
    if let Some(d) = detail {
        v["detail"] = json!(d);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_by_status() {
        assert_eq!(classify("x", Some(401)).0, "PROVIDER_AUTH");
        assert_eq!(classify("x", Some(403)).0, "PROVIDER_AUTH");
        assert_eq!(classify("x", Some(429)).0, "PROVIDER_TRANSIENT");
        assert_eq!(classify("x", Some(503)).0, "PROVIDER_TRANSIENT");
        assert_eq!(classify("x", Some(400)).0, "RUN_FAILED");
    }

    #[test]
    fn classify_by_message() {
        assert_eq!(
            classify("gemini unreachable — check your connection", None).0,
            "PROVIDER_UNREACHABLE"
        );
        assert_eq!(classify("tool requires approval", None).0, "DENIED");
        assert_eq!(classify("boom", None).0, "RUN_FAILED");
    }

    #[test]
    fn event_includes_hint_only_when_present() {
        let v = event("x", Some(429), None);
        assert_eq!(v["code"], "PROVIDER_TRANSIENT");
        assert!(v["hint"].is_string());
        let v = event("x", None, None);
        assert!(v["hint"].is_null());
    }
}

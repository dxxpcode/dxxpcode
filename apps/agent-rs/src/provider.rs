//! Provider adapters — port of packages/providers (Anthropic, OpenAI, mock) + jev.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl Usage {
    pub fn to_json(&self) -> Value {
        json!({"inputTokens": self.input_tokens, "outputTokens": self.output_tokens})
    }
}

#[derive(Debug)]
pub enum ProviderEvent {
    Text(String),
    /// Reasoning/thinking tokens (Claude extended thinking, o-series).
    Thinking(String),
    ToolUse { id: String, name: String, input: Value },
    Done { stop_reason: String, usage: Option<Usage> },
}

#[derive(Debug)]
pub struct ProviderError(pub String, pub Option<u32>);

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ProviderError {}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(None)
        .build()
        .into()
}

fn post_error(e: ureq::Error, provider: &str) -> ProviderError {
    match e {
        ureq::Error::StatusCode(code) => ProviderError(format!("{provider} API error {code}"), Some(code as u32)),
        other => ProviderError(format!("{provider} request failed: {other}"), None),
    }
}

/// Read a streaming ureq response as SSE `data:` payloads (event field included).
fn read_sse<R: Read>(
    reader: R,
    aborted: &Arc<AtomicBool>,
    mut on_event: impl FnMut(&str, &str),
) {
    let mut reader = std::io::BufReader::with_capacity(16 * 1024, reader);
    let mut buf = String::new();
    let mut chunk = [0u8; 16384];
    loop {
        if aborted.load(Ordering::Relaxed) {
            return;
        }
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                while let Some(idx) = buf.find("\n\n") {
                    let raw = buf[..idx].to_string();
                    buf = buf[idx + 2..].to_string();
                    let mut event = String::new();
                    let mut data_lines: Vec<String> = vec![];
                    for line in raw.split('\n') {
                        if let Some(e) = line.strip_prefix("event:") {
                            event = e.trim().to_string();
                        } else if let Some(d) = line.strip_prefix("data:") {
                            data_lines.push(d.strip_prefix(' ').unwrap_or(d).to_string());
                        }
                    }
                    if !data_lines.is_empty() {
                        on_event(&event, &data_lines.join("\n"));
                    }
                }
            }
        }
    }
}

pub enum Provider {
    Anthropic { key: String },
    OpenAi { key: String, base_url: String },
    Mock { script: Vec<Value>, turn: usize },
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Anthropic { .. } => "anthropic",
            Self::OpenAi { .. } => "openai",
            Self::Mock { .. } => "mock",
        }
    }

    pub fn list_models(&self) -> Result<Vec<String>, ProviderError> {
        match self {
            Self::Anthropic { key } => {
                let mut resp = agent()
                    .get("https://api.anthropic.com/v1/models?limit=100")
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
                    .call()
                    .map_err(|e| post_error(e, "Anthropic"))?;
                let body: Value = resp.body_mut().read_json::<Value>().map_err(|e| ProviderError(e.to_string(), None))?;
                Ok(body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
                    .unwrap_or_default())
            }
            Self::OpenAi { key, base_url } => {
                let mut resp = agent()
                    .get(&format!("{base_url}/models"))
                    .header("authorization", &format!("Bearer {key}"))
                    .call()
                    .map_err(|e| post_error(e, "OpenAI"))?;
                let body: Value = resp.body_mut().read_json::<Value>().map_err(|e| ProviderError(e.to_string(), None))?;
                let re = regex::Regex::new(r"(?i)embed|whisper|dall-e|tts|moderation|babbage|davinci|audio|image|transcribe").unwrap();
                let mut ids: Vec<String> = body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                            .filter(|id| !re.is_match(id))
                            .collect()
                    })
                    .unwrap_or_default();
                ids.sort();
                ids.reverse();
                Ok(ids)
            }
            Self::Mock { .. } => Ok(vec!["mock".into()]),
        }
    }

    /// Stream one chat turn; `emit` is called per provider event.
    pub fn chat(
        &mut self,
        system: &str,
        messages: &[crate::config::Message],
        tools: &[Value],
        model: &str,
        effort: Option<&str>,
        aborted: &Arc<AtomicBool>,
        mut emit: impl FnMut(ProviderEvent),
    ) -> Result<(), ProviderError> {
        match self {
            Self::Anthropic { key } => anthropic_chat(key, system, messages, tools, model, effort, aborted, &mut emit),
            Self::OpenAi { key, base_url } => openai_chat(key, base_url, system, messages, tools, model, effort, aborted, &mut emit),
            Self::Mock { script, turn } => {
                let t = script.get(*turn).cloned();
                *turn += 1;
                mock_emit(t, emit);
                Ok(())
            }
        }
    }
}

const EFFORT_BUDGET: &[(&str, u64)] = &[
    ("minimal", 1024),
    ("low", 4096),
    ("medium", 16384),
    ("high", 32768),
    ("xhigh", 49152),
    ("max", 61440),
];

fn anthropic_chat(
    key: &str,
    system: &str,
    messages: &[crate::config::Message],
    tools: &[Value],
    model: &str,
    effort: Option<&str>,
    aborted: &Arc<AtomicBool>,
    emit: &mut dyn FnMut(ProviderEvent),
) -> Result<(), ProviderError> {
    let budget = effort.and_then(|e| EFFORT_BUDGET.iter().find(|(n, _)| *n == e)).map(|(_, b)| *b);
    let mut body = json!({
        "model": model,
        "max_tokens": std::cmp::max(8192u64, budget.map(|b| b + 2048).unwrap_or(0)),
        "system": system,
        "messages": messages.iter().map(to_anthropic_message).collect::<Vec<_>>(),
        "tools": tools.iter().map(|t| json!({
            "name": t["name"], "description": t["description"], "input_schema": t["inputSchema"],
        })).collect::<Vec<_>>(),
        "stream": true,
    });
    if let Some(b) = budget {
        body["thinking"] = json!({"type": "enabled", "budget_tokens": b});
    }

    let mut resp = agent()
        .post("https://api.anthropic.com/v1/messages")
        .header("content-type", "application/json")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send(body.to_string())
        .map_err(|e| post_error(e, "Anthropic"))?;

    let mut usage = Usage::default();
    let mut tool_blocks: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
    let mut stop_reason = String::from("end_turn");

    let reader = resp.body_mut().as_reader();
    read_sse(reader, aborted, |event, data| {
        if aborted.load(Ordering::Relaxed) {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(data) else { return };
        match event {
            "message_start" => {
                if let Some(u) = parsed.pointer("/message/usage") {
                    usage.input_tokens = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    usage.output_tokens = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                }
            }
            "content_block_start" => {
                if parsed.pointer("/content_block/type").and_then(|v| v.as_str()) == Some("tool_use") {
                    let idx = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    tool_blocks.insert(
                        idx,
                        (
                            parsed.pointer("/content_block/id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            parsed.pointer("/content_block/name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            String::new(),
                        ),
                    );
                }
            }
            "content_block_delta" => {
                let dt = parsed.pointer("/delta/type").and_then(|v| v.as_str());
                if dt == Some("thinking_delta") {
                    if let Some(t) = parsed.pointer("/delta/thinking").and_then(|v| v.as_str()) {
                        emit(ProviderEvent::Thinking(t.to_string()));
                    }
                } else if dt == Some("text_delta") {
                    if let Some(t) = parsed.pointer("/delta/text").and_then(|v| v.as_str()) {
                        emit(ProviderEvent::Text(t.to_string()));
                    }
                } else if dt == Some("input_json_delta") {
                    let idx = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    if let Some(b) = tool_blocks.get_mut(&idx) {
                        b.2.push_str(parsed.pointer("/delta/partial_json").and_then(|v| v.as_str()).unwrap_or(""));
                    }
                }
            }
            "content_block_stop" => {
                let idx = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                if let Some((id, name, json_text)) = tool_blocks.remove(&idx) {
                    let input = serde_json::from_str::<Value>(&json_text).unwrap_or_else(|_| {
                        if json_text.is_empty() { json!({}) } else { json!({"__raw": json_text}) }
                    });
                    emit(ProviderEvent::ToolUse { id, name, input });
                }
            }
            "message_delta" => {
                if let Some(r) = parsed.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                    stop_reason = r.to_string();
                }
                if let Some(o) = parsed.pointer("/usage/output_tokens").and_then(|v| v.as_u64()) {
                    usage.output_tokens = o;
                }
            }
            "message_stop" => {
                emit(ProviderEvent::Done { stop_reason: stop_reason.clone(), usage: Some(usage.clone()) });
            }
            _ => {}
        }
    });
    Ok(())
}

fn to_anthropic_message(m: &crate::config::Message) -> Value {
    let content: Vec<Value> = m
        .content
        .iter()
        .map(|b| match b.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => json!({
                "type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"],
            }),
            Some("tool_result") => json!({
                "type": "tool_result",
                "tool_use_id": b["toolUseId"],
                "content": [{"type": "text", "text": b["content"].as_str().unwrap_or("")}],
                "is_error": b.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
            }),
            _ => json!({"type": "text", "text": b["text"].as_str().unwrap_or("")}),
        })
        .collect();
    json!({"role": m.role, "content": content})
}

fn openai_chat(
    key: &str,
    base_url: &str,
    system: &str,
    messages: &[crate::config::Message],
    tools: &[Value],
    model: &str,
    effort: Option<&str>,
    aborted: &Arc<AtomicBool>,
    emit: &mut dyn FnMut(ProviderEvent),
) -> Result<(), ProviderError> {
    let mut wire: Vec<Value> = vec![json!({"role": "system", "content": system})];
    for m in messages {
        wire.extend(to_openai_messages(m));
    }
    let mut body = json!({
        "model": model,
        "stream": true,
        "stream_options": {"include_usage": true},
        "messages": wire,
        "tools": tools.iter().map(|t| json!({
            "type": "function",
            "function": {"name": t["name"], "description": t["description"], "parameters": t["inputSchema"]},
        })).collect::<Vec<_>>(),
    });
    if let Some(e) = effort {
        body["reasoning_effort"] = json!(e);
    }

    let mut resp = agent()
        .post(&format!("{base_url}/chat/completions"))
        .header("content-type", "application/json")
        .header("authorization", &format!("Bearer {key}"))
        .send(body.to_string())
        .map_err(|e| post_error(e, "OpenAI"))?;

    let mut usage: Option<Usage> = None;
    let mut stop_reason = String::from("stop");
    let mut tool_calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
    let mut counter = 0u64;

    let reader = resp.body_mut().as_reader();
    read_sse(reader, aborted, |_event, data| {
        if aborted.load(Ordering::Relaxed) || data == "[DONE]" {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(data) else { return };
        if let Some(u) = parsed.get("usage") {
            usage = Some(Usage {
                input_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                output_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            });
        }
        let choice = parsed.pointer("/choices/0").cloned();
        let Some(choice) = choice else { return };
        // Reasoning deltas — o-series `reasoning_content`, others `reasoning`.
        for key in ["reasoning_content", "reasoning"] {
            if let Some(t) = choice.pointer(&format!("/delta/{key}")).and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    emit(ProviderEvent::Thinking(t.to_string()));
                }
            }
        }
        if let Some(text) = choice.pointer("/delta/content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                emit(ProviderEvent::Text(text.to_string()));
            }
        }
        if let Some(calls) = choice.pointer("/delta/tool_calls").and_then(|v| v.as_array()) {
            for tc in calls {
                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                let entry = tool_calls
                    .entry(idx)
                    .or_insert_with(|| {
                        let id = tc.get("id").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| {
                            counter += 1;
                            format!("call_{counter}")
                        });
                        (id, String::new(), String::new())
                    });
                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                    entry.0 = id.to_string();
                }
                if let Some(n) = tc.pointer("/function/name").and_then(|v| v.as_str()) {
                    entry.1.push_str(n);
                }
                if let Some(a) = tc.pointer("/function/arguments").and_then(|v| v.as_str()) {
                    entry.2.push_str(a);
                }
            }
        }
        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            stop_reason = fr.to_string();
            let calls: Vec<_> = std::mem::take(&mut tool_calls).into_values().collect();
            for (id, name, args) in calls {
                let input = serde_json::from_str::<Value>(&args).unwrap_or_else(|_| {
                    if args.is_empty() { json!({}) } else { json!({"__raw": args}) }
                });
                emit(ProviderEvent::ToolUse { id, name, input });
            }
        }
    });
    emit(ProviderEvent::Done { stop_reason, usage });
    Ok(())
}

fn to_openai_messages(m: &crate::config::Message) -> Vec<Value> {
    let mut texts = vec![];
    let mut tool_calls = vec![];
    let mut tool_results = vec![];
    for b in &m.content {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => tool_calls.push(json!({
                "id": b["id"], "type": "function",
                "function": {"name": b["name"], "arguments": b["input"].to_string()},
            })),
            Some("tool_result") => tool_results.push(json!({
                "role": "tool", "tool_call_id": b["toolUseId"], "content": b["content"].as_str().unwrap_or(""),
            })),
            _ => {
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    texts.push(t.to_string());
                }
            }
        }
    }
    if !tool_results.is_empty() {
        let mut out = vec![];
        if !texts.is_empty() {
            out.push(json!({"role": m.role, "content": texts.join("")}));
        }
        out.extend(tool_results);
        return out;
    }
    let joined = texts.join("");
    let mut out = json!({"role": m.role, "content": if joined.is_empty() { Value::Null } else { json!(joined) }});
    if !tool_calls.is_empty() {
        out["tool_calls"] = json!(tool_calls);
    }
    vec![out]
}

fn mock_emit(turn: Option<Value>, mut emit: impl FnMut(ProviderEvent)) {
    let Some(t) = turn else {
        emit(ProviderEvent::Text("(mock: no scripted turn)".into()));
        emit(ProviderEvent::Done { stop_reason: "end_turn".into(), usage: None });
        return;
    };
    if let Some(ms) = t.get("delayMs").and_then(|v| v.as_u64()) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    if let Some(text) = t.get("think").and_then(|v| v.as_str()) {
        for chunk in text.as_bytes().chunks(24) {
            emit(ProviderEvent::Thinking(String::from_utf8_lossy(chunk).to_string()));
        }
        if let Some(ms) = t.get("thinkDelayMs").and_then(|v| v.as_u64()) {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }
    if let Some(text) = t.get("text").and_then(|v| v.as_str()) {
        for chunk in text.as_bytes().chunks(24) {
            emit(ProviderEvent::Text(String::from_utf8_lossy(chunk).to_string()));
            if let Some(ms) = t.get("chunkDelayMs").and_then(|v| v.as_u64()) {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
        }
    }
    let mut n = 0;
    if let Some(calls) = t.get("toolCalls").and_then(|v| v.as_array()) {
        for call in calls {
            emit(ProviderEvent::ToolUse {
                id: format!("mock_{n}"),
                name: call.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                input: call.get("input").cloned().unwrap_or(json!({})),
            });
            n += 1;
        }
    }
    let has_calls = t.get("toolCalls").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    let stop_reason = t
        .get("stopReason")
        .and_then(|v| v.as_str())
        .unwrap_or(if has_calls { "tool_use" } else { "end_turn" })
        .to_string();
    let usage = t.get("usage").map(|u| Usage {
        input_tokens: u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0),
    });
    emit(ProviderEvent::Done { stop_reason, usage });
}

/* ---------------------------------- jev ---------------------------------- */

fn jev_decide(api_key: &str, state: &Value, questions: &Value) -> Result<Value, String> {
    let base = std::env::var("TYPESAFE_BASE_URL").unwrap_or_else(|_| "https://api.typesafe.ai".into());
    let mut resp = agent()
        .post(&format!("{base}/v1/systemone"))
        .header("authorization", &format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .config().timeout_global(Some(std::time::Duration::from_secs(5))).build()
        .send(json!({"model": "jev-latest", "state": state, "questions": questions}).to_string())
        .map_err(|e| format!("jev: {e}"))?;
    resp.body_mut().read_json::<Value>().map_err(|e| e.to_string())
}

/// Smart-approval verdict via Jev; None → caller falls back to the prompt.
pub fn smart_approve(tool: &str, input: &Value, reason: Option<&str>, risk: &str, api_key: &str) -> Option<(bool, f64)> {
    let res = jev_decide(
        api_key,
        &json!({"tool": tool, "input": input, "reason": reason, "risk": risk}),
        &json!({
            "verdict": {
                "type": "choice",
                "instructions": "An AI coding agent in a terminal wants to run this tool call. Choose 'approve' only when the action is routine, reversible, and clearly safe (install deps, run tests/build/lint, read-only git). Choose 'escalate' for anything destructive, irreversible, touching secrets/credentials, network-publishing, sudo, or ambiguous.",
                "criteria": {
                    "approve": "routine, reversible, clearly safe",
                    "escalate": "destructive, risky, secret-related, or uncertain — a human should decide",
                },
            },
        }),
    )
    .ok()?;
    let a = res.pointer("/answers/verdict")?;
    let approve = a.get("choice").and_then(|v| v.as_str()) == Some("approve")
        && a.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0) >= 0.8;
    Some((approve, a.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0)))
}

const EFFORT_TIERS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

/// Jev effort routing; None → caller keeps the configured effort.
pub fn jev_route_effort(task: &str, api_key: &str) -> Option<String> {
    let res = jev_decide(
        api_key,
        &json!({"task": task}),
        &json!({
            "effort": {
                "type": "choice",
                "instructions": "Pick the reasoning effort an AI coding agent should spend on this task. Judge the task's inherent complexity, not its length: lower tiers for lookups, formatting, simple edits and straightforward commands; medium for typical agentic coding; higher tiers only for genuinely hard, multi-step or high-stakes work.",
                "criteria": {
                    "minimal": "trivial — answers, renames, one-line edits",
                    "low": "simple — drafting, small changes, routine commands",
                    "medium": "standard — most coding tasks and fixes",
                    "high": "complex — debugging, refactors, deep planning",
                    "xhigh": "very hard — subtle bugs, architecture, large multi-step work",
                    "max": "extreme — high-stakes, hardest reasoning problems",
                },
            },
        }),
    )
    .ok()?;
    let choice = res.pointer("/answers/effort/choice")?.as_str()?;
    EFFORT_TIERS.contains(&choice).then(|| choice.to_string())
}

/// Saved-key / env-var provider resolution — mirrors select.ts.
pub fn resolve_provider(
    provider_override: Option<&str>,
    model_override: Option<&str>,
    config: &crate::config::Config,
) -> Result<(Provider, String), ProviderError> {
    let name = provider_override
        .map(String::from)
        .or_else(|| std::env::var("DXXPCODE_PROVIDER").ok())
        .unwrap_or_default()
        .to_lowercase();

    if name == "mock" {
        let script = std::env::var("DXXPCODE_MOCK_SCRIPT")
            .ok()
            .and_then(|p| std::fs::read_to_string(&p).ok())
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .unwrap_or_else(|| vec![json!({"text": "mock"})]);
        return Ok((Provider::Mock { script, turn: 0 }, model_override.unwrap_or("mock").to_string()));
    }

    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if name == "anthropic" || (name.is_empty() && (env("ANTHROPIC_API_KEY").is_some() || config.anthropic_api_key.is_some())) {
        let key = env("ANTHROPIC_API_KEY").or_else(|| config.anthropic_api_key.clone());
        let Some(key) = key else {
            return Err(ProviderError("DXXPCODE_PROVIDER=anthropic requires ANTHROPIC_API_KEY".into(), None));
        };
        let model = model_override
            .map(String::from)
            .or_else(|| env("DXXPCODE_MODEL"))
            .unwrap_or_else(|| "claude-opus-5-5".into());
        return Ok((Provider::Anthropic { key }, model));
    }
    if name == "openai" || (name.is_empty() && (env("OPENAI_API_KEY").is_some() || config.openai_api_key.is_some())) {
        let key = env("OPENAI_API_KEY").or_else(|| config.openai_api_key.clone());
        let Some(key) = key else {
            return Err(ProviderError("DXXPCODE_PROVIDER=openai requires OPENAI_API_KEY".into(), None));
        };
        let model = model_override
            .map(String::from)
            .or_else(|| env("DXXPCODE_MODEL"))
            .unwrap_or_else(|| "gpt-6".into());
        return Ok((Provider::OpenAi { key, base_url: std::env::var("OPENAI_BASE_URL").ok().unwrap_or_else(|| "https://api.openai.com/v1".into()).trim_end_matches('/').to_string() }, model));
    }
    if !name.is_empty() {
        return Err(ProviderError(format!("Unknown provider \"{name}\". Supported: anthropic, openai"), None));
    }
    Err(ProviderError(
        "No model provider configured. Run `dxxpcode` in a terminal to connect one, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.".into(),
        None,
    ))
}

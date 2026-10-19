use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, PartialEq)]
pub enum EffortMode {
    #[default]
    Unknown,
    OpenAi,
    ThinkingBudget,
    AnthropicEffort,
    AdaptiveEffort,
    BudgetEffort,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    // None means unknown; an empty list means no configurable reasoning.
    pub effort_levels: Option<Vec<String>>,
    #[serde(skip)]
    pub effort_mode: EffortMode,
}

pub const EFFORT_ORDER: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

impl ModelInfo {
    pub fn unknown(id: &str) -> Self {
        Self {
            id: id.into(),
            display_name: id.into(),
            effort_levels: None,
            effort_mode: EffortMode::Unknown,
        }
    }

    pub fn supports(&self, effort: &str) -> bool {
        self.effort_levels
            .as_ref()
            .is_some_and(|levels| levels.iter().any(|level| level == effort))
    }

    pub fn routed_effort(&self, effort: &str) -> Option<String> {
        let target = EFFORT_ORDER.iter().position(|level| *level == effort)?;
        EFFORT_ORDER[..=target]
            .iter()
            .rev()
            .find(|level| self.supports(level))
            .or_else(|| EFFORT_ORDER.iter().find(|level| self.supports(level)))
            .map(|level| level.to_string())
    }
}

fn snapshot_base(id: &str) -> &str {
    if let Some((base, date)) = id.rsplit_once('-') {
        if date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()) {
            return base;
        }
    }
    if id.len() >= 11 {
        if let (Some(base), Some(date)) = (id.get(..id.len() - 11), id.get(id.len() - 11..)) {
            if date.starts_with('-')
                && date[1..].bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
            {
                return base;
            }
        }
    }
    id
}

pub fn fallback_model(id: &str, provider: &str, official_openai: bool) -> ModelInfo {
    let mut info = ModelInfo::unknown(id);
    let base = snapshot_base(id);
    // Explicit documented families only; never infer support from a version prefix.
    let (mode, levels): (EffortMode, &[&str]) = match (provider, base) {
        (
            "anthropic",
            "claude-opus-5-5" | "claude-opus-5" | "claude-opus-4-8" | "claude-opus-4-7"
            | "claude-sonnet-5-5" | "claude-sonnet-5" | "claude-haiku-5-5",
        ) => (
            EffortMode::AdaptiveEffort,
            &["low", "medium", "high", "xhigh", "max"],
        ),
        ("anthropic", "claude-opus-4-6" | "claude-sonnet-4-6") => (
            EffortMode::AdaptiveEffort,
            &["low", "medium", "high", "max"],
        ),
        (
            "anthropic",
            "claude-sonnet-4-5"
            | "claude-haiku-4-5"
            | "claude-sonnet-4"
            | "claude-opus-4-5"
            | "claude-3-7-sonnet-latest"
            | "claude-3-7-sonnet",
        ) => (
            EffortMode::ThinkingBudget,
            &["minimal", "low", "medium", "high", "xhigh", "max"],
        ),
        ("anthropic", "claude-opus-4" | "claude-opus-4-1") => {
            (EffortMode::ThinkingBudget, &["minimal", "low", "medium"])
        }
        ("openai", "gpt-5" | "gpt-5-mini" | "gpt-5-nano") if official_openai => {
            (EffortMode::OpenAi, &["minimal", "low", "medium", "high"])
        }
        ("openai", "gpt-5.1") if official_openai => {
            (EffortMode::OpenAi, &["none", "low", "medium", "high"])
        }
        ("openai", "gpt-5.2" | "gpt-5.4" | "gpt-5.5") if official_openai => (
            EffortMode::OpenAi,
            &["none", "low", "medium", "high", "xhigh"],
        ),
        ("openai", "o1" | "o3" | "o3-mini" | "o4-mini") if official_openai => {
            (EffortMode::OpenAi, &["low", "medium", "high"])
        }
        ("openai", "gpt-4o" | "gpt-4o-mini" | "gpt-4.1" | "gpt-4.1-mini" | "gpt-4.1-nano")
            if official_openai =>
        {
            (EffortMode::OpenAi, &[])
        }
        (
            "anthropic",
            "claude-3-5-sonnet"
            | "claude-3-5-sonnet-latest"
            | "claude-3-5-haiku"
            | "claude-3-5-haiku-latest",
        ) => (EffortMode::ThinkingBudget, &[]),
        ("mock", _) => (EffortMode::OpenAi, EFFORT_ORDER),
        _ => return info,
    };
    info.effort_mode = mode;
    info.effort_levels = Some(levels.iter().map(|level| level.to_string()).collect());
    info
}

pub fn catalog_model(value: &Value, provider: &str, official_openai: bool) -> Option<ModelInfo> {
    let id = value.get("id")?.as_str()?;
    if id.trim().is_empty() {
        return None;
    }
    let mut info = fallback_model(id, provider, official_openai);
    let fallback_levels = info.effort_levels.clone();
    if let Some(name) = value
        .get("display_name")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
    {
        if !name.trim().is_empty() {
            info.display_name = name.into();
        }
    }
    if provider == "anthropic" {
        if let Some(caps) = value.get("capabilities").filter(|caps| caps.is_object()) {
            if caps.pointer("/effort/supported").and_then(Value::as_bool) == Some(true) {
                info.effort_levels = Some(
                    EFFORT_ORDER
                        .iter()
                        .filter(|level| {
                            caps.pointer(&format!("/effort/{level}/supported"))
                                .and_then(Value::as_bool)
                                == Some(true)
                        })
                        .map(|level| level.to_string())
                        .collect(),
                );
                info.effort_mode = if caps
                    .pointer("/thinking/types/adaptive/supported")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    EffortMode::AdaptiveEffort
                } else if caps
                    .pointer("/thinking/types/enabled/supported")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    EffortMode::BudgetEffort
                } else {
                    EffortMode::AnthropicEffort
                };
            } else if caps
                .pointer("/thinking/types/enabled/supported")
                .and_then(Value::as_bool)
                == Some(true)
            {
                info.effort_levels = Some(
                    EFFORT_ORDER[1..]
                        .iter()
                        .map(|level| level.to_string())
                        .collect(),
                );
                info.effort_mode = EffortMode::ThinkingBudget;
            } else if caps.pointer("/thinking/supported").and_then(Value::as_bool) == Some(false) {
                info.effort_levels = Some(vec![]);
                info.effort_mode = EffortMode::Unknown;
            } else {
                info.effort_levels = None;
                info.effort_mode = EffortMode::Unknown;
            }
        }
    }
    if matches!(
        info.effort_mode,
        EffortMode::ThinkingBudget | EffortMode::BudgetEffort
    ) {
        if let Some(max_tokens) = value.get("max_tokens").and_then(Value::as_u64) {
            if let Some(levels) = &mut info.effort_levels {
                levels.retain(|level| {
                    thinking_budget(level)
                        .is_some_and(|budget| 8192.max(budget + 2048) <= max_tokens)
                });
            }
        } else if let Some(known) = fallback_levels {
            if let Some(levels) = &mut info.effort_levels {
                levels.retain(|level| known.contains(level));
            }
        } else {
            info.effort_levels = None;
        }
    }
    Some(info)
}

fn thinking_budget(effort: &str) -> Option<u64> {
    Some(match effort {
        "minimal" => 1024,
        "low" => 4096,
        "medium" => 16384,
        "high" => 32768,
        "xhigh" => 49152,
        "max" => 61440,
        _ => return None,
    })
}

pub fn apply_anthropic_effort(body: &mut Value, info: &ModelInfo, effort: Option<&str>) {
    let Some(effort) = effort.filter(|effort| info.supports(effort)) else {
        return;
    };
    if matches!(
        info.effort_mode,
        EffortMode::AnthropicEffort | EffortMode::AdaptiveEffort | EffortMode::BudgetEffort
    ) {
        body["output_config"] = json!({"effort": effort});
    }
    match info.effort_mode {
        EffortMode::AdaptiveEffort => {
            body["thinking"] = json!({"type": "adaptive"});
        }
        EffortMode::ThinkingBudget | EffortMode::BudgetEffort => {
            let Some(budget) = thinking_budget(effort) else {
                return;
            };
            body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
            body["max_tokens"] = json!(8192.max(budget + 2048));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_choices_are_model_and_endpoint_specific() {
        let gpt5 = fallback_model("gpt-5-2025-08-07", "openai", true);
        assert!(gpt5.supports("minimal"));
        assert!(!gpt5.supports("max"));
        assert!(!gpt5.supports("xhigh"));
        assert_eq!(gpt5.routed_effort("max").as_deref(), Some("high"));
        assert_eq!(gpt5.routed_effort("minimal").as_deref(), Some("minimal"));
        assert!(fallback_model("gpt-5.2", "openai", true).supports("none"));
        assert!(fallback_model("gpt-5.2", "openai", true).supports("xhigh"));
        assert!(fallback_model("gpt-5.5", "openai", true).supports("xhigh"));
        assert!(!fallback_model("gpt-5.5", "openai", true).supports("max"));
        for id in ["gpt-5-custom", "gpt-50", "gpt-5.99", "org/gpt-5"] {
            assert_eq!(fallback_model(id, "openai", true).effort_levels, None);
        }
        assert_eq!(fallback_model("gpt-5", "openai", false).effort_levels, None);
        assert_eq!(
            fallback_model("gpt-4o", "openai", true).effort_levels,
            Some(vec![])
        );
    }

    #[test]
    fn authoritative_claude_catalog_overrides_fallbacks() {
        let info = catalog_model(
            &json!({
                "id": "claude-future", "display_name": "Claude Future",
                "capabilities": { "effort": { "supported": true,
                    "low": {"supported": true}, "high": {"supported": true},
                    "max": {"supported": false} } }
            }),
            "anthropic",
            false,
        )
        .unwrap();
        assert_eq!(info.display_name, "Claude Future");
        assert_eq!(info.effort_levels, Some(vec!["low".into(), "high".into()]));
        assert_eq!(info.routed_effort("max").as_deref(), Some("high"));
        let unsupported = catalog_model(
            &json!({
                "id": "claude-opus-5-5",
                "capabilities": {"thinking": {"supported": false}, "effort": {"supported": false}}
            }),
            "anthropic",
            false,
        )
        .unwrap();
        assert!(!unsupported.supports("medium"));
    }

    #[test]
    fn claude_request_matches_its_reasoning_protocol() {
        let mut modern = json!({"max_tokens": 8192});
        apply_anthropic_effort(
            &mut modern,
            &fallback_model("claude-opus-5-5", "anthropic", false),
            Some("high"),
        );
        assert_eq!(modern["output_config"]["effort"], "high");
        assert_eq!(modern["thinking"], json!({"type": "adaptive"}));
        let mut legacy = json!({"max_tokens": 8192});
        apply_anthropic_effort(
            &mut legacy,
            &fallback_model("claude-sonnet-4-5-20250929", "anthropic", false),
            Some("medium"),
        );
        assert_eq!(legacy["thinking"]["budget_tokens"], 16384);
        assert_eq!(legacy["max_tokens"], 18432);
        let mut unknown = json!({"max_tokens": 8192});
        apply_anthropic_effort(&mut unknown, &ModelInfo::unknown("custom"), Some("max"));
        assert!(unknown.get("thinking").is_none());
        assert_eq!(ModelInfo::unknown("custom").routed_effort("high"), None);
    }

    #[test]
    fn manual_thinking_and_effort_can_coexist_without_adaptive_mode() {
        let info = catalog_model(&json!({
            "id": "claude-opus-4-5", "capabilities": {
                "effort": {"supported": true, "medium": {"supported": true}},
                "thinking": {"types": {"enabled": {"supported": true}, "adaptive": {"supported": false}}}
            }
        }), "anthropic", false).unwrap();
        let mut body = json!({"max_tokens": 8192});
        apply_anthropic_effort(&mut body, &info, Some("medium"));
        assert_eq!(body["output_config"]["effort"], "medium");
        assert_eq!(body["thinking"]["type"], "enabled");
    }

    #[test]
    fn unknown_and_unicode_ids_are_safe_and_default_does_not_add_options() {
        for id in [
            "organization/自定义模型-name",
            "🧑‍💻🧑‍💻🧑‍💻",
            "unknown-2026-01-01",
            "custom",
        ] {
            let info = fallback_model(id, "openai", true);
            assert_eq!(info.id, id);
            assert_eq!(info.effort_levels, None);
        }
        let mut body = json!({"max_tokens": 8192});
        apply_anthropic_effort(
            &mut body,
            &fallback_model("claude-opus-5-5", "anthropic", false),
            None,
        );
        assert_eq!(body, json!({"max_tokens": 8192}));
        assert_eq!(
            serde_json::to_value(ModelInfo::unknown("custom")).unwrap(),
            json!({
                "id": "custom", "displayName": "custom", "effortLevels": null,
            })
        );
    }

    #[test]
    fn manual_budgets_respect_the_models_output_limit() {
        let info = catalog_model(&json!({
            "id": "future-manual-model", "max_tokens": 32000,
            "capabilities": {"effort": {"supported": false}, "thinking": {"types": {"enabled": {"supported": true}}}}
        }), "anthropic", false).unwrap();
        assert!(info.supports("medium"));
        assert!(!info.supports("high"));
        assert!(!fallback_model("claude-opus-4", "anthropic", false).supports("high"));
    }
}

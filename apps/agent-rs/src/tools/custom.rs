use super::*;

#[derive(Clone)]
pub struct CustomSpec {
    pub name: String,
    pub description: String,
    pub command: String,
    pub ask: bool,
    pub enabled: bool,
    pub timeout_ms: u64,
    /// (arg name, arg type) — type is "string" | "number" | "bool".
    pub args: Vec<(String, String)>,
    pub path: PathBuf,
}

fn custom_dirs(root: &str) -> Vec<PathBuf> {
    let mut dirs = vec![crate::config::home_dir().join("tools")];
    if !root.is_empty() {
        dirs.push(Path::new(root).join(".dxxpcode").join("tools"));
    }
    dirs
}

fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1]
            .replace("\\n", "\n")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn parse_custom(path: &Path) -> Option<CustomSpec> {
    let raw = fs::read_to_string(path).ok()?;
    let mut spec = CustomSpec {
        name: path.file_stem()?.to_string_lossy().to_string(),
        description: String::new(),
        command: String::new(),
        ask: false,
        enabled: false,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        args: vec![],
        path: path.to_path_buf(),
    };
    let mut in_args = false;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_args = line == "[args]";
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        if in_args {
            spec.args.push((k.to_string(), unquote(v)));
            continue;
        }
        match k {
            "name" => spec.name = unquote(v),
            "description" => spec.description = unquote(v),
            "command" => spec.command = unquote(v),
            "permission" => spec.ask = unquote(v) == "ask",
            "enabled" => spec.enabled = v == "true",
            "timeout_ms" => spec.timeout_ms = v.parse().unwrap_or(DEFAULT_TIMEOUT_MS),
            _ => {}
        }
    }
    // A valid tool name is a safe provider identifier — anything else is skipped.
    if spec.command.is_empty()
        || spec.name.is_empty()
        || !spec
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(spec)
}

/// All custom tool specs found under `~/.dxxpcode/tools/` and
/// `<root>/.dxxpcode/tools/` — enabled and disabled alike (for /tools).
pub fn custom_tools(root: &str) -> Vec<CustomSpec> {
    let mut out = vec![];
    for dir in custom_dirs(root) {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("toml") {
                if let Some(spec) = parse_custom(&p) {
                    out.push(spec);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The enabled spec with this name, if any.
pub fn custom_spec(root: &str, name: &str) -> Option<CustomSpec> {
    custom_tools(root)
        .into_iter()
        .find(|s| s.enabled && s.name == name)
}

/// Flip `enabled = true|false` inside a tool file (inserts the line if absent).
pub fn set_custom_enabled(path: &Path, on: bool) -> Result<(), String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut seen = false;
    let mut out = String::new();
    for line in raw.lines() {
        if line.trim_start().starts_with("enabled") && line.contains('=') {
            out.push_str(&format!("enabled = {on}\n"));
            seen = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !seen {
        out.insert_str(0, &format!("enabled = {on}\n"));
    }
    fs::write(path, out).map_err(|e| e.to_string())
}

/// Substitute `{arg}` placeholders in a tool's command template. String args
/// are single-quoted so injected text can never escape into shell syntax.
fn expand_custom(spec: &CustomSpec, input: &Value) -> Result<String, String> {
    let mut cmd = spec.command.clone();
    for (arg, ty) in &spec.args {
        let placeholder = format!("{{{arg}}}");
        if !cmd.contains(&placeholder) {
            continue;
        }
        let Some(v) = input.get(arg) else {
            return Err(format!("missing arg \"{arg}\""));
        };
        let rep = match ty.as_str() {
            "number" | "bool" => v
                .as_f64()
                .map(|n| n.to_string())
                .or_else(|| v.as_bool().map(|b| b.to_string()))
                .ok_or_else(|| format!("arg \"{arg}\" must be {ty}"))?,
            _ => format!("'{}'", v.as_str().unwrap_or("").replace('\'', "'\\''")),
        };
        cmd = cmd.replace(&placeholder, &rep);
    }
    if let Some(rest) = cmd.split('{').nth(1).and_then(|s| s.split('}').next()) {
        if rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("unknown arg \"{rest}\" in command template"));
        }
    }
    Ok(cmd)
}

/// Permission check for a custom tool — evaluates the expanded command
/// through the normal command rules; `permission = "ask"` forces approval.
pub fn perm_custom(spec: &CustomSpec, input: &Value, _root: &str) -> Decision {
    if spec.ask {
        return Decision {
            level: Level::Approval,
            reason: format!("custom tool \"{}\" asks permission", spec.name),
        };
    }
    match expand_custom(spec, input) {
        Ok(cmd) => evaluate_command(&cmd),
        Err(e) => Decision {
            level: Level::Restricted,
            reason: e,
        },
    }
}

/// Run a custom tool by expanding its template and delegating to the
/// run_command executor (same timeouts, streaming, esc-interrupt).
pub fn exec_custom(spec: &CustomSpec, input: &Value, ctx: &Ctx) -> ToolResult {
    match expand_custom(spec, input) {
        Ok(cmd) => exec_run_command(&json!({"command": cmd, "timeout_ms": spec.timeout_ms}), ctx),
        Err(e) => ToolResult::err(e),
    }
}

pub(super) fn custom_schema(spec: &CustomSpec) -> Value {
    let mut props = Map::new();
    for (arg, ty) in &spec.args {
        let ty = match ty.as_str() {
            "number" => "number",
            "bool" => "boolean",
            _ => "string",
        };
        props.insert(arg.clone(), json!({"type": ty}));
    }
    json!({"type": "object", "properties": props, "required": spec.args.iter().map(|a| &a.0).collect::<Vec<_>>()})
}

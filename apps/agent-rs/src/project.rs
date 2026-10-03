//! Project detection + agent system prompt — port of packages/project + agent/context.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct GitInfo {
    pub branch: String,
    pub dirty: bool,
    pub ahead_behind: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub languages: Vec<String>,
    pub package_manager: Option<String>,
    pub test_command: Option<String>,
    pub build_command: Option<String>,
    pub git: Option<GitInfo>,
}

impl ProjectInfo {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "languages": self.languages,
            "git": self.git.as_ref().map(|g| json!({
                "branch": g.branch, "dirty": g.dirty,
            })),
        })
    }
}

fn git_out(root: &str, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_PAGER", "cat")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

pub fn detect_git(root: &str) -> Option<GitInfo> {
    let branch = git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        return None;
    }
    let status = git_out(root, &["status", "--porcelain"]).unwrap_or_default();
    let ahead_behind = git_out(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    );
    Some(GitInfo {
        branch,
        dirty: !status.trim().is_empty(),
        ahead_behind: ahead_behind.filter(|s| !s.is_empty()),
    })
}

fn js_package_manager(root: &Path) -> String {
    for (lock, pm) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if root.join(lock).exists() {
            return pm.into();
        }
    }
    if let Ok(raw) = fs::read_to_string(root.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<Value>(&raw) {
            if let Some(pm) = pkg.get("packageManager").and_then(|v| v.as_str()) {
                return pm.split('@').next().unwrap_or("npm").to_string();
            }
        }
    }
    "npm".into()
}

fn js_commands(root: &Path, pm: &str) -> (Option<String>, Option<String>) {
    let Ok(raw) = fs::read_to_string(root.join("package.json")) else {
        return (None, None);
    };
    let Ok(pkg) = serde_json::from_str::<Value>(&raw) else {
        return (None, None);
    };
    let scripts = pkg.get("scripts").cloned().unwrap_or(json!({}));
    let has = |k: &str| scripts.get(k).is_some();
    let run = match pm {
        "npm" => "npm run",
        "yarn" => "yarn",
        p => {
            return (
                has("test").then(|| format!("{p} test")),
                has("build").then(|| format!("{p} run build")),
            )
        }
    };
    (
        has("test").then(|| {
            if pm == "npm" {
                "npm test".into()
            } else {
                format!("{pm} test")
            }
        }),
        has("build").then(|| format!("{run} build")),
    )
}

const MARKERS: &[(&str, &str, Option<&str>, Option<&str>)] = &[
    ("package.json", "JavaScript/TypeScript", None, None),
    ("pyproject.toml", "Python", Some("pytest"), None),
    ("requirements.txt", "Python", None, None),
    (
        "Cargo.toml",
        "Rust",
        Some("cargo test"),
        Some("cargo build"),
    ),
    (
        "go.mod",
        "Go",
        Some("go test ./..."),
        Some("go build ./..."),
    ),
    ("pom.xml", "Java", Some("mvn test"), Some("mvn compile")),
    (
        "build.gradle",
        "Java/Kotlin",
        Some("./gradlew test"),
        Some("./gradlew build"),
    ),
];

pub fn detect_project(root: &str) -> ProjectInfo {
    let rootp = PathBuf::from(root);
    let mut languages = Vec::<String>::new();
    let mut package_manager = None;
    let mut test_command = None;
    let mut build_command = None;

    let has_csproj = fs::read_dir(&rootp)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.file_name().to_string_lossy().ends_with(".csproj"))
        })
        .unwrap_or(false);

    for (file, lang, test, build) in MARKERS {
        if rootp.join(file).exists() {
            if !languages.iter().any(|l| l == lang) {
                languages.push((*lang).into());
            }
            if *file == "package.json" {
                let pm = js_package_manager(&rootp);
                let (t, b) = js_commands(&rootp, &pm);
                package_manager = Some(pm);
                test_command = t;
                build_command = b;
            } else {
                test_command = test_command.or_else(|| test.map(|s| s.to_string()));
                build_command = build_command.or_else(|| build.map(|s| s.to_string()));
            }
        }
    }
    if has_csproj {
        languages.push(".NET".into());
        test_command = test_command.or_else(|| Some("dotnet test".into()));
        build_command = build_command.or_else(|| Some("dotnet build".into()));
    }

    let name = rootp
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());

    ProjectInfo {
        root: root.into(),
        name,
        languages,
        package_manager,
        test_command,
        build_command,
        git: detect_git(root),
    }
}

pub fn load_instructions(root: &str) -> Option<(String, String)> {
    for name in [".dxxpcode/instructions.md", "AGENTS.md"] {
        let path = Path::new(root).join(name);
        if path.is_file() {
            if let Ok(content) = fs::read_to_string(&path) {
                let content = content.trim().to_string();
                if !content.is_empty() {
                    return Some((name.to_string(), content));
                }
            }
        }
    }
    None
}

/// `.dxxpcode/memory.md` — durable notes the agent appends to via `remember`.
/// Read whole, capped at ~4KB: human notes lead, agent bullets trim from the
/// top (recency wins) when over the cap.
pub fn load_memory(root: &str) -> Option<String> {
    const CAP: usize = 4096;
    let path = Path::new(root).join(".dxxpcode/memory.md");
    let content = fs::read_to_string(&path).ok()?.trim().to_string();
    if content.is_empty() {
        return None;
    }
    if content.len() <= CAP {
        return Some(content);
    }
    // Split human notes (before "## Notes") from agent bullets (after it).
    let (head, notes) = match content.find("## Notes") {
        Some(i) => (content[..i].trim().to_string(), content[i..].to_string()),
        None => (String::new(), content.clone()),
    };
    let head = head.chars().take(CAP / 2).collect::<String>();
    let mut tail: Vec<&str> = notes.lines().collect();
    while head.len() + tail.join("\n").len() > CAP && tail.len() > 1 {
        tail.remove(0);
    }
    Some(format!("{head}\n{}", tail.join("\n")).trim().to_string())
}

pub fn top_level_listing(root: &str) -> Vec<String> {
    const SKIP: &[&str] = &[
        "node_modules",
        ".git",
        "dist",
        "build",
        "target",
        "__pycache__",
        ".next",
        ".venv",
        "venv",
    ];
    fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !SKIP.contains(&n.as_str()))
                .take(60)
                .collect()
        })
        .unwrap_or_default()
}

const RULES: &str = r#"You are DxxpCode, a terminal-native AI coding agent. You operate inside the user's current project.

Workflow:
1. Investigate before editing — read the relevant files and tests.
2. For any non-trivial change, call propose_plan with a concise numbered plan. Do not edit during planning; only read-only tools are available then. Never answer a code task with prose — a text reply ends the run with no changes; either call propose_plan or reply DECLINE: <reason>.
3. During execution, make focused edits with edit_file/write_file, then verify: run the project's test command (and build when relevant).
4. If verification fails, diagnose and fix — you have a bounded number of iterations.
5. When finished, end with a short summary: what changed and the verification outcome.

Rules:
- Keep edits minimal and consistent with existing conventions.
- Match the project's existing patterns before introducing new ones: if there is no test framework, write plain runnable asserts — never install or invoke a new framework (e.g. jest) to satisfy a task.
- Spend tool calls deliberately: read only what the edit needs, don't re-read files you already have, and don't loop run-verify-kill-retry — prefer one direct path to a verified change. Never re-read a file you just wrote or edited; the tool result already confirms it. Verify once with the project's own test/check — don't hand-test every path with ad-hoc servers or repeated probes.
- Some actions require user approval or are restricted (secrets, paths outside the project, destructive commands). If a tool call is denied, accept it and find another way — do not retry identical calls.
- Never read .env files, SSH keys, or credential stores.
- Prefer running the project's own test command over ad-hoc checks.
- Memory: call `remember` with a one-line note when you learn something durable about this project — conventions, commands that worked, decisions made. It lands in `.dxxpcode/memory.md` and every future session reads it. Never store secrets, task state, or anything already in the project instructions.
- Project tools: `.dxxpcode/tools/` may hold user-provided scripts + docs. Check that directory before saying you can't do something — read a tool's file for usage, then invoke it with run_command.
- Be concise — the user reads this in a terminal."#;

pub fn gather_context(root: &str) -> (ProjectInfo, String) {
    let project = detect_project(root);
    let instructions = load_instructions(root);
    let top_level = top_level_listing(root);

    let mut lines = vec![RULES.to_string(), String::new(), "Project:".into()];
    lines.push(format!("- name: {}", project.name));
    lines.push(format!("- root: {}", project.root));
    if !project.languages.is_empty() {
        lines.push(format!("- languages: {}", project.languages.join(", ")));
    }
    if let Some(pm) = &project.package_manager {
        lines.push(format!("- package manager: {pm}"));
    }
    if let Some(t) = &project.test_command {
        lines.push(format!("- test command: {t}"));
    }
    if let Some(b) = &project.build_command {
        lines.push(format!("- build command: {b}"));
    }
    if let Some(git) = &project.git {
        let mut s = format!(
            "- git: branch {}{}",
            git.branch,
            if git.dirty { " (dirty)" } else { " (clean)" }
        );
        if let Some(ab) = &git.ahead_behind {
            s.push_str(&format!(", ahead/behind {ab}"));
        }
        lines.push(s);
    } else {
        lines.push("- git: not a repository".into());
    }
    if !top_level.is_empty() {
        lines.push(format!("- top-level: {}", top_level.join(", ")));
    }
    if let Some((path, content)) = instructions {
        lines.push(String::new());
        lines.push(format!("Project instructions ({path}):"));
        lines.push(content);
    }
    if let Some(memory) = load_memory(root) {
        lines.push(String::new());
        lines.push("Project memory (.dxxpcode/memory.md):".to_string());
        lines.push(memory);
    }
    let tools_dir = std::path::Path::new(root).join(".dxxpcode/tools");
    if let Ok(entries) = std::fs::read_dir(&tools_dir) {
        let names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect();
        if !names.is_empty() {
            let mut names = names;
            names.sort();
            lines.push(String::new());
            lines.push(format!(
                "Project tools (.dxxpcode/tools/): {}",
                names.join(", ")
            ));
        }
    }
    (project, lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_injected_and_trimmed() {
        let dir = std::env::temp_dir().join(format!("dxxp-ctx-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".dxxpcode")).unwrap();
        fs::write(
            dir.join(".dxxpcode/memory.md"),
            "# Project notes\nHand-written line.\n\n## Notes\n- tests run via make check\n",
        )
        .unwrap();
        let (_, system) = gather_context(dir.to_str().unwrap());
        assert!(
            system.contains("Project memory (.dxxpcode/memory.md):"),
            "{system}"
        );
        assert!(system.contains("- tests run via make check"), "{system}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_cap_keeps_recent() {
        let dir = std::env::temp_dir().join(format!("dxxp-cap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".dxxpcode")).unwrap();
        let notes = (0..300)
            .map(|i| format!("- note number {i} with some padding text"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            dir.join(".dxxpcode/memory.md"),
            format!("Human header.\n\n## Notes\n{notes}\n"),
        )
        .unwrap();
        let mem = load_memory(dir.to_str().unwrap()).unwrap();
        assert!(mem.len() <= 4096 + 60, "{}", mem.len());
        assert!(mem.contains("Human header."));
        assert!(mem.contains("- note number 299"), "{mem}");
        assert!(!mem.contains("- note number 0\n"), "{mem}");
        let _ = fs::remove_dir_all(&dir);
    }
}

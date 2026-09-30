//! Permission classification — port of packages/permissions.

use regex::Regex;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Safe,
    Approval,
    Restricted,
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub level: Level,
    pub reason: String,
}

// Simple memoized compile helper.
macro_rules! cre {
    ($p:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::new($p).unwrap())
    }};
    ($p:expr, i) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::new(&format!("(?i){}", $p)).unwrap())
    }};
}

const RESTRICTED_SEGMENTS: &[&str] = &[".ssh", ".aws", ".gnupg", ".password-store", ".docker"];

const RESTRICTED_FILE_PATTERNS: &[&str] = &[
    r"(?i)^\.env(\..*)?$",
    r"(?i)^id_(rsa|ed25519|ecdsa|dsa)$",
    r"(?i)\.(pem|key|p12|pfx|keystore|jks)$",
    r"(?i)^(credentials|secrets|htpasswd|netrc|\.netrc|shadow)$",
    r"(?i)\.credentials$",
    r"(?i)^config\.(npmrc|dockercfg)$",
    r"(?i)^\.npmrc$",
    r"(?i)^\.pgpass$",
    r"(?i)^\.git-credentials$",
];

const APPROVAL_FILE_PATTERNS: &[&str] = &[
    r"^package(-lock)?\.json$",
    r"^(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$",
    r"^tsconfig.*\.json$",
    r"\.(config|rc)\.(js|ts|mjs|cjs|json|yaml|yml)$",
    r"^Dockerfile.*$",
    r"^docker-compose.*\.(yaml|yml)$",
    r"^Makefile$",
    r"^Cargo\.(toml|lock)$",
    r"^pyproject\.toml$",
    r"^(go\.mod|go\.sum)$",
    r"^(pom\.xml|build\.gradle.*|.*\.csproj)$",
    r"^\.(github|gitlab|vscode|idea)(/|$)",
    r"^\.(gitignore|gitattributes|editorconfig|npmrc|nvmrc|node-version)$",
    r"^\.pre-commit-config\.yaml$",
    r"^LICENSE$",
];

pub fn normalize_path(p: &str) -> String {
    let collapsed = p.replace('\\', "/");
    let mut out = String::with_capacity(collapsed.len());
    let mut prev_slash = false;
    for c in collapsed.chars() {
        if c == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(c);
    }
    out
}

/// Resolve `target` against `root`; returns the project-relative path or None.
pub fn resolve_within_root(root: &str, target: &str) -> Option<String> {
    let norm_root = normalize_path(root).trim_end_matches('/').to_string();
    let win_abs = {
        let b = target.as_bytes();
        b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
    };
    let joined = if target.starts_with('/') || win_abs {
        normalize_path(target)
    } else {
        normalize_path(&format!("{norm_root}/{target}"))
    };
    let mut parts: Vec<&str> = vec![];
    for seg in joined.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    // Keep the root's leading-slash shape: Windows roots ("C:/x") have none.
    let resolved = format!(
        "{}{}",
        if joined.starts_with('/') { "/" } else { "" },
        parts.join("/")
    );
    let rel = if resolved == norm_root {
        String::new()
    } else {
        resolved.strip_prefix(&format!("{norm_root}/"))?.to_string()
    };
    // Symlink guard: canonicalize the deepest existing ancestor of the
    // resolved path and require it to stay under the canonical root.
    let root_abs = PathBuf::from(&norm_root);
    let root_canon = fs::canonicalize(&root_abs).unwrap_or_else(|_| root_abs.clone());
    let mut probe = root_abs.join(&rel);
    loop {
        match fs::canonicalize(&probe) {
            Ok(c) => {
                if !c.starts_with(&root_canon) {
                    return None;
                }
                break;
            }
            Err(_) => {
                if probe == root_abs || !probe.pop() {
                    break;
                }
            }
        }
    }
    Some(rel)
}

fn any_matches(patterns: &[&str], base: &str) -> bool {
    patterns
        .iter()
        .any(|p| Regex::new(p).unwrap().is_match(base))
}

pub fn is_restricted_path(relative: &str) -> bool {
    let rel = normalize_path(relative);
    let segments: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    for seg in &segments {
        if RESTRICTED_SEGMENTS.contains(&seg.to_lowercase().as_str()) {
            return true;
        }
    }
    let base = segments.last().copied().unwrap_or(rel.as_str());
    any_matches(RESTRICTED_FILE_PATTERNS, base)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileAction {
    Read,
    Write,
    Delete,
    Rename,
}

impl FileAction {
    fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Delete => "delete",
            Self::Rename => "rename",
        }
    }
}

pub fn evaluate_file_action(root: &str, target: &str, action: FileAction) -> Decision {
    let Some(rel) = resolve_within_root(root, target) else {
        return Decision {
            level: Level::Restricted,
            reason: format!("Path escapes the project root: {target}"),
        };
    };
    if is_restricted_path(&rel) {
        return Decision {
            level: Level::Restricted,
            reason: format!("Protected file: {rel} matches a credential/secret pattern"),
        };
    }
    if matches!(action, FileAction::Delete | FileAction::Rename) {
        return Decision {
            level: Level::Approval,
            reason: format!("{} requires confirmation: {}", action.label(), rel),
        };
    }
    if action == FileAction::Write && any_matches(APPROVAL_FILE_PATTERNS, &rel) {
        return Decision {
            level: Level::Approval,
            reason: format!("{rel} is a project manifest/config file"),
        };
    }
    Decision {
        level: Level::Safe,
        reason: format!(
            "{} {}",
            action.label(),
            if rel.is_empty() { "project root" } else { &rel }
        ),
    }
}

/* ------------------------------ commands ------------------------------ */

const RESTRICTED_COMMANDS: &[(&str, &str)] = &[
    (
        r"\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?/($|\s)",
        "Recursive delete of a filesystem root",
    ),
    (r"\bmkfs\b|\bformat\b.*/dev/", "Filesystem formatting"),
    (r"\bdd\b.*\bof=/dev/", "Raw disk write"),
    (r":\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:", "Fork bomb"),
    (
        r">\s*~?/?\.ssh/|cat\s+[^|]*\.ssh/|cat\s+[^|]*\.env\b",
        "Accesses a protected credential path",
    ),
];

const SAFE_PREFIXES: &[&str] = &[
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "file",
    "stat",
    "find",
    "grep",
    "rg",
    "fd",
    "tree",
    "which",
    "echo",
    "env",
    "printenv",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git remote",
    "git blame",
    "git rev-parse",
    "git ls-files",
    "git describe",
    "git stash list",
    "git tag",
    "git config --get",
    "git config --list",
    "node",
    "npm test",
    "npm run",
    "npm exec",
    "npm ls",
    "npm view",
    "npm outdated",
    "npx tsc",
    "npx vitest run",
    "npx jest",
    "pnpm test",
    "pnpm run",
    "pnpm exec",
    "pnpm ls",
    "pnpm view",
    "yarn test",
    "yarn run",
    "bun test",
    "bun run",
    "bunx",
    "tsc",
    "vitest",
    "jest",
    "mocha",
    "eslint",
    "biome",
    "prettier",
    "cargo test",
    "cargo build",
    "cargo check",
    "cargo clippy",
    "cargo fmt",
    "go test",
    "go build",
    "go vet",
    "go fmt",
    "go mod verify",
    "pytest",
    "python -m pytest",
    "python -m compileall",
    "ruff",
    "mypy",
    "mvn test",
    "mvn compile",
    "gradle test",
    "./gradlew test",
    "./gradlew build",
    "dotnet test",
    "dotnet build",
    "make test",
    "make check",
    "make build",
    "test",
    "true",
    "false",
];

// Checked before SAFE_PREFIXES: shapes that turn an otherwise-safe command
// into a code-execution vector.
const EXEC_VECTORS: &[(&str, &str)] = &[
    (
        r"\benv(\s+[A-Za-z_][A-Za-z_0-9]*=[^\s]+)*\s+[^=\s]+(\s|$)",
        "env launches a program",
    ),
    (
        r"\bfind\b.*\s-(exec|execdir|ok|okdir|delete)\b",
        "find executes a command",
    ),
    (
        r"\bfd\b.*\s(-x|-X|--exec|--exec-batch)\b",
        "fd executes a command",
    ),
    (r"\bxargs\b", "Runs a command per input line"),
    (
        r"\b(node|nodejs|deno|bun)\s+.*\s(-e|-p|--eval|--print)(=|\b)",
        "Runs inline code",
    ),
    (
        r"\b(node|nodejs|deno|bun)\s+(-e|-p|--eval|--print)(=|\b)",
        "Runs inline code",
    ),
];

const APPROVAL_COMMANDS: &[(&str, &str)] = &[
    (r"\brm\b", "Deletes files"),
    (r"\bmv\b", "Moves/renames files"),
    (r"\bcp\s+-[a-zA-Z]*r", "Recursive copy"),
    (
        r"\b(git\s+)?(commit|push|reset|clean|rebase|merge|checkout\s+-[bB]|branch\s+-[dD]|stash\s+(pop|drop)|cherry-pick|revert|tag\s+-[dD])\b",
        "Mutates git state",
    ),
    (
        r"\bgit\s+(add|commit|push|pull|fetch|reset|clean|rebase|merge|checkout|switch|restore|stash|cherry-pick|revert|rm|mv)\b",
        "Mutates git state",
    ),
    (
        r"\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade|publish|link)\b",
        "Changes dependencies",
    ),
    (
        r"\b(pip|pip3|uv|poetry)\s+(install|uninstall|add|remove)\b",
        "Changes dependencies",
    ),
    (
        r"\bcargo\s+(add|remove|install|publish)\b",
        "Changes dependencies",
    ),
    (r"\bgo\s+(get|install)\b", "Changes dependencies"),
    (r"\b(sudo|doas)\b", "Elevated privileges"),
    (r"\b(curl|wget)\b", "Network access"),
    (
        r"\|\s*(sh|bash|zsh|fish|python|node)\b",
        "Pipes to an interpreter",
    ),
    (r"\b(chmod|chown|chgrp)\b", "Changes file permissions"),
    (
        r"\b(docker|podman|kubectl|helm|terraform|ansible)\b",
        "Infrastructure access",
    ),
    (r"\b(kill|pkill|killall)\b", "Terminates processes"),
    (
        r"\b(apt|apt-get|brew|dnf|yum|pacman|snap)\s+(install|remove|uninstall)\b",
        "System package change",
    ),
    (r"\b(launchctl|systemctl|service)\b", "Service management"),
    (r"\b(sh|bash|zsh|fish)\s+-c\b", "Shell wrapper"),
    (r">\s*[^|]", "Writes to a file via redirection"),
    (r"\bssh\b|\bscp\b|\brsync\b", "Remote access"),
];

pub fn evaluate_command(command: &str) -> Decision {
    let cmd = command.trim();
    for (pat, reason) in RESTRICTED_COMMANDS {
        if Regex::new(pat).unwrap().is_match(cmd) {
            return Decision {
                level: Level::Restricted,
                reason: (*reason).into(),
            };
        }
    }
    for token in cmd.split_whitespace() {
        let cleaned = token.trim_matches(|c| c == '"' || c == '\'');
        if is_restricted_path(cleaned) {
            return Decision {
                level: Level::Restricted,
                reason: format!("Command touches protected path: {cleaned}"),
            };
        }
    }
    for (pat, reason) in EXEC_VECTORS {
        if Regex::new(pat).unwrap().is_match(cmd) {
            return Decision {
                level: Level::Approval,
                reason: (*reason).into(),
            };
        }
    }
    let lower = cmd.to_lowercase();
    let chain = cre!(r"[;&|>`]|\$\(").clone();
    for prefix in SAFE_PREFIXES {
        if lower == *prefix
            || lower.starts_with(&format!("{prefix} "))
            || lower.starts_with(&format!("{prefix}\t"))
        {
            if chain.is_match(&cmd[prefix.len()..]) {
                break;
            }
            return Decision {
                level: Level::Safe,
                reason: format!("Known safe command: {prefix}"),
            };
        }
    }
    for (pat, reason) in APPROVAL_COMMANDS {
        if Regex::new(pat).unwrap().is_match(cmd) {
            return Decision {
                level: Level::Approval,
                reason: (*reason).into(),
            };
        }
    }
    Decision {
        level: Level::Approval,
        reason: "Unrecognized command — confirming before execution".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_prefix_stays_safe() {
        for cmd in [
            "ls",
            "ls -la src",
            "cat file.txt",
            "git status",
            "cargo test",
            "node script.js",
            "env",
        ] {
            assert_eq!(evaluate_command(cmd).level, Level::Safe, "{cmd}");
        }
    }

    #[test]
    fn env_launching_a_program_needs_approval() {
        for cmd in ["env rm -rf x", "env FOO=1 node x.js", "env -i sh"] {
            assert_eq!(evaluate_command(cmd).level, Level::Approval, "{cmd}");
        }
        assert_eq!(evaluate_command("env FOO=1").level, Level::Safe);
    }

    #[test]
    fn exec_flags_need_approval() {
        for cmd in [
            "find . -exec rm {} \\;",
            "find . -delete",
            "fd . -x rm {}",
            "ls | xargs rm",
            "node -e 'process.exit(1)'",
            "node --eval 'x'",
            "node -p '1+1'",
        ] {
            assert_eq!(evaluate_command(cmd).level, Level::Approval, "{cmd}");
        }
        // benign variants stay safe
        for cmd in ["find . -name '*.rs'", "fd . src", "node --version"] {
            assert_eq!(evaluate_command(cmd).level, Level::Safe, "{cmd}");
        }
    }

    #[test]
    fn lexical_escape_still_rejected() {
        assert!(resolve_within_root("/proj", "../outside.txt").is_none());
        assert!(resolve_within_root("/proj", "/etc/passwd").is_none());
        assert_eq!(
            resolve_within_root("/proj", "src/a.rs").as_deref(),
            Some("src/a.rs")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected() {
        use std::os::unix::fs::symlink;
        let tmp = std::env::temp_dir().join(format!("dxxp-perm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");
        let outside = tmp.join("outside");
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, proj.join("link")).unwrap();
        // A file targeted through the symlink escapes the root.
        assert!(resolve_within_root(proj.to_str().unwrap(), "link/secret.txt").is_none());
        // A normal path inside the project still resolves.
        fs::write(proj.join("ok.txt"), "x").unwrap();
        assert_eq!(
            resolve_within_root(proj.to_str().unwrap(), "ok.txt").as_deref(),
            Some("ok.txt")
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}

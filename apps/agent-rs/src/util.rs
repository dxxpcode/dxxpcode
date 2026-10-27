//! Secret redaction, @mention expansion, and the project file index.

use crate::perm::{is_restricted_path, resolve_within_root};
use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const MASK: &str = "[redacted]";

fn key_patterns() -> &'static [Regex] {
    static RE: OnceLock<Vec<Regex>> = OnceLock::new();
    RE.get_or_init(|| {
        [
            r"sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{8,}",
            r"gh[pousr]_[A-Za-z0-9]{16,}",
            r"github_pat_[A-Za-z0-9_]{20,}",
            r"AKIA[0-9A-Z]{16}",
            r"xox[baprs]-[A-Za-z0-9-]{10,}",
            r"AIza[0-9A-Za-z_-]{35}",
            r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    })
}

fn secret_env_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(KEY|TOKEN|SECRET|PASSWORD)").unwrap())
}

fn env_secrets() -> Vec<String> {
    let mut out: Vec<String> = std::env::vars()
        .filter(|(k, v)| v.len() >= 8 && secret_env_re().is_match(k))
        .map(|(_, v)| v)
        .collect();
    out.sort_by(|a, b| b.len().cmp(&a.len()));
    out
}

pub fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    for s in env_secrets() {
        out = out.replace(&s, MASK);
    }
    for re in key_patterns() {
        out = re.replace_all(&out, MASK).to_string();
    }
    out
}

/* ------------------------------- mentions ------------------------------- */

const MAX_BYTES: usize = 200 * 1024;
const MAX_DIR_ENTRIES: usize = 400;
const MAX_BRANCH_COMMITS: usize = 50;
const MAX_BRANCH_STAT_LINES: usize = 100;
const MAX_INDEX_ENTRIES: usize = 8000;
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".dxxpcode",
    "node_modules",
    "dist",
    "build",
    ".next",
    "out",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    "target",
];

pub struct MentionsResult {
    pub text: String,
    pub attached: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

fn walk_files_limited(root: &Path, rel: &str, out: &mut Vec<String>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let Ok(rd) = fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        if out.len() >= cap {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let p = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) && !is_restricted_path(&p) {
                walk_files_limited(root, &p, out, cap);
            }
        } else if ft.is_file() && !is_restricted_path(&p) {
            out.push(p);
        }
    }
}

fn mention_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:^|\s)@([A-Za-z0-9_./~-]+)(?:#(\d+)(?:-(\d+))?)?").unwrap())
}

pub fn expand_mentions(task: &str, root: &str) -> MentionsResult {
    let mut seen = HashSet::new();
    let mut blocks = vec![];
    let mut attached = vec![];
    let mut skipped = vec![];
    let rootp = PathBuf::from(root);

    for m in mention_re().captures_iter(task) {
        let raw = m.get(1).map(|g| g.as_str()).unwrap_or("");
        let p = raw.trim_end_matches(|c: char| {
            matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}' | '>')
        });
        if p.is_empty() {
            continue;
        }
        let from = m.get(2).and_then(|g| g.as_str().parse::<usize>().ok());
        let to = m.get(3).and_then(|g| g.as_str().parse::<usize>().ok());
        let Some(rel) = resolve_within_root(root, p.trim_end_matches('/')) else {
            skipped.push((p.to_string(), "outside project root".into()));
            continue;
        };
        if is_restricted_path(&rel) {
            skipped.push((p.to_string(), "protected file".into()));
            continue;
        }
        let key = format!("{rel}#{}-{}", from.unwrap_or(0), to.unwrap_or(0));
        if !seen.insert(key) {
            continue;
        }
        let abs = rootp.join(&rel);
        if !abs.exists() {
            // Not a path — try a git branch: attach what the branch adds over
            // HEAD (commits + diff stat), like Cursor's @Branch.
            if let Some((label, block)) = branch_context(root, p) {
                attached.push(label);
                blocks.push(block);
            } else {
                skipped.push((p.to_string(), "not found".into()));
            }
            continue;
        }
        if abs.is_dir() {
            let mut files = vec![];
            walk_files_limited(&rootp, &rel, &mut files, MAX_DIR_ENTRIES);
            files.sort();
            if files.is_empty() {
                skipped.push((p.to_string(), "empty directory".into()));
                continue;
            }
            attached.push(format!("{rel}/ ({} files)", files.len()));
            blocks.push(format!(
                "\n\n<directory path=\"{rel}/\">\n{}\n</directory>",
                files.join("\n")
            ));
            continue;
        }
        if !abs.is_file() {
            skipped.push((p.to_string(), "not found".into()));
            continue;
        }
        let Ok(raw) = fs::read_to_string(&abs) else {
            skipped.push((p.to_string(), "not found".into()));
            continue;
        };
        if raw.len() > MAX_BYTES || raw.contains('\0') {
            skipped.push((p.to_string(), "too large or binary".into()));
            continue;
        }
        if let Some(f) = from {
            let lines: Vec<&str> = raw.split('\n').collect();
            if f < 1 || f > lines.len() {
                skipped.push((
                    p.to_string(),
                    format!("line range out of bounds ({} lines)", lines.len()),
                ));
                continue;
            }
            let end = to.unwrap_or(f).clamp(f, lines.len());
            let slice = &lines[f - 1..end];
            attached.push(format!("{rel}#{f}-{end} ({} lines)", slice.len()));
            blocks.push(format!(
                "\n\n<file path=\"{rel}\" lines=\"{f}-{end}\">\n{}\n</file>",
                slice.join("\n")
            ));
            continue;
        }
        attached.push(format!("{rel} ({} lines)", raw.split('\n').count()));
        blocks.push(format!(
            "\n\n<file path=\"{rel}\">\n{}\n</file>",
            raw.trim_end_matches('\n')
        ));
    }
    MentionsResult {
        text: task.to_string() + &blocks.join(""),
        attached,
        skipped,
    }
}

/// `@<branch>` context: commits the branch adds over HEAD plus the diff stat
/// against the merge base — the "what would change if this landed" view.
/// `None` when `name` isn't a local branch (callers try path resolution first,
/// so a file/dir named like a branch always wins).
fn branch_context(root: &str, name: &str) -> Option<(String, String)> {
    git_stdout_ok(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )?;
    let log = git_stdout(
        root,
        &[
            "log",
            "--oneline",
            "--no-decorate",
            &format!("HEAD..{name}"),
        ],
    );
    let stat = git_stdout(root, &["diff", "--stat", &format!("HEAD...{name}")]);
    let commits: Vec<&str> = log.lines().take(MAX_BRANCH_COMMITS).collect();
    let stat_lines: Vec<&str> = stat.lines().take(MAX_BRANCH_STAT_LINES).collect();
    let label = format!(
        "{name} (branch: {} commits, {} files changed)",
        commits.len(),
        stat_lines.len().saturating_sub(1).max(0)
    );
    let block = format!(
        "\n\n<branch name=\"{name}\">\ncommits ahead of HEAD:\n{}\n\ndiff stat vs merge-base:\n{}\n</branch>",
        if commits.is_empty() {
            "(none — branch is at or behind HEAD)".to_string()
        } else {
            commits.join("\n")
        },
        stat_lines.join("\n")
    );
    Some((label, block))
}

/* ------------------------------- git helpers ------------------------------ */

/// Raw stdout of `git <args>` run in `root`; empty when git can't run.
/// `GIT_PAGER=cat` is always set so output never blocks on a pager.
pub fn git_stdout(root: &str, args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_PAGER", "cat")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// Trimmed stdout when the command succeeds, `None` otherwise.
pub fn git_stdout_ok(root: &str, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_PAGER", "cat")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Exit code plus combined stdout+stderr — for surfacing git output to the model.
pub fn git_result(root: &str, args: &[&str]) -> (i32, String) {
    match Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_PAGER", "cat")
        .output()
    {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.is_empty() {
                s.push_str(&format!("\n{err}"));
            }
            (o.status.code().unwrap_or(1), s)
        }
        Err(_) => (1, String::new()),
    }
}

/* ----------------------------- file index ----------------------------- */

pub struct FileIndex {
    pub files: Vec<String>,
    pub dirs: Vec<String>,
    pub branches: Vec<String>,
}

fn git_files(root: &str) -> Option<Vec<String>> {
    let text = git_stdout_ok(root, &["ls-files", "-co", "--exclude-standard"])?;
    if text.is_empty() {
        return None;
    }
    Some(
        text.lines()
            .take(MAX_INDEX_ENTRIES)
            .map(String::from)
            .collect(),
    )
}

pub fn list_project_files(root: &str) -> FileIndex {
    let files = git_files(root).unwrap_or_else(|| {
        let mut out = vec![];
        walk_files_limited(Path::new(root), "", &mut out, MAX_INDEX_ENTRIES);
        out
    });
    let mut dirs: HashSet<String> = HashSet::new();
    for f in &files {
        let mut p = Path::new(f).parent();
        while let Some(d) = p {
            let s = d.to_string_lossy().to_string();
            if s.is_empty() {
                break;
            }
            dirs.insert(s.clone());
            p = d.parent();
        }
    }
    let mut dirs: Vec<String> = dirs.into_iter().collect();
    dirs.sort();
    let branches = git_stdout_ok(
        root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .map(|t| t.lines().map(String::from).collect())
    .unwrap_or_default();
    FileIndex {
        files,
        dirs,
        branches,
    }
}

fn path_basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Ranked completions for an `@` fragment — dirs first, top 8.
pub fn file_suggestions(idx: &FileIndex, frag: &str) -> Vec<(String, &'static str)> {
    let f = frag.to_lowercase();
    let base = path_basename(&f).to_string();
    let score = |p: &str| -> i32 {
        let lp = p.to_lowercase();
        if lp == f {
            0
        } else if lp.starts_with(&f) {
            if path_basename(&lp).starts_with(&base) {
                1
            } else {
                2
            }
        } else if path_basename(&lp).starts_with(&base) {
            3
        } else if lp.contains(&f) {
            4
        } else {
            -1
        }
    };
    let mut seen = HashSet::new();
    // kind: 2 = dir, 1 = branch, 0 = file (dirs rank ahead on equal scores).
    let mut entries: Vec<(String, i32, u8)> = vec![];
    for d in &idx.dirs {
        let s = score(&format!("{d}/"));
        if s >= 0 && seen.insert(d.clone()) {
            entries.push((format!("{d}/"), s, 2));
        }
    }
    for p in &idx.files {
        let s = score(p);
        if s >= 0 && seen.insert(p.clone()) {
            entries.push((p.clone(), s, 0));
        }
    }
    for b in &idx.branches {
        let s = score(b);
        if s >= 0 && seen.insert(b.clone()) {
            entries.push((b.clone(), s, 1));
        }
    }
    entries.sort_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)).then(a.0.cmp(&b.0)));
    entries
        .into_iter()
        .take(8)
        .map(|(p, _, kind)| {
            (
                p,
                if kind == 2 {
                    "dir"
                } else if kind == 1 {
                    "branch"
                } else {
                    "file"
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dxxp-mentions-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), (1..=10).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
        dir
    }

    #[test]
    fn mention_reversed_range_does_not_panic() {
        let dir = fixture("rev");
        let res = expand_mentions("see @a.txt#5-2", dir.to_str().unwrap());
        // A reversed range clamps to the start line instead of slicing [4..2].
        assert_eq!(res.attached.len(), 1, "{:?}", res.skipped);
        assert!(res.attached[0].contains("#5-5"), "{:?}", res.attached);
        assert!(res.skipped.is_empty(), "{:?}", res.skipped);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mention_ranges_with_same_start_are_not_deduped() {
        let dir = fixture("dedup");
        let res = expand_mentions("@a.txt#1-2 and @a.txt#1-8", dir.to_str().unwrap());
        assert_eq!(res.attached.len(), 2, "{:?}", res.attached);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mention_out_of_bounds_range_is_skipped() {
        let dir = fixture("oob");
        let res = expand_mentions("@a.txt#50-60", dir.to_str().unwrap());
        assert!(res.attached.is_empty(), "{:?}", res.attached);
        assert_eq!(res.skipped.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}

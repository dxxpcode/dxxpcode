use super::*;

pub(super) fn exec_list_directory(input: &Value, ctx: &Ctx) -> ToolResult {
    let path = opt_str(input, "path").unwrap_or_else(|| ".".into());
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    let Ok(meta) = fs::metadata(&abs) else {
        return ToolResult::err(format!(
            "not a directory: {}",
            if r.is_empty() { "." } else { &r }
        ));
    };
    if !meta.is_dir() {
        return ToolResult::err(format!(
            "not a directory: {}",
            if r.is_empty() { "." } else { &r }
        ));
    }
    const SKIP: &[&str] = &["node_modules", ".git", "__pycache__"];
    let mut entries: Vec<String> = fs::read_dir(&abs)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !SKIP.contains(&e.file_name().to_string_lossy().as_ref()))
                .map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        format!("{n}/")
                    } else {
                        n
                    }
                })
                .take(500)
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    ToolResult::ok(if entries.is_empty() {
        "(empty)".into()
    } else {
        entries.join("\n")
    })
}

pub(super) fn exec_read_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(path) = str_arg(input, "path") else {
        return ToolResult::err("missing or invalid \"path\"");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    if !abs.exists() {
        return ToolResult::err(format!("file not found: {r}"));
    }
    let Ok(meta) = fs::metadata(&abs) else {
        return ToolResult::err(format!("not a file: {r}"));
    };
    if !meta.is_file() {
        return ToolResult::err(format!("not a file: {r}"));
    }
    if meta.len() > MAX_READ_BYTES {
        return ToolResult::err(format!(
            "file too large ({} bytes); read a range with offset/limit",
            meta.len()
        ));
    }
    let Ok(raw) = fs::read_to_string(&abs) else {
        return ToolResult::err(format!("binary file not shown: {r}"));
    };
    if raw.contains('\0') {
        return ToolResult::err(format!("binary file not shown: {r}"));
    }
    let all: Vec<&str> = raw.split('\n').collect();
    let offset = (opt_num(input, "offset").unwrap_or(1.0) as usize).max(1);
    let limit =
        (opt_num(input, "limit").unwrap_or(MAX_READ_LINES as f64) as usize).min(MAX_READ_LINES);
    let start = (offset - 1).min(all.len());
    let end = start.saturating_add(limit).min(all.len());
    let slice = &all[start..end];
    let numbered: String = slice
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{}\t{}", offset + i, l))
        .collect::<Vec<_>>()
        .join("\n");
    let truncated = offset - 1 + slice.len() < all.len();
    ToolResult::ok(format!(
        "{}{}",
        numbered,
        if truncated {
            format!("\n… ({} lines total, truncated)", all.len())
        } else {
            String::new()
        }
    ))
}

pub(super) fn exec_write_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let (Ok(path), Ok(content)) = (str_arg(input, "path"), str_arg(input, "content")) else {
        return ToolResult::err("missing or invalid input");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    if let Some(parent) = abs.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let prev = fs::read_to_string(&abs).ok();
    let existed = prev.is_some();
    if fs::write(&abs, &content).is_err() {
        return ToolResult::err(format!("failed to write: {r}"));
    }
    let mut res = ToolResult::ok(format!(
        "{} {} ({} lines)",
        if existed { "updated" } else { "created" },
        r,
        content.split('\n').count()
    ));
    res.changed_file = Some(r.clone());
    res.diff = Some(preview_diff(&r, prev.as_deref(), &content)).filter(|d| !d.is_empty());
    res
}

pub(super) struct Edit {
    pub(super) old: String,
    pub(super) new: String,
}

pub(super) fn edits_from(input: &Value) -> Option<Vec<Edit>> {
    if let Some(arr) = input.get("edits").and_then(|v| v.as_array()) {
        let mut out = Vec::with_capacity(arr.len());
        for e in arr {
            let old = e.get("old_string").and_then(|v| v.as_str())?;
            let new = e.get("new_string").and_then(|v| v.as_str())?;
            out.push(Edit {
                old: old.to_string(),
                new: new.to_string(),
            });
        }
        return if out.is_empty() { None } else { Some(out) };
    }
    let old = input.get("old_string").and_then(|v| v.as_str())?;
    let new = input.get("new_string").and_then(|v| v.as_str())?;
    Some(vec![Edit {
        old: old.to_string(),
        new: new.to_string(),
    }])
}

/// Locate `old` inside `raw` exactly or with per-line whitespace tolerance.
/// Returns (matches, mode) — each match a (start_byte, end_byte) region.
fn find_matches(raw: &str, old: &str) -> (Vec<(usize, usize)>, &'static str) {
    if old.is_empty() {
        return (vec![], "exact");
    }
    let mut hits: Vec<(usize, usize)> = raw
        .match_indices(old)
        .map(|(i, _)| (i, i + old.len()))
        .collect();
    if !hits.is_empty() {
        return (hits, "exact");
    }
    // Whitespace-tolerant: compare lines after trimming each side's edges.
    let old_lines: Vec<&str> = old.lines().map(|l| l.trim()).collect();
    if old_lines.is_empty() || old_lines.iter().all(|l| l.is_empty()) {
        return (vec![], "exact");
    }
    // Real byte offset of each line start — `lines()` strips a trailing
    // '\r' as well as '\n', so line.len()+1 undercounts CRLF files and a
    // missing trailing newline; using it here would splice at wrong bytes.
    let raw_lines: Vec<&str> = raw.lines().collect();
    let mut line_starts: Vec<usize> = Vec::with_capacity(raw_lines.len() + 1);
    {
        let mut pos = 0usize;
        for l in &raw_lines {
            line_starts.push(pos);
            pos += l.len();
            pos += raw[pos..].chars().next().map(|c| c.len_utf8()).unwrap_or(0);
            if raw.as_bytes().get(pos.wrapping_sub(1)) == Some(&b'\r')
                && raw.as_bytes().get(pos) == Some(&b'\n')
            {
                pos += 1;
            }
        }
        line_starts.push(pos.min(raw.len()));
    }
    let n = old_lines.len();
    for (i, w) in raw_lines.windows(n).enumerate() {
        if w.iter().zip(&old_lines).all(|(a, b)| a.trim() == *b) {
            let start = line_starts[i];
            // End of the last matched line's content — the line's own
            // terminator stays outside the replaced region.
            let end = (line_starts[i + n - 1] + raw_lines[i + n - 1].len()).min(raw.len());
            hits.push((start, end));
        }
    }
    if !hits.is_empty() {
        return (hits, "whitespace-tolerant");
    }
    (vec![], "exact")
}

/// Best-effort closest region for a failed match: the contiguous line window
/// sharing the most trimmed lines with `old`, shown to the model so it can
/// self-correct in one retry.
fn closest_region(raw: &str, old: &str) -> Option<String> {
    let old_set: std::collections::HashSet<&str> = old
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if old_set.is_empty() {
        return None;
    }
    let n = old.lines().count().max(2);
    let raw_lines: Vec<&str> = raw.lines().collect();
    let mut best = (0usize, 0usize); // (score, start_line)
    for i in 0..raw_lines.len().saturating_sub(n - 1).max(1) {
        let score = raw_lines[i..(i + n).min(raw_lines.len())]
            .iter()
            .filter(|l| old_set.contains(l.trim()))
            .count();
        if score > best.0 {
            best = (score, i);
        }
    }
    if best.0 == 0 {
        return None;
    }
    let end = (best.1 + n).min(raw_lines.len());
    let body = raw_lines[best.1..end]
        .iter()
        .enumerate()
        .map(|(k, l)| format!("{:>4}| {l}", best.1 + k + 1))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("closest match at line {}:\n{body}", best.1 + 1))
}

/// Apply edits sequentially, enforcing the unique-match guard unless
/// replace_all. Returns (updated content, matched-with-whitespace-tolerance)
/// or an error message for the model.
pub(super) fn apply_edits(
    raw: &str,
    edits: &[Edit],
    replace_all: bool,
    path: &str,
) -> Result<(String, bool), String> {
    let mut content = raw.to_string();
    let mut used_fallback = false;
    for (i, e) in edits.iter().enumerate() {
        let (hits, mode) = find_matches(&content, &e.old);
        let tag = if edits.len() > 1 {
            format!("edit {}: ", i + 1)
        } else {
            String::new()
        };
        if hits.is_empty() {
            let hint = closest_region(&content, &e.old)
                .map(|h| format!("; {h}"))
                .unwrap_or_default();
            return Err(format!("{tag}old_string not found in {path}{hint}"));
        }
        if hits.len() > 1 && !replace_all {
            return Err(format!(
                "{tag}old_string matches {} times in {path}; provide more context or set replace_all",
                hits.len()
            ));
        }
        used_fallback |= mode != "exact";
        if replace_all {
            for (s, e_) in hits.iter().rev() {
                content.replace_range(*s..*e_, &e.new);
            }
        } else {
            let (s, e_) = hits[0];
            content.replace_range(s..e_, &e.new);
        }
    }
    Ok((content, used_fallback))
}

pub(super) fn exec_edit_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(path) = str_arg(input, "path") else {
        return ToolResult::err("missing or invalid input");
    };
    let Some(edits) = edits_from(input) else {
        return ToolResult::err("missing \"old_string\"/\"new_string\" or \"edits\"");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    let Ok(raw) = fs::read_to_string(&abs) else {
        return ToolResult::err(format!("file not found: {r}"));
    };
    let replace_all = input.get("replace_all").and_then(|v| v.as_bool()) == Some(true);
    let (updated, tolerant) = match apply_edits(&raw, &edits, replace_all, &r) {
        Ok(u) => u,
        Err(m) => return ToolResult::err(m),
    };
    if fs::write(&abs, &updated).is_err() {
        return ToolResult::err(format!("failed to write: {r}"));
    }
    let mut res = ToolResult::ok(format!(
        "edited {r} ({} edit{}{})",
        edits.len(),
        if edits.len() > 1 { "s" } else { "" },
        if tolerant {
            ", whitespace-tolerant match"
        } else {
            ""
        }
    ));
    res.changed_file = Some(r.clone());
    res.diff = Some(preview_diff(&r, Some(&raw), &updated)).filter(|d| !d.is_empty());
    res
}

pub(super) fn exec_delete_file(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(path) = str_arg(input, "path") else {
        return ToolResult::err("missing or invalid \"path\"");
    };
    let Some(r) = rel(ctx, &path) else {
        return escape_result(&path);
    };
    let abs = Path::new(&ctx.root).join(&r);
    if !abs.exists() {
        return ToolResult::err(format!("not found: {r}"));
    }
    if fs::remove_file(&abs).map(|_| ()).is_err() && fs::remove_dir(&abs).is_err() {
        return ToolResult::err(format!("failed to delete: {r}"));
    }
    let mut res = ToolResult::ok(format!("deleted {r}"));
    res.changed_file = Some(r);
    res
}

/* -------------------------------- search --------------------------------- */

const SEARCH_SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    ".dxxpcode",
    "coverage",
    ".turbo",
];
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_MATCHES: usize = 100;

fn walk_search(root: &Path, rel: &str, out: &mut Vec<String>) {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let Ok(rd) = fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let p = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !SEARCH_SKIP.contains(&name.as_str()) && !crate::perm::is_restricted_path(&p) {
                walk_search(root, &p, out);
            }
        } else if ft.is_file() && !crate::perm::is_restricted_path(&p) {
            out.push(p);
        }
    }
}

fn glob_to_re(glob: &str) -> Option<regex::Regex> {
    let mut pat = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => pat.push_str(".*"),
            '?' => pat.push('.'),
            c if ".+^${}()|[]\\".contains(c) => {
                pat.push('\\');
                pat.push(c);
            }
            c => pat.push(c),
        }
    }
    pat.push('$');
    regex::Regex::new(&pat).ok()
}

pub(super) fn exec_search_files(input: &Value, ctx: &Ctx) -> ToolResult {
    let Ok(pattern) = str_arg(input, "pattern") else {
        return ToolResult::err("missing or invalid \"pattern\"");
    };
    let base = opt_str(input, "path").unwrap_or_else(|| ".".into());
    let Some(rel) = resolve_within_root(&ctx.root, &base) else {
        return ToolResult::err(format!("directory not found: {base}"));
    };
    let abs = Path::new(&ctx.root).join(&rel);
    if !abs.exists() {
        return ToolResult::err(format!("directory not found: {base}"));
    }
    let flags = if input.get("case_insensitive").and_then(|v| v.as_bool()) == Some(true) {
        "(?i)"
    } else {
        ""
    };
    let Ok(re) = regex::Regex::new(&format!("{flags}{pattern}")) else {
        return ToolResult::err(format!("invalid regex: {pattern}"));
    };
    let glob_re = opt_str(input, "glob").and_then(|g| glob_to_re(&g));

    let files = if abs.is_dir() {
        let mut v = vec![];
        walk_search(Path::new(&ctx.root), &rel, &mut v);
        v
    } else {
        vec![rel.clone()]
    };
    let mut matches = vec![];
    'outer: for file in files {
        if let Some(gr) = &glob_re {
            let base_name = file.rsplit('/').next().unwrap_or(&file);
            if !gr.is_match(base_name) {
                continue;
            }
        }
        let absf = Path::new(&ctx.root).join(&file);
        let Ok(meta) = fs::metadata(&absf) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(&absf) else {
            continue;
        };
        if text.contains('\0') {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                matches.push(format!(
                    "{file}:{}: {}",
                    i + 1,
                    line.chars().take(200).collect::<String>()
                ));
                if matches.len() >= MAX_MATCHES {
                    break 'outer;
                }
            }
        }
    }
    ToolResult::ok(if matches.is_empty() {
        "no matches".into()
    } else {
        let mut body = matches.join("\n");
        if matches.len() >= MAX_MATCHES {
            body += &format!("\n… (truncated at {MAX_MATCHES})");
        }
        body
    })
}

/* --------------------------------- shell --------------------------------- */

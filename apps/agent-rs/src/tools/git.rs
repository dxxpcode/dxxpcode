use super::*;

const GIT_MAX_OUTPUT: usize = 64 * 1024;

fn git_cmd(ctx: &Ctx, args: &[&str]) -> (i32, String) {
    let (code, out) = crate::util::git_result(&ctx.root, args);
    (code, out.chars().take(GIT_MAX_OUTPUT).collect())
}

pub(super) fn exec_git_status(_i: &Value, ctx: &Ctx) -> ToolResult {
    let (code, out) = git_cmd(ctx, &["status", "--short", "--branch"]);
    ToolResult {
        content: if out.trim().is_empty() {
            "clean".into()
        } else {
            out
        },
        is_error: code != 0,
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

pub(super) fn exec_git_diff(input: &Value, ctx: &Ctx) -> ToolResult {
    let mut args = vec!["diff"];
    if input.get("staged").and_then(|v| v.as_bool()) == Some(true) {
        args.push("--cached");
    }
    let mut owned: Vec<String> = vec![];
    if let Some(path) = opt_str(input, "path") {
        owned.push("--".into());
        owned.push(path);
    }
    let argrefs: Vec<&str> = args
        .iter()
        .copied()
        .chain(owned.iter().map(|s| s.as_str()))
        .collect();
    let (code, out) = git_cmd(ctx, &argrefs);
    ToolResult {
        content: if out.trim().is_empty() {
            "(no diff)".into()
        } else {
            out
        },
        is_error: code != 0,
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

pub(super) fn exec_git_log(input: &Value, ctx: &Ctx) -> ToolResult {
    let limit = (opt_num(input, "limit").unwrap_or(15.0) as usize).min(30);
    let max = format!("--max-count={limit}");
    let (code, out) = git_cmd(ctx, &["log", &max, "--oneline", "--decorate"]);
    ToolResult {
        content: if out.trim().is_empty() {
            "(no commits)".into()
        } else {
            out
        },
        is_error: code != 0,
        changed_file: None,
        diff: None,
        images: vec![],
    }
}

/* ------------------------------- registry -------------------------------- */

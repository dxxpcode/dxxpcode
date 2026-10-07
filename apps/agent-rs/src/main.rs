//! dxxpcode — the DxxpCode agent engine.
//! `--app` speaks the NDJSON shell protocol consumed by the desktop app.

mod agent;
mod app;
mod browser;
mod config;
mod errors;
mod perm;
mod project;
mod provider;
mod serve;
mod tools;
mod util;

use config::load_config;

fn latest_session_for_local(root: &str) -> Option<config::SessionRecord> {
    config::list_sessions()
        .into_iter()
        .find(|s| s.project_root == root)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(|a| a.as_str()) == Some("serve") {
        std::process::exit(serve::run());
    }
    let mut app_mode = false;
    let mut plan = false;
    let mut resume = false;
    let mut version = false;
    let mut yes = false;
    let mut provider_flag: Option<String> = None;
    let mut model_flag: Option<String> = None;
    let mut effort_flag: Option<String> = None;
    let mut variant_flag: Option<String> = None;
    let mut max_iterations: Option<u32> = None;
    let mut task_prompt: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "--app" => app_mode = true,
            "--task" | "--print" => {
                i += 1;
                task_prompt = argv.get(i).cloned();
            }
            "--plan" => plan = true,
            "--resume" => resume = true,
            "--version" | "-v" => version = true,
            "--help" | "-h" => {
                println!("dxxpcode — the agent engine inside the DxxpCode desktop app\n\n  dxxpcode --app            NDJSON protocol mode (used by the app)\n  dxxpcode --version        Print version\n");
                return;
            }
            "--yes" | "-y" => yes = true,
            "--provider" => {
                i += 1;
                provider_flag = argv.get(i).cloned();
            }
            "--model" => {
                i += 1;
                model_flag = argv.get(i).cloned();
            }
            "--effort" => {
                i += 1;
                effort_flag = argv.get(i).cloned();
            }
            "--variant" => {
                i += 1;
                variant_flag = argv.get(i).cloned();
            }
            "--max-iterations" => {
                i += 1;
                max_iterations = argv
                    .get(i)
                    .and_then(|v| v.parse::<u32>().ok())
                    .filter(|n| *n > 0);
            }
            _ => {
                if let Some(v) = a.strip_prefix("--provider=") {
                    provider_flag = Some(v.to_string());
                } else if let Some(v) = a.strip_prefix("--model=") {
                    model_flag = Some(v.to_string());
                } else if let Some(v) = a.strip_prefix("--effort=") {
                    effort_flag = Some(v.to_string());
                } else if let Some(v) = a.strip_prefix("--variant=") {
                    variant_flag = Some(v.to_string());
                }
            }
        }
        i += 1;
    }
    if version {
        println!("dxxpcode {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if let Some(task) = task_prompt {
        run_task_once(&root_wait(), task);
        return;
    }
    fn root_wait() -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".into())
    }
    if !app_mode {
        eprintln!("dxxpcode-rs supports --app mode only (the terminal UI is the TS CLI).");
        std::process::exit(2);
    }

    let root = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into());
    let cfg = load_config();
    // Config-provided OpenAI base url (saved during onboarding) mirrors cli.ts.
    if std::env::var("OPENAI_BASE_URL").is_err() {
        if let Some(b) = &cfg.openai_base_url {
            std::env::set_var("OPENAI_BASE_URL", b);
        }
    }

    let provider_name = provider_flag.or_else(|| cfg.provider.clone());
    let model = model_flag.or_else(|| cfg.model.clone());
    let (provider, model) =
        match provider::resolve_provider(provider_name.as_deref(), model.as_deref(), &cfg) {
            Ok(t) => t,
            Err(e) => {
                // The app still needs a process it can talk to for onboarding —
                // fall back to a stub provider and let needsSetup drive the flow.
                let _ = e;
                (
                    provider::Provider::Mock {
                        script: vec![
                            serde_json::json!({"text": "(no provider configured — run setup)"}),
                        ],
                        turn: 0,
                    },
                    cfg.model.clone().unwrap_or_else(|| "mock".into()),
                )
            }
        };

    let env_effort = std::env::var("DXXPCODE_EFFORT").ok();
    let effort = effort_flag
        .or_else(|| {
            env_effort.filter(|e| {
                ["minimal", "low", "medium", "high", "xhigh", "max"].contains(&e.as_str())
            })
        })
        .or_else(|| cfg.effort.clone());
    let env_variant = std::env::var("DXXPCODE_VARIANT").ok();
    let variant = variant_flag
        .or(env_variant)
        .or_else(|| cfg.variant.clone())
        .filter(|s| s != "default")
        .filter(|s| {
            cfg.variants.as_ref().is_some_and(|v| v.contains_key(s)) || {
                eprintln!("unknown variant: {s} — define it under \"variants\" in config.json");
                false
            }
        });
    let auto_approve = yes || cfg.approval_mode.as_deref() == Some("auto");
    let smart_mode = !yes && cfg.approval_mode.as_deref() == Some("smart");
    let mode = if plan {
        "plan"
    } else if auto_approve {
        "always-approve"
    } else if smart_mode {
        "smart"
    } else {
        "ask"
    };

    let session = if resume {
        latest_session_for_local(&root)
    } else {
        None
    };
    let project = project::detect_project(&root);

    std::process::exit(app::run_app(app::AppDeps {
        version: env!("CARGO_PKG_VERSION").to_string(),
        provider,
        model,
        effort,
        variant,
        project,
        root,
        session,
        plan_only: plan,
        auto_approve,
        smart_approve_mode: smart_mode,
        max_iterations: max_iterations.or(cfg.max_iterations),
        config: cfg,
        mode: mode.to_string(),
    }));
}

/// `dxxpcode --task "…"` — one-shot non-interactive run (auto-approved),
/// used for spawning detached sub-agent sessions (e.g. /review agent).
fn run_task_once(root: &str, task: String) {
    use std::io::Write;
    let cfg = load_config();
    if std::env::var("OPENAI_BASE_URL").is_err() {
        if let Some(b) = &cfg.openai_base_url {
            std::env::set_var("OPENAI_BASE_URL", b);
        }
    }
    let provider_name = std::env::var("DXXPCODE_PROVIDER")
        .ok()
        .or(cfg.provider.clone());
    let model_name = std::env::var("DXXPCODE_MODEL").ok().or(cfg.model.clone());
    let (mut provider, model) =
        match provider::resolve_provider(provider_name.as_deref(), model_name.as_deref(), &cfg) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
    let mut approve_plan = |plan: &serde_json::Value| Some(plan.clone());
    let mut approve_tool = |_t: &str, _i: &serde_json::Value, _r: &str, _m: Option<&str>| true;
    let mut review_change = |_t: &str, _i: &serde_json::Value, _d: &str| true;
    let mut steer = || None;
    let procs = crate::tools::load_procs(root);
    let mut opts = agent::RunOpts {
        task,
        provider: &mut provider,
        model,
        project_root: root.to_string(),
        plan_only: false,
        max_iterations: cfg.max_iterations,
        approve_plan: &mut approve_plan,
        approve_tool: &mut approve_tool,
        review_change: &mut review_change,
        session: None,
        chat: false,
        effort: cfg.effort.clone(),
        variant_opts: cfg
            .variant
            .as_ref()
            .and_then(|n| cfg.variants.as_ref().and_then(|v| v.get(n).cloned())),
        aborted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        steer: &mut steer,
        procs,
    };
    let mut ok = true;
    agent::run_task(
        &mut opts,
        &mut |ev| match ev.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = ev.get("text").and_then(|t| t.as_str()) {
                    print!("{t}");
                    let _ = std::io::stdout().flush();
                }
            }
            Some("done") => {
                let status = ev
                    .pointer("/result/status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                ok = status == "completed";
                println!();
            }
            _ => {}
        },
    );
    std::process::exit(if ok { 0 } else { 1 });
}

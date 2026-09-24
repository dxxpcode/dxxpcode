#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { detectProject } from "@dxxpcode/project";
import { ProviderConfigError, resolveProvider } from "@dxxpcode/providers";
import { homeDir, latestSessionFor, loadConfig, loadSession, saveConfig } from "@dxxpcode/sessions";
import type { SessionRecord } from "@dxxpcode/sessions";
import { renderBanner, renderTips } from "./banner.ts"; // kept for non-interactive/tests
import { expandMentions } from "./mentions.ts";
import { createPrompter } from "./prompt.ts";
import { undoCheckpoint } from "@dxxpcode/agent";
import { runAndRender } from "./run.ts";
import { bold, cyan, dim, errLine, green, line, pill, red, renderDiff, rule } from "./render.ts";

const VERSION = "0.1.0";

const HELP = `dxxpcode — AI coding agent for your terminal

Usage:
  dxxpcode                     Start interactive agent
  dxxpcode "<task>"            Run a task directly
  dxxpcode --plan "<task>"     Plan only — no changes
  dxxpcode --review            Show working-tree diff
  dxxpcode --undo              Restore files from the last checkpoint
  dxxpcode --resume            Resume the previous session here
  dxxpcode --version           Print version
  dxxpcode --help              This help

Options:
  --provider <name>            anthropic | openai | mock
  --model <name>               Model override (DXXPCODE_MODEL)
  --effort <level>             Reasoning effort: minimal | low | medium | high | xhigh | max (DXXPCODE_EFFORT)
  --yes, -y                    Auto-approve actions needing confirmation
  --max-iterations <n>         Agent iteration cap (default 40)

Configuration:
  ~/.dxxpcode/config.json      { "provider", "model", "approvalMode", "effort", "maxIterations" }
  .dxxpcode/instructions.md    Per-project instructions (AGENTS.md also honored)

Environment:
  ANTHROPIC_API_KEY            Enables the Anthropic provider
  OPENAI_API_KEY               Enables the OpenAI provider
  OPENAI_BASE_URL              OpenAI-compatible endpoint (OpenRouter, local)
  DXXPCODE_PROVIDER            Force a provider
  DXXPCODE_MODEL               Force a model
  DXXPCODE_EFFORT              Reasoning effort: minimal | low | medium | high | xhigh | max
  DXXPCODE_MOCK_SCRIPT         Path to a JSON array of mock turns (offline dev/e2e)

Mentions:
  @path/to/file.ts           Attach a file's contents as task context
`;

interface Args {
  task?: string;
  plan: boolean;
  review: boolean;
  undo: boolean;
  resume: boolean;
  version: boolean;
  help: boolean;
  yes: boolean;
  provider?: string;
  model?: string;
  effort?: import("@dxxpcode/sessions").DxxpConfig["effort"];
  maxIterations?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { plan: false, review: false, undo: false, resume: false, version: false, help: false, yes: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--plan": args.plan = true; break;
      case "--review": args.review = true; break;
      case "--undo": args.undo = true; break;
      case "--resume": args.resume = true; break;
      case "--version": case "-v": args.version = true; break;
      case "--help": case "-h": args.help = true; break;
      case "--yes": case "-y": args.yes = true; break;
      case "--provider": args.provider = argv[++i]; break;
      case "--model": args.model = argv[++i]; break;
      case "--effort": {
        const e = argv[++i];
        if (e === "minimal" || e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max") args.effort = e;
        else { errLine("--effort must be minimal, low, medium, high, xhigh, or max"); process.exit(2); }
        break;
      }
      case "--max-iterations": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) args.maxIterations = Math.floor(n);
        break;
      }
      default:
        if (a.startsWith("--provider=")) args.provider = a.slice(11);
        else if (a.startsWith("--model=")) args.model = a.slice(8);
        else if (a.startsWith("--effort=")) {
          const e = a.slice(9);
          if (e === "minimal" || e === "low" || e === "medium" || e === "high" || e === "xhigh" || e === "max") args.effort = e;
          else { errLine("--effort must be minimal, low, medium, high, xhigh, or max"); process.exit(2); }
        }
        else if (a.startsWith("--")) { errLine(`unknown option: ${a}`); process.exit(2); }
        else positional.push(a);
    }
  }
  if (positional.length) args.task = positional.join(" ");
  return args;
}

function review(root: string): number {
  const out = git(root, ["status", "--short", "--branch"]);
  const diff = git(root, ["diff"]) + git(root, ["diff", "--cached"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).trim();
  line(out.trim() || dim("(clean)"));
  if (untracked) {
    line(dim("untracked:"));
    for (const f of untracked.split("\n")) line(`  ${f}`);
  }
  if (diff.trim()) line(renderDiff(diff));
  else if (!untracked) line(dim("No changes."));
  return 0;
}

function undo(root: string): number {
  const sess = latestSessionFor(root);
  const out = sess ? undoCheckpoint(root, sess.id, process.env) : null;
  if (!out) {
    line(dim("Nothing to undo."));
    return 0;
  }
  line(green(`restored checkpoint ${out.seq}`));
  for (const f of out.restored) line(`  ${green("+")} ${f}`);
  for (const f of out.removed) line(`  ${red("−")} ${f}`);
  if (out.headMoved) {
    line(dim(`  note: HEAD moved (${out.headMoved.from.slice(0, 7)} → ${out.headMoved.to.slice(0, 7)}) since this checkpoint`));
  }
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
    process.stdin.resume();
  });
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root, encoding: "utf8",
      env: { ...process.env, GIT_PAGER: "cat" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    errLine(red(`git failed: ${(e as Error).message}`));
    return "";
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { line(HELP); return 0; }
  if (args.version) { line(`dxxpcode ${VERSION}`); return 0; }

  const root = process.cwd();
  const project = detectProject(root);

  if (args.review) return review(root);
  if (args.undo) return undo(root);

  const interactive = process.stdin.isTTY === true;

  const config = loadConfig();
  // Saved provider config feeds resolution; env vars still win.
  const providerEnv = { ...process.env };
  if (!providerEnv.OPENAI_BASE_URL && config.openaiBaseUrl) {
    providerEnv.OPENAI_BASE_URL = config.openaiBaseUrl;
  }
  const keys = { anthropic: config.anthropicApiKey, openai: config.openaiApiKey };

  let provider;
  try {
    provider = resolveProvider({
      provider: args.provider ?? config.provider,
      model: args.model ?? config.model,
      env: providerEnv,
      keys,
    });
  } catch (e) {
    if (e instanceof ProviderConfigError) {
      // First-run connect flow: pick a provider + paste a key in the TUI.
      if (interactive) {
        const { runProviderSetup } = await import("./ui/setup.tsx");
        const setup = await runProviderSetup();
        if (!setup) {
          errLine(red(e.message));
          return 1;
        }
        const cfg = { ...loadConfig(), provider: setup.provider };
        if (setup.provider === "anthropic") {
          cfg.anthropicApiKey = setup.apiKey;
          providerEnv.ANTHROPIC_API_KEY = setup.apiKey;
        } else {
          cfg.openaiApiKey = setup.apiKey;
          providerEnv.OPENAI_API_KEY = setup.apiKey;
          if (setup.baseUrl) {
            cfg.openaiBaseUrl = setup.baseUrl;
            providerEnv.OPENAI_BASE_URL = setup.baseUrl;
          }
        }
        saveConfig(cfg);
        config.provider = setup.provider;
        provider = resolveProvider({
          provider: args.provider ?? config.provider,
          model: args.model ?? config.model,
          env: providerEnv,
          keys,
        });
      } else {
        errLine(red(e.message));
        return 1;
      }
    } else {
      throw e;
    }
  }

  const envEffort = process.env.DXXPCODE_EFFORT;
  const effort = args.effort
    ?? (["minimal","low","medium","high","xhigh","max"].includes(envEffort ?? "") ? envEffort as Args["effort"] : config.effort);
  const autoApprove = args.yes || config.approvalMode === "auto";
  const smartApproveMode = !args.yes && config.approvalMode === "smart";
  // Mode shown in the status bar: plan | always-approve | smart | ask.
  const mode = args.plan ? "plan" : autoApprove ? "always-approve" : smartApproveMode ? "smart" : "ask";
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  let session: SessionRecord | undefined;
  if (args.resume) {
    session = latestSessionFor(root) ?? undefined;
  }

  // "Always allow" approvals persist across tasks for the whole process.
  const allowlist = new Set<string>();

  // One-shot install ping — generates a random ID once, POSTs to the stats endpoint.
  const { trackInstall } = await import("./track.ts");
  trackInstall(config, process.env);

  if (interactive) {
    // Background update check — resolved inside the TUI as a note.
    const updateCheck = import("./update.ts").then((m) =>
      m.checkForUpdate(VERSION).catch(() => null),
    );
    // Full TUI: boxed input, arrow-key approvals, scrollable transcript.
    const { startInkApp } = await import("./ui/App.tsx");
    return startInkApp({
      version: VERSION,
      provider: provider.provider,
      model: provider.model,
      effort,
      project,
      root,
      session,
      planOnly: args.plan,
      autoApprove,
      smartApprove: smartApproveMode,
      maxIterations: args.maxIterations ?? config.maxIterations,
      task: args.task,
      allowlist,
      historyFile: join(homeDir(), "history"),
      updateCheck,
      onSession: (id) => {
        session = loadSession(id) ?? session;
      },
      getReviewDiff: () => git(root, ["diff"]) + git(root, ["diff", "--cached"]),
    });
  }

  // Non-interactive: plain renderer (piped stdin, CI logs).
  const prompter = createPrompter({ interactive: false });
  const ruleStr = rule();
  const header = `${cyan("◆")} ${bold(project.name)}${project.languages.length ? dim(` (${project.languages.join(", ")})`) : ""}${project.git ? dim(`  ${project.git.branch}${project.git.dirty ? "*" : ""}`) : ""}`;
  line(header);
  line(dim(`${provider.provider.name} · ${provider.model} · ${mode}`));
  if (ruleStr) line(ruleStr);
  if (args.resume) {
    line(dim(session ? `resumed session ${session.id} (${session.messages.length} messages)` : "no previous session for this directory"));
  }

  const runOnce = async (task: string) => {
    for (const l of pill(task)) line(l);
    const mentions = expandMentions(task, root);
    for (const a of mentions.attached) line(dim(`  attached ${a}`));
    for (const s of mentions.skipped) line(dim(`  skipped @${s.path}: ${s.reason}`));
    const runCtl = new AbortController();
    if (controller.signal.aborted) runCtl.abort();
    else controller.signal.addEventListener("abort", () => runCtl.abort(), { once: true });
    const result = await runAndRender({
      task: mentions.text,
      provider: provider.provider,
      model: provider.model,
      effort,
      projectRoot: root,
      planOnly: args.plan,
      autoApprove,
      smartApprove: smartApproveMode ? (process.env.TYPESAFE_API_KEY ?? config.typeSafeApiKey) : undefined,
      maxIterations: args.maxIterations ?? config.maxIterations,
      prompter,
      session,
      signal: runCtl.signal,
      allowlist,
    });
    if (result.sessionId) {
      session = loadSession(result.sessionId) ?? session;
    }
    return result;
  };

  if (args.task) {
    const result = await runOnce(args.task);
    prompter.close();
    return result.status === "completed" || result.status === "plan_only" ? 0 : 1;
  }

  // Piped stdin reads as the task (e.g. `echo "fix tests" | dxxpcode`).
  const input = (await readStdin()).trim();
  if (!input) {
    errLine(red("no task given — pass one as an argument or pipe it on stdin"));
    prompter.close();
    return 2;
  }
  const result = await runOnce(input);
  prompter.close();
  return result.status === "completed" || result.status === "plan_only" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errLine(red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });

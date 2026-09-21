#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { detectProject } from "@dxxpcode/project";
import { ProviderConfigError, resolveProvider } from "@dxxpcode/providers";
import { homeDir, latestSessionFor, loadConfig, loadSession } from "@dxxpcode/sessions";
import type { SessionRecord } from "@dxxpcode/sessions";
import { renderBanner, renderTips } from "./banner.ts";
import { expandMentions } from "./mentions.ts";
import { createPrompter } from "./prompt.ts";
import { runAndRender } from "./run.ts";
import { bold, cyan, dim, errLine, line, red, renderDiff, rule } from "./render.ts";

const VERSION = "0.1.0";

const HELP = `dxxpcode — AI coding agent for your terminal

Usage:
  dxxpcode                     Start interactive agent
  dxxpcode "<task>"            Run a task directly
  dxxpcode --plan "<task>"     Plan only — no changes
  dxxpcode --review            Show working-tree diff
  dxxpcode --resume            Resume the previous session here
  dxxpcode --version           Print version
  dxxpcode --help              This help

Options:
  --provider <name>            anthropic | openai | mock
  --model <name>               Model override (DXXPCODE_MODEL)
  --yes, -y                    Auto-approve actions needing confirmation
  --max-iterations <n>         Agent iteration cap (default 40)

Configuration:
  ~/.dxxpcode/config.json      { "provider", "model", "approvalMode", "maxIterations" }
  .dxxpcode/instructions.md    Per-project instructions (AGENTS.md also honored)

Environment:
  ANTHROPIC_API_KEY            Enables the Anthropic provider
  OPENAI_API_KEY               Enables the OpenAI provider
  OPENAI_BASE_URL              OpenAI-compatible endpoint (OpenRouter, local)
  DXXPCODE_PROVIDER            Force a provider
  DXXPCODE_MODEL               Force a model
  DXXPCODE_MOCK_SCRIPT         Path to a JSON array of mock turns (offline dev/e2e)

Mentions:
  @path/to/file.ts           Attach a file's contents as task context
`;

interface Args {
  task?: string;
  plan: boolean;
  review: boolean;
  resume: boolean;
  version: boolean;
  help: boolean;
  yes: boolean;
  provider?: string;
  model?: string;
  maxIterations?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { plan: false, review: false, resume: false, version: false, help: false, yes: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--plan": args.plan = true; break;
      case "--review": args.review = true; break;
      case "--resume": args.resume = true; break;
      case "--version": case "-v": args.version = true; break;
      case "--help": case "-h": args.help = true; break;
      case "--yes": case "-y": args.yes = true; break;
      case "--provider": args.provider = argv[++i]; break;
      case "--model": args.model = argv[++i]; break;
      case "--max-iterations": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) args.maxIterations = Math.floor(n);
        break;
      }
      default:
        if (a.startsWith("--provider=")) args.provider = a.slice(11);
        else if (a.startsWith("--model=")) args.model = a.slice(8);
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

  const config = loadConfig();
  let provider;
  try {
    provider = resolveProvider({
      provider: args.provider ?? config.provider,
      model: args.model ?? config.model,
    });
  } catch (e) {
    if (e instanceof ProviderConfigError) {
      errLine(red(e.message));
      return 1;
    }
    throw e;
  }

  const interactive = process.stdin.isTTY === true;
  const prompter = createPrompter({
    interactive,
    historyFile: interactive ? join(homeDir(), "history") : undefined,
  });
  const autoApprove = args.yes || config.approvalMode === "auto";
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  const ruleStr = rule();

  let session: SessionRecord | undefined;
  if (args.resume) {
    session = latestSessionFor(root) ?? undefined;
  }

  const startRepl = interactive && !args.task;
  if (startRepl) {
    for (const l of renderBanner({
      version: VERSION,
      provider: provider.provider.name,
      model: provider.model,
      project,
      cwd: root,
      resumedSession: session,
    })) line(l);
    if (ruleStr) line(ruleStr);
    for (const l of renderTips()) line(l);
    if (ruleStr) line(ruleStr);
    if (args.resume && !session) line(dim("no previous session for this directory"));
  } else {
    const header = `${cyan("◆")} ${bold(project.name)}${project.languages.length ? dim(` (${project.languages.join(", ")})`) : ""}${project.git ? dim(`  ${project.git.branch}${project.git.dirty ? "*" : ""}`) : ""}`;
    line(header);
    line(dim(`${provider.provider.name} · ${provider.model}`));
    if (ruleStr) line(ruleStr);
    if (args.resume) {
      line(dim(session ? `resumed session ${session.id} (${session.messages.length} messages)` : "no previous session for this directory"));
    }
  }

  // "Always allow" approvals persist across tasks for the whole process.
  const allowlist = new Set<string>();

  // esc interrupts the active run or resolves a pending prompt; ctrl-c
  // keeps its kill-the-process semantics via the global controller.
  let runCtl: AbortController | null = null;
  if (interactive) {
    process.stdin.on("keypress", (_s, key) => {
      if (key?.name !== "escape" || !runCtl) return;
      prompter.cancelPending();
      runCtl.abort();
    });
  }

  const runOnce = async (task: string) => {
    const mentions = expandMentions(task, root);
    for (const a of mentions.attached) line(dim(`  attached ${a}`));
    for (const s of mentions.skipped) line(dim(`  skipped @${s.path}: ${s.reason}`));
    runCtl = new AbortController();
    if (controller.signal.aborted) runCtl.abort();
    else controller.signal.addEventListener("abort", () => runCtl?.abort(), { once: true });
    let result;
    try {
      result = await runAndRender({
        task: mentions.text,
        provider: provider.provider,
        model: provider.model,
        projectRoot: root,
        planOnly: args.plan,
        autoApprove,
        maxIterations: args.maxIterations ?? config.maxIterations,
        prompter,
        session,
        signal: runCtl.signal,
        allowlist,
      });
    } finally {
      runCtl = null;
    }
    // Continue the same conversation for subsequent REPL inputs.
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
  if (!interactive) {
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

  // Interactive REPL
  while (true) {
    const input = (await prompter.ask(`${cyan("❯")} `)).trim();
    if (prompter.closed || controller.signal.aborted) break;
    if (!input) continue;
    if (input === "exit" || input === "quit") break;
    if (input === "/review") { review(root); continue; }
    try {
      await runOnce(input);
    } catch (e) {
      errLine(red(e instanceof Error ? e.message : String(e)));
    }
    if (ruleStr) line(ruleStr);
  }
  prompter.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errLine(red(e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });

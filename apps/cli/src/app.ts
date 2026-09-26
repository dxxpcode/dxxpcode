/**
 * App mode (`dxxpcode --app`): the shell protocol for the desktop app and
 * other UIs. The process speaks newline-delimited JSON instead of ANSI —
 * events on stdout, commands on stdin.
 *
 * Outbound events (one JSON object per line):
 *   {type:"ready", version, provider, model, mode, project}
 *   {type:"state", provider, model, effort, mode}   config changed → header
 *   {type:"user", text}                            task echo
 *   AgentEvent types verbatim                      status|text|plan|tool_start|
 *                                                  tool_end|todo|checkpoint|
 *                                                  denied|usage|compacted|done
 *   {type:"approval", id, kind, summary, reason, allowAlways}
 *   {type:"menu", id, title, options:[{label,desc}], current}
 *   {type:"prompt", id, title, secret}             single-line input request
 *   {type:"table", title, rows:[[label,value]]}
 *   {type:"markdown", title, text}
 *   {type:"diff_card", title, diff}
 *   {type:"steer", text} | {type:"note", text} | {type:"error", text}
 *   {type:"session", id, tokens}                session assigned/cleared
 *   {type:"idle"} | {type:"exit"}
 *
 * Inbound commands (one JSON object per line):
 *   {type:"submit", text}                        run a task (or steer)
 *   {type:"approve", id, choice:"y"|"n"|"a"}     answer an approval request
 *   {type:"select", id, index}                   pick a menu option (-1 = cancel)
 *   {type:"prompt_submit", id, text}             answer a prompt ("" = cancel)
 *   {type:"command", name:"/review", args?}      run a slash command
 *   {type:"list_files", id, prefix}              @mention completions → {type:"files", id, items}
 *   {type:"cancel"}                              abort the active run
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AgentEvent, ApprovalRequest, RunResult } from "@dxxpcode/agent";
import { compactMessages, estimateTokens, runTask, undoCheckpoint } from "@dxxpcode/agent";
import type { ModelProvider, ReasoningEffort } from "@dxxpcode/providers";
import { KNOWN_MODELS, resolveProvider } from "@dxxpcode/providers";
import { detectGit } from "@dxxpcode/project";
import type { ProjectInfo } from "@dxxpcode/project";
import { homeDir, listSessions, loadConfig, loadSession, saveConfig, saveSession } from "@dxxpcode/sessions";
import type { DxxpConfig, SessionRecord } from "@dxxpcode/sessions";
import type { ProposedPlan } from "@dxxpcode/tools";
import { expandMentions, listProjectFiles } from "./mentions.ts";
import { fileSuggestions, type FileIndex } from "./ui/suggest.ts";
import { jevRouteEffort, smartApprove } from "./jev.ts";
import { CHANGELOG_MD, DOCS_MD } from "./reference.ts";

export interface AppModeDeps {
  version: string;
  provider: ModelProvider;
  providerName: string;
  model: string;
  effort?: ReasoningEffort;
  project: ProjectInfo;
  root: string;
  session?: SessionRecord;
  planOnly: boolean;
  autoApprove: boolean;
  /** "smart" approval mode enabled (Jev); needs a TypeSafe key. */
  smartApproveMode: boolean;
  maxIterations?: number;
  allowlist: Set<string>;
  config: DxxpConfig;
  mode: string;
}

interface InCommand {
  type: string;
  text?: string;
  id?: number;
  choice?: string;
  name?: string;
  index?: number;
}

const emit = (o: unknown) => {
  process.stdout.write(JSON.stringify(o) + "\n");
};

function describe(req: ApprovalRequest): string {
  if (req.tool === "run_command") return String(req.input["command"] ?? req.tool);
  const target = req.input["path"];
  return typeof target === "string" ? `${req.tool} ${target}` : req.tool;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function gitDiff(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_PAGER: "cat" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

const COMMAND_LIST = [
  { name: "/review", desc: "show the working-tree diff" },
  { name: "/model", desc: "pick the model for the next task" },
  { name: "/status", desc: "session, config, and usage info" },
  { name: "/settings", desc: "approval mode, provider, model, effort" },
  { name: "/approval", desc: "approval mode — ask, always, or smart (Jev)" },
  { name: "/effort", desc: "reasoning effort for the next task" },
  { name: "/providers", desc: "switch between configured providers" },
  { name: "/undo", desc: "restore files from the last checkpoint" },
  { name: "/compact", desc: "compress old tool output in the session context" },
  { name: "/docs", desc: "reference — install, commands, flags, config" },
  { name: "/changelog", desc: "release history" },
  { name: "/clear", desc: "clear the transcript" },
  { name: "/new", desc: "start a new session — resets context and approvals" },
  { name: "/resume", desc: "resume a previous session for this project" },
  { name: "/help", desc: "list available commands" },
  { name: "/exit", desc: "quit" },
];

export async function runAppMode(deps: AppModeDeps): Promise<number> {
  // Raw mode on the pty: disables line buffering and echo so commands arrive
  // byte-accurate and aren't echoed back into the JSON stream.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  // Live, mutable session state — menus and commands update these.
  const live = {
    provider: deps.provider,
    model: deps.model,
    effort: deps.effort,
    autoApprove: deps.autoApprove,
    smartApproveMode: deps.smartApproveMode,
    mode: deps.mode,
  };

  const emitState = () =>
    emit({
      type: "state",
      provider: live.provider.name,
      model: live.model,
      effort: deps.config.effortAuto ? "auto (Jev)" : (live.effort ?? "default"),
      mode: live.mode,
    });

  const emitSession = () =>
    emit({
      type: "session",
      id: session?.id ?? null,
      tokens: session ? estimateTokens(session.messages) : 0,
    });

  emit({
    type: "ready",
    version: deps.version,
    provider: live.provider.name,
    model: live.model,
    effort: live.effort,
    mode: live.mode,
    commands: COMMAND_LIST,
    project: {
      name: deps.project.name,
      languages: deps.project.languages,
      git: deps.project.git,
    },
  });

  const pendingApprovals = new Map<number, (choice: string) => void>();
  const pendingSelects = new Map<number, (index: number | null) => void>();
  const pendingPrompts = new Map<number, (text: string | null) => void>();
  let nextId = 1;
  const steerQueue: string[] = [];
  const taskQueue: string[] = [];
  let session = deps.session;
  emitSession();
  let fileIndex: FileIndex | null = null;
  let abortRun: AbortController | null = null;
  let pumping = false;
  let turnTokens = 0;

  const ask = (kind: "plan" | "tool", summary: string, reason?: string) =>
    new Promise<string>((resolve) => {
      const id = nextId++;
      pendingApprovals.set(id, resolve);
      emit({ type: "approval", id, kind, summary, reason, allowAlways: kind === "tool" });
    });

  const menu = (
    title: string,
    options: { label: string; desc?: string }[],
    current?: number,
  ) =>
    new Promise<number | null>((resolve) => {
      const id = nextId++;
      pendingSelects.set(id, resolve);
      emit({ type: "menu", id, title, options, current });
    });

  const prompt = (title: string, secret = false) =>
    new Promise<string | null>((resolve) => {
      const id = nextId++;
      pendingPrompts.set(id, resolve);
      emit({ type: "prompt", id, title, secret });
    });

  const jevKey = () => process.env.TYPESAFE_API_KEY ?? deps.config.typeSafeApiKey;

  /* ------------------------------ slash commands ------------------------------ */

  const openModelMenu = async () => {
    const name = live.provider.name;
    const fallback = [...(KNOWN_MODELS[name] ?? [])];
    if (name === "openai" && loadConfig().openaiBaseUrl) fallback.push("grok-4", "gemini-3-pro");
    const known = live.provider.listModels
      ? await live.provider.listModels().catch(() => fallback)
      : fallback;
    const list = known.length > 0 ? known : fallback;
    const opts = live.model && !list.includes(live.model) ? [live.model, ...list] : list;
    const i = await menu(
      `Model — ${name} · applies to the next task and is saved`,
      [...opts.map((m) => ({ label: m })), { label: "custom…" }],
      Math.max(0, opts.indexOf(live.model)),
    );
    if (i === null) return;
    let m = opts[i];
    if (m === undefined) {
      const custom = await prompt("model name:");
      if (!custom?.trim()) return;
      m = custom.trim();
    }
    live.model = m;
    saveConfig({ ...loadConfig(), model: m });
    emit({ type: "note", text: `model: ${m} · effort ${live.effort ?? "default"} (saved)` });
    emitState();
  };

  const openEffortMenu = async () => {
    const opts = ["default", "minimal", "low", "medium", "high", "xhigh", "max", "auto (Jev)"];
    const descs = [
      "provider default",
      "fastest — quick lookups, simple formatting",
      "modest reasoning — drafting, straightforward tasks",
      "balanced — agentic coding, research, most workloads",
      "hard reasoning — complex debugging, deep planning",
      "larger budget for the hardest multi-step problems",
      "unconstrained budget — high-stakes, hardest tasks",
      "Jev scores each task and picks the tier — needs TYPESAFE_API_KEY",
    ];
    const cfg = loadConfig();
    const cur = cfg.effortAuto ? "auto (Jev)" : (live.effort ?? "default");
    const i = await menu(
      "Reasoning effort — applies to the next task",
      opts.map((o, n) => ({ label: o, desc: descs[n] })),
      Math.max(0, opts.indexOf(cur)),
    );
    if (i === null) return;
    const next = opts[i];
    if (next === "auto (Jev)") {
      deps.config.effortAuto = true;
      saveConfig({ ...loadConfig(), effortAuto: true });
      emit({
        type: "note",
        text: `reasoning effort: auto (Jev) (saved)${jevKey() ? "" : " — set TYPESAFE_API_KEY to enable"}`,
      });
    } else {
      live.effort = next === "default" ? undefined : (next as ReasoningEffort);
      deps.config.effortAuto = false;
      saveConfig({ ...loadConfig(), effort: live.effort, effortAuto: false });
      emit({ type: "note", text: `reasoning effort: ${next} (saved)` });
    }
    emitState();
  };

  const openApprovalMenu = async () => {
    const opts = ["ask", "always-approve", "smart (Jev)"];
    const cur = live.smartApproveMode ? 2 : live.autoApprove ? 1 : 0;
    const i = await menu(
      `Approval mode — applied to the next task and saved${jevKey() ? "" : " · smart needs TYPESAFE_API_KEY"}`,
      opts.map((o) => ({ label: o })),
      cur,
    );
    if (i === null) return;
    live.smartApproveMode = i === 2;
    live.autoApprove = i === 1;
    live.mode = live.smartApproveMode ? "smart" : live.autoApprove ? "always-approve" : "ask";
    saveConfig({ ...loadConfig(), approvalMode: live.smartApproveMode ? "smart" : live.autoApprove ? "auto" : "ask" });
    emit({
      type: "note",
      text: `approval mode: ${opts[i]} (saved)${live.smartApproveMode && !jevKey() ? " — no TYPESAFE_API_KEY yet; falls back to ask" : ""}`,
    });
    emitState();
  };

  const openProviderMenu = async () => {
    const cfg = loadConfig();
    const env = process.env;
    const avail: string[] = [];
    if (env.ANTHROPIC_API_KEY || cfg.anthropicApiKey) avail.push("anthropic");
    if (env.OPENAI_API_KEY || cfg.openaiApiKey) avail.push("openai");
    if (env.DXXPCODE_PROVIDER === "mock" || env.DXXPCODE_MOCK_SCRIPT || live.provider.name === "mock") {
      avail.push("mock");
    }
    const opts = [...new Set([live.provider.name, ...avail])];
    const i = await menu(
      "Provider — switches for the next task and is saved",
      [...opts.map((p) => ({ label: p })), { label: "connect a provider…" }],
      Math.max(0, opts.indexOf(live.provider.name)),
    );
    if (i === null) return;
    if (opts[i] === undefined) {
      const which = await menu("Connect a provider", [
        { label: "Anthropic", desc: "Claude models" },
        { label: "OpenAI-compatible", desc: "OpenAI, OpenRouter, local endpoints" },
      ]);
      if (which === null) return;
      const key = await prompt(
        which === 0 ? "Anthropic API key:" : "OpenAI-compatible API key:",
        true,
      );
      if (!key?.trim()) return;
      let baseUrl: string | undefined;
      if (which === 1) {
        const b = await prompt("Base URL (blank = api.openai.com):");
        if (b?.trim()) baseUrl = b.trim();
      }
      const cfg2 = { ...loadConfig() };
      if (which === 0) cfg2.anthropicApiKey = key.trim();
      else {
        cfg2.openaiApiKey = key.trim();
        if (baseUrl) cfg2.openaiBaseUrl = baseUrl;
      }
      saveConfig(cfg2);
      emit({ type: "note", text: `${which === 0 ? "Anthropic" : "OpenAI-compatible"} key saved — pick it from /providers` });
      return;
    }
    const name = opts[i];
    if (name === live.provider.name) return;
    try {
      const fresh = loadConfig();
      const models = { ...(fresh.models ?? {}) };
      models[live.provider.name] = live.model;
      const sel = resolveProvider({
        provider: name,
        model: models[name],
        env,
        keys: { anthropic: fresh.anthropicApiKey, openai: fresh.openaiApiKey },
      });
      live.provider = sel.provider;
      live.model = sel.model;
      saveConfig({ ...fresh, provider: name, model: sel.model, models });
      emit({ type: "note", text: `provider: ${name} · ${sel.model} (saved)` });
      emitState();
    } catch (e) {
      emit({ type: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const openSettingsMenu = async () => {
    const entries = ["Approval mode", "Provider", "Model", "Reasoning effort"];
    const i = await menu(
      "Settings",
      entries.map((e) => ({ label: e })),
    );
    if (i === null) return;
    if (i === 0) await openApprovalMenu();
    else if (i === 1) await openProviderMenu();
    else if (i === 2) await openModelMenu();
    else if (i === 3) await openEffortMenu();
  };

  const showStatus = () => {
    const git = detectGit(deps.root) ?? deps.project.git;
    const rows: [string, string][] = [
      ["provider", `${live.provider.name} · ${live.model}`],
      ["mode", live.mode],
      ["effort", deps.config.effortAuto ? "auto (Jev)" : (live.effort ?? "default")],
      ["version", `v${deps.version}`],
      ["project", `${deps.project.name} — ${deps.root}`],
      ["git", git ? `${git.branch}${git.dirty ? " (dirty)" : " (clean)"}` : "not a repository"],
      ["session", session?.id ?? "—"],
      [
        "context",
        session ? `~${fmtTokens(estimateTokens(session.messages))} tok / 60k cap` : "—",
      ],
      ["usage", `${fmtTokens(turnTokens)} tok this turn`],
      ["config", join(homeDir(), "config.json")],
    ];
    emit({ type: "table", title: "Status", rows });
  };

  const handleCommand = async (raw: string): Promise<void> => {
    const name = raw.trim().split(/\s/)[0];
    switch (name) {
      case "/review": {
        const diff = gitDiff(deps.root, ["diff"]) + gitDiff(deps.root, ["diff", "--cached"]);
        const untracked = gitDiff(deps.root, ["ls-files", "--others", "--exclude-standard"]).trim();
        if (diff.trim()) {
          emit({ type: "diff_card", title: "working tree", diff });
          if (untracked) emit({ type: "note", text: `untracked: ${untracked.split("\n").length} file(s)` });
        } else {
          emit({ type: "note", text: untracked ? `untracked: ${untracked.split("\n").length} file(s)` : "No changes." });
        }
        return;
      }
      case "/status":
        showStatus();
        return;
      case "/settings":
        await openSettingsMenu();
        return;
      case "/approval":
        await openApprovalMenu();
        return;
      case "/model":
        await openModelMenu();
        return;
      case "/effort":
        await openEffortMenu();
        return;
      case "/provider":
      case "/providers":
        await openProviderMenu();
        return;
      case "/setup":
        await openProviderMenu();
        return;
      case "/undo": {
        const out = session ? undoCheckpoint(deps.root, session.id, process.env) : null;
        emit({
          type: "note",
          text: out
            ? `restored checkpoint ${out.seq}${out.restored.length ? ` — restored ${out.restored.join(", ")}` : ""}${out.removed.length ? ` — removed ${out.removed.join(", ")}` : ""}${out.headMoved ? ` — note: HEAD moved (${out.headMoved.from.slice(0, 7)} → ${out.headMoved.to.slice(0, 7)}) since this checkpoint` : ""}`
            : "nothing to undo",
        });
        return;
      }
      case "/compact": {
        if (!session || session.messages.length === 0) {
          emit({ type: "note", text: "no session context to compact yet" });
          return;
        }
        const r = compactMessages(session.messages, { force: true });
        saveSession(session, process.env);
        emit({
          type: "note",
          text: r.compacted
            ? `compacted context — ${r.blocks} old result(s) summarized (~${fmtTokens(r.before)} → ~${fmtTokens(r.after)} tok)`
            : `context already compact (~${fmtTokens(r.before)} tok)`,
        });
        return;
      }
      case "/docs":
        emit({ type: "markdown", title: "Docs", text: DOCS_MD });
        return;
      case "/changelog":
        emit({ type: "markdown", title: "Changelog", text: CHANGELOG_MD });
        return;
      case "/resume": {
        const past = listSessions(process.env)
          .filter((s) => s.projectRoot === deps.root)
          .slice(0, 12);
        if (past.length === 0) {
          emit({ type: "note", text: "no sessions for this project yet" });
          return;
        }
        const i = await menu(
          "Resume a session",
          past.map((s) => ({
            label: `${s.updatedAt.slice(0, 16).replace("T", " ")} — ${s.task.slice(0, 60) || "(untitled)"}`,
            desc: `${s.id.slice(0, 8)} · ${s.messages.length} msg`,
          })),
        );
        if (i === null) return;
        const picked = loadSession(past[i].id);
        if (!picked) {
          emit({ type: "error", text: `session ${past[i].id} is unreadable` });
          return;
        }
        session = picked;
        deps.allowlist.clear();
        emitSession();
        emit({
          type: "note",
          text: `resumed session ${picked.id.slice(0, 8)} — ${picked.messages.length} message(s) restored`,
        });
        return;
      }
      case "/new":
        session = undefined;
        deps.allowlist.clear();
        emit({ type: "session", id: null, tokens: 0 });
        emit({ type: "note", text: "new session — context and session approvals reset" });
        return;
      case "/help":
        emit({
          type: "markdown",
          title: "Commands",
          text: COMMAND_LIST.map((c) => `**\`${c.name}\`** — ${c.desc}`).join("\n"),
        });
        return;
      case "/exit":
      case "exit":
      case "quit":
        emit({ type: "exit" });
        process.exit(0);
        return;
      default:
        emit({ type: "note", text: `unknown command ${name} — /help lists commands` });
    }
  };

  /* -------------------------------- task runs -------------------------------- */

  const runOnce = async (task: string): Promise<void> => {
    emit({ type: "user", text: task });
    const ctl = new AbortController();
    abortRun = ctl;
    turnTokens = 0;

    const approvePlan = async (plan: ProposedPlan): Promise<boolean> => {
      if (live.autoApprove) {
        emit({ type: "note", text: "auto-approved plan" });
        return true;
      }
      const body = [plan.summary, ...plan.steps.map((s, i) => `${i + 1}. ${s}`)]
        .filter(Boolean)
        .join("\n");
      const choice = await ask("plan", body);
      return choice === "y" || choice === "a";
    };

    const approveTool = async (req: ApprovalRequest): Promise<boolean> => {
      const summary = describe(req);
      const key = `${req.tool}:${summary}`;
      if (deps.allowlist.has(key)) {
        emit({ type: "note", text: `allowed earlier this session: ${summary}` });
        return true;
      }
      if (live.autoApprove) {
        emit({ type: "note", text: `auto-approved: ${summary}` });
        return true;
      }
      if (live.smartApproveMode) {
        const key_ = jevKey();
        if (key_) {
          const v = await smartApprove(req, key_);
          if (v?.approve) {
            emit({ type: "note", text: `smart-approved (jev ${v.confidence.toFixed(2)}): ${summary}` });
            return true;
          }
          if (v) emit({ type: "note", text: `jev escalated (${v.confidence.toFixed(2)})` });
        }
      }
      const choice = await ask("tool", summary, req.reason ?? req.decision.reason);
      if (choice === "a") {
        deps.allowlist.add(key);
        return true;
      }
      return choice === "y";
    };

    try {
      const mentions = expandMentions(task, deps.root);
      for (const a of mentions.attached) emit({ type: "note", text: `attached ${a}` });
      for (const s of mentions.skipped)
        emit({ type: "note", text: `skipped @${s.path}: ${s.reason}` });
      const key_ = jevKey();
      const effort =
        deps.config.effortAuto && key_
          ? ((await jevRouteEffort(mentions.text, key_))?.effort ?? live.effort)
          : live.effort;
      const events = runTask({
        task: mentions.text,
        provider: live.provider,
        model: live.model,
        effort,
        projectRoot: deps.root,
        planOnly: deps.planOnly,
        maxIterations: deps.maxIterations,
        approvePlan,
        approveTool,
        session,
        signal: ctl.signal,
        steer: () => steerQueue.shift(),
      });
      let result: RunResult | undefined;
      for await (const ev of events) {
        if (ev.type === "approval_request") continue; // we emit richer approvals
        if (ev.type === "usage") turnTokens = ev.usage.inputTokens + ev.usage.outputTokens;
        emit(ev satisfies AgentEvent);
        if (ev.type === "done") result = ev.result;
      }
      if (result?.sessionId) {
        session = loadSession(result.sessionId) ?? session;
        emitSession();
      }
    } catch (err) {
      emit({
        type: "done",
        result: {
          status: "error",
          summary: "Failed",
          error: err instanceof Error ? err.message : String(err),
          filesChanged: [],
          commands: [],
          toolCalls: 0,
          sessionId: session?.id ?? "",
        } satisfies RunResult,
      });
    } finally {
      abortRun = null;
    }
    emit({ type: "idle" });
    // Text queued while the run wound down becomes the next task.
    const next = steerQueue.shift();
    if (next) await runOnce(next);
  };

  const pump = () => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (taskQueue.length) await runOnce(taskQueue.shift()!);
      } finally {
        pumping = false;
      }
    })();
  };

  /* --------------------------------- stdin ---------------------------------- */

  return new Promise<number>((resolve) => {
    let buf = "";
    process.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let cmd: InCommand;
        try {
          cmd = JSON.parse(line) as InCommand;
        } catch {
          continue;
        }
        if (cmd.type === "submit" && typeof cmd.text === "string" && cmd.text.trim()) {
          const text = cmd.text.trim();
          if (text.startsWith("/")) {
            void handleCommand(text);
          } else if (abortRun) {
            steerQueue.push(text);
            emit({ type: "steer", text });
          } else {
            taskQueue.push(text);
          }
          pump();
        } else if (cmd.type === "command" && typeof cmd.name === "string") {
          void handleCommand(cmd.name);
        } else if (cmd.type === "approve" && typeof cmd.id === "number") {
          const r = pendingApprovals.get(cmd.id);
          if (r) {
            pendingApprovals.delete(cmd.id);
            r(cmd.choice === "a" ? "a" : cmd.choice === "y" ? "y" : "n");
          }
        } else if (cmd.type === "select" && typeof cmd.id === "number") {
          const r = pendingSelects.get(cmd.id);
          if (r) {
            pendingSelects.delete(cmd.id);
            r(typeof cmd.index === "number" && cmd.index >= 0 ? cmd.index : null);
          }
        } else if (cmd.type === "prompt_submit" && typeof cmd.id === "number") {
          const r = pendingPrompts.get(cmd.id);
          if (r) {
            pendingPrompts.delete(cmd.id);
            r(typeof cmd.text === "string" && cmd.text.length ? cmd.text : null);
          }
        } else if (cmd.type === "list_files" && typeof cmd.id === "number") {
          // @mention autocomplete — index builds lazily on first request.
          fileIndex ??= listProjectFiles(deps.root);
          emit({
            type: "files",
            id: cmd.id,
            items: fileSuggestions(fileIndex, typeof cmd.text === "string" ? cmd.text : ""),
          });
        } else if (cmd.type === "cancel") {
          abortRun?.abort();
        }
      }
    });
    process.stdin.on("end", () => resolve(0));
    process.stdin.on("error", () => resolve(0));
  });
}

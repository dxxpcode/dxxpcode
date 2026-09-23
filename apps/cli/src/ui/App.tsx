import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalRequest, RunResult } from "@dxxpcode/agent";
import { runTask } from "@dxxpcode/agent";
import type { ModelProvider, ReasoningEffort, TodoItem } from "@dxxpcode/providers";
import { KNOWN_MODELS, resolveProvider } from "@dxxpcode/providers";
import { detectGit, type ProjectInfo } from "@dxxpcode/project";
import { homeDir, loadConfig, loadSession, saveConfig, type SessionRecord } from "@dxxpcode/sessions";
import { ProviderSetup, type SetupResult } from "./setup.tsx";
import { diffTarget, TOOL_DISPLAY, TOOL_ICONS, TOOL_VERBS, toolArg } from "../render.ts";
import { expandMentions } from "../mentions.ts";
import { loadHistory, saveHistory } from "./history.ts";
import { mdLine } from "./md.tsx";
import { XX_MARK } from "../banner.ts";
import { parseDiff, type DiffRow } from "./diff.ts";
import { join } from "node:path";

type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "pill"; text: string }
  | { id: number; kind: "note"; text: string }
  | { id: number; kind: "thought"; secs: number }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "tool"; name: string; arg: string }
  | { id: number; kind: "result"; text: string; isError: boolean }
  | { id: number; kind: "tree"; lines: string[] }
  | { id: number; kind: "plan"; summary?: string; steps: string[] }
  | { id: number; kind: "todo"; items: TodoItem[] }
  | { id: number; kind: "diff"; path: string; rows: DiffRow[] }
  | { id: number; kind: "denied"; reason: string }
  | { id: number; kind: "status"; rows: [string, string][] }
  | { id: number; kind: "footer"; result: RunResult; secs: number }
  | { id: number; kind: "error"; text: string };

type ItemInput = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

type Pending =
  | { kind: "input" }
  | { kind: "plan"; resolve: (ok: boolean) => void }
  | { kind: "tool"; req: ApprovalRequest; key: string; resolve: (v: "y" | "a" | "n") => void }
  | { kind: "config"; title: string; options: string[]; descs?: string[]; resolve: (i: number | null) => void }
  | { kind: "prompt"; title: string; resolve: (v: string | null) => void };

export interface AppProps {
  version: string;
  provider: ModelProvider;
  model: string;
  effort?: ReasoningEffort;
  project: ProjectInfo;
  root: string;
  session?: SessionRecord;
  planOnly: boolean;
  autoApprove: boolean;
  maxIterations?: number;
  /** First task for one-shot runs; App exits after it finishes. */
  task?: string;
  /** Session-scoped "always allow" keys shared across tasks. */
  allowlist: Set<string>;
  /** Persistent input history (REPL only). */
  historyFile?: string;
  /** Working-tree diff for /review. */
  getReviewDiff?: () => string;
  onExit: (code: number) => void;
  /** Called with the session id after each run so `--resume` chains. */
  onSession: (id: string) => void;
  /** Resolves to a newer published version, if one exists. */
  updateCheck?: Promise<string | null>;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SURFACE = "#1a1b26";
const SURFACE_HI = "#262838";

type Seg = { t: string; c?: string; bg?: string; bold?: boolean; dim?: boolean };
const segWidth = (l: Seg[]) => l.reduce((n, s) => n + s.t.length, 0);

function SurfaceLine({ segs, w, bg }: { segs: Seg[]; w: number; bg?: string }) {
  return (
    <Text backgroundColor={bg ?? SURFACE}>
      {" "}
      {segs.map((s, i) => (
        <Text key={i} color={s.c} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim}>
          {s.t}
        </Text>
      ))}
      {" ".repeat(Math.max(0, w - segWidth(segs)) + 1)}
    </Text>
  );
}

/** Tinted surface card — subtle bg fill instead of a border. */
function Card({
  lines,
  accent,
  fills,
}: {
  lines: Seg[][];
  accent?: string;
  fills?: (string | undefined)[];
}) {
  const w = Math.max(0, ...lines.map(segWidth));
  return (
    <Box flexDirection="row">
      {accent ? (
        <Text backgroundColor={accent}>{Array(lines.length).fill("  ").join("\n")}</Text>
      ) : null}
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <SurfaceLine key={i} segs={l} w={w} bg={fills?.[i]} />
        ))}
      </Box>
    </Box>
  );
}

const COMMANDS = [
  { name: "/review", desc: "show the working-tree diff" },
  { name: "/model", desc: "current provider and model" },
  { name: "/status", desc: "session, config, and usage info" },
  { name: "/config", desc: "change settings (approval mode)" },
  { name: "/effort", desc: "reasoning effort for the next task" },
  { name: "/provider", desc: "connect or switch the model provider" },
  { name: "/clear", desc: "clear the transcript" },
  { name: "/help", desc: "list available commands" },
  { name: "/exit", desc: "quit dxxpcode" },
];

function describe(req: ApprovalRequest): string {
  if (req.tool === "run_command") return String(req.input["command"] ?? req.tool);
  const target = req.input["path"];
  return typeof target === "string" ? `${req.tool} ${target}` : req.tool;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const idRef = useRef(0);
  const [items, setItems] = useState<Item[]>(() =>
    props.task ? [] : [{ kind: "banner", id: idRef.current++ }],
  );
  const liveRef = useRef(""); // accumulated model text for the open burst
  const [liveText, setLiveText] = useState("");
  const [spinLabel, setSpinLabel] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [pending, setPending] = useState<Pending>({ kind: "input" });
  const [menuSel, setMenuSel] = useState(0);
  const [input, setInput] = useState("");
  const [cmdSel, setCmdSel] = useState(0);
  const [hist, setHist] = useState<string[]>(() => loadHistory(props.historyFile));
  const histRef = useRef(hist);
  histRef.current = hist;
  const [histIdx, setHistIdx] = useState(-1);
  const [exited, setExited] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [tok, setTok] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const runStartRef = useRef(0);

  const thinkAt = useRef(0);
  const running = useRef(false);
  const runCtl = useRef<AbortController | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const sessionRef = useRef(props.session);
  const [prov, setProv] = useState({ provider: props.provider, model: props.model });
  const provRef = useRef(prov);
  // /config writes these; they take effect on the next run.
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  const autoRef = useRef(props.autoApprove);
  const effortRef = useRef(props.effort);
  const [promptVal, setPromptVal] = useState("");
  const [setup, setSetup] = useState(false);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const suggestions = input.startsWith("/")
    ? COMMANDS.filter((c) => c.name.startsWith(input))
    : [];
  const sugSel = Math.min(cmdSel, Math.max(0, suggestions.length - 1));
  const sugRef = useRef<{ sel: number; names: string[] }>({ sel: 0, names: [] });
  sugRef.current = { sel: sugSel, names: suggestions.map((c) => c.name) };

  const push = useCallback((item: ItemInput) => {
    setItems((prev) => [...prev, { ...item, id: idRef.current++ } as Item]);
  }, []);

  // Spinner frames while thinking.
  useEffect(() => {
    if (spinLabel === null) return;
    const t = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(t);
  }, [spinLabel]);

  // One-time update notice once the background check resolves.
  useEffect(() => {
    let cancelled = false;
    props.updateCheck?.then((latest) => {
      if (latest && !cancelled) {
        push({
          kind: "note",
          text: `⎿ update available: v${props.version} → v${latest} — npm i -g dxxpcode to upgrade`,
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live turn meter while a run is in flight.
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(
      () => setElapsed((Date.now() - runStartRef.current) / 1000),
      100,
    );
    return () => clearInterval(t);
  }, [isRunning]);

  const finish = useCallback(
    (code: number) => {
      saveHistory(props.historyFile, histRef.current);
      setExited(true);
      exit();
      props.onExit(code);
    },
    [exit, props],
  );

  const runOnce = useCallback(
    async (task: string): Promise<RunResult | undefined> => {
      push({ kind: "pill", text: task });
      const mentions = expandMentions(task, props.root);
      for (const a of mentions.attached) push({ kind: "note", text: `attached ${a}` });
      for (const s of mentions.skipped) push({ kind: "note", text: `skipped @${s.path}: ${s.reason}` });

      const ctl = new AbortController();
      runCtl.current = ctl;
      running.current = true;
      setIsRunning(true);
      setTok(0);
      setElapsed(0);
      runStartRef.current = Date.now();
      thinkAt.current = Date.now();
      setSpinLabel("Thinking…");

      const flushThought = () => {
        if (!thinkAt.current) return;
        const secs = (Date.now() - thinkAt.current) / 1000;
        thinkAt.current = 0;
        if (secs >= 1) push({ kind: "thought", secs });
      };
      const flushText = () => {
        const t = liveRef.current;
        if (!t) return;
        liveRef.current = "";
        setLiveText("");
        if (t.trim()) push({ kind: "text", text: t });
      };
      const stopSpin = () => {
        setSpinLabel(null);
        flushThought();
        flushText();
      };

      const approvePlan = async (): Promise<boolean> => {
        stopSpin();
        if (autoRef.current) return true;
        return new Promise((resolve) => {
          setMenuSel(0);
          setPending({ kind: "plan", resolve });
        });
      };
      const approveTool = async (req: ApprovalRequest): Promise<boolean> => {
        const key = `${req.tool}:${describe(req)}`;
        stopSpin();
        if (props.allowlist.has(key)) {
          push({ kind: "note", text: "⎿ allowed earlier this session" });
          return true;
        }
        if (autoRef.current) {
          push({ kind: "note", text: `auto-approved: ${describe(req)}` });
          return true;
        }
        return new Promise((resolve) => {
          setMenuSel(0);
          setPending({
            kind: "tool", req, key,
            resolve: (v) => {
              if (v === "a") props.allowlist.add(key);
              resolve(v !== "n");
            },
          });
        });
      };

      const t0 = Date.now();
      let result: RunResult | undefined;
      try {
        for await (const ev of runTask({
          task: mentions.text,
          provider: provRef.current.provider,
          model: provRef.current.model,
          effort: effortRef.current,
          projectRoot: props.root,
          planOnly: props.planOnly,
          maxIterations: props.maxIterations,
          approvePlan,
          approveTool,
          session: sessionRef.current,
          signal: ctl.signal,
        })) {
          switch (ev.type) {
            case "status":
              flushText();
              thinkAt.current = thinkAt.current || Date.now();
              setSpinLabel(/[.…]$/.test(ev.message) ? ev.message : `${ev.message}…`);
              break;
            case "text":
              setSpinLabel(null);
              flushThought();
              liveRef.current += ev.text;
              setLiveText(liveRef.current);
              break;
            case "plan":
              stopSpin();
              push({ kind: "plan", summary: ev.plan.summary, steps: ev.plan.steps });
              break;
            case "tool_start": {
              stopSpin();
              const arg = toolArg(ev.input);
              push({ kind: "tool", name: ev.tool, arg });
              thinkAt.current = Date.now();
              setSpinLabel(`${TOOL_VERBS[ev.tool] ?? "Working"}${arg ? ` ${arg}` : ""}…`);
              break;
            }
            case "tool_end": {
              stopSpin();
              const lines = ev.result.content.split("\n").filter((l) => l.length > 0);
              if (ev.tool === "list_directory" && ev.result.isError !== true) {
                push({ kind: "tree", lines });
              } else {
                const summary =
                  (lines[0] ?? "").slice(0, 120) +
                  (lines.length > 1 ? `  +${lines.length - 1} more lines` : "");
                push({ kind: "result", text: summary, isError: ev.result.isError === true });
              }
              if (ev.result.diff) {
                push({
                  kind: "diff",
                  path: diffTarget(ev.result.diff) ?? "diff",
                  rows: parseDiff(ev.result.diff),
                });
              }
              thinkAt.current = Date.now();
              setSpinLabel("Thinking…");
              break;
            }
            case "todo":
              stopSpin();
              push({ kind: "todo", items: ev.items });
              break;
            case "denied":
              stopSpin();
              push({ kind: "denied", reason: ev.reason });
              thinkAt.current = Date.now();
              setSpinLabel("Thinking…");
              break;
            case "approval_request":
              break;
            case "compacted":
              push({
                kind: "note",
                text: `⎿ compacted context — ${ev.blocks} old result(s) summarized (~${Math.round(ev.before / 1000)}k → ~${Math.round(ev.after / 1000)}k tok)`,
              });
              break;
            case "usage":
              setTok(ev.usage.inputTokens + ev.usage.outputTokens);
              break;
            case "done":
              result = ev.result;
              break;
          }
        }
      } finally {
        stopSpin();
        running.current = false;
        setIsRunning(false);
        runCtl.current = null;
        setPending({ kind: "input" });
      }
      if (result && result.status !== "plan_only") {
        push({ kind: "footer", result, secs: (Date.now() - t0) / 1000 });
      }
      if (result?.sessionId) {
        sessionRef.current = loadSession(result.sessionId) ?? sessionRef.current;
        props.onSession(result.sessionId);
      }
      return result;
    },
    [props, push],
  );

  const openModelMenu = useCallback(() => {
    const name = provRef.current.provider.name;
    const fallback = [...(KNOWN_MODELS[name] ?? [])];
    // OpenAI-compatible endpoints (xAI Grok, Google Gemini, local) get their models too.
    if (name === "openai" && loadConfig().openaiBaseUrl) {
      fallback.push("grok-4", "gemini-3-pro");
    }
    const cur = provRef.current.model;
    const listModels = provRef.current.provider.listModels?.bind(provRef.current.provider);
    if (listModels) {
      setSpinLabel("Fetching models…");
      listModels()
        .catch(() => fallback)
        .then((known) => {
          setSpinLabel(null);
          showMenu(known.length > 0 ? known : fallback);
        });
    } else {
      showMenu(fallback);
    }
    function showMenu(known: string[]) {
    const opts = cur && !known.includes(cur) ? [cur, ...known] : known;
    const applyModel = (m: string) => {
      setProv({ ...provRef.current, model: m });
      saveConfig({ ...loadConfig(), model: m });
      push({ kind: "note", text: `model: ${m} (saved)` });
    };
    const openCustomPrompt = () => {
      setPending({
        kind: "prompt",
        title: "model name:",
        resolve: (v) => {
          if (v && v.trim()) applyModel(v.trim());
        },
      });
    };
    setMenuSel(Math.max(0, opts.indexOf(cur)));
    setPending({
      kind: "config",
      title: `Model — ${name} · applies to the next task and is saved to config`,
      options: [...opts, "custom…"],
      resolve: (i) => {
        if (i === null) return;
        if (opts[i] === undefined) openCustomPrompt();
        else applyModel(opts[i]);
      },
    });
    }
  }, [push]);

  const openEffortMenu = useCallback(() => {
    const opts = ["default", "minimal", "low", "medium", "high", "xhigh", "max"];
    const cur = effortRef.current ?? "default";
    setMenuSel(opts.indexOf(cur));
    setPending({
      kind: "config",
      title: "Reasoning effort — applies to the next task (ignored on models without support)",
      options: opts,
      descs: [
        "provider default",
        "fastest — quick lookups, simple formatting",
        "modest reasoning — drafting, straightforward tasks",
        "balanced — agentic coding, research, most workloads",
        "hard reasoning — complex debugging, deep planning",
        "larger budget for the hardest multi-step problems",
        "unconstrained budget — high-stakes, hardest tasks",
      ],
      resolve: (i) => {
        if (i === null) return;
        const next = opts[i];
        effortRef.current = next === "default" ? undefined : (next as ReasoningEffort);
        saveConfig({ ...loadConfig(), effort: effortRef.current });
        push({ kind: "note", text: `reasoning effort: ${next} (saved)` });
      },
    });
  }, [push]);

  const openConfigMenu = useCallback(() => {
    const openApprovalMenu = () => {
      const opts = ["ask", "always-approve"];
      setMenuSel(autoRef.current ? 1 : 0);
      setPending({
        kind: "config",
        title: "Approval mode — applied to the next task and saved to config",
        options: opts,
        resolve: (i) => {
          if (i === null) return;
          const next = opts[i] === "always-approve";
          autoRef.current = next;
          setModeOverride(next ? "always-approve" : "ask");
          saveConfig({ ...loadConfig(), approvalMode: next ? "auto" : "ask" });
          push({ kind: "note", text: `approval mode: ${opts[i]} (saved)` });
        },
      });
    };
    const entries = ["Approval mode", "Model", "Reasoning effort"];
    setMenuSel(0);
    setPending({
      kind: "config",
      title: "Settings",
      options: entries,
      resolve: (i) => {
        if (i === 0) openApprovalMenu();
        else if (i === 1) openModelMenu();
        else if (i === 2) openEffortMenu();
      },
    });
  }, [push, openModelMenu, openEffortMenu]);

  const submit = useCallback(
    (raw: string) => {
      let task = raw.trim();
      if (!task || running.current) return;
      setInput("");
      setHistIdx(-1);
      setHist((h) => (h[0] === task ? h : [task, ...h].slice(0, 500)));
      if (task.startsWith("/")) {
        const { sel, names } = sugRef.current;
        if (task === names[0] || COMMANDS.some((c) => c.name === task)) {
          // exact command — handled below
        } else if (names.length > 0) {
          task = names[sel];
        } else {
          push({ kind: "note", text: `unknown command ${task} — /help lists commands` });
          return;
        }
      }
      if (task === "/exit" || task === "exit" || task === "quit") {
        finish(0);
        return;
      }
      if (task === "/model") {
        openModelMenu();
        return;
      }
      if (task === "/status") {
        const p = props.project;
        const cur = provRef.current;
        const git = detectGit(props.root) ?? p.git;
        const effMode = modeOverride ?? (props.planOnly ? "plan" : autoRef.current ? "always-approve" : "ask");
        push({
          kind: "status",
          rows: [
            ["provider", `${cur.provider.name} · ${cur.model}`],
            ["mode", effMode],
            ["effort", effortRef.current ?? "default"],
            ["version", `v${props.version}`],
            ["project", `${p.name} — ${p.root}`],
            ["git", git ? `${git.branch}${git.dirty ? " (dirty)" : " (clean)"}` : "not a repository"],
            ["session", sessionRef.current?.id ?? "—"],
            ["usage", `${fmtTokens(tok)} tok this turn`],
            ["config", join(homeDir(), "config.json")],
          ],
        });
        return;
      }
      if (task === "/config") {
        openConfigMenu();
        return;
      }
      if (task === "/effort") {
        openEffortMenu();
        return;
      }
      if (task === "/provider") {
        setSetup(true);
        return;
      }
      if (task === "/clear") {
        setItems([]);
        return;
      }
      if (task === "/help") {
        push({
          kind: "text",
          text: COMMANDS.map((c) => `${c.name} — ${c.desc}`).join("\n"),
        });
        return;
      }
      if (task === "/review") {
        const diff = props.getReviewDiff?.() ?? "";
        if (diff.trim()) {
          push({ kind: "diff", path: "working tree", rows: parseDiff(diff) });
        } else {
          push({ kind: "note", text: "No changes." });
        }
        return;
      }
      void runOnce(task);
    },
    [finish, push, runOnce, props, openModelMenu, openConfigMenu, openEffortMenu],
  );

  // One-shot task: run once on mount, exit with the result code.
  const ranOnce = useRef(false);
  useEffect(() => {
    if (props.task && !ranOnce.current) {
      ranOnce.current = true;
      void runOnce(props.task).then((r) => {
        finish(r && (r.status === "completed" || r.status === "plan_only") ? 0 : 1);
      });
    }
  }, [props.task, runOnce, finish]);

  useInput((ch, key) => {
    if (setupRef.current) return; // ProviderSetup owns input while open
    if (key.ctrl && ch === "c") {
      if (runCtl.current) runCtl.current.abort();
      finish(130);
      return;
    }
    if (key.escape) {
      if (pendingRef.current.kind !== "input") {
        const p = pendingRef.current;
        setPending({ kind: "input" });
        if (p.kind === "plan") p.resolve(false);
        else if (p.kind === "tool") p.resolve("n");
        else if (p.kind === "config") p.resolve(null);
        else if (p.kind === "prompt") p.resolve(null);
      }
      if (runCtl.current) runCtl.current.abort();
      return;
    }
    const p = pendingRef.current;
    if (p.kind === "prompt") return; // inline TextInput owns input
    if (p.kind === "plan" || p.kind === "tool" || p.kind === "config") {
      const opts = p.kind === "config" ? p.options.length : p.kind === "plan" ? 2 : 3;
      if (key.upArrow || ch === "k") setMenuSel((s) => (s - 1 + opts) % opts);
      else if (key.downArrow || ch === "j") setMenuSel((s) => (s + 1) % opts);
      else if (p.kind !== "config" && ch === "y") choose(p, 0);
      else if (p.kind === "tool" && ch === "a") choose(p, 1);
      else if (p.kind !== "config" && ch === "n") choose(p, opts - 1);
      else if (key.return) choose(p, menuSel);
      return;
    }
    if (p.kind === "input") {
      const sug = sugRef.current.names;
      if (sug.length > 0) {
        if (key.upArrow) setCmdSel((s) => (s - 1 + sug.length) % sug.length);
        else if (key.downArrow) setCmdSel((s) => (s + 1) % sug.length);
        return;
      }
      if (key.upArrow && hist.length) {
        const i = Math.min(histIdx + 1, hist.length - 1);
        setHistIdx(i);
        setInput(hist[i]);
      } else if (key.downArrow) {
        const i = histIdx - 1;
        setHistIdx(i);
        setInput(i < 0 ? "" : hist[i]);
      }
    }
  });

  const onSetupDone = useCallback(
    (r: SetupResult | null) => {
      setSetup(false);
      if (!r) {
        push({ kind: "note", text: "provider setup cancelled" });
        return;
      }
      const env = { ...process.env };
      const cfg = { ...loadConfig(), provider: r.provider };
      if (r.provider === "anthropic") {
        cfg.anthropicApiKey = r.apiKey;
        env.ANTHROPIC_API_KEY = r.apiKey;
      } else {
        cfg.openaiApiKey = r.apiKey;
        env.OPENAI_API_KEY = r.apiKey;
        if (r.baseUrl) {
          cfg.openaiBaseUrl = r.baseUrl;
          env.OPENAI_BASE_URL = r.baseUrl;
        }
      }
      try {
        saveConfig(cfg);
        const sel = resolveProvider({ provider: r.provider, model: cfg.model, env });
        provRef.current = sel;
        setProv(sel);
        push({ kind: "note", text: `connected ${r.provider} · ${sel.model}` });
      } catch (e) {
        push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    },
    [push],
  );

  function choose(p: Pending, i: number) {
    setPending({ kind: "input" });
    if (p.kind === "plan") p.resolve(i === 0);
    else if (p.kind === "tool") p.resolve(i === 1 ? "a" : i === 0 ? "y" : "n");
    else if (p.kind === "config") p.resolve(i);
  }

  const mode = modeOverride ?? (props.planOnly ? "plan" : autoRef.current ? "always-approve" : "ask");

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(it) => (
          <Box key={it.id} marginTop={MAJOR_ITEMS.has(it.kind) ? 1 : 0}>
            <ItemView it={it} props={props} />
          </Box>
        )}
      </Static>
      {spinLabel !== null && (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>{" "}
            <Text dimColor>{spinLabel}</Text>
            <Text dimColor>  ·  esc to interrupt</Text>
          </Text>
        </Box>
      )}
      {liveText.length > 0 && (
        <Text>
          <Text color="cyan">⏺ </Text>
          {liveText.split("\n").map((l, i) => (
            <React.Fragment key={i}>
              {i > 0 ? "\n" : ""}
              {mdLine(l)}
            </React.Fragment>
          ))}
        </Text>
      )}
      {pending.kind === "plan" && (
        <Menu
          title="Execute this plan?"
          options={["Yes", "No"]}
          descriptions={["run the plan as approved", "discard and stop the task"]}
          sel={menuSel}
        />
      )}
      {pending.kind === "config" && (
        <Menu
          title={pending.title}
          options={pending.options}
          descriptions={pending.descs}
          sel={menuSel}
        />
      )}
      {pending.kind === "tool" && (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Card
              accent="yellow"
              lines={[
                [
                  { t: "⚠ Approval required — " },
                  { t: describe(pending.req), bold: true },
                ],
                ...(pending.req.reason ?? pending.req.decision.reason
                  ? [[{ t: `Reason: ${pending.req.reason ?? pending.req.decision.reason}`, dim: true }]]
                  : []),
              ]}
            />
          </Box>
          <Menu
            options={["Yes", "Always (this session)", "No"]}
            descriptions={["allow once", "allow this action for the rest of the session", "deny and stop the task"]}
            sel={menuSel}
          />
        </Box>
      )}
      {setup && !exited && (
        <Box marginTop={1}>
          <ProviderSetup onDone={onSetupDone} />
        </Box>
      )}
      {pending.kind === "prompt" && (
        <Box marginTop={1}>
          <Text color="cyan">❯ </Text>
          <Text dimColor>{pending.title} </Text>
          <TextInput
            value={promptVal}
            onChange={setPromptVal}
            onSubmit={(v) => {
              const p = pending;
              setPending({ kind: "input" });
              setPromptVal("");
              if (p.kind === "prompt") p.resolve(v.trim() ? v : null);
            }}
          />
        </Box>
      )}
      {pending.kind === "input" && !exited && !setup && (
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginTop={1}
          justifyContent="space-between"
        >
          <Box>
            <Text color="cyan">❯ </Text>
            <TextInput
              value={input}
              onChange={(v) => {
                setInput(v);
                setCmdSel(0);
              }}
              onSubmit={submit}
            />
          </Box>
          <Text dimColor>
            {isRunning
              ? `turn ${elapsed.toFixed(1)}s${tok ? ` · ↓${fmtTokens(tok)} tok` : ""}${effortRef.current ? ` · ${effortRef.current} effort` : ""}`
              : `${prov.model} · ${mode}${effortRef.current ? ` · ${effortRef.current}` : ""}`}
          </Text>
        </Box>
      )}
      {pending.kind === "input" &&
        !exited &&
        !setup &&
        suggestions.map((c, i) => (
          <Text key={c.name} backgroundColor={i === sugSel ? SURFACE_HI : undefined}>
            {"  "}
            <Text color="cyan">{c.name}</Text>
            <Text dimColor>{"  "}{c.desc}</Text>
            {" ".repeat(
              Math.max(
                0,
                Math.max(...suggestions.map((x) => x.name.length + x.desc.length)) -
                  c.name.length - c.desc.length + 3,
              ),
            )}
          </Text>
        ))}
    </Box>
  );
}

const MAJOR_ITEMS = new Set(["banner", "pill", "plan", "diff", "footer"]);

function Menu({
  title,
  options,
  sel,
  descriptions,
}: {
  title?: string;
  options: string[];
  sel: number;
  descriptions?: string[];
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {title ? <Text dimColor>{title}</Text> : null}
      {options.map((o, i) => (
        <Box key={o} flexDirection="column">
          <Text backgroundColor={i === sel ? SURFACE_HI : undefined}>
            <Text dimColor={i !== sel} bold={i === sel}>
              {i === sel ? " ● " : " ◯ "}
              {o}
            </Text>
            {i === sel
              ? " ".repeat(Math.max(0, Math.max(...options.map((x) => x.length)) - o.length) + 1)
              : ""}
          </Text>
          {descriptions?.[i] ? (
            <Text dimColor>{"      "}{descriptions[i]}</Text>
          ) : null}
        </Box>
      ))}
      <Text dimColor>{"  "}↑/↓ navigate · Enter select · esc cancel</Text>
    </Box>
  );
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^:?-+:?$/;

/** Rendered markdown table: header bold, `│` separators become dim, rows aligned. */
function Table({ rows }: { rows: string[][] }) {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => r[c]?.length ?? 0)),
  );
  const row = (r: string[], bold: boolean, key: number) => (
    <Text key={key}>
      {"  "}
      {r.map((cell, c) => (
        <React.Fragment key={c}>
          {c > 0 ? "  " : ""}
          <Text bold={bold}>{(cell ?? "").padEnd(w[c])}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
  const out: React.ReactNode[] = [];
  let i = 0;
  let headerDone = false;
  while (i < rows.length) {
    const r = rows[i];
    if (r.every((c) => TABLE_SEP.test(c))) {
      out.push(
        <Text key={`sep${i}`} dimColor>
          {"  "}{w.map((x) => "─".repeat(x)).join("  ")}
        </Text>,
      );
      i++;
      continue;
    }
    out.push(row(r, !headerDone, i));
    headerDone = true;
    i++;
  }
  return <Box flexDirection="column">{out}</Box>;
}

/** Streamed text burst: normal lines via mdLine, `|…|` runs become Tables. */
function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    if (TABLE_LINE.test(lines[i])) {
      const rows: string[][] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i])) {
        rows.push(
          lines[i].split("|").slice(1, -1).map((c) => c.trim()),
        );
        i++;
      }
      out.push(<Table key={k++} rows={rows} />);
      continue;
    }
    out.push(
      <Text key={k++}>
        {i === 0 ? <Text color="cyan">⏺ </Text> : "  "}
        {mdLine(lines[i])}
      </Text>,
    );
    i++;
  }
  return <Box flexDirection="column">{out}</Box>;
}

function ItemView({ it, props }: { it: Item; props: AppProps }) {
  switch (it.kind) {
    case "banner":
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={2}>
              {XX_MARK.map((r, i) => (
                <Text key={i} bold>
                  {r}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column">
              <Text bold color="cyan">
                DxxpCode
              </Text>
              <Text dimColor>
                v{props.version} · {props.provider.name} · {props.model}
              </Text>
            </Box>
          </Box>
          <Text>
            <Text bold>{props.project.name}</Text>
            <Text dimColor>
              {props.project.languages.length ? ` (${props.project.languages.join(", ")})` : ""}
              {props.project.git
                ? ` · ${props.project.git.branch}${props.project.git.dirty ? "*" : ""}`
                : ""}
            </Text>
          </Text>
          <Text dimColor>{props.root}</Text>
          {props.session ? (
            <Text dimColor>
              resumed session {props.session.id} ({props.session.messages.length} messages)
            </Text>
          ) : null}
          <Text> </Text>
          <Text bold dimColor>
            Tips for getting started
          </Text>
          {[
            `Describe a task in plain language — "fix the failing test in math.js"`,
            `Attach files as context inline: @src/math.js`,
            `Preview without changes: dxxpcode --plan "<task>"`,
            `Review diffs anytime: /review in-session, or dxxpcode --review`,
            `Pick up where you left off: dxxpcode --resume`,
            `Project instructions live in .dxxpcode/instructions.md`,
          ].map((t, i) => (
            <Text key={i}>
              {"  "}
              <Text color="cyan">{i + 1}</Text>
              {`. ${t}`}
            </Text>
          ))}
          <Text> </Text>
        </Box>
      );
    case "pill":
      return <Card lines={[[{ t: "❯ ", c: "cyan" }, { t: it.text }]]} />;
    case "status":
      return (
        <Card
          lines={it.rows.map(([k, v]) => [
            { t: `${k.padEnd(9)}`, dim: true },
            { t: v },
          ])}
        />
      );
    case "note":
      return <Text dimColor>  {it.text}</Text>;
    case "thought":
      return (
        <Text dimColor>
          {"  "}
          <Text color="magenta">◆</Text> Thought for {it.secs.toFixed(1)}s
        </Text>
      );
    case "text":
      return <TextBlock text={it.text} />;
    case "tree":
      return (
        <Box flexDirection="column">
          <Text dimColor>{"  ⎿  "}Listed {it.lines.length} entries</Text>
          {it.lines.slice(0, 40).map((l, i) => (
            <Text key={i} dimColor>
              {"     "}{i === it.lines.length - 1 || i === 39 ? "└─" : "├─"} {l}
            </Text>
          ))}
          {it.lines.length > 40 ? (
            <Text dimColor>{"     "}… {it.lines.length - 40} more</Text>
          ) : null}
        </Box>
      );
    case "tool": {
      const name = TOOL_DISPLAY[it.name] ?? it.name;
      const icon = TOOL_ICONS[it.name] ?? "⏺";
      return (
        <Text>
          <Text color="cyan">{icon} </Text>
          <Text bold>{name}</Text>
          {it.arg ? <Text dimColor>({it.arg})</Text> : null}
        </Text>
      );
    }
    case "result":
      return (
        <Text>
          {"  "}
          <Text color={it.isError ? "red" : undefined} dimColor={!it.isError}>
            ⎿  {it.text}
          </Text>
        </Text>
      );
    case "plan": {
      const lines: Seg[][] = [
        [{ t: "plan", bold: true }, { t: "  ×", dim: true }],
        ...(it.summary ? [[{ t: it.summary, dim: true }]] : []),
        ...it.steps.map((s, i) => [{ t: `${i + 1}`, c: "cyan" }, { t: `. ${s}` }]),
      ];
      return <Card lines={lines} />;
    }
    case "todo": {
      const done = it.items.filter((t) => t.status === "completed").length;
      const lines: Seg[][] = [
        [{ t: "tasks", bold: true }, { t: `  ${done}/${it.items.length}  ×`, dim: true }],
        ...it.items.map((t) => {
          const mark =
            t.status === "completed"
              ? { t: "✓ ", c: "green" }
              : t.status === "in_progress"
                ? { t: "▶ ", c: "cyan" }
                : { t: "○ ", dim: true };
          const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return [mark, { t: label, dim: t.status !== "in_progress" }];
        }),
      ];
      return <Card lines={lines} />;
    }
    case "diff": {
      const rows = it.rows.filter((r) => r.kind !== "meta");
      const lines: Seg[][] = [
        [{ t: it.path, bold: true }, { t: "  ×", dim: true }],
        ...rows.map((r) => [
          {
            t: `${r.num !== null ? String(r.num).padStart(4) : "    "}  ${
              r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "
            } ${r.text}`,
            c:
              r.kind === "hunk"
                ? "cyan"
                : r.kind === "add"
                  ? "green"
                  : r.kind === "del"
                    ? "red"
                    : undefined,
            dim: r.kind === "ctx",
          },
        ]),
      ];
      const fills = [
        undefined,
        ...rows.map((r) =>
          r.kind === "add" ? "#0c2b16" : r.kind === "del" ? "#3b0f12" : undefined,
        ),
      ];
      return <Card lines={lines} fills={fills} />;
    }
    case "denied":
      return (
        <Text color="red">
          {"  ⎿  Denied: "}
          {it.reason}
        </Text>
      );
    case "footer": {
      const r = it.result;
      const ok = r.status === "completed";
      const tokens =
        r.usage && (r.usage.inputTokens || r.usage.outputTokens)
          ? ` · ${fmtTokens(r.usage.inputTokens + r.usage.outputTokens)} tokens`
          : "";
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={ok ? "green" : "yellow"}>{ok ? "✓" : "⚠"} </Text>
            <Text bold>{ok ? "Completed" : r.status}</Text>
            <Text dimColor>
              {" · "}
              {it.secs.toFixed(1)}s{tokens}
            </Text>
          </Text>
          {r.summary && !ok ? <Text dimColor>{r.summary}</Text> : null}
          {r.filesChanged.length > 0 && (
            <Text dimColor>  Changed: {r.filesChanged.join(", ")}</Text>
          )}
          {r.error ? <Text color="red">{r.error}</Text> : null}
          <Text dimColor>{"─".repeat(24)}</Text>
        </Box>
      );
    }
    case "error":
      return <Text color="red">{it.text}</Text>;
  }
}

export interface InkRunResult {
  code: number;
}

/**
 * Mount the interactive ink UI. Resolves with the exit code when the user
 * quits (exit/quit, ctrl-C, or a completed one-shot task).
 */
export async function startInkApp(props: Omit<AppProps, "onExit">): Promise<number> {
  return new Promise<number>((resolve) => {
    const app = render(
      <App {...props} onExit={resolve} onSession={props.onSession} />,
    );
    app.waitUntilExit().catch(() => resolve(0));
  });
}

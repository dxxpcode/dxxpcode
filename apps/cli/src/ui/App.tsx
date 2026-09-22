import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalRequest, RunResult } from "@dxxpcode/agent";
import { runTask } from "@dxxpcode/agent";
import type { ModelProvider } from "@dxxpcode/providers";
import type { ProjectInfo } from "@dxxpcode/project";
import { loadSession, type SessionRecord } from "@dxxpcode/sessions";
import { diffTarget, TOOL_DISPLAY, toolArg } from "../render.ts";
import { expandMentions } from "../mentions.ts";
import { loadHistory, saveHistory } from "./history.ts";
import { mdLine } from "./md.tsx";
import { parseDiff, type DiffRow } from "./diff.ts";

type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "pill"; text: string }
  | { id: number; kind: "note"; text: string }
  | { id: number; kind: "thought"; secs: number }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "tool"; name: string; arg: string }
  | { id: number; kind: "result"; text: string; isError: boolean }
  | { id: number; kind: "plan"; summary?: string; steps: string[] }
  | { id: number; kind: "diff"; path: string; rows: DiffRow[] }
  | { id: number; kind: "denied"; reason: string }
  | { id: number; kind: "footer"; result: RunResult; secs: number }
  | { id: number; kind: "error"; text: string };

type ItemInput = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

type Pending =
  | { kind: "input" }
  | { kind: "plan"; resolve: (ok: boolean) => void }
  | { kind: "tool"; req: ApprovalRequest; key: string; resolve: (v: "y" | "a" | "n") => void };

export interface AppProps {
  version: string;
  provider: ModelProvider;
  model: string;
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
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  const [hist, setHist] = useState<string[]>(() => loadHistory(props.historyFile));
  const histRef = useRef(hist);
  histRef.current = hist;
  const [histIdx, setHistIdx] = useState(-1);
  const [exited, setExited] = useState(false);

  const thinkAt = useRef(0);
  const running = useRef(false);
  const runCtl = useRef<AbortController | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const sessionRef = useRef(props.session);

  const push = useCallback((item: ItemInput) => {
    setItems((prev) => [...prev, { ...item, id: idRef.current++ } as Item]);
  }, []);

  // Spinner frames while thinking.
  useEffect(() => {
    if (spinLabel === null) return;
    const t = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(t);
  }, [spinLabel]);

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
        if (props.autoApprove) return true;
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
        if (props.autoApprove) {
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
          provider: props.provider,
          model: props.model,
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
            case "tool_start":
              stopSpin();
              push({ kind: "tool", name: ev.tool, arg: toolArg(ev.input) });
              break;
            case "tool_end": {
              stopSpin();
              const lines = ev.result.content.split("\n").filter((l) => l.length > 0);
              const summary =
                (lines[0] ?? "").slice(0, 120) +
                (lines.length > 1 ? `  +${lines.length - 1} more lines` : "");
              push({ kind: "result", text: summary, isError: ev.result.isError === true });
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
            case "denied":
              stopSpin();
              push({ kind: "denied", reason: ev.reason });
              thinkAt.current = Date.now();
              setSpinLabel("Thinking…");
              break;
            case "approval_request":
              break;
            case "done":
              result = ev.result;
              break;
          }
        }
      } finally {
        stopSpin();
        running.current = false;
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

  const submit = useCallback(
    (raw: string) => {
      const task = raw.trim();
      if (!task || running.current) return;
      setInput("");
      setHistIdx(-1);
      setHist((h) => (h[0] === task ? h : [task, ...h].slice(0, 500)));
      if (task === "exit" || task === "quit") {
        finish(0);
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
    [finish, push, runOnce],
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
      }
      if (runCtl.current) runCtl.current.abort();
      return;
    }
    const p = pendingRef.current;
    if (p.kind === "plan" || p.kind === "tool") {
      const opts = p.kind === "plan" ? 2 : 3;
      if (key.upArrow || ch === "k") setMenuSel((s) => (s - 1 + opts) % opts);
      else if (key.downArrow || ch === "j") setMenuSel((s) => (s + 1) % opts);
      else if (ch === "y") choose(p, 0);
      else if (p.kind === "tool" && ch === "a") choose(p, 1);
      else if (ch === "n") choose(p, opts - 1);
      else if (key.return) choose(p, menuSel);
      return;
    }
    if (p.kind === "input") {
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

  function choose(p: Pending, i: number) {
    setPending({ kind: "input" });
    if (p.kind === "plan") p.resolve(i === 0);
    else if (p.kind === "tool") p.resolve(i === 1 ? "a" : i === 0 ? "y" : "n");
  }

  const mode = props.planOnly ? "plan" : props.autoApprove ? "always-approve" : "ask";

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(it) => <ItemView key={it.id} it={it} props={props} />}
      </Static>
      {spinLabel !== null && (
        <Text>
          {"  "}
          <Text color="cyan">{FRAMES[frame % FRAMES.length]}</Text>{" "}
          <Text dimColor>
            {spinLabel}  ·  esc to interrupt
          </Text>
        </Text>
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
          sel={menuSel}
        />
      )}
      {pending.kind === "tool" && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
            <Text>
              ⚠ Approval required — <Text bold>{describe(pending.req)}</Text>
            </Text>
            {(pending.req.reason ?? pending.req.decision.reason) && (
              <Text dimColor>Reason: {pending.req.reason ?? pending.req.decision.reason}</Text>
            )}
          </Box>
          <Menu options={["Yes", "Always (this session)", "No"]} sel={menuSel} />
        </Box>
      )}
      {pending.kind === "input" && !exited && (
        <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
          <Box>
            <Text color="cyan">❯ </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} />
          </Box>
          <Text dimColor>
            {props.model} · {mode}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function Menu({ title, options, sel }: { title?: string; options: string[]; sel: number }) {
  return (
    <Box flexDirection="column" marginTop={0}>
      {title ? <Text dimColor>{title}</Text> : null}
      {options.map((o, i) => (
        <Text key={o} inverse={i === sel} dimColor={i !== sel}>
          {i === sel ? `  ❯ ${o}` : `    ${o}`}
        </Text>
      ))}
      <Text dimColor>↑/↓ navigate · Enter select · esc cancel</Text>
    </Box>
  );
}

function ItemView({ it, props }: { it: Item; props: AppProps }) {
  switch (it.kind) {
    case "banner":
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">
            DxxpCode
          </Text>
          <Text dimColor>
            v{props.version} · {props.provider.name} · {props.model}
          </Text>
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
      return (
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text>
            <Text color="cyan">❯ </Text>
            {it.text}
          </Text>
        </Box>
      );
    case "note":
      return <Text dimColor>  {it.text}</Text>;
    case "thought":
      return <Text dimColor>  ◆ Thought for {it.secs.toFixed(1)}s</Text>;
    case "text":
      return (
        <Box flexDirection="column">
          {it.text.split("\n").map((l, i) => (
            <Text key={i}>
              {i === 0 ? <Text color="cyan">⏺ </Text> : "  "}
              {mdLine(l)}
            </Text>
          ))}
        </Box>
      );
    case "tool": {
      const name = TOOL_DISPLAY[it.name] ?? it.name;
      return (
        <Text>
          <Text color="cyan">⏺ </Text>
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
    case "plan":
      return (
        <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
          <Text dimColor>── plan ──────────────────────</Text>
          {it.summary ? <Text dimColor>{it.summary}</Text> : null}
          {it.steps.map((s, i) => (
            <Text key={i}>
              <Text color="cyan">{i + 1}</Text>
              {`. ${s}`}
            </Text>
          ))}
        </Box>
      );
    case "diff":
      return (
        <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
          <Text>
            <Text dimColor>── </Text>
            <Text bold>{it.path}</Text>
            <Text dimColor> ── ×</Text>
          </Text>
          {it.rows
            .filter((r) => r.kind !== "meta")
            .map((r, i) => (
              <Text
                key={i}
                color={r.kind === "hunk" ? "cyan" : r.kind === "add" ? "green" : r.kind === "del" ? "red" : undefined}
                dimColor={r.kind === "ctx"}
                backgroundColor={r.kind === "add" ? "#0c2b16" : r.kind === "del" ? "#3b0f12" : undefined}
              >
                {r.num !== null ? String(r.num).padStart(4) + "  " : "      "}
                {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                {r.text}
              </Text>
            ))}
        </Box>
      );
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
          <Text> </Text>
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

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalRequest, RunResult } from "@dxxpcode/agent";
import { compactMessages, runTask, undoCheckpoint } from "@dxxpcode/agent";
import type { ReasoningEffort } from "@dxxpcode/providers";
import { resolveProvider } from "@dxxpcode/providers";
import { loadConfig, loadSession, saveConfig, saveSession } from "@dxxpcode/sessions";
import { ProviderSetup, SetupWizard, type SetupResult, type WizardResult } from "./setup.tsx";
import { diffTarget, TOOL_VERBS, toolArg } from "../render.ts";
import { expandMentions, listProjectFiles } from "../mentions.ts";
import { CHANGELOG_MD, DOCS_MD } from "../reference.ts";
import { billingUrl, openUrl, waitForLoginCallback } from "../auth.ts";
import { jevRouteEffort, smartApprove } from "../jev.ts";
import { loadHistory, saveHistory } from "./history.ts";
import { mdLine } from "./md.tsx";
import { parseDiff } from "./diff.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, FRAMES, SURFACE_HI, describe, fmtTokens } from "./shared.ts";
import { atFragment, fileSuggestions, type FileIndex } from "./suggest.ts";
import { Card, ItemView, MAJOR_ITEMS, Menu, TabBar, ShimmerMark } from "./widgets.tsx";
import { useConfigMenus } from "./useMenus.tsx";
import type { AppProps, Item, ItemInput, Pending } from "./types.ts";

export type { AppProps };

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
  const cfgRef = useRef(loadConfig(process.env));
  const [prov, setProv] = useState({ provider: props.provider, model: props.model });
  const provRef = useRef(prov);
  // /config writes these; they take effect on the next run.
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  const autoRef = useRef(props.autoApprove);
  const smartRef = useRef(props.smartApprove ?? false);
  const jevKey = process.env.TYPESAFE_API_KEY ?? cfgRef.current.typeSafeApiKey;
  const autoEffortRef = useRef(cfgRef.current.effortAuto ?? false);
  const effortRef = useRef(props.effort);
  const [promptVal, setPromptVal] = useState("");
  const [setup, setSetup] = useState(false);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const [wizard, setWizard] = useState(false);
  const wizardRef = useRef(wizard);
  wizardRef.current = wizard;
  const fileIndexRef = useRef<FileIndex | null>(null);
  // Trailing @fragment → file/dir suggestions; leading / → command suggestions.
  const atFrag = atFragment(input);
  const suggestions = input.startsWith("/")
    ? COMMANDS.filter((c) => c.name.startsWith(input))
    : atFrag !== null
      ? fileSuggestions((fileIndexRef.current ??= listProjectFiles(props.root)), atFrag)
      : [];
  const sugMode = input.startsWith("/") ? "cmd" : "file";
  const sugSel = Math.min(cmdSel, Math.max(0, suggestions.length - 1));
  const sugRef = useRef<{ sel: number; names: string[]; mode: string }>({
    sel: 0,
    names: [],
    mode: "cmd",
  });
  sugRef.current = { sel: sugSel, names: suggestions.map((c) => c.name), mode: sugMode };

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
        if (smartRef.current && jevKey) {
          const v = await smartApprove(req, jevKey);
          if (v?.approve) {
            push({ kind: "note", text: `⎿ smart-approved: ${describe(req)} (jev ${v.confidence.toFixed(2)})` });
            return true;
          }
          if (v) push({ kind: "note", text: `⎿ jev escalated (${v.confidence.toFixed(2)}) — your call` });
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

      let eff = effortRef.current;
      if (autoEffortRef.current && jevKey) {
        const r = await jevRouteEffort(mentions.text, jevKey);
        if (r) {
          eff = r.effort;
          push({ kind: "note", text: `⎿ effort: ${r.effort} (jev ${r.confidence.toFixed(2)})` });
        }
      }

      const t0 = Date.now();
      let result: RunResult | undefined;
      try {
        for await (const ev of runTask({
          task: mentions.text,
          provider: provRef.current.provider,
          model: provRef.current.model,
          effort: eff,
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
            case "checkpoint":
              push({ kind: "note", text: `⎿ checkpoint ${ev.seq} — /undo restores ${ev.paths.join(", ")}` });
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

  const { openModelMenu, openProviderMenu, openEffortMenu, openConfigMenu, statusRows } = useConfigMenus({
    props,
    push,
    setPending,
    setMenuSel,
    setSpinLabel,
    setProv,
    setModeOverride,
    setSetup,
    provRef,
    autoRef,
    smartRef,
    effortRef,
    autoEffortRef,
    jevKey,
    sessionRef,
    modeOverride,
    tok,
  });

  const [inputKey, setInputKey] = useState(0);
  const completeMention = (name: string) => {
    setInput(
      (v) => v.replace(/@[^\s#]*((?:#[^\s]*)?)$/, `@${name}$1`) + (name.endsWith("/") ? "" : " "),
    );
    // Remount so the cursor lands at the end instead of the old offset.
    setInputKey((k) => k + 1);
  };

  const submit = useCallback(
    (raw: string) => {
      let task = raw.trim();
      if (!task || running.current) return;
      // Enter with an @mention dropdown open completes the mention unless the
      // typed path already resolves to a real file or directory.
      if (sugRef.current.mode === "file" && sugRef.current.names.length > 0) {
        const m = task.match(/@([^\s#]*)((?:#[^\s]*)?)$/);
        const frag = m ? m[1] : "";
        if (!m || !existsSync(join(props.root, frag.replace(/\/+$/, "")))) {
          completeMention(sugRef.current.names[sugRef.current.sel]);
          return;
        }
      }
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
      if (task === "/status" || task === "/sessions") {
        openConfigMenu(1);
        return;
      }
      if (task === "/config" || task === "/settings") {
        openConfigMenu(0);
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
      if (task === "/setup") {
        setWizard(true);
        return;
      }
      if (task === "/providers") {
        openProviderMenu();
        return;
      }
      if (task === "/undo") {
        const sess = sessionRef.current;
        const out = sess ? undoCheckpoint(props.root, sess.id, process.env) : null;
        push({
          kind: "note",
          text: out
            ? `restored checkpoint ${out.seq}${out.restored.length ? ` — restored ${out.restored.join(", ")}` : ""}${out.removed.length ? ` — removed ${out.removed.join(", ")}` : ""}${out.headMoved ? ` — note: HEAD moved (${out.headMoved.from.slice(0, 7)} → ${out.headMoved.to.slice(0, 7)}) since this checkpoint` : ""}`
            : "⎿ nothing to undo",
        });
        return;
      }
      if (task === "/login") {
        if (cfgRef.current.authToken) {
          push({ kind: "note", text: `⎿ already signed in as ${cfgRef.current.accountEmail ?? "account"} — /logout to switch` });
          return;
        }
        const pendingLogin = waitForLoginCallback(process.env);
        pendingLogin.url
          .then((u) => {
            const opened = openUrl(u);
            push({
              kind: "note",
              text: opened
                ? `⎿ opened ${u} — finish sign-in in your browser`
                : `⎿ open this URL to sign in: ${u}`,
            });
          })
          .catch((e: Error) => push({ kind: "note", text: `⎿ sign-in failed: ${e.message}` }));
        pendingLogin.result
          .then((r) => {
            cfgRef.current = { ...cfgRef.current, authToken: r.token, accountEmail: r.email, plan: r.plan ?? "free" };
            saveConfig(cfgRef.current, process.env);
            push({ kind: "note", text: `⎿ signed in${r.email ? ` as ${r.email}` : ""} · plan ${r.plan ?? "free"}` });
          })
          .catch((e: Error) => push({ kind: "note", text: `⎿ sign-in failed: ${e.message}` }));
        return;
      }
      if (task === "/logout") {
        if (!cfgRef.current.authToken) {
          push({ kind: "note", text: "⎿ not signed in" });
          return;
        }
        const { authToken: _t, accountEmail: _e, plan: _p, ...rest } = cfgRef.current;
        cfgRef.current = rest;
        saveConfig(cfgRef.current, process.env);
        push({ kind: "note", text: "⎿ signed out — token removed from config.json" });
        return;
      }
      if (task === "/upgrade") {
        const url = cfgRef.current.authToken
          ? `${billingUrl(process.env)}?token=${encodeURIComponent(cfgRef.current.authToken)}`
          : billingUrl(process.env);
        push({
          kind: "note",
          text: openUrl(url)
            ? `⎿ opened ${url} — manage your plan in the browser`
            : `⎿ manage your plan at: ${url}`,
        });
        return;
      }
      if (task === "/docs") {
        push({ kind: "text", text: DOCS_MD });
        return;
      }
      if (task === "/changelog") {
        push({ kind: "text", text: CHANGELOG_MD });
        return;
      }
      if (task === "/compact") {
        const sess = sessionRef.current;
        if (!sess || sess.messages.length === 0) {
          push({ kind: "note", text: "⎿ no session context to compact yet" });
          return;
        }
        const r = compactMessages(sess.messages, { force: true });
        saveSession(sess, process.env);
        push({
          kind: "note",
          text: r.compacted
            ? `⎿ compacted context — ${r.blocks} old result(s) summarized (~${fmtTokens(r.before)} → ~${fmtTokens(r.after)} tok)`
            : `⎿ context already compact (~${fmtTokens(r.before)} tok)`,
        });
        return;
      }
      if (task === "/clear") {
        setItems([]);
        return;
      }
      if (task === "/new") {
        sessionRef.current = undefined;
        props.allowlist.clear();
        push({ kind: "note", text: "⎿ new session — context and session approvals reset" });
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
    if (setupRef.current || wizardRef.current) return; // setup wizard owns input while open
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
      if (p.kind === "config" && p.tabs) {
        const tabs = p.tabs.length;
        const t = p.tab ?? 0;
        if (key.leftArrow) {
          setMenuSel(0);
          setPending({ ...p, tab: (t + tabs - 1) % tabs });
        } else if (key.rightArrow) {
          setMenuSel(0);
          setPending({ ...p, tab: (t + 1) % tabs });
        } else if (t === 0) {
          if (key.upArrow || ch === "k") setMenuSel((s) => (s - 1 + opts) % opts);
          else if (key.downArrow || ch === "j") setMenuSel((s) => (s + 1) % opts);
          else if (key.return) choose(p, menuSel);
        }
        return;
      }
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
        else if (key.tab && sugRef.current.mode === "file") completeMention(sug[sugRef.current.sel]);
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

  const onWizardDone = useCallback(
    (r: WizardResult | null) => {
      setWizard(false);
      if (!r) {
        push({ kind: "note", text: "setup cancelled" });
        return;
      }
      if (r.provider) onSetupDone(r.provider);
      const cfg = { ...loadConfig() };
      if (r.effortAuto) {
        cfg.effortAuto = true;
        autoEffortRef.current = true;
      } else if (r.effort !== undefined) {
        cfg.effort = r.effort;
        cfg.effortAuto = false;
        effortRef.current = r.effort;
        autoEffortRef.current = false;
      }
      if (r.typeSafeApiKey) cfg.typeSafeApiKey = r.typeSafeApiKey;
      saveConfig(cfg);
      const bits = [
        r.provider ? `provider ${r.provider.provider}` : null,
        r.effortAuto ? "effort auto (Jev)" : r.effort ? `effort ${r.effort}` : null,
        r.typeSafeApiKey ? "Jev key saved" : null,
      ].filter(Boolean);
      push({ kind: "note", text: bits.length ? `setup complete — ${bits.join(" · ")}` : "setup complete — nothing changed" });
    },
    [push, onSetupDone],
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
          <ShimmerMark frame={frame} />
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
      {pending.kind === "config" &&
        (pending.tabs ? (
          <Box flexDirection="column" marginTop={1}>
            <TabBar tabs={pending.tabs} sel={pending.tab ?? 0} />
            {pending.tab === 0 ? (
              <Menu options={pending.options} sel={menuSel} />
            ) : (
              <Box marginTop={1}>
                <Card
                  lines={statusRows().map(([k, v]) => [
                    { t: `${k.padEnd(9)}`, dim: true },
                    { t: v },
                  ])}
                />
              </Box>
            )}
          </Box>
        ) : (
          <Menu
            title={pending.title}
            options={pending.options}
            descriptions={pending.descs}
            sel={menuSel}
          />
        ))}
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
      {wizard && !exited && (
        <Box marginTop={1}>
          <SetupWizard onDone={onWizardDone} />
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
      {pending.kind === "input" && !exited && !setup && !wizard && (
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
              key={inputKey}
              value={input}
              placeholder="describe a task · / for commands · @ to attach files"
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
              : `${prov.model} · ${mode}${autoEffortRef.current ? " · auto effort" : effortRef.current ? ` · ${effortRef.current}` : ""}`}
          </Text>
        </Box>
      )}
      {pending.kind === "input" &&
        !exited &&
        !setup &&
        !wizard &&
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

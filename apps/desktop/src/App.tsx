import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Plus, Search, PanelLeft, Minus, Square, X, ChevronDown } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Approval, Item, MenuState, Plan, PromptState, ReadyInfo, Todo } from "./types";
import { TOOL_DISPLAY, TOOL_FAMILY, TOOL_ICONS, toolArg } from "./types";

marked.setOptions({ breaks: true, gfm: true });
const md = (t: string) => ({ __html: marked.parse(t, { async: false }) });

// Render a still-growing stream: close an unclosed ``` fence so it paints as a
// code block instead of flickering raw markers while it's being written.
function closePartialMd(t: string): string {
  const fences = t.match(/(^|\n)```/g);
  if (fences && fences.length % 2 === 1) t += "\n```";
  return t;
}

// Streaming text: render everything but the newest fragment statically, and
// wrap the tail in an .ease span so only the freshly arrived words fade/slide
// in (re-mounting the tail is fine — it's the part that's animating anyway).
function mdStream(t: string) {
  const closed = closePartialMd(t);
  const cut = Math.max(0, closed.length - 28);
  const sp = closed.indexOf(" ", cut);
  const tail = sp > 0 ? closed.slice(sp + 1) : closed.slice(cut);
  const head = closed.slice(0, closed.length - tail.length);
  return { __html: `${marked.parse(head, { async: false })}<span class="ease">${marked.parseInline(tail, { async: false })}</span>` };
}

const EFFORT_LEVELS = ["default", "minimal", "low", "medium", "high", "xhigh", "max", "auto (Jev)"];
const send = (cmd: object) => invoke("pty_write", { data: JSON.stringify(cmd) + "\n" });

const win = getCurrentWindow();
// macOS gets native overlay traffic lights; Linux/Windows need our own.
const IS_MAC = navigator.userAgent.includes("Macintosh");

interface Ev { type: string; [k: string]: unknown }

const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: "Explore this codebase", prompt: "Give me a tour of this codebase — the main entry points, structure, and how the pieces fit together." },
  { label: "Build a feature", prompt: "" },
  { label: "Fix a bug", prompt: "" },
  { label: "Review recent changes", prompt: "/review agent" },
];

export default function App() {
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [diffs, setDiffs] = useState<{ id: number; path: string; diff: string; decided?: string }[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [promptReq, setPromptReq] = useState<PromptState | null>(null);
  const [promptVal, setPromptVal] = useState("");
  const [cmdSel, setCmdSel] = useState(0);
  const [fileSugs, setFileSugs] = useState<{ id: number; items: { name: string; desc: string }[] }>({ id: -1, items: [] });
  const fileReqId = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // In-app updates: checked once on launch, downloaded in the background,
  // then surfaced as a restart row in Settings → About.
  const [update, setUpdate] = useState<{ version: string; status: "downloading" | "ready" } | null>(null);
  useEffect(() => {
    check()
      .then((u) => {
        if (!u) return;
        setUpdate({ version: u.version, status: "downloading" });
        u.downloadAndInstall()
          .then(() => setUpdate({ version: u.version, status: "ready" }))
          .catch(() => setUpdate(null));
      })
      .catch(() => {});
  }, []);
  const [sessionInfo, setSessionInfo] = useState<{ id: string | null; tokens: number }>({ id: null, tokens: 0 });
  const [onboarding, setOnboarding] = useState(false);
  // Onboarding wizard: welcome → pick a provider → enter + validate the key.
  const [obStep, setObStep] = useState<"welcome" | "pick" | "key" | "project">("welcome");
  const [obProvider, setObProvider] = useState<"anthropic" | "openai" | "openrouter">("anthropic");
  const OB_BASE: Record<string, string | undefined> = { openrouter: "https://openrouter.ai/api/v1" };
  const [obKey, setObKey] = useState("");
  const [obBase, setObBase] = useState("");
  const [obBusy, setObBusy] = useState(false);
  const [obError, setObError] = useState<string | null>(null);
  // Set when we respawn the sidecar for a project switch; the next ready
  // event then finishes onboarding instead of re-showing it.
  const projectSwitchPending = useRef(false);
  const [docView, setDocView] = useState<{ title: string; text: string } | null>(null);
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem("sidebar") !== "closed");
  const [modelPop, setModelPop] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; title: string; desc: string }[]>([]);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [sysDark, setSysDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme === "system" ? sysDark : theme === "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", theme);
  }, [dark, theme]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const push = (item: Item) => {
    if (textBuf.current && flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
    closeThink();
    // Reasoning that directly precedes a tool call anchors to that tool's row.
    if (item.k === "tool") {
      setItems((prev) => {
        const last = prev[prev.length - 1];
        if (last?.k === "think" && !last.live)
          return [...prev.slice(0, -1), { ...item, think: { text: last.text, ms: last.ms } }];
        return [...prev, item];
      });
      return;
    }
    setItems((prev) => [...prev, item]);
  };
  const commands = ready?.commands ?? [];
  const palette = input.startsWith("/")
    ? commands.filter((c) => c.name.startsWith(input.split(/\s/)[0]))
    : [];
  const atMatch = input.match(/(?:^|\s)@([^\s]*)$/);
  const atFrag = palette.length === 0 && atMatch ? atMatch[1].split("#")[0] : null;
  const files = atFrag !== null ? fileSugs.items : [];
  // Batch streamed deltas: buffer and flush once per frame-ish so React
  // re-renders ~30x/sec max instead of once per NDJSON chunk.
  const textBuf = useRef("");
  const thinkBuf = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live token rate: count streamed chars, report ~tok/s while streaming.
  const [tokRate, setTokRate] = useState(0);
  const rateChars = useRef(0);
  const rateStart = useRef(0);
  const rateTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const countStream = (n: number) => {
    if (!rateStart.current) {
      rateStart.current = Date.now();
      rateTimer.current = setInterval(() => {
        const el = (Date.now() - rateStart.current) / 1000;
        setTokRate(el > 0 ? Math.round(rateChars.current / 4 / el) : 0);
      }, 400);
    }
    rateChars.current += n;
  };
  const stopRate = useCallback(() => {
    if (rateTimer.current) { clearInterval(rateTimer.current); rateTimer.current = null; }
    rateChars.current = 0;
    rateStart.current = 0;
    setTokRate(0);
  }, []);
  const flushThink = useCallback(() => {
    thinkTimer.current = null;
    const t = thinkBuf.current;
    thinkBuf.current = "";
    if (!t) return;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "think" && last.live) return [...prev.slice(0, -1), { ...last, text: last.text + t }];
      return [...prev, { k: "think", text: t, live: true, startedAt: Date.now() }];
    });
  }, []);
  const appendThink = (t: string) => {
    thinkBuf.current += t;
    countStream(t.length);
    if (!thinkTimer.current) thinkTimer.current = setTimeout(flushThink, 32);
  };
  const closeThink = useCallback(() => {
    if (thinkTimer.current) { clearTimeout(thinkTimer.current); flushThink(); }
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "think" && last.live)
        return [...prev.slice(0, -1), { ...last, live: false, ms: last.startedAt ? Date.now() - last.startedAt : undefined }];
      return prev;
    });
  }, [flushThink]);
  const flushText = useCallback(() => {
    flushTimer.current = null;
    const t = textBuf.current;
    textBuf.current = "";
    if (!t) return;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "text") return [...prev.slice(0, -1), { k: "text", text: last.text + t }];
      return [...prev, { k: "text", text: t }];
    });
  }, []);
  const appendText = (t: string) => {
    textBuf.current += t;
    countStream(t.length);
    if (!flushTimer.current) flushTimer.current = setTimeout(flushText, 32);
  };

  const handle = useCallback((ev: Ev) => {
    switch (ev.type) {
      case "ready": {
        const r = ev as unknown as ReadyInfo;
        setReady(r);
        if (projectSwitchPending.current) {
          projectSwitchPending.current = false;
          setOnboarding(false);
          setObStep("welcome");
        } else if (r.needsSetup) { setOnboarding(true); setObStep("welcome"); }
        // A fresh ready = respawned sidecar (project switch) or first boot —
        // reset the transcript so the new session starts clean.
        setItems([]);
        setApprovals([]);
        setSessionInfo({ id: null, tokens: 0 });
        break;
      }
      case "user":
        push({ k: "user", text: String(ev.text) });
        setRunning(true);
        break;
      case "state":
        setReady((prev) =>
          prev
            ? {
                ...prev,
                provider: String(ev.provider),
                model: String(ev.model),
                effort: ev.effort as string | undefined,
                mode: String(ev.mode),
              }
            : prev,
        );
        break;
      case "menu":
        setMenu({
          id: Number(ev.id), title: String(ev.title),
          options: ev.options as MenuState["options"],
          current: ev.current as number | undefined,
        });
        break;
      case "prompt":
        setPromptReq({ id: Number(ev.id), title: String(ev.title), secret: ev.secret === true });
        setPromptVal("");
        break;
      case "table":
        push({ k: "table", title: String(ev.title), rows: ev.rows as [string, string][] });
        break;
      case "markdown":
        setDocView({ title: String(ev.title), text: String(ev.text) });
        break;
      case "diff_card":
        push({ k: "diffcard", title: String(ev.title), diff: String(ev.diff) });
        break;
      case "error":
        push({ k: "note", text: `error: ${ev.text}` });
        break;
      case "exit":
        void getCurrentWindow().close();
        break;
      case "session":
        setSessionInfo({ id: ev.id as string | null, tokens: Number(ev.tokens) });
        break;
      case "sessions":
        setSessions(Array.isArray(ev.items) ? (ev.items as { id: string; title: string; desc: string }[]) : []);
        break;
      case "files":
        if (Number(ev.id) === fileReqId.current)
          setFileSugs({ id: fileReqId.current, items: ev.items as { name: string; desc: string }[] });
        break;
      case "setup_result": {
        setObBusy(false);
        if (ev.ok === true) {
          setObStep("project");
          setObKey("");
          setObBase("");
          setObError(null);
        } else {
          setObError(String(ev.error ?? "could not validate key"));
        }
        break;
      }
      case "status":
        setStatus(String(ev.message));
        break;
      case "think":
        appendThink(String(ev.text));
        break;
      case "text":
        // Text following a thinking block ends it.
        closeThink();
        appendText(String(ev.text));
        setStatus(null);
        break;
      case "plan":
        push({ k: "plan", plan: ev.plan as Plan });
        break;
      case "tool_start":
        push({
          k: "tool", tool: String(ev.tool),
          arg: toolArg((ev.input as Record<string, unknown>) ?? {}),
          pending: true, startedAt: Date.now(),
        });
        break;
      case "tool_delta": {
        // Live partial output from a running tool (e.g. run_command).
        const delta = String(ev.text);
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "tool" && it.pending && it.tool === ev.tool) {
              next[i] = { ...it, out: (it.out ?? "") + delta };
              return next;
            }
          }
          return next;
        });
        break;
      }
      case "tool_end": {
        const res = ev.result as { content?: string; isError?: boolean; diff?: string };
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "tool" && it.pending && it.tool === ev.tool) {
              next[i] = { ...it, pending: false, out: res.content, isError: res.isError, diff: res.diff };
              return next;
            }
          }
          return next;
        });
        setStatus("Thinking…");
        break;
      }
      case "todo":
        push({ k: "todos", items: ev.items as Todo[] });
        break;
      case "checkpoint":
        push({ k: "note", text: `checkpoint ${ev.seq} — /undo restores ${(ev.paths as string[]).join(", ")}` });
        break;
      case "denied":
        push({ k: "denied", tool: String(ev.tool), reason: String(ev.reason) });
        break;
      case "compacted":
        push({ k: "note", text: `compacted context — ${ev.blocks} old result(s) summarized` });
        break;
      case "approval":
        setApprovals((prev) => [
          ...prev,
          {
            id: Number(ev.id), kind: ev.kind as "plan" | "tool",
            summary: String(ev.summary), reason: ev.reason as string | undefined,
            allowAlways: ev.allowAlways === true,
            extraChoice: ev.extraChoice as { choice: string; label: string } | undefined,
          },
        ]);
        break;
      case "diff_review":
        setDiffs((prev) => [
          ...prev,
          { id: Number(ev.id), path: String(ev.path), diff: String(ev.diff) },
        ]);
        break;
      case "steer":
        push({ k: "note", text: `steering: ${ev.text}`, steer: true });
        break;
      case "note":
        push({ k: "note", text: String(ev.text) });
        break;
      case "done": {
        const r = ev.result as {
          status: string; summary: string; filesChanged?: string[];
          usage?: { inputTokens?: number; outputTokens?: number };
        };
        if (r.status === "cancelled") {
          // Mark a text stream cut short by esc.
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].k === "text") {
                next[i] = { ...next[i], interrupted: true };
                break;
              }
              if (next[i].k === "user" || next[i].k === "done") break;
            }
            return next;
          });
        }
        push({
          k: "done", status: r.status, summary: r.summary ?? "",
          filesChanged: r.filesChanged ?? [],
          tokens: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined,
        });
        break;
      }
      case "idle":
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); flushThink(); }
        closeThink();
        stopRate();
        setRunning(false);
        setStatus(null);
        break;
      case "usage":
        break;
    }
  }, [stopRate]);

  useEffect(() => {
    let buf = "";
    const dec = new TextDecoder();
    const un = listen<number[]>("pty-out", (e) => {
      buf += dec.decode(new Uint8Array(e.payload), { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (!t) continue;
        try {
          handle(JSON.parse(t) as Ev);
        } catch {
          push({ k: "raw", text: t });
        }
      }
    });
    // Tell the backend the listener is attached; it replays early output.
    void un.then(() => invoke("ui_ready"));
    return () => {
      void un.then((f) => f());
    };
  }, [handle]);

  // Stick to bottom: auto-scroll only while the user is already at the bottom;
  // scrolling up pauses follow so the transcript doesn't fight the reader.
  const stickBottom = useRef(true);
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [items, approvals, status]);

  // Ask the CLI for @mention completions whenever the fragment changes.
  useEffect(() => {
    if (atFrag === null) return;
    const id = ++fileReqId.current;
    const t = setTimeout(() => {
      void send({ type: "list_files", id, text: atFrag });
    }, 120);
    return () => clearTimeout(t);
  }, [atFrag]);

  const completeMention = (name: string) => {
    setInput((v) => v.replace(/@[^\s]*$/, `@${name}`) + (name.endsWith("/") ? "" : " "));
    setFileSugs({ id: -1, items: [] });
    taRef.current?.focus();
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    if (files.length > 0 && atFrag !== null) {
      // File palette open — Enter completes the selected mention.
      completeMention(files[Math.min(cmdSel, files.length - 1)].name);
      setCmdSel(0);
      return;
    }
    if (palette.length > 0 && !text.includes(" ")) {
      // Palette open on an exact/partial command — take the selected suggestion.
      const pick = palette[Math.min(cmdSel, palette.length - 1)];
      if (pick && pick.name !== text) {
        setInput(pick.name);
        setCmdSel(0);
        return;
      }
    }
    setInput("");
    setCmdSel(0);
    if (text === "/clear") {
      setItems([]);
      return;
    }
    if (text === "/exit") {
      void getCurrentWindow().close();
      return;
    }
    void send({ type: "submit", text });
  };

  const pickMenu = (index: number) => {
    const m = menu;
    if (!m) return;
    setMenu({ ...m, answered: index });
    setTimeout(() => setMenu((cur) => (cur?.id === m.id ? null : cur)), 250);
    void send({ type: "select", id: m.id, index });
  };

  const cmd = (name: string) => {
    setSettingsOpen(false);
    if (name === "/docs" || name === "/changelog" || name === "/help") setDocView({ title: "…", text: "" });
    void send({ type: "command", name });
  };

  const openProject = () => {
    void invoke<string | null>("pick_folder").then((dir) => {
      if (dir) {
        projectSwitchPending.current = true;
        void invoke("restart_sidecar", { cwd: dir });
      }
    });
  };

  const submitPrompt = () => {
    const p = promptReq;
    if (!p) return;
    setPromptReq(null);
    void send({ type: "prompt_submit", id: p.id, text: promptVal });
  };

  const answer = (id: number, choice: string) => {
    setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, answered: choice } : a)));
    void send({ type: "approve", id, choice });
  };

  const decideDiff = (id: number, decision: string) => {
    setDiffs((prev) => prev.map((d) => (d.id === id ? { ...d, decided: decision } : d)));
    void send({ type: "diff_decide", id, decision });
  };

  useEffect(() => {
    localStorage.setItem("sidebar", sideOpen ? "open" : "closed");
  }, [sideOpen]);

  const [sbQuery, setSbQuery] = useState("");

  // Refresh the session list on boot, project switch, and session change.
  useEffect(() => {
    if (ready && sideOpen) void send({ type: "sessions" });
  }, [ready, sideOpen, sessionInfo.id]);

  // Group sessions by recency: desc is "<yyyy-mm-dd> · N msg".
  const sessionGroups = (() => {
    const q = sbQuery.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const groups: [string, typeof filtered][] = [];
    for (const s of filtered) {
      const date = s.desc.split("·")[0].trim();
      const label = date === today ? "Today" : date === yesterday ? "Yesterday" : "Earlier";
      const last = groups[groups.length - 1];
      if (last && last[0] === label) last[1].push(s);
      else groups.push([label, [s]]);
    }
    return groups;
  })();

  return (
    <div className="app">
      {sideOpen && ready && (
        <aside className="sidebar" data-tauri-drag-region>
          <div className="sb-top">
            <Button variant="ghost" className="w-full justify-start h-8 px-2.5" onClick={() => cmd("/new")}>
              <Plus size={13} />
              <span>New session</span>
            </Button>
            <div className="sb-search">
              <Search size={12} />
              <Input
                type="text"
                placeholder="Search"
                value={sbQuery}
                onChange={(e) => setSbQuery(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
          <ScrollArea className="sb-list">
            <div className="sb-items">
              {sessionGroups.length === 0 && <p className="sb-empty">{sbQuery ? "No matches." : "No sessions in this project yet."}</p>}
              {sessionGroups.map(([label, group]) => (
                <div className="sb-group" key={label}>
                  <div className="sb-group-label">{label}</div>
                  {group.map((s) => {
                    const active = s.id === sessionInfo.id;
                    return (
                      <Button
                        key={s.id}
                        variant={active ? "secondary" : "ghost"}
                        title={s.title}
                        onClick={() => void send({ type: "resume", id: s.id })}
                        className={`w-full justify-start h-8 px-2.5${active ? " shadow-[var(--shadow-sm)] ring-1 ring-inset ring-[var(--border)]" : ""}`}
                      >
                        <span className={`truncate${active ? " font-semibold" : ""}`}>{s.title || "Untitled"}</span>
                      </Button>
                    );
                  })}
                </div>
              ))}
            </div>
          </ScrollArea>
        </aside>
      )}
      <div className="main">
      <header className={`header${IS_MAC ? " mac" : ""}`} data-tauri-drag-region>
        <div className="hctx" data-tauri-drag-region>
          <Button
            variant="ghost"
            size="icon"
            title={sideOpen ? "Hide sessions" : "Show sessions"}
            onClick={() => setSideOpen((v) => !v)}
          >
            <PanelLeft size={14} />
          </Button>
          <Logo className="logo-mark" />
        </div>
        <span className="spacer" />
        {ready && !IS_MAC && (
          <div className="hact">
            <Button variant="ghost" size="icon" title="Minimize" onClick={() => void win.minimize()}>
              <Minus size={14} />
            </Button>
            <Button variant="ghost" size="icon" title="Maximize" onClick={() => void win.toggleMaximize()}>
              <Square size={12} />
            </Button>
            <Button variant="ghost" size="icon" title="Close" className="win-close" onClick={() => void win.close()}>
              <X size={14} />
            </Button>
          </div>
        )}
      </header>

      {settingsOpen && ready && (
        <div className="settings">
          <div className="settings-col">
            <div className="setgroup">
              <div className="setgroup-title">Agent</div>
              <div className="setlist">
                <SetRow label="Provider" value={`${ready.provider} · ${ready.model}`} onClick={() => cmd("/providers")} />
                <SetRow label="Connect a provider" value="add an API key" onClick={() => cmd("/provider")} />
                <SetRow label="Model" value={ready.model} onClick={() => cmd("/model")} />
                <SetRow label="Reasoning effort" value={ready.effort ?? "default"} onClick={() => cmd("/effort")} />
                <SetRow label="Approval mode" value={ready.mode} onClick={() => cmd("/approval")} />
              </div>
            </div>
            <div className="setgroup">
              <div className="setgroup-title">Appearance</div>
              <div className="setlist">
                <div className="setrow static">
                  <span className="setlabel">Theme</span>
                  <span className="theme-opts">
                    {(["system", "light", "dark"] as const).map((t) => (
                      <button key={t} className={`eff-pill${theme === t ? " cur" : ""}`} onClick={() => setTheme(t)}>
                        {t}
                      </button>
                    ))}
                  </span>
                </div>
              </div>
            </div>
            <div className="setgroup">
              <div className="setgroup-title">Session</div>
              <div className="setlist">
                <div className="setrow static"><span className="setlabel">Session ID</span><span className="setval mono">{sessionInfo.id ?? "—"}</span></div>
                <div className="setrow static"><span className="setlabel">Context</span><span className="setval mono">{sessionInfo.tokens ? `~${sessionInfo.tokens >= 1000 ? (sessionInfo.tokens / 1000).toFixed(1) + "k" : sessionInfo.tokens} tok / 60k cap` : "—"}</span></div>
                <SetAction
                  label="Open a project…"
                  onClick={openProject}
                />
                <SetAction label="Resume a session…" onClick={() => cmd("/resume")} />
                <SetAction label="Compact context" onClick={() => cmd("/compact")} />
                <SetAction label="Undo last checkpoint" onClick={() => cmd("/undo")} />
                <SetAction label="Start new session" onClick={() => cmd("/new")} />
              </div>
            </div>
            <div className="setgroup">
              <div className="setgroup-title">About</div>
              <div className="setlist">
                <div className="setrow static"><span className="setlabel">Version</span><span className="setval mono">v{ready.version}</span></div>
                {update?.status === "downloading" && (
                  <div className="setrow static"><span className="setlabel">Update</span><span className="setval mono">downloading v{update.version}…</span></div>
                )}
                {update?.status === "ready" && (
                  <SetAction label={`Update ready — v${update.version} · restart to apply`} onClick={() => void relaunch()} />
                )}
                <SetAction label="Documentation" onClick={() => cmd("/docs")} />
                <SetAction label="Changelog" onClick={() => cmd("/changelog")} />
                <SetAction label="Run setup…" onClick={() => cmd("/setup")} />
                <SetAction label="Quit dxxpcode" onClick={() => cmd("/exit")} danger />
              </div>
            </div>
          </div>
        </div>
      )}
      {docView && (
        <div className="docviewer" onClick={(e) => { if (e.target === e.currentTarget) setDocView(null); }}>
          <div className="card doc-card">
            <div className="card-title">
              {docView.title}
              <span className="spacer" />
              <button className="doc-close" onClick={() => setDocView(null)} aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="doc-body text" dangerouslySetInnerHTML={md(docView.text)} />
          </div>
        </div>
      )}
      {onboarding && !settingsOpen && !docView && (
        <div className="onboarding">
          <div className="card ob-card">
            <Logo className="ob-mark" />
            {obStep === "welcome" && (
              <>
                <div className="ob-title">Welcome to <span className="ob-grad">dxxpcode</span></div>
                <p className="ob-desc">Your AI coding agent — one setup step and you're ready to ship.</p>
                <div className="setbtns">
                  <button className="btn primary" onClick={() => setObStep("pick")}>Get started</button>
                  <button className="btn" onClick={() => setOnboarding(false)}>Skip for now</button>
                </div>
                <p className="ob-hint">Re-run anytime with /setup or Settings → Run setup</p>
              </>
            )}
            {obStep === "pick" && (
              <>
                <div className="ob-title">Connect a provider</div>
                <p className="ob-desc">Pick where your models come from — you can add more later.</p>
                <div className="ob-providers">
                  <button className="ob-prov" onClick={() => { setObProvider("anthropic"); setObStep("key"); setObError(null); }}>
                    <span className="ob-prov-name">Anthropic</span>
                    <span className="ob-prov-desc">Claude models</span>
                  </button>
                  <button className="ob-prov" onClick={() => { setObProvider("openrouter"); setObStep("key"); setObError(null); }}>
                    <span className="ob-prov-name">OpenRouter</span>
                    <span className="ob-prov-desc">one key — Claude, GPT, Gemini, Llama</span>
                  </button>
                  <button className="ob-prov" onClick={() => { setObProvider("openai"); setObStep("key"); setObError(null); }}>
                    <span className="ob-prov-name">OpenAI-compatible</span>
                    <span className="ob-prov-desc">OpenAI, Gemini, local endpoints</span>
                  </button>
                  <button className="ob-prov demo" onClick={() => { setObBusy(true); void send({ type: "setup", provider: "mock" }); }}>
                    <span className="ob-prov-name">Just explore</span>
                    <span className="ob-prov-desc">demo mode — no key needed</span>
                  </button>
                </div>
                <div className="setbtns">
                  <button className="btn" onClick={() => setObStep("welcome")}>Back</button>
                </div>
              </>
            )}
            {obStep === "project" && (
              <>
                <div className="ob-title">Open a project</div>
                <p className="ob-desc">Pick the folder dxxpcode works in.{ready ? ` Currently ${ready.project.name}.` : ""}</p>
                <div className="setbtns">
                  <button className="btn primary" onClick={() => setOnboarding(false)}>Use {ready?.project.name ?? "this folder"}</button>
                  <button className="btn" onClick={openProject}>
                    Choose folder…
                  </button>
                </div>
                <p className="ob-hint">Switch anytime with Settings → Open a project</p>
              </>
            )}
            {obStep === "key" && (
              <>
                <div className="ob-title">{obProvider === "anthropic" ? "Anthropic API key" : obProvider === "openrouter" ? "OpenRouter API key" : "OpenAI-compatible key"}</div>
                <p className="ob-desc">Validated against {obProvider === "anthropic" ? "api.anthropic.com" : obProvider === "openrouter" ? "openrouter.ai/api/v1" : "the /models endpoint"} before it's saved.</p>
                <input
                  className="ob-input mono"
                  type="password"
                  autoFocus
                  placeholder={obProvider === "anthropic" ? "sk-ant-…" : "sk-…"}
                  value={obKey}
                  onChange={(e) => { setObKey(e.target.value); setObError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && obKey.trim() && !obBusy) {
                      setObBusy(true);
                      void send({ type: "setup", provider: obProvider === "openrouter" ? "openai" : obProvider, key: obKey.trim(), base_url: OB_BASE[obProvider] ?? (obBase.trim() || undefined) });
                    }
                  }}
                />
                {obProvider === "openai" && (
                  <input
                    className="ob-input mono"
                    type="text"
                    placeholder="Base URL — blank for api.openai.com"
                    value={obBase}
                    onChange={(e) => setObBase(e.target.value)}
                  />
                )}
                {obError && <p className="ob-error">{obError}</p>}
                <div className="setbtns">
                  <button className="btn" disabled={obBusy} onClick={() => setObStep("pick")}>Back</button>
                  <button
                    className="btn primary"
                    disabled={!obKey.trim() || obBusy}
                    onClick={() => {
                      setObBusy(true);
                      void send({ type: "setup", provider: obProvider === "openrouter" ? "openai" : obProvider, key: obKey.trim(), base_url: OB_BASE[obProvider] ?? (obBase.trim() || undefined) });
                    }}
                  >
                    {obBusy ? "Validating…" : "Validate & connect"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll} style={settingsOpen ? { display: "none" } : undefined}>
        {items.length === 0 && approvals.length === 0 && ready && !onboarding && (
          <div className="hero">
            <Logo className="hero-mark" />
            <div className="hero-title">What should we build in
              <button className="hero-proj" title="Change project" onClick={openProject}>
                {ready.project.name}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>?
            </div>
            <div className="hero-cards">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  className="hero-card"
                  onClick={() => { setInput(s.prompt); taRef.current?.focus(); }}
                >
                  <span className="hero-label">{s.label}</span>
                  <span className="hero-arrow" aria-hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it, i) => (
          <ItemView key={i} item={it} streaming={running && i === items.length - 1} />
        ))}
        {approvals.map((a) => (
          <div className={`approval row${a.answered ? " answered" : ""}`} key={`ap${a.id}`}>
            <div className="title"><span className="dot" />Approval required</div>
            <div className="summary">{a.summary}</div>
            {a.reason && <div className="reason">Reason: {a.reason}</div>}
            {a.answered ? (
              <div className="reason">answered: {a.answered === "n" ? "denied" : a.answered === "a" ? "always allow" : a.answered === "s" ? "approved + saved" : "allowed"}</div>
            ) : (
              <div className="btns">
                <button className="btn allow" onClick={() => answer(a.id, "y")}>Allow</button>
                {a.allowAlways && <button className="btn" onClick={() => answer(a.id, "a")}>Always allow</button>}
                {a.extraChoice && <button className="btn" onClick={() => answer(a.id, a.extraChoice!.choice)}>{a.extraChoice.label}</button>}
                <button className="btn deny" onClick={() => answer(a.id, "n")}>Deny</button>
              </div>
            )}
          </div>
        ))}
        {diffs.map((d) => {
          const st = diffStats(d.diff);
          return (
            <div className={`approval row diffrev${d.decided ? " answered" : ""}`} key={`df${d.id}`}>
              <div className="title">
                <span className="dot" />Review change — {d.path}
                <span className="diffstat"><span className="ds-add">+{st.add}</span><span className="ds-del">−{st.del}</span></span>
              </div>
              <Diff diff={d.diff} />
              {d.decided ? (
                <div className="reason">{d.decided === "discard" ? "discarded" : "applied"}</div>
              ) : (
                <div className="btns">
                  <button className="btn allow" onClick={() => decideDiff(d.id, "apply")}>Apply</button>
                  <button className="btn" onClick={() => decideDiff(d.id, "apply_all")}>Apply all</button>
                  <button className="btn deny" onClick={() => decideDiff(d.id, "discard")}>Discard</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="statusline">
        {(status || tokRate > 0) && <><span className="pulse" /><span>{status}</span>{tokRate > 0 && <span className="tokrate">{tokRate} tok/s</span>}{running && <span style={{ color: "var(--faint)" }}>· esc to interrupt</span>}</>}
      </div>

      {menu && (
        <div className="menu-card">
          <div className="card-title">{menu.title}</div>
          <div className="menu-opts">
            {menu.options.map((o, i) => (
              <button
                key={i}
                className={`menu-opt${i === menu.current ? " cur" : ""}`}
                disabled={menu.answered !== undefined}
                onClick={() => pickMenu(i)}
              >
                <span className="menu-label">{o.label}</span>
                {o.desc && <span className="menu-desc">{o.desc}</span>}
              </button>
            ))}
          </div>
          <div className="btns">
            <button className="btn deny" onClick={() => pickMenu(-1)}>Cancel</button>
          </div>
        </div>
      )}
      {promptReq && (
        <div className="menu-card">
          <div className="card-title">{promptReq.title}</div>
          <div className="prompt-row">
            <input
              autoFocus
              type={promptReq.secret ? "password" : "text"}
              value={promptVal}
              onChange={(e) => setPromptVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPrompt();
                else if (e.key === "Escape") {
                  setPromptReq(null);
                  void send({ type: "prompt_submit", id: promptReq.id, text: "" });
                }
              }}
            />
            <button className="btn allow" onClick={submitPrompt}>OK</button>
          </div>
        </div>
      )}
      <div className="composer">
        {palette.length > 0 && (
          <div className="palette">
            {palette.map((c, i) => (
              <button
                key={c.name}
                className={`palette-row${i === Math.min(cmdSel, palette.length - 1) ? " sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(c.name);
                  setCmdSel(0);
                  taRef.current?.focus();
                }}
              >
                <span className="mono pcmd">{c.name}</span>
                <span className="pdesc">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {palette.length === 0 && files.length > 0 && (
          <div className="palette">
            {files.map((f, i) => (
              <button
                key={f.name}
                className={`palette-row${i === Math.min(cmdSel, files.length - 1) ? " sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  completeMention(f.name);
                }}
              >
                <span className="mono pcmd">{f.name}</span>
                <span className="pdesc">{f.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="inputbox">
          {ready && (
            <div className="inctx-row">
              <button className="inctx" title="Change project" onClick={openProject}>
                <span className="inctx-name">{ready.project.name}</span>
                {ready.project.git && (
                  <span className="branch mono">{ready.project.git.branch}{ready.project.git.dirty ? "*" : ""}</span>
                )}
                <ChevronDown size={11} />
              </button>
              <div className="inctx-anchor">
                <button className="inctx" title="Model & effort" onClick={() => setModelPop((v) => !v)}>
                  <span className="inctx-name">
                    {ready.model}
                    {ready.effort && ready.effort !== "default" ? ` · ${ready.effort}` : ""}
                  </span>
                  <ChevronDown size={11} />
                </button>
                {modelPop && (
                  <>
                    <div className="pop-back" onClick={() => setModelPop(false)} />
                    <div className="inctx-pop">
                      <button className="pop-row" onClick={() => { setModelPop(false); cmd("/model"); }}>
                        <span className="pop-row-label">Change model…</span>
                        <span className="pop-val mono">{ready.model}</span>
                      </button>
                      <div className="pop-sep" />
                      <div className="pop-label">Reasoning effort</div>
                      <div className="eff-grid">
                        {EFFORT_LEVELS.map((lvl) => (
                          <button
                            key={lvl}
                            className={`eff-pill${(ready.effort ?? "default") === lvl ? " cur" : ""}`}
                            onClick={() => { setModelPop(false); cmd(`/effort ${lvl}`); }}
                          >
                            {lvl}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="ghost-wrap">
            {input && (
              <div className="ghost-mirror" aria-hidden="true">
                <span className="ghost-src">{input}</span>
                <span className="ghost-hint"> · / commands · @ files</span>
              </div>
            )}
            <textarea
            ref={taRef}
            rows={1}
            autoFocus
            placeholder="Ask dxxpcode anything…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
            onKeyDown={(e) => {
              const rows = palette.length > 0 ? palette.length : files.length;
              if (rows > 0 && e.key === "ArrowDown") {
                e.preventDefault();
                setCmdSel((s) => (s + 1) % rows);
              } else if (rows > 0 && e.key === "ArrowUp") {
                e.preventDefault();
                setCmdSel((s) => (s - 1 + rows) % rows);
              } else if (e.key === "Tab" && files.length > 0) {
                e.preventDefault();
                completeMention(files[Math.min(cmdSel, files.length - 1)].name);
                setCmdSel(0);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                if (palette.length > 0 || files.length > 0) {
                  setFileSugs({ id: -1, items: [] });
                  if (palette.length > 0) setInput("");
                } else if (running) void send({ type: "cancel" });
              }
            }}
            />
          </div>
        </div>
        <div className="hints">
          <span><kbd>⏎</kbd> send</span>
          {running && <span><kbd>esc</kbd> interrupt · typed text steers the run</span>}
          <Button variant="ghost" size="sm" className="modelchip" title={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={() => setTheme(dark ? "light" : "dark")}>
            {theme === "system" ? `auto` : theme}
          </Button>
          <Button variant="ghost" size="sm" className="modelchip" title="Settings" onClick={() => setSettingsOpen((v) => !v)}>
            settings
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}

function ItemView({ item, streaming }: { item: Item; streaming?: boolean }) {
  switch (item.k) {
    case "user":
      return <div className="usermsg row"><span className="chev">❯</span>{item.text}</div>;
    case "text":
      return (
        <div className="text row">
          <span dangerouslySetInnerHTML={streaming ? mdStream(item.text) : md(item.text)} />
          {streaming && <span className="caret" aria-hidden />}
          {item.interrupted && <span className="interrupted">— interrupted</span>}
        </div>
      );
    case "think":
      // Reasoning tokens: live dim stream while arriving, collapsible after.
      return item.live ? (
        <div className="think row">
          <div className="think-head"><span className="think-dot" /><span className="think-shimmer">Thinking</span></div>
          <div className="think-text">{item.text}<span className="caret tool-caret" aria-hidden /></div>
        </div>
      ) : (
        <details className="think row">
          <summary>
            {item.ms != null ? `Thought for ${Math.max(1, Math.round(item.ms / 1000))}s` : "Thought"}
            <span className="think-n">{item.text.trim().split("\n")[0].slice(0, 64)}{(item.text.trim().split("\n")[0] ?? "").length > 64 || item.text.includes("\n") ? "…" : ""}</span>
          </summary>
          <div className="think-text">{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return (
        <div className="card plan row">
          <div className="card-title">Plan</div>
          <div className="card-body">
            {item.plan.summary && <div style={{ marginBottom: 6, color: "var(--dim)" }}>{item.plan.summary}</div>}
            {item.plan.steps.map((s, i) => (
              <div className="plan-step" key={i}><span className="n">{i + 1}</span><span>{s}</span></div>
            ))}
          </div>
        </div>
      );
    case "todos":
      return (
        <div className="card todos row">
          <div className="card-title">Tasks</div>
          <div className="card-body">
            {item.items.map((t, i) => (
              <div className={`todo-item ${t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : ""}`} key={i}>
                <span className="mark">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○"}</span>
                <span className="lbl">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
              </div>
            ))}
          </div>
        </div>
      );
    case "table":
      return (
        <div className="card row">
          <div className="card-title">{item.title}</div>
          <div className="card-body">
            <table className="kv">
              <tbody>
                {item.rows.map(([k, v], i) => (
                  <tr key={i}><td className="k">{k}</td><td className="v mono">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "markdown":
      return (
        <div className="card row">
          <div className="card-title">{item.title}</div>
          <div className="card-body text" dangerouslySetInnerHTML={md(item.text)} />
        </div>
      );
    case "diffcard":
      return (
        <div className="card row">
          <div className="card-title">{item.title}</div>
          <div className="card-body" style={{ padding: "8px 0" }}>
            <Diff diff={item.diff} />
          </div>
        </div>
      );
    case "note":
      return <div className={`note row${item.steer ? " steer" : ""}`}>{item.steer ? "⎿ " : ""}{item.text}</div>;
    case "denied":
      return <div className="note row" style={{ color: "var(--red)" }}>⎿ Denied: {item.reason} ({item.tool})</div>;
    case "done":
      return (
        <div className="done row">
          <span className={`st ${item.status === "completed" ? "ok" : item.status === "error" ? "err" : "warn"}`}>
            {item.status === "completed" ? "Completed" : item.status}
          </span>
          <span className="meta">{item.tokens ? ` · ${item.tokens} tokens` : ""}</span>
          {item.filesChanged.length > 0 && (
            <ul>{item.filesChanged.map((f) => <li className="mono" key={f}>{f}</li>)}</ul>
          )}
        </div>
      );
    case "raw":
      return <div className="note row mono">{item.text}</div>;
  }
}

const Chevron = (
  <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
);

function SetRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button className="setrow link" onClick={onClick}>
      <span className="setlabel">{label}</span>
      <span className="setval">{value}</span>
      {Chevron}
    </button>
  );
}

function SetAction({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`setrow link${danger ? " danger" : ""}`} onClick={onClick}>
      <span className="setlabel">{label}</span>
      {Chevron}
    </button>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - since) / 1000);
  return <span className="elapsed">{s}s</span>;
}

function ToolRow({ item }: { item: Extract<Item, { k: "tool" }> }) {
  const fam = TOOL_FAMILY[item.tool] ?? "planx";
  const name = TOOL_DISPLAY[item.tool] ?? item.tool;
  const icon = TOOL_ICONS[item.tool] ?? "•";
  const first = item.out?.split("\n").filter((l) => l.trim())[0]?.slice(0, 120);
  // While running, show the tail of the streamed output; once finished it
  // collapses into the usual details/summary.
  const tail = item.pending && item.out?.trim()
    ? item.out.trimEnd().split("\n").slice(-6).join("\n")
    : null;
  return (
    <div className={`tool row ${fam}`}>
      <div className="head">
        <span className="icon">{icon}</span>
        <span className="name">{name}</span>
        {item.arg && <span className="arg">{item.arg}</span>}
        {item.pending && (
          <>
            <span className="caret tool-caret" aria-hidden />
            {item.startedAt && <Elapsed since={item.startedAt} />}
          </>
        )}
      </div>
      {item.think && (
        <details className="think tool-think">
          <summary>
            {item.think.ms != null ? `Thought for ${Math.max(1, Math.round(item.think.ms / 1000))}s` : "Thought"}
            <span className="think-n">{item.think.text.trim().split("\n")[0].slice(0, 64)}…</span>
          </summary>
          <div className="think-text">{item.think.text}</div>
        </details>
      )}
      {tail && <div className="out live">{tail}</div>}
      {item.diff ? (
        <div className="card" style={{ margin: "6px 0 0 22px" }}>
          <div className="card-body" style={{ padding: "8px 0" }}>
            <Diff diff={item.diff} />
          </div>
        </div>
      ) : !item.pending && item.out && item.out.trim() ? (
        <details>
          <summary className={item.isError ? "" : ""}>{item.isError ? "error: " : ""}{first}{item.out.split("\n").length > 1 ? ` (+${item.out.split("\n").length - 1} lines)` : ""}</summary>
          <div className={`out${item.isError ? " err" : ""}`}>{item.out}</div>
        </details>
      ) : null}
    </div>
  );
}

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

type DiffRow = { cls: string; gutter: string; text: string; chg?: [number, number] };

// Pair each run of deletions with the following run of additions and highlight
// the differing infix inside each paired line (common prefix/suffix trimmed).
function wordChanges(rows: DiffRow[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].cls !== "del") { i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].cls === "del") j++;
    let k = j;
    while (k < rows.length && rows[k].cls === "add") k++;
    const dels = rows.slice(i, j), adds = rows.slice(j, k);
    for (let n = 0; n < Math.min(dels.length, adds.length); n++) {
      const a = dels[n].text.slice(1), b = adds[n].text.slice(1);
      let pre = 0;
      while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
      let suf = 0;
      while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      if (a.length - pre - suf > 0) dels[n].chg = [pre + 1, a.length - suf + 1];
      if (b.length - pre - suf > 0) adds[n].chg = [pre + 1, b.length - suf + 1];
    }
    i = k;
  }
}

export function Diff({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const rows: DiffRow[] = [];
  let oldN = 0, newN = 0;
  for (const l of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      oldN = Number(h[1]); newN = Number(h[2]);
      rows.push({ cls: "hunk", gutter: "", text: l });
    } else if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) {
      rows.push({ cls: "meta", gutter: "", text: l });
    } else if (l.startsWith("+")) {
      rows.push({ cls: "add", gutter: String(newN++), text: l });
    } else if (l.startsWith("-")) {
      rows.push({ cls: "del", gutter: String(oldN++), text: l });
    } else if (l.startsWith("\\")) {
      rows.push({ cls: "ctx", gutter: "", text: l });
    } else if (oldN > 0 || newN > 0) {
      rows.push({ cls: "ctx", gutter: String(newN++), text: l }); oldN++;
    } else {
      rows.push({ cls: "ctx", gutter: "", text: l });
    }
  }
  wordChanges(rows);
  // Fold long runs of context lines (keep head+tail, collapse the middle).
  const FOLD_KEEP = 2;
  const view: (DiffRow | { fold: number })[] = [];
  let n = 0;
  while (n < rows.length) {
    if (rows[n].cls === "ctx" && rows[n].gutter !== "") {
      let m = n;
      while (m < rows.length && rows[m].cls === "ctx" && rows[m].gutter !== "") m++;
      const run = m - n;
      if (!expanded && run > FOLD_KEEP * 2 + 1) {
        view.push(...rows.slice(n, n + FOLD_KEEP), { fold: run - FOLD_KEEP * 2 }, ...rows.slice(m - FOLD_KEEP, m));
      } else {
        view.push(...rows.slice(n, m));
      }
      n = m;
    } else {
      view.push(rows[n]); n++;
    }
  }
  const renderText = (r: DiffRow) => {
    const hasSign = r.cls === "add" || r.cls === "del";
    const off = hasSign ? 1 : 0;
    const body = r.chg
      ? <span>{r.text.slice(off, r.chg[0])}<mark className="chg">{r.text.slice(r.chg[0], r.chg[1])}</mark>{r.text.slice(r.chg[1])}</span>
      : <span>{r.text.slice(off)}</span>;
    return hasSign ? <><span className="sign">{r.text[0]}</span>{body}</> : body;
  };
  return (
    <div className="diff">
      {view.map((r, i) =>
        "fold" in r ? (
          <button className="ln fold" key={i} onClick={() => setExpanded(true)}>
            <span className="gutter" /><span>⋮ {r.fold} unchanged lines</span>
          </button>
        ) : (
          <div className={`ln ${r.cls}`} key={i}><span className="gutter">{r.gutter}</span>{renderText(r)}</div>
        ),
      )}
    </div>
  );
}

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 442 270" fill="currentColor" role="img" aria-label="DxxpCode" className={className}>
      <path d="M0 0L95 135L0 270H66L257 0H191L128.5 88L66 0ZM375 0L185.5 270H252L314 183L375.5 270H441L347 135L441.5 0ZM267 23L234 70L272 123.5L305.5 76.5ZM171 148L138 195L176 248.5L209.5 201.5Z" />
    </svg>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Approval, Item, MenuState, Plan, PromptState, ReadyInfo, Todo } from "./types";
import { TOOL_DISPLAY, TOOL_FAMILY, TOOL_ICONS, toolArg } from "./types";

marked.setOptions({ breaks: true, gfm: true });
const md = (t: string) => ({ __html: marked.parse(t, { async: false }) });

const send = (cmd: object) => invoke("pty_write", { data: JSON.stringify(cmd) + "\n" });

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
  const [sessionInfo, setSessionInfo] = useState<{ id: string | null; tokens: number }>({ id: null, tokens: 0 });
  const [onboarding, setOnboarding] = useState(false);
  const [docView, setDocView] = useState<{ title: string; text: string } | null>(null);
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const push = (item: Item) => {
    if (textBuf.current && flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
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
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (!flushTimer.current) flushTimer.current = setTimeout(flushText, 32);
  };

  const handle = useCallback((ev: Ev) => {
    switch (ev.type) {
      case "ready": {
        const r = ev as unknown as ReadyInfo;
        setReady(r);
        if (r.needsSetup) setOnboarding(true);
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
      case "files":
        if (Number(ev.id) === fileReqId.current)
          setFileSugs({ id: fileReqId.current, items: ev.items as { name: string; desc: string }[] });
        break;
      case "status":
        setStatus(String(ev.message));
        break;
      case "text":
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
        push({
          k: "done", status: r.status, summary: r.summary ?? "",
          filesChanged: r.filesChanged ?? [],
          tokens: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined,
        });
        break;
      }
      case "idle":
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
        setRunning(false);
        setStatus(null);
        break;
      case "usage":
        break;
    }
  }, []);

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

  return (
    <div className="app">
      <header className="header">
        <Logo className="logo-mark" />
        {ready && (
          <>
            {ready.project.git && (
              <span className="branch mono">{ready.project.git.branch}{ready.project.git.dirty ? "*" : ""}</span>
            )}
            <span className="spacer" />
            <button className="ctl" title={dark ? "Light mode" : "Dark mode"} onClick={() => setDark((v) => !v)}>
              {dark ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
              )}
            </button>
            <button className="ctl gear" title="Settings" onClick={() => setSettingsOpen((v) => !v)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </>
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
              <div className="setgroup-title">Session</div>
              <div className="setlist">
                <div className="setrow static"><span className="setlabel">Session ID</span><span className="setval mono">{sessionInfo.id ?? "—"}</span></div>
                <div className="setrow static"><span className="setlabel">Context</span><span className="setval mono">{sessionInfo.tokens ? `~${sessionInfo.tokens >= 1000 ? (sessionInfo.tokens / 1000).toFixed(1) + "k" : sessionInfo.tokens} tok / 60k cap` : "—"}</span></div>
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
            <div className="ob-title">Welcome to <span className="ob-grad">dxxpcode</span></div>
            <p className="ob-desc">Your AI coding agent — one setup step and you're ready to ship.</p>
            <div className="setbtns">
              <button className="btn primary" onClick={() => { setOnboarding(false); cmd("/setup"); }}>Get started</button>
              <button className="btn" onClick={() => setOnboarding(false)}>Skip for now</button>
            </div>
            <p className="ob-hint">Re-run anytime with /setup or Settings → Run setup</p>
          </div>
        </div>
      )}
      <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll} style={settingsOpen ? { display: "none" } : undefined}>
        {items.length === 0 && approvals.length === 0 && ready && !onboarding && (
          <div className="hero">
            <Logo className="hero-mark" />
            <div className="hero-title">What should we build in <span className="hero-proj">{ready.project.name}</span>?</div>
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
      </div>

      <div className="statusline">
        {status && <><span className="pulse" /><span>{status}</span>{running && <span style={{ color: "var(--faint)" }}>· esc to interrupt</span>}</>}
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
        <div className="hints">
          <span><kbd>/</kbd> commands · <kbd>@</kbd> files</span>
          <span><kbd>⏎</kbd> send</span>
          {running && <span><kbd>esc</kbd> interrupt · typed text steers the run</span>}
          {ready && (
            <button className="modelchip" title="Provider & model — click to change" onClick={() => cmd("/providers")}>
              {ready.model}
            </button>
          )}
          {ready?.effort && (
            <button className="modelchip" title="Reasoning effort — click to change" onClick={() => cmd("/effort")}>
              {ready.effort}
            </button>
          )}
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
          <span dangerouslySetInnerHTML={md(item.text)} />
          {streaming && <span className="caret" aria-hidden />}
        </div>
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

function Diff({ diff }: { diff: string }) {
  const rows: { cls: string; gutter: string; text: string }[] = [];
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
  return (
    <div className="diff">
      {rows.map((r, i) => (
        <div className={`ln ${r.cls}`} key={i}><span className="gutter">{r.gutter}</span><span>{r.text}</span></div>
      ))}
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

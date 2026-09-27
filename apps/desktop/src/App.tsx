import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { Approval, Item, MenuState, Plan, PromptState, ReadyInfo, Todo } from "./types";
import { TOOL_DISPLAY, TOOL_FAMILY, TOOL_ICONS, toolArg } from "./types";
import { transport } from "./transport";

marked.setOptions({ breaks: true, gfm: true });
const md = (t: string) => ({ __html: marked.parse(t, { async: false }) });

const send = (cmd: object) => transport.then((t) => t.send(cmd));
const closeWindow = () => transport.then((t) => t.close());

interface Ev { type: string; [k: string]: unknown }

const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: "Explore this codebase", prompt: "Give me a tour of this codebase — the main entry points, structure, and how the pieces fit together." },
  { label: "Build a feature", prompt: "" },
  { label: "Fix a bug", prompt: "" },
  { label: "Review recent changes", prompt: "/review agent" },
];

const SETUP_STEPS = ["Provider", "API key", "Effort", "Smart approvals"];

function setupStep(title: string): number {
  const t = title.toLowerCase();
  if (t.includes("connect a provider")) return 0;
  if (t.includes("api key") || t.includes("base url")) return 1;
  if (t.includes("effort")) return 2;
  if (t.includes("typesafe") || t.includes("optional")) return 3;
  return 0;
}

type ObPhase = null | "welcome" | "setup" | "done";

const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

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
  const [ob, setOb] = useState<ObPhase>(null);
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

  const push = (item: Item) => setItems((prev) => [...prev, item]);
  const commands = ready?.commands ?? [];
  const palette = input.startsWith("/")
    ? commands.filter((c) => c.name.startsWith(input.split(/\s/)[0]))
    : [];
  const atMatch = input.match(/(?:^|\s)@([^\s]*)$/);
  const atFrag = palette.length === 0 && atMatch ? atMatch[1].split("#")[0] : null;
  const files = atFrag !== null ? fileSugs.items : [];
  const appendText = (t: string) =>
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "text") return [...prev.slice(0, -1), { k: "text", text: last.text + t }];
      return [...prev, { k: "text", text: t }];
    });

  const handle = useCallback((ev: Ev) => {
    switch (ev.type) {
      case "ready": {
        const r = ev as unknown as ReadyInfo;
        setReady(r);
        if (r.needsSetup) setOb("welcome");
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
        void closeWindow();
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
          pending: true,
        });
        break;
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
      case "note": {
        const text = String(ev.text);
        if (text.startsWith("you're all set")) setOb((p) => (p === "setup" ? "done" : p));
        push({ k: "note", text });
        break;
      }
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
        setRunning(false);
        setStatus(null);
        break;
      case "usage":
        break;
    }
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void transport.then(async (t) => {
      const un = await t.subscribe((line) => {
        try {
          handle(JSON.parse(line) as Ev);
        } catch {
          push({ k: "raw", text: line });
        }
      });
      if (cancelled) { un(); return; }
      dispose = un;
      // Tell the backend the listener is attached; it replays early output.
      void t.ready();
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [handle]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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

  // Setup wizard lifecycle: close when the CLI stops asking questions
  // (cancelled or finished), linger briefly on the success screen.
  useEffect(() => {
    if (ob === "done") {
      const t = setTimeout(() => setOb(null), 1800);
      return () => clearTimeout(t);
    }
    if (ob === "setup" && !menu && !promptReq) {
      const t = setTimeout(() => setOb((p) => (p === "setup" ? null : p)), 1200);
      return () => clearTimeout(t);
    }
  }, [ob, menu, promptReq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (docView) setDocView(null);
        else if (settingsOpen) setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docView, settingsOpen]);

  const completeMention = (name: string) => {
    setInput((v) => v.replace(/@[^\s]*$/, `@${name}`) + (name.endsWith("/") ? "" : " "));
    setFileSugs({ id: -1, items: [] });
    taRef.current?.focus();
  };

  const resetTextarea = () => {
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    if (files.length > 0 && atFrag !== null) {
      completeMention(files[Math.min(cmdSel, files.length - 1)].name);
      setCmdSel(0);
      return;
    }
    if (palette.length > 0 && !text.includes(" ")) {
      const pick = palette[Math.min(cmdSel, palette.length - 1)];
      if (pick && pick.name !== text) {
        setInput(pick.name);
        setCmdSel(0);
        return;
      }
    }
    setInput("");
    setCmdSel(0);
    resetTextarea();
    if (text === "/clear") {
      setItems([]);
      return;
    }
    if (text === "/exit") {
      void closeWindow();
      return;
    }
    void send({ type: "submit", text });
  };

  const pickMenu = (index: number) => {
    const m = menu;
    if (!m) return;
    setMenu({ ...m, answered: index });
    setTimeout(() => setMenu((cur) => (cur?.id === m.id ? null : cur)), 220);
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

  const cancelPrompt = () => {
    const p = promptReq;
    if (!p) return;
    setPromptReq(null);
    void send({ type: "prompt_submit", id: p.id, text: "" });
  };

  const answer = (id: number, choice: string) => {
    setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, answered: choice } : a)));
    void send({ type: "approve", id, choice });
  };

  const startSetup = () => {
    setOb("setup");
    cmd("/setup");
  };

  const inWizard = ob === "setup";
  const showHero = items.length === 0 && approvals.length === 0 && ready && ob === null;

  return (
    <div className="app">
      <div className="bg-glow" aria-hidden />
      <header className="header">
        <div className="brand">
          <Logo className="logo-mark" />
          {ready && (
            <div className="crumb">
              <span className="crumb-sep">/</span>
              <span className="crumb-proj">{ready.project.name}</span>
              {ready.project.git && (
                <span className="branch mono" title={ready.project.git.dirty ? "uncommitted changes" : "clean"}>
                  <Icon name="branch" />
                  {ready.project.git.branch}
                  {ready.project.git.dirty && <span className="dirty" />}
                </span>
              )}
            </div>
          )}
        </div>
        <span className="spacer" />
        {ready && (
          <div className="header-actions">
            <span className={`mode-pill mode-${ready.mode.replace(/[^a-z]/g, "")}`} title="Approval mode">{ready.mode}</span>
            <button className="ctl" title={dark ? "Switch to light" : "Switch to dark"} onClick={() => setDark((v) => !v)}>
              <Icon name={dark ? "sun" : "moon"} />
            </button>
            <button className={`ctl gear${settingsOpen ? " on" : ""}`} title="Settings" onClick={() => setSettingsOpen((v) => !v)}>
              <Icon name="gear" />
            </button>
          </div>
        )}
      </header>

      {settingsOpen && ready && (
        <div className="sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <aside className="sheet" role="dialog" aria-label="Settings">
            <div className="sheet-head">
              <div className="sheet-title">Settings</div>
              <button className="ctl ghost" onClick={() => setSettingsOpen(false)} aria-label="Close"><Icon name="x" /></button>
            </div>
            <div className="sheet-body">
              <section className="sect">
                <div className="sect-title">Appearance</div>
                <div className="seg">
                  <button className={`seg-opt${!dark ? " on" : ""}`} onClick={() => setDark(false)}><Icon name="sun" />Light</button>
                  <button className={`seg-opt${dark ? " on" : ""}`} onClick={() => setDark(true)}><Icon name="moon" />Dark</button>
                </div>
              </section>
              <section className="sect">
                <div className="sect-title">Model</div>
                <div className="list">
                  <SetRow label="Provider" value={ready.provider} onClick={() => cmd("/providers")} />
                  <SetRow label="Model" value={ready.model} mono onClick={() => cmd("/model")} />
                  <SetRow label="Reasoning effort" value={ready.effort ?? "default"} onClick={() => cmd("/effort")} />
                  <SetRow label="Approval mode" value={ready.mode} onClick={() => cmd("/approval")} />
                  <SetRow label="Connect a provider" value="Add an API key" onClick={() => cmd("/provider")} />
                </div>
              </section>
              <section className="sect">
                <div className="sect-title">Session</div>
                <div className="list">
                  <div className="setrow static"><span className="setlabel">Session id</span><span className="setval mono">{sessionInfo.id ?? "—"}</span></div>
                  <div className="setrow static">
                    <span className="setlabel">Context</span>
                    <span className="setval">
                      {sessionInfo.tokens ? (
                        <span className="ctx">
                          <span className="ctx-bar"><span style={{ width: `${Math.min(100, (sessionInfo.tokens / 60000) * 100)}%` }} /></span>
                          <span className="mono">~{fmtTok(sessionInfo.tokens)} / 60k</span>
                        </span>
                      ) : "—"}
                    </span>
                  </div>
                </div>
                <div className="setbtns">
                  <button className="btn" onClick={() => cmd("/resume")}><Icon name="history" />Resume…</button>
                  <button className="btn" onClick={() => cmd("/compact")}><Icon name="compact" />Compact</button>
                  <button className="btn" onClick={() => cmd("/undo")}><Icon name="undo" />Undo</button>
                  <button className="btn" onClick={() => cmd("/new")}><Icon name="plus" />New session</button>
                </div>
              </section>
              <section className="sect">
                <div className="sect-title">About</div>
                <div className="list">
                  <div className="setrow static"><span className="setlabel">Version</span><span className="setval mono">v{ready.version}</span></div>
                </div>
                <div className="setbtns">
                  <button className="btn" onClick={() => cmd("/docs")}>Docs</button>
                  <button className="btn" onClick={() => cmd("/changelog")}>Changelog</button>
                  <button className="btn" onClick={() => { setSettingsOpen(false); startSetup(); }}>Run setup…</button>
                  <button className="btn deny" onClick={() => cmd("/exit")}>Quit</button>
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}

      {docView && (
        <div className="docviewer" onClick={(e) => { if (e.target === e.currentTarget) setDocView(null); }}>
          <div className="card doc-card">
            <div className="card-title">
              {docView.title}
              <span className="spacer" />
              <button className="ctl ghost" onClick={() => setDocView(null)} aria-label="Close"><Icon name="x" /></button>
            </div>
            {docView.text ? (
              <div className="doc-body text" dangerouslySetInnerHTML={md(docView.text)} />
            ) : (
              <div className="doc-body skeleton"><span /><span /><span /><span /></div>
            )}
          </div>
        </div>
      )}

      {ob && !settingsOpen && !docView && (
        <div className="onboarding">
          {ob === "welcome" && (
            <div className="ob-card">
              <div className="ob-orb"><Logo className="ob-mark" /></div>
              <div className="ob-title">Welcome to <span className="ob-grad">dxxpcode</span></div>
              <p className="ob-desc">An AI coding agent that lives in your terminal. Connect a provider and you're ready to ship.</p>
              <ul className="ob-feats">
                <li><Icon name="key" /><span>Bring your own key — Anthropic or any OpenAI-compatible endpoint</span></li>
                <li><Icon name="shield" /><span>Every write and shell command goes through approvals you control</span></li>
                <li><Icon name="undo" /><span>Checkpoints let you undo anything the agent changes</span></li>
              </ul>
              <div className="ob-actions">
                <button className="btn primary lg" onClick={startSetup}>Get started<Icon name="arrow" /></button>
                <button className="btn ghost" onClick={() => setOb(null)}>Skip for now</button>
              </div>
              <p className="ob-hint">Takes about a minute · re-run anytime with <kbd>/setup</kbd></p>
            </div>
          )}
          {ob === "setup" && (
            <Wizard
              menu={menu}
              prompt={promptReq}
              promptVal={promptVal}
              setPromptVal={setPromptVal}
              onPick={pickMenu}
              onPromptSubmit={submitPrompt}
              onPromptCancel={cancelPrompt}
              onCancel={() => {
                if (menu) pickMenu(-1);
                else if (promptReq) cancelPrompt();
                setOb(null);
              }}
            />
          )}
          {ob === "done" && (
            <div className="ob-card ob-done">
              <div className="ob-check"><Icon name="check" /></div>
              <div className="ob-title">You're all set</div>
              <p className="ob-desc">Ask dxxpcode anything — it'll plan, ask before it acts, and show you every change.</p>
            </div>
          )}
        </div>
      )}

      <div className="transcript" ref={scrollRef}>
        <div className="thread">
          {showHero && (
            <div className="hero">
              <Logo className="hero-mark" />
              <div className="hero-title">What should we build in <span className="hero-proj">{ready.project.name}</span>?</div>
              {ready.project.languages.length > 0 && (
                <div className="hero-langs">{ready.project.languages.slice(0, 4).map((l) => <span key={l}>{l}</span>)}</div>
              )}
              <div className="hero-cards">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    className="hero-card"
                    onClick={() => { setInput(s.prompt); taRef.current?.focus(); }}
                  >
                    <span className="hero-label">{s.label}</span>
                    <span className="hero-arrow" aria-hidden><Icon name="arrow" /></span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((it, i) => <ItemView key={i} item={it} />)}
          {approvals.map((a) => (
            <div className={`approval row${a.answered ? " answered" : ""}`} key={`ap${a.id}`}>
              <div className="ap-head">
                <span className="ap-icon"><Icon name="shield" /></span>
                <span className="ap-title">{a.kind === "plan" ? "Approve plan" : "Approval required"}</span>
                {a.answered && (
                  <span className="ap-answer">
                    {a.answered === "n" ? "Denied" : a.answered === "a" ? "Always allowed" : a.answered === "s" ? "Approved & saved" : "Allowed"}
                  </span>
                )}
              </div>
              <div className="summary">{a.summary}</div>
              {a.reason && <div className="reason">{a.reason}</div>}
              {!a.answered && (
                <div className="btns">
                  <button className="btn primary" onClick={() => answer(a.id, "y")}>Allow</button>
                  {a.allowAlways && <button className="btn" onClick={() => answer(a.id, "a")}>Always allow</button>}
                  {a.extraChoice && <button className="btn" onClick={() => answer(a.id, a.extraChoice!.choice)}>{a.extraChoice.label}</button>}
                  <span className="spacer" />
                  <button className="btn deny" onClick={() => answer(a.id, "n")}>Deny</button>
                </div>
              )}
            </div>
          ))}
          {status && (
            <div className="statusline row">
              <span className="pulse" />
              <span className="shimmer">{status}</span>
              {running && <span className="hint">esc to interrupt</span>}
            </div>
          )}
        </div>
      </div>

      <div className="dock">
        {!inWizard && menu && (
          <div className="popover">
            <div className="pop-title">{menu.title}</div>
            <MenuOptions menu={menu} onPick={pickMenu} />
            <div className="pop-foot">
              <span className="hint"><kbd>esc</kbd> cancel</span>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => pickMenu(-1)}>Cancel</button>
            </div>
          </div>
        )}
        {!inWizard && promptReq && (
          <div className="popover">
            <div className="pop-title">{promptReq.title}</div>
            <PromptField
              prompt={promptReq}
              value={promptVal}
              onChange={setPromptVal}
              onSubmit={submitPrompt}
              onCancel={cancelPrompt}
            />
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
                  <span className="pfile"><Icon name={f.name.endsWith("/") ? "folder" : "file"} /></span>
                  <span className="mono pcmd">{f.name}</span>
                  <span className="pdesc">{f.desc}</span>
                </button>
              ))}
            </div>
          )}
          <div className={`inputbox${running ? " busy" : ""}`}>
            <textarea
              ref={taRef}
              rows={1}
              autoFocus
              placeholder={running ? "Type to steer the run…" : "Ask dxxpcode anything…"}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
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
                  } else if (menu) pickMenu(-1);
                  else if (running) void send({ type: "cancel" });
                }
              }}
            />
            <div className="toolbar">
              {ready && (
                <>
                  <button className="chip" title="Provider & model" onClick={() => cmd("/providers")}>
                    <Icon name="spark" /><span className="mono">{ready.model}</span>
                  </button>
                  {ready.effort && (
                    <button className="chip" title="Reasoning effort" onClick={() => cmd("/effort")}>
                      <Icon name="gauge" />{ready.effort}
                    </button>
                  )}
                </>
              )}
              <span className="spacer" />
              <span className="hint kbd-hint"><kbd>/</kbd> commands <kbd>@</kbd> files</span>
              {running ? (
                <button className="send stop" title="Interrupt (esc)" onClick={() => void send({ type: "cancel" })}>
                  <Icon name="stop" />
                </button>
              ) : (
                <button className="send" title="Send (⏎)" disabled={!input.trim()} onClick={submit}>
                  <Icon name="up" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Wizard(props: {
  menu: MenuState | null;
  prompt: PromptState | null;
  promptVal: string;
  setPromptVal: (v: string) => void;
  onPick: (i: number) => void;
  onPromptSubmit: () => void;
  onPromptCancel: () => void;
  onCancel: () => void;
}) {
  const { menu, prompt } = props;
  const title = menu?.title ?? prompt?.title ?? "";
  const step = setupStep(title);
  const optional = /optional|blank/i.test(title);
  const heading = ["Choose a provider", "Add your API key", "Reasoning effort", "Smart approvals"][step];
  const blurb = [
    "Pick where your model runs. You can add more providers later from Settings.",
    "Stored locally in your dxxpcode config — never sent anywhere but your provider.",
    "How hard the model thinks by default. You can change this per task.",
    "Optionally connect Jev to auto-approve safe actions and pick effort per task.",
  ][step];
  return (
    <div className="ob-card ob-wizard">
      <ol className="stepper" aria-label="Setup progress">
        {SETUP_STEPS.map((s, i) => (
          <li key={s} className={i < step ? "past" : i === step ? "cur" : ""}>
            <span className="step-dot">{i < step ? <Icon name="check" /> : i + 1}</span>
            <span className="step-lbl">{s}</span>
          </li>
        ))}
      </ol>
      <div className="wiz-body" key={title}>
        {title ? (
          <>
            <div className="wiz-title">{heading}</div>
            <p className="wiz-blurb">{blurb}</p>
            {menu && <MenuOptions menu={menu} onPick={props.onPick} large />}
            {prompt && (
              <>
                <label className="wiz-label">{prompt.title.replace(/^Optional:\s*/i, "").replace(/\s*\(blank[^)]*\)\s*:?$/i, "").replace(/:$/, "")}</label>
                <PromptField
                  prompt={prompt}
                  value={props.promptVal}
                  onChange={props.setPromptVal}
                  onSubmit={props.onPromptSubmit}
                  onCancel={props.onPromptCancel}
                  submitLabel={optional && !props.promptVal ? "Skip" : "Continue"}
                />
              </>
            )}
          </>
        ) : (
          <div className="wiz-wait"><span className="pulse" />Waiting for the agent…</div>
        )}
      </div>
      <div className="wiz-foot">
        <button className="btn ghost sm" onClick={props.onCancel}>Cancel setup</button>
        <span className="spacer" />
        <span className="hint">Step {step + 1} of {SETUP_STEPS.length}</span>
      </div>
    </div>
  );
}

function MenuOptions({ menu, onPick, large }: { menu: MenuState; onPick: (i: number) => void; large?: boolean }) {
  return (
    <div className={`menu-opts${large ? " large" : ""}`} role="listbox">
      {menu.options.map((o, i) => (
        <button
          key={i}
          role="option"
          aria-selected={i === menu.current}
          className={`menu-opt${i === menu.current ? " cur" : ""}${menu.answered === i ? " picked" : ""}`}
          disabled={menu.answered !== undefined}
          onClick={() => onPick(i)}
        >
          <span className="menu-text">
            <span className="menu-label">{o.label}</span>
            {o.desc && <span className="menu-desc">{o.desc}</span>}
          </span>
          <span className="menu-mark">{i === menu.current ? <Icon name="check" /> : <Icon name="arrow" />}</span>
        </button>
      ))}
    </div>
  );
}

function PromptField(props: {
  prompt: PromptState;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel?: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="prompt-row">
      <div className="field">
        {props.prompt.secret && <span className="field-ic"><Icon name="key" /></span>}
        <input
          autoFocus
          type={props.prompt.secret && !reveal ? "password" : "text"}
          spellCheck={false}
          autoComplete="off"
          placeholder={props.prompt.secret ? "sk-…" : ""}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onSubmit();
            else if (e.key === "Escape") props.onCancel();
          }}
        />
        {props.prompt.secret && (
          <button className="ctl ghost" type="button" tabIndex={-1} title={reveal ? "Hide" : "Show"} onClick={() => setReveal((v) => !v)}>
            <Icon name={reveal ? "eyeoff" : "eye"} />
          </button>
        )}
      </div>
      <button className="btn primary" onClick={props.onSubmit}>{props.submitLabel ?? "OK"}</button>
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.k) {
    case "user":
      return <div className="usermsg row">{item.text}</div>;
    case "text":
      return (
        <div className="assistant row">
          <span className="av"><Logo /></span>
          <div className="text" dangerouslySetInnerHTML={md(item.text)} />
        </div>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return (
        <div className="card plan row">
          <div className="card-title"><Icon name="plan" />Plan</div>
          <div className="card-body">
            {item.plan.summary && <div className="plan-summary">{item.plan.summary}</div>}
            <ol className="plan-steps">
              {item.plan.steps.map((s, i) => (
                <li className="plan-step" key={i}><span className="n">{i + 1}</span><span>{s}</span></li>
              ))}
            </ol>
          </div>
        </div>
      );
    case "todos": {
      const done = item.items.filter((t) => t.status === "completed").length;
      return (
        <div className="card todos row">
          <div className="card-title">
            <Icon name="list" />Tasks
            <span className="spacer" />
            <span className="count">{done}/{item.items.length}</span>
          </div>
          <div className="progress"><span style={{ width: `${item.items.length ? (done / item.items.length) * 100 : 0}%` }} /></div>
          <div className="card-body">
            {item.items.map((t, i) => (
              <div className={`todo-item ${t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : ""}`} key={i}>
                <span className="mark">{t.status === "completed" ? <Icon name="check" /> : t.status === "in_progress" ? <span className="pulse" /> : null}</span>
                <span className="lbl">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
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
          <div className="card-title"><Icon name="diff" />{item.title}</div>
          <Diff diff={item.diff} />
        </div>
      );
    case "note":
      return <div className={`note row${item.steer ? " steer" : ""}`}>{item.steer && <Icon name="steer" />}{item.text}</div>;
    case "denied":
      return <div className="note row denied"><Icon name="x" />Denied: {item.reason} <span className="mono">({item.tool})</span></div>;
    case "done":
      return (
        <div className="done row">
          <span className={`st ${item.status === "completed" ? "ok" : item.status === "error" ? "err" : "warn"}`}>
            {item.status === "completed" ? <Icon name="check" /> : null}
            {item.status === "completed" ? "Completed" : item.status}
          </span>
          {item.tokens ? <span className="meta">{fmtTok(item.tokens)} tokens</span> : null}
          {item.filesChanged.length > 0 && (
            <div className="files">
              {item.filesChanged.map((f) => <span className="mono" key={f}><Icon name="file" />{f}</span>)}
            </div>
          )}
        </div>
      );
    case "raw":
      return <div className="note row mono">{item.text}</div>;
  }
}

function SetRow({ label, value, onClick, mono }: { label: string; value: string; onClick: () => void; mono?: boolean }) {
  return (
    <button className="setrow" onClick={onClick}>
      <span className="setlabel">{label}</span>
      <span className={`setval${mono ? " mono" : ""}`}>{value}</span>
      <Icon name="chev" />
    </button>
  );
}

function ToolRow({ item }: { item: Extract<Item, { k: "tool" }> }) {
  const fam = TOOL_FAMILY[item.tool] ?? "planx";
  const name = TOOL_DISPLAY[item.tool] ?? item.tool;
  const icon = TOOL_ICONS[item.tool] ?? "•";
  const lines = item.out?.split("\n") ?? [];
  const first = lines.filter((l) => l.trim())[0]?.slice(0, 120);
  return (
    <div className={`tool row ${fam}${item.pending ? " pending" : ""}${item.isError ? " failed" : ""}`}>
      <div className="head">
        <span className="icon mono">{icon}</span>
        <span className="name">{name}</span>
        {item.arg && <span className="arg">{item.arg}</span>}
        {item.pending && <span className="spinner" aria-label="running" />}
      </div>
      {item.diff ? (
        <div className="card tool-diff"><Diff diff={item.diff} /></div>
      ) : item.out && item.out.trim() ? (
        <details>
          <summary>
            <Icon name="chev" />
            <span className={item.isError ? "err" : ""}>{item.isError ? "error: " : ""}{first}</span>
            {lines.length > 1 && <span className="more">+{lines.length - 1} lines</span>}
          </summary>
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

const ICONS: Record<string, string> = {
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  x: "M18 6L6 18M6 6l12 12",
  check: "M5 12.5l4.5 4.5L19 7.5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  up: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  chev: "M9 6l6 6-6 6",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  key: "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3-3.5 3.5z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2",
  compact: "M4 14h16M4 10h16M12 3v4M12 17v4M9 5l3 2 3-2M9 19l3-2 3 2",
  plus: "M12 5v14M5 12h14",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  gauge: "M12 15l3.5-5.5M3 15a9 9 0 0 1 18 0M4 18h16",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeoff: "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.6 6.6C4 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1",
  plan: "M9 4h6l1 3h4v13H4V7h4zM8 12h8M8 16h5",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  diff: "M12 3v18M5 8h14M5 16h14",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  steer: "M6 4v8a4 4 0 0 0 4 4h8M14 12l4 4-4 4",
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 442 270" fill="currentColor" role="img" aria-label="DxxpCode" className={className}>
      <path d="M0 0L95 135L0 270H66L257 0H191L128.5 88L66 0ZM375 0L185.5 270H252L314 183L375.5 270H441L347 135L441.5 0ZM267 23L234 70L272 123.5L305.5 76.5ZM171 148L138 195L176 248.5L209.5 201.5Z" />
    </svg>
  );
}

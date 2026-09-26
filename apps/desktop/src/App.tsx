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
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const push = (item: Item) => setItems((prev) => [...prev, item]);
  const commands = ready?.commands ?? [];
  const palette = input.startsWith("/")
    ? commands.filter((c) => c.name.startsWith(input.split(/\s/)[0]))
    : [];
  const appendText = (t: string) =>
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "text") return [...prev.slice(0, -1), { k: "text", text: last.text + t }];
      return [...prev, { k: "text", text: t }];
    });

  const handle = useCallback((ev: Ev) => {
    switch (ev.type) {
      case "ready":
        setReady(ev as unknown as ReadyInfo);
        break;
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
        push({ k: "markdown", title: String(ev.title), text: String(ev.text) });
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, approvals, status]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
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
        <span className="logo">XX</span>
        {ready && (
          <>
            <span className="proj">{ready.project.name}</span>
            {ready.project.git && (
              <span className="branch mono">{ready.project.git.branch}{ready.project.git.dirty ? "*" : ""}</span>
            )}
            <span className="spacer" />
            <span className="chip">{ready.provider} · {ready.model}</span>
            {ready.effort && <span className="chip">{ready.effort}</span>}
            <span className="chip">{ready.mode}</span>
          </>
        )}
      </header>

      <div className="transcript" ref={scrollRef}>
        {items.map((it, i) => <ItemView key={i} item={it} />)}
        {approvals.map((a) => (
          <div className={`approval row${a.answered ? " answered" : ""}`} key={`ap${a.id}`}>
            <div className="title"><span className="dot" />Approval required</div>
            <div className="summary">{a.summary}</div>
            {a.reason && <div className="reason">Reason: {a.reason}</div>}
            {a.answered ? (
              <div className="reason">answered: {a.answered === "n" ? "denied" : a.answered === "a" ? "always allow" : "allowed"}</div>
            ) : (
              <div className="btns">
                <button className="btn allow" onClick={() => answer(a.id, "y")}>Allow</button>
                {a.allowAlways && <button className="btn" onClick={() => answer(a.id, "a")}>Always allow</button>}
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
              if (palette.length > 0 && e.key === "ArrowDown") {
                e.preventDefault();
                setCmdSel((s) => (s + 1) % palette.length);
              } else if (palette.length > 0 && e.key === "ArrowUp") {
                e.preventDefault();
                setCmdSel((s) => (s - 1 + palette.length) % palette.length);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                if (palette.length > 0) setInput("");
                else if (running) void send({ type: "cancel" });
              }
            }}
          />
        </div>
        <div className="hints">
          <span><kbd>/</kbd> commands</span>
          <span><kbd>⏎</kbd> send</span>
          {running && <span><kbd>esc</kbd> interrupt · typed text steers the run</span>}
        </div>
      </div>
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.k) {
    case "user":
      return <div className="usermsg row"><span className="chev">❯</span>{item.text}</div>;
    case "text":
      return <div className="text row" dangerouslySetInnerHTML={md(item.text)} />;
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

function ToolRow({ item }: { item: Extract<Item, { k: "tool" }> }) {
  const fam = TOOL_FAMILY[item.tool] ?? "planx";
  const name = TOOL_DISPLAY[item.tool] ?? item.tool;
  const icon = TOOL_ICONS[item.tool] ?? "•";
  const first = item.out?.split("\n").filter((l) => l.trim())[0]?.slice(0, 120);
  return (
    <div className={`tool row ${fam}`}>
      <div className="head">
        <span className="icon">{icon}</span>
        <span className="name">{name}</span>
        {item.arg && <span className="arg">{item.arg}</span>}
        {item.pending && <span style={{ color: "var(--faint)", fontSize: 12 }}>…</span>}
      </div>
      {item.diff ? (
        <div className="card" style={{ margin: "6px 0 0 22px" }}>
          <div className="card-body" style={{ padding: "8px 0" }}>
            <Diff diff={item.diff} />
          </div>
        </div>
      ) : item.out && item.out.trim() ? (
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

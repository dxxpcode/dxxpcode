import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import type { Approval, Item, Plan, ReadyInfo, Todo } from "./types";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const push = (item: Item) => setItems((prev) => [...prev, item]);
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
    setInput("");
    void send({ type: "submit", text });
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

      <div className="composer">
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
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && running) {
                void send({ type: "cancel" });
              }
            }}
          />
        </div>
        <div className="hints">
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

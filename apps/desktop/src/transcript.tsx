import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { Item } from "./types";
import { TOOL_DISPLAY } from "./types";
import { md } from "./lib/markdown";

// Markdown is expensive (marked + highlight.js) — parse once per text value
// and let memo skip re-renders when the string hasn't changed.
export const Md = memo(function Md({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => md(text), [text]);
  return <div className={className} dangerouslySetInnerHTML={html} />;
});

function ItemViewImpl({ item, toolCount, onCmd }: { item: Item; toolCount?: number; onCmd?: (name: string) => void }) {
  switch (item.k) {
    case "user":
      return <div className="usermsg row">{item.text}</div>;
    case "text":
      return (
        <div className="reply row">
          <Md className="reply-body text" text={item.text} />
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
    case "plan": {
      const st = item.plan.stepStatus;
      const doneCount = st ? st.filter((s) => s === "completed").length : 0;
      const card = (
        <section className="reply reply-section plan row">
          <h2 className="reply-title">Plan{item.plan.amended && <span className="plan-amended">edited by you</span>}</h2>
          <div className="reply-body">
            {item.plan.summary && <p className="reply-intro">{item.plan.summary}</p>}
            <ol className="plan-steps">
              {item.plan.steps.map((s, i) => {
                const status = st?.[i];
                return (
                  <li
                    className={`plan-step${status === "completed" ? " done" : status === "in_progress" ? " active" : ""}`}
                    key={i}
                  >{s}</li>
                );
              })}
            </ol>
          </div>
        </section>
      );
      if (!item.plan.collapsed) return card;
      return (
        <details className="plan-fold row">
          <summary>
            <span className="plan-fold-title">Plan{item.plan.amended && <span className="plan-amended">edited by you</span>}</span>
            <span className="plan-fold-meta">
              {st ? `${doneCount}/${item.plan.steps.length} steps` : `${item.plan.steps.length} step${item.plan.steps.length === 1 ? "" : "s"}`}
              {item.plan.summary ? ` — ${item.plan.summary}` : ""}
            </span>
          </summary>
          {card}
        </details>
      );
    }
    case "replan":
      return (
        <div className="build-cue row">
          <button className="build-btn" onClick={() => onCmd?.("replan")}>Re-plan</button>
          <span className="build-hint">runs the same task through planning again</span>
        </div>
      );
    case "build":
      return (
        <div className="build-cue row">
          <button className="build-btn" onClick={() => onCmd?.("build")}>Build this plan</button>
          <span className="build-hint">runs the approved steps · saved to .dxxpcode/plan.md</span>
        </div>
      );
    case "todos":
      return (
        <section className="reply reply-section todos row">
          <h2 className="reply-title">Tasks</h2>
          <ul className="todo-list reply-body">
            {item.items.map((t, i) => (
              <li className={`todo-item ${t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : ""}`} key={i}>
                <span className="mark">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○"}</span>
                <span className="lbl">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
              </li>
            ))}
          </ul>
        </section>
      );
    case "table":
      return (
        <section className="reply reply-section row">
          {item.title && <h2 className="reply-title">{item.title}</h2>}
          <div className="reply-table reply-body">
            <table className="kv">
              <tbody>
                {item.rows.map(([k, v], i) => (
                  <tr key={i}><th scope="row" className="k">{k}</th><td className="v mono">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case "markdown":
      return (
        <section className="reply reply-section row">
          {item.title && <h2 className="reply-title">{item.title}</h2>}
          <Md className="reply-body text" text={item.text} />
        </section>
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
    case "error":
      return (
        <div className="errrow row">
          <span className="erricon">✗</span>
          <div className="errbody">
            <div>{item.text}</div>
            {item.hint && <div className="errhint">{item.hint}</div>}
            {item.detail && (
              <details className="errdetail"><summary>details</summary><pre>{item.detail}</pre></details>
            )}
          </div>
        </div>
      );
    case "denied":
      return <div className="note row" style={{ color: "var(--red)" }}>⎿ Denied: {item.reason} ({item.tool})</div>;
    case "checkpoint":
      return (
        <div className="ckpt row">
          <span className="ckpt-dot" />
          <span className="ckpt-label">Checkpoint {item.seq}</span>
          <span className="ckpt-meta">
            {item.paths.slice(0, 4).map((p) => <FileChip key={p} path={p} />)}
            {item.paths.length > 4 && <span className="ckpt-more">+{item.paths.length - 4}</span>}
          </span>
          {onCmd && (
            <span className="ckpt-acts">
              <button className="ckpt-act" onClick={() => onCmd("/undo")}>Restore</button>
              <button className="ckpt-act" onClick={() => onCmd("/review")}>Review</button>
            </span>
          )}
        </div>
      );
    case "done": {
      const ok = item.status === "completed";
      const cancelled = item.status === "cancelled";
      const fail = item.status === "error" || item.status === "failed";
      const meta = [
        toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : null,
        item.filesChanged.length > 0 ? `${item.filesChanged.length} file${item.filesChanged.length === 1 ? "" : "s"}` : null,
        item.tokens ? fmtK(item.tokens) + " tok" : null,
      ].filter(Boolean).join(" · ");
      const label = ok ? "Worked" : cancelled ? "Stopped" : fail ? "Failed" : item.status === "incomplete" ? "Incomplete" : item.status === "max_iterations" ? "Stopped at limit" : item.status;
      return (
        <div className={`worked row${ok ? "" : cancelled ? " stop" : fail ? " fail" : " warn"}`}>
          <span className="worked-dot" />
          <span className="worked-label">{label}{item.secs != null ? ` for ${fmtDuration(item.secs)}` : ""}</span>
          {meta && <span className="meta">{meta}</span>}
          {item.filesChanged.length > 0 && (
            <div className="fchips">
              {item.filesChanged.map((f) => <FileChip key={f} path={f} />)}
            </div>
          )}
        </div>
      );
    }
    case "raw":
      return <div className="note row mono">{item.text}</div>;
  }
}

// Item objects keep their identity across `setItems` appends, so memo
// skips every row except the one still streaming.
export const ItemView = memo(ItemViewImpl);

const Chevron = (
  <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
);


function fmtDuration(secs: number) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
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

const FILE_ARG_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "delete_file", "list_directory", "search_files", "git_diff",
]);

function toolLabel(it: Extract<Item, { k: "tool" }>): string {
  const name = TOOL_DISPLAY[it.tool] ?? it.tool;
  const a = it.arg.trim();
  if (!a) return name;
  const tail = FILE_ARG_TOOLS.has(it.tool) ? (a.split("/").pop() ?? a) : a.split(/\s+/).slice(0, 3).join(" ");
  return `${name} ${tail.length > 26 ? tail.slice(0, 25) + "…" : tail}`;
}

function TGroupImpl({ seg, running, lastIdx, onCmd }: { seg: Grouped[]; running: boolean; lastIdx: number; onCmd?: (name: string) => void }) {
  const anyPending = seg.some((g) => g.item.k === "tool" && g.item.pending);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(anyPending || seg.length === 1);
  }, [anyPending, seg.length]);
  // A single tool stays as one quiet line; a finished run collapses to "N tools".
  if (seg.length === 1) {
    const it = seg[0];
    return (
      <div className="tgroup">
        <ItemView item={it.item} onCmd={onCmd} />
      </div>
    );
  }
  const tools = seg.map((g) => g.item as Extract<Item, { k: "tool" }>);
  const preview = tools.slice(0, 3).map(toolLabel).join(" · ") + (tools.length > 3 ? ` · +${tools.length - 3}` : "");
  return (
    <div className="tgroup">
      <button
        className="tg-summary"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`tg-dot${anyPending ? " live" : ""}`} />{seg.length} tools<span className="tg-preview">{preview}</span>
      </button>
      {open && (
        <div className="tg-body">
          {seg.map((it) => (
            <ItemView key={it.idx} item={it.item} onCmd={onCmd} />
          ))}
        </div>
      )}
    </div>
  );
}

// Grouped wrappers are rebuilt on every render — compare by item identity
// so finished groups don't re-render while siblings stream.
export const TGroup = memo(TGroupImpl, (a, b) =>
  a.running === b.running &&
  a.lastIdx === b.lastIdx &&
  a.onCmd === b.onCmd &&
  a.seg.length === b.seg.length &&
  a.seg.every((g, i) => g.idx === b.seg[i].idx && g.item === b.seg[i].item),
);

function FileChip({ path }: { path: string }) {
  const base = path.split("/").pop() ?? path;
  const dir = path.slice(0, path.length - base.length);
  return (
    <button
      className="fchip"
      title={`${path} — click to copy`}
      onClick={() => void navigator.clipboard.writeText(path)}
    >
      <span className="dc-path">
        <span className="dc-base">{base}</span>
        {dir && <span className="dc-dir">{dir}</span>}
      </span>
    </button>
  );
}

function ToolRow({ item }: { item: Extract<Item, { k: "tool" }> }) {
  const name = TOOL_DISPLAY[item.tool] ?? item.tool;
  const first = item.out?.split("\n").filter((l) => l.trim())[0]?.slice(0, 120);
  // While running, show the tail of the streamed output; once finished it
  // collapses into the usual details/summary.
  const tail = item.pending && item.out?.trim()
    ? item.out.trimEnd().split("\n").slice(-6).join("\n")
    : null;
  const dstat = item.diff ? diffStats(item.diff) : null;
  return (
    <div className={`tool row${item.isError ? " err" : ""}`}>
      <div className="head">
        <span className="tsym" aria-hidden>{item.pending ? "·" : item.isError ? "×" : "✓"}</span>
        <span className="name">{name}</span>
        {item.arg && <span className="arg">{item.arg}</span>}
        {dstat && (dstat.add > 0 || dstat.del > 0) && (
          <span className="tstat"><span className="ds-add">+{dstat.add}</span><span className="ds-del">−{dstat.del}</span></span>
        )}
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

type Grouped = { idx: number; item: Item };

// Turn = a user prompt plus everything until the next one — rendered in a
// `.turn` wrapper so prompts read as separators and whitespace does the
// grouping, Codex-style.
export function groupTurns(segs: (Grouped | Grouped[])[]): (Grouped | Grouped[])[][] {
  const turns: (Grouped | Grouped[])[][] = [[]];
  for (const s of segs) {
    if (!Array.isArray(s) && s.item.k === "user") turns.push([]);
    turns[turns.length - 1].push(s);
  }
  return turns.filter((t) => t.length > 0);
}

export function groupItems(items: Item[]): (Grouped | Grouped[])[] {
  const segs: (Grouped | Grouped[])[] = [];
  items.forEach((item, idx) => {
    const last = segs[segs.length - 1];
    if (item.k === "tool") {
      if (Array.isArray(last)) last.push({ idx, item });
      else segs.push([{ idx, item }]);
    } else {
      segs.push({ idx, item });
    }
  });
  return segs;
}

const SUMMARY_CLAMP_LINES = 6;

// Plan approval body: summary + editable step list. Steps are borderless
// inputs (rail-rename style); the user's edited steps ride back on the
// approve message.
export function PlanApproval({
  summary,
  steps,
  extraChoice,
  onAnswer,
}: {
  summary: string;
  steps: string[];
  extraChoice?: { choice: string; label: string };
  onAnswer: (choice: string, steps: string[]) => void;
}) {
  const [edited, setEdited] = useState<string[]>(steps);
  const finalSteps = () => edited.map((s) => s.trim()).filter(Boolean);
  return (
    <>
      <div className="dec-body">
        {summary && <Md className="plan-summary text" text={summary} />}
        <ol className="plan-edit">
          {edited.map((s, i) => (
            <li className="plan-edit-row" key={i}>
              <input
                className="plan-edit-input"
                value={s}
                placeholder="Describe the step…"
                aria-label={`Plan step ${i + 1}`}
                onChange={(e) => setEdited((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                className="plan-edit-del"
                aria-label={`Remove step ${i + 1}`}
                title="Remove step"
                onClick={() => setEdited((cur) => cur.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
        <button className="plan-edit-add" onClick={() => setEdited((cur) => [...cur, ""])}>+ add step</button>
      </div>
      <div className="dec-acts">
        <button className="pill allow" onClick={() => onAnswer("y", finalSteps())}>Approve plan</button>
        <button className="pill deny" onClick={() => onAnswer("n", [])}>Deny</button>
        {extraChoice && <span className="dec-sep" />}
        {extraChoice && (
          <button className="pill ghost" onClick={() => onAnswer(extraChoice.choice, finalSteps())}>
            {extraChoice.label}
          </button>
        )}
      </div>
    </>
  );
}

export function ApprovalSummary({ text, kind }: { text: string; kind: "plan" | "tool" }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > SUMMARY_CLAMP_LINES + 2;
  return (
    <div className={`summary-md${long && !open ? " clamped" : ""}`}>
      <div className="summary-cap">{kind === "plan" ? "Plan" : "Command"}</div>
      <Md className="text" text={text} />
      {long && (
        <button className="summary-more" onClick={() => setOpen((v) => !v)}>
          {open ? "show less" : `show ${text.split("\n").length - SUMMARY_CLAMP_LINES} more lines`}
        </button>
      )}
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

type DiffRow = { cls: string; line: string; sign: string; text: string; chg?: [number, number] };

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
      const a = dels[n].text, b = adds[n].text;
      let pre = 0;
      while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
      let suf = 0;
      while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      if (a.length - pre - suf > 0) dels[n].chg = [pre, a.length - suf];
      if (b.length - pre - suf > 0) adds[n].chg = [pre, b.length - suf];
    }
    i = k;
  }
}

function DiffImpl({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const rows: DiffRow[] = [];
  let oldN = 0, newN = 0;
  for (const l of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)$/.exec(l);
    if (h) {
      oldN = Number(h[1]); newN = Number(h[2]);
      rows.push({ cls: "hunk", line: "", sign: "", text: h[3]?.trim() ? `in ${h[3].trim()}` : "Changes" });
    } else if (l.startsWith("@@")) {
      rows.push({ cls: "hunk", line: "", sign: "", text: "Changes" });
    } else if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) {
      continue;
    } else if (l.startsWith("+")) {
      rows.push({ cls: "add", line: newN ? String(newN++) : "", sign: "+", text: l.slice(1) });
    } else if (l.startsWith("-")) {
      rows.push({ cls: "del", line: oldN ? String(oldN++) : "", sign: "−", text: l.slice(1) });
    } else if (l.startsWith("\\")) {
      rows.push({ cls: "note", line: "", sign: "", text: l });
    } else if (oldN > 0 || newN > 0) {
      const line = newN ? String(newN) : String(oldN);
      if (oldN) oldN++;
      if (newN) newN++;
      rows.push({ cls: "ctx", line, sign: "", text: l.startsWith(" ") ? l.slice(1) : l });
    }
  }
  wordChanges(rows);
  // Fold long runs of context lines (keep head+tail, collapse the middle).
  const FOLD_KEEP = 2;
  const view: (DiffRow | { fold: number })[] = [];
  let n = 0;
  while (n < rows.length) {
    if (rows[n].cls === "ctx" && rows[n].line) {
      let m = n;
      while (m < rows.length && rows[m].cls === "ctx" && rows[m].line) m++;
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
    const body = r.chg
      ? <>{syntaxSpans(r.text.slice(0, r.chg[0]))}<mark className="chg">{syntaxSpans(r.text.slice(r.chg[0], r.chg[1]))}</mark>{syntaxSpans(r.text.slice(r.chg[1]))}</>
      : syntaxSpans(r.text);
    return <span className="code">{body}</span>;
  };
  return (
    <div className="diff">
      {view.map((r, i) =>
        "fold" in r ? (
          <button className="ln fold" key={i} onClick={() => setExpanded(true)}>
            <span className="gutter" /><span className="sign" /><span>⋮ {r.fold} unchanged lines</span>
          </button>
        ) : r.cls === "hunk" ? (
          <div className="ln hunk" key={i}><span className="gutter" /><span className="hunkchip">{r.text}</span></div>
        ) : (
          <div className={`ln ${r.cls}`} key={i}>
            <span className="gutter">{r.line}</span>
            <span className="sign">{r.sign}</span>
            {renderText(r)}
          </div>
        ),
      )}
    </div>
  );
}

export const Diff = memo(DiffImpl);

const SYN_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*|\/\*.*\*\/|#(?!include)[^\n]*)|\b(\d[\d_]*(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|import|from|export|default|class|extends|new|this|self|struct|enum|fn|pub|use|impl|trait|def|print|None|True|False|null|undefined|async|await|try|catch|except|finally|match|mod|type|interface|static|void|int|float|str|bool|mut|ref|move|where|in|is|and|or|not)\b/g;

function syntaxSpans(text: string) {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(SYN_RE)) {
    const i = m.index!;
    if (i > last) out.push(text.slice(last, i));
    const cls = m[1] ? "syn-str" : m[2] ? "syn-com" : m[3] ? "syn-num" : "syn-kw";
    out.push(<span key={k++} className={cls}>{m[0]}</span>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 442 270" fill="currentColor" role="img" aria-label="DxxpCode" className={className}>
      <path pathLength={1000} d="M0 0L95 135L0 270H66L257 0H191L128.5 88L66 0ZM375 0L185.5 270H252L314 183L375.5 270H441L347 135L441.5 0ZM267 23L234 70L272 123.5L305.5 76.5ZM171 148L138 195L176 248.5L209.5 201.5Z" />
    </svg>
  );
}


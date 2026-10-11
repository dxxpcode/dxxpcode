import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";

export const EFFORT_AUTO = "auto (Jev)";
const EFFORTS: { id: string; label: string; bars: 1 | 2 | 3; hint: string }[] = [
  { id: "default", label: "Default", bars: 1, hint: "provider default" },
  { id: "minimal", label: "Minimal", bars: 1, hint: "fastest, least thinking" },
  { id: "low", label: "Low", bars: 1, hint: "light reasoning" },
  { id: "medium", label: "Medium", bars: 2, hint: "balanced" },
  { id: "high", label: "High", bars: 2, hint: "deeper reasoning" },
  { id: "xhigh", label: "Extra high", bars: 3, hint: "near maximum" },
  { id: "max", label: "Max", bars: 3, hint: "most reasoning" },
];

function providerOf(model: string): { name: string; color: string } {
  const m = model.toLowerCase();
  if (/claude|anthropic|sonnet|opus|haiku/.test(m)) return { name: "Anthropic", color: "#d98a63" };
  if (/gpt|openai|codex/.test(m) || /^o\d/.test(m)) return { name: "OpenAI", color: "#4ade80" };
  if (/gemini|google/.test(m)) return { name: "Google", color: "#60a5fa" };
  if (/deepseek/.test(m)) return { name: "DeepSeek", color: "#c084fc" };
  return { name: "Other", color: "var(--faint)" };
}

function effortOf(effort: string): { bars: number; auto: boolean; label: string } {
  if (effort === EFFORT_AUTO) return { bars: 3, auto: true, label: "auto" };
  const e = EFFORTS.find((x) => x.id === effort);
  return e ? { bars: e.bars, auto: false, label: e.id } : { bars: 1, auto: false, label: effort };
}

function Bars({ on, auto = false }: { on: number; auto?: boolean }) {
  return (
    <span className={`mp-bars${auto ? " auto" : ""}`} aria-hidden="true">
      {[0, 1, 2].map((i) => <i key={i} className={i < on ? "on" : ""} />)}
    </span>
  );
}

/** Shared popover behaviour: outside click + Escape close, arrow-key listbox nav. */
function usePopover(open: boolean, close: () => void, count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  useEffect(() => { if (!open) setActive(0); }, [open]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      setActive((i) => e.key === "Home" ? 0 : e.key === "End" ? count - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + count) % count);
    }
  };
  return { ref, active, setActive, onKeyDown };
}

function ModelMenu({ model, modelOpts, variant, disabled, onOpen, onModel }: {
  model: string; modelOpts: string[]; variant?: string; disabled?: boolean;
  onOpen?: () => void; onModel: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const opts = Array.from(new Set([...(modelOpts.length ? modelOpts : [model]), model]));
    const rows = q ? opts.filter((o) => o.toLowerCase().includes(q)) : opts;
    const order: string[] = [];
    const byProv = new Map<string, { color: string; rows: string[] }>();
    for (const o of rows) {
      const p = providerOf(o);
      if (!byProv.has(p.name)) { byProv.set(p.name, { color: p.color, rows: [] }); order.push(p.name); }
      byProv.get(p.name)!.rows.push(o);
    }
    return order.map((name) => ({ name, ...byProv.get(name)! }));
  }, [model, modelOpts, query]);

  const flat = groups.flatMap((g) => g.rows);
  const { ref: menuRef, active: act, setActive: setAct, onKeyDown: menuKeys } = usePopover(open, close, flat.length);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { rowRefs.current[Math.min(act, flat.length - 1)]?.focus(); }, [act, flat.length, open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <div className="mp" ref={menuRef} onKeyDown={menuKeys}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button ref={triggerRef} type="button" className="mp-btn mp-model-btn"
        aria-label={`Model: ${model}`} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? id : undefined} title={`Model: ${model}`}
        data-open={open || undefined} disabled={disabled}
        onClick={() => { if (open) close(); else { setQuery(""); setOpen(true); onOpen?.(); } }}>
        <span className="mp-dot" style={{ background: providerOf(model).color }} />
        <span className="mp-name">{model}</span>
        <ChevronDown size={11} className="mp-caret" />
      </button>
      {open && (
        <div className="mp-menu" id={id} role="listbox" aria-label="Model">
          <div className="mp-search">
            <Search size={11} className="mp-search-icon" />
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const pick = flat[act] ?? flat[0]; if (pick) { close(); onModel(pick); } } }}
              placeholder="Search models" aria-label="Filter models" spellCheck={false} />
          </div>
          <div className="mp-list">
            {flat.length === 0 && <div className="mp-empty">No models match “{query}”</div>}
            {groups.map((g) => (
              <div key={g.name} className="mp-group">
                <div className="mp-group-label">{g.name}</div>
                {g.rows.map((o) => {
                  const i = flat.indexOf(o);
                  return (
                    <button key={o} ref={(el) => { rowRefs.current[i] = el; }} type="button" role="option"
                      tabIndex={i === act ? 0 : -1} aria-selected={o === model}
                      className={`mp-row${o === model ? " cur" : ""}`}
                      onFocus={() => setAct(i)}
                      onClick={() => { close(); onModel(o); }}>
                      <span className="mp-check">{o === model ? <Check size={11} /> : null}</span>
                      <span className="mp-dot" style={{ background: providerOf(o).color }} />
                      <span className="mp-row-name">{o}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="mp-hr" />
            <button type="button" className="mp-row" role="option" aria-selected={false}
              onClick={() => { close(); onModel("custom…"); }}>
              <span className="mp-check" />
              <span className="mp-row-name mp-dim">custom…</span>
            </button>
            {variant && <div className="mp-foot">variant · {variant}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function EffortMeter({ effort, disabled, onEffort }: {
  effort: string; disabled?: boolean; onEffort: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const cur = effortOf(effort);
  const opts = [...EFFORTS.map((e) => e.id), EFFORT_AUTO];
  const { ref, active, setActive, onKeyDown } = usePopover(open, close, opts.length);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { rowRefs.current[Math.min(active, opts.length - 1)]?.focus(); }, [active, open, opts.length]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <div className="mp" ref={ref} onKeyDown={onKeyDown}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button ref={triggerRef} type="button" className="mp-btn mp-meter-btn"
        aria-label={`Reasoning effort: ${cur.label}`} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? id : undefined} title={`Reasoning effort: ${cur.label}`}
        data-open={open || undefined} disabled={disabled}
        onClick={() => open ? close() : setOpen(true)}>
        <Bars on={cur.bars} auto={cur.auto} />
      </button>
      {open && (
        <div className="mp-menu mp-effort-menu" id={id} role="listbox" aria-label="Reasoning effort">
          <div className="mp-group-label">Reasoning effort</div>
          {EFFORTS.map((e, i) => (
            <button key={e.id} ref={(el) => { rowRefs.current[i] = el; }} type="button" role="option"
              tabIndex={i === active ? 0 : -1} aria-selected={e.id === effort}
              className={`mp-row${e.id === effort ? " cur" : ""}`}
              onFocus={() => setActive(i)}
              onClick={() => { close(); onEffort(e.id); }}>
              <span className="mp-check">{e.id === effort ? <Check size={11} /> : null}</span>
              <span className="mp-row-name">{e.label}<span className="mp-hint">{e.hint}</span></span>
              <Bars on={e.bars} />
            </button>
          ))}
          <div className="mp-hr" />
          <button ref={(el) => { rowRefs.current[opts.length - 1] = el; }} type="button" role="option"
            tabIndex={opts.length - 1 === active ? 0 : -1} aria-selected={effort === EFFORT_AUTO}
            className={`mp-row${effort === EFFORT_AUTO ? " cur" : ""}`}
            onFocus={() => setActive(opts.length - 1)}
            onClick={() => { close(); onEffort(EFFORT_AUTO); }}>
            <span className="mp-check">{effort === EFFORT_AUTO ? <Check size={11} /> : null}</span>
            <Sparkles size={11} className="mp-jev" />
            <span className="mp-row-name">Dynamic<span className="mp-hint">Jev routes effort</span></span>
            <Bars on={3} auto />
          </button>
        </div>
      )}
    </div>
  );
}

export function ModelPicker(props: {
  model: string; modelOpts: string[]; effort: string; variant?: string;
  disabled?: boolean; onOpen?: () => void; onModel: (v: string) => void; onEffort: (v: string) => void;
}) {
  return (
    <>
      <ModelMenu model={props.model} modelOpts={props.modelOpts} variant={props.variant}
        disabled={props.disabled} onOpen={props.onOpen} onModel={props.onModel} />
      <EffortMeter effort={props.effort} disabled={props.disabled} onEffort={props.onEffort} />
    </>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

export function SetSelect({ label, desc, value, options, extra, onChange, compact = false, disabled = false, onOpen }: { label: string; desc?: string; value: string; options: string[]; extra?: string[]; onChange: (v: string) => void; compact?: boolean; disabled?: boolean; onOpen?: () => void }) {
  const opts = Array.from(new Set([...options, value, ...(extra ?? [])]));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openMenu = () => {
    if (disabled) return;
    setActive(Math.max(0, opts.indexOf(value)));
    setOpen(true);
    onOpen?.();
  };
  const closeMenu = () => { setOpen(false); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  useEffect(() => {
    if (open) optionRefs.current[Math.min(active, opts.length - 1)]?.focus();
  }, [open, active, opts.length]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return (
    <div className={compact ? "composer-select" : "setrow static"} ref={ref}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          if (!open) openMenu();
          else setActive((i) => e.key === "Home" ? 0 : e.key === "End" ? opts.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length);
        }
      }}>
      {!compact && <span className="setlabel">{label}{desc && <span className="setdesc">{desc}</span>}</span>}
      <div className="setdd">
        <button ref={triggerRef} type="button" className="setdd-btn" aria-label={`${label}: ${value}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} title={`${label}: ${value}`} disabled={disabled} onClick={() => open ? closeMenu() : openMenu()}>
          <span className="setdd-val">{value}</span>
          <ChevronDown size={11} className="setdd-caret" />
        </button>
        {open && (
          <div className="setdd-menu" id={id} role="listbox" aria-label={label}>
            {opts.map((o, i) => (
              <button
                key={o}
                ref={(el) => { optionRefs.current[i] = el; }}
                type="button"
                role="option"
                tabIndex={i === active ? 0 : -1}
                aria-selected={o === value}
                className={`setdd-item${o === value ? " cur" : ""}`}
                onFocus={() => setActive(i)}
                onClick={() => { closeMenu(); onChange(o); }}
              >
                <span className="setdd-check">{o === value ? "✓" : ""}</span>
                {o}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


// One grouped control for "how the agent thinks": a `model · effort` trigger
// opening a single menu — models (with custom…) over a hairline divider over
// the effort levels. The current item gets a soft fill instead of a check.
export function ModelSelect({ model, effort, variant, models, efforts, disabled = false, onOpen, onModel, onEffort, onCustom }: {
  model: string; effort: string; variant?: string | null;
  models: string[]; efforts: string[];
  disabled?: boolean; onOpen?: () => void;
  onModel: (v: string) => void; onEffort: (v: string) => void; onCustom: () => void;
}) {
  const flat: { kind: "m" | "e"; v: string }[] = [
    ...Array.from(new Set([...models, model])).map((v) => ({ kind: "m" as const, v })),
    { kind: "m", v: "custom…" },
    ...efforts.map((v) => ({ kind: "e" as const, v })),
  ];
  const curIdx = flat.findIndex((o) => (o.kind === "m" ? o.v === model : o.v === effort));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openMenu = () => {
    if (disabled) return;
    setActive(Math.max(0, curIdx));
    setOpen(true);
    onOpen?.();
  };
  const closeMenu = () => { setOpen(false); triggerRef.current?.focus(); };
  const pick = (o: { kind: "m" | "e"; v: string }) => {
    closeMenu();
    if (o.kind === "e") onEffort(o.v);
    else if (o.v === "custom…") onCustom();
    else onModel(o.v);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  useEffect(() => {
    if (open) optionRefs.current[Math.min(active, flat.length - 1)]?.focus();
  }, [open, active, flat.length]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  let mi = 0; // flat index counter while rendering the models group
  const modelRows = flat.slice(0, flat.length - efforts.length);
  const effortRows = flat.slice(flat.length - efforts.length);

  return (
    <div className="composer-select msel" ref={ref}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          if (!open) openMenu();
          else setActive((i) => e.key === "Home" ? 0 : e.key === "End" ? flat.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
        }
      }}>
      <div className="setdd">
        <button ref={triggerRef} type="button" className="setdd-btn msel-btn" aria-label={`Model: ${model}, effort: ${effort}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} title={`${model} · ${effort}`} disabled={disabled} onClick={() => open ? closeMenu() : openMenu()}>
          <Sparkles size={11} className="msel-ico" aria-hidden="true" />
          <span className="setdd-val">{model}{variant && <span className="msel-var"> {variant}</span>} <span className="msel-dot">·</span> {effort}</span>
          <ChevronDown size={11} className={`setdd-caret${open ? " open" : ""}`} />
        </button>
        {open && (
          <div className="setdd-menu msel-menu" id={id} role="listbox" aria-label="Model and effort">
            <div className="msel-head">Model</div>
            {modelRows.map((o) => {
              const i = mi++;
              return (
                <button key={`m:${o.v}`} ref={(el) => { optionRefs.current[i] = el; }} type="button" role="option"
                  tabIndex={i === active ? 0 : -1} aria-selected={o.v === model}
                  className={`setdd-item msel-item${o.v === model ? " cur" : ""}`}
                  onFocus={() => setActive(i)} onClick={() => pick(o)}>
                  {o.v}
                </button>
              );
            })}
            <div className="msel-sep" aria-hidden="true" />
            <div className="msel-head">Effort</div>
            {effortRows.map((o) => {
              const i = mi++;
              return (
                <button key={`e:${o.v}`} ref={(el) => { optionRefs.current[i] = el; }} type="button" role="option"
                  tabIndex={i === active ? 0 : -1} aria-selected={o.v === effort}
                  className={`setdd-item msel-item${o.v === effort ? " cur" : ""}`}
                  onFocus={() => setActive(i)} onClick={() => pick(o)}>
                  {o.v}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

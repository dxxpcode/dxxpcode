import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { modelPickerOptions, modelPickerPosition } from "./lib/model-picker-layout";

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


export function ModelSelect({ model, effort, variant, models, efforts, disabled = false, onOpen, onModel, onEffort, onCustom }: {
  model: string; effort: string; variant?: string | null;
  models: string[]; efforts: string[];
  disabled?: boolean; onOpen?: () => void;
  onModel: (v: string) => void; onEffort: (v: string) => void; onCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeModel, setActiveModel] = useState(model);
  const [activeEffort, setActiveEffort] = useState(effort);
  const [position, setPosition] = useState<ReturnType<typeof modelPickerPosition> | null>(null);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const modelRefs = useRef(new Map<string, HTMLButtonElement>());
  const modelOptions = modelPickerOptions(models, model, query);
  const searchable = new Set([...models, model]).size > 8;
  const focusModel = modelOptions.includes(activeModel) ? activeModel : modelOptions[0];
  const effortOptions = Array.from(new Set([...efforts, effort]));
  const updatePosition = () => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (anchor) setPosition(modelPickerPosition(anchor, { width: window.innerWidth, height: window.innerHeight }));
  };
  const openMenu = () => {
    if (disabled) return;
    setQuery("");
    setActiveModel(model);
    setActiveEffort(effort);
    updatePosition();
    setOpen(true);
    onOpen?.();
  };
  const closeMenu = () => { setOpen(false); triggerRef.current?.focus(); };
  const navigateGroup = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length || current < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
      : (current + (["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);
  useEffect(() => {
    if (open) (searchRef.current ?? modelRefs.current.get(model))?.focus();
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <div className="msel" ref={ref}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        else if (!open && ["ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          openMenu();
        }
      }}>
      <button ref={triggerRef} type="button" className="msel-btn"
        aria-label={`Model: ${model}, reasoning effort: ${effort}${variant ? `, variant: ${variant}` : ""}`}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        title={`${model} · ${effort}${variant ? ` (${variant})` : ""}`}
        disabled={disabled} onClick={() => open ? closeMenu() : openMenu()}>
        <span className="msel-value">{model}</span>
        <span className="msel-effort"><span aria-hidden="true">·</span> {effort}</span>
        <ChevronDown size={11} className="msel-caret" aria-hidden="true" />
      </button>
      {open && position && (
        <div className="msel-menu" style={position} id={id} role="dialog" aria-label="Model and reasoning effort">
          <div className="msel-heading" id={`${id}-models`}>Model</div>
          {variant && <div className="msel-variant">Variant · {variant}</div>}
          {searchable && (
            <label className="msel-search">
              <Search size={13} aria-hidden="true" />
              <input ref={searchRef} aria-label="Search models" placeholder="Search models…" value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && modelOptions.length) {
                    e.preventDefault();
                    modelRefs.current.get(focusModel)?.focus();
                  }
                }} />
            </label>
          )}
          <div className="msel-models" role="radiogroup" aria-labelledby={`${id}-models`} onKeyDown={navigateGroup}>
            {modelOptions.map((name) => (
              <button key={name} ref={(el) => { if (el) modelRefs.current.set(name, el); else modelRefs.current.delete(name); }}
                type="button" role="radio" aria-checked={name === model} tabIndex={name === focusModel ? 0 : -1}
                className="msel-model" onFocus={() => setActiveModel(name)}
                onClick={() => { closeMenu(); onModel(name); }}>
                <span>{name}</span>
                {name === model && <Check size={13} aria-hidden="true" />}
              </button>
            ))}
            {!modelOptions.length && <div className="msel-empty">No matching models</div>}
          </div>
          <button type="button" className="msel-custom" onClick={() => { closeMenu(); onCustom(); }}>Custom model…</button>
          <div className="msel-footer">
            <div className="msel-heading" id={`${id}-effort`}>Reasoning effort</div>
            <div className="msel-segments" role="radiogroup" aria-labelledby={`${id}-effort`} aria-describedby={`${id}-hint`} onKeyDown={navigateGroup}>
              {effortOptions.map((level) => (
                <button key={level} type="button" role="radio" aria-checked={level === effort}
                  tabIndex={level === activeEffort ? 0 : -1} onFocus={() => setActiveEffort(level)}
                  onClick={() => onEffort(level)}>{level}</button>
              ))}
            </div>
            <p className="msel-hint" id={`${id}-hint`}>More reasoning can take longer.</p>
          </div>
        </div>
      )}
    </div>
  );
}

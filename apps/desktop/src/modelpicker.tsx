import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";

export const EFFORT_AUTO = "auto (Jev)";
const EFFORTS: { id: string; short: string }[] = [
  { id: "default", short: "def" },
  { id: "minimal", short: "min" },
  { id: "low", short: "low" },
  { id: "medium", short: "med" },
  { id: "high", short: "high" },
  { id: "xhigh", short: "xhi" },
  { id: "max", short: "max" },
];

function shortModel(model: string): string {
  const s = model.replace(/^(claude|gpt|gemini|deepseek)-/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortEffort(effort: string): string {
  if (effort === EFFORT_AUTO) return "auto";
  return EFFORTS.find((e) => e.id === effort)?.short ?? effort;
}

export function ModelPicker({ model, modelOpts, effort, variant, disabled, onOpen, onModel, onEffort }: {
  model: string; modelOpts: string[]; effort: string; variant?: string;
  disabled?: boolean; onOpen?: () => void;
  onModel: (v: string) => void; onEffort: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const effortBtnRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const opts = Array.from(new Set([...(modelOpts.length ? modelOpts : [model]), model]));
  const openMenu = () => { if (disabled) return; setActive(Math.max(0, opts.indexOf(model))); setOpen(true); onOpen?.(); };
  const closeMenu = (focus?: "model" | "effort") => {
    setOpen(false);
    (focus === "effort" ? effortBtnRef : modelBtnRef).current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  useEffect(() => { if (open) rowRefs.current[Math.min(active, opts.length - 1)]?.focus(); }, [open, active, opts.length]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <span className="mp" ref={ref}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        else if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && (e.target as HTMLElement).closest(".mp-models")) {
          e.preventDefault();
          setActive((i) => e.key === "Home" ? 0 : e.key === "End" ? opts.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length);
        }
      }}>
      <button ref={modelBtnRef} type="button" className="mp-word"
        aria-label={`Model: ${model}`} aria-haspopup="listbox" aria-expanded={open}
        title={`Model: ${model}`} disabled={disabled} onClick={openMenu}>
        {shortModel(model)}
      </button>
      <span className="mp-sep" aria-hidden="true">·</span>
      <button ref={effortBtnRef} type="button" className="mp-word mp-word-effort"
        aria-label={`Reasoning effort: ${effort}`} aria-haspopup="listbox" aria-expanded={open}
        title={`Reasoning effort: ${effort}`} disabled={disabled} onClick={openMenu}>
        {shortEffort(effort)}
      </button>
      {open && (
        <div className="mp-menu" id={id} role="listbox" aria-label="Model and effort">
          <div className="mp-sec">Model</div>
          <div className="mp-models">
            {opts.map((o, i) => (
              <button key={o} ref={(el) => { rowRefs.current[i] = el; }} type="button" role="option"
                tabIndex={i === active ? 0 : -1} aria-selected={o === model}
                className={`mp-opt${o === model ? " cur" : ""}`}
                onFocus={() => setActive(i)}
                onClick={() => { closeMenu("model"); onModel(o); }}>
                <span className="mp-check">{o === model ? <Check size={11} /> : null}</span>
                {o}
              </button>
            ))}
            <button type="button" role="option" aria-selected={false}
              className="mp-opt mp-opt-dim"
              onClick={() => { closeMenu("model"); onModel("custom…"); }}>
              <span className="mp-check" />custom…
            </button>
          </div>
          <div className="mp-sec">Effort</div>
          <div className="mp-seg" role="group" aria-label="Reasoning effort">
            {EFFORTS.map((e) => (
              <button key={e.id} type="button"
                className={`mp-seg-btn${e.id === effort ? " cur" : ""}`}
                aria-pressed={e.id === effort}
                onClick={() => onEffort(e.id)}>
                {e.short}
              </button>
            ))}
          </div>
          <button type="button" className={`mp-opt mp-auto${effort === EFFORT_AUTO ? " cur" : ""}`}
            aria-pressed={effort === EFFORT_AUTO}
            onClick={() => onEffort(EFFORT_AUTO)}>
            <span className="mp-check">{effort === EFFORT_AUTO ? <Check size={11} /> : null}</span>
            auto — Jev routes
          </button>
          {variant && <div className="mp-foot">variant · {variant}</div>}
        </div>
      )}
    </span>
  );
}

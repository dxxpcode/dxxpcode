import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";

export const EFFORT_STOPS = ["default", "minimal", "low", "medium", "high", "xhigh", "max"];
export const EFFORT_AUTO = "auto (Jev)";
const EFFORT_CYCLE = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_SHORT: Record<string, string> = {
  default: "def", minimal: "min", low: "low", medium: "med",
  high: "high", xhigh: "xhigh", max: "max", [EFFORT_AUTO]: "auto",
};

function providerColor(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return "#d98a63";
  if (m.includes("gpt") || m.includes("openai") || m.includes("codex") || /^o\d/.test(m)) return "#4ade80";
  if (m.includes("gemini") || m.includes("google")) return "#60a5fa";
  if (m.includes("deepseek")) return "#c084fc";
  return "var(--faint)";
}

function effortFraction(effort: string): number {
  const i = EFFORT_STOPS.indexOf(effort);
  return i < 0 ? 1 : i / (EFFORT_STOPS.length - 1);
}

function nextEffort(effort: string): string {
  const i = EFFORT_CYCLE.indexOf(effort);
  return EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length];
}

export function ModelPicker({
  model, modelOpts, effort, variant, disabled, onOpen, onModel, onEffort,
}: {
  model: string;
  modelOpts: string[];
  effort: string;
  variant?: string;
  disabled?: boolean;
  onOpen?: () => void;
  onModel: (v: string) => void;
  onEffort: (v: string) => void;
}) {
  const auto = effort === EFFORT_AUTO;
  const opts = Array.from(new Set([...(modelOpts.length ? modelOpts : [model]), model]));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const openMenu = () => {
    if (disabled) return;
    setActive(Math.max(0, opts.indexOf(model)));
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

  const frac = effortFraction(effort);
  const dialStyle = {
    "--mp-a": `${Math.round((auto ? 1 : frac) * 360)}deg`,
    "--mp-c": auto ? "var(--purple)" : "var(--text)",
  } as React.CSSProperties;

  return (
    <div className={`mpicker${open ? " open" : ""}`} ref={ref}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); closeMenu(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && open) {
          e.preventDefault();
          setActive((i) => e.key === "Home" ? 0 : e.key === "End" ? opts.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length);
        }
      }}>
      <div className={`mp-chip${disabled ? " off" : ""}`}>
        <button
          ref={triggerRef}
          type="button"
          className="mp-model"
          aria-label={`Model: ${model}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          title={`Model: ${model}`}
          disabled={disabled}
          onClick={() => open ? closeMenu() : openMenu()}
        >
          <span className="mp-dot" style={{ background: providerColor(model) }} />
          <span className="mp-name">{model}</span>
          <ChevronDown size={11} className={`mp-caret${open ? " flip" : ""}`} />
        </button>
        <span className="mp-sep" aria-hidden />
        <button
          type="button"
          className={`mp-eff${auto ? " auto" : ""}`}
          aria-label={`Reasoning effort: ${effort}. Activate to cycle.`}
          title={`Effort: ${effort} — click to cycle`}
          disabled={disabled}
          onClick={() => onEffort(nextEffort(effort))}
        >
          <span className="mp-dial" style={dialStyle}><span className="mp-dial-core" /></span>
          <span className="mp-eff-label">{EFFORT_SHORT[effort] ?? effort}</span>
        </button>
      </div>
      {open && (
        <div className="mp-pop" id={id} role="dialog" aria-label="Model and effort">
          <div className="mp-sec">Reasoning effort</div>
          <div className={`mp-slider${auto ? " auto" : ""}`} role="radiogroup" aria-label="Reasoning effort">
            <div className="mp-track">
              <div className="mp-rail" />
              <div className="mp-fill" style={{ width: `${frac * 100}%` }} />
              <div className="mp-stops">
                {EFFORT_STOPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={s === effort}
                    className={`mp-stop${s === effort ? " on" : ""}`}
                    title={s}
                    disabled={auto}
                    onClick={() => onEffort(s)}
                  />
                ))}
              </div>
            </div>
            <div className="mp-stoplabels">
              {EFFORT_STOPS.map((s) => (
                <span key={s} className={s === effort ? "on" : ""}>{EFFORT_SHORT[s] ?? s}</span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="mp-jev"
            role="switch"
            aria-checked={auto}
            onClick={() => onEffort(auto ? "default" : EFFORT_AUTO)}
          >
            <Sparkles size={11} className="mp-jev-ico" />
            <span className="mp-jev-text">auto — Jev routes effort</span>
            <span className={`mp-switch${auto ? " on" : ""}`}><span className="mp-switch-dot" /></span>
          </button>
          <div className="mp-hr" />
          <div className="mp-sec">Model</div>
          <div className="mp-models" role="listbox" aria-label="Model">
            {opts.map((o, i) => (
              <button
                key={o}
                ref={(el) => { optionRefs.current[i] = el; }}
                type="button"
                role="option"
                tabIndex={i === active ? 0 : -1}
                aria-selected={o === model}
                className={`mp-mrow${o === model ? " cur" : ""}`}
                onFocus={() => setActive(i)}
                onClick={() => { closeMenu(); onModel(o); }}
              >
                <span className="mp-dot" style={{ background: providerColor(o) }} />
                <span className="mp-mname">{o}</span>
                <span className="mp-check">{o === model ? <Check size={12} /> : null}</span>
              </button>
            ))}
            <button
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={false}
              className="mp-mrow custom"
              onClick={() => { closeMenu(); onModel("custom…"); }}
            >
              <span className="mp-dot" style={{ background: "transparent" }} />
              <span className="mp-mname">custom…</span>
              <span className="mp-check" />
            </button>
          </div>
          {variant && <div className="mp-foot">variant · {variant}</div>}
        </div>
      )}
    </div>
  );
}

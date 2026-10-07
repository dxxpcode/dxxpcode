import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

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


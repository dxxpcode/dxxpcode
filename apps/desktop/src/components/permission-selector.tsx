import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { PERMISSION_OPTIONS, permissionMode } from "../lib/permission-mode";
import type { PermissionMode } from "../lib/permission-mode";
import { nextOption } from "../lib/composer-selector";

const ICONS = { ask: Shield, smart: ShieldCheck, "always-approve": ShieldAlert } as const;

export function PermissionSelector({ mode, disabled, onChange, onCommit }: {
  mode: string | undefined;
  disabled: boolean;
  onChange: (value: PermissionMode) => void;
  onCommit: () => void;
}) {
  const current = permissionMode(mode);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<PermissionMode>(current);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const option = PERMISSION_OPTIONS.find((o) => o.value === current)!;
  const Icon = ICONS[current];

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const toggle = () => {
    if (disabled) return;
    if (open) { close(); return; }
    setActive(current);
    setOpen(true);
  };
  const choose = (value: PermissionMode) => {
    close();
    if (value !== current) onChange(value);
    onCommit();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open) rows.current[PERMISSION_OPTIONS.findIndex((o) => o.value === active)]?.focus();
  }, [open, active]);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = PERMISSION_OPTIONS.findIndex((o) => o.value === active);
    const next = event.key === "Home" ? 0 : event.key === "End" ? PERMISSION_OPTIONS.length - 1
      : nextOption(index, PERMISSION_OPTIONS.length, event.key === "ArrowDown" ? 1 : -1);
    setActive(PERMISSION_OPTIONS[next].value);
  };

  return (
    <div className="permission-selector" ref={root}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}>
      <button ref={trigger} type="button"
        className={`permission-trigger${current === "always-approve" ? " full" : ""}`}
        disabled={disabled}
        title={disabled ? "Complete setup to change permissions" : `Permissions: ${option.label}`}
        aria-label={`Permissions: ${option.label}`}
        aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (!open) toggle(); }
        }}>
        <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
        <span>{option.short}</span>
        <ChevronDown size={12} aria-hidden="true" className={open ? "selector-chevron open" : "selector-chevron"} />
      </button>
      {open && !disabled && (
        <div className="selector-popover permission-popover" id={`${id}-panel`} role="dialog" aria-label="Permissions">
          <div className="selector-heading"><span>How should actions be approved?</span></div>
          <div className="selector-options" role="listbox" aria-label="Permission mode" onKeyDown={keys}>
            {PERMISSION_OPTIONS.map((o, index) => {
              const RowIcon = ICONS[o.value];
              return (
                <button key={o.value} ref={(element) => { rows.current[index] = element; }}
                  type="button" role="option" tabIndex={o.value === active ? 0 : -1}
                  aria-selected={o.value === current}
                  className={`selector-option permission-option${o.value === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(o.value)}
                  onFocus={() => setActive(o.value)}
                  onClick={() => choose(o.value)}>
                  <RowIcon size={15} strokeWidth={1.8} aria-hidden="true" className="permission-option-icon" />
                  <span className="permission-option-body">
                    <span className="selector-option-text">{o.label}</span>
                    <span className="permission-option-desc">{o.description}</span>
                  </span>
                  {o.value === current && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

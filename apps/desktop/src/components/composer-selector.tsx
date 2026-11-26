import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, CircleDashed, Search, SlidersHorizontal } from "lucide-react";
import { EFFORT_OPTIONS, displayModel, displayProvider, effortOption, filterModels, nextOption } from "../lib/composer-selector";
import { ProviderIcon, providerIconKey } from "./provider-icons";

function EffortMeter({ value }: { value: string }) {
  const { tier } = effortOption(value);
  if (!tier) return value === "auto (Jev)"
    ? <SlidersHorizontal size={15} aria-hidden="true" />
    : <CircleDashed size={15} aria-hidden="true" />;
  return (
    <svg className="selector-meter" width="21" height="16" viewBox="0 0 21 16" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <rect key={index} x={index * 3.5} y={12 - index * 2} width="2" height={4 + index * 2}
          rx="0.7" fill="currentColor" opacity={index < tier ? 1 : 0.2} />
      ))}
    </svg>
  );
}

export function ComposerSelector({
  model, models, provider, effort, disabled, disabledReason,
  onModelsOpen, onModelChange, onCustomModel, onEffortChange, onCommit,
}: {
  model: string;
  models: string[];
  provider: string;
  effort: string;
  disabled: boolean;
  disabledReason: string;
  onModelsOpen: () => void;
  onModelChange: (value: string) => void;
  onCustomModel: () => void;
  onEffortChange: (value: string) => void;
  onCommit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeModel, setActiveModel] = useState(model);
  const [activeEffort, setActiveEffort] = useState(effort);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelRows = useRef<(HTMLButtonElement | null)[]>([]);
  const effortRows = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const modelListId = `${id}-models`;
  const effortListId = `${id}-efforts`;
  const filtered = filterModels(models, model, query);
  const modelIndex = Math.max(0, filtered.indexOf(activeModel));
  const currentEffort = effortOption(effort);
  const options = EFFORT_OPTIONS.some((option) => option.value === effort)
    ? EFFORT_OPTIONS : [...EFFORT_OPTIONS, currentEffort];

  const toggle = () => {
    if (disabled) return;
    if (open) { setOpen(false); return; }
    setQuery("");
    setActiveModel(model);
    setActiveEffort(effort);
    onModelsOpen();
    setOpen(true);
  };
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const chooseModel = (value: string) => {
    if (disabled) return;
    close();
    if (value !== model) onModelChange(value);
    onCommit();
  };
  const chooseEffort = (value: string) => {
    if (disabled) return;
    close();
    if (value !== effort) onEffortChange(value);
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
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => {
    if (open) modelRows.current[modelIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, modelIndex, query, filtered.length]);

  const modelKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = nextOption(modelIndex, filtered.length, event.key === "ArrowDown" ? 1 : -1);
      if (index >= 0) setActiveModel(filtered[index]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filtered[modelIndex]) chooseModel(filtered[modelIndex]);
    }
  };
  const effortKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = options.findIndex((option) => option.value === activeEffort);
    const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : nextOption(current, options.length, event.key === "ArrowDown" ? 1 : -1);
    setActiveEffort(options[index].value);
  };

  return (
    <div className="composer-selector" ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}>
      <button ref={trigger} type="button" className="selector-unified"
        disabled={disabled}
        title={disabled ? disabledReason : `Model: ${model} · Reasoning effort: ${currentEffort.label}`}
        aria-label={`Model: ${model}, Reasoning effort: ${currentEffort.label}`}
        aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (!open) toggle(); }
        }}>
        <ProviderIcon icon={providerIconKey(provider, model)} />
        <span className="selector-model-name">{displayModel(model)}</span>
        <span className="selector-effort-name">{currentEffort.label}</span>
        <ChevronDown size={12} aria-hidden="true" className={open ? "selector-chevron open" : "selector-chevron"} />
      </button>
      {open && !disabled && (
        <div className="selector-popover selector-unified-popover" id={`${id}-panel`}
          role="dialog" aria-label="Choose model and reasoning effort">
          <div className="selector-heading"><span>Model</span>
            <span className="selector-provider" title={provider}>
              <ProviderIcon icon={providerIconKey(provider)} />{displayProvider(provider)}
            </span>
          </div>
          <div className="selector-search">
            <Search size={14} aria-hidden="true" />
            <input ref={search} value={query} placeholder="Search models…" aria-label="Search models"
              role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={modelListId}
              aria-activedescendant={filtered.length ? `${id}-model-${modelIndex}` : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveModel(filterModels(models, model, event.target.value)[0] ?? "");
              }}
              onKeyDown={modelKeys} />
          </div>
          <div className="selector-options selector-models" id={modelListId} role="listbox" aria-label="Models">
            {filtered.map((value, index) => (
              <button key={value} ref={(element) => { modelRows.current[index] = element; }}
                id={`${id}-model-${index}`} type="button" role="option" tabIndex={-1}
                aria-selected={value === model}
                className={`selector-option${index === modelIndex ? " active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveModel(value)} onClick={() => chooseModel(value)}>
                <ProviderIcon icon={providerIconKey(provider, value)} />
                <span className="selector-option-text">{displayModel(value)}</span>
                {value === model && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {!filtered.length && <div className="selector-empty" role="status">No matching models</div>}
          </div>
          <div className="selector-footer selector-footer-models">
            <button type="button" className="selector-custom" onClick={() => { close(); onCustomModel(); }}>
              Custom model… <span aria-hidden="true">↗</span>
            </button>
          </div>
          <div className="selector-heading selector-effort-heading"><span>Reasoning effort</span><span>Next task</span></div>
          <div className="selector-options selector-efforts" id={effortListId} role="listbox" aria-label="Reasoning effort" onKeyDown={effortKeys}>
            {options.map((option, index) => (
              <button key={option.value} ref={(element) => { effortRows.current[index] = element; }}
                type="button" role="option" tabIndex={option.value === activeEffort ? 0 : -1}
                aria-selected={option.value === effort}
                aria-label={`${option.label} — ${option.description}`}
                title={option.description}
                className={`selector-option selector-effort-row${option.value === "auto (Jev)" ? " selector-auto" : ""}`}
                onFocus={() => setActiveEffort(option.value)} onClick={() => chooseEffort(option.value)}>
                <span className="selector-option-meter"><EffortMeter value={option.value} /></span>
                <span className="selector-option-text">{option.label}</span>
                <span className="selector-effort-desc">{option.description}</span>
                {option.value === effort && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className="selector-footnote">Higher effort can take longer. Support varies by model.</div>
        </div>
      )}
    </div>
  );
}

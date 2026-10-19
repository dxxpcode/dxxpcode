import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { EFFORT_OPTIONS, effortOption, filterModels, modelLabel, nextOption, selectorPosition } from "../lib/composer-selector";

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
  const [open, setOpen] = useState<"model" | "effort" | null>(null);
  const [query, setQuery] = useState("");
  const [activeModel, setActiveModel] = useState(model);
  const [activeEffort, setActiveEffort] = useState(effort);
  const [position, setPosition] = useState<ReturnType<typeof selectorPosition>>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelRows = useRef<(HTMLButtonElement | null)[]>([]);
  const effortRows = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const filtered = filterModels(models, model, query);
  const modelIndex = Math.max(0, filtered.indexOf(activeModel));
  const currentEffort = effortOption(effort);
  const options = EFFORT_OPTIONS.some((option) => option.value === effort)
    ? EFFORT_OPTIONS : [...EFFORT_OPTIONS, currentEffort];

  const show = (category: "model" | "effort") => {
    if (disabled) return;
    if (category === "model") { setQuery(""); setActiveModel(model); onModelsOpen(); }
    else setActiveEffort(effort);
    setOpen(category);
  };
  const close = (restoreFocus = false) => {
    setOpen(null);
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (category: "model" | "effort", value: string) => {
    if (disabled) return;
    close();
    if (category === "model" && value !== model) onModelChange(value);
    if (category === "effort") onEffortChange(value);
    onCommit();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (trigger.current) setPosition(selectorPosition(trigger.current.getBoundingClientRect(), {
        width: window.innerWidth, height: window.innerHeight,
      }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);
  useEffect(() => { if (open === "model") search.current?.focus(); }, [open]);
  useEffect(() => {
    if (open === "model") modelRows.current[modelIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, modelIndex, query, filtered.length]);
  useEffect(() => {
    if (open === "effort") effortRows.current[options.findIndex((option) => option.value === activeEffort)]?.focus();
  }, [open, activeEffort, effort]);

  const modelKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = nextOption(modelIndex, filtered.length, event.key === "ArrowDown" ? 1 : -1);
      if (index >= 0) setActiveModel(filtered[index]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (filtered[modelIndex]) choose("model", filtered[modelIndex]);
    }
  };
  const effortKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = options.findIndex((option) => option.value === activeEffort);
    const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : nextOption(current, options.length, event.key === "ArrowDown" ? 1 : -1);
    setActiveEffort(options[index].value);
  };

  return (
    <div className="composer-selector" ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); close(true);
        }
      }}>
      <button ref={trigger} type="button" className="selector-trigger" disabled={disabled}
        title={disabled ? disabledReason : `${model} · Reasoning effort: ${currentEffort.label}`}
        aria-label={`Model settings: ${modelLabel(model)}, effort ${currentEffort.label}`}
        aria-haspopup="dialog" aria-expanded={!!open} aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => open ? close() : show("model")}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (!open) show("model"); }
        }}>
        <span className="selector-model-name">{modelLabel(model)}</span>
        <span className="selector-current-effort"><span aria-hidden="true">·</span>{currentEffort.label}</span>
        <ChevronDown size={12} aria-hidden="true" className={open ? "selector-chevron open" : "selector-chevron"} />
      </button>
      {open && !disabled && (
        <div className="selector-popover" id={`${id}-panel`} role="dialog" aria-label="Model settings" style={position}>
          <div className="selector-heading">
            <div className="selector-categories" role="group" aria-label="Setting category">
              <button type="button" className="selector-category" aria-pressed={open === "model"} onClick={() => show("model")}>Model</button>
              <button type="button" className="selector-category" aria-pressed={open === "effort"} onClick={() => show("effort")}>Effort</button>
            </div>
            <span className="selector-provider" title={provider}>{provider}</span>
          </div>
          {open === "model" ? <>
            <div className="selector-search">
              <Search size={14} aria-hidden="true" />
              <input ref={search} value={query} placeholder="Search models…" aria-label="Search models"
                role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-models`}
                aria-activedescendant={filtered.length ? `${id}-model-${modelIndex}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveModel(filterModels(models, model, event.target.value)[0] ?? "");
                }} onKeyDown={modelKeys} />
            </div>
            <div className="selector-options" id={`${id}-models`} role="listbox" aria-label="Models">
              {filtered.map((value, index) => (
                <button key={value} ref={(element) => { modelRows.current[index] = element; }}
                  id={`${id}-model-${index}`} type="button" role="option" tabIndex={-1}
                  aria-selected={value === model} className={`selector-option${index === modelIndex ? " active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveModel(value)}
                  onClick={() => choose("model", value)}>
                  <span className="selector-option-copy"><span className="selector-option-text">{modelLabel(value)}</span>
                    {modelLabel(value) !== value && <span className="selector-model-id">{value}</span>}
                  </span>
                  {value === model && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {!filtered.length && <div className="selector-empty" role="status">No matching models</div>}
            <div className="selector-footer">
              <button type="button" className="selector-custom" onClick={() => { close(); onCustomModel(); }}>
                Custom model… <span aria-hidden="true">↗</span>
              </button>
            </div>
          </> : <>
            <div className="selector-options" role="listbox" aria-label="Reasoning effort" onKeyDown={effortKeys}>
              {options.map((option, index) => (
                <button key={option.value} ref={(element) => { effortRows.current[index] = element; }}
                  type="button" role="option" tabIndex={option.value === activeEffort ? 0 : -1}
                  aria-selected={option.value === effort}
                  className={`selector-option selector-effort-option${option.value === "auto (Jev)" ? " selector-auto" : ""}`}
                  onFocus={() => setActiveEffort(option.value)} onClick={() => choose("effort", option.value)}>
                  <span className="selector-option-copy"><span className="selector-option-text">{option.label}</span>
                    <span className="selector-description">{option.description}</span>
                  </span>
                  {option.value === effort && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <div className="selector-footnote">Higher effort can take longer. Support varies by model.</div>
          </>}
        </div>
      )}
    </div>
  );
}

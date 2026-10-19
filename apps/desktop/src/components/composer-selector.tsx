import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { ModelInfo } from "../types";
import { availableEffortOptions, filterModels, modelLabel, nextOption, selectedEffort } from "../lib/composer-selector";

type View = "overview" | "model" | "effort";

export function ComposerSelector({
  model, modelInfo, models, provider, effort, effortChoices, disabled, disabledReason,
  onModelsOpen, onModelChange, onCustomModel, onEffortChange, onCommit,
}: {
  model: string;
  modelInfo?: ModelInfo;
  models: ModelInfo[];
  provider: string;
  effort: string;
  effortChoices?: string[];
  disabled: boolean;
  disabledReason: string;
  onModelsOpen: () => void;
  onModelChange: (value: string) => void;
  onCustomModel: () => void;
  onEffortChange: (value: string) => void;
  onCommit: () => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState("");
  const [activeModel, setActiveModel] = useState(model);
  const [activeEffort, setActiveEffort] = useState(effort);
  const [overviewIndex, setOverviewIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const overviewRows = useRef<(HTMLButtonElement | null)[]>([]);
  const modelRows = useRef<(HTMLButtonElement | null)[]>([]);
  const effortRows = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const names = Object.fromEntries([...models, ...(modelInfo ? [modelInfo] : [])].map((info) => [info.id, info.displayName ?? info.id]));
  const name = modelLabel(model, names[model]);
  const filtered = filterModels(models.map((info) => info.id), model, query, names);
  const modelIndex = Math.max(0, filtered.indexOf(activeModel));
  const options = availableEffortOptions(effortChoices);
  const currentEffort = selectedEffort(effort, effortChoices);
  const effortIndex = Math.max(0, options.findIndex((option) => option.value === activeEffort));
  const title = view === "model" ? "Model" : view === "effort" ? "Reasoning effort" : "Model settings";

  const close = (restoreFocus = false) => {
    setView(null);
    if (restoreFocus) trigger.current?.focus();
  };
  const openPanel = (panel: "model" | "effort") => {
    if (panel === "model") { setQuery(""); setActiveModel(model); }
    else setActiveEffort(currentEffort.value);
    setOverviewIndex(panel === "model" ? 0 : 1);
    setView(panel);
  };
  const choose = (kind: "model" | "effort", value: string) => {
    if (disabled) return;
    close();
    if (kind === "model" && value !== model) onModelChange(value);
    if (kind === "effort") onEffortChange(value);
    onCommit();
  };
  const toggle = () => {
    if (disabled) return;
    if (view) close();
    else { setOverviewIndex(0); setView("overview"); onModelsOpen(); }
  };

  useEffect(() => {
    if (!view) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setView(null);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [view]);
  useEffect(() => { if (disabled) setView(null); }, [disabled]);
  useEffect(() => {
    if (view === "overview") overviewRows.current[overviewIndex]?.focus();
    if (view === "model") search.current?.focus();
  }, [view, overviewIndex]);
  useEffect(() => {
    if (view === "model") modelRows.current[modelIndex]?.scrollIntoView({ block: "nearest" });
  }, [view, modelIndex, filtered.length]);
  useEffect(() => {
    if (view === "effort") effortRows.current[effortIndex]?.focus();
  }, [view, effortIndex, options.length]);

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

  return (
    <div className="composer-selector" ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== "Escape" || !view) return;
        event.preventDefault();
        event.stopPropagation();
        if (view === "overview") close(true);
        else setView("overview");
      }}>
      <button ref={trigger} type="button" className="selector-trigger" disabled={disabled}
        title={disabled ? disabledReason : `${name} · ${model} · Reasoning effort: ${currentEffort.label}`}
        aria-label={`Model settings: ${name}, reasoning effort ${currentEffort.label}`}
        aria-haspopup="dialog" aria-expanded={!!view} aria-controls={view ? `${id}-panel` : undefined}
        onClick={toggle} onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); if (!view) toggle(); }
        }}>
        <span className="selector-model-name">{name}</span>
        <span className="selector-trigger-effort"><span aria-hidden="true">·</span> {currentEffort.label}</span>
        <ChevronDown size={12} aria-hidden="true" className={view ? "selector-chevron open" : "selector-chevron"} />
      </button>
      {view && !disabled && (
        <div className={`selector-popover${view === "overview" ? " selector-overview" : ""}`}
          id={`${id}-panel`} role="dialog" aria-label={title}>
          <div className="selector-heading">
            {view !== "overview" ? (
              <button type="button" className="selector-back" aria-label="Back to model settings" onClick={() => setView("overview")}>
                <ArrowLeft size={13} aria-hidden="true" /><span>{title}</span>
              </button>
            ) : <span>{title}</span>}
            <span className="selector-provider" title={provider}>{provider}</span>
          </div>
          {view === "overview" && (
            <div className="selector-overview-options" onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                setOverviewIndex(event.key === "Home" ? 0 : event.key === "End" ? 1
                  : nextOption(overviewIndex, 2, event.key === "ArrowDown" ? 1 : -1));
              } else if (event.key === "ArrowRight") {
                event.preventDefault(); openPanel(overviewIndex === 0 ? "model" : "effort");
              }
            }}>
              <button ref={(element) => { overviewRows.current[0] = element; }} type="button" className="selector-overview-row"
                onFocus={() => setOverviewIndex(0)} onClick={() => openPanel("model")}>
                <span>Model</span><span className="selector-overview-value">{name}</span><ChevronRight size={13} aria-hidden="true" />
              </button>
              <button ref={(element) => { overviewRows.current[1] = element; }} type="button" className="selector-overview-row"
                onFocus={() => setOverviewIndex(1)} onClick={() => openPanel("effort")}>
                <span>Effort</span><span className="selector-overview-value">{currentEffort.label}</span><ChevronRight size={13} aria-hidden="true" />
              </button>
            </div>
          )}
          {view === "model" && <>
            <div className="selector-search">
              <Search size={14} aria-hidden="true" />
              <input ref={search} value={query} placeholder="Search models…" aria-label="Search models"
                role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-models`}
                aria-activedescendant={filtered.length ? `${id}-model-${modelIndex}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveModel(filterModels(models.map((info) => info.id), model, event.target.value, names)[0] ?? "");
                }} onKeyDown={modelKeys} />
            </div>
            <div className="selector-options" id={`${id}-models`} role="listbox" aria-label="Models">
              {filtered.map((value, index) => {
                const label = modelLabel(value, names[value]);
                return (
                  <button key={value} ref={(element) => { modelRows.current[index] = element; }}
                    id={`${id}-model-${index}`} type="button" role="option" tabIndex={-1}
                    aria-selected={value === model} className={`selector-option${index === modelIndex ? " active" : ""}`}
                    onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveModel(value)}
                    onClick={() => choose("model", value)}>
                    <span className="selector-option-copy"><span className="selector-option-text">{label}</span>
                      {label !== value && <span className="selector-model-id">{value}</span>}
                    </span>
                    {value === model && <Check size={14} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
            {!filtered.length && <div className="selector-empty" role="status">No matching models</div>}
            <div className="selector-footer">
              <button type="button" className="selector-custom" onClick={() => { close(); onCustomModel(); }}>
                Custom model… <span aria-hidden="true">↗</span>
              </button>
            </div>
          </>}
          {view === "effort" && (
            <div className="selector-options" role="listbox" aria-label="Reasoning effort" onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                : nextOption(effortIndex, options.length, event.key === "ArrowDown" ? 1 : -1);
              setActiveEffort(options[index].value);
            }}>
              {options.map((option, index) => (
                <button key={option.value} ref={(element) => { effortRows.current[index] = element; }}
                  type="button" role="option" tabIndex={index === effortIndex ? 0 : -1}
                  aria-selected={option.value === currentEffort.value}
                  className={`selector-option selector-effort-option${option.value === "auto (Jev)" ? " selector-auto" : ""}`}
                  onFocus={() => setActiveEffort(option.value)} onClick={() => choose("effort", option.value)}>
                  <span className="selector-option-copy"><span className="selector-option-text">{option.label}</span>
                    <span className="selector-description">{option.description}</span>
                  </span>
                  {option.value === currentEffort.value && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
          {view !== "model" && <div className="selector-footnote">
            {view === "overview" ? "Applies to the next task." : options.length > 1
              ? "Higher effort can take longer and use more tokens."
              : modelInfo?.effortLevels?.length === 0
                ? "This model uses its default reasoning behavior."
                : "Reasoning controls aren’t verified for this model. Using the provider default."}
          </div>}
        </div>
      )}
    </div>
  );
}

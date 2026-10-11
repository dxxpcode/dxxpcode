import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface ModelMatrixProps {
  model: string;
  effort: string;
  efforts: string[];
  models: string[];
  variant: string;
  variants: string[];
  disabled: boolean;
  onOpen: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onVariant: (variant: string) => void;
  onCustom: () => void;
}

interface CellPosition {
  model: string;
  column: number;
}

export const ModelMatrix = memo(function ModelMatrix({
  model,
  effort,
  efforts,
  models,
  variant,
  variants,
  disabled,
  onOpen,
  onModel,
  onEffort,
  onVariant,
  onCustom,
}: ModelMatrixProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusCell, setFocusCell] = useState<CellPosition | null>(null);
  const [crosshair, setCrosshair] = useState<CellPosition | null>(null);
  const tiers = useMemo(() => efforts.filter((item) => item !== "default" && item !== "auto (Jev)"), [efforts]);
  const allModels = useMemo(() => {
    const source = models.length ? models : [model];
    const unique = Array.from(new Set(source));
    return unique.includes(model) ? unique : [...unique, model];
  }, [model, models]);
  const visibleModels = useMemo(() => {
    const filter = query.toLowerCase();
    return filter ? allModels.filter((item) => item.toLowerCase().includes(filter)) : allModels;
  }, [allModels, query]);
  const specialEffort = effort === "default" || effort === "auto (Jev)";
  const effortLabel = effort === "auto (Jev)" ? "auto" : effort;
  const title = `${model} · ${effort} · ${variant}`;
  const selectedColumn = tiers.indexOf(effort);

  const closePanel = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setCrosshair(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openPanel = useCallback(() => {
    if (disabled) return;
    const column = selectedColumn >= 0 ? selectedColumn : 0;
    setQuery("");
    setFocusCell({ model, column });
    setOpen(true);
    onOpen();
  }, [disabled, model, onOpen, selectedColumn]);

  const cellKey = (row: string, column: number) => `${row}\u0000${column}`;

  useEffect(() => {
    if (disabled && open) closePanel();
  }, [closePanel, disabled, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePanel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.key === "Backspace") {
        event.preventDefault();
        setQuery((current) => current.slice(0, -1));
      } else if (event.key.length === 1 && event.key !== " ") {
        event.preventDefault();
        setQuery((current) => current + event.key);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closePanel, open]);

  useEffect(() => {
    if (!open || !visibleModels.length) return;
    if (!focusCell || !visibleModels.includes(focusCell.model)) {
      setFocusCell({
        model: visibleModels[0],
        column: Math.max(0, Math.min(focusCell?.column ?? 0, tiers.length - 1)),
      });
    }
  }, [focusCell, open, tiers.length, visibleModels]);

  useLayoutEffect(() => {
    if (!open || !focusCell || !visibleModels.includes(focusCell.model)) return;
    cellRefs.current.get(cellKey(focusCell.model, focusCell.column))?.focus();
  }, [focusCell, open, visibleModels]);

  useLayoutEffect(() => {
    if (open) rowRefs.current.get(model)?.scrollIntoView({ block: "nearest" });
  }, [model, open, visibleModels]);

  const focusAt = (row: string, column: number) => {
    const next = {
      model: row,
      column: Math.max(0, Math.min(column, tiers.length - 1)),
    };
    setFocusCell(next);
    cellRefs.current.get(cellKey(next.model, next.column))?.focus();
  };

  const pickCell = (row: string, tier: string) => {
    if (row !== model) onModel(row);
    if (tier !== effort) onEffort(tier);
    closePanel(true);
  };

  const renderRow = (row: string) => (
    <div
      className={`mmx-row${specialEffort && row === model ? " mmx-row-special" : ""}`}
      key={row}
      ref={(element) => {
        if (element) rowRefs.current.set(row, element);
        else rowRefs.current.delete(row);
      }}
    >
      <div
        className={`mmx-row-label${row === model ? " mmx-current" : ""}${crosshair?.model === row ? " mmx-hot" : ""}`}
        title={row}
      >{row}</div>
      {tiers.map((tier, column) => {
        const selected = row === model && tier === effort;
        const focused = focusCell?.model === row && focusCell.column === column;
        return (
          <button
            type="button"
            className={`mmx-cell${selected ? " mmx-selected" : ""}`}
            key={tier}
            ref={(element) => {
              const key = cellKey(row, column);
              if (element) cellRefs.current.set(key, element);
              else cellRefs.current.delete(key);
            }}
            tabIndex={focused ? 0 : -1}
            aria-label={`${row} · ${tier}`}
            aria-pressed={selected}
            onMouseEnter={() => setCrosshair({ model: row, column })}
            onMouseLeave={() => setCrosshair(focusCell)}
            onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setCrosshair({ model: row, column }); }}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setCrosshair(null);
            }}
            onKeyDown={(event) => {
              const rowIndex = visibleModels.indexOf(row);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const nextRow = Math.max(0, Math.min(rowIndex + (event.key === "ArrowDown" ? 1 : -1), visibleModels.length - 1));
                focusAt(visibleModels[nextRow], column);
              } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                focusAt(row, column + (event.key === "ArrowRight" ? 1 : -1));
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                focusAt(row, event.key === "Home" ? 0 : tiers.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                pickCell(row, tier);
              }
            }}
            onClick={() => pickCell(row, tier)}
          ><span className="mmx-dot" /></button>
        );
      })}
    </div>
  );

  return (
    <div className="mmx-anchor" ref={rootRef}>
      <button
        type="button"
        className={`mmx-trigger${open ? " mmx-open" : ""}`}
        ref={triggerRef}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => open ? closePanel() : openPanel()}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openPanel();
          }
        }}
      >
        <span className={`mmx-glyph${effort === "auto (Jev)" ? " mmx-auto" : ""}`} aria-hidden="true">
          {tiers.map((tier, index) => {
            const height = 4 + index * 1.4;
            const active = selectedColumn >= 0 && index <= selectedColumn;
            return <i key={tier} className={active ? "mmx-bar-active" : ""} style={{ height: `${height}px` }} />;
          })}
        </span>
        <span className="mmx-model">{model}</span>
        <span className="mmx-effort">{effortLabel}</span>
        {variant !== "default" && <span className="mmx-variant">· {variant}</span>}
      </button>

      {open && (
        <div className="mmx" role="dialog" aria-label="Model and reasoning effort">
          <div className="mmx-scroll">
            <div className="mmx-grid">
              <div className="mmx-header">
                <div className="mmx-filter" aria-live="polite">
                  {query ? <span>{query}</span> : <span className="mmx-placeholder">Type to filter</span>}
                </div>
                {tiers.map((tier, column) => (
                  <div className={`mmx-tier${crosshair?.column === column ? " mmx-hot" : ""}`} key={tier}>{tier}</div>
                ))}
              </div>
              {visibleModels.map(renderRow)}
              {!visibleModels.length && <div className="mmx-empty">No models match</div>}
              <button type="button" className="mmx-custom" onClick={() => { closePanel(true); onCustom(); }}>Custom model…</button>
            </div>
          </div>
          <div className="mmx-footer">
            <div className="mmx-effort-toggles">
              <button
                type="button"
                className={`mmx-quiet${effort === "default" ? " mmx-active" : ""}`}
                aria-pressed={effort === "default"}
                onClick={() => onEffort("default")}
              >Provider default</button>
              <button
                type="button"
                className={`mmx-quiet${effort === "auto (Jev)" ? " mmx-active" : ""}`}
                aria-pressed={effort === "auto (Jev)"}
                onClick={() => onEffort("auto (Jev)")}
              >Auto · Jev</button>
            </div>
            {!!variants.length && (
              <div className="mmx-variants" aria-label="Model variant">
                {variants.length === 1 ? (
                  <>
                    <span className="mmx-variant-name">{variants[0]}</span>
                    <button
                      type="button"
                      className={`mmx-switch${variant === variants[0] ? " mmx-switch-on" : ""}`}
                      role="switch"
                      aria-checked={variant === variants[0]}
                      aria-label={`${variants[0]} variant`}
                      onClick={() => onVariant(variant === variants[0] ? "default" : variants[0])}
                    ><span /></button>
                  </>
                ) : (
                  <div className="mmx-segmented">
                    {["default", ...variants].map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={`mmx-segment${variant === item ? " mmx-active" : ""}`}
                        aria-pressed={variant === item}
                        onClick={() => onVariant(item)}
                      >{item}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

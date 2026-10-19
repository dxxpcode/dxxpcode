import { useId, useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { dialogTabTarget } from "../lib/dialog-navigation";
import { cn } from "../lib/utils";

export function DesktopDialog({
  title, className, children, onClose, onEscape, returnFocusRef, activeKey, navigation = false, escapeHint = "Close",
}: {
  title: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
  onEscape?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  activeKey?: string;
  navigation?: boolean;
  escapeHint?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!node.contains(document.activeElement)) {
      (node.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? node).focus();
    }
    const previous = previousFocus.current;
    return () => {
      requestAnimationFrame(() => {
        // A selection may already have focused the composer or opened another dialog.
        if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) return;
        (previous?.isConnected ? previous : returnFocusRef?.current)?.focus({ preventScroll: true });
      });
    };
  }, [returnFocusRef]);

  useLayoutEffect(() => {
    if (activeKey === undefined) return;
    const rows = dialog.current?.querySelectorAll<HTMLElement>('[data-active="true"]');
    rows?.[rows.length - 1]?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  return createPortal(
    <div className="sesspal" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} className={cn("desktop-dialog sesspal-dialog", className)}
        role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            (onEscape ?? onClose)();
          } else if (event.key === "Tab") {
            const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href], button, input, select, textarea, [tabindex]'
            )).filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0);
            const index = nodes.indexOf(document.activeElement as HTMLElement);
            const target = dialogTabTarget(index, nodes.length, event.shiftKey);
            if (target !== null || !nodes.length) {
              event.preventDefault();
              (nodes[target ?? 0] ?? event.currentTarget).focus();
            }
          }
        }}>
        <header className="dialog-head">
          <h2 id={id} className="dialog-title">{title}</h2>
          <Button type="button" variant="ghost" size="icon" className="dialog-close"
            aria-label={`Close ${title}`} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </Button>
        </header>
        {children}
        {navigation && <footer className="dialog-footer">
          <span><kbd>↑ ↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Select</span>
          <span><kbd>Esc</kbd> {escapeHint}</span>
        </footer>}
      </section>
    </div>,
    document.body,
  );
}

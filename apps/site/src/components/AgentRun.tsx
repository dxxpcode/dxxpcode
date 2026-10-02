import { useEffect, useRef, useState } from "react";

type Step =
  | { kind: "task"; text: string }
  | { kind: "tool"; icon: string; text: string; meta?: string }
  | { kind: "edit"; icon: string; text: string; meta?: string }
  | { kind: "ok"; text: string }
  | { kind: "done"; text: string };

const STEPS: Step[] = [
  { kind: "task", text: "add a /version endpoint" },
  { kind: "tool", icon: "▸", text: "read_file", meta: "server.js · 28 lines" },
  { kind: "tool", icon: "▸", text: "edit_file", meta: "server.js · +5 −0" },
  { kind: "tool", icon: "▸", text: "run", meta: "node server.test.js" },
  { kind: "ok", text: "4 tests passed" },
  { kind: "done", text: "completed · 1 file · 14s" },
];

const STEP_MS = 900;
const HOLD_MS = 3500;

export function AgentRun() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    if (shown < STEPS.length) {
      const t = setTimeout(() => setShown((s) => s + 1), STEP_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown(0), HOLD_MS);
    return () => clearTimeout(t);
  }, [started, shown]);

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-xl border border-border bg-muted/40 text-left font-mono text-[12px] leading-relaxed"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="ml-2 text-[11px] text-muted-foreground">dxxpcode · run</span>
      </div>
      <div className="h-[196px] overflow-hidden p-4">
        {STEPS.slice(0, shown).map((s, i) => (
          <div key={`${shown === 0 ? "r" : "s"}-${i}`} className="animate-[fadein_200ms_ease-out]">
            {s.kind === "task" && (
              <p className="text-foreground">
                <span className="text-muted-foreground">❯ </span>
                {s.text}
              </p>
            )}
            {s.kind === "tool" && (
              <p className="text-muted-foreground">
                <span className="text-foreground/70">{s.icon}</span> {s.text}
                {s.meta && <span className="text-muted-foreground/70"> · {s.meta}</span>}
              </p>
            )}
            {s.kind === "ok" && <p className="text-foreground/90">✓ {s.text}</p>}
            {s.kind === "done" && <p className="mt-2 text-muted-foreground">{s.text}</p>}
          </div>
        ))}
        {started && shown < STEPS.length && (
          <span className="mt-0.5 inline-block h-3 w-[7px] translate-y-[1px] animate-pulse bg-foreground/70" />
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

const COMMAND = [
  "$ curl -X POST http://127.0.0.1:8787/tasks \\",
  '    -H "Authorization: Bearer $(cat ~/.dxxpcode/api-token)" \\',
  '    -d \'{"prompt": "fix the failing test"}\'',
];
const RESPONSE = '{"task_id": "21f7720c-9e62"}';

export function ApiTerminal() {
  const ref = useRef<HTMLDivElement>(null);
  const [chars, setChars] = useState(0);
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
    const t = setInterval(() => {
      setChars((c) => {
        if (c >= RESPONSE.length) {
          clearInterval(t);
          return c;
        }
        return c + 1;
      });
    }, 28);
    return () => clearInterval(t);
  }, [started]);

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-xl border border-border bg-muted/40 text-left font-mono text-[12px] leading-relaxed"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="ml-2 text-[11px] text-muted-foreground">~/dxxpcode</span>
      </div>
      <div className="overflow-x-auto p-4">
        {COMMAND.map((line) => (
          <p key={line} className="text-muted-foreground">
            {line}
          </p>
        ))}
        <p className="mt-2 text-foreground/90">
          {RESPONSE.slice(0, chars)}
          {started && chars < RESPONSE.length && (
            <span className="ml-0.5 inline-block h-3 w-[7px] translate-y-[1px] animate-pulse bg-foreground/70" />
          )}
        </p>
      </div>
    </div>
  );
}

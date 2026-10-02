import { useEffect, useRef, useState } from "react";

// One loop of the run timeline, in display order. Durations are the
// real pacing of a run: think, read, edit+diff, approval beat, verify.
const T = {
  task: 400,
  thinking: 1700, // shimmer "Thinking…" resolves to "Thought for 2.8s"
  read: 800,
  edit: 700,
  diff: 250, // per diff line
  approveWait: 1200, // card sits pending before "y"
  run: 700,
  tests: 900,
  done: 3800, // hold the finished state
};

const DIFF_LINES = [
  '+  if (req.url === "/version") {',
  '+    res.end(JSON.stringify({ version: "0.2.1" }));',
  "+  }",
];

const SHIMMER =
  "bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:250%_100%] bg-clip-text text-transparent animate-[thinkshine_1.6s_linear_infinite]";

type Phase =
  | "task"
  | "thinking"
  | "thought"
  | "read"
  | "edit"
  | "diff"
  | "approve-pending"
  | "approved"
  | "run"
  | "tests"
  | "done";

const ORDER: { phase: Phase; after: number }[] = [
  { phase: "task", after: T.task },
  { phase: "thinking", after: T.thinking },
  { phase: "thought", after: T.read },
  { phase: "read", after: T.edit },
  { phase: "edit", after: T.diff * DIFF_LINES.length + 300 },
  { phase: "diff", after: T.approveWait },
  { phase: "approve-pending", after: 300 },
  { phase: "approved", after: T.run },
  { phase: "run", after: T.tests },
  { phase: "tests", after: 600 },
  { phase: "done", after: T.done },
];

export function AgentRun() {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(-1); // index into ORDER; -1 = idle
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);

  // begin on scroll into view
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !started.current) {
          started.current = true;
          setStep(0);
          io.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // advance the timeline; loop after done
  useEffect(() => {
    if (step < 0) return;
    if (step >= ORDER.length) {
      const t = setTimeout(() => setStep(0), 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), ORDER[step].after);
    return () => clearTimeout(t);
  }, [step]);

  // elapsed timer in the title bar, resets each loop
  useEffect(() => {
    if (step < 0) return;
    if (step === 0) setElapsed(0);
    if (step >= ORDER.length - 1) return;
    const iv = setInterval(() => setElapsed((e) => e + 0.1), 100);
    return () => clearInterval(iv);
  }, [step]);

  const at = (p: Phase) => step >= ORDER.findIndex((o) => o.phase === p);
  const is = (p: Phase) => step === ORDER.findIndex((o) => o.phase === p);
  const done = step >= ORDER.length - 1; // "done" phase onward, through the hold
  const running = started.current && !done;

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-xl border border-border bg-muted/40 text-left font-mono text-[12px] leading-[1.7]"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="h-2 w-2 rounded-full bg-muted-foreground/25" />
        <span className="ml-2 text-[11px] text-muted-foreground">dxxpcode · run</span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/70">
          {running ? `${elapsed.toFixed(0)}s` : done ? "done" : ""}
        </span>
      </div>
      <div className="h-[264px] overflow-hidden p-4">
        {step >= 0 && (
          <p className="animate-[fadein_200ms_ease-out] text-foreground">
            <span className="text-muted-foreground">❯ </span>
            add a /version endpoint
          </p>
        )}
        {is("thinking") && (
          <p className={`animate-[fadein_200ms_ease-out] mt-1 ${SHIMMER}`}>◆ Thinking…</p>
        )}
        {at("thought") && (
          <p className="animate-[fadein_200ms_ease-out] mt-1 text-muted-foreground">
            ◆ Thought for 2.8s
          </p>
        )}
        {at("read") && (
          <p className="animate-[fadein_200ms_ease-out] text-muted-foreground">
            <span className="text-foreground/70">▸</span> read_file
            <span className="text-muted-foreground/70"> · server.js · 28 lines</span>
          </p>
        )}
        {at("edit") && (
          <div className="animate-[fadein_200ms_ease-out]">
            <p className="text-muted-foreground">
              <span className="text-foreground/70">◆</span> Edit server.js
              <span className="ml-2 text-green-600 dark:text-green-400">+5</span>
              <span className="ml-1 text-muted-foreground/70">−0</span>
            </p>
            {at("diff") &&
              DIFF_LINES.map((l) => (
                <p key={l} className="animate-[fadein_200ms_ease-out] text-green-600/90 dark:text-green-400/90">
                  {l}
                </p>
              ))}
          </div>
        )}
        {(is("approve-pending") || at("approved")) && (
          <p className="animate-[fadein_200ms_ease-out] mt-1">
            {is("approve-pending") ? (
              <span className="text-amber-600 dark:text-amber-400">● Apply? y</span>
            ) : (
              <span className="text-foreground/80">✓ applied</span>
            )}
          </p>
        )}
        {at("run") && (
          <p className="animate-[fadein_200ms_ease-out] text-muted-foreground">
            <span className="text-foreground/70">▸</span> run
            <span className="text-muted-foreground/70"> · node server.test.js</span>
          </p>
        )}
        {at("tests") && (
          <p className="animate-[fadein_200ms_ease-out] text-foreground/90">✓ 4 tests passed</p>
        )}
        {at("done") && (
          <p className="animate-[fadein_200ms_ease-out] mt-2 text-muted-foreground">
            completed · 1 file · 14s
          </p>
        )}
        {started.current && !done && !is("thinking") && (
          <span className="mt-0.5 inline-block h-3 w-[7px] translate-y-[1px] animate-pulse bg-foreground/70" />
        )}
      </div>
    </div>
  );
}

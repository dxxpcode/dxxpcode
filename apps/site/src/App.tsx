import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./components/ui/button";
import { GITHUB_URL, Nav } from "./components/Nav";
import Changelog from "./Changelog";
import Docs from "./Docs";
import { cn } from "./lib/utils";

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="Copy"
      className={cn("text-muted-foreground transition-colors hover:text-foreground", className)}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function CodeChip({ code, className }: { code: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-full border border-border py-2.5 pl-5 pr-4 font-mono text-[13px] leading-6 text-foreground",
        className,
      )}
    >
      <code className="flex-1 overflow-x-auto whitespace-pre">
        <span className="select-none text-muted-foreground">$ </span>
        {code}
      </code>
      <CopyButton text={code} />
    </div>
  );
}

const TASK = 'dxxpcode "document the math helpers"';

const STAGE_DELAYS = [500, 1400, 650, 500, 300, 650, 500];
// 0: finish typing → 1: thought → 2: plan → 3: edit → 4: result → 5: diff → 6: completed

function Reveal({ stage, show, children, className }: { stage: number; show: number; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "transition-all duration-500 ease-out",
        show >= stage ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function TerminalShot() {
  const [typed, setTyped] = useState(0);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(TASK.length);
      setStage(STAGE_DELAYS.length);
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i <= TASK.length; i++) {
      timers.push(setTimeout(() => setTyped(i), 300 + i * 38));
    }
    let t = 300 + TASK.length * 38;
    for (let s = 0; s < STAGE_DELAYS.length; s++) {
      t += STAGE_DELAYS[s];
      const n = s + 1;
      timers.push(setTimeout(() => setStage(n), t));
    }
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="overflow-hidden rounded-xl bg-[#0a0a0a] font-mono text-[13px] leading-6 text-white/50 shadow-[0_32px_64px_-24px_rgb(0_0_0/0.35)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/[0.09]">
      <div className="relative flex items-center px-4 py-3">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        </span>
        <span className="absolute inset-x-0 text-center text-xs text-white/35">dxxpcode</span>
      </div>
      <div className="min-h-[300px] space-y-1.5 border-t border-white/[0.08] px-5 pb-6 pt-4">
        <div>
          <span className="text-white/35">❯</span>{" "}
          <span className="text-white/90">{TASK.slice(0, typed)}</span>
          {typed < TASK.length && <span className="animate-blink text-white/70">▌</span>}
        </div>
        <Reveal stage={1} show={Math.max(stage, typed >= TASK.length ? 1 : 0)}>
          <div className="text-white/35">◆ Thought for 1.4s</div>
        </Reveal>
        <Reveal stage={2} show={stage} className="py-1.5">
          <div className="inline-block rounded-md bg-white/[0.05] px-3.5 py-2">
            <div className="font-medium text-white/90">plan ×</div>
            <div>1. Read src/math.ts</div>
            <div>2. Add a docstring</div>
          </div>
        </Reveal>
        <Reveal stage={3} show={stage}>
          <span className="text-white/90">⏺</span>{" "}
          <span className="font-medium text-white/90">Edit</span>
          <span className="text-white/40">(src/math.ts)</span>
        </Reveal>
        <Reveal stage={4} show={stage}>
          <div className="pl-5">⎿ edited src/math.ts (1 replacement)</div>
        </Reveal>
        <Reveal stage={5} show={stage} className="py-1.5">
          <div className="inline-block rounded-md bg-white/[0.05] px-3.5 py-2">
            <div className="font-medium text-white/90">src/math.ts ×</div>
            <div>
              <span className="text-white/30">1 </span>
              <span className="bg-emerald-400/10 px-1 text-emerald-300/90">+/** Adds two numbers. */</span>
            </div>
            <div>
              <span className="text-white/30">2 </span>
              <span className="px-1">export const add = …</span>
            </div>
          </div>
        </Reveal>
        <Reveal stage={6} show={stage}>
          <span className="text-emerald-400/90">✓</span>{" "}
          <span className="font-medium text-white/90">Completed</span> · 4.2s · 44.4k tokens
        </Reveal>
      </div>
    </div>
  );
}
const PRINCIPLES = [
  ["Plans before it acts.", "Every meaningful change starts as a numbered plan you can read, edit, or reject."],
  ["Asks before it writes.", "Edits and shell commands wait for your approval. Nothing destructive runs silently."],
  ["Stays on your machine.", "Bring your own key. Your repository never leaves your laptop except for model calls."],
] as const;

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  if (window.location.pathname.startsWith("/docs")) return <Docs />;
  if (window.location.pathname.startsWith("/changelog")) return <Changelog />;

  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <Nav dark={dark} onToggleTheme={() => setDark((d) => !d)} />

      <header className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[640px] bg-[linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_0%,black,transparent)]"
        />
        <div className="relative mx-auto max-w-4xl px-6 pb-16 pt-20 text-center md:pb-20 md:pt-32">
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-[13px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground" />
            Free during early access · bring your own API key
          </p>
          <h1 className="mt-7 text-balance text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] md:text-[72px]">
            The AI coding agent
            <span className="block text-muted-foreground">that lives in your terminal.</span>
          </h1>
          <p className="mx-auto mt-7 max-w-lg text-pretty text-[17px] leading-7 text-muted-foreground">
            Describe a task. DxxpCode plans it, asks permission, edits code, runs your tests, and shows
            you the diff.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button className="h-11 px-6" onClick={() => (window.location.href = "/docs")}>
              Get started
            </Button>
            <CodeChip code="npm install -g dxxpcode" className="h-11 bg-background" />
          </div>
        </div>
      </header>

      <section className="relative mx-auto max-w-4xl px-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-16 -top-8 bottom-8 -z-0 rounded-[48px] bg-foreground/[0.04] blur-3xl dark:bg-white/[0.07]"
        />
        <div className="relative">
          <TerminalShot />
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pt-32 md:pt-40">
        <div className="grid border-y border-border md:grid-cols-3">
          {PRINCIPLES.map(([title, body], i) => (
            <div
              key={title}
              className={cn(
                "py-10 md:px-8 md:py-12",
                i > 0 && "border-t border-border md:border-l md:border-t-0",
                i === 0 && "md:pl-0",
                i === PRINCIPLES.length - 1 && "md:pr-0",
              )}
            >
              <div className="font-mono text-xs text-muted-foreground">0{i + 1}</div>
              <h3 className="mt-6 text-[17px] font-medium tracking-[-0.01em]">{title}</h3>
              <p className="mt-2 text-[15px] leading-6 text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-32 text-center md:py-40">
        <h2 className="text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.035em] md:text-[48px]">
          Ship from the prompt.
        </h2>
        <p className="mt-4 text-[17px] text-muted-foreground">Works in minutes. No config required.</p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button className="h-11 px-6" onClick={() => (window.location.href = "/docs")}>
            Read the docs
          </Button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center rounded-full border border-border px-6 text-[15px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            View on GitHub
          </a>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-8 text-[13px] text-muted-foreground">
          <span>© 2026 DxxpCode · Terminal-native. Bring your own key.</span>
          <div className="flex gap-6">
            <a href="/docs" className="transition-colors hover:text-foreground">Docs</a>
            <a href="/changelog" className="transition-colors hover:text-foreground">Changelog</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

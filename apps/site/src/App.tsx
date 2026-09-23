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
      className={cn("text-white/40 transition-colors hover:text-white/80", className)}
    >
      {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function CodeChip({ code, className }: { code: string; className?: string }) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl bg-[#1d1d1f] px-4 py-3 font-mono text-[13px] leading-6 text-white/90",
        className,
      )}
    >
      <code className="flex-1 overflow-x-auto whitespace-pre">{code}</code>
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
    <div className="overflow-hidden rounded-2xl bg-[#1d1d1f] font-mono text-[13px] leading-6 text-white/55 shadow-[0_40px_80px_-32px_rgb(0_0_0/0.45)] ring-1 ring-black/10">
      <div className="flex items-center gap-2 px-5 py-3.5">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-xs text-white/40">dxxpcode</span>
      </div>
      <div className="space-y-1.5 border-t border-white/10 px-5 pb-6 pt-4">
        <div>
          <span className="text-[#7ee787]">❯</span>{" "}
          <span className="text-white/90">{TASK.slice(0, typed)}</span>
          {typed < TASK.length && <span className="animate-blink text-white/70">▌</span>}
        </div>
        <Reveal stage={1} show={Math.max(stage, typed >= TASK.length ? 1 : 0)}>
          <div className="text-[#b083f0]">◆ Thought for 1.4s</div>
        </Reveal>
        <Reveal stage={2} show={stage} className="py-1.5">
          <div className="inline-block rounded-lg bg-white/[0.06] px-3.5 py-2">
            <div className="font-medium text-white/90">plan ×</div>
            <div>1. Read src/math.ts</div>
            <div>2. Add a docstring</div>
          </div>
        </Reveal>
        <Reveal stage={3} show={stage}>
          <span className="text-[#7ee787]">⏺</span>{" "}
          <span className="font-medium text-white/90">Edit</span>
          <span className="text-white/40">(src/math.ts)</span>
        </Reveal>
        <Reveal stage={4} show={stage}>
          <div className="pl-5">⎿ edited src/math.ts (1 replacement)</div>
        </Reveal>
        <Reveal stage={5} show={stage} className="py-1.5">
          <div className="inline-block rounded-lg bg-white/[0.06] px-3.5 py-2">
            <div className="font-medium text-white/90">src/math.ts ×</div>
            <div>
              <span className="text-white/30">1 </span>
              <span className="bg-emerald-400/15 px-1 text-emerald-300">+/** Adds two numbers. */</span>
            </div>
            <div>
              <span className="text-white/30">2 </span>
              <span className="px-1">export const add = …</span>
            </div>
          </div>
        </Reveal>
        <Reveal stage={6} show={stage}>
          <span className="text-emerald-400">✓</span>{" "}
          <span className="font-medium text-white/90">Completed</span> · 4.2s · 44.4k tokens
        </Reveal>
      </div>
    </div>
  );
}



export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  if (window.location.pathname.startsWith("/docs")) return <Docs />;
  if (window.location.pathname.startsWith("/changelog")) return <Changelog />;

  return (
    <div className="min-h-screen bg-background">
      <Nav dark={dark} onToggleTheme={() => setDark((d) => !d)} />

      <header className="mx-auto max-w-3xl px-6 pb-16 pt-16 text-center md:pt-24">
        <h1 className="text-5xl font-semibold leading-[1.05] tracking-[-0.02em] md:text-6xl">
          The AI coding agent that lives in your terminal.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-xl leading-7 text-muted-foreground">
          Describe a task. DxxpCode plans it, asks permission, edits code, runs your tests, and shows
          you the diff.
        </p>
        <div className="mt-8 flex items-center justify-center gap-6">
          <Button
            size="lg"
            onClick={() => window.open(GITHUB_URL, "_blank")}
          >
            Get started
          </Button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-[17px] font-medium text-primary hover:underline"
          >
            View on GitHub&nbsp;&rsaquo;
          </a>
        </div>
        <p className="mt-6 text-[15px] text-muted-foreground">
          Free during early access · bring your own API key
        </p>
      </header>

      <section className="mx-auto max-w-3xl px-6 pb-8">
        <TerminalShot />
        <div className="mt-10 flex justify-center pb-16">
          <CodeChip code="npm install -g dxxpcode" />
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
          <span>© 2026 DxxpCode</span>
          <span className="hidden md:inline">
            Free during market validation — paid plans (hosted inference, team features) come later.
          </span>
          <span>Terminal-native. Bring your own key.</span>
        </div>
      </footer>
    </div>
  );
}

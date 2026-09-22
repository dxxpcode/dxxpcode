import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

const GITHUB_URL = "https://github.com/thenextdeveloper/DxxpCode-Terminal";

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

function TerminalShot() {
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
          <span className="text-white/90">dxxpcode "document the math helpers"</span>
        </div>
        <div className="text-[#b083f0]">◆ Thought for 1.4s</div>
        <div className="my-3 inline-block rounded-lg bg-white/[0.06] px-3.5 py-2">
          <div className="font-medium text-white/90">plan ×</div>
          <div>1. Read src/math.ts</div>
          <div>2. Add a docstring</div>
        </div>
        <div>
          <span className="text-[#7ee787]">⏺</span>{" "}
          <span className="font-medium text-white/90">Edit</span>
          <span className="text-white/40">(src/math.ts)</span>
        </div>
        <div className="pl-5">⎿ edited src/math.ts (1 replacement)</div>
        <div className="my-3 inline-block rounded-lg bg-white/[0.06] px-3.5 py-2">
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
        <div>
          <span className="text-emerald-400">✓</span>{" "}
          <span className="font-medium text-white/90">Completed</span> · 4.2s · 44.4k tokens
        </div>
      </div>
    </div>
  );
}



export default function App() {
  return (
    <div className="min-h-screen bg-background">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="DxxpCode" className="h-[17px] w-auto" />
          <span className="text-[15px] font-semibold tracking-tight">DxxpCode</span>
        </div>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[15px] text-[#6e6e73] transition-colors hover:text-foreground"
        >
          GitHub
        </a>
      </nav>

      <header className="mx-auto max-w-3xl px-6 pb-16 pt-16 text-center md:pt-24">
        <h1 className="text-5xl font-semibold leading-[1.05] tracking-[-0.02em] md:text-6xl">
          The AI coding agent that lives in your terminal.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-xl leading-7 text-[#6e6e73]">
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
      </header>

      <section className="mx-auto max-w-3xl px-6 pb-8">
        <TerminalShot />
        <div className="mt-10 flex justify-center pb-16">
          <CodeChip code="npm install -g dxxpcode" />
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-sm text-[#6e6e73]">
          <span>© 2026 DxxpCode</span>
          <span>Terminal-native. Bring your own key.</span>
        </div>
      </footer>
    </div>
  );
}

import { useMemo, useState } from "react";
import {
  Check, ChevronRight, Copy, Github, Play, ShieldCheck, Sparkles, TerminalSquare, Zap,
} from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";

const FEATURES = [
  { icon: TerminalSquare, title: "Lives in your terminal", desc: "No IDE plugin, no Electron wrapper. The CLI is the product — run it where your code lives." },
  { icon: Sparkles, title: "Plan → approve → execute", desc: "The agent proposes a numbered plan before touching anything. You approve with arrow keys." },
  { icon: ShieldCheck, title: "Fail-closed permissions", desc: "Reads run free; deletes, git mutations, and installs ask first; .env and keys are always denied." },
  { icon: Zap, title: "Streams like it means it", desc: "Live thought timers, tinted panels, inline diffs, markdown tables — a transcript you can actually scan." },
  { icon: Play, title: "Real verification", desc: "After editing, it runs your project's own test command and reports what changed." },
  { icon: Copy, title: "Sessions that persist", desc: "--resume picks up the last session for the directory. History and context survive restarts." },
];

type Step = { id: string; title: string; blurb: string; cmd?: string; code?: string; cmdLabel: string };

function useSteps(provider: "anthropic" | "openai", key: string): Step[] {
  const shownKey = key.trim() || "sk-…";
  const envLine =
    provider === "anthropic"
      ? `export ANTHROPIC_API_KEY=${shownKey}`
      : `export OPENAI_API_KEY=${shownKey}`;
  return [
    {
      id: "install",
      title: "Install the CLI",
      blurb: "One package, zero config to start. Requires Node.js ≥ 22.6.",
      cmd: "npm install -g dxxpcode",
      cmdLabel: "Install command",
    },
    {
      id: "key",
      title: "Connect a model provider",
      blurb: "Bring your own key — Anthropic or OpenAI-compatible endpoints.",
      code: `# ${provider === "anthropic" ? "Anthropic" : "OpenAI"}\n${envLine}\n# or persist it in ~/.dxxpcode/config.json`,
      cmdLabel: "Shell",
    },
    {
      id: "task",
      title: "Run your first task",
      blurb: "cd into any repo and describe what you want. The agent proposes a plan you approve before anything changes.",
      cmd: 'cd your-project && dxxpcode "fix the failing test in math.js"',
      cmdLabel: "First task",
    },
    {
      id: "resume",
      title: "Review and resume",
      blurb: "Inspect the diff, then pick the session back up anytime — state lives in ~/.dxxpcode/sessions/.",
      code: "dxxpcode --review   # see exactly what changed\ndxxpcode --resume   # continue the last session",
      cmdLabel: "Shell",
    },
  ];
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="Copy"
    >
      {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

function TerminalMock() {
  return (
    <Card className="overflow-hidden font-mono text-[13px] leading-6">
      <div className="flex items-center gap-1.5 border-b border-border bg-secondary/40 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
        <span className="ml-2 text-xs text-muted-foreground">dxxpcode — zsh</span>
      </div>
      <div className="space-y-1 p-4 text-muted-foreground">
        <div>
          <span className="text-primary">❯</span>{" "}
          <span className="text-foreground">dxxpcode "document the math helpers"</span>
        </div>
        <div className="text-accent">◆ Thought for 1.4s</div>
        <div className="my-2 inline-block rounded-md bg-secondary/60 px-3 py-1.5">
          <div className="font-semibold text-foreground">plan ×</div>
          <div>1. Read src/math.ts</div>
          <div>2. Add a docstring</div>
        </div>
        <div>
          <span className="text-primary">⏺</span>{" "}
          <span className="font-semibold text-foreground">Edit</span>
          <span className="text-muted-foreground">(src/math.ts)</span>
        </div>
        <div className="pl-5">⎿ edited src/math.ts (1 replacement)</div>
        <div className="my-2 inline-block rounded-md bg-secondary/60 px-3 py-1.5">
          <div className="font-semibold text-foreground">src/math.ts ×</div>
          <div>
            <span className="text-muted-foreground">   1 </span>
            <span className="bg-emerald-500/15 text-emerald-300">+/** Adds two numbers. */</span>
          </div>
          <div>
            <span className="text-muted-foreground">   2 </span>export const add = …
          </div>
        </div>
        <div>
          <span className="text-emerald-400">✓</span>{" "}
          <span className="font-semibold text-foreground">Completed</span> · 4.2s · 44.4k tokens
        </div>
      </div>
    </Card>
  );
}

function Onboarding() {
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [key, setKey] = useState("");
  const [step, setStep] = useState(0);
  const steps = useSteps(provider, key);
  const current = steps[step];

  return (
    <section id="onboarding" className="mx-auto max-w-6xl px-6 py-20">
      <div className="mb-10 text-center">
        <Badge>Onboarding</Badge>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">Zero to first task in a minute</h2>
        <p className="mt-2 text-muted-foreground">
          Four steps. Pick your provider — the commands update as you go.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-center gap-3">
        <span className="text-sm text-muted-foreground">Provider:</span>
        {(["anthropic", "openai"] as const).map((p) => (
          <Button
            key={p}
            variant={provider === p ? "default" : "outline"}
            size="sm"
            onClick={() => setProvider(p)}
          >
            {p === "anthropic" ? "Anthropic" : "OpenAI-compatible"}
          </Button>
        ))}
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="paste your API key (never leaves this page)"
          className="w-64 font-mono text-xs"
          type="password"
        />
      </div>

      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                onClick={() => setStep(i)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors",
                  i === step
                    ? "border-primary/50 bg-secondary/60"
                    : "border-transparent hover:bg-secondary/40",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    i < step
                      ? "border-emerald-500/50 text-emerald-400"
                      : i === step
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={cn("text-sm", i === step ? "text-foreground" : "text-muted-foreground")}>
                  {s.title}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Step {step + 1} — {current.title}
            </CardTitle>
            <CardDescription>{current.blurb}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {current.cmdLabel}
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
                <code className="flex-1 overflow-x-auto whitespace-pre text-emerald-300">
                  {current.cmd ?? current.code}
                </code>
                <CopyButton text={current.cmd ?? current.code ?? ""} />
              </div>
            </div>
            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" size="sm" disabled={step === 0} onClick={() => setStep(step - 1)}>
                Back
              </Button>
              <span className="text-xs text-muted-foreground">
                {step + 1} / {steps.length}
              </span>
              <Button size="sm" onClick={() => setStep(step + 1)} disabled={step === steps.length - 1}>
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export default function App() {
  const year = useMemo(() => new Date().getFullYear(), []);
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="DxxpCode logo" className="h-7 w-auto" />
          <span className="font-mono font-semibold">DxxpCode</span>
          <Badge>v0.1.0</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => document.getElementById("onboarding")?.scrollIntoView({ behavior: "smooth" })}
          >
            Get started
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open("https://github.com/thenextdeveloper/DxxpCode-Terminal", "_blank")}
          >
            <Github className="h-4 w-4" /> GitHub
          </Button>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-6 pb-16 pt-10 md:grid-cols-2">
        <div>
          <Badge className="mb-4">The CLI is the product</Badge>
          <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
            An AI coding agent that lives entirely in your terminal.
          </h1>
          <p className="mt-4 max-w-md text-lg text-muted-foreground">
            Describe a task. DxxpCode plans it, asks permission, edits code, runs your tests, and
            shows you the diff — no dashboards, no browser tabs.
          </p>
          <div className="mt-6 flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 font-mono text-sm">
            <span className="text-primary">$</span>
            <code className="flex-1">npm install -g dxxpcode</code>
            <CopyButton text="npm install -g dxxpcode" />
          </div>
          <div className="mt-4 flex gap-3">
            <Button
              onClick={() => document.getElementById("onboarding")?.scrollIntoView({ behavior: "smooth" })}
            >
              Start onboarding <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              onClick={() => window.open("https://github.com/thenextdeveloper/DxxpCode-Terminal", "_blank")}
            >
              View source
            </Button>
          </div>
        </div>
        <TerminalMock />
      </section>

      <section className="border-t border-border bg-card/30">
        <div className="mx-auto grid max-w-6xl gap-4 px-6 py-16 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title} className="bg-background/60">
              <CardHeader>
                <f.icon className="mb-2 h-5 w-5 text-primary" />
                <CardTitle className="text-base">{f.title}</CardTitle>
                <CardDescription>{f.desc}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <Onboarding />

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
          <span className="font-mono">© {year} DxxpCode</span>
          <span>Terminal-native. Bring your own key.</span>
        </div>
      </footer>
    </div>
  );
}

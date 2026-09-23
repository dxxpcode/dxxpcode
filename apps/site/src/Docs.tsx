import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { cn } from "./lib/utils";

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 overflow-x-auto rounded-xl bg-[#0a0a0a] px-4 py-3 font-mono ring-1 ring-black/5 dark:ring-white/[0.09] text-[13px] leading-6 text-white/90">
      <pre>{children}</pre>
    </div>
  );
}

function Inline({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-b border-border py-10 last:border-b-0">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-3 text-[15px] leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

function Row({ name, desc }: { name: string; desc: string }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="whitespace-nowrap py-2.5 pr-6 align-top font-mono text-[13px] text-foreground">
        {name}
      </td>
      <td className="py-2.5 text-muted-foreground">{desc}</td>
    </tr>
  );
}

const SECTIONS = [
  ["start", "Getting started"],
  ["connect", "Connect a provider"],
  ["task", "Your first task"],
  ["commands", "Slash commands"],
  ["flags", "Flags & environment"],
  ["config", "Configuration"],
  ["instructions", "Project instructions"],
] as const;

export default function Docs() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [active, setActive] = useState<string>("start");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Nav dark={dark} onToggleTheme={() => setDark((d) => !d)} />

      <div className="mx-auto flex max-w-5xl gap-10 px-6 pb-16">
        <aside className="sticky top-14 hidden w-44 shrink-0 self-start pt-10 md:block">
          <p className="pb-3 text-[13px] font-semibold tracking-tight">Docs</p>
          <ul className="space-y-1.5 border-l border-border">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className={cn(
                    "-ml-px block border-l-2 pl-3 py-0.5 text-[14px] transition-colors",
                    active === id
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="pt-10">
            <p className="text-[17px] leading-7 text-muted-foreground">
              The AI coding agent that lives in your terminal — install, connect a provider, and ship.
            </p>
          </div>

          <Section id="start" title="Getting started">
            <p>Requires Node 20 or later. Install the CLI globally:</p>
            <Code>npm install -g dxxpcode</Code>
            <p>
              Then run it inside any project directory — DxxpCode detects languages, git state, and
              project instructions automatically:
            </p>
            <Code>cd your-project{"\n"}dxxpcode</Code>
            <p>
              Free during early access — you bring your own API key, and nothing leaves your machine
              except calls to your chosen provider.
            </p>
          </Section>

          <Section id="connect" title="Connect a provider">
            <p>
              On first launch, DxxpCode walks you through connecting a provider in the terminal. You
              can reopen that flow anytime with <Inline>/provider</Inline>, or skip it entirely with
              environment variables:
            </p>
            <Code>
              {"# Anthropic (Claude)\nexport ANTHROPIC_API_KEY=sk-ant-…\n\n# OpenAI-compatible (OpenAI, Grok, Gemini, OpenRouter, local)\nexport OPENAI_API_KEY=sk-…\nexport OPENAI_BASE_URL=https://api.x.ai/v1   # optional"}
            </Code>
            <p>
              Keys are stored owner-only in <Inline>~/.dxxpcode/config.json</Inline> — environment
              variables always take precedence.
            </p>
          </Section>

          <Section id="task" title="Your first task">
            <p>Describe a task in plain language at the prompt:</p>
            <Code>❯ fix the failing test in math.js</Code>
            <p>The agent then walks a fixed loop:</p>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Investigates the repo and proposes a plan.</li>
              <li>You approve it (arrow keys → Enter) — nothing changes before that.</li>
              <li>It edits files, showing each diff as a card, and keeps a live task checklist.</li>
              <li>Actions that can hurt anything — shell commands, deletes — ask first.</li>
              <li>It runs your tests, then summarizes what changed and the tokens used.</li>
            </ol>
            <p>
              Every file mutation is checkpointed — <Inline>/undo</Inline> restores the last change.
              Preview without changing anything via <Inline>dxxpcode --plan &quot;task&quot;</Inline>,
              and pick up where you left off with <Inline>dxxpcode --resume</Inline>.
            </p>
            <p>
              Attach context inline with <Inline>@</Inline> mentions — typing{" "}
              <Inline>@</Inline> opens a file/directory picker; <Inline>Tab</Inline> completes.
              <Inline>@src/math.ts</Inline> attaches a file, <Inline>@src/math.ts#5-10</Inline>{" "}
              attaches just those lines, and <Inline>@src/</Inline> attaches a directory listing.
            </p>
          </Section>

          <Section id="commands" title="Slash commands">
            <table className="w-full text-[14px]">
              <tbody>
                <Row name="/status" desc="Provider, model, mode, version, project, git, session, and token usage." />
                <Row name="/config" desc="Settings menu — approval mode, model, reasoning effort." />
                <Row name="/model" desc="Pick a model from the provider's live catalog (or enter a custom name)." />
                <Row name="/effort" desc="Reasoning effort for the next task: default, minimal → max." />
                <Row name="/undo" desc="Restore files from the last checkpoint." />
                <Row name="/review" desc="Show the working-tree diff." />
                <Row name="/provider" desc="Connect or switch the model provider." />
                <Row name="/clear" desc="Clear the transcript." />
                <Row name="/help" desc="List all commands." />
                <Row name="/exit" desc="Quit dxxpcode." />
              </tbody>
            </table>
          </Section>

          <Section id="flags" title="Flags & environment">
            <table className="w-full text-[14px]">
              <tbody>
                <Row name='dxxpcode "task"' desc="Run a task directly (non-interactive-friendly)." />
                <Row name='--plan "task"' desc="Plan only — no changes made." />
                <Row name="--resume" desc="Resume the previous session in this directory." />
                <Row name="--review" desc="Print the working-tree diff and exit." />
                <Row name="--undo" desc="Restore files from the last checkpoint and exit." />
                <Row name="--provider" desc="anthropic | openai | mock." />
                <Row name="--model" desc="Model override for this run." />
                <Row name="--effort" desc="minimal | low | medium | high | xhigh | max." />
                <Row name="--yes, -y" desc="Auto-approve actions that would otherwise ask." />
                <Row name="--max-iterations" desc="Agent iteration cap (default 40)." />
              </tbody>
            </table>
            <p className="pt-2">Environment:</p>
            <table className="w-full text-[14px]">
              <tbody>
                <Row name="ANTHROPIC_API_KEY" desc="Enables the Anthropic provider." />
                <Row name="OPENAI_API_KEY" desc="Enables the OpenAI provider." />
                <Row name="OPENAI_BASE_URL" desc="OpenAI-compatible endpoint (Grok, Gemini, OpenRouter, local)." />
                <Row name="DXXPCODE_PROVIDER" desc="Force a provider." />
                <Row name="DXXPCODE_MODEL" desc="Force a model." />
                <Row name="DXXPCODE_EFFORT" desc="Force a reasoning effort level." />
                <Row name="DXXPCODE_HOME" desc="Override ~/.dxxpcode (sessions, config, checkpoints)." />
              </tbody>
            </table>
          </Section>

          <Section id="config" title="Configuration">
            <p>
              Everything configurable lives in <Inline>~/.dxxpcode/config.json</Inline> — the same
              settings <Inline>/config</Inline> edits in-session:
            </p>
            <Code>
              {'{\n  "provider": "anthropic",\n  "model": "claude-opus-5-5",\n  "approvalMode": "ask",        // or "auto"\n  "effort": "high",               // default if unset\n  "maxIterations": 40\n}'}
            </Code>
            <p>
              <Inline>/status</Inline> shows the effective values for the current session, including
              the config path.
            </p>
          </Section>

          <Section id="instructions" title="Project instructions">
            <p>
              Drop guidance for the agent in <Inline>.dxxpcode/instructions.md</Inline> at your repo
              root — conventions, commands, files to avoid. <Inline>AGENTS.md</Inline> is honored
              too. Instructions are injected into every task's context, alongside detected languages
              and git state.
            </p>
            <p>
              Sessions, checkpoints, and history live under <Inline>~/.dxxpcode/</Inline>; nothing
              project-specific leaves the machine except your provider API calls.
            </p>
          </Section>
        </main>
      </div>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
          <span>© 2026 DxxpCode</span>
          <span>Terminal-native. Bring your own key.</span>
        </div>
      </footer>
    </div>
  );
}

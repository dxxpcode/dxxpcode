import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";

interface Release {
  version: string;
  date: string;
  tag?: string;
  items: string[];
}

const RELEASES: Release[] = [
  {
    version: "Unreleased",
    date: "on main",
    items: [
      "Docs page — /docs with install, provider, command, and config reference",
      "Changelog page — this page",
      "File checkpoints — every mutation snapshots its target; /undo restores the last change",
      "Task checklists — todo_write renders a live tasks card in the terminal",
      "Slash-command shortcuts — /effort, /model, /undo, /review, /provider",
      "Live model picker — /model fetches the provider's current catalog",
      "Reasoning effort — minimal through max tiers, shown in the turn meter and footer",
      "Opencode-style streaming — per-tool icons and live verb lines",
      "Resume indicator — --resume shows the restored session and message count",
      "Fresh git state in /status — dirty trees no longer report clean",
    ],
  },
  {
    version: "0.1.0",
    date: "Initial release",
    items: [
      "Interactive terminal UI — boxed input, arrow-key approvals, scrollable transcript, status bar, live turn meter, slash-command autocomplete, persistent history",
      "Agent loop — plan → approve → execute → verify, with permission tiers and session \"always allow\"",
      "Providers — Anthropic and OpenAI-compatible streaming adapters; first-run /provider connect flow",
      "Tools — filesystem, search, shell, git; @file mentions; inline diff previews; token/time footer",
      "Context compaction past ~60k estimated tokens",
      "Sessions persisted locally with --resume; --plan, --review, --yes modes",
      "Update notifications via npm registry with a 24h cache",
    ],
  },
];

export default function Changelog() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <div className="min-h-screen bg-background">
      <Nav dark={dark} onToggleTheme={() => setDark((d) => !d)} />

      <div className="mx-auto max-w-3xl px-6 pb-16">
        <div className="pt-10">
          <h1 className="text-4xl font-semibold tracking-tight">Changelog</h1>
          <p className="mt-3 text-[17px] leading-7 text-muted-foreground">
            What's new in DxxpCode. Versions follow semver; releases publish to npm as{" "}
            <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]">dxxpcode</code>.
          </p>
        </div>

        <div className="mt-4">
          {RELEASES.map((r) => (
            <section key={r.version} className="border-b border-border py-9 last:border-b-0">
              <div className="flex items-baseline gap-3">
                <h2 className="font-mono text-lg font-semibold tracking-tight">
                  {r.version === "Unreleased" ? r.version : `v${r.version}`}
                </h2>
                <span className="text-[13px] text-muted-foreground">{r.date}</span>
              </div>
              <ul className="mt-4 space-y-2.5 text-[15px] leading-7 text-muted-foreground">
                {r.items.map((item) => {
                  const [lead, rest] = item.split(" — ");
                  return (
                    <li key={item} className="flex gap-2.5">
                      <span className="mt-[11px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                      <span>
                        {rest ? (
                          <>
                            <span className="text-foreground">{lead}</span>
                            {" — "}
                            {rest}
                          </>
                        ) : (
                          lead
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
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

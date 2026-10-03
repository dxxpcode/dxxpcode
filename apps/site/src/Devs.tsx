import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Logo } from "./components/Logo";

const ENDPOINTS: { method: string; path: string; description: string }[] = [
  { method: "POST", path: "/tasks", description: "Start a run — {prompt, cwd?, model?, effort?, mode?, autoApprove?}" },
  { method: "GET", path: "/tasks/:id/events", description: "SSE stream of the run's events (text, tool calls, approvals, done)" },
  { method: "POST", path: "/tasks/:id/input", description: "Steer a run or answer a pending approval — {type: \"steer\"|\"approve\"}" },
  { method: "GET", path: "/tasks", description: "List tasks with status" },
  { method: "GET", path: "/tasks/:id", description: "Status and finish summary, including the session id" },
  { method: "DELETE", path: "/tasks/:id", description: "Interrupt the run (esc equivalent)" },
];

function Code({ children }: { children: string }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-left font-mono text-[12px] leading-relaxed text-foreground/90">
      {children}
    </pre>
  );
}

export default function Devs() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <div className="flex min-h-[100svh] flex-col bg-background">
      <header className="grid h-16 grid-cols-3 items-center px-6">
        <span />
        <a href="/" className="justify-self-center" aria-label="DxxpCode">
          <Logo className="h-[18px] w-auto" />
        </a>
        <nav className="flex items-center gap-5 justify-self-end text-[13px] text-muted-foreground">
          <button
            onClick={() => setDark((d) => !d)}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="-mr-2 p-2 transition-colors hover:text-foreground"
          >
            {dark ? <Sun strokeWidth={1.5} className="h-4 w-4" /> : <Moon strokeWidth={1.5} className="h-4 w-4" />}
          </button>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center px-6 pb-16 pt-10 text-center">
        <p className="font-mono text-[12px] text-muted-foreground">DxxpDevs</p>
        <h1 className="mt-2 text-balance text-[28px] font-medium leading-tight tracking-[-0.02em] sm:text-[32px]">
          A local coding agent{" "}
          <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            other developer tools can control
          </span>
        </h1>
        <p className="mt-4 max-w-2xl text-pretty text-[14px] leading-relaxed text-muted-foreground">
          <code className="font-mono text-[13px] text-foreground">dxxpcode serve</code> exposes the agent loop over
          localhost HTTP — the same plan → approve → execute → verify → review machinery the desktop app uses, driven
          by anything that speaks HTTP: CI bots, IDE plugins, scripts.
        </p>

        <section className="mt-14 w-full max-w-2xl">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Start the server</h2>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Runs on <code className="font-mono">127.0.0.1:8787</code> · token saved to{" "}
            <code className="font-mono">~/.dxxpcode/api-token</code>
          </p>
          <Code>{`$ dxxpcode serve
dxxpcode serve listening on http://127.0.0.1:8787
token: dxp_…  (saved in ~/.dxxpcode/api-token)`}</Code>
        </section>

        <section className="mt-12 w-full max-w-2xl">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Run a task</h2>
          <Code>{`$ TOKEN=$(cat ~/.dxxpcode/api-token)

$ curl -X POST http://127.0.0.1:8787/tasks \\
    -H "Authorization: Bearer $TOKEN" \\
    -d '{"prompt": "fix the failing test", "cwd": "~/app"}'

{"task_id": "21f7720c-9e62"}`}</Code>
        </section>

        <section className="mt-12 w-full max-w-2xl">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Stream the events</h2>
          <p className="mt-2 text-[13px] text-muted-foreground">
            Every event the agent emits — text, tool calls, approvals, done — replayed then tailed over SSE.
          </p>
          <Code>{`$ curl -N http://127.0.0.1:8787/tasks/21f7720c-9e62/events \\
    -H "Authorization: Bearer $TOKEN"

data: {"type":"status","message":"Inspecting project…"}
data: {"type":"tool_call","name":"read_file", …}
data: {"type":"done","result":{"status":"completed", …}}`}</Code>
        </section>

        <section className="mt-14 w-full max-w-2xl">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Endpoints</h2>
          <div className="mt-5 divide-y divide-border border-y border-border">
            {ENDPOINTS.map((e) => (
              <div key={e.method + e.path} className="flex items-baseline gap-3 py-3 text-left">
                <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{e.method}</span>
                <span className="w-48 shrink-0 font-mono text-[12px]">{e.path}</span>
                <span className="text-[12px] text-muted-foreground">{e.description}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 w-full max-w-2xl">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">What it's for</h2>
          <div className="mt-6 grid gap-6 text-left sm:grid-cols-3">
            {[
              {
                title: "A CI fix bot",
                body: "On a failing check, POST a task with the failure log as the prompt and stream events into the job output.",
              },
              {
                title: "An IDE integration",
                body: "Drive runs from an editor panel — prompt in, SSE events rendered as the transcript.",
              },
              {
                title: "Scripted batch work",
                body: "Queue tasks across repos with autoApprove for unattended runs; sessions persist for resume.",
              },
            ].map((u) => (
              <div key={u.title}>
                <p className="text-[13px] font-medium">{u.title}</p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{u.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 w-full max-w-2xl border-t border-border pt-8">
          <p className="font-mono text-[12px] text-muted-foreground">
            Engineering deep dives ·{" "}
            <a href="/notes" className="transition-colors hover:text-foreground">
              Notes →
            </a>
          </p>
        </section>

        <p className="mt-8 w-full max-w-2xl font-mono text-[12px] text-muted-foreground">
          localhost only · bearer token required · bring your own API key
        </p>
      </main>
    </div>
  );
}

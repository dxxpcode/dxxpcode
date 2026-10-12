import { useEffect, useState } from "react";
import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { Logo } from "./components/Logo";

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

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <p className="font-mono text-[12px] text-muted-foreground">DxxpDevs</p>
        <h1 className="mt-2 text-balance text-[28px] font-medium leading-tight tracking-[-0.02em] sm:text-[32px]">
          A local coding agent{" "}
          <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            your tools can drive
          </span>
        </h1>
        <p className="mt-4 max-w-xl text-pretty text-[14px] leading-relaxed text-muted-foreground">
          <code className="font-mono text-[13px] text-foreground">dxxpcode serve</code> exposes the agent loop over
          localhost HTTP — the same plan → approve → execute machinery the desktop app uses. It's what powers our own
          integrations today.
        </p>

        <div className="mt-10 w-full max-w-md rounded-xl border border-border p-6 text-left">
          <p className="text-[13px] font-medium">Developer API — in development</p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            The HTTP API works, but its schema is still moving while we focus on the desktop app. We're not documenting
            or supporting it for external use yet — build on it knowing it may change.
          </p>
          <a
            href="https://github.com/dxxpcode/dxxpcode/issues/new?title=Developer%20API%20access"
            className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-foreground transition-colors hover:text-muted-foreground"
          >
            Tell us what you'd build <ArrowUpRight strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        </div>

        <p className="mt-10 font-mono text-[12px] text-muted-foreground">
          Engineering deep dives ·{" "}
          <a href="/notes" className="transition-colors hover:text-foreground">
            Notes →
          </a>
        </p>
      </main>
    </div>
  );
}

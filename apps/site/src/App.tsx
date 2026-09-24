import { useEffect, useState } from "react";
import { Check, Copy, Moon, Sun } from "lucide-react";
import { Logo } from "./components/Logo";
import Changelog from "./Changelog";
import Docs from "./Docs";

const INSTALL = "npm install -g dxxpcode";

function InstallCount() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => setN(typeof d.installs === "number" ? d.installs : null))
      .catch(() => {});
  }, []);
  if (n === null) return null;
  return (
    <p className="mt-6 text-[13px] text-muted-foreground">
      {n.toLocaleString()} {n === 1 ? "developer" : "developers"} installed dxxpcode
    </p>
  );
}

function InstallButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(INSTALL);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={`Copy "${INSTALL}"`}
      className="group inline-flex h-10 items-center rounded-full border border-border font-mono text-[13px] transition-colors hover:bg-secondary"
    >
      <span className="pl-5 pr-4">
        <span className="select-none text-muted-foreground">$ </span>
        <span className="text-foreground/80">{INSTALL}</span>
      </span>
      <span className="h-5 w-px bg-border" />
      <span className="flex h-full items-center pl-3.5 pr-4 text-muted-foreground transition-colors group-hover:text-foreground">
        {copied ? <Check strokeWidth={1.5} className="h-4 w-4 text-foreground" /> : <Copy strokeWidth={1.5} className="h-4 w-4" />}
      </span>
    </button>
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

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <h1 className="text-balance text-[28px] font-medium leading-tight tracking-[-0.02em] sm:text-[32px]">
          The AI coding agent{" "}
          <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            in your terminal
          </span>
        </h1>

        <div className="mt-7">
          <InstallButton />
        </div>
        <InstallCount />
      </main>
    </div>
  );
}

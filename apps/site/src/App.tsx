import { useEffect, useState } from "react";
import { Check, Github, Moon, Sun, Terminal } from "lucide-react";
import { GITHUB_URL } from "./components/Nav";
import Changelog from "./Changelog";
import Docs from "./Docs";

const INSTALL = "npm install -g dxxpcode";

const PROVIDERS = ["Anthropic", "OpenAI", "Gemini", "Grok", "OpenRouter", "Local models"];

const PLATFORMS = ["macOS", "Linux", "Windows (WSL)"];

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
      className="inline-flex h-10 items-center gap-2.5 rounded-full bg-foreground px-5 text-background transition-opacity hover:opacity-90"
    >
      {copied ? <Check className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
      <span className="font-mono text-[13px]">{INSTALL}</span>
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
          <img src={dark ? "/logo-dark.png" : "/logo.png"} alt="DxxpCode" className="h-[18px] w-auto" />
        </a>
        <nav className="flex items-center gap-5 justify-self-end text-[13px] text-muted-foreground">
          <a href="/docs" className="transition-colors hover:text-foreground">
            Docs
          </a>
          <a href="/changelog" className="hidden transition-colors hover:text-foreground sm:inline">
            Changelog
          </a>
          <button
            onClick={() => setDark((d) => !d)}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="-mr-2 p-2 transition-colors hover:text-foreground"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-8 text-center">
        <h1 className="text-balance text-[28px] font-medium leading-tight tracking-[-0.02em] sm:text-[32px]">
          The AI coding agent{" "}
          <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
            in your terminal
          </span>
        </h1>

        <div className="mt-7 flex flex-col items-center gap-3 sm:flex-row">
          <InstallButton />
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2.5 rounded-full border border-border px-5 text-[14px] text-foreground transition-colors hover:bg-secondary"
          >
            <Github className="h-4 w-4" />
            GitHub
          </a>
        </div>

        <ul className="mt-10 flex max-w-[300px] flex-wrap sm:max-w-none justify-center gap-x-6 gap-y-2 text-[13px] text-muted-foreground">
          {PROVIDERS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </main>

      <footer className="pb-10 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Runs on
        </p>
        <ul className="mt-4 flex justify-center gap-6 text-[13px] text-foreground/80">
          {PLATFORMS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </footer>
    </div>
  );
}

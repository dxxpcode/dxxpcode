import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Logo } from "./components/Logo";
import Changelog from "./Changelog";
import Docs from "./Docs";

const RELEASE = "https://github.com/thenextdeveloper/DxxpCode-Terminal/releases/download/desktop-v0.1.0";
const DOWNLOADS: [string, string][] = [
  ["macOS", `${RELEASE}/dxxpcode-desktop_0.1.0_aarch64.dmg`],
  ["Windows", `${RELEASE}/dxxpcode-desktop_0.1.0_x64-setup.exe`],
  ["Linux", `${RELEASE}/dxxpcode-desktop_0.1.0_amd64.AppImage`],
];

function DownloadButtons() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        {DOWNLOADS.map(([os, url]) => (
          <a
            key={os}
            href={url}
            className="inline-flex h-10 items-center rounded-full bg-foreground px-5 text-[13px] font-medium text-background transition-opacity hover:opacity-80"
          >
            {os}
          </a>
        ))}
      </div>
      <a
        href="https://github.com/thenextdeveloper/DxxpCode-Terminal/releases/tag/desktop-v0.1.0"
        className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        All releases →
      </a>
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
            on your desktop
          </span>
        </h1>

        <div className="mt-7">
          <DownloadButtons />
        </div>
      </main>
    </div>
  );
}

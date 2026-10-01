import { useEffect, useState } from "react";
import { ArrowDown, Moon, Sun } from "lucide-react";
import { GitHubStars } from "./components/GitHubStars";
import { Logo } from "./components/Logo";
import { PlatformIcon, type Platform } from "./components/PlatformIcon";
import { Reliability } from "./components/Reliability";
import Changelog from "./Changelog";
import Docs from "./Docs";

const VERSION = "0.2.1";
const RELEASE = `https://github.com/dxxpcode/DxxpCode-Terminal/releases/download/desktop-v${VERSION}`;
const RELEASES = `https://github.com/dxxpcode/DxxpCode-Terminal/releases/tag/desktop-v${VERSION}`;

const DOWNLOADS: { os: Platform; url: string; build: string; alts?: { label: string; url: string }[] }[] = [
  { os: "macOS", url: `${RELEASE}/dxxpcode-desktop_${VERSION}_aarch64.dmg`, build: "Apple Silicon · .dmg" },
  { os: "Windows", url: `${RELEASE}/dxxpcode-desktop_${VERSION}_x64-setup.exe`, build: "x64 · .exe" },
  {
    os: "Linux",
    url: `${RELEASE}/dxxpcode-desktop_${VERSION}_amd64.AppImage`,
    build: "x64 · AppImage",
    alts: [{ label: ".deb", url: `${RELEASE}/dxxpcode-desktop_${VERSION}_amd64.deb` }],
  },
];

function detect(): Platform | null {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(ua)) return null;
  if (/Win/i.test(ua)) return "Windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "Linux";
  return "macOS";
}

const quiet = "text-muted-foreground transition-colors hover:text-foreground";

function DownloadButtons() {
  const [os] = useState(detect);
  const primary = DOWNLOADS.find((d) => d.os === os);

  if (!primary) {
    return (
      <div className="flex flex-col items-center gap-6">
        <p className="text-[13px] text-muted-foreground">
          Available for{" "}
          {DOWNLOADS.map((d, i) => (
            <span key={d.os}>
              {i > 0 && (i === DOWNLOADS.length - 1 ? " and " : ", ")}
              <a href={d.url} className="text-foreground underline-offset-4 hover:underline">
                {d.os}
              </a>
            </span>
          ))}
        </p>
        <GitHubStars />
      </div>
    );
  }

  const others = DOWNLOADS.filter((d) => d !== primary);
  return (
    <div className="flex flex-col items-center">
      <div className="flex flex-wrap items-start justify-center gap-3">
        <div className="flex flex-col items-center">
          <a
            href={primary.url}
            className="inline-flex h-11 items-center gap-2.5 rounded-full bg-foreground pl-5 pr-4 text-[14px] font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <PlatformIcon os={primary.os} className="h-4 w-4" />
            Download for {primary.os}
            <ArrowDown strokeWidth={1.5} className="h-4 w-4 opacity-60" />
          </a>
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            v{VERSION} · {primary.build}
            {primary.alts?.map((a) => (
              <span key={a.label}>
                {" · "}
                <a href={a.url} className="underline-offset-4 transition-colors hover:text-foreground hover:underline">
                  {a.label}
                </a>
              </span>
            ))}
          </p>
        </div>
        <GitHubStars />
      </div>
      <p className="mt-6 text-[13px] text-muted-foreground">
        Also available for{" "}
        {others.map((d, i) => (
          <span key={d.os}>
            {i > 0 && " · "}
            <a href={d.url} className="text-foreground/80 transition-colors hover:text-foreground">
              {d.os}
            </a>
          </span>
        ))}
        {" · "}
        <a href={RELEASES} className={quiet}>
          All releases
        </a>
      </p>
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

        <figure className="mt-12 w-full max-w-5xl overflow-hidden rounded-xl border border-border sm:mt-14">
          <img
            src={dark ? "/desktop-task-dark.webp" : "/desktop-task-light.webp"}
            alt="DxxpCode fixing a cart total rounding bug, with an approved plan, the applied code diff, and three passing tests."
            width={2200}
            height={2100}
            decoding="async"
            className="block h-auto w-full"
          />
        </figure>

        <section className="mt-14 w-full max-w-2xl">
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">Native Rust. Nothing bundled.</h2>
          <div className="mt-6 grid grid-cols-3 divide-x divide-border border-y border-border">
            {[
              { value: "3.6 MB", label: "engine size", others: "80–300 MB" },
              { value: "<5 ms", label: "cold start", others: "seconds" },
              { value: "4 MB", label: "idle memory", others: "100–400 MB" },
            ].map((s) => (
              <div key={s.label} className="flex flex-col items-center px-2 py-6">
                <p className="font-mono text-[20px] font-medium tracking-tight">{s.value}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">{s.label}</p>
                <p className="mt-2 font-mono text-[11px] text-muted-foreground/70">
                  <span className="block sm:inline">others </span>
                  <span className="whitespace-nowrap">{s.others}</span>
                </p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[12px] text-muted-foreground">
            Compared with agents that bundle Electron, Node or Bun.
          </p>
        </section>

        <Reliability />
      </main>
    </div>
  );
}

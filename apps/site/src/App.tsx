import { useEffect, useState } from "react";
import { ArrowDown, Moon, Sun } from "lucide-react";
import { GitHubStars } from "./components/GitHubStars";
import { Logo } from "./components/Logo";
import { PlatformIcon, type Platform } from "./components/PlatformIcon";
import Changelog from "./Changelog";
import Devs from "./Devs";
import Docs from "./Docs";
import Notes from "./Notes";
import Pricing, { PricingSuccess } from "./Pricing";

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
        {" · "}
        <a href="/pricing" className={quiet}>
          Pricing →
        </a>
        {" · "}
        <a href="https://developers.dxxp.codes" className={quiet}>
          Developer API →
        </a>
      </p>
    </div>
  );
}

function Header({ dark, setDark }: { dark: boolean; setDark: (d: boolean) => void }) {
  return (
    <header className="grid h-16 grid-cols-3 items-center px-6">
      <span />
      <a href="/" className="justify-self-center" aria-label="DxxpCode">
        <Logo className="h-[18px] w-auto" />
      </a>
      <nav className="flex items-center gap-5 justify-self-end text-[13px] text-muted-foreground">
        <button
          onClick={() => setDark(!dark)}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="-mr-2 p-2 transition-colors hover:text-foreground"
        >
          {dark ? <Sun strokeWidth={1.5} className="h-4 w-4" /> : <Moon strokeWidth={1.5} className="h-4 w-4" />}
        </button>
      </nav>
    </header>
  );
}

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  // developers.dxxp.codes is the devs site: root serves the devs page,
  // /notes serves engineering notes. Other paths fall through to /devs-style
  // routing so existing links keep working.
  const path = window.location.pathname;
  const devHost = window.location.hostname === "developers.dxxp.codes";
  // Devs content lives exclusively at developers.dxxp.codes: /devs* on any
  // host forwards there with the prefix stripped.
  if (path.startsWith("/devs")) {
    window.location.replace(`https://developers.dxxp.codes${path.replace(/^\/devs/, "") || "/"}`);
    return null;
  }
  if (devHost && (path === "/notes" || path.startsWith("/notes/"))) return <Notes />;
  if (devHost && !path.startsWith("/docs") && !path.startsWith("/changelog")) return <Devs />;
  if (window.location.pathname.startsWith("/docs")) return <Docs />;
  if (window.location.pathname.startsWith("/changelog")) return <Changelog />;
  if (path === "/pricing" || path === "/pricing/success") {
    return (
      <div className="flex min-h-[100svh] flex-col bg-background">
        <Header dark={dark} setDark={setDark} />
        {path === "/pricing" ? <Pricing /> : <PricingSuccess />}
      </div>
    );
  }

  return (
    <div className="flex min-h-[100svh] flex-col bg-background">
      <Header dark={dark} setDark={setDark} />

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

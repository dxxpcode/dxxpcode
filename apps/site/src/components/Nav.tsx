import { Moon, Sun } from "lucide-react";
import { Logo } from "./Logo";

export const GITHUB_URL = "https://github.com/dxxpcode";

const LINKS = [
  ["/", "Projects"],
  ["/download", "Download"],
  ["/docs", "Docs"],
  ["/changelog", "Changelog"],
] as const;

// Projects and Download live on the main site: developers.dxxp.codes serves
// its own Devs page for those paths, so on the dev host these links must
// leave for dxxp.codes. Everywhere else they stay relative so previews and
// local dev keep their own pages.
const MAIN_SITE_ONLY = new Set(["/", "/download"]);
const toMainSite = (href: string) =>
  window.location.hostname === "developers.dxxp.codes" && MAIN_SITE_ONLY.has(href)
    ? `https://dxxp.codes${href}`
    : href;

export function Nav({
  dark,
  onToggleTheme,
}: {
  dark: boolean;
  onToggleTheme: () => void;
}) {
  const path = window.location.pathname;
  return (
    <div className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-xl backdrop-saturate-150">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2.5">
          <Logo className="h-4 w-auto" />
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">DxxpCode</span>
        </a>
        <div className="flex items-center gap-5 sm:gap-6">
          {LINKS.map(([href, label]) => {
            const url = toMainSite(href);
            const active = url === "/" ? path === "/" : url.startsWith("/") && path.startsWith(url);
            return (
              <a
                key={href}
                href={url}
                className={
                  active
                    ? "text-sm text-foreground"
                    : "text-sm text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {label}
              </a>
            );
          })}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <button
            onClick={onToggleTheme}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="-mr-2 rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            {dark ? <Sun strokeWidth={1.5} className="h-4 w-4" /> : <Moon strokeWidth={1.5} className="h-4 w-4" />}
          </button>
        </div>
      </nav>
    </div>
  );
}

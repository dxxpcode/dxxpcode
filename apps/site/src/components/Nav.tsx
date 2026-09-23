import { Moon, Sun } from "lucide-react";

export const GITHUB_URL = "https://github.com/thenextdeveloper/DxxpCode-Terminal";

const LINKS = [
  ["/docs", "Docs"],
  ["/changelog", "Changelog"],
] as const;

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
          <img src={dark ? "/logo-dark.png" : "/logo.png"} alt="DxxpCode" className="h-4 w-auto" />
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">DxxpCode</span>
        </a>
        <div className="flex items-center gap-5 sm:gap-6">
          {LINKS.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className={
                path.startsWith(href)
                  ? "text-sm text-foreground"
                  : "text-sm text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              {label}
            </a>
          ))}
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
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </nav>
    </div>
  );
}

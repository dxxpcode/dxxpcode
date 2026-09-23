import { Moon, Sun } from "lucide-react";

export const GITHUB_URL = "https://github.com/thenextdeveloper/DxxpCode-Terminal";

export function Nav({
  dark,
  onToggleTheme,
}: {
  dark: boolean;
  onToggleTheme: () => void;
}) {
  const onDocs = window.location.pathname.startsWith("/docs");
  return (
    <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
      <a href="/" className="flex items-center gap-2.5">
        <img src={dark ? "/logo-dark.png" : "/logo.png"} alt="DxxpCode" className="h-[17px] w-auto" />
        <span className="text-[15px] font-semibold tracking-tight">DxxpCode</span>
      </a>
      <div className="flex items-center gap-5">
        <a
          href="/docs"
          className={
            onDocs
              ? "text-[15px] font-medium text-foreground"
              : "text-[15px] text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          Docs
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[15px] text-muted-foreground transition-colors hover:text-foreground"
        >
          GitHub
        </a>
        <button
          onClick={onToggleTheme}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
      </div>
    </nav>
  );
}

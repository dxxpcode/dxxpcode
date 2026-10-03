import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Moon, Sun } from "lucide-react";
import { Logo } from "./components/Logo";
import { POSTS, type Post } from "./posts";

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, setDark };
}

type SetDark = (d: boolean | ((v: boolean) => boolean)) => void;

function Header({ dark, setDark }: { dark: boolean; setDark: SetDark }) {
  return (
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
  );
}

function Shell({ children, dark, setDark }: { children: ReactNode; dark: boolean; setDark: SetDark }) {
  return (
    <div className="flex min-h-[100svh] flex-col bg-background">
      <Header dark={dark} setDark={setDark} />
      <main className="flex flex-1 flex-col items-center px-6 pb-16 pt-10 text-center">{children}</main>
    </div>
  );
}

export default function Notes() {
  const { dark, setDark } = useTheme();
  const slug = window.location.pathname.replace(/^\/(devs\/)?notes\/?/, "").replace(/\/$/, "");
  const post = POSTS.find((p) => p.slug === slug);
  if (post) return <NotePost post={post} dark={dark} setDark={setDark} />;

  return (
    <Shell dark={dark} setDark={setDark}>
      <p className="font-mono text-[12px] text-muted-foreground">DxxpDevs · Notes</p>
      <h1 className="mt-2 text-balance text-[28px] font-medium leading-tight tracking-[-0.02em] sm:text-[32px]">
        Engineering{" "}
        <span className="bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
          deep dives
        </span>
      </h1>
      <p className="mt-4 max-w-2xl text-pretty text-[14px] leading-relaxed text-muted-foreground">
        How the agent loop, the tools, and the safety boundaries actually work — written by the code
        that ships them.
      </p>

      <div className="mt-14 w-full max-w-2xl divide-y divide-border border-y border-border text-left">
        {POSTS.map((p) => (
          <a key={p.slug} href={`/notes/${p.slug}`} className="group block py-5">
            <p className="font-mono text-[11px] text-muted-foreground">
              {p.date} · {p.tag} · {p.minutes} min
            </p>
            <p className="mt-1.5 text-[15px] font-medium tracking-[-0.01em] transition-colors group-hover:text-foreground/80">
              {p.title}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{p.dek}</p>
          </a>
        ))}
      </div>
    </Shell>
  );
}

function NotePost({ post, dark, setDark }: { post: Post; dark: boolean; setDark: SetDark }) {
  const Body = post.body;
  return (
    <Shell dark={dark} setDark={setDark}>
      <a
        href="/notes"
        className="inline-flex items-center gap-1.5 self-center font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" />
        Notes
      </a>
      <p className="mt-6 font-mono text-[12px] text-muted-foreground">
        {post.date} · {post.tag} · {post.minutes} min
      </p>
      <h1 className="mt-2 max-w-2xl text-balance text-[28px] font-medium leading-tight tracking-[-0.02em] sm:text-[32px]">
        {post.title}
      </h1>
      <div className="prose-site mt-10 w-full max-w-2xl text-left">
        <Body />
      </div>
      <p className="mt-14 w-full max-w-2xl border-t border-border pt-6 font-mono text-[12px] text-muted-foreground">
        DxxpDevs · <a href="/" className="transition-colors hover:text-foreground">API quickstart →</a>
      </p>
    </Shell>
  );
}

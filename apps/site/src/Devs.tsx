import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { POSTS, type Post } from "./posts";
import { AgentLoop } from "./posts/agent-loop";
import { EditsThatDontFail } from "./posts/edits-that-dont-fail";

const BODIES: Record<string, () => React.ReactNode> = {
  "the-agent-loop-is-the-product": AgentLoop,
  "edits-that-dont-fail": EditsThatDontFail,
};

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

function Row({ post }: { post: Post }) {
  const written = post.slug in BODIES;
  const cls = "block border-b border-border py-5 transition-opacity last:border-b-0";
  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-[15px] font-medium tracking-[-0.01em]">{post.title}</p>
        <p className="shrink-0 font-mono text-[11px] text-muted-foreground">{post.minutes} min</p>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{post.dek}</p>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground/70">
        {post.date} · {post.tag}
        {!written && " · coming soon"}
      </p>
    </>
  );
  if (!written) return <div className={`${cls} opacity-60`}>{inner}</div>;
  return (
    <a href={`/devs/${post.slug}`} className={`${cls} hover:opacity-70`}>
      {inner}
    </a>
  );
}

export default function Devs() {
  const { dark, toggle } = useTheme();
  const slug = window.location.pathname.replace(/^\/devs\/?/, "").replace(/\/$/, "");
  const post = POSTS.find((p) => p.slug === slug);
  const Body = post ? BODIES[post.slug] : undefined;

  return (
    <div className="min-h-screen bg-background">
      <Nav dark={dark} onToggleTheme={toggle} />
      <main className="mx-auto max-w-2xl px-6 pb-16 pt-12">
        {post && Body ? (
          <>
            <a
              href="/devs"
              className="font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              ← Devs
            </a>
            <h1 className="mt-6 text-balance text-[26px] font-medium leading-tight tracking-[-0.02em]">
              {post.title}
            </h1>
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              {post.date} · {post.tag} · {post.minutes} min read
            </p>
            <div className="prose mt-8 space-y-4 text-[15px] leading-7 text-muted-foreground [&_code]:rounded-md [&_code]:bg-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h2]:pt-4 [&_h2]:text-[17px] [&_h2]:font-medium [&_h2]:tracking-tight [&_h2]:text-foreground [&_h3]:pt-3 [&_h3]:text-[15px] [&_h3]:font-medium [&_h3]:text-foreground">
              <Body />
            </div>
          </>
        ) : (
          <>
            <h1 className="text-[26px] font-medium tracking-[-0.02em]">Devs</h1>
            <p className="mt-3 max-w-lg text-[15px] leading-7 text-muted-foreground">
              Engineering notes from building DxxpCode — the agent loop, the tools, and the
              reliability work behind both.
            </p>
            <div className="mt-8">
              {POSTS.map((p) => (
                <Row key={p.slug} post={p} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

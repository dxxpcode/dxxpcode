import { useId } from "react";
import { ArrowUpRight, ChevronDown, Folder, GitBranch } from "lucide-react";
import type { ReadyInfo } from "../types";
import type { SessionSummary } from "../lib/home-layout";
import { sessionDetail, sessionTimestamp } from "../lib/home-layout";
import { sessionAge } from "../lib/sidebar-layout";
import { Logo } from "../transcript";
import { Button } from "./ui/button";

export function HomeHeader({ project, onOpenProject }: {
  project: ReadyInfo["project"];
  onOpenProject: () => void;
}) {
  return (
    <section className="home-intro" aria-labelledby="home-title">
      <Logo className="home-mark" />
      <div className="home-context">
        <Button type="button" variant="ghost" className="home-project" onClick={onOpenProject}
          title={`Change project: ${project.name}`} aria-label={`Change project: ${project.name}`}>
          <Folder size={13} aria-hidden="true" />
          <span className="truncate">{project.name}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </Button>
        {project.git && <span className="home-branch" title={`${project.git.branch}${project.git.dirty ? " · Uncommitted changes" : ""}`}>
          <GitBranch size={12} aria-hidden="true" />
          <span className="truncate">{project.git.branch}</span>
          {project.git.dirty && <span className="home-dirty" role="img" aria-label="Uncommitted changes" />}
        </span>}
      </div>
      <h1 id="home-title">What should we build?</h1>
      <p>Start something new, or pick up where you left off.</p>
    </section>
  );
}

export function HomeSessions({ sessions, loaded, onResume, onViewAll }: {
  sessions: SessionSummary[];
  loaded: boolean;
  onResume: (id: string) => void;
  onViewAll: () => void;
}) {
  const id = useId();
  if (!loaded || !sessions.length) return (
    <div className="home-recent home-empty" role="status" aria-busy={!loaded}>
      <p>{loaded ? "Your recent sessions will appear here after your first task." : "Loading recent sessions…"}</p>
    </div>
  );

  return (
    <section className="home-recent" aria-labelledby="home-recent-title">
      <div className="home-recent-head">
        <h2 id="home-recent-title">Continue</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onViewAll}>View all<ArrowUpRight size={12} aria-hidden="true" /></Button>
      </div>
      <ul className="home-session-grid">
        {sessions.map((session) => {
          const title = session.title.trim() || session.task?.trim() || "Untitled session";
          const timestamp = sessionTimestamp(session);
          const age = sessionAge(timestamp);
          const detail = sessionDetail(session);
          const metaId = `${id}-${session.id}-meta`;
          return (
            <li key={session.id}>
              <Button type="button" variant="ghost" className="home-session" onClick={() => onResume(session.id)}
                title={title} aria-label={`Resume ${title}`} aria-describedby={age || detail ? metaId : undefined}>
                <span className="home-session-top">
                  <span className="home-session-title">{title}</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </span>
                {(age || detail) && <span className="home-session-meta" id={metaId}>
                  {age && timestamp && <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
                    {age === "now" ? "Just now" : `${age} ago`}
                  </time>}
                  {age && detail && <span aria-hidden="true">·</span>}
                  {detail && <span>{detail}</span>}
                </span>}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

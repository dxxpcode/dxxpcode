import { useId } from "react";
import { ArrowRight, ChevronDown, Folder, GitBranch } from "lucide-react";
import type { ReadyInfo } from "../types";
import type { SessionSummary } from "../lib/home-layout";
import { sessionDetail, sessionTimestamp } from "../lib/home-layout";
import { sessionAge } from "../lib/sidebar-layout";
import { Button } from "./ui/button";

export function HomeHeader({ project, onOpenProject }: {
  project: ReadyInfo["project"];
  onOpenProject: () => void;
}) {
  return (
    <section className="home-intro" aria-labelledby="home-title">
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
      <h1 id="home-title">What’s next?</h1>
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
  if (!loaded) return (
    <div className="home-recent home-empty" role="status" aria-busy={!loaded}>
      <p>Loading recent sessions…</p>
    </div>
  );
  if (!sessions.length) return null;

  return (
    <section className="home-recent" aria-labelledby="home-recent-title">
      <div className="home-recent-head">
        <h2 id="home-recent-title">Recent work</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onViewAll}>All sessions<ArrowRight size={12} aria-hidden="true" /></Button>
      </div>
      <ul className="home-session-list">
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
                <span className="home-session-copy">
                  <span className="home-session-title">{title}</span>
                  {detail && <span className="home-session-detail">{detail}</span>}
                </span>
                <span className="home-session-meta" id={metaId}>
                  {detail && <span className="sr-only">{detail}</span>}
                  {age && timestamp && <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
                    {age === "now" ? "Just now" : `${age} ago`}
                  </time>}
                  <ArrowRight size={14} aria-hidden="true" />
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

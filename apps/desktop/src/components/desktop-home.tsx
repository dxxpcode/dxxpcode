import { ArrowUpRight, ChevronDown, Folder, GitBranch } from "lucide-react";
import type { ReadyInfo } from "../types";
import type { SessionSummary } from "../lib/home-layout";
import { sessionDetail } from "../lib/home-layout";
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
        <Button variant="ghost" className="home-project" onClick={onOpenProject}
          title="Change project" aria-label={`Change project: ${project.name}`}>
          <Folder size={13} aria-hidden="true" />
          <span className="truncate">{project.name}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </Button>
        {project.git && <span className="home-branch" title={`${project.git.branch}${project.git.dirty ? " · Uncommitted changes" : ""}`}>
          <GitBranch size={12} aria-hidden="true" />
          <span className="truncate">{project.git.branch}{project.git.dirty ? "*" : ""}</span>
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
  if (!loaded || !sessions.length) return (
    <div className="home-recent home-empty" role="status">
      {loaded ? "Your recent sessions will appear here after your first task." : "Loading recent sessions…"}
    </div>
  );

  return (
    <section className="home-recent" aria-labelledby="home-recent-title">
      <div className="home-recent-head">
        <h2 id="home-recent-title">Continue</h2>
        <Button variant="ghost" size="sm" onClick={onViewAll}>View all<ArrowUpRight size={12} aria-hidden="true" /></Button>
      </div>
      <ul className="home-session-grid">
        {sessions.map((session) => {
          const title = session.title.trim() || session.task?.trim() || "Untitled session";
          const age = sessionAge(session.when);
          const detail = sessionDetail(session);
          return (
            <li key={session.id}>
              <Button variant="ghost" className="home-session" onClick={() => onResume(session.id)}
                title={title} aria-label={`Resume ${title}`}>
                <span className="home-session-top">
                  <span className="home-session-title">{title}</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </span>
                {(age || detail) && <span className="home-session-meta">
                  {age && <time dateTime={session.when?.replace(" ", "T")} title={session.when}>
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

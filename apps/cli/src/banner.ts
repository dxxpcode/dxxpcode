import type { ProjectInfo } from "@dxxpcode/project";
import type { SessionRecord } from "@dxxpcode/sessions";
import { homedir } from "node:os";
import { FANCY, bold, cyan, dim, rule } from "./render.ts";

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  project: ProjectInfo;
  cwd: string;
  resumedSession?: SessionRecord;
}

const TIPS = [
  `Describe a task in plain language — ${dim('"fix the failing test in math.js"')}`,
  `Attach files as context inline: ${cyan("@src/math.js")} in your task`,
  `Preview without changes: ${cyan("dxxpcode --plan \"<task>\"")}`,
  `Review diffs anytime: ${cyan("/review")} in-session, or ${cyan("dxxpcode --review")}`,
  `Pick up where you left off: ${cyan("dxxpcode --resume")}`,
  `Project instructions live in ${cyan(".dxxpcode/instructions.md")} (AGENTS.md works too)`,
];

function shortHome(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Startup banner lines: logo + name/version/model + project context. */
export function renderBanner(info: BannerInfo): string[] {
  const git = info.project.git
    ? dim(` · ${info.project.git.branch}${info.project.git.dirty ? "*" : ""}`)
    : "";
  const langs = info.project.languages.length ? dim(` (${info.project.languages.join(", ")})`) : "";
  const meta = [
    bold(info.project.name) + langs + git,
    dim(shortHome(info.cwd)),
    ...(info.resumedSession
      ? [dim(`resumed ${info.resumedSession.id} (${info.resumedSession.messages.length} messages)`)]
      : []),
  ];
  return [
    bold(cyan("DxxpCode")),
    dim(`v${info.version} · ${info.provider} · ${info.model}`),
    ...meta,
  ];
}

/** "Tips for getting started" section lines (6 tips, numbered). */
export function renderTips(): string[] {
  return [
    dim(bold("Tips for getting started")),
    ...TIPS.map((t, i) => `  ${cyan(String(i + 1))}. ${t}`),
  ];
}

export function bannerRule(): string {
  return rule();
}

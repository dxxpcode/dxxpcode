import { detectProject, loadInstructions, topLevelListing } from "@dxxpcode/project";
import type { ProjectInfo } from "@dxxpcode/project";

export interface AgentContext {
  project: ProjectInfo;
  instructions: { path: string; content: string } | null;
  topLevel: string[];
  systemPrompt: string;
}

const RULES = `You are DxxpCode, a terminal-native AI coding agent. You operate inside the user's current project.

Workflow:
1. Investigate before editing — read the relevant files and tests.
2. For any non-trivial change, call propose_plan with a concise numbered plan. Do not edit during planning; only read-only tools are available then.
3. During execution, make focused edits with edit_file/write_file, then verify: run the project's test command (and build when relevant).
4. If verification fails, diagnose and fix — you have a bounded number of iterations.
5. When finished, end with a short summary: what changed and the verification outcome.

Rules:
- Keep edits minimal and consistent with existing conventions.
- Some actions require user approval or are restricted (secrets, paths outside the project, destructive commands). If a tool call is denied, accept it and find another way — do not retry identical calls.
- Never read .env files, SSH keys, or credential stores.
- Prefer running the project's own test command over ad-hoc checks.
- Be concise — the user reads this in a terminal.`;

export function gatherContext(root: string): AgentContext {
  const project = detectProject(root);
  const instructions = loadInstructions(root);
  const topLevel = topLevelListing(root);

  const lines: string[] = [RULES, "", "Project:"];
  lines.push(`- name: ${project.name}`);
  lines.push(`- root: ${project.root}`);
  if (project.languages.length) lines.push(`- languages: ${project.languages.join(", ")}`);
  if (project.packageManager) lines.push(`- package manager: ${project.packageManager}`);
  if (project.testCommand) lines.push(`- test command: ${project.testCommand}`);
  if (project.buildCommand) lines.push(`- build command: ${project.buildCommand}`);
  if (project.git) {
    lines.push(
      `- git: branch ${project.git.branch}${project.git.dirty ? " (dirty)" : " (clean)"}` +
        (project.git.aheadBehind ? `, ahead/behind ${project.git.aheadBehind}` : ""),
    );
  } else {
    lines.push("- git: not a repository");
  }
  if (topLevel.length) lines.push(`- top-level: ${topLevel.join(", ")}`);
  if (instructions) {
    lines.push("", `Project instructions (${instructions.path}):`, instructions.content);
  }

  return { project, instructions, topLevel, systemPrompt: lines.join("\n") };
}

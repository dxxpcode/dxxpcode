// Event/item model for the desktop UI, mirroring `dxxpcode --app` events.

export interface ReadyInfo {
  version: string;
  provider: string;
  model: string;
  effort?: string;
  mode: string;
  needsSetup?: boolean;
  commands?: { name: string; desc: string }[];
  project: { name: string; languages: string[]; git?: { branch: string; dirty: boolean } | null };
}

export interface MenuState {
  id: number;
  title: string;
  options: { label: string; desc?: string }[];
  current?: number;
  answered?: number;
}

export interface PromptState {
  id: number;
  title: string;
  secret?: boolean;
}

export interface Todo { status: string; content: string; activeForm?: string }
export interface Plan { summary: string; steps: string[]; trivial?: boolean }

export type Item =
  | { k: "user"; text: string }
  | { k: "text"; text: string; interrupted?: boolean }
  | { k: "think"; text: string; live?: boolean; startedAt?: number; ms?: number }
  | { k: "tool"; tool: string; arg: string; out?: string; isError?: boolean; diff?: string; pending: boolean; startedAt?: number; think?: { text: string; ms?: number } }
  | { k: "plan"; plan: Plan }
  | { k: "todos"; items: Todo[] }
  | { k: "note"; text: string; steer?: boolean }
  | { k: "denied"; tool: string; reason: string }
  | { k: "done"; status: string; summary: string; filesChanged: string[]; secs?: number; tokens?: number }
  | { k: "table"; title: string; rows: [string, string][] }
  | { k: "markdown"; title: string; text: string }
  | { k: "diffcard"; title: string; diff: string }
  | { k: "raw"; text: string };

export interface Approval {
  id: number;
  kind: "plan" | "tool";
  tool?: string;
  summary: string;
  reason?: string;
  allowAlways: boolean;
  extraChoice?: { choice: string; label: string };
  answered?: string;
}

export const TOOL_DISPLAY: Record<string, string> = {
  read_file: "Read", write_file: "Write", edit_file: "Edit", delete_file: "Delete",
  list_directory: "List", search_files: "Search", run_command: "Bash",
  run_background: "Bash ⧗", check_process: "Proc", kill_process: "Kill",
  git_status: "Git", git_diff: "Git", git_log: "Git",
  propose_plan: "Plan", todo_write: "Checklist",
};

export const TOOL_ICONS: Record<string, string> = {
  read_file: "→", write_file: "←", edit_file: "←", delete_file: "✗",
  list_directory: "≡", search_files: "✱", run_command: "$", run_background: "$",
  check_process: "⌾", kill_process: "✗",
  git_status: "⑂", git_diff: "⑂", git_log: "⑂",
  propose_plan: "◇", todo_write: "☰",
};

export const TOOL_FAMILY: Record<string, string> = {
  read_file: "reads", list_directory: "reads", search_files: "reads",
  write_file: "writes", edit_file: "writes",
  delete_file: "danger", kill_process: "danger",
  run_command: "shell", run_background: "shell", check_process: "shell",
  git_status: "git", git_diff: "git", git_log: "git",
  propose_plan: "planx", todo_write: "planx",
};

export function toolArg(input: Record<string, unknown>): string {
  const cand = input["path"] ?? input["command"] ?? input["pattern"] ?? input["summary"];
  return typeof cand === "string" && cand.length ? cand.slice(0, 120) : "";
}

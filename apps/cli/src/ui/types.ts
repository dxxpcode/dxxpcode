import type { ApprovalRequest, RunResult } from "@dxxpcode/agent";
import type { ModelProvider, ReasoningEffort, TodoItem } from "@dxxpcode/providers";
import type { ProjectInfo } from "@dxxpcode/project";
import type { SessionRecord } from "@dxxpcode/sessions";
import type { DiffRow } from "./diff.ts";

export type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "pill"; text: string }
  | { id: number; kind: "note"; text: string }
  | { id: number; kind: "thought"; secs: number }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "tool"; name: string; arg: string }
  | { id: number; kind: "result"; text: string; isError: boolean }
  | { id: number; kind: "tree"; lines: string[] }
  | { id: number; kind: "plan"; summary?: string; steps: string[] }
  | { id: number; kind: "todo"; items: TodoItem[] }
  | { id: number; kind: "diff"; path: string; rows: DiffRow[] }
  | { id: number; kind: "denied"; reason: string }
  | { id: number; kind: "status"; rows: [string, string][] }
  | { id: number; kind: "footer"; result: RunResult; secs: number }
  | { id: number; kind: "error"; text: string };

export type ItemInput = Item extends infer T
  ? T extends Item
    ? Omit<T, "id">
    : never
  : never;

export type Pending =
  | { kind: "input" }
  | { kind: "plan"; resolve: (ok: boolean) => void }
  | { kind: "tool"; req: ApprovalRequest; key: string; resolve: (v: "y" | "a" | "n") => void }
  | {
      kind: "config";
      title: string;
      options: string[];
      descs?: string[];
      resolve: (i: number | null) => void;
      /** When set, renders a tab bar; `tab` is the active pane (0 = the menu). */
      tabs?: string[];
      tab?: number;
    }
  | { kind: "prompt"; title: string; resolve: (v: string | null) => void };

export interface AppProps {
  version: string;
  provider: ModelProvider;
  model: string;
  effort?: ReasoningEffort;
  project: ProjectInfo;
  root: string;
  session?: SessionRecord;
  planOnly: boolean;
  autoApprove: boolean;
  /** Jev-powered smart approvals (approvalMode "smart" + TYPESAFE_API_KEY). */
  smartApprove?: boolean;
  maxIterations?: number;
  /** First task for one-shot runs; App exits after it finishes. */
  task?: string;
  /** Session-scoped "always allow" keys shared across tasks. */
  allowlist: Set<string>;
  /** Persistent input history (REPL only). */
  historyFile?: string;
  /** Working-tree diff for /review. */
  getReviewDiff?: () => string;
  onExit: (code: number) => void;
  /** Called with the session id after each run so `--resume` chains. */
  onSession: (id: string) => void;
  /** Resolves to a newer published version, if one exists. */
  updateCheck?: Promise<string | null>;
}

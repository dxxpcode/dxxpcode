import { str } from "./types.ts";
import type { AgentTool, ToolResult } from "./types.ts";
import type { TodoItem } from "@dxxpcode/providers";
import { fileTools } from "./fs.ts";
import { searchFiles } from "./search.ts";
import { runCommand } from "./shell.ts";
import { gitDiff, gitLog, gitStatus } from "./git.ts";

/**
 * Plan-phase marker tool. The runtime intercepts it — it never "executes"
 * anything; it carries the proposed plan back to the caller.
 */
export const proposePlan: AgentTool = {
  name: "propose_plan",
  description:
    "Present the implementation plan to the user for approval. Call this once investigation is complete. " +
    "Set trivial=true only for changes small enough to skip approval (typo fixes, one-line edits).",
  planPhase: true,
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One-sentence summary of the change" },
      steps: { type: "array", items: { type: "string" }, description: "Ordered implementation steps" },
      trivial: { type: "boolean", description: "True if the change is small enough to skip approval" },
    },
    required: ["summary", "steps"],
  },
  permission: () => ({ level: "safe", reason: "presenting a plan" }),
  execute: async () => ({ content: "plan recorded" }),
};

/**
 * Checklist tool. The runtime intercepts it like propose_plan — the agent
 * maintains a live task list rendered in the UI and persisted on the session.
 */
export const todoWrite: AgentTool = {
  name: "todo_write",
  description:
    "Maintain a task checklist for the current task. Call early in multi-step work with the full ordered list, " +
    "then again whenever an item starts or finishes (exactly one in_progress at a time). " +
    "Keep items concrete and verifiable; remove steps that become irrelevant.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable identifier for the item" },
            content: { type: "string", description: "Imperative description of the step" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", description: "Present-continuous label while in progress" },
          },
          required: ["id", "content", "status"],
        },
        description: "The complete checklist, in order — replaces the previous list",
      },
    },
    required: ["todos"],
  },
  permission: () => ({ level: "safe", reason: "updating the task checklist" }),
  execute: async () => ({ content: "checklist updated" }),
};

export function parseTodos(input: Record<string, unknown>): TodoItem[] {
  if (!Array.isArray(input["todos"])) throw new Error(`missing or invalid "todos"`);
  const items: TodoItem[] = [];
  for (const raw of input["todos"]) {
    if (typeof raw !== "object" || raw === null) continue;
    const it = raw as Record<string, unknown>;
    const status = it["status"];
    const content = it["content"];
    if (typeof content !== "string" || content.length === 0) continue;
    items.push({
      id: typeof it["id"] === "string" && it["id"].length > 0 ? it["id"] : `item-${items.length + 1}`,
      content,
      status: status === "in_progress" || status === "completed" ? status : "pending",
      activeForm: typeof it["activeForm"] === "string" && it["activeForm"].length > 0 ? it["activeForm"] : undefined,
    });
  }
  return items;
}

export function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return "checklist cleared";
  return items
    .map((it) => {
      const box = it.status === "completed" ? "[x]" : it.status === "in_progress" ? "[>]" : "[ ]";
      return `${box} ${it.content}`;
    })
    .join("\n");
}

export interface ProposedPlan {
  summary: string;
  steps: string[];
  trivial: boolean;
}

export function parsePlan(input: Record<string, unknown>): ProposedPlan {
  const steps = Array.isArray(input["steps"])
    ? input["steps"].map((s) => String(s)).filter((s) => s.length > 0)
    : [];
  return {
    summary: str(input, "summary"),
    steps,
    trivial: input["trivial"] === true,
  };
}

const ALL_TOOLS: AgentTool[] = [
  proposePlan,
  todoWrite,
  ...fileTools,
  searchFiles,
  runCommand,
  gitStatus,
  gitDiff,
  gitLog,
];

export function allTools(): AgentTool[] {
  return ALL_TOOLS;
}

export function toolsForPhase(phase: "plan" | "execute"): AgentTool[] {
  return phase === "plan" ? ALL_TOOLS.filter((t) => t.planPhase) : ALL_TOOLS;
}

export function findTool(name: string): AgentTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export interface DeniedResult extends ToolResult {
  denied?: boolean;
}

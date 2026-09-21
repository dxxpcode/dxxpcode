import { str } from "./types.ts";
import type { AgentTool, ToolResult } from "./types.ts";
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

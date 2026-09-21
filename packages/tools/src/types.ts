import type { JsonObject, ToolDefinition } from "@dxxpcode/providers";
import type { PermissionDecision } from "@dxxpcode/permissions";

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Set for file-mutating tools so the runtime can report changed files. */
  changedFile?: string;
}

export interface ToolContext {
  /** Project root — every filesystem and shell action is jailed here. */
  root: string;
  signal?: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Whether the tool is available in the plan phase (read-only + propose_plan). */
  planPhase: boolean;
  /** Classify the input before execution. */
  permission(input: JsonObject, ctx: ToolContext): PermissionDecision;
  execute(input: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}

export function toDefinition(tool: AgentTool): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export function str(input: JsonObject, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing or invalid "${key}"`);
  return v;
}

export function optStr(input: JsonObject, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function optNum(input: JsonObject, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

import type { PermissionDecision } from "@dxxpcode/permissions";
import type {
  ContentBlock,
  JsonObject,
  Message,
  ModelProvider,
  TextBlock,
  ToolUseBlock,
  Usage,
} from "@dxxpcode/providers";
import { findTool, parsePlan, toDefinition, toolsForPhase } from "@dxxpcode/tools";
import type { AgentTool, ProposedPlan, ToolContext, ToolResult } from "@dxxpcode/tools";
import { newSessionId, saveSession } from "@dxxpcode/sessions";
import type { RecordedToolCall, SessionRecord } from "@dxxpcode/sessions";
import { execFileSync } from "node:child_process";
import { gatherContext } from "./context.ts";

export interface ApprovalRequest {
  tool: string;
  input: JsonObject;
  decision: PermissionDecision;
  /** Model-provided reason (e.g. run_command's "reason" arg). */
  reason?: string;
}

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "plan"; plan: ProposedPlan }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "tool_start"; tool: string; input: JsonObject }
  | { type: "tool_end"; tool: string; result: ToolResult }
  | { type: "denied"; tool: string; reason: string }
  | { type: "done"; result: RunResult };

export interface RunResult {
  status: "completed" | "denied" | "max_iterations" | "cancelled" | "error" | "plan_only";
  summary: string;
  filesChanged: string[];
  commands: string[];
  toolCalls: number;
  plan?: ProposedPlan;
  diffStat?: string;
  error?: string;
  sessionId: string;
}

export interface RunOptions {
  task: string;
  provider: ModelProvider;
  model: string;
  projectRoot: string;
  planOnly?: boolean;
  maxIterations?: number;
  /** Approver for approval-tier actions. Undefined → auto-deny. */
  approveTool?: (req: ApprovalRequest) => Promise<boolean>;
  /** Approver for plans. Undefined → auto-approve only trivial plans. */
  approvePlan?: (plan: ProposedPlan) => Promise<boolean>;
  /** Resume an existing session (messages restored). */
  session?: SessionRecord;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ITERATIONS = 40;

export async function* runTask(opts: RunOptions): AsyncGenerator<AgentEvent> {
  const { provider, model, projectRoot } = opts;
  const env = opts.env ?? process.env;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const ctx: ToolContext = { root: projectRoot, signal: opts.signal };

  const context = gatherContext(projectRoot);
  yield { type: "status", message: "Inspecting project…" };

  const session: SessionRecord =
    opts.session ??
    ({
      version: 1,
      id: newSessionId(projectRoot),
      projectRoot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      task: opts.task,
      messages: [],
      toolCalls: [],
      filesChanged: [],
      commands: [],
    } satisfies SessionRecord);

  const persist = () => {
    session.updatedAt = new Date().toISOString();
    saveSession(session, env);
  };

  const messages: Message[] = session.messages;
  repairTail(messages);
  if (opts.task) {
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      // Resumed session already ends on a user turn — keep roles alternating.
      last.content.push({ type: "text", text: `\n\n${opts.task}` });
    } else {
      messages.push({ role: "user", content: [{ type: "text", text: opts.task }] });
    }
  }

  const stats = { toolCalls: 0 };
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const finish = (result: RunResult): { type: "done"; result: RunResult } => {
    session.result = result.summary;
    persist();
    return { type: "done", result };
  };
  const base = (status: RunResult["status"]): RunResult => ({
    status,
    summary: "",
    filesChanged: [...session.filesChanged],
    commands: [...session.commands],
    toolCalls: stats.toolCalls,
    sessionId: session.id,
  });

  try {
    /* ------------------------------ PLAN PHASE ------------------------------ */
    let approved = false;
    let plan: ProposedPlan | undefined;
    let iterations = 0;

    while (!approved) {
      if (opts.signal?.aborted) {
        yield finish({ ...base("cancelled"), summary: "Cancelled" });
        return;
      }
      const turn = yield* streamTurn(provider, model, context.systemPrompt, messages, "plan", opts.signal);
      mergeUsage(usage, turn.usage);

      const planCall = turn.toolCalls.find((c) => c.name === "propose_plan");
      if (planCall) {
        const results = yield* runPlanPhaseTools(turn.toolCalls, planCall, ctx, session, stats);
        appendToolResults(messages, results);
        plan = parsePlan(planCall.input);
        yield { type: "plan", plan };
        if (plan.trivial) {
          approved = true;
        } else if (opts.planOnly) {
          yield finish({ ...base("plan_only"), summary: plan.summary, plan });
          return;
        } else if (opts.approvePlan && (await opts.approvePlan(plan))) {
          approved = true;
        } else {
          yield finish({ ...base("denied"), summary: "Plan not approved", plan });
          return;
        }
      } else if (turn.toolCalls.length > 0) {
        const results = yield* runPlanPhaseTools(turn.toolCalls, undefined, ctx, session, stats);
        appendToolResults(messages, results);
      } else {
        yield finish({ ...base("completed"), summary: lastAssistantText(messages) || "Done" });
        return;
      }
      if (++iterations >= maxIterations) {
        yield finish({ ...base("max_iterations"), summary: "Planning iteration limit reached" });
        return;
      }
    }

    iterations = 0;
    if (opts.planOnly) {
      yield finish({ ...base("plan_only"), summary: plan?.summary ?? "Done", plan });
      return;
    }
    if (plan) {
      messages.push({ role: "user", content: [{ type: "text", text: "Plan approved. Execute it now." }] });
    }

    /* ----------------------------- EXECUTE PHASE ---------------------------- */
    while (true) {
      if (opts.signal?.aborted) {
        yield finish({ ...base("cancelled"), summary: "Cancelled" });
        return;
      }
      const turn = yield* streamTurn(provider, model, context.systemPrompt, messages, "execute", opts.signal);
      mergeUsage(usage, turn.usage);

      if (turn.toolCalls.length === 0) {
        yield finish({
          ...base("completed"),
          summary: lastAssistantText(messages) || "Done",
          diffStat: gitDiffStat(projectRoot) ?? undefined,
        });
        return;
      }

      const results: ContentBlock[] = [];
      for (const call of turn.toolCalls) {
        stats.toolCalls++;
        const tool = findTool(call.name);
        if (!tool || tool.name === "propose_plan") {
          yield { type: "denied", tool: call.name, reason: "unknown tool" };
          session.toolCalls.push(record(call, true, false));
          results.push({ type: "tool_result", toolUseId: call.id, content: `unknown tool: ${call.name}`, isError: true });
          continue;
        }
        const decision = tool.permission(call.input, ctx);
        if (decision.level === "restricted") {
          session.toolCalls.push(record(call, true, true));
          yield { type: "denied", tool: call.name, reason: decision.reason };
          results.push({ type: "tool_result", toolUseId: call.id, content: `denied: ${decision.reason}`, isError: true });
          continue;
        }
        if (decision.level === "approval") {
          const req: ApprovalRequest = {
            tool: call.name,
            input: call.input,
            decision,
            reason: typeof call.input["reason"] === "string" ? call.input["reason"] : undefined,
          };
          yield { type: "approval_request", request: req };
          if (!(opts.approveTool && (await opts.approveTool(req)))) {
            session.toolCalls.push(record(call, true, true));
            yield { type: "denied", tool: call.name, reason: "not approved" };
            results.push({ type: "tool_result", toolUseId: call.id, content: "denied by user", isError: true });
            continue;
          }
        }
        yield { type: "tool_start", tool: call.name, input: call.input };
        const result = await executeTool(tool, call.input, ctx);
        if (call.name === "run_command" && typeof call.input["command"] === "string") {
          session.commands.push(call.input["command"]);
        }
        if (result.changedFile && !session.filesChanged.includes(result.changedFile)) {
          session.filesChanged.push(result.changedFile);
        }
        session.toolCalls.push({
          name: call.name,
          input: call.input,
          isError: result.isError,
          changedFile: result.changedFile,
        });
        persist();
        yield { type: "tool_end", tool: call.name, result };
        results.push({ type: "tool_result", toolUseId: call.id, content: result.content, isError: result.isError });
      }
      appendToolResults(messages, results);

      if (++iterations >= maxIterations) {
        yield finish({ ...base("max_iterations"), summary: "Iteration limit reached" });
        return;
      }
    }
  } catch (err) {
    yield finish({
      ...base("error"),
      summary: "Failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/* --------------------------------- helpers -------------------------------- */

interface TurnOutcome {
  toolCalls: ToolUseBlock[];
  stopReason: string;
  usage?: Usage;
}

/**
 * Stream one provider call. Emits text events to the caller and appends the
 * completed assistant message (text + tool_use blocks) to `messages`.
 */
async function* streamTurn(
  provider: ModelProvider,
  model: string,
  system: string,
  messages: Message[],
  phase: "plan" | "execute",
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, TurnOutcome> {
  const tools = toolsForPhase(phase).map(toDefinition);
  const toolCalls: ToolUseBlock[] = [];
  const textParts: string[] = [];
  let stopReason = "end_turn";
  let usage: Usage | undefined;

  for await (const ev of provider.chat({ system, messages, tools, model }, signal)) {
    if (ev.type === "text") {
      textParts.push(ev.text);
      yield { type: "text", text: ev.text };
    } else if (ev.type === "tool_use") {
      toolCalls.push(ev.call);
    } else {
      stopReason = ev.stopReason;
      usage = ev.usage;
    }
  }

  if (textParts.length || toolCalls.length) {
    const content: ContentBlock[] = [];
    if (textParts.length) content.push({ type: "text", text: textParts.join("") });
    for (const c of toolCalls) content.push(c);
    messages.push({ role: "assistant", content });
  }
  return { toolCalls, stopReason, usage };
}

function appendToolResults(messages: Message[], results: ContentBlock[]): void {
  if (results.length) messages.push({ role: "user", content: results });
}

/**
 * Resumed sessions may end mid-turn (assistant tool_use without results).
 * Close dangling tool calls so providers accept the transcript.
 */
function repairTail(messages: Message[]): void {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return;
  const dangling = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  if (!dangling.length) return;
  messages.push({
    role: "user",
    content: dangling.map((c) => ({
      type: "tool_result" as const,
      toolUseId: c.id,
      content: "interrupted before execution",
      isError: true,
    })),
  });
}

/** Execute plan-phase tool calls; the propose_plan call gets an ack result. */
async function* runPlanPhaseTools(
  toolCalls: ToolUseBlock[],
  planCall: ToolUseBlock | undefined,
  ctx: ToolContext,
  session: SessionRecord,
  stats: { toolCalls: number },
): AsyncGenerator<AgentEvent, ContentBlock[]> {
  const results: ContentBlock[] = [];
  for (const call of toolCalls) {
    if (call === planCall) {
      results.push({ type: "tool_result", toolUseId: call.id, content: "plan presented to user" });
      continue;
    }
    stats.toolCalls++;
    const tool: AgentTool | undefined = findTool(call.name);
    if (!tool || !tool.planPhase) {
      yield { type: "denied", tool: call.name, reason: "not available while planning" };
      results.push({ type: "tool_result", toolUseId: call.id, content: `tool not available while planning: ${call.name}`, isError: true });
      continue;
    }
    const decision = tool.permission(call.input, ctx);
    if (decision.level !== "safe") {
      session.toolCalls.push(record(call, true, true));
      yield { type: "denied", tool: call.name, reason: decision.reason };
      results.push({ type: "tool_result", toolUseId: call.id, content: `denied: ${decision.reason}`, isError: true });
      continue;
    }
    yield { type: "tool_start", tool: call.name, input: call.input };
    const result = await executeTool(tool, call.input, ctx);
    session.toolCalls.push({ name: call.name, input: call.input, isError: result.isError });
    yield { type: "tool_end", tool: call.name, result };
    results.push({ type: "tool_result", toolUseId: call.id, content: result.content, isError: result.isError });
  }
  return results;
}

async function executeTool(tool: AgentTool, input: JsonObject, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await tool.execute(input, ctx);
  } catch (err) {
    return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function record(call: ToolUseBlock, isError: boolean, denied: boolean): RecordedToolCall {
  return { name: call.name, input: call.input, isError, denied };
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim()) return text.trim();
    }
  }
  return "";
}

function mergeUsage(total: Usage, next?: Usage): void {
  if (!next) return;
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
}

function gitDiffStat(root: string): string | null {
  try {
    const out = execFileSync("git", ["diff", "--stat"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_PAGER: "cat" },
    }).trim();
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parts = [out, untracked ? `untracked: ${untracked.split("\n").length} file(s)` : ""].filter(Boolean);
    return parts.join("\n") || null;
  } catch {
    return null;
  }
}

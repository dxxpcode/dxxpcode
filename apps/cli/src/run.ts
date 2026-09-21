import type { AgentEvent, ApprovalRequest, RunResult } from "@dxxpcode/agent";
import type { ProposedPlan } from "@dxxpcode/tools";
import type { SessionRecord } from "@dxxpcode/sessions";
import { runTask } from "@dxxpcode/agent";
import type { ModelProvider } from "@dxxpcode/providers";
import type { Prompter } from "./prompt.ts";
import { SYM, bold, cyan, dim, errLine, green, line, red, toolLabel, write, yellow } from "./render.ts";

export interface RunCliOptions {
  task: string;
  provider: ModelProvider;
  model: string;
  projectRoot: string;
  planOnly?: boolean;
  autoApprove?: boolean;
  maxIterations?: number;
  prompter: Prompter;
  session?: SessionRecord;
  signal?: AbortSignal;
}

/** Consume a runTask event stream and render it to the terminal. */
export async function runAndRender(opts: RunCliOptions): Promise<RunResult> {
  const { prompter } = opts;
  let lastToolHeader = "";

  const approvePlan = async (plan: ProposedPlan): Promise<boolean> => {
    line();
    line(bold("Plan"));
    if (plan.summary) line(dim(plan.summary));
    plan.steps.forEach((s, i) => line(`  ${cyan(String(i + 1))}. ${s}`));
    if (opts.autoApprove) {
      line(dim("auto-approved (--yes)"));
      return true;
    }
    if (!prompter.interactive) {
      line(dim("non-interactive run — re-run with --yes to approve"));
      return false;
    }
    return prompter.confirm("Proceed? [y/N] ");
  };

  const approveTool = async (req: ApprovalRequest): Promise<boolean> => {
    line();
    line(`${yellow(SYM.warn)} The agent wants to run: ${bold(describe(req))}`);
    const reason = req.reason ?? req.decision.reason;
    if (reason) line(`  ${dim("Reason:")} ${reason}`);
    if (opts.autoApprove) {
      line(dim("  auto-approved (--yes)"));
      return true;
    }
    if (!prompter.interactive) {
      line(dim("  non-interactive run — denied; re-run with --yes to allow"));
      return false;
    }
    return prompter.confirm("  Allow? [y/N] ");
  };

  const render = (ev: AgentEvent): void => {
    switch (ev.type) {
      case "status":
        line(dim(`→ ${ev.message}`));
        break;
      case "text":
        write(ev.text);
        break;
      case "plan":
        break; // approval handled by approvePlan callback
      case "tool_start":
        lastToolHeader = `  ${cyan(SYM.run)} ${toolLabel(ev.tool, ev.input)}`;
        line(lastToolHeader);
        break;
      case "tool_end": {
        const first = ev.result.content.split("\n")[0] ?? "";
        const mark = ev.result.isError ? red(SYM.fail) : green(SYM.ok);
        line(`  ${mark} ${dim(first.slice(0, 120))}`);
        break;
      }
      case "denied":
        line(`  ${red(SYM.fail)} ${dim(`denied: ${ev.reason}`)}`);
        break;
      case "approval_request":
        break; // rendered inside approveTool
      case "done":
        break;
    }
  };

  const events = runTask({
    task: opts.task,
    provider: opts.provider,
    model: opts.model,
    projectRoot: opts.projectRoot,
    planOnly: opts.planOnly,
    maxIterations: opts.maxIterations,
    approvePlan,
    approveTool,
    session: opts.session,
    signal: opts.signal,
  });

  let result: RunResult | undefined;
  for await (const ev of events) {
    render(ev);
    if (ev.type === "done") result = ev.result;
  }
  line();
  if (result) renderResult(result);
  return result ?? { status: "error", summary: "no result", filesChanged: [], commands: [], toolCalls: 0, sessionId: "" };
}

function describe(req: ApprovalRequest): string {
  if (req.tool === "run_command") return String(req.input["command"] ?? req.tool);
  const target = req.input["path"];
  return typeof target === "string" ? `${req.tool} ${target}` : req.tool;
}

function renderResult(r: RunResult): void {
  if (r.status === "plan_only") {
    return;
  }
  const mark =
    r.status === "completed" ? green(SYM.ok) : r.status === "error" ? red(SYM.fail) : yellow(SYM.warn);
  line(`${mark} ${bold(r.status === "completed" ? "Completed" : r.status)}`);
  if (r.summary && r.status !== "completed") line(dim(r.summary));
  if (r.filesChanged.length) {
    line(`  ${dim("Changed:")}`);
    for (const f of r.filesChanged) line(`    ${f}`);
  }
  if (r.diffStat) {
    line(`  ${dim("Git:")}`);
    for (const l of r.diffStat.split("\n")) line(`    ${dim(l)}`);
  }
  if (r.error) errLine(red(r.error));
}

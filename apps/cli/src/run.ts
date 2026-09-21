import type { AgentEvent, ApprovalRequest, RunResult } from "@dxxpcode/agent";
import type { ProposedPlan } from "@dxxpcode/tools";
import type { SessionRecord } from "@dxxpcode/sessions";
import { runTask } from "@dxxpcode/agent";
import type { ModelProvider } from "@dxxpcode/providers";
import type { Prompter } from "./prompt.ts";
import {
  FANCY, SYM, bold, card, createSpinner, cyan, dim, errLine, green, line, red, resultLine, rule,
  toolLine, write, yellow,
} from "./render.ts";

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
  const t0 = Date.now();
  const spin = createSpinner();
  // Model text streams without guaranteed trailing newlines; structural
  // output (tool lines, plans, prompts) must start on a fresh line.
  let midText = false;
  // Each contiguous burst of model text opens with a ⏺ bullet.
  let textOpen = false;
  const nl = () => {
    if (midText) {
      write("\n");
      midText = false;
    }
    textOpen = false;
  };

  const approvePlan = async (_plan: ProposedPlan): Promise<boolean> => {
    nl();
    spin.stop();
    if (opts.autoApprove) {
      line(dim("auto-approved (--yes)"));
      return true;
    }
    if (!prompter.interactive) {
      line(dim("non-interactive run — re-run with --yes to approve"));
      return false;
    }
    nl();
    return prompter.confirm(`${cyan("❯")} Proceed? ${dim("[y/N]")} `);
  };

  const approveTool = async (req: ApprovalRequest): Promise<boolean> => {
    nl();
    spin.stop();
    const body = [`The agent wants to run: ${bold(describe(req))}`];
    const reason = req.reason ?? req.decision.reason;
    if (reason) body.push(dim(`Reason: ${reason}`));
    if (opts.autoApprove) {
      body.push(dim("auto-approved (--yes)"));
      for (const l of card(`${SYM.warn} Approval required`, body, yellow)) line(l);
      return true;
    }
    if (!prompter.interactive) {
      body.push(dim("non-interactive run — denied; re-run with --yes to allow"));
      for (const l of card(`${SYM.warn} Approval required`, body, yellow)) line(l);
      return false;
    }
    for (const l of card(`${SYM.warn} Approval required`, body, yellow)) line(l);
    return prompter.confirm(`${cyan("❯")} Allow? ${dim("[y/N]")} `);
  };

  // Events that precede a provider call restart the spinner; anything the
  // model produces stops it.
  const render = (ev: AgentEvent): void => {
    if (ev.type !== "text") {
      // Commit any partially-streamed text line, then clear the spinner's
      // line so structural output never collides with it.
      nl();
      spin.stop();
    }
    switch (ev.type) {
      case "status": {
        // Status feeds the live spinner label (plain line off-TTY).
        const label = /[.…]$/.test(ev.message) ? ev.message : `${ev.message}…`;
        if (FANCY) {
          spin.setLabel(label);
          spin.start(label);
        } else {
          line(dim(`· ${ev.message}`));
        }
        break;
      }
      case "text":
        spin.stop();
        if (!textOpen) {
          write(`${cyan(SYM.bullet)} `);
          textOpen = true;
        }
        write(ev.text);
        midText = true;
        break;
      case "plan": {
        const body = [
          ...(ev.plan.summary ? [dim(ev.plan.summary)] : []),
          ...ev.plan.steps.map((s, i) => `${cyan(String(i + 1))}. ${s}`),
        ];
        for (const l of card("Plan", body)) line(l);
        break;
      }
      case "tool_start":
        line(toolLine(ev.tool, ev.input));
        break;
      case "tool_end":
        line(resultLine(ev.result.content, ev.result.isError === true));
        spin.start("Thinking…");
        break;
      case "denied":
        line(`  ${red(SYM.sub)}  ${red(`Denied: ${ev.reason}`)}`);
        spin.start("Thinking…");
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

  spin.start("Thinking…");
  let result: RunResult | undefined;
  try {
    for await (const ev of events) {
      render(ev);
      if (ev.type === "done") result = ev.result;
    }
  } finally {
    spin.stop();
  }
  nl();
  line();
  if (result) renderResult(result, Date.now() - t0);
  return result ?? { status: "error", summary: "no result", filesChanged: [], commands: [], toolCalls: 0, sessionId: "" };
}

function describe(req: ApprovalRequest): string {
  if (req.tool === "run_command") return String(req.input["command"] ?? req.tool);
  const target = req.input["path"];
  return typeof target === "string" ? `${req.tool} ${target}` : req.tool;
}

function renderResult(r: RunResult, elapsedMs: number): void {
  if (r.status === "plan_only") {
    return;
  }
  const secs = (elapsedMs / 1000).toFixed(1);
  const mark =
    r.status === "completed" ? green(SYM.ok) : r.status === "error" ? red(SYM.fail) : yellow(SYM.warn);
  line(rule());
  line(`${mark} ${bold(r.status === "completed" ? "Completed" : r.status)} ${dim(`· ${secs}s`)}`);
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

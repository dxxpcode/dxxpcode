/**
 * App mode (`dxxpcode --app`): the shell protocol for the desktop app and
 * other UIs. The process speaks newline-delimited JSON instead of ANSI —
 * events on stdout, commands on stdin.
 *
 * Outbound events (one JSON object per line):
 *   {type:"ready", version, provider, model, mode, project}
 *   {type:"user", text}                       task echo
 *   AgentEvent types verbatim                 status|text|plan|tool_start|
 *                                             tool_end|todo|checkpoint|
 *                                             denied|usage|compacted|done
 *   {type:"approval", id, kind, summary, reason, allowAlways}
 *   {type:"steer", text}                      queued steering echo
 *   {type:"note", text}                       misc notes
 *   {type:"idle"}                             run finished / awaiting input
 *
 * Inbound commands (one JSON object per line):
 *   {type:"submit", text}                     run a task (or steer a live run)
 *   {type:"approve", id, choice:"y"|"n"|"a"}  answer an approval request
 *   {type:"cancel"}                           abort the active run
 */
import type { AgentEvent, ApprovalRequest, RunResult } from "@dxxpcode/agent";
import { runTask } from "@dxxpcode/agent";
import type { ModelProvider, ReasoningEffort } from "@dxxpcode/providers";
import type { ProjectInfo } from "@dxxpcode/project";
import { loadSession } from "@dxxpcode/sessions";
import type { SessionRecord } from "@dxxpcode/sessions";
import type { ProposedPlan } from "@dxxpcode/tools";
import { expandMentions } from "./mentions.ts";
import { jevRouteEffort, smartApprove } from "./jev.ts";
import type { DxxpConfig } from "@dxxpcode/sessions";

export interface AppModeDeps {
  version: string;
  provider: ModelProvider;
  providerName: string;
  model: string;
  effort?: ReasoningEffort;
  project: ProjectInfo;
  root: string;
  session?: SessionRecord;
  planOnly: boolean;
  autoApprove: boolean;
  /** "smart" approval mode enabled (Jev); needs a TypeSafe key. */
  smartApproveMode: boolean;
  maxIterations?: number;
  allowlist: Set<string>;
  config: DxxpConfig;
  mode: string;
}

interface InCommand {
  type: string;
  text?: string;
  id?: number;
  choice?: string;
}

const emit = (o: unknown) => {
  process.stdout.write(JSON.stringify(o) + "\n");
};

function describe(req: ApprovalRequest): string {
  if (req.tool === "run_command") return String(req.input["command"] ?? req.tool);
  const target = req.input["path"];
  return typeof target === "string" ? `${req.tool} ${target}` : req.tool;
}

export async function runAppMode(deps: AppModeDeps): Promise<number> {
  // Raw mode on the pty: disables line buffering and echo so commands arrive
  // byte-accurate and aren't echoed back into the JSON stream.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  emit({
    type: "ready",
    version: deps.version,
    provider: deps.providerName,
    model: deps.model,
    effort: deps.effort,
    mode: deps.mode,
    project: {
      name: deps.project.name,
      languages: deps.project.languages,
      git: deps.project.git,
    },
  });

  const pendingApprovals = new Map<number, (choice: string) => void>();
  let nextApprovalId = 1;
  const steerQueue: string[] = [];
  const taskQueue: string[] = [];
  let session = deps.session;
  let abortRun: AbortController | null = null;
  let pumping = false;

  const ask = (kind: "plan" | "tool", summary: string, reason?: string) =>
    new Promise<string>((resolve) => {
      const id = nextApprovalId++;
      pendingApprovals.set(id, resolve);
      emit({ type: "approval", id, kind, summary, reason, allowAlways: kind === "tool" });
    });

  const runOnce = async (task: string): Promise<void> => {
    emit({ type: "user", text: task });
    const ctl = new AbortController();
    abortRun = ctl;

    const approvePlan = async (plan: ProposedPlan): Promise<boolean> => {
      if (deps.autoApprove) {
        emit({ type: "note", text: "auto-approved plan" });
        return true;
      }
      const body = [plan.summary, ...plan.steps.map((s, i) => `${i + 1}. ${s}`)]
        .filter(Boolean)
        .join("\n");
      const choice = await ask("plan", body);
      return choice === "y" || choice === "a";
    };

    const approveTool = async (req: ApprovalRequest): Promise<boolean> => {
      const summary = describe(req);
      const key = `${req.tool}:${summary}`;
      if (deps.allowlist.has(key)) {
        emit({ type: "note", text: `allowed earlier this session: ${summary}` });
        return true;
      }
      if (deps.autoApprove) {
        emit({ type: "note", text: `auto-approved: ${summary}` });
        return true;
      }
      if (deps.smartApproveMode) {
        const key_ = process.env.TYPESAFE_API_KEY ?? deps.config.typeSafeApiKey;
        if (key_) {
          const v = await smartApprove(req, key_);
          if (v?.approve) {
            emit({ type: "note", text: `smart-approved (jev ${v.confidence.toFixed(2)}): ${summary}` });
            return true;
          }
          if (v) emit({ type: "note", text: `jev escalated (${v.confidence.toFixed(2)})` });
        }
      }
      const choice = await ask("tool", summary, req.reason ?? req.decision.reason);
      if (choice === "a") {
        deps.allowlist.add(key);
        return true;
      }
      return choice === "y";
    };

    try {
      const mentions = expandMentions(task, deps.root);
      for (const a of mentions.attached) emit({ type: "note", text: `attached ${a}` });
      for (const s of mentions.skipped)
        emit({ type: "note", text: `skipped @${s.path}: ${s.reason}` });
      const effort =
        deps.config.effortAuto && (process.env.TYPESAFE_API_KEY ?? deps.config.typeSafeApiKey)
          ? ((await jevRouteEffort(
              mentions.text,
              process.env.TYPESAFE_API_KEY ?? deps.config.typeSafeApiKey ?? "",
            ))?.effort ?? deps.effort)
          : deps.effort;
      const events = runTask({
        task: mentions.text,
        provider: deps.provider,
        model: deps.model,
        effort,
        projectRoot: deps.root,
        planOnly: deps.planOnly,
        maxIterations: deps.maxIterations,
        approvePlan,
        approveTool,
        session,
        signal: ctl.signal,
        steer: () => steerQueue.shift(),
      });
      let result: RunResult | undefined;
      for await (const ev of events) {
        if (ev.type === "approval_request") continue; // we emit richer approvals
        emit(ev satisfies AgentEvent);
        if (ev.type === "done") result = ev.result;
      }
      if (result?.sessionId) session = loadSession(result.sessionId) ?? session;
    } catch (err) {
      emit({
        type: "done",
        result: {
          status: "error",
          summary: "Failed",
          error: err instanceof Error ? err.message : String(err),
          filesChanged: [],
          commands: [],
          toolCalls: 0,
          sessionId: session?.id ?? "",
        } satisfies RunResult,
      });
    } finally {
      abortRun = null;
    }
    emit({ type: "idle" });
    // Text queued while the run wound down becomes the next task.
    const next = steerQueue.shift();
    if (next) await runOnce(next);
  };

  const pump = () => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (taskQueue.length) await runOnce(taskQueue.shift()!);
      } finally {
        pumping = false;
      }
    })();
  };

  return new Promise<number>((resolve) => {
    let buf = "";
    process.stdin.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let cmd: InCommand;
        try {
          cmd = JSON.parse(line) as InCommand;
        } catch {
          continue;
        }
        if (cmd.type === "submit" && typeof cmd.text === "string" && cmd.text.trim()) {
          if (abortRun) {
            steerQueue.push(cmd.text);
            emit({ type: "steer", text: cmd.text });
          } else {
            taskQueue.push(cmd.text);
          }
          pump();
        } else if (cmd.type === "approve" && typeof cmd.id === "number") {
          const resolveApproval = pendingApprovals.get(cmd.id);
          if (resolveApproval) {
            pendingApprovals.delete(cmd.id);
            resolveApproval(cmd.choice === "a" ? "a" : cmd.choice === "y" ? "y" : "n");
          }
        } else if (cmd.type === "cancel") {
          abortRun?.abort();
        }
      }
    });
    process.stdin.on("end", () => resolve(0));
    process.stdin.on("error", () => resolve(0));
  });
}

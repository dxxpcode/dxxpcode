import { rmSync } from "node:fs";
import { join } from "node:path";
import { runTask, undoCheckpoint } from "@dxxpcode/agent";
import type { ApprovalRequest } from "@dxxpcode/agent";
import { resolveProvider, ProviderConfigError, KNOWN_MODELS, DEFAULT_MODELS } from "@dxxpcode/providers";
import type { ModelProvider } from "@dxxpcode/providers";
import { loadConfig, saveConfig, loadSession, listSessions, newSessionId, sessionsDir } from "@dxxpcode/sessions";
import type { SessionRecord } from "@dxxpcode/sessions";
import {
  BRIDGE_VERSION,
  ERR_INTERNAL,
  ERR_METHOD,
  ERR_PARAMS,
  ERR_PARSE,
  ERR_REQUEST_UNKNOWN,
  ERR_RUN_NOT_FOUND,
} from "./protocol.ts";
import type {
  ApprovalRespondParams,
  BridgeDefaults,
  ConfigSetParams,
  EventNotificationParams,
  IncomingMessage,
  PlanRespondParams,
  PublicConfig,
  ResponseMessage,
  RunCancelParams,
  RunStartParams,
  SecretsSetParams,
  SessionDeleteParams,
  SessionGetParams,
  SessionListParams,
  SessionSummary,
} from "./protocol.ts";

export interface Bridge {
  /** Feed one newline-delimited JSON-RPC message. Never throws. */
  handleLine(line: string): void;
  /** Abort in-flight runs; called when the transport closes. */
  close(): void;
}

export interface BridgeOptions {
  /** Sink for one complete JSON line (responses + event notifications). */
  write(line: string): void;
  /** Environment for config/session paths and provider resolution. */
  env?: NodeJS.ProcessEnv;
  defaults?: BridgeDefaults;
}

class BridgeError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface PendingRequest {
  sessionId: string;
  /** Allowlist key — set only for approval requests. */
  key?: string;
  resolve?: (answer: boolean) => void;
  /** Answered before the runtime's approver awaited it — consumed on await. */
  answer?: boolean;
  /** Settled without a client respond (auto-approve, allowlist hit, sweep). */
  consumed: boolean;
}

interface ActiveRun {
  sessionId: string;
  controller: AbortController;
  allowlist: Set<string>;
  /** All requestIds allocated for this run — swept when it finishes. */
  requestIds: Set<string>;
  /** requestId carried by the last plan / approval_request event. */
  lastPlanRequestId?: string;
  lastApprovalRequestId?: string;
}

const SECRET_CONFIG_KEYS = ["anthropicApiKey", "openaiApiKey", "typeSafeApiKey", "authToken"] as const;

export function createBridge(opts: BridgeOptions): Bridge {
  const env = opts.env ?? process.env;
  const defaults = opts.defaults ?? {};
  /** Provider keys delivered via secrets.set — never read from config.json here. */
  const secrets: { anthropic?: string; openai?: string } = {};
  const pending = new Map<string, PendingRequest>();
  const runs = new Map<string, ActiveRun>();
  let reqSeq = 0;
  let closed = false;

  const send = (msg: ResponseMessage | { jsonrpc: "2.0"; method: string; params: EventNotificationParams }) => {
    opts.write(JSON.stringify(msg));
  };

  const notify = (params: EventNotificationParams) => send({ jsonrpc: "2.0", method: "event", params });

  /** Runtime-side wait: resolves when plan.respond / approval.respond arrives. */
  function waitFor(requestId: string): Promise<boolean> {
    const entry = pending.get(requestId);
    if (!entry) return Promise.resolve(false);
    if (entry.answer !== undefined) {
      const a = entry.answer;
      entry.consumed = true;
      return Promise.resolve(a);
    }
    return new Promise((resolve) => {
      entry.resolve = (v) => {
        entry.consumed = true;
        resolve(v);
      };
    });
  }

  /** Client-side answer; idempotent when the entry was settled internally. */
  function respond(requestId: string, answer: boolean, always = false): void {
    const entry = pending.get(requestId);
    if (!entry) throw new BridgeError(ERR_REQUEST_UNKNOWN, `unknown requestId ${requestId}`);
    if (entry.consumed) return; // raced with auto-approve / allowlist — ignore
    if (always && answer && entry.key) {
      runs.get(entry.sessionId)?.allowlist.add(entry.key);
    }
    if (entry.resolve) entry.resolve(answer);
    else entry.answer = answer;
  }

  function sweep(run: ActiveRun): void {
    for (const id of run.requestIds) pending.delete(id);
  }

  function reqStr(p: Record<string, unknown>, key: string): string {
    const v = p[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new BridgeError(ERR_PARAMS, `missing or invalid "${key}"`);
    }
    return v;
  }

  function approvalKey(req: ApprovalRequest): string {
    if (req.tool === "run_command") return `${req.tool}:${String(req.input["command"] ?? "")}`;
    const target = req.input["path"];
    return typeof target === "string" ? `${req.tool}:${target}` : req.tool;
  }

  function resolveSelection(overrides: { provider?: string; model?: string }): { provider: ModelProvider; model: string } {
    const config = loadConfig(env);
    const providerEnv = { ...env };
    if (!providerEnv.OPENAI_BASE_URL && config.openaiBaseUrl) {
      providerEnv.OPENAI_BASE_URL = config.openaiBaseUrl;
    }
    return resolveProvider({
      provider: overrides.provider ?? defaults.provider ?? config.provider,
      model: overrides.model ?? defaults.model ?? config.model,
      env: providerEnv,
      keys: secrets,
    });
  }

  async function handleRunStart(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    const p = params as unknown as RunStartParams;
    const projectRoot = reqStr(params, "projectRoot");
    const task = reqStr(params, "task");
    const selection = resolveSelection(p);
    const autoApproveAll = p.autoApprove ?? defaults.autoApprove ?? false;

    let session: SessionRecord;
    if (p.resumeSessionId) {
      const loaded = loadSession(p.resumeSessionId, env);
      if (!loaded) throw new BridgeError(ERR_PARAMS, `session not found: ${p.resumeSessionId}`);
      session = loaded;
    } else {
      const now = new Date().toISOString();
      session = {
        version: 1,
        id: newSessionId(projectRoot),
        projectRoot,
        createdAt: now,
        updatedAt: now,
        task,
        messages: [],
        toolCalls: [],
        filesChanged: [],
        commands: [],
      };
    }

    const run: ActiveRun = {
      sessionId: session.id,
      controller: new AbortController(),
      allowlist: new Set(),
      requestIds: new Set(),
    };
    runs.set(run.sessionId, run);

    const allocateRequest = (key?: string): string => {
      const requestId = `req_${++reqSeq}`;
      run.requestIds.add(requestId);
      pending.set(requestId, { sessionId: run.sessionId, key, consumed: false });
      return requestId;
    };

    const approvePlan = async (): Promise<boolean> => {
      if (autoApproveAll) return true;
      const requestId = run.lastPlanRequestId;
      run.lastPlanRequestId = undefined;
      if (!requestId) return false; // no request issued — fail closed
      return waitFor(requestId);
    };

    const approveTool = async (req: ApprovalRequest): Promise<boolean> => {
      const requestId = run.lastApprovalRequestId;
      run.lastApprovalRequestId = undefined;
      if (autoApproveAll || run.allowlist.has(approvalKey(req))) return true;
      if (!requestId) return false; // no request issued — fail closed
      return waitFor(requestId);
    };

    void (async () => {
      try {
        for await (const ev of runTask({
          task,
          provider: selection.provider,
          model: selection.model,
          projectRoot,
          planOnly: p.planOnly,
          maxIterations: defaults.maxIterations,
          effort: p.effort ?? defaults.effort,
          env,
          session,
          signal: run.controller.signal,
          approvePlan,
          approveTool,
        })) {
          const eventParams: EventNotificationParams = { sessionId: run.sessionId, event: ev };
          if (ev.type === "plan" && !autoApproveAll && !ev.plan.trivial && !p.planOnly) {
            const requestId = allocateRequest();
            run.lastPlanRequestId = requestId;
            eventParams.requestId = requestId;
          } else if (
            ev.type === "approval_request" &&
            !autoApproveAll &&
            !run.allowlist.has(approvalKey(ev.request))
          ) {
            const requestId = allocateRequest(approvalKey(ev.request));
            run.lastApprovalRequestId = requestId;
            eventParams.requestId = requestId;
          }
          notify(eventParams);
          if (ev.type === "done") {
            runs.delete(run.sessionId);
            sweep(run);
          }
        }
      } catch (err) {
        notify({
          sessionId: run.sessionId,
          event: {
            type: "done",
            result: {
              status: "error",
              summary: "Failed",
              filesChanged: [],
              commands: [],
              toolCalls: 0,
              sessionId: run.sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        });
        runs.delete(run.sessionId);
        sweep(run);
      }
    })();

    return { sessionId: run.sessionId };
  }

  function toError(err: unknown): { code: number; message: string } {
    if (err instanceof BridgeError) return { code: err.code, message: err.message };
    if (err instanceof ProviderConfigError) return { code: ERR_PARAMS, message: err.message };
    return { code: ERR_INTERNAL, message: err instanceof Error ? err.message : String(err) };
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ping":
        return { version: BRIDGE_VERSION, pid: process.pid };
      case "shutdown":
        for (const run of runs.values()) run.controller.abort();
        return { ok: true };
      case "run.start":
        return handleRunStart(params);
      case "run.cancel": {
        const p = params as unknown as RunCancelParams;
        const run = runs.get(reqStr(params, "sessionId"));
        if (!run) throw new BridgeError(ERR_RUN_NOT_FOUND, `no active run for session`);
        run.controller.abort();
        return { ok: true };
      }
      case "plan.respond": {
        const p = params as unknown as PlanRespondParams;
        respond(reqStr(params, "requestId"), p.approve === true);
        return { ok: true };
      }
      case "approval.respond": {
        const p = params as unknown as ApprovalRespondParams;
        respond(reqStr(params, "requestId"), p.allow === true, p.always === true);
        return { ok: true };
      }
      case "session.list": {
        const p = params as unknown as SessionListParams;
        return listSessions(env)
          .filter((s) => !p.projectRoot || s.projectRoot === p.projectRoot)
          .map(
            (s): SessionSummary => ({
              id: s.id,
              projectRoot: s.projectRoot,
              task: s.task,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              messageCount: s.messages.length,
              result: s.result,
            }),
          );
      }
      case "session.get": {
        const p = params as unknown as SessionGetParams;
        const rec = loadSession(reqStr(params, "id"), env);
        if (!rec) throw new BridgeError(ERR_PARAMS, `session not found: ${p.id}`);
        return rec;
      }
      case "session.delete": {
        const p = params as unknown as SessionDeleteParams;
        const id = reqStr(params, "id");
        if (!/^[\w.-]+$/.test(id)) throw new BridgeError(ERR_PARAMS, "invalid session id");
        rmSync(join(sessionsDir(env), `${id}.json`), { force: true });
        return { ok: true };
      }
      case "checkpoint.undo": {
        const out = undoCheckpoint(reqStr(params, "projectRoot"), reqStr(params, "sessionId"), env);
        if (!out) throw new BridgeError(ERR_PARAMS, "no checkpoint to undo");
        return out;
      }
      case "config.get": {
        const raw = loadConfig(env);
        const config = { ...raw } as Record<string, unknown>;
        for (const k of SECRET_CONFIG_KEYS) delete config[k];
        return {
          config: config as PublicConfig,
          keys: {
            anthropic: Boolean(secrets.anthropic ?? raw.anthropicApiKey ?? env.ANTHROPIC_API_KEY),
            openai: Boolean(secrets.openai ?? raw.openaiApiKey ?? env.OPENAI_API_KEY),
          },
        };
      }
      case "config.set": {
        const p = params as unknown as ConfigSetParams;
        const next = { ...p.config } as Record<string, unknown>;
        for (const k of SECRET_CONFIG_KEYS) {
          if (next[k] !== undefined) {
            throw new BridgeError(ERR_PARAMS, `${k} must go through secrets.set`);
          }
        }
        saveConfig({ ...loadConfig(env), ...next }, env);
        return { ok: true };
      }
      case "providers.list": {
        let current: { provider: string; model: string } | null = null;
        try {
          const sel = resolveSelection({});
          current = { provider: sel.provider.name, model: sel.model };
        } catch {
          current = null;
        }
        return {
          current,
          providers: Object.keys(KNOWN_MODELS).map((name) => ({
            name,
            models: KNOWN_MODELS[name],
            default: DEFAULT_MODELS[name],
          })),
        };
      }
      case "secrets.set": {
        const p = params as unknown as SecretsSetParams;
        if (p.provider !== "anthropic" && p.provider !== "openai") {
          throw new BridgeError(ERR_PARAMS, `unsupported provider ${String(p.provider)}`);
        }
        if (typeof p.key !== "string" || p.key.length === 0) {
          throw new BridgeError(ERR_PARAMS, `missing or invalid "key"`);
        }
        secrets[p.provider] = p.key;
        return { ok: true };
      }
      default:
        throw new BridgeError(ERR_METHOD, `unknown method ${method}`);
    }
  }

  return {
    handleLine(line: string) {
      if (closed) return;
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(line) as IncomingMessage;
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_PARSE, message: "invalid JSON" } });
        return;
      }
      const hasId = "id" in msg && msg.id !== undefined;
      void dispatch(msg.method, (msg.params ?? {}) as Record<string, unknown>).then(
        (result) => {
          if (hasId && "id" in msg) send({ jsonrpc: "2.0", id: msg.id, result });
        },
        (err) => {
          if (hasId && "id" in msg) send({ jsonrpc: "2.0", id: msg.id, error: toError(err) });
        },
      );
    },
    close() {
      closed = true;
      for (const run of runs.values()) run.controller.abort();
    },
  };
}

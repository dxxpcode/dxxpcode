import type { AgentEvent } from "@dxxpcode/agent";
import type { JsonObject, ReasoningEffort } from "@dxxpcode/providers";
import type { DxxpConfig } from "@dxxpcode/sessions";

export const JSONRPC_VERSION = "2.0" as const;
export const BRIDGE_VERSION = "0.1.0" as const;

/* ------------------------------- wire shapes ------------------------------ */

export interface RequestMessage {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: JsonObject;
}

/** Client-initiated message without an id — handled, never answered. */
export interface NotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

export type IncomingMessage = RequestMessage | NotificationMessage;

export interface RpcError {
  code: number;
  message: string;
}

export interface ResponseMessage {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: RpcError;
}

/** Server → client push carrying one runtime event. */
export interface EventNotificationParams {
  sessionId: string;
  event: AgentEvent;
  /** Present when the event awaits a `*.respond` call. */
  requestId?: string;
}

export const ERR_PARSE = -32700;
export const ERR_METHOD = -32601;
export const ERR_PARAMS = -32602;
export const ERR_INTERNAL = -32000;
export const ERR_RUN_NOT_FOUND = -32001;
export const ERR_REQUEST_UNKNOWN = -32002;

/* ------------------------------- method params ---------------------------- */

export interface RunStartParams {
  projectRoot: string;
  task: string;
  planOnly?: boolean;
  effort?: ReasoningEffort;
  /** Overrides for this run; fall back to spawn-time defaults then config. */
  provider?: string;
  model?: string;
  /** Continue an existing session instead of starting a new one. */
  resumeSessionId?: string;
  /** Auto-approve approval-tier actions (equivalent to CLI --yes). */
  autoApprove?: boolean;
}

export interface RunCancelParams {
  sessionId: string;
}

export interface PlanRespondParams {
  requestId: string;
  approve: boolean;
}

export interface ApprovalRespondParams {
  requestId: string;
  allow: boolean;
  /** Also allowlist this exact action for the rest of the run. */
  always?: boolean;
}

export interface SessionListParams {
  projectRoot?: string;
}

/** Slim session shape for list UIs — full records via session.get. */
export interface SessionSummary {
  id: string;
  projectRoot: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  result?: string;
}

export interface SessionGetParams {
  id: string;
}

export interface SessionDeleteParams {
  id: string;
}

export interface CheckpointUndoParams {
  projectRoot: string;
  sessionId: string;
}

export interface ConfigSetParams {
  config: Partial<DxxpConfig>;
}

/** Config with secret fields stripped; secrets go through secrets.set. */
export type PublicConfig = Omit<DxxpConfig, "anthropicApiKey" | "openaiApiKey" | "typeSafeApiKey" | "authToken">;

export interface SecretsSetParams {
  provider: "anthropic" | "openai";
  key: string;
}

export interface ProvidersListResult {
  /** Currently resolvable selection; null when no provider is configured. */
  current: { provider: string; model: string } | null;
  providers: Array<{ name: string; models: string[]; default: string }>;
}

export interface PingResult {
  version: string;
  pid: number;
}

/** Spawn-time defaults; every field is overridable per run.start. */
export interface BridgeDefaults {
  provider?: string;
  model?: string;
  effort?: ReasoningEffort;
  maxIterations?: number;
  autoApprove?: boolean;
}

export const METHODS = [
  "ping",
  "shutdown",
  "run.start",
  "run.cancel",
  "plan.respond",
  "approval.respond",
  "session.list",
  "session.get",
  "session.delete",
  "checkpoint.undo",
  "config.get",
  "config.set",
  "providers.list",
  "secrets.set",
] as const;

export type BridgeMethod = (typeof METHODS)[number];

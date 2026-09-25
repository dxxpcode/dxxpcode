import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ApprovalMode = "ask" | "auto" | "smart";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DxxpConfig {
  provider?: string;
  model?: string;
  /** Last-used model per provider — restored on provider switch. */
  models?: Record<string, string>;
  approvalMode?: ApprovalMode;
  /** Reasoning effort level for reasoning-capable models. */
  effort?: ReasoningEffort;
  /** Let Jev pick the effort tier per task (uses TYPESAFE_API_KEY / typeSafeApiKey). */
  effortAuto?: boolean;
  maxIterations?: number;
  /** Saved by the in-CLI provider setup; env vars take precedence. */
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  /** Random per-install ID — generated once, powers the unique-installs stat. */
  installId?: string;
  /** TypeSafe API key for Jev-powered smart approvals. */
  typeSafeApiKey?: string;
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DXXPCODE_HOME ?? join(homedir(), ".dxxpcode");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DxxpConfig {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as DxxpConfig) : {};
  } catch {
    return {};
  }
}

export function saveConfig(config: DxxpConfig, env: NodeJS.ProcessEnv = process.env): void {
  const dir = homeDir(env);
  mkdirSync(dir, { recursive: true });
  const path = configPath(env);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  chmodSync(path, 0o600); // may hold provider keys — owner-only
}

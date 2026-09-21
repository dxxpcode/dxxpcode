import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ApprovalMode = "ask" | "auto";

export interface DxxpConfig {
  provider?: string;
  model?: string;
  approvalMode?: ApprovalMode;
  maxIterations?: number;
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
  writeFileSync(configPath(env), JSON.stringify(config, null, 2) + "\n", "utf8");
}

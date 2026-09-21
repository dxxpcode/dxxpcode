import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { homeDir } from "./config.ts";
import type { SessionRecord } from "./types.ts";

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), "sessions");
}

function slugify(root: string): string {
  const base = root.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project";
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function newSessionId(projectRoot: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${slugify(projectRoot)}-${ts}-${randomBytes(3).toString("hex")}`;
}

export function saveSession(record: SessionRecord, env: NodeJS.ProcessEnv = process.env): string {
  const dir = sessionsDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  return path;
}

export function loadSession(id: string, env: NodeJS.ProcessEnv = process.env): SessionRecord | null {
  const path = join(sessionsDir(env), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.version === 1 ? (parsed as SessionRecord) : null;
  } catch {
    return null;
  }
}

export function listSessions(env: NodeJS.ProcessEnv = process.env): SessionRecord[] {
  const dir = sessionsDir(env);
  if (!existsSync(dir)) return [];
  const out: SessionRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (parsed?.version === 1) out.push(parsed as SessionRecord);
    } catch {
      /* skip corrupt files */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Latest session for a project root, used by `dxxpcode --resume`. */
export function latestSessionFor(projectRoot: string, env: NodeJS.ProcessEnv = process.env): SessionRecord | null {
  return listSessions(env).find((s) => s.projectRoot === projectRoot) ?? null;
}

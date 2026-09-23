import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homeDir } from "@dxxpcode/sessions";

/** One file captured before a mutating tool ran. */
export interface CheckpointFile {
  /** Path relative to the project root. */
  path: string;
  /** Whether the file existed before the change (false → restore = delete). */
  existed: boolean;
  /** Blob filename inside the checkpoint dir, when existed. */
  blob?: string;
}

export interface CheckpointInfo {
  seq: number;
  at: string;
  files: CheckpointFile[];
}

export interface UndoResult {
  seq: number;
  restored: string[];
  removed: string[];
}

/** Tools whose file writes get checkpointed. */
export const CHECKPOINTED_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

const MAX_CHECKPOINTS = 30;

export function checkpointsDir(sessionId: string, env: NodeJS.ProcessEnv): string {
  return join(homeDir(env), "checkpoints", sessionId);
}

function listSeqs(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => Number(d))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

/** Highest checkpoint seq + 1 for a session. */
export function nextCheckpointSeq(sessionId: string, env: NodeJS.ProcessEnv): number {
  const seqs = listSeqs(checkpointsDir(sessionId, env));
  return seqs.length ? seqs[seqs.length - 1] + 1 : 1;
}

/**
 * Snapshot the given project-relative paths before mutation.
 * Each call is one undoable unit (one tool call = one checkpoint).
 */
export function takeCheckpoint(
  root: string,
  paths: string[],
  sessionId: string,
  env: NodeJS.ProcessEnv,
): CheckpointInfo | null {
  const dir = checkpointsDir(sessionId, env);
  const seq = nextCheckpointSeq(sessionId, env);
  const cpDir = join(dir, String(seq));
  mkdirSync(cpDir, { recursive: true });
  const files: CheckpointFile[] = [];
  let n = 0;
  for (const p of paths) {
    const abs = resolve(root, p);
    // Tool input paths are jailed to root upstream; mirror that guard here.
    if (!abs.startsWith(resolve(root))) continue;
    const existed = existsSync(abs);
    const entry: CheckpointFile = { path: p, existed };
    if (existed) {
      const blob = `blob-${n}`;
      entry.blob = blob;
      writeFileSync(join(cpDir, blob), readFileSync(abs));
    }
    files.push(entry);
    n++;
  }
  if (files.length === 0) {
    rmSync(cpDir, { recursive: true, force: true });
    return null;
  }
  const info: CheckpointInfo = { seq, at: new Date().toISOString(), files };
  writeFileSync(join(cpDir, "manifest.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
  // Prune oldest checkpoints past the cap.
  const seqs = listSeqs(dir);
  for (const old of seqs.slice(0, Math.max(0, seqs.length - MAX_CHECKPOINTS))) {
    rmSync(join(dir, String(old)), { recursive: true, force: true });
  }
  return info;
}

/** Count checkpoints available to undo. */
export function checkpointCount(sessionId: string, env: NodeJS.ProcessEnv): number {
  return listSeqs(checkpointsDir(sessionId, env)).length;
}

/**
 * Restore the most recent checkpoint: files that existed are rewritten from
 * their blob, files that didn't are deleted. Returns null when nothing is
 * left to undo.
 */
export function undoCheckpoint(
  root: string,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): UndoResult | null {
  const dir = checkpointsDir(sessionId, env);
  const seqs = listSeqs(dir);
  if (seqs.length === 0) return null;
  const seq = seqs[seqs.length - 1];
  const cpDir = join(dir, String(seq));
  let info: CheckpointInfo;
  try {
    info = JSON.parse(readFileSync(join(cpDir, "manifest.json"), "utf8")) as CheckpointInfo;
  } catch {
    rmSync(cpDir, { recursive: true, force: true });
    return null;
  }
  const restored: string[] = [];
  const removed: string[] = [];
  for (const f of info.files) {
    const abs = resolve(root, f.path);
    if (!abs.startsWith(resolve(root))) continue;
    if (f.existed && f.blob) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, readFileSync(join(cpDir, f.blob)));
      restored.push(f.path);
    } else if (!f.existed && existsSync(abs)) {
      rmSync(abs);
      removed.push(f.path);
    }
  }
  rmSync(cpDir, { recursive: true, force: true });
  return { seq, restored, removed };
}

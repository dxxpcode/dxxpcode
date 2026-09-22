import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX = 500;

/** Newest-first input history (same format prompt.ts used). */
export function loadHistory(file: string | undefined): string[] {
  if (!file || !existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, MAX);
  } catch {
    return [];
  }
}

export function saveHistory(file: string | undefined, hist: string[]): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, hist.slice(0, MAX).join("\n") + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

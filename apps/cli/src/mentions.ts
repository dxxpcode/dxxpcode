import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRestrictedPath, resolveWithinRoot } from "@dxxpcode/permissions";

const MENTION = /(?:^|\s)@([A-Za-z0-9_./~-]+)/g;
const MAX_BYTES = 200 * 1024;

export interface MentionsResult {
  /** Task text with `<file path="...">` context blocks appended. */
  text: string;
  /** Attached files as `path (N lines)`. */
  attached: string[];
  skipped: { path: string; reason: string }[];
}

/**
 * Expand `@path` mentions in a task into file-content context blocks.
 * Paths are jailed to the project root and restricted patterns (.env,
 * keys, …) are skipped — same rules as the read_file tool.
 */
export function expandMentions(task: string, root: string): MentionsResult {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const attached: string[] = [];
  const skipped: MentionsResult["skipped"] = [];
  for (const m of task.matchAll(MENTION)) {
    const p = m[1].replace(/[.,;:!?)\]}>]+$/, "");
    if (!p) continue;
    const rel = resolveWithinRoot(root, p);
    if (rel === null) {
      skipped.push({ path: p, reason: "outside project root" });
      continue;
    }
    if (isRestrictedPath(rel)) {
      skipped.push({ path: p, reason: "protected file" });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      skipped.push({ path: p, reason: "not found" });
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    if (raw.length > MAX_BYTES || raw.includes("\0")) {
      skipped.push({ path: p, reason: "too large or binary" });
      continue;
    }
    attached.push(`${rel} (${raw.split("\n").length} lines)`);
    blocks.push(`\n\n<file path="${rel}">\n${raw.replace(/\n+$/, "")}\n</file>`);
  }
  return { text: task + blocks.join(""), attached, skipped };
}

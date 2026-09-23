import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRestrictedPath, resolveWithinRoot } from "@dxxpcode/permissions";

const MENTION = /(?:^|\s)@([A-Za-z0-9_./~-]+)(?:#(\d+)(?:-(\d+))?)?/g;
const MAX_BYTES = 200 * 1024;
const MAX_DIR_ENTRIES = 400;
const MAX_INDEX_ENTRIES = 8000;
const SKIP_DIRS = new Set([".git", ".dxxpcode", "node_modules", "dist", "build", ".next", "out", "coverage", ".venv", "venv", "__pycache__", "target"]);

export interface MentionsResult {
  /** Task text with `<file>`/`<directory>` context blocks appended. */
  text: string;
  /** Attached entries as `path (N lines)` / `path/ (N files)`. */
  attached: string[];
  skipped: { path: string; reason: string }[];
}

/**
 * Expand `@path` mentions in a task into context blocks.
 * `@file` attaches contents, `@file#5-10` attaches a line range, and `@dir/`
 * attaches a recursive file listing. Paths are jailed to the project root and
 * restricted patterns (.env, keys, …) are skipped — same rules as read_file.
 */
export function expandMentions(task: string, root: string): MentionsResult {
  const seen = new Set<string>();
  const blocks: string[] = [];
  const attached: string[] = [];
  const skipped: MentionsResult["skipped"] = [];
  for (const m of task.matchAll(MENTION)) {
    const p = m[1].replace(/[.,;:!?)\]}>]+$/, "");
    if (!p) continue;
    const from = m[2] ? Number(m[2]) : null;
    const to = m[3] ? Number(m[3]) : null;
    const rel = resolveWithinRoot(root, p.replace(/\/+$/, ""));
    if (rel === null) {
      skipped.push({ path: p, reason: "outside project root" });
      continue;
    }
    if (isRestrictedPath(rel)) {
      skipped.push({ path: p, reason: "protected file" });
      continue;
    }
    const key = `${rel}${from ? `#${from}` : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      skipped.push({ path: p, reason: "not found" });
      continue;
    }
    if (statSync(abs).isDirectory()) {
      const files = listFiles(root, rel).slice(0, MAX_DIR_ENTRIES);
      if (files.length === 0) {
        skipped.push({ path: p, reason: "empty directory" });
        continue;
      }
      attached.push(`${rel}/ (${files.length} files)`);
      blocks.push(`\n\n<directory path="${rel}/">\n${files.join("\n")}\n</directory>`);
      continue;
    }
    if (!statSync(abs).isFile()) {
      skipped.push({ path: p, reason: "not found" });
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    if (raw.length > MAX_BYTES || raw.includes("\0")) {
      skipped.push({ path: p, reason: "too large or binary" });
      continue;
    }
    if (from !== null) {
      const lines = raw.split("\n");
      const end = Math.min(to ?? from, lines.length);
      if (from < 1 || from > lines.length) {
        skipped.push({ path: p, reason: `line range out of bounds (${lines.length} lines)` });
        continue;
      }
      const slice = lines.slice(from - 1, end);
      attached.push(`${rel}#${from}-${end} (${slice.length} lines)`);
      blocks.push(`\n\n<file path="${rel}" lines="${from}-${end}">\n${slice.join("\n")}\n</file>`);
      continue;
    }
    attached.push(`${rel} (${raw.split("\n").length} lines)`);
    blocks.push(`\n\n<file path="${rel}">\n${raw.replace(/\n+$/, "")}\n</file>`);
  }
  return { text: task + blocks.join(""), attached, skipped };
}

/**
 * Project file index for `@` autocomplete: tracked + untracked files
 * (git-respected ignores) plus their parent directories.
 */
export function listProjectFiles(root: string): { files: string[]; dirs: string[] } {
  const files = gitFiles(root) ?? walkFiles(root);
  const dirs = new Set<string>();
  for (const f of files) {
    let d = dirname(f);
    while (d && d !== ".") {
      dirs.add(d);
      d = dirname(d);
    }
  }
  return { files, dirs: [...dirs].sort() };
}

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    return out.split("\n").slice(0, MAX_INDEX_ENTRIES);
  } catch {
    return null;
  }
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length >= MAX_INDEX_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_INDEX_ENTRIES) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && !isRestrictedPath(p)) {
        out.push(p);
      }
    }
  };
  walk("");
  return out;
}

/** Recursive file listing under a directory mention (skips restricted files). */
function listFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length >= MAX_DIR_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_DIR_ENTRIES) return;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && !isRestrictedPath(p)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

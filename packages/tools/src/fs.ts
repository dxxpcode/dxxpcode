import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluateFileAction, resolveWithinRoot } from "@dxxpcode/permissions";
import { optNum, optStr, str } from "./types.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 200 * 1024;

function rel(ctx: ToolContext, path: string): string | null {
  return resolveWithinRoot(ctx.root, path);
}

function escapeResult(path: string): { content: string; isError: true } {
  return { content: `path escapes project root: ${path}`, isError: true };
}

const DIFF_CTX = 2;
const DIFF_MAX_LINES = 30;

/**
 * Minimal unified-diff preview: common prefix/suffix trimmed, the differing
 * middle shown with DIFF_CTX context lines. Returns "" when unchanged.
 */
export function previewDiff(path: string, oldContent: string | null, newContent: string): string {
  const a = oldContent === null ? [] : oldContent.split("\n");
  const b = newContent.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (pre === a.length && pre === b.length) return ""; // identical
  const del = a.slice(pre, a.length - suf);
  const add = b.slice(pre, b.length - suf);
  const oldStart = Math.max(0, pre - DIFF_CTX);
  const newStart = oldStart;
  const oldEnd = Math.min(a.length, pre + del.length + DIFF_CTX);
  const newEnd = Math.min(b.length, pre + add.length + DIFF_CTX);
  const lines: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`,
  ];
  for (const l of a.slice(oldStart, pre)) lines.push(` ${l}`);
  for (const l of del) lines.push(`-${l}`);
  for (const l of add) lines.push(`+${l}`);
  for (const l of a.slice(pre + del.length, oldEnd)) lines.push(` ${l}`);
  if (lines.length > DIFF_MAX_LINES) {
    lines.length = DIFF_MAX_LINES;
    lines.push(`… ${add.length + del.length + 2 * DIFF_CTX - DIFF_MAX_LINES + 3} more lines`);
  }
  return lines.join("\n");
}

export const listDirectory: AgentTool = {
  name: "list_directory",
  description: "List files and directories under a path inside the project. Use '.' for the project root.",
  planPhase: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative directory path (default: '.')" },
    },
  },
  permission: (input, ctx) => evaluateFileAction(ctx.root, optStr(input, "path") ?? ".", "read"),
  execute: async (input, ctx) => {
    const r = rel(ctx, optStr(input, "path") ?? ".");
    if (r === null) return escapeResult(optStr(input, "path") ?? ".");
    const abs = join(ctx.root, r);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      return { content: `not a directory: ${r || "."}`, isError: true };
    }
    const SKIP = new Set(["node_modules", ".git", "__pycache__"]);
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .slice(0, 500);
    return { content: entries.join("\n") || "(empty)" };
  },
};

export const readFile: AgentTool = {
  name: "read_file",
  description: "Read a file inside the project. Returns numbered lines; truncated beyond 2000 lines or 200KB.",
  planPhase: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative file path" },
      offset: { type: "number", description: "1-based starting line" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  permission: (input, ctx) => evaluateFileAction(ctx.root, str(input, "path"), "read"),
  execute: async (input, ctx) => {
    const r = rel(ctx, str(input, "path"));
    if (r === null) return escapeResult(str(input, "path"));
    const abs = join(ctx.root, r);
    if (!existsSync(abs)) return { content: `file not found: ${r}`, isError: true };
    if (!statSync(abs).isFile()) return { content: `not a file: ${r}`, isError: true };
    const size = statSync(abs).size;
    if (size > MAX_READ_BYTES) {
      return { content: `file too large (${size} bytes); read a range with offset/limit`, isError: true };
    }
    const raw = readFileSync(abs, "utf8");
    if (raw.includes("\0")) return { content: `binary file not shown: ${r}`, isError: true };
    const all = raw.split("\n");
    const offset = Math.max(1, optNum(input, "offset") ?? 1);
    const limit = Math.min(optNum(input, "limit") ?? MAX_READ_LINES, MAX_READ_LINES);
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    const truncated = offset - 1 + slice.length < all.length;
    return {
      content: numbered + (truncated ? `\n… (${all.length} lines total, truncated)` : ""),
    };
  },
};

export const writeFile: AgentTool = {
  name: "write_file",
  description: "Create or overwrite a file inside the project. Parent directories are created.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative file path" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  },
  permission: (input, ctx) => evaluateFileAction(ctx.root, str(input, "path"), "write"),
  execute: async (input, ctx) => {
    const r = rel(ctx, str(input, "path"));
    if (r === null) return escapeResult(str(input, "path"));
    const abs = join(ctx.root, r);
    const content = str(input, "content");
    mkdirSync(dirname(abs), { recursive: true });
    const existed = existsSync(abs);
    const prev = existed ? readFileSync(abs, "utf8") : null;
    writeFileSync(abs, content, "utf8");
    return {
      content: `${existed ? "updated" : "created"} ${r} (${content.split("\n").length} lines)`,
      changedFile: r,
      diff: previewDiff(r, prev, content),
    };
  },
};

export const editFile: AgentTool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. The old_string must match exactly once unless replace_all is true.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative file path" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  permission: (input, ctx) => evaluateFileAction(ctx.root, str(input, "path"), "write"),
  execute: async (input, ctx) => {
    const r = rel(ctx, str(input, "path"));
    if (r === null) return escapeResult(str(input, "path"));
    const abs = join(ctx.root, r);
    if (!existsSync(abs)) return { content: `file not found: ${r}`, isError: true };
    const raw = readFileSync(abs, "utf8");
    const oldStr = str(input, "old_string");
    const newStr = input["new_string"];
    if (typeof newStr !== "string") return { content: `missing "new_string"`, isError: true };
    const occurrences = raw.split(oldStr).length - 1;
    if (occurrences === 0) return { content: `old_string not found in ${r}`, isError: true };
    const replaceAll = input["replace_all"] === true;
    if (occurrences > 1 && !replaceAll) {
      return {
        content: `old_string matches ${occurrences} times in ${r}; provide more context or set replace_all`,
        isError: true,
      };
    }
    const updated = replaceAll ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr);
    writeFileSync(abs, updated, "utf8");
    return {
      content: `edited ${r} (${occurrences} replacement${occurrences > 1 ? "s" : ""})`,
      changedFile: r,
      diff: previewDiff(r, raw, updated),
    };
  },
};

export const deleteFile: AgentTool = {
  name: "delete_file",
  description: "Delete a file or empty directory inside the project. Always requires approval.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project-relative path" },
    },
    required: ["path"],
  },
  permission: (input, ctx) => evaluateFileAction(ctx.root, str(input, "path"), "delete"),
  execute: async (input, ctx) => {
    const r = rel(ctx, str(input, "path"));
    if (r === null) return escapeResult(str(input, "path"));
    const abs = join(ctx.root, r);
    if (!existsSync(abs)) return { content: `not found: ${r}`, isError: true };
    rmSync(abs, { recursive: false });
    return { content: `deleted ${r}`, changedFile: r };
  },
};

export const fileTools: AgentTool[] = [listDirectory, readFile, writeFile, editFile, deleteFile];

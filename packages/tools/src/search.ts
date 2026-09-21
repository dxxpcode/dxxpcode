import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluateFileAction, isRestrictedPath, resolveWithinRoot } from "@dxxpcode/permissions";
import { optStr, str } from "./types.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "__pycache__",
  ".next", ".nuxt", ".venv", "venv", ".dxxpcode", "coverage", ".turbo",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_MATCHES = 100;

function* walk(root: string, dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !isRestrictedPath(rel)) yield* walk(root, rel);
    } else if (e.isFile()) {
      if (!isRestrictedPath(rel)) yield rel;
    }
  }
}

export const searchFiles: AgentTool = {
  name: "search_files",
  description:
    "Search file contents in the project with a regex. Returns `path:line: text` matches (max 100). Protected files are skipped.",
  planPhase: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "Subdirectory to search (default: project root)" },
      glob: { type: "string", description: "Optional filename filter like '*.ts'" },
      case_insensitive: { type: "boolean", description: "Case-insensitive match (default false)" },
    },
    required: ["pattern"],
  },
  permission: (input, ctx) => evaluateFileAction(ctx.root, optStr(input, "path") ?? ".", "read"),
  execute: async (input, ctx) => {
    const base = optStr(input, "path") ?? ".";
    const rel = resolveWithinRoot(ctx.root, base);
    if (rel === null || !existsSync(join(ctx.root, rel))) {
      return { content: `directory not found: ${base}`, isError: true };
    }
    let re: RegExp;
    try {
      re = new RegExp(str(input, "pattern"), input["case_insensitive"] === true ? "i" : "");
    } catch (e) {
      return { content: `invalid regex: ${(e as Error).message}`, isError: true };
    }
    const glob = optStr(input, "glob");
    const globRe = glob
      ? new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
      : null;

    const matches: string[] = [];
    const isDir = statSync(join(ctx.root, rel)).isDirectory();
    const files = isDir ? [...walk(ctx.root, rel)] : [rel];
    outer: for (const file of files) {
      if (globRe && !globRe.test(file.split("/").pop() ?? "")) continue;
      const abs = join(ctx.root, file);
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${file}:${i + 1}: ${lines[i].slice(0, 200)}`);
          if (matches.length >= MAX_MATCHES) break outer;
        }
      }
    }
    return {
      content: matches.length
        ? matches.join("\n") + (matches.length >= MAX_MATCHES ? `\n… (truncated at ${MAX_MATCHES})` : "")
        : "no matches",
    };
  },
};

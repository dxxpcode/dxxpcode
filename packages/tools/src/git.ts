import { execFile } from "node:child_process";
import { optStr } from "./types.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const MAX_OUTPUT = 64 * 1024;

function git(ctx: ToolContext, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: ctx.root, timeout: 30_000, maxBuffer: MAX_OUTPUT, env: { ...process.env, GIT_PAGER: "cat" } },
      (err, stdout, stderr) => {
        const errCode = (err as { code?: number } | null)?.code;
        const code = typeof errCode === "number" ? errCode : err ? 1 : 0;
        resolve({ code, out: (stdout + (stderr ? `\n${stderr}` : "")).slice(0, MAX_OUTPUT) });
      },
    );
  });
}

export const gitStatus: AgentTool = {
  name: "git_status",
  description: "Show git status (branch + working tree changes) for the project.",
  planPhase: true,
  inputSchema: { type: "object", properties: {} },
  permission: () => ({ level: "safe", reason: "read-only git status" }),
  execute: async (_input, ctx) => {
    const { code, out } = await git(ctx, ["status", "--short", "--branch"]);
    return { content: out.trim() || "clean", isError: code !== 0 };
  },
};

export const gitDiff: AgentTool = {
  name: "git_diff",
  description: "Show the working-tree diff (optionally for a path). Includes unstaged changes.",
  planPhase: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Optional project-relative path to diff" },
      staged: { type: "boolean", description: "Show staged diff instead (default false)" },
    },
  },
  permission: () => ({ level: "safe", reason: "read-only git diff" }),
  execute: async (input, ctx) => {
    const args = ["diff"];
    if (input["staged"] === true) args.push("--cached");
    const path = optStr(input, "path");
    if (path) args.push("--", path);
    const { code, out } = await git(ctx, args);
    return { content: out.trim() || "(no diff)", isError: code !== 0 };
  },
};

export const gitLog: AgentTool = {
  name: "git_log",
  description: "Show recent commit history (oneline, max 30).",
  planPhase: true,
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max commits (default 15, max 30)" },
    },
  },
  permission: () => ({ level: "safe", reason: "read-only git log" }),
  execute: async (input, ctx) => {
    const raw = input["limit"];
    const limit = Math.min(typeof raw === "number" && raw > 0 ? Math.floor(raw) : 15, 30);
    const { code, out } = await git(ctx, ["log", `--max-count=${limit}`, "--oneline", "--decorate"]);
    return { content: out.trim() || "(no commits)", isError: code !== 0 };
  },
};

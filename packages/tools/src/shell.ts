import { spawn } from "node:child_process";
import { evaluateCommand } from "@dxxpcode/permissions";
import { optNum, str } from "./types.ts";
import type { AgentTool } from "./types.ts";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const runCommand: AgentTool = {
  name: "run_command",
  description:
    "Run a shell command inside the project directory. Output is captured and truncated to 64KB. " +
    "Commands are permission-checked; unrecognized commands require approval.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run (cwd = project root)" },
      timeout_ms: { type: "number", description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
      reason: { type: "string", description: "Why this command is needed (shown at approval prompts)" },
    },
    required: ["command"],
  },
  permission: (input) => evaluateCommand(str(input, "command")),
  execute: async (input, ctx) => {
    const command = str(input, "command");
    const timeout = Math.min(optNum(input, "timeout_ms") ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", PAGER: "cat", GIT_PAGER: "cat" };
      // A spawned test suite is a new run, not part of any parent harness.
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_V8_COVERAGE;
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: ctx.root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so kill() reaches grandchildren too.
        detached: true,
      });
      const killTree = () => {
        try {
          if (child.pid != null) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      };
      let out = "";
      let timedOut = false;
      const onData = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeout);
      const onAbort = () => {
        killTree();
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          resolve({ content: `command timed out after ${timeout}ms\n${out.slice(0, MAX_OUTPUT)}`, isError: true });
          return;
        }
        if (ctx.signal?.aborted) {
          resolve({ content: "command cancelled", isError: true });
          return;
        }
        const body = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + "\n… (truncated)" : out;
        resolve({
          content: `$ ${command}\nexit ${code ?? "?"}\n${body}`.trimEnd(),
          isError: code !== 0,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ content: `failed to start: ${err.message}`, isError: true });
      });
    });
  },
};

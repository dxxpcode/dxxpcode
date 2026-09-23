import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateCommand } from "@dxxpcode/permissions";
import { optNum, optStr, str } from "./types.ts";
import type { AgentTool } from "./types.ts";

const MAX_LOG_READ = 16 * 1024;

// duplicated from @dxxpcode/sessions homeDir() — tools can't depend on sessions
// (build order + dependency direction)
function dxxpHome(): string {
  return process.env.DXXPCODE_HOME ?? join(homedir(), ".dxxpcode");
}

interface BgProc {
  name: string;
  command: string;
  pid: number;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
}

/** Processes started this session, keyed by caller-chosen name. */
const PROCS = new Map<string, BgProc>();

function bgDir(): string {
  const dir = join(dxxpHome(), "bg");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function alive(p: BgProc): boolean {
  if (p.exitCode !== null) return false;
  try {
    process.kill(p.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logTail(file: string, maxBytes = MAX_LOG_READ): string {
  if (!existsSync(file)) return "";
  const content = readFileSync(file, "utf8");
  return content.length > maxBytes ? `… (earlier output truncated)\n${content.slice(-maxBytes)}` : content;
}

export const runBackground: AgentTool = {
  name: "run_background",
  description:
    "Start a long-running shell command (dev server, watcher, build) in the background and keep working. " +
    "Output goes to a log file; check it later with check_process, stop it with kill_process. " +
    "Give each process a short name to reference it.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run (cwd = project root)" },
      name: { type: "string", description: "Short handle for this process (e.g. 'dev-server')" },
      reason: { type: "string", description: "Why this command is needed (shown at approval prompts)" },
    },
    required: ["command", "name"],
  },
  permission: (input) => evaluateCommand(str(input, "command")),
  execute: async (input, ctx) => {
    const command = str(input, "command");
    const name = str(input, "name");
    const existing = PROCS.get(name);
    if (existing && alive(existing)) {
      return { content: `background process '${name}' is already running (pid ${existing.pid})`, isError: true };
    }
    const logFile = join(bgDir(), `${name.replace(/[^\w.-]/g, "_")}.log`);
    const fd = openSync(logFile, "w");
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", PAGER: "cat", GIT_PAGER: "cat" };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_V8_COVERAGE;
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: ctx.root,
      env,
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    const proc: BgProc = { name, command, pid: child.pid ?? -1, logFile, startedAt: Date.now(), exitCode: null };
    child.on("close", (code) => {
      proc.exitCode = code ?? -1;
    });
    child.unref();
    PROCS.set(name, proc);
    return {
      content: `started '${name}' in the background (pid ${proc.pid})\nlog: ${logFile}\nuse check_process to read output or kill_process to stop it`,
    };
  },
};

export const checkProcess: AgentTool = {
  name: "check_process",
  description:
    "Check a background process started with run_background: whether it's still running and its recent output. " +
    "Omit `name` to list all background processes.",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Process name from run_background" },
      tail_lines: { type: "number", description: "Log lines to return (default 60)" },
    },
  },
  permission: () => ({ level: "safe", reason: "reading background process status" }),
  execute: async (input) => {
    const name = optStr(input, "name");
    if (!name) {
      if (PROCS.size === 0) return { content: "no background processes" };
      const lines = [...PROCS.values()].map((p) => {
        const secs = ((Date.now() - p.startedAt) / 1000).toFixed(0);
        const state = alive(p) ? `running (pid ${p.pid}, ${secs}s)` : `exited (${p.exitCode})`;
        return `${p.name}: ${state} — ${p.command}`;
      });
      return { content: lines.join("\n") };
    }
    const p = PROCS.get(name);
    if (!p) return { content: `no background process named '${name}'`, isError: true };
    const state = alive(p) ? `running (pid ${p.pid})` : `exited (${p.exitCode})`;
    const tail = logTail(p.logFile);
    const n = optNum(input, "tail_lines") ?? 60;
    const lines = tail.split("\n");
    const shown = lines.length > n ? lines.slice(-n).join("\n") : tail;
    return { content: `${p.name}: ${state}\n$ ${p.command}\n${shown.trimEnd() || "(no output yet)"}` };
  },
};

export const killProcess: AgentTool = {
  name: "kill_process",
  description: "Stop a background process started with run_background (SIGTERM, process group).",
  planPhase: false,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Process name from run_background" },
    },
    required: ["name"],
  },
  permission: () => ({ level: "approval", reason: "killing a background process" }),
  execute: async (input) => {
    const name = str(input, "name");
    const p = PROCS.get(name);
    if (!p) return { content: `no background process named '${name}'`, isError: true };
    if (!alive(p)) return { content: `'${name}' already exited (${p.exitCode})` };
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch (err) {
        return { content: `failed to kill '${name}': ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }
    return { content: `sent SIGTERM to '${name}' (pid ${p.pid})` };
  },
};

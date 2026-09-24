import type { ApprovalRequest } from "@dxxpcode/agent";

export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SURFACE = "#1a1b26";
export const SURFACE_HI = "#262838";

export type Seg = { t: string; c?: string; bg?: string; bold?: boolean; dim?: boolean };
export const segWidth = (l: Seg[]) => l.reduce((n, s) => n + s.t.length, 0);

export const COMMANDS = [
  { name: "/review", desc: "show the working-tree diff" },
  { name: "/model", desc: "current provider and model" },
  { name: "/status", desc: "session, config, and usage info" },
  { name: "/config", desc: "change settings (approval mode)" },
  { name: "/settings", desc: "settings and session surface" },
  { name: "/effort", desc: "reasoning effort for the next task" },
  { name: "/provider", desc: "connect or switch the model provider" },
  { name: "/providers", desc: "switch between configured providers" },
  { name: "/undo", desc: "restore files from the last checkpoint" },
  { name: "/compact", desc: "compress old tool output in the session context" },
  { name: "/docs", desc: "in-terminal reference — install, commands, flags, config" },
  { name: "/changelog", desc: "release history" },
  { name: "/clear", desc: "clear the transcript" },
  { name: "/help", desc: "list available commands" },
  { name: "/exit", desc: "quit dxxpcode" },
];

export function describe(req: ApprovalRequest): string {
  if (req.tool === "run_command") return String(req.input["command"] ?? req.tool);
  const target = req.input["path"];
  return typeof target === "string" ? `${req.tool} ${target}` : req.tool;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

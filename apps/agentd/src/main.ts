#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createBridge } from "@dxxpcode/bridge";
import type { BridgeDefaults } from "@dxxpcode/bridge";
import { loadConfig } from "@dxxpcode/sessions";
import type { ReasoningEffort } from "@dxxpcode/providers";

const VERSION = "0.1.0";

const HELP = `dxxpcode-agent — headless DxxpCode agent bridge

Speaks newline-delimited JSON-RPC 2.0 on stdio. All output on stdout is
protocol traffic — nothing else may write there. Logs go to stderr.

Usage:
  dxxpcode-agent                    Serve the bridge on stdio
  dxxpcode-agent --version          Print version
  dxxpcode-agent --help             This help

Options (spawn-time defaults; run.start may override per call):
  --provider <name>               anthropic | openai | mock
  --model <name>                  Model override
  --effort <level>                minimal | low | medium | high | xhigh | max
  --max-iterations <n>            Agent iteration cap
  --yes                           Auto-approve approval-tier actions

Methods:
  ping · shutdown · run.start · run.cancel · plan.respond · approval.respond
  session.list · session.get · session.delete · checkpoint.undo
  config.get · config.set · providers.list · secrets.set
`;

interface Args {
  provider?: string;
  model?: string;
  effort?: ReasoningEffort;
  maxIterations?: number;
  yes: boolean;
  version: boolean;
  help: boolean;
}

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function parseArgs(argv: string[]): Args {
  const args: Args = { yes: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--provider":
        args.provider = argv[++i];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--effort": {
        const e = argv[++i];
        if (EFFORTS.has(e)) {
          args.effort = e as ReasoningEffort;
        } else {
          process.stderr.write("--effort must be minimal, low, medium, high, xhigh, or max\n");
          process.exit(2);
        }
        break;
      }
      case "--max-iterations": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) args.maxIterations = Math.floor(n);
        break;
      }
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        process.stderr.write(`unknown option: ${a}\n`);
        process.exit(2);
    }
  }
  return args;
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(HELP); // stdout stays protocol-clean
    return;
  }
  if (args.version) {
    process.stderr.write(`dxxpcode-agent ${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  const defaults: BridgeDefaults = {
    provider: args.provider ?? config.provider,
    model: args.model ?? config.model,
    effort: args.effort ?? config.effort,
    maxIterations: args.maxIterations ?? config.maxIterations,
    autoApprove: args.yes || config.approvalMode === "auto",
  };

  const bridge = createBridge({
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    env: process.env,
    defaults,
  });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (line.trim()) bridge.handleLine(line);
  });
  rl.on("close", () => {
    bridge.close();
    process.exit(0);
  });
}

main();

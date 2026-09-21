import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as readline from "node:readline";

export interface Prompter {
  ask(question: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** yes / always / no picker — 'a' answers return "a". */
  pick(question: string): Promise<"y" | "a" | "n">;
  /**
   * Resolve a pending question with "" (used by esc-interrupt). Flushes
   * readline's internal question by simulating Enter so it doesn't eat the
   * next prompt's input.
   */
  cancelPending(): void;
  close(): void;
  readonly interactive: boolean;
  /** True once the underlying readline interface is closed (EOF/ctrl-D/ctrl-C). */
  readonly closed: boolean;
}

const MAX_HISTORY = 500;

/**
 * Readline-backed prompter. In non-TTY mode, confirms return `defaultYes`
 * (i.e. deny unless --yes was passed) and ask() returns "". Once the
 * interface closes, later calls resolve "" instead of throwing.
 * When historyFile is given, REPL input history persists across sessions
 * (newest-first, capped at MAX_HISTORY).
 */
export function createPrompter(opts: { interactive: boolean; historyFile?: string }): Prompter {
  const history =
    opts.interactive && opts.historyFile && existsSync(opts.historyFile)
      ? readFileSync(opts.historyFile, "utf8").split("\n").filter(Boolean).slice(0, MAX_HISTORY)
      : undefined;
  const rl = opts.interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout, history })
    : null;
  // Tracked separately for persistence (rl.history isn't in the typings):
  // newest-first, seeded from the history file.
  const hist: string[] = history ? [...history] : [];
  let pending: ((answer: string) => void) | null = null;
  let closed = rl === null ? !opts.interactive : false;
  rl?.on("close", () => {
    closed = true;
    // EOF/ctrl-D resolves a pending prompt with "" so confirms fall back
    // to their default instead of hanging. The line the prompt occupied
    // never got a newline, so emit one (bash does the same on ctrl-d).
    if (pending) process.stdout.write("\n");
    pending?.("");
    pending = null;
  });
  const question = (q: string): Promise<string> =>
    new Promise((resolve) => {
      if (!rl || closed) {
        resolve("");
        return;
      }
      pending = resolve;
      rl.question(q, (answer) => {
        pending = null;
        resolve(answer);
      });
    });
  return {
    interactive: opts.interactive,
    ask: async (q) => {
      const answer = await question(q);
      if (answer.trim() && hist[0] !== answer) {
        hist.unshift(answer);
        hist.length = Math.min(hist.length, MAX_HISTORY);
      }
      return answer;
    },
    confirm: async (q, defaultYes = false) => {
      const answer = (await question(q)).trim().toLowerCase();
      if (!rl || closed) return defaultYes;
      if (!answer) return defaultYes;
      return answer === "y" || answer === "yes";
    },
    pick: async (q) => {
      const answer = (await question(q)).trim().toLowerCase();
      if (!rl || closed) return "n";
      if (answer === "a" || answer === "always") return "a";
      if (answer === "y" || answer === "yes") return "y";
      return "n";
    },
    cancelPending: () => {
      if (!rl || !pending) return;
      const resolve = pending;
      // Flushes readline's queued question (its callback nulls `pending`).
      rl.write(null, { name: "return" });
      resolve("");
    },
    close: () => {
      if (rl && opts.historyFile) {
        try {
          mkdirSync(dirname(opts.historyFile), { recursive: true });
          writeFileSync(opts.historyFile, hist.slice(0, MAX_HISTORY).join("\n") + "\n", "utf8");
        } catch {
          /* history is best-effort */
        }
      }
      rl?.close();
    },
    get closed() {
      return closed;
    },
  };
}

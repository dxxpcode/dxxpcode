import * as readline from "node:readline";

export interface Prompter {
  ask(question: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
  readonly interactive: boolean;
  /** True once the underlying readline interface is closed (EOF/ctrl-D/ctrl-C). */
  readonly closed: boolean;
}

/**
 * Readline-backed prompter. In non-TTY mode, confirms return `defaultYes`
 * (i.e. deny unless --yes was passed) and ask() returns "". Once the
 * interface closes, later calls resolve "" instead of throwing.
 */
export function createPrompter(opts: { interactive: boolean }): Prompter {
  const rl = opts.interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let pending: ((answer: string) => void) | null = null;
  let closed = rl === null ? !opts.interactive : false;
  rl?.on("close", () => {
    closed = true;
    // EOF/ctrl-D resolves a pending prompt with "" so confirms fall back
    // to their default instead of hanging.
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
    ask: (q) => question(q),
    confirm: async (q, defaultYes = false) => {
      const answer = (await question(q)).trim().toLowerCase();
      if (!rl || closed) return defaultYes;
      if (!answer) return defaultYes;
      return answer === "y" || answer === "yes";
    },
    close: () => rl?.close(),
    get closed() {
      return closed;
    },
  };
}

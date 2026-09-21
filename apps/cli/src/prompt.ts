import * as readline from "node:readline";

export interface Prompter {
  ask(question: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
  readonly interactive: boolean;
}

/**
 * Readline-backed prompter. In non-TTY mode, confirms return `defaultYes`
 * (i.e. deny unless --yes was passed) and ask() returns "".
 */
export function createPrompter(opts: { interactive: boolean }): Prompter {
  const rl = opts.interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const question = (q: string): Promise<string> =>
    new Promise((resolve) => {
      if (!rl) {
        resolve("");
        return;
      }
      rl.question(q, (answer) => resolve(answer));
    });
  return {
    interactive: opts.interactive,
    ask: (q) => question(q),
    confirm: async (q, defaultYes = false) => {
      const answer = (await question(q)).trim().toLowerCase();
      if (!rl) return defaultYes;
      if (!answer) return defaultYes;
      return answer === "y" || answer === "yes";
    },
    close: () => rl?.close(),
  };
}

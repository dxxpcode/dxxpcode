const TTY = process.stdout.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export function color(s: string, ...codes: string[]): string {
  if (!COLOR) return s;
  return codes.join("") + s + C.reset;
}

export const dim = (s: string) => color(s, C.dim);
export const bold = (s: string) => color(s, C.bold);
export const green = (s: string) => color(s, C.green);
export const yellow = (s: string) => color(s, C.yellow);
export const red = (s: string) => color(s, C.red);
export const cyan = (s: string) => color(s, C.cyan);

export const SYM = { ok: "✓", warn: "⚠", fail: "✗", run: "→" };

export function write(s: string): void {
  process.stdout.write(s);
}

export function line(s = ""): void {
  process.stdout.write(s + "\n");
}

export function errLine(s: string): void {
  process.stderr.write(s + "\n");
}

/** Short one-line label for a tool call (path, command, or pattern). */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const cand = input["path"] ?? input["command"] ?? input["pattern"] ?? input["summary"];
  if (typeof cand === "string" && cand.length) {
    return `${tool} ${dim(cand.slice(0, 80))}`;
  }
  return tool;
}

/** Render a unified diff with colored +/- lines. */
export function renderDiff(diff: string): string {
  return diff
    .split("\n")
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) return bold(l);
      if (l.startsWith("+")) return green(l);
      if (l.startsWith("-")) return red(l);
      if (l.startsWith("@@")) return cyan(l);
      return l;
    })
    .join("\n");
}

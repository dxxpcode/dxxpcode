const TTY = process.stdout.isTTY === true;
const COLOR = TTY && !process.env.NO_COLOR;
/** Rich output (cards, spinner, rules) only on an interactive terminal. */
export const FANCY = TTY;

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

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

const WIDTH = Math.min(process.stdout.columns || 80, 100);

/** Horizontal rule across the terminal (TTY only; empty string otherwise). */
export function rule(): string {
  return FANCY ? dim("─".repeat(Math.min(WIDTH, 72))) : "";
}

/** ANSI-aware word wrap; hard-splits words longer than the width. */
function wrap(s: string, w: number): string[] {
  w = Math.max(1, w);
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const m of s.matchAll(/\x1b\[[0-9;]*m|\s+|\S+/g)) {
    const t = m[0];
    if (t.startsWith("\x1b")) {
      cur += t;
      continue;
    }
    if (/^\s+$/.test(t)) {
      if (curLen > 0 && curLen + t.length <= w) {
        cur += t;
        curLen += t.length;
      }
      continue;
    }
    if (curLen > 0 && curLen + t.length > w) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    let word = t;
    while (word.length > w) {
      out.push(word.slice(0, w));
      word = word.slice(w);
    }
    cur += word;
    curLen += word.length;
  }
  if (curLen > 0) out.push(cur);
  return out.length ? out : [""];
}

/**
 * Rounded card with a titled top border. Body lines are pre-styled and
 * word-wrapped to the card width. Falls back to an indented block when
 * not on a TTY.
 */
export function card(title: string, body: string[], accent = cyan): string[] {
  if (!FANCY) {
    return [title, ...body.map((l) => `  ${l}`)];
  }
  const w = Math.max(30, Math.min(WIDTH, 76));
  const cw = w - 4; // "│ " + content + " │"
  const dash = (n: number) => "─".repeat(Math.max(0, n));
  const top = dim("╭─") + ` ${bold(accent(title))} ` + dim(dash(w - 6 - visibleLen(title)) + "╮");
  const mid = body
    .flatMap((l) => wrap(l, cw))
    .map((l) => dim("│") + " " + l + " ".repeat(Math.max(0, cw - visibleLen(l))) + " " + dim("│"));
  const bot = dim("╰" + dash(w - 2) + "╯");
  return [top, ...mid, bot];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  start(label: string): void;
  stop(): void;
}

/**
 * Braille spinner drawn on the current line while the model is thinking.
 * No-op off a TTY. Unref'd so it never holds the process open.
 */
export function createSpinner(): Spinner {
  let timer: ReturnType<typeof setInterval> | null = null;
  let i = 0;
  let label = "";
  const draw = () => {
    if (TTY) write(`\r\x1b[2K  ${cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${dim(label)}`);
  };
  return {
    start(l: string) {
      label = l;
      if (!TTY || timer) return;
      draw();
      timer = setInterval(draw, 80);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (TTY) write("\r\x1b[2K");
    },
  };
}

/** Short one-line label for a tool call (path, command, or pattern). */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const cand = input["path"] ?? input["command"] ?? input["pattern"] ?? input["summary"];
  if (typeof cand === "string" && cand.length) {
    return `${tool} ${dim(cand.slice(0, 80))}`;
  }
  return tool;
}

/** Render a unified diff with colored +/- lines and a dim line-number gutter. */
export function renderDiff(diff: string): string {
  const out: string[] = [];
  let oldN = 0;
  let newN = 0;
  const gutter = (n: number) => dim(String(n).padStart(4) + " │");
  for (const l of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      out.push(cyan(l));
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) {
      out.push(bold(l));
    } else if (l.startsWith("+")) {
      out.push(`${gutter(newN++)} ${green(l)}`);
    } else if (l.startsWith("-")) {
      out.push(`${gutter(oldN++)} ${red(l)}`);
    } else if (l.startsWith("\\")) {
      out.push(`      ${dim(l)}`);
    } else if (oldN > 0 || newN > 0) {
      out.push(`${gutter(newN++)} ${dim(l)}`);
      oldN++;
    } else {
      out.push(l);
    }
  }
  return out.join("\n");
}

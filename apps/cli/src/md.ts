import { COLOR } from "./render.ts";

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDER = "\x1b[4m";
const STRIKE = "\x1b[9m";
const CODE = "\x1b[36;7m"; // cyan + inverse — reads like a code chip
const RESET = "\x1b[0m";

export interface MdStyler {
  /** Push a stream chunk; returns styled text ready to write. */
  push(chunk: string): string;
  /** End the burst: emit held marker chars literally and reset open styles. */
  flush(): string;
}

/**
 * Streaming-safe ANSI markdown renderer for model output.
 * Supports **bold**, *italic*, `code`, ~~strike~~, #..###### headers,
 * `-`/`+` bullets and `>` quotes. Trailing marker characters that may be
 * split across chunks are held until the next chunk or flush.
 */
export function createMdStyler(enabled = COLOR): MdStyler {
  let inBold = false;
  let inItalic = false;
  let inCode = false;
  let inStrike = false;
  let inHeader = false;
  let lineStart = true;
  let hold = "";

  const anyOpen = () => inBold || inItalic || inCode || inStrike || inHeader;
  const reset = () => {
    inBold = inItalic = inCode = inStrike = inHeader = false;
    return RESET;
  };

  const push = (chunk: string): string => {
    if (!enabled) return chunk;
    const inp = hold + chunk;
    hold = "";
    let out = "";
    let i = 0;
    while (i < inp.length) {
      const ch = inp[i];
      const last = i === inp.length - 1;
      if (inCode) {
        if (ch === "`") {
          inCode = false;
          out += RESET;
        } else if (ch === "\n") {
          // Unmatched backtick — close rather than garble later text.
          out += reset() + "\n";
          lineStart = true;
          i++;
          continue;
        } else {
          out += ch;
        }
        i++;
        continue;
      }
      if (ch === "`") {
        if (last) {
          hold = inp.slice(i);
          break;
        }
        inCode = true;
        out += CODE;
        i++;
        continue;
      }
      if (ch === "*") {
        if (inp[i + 1] === "*") {
          inBold = !inBold;
          out += inBold ? BOLD : RESET;
          i += 2;
          continue;
        }
        if (last) {
          hold = inp.slice(i);
          break;
        }
        if (lineStart && inp[i + 1] === " ") {
          out += "• ";
          i += 2;
          lineStart = false;
          continue;
        }
        inItalic = !inItalic;
        out += inItalic ? ITALIC : RESET;
        i++;
        continue;
      }
      if (ch === "~") {
        if (inp[i + 1] === "~") {
          inStrike = !inStrike;
          out += inStrike ? STRIKE : RESET;
          i += 2;
          continue;
        }
        if (last) {
          hold = inp.slice(i);
          break;
        }
      }
      if (lineStart && ch === "#") {
        const m = /^#{1,6} /.exec(inp.slice(i));
        if (m) {
          out += BOLD + UNDER;
          inHeader = true;
          i += m[0].length;
          lineStart = false;
          continue;
        }
        if (/^#{1,6}$/.test(inp.slice(i))) {
          hold = inp.slice(i);
          break; // "###" might be continued by the next chunk
        }
      }
      if (lineStart && (ch === "-" || ch === "+") && inp[i + 1] === " ") {
        out += "• ";
        i += 2;
        lineStart = false;
        continue;
      }
      if (lineStart && ch === ">" && inp[i + 1] === " ") {
        out += "\x1b[2m│ \x1b[0m";
        i += 2;
        lineStart = false;
        continue;
      }
      if (ch === "\n") {
        out += (anyOpen() ? reset() : "") + "\n";
        lineStart = true;
        i++;
        continue;
      }
      lineStart = false;
      out += ch;
      i++;
    }
    return out;
  };

  return {
    push,
    flush: () => {
      const tail = (anyOpen() ? RESET : "") + hold;
      hold = "";
      reset();
      lineStart = true;
      return tail;
    },
  };
}

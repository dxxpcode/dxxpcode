import type { ContentBlock, Message, ToolResultBlock } from "@dxxpcode/providers";

export interface CompactOptions {
  /** Estimated-token ceiling that triggers compaction. Default 60_000. */
  maxTokens?: number;
  /** Messages (counted from the tail) kept verbatim. Default 8. */
  keepRecent?: number;
  /** Lines kept from the head and tail of a compressed tool result. Default 20. */
  previewLines?: number;
}

export interface CompactResult {
  compacted: boolean;
  /** Estimated tokens before/after. */
  before: number;
  after: number;
  /** Tool results compressed this pass. */
  blocks: number;
}

const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_result") chars += b.content.length;
      else chars += JSON.stringify(b.input).length + b.name.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function preview(content: string, lines: number): string | null {
  const all = content.split("\n");
  const keep = lines * 2;
  if (all.length <= keep + 8) return null;
  const omitted = all.length - keep;
  return [
    ...all.slice(0, lines),
    `… (${omitted} lines omitted — re-run the tool if you need this output again)`,
    ...all.slice(-lines),
  ].join("\n");
}

/**
 * Deterministically compact the transcript when it grows past `maxTokens`:
 * old tool_result blocks shrink to a head+tail preview. The most recent
 * `keepRecent` messages stay verbatim, and tool_use/tool_result pairing is
 * preserved (results keep their ids), so the transcript remains valid.
 * Mutates `messages` in place.
 */
export function compactMessages(messages: Message[], opts: CompactOptions = {}): CompactResult {
  const maxTokens = opts.maxTokens ?? 60_000;
  const keepRecent = opts.keepRecent ?? 8;
  const previewLines = opts.previewLines ?? 20;

  const before = estimateTokens(messages);
  if (before <= maxTokens) return { compacted: false, before, after: before, blocks: 0 };

  const cutoff = Math.max(0, messages.length - keepRecent);
  let blocks = 0;
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    const content: ContentBlock[] = m.content.map((b) => {
      if (b.type !== "tool_result") return b;
      const next = preview(b.content, previewLines);
      if (next === null) return b;
      blocks++;
      const out: ToolResultBlock = { ...b, content: next };
      return out;
    });
    if (blocks > 0) messages[i] = { role: m.role, content };
  }
  return { compacted: blocks > 0, before, after: estimateTokens(messages), blocks };
}

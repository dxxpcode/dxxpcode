import type { Item } from "../types.js";

export type StreamEntry = { idx: number; item: Item };
export type ToolEntry = { idx: number; item: Extract<Item, { k: "tool" }> };
export type StreamSegment = StreamEntry | ToolEntry[];
export type StreamTurn = { key: number; segments: StreamSegment[] };

export function groupStreamTurns(items: Item[]): StreamTurn[] {
  const turns: StreamTurn[] = [];
  let turn: StreamTurn | undefined;

  items.forEach((item, idx) => {
    if (!turn || item.k === "user") {
      turn = { key: idx, segments: [] };
      turns.push(turn);
    }

    const previous = turn.segments[turn.segments.length - 1];
    if (item.k === "tool") {
      const entry: ToolEntry = { idx, item };
      if (Array.isArray(previous)) previous.push(entry);
      else turn.segments.push([entry]);
    } else {
      turn.segments.push({ idx, item });
    }
  });

  return turns;
}

const FAMILY_LABEL: Record<string, string> = {
  reads: "Exploration",
  writes: "File operations",
  danger: "System actions",
  shell: "Command activity",
  git: "Git checks",
  planx: "Planning",
};

export function toolGroupState(entries: ToolEntry[], toolFamilies: Record<string, string>): { pending: boolean; failed: number; label: string } {
  const families = new Set(entries.map(({ item }) => toolFamilies[item.tool] ?? "other"));
  return {
    pending: entries.some(({ item }) => item.pending),
    failed: entries.filter(({ item }) => item.isError).length,
    label: families.size === 1 && FAMILY_LABEL[[...families][0]]
      ? `${FAMILY_LABEL[[...families][0]]} · ${entries.length}`
      : `${entries.length} actions`,
  };
}

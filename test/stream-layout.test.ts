import { test } from "node:test";
import assert from "node:assert/strict";
import { groupStreamTurns, toolGroupState } from "../apps/desktop/src/lib/stream-layout.ts";
import type { Item } from "../apps/desktop/src/types.ts";
import { TOOL_FAMILY } from "../apps/desktop/src/types.ts";

const tool = (name: string, pending = false, isError = false): Item => ({
  k: "tool", tool: name, arg: "", pending, isError,
});

test("stream turns begin at user prompts and retain non-user prelude events", () => {
  const items: Item[] = [
    { k: "note", text: "restored" },
    { k: "user", text: "first" },
    { k: "text", text: "answer" },
    { k: "user", text: "second" },
    { k: "done", status: "completed", summary: "", filesChanged: [] },
  ];
  const turns = groupStreamTurns(items);
  assert.deepEqual(turns.map(({ key }) => key), [0, 1, 3]);
  assert.deepEqual(turns.map(({ segments }) => segments.length), [1, 2, 2]);
});

test("only consecutive tools collapse into one activity group", () => {
  const items: Item[] = [
    { k: "user", text: "task" },
    tool("read_file"), tool("search_files"),
    { k: "text", text: "progress" },
    tool("run_command"),
  ];
  const [{ segments }] = groupStreamTurns(items);
  assert.equal(Array.isArray(segments[1]) && segments[1].length, 2);
  assert.equal(Array.isArray(segments[2]), false);
  assert.equal(Array.isArray(segments[3]) && segments[3].length, 1);
});

test("activity state keeps pending and failed tools discoverable", () => {
  const items: Item[] = [tool("read_file"), tool("run_command", true), tool("edit_file", false, true)];
  const segment = groupStreamTurns(items)[0].segments[0];
  assert.ok(Array.isArray(segment));
  assert.deepEqual(toolGroupState(segment, TOOL_FAMILY), { pending: true, failed: 1, label: "3 actions" });
});

test("activity summaries describe homogeneous event groups", () => {
  const items: Item[] = [tool("read_file"), tool("search_files")];
  const segment = groupStreamTurns(items)[0].segments[0];
  assert.ok(Array.isArray(segment));
  assert.equal(toolGroupState(segment, TOOL_FAMILY).label, "Exploration · 2");
});

test("grouping preserves every item and its original streaming index", () => {
  const items: Item[] = [tool("read_file"), { k: "user", text: "task" }, tool("read_file"), tool("run_command"), { k: "text", text: "answer" }];
  const entries = groupStreamTurns(items).flatMap(({ segments }) => segments.flatMap((s) => Array.isArray(s) ? s : [s]));
  assert.deepEqual(entries.map(({ idx }) => idx), [0, 1, 2, 3, 4]);
  assert.deepEqual(entries.map(({ item }) => item), items);
  assert.deepEqual(groupStreamTurns([]), []);
});

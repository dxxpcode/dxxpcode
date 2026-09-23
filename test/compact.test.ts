import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMessages, estimateTokens } from "@dxxpcode/agent";
import type { Message } from "@dxxpcode/providers";

function bigResult(id: string, lines: number): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: id,
        content: Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n"),
      },
    ],
  };
}

test("compactMessages is a no-op under the token ceiling", () => {
  const messages: Message[] = [bigResult("t1", 50), { role: "assistant", content: [{ type: "text", text: "ok" }] }];
  const snapshot = JSON.stringify(messages);
  const result = compactMessages(messages, { maxTokens: 60_000 });
  assert.equal(result.compacted, false);
  assert.equal(JSON.stringify(messages), snapshot);
});

test("compactMessages compresses old tool results and keeps recent ones", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 5; i++) messages.push(bigResult(`old-${i}`, 300));
  for (let i = 0; i < 8; i++) messages.push(bigResult(`recent-${i}`, 300));

  const result = compactMessages(messages, { maxTokens: 10_000, keepRecent: 8 });
  assert.equal(result.compacted, true);
  assert.equal(result.blocks, 5);
  assert.ok(result.after < result.before);

  for (let i = 0; i < 5; i++) {
    const b = messages[i].content[0];
    assert.equal(b.type, "tool_result");
    assert.equal(b.toolUseId, `old-${i}`);
    assert.match(b.content, /lines omitted/);
    assert.match(b.content, /^line 0 /);
  }
  for (let i = 5; i < 13; i++) {
    const b = messages[i].content[0];
    assert.equal(b.type, "tool_result");
    assert.doesNotMatch(b.content, /lines omitted/);
    assert.equal(b.content.split("\n").length, 300);
  }
});

test("compactMessages never compresses below the keepRecent window", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 4; i++) messages.push(bigResult(`t${i}`, 500));
  const result = compactMessages(messages, { maxTokens: 1_000, keepRecent: 8 });
  assert.equal(result.blocks, 0);
});

test("estimateTokens scales with content size", () => {
  const small = estimateTokens([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  const big = estimateTokens([bigResult("t", 200)]);
  assert.ok(small < 10);
  assert.ok(big > 1_000);
});

test("compactMessages force compacts under the ceiling", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 10; i++) messages.push(bigResult(`t${i}`, 100));
  const result = compactMessages(messages, { force: true, keepRecent: 8 });
  assert.equal(result.compacted, true);
  assert.equal(result.blocks, 2);
  assert.ok(result.after < result.before);
});

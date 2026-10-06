import { test } from "node:test";
import assert from "node:assert/strict";
import { composerAction } from "../apps/desktop/src/lib/composer-layout.ts";

test("ordinary prompts send when idle and queue while a task is running", () => {
  assert.equal(composerAction("Fix the tests", false), "send");
  assert.equal(composerAction("Fix the tests", true), "queue");
  assert.equal(composerAction("  Fix the tests\n", true), "queue");
});

test("slash commands and steering never advertise queueing", () => {
  for (const command of ["/settings", "/clear", "/exit", "/new", "/steer focus on tests", "  /model custom  "]) {
    assert.equal(composerAction(command, false), "send");
    assert.equal(composerAction(command, true), "send");
  }
});

test("file and command completions take precedence over sending or queueing", () => {
  for (const running of [false, true]) {
    assert.equal(composerAction("Inspect @src", running, true), "complete");
    assert.equal(composerAction("/mod", running, false, true), "complete");
    assert.equal(composerAction("/model existing", running, false, false), "send");
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { dialogTabTarget } from "../apps/desktop/src/lib/dialog-navigation.ts";

test("dialog Tab wraps at both focus boundaries", () => {
  assert.equal(dialogTabTarget(3, 4, false), 0);
  assert.equal(dialogTabTarget(0, 4, true), 3);
});

test("dialog Tab preserves native navigation between interior elements", () => {
  assert.equal(dialogTabTarget(1, 4, false), null);
  assert.equal(dialogTabTarget(2, 4, true), null);
  assert.equal(dialogTabTarget(0, 4, false), null);
  assert.equal(dialogTabTarget(3, 4, true), null);
});

test("dialog focus entering from outside starts at the appropriate boundary", () => {
  assert.equal(dialogTabTarget(-1, 4, false), 0);
  assert.equal(dialogTabTarget(-1, 4, true), 3);
  assert.equal(dialogTabTarget(4, 4, false), 0);
});

test("a single focusable element retains focus in either direction", () => {
  assert.equal(dialogTabTarget(0, 1, false), 0);
  assert.equal(dialogTabTarget(0, 1, true), 0);
});

test("an empty dialog has no element target", () => {
  assert.equal(dialogTabTarget(-1, 0, false), null);
  assert.equal(dialogTabTarget(-1, 0, true), null);
});

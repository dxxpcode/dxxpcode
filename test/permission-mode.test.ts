import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_OPTIONS, PERMISSION_OPTIONS, composerMode, permissionMode, permissionOption } from "../apps/desktop/src/lib/permission-mode.ts";

test("permission options send the sidecar's /approval names", () => {
  assert.deepEqual(PERMISSION_OPTIONS.map((o) => o.value), ["ask", "smart", "always-approve"]);
  assert.deepEqual(PERMISSION_OPTIONS.map((o) => o.label), ["Ask for approval", "Approve for me", "Full access"]);
});

test("every mode spelling the engine or config uses maps to one option", () => {
  assert.equal(permissionMode("ask"), "ask");
  assert.equal(permissionMode("smart"), "smart");
  assert.equal(permissionMode("smart (Jev)"), "smart");
  assert.equal(permissionMode("always-approve"), "always-approve");
  assert.equal(permissionMode("auto"), "always-approve");
  assert.equal(permissionMode(undefined), "ask");
  assert.equal(permissionMode("unknown"), "ask");
  assert.equal(permissionOption("always-approve").short, "Full access");
});

test("plan is a fourth, exclusive mode layered over the approval mode", () => {
  assert.deepEqual(MODE_OPTIONS.map((o) => o.short), ["Ask", "Auto-review", "Full access", "Plan"]);
  assert.equal(composerMode("always-approve", true), "plan");
  assert.equal(composerMode("always-approve", false), "always-approve");
  assert.equal(composerMode(undefined, false), "ask");
});

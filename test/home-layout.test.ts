import { test } from "node:test";
import assert from "node:assert/strict";
import { isHomeConversation, recentSessions, sessionDetail, sessionTimestamp } from "../apps/desktop/src/lib/home-layout.ts";
import type { SessionSummary } from "../apps/desktop/src/lib/home-layout.ts";

const session = (id: string, when?: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, title: id, desc: "", when, ...extra,
});

test("empty sessions and configuration notes keep the home surface available", () => {
  assert.equal(isHomeConversation([]), true);
  assert.equal(isHomeConversation([{ k: "note" }]), true);
  assert.equal(isHomeConversation([{ k: "note" }, { k: "note", steer: false }]), true);
});

test("a task, restored conversation, error, or steering message belongs in the transcript", () => {
  for (const item of [
    { k: "user" }, { k: "text" }, { k: "tool" }, { k: "plan" },
    { k: "error" }, { k: "done" }, { k: "note", steer: true },
  ]) {
    assert.equal(isHomeConversation([{ k: "note" }, item]), false);
  }
});

test("home shows four most recent sessions without changing the pinned-first rail order", () => {
  const sessions = [
    session("pinned", "2026-10-01T12:00:00Z", { pinned: true }),
    session("newest", "2026-10-19T12:00:00Z"),
    session("second", "2026-10-18T12:00:00Z"),
    session("third", "2026-10-17T12:00:00Z"),
    session("fourth", "2026-10-16T12:00:00Z"),
  ];
  assert.deepEqual(recentSessions(sessions).map((s) => s.id), ["newest", "second", "third", "fourth"]);
  assert.equal(sessions[0].id, "pinned");
});

test("home tolerates empty lists, missing timestamps, and invalid dates", () => {
  assert.deepEqual(recentSessions([]), []);
  const sessions = [
    session("missing"),
    session("invalid", "not a date"),
    session("dated", "2026-10-19T12:00:00Z"),
    session("legacy", undefined, { desc: "2026-10-18 · 2 msg" }),
  ];
  assert.deepEqual(recentSessions(sessions).map((s) => s.id), ["dated", "legacy", "missing", "invalid"]);
});

test("home accepts sidecar timestamps with spaces and keeps equal-date order stable", () => {
  const sessions = [
    session("older", "2026-10-18 09:00"),
    session("first", "2026-10-19 09:00"),
    session("second", "2026-10-19 09:00"),
  ];
  assert.deepEqual(recentSessions(sessions).map((s) => s.id), ["first", "second", "older"]);
});

test("home sorts and displays the same valid timestamp, including legacy metadata", () => {
  const legacy = session("legacy", "invalid", { desc: "2026-10-18 · 2 msg" });
  assert.equal(sessionTimestamp(legacy), "2026-10-18T00:00:00.000Z");
  assert.equal(sessionTimestamp(session("current", "2026-10-19T09:00:00Z")), "2026-10-19T09:00:00.000Z");
  assert.equal(sessionTimestamp(session("unknown", "invalid", { desc: "unknown · 2 msg" })), undefined);
  assert.equal(sessionTimestamp(session("missing")), undefined);
  assert.deepEqual(recentSessions([legacy, session("older", "2026-10-17T09:00:00Z")]).map((s) => s.id), ["legacy", "older"]);
});

test("home metadata counts actual unique changed files instead of implying a branch", () => {
  assert.equal(sessionDetail(session("a", undefined, { files: ["a.ts"], status: "success" })), "1 file changed");
  assert.equal(sessionDetail(session("a", undefined, { files: ["a.ts", "b.ts", "a.ts"] })), "2 files changed");
});

test("home metadata shows a recorded outcome when there are no changed files", () => {
  for (const [status, expected] of [
    ["success", "Completed"], ["completed", "Completed"], ["done", "Completed"],
    ["error", "Failed"], ["failed", "Failed"], ["cancelled", "Cancelled"], ["canceled", "Cancelled"],
    ["denied", "Denied"], [" Custom outcome ", "Custom outcome"],
  ]) {
    assert.equal(sessionDetail(session("a", undefined, { files: [], status })), expected);
  }
});

test("home does not hide an unsuccessful outcome behind a changed-file count", () => {
  assert.equal(sessionDetail(session("a", undefined, { files: ["a.ts"], status: "error" })), "1 file changed · Failed");
  assert.equal(sessionDetail(session("a", undefined, { files: ["a.ts", "b.ts"], status: "canceled" })), "2 files changed · Cancelled");
  assert.equal(sessionDetail(session("a", undefined, { files: ["a.ts"], status: "interrupted" })), "1 file changed · Interrupted");
});

test("home does not invent a completed state or file count for missing metadata", () => {
  assert.equal(sessionDetail(session("a")), "");
  assert.equal(sessionDetail(session("a", undefined, { files: [], status: " " })), "");
});

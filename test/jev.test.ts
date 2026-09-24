import { strict as assert } from "node:assert";
import test from "node:test";
import { jevRouteEffort, smartApprove } from "../apps/cli/src/jev.ts";
import type { ApprovalRequest } from "../packages/agent/src/runtime.ts";

const req: ApprovalRequest = {
  tool: "run_command",
  input: { command: "npm test" },
  decision: { level: "approval", reason: "runs a shell command" },
};

function stub(answers: unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "jev-1", answers }))) as typeof fetch;
  return () => (globalThis.fetch = real);
}

test("smartApprove auto-approves high-confidence 'approve' verdicts", async () => {
  const restore = stub({
    verdict: { type: "choice", choice: "approve", confidence: 0.95, probabilities: {} },
  });
  try {
    assert.deepEqual(await smartApprove(req, "key"), { approve: true, confidence: 0.95 });
  } finally {
    restore();
  }
});

test("smartApprove escalates low-confidence and 'escalate' verdicts", async () => {
  for (const ans of [
    { type: "choice", choice: "approve", confidence: 0.5 },
    { type: "choice", choice: "escalate", confidence: 0.99 },
  ]) {
    const restore = stub({ verdict: ans });
    try {
      assert.equal((await smartApprove(req, "key"))?.approve, false);
    } finally {
      restore();
    }
  }
});

test("smartApprove returns null when Jev is unreachable", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  try {
    assert.equal(await smartApprove(req, "key"), null);
  } finally {
    globalThis.fetch = real;
  }
});

test("jevRouteEffort maps a valid tier choice, nulls on bad choice", async () => {
  const restore = stub({
    effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
  });
  try {
    assert.deepEqual(await jevRouteEffort("fix the auth bug", "key"), { effort: "high", confidence: 0.9 });
  } finally {
    restore();
  }

  const restore2 = stub({ effort: { type: "choice", choice: "bogus", confidence: 0.9 } });
  try {
    assert.equal(await jevRouteEffort("x", "key"), null);
  } finally {
    restore2();
  }
});

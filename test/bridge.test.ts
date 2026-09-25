import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "@dxxpcode/bridge";
import type { MockTurn } from "@dxxpcode/providers";
import { loadSession } from "@dxxpcode/sessions";

const FIXTURE = fileURLToPath(new URL("./fixtures/node-app", import.meta.url));
const AGENTD = fileURLToPath(new URL("../apps/agentd/src/main.ts", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dxxp-bridge-"));
  cpSync(FIXTURE, root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  const home = mkdtempSync(join(tmpdir(), "dxxp-home-"));
  const env = { ...process.env, DXXPCODE_HOME: home } as NodeJS.ProcessEnv;
  return { root, env, home };
}

const PLAN_THEN_RM: MockTurn[] = [
  {
    toolCalls: [
      {
        name: "propose_plan",
        input: { summary: "Clean build output", steps: ["rm -rf build", "Report"] },
      },
    ],
  },
  { toolCalls: [{ name: "run_command", input: { command: "rm -rf build", reason: "clean artifacts" } }] },
  { text: "Done cleaning." },
];

const TRIVIAL: MockTurn[] = [
  {
    toolCalls: [
      {
        name: "propose_plan",
        input: { summary: "Say hi", steps: ["Reply"], trivial: true },
      },
    ],
  },
  { text: "Hi!" },
];

type Msg = Record<string, unknown>;

/** In-process wire: drive the bridge directly, capture every emitted line. */
function wire(script: MockTurn[], env: NodeJS.ProcessEnv, defaults?: { autoApprove?: boolean }) {
  const msgs: Msg[] = [];
  const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  const onLine = (l: string) => {
    const m = JSON.parse(l) as Msg;
    msgs.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  const scriptPath = join(env.DXXPCODE_HOME as string, "mock.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const e = { ...env, DXXPCODE_PROVIDER: "mock", DXXPCODE_MOCK_SCRIPT: scriptPath };
  const bridge = createBridge({ write: onLine, env: e, defaults });
  let reqId = 0;
  return {
    send(method: string, params?: Msg) {
      bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ++reqId, method, params }));
      return reqId;
    },
    events() {
      return msgs.filter((m) => m.method === "event");
    },
    waitFor(pred: (m: Msg) => boolean, ms = 10000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<Msg>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("waitFor timed out")), ms);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

type Api = ReturnType<typeof wire>;

function eventType(m: Msg): string {
  return ((m.params as Msg).event as Msg).type as string;
}

function eventOf(m: Msg, type: string): boolean {
  return m.method === "event" && eventType(m) === type;
}

function resultOf(done: Msg): Msg {
  return ((done.params as Msg).event as Msg).result as Msg;
}

function untilDone(api: Api, sessionId: string) {
  return api.waitFor((m) => m.method === "event" && eventType(m) === "done" && (m.params as Msg).sessionId === sessionId);
}

test("bridge: plan approve → tool approve → done, with persisted session", async () => {
  const { root, env } = setup();
  const api = wire(PLAN_THEN_RM, env);
  const startId = api.send("run.start", { projectRoot: root, task: "clean build" });

  const startResp = await api.waitFor((m) => m.id === startId);
  const sessionId = (startResp.result as Msg).sessionId as string;
  assert.ok(sessionId, "run.start returns a sessionId");

  const planEv = await api.waitFor((m) => eventOf(m, "plan") && (m.params as Msg).sessionId === sessionId);
  const planParams = planEv.params as Msg;
  assert.ok(planParams.requestId, "plan event must carry requestId");
  api.send("plan.respond", { requestId: planParams.requestId, approve: true });

  const apEv = await api.waitFor((m) => eventOf(m, "approval_request"));
  const apParams = apEv.params as Msg;
  assert.ok(apParams.requestId);
  api.send("approval.respond", { requestId: apParams.requestId, allow: true });

  const doneEv = await untilDone(api, sessionId);
  const result = resultOf(doneEv);
  assert.equal(result.status, "completed");
  assert.equal(result.sessionId, sessionId);

  const rec = loadSession(sessionId, env);
  assert.ok(rec, "session record persisted");
  assert.equal(rec!.projectRoot, root);
});

test("bridge: rejected plan finishes as denied", async () => {
  const { root, env } = setup();
  const api = wire(PLAN_THEN_RM, env);
  api.send("run.start", { projectRoot: root, task: "clean build" });
  const planEv = await api.waitFor((m) => eventOf(m, "plan"));
  const pp = planEv.params as Msg;
  api.send("plan.respond", { requestId: pp.requestId, approve: false });
  const done = await untilDone(api, pp.sessionId as string);
  assert.equal(resultOf(done).status, "denied");
});

test("bridge: rejected tool call surfaces a denied event", async () => {
  const { root, env } = setup();
  const api = wire(PLAN_THEN_RM, env);
  api.send("run.start", { projectRoot: root, task: "clean build" });
  const planEv = await api.waitFor((m) => eventOf(m, "plan"));
  api.send("plan.respond", { requestId: (planEv.params as Msg).requestId, approve: true });
  const apEv = await api.waitFor((m) => eventOf(m, "approval_request"));
  const sessionId = (apEv.params as Msg).sessionId as string;
  api.send("approval.respond", { requestId: (apEv.params as Msg).requestId, allow: false });
  const denied = await api.waitFor((m) => eventOf(m, "denied") && (m.params as Msg).sessionId === sessionId);
  assert.ok(denied, "denied event emitted");
  const done = await untilDone(api, sessionId);
  assert.equal(resultOf(done).status, "completed");
});

test("bridge: always-allow dedupes identical approval prompts", async () => {
  const { root, env } = setup();
  const script: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "x", steps: ["a"], trivial: true } }] },
    { toolCalls: [{ name: "run_command", input: { command: "rm -rf build" } }] },
    { toolCalls: [{ name: "run_command", input: { command: "rm -rf build" } }] },
    { text: "done" },
  ];
  const api = wire(script, env);
  api.send("run.start", { projectRoot: root, task: "t" });
  const apEv = await api.waitFor((m) => eventOf(m, "approval_request"));
  const ap = apEv.params as Msg;
  api.send("approval.respond", { requestId: ap.requestId, allow: true, always: true });
  const done = await untilDone(api, ap.sessionId as string);
  const approvals = api.events().filter((m) => eventOf(m, "approval_request") && (m.params as Msg).requestId);
  assert.equal(approvals.length, 1, "second identical command must not re-prompt");
  assert.equal(resultOf(done).status, "completed");
});

test("bridge: run.cancel aborts an in-flight run", async () => {
  const { root, env } = setup();
  const api = wire([{ delayMs: 200, toolCalls: [{ name: "read_file", input: { path: "package.json" } }] }], env);
  api.send("run.start", { projectRoot: root, task: "t" });
  const status = await api.waitFor((m) => m.method === "event");
  const sessionId = (status.params as Msg).sessionId as string;
  api.send("run.cancel", { sessionId });
  const done = await untilDone(api, sessionId);
  assert.equal(resultOf(done).status, "cancelled");
});

test("bridge: run.cancel on a finished run errors", async () => {
  const { root, env } = setup();
  const api = wire(TRIVIAL, env);
  api.send("run.start", { projectRoot: root, task: "hi" });
  const done = await api.waitFor((m) => eventOf(m, "done"));
  const id = api.send("run.cancel", { sessionId: (done.params as Msg).sessionId });
  const resp = await api.waitFor((m) => m.id === id);
  assert.equal((resp.error as Msg).code, -32001);
});

test("bridge: trivial plan executes without a requestId", async () => {
  const { root, env } = setup();
  const api = wire(TRIVIAL, env);
  api.send("run.start", { projectRoot: root, task: "hi" });
  const doneEv = await api.waitFor((m) => eventOf(m, "done"));
  const plans = api.events().filter((m) => eventOf(m, "plan"));
  assert.equal(plans.length, 1);
  assert.equal((plans[0].params as Msg).requestId, undefined);
  assert.equal(resultOf(doneEv).status, "completed");
});

test("bridge: planOnly ends after the plan without prompting", async () => {
  const { root, env } = setup();
  const api = wire(PLAN_THEN_RM, env);
  api.send("run.start", { projectRoot: root, task: "clean build", planOnly: true });
  const done = await api.waitFor((m) => eventOf(m, "done"));
  assert.equal(resultOf(done).status, "plan_only");
  const approvals = api.events().filter((m) => eventOf(m, "approval_request"));
  assert.equal(approvals.length, 0);
});

test("bridge: session.list and session.get reflect finished runs", async () => {
  const { root, env } = setup();
  const api = wire(TRIVIAL, env);
  api.send("run.start", { projectRoot: root, task: "hi" });
  const done = await api.waitFor((m) => eventOf(m, "done"));
  const sessionId = (done.params as Msg).sessionId as string;

  let id = api.send("session.list", {});
  let resp = await api.waitFor((m) => m.id === id);
  const summaries = resp.result as Msg[];
  const found = summaries.find((s) => s.id === sessionId);
  assert.ok(found, "session.list includes the new session");
  assert.equal(found.projectRoot, root);
  assert.equal(found.task, "hi");

  id = api.send("session.get", { id: sessionId });
  resp = await api.waitFor((m) => m.id === id);
  const rec = resp.result as Msg;
  assert.equal(rec.id, sessionId);
  assert.ok(Array.isArray(rec.messages));

  id = api.send("session.delete", { id: sessionId });
  resp = await api.waitFor((m) => m.id === id);
  id = api.send("session.get", { id: sessionId });
  resp = await api.waitFor((m) => m.id === id);
  assert.equal((resp.error as Msg).code, -32602);
});

test("bridge: resume continues a stored session", async () => {
  const { root, env } = setup();
  const api = wire(TRIVIAL, env);
  api.send("run.start", { projectRoot: root, task: "hi" });
  const done = await api.waitFor((m) => eventOf(m, "done"));
  const sessionId = (done.params as Msg).sessionId as string;

  const api2 = wire([{ text: "resumed ok" }], env);
  api2.send("run.start", { projectRoot: root, task: "again", resumeSessionId: sessionId });
  const done2 = await api2.waitFor((m) => eventOf(m, "done"));
  assert.equal(resultOf(done2).status, "completed");
  const rec = loadSession(sessionId, env);
  assert.ok(rec!.messages.length >= 4, "resumed session accumulated messages");
});

test("bridge: error paths — unknown method, bad params, unknown requestId", async () => {
  const { env } = setup();
  const api = wire(TRIVIAL, env);
  let id = api.send("nope.method", {});
  let resp = await api.waitFor((m) => m.id === id);
  assert.equal((resp.error as Msg).code, -32601);

  id = api.send("run.start", { task: "x" }); // missing projectRoot
  resp = await api.waitFor((m) => m.id === id);
  assert.equal((resp.error as Msg).code, -32602);

  id = api.send("plan.respond", { requestId: "req_999", approve: true });
  resp = await api.waitFor((m) => m.id === id);
  assert.equal((resp.error as Msg).code, -32002);
});

test("bridge: config.set rejects secret fields", async () => {
  const { env } = setup();
  const api = wire(TRIVIAL, env);
  const id = api.send("config.set", { config: { anthropicApiKey: "sk-x" } });
  const resp = await api.waitFor((m) => m.id === id);
  assert.equal((resp.error as Msg).code, -32602);
});

test("bridge: secrets.set stores keys for provider resolution", async () => {
  const { env } = setup();
  const msgs: Msg[] = [];
  const bare = createBridge({
    write: (l) => msgs.push(JSON.parse(l) as Msg),
    env: { ...env, DXXPCODE_PROVIDER: "mock", DXXPCODE_MOCK_SCRIPT: undefined },
  });
  let rid = 0;
  bare.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "secrets.set", params: { provider: "anthropic", key: "sk-test" } }));
  await new Promise((r) => setTimeout(r, 10));
  const resp = msgs.find((m) => m.id === rid);
  assert.ok(resp?.result);
  const bad = msgs.filter((m) => m.error);
  assert.equal(bad.length, 0);
});

test("agentd: end-to-end over real stdio", async () => {
  const { root, env } = setup();
  const scriptPath = join(env.DXXPCODE_HOME as string, "mock-e2e.json");
  writeFileSync(scriptPath, JSON.stringify(PLAN_THEN_RM));

  const child = spawn("node", ["--conditions=development", AGENTD, "--provider", "mock"], {
    env: { ...process.env, DXXPCODE_HOME: env.DXXPCODE_HOME as string, DXXPCODE_MOCK_SCRIPT: scriptPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const msgs: Msg[] = [];
  const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  const expect = (pred: (m: Msg) => boolean) =>
    new Promise<Msg>((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("agentd expect timed out")), 15000);
    });

  const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  rl.on("line", (l) => {
    const m = JSON.parse(l) as Msg;
    msgs.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });

  const rpc = (id: number, method: string, params?: Msg) =>
    (child.stdin as NodeJS.WritableStream).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

  rpc(1, "ping");
  const pong = await expect((m) => m.id === 1);
  assert.equal((pong.result as Msg).version, "0.1.0");

  rpc(2, "run.start", { projectRoot: root, task: "clean build" });
  const start = await expect((m) => m.id === 2);
  const sessionId = (start.result as Msg).sessionId as string;
  assert.ok(sessionId);

  const planEv = await expect((m) => eventOf(m, "plan"));
  rpc(3, "plan.respond", { requestId: (planEv.params as Msg).requestId, approve: true });

  const apEv = await expect((m) => eventOf(m, "approval_request"));
  rpc(4, "approval.respond", { requestId: (apEv.params as Msg).requestId, allow: true });

  const done = await expect((m) => eventOf(m, "done"));
  assert.equal(resultOf(done).status, "completed");

  // Golden ordering: status → plan → approval_request → tool run → done.
  const types = msgs.filter((m) => m.method === "event").map(eventType);
  assert.deepEqual(
    types.filter((t) => ["status", "plan", "approval_request", "tool_start", "tool_end", "done"].includes(t)),
    ["status", "plan", "approval_request", "tool_start", "tool_end", "done"],
  );

  (child.stdin as NodeJS.WritableStream).end();
  child.kill();
  const rec = loadSession(sessionId, env);
  assert.ok(existsSync(join(env.DXXPCODE_HOME as string, "sessions", `${sessionId}.json`)) && rec);
});

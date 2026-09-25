import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTask } from "@dxxpcode/agent";
import type { AgentEvent, RunResult } from "@dxxpcode/agent";
import { MockProvider } from "@dxxpcode/providers";
import type { MockTurn } from "@dxxpcode/providers";
import { latestSessionFor } from "@dxxpcode/sessions";

const FIXTURE = fileURLToPath(new URL("./fixtures/node-app", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dxxp-agent-"));
  cpSync(FIXTURE, root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  const home = mkdtempSync(join(tmpdir(), "dxxp-home-"));
  const env = { ...process.env, DXXPCODE_HOME: home } as NodeJS.ProcessEnv;
  return { root, env };
}

const FIX_TURNS: MockTurn[] = [
  {
    toolCalls: [
      {
        name: "propose_plan",
        input: {
          summary: "Fix add() and verify with npm test",
          steps: ["Read src/math.js", "Fix the subtraction bug", "Run npm test"],
        },
      },
    ],
  },
  { toolCalls: [{ name: "read_file", input: { path: "src/math.js" } }] },
  {
    toolCalls: [
      { name: "edit_file", input: { path: "src/math.js", old_string: "return a - b", new_string: "return a + b" } },
    ],
  },
  { toolCalls: [{ name: "run_command", input: { command: "npm test" } }] },
  { text: "Fixed add(); tests pass." },
];

async function collect(opts: Parameters<typeof runTask>[0]) {
  const events: AgentEvent[] = [];
  let result: RunResult | undefined;
  for await (const ev of runTask(opts)) {
    events.push(ev);
    if (ev.type === "done") result = ev.result;
  }
  return { events, result: result! };
}

test("agent fixes a bug end-to-end with a scripted provider", async () => {
  const { root, env } = setup();
  const { result, events } = await collect({
    task: "fix the failing test",
    provider: new MockProvider(FIX_TURNS),
    model: "mock",
    projectRoot: root,
    env,
    approvePlan: async () => true,
    approveTool: async () => true,
  });

  assert.equal(result.status, "completed");
  assert.match(readFileSync(join(root, "src/math.js"), "utf8"), /return a \+ b/);
  assert.ok(result.filesChanged.includes("src/math.js"));
  assert.ok(result.commands.includes("npm test"));
  assert.ok(events.some((e) => e.type === "plan"));

  // Real verification: the fixture test now passes.
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  const out = execFileSync("npm", ["test", "--silent"], { cwd: root, encoding: "utf8", env: cleanEnv });
  assert.match(out + "", /pass 1|ok 1/);

  // Session persisted and resumable.
  const saved = latestSessionFor(root, env);
  assert.equal(saved?.id, result.sessionId);
  assert.equal(saved?.result, result.summary);
});

test("plan-only mode stops before any mutation", async () => {
  const { root, env } = setup();
  const provider = new MockProvider(FIX_TURNS);
  const { result } = await collect({
    task: "fix the failing test",
    provider,
    model: "mock",
    projectRoot: root,
    planOnly: true,
    env,
    approvePlan: async () => true,
  });
  assert.equal(result.status, "plan_only");
  assert.equal(result.plan?.steps.length, 3);
  assert.match(readFileSync(join(root, "src/math.js"), "utf8"), /return a - b/);
  assert.equal(provider.requests.length, 1);
});

test("rejected plan aborts before execution", async () => {
  const { root, env } = setup();
  const { result } = await collect({
    task: "fix the failing test",
    provider: new MockProvider(FIX_TURNS),
    model: "mock",
    projectRoot: root,
    env,
    approvePlan: async () => false,
  });
  assert.equal(result.status, "denied");
  assert.match(readFileSync(join(root, "src/math.js"), "utf8"), /return a - b/);
});

test("trivial plans skip approval and execute directly", async () => {
  const { root, env } = setup();
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "one-liner", steps: ["fix"], trivial: true } }] },
    {
      toolCalls: [
        { name: "edit_file", input: { path: "src/math.js", old_string: "return a - b", new_string: "return a + b" } },
      ],
    },
    { text: "done" },
  ];
  const { result } = await collect({
    task: "typo fix",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
    // no approvePlan — trivial plans must not require it
  });
  assert.equal(result.status, "completed");
  assert.match(readFileSync(join(root, "src/math.js"), "utf8"), /a \+ b/);
});

test("restricted actions are denied without calling the approver", async () => {
  const { root, env } = setup();
  let approvalsAsked = 0;
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "s", steps: ["x"], trivial: true } }] },
    { toolCalls: [{ name: "read_file", input: { path: ".env" } }] },
    { toolCalls: [{ name: "write_file", input: { path: "../out.txt", content: "x" } }] },
    { text: "done" },
  ];
  const { result, events } = await collect({
    task: "try restricted things",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
    approveTool: async () => {
      approvalsAsked++;
      return true;
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(approvalsAsked, 0);
  assert.ok(events.filter((e) => e.type === "denied").length >= 2);
});

test("approval-required tools call the approver and honor denial", async () => {
  const { root, env } = setup();
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "s", steps: ["x"], trivial: true } }] },
    { toolCalls: [{ name: "run_command", input: { command: "rm -rf src" } }] },
    { text: "done" },
  ];
  const { result, events } = await collect({
    task: "delete things",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
    approveTool: async () => false,
  });
  assert.equal(result.status, "completed");
  assert.ok(events.some((e) => e.type === "denied" && /not approved/.test(e.reason)));
  // src still exists — command never ran.
  readFileSync(join(root, "src/math.js"), "utf8");
});

test("max iterations bounds the loop", async () => {
  const { root, env } = setup();
  const { result } = await collect({
    task: "loop forever",
    provider: new MockProvider((_, turn) =>
      turn === 0
        ? { toolCalls: [{ name: "propose_plan", input: { summary: "s", steps: ["x"], trivial: true } }] }
        : { toolCalls: [{ name: "run_command", input: { command: "true" } }] },
    ),
    model: "mock",
    projectRoot: root,
    env,
    maxIterations: 5,
  });
  assert.equal(result.status, "max_iterations");
});

test("todo_write emits a live checklist and persists it on the session", async () => {
  const { root, env } = setup();
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "s", steps: ["x"], trivial: true } }] },
    {
      toolCalls: [
        {
          name: "todo_write",
          input: {
            todos: [
              { id: "1", content: "Read the file", status: "completed" },
              { id: "2", content: "Apply the fix", status: "in_progress", activeForm: "Applying the fix" },
              { id: "3", content: "Run tests", status: "pending" },
            ],
          },
        },
      ],
    },
    { text: "done" },
  ];
  const { result, events } = await collect({
    task: "track a checklist",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
  });
  assert.equal(result.status, "completed");
  const todo = events.find((e) => e.type === "todo");
  assert.ok(todo && todo.type === "todo");
  assert.equal(todo.items.length, 3);
  assert.equal(todo.items[1].status, "in_progress");
  // Persisted on the session so the checklist survives --resume.
  const saved = latestSessionFor(root, env);
  assert.equal(saved?.todos?.length, 3);
});

test("todo_write is execute-phase only (not a plan-phase tool)", async () => {
  const { root, env } = setup();
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "todo_write", input: { todos: [{ id: "1", content: "x", status: "pending" }] } }] },
    { toolCalls: [{ name: "propose_plan", input: { summary: "s", steps: ["x"], trivial: true } }] },
    { text: "done" },
  ];
  const { result, events } = await collect({
    task: "try checklist during planning",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
  });
  assert.equal(result.status, "completed");
  assert.ok(!events.some((e) => e.type === "todo"));
});

test("file mutations are checkpointed and undoable", async () => {
  const { root, env } = setup();
  const { undoCheckpoint, checkpointCount } = await import("@dxxpcode/agent");
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "s", steps: ["x"], trivial: true } }] },
    {
      toolCalls: [
        { name: "edit_file", input: { path: "src/math.js", old_string: "return a - b", new_string: "return a + b" } },
        { name: "write_file", input: { path: "new.js", content: "// new\n" } },
      ],
    },
    { text: "done" },
  ];
  const { result, events } = await collect({
    task: "make changes",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
  });
  assert.equal(result.status, "completed");
  assert.equal(events.filter((e) => e.type === "checkpoint").length, 2);

  const saved = latestSessionFor(root, env);
  assert.equal(checkpointCount(saved!.id, env), 2);

  // Undo newest-first: new.js disappears, then math.js reverts.
  const u1 = undoCheckpoint(root, saved!.id, env);
  assert.ok(u1);
  assert.deepEqual(u1.removed, ["new.js"]);
  const u2 = undoCheckpoint(root, saved!.id, env);
  assert.ok(u2);
  assert.deepEqual(u2.restored, ["src/math.js"]);
  assert.match(readFileSync(join(root, "src/math.js"), "utf8"), /return a - b/);
  assert.equal(undoCheckpoint(root, saved!.id, env), null);
});

test("checkpoints record HEAD; undo reports when HEAD moved", async () => {
  const { root, env } = setup();
  const { takeCheckpoint, undoCheckpoint } = await import("@dxxpcode/agent");
  const cp = takeCheckpoint(root, ["src/math.js"], "s-git", env);
  assert.ok(cp?.headSha);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "move", "--allow-empty"], {
    cwd: root,
  });
  const res = undoCheckpoint(root, "s-git", env);
  assert.ok(res?.headMoved);
  assert.equal(res!.headMoved!.from, cp!.headSha);
});

test("secrets in tool output are redacted before the transcript and context", async () => {
  const { root, env } = setup();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(root, "keys.txt"),
    "openai=sk-proj-abc123def456ghi789 gh=ghp_0123456789abcdefXYZ custom=hunter2supersecret\n",
  );
  const env2 = { ...env, MY_API_TOKEN: "hunter2supersecret" };
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "Read keys", steps: ["read"] } }] },
    { toolCalls: [{ name: "read_file", input: { path: "keys.txt" } }] },
    { text: "done" },
  ];
  const { events } = await collect({
    task: "read keys",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env: env2,
    approvePlan: async () => true,
    approveTool: async () => true,
  });
  const toolEnd = events.find((e) => e.type === "tool_end" && e.tool === "read_file");
  assert.ok(toolEnd && toolEnd.type === "tool_end");
  const out = toolEnd.result.content;
  assert.ok(!out.includes("sk-proj-abc123def456ghi789"), "openai key leaked");
  assert.ok(!out.includes("ghp_0123456789abcdefXYZ"), "github token leaked");
  assert.ok(!out.includes("hunter2supersecret"), "env secret leaked");
  assert.match(out, /\[redacted\]/);

  // The model-visible context in the saved session is masked too.
  const saved = latestSessionFor(root, env2);
  const blob = JSON.stringify(saved!.messages);
  assert.ok(!blob.includes("sk-proj-abc123def456ghi789"));
  assert.ok(!blob.includes("hunter2supersecret"));
});

test("steering messages are injected after the tool batch", async () => {
  const { root, env } = setup();
  const queue = ["use subtraction instead"];
  const turns: MockTurn[] = [
    { toolCalls: [{ name: "propose_plan", input: { summary: "x", steps: ["s"], trivial: true } }] },
    { toolCalls: [{ name: "read_file", input: { path: "src/math.js" } }] },
    { text: "done" },
  ];
  await collect({
    task: "fix math",
    provider: new MockProvider(turns),
    model: "mock",
    projectRoot: root,
    env,
    approvePlan: async () => true,
    approveTool: async () => true,
    steer: () => queue.shift(),
  });
  const saved = latestSessionFor(root, env)!;
  const steerMsg = saved.messages.find(
    (m) => m.role === "user" && JSON.stringify(m.content).includes("use subtraction instead"),
  );
  assert.ok(steerMsg, "steering message not in context");
  assert.match(JSON.stringify(steerMsg.content), /while you were working/);
});

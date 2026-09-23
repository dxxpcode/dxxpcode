import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  deleteFile,
  editFile,
  findTool,
  parseTodos,
  renderTodos,
  gitDiff,
  gitStatus,
  listDirectory,
  checkProcess,
  killProcess,
  readFile,
  runBackground,
  runCommand,
  searchFiles,
  toolsForPhase,
  writeFile,
} from "@dxxpcode/tools";
import type { ToolContext } from "@dxxpcode/tools";

const FIXTURE = fileURLToPath(new URL("./fixtures/node-app", import.meta.url));

function setup(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), "dxxp-tools-"));
  cpSync(FIXTURE, root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
  return { root, ctx: { root } };
}

test("read_file returns numbered lines and errors on missing", async () => {
  const { ctx } = setup();
  const res = await readFile.execute({ path: "src/math.js" }, ctx);
  assert.match(res.content, /1\texport function add/);
  const missing = await readFile.execute({ path: "nope.js" }, ctx);
  assert.equal(missing.isError, true);
});

test("write_file creates parents and reports the change", async () => {
  const { root, ctx } = setup();
  const res = await writeFile.execute({ path: "a/b/c.txt", content: "hi\n" }, ctx);
  assert.equal(res.changedFile, "a/b/c.txt");
  assert.equal(readFileSync(join(root, "a/b/c.txt"), "utf8"), "hi\n");
});

test("edit_file replaces a unique match; rejects ambiguous", async () => {
  const { root, ctx } = setup();
  writeFileSync(join(root, "dup.txt"), "x x\n");
  const ambiguous = await editFile.execute({ path: "dup.txt", old_string: "x", new_string: "y" }, ctx);
  assert.equal(ambiguous.isError, true);
  const res = await editFile.execute({ path: "src/math.js", old_string: "return a - b", new_string: "return a + b" }, ctx);
  assert.equal(res.changedFile, "src/math.js");
  assert.match(readFileSync(join(root, "src/math.js"), "utf8"), /a \+ b/);
});

test("search_files finds regex matches and skips protected files", async () => {
  const { root, ctx } = setup();
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "note.txt"), "the needle\n");
  const res = await searchFiles.execute({ pattern: "needle|SECRET" }, ctx);
  assert.match(res.content, /note\.txt:1: the needle/);
  assert.ok(!res.content.includes("SECRET"), "restricted file must be skipped");
});

test("run_command executes in project root and reports exit code", async () => {
  const { root, ctx } = setup();
  const ok = await runCommand.execute({ command: "pwd" }, ctx);
  assert.match(ok.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const bad = await runCommand.execute({ command: "exit 3" }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content, /exit 3/);
});

test("run_command enforces timeout", async () => {
  const { ctx } = setup();
  const res = await runCommand.execute({ command: "sleep 5", timeout_ms: 200 }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /timed out/);
});

test("tools cannot escape the project root", async () => {
  const { ctx } = setup();
  const res = await writeFile.execute({ path: "../escape.txt", content: "x" }, ctx);
  assert.equal(res.isError, true);
});

test("git tools report status and diff", async () => {
  const { root, ctx } = setup();
  writeFileSync(join(root, "src/math.js"), readFileSync(join(root, "src/math.js"), "utf8") + "//x\n");
  const st = await gitStatus.execute({}, ctx);
  assert.match(st.content, /M\s+src\/math\.js/);
  const diff = await gitDiff.execute({ path: "src/math.js" }, ctx);
  assert.match(diff.content, /\+.*\/\/x/);
});

test("phase gating: plan phase has read-only tools + propose_plan", () => {
  const plan = toolsForPhase("plan").map((t) => t.name);
  assert.ok(plan.includes("read_file"));
  assert.ok(plan.includes("propose_plan"));
  assert.ok(!plan.includes("write_file"));
  assert.ok(!plan.includes("run_command"));
  const exec = toolsForPhase("execute").map((t) => t.name);
  for (const n of ["write_file", "edit_file", "delete_file", "run_command", "git_diff"]) {
    assert.ok(exec.includes(n), n);
  }
});

test("findTool resolves registered tools", () => {
  assert.equal(findTool("read_file")?.name, "read_file");
  assert.equal(findTool("nope"), undefined);
  const del = deleteFile.permission({ path: "src/x.ts" }, { root: "/p" });
  assert.equal(del.level, "approval");
  assert.equal(listDirectory.permission({ path: "." }, { root: "/p" }).level, "safe");
});

test("parseTodos normalizes the checklist", () => {
  const items = parseTodos({
    todos: [
      { id: "a", content: "First", status: "completed" },
      { content: "Second", status: "in_progress" },
      { content: "Third", status: "bogus" },
      { status: "pending" }, // no content — dropped
    ],
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].status, "completed");
  assert.equal(items[1].status, "in_progress");
  assert.equal(items[2].status, "pending");
  assert.equal(items[1].id, "item-2");
  assert.equal(renderTodos(items), "[x] First\n[>] Second\n[ ] Third");
});

test("todo_write is an execute-phase tool", () => {
  assert.ok(!toolsForPhase("plan").some((t) => t.name === "todo_write"));
  assert.ok(toolsForPhase("execute").some((t) => t.name === "todo_write"));
});

test("run_background spawns a process; check_process reads its log; kill_process stops it", async () => {
  const { ctx } = setup();
  const home = mkdtempSync(join(tmpdir(), "dxxp-bg-"));
  const prev = process.env.DXXPCODE_HOME;
  process.env.DXXPCODE_HOME = home;
  try {
    const start = await runBackground.execute(
      { command: "sleep 0.3 && echo done-marker", name: "t-proc" },
      ctx,
    );
    assert.equal(start.isError, undefined);
    await new Promise((r) => setTimeout(r, 700));
    const check = await checkProcess.execute({ name: "t-proc" }, ctx);
    assert.match(check.content, /done-marker/);
    const list = await checkProcess.execute({}, ctx);
    assert.match(list.content, /t-proc/);
    const again = await runBackground.execute({ command: "sleep 30", name: "t2" }, ctx);
    assert.match(again.content, /started 't2'/);
    const kill = await killProcess.execute({ name: "t2" }, ctx);
    assert.match(kill.content, /SIGTERM/);
  } finally {
    if (prev === undefined) delete process.env.DXXPCODE_HOME;
    else process.env.DXXPCODE_HOME = prev;
  }
});

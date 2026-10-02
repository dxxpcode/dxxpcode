#!/usr/bin/env node
// dxxpcode eval runner — drives `dxxpcode --app` over a fixture task and scores
// the run mechanically: completion, tests, regression, tool calls, tokens,
// interventions, wall time.
//
//   node eval/runner.mjs                     # run every fixture with mock
//   node eval/runner.mjs --only fix-bug      # one fixture
//   node eval/runner.mjs --provider real     # use the real configured provider
//   node eval/runner.mjs --timeout 120       # per-task timeout (seconds)
//
// Writes results/<fixture>-<ts>.json (metrics) + .jsonl (raw event stream).

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO = resolve(ROOT, "..");
const RESULTS = join(ROOT, "results");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ONLY = opt("only", null);
const PROVIDER = opt("provider", "mock");
const TIMEOUT_MS = Number(opt("timeout", 180)) * 1000;

const BIN = existsSync(join(REPO, "apps/agent-rs/target/debug/dxxpcode"))
  ? join(REPO, "apps/agent-rs/target/debug/dxxpcode")
  : "dxxpcode";

const fixtures = readdirSync(join(ROOT, "fixtures"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !ONLY || n === ONLY)
  .sort();

if (fixtures.length === 0) {
  console.error(ONLY ? `no fixture named ${ONLY}` : "no fixtures found");
  process.exit(1);
}
mkdirSync(RESULTS, { recursive: true });

function runVerify(cmd, cwd) {
  try {
    const out = execFileSync("bash", ["-lc", cmd], { cwd, timeout: 60_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: out.trim() };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ""}${e.stderr || ""}`.trim() || String(e.status ?? e) };
  }
}

const sh = (cmd, cwd, opts = {}) =>
  execFileSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();

function gitFiles(cwd) {
  try {
    return sh("git status --porcelain | awk '{print $2}'", cwd).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function runFixture(name) {
  const dir = join(ROOT, "fixtures", name);
  const spec = JSON.parse(readFileSync(join(dir, "eval.json"), "utf8"));
  const work = mkdtempSync(join(tmpdir(), `dxxp-eval-${name}-`));
  const home = mkdtempSync(join(tmpdir(), `dxxp-eval-home-`));
  cpSync(dir, work, { recursive: true });
  rmSync(join(work, "eval.json"), { force: true });
  rmSync(join(work, "mock.json"), { force: true });
  // baseline commit so the worktree diff measures regression;
  // .dxxpcode/ holds the agent's own plan/todo mirrors — not a user regression
  writeFileSync(join(work, ".gitignore"), ".dxxpcode/\n");
  sh("git init -q && git add -A && git -c user.email=eval@dxxp -c user.name=eval commit -qm baseline", work);

  const events = [];
  const metrics = {
    fixture: name,
    provider: PROVIDER,
    toolCalls: 0,
    toolNames: {},
    approvals: 0,
    diffReviews: 0,
    steers: 0,
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
    status: null,
    error: null,
  };

  const env = {
    ...process.env,
    HOME: home,
    DXXPCODE_HOME: join(home, ".dxxpcode"),
  };
  mkdirSync(env.DXXPCODE_HOME, { recursive: true });
  if (PROVIDER === "mock") {
    writeFileSync(join(env.DXXPCODE_HOME, "config.json"), JSON.stringify({ provider: "mock", model: "mock" }));
    env.DXXPCODE_PROVIDER = "mock";
    env.DXXPCODE_MOCK_SCRIPT = join(dir, "mock.json");
  }

  const t0 = Date.now();
  const child = spawn(BIN, ["--app"], { cwd: work, env });
  const rl = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const send = (v) => child.stdin.write(JSON.stringify(v) + "\n");
  const done = new Promise((resolveDone) => {
    const killTimer = setTimeout(() => {
      metrics.status = "timeout";
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    rl.on("line", (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      events.push(ev);
      switch (ev.type) {
        case "tool_start":
          metrics.toolCalls++;
          metrics.toolNames[ev.tool] = (metrics.toolNames[ev.tool] || 0) + 1;
          break;
        case "steer":
          metrics.steers++;
          break;
        case "usage":
          if (ev.usage) {
            metrics.usage.inputTokens = ev.usage.inputTokens ?? metrics.usage.inputTokens;
            metrics.usage.outputTokens = ev.usage.outputTokens ?? metrics.usage.outputTokens;
          }
          metrics.usage.modelCalls++;
          break;
        case "approval": {
          metrics.approvals++;
          const choice = spec.expect?.approvalChoice ?? (spec.expect?.autoApprove !== false ? "y" : "n");
          send({ type: "approve", id: ev.id, choice });
          break;
        }
        case "diff_review": {
          metrics.diffReviews++;
          send({ type: "diff_decide", id: ev.id, decision: spec.expect?.diffDecision ?? "apply" });
          break;
        }
        case "prompt":
          send({ type: "prompt_submit", id: ev.id, text: spec.expect?.promptText ?? "" });
          break;
        case "menu":
          send({ type: "select", id: ev.id, index: spec.expect?.menuIndex ?? 0 });
          break;
        case "error":
          metrics.error = ev.message ?? JSON.stringify(ev);
          break;
        case "done":
          metrics.status = ev.result?.status ?? "done";
          if (ev.result?.error) metrics.error = ev.result.error;
          send({ type: "cancel" });
          setTimeout(() => { clearTimeout(killTimer); resolveDone(); }, 400);
          break;
        case "exit":
          clearTimeout(killTimer);
          resolveDone();
          break;
      }
    });
    child.on("close", () => { clearTimeout(killTimer); resolveDone(); });
  });

  send({ type: "submit", text: spec.task });
  await done;
  metrics.wallMs = Date.now() - t0;

  // ---- mechanical scoring ----
  const score = { checks: [] };
  const check = (name_, ok, detail = "") => score.checks.push({ name: name_, ok, detail });

  if (spec.verify?.command) {
    const v = runVerify(spec.verify.command, work);
    check("tests", v.ok, v.output.split("\n").pop() || "");
  }
  if (spec.verify?.files) {
    const changed = gitFiles(work);
    const missing = spec.verify.files.filter((f) => !changed.includes(f) && !existsSync(join(work, f)));
    check("expected-files", missing.length === 0, missing.join(","));
  }
  if (spec.verify?.grep) {
    const miss = spec.verify.grep.filter((pat) => {
      try { sh(`grep -rEl '${pat.replace(/'/g, "'\\''")}' .`, work); return false; } catch { return true; }
    });
    check("expected-output", miss.length === 0, miss.join(","));
  }
  {
    const changed = gitFiles(work);
    score.filesChanged = changed;
    // "files" present (even []) = allowlist of changeable paths; absent = don't check
    if (spec.verify && "files" in spec.verify) {
      const allowed = new Set(spec.verify.files);
      const extra = changed.filter((f) => !allowed.has(f));
      check("regression", extra.length === 0, extra.join(","));
    }
  }
  if (spec.expect?.max_tool_calls != null) check("tool-efficiency", metrics.toolCalls <= spec.expect.max_tool_calls, `${metrics.toolCalls} > ${spec.expect.max_tool_calls}`);
  if (spec.expect?.max_approvals != null) check("interventions", metrics.approvals <= spec.expect.max_approvals, `${metrics.approvals} > ${spec.expect.max_approvals}`);
  check("completion", metrics.status === "completed" || metrics.status === spec.expect?.status, metrics.status ?? "no done");

  score.passed = score.checks.filter((c) => c.ok).length;
  score.total = score.checks.length;
  score.ok = score.checks.every((c) => c.ok);

  const ts = t0;
  writeFileSync(join(RESULTS, `${name}-${ts}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(RESULTS, `${name}-${ts}.json`), JSON.stringify({ spec, metrics, score }, null, 2));
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (stderr.trim()) metrics.stderrTail = stderr.trim().split("\n").slice(-3).join("\n");
  return { metrics, score };
}

let failed = 0;
for (const f of fixtures) {
  process.stdout.write(`▸ ${f} … `);
  try {
    const { metrics, score } = await runFixture(f);
    const s = `${score.passed}/${score.total}`;
    console.log(`${score.ok ? "PASS" : "FAIL"} (${s}) — ${metrics.status}, ${metrics.toolCalls} tools, ${metrics.approvals} approvals, ${(metrics.wallMs / 1000).toFixed(1)}s`);
    if (!score.ok) failed++;
  } catch (e) {
    console.log(`ERROR — ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);

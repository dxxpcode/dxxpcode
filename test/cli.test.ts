import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["--conditions=development", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

test("--help prints usage", () => {
  const { code, out } = run(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /dxxpcode — AI coding agent/);
  assert.match(out, /--plan/);
  assert.match(out, /--resume/);
});

test("--version prints the version", () => {
  const { code, out } = run(["--version"]);
  assert.equal(code, 0);
  assert.match(out, /dxxpcode \d+\.\d+\.\d+/);
});

test("--review runs without a provider configured", () => {
  const dir = fileURLToPath(new URL("./fixtures/node-app", import.meta.url));
  const { code, out } = (() => {
    try {
      const out = execFileSync("node", ["--conditions=development", CLI, "--review"], {
        encoding: "utf8",
        cwd: dir,
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  })();
  assert.equal(code, 0);
  assert.match(out, /not a git repository|No changes|untracked|##/i);
});

test("banner renders name, version, model, and project context", async () => {
  const { renderBanner, renderTips } = await import("../apps/cli/src/banner.ts");
  const lines = renderBanner({
    version: "0.1.0",
    provider: "mock",
    model: "mock-model",
    project: { name: "demo", languages: ["TypeScript"], root: "/tmp/demo", git: null, packageManager: "npm", testCommand: "npm test", buildCommand: null },
    cwd: "/tmp/demo",
  });
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /DxxpCode/);
  assert.match(text, /v0\.1\.0 · mock · mock-model/);
  assert.match(text, /demo \(TypeScript\)/);
  assert.equal(renderTips().length, 6); // title + 5 tips
});

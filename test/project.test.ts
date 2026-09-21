import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject, loadInstructions } from "@dxxpcode/project";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/node-app", import.meta.url));

test("detectProject detects a node app with npm test", () => {
  const info = detectProject(FIXTURE);
  assert.equal(info.name, "node-app");
  assert.ok(info.languages.includes("JavaScript/TypeScript"));
  assert.equal(info.packageManager, "npm");
  assert.equal(info.testCommand, "npm test");
});

test("detectProject detects rust and go markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "dxxp-proj-"));
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='x'\n");
  const rust = detectProject(dir);
  assert.ok(rust.languages.includes("Rust"));
  assert.equal(rust.testCommand, "cargo test");

  const dir2 = mkdtempSync(join(tmpdir(), "dxxp-proj-"));
  writeFileSync(join(dir2, "go.mod"), "module x\n");
  const go = detectProject(dir2);
  assert.ok(go.languages.includes("Go"));
  assert.equal(go.testCommand, "go test ./...");
});

test("loadInstructions prefers .dxxpcode/instructions.md, falls back to AGENTS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "dxxp-proj-"));
  writeFileSync(join(dir, "AGENTS.md"), "use pnpm\n");
  const fallback = loadInstructions(dir);
  assert.equal(fallback?.content, "use pnpm");

  mkdirSync(join(dir, ".dxxpcode"));
  writeFileSync(join(dir, ".dxxpcode", "instructions.md"), "use vitest\n");
  const primary = loadInstructions(dir);
  assert.equal(primary?.content, "use vitest");
});

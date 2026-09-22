import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  latestSessionFor,
  listSessions,
  loadConfig,
  loadSession,
  newSessionId,
  saveConfig,
  saveSession,
} from "@dxxpcode/sessions";
import type { SessionRecord } from "@dxxpcode/sessions";

function tmpEnv() {
  const home = mkdtempSync(join(tmpdir(), "dxxp-home-"));
  return { ...process.env, DXXPCODE_HOME: home } as NodeJS.ProcessEnv;
}

function record(root: string, id: string): SessionRecord {
  return {
    version: 1,
    id,
    projectRoot: root,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    task: "do a thing",
    messages: [{ role: "user", content: [{ type: "text", text: "do a thing" }] }],
    toolCalls: [],
    filesChanged: ["src/a.ts"],
    commands: ["npm test"],
    result: "done",
  };
}

test("save/load session roundtrip", () => {
  const env = tmpEnv();
  const s = record("/p/app", "test-session-1");
  saveSession(s, env);
  const loaded = loadSession("test-session-1", env);
  assert.deepEqual(loaded, s);
});

test("latestSessionFor matches by project root, newest first", () => {
  const env = tmpEnv();
  const older = { ...record("/p/app", "s-old"), updatedAt: "2026-01-01T00:00:00Z" };
  const newer = { ...record("/p/app", "s-new"), updatedAt: "2026-06-01T00:00:00Z" };
  const other = { ...record("/p/other", "s-other"), updatedAt: "2026-12-01T00:00:00Z" };
  saveSession(older, env);
  saveSession(newer, env);
  saveSession(other, env);
  assert.equal(latestSessionFor("/p/app", env)?.id, "s-new");
  assert.equal(latestSessionFor("/p/none", env), null);
  assert.equal(listSessions(env).length, 3);
});

test("newSessionId includes a project slug", () => {
  const id = newSessionId("/home/user/my-app");
  assert.match(id, /^my-app-[0-9a-f]{8}-/);
});

test("config roundtrip via DXXPCODE_HOME", () => {
  const env = tmpEnv();
  assert.deepEqual(loadConfig(env), {});
  saveConfig({ provider: "anthropic", model: "claude-sonnet-4-5", approvalMode: "auto" }, env);
  const loaded = loadConfig(env);
  assert.equal(loaded.provider, "anthropic");
  assert.equal(loaded.model, "claude-sonnet-4-5");
  assert.ok(configPath(env).endsWith("config.json"));
});

test("config is written owner-only and roundtrips provider keys", () => {
  const env = tmpEnv();
  saveConfig({ provider: "openai", openaiApiKey: "sk-x", openaiBaseUrl: "https://x.test/v1" }, env);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
  const loaded = loadConfig(env);
  assert.equal(loaded.openaiApiKey, "sk-x");
  assert.equal(loaded.openaiBaseUrl, "https://x.test/v1");
});

test("corrupt session files are skipped", () => {
  const env = tmpEnv();
  const s = record("/p/app", "good");
  saveSession(s, env);
  const dir = join((env.DXXPCODE_HOME as string), "sessions");
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(listSessions(env).length, 1);
});

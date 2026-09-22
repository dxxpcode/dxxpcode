import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, ProviderConfigError, resolveProvider } from "@dxxpcode/providers";

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.DXXPCODE_PROVIDER;
  delete env.DXXPCODE_MODEL;
  delete env.DXXPCODE_MOCK_SCRIPT;
  return { ...env, ...extra };
}

test("resolveProvider picks anthropic when ANTHROPIC_API_KEY is set", () => {
  const { provider, model } = resolveProvider({ env: cleanEnv({ ANTHROPIC_API_KEY: "sk-x" }) });
  assert.equal(provider.name, "anthropic");
  assert.equal(model, "claude-sonnet-4-5");
});

test("resolveProvider picks openai when only OPENAI_API_KEY is set", () => {
  const { provider, model } = resolveProvider({ env: cleanEnv({ OPENAI_API_KEY: "sk-x" }) });
  assert.equal(provider.name, "openai");
  assert.equal(model, "gpt-4o");
});

test("resolveProvider errors when nothing is configured", () => {
  assert.throws(() => resolveProvider({ env: cleanEnv() }), ProviderConfigError);
});

test("resolveProvider uses saved keys when env vars are absent", () => {
  const { provider } = resolveProvider({
    env: cleanEnv(),
    keys: { anthropic: "sk-saved" },
  });
  assert.equal(provider.name, "anthropic");
});

test("env vars take precedence over saved keys", () => {
  const { provider } = resolveProvider({
    env: cleanEnv({ ANTHROPIC_API_KEY: "sk-env" }),
    keys: { openai: "sk-saved" },
  });
  assert.equal(provider.name, "anthropic");
});

test("resolveProvider honors explicit provider + model overrides", () => {
  const { model } = resolveProvider({
    provider: "openai",
    model: "o4-mini",
    env: cleanEnv({ OPENAI_API_KEY: "sk-x" }),
  });
  assert.equal(model, "o4-mini");
});

test("DXXPCODE_MOCK_SCRIPT loads a scripted provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dxxp-mock-"));
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify([{ text: "hello from script" }]));
  const { provider } = resolveProvider({ env: cleanEnv({ DXXPCODE_PROVIDER: "mock", DXXPCODE_MOCK_SCRIPT: scriptPath }) });
  assert.ok(provider instanceof MockProvider);
  const events = [];
  for await (const ev of provider.chat({ system: "", messages: [], tools: [], model: "mock" })) {
    events.push(ev);
  }
  assert.deepEqual(
    events.map((e) => e.type),
    ["text", "done"],
  );
});

test("DXXPCODE_MOCK_SCRIPT with a bad file raises ProviderConfigError", () => {
  assert.throws(
    () => resolveProvider({ env: cleanEnv({ DXXPCODE_PROVIDER: "mock", DXXPCODE_MOCK_SCRIPT: "/nonexistent.json" }) }),
    ProviderConfigError,
  );
});

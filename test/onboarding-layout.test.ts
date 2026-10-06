import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ONBOARDING_PHASES, ONBOARDING_PROVIDERS, onboardingBack, onboardingPhase, onboardingSetup } from "../apps/desktop/src/lib/onboarding-layout.ts";

test("provider selection and key entry share the Connect phase", () => {
  assert.deepEqual(ONBOARDING_PHASES, ["Welcome", "Connect", "Project"]);
  assert.equal(onboardingPhase("welcome"), 0);
  assert.equal(onboardingPhase("pick"), 1);
  assert.equal(onboardingPhase("key"), 1);
  assert.equal(onboardingPhase("project"), 2);
});

test("the optional first task appears after the required setup phases", () => {
  assert.equal(onboardingPhase("first"), ONBOARDING_PHASES.length);
});

test("Back preserves the existing onboarding navigation", () => {
  assert.equal(onboardingBack("key"), "pick");
  assert.equal(onboardingBack("pick"), "welcome");
  assert.equal(onboardingBack("project"), "pick");
  assert.equal(onboardingBack("first"), "pick");
});

test("native Anthropic and OpenAI setup retain their protocol and trim keys", () => {
  assert.deepEqual(onboardingSetup("anthropic", "  sample-key\n"), {
    type: "setup", provider: "anthropic", key: "sample-key", base_url: undefined,
  });
  assert.deepEqual(onboardingSetup("openai", "  sample-key  "), {
    type: "setup", provider: "openai", key: "sample-key", base_url: undefined,
  });
});

test("compatible providers keep their existing endpoint mappings", () => {
  const endpoints = {
    openrouter: "https://openrouter.ai/api/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    groq: "https://api.groq.com/openai/v1",
    deepseek: "https://api.deepseek.com/v1",
    xai: "https://api.x.ai/v1",
    mistral: "https://api.mistral.ai/v1",
  };
  for (const [provider, base_url] of Object.entries(endpoints)) {
    assert.deepEqual(onboardingSetup(provider, " sample-key ", "https://ignored.example/v1"), {
      type: "setup", provider: "openai", key: "sample-key", base_url,
    });
  }
});

test("custom endpoints trim the URL and preserve the blank OpenAI fallback", () => {
  assert.deepEqual(onboardingSetup("custom", " sample-key ", " https://endpoint.example/v1 "), {
    type: "setup", provider: "openai", key: "sample-key", base_url: "https://endpoint.example/v1",
  });
  assert.equal(onboardingSetup("custom", "sample-key", "  ").base_url, undefined);
});

test("demo setup sends no key or endpoint and stays session-only", () => {
  assert.deepEqual(onboardingSetup("mock", "unused-key", "https://unused.example"), {
    type: "setup", provider: "mock",
  });
});

test("provider help opens only the exact HTTPS key pages allowed by Tauri", () => {
  const capabilities = JSON.parse(readFileSync(new URL("../apps/desktop/src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  const opener = capabilities.permissions.find((p: { identifier?: string }) => p.identifier === "opener:allow-open-url");
  const keyUrls = ONBOARDING_PROVIDERS.filter((p) => p.keyUrl).map((p) => p.keyUrl!);
  assert.equal(keyUrls.length, 8);
  assert.deepEqual(opener.allow.map((p: { url: string }) => p.url).sort(), [...keyUrls].sort());
  for (const url of keyUrls) {
    assert.equal(new URL(url).protocol, "https:");
    assert.ok(!url.includes("*"));
  }
  assert.equal(ONBOARDING_PROVIDERS.find((p) => p.id === "custom")?.keyUrl, undefined);
});

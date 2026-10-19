import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_OPTIONS, availableEffortOptions, filterModels, modelLabel, nextOption, selectedEffort } from "../apps/desktop/src/lib/composer-selector.ts";

test("effort labels preserve every existing command value", () => {
  assert.deepEqual(EFFORT_OPTIONS.map((option) => option.value), ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto (Jev)"]);
  assert.equal(selectedEffort("xhigh", ["xhigh"]).label, "Extra high");
  assert.equal(selectedEffort("max", ["max"]).label, "Maximum");
  assert.equal(selectedEffort("auto (Jev)", ["auto (Jev)"]).label, "Auto");
});

test("model discovery keeps current and custom IDs intact and removes duplicates and empty rows", () => {
  assert.deepEqual(filterModels(["gpt-5", "org/custom-v2", "gpt-5", "", "   "], "org/custom-v2", ""), ["org/custom-v2", "gpt-5"]);
  assert.deepEqual(filterModels([], "org/custom-v2", ""), ["org/custom-v2"]);
});

test("model search ignores case and surrounding whitespace without altering IDs", () => {
  assert.deepEqual(filterModels(["claude-sonnet-4-5", "gpt-5", "Claude-Opus"], "gpt-5", " CLAUDE "), ["claude-sonnet-4-5", "Claude-Opus"]);
  assert.deepEqual(filterModels(["gpt-5"], "gpt-5", "nothing matches"), []);
});

test("keyboard navigation wraps and handles empty results", () => {
  assert.equal(nextOption(0, 3, -1), 2);
  assert.equal(nextOption(2, 3, 1), 0);
  assert.equal(nextOption(0, 1, 1), 0);
  assert.equal(nextOption(0, 0, 1), -1);
});

test("friendly model labels preserve exact IDs and do not invent names for custom models", () => {
  assert.equal(modelLabel("claude-sonnet-4-5-20250929"), "Claude Sonnet 4.5");
  assert.equal(modelLabel("claude-3-7-sonnet-latest"), "Claude Sonnet 3.7");
  assert.equal(modelLabel("gpt-5.2-2025-12-11"), "GPT-5.2");
  assert.equal(modelLabel("gpt-5-mini"), "GPT-5 Mini");
  assert.equal(modelLabel("gpt-4o"), "GPT-4o");
  assert.equal(modelLabel("gpt-6.1-sol"), "GPT-6.1 Sol");
  assert.equal(modelLabel("vendor/opaque:model@version"), "vendor/opaque:model@version");
  assert.equal(modelLabel("gpt-5-custom"), "gpt-5-custom");
  assert.equal(modelLabel("deployment-123", "Team coding model"), "Team coding model");
  assert.equal(modelLabel("deployment-123", "  "), "deployment-123");
});

test("search finds friendly names, provider names, and exact version IDs", () => {
  const id = "claude-sonnet-4-5-20250929";
  assert.deepEqual(filterModels([id, "gpt-5"], "gpt-5", "Sonnet 4.5"), [id]);
  assert.deepEqual(filterModels([id], id, "20250929"), [id]);
  assert.deepEqual(filterModels(["deployment-123"], "gpt-5", "Team coding", { "deployment-123": "Team coding model" }), ["deployment-123"]);
});

test("effort choices use only backend-supported values, with default always available", () => {
  assert.deepEqual(availableEffortOptions(["low", "medium", "high"]).map((option) => option.value), ["default", "low", "medium", "high"]);
  assert.deepEqual(availableEffortOptions(undefined).map((option) => option.value), ["default"]);
  assert.deepEqual(availableEffortOptions([]).map((option) => option.value), ["default"]);
  assert.deepEqual(availableEffortOptions(["default", "none", "high", "high", "invented"]).map((option) => option.value), ["default", "none", "high"]);
  assert.ok(!availableEffortOptions(["low"]).some((option) => option.value === "auto (Jev)"));
  assert.ok(availableEffortOptions(["low", "auto (Jev)"]).some((option) => option.value === "auto (Jev)"));
});

test("a saved unsupported effort falls back without being reintroduced as a choice", () => {
  assert.equal(selectedEffort("max", ["low", "medium", "high"]).value, "default");
  assert.equal(selectedEffort("custom", undefined).value, "default");
  assert.equal(selectedEffort("high", ["low", "medium", "high"]).value, "high");
  assert.equal(selectedEffort("auto (Jev)", ["default"]).value, "default");
});

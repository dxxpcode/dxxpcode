import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_OPTIONS, displayModel, displayProvider, effortOption, filterModels, nextOption } from "../apps/desktop/src/lib/composer-selector.ts";

test("effort labels preserve every existing command value", () => {
  assert.deepEqual(EFFORT_LEVELS, ["default", "minimal", "low", "medium", "high", "xhigh", "max", "auto (Jev)"]);
  assert.equal(effortOption("xhigh").label, "Extra high");
  assert.equal(effortOption("max").label, "Maximum");
  assert.equal(effortOption("auto (Jev)").label, "Auto");
});

test("default and auto do not imply a fixed reasoning tier", () => {
  assert.equal(effortOption("default").tier, 0);
  assert.equal(effortOption("auto (Jev)").tier, 0);
  assert.deepEqual(EFFORT_OPTIONS.slice(1, 7).map((option) => option.tier), [1, 2, 3, 4, 5, 6]);
  assert.match(effortOption("auto (Jev)").description, /Requires a Jev key/);
});

test("unknown current effort remains visible without pretending to be a supported tier", () => {
  assert.deepEqual(effortOption("custom"), {
    value: "custom", label: "custom", description: "Current reasoning effort.", tier: 0,
  });
});

test("model discovery keeps current and custom IDs intact and removes duplicates and empty rows", () => {
  assert.deepEqual(filterModels(["gpt-5", "org/custom-v2", "gpt-5", "", "   "], "org/custom-v2", ""), ["org/custom-v2", "gpt-5"]);
  assert.deepEqual(filterModels([], "org/custom-v2", ""), ["org/custom-v2"]);
});

test("model search ignores case and surrounding whitespace without altering IDs", () => {
  assert.deepEqual(filterModels(["claude-sonnet-4-5", "gpt-5", "Claude-Opus"], "gpt-5", " CLAUDE "), ["claude-sonnet-4-5", "Claude-Opus"]);
  assert.deepEqual(filterModels(["gpt-5"], "gpt-5", "nothing matches"), []);
});

test("provider ids display with proper brand casing", () => {
  assert.equal(displayProvider("anthropic"), "Anthropic");
  assert.equal(displayProvider("openai"), "OpenAI");
  assert.equal(displayProvider("openrouter"), "OpenRouter");
  assert.equal(displayProvider("xai"), "xAI");
  assert.equal(displayProvider("deepseek"), "DeepSeek");
  assert.equal(displayProvider("some-endpoint"), "Some Endpoint");
});

test("model ids display with proper casing while versions stay intact", () => {
  assert.equal(displayModel("claude-sonnet-4-5"), "Claude Sonnet 4.5");
  assert.equal(displayModel("claude-3-5-haiku-20241022"), "Claude 3.5 Haiku 20241022");
  assert.equal(displayModel("gpt-5"), "GPT-5");
  assert.equal(displayModel("gpt-4o"), "GPT-4o");
  assert.equal(displayModel("gpt-5-codex"), "GPT-5 Codex");
  assert.equal(displayModel("o4-mini"), "o4-mini");
  assert.equal(displayModel("gemini-2.5-pro"), "Gemini 2.5 Pro");
  assert.equal(displayModel("anthropic/claude-sonnet-4.5"), "Claude Sonnet 4.5");
  assert.equal(displayModel("deepseek-chat"), "DeepSeek chat");
  assert.equal(displayModel("kimi-k2"), "Kimi K2");
  assert.equal(displayModel("qwen3-coder"), "Qwen3 coder");
});

test("model search also matches display names", () => {
  assert.deepEqual(filterModels(["claude-sonnet-4-5", "gpt-5"], "gpt-5", "sonnet 4.5"), ["claude-sonnet-4-5"]);
  assert.deepEqual(filterModels(["gpt-5"], "gpt-5", "GPT-5"), ["gpt-5"]);
});

test("keyboard navigation wraps and handles empty results", () => {
  assert.equal(nextOption(0, 3, -1), 2);
  assert.equal(nextOption(2, 3, 1), 0);
  assert.equal(nextOption(0, 1, 1), 0);
  assert.equal(nextOption(0, 0, 1), -1);
});

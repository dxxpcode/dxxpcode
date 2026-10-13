import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_LEVELS, EFFORT_OPTIONS, effortOption, filterModels, nextOption } from "../apps/desktop/src/lib/composer-selector.ts";

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

test("keyboard navigation wraps and handles empty results", () => {
  assert.equal(nextOption(0, 3, -1), 2);
  assert.equal(nextOption(2, 3, 1), 0);
  assert.equal(nextOption(0, 1, 1), 0);
  assert.equal(nextOption(0, 0, 1), -1);
});

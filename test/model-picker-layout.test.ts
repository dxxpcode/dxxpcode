import { test } from "node:test";
import assert from "node:assert/strict";
import { modelPickerOptions, modelPickerPosition } from "../apps/desktop/src/lib/model-picker-layout.ts";

test("model search deduplicates choices and keeps the active custom model", () => {
  assert.deepEqual(modelPickerOptions(["alpha", "beta", "alpha"], "custom/model", ""), ["alpha", "beta", "custom/model"]);
  assert.deepEqual(modelPickerOptions(["alpha", "beta"], "alpha", " ALP "), ["alpha"]);
  assert.deepEqual(modelPickerOptions(["alpha"], "alpha", "missing"), []);
});

test("picker opens above the composer and aligns with its trigger", () => {
  const position = modelPickerPosition({ left: 250, top: 600, bottom: 630 }, { width: 1000, height: 700 });
  assert.equal(position.left, 250);
  assert.equal(position.width, 340);
  assert.ok("bottom" in position);
  assert.equal(position.bottom, 108);
  assert.equal(position.maxHeight, 460);
});

test("picker stays within a narrow viewport and flips below a high trigger", () => {
  const position = modelPickerPosition({ left: 290, top: 60, bottom: 90 }, { width: 320, height: 500 });
  assert.equal(position.left, 16);
  assert.equal(position.width, 288);
  assert.ok("top" in position);
  assert.equal(position.top, 98);
  assert.equal(position.maxHeight, 386);
});

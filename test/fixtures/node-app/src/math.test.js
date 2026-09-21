import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./math.js";

test("add adds two numbers", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

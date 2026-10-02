const assert = require("assert");
const { sumRange } = require("./sum");

assert.strictEqual(sumRange(0), 0);
assert.strictEqual(sumRange(1), 1);
assert.strictEqual(sumRange(5), 15);
assert.strictEqual(sumRange(100), 5050);
console.log("ok");

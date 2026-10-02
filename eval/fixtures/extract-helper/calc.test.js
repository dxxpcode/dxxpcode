const assert = require("assert");
const { report } = require("./calc");

const r = report([10, 20, 30]);
assert.strictEqual(r.avg, 20);
assert.strictEqual(r.hi, 30);
assert.strictEqual(r.count, 3);
console.log("ok");

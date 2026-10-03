const assert = require("assert");
const { parseAge } = require("./age");

assert.strictEqual(parseAge("42"), 42);
assert.throws(() => parseAge("abc"));
assert.throws(() => parseAge("-3"));
console.log("ok");

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, isNewer } from "../apps/cli/src/update.ts";

function env() {
  const home = mkdtempSync(join(tmpdir(), "dxxp-update-"));
  return { ...process.env, DXXPCODE_HOME: home } as NodeJS.ProcessEnv;
}

test("isNewer compares semver segments", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.2.0"), false);
  assert.equal(isNewer("v1.0.0", "0.9.9"), true);
  assert.equal(isNewer("1.0", "1.0.1"), false);
});

test("checkForUpdate returns the cached latest when it is newer", async () => {
  const e = env();
  writeFileSync(
    join(e.DXXPCODE_HOME!, "update-check.json"),
    JSON.stringify({ checkedAt: Date.now(), latest: "9.9.9" }),
  );
  assert.equal(await checkForUpdate("0.1.0", e), "9.9.9");
});

test("checkForUpdate returns null when cache is not newer", async () => {
  const e = env();
  writeFileSync(
    join(e.DXXPCODE_HOME!, "update-check.json"),
    JSON.stringify({ checkedAt: Date.now(), latest: "0.1.0" }),
  );
  assert.equal(await checkForUpdate("0.1.0", e), null);
});

test("checkForUpdate survives a corrupt cache", async () => {
  const e = env();
  writeFileSync(join(e.DXXPCODE_HOME!, "update-check.json"), "not json");
  // Falls through to the registry fetch; offline → null, online → real answer.
  const v = await checkForUpdate("999.0.0", e);
  assert.equal(v, null);
});

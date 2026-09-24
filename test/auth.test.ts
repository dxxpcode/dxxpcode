import { strict as assert } from "node:assert";
import { get } from "node:http";
import test from "node:test";
import { authBase, billingUrl, waitForLoginCallback } from "../apps/cli/src/auth.ts";

const env = { DXXPCODE_AUTH_URL: "https://auth.example" } as NodeJS.ProcessEnv;

test("authBase defaults and respects DXXPCODE_AUTH_URL", () => {
  assert.equal(authBase(env), "https://auth.example");
  assert.equal(billingUrl(env), "https://auth.example/billing");
});

test("waitForLoginCallback resolves on a well-formed callback", async () => {
  const login = waitForLoginCallback(env);
  const url = await login.url;
  assert.match(url, /^https:\/\/auth\.example\/connect\?redirect=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback&state=[0-9a-f]{16}$/);
  const callback = decodeURIComponent(new URL(url).searchParams.get("redirect")!);
  const state = new URL(url).searchParams.get("state")!;
  await new Promise<void>((resolve, reject) => {
    get(`${callback}?state=${state}&token=tok123&email=a%40b.co&plan=pro`, (res) => {
      res.resume();
      res.on("end", resolve);
      res.on("error", reject);
    }).on("error", reject);
  });
  assert.deepEqual(await login.result, { token: "tok123", email: "a@b.co", plan: "pro" });
});

test("waitForLoginCallback rejects on timeout", async () => {
  const login = waitForLoginCallback(env, { timeoutMs: 50 });
  await assert.rejects(login.result, /timed out/);
});

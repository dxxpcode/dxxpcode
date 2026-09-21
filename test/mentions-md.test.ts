import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandMentions } from "../apps/cli/src/mentions.ts";
import { createMdStyler } from "../apps/cli/src/md.ts";

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "dxxp-mentions-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".env"), "SECRET=x\n");
  return dir;
}

test("expandMentions attaches file contents as context blocks", () => {
  const r = expandMentions("fix @src/a.ts please", root());
  assert.match(r.text, /<file path="src\/a\.ts">\nexport const a = 1;\n<\/file>/);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.attached.length, 1);
});

test("expandMentions skips missing, restricted, and root-escaping paths", () => {
  const r = expandMentions("see @nope.ts and @.env and @../x", root());
  assert.equal(r.attached.length, 0);
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped[0].reason, /not found/);
  assert.match(r.skipped[1].reason, /protected/);
  assert.match(r.skipped[2].reason, /outside/);
});

test("expandMentions ignores email-like and duplicate mentions", () => {
  const r = expandMentions("mail me@x.com, check @src/a.ts twice @src/a.ts.", root());
  assert.equal(r.attached.length, 1);
});

test("md styler renders bold, code, headers and bullets", () => {
  const md = createMdStyler(true);
  const out = md.push("## Title\n- item **bold** and `code`\n") + md.flush();
  assert.match(out, /\x1b\[1m\x1b\[4mTitle/);
  assert.match(out, /• item \x1b\[1mbold\x1b\[0m and \x1b\[36;7mcode\x1b\[0m/);
});

test("md styler handles markers split across chunks", () => {
  const md = createMdStyler(true);
  const out = md.push("use `read_fil") + md.push("e` next") + md.flush();
  assert.match(out, /\x1b\[36;7mread_file\x1b\[0m next/);
});

test("md styler resets unclosed markers at newline and flush", () => {
  const md = createMdStyler(true);
  const out = md.push("**oops\nplain") + md.push(" trailing *") + md.flush();
  assert.match(out, /\x1b\[0m\nplain/); // bold closed at newline
  assert.match(out, /trailing \*$/); // held marker emitted literally
});

test("md styler is a pass-through when disabled", () => {
  const md = createMdStyler(false);
  assert.equal(md.push("**b** `c`"), "**b** `c`");
});

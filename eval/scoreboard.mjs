#!/usr/bin/env node
// Aggregates eval/results/*.json into a scoreboard. Optionally diffs two runs.
//
//   node eval/scoreboard.mjs                    # latest result per fixture
//   node eval/scoreboard.mjs --dir results      # explicit results dir
//   node eval/scoreboard.mjs --compare A.json B.json   # per-fixture delta

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const DIR = join(ROOT, opt("dir", "results"));
const CMP = args.indexOf("--compare") >= 0;

const load = (file) => JSON.parse(readFileSync(file, "utf8"));

function summarize(r) {
  const m = r.metrics;
  return {
    fixture: m.fixture,
    score: `${r.score.passed}/${r.score.total}`,
    ok: r.score.ok,
    status: m.status,
    tools: m.toolCalls,
    approvals: m.approvals,
    in: m.usage.inputTokens,
    out: m.usage.outputTokens,
    calls: m.usage.modelCalls,
    secs: (m.wallMs / 1000).toFixed(1),
    failed: r.score.checks.filter((c) => !c.ok).map((c) => c.name),
  };
}

if (CMP) {
  const [a, b] = [args[args.indexOf("--compare") + 1], args[args.indexOf("--compare") + 2]].map((f) => {
    const r = load(resolve(f));
    return Object.fromEntries((Array.isArray(r) ? r : [r]).map((x) => [x.metrics.fixture, x]));
  });
  console.log("| fixture | metric | before | after |");
  console.log("|---|---|---|---|");
  for (const f of Object.keys(a)) {
    const A = summarize(a[f]); const B = b[f] ? summarize(b[f]) : null;
    if (!B) { console.log(`| ${f} | — | ${A.score} | (no run) |`); continue; }
    for (const k of ["tools", "approvals", "in", "out", "secs"]) {
      if (A[k] !== B[k]) console.log(`| ${f} | ${k} | ${A[k]} | ${B[k]} |`);
    }
    if (A.score !== B.score) console.log(`| ${f} | score | ${A.score} | ${B.score} |`);
  }
  process.exit(0);
}

// latest result per fixture
const latest = {};
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const [name, ts] = basename(f, ".json").split(/-(?=\d{13}$)/);
  const t = Number(ts || 0);
  if (!latest[name] || t > latest[name].t) latest[name] = { t, file: join(DIR, f) };
}

const rows = Object.values(latest).map(({ file }) => summarize(load(file)));
if (!rows.length) { console.log("no results in", DIR); process.exit(0); }

console.log("| fixture | score | status | tools | approvals | tokens in/out | calls | secs |");
console.log("|---|---|---|---|---|---|---|---|");
let pass = 0;
for (const r of rows) {
  if (r.ok) pass++;
  console.log(`| ${r.fixture} | ${r.score}${r.ok ? "" : ` (${r.failed.join(",")})`} | ${r.status} | ${r.tools} | ${r.approvals} | ${r.in}/${r.out} | ${r.calls} | ${r.secs} |`);
}
console.log(`\n${pass}/${rows.length} fixtures fully passing`);

const LOOP = [
  { stage: "plan", prevents: "outlines the approach before touching anything" },
  { stage: "approve", prevents: "proposed diffs shown — nothing lands unseen" },
  { stage: "execute", prevents: "diff-level approval per write" },
  { stage: "auto-verify", prevents: "repo's own tests run; failures feed back in" },
  { stage: "blind review", prevents: "fresh-context model audits only the diff" },
  { stage: "done", prevents: "every mutation checkpointed — /undo restores it" },
];

const FAILURES: { when: string; mechanism: string }[] = [
  {
    when: "the model calls the same tool in a loop",
    mechanism: "stuck-loop detection — nudge at 3 identical calls, hard stop at 4",
  },
  {
    when: "the provider stalls or rate-limits",
    mechanism: "watchdog every 15s of silence · 15s/60s connect+header timeouts · 3 retries with backoff",
  },
  {
    when: "an edit doesn't match the file",
    mechanism: "whitespace-tolerant matching; a miss returns the closest region so it self-corrects in one retry",
  },
  {
    when: "the model tries to escape the sandbox",
    mechanism: "classifier catches env rm · xargs · node -e · find -exec; paths canonicalized against the project root",
  },
  {
    when: "you disagree with a change",
    mechanism: "diffs are approved before they land; git-aware checkpoints undo any file",
  },
];

const VERIFY = [
  {
    lead: "auto-verify",
    body: "runs npm test, cargo test, or the repo's own commands after any turn that changed files. Failure output goes back into context — the agent fixes its own breakage before declaring done.",
  },
  {
    lead: "blind review",
    body: "a second, isolated model sees only the diff and the touched files — never the reasoning that produced them. It reports concrete defects or CLEAN. One repair round, then done regardless.",
  },
  {
    lead: "chat mode",
    body: "read-only is enforced at the tool registry, not the prompt. The write tools do not exist to a chat-mode run.",
  },
];

export function Reliability() {
  return (
    <section className="mt-16 w-full max-w-2xl text-left">
      <h2 className="text-center text-[15px] font-medium tracking-[-0.01em]">
        Built to finish the task.
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-center text-[13px] leading-relaxed text-muted-foreground">
        Every coding agent demos well. The difference is what happens at minute forty — when the
        model repeats itself, the provider stalls, and an edit doesn't apply. That's where DxxpCode
        is engineered.
      </p>

      {/* The loop */}
      <div className="mt-10 border-y border-border py-6">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-3 font-mono text-[12px]">
          {LOOP.map((s, i) => (
            <span key={s.stage} className="flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground/50">→</span>}
              <span className="text-foreground">{s.stage}</span>
            </span>
          ))}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
          {LOOP.map((s) => (
            <div key={s.stage} className="bg-background px-4 py-3">
              <p className="font-mono text-[12px] font-medium">{s.stage}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{s.prevents}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Failure → mechanism */}
      <div className="mt-10">
        <h3 className="text-center text-[13px] font-medium text-muted-foreground">
          What happens when things go wrong
        </h3>
        <div className="mt-4 divide-y divide-border border-y border-border">
          {FAILURES.map((f) => (
            <div key={f.when} className="grid gap-1 py-3.5 sm:grid-cols-[240px_1fr] sm:gap-4">
              <p className="text-[13px] text-muted-foreground">{f.when}</p>
              <p className="font-mono text-[12px] leading-relaxed text-foreground">{f.mechanism}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Verify, don't trust */}
      <div className="mt-10">
        <h3 className="text-center text-[13px] font-medium text-muted-foreground">
          Verify, don't trust
        </h3>
        <div className="mt-4 space-y-5">
          {VERIFY.map((v) => (
            <div key={v.lead} className="grid gap-1 sm:grid-cols-[120px_1fr] sm:gap-4">
              <p className="font-mono text-[12px] font-medium">{v.lead}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{v.body}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-10 border-t border-border pt-5 text-center text-[12px] leading-relaxed text-muted-foreground">
        Known limits: a mid-stream stall still needs esc to interrupt — we time out at connect and
        header, not mid-body. One provider per session for now.
      </p>
    </section>
  );
}

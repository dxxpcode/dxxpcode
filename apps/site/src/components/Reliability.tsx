import { ChevronDown } from "lucide-react";

const LOOP = [
  { stage: "Plan", description: "Outline the approach before making changes." },
  { stage: "Approve", description: "Review the proposed changes." },
  { stage: "Execute", description: "Approve writes as they happen." },
  { stage: "Verify", description: "Run project tests and feed failures back in." },
  { stage: "Review", description: "Check the diff with a fresh model context." },
  { stage: "Done", description: "Keep checkpoints to restore with /undo." },
];

const BENEFITS = [
  {
    title: "Recover from interruptions",
    description: "Retries, loop detection, and edit recovery help the agent handle stalls and failed changes.",
  },
  {
    title: "Check the work",
    description: "Project tests feed failures back to the agent. An independent review checks the diff for defects.",
  },
  {
    title: "Stay in control",
    description: "Review changes before they land, with checkpoints and undo when you want to take a step back.",
  },
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
    <section aria-labelledby="reliability-heading" className="mt-20 w-full max-w-3xl text-left">
      <h2 id="reliability-heading" className="text-balance text-center text-[26px] font-medium leading-tight tracking-[-0.02em] sm:text-[28px]">
        Built to finish the task.
      </h2>
      <p className="mx-auto mt-4 max-w-lg text-center text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
        When an edit fails or a provider stalls, DxxpCode has a recovery path.
        Changes are tested and reviewed before the task ends.
      </p>

      <ol aria-label="Task workflow" className="mt-8 grid gap-x-5 gap-y-6 border-y border-border py-7 sm:grid-cols-3 lg:grid-cols-6">
        {LOOP.map((s, i) => (
          <li key={s.stage} className="grid grid-cols-[1.5rem_1fr] gap-x-3 sm:block">
            <span aria-hidden="true" className="font-mono text-[11px] leading-5 text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="sm:mt-3">
              <h3 className="text-[14px] font-medium">{s.stage}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{s.description}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-3 divide-y divide-border">
        {BENEFITS.map((benefit) => (
          <div key={benefit.title} className="grid gap-2 py-6 sm:grid-cols-[220px_1fr] sm:gap-8">
            <h3 className="text-[15px] font-medium tracking-[-0.01em]">{benefit.title}</h3>
            <p className="text-[14px] leading-relaxed text-muted-foreground">{benefit.description}</p>
          </div>
        ))}
      </div>

      <details className="group border-y border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
          Technical details
          <ChevronDown aria-hidden="true" strokeWidth={1.5} className="h-4 w-4 shrink-0 group-open:rotate-180" />
        </summary>
        <div className="pb-7">
          <h3 className="text-[14px] font-medium">What happens when things go wrong</h3>
          <dl className="mt-4 divide-y divide-border">
            {FAILURES.map((f) => (
              <div key={f.when} className="grid gap-2 py-4 sm:grid-cols-[220px_1fr] sm:gap-8">
                <dt className="text-[13px] leading-relaxed text-muted-foreground">{f.when}</dt>
                <dd className="text-[13px] leading-relaxed">{f.mechanism}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-7 text-[14px] font-medium">Verify, don't trust</h3>
          <dl className="mt-5 space-y-5">
            {VERIFY.map((v) => (
              <div key={v.lead} className="grid gap-2 sm:grid-cols-[220px_1fr] sm:gap-8">
                <dt className="font-mono text-[12px] font-medium">{v.lead}</dt>
                <dd className="text-[13px] leading-relaxed text-muted-foreground">{v.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>

      <p className="mx-auto mt-5 max-w-xl text-center text-[13px] leading-relaxed text-muted-foreground">
        <span className="text-foreground">Known limits:</span> press <kbd className="font-mono text-[12px]">Esc</kbd> to
        interrupt a mid-stream stall. Timeouts cover connection and headers, not the response body.
        One provider per session.
      </p>
    </section>
  );
}

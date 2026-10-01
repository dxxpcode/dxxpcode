export function AgentLoop() {
  return (
    <>
      <p>
        Every coding agent demos well. Give two agents the same model and the same prompt, and they
        will still diverge — not because of the model, but because of the harness: the loop of
        tools, checks, and boundaries wrapped around it. That loop is the actual product. It decides
        what the model can reach, what happens when it fails, and when the run is allowed to end.
      </p>
      <p>
        DxxpCode's loop is six stages. Each exists because of a specific way we've watched agents
        fail — including ours.
      </p>

      <h2>The stages</h2>

      <h3>plan</h3>
      <p>
        Before any file is touched, the agent outlines what it intends to do. A bad read of the task
        is cheap to correct here and expensive after forty edits. The plan is where misunderstandings
        surface while they still cost nothing.
      </p>

      <h3>approve</h3>
      <p>
        The proposed diff is shown before it lands. Approval isn't a courtesy — it's the first
        checkpoint where a human eye can catch a wrong direction before it compounds. Nothing writes
        to your tree unseen.
      </p>

      <h3>execute</h3>
      <p>
        Writes go through diff-level approval per file, and commands go through the permission
        classifier — a safe-prefix allowlist for reads, plus explicit detection of execution
        vectors (<code>env rm</code>, <code>xargs</code>, <code>node -e</code>,{" "}
        <code>find -exec</code>) that would otherwise smuggle arbitrary commands through a safe
        prefix. Paths are canonicalized so a symlink can't escape the project root.
      </p>

      <h3>auto-verify</h3>
      <p>
        After any turn that changed files, the agent runs the repo's own tests or build. Failure
        output goes back into the context, and the agent repairs its own breakage — up to two
        rounds. A run that compiles nothing doesn't get to call itself done.
      </p>

      <h3>blind review</h3>
      <p>
        Verification proves the code runs; it doesn't prove the code is right. So a second,
        isolated model pass audits the diff. It sees only the diff and the touched files — never
        the chat history, never the reasoning that produced the change. Self-review rationalizes;
        a fresh context doesn't share the author's assumptions. Findings get one repair round, then
        the run ends regardless — a review-repair loop that can't terminate is its own failure mode.
      </p>

      <h3>done</h3>
      <p>
        Every mutation is checkpointed before it lands, so <code>/undo</code> can restore any file.
        The finish summary lists what changed — the run ends with an audit trail, not a shrug.
      </p>

      <h2>What this buys</h2>
      <p>
        The honest claim isn't that the agent never errs. It's that every failure class has a
        designed response: a stuck tool loop is detected and stopped, a provider stall is
        watched and timed out, a failed edit returns the closest matching region so the model
        self-corrects in one retry. Reliability isn't a property of the model — it's the number of
        failure modes that have a path back. That number is what we work on.
      </p>
    </>
  );
}

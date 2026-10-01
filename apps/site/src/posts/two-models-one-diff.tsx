export function TwoModelsOneDiff() {
  return (
    <>
      <p>
        Auto-verify proves the code runs. It can't prove the code is right — the tests the agent
        ran are the tests it knew about, and a model reviewing its own output tends to find it
        agreeable. So before a run can call itself done, a second pass audits the change.
      </p>

      <h2>Fresh context, on purpose</h2>
      <p>
        The review model doesn't see the conversation. It sees the diff and the touched files —
        nothing else: not the prompt, not the plan, not the reasoning that produced the change.
        That's the point, not a limitation. An author rationalizes ("this works because…") and a
        reviewer with no stake in the explanation reads what's actually there.
      </p>

      <h2>What it actually catches</h2>
      <p>
        The findings aren't vague. The reviewer reports concrete defects — a guard dropped in the
        refactor, an off-by-one, a deleted error path, a TODO that changed behavior — or it says
        CLEAN. Findings get one repair round: the agent fixes, the diff is re-checked, and then
        the run ends regardless. A review-repair loop that can't terminate is its own failure
        mode, so it doesn't get one.
      </p>

      <h2>Two models, not one smarter model</h2>
      <p>
        There's a fashionable alternative: one bigger model, asked to "double-check" itself. It
        doesn't work the same way — the check inherits the same assumptions that produced the
        bug. Context separation is the cheap version of a second opinion: same model is fine,
        different information is what matters. The reviewer being ignorant of your reasoning is
        precisely why it works.
      </p>
    </>
  );
}

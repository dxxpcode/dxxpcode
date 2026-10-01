export function EditsThatDontFail() {
  return (
    <>
      <p>
        The most common way an agent wastes a turn isn't reasoning badly — it's failing to apply a
        patch. The model produces a perfectly reasonable edit, the old code it's anchoring on
        differs by a space or a renamed variable, the match fails, and the turn burns a retry
        guessing again. Multiply that across a run and "editing files" becomes the bottleneck no
        one talks about.
      </p>
      <p>
        So we rebuilt <code>edit_file</code> around a single question: how does a failed edit stop
        being a failure?
      </p>

      <h2>Tolerant matching</h2>
      <p>
        Exact string matching is the wrong contract. Files have trailing whitespace, mixed
        indentation, and lines the model saw two turns ago and paraphrased. The matcher ignores
        trailing whitespace and tries normalized-indentation variants before declaring a miss —
        the model's job is to describe intent, not to reproduce bytes.
      </p>

      <h2>Miss-hints, not dead ends</h2>
      <p>
        When a match does fail, the tool doesn't return <code>"old_string not found"</code> and
        stop. It returns the region of the file closest to what the model described — so the next
        attempt is informed, not guessed. In practice a miss becomes a one-retry self-correction
        instead of a spiral.
      </p>

      <h2>Batch edits</h2>
      <p>
        A turn often wants several edits to the same file — rename a function and update its three
        call sites. Each call is a separate approval and a separate chance to fail halfway through.
        Batch edits apply a list of patches to one file atomically: either the file reflects all of
        them, or none land. No half-renamed file left for the user to clean up.
      </p>

      <h2>Why it matters</h2>
      <p>
        Reliability compounds. A 95% per-edit success rate across a twenty-edit task is a coin flip.
        Raising each edit toward "fails only when genuinely ambiguous" is what turns an impressive
        demo into a tool that finishes real work — and it's invisible when it works, which is
        exactly the point.
      </p>
    </>
  );
}

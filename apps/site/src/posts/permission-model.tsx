export function PermissionModel() {
  return (
    <>
      <p>
        An agent that can run shell commands needs a line between "reads things" and "does
        things." The tempting implementation is a safe-prefix allowlist — approve anything
        starting with <code>ls</code>, <code>cat</code>, or <code>git status</code>. It also leaks
        immediately.
      </p>

      <h2>Why prefixes leak</h2>
      <p>
        A prefix is a string property; safety is a semantic property. <code>env rm -rf .</code>{" "}
        starts with <code>env</code> — a safe prefix — and executes <code>rm</code> as a
        subprocess. Same for <code>xargs rm</code>, <code>node -e</code>,{" "}
        <code>find . -exec rm {} \;</code>, and every interpreter flag that turns a read-looking
        command into arbitrary code. Any allowlist built on command names is a filter for inputs
        the attacker hasn't thought of yet.
      </p>

      <h2>Exec-vector classification</h2>
      <p>
        The classifier doesn't ask "what's the command" — it asks "can this command spawn
        something." Reads pass on the allowlist. Anything containing a known execution vector —
        env-assignments, xargs, shell substitutions, interpreter eval flags, find -exec — is
        promoted to explicit approval regardless of the prefix it rode in on. The model gets a
        plain-language reason ("contains an execution vector") it can route around instead of a
        bare denial.
      </p>

      <h2>Paths can't escape the root</h2>
      <p>
        The other hole isn't the command, it's the target. <code>cat ../../etc/passwd</code>{" "}
        looks like a read. Every path argument is canonicalized and checked against the project
        root — including through symlinks, which are resolved before comparison so a link inside
        the project pointing outside it doesn't pass. Denied paths get the same explanatory
        error.
      </p>

      <h2>Why it matters</h2>
      <p>
        A permission model you can't explain to yourself can't be trusted by anyone else. Ours
        fits in one paragraph: reads run free, exec vectors are never silent, paths stay inside
        the project. Every rule exists because we watched a hole it closes.
      </p>
    </>
  );
}

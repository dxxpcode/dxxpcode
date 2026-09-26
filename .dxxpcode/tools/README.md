# Project tools

Drop scripts or docs here and the agent can use them. It sees the file names
in its context and reads a file when it needs that tool — no schemas dumped
up front.

Convention:

- An executable file (`web-search`, `deploy.sh`) is invoked via run_command.
- A `.md` file documents a command-line tool already installed (`gh.md`).
- Keep each file small and self-contained: usage line, auth env var name
  (never a real secret), and one example.

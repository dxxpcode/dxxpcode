# gh — GitHub CLI

`gh` is installed and authenticated. Prefer it over the GitHub API or
git plumbing for anything on GitHub.

- PRs: `gh pr list`, `gh pr view <n>`, `gh pr checks <n>`, `gh pr diff <n>`
- Issues: `gh issue list`, `gh issue view <n>`
- CI logs: `gh run list`, `gh run view --log <id>`
- Releases: `gh release list`, `gh release view <tag>`

Always pass `--repo owner/name` when the working directory is not a
checkout of the repo in question.

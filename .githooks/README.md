# Commit co-authors

Every commit in this project credits both Claude and Codex. The tracked
`prepare-commit-msg` hook adds missing `Co-authored-by` trailers automatically,
including when amending a commit, and avoids duplicates.

This checkout is configured already. After cloning, enable the hook with:

```sh
git config core.hooksPath .githooks
```

Keep both trailers when writing commit messages manually:

```text
Co-authored-by: Claude <noreply@anthropic.com>
Co-authored-by: Codex <noreply@openai.com>
```

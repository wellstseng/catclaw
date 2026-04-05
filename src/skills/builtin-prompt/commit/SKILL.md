---
name: commit
description: "Create a git commit with proper analysis and safety rules."
allowed-tools: ["run_command"]
---

# /commit — Git Commit

Create a well-formed git commit by analyzing changes, drafting a message, and committing safely.

## Steps

1. **Gather info** (run these in parallel via `run_command`):
   - `git status` — see untracked & staged files
   - `git diff --cached && git diff` — see all changes
   - `git log --oneline -5` — recent commit style

2. **Analyze & draft**:
   - Summarize the nature of changes (new feature / enhancement / bug fix / refactor / test / docs)
   - Draft a concise commit message (1-2 sentences) focusing on **why**, not what
   - Do NOT commit files that likely contain secrets (`.env`, credentials, tokens)

3. **Commit** (run sequentially):
   - `git add <specific files>` — add relevant files by name, **never** use `git add -A` or `git add .`
   - `git commit -m "<message>"` — create the commit
   - `git status` — verify success

## Safety Rules

- **New commit only**: Never amend unless the user explicitly says "amend"
- **No force push**: Never `git push --force`
- **No hook bypass**: Never use `--no-verify`
- **No destructive ops**: Never `git reset --hard`, `git checkout .`, `git clean -f`
- If a pre-commit hook fails: fix the issue, re-stage, create a **new** commit (do NOT amend)
- If there are no changes to commit, say so — do not create an empty commit

---
name: pr
description: "Create a GitHub pull request with proper analysis."
allowed-tools: ["run_command"]
---

# /pr — Create Pull Request

Analyze all commits on the current branch and create a well-formed GitHub PR.

## Steps

1. **Gather info** (run these in parallel via `run_command`):
   - `git status` — see working tree state
   - `git diff --cached && git diff` — see uncommitted changes
   - `git log --oneline main..HEAD` — all commits to include
   - `git diff main...HEAD` — full diff from base branch

2. **Analyze & draft**:
   - Review **all** commits (not just the latest)
   - Draft PR title (< 70 chars) and body
   - Body format:
     ```
     ## Summary
     - bullet points

     ## Test plan
     - [ ] testing checklist
     ```

3. **Push & create PR** (run sequentially):
   - `git push -u origin HEAD` — push current branch
   - Create PR:
     ```
     gh pr create --title "<title>" --body "<body>"
     ```
   - Report the PR URL back to the user

## Safety Rules

- **Never force push** to main/master
- If there are uncommitted changes, ask the user whether to commit first
- If no remote branch exists, push with `-u` to set upstream
- Base branch defaults to `main` unless the user specifies otherwise

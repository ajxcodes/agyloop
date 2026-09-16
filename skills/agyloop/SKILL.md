---
name: agyloop
description: >-
  Multi-subagent development lifecycle orchestrator for Google Antigravity.
  Coordinates Context Discovery -> Planning -> Approval -> Implementation -> Quality Gates -> AI Review -> Conventional Commit.
  Trigger whenever the user types /agyloop, /agyloop plan, /agyloop implement, /agyloop gates, /agyloop yolo, or requests to run the disciplined agyloop development pipeline.
---

# AgyLoop Orchestrator Skill

`agyloop` orchestrates autonomous pair programming across specialized, context-isolated subagents to prevent token degradation and guarantee verified, high-quality code changes.

## Lifecycle Stages & Subagent Contracts

$$\text{Discovery} \longrightarrow \text{Plan} \longrightarrow \text{Approval Gate} \longrightarrow \text{Implement} \longrightarrow \text{Quality Gate} \longrightarrow \text{AI Review} \longrightarrow \text{Commit}$$

### 1. Discovery (`DISCOVERY`)
- Read issue context, criteria, and repository standards.
- Run `bin/agyloop transition DISCOVERY`.

### 2. Planning Subagent (`PLAN`)
- Define the read-only **`planner`** subagent with physical write suppression:
  - `enable_write_tools: false` (zero mutating file or execute commands)
  - `enable_mcp_tools: true` (read-only diagnostic MCP inspection enabled)
  - Tool whitelist: strictly `view_file`, `grep_search`, `find_by_name`, `list_dir`
  - System prompt: `prompts/planner.md`
- Invoke subagent with `Model: "pro"` (or tier resolved from `.agyloop.json`).
- Produce technical specifications in `artifacts/plans/`:
  - `[Discovery] - {Title}.md` (for defects)
  - `[Implementation] - {Title}.md` (technical plan)
  - `AgyLoop Summary.md` (cumulative run log)
- Advance state: `bin/agyloop transition PLAN`.

### 3. Human Approval Gate (`APPROVAL`)
- Pause and present plan to the user.
- Advance state: `bin/agyloop transition APPROVAL`.
- *(Skipped automatically in `yolo` mode).*

### 4. Implementation Subagent (`IMPLEMENT`)
- **Git Worktree Isolation**:
  - Automatically provisions dedicated worktree: `.worktrees/<task-id>` on branch `task/<task-id>-<slug>` sharing the root `.git/objects` store.
  - Ensures `.worktrees/` is in `.gitignore` and symlinks `node_modules` and `artifacts` from the parent workspace.
  - The developer's primary working directory remains completely untouched on its active branch.
- Launch the **`implementer`** subagent with a fresh, token-minimized context primed strictly with the approved plan:
  - Subagent execution directory: `Cwd = .worktrees/<task-id>` (or `Workspace: 'share'`)
  - `enable_write_tools: true` (full read/write access for surgical editing and verification)
  - `enable_mcp_tools: false`
  - Tool whitelist: `view_file`, `grep_search`, `find_by_name`, `list_dir`, `write_to_file`, `replace_file_content`, `run_command`
  - System prompt: `prompts/implementer.md`
- Model tier resolved via `ConfigRepository` (defaulting to `"inherit"`).
- Execute surgical code modifications adhering strictly to the approved plan.
- Advance state: `bin/agyloop transition IMPLEMENT` (or run `bin/agyloop implement`).

### 5. Quality Gate Subagent (`QUALITY_GATE`)
- Launch the isolated **`gate`** subagent inside `.worktrees/<task-id>`.
- Execute builds, test suites, and linters.
- Capture structured results: `GATE_STATUS: PASSED | FAILED`.
- If failed, route back to `IMPLEMENT`.
- Advance state: `bin/agyloop transition QUALITY_GATE`.

### 6. Two-Tier Reviewer Subagent (`REVIEW`)
- Execute pre-commit diagnostics via `critique` inside `.worktrees/<task-id>`.
- Launch the **`reviewer`** subagent to validate diffs against acceptance criteria.
- Advance state: `bin/agyloop transition REVIEW`.

### 7. Conventional Commit Gate (`COMMIT`)
- Draft a semantic conventional commit message from the isolated worktree diff.
- Seek user confirmation, commit, and push.
- Automated Teardown & Lifecycle Cleanup:
  - Detach and remove worktree: `git worktree remove --force .worktrees/<task-id>`
  - Prune dangling metadata: `git worktree prune`
- Advance state: `bin/agyloop transition COMMIT`, then `COMPLETED`.

---

## Operational Commands

- `/agyloop`: Full end-to-end lifecycle with human approval gates.
- `/agyloop plan`: Stops at the `APPROVAL` gate for technical spec sign-off.
- `/agyloop implement`: Resumes straight from an approved plan into isolated worktree modifications.
- `/agyloop gates`: Runs isolated builds, tests, and AI review on active worktree diff.
- `/agyloop yolo`: Fast-path mode auto-approving plan gates while keeping quality checks.
- `/agyloop --commit-after`: Automatically commit and teardown worktree if all quality gates pass green.
- `bin/agyloop worktree list`: List all active isolated git worktrees.
- `bin/agyloop worktree prune`: Clean up stale worktrees and release orphaned git index locks.

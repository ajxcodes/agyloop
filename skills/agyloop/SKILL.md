---
name: agyloop
description: >-
  Multi-subagent development lifecycle orchestrator for Google Antigravity.
  Coordinates Context Discovery -> Planning -> Approval -> Implementation -> Quality Gates -> AI Review -> Conventional Commit.
  Trigger whenever the user types /agyloop, /agyloop plan, /agyloop implement, /agyloop gates, /agyloop yolo, or requests to run the disciplined agyloop development pipeline.
---

# AgyLoop Orchestrator Skill

`agyloop` orchestrates autonomous pair programming across specialized, context-isolated subagents to prevent token degradation and guarantee verified, high-quality code changes.

> [!IMPORTANT]
> ### Mandatory Subagent Execution Contract (Zero Direct Root Mutation)
> The root agent orchestrating `/agyloop` is **STRICTLY PROHIBITED** from:
> 1. Directly editing source code files in the primary repository or worktree (`write_to_file`, `replace_file_content` on project files).
> 2. Directly running quality gate, build, or test commands (`npm test`, `npm run build`, `vitest`, `pytest`, etc.) in the root conversation context.
> 3. Directly committing or pushing from the root working tree.
>
> The root agent's ONLY permitted operational actions are:
> 1. Running `bin/agyloop` CLI commands (`bin/agyloop transition ...`, `bin/agyloop next [--json]`, `bin/agyloop branch-info`, `bin/agyloop implement`, `bin/agyloop commit`).
> 2. Querying pipeline next steps via `bin/agyloop next --json` to retrieve pre-configured `invoke_subagent` payloads.
> 3. Spawning context-isolated subagents via `invoke_subagent`.
> 4. Communicating with subagents via `send_message`.
> 5. Presenting plans, status, and approval gates to the user.

---

## Dual-Branch Architecture & Worktree Guardrails

```
main (stable production)
  └── phase/1-collector (collector branch: auto-created & pushed to remote best-effort)
        └── task/41-subagent-contracts (isolated in .worktrees/41)
```

1. **Dual-Branching Lifecycle**:
   - Collector branch (`phase/*` or `feature/*`) discovered via issue labels (`phase:1`) or title regex (`Phase 1:` / `[Phase 1]`).
   - Auto-creates collector branch from `main` if missing and pushes to remote (`git push -u origin <collector>` best-effort).
   - Task branch (`task/<id>-<slug>` or `fix/<id>-<slug>`) is branched directly from the collector branch.
   - PR target defaults to the collector branch (`gh pr create --base <collector>`).
2. **Worktree Isolation Guardrails**:
   - `transition IMPLEMENT` and `start-implementation` strictly mandate worktree isolation.
   - Automatically provisions `.worktrees/<task-id>` on task branch if missing.
   - Errors out with `WorktreeCreationError` if transition to `IMPLEMENT` is attempted without an active worktree unless explicitly bypassed with `--no-worktree`.
   - Symlinks `node_modules` and `artifacts` into `.worktrees/<task-id>` while keeping root working directory clean on its original branch.
   - Ensures both `.worktrees/` and `.agyloop/` are present in `.gitignore`.
3. **Automated Teardown**:
   - On `bin/agyloop commit`, prompts to clean up worktree (or cleans automatically in `-y`/`yolo` mode).
   - Pass `--keep-worktree` to preserve the directory for further inspection.

---

## Ready-to-Run Subagent Invocation Payloads

Run `bin/agyloop next --json` at any stage to inspect the next step and obtain the exact JSON payload.

### 1. Planning Subagent (`PLAN`)
```json
{
  "Subagents": [
    {
      "TypeName": "research",
      "Role": "AgyLoop Planner",
      "Model": "pro",
      "Workspace": "share",
      "Prompt": "Read issue context and codebase standards. Generate architectural plan and specifications in artifacts/plans/ with physical write suppression."
    }
  ]
}
```

### 2. Implementation Subagent (`IMPLEMENT`)
```json
{
  "Subagents": [
    {
      "TypeName": "self",
      "Role": "AgyLoop Implementer",
      "Model": "inherit",
      "Workspace": "share",
      "Prompt": "Execute code modifications strictly inside isolated worktree directory:\nCwd: .worktrees/<task-id>\nBranch: task/<task-id>-<slug>\n\nAdhere strictly to the approved plan in artifacts/plans/."
    }
  ]
}
```

### 3. Quality Gate Subagent (`QUALITY_GATE`)
```json
{
  "Subagents": [
    {
      "TypeName": "self",
      "Role": "AgyLoop Gatekeeper",
      "Model": "inherit",
      "Workspace": "share",
      "Prompt": "Execute verification quality gates strictly inside isolated worktree directory:\nCwd: .worktrees/<task-id>\n\nRun builds, typechecks, linters, and automated test suites."
    }
  ]
}
```

### 4. Reviewer Subagent (`REVIEW`)
```json
{
  "Subagents": [
    {
      "TypeName": "research",
      "Role": "AgyLoop Reviewer",
      "Model": "inherit",
      "Workspace": "share",
      "Prompt": "Inspect isolated worktree diff against base '<baseBranch>':\nCwd: .worktrees/<task-id>\n\nRun critique pre-commit diagnostics and verify Acceptance Criteria fulfillment."
    }
  ]
}
```

---

## Lifecycle Stages

$$\text{Discovery} \longrightarrow \text{Plan} \longrightarrow \text{Approval Gate} \longrightarrow \text{Implement} \longrightarrow \text{Quality Gate} \longrightarrow \text{AI Review} \longrightarrow \text{Commit}$$

### 1. Discovery & Smart Pre-Flight Checks (`DISCOVERY`)
- Read issue context, criteria, and repository standards.
- Run smart pre-flight checks:
  - If issue is `CLOSED` on GitHub -> cleanly halts (`Task #<id> is already closed.`).
  - If associated PR is already `MERGED` into base branch -> cleanly halts (`PR for task #<id> is already merged into <base_branch>.`).
  - If associated branch or PR is already `OPEN` -> enters Resume Mode without creating duplicate branches.
- Dynamic Base Branch Inference:
  - Discovers collector branch (`phase/*` or `feature/*`).
  - Auto-creates collector branch from `main` if not yet existing and pushes to remote (best-effort).
  - Routes task branch: `task/<id>-<slug>` rooted on collector branch.
  - Routes bugs to `fix/<id>-<slug>` based on phase status.
- Private vs. Public Sanitization:
  - Automatically strips private tracking URLs (e.g. `ajxcodes/projects#...`) from public commits and PR markdown.
- Run `bin/agyloop transition DISCOVERY`.

### 2. Planning Subagent (`PLAN`)
- Launch the read-only **`planner`** subagent via `invoke_subagent`.
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
- Verify or auto-provision worktree: `.worktrees/<task-id>` on task branch.
- Launch the **`implementer`** subagent via `invoke_subagent` targeting `Cwd: .worktrees/<task-id>`.
- Root agent monitors progress via `manage_task` or messages without modifying files.
- Advance state: `bin/agyloop transition IMPLEMENT` (or run `bin/agyloop implement`).

### 5. Quality Gate Subagent (`QUALITY_GATE`)
- Launch the isolated **`gate`** subagent inside `.worktrees/<task-id>` via `invoke_subagent`.
- Execute builds, test suites, and linters inside the worktree directory.
- Capture structured results: `GATE_STATUS: PASSED | FAILED`.
- If failed, route back to `IMPLEMENT`.
- Advance state: `bin/agyloop transition QUALITY_GATE`.

### 6. Two-Tier Reviewer Subagent (`REVIEW`)
- Execute pre-commit diagnostics via `critique` inside `.worktrees/<task-id>`.
- Launch the **`reviewer`** subagent to validate diffs against acceptance criteria.
- Advance state: `bin/agyloop transition REVIEW`.

### 7. Conventional Commit Gate (`COMMIT`)
- Draft a semantic conventional commit message referencing the issue (`#<id>`).
- Automatically sanitize private project tracker URLs.
- Seek user confirmation, execute commit (`bin/agyloop commit`), and teardown worktree.
- Push task branch and open PR targeting base collector branch: `gh pr create --base <collector>`.
- Advance state: `bin/agyloop transition COMMIT`, then `COMPLETED`.

---

## Operational Commands

- `/agyloop [task]`: Full end-to-end lifecycle with human approval gates.
- `/agyloop plan`: Stops at the `APPROVAL` gate for technical spec sign-off.
- `/agyloop implement`: Resumes straight from an approved plan into isolated worktree modifications.
- `/agyloop gates`: Runs isolated builds, tests, and AI review on active worktree diff.
- `/agyloop yolo`: Fast-path mode auto-approving plan gates while keeping quality checks.
- `bin/agyloop next [--json]`: Query the exact next action and get machine-readable `invoke_subagent` payloads.
- `bin/agyloop branch-info [--json]`: Inspect active base collector branch, task branch, and worktree location.
- `bin/agyloop commit [--keep-worktree]`: Commit staged changes in worktree, push, and teardown worktree.
- `bin/agyloop worktree list`: List all active isolated git worktrees.
- `bin/agyloop worktree prune`: Clean up stale worktrees and release orphaned git index locks.

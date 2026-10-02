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
> 6. When invoking commit in an automated context, the orchestrator MUST use `bin/agyloop commit -y` or `bin/agyloop commit -y -m "<msg>"` after user confirmation, as interactive mode will abort in non-TTY environments.

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
      "TypeName": "self",
      "Role": "AgyLoop Planner",
      "Model": "pro",
      "Workspace": "share",
      "Prompt": "Read issue context and codebase standards. Generate architectural plan and specifications in artifacts/plans/ with scoped write tools."
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
      "TypeName": "self",
      "Role": "AgyLoop Reviewer",
      "Model": "inherit",
      "Workspace": "share",
      "Prompt": "Inspect isolated worktree diff against base '<baseBranch>':\nCwd: .worktrees/<task-id>\n\nRun critique pre-commit diagnostics and verify Acceptance Criteria fulfillment."
    }
  ]
}
```

---

## Lifecycle Stages & Closed-Loop Architecture

$$\text{Discovery (Conditional)} \longleftrightarrow \text{Plan} \longleftrightarrow \text{Approval Gate} \longleftrightarrow \text{Implement} \longleftrightarrow \text{Quality Gate} \longleftrightarrow \text{Two-Tier Review} \longleftrightarrow \text{Commit Gate} \longrightarrow \text{Completed}$$
$$\text{Open PR Comments} \longrightarrow \text{Triage Gate (TRIAGE)} \longleftrightarrow \{\text{IMPLEMENT}, \text{PLAN}, \text{DISCOVERY}, \text{COMPLETED}\}$$

### 1. Conditional Discovery & Smart Pre-Flight Checks (`DISCOVERY`)
- **Conditional Discovery Execution**:
  - **Bug / Defect Tasks**: Run deep Root Cause Analysis (RCA) and generate `[Discovery] - {Title}.md` detailing symptoms, failure mode, and reproduction steps.
  - **Feature / Chore Tasks**: Automatically bypass the RCA investigation stage and transition directly to `PLAN`.
  - **Ambiguous Tasks**: Orchestrator clarifies context with the user before proceeding.
- **Smart Pre-Flight Invariants**:
  - If issue is `CLOSED` on GitHub $\rightarrow$ cleanly halts (`Task #<id> is already closed.`).
  - If associated PR is already `MERGED` into base branch $\rightarrow$ cleanly halts (`PR for task #<id> is already merged.`).
  - If associated branch or PR is already `OPEN` $\rightarrow$ enters **Resume Mode** without creating duplicate branches.
  - **Interactive PR Review Triage Gate**: In Resume Mode on an open PR with review comments or `CHANGES_REQUESTED`, instead of jumping directly into `IMPLEMENT`, the pipeline halts at the **Interactive Triage Gate (`STAGE_TRIAGE`)**. The developer is presented with categorized comments (`[error]`, `[suggestion]`, `[question]`) and routes the pipeline appropriately:
    - Route to `IMPLEMENT` for code fixes and small adjustments.
    - Route to `PLAN` for broader architectural rework.
    - Route to `DISCOVERY` for deep root-cause investigation.
    - Route to `COMPLETED` to dismiss or defer comments.
- **Dynamic Base Branch Inference**:
  - Discovers collector branch (`phase/*` or `feature/*`).
  - Auto-creates collector branch from `main` if not yet existing and pushes to remote (best-effort).
  - Routes task branch: `task/<id>-<slug>` rooted on collector branch (or `fix/<id>-<slug>` for bugs).
- **Private vs. Public Sanitization**:
  - Automatically strips private tracking URLs (e.g. `ajxcodes/projects#...`) from public commits and PR markdown.

### 2. PR Review Comments Triage Gate (`TRIAGE`)
- Halts pipeline execution when resuming on an open PR with review feedback (`pauseAtGate('TRIAGE')`).
- Inspects categorized review comments: `bin/agyloop triage`.
- Developer selects lifecycle destination:
  - `bin/agyloop triage implement`: Directs to `IMPLEMENT` with comments context.
  - `bin/agyloop triage plan`: Directs to `PLAN` for structural plan revision.
  - `bin/agyloop triage discovery`: Directs to `DISCOVERY` for investigative RCA.
  - `bin/agyloop triage dismiss`: Directs to `COMPLETED` dismissing comments.

### 3. Planning Subagent (`PLAN`)
- Launch the read-only **`planner`** subagent via `invoke_subagent`.
- Support iterative plan revisions: accepts `userFeedback`, `previousPlanContent`, and tracks `iterationCount`.
- Produce technical specifications in `artifacts/plans/`:
  - `[Discovery] - {Title}.md` (for defects)
  - `[Implementation] - {Title}.md` (technical plan)
  - `AgyLoop Summary.md` (cumulative run log)
- Advance state: `bin/agyloop transition PLAN`.

### 4. Human Approval Gate (`APPROVAL`) & Plan Redirection Loops
- Pause and present plan to the user.
- Human timer pause: autonomous execution timers pause while awaiting developer feedback (`pauseAtGate('APPROVAL')`).
- **Iterative Plan Redirection Loop (`APPROVAL <-> PLAN`)**:
  - Developer can approve or redirect the plan indefinitely.
  - Redirections transition back to `PLAN` with the previous draft and feedback, spawning a fresh, clean Planner subagent.
- Advance state: `bin/agyloop transition APPROVAL` (skipped automatically in `yolo` mode).

### 5. Implementation Subagent (`IMPLEMENT`)
- Verify or auto-provision worktree: `.worktrees/<task-id>` on task branch (idempotent; reuses existing worktree cleanly).
- Launch the **`implementer`** subagent via `invoke_subagent` targeting `Cwd: .worktrees/<task-id>`.
- Restrict Implementer `run_command` strictly to syntax validation (`npx tsc --noEmit`). Prohibit full test suites or linters.
- Implementer signals `IMPLEMENTATION_DONE` upon completing checklist with clean syntax.
- Advance state: `bin/agyloop transition IMPLEMENT` (or run `bin/agyloop implement`).

### 6. Quality Gate & Automated Compound Verification (`QUALITY_GATE`)
- **Dual Execution Modes**:
  - **Automated Compound Runner (`bin/agyloop gates`)**:
    - The standard and recommended verification path for automated workflows.
    - Executes Tier 1 quality gates (compilation, typechecks, linters, and full automated test suite) directly inside `.worktrees/<task-id>`.
    - Automatically chains directly into **Tier 1 Automated Critique Review** (invoking `critique` analysis across the working diff).
    - If both quality gates and critique pass without blocking issues, it automatically advances the state machine to `COMMIT` (or directly commits if `--commit-after` is supplied).
  - **Standalone Subagent Dispatch (`gate`)**:
    - Ephemeral micro-agent launched via `invoke_subagent` (using payload from `bin/agyloop next --json`).
    - Intended for interactive subagent dispatch when complete conversational context isolation or granular error handling is required.
    - Executes builds, typechecks, test suites, and linters inside `.worktrees/<task-id>`.
    - Emits structured results: `GATE_STATUS: PASSED | FAILED`.
- **Quality Gate Failure Loop**: If gates fail in either mode, transitions back to `IMPLEMENT` with isolated diagnostics in `selfCorrectionPayload` for a fresh Implementer subagent.
- Advance state: `bin/agyloop transition QUALITY_GATE`.

### 7. Two-Tier Review Architecture (`REVIEW`)
- **Tier 1 (Automated Critique Diagnostics)**:
  - Executes `critique` CLI inside `.worktrees/<task-id>` against base branch (`main` or phase collector).
  - Inspects code against repository standards (`.github/critique.md`, clean architecture boundaries, zero magic values).
  - Automatically performed as part of `bin/agyloop gates` and `bin/agyloop yolo`.
- **Tier 2 (AI Acceptance Criteria & Standards Audit)**:
  - When deep Acceptance Criteria auditing or isolated evaluation is requested, spawns the read-only **`reviewer`** subagent via `invoke_subagent` (payload from `bin/agyloop next --json`).
  - Supplied with raw `critique` diagnostics, `git diff`, repo standards, and approved plan Acceptance Criteria.
  - Reviewer verifies criteria fulfillment and emits structured verdict: `REVIEW_STATUS: APPROVED | CHANGES_REQUESTED`.
- **Optional `--commit-after` Behavior**:
  - Passing `--commit-after` to `bin/agyloop gates` or `bin/agyloop yolo` instructs the runner to automatically draft and execute the conventional commit upon clean quality gates and review approval, seamlessly advancing to `COMPLETED`.
- **Mandatory Critique & Review Failure Loop**:
  - Any `critical` or `error` findings from `critique` or unfulfilled ACs mandate `CHANGES_REQUESTED`.
  - Packages diagnostics and remediation actions into `selfCorrectionPayload`, reverting `REVIEW -> IMPLEMENT` for a fresh Implementer subagent.
- Advance state: `bin/agyloop transition REVIEW`.

### 8. Conventional Commit Gate (`COMMIT`) & Rejection Loops
- Human timer pause: autonomous execution timers pause while awaiting commit sign-off (`pauseAtGate('COMMIT')`).
- Draft a semantic conventional commit message referencing the issue (`#<id>`).
- Automatically sanitize private project tracker URLs.
- **Commit Gate Rejection Loops**:
  - Developer can reject the completed implementation at the commit gate.
  - Rejection with code feedback routes `COMMIT -> IMPLEMENT` for code fixes.
  - Rejection with design feedback routes `COMMIT -> PLAN` for architectural replanning.
- Upon confirmation: execute commit (`bin/agyloop commit`), push task branch, teardown worktree, and open PR targeting base collector branch: `gh pr create --base <collector>`.
- Advance state: `bin/agyloop transition COMMIT`, then `COMPLETED`.

---

## Ephemeral Subagent Lifecycle Protocol

To prevent context rot, token degradation, and hallucination during multi-step development loops:
1. **Single-Turn Micro-Agents**: Every subagent invocation (`planner`, `implementer`, `gate`, `reviewer`) is treated as a single-turn, disposable micro-agent.
2. **Targeted State Handoff**: Subagents receive only the relevant task context and structured `selfCorrectionPayload` (compiler errors, failing test traces, critique violations, or PR review comments).
3. **Fresh Execution Contexts**: Sequential correction cycles discard the previous subagent conversation and spawn a fresh subagent with the current working tree state and targeted remediation directives.

---

## CLI Command Reference & Cheatsheet

> [!CAUTION]
> **Anti-Hallucination Directive**:
> Never guess subcommands or execute `bin/agyloop --help` during automated agent workflows. Reference this cheatsheet directly.
> Note: `bin/agyloop start` does **NOT** exist. Use `bin/agyloop [issue]` or `bin/agyloop plan --issue <id>`.

| Command / Invocation | Description & Primary Use Case | Key Flags & Arguments |
| :--- | :--- | :--- |
| `bin/agyloop [issue]` | Standard continuous lifecycle orchestrator. Runs Discovery $\rightarrow$ Plan $\rightarrow$ [Approval] $\rightarrow$ Implement $\rightarrow$ Gates $\rightarrow$ Review $\rightarrow$ [Commit]. | `[issue]` (e.g. `113`), `--yolo`, `--commit-after`, `--no-worktree`, `--dry-run` |
| `bin/agyloop plan [--issue <id>]` | Plan-only mode. Generates persistent specification in `artifacts/plans/` and halts at `[APPROVAL]` gate. | `--issue <id>`, `--title <text>`, `--type <discovery\|implementation\|auto>`, `--dry-run` |
| `bin/agyloop implement [--issue <id>]` | Resumes implementation directly from approved plan inside isolated worktree. | `--issue <id>`, `--no-worktree`, `--base-branch <branch>`, `--dry-run` |
| `bin/agyloop gates [--issue <id>]` | Compound automated verification. Runs test suite, compilation, and automated Critique analysis; advances to `COMMIT` if clean. | `--commit-after`, `--staged`, `-m "<msg>"`, `--issue <id>`, `--dry-run` |
| `bin/agyloop commit` | Drafts Conventional Commit and prompts for interactive human approval (or commits immediately with `-y`). | `-y` / `--yes`, `-m` / `--message "<msg>"`, `-s` / `--staged`, `--keep-worktree`, `--dry-run` |
| `bin/agyloop yolo [--issue <id>]` | Unattended fast-path execution. Auto-approves plan gate and streams through implementation and compound gates. | `--issue <id>`, `--commit-after`, `--no-worktree`, `--dry-run` |
| `bin/agyloop next [--json]` | Inspects current lifecycle state and outputs the next recommended action or machine-readable `invoke_subagent` payload. | `--json` |
| `bin/agyloop branch-info [--json]` | Displays base collector branch, active task branch, worktree directory, and PR target. | `--json` |
| `bin/agyloop status` | Displays current pipeline stage, execution mode, active issue, worktree list, and transition history. | None |
| `bin/agyloop worktree <subcommand>` | Manages isolated git worktrees. Valid subcommands: `list`, `clean`, `prune`, `remove <id>`. | `list`, `clean`, `prune`, `remove <task-id>`, `--all`, `--subagents` |
| `bin/agyloop critique <subcommand>` | Manages Critique CLI integration and version status. Valid subcommands: `status`, `install`, `update`. | `status`, `install`, `update`, `--force`, `--json` |
| `bin/agyloop triage <action>` | Routes open PR review comments to lifecycle stages. Valid actions: `implement`, `plan`, `discovery`, `dismiss`. | `implement`, `plan`, `discovery`, `dismiss`, `--issue <id>`, `-m "<notes>"`, `--json` |
| `bin/agyloop release [phaseBranch]` | Creates a Milestone Release PR from phase collector to main with automated SemVer labeling and changelog. | `[phaseBranch]`, `--base-branch <branch>`, `--dry-run`, `--refresh` |
| `bin/agyloop reset` | Resets the `.agyloop/state.json` checkpoint for the repository. | None |
| `bin/agyloop transition <STAGE>` | Manually advances or rolls back the state machine to a specific lifecycle stage. | `<STAGE>` (e.g. `PLAN`, `IMPLEMENT`, `QUALITY_GATE`, `REVIEW`, `COMMIT`) |

---

## User Slash Commands

- `/agyloop [task]`: Full end-to-end lifecycle with human approval gates.
- `/agyloop plan`: Stops at the `APPROVAL` gate for technical spec sign-off.
- `/agyloop implement`: Resumes straight from an approved plan into isolated worktree modifications.
- `/agyloop gates`: Runs isolated builds, tests, and AI review on active worktree diff.
- `/agyloop yolo`: Fast-path mode auto-approving plan gates while keeping quality checks.

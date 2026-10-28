---
name: agyloop
description: >-
  Multi-subagent development lifecycle orchestrator for Google Antigravity.
  Coordinates Context Discovery -> Planning -> Approval -> Implementation -> Quality Gates -> AI Review -> Conventional Commit.
  Trigger whenever the user types /agyloop, /agyloop plan, /agyloop implement, /agyloop yolo, or requests to run the disciplined agyloop development pipeline.
---

# AgyLoop Orchestrator Skill

`agyloop` orchestrates autonomous pair programming across specialized, context-isolated subagents to prevent token degradation and guarantee verified, high-quality code changes.

> [!IMPORTANT]
> ### Mandatory Subagent Execution Contract (Zero Direct Root Mutation)
> The root agent orchestrating `/agyloop` is **STRICTLY PROHIBITED** from:
> 1. Directly editing source code files in the primary repository or worktree (`write_to_file`, `replace_file_content` on project files).
> 2. Directly running quality gate, build, or test commands (`npm test`, `npm run build`, `vitest`, `pytest`, etc.) in the root conversation context.
> 3. Directly committing or pushing from the root working tree.
> 4. Manually forcing stage transitions (e.g. `bin/agyloop transition COMMIT` or `COMPLETED`) that bypass the `QUALITY_GATE` or `REVIEW` stages. Forced transitions that skip these stages are forbidden.
>
> The root agent's ONLY permitted operational actions are:
> 1. Running `bin/agyloop` CLI commands (`bin/agyloop transition ...`, `bin/agyloop next [--json]`, `bin/agyloop resume`, `bin/agyloop branch-info`, `bin/agyloop implement`, `bin/agyloop commit`).
> 2. Querying pipeline next steps via `bin/agyloop next --json` to retrieve pre-configured `invoke_subagent` payloads.
> 3. Spawning context-isolated subagents via `invoke_subagent`.
> 4. Communicating with subagents via `send_message`.
> 5. Presenting plans, status, and approval gates to the user.
> 6. When invoking commit in an automated context, the orchestrator MUST use `bin/agyloop commit -y` or `bin/agyloop commit -y -m "<msg>"` after user confirmation, as interactive mode will abort in non-TTY environments.
>
> ### Worker Subagent Contract (Anti-Inception Guardrails)
> Subagents spawned by agyloop are leaf workers and are STRICTLY PROHIBITED from acting as the orchestrator.
> Subagents must NEVER call `invoke_subagent`, `define_subagent`, or spawn duplicate subagents. Subagents must execute their designated task directly using only their permitted tools and report results back to the caller.

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
  - `bin/agyloop triage completed`: Records a disposition and posts nothing to the PR — the non-destructive exit; the gate does not re-open.
  - `bin/agyloop triage dismiss`: Directs to `COMPLETED` dismissing comments, and **writes to GitHub**; it is not the non-destructive exit. With `-m "<notes>"`, replies to and resolves only the unresolved review threads containing the triaged comments (other threads are untouched), and answers the triaged PR conversation comments. The route has no memory of its own between runs, so "already answered" is derived from the PR's current state: an inline comment whose review thread is **resolved** was answered by an earlier run, and a conversation comment whose id another comment **references** (`...#issuecomment-<id>`, carried by every dismissal reply the tool posts) was answered by an earlier run — both are skipped, never answered twice. A conversation comment is also skipped when its normalised feedback key matches an inline comment that was replied to in the same run; a paraphrase of the same feedback at a different line is a different key and is answered again. The tool's own dismissal replies (the `Dismissing this PR conversation comment:` footer, the id-bearing reference) are ignored. An **unmarked prior answer** — a reply posted before the tool carried a marker, which no rule can attribute — is ignored rather than answered a third time, but only when it predates the newest dismissal answer, so a comment posted afterwards is still answered. Failures never block the transition: the CLI reports how many threads and conversation comments were replied to and resolved, how many were skipped (already answered / duplicate feedback), how many were ignored (the tool's own reply / unmarked prior answer), how many failed, and the failure details — a partial dismissal is reported as `DISMISS (PARTIAL)`, never as an unqualified success.

### 3. Planning Subagent (`PLAN`)
- Launch the read-only **`planner`** subagent via `invoke_subagent`.
- Support iterative plan revisions: accepts `userFeedback`, `previousPlanContent`, and tracks `iterationCount`.
- Produce technical specifications in the ONE canonical `artifacts/plans/<issue>-<slug>/` directory:
  - `[Discovery] - {Title}.md` (the RCA report for defects)
  - `implementation_plan.md` (the technical specification the planner completes; this is what PLAN/QUALITY_GATE/REVIEW/COMMIT resolve)
  - `CodeLoop Summary.md` (cumulative run log)
- For a defect scaffold the RCA report and `implementation_plan.md` are DIFFERENT documents: `implementation_plan.md` always starts from the implementation template.
- Advance state: `bin/agyloop transition APPROVAL` (`bin/agyloop plan` moves DISCOVERY → PLAN).

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
  - **Gate Subagent Dispatch (`gate`)**:
    - Run `bin/agyloop next --json` to retrieve the `invoke_subagent` payload, then launch the gate subagent.
    - The `yolo` runner chains quality gates and Tier 1 critique automatically, advancing to `COMMIT` when clean.
  - **Standalone Subagent Dispatch (`gate`)**:
    - Ephemeral micro-agent launched via `invoke_subagent` (using payload from `bin/agyloop next --json`).
    - Intended for interactive subagent dispatch when complete conversational context isolation or granular error handling is required.
    - Executes builds, typechecks, test suites, and linters inside `.worktrees/<task-id>`.
    - Emits structured results: `GATE_STATUS: PASSED | FAILED`, plus the machine-readable `GATE_REPORT_JSON:` evidence block described next.
    - **Filing the gate evidence**: the gate subagent only EMITS the `GATE_REPORT_JSON:` block as the last thing in its response — it is verification-only and never runs `codeloop`. The **orchestrator** writes the block to a file and files it: `bin/agyloop gate-report --issue <n> --report-file <path>` (equivalently `bin/codeloop gate-report …`), or pipes it in with `--report-stdin`. `bin/codeloop gate-report` refuses to run inside a dispatched subagent session. `bin/agyloop transition REVIEW` then ingests the filed report into the checkpoint and the CodeLoop Summary (verdict, build system, test count, measured duration) and consumes it. **The gate exits with evidence or it does not exit at all**: `transition REVIEW` REFUSES (non-zero, nothing written, no `REVIEW` entry) when no same-round `GATE_REPORT_JSON` block is filed, so a gate can never be certified as `PASSED` on nothing. Filing is legal only at `QUALITY_GATE`; if the gate was already left, file late by walking back: `bin/agyloop transition IMPLEMENT`, then `bin/agyloop transition QUALITY_GATE`, then `bin/agyloop gate-report --issue <n> --report-file <path>`, then `bin/agyloop transition REVIEW`. (The non-certifying exits `transition IMPLEMENT` / `transition TRIAGE` still record `NOT RECORDED`.)
- **Quality Gate Failure Loop**: If gates fail in either mode, transitions back to `IMPLEMENT` with isolated diagnostics in `selfCorrectionPayload` for a fresh Implementer subagent.
- Advance state: `bin/agyloop transition QUALITY_GATE` to enter the gate, then `bin/agyloop gate-report` and `bin/agyloop transition REVIEW` to leave it with evidence.

### 7. Two-Tier Review Architecture (`REVIEW`)
- **Tier 1 (Automated Critique Diagnostics)**:
  - Executes `critique` CLI inside `.worktrees/<task-id>` against base branch (`main` or phase collector).
  - Inspects code against repository standards (`.github/critique.md`, clean architecture boundaries, zero magic values).
  - Automatically performed as part of `bin/agyloop yolo`.
- **Tier 2 (AI Acceptance Criteria & Standards Audit)**:
  - When deep Acceptance Criteria auditing or isolated evaluation is requested, spawns the read-only **`reviewer`** subagent via `invoke_subagent` (payload from `bin/agyloop next --json`).
  - Supplied with raw `critique` diagnostics, `git diff`, repo standards, and approved plan Acceptance Criteria.
  - Reviewer verifies criteria fulfillment and emits structured verdict: `REVIEW_STATUS: APPROVED | CHANGES_REQUESTED`.
  - **Filing the verdict**: the reviewer subagent only EMITS the block — it is read-only and never runs `codeloop`. The **orchestrator** writes the block to a file and files it: `bin/agyloop review --issue <n> --verdict-file <path>` (equivalently `bin/codeloop review --issue <n> --verdict-file <path>`), pipe it in with `bin/agyloop review --issue <n> --verdict-stdin`, or pass it inline with `--review-output "<block>"`. `bin/codeloop review` refuses to run inside a dispatched subagent session, so the write is the orchestrator's alone. The recorded verdict is the reviewer's own: `APPROVED` advances to the COMMIT gate, `CHANGES_REQUESTED` reverts to `IMPLEMENT` (exit code `1`). Tier 1 critique still runs on the filing path, so a `critical`/`error` finding forces `CHANGES_REQUESTED` even when the reviewer approved. `bin/agyloop review` with no verdict flag runs the Tier 1 critique review instead.
- **Optional `--commit-after` Behavior**:
  - Passing `--commit-after` to `bin/agyloop yolo` instructs the runner to automatically draft and execute the conventional commit upon clean quality gates and review approval, seamlessly advancing to `COMPLETED`.
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
| `bin/agyloop [issue]` | Standard continuous lifecycle orchestrator. Runs Discovery $\rightarrow$ Plan $\rightarrow$ [Approval] $\rightarrow$ Implement $\rightarrow$ Gates $\rightarrow$ Review $\rightarrow$ [Commit]. | `[issue]` (e.g. `113`), `--yolo`, `--commit-after`, `--no-worktree`, `--dry-run` (`--json` is refused) |
| `bin/agyloop plan [--issue <id>]` | Plan-only mode. Scaffolds/reuses the ONE canonical `artifacts/plans/<issue>-<slug>/` directory, moves the checkpoint to `[PLAN]`, and halts at `[APPROVAL]`. Re-running it adopts the existing directory (a populated RCA report releases the RCA gate). | `--issue <id>`, `--title <text>`, `--type <discovery\|implementation\|auto>`, `--plan-path <file>`, `--plan-dir <dir>`, `--dry-run` |
| `bin/agyloop implement [--issue <id>]` | Resumes implementation directly from approved plan inside isolated worktree. `next` at IMPLEMENT returns the **planner** while the plan is blank, and the implementer once it is non-blank. | `--issue <id>`, `--plan-path <file>`, `--plan-dir <dir>`, `--no-worktree`, `--base-branch <branch>`, `--dry-run` |
| `bin/agyloop triage` | Read-only: lists current PR review comments without changing state. | `--issue <id>`, `--json` |
| `bin/agyloop commit` | Drafts Conventional Commit and prompts for interactive human approval (or commits immediately with `-y`). | `-y` / `--yes`, `-m` / `--message "<msg>"`, `-s` / `--staged`, `--keep-worktree`, `--dry-run` (`--json` is refused) |
| `bin/agyloop yolo [--issue <id>]` | Unattended fast-path execution. Auto-approves plan gate and streams through implementation and compound gates. Re-running `yolo` while parked at `DISCOVERY` **holds** the park until the discovery report is populated — it does not advance to `PLAN` from a pristine scaffold. A blank plan parks at IMPLEMENT with `codeloop next` (planner) or `--plan-path` as the recovery. | `--issue <id>`, `--plan-path <file>`, `--plan-dir <dir>`, `--commit-after`, `--no-worktree`, `--skip-discovery`, `--dry-run` |
| `bin/agyloop next [--json]` | Inspects current lifecycle state and outputs the next recommended action or machine-readable `invoke_subagent` payload. Reports a gate pause but **never clears one**. Read-only by default: plain `next` never advances or resets a checkpoint. | `--json` (adds `actionable`, `pause`), `--issue <id>`, `--restart` (COMPLETED only: reset and re-open at DISCOVERY). `--dry-run` is refused: `next` can persist a TRIAGE pause, so it has no simulation path |
| `bin/agyloop resume` | Clears a persisted gate pause (`CIRCUIT_BREAKER`, `APPROVAL`, `COMMIT`, `TRIAGE`) and checkpoints the wait time. The only command that clears a pause. | `--json`, `--dry-run` |
| `bin/agyloop branch-info [--json]` | Displays base collector branch, active task branch, worktree directory, and PR target. | `--json` |
| `bin/agyloop sync` | Fast-forwards the collector branch and closes issues whose PRs merged into it. | `--dry-run` (no fetch, pull, or issue close) |
| `bin/agyloop review` | Records the dispatched Reviewer subagent's verdict (`APPROVED` advances to COMMIT; `CHANGES_REQUESTED` reverts to IMPLEMENT). | `--issue <id>`, `--verdict-file <path>`, `--review-output "<block>"`, `--verdict-stdin`, `--json`, `--dry-run` |
| `bin/agyloop gate-report` | Files the dispatched Quality Gate subagent's `GATE_REPORT_JSON:` evidence block; `transition REVIEW` ingests and consumes it, writing the verdict, build system, test count and duration into the summary. Refused to dispatched subagents. | `--issue <id>`, `--report-file <path\|->`, `--report-stdin`, `--json`, `--dry-run` |
| `bin/agyloop status [--json]` | Displays current pipeline stage, execution mode, active issue, worktree list, and transition history. | `--json` (single JSON document: `dryRun`, `currentStage`, `mode`, `activeTasks`, `skippedCorrupt`, `history`) |
| `bin/agyloop worktree <subcommand>` | Manages isolated git worktrees. Valid subcommands: `list`, `clean`, `prune`, `remove <id>`. | `list`, `clean`, `prune`, `remove <task-id>`, `--all`, `--subagents`, `--dry-run` (clean/prune/remove; `list` refuses it) |
| `bin/agyloop critique <subcommand>` | Manages Critique CLI integration and version status. Valid subcommands: `status`, `install`, `update`. | `status`, `install`, `update`, `--force`, `--json` (status only), `--dry-run` (install/update) |
| `bin/agyloop triage <action>` | Routes open PR review comments to lifecycle stages. Valid actions: `implement`, `plan`, `discovery`, `completed`, `dismiss`. `completed` records a disposition and posts nothing to the PR (non-destructive exit); `dismiss` also replies to/resolves the PR threads (writes to GitHub). A routing action requires the checkpoint to be at the TRIAGE gate. | `implement`, `plan`, `discovery`, `completed`, `dismiss`, `--issue <id>`, `-m "<notes>"`, `--json`, `--dry-run` |
| `bin/agyloop release [phaseBranch]` | Creates a Milestone Release PR from phase collector to main with automated SemVer labeling and changelog. | `[phaseBranch]`, `--base-branch <branch>`, `--dry-run`, `--refresh` |
| `bin/agyloop reset` | Resets the `.agyloop/state.json` checkpoint for the repository (or a task checkpoint with `--issue`). | `--issue <id>`, `--all`, `--dry-run` (`--json` is refused) |
| `bin/agyloop transition <TARGET_STAGE>` | Moves the state machine to the TARGET stage (the stage you want to enter, not the current one). Follow the sequence DISCOVERY -> PLAN -> APPROVAL -> IMPLEMENT -> QUALITY_GATE -> REVIEW -> COMMIT -> COMPLETED. Calling `transition X` while already in stage `X` throws `InvalidTransitionError`. | `<TARGET_STAGE>` (e.g. `PLAN`, `IMPLEMENT`, `QUALITY_GATE`, `REVIEW`, `COMMIT`) |
| `bin/agyloop abort` / `bin/codeloop abort` | Emergency Stop: terminates active subagents, clears git index locks, quarantines uncommitted changes, and shuts down test sandboxes. | `-f` / `--force`, `--quarantine`, `--no-quarantine`, `--reason "<text>"`, `--dry-run` |

### Gate Pause Recovery

`next` **reports** a pause; `resume` **clears** it. They are not interchangeable.

1. Read `actionable` and `pause` from `bin/agyloop next --json`. When `actionable` is `false`, or `pause` is non-null, the pipeline is halted at a gate (`{ gate, pausedAt, resumeCommand, message }`) and the returned subagent payload is **not** a directive to execute.
2. Resolve the blocking condition — e.g. wait out the provider quota window behind a `CIRCUIT_BREAKER` (exit code `2`, nothing is lost).
3. Run `bin/agyloop resume`, then re-run `bin/agyloop next --json`.

Never re-run `next` in a loop to clear a pause — it only reads the checkpoint and will keep reporting the same halt. Non-human gates (`CIRCUIT_BREAKER`) are consumed automatically once the pipeline transitions again; human gates (`APPROVAL`, `COMMIT`, `TRIAGE`) wait for the developer. `bin/agyloop status` surfaces the same state as `Paused At Gate`, `Paused At`, and a `Recovery:` hint.

---

## User Slash Commands

- `/agyloop [task]` or `/codeloop [task]`: Full end-to-end lifecycle with human approval gates.
- `/agyloop plan` or `/codeloop plan`: Stops at the `APPROVAL` gate for technical spec sign-off.
- `/agyloop implement` or `/codeloop implement`: Resumes straight from an approved plan into isolated worktree modifications.
- Quality gate stage: run the `gate` subagent from the payload in `bin/agyloop next --json` against the active worktree diff.
- `/agyloop yolo` or `/codeloop yolo`: Fast-path mode auto-approving plan gates while keeping quality checks.
- `/agyloop abort` or `/codeloop abort`: Emergency Stop halting all active subagents and restoring workspace stability.

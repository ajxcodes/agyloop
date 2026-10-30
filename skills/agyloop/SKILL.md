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
> 4. Manually forcing stage transitions (e.g. `codeloop transition COMMIT` or `COMPLETED`) that bypass the `QUALITY_GATE` or `REVIEW` stages. Forced transitions that skip these stages are forbidden.
>
> The root agent's ONLY permitted operational actions are:
> 1. Running `codeloop` CLI commands (`codeloop transition ...`, `codeloop next [--json]`, `codeloop resume`, `codeloop branch-info`, `codeloop implement`, `codeloop commit`).
> 2. Querying pipeline next steps via `codeloop next --json` to retrieve pre-configured `invoke_subagent` payloads.
> 3. Spawning context-isolated subagents via `invoke_subagent`.
> 4. Communicating with subagents via `send_message`.
> 5. Presenting plans, status, and approval gates to the user.
> 6. When invoking commit in an automated context, the orchestrator MUST use `codeloop commit -y` or `codeloop commit -y -m "<msg>"` after user confirmation, as interactive mode will abort in non-TTY environments.
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
   - A PR that targets a collector branch (`phase/*` / `feature/*`) does **not** auto-close its issue on merge — GitHub **closing keywords** fire only on the default branch — so `commit` prints the caveat (whether the issue came from `--issue` or the checkpoint) and `codeloop sync` closes the issue after the merge.
2. **Worktree Isolation Guardrails**:
   - `transition IMPLEMENT` and `start-implementation` strictly mandate worktree isolation.
   - Automatically provisions `.worktrees/<task-id>` on task branch if missing.
   - Errors out with `WorktreeCreationError` if transition to `IMPLEMENT` is attempted without an active worktree unless explicitly bypassed with `--no-worktree`.
   - Symlinks `node_modules` and `artifacts` into `.worktrees/<task-id>` while keeping root working directory clean on its original branch.
   - Ensures both `.worktrees/` and `.agyloop/` are present in `.gitignore`.
3. **Automated Teardown**:
   - On `codeloop commit`, prompts to clean up worktree (or cleans automatically in `-y`/`yolo` mode).
   - Pass `--keep-worktree` to preserve the directory for further inspection.

---

## Ready-to-Run Subagent Invocation Payloads

Run `codeloop next --json` at any stage to inspect the next step and obtain the exact JSON payload.

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
- Inspects categorized review comments: `codeloop triage`.
- Developer selects lifecycle destination:
  - `codeloop triage implement`: Directs to `IMPLEMENT` with comments context.
  - `codeloop triage plan`: Directs to `PLAN` for structural plan revision.
  - `codeloop triage discovery`: Directs to `DISCOVERY` for investigative RCA.
  - `codeloop triage completed`: Records a disposition and posts nothing to the PR — the non-destructive exit; the gate does not re-open.
  - `codeloop triage dismiss`: Directs to `COMPLETED` dismissing comments, and **writes to GitHub**; it is not the non-destructive exit. `-m "<notes>"` is **required** — the dismissal notes: without it the command refuses, exits non-zero, writes nothing, and the checkpoint stays at `TRIAGE`. A dismissal that handles **zero** items (nothing replied to or resolved) also refuses and records nothing; the non-destructive exit is `codeloop triage completed`. With `-m "<notes>"`, replies to and resolves only the unresolved review threads containing the triaged comments (other threads are untouched), and answers the triaged PR conversation comments. The route has no memory of its own between runs, so "already answered" is derived from the PR's current state: an inline thread is skipped **only** when the tool's own **dismissal marker** is present (`Dismissing this inline review thread:`, or the historic `— CodeLoop Triage Subagent` signature) — a thread that is merely **resolved** is **not** skipped, because the review bot auto-resolves the threads it creates, so resolution is not proof that anyone answered. Such a thread is replied to, and is not resolved a second time — it is already closed, and the tool never claims a resolve it did not perform. A conversation comment whose id another comment **references** (`...#issuecomment-<id>`, carried by every dismissal reply the tool posts) was answered by an earlier run, and is skipped, never answered twice. A conversation comment is also skipped when its normalised feedback key matches an inline comment that was replied to in the same run; a paraphrase of the same feedback at a different line is a different key and is answered again. The tool's own dismissal replies (the `Dismissing this PR conversation comment:` footer, the id-bearing reference) are ignored. An **unmarked prior answer** — a reply posted before the tool carried a marker, which no rule can attribute — is ignored rather than answered a third time, but only when it predates the newest dismissal answer, so a comment posted afterwards is still answered. A partial or failed dismissal records **only** the feedback it actually answered, so `codeloop next` re-opens for the failed items; the CLI reports how many threads and conversation comments were replied to and resolved, how many were skipped (already answered / duplicate feedback), how many were ignored (the tool's own reply / unmarked prior answer), how many failed, and the failure details — a partial dismissal is reported as `DISMISS (PARTIAL)`, never as an unqualified success.
- **The gate also ends when the pull request is merged or closed**: `codeloop next` then records `COMPLETED` and reports idle — no `codeloop resume` and no disposition are needed. Only an OPEN PR's feedback is actionable; the check is the same one that routes *into* the gate. Fail closed: if GitHub cannot be read, the gate stays.

### 3. Planning Subagent (`PLAN`)
- Launch the read-only **`planner`** subagent via `invoke_subagent`.
- Support iterative plan revisions: accepts `userFeedback`, `previousPlanContent`, and tracks `iterationCount`.
- Produce technical specifications in the ONE canonical `artifacts/plans/<issue>-<slug>/` directory:
  - `[Discovery] - {Title}.md` (the RCA report for defects)
  - `implementation_plan.md` (the technical specification the planner completes; this is what PLAN/QUALITY_GATE/REVIEW/COMMIT resolve)
  - `CodeLoop Summary.md` (cumulative run log)
- For a defect scaffold the RCA report and `implementation_plan.md` are DIFFERENT documents: `implementation_plan.md` always starts from the implementation template.
- Advance state: `codeloop transition APPROVAL` (`codeloop plan` moves DISCOVERY → PLAN).

### 4. Human Approval Gate (`APPROVAL`) & Plan Redirection Loops
- Pause and present plan to the user.
- Human timer pause: autonomous execution timers pause while awaiting developer feedback (`pauseAtGate('APPROVAL')`).
- **Iterative Plan Redirection Loop (`APPROVAL <-> PLAN`)**:
  - Developer can approve or redirect the plan indefinitely.
  - Redirections transition back to `PLAN` with the previous draft and feedback, spawning a fresh, clean Planner subagent.
- Advance state: `codeloop transition APPROVAL` (skipped automatically in `yolo` mode).

### 5. Implementation Subagent (`IMPLEMENT`)
- Verify or auto-provision worktree: `.worktrees/<task-id>` on task branch (idempotent; reuses existing worktree cleanly).
- Launch the **`implementer`** subagent via `invoke_subagent` targeting `Cwd: .worktrees/<task-id>`.
- Restrict Implementer `run_command` strictly to syntax validation (`npx tsc --noEmit`). Prohibit full test suites or linters.
- Implementer signals `IMPLEMENTATION_DONE` upon completing checklist with clean syntax.
- Advance state: `codeloop transition IMPLEMENT` (or run `codeloop implement`).

### 6. Quality Gate & Automated Compound Verification (`QUALITY_GATE`)
- **Dual Execution Modes**:
  - **Gate Subagent Dispatch (`gate`)**:
    - Run `codeloop next --json` to retrieve the `invoke_subagent` payload, then launch the gate subagent.
    - The `yolo` runner chains quality gates and Tier 1 critique automatically, advancing to `COMMIT` when clean.
  - **Standalone Subagent Dispatch (`gate`)**:
    - Ephemeral micro-agent launched via `invoke_subagent` (using payload from `codeloop next --json`).
    - Intended for interactive subagent dispatch when complete conversational context isolation or granular error handling is required.
    - Executes builds, typechecks, test suites, and linters inside `.worktrees/<task-id>`.
    - Emits structured results: `GATE_STATUS: PASSED | FAILED`, plus the machine-readable `GATE_REPORT_JSON:` evidence block described next.
    - **Filing the gate evidence**: the gate subagent only EMITS the `GATE_REPORT_JSON:` block as the last thing in its response — it is verification-only and never runs `codeloop`. The **orchestrator** writes the block to a file and files it: `codeloop gate-report --issue <n> --report-file <path>` (equivalently `bin/codeloop gate-report …`), or pipes it in with `--report-stdin`. `bin/codeloop gate-report` refuses to run inside a dispatched subagent session. `codeloop transition REVIEW` then ingests the filed report into the checkpoint and the CodeLoop Summary (verdict, build system, test count, measured duration) and consumes it. **The gate exits with evidence or it does not exit at all**: `transition REVIEW` REFUSES (non-zero, nothing written, no `REVIEW` entry) when no same-round `GATE_REPORT_JSON` block is filed, so a gate can never be certified as `PASSED` on nothing. Filing is legal only at `QUALITY_GATE`; if the gate was already left, file late by walking back: `codeloop transition IMPLEMENT`, then `codeloop transition QUALITY_GATE`, then `codeloop gate-report --issue <n> --report-file <path>`, then `codeloop transition REVIEW`. (The non-certifying exits `transition IMPLEMENT` / `transition TRIAGE` still record `NOT RECORDED`.)
- **Gate command contract (issue #348, revised by #369)**: the approved plan's `### Quality Gate Targets` run in the task worktree, in plan order, **before** the commit gate, against the **uncommitted change** — no synthetic commit is created. Every target must pass on that dirty tree. A committed-tree **assertion** (`git diff --exit-code`, `git diff --quiet`, or the same behind `bash -c`) is rejected at plan approval, naming the command; **listing** forms (`git diff`, `git diff --stat`, `git status --porcelain`, `git diff --cached`, `git diff HEAD`) exit 0 there and are allowed. A declared entry the parser cannot execute (`uv run pytest -q` is fine; a compound `;` chain or an unknown runner is not) is refused at approval, never silently dropped into auto-detection. Declaring targets replaces the act container gate, so when the change touches `.github/workflows/**` the resolved list is **composed** with a workflow linter (`act -j <job>` first, then `actionlint`) with visible provenance, and the gate fails closed when neither can be resolved. Keep committed-tree invariants in CI (`.github/workflows/ci.yml`) or in a `bash scripts/<name>.sh` target that snapshots the pre-state and compares after. Fix the command *before* approving: editing the plan afterwards invalidates the approved digest.
- **Quality Gate Failure Loop**: If gates fail in either mode, transitions back to `IMPLEMENT` with isolated diagnostics in `selfCorrectionPayload` for a fresh Implementer subagent.
- Advance state: `codeloop transition QUALITY_GATE` to enter the gate, then `codeloop gate-report` and `codeloop transition REVIEW` to leave it with evidence.

### 7. Two-Tier Review Architecture (`REVIEW`)
- **Tier 1 (Automated Critique Diagnostics)**:
  - Executes `critique` CLI inside `.worktrees/<task-id>` against base branch (`main` or phase collector).
  - Inspects code against repository standards (`.github/critique.md`, clean architecture boundaries, zero magic values).
  - Automatically performed as part of `codeloop yolo`.
- **Tier 2 (AI Acceptance Criteria & Standards Audit)**:
  - When deep Acceptance Criteria auditing or isolated evaluation is requested, spawns the read-only **`reviewer`** subagent via `invoke_subagent` (payload from `codeloop next --json`).
  - Supplied with raw `critique` diagnostics, `git diff`, repo standards, and approved plan Acceptance Criteria.
  - Reviewer verifies criteria fulfillment and emits structured verdict: `REVIEW_STATUS: APPROVED | CHANGES_REQUESTED`.
  - **Filing the verdict**: the reviewer subagent only EMITS the block — it is read-only and never runs `codeloop`. The **orchestrator** writes the block to a file and files it: `codeloop review --issue <n> --verdict-file <path>` (equivalently `bin/codeloop review --issue <n> --verdict-file <path>`), pipe it in with `codeloop review --issue <n> --verdict-stdin`, or pass it inline with `--review-output "<block>"`. `bin/codeloop review` refuses to run inside a dispatched subagent session, so the write is the orchestrator's alone. The recorded verdict is the reviewer's own: `APPROVED` advances to the COMMIT gate, `CHANGES_REQUESTED` reverts to `IMPLEMENT` (exit code `1`). Tier 1 critique still runs on the filing path, so a `critical`/`error` finding that **requests a change** forces `CHANGES_REQUESTED` even when the reviewer approved. `codeloop review` with no verdict flag runs the Tier 1 critique review instead.
- **What counts as blocking locally**: `codeloop review` counts only `critical`/`error` findings that **request a change**: a finding that asserts no defect (e.g. "correctly pins …") is not counted as blocking and is named on stderr; ambiguous bodies still block.

- **Refuting a factually wrong finding**: A critique finding can be **factually wrong** — a change request the operator has verified is false (e.g. "`actions/checkout@v7` does not exist" when the tag exists). For that case only, `codeloop review` accepts `--refute '<path>:<line>[#<severity>]=<reason>'` (repeatable; a **reason is mandatory** and a refutation without one is refused). A refutation suppresses only that finding's Tier 1 escalation: the reviewer's verdict, the recorded source and every count stay as filed, only a filed `APPROVED` verdict can be refuted, and every refuted finding is named on stderr and recorded under `reviewRefutations` in the checkpoint. It is not a way to ignore findings you disagree with — only ones you have checked and found false.
- **Optional `--commit-after` Behavior**:
  - Passing `--commit-after` to `codeloop yolo` instructs the runner to automatically draft and execute the conventional commit upon clean quality gates and review approval, seamlessly advancing to `COMPLETED`.
- **Mandatory Critique & Review Failure Loop**:
  - Any `critical` or `error` findings from `critique` or unfulfilled ACs mandate `CHANGES_REQUESTED`.
  - Packages diagnostics and remediation actions into `selfCorrectionPayload`, reverting `REVIEW -> IMPLEMENT` for a fresh Implementer subagent.
- Advance state: `codeloop transition REVIEW`.

### 8. Conventional Commit Gate (`COMMIT`) & Rejection Loops
- Human timer pause: autonomous execution timers pause while awaiting commit sign-off (`pauseAtGate('COMMIT')`).
- Draft a semantic conventional commit message referencing the issue (`#<id>`).
- Automatically sanitize private project tracker URLs.
- **Commit Gate Rejection Loops**:
  - Developer can reject the completed implementation at the commit gate.
  - Rejection with code feedback routes `COMMIT -> IMPLEMENT` for code fixes.
  - Rejection with design feedback routes `COMMIT -> PLAN` for architectural replanning.
- Upon confirmation: execute commit (`codeloop commit`), push task branch, teardown worktree, and open the PR targeting the base collector branch. **The commit gate is not the delivery step**: run `codeloop commit --create-pr` to have the tool open the PR itself, with the sanitized body, `Closes #<id>` and the milestone. Without `--create-pr` the branch is pushed but the run is **NOT delivered** — the tool prints the single `gh pr create …` command to run, and the run is only delivered once that PR is **merged**. The default is explicit opt-in for `commit`; `--commit-after` (including `yolo --commit-after`) implies `--create-pr`, so an unattended run opens its own PR. A PR that targets a collector branch (`phase/*` / `feature/*`) does **not** auto-close its issue on merge — GitHub **closing keywords** fire only on the default branch — so `commit` prints the caveat (whether the issue came from `--issue` or the checkpoint) and `codeloop sync` closes the issue after the merge.
- Advance state: `codeloop transition COMMIT`, then `COMPLETED`.

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
> Never guess subcommands or execute `codeloop --help` during automated agent workflows. Reference this cheatsheet directly.
> Note: `codeloop start` does **NOT** exist. Use `codeloop [issue]` or `codeloop plan --issue <id>`.

| Command / Invocation | Description & Primary Use Case | Key Flags & Arguments |
| :--- | :--- | :--- |
| `codeloop [issue]` | Standard continuous lifecycle orchestrator. Runs Discovery $\rightarrow$ Plan $\rightarrow$ [Approval] $\rightarrow$ Implement $\rightarrow$ Gates $\rightarrow$ Review $\rightarrow$ [Commit]. | `[issue]` (e.g. `113`), `--yolo`, `--commit-after`, `--no-worktree`, `--dry-run` (`--json` is refused) |
| `codeloop plan [--issue <id>]` | Plan-only mode. Scaffolds/reuses the ONE canonical `artifacts/plans/<issue>-<slug>/` directory, moves the checkpoint to `[PLAN]`, and halts at `[APPROVAL]`. Re-running it adopts the existing directory (a populated RCA report releases the RCA gate). | `--issue <id>`, `--title <text>`, `--type <discovery\|implementation\|auto>`, `--plan-path <file>`, `--plan-dir <dir>`, `--dry-run` |
| `codeloop implement [--issue <id>]` | Resumes implementation directly from approved plan inside isolated worktree. Consumes a persisted `APPROVAL` pause and banks the wait, so `next --json` is immediately actionable. `next` at IMPLEMENT returns the **planner** while the plan is blank, and the implementer once it is non-blank. | `--issue <id>`, `--plan-path <file>`, `--plan-dir <dir>`, `--no-worktree`, `--base-branch <branch>`, `--dry-run` |
| `codeloop triage` | Read-only: lists current PR review comments without changing state. | `--issue <id>`, `--json` |
| `codeloop commit` | Drafts Conventional Commit and prompts for interactive human approval (or commits immediately with `-y`). `--create-pr` opens the PR itself (base = the collector branch) with the sanitized body, `Closes #<id>` and the milestone; without it the branch is pushed but **not delivered** until the printed `gh pr create …` command is run and the PR is merged. `--commit-after` implies `--create-pr`. A PR that targets a collector branch (`phase/*` / `feature/*`) does **not** auto-close its issue on merge — GitHub **closing keywords** fire only on the default branch — so `commit` prints the caveat (whether the issue came from `--issue` or the checkpoint) and `codeloop sync` closes the issue after the merge. | `-y` / `--yes`, `-m` / `--message "<msg>"`, `-s` / `--staged`, `--keep-worktree`, `--create-pr`, `--dry-run` (`--json` is refused) |
| `codeloop yolo [--issue <id>]` | Unattended fast-path execution. Auto-approves plan gate and streams through implementation and compound gates. Re-running `yolo` while parked at `DISCOVERY` **holds** the park until the discovery report is populated — it does not advance to `PLAN` from a pristine scaffold. A blank plan parks at IMPLEMENT with `codeloop next` (planner) or `--plan-path` as the recovery. | `--issue <id>`, `--plan-path <file>`, `--plan-dir <dir>`, `--commit-after`, `--no-worktree`, `--skip-discovery`, `--dry-run` |
| `codeloop next [--json]` | Inspects current lifecycle state and outputs the next recommended action or machine-readable `invoke_subagent` payload. Reports a gate pause without clearing it, **except** the documented TRIAGE exit: a `MERGED`/`CLOSED` pull request records `COMPLETED` and consumes the TRIAGE pause. Read-only by default: plain `next` never advances or resets a checkpoint **except** that same TRIAGE exit. `--json` carries `actionType`: `subagent` (a payload is attached and `actionable` is true), `human_gate`, `completed`, `preflight`, or `advance` — the stage's completion condition is already met, so there is **no payload** and the directive names the command to run. | `--json` (adds `actionType`, `actionable`, `pause`), `--issue <id>`, `--restart` (COMPLETED only: reset and re-open — at TRIAGE when the PR carries undispositioned review feedback, otherwise at DISCOVERY), `--dry-run` (reads and declares the suppressed context writes in `wouldWrite`) |
| `codeloop resume` | Clears a persisted gate pause that has **no forward command** (e.g. `CIRCUIT_BREAKER`) and checkpoints the wait time. The command that answers a gate clears its own pause: `codeloop implement` clears `APPROVAL`, `codeloop commit` clears `COMMIT`, and `codeloop next` clears the terminal `TRIAGE` pause when the PR is `MERGED`/`CLOSED`. | `--json`, `--dry-run` |
| `codeloop branch-info [--json]` | Displays base collector branch, active task branch, worktree directory, and PR target. | `--json` |
| `codeloop sync` | Fast-forwards the collector branch and closes issues whose PRs merged into it. | `--dry-run` (no fetch, pull, or issue close) |
| `codeloop review` | Records the dispatched Reviewer subagent's verdict (`APPROVED` advances to COMMIT; `CHANGES_REQUESTED` reverts to IMPLEMENT). `--critique-report` re-checks the verdict against an already-produced critique JSON report (hermetic Tier 1 — no critique subprocess). Only findings that request a change block; `--refute` releases one you have verified is false. | `--issue <id>`, `--verdict-file <path>`, `--review-output "<block>"`, `--verdict-stdin`, `--critique-report <path\|->`, `--refute <path>:<line>[#<severity>]=<reason>` (repeatable; reason mandatory), `--json`, `--dry-run` |
| `codeloop gate-report` | Files the dispatched Quality Gate subagent's `GATE_REPORT_JSON:` evidence block; `transition REVIEW` ingests and consumes it, writing the verdict, build system, test count and duration into the summary. Refused to dispatched subagents. | `--issue <id>`, `--report-file <path\|->`, `--report-stdin`, `--json`, `--dry-run` |
| `codeloop status [--json]` | Displays current pipeline stage, execution mode, active issue, worktree list, and transition history. | `--json` (single JSON document: `dryRun`, `currentStage`, `mode`, `activeTasks`, `skippedCorrupt`, `history`) |
| `codeloop worktree <subcommand>` | Manages isolated git worktrees. Valid subcommands: `list`, `clean`, `prune`, `remove <id>`. | `list`, `clean`, `prune`, `remove <task-id>`, `--all`, `--subagents`, `--dry-run` (clean/prune/remove; `list` refuses it) |
| `codeloop critique <subcommand>` | Manages Critique CLI integration and version status. Valid subcommands: `status`, `install`, `update`. | `status`, `install`, `update`, `--force`, `--json` (status only), `--dry-run` (install/update) |
| `codeloop triage <action>` | Routes open PR review comments to lifecycle stages. Valid actions: `implement`, `plan`, `discovery`, `completed`, `dismiss`. `completed` records a disposition and posts nothing to the PR (non-destructive exit); `dismiss` also replies to/resolves the PR threads (writes to GitHub). A routing action requires the checkpoint to be at the TRIAGE gate. | `implement`, `plan`, `discovery`, `completed`, `dismiss`, `--issue <id>`, `-m "<notes>"`, `--json`, `--dry-run` |
| `codeloop release [phaseBranch]` | Creates a Milestone Release PR from phase collector to main with automated SemVer labeling and changelog. | `[phaseBranch]`, `--base-branch <branch>`, `--dry-run`, `--refresh` |
| `codeloop reset` | Resets the `.agyloop/state.json` checkpoint for the repository (or a task checkpoint with `--issue`). | `--issue <id>`, `--all`, `--dry-run` (`--json` is refused) |
| `codeloop transition <TARGET_STAGE>` | Moves the state machine to the TARGET stage (the stage you want to enter, not the current one). Follow the sequence DISCOVERY -> PLAN -> APPROVAL -> IMPLEMENT -> QUALITY_GATE -> REVIEW -> COMMIT -> COMPLETED. Calling `transition X` while already in stage `X` throws `InvalidTransitionError`. | `<TARGET_STAGE>` (e.g. `PLAN`, `IMPLEMENT`, `QUALITY_GATE`, `REVIEW`, `COMMIT`) |
| `codeloop abort` / `bin/codeloop abort` | Emergency Stop: terminates active subagents, clears git index locks, quarantines uncommitted changes, and shuts down test sandboxes. | `-f` / `--force`, `--quarantine`, `--no-quarantine`, `--reason "<text>"`, `--dry-run` |

### Gate Pause Recovery

`next` **reports** a pause; the command that **answers** the gate clears it. They are not interchangeable — with two exceptions: a `TRIAGE` pause whose pull request is `MERGED`/`CLOSED` is cleared by `next` itself, because the gate is already over, and the forward commands `implement` (`APPROVAL`) and `commit` (`COMMIT`) consume the pause of the gate they answer.

1. Read `actionable`, `actionType` and `pause` from `codeloop next --json`. **`actionable` means "a subagent may be dispatched right now"** — it is `true` only for a `subagent` directive with no persisted pause. It is `false` for every `human_gate` directive (COMMIT, the DISCOVERY plan-directory park, the missing-worktree gate), for every persisted pause, for `COMPLETED` and `INITIALIZED`, and for every stage whose completion condition is already met — those report `actionType: "advance"` with **no `invocationPayload`** and name the command to run instead. A human gate carries a synthesised `pause` object (`{ gate, pausedAt, resumeCommand: null, message }`) because it is a wait on a person, not a checkpoint pause: there is nothing to `resume`. A persisted pause carries the real `resumeCommand` (`codeloop resume`). Either way, a non-null `pause` means the returned payload is **not** a directive to execute.
2. Run the command that ANSWERS the gate — that is what clears its pause: `codeloop implement` for `APPROVAL`, `codeloop commit` for `COMMIT`, and `codeloop next` for a terminal `TRIAGE` gate. `codeloop resume` is for a pause with **no forward command**: wait out the blocking condition first (e.g. the provider quota window behind a `CIRCUIT_BREAKER`, exit code `2`, nothing is lost), then run it.
3. Re-run `codeloop next --json` after the answering command (or after `codeloop resume`) to obtain the directive.

Never re-run `next` in a loop to clear a pause that is not the TRIAGE gate over a terminal PR — for every other pause it only reads the checkpoint and will keep reporting the same halt. Non-human gates (`CIRCUIT_BREAKER`) are consumed automatically once the pipeline transitions again; human gates (`APPROVAL`, `COMMIT`, `TRIAGE`) are cleared by the command that answers them. `codeloop status` surfaces the same state as `Paused At Gate`, `Paused At`, and a `Recovery:` hint.

---

## User Slash Commands

- `/agyloop [task]` or `/codeloop [task]`: Full end-to-end lifecycle with human approval gates.
- `/agyloop plan` or `/codeloop plan`: Stops at the `APPROVAL` gate for technical spec sign-off.
- `/agyloop implement` or `/codeloop implement`: Resumes straight from an approved plan into isolated worktree modifications.
- Quality gate stage: run the `gate` subagent from the payload in `codeloop next --json` against the active worktree diff.
- `/agyloop yolo` or `/codeloop yolo`: Fast-path mode auto-approving plan gates while keeping quality checks.
- `/agyloop abort` or `/codeloop abort`: Emergency Stop halting all active subagents and restoring workspace stability.

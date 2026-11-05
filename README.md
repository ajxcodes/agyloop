# CodeLoop (`codeloop`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Google Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin%20v2-purple.svg)](https://github.com/ajxcodes/agyloop)
[![Project Tracking](https://img.shields.io/badge/Roadmap-ajxcodes%2Fprojects%2347-brightgreen.svg)](https://github.com/ajxcodes/projects/issues/47)

> **Multi-Subagent Development Lifecycle Orchestrator for Google Antigravity (`agy`)**

`codeloop` transforms autonomous coding agents from single-prompt chat assistants into a disciplined, context-isolated pair-programming pipeline:

$$\text{Context} \longrightarrow \text{Plan} \longrightarrow \text{Approve} \longrightarrow \text{Implement} \longrightarrow \text{Quality Gate} \longrightarrow \text{AI Review} \longrightarrow \text{Commit}$$

---

## 🎯 The Problem

1. **Context Saturation & Token Degradation**: Cramming deep repository exploration, file editing, build logs, and unit test runs into one conversational context bloats tokens, degrades reasoning, and risks hallucinations.
2. **Ephemeral Memory**: Native agent planning files live in session-ephemeral directories (`brain/`) and are discarded across branch switches, IDE reloads, or multi-day tasks.
3. **One-Size-Fits-All Models**: Running high-reasoning flagship models for simple test log parsing wastes quota, while underpowered models fail at architectural design.
4. **Unverified & Silent Commits**: Autonomous agents frequently commit modifications without executing local test suites, static analysis, or seeking explicit user sign-off.

---

## 🏗️ Architecture & Lifecycle Contract

`codeloop` introduces a phased state machine coordinated across specialized, context-isolated subagents:

```text
[Issue / Task Context]
       │
       ▼
┌────────────────────────────────────────────────────────┐
│ 1. Context & Standards Discovery                       │
│    • Queries GitHub issue context via `gh`             │
│    • Detects repository standards & configurations     │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 2. Planning Subagent (Read-Only)                       │
│    • Strict read-only inspection (zero edits)          │
│    • Generates persistent artifacts in:                │
│      `artifacts/plans/[Discovery] - {Title}.md`        │
│      `artifacts/plans/[Implementation] - {Title}.md`   │
│      `artifacts/plans/CodeLoop Summary.md`              │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
          [🛑 Human Approval Gate: Proceed?]
                         │ (Approved / Bypassed in YOLO)
                         ▼
┌────────────────────────────────────────────────────────┐
│ 3. Implementation Subagent                             │
│    • Fresh context loaded strictly with approved plan  │
│    • Executes clean code changes and refactorings      │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 4. Quality Gate Subagent (Isolated Shell)              │
│    • Executes builds, tests, and linters               │
│    • Auto-detects Gradle, npm, dotnet, Go, Cargo, etc. │
│    • Returns compact structured summary:               │
│      `GATE_STATUS: PASSED | FAILED`                    │
│      `TEST_METRICS: X passed, 0 failed, 0 skipped`     │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 5. Two-Tier Reviewer Subagent                          │
│    • Executes CLI diagnostics: `critique`              │
│    • Cross-references diff against criteria & rules    │
│    • Structured verdict: `REVIEW_STATUS: APPROVED`     │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 6. Conventional Commit Gate                            │
│    • Formats semantic commit message (`feat:`, etc.)   │
│    • Hard gate: Draft -> Interactive user confirmation │
└────────────────────────────────────────────────────────┘
```

A gate report may declare the test count its runner does not print: append `TEST_METRICS: <n> passed, <n> failed, <n> skipped` to the command output. A `PASSED` report whose executed test command has no measured total (`"testsPassed": null` or `0`) is refused at filing and again at `transition REVIEW`.

An approved plan literal that cannot be satisfied as written is a **deviation**, not a silent edit. The implementer emits a `PLAN_DEVIATION:` block, either as a JSON object carrying `planSection`, `planLiteral`, `implementedAssertion` and `reason` (optional `files: ["path:line"]`) or with the prose labels `Plan section:`, `Plan literal:`, `Implemented:` and `Reason:`; the orchestrator files it with `codeloop deviation --issue <n> --deviation-file <path>` (or `--deviation-stdin`). The record lands in the checkpoint. `codeloop deviation` files at IMPLEMENT, QUALITY_GATE, REVIEW and COMMIT; `codeloop transition REVIEW` and `codeloop commit` refuse while one is unacknowledged — acknowledge it with `codeloop deviation --issue <n> --ack PD-1 --reason "<why the new literal is right>"`, or route the plan back with `codeloop transition PLAN`. If a deviation is discovered after implementation, file it at REVIEW, or route back with `codeloop transition IMPLEMENT`, file it there, and re-run the gate. At APPROVAL the pipeline also refuses a Test Register literal that contradicts the test it pins (naming `file:line`) and an acceptance criterion or checklist step that targets a commit-excluded path (`artifacts/`, `.agyloop/`, `node_modules/`); deliver such a correction as a tracked document or declare it `**Out of Scope:**`. A `New test:` row is judged against the **base revision** — `--base-branch`, else the checkpoint's recorded `baseBranch`, else `main` — because a plan revised through `codeloop transition PLAN` is re-approved while the implementation's own tests are already in the worktree; a `Pins:` row keeps resolving against the delivered worktree, so a pinned test that was deleted there is still refused. In the verdict, `AC_EVIDENCE:` names the path that proves each criterion — evidence outside the delivered change set makes the criterion `unverifiable` and the round cannot be certified; a filed `APPROVED` verdict that omits the block, or whose block parses to nothing, is refused and records nothing.

---

## ⚡ Configurable Model Routing

Optimize latency, reasoning capability, and quota usage by assigning appropriate models per stage in `config.json`:

| Subagent Role | Default Model Tier | Primary Purpose |
|---|---|---|
| **`planner`** | `pro` / `inherit` | Architectural reasoning, deep inspection, edge-case analysis |
| **`implementer`** | `inherit` / `flash` | Focused code generation and refactoring from plan inside isolated worktree |
| **`gate`** | `flash_lite` | Fast build/test execution, containerized `act` gates, and log parsing |
| **`reviewer`** | `flash` / `pro` | Two-tier critique diagnostics and acceptance criteria audit |
| **`triage`** | `inherit` | Categorizes PR review comments and routes pipeline lifecycle stages |

---

## 🚀 Operational Modes & Commands

```bash
# Full lifecycle with human approval gates (Plan -> Stop -> Implement -> Gate -> Review -> Commit)
/codeloop [issue]

# Plan-only mode: generates persistent tech spec in artifacts/plans/ and hard-stops for review
/codeloop plan [--issue <id>]

# Resumes implementation directly from an approved plan inside isolated worktree
/codeloop implement [--issue <id>]

# Fast-path / unattended mode: auto-approves plan gate & infers defaults while keeping quality gates
/codeloop yolo [--issue <id>]

# Automatically commit if all quality gates and reviews pass green
/codeloop --commit-after

# Commit and open the PR from the tool (base = the collector branch) instead of
# printing the `gh pr create …` command for you to run. Without it the branch is
# pushed but the run is NOT delivered until the PR is merged.
# `--commit-after` (and `yolo --commit-after`) implies `--create-pr`: an
# unattended run opens the PR itself rather than stopping one step short.
codeloop commit --create-pr

# PR Review comment triage: inspect and route review feedback
/codeloop triage [implement | plan | discovery | dismiss]

# Worktree management: list, clean, prune isolated worktrees
codeloop worktree [list | clean | prune]
```

### Collector-branch PRs and the closing keyword

A PR that targets a collector branch (`phase/*` / `feature/*`) is not a
default-branch PR. GitHub's documented **closing keyword** rule (`Closes #N`)
covers the default branch only, but delivery here has not been consistent: some
collector-branch merges auto-close the issue (#369 closed 12 s after the merge,
before any `sync`), and some leave it open until `codeloop sync` closes it
(#401). A pre-merge `closingIssuesReferences` read does not discriminate — it is
`0` on both shapes. `codeloop commit` therefore states the measured base — a
collector branch, not the default branch — and prints conditional advice: if
`Closes #N` does not close the issue on merge, run `codeloop sync` to close it.
The advice is printed only when a PR exists.

Likewise, the TRIAGE gate ends on its own: once the pull request is merged or
closed, `codeloop next` records `COMPLETED` and reports idle, with no
`codeloop resume` needed. An open PR keeps the gate.

### ⚠️ Behaviour change (issue #250): `--issue` is strict

`--issue <num>` accepts **digits only** (an optional leading `#` is allowed, so
`--issue 250` and `--issue #250` are the same thing). A token with trailing
garbage is **rejected** — the command exits 1 and reads or writes nothing:

```
✗ Invalid --issue '999abc'. Expected a positive integer (digits only), e.g. --issue 250.
```

**Deliberately changed behaviour.** `codeloop status --issue 999abc` and
`codeloop resume --issue 999abc` previously *clamped* the token to issue 999
and silently addressed `tasks/999.json`, while their sibling `halt` wrote the
ROOT checkpoint `.agyloop/state.json`. Four parsers read the same token and
disagreed about what it meant (clamp / root / literal file / silently ignored).
They now all fail the same way, before any checkpoint is touched.

Related, also deliberate: `codeloop reset --issue <n>` now exits **1** when
there is no checkpoint for that issue (it used to print an unconditional
success line for a reset it never performed), and `codeloop branch-info` is now
read-only with respect to checkpoints — it performs **zero** checkpoint writes
(it can still touch git, e.g. to materialise a missing base branch).

Every checkpoint-touching command (`status`, `next`, `resume`, `transition`,
`branch-info`, `halt`, `reset --issue <n>`, `commit`, `implement`, `plan`,
`yolo`, `abort`, `triage`, `sync`) now resolves the SAME authoritative
checkpoint, so a command that reads a task checkpoint writes that same
checkpoint — never the root. (`reset` without `--issue` is the one exception:
it clears the repository's OWN checkpoint — the root outside a task worktree,
`tasks/<n>.json` inside one — and now names the file it actually cleared.)

---

## 📂 Persistent `artifacts/plans/`

All plans and run summaries live in a gitignored `{project-root}/artifacts/plans/` directory:
- `[Discovery] - {Title}.md`: Root-cause investigation and reproduction commands for bugs.
- `[Implementation] - {Title}.md`: Detailed design specification and step-by-step technical plan.
- `CodeLoop Summary.md`: Cumulative execution log tracking subagent runtimes, quality gate verdicts, and model tiers.

Plans remain persistent across IDE reloads, branch changes, and multi-day tasks without polluting your Git commit history.

---

## 📦 Installation & Symlink Setup

To register `codeloop` with your local Antigravity installation, symlink the repository into the global Antigravity plugins directory (`~/.gemini/config/plugins/agyloop`):

### 1. Run Setup Script
```bash
./bin/setup-symlink.sh
```
*This idempotently links `{project-root}` to `~/.gemini/config/plugins/agyloop`.*

### 2. Verify Plugin Registration
```bash
./bin/verify-install.sh
```
*This validates symlink resolution, `plugin.json` schema structure, subagent declarations, and Antigravity environment readiness.*

---

## 🛠️ Troubleshooting & Plugin Resolution

If Antigravity does not immediately discover the `/codeloop` command or subagents:

1. **Check Symlink Resolution**:
   Ensure `~/.gemini/config/plugins/agyloop` points directly to your repository root:
   ```bash
   ls -la ~/.gemini/config/plugins/agyloop
   ```
2. **Validate Manifest Syntax**:
   Verify that `plugin.json` has valid JSON and required fields:
   ```bash
   ./bin/verify-install.sh
   ```
3. **Check Plugin State in `config.json`**:
   Ensure the plugin is not disabled in your Antigravity configuration (`~/.gemini/antigravity-cli/config.json` or project settings):
   ```json
   {
     "plugins": {
       "codeloop": { "enabled": true }
     }
   }
   ```
4. **Reload Workspace / App**:
   Reload the Antigravity window or restart the CLI session so the plugin manager rescans `~/.gemini/config/plugins/`.

---

## 🗺️ Roadmap & Tracking

Track the development of `codeloop` in the central [ajxcodes/projects](https://github.com/ajxcodes/projects) management board:
- **Parent Epic**: [#47 - [Epic] CodeLoop: Multi-Subagent Development Lifecycle Orchestrator for Antigravity](https://github.com/ajxcodes/projects/issues/47)
- **Project Board**: [GitHub Project #9 (CodeLoop)](https://github.com/users/ajxcodes/projects/9)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Copyright (c) 2026 ajxcodes.

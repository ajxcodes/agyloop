# CodeLoop (`codeloop`)

[![Release](https://img.shields.io/github/v/release/ajxcodes/codeloop?label=Release&color=0e8a16)](https://github.com/ajxcodes/codeloop/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Google Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin%20v2-purple.svg)](https://github.com/ajxcodes/codeloop)
[![OpenCode Compatible](https://img.shields.io/badge/OpenCode-Skill%20%2B%20CLI-00ADD8.svg)](integrations/opencode/codeloop-skill.md)
[![Project Tracking](https://img.shields.io/badge/Roadmap-ajxcodes%2Fprojects%2347-brightgreen.svg)](https://github.com/ajxcodes/projects/issues/47)

> **Multi-Subagent Development Lifecycle Orchestrator for Google Antigravity (`agy`) and OpenCode (`opencode`)**

`codeloop` (formerly `agyloop`) transforms autonomous coding agents from single-prompt chat assistants into a governed, context-isolated software delivery pipeline with isolated Git worktrees, cryptographic plan locking, two-tier code review, and resilient circuit breakers:

$$\text{Discovery (Bugs)} \longrightarrow \text{Plan} \longrightarrow \text{Approve} \longrightarrow \text{Implement} \longrightarrow \text{Quality Gate} \longrightarrow \text{Two-Tier Review} \longrightarrow \text{Commit \& PR} \longleftrightarrow \text{Triage}$$

---

## 🎯 Why CodeLoop?

1. **Context Saturation & Token Degradation**: Cramming deep repository exploration, multi-file edits, compiler output, test logs, and code review into one conversational context bloats tokens, degrades reasoning, and causes agent drift. `codeloop` dispatches single-turn, role-scoped leaf subagents with fresh context windows at every stage.
2. **Ephemeral Planning & Unpinned Specs**: Chat-only plans vanish across IDE reloads or branch switches, and agents silently rewrite requirements mid-flight. `codeloop` persists artifacts in `artifacts/plans/<issue>-<slug>/`, freezes approved plans by SHA-256 digest, and requires explicit `PLAN_DEVIATION` records if an approved literal must change.
3. **One-Size-Fits-All Model Spend**: Running frontier reasoning models to parse test logs wastes quota, while lightweight models underperform on architectural design. `codeloop` routes each lifecycle stage (`discovery`, `planner`, `implementer`, `gate`, `reviewer`, `triage`) to its optimal model tier, with automatic quota failover and checkpointed `429` pauses.
4. **Ungoverned Verdicts & Silent Commits**: Autonomous agents frequently claim tests passed without running them, edit the root workspace directly, or commit without review. `codeloop` isolates every task in `.worktrees/<issue>`, enforces orchestrator-only `gate-report` and `review` channels backed by measured evidence, and gates delivery on two-tier verification.

---

## ✨ Core Capabilities (v0.7.0)

- **Dual-Host Agent Orchestration**: Native plugin and subagent directives for **Google Antigravity (`agy`)** and first-class skill + slash-command integration for **OpenCode (`opencode`)**, emitting host-aware tool vocabularies per role.
- **Polyglot & Monorepo Project Scaffolder (`codeloop init`)**: Detects Node (`npm`/`pnpm`/`yarn`/`bun` workspaces), TypeScript, Python (`uv`/`pytest`), Go, Rust (`cargo`), Java/Kotlin (Gradle/Maven), .NET, Docker Compose, Playwright/Cypress E2E, and `nektos/act` GitHub Actions workflows to generate `.codeloop/config.json` and symlink-safe `.gitignore` rules.
- **Multi-Task State Machine & Worktree Isolation**: Concurrent per-issue checkpoints (`.agyloop/tasks/<issue>.json`), dual-branch collector routing (`main` $\rightarrow$ `phase/*` or `feature/*` $\rightarrow$ `task/<id>-<slug>` / `fix/<id>-<slug>`), and mandatory `.worktrees/<id>` isolation.
- **Governed Verification Evidence**:
  - **Approved Plan Locking**: SHA-256 digest verification, pre-approval `### Baseline Evidence` execution, static sandboxing checks for `### Manual Smoke Test Protocol`, and audited `PLAN_DEVIATION` tracking.
  - **Measured Quality Gates**: Plan-derived `### Quality Gate Targets`, vacuous-diff refusal, workflow lint composition (`act` / `actionlint`), and mandatory `GATE_REPORT_JSON` filing.
  - **Two-Tier Code Review**: Automated **Critique CLI** static/AI diff diagnostics pinned via `<report>.provenance.json` sidecars + read-only **Reviewer Subagent** Acceptance Criteria verification (`AC_EVIDENCE:`), with audited false-positive refutation (`--refute`).
- **Closed-Loop PR Triage & Milestone Releases**: Inspects inline review threads and PR conversation comments (`codeloop triage`), reconciles collector-branch merges (`codeloop sync`), and compiles SemVer-labeled milestone release PRs (`codeloop release`).
- **Operational Safety & Resilience**: Configurable circuit breakers, HTTP `429` / `RESOURCE_EXHAUSTED` quota halting (`exit 2`) with lossless `codeloop resume`, stale-build execution guards (`bin/stale-dist.js`), and emergency quarantine (`codeloop abort`).

---

## 🏗️ Architecture & Lifecycle Contract

`codeloop` coordinates specialized, context-isolated leaf subagents across an 8-stage state machine:

```text
[GitHub Issue / Task Context]
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. Pre-Flight & Conditional Discovery (`DISCOVERY`)          │
│    • Halts cleanly on CLOSED issues or MERGED PRs            │
│    • Routes OPEN PRs with feedback directly to `TRIAGE`      │
│    • Bug issues park for empirical RCA (`[Discovery] - ...`) │
│    • Feature/chore issues advance straight to `PLAN`         │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. Planning Subagent (`PLAN` — Scoped Read-Only)             │
│    • Inspects codebase without mutating tracked files        │
│    • Writes persistent spec to `artifacts/plans/<id>-<slug>` │
│      - `[Discovery] - {Title}.md` (for defects)              │
│      - `implementation_plan.md`                              │
│      - `CodeLoop Summary.md`                                 │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
       [🛑 Human Approval Gate (`APPROVAL`) + Digest Lock]
                               │ (Interactive or auto in `yolo`)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. Implementation Subagent (`IMPLEMENT` — Isolated Worktree) │
│    • Provisions `.worktrees/<id>` off collector branch       │
│    • Executes approved plan with syntax-only local checks    │
│    • Files explicit `PLAN_DEVIATION` if a literal must shift │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. Quality Gate Subagent (`QUALITY_GATE` — Isolated Shell)   │
│    • Runs plan's `Quality Gate Targets` or detected suite    │
│    • Refuses vacuous (zero-diff) or unmeasured test runs     │
│    • Emits `GATE_STATUS: PASSED | FAILED`,                   │
│      `TEST_METRICS: X passed, 0 failed, 0 skipped`,          │
│      and `GATE_REPORT_JSON` filed via `codeloop gate-report` │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. Two-Tier Review (`REVIEW` — Critique + AI Audit)          │
│    • Tier 1: `critique --commit <base>` + provenance sidecar │
│    • Tier 2: Read-only Reviewer audits ACs (`AC_EVIDENCE:`)  │
│    • Verdict filed by orchestrator via `codeloop review`     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 6. Conventional Commit & PR Delivery (`COMMIT`)              │
│    • Drafts semantic commit (`feat:`, `fix:`) & strips URLs  │
│    • `codeloop commit --create-pr` pushes, opens collector   │
│      PR with `Closes #<id>`, and tears down `.worktrees/<id>`│
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 7. PR Review Triage (`TRIAGE`) ──► `COMPLETED`               │
│    • Routes open PR review threads (`implement`, `plan`,     │
│      `discovery`, `completed`, or `dismiss -m "<notes>"`)    │
│    • Automatically exits to `COMPLETED` once PR merges       │
└──────────────────────────────────────────────────────────────┘
```

### Governed Verification Invariants

- **Measured Test Evidence (`TEST_METRICS`)**: A gate report may declare the test count its runner does not print (such as `go test ./...` or `ctest`): append `TEST_METRICS: <n> passed, <n> failed, <n> skipped` to the command output. A `PASSED` report whose executed test command has no measured positive total (`"testsPassed": null` or `0`) is refused at `codeloop gate-report` filing and again at `codeloop transition REVIEW`.
- **Plan Integrity & `PLAN_DEVIATION` Governance**: At `APPROVAL`, `codeloop` locks the plan's SHA-256 digest, verifies `### Baseline Evidence`, lints `### Manual Smoke Test Protocol` fences for temp-sandbox isolation, and validates `### Quality Gate Targets` (rejecting committed-tree-only assertions like `git diff --exit-code` that cannot pass pre-commit). If an approved plan literal cannot be satisfied as written, the implementer emits a `PLAN_DEVIATION:` block (`planSection`, `planLiteral`, `implementedAssertion`, `reason`, optional `files`), which the orchestrator files via `codeloop deviation --issue <n> --deviation-file <path>`. Both `transition REVIEW` and `codeloop commit` refuse while any deviation remains unacknowledged (`codeloop deviation --issue <n> --ack PD-1 --reason "<why>"`).
- **Two-Tier Review, `AC_EVIDENCE`, & Audited Refutations**: Tier 1 runs `critique` in the task worktree against `--commit <base>` and verifies its `<report>.provenance.json` sidecar against the active base and `HEAD`. Tier 2 requires every `APPROVED` verdict to include an `AC_EVIDENCE:` block citing delivered files; citations outside the delivered change set mark criteria `unverifiable` and block certification. Non-actionable critique affirmations are separated from blocking findings automatically, and factually false findings verified by the operator can be refuted on the audit trail via `codeloop review --refute '<path>:<line>[#<severity>]=<reason>'`.
- **Subagent Session Boundary**: Dispatched leaf subagents (`planner`, `implementer`, `gate`, `reviewer`, `triage`) are prohibited from mutating pipeline state or spawning nested subagents; `codeloop gate-report` and `codeloop review` reject invocations from inside a worker subagent environment.

---

## 📦 Installation & Host Setup

### Prerequisites
- **Node.js** `>= 18.0.0` (Node 22/24 LTS recommended)
- **Git** `>= 2.38+` (for isolated `git worktree` management)
- **GitHub CLI (`gh`)** `>= 2.40.0` (authenticated via `gh auth status`)
- **`jq`** (recommended for POSIX shell verification scripts)

### 1. Clone & Build CodeLoop
```bash
git clone https://github.com/ajxcodes/codeloop.git ~/code/codeloop
cd ~/code/codeloop
npm ci
npm run build

# Link the CLI into ~/.local/bin (ensure ~/.local/bin is on your PATH)
mkdir -p ~/.local/bin
ln -sfn ~/code/codeloop/bin/codeloop.js ~/.local/bin/codeloop
codeloop --version # 0.7.0
```
*(Cross-platform launchers are included in `bin/`: POSIX `/bin/sh` scripts `bin/codeloop` & deprecated shim `bin/agyloop`, Node entrypoints `.js`, plus Windows `.cmd` and `.ps1` wrappers.)*

### 2. Register with Google Antigravity (`agy`)
Symlink the repository into the global Antigravity plugins directory (`~/.gemini/config/plugins/codeloop`) and validate the Plugin V2 manifest contract:
```bash
./bin/setup-symlink.sh
./bin/verify-install.sh
```
*`setup-symlink.sh` idempotently links `{project-root}` to `~/.gemini/config/plugins/codeloop`.*

### 3. Register with OpenCode (`opencode`)
Install the OpenCode skill (`~/.config/opencode/skills/codeloop/SKILL.md`) and idempotently register the `/codeloop` slash command in `opencode.json` / `opencode.jsonc`:
```bash
codeloop opencode install
```

### 4. Install or Update the Critique CLI (Tier 1 Review)
```bash
codeloop critique install
codeloop critique status
```

---

## 🚀 Operational Modes & CLI Reference

### Initialize Any Target Repository
```bash
# Interactive setup: detects ecosystems, workspaces, test/lint/smoke profiles, and updates .gitignore
codeloop init

# Non-interactive / preview modes
codeloop init --yes
codeloop init --dry-run --json
```

### End-to-End Lifecycle Commands
```bash
# Standard interactive lifecycle (pauses at [APPROVAL] and [COMMIT] human gates)
codeloop --issue 320

# Plan-only mode: scaffolds artifacts/plans/<id>-<slug>/ and parks at [PLAN] (or [DISCOVERY] for bugs)
codeloop plan --issue 320

# Resume implementation from an approved plan inside an isolated .worktrees/<id> checkout
codeloop implement --issue 320

# Unattended fast-path: auto-approves plan gate and runs quality gates + Tier 1 review
codeloop yolo --issue 320

# Full hands-off delivery: plan -> implement -> gates -> review -> commit -> open PR
codeloop yolo --issue 320 --commit-after

# Commit, push task branch, and open PR targeting the collector/base branch
codeloop commit --issue 320 --create-pr
```
*(Inside Antigravity or OpenCode chat sessions, invoke `/codeloop`, `/codeloop plan`, `/codeloop implement`, or `/codeloop yolo`.)*

### Subagent Orchestration & Governance Commands

| Command | Purpose |
|---|---|
| `codeloop next [--issue <n>] [--json]` | Inspect state and emit the next `invoke_subagent` payload (`actionable`, `actionType`, `pause`) |
| `codeloop status [--issue <n>] [--json]` | Render multi-task status matrix, active worktrees, PR delivery state, and gate pauses |
| `codeloop branch-info [--issue <n>] [--json]` | Read-only inspection of base collector branch, task branch, and PR target |
| `codeloop transition <STAGE> [--issue <n>]` | Advance or walk back the state machine across legal stage transitions |
| `codeloop gate-report --issue <n> --report-file <f>` | File a Quality Gate subagent's `GATE_REPORT_JSON` evidence block (`--report-stdin` supported) |
| `codeloop review --issue <n> [--verdict-file <f>]` | File Reviewer `AC_EVIDENCE` verdict, cross-check `--critique-report`, or `--refute` false positives |
| `codeloop deviation --issue <n> [...]` | File (`--deviation-file`), list, or acknowledge (`--ack <id> --reason <text>`) plan deviations |
| `codeloop triage [action] [--issue <n>]` | Inspect PR comments or route via `implement`, `plan`, `discovery`, `completed`, or `dismiss -m "<notes>"` |
| `codeloop sync [--dry-run]` | Fast-forward collector branch and reconcile/auto-close issues for merged collector PRs |
| `codeloop release [branch] [--dry-run]` | Compile deliverable changelog and open a SemVer-labeled (`release:*`) PR to `main` |
| `codeloop worktree [list\|clean\|prune\|remove <id>]` | Manage isolated `.worktrees/<id>` checkouts (`--prune-stale`, `--subagents`, `--all`) |
| `codeloop resume [--issue <n>]` | Clear a persisted gate pause (e.g. `CIRCUIT_BREAKER`) and bank human/quota wait duration |
| `codeloop halt --reason quota [--issue <n>]` | Record an external HTTP `429` / quota exhaustion at `CIRCUIT_BREAKER` and exit with code `2` |
| `codeloop abort [--issue <n>] [--quarantine]` | Emergency stop: terminate subagents, clear locks, and quarantine dirty task worktrees |
| `codeloop reset [--issue <n> \| --all]` | Reset a specific task checkpoint or clear workspace checkpoints |
| `codeloop config` / `codeloop models` / `codeloop prompt [role]` | Inspect resolved configuration, Gemini/OpenCode model mappings, and role tool whitelists |

### Dual-Branch Collector PRs & Closing Keyword Semantics

`codeloop` routes phase and feature work through a two-tier branch topology (`main` $\leftarrow$ `phase/*` or `feature/*` collector $\leftarrow$ `task/<id>-<slug>` or `fix/<id>-<slug>`).

- **Delivery Requires a Merged PR**: Running `codeloop commit` without `--create-pr` pushes the branch and prints the exact `gh pr create …` command, leaving the run undelivered until that PR is opened and merged. Passing `--create-pr` (implied automatically by `--commit-after`) opens the PR directly with sanitized descriptions, milestone metadata, and `Closes #<id>`.
- **Collector-Branch `Closes #N` Behavior**: A PR that targets a collector branch (`phase/*` / `feature/*`) is not a default-branch PR. GitHub's documented **closing keyword** rule (`Closes #N`) covers the default branch only, and collector-branch merges do not consistently auto-close issues across GitHub workflows (some collector merges auto-close immediately, while others remain open). `codeloop commit` therefore states the measured base — a collector branch, not the default branch — and prints conditional guidance: if `Closes #N` does not close the issue on merge, run `codeloop sync` to close it.
- **Automatic `TRIAGE` Exit**: Once an associated PR is merged or closed on GitHub, `codeloop next` automatically transitions `TRIAGE` $\rightarrow$ `COMPLETED` and reports idle without requiring a manual `codeloop resume`.

### Strict `--issue` Resolution & Exit Codes

- **Strict Positive-Integer `--issue`**: `--issue <num>` accepts digits only (with an optional `#` prefix, e.g. `--issue 250` or `--issue #250`). Malformed tokens such as `--issue 999abc` fail closed with exit code `1` before reading or mutating any checkpoint. Every stateful command resolves the same authoritative task checkpoint (`.agyloop/tasks/<n>.json`), preventing cross-task or root-checkpoint bleed; use `--workspace <dir>` to target another repository root explicitly.
- **Process Exit Codes**:
  - `0` — Success.
  - `1` — Gate failure, review `CHANGES_REQUESTED`, validation refusal, or usage error.
  - `2` — Recoverable provider quota exhaustion (`HTTP 429` / `RESOURCE_EXHAUSTED`). State is safely checkpointed at `CIRCUIT_BREAKER`; run `codeloop resume` once the quota window resets.

---

## ⚡ Configuration, Model Routing & Circuit Breakers

Running `codeloop init` scaffolds `.codeloop/config.json` (and seamlessly migrates legacy `.agyloop/config.json` or `.agyloop.json` files):

```json
{
  "$schema": "https://antigravity.google/schemas/v1/agyloop.json",
  "runner": "auto",
  "opencode": {
    "model": "ollama/ornith:9b-128k"
  },
  "models": {
    "planner": "pro",
    "implementer": "inherit",
    "gate": "flash_lite",
    "reviewer": "flash"
  },
  "options": {
    "commitAfter": false,
    "gateTimeoutSeconds": 300,
    "autoApproveInYolo": true,
    "enableMcpInPlanner": true
  },
  "circuitBreakers": {
    "maxTurnsPerSubagent": 15,
    "maxGateRetries": 3,
    "maxConcurrentSubagents": 4,
    "maxWallClockDurationSeconds": 900,
    "tokenBudgetThreshold": 150000,
    "actionOnTrip": "pause_for_human"
  }
}
```

| Subagent Role | Default Model Tier | Primary Responsibility |
|---|---|---|
| **`discovery`** | `pro` / `inherit` | Empirical bug reproduction and structured Root Cause Analysis (RCA) |
| **`planner`** | `pro` / `inherit` | Read-only architectural design, Test Register authoring, and smoke protocol specs |
| **`implementer`** | `inherit` / `flash` | Scoped code changes and refactoring inside isolated `.worktrees/<id>` |
| **`gate`** | `flash_lite` | Fast build, lint, typecheck, test suite, and containerized `act` execution |
| **`reviewer`** | `flash` / `pro` | Two-tier `critique` correlation and `AC_EVIDENCE` acceptance criteria verification |
| **`triage`** | `inherit` | PR review thread & conversation comment classification and lifecycle routing |

---

## 📂 Persistent Workspace Layout

```text
<project-root>/
├── .codeloop/
│   └── config.json                         # Tracked project & verification profile (from `codeloop init`)
├── .agyloop/                               # Gitignored runtime checkpoints (symlinked safely in worktrees)
│   ├── state.json                          # Root workspace checkpoint
│   └── tasks/<issue>.json                  # Isolated per-issue state machine checkpoints
├── .worktrees/
│   └── <issue>/                            # Isolated task branch checkout (`task/<id>-*` or `fix/<id>-*`)
└── artifacts/plans/<issue>-<slug>/         # Gitignored persistent task specifications & telemetry
    ├── [Discovery] - {Title}.md            # Empirical RCA report (bug/defect workflows)
    ├── implementation_plan.md              # Approved technical plan (frozen by SHA-256 digest)
    └── CodeLoop Summary.md                 # Cumulative stage timings, dispatch counts, and gate metrics
```

---

## 🛠️ Troubleshooting

1. **Check Antigravity Plugin Symlink**:
   Ensure `~/.gemini/config/plugins/codeloop` resolves to your `codeloop` checkout and passes verification:
   ```bash
   ls -la ~/.gemini/config/plugins/codeloop
   ./bin/verify-install.sh
   ```
2. **Stale Build Refusal (`stale-dist`)**:
   If `codeloop` refuses to run after pulling new TypeScript commits in a development checkout of `codeloop` itself, rebuild `dist/` and refresh the build stamp:
   ```bash
   npm run build
   ```
3. **Plugin Enabled State**:
   Confirm `codeloop` is enabled in `~/.gemini/antigravity-cli/config.json` (and reload your Antigravity window or OpenCode session after first install):
   ```json
   {
     "plugins": {
       "codeloop": { "enabled": true }
     }
   }
   ```

---

## 🗺️ Roadmap & Tracking

Track ongoing development in [ajxcodes/projects](https://github.com/ajxcodes/projects):
- **Parent Epic**: [#47 — CodeLoop: Multi-Subagent Development Lifecycle Orchestrator](https://github.com/ajxcodes/projects/issues/47)
- **Project Board**: [GitHub Project #9 (CodeLoop)](https://github.com/users/ajxcodes/projects/9)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Copyright (c) 2026 Alvin Jorrel Pascual ([ajxcodes](https://github.com/ajxcodes)).

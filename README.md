# AgyLoop (`agyloop`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Google Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin%20v2-purple.svg)](https://github.com/ajxcodes/agyloop)
[![Project Tracking](https://img.shields.io/badge/Roadmap-ajxcodes%2Fprojects%2347-brightgreen.svg)](https://github.com/ajxcodes/projects/issues/47)

> **Multi-Subagent Development Lifecycle Orchestrator for Google Antigravity (`agy`)**

`agyloop` transforms autonomous coding agents from single-prompt chat assistants into a disciplined, context-isolated pair-programming pipeline:

$$\text{Context} \longrightarrow \text{Plan} \longrightarrow \text{Approve} \longrightarrow \text{Implement} \longrightarrow \text{Quality Gate} \longrightarrow \text{AI Review} \longrightarrow \text{Commit}$$

---

## 🎯 The Problem

1. **Context Saturation & Token Degradation**: Cramming deep repository exploration, file editing, build logs, and unit test runs into one conversational context bloats tokens, degrades reasoning, and risks hallucinations.
2. **Ephemeral Memory**: Native agent planning files live in session-ephemeral directories (`brain/`) and are discarded across branch switches, IDE reloads, or multi-day tasks.
3. **One-Size-Fits-All Models**: Running high-reasoning flagship models for simple test log parsing wastes quota, while underpowered models fail at architectural design.
4. **Unverified & Silent Commits**: Autonomous agents frequently commit modifications without executing local test suites, static analysis, or seeking explicit user sign-off.

---

## 🏗️ Architecture & Lifecycle Contract

`agyloop` introduces a phased state machine coordinated across specialized, context-isolated subagents:

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
│      `artifacts/plans/AgyLoop Summary.md`              │
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
│      `TEST_COUNT: X passed, 0 failed`                  │
└────────────────────────┬───────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 5. Two-Tier Reviewer Subagent                          │
│    • Executes CLI diagnostics: `ai-reviewer`           │
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

---

## ⚡ Configurable Model Routing

Optimize latency, reasoning capability, and quota usage by assigning appropriate models per stage in `config.json`:

| Subagent Role | Default Model Tier | Primary Purpose |
|---|---|---|
| **`planner`** | `pro` / `inherit` | Architectural reasoning, deep inspection, edge-case analysis |
| **`implementer`** | `inherit` / `flash` | Focused code generation and refactoring from plan |
| **`gate`** | `flash_lite` | Fast, cheap build/test script execution and log parsing |
| **`reviewer`** | `flash` / `pro` | Standards compliance and acceptance criteria validation |

---

## 🚀 Operational Modes & Commands

```bash
# Full lifecycle with human approval gates (Plan -> Stop -> Implement -> Gate -> Review -> Commit)
/agyloop

# Plan-only mode: generates persistent tech spec in artifacts/plans/ and hard-stops for review
/agyloop plan

# Resumes implementation directly from an approved plan
/agyloop implement

# Runs isolated quality gate and AI review diagnostics on current working diff
/agyloop gates

# Fast-path / unattended mode: auto-approves plan gate & infers defaults while keeping quality gates
/agyloop yolo

# Automatically commit if all quality gates and reviews pass green
/agyloop --commit-after

# 100% end-to-end autonomous execution (Issue -> Plan -> Implement -> Gates -> Review -> Commit)
/agyloop yolo --commit-after
```

---

## 📂 Persistent `artifacts/plans/`

All plans and run summaries live in a gitignored `{project-root}/artifacts/plans/` directory:
- `[Discovery] - {Title}.md`: Root-cause investigation and reproduction commands for bugs.
- `[Implementation] - {Title}.md`: Detailed design specification and step-by-step technical plan.
- `AgyLoop Summary.md`: Cumulative execution log tracking subagent runtimes, quality gate verdicts, and model tiers.

Plans remain persistent across IDE reloads, branch changes, and multi-day tasks without polluting your Git commit history.

---

## 🗺️ Roadmap & Tracking

Track the development of `agyloop` in the central [ajxcodes/projects](https://github.com/ajxcodes/projects) management board:
- **Parent Epic**: [#47 - [Epic] AgyLoop: Multi-Subagent Development Lifecycle Orchestrator for Antigravity](https://github.com/ajxcodes/projects/issues/47)
- **Project Board**: [GitHub Project #9 (AgyLoop)](https://github.com/users/ajxcodes/projects/9)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Copyright (c) 2026 ajxcodes.

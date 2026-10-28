---
name: codeloop
description: >-
  Multi-subagent development lifecycle orchestrator for OpenCode.
  Coordinates Context Discovery -> Planning -> Approval -> Implementation -> Quality Gates -> AI Review -> Conventional Commit.
  Trigger whenever the user types /codeloop, /codeloop plan, /codeloop implement, /codeloop yolo, or requests to run the CodeLoop development pipeline.
metadata:
  opencode/slash: "true"
---

# CodeLoop Orchestrator Skill for OpenCode

`codeloop` orchestrates autonomous pair programming across specialized, context-isolated subagents to prevent token degradation and guarantee verified, high-quality code changes in OpenCode.

## OpenCode Invocation & Commands

To advance or inspect the CodeLoop pipeline:
1. `codeloop next --json`: Inspect the current pipeline stage and get the next recommended action.
2. `codeloop plan <issue>`: Initiate discovery or architectural planning for a GitHub issue.
3. `codeloop implement`: Begin surgical code implementation inside an isolated worktree.
4. `codeloop next --json`: Invoke the gate subagent, which runs automated typechecking, linting, and test suites. (The former standalone `gates` subcommand was removed - `codeloop next` is the only entry point.)
5. `codeloop review --issue <n> --verdict-file <path>`: As the orchestrator, record the dispatched AI Reviewer Subagent's verdict (`REVIEW_STATUS: APPROVED | CHANGES_REQUESTED`) into the checkpoint. The reviewer is read-only and only emits the block; write its verdict block to a file and pass it with `--verdict-file` (or pipe it with `--verdict-stdin`). Pass `--critique-report <path|->` when a critique JSON report already exists, so the verdict is cross-checked without running the critique CLI again. `codeloop review` refuses to run inside a dispatched subagent session. `codeloop review --issue <n>` with no verdict runs the critique-based AI review instead.
6. `codeloop commit`: Draft and execute conventional commits with interactive approval. Add `--create-pr` to have the tool open the PR itself (base = the collector branch, with the sanitized body, `Closes #<id>` and the milestone). Without it the branch is pushed but the run is **not delivered**; the tool prints the single `gh pr create …` command, and delivery completes only when that PR is **merged**. `--commit-after` (including `yolo --commit-after`) implies `--create-pr`.
7. `codeloop yolo <issue>`: Run the end-to-end autonomous lifecycle pipeline.
8. `codeloop resume`: Clear a persisted gate pause and checkpoint the wait time.

## Recording a dispatched verdict

The Reviewer subagent runs read-only and only emits the verdict block. The orchestrator files it — a dispatched subagent session is refused by `codeloop review`, so the write belongs to the root session:

1. The reviewer emits the block as the **last** thing in its response:
   ```
   REVIEW_STATUS: APPROVED | CHANGES_REQUESTED
   REVIEW_SUMMARY: <summary>
   UNFULFILLED_AC:
   - <criterion> (or "None")
   REMEDIATION_GUIDANCE:
   - <action> (or "None")
   ```
2. As the orchestrator, write that block to a file and run `codeloop review --issue <n> --verdict-file <path>` (or pipe it into `codeloop review --issue <n> --verdict-stdin`).
3. `codeloop next --json` then reports the **actual** verdict at the COMMIT gate — `Review passed.` for `APPROVED`, and the pipeline reverts to `IMPLEMENT` (exit code `1`) for `CHANGES_REQUESTED`.

When the orchestrator already holds a critique JSON report — a previous `critique --json` run, or a deduped CI artifact — pass it with `codeloop review --issue <n> --verdict-file <path> --critique-report <path|->` instead of letting `review` execute the critique CLI again. That cross-checks the verdict against the already-produced report (hermetic Tier 1: no critique subprocess). Use `-` to read the report from stdin.

A verdict block that cannot be parsed is a hard failure: the review is recorded or the run fails — a `CHANGES_REQUESTED` is never silently downgraded to a skip.

## Triaging PR Review Comments

When `codeloop next --json` reports the pipeline is at the **TRIAGE** gate, dispatch the triage subagent (its prompt names the same command):

```
codeloop triage <action> --issue <id>
```

Valid actions (all five, each with its side effect):

- `implement` — routes to `IMPLEMENT` with the review comments as context.
- `plan` — routes to `PLAN` for structural plan revision.
- `discovery` — routes to `DISCOVERY` for investigative root-cause analysis.
- `completed` — records a disposition and posts nothing to the PR (the non-destructive exit).
- `dismiss` — records a disposition and replies to/resolves the PR threads using `-m "<notes>"` (writes to GitHub; without `-m` nothing is posted and the dismissal is refused). A dismissal that handles zero items records nothing and stays at `TRIAGE`; the non-destructive exit is `completed`. A thread is skipped only when the tool's own dismissal marker is present — a merely resolved thread is replied to, never skipped.

A routing action requires the checkpoint to be at the **TRIAGE** gate: run `codeloop next --json` first. List mode (`codeloop triage` with no action) is read-only and never mutates state.

## Recovering From a Gate Pause

`codeloop next --json` returns `actionable: false` plus a `pause` object (`{ gate, pausedAt, resumeCommand, message }`) when the pipeline is halted. `actionable` means "a subagent may be dispatched right now": it is `true` only for a `subagent` directive with no persisted pause. It is `false` for every human gate (COMMIT included), for a persisted pause, for `COMPLETED` and `INITIALIZED`, and for every stage whose completion condition is already met — those report `actionType: "advance"` with no `invocationPayload` and name the command to run instead. A human gate's `resumeCommand` is `null` — there is nothing to resume; run the command its message names. The most common persisted cause is a provider quota rejection (HTTP 429 / `RESOURCE_EXHAUSTED`, exit code `2`), which is checkpointed — nothing is lost.

Resolve the blocking condition, then run `codeloop resume` (accepts `--json` and `--dry-run`) **before** calling `codeloop next --json` again. `next` only *reports* a pause; `resume` is the only command that clears one, so never loop on `next` to clear it.

## Model Configuration
OpenCode subagent invocations run with `--model <model>`, defaulting to `ollama/ornith:9b-128k` (or overridden via `OPENCODE_MODEL` environment variable or `--model` CLI argument).

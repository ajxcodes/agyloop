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
5. `codeloop review --issue <n> --verdict-file <path>`: Record the dispatched AI Reviewer Subagent's verdict (`REVIEW_STATUS: APPROVED | CHANGES_REQUESTED`) into the checkpoint. Write the subagent's verdict block to a file and pass it with `--verdict-file` (or pipe it with `--verdict-stdin`). `codeloop review --issue <n>` with no verdict runs the critique-based AI review instead.
6. `codeloop commit`: Draft and execute conventional commits with interactive approval.
7. `codeloop yolo <issue>`: Run the end-to-end autonomous lifecycle pipeline.
8. `codeloop resume`: Clear a persisted gate pause and checkpoint the wait time.

## Recording a dispatched verdict

The Reviewer subagent runs read-only, so its verdict block travels back through a command:

1. The reviewer emits the block as the **last** thing in its response:
   ```
   REVIEW_STATUS: APPROVED | CHANGES_REQUESTED
   REVIEW_SUMMARY: <summary>
   UNFULFILLED_AC:
   - <criterion> (or "None")
   REMEDIATION_GUIDANCE:
   - <action> (or "None")
   ```
2. Write that block to a file and run `codeloop review --issue <n> --verdict-file <path>` (or pipe it into `codeloop review --issue <n> --verdict-stdin`).
3. `codeloop next --json` then reports the **actual** verdict at the COMMIT gate — `Review passed.` for `APPROVED`, and the pipeline reverts to `IMPLEMENT` (exit code `1`) for `CHANGES_REQUESTED`.

A verdict block that cannot be parsed is a hard failure: the review is recorded or the run fails — a `CHANGES_REQUESTED` is never silently downgraded to a skip.

## Recovering From a Gate Pause

`codeloop next --json` returns `actionable: false` plus a `pause` object (`{ gate, pausedAt, resumeCommand, message }`) when the pipeline is halted. The most common cause is a provider quota rejection (HTTP 429 / `RESOURCE_EXHAUSTED`, exit code `2`), which is checkpointed — nothing is lost.

Resolve the blocking condition, then run `codeloop resume` (accepts `--json` and `--dry-run`) **before** calling `codeloop next --json` again. `next` only *reports* a pause; `resume` is the only command that clears one, so never loop on `next` to clear it.

## Model Configuration
OpenCode subagent invocations run with `--model <model>`, defaulting to `ollama/ornith:9b-128k` (or overridden via `OPENCODE_MODEL` environment variable or `--model` CLI argument).

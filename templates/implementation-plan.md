# [Implementation] - {Title}

**Issue:** #{IssueNumber}  
**Date:** {Date}  
**Author:** AgyLoop Planning Subagent  
**Status:** DRAFT | APPROVED  

---

## 1. Context & Objectives
- **Feature Overview:**
- **Acceptance Criteria:**
- **Out of Scope:**
<!-- Name any correction deliberately NOT delivered, so the reviewer cannot count it as met. -->

## 2. Architectural Design & Impact
- **Component Breakdown:**
- **Data Flow / Model Invariants:**
- **Dependencies & Imports:**

## 3. Implementation Steps
- [ ] **Step 1:** 
- [ ] **Step 2:** 
- [ ] **Step 3:** 

### Test Register
<!-- One row per pinned assertion: `- **TR-1** — **Pins:** `path` :: `test title`` (or `**New test:**`) plus a `**Asserts:**` literal. A `Pins:` row must restate the pinned literal exactly; APPROVAL refuses a contradicting row and names `file:line`. -->

## 4. Quality Gate & Test Verification

### Quality Gate Targets
- **Target 1:**
- **Target 2:**

### Manual Smoke Test Protocol
- **Check 1:**

### Baseline Evidence

<!-- Baseline claim shape: `Declared:` must be the command's literal stdout (copy it verbatim); `Output:` must be the stdout that command printed. APPROVAL runs each command once and checks both against the fresh measurement — a `Declared:` carrying a value the command does not print is refused, and so is an `Output:` that does not match — while a prose `Declared:` is accepted only when `Output:` verifies. -->
<!-- Baseline command cwd: Baseline commands are measured in more than one directory: APPROVAL runs each command in the workspace it is invoked from (the `--workspace` root, otherwise the current directory), and IMPLEMENT runs it again in the task worktree, which is a pristine checkout with no build output because `dist/` is git-ignored. A command must therefore print the same stdout in both directories, which rules out resolving the workspace's own build output (`./dist`, `./build`) at all. Every refusal names the cwd it measured in. -->

#### <claim-id>

- **Declared:**
- **Command:**
- **Output:**

/* eslint-disable @typescript-eslint/no-unused-vars */
import { STAGE_COMMIT, STAGE_IMPLEMENT, STAGE_QUALITY_GATE, STAGE_REVIEW } from './lifecycle-stages';
import { GateSmokeCoverageRefusalParams, STATUS_FAILED, VERDICT_INPUT_SOURCE_STDIN } from './gate-verdicts';
import { BASELINE_COMMAND_CWD_CONTRACT, BASELINE_DECLARED_SHAPE_SENTENCE, HEADING_BASELINE_EVIDENCE, NEW_LIFECYCLE_COMMAND, NODE_RUNTIME_BINARY, PATH_BUNDLED_CRITIQUE_JS, PATH_SIBLING_CRITIQUE_DIR, PATH_USER_DATA_CRITIQUE_DIR, PATH_USER_DATA_CRITIQUE_MAC, PATH_USER_LOCAL_CRITIQUE, REOPEN_COMPLETED_COMMAND, ROOT_BUILD_PROHIBITION_SENTENCE, WORKTREE_GUARD_SIGNAL } from './vocabulary';
import { SMOKE_PROTOCOL_NOT_DECLARED, SMOKE_SANDBOX_MANDATE, SMOKE_SANDBOX_RECOMMENDED_PATH } from './value-objects/smoke-protocol';
import { COMMAND_CRITIQUE, COMMAND_TRANSITION, FLAG_REFUTE, TOKEN_TEST_METRICS } from './cli-contract';
import { PLAN_DEVIATION_EXAMPLE, PLAN_DEVIATION_PROSE_LABELS } from './plan-contract';
import { CRITIQUE_FLAG_JSON, CRITIQUE_JS_EXTENSION, CRITIQUE_REPORT_STDIN, CRITIQUE_SUBCOMMAND_INSTALL, CRITIQUE_SUBCOMMAND_STATUS } from './critique';
import { formatDiscoveryParkAwaitingRca } from './discovery';


export const MSG_DISPATCH_COUNTER_UNRECORDED_TEMPLATE =
  '[codeloop] Warning: could not record the {counter} dispatch counter at {path}; returning the directive unchanged.' as const;


// Transition Notes
export const NOTE_DEVELOPER_APPROVED = 'Approved by developer' as const;

export const NOTE_AUTO_APPROVED_YOLO = 'Auto-approved in YOLO mode' as const;

export const NOTE_MANUAL_TRANSITION = 'Manual CLI transition' as const;

export const NOTE_INITIATED_PLANNING = 'Initiated planning mode' as const;

export const NOTE_INITIATED_DISCOVERY_RCA = 'Initiated discovery mode for defect RCA' as const;

export const NOTE_GENERATING_SPECS = 'Generating plan specifications' as const;

export const NOTE_AWAITING_REVIEW = 'Awaiting human review' as const;

export const NOTE_MANUAL_GATES_RUN = 'Manual gates run' as const;

export const NOTE_EXECUTING_GATES = 'Executing quality gates' as const;

export const NOTE_GATES_PASSED = 'Quality gates passed successfully' as const;

export const NOTE_GATES_FAILED = 'Quality gates failed' as const;

export const NOTE_EXECUTING_REVIEW = 'Executing AI review' as const;

export const NOTE_REVIEW_APPROVED = 'AI review approved: Code changes verified' as const;

export const NOTE_REVIEW_CHANGES_REQUESTED = 'AI review requested changes: Reverting to IMPLEMENT' as const;

export const NOTE_REVIEW_SKIPPED = 'AI review skipped: No reviewer output or critique report — proceeding without review' as const;

export const NOTE_REOPEN_IMPLEMENTATION_COMPLETED = 'Reopening implementation from completed stage to address review findings' as const;

export const NOTE_RERUN_GATES_COMPLETED = 'Re-executing quality gates from completed stage' as const;

export const NOTE_IMPLICIT_APPROVAL = 'Implicitly approved by explicit implementation request' as const;


/**
 * The ONE sentence the IMPLEMENT and QUALITY_GATE dispatches render verbatim
 * (issue #405, D1). Keeping it a single constant is what makes prompt parity
 * mechanical instead of aspirational.
 */
export const NOTE_WORKTREE_GUARD_ESCAPE_HATCH =
  `This worktree is the code under test, and the cross-worktree state guard's documented escape hatch is the tool-owned \`${WORKTREE_GUARD_SIGNAL}\`. Run a check that seeds a foreign fixture with \`${WORKTREE_GUARD_SIGNAL}=1\` prefixed to the command; do not substitute another variable, because the gate uses this same escape hatch. Never use a variable that the test runner itself interprets: Node's runner skips every test file and exits 0 when its nested-run marker is set.` as const;


/**
 * The planner-side counterpart (issue #405, AC-3): a foreign fixture issue is
 * allowed, but only when the CHECK carries the documented signal. The gate runs
 * `SmokeProtocol.toScript()`, which emits the check bodies only — a signal
 * stated in preamble prose is never applied.
 */
export const NOTE_SMOKE_FIXTURE_ISSUE_RULE =
  `A check that seeds a fixture issue number other than the worktree's issue is refused by the cross-worktree state guard unless the check itself carries the documented state-guard escape hatch (for example \`${WORKTREE_GUARD_SIGNAL}=1 node bin/codeloop.js …\`): the gate executes the frozen checks as a script, so a signal stated only in prose is never applied. State the escape hatch inside the check, or use the worktree's own issue number.` as const;


export const MSG_PLAN_MODIFIED_AFTER_APPROVAL =
  'The approved plan changed after approval: {path}. Expected digest {expected}, found {actual}. Restore the approved plan or re-run planning and approval (PLAN -> APPROVAL -> IMPLEMENT).' as const;

export const MSG_PLAN_MODIFIED_DURING_GATE =
  'The approved plan changed during the quality gate: {path}. Expected digest {expected}, found {actual}. A gate cannot certify an artifact it did not execute.' as const;

export const MSG_PLAN_APPROVED_MISSING =
  'The approved plan is missing or unreadable: {path}. Expected digest {expected}. Restore the approved plan before re-running the gate.' as const;

export const MSG_SMOKE_PROTOCOL_NOT_EXECUTABLE =
  'Manual Smoke Test Protocol is not executable: check "{check}" at plan line {line} violates rule "{rule}": {excerpt}' as const;

export const MSG_SMOKE_PROTOCOL_FAILED =
  'Manual Smoke Test Protocol failed at check "{check}" (plan line {line}){detail}.' as const;

export const MSG_SMOKE_PROTOCOL_NO_CHECKS =
  'Manual Smoke Test Protocol declared no executable check; a zero-check protocol cannot pass the gate.' as const;


/**
 * Plan-baseline contract messages (issue #388). A declared baseline that was
 * never measured travels through APPROVAL as normative; the first actor asked
 * to satisfy it is the implementer. These templates name the measured value so
 * the plan can be corrected before it becomes an instruction.
 */
export const MSG_PLAN_BASELINE_EVIDENCE_MISSING =
  `Plan baseline evidence is missing or unbacked: {detail}. Add a \`### ${HEADING_BASELINE_EVIDENCE}\` section with one \`#### <claim-id>\` per declared number, carrying \`- **Declared:**\`, \`- **Command:**\` and \`- **Output:**\`. A plan that claims its baselines were reproduced must carry the command and output that produced each number.` as const;

export const MSG_PLAN_BASELINE_INCOMPLETE =
  'Plan baseline claim "{claim}" at plan line {line} is incomplete: {detail}. Every claim needs the declared value, the command that measures it and the output that command printed.' as const;

export const MSG_PLAN_BASELINE_COMMAND_FAILED =
  'Plan baseline claim "{claim}" at plan line {line} could not be measured with cwd={cwd}: the command `{command}` {detail}. A baseline that cannot be reproduced cannot be approved; fix the command or remove the claim.' as const;


export const MSG_PLAN_BASELINE_MISMATCH =
  `Plan baseline claim "{claim}" at plan line {line} declares {declared}, but the command measured {measured} with cwd={cwd}: \`{command}\`. ${BASELINE_DECLARED_SHAPE_SENTENCE} Copy the measured stdout into both labels, or change the command so it prints the declared value, then re-run approval.` as const;

export const MSG_PLAN_BASELINE_OUTPUT_MISMATCH =
  `Plan baseline claim "{claim}" at plan line {line} declares {declared} and attests Output {output}, but the command measured {measured} with cwd={cwd}: \`{command}\`. ${BASELINE_DECLARED_SHAPE_SENTENCE} Copy the measured stdout into both labels and re-run approval.` as const;

export const MSG_PLAN_BASELINE_ROOT_BUILD =
  `Plan baseline claim "{claim}" at plan line {line} runs a build-like command \`{command}\` (matched: {match}). ${ROOT_BUILD_PROHIBITION_SENTENCE} Baseline commands are refused before anything runs; measure the same value without rebuilding the root, for example compile into a scratch out-dir outside the workspace with \`npx tsc --outDir "$HOME/.cache/codeloop/baseline-<issue>/dist"\` and require() the compiled module from there.` as const;

export const MSG_PLAN_BASELINE_WORKSPACE_BUILD_OUTPUT =
  `Plan baseline claim "{claim}" at plan line {line} resolves the workspace's build output ({match}) in \`{command}\` (cwd={cwd}; nothing was executed). ${BASELINE_COMMAND_CWD_CONTRACT} Measure the same value without workspace build output — compile into a scratch out-dir outside the workspace with \`npx tsc --outDir "$HOME/.cache/codeloop/baseline-<issue>/dist"\` and require() the compiled module from there — then re-run approval.` as const;

export const MSG_PLAN_BASELINE_BODY_MISMATCH =
  'Plan baseline claim "{claim}" at plan line {line} is restated in the plan body as {restated}, but its evidence declares {declared}: {excerpt}. The body and the evidence must state the same value; correct one of them and re-run approval.' as const;

export const MSG_GATE_LINT_MISSING =
  'Lint is mandatory for this Node project, but no resolved gate command is a lint command.' as const;

/**
 * A gate target that ASSERTS a committed-tree invariant can never pass: the
 * gate runs in the task worktree against the UNCOMMITTED change, BEFORE the
 * commit gate (issue #348, narrowed by #369). Listing forms (`git diff`,
 * `git diff --stat`, `git status --porcelain`) exit 0 there and are allowed.
 * ONE template for every enforcement point.
 */
export const MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION =
  'Plan Quality Gate Target {index} at plan line {line} is a committed-tree assertion that can never pass: `{command}`. Gate commands run in the task worktree against the UNCOMMITTED change, before `codeloop commit`, so an assertion that the worktree or the index matches HEAD (`git diff --exit-code`, `git diff --quiet`, `git diff HEAD --exit-code`, also behind a shell wrapper such as `bash -c`) always sees the change under test. Listing forms (`git diff`, `git diff --stat`, `git diff --check`, `git status --porcelain`) exit 0 on that dirty tree and are allowed. Move the invariant to CI, or express it in a script the gate can run (`bash scripts/<name>.sh`) that snapshots the pre-state and compares after. Nothing was staged and nothing was committed.' as const;


/**
 * A declared verification entry the parser could not turn into an executable
 * command. It is REFUSED, never silently dropped (#369, was #372).
 */
export const MSG_GATE_TARGET_UNEXECUTABLE_ENTRY =
  'Plan Quality Gate Target at plan line {line} was NOT silently dropped, but it cannot be executed as approved: `{command}` (reason: {detail}). Every declared verification entry must be a single runnable command. Put it in a fenced `bash` block, use a known runner or a path-like binary (for example `./scripts/check.sh`), and remove the separators this parser refuses: `;`, `|`, backticks and `$(`. `&&` chains are split into one target each automatically — do not rewrite them. Nothing was staged and nothing was committed.' as const;


/**
 * The change under test touches workflows, but the composed command list has no
 * workflow linter (#369, was #368). Plan targets replace the act container gate,
 * so the linter must be composed or the gate must refuse.
 */
export const MSG_GATE_TARGET_WORKFLOW_LINT_MISSING =
  'The change under test touches workflow files ({detail}), but the approved plan targets declare no workflow linter. Declaring targets replaces the act container gate, so a workflow edit additionally requires `{command}` (or `act -j <job>`): no local lint target can see a workflow schema error, and CI rejects it. Add `{command}` to the plan Quality Gate Targets, or remove the workflow edit from this change.' as const;


/** Why a required workflow-lint composition could not resolve a command (#369). */
export const MSG_WORKFLOW_LINT_UNAVAILABLE =
  'no workflow linter could be resolved: `act` is unavailable or has no usable container runtime, and `actionlint` is not installed. Install one of them, or declare `actionlint` explicitly in the plan Quality Gate Targets.' as const;

export const MSG_NO_FAILURES = 'All verification commands passed without failures.' as const;

export const MSG_COMMAND_FAILED_NO_OUTPUT = 'Command failed without output.' as const;


/**
 * The sandbox rule for blocks the PLANNER authors into the plan's
 * Manual Smoke Test Protocol (issue #359). The self-directed
 * SMOKE_SANDBOX_MANDATE above governs the subagent's OWN execution;
 * this note governs the fenced checks the gate will run later.
 */
export const NOTE_SMOKE_BLOCK_SANDBOX_RULE =
  `Every state-mutating check (one that invokes the \`codeloop\` CLI) must create its sandbox under \`${SMOKE_SANDBOX_RECOMMENDED_PATH}\`, and must cd into that sandbox before the first CLI invocation — or pass \`--workspace\` resolving inside it. A \`mktemp -d\` under \`/tmp\`, any sandbox outside that root, or a block that names a sandbox without entering it is refused by the state guard and rejected at dispatch. A block that declares no sandbox at all and runs the CLI outside every recognised sandbox is refused with rule \`sandbox-missing\`.` as const;


/**
 * The one prohibition shared by the implementer directive and the planner
 * surface (issue #388, was #386): the frozen protocol belongs to the GATE.
 * The implementer may RUN it when the directive carries it, but an implementer
 * that invents or claims smoke results is reporting evidence it does not own.
 */
export const NOTE_IMPLEMENTER_SMOKE_OWNERSHIP =
  'Do not claim smoke results; the gate owns the protocol.' as const;



export const MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE = 'Test suite is forbidden from mutating the root orchestrator state.' as const;


/** Warned when the dispatch-time baseline could not be captured. */
export const MSG_DISCOVERY_BASELINE_UNRECORDED =
  'Discovery boundary baseline unrecorded: a write outside the plan directory will not be measured for this dispatch.' as const;

/**
 * A first-run `plan --issue <n>` whose label lookup failed AND whose title
 * carries no bug marker cannot infer the kind (#382, D4). Refusing is the
 * explicit alternative to the silent skip of DISCOVERY.
 */
export const MSG_PLAN_ISSUE_KIND_LABELS_UNAVAILABLE =
  'Issue labels for #{issue} could not be read, so the issue kind cannot be inferred: the resolved title carries no bug marker. Refusing to default to an implementation plan and silently skip DISCOVERY. Pass `--type discovery` to run RCA, `--type implementation` to plan directly, or `--skip-discovery` to bypass RCA explicitly.' as const;

/** Recorded when the kind was inferred from a title because labels were unreadable (#382). */
export const NOTE_PLAN_LABELS_UNAVAILABLE =
  'Issue labels could not be read, so the issue kind came from the title fallback (kind: {kind}). Pass `--type discovery` or `--type implementation` to override the inference.' as const;


/** The refusal every malformed block carries (issue #451, AC2). */
export const MSG_PLAN_DEVIATION_SHAPE =
  `expected a JSON object with all four keys: "planSection", "planLiteral", "implementedAssertion", "reason" ` +
  `(optional "files": ["path:line"]). ${PLAN_DEVIATION_PROSE_LABELS} are also accepted. ` +
  `Accepted shape:\n${PLAN_DEVIATION_EXAMPLE}`;

export const MSG_NO_DIFF_FOUND = 'No diff found. Exiting.' as const;

export const MSG_CLEAN_DIFF_REVIEW = 'No uncommitted changes or working tree diff found.' as const;

export const MSG_NO_ISSUES_FOUND = '*No issues found! Great job!* 🚀' as const;

export const MSG_CRITIQUE_NOT_FOUND =
  'Critique CLI binary not found. Please install critique or place it on PATH, ~/.local/bin, or as sibling ../critique.' as const;


/**
 * Tier 1 guidance when the critique binary cannot be resolved (issue #314).
 *
 * The prompt used to quote `~/.local/bin/critique`, but `codeloop critique
 * install` writes to the platform user-data directory, so the quoted command
 * was dead on every installer-managed host. The unresolved render therefore
 * names the resolver and the locations it actually searches instead of
 * inventing a path.
 *
 * Every line but the last ends with a newline; the prompt builder appends the
 * final `\n` itself.
 */
export const NOTE_CRITIQUE_TIER_ONE_UNRESOLVED =
  `   \`\`\`bash\n` +
  `   codeloop ${COMMAND_CRITIQUE} ${CRITIQUE_SUBCOMMAND_STATUS} ${CRITIQUE_FLAG_JSON}\n` +
  `   \`\`\`\n` +
  `   - The critique binary could not be resolved for this workspace, so no path is quoted here. Do NOT guess one and do NOT report Tier 1 as passed.\n` +
  `   - Read \`resolution.path\` from that payload, then run that exact path with \`${CRITIQUE_FLAG_JSON}\` (prefix \`${NODE_RUNTIME_BINARY}\` when it ends in \`${CRITIQUE_JS_EXTENSION}\`).\n` +
  `   - The resolver searches, in order: sibling \`${PATH_SIBLING_CRITIQUE_DIR}/${PATH_BUNDLED_CRITIQUE_JS}\`, bundled \`${PATH_BUNDLED_CRITIQUE_JS}\`, the user-data directory (\`$XDG_DATA_HOME/critique\` or \`~/${PATH_USER_DATA_CRITIQUE_DIR}\` on Linux, \`~/${PATH_USER_DATA_CRITIQUE_MAC}\` on macOS, \`%LOCALAPPDATA%/critique\` on Windows), \`~/${PATH_USER_LOCAL_CRITIQUE}\`, then \`$PATH\`.\n` +
  `   - If the payload reports no path, tell the operator to run \`codeloop ${COMMAND_CRITIQUE} ${CRITIQUE_SUBCOMMAND_INSTALL}\` and record Tier 1 as unavailable — never as a pass.`;

export const NOTE_COMMIT_CONFIRMED = 'Commit confirmed and executed' as const;

export const NOTE_COMMIT_SKIPPED = 'Commit skipped by user' as const;

export const NOTE_COMMIT_AUTO_APPROVED = 'Commit auto-approved' as const;

export const NOTE_COMMIT_REJECTED = 'Commit rejected by user' as const;


export const NOTE_LIFECYCLE_STARTED = 'Lifecycle execution started' as const;

export const NOTE_LIFECYCLE_COMPLETED = 'Lifecycle completed successfully' as const;

export const NOTE_PAUSED_APPROVAL_GATE = 'Paused at plan approval gate' as const;

export const NOTE_PAUSED_COMMIT_GATE = 'Paused at conventional commit gate' as const;

export const NOTE_PAUSED_TRIAGE_GATE = 'Paused at PR review comments triage gate' as const;

export const NOTE_YOLO_PARKED_AT_DISCOVERY =
  'Bug issue parked at DISCOVERY for RCA — YOLO cannot dispatch subagents inline. Run `codeloop next` to dispatch the discovery subagent, then re-run `codeloop yolo`. State is checkpointed; nothing is lost.' as const;

/**
 * Appended to a park note ONLY when the checkpoint records a pause (issue #315,
 * AC-9 / Defect G.8).
 *
 * The old parenthetical ("`codeloop resume` first if a pause is recorded") was
 * unconditional, so every parked operator was told to resume at a park where
 * `next --json` reports `pause: null` — advice the checkpoint could not honour.
 * The caller knows whether a pause exists; the note must not guess.
 */
export const NOTE_RESUME_FIRST_WHEN_PAUSED =
  'A pause is recorded; run `codeloop resume` first.' as const;

/**
 * Re-entry park (issue #237): distinct from NOTE_YOLO_PARKED_AT_DISCOVERY because
 * the operator DID re-run after the park, so the outstanding work is the RCA
 * report itself rather than "dispatch the discovery subagent".
 *
 * Reworded for issue #306: the message no longer claims a populated report "is
 * still an unpopulated scaffold" (false, and it named nothing missing). It now
 * says the report lacks RCA evidence, and `formatDiscoveryParkAwaitingRca`
 * appends WHICH evidence is missing and which files were read.
 */
export const NOTE_DISCOVERY_PARK_AWAITING_RCA =
  'Parked at DISCOVERY for RCA: the discovery report does not yet contain RCA evidence. Run `codeloop next` to dispatch the discovery subagent, populate the report, then run `codeloop plan --issue <n>`. Pass `--skip-discovery` to bypass the RCA gate explicitly. State is checkpointed; nothing is lost.' as const;

/**
 * The park headline for a report rejected by the KIND gate (its first line is
 * not the scaffold title), issue #320's message half + #339 item 3.
 *
 * Distinct from `NOTE_DISCOVERY_PARK_AWAITING_RCA` on purpose: a file rejected
 * for its TITLE has fine content, so claiming it "does not yet contain RCA
 * evidence" is false — and the operator would bisect the wrong thing. The
 * `{firstLine}` slot names the discriminator the gate actually saw, so the two
 * rejection reasons are distinguishable at the headline.
 */
export const NOTE_DISCOVERY_PARK_KIND_MISMATCH =
  'Parked at DISCOVERY for RCA: the discovery report\'s first line must be the `# [Discovery] - …` scaffold title (found: \'{firstLine}\'). Run `codeloop next` to dispatch the discovery subagent, fix the title (or populate an existing titled report), then run `codeloop plan --issue <n>`. Pass `--skip-discovery` to bypass the RCA gate explicitly. State is checkpointed; nothing is lost.' as const;

/**
 * Recorded in history metadata when `codeloop next --restart` re-opens a
 * COMPLETED checkpoint, so the destructive reset is auditable from `status`.
 */
export const NOTE_RESTARTED_FROM_COMPLETED =
  'Re-opened planning from a COMPLETED checkpoint (explicit --restart)' as const;

export const NOTE_TRIAGE_ROUTED = 'Triage completed: routed to target stage' as const;

/**
 * Recorded when a dispatched reviewer's verdict arrives while the pipeline
 * already rests at the COMMIT gate (issue #269).
 *
 * The commit gate is where the live defect was observed: the gate reported
 * "No AI review verdict is recorded for this task" while the reviewer was
 * holding a genuine APPROVED verdict that had no channel to reach the
 * checkpoint. The review is therefore re-opened through the legal route
 * `COMMIT -> QUALITY_GATE -> REVIEW` — the transition table is NOT widened.
 */
export const NOTE_REVIEW_REOPENED_FROM_COMMIT =
  'Review re-opened to record the dispatched Reviewer Subagent verdict' as const;

export const NOTE_AUTO_APPROVED_PLAN = 'Plan auto-approved in YOLO mode' as const;

export const NOTE_COMMIT_AFTER_EXECUTED = 'Commit automatically executed via --commit-after' as const;

export const NOTE_ALREADY_COMPLETED = 'Pipeline already completed' as const;

export const NOTE_WORKTREE_CREATED = 'Isolated git worktree provisioned' as const;

export const NOTE_WORKTREE_REMOVED = 'Isolated git worktree detached and cleaned' as const;

export const NOTE_WORKTREE_PRUNED = 'Dangling git worktrees pruned' as const;

/**
 * Removal post-condition notes (issue #282).
 *
 * `codeloop worktree remove` used to delete the directory and say nothing about
 * the checkpoint, so the tool kept advertising a worktree that was gone
 * (absorbed #273). The removal now REPORTS which of the three descriptor
 * outcomes it reached, single-sourced here so no call site invents its own
 * wording. No emoji: the CLI owns the `✓` / `✗` / `⚠` prefix.
 */
export const NOTE_WORKTREE_CHECKPOINT_CLEARED =
  'checkpoint descriptor cleared (this task no longer records a worktree)' as const;

/**
 * The same post-condition when the checkpoint that named the removed path was
 * NOT the operator's task checkpoint (e.g. a root `.agyloop/state.json` written
 * by an older build). "This task no longer records a worktree" would be a lie
 * in that case, so the scope is stated instead (#282 review).
 */
export const NOTE_WORKTREE_CHECKPOINT_CLEARED_SCOPE =
  'checkpoint descriptor cleared (a checkpoint that named the removed path no longer records it)' as const;

export const NOTE_WORKTREE_CHECKPOINT_UNCHANGED =
  'checkpoint descriptor unchanged (it did not point at the removed path)' as const;

export const NOTE_WORKTREE_CHECKPOINT_UNREADABLE =
  'checkpoint descriptor could not be read or updated, so it was left as it was' as const;

/**
 * Reported when the operator asks to repair a stale descriptor
 * (`worktree remove <id> --prune-stale`) without a live worktree directory.
 */
export const NOTE_WORKTREE_STALE_PRUNED = 'Stale worktree descriptor pruned' as const;

export const NOTE_WORKTREE_STALE_ABSENT =
  'No checkpoint recorded a worktree at the requested path' as const;

/**
 * Reported by the READ-ONLY diagnostics (`branch-info`, `next`) when a
 * checkpoint advertises a worktree whose directory is gone. Naming the
 * remediation keeps the operator from hand-editing the checkpoint — and the
 * remediation MUST be a command that actually succeeds for a missing directory,
 * which is why it carries `--prune-stale`: the plain removal correctly refuses
 * a path that does not exist (#282 AC-2, review iteration 2).
 *
 * `{id}` is substituted by the presentation layer, which knows the task token.
 */
export const NOTE_WORKTREE_STALE =
  'stale descriptor — the worktree directory does not exist; run `codeloop worktree remove {id} --prune-stale` to clear it' as const;


// ============================================================================
// Emergency Abort quarantine scope (issue #266)
// ============================================================================

/**
 * `abort` used to quarantine EVERY worktree the repository registered —
 * including other tasks' and external ones — so aborting one task emptied
 * every other task's in-flight work (#266, live #250 instance). These notes
 * single-source the reasons an operator is told about a worktree the abort did
 * NOT touch, so no call site invents its own wording.
 */
/** The checkpoint records no worktree: nothing may be quarantined. */
export const NOTE_ABORT_NO_WORKTREE_RECORDED =
  'this checkpoint records no worktree — nothing to quarantine' as const;


/** The descriptor names a path this repository does not register under `.worktrees`. */
export const NOTE_ABORT_WORKTREE_NOT_REGISTERED =
  'not a registered worktree of this repository (stale descriptor or external worktree) — left untouched' as const;


/** The descriptor names the directory the abort was invoked from. */
export const NOTE_ABORT_WORKTREE_CWD =
  'current working directory — left untouched (run `codeloop abort` from the repository root to quarantine it, or pass --no-quarantine to silence this)' as const;


/** `--no-quarantine` / `--keep-worktrees`. */
export const NOTE_ABORT_QUARANTINE_DISABLED =
  'quarantine disabled by --no-quarantine — left untouched' as const;


/** The worktree was already clean. */
export const NOTE_ABORT_WORKTREE_CLEAN = 'already clean — nothing to quarantine' as const;


/** No abort run may ever quarantine a worktree outside `<repo>/.worktrees` (AC-3). */
export const NOTE_ABORT_EXTERNAL_NEVER_QUARANTINED =
  'external worktrees are never quarantined' as const;


/** Adapter omitted the optional `quarantineWorktree` capability. */
export const NOTE_ABORT_QUARANTINE_UNSUPPORTED =
  'quarantine is not supported by this adapter' as const;


/** Report label for a worktree that recorded nothing. */
export const NOTE_ABORT_NO_WORKTREE_LABEL =
  'NONE (this checkpoint records no worktree)' as const;


// --- Missing worktree descriptor (issue #287 B / #266 D5) ---

/**
 * `next` at IMPLEMENT with `worktree: null`. `{command}` is filled by the
 * application layer, which knows the issue token.
 */
export const NOTE_WORKTREE_MISSING_REPROVISION =
  'No isolated worktree is recorded for this checkpoint, so the IMPLEMENT stage cannot dispatch a subagent. Re-provision it with `{command}` (an existing task branch is reused). If direct root execution was intended, re-run with `--no-worktree`.' as const;


/**
 * The short, honest reason a run refused to advance: nothing was implemented.
 *
 * Used in the lifecycle result message and in the operator-facing ⚠ block. It
 * is NOT written into the state-machine history — a park performs no
 * `transition()`, and history entries are only appended by `transition()`.
 */
export const NOTE_IMPLEMENTATION_EVIDENCE_MISSING =
  'Implementation produced no changes — refusing to advance to quality gates' as const;


/**
 * The full park message for the YOLO fast-path (issue #259). `{baseRef}` is
 * substituted with the reference the probe actually compared against.
 */
export const NOTE_YOLO_NO_IMPLEMENTATION =
  "Implementation produced no changes — refusing to advance to quality gates. The working tree is unchanged relative to '{baseRef}', so no implementation was detected. The YOLO fast-path prepares the implementation but cannot execute the plan (codeloop dispatches subagents, it does not run them): run `codeloop next` to dispatch the Code Implementation Subagent, then re-run `codeloop yolo`. State is checkpointed at IMPLEMENT; nothing is lost." as const;


/**
 * Continuation lines of the operator-facing park block (stderr).
 */
export const NOTE_IMPLEMENTATION_PARK_UNCHANGED =
  "Working tree is unchanged relative to '{baseRef}' — no implementation was detected." as const;

export const NOTE_IMPLEMENTATION_PARK_DISPATCH =
  'The YOLO fast-path prepares the implementation but cannot execute the plan (codeloop dispatches subagents, it does not run them).' as const;

export const NOTE_IMPLEMENTATION_PARK_NEXT =
  'Next: run `codeloop next` to dispatch the Code Implementation Subagent, then re-run `codeloop yolo`.' as const;


/**
 * The plan-empty advisory (issue #259, S10).
 *
 * `codeloop yolo` never dispatches the PLANNER either, so the fast-path's
 * plan is the tool's own blank scaffold — every heading empty, every
 * `**Step N:**` marker without a value. Dispatching the implementer with that
 * document would hand it nothing to execute, so the park says so instead.
 * `{planPath}` names the plan the implementer would have received.
 */
export const NOTE_IMPLEMENTATION_PLAN_EMPTY =
  "The plan at '{planPath}' is still the blank scaffold — the implementer would receive an empty plan" as const;


/**
 * The continuation line of the plan-empty advisory. It REPLACES
 * `NOTE_IMPLEMENTATION_PARK_NEXT` — printing both would tell the operator to
 * dispatch an implementer that has nothing to execute.
 *
 * Issue #267: the path it names must be REACHABLE. `codeloop next` now returns
 * the PLANNER directive (not the implementer) while the plan is blank, and
 * `--plan-path` can supply a plan the operator already wrote. The
 * Architectural Planning Subagent is no longer the sole, unreachable route.
 * `{issue}` is optional: the fallback text stays valid without it.
 */
export const NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT =
  'Next: run `codeloop next` to obtain the planner directive (or supply your own plan with `codeloop implement --plan-path <file>`), then re-run `codeloop next` to dispatch the Code Implementation Subagent once the plan is non-blank.' as const;


/**
 * The full park message for a YOLO run whose plan is still the blank
 * scaffold. `{baseRef}` is the reference the probe compared against and
 * `{planPath}` names the empty plan.
 *
 * Issue #267: the recovery route is named as the commands the operator can
 * actually run — `codeloop next` (planner directive) or `--plan-path`.
 */
export const NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN =
  "Implementation produced no changes — refusing to advance to quality gates. The working tree is unchanged relative to '{baseRef}', so no implementation was detected. The plan at '{planPath}' is still the blank scaffold (no implementation steps), so dispatching the implementer now would give it nothing to execute: run `codeloop next` to obtain the planner directive (or supply your own plan with `codeloop implement --plan-path <file>`), then run `codeloop next` again. State is checkpointed at IMPLEMENT; nothing is lost." as const;


/**
 * A REPEATED blank-plan park (issue #267, AC-A5).
 *
 * The second occurrence must not read identically to the first: it says how
 * many attempts have been observed, so a re-run with no intervening action is
 * visibly not progress. `{count}` is the recorded park count, `{baseRef}` the
 * probe reference and `{planPath}` the still-blank plan.
 */
export const NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN_REPEAT =
  "Implementation produced no changes — refusing to advance to quality gates (attempt {count}, the plan is STILL blank). The working tree is unchanged relative to '{baseRef}', so no implementation was detected. The plan at '{planPath}' carries no implementation steps; nothing has changed since the previous park. Run `codeloop next` to obtain the planner directive (or supply a plan with `codeloop implement --plan-path <file>`). State is checkpointed at IMPLEMENT; nothing is lost." as const;


/**
 * The CLI stderr advisory for the SECOND and later blank-plan park
 * (issue #267, AC-A5): `{planPath}` and the attempt `{count}`.
 */
export const NOTE_IMPLEMENTATION_PLAN_EMPTY_REPEAT =
  "The plan at '{planPath}' is STILL the blank scaffold (attempt {count}); no plan was written since the previous park" as const;


/**
 * The VACUOUS gate verdict line: the gates refused to certify a tree that
 * contains no implementation, so NO gate command was executed.
 */
export const MSG_GATE_VACUOUS =
  "VACUOUS — no implementation detected (working tree unchanged relative to '{baseRef}'); quality gate commands were NOT executed." as const;


/**
 * Lifecycle refusal messages for a VACUOUS gate verdict. A VACUOUS verdict is
 * NOT a failure: nothing was reverted, because the stage was never advanced.
 */
export const NOTE_GATES_VACUOUS_STANDARD =
  "Quality gates refused to certify an unimplemented tree (VACUOUS) — the working tree is unchanged relative to '{baseRef}'. Pipeline stays at IMPLEMENT." as const;

export const NOTE_GATES_VACUOUS_YOLO =
  'Quality gates refused to certify an unimplemented tree (VACUOUS) — refusing to advance.' as const;


/** The gate-report warning for an unmeasurable branch diff (issue #263). */
export const MSG_GATE_UNMEASURABLE =
  "Could not measure this branch's own changes: {error}. The implementation count above comes from 'git status' only." as const;


/** The stale-worktree advisory (issue #263). `{mergeBase}` is the short branch point. */
export const NOTE_IMPLEMENTATION_STALE_WORKTREE =
  "Stale worktree — this branch is {ahead} commit(s) behind '{baseRef}' (branch point {mergeBase}); the gate would validate a build the base branch no longer contains." as const;


/** The CLI's second line when the branch diff could not be measured (issue #263). */
export const NOTE_IMPLEMENTATION_UNMEASURABLE =
  "This branch's own changes could not be measured against '{baseRef}' ({error}) — 'git status' found no implementation, so the tree cannot be certified." as const;


/** The full YOLO park message when the branch diff could not be measured (issue #263). */
export const NOTE_YOLO_NO_IMPLEMENTATION_UNMEASURABLE =
  "Implementation produced no changes — refusing to advance to quality gates. 'git status' found no implementation and this branch's own changes could not be measured against '{baseRef}' ({error}), so the tree cannot be certified. State is checkpointed at IMPLEMENT; nothing is lost." as const;


/** Why the dismissal route had nothing to dismiss. */
export const NOTE_DISMISS_NO_NOTES = 'no dismissal notes were provided (-m "<notes>")' as const;

export const NOTE_DISMISS_NO_PR = 'no pull request was resolved for this issue' as const;

export const NOTE_DISMISS_NO_GATEWAY = 'the GitHub gateway is unavailable' as const;


/**
 * The generic reason used when a dismissal report carries no more specific
 * reason for having dismissed nothing.
 */
export const NOTE_DISMISS_NOTHING = 'nothing was dismissed' as const;


/**
 * Why a dismissal that ran answered, resolved and skipped nothing at all.
 *
 * The dismissal route may run and find no feedback to act on — for example
 * when the comment fetch failed silently and the gateway listed no threads.
 * Such a run dismissed nothing, so it must never wear the unqualified success
 * line.
 */
export const NOTE_DISMISS_NOTHING_HANDLED =
  'the dismissal ran but no review feedback was handled' as const;


/**
 * Appended to a refusal reason. A refusal is only truthful if the operator is
 * told that NOTHING was written: the phantom dismissal of #336 printed a
 * transition it never performed.
 */
export const NOTE_DISMISS_REFUSED_SUFFIX =
  ' — nothing was written and the gate stays at TRIAGE' as const;


/**
 * Why a dismissal that RAN was refused. It names the non-destructive exit so a
 * refused dismissal is never a dead end (`completed` is always legal at TRIAGE).
 */
export const NOTE_DISMISS_REFUSED_NOTHING =
  'the dismissal handled no review feedback (nothing was replied to or resolved); use `codeloop triage completed` for the non-destructive exit' as const;


/**
 * Why the inline review threads could not be dismissed: the gateway does not
 * implement the thread surface.
 */
export const MSG_DISMISS_NO_THREAD_SUPPORT =
  'the GitHub gateway cannot list or resolve review threads' as const;


/**
 * Why a PR conversation comment could not be answered: it carries no id.
 */
export const MSG_DISMISS_NO_CONVERSATION_ID =
  'the conversation comment carries no id, so it cannot be answered' as const;


/**
 * Why the PR conversation surface could not be answered: the gateway does not
 * implement it.
 */
export const MSG_DISMISS_NO_CONVERSATION_SUPPORT =
  'the GitHub gateway cannot post replies on the PR conversation surface' as const;


/**
 * Why a PR conversation comment was not answered a second time.
 */
export const NOTE_DISMISS_DUPLICATE_FEEDBACK = 'duplicate feedback' as const;


/**
 * Why a PR conversation comment was skipped: the PR's own state proves it was
 * already answered (another comment references its id, or its inline review
 * thread carries the tool's dismissal MARKER).
 *
 * The thread's resolution state is not that proof: the review bot
 * auto-resolves the threads it creates, so a resolved thread can be entirely
 * unanswered.
 */
export const NOTE_DISMISS_ALREADY_ANSWERED = 'already answered' as const;


/**
 * Why a PR conversation comment was ignored altogether: it is the tool's own
 * dismissal reply, not review feedback.
 */
export const NOTE_DISMISS_OWN_REPLY = 'own dismissal reply' as const;


/**
 * Why an unmarked conversation comment was ignored: it is a PRIOR ANSWER the
 * tool cannot attribute, so answering it would be a third reply to the same
 * feedback.
 */
export const NOTE_DISMISS_PRIOR_ANSWER = 'unmarked prior answer' as const;


/**
 * The replacement for the removed `AGY_SUBAGENT` marker guard (issue #241/R1).
 *
 * This is a DIFFERENT protection from the one it replaces: it prevents routing
 * the WRONG checkpoint, not "a root agent routing". A dispatcher cannot
 * distinguish its own root from a subagent, and pretending otherwise was the
 * defect.
 */
export const MSG_TRIAGE_ROUTING_REQUIRES_GATE =
  'Error: A triage routing action requires the checkpoint to be at the TRIAGE gate. Run `codeloop next` to reach the gate; a routing action never moves a checkpoint from any other stage.' as const;


/**
 * The history/summary note for a recorded triage disposition.
 */
export const NOTE_TRIAGE_DISPOSITION_RECORDED =
  'Triage disposition recorded: {action} (PR #{prNumber}, {count} feedback item(s) at {recordedAt})' as const;


/**
 * Why NO disposition was recorded.
 *
 * An empty key set must never masquerade as "everything was dispositioned":
 * if no feedback could be read, the tool knows nothing about what was disposed
 * of, and the next triage must see the PR afresh.
 */
export const NOTE_TRIAGE_DISPOSITION_NOT_RECORDED =
  'no triage disposition recorded — no PR review feedback could be read' as const;


/**
 * The `State Updated` counterpart of a refusal (#336): the checkpoint was NOT
 * written, so the line must say exactly that.
 */
export const NOTE_TRIAGE_STATE_UNCHANGED =
  'nothing written — the checkpoint was not changed' as const;


/**
 * The `Next Stage` counterpart of a refusal: the gate did not move, so naming a
 * target stage would be the phantom transition #336 reported.
 */
export const NOTE_TRIAGE_REFUSAL_NO_TRANSITION =
  'unchanged — the checkpoint stays at its current stage' as const;


/**
 * The disposition line of a refusal. A refused action dispositioned nothing,
 * so the operator must not be shown the "not recorded because no feedback could
 * be read" sentence — the feedback WAS read; the action was refused.
 */
export const NOTE_TRIAGE_DISPOSITION_REFUSED =
  'not recorded — the action was refused, so no feedback was dispositioned' as const;


/**
 * The dry-run prediction of a `dismiss` that MAY write (#336).
 *
 * The old literal promised "Would reply to and resolve the PR review threads"
 * even when the real run would have refused and posted nothing — a simulation
 * is only useful if it predicts the run it simulates.
 */
export const NOTE_TRIAGE_DRY_RUN_DISMISS =
  'Would attempt a dismissal of the PR review threads (a real run refuses and records nothing when it handles no feedback)' as const;



/**
 * The exit condition of the TRIAGE gate, stated in the tool's own output.
 *
 * The gate re-opens on every `codeloop next` while the PR is open, so the
 * operator must be told what ENDS it: a recorded disposition, or the PR being
 * merged/closed.
 */
export const NOTE_TRIAGE_GATE_EXIT_CONDITION =
  "This gate ends when the feedback is dispositioned (the disposition is recorded in the checkpoint) or when the PR is merged/closed: `codeloop next` then records COMPLETED and reports idle, with no `codeloop resume` needed. Until then 'codeloop next' reports this gate again." as const;


/** Rendered on the history note and on the idle report, never duplicated. */
export const NOTE_TRIAGE_GATE_ENDED_BY_PR_STATE =
  'Triage gate ended: {pr} is {state}. Open review feedback no longer needs a disposition.' as const;


/**
 * Issue #354 (item 1): a CLOSED pull request was closed WITHOUT merging, so the
 * gate ending is not a delivery. `MERGED` keeps the neutral frame above — the
 * note states the measured fact and never claims a release it cannot prove.
 */
export const NOTE_TRIAGE_GATE_ENDED_BY_PR_STATE_NOT_DELIVERED =
  'Triage gate ended: {pr} is {state}. The pull request was closed without merging, so the run was not delivered — the branch/worktree work never landed on the base branch. Open review feedback no longer needs a disposition.' as const;


/**
 * The dispatcher's instruction to the read-only gate subagent (issue #284).
 *
 * It names the filing command as the ORCHESTRATOR's action and forbids the
 * subagent from running it: `codeloop gate-report` is refused to a dispatched
 * subagent, so an instruction to run it would be a promise the guard breaks.
 */
export const NOTE_GATE_REPORT_RETURN =
  `This block is the ONLY record of this gate. Emit it verbatim as the LAST thing in your response. Do not run any \`codeloop\` command: you are a verification-only agent, and the orchestrator files this block with \`codeloop gate-report --issue <n> --report-file <path>\` and advances the checkpoint.` as const;


/**
 * What the example's `<…>` tokens and zeroes mean (issue #311), plus the two
 * definitions #325 found undefined (issue #315, AC-16/AC-17).
 *
 * Without the first paragraph, a copying subagent emits the template verbatim
 * and records "zero tests, zero milliseconds" as measured evidence. Without the
 * definitions, `testsPassed` was whatever arithmetic the agent chose — which is
 * how 86 targeted tests got added to the 1867-test suite that already ran them.
 */
export const NOTE_GATE_REPORT_EXAMPLE_PLACEHOLDERS =
  `Replace every \`<…>\` placeholder and every placeholder zero above with THIS run's measured values. The example is a shape, not evidence: emitting it verbatim records false measurements. ` +
  `\`testsPassed\` counts UNIQUE tests across the whole run: a targeted subset plus the full suite that already includes it is NOT a valid value (report the full suite's count, and keep each command in \`commandResults\` so the total can be checked). ` +
  `\`executedCommands\` holds COMMANDS only — a smoke-check result is a protocol step, not a command, and belongs in \`smokeChecks\`. ` +
  `A \`notRun\` entry in the example is a SHAPE, not a claim: emit \`[]\` when no declared gate was skipped, and one object per skipped gate. A \`smokeChecks\` entry is one protocol check; emit \`[]\` when the plan declares no protocol.`;


/**
 * The exact `smokeChecks` / `notRun` entry shapes `GateResultReport` accepts
 * (issue #338, absorbing #343).
 *
 * The parser was the only place this contract existed: a gate that followed
 * the prose invented `{check, planLine, status}` and had its whole evidence
 * block refused at filing, after the verification run was already paid for.
 */
export const NOTE_GATE_REPORT_EVIDENCE_SHAPES =
  `\`smokeChecks\` entries are OBJECTS — { "id": "<check-id>", "label": "<check label>", "passed": true }: ` +
  `\`id\` is a non-empty string (required) and for a smoke check it MUST be the canonical \`check-<n>\` id the gate prompt publishes, in plan order — ` +
  `a missing, renamed, duplicated or skipped check is a \`FAILED\` verdict, and an id this plan does not declare refuses the block; ` +
  `\`label\` is optional and defaults to \`id\`; \`passed\` is a BOOLEAN or \`null\` — ` +
  `never a status string, so "PASSED" is rejected. \`passed: null\` means "ran, no verdict reported" and is never collapsed into \`true\`. ` +
  `\`notRun\` entries are OBJECTS — { "id": "<gate-id>", "label": "<gate label>", "reason": "<why it did not run>" }: ` +
  `\`id\` and \`reason\` are non-empty strings, \`label\` is optional and defaults to \`id\`; an array of bare strings is rejected. ` +
  `Emit \`[]\` for either list when this run has no such entry — never invent a check or a skipped gate.`;


/**
 * The count declaration a count-less runner needs (issue #415).
 *
 * `go test ./...`, `ctest` and a bare `gradle test` print no counts, so the
 * parser correctly returns null and the gate cannot measure the run. The token
 * exists in the parser; this note is the first documentation of it in the
 * dispatched prompt. `TOKEN_TEST_METRICS` is interpolated so the prompt, the
 * parser and `--help` cannot drift.
 */
export const NOTE_GATE_REPORT_TEST_COUNT_TOKEN =
  `A test command that prints no count of its own (\`go test ./...\`, \`ctest\`, a bare Gradle run) must declare one: append \`${TOKEN_TEST_METRICS}: <n> passed, <n> failed, <n> skipped\` to the command output, or run a count-bearing variant (\`go test -json\`). A PASSED block whose executed test command has no measured total — \`"testsPassed": null\` — is refused at filing and again at \`transition REVIEW\`; \`"testsPassed": 0\` is refused too.` as const;


/**
 * The note `codeloop review` prints when a supplied Tier 1 report cannot be tied
 * to the reviewed base and HEAD (issue #445, AC2).
 *
 * `null` stands for "not measured" (no sidecar, unreadable sidecar, or a HEAD
 * this run could not read) and renders as `(unmeasured)` — a missing sidecar is
 * named as missing rather than left blank.
 */
export const MSG_CRITIQUE_PROVENANCE_UNBOUND =
  "Tier 1 critique was NOT verified: the report describes base '{reportBase}' at HEAD {reportHead}, but this review certifies base '{reviewedBase}' at HEAD {reviewedHead}. Recorded critiqueVerified=false — re-run the reviewer's Tier 1 command (it runs in the reviewed worktree with `--commit <base>`) and file the report beside its `.provenance.json` sidecar." as const;


/**
 * Issue #452: the sidecar named this review's base and HEAD, but the worktree
 * content changed after Tier 1 ran (HEAD does not move during REVIEW).
 */
export const MSG_CRITIQUE_PROVENANCE_DIGEST_UNBOUND =
  "Tier 1 critique was NOT verified: the report was produced against change set {reportDigest}, but the reviewed worktree is now {reviewedDigest} at the same base '{reviewedBase}' and HEAD {reviewedHead}. The worktree changed after Tier 1 ran; re-run the reviewer's Tier 1 command (it runs in the reviewed worktree with `--commit <base>`) and file the report beside its `.provenance.json` sidecar." as const;


/** Issue #452: a legacy two-field sidecar carries no change-set digest. */
export const MSG_CRITIQUE_PROVENANCE_DIGEST_MISSING =
  "Tier 1 critique was NOT verified: the provenance sidecar carries no usable change-set digest, so it cannot be tied to the worktree it describes. Recorded critiqueVerified=false — re-run the reviewer's Tier 1 command so it writes the digest beside the base and HEAD." as const;


/** Issue #452: this review could not measure the worktree digest. */
export const MSG_CRITIQUE_PROVENANCE_DIGEST_UNMEASURED =
  "Tier 1 critique was NOT verified: this review could not measure the worktree's change-set digest, so the report cannot be tied to the tree it describes. Recorded critiqueVerified=false — re-run the review once git can read the reviewed worktree." as const;


/**
 * The dispatcher's instruction to the read-only reviewer (issue #297).
 *
 * It names NO `codeloop` command on purpose: the reviewer's whole job is to
 * emit the block. `codeloop review` is refused to a dispatched subagent, so a
 * command here would be a promise the guard breaks.
 */
export const NOTE_REVIEW_VERDICT_RETURN =
  `The verdict block above is the ONLY record of this review. Emit it verbatim as the LAST thing in your response; the orchestrator files it into the checkpoint. Do not run any \`codeloop\` command — you are a read-only reviewer, and pipeline state is written by the orchestrator alone.` as const;


/**
 * The advisory printed when a verdict was recorded WITHOUT Tier 1 (issue #297).
 *
 * Applies only when a reviewer block was filed and no critique evidence was
 * available: the operator is told the verdict was not cross-checked.
 */
export const NOTE_REVIEW_CRITIQUE_NOT_VERIFIED =
  `Tier 1 critique did not run: this verdict was not cross-checked against automated findings.` as const;


/**
 * What ENDS the REVIEW gate (issue #272/AC2) — the same shape as
 * `NOTE_TRIAGE_GATE_EXIT_CONDITION`.
 */
export const NOTE_REVIEW_GATE_EXIT_CONDITION =
  "This gate ends when the verdict is filed (the checkpoint records a reviewVerdict) or when the review is intentionally abandoned. Until then 'codeloop next' reports this gate again." as const;


/** The per-read re-dispatch record: `{n}` of `{max}`. */
export const NOTE_REVIEW_DISPATCH_ORDINAL =
  'Reviewer dispatch {n} of {max} for this review round.' as const;


/** The breaker's description: it names the cap AND the way out. */
export const NOTE_REVIEW_DISPATCH_CAP =
  'The reviewer has been dispatched {max} times without a filed verdict. File the verdict with `{command}` (or abandon the review) before continuing.' as const;


export const NOTE_REVIEW_NON_ACTIONABLE_HEADER =
  '⚠ Critique reported {n} critical/error finding(s) that request no change; they are NOT counted as blocking (ambiguous findings still block):' as const;

export const NOTE_REVIEW_NON_ACTIONABLE_LINE =
  '  • {path}:{line} [{severity}/{actionability}] {body}' as const;


/** The escalation summary's clause when affirmations were exempted (issue #349). */
export const NOTE_REVIEW_IGNORED_AFFIRMATIONS =
  'Ignored {n} critical/error finding(s) that request no change.' as const;


export const NOTE_REVIEW_REFUTED_HEADER =
  '⚠ Operator refuted {n} critique finding(s); they are not counted as blocking for this verdict:' as const;

export const NOTE_REVIEW_REFUTED_LINE =
  '  • {target} [{severity}/{actionability}] {body}' as const;

export const NOTE_REVIEW_REFUTED_REASON_LINE = '    reason: {reason}' as const;


// Every refusal below is a HARD error: exit 1, nothing read into state, nothing
// recorded (`RefutationRefusedError`, raised before `stateRepo.save()`).
export const NOTE_REFUTATION_REQUIRES_VALUE =
  `✗ '${FLAG_REFUTE}' requires a value: ${FLAG_REFUTE} '<path>:<line>[#<severity>]=<reason>'. Nothing was changed; supply the refutation (or remove the flag).` as const;

export const NOTE_REFUTATION_REASON_REQUIRED =
  `✗ ${FLAG_REFUTE} requires a reason: '<path>:<line>[#<severity>]=<reason>'. A refutation without a reason is refused, and nothing was recorded.` as const;

export const NOTE_REFUTATION_MALFORMED_TARGET =
  `✗ ${FLAG_REFUTE} target is malformed: expected '<path>:<line>[#<severity>]' before the '='. Nothing was changed.` as const;

export const NOTE_REFUTATION_SCOPE =
  `✗ '${FLAG_REFUTE}' is only supported by 'review'. Remove the flag from '{command}'.` as const;

export const NOTE_REFUTATION_REQUIRES_VERDICT =
  `✗ ${FLAG_REFUTE} requires a filed reviewer verdict: pass --verdict-file (or --review-output/--verdict-stdin) so the reviewer's APPROVED verdict is on record. Nothing was recorded.` as const;

export const NOTE_REFUTATION_REQUIRES_APPROVED =
  `✗ ${FLAG_REFUTE} cannot rescue a reviewer 'CHANGES_REQUESTED': only a filed 'APPROVED' verdict can be refuted. Nothing was recorded.` as const;

export const NOTE_REFUTATION_NO_REPORT =
  `✗ ${FLAG_REFUTE} requires a critique report with a matching blocking finding: none was available this round. Nothing was recorded.` as const;

export const NOTE_REFUTATION_NO_MATCH =
  `✗ ${FLAG_REFUTE} '{target}' matches no blocking finding in the critique report. Nothing was recorded.` as const;

export const NOTE_REFUTATION_ALREADY_NON_BLOCKING =
  `✗ ${FLAG_REFUTE} '{target}' matches a finding that requests no change; it is already not counted as blocking. Nothing was recorded.` as const;

export const NOTE_REFUTATION_SEVERITY_MISMATCH =
  `✗ ${FLAG_REFUTE} '{target}' selects a severity the finding does not have: the finding at that location is '{actual}'. Retry with '{suggestion}'. Nothing was recorded.` as const;

export const NOTE_REFUTATION_ALREADY_REFUTED =
  `✗ ${FLAG_REFUTE} '{target}' was already refuted by an earlier ${FLAG_REFUTE}. Nothing was recorded.` as const;

export const NOTE_REFUTATION_AMBIGUOUS =
  `✗ ${FLAG_REFUTE} '{target}' matches {count} blocking findings. Narrow it with #severity:` as const;


/**
 * What ENDS the QUALITY_GATE stage once this round's block is on record
 * (issue #337).
 */
export const NOTE_GATE_EVIDENCE_FILED =
  'Gate evidence filed for this round — the completion condition is met; do not re-dispatch the gate.' as const;


/** What ENDS the IMPLEMENT stage (issue #327). */
export const NOTE_IMPLEMENT_ADVANCE_CONDITION =
  'This stage ends when an implementation diff exists in the task worktree.' as const;


/** The state sentence when the probe FOUND an implementation (issue #327). */
export const NOTE_IMPLEMENT_PRESENT =
  'Implementation present: An implementation diff exists in the task worktree — the completion condition is met; do not re-dispatch the implementer.' as const;


/**
 * The state sentence when a diff is present but a review remediation is still
 * outstanding (issue #337).
 *
 * After `CHANGES_REQUESTED` the rejected diff is ALREADY in the worktree, so
 * the IMPLEMENT completion condition is "a diff exists AND no remediation is
 * pending". Printing `NOTE_IMPLEMENT_PRESENT` while dispatching the implementer
 * would tell the operator not to do the thing the payload asks for.
 */
export const NOTE_IMPLEMENT_PRESENT_REMEDIATION_PENDING =
  'Implementation present, but the AI review requested changes: the rejected diff is still in the task worktree, so the completion condition is NOT yet met. Dispatch the implementer to apply the remediation below; do not treat the existing diff as complete.' as const;


/**
 * The state sentence when a FAILED quality gate returned the pipeline to
 * IMPLEMENT (issue #337).
 *
 * A gate that exits `FAILED` transitions BACK to `IMPLEMENT` and stamps
 * `gateVerdict: FAILED` on the entry that opens the round. The diff sitting in
 * the worktree is therefore the diff that FAILED, so the completion condition is
 * NOT met even though the probe reports a present implementation: the operator
 * must get a fresh implementer carrying the gate's diagnostics, exactly as
 * `skills/codeloop/SKILL.md` promises for the gate-failure loop.
 */
export const NOTE_IMPLEMENT_GATE_FAILED =
  'The quality gate FAILED for this IMPLEMENT round: the completion condition is NOT met until its failures are fixed. Dispatch the implementer with the recorded gate diagnostics below; do not treat any existing diff as complete.' as const;


/** The heading of the gate-failure block a re-dispatched implementer receives (issue #337). */
export const NOTE_IMPLEMENT_GATE_FAILED_HEADING =
  `### Quality Gate Failure (${STATUS_FAILED})` as const;


/** The framing sentence of the gate-failure block (issue #337). */
export const NOTE_IMPLEMENT_GATE_FAILED_INTRO =
  'The quality gate FAILED and returned the pipeline to IMPLEMENT, so the completion condition is NOT met: fix every failure below, then re-run the gate.' as const;


/** The state sentence when the probe measured a clean tree (issue #327). */
export const NOTE_IMPLEMENT_ABSENT =
  'Implementation not present: No implementation diff was detected in the task worktree yet.' as const;


/** The state sentence when the probe could not measure (issue #327). */
export const NOTE_IMPLEMENT_UNVERIFIED =
  'The implementation diff could not be measured, so this directive makes no claim about the worktree.' as const;


/** The per-read re-dispatch record for IMPLEMENT: `{n}`. */
export const NOTE_IMPLEMENT_DISPATCH_ORDINAL =
  'Implementer dispatch {n} for this stage.' as const;


/**
 * The refusal a `PASSED` report that does not cover the plan's declared
 * Quality Gate Targets raises (issue #408, D2).
 *
 * ONE renderer for both enforcement points — filing (`gate-report`) and ingest
 * (`transition REVIEW`) — so the two cannot drift. `{missing}` is replaced by a
 * REPLACER FUNCTION: a command containing `$&` must not corrupt the message.
 */
export const MSG_GATE_EVIDENCE_COVERAGE_MISSING =
  "Gate evidence refused: the PASSED report does not cover the plan's declared Quality Gate Targets. Missing {missingCount} of {declaredCount} declared commands: {missing}. The plan's declared commands ARE the gate's command list, in this order, and a PASSED report must execute every one. Run the missing commands, then {refile} with `{command}`. {tail}" as const;


/**
 * The refusal a `PASSED` report that does not evidence the plan's declared
 * `### Manual Smoke Test Protocol` raises (issue #444).
 *
 * ONE renderer for both enforcement points — filing (`gate-report`) and ingest
 * (`transition REVIEW`) — so the two cannot drift. Every interpolated list goes
 * through a REPLACER FUNCTION: an id containing `$&` must not corrupt the
 * message.
 */
export const MSG_GATE_SMOKE_COVERAGE_MISSING =
  "Gate evidence refused: the PASSED report does not evidence the plan's declared Manual Smoke Test Protocol. {reason} Missing {missingCount} of {declaredCount} declared checks: {missing}.{clauses} The plan's declared checks ARE the gate's behavioural evidence: a PASSED report must report every check with its canonical id and `passed: true`, and a missing, renamed, duplicated or skipped check is a FAILED verdict. Run the missing checks, then {refile} with `{command}`. {tail}" as const;
export function smokeReasonClause(params: GateSmokeCoverageRefusalParams): string {
  switch (params.reason) {
    case 'protocol-not-declared':
      return `The report declares smokeProtocol: ${SMOKE_PROTOCOL_NOT_DECLARED} while the plan declares ${params.declaredCount} check(s).`;
    case 'protocol-missing':
      return 'The report omits smokeProtocol; a PASSED report over a declared protocol must report PASSED.';
    case 'protocol-failed':
      return 'The report declares smokeProtocol: FAILED; a PASSED report cannot certify a failed smoke protocol.';
    case 'duplicate':
      return 'The report repeats a declared check id.';
    case 'unknown':
      return 'The report reports a check id the plan does not declare.';
    case 'missing':
      return 'The report does not report every declared check.';
    case 'skipped':
      return 'The report lists a declared check in notRun.';
    case 'failed':
      return 'The report does not mark every declared check passed.';
    default:
      return 'The report does not evidence the plan’s declared protocol.';
  }
}
export function smokeClause(label: string, ids: readonly string[]): string {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  const rendered = ids.map((id) => `\`${id}\``).join(', ');
  return ` ${label}: ${rendered}.`;
}


/**
 * The refusal a `PASSED` report that names a test command while recording
 * `testsPassed = 0` raises (issue #412).
 *
 * ONE renderer for both enforcement points — filing (`gate-report`) and ingest
 * (`transition REVIEW`) — so the two cannot drift. `{commands}` is replaced by
 * a REPLACER FUNCTION: a command containing `$&` must not corrupt the message.
 */
export const MSG_GATE_PASSED_ZERO_TESTS =
  "Gate evidence refused: the PASSED report's normalised unique test total (testsPassed) is 0. A PASSED gate that ran tests must report a positive unique test total; a zero-test run is not evidence (a test runner that skipped every file — for example Node's recursive-run marker — still exits 0 and prints no summary). Test command(s): {commands}. Re-run the test commands without the conflicting signal, then {refile} with `{command}`. {tail}" as const;


/**
 * The refusal for a `PASSED` report whose test total was never MEASURED (issue
 * #415). Distinct from the zero-test message because the remedy differs: a zero
 * total means the runner executed nothing, a null total means no count was
 * recorded at all. `{commands}` is replaced by a REPLACER FUNCTION.
 */
export const MSG_GATE_PASSED_UNMEASURED_TESTS =
  `Gate evidence refused: the PASSED report's normalised unique test total (testsPassed) is null — the run did not MEASURE a test count. A PASSED gate that ran a test command must report a measured positive unique test total; 'not measured' cannot be distinguished from a run that executed nothing. Test command(s): {commands}. Record the measured count, or declare it in the gate output as \`${TOKEN_TEST_METRICS}: <n> passed, <n> failed, <n> skipped\` when the runner prints no count of its own (for example \`go test ./...\`), then {refile} with \`{command}\`. {tail}` as const;


/** The in-process failure when an exit-0 run still parses as having failures. */
export const MSG_GATE_TEST_METRICS_CONFLICT =
  `Test evidence conflict: '{command}' exited 0 but its summary parsed as {failed} failed test(s). An exit-0 test command cannot have failed tests, so the summary was not read correctly and the gate will not certify it. Re-run with a count-bearing summary, or declare the count as \`${TOKEN_TEST_METRICS}: <n> passed, <n> failed, <n> skipped\` in the command output.` as const;


/**
 * The in-process failure snippet for an exit-0 test command with no measurable
 * total (issues #412, #415). Both causes are named: a runner that skipped every
 * file, and a runner that prints no count at all. The token is the remedy the
 * second cause needs; it used to be discoverable only by reading the parser.
 */
export const MSG_GATE_NO_TEST_EVIDENCE =
  `Test evidence missing: '{command}' exited 0 without a measurable test count. Either (a) the runner skipped every file — a conflicting nested-run signal (for example Node's recursive-run marker) makes \`node --test\` do exactly that and still exit 0 — or (b) the runner prints no counts at all (\`go test ./...\`, \`ctest\`). Re-run without the conflicting signal; if the runner simply has no count, declare one in its output as \`${TOKEN_TEST_METRICS}: <n> passed, <n> failed, <n> skipped\` so the gate can measure the run.` as const;


/** What ENDS the DISCOVERY stage (issue #292). */
export const NOTE_DISCOVERY_ADVANCE_CONDITION =
  'This stage ends when a populated RCA report exists for the issue.' as const;


/**
 * The DISCOVERY state sentence once the RCA report is populated (issue #337).
 *
 * The directive used to print this sentence and STILL emit `actionType:
 * 'subagent'` with an invocation payload (and record a dispatch), so the prose
 * and the machine fields disagreed in the same document.
 */
export const NOTE_DISCOVERY_COMPLETE =
  'The discovery report is populated — the completion condition is met; do not re-dispatch discovery.' as const;


/** What ENDS the PLAN stage (issue #292). */
export const NOTE_PLAN_ADVANCE_CONDITION =
  'This stage ends when the plan file is non-blank.' as const;


/** The PLAN state sentence once the plan is non-blank (issue #337). */
export const NOTE_PLAN_COMPLETE =
  'The plan is non-blank — the completion condition is met; do not re-dispatch the planner.' as const;


/** The idle directive's summary: both names are executable commands. */
export const NOTE_IDLE_SUMMARY =
  `Pipeline is idle. Start a new lifecycle with \`${NEW_LIFECYCLE_COMMAND}\`, or re-open a COMPLETED task with \`${REOPEN_COMPLETED_COMMAND}\`.` as const;


/** The per-read re-dispatch record for DISCOVERY: `{n}`. */
export const NOTE_DISCOVERY_DISPATCH_ORDINAL =
  'Discovery dispatch {n} for this stage.' as const;


/** The per-read re-dispatch record for PLAN: `{n}`. */
export const NOTE_PLAN_DISPATCH_ORDINAL =
  'Planner dispatch {n} for this stage.' as const;


/**
 * Recorded in history metadata when `codeloop plan` re-enters PLAN from an
 * IMPLEMENT checkpoint (issue #267). Re-planning is the supported recovery
 * from the blank-plan park.
 */
export const NOTE_REOPENED_PLAN_FROM_IMPLEMENT =
  'Re-opened the plan from an IMPLEMENT checkpoint (blank-plan recovery)' as const;


/**
 * The blank-plan IMPLEMENT directive (issue #267, AC-A2).
 *
 * `codeloop next` at a blank-plan checkpoint returns the PLANNER instead of the
 * implementer, so the operator is handed the payload that can actually fill the
 * plan. `{planPath}` is the spec to complete, `{issue}` the task, `{command}`
 * the advance command.
 */
export const NOTE_BLANK_PLAN_DISPATCH_PLANNER =
  "The plan at '{planPath}' is still blank, so dispatching the implementer would give it nothing to execute. Dispatch the PLANNER to write the specification (or supply a plan with `codeloop implement --plan-path <file>`), then run `codeloop next` again. {command}." as const;


/**
 * The diagnostic for a verdict flag that was PRESENT but carried no value
 * (issue #269, R1).
 *
 * A verdict that was never read must fail LOUDLY. Falling through to the
 * critique path would record a `SKIPPED` verdict — a silent downgrade of the
 * reviewer's real verdict, and the exact defect this channel exists to
 * remove.
 */
export const NOTE_VERDICT_INPUT_MISSING =
  '{flag} was provided without a reviewer verdict. No verdict was recorded and the review did NOT run: a verdict that was never read must fail loudly, never fall through to the critique path. {hint}' as const;


/**
 * The `--critique-report` flag named no value (issue #297).
 *
 * Same posture as the verdict flags: a present-but-valueless evidence flag must
 * fail loudly BEFORE any state is touched, rather than silently disabling the
 * only cross-check of the filed verdict.
 */
export const NOTE_CRITIQUE_REPORT_INPUT_MISSING =
  "{flag} was provided without a critique report. No verdict was recorded and the checkpoint was not touched. Pass the path of the critique CLI JSON report, or '-' to read it from stdin." as const;


/** A `--critique-report` payload that was read but is not a critique report. */
export const NOTE_CRITIQUE_REPORT_PARSE_FAILURE =
  '✗ Critique report could not be parsed: {reason}' as const;


/**
 * A `--critique-report` path that has no readable payload at all (issue #400).
 *
 * Distinct from the parse failure on purpose: a missing file is the signature
 * of a crashed critique run, so pointing the operator at the evidence file's
 * FORMAT debugs the wrong stage.
 */
export const NOTE_CRITIQUE_REPORT_UNREADABLE =
  '✗ Tier 1 critique report could not be read: {path} ({reason}). The critique run probably failed and wrote nothing — re-run without --critique-report so review executes Tier 1 itself. Nothing was recorded.' as const;
export function critiqueReportLabel(reportPath: string): string {
  return reportPath === CRITIQUE_REPORT_STDIN ? VERDICT_INPUT_SOURCE_STDIN : reportPath;
}


/** A `--critique-report` payload that was read but carries no evidence (issue #400). */
export const NOTE_CRITIQUE_REPORT_EMPTY =
  '✗ Tier 1 critique report is empty: {path}. The critique run produced no evidence — re-run without --critique-report so review executes Tier 1 itself. Nothing was recorded.' as const;


/** `transition REVIEW` refuses while any deviation is unacknowledged. */
export const MSG_PLAN_DEVIATION_UNACKNOWLEDGED =
  'Plan deviation{plural} {ids} {isAre} unacknowledged. {lines}' as const;


/** Filing and acknowledgement are legal at every stage that can precede delivery. */
export const MSG_PLAN_DEVIATION_STAGE_REFUSAL =
  `Plan deviations can be filed or acknowledged at ${STAGE_IMPLEMENT}, ${STAGE_QUALITY_GATE}, ` +
  `${STAGE_REVIEW} or ${STAGE_COMMIT}; the checkpoint is at {stage}. ` +
  `If a deviation surfaced after implementation, route back with ` +
  `\`codeloop ${COMMAND_TRANSITION} ${STAGE_IMPLEMENT} --issue <n>\`, file it there, and re-run the gate. ` +
  `Nothing was written.`;


/** One Test Register row contradicts the test it pins. */
export const MSG_PLAN_TEST_REGISTER_CONTRADICTION =
  'Test Register row {row} contradicts the test it pins ({file}:{line}): it declares "{subject}" === "{rowValue}", but the pinned test asserts "{pinnedValue}". A row must restate the pinned literal, or declare a New test. Fix the plan, or route it back for revision.' as const;


/** A row declares neither `Pins:` nor `New test:`. */
export const MSG_PLAN_TEST_REGISTER_MISSING_MARKER =
  'Test Register row {row} declares neither **Pins:** nor **New test:**. Every row must pin an existing test (`**Pins:** \\`path\\` :: \\`title\\``) or declare itself new (`**New test:** \\`path\\` :: \\`title\\``).' as const;


/** A pinned reference cannot be resolved. */
export const MSG_PLAN_TEST_REGISTER_UNRESOLVABLE =
  'Test Register row {row} pins "{path}" :: "{title}", which cannot be resolved inside the workspace: {reason}.' as const;


/** A `Test Register` heading carries no parsable row (issue #436, AC1). */
export const MSG_PLAN_TEST_REGISTER_EMPTY =
  'The plan has a `Test Register` heading (plan line {line}) but no parsable row. A row is a `- **<id>**` bullet or a table row opening with a bold id, carrying a **Pins:** path :: title or **New test:** path :: title marker plus an **Asserts:** literal. Rewrite the register as rows, or remove the heading if the plan has no register.' as const;


/** A `New test:` title already exists. */
export const MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW =
  'Test Register row {row} declares a New test "{title}" in {path}, but that file already contains a test with that exact title (line {line}). A case that already exists is not new.' as const;


/** A `New test:` title already exists at the base revision (issue #489). */
export const MSG_PLAN_TEST_REGISTER_DUPLICATE_NEW_BASE =
  'Test Register row {row} declares a New test "{title}" in {path}, but that title already exists at the base revision "{base}" (line {line}). A case that already exists is not new; pin it with **Pins:** instead of declaring it new.' as const;


/** A planned test id already exists in the target file (issue #518, #476). */
export const MSG_PLAN_TEST_REGISTER_DUPLICATE_ID =
  'The plan plans test id "{id}" in {path} ({where}), but that file already declares it at {lines}. A test id must be unique inside its file: a reused id makes every reference — the plan, the Test Register, the review verdict and the summary — ambiguous. Choose a fresh id, or pin the existing case with **Pins:** instead of planning the id.' as const;


/** An AC or checklist step targets a path the commit can never contain. */
export const MSG_PLAN_EVIDENCE_EXCLUDED_PATH =
  'The plan\'s {target} names {path} (plan line {line}), which cannot appear in the delivered change set: {reason}. Deliver the correction as a tracked document, or declare it out of scope in the plan (a `- **Out of Scope:** <reason>` bullet).' as const;


/** The reviewer cited evidence outside the delivered change set. */
export const MSG_AC_EVIDENCE_UNVERIFIABLE =
  '{ac} is not in the delivered change set: {path}. Report the criterion as unverifiable, or cite a tracked file in the diff.' as const;


/** A reported `unverifiable` AC the plan itself declares out of scope (issue #506). */
export const MSG_AC_EVIDENCE_OPERATOR_STEP =
  'The plan declares this criterion out of scope: "{declaration}". Report it `out-of-scope` with no evidence path — `unverifiable` names evidence that must ship in this diff, so it escalates an APPROVED verdict.' as const;


/** The remediation line for that criterion. */
export const MSG_AC_EVIDENCE_OPERATOR_STEP_REMEDY =
  'Report {ac} as `out-of-scope` with no path (the plan declares it out of scope), or cite tracked evidence for it in this diff.' as const;


/** The summary clause that names `out-of-scope` for the declared entries. */
export const MSG_AC_EVIDENCE_OPERATOR_STEP_SUMMARY =
  'The plan declares {count} of them out of scope: report such a criterion `out-of-scope`, never `unverifiable`.' as const;


/** The unmeasured-change-set note (never converted into a false failure). */
export const MSG_AC_EVIDENCE_UNMEASURED =
  'The delivered change set could not be measured against base "{base}", so tracked-file evidence was not verified this round.' as const;


/**
 * A filed APPROVED verdict carried no `AC_EVIDENCE:` block (issue #435, D1).
 *
 * Certification is not a formality: without the block nothing was resolved, so
 * the round cannot be approved on the reviewer's word alone.
 */
export const MSG_AC_EVIDENCE_REQUIRED =
  'This APPROVED verdict carries no AC_EVIDENCE: block, so the {count} acceptance criteria the plan declares were not checked against the delivered change set. Append the block as the LAST thing in the verdict — one "- <AC id>: met|unverifiable|out-of-scope — `<path>`" line per criterion you checked — and file the verdict again.' as const;


/** A reported block that parsed to zero entries (issue #435, D4). */
export const MSG_AC_EVIDENCE_MALFORMED =
  'This APPROVED verdict carries an AC_EVIDENCE: block that yields no parseable entry, so it certifies nothing. Every item must read "- <AC id>: met|unverifiable|out-of-scope — `<path>`". {lines}' as const;


/**
 * The cross-repo half of the release-notes contract (issue #257 / #315 AC-32).
 *
 * `ajxcodes/auto-tag` renders the published GitHub Release notes from commit
 * SUBJECTS only (`--pretty=format:"- %s"`). That generator lives in another
 * repository and another release train, so the in-repo changelog fix does not
 * close it — and no artifact this run produces may imply that it did.
 */
export const NOTE_RELEASE_NOTES_DEPENDENCY =
  'GitHub Release notes are generated by ajxcodes/auto-tag from commit subjects only (cross-repo; not fixed here).' as const;


/** Pause note emitted whenever the lifecycle halts at the circuit-breaker gate. */
export const NOTE_PAUSED_CIRCUIT_BREAKER_GATE = 'Paused at circuit breaker gate' as const;

export const MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST = `State mutation is forbidden inside a smoke-isolation directory the tool does not recognise as its own sandbox (${SMOKE_SANDBOX_RECOMMENDED_PATH}).` as const;

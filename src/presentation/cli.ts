/**
 * agyloop - CLI Presentation Controller & Dispatcher
 *
 * Formats terminal output and dispatches commands to application use cases.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  STAGES,
  StageName,
  CLI_VERSION,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_TRIAGE,
  GATE_APPROVAL,
  GATE_COMMIT,
  GATE_CIRCUIT_BREAKER,
  MODE_YOLO,
  MODE_PLAN,
  MODE_STANDARD,
  MODE_IMPLEMENT,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MODE_COMMIT,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ROLE_TRIAGE,
  VERDICT_SKIPPED,
  DEFAULT_PROMPTS_DIR,
  DEFAULT_STATE_DIR,
  DEFAULT_STATE_FILE,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  EXIT_CODE_QUOTA_EXHAUSTED,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_WORKTREE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_RELEASE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_CRITIQUE,
  COMMAND_TRIAGE,
  COMMAND_HALT,
  COMMAND_REVIEW,
  COMMAND_GATE_REPORT,
  COMMAND_SYNC,
  COMMAND_INIT,
  COMMAND_RESUME,
  FLAG_VERDICT_FILE,
  FLAG_REVIEW_OUTPUT,
  FLAG_VERDICT_STDIN,
  FLAG_CRITIQUE_REPORT,
  CRITIQUE_REPORT_STDIN,
  FLAG_REFUTE,
  NOTE_REFUTATION_REQUIRES_VALUE,
  FindingRefutation,
  RefutationRefusedError,
  formatNonActionableFindingsNote,
  formatRefutedFindingsNote,
  FLAG_REPORT_FILE,
  FLAG_REPORT_STDIN,
  FLAG_PLAN_PATH,
  FLAG_PLAN_DIR,
  VERDICT_INPUT_SOURCE_STDIN,
  NOTE_VERDICT_INPUT_MISSING,
  HINT_VERDICT_FILE_INPUT,
  HINT_REVIEW_OUTPUT_INPUT,
  HINT_VERDICT_STDIN_INPUT,
  formatCritiqueReportInputMissing,
  formatCritiqueReportParseFailure,
  formatCritiqueReportUnreadable,
  formatCritiqueReportEmpty,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  FLAG_WORKTREE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  FLAG_NO_WORKTREE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  FLAG_FORCE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  FLAG_FORCE_SHORT,
  REGEX_POSITIONAL_ISSUE_ID,
  PreFlightHaltError,
  MilestoneReleaseError,
  MilestoneSealedError,
  QuotaExhaustedError,
  ValidationError,
  CircuitBreakerTrippedError,
  InvalidTransitionError,
  QUOTA_RESUME_COMMAND,
  StateMachine,
  StateMachineSnapshot,
  IssueNumber,
  parseIssueToken,
  NOTE_DISCOVERY_PARK_AWAITING_RCA,
  NOTE_RELEASE_NOTES_DEPENDENCY,
  withRecordedPauseHint,
  NOTE_IMPLEMENTATION_EVIDENCE_MISSING,
  NOTE_IMPLEMENTATION_PARK_UNCHANGED,
  NOTE_IMPLEMENTATION_PARK_DISPATCH,
  NOTE_IMPLEMENTATION_PARK_NEXT,
  NOTE_IMPLEMENTATION_UNMEASURABLE,
  NOTE_IMPLEMENTATION_STALE_WORKTREE,
  NOTE_IMPLEMENTATION_PLAN_EMPTY,
  NOTE_IMPLEMENTATION_PLAN_EMPTY_REPEAT,
  NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT,
  PLAN_EMPTY_PARK_REPEAT_THRESHOLD,
  // Issue #259: the VACUOUS refusal messages live in the domain. The CLI
  // must never re-type them — a hand-typed copy is how the two drift apart.
  NOTE_GATES_VACUOUS_YOLO,
  NOTE_GATES_VACUOUS_STANDARD,
  STATE_MUTATING_COMMANDS,
  // Dismissal reporting: the dismissal route reports what it really achieved,
  // so the CLI must render those counts instead of an unqualified success.
  DISMISS_OUTCOME_COMPLETE,
  DISMISS_OUTCOME_PARTIAL,
  DISMISS_OUTCOME_FAILED,
  DISMISS_OUTCOME_NOTHING,
  DISMISS_OUTCOME_REFUSED,
  LABEL_DISMISS_THREADS,
  LABEL_DISMISS_CONVERSATION,
  LABEL_DISMISS_FAILURES,
  LABEL_DISMISS_SURFACES,
  LABEL_DISMISS_NO_SURFACE,
  DISMISS_FAILURE_DETAIL_LIMIT,
  NOTE_DISMISS_DUPLICATE_FEEDBACK,
  NOTE_DISMISS_ALREADY_ANSWERED,
  NOTE_DISMISS_OWN_REPLY,
  NOTE_DISMISS_PRIOR_ANSWER,
  NOTE_DISMISS_NOTHING,
  NOTE_DISMISS_NOTHING_HANDLED,
  // Issue #282: a read-only diagnostic reports a dead descriptor as STALE
  // instead of advertising a directory that is gone.
  NOTE_WORKTREE_STALE,
  // Issue #266: the abort summary states that the checkpoint records no
  // worktree instead of printing an ambiguous `0`.
  NOTE_ABORT_NO_WORKTREE_LABEL,
  // Issue #269: the TRIAGE gate's exit condition and the disposition line.
  NOTE_TRIAGE_GATE_EXIT_CONDITION,
  NOTE_TRIAGE_DISPOSITION_NOT_RECORDED,
  NOTE_TRIAGE_DISPOSITION_REFUSED,
  NOTE_TRIAGE_STATE_UNCHANGED,
  NOTE_TRIAGE_REFUSAL_NO_TRANSITION,
  NOTE_TRIAGE_DRY_RUN_DISMISS,
  LABEL_TRIAGE_DISPOSITION,
  // Issue #241 (D1/D4): ONE action vocabulary + ONE formatter for the parser,
  // the error text, `--help`, the read-only hint and the stage precondition.
  TRIAGE_DISPOSITION_ACTIONS,
  formatTriageActionList,
  formatTriageActionSideEffects,
  MSG_TRIAGE_ROUTING_REQUIRES_GATE,
  // Issue #272: the additive `status` line for the REVIEW re-dispatch record.
  LABEL_REVIEW_DISPATCHES,
  // Issue #297: the advisory printed when a filed verdict was not cross-checked
  // by Tier 1.
  NOTE_REVIEW_CRITIQUE_NOT_VERIFIED,
  LABEL_DISCOVERY_DISPATCHES,
  LABEL_PLAN_DISPATCHES,
  LABEL_PLAN_EMPTY_PARKS,
  // Issue #327: the IMPLEMENT re-dispatch record is observable in `status`.
  LABEL_IMPLEMENT_DISPATCHES,
  COMMAND_OPENCODE,
  // Issue #269 (R5): the ONE renderer for the operator-facing disposition
  // line. The CLI must not hand-render it.
  formatTriageDispositionLine,
  TriageDisposition,
  ReviewVerdict,
  AiReviewReport,
  ReviewerSubagentError,
  GateResultReport,
  resolveGateRound,
  formatGateReportAdvanceCommand,
  // Issue #327: the late-filing refusal names a LEGAL walk back to the gate.
  formatGateReportChannelCommand,
  // Issue #408 (D2): the coverage refusal is ONE renderer for filing + ingest.
  formatGateTargetCoverageRefusal,
  // Issues #412/#415: a PASSED block that ran a test command but recorded zero
  // or unmeasured unique tests is not certifiable evidence.
  gateTestEvidenceRefusal,
  formatGateZeroTestRefusal,
  TOKEN_TEST_METRICS,
  formatTransitionRecoveryCommands,
  findLegalTransitionPath,
  // Issue #402: the APPROVAL baseline behaviour embeds the SAME prohibition the
  // DISCOVERY directive states, so the two surfaces can never drift.
  ROOT_BUILD_PROHIBITION_SENTENCE
} from '../domain';
import type {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  WorktreeManagerPort,
  BuildDetectorPort,
  CritiquePort
} from '../ports';
import {
  FileStateRepository,
  CliGitHubGateway,
  FileConfigRepository,
  GeminiModelCatalog,
  FilePlanGenerator,
  FilePromptRepository,
  ProcessCommandExecutor,
  FileBuildDetector,
  ReadlineConfirmationPrompt,
  CliCritiqueGateway,
  GithubCritiqueInstallerGateway,
  FileStandardsRepository,
  GitWorktreeManager,
  RunnerFactory,
  FileProjectScaffolder,
  FileGateReportRepository,
  FileWorkspaceMutationProbe
} from '../infrastructure';
import { installOpenCodeIntegration } from './opencode-setup';
import { ColorStream, STAGE_COLOR_CODES, paint } from './color-policy';
import {
  validateCapability,
  validatePlanInputScope,
  validateRefutationScope,
  validateUnknownFlags
} from './cli-flags';
import {
  RunLifecycleUseCase,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  StartPlanningUseCase,
  TransitionStageUseCase,
  GetPipelineStatusUseCase,
  ResetPipelineUseCase,
  ListModelsUseCase,
  ResolveSubagentUseCase,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  StartImplementationUseCase,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  RunQualityGateUseCase,
  RunReviewUseCase,
  ManageCritiqueUseCase,
  DraftCommitUseCase,
  ExecuteCommitUseCase,
  ManageWorktreeUseCase,
  MilestoneReleaseUseCase,
  InferBaseBranchUseCase,
  GetNextActionUseCase,
  TriagePrCommentsUseCase,
  TriageAction,
  TriageDismissReport,
  TriageRefusal,
  dismissalPerformed,
  SyncUseCase,
  AbortPipelineUseCase,
  AbortPipelineResult,
  InitProjectUseCase,
  ResumePipelineUseCase,
  HaltPipelineUseCase,
  resolveCheckpointScope,
  CheckpointScope,
  // Issue #327: `next` consults the SAME implementation-evidence probe the
  // gate and the YOLO path use, so "nothing implemented yet" is a measurement.
  DetectImplementationDiffUseCase,
  // Issue #408 (D2): the SAME coverage assessment the ingest side runs.
  assessGateEvidenceCoverage
} from '../application';
import type { ImplementationProbe } from '../application';

export interface CliOptions {
  workspaceDir?: string;
  commitAfter: boolean;
  yolo: boolean;
  dryRun: boolean;
  issue: string | null;
  title: string | null;
  type: string | null;
  configPath: string | null;
  refresh: boolean;
  help: boolean;
  version: boolean;
  stageArg: string | null;
  roleArg: string | null;
  yes: boolean;
  message: string | null;
  staged: boolean;
  worktree: boolean;
  noWorktree: boolean;
  keepWorktree: boolean;
  json: boolean;
  baseBranch: string | null;
  phaseBranch: string | null;
  worktreeSubcommand: string | null;
  worktreeTarget: string | null;
  /**
   * `worktree remove`-scoped opt-in (#282): clear a checkpoint descriptor whose
   * worktree directory is already gone. The plain command keeps refusing a
   * missing path (AC-2); this is the remediation the stale-descriptor
   * diagnostics print, and it never touches the filesystem.
   */
  pruneStale: boolean;
  subagents: boolean;
  all: boolean;
  critiqueSubcommand: string | null;
  opencodeSubcommand: string | null;
  model: string | null;
  force: boolean;
  triageAction: string | null;
  step: boolean;
  messageFile: string | null;
  createPr: boolean;
  quarantine: boolean;
  /**
   * `--no-quarantine` / `--keep-worktrees` (issue #266 AC-5): abort without
   * relocating the task worktree's uncommitted work.
   */
  noQuarantine: boolean;
  reason: string | null;
  retryAfter: string | null;
  /**
   * `next`-scoped explicit opt-in (issue #237): on a COMPLETED checkpoint,
   * reset it and re-open at DISCOVERY. Plain `next` never mutates a checkpoint.
   */
  restart: boolean;
  /**
   * Explicit opt-in (issue #237): bypass the DISCOVERY RCA park. Threaded
   * `CliOptions -> RunLifecycleParams -> StartPlanningParams` and recorded in
   * history metadata so a bypassed RCA gate stays auditable.
   */
  skipDiscovery: boolean;
  /**
   * The path of the file carrying the dispatched Reviewer subagent's verdict
   * block (issue #269). Read by `codeloop review`.
   */
  verdictFile: string | null;
  /**
   * The dispatched Reviewer subagent's verdict block, inline (issue #269).
   */
  reviewOutput: string | null;
  /**
   * True when `--verdict-file` was PRESENT on the command line, whether or
   * not it carried a value (issue #269, R1).
   *
   * A present-but-valueless verdict flag is a LOUD failure, never a
   * fall-through to the critique path: the fall-through records a `SKIPPED`
   * verdict, which silently downgrades the reviewer's real one. The marker is
   * what makes "the flag was there but its value was missing" distinguishable
   * from "the flag was never given".
   */
  verdictFileRequested: boolean;
  /**
   * True when `--review-output` was PRESENT on the command line, whether or
   * not it carried a value (issue #269, R1).
   */
  reviewOutputRequested: boolean;
  /**
   * Read the dispatched Reviewer subagent's verdict block from stdin
   * (issue #269).
   */
  verdictStdin: boolean;
  /**
   * The path of a critique CLI JSON report to cross-check the filed verdict
   * against (issue #297), or the literal `-` for stdin.
   *
   * This is the hermetic Tier 1 evidence channel: supplying it suppresses the
   * critique subprocess but NOT the two-tier invariant.
   */
  critiqueReport: string | null;
  /** True when `--critique-report` was PRESENT, whether or not it carried a value. */
  critiqueReportRequested: boolean;
  /**
   * The path of the dispatched GATE subagent's evidence block (issue #284), or
   * the literal `-` for stdin.
   */
  reportFile: string | null;
  /** Read the gate's evidence block from stdin (issue #284). */
  reportStdin: boolean;
  /** True when `--report-file` was PRESENT, whether or not it carried a value. */
  reportFileRequested: boolean;
  /**
   * An operator-supplied plan file (issue #267). When present it is the plan
   * the lifecycle executes, and no competing plan directory is scaffolded.
   */
  planPath: string | null;
  /** An operator-supplied plan directory (issue #267). */
  planDir: string | null;
  /** True when `--plan-path` was PRESENT, whether or not it carried a value. */
  planPathRequested: boolean;
  /** True when `--plan-dir` was PRESENT, whether or not it carried a value. */
  planDirRequested: boolean;
  /**
   * The operator refutations carried by `--refute` (issue #349), in
   * command-line order. Parsed into `FindingRefutation` instances at the
   * `runCli` chokepoint, before any repository is constructed.
   */
  refuteSpecs: string[];
  /** True when `--refute` was PRESENT, whether or not it carried a value. */
  refuteRequested: boolean;
}

export interface ParsedCliArgs {
  command: string | null;
  options: CliOptions;
  /**
   * Tokens the parser did not recognise (issue #248). The parser never throws
   * and never drops a token silently: `runCli` rejects the invocation before
   * any command body runs, so a misspelled safety switch (`--dry-runn`) is a
   * hard error instead of a destructive operation.
   */
  unknownFlags: readonly string[];
}

/**
 * Zero-Hang Invariant (issue #218 AC6): prompts are permitted only when a human is
 * attached to BOTH stdin and stdout AND machine-readable output was not requested.
 * Pure so it is unit-testable without touching the real process streams.
 */
export function computePromptsAllowed(
  options: Pick<CliOptions, 'json'>,
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean
): boolean {
  return !options.json && stdinIsTTY && stdoutIsTTY;
}

/**
 * Command that clears a persisted gate pause (issue #218 AC4).
 *
 * `codeloop next` only *reports* a pause — it never clears one, with the single
 * exception of the terminal TRIAGE exit (issue #351), where a MERGED/CLOSED pull
 * request records COMPLETED and consumes the pause. `resumeFromGate()` is reachable
 * from `resume`, `transition` and `triage`, so exit code 2 telling users to "resume
 * with codeloop next" was advice that could not work. Help text, the `next` banner
 * and the `status` recovery hint therefore name this command.
 *
 * It is declared here rather than imported so the help text keeps naming a command that
 * clears the pause even if a domain constant drifts again;
 * `tests/presentation/cli-gate-pause-visibility.test.ts` pins it against
 * `QUOTA_RESUME_COMMAND` (domain), which must resolve to the same string.
 */
export const RESUME_COMMAND = 'codeloop resume';

/**
 * The COMMIT gate's command (issue #315, AC-7): the step an operator takes at a
 * persisted COMMIT pause is the commit itself, never `resume`.
 */
export const COMMIT_GATE_COMMAND = 'codeloop commit';

/**
 * The APPROVAL gate's command (issue #362, Finding 3): the step an operator
 * takes at an APPROVAL pause is the approval flow itself — the command the
 * gate's own `humanSummary` names — never `resume`. `transition-stage.ts` calls
 * `resumeFromGate()` unconditionally, so `codeloop implement` alone clears the
 * pause; telling the operator to run `codeloop resume` first was an unnecessary
 * extra step beside a contradicting summary.
 */
export const APPROVAL_GATE_COMMAND = 'codeloop implement';

/**
 * A gate pause read straight off the persisted checkpoint.
 *
 * Rendered as data (never prose) in `next --json`, and as an extra block in the human
 * `status` / `next` output. `gate` is whatever `StateMachine.pauseAtGate()` recorded —
 * today `CIRCUIT_BREAKER`, `APPROVAL`, `COMMIT` or `TRIAGE`.
 */
export interface PersistedGatePause {
  readonly gate: string;
  readonly pausedAt: string | null;
  /**
   * The command that clears a PERSISTED pause — `null` for a human gate, which
   * is not something `resume` can (or should) clear: both a synthesised gate
   * pause and a persisted one at COMMIT (issue #315, AC-7) or APPROVAL (issue
   * #362, Finding 3). Overloading this field with a fake command would have
   * made the hint false; a nullable field keeps it honest.
   */
  readonly resumeCommand: string | null;
  readonly message: string;
}

/**
 * The pause OBJECT a `human_gate` directive carries (issue #315, AC-7).
 *
 * A human gate is a wait on a person, not a persisted checkpoint pause, so
 * there is nothing to `resume`: `resumeCommand` is `null` and `pausedAt` is the
 * timestamp of the stage entry that opened the gate. Returning `null` instead
 * (the old behaviour) forced every consumer to special-case COMMIT.
 */
export function synthesiseHumanGatePause(
  action: { readonly currentStage: string; readonly humanSummary: string },
  pausedAt: string | null
): PersistedGatePause {
  return {
    gate: action.currentStage,
    pausedAt,
    resumeCommand: null,
    message: `Human gate at ${action.currentStage}: ${action.humanSummary}`
  };
}

/** The timestamp of the checkpoint's most recent history entry, or `null`. */
function lastHistoryTimestamp(snapshot: StateMachineSnapshot | null | undefined): string | null {
  const history = snapshot?.history;
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }
  return history[history.length - 1]?.timestamp ?? null;
}

/**
 * Reads the persisted gate pause, or `null` when the pipeline is not paused.
 *
 * Never throws: a missing, unreadable or corrupt checkpoint must not take down a
 * command whose real job is to report state (issue #218 AC4).
 *
 * `snapshotOverride` lets a caller that has ALREADY resolved the authoritative
 * checkpoint hand that exact snapshot in, so the pause block cannot be read from
 * a different file than the header was built from (#226 D5). Omitted, the
 * behaviour is unchanged and the repository is read directly — which is why all
 * pre-existing call sites needed no edit.
 */
export async function readPersistedGatePause(
  stateRepo: StateRepository,
  snapshotOverride?: StateMachineSnapshot | null
): Promise<PersistedGatePause | null> {
  try {
    const snapshot = snapshotOverride !== undefined ? snapshotOverride : await stateRepo.load();
    const gate = snapshot?.pausedAtGate ?? null;
    if (!gate) {
      return null;
    }

    // Issue #315 (AC-7 / AC-13): the COMMIT gate is a HUMAN GATE, not a
    // resumable blocker. `run-review` persists `pausedAtGate: 'COMMIT'` so the
    // confirmation wait is measurable, but the operator's next step is
    // `codeloop commit --create-pr` — never `codeloop resume`. Presenting it as
    // a resumable pause printed a 🛑 "run codeloop resume" banner next to a
    // humanSummary that said "run codeloop commit --create-pr": two conflicting
    // next steps, one of them wrong. The pause stays (accounting), the resume
    // guidance goes.
    if (gate === GATE_COMMIT) {
      return {
        gate,
        pausedAt: snapshot?.pausedAtTimestamp ?? null,
        resumeCommand: null,
        message: `Pipeline rests at the ${gate} human gate. This is not a resumable blocker: run \`${COMMIT_GATE_COMMAND}\` (add \`--create-pr\` to open the delivery PR).`
      };
    }

    // Issue #362 (Finding 3): APPROVAL is the same human-gate class as COMMIT.
    // Entering APPROVAL persists `pausedAtGate: 'APPROVAL'`
    // (`transition-stage.ts`), and the persisted pause shadowed the synthesised
    // human-gate pause, so `next --json` returned a `humanSummary` saying "run
    // codeloop implement" beside a pause saying "run codeloop resume" — two
    // conflicting next steps, one of them wrong (the `resume` half of #315,
    // left unfixed). The pause stays (wait accounting — `resumeFromGate()`
    // banks `totalHumanWaitMs`), only the false guidance goes.
    if (gate === GATE_APPROVAL) {
      return {
        gate,
        pausedAt: snapshot?.pausedAtTimestamp ?? null,
        resumeCommand: null,
        message: `Pipeline rests at the ${gate} human gate. This is not a resumable blocker: once the plan is approved, run \`${APPROVAL_GATE_COMMAND}\` (or \`codeloop transition IMPLEMENT\`).`
      };
    }

    return {
      gate,
      pausedAt: snapshot?.pausedAtTimestamp ?? null,
      resumeCommand: RESUME_COMMAND,
      message: `Pipeline is paused at the ${gate} gate. Resolve the blocking condition, then run \`${RESUME_COMMAND}\`.`
    };
  } catch {
    return null;
  }
}

export function printHelp(): void {
  console.log(`
codeloop v${CLI_VERSION} - Multi-Agent Development Lifecycle Orchestrator

Usage:
  codeloop [command] [options]

Operational Modes:
  init               Scaffold .codeloop/config.json (git, verification profile) and update .gitignore; migrates legacy .agyloop config
  (default)          Run continuous lifecycle (Discovery -> Plan -> [Approval] -> Implement -> Gates -> Review -> [Commit])
  yolo               Unattended fast-path (auto-approves plan gate, streams straight through gates and review)
  plan               Plan-only mode; generates persistent plan in artifacts/plans/ and halts at [APPROVAL] gate. Bug-labelled issues enter DISCOVERY first and park until the RCA report is populated.
  implement          Resume implementation directly from approved plan specification
  commit             Draft Conventional Commit and prompt for interactive human approval
  release [branch]   Generate Milestone Release PR from phase collector to main with SemVer label
  sync               Fast-forward collector branch and process merged PRs to auto-close issues

Pipeline Management:
  next               Inspect state and generate the next invoke_subagent directive (writes only the declared context fields: inferred baseBranch, dispatch counters, updatedAt; at TRIAGE a MERGED/CLOSED pull request ENDS the gate — the checkpoint is recorded as COMPLETED and the report is idle; --dry-run previews without writing; --restart also resets the checkpoint)
                     An OPEN pull request keeps the TRIAGE gate; when the PR is MERGED/CLOSED the gate exits to COMPLETED on the next read, so it never needs \`codeloop resume\` + \`codeloop triage\`
                     --json adds 'actionable' and 'pause': actionable is true only for a dispatchable subagent directive with no persisted pause; it is false for every human_gate (COMMIT included), every persisted pause, COMPLETED, INITIALIZED, and every stage whose completion condition is already met (those report actionType 'advance' and carry no invocationPayload); pause is null when neither a persisted pause nor a human gate applies
  branch-info        Display base collector branch, active task branch, and PR target
  status             Display current pipeline stage, active tasks matrix, and checkpoint history
  config             Display active configuration and model routing table
  models             List available Gemini models and mapped Antigravity tiers
  prompt [role]      Inspect subagent definition, whitelist, and system prompt (planner|implementer|gate|reviewer)
  reset              Reset .agyloop/state.json checkpoint (supports --issue <id> and --all)
  resume             Clear a persisted gate pause (CIRCUIT_BREAKER, APPROVAL, COMMIT, TRIAGE) and checkpoint the wait time
  halt --reason quota [--retry-after <s>]  Record provider quota halt (429) and checkpoint at CIRCUIT_BREAKER (exits 2)
  abort              Emergency Stop: halts subagents, clears locks, quarantines worktrees, stops sandboxes
  transition <STAGE> Advance state machine to target stage
      APPROVAL measures every \`### Baseline Evidence\` claim exactly once and refuses a build-like command (\`npm run build\`, \`npm test\`, \`tsc\`, \`make\`) with a named reason. ${ROOT_BUILD_PROHIBITION_SENTENCE}
      Legacy {COMPLETED, pausedAtGate: COMMIT} checkpoints: 'transition' cleanses the stale pause when it reopens the run; 'implement' fails first at the plan gate and leaves it in place.
  worktree [cmd]     Manage isolated git worktrees (list | clean | prune | remove <id>)
  critique [cmd]     Manage Critique CLI installation (status | install | update)
  opencode [cmd]     Manage OpenCode integration assets (install: skill + /codeloop command)
  triage [action]    Triage PR review comments and route pipeline (${formatTriageActionList('|')}); ${formatTriageActionSideEffects()}
  review            Record an AI Reviewer Subagent's verdict (--verdict-file <path> | --review-output <text> | --verdict-stdin | --critique-report <path|-> | ${FLAG_REFUTE} <path>:<line>[#<severity>]=<reason>); with no verdict it runs the critique-based review
  gate-report       File a dispatched Quality Gate Subagent's GATE_REPORT_JSON evidence block (--report-file <path|-> | --report-stdin); 'transition REVIEW' ingests it
      A PASSED block whose executed test command has no MEASURED positive total is refused. A runner that prints no count (e.g. \`go test ./...\`) must declare \`${TOKEN_TEST_METRICS}: <n> passed, <n> failed, <n> skipped\` in its output.

Operational Flags:
      --yolo         Enable unattended fast-path (equivalent to 'yolo' command)
      --commit-after Automatically draft and commit changes if quality gates and AI review pass (implies --create-pr, so the run is delivered)
      --step         Pause compound execution after quality gates (before AI review)
  -y, --yes          Skip interactive confirmation prompt (auto-approve commit)
  -m, --message <msg> Explicit conventional commit message override; for 'triage dismiss' the dismissal notes — required, since a dismissal without them is refused and writes nothing
      --message-file <path> Read commit message from file
      --verdict-file <path> Read an AI Reviewer Subagent's verdict block from a file (codeloop review)
      --review-output <text> Pass an AI Reviewer Subagent's verdict block inline (codeloop review)
      --verdict-stdin   Read an AI Reviewer Subagent's verdict block from stdin (codeloop review)
      --critique-report <path|->  Cross-check the verdict against a critique CLI JSON report (codeloop review)
      ${FLAG_REFUTE} <path>:<line>[#<severity>]=<reason>  Refute a critique finding you have verified is false (repeatable; codeloop review with a filed APPROVED verdict only). The reason is mandatory — a refutation without one is refused, and every refuted finding is named on stderr and recorded as reviewRefutations.
      --report-file <path|->  Read a Quality Gate Subagent's GATE_REPORT_JSON block from a file (codeloop gate-report)
      --report-stdin     Read a Quality Gate Subagent's GATE_REPORT_JSON block from stdin (codeloop gate-report)
      --create-pr    Automatically create a PR after commit. A PR that targets a collector branch (phase/* or feature/*) does NOT auto-close the issue on merge — closing keywords fire only on the default branch — so \`commit\` prints that caveat whether the issue came from --issue or the checkpoint, and \`codeloop sync\` closes the issue after the merge.
  -s, --staged       Inspect / commit staged changes only (git diff --cached)
  -f, --force        Force operation (force abort, fresh version check or reinstallation)
      --quarantine   Quarantine uncommitted changes to a dedicated branch during abort
      --no-quarantine  Abort without stashing worktrees (alias: --keep-worktrees)
      --issue <num>  Associate execution with GitHub issue number (digits only; e.g. --issue 250)
      --title <text>  Specify the plan title; the artifact folder and filename are derived from it and bounded (long titles are truncated and hashed)
      --type <type>  Specify plan type (discovery | implementation | auto); auto infers from the issue kind (bug -> DISCOVERY entry, otherwise -> PLAN), and an explicit value also selects the entry stage
      --config <path> Path to custom configuration file (.agyloop.json)
      --model <name> Override agent runner model (e.g. ornith:9b-128k)
      --worktree     Enable git worktree isolation for task execution (default: true)
      --no-worktree  Disable worktree isolation and execute directly in root workspace
      --keep-worktree Keep git worktree after commit completion (prevent auto-teardown)
      --subagents    Prune external Antigravity subagent worktrees (used with worktree prune/clean)
      --all          Include/prune all worktrees (used with worktree list/prune/clean)
      --prune-stale  Clear the checkpoint descriptor of a worktree whose directory no longer exists (used with worktree remove <id>)
      --json         Machine-readable JSON (supported by: init, next, branch-info, status, resume, halt, critique status, triage, review, gate-report)
      --base-branch <branch> Override base branch for worktree or milestone release
      --refresh      Force refresh of discovered Gemini models or milestone release PR
      --dry-run      Simulate execution without modifying state (mutating commands only; read-only commands refuse it — see the command table above)
      --plan-path <f> Supply an existing plan file the lifecycle executes instead of scaffolding a new plan (plan, implement, yolo)
      --plan-dir <d>  Supply an existing plan directory (plan, implement, yolo)
      --restart      Explicit opt-in: on a COMPLETED checkpoint, reset it and re-open — at TRIAGE when the pull request carries undispositioned review feedback (that feedback wins over DISCOVERY), otherwise at DISCOVERY. Plain 'next' never advances a stage except the documented TRIAGE exit (a MERGED/CLOSED PR ends the gate as COMPLETED); otherwise it writes only the context fields named above.
      --skip-discovery  Explicit opt-in: bypass the DISCOVERY RCA park (auditable in state history).
  -h, --help         Show this help message and exit
  -v, --version      Show version information and exit

Exit Codes:
  0   Success
  1   Failure (gate, review, config or usage error). Work is NOT checkpointed for resume.
  2   Provider quota exhausted (HTTP 429 / RESOURCE_EXHAUSTED / rate-limit rejection).
      Recoverable: state is checkpointed at the CIRCUIT_BREAKER gate and nothing is lost.
      Resume with '${RESUME_COMMAND}' once the quota window resets — 'codeloop next' only
      reports the pause, it does not clear it.
      External runners report quota via 'codeloop halt --reason quota' — the in-process runner is intentionally not wired into the lifecycle.
      CI: treat 2 as failure too, but distinguish it from 1 to avoid hot-retrying a
      provider that will keep rejecting until the window reopens.

Examples:
  codeloop                               Standard continuous loop (stops at [APPROVAL] and [COMMIT] gates)
  codeloop plan --issue 32               Generate persistent plan for issue #32 and stop at [APPROVAL] gate
  codeloop implement                    Resume implementation from approved plan in artifacts/plans/
  codeloop resume                       Clear a persisted gate pause (e.g. CIRCUIT_BREAKER) and checkpoint the wait time
  codeloop commit                        Draft Conventional Commit and prompt for human approval
  codeloop commit -y                     Draft Conventional Commit and commit immediately
  codeloop opencode install              Install the OpenCode skill to ~/.config/opencode/skills/ and register the /codeloop command
  codeloop critique status               Inspect critique resolution, installed version, and update status
  codeloop critique install              Install latest critique CLI into user data directory
  codeloop critique update               Update critique CLI to latest release
  codeloop release phase/1-bridge-arch   Generate milestone release PR to main with SemVer label
  codeloop release --dry-run             Preview calculated SemVer bump and compiled changelog
  codeloop yolo                          Unattended fast-path (auto-approves plan gate, runs gates and review)
  codeloop yolo --commit-after           100% end-to-end hands-off loop: plan -> implement -> gates -> review -> commit
  codeloop --yolo --commit-after         Equivalent hands-off execution using flag syntax
  codeloop init                          Detect project and scaffold .codeloop/config.json
  codeloop init --dry-run --json         Preview generated config without writing anything
  codeloop worktree list                 List isolated git worktrees and their status (active | prunable)
  codeloop worktree prune                Prune dangling worktrees and lock metadata
`);
}

export function parseArguments(args: readonly string[]): ParsedCliArgs {
  let command: string | null = null;
  const options: CliOptions = {
    commitAfter: false,
    yolo: false,
    dryRun: false,
    issue: null,
    title: null,
    type: null,
    configPath: null,
    refresh: false,
    help: false,
    version: false,
    stageArg: null,
    roleArg: null,
    yes: false,
    message: null,
    staged: false,
    worktree: true,
    noWorktree: false,
    keepWorktree: false,
    json: false,
    baseBranch: null,
    phaseBranch: null,
    worktreeSubcommand: null,
    worktreeTarget: null,
    pruneStale: false,
    subagents: false,
    all: false,
    critiqueSubcommand: null,
    opencodeSubcommand: null,
    model: null,
    force: false,
    triageAction: null,
    step: false,
    messageFile: null,
    createPr: false,
    quarantine: false,
    noQuarantine: false,
    reason: null,
    retryAfter: null,
    restart: false,
    skipDiscovery: false,
    verdictFile: null,
    reviewOutput: null,
    verdictFileRequested: false,
    reviewOutputRequested: false,
    verdictStdin: false,
    critiqueReport: null,
    critiqueReportRequested: false,
    reportFile: null,
    reportStdin: false,
    reportFileRequested: false,
    planPath: null,
    planDir: null,
    planPathRequested: false,
    planDirRequested: false,
    refuteSpecs: [],
    refuteRequested: false
  };

  const positional: string[] = [];
  // Issue #248: the diagnostic channel for unrecognised tokens. The parser is
  // deliberately non-throwing (main() parses speculatively inside a swallowing
  // try/catch, so a throw here would be swallowed and resurface as `Fatal:` +
  // stack); the return value is the channel.
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--commit-after') {
      options.commitAfter = true;
    } else if (arg === '--step') {
      options.step = true;
    } else if (arg === '--yolo') {
      options.yolo = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--staged' || arg === '-s') {
      options.staged = true;
    } else if (arg === '--worktree') {
      options.worktree = true;
      options.noWorktree = false;
    } else if (arg === '--no-worktree') {
      options.worktree = false;
      options.noWorktree = true;
    } else if (arg === '--keep-worktree') {
      options.keepWorktree = true;
    } else if (arg === '--subagents') {
      options.subagents = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--prune-stale') {
      options.pruneStale = true;
    } else if (arg.startsWith('--prune-stale=')) {
      options.pruneStale = arg.split('=')[1] !== 'false';
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--quarantine') {
      options.quarantine = true;
    } else if (arg === '--no-quarantine' || arg === '--keep-worktrees') {
      // #266 AC-5. `--keep-worktrees` is PLURAL and distinct from the existing
      // singular `--keep-worktree` (keep the worktree after commit), so this is
      // matched by exact equality only — never by prefix.
      options.noQuarantine = true;
    } else if (arg === '--reason') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.reason = args[++i];
      } else {
        options.reason = null;
      }
    } else if (arg.startsWith('--reason=')) {
      options.reason = arg.split('=')[1] || null;
    } else if (arg === '--retry-after') {
      if (i + 1 < args.length) {
        const next = args[i + 1];
        // A negative-looking token (`-5`) is captured so the halt handler can
        // reject it as invalid; any other flag means the value was omitted.
        if (!next.startsWith('-') || /^-\d/.test(next)) {
          options.retryAfter = args[++i];
        } else {
          options.retryAfter = null;
        }
      } else {
        options.retryAfter = null;
      }
    } else if (arg.startsWith('--retry-after=')) {
      options.retryAfter = arg.split('=')[1] || null;
    } else if (arg === '--base-branch') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.baseBranch = args[++i];
      } else {
        options.baseBranch = null;
      }
    } else if (arg.startsWith('--base-branch=')) {
      options.baseBranch = arg.split('=')[1] || null;
    } else if (arg === '--message' || arg === '-m') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.message = args[++i];
      } else {
        options.message = null;
      }
    } else if (arg.startsWith('--message=')) {
      options.message = arg.split('=')[1] || null;
    } else if (arg === '--message-file') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.messageFile = args[++i];
      } else {
        options.messageFile = null;
      }
    } else if (arg.startsWith('--message-file=')) {
      options.messageFile = arg.split('=')[1] || null;
    } else if (arg === FLAG_PLAN_PATH) {
      // Issue #267: implemented, never silently discarded. A missing value is
      // recorded as requested-but-null so runCli can fail loudly (mirrors the
      // `--verdict-file` contract from #269).
      options.planPathRequested = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.planPath = args[++i];
      } else {
        options.planPath = null;
      }
    } else if (arg.startsWith(`${FLAG_PLAN_PATH}=`)) {
      options.planPathRequested = true;
      options.planPath = arg.split('=')[1] || null;
    } else if (arg === FLAG_PLAN_DIR) {
      options.planDirRequested = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.planDir = args[++i];
      } else {
        options.planDir = null;
      }
    } else if (arg.startsWith(`${FLAG_PLAN_DIR}=`)) {
      options.planDirRequested = true;
      options.planDir = arg.split('=')[1] || null;
    } else if (arg === '--refute') {
      // Issue #349: the operator refutation channel. A missing value is
      // RECORDED (`refuteRequested` with no spec) and refused later, so the
      // parser never throws and the diagnostic names the flag, not a stack.
      options.refuteRequested = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.refuteSpecs.push(args[++i]);
      }
    } else if (arg.startsWith('--refute=')) {
      options.refuteRequested = true;
      const refuteValue = arg.slice('--refute='.length);
      if (refuteValue.length > 0) {
        options.refuteSpecs.push(refuteValue);
      }
    } else if (arg === FLAG_VERDICT_FILE) {
      // A flag whose value is missing sets the option to `null` — never a
      // silent default (issue #269): a verdict that was never read must fail
      // loudly, not fall through to the critique path. The `...Requested`
      // marker records that the flag WAS given, so the review command can
      // tell "no value" apart from "no flag" (issue #269, R1).
      options.verdictFileRequested = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.verdictFile = args[++i];
      } else {
        options.verdictFile = null;
      }
    } else if (arg.startsWith(`${FLAG_VERDICT_FILE}=`)) {
      options.verdictFileRequested = true;
      options.verdictFile = arg.split('=')[1] || null;
    } else if (arg === FLAG_REVIEW_OUTPUT) {
      options.reviewOutputRequested = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.reviewOutput = args[++i];
      } else {
        options.reviewOutput = null;
      }
    } else if (arg.startsWith(`${FLAG_REVIEW_OUTPUT}=`)) {
      options.reviewOutputRequested = true;
      options.reviewOutput = arg.split('=')[1] || null;
    } else if (arg === FLAG_VERDICT_STDIN) {
      options.verdictStdin = true;
    } else if (arg.startsWith(`${FLAG_VERDICT_STDIN}=`)) {
      options.verdictStdin = arg.split('=')[1] !== 'false';
    } else if (arg === FLAG_CRITIQUE_REPORT) {
      // Issue #297: the Tier 1 evidence channel. A literal `-` is a VALUE
      // (stdin), never a missing value — so it is accepted even though it
      // starts with a dash.
      options.critiqueReportRequested = true;
      if (i + 1 < args.length && (args[i + 1] === CRITIQUE_REPORT_STDIN || !args[i + 1].startsWith('-'))) {
        options.critiqueReport = args[++i];
      } else {
        options.critiqueReport = null;
      }
    } else if (arg.startsWith(`${FLAG_CRITIQUE_REPORT}=`)) {
      options.critiqueReportRequested = true;
      options.critiqueReport = arg.split('=')[1] || null;
    } else if (arg === FLAG_REPORT_FILE) {
      // Issue #284: the gate evidence channel. A literal `-` is a VALUE (stdin).
      options.reportFileRequested = true;
      if (i + 1 < args.length && (args[i + 1] === '-' || !args[i + 1].startsWith('-'))) {
        options.reportFile = args[++i];
      } else {
        options.reportFile = null;
      }
    } else if (arg.startsWith(`${FLAG_REPORT_FILE}=`)) {
      options.reportFileRequested = true;
      options.reportFile = arg.split('=')[1] || null;
    } else if (arg === FLAG_REPORT_STDIN) {
      options.reportStdin = true;
    } else if (arg.startsWith(`${FLAG_REPORT_STDIN}=`)) {
      options.reportStdin = arg.split('=')[1] !== 'false';
    } else if (arg === '--create-pr') {
      options.createPr = true;
    } else if (arg === '--restart') {
      // `next`-scoped: only read in the `next` case, where it is the single
      // authorisation to destroy a COMPLETED checkpoint (issue #237).
      options.restart = true;
    } else if (arg.startsWith('--restart=')) {
      options.restart = arg.split('=')[1] !== 'false';
    } else if (arg === '--skip-discovery') {
      options.skipDiscovery = true;
    } else if (arg.startsWith('--skip-discovery=')) {
      options.skipDiscovery = arg.split('=')[1] !== 'false';
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--refresh') {
      options.refresh = true;
    } else if (arg === '--issue') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.issue = args[++i];
      } else {
        options.issue = null;
      }
    } else if (arg.startsWith('--issue=')) {
      options.issue = arg.split('=')[1] || null;
    } else if (arg === '--title') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.title = args[++i];
      } else {
        options.title = null;
      }
    } else if (arg.startsWith('--title=')) {
      options.title = arg.split('=')[1] || null;
    } else if (arg === '--type') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.type = args[++i];
      } else {
        options.type = null;
      }
    } else if (arg.startsWith('--type=')) {
      options.type = arg.split('=')[1] || null;
    } else if (arg === '--config') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.configPath = args[++i];
      } else {
        options.configPath = null;
      }
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.split('=')[1] || null;
    } else if (arg === '--model') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.model = args[++i];
      } else {
        options.model = null;
      }
    } else if (arg.startsWith('--model=')) {
      options.model = arg.split('=')[1] || null;
    } else if (arg === '--workspace' || arg === '--workspace-dir') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.workspaceDir = args[++i];
      }
    } else if (arg.startsWith('--workspace=')) {
      options.workspaceDir = arg.split('=')[1] || undefined;
    } else if (arg.startsWith('--workspace-dir=')) {
      options.workspaceDir = arg.split('=')[1] || undefined;
    } else if (arg === '--') {
      // Conventional end-of-options: everything after it is positional, so
      // `codeloop status -- --json` runs `status` with `--json` as a positional
      // rather than inventing an unknown flag (#248, R15).
      positional.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith('-') && arg !== '-') {
      // The terminal branch that did not exist: an unrecognised flag is
      // RECORDED, never silently discarded (#248). `runCli` rejects the whole
      // invocation before dispatch. A bare `-` is a positional.
      unknownFlags.push(arg);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    let cmdIndex = 0;

    const match0 = positional[0].match(REGEX_POSITIONAL_ISSUE_ID);
    if (match0) {
      options.issue = match0[1];
      cmdIndex = 1;
    }

    if (cmdIndex < positional.length) {
      command = positional[cmdIndex];

      if (command === 'transition' && cmdIndex + 1 < positional.length) {
        options.stageArg = positional[cmdIndex + 1].toUpperCase();
      } else if (command === 'prompt' && cmdIndex + 1 < positional.length) {
        options.roleArg = positional[cmdIndex + 1].toLowerCase();
      } else if (command === 'worktree') {
        options.worktreeSubcommand = cmdIndex + 1 < positional.length ? positional[cmdIndex + 1].toLowerCase() : 'list';
        options.worktreeTarget = cmdIndex + 2 < positional.length ? positional[cmdIndex + 2] : null;
      } else if (command === 'release') {
        options.phaseBranch = cmdIndex + 1 < positional.length ? positional[cmdIndex + 1] : null;
      } else if (command === 'critique') {
        options.critiqueSubcommand = cmdIndex + 1 < positional.length ? positional[cmdIndex + 1].toLowerCase() : 'status';
      } else if (command === 'opencode') {
        options.opencodeSubcommand = cmdIndex + 1 < positional.length ? positional[cmdIndex + 1].toLowerCase() : 'install';
      } else if (command === 'triage') {
        options.triageAction = cmdIndex + 1 < positional.length ? positional[cmdIndex + 1].toLowerCase() : null;
      } else if (cmdIndex + 1 < positional.length) {
        const matchNext = positional[cmdIndex + 1].match(REGEX_POSITIONAL_ISSUE_ID);
        if (matchNext) {
          options.issue = matchNext[1];
        }
      }
    }
  }

  return { command, options, unknownFlags };
}

/**
 * Renders the diagnostic for a verdict flag that carried no value
 * (issue #269, R1).
 *
 * The message names the offending flag and states the two facts the operator
 * needs: NOTHING was recorded, and the review did NOT run (so the pipeline
 * was not advanced by a verdict the reviewer never gave).
 */
export function formatVerdictInputMissing(flag: string, hint: string): string {
  return NOTE_VERDICT_INPUT_MISSING.replace('{flag}', flag).replace('{hint}', hint);
}

/**
 * The stage badge, coloured through the ONE colour policy (#339 items 8/9).
 *
 * `opts` exists so tests (and only tests) can inject a stream/env pair; the
 * production call sites pass nothing and get `(process.stdout, process.env)` —
 * piped output, `NO_COLOR` and `TERM=dumb` therefore all render plain, and a
 * TTY-attached render keeps its colour. When colour is off NO escape AND NO
 * reset byte is emitted (the old code always appended the reset sequence).
 */
export function formatStageBadge(
  stage: string,
  opts?: { readonly stream?: ColorStream; readonly env?: NodeJS.ProcessEnv }
): string {
  const code = STAGE_COLOR_CODES[stage];
  return code ? paint(code, `[${stage}]`, opts?.stream, opts?.env) : `[${stage}]`;
}

/**
 * Renders what the dismissal route really achieved.
 *
 * A dismissal that replied to 7 of 28 threads is NOT a dismissal, so it must
 * never be rendered with the same unqualified success line as a complete one.
 * A dismissal that handled nothing at all is not a dismissal either — it ran,
 * dismissed nothing, and must say so. It still reports its counters: a run
 * over an already-dismissed PR replied to nothing BECAUSE everything was
 * already answered, and the operator must be able to see that.
 */
/**
 * The indented count and failure lines of a dismissal report (#336).
 *
 * ONE source for both renderers: the success renderer and the refusal
 * renderer must never disagree about what a run achieved — a refusal that
 * hides the failures that caused it is the same class of lie as the phantom
 * dismissal.
 */
export function dismissCountLines(report: TriageDismissReport): string[] {
  const threadFailures = report.failures.filter((f) => f.scope === 'thread').length;
  const conversationFailures = report.failures.filter((f) => f.scope === 'conversation').length;

  const lines = [
    `${LABEL_DISMISS_THREADS}  : ${report.threadsReplied} replied, ${report.threadsResolved} resolved, ${report.threadsSkipped} skipped (${NOTE_DISMISS_ALREADY_ANSWERED}), ${threadFailures} failed`,
    `${LABEL_DISMISS_CONVERSATION} : ${report.conversationsReplied} replied, ${report.conversationsSkipped} skipped (${report.conversationsAlreadyAnswered} ${NOTE_DISMISS_ALREADY_ANSWERED}, ${report.conversationsDuplicate} ${NOTE_DISMISS_DUPLICATE_FEEDBACK}), ${report.conversationsIgnored} ignored (${NOTE_DISMISS_OWN_REPLY}), ${report.conversationsPriorAnswers} ignored (${NOTE_DISMISS_PRIOR_ANSWER}), ${conversationFailures} failed`,
    `${LABEL_DISMISS_SURFACES}       : ${report.surfaces.length > 0 ? report.surfaces.join(', ') : LABEL_DISMISS_NO_SURFACE}`
  ];

  if (report.failures.length > 0) {
    lines.push(`${LABEL_DISMISS_FAILURES}        : ${report.failures.length}`);
    const shown = report.failures.slice(0, DISMISS_FAILURE_DETAIL_LIMIT);
    for (const failure of shown) {
      lines.push(`  - ${failure.scope} ${failure.target}: ${failure.error}`);
    }
    if (report.failures.length > shown.length) {
      lines.push(`  - ... and ${report.failures.length - shown.length} more failure(s)`);
    }
  }

  return lines;
}

/**
 * Renders a REFUSED dismissal, or the dry run that predicts one (#336).
 *
 * The refusal is printed to stdout, like the rest of the triage report: the
 * banner and the fetched comments are already there, and splitting one report
 * across two streams makes the ordering unpredictable. The exit code is the
 * machine signal.
 */
export function printTriageRefusal(
  refusal: TriageRefusal,
  dismissal?: TriageDismissReport,
  dryRun = false
): void {
  const prefix = dryRun ? '[dry-run] ' : '';
  console.log(`${prefix}✗ Triage Action : ${DISMISS_OUTCOME_REFUSED} — ${refusal.reason}`);
  if (dismissal) {
    for (const line of dismissCountLines(dismissal)) {
      console.log(`  ${line}`);
    }
  }
}

export function printTriageDismissOutcome(report?: TriageDismissReport): void {
  if (!report || !report.attempted) {
    const reason = report?.skippedReason ?? NOTE_DISMISS_NOTHING;
    console.log(`⚠ Triage Action : ${DISMISS_OUTCOME_NOTHING} — ${reason}`);
    return;
  }

  // The ONE definition of "performed" (#336): the use case refuses a
  // zero-item dismissal with the same computation, so the refusal and this
  // rendering cannot disagree.
  const performed = dismissalPerformed(report);

  // The dismissal ran, but it replied to nothing, resolved nothing and
  // answered nothing. Whatever the failure count says, a dismissal that
  // handled zero items is not a dismissal, so it never wears the unqualified
  // success line.
  const nothingHandled = performed === 0 && report.failures.length === 0;

  let badge = '✓';
  let outcome: string = DISMISS_OUTCOME_COMPLETE;
  if (nothingHandled) {
    badge = '⚠';
    outcome = DISMISS_OUTCOME_NOTHING;
  } else if (report.failures.length > 0) {
    outcome = performed > 0 ? DISMISS_OUTCOME_PARTIAL : DISMISS_OUTCOME_FAILED;
    badge = performed > 0 ? '⚠' : '✗';
  }

  if (nothingHandled) {
    console.log(`${badge} Triage Action : ${outcome} — ${NOTE_DISMISS_NOTHING_HANDLED}`);
  } else {
    console.log(`${badge} Triage Action : ${outcome}`);
  }
  for (const line of dismissCountLines(report)) {
    console.log(`  ${line}`);
  }
}

/**
 * Shared diagnostic for lifecycle halts caused by provider quota exhaustion or a
 * tripped circuit breaker (issue #218 AC4). Returns the exit code when the error
 * was handled, or `null` so the caller keeps its existing handling.
 *
 * Quota failures get a dedicated exit code so CI can distinguish "provider said
 * no" from an ordinary lifecycle failure.
 */
export function lifecycleHaltExitCode(err: unknown): number | null {
  if (err instanceof QuotaExhaustedError) {
    console.error(`\n🛑 Provider quota exhausted.\n${err.message}\n`);
    console.error(`State is checkpointed — re-run \`${QUOTA_RESUME_COMMAND}\` once the quota window resets.\n`);
    return EXIT_CODE_QUOTA_EXHAUSTED;
  }

  if (err instanceof CircuitBreakerTrippedError) {
    console.error(`\n🛑 ${err.message}\n`);
    console.error(`State is checkpointed — re-run \`${QUOTA_RESUME_COMMAND}\` after the blocking condition clears.\n`);
    return EXIT_CODE_FAILURE;
  }

  return null;
}

/**
 * Reports a persisted circuit-breaker halt (quota exhaustion or exhausted retries)
 * from a lifecycle result and returns its exit code, or `null` when the pipeline is
 * not halted at the breaker gate.
 */
export function persistedHaltExitCode(
  result: {
    readonly pausedAtGate?: string | null;
    readonly quotaExhausted?: boolean;
    readonly message?: string;
  }
): number | null {
  if (result.pausedAtGate !== GATE_CIRCUIT_BREAKER) {
    return null;
  }
  console.error(`\n🛑 ${result.message ?? 'Circuit breaker halted the pipeline.'}`);
  console.error(`State is checkpointed — re-run \`${QUOTA_RESUME_COMMAND}\` after the blocking condition clears.\n`);
  return result.quotaExhausted ? EXIT_CODE_QUOTA_EXHAUSTED : EXIT_CODE_FAILURE;
}

/**
 * Projects the `codeloop resume --json` payload. Machine-readable output must not leak
 * the rehydrated `StateMachine` the use case returns: its private fields are a domain
 * implementation detail, and the primitives below are what a caller actually needs.
 */
function buildResumeJsonPayload(result: {
  readonly success: boolean;
  readonly resumed: boolean;
  readonly persisted: boolean;
  readonly pausedAtGate: string | null;
  readonly pausedAtTimestamp: string | null;
  readonly totalHumanWaitMs: number;
  readonly currentStage: string | null;
  readonly mode: string | null;
  readonly issue: number | null;
  readonly message: string;
  readonly resolvedFromIssue: number | null;
  readonly resolvedFromPath: string | null;
}, dryRun: boolean): Record<string, unknown> {
  return {
    success: result.success,
    dryRun,
    resumed: result.resumed,
    persisted: result.persisted,
    pausedAtGate: result.pausedAtGate,
    pausedAtTimestamp: result.pausedAtTimestamp,
    totalHumanWaitMs: result.totalHumanWaitMs,
    currentStage: result.currentStage,
    mode: result.mode,
    issue: result.issue,
    // Issue #252.1: JSON parity with the human `Task : #n (path)` line.
    resolvedFromIssue: result.resolvedFromIssue,
    resolvedFromPath: result.resolvedFromPath,
    message: result.message
  };
}

/**
 * Prints the implementer dispatch directive for the YOLO implementation park
 * (issue #259).
 *
 * The payload is produced by the SAME `GetNextActionUseCase` that
 * `codeloop next` uses, so the two can never drift. `buildImplementAction`
 * asserts the Zero-Direct-Root-Mutation invariant and THROWS when there is no
 * worktree (the `--no-worktree` / no-issue case): the park still succeeds and
 * simply omits the payload — the park message already names `codeloop next`.
 *
 * `issue` is the ALREADY-PARSED issue number (issue #250): the raw `--issue`
 * token never reaches a use case.
 */
async function printImplementerDirective(
  stateRepo: StateRepository,
  configRepo: ConfigRepository,
  planGenerator: PlanGeneratorPort,
  githubGateway: GitHubGateway,
  worktreeManager: WorktreeManagerPort,
  buildDetector: BuildDetectorPort,
  inferBaseBranchUseCase: InferBaseBranchUseCase,
  implementationProbe: ImplementationProbe,
  configPath: string | null,
  issue: number | undefined,
  critique: CritiquePort
): Promise<void> {
  try {
    const getNextActionUseCase = new GetNextActionUseCase(
      stateRepo,
      configRepo,
      planGenerator,
      githubGateway,
      undefined,
      worktreeManager,
      buildDetector,
      inferBaseBranchUseCase,
      critique,
      implementationProbe
    );

    const directive = await getNextActionUseCase.execute({
      configPath,
      issue
    });

    if (!directive.invocationPayload) {
      return;
    }

    console.log('--- invoke_subagent JSON Payload ---');
    console.log(JSON.stringify(directive.invocationPayload, null, 2));
    console.log('\nPass this payload directly to invoke_subagent or copy into chat.\n');
  } catch {
    // No worktree (or no directive available): the park message already names
    // `codeloop next`, so omitting the payload keeps the park truthful.
  }
}

/**
 * Resolves the authoritative checkpoint for a command and returns the scope.
 *
 * CHOKEPOINT 2 (issue #250, Scope A): ONE answer to "which checkpoint is
 * authoritative, and which repository must be read AND written".
 *
 * The scope is ALWAYS resolved from the SAME repository the CLI constructed —
 * never from a repository that a previous scope already narrowed. Resolving a
 * scope from an already-scoped repository drops the ROOT from the candidate set
 * and can select a DIFFERENT file than `status`/`resume` select, which is
 * exactly the disagreement this issue removes. `scope.repo` is therefore only
 * ever a WRITE target; it is never re-resolved.
 */
async function resolveScope(
  stateRepo: StateRepository,
  issue: number | undefined
): Promise<CheckpointScope> {
  return resolveCheckpointScope(stateRepo, issue);
}

/**
 * Resolves the scope for a command whose WORK must not depend on the
 * checkpoint being readable, and reports the failure instead of throwing it.
 *
 * `abort` is the emergency teardown, and a corrupt `tasks/<n>.json` is
 * PRECISELY the state an operator aborts FROM — the resolver's own note says
 * saves use a plain `writeFileSync`, so a crash mid-write leaves a truncated
 * file. The strict resolver deliberately lets an unreadable NAMED checkpoint
 * throw, which is right for a command that must READ the snapshot, and wrong
 * for the one command whose job is to clean up after a broken state: the
 * teardown (process termination, `.git/index.lock` clearing, worktree
 * quarantine, container termination) must still run.
 *
 * The scope is still resolved when it CAN be, so `abort --issue 999` addresses
 * `tasks/999.json`; when it cannot, the repository bound to the SAME issue is
 * used. The abort use case only reads the checkpoint for an OPTIONAL audit log,
 * and that read is already wrapped in a try/catch of its own.
 */
async function resolveScopeTolerantly(
  stateRepo: StateRepository,
  issue: number | undefined
): Promise<{ repo: StateRepository; error: unknown }> {
  // `error` is `unknown`, NOT `unknown | null` — the latter collapses to
  // `unknown` and loses the fact that `null` is the "no failure" sentinel. The
  // caller MUST therefore test `error !== null` explicitly: a truthiness test
  // would silently swallow a thrown `undefined`/`0`/`''` as "no failure".
  try {
    return { repo: (await resolveScope(stateRepo, issue)).repo, error: null };
  } catch (error) {
    let repo = stateRepo;
    if (issue !== undefined && stateRepo.forIssue) {
      try {
        repo = stateRepo.forIssue(issue);
      } catch {
        // The issue itself is unusable — the unscoped repository is the last
        // resort, and the abort use case tolerates an unreadable checkpoint.
        repo = stateRepo;
      }
    }
    return { repo, error };
  }
}

/**
 * Separates a checkpoint's recorded worktree path into LIVE vs STALE
 * (issue #282, absorbed #273).
 *
 * A removal that cleared the descriptor is the repair, but a descriptor written
 * by an older build — or one whose directory was deleted out of band — is still
 * on disk. The read-only diagnostics must therefore check existence before
 * advertising a path, and say "stale" instead of printing a directory that is
 * gone. They never write: repairing the checkpoint remains the operator's
 * `codeloop worktree remove <id> --prune-stale` job (#250, AC A4).
 */
function describeWorktreeTruth(worktreePath: string | null | undefined): {
  livePath: string | null;
  stalePath: string | null;
} {
  if (!worktreePath) return { livePath: null, stalePath: null };
  try {
    if (fs.statSync(worktreePath).isDirectory()) {
      return { livePath: worktreePath, stalePath: null };
    }
  } catch {
    // Missing or unreadable -> stale.
  }
  return { livePath: null, stalePath: worktreePath };
}

/** Stands in for a dead path wherever a directive would otherwise hand it to a subagent. */
const STALE_WORKTREE_PLACEHOLDER = '<stale worktree — path no longer exists>';

/**
 * Builds the stale-descriptor remediation with the REAL task token.
 *
 * `NOTE_WORKTREE_STALE` carries `{id}` because the constant cannot know which
 * task is being reported. The placeholder is filled from `--issue` when known,
 * otherwise from the last segment of the recorded path (`.worktrees/42` -> 42),
 * so the printed command is one the operator can paste and run (#282 review
 * iteration 2: the old text named a command guaranteed to fail for a missing
 * directory).
 */
function formatStaleWorktreeNote(worktreePath: string, issue?: number | null): string {
  const segments = worktreePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const id =
    issue !== undefined && issue !== null
      ? String(issue)
      : segments.length > 0
        ? segments[segments.length - 1]
        : '<id>';
  return NOTE_WORKTREE_STALE.replace('{id}', id);
}

/**
 * Renders the delivery state a COMPLETED run recorded (issue #315, AC-24).
 *
 * A terminal stage is NOT proof of delivery: the #327 run reached COMPLETED with
 * the branch pushed and no PR. `missing` (and an unrecorded legacy checkpoint)
 * therefore says so explicitly rather than implying the milestone has the work.
 */
function formatPullRequestDelivery(
  pullRequest:
    | {
        readonly number: number | null;
        readonly url: string | null;
        readonly status: 'created' | 'existing' | 'missing';
      }
    | null
    | undefined,
  disposition?: { readonly prNumber: number } | null
): string {
  if (!pullRequest || pullRequest.status === 'missing') {
    if (disposition) {
      // The triage PR is evidence that a PR EXISTED; the delivery record is
      // simply absent. Saying "no PR recorded" would contradict `next`, which
      // names the same PR (#336 Defect 2).
      return `pushed, NOT delivered (delivery PR not recorded; triage disposition names PR #${disposition.prNumber})`;
    }
    return 'pushed, NOT delivered (no PR recorded)';
  }
  const ref = pullRequest.number !== null ? `PR #${pullRequest.number}` : 'PR';
  if (pullRequest.url) {
    return `${ref} (${pullRequest.url})`;
  }
  return pullRequest.status === 'created' ? `${ref} (created; URL unavailable)` : ref;
}

/**
 * Removes a stale worktree path from a `next` directive (#282 review).
 *
 * `GetNextActionUseCase` builds its stage-specific prompts and summary from the
 * raw descriptor and cannot check existence (no `fs` in the application layer).
 * Presenting that dead path as `Cwd:` would dispatch a subagent into a
 * directory that is gone, so the PRESENTATION layer redacts it and names the
 * repair instead. Live paths are returned untouched.
 */
function redactStaleWorktreeArtifacts<
  T extends {
    humanSummary: string;
    invocationPayload?: {
      Subagents: ReadonlyArray<{ Prompt: string; Workspace?: string }>;
    } | null;
  }
>(result: T, stalePath: string | null, remediation: string): T {
  if (!stalePath) return result;
  const replacement = `${STALE_WORKTREE_PLACEHOLDER}; ${remediation}`;
  const redact = (text: string): string => text.split(stalePath).join(replacement);

  const payload = result.invocationPayload
    ? {
        ...result.invocationPayload,
        Subagents: result.invocationPayload.Subagents.map((item) => ({
          ...item,
          Prompt: redact(item.Prompt),
          ...(typeof item.Workspace === 'string' ? { Workspace: redact(item.Workspace) } : {})
        }))
      }
    : result.invocationPayload;

  return {
    ...result,
    humanSummary: redact(result.humanSummary),
    invocationPayload: payload
  } as T;
}

/**
 * Renders the abort's worktree section truthfully (issue #266 AC-4).
 *
 * The emergency abort used to print only a count and a `(stashed)` marker, so an
 * operator whose files had moved into a stash was never told WHERE they went.
 * Every touched worktree now carries the one reference that restores it, and
 * every worktree deliberately left alone names its reason. Quarantine FAILURES
 * go to stderr with `⚠`; the abort itself still exits 0 — it is a best-effort
 * teardown and a non-zero exit would imply the teardown did not happen.
 */
function renderAbortQuarantine(result: AbortPipelineResult): void {
  const { worktreesQuarantined, worktreesQuarantineSkipped, worktreesQuarantineFailed } =
    result;

  if (worktreesQuarantined.length === 0 && result.worktreeScopePath === null) {
    console.log(`  - Worktrees quarantined    : ${NOTE_ABORT_NO_WORKTREE_LABEL}`);
  } else {
    console.log(`  - Worktrees quarantined    : ${worktreesQuarantined.length}`);
    for (const wt of worktreesQuarantined) {
      if (wt.branch) {
        console.log(`    * ${wt.worktreePath} (branch: ${wt.branch})`);
        console.log(`      recover: git -C ${wt.worktreePath} checkout ${wt.branch}`);
      } else if (wt.stashRef) {
        console.log(`    * ${wt.worktreePath} (stash: ${wt.stashRef})`);
        console.log(`      recover: git -C ${wt.worktreePath} stash pop ${wt.stashRef}`);
        if (wt.stashMessage) {
          console.log(`      stash message: ${wt.stashMessage}`);
        }
      } else if (wt.stashMessage) {
        // Never claim a ref that could not be resolved: the message is the only
        // stable handle on a stash list whose index a concurrent push can shift.
        console.log(`    * ${wt.worktreePath} (stash: unresolved)`);
        console.log(
          `      recover: run \`git stash list\` and \`git stash pop <ref>\` (stash message: ${wt.stashMessage})`
        );
      } else if (wt.stashed) {
        console.log(`    * ${wt.worktreePath} (stashed)`);
        console.log(
          `      recover: run \`git -C ${wt.worktreePath} stash list\` and \`git stash pop <ref>\``
        );
      } else {
        console.log(`    * ${wt.worktreePath} (quarantined)`);
      }
    }
  }

  if (worktreesQuarantineSkipped.length > 0) {
    console.log(`  - Worktrees left untouched : ${worktreesQuarantineSkipped.length}`);
    for (const skipped of worktreesQuarantineSkipped) {
      console.log(`    * ${skipped.worktreePath} — ${skipped.reason}`);
    }
  }

  if (worktreesQuarantineFailed.length > 0) {
    console.error(`  - Worktree quarantine FAILED: ${worktreesQuarantineFailed.length}`);
    for (const failed of worktreesQuarantineFailed) {
      console.error(`    * ${failed.worktreePath} — ${failed.error}`);
    }
  }
}

/**
 * Renders the plan-artifact summary truthfully (issues #240/Defect 5, #299).
 *
 * `📁 Initialized plan directory` is printed ONLY when a directory was actually
 * created; an existing directory says so. A discovery scaffold names BOTH
 * artifacts — the RCA report and the technical specification — because they no
 * longer carry the same content.
 */
function printPlanScaffoldSummary(info: {
  readonly type: string;
  readonly directoryCreated: boolean;
  readonly folderName: string;
  readonly planDir: string;
  readonly planPath: string;
  readonly mirrorPath: string;
  readonly summaryPath: string;
}): void {
  const verb = info.directoryCreated
    ? '📁 Initialized plan directory'
    : '📁 Using existing plan directory';
  // Print the ACTUAL target, relative to cwd when it is inside the workspace,
  // otherwise absolute. Always prefixing `artifacts/plans/` named a location
  // that did not exist for `--plan-dir` (issue #240/Defect 5).
  const absoluteDir = path.resolve(info.planDir);
  const relativeDir = path.relative(process.cwd(), absoluteDir);
  const displayDir =
    relativeDir.length > 0 && !relativeDir.startsWith('..') && !path.isAbsolute(relativeDir)
      ? `${relativeDir.split(path.sep).join('/')}/`
      : `${absoluteDir}/`;
  console.log(`${verb}: ${displayDir}`);
  if (info.type === 'discovery') {
    console.log(`  ✓ Discovery Report (discovery): ${path.basename(info.planPath)}`);
    console.log(`  ✓ Specification (implementation): ${path.basename(info.mirrorPath)}`);
  } else {
    console.log(`  ✓ Specification (implementation): ${path.basename(info.planPath)}`);
    // #339 (audit extra E4): one path must be named once. The adoption path
    // hands back `implementation_plan.md` for BOTH `planPath` and
    // `mirrorPath`, and printing it under two labels read as two files.
    if (info.mirrorPath && path.basename(info.mirrorPath) !== path.basename(info.planPath)) {
      console.log(`  ✓ Canonical Mirror  : ${path.basename(info.mirrorPath)}`);
    }
  }
  console.log(`  ✓ Execution Log     : ${path.basename(info.summaryPath)}`);
}

/**
 * Renders the operator-supplied plan summary (issue #267). A supplied plan
 * means NO scaffold happened, so no scaffold line may be printed.
 */
function printSuppliedPlanSummary(planPath: string, currentStage?: string): void {
  console.log(`📄 Using supplied plan: ${planPath}`);
  if (currentStage === STAGE_IMPLEMENT) {
    console.log(`Next: run codeloop next to obtain the implementer directive.`);
  }
}

/**
 * Issue #315 (Defect A): a human report piped into a short consumer is normal
 * usage — `codeloop status | head -n 1`, `| less` (quit early) — and until now
 * the second write after the reader closed threw an unhandled `EPIPE` and
 * killed the process with a stack trace and exit 1.
 *
 * The guard is installed ONCE, here in the entrypoint, so it covers every human
 * report rather than `status` alone. It reacts to the stream-level error only:
 *
 * - `EPIPE` / `ECONNRESET` — the consumer went away. The report has nowhere
 *   left to go, and refusing to exit 0 would turn a pager into a failure.
 * - Any other write error (`EIO`, `ENOSPC`, …) is a REAL failure and is
 *   re-thrown on the next tick, exactly as Node would have done — the guard
 *   must never swallow it into a success exit.
 */
let streamErrorGuardsInstalled = false;

export function installStreamErrorGuards(): void {
  if (streamErrorGuardsInstalled) {
    return;
  }
  streamErrorGuardsInstalled = true;

  const handleStreamError = (err: NodeJS.ErrnoException): void => {
    if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) {
      process.exitCode = EXIT_CODE_SUCCESS;
      process.exit(EXIT_CODE_SUCCESS);
    }
    process.nextTick(() => {
      throw err;
    });
  };

  process.stdout.on('error', handleStreamError);
  process.stderr.on('error', handleStreamError);
}

export async function runCli(rawArgs: readonly string[] = process.argv.slice(2)): Promise<number> {
  // Issue #315 (Defect A): FIRST statement, before any command can write. The
  // guard lives in the entrypoint so `bin/codeloop.js` and every in-process
  // caller (the dist-level suites included) get it.
  installStreamErrorGuards();

  const { command, options, unknownFlags } = parseArguments(rawArgs);

  // Issue #248: unknown flags are rejected FIRST — before help, before version
  // and before any adapter, repository load or command body. A misspelled
  // `--dry-runn` must never become "no --dry-run at all" (#248 AC-248.9/10).
  const unknownViolations = validateUnknownFlags(unknownFlags);
  if (unknownViolations.length > 0) {
    for (const line of unknownViolations) {
      console.error(line);
    }
    return EXIT_CODE_FAILURE;
  }

  if (options.help) {
    printHelp();
    return EXIT_CODE_SUCCESS;
  }

  if (options.version) {
    console.log(`codeloop v${CLI_VERSION}`);
    return EXIT_CODE_SUCCESS;
  }

  // CHOKEPOINT 1 (issue #250, Scope B). ONE grammar for the `--issue` token,
  // applied before any command runs and before any checkpoint is read or
  // written. A token with trailing garbage is REJECTED, never clamped: the
  // four competing parsers this replaces disagreed about what `999abc` meant
  // (999 / the root / the literal file `tasks/999abc.json` / silently ignored),
  // which is how `status` came to read `tasks/999.json` while `halt` wrote
  // `.agyloop/state.json`.
  const issueToken = parseIssueToken(options.issue);
  if (issueToken.kind === 'invalid') {
    // stderr: stdout stays parseable for `--json` consumers.
    console.error(`✗ ${issueToken.message}`);
    return EXIT_CODE_FAILURE;
  }
  const issueValue: number | undefined = issueToken.kind === 'valid' ? issueToken.issue : undefined;

  // Treat 'yolo' subcommand or --yolo flag as YOLO execution. Computed BEFORE
  // the capability gate so the gate sees the command that will actually run.
  const effectiveCommand = command === null && options.yolo ? 'yolo' : command;

  // Issue #248: a flag the selected command cannot honour is a REFUSAL, not a
  // silent no-op. Runs before any adapter is constructed, so no mutation is
  // even possible (#248 AC-248.11).
  const capabilityViolations = validateCapability({
    command: effectiveCommand,
    yolo: options.yolo,
    worktreeSubcommand: options.worktreeSubcommand,
    critiqueSubcommand: options.critiqueSubcommand,
    opencodeSubcommand: options.opencodeSubcommand,
    dryRun: options.dryRun,
    json: options.json
  });
  if (capabilityViolations.length > 0) {
    for (const line of capabilityViolations) {
      console.error(line);
    }
    return EXIT_CODE_FAILURE;
  }

  // Issue #267: plan inputs are scoped to the commands that execute a plan,
  // and a present-but-valueless flag is a LOUD failure — never a silent
  // fall-through to a freshly scaffolded plan directory.
  const planInputViolations = validatePlanInputScope({
    command: effectiveCommand,
    planPathRequested: options.planPathRequested,
    planDirRequested: options.planDirRequested
  });
  const planInputMissing: string[] = [];
  if (options.planPathRequested && options.planPath === null) {
    planInputMissing.push(
      `✗ '${FLAG_PLAN_PATH}' was provided without a value. Nothing was changed; supply a plan file path (or remove the flag).`
    );
  }
  if (options.planDirRequested && options.planDir === null) {
    planInputMissing.push(
      `✗ '${FLAG_PLAN_DIR}' was provided without a value. Nothing was changed; supply a plan directory path (or remove the flag).`
    );
  }
  if (planInputViolations.length > 0 || planInputMissing.length > 0) {
    for (const line of [...planInputViolations, ...planInputMissing]) {
      console.error(line);
    }
    return EXIT_CODE_FAILURE;
  }

  // Issue #349, CHOKEPOINT 2: `--refute` is scoped to `review`, a missing value
  // is a loud failure, and every token is parsed into a `FindingRefutation`
  // BEFORE any repository is constructed — so a malformed refutation can never
  // touch state, and every command gets the same diagnostic.
  const refutations: FindingRefutation[] = [];
  const refutationViolations = validateRefutationScope({
    command: effectiveCommand,
    refuteRequested: options.refuteRequested
  });
  const refutationInvalid: string[] = [];
  if (refutationViolations.length === 0 && options.refuteRequested) {
    if (options.refuteSpecs.length === 0) {
      refutationInvalid.push(NOTE_REFUTATION_REQUIRES_VALUE);
    } else {
      for (const spec of options.refuteSpecs) {
        try {
          refutations.push(FindingRefutation.parse(spec));
        } catch (err: unknown) {
          // A ValidationError wraps the operator-facing note in its `reason`;
          // printing the wrapper ("Validation failed for field 'refute': …")
          // would bury the diagnostic the operator has to act on.
          if (err instanceof ValidationError) {
            const reason = err.details?.reason;
            refutationInvalid.push(typeof reason === 'string' ? reason : err.message);
          } else {
            refutationInvalid.push(err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
  }
  if (refutationViolations.length > 0 || refutationInvalid.length > 0) {
    for (const line of [...refutationViolations, ...refutationInvalid]) {
      console.error(line);
    }
    return EXIT_CODE_FAILURE;
  }

  // Issue #267: a supplied plan path is relative to the OPERATOR's cwd (the
  // repo root), not to the task worktree the implementation later runs in.
  // Resolve it ONCE here, so every downstream use case receives an absolute
  // path that is valid from any workspace.
  if (options.planPath) {
    options.planPath = path.resolve(options.planPath);
  }
  if (options.planDir) {
    options.planDir = path.resolve(options.planDir);
  }

  const stateRepo = new FileStateRepository({ workspaceDir: options.workspaceDir, issue: issueValue });
  const githubGateway = new CliGitHubGateway();
  const configRepo = new FileConfigRepository();
  const modelCatalog = new GeminiModelCatalog({ configRepo });
  const planGenerator = new FilePlanGenerator();
  const promptRepo = new FilePromptRepository();
  const commandExecutor = new ProcessCommandExecutor();
  const buildDetector = new FileBuildDetector();
  const standardsRepo = new FileStandardsRepository();
  const critique = new CliCritiqueGateway();
  const critiqueInstaller = new GithubCritiqueInstallerGateway();
  // Single source of truth for prompt permission (issue #218 AC6). Computed once and
  // reused by every prompt-issuing call site; also handed to the readline adapter so
  // a non-interactive session cannot block even if a caller forgets to gate.
  const promptsAllowed = computePromptsAllowed(
    options,
    Boolean(process.stdin.isTTY),
    Boolean(process.stdout.isTTY)
  );
  const confirmationPrompt = new ReadlineConfirmationPrompt({ interactive: promptsAllowed });
  const worktreeManager = new GitWorktreeManager(commandExecutor);

  const config = configRepo.loadConfig({
    customPath: options.configPath,
    model: options.model || undefined
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const runner = RunnerFactory.createRunner({
    config,
    commandExecutor
  });

  // Factories (issue #250): the lifecycle and the branch inference must be built
  // against the RESOLVED repository, so a task-scoped command writes the task
  // checkpoint and never the root. The previous single top-level instance was
  // bound to the unscoped repository, so `transition` wrote the root while
  // `status` read the task file.
  const makeLifecycleUseCase = (repo: StateRepository): RunLifecycleUseCase =>
    new RunLifecycleUseCase({
      stateRepo: repo,
      configRepo,
      planGenerator,
      githubGateway,
      commandExecutor,
      buildDetector,
      standardsRepo,
      critique,
      critiqueInstaller,
      confirmationPrompt,
      worktreeManager,
      gateReportRepo: new FileGateReportRepository({
        workspaceDir: options.workspaceDir || process.cwd(),
        issue: issueValue ?? null
      })
    });

  const makeInferBaseBranchUseCase = (repo: StateRepository): InferBaseBranchUseCase =>
    new InferBaseBranchUseCase(worktreeManager, githubGateway, repo);

  const manageCritiqueUseCase = new ManageCritiqueUseCase(critique, critiqueInstaller);

  // Issue #269: `triage` is carved out because ROUTING is the subagent's job,
  // and `halt` because the runner must be able to report quota. `review` is NOT
  // carved out (issue #297): the dispatched reviewer only EMITS a verdict block,
  // and the orchestrator — a root session, with no `AGY_SUBAGENT` marker — is
  // the one that files it. A read-only agent must not hold a command that
  // advances the checkpoint.
  if (process.env.AGY_SUBAGENT === '1' && effectiveCommand !== COMMAND_TRIAGE && effectiveCommand !== COMMAND_HALT && (STATE_MUTATING_COMMANDS as readonly (string | null)[]).includes(effectiveCommand)) {
    console.error('Error: Execution blocked. Subagents are not permitted to mutate global pipeline state.');
    console.error(`Command '${effectiveCommand === null ? '(default)' : effectiveCommand}' violates the Zero Direct Root Mutation invariant.`);
    return EXIT_CODE_FAILURE;
  }

  switch (effectiveCommand) {
    case COMMAND_INIT: {
      const workspaceDir = options.workspaceDir || process.cwd();
      const initUseCase = new InitProjectUseCase({
        commandExecutor,
        buildDetector,
        scaffolder: new FileProjectScaffolder(),
        confirmationPrompt,
        configRepo
      });
      const res = await initUseCase.execute({
        workspaceDir,
        yes: options.yes,
        interactive: promptsAllowed,
        force: options.force,
        dryRun: options.dryRun
      });

      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
        return EXIT_CODE_SUCCESS;
      }

      console.log('\n=== CodeLoop: Project Init ===');
      if (res.skipped) {
        console.log(`Config already exists at ${res.configPath}. Use --force to overwrite.`);
        return EXIT_CODE_SUCCESS;
      }
      console.log(`${res.dryRun ? '[dry-run] Would write' : '✓ Wrote'} config: ${res.configPath}`);
      if (res.migratedFrom) {
        console.log(`  Migrated legacy settings from: ${res.migratedFrom}`);
      }
      if (res.config?.git) {
        console.log(`  Git: remote=${res.config.git.remote} base=${res.config.git.baseBranch} forge=${res.config.git.forge}`);
      }
      if (res.config?.verification) {
        console.log(`  Ecosystem: ${res.config.verification.ecosystem}`);
        console.log(`  Fast checks: ${res.config.verification.fastCheck?.length ?? 0}, smoke steps: ${res.config.verification.smoke?.steps.length ?? 0}, gates: ${res.config.verification.gates?.length ?? 0}`);
      }
      const verb = res.dryRun ? 'would add' : 'added';
      if (res.gitignoreReplaced.length > 0) {
        console.log(`  .gitignore: ${res.dryRun ? 'would replace' : 'replaced'} blanket ignore(s): ${res.gitignoreReplaced.join(', ')}`);
      }
      if (res.gitignoreAdded.length > 0) {
        console.log(`  .gitignore: ${verb} ${res.gitignoreAdded.length} rule(s): ${res.gitignoreAdded.join(', ')}`);
      } else if (res.gitignoreReplaced.length === 0) {
        console.log('  .gitignore: already up to date');
      }
      console.log('');
      return EXIT_CODE_SUCCESS;
    }

    case 'next': {
      // Issue #251 AC-251.4: a corrupt NAMED checkpoint is a rendered failure,
      // not a raw stack out of `runCli`.
      try {
      // The scope is resolved from the CLI's own repository, and the use case
      // reads AND writes through `scope.repo` — so `next` can no longer
      // contradict `status` about which checkpoint is live, and the context
      // write lands in the resolved checkpoint instead of the root (#250).
      const scope = await resolveScope(stateRepo, issueValue);
      const getNextActionUseCase = new GetNextActionUseCase(
        scope.repo,
        configRepo,
        planGenerator,
        githubGateway,
        undefined,
        worktreeManager,
        buildDetector,
        makeInferBaseBranchUseCase(scope.repo),
        critique,
        new DetectImplementationDiffUseCase(commandExecutor),
        new FileGateReportRepository({ workspaceDir: options.workspaceDir || process.cwd() }),
        // Issue #389: DISCOVERY's scoped-write boundary is measured, not prose.
        new FileWorkspaceMutationProbe(commandExecutor)
      );
      const res = await getNextActionUseCase.execute({
        configPath: options.configPath,
        issue: issueValue,
        restart: options.restart,
        dryRun: options.dryRun
      });

      // A persisted gate pause (quota exhaustion, exhausted retries) must never be
      // mistaken for a runnable directive. It is read BEFORE the `--json` branch
      // because that command is what the agent harness runs (skills/agyloop/SKILL.md),
      // and a pause it cannot see is a pause it will happily execute through.
      //
      // The pause is RE-READ from `scope.repo` AFTER the use case ran (no
      // snapshot override): a TRIAGE pause that `next` itself just wrote must
      // still be reported (#250, R7). The snapshot is read once and shared with
      // the synthesised gate pause below, so `next` cannot describe two
      // different checkpoints.
      const snapshotAfter = await Promise.resolve(scope.repo.load()).catch(() => null);
      const persistedPause = await readPersistedGatePause(scope.repo, snapshotAfter);
      const pausedAtBreakerGate = persistedPause?.gate === GATE_CIRCUIT_BREAKER;

      // Issue #282: a checkpoint can carry a worktree descriptor whose
      // directory is gone. The directive's top-level `worktreePath` must be
      // truthful about that — suppressed when stale, reported alongside — and
      // the checkpoint is NOT repaired here (see `describeWorktreeTruth`).
      const worktreeTruth = describeWorktreeTruth(res.worktreePath);
      const staleRemediation = worktreeTruth.stalePath
        ? formatStaleWorktreeNote(worktreeTruth.stalePath, issueValue)
        : '';
      // A dead path must not travel inside `humanSummary` or a subagent prompt
      // as if it were a usable Cwd: redact it and name the repair (#282 review).
      const truthful = redactStaleWorktreeArtifacts(
        res,
        worktreeTruth.stalePath,
        staleRemediation
      );

      // Issue #315 (Defect E / AC-7): a HUMAN GATE is not actionable work. The
      // old rule (`actionable === pause === null`) made every unpaused
      // `human_gate` — COMMIT, the DISCOVERY plan-directory park, the missing
      // worktree gate — report `actionable: true` with `pause: null`, so a
      // harness that gates on `actionable` treated a human gate as automated
      // work. A gate that is not a PERSISTED pause still carries a pause OBJECT
      // (synthesised here), so `actionable:false` and a non-null `pause` can
      // never disagree.
      const gatePause =
        res.actionType === 'human_gate'
          ? synthesiseHumanGatePause(res, lastHistoryTimestamp(snapshotAfter))
          : null;
      const pause = persistedPause ?? gatePause;
      // Issue #337: `actionable` means "a subagent may be dispatched NOW". A
      // directive whose stage is COMPLETE (`actionType: 'advance'`), an idle
      // report ('completed') and pre-flight ('preflight') carry NO payload, so
      // they are not actionable even though none of them is a human gate.
      const actionable = persistedPause === null && res.actionType === 'subagent';

      if (options.json) {
        // Machine-readable output stays a single JSON document: the pause travels as
        // data, never as prose on stdout. `actionable` is the single boolean a harness
        // needs to decide whether to invoke the subagent.
        console.log(
          JSON.stringify(
            {
              ...truthful,
              // #275.6: every machine-readable payload states whether it was a
              // simulation. `next` is not read-only — it records context
              // fields — but `--dry-run` is honoured (issue #301) and declares
              // the suppressed writes in `wouldWrite`.
              dryRun: options.dryRun === true,
              worktreePath: worktreeTruth.livePath,
              worktreeStale: worktreeTruth.stalePath !== null,
              staleWorktreePath: worktreeTruth.stalePath,
              actionable,
              pause
            },
            null,
            2
          )
        );
        // The 🛑 banner is for a PERSISTED pause only: a human gate is the
        // pipeline's normal shape, and warning about it every time would be
        // noise the operator learns to ignore.
        //
        // Issue #315 (AC-7): a persisted COMMIT pause is the human gate's own
        // accounting record (recorded by `run-review` so the wait is
        // measurable), not a blocker — a 🛑 "run codeloop resume" banner there
        // contradicted the directive's "run codeloop commit --create-pr".
        //
        // Issue #362 (Finding 3): the predicate is now the pause's own
        // `resumeCommand` rather than a hard-coded gate exception list, which
        // is the actual rule — warn only when there is something to resume.
        // APPROVAL, CIRCUIT_BREAKER and TRIAGE keep their existing behaviour
        // without growing the list.
        if (persistedPause && persistedPause.resumeCommand !== null) {
          // Warnings go to stderr so stdout stays parseable.
          console.error(`🛑 ${persistedPause.message}`);
        }
        if (worktreeTruth.stalePath) {
          console.error(`⚠ ${worktreeTruth.stalePath}: ${staleRemediation}`);
        }
        return EXIT_CODE_SUCCESS;
      }

      console.log('\n=== CodeLoop: Next Subagent Directive ===');
      if (pausedAtBreakerGate) {
        console.log(`Status       : 🛑 ${GATE_CIRCUIT_BREAKER} — ${truthful.humanSummary}`);
        console.log('Resolve the blocking condition (e.g. wait for the provider quota window),');
        console.log(`then re-run \`${RESUME_COMMAND}\`. State is checkpointed; nothing is lost.\n`);
      }
      console.log(`Current Stage : ${formatStageBadge(truthful.currentStage)}`);
      console.log(`Next Action   : ${truthful.title}`);
      if (truthful.baseBranch) {
        console.log(`Base Branch   : ${truthful.baseBranch}`);
      }
      if (truthful.taskBranch) {
        console.log(`Task Branch   : ${truthful.taskBranch}`);
      }
      if (worktreeTruth.livePath) {
        console.log(`Target Cwd    : ${worktreeTruth.livePath}`);
      }
      if (worktreeTruth.stalePath) {
        // One warning, on stderr: stdout stays parseable, and the operator is
        // told how to repair the descriptor instead of being handed a dead path.
        console.error(`⚠ ${worktreeTruth.stalePath}: ${staleRemediation}`);
      }
      console.log(`Description   : ${truthful.description}`);
      console.log(`Summary       : ${truthful.humanSummary}`);
      // Issue #389: a measured write outside the stage's scope must be visible
      // in the human-readable directive, not only in `--json`.
      if (truthful.stageFindings && truthful.stageFindings.length > 0) {
        console.log(`Findings      : ${truthful.stageFindings.length}`);
        truthful.stageFindings.forEach((finding) => {
          console.log(`  ⚠ [${finding.rule}] ${finding.path} — ${finding.detail}`);
        });
      }
      console.log('');

      // Issue #301: a dry run reads and declares, never writes.
      if (options.dryRun) {
        if (res.wouldWrite.length > 0) {
          console.log('[dry-run] No checkpoint was written.');
          res.wouldWrite.forEach((entry) => console.log(`  would write: ${entry}`));
        } else {
          console.log('[dry-run] Nothing would be written.');
        }
        console.log('');
      }

      if (truthful.invocationPayload) {
        console.log('--- invoke_subagent JSON Payload ---');
        console.log(JSON.stringify(truthful.invocationPayload, null, 2));
        console.log('\nPass this payload directly to invoke_subagent or copy into chat.\n');
      }
      return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ Next failed: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'branch-info': {
      // Issue #251 AC-251.4: same rendered failure as `status`/`resume`.
      try {
      // `branch-info` is a DIAGNOSTIC: it must perform ZERO checkpoint writes
      // (issue #250, AC A4). It used to write the inferred issue back into the
      // checkpoint AND let the base-branch inference persist its own result —
      // two hidden writes that made a read-only command mutate state (and made
      // the behaviour depend on the cwd, because the `/tmp` guard swallows the
      // write there).
      const scope = await resolveScope(stateRepo, issueValue);
      const snapshot = scope.snapshot;
      // Issue #251 AC-251.4: a parseable-but-invalid checkpoint (`{"currentStage":
      // "GARBAGE"}`) must fail HERE too. `branch-info` never rehydrated the
      // snapshot, so it exited 0 while `status` crashed. This is a pure read and
      // does not weaken the zero-write guarantee.
      if (snapshot) {
        StateMachine.fromSnapshot(snapshot);
      }
      const currentBranch = await worktreeManager.resolveBaseBranch();
      const defaultBranch = 'main';

      let issue = scope.issue ?? snapshot?.issue ?? null;
      if (!issue) {
        // Inference only — the result is REPORTED, never written back.
        issue =
          IssueNumber.inferFromPath(snapshot?.worktree?.worktreePath as string | undefined) ??
          IssueNumber.inferFromPath(process.cwd()) ??
          IssueNumber.inferFromBranch(currentBranch);
      }

      let baseBranch = snapshot?.baseBranch || null;
      if (!baseBranch && issue) {
        try {
          const infer = makeInferBaseBranchUseCase(scope.repo);
          const res = await infer.execute({ issueNumber: issue, persist: false });
          baseBranch = res.baseBranch;
        } catch {
          baseBranch = null;
        }
      }

      const activeTaskBranch = snapshot?.worktree?.branch || (currentBranch.startsWith('task/') || currentBranch.startsWith('fix/') ? currentBranch : null);
      const collectorBranch = baseBranch || (currentBranch.startsWith('phase/') || currentBranch.startsWith('feature/') ? currentBranch : null);
      const prTarget = collectorBranch || defaultBranch;

      // Issue #282: report a dead descriptor as stale; never advertise the path
      // as a live worktree, and never repair it here (AC A4, #250).
      const worktreeTruth = describeWorktreeTruth(
        (snapshot?.worktree?.worktreePath as string | undefined) || null
      );

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              dryRun: false,
              baseBranch: collectorBranch,
              taskBranch: activeTaskBranch,
              worktreePath: worktreeTruth.livePath,
              // Additive (#282): `worktreePath` is null for a stale descriptor.
              worktreeStale: worktreeTruth.stalePath !== null,
              staleWorktreePath: worktreeTruth.stalePath,
              prBaseTarget: prTarget,
              milestoneTarget: defaultBranch,
              // Additive: the checkpoint this report was derived from (#250).
              checkpoint: scope.path
            },
            null,
            2
          )
        );
        return EXIT_CODE_SUCCESS;
      }

      console.log('\n=== CodeLoop: Branch Lifecycle & Target Diagnostics ===');
      console.log(`Base Collector Branch : ${collectorBranch ? collectorBranch : '(none - direct from ' + defaultBranch + ')'}`);
      console.log(`Active Task Branch    : ${activeTaskBranch ? activeTaskBranch : '(none - worktree not active)'}`);
      console.log(`Milestone Target      : ${defaultBranch}`);
      console.log(`PR Creation Target    : ${prTarget}`);
      if (worktreeTruth.livePath) {
        console.log(`Isolated Worktree     : ${worktreeTruth.livePath}`);
      } else if (worktreeTruth.stalePath) {
        console.log(
          `Isolated Worktree     : ${worktreeTruth.stalePath} (MISSING — ${formatStaleWorktreeNote(
            worktreeTruth.stalePath,
            issue
          )})`
        );
      }
      console.log('');
      return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ Branch info failed: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'status': {
      // UNCHANGED except for the parsed issue: `status` resolves internally and
      // MUST keep the SAME repository the CLI constructed — re-resolving an
      // already-scoped repository would re-run the scan and could select a
      // different file (#250, R13).
      //
      // The local catch mirrors `resume` (#251 AC-251.2): a corrupt checkpoint
      // is a rendered `✗`, never `Fatal:` + stack from `main`.
      try {
        const getStatusUseCase = new GetPipelineStatusUseCase(stateRepo);
        const result = await getStatusUseCase.execute({ issue: issueValue });
        const statusPause = await readPersistedGatePause(stateRepo, result.resolvedSnapshot);
        // Issue #336 (Defect 2): the triage disposition is part of what the run
        // recorded. It is read through the DOMAIN validator, so a corrupt or
        // hand-edited field renders as "not recorded" instead of
        // `action=undefined`, and the text and JSON surfaces cannot disagree.
        const triageDisposition = TriageDisposition.fromJSON(
          result.resolvedSnapshot?.triageDisposition
        );
        // Issue #315 (AC-9 / G7): `stateFilePath` is the RESOLUTION TARGET, which
        // may not exist yet on a fresh install. Printing it as `Checkpoint :` was
        // a report naming a file that did not exist, so the text path says so and
        // the JSON path carries the existence explicitly (consumers that need the
        // target keep reading `stateFilePath`).
        const checkpointExists = fs.existsSync(result.stateFilePath);

        // A skipped row is a diagnostic, not a payload field to swallow: tell
        // the operator on stderr so stdout stays a single JSON document.
        for (const skipped of result.skippedCorrupt) {
          console.error(
            `⚠ Skipped unreadable checkpoint${skipped.issue !== null ? ` for issue #${skipped.issue}` : ''}` +
            `${skipped.path ? ` (${skipped.path})` : ''}: ${skipped.error}`
          );
        }

        if (options.json) {
          // RAW stage/mode strings — never `formatStageBadge`, which emits ANSI
          // and would corrupt a machine-readable document (#275, R10).
          console.log(
            JSON.stringify(
              {
                dryRun: false,
                currentStage: result.status.currentStage,
                mode: result.status.mode,
                issue: result.status.issue,
                updatedAt: result.status.updatedAt,
                stateFilePath: result.stateFilePath,
                stateFileExists: checkpointExists,
                resolvedIssue: result.resolvedIssue,
                pausedAtGate: statusPause?.gate ?? null,
                pause: statusPause,
                // Issue #315 (AC-24 / #332): what the run recorded about its
                // delivery PR. `null` means "not recorded" — never "delivered".
                pullRequest: result.resolvedSnapshot?.pullRequest ?? null,
                // Issue #336 (Defect 2): the disposition the checkpoint holds,
                // under the name the checkpoint uses. `next` already read this
                // field; `status` dropping it is how the two surfaces
                // disagreed about the same PR.
                triageDisposition: triageDisposition ? triageDisposition.toJSON() : null,
                reviewDispatchCount: result.status.reviewDispatchCount,
                discoveryDispatchCount: result.status.discoveryDispatchCount,
                planDispatchCount: result.status.planDispatchCount,
                // Issue #315 (AC-11): the fourth counter, under the name the
                // checkpoint uses. The text renderer and `next --json` already
                // reported it; the machine-readable status silently omitted it.
                implementationDispatchCount: result.status.implementationDispatchCount,
                planEmptyParkCount: result.status.planEmptyParkCount,
                activeTasks: result.activeTasks.map((task) => ({
                  issue: task.issue,
                  currentStage: task.status.currentStage,
                  mode: task.status.mode,
                  updatedAt: task.status.updatedAt,
                  stateFilePath: task.stateFilePath ?? null
                })),
                skippedCorrupt: result.skippedCorrupt.map((skipped) => ({
                  issue: skipped.issue,
                  path: skipped.path,
                  error: skipped.error
                })),
                history: result.history.map((entry) => ({
                  stage: entry.stage,
                  timestamp: entry.timestamp
                }))
              },
              null,
              2
            )
          );
          return EXIT_CODE_SUCCESS;
        }

        console.log('\n=== CodeLoop: Pipeline Status ===');
        console.log(`Current Stage : ${formatStageBadge(result.status.currentStage)}`);
        console.log(`Execution Mode: ${result.status.mode}`);
        console.log(`Active Issue  : ${result.status.issue ? '#' + result.status.issue : 'None'}`);
        console.log(`Updated At    : ${result.status.updatedAt}`);
        console.log(`Checkpoint    : ${checkpointExists ? result.stateFilePath : '(not created yet)'}`);
        if (result.resolvedIssue !== null) {
          // Without this the `Checkpoint` line read like an assertion that the run
          // uses the root file, which is exactly what it did NOT use: the root
          // `.agyloop/state.json` is not read or written by task runs (#226 D5).
          console.log(`              (authoritative for issue #${result.resolvedIssue} — the root .agyloop/state.json is not used by task runs)`);
        }

        // Issue #315 (AC-24 / #332): a COMPLETED run states whether it was
        // DELIVERED. Before this, the terminal badge was the only signal, and a
        // pushed branch with no PR looked exactly like a merged one.
        if (result.status.currentStage === STAGE_COMPLETED) {
          console.log(`Delivery      : ${formatPullRequestDelivery(result.resolvedSnapshot?.pullRequest, triageDisposition)}`);
        }

        // Issue #336 (Defect 2): a disposition is recorded by every routing
        // action, not only at the terminal stage, so it is rendered wherever
        // it exists. It follows the Delivery line so a COMPLETED run reads the
        // two facts in the order the operator cares about them.
        if (triageDisposition) {
          console.log(formatTriageDispositionLine(triageDisposition, 'status-report'));
        }

        if (statusPause) {
          console.log(`Paused At Gate: ${statusPause.gate}`);
          console.log(`Paused At     : ${statusPause.pausedAt ?? '(unknown)'}`);
          if (statusPause.gate === GATE_CIRCUIT_BREAKER) {
            console.log('Recovery      : resolve the blocking condition (e.g. wait for the provider quota window),');
            console.log(`                then run \`${RESUME_COMMAND}\`.`);
          }
        }

        // Additive (issue #272): a REVIEW round that has been re-dispatched is
        // observable in `status`, not only in the checkpoint file.
        if (result.status.reviewDispatchCount > 0) {
          console.log(`${LABEL_REVIEW_DISPATCHES} : ${result.status.reviewDispatchCount}`);
        }
        // Additive (issue #292/#267): the early-stage re-dispatch records and
        // the blank-plan park count are observable in `status`, not only in the
        // checkpoint file.
        if (result.status.discoveryDispatchCount > 0) {
          console.log(`${LABEL_DISCOVERY_DISPATCHES} : ${result.status.discoveryDispatchCount}`);
        }
        if (result.status.planDispatchCount > 0) {
          console.log(`${LABEL_PLAN_DISPATCHES} : ${result.status.planDispatchCount}`);
        }
        // Issue #327: the IMPLEMENT re-dispatch record, so a run that keeps
        // reading `next` at IMPLEMENT is observable in `status`.
        if (result.status.implementationDispatchCount > 0) {
          console.log(`${LABEL_IMPLEMENT_DISPATCHES} : ${result.status.implementationDispatchCount}`);
        }
        if (result.status.planEmptyParkCount > 0) {
          console.log(`${LABEL_PLAN_EMPTY_PARKS} : ${result.status.planEmptyParkCount}`);
        }

        if (result.activeTasks && result.activeTasks.length > 0) {
          console.log(`\nActive Tasks Matrix (${result.activeTasks.length}):`);
          console.log('--------------------------------------------------------------------------------');
          console.log('Issue       Stage                Mode            Updated At');
          console.log('--------------------------------------------------------------------------------');
          for (const task of result.activeTasks) {
            const issueStr = task.issue ? `#${task.issue}` : 'Root';
            const issuePad = issueStr.padEnd(11);
            const rawStage = `[${task.status.currentStage}]`;
            const stageBadge = formatStageBadge(task.status.currentStage);
            const stagePaddingNeeded = Math.max(0, 20 - rawStage.length);
            const stagePad = stageBadge + ' '.repeat(stagePaddingNeeded);
            const modePad = task.status.mode.padEnd(15);
            console.log(`${issuePad} ${stagePad} ${modePad} ${task.status.updatedAt}`);
          }
          console.log('--------------------------------------------------------------------------------');
        }

        const worktrees = await worktreeManager.listWorktrees();
        if (worktrees.length > 0) {
          console.log(`\nIsolated Git Worktrees (${worktrees.length}):`);
          for (const wt of worktrees) {
            console.log(`  - Task ${wt.taskId}: ${wt.worktreePath} (branch: ${wt.branch})`);
          }
        }

        console.log('\nTransition History:');
        result.history.forEach((entry, idx) => {
          console.log(`  ${idx + 1}. ${formatStageBadge(entry.stage)} at ${entry.timestamp}`);
        });
        console.log('');
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ Status failed: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'config': {
      console.log('\n=== CodeLoop: Configuration & Model Routing ===');
      const roles = ['planner', 'implementer', 'gate', 'reviewer', 'triage'];
      console.log('\nSubagent Model Routing Table:');
      console.log('----------------------------------------------------------------------');
      console.log('Role         Configured           AGY Subagent Tier   Canonical API Model');
      console.log('----------------------------------------------------------------------');
      for (const role of roles) {
        const resolved = configRepo.resolveModel(role, config);
        const rPad = role.padEnd(12);
        const cPad = resolved.configured.padEnd(20);
        const tPad = resolved.tier.padEnd(19);
        console.log(`${rPad} ${cPad} ${tPad} ${resolved.apiModel}`);
      }
      console.log('----------------------------------------------------------------------');
      console.log('\nPipeline Options:');
      console.log(`  Commit After Passes   : ${config.options.commitAfter}`);
      console.log(`  Gate Timeout (seconds): ${config.options.gateTimeoutSeconds}`);
      console.log(`  Auto-Approve In YOLO  : ${config.options.autoApproveInYolo}`);
      console.log('');
      return EXIT_CODE_SUCCESS;
    }

    case 'models': {
      console.log('\n=== CodeLoop: Discovering Available Gemini Models ===');
      const listModelsUseCase = new ListModelsUseCase(modelCatalog);
      const models = await listModelsUseCase.execute({ forceRefresh: options.refresh });
      console.log(`Found ${models.length} candidate models:\n`);
      console.log('----------------------------------------------------------------------');
      console.log('Model ID                               Antigravity Tier Mapping');
      console.log('----------------------------------------------------------------------');
      models.forEach((m) => {
        const idPad = m.id.padEnd(38);
        console.log(`${idPad} ${m.tier}`);
      });
      console.log('----------------------------------------------------------------------');
      console.log('Tip: Run with --refresh to re-fetch live models from Gemini API.\n');
      return EXIT_CODE_SUCCESS;
    }

    case 'reset': {
      // The repository the CLI constructed: `resetTask` derives the task path
      // from the workspace root, so the repository's own binding does not
      // matter for `reset --issue <n>` (#250). For a ROOT reset the binding
      // DOES matter — it names the file that is deleted — which is why the
      // report prints `result.path` (the truth) instead of a literal.
      const resetUseCase = new ResetPipelineUseCase(stateRepo);
      const result = await resetUseCase.execute({
        issue: issueValue,
        all: options.all,
        dryRun: options.dryRun
      });

      if (result.dryRun) {
        // A simulation states what it WOULD do and predicts the real exit code
        // (#248): task-scope with nothing to clear exits 1, exactly like the
        // real command; root and `--all` exit 0 either way.
        if (result.scope === 'all') {
          console.log('[dry-run] Would purge .agyloop/state.json and all task checkpoints.');
          return EXIT_CODE_SUCCESS;
        }
        if (result.scope === 'task') {
          if (result.wouldClear) {
            console.log(`[dry-run] Would clear the checkpoint for issue #${result.issue} (${result.path}).`);
            return EXIT_CODE_SUCCESS;
          }
          console.error(`[dry-run] Nothing to clear for issue #${result.issue} (${result.path}).`);
          return EXIT_CODE_FAILURE;
        }
        if (result.wouldClear) {
          console.log(`[dry-run] Would clear ${result.path}.`);
        } else {
          console.log(`[dry-run] Nothing to clear at ${result.path}.`);
        }
        return EXIT_CODE_SUCCESS;
      }

      if (result.scope === 'all') {
        console.log('✓ CodeLoop pipeline state reset. .agyloop/state.json and all task checkpoints purged.');
        return EXIT_CODE_SUCCESS;
      }

      if (result.scope === 'task') {
        if (result.removed) {
          console.log(`✓ CodeLoop task state reset. Checkpoint for issue #${result.issue} cleared (${result.path}).`);
          return EXIT_CODE_SUCCESS;
        }
        // AC B4 (issue #250): the unconditional success line is GONE. A reset
        // that addressed a checkpoint which did not exist must not claim it
        // cleared one.
        console.error(`✗ No checkpoint found for issue #${result.issue} (${result.path}). Nothing was cleared.`);
        return EXIT_CODE_FAILURE;
      }

      // The TRUTH, not a literal: `resetRoot()` deletes `stateRepo.reset()`,
      // which is `stateRepo.getStateFilePath()`. Inside a task worktree the
      // CLI's repository is bound to `tasks/<n>.json`, so the old hardcoded
      // ".agyloop/state.json" named a file that was never touched (issue #250,
      // review N2).
      console.log(`✓ CodeLoop pipeline state reset. ${result.path} cleared.`);
      return EXIT_CODE_SUCCESS;
    }

    case COMMAND_RESUME: {
      // Guarded by STATE_MUTATING_COMMANDS ('resume' clears the persisted pause, so it
      // mutates the checkpoint exactly like `reset` does): a subagent is refused above.
      try {
        const resumeUseCase = new ResumePipelineUseCase(stateRepo);
        const resumeResult = await resumeUseCase.execute({
          dryRun: options.dryRun,
          issue: issueValue,              // (#226 — was never forwarded)
        });

        if (options.json) {
          // Single JSON document on stdout; anything diagnostic goes to stderr.
          console.log(JSON.stringify(buildResumeJsonPayload(resumeResult, options.dryRun === true), null, 2));
          if (!resumeResult.success) {
            console.error(`✗ ${resumeResult.message}`);
          }
          return resumeResult.success ? EXIT_CODE_SUCCESS : EXIT_CODE_FAILURE;
        }

        if (!resumeResult.success) {
          console.error(`✗ ${resumeResult.message}`);
          return EXIT_CODE_FAILURE;
        }

        console.log('\n=== CodeLoop: Pipeline Resume ===');
        console.log(`${options.dryRun ? '[dry-run] ' : '✓ '}${resumeResult.message}`);
        if (resumeResult.resolvedFromIssue != null) {
          // A bare `resume` gives no hint that a task checkpoint was involved; without
          // this the operator cannot tell WHICH task was inspected (#226 D6).
          console.log(`  Task         : #${resumeResult.resolvedFromIssue} (${resumeResult.resolvedFromPath})`);
        }
        console.log(`  Cleared Gate : ${resumeResult.pausedAtGate ?? '(none)'}`);
        console.log(`  Cleared At   : ${resumeResult.pausedAtTimestamp ?? '(unknown)'}`);
        console.log(`  Stage        : ${resumeResult.currentStage ?? '(no checkpoint)'}`);
        if (resumeResult.resumed) {
          console.log(`  Next Step    : run \`codeloop next\` to obtain the next directive.`);
        }
        console.log('');
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ Resume failed: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case COMMAND_HALT: {
      // Inbound quota-halt channel (issue #220): the runner-side caller invokes
      // this as a separate process when it observes a 429. Guarded by
      // STATE_MUTATING_COMMANDS but carved out for subagents above, like `triage`.
      try {
        if (options.reason !== 'quota') {
          console.error(`Error: 'halt' requires --reason quota. Example: codeloop halt --reason quota [--retry-after <seconds>].`);
          return EXIT_CODE_FAILURE;
        }

        let retryAfterSeconds: number | undefined;
        if (options.retryAfter !== null && options.retryAfter !== undefined) {
          const raw = options.retryAfter;
          if (!/^\d{1,6}$/.test(raw)) {
            console.error(`Error: Invalid --retry-after '${raw}'. Expected a non-negative integer number of seconds (0-999999).`);
            return EXIT_CODE_FAILURE;
          }
          retryAfterSeconds = Number(raw);
        }

        // The scope decides the FILE. `halt` used to write `.agyloop/state.json`
        // while its sibling `status` read `tasks/999.json` (#250, AC B2).
        const scope = await resolveScope(stateRepo, issueValue);
        const haltUseCase = new HaltPipelineUseCase(scope.repo);
        const haltResult = await haltUseCase.execute({
          reason: 'quota',
          retryAfterSeconds,
          dryRun: options.dryRun,
          issue: issueValue
        });

        if (!haltResult.success) {
          console.error(`✗ ${haltResult.message}`);
          return EXIT_CODE_FAILURE;
        }

        if (options.json) {
          // Single JSON document on stdout; anything diagnostic goes to stderr.
          console.log(
            JSON.stringify(
              {
                success: haltResult.success,
                dryRun: options.dryRun === true,
                halted: haltResult.halted,
                persisted: haltResult.persisted,
                pausedAtGate: haltResult.pausedAtGate,
                pausedAtTimestamp: haltResult.pausedAtTimestamp,
                quotaResetAt: haltResult.quotaResetAt,
                quotaResetEstimated: haltResult.quotaResetEstimated,
                retryAfterSeconds: haltResult.retryAfterSeconds,
                issue: haltResult.issue,
                message: haltResult.message
              },
              null,
              2
            )
          );
          return EXIT_CODE_QUOTA_EXHAUSTED;
        }

        console.log('\n=== CodeLoop: Provider Quota Halt ===');
        if (options.dryRun) {
          // Never `✓ Quota halt recorded` — nothing was recorded (#248).
          console.log(`[dry-run] Would record a quota halt at the ${haltResult.pausedAtGate} gate — nothing was written.`);
          console.log(`  Quota Resets : ${haltResult.quotaResetAt}${haltResult.quotaResetEstimated ? ' (estimated)' : ''}`);
          console.log(`  Next Step    : run \`${QUOTA_RESUME_COMMAND}\` once the quota window resets.`);
          console.log('');
          return EXIT_CODE_QUOTA_EXHAUSTED;
        }
        console.log(`✓ Quota halt recorded at the ${haltResult.pausedAtGate} gate — nothing is lost.`);
        console.log(`  Paused At    : ${haltResult.pausedAtTimestamp ?? '(unknown)'}`);
        console.log(`  Quota Resets : ${haltResult.quotaResetAt}${haltResult.quotaResetEstimated ? ' (estimated)' : ''}`);
        console.log(`  Next Step    : run \`${QUOTA_RESUME_COMMAND}\` once the quota window resets.`);
        console.log('');
        return EXIT_CODE_QUOTA_EXHAUSTED;
      } catch (err: unknown) {
        console.error(`✗ Halt failed: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'abort': {
      console.log('\n🛑 CodeLoop: Initiating Emergency Abort Protocol...');
      // The teardown must run even when the checkpoint is UNREADABLE: a corrupt
      // `tasks/<n>.json` is precisely the state an operator aborts FROM (issue
      // #250, review B1). Before #250 the checkpoint was read only in the
      // use case's LAST step — inside a try/catch, AFTER the teardown — so a
      // corrupt file could never stop the teardown. Resolving the scope before
      // the use case must not reintroduce that failure mode.
      const scope = await resolveScopeTolerantly(stateRepo, issueValue);
      if (scope.error !== null) {
        // `⚠`, not `✗`: the abort itself SUCCEEDS — only the optional audit
        // checkpoint was unreadable.
        console.error(
          `⚠ Could not read the checkpoint (${scope.repo.getStateFilePath()}): ` +
          `${scope.error instanceof Error ? scope.error.message : String(scope.error)}. ` +
          'Continuing the teardown.'
        );
      }
      const abortUseCase = new AbortPipelineUseCase({
        stateRepo: scope.repo,
        commandExecutor,
        worktreeManager,
        planGenerator
      });

      const abortResult = await abortUseCase.execute({
        workspaceDir: options.workspaceDir,
        issue: issueValue,
        force: options.force,
        quarantine: options.quarantine,
        noQuarantine: options.noQuarantine,
        dryRun: options.dryRun
      });

      if (abortResult.dryRun) {
        // A simulation must never print the teardown's completion line (#248).
        console.log('[dry-run] Emergency abort simulated — nothing was terminated, moved or cleared.');
        console.log('  - Processes terminated     : 0 (simulated — no signal was sent)');
        console.log('  - Stale git locks cleared  : NO (simulated)');
        console.log(`  - Worktrees would quarantine: ${abortResult.worktreesWouldQuarantine.length}`);
        for (const path of abortResult.worktreesWouldQuarantine) {
          console.log(`    * ${path}`);
        }
        for (const skipped of abortResult.worktreesQuarantineSkipped) {
          console.log(`    * ${skipped.worktreePath} would be left untouched — ${skipped.reason}`);
        }
        console.log(`  - Containers would terminate: ${abortResult.containersWouldTerminate.length}`);
        for (const c of abortResult.containersWouldTerminate) {
          console.log(`    * ${c}`);
        }
        console.log('  - Summary audit checkpoint : SKIPPED (simulated)');
        console.log('');
        return EXIT_CODE_SUCCESS;
      }

      console.log(`✓ Emergency Abort completed in ${abortResult.durationMs}ms:`);
      console.log(`  - Processes terminated     : ${abortResult.processesTerminated}`);
      console.log(`  - Stale git locks cleared  : ${abortResult.indexLockRemoved ? 'YES' : 'NONE'}`);
      renderAbortQuarantine(abortResult);
      console.log(`  - Containers terminated    : ${abortResult.containersTerminated.length}`);
      for (const c of abortResult.containersTerminated) {
        console.log(`    * ${c}`);
      }
      console.log(`  - Summary audit checkpoint : ${abortResult.auditLogged ? 'LOGGED' : 'SKIPPED'}`);
      console.log('');
      return EXIT_CODE_SUCCESS;
    }

    case 'transition': {
      if (!options.stageArg) {
        console.error('Error: Please specify target stage. Example: codeloop transition PLAN');
        console.error('Valid stages:', Object.keys(STAGES).join(', '));
        return EXIT_CODE_FAILURE;
      }
      try {
        // The scope decides the FILE and the MODE: `transition` used to act on
        // the ROOT checkpoint's stage/mode while `status` reported the task
        // checkpoint's (#250, AC A3).
        const scope = await resolveScope(stateRepo, issueValue);
        const transitionUseCase = new TransitionStageUseCase(
          scope.repo,
          worktreeManager,
          makeInferBaseBranchUseCase(scope.repo),
          planGenerator,
          new FileGateReportRepository({
            workspaceDir: options.workspaceDir || process.cwd(),
            issue: issueValue ?? null
          }),
          commandExecutor
        );
        await transitionUseCase.execute({
          targetStage: options.stageArg as StageName,
          metadata: { note: 'Manual CLI transition' },
          dryRun: options.dryRun,          // (#226 — was silently dropped)
          noWorktree: options.noWorktree,
          baseBranch: options.baseBranch,
          issue: issueValue,
          title: options.title,
          workspaceDir: options.workspaceDir
        });
        console.log(
          `${options.dryRun ? '[dry-run] ' : '✓ '}Transitioned to ${formatStageBadge(options.stageArg)}`
        );
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'worktree': {
      const manageWorktreeUseCase = new ManageWorktreeUseCase(worktreeManager, stateRepo);
      const sub = options.worktreeSubcommand || 'list';

      if (sub === 'list') {
        const res = await manageWorktreeUseCase.list({
          includeExternal: options.all
        });
        const list = res.data || [];
        // #339 (item 5): the header used to claim every row was "Active" while
        // git itself reported the registration `prunable`, and the table had no
        // Status column to tell the two apart.
        console.log('\n=== CodeLoop: Isolated Git Worktrees ===');
        if (list.length === 0) {
          console.log('No isolated worktrees found.\n');
        } else {
          console.log('---------------------------------------------------------------------------------------------');
          console.log('Task ID      Branch                         Status    Worktree Directory');
          console.log('---------------------------------------------------------------------------------------------');
          for (const wt of list) {
            const idPad = wt.taskId.padEnd(12);
            const bPad = wt.branch.padEnd(30);
            const status = wt.prunable ? 'prunable' : 'active';
            console.log(`${idPad} ${bPad} ${status.padEnd(8)} ${wt.worktreePath}`);
          }
          console.log('---------------------------------------------------------------------------------------------\n');
        }
        return EXIT_CODE_SUCCESS;
      }

      if (sub === 'clean' || sub === 'prune') {
        console.log(
          options.dryRun
            ? 'Simulating orphaned git worktree and lock pruning...'
            : 'Pruning orphaned git worktrees and locks...'
        );
        const res = await manageWorktreeUseCase.clean({
          subagents: options.subagents,
          all: options.all,
          dryRun: options.dryRun
        });
        console.log(`${options.dryRun ? '[dry-run] ' : '✓ '}${res.message}\n`);
        return EXIT_CODE_SUCCESS;
      }

      if (sub === 'remove' || sub === 'rm') {
        if (!options.worktreeTarget) {
          console.error('Error: Please specify task ID or worktree path to remove. Example: codeloop worktree remove 87');
          return EXIT_CODE_FAILURE;
        }

        // Issue #282: resolve FIRST (the resolver validates the target and
        // proves it stays inside `<root>/.worktrees`) and never print a success
        // line for something that was not removed. Any refusal — absolute
        // path, `..`, separator, symlink, missing, unregistered — lands in the
        // catch and exits non-zero with the reason on stderr.
        const workspaceDir = options.workspaceDir || process.cwd();
        try {
          const targetPath = await worktreeManager.resolveTaskWorktreePath(
            workspaceDir,
            options.worktreeTarget
          );
          console.log(
            `${options.dryRun ? '[dry-run] Would remove' : 'Removing'} worktree at ${targetPath}...`
          );

          // Descriptor scope uses the SAME issue grammar as every other
          // command (#250): an explicit `--issue` wins, else a purely numeric
          // target scopes the task checkpoint; anything else leaves it absent
          // and the path-matched scan decides.
          const parsedTarget = parseIssueToken(options.worktreeTarget);
          const targetIssue =
            issueValue ?? (parsedTarget.kind === 'valid' ? parsedTarget.issue : null);

          // Issue #266 (absorbs #287): descriptor clearing must target the
          // REPOSITORY's checkpoint, not the caller's worktree-local one. When
          // `worktree remove` runs from inside `.worktrees/<id>`, the caller's
          // state root IS the directory this command deletes first.
          const repoRoot = worktreeManager.resolveRepositoryRoot
            ? await worktreeManager.resolveRepositoryRoot(workspaceDir)
            : workspaceDir;
          const removalStateRepo = new FileStateRepository({
            workspaceDir: repoRoot,
            // Bind the ROOT checkpoint as the PRIMARY candidate and do NOT pass
            // `issue:`: that keeps the legacy root `.agyloop/state.json` on the
            // watchlist (the dual-checkpoint case pinned by cli-worktree-remove
            // T-P9). `clearDescriptor` adds `.agyloop/tasks/<id>.json` from its
            // own `issue` parameter and from the path-matched `listAllStates()`
            // sweep.
            stateFilePath: path.join(repoRoot, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE)
          });
          const removalUseCase = new ManageWorktreeUseCase(worktreeManager, removalStateRepo);

          // `--prune-stale` is the supported repair for a descriptor whose
          // directory is gone (#282 review iteration 2). The plain command must
          // keep refusing a missing path (AC-2), so this opt-in is the only
          // path that clears a descriptor without a live worktree — and it
          // touches the checkpoint only, never the filesystem.
          if (options.pruneStale) {
            if (fs.existsSync(targetPath)) {
              console.error(
                `✗ Worktree directory still exists at ${targetPath}; run without --prune-stale to remove it normally.`
              );
              return EXIT_CODE_FAILURE;
            }

            const pruned = await removalUseCase.clearStaleDescriptor({
              worktreePath: targetPath,
              issue: targetIssue,
              dryRun: options.dryRun
            });

            if (!pruned.success) {
              console.error(`✗ ${pruned.message}`);
              return EXIT_CODE_FAILURE;
            }

            console.log(`${options.dryRun ? '[dry-run] ' : '✓ '}${pruned.message}\n`);
            return EXIT_CODE_SUCCESS;
          }

          const res = await removalUseCase.teardown({
            worktreePath: targetPath,
            workspaceDir: repoRoot,
            taskId: options.worktreeTarget,
            issue: targetIssue,
            dryRun: options.dryRun
          });

          // Belt-and-braces over the manager's own post-condition: never print
          // `✓` for a path that still exists. On a DRY RUN the directory is
          // EXPECTED to still exist — that is the whole point — so the check is
          // inverted (#248, R5).
          if (options.dryRun) {
            if (!fs.existsSync(targetPath)) {
              console.error(`✗ A dry run removed the worktree at ${targetPath}; nothing may be deleted.`);
              return EXIT_CODE_FAILURE;
            }
            console.log(`[dry-run] ${res.message}\n`);
            return EXIT_CODE_SUCCESS;
          }
          if (fs.existsSync(targetPath)) {
            console.error(`✗ Worktree still exists after removal: ${targetPath}`);
            return EXIT_CODE_FAILURE;
          }

          console.log(`✓ ${res.message}\n`);
          return EXIT_CODE_SUCCESS;
        } catch (err: unknown) {
          console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
          return EXIT_CODE_FAILURE;
        }
      }

      console.error(`Unknown worktree subcommand: '${sub}'. Valid subcommands: list, clean, prune, remove <task-id>\n`);
      return EXIT_CODE_FAILURE;
    }

    case 'critique': {
      const sub = options.critiqueSubcommand || 'status';
      switch (sub) {
        case 'status': {
          const status = await manageCritiqueUseCase.getStatus(process.cwd());
          if (options.json) {
            console.log(JSON.stringify({ dryRun: false, ...status }, null, 2));
            return EXIT_CODE_SUCCESS;
          }

          console.log('\n=== CodeLoop: Critique CLI Status ===');
          console.log(`Resolution Source : ${status.resolution.source}`);
          console.log(`Resolved Path     : ${status.resolution.path || 'Not found'}`);
          console.log(`Installed Version : ${status.versionInfo.currentVersion ? `v${status.versionInfo.currentVersion}` : 'Not installed'}`);
          console.log(`Latest Version    : ${status.versionInfo.latestVersion ? `v${status.versionInfo.latestVersion}` : 'Unknown (offline or pending)'}`);
          if (status.versionInfo.lastCheckedAt) {
            console.log(`Last Checked At   : ${new Date(status.versionInfo.lastCheckedAt).toLocaleString()}`);
          }
          console.log(`Update Available  : ${status.versionInfo.isOutdated ? 'YES ⚠️' : 'NO ✓'}`);

          if (status.versionInfo.isOutdated) {
            console.log(`\n💡 A new version of critique is available (v${status.versionInfo.currentVersion} -> v${status.versionInfo.latestVersion}).`);
            console.log('   Run `codeloop critique update` to upgrade.\n');
          } else if (!status.resolution.isAvailable) {
            console.log('\n⚠️  Critique CLI is not installed.');
            console.log('   Run `codeloop critique install` to install it automatically.\n');
          } else {
            console.log('\n✓ Critique CLI is installed and up to date.\n');
          }
          return EXIT_CODE_SUCCESS;
        }

        case 'install': {
          console.log(
            options.dryRun ? '\n📥 Simulating Critique CLI installation...' : '\n📥 Installing Critique CLI...'
          );
          const result = await manageCritiqueUseCase.install({
            force: options.force,
            dryRun: options.dryRun
          });
          if (result.success) {
            if (options.dryRun) {
              console.log(`[dry-run] Would install critique v${result.version} to:`);
              console.log(`  ${result.targetPath}`);
              console.log('  Nothing was downloaded or written.\n');
              return EXIT_CODE_SUCCESS;
            }
            console.log(`✓ Successfully installed critique v${result.version} to:`);
            console.log(`  ${result.targetPath}\n`);
            return EXIT_CODE_SUCCESS;
          } else {
            console.error(`✗ Installation failed: ${result.error || 'Unknown error'}\n`);
            return EXIT_CODE_FAILURE;
          }
        }

        case 'update': {
          console.log(
            options.dryRun ? '\n🔄 Simulating Critique CLI update...' : '\n🔄 Updating Critique CLI...'
          );
          const result = await manageCritiqueUseCase.update({ dryRun: options.dryRun });
          if (result.success) {
            if (options.dryRun) {
              console.log(`[dry-run] Would update critique to v${result.version} at:`);
              console.log(`  ${result.targetPath}`);
              console.log('  Nothing was downloaded or written.\n');
              return EXIT_CODE_SUCCESS;
            }
            console.log(`✓ Successfully updated critique to v${result.version} at:`);
            console.log(`  ${result.targetPath}\n`);
            return EXIT_CODE_SUCCESS;
          } else {
            console.error(`✗ Update failed: ${result.error || 'Unknown error'}\n`);
            return EXIT_CODE_FAILURE;
          }
        }

        default: {
          console.error(`Error: Unknown critique subcommand "${sub}". Available: status, install, update.\n`);
          return EXIT_CODE_FAILURE;
        }
      }
    }

    case 'triage': {
      const rawAction = options.triageAction ? options.triageAction.toLowerCase() : null;
      // ONE source: the parser validates against the same frozen action list the
      // prompts, the help text and the hint render (issue #241, D4).
      const validActions: readonly TriageAction[] = TRIAGE_DISPOSITION_ACTIONS;
      if (rawAction && !(validActions as readonly string[]).includes(rawAction)) {
        console.error(`Error: Unrecognized triage action '${options.triageAction}'. Available: ${formatTriageActionList(', ')}.`);
        return EXIT_CODE_FAILURE;
      }
      const action = (rawAction || undefined) as TriageAction | undefined;

      try {
        // The scope resolution lives INSIDE the try (issue #250, review N1): an
        // unreadable NAMED checkpoint must be REPORTED as a triage failure,
        // not thrown out of `runCli` as a raw stack. Before #250 the checkpoint
        // was read inside the use case, i.e. inside this try — that contract is
        // restored here.
        const scope = await resolveScope(stateRepo, issueValue);

        // The replacement protection for the removed `AGY_SUBAGENT` marker
        // (issue #241, §4.1): a routing action may only route a checkpoint that
        // is actually AT the TRIAGE gate. This prevents routing the WRONG
        // checkpoint; it is not a claim that a root actor is distinguishable
        // from a subagent. List mode is unaffected.
        if (action && scope.snapshot?.currentStage !== STAGE_TRIAGE) {
          console.error(MSG_TRIAGE_ROUTING_REQUIRES_GATE);
          return EXIT_CODE_FAILURE;
        }

        const triageUseCase = new TriagePrCommentsUseCase(
          scope.repo,
          githubGateway,
          planGenerator,
          worktreeManager,
          makeInferBaseBranchUseCase(scope.repo)
        );

        const result = await triageUseCase.execute({
          issue: issueValue,
          action,
          notes: options.message || undefined,
          workspaceDir: process.cwd(),
          dryRun: options.dryRun
        });

        if (options.json) {
          // A machine-readable projection, never the rehydrated StateMachine
          // entity, and — critically — a SINGLE document on stdout: the human
          // banner is printed below, after this branch returns (#275 Defect A).
          console.log(
            JSON.stringify(
              {
                success: result.success,
                dryRun: result.dryRun === true,
                stateUpdated: result.stateUpdated === true,
                targetStage: result.targetStage,
                wouldTransitionTo: result.wouldTransitionTo ?? null,
                wouldCreateWorktree: result.wouldCreateWorktree === true,
                wouldDismiss: result.wouldDismiss === true,
                wouldRecordDisposition: result.wouldRecordDisposition === true,
                prNumber: result.prNumber ?? null,
                comments: result.comments,
                ...(result.dismissal ? { dismissal: result.dismissal } : {}),
                refused: result.refused ?? null,
                disposition: result.disposition ?? null,
                dispositionRecorded: result.dispositionRecorded === true,
                message: result.message
              },
              null,
              2
            )
          );
          return result.success ? EXIT_CODE_SUCCESS : EXIT_CODE_FAILURE;
        }

        console.log('\n=== CodeLoop: PR Review Comments Triage ===');

        if (result.comments && result.comments.length > 0) {
          console.log(`Found ${result.comments.length} PR review comment(s):\n`);
          result.comments.forEach((c, idx) => {
            const cat = c.category ? ` [${c.category.toUpperCase()}]` : '';
            const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
            console.log(`  ${idx + 1}.${cat} @${c.author}${loc}:`);
            const firstLine = (c.body || '').split('\n')[0].slice(0, 100);
            console.log(`     "${firstLine}${firstLine.length >= 100 ? '...' : ''}"`);
          });
          console.log('');
        } else {
          console.log('No PR review comments found.\n');
        }

        if (!action) {
          console.log(`(Read-only list mode: no state changes. Provide an action: ${formatTriageActionList('|')}.)`);
          console.log(`  ${formatTriageActionSideEffects()}.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.refused) {
          // A refusal writes NOTHING, so the report must never print the
          // success lines (#336). This branch runs before the dry-run block so
          // a predicted refusal renders identically to the real one.
          printTriageRefusal(result.refused, result.dismissal, result.dryRun === true);
          if (result.dryRun) {
            console.log('[dry-run] Would NOT transition — the checkpoint stays at its current stage.');
            console.log('[dry-run] Nothing was written.\n');
          } else {
            console.log(`✗ Next Stage    : ${NOTE_TRIAGE_REFUSAL_NO_TRANSITION}`);
            console.log(`✗ State Updated : ${NOTE_TRIAGE_STATE_UNCHANGED}`);
            console.log(`⚠ ${LABEL_TRIAGE_DISPOSITION} : ${NOTE_TRIAGE_DISPOSITION_REFUSED}\n`);
          }
          return EXIT_CODE_FAILURE;
        }

        if (result.dryRun) {
          // A simulation never says "State Updated" (#248 AC-248.5).
          console.log(`[dry-run] Triage Action : ${action.toUpperCase()}`);
          console.log(`[dry-run] Would transition to ${formatStageBadge(result.wouldTransitionTo ?? result.targetStage)}`);
          if (result.wouldCreateWorktree) {
            console.log('[dry-run] Would create a worktree');
          }
          if (result.wouldDismiss) {
            console.log(`[dry-run] ${NOTE_TRIAGE_DRY_RUN_DISMISS}`);
          }
          console.log('[dry-run] Nothing was written.\n');
          return EXIT_CODE_SUCCESS;
        }

        if (action === 'dismiss') {
          // The dismissal route reports what it really achieved — a partial
          // dismissal must never be rendered as an unqualified success.
          printTriageDismissOutcome(result.dismissal);
        } else {
          console.log(`✓ Triage Action : ${action.toUpperCase()}`);
        }
        console.log(`✓ Next Stage    : ${formatStageBadge(result.targetStage)}`);
        console.log(`✓ State Updated : Pipeline transitioned to ${result.targetStage}\n`);

        // Issue #269: the disposition line and the exit condition. The gate
        // re-opens on every read while the PR is open, so the operator must be
        // told what was recorded and what ends the loop. The line itself is
        // rendered by the ONE shared renderer (issue #269, R5).
        if (result.dispositionRecorded && result.disposition) {
          console.log(`✓ ${formatTriageDispositionLine(result.disposition, 'triage-cli')}`);
        } else {
          console.log(`⚠ ${LABEL_TRIAGE_DISPOSITION} : ${NOTE_TRIAGE_DISPOSITION_NOT_RECORDED}`);
        }
        console.log(`  ${NOTE_TRIAGE_GATE_EXIT_CONDITION}\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ Triage failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_CODE_FAILURE;
      }
    }

    case COMMAND_GATE_REPORT: {
      // The INBOUND CHANNEL for a dispatched GATE subagent's evidence
      // (issue #284). The gate emits a `GATE_REPORT_JSON:` block; until this
      // command existed nothing persisted it, so the summary's gate metrics
      // kept the template's `PENDING` forever.
      //
      // It NEVER transitions and NEVER saves the checkpoint: it files one
      // evidence record, which `codeloop transition REVIEW` then ingests and
      // consumes. A subagent cannot reach this command (it is in
      // `STATE_MUTATING_COMMANDS`, with no carve-out): the gate emits text, the
      // orchestrator files it.
      try {
        if (options.reportFileRequested && options.reportFile === null) {
          console.error(
            `✗ '${FLAG_REPORT_FILE}' was provided without a value. Nothing was recorded; supply a path, '-' for stdin, or remove the flag.`
          );
          return EXIT_CODE_FAILURE;
        }
        if (options.reportFile !== null && options.reportStdin) {
          console.error(
            `✗ '${FLAG_REPORT_FILE}' and '${FLAG_REPORT_STDIN}' both supply a report. Use one of them.`
          );
          return EXIT_CODE_FAILURE;
        }
        if (options.reportFile === null && !options.reportStdin) {
          console.error(
            `✗ Gate evidence refused: no report supplied. Pass '${FLAG_REPORT_FILE} <path>' or '${FLAG_REPORT_STDIN}'.`
          );
          return EXIT_CODE_FAILURE;
        }

        const scope = await resolveScope(stateRepo, issueValue);
        const stage = scope.snapshot?.currentStage ?? null;
        // Issue #311: only the QUALITY_GATE exit consumes gate evidence
        // (`transition-stage.ts`). Accepting REVIEW here wrote a record no
        // transition could ever ingest, which the clear-on-enter hook then
        // deleted as stale — an accepted filing path that was silently orphaned.
        //
        // Issue #327 (Defect 3, AC-5): the refusal used to state only that
        // filing was impossible, which left the operator with no way back after
        // the gate had already exited. It now names the LEGAL walk-back,
        // computed from the transition table, plus the filing command it ends
        // with — so the advice is executable from the stage that prints it.
        if (stage !== STAGE_QUALITY_GATE) {
          const lateIssue = scope.issue ?? issueValue ?? null;
          const mode = scope.snapshot?.mode ?? MODE_STANDARD;
          const walkBack = formatTransitionRecoveryCommands(
            stage,
            STAGE_QUALITY_GATE,
            lateIssue,
            mode
          );
          const crossesPlan =
            stage !== null &&
            (findLegalTransitionPath(stage, STAGE_QUALITY_GATE, mode) ?? []).includes(STAGE_PLAN);
          const planPrerequisite =
            crossesPlan && !scope.snapshot?.planDir
              ? `\`codeloop plan --issue ${lateIssue ?? '<n>'} --plan-dir <dir>\` first (the checkpoint records no plan directory), then `
              : '';
          const recovery =
            walkBack === null
              ? ''
              : ` To file it, ${planPrerequisite}walk back: ${walkBack}, then re-run \`${formatGateReportChannelCommand(lateIssue)}\`.`;
          console.error(
            `✗ Gate evidence refused: checkpoint is at ${stage ?? '(none)'}; evidence can only be filed at ${STAGE_QUALITY_GATE}, the one stage whose exit consumes it.${recovery} Nothing was written.`
          );
          return EXIT_CODE_FAILURE;
        }

        let rawReport: string;
        try {
          rawReport =
            options.reportFile !== null && options.reportFile !== '-'
              ? fs.readFileSync(path.resolve(options.reportFile), 'utf8')
              : fs.readFileSync(0, 'utf8');
        } catch (err: unknown) {
          console.error(
            `✗ Could not read the gate report: ${err instanceof Error ? err.message : String(err)}`
          );
          return EXIT_CODE_FAILURE;
        }

        // The round is stamped FROM THE CHECKPOINT: a block that certifies a
        // different round is refused, so a stale PASSED can never certify a
        // later run. One formula, shared with the ingest side (issue #311).
        const gateRound = resolveGateRound(scope.snapshot?.history);

        let report: GateResultReport;
        try {
          report = GateResultReport.parseBlock(rawReport, gateRound);
        } catch (err: unknown) {
          console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
          return EXIT_CODE_FAILURE;
        }

        // Issue #408 (D2): a PASSED report certifies the gate only when its
        // commands cover the plan's declared Quality Gate Targets. Assessed
        // BEFORE the `--dry-run` branch so a preview reports the SAME findings a
        // real filing would raise — and writes nothing in either case.
        {
          const coverage = assessGateEvidenceCoverage({
            planGenerator,
            workspaceDir: options.workspaceDir || process.cwd(),
            issue: scope.issue ?? issueValue ?? null,
            planPath:
              scope.snapshot?.planPath ??
              scope.snapshot?.approvedPlanPath ??
              options.planPath ??
              null,
            planDir: scope.snapshot?.planDir ?? options.planDir ?? null,
            report
          });
          if (coverage.assessed && !coverage.covered) {
            const refusal = formatGateTargetCoverageRefusal(
              coverage.missing,
              coverage.declared.length,
              scope.issue ?? issueValue ?? null,
              'filing'
            );
            if (options.dryRun) {
              console.error(`[dry-run] ${refusal}`);
              console.error('[dry-run] Nothing was written.');
            } else {
              console.error(`✗ ${refusal}`);
            }
            return EXIT_CODE_FAILURE;
          }
        }

        // Issues #412/#415: a PASSED block that names a test command but records
        // testsPassed = 0 (executed nothing) or null (never measured) is not
        // evidence. Assessed BEFORE the `--dry-run` branch so a preview reports
        // the SAME finding a real filing would raise — and writes nothing.
        {
          const refusal = gateTestEvidenceRefusal(report);
          if (refusal) {
            const rendered = formatGateZeroTestRefusal(
              refusal.commands,
              scope.issue ?? issueValue ?? null,
              'filing',
              refusal.gap
            );
            if (options.dryRun) {
              console.error(`[dry-run] ${rendered}`);
              console.error('[dry-run] Nothing was written.');
            } else {
              console.error(`✗ ${rendered}`);
            }
            return EXIT_CODE_FAILURE;
          }
        }

        if (options.dryRun) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  dryRun: true,
                  recorded: false,
                  verdict: report.verdict,
                  testsStatus: report.testsStatus,
                  durationMs: report.durationMs
                },
                null,
                2
              )
            );
            return EXIT_CODE_SUCCESS;
          }
          console.log(`[dry-run] Would record gate evidence: ${report.formatConfirmation()}`);
          console.log('[dry-run] Nothing was written.');
          return EXIT_CODE_SUCCESS;
        }

        const issueForEvidence = scope.issue ?? issueValue ?? null;
        const gateReportRepo = new FileGateReportRepository({
          workspaceDir: options.workspaceDir || process.cwd(),
          issue: issueForEvidence
        });
        const evidencePath = gateReportRepo.save(issueForEvidence, report);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                dryRun: false,
                recorded: true,
                verdict: report.verdict,
                testsStatus: report.testsStatus,
                durationMs: report.durationMs,
                evidencePath
              },
              null,
              2
            )
          );
          return EXIT_CODE_SUCCESS;
        }

        console.log(`✓ Gate evidence recorded: ${report.formatConfirmation()}`);
        console.log(`  Evidence: ${evidencePath}`);
        // Issue #311: the advice is a state-machine query, not a literal. At
        // any non-filing stage the formatter returns null and no line prints,
        // so the command can never advise a self-transition.
        const nextStep = formatGateReportAdvanceCommand(stage, issueForEvidence);
        if (nextStep !== null) {
          console.log(`  Next: ${nextStep}`);
        }
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case COMMAND_REVIEW: {
      // The INBOUND CHANNEL for a dispatched Reviewer subagent's verdict
      // (issue #269). The reviewer produces a `REVIEW_STATUS: APPROVED |
      // CHANGES_REQUESTED` block; `RunReviewParams.reviewOutput` is the
      // domain's chosen seam for it — and until now NO command supplied it, so
      // the verdict was structurally unrecordable.

      // A verdict was REQUESTED but its value never arrived (issue #269, R1).
      //
      // This is checked BEFORE anything else — before the scope is resolved
      // and long before the use case runs — so nothing is read, nothing is
      // written and NO checkpoint is touched. Falling through to the critique
      // path would record a `SKIPPED` verdict: a SILENT downgrade of the
      // reviewer's real verdict, which is exactly what this channel exists to
      // prevent.
      if (options.verdictFileRequested && options.verdictFile === null) {
        console.error(`✗ ${formatVerdictInputMissing(FLAG_VERDICT_FILE, HINT_VERDICT_FILE_INPUT)}`);
        return EXIT_CODE_FAILURE;
      }
      if (options.reviewOutputRequested && options.reviewOutput === null) {
        console.error(`✗ ${formatVerdictInputMissing(FLAG_REVIEW_OUTPUT, HINT_REVIEW_OUTPUT_INPUT)}`);
        return EXIT_CODE_FAILURE;
      }
      // Issue #297: the Tier 1 evidence flag failed the same way. A report that
      // was requested but never supplied must not become "no cross-check".
      if (options.critiqueReportRequested && options.critiqueReport === null) {
        console.error(`✗ ${formatCritiqueReportInputMissing(FLAG_CRITIQUE_REPORT)}`);
        return EXIT_CODE_FAILURE;
      }
      // ONE stdin: a verdict on stdin and a critique report on stdin cannot both
      // be read, so the invocation is refused before anything is consumed.
      if (options.verdictStdin && options.critiqueReport === CRITIQUE_REPORT_STDIN) {
        console.error(
          `✗ ${FLAG_VERDICT_STDIN} and ${FLAG_CRITIQUE_REPORT} - both read stdin. Supply one of them from a file.`
        );
        return EXIT_CODE_FAILURE;
      }

      try {
        const scope = await resolveScope(stateRepo, issueValue);
        const resolveSubagentUseCase = new ResolveSubagentUseCase(configRepo, githubGateway, promptRepo);
        const reviewUseCase = new RunReviewUseCase(
          scope.repo,
          configRepo,
          planGenerator,
          standardsRepo,
          critique,
          commandExecutor,
          resolveSubagentUseCase,
          critiqueInstaller,
          confirmationPrompt
        );

        // Resolve the reviewer's verdict text (the inbound channel).
        let reviewOutput: string | null = null;
        let reviewOutputSource: string | null = null;
        try {
          if (options.reviewOutput !== null) {
            reviewOutput = options.reviewOutput;
            reviewOutputSource = FLAG_REVIEW_OUTPUT;
          } else if (options.verdictFile !== null) {
            reviewOutput = fs.readFileSync(options.verdictFile, 'utf8');
            reviewOutputSource = options.verdictFile;
          } else if (options.verdictStdin) {
            reviewOutput = fs.readFileSync(0, 'utf8');
            reviewOutputSource = VERDICT_INPUT_SOURCE_STDIN;
            // A verdict was REQUESTED on stdin but stdin carried none
            // (issue #269, R1): the same silent-SKIPPED hole as a
            // present-but-valueless flag, so it fails loudly too.
            if (reviewOutput.trim().length === 0) {
              console.error(`✗ ${formatVerdictInputMissing(FLAG_VERDICT_STDIN, HINT_VERDICT_STDIN_INPUT)}`);
              return EXIT_CODE_FAILURE;
            }
          }
        } catch (err: unknown) {
          console.error(
            `✗ Could not read the reviewer verdict: ${err instanceof Error ? err.message : String(err)}`
          );
          return EXIT_CODE_FAILURE;
        }

        // A parse failure is a HARD failure (issue #269), and it is detected
        // BEFORE anything else: an unreadable verdict is the more actionable
        // diagnostic, and the use case's own stage guard would otherwise mask
        // it with "Cannot run review from stage ...". `ReviewVerdict.parse` is
        // the ONE parser — the use case parses the same text again, so the
        // recorded verdict is the reviewer's verdict or nothing.
        if (reviewOutput !== null) {
          try {
            ReviewVerdict.parse(reviewOutput);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`✗ Reviewer verdict could not be parsed: ${message}`);
            return EXIT_CODE_FAILURE;
          }
        }

        // Issue #297: the Tier 1 evidence is read and PARSED here — before the
        // use case runs — so an unreadable or unparseable report cannot leave a
        // half-applied checkpoint behind. A supplied report suppresses the
        // critique subprocess but never the two-tier invariant itself.
        //
        // Issue #400 (D2b): three failure classes, three messages. A missing or
        // unreadable file is the signature of a crashed critique run, and it
        // must never be reported as a parse failure: that names the evidence
        // file instead of the stage that failed.
        let priorCritiqueReport: AiReviewReport | null = null;
        if (options.critiqueReport !== null) {
          let rawReport: string;
          try {
            rawReport =
              options.critiqueReport === CRITIQUE_REPORT_STDIN
                ? fs.readFileSync(0, 'utf8')
                : fs.readFileSync(options.critiqueReport, 'utf8');
          } catch (err: unknown) {
            console.error(
              formatCritiqueReportUnreadable(
                options.critiqueReport,
                err instanceof Error ? err.message : String(err)
              )
            );
            return EXIT_CODE_FAILURE;
          }
          if (rawReport.trim().length === 0) {
            console.error(formatCritiqueReportEmpty(options.critiqueReport));
            return EXIT_CODE_FAILURE;
          }
          try {
            priorCritiqueReport = AiReviewReport.parse(rawReport);
          } catch (err: unknown) {
            console.error(
              formatCritiqueReportParseFailure(err instanceof Error ? err.message : String(err))
            );
            return EXIT_CODE_FAILURE;
          }
        }

        const result = await reviewUseCase.execute({
          issue: issueValue,
          reviewOutput,
          priorCritiqueReport,
          refutations,
          baseRef: options.baseBranch || undefined,
          configPath: options.configPath,
          dryRun: options.dryRun,
          interactive: promptsAllowed,
          workspaceDir: options.workspaceDir || process.cwd()
        });

        // Issue #349: BOTH exemptions are never silent, and both notes go to
        // stderr — printed before the `--json`/human branches so stdout stays
        // exactly one parseable document (R-5).
        const nonActionableNote = formatNonActionableFindingsNote(result.nonActionableFindings);
        if (nonActionableNote) {
          console.error(nonActionableNote);
        }
        const refutedNote = formatRefutedFindingsNote(
          result.refutations.map((refutation) => ({
            target: refutation.target,
            severity: refutation.severity,
            actionability: refutation.actionability,
            body: refutation.bodyExcerpt,
            reason: refutation.reason
          }))
        );
        if (refutedNote) {
          console.error(refutedNote);
        }

        if (options.json) {
          // A SINGLE JSON document on stdout; warnings go to stderr so stdout
          // stays parseable.
          //
          // On a dry run the payload must NOT assert state that was never
          // written (#275.6 / #248): `currentStage` stays the on-disk stage,
          // the untaken stage travels as `wouldSetStage`, the unfiled verdict as
          // `wouldRecordVerdict`, and `reviewVerdict` is omitted entirely.
          const dryRun = options.dryRun === true;
          const payload: Record<string, unknown> = {
            dryRun,
            verdict: result.verdict.toJSON(),
            verdictSource: result.reviewSource,
            critiqueVerified: result.critiqueVerified,
            passed: result.passed,
            // Issue #349 (additive, both arms): the machine-readable mirror of
            // this round's exemptions and audit trail. `[]` when none.
            nonActionableFindings: result.nonActionableFindings,
            refutations: result.refutations
          };
          if (dryRun) {
            payload.previousStage = result.previousStage ?? result.currentStage;
            payload.currentStage = result.previousStage ?? result.currentStage;
            payload.wouldSetStage = result.currentStage;
            payload.wouldRecordVerdict = result.verdict.status;
            payload.wouldRecordCritiqueVerified = result.critiqueVerified;
          } else {
            payload.currentStage = result.currentStage;
            payload.reviewVerdict = result.verdict.status;
            // Issue #284 (D7): THIS round's reviewer status, read from the run
            // that just computed it. A critique-only re-run supplies no block,
            // so the key is absent — never the previous round's status, which
            // is what scanning history backwards reported.
            if (result.reviewerVerdict) {
              payload.reviewerVerdict = result.reviewerVerdict;
            }
            if (result.reviewedBaseCommit) {
              payload.reviewedBaseCommit = result.reviewedBaseCommit;
            }
          }
          console.log(JSON.stringify(payload, null, 2));
          if (!result.passed) {
            console.error(
              dryRun
                ? `[dry-run] Would record verdict ${result.verdict.status} and revert to ${formatStageBadge(STAGE_IMPLEMENT)}.`
                : '✗ AI Review requested changes. Pipeline reverted to IMPLEMENT.'
            );
          }
          return result.passed ? EXIT_CODE_SUCCESS : EXIT_CODE_FAILURE;
        }

        // Issue #315 (Defect D, AC-6): `formatReportText()` owns the report's
        // title, so printing one here rendered TWO headers for one report. The
        // leading newline is kept so the report still starts on its own line.
        console.log(`\n${result.verdict.formatReportText()}`);
        console.log('');
        // The stage on disk. On a dry run this is the ONLY stage that exists,
        // so the unwritten next stage is never presented as the current one.
        if (options.dryRun) {
          console.log(`Current Stage  : ${formatStageBadge(result.previousStage ?? result.currentStage)}`);
        }
        console.log(`Verdict Source : ${result.reviewSource ?? 'unknown'}`);
        console.log(`Critique Verified : ${result.critiqueVerified}`);
        if (reviewOutputSource) {
          console.log(`Verdict Input  : ${reviewOutputSource}`);
        }
        // Issue #297: a filed APPROVED that Tier 1 never cross-checked is
        // recorded, but it must say so — on stderr, so stdout stays a report.
        if (result.verdict.isApproved() && !result.critiqueVerified) {
          console.error(NOTE_REVIEW_CRITIQUE_NOT_VERIFIED);
        }

        if (options.dryRun) {
          if (!result.passed) {
            console.error(
              `[dry-run] Would record verdict ${result.verdict.status} and revert to ${formatStageBadge(STAGE_IMPLEMENT)}.`
            );
            return EXIT_CODE_FAILURE;
          }
          console.log(`[dry-run] Would set stage : ${formatStageBadge(result.currentStage)}`);
          console.log(
            `[dry-run] Would record verdict ${result.verdict.status} — nothing was recorded.`
          );
          return EXIT_CODE_SUCCESS;
        }

        console.log(`Next Stage     : ${formatStageBadge(result.currentStage)}`);

        if (!result.passed) {
          console.error('✗ AI Review requested changes. Pipeline reverted to IMPLEMENT.');
          return EXIT_CODE_FAILURE;
        }

        console.log('\n✓ AI Review recorded.');
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        // A parse failure is a HARD failure (issue #269): the verdict block
        // could not be parsed, so NOTHING is recorded. The command must never
        // re-run the review without the reviewer's output — that would
        // silently downgrade a CHANGES_REQUESTED to a SKIPPED.
        if (err instanceof ReviewerSubagentError) {
          console.error(`✗ Reviewer verdict could not be parsed: ${err.message}`);
          return EXIT_CODE_FAILURE;
        }
        // Issue #349: every refused refutation is printed, not just the first.
        if (err instanceof RefutationRefusedError) {
          for (const line of err.refusals) {
            console.error(line);
          }
          return EXIT_CODE_FAILURE;
        }
        console.error(`✗ Review failed: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'prompt': {
      const role = options.roleArg || ROLE_PLANNER;
      if (role !== ROLE_PLANNER && role !== ROLE_IMPLEMENTER && role !== ROLE_GATE && role !== ROLE_REVIEWER && role !== ROLE_TRIAGE) {
        console.error(`Valid prompt roles: '${ROLE_PLANNER}', '${ROLE_IMPLEMENTER}', '${ROLE_GATE}', '${ROLE_REVIEWER}', '${ROLE_TRIAGE}'. Received: '${role}'.`);
        return EXIT_CODE_FAILURE;
      }

      const resolveSubagentUseCase = new ResolveSubagentUseCase(
        configRepo,
        githubGateway,
        promptRepo
      );
      const def = resolveSubagentUseCase.execute({ role, customConfig: config });
      console.log('\n=== CodeLoop: Subagent Definition ===');
      console.log(`Subagent Name : ${def.name}`);
      console.log(`Subagent Role : ${def.role}`);
      console.log(`Resolved Tier : ${def.model} (API default: ${def.apiModel})`);
      console.log(`Write Tools   : ${def.capabilities.enable_write_tools ? 'ENABLED' : 'DISABLED (Read-Only)'}`);
      console.log(`Tool Whitelist: ${def.tools.join(', ')}`);
      console.log(
        `Capabilities  : write_tools=${def.capabilities.enable_write_tools}, mcp_tools=${def.capabilities.enable_mcp_tools}`
      );
      console.log(`\n=== CodeLoop: System Prompt (${DEFAULT_PROMPTS_DIR}/${role}.md) ===\n`);
      console.log(def.system_prompt);
      console.log('');
      return EXIT_CODE_SUCCESS;
    }

    case 'release': {
      console.log('\n🚀 CodeLoop: Milestone Release PR Orchestrator');
      try {
        const milestoneReleaseUseCase = new MilestoneReleaseUseCase(
          worktreeManager,
          githubGateway,
          configRepo,
          commandExecutor
        );

        const result = await milestoneReleaseUseCase.execute({
          phaseBranch: options.phaseBranch || undefined,
          baseBranch: options.baseBranch || undefined,
          dryRun: options.dryRun,
          refresh: options.refresh,
          configPath: options.configPath,
          workspaceDir: process.cwd()
        });

        // Issue #315 (AC-30) / #339 (items 8/9): ANSI is for a terminal only.
        // The local `isTTY`-only closure is gone — `paint` is now the ONE
        // colour policy (`color-policy.ts`), so this renderer also honours
        // NO_COLOR and TERM=dumb like every other one.

        // Issue #315 (AC-30): name the RANGE that was validated, and the exact
        // ref it was computed against, before any metrics.
        console.log(`\nCollector Branch : ${paint('35', result.phaseBranch)}`);
        console.log(`Target Base      : ${paint('32', result.baseBranch)}`);
        console.log(
          `Range            : ${result.evaluation.commitObjects} commits from ${result.baseRefUsed}..${result.phaseBranch}`
        );
        console.log(`Predicted SemVer : ${paint('1', result.evaluation.bump.toUpperCase())} (Label: ${paint('36', result.evaluation.releaseLabel)})`);
        // Issue #315 (AC-27): the headline counts DELIVERABLES; the git
        // topology is reported separately so the two can never be confused.
        console.log(`Commit Metrics   : ${result.evaluation.totalCommits} deliverables (${result.evaluation.featuresCount} feats, ${result.evaluation.fixesCount} fixes, ${result.evaluation.breakingCount} breaking; ${result.evaluation.commitObjects} commit objects)`);
        // Issue #315 (AC-32): the GitHub Release-notes half lives in another
        // repository. Say so, so this in-repo change never implies it closed it.
        console.log(`⚠ ${NOTE_RELEASE_NOTES_DEPENDENCY}`);

        if (result.openInFlightPrsCount > 0) {
          console.log(`\n⚠️  Warning: In-flight PRs detected targeting '${result.phaseBranch}'. Ensure all tasks are merged before final release.`);
        }

        if (result.dryRun) {
          console.log(`\n[DRY RUN] Generated Changelog Preview:\n`);
          console.log(result.evaluation.changelog);
          console.log(`\n[DRY RUN] Would create Milestone PR targeting '${result.baseBranch}' with label '${result.evaluation.releaseLabel}'.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.pullRequest) {
          console.log(`\n✓ Milestone Pull Request: ${paint('1', result.pullRequest.url || '#' + result.pullRequest.number)}`);
          console.log(`✓ Release Label Applied : ${paint('36', result.evaluation.releaseLabel)} (Triggers ajxcodes/auto-tag@v1 upon merge)`);
        }

        console.log(`\n✓ ${result.message}\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        if (err instanceof MilestoneReleaseError) {
          console.error(`\n✗ ${err.message}\n`);
          return EXIT_CODE_FAILURE;
        }
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'plan': {
      console.log(`\n🚀 Starting CodeLoop [PLAN-ONLY] Mode`);
      try {
        const scope = await resolveScope(stateRepo, issueValue);
        const result = await makeLifecycleUseCase(scope.repo).execute({
          mode: MODE_PLAN,
          issue: issueValue,
          title: options.title,
          type: options.type,
          dryRun: options.dryRun,
          configPath: options.configPath,
          skipDiscovery: options.skipDiscovery,
          planPath: options.planPath,
          planDir: options.planDir,
          interactive: promptsAllowed
        });

        const planBreakerHalt = persistedHaltExitCode(result);
        if (planBreakerHalt !== null) {
          return planBreakerHalt;
        }

        if (options.dryRun) {
          // #339 (item 2 + audit extra E1): the preview mirrors the REAL run's
          // branch — reuse when the real run adopts an existing directory,
          // scaffold only when it would create one, the supplied plan when
          // `--plan-path` is given, and NOTHING when the run would park (a park
          // scaffolds nothing). The title is the resolved one the real run
          // would scaffold with, never a placeholder guess.
          const preview = result.planResult?.dryRunPreview;
          if (preview?.action === 'supplied') {
            console.log(`\n[DRY RUN] Would use supplied plan: ${preview.dir}`);
          } else if (preview?.action === 'reuse') {
            console.log(`\n[DRY RUN] Would reuse existing plan directory: ${preview.dir}`);
          } else if (preview?.action === 'scaffold') {
            // Issue #364 (AC-7): name the SAME bounded folder and file the real
            // run would create, so the pre-flight check cannot report success
            // for a scaffold the real run refuses.
            const scaffoldTarget =
              preview.dir ??
              `artifacts/plans/${preview.folderName ? `${preview.folderName}/` : ''}`;
            const createdFile = preview.fileName ? ` and create ${preview.fileName}` : '';
            console.log(
              `\n[DRY RUN] Would scaffold ${scaffoldTarget}${createdFile} for: "${preview.title}" (type: ${preview.type})`
            );
          }
        } else {
          const suppliedPlanPath = result.planResult?.suppliedPlanPath ?? null;
          if (suppliedPlanPath) {
            console.log('');
            printSuppliedPlanSummary(suppliedPlanPath, result.currentStage);
          } else if (result.planResult?.scaffoldInfo) {
            console.log('');
            printPlanScaffoldSummary(result.planResult.scaffoldInfo);
          }
        }

        // Issue #315 (Defect B, AC-3/AC-4): the subagent block ADVERTISES the
        // NEXT dispatch, so it may only be printed when the stage it names is
        // still the next actionable stage once this command returns. A dry run
        // writes nothing, so for it the stage on disk is the only truth. And it
        // must never fire on an invocation whose work was Discovery: no planner
        // ran there, and printing `planner`/`pro` after a run that only read the
        // RCA report is the defect itself (it fired on the park path too). Those
        // paths name the subagent that actually ran instead.
        const previousStage = scope.snapshot?.currentStage ?? null;
        const stageAfterThisRun = options.dryRun ? previousStage : result.currentStage;
        const enteredAtDiscoveryWork =
          previousStage === null ||
          previousStage === STAGE_INITIALIZED ||
          previousStage === STAGE_DISCOVERY;
        const plannerIsNextActionable =
          stageAfterThisRun === STAGE_PLAN &&
          !enteredAtDiscoveryWork &&
          result.pausedAtGate !== GATE_APPROVAL &&
          result.planResult?.discoveryParked !== true;

        if (plannerIsNextActionable && result.planResult?.plannerDef) {
          const p = result.planResult.plannerDef;
          console.log(`\nSubagent     : ${p.name} (${p.role})`);
          console.log(`Model Tier   : ${p.model}`);
          console.log(`Whitelisted  : ${p.tools.join(', ')}`);
          console.log(
            `Safety Guard : Scoped plan modification (write_tools=${p.capabilities.enable_write_tools}, mcp_tools=${p.capabilities.enable_mcp_tools})\n`
          );
        } else if (
          result.planResult?.discoveryDef &&
          // #339 (item 1): `--skip-discovery` exists to SKIP Discovery — the
          // block must never name the Discovery subagent for a run that
          // deliberately performed none. It cannot suppress a park attribution:
          // the skip flag forces `ADVANCE_TO_PLAN`, so a park never coexists
          // with it.
          options.skipDiscovery !== true &&
          // Issue #400 (D1): only `discoveryParked` means DISCOVERY is still the
          // stage after this run — that is the one case where the next dispatch
          // really is the Discovery subagent. `previousStage === STAGE_DISCOVERY`
          // is true for a park AND for an advance, so it advertised a dispatch
          // that had already happened. Printing nothing on the advance is the
          // only statement true in both plan states (blank plan ⇒ `next`
          // dispatches the planner; substantive plan ⇒ `next` advances to
          // APPROVAL).
          result.planResult.discoveryParked === true
        ) {
          // The subagent this invocation still has to dispatch: the Discovery
          // attribution, never the planner's. `inherit` here is the model the
          // discovery role resolved to, not a `pro` attribution for work that
          // did not run.
          const d = result.planResult.discoveryDef;
          console.log(`\nSubagent     : ${d.name} (${d.role})`);
          console.log(`Model Tier   : ${d.model}\n`);
        }

        // #339 (item 2): the dry-run leg FIRST. It used to sit behind the park
        // leg, so a dry-run park printed the real park note ("State is
        // checkpointed") while writing nothing and never reached the
        // disclaimer. On a dry run the disclaimer ALWAYS prints; park/approval
        // outcomes follow as `Would …` statements only, and `result.message`
        // (the real park note) is never printed.
        if (options.dryRun) {
          // Issue #315 (Defect F, AC-5): a dry run writes no checkpoint, so it
          // must never claim an advance. The stage on disk is the stage it
          // reports; a fresh install with no checkpoint has none.
          const unchanged = previousStage
            ? `still ${formatStageBadge(previousStage)}`
            : 'no checkpoint exists yet';
          console.log(`\n[DRY RUN] Stage unchanged: ${unchanged}. No checkpoint was written.`);
          if (result.planResult?.discoveryParked === true) {
            console.log(
              '[DRY RUN] Would park at DISCOVERY for RCA: populate the discovery report, then run `codeloop plan --issue <n>` (or pass --skip-discovery).'
            );
          } else if (result.pausedAtGate === GATE_APPROVAL) {
            console.log(`[DRY RUN] Would pause at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
          }
        } else if (result.pausedAtGate === GATE_APPROVAL) {
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
          console.log(`Review artifacts in artifacts/plans/ and run 'codeloop implement' to continue.\n`);
        } else if (result.planResult?.discoveryParked === true) {
          // Issue #237, finding 3: a parked re-entry looks exactly like a
          // successful advance (`currentStage` is still DISCOVERY), so without
          // this leg `codeloop plan` printed "✓ Pipeline advanced to
          // DISCOVERY." — the precise string the plan wanted gone, and the
          // operator was never told the outstanding work is the RCA report.
          // `RunLifecycleUseCase.executePlanMode` already builds the message;
          // the CLI was simply dropping it on every mode but YOLO.
          console.log(`\n🛑 ${result.message ?? withRecordedPauseHint(NOTE_DISCOVERY_PARK_AWAITING_RCA, result.pausedAtGate)}\n`);
        } else if (previousStage !== null && previousStage === result.currentStage) {
          // Issue #315 (AC-5): the same success line fired at a stage the run
          // did not leave (e.g. `plan` at QUALITY_GATE named QUALITY_GATE as an
          // "advance"). Say what is true: nothing moved.
          console.log(`\nAlready at ${formatStageBadge(result.currentStage)}; nothing to advance.`);
        } else {
          console.log(`\n✓ Pipeline advanced to ${formatStageBadge(result.currentStage)}.`);
        }
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        const haltCode = lifecycleHaltExitCode(err);
        if (haltCode !== null) {
          return haltCode;
        }
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 CodeLoop Pre-Flight Check: ${err.message}\n`);
          return EXIT_CODE_SUCCESS;
        }
        if (err instanceof MilestoneSealedError) {
          console.error(`\n🛑 ${err.message}\n`);
          return EXIT_CODE_FAILURE;
        }
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'implement': {
      console.log(`\n🚀 Resuming CodeLoop Implementation`);
      try {
        const scope = await resolveScope(stateRepo, issueValue);
        const result = await makeLifecycleUseCase(scope.repo).execute({
          mode: MODE_IMPLEMENT,
          issue: issueValue,
          configPath: options.configPath,
          dryRun: options.dryRun,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined,
          planPath: options.planPath,
          planDir: options.planDir,
          interactive: promptsAllowed
        });

        const implementBreakerHalt = persistedHaltExitCode(result);
        if (implementBreakerHalt !== null) {
          return implementBreakerHalt;
        }

        const impl = result.implementationResult;
        if (impl?.resumed) {
          console.log(
            `${options.dryRun ? '[dry-run] ' : ''}Already at ${formatStageBadge(STAGE_IMPLEMENT)}. Resuming code modifications.\n`
          );
        } else {
          console.log(
            `${options.dryRun ? '[dry-run] ' : '✓ '}Advanced to ${formatStageBadge(STAGE_IMPLEMENT)}. Ready for code modifications.\n`
          );
        }
        if (options.dryRun) {
          // The mutation is correctly suppressed (`start-implementation.ts`
          // gates it on `dryRun`); only the output used to claim otherwise (#248).
          console.log('[dry-run] Nothing was written.\n');
        }

        if (result.worktree) {
          console.log(`🌲 Isolated Worktree: ${result.worktree.worktreePath} (branch: ${result.worktree.branch})`);
        }

        if (impl?.planPath) {
          console.log(`📁 Loaded Approved Plan: ${impl.planPath}`);
        }
        if (impl?.implementerDef) {
          console.log(`Subagent     : ${impl.implementerDef.name} (${impl.implementerDef.role})`);
          console.log(`Model Tier   : ${impl.implementerDef.model}`);
          console.log(`Write Tools  : ENABLED (write_to_file, replace_file_content, run_command)`);
          console.log(`Whitelisted  : ${impl.implementerDef.tools.join(', ')}\n`);
        }
        console.log(`Next Step    : Execute checklist items and run 'codeloop next' when complete.\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        const haltCode = lifecycleHaltExitCode(err);
        if (haltCode !== null) {
          return haltCode;
        }
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 CodeLoop Pre-Flight Check: ${err.message}\n`);
          return EXIT_CODE_SUCCESS;
        }
        if (err instanceof MilestoneSealedError) {
          console.error(`\n🛑 ${err.message}\n`);
          return EXIT_CODE_FAILURE;
        }
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'commit': {
      console.log(`\n📦 CodeLoop: Semantic Conventional Commit Gate`);
      try {
        // The scope decides the FILE: `commit` used to read the root checkpoint
        // and refuse with "Cannot draft commit: Pipeline is at '<other stage>'"
        // while the live run sat in `tasks/<n>.json` (#250, Scope A).
        const scope = await resolveScope(stateRepo, issueValue);
        const snapshot = scope.snapshot;
        const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : null;
        const rootWorkspaceDir = options.workspaceDir || process.cwd();
        const effectiveWorkspaceDir = sm?.worktree?.worktreePath || rootWorkspaceDir;

        let finalMessage = options.message;
        if (options.messageFile) {
          finalMessage = fs.readFileSync(options.messageFile, 'utf8').trim();
        }

        const draftCommitUseCase = new DraftCommitUseCase(
          scope.repo,
          commandExecutor,
          githubGateway,
          planGenerator
        );

        const draftResult = await draftCommitUseCase.execute({
          issue: issueValue,
          staged: options.staged,
          userMessage: finalMessage,
          workspaceDir: effectiveWorkspaceDir
        });

        console.log(`\nProposed Conventional Commit:`);
        console.log(`  ${paint('32', draftResult.commitMessage.toSingleLine())}`);
        if (draftResult.commitMessage.body) {
          console.log(`\nBody:\n${draftResult.commitMessage.body}`);
        }
        if (draftResult.commitMessage.isBreaking) {
          // #382 D1: the warning follows the FINAL message, not the analysis
          // result. `--message-file`/`-m` can replace the plan's message with a
          // non-breaking one (or a different breaking one), and a warning that
          // contradicted the subject printed directly above it is worse than no
          // warning at all. `draftResult.plan.isBreaking` stays for JSON and
          // reporting only.
          console.log(`\n⚠️  BREAKING CHANGE detected!`);
        }
        console.log(`\nFiles to commit (${draftResult.listedFiles.length}):`);
        draftResult.listedFiles.forEach((f) =>
          console.log(`  - ${f}${draftResult.untrackedFiles.includes(f) ? ' (untracked)' : ''}`)
        );
        if (draftResult.excludedFiles.length > 0) {
          // Issue #301: the same exclusion list the commit applies. The list
          // above never contains these, so saying so cannot contradict itself.
          console.log(`   (excluded from the commit: .agyloop, node_modules, artifacts)`);
        }

        if (options.dryRun) {
          console.log(`\n[DRY RUN] Simulated commit. No changes were committed.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (!options.yes && !promptsAllowed) {
          // `commit` refuses `--json` at the capability gate (#248), so the only
          // way to reach this guard is a genuinely non-interactive terminal.
          // Saying "non-interactive terminal" about a fully interactive TTY is
          // factually false and sends the user hunting for a TTY problem they
          // do not have, so the refusal stays non-zero and names the fix.
          console.error(
            `\n[codeloop] Non-interactive terminal detected. Re-run with -y/--yes to confirm, or run interactively.\n`
          );
          return EXIT_CODE_FAILURE;
        }

        const executeCommitUseCase = new ExecuteCommitUseCase(
          scope.repo,
          commandExecutor,
          planGenerator,
          confirmationPrompt,
          worktreeManager
        );

        const execResult = await executeCommitUseCase.execute({
          commitMessage: draftResult.commitMessage,
          // Only assert explicit confirmation when the user passed -y/--yes. A literal
          // `false` short-circuits the gate in the use case and silently cancels the
          // commit instead of prompting, which diverged from the lifecycle entry point.
          confirmed: options.yes ? true : undefined,
          bypassConfirmation: options.yes,
          interactive: promptsAllowed,
          staged: options.staged,
          dryRun: options.dryRun,
          issue: issueValue,
          keepWorktree: options.keepWorktree,
          workspaceDir: effectiveWorkspaceDir,
          rootWorkspaceDir: rootWorkspaceDir,
          createPr: options.createPr
        });

        if (execResult.confirmed && execResult.success) {
          console.log(`\n✓ Successfully committed: ${paint('1', String(execResult.commitHash))}`);
          // Issue #315 (AC-24): a terminal stage is not the same claim as
          // delivery. When the checkpoint recorded no PR, say so on the advance
          // line instead of letting COMPLETED imply the work shipped.
          const deliveryRecord = execResult.stateMachine.pullRequest;
          const noPrRecorded = !deliveryRecord || deliveryRecord.status === 'missing';
          console.log(
            `✓ Pipeline advanced to ${formatStageBadge(execResult.currentStage)}.${noPrRecorded ? ' — no PR (see below)' : ''}`
          );
          // Issue #301/#307: name the tree the commit actually landed in.
          console.log(
            `   ✓ Committed in: ${execResult.commitCwd} (${execResult.worktreeMode === 'isolated' ? 'isolated worktree' : 'workspace root'})`
          );
          if (execResult.fallbackUsed) {
            console.log(`✓ Remote push succeeded via HTTPS token fallback.`);
          }
          if (execResult.pushError) {
            console.log(`\n⚠️  Remote push failed. Worktree preserved for manual recovery.\n   Error: ${execResult.pushError}`);
          }
          if (execResult.worktreeTornDown) {
            // Issue #247: descriptor-accurate reporting — never claim "Isolated"
            // for a non-isolated worktree descriptor.
            console.log(`✓ Git worktree torn down and pruned: ${execResult.worktreeTornDownPath ?? '(unknown)'}${execResult.worktreeTornDownIsolated === true ? ' (isolated)' : ''}.`);
          }
          if (execResult.prCreated) {
            // Issue #240/Defect 1: report the PR this run CREATED. The manual
            // script below is printed only when no PR was created.
            const headBranch = execResult.stateMachine.worktree?.branch ?? '';
            console.log(
              execResult.prUrl
                ? `\n✓ PR created: ${execResult.prUrl}`
                : `\n✓ PR created for branch '${headBranch}' (URL unavailable).`
            );
          } else if (execResult.prExists) {
            const headBranch = execResult.stateMachine.worktree?.branch ?? '';
            console.log(`\n✓ PR already exists for branch '${headBranch}'.`);
          } else if (execResult.prCommand) {
            // Issue #315 (AC-25 / #332): one copy-pasteable command AND the
            // reason it exists. "Commit succeeded" is not "run delivered".
            const headBranch = execResult.stateMachine.worktree?.branch ?? '<task branch>';
            console.log(
              `\n⚠ Branch '${headBranch}' is pushed but NOT delivered — no PR exists. Run:\n  ${execResult.prCommand}\n`
            );
          }
          // Issue #240/Defect 3: a closing keyword only auto-closes on the
          // DEFAULT branch. Say so, and name the compensator, instead of
          // letting the operator assume `Closes #N` did something.
          //
          // Issue #351: the caveat keyed on `issueValue` — the `--issue` flag
          // only — so the pipeline's OWN recommended invocation (`codeloop
          // commit --create-pr`, issue taken from the checkpoint) suppressed
          // it. `resolvedIssue` is the value that produced the body's `Closes
          // #N`, so the warning can no longer describe a keyword the PR does
          // not carry, nor stay silent when it does.
          const caveatIssue = execResult.resolvedIssue ?? issueValue;
          if (execResult.prBaseIsCollector && caveatIssue) {
            console.log(
              `\n⚠ Closing keyword caveat: this PR targets the collector branch '${execResult.prBaseBranch}'.`
            );
            console.log(
              `  \`Closes #${caveatIssue}\` will not auto-close the issue on merge. Run \`codeloop sync\` after the merge to close it.`
            );
          }
          if (execResult.summaryUpdated) {
            console.log(`✓ CodeLoop Summary.md updated with commit hash and timestamp.\n`);
          }
          return EXIT_CODE_SUCCESS;
        } else {
          console.log(`\nCommit cancelled by user. Working tree remains uncommitted.\n`);
          return EXIT_CODE_SUCCESS;
        }
      } catch (err: unknown) {
        console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_CODE_FAILURE;
      }
    }

    case COMMAND_SYNC: {
      console.log(`\n🔄 CodeLoop: Synchronizing Remote Collector Branch & Merged PRs`);
      try {
        // The scope resolution lives INSIDE the try (issue #250, review N2): an
        // unreadable NAMED checkpoint must be REPORTED as a sync failure, not
        // thrown out of `runCli` as a raw stack. Before #250 the checkpoint was
        // read inside `SyncUseCase.execute` — which catches its own errors and
        // returns `Sync failed: …` — so that contract is restored here.
        const scope = await resolveScope(stateRepo, issueValue);
        const syncUseCase = new SyncUseCase(
          commandExecutor,
          githubGateway,
          scope.repo,
          worktreeManager
        );
        const res = await syncUseCase.execute({
          workspaceDir: process.cwd(),
          dryRun: options.dryRun
        });
        if (res.success) {
          // The dry-run message already carries `[dry-run] `; a `✓` here would
          // claim the fetch happened (#248).
          console.log(`${res.dryRun ? '' : '✓ '}${res.message}\n`);
          // Issue #240/Defect 3: every decision is auditable. A PR that was NOT
          // closed says why, instead of the run silently doing less than the
          // operator expects.
          for (const log of res.logs ?? []) {
            console.log(`  · ${log}`);
          }
          for (const warning of res.warnings ?? []) {
            console.error(`⚠ ${warning}`);
          }
          return EXIT_CODE_SUCCESS;
        } else {
          console.error(`✗ ${res.message}\n`);
          // An incomplete run must still show WHICH issues were skipped or
          // closed: the operator cannot audit the run otherwise (#328).
          for (const log of res.logs ?? []) {
            console.log(`  · ${log}`);
          }
          for (const warning of res.warnings ?? []) {
            console.error(`⚠ ${warning}`);
          }
          return EXIT_CODE_FAILURE;
        }
      } catch (err: unknown) {
        console.error(`✗ Sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'yolo': {
      console.log(`\n⚡ Starting CodeLoop [YOLO] Fast-Path Mode`);
      try {
        const scope = await resolveScope(stateRepo, issueValue);
        const result = await makeLifecycleUseCase(scope.repo).execute({
          mode: MODE_YOLO,
          issue: issueValue,
          title: options.title,
          type: options.type,
          commitAfter: options.commitAfter,
          // Issue #315 (AC-22/AC-25 / #332): a hands-off `--commit-after` run
          // opens the delivery PR itself. Without this, every unattended path
          // stopped one step short of delivery — pushed branch, no PR, and a
          // checkpoint claiming COMPLETED. An interactive/forwarded run keeps
          // the opt-in default and gets the printed `gh pr create …` line.
          createPr: options.createPr || options.commitAfter === true,
          staged: options.staged,
          message: options.message,
          dryRun: options.dryRun,
          configPath: options.configPath,
          skipDiscovery: options.skipDiscovery,
          planPath: options.planPath,
          planDir: options.planDir,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined,
          interactive: promptsAllowed
        });

        const yoloBreakerHalt = persistedHaltExitCode(result);
        if (yoloBreakerHalt !== null) {
          return yoloBreakerHalt;
        }

        if (options.dryRun) {
          console.log(`\n[DRY RUN] ${result.message || 'Simulated execution completed.'}\n`);
          return EXIT_CODE_SUCCESS;
        }

        // #234: yolo can halt before gates (bug issues parked at DISCOVERY, or the
        // wrong-stage guard checkpoint). Surface `result.message` + standard guidance
        // instead of falling through to the "gates and review passed" copy below.
        if (!result.qualityGateResult && !result.reviewResult && !result.executeCommitResult) {
          const suppliedPlanPath = result.planResult?.suppliedPlanPath ?? null;
          if (suppliedPlanPath) {
            printSuppliedPlanSummary(suppliedPlanPath, result.currentStage);
          } else if (result.planResult?.scaffoldInfo) {
            printPlanScaffoldSummary(result.planResult.scaffoldInfo);
          }

          // Issue #259: the implementation park. A non-green block on stderr
          // (the halt is NOT a success signal; stdout stays parseable), followed
          // by the implementer dispatch directive — produced by the SAME
          // `GetNextActionUseCase` that `codeloop next` uses, so the payload
          // shape cannot drift.
          if (result.implementationHalted) {
            const baseRef = result.implementationDiff?.baseRef ?? 'main';
            const measurementError = result.implementationDiff?.measurementError ?? null;
            const baseAheadCommits = result.implementationDiff?.baseAheadCommits ?? 0;
            const mergeBase = result.implementationDiff?.mergeBase ?? null;

            console.error(`⚠ ${NOTE_IMPLEMENTATION_EVIDENCE_MISSING}.`);
            if (measurementError !== null) {
              // Issue #263: the branch's own changes could not be measured, so
              // "the working tree is unchanged" would be a claim the probe
              // cannot support. Say what actually happened instead.
              console.error(
                `   ${NOTE_IMPLEMENTATION_UNMEASURABLE.replace('{baseRef}', baseRef).replace(
                  '{error}',
                  measurementError
                )}`
              );
            } else {
              console.error(`   ${NOTE_IMPLEMENTATION_PARK_UNCHANGED.replace('{baseRef}', baseRef)}`);
              if (baseAheadCommits > 0 && mergeBase !== null) {
                // Issue #263: staleness is advisory — the corrected measurement
                // is the enforcement — but the operator should know that the
                // build about to be gated is behind the base branch.
                console.error(
                  `   ⚠ ${NOTE_IMPLEMENTATION_STALE_WORKTREE.replace(
                    '{ahead}',
                    String(baseAheadCommits)
                  )
                    .replace('{baseRef}', baseRef)
                    .replace('{mergeBase}', mergeBase.slice(0, 7))}`
                );
              }
            }
            console.error(`   ${NOTE_IMPLEMENTATION_PARK_DISPATCH}`);

            // Issue #259 (S10): the fast-path never dispatches the PLANNER
            // either, so its plan is the tool's own blank scaffold. A directive
            // that points at an EMPTY plan is a false instruction — the
            // implementer would have nothing to execute. The advisory replaces
            // the ordinary continuation line (printing both would tell the
            // operator to dispatch an implementer with nothing to do) and the
            // payload is suppressed entirely.
            //
            // Issue #263: the plan-empty advisory is tied to the MEASURED case
            // only — when the tree could not be measured, the first problem is
            // that the tree cannot be certified.
            if (measurementError === null && result.implementationPlanEmpty === true) {
              const planPath = result.implementationResult?.planPath ?? '(the scaffolded plan)';
              const parkCount = result.implementationPlanParkCount ?? 1;
              if (parkCount >= PLAN_EMPTY_PARK_REPEAT_THRESHOLD) {
                console.error(
                  `   ${NOTE_IMPLEMENTATION_PLAN_EMPTY_REPEAT.replace('{planPath}', planPath).replace('{count}', String(parkCount))}`
                );
              } else {
                console.error(`   ${NOTE_IMPLEMENTATION_PLAN_EMPTY.replace('{planPath}', planPath)}`);
              }
              console.error(`   ${NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT}`);
            } else {
              console.error(`   ${NOTE_IMPLEMENTATION_PARK_NEXT}`);
              await printImplementerDirective(scope.repo, configRepo, planGenerator, githubGateway, worktreeManager, buildDetector, makeInferBaseBranchUseCase(scope.repo), new DetectImplementationDiffUseCase(commandExecutor), options.configPath, issueValue, critique);
            }
            return EXIT_CODE_SUCCESS;
          }

          console.log(`\n${result.success ? '⏸' : '🛑'} ${result.message ?? `YOLO fast-path halted at ${result.currentStage}.`}\n`);
          return result.success ? EXIT_CODE_SUCCESS : EXIT_CODE_FAILURE;
        }

        {
          const suppliedPlanPath = result.planResult?.suppliedPlanPath ?? null;
          if (suppliedPlanPath) {
            printSuppliedPlanSummary(suppliedPlanPath, result.currentStage);
            console.log(`⚡ Auto-approved plan gate -> streaming into implementation.`);
          } else if (result.planResult?.scaffoldInfo) {
            printPlanScaffoldSummary(result.planResult.scaffoldInfo);
            console.log(`⚡ Auto-approved plan gate -> streaming into implementation.`);
          }
        }

        if (result.worktree) {
          console.log(`🌲 Isolated Worktree: ${result.worktree.worktreePath} (branch: ${result.worktree.branch})`);
        }

        if (result.qualityGateResult?.summaryReport) {
          console.log('\n' + result.qualityGateResult.summaryReport + '\n');
        }

        if (result.qualityGateResult && !result.qualityGateResult.passed) {
          // Issue #259 (defence in depth): a VACUOUS verdict is a REFUSAL, not
          // a failure — no gate command ran, nothing was reverted, and no gate
          // retry was consumed. The "gates failed / reverted" copy would be a
          // false claim.
          if (result.qualityGateResult.vacuous === true) {
            console.error(`⚠ ${result.message ?? NOTE_GATES_VACUOUS_YOLO}`);
            return EXIT_CODE_SUCCESS;
          }
          console.error(`✗ Quality gates failed in YOLO mode. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
          return EXIT_CODE_FAILURE;
        }

        if (result.reviewResult) {
          if (result.reviewResult.verdict.status === VERDICT_SKIPPED) {
            // Loud, distinct advisory (issue #236): absence of a reviewer must never
            // masquerade as a rejection. console.error keeps it on stderr and
            // capture-able by the existing runCli test harnesses.
            console.error(`⚠ AI PR Review: SKIPPED — no reviewer output and no critique report. Proceeding WITHOUT AI review.`);
            console.error(`  Enable it: \`codeloop critique install\` or dispatch the Reviewer via \`codeloop next\`.`);
          } else {
            console.log(`✓ AI PR Review: ${result.reviewResult.verdict.status}`);
          }
          if (!result.reviewResult.passed) {
            console.error(`✗ AI Review requested changes in YOLO mode. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
            return EXIT_CODE_FAILURE;
          }
        }

        if (result.executeCommitResult && result.executeCommitResult.success) {
          console.log(`\n✓ 100% Unattended Loop Finished: ${paint('1', String(result.executeCommitResult.commitHash))}`);
          console.log(`✓ Pipeline Stage: ${formatStageBadge(result.currentStage)}.`);
          if (result.executeCommitResult.fallbackUsed) {
            console.log(`✓ Remote push succeeded via HTTPS token fallback.`);
          }
          if (result.executeCommitResult.pushError) {
            console.log(`\n⚠️  Remote push failed. Worktree preserved for manual recovery.\n   Error: ${result.executeCommitResult.pushError}`);
          }
          console.log('');
        } else if (result.reviewResult?.verdict.status === VERDICT_SKIPPED) {
          console.log(`\n✓ Quality gates passed in YOLO mode. AI review SKIPPED (advisory — no reviewer output or critique report).`);
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'codeloop commit' or re-run with '--commit-after'.\n`);
        } else {
          console.log(`\n✓ Quality gates and AI review passed in YOLO mode.`);
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'codeloop commit' or re-run with '--commit-after'.\n`);
        }

        if (result.reviewResult?.updateNotification) {
          console.log('\n' + result.reviewResult.updateNotification);
        }

        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        const haltCode = lifecycleHaltExitCode(err);
        if (haltCode !== null) {
          return haltCode;
        }
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 CodeLoop Pre-Flight Check: ${err.message}\n`);
          return EXIT_CODE_SUCCESS;
        }
        if (err instanceof MilestoneSealedError) {
          console.error(`\n🛑 ${err.message}\n`);
          return EXIT_CODE_FAILURE;
        }
        // #234: a wrong-stage transition that still escapes a use case gets the
        // standard checkpoint guidance instead of a bare `✗`.
        if (err instanceof InvalidTransitionError) {
          console.error(`\n🛑 ${err.message}`);
          console.error(`State is checkpointed — run \`codeloop next\` for the next directive or \`${RESUME_COMMAND}\` to clear a pause.\n`);
          return EXIT_CODE_FAILURE;
        }
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'gate':
    case 'gates':
      console.error('error: `gate`/`gates` subcommands have been removed. Use `codeloop next` to invoke the gate subagent.');
      return EXIT_CODE_FAILURE;

    case COMMAND_OPENCODE: {
      const subcmd = options.opencodeSubcommand || 'install';
      if (subcmd === 'install') {
        try {
          // #339 (item 4): this command WRITES two files (the skill asset and
          // the `/codeloop` command registration), so `--dry-run` must simulate
          // instead of refusing it as "read-only". The preview resolves both
          // target paths through the same helpers the real install uses and
          // writes nothing.
          if (options.dryRun) {
            const preview = installOpenCodeIntegration({ force: options.force, dryRun: true });
            console.log('\n[dry-run] OpenCode integration install simulated — nothing was written.');
            if (preview.configPath) {
              console.log(`[dry-run] Would write: ${preview.configPath}`);
            }
            console.log(`[dry-run] Would write: ${preview.installedPath}`);
            return EXIT_CODE_SUCCESS;
          }
          const res = installOpenCodeIntegration({ force: options.force });
          console.log('\n✓ OpenCode Integration Assets Installed:');
          console.log(`  Source   : ${res.sourcePath}`);
          console.log(`  Target   : ${res.installedPath}`);
          console.log(`  Mode     : ${res.isSymlink ? 'Symlink' : 'Copy'}`);
          console.log(`  Workspace: ${res.canonicalBaseDir} (${res.canonicalizationMethod})`);
          console.log(
            `  Command  : ${res.commandRegistered ? 'registered' : res.configPath ? 'already present' : 'not registered'} @ ${res.configPath ?? '(none)'}`
          );
          for (const warning of res.warnings) {
            console.log(`  ⚠️  ${warning}`);
          }
          if (res.degradedReason) {
            console.log(`  ⚠️  Install degraded: ${res.degradedReason}`);
          }
          console.log('');
          return EXIT_CODE_SUCCESS;
        } catch (err: unknown) {
          console.error(`✗ Failed to install OpenCode integration: ${err instanceof Error ? err.message : String(err)}`);
          return EXIT_CODE_FAILURE;
        }
      } else {
        console.error(`Unknown opencode subcommand "${subcmd}". Available: install`);
        return EXIT_CODE_FAILURE;
      }
    }

    default: {
      if (command !== null) {
        console.error(`Error: Unknown command "${command}". Run "codeloop --help" for available commands.\n`);
        return EXIT_CODE_FAILURE;
      }

      // Default execution: Continuous Lifecycle Orchestration
      console.log(`\n🔄 CodeLoop Continuous Development Lifecycle`);
      try {
        const scope = await resolveScope(stateRepo, issueValue);
        const result = await makeLifecycleUseCase(scope.repo).execute({
          mode: MODE_STANDARD,
          issue: issueValue,
          title: options.title,
          type: options.type,
          commitAfter: options.commitAfter,
          // Issue #315 (AC-22/AC-25 / #332): a hands-off `--commit-after` run
          // opens the delivery PR itself. Without this, every unattended path
          // stopped one step short of delivery — pushed branch, no PR, and a
          // checkpoint claiming COMPLETED. An interactive/forwarded run keeps
          // the opt-in default and gets the printed `gh pr create …` line.
          createPr: options.createPr || options.commitAfter === true,
          yes: options.yes,
          staged: options.staged,
          message: options.message,
          interactive: promptsAllowed,
          interactiveCommit: promptsAllowed && !options.yes,
          dryRun: options.dryRun,
          configPath: options.configPath,
          skipDiscovery: options.skipDiscovery,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined,
          planPath: options.planPath,
          planDir: options.planDir
        });

        if (result.pausedAtGate === GATE_APPROVAL) {
          const suppliedPlanPath = result.planResult?.suppliedPlanPath ?? null;
          if (suppliedPlanPath) {
            printSuppliedPlanSummary(suppliedPlanPath, result.currentStage);
          } else if (result.planResult?.scaffoldInfo) {
            printPlanScaffoldSummary(result.planResult.scaffoldInfo);
          }
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
          console.log(`Review artifacts and run 'codeloop implement' (or 'codeloop') to continue.\n`);
          return EXIT_CODE_SUCCESS;
        }

        // Issue #237, finding 3: same park, same silence as the `plan` case. A
        // re-entry that parks at DISCOVERY leaves `currentStage === DISCOVERY`,
        // so the "Pipeline at stage: DISCOVERY" line below reads like progress
        // and never names the outstanding work. `RunLifecycleUseCase.
        // executeStandardMode` builds the message; print it.
        if (result.planResult?.discoveryParked === true) {
          console.log(`\n🛑 ${result.message ?? withRecordedPauseHint(NOTE_DISCOVERY_PARK_AWAITING_RCA, result.pausedAtGate)}\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.worktree) {
          console.log(`🌲 Isolated Worktree: ${result.worktree.worktreePath} (branch: ${result.worktree.branch})`);
        }

        if (result.qualityGateResult?.summaryReport) {
          console.log('\n' + result.qualityGateResult.summaryReport + '\n');
        }

        if (result.qualityGateResult && !result.qualityGateResult.passed) {
          // Issue #259: a VACUOUS verdict is a REFUSAL, not a failure. No gate
          // command ran and nothing was reverted, so the "gates failed /
          // reverted to IMPLEMENT" copy would be a false claim. The
          // lifecycle's message is the truth.
          if (result.qualityGateResult.vacuous === true) {
            // The fallback is the domain constant with `{baseRef}` substituted
            // from the verdict — the same source the lifecycle uses — so the
            // message can never drift from the lifecycle's own wording.
            const baseRef = result.implementationDiff?.baseRef ?? 'main';
            console.error(`⚠ ${result.message ?? NOTE_GATES_VACUOUS_STANDARD.replace('{baseRef}', baseRef)}`);
            return EXIT_CODE_SUCCESS;
          }
          console.error(`✗ Quality gates failed. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
          return EXIT_CODE_FAILURE;
        }

        if (result.reviewResult) {
          if (result.reviewResult.verdict.status === VERDICT_SKIPPED) {
            // Loud, distinct advisory (issue #236) — same treatment as the yolo handler.
            console.error(`⚠ AI PR Review: SKIPPED — no reviewer output and no critique report. Proceeding WITHOUT AI review.`);
            console.error(`  Enable it: \`codeloop critique install\` or dispatch the Reviewer via \`codeloop next\`.`);
          } else {
            console.log(`AI PR Review: ${result.reviewResult.verdict.status}`);
          }
          if (!result.reviewResult.passed) {
            console.error(`✗ AI Review requested changes. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
            return EXIT_CODE_FAILURE;
          }
        }

        if (result.executeCommitResult && result.executeCommitResult.success) {
          console.log(`\n✓ Successfully committed: ${paint('1', String(result.executeCommitResult.commitHash))}`);
          console.log(`✓ Pipeline advanced to ${formatStageBadge(result.currentStage)}.`);
          if (result.executeCommitResult.fallbackUsed) {
            console.log(`✓ Remote push succeeded via HTTPS token fallback.`);
          }
          if (result.executeCommitResult.pushError) {
            console.log(`\n⚠️  Remote push failed. Worktree preserved for manual recovery.\n   Error: ${result.executeCommitResult.pushError}`);
          }
          console.log('');
          return EXIT_CODE_SUCCESS;
        }

        const breakerHaltCode = persistedHaltExitCode(result);
        if (breakerHaltCode !== null) {
          return breakerHaltCode;
        }

        if (result.pausedAtGate === GATE_COMMIT) {
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'codeloop commit' to execute.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.currentStage === STAGE_COMPLETED) {
          console.log(`✓ Pipeline is in ${formatStageBadge(STAGE_COMPLETED)} stage.\n`);
        } else {
          console.log(`Pipeline at stage: ${formatStageBadge(result.currentStage)}\n`);
        }

        if (result.reviewResult?.updateNotification) {
          console.log('\n' + result.reviewResult.updateNotification);
        }

        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        const haltCode = lifecycleHaltExitCode(err);
        if (haltCode !== null) {
          return haltCode;
        }
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 CodeLoop Pre-Flight Check: ${err.message}\n`);
          return EXIT_CODE_SUCCESS;
        }
        if (err instanceof MilestoneSealedError) {
          console.error(`\n🛑 ${err.message}\n`);
          return EXIT_CODE_FAILURE;
        }
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }
  }
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  let parsedOptions: CliOptions | null = null;
  try {
    const parsed = parseArguments(rawArgs);
    parsedOptions = parsed.options;
  } catch {
    // Non-fatal fallback if parsing raw args fails
  }

  let isAborting = false;
  const handleSignal = async (signal: string) => {
    if (isAborting) {
      process.exit(1);
    }
    isAborting = true;
    console.error(`\n[${signal}] Received emergency termination signal. Invoking abort protocol...`);
    try {
      const parsedToken = parseIssueToken(parsedOptions?.issue);
      const issueValue = parsedToken.kind === 'valid' ? parsedToken.issue : undefined;
      const stateRepo = new FileStateRepository({
        workspaceDir: parsedOptions?.workspaceDir,
        issue: issueValue
      });
      const abortUseCase = new AbortPipelineUseCase({
        stateRepo,
        commandExecutor: new ProcessCommandExecutor(),
        worktreeManager: new GitWorktreeManager(),
        planGenerator: new FilePlanGenerator()
      });
      await abortUseCase.execute({
        workspaceDir: parsedOptions?.workspaceDir,
        issue: issueValue,
        force: true,
        reason: `POSIX Signal ${signal}`,
        noQuarantine: parsedOptions?.noQuarantine === true
      });
    } catch {
      // Best-effort cleanup
    }
    process.exit(1);
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  if (process.platform !== 'win32') {
    process.once('SIGUSR1', () => handleSignal('SIGUSR1'));
  }

  try {
    const code = await runCli(rawArgs);
    if (code !== 0) {
      process.exit(code);
    }
  } catch (err: unknown) {
    console.error('Fatal:', err);
    process.exit(EXIT_CODE_FAILURE);
  }
}

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STAGE_QUALITY_GATE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STAGE_INITIALIZED,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STAGE_DISCOVERY,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STAGE_PLAN,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  DEFAULT_PROMPTS_DIR,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  EXIT_CODE_QUOTA_EXHAUSTED,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_WORKTREE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_RELEASE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_CRITIQUE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  COMMAND_TRIAGE,
  COMMAND_SYNC,
  COMMAND_INIT,
  COMMAND_RESUME,
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
  CircuitBreakerTrippedError,
  QUOTA_RESUME_COMMAND,
  StateMachine,
  IssueNumber,
  STATE_MUTATING_COMMANDS
} from '../domain';
import type { StateRepository } from '../ports';
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
  FileProjectScaffolder
} from '../infrastructure';
import { installOpenCodeIntegration } from './opencode-setup';
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  SyncUseCase,
  AbortPipelineUseCase,
  InitProjectUseCase,
  ResumePipelineUseCase
} from '../application';

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
  reason: string | null;
}

export interface ParsedCliArgs {
  command: string | null;
  options: CliOptions;
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
 * `codeloop next` only *reports* a pause — it never clears one. `resumeFromGate()` is
 * reachable from `resume`, `transition` and `triage`, so exit code 2 telling users to
 * "resume with codeloop next" was advice that could not work. Help text, the `next`
 * banner and the `status` recovery hint therefore name this command.
 *
 * It is declared here rather than imported so the help text keeps naming a command that
 * clears the pause even if a domain constant drifts again;
 * `tests/presentation/cli-gate-pause-visibility.test.ts` pins it against
 * `QUOTA_RESUME_COMMAND` (domain), which must resolve to the same string.
 */
export const RESUME_COMMAND = 'codeloop resume';

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
  readonly resumeCommand: string;
  readonly message: string;
}

/**
 * Reads the persisted gate pause, or `null` when the pipeline is not paused.
 *
 * Never throws: a missing, unreadable or corrupt checkpoint must not take down a
 * command whose real job is to report state (issue #218 AC4).
 */
export async function readPersistedGatePause(stateRepo: StateRepository): Promise<PersistedGatePause | null> {
  try {
    const snapshot = await stateRepo.load();
    const gate = snapshot?.pausedAtGate ?? null;
    if (!gate) {
      return null;
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
  plan               Plan-only mode; generates persistent plan in artifacts/plans/ and halts at [APPROVAL] gate
  implement          Resume implementation directly from approved plan specification
  commit             Draft Conventional Commit and prompt for interactive human approval
  release [branch]   Generate Milestone Release PR from phase collector to main with SemVer label
  sync               Fast-forward collector branch and process merged PRs to auto-close issues

Pipeline Management:
  next               Inspect state and generate next invoke_subagent command/payload
  branch-info        Display base collector branch, active task branch, and PR target
  status             Display current pipeline stage, active tasks matrix, and checkpoint history
  config             Display active configuration and model routing table
  models             List available Gemini models and mapped Antigravity tiers
  prompt [role]      Inspect subagent definition, whitelist, and system prompt (planner|implementer|gate|reviewer)
  reset              Reset .agyloop/state.json checkpoint (supports --issue <id> and --all)
  resume             Clear a persisted gate pause (CIRCUIT_BREAKER, APPROVAL, COMMIT, TRIAGE) and checkpoint the wait time
  abort              Emergency Stop: halts subagents, clears locks, quarantines worktrees, stops sandboxes
  transition <STAGE> Advance state machine to target stage
  worktree [cmd]     Manage isolated git worktrees (list | clean | prune | remove <id>)
  critique [cmd]     Manage Critique CLI installation (status | install | update)
  opencode [cmd]     Manage OpenCode integration assets (install: skill + /codeloop command)
  triage [action]    Triage PR review comments and route pipeline (implement|plan|discovery|dismiss)

Operational Flags:
      --yolo         Enable unattended fast-path (equivalent to 'yolo' command)
      --commit-after Automatically draft and commit changes if quality gates and AI review pass
      --step         Pause compound execution after quality gates (before AI review)
  -y, --yes          Skip interactive confirmation prompt (auto-approve commit)
  -m, --message <msg> Explicit conventional commit message override
      --message-file <path> Read commit message from file
      --create-pr    Automatically create a PR after commit
  -s, --staged       Inspect / commit staged changes only (git diff --cached)
  -f, --force        Force operation (force abort, fresh version check or reinstallation)
      --quarantine   Quarantine uncommitted changes to a dedicated branch during abort
      --issue <num>  Associate execution with GitHub issue number
      --title <text> Specify plan title for persistent artifact scaffolding
      --type <type>  Specify plan type (discovery | implementation | auto)
      --config <path> Path to custom configuration file (.agyloop.json)
      --model <name> Override agent runner model (e.g. ornith:9b-128k)
      --worktree     Enable git worktree isolation for task execution (default: true)
      --no-worktree  Disable worktree isolation and execute directly in root workspace
      --keep-worktree Keep git worktree after commit completion (prevent auto-teardown)
      --subagents    Prune external Antigravity subagent worktrees (used with worktree prune/clean)
      --all          Include/prune all worktrees (used with worktree list/prune/clean)
      --json         Output machine-readable JSON for scripting and piping
      --base-branch <branch> Override base branch for worktree or milestone release
      --refresh      Force refresh of discovered Gemini models or milestone release PR
      --dry-run      Simulate execution without modifying state or files on disk
  -h, --help         Show this help message and exit
  -v, --version      Show version information and exit

Exit Codes:
  0   Success
  1   Failure (gate, review, config or usage error). Work is NOT checkpointed for resume.
  2   Provider quota exhausted (HTTP 429 / RESOURCE_EXHAUSTED / rate-limit rejection).
      Recoverable: state is checkpointed at the CIRCUIT_BREAKER gate and nothing is lost.
      Resume with '${RESUME_COMMAND}' once the quota window resets — 'codeloop next' only
      reports the pause, it does not clear it.
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
  codeloop worktree list                 List all active isolated git worktrees
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
    reason: null
  };

  const positional: string[] = [];

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
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--quarantine') {
      options.quarantine = true;
    } else if (arg === '--reason') {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.reason = args[++i];
      } else {
        options.reason = null;
      }
    } else if (arg.startsWith('--reason=')) {
      options.reason = arg.split('=')[1] || null;
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
    } else if (arg === '--create-pr') {
      options.createPr = true;
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
    } else if (!arg.startsWith('-')) {
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

  return { command, options };
}

export function formatStageBadge(stage: string): string {
  const colors: Record<string, string> = {
    INITIALIZED: '\x1b[36m', // Cyan
    DISCOVERY: '\x1b[34m',   // Blue
    PLAN: '\x1b[35m',        // Magenta
    APPROVAL: '\x1b[33m',    // Yellow
    IMPLEMENT: '\x1b[32m',   // Green
    QUALITY_GATE: '\x1b[36m',// Cyan
    REVIEW: '\x1b[34m',      // Blue
    COMMIT: '\x1b[32m',      // Green
    COMPLETED: '\x1b[32m\x1b[1m', // Bold Green
    TRIAGE: '\x1b[33m\x1b[1m'     // Bold Yellow
  };
  const reset = '\x1b[0m';
  const color = colors[stage] || '';
  return `${color}[${stage}]${reset}`;
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
}): Record<string, unknown> {
  return {
    success: result.success,
    resumed: result.resumed,
    persisted: result.persisted,
    pausedAtGate: result.pausedAtGate,
    pausedAtTimestamp: result.pausedAtTimestamp,
    totalHumanWaitMs: result.totalHumanWaitMs,
    currentStage: result.currentStage,
    mode: result.mode,
    issue: result.issue,
    message: result.message
  };
}

export async function runCli(rawArgs: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { command, options } = parseArguments(rawArgs);

  if (options.help) {
    printHelp();
    return EXIT_CODE_SUCCESS;
  }

  if (options.version) {
    console.log(`agyloop v${CLI_VERSION}`);
    return EXIT_CODE_SUCCESS;
  }

  const issueValue = IssueNumber.tryFrom(options.issue)?.value;
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

  const lifecycleUseCase = new RunLifecycleUseCase({
    stateRepo,
    configRepo,
    planGenerator,
    githubGateway,
    commandExecutor,
    buildDetector,
    standardsRepo,
    critique,
    critiqueInstaller,
    confirmationPrompt,
    worktreeManager
  });

  const manageCritiqueUseCase = new ManageCritiqueUseCase(critique, critiqueInstaller);

  const inferBaseBranchUseCase = new InferBaseBranchUseCase(worktreeManager, githubGateway, stateRepo);

  // Treat 'yolo' subcommand or --yolo flag as YOLO execution
  const effectiveCommand = command === null && options.yolo ? 'yolo' : command;

  if (process.env.AGY_SUBAGENT === '1' && effectiveCommand !== 'triage' && (STATE_MUTATING_COMMANDS as readonly (string | null)[]).includes(effectiveCommand)) {
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
      const getNextActionUseCase = new GetNextActionUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway,
        undefined,
        worktreeManager,
        buildDetector,
        inferBaseBranchUseCase
      );
      const res = await getNextActionUseCase.execute({
        configPath: options.configPath,
        issue: options.issue
      });

      // A persisted gate pause (quota exhaustion, exhausted retries) must never be
      // mistaken for a runnable directive. It is read BEFORE the `--json` branch
      // because that command is what the agent harness runs (skills/agyloop/SKILL.md),
      // and a pause it cannot see is a pause it will happily execute through.
      const pause = await readPersistedGatePause(stateRepo);
      const pausedAtBreakerGate = pause?.gate === GATE_CIRCUIT_BREAKER;

      if (options.json) {
        // Machine-readable output stays a single JSON document: the pause travels as
        // data, never as prose on stdout. `actionable` is the single boolean a harness
        // needs to decide whether to invoke the subagent.
        console.log(
          JSON.stringify(
            {
              ...res,
              actionable: pause === null,
              pause
            },
            null,
            2
          )
        );
        if (pause) {
          // Warnings go to stderr so stdout stays parseable.
          console.error(`🛑 ${pause.message}`);
        }
        return EXIT_CODE_SUCCESS;
      }

      console.log('\n=== CodeLoop: Next Subagent Directive ===');
      if (pausedAtBreakerGate) {
        console.log(`Status       : 🛑 ${GATE_CIRCUIT_BREAKER} — ${res.humanSummary}`);
        console.log('Resolve the blocking condition (e.g. wait for the provider quota window),');
        console.log(`then re-run \`${RESUME_COMMAND}\`. State is checkpointed; nothing is lost.\n`);
      }
      console.log(`Current Stage : ${formatStageBadge(res.currentStage)}`);
      console.log(`Next Action   : ${res.title}`);
      if (res.baseBranch) {
        console.log(`Base Branch   : ${res.baseBranch}`);
      }
      if (res.taskBranch) {
        console.log(`Task Branch   : ${res.taskBranch}`);
      }
      if (res.worktreePath) {
        console.log(`Target Cwd    : ${res.worktreePath}`);
      }
      console.log(`Description   : ${res.description}`);
      console.log(`Summary       : ${res.humanSummary}\n`);

      if (res.invocationPayload) {
        console.log('--- invoke_subagent JSON Payload ---');
        console.log(JSON.stringify(res.invocationPayload, null, 2));
        console.log('\nPass this payload directly to invoke_subagent or copy into chat.\n');
      }
      return EXIT_CODE_SUCCESS;
    }

    case 'branch-info': {
      const snapshot = await stateRepo.load();
      const currentBranch = await worktreeManager.resolveBaseBranch();
      const defaultBranch = 'main';

      let issue = options.issue ? Number(options.issue) : snapshot?.issue || null;
      if (!issue) {
        issue =
          IssueNumber.inferFromPath(snapshot?.worktree?.worktreePath as string | undefined) ??
          IssueNumber.inferFromPath(process.cwd()) ??
          IssueNumber.inferFromBranch(currentBranch);
        if (issue && snapshot && !snapshot.issue) {
          try {
            const sm = StateMachine.fromSnapshot(snapshot);
            sm.setIssue(issue);
            await stateRepo.save(sm.toSnapshot());
          } catch {
            // Non-fatal persistence
          }
        }
      }

      let baseBranch = snapshot?.baseBranch || null;
      if (!baseBranch && issue) {
        try {
          const infer = new InferBaseBranchUseCase(worktreeManager, githubGateway, stateRepo);
          const res = await infer.execute({ issueNumber: issue });
          baseBranch = res.baseBranch;
        } catch {
          baseBranch = null;
        }
      }

      const activeTaskBranch = snapshot?.worktree?.branch || (currentBranch.startsWith('task/') || currentBranch.startsWith('fix/') ? currentBranch : null);
      const collectorBranch = baseBranch || (currentBranch.startsWith('phase/') || currentBranch.startsWith('feature/') ? currentBranch : null);
      const prTarget = collectorBranch || defaultBranch;

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              baseBranch: collectorBranch,
              taskBranch: activeTaskBranch,
              worktreePath: snapshot?.worktree?.worktreePath || null,
              prBaseTarget: prTarget,
              milestoneTarget: defaultBranch
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
      if (snapshot?.worktree?.worktreePath) {
        console.log(`Isolated Worktree     : ${snapshot.worktree.worktreePath}`);
      }
      console.log('');
      return EXIT_CODE_SUCCESS;
    }

    case 'status': {
      const getStatusUseCase = new GetPipelineStatusUseCase(stateRepo);
      const result = await getStatusUseCase.execute();
      console.log('\n=== CodeLoop: Pipeline Status ===');
      console.log(`Current Stage : ${formatStageBadge(result.status.currentStage)}`);
      console.log(`Execution Mode: ${result.status.mode}`);
      console.log(`Active Issue  : ${result.status.issue ? '#' + result.status.issue : 'None'}`);
      console.log(`Updated At    : ${result.status.updatedAt}`);
      console.log(`Checkpoint    : ${result.stateFilePath}`);

      // Additive: nothing else below distinguishes a live pipeline from one halted at
      // a gate, so an operator could not tell that the run was waiting on them.
      const statusPause = await readPersistedGatePause(stateRepo);
      if (statusPause) {
        console.log(`Paused At Gate: ${statusPause.gate}`);
        console.log(`Paused At     : ${statusPause.pausedAt ?? '(unknown)'}`);
        if (statusPause.gate === GATE_CIRCUIT_BREAKER) {
          console.log('Recovery      : resolve the blocking condition (e.g. wait for the provider quota window),');
          console.log(`                then run \`${RESUME_COMMAND}\`.`);
        }
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
      const resetUseCase = new ResetPipelineUseCase(stateRepo);
      await resetUseCase.execute({
        issue: options.issue,
        all: options.all
      });
      if (options.all) {
        console.log('✓ CodeLoop pipeline state reset. .agyloop/state.json and all task checkpoints purged.');
      } else if (options.issue) {
        console.log(`✓ CodeLoop task state reset. Checkpoint for issue #${options.issue} cleared.`);
      } else {
        console.log('✓ CodeLoop pipeline state reset. .agyloop/state.json cleared.');
      }
      return EXIT_CODE_SUCCESS;
    }

    case COMMAND_RESUME: {
      // Guarded by STATE_MUTATING_COMMANDS ('resume' clears the persisted pause, so it
      // mutates the checkpoint exactly like `reset` does): a subagent is refused above.
      try {
        const resumeUseCase = new ResumePipelineUseCase(stateRepo);
        const resumeResult = await resumeUseCase.execute({ dryRun: options.dryRun });

        if (options.json) {
          // Single JSON document on stdout; anything diagnostic goes to stderr.
          console.log(JSON.stringify(buildResumeJsonPayload(resumeResult), null, 2));
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

    case 'abort': {
      console.log('\n🛑 CodeLoop: Initiating Emergency Abort Protocol...');
      const abortUseCase = new AbortPipelineUseCase({
        stateRepo,
        commandExecutor,
        worktreeManager,
        planGenerator
      });

      const abortResult = await abortUseCase.execute({
        workspaceDir: options.workspaceDir,
        issue: options.issue,
        force: options.force,
        quarantine: options.quarantine
      });

      console.log(`✓ Emergency Abort completed in ${abortResult.durationMs}ms:`);
      console.log(`  - Processes terminated     : ${abortResult.processesTerminated}`);
      console.log(`  - Stale git locks cleared  : ${abortResult.indexLockRemoved ? 'YES' : 'NONE'}`);
      console.log(`  - Worktrees quarantined    : ${abortResult.worktreesQuarantined.length}`);
      for (const wt of abortResult.worktreesQuarantined) {
        const actionStr = wt.branch ? `branch: ${wt.branch}` : (wt.stashed ? 'stashed' : 'quarantined');
        console.log(`    * ${wt.worktreePath} (${actionStr})`);
      }
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
        console.error('Error: Please specify target stage. Example: agyloop transition PLAN');
        console.error('Valid stages:', Object.keys(STAGES).join(', '));
        return EXIT_CODE_FAILURE;
      }
      try {
        const transitionUseCase = new TransitionStageUseCase(
          stateRepo,
          worktreeManager,
          inferBaseBranchUseCase,
          planGenerator
        );
        await transitionUseCase.execute({
          targetStage: options.stageArg as StageName,
          metadata: { note: 'Manual CLI transition' },
          noWorktree: options.noWorktree,
          baseBranch: options.baseBranch,
          issue: options.issue
        });
        console.log(`✓ Transitioned to ${formatStageBadge(options.stageArg)}`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'worktree': {
      const manageWorktreeUseCase = new ManageWorktreeUseCase(worktreeManager);
      const sub = options.worktreeSubcommand || 'list';

      if (sub === 'list') {
        const res = await manageWorktreeUseCase.list({
          includeExternal: options.all
        });
        const list = res.data || [];
        console.log('\n=== CodeLoop: Active Isolated Git Worktrees ===');
        if (list.length === 0) {
          console.log('No isolated worktrees found.\n');
        } else {
          console.log('--------------------------------------------------------------------------------');
          console.log('Task ID      Branch                         Worktree Directory');
          console.log('--------------------------------------------------------------------------------');
          for (const wt of list) {
            const idPad = wt.taskId.padEnd(12);
            const bPad = wt.branch.padEnd(30);
            console.log(`${idPad} ${bPad} ${wt.worktreePath}`);
          }
          console.log('--------------------------------------------------------------------------------\n');
        }
        return EXIT_CODE_SUCCESS;
      }

      if (sub === 'clean' || sub === 'prune') {
        console.log('Pruning orphaned git worktrees and locks...');
        const res = await manageWorktreeUseCase.clean({
          subagents: options.subagents,
          all: options.all
        });
        console.log(`✓ ${res.message}\n`);
        return EXIT_CODE_SUCCESS;
      }

      if (sub === 'remove' || sub === 'rm') {
        if (!options.worktreeTarget) {
          console.error('Error: Please specify task ID or worktree path to remove. Example: agyloop worktree remove 87');
          return EXIT_CODE_FAILURE;
        }
        const targetPath = await worktreeManager.resolveTaskWorktreePath(process.cwd(), options.worktreeTarget);
        console.log(`Removing worktree at ${targetPath}...`);
        const res = await manageWorktreeUseCase.teardown({ worktreePath: targetPath });
        console.log(`✓ ${res.message}\n`);
        return EXIT_CODE_SUCCESS;
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
            console.log(JSON.stringify(status, null, 2));
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
            console.log('   Run `agyloop critique update` to upgrade.\n');
          } else if (!status.resolution.isAvailable) {
            console.log('\n⚠️  Critique CLI is not installed.');
            console.log('   Run `agyloop critique install` to install it automatically.\n');
          } else {
            console.log('\n✓ Critique CLI is installed and up to date.\n');
          }
          return EXIT_CODE_SUCCESS;
        }

        case 'install': {
          console.log('\n📥 Installing Critique CLI...');
          const result = await manageCritiqueUseCase.install({ force: options.force });
          if (result.success) {
            console.log(`✓ Successfully installed critique v${result.version} to:`);
            console.log(`  ${result.targetPath}\n`);
            return EXIT_CODE_SUCCESS;
          } else {
            console.error(`✗ Installation failed: ${result.error || 'Unknown error'}\n`);
            return EXIT_CODE_FAILURE;
          }
        }

        case 'update': {
          console.log('\n🔄 Updating Critique CLI...');
          const result = await manageCritiqueUseCase.update();
          if (result.success) {
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
      const triageUseCase = new TriagePrCommentsUseCase(
        stateRepo,
        githubGateway,
        planGenerator,
        worktreeManager,
        inferBaseBranchUseCase
      );

      const rawAction = options.triageAction ? options.triageAction.toLowerCase() : null;
      const validActions = ['implement', 'plan', 'discovery', 'dismiss', 'completed'];
      if (rawAction && !validActions.includes(rawAction)) {
        console.error(`Error: Unrecognized triage action '${options.triageAction}'. Available: implement, plan, discovery, dismiss, completed.`);
        return EXIT_CODE_FAILURE;
      }
      const action = (rawAction || undefined) as TriageAction | undefined;

      if (action && process.env.AGY_SUBAGENT !== '1') {
        console.error('Error: Execution blocked. Root agent is not allowed to run pipeline routing triage actions.');
        console.error('You must invoke the dedicated Triage Subagent to handle PR review categorization.');
        return EXIT_CODE_FAILURE;
      }

      console.log('\n=== CodeLoop: PR Review Comments Triage ===');
      try {
        const result = await triageUseCase.execute({
          issue: options.issue,
          action,
          notes: options.message || undefined,
          workspaceDir: process.cwd()
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return EXIT_CODE_SUCCESS;
        }

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
          console.log('(Read-only list mode: no state changes. Provide an action: implement|plan|discovery|dismiss.)\n');
          return EXIT_CODE_SUCCESS;
        }

        console.log(`✓ Triage Action : ${action.toUpperCase()}`);
        console.log(`✓ Next Stage    : ${formatStageBadge(result.targetStage)}`);
        console.log(`✓ State Updated : Pipeline transitioned to ${result.targetStage}\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ Triage failed: ${err instanceof Error ? err.message : String(err)}\n`);
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

        console.log(`\nCollector Branch : \x1b[35m${result.phaseBranch}\x1b[0m`);
        console.log(`Target Base      : \x1b[32m${result.baseBranch}\x1b[0m`);
        console.log(`Predicted SemVer : \x1b[1m${result.evaluation.bump.toUpperCase()}\x1b[0m (Label: \x1b[36m${result.evaluation.releaseLabel}\x1b[0m)`);
        console.log(`Commit Metrics   : ${result.evaluation.totalCommits} commits (${result.evaluation.featuresCount} feats, ${result.evaluation.fixesCount} fixes, ${result.evaluation.breakingCount} breaking)`);

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
          console.log(`\n✓ Milestone Pull Request: \x1b[1m${result.pullRequest.url || '#' + result.pullRequest.number}\x1b[0m`);
          console.log(`✓ Release Label Applied : \x1b[36m${result.evaluation.releaseLabel}\x1b[0m (Triggers ajxcodes/auto-tag@v1 upon merge)`);
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
        const result = await lifecycleUseCase.execute({
          mode: MODE_PLAN,
          issue: options.issue,
          title: options.title,
          type: options.type,
          dryRun: options.dryRun,
          configPath: options.configPath,
          interactive: promptsAllowed
        });

        const planBreakerHalt = persistedHaltExitCode(result);
        if (planBreakerHalt !== null) {
          return planBreakerHalt;
        }

        if (options.dryRun) {
          console.log(
            `\n[DRY RUN] Would scaffold artifacts/plans/ for: "${result.planResult?.planTitle}" (type: ${result.planResult?.planType})`
          );
        } else if (result.planResult?.scaffoldInfo) {
          const info = result.planResult.scaffoldInfo;
          console.log(`\n📁 Initialized plan directory: artifacts/plans/${info.folderName}/`);
          console.log(`  ✓ Specification (${info.type}): ${path.basename(info.planPath)}`);
          if (info.mirrorPath) {
            console.log(`  ✓ Canonical Mirror  : ${path.basename(info.mirrorPath)}`);
          }
          console.log(`  ✓ Execution Log     : ${path.basename(info.summaryPath)}`);
        }

        if (result.planResult?.plannerDef) {
          const p = result.planResult.plannerDef;
          console.log(`\nSubagent     : ${p.name} (${p.role})`);
          console.log(`Model Tier   : ${p.model}`);
          console.log(`Whitelisted  : ${p.tools.join(', ')}`);
          console.log(
            `Safety Guard : Scoped plan modification (write_tools=${p.capabilities.enable_write_tools}, mcp_tools=${p.capabilities.enable_mcp_tools})\n`
          );
        }

        if (result.pausedAtGate === GATE_APPROVAL) {
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
          console.log(`Review artifacts in artifacts/plans/ and run 'agyloop implement' to continue.\n`);
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
        const result = await lifecycleUseCase.execute({
          mode: MODE_IMPLEMENT,
          issue: options.issue,
          configPath: options.configPath,
          dryRun: options.dryRun,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined,
          interactive: promptsAllowed
        });

        const implementBreakerHalt = persistedHaltExitCode(result);
        if (implementBreakerHalt !== null) {
          return implementBreakerHalt;
        }

        const impl = result.implementationResult;
        if (impl?.resumed) {
          console.log(`Already at ${formatStageBadge(STAGE_IMPLEMENT)}. Resuming code modifications.\n`);
        } else {
          console.log(`✓ Advanced to ${formatStageBadge(STAGE_IMPLEMENT)}. Ready for code modifications.\n`);
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
        console.log(`Next Step    : Execute checklist items and run 'agyloop next' when complete.\n`);
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
        const snapshot = await stateRepo.load();
        const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : null;
        const rootWorkspaceDir = options.workspaceDir || process.cwd();
        const effectiveWorkspaceDir = sm?.worktree?.worktreePath || rootWorkspaceDir;

        let finalMessage = options.message;
        if (options.messageFile) {
          finalMessage = fs.readFileSync(options.messageFile, 'utf8').trim();
        }

        const draftCommitUseCase = new DraftCommitUseCase(
          stateRepo,
          commandExecutor,
          githubGateway,
          planGenerator
        );

        const draftResult = await draftCommitUseCase.execute({
          issue: options.issue,
          staged: options.staged,
          userMessage: finalMessage,
          workspaceDir: effectiveWorkspaceDir
        });

        console.log(`\nProposed Conventional Commit:`);
        console.log(`  \x1b[32m${draftResult.commitMessage.toSingleLine()}\x1b[0m`);
        if (draftResult.commitMessage.body) {
          console.log(`\nBody:\n${draftResult.commitMessage.body}`);
        }
        if (draftResult.plan.isBreaking) {
          console.log(`\n⚠️  BREAKING CHANGE detected!`);
        }
        console.log(`\nFiles to commit (${draftResult.plan.modifiedFiles.length}):`);
        draftResult.plan.modifiedFiles.forEach((f) => console.log(`  - ${f}`));

        if (options.dryRun) {
          console.log(`\n[DRY RUN] Simulated commit. No changes were committed.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (!options.yes && !promptsAllowed) {
          // `promptsAllowed` folds in `!options.json`, so this single guard covers two
          // unrelated situations. Saying "non-interactive terminal" about a fully
          // interactive TTY is factually false and sends the user hunting for a TTY
          // problem they do not have, so the diagnostic is split while the refusal
          // (and its non-zero exit) stays identical.
          console.error(
            options.json
              ? `\n[agyloop] Machine-readable output requested; re-run without --json or pass -y/--yes to confirm.\n`
              : `\n[agyloop] Non-interactive terminal detected. Re-run with -y/--yes to confirm, or run interactively.\n`
          );
          return EXIT_CODE_FAILURE;
        }

        const executeCommitUseCase = new ExecuteCommitUseCase(
          stateRepo,
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
          issue: options.issue,
          keepWorktree: options.keepWorktree,
          workspaceDir: effectiveWorkspaceDir,
          rootWorkspaceDir: rootWorkspaceDir,
          createPr: options.createPr
        });

        if (execResult.confirmed && execResult.success) {
          console.log(`\n✓ Successfully committed: \x1b[1m${execResult.commitHash}\x1b[0m`);
          console.log(`✓ Pipeline advanced to ${formatStageBadge(execResult.currentStage)}.`);
          if (execResult.fallbackUsed) {
            console.log(`✓ Remote push succeeded via HTTPS token fallback.`);
          }
          if (execResult.pushError) {
            console.log(`\n⚠️  Remote push failed. Worktree preserved for manual recovery.\n   Error: ${execResult.pushError}`);
          }
          if (execResult.worktreeTornDown) {
            console.log(`✓ Isolated git worktree torn down and pruned.`);
          }
          if (execResult.prCommand) {
            console.log(`\nNext Step (Create PR):\n  ${execResult.prCommand}`);
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
      const syncUseCase = new SyncUseCase(
        commandExecutor,
        githubGateway,
        stateRepo,
        worktreeManager
      );
      const res = await syncUseCase.execute({ workspaceDir: process.cwd() });
      if (res.success) {
        console.log(`✓ ${res.message}\n`);
        return EXIT_CODE_SUCCESS;
      } else {
        console.error(`✗ ${res.message}\n`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'yolo': {
      console.log(`\n⚡ Starting CodeLoop [YOLO] Fast-Path Mode`);
      try {
        const result = await lifecycleUseCase.execute({
          mode: MODE_YOLO,
          issue: options.issue,
          title: options.title,
          type: options.type,
          commitAfter: options.commitAfter,
          staged: options.staged,
          message: options.message,
          dryRun: options.dryRun,
          configPath: options.configPath,
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

        if (result.planResult?.scaffoldInfo) {
          const info = result.planResult.scaffoldInfo;
          console.log(`📁 Initialized plan directory: artifacts/plans/${info.folderName}/`);
          console.log(`⚡ Auto-approved plan gate -> streaming into implementation.`);
        }

        if (result.worktree) {
          console.log(`🌲 Isolated Worktree: ${result.worktree.worktreePath} (branch: ${result.worktree.branch})`);
        }

        if (result.qualityGateResult?.summaryReport) {
          console.log('\n' + result.qualityGateResult.summaryReport + '\n');
        }

        if (result.qualityGateResult && !result.qualityGateResult.passed) {
          console.error(`✗ Quality gates failed in YOLO mode. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
          return EXIT_CODE_FAILURE;
        }

        if (result.reviewResult) {
          console.log(`✓ AI PR Review: ${result.reviewResult.verdict.status}`);
          if (!result.reviewResult.passed) {
            console.error(`✗ AI Review requested changes in YOLO mode. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
            return EXIT_CODE_FAILURE;
          }
        }

        if (result.executeCommitResult && result.executeCommitResult.success) {
          console.log(`\n✓ 100% Unattended Loop Finished: \x1b[1m${result.executeCommitResult.commitHash}\x1b[0m`);
          console.log(`✓ Pipeline Stage: ${formatStageBadge(result.currentStage)}.`);
          if (result.executeCommitResult.fallbackUsed) {
            console.log(`✓ Remote push succeeded via HTTPS token fallback.`);
          }
          if (result.executeCommitResult.pushError) {
            console.log(`\n⚠️  Remote push failed. Worktree preserved for manual recovery.\n   Error: ${result.executeCommitResult.pushError}`);
          }
          console.log('');
        } else {
          console.log(`\n✓ Quality gates and AI review passed in YOLO mode.`);
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'agyloop commit' or re-run with '--commit-after'.\n`);
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

    case 'gate':
    case 'gates':
      console.error('error: `gate`/`gates` subcommands have been removed. Use `agyloop next` to invoke the gate subagent.');
      return EXIT_CODE_FAILURE;

    case 'opencode': {
      const subcmd = options.opencodeSubcommand || 'install';
      if (subcmd === 'install') {
        try {
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
        console.error(`Error: Unknown command "${command}". Run "agyloop --help" for available commands.\n`);
        return EXIT_CODE_FAILURE;
      }

      // Default execution: Continuous Lifecycle Orchestration
      console.log(`\n🔄 CodeLoop Continuous Development Lifecycle`);
      try {
        const result = await lifecycleUseCase.execute({
          mode: MODE_STANDARD,
          issue: options.issue,
          title: options.title,
          type: options.type,
          commitAfter: options.commitAfter,
          yes: options.yes,
          staged: options.staged,
          message: options.message,
          interactive: promptsAllowed,
          interactiveCommit: promptsAllowed && !options.yes,
          dryRun: options.dryRun,
          configPath: options.configPath,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined
        });

        if (result.pausedAtGate === GATE_APPROVAL) {
          if (result.planResult?.scaffoldInfo) {
            const info = result.planResult.scaffoldInfo;
            console.log(`📁 Scaffolded Plan: artifacts/plans/${info.folderName}/`);
          }
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
          console.log(`Review artifacts and run 'agyloop implement' (or 'agyloop') to continue.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.worktree) {
          console.log(`🌲 Isolated Worktree: ${result.worktree.worktreePath} (branch: ${result.worktree.branch})`);
        }

        if (result.qualityGateResult?.summaryReport) {
          console.log('\n' + result.qualityGateResult.summaryReport + '\n');
        }

        if (result.qualityGateResult && !result.qualityGateResult.passed) {
          console.error(`✗ Quality gates failed. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
          return EXIT_CODE_FAILURE;
        }

        if (result.reviewResult) {
          console.log(`AI PR Review: ${result.reviewResult.verdict.status}`);
          if (!result.reviewResult.passed) {
            console.error(`✗ AI Review requested changes. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
            return EXIT_CODE_FAILURE;
          }
        }

        if (result.executeCommitResult && result.executeCommitResult.success) {
          console.log(`\n✓ Successfully committed: \x1b[1m${result.executeCommitResult.commitHash}\x1b[0m`);
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
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'agyloop commit' to execute.\n`);
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
      const issueValue = parsedOptions?.issue ? IssueNumber.tryFrom(parsedOptions.issue)?.value : undefined;
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
        reason: `POSIX Signal ${signal}`
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

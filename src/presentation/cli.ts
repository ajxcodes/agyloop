/**
 * agyloop - CLI Presentation Controller & Dispatcher
 *
 * Formats terminal output and dispatches commands to application use cases.
 */

import * as path from 'path';
import {
  STAGES,
  StageName,
  CLI_VERSION,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  MODE_YOLO,
  MODE_PLAN,
  MODE_STANDARD,
  MODE_IMPLEMENT,
  MODE_GATES,
  MODE_COMMIT,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  DEFAULT_PROMPTS_DIR,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  COMMAND_WORKTREE,
  COMMAND_RELEASE,
  COMMAND_CRITIQUE,
  FLAG_WORKTREE,
  FLAG_NO_WORKTREE,
  FLAG_FORCE,
  FLAG_FORCE_SHORT,
  REGEX_POSITIONAL_ISSUE_ID,
  PreFlightHaltError,
  MilestoneReleaseError,
  MilestoneSealedError,
  StateMachine
} from '../domain';
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
  GitWorktreeManager
} from '../infrastructure';
import {
  RunLifecycleUseCase,
  StartPlanningUseCase,
  TransitionStageUseCase,
  GetPipelineStatusUseCase,
  ResetPipelineUseCase,
  ListModelsUseCase,
  ResolveSubagentUseCase,
  StartImplementationUseCase,
  RunQualityGateUseCase,
  RunReviewUseCase,
  ManageCritiqueUseCase,
  DraftCommitUseCase,
  ExecuteCommitUseCase,
  ManageWorktreeUseCase,
  MilestoneReleaseUseCase,
  InferBaseBranchUseCase,
  GetNextActionUseCase
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
  critiqueSubcommand: string | null;
  force: boolean;
}

export interface ParsedCliArgs {
  command: string | null;
  options: CliOptions;
}

export function printHelp(): void {
  console.log(`
agyloop v${CLI_VERSION} - Antigravity Development Lifecycle Orchestrator

Usage:
  agyloop [command] [options]

Operational Modes:
  (default)          Run continuous lifecycle (Discovery -> Plan -> [Approval] -> Implement -> Gates -> Review -> [Commit])
  yolo               Unattended fast-path (auto-approves plan gate, streams straight through gates and review)
  plan               Plan-only mode; generates persistent plan in artifacts/plans/ and halts at [APPROVAL] gate
  implement          Resume implementation directly from approved plan specification
  gates              Run standalone quality gates and AI PR review on working diff
  commit             Draft Conventional Commit and prompt for interactive human approval
  release [branch]   Generate Milestone Release PR from phase collector to main with SemVer label

Pipeline Management:
  next               Inspect state and generate next invoke_subagent command/payload
  branch-info        Display base collector branch, active task branch, and PR target
  status             Display current pipeline stage and checkpoint history
  config             Display active configuration and model routing table
  models             List available Gemini models and mapped Antigravity tiers
  prompt [role]      Inspect subagent definition, whitelist, and system prompt (planner|implementer|gate|reviewer)
  reset              Reset .agyloop/state.json checkpoint
  transition <STAGE> Advance state machine to target stage
  worktree [cmd]     Manage isolated git worktrees (list | clean | prune | remove <id>)
  critique [cmd]     Manage Critique CLI installation (status | install | update)

Operational Flags:
      --yolo         Enable unattended fast-path (equivalent to 'yolo' command)
      --commit-after Automatically draft and commit changes if quality gates and AI review pass
  -y, --yes          Skip interactive confirmation prompt (auto-approve commit)
  -m, --message <msg> Explicit conventional commit message override
  -s, --staged       Inspect / commit staged changes only (git diff --cached)
  -f, --force        Force operation (force fresh version check or reinstallation)
      --issue <num>  Associate execution with GitHub issue number
      --title <text> Specify plan title for persistent artifact scaffolding
      --type <type>  Specify plan type (discovery | implementation | auto)
      --config <path> Path to custom configuration file (.agyloop.json)
      --worktree     Enable git worktree isolation for task execution (default: true)
      --no-worktree  Disable worktree isolation and execute directly in root workspace
      --keep-worktree Keep git worktree after commit completion (prevent auto-teardown)
      --json         Output machine-readable JSON for scripting and piping
      --base-branch <branch> Override base branch for worktree or milestone release
      --refresh      Force refresh of discovered Gemini models or milestone release PR
      --dry-run      Simulate execution without modifying state or files on disk
  -h, --help         Show this help message and exit
  -v, --version      Show version information and exit

Examples:
  agyloop                               Standard continuous loop (stops at [APPROVAL] and [COMMIT] gates)
  agyloop plan --issue 32               Generate persistent plan for issue #32 and stop at [APPROVAL] gate
  agyloop implement                    Resume implementation from approved plan in artifacts/plans/
  agyloop gates                         Run quality gates and AI PR review on working diff
  agyloop gates --commit-after          Run gates and review, auto-committing if all pass
  agyloop commit                        Draft Conventional Commit and prompt for human approval
  agyloop commit -y                     Draft Conventional Commit and commit immediately
  agyloop critique status               Inspect critique resolution, installed version, and update status
  agyloop critique install              Install latest critique CLI into user data directory
  agyloop critique update               Update critique CLI to latest release
  agyloop release phase/1-bridge-arch   Generate milestone release PR to main with SemVer label
  agyloop release --dry-run             Preview calculated SemVer bump and compiled changelog
  agyloop yolo                          Unattended fast-path (auto-approves plan gate, runs gates and review)
  agyloop yolo --commit-after           100% end-to-end hands-off loop: plan -> implement -> gates -> review -> commit
  agyloop --yolo --commit-after         Equivalent hands-off execution using flag syntax
  agyloop worktree list                 List all active isolated git worktrees
  agyloop worktree prune                Prune dangling worktrees and lock metadata
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
    critiqueSubcommand: null,
    force: false
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
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
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
    COMPLETED: '\x1b[32m\x1b[1m' // Bold Green
  };
  const reset = '\x1b[0m';
  const color = colors[stage] || '';
  return `${color}[${stage}]${reset}`;
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

  const stateRepo = new FileStateRepository();
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
  const confirmationPrompt = new ReadlineConfirmationPrompt();
  const worktreeManager = new GitWorktreeManager(commandExecutor);

  const config = configRepo.loadConfig({ customPath: options.configPath });

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

  switch (effectiveCommand) {
    case 'next': {
      const getNextActionUseCase = new GetNextActionUseCase(
        stateRepo,
        configRepo,
        planGenerator,
        githubGateway
      );
      const res = await getNextActionUseCase.execute({
        configPath: options.configPath
      });

      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
        return EXIT_CODE_SUCCESS;
      }

      console.log('\n=== AgyLoop: Next Subagent Directive ===');
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

      let baseBranch = snapshot?.baseBranch || null;
      if (!baseBranch && snapshot?.issue) {
        try {
          const infer = new InferBaseBranchUseCase(worktreeManager, githubGateway, stateRepo);
          const res = await infer.execute({ issueNumber: snapshot.issue });
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

      console.log('\n=== AgyLoop: Branch Lifecycle & Target Diagnostics ===');
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
      console.log('\n=== AgyLoop: Pipeline Status ===');
      console.log(`Current Stage : ${formatStageBadge(result.status.currentStage)}`);
      console.log(`Execution Mode: ${result.status.mode}`);
      console.log(`Active Issue  : ${result.status.issue ? '#' + result.status.issue : 'None'}`);
      console.log(`Updated At    : ${result.status.updatedAt}`);
      console.log(`Checkpoint    : ${result.stateFilePath}`);

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
      console.log('\n=== AgyLoop: Configuration & Model Routing ===');
      const roles = ['planner', 'implementer', 'gate', 'reviewer'];
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
      console.log('\n=== AgyLoop: Discovering Available Gemini Models ===');
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
      await resetUseCase.execute();
      console.log('✓ AgyLoop pipeline state reset. .agyloop/state.json cleared.');
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
        const res = await manageWorktreeUseCase.list();
        const list = res.data || [];
        console.log('\n=== AgyLoop: Active Isolated Git Worktrees ===');
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
        const res = await manageWorktreeUseCase.clean();
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

          console.log('\n=== AgyLoop: Critique CLI Status ===');
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

    case 'prompt': {
      const role = options.roleArg || ROLE_PLANNER;
      if (role !== ROLE_PLANNER && role !== ROLE_IMPLEMENTER && role !== ROLE_GATE && role !== ROLE_REVIEWER) {
        console.error(`Valid prompt roles: '${ROLE_PLANNER}', '${ROLE_IMPLEMENTER}', '${ROLE_GATE}', '${ROLE_REVIEWER}'. Received: '${role}'.`);
        return EXIT_CODE_FAILURE;
      }

      const resolveSubagentUseCase = new ResolveSubagentUseCase(
        configRepo,
        githubGateway,
        promptRepo
      );
      const def = resolveSubagentUseCase.execute({ role, customConfig: config });
      console.log('\n=== AgyLoop: Subagent Definition ===');
      console.log(`Subagent Name : ${def.name}`);
      console.log(`Subagent Role : ${def.role}`);
      console.log(`Resolved Tier : ${def.model} (API default: ${def.apiModel})`);
      console.log(`Write Tools   : ${def.capabilities.enable_write_tools ? 'ENABLED' : 'DISABLED (Read-Only)'}`);
      console.log(`Tool Whitelist: ${def.tools.join(', ')}`);
      console.log(
        `Capabilities  : write_tools=${def.capabilities.enable_write_tools}, mcp_tools=${def.capabilities.enable_mcp_tools}`
      );
      console.log(`\n=== AgyLoop: System Prompt (${DEFAULT_PROMPTS_DIR}/${role}.md) ===\n`);
      console.log(def.system_prompt);
      console.log('');
      return EXIT_CODE_SUCCESS;
    }

    case 'release': {
      console.log('\n🚀 AgyLoop: Milestone Release PR Orchestrator');
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
      console.log(`\n🚀 Starting AgyLoop [PLAN-ONLY] Mode`);
      try {
        const result = await lifecycleUseCase.execute({
          mode: MODE_PLAN,
          issue: options.issue,
          title: options.title,
          type: options.type,
          dryRun: options.dryRun,
          configPath: options.configPath
        });

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
            `Safety Guard : Physical write suppression enabled (write_tools=false, mcp_tools=${p.capabilities.enable_mcp_tools})\n`
          );
        }

        console.log(`🛑 Paused at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
        console.log(`Review artifacts in artifacts/plans/ and run 'agyloop implement' to continue.\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 AgyLoop Pre-Flight Check: ${err.message}\n`);
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
      console.log(`\n🚀 Resuming AgyLoop Implementation`);
      try {
        const result = await lifecycleUseCase.execute({
          mode: MODE_IMPLEMENT,
          issue: options.issue,
          configPath: options.configPath,
          dryRun: options.dryRun,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined
        });

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
        console.log(`Next Step    : Execute checklist items and run 'agyloop gates' when complete.\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 AgyLoop Pre-Flight Check: ${err.message}\n`);
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

    case 'gates': {
      console.log(`\n🧪 Executing AgyLoop Quality Gates & AI PR Review`);
      try {
        const result = await lifecycleUseCase.execute({
          mode: MODE_GATES,
          issue: options.issue,
          commitAfter: options.commitAfter,
          staged: options.staged,
          message: options.message,
          configPath: options.configPath,
          dryRun: options.dryRun,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined
        });

        if (options.dryRun) {
          console.log(`\n[DRY RUN] ${result.message || 'Simulated gates execution completed.'}\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.qualityGateResult?.summaryReport) {
          console.log('\n' + result.qualityGateResult.summaryReport + '\n');
        }

        if (result.qualityGateResult && !result.qualityGateResult.passed) {
          console.error(`✗ Quality gates failed. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
          console.error(`Resolve failures and re-run 'agyloop gates'.\n`);
          return EXIT_CODE_FAILURE;
        }

        console.log(`✓ Quality gates passed.`);

        if (result.reviewResult) {
          console.log(`\n=== AgyLoop: AI PR Review ===`);
          console.log(`Verdict: ${result.reviewResult.verdict.status}`);
          console.log(`Summary: ${result.reviewResult.verdict.summary}\n`);

          if (!result.reviewResult.passed) {
            console.error(`✗ AI Review requested changes. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
            if (result.reviewResult.verdict.unfulfilledCriteria.length > 0) {
              console.error('Unfulfilled Criteria:');
              result.reviewResult.verdict.unfulfilledCriteria.forEach((c) => console.error(`  - ${c}`));
            }
            if (result.reviewResult.verdict.remediationGuidance.length > 0) {
              console.error('Remediation Guidance:');
              result.reviewResult.verdict.remediationGuidance.forEach((r) => console.error(`  - ${r}`));
            }
            console.error(`\nResolve review findings and re-run 'agyloop gates'.\n`);
            return EXIT_CODE_FAILURE;
          }

          console.log(`✓ AI Review approved. Pipeline advanced to ${formatStageBadge(result.currentStage)}.`);
        }

        if (result.executeCommitResult && result.executeCommitResult.success) {
          console.log(`\n✓ Successfully committed via --commit-after: \x1b[1m${result.executeCommitResult.commitHash}\x1b[0m`);
          console.log(`✓ Pipeline advanced to ${formatStageBadge(result.currentStage)}.\n`);
        } else if (result.currentStage === STAGE_COMMIT) {
          console.log(`Next Step: Run 'agyloop commit' to draft and approve conventional commit.\n`);
        }

        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 AgyLoop Pre-Flight Check: ${err.message}\n`);
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
      console.log(`\n📦 AgyLoop: Semantic Conventional Commit Gate`);
      try {
        const snapshot = await stateRepo.load();
        const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : null;
        const rootWorkspaceDir = options.workspaceDir || process.cwd();
        const effectiveWorkspaceDir = sm?.worktree?.worktreePath || rootWorkspaceDir;

        const draftCommitUseCase = new DraftCommitUseCase(
          stateRepo,
          commandExecutor,
          githubGateway,
          planGenerator
        );

        const draftResult = await draftCommitUseCase.execute({
          issue: options.issue,
          staged: options.staged,
          userMessage: options.message,
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

        if (!options.yes && !process.stdin.isTTY) {
          console.error(`\nError: Interactive confirmation required. Pass -y/--yes in non-interactive environments.\n`);
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
          confirmed: options.yes,
          bypassConfirmation: options.yes,
          staged: options.staged,
          dryRun: options.dryRun,
          issue: options.issue,
          keepWorktree: options.keepWorktree,
          workspaceDir: effectiveWorkspaceDir,
          rootWorkspaceDir: rootWorkspaceDir
        });

        if (execResult.confirmed && execResult.success) {
          console.log(`\n✓ Successfully committed: \x1b[1m${execResult.commitHash}\x1b[0m`);
          console.log(`✓ Pipeline advanced to ${formatStageBadge(execResult.currentStage)}.`);
          if (execResult.worktreeTornDown) {
            console.log(`✓ Isolated git worktree torn down and pruned.`);
          }
          if (execResult.prCommand) {
            console.log(`\nNext Step (Create PR):\n  ${execResult.prCommand}`);
          }
          if (execResult.summaryUpdated) {
            console.log(`✓ AgyLoop Summary.md updated with commit hash and timestamp.\n`);
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

    case 'yolo': {
      console.log(`\n⚡ Starting AgyLoop [YOLO] Fast-Path Mode`);
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
          baseBranch: options.baseBranch || undefined
        });

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
          console.log(`✓ Pipeline Stage: ${formatStageBadge(result.currentStage)}\n`);
        } else {
          console.log(`\n✓ Quality gates and AI review passed in YOLO mode.`);
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'agyloop commit' or re-run with '--commit-after'.\n`);
        }

        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 AgyLoop Pre-Flight Check: ${err.message}\n`);
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

    default: {
      if (command !== null) {
        console.error(`Error: Unknown command "${command}". Run "agyloop --help" for available commands.\n`);
        return EXIT_CODE_FAILURE;
      }

      // Default execution: Continuous Lifecycle Orchestration
      console.log(`\n🔄 AgyLoop Continuous Development Lifecycle`);
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
          interactiveCommit: true,
          dryRun: options.dryRun,
          configPath: options.configPath,
          worktree: options.noWorktree ? false : true,
          baseBranch: options.baseBranch || undefined
        });

        if (result.pausedAtGate === 'APPROVAL') {
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
          console.log(`✓ Pipeline advanced to ${formatStageBadge(result.currentStage)}.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.pausedAtGate === 'COMMIT') {
          console.log(`🛑 Paused at ${formatStageBadge(STAGE_COMMIT)} gate. Run 'agyloop commit' to execute.\n`);
          return EXIT_CODE_SUCCESS;
        }

        if (result.currentStage === STAGE_COMPLETED) {
          console.log(`✓ Pipeline is in ${formatStageBadge(STAGE_COMPLETED)} stage.\n`);
          return EXIT_CODE_SUCCESS;
        }

        console.log(`Pipeline at stage: ${formatStageBadge(result.currentStage)}\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        if (err instanceof PreFlightHaltError) {
          console.log(`\n🛑 AgyLoop Pre-Flight Check: ${err.message}\n`);
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
  try {
    const code = await runCli(process.argv.slice(2));
    if (code !== 0) {
      process.exit(code);
    }
  } catch (err: unknown) {
    console.error('Fatal:', err);
    process.exit(EXIT_CODE_FAILURE);
  }
}

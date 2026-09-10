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
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  MODE_YOLO,
  MODE_PLAN,
  MODE_STANDARD,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  DEFAULT_PROMPTS_DIR,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE
} from '../domain';
import {
  FileStateRepository,
  CliGitHubGateway,
  FileConfigRepository,
  GeminiModelCatalog,
  FilePlanGenerator,
  FilePromptRepository,
  ProcessCommandExecutor
} from '../infrastructure';
import {
  StartPlanningUseCase,
  TransitionStageUseCase,
  GetPipelineStatusUseCase,
  ResetPipelineUseCase,
  ListModelsUseCase,
  ResolveSubagentUseCase,
  StartImplementationUseCase,
  RunQualityGateUseCase
} from '../application';


export interface CliOptions {
  commitAfter: boolean;
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

Commands:
  (default)          Run full lifecycle (Context -> Plan -> Approve -> Implement -> Gate -> Review -> Commit)
  plan               Run planning subagent and stop at approval gate
  implement          Resume implementation directly from approved plan
  gates              Run quality and AI review gates on current working diff
  yolo               Unattended fast-path mode (auto-approves plan gate)
  status             Display current pipeline stage and checkpoint history
  config             Display active configuration and model routing table
  models             List available Gemini models and mapped Antigravity tiers
  prompt [role]      Inspect subagent definition, whitelist, and system prompt
  reset              Reset .agyloop/state.json checkpoint
  transition <STAGE> Advance state machine to target stage

Options:
  --commit-after     Opt-in flag to automatically commit if all gates pass
  --issue <number>   Specify GitHub issue number
  --title <text>     Specify plan title (for scaffolding)
  --type <type>      Specify plan type (discovery | implementation)
  --config <path>    Path to custom configuration file
  --refresh          Force refresh of discovered Gemini models from API
  --dry-run          Simulate execution without modifying state on disk
  -h, --help         Show help
  -v, --version      Show version
`);
}

export function parseArguments(args: readonly string[]): ParsedCliArgs {
  let command: string | null = null;
  const options: CliOptions = {
    commitAfter: false,
    dryRun: false,
    issue: null,
    title: null,
    type: null,
    configPath: null,
    refresh: false,
    help: false,
    version: false,
    stageArg: null,
    roleArg: null
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
    command = positional[0];
    if (command === 'transition' && positional.length > 1) {
      options.stageArg = positional[1].toUpperCase();
    } else if (command === 'prompt' && positional.length > 1) {
      options.roleArg = positional[1].toLowerCase();
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

  const config = configRepo.loadConfig({ customPath: options.configPath });


  switch (command) {
    case 'status': {
      const getStatusUseCase = new GetPipelineStatusUseCase(stateRepo);
      const result = await getStatusUseCase.execute();
      console.log('\n=== AgyLoop: Pipeline Status ===');
      console.log(`Current Stage : ${formatStageBadge(result.status.currentStage)}`);
      console.log(`Execution Mode: ${result.status.mode}`);
      console.log(`Active Issue  : ${result.status.issue ? '#' + result.status.issue : 'None'}`);
      console.log(`Updated At    : ${result.status.updatedAt}`);
      console.log(`Checkpoint    : ${result.stateFilePath}`);
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
        const transitionUseCase = new TransitionStageUseCase(stateRepo);
        await transitionUseCase.execute({
          targetStage: options.stageArg as StageName,
          metadata: { note: 'Manual CLI transition' }
        });
        console.log(`✓ Transitioned to ${formatStageBadge(options.stageArg)}`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'prompt': {
      const role = options.roleArg || ROLE_PLANNER;
      if (role !== ROLE_PLANNER && role !== ROLE_IMPLEMENTER && role !== ROLE_GATE) {
        console.error(`Currently, detailed prompts are defined for '${ROLE_PLANNER}', '${ROLE_IMPLEMENTER}', and '${ROLE_GATE}'. Received: '${role}'.`);
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

    case 'plan': {
      console.log(`\n🚀 Starting AgyLoop [PLAN-ONLY] Mode`);
      const startPlanningUseCase = new StartPlanningUseCase(
        stateRepo,
        githubGateway,
        configRepo,
        planGenerator
      );

      const result = await startPlanningUseCase.execute({
        issue: options.issue,
        title: options.title,
        type: options.type,
        dryRun: options.dryRun,
        configPath: options.configPath
      });

      if (options.dryRun) {
        console.log(
          `\n[DRY RUN] Would scaffold artifacts/plans/ for: "${result.planTitle}" (type: ${result.planType})`
        );
      } else if (result.scaffoldInfo) {
        console.log(`\n📁 Initialized plan directory: artifacts/plans/${result.scaffoldInfo.folderName}/`);
        console.log(`  ✓ Specification (${result.scaffoldInfo.type}): ${path.basename(result.scaffoldInfo.planPath)}`);
        if (result.scaffoldInfo.mirrorPath) {
          console.log(`  ✓ Canonical Mirror  : ${path.basename(result.scaffoldInfo.mirrorPath)}`);
        }
        console.log(`  ✓ Execution Log     : ${path.basename(result.scaffoldInfo.summaryPath)}`);
      }

      console.log(`\nSubagent     : ${result.plannerDef.name} (${result.plannerDef.role})`);
      console.log(`Model Tier   : ${result.plannerDef.model}`);
      console.log(`Whitelisted  : ${result.plannerDef.tools.join(', ')}`);
      console.log(
        `Safety Guard : Physical write suppression enabled (write_tools=false, mcp_tools=${result.plannerDef.capabilities.enable_mcp_tools})\n`
      );

      console.log(`🛑 Paused at ${formatStageBadge(STAGE_APPROVAL)} gate.`);
      console.log(`Review artifacts in artifacts/plans/ and run 'agyloop implement' to continue.\n`);
      return EXIT_CODE_SUCCESS;
    }

    case 'implement': {
      console.log(`\n🚀 Resuming AgyLoop Implementation`);
      try {
        const resolveSubagentUseCase = new ResolveSubagentUseCase(
          configRepo,
          githubGateway,
          promptRepo
        );
        const startImplementationUseCase = new StartImplementationUseCase(
          stateRepo,
          configRepo,
          planGenerator,
          githubGateway,
          resolveSubagentUseCase
        );

        const result = await startImplementationUseCase.execute({
          issue: options.issue,
          configPath: options.configPath,
          dryRun: options.dryRun
        });

        if (result.resumed) {
          console.log(`Already at ${formatStageBadge(STAGE_IMPLEMENT)}. Resuming code modifications.\n`);
        } else {
          console.log(`✓ Advanced to ${formatStageBadge(STAGE_IMPLEMENT)}. Ready for code modifications.\n`);
        }

        if (result.planPath) {
          console.log(`📁 Loaded Approved Plan: ${result.planPath}`);
        }
        console.log(`Subagent     : ${result.implementerDef.name} (${result.implementerDef.role})`);
        console.log(`Model Tier   : ${result.implementerDef.model}`);
        console.log(`Write Tools  : ENABLED (write_to_file, replace_file_content, run_command)`);
        console.log(`Whitelisted  : ${result.implementerDef.tools.join(', ')}\n`);
        console.log(`Next Step    : Execute checklist items and run 'agyloop gates' when complete.\n`);
        return EXIT_CODE_SUCCESS;
      } catch (err: unknown) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }

    case 'gates': {
      console.log(`\n🧪 Executing AgyLoop Quality Gates`);
      try {
        const resolveSubagentUseCase = new ResolveSubagentUseCase(
          configRepo,
          githubGateway,
          promptRepo
        );
        const runQualityGateUseCase = new RunQualityGateUseCase(
          stateRepo,
          configRepo,
          planGenerator,
          commandExecutor,
          resolveSubagentUseCase
        );

        const result = await runQualityGateUseCase.execute({
          issue: options.issue,
          configPath: options.configPath,
          dryRun: options.dryRun
        });

        console.log('\n' + result.summaryReport + '\n');

        if (result.passed) {
          console.log(`✓ Quality gates passed. Pipeline advanced to ${formatStageBadge(result.currentStage)}.`);
          console.log(`Next Step: Run AI PR review before committing and creating PR.\n`);
          return EXIT_CODE_SUCCESS;
        } else {
          console.error(`✗ Quality gates failed. Pipeline reverted to ${formatStageBadge(result.currentStage)}.`);
          console.error(`Resolve failures and re-run 'agyloop gates'.\n`);
          return EXIT_CODE_FAILURE;
        }
      } catch (err: unknown) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        return EXIT_CODE_FAILURE;
      }
    }


    case 'yolo': {
      console.log(`\n⚡ Starting AgyLoop [YOLO] Mode (Auto-Approval Gate)`);
      const transitionUseCase = new TransitionStageUseCase(stateRepo);
      let sm = await transitionUseCase.execute({
        targetStage: STAGE_DISCOVERY,
        mode: MODE_YOLO
      });
      sm = await transitionUseCase.execute({
        targetStage: STAGE_PLAN,
        mode: MODE_YOLO
      });
      sm = await transitionUseCase.execute({
        targetStage: STAGE_IMPLEMENT,
        mode: MODE_YOLO,
        metadata: { note: 'Auto-approved in YOLO mode' }
      });
      console.log(`Active Stage: ${formatStageBadge(sm.currentStage)}`);
      return EXIT_CODE_SUCCESS;
    }

    default: {
      const getStatusUseCase = new GetPipelineStatusUseCase(stateRepo);
      const result = await getStatusUseCase.execute();
      console.log(`\n🔄 AgyLoop Development Lifecycle Coordinator`);
      console.log(`Current Stage: ${formatStageBadge(result.status.currentStage)}`);
      console.log(`To inspect configuration: agyloop config`);
      console.log(`To discover models:       agyloop models`);
      console.log(`To view pipeline status:  agyloop status`);
      console.log(`To run planning mode:     agyloop plan`);
      console.log(`To run quality gates:     agyloop gates`);
      console.log(`To see all options:       agyloop --help\n`);
      return EXIT_CODE_SUCCESS;
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

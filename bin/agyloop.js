#!/usr/bin/env node

/**
 * agyloop - Multi-Subagent Development Lifecycle Orchestrator CLI
 *
 * Usage:
 *   agyloop [command] [options]
 *
 * Commands:
 *   (default)      Execute complete pair-programming loop
 *   plan           Run planning stage and stop at human approval gate
 *   implement      Resume execution from approved plan
 *   gates          Run quality and AI review gates on current diff
 *   yolo           Execute unattended fast-path mode
 *   status         Inspect active stage and checkpoint history
 *   config         Display active configuration and model routing table
 *   models         Discover and list available Gemini models & tier mappings
 *   reset          Reset pipeline checkpoint state
 *   transition <s> Advance state to specified target stage
 *
 * Options:
 *   --commit-after Automatically commit if all quality gates pass
 *   --issue <num>  Associate execution with an issue number
 *   --config <p>   Path to custom configuration JSON
 *   --refresh      Force refresh of cached Gemini models
 *   --dry-run      Simulate transitions without writing to disk
 *   -h, --help     Show this help message
 *   -v, --version  Show version
 */

const path = require('path');
const { StateMachine, STAGES } = require('../lib/state-machine');
const {
  loadConfig,
  resolveModel,
  fetchAvailableModels,
  DEFAULT_CONFIG
} = require('../lib/config');
const {
  getPlannerDefinition,
  getPlannerSystemPrompt,
  buildPlanningTaskPrompt,
  READ_ONLY_TOOLS
} = require('../lib/planner');
const {
  fetchIssueContext,
  formatIssueForPrompt,
  getCurrentRepo
} = require('../lib/github');

const VERSION = '0.1.0';

function printHelp() {
  console.log(`
agyloop v${VERSION} - Antigravity Development Lifecycle Orchestrator

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
  --config <path>    Path to custom configuration file
  --refresh          Force refresh of discovered Gemini models from API
  --dry-run          Simulate execution without modifying state on disk
  -h, --help         Show help
  -v, --version      Show version
`);
}

function parseArguments(args) {
  let command = null;
  const options = {
    commitAfter: false,
    dryRun: false,
    issue: null,
    configPath: null,
    refresh: false,
    help: false,
    version: false,
    stageArg: null,
    roleArg: null
  };

  const positional = [];

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
      options.issue = args[++i];
    } else if (arg.startsWith('--issue=')) {
      options.issue = arg.split('=')[1];
    } else if (arg === '--config') {
      options.configPath = args[++i];
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.split('=')[1];
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

function formatStageBadge(stage) {
  const colors = {
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

async function main() {
  const rawArgs = process.argv.slice(2);
  const { command, options } = parseArguments(rawArgs);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.version) {
    console.log(`agyloop v${VERSION}`);
    process.exit(0);
  }

  const config = loadConfig({
    customPath: options.configPath
  });

  const mode = command === 'yolo' ? 'yolo' : command === 'plan' ? 'plan' : 'standard';
  const sm = new StateMachine({
    mode,
    issue: options.issue
  });

  switch (command) {
    case 'status': {
      const status = sm.getStatus();
      console.log('\n=== AgyLoop: Pipeline Status ===');
      console.log(`Current Stage : ${formatStageBadge(status.currentStage)}`);
      console.log(`Execution Mode: ${status.mode}`);
      console.log(`Active Issue  : ${status.issue ? '#' + status.issue : 'None'}`);
      console.log(`Updated At    : ${status.updatedAt}`);
      console.log(`Checkpoint    : ${status.stateFile}`);
      console.log('\nTransition History:');
      sm.state.history.forEach((entry, idx) => {
        console.log(`  ${idx + 1}. ${formatStageBadge(entry.stage)} at ${entry.timestamp}`);
      });
      console.log('');
      break;
    }

    case 'config': {
      console.log('\n=== AgyLoop: Configuration & Model Routing ===');
      const roles = ['planner', 'implementer', 'gate', 'reviewer'];
      console.log('\nSubagent Model Routing Table:');
      console.log('----------------------------------------------------------------------');
      console.log('Role         Configured           AGY Subagent Tier   Canonical API Model');
      console.log('----------------------------------------------------------------------');
      for (const role of roles) {
        const resolved = resolveModel(role, config);
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
      break;
    }

    case 'models': {
      console.log('\n=== AgyLoop: Discovering Available Gemini Models ===');
      const models = await fetchAvailableModels({
        forceRefresh: options.refresh
      });
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
      break;
    }

    case 'reset': {
      sm.reset(true);
      console.log('✓ AgyLoop pipeline state reset. .agyloop/state.json cleared.');
      break;
    }

    case 'transition': {
      if (!options.stageArg) {
        console.error('Error: Please specify target stage. Example: agyloop transition PLAN');
        console.error('Valid stages:', Object.keys(STAGES).join(', '));
        process.exit(1);
      }
      try {
        sm.transition(options.stageArg, { note: 'Manual CLI transition' });
        console.log(`✓ Transitioned to ${formatStageBadge(options.stageArg)}`);
      } catch (err) {
        console.error(`✗ ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'prompt': {
      const role = options.roleArg || 'planner';
      if (role !== 'planner') {
        console.error(`Currently, detailed prompts are defined for 'planner'. Received: '${role}'.`);
        process.exit(1);
      }
      const def = getPlannerDefinition(config);
      console.log('\n=== AgyLoop: Subagent Definition ===');
      console.log(`Subagent Name : ${def.name}`);
      console.log(`Subagent Role : ${def.role}`);
      console.log(`Resolved Tier : ${def.model} (API default: ${def.apiModel})`);
      console.log(`Read-Only     : true`);
      console.log(`Tool Whitelist: ${def.tools.join(', ')}`);
      console.log(`Capabilities  : write_tools=${def.capabilities.enable_write_tools}, mcp_tools=${def.capabilities.enable_mcp_tools}`);
      console.log('\n=== AgyLoop: System Prompt (prompts/planner.md) ===\n');
      console.log(def.system_prompt);
      console.log('');
      break;
    }

    case 'plan': {
      console.log(`\n🚀 Starting AgyLoop [PLAN-ONLY] Mode`);
      console.log(`Current Stage: ${formatStageBadge(sm.state.currentStage)}`);

      const activeIssue = options.issue || sm.state.issue;
      if (activeIssue) {
        console.log(`Querying GitHub context for Issue #${activeIssue}...`);
        const issueData = fetchIssueContext(activeIssue);
        if (issueData && !issueData.error) {
          console.log(`  ✓ Issue: ${issueData.title}`);
          if (issueData.labels && issueData.labels.length > 0) {
            console.log(`  ✓ Labels: ${issueData.labels.join(', ')}`);
          }
        } else if (issueData && issueData.error) {
          console.log(`  ! Warning: Could not fetch GitHub issue (${issueData.error})`);
        }
      }

      const plannerDef = getPlannerDefinition(config);
      console.log(`Subagent     : ${plannerDef.name} (${plannerDef.role})`);
      console.log(`Model Tier   : ${plannerDef.model}`);
      console.log(`Whitelisted  : ${plannerDef.tools.join(', ')}`);
      console.log(`Safety Guard : Physical write suppression enabled (write_tools=false, mcp_tools=${plannerDef.capabilities.enable_mcp_tools})\n`);

      if (sm.state.currentStage === STAGES.INITIALIZED) {
        sm.transition(STAGES.DISCOVERY, { note: 'Initiated planning mode' });
      }
      if (sm.state.currentStage === STAGES.DISCOVERY) {
        sm.transition(STAGES.PLAN, { note: 'Generating plan specifications' });
      }
      if (sm.state.currentStage === STAGES.PLAN) {
        sm.transition(STAGES.APPROVAL, { note: 'Awaiting human review' });
      }
      console.log(`🛑 Paused at ${formatStageBadge(STAGES.APPROVAL)} gate.`);
      console.log(`Review artifacts in artifacts/plans/ and run 'agyloop implement' to continue.\n`);
      break;
    }

    case 'implement': {
      console.log(`\n🚀 Resuming AgyLoop Implementation`);
      if (sm.state.currentStage === STAGES.APPROVAL) {
        sm.transition(STAGES.IMPLEMENT, { note: 'Approved by developer' });
        console.log(`✓ Advanced to ${formatStageBadge(STAGES.IMPLEMENT)}. Ready for code modifications.\n`);
      } else if (sm.state.currentStage === STAGES.IMPLEMENT) {
        console.log(`Already at ${formatStageBadge(STAGES.IMPLEMENT)}. Continuing code generation.\n`);
      } else {
        console.error(`✗ Cannot resume into IMPLEMENT from ${formatStageBadge(sm.state.currentStage)}.`);
        console.error(`Run 'agyloop plan' first or verify your .agyloop/state.json checkpoint.`);
        process.exit(1);
      }
      break;
    }

    case 'gates': {
      console.log(`\n🧪 Executing AgyLoop Quality & Review Gates`);
      if (sm.canTransition(STAGES.QUALITY_GATE)) {
        sm.transition(STAGES.QUALITY_GATE, { note: 'Manual gates run' });
      }
      console.log(`Active Stage: ${formatStageBadge(sm.state.currentStage)}`);
      console.log(`Run tests, linters, and ai-reviewer diagnostics.\n`);
      break;
    }

    case 'yolo': {
      console.log(`\n⚡ Starting AgyLoop [YOLO] Mode (Auto-Approval Gate)`);
      if (sm.state.currentStage === STAGES.INITIALIZED) {
        sm.transition(STAGES.DISCOVERY);
        sm.transition(STAGES.PLAN);
        sm.transition(STAGES.IMPLEMENT, { note: 'Auto-approved in YOLO mode' });
      }
      console.log(`Active Stage: ${formatStageBadge(sm.state.currentStage)}`);
      break;
    }

    default: {
      console.log(`\n🔄 AgyLoop Development Lifecycle Coordinator`);
      console.log(`Current Stage: ${formatStageBadge(sm.state.currentStage)}`);
      console.log(`To inspect configuration: agyloop config`);
      console.log(`To discover models:       agyloop models`);
      console.log(`To view pipeline status:  agyloop status`);
      console.log(`To run planning mode:     agyloop plan`);
      console.log(`To run quality gates:     agyloop gates`);
      console.log(`To see all options:       agyloop --help\n`);
      break;
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, parseArguments };

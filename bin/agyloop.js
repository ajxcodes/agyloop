#!/usr/bin/env node

/**
 * agyloop - Multi-Subagent Development Lifecycle Orchestrator CLI
 *
 * Thin launcher delegating directly to the compiled presentation dispatcher.
 */

const { main, parseArguments, runCli } = require('../dist/presentation/cli');

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, parseArguments, runCli };

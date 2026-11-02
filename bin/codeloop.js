#!/usr/bin/env node

/**
 * codeloop - Multi-Subagent Development Lifecycle Orchestrator CLI
 *
 * Thin launcher delegating directly to the compiled presentation dispatcher.
 */
const path = require('path');
const { NOTICE_STALE_DIST, checkStaleDist, evaluateStaleDist } = require('./stale-dist');

const baseDir = path.join(__dirname, '..');

// Issue #466: a stale build on the release path is a REFUSAL, decided BEFORE
// `dist/` is required — the compiled CLI is exactly what must not run.
const staleDist = evaluateStaleDist(process.argv.slice(2), baseDir, {
  isMain: require.main === module
});

if (staleDist.refuse) {
  // 1 === EXIT_CODE_FAILURE (domain). That constant lives in dist/, and
  // importing it here would load the stale build this guard exists to stop.
  console.error(staleDist.message);
  process.exit(1);
}

// Read-only commands and --help/--version keep the notice (AC3).
if (staleDist.stale) {
  console.warn(NOTICE_STALE_DIST);
}

const { main, parseArguments, runCli } = require('../dist/presentation/cli');

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, parseArguments, runCli, checkStaleDist };

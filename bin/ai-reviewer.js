#!/usr/bin/env node

/**
 * agyloop - Independent AI PR Reviewer CLI
 *
 * Self-contained zero-dependency launcher delegating directly to the compiled
 * presentation dispatcher.
 */

const { runAiReviewerCli, parseCliArguments, printHelp } = require('../dist/presentation/ai-reviewer-cli');

if (require.main === module) {
  runAiReviewerCli(process.argv)
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      console.error('Fatal:', err);
      process.exit(1);
    });
}

module.exports = { runAiReviewerCli, parseCliArguments, printHelp };

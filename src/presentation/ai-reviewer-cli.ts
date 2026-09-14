/**
 * agyloop - AI PR Reviewer Presentation CLI
 *
 * Dispatches CLI invocations, parses command line flags, and formats review reports.
 * Supports --staged, --base, --json, and --help.
 */

import { AiReviewOptions } from '../ports/ai-reviewer';
import { runAiReviewEngine } from '../infrastructure/ai-reviewer/ai-reviewer-engine';
import { EXIT_CODE_SUCCESS } from '../domain/constants';

export interface CliArguments extends AiReviewOptions {
  readonly json?: boolean;
  readonly help?: boolean;
}

export function parseCliArguments(argv: string[]): CliArguments {
  const args = argv.slice(2);
  let staged = false;
  let baseRef: string | undefined;
  let json = false;
  let help = false;
  let timeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--staged' || arg === '-s') {
      staged = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if ((arg === '--base' || arg === '-b') && i + 1 < args.length) {
      baseRef = args[++i];
    } else if (arg === '--timeout' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        timeoutMs = parsed;
      }
    }
  }

  return {
    staged,
    baseRef,
    json,
    help,
    timeoutMs
  };
}

export function printHelp(): void {
  console.log(`
ai-reviewer - Independent AI PR Reviewer CLI (agyloop)

Usage:
  ai-reviewer [options]

Options:
  -s, --staged       Review staged changes only (git diff --cached)
  -b, --base <ref>   Review changes against a base commit/branch (git diff <ref>...HEAD)
      --json         Output review results in structured JSON format
      --timeout <ms> Request timeout in milliseconds
  -h, --help         Show this help message and exit
`);
}

export async function runAiReviewerCli(argv: string[] = process.argv): Promise<number> {
  const parsedArgs = parseCliArguments(argv);

  if (parsedArgs.help) {
    printHelp();
    return EXIT_CODE_SUCCESS;
  }

  try {
    const report = await runAiReviewEngine({
      staged: parsedArgs.staged,
      baseRef: parsedArgs.baseRef,
      timeoutMs: parsedArgs.timeoutMs
    });

    if (parsedArgs.json) {
      console.log(JSON.stringify(report.toJSON(), null, 2));
    } else {
      console.log(report.formatMarkdownReport());
    }

    return EXIT_CODE_SUCCESS;
  } catch (err) {
    console.error('ai-reviewer error:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

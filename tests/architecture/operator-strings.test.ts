/**
 * agyloop - Architecture Fitness Test: one operator vocabulary (issue #315, G1/G2)
 *
 * The deprecated `agyloop` launcher still works, but it prints a deprecation
 * warning on every invocation. Any operator-facing string that tells someone to
 * run `bin/agyloop …`, `agyloop <verb>`, `agyloop --help`, or any log line
 * prefixed `[agyloop]`, therefore instructs them to run a command the tool
 * itself discourages — the exact defect that let one run mix `bin/agyloop`
 * (preflight), `agyloop commit` (human gate) and `codeloop plan` (park hint),
 * and that still printed `Run "agyloop --help"` on the unknown-command path.
 *
 * This is a build-time tripwire, not a behaviour test: it reads every
 * TypeScript file under `src/` and refuses the deprecated token. The launcher
 * shim (`bin/agyloop.js`, outside `src/`), the deprecation warning itself and
 * the input recogniser in `quality-gate-targets.ts` are the only legitimate
 * carriers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

/**
 * The one file allowed to carry the deprecated token: `COMMAND_FIRST_TOKENS`
 * parses operator INPUT (plans written by older builds) and is never printed.
 */
const INPUT_RECOGNISER = 'src/domain/value-objects/quality-gate-targets.ts';

/**
 * Every token that turns a bare `agyloop` into a COMMAND HINT an operator could
 * copy. Prose that merely mentions the tool ("agyloop dispatches subagents") is
 * not matched, and neither is a path (`.agyloop/`, `skills/agyloop/`).
 */
const COMMAND_TOKENS = [
  '--help',
  '--version',
  '--json',
  '--dry-run',
  '--create-pr',
  '--commit-after',
  '--issue',
  'transition',
  'implement',
  'commit',
  'next',
  'plan',
  'triage',
  'resume',
  'gate-report',
  'worktree',
  'critique',
  'abort',
  'halt',
  'status',
  'review',
  'sync',
  'release',
  'init',
  'yolo',
  'branch-info',
  'models',
  'prompt',
  'reset',
  'opencode'
].join('|');

const REGEX_ANY_LAUNCHER_TOKEN = /agyloop/;

function getSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

/** `file:line` for every line matching `pattern`, so a failure names the site. */
function findMatches(
  pattern: RegExp,
  options: { readonly skipComments?: boolean; readonly exempt?: readonly string[] } = {}
): string[] {
  const exempt = new Set(options.exempt ?? []);
  const matches: string[] = [];
  for (const file of getSourceFiles(SRC_DIR)) {
    const relative = path.relative(PROJECT_ROOT, file);
    if (exempt.has(relative)) {
      continue;
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line: string, index: number) => {
      if (options.skipComments) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          return;
        }
      }
      // Fresh regex state per line: a /g pattern is stateful.
      const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      if (probe.test(line)) {
        matches.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return matches;
}

describe('operator vocabulary is codeloop-only (issue #315, Defect G)', () => {
  test('no `[agyloop]` log prefix remains in src/', () => {
    const matches = findMatches(/\[agyloop\]/);
    assert.deepStrictEqual(
      matches,
      [],
      `the deprecated log prefix must not survive in src/ — operator output says codeloop:\n${matches.join('\n')}`
    );
  });

  test('no `bin/agyloop` command token remains in src/', () => {
    const matches = findMatches(/bin\/agyloop/, { exempt: [INPUT_RECOGNISER] });
    assert.deepStrictEqual(
      matches,
      [],
      `operator-facing command names must be codeloop, never the deprecated launcher:\n${matches.join('\n')}`
    );
  });

  test('no bare `agyloop <verb>` / `agyloop --help` hint remains in src/', () => {
    // Catches the class the first two patterns missed: `Run "agyloop --help"`,
    // `run "agyloop commit"`. The lookbehind keeps paths (`.agyloop/`,
    // `skills/agyloop/`) and identifiers (`agyloop-models.json`) out of scope.
    const matches = findMatches(
      new RegExp(`(?<![\\w./-])agyloop\\s+(?:${COMMAND_TOKENS})\\b`),
      { skipComments: true, exempt: [INPUT_RECOGNISER] }
    );
    assert.deepStrictEqual(
      matches,
      [],
      `command hints must name codeloop:\n${matches.join('\n')}`
    );
  });

  test('the only `agyloop` in src/ that reaches an operator is prose, never a command', () => {
    // Guard against a future widening that silently degrades into a no-op: the
    // scan must still SEE the token it exempts and the prose it permits.
    const all = findMatches(REGEX_ANY_LAUNCHER_TOKEN);
    assert.ok(all.length > 0, 'the scan must find the token it is guarding against');
  });
});

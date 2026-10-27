/**
 * agyloop - flag vocabulary contract (#248 Wave 1)
 *
 * Source-derived, not a second hand-maintained list: the parser slice in
 * `src/presentation/cli.ts` is parsed and every `--flag` it understands must be
 * in `KNOWN_LONG_FLAGS`. A future parser branch that adds a flag without
 * registering it here reddens T-V3, which is exactly the drift this issue is
 * about.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseArguments } = require('../../dist/presentation/cli');
const {
  KNOWN_LONG_FLAGS,
  KNOWN_SHORT_FLAGS,
  KNOWN_CLI_FLAGS,
  UNIMPLEMENTED_FLAGS,
  COMMAND_CAPABILITIES,
  capabilityKey,
  validateUnknownFlags
} = require('../../dist/presentation/cli-flags');
const { CLI_DOCUMENTED_COMMANDS } = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CLI_SOURCE = path.join(PROJECT_ROOT, 'src', 'presentation', 'cli.ts');

/** The `parseArguments` body, which is where a recognised flag must appear. */
function parseArgumentsSlice(): string {
  const source = fs.readFileSync(CLI_SOURCE, 'utf8');
  const start = source.indexOf('export function parseArguments');
  assert.ok(start >= 0, 'parseArguments must exist in cli.ts');
  const end = source.indexOf('return { command, options, unknownFlags };', start);
  assert.ok(end > start, 'the parseArguments return sentinel must exist');
  return source.slice(start, end);
}

function extractedLongFlags(): Set<string> {
  const found = new Set<string>();
  const pattern = /--[a-z][a-z-]*/g;
  let match: RegExpExecArray | null;
  const slice = parseArgumentsSlice();
  while ((match = pattern.exec(slice)) !== null) {
    found.add(match[0]);
  }
  return found;
}

describe('flag vocabulary (#248 Wave 1)', () => {
  test('T-V1: KNOWN_CLI_FLAGS is frozen, has 49 entries and no duplicates', () => {
    assert.ok(Object.isFrozen(KNOWN_CLI_FLAGS), 'the union must be frozen');
    assert.ok(Object.isFrozen(KNOWN_LONG_FLAGS), 'the long list must be frozen');
    assert.ok(Object.isFrozen(KNOWN_SHORT_FLAGS), 'the short list must be frozen');
    assert.strictEqual(KNOWN_LONG_FLAGS.length, 43);
    assert.strictEqual(KNOWN_SHORT_FLAGS.length, 6);
    assert.strictEqual(KNOWN_CLI_FLAGS.length, 49);
    assert.strictEqual(new Set(KNOWN_CLI_FLAGS).size, KNOWN_CLI_FLAGS.length, 'no duplicates');
  });

  test('T-V2: every known flag parses without an unknown-flag diagnostic', () => {
    for (const flag of KNOWN_LONG_FLAGS) {
      if (Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_FLAGS, flag)) {
        const lines = validateUnknownFlags([flag]);
        assert.strictEqual(lines.length, 1, `${flag} must produce exactly one diagnostic`);
        assert.ok(lines[0].includes('#267'), `${flag} must name its tracking issue`);
        assert.ok(!lines[0].includes('Unknown flag'), `${flag} must not be "unknown"`);
        continue;
      }
      const parsed = parseArguments([flag]);
      assert.deepStrictEqual(
        [...parsed.unknownFlags],
        [],
        `${flag} must be recognised by the parser`
      );
    }

    for (const flag of KNOWN_SHORT_FLAGS) {
      const parsed = parseArguments([flag]);
      assert.deepStrictEqual([...parsed.unknownFlags], [], `${flag} must be recognised`);
    }
  });

  test('T-V3: every --flag the parser understands is in KNOWN_LONG_FLAGS', () => {
    const extracted = extractedLongFlags();
    assert.ok(extracted.size > 20, 'sanity: the slice must contain the flag branches');
    for (const flag of extracted) {
      assert.ok(
        KNOWN_LONG_FLAGS.includes(flag),
        `the parser understands ${flag} but KNOWN_LONG_FLAGS does not list it`
      );
    }
  });

  test('T-V4: every known long flag has a source (no dead vocabulary)', () => {
    const extracted = extractedLongFlags();
    const constantOnly = new Set([
      '--verdict-file',
      '--review-output',
      '--verdict-stdin',
      '--critique-report',
      '--report-file',
      '--report-stdin',
      '--plan-path',
      '--plan-dir'
    ]);
    for (const flag of KNOWN_LONG_FLAGS) {
      const accounted =
        extracted.has(flag) ||
        constantOnly.has(flag) ||
        Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_FLAGS, flag);
      assert.ok(accounted, `${flag} is in the vocabulary but nothing recognises it`);
    }
  });

  test('T-V5: the capability table covers every documented command and subcommand', () => {
    for (const command of CLI_DOCUMENTED_COMMANDS) {
      const key = capabilityKey({
        command,
        yolo: false,
        worktreeSubcommand: null,
        critiqueSubcommand: null,
        opencodeSubcommand: null
      });
      assert.ok(
        Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITIES, key),
        `command '${command}' has no capability entry (key '${key}')`
      );
    }

    assert.ok(Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITIES, '(default)'));
    for (const key of [
      'worktree:list',
      'worktree:clean',
      'worktree:prune',
      'worktree:remove',
      'critique:status',
      'critique:install',
      'critique:update',
      'opencode:install'
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(COMMAND_CAPABILITIES, key), key);
    }

    // `worktree rm` normalises onto the remove key.
    assert.strictEqual(
      capabilityKey({
        command: 'worktree',
        yolo: false,
        worktreeSubcommand: 'rm',
        critiqueSubcommand: null,
        opencodeSubcommand: null
      }),
      'worktree:remove'
    );

    for (const [key, capability] of Object.entries(COMMAND_CAPABILITIES) as Array<[string, any]>) {
      assert.ok(['supported', 'refused'].includes(capability.dryRun), `${key}.dryRun`);
      assert.ok(['supported', 'refused'].includes(capability.json), `${key}.json`);
    }
  });
});

/**
 * agyloop - CLI flag contract (#248 Wave 1)
 *
 * The parser used to end with `else if (!arg.startsWith('-'))` and no terminal
 * branch, so a token it did not recognise was silently discarded. A misspelled
 * `--dry-runn` therefore became "no --dry-run at all" and the command mutated
 * anyway. These tests pin the two halves of the fix:
 *
 *   1. an unrecognised flag is a HARD error with a "did you mean" suggestion;
 *   2. the rejection happens BEFORE any command body runs (no mutation).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { runCli, parseArguments } = require('../../dist/presentation/cli');
const {
  COMMAND_CAPABILITIES,
  KNOWN_LONG_FLAGS,
  UNIMPLEMENTED_FLAGS,
  validateUnknownFlags
} = require('../../dist/presentation/cli-flags');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const SEEDED_AT = '2026-10-01T00:00:00.000Z';

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

function taskCheckpoint(issue: number): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue,
    milestoneTitle: null,
    baseBranch: 'main',
    worktree: null,
    planDir: null,
    triagePayload: null,
    triageDisposition: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    history: [{ stage: 'INITIALIZED', timestamp: SEEDED_AT }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0,
    planRevisionCount: 0,
    implementToGateLoops: 0,
    reviewDispatchCount: 0
  };
}

function rootCheckpoint(): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    history: [{ stage: 'PLAN', timestamp: SEEDED_AT }]
  };
}

/** Seeds `.agyloop/state.json` and `.agyloop/tasks/888.json`. */
function seedWorkspace(dir: string): void {
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agyloop', 'state.json'), JSON.stringify(rootCheckpoint()));
  fs.writeFileSync(path.join(dir, '.agyloop', 'tasks', '888.json'), JSON.stringify(taskCheckpoint(888)));
}

/** Recursive, order-independent hash of a tree — byte identity, not mtime. */
function treeHash(root: string): string {
  if (!fs.existsSync(root)) return 'absent';
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(root, full);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        lines.push(`${rel} ${digest}`);
      }
    }
  };
  walk(root);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void,
  inspect?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-flags-'));
  let stdout = '';
  let stderr = '';

  try {
    if (seed) seed(tempDir);
    process.chdir(tempDir);
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await runCli(args);

    if (inspect) inspect(tempDir);
    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('unknown flags are hard errors (#248 AC-248.9/10)', () => {
  test('T-F1: an unknown long flag exits 1 and leaves stdout empty', async () => {
    const result = await runCliInSandbox(['status', '--bogus-flag']);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.stdout, '');
    assert.match(result.stderr, /Unknown flag '--bogus-flag'/);
  });

  test('T-F2: --dry-runn is rejected with a suggestion and mutates nothing', async () => {
    let hashBefore = '';
    let hashAfter = '';
    const result = await runCliInSandbox(
      ['reset', '--dry-runn', '--issue', '888'],
      (dir) => {
        seedWorkspace(dir);
        hashBefore = treeHash(path.join(dir, '.agyloop'));
      },
      (dir) => {
        hashAfter = treeHash(path.join(dir, '.agyloop'));
      }
    );

    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /Did you mean '--dry-run'\?/);
    assert.strictEqual(hashAfter, hashBefore, 'a rejected invocation must not touch the checkpoint tree');
  });

  test('T-F3: --skip-discoveryy suggests --skip-discovery and prints no directive', async () => {
    const result = await runCliInSandbox(['next', '--skip-discoveryy']);
    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /Did you mean '--skip-discovery'\?/);
    assert.ok(!result.stdout.includes('Next Subagent Directive'), result.stdout);
  });

  test('T-F4: a flag value never becomes the command', async () => {
    const result = await runCliInSandbox(['--bogus', 'value', 'status']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('--bogus'), result.stderr);
    assert.ok(!result.stderr.includes('Unknown command "value"'), result.stderr);
  });

  test('T-F5: a short flag is never answered with a long-flag suggestion', async () => {
    const result = await runCliInSandbox(['status', '-q']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('-q'), result.stderr);
    assert.ok(!result.stderr.includes("'-y'"), result.stderr);
    assert.ok(!result.stderr.includes('Did you mean'), result.stderr);
  });

  test('T-F6: --plan-path is IMPLEMENTED (#267) and scoped to plan/implement/yolo', async () => {
    // A command that does not execute a plan refuses it loudly — never
    // "unknown" (a typo signal) and never a silent drop.
    const refused = await runCliInSandbox(['status', '--plan-path', 'artifacts/x.md']);
    assert.strictEqual(refused.code, 1);
    assert.ok(refused.stderr.includes('--plan-path'), refused.stderr);
    assert.ok(refused.stderr.includes('only supported by plan/implement/yolo'), refused.stderr);
    assert.ok(!refused.stderr.includes('Unknown flag'), refused.stderr);
    assert.ok(!refused.stderr.includes('Did you mean'), refused.stderr);

    // A present-but-valueless flag is a loud failure.
    const missing = await runCliInSandbox(['plan', '--plan-path']);
    assert.strictEqual(missing.code, 1);
    assert.ok(missing.stderr.includes('without a value'), missing.stderr);
  });

  test('T-F9: a flag before the command is still rejected', async () => {
    const result = await runCliInSandbox(['--bogus', 'status']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('--bogus'), result.stderr);
  });

  test('T-F10: `--` ends options and a bare `-` is positional', () => {
    const afterTerminator = parseArguments(['--', 'status']);
    assert.strictEqual(afterTerminator.command, 'status');
    assert.deepStrictEqual(afterTerminator.unknownFlags, []);

    const flagAsPositional = parseArguments(['status', '--', '--json']);
    assert.strictEqual(flagAsPositional.command, 'status');
    assert.strictEqual(flagAsPositional.options.json, false);
    assert.deepStrictEqual(flagAsPositional.unknownFlags, []);

    const bareDash = parseArguments(['-']);
    assert.deepStrictEqual(bareDash.unknownFlags, []);
  });

  test('T-F11: every rejected invocation leaves the tree byte-identical', async () => {
    const invocations = [
      ['reset', '--dry-runn', '--issue', '888'],
      ['abort', '--dry-runn'],
      ['worktree', 'remove', '888', '--dry-runn'],
      ['critique', 'install', '--dry-runn'],
      ['status', '--bogus'],
      ['status', '--plan-path', 'x.md']
    ];

    for (const args of invocations) {
      let before = '';
      let after = '';
      const result = await runCliInSandbox(
        args,
        (dir) => {
          seedWorkspace(dir);
          before = treeHash(dir);
        },
        (dir) => {
          after = treeHash(dir);
        }
      );
      assert.notStrictEqual(result.code, 0, `${args.join(' ')} must be rejected`);
      assert.strictEqual(after, before, `${args.join(' ')} must not mutate the workspace`);
    }
  });

  test('T-F12: an unknown flag beats --help', async () => {
    const rejected = await runCliInSandbox(['status', '--bogus', '--help']);
    assert.strictEqual(rejected.code, 1);
    assert.ok(rejected.stderr.includes('--bogus'), rejected.stderr);
    assert.ok(!rejected.stdout.includes('Usage:'), rejected.stdout);

    const help = await runCliInSandbox(['--help']);
    assert.strictEqual(help.code, 0);
    assert.ok(help.stdout.includes('Usage:'), help.stdout);
  });

  test('T-F13: =value on a boolean flag is a shape error, not an unknown flag', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['reset', '--dry-run=true', '--issue', '888'],
      (dir) => {
        seedWorkspace(dir);
        before = treeHash(path.join(dir, '.agyloop'));
      },
      (dir) => {
        after = treeHash(path.join(dir, '.agyloop'));
      }
    );
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('does not take a value'), result.stderr);
    assert.ok(!result.stderr.includes('Unknown flag'), result.stderr);
    assert.strictEqual(after, before);
  });
});

describe('capability gate refusals (#248 AC-248.11, #275 AC-275.2)', () => {
  test('T-F7: every read-only command refuses --dry-run', async () => {
    const refusedDryRun: Array<[string, string[]]> = [
      ['status', ['status', '--dry-run']],
      ['config', ['config', '--dry-run']],
      ['models', ['models', '--dry-run']],
      ['prompt', ['prompt', '--dry-run']],
      ['branch-info', ['branch-info', '--dry-run']],
      ['worktree list', ['worktree', 'list', '--dry-run']],
      ['critique status', ['critique', 'status', '--dry-run']]
      // `opencode install` was removed here: it WRITES two files, so calling it
      // read-only was false (#339 item 4). It now SIMULATES — see
      // `cli-flag-help-contract.test.ts` T4.1-T4.3 (dry run exits 0, prints both
      // would-write paths, writes nothing; the real run creates both files).
    ];

    for (const [label, args] of refusedDryRun) {
      let before = '';
      let after = '';
      const result = await runCliInSandbox(
        args,
        (dir) => {
          seedWorkspace(dir);
          before = treeHash(dir);
        },
        (dir) => {
          after = treeHash(dir);
        }
      );
      assert.strictEqual(result.code, 1, `${label} must refuse --dry-run`);
      assert.ok(result.stderr.includes('--dry-run'), `${label}: ${result.stderr}`);
      assert.strictEqual(after, before, `${label} must change nothing`);
    }
  });

  // Issue #301 (absorbing #304): `next` DOES write context fields, so it must
  // not claim to be a read-only command that refuses `--dry-run`. Its dry run
  // succeeds AND writes nothing.
  test('N-29: next --dry-run succeeds and writes nothing (#301)', async () => {
    let before = '';
    let after = '';
    const result = await runCliInSandbox(
      ['next', '--dry-run', '--issue', '888'],
      (dir) => {
        seedWorkspace(dir);
        before = treeHash(path.join(dir, '.agyloop'));
      },
      (dir) => {
        after = treeHash(path.join(dir, '.agyloop'));
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(after, before, 'next --dry-run must not touch the checkpoint tree');
    assert.ok(!result.stderr.includes('does not modify state'), result.stderr);
  });

  test('T-F8: every command without a JSON surface refuses --json', async () => {
    const refusedJson: Array<[string, string[]]> = [
      ['config', ['config', '--json']],
      ['models', ['models', '--json']],
      ['prompt', ['prompt', '--json']],
      ['reset', ['reset', '--json']],
      ['abort', ['abort', '--json']],
      ['transition', ['transition', 'PLAN', '--json']],
      ['plan', ['plan', '--json']],
      ['implement', ['implement', '--json']],
      ['commit', ['commit', '--json']],
      ['release', ['release', '--json']],
      ['yolo', ['yolo', '--json']],
      ['sync', ['sync', '--json']]
    ];

    for (const [label, args] of refusedJson) {
      const result = await runCliInSandbox(args);
      assert.strictEqual(result.code, 1, `${label} must refuse --json`);
      assert.ok(result.stdout.trim().startsWith('{') === false, `${label} printed a JSON document: ${result.stdout}`);
      assert.ok(result.stderr.includes('--json'), `${label}: ${result.stderr}`);
    }
  });

  test('the capability table is the single source of truth for the refusal tests', () => {
    assert.ok(Object.keys(COMMAND_CAPABILITIES).length > 0);
    for (const [key, capability] of Object.entries(COMMAND_CAPABILITIES) as Array<[string, any]>) {
      assert.ok(['supported', 'refused'].includes(capability.dryRun), key);
      assert.ok(['supported', 'refused'].includes(capability.json), key);
    }
  });

  test('the unimplemented vocabulary is empty and the plan flags are known (#267)', () => {
    assert.deepStrictEqual(Object.keys(UNIMPLEMENTED_FLAGS), []);
    assert.ok(KNOWN_LONG_FLAGS.includes('--plan-path'));
    assert.ok(KNOWN_LONG_FLAGS.includes('--plan-dir'));
    assert.ok(!KNOWN_LONG_FLAGS.includes('--not-a-real-flag'));
  });
});

describe('help text documents the flag contract (#275 AC-275.5)', () => {
  test('T-J8: --json names its supported commands and both plan flags are documented', async () => {
    const result = await runCliInSandbox(['--help']);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /--json\s+Machine-readable JSON \(supported by: init, next, branch-info, status/);
    assert.match(result.stdout, /--plan-path <f> Supply an existing plan file/);
    assert.match(result.stdout, /--plan-dir <d>\s+Supply an existing plan directory/);
    assert.match(result.stdout, /--dry-run\s+Simulate execution without modifying state \(mutating commands only/);
    assert.ok(result.stdout.includes('Legacy {COMPLETED, pausedAtGate: COMMIT}'), result.stdout);
  });
});

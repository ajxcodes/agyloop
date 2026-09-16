/**
 * agyloop - CLI Operational Modes, Flags & Help Presentation Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parseArguments,
  printHelp,
  formatStageBadge,
  runCli
} = require('../../dist/presentation');
const {
  STAGE_INITIALIZED,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  CLI_VERSION
} = require('../../dist/domain');

describe('CLI Operational Modes & Flag Parsing', () => {
  describe('Operational Flags & Alias Combinations', () => {
    test('parses --yolo flag', () => {
      const parsed = parseArguments(['--yolo']);
      assert.strictEqual(parsed.command, null);
      assert.strictEqual(parsed.options.yolo, true);
    });

    test('parses yolo subcommand', () => {
      const parsed = parseArguments(['yolo']);
      assert.strictEqual(parsed.command, 'yolo');
      assert.strictEqual(parsed.options.yolo, false);
    });

    test('parses --commit-after flag alone', () => {
      const parsed = parseArguments(['--commit-after']);
      assert.strictEqual(parsed.options.commitAfter, true);
    });

    test('parses yolo with --commit-after', () => {
      const parsed = parseArguments(['yolo', '--commit-after']);
      assert.strictEqual(parsed.command, 'yolo');
      assert.strictEqual(parsed.options.commitAfter, true);
    });

    test('parses --yolo with --commit-after', () => {
      const parsed = parseArguments(['--yolo', '--commit-after']);
      assert.strictEqual(parsed.command, null);
      assert.strictEqual(parsed.options.yolo, true);
      assert.strictEqual(parsed.options.commitAfter, true);
    });

    test('parses gates with --commit-after', () => {
      const parsed = parseArguments(['gates', '--commit-after']);
      assert.strictEqual(parsed.command, 'gates');
      assert.strictEqual(parsed.options.commitAfter, true);
    });

    test('parses commit with -y / --yes flag', () => {
      const parsedShort = parseArguments(['commit', '-y']);
      assert.strictEqual(parsedShort.command, 'commit');
      assert.strictEqual(parsedShort.options.yes, true);

      const parsedLong = parseArguments(['commit', '--yes']);
      assert.strictEqual(parsedLong.command, 'commit');
      assert.strictEqual(parsedLong.options.yes, true);
    });

    test('parses commit with -m and --message', () => {
      const parsedShort = parseArguments(['commit', '-m', 'feat: add flag']);
      assert.strictEqual(parsedShort.options.message, 'feat: add flag');

      const parsedEq = parseArguments(['commit', '--message=feat: add flag']);
      assert.strictEqual(parsedEq.options.message, 'feat: add flag');
    });

    test('parses plan with --issue and --title', () => {
      const parsed = parseArguments(['plan', '--issue', '42', '--title', 'My Plan']);
      assert.strictEqual(parsed.command, 'plan');
      assert.strictEqual(parsed.options.issue, '42');
      assert.strictEqual(parsed.options.title, 'My Plan');
    });

    test('parses implement mode', () => {
      const parsed = parseArguments(['implement', '--issue', '32']);
      assert.strictEqual(parsed.command, 'implement');
      assert.strictEqual(parsed.options.issue, '32');
    });

    test('parses --dry-run and -s / --staged', () => {
      const parsed = parseArguments(['gates', '--staged', '--dry-run']);
      assert.strictEqual(parsed.options.staged, true);
      assert.strictEqual(parsed.options.dryRun, true);
    });

    test('parses --worktree and --no-worktree flags', () => {
      const parsedDefault = parseArguments(['yolo']);
      assert.strictEqual(parsedDefault.options.worktree, true);

      const parsedWorktree = parseArguments(['implement', '--worktree']);
      assert.strictEqual(parsedWorktree.options.worktree, true);

      const parsedNoWorktree = parseArguments(['yolo', '--no-worktree']);
      assert.strictEqual(parsedNoWorktree.options.worktree, false);
    });

    test('parses --base-branch option', () => {
      const parsed = parseArguments(['implement', '--base-branch', 'develop']);
      assert.strictEqual(parsed.options.baseBranch, 'develop');

      const parsedEq = parseArguments(['yolo', '--base-branch=feature/base']);
      assert.strictEqual(parsedEq.options.baseBranch, 'feature/base');
    });

    test('parses worktree subcommands', () => {
      const parsedList = parseArguments(['worktree', 'list']);
      assert.strictEqual(parsedList.command, 'worktree');
      assert.strictEqual(parsedList.options.worktreeSubcommand, 'list');

      const parsedPrune = parseArguments(['worktree', 'prune']);
      assert.strictEqual(parsedPrune.command, 'worktree');
      assert.strictEqual(parsedPrune.options.worktreeSubcommand, 'prune');

      const parsedClean = parseArguments(['worktree', 'clean']);
      assert.strictEqual(parsedClean.command, 'worktree');
      assert.strictEqual(parsedClean.options.worktreeSubcommand, 'clean');

      const parsedRemove = parseArguments(['worktree', 'remove', '87']);
      assert.strictEqual(parsedRemove.command, 'worktree');
      assert.strictEqual(parsedRemove.options.worktreeSubcommand, 'remove');
      assert.strictEqual(parsedRemove.options.worktreeTarget, '87');
    });
  });

  describe('Help Output & Stage Badges', () => {
    test('printHelp logs comprehensive documentation with operational modes and examples', () => {
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        printHelp();
      } finally {
        console.log = originalLog;
      }

      assert.ok(output.includes(`agyloop v${CLI_VERSION}`));
      assert.ok(output.includes('Operational Modes:'));
      assert.ok(output.includes('yolo'));
      assert.ok(output.includes('plan'));
      assert.ok(output.includes('implement'));
      assert.ok(output.includes('gates'));
      assert.ok(output.includes('commit'));
      assert.ok(output.includes('--commit-after'));
      assert.ok(output.includes('--yolo'));
      assert.ok(output.includes('Examples:'));
      assert.ok(output.includes('agyloop yolo --commit-after'));
    });

    test('formatStageBadge formats ANSI color tags cleanly', () => {
      const initBadge = formatStageBadge(STAGE_INITIALIZED);
      assert.ok(initBadge.includes('[INITIALIZED]'));

      const approvalBadge = formatStageBadge(STAGE_APPROVAL);
      assert.ok(approvalBadge.includes('[APPROVAL]'));

      const completedBadge = formatStageBadge(STAGE_COMPLETED);
      assert.ok(completedBadge.includes('[COMPLETED]'));
    });
  });

  describe('CLI Dispatcher Execution', () => {
    test('runCli prints version 0.2.0 and returns success code', async () => {
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        const exitCode = await runCli(['--version']);
        assert.strictEqual(exitCode, 0);
        assert.ok(output.includes(`agyloop v${CLI_VERSION}`));
      } finally {
        console.log = originalLog;
      }
    });

    test('runCli commit --dry-run outputs preview and exits 0 without prompting', async () => {
      const prevCwd = process.cwd();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-commit-test-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'COMMIT',
          mode: 'standard',
          issue: 99,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: [{ stage: 'COMMIT', timestamp: new Date().toISOString() }]
        })
      );

      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['commit', '--dry-run']);
        assert.strictEqual(exitCode, 0);
        assert.ok(output.includes('[DRY RUN] Simulated commit. No changes were committed.'));
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli commit without -y in non-interactive environment exits 1 with helpful message', async () => {
      const prevCwd = process.cwd();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-noninteractive-test-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'COMMIT',
          mode: 'standard',
          issue: 99,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: [{ stage: 'COMMIT', timestamp: new Date().toISOString() }]
        })
      );

      let errorOutput = '';
      const originalError = console.error;
      console.error = (msg) => {
        errorOutput += msg + '\n';
      };

      const originalIsTTY = process.stdin.isTTY;
      try {
        process.chdir(tempDir);
        // Simulate non-interactive subagent environment
        (process.stdin as any).isTTY = false;

        const exitCode = await runCli(['commit']);
        assert.strictEqual(exitCode, 1);
        assert.ok(errorOutput.includes('Error: Interactive confirmation required. Pass -y/--yes in non-interactive environments.'));
      } finally {
        process.chdir(prevCwd);
        (process.stdin as any).isTTY = originalIsTTY;
        console.error = originalError;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

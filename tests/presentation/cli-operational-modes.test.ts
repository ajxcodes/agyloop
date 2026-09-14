/**
 * agyloop - CLI Operational Modes, Flags & Help Presentation Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseArguments,
  printHelp,
  formatStageBadge
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
});

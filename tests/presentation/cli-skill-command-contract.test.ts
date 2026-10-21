/**
 * agyloop - Skill <-> CLI Command Contract Tests (issue #269, AC2.2)
 *
 * The OpenCode skill documented `codeloop review`, but the command did not
 * exist: `Error: Unknown command "review". Run "agyloop --help" for available
 * commands.` The skill and the CLI disagreed, and an agent following the skill
 * got an "Unknown command" at the moment it mattered.
 *
 * SK1 - every `codeloop <cmd>` the skill mentions is a DOCUMENTED command
 * SK2 - every DOCUMENTED command has a `case` in the CLI's command switch
 * SK3 - `AGY_SUBAGENT=1 codeloop review` is permitted (the channel is open)
 *       while every other mutating command is still blocked
 * SK4 - `OPENCODE_SKILL_ASSET_RELATIVE_PATH` resolves to the skill file — the
 *       installed copy and the source cannot disagree
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runCli,
  EXIT_CODE_SUCCESS
} = require('../../dist/presentation/cli');
const {
  CLI_DOCUMENTED_COMMANDS,
  STATE_MUTATING_COMMANDS,
  COMMAND_TRIAGE,
  COMMAND_HALT,
  COMMAND_REVIEW,
  OPENCODE_SKILL_ASSET_RELATIVE_PATH
} = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_FILE = path.join(PROJECT_ROOT, OPENCODE_SKILL_ASSET_RELATIVE_PATH);
const CLI_SOURCE = path.join(PROJECT_ROOT, 'src', 'presentation', 'cli.ts');
const CONSTANTS_SOURCE = path.join(PROJECT_ROOT, 'src', 'domain', 'constants.ts');

describe('Skill <-> CLI command contract (issue #269)', () => {
  test('SK1: every command the skill mentions is a documented CLI command', () => {
    const skill = fs.readFileSync(SKILL_FILE, 'utf8');

    const mentioned = new Set<string>();
    const pattern = /\bcodeloop ([a-z][a-z-]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(skill)) !== null) {
      mentioned.add(match[1]);
    }

    assert.ok(mentioned.size > 0, 'the skill must mention at least one command');

    for (const command of mentioned) {
      assert.ok(
        CLI_DOCUMENTED_COMMANDS.includes(command),
        `the skill documents \`codeloop ${command}\`, which is not a documented CLI command`
      );
    }

    // The specific regression: the skill documented a command that did not
    // exist. It must exist now.
    assert.ok(skill.includes('codeloop review'), 'the skill must document `codeloop review`');
    assert.ok(
      CLI_DOCUMENTED_COMMANDS.includes('review'),
      '`review` must be a documented CLI command'
    );
  });

  test('SK2: every documented command has a case in the CLI switch', () => {
    const cliSource = fs.readFileSync(CLI_SOURCE, 'utf8');
    const constantsSource = fs.readFileSync(CONSTANTS_SOURCE, 'utf8');

    // Resolve the `COMMAND_*` constants the CLI's switch uses by name.
    const constants = new Map<string, string>();
    const constantPattern = /export const (COMMAND_[A-Z_]+)\s*=\s*'([^']+)'/g;
    let constantMatch: RegExpExecArray | null;
    while ((constantMatch = constantPattern.exec(constantsSource)) !== null) {
      constants.set(constantMatch[1], constantMatch[2]);
    }

    const cases = new Set<string>();
    const casePattern = /case\s+(?:'([^']+)'|([A-Z][A-Z0-9_]*))\s*:/g;
    let caseMatch: RegExpExecArray | null;
    while ((caseMatch = casePattern.exec(cliSource)) !== null) {
      if (caseMatch[1]) {
        cases.add(caseMatch[1]);
      } else if (caseMatch[2] && constants.has(caseMatch[2])) {
        cases.add(constants.get(caseMatch[2])!);
      }
    }

    for (const command of CLI_DOCUMENTED_COMMANDS) {
      assert.ok(
        cases.has(command),
        `the documented command \`${command}\` has no case in src/presentation/cli.ts`
      );
    }

    // The removed commands must NOT be documented commands.
    assert.ok(!CLI_DOCUMENTED_COMMANDS.includes('gate'));
    assert.ok(!CLI_DOCUMENTED_COMMANDS.includes('gates'));
  });

  test('SK3: AGY_SUBAGENT=1 may run `review`, but every other mutating command is still blocked', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-skill-contract-'));
    const prevCwd = process.cwd();
    const originalSubagent = process.env.AGY_SUBAGENT;
    const originalLog = console.log;
    const originalError = console.error;
    let errorOutput = '';

    try {
      process.chdir(sandbox);
      process.env.AGY_SUBAGENT = '1';
      console.log = () => {};
      console.error = (msg: any) => {
        errorOutput += String(msg) + '\n';
      };

      // The carved-out commands: the reviewer subagent must be able to FILE its
      // verdict, the triage subagent must be able to ROUTE, and the runner must
      // be able to report a quota halt.
      for (const command of [COMMAND_REVIEW, COMMAND_TRIAGE, COMMAND_HALT]) {
        errorOutput = '';
        await runCli([command]);
        assert.ok(
          !errorOutput.includes('Subagents are not permitted'),
          `\`${command}\` must be permitted for a subagent, got:\n${errorOutput}`
        );
        assert.ok(
          !errorOutput.includes('Zero Direct Root Mutation'),
          `\`${command}\` must be permitted for a subagent, got:\n${errorOutput}`
        );
      }

      // Every OTHER mutating command is still blocked.
      for (const command of STATE_MUTATING_COMMANDS) {
        if (command === null) continue;
        if (command === COMMAND_TRIAGE || command === COMMAND_HALT || command === COMMAND_REVIEW) {
          continue;
        }
        errorOutput = '';
        const code = await runCli([command]);
        assert.ok(
          errorOutput.includes('Subagents are not permitted'),
          `\`${command}\` must still be blocked for a subagent, got:\n${errorOutput}`
        );
        assert.strictEqual(code, 1, `\`${command}\` must exit 1 when blocked`);
      }
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      if (originalSubagent !== undefined) {
        process.env.AGY_SUBAGENT = originalSubagent;
      } else {
        delete process.env.AGY_SUBAGENT;
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('SK4: the installed skill asset resolves to the source skill file', () => {
    assert.ok(
      fs.existsSync(SKILL_FILE),
      `the skill asset must exist at ${OPENCODE_SKILL_ASSET_RELATIVE_PATH}`
    );

    const skill = fs.readFileSync(SKILL_FILE, 'utf8');
    assert.ok(
      skill.includes('codeloop review'),
      'the SOURCE skill file must document `codeloop review` — the installed copy is a symlink to it'
    );
    assert.ok(
      !skill.includes('`codeloop review`: Perform AI standards verification'),
      'the stale description of the non-existent command must be gone'
    );
  });
});

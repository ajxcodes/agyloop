/**
 * agyloop - CLI Triage Dismissal Report Tests
 *
 * The dismissal route reports what it really achieved, so the CLI must render
 * that outcome: a dismissal that only answered part of the feedback may never
 * be presented as an unqualified success, and a dismissal that handled nothing
 * at all is not a dismissal.
 *
 * The call-site test at the bottom exercises `runCli` itself: the renderer is
 * not the only place the outcome is printed, and a call site that fell back to
 * an unconditional success line would leave the renderer honest but the tool
 * lying.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { printTriageDismissOutcome, runCli } = require('../../dist/presentation');
const {
  DISMISS_OUTCOME_COMPLETE,
  DISMISS_OUTCOME_PARTIAL,
  DISMISS_OUTCOME_FAILED,
  DISMISS_OUTCOME_NOTHING,
  NOTE_DISMISS_NO_PR,
  NOTE_DISMISS_NOTHING_HANDLED
} = require('../../dist/domain');

/**
 * The single line that carries the outcome of the dismissal.
 */
function actionLine(output: string): string {
  const line = output.split('\n').find((l) => l.includes('Triage Action'));
  if (!line) {
    throw new Error(`the dismissal must print a "Triage Action" line:\n${output}`);
  }
  return line.trim();
}

function captureOutput(fn: () => void): string {
  const originalLog = console.log;
  let output = '';
  console.log = (msg: unknown) => {
    output += `${msg}\n`;
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return output;
}

describe('CLI triage dismissal reporting', () => {
  test('a complete dismissal reports what it replied to and resolved', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: true,
        threadsReplied: 28,
        threadsResolved: 28,
        threadsSkipped: 0,
        conversationsReplied: 24,
        conversationsSkipped: 0,
        conversationsAlreadyAnswered: 0,
        conversationsDuplicate: 0,
        conversationsIgnored: 0,
        conversationsPriorAnswers: 0,
        failures: [],
        surfaces: ['Inline threads', 'PR conversation']
      })
    );

    assert.strictEqual(actionLine(output), `✓ Triage Action : ${DISMISS_OUTCOME_COMPLETE}`);
    assert.ok(output.includes('Inline threads  : 28 replied, 28 resolved, 0 skipped'));
    assert.ok(output.includes('PR conversation : 24 replied, 0 skipped'));
    assert.ok(!output.includes('PARTIAL'));
    assert.ok(!output.includes('Failures'));
  });

  test('a partial dismissal is never presented as an unqualified success', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: true,
        threadsReplied: 7,
        threadsResolved: 7,
        threadsSkipped: 0,
        conversationsReplied: 18,
        conversationsSkipped: 3,
        conversationsAlreadyAnswered: 2,
        conversationsDuplicate: 1,
        conversationsIgnored: 0,
        conversationsPriorAnswers: 0,
        failures: [
          { scope: 'thread', target: 'PRRT_abc', error: 'secondary rate limit' },
          { scope: 'conversation', target: '6293879014', error: 'secondary rate limit' }
        ],
        surfaces: ['Inline threads', 'PR conversation']
      })
    );

    assert.strictEqual(actionLine(output), `⚠ Triage Action : ${DISMISS_OUTCOME_PARTIAL}`);
    assert.ok(!output.includes('✓ Triage Action : DISMISS\n'));
    assert.ok(output.includes('Inline threads  : 7 replied, 7 resolved, 0 skipped'));
    assert.ok(output.includes('PR conversation : 18 replied, 3 skipped'));
    assert.ok(output.includes('Failures        : 2'));
    assert.ok(output.includes('- thread PRRT_abc: secondary rate limit'));
    assert.ok(output.includes('- conversation 6293879014: secondary rate limit'));
  });

  test('a dismissal that achieved nothing is reported as failed', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: true,
        threadsReplied: 0,
        threadsResolved: 0,
        threadsSkipped: 0,
        conversationsReplied: 0,
        conversationsSkipped: 0,
        conversationsAlreadyAnswered: 0,
        conversationsDuplicate: 0,
        conversationsIgnored: 0,
        conversationsPriorAnswers: 0,
        failures: [{ scope: 'thread', target: 'PRRT_abc', error: 'secondary rate limit' }],
        surfaces: ['Inline threads']
      })
    );

    assert.strictEqual(actionLine(output), `✗ Triage Action : ${DISMISS_OUTCOME_FAILED}`);
    assert.ok(!output.includes('✓ Triage Action : DISMISS\n'));
  });

  /**
   * The regression this delta exists to prevent: a dismissal that RAN, handled
   * nothing and recorded no failure used to wear the unqualified green success
   * line, because the renderer only left the "COMPLETE" branch when a failure
   * had been recorded.
   */
  test('a dismissal that ran and handled nothing is never an unqualified success', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: true,
        threadsReplied: 0,
        threadsResolved: 0,
        threadsSkipped: 0,
        conversationsReplied: 0,
        conversationsSkipped: 0,
        conversationsAlreadyAnswered: 0,
        conversationsDuplicate: 0,
        conversationsIgnored: 0,
        conversationsPriorAnswers: 0,
        failures: [],
        surfaces: []
      })
    );

    const line = actionLine(output);
    assert.ok(!line.startsWith('✓'), `a dismissal that handled nothing must not be green: ${line}`);
    assert.match(line, /^[⚠✗]/, `a dismissal that handled nothing must be non-green: ${line}`);
    assert.ok(line.includes(DISMISS_OUTCOME_NOTHING), `the outcome must be "nothing dismissed": ${line}`);
  });

  /**
   * A run over an already-dismissed PR replies to nothing BECAUSE everything
   * was already answered. The counters must show that, or the operator reads
   * "nothing dismissed" as a failure of the route.
   */
  test('a run where everything was already answered shows the skips', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: true,
        threadsReplied: 0,
        threadsResolved: 0,
        threadsSkipped: 4,
        conversationsReplied: 0,
        conversationsSkipped: 26,
        conversationsAlreadyAnswered: 26,
        conversationsDuplicate: 0,
        conversationsIgnored: 26,
        conversationsPriorAnswers: 24,
        failures: [],
        surfaces: ['PR conversation']
      })
    );

    const line = actionLine(output);
    assert.ok(!line.startsWith('✓'), `an already-answered PR must not be a green dismissal: ${line}`);
    assert.ok(line.includes(DISMISS_OUTCOME_NOTHING), `the outcome must be "nothing dismissed": ${line}`);
    assert.ok(
      output.includes('Inline threads  : 0 replied, 0 resolved, 4 skipped (already answered)'),
      `the resolved threads must be reported as skipped:\n${output}`
    );
    assert.ok(
      output.includes('PR conversation : 0 replied, 26 skipped (26 already answered, 0 duplicate feedback)'),
      `the already-answered comments must be reported as skipped:\n${output}`
    );
    assert.ok(
      output.includes('26 ignored (own dismissal reply)'),
      `the tool's own replies must be reported as ignored:\n${output}`
    );
    assert.ok(
      output.includes('24 ignored (unmarked prior answer)'),
      `the unattributable prior answers must be reported:\n${output}`
    );
  });

  test('a dismissal that never ran says why', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: false,
        skippedReason: 'no dismissal notes were provided (-m "<notes>")',
        threadsReplied: 0,
        threadsResolved: 0,
        threadsSkipped: 0,
        conversationsReplied: 0,
        conversationsSkipped: 0,
        conversationsAlreadyAnswered: 0,
        conversationsDuplicate: 0,
        conversationsIgnored: 0,
        conversationsPriorAnswers: 0,
        failures: [],
        surfaces: []
      })
    );

    assert.ok(output.includes('⚠ Triage Action : DISMISS (NOTHING DISMISSED)'));
    assert.ok(output.includes('no dismissal notes were provided'));
    assert.ok(!output.includes('✓ Triage Action : DISMISS\n'));
  });

  test('the dismissal report names the surfaces it acted on', () => {
    const output = captureOutput(() =>
      printTriageDismissOutcome({
        attempted: true,
        threadsReplied: 2,
        threadsResolved: 2,
        threadsSkipped: 0,
        conversationsReplied: 1,
        conversationsSkipped: 0,
        conversationsAlreadyAnswered: 0,
        conversationsDuplicate: 0,
        conversationsIgnored: 0,
        conversationsPriorAnswers: 0,
        failures: [],
        surfaces: ['Inline threads', 'PR conversation']
      })
    );

    assert.ok(output.includes('Surfaces'), 'the surfaces of the dismissal must be rendered');
    assert.ok(output.includes('Inline threads, PR conversation'));
  });
});

/**
 * The renderer is not the only place the dismissal outcome is printed: the CLI
 * call site prints it too. A call site that fell back to an unconditional
 * `✓ Triage Action : ...` line would leave the renderer honest while the tool
 * still lied to the operator — so the call site is exercised here.
 */
describe('CLI triage dismissal call site', () => {
  test('triage dismiss never prints an unqualified success line', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-triage-dismiss-callsite-'));
    const prevCwd = process.cwd();
    const prevSubagent = process.env.AGY_SUBAGENT;
    const prevGhRepo = process.env.GH_REPO;
    const originalLog = console.log;
    const originalError = console.error;

    let output = '';
    let exitCode = -1;
    console.log = (msg: unknown) => {
      output += `${msg}\n`;
    };
    console.error = (msg: unknown) => {
      output += `${msg}\n`;
    };
    // The triage subagent is the only caller allowed to run a routing action.
    process.env.AGY_SUBAGENT = '1';
    // No ambient repository: the gateway must not resolve a PR from the host.
    delete process.env.GH_REPO;

    try {
      process.chdir(tempDir);
      // The routing precondition requires the resolved checkpoint to be at
      // TRIAGE, and `--issue 259` binds `.agyloop/tasks/259.json` (#250).
      const tasksDir = path.join(tempDir, '.agyloop', 'tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        path.join(tasksDir, '259.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'TRIAGE',
          mode: 'standard',
          issue: 259,
          baseBranch: 'main',
          createdAt: now,
          updatedAt: now,
          history: [{ stage: 'TRIAGE', timestamp: now }],
          pausedAtGate: null,
          pausedAtTimestamp: null
        })
      );
      exitCode = await runCli(['triage', 'dismiss', '-m', 'not applicable', '--issue', '259']);
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      if (prevSubagent === undefined) {
        delete process.env.AGY_SUBAGENT;
      } else {
        process.env.AGY_SUBAGENT = prevSubagent;
      }
      if (prevGhRepo === undefined) {
        delete process.env.GH_REPO;
      } else {
        process.env.GH_REPO = prevGhRepo;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    assert.strictEqual(exitCode, 0, `the dismissal must not fail:\n${output}`);

    const line = actionLine(output);
    // The OUTCOME CLASS is what is asserted: a green unqualified success line
    // is the regression this test exists to catch, whatever the wording is.
    assert.ok(!line.startsWith('✓'), `the dismissal must not be an unqualified success: ${line}`);
    assert.match(line, /^[⚠✗]/, `the dismissal must be rendered as a non-green outcome: ${line}`);
    assert.ok(
      line.includes(DISMISS_OUTCOME_NOTHING),
      `a dismissal that dismissed nothing must say so: ${line}`
    );
    // ...and it must state a truthful reason for having dismissed nothing:
    // either no PR was resolved, or the run handled no feedback at all.
    const zeroCaseReasons = [NOTE_DISMISS_NO_PR, NOTE_DISMISS_NOTHING_HANDLED];
    assert.ok(
      zeroCaseReasons.some((reason) => line.includes(reason)),
      `the dismissal must say why nothing was dismissed: ${line}`
    );
  });
});

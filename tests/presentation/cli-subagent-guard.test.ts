/**
 * agyloop - CLI Subagent Guard Presentation Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  runCli,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE
} = require('../../dist/presentation');
const { MSG_TRIAGE_ROUTING_REQUIRES_GATE } = require('../../dist/domain');

describe('CLI Subagent Guard', () => {
  let prevCwd: string;
  let originalEnvSubagent: string | undefined;
  let tempDir: string;
  let originalLog: any;
  let originalError: any;
  let errorOutput = '';
  let standardOutput = '';

  beforeEach(() => {
    prevCwd = process.cwd();
    originalEnvSubagent = process.env.AGY_SUBAGENT;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-subagent-guard-'));
    const stateDir = path.join(tempDir, '.agyloop');
    fs.mkdirSync(stateDir, { recursive: true });
    
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        version: '1.0.0',
        currentStage: 'INITIALIZED',
        mode: 'standard',
        issue: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: []
      })
    );
    
    errorOutput = '';
    standardOutput = '';
    originalLog = console.log;
    originalError = console.error;
    console.log = (msg) => {
      standardOutput += msg + '\n';
    };
    console.error = (msg) => {
      errorOutput += msg + '\n';
    };
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnvSubagent !== undefined) {
      process.env.AGY_SUBAGENT = originalEnvSubagent;
    } else {
      delete process.env.AGY_SUBAGENT;
    }
  });

  describe('When AGY_SUBAGENT=1', () => {
    beforeEach(() => {
      process.env.AGY_SUBAGENT = '1';
    });

    test('blocks mutating commands (transition)', async () => {
      const exitCode = await runCli(['transition', 'PLAN']);
      assert.strictEqual(exitCode, 1);
      assert.ok(errorOutput.includes('Error: Execution blocked. Subagents are not permitted to mutate global pipeline state.'));
      assert.ok(errorOutput.includes("Command 'transition' violates the Zero Direct Root Mutation invariant."));
    });

    test('blocks mutating commands (yolo)', async () => {
      const exitCode = await runCli(['yolo']);
      assert.strictEqual(exitCode, 1);
      assert.ok(errorOutput.includes("Command 'yolo' violates the Zero Direct Root Mutation invariant."));
    });

    test('blocks mutating commands (abort)', async () => {
      const exitCode = await runCli(['abort']);
      assert.strictEqual(exitCode, 1);
      assert.ok(errorOutput.includes("Command 'abort' violates the Zero Direct Root Mutation invariant."));
    });

    test('permits non-mutating commands (status)', async () => {
      const exitCode = await runCli(['status']);
      assert.strictEqual(exitCode, 0);
      assert.ok(standardOutput.includes('Pipeline Status'));
    });

    test('permits non-mutating commands (next)', async () => {
      const exitCode = await runCli(['next']);
      assert.strictEqual(exitCode, 0);
      assert.ok(standardOutput.includes('Next Subagent Directive'));
    });

    test('permits subagents to run triage', async () => {
      await runCli(['triage', 'implement']);
      assert.strictEqual(errorOutput.includes('Subagents are not permitted'), false);
      assert.strictEqual(errorOutput.includes('Root agent is not allowed'), false);
    });

    test('permits subagents to report quota via halt (issue #220 inbound channel)', async () => {
      const exitCode = await runCli(['halt', '--reason', 'quota', '--dry-run']);
      assert.strictEqual(errorOutput.includes('Subagents are not permitted'), false);
      assert.strictEqual(errorOutput.includes('Zero Direct Root Mutation'), false);
      assert.strictEqual(exitCode, 2);
    });

    test('permits subagents to file their review verdict via review (issue #269 inbound channel)', async () => {
      // The REVIEWER subagent is the PRODUCER of the verdict; `review` is the
      // channel that files it. The guard must not close that channel.
      const verdictFile = path.join(tempDir, 'verdict.md');
      fs.writeFileSync(verdictFile, 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n', 'utf8');

      await runCli(['review', '--verdict-file', verdictFile]);

      assert.strictEqual(
        errorOutput.includes('Subagents are not permitted'),
        false,
        `the review channel must be open for a subagent, got:\n${errorOutput}`
      );
      assert.strictEqual(
        errorOutput.includes('Zero Direct Root Mutation'),
        false,
        `the review channel must be open for a subagent, got:\n${errorOutput}`
      );
    });
  });

  describe('When AGY_SUBAGENT is not set', () => {
    beforeEach(() => {
      delete process.env.AGY_SUBAGENT;
    });

    test('permits mutating commands', async () => {
      await runCli(['transition', 'PLAN']);
      assert.strictEqual(errorOutput.includes('Subagents are not permitted'), false);
    });

    test('SG3a: permits a triage routing action without an environment marker', async () => {
      // Seed the gate the action actually routes: TRIAGE.
      const statePath = path.join(tempDir, '.agyloop', 'state.json');
      const snapshot = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          ...snapshot,
          currentStage: 'TRIAGE',
          history: [{ stage: 'TRIAGE', timestamp: new Date().toISOString() }],
          pausedAtGate: null,
          pausedAtTimestamp: null
        })
      );

      const exitCode = await runCli(['triage', 'completed']);

      assert.strictEqual(exitCode, 0, `a routing action must not need a marker, got:\n${errorOutput}`);
      assert.strictEqual(
        errorOutput.includes('Root agent is not allowed'),
        false,
        'the removed marker guard must not fire'
      );
      assert.strictEqual(
        errorOutput.includes('requires the checkpoint to be at the TRIAGE gate'),
        false,
        'a TRIAGE checkpoint must be routable'
      );
    });

    test('SG3b: refuses a routing action from a non-TRIAGE checkpoint', async () => {
      const exitCode = await runCli(['triage', 'implement']);
      assert.strictEqual(exitCode, 1);
      assert.ok(
        errorOutput.includes(MSG_TRIAGE_ROUTING_REQUIRES_GATE),
        `the stage precondition must refuse routing from INITIALIZED, got:\n${errorOutput}`
      );
    });
  });
});

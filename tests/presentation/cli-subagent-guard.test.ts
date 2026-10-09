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
  });

  describe('When AGY_SUBAGENT is not set', () => {
    beforeEach(() => {
      delete process.env.AGY_SUBAGENT;
    });

    test('permits mutating commands', async () => {
      await runCli(['transition', 'PLAN']);
      assert.strictEqual(errorOutput.includes('Subagents are not permitted'), false);
    });

    test('blocks root agent from running triage actions', async () => {
      const exitCode = await runCli(['triage', 'implement']);
      assert.strictEqual(exitCode, 1);
      assert.ok(errorOutput.includes('Error: Execution blocked. Root agent is not allowed to run pipeline routing triage actions.'));
    });
  });
});

/**
 * agyloop - CLI Next Action and Branch Info Presentation Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parseArguments,
  runCli
} = require('../../dist/presentation');

describe('CLI Next & Branch-Info Subcommands', () => {
  describe('Argument Parsing', () => {
    test('parses next command with and without --json', () => {
      const parsed = parseArguments(['next']);
      assert.strictEqual(parsed.command, 'next');
      assert.strictEqual(parsed.options.json, false);

      const parsedJson = parseArguments(['next', '--json']);
      assert.strictEqual(parsedJson.command, 'next');
      assert.strictEqual(parsedJson.options.json, true);
    });

    test('parses branch-info command with and without --json', () => {
      const parsed = parseArguments(['branch-info']);
      assert.strictEqual(parsed.command, 'branch-info');
      assert.strictEqual(parsed.options.json, false);

      const parsedJson = parseArguments(['branch-info', '--json']);
      assert.strictEqual(parsedJson.command, 'branch-info');
      assert.strictEqual(parsedJson.options.json, true);
    });

    test('parses --keep-worktree flag', () => {
      const parsed = parseArguments(['commit', '--keep-worktree']);
      assert.strictEqual(parsed.command, 'commit');
      assert.strictEqual(parsed.options.keepWorktree, true);
    });
  });

  describe('runCli Dispatcher Execution', () => {
    test('runCli next outputs human readable action summary', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-test-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'INITIALIZED',
          mode: 'standard',
          issue: 41,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next']);
        assert.strictEqual(exitCode, 0);
        assert.ok(output.includes('Next Subagent Directive'));
        assert.ok(output.includes('INITIALIZED'));
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli next --json outputs parseable JSON payload', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-json-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'DISCOVERY',
          mode: 'standard',
          issue: 41,
          baseBranch: 'phase/1-bridge',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.currentStage, 'DISCOVERY');
        assert.strictEqual(parsed.nextStage, 'PLAN');
        assert.strictEqual(parsed.actionType, 'subagent');
        assert.ok(parsed.invocationPayload);
        assert.strictEqual(parsed.invocationPayload.Subagents[0].TypeName, 'self');
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli branch-info outputs branch and PR routing table', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-branch-test-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: 41,
          baseBranch: 'phase/1-bridge',
          worktree: {
            worktreePath: '/repo/.worktrees/41',
            branch: 'task/41-work',
            baseBranch: 'phase/1-bridge',
            createdAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['branch-info']);
        assert.strictEqual(exitCode, 0);
        assert.ok(output.includes('Branch Lifecycle & Target Diagnostics'));
        assert.ok(output.includes('phase/1-bridge'));
        assert.ok(output.includes('task/41-work'));
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli branch-info --json outputs structured JSON', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-branch-json-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: 41,
          baseBranch: 'phase/1-bridge',
          worktree: {
            worktreePath: '/repo/.worktrees/41',
            branch: 'task/41-work',
            baseBranch: 'phase/1-bridge',
            createdAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['branch-info', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.baseBranch, 'phase/1-bridge');
        assert.strictEqual(parsed.taskBranch, 'task/41-work');
        assert.strictEqual(parsed.worktreePath, '/repo/.worktrees/41');
        assert.strictEqual(parsed.prBaseTarget, 'phase/1-bridge');
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli next --issue 51 overrides COMPLETED state and outputs DISCOVERY directive', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-override-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'COMPLETED',
          mode: 'standard',
          issue: 40,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next', '--issue', '51', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.currentStage, 'DISCOVERY');
        assert.strictEqual(parsed.nextStage, 'PLAN');
        assert.strictEqual(parsed.actionType, 'subagent');
        assert.ok(parsed.invocationPayload.Subagents[0].Prompt.includes('#51'));
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli branch-info auto-infers issue when state.issue is null', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-branch-infer-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: null,
          worktree: {
            taskId: '51',
            worktreePath: path.join(tempDir, '.worktrees', '51'),
            branch: 'task/51-work',
            baseBranch: 'main',
            createdAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['branch-info', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.taskBranch, 'task/51-work');

        // Verify state.json was persisted with inferred issue 51
        const rawState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
        assert.strictEqual(rawState.issue, 51);
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

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
const { NOTE_RESTARTED_FROM_COMPLETED } = require('../../dist/domain');

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

    test('runCli next --issue 51 on a COMPLETED checkpoint is non-destructive', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-completed-'));
      // `next --issue <n>` resolves the TASK-scoped checkpoint
      // (.agyloop/tasks/<n>.json), so that is where the seed must live.
      const stateDir = path.join(tempDir, '.agyloop', 'tasks');
      fs.mkdirSync(stateDir, { recursive: true });
      const seed = {
        version: '1.0.0',
        currentStage: 'COMPLETED',
        mode: 'standard',
        issue: 40,
        milestoneTitle: 'Phase 6',
        baseBranch: 'phase/6',
        planDir: 'artifacts/plans/40-done',
        worktree: {
          taskId: '40',
          worktreePath: '/repo/.worktrees/40',
          branch: 'task/40-work',
          baseBranch: 'phase/6',
          createdAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [
          { stage: 'INITIALIZED', timestamp: new Date().toISOString() },
          { stage: 'DISCOVERY', timestamp: new Date().toISOString() },
          { stage: 'PLAN', timestamp: new Date().toISOString() },
          { stage: 'APPROVAL', timestamp: new Date().toISOString() },
          { stage: 'IMPLEMENT', timestamp: new Date().toISOString() },
          { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() },
          { stage: 'REVIEW', timestamp: new Date().toISOString() },
          { stage: 'COMMIT', timestamp: new Date().toISOString() },
          { stage: 'COMPLETED', timestamp: new Date().toISOString() }
        ],
        totalHumanWaitMs: 123000,
        planRevisionCount: 2
      };
      const statePath = path.join(stateDir, '40.json');
      fs.writeFileSync(statePath, JSON.stringify(seed));

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next', '--issue', '40', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());

        // Issue #237 (Defect 2): `next` is a query. The forbidden
        // { currentStage: "PLAN", planDir: null } snapshot is gone.
        assert.strictEqual(parsed.currentStage, 'COMPLETED');
        assert.strictEqual(parsed.actionType, 'completed');
        assert.match(parsed.humanSummary, /--restart/);

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(persisted.currentStage, 'COMPLETED');
        assert.strictEqual(persisted.issue, 40);
        assert.strictEqual(persisted.planDir, seed.planDir);
        assert.deepStrictEqual(persisted.worktree, seed.worktree);
        assert.strictEqual(persisted.milestoneTitle, seed.milestoneTitle);
        assert.strictEqual(persisted.baseBranch, seed.baseBranch);
        assert.strictEqual(persisted.history.length, 9);
        assert.strictEqual(persisted.planRevisionCount, 2);
        assert.strictEqual(persisted.totalHumanWaitMs, 123000);
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli next --issue 51 --restart re-opens the COMPLETED checkpoint at DISCOVERY', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-restart-'));
      // Task-scoped checkpoint for the issue the operator is asking about.
      const stateDir = path.join(tempDir, '.agyloop', 'tasks');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'artifacts', 'plans', '51-done'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'artifacts', 'plans', '51-done', 'implementation-plan.md'),
        '# Approved Technical Plan for Issue 51'
      );
      const statePath = path.join(stateDir, '51.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'COMPLETED',
          mode: 'standard',
          issue: 51,
          planDir: 'artifacts/plans/51-done',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: [{ stage: 'COMPLETED', timestamp: new Date().toISOString() }],
          planRevisionCount: 2
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
        const exitCode = await runCli(['next', '--issue', '51', '--restart', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());

        assert.strictEqual(parsed.currentStage, 'DISCOVERY');
        assert.strictEqual(parsed.actionType, 'subagent');
        assert.strictEqual(parsed.role, 'discovery');

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(persisted.currentStage, 'DISCOVERY');
        // A reset seeds INITIALIZED then the DISCOVERY hop: exactly two entries,
        // and never a PLAN entry.
        assert.strictEqual(persisted.history.length, 2);
        assert.ok(!persisted.history.some((h: any) => h.stage === 'PLAN'));
        assert.strictEqual(persisted.planDir, null);
        assert.strictEqual(persisted.history[1].metadata.note, NOTE_RESTARTED_FROM_COMPLETED);
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

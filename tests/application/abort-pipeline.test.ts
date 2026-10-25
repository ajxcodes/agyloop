/**
 * agyloop - AbortPipelineUseCase Tests
 *
 * Issue #266: the Emergency Abort Protocol used to quarantine EVERY registered
 * worktree — other tasks' included — and never told the operator where the work
 * went. The scope is now the checkpoint's OWN descriptor; these tests pin that
 * selection, the skip reasons, the recovery reference and the atomicity of a
 * failed quarantine.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  AbortPipelineUseCase
} = require('../../dist/application');
const {
  NOTE_ABORT_QUARANTINE_DISABLED,
  NOTE_ABORT_WORKTREE_CLEAN,
  NOTE_ABORT_WORKTREE_CWD,
  NOTE_ABORT_WORKTREE_NOT_REGISTERED
} = require('../../dist/domain');

const WORKSPACE = '/mock/workspace';
const OWN_WORKTREE = `${WORKSPACE}/.worktrees/212`;
const OTHER_WORKTREE = `${WORKSPACE}/.worktrees/999`;

describe('AbortPipelineUseCase (Emergency Abort Protocol)', () => {
  let mockStateRepo: any;
  let mockCommandExecutor: any;
  let mockWorktreeManager: any;
  let mockPlanGenerator: any;

  function makeUseCase(): any {
    return new AbortPipelineUseCase({
      stateRepo: mockStateRepo,
      commandExecutor: mockCommandExecutor,
      worktreeManager: mockWorktreeManager,
      planGenerator: mockPlanGenerator
    });
  }

  function greenResult(command: string) {
    return {
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      combinedOutput: '',
      durationMs: 5,
      timedOut: false
    };
  }

  beforeEach(() => {
    mockStateRepo = {
      load: async () => ({
        issue: 212,
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        worktree: {
          taskId: '212',
          worktreePath: OWN_WORKTREE,
          branch: 'task/212',
          baseBranch: 'main',
          isIsolated: true
        },
        history: []
      }),
      save: async () => {},
      reset: async () => {},
      getStateFilePath: () => '/mock/workspace/.agyloop/state.json'
    };

    mockCommandExecutor = {
      executedCommands: [] as string[],
      killAllCalls: [] as (string | undefined)[],
      execute: async (cmd: string) => {
        mockCommandExecutor.executedCommands.push(cmd);
        if (cmd.includes('ps -a')) {
          if (cmd.includes('name=codeloop-sandbox-*')) {
            return {
              command: cmd,
              exitCode: 0,
              stdout: 'c123\nc456\n',
              stderr: '',
              combinedOutput: 'c123\nc456\n',
              durationMs: 5,
              timedOut: false
            };
          }
        }
        if (cmd.includes('rm -f')) {
          return greenResult(cmd);
        }
        return greenResult(cmd);
      },
      killAll: (signal?: string) => {
        mockCommandExecutor.killAllCalls.push(signal);
        return 3;
      }
    };

    mockWorktreeManager = {
      clearedWorkspace: undefined as string | undefined,
      quarantinedOptions: [] as any[],
      listedOptions: [] as any[],
      clearIndexLock: async (ws?: string) => {
        mockWorktreeManager.clearedWorkspace = ws;
        return true;
      },
      listWorktrees: async (opts?: any) => {
        mockWorktreeManager.listedOptions.push(opts);
        return [
          {
            taskId: 212,
            worktreePath: OWN_WORKTREE,
            branch: 'task/212',
            isClean: false
          }
        ];
      },
      quarantineWorktree: async (opts: any) => {
        mockWorktreeManager.quarantinedOptions.push(opts);
        return {
          quarantined: true,
          outcome: opts.quarantineBranch ? 'branch' : 'stashed',
          branch: opts.quarantineBranch ? 'quarantine/task-212-12345' : undefined,
          stashed: !opts.quarantineBranch
        };
      }
    };

    mockPlanGenerator = {
      updatedLogs: [] as any[],
      resolvePlanFile: () => ({
        folderName: '212-circuit-breakers',
        planDir: '/mock/workspace/artifacts/plans/212-circuit-breakers',
        planPath: '/mock/workspace/artifacts/plans/212-circuit-breakers/implementation-plan.md',
        summaryPath: '/mock/workspace/artifacts/plans/212-circuit-breakers/AgyLoop Summary.md'
      }),
      updateSummaryLog: (summaryPath: string, data: any) => {
        mockPlanGenerator.updatedLogs.push({ summaryPath, data });
        return true;
      }
    };
  });

  test('executes emergency abort: kills processes, clears index lock, quarantines worktrees, removes containers, and logs audit', async () => {
    const useCase = makeUseCase();

    const result = await useCase.execute({
      workspaceDir: WORKSPACE,
      issue: 212,
      force: true,
      quarantine: true,
      reason: 'Manual abort trigger'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.processesTerminated, 3);
    assert.strictEqual(result.terminatedProcessesCount, 3);
    assert.deepStrictEqual(mockCommandExecutor.killAllCalls, ['SIGKILL']);
    assert.strictEqual(result.indexLockRemoved, true);
    assert.strictEqual(mockWorktreeManager.clearedWorkspace, WORKSPACE);

    assert.strictEqual(result.worktreesQuarantined.length, 1);
    assert.strictEqual(mockWorktreeManager.quarantinedOptions.length, 1);
    assert.strictEqual(mockWorktreeManager.quarantinedOptions[0].quarantineBranch, true);

    // Ephemeral containers
    assert.ok(result.containersTerminated.length > 0);
    assert.ok(mockCommandExecutor.executedCommands.some((c: string) => c.includes('rm -f c123')));

    // Audit summary log
    assert.strictEqual(result.auditLogged, true);
    assert.strictEqual(mockPlanGenerator.updatedLogs.length, 1);
    const abortEvent = mockPlanGenerator.updatedLogs[0].data.abortEvent;
    assert.ok(abortEvent);
    assert.strictEqual(abortEvent.stage, 'IMPLEMENT');
    assert.strictEqual(abortEvent.reason, 'Manual abort trigger');
    assert.strictEqual(abortEvent.teardownMetrics.processesTerminated, 3);
    assert.strictEqual(abortEvent.teardownMetrics.terminatedProcessesCount, 3);
  });

  test('A1 quarantines only the checkpoint\'s own worktree when several are registered', async () => {
    mockWorktreeManager.listWorktrees = async (opts?: any) => {
      mockWorktreeManager.listedOptions.push(opts);
      return [
        { taskId: 212, worktreePath: OWN_WORKTREE, branch: 'task/212', isClean: false },
        { taskId: 999, worktreePath: OTHER_WORKTREE, branch: 'task/999', isClean: false }
      ];
    };

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.strictEqual(mockWorktreeManager.quarantinedOptions.length, 1, 'exactly one quarantine');
    assert.strictEqual(mockWorktreeManager.quarantinedOptions[0].worktreePath, OWN_WORKTREE);
    assert.strictEqual(result.worktreesQuarantined.length, 1);
    assert.strictEqual(result.worktreesQuarantined[0].worktreePath, OWN_WORKTREE);
    assert.deepStrictEqual(
      result.worktreesQuarantined.map((w: any) => w.worktreePath).includes(OTHER_WORKTREE),
      false,
      'the sibling task worktree must never be quarantined'
    );
  });

  test('A2 never widens the listing to external worktrees', async () => {
    await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.ok(mockWorktreeManager.listedOptions.length > 0, 'the listing must be consulted');
    for (const opts of mockWorktreeManager.listedOptions) {
      assert.strictEqual(
        Boolean(opts && opts.includeExternal),
        false,
        `a destructive operation must not list external worktrees: ${JSON.stringify(opts)}`
      );
    }
  });

  test('A3 leaves a worktree untouched when the checkpoint records none', async () => {
    mockStateRepo.load = async () => ({
      issue: 212,
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      worktree: null,
      history: []
    });

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.strictEqual(mockWorktreeManager.quarantinedOptions.length, 0);
    assert.strictEqual(result.worktreeScopePath, null);
    assert.deepStrictEqual(result.worktreesQuarantined, []);
    assert.strictEqual(mockWorktreeManager.listedOptions.length, 0, 'nothing to look up');
  });

  test('A4 reports a failed quarantine as failed and does not count it', async () => {
    mockWorktreeManager.quarantineWorktree = async (opts: any) => {
      mockWorktreeManager.quarantinedOptions.push(opts);
      return { quarantined: false, outcome: 'failed', error: 'stash boom' };
    };

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.deepStrictEqual(result.worktreesQuarantined, []);
    assert.deepStrictEqual(result.worktreesQuarantineFailed, [
      { worktreePath: OWN_WORKTREE, error: 'stash boom' }
    ]);
    assert.strictEqual(
      mockPlanGenerator.updatedLogs[0].data.abortEvent.teardownMetrics.worktreesQuarantineFailed,
      1
    );
    assert.strictEqual(
      mockPlanGenerator.updatedLogs[0].data.abortEvent.teardownMetrics.worktreesQuarantined,
      0
    );
  });

  test('A5 skips the worktree that contains the process cwd', async () => {
    for (const currentDir of [OWN_WORKTREE, `${OWN_WORKTREE}/sub`]) {
      mockWorktreeManager.quarantinedOptions.length = 0;
      mockWorktreeManager.listedOptions.length = 0;

      const result = await makeUseCase().execute({
        workspaceDir: WORKSPACE,
        issue: 212,
        currentDir
      });

      assert.strictEqual(
        mockWorktreeManager.quarantinedOptions.length,
        0,
        `${currentDir}: the directory the operator stands in must never be emptied`
      );
      assert.strictEqual(result.worktreesQuarantined.length, 0);
      assert.strictEqual(result.worktreesQuarantineSkipped.length, 1);
      assert.ok(result.worktreesQuarantineSkipped[0].reason.includes(NOTE_ABORT_WORKTREE_CWD));
      assert.ok(result.worktreesQuarantineSkipped[0].reason.includes('current working directory'));
      assert.strictEqual(
        result.worktreeScopePath,
        OWN_WORKTREE,
        'the operator must still be told which worktree was skipped'
      );
    }
  });

  test('A6 skips a descriptor path this repository does not register', async () => {
    mockStateRepo.load = async () => ({
      issue: 212,
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      worktree: { taskId: '212', worktreePath: '/mock/elsewhere', branch: 'task/212' },
      history: []
    });

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.strictEqual(mockWorktreeManager.quarantinedOptions.length, 0);
    assert.strictEqual(result.worktreesQuarantineSkipped.length, 1);
    assert.ok(
      result.worktreesQuarantineSkipped[0].reason.includes(NOTE_ABORT_WORKTREE_NOT_REGISTERED)
    );
    assert.strictEqual(result.worktreesQuarantineSkipped[0].worktreePath, '/mock/elsewhere');
  });

  test('A7 reports an already-clean worktree as skipped, not quarantined', async () => {
    mockWorktreeManager.quarantineWorktree = async (opts: any) => {
      mockWorktreeManager.quarantinedOptions.push(opts);
      return { quarantined: false, outcome: 'clean' };
    };

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.deepStrictEqual(result.worktreesQuarantined, []);
    assert.strictEqual(result.worktreesQuarantineSkipped.length, 1);
    assert.strictEqual(result.worktreesQuarantineSkipped[0].reason, NOTE_ABORT_WORKTREE_CLEAN);
  });

  test('A8 surfaces the stash recovery reference in the result', async () => {
    mockWorktreeManager.quarantineWorktree = async (opts: any) => {
      mockWorktreeManager.quarantinedOptions.push(opts);
      return {
        quarantined: true,
        outcome: 'stashed',
        stashed: true,
        stashRef: 'stash@{0}',
        stashMessage: 'quarantine-abort-task-212-1'
      };
    };

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.strictEqual(result.worktreesQuarantined.length, 1);
    assert.strictEqual(result.worktreesQuarantined[0].stashRef, 'stash@{0}');
    assert.strictEqual(
      result.worktreesQuarantined[0].stashMessage,
      'quarantine-abort-task-212-1'
    );
    assert.strictEqual(result.worktreesQuarantined[0].stashed, true);
  });

  test('A9 --no-quarantine skips the relocation', async () => {
    const result = await makeUseCase().execute({
      workspaceDir: WORKSPACE,
      issue: 212,
      noQuarantine: true
    });

    assert.strictEqual(mockWorktreeManager.quarantinedOptions.length, 0);
    assert.strictEqual(result.worktreesQuarantined.length, 0);
    assert.strictEqual(result.worktreesQuarantineSkipped.length, 1);
    assert.strictEqual(
      result.worktreesQuarantineSkipped[0].reason,
      NOTE_ABORT_QUARANTINE_DISABLED
    );
    assert.ok(result.worktreesQuarantineSkipped[0].reason.includes('--no-quarantine'));
    assert.strictEqual(result.worktreeScopePath, OWN_WORKTREE);
  });

  test('A10 keeps the teardown non-fatal when the checkpoint is corrupt', async () => {
    mockStateRepo.load = async () => {
      throw new Error('Failed to parse state checkpoint');
    };

    const result = await makeUseCase().execute({ workspaceDir: WORKSPACE, issue: 212 });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.worktreeScopePath, null);
    assert.strictEqual(mockWorktreeManager.quarantinedOptions.length, 0);
    assert.deepStrictEqual(result.worktreesQuarantined, []);
  });
});

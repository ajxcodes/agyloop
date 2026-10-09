/**
 * agyloop - AbortPipelineUseCase Tests
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  AbortPipelineUseCase
} = require('../../dist/application');

describe('AbortPipelineUseCase (Emergency Abort Protocol)', () => {
  let mockStateRepo: any;
  let mockCommandExecutor: any;
  let mockWorktreeManager: any;
  let mockPlanGenerator: any;

  beforeEach(() => {
    mockStateRepo = {
      load: async () => ({
        issue: 212,
        currentStage: 'IMPLEMENT',
        mode: 'standard',
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
          return {
            command: cmd,
            exitCode: 0,
            stdout: '',
            stderr: '',
            combinedOutput: '',
            durationMs: 5,
            timedOut: false
          };
        }
        return {
          command: cmd,
          exitCode: 0,
          stdout: '',
          stderr: '',
          combinedOutput: '',
          durationMs: 5,
          timedOut: false
        };
      },
      killAll: (signal?: string) => {
        mockCommandExecutor.killAllCalls.push(signal);
        return 3;
      }
    };

    mockWorktreeManager = {
      clearedWorkspace: undefined as string | undefined,
      quarantinedOptions: [] as any[],
      clearIndexLock: async (ws?: string) => {
        mockWorktreeManager.clearedWorkspace = ws;
        return true;
      },
      listWorktrees: async () => [
        {
          taskId: 212,
          worktreePath: '/mock/workspace/.worktrees/212',
          branch: 'task/212',
          isClean: false
        }
      ],
      quarantineWorktree: async (opts: any) => {
        mockWorktreeManager.quarantinedOptions.push(opts);
        return {
          quarantined: true,
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
    const useCase = new AbortPipelineUseCase({
      stateRepo: mockStateRepo,
      commandExecutor: mockCommandExecutor,
      worktreeManager: mockWorktreeManager,
      planGenerator: mockPlanGenerator
    });

    const result = await useCase.execute({
      workspaceDir: '/mock/workspace',
      issue: 212,
      force: true,
      quarantine: true,
      reason: 'Manual abort trigger'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.processesTerminated, 3);
    assert.deepStrictEqual(mockCommandExecutor.killAllCalls, ['SIGKILL']);
    assert.strictEqual(result.indexLockRemoved, true);
    assert.strictEqual(mockWorktreeManager.clearedWorkspace, '/mock/workspace');

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
  });
});

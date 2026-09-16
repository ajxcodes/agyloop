/**
 * agyloop - Worktree Guardrails & Teardown Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  TransitionStageUseCase,
  StartImplementationUseCase,
  ExecuteCommitUseCase
} = require('../../dist/application');
const {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_COMMIT,
  MODE_STANDARD,
  MODE_YOLO,
  WorktreeCreationError,
  InvalidTransitionError,
  CommitMessage,
  WorktreeDescriptor
} = require('../../dist/domain');

import type {
  StateRepository,
  WorktreeManagerPort,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  CommandExecutorPort,
  ConfirmationPromptPort,
  ConfigRepository,
  AgyLoopConfig,
  PlanGeneratorPort
} from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null = null;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.savedSnapshot = initial;
  }

  async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/repo/.agyloop/state.json';
  }
}

function makeMockWorktree(overrides: Partial<WorktreeManagerPort> = {}): WorktreeManagerPort {
  return {
    resolveTaskWorktreePath: (_dir: string, taskId: string | number) => `/repo/.worktrees/${taskId}`,
    resolveTaskBranchName: (taskId: string | number) => `task/${taskId}-worktree-guardrails`,
    ensureGitIgnore: async () => false,
    resolveBaseBranch: async () => 'phase/1-bridge',
    createWorktree: async (opts: CreateWorktreeOptions) =>
      WorktreeDescriptor.create({
        taskId: opts.taskId,
        worktreePath: `/repo/.worktrees/${opts.taskId}`,
        branch: `task/${opts.taskId}-work`,
        baseBranch: opts.baseBranch || 'phase/1-bridge',
        createdAt: new Date().toISOString()
      }),
    removeWorktree: async () => {},
    pruneWorktrees: async () => {},
    listWorktrees: async () => [],
    cleanOrphanedWorktrees: async () => 0,
    listBranches: async () => ['main', 'phase/1-bridge'],
    createBranch: async () => {},
    isAncestor: async () => false,
    getCommitsBetween: async () => [],
    pushBranch: async () => true,
    ...overrides
  };
}

function makeMockCommandExecutor(): CommandExecutorPort {
  return {
    execute: async (cmd: string) => ({
      command: cmd,
      exitCode: 0,
      stdout: '[task/41-work 1234567] commit message',
      stderr: '',
      combinedOutput: '[task/41-work 1234567] commit message',
      durationMs: 10,
      timedOut: false
    })
  };
}

function makeMockPrompt(confirmed = true): ConfirmationPromptPort {
  return {
    confirm: async () => confirmed
  };
}

function makeMockConfig(): ConfigRepository {
  const config: AgyLoopConfig = {
    models: {
      planner: 'pro',
      implementer: 'inherit',
      gate: 'flash',
      reviewer: 'flash'
    },
    options: {
      commitAfter: false,
      gateTimeoutSeconds: 300,
      autoApproveInYolo: true,
      enableMcpInPlanner: true
    }
  };
  return {
    loadConfig: () => config,
    resolveModel: (role: string) => {
      const configured = config.models[role] || 'inherit';
      let tier: any = 'inherit';
      let apiModel = 'inherit';
      if (configured.includes('pro')) {
        tier = 'pro';
        apiModel = 'gemini-2.5-pro';
      } else if (configured.includes('flash')) {
        tier = 'flash';
        apiModel = 'gemini-3.5-flash';
      }
      return { role: role as any, configured, tier, apiModel };
    },
    mapModelToTier: (inputModel: string): any => {
      if (inputModel.includes('pro')) return 'pro';
      if (inputModel.includes('flash')) return 'flash';
      return 'inherit';
    }
  };
}

function makeMockPlanGenerator(): PlanGeneratorPort {
  return {
    scaffoldPlanDirectory: () => ({
      planDir: '/repo/artifacts/plans',
      isNew: false,
      folderName: 'plans',
      type: 'implementation',
      planPath: '/repo/artifacts/plans/[Implementation] - Test.md',
      mirrorPath: '',
      summaryPath: '/repo/artifacts/plans/AgyLoop Summary.md'
    }),
    resolvePlanFile: () => ({
      planPath: '/repo/artifacts/plans/[Implementation] - Test.md',
      planDir: '/repo/artifacts/plans',
      planFileName: '[Implementation] - Test.md',
      summaryPath: '/repo/artifacts/plans/AgyLoop Summary.md',
      exists: true,
      hasSummary: true
    }),
    readPlanDocument: () => '# Plan\nImplementation details',
    generatePlan: () => ({ planPath: '', mirrorPath: '', isNew: false, created: false, title: '', content: '', documentContent: '' }),
    generateSummaryLog: () => ({ summaryPath: '', isNew: false, created: false, content: '' }),
    updateSummaryLog: () => true,
    findPlanDirectory: () => '/repo/artifacts/plans'
  };
}

describe('Worktree Guardrails & Mandatory Worktree Invariant', () => {
  describe('TransitionStageUseCase Worktree Guardrails', () => {
    test('auto-provisions worktree when transitioning to IMPLEMENT if worktreeManager is provided', async () => {
      const sm = StateMachine.createInitial({ issue: 41 });
      sm.transition('DISCOVERY');
      sm.transition('PLAN');
      sm.transition('APPROVAL');

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      let createdTaskId = '';

      const mockWorktree = makeMockWorktree({
        createWorktree: async (opts: CreateWorktreeOptions) => {
          createdTaskId = String(opts.taskId);
          return WorktreeDescriptor.create({
            taskId: opts.taskId,
            worktreePath: `/repo/.worktrees/${opts.taskId}`,
            branch: `task/${opts.taskId}-work`,
            baseBranch: 'phase/1-bridge',
            createdAt: new Date().toISOString()
          });
        }
      });

      const useCase = new TransitionStageUseCase(stateRepo, mockWorktree);
      const updatedSm = await useCase.execute({
        targetStage: STAGE_IMPLEMENT,
        issue: 41
      });

      assert.strictEqual(updatedSm.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(createdTaskId, '41');
      assert.ok(updatedSm.worktree);
      assert.strictEqual(updatedSm.worktree.worktreePath, '/repo/.worktrees/41');
    });

    test('throws WorktreeCreationError when transitioning to IMPLEMENT without worktree and no worktreeManager', async () => {
      const sm = StateMachine.createInitial({ issue: 41 });
      sm.transition('DISCOVERY');
      sm.transition('PLAN');
      sm.transition('APPROVAL');

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const useCase = new TransitionStageUseCase(stateRepo); // No worktreeManager

      await assert.rejects(
        async () => {
          await useCase.execute({ targetStage: STAGE_IMPLEMENT });
        },
        (err: unknown) => {
          assert.ok(err instanceof WorktreeCreationError);
          assert.ok((err as Error).message.includes('Cannot transition to IMPLEMENT stage without an active worktree descriptor'));
          return true;
        }
      );
    });

    test('allows transitioning to IMPLEMENT without worktree when noWorktree: true is passed', async () => {
      const sm = StateMachine.createInitial({ issue: 41 });
      sm.transition('DISCOVERY');
      sm.transition('PLAN');
      sm.transition('APPROVAL');

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const useCase = new TransitionStageUseCase(stateRepo);

      const updatedSm = await useCase.execute({
        targetStage: STAGE_IMPLEMENT,
        noWorktree: true
      });

      assert.strictEqual(updatedSm.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(updatedSm.worktree, null);
    });
  });

  describe('StartImplementationUseCase Stage Validation & Worktree Provisioning', () => {
    test('enforces stage transition validation first before attempting worktree operations', async () => {
      const sm = StateMachine.createInitial({ issue: 41 }); // in INITIALIZED
      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const mockWorktree = makeMockWorktree();

      const useCase = new StartImplementationUseCase(
        stateRepo,
        makeMockConfig(),
        makeMockPlanGenerator(),
        undefined,
        undefined,
        mockWorktree
      );

      // Must throw InvalidTransitionError, NOT WorktreeCreationError
      await assert.rejects(
        async () => {
          await useCase.execute({ workspaceDir: '/repo' });
        },
        (err: unknown) => {
          assert.ok(err instanceof InvalidTransitionError);
          return true;
        }
      );
    });

    test('auto-provisions worktree and targets taskPrompt to worktree path', async () => {
      const sm = StateMachine.createInitial({ issue: 41 });
      sm.transition('DISCOVERY');
      sm.transition('PLAN');
      sm.transition('APPROVAL');

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const mockWorktree = makeMockWorktree();

      const useCase = new StartImplementationUseCase(
        stateRepo,
        makeMockConfig(),
        makeMockPlanGenerator(),
        undefined,
        undefined,
        mockWorktree
      );

      const result = await useCase.execute({ workspaceDir: '/repo' });
      assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
      assert.ok(result.stateMachine.worktree);
      assert.strictEqual(result.stateMachine.worktree.worktreePath, '/repo/.worktrees/41');
      assert.ok(result.taskPrompt.includes('/repo/.worktrees/41'));
    });
  });

  describe('ExecuteCommitUseCase Automated Teardown & PR Target', () => {
    test('tears down worktree and cleans state machine worktree descriptor on commit by default', async () => {
      const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
      sm.setWorktree(
        WorktreeDescriptor.create({
          taskId: 41,
          worktreePath: '/repo/.worktrees/41',
          branch: 'task/41-work',
          baseBranch: 'phase/1-bridge',
          createdAt: new Date().toISOString()
        })
      );
      // Advance stage to COMMIT
      sm.transition('DISCOVERY');
      sm.transition('PLAN');
      sm.transition('APPROVAL');
      sm.transition('IMPLEMENT');
      sm.transition('QUALITY_GATE');
      sm.transition('REVIEW');
      sm.transition('COMMIT');

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      let removedPath = '';
      let forceRemoved = false;
      let pruned = false;

      const mockWorktree = makeMockWorktree({
        removeWorktree: async (opts: RemoveWorktreeOptions) => {
          removedPath = opts.worktreePath;
          forceRemoved = Boolean(opts.force);
          pruned = Boolean(opts.prune);
        }
      });

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        makeMockCommandExecutor(),
        undefined,
        makeMockPrompt(true),
        mockWorktree
      );

      const commitMsg = CommitMessage.create({
        type: 'feat',
        description: 'implement worktree teardown guardrails (#41)'
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        bypassConfirmation: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.worktreeTornDown, true);
      assert.strictEqual(removedPath, '/repo/.worktrees/41');
      assert.strictEqual(forceRemoved, true);
      assert.strictEqual(pruned, true);
      assert.strictEqual(result.stateMachine.worktree, null);
      assert.strictEqual(result.prBaseBranch, 'phase/1-bridge');
      assert.ok(result.prCommand?.includes('--base "phase/1-bridge"'));
      assert.ok(result.prCommand?.includes('--head "task/41-work"'));
    });

    test('preserves worktree when keepWorktree is true', async () => {
      const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
      sm.setWorktree(
        WorktreeDescriptor.create({
          taskId: 41,
          worktreePath: '/repo/.worktrees/41',
          branch: 'task/41-work',
          baseBranch: 'phase/1-bridge',
          createdAt: new Date().toISOString()
        })
      );
      sm.transition('DISCOVERY');
      sm.transition('PLAN');
      sm.transition('APPROVAL');
      sm.transition('IMPLEMENT');
      sm.transition('QUALITY_GATE');
      sm.transition('REVIEW');
      sm.transition('COMMIT');

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      let removeCalled = false;

      const mockWorktree = makeMockWorktree({
        removeWorktree: async () => {
          removeCalled = true;
        }
      });

      const useCase = new ExecuteCommitUseCase(
        stateRepo,
        makeMockCommandExecutor(),
        undefined,
        makeMockPrompt(true),
        mockWorktree
      );

      const commitMsg = CommitMessage.create({
        type: 'feat',
        description: 'implement worktree teardown guardrails (#41)'
      });

      const result = await useCase.execute({
        commitMessage: commitMsg,
        keepWorktree: true,
        bypassConfirmation: true
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.worktreeTornDown, false);
      assert.strictEqual(removeCalled, false);
      assert.ok(result.stateMachine.worktree);
    });
  });
});

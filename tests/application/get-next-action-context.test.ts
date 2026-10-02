/**
 * agyloop - Comprehensive Issue Context Resolution Unit Tests (Issue #51)
 *
 * Validates:
 * 1. Explicit --issue flag ingestion across COMPLETED and INITIALIZED lifecycle states.
 * 2. Automatic context inference from worktree paths and git branches.
 * 3. State persistence of inferred issue numbers.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { GetNextActionUseCase, RunPreFlightCheckUseCase } = require('../../dist/application');
const {
  StateMachine,
  IssueNumber,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  ROLE_PLANNER
} = require('../../dist/domain');

import type {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  WorktreeManagerPort,
  AgyLoopConfig
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

function makeMockConfig(overrides: Partial<AgyLoopConfig> = {}): ConfigRepository {
  const config: AgyLoopConfig = {
    models: {
      planner: 'pro',
      implementer: 'inherit',
      gate: 'flash_lite',
      reviewer: 'flash'
    },
    options: {
      commitAfter: false,
      gateTimeoutSeconds: 300,
      autoApproveInYolo: true,
      enableMcpInPlanner: true
    },
    ...overrides
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
      } else if (configured.includes('flash_lite')) {
        tier = 'flash_lite';
        apiModel = 'gemini-2.5-flash-lite';
      } else if (configured.includes('flash')) {
        tier = 'flash';
        apiModel = 'gemini-3.5-flash';
      }
      return { role: role as any, configured, tier, apiModel };
    },
    mapModelToTier: (inputModel: string): any => {
      if (inputModel.includes('pro')) return 'pro';
      if (inputModel.includes('flash_lite')) return 'flash_lite';
      if (inputModel.includes('flash')) return 'flash';
      return 'inherit';
    }
  };
}

describe('Issue #51: Issue Context Resolution & Auto-Inference', () => {
  describe('IssueNumber Value Object Auto-Inference', () => {
    test('infers issue number from unix and windows worktree paths', () => {
      assert.strictEqual(IssueNumber.inferFromPath('.worktrees/51'), 51);
      assert.strictEqual(IssueNumber.inferFromPath('/home/user/code/agyloop/.worktrees/51'), 51);
      assert.strictEqual(IssueNumber.inferFromPath('/home/user/code/agyloop/.worktrees/51/src/domain'), 51);
      assert.strictEqual(IssueNumber.inferFromPath('C:\\code\\.worktrees\\51\\src'), 51);
      assert.strictEqual(IssueNumber.inferFromPath('/repo/src/domain'), null);
      assert.strictEqual(IssueNumber.inferFromPath(null), null);
    });

    test('infers issue number from task and fix branch names', () => {
      assert.strictEqual(IssueNumber.inferFromBranch('task/51'), 51);
      assert.strictEqual(IssueNumber.inferFromBranch('fix/42'), 42);
      assert.strictEqual(IssueNumber.inferFromBranch('task/51-issue-context'), 51);
      assert.strictEqual(IssueNumber.inferFromBranch('origin/task/51-issue-context'), 51);
      assert.strictEqual(IssueNumber.inferFromBranch('fix/99_bug_fix'), 99);
      assert.strictEqual(IssueNumber.inferFromBranch('main'), null);
      assert.strictEqual(IssueNumber.inferFromBranch('phase/5'), null);
      assert.strictEqual(IssueNumber.inferFromBranch('feature/awesome'), null);
    });

    test('infers issue number from composite context', () => {
      assert.strictEqual(
        IssueNumber.inferFromContext({
          cwd: '/repo',
          branch: 'task/51'
        }),
        51
      );
      assert.strictEqual(
        IssueNumber.inferFromContext({
          cwd: '/repo/.worktrees/45',
          branch: 'main'
        }),
        45
      );
      assert.strictEqual(
        IssueNumber.inferFromContext({
          worktreePath: '/repo/.worktrees/99',
          cwd: '/repo',
          branch: 'task/51'
        }),
        99
      );
    });
  });

  describe('StateMachine Auto-Inference & Snapshot Hydration', () => {
    test('StateMachine.fromSnapshot infers issue from worktree metadata if issue is null', () => {
      const snapshot: StateMachineSnapshot = {
        version: '1.0.0',
        currentStage: STAGE_IMPLEMENT,
        mode: 'standard',
        issue: null,
        worktree: {
          taskId: '51',
          worktreePath: '/repo/.worktrees/51',
          branch: 'task/51-context',
          baseBranch: 'main'
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: []
      };

      const sm = StateMachine.fromSnapshot(snapshot);
      assert.strictEqual(sm.issue, 51);
    });

    test('StateMachine.inferIssue sets issue when initially null', () => {
      const sm = StateMachine.createInitial();
      assert.strictEqual(sm.issue, null);

      const inferred = sm.inferIssue({ cwd: '/repo/.worktrees/51' });
      assert.strictEqual(inferred, 51);
      assert.strictEqual(sm.issue, 51);
    });
  });

  describe('GetNextActionUseCase Explicit Flag Ingestion', () => {
    test('initializes and returns DISCOVERY subagent directive when --issue is provided to COMPLETED state', async () => {
      const sm = StateMachine.createInitial({ issue: 40 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      sm.transition(STAGE_QUALITY_GATE);
      sm.transition(STAGE_REVIEW);
      sm.transition(STAGE_COMMIT);
      sm.transition(STAGE_COMPLETED);

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

      // Explicitly pass --issue 51
      const result = await useCase.execute({
        workspaceDir: '/repo',
        issue: 51
      });

      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.nextStage, STAGE_PLAN);
      assert.strictEqual(result.actionType, 'subagent');
      assert.strictEqual(result.role, ROLE_PLANNER);
      assert.ok(result.invocationPayload);
      assert.strictEqual(result.invocationPayload.Subagents[0].TypeName, 'self');
      assert.ok(result.invocationPayload.Subagents[0].Prompt.includes('#51'));

      // Check state snapshot was updated and persisted
      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 51);
      assert.strictEqual(saved?.currentStage, STAGE_DISCOVERY);
    });

    test('resumes at STAGE_PLAN if plan document already exists for explicit issue on COMPLETED state', async () => {
      const sm = StateMachine.createInitial({ issue: 40 });
      sm.transition(STAGE_DISCOVERY);
      sm.transition(STAGE_PLAN);
      sm.transition(STAGE_APPROVAL);
      sm.transition(STAGE_IMPLEMENT);
      sm.transition(STAGE_QUALITY_GATE);
      sm.transition(STAGE_REVIEW);
      sm.transition(STAGE_COMMIT);
      sm.transition(STAGE_COMPLETED);

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const mockPlanGen: PlanGeneratorPort = {
        resolvePlanFile: () => ({
          planDir: '/repo/artifacts/plans',
          planFileName: '51-plan.md',
          planPath: '/repo/artifacts/plans/51-plan.md',
          format: 'markdown'
        }),
        readPlanDocument: () => '# Approved Technical Plan for Issue 51',
        generatePlan: () => ({
          planPath: '/repo/artifacts/plans/51-plan.md',
          mirrorPath: '/repo/artifacts/plans/51-plan.md',
          content: '# Approved Technical Plan for Issue 51',
          created: true
        })
      } as any as PlanGeneratorPort;

      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        mockPlanGen
      );

      const result = await useCase.execute({
        workspaceDir: '/repo',
        issue: 51
      });

      assert.strictEqual(result.currentStage, STAGE_PLAN);
      assert.strictEqual(result.nextStage, STAGE_APPROVAL);
      assert.strictEqual(result.actionType, 'human_gate');
      assert.ok(result.humanSummary.includes('Present the plan to the user'));

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 51);
      assert.strictEqual(saved?.currentStage, STAGE_PLAN);
    });

    test('initializes and returns DISCOVERY subagent directive when --issue is provided to INITIALIZED state with null issue', async () => {
      const sm = StateMachine.createInitial(); // issue is null
      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

      const result = await useCase.execute({
        workspaceDir: '/repo',
        issue: 51
      });

      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.nextStage, STAGE_PLAN);
      assert.strictEqual(result.actionType, 'subagent');

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 51);
      assert.strictEqual(saved?.currentStage, STAGE_DISCOVERY);
    });
  });

  describe('GetNextActionUseCase Context Auto-Inference', () => {
    test('auto-infers issue context from worktree cwd when state.issue is null', async () => {
      const sm = StateMachine.createInitial();
      sm.transition(STAGE_DISCOVERY);
      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

      const result = await useCase.execute({
        workspaceDir: '/repo/.worktrees/51'
      });

      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.ok(result.invocationPayload);
      assert.ok(result.invocationPayload.Subagents[0].Prompt.includes('#51'));

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 51);
    });

    test('auto-infers issue context from active task branch via WorktreeManager', async () => {
      const sm = StateMachine.createInitial();
      sm.transition(STAGE_DISCOVERY);
      const stateRepo = new MockStateRepo(sm.toSnapshot());

      const mockWorktreeManager: WorktreeManagerPort = {
        resolveBaseBranch: async () => 'task/51-feature-branch',
        resolveTaskWorktreePath: async () => '/repo/.worktrees/51',
        resolveTaskBranchName: () => 'task/51',
        createWorktree: async () => ({} as any),
        removeWorktree: async () => {},
        ensureGitIgnore: async () => true
      } as any as WorktreeManagerPort;

      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        undefined,
        undefined,
        undefined,
        mockWorktreeManager
      );

      const result = await useCase.execute({ workspaceDir: '/repo' });
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.ok(result.invocationPayload);
      assert.ok(result.invocationPayload.Subagents[0].Prompt.includes('#51'));

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 51);
    });
  });

  describe('RunPreFlightCheckUseCase Auto-Inference', () => {
    test('auto-infers issue from worktree path and persists back to stateRepo', async () => {
      const sm = StateMachine.createInitial(); // issue is null
      const stateRepo = new MockStateRepo(sm.toSnapshot());

      const preflight = new RunPreFlightCheckUseCase(
        undefined,
        undefined,
        stateRepo
      );

      const result = await preflight.execute({
        workspaceDir: '/repo/.worktrees/51'
      });

      assert.ok(result.message.includes('51'));
      assert.strictEqual(result.canProceed, true);

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 51);
    });

    test('auto-infers issue from active branch when cwd has no worktree pattern', async () => {
      const sm = StateMachine.createInitial();
      const stateRepo = new MockStateRepo(sm.toSnapshot());

      const mockWorktreeManager: WorktreeManagerPort = {
        resolveBaseBranch: async () => 'fix/42-fix-timeout',
        resolveTaskWorktreePath: async () => '/repo/.worktrees/42',
        resolveTaskBranchName: () => 'task/42',
        createWorktree: async () => ({} as any),
        removeWorktree: async () => {},
        ensureGitIgnore: async () => true
      } as any as WorktreeManagerPort;

      const preflight = new RunPreFlightCheckUseCase(
        undefined,
        mockWorktreeManager,
        stateRepo
      );

      const result = await preflight.execute({
        workspaceDir: '/repo'
      });

      assert.ok(result.message.includes('42'));
      assert.strictEqual(result.canProceed, true);

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.issue, 42);
    });
  });
});

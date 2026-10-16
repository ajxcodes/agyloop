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
  STAGE_TRIAGE,
  GATE_TRIAGE,
  ROLE_PLANNER,
  ROLE_DISCOVERY,
  ROLE_TRIAGE,
  NOTE_RESTARTED_FROM_COMPLETED
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

  describe('GetNextActionUseCase Read-Path Write Contract (issue #237)', () => {
    const NOW = new Date().toISOString();

    /**
     * A COMPLETED checkpoint carrying everything a destructive `reset()` would
     * destroy: planDir, worktree, milestoneTitle, baseBranch, counters.
     */
    function seedCompleted(overrides: Record<string, unknown> = {}): StateMachineSnapshot {
      const history = Object.freeze([
        'INITIALIZED',
        'DISCOVERY',
        'PLAN',
        'APPROVAL',
        'IMPLEMENT',
        'QUALITY_GATE',
        'REVIEW',
        'COMMIT',
        'COMPLETED'
      ].map((stage) => ({ stage, timestamp: NOW })));
      return {
        version: '1.0.0',
        currentStage: STAGE_COMPLETED,
        mode: 'standard',
        issue: 40,
        milestoneTitle: 'Phase 6',
        baseBranch: 'phase/6',
        worktree: {
          taskId: '40',
          worktreePath: '/repo/.worktrees/40',
          branch: 'task/40-work',
          baseBranch: 'phase/6',
          createdAt: NOW
        },
        planDir: 'artifacts/plans/40-done',
        triagePayload: null,
        createdAt: NOW,
        updatedAt: NOW,
        history,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 123000,
        planRevisionCount: 2,
        ...overrides
      } as unknown as StateMachineSnapshot;
    }

    /** A plan generator that resolves a plan document — the old Defect-2 trigger. */
    const resolvingPlanGen: PlanGeneratorPort = {
      resolvePlanFile: () => ({
        planDir: '/repo/artifacts/plans/40-done',
        planFileName: 'implementation-plan.md',
        planPath: '/repo/artifacts/plans/40-done/implementation-plan.md',
        format: 'markdown'
      }),
      readPlanDocument: () => '# Approved Technical Plan for Issue 40',
      generatePlan: () => ({
        planPath: '/repo/artifacts/plans/40-done/implementation-plan.md',
        mirrorPath: '/repo/artifacts/plans/40-done/implementation-plan.md',
        content: '# Approved Technical Plan for Issue 40',
        created: true
      })
    } as any as PlanGeneratorPort;

    /** A gateway with an OPEN PR carrying CHANGES_REQUESTED review feedback. */
    function gatewayWithFeedback(): any {
      return {
        getCurrentRepo: () => 'owner/repo',
        fetchIssue: async () => null,
        findPullRequest: async () => ({
          number: 7,
          title: 'Task #40',
          state: 'OPEN',
          baseRefName: 'phase/6',
          headRefName: 'task/40-work',
          url: 'https://example.invalid/pr/7',
          merged: false,
          labels: []
        }),
        fetchPullRequestComments: async () => [
          { author: 'r', body: 'fix the nil dereference', state: 'CHANGES_REQUESTED' }
        ]
      };
    }

    /** An OPEN PR whose review comments list is empty (no feedback to act on). */
    function gatewayWithoutFeedback(): any {
      return {
        getCurrentRepo: () => 'owner/repo',
        fetchIssue: async () => null,
        findPullRequest: async () => ({
          number: 7,
          title: 'Task #40',
          state: 'OPEN',
          baseRefName: 'phase/6',
          headRefName: 'task/40-work',
          url: 'https://example.invalid/pr/7',
          merged: false,
          labels: []
        }),
        fetchPullRequestComments: async () => []
      };
    }

    /** Asserts every persisted field of the seed survived the query untouched. */
    function assertUnchanged(saved: StateMachineSnapshot | null, seed: StateMachineSnapshot): void {
      assert.ok(saved, 'a snapshot must still be persisted');
      assert.strictEqual(saved!.currentStage, seed.currentStage);
      assert.strictEqual(saved!.issue, seed.issue);
      assert.strictEqual(saved!.mode, seed.mode);
      assert.strictEqual(saved!.planDir, seed.planDir);
      assert.strictEqual(saved!.baseBranch, seed.baseBranch);
      assert.strictEqual(saved!.milestoneTitle, seed.milestoneTitle);
      assert.deepStrictEqual(saved!.worktree, seed.worktree);
      assert.strictEqual(saved!.history.length, seed.history.length);
      assert.strictEqual(saved!.planRevisionCount, seed.planRevisionCount);
      assert.strictEqual(saved!.totalHumanWaitMs, seed.totalHumanWaitMs);
      assert.strictEqual(saved!.pausedAtGate, seed.pausedAtGate);
    }

    test('next --issue <n> on COMPLETED is non-destructive even when a plan document exists', async () => {
      const seed = seedCompleted();
      const stateRepo = new MockStateRepo(seed);
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), resolvingPlanGen);

      const result = await useCase.execute({ workspaceDir: '/repo', issue: 51 });

      assert.strictEqual(result.actionType, 'completed');
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
      // The summary must tell the operator how to start a new iteration.
      assert.match(result.humanSummary, /--restart/);

      // Every persisted field must equal the seed: no reset, no stage advance,
      // no forbidden { PLAN, planDir: null } snapshot.
      assertUnchanged(await stateRepo.load(), seed);
    });

    test('plain next from inside a worktree never destroys a task-scoped COMPLETED checkpoint with issue: null', async () => {
      // No worktree descriptor, so the issue is genuinely unresolvable from state
      // and must be inferred from the cwd — the exact shape that used to trip the
      // destructive `reset()` branch.
      const seed = seedCompleted({ issue: null, worktree: null });
      const stateRepo = new MockStateRepo(seed);
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), resolvingPlanGen);

      const result = await useCase.execute({ workspaceDir: '/repo/.worktrees/51' });

      assert.strictEqual(result.actionType, 'completed');
      const saved = await stateRepo.load();
      // `issue` is the one field the query path is always permitted to write.
      assert.strictEqual(saved?.issue, 51);
      assert.strictEqual(saved?.currentStage, STAGE_COMPLETED);
      assert.strictEqual(saved?.planDir, seed.planDir);
      assert.strictEqual(saved?.history.length, seed.history.length);
      assert.strictEqual(saved?.planRevisionCount, 2);
      assert.strictEqual(saved?.totalHumanWaitMs, 123000);
    });

    test('--restart re-opens at DISCOVERY and never PLAN', async () => {
      const seed = seedCompleted();
      const stateRepo = new MockStateRepo(seed);
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), resolvingPlanGen);

      const result = await useCase.execute({ workspaceDir: '/repo', issue: 51, restart: true });

      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(result.actionType, 'subagent');
      assert.strictEqual(result.role, ROLE_DISCOVERY);

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.currentStage, STAGE_DISCOVERY);
      // A fresh reset seeds INITIALIZED then DISCOVERY: exactly two entries.
      assert.strictEqual(saved?.history.length, 2);
      assert.ok(
        !saved?.history.some((h: any) => h.stage === STAGE_PLAN),
        'R1 forbids PLAN without evidence or opt-in, so no restart may land there'
      );
      assert.strictEqual(saved?.planDir, null);
      const last = saved?.history[saved.history.length - 1];
      assert.strictEqual((last as any)?.metadata?.note, NOTE_RESTARTED_FROM_COMPLETED);
    });

    test('--restart yields to open review feedback', async () => {
      const seed = seedCompleted();
      const stateRepo = new MockStateRepo(seed);
      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        undefined,
        gatewayWithFeedback()
      );

      const result = await useCase.execute({ workspaceDir: '/repo', issue: 51, restart: true });

      assert.strictEqual(result.currentStage, STAGE_TRIAGE);
      assert.strictEqual(result.actionType, 'subagent');
      assert.strictEqual(result.role, ROLE_TRIAGE);

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.currentStage, STAGE_TRIAGE);
      assert.strictEqual(saved?.pausedAtGate, GATE_TRIAGE);
      assert.ok(saved?.triagePayload?.includes('fix the nil dereference'));
      // R4 beats R5: the checkpoint is routed, never destroyed.
      assert.strictEqual(saved?.planDir, seed.planDir);
      assert.strictEqual(saved?.history.length, seed.history.length + 1);
      assert.strictEqual(saved?.planRevisionCount, 2);
      assert.strictEqual(saved?.totalHumanWaitMs, 123000);
    });

    test('next on COMPLETED with open PR review comments routes to TRIAGE without a restart', async () => {
      const seed = seedCompleted();
      const stateRepo = new MockStateRepo(seed);
      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        undefined,
        gatewayWithFeedback()
      );

      const result = await useCase.execute({ workspaceDir: '/repo', issue: 51 });

      assert.strictEqual(result.currentStage, STAGE_TRIAGE);
      assert.strictEqual(result.actionType, 'subagent');
      assert.strictEqual(result.role, ROLE_TRIAGE);

      const saved = await stateRepo.load();
      assert.strictEqual(saved?.currentStage, STAGE_TRIAGE);
      assert.strictEqual(saved?.pausedAtGate, GATE_TRIAGE);
      assert.ok(saved?.triagePayload?.includes('fix the nil dereference'));
      // reset() semantics never applied: planDir, counters and history all survive.
      assert.strictEqual(saved?.planDir, seed.planDir);
      assert.strictEqual(saved?.planRevisionCount, 2);
      assert.strictEqual(saved?.totalHumanWaitMs, 123000);
      assert.strictEqual(saved?.history.length, seed.history.length + 1);
    });

    test('offline next on COMPLETED is non-destructive even with a githubGateway injected', async () => {
      const seed = seedCompleted();
      const stateRepo = new MockStateRepo(seed);
      const offlineGateway: any = {
        getCurrentRepo: () => 'owner/repo',
        fetchIssue: async () => null,
        findPullRequest: async () => {
          throw new Error('gh: could not connect to github.com');
        },
        fetchPullRequestComments: async () => []
      };
      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        resolvingPlanGen,
        offlineGateway
      );

      const result = await useCase.execute({ workspaceDir: '/repo', issue: 51 });

      // detectOpenReviewFeedback fails closed, so the idle report stands.
      assert.strictEqual(result.actionType, 'completed');
      assert.strictEqual(result.currentStage, STAGE_COMPLETED);
      assertUnchanged(await stateRepo.load(), seed);
    });

    test('an OPEN PR with no review comments does not authorise any mutation', async () => {
      const seed = seedCompleted();
      const stateRepo = new MockStateRepo(seed);
      const useCase = new GetNextActionUseCase(
        stateRepo,
        makeMockConfig(),
        resolvingPlanGen,
        gatewayWithoutFeedback()
      );

      const result = await useCase.execute({ workspaceDir: '/repo', issue: 51, restart: true });

      // `--restart` is honoured here: feedback is what outranks it, not silence.
      assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
      const saved = await stateRepo.load();
      assert.strictEqual(saved?.currentStage, STAGE_DISCOVERY);
      assert.strictEqual(saved?.history.length, 2);
    });

    test('no GetNextActionUseCase path can persist { currentStage: PLAN, planDir: null }', async () => {
      for (const baseStage of [STAGE_COMPLETED, STAGE_INITIALIZED]) {
        for (const planGen of [resolvingPlanGen, undefined]) {
          for (const restart of [false, true]) {
            for (const gateway of [undefined, gatewayWithFeedback(), gatewayWithoutFeedback()]) {
              const seed = seedCompleted({ currentStage: baseStage, issue: 51 });
              const stateRepo = new MockStateRepo(seed);
              const useCase = new GetNextActionUseCase(
                stateRepo,
                makeMockConfig(),
                planGen,
                gateway as any
              );
              await useCase.execute({ workspaceDir: '/repo', issue: 51, restart });
              const saved = await stateRepo.load();
              const forbidden = saved?.currentStage === STAGE_PLAN && saved?.planDir == null;
              assert.strictEqual(
                forbidden,
                false,
                `forbidden snapshot from ${baseStage} + planGen=${Boolean(planGen)} + restart=${restart} + gateway=${Boolean(gateway)}`
              );
            }
          }
        }
      }
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

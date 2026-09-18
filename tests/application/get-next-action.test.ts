/**
 * agyloop - GetNextActionUseCase Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { GetNextActionUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_STANDARD,
  MODE_YOLO,
  WorktreeDescriptor,
  ROLE_TITLE_PLANNER,
  ROLE_TITLE_IMPLEMENTER,
  ROLE_TITLE_GATE,
  ROLE_TITLE_REVIEWER
} = require('../../dist/domain');

import type {
  StateRepository,
  ConfigRepository,
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

describe('GetNextActionUseCase Directives & Invocation Payloads', () => {
  test('returns preflight action for STAGE_INITIALIZED', async () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_INITIALIZED);
    assert.strictEqual(result.nextStage, STAGE_DISCOVERY);
    assert.strictEqual(result.actionType, 'preflight');
    assert.ok(result.humanSummary.includes('bin/agyloop transition DISCOVERY --issue 41'));
  });

  test('returns planning subagent payload for STAGE_DISCOVERY', async () => {
    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
    sm.transition(STAGE_DISCOVERY);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.nextStage, STAGE_PLAN);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'planner');
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.invocationPayload.Subagents.length, 1);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'research');
    assert.strictEqual(sub.Role, ROLE_TITLE_PLANNER);
    assert.strictEqual(sub.Model, 'pro');
    assert.strictEqual(sub.Workspace, 'share');
  });

  test('returns human approval gate for STAGE_PLAN in standard mode', async () => {
    const sm = StateMachine.createInitial({ issue: 41, mode: MODE_STANDARD });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_PLAN);
    assert.strictEqual(result.nextStage, STAGE_APPROVAL);
    assert.strictEqual(result.actionType, 'human_gate');
    assert.ok(result.humanSummary.includes('wait for approval'));
  });

  test('auto-advances to implement subagent for STAGE_PLAN in yolo mode', async () => {
    const sm = StateMachine.createInitial({ issue: 41, mode: MODE_YOLO });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_PLAN);
    assert.strictEqual(result.nextStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
    assert.ok(result.invocationPayload);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'self');
    assert.strictEqual(sub.Role, ROLE_TITLE_IMPLEMENTER);
    assert.strictEqual(sub.Model, 'inherit');
  });

  test('returns human approval gate for STAGE_APPROVAL in standard mode', async () => {
    const sm = StateMachine.createInitial({ issue: 41, mode: MODE_STANDARD });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 41,
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41-work',
        baseBranch: 'phase/1-bridge',
        createdAt: new Date().toISOString()
      })
    );

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_APPROVAL);
    assert.strictEqual(result.nextStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.actionType, 'human_gate');
    assert.ok(result.humanSummary.includes('wait for approval'));
  });

  test('returns implementer subagent payload for STAGE_IMPLEMENT', async () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 41,
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41-work',
        baseBranch: 'phase/1-bridge',
        createdAt: new Date().toISOString()
      })
    );

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.nextStage, STAGE_QUALITY_GATE);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
    assert.ok(result.invocationPayload);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'self');
    assert.strictEqual(sub.Role, ROLE_TITLE_IMPLEMENTER);
    assert.ok(sub.Prompt.includes('/repo/.worktrees/41'));
    assert.strictEqual(sub.Prompt.includes('Approved Technical Plan'), false);
  });

  test('returns gate subagent payload for STAGE_QUALITY_GATE', async () => {
    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 41,
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41-work',
        baseBranch: 'phase/1-bridge',
        createdAt: new Date().toISOString()
      })
    );

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_QUALITY_GATE);
    assert.strictEqual(result.nextStage, STAGE_REVIEW);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'gate');
    assert.ok(result.invocationPayload);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'self');
    assert.strictEqual(sub.Role, ROLE_TITLE_GATE);
    assert.strictEqual(sub.Model, 'flash_lite');
    assert.ok(sub.Prompt.includes('/repo/.worktrees/41'));
  });

  test('returns reviewer subagent payload for STAGE_REVIEW', async () => {
    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 41,
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41-work',
        baseBranch: 'phase/1-bridge',
        createdAt: new Date().toISOString()
      })
    );

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_REVIEW);
    assert.strictEqual(result.nextStage, STAGE_COMMIT);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'reviewer');
    assert.ok(result.invocationPayload);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'research');
    assert.strictEqual(sub.Role, ROLE_TITLE_REVIEWER);
    assert.strictEqual(sub.Model, 'flash');
    assert.ok(sub.Prompt.includes('phase/1-bridge'));
    assert.ok(sub.Prompt.includes('/repo/.worktrees/41'));
  });

  test('returns commit human gate for STAGE_COMMIT', async () => {
    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(result.nextStage, STAGE_COMPLETED);
    assert.strictEqual(result.actionType, 'human_gate');
    assert.ok(result.humanSummary.includes('agyloop commit'));
  });

  test('returns completed action for STAGE_COMPLETED', async () => {
    const sm = StateMachine.createInitial({ issue: 41 });
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

    const completedResult = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(completedResult.currentStage, STAGE_COMPLETED);
    assert.strictEqual(completedResult.nextStage, STAGE_INITIALIZED);
    assert.strictEqual(completedResult.actionType, 'completed');
  });

  test('populates issue context and omits blank plan block for STAGE_IMPLEMENT when githubGateway is configured', async () => {
    const sm = StateMachine.createInitial({ issue: 85 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 85,
        worktreePath: '/repo/.worktrees/85',
        branch: 'fix/85',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );

    const mockGithub: any = {
      getCurrentRepo: () => 'ajxcodes/agyloop',
      fetchIssue: (num: number) => ({
        repo: 'ajxcodes/agyloop',
        number: num,
        title: 'Fix prompt issue context and blank plan spec',
        body: 'Detailed issue description for issue 85.',
        labels: ['bug'],
        comments: [],
        state: 'OPEN'
      })
    };

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      mockGithub
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.ok(result.invocationPayload);
    const sub = result.invocationPayload.Subagents[0];
    assert.ok(sub.Prompt.includes('Active Issue: #85 - Fix prompt issue context and blank plan spec'));
    assert.ok(sub.Prompt.includes('Detailed issue description for issue 85.'));
    assert.strictEqual(sub.Prompt.includes('Approved Technical Plan'), false);
  });

  test('populates issue context for STAGE_REVIEW when githubGateway is configured', async () => {
    const sm = StateMachine.createInitial({ issue: 85, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 85,
        worktreePath: '/repo/.worktrees/85',
        branch: 'fix/85',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );

    const mockGithub: any = {
      getCurrentRepo: () => 'ajxcodes/agyloop',
      fetchIssue: (num: number) => ({
        repo: 'ajxcodes/agyloop',
        number: num,
        title: 'Fix prompt issue context and blank plan spec',
        body: 'Detailed issue description for issue 85.',
        labels: ['bug'],
        comments: [],
        state: 'OPEN'
      })
    };

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      mockGithub
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_REVIEW);
    assert.ok(result.invocationPayload);
    const sub = result.invocationPayload.Subagents[0];
    assert.ok(sub.Prompt.includes('Active Issue: #85 - Fix prompt issue context and blank plan spec'));
    assert.ok(sub.Prompt.includes('Detailed issue description for issue 85.'));
  });
});

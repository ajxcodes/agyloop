/**
 * agyloop - GetNextActionUseCase Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { GetNextActionUseCase, InferBaseBranchUseCase } = require('../../dist/application');
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
  STAGE_TRIAGE,
  MODE_STANDARD,
  MODE_YOLO,
  WorktreeDescriptor,
  ROLE_TITLE_PLANNER,
  ROLE_TITLE_IMPLEMENTER,
  ROLE_TITLE_GATE,
  ROLE_TITLE_REVIEWER,
  Ecosystem,
  ECOSYSTEM_NODE,
  ANTI_INCEPTION_GUARDRAIL
} = require('../../dist/domain');

import type {
  StateRepository,
  ConfigRepository,
  AgyLoopConfig,
  BuildDetectorPort,
  DetectedProject
} from '../../src/ports';
import type { StateMachineSnapshot, GateCommandDefinition } from '../../src/domain';

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

class MockBuildDetector implements BuildDetectorPort {
  private readonly commands: readonly GateCommandDefinition[];
  public lintCommand: string | null = null;

  constructor(commands: readonly GateCommandDefinition[] = []) {
    this.commands = commands;
  }

  async detect(workspaceDir: string): Promise<DetectedProject> {
    return {
      workspaceDir,
      ecosystems: [],
      primaryEcosystem: new Ecosystem({ type: ECOSYSTEM_NODE, markerFiles: ['package.json'], packageManager: 'npm' }),
      commands: this.commands,
      hasOverrides: false
    };
  }

  async resolveCommands(): Promise<readonly GateCommandDefinition[]> {
    return this.commands;
  }

  async resolveCommandPlan(
    workspaceDir: string,
    _config?: AgyLoopConfig,
    options?: import('../../src/ports').GateCommandResolutionOptions
  ): Promise<import('../../src/domain').GateCommandPlan> {
    const planTargets = options?.planTargets ?? [];
    const planPath = options?.planPath ?? null;
    const appended: string[] = [];

    const applyLint = (defs: GateCommandDefinition[]): GateCommandDefinition[] => {
      if (this.lintCommand === null) return defs;
      const hasLint = defs.some((def) => def.command.split(/\s+/).includes('lint'));
      if (hasLint) return defs;
      appended.push(this.lintCommand);
      return [...defs, { id: 'lint', label: 'Lint (npm)', command: this.lintCommand }];
    };

    if (planTargets.length > 0) {
      return {
        commands: applyLint(
          planTargets.map((command, idx) => ({
            id: `plan-${idx + 1}`,
            label: `Plan Target ${idx + 1}`,
            command
          }))
        ),
        source: 'plan',
        sourceDetail: planPath ? `plan ${planPath}` : 'plan targets',
        appended,
        lintRequired: this.lintCommand !== null,
        lintCommand: this.lintCommand,
        planPath
      };
    }
    return {
      commands: applyLint([...this.commands]),
      source: 'auto-detect',
      sourceDetail: `auto-detected from ${workspaceDir}`,
      appended,
      lintRequired: this.lintCommand !== null,
      lintCommand: this.lintCommand,
      planPath
    };
  }
}

class MockPlanGenerator {
  public content = '';
  public digest: string | null = null;
  public planPath = '/repo/artifacts/plans/41-task/implementation_plan.md';

  public resolvePlanFile(): any {
    return {
      planDir: '/repo/artifacts/plans/41-task',
      planPath: this.planPath,
      planFileName: 'implementation_plan.md'
    };
  }
  public readPlanDocument(): string {
    return this.content;
  }
  public hashPlanDocument(): string | null {
    return this.digest;
  }
  public scaffoldPlanDirectory(): any {
    return { planDir: '/repo/artifacts/plans/41-task', folderName: '41-task', type: 'implementation', planPath: this.planPath, mirrorPath: this.planPath, summaryPath: '', directoryCreated: false, filesCreated: false, adoptedExisting: true };
  }
  public generatePlan(): any {
    return { planPath: '', mirrorPath: null, content: '', mirrorContent: null, created: false, mirrorCreated: false };
  }
  public generateSummaryLog(): any {
    return { summaryPath: '', content: '', created: false };
  }
  public updateSummaryLog(): boolean {
    return true;
  }
  public findPlanDirectory(): string | null {
    return '/repo/artifacts/plans/41-task';
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

  test('returns discovery subagent payload for STAGE_DISCOVERY', async () => {
    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'phase/1-bridge' });
    sm.transition(STAGE_DISCOVERY);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_DISCOVERY);
    assert.strictEqual(result.nextStage, STAGE_PLAN);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'discovery');
    assert.ok(result.invocationPayload);
    assert.strictEqual(result.invocationPayload.Subagents.length, 1);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'self');
    assert.strictEqual(sub.Role, 'Discovery Subagent');
    assert.strictEqual(sub.Model, 'inherit');
    assert.strictEqual(sub.Workspace, 'inherit');
    assert.ok(result.description.includes('smoke testing'));
    assert.ok(result.humanSummary.includes('scoped write tools'));
  });

  test('returns planning subagent payload for STAGE_PLAN in standard mode', async () => {
    const sm = StateMachine.createInitial({ issue: 41, mode: MODE_STANDARD });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_PLAN);
    assert.strictEqual(result.nextStage, STAGE_APPROVAL);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'planner');
    assert.ok(result.humanSummary.includes('scoped write tools'));
  });

  test('returns planning subagent payload for STAGE_PLAN in yolo mode', async () => {
    const sm = StateMachine.createInitial({ issue: 41, mode: MODE_YOLO });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.setWorktree(new WorktreeDescriptor({ taskId: '41', worktreePath: '/repo/.worktrees/41', branch: 'task/41', baseBranch: 'main' }));
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_PLAN);
    assert.strictEqual(result.nextStage, STAGE_APPROVAL);
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'planner');
    assert.ok(result.invocationPayload);

    const sub = result.invocationPayload.Subagents[0];
    assert.strictEqual(sub.TypeName, 'self');
    assert.strictEqual(sub.Role, ROLE_TITLE_PLANNER);
    assert.strictEqual(sub.Model, 'pro');
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

  test('implement action root check uses the shared root-invariant predicate (#247, resolve-normalized)', async () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 41,
        worktreePath: '/repo/.',
        branch: 'task/41-work',
        baseBranch: 'phase/1-bridge'
      })
    );

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    // '/repo/.' resolves onto the workspace root ('/repo'), so the shared
    // predicate — not a raw `===` compare — must reject it.
    await assert.rejects(
      async () => {
        await useCase.execute({ workspaceDir: '/repo' });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("Zero Direct Root Mutation invariant violated"),
          `unexpected message: ${(err as Error).message}`
        );
        assert.ok(
          (err as Error).message.includes("root workspace '/repo'"),
          'the resolve-normalized root (not the raw variant) is named in the message'
        );
        return true;
      }
    );

    // A distinct, non-root path passes the same predicate (no over-restriction).
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 41,
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41-work',
        baseBranch: 'phase/1-bridge'
      })
    );
    stateRepo.savedSnapshot = sm.toSnapshot();

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'implementer');
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

    // Issue #284: the directive NAMES the evidence channel, exactly as the
    // REVIEW directive names the verdict channel (#272's lesson: a channel
    // nobody is told about is a channel that never gets used).
    assert.ok(
      result.description.includes('codeloop gate-report'),
      `the QUALITY_GATE description must name the evidence channel, got: ${result.description}`
    );
    assert.ok(
      result.humanSummary.includes('codeloop gate-report'),
      `the QUALITY_GATE summary must name the evidence channel, got: ${result.humanSummary}`
    );
  });

  test('returns gate subagent payload with resolved verification commands for STAGE_QUALITY_GATE', async () => {
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
    const mockBuildDetector = new MockBuildDetector([
      { id: 'test', command: 'npm test', label: 'Run test suite' },
      { id: 'typecheck', command: 'npx tsc --noEmit', label: 'TypeScript check' }
    ]);
    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      mockBuildDetector
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_QUALITY_GATE);
    assert.ok(result.invocationPayload);

    const sub = result.invocationPayload.Subagents[0];
    assert.ok(sub.Prompt.includes('Target Verification Commands:'));
    assert.ok(sub.Prompt.includes('1. `npm test`'));
    assert.ok(sub.Prompt.includes('2. `npx tsc --noEmit`'));
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
    assert.strictEqual(sub.TypeName, 'self');
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

  test('infers baseBranch when missing and activeIssue is present with worktreeManager', async () => {
    const sm = StateMachine.createInitial({ issue: 93 });
    sm.transition(STAGE_DISCOVERY);
    assert.strictEqual(sm.baseBranch, null);

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const mockWorktreeManager: any = {
      resolveBaseBranch: async () => 'main',
      listBranches: async () => ['main', 'phase/5-quality-gates'],
      isAncestorMerged: async () => false
    };
    const mockGithub: any = {
      getCurrentRepo: () => 'ajxcodes/agyloop',
      fetchIssue: (num: number) => ({
        repo: 'ajxcodes/agyloop',
        number: num,
        title: '[Phase 5] [Bug] agyloop: GetNextAction reports baseBranch as main',
        body: 'Details here',
        labels: ['phase:5', 'bug'],
        comments: [],
        state: 'OPEN'
      })
    };

    const inferUseCase = new InferBaseBranchUseCase(
      mockWorktreeManager,
      mockGithub,
      stateRepo
    );

    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      mockGithub,
      undefined,
      mockWorktreeManager,
      undefined,
      inferUseCase
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.baseBranch, 'phase/5-quality-gates');
    assert.strictEqual(stateRepo.savedSnapshot?.baseBranch, 'phase/5-quality-gates');
  });

  test('does not infer baseBranch when inferBaseBranchUseCase is not injected even if worktreeManager is provided', async () => {
    const sm = StateMachine.createInitial({ issue: 93 });
    sm.transition(STAGE_DISCOVERY);

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const mockWorktreeManager: any = {
      resolveBaseBranch: async () => 'main',
      listBranches: async () => ['main', 'phase/5-quality-gates'],
      isAncestorMerged: async () => false
    };
    const mockGithub: any = {
      getCurrentRepo: () => 'ajxcodes/agyloop',
      fetchIssue: (num: number) => ({
        repo: 'ajxcodes/agyloop',
        number: num,
        title: '[Phase 5] [Bug] agyloop: GetNextAction reports baseBranch as main',
        body: 'Details here',
        labels: ['phase:5', 'bug'],
        comments: [],
        state: 'OPEN'
      })
    };

    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      mockGithub,
      undefined,
      mockWorktreeManager
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.baseBranch, 'main');
    assert.strictEqual(stateRepo.savedSnapshot?.baseBranch, null);
  });

  test('handles inferBaseBranch failure non-fatally with warning', async () => {
    const sm = StateMachine.createInitial({ issue: 93 });
    sm.transition(STAGE_DISCOVERY);

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const mockInferUseCase: any = {
      execute: async () => {
        throw new Error('Network failure or git corruption');
      }
    };

    const useCase = new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockInferUseCase
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.baseBranch, 'main');
    assert.strictEqual(stateRepo.savedSnapshot?.baseBranch, null);
  });

  test('embeds PR review comments in STAGE_TRIAGE subagent prompt', async () => {
    const sm = StateMachine.createInitial({ issue: 190 });
    sm.transition(STAGE_TRIAGE);
    sm.setTriagePayload('Reviewer: Please fix the magic constants in resolve-subagent.ts');

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_TRIAGE);
    assert.ok(result.invocationPayload);
    
    const sub = result.invocationPayload.Subagents[0];
    assert.ok(sub.Prompt.includes('Reviewer: Please fix the magic constants'));
  });

  test('embeds PR review comments in STAGE_IMPLEMENT subagent prompt', async () => {
    const sm = StateMachine.createInitial({ issue: 190 });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.setTriagePayload('Reviewer: Consider using a map instead of a switch statement');
    sm.setWorktree(
      WorktreeDescriptor.create({
        taskId: 190,
        worktreePath: '/repo/.worktrees/190',
        branch: 'fix/190',
        baseBranch: 'main',
        createdAt: new Date().toISOString()
      })
    );

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
    assert.ok(result.invocationPayload);
    
    const sub = result.invocationPayload.Subagents[0];
    assert.ok(sub.Prompt.includes('Consider using a map'));
  });

  test('asserts every prompt payload emitted by GetNextActionUseCase contains the anti-inception guardrail across all stages', async () => {
    const stagesToTest = [
      STAGE_DISCOVERY,
      STAGE_PLAN,
      STAGE_IMPLEMENT,
      STAGE_QUALITY_GATE,
      STAGE_REVIEW,
      STAGE_TRIAGE
    ];

    for (const stage of stagesToTest) {
      const sm = StateMachine.createInitial({ issue: 203, mode: MODE_YOLO });
      if (stage === STAGE_DISCOVERY) {
        sm.transition(STAGE_DISCOVERY);
      } else if (stage === STAGE_PLAN) {
        sm.transition(STAGE_PLAN);
      } else if (stage === STAGE_IMPLEMENT) {
        sm.transition(STAGE_PLAN);
        sm.transition(STAGE_IMPLEMENT);
      } else if (stage === STAGE_QUALITY_GATE) {
        sm.transition(STAGE_PLAN);
        sm.transition(STAGE_IMPLEMENT);
        sm.transition(STAGE_QUALITY_GATE);
      } else if (stage === STAGE_REVIEW) {
        sm.transition(STAGE_PLAN);
        sm.transition(STAGE_IMPLEMENT);
        sm.transition(STAGE_QUALITY_GATE);
        sm.transition(STAGE_REVIEW);
      } else if (stage === STAGE_TRIAGE) {
        sm.transition(STAGE_TRIAGE);
      }

      if (stage === STAGE_IMPLEMENT || stage === STAGE_QUALITY_GATE || stage === STAGE_REVIEW) {
        sm.setWorktree(
          WorktreeDescriptor.create({
            taskId: 203,
            worktreePath: '/repo/.worktrees/203',
            branch: 'fix/203',
            baseBranch: 'main',
            createdAt: new Date().toISOString()
          })
        );
      }
      if (stage === STAGE_TRIAGE) {
        sm.setTriagePayload('Sample review comment');
      }

      const stateRepo = new MockStateRepo(sm.toSnapshot());
      const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

      const result = await useCase.execute({ workspaceDir: '/repo' });
      assert.ok(
        result.invocationPayload,
        `Expected invocationPayload for stage ${stage}`
      );
      for (const subagent of result.invocationPayload.Subagents) {
        assert.ok(
          subagent.Prompt.includes(ANTI_INCEPTION_GUARDRAIL),
          `Expected subagent prompt in stage ${stage} to contain anti-inception guardrail`
        );
      }
    }
  });
});



/**
 * Issue #266 (absorbs #287 B): a checkpoint at IMPLEMENT whose worktree
 * descriptor is null used to raise the Zero Direct Root Mutation invariant and
 * surface as a raw `Fatal:` + stack. It must instead return an actionable
 * directive — while a NON-NULL descriptor that resolves to the root keeps
 * raising (pinned by the #247 test above).
 */
describe('GetNextActionUseCase — missing worktree directive (#266)', () => {
  const NOW = '2026-10-24T00:00:00.000Z';

  function implementWithoutWorktree(): any {
    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    return sm;
  }

  test('E1 IMPLEMENT with a null worktree returns a re-provision directive (AC-10)', async () => {
    const sm = implementWithoutWorktree();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'human_gate');
    assert.strictEqual(result.title, 'Worktree Required');
    assert.ok(result.humanSummary.length > 0, 'the directive must be rendered');
    assert.ok(
      result.humanSummary.includes('codeloop implement --issue 41'),
      `the directive must name the recovery command:\n${result.humanSummary}`
    );
    assert.strictEqual(result.worktreePath, null);
    assert.strictEqual(result.nextStage, STAGE_IMPLEMENT, 'never advance into an unrunnable stage');
    assert.strictEqual(result.currentStage, STAGE_IMPLEMENT);
  });

  test('E2 the directive is stable across IMPLEMENT retries (AC-10)', async () => {
    const sm = implementWithoutWorktree();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const first = await useCase.execute({ workspaceDir: '/repo' });
    const second = await useCase.execute({ workspaceDir: '/repo' });

    for (const result of [first, second]) {
      assert.strictEqual(result.actionType, 'human_gate');
      assert.strictEqual(result.title, 'Worktree Required');
      assert.ok(result.humanSummary.includes('codeloop implement --issue 41'));
      assert.strictEqual(result.nextStage, STAGE_IMPLEMENT);
    }
  });

  test('E3 YOLO APPROVAL with a null worktree returns the same directive (AC-10)', async () => {
    const sm = StateMachine.createInitial({ issue: 41, mode: MODE_YOLO, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);

    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig());

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'human_gate');
    assert.strictEqual(result.currentStage, STAGE_APPROVAL);
    assert.ok(result.humanSummary.includes('codeloop implement --issue 41'));
  });

  test('E5 TRIAGE and COMMIT are unaffected by a null worktree (scope guard)', async () => {
    const triageSnapshot = {
      version: '1.0.0',
      currentStage: STAGE_TRIAGE,
      mode: MODE_STANDARD,
      issue: 41,
      baseBranch: 'main',
      worktree: null,
      createdAt: NOW,
      updatedAt: NOW,
      history: [{ stage: STAGE_TRIAGE, timestamp: NOW }]
    } as unknown;

    const triageRepo = new MockStateRepo(triageSnapshot as any);
    const triageUseCase = new GetNextActionUseCase(triageRepo, makeMockConfig());
    const triageResult = await triageUseCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(triageResult.currentStage, STAGE_TRIAGE);
    assert.strictEqual(triageResult.actionType, 'subagent');
    assert.strictEqual(triageResult.role, 'triage');

    const sm = StateMachine.createInitial({ issue: 41, baseBranch: 'main' });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);

    const commitRepo = new MockStateRepo(sm.toSnapshot());
    const commitUseCase = new GetNextActionUseCase(commitRepo, makeMockConfig());
    const commitResult = await commitUseCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(commitResult.actionType, 'human_gate');
    assert.ok(commitResult.humanSummary.includes('agyloop commit'));
  });
});

// ============================================================================
// Early-stage dispatch directives & blank-plan recovery (#292, #267)
// ============================================================================

describe('Discovery/Plan directives and blank-plan recovery (#292, #267)', () => {
  const { test: caseTest } = require('node:test');
  const { NOTE_DISCOVERY_ADVANCE_CONDITION, NOTE_PLAN_ADVANCE_CONDITION } = require('../../dist/domain');

  const DISCOVERY_PATH = '/repo/artifacts/plans/41-bug-probe/[Discovery] - Bug probe.md';
  const PLAN_PATH = '/repo/artifacts/plans/41-bug-probe/implementation_plan.md';

  const BLANK_PLAN = [
    '# [Implementation] - Bug probe',
    '',
    '## 1. Context & Objectives',
    '- **Feature Overview:**',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:**'
  ].join('\n');

  const REAL_PLAN = [
    '# [Implementation] - Bug probe',
    '',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** change `src/probe.ts` to return a value.'
  ].join('\n');

  function planGen(content: string): any {
    return {
      findPlanDirectory: () => '/repo/artifacts/plans/41-bug-probe',
      resolvePlanFile: (options: any) => ({
        planDir: '/repo/artifacts/plans/41-bug-probe',
        planPath: options?.stage === STAGE_DISCOVERY ? DISCOVERY_PATH : PLAN_PATH,
        planFileName: options?.stage === STAGE_DISCOVERY ? '[Discovery] - Bug probe.md' : 'implementation_plan.md'
      }),
      readPlanDocument: () => content
    };
  }

  function discoveryCheckpoint(): any {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY, { note: 'probe' });
    sm.setPlanDir('/repo/artifacts/plans/41-bug-probe');
    return sm;
  }

  function planCheckpoint(): any {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY, { note: 'probe' });
    sm.setPlanDir('/repo/artifacts/plans/41-bug-probe');
    sm.transition(STAGE_PLAN, { note: 'probe' });
    return sm;
  }

  function implementCheckpoint(): any {
    const sm = planCheckpoint();
    sm.transition(STAGE_APPROVAL);
    sm.setWorktree(
      new WorktreeDescriptor({
        taskId: '41',
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41',
        baseBranch: 'main'
      })
    );
    sm.transition(STAGE_IMPLEMENT);
    return sm;
  }

  caseTest('T-292.1: the DISCOVERY directive names the condition, the command and the target', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), planGen(BLANK_PLAN));

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'discovery');
    assert.ok(result.description.includes('codeloop plan --issue 41'), result.description);
    assert.ok(result.description.includes(NOTE_DISCOVERY_ADVANCE_CONDITION), result.description);
    assert.ok(result.humanSummary.includes('codeloop plan --issue 41'), result.humanSummary);
    assert.ok(result.humanSummary.includes(NOTE_DISCOVERY_ADVANCE_CONDITION), result.humanSummary);
    assert.ok(result.invocationPayload!.Subagents[0].Prompt.includes(DISCOVERY_PATH));
  });

  caseTest('T-292.2: the PLAN directive names the condition, the command and the spec target', async () => {
    const stateRepo = new MockStateRepo(planCheckpoint().toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), planGen(REAL_PLAN));

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.role, 'planner');
    assert.ok(result.description.includes('codeloop transition APPROVAL --issue 41'), result.description);
    assert.ok(result.description.includes(NOTE_PLAN_ADVANCE_CONDITION), result.description);
    assert.ok(result.humanSummary.includes('codeloop transition APPROVAL --issue 41'), result.humanSummary);
    assert.ok(result.humanSummary.includes(NOTE_PLAN_ADVANCE_CONDITION), result.humanSummary);
    assert.ok(result.invocationPayload!.Subagents[0].Prompt.includes(PLAN_PATH));
    assert.match(result.description, /non-blank/);
  });

  caseTest('T-292.5: three reads at DISCOVERY name the command and record counts 1, 2, 3', async () => {
    const stateRepo = new MockStateRepo(discoveryCheckpoint().toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), planGen(BLANK_PLAN));

    for (let read = 1; read <= 3; read += 1) {
      const result = await useCase.execute({ workspaceDir: '/repo' });
      assert.ok(result.humanSummary.includes('codeloop plan --issue 41'));
      assert.strictEqual(result.discoveryDispatchCount, read);
      assert.strictEqual((stateRepo.savedSnapshot as any).discoveryDispatchCount, read);
    }
  });

  caseTest('T-292.5: three reads at PLAN record planDispatchCount 1, 2, 3', async () => {
    const stateRepo = new MockStateRepo(planCheckpoint().toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), planGen(REAL_PLAN));

    for (let read = 1; read <= 3; read += 1) {
      const result = await useCase.execute({ workspaceDir: '/repo' });
      assert.ok(result.humanSummary.includes('codeloop transition APPROVAL --issue 41'));
      assert.strictEqual(result.planDispatchCount, read);
      assert.strictEqual((stateRepo.savedSnapshot as any).planDispatchCount, read);
    }
  });

  caseTest('T-292.6: three reads never advance the stage or alter history', async () => {
    const sm = discoveryCheckpoint();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const useCase = new GetNextActionUseCase(stateRepo, makeMockConfig(), planGen(BLANK_PLAN));

    const beforeStage = stateRepo.savedSnapshot!.currentStage;
    const beforeHistory = JSON.stringify(stateRepo.savedSnapshot!.history);
    const beforeMode = stateRepo.savedSnapshot!.mode;
    const beforePlanDir = stateRepo.savedSnapshot!.planDir;

    for (let read = 0; read < 3; read += 1) {
      await useCase.execute({ workspaceDir: '/repo' });
    }

    assert.strictEqual(stateRepo.savedSnapshot!.currentStage, beforeStage);
    assert.strictEqual(JSON.stringify(stateRepo.savedSnapshot!.history), beforeHistory);
    assert.strictEqual(stateRepo.savedSnapshot!.mode, beforeMode);
    assert.strictEqual(stateRepo.savedSnapshot!.planDir, beforePlanDir);
    assert.strictEqual((stateRepo.savedSnapshot as any).discoveryDispatchCount, 3);
  });

  caseTest('T-267.A2: a blank plan at IMPLEMENT offers the PLANNER, a real plan the implementer', async () => {
    const blankRepo = new MockStateRepo(implementCheckpoint().toSnapshot());
    const blankResult = await new GetNextActionUseCase(
      blankRepo,
      makeMockConfig(),
      planGen(BLANK_PLAN)
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(blankResult.role, 'planner');
    assert.strictEqual(blankResult.nextStage, STAGE_PLAN);
    assert.strictEqual(blankResult.planBlank, true);
    assert.strictEqual(blankResult.currentStage, STAGE_IMPLEMENT);
    assert.ok(blankResult.humanSummary.includes('--plan-path'), blankResult.humanSummary);

    const realRepo = new MockStateRepo(implementCheckpoint().toSnapshot());
    const realResult = await new GetNextActionUseCase(
      realRepo,
      makeMockConfig(),
      planGen(REAL_PLAN)
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(realResult.role, 'implementer');
    assert.strictEqual(realResult.planBlank, false);
    assert.strictEqual(realResult.nextStage, STAGE_QUALITY_GATE);
  });
});

// ============================================================================
// Blank-plan directive reachability, supplied plan preference, guard order
// (review round 1: findings 1, 2, advisor on root guard/counter persistence)
// ============================================================================

describe('Blank-plan directive reachability & guard ordering (#267)', () => {
  const { test: caseTest } = require('node:test');

  const BLANK_PLAN = [
    '# [Implementation] - probe',
    '',
    '## 1. Context & Objectives',
    '- **Feature Overview:**',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:**'
  ].join('\n');

  const SUPPLIED_PLAN = [
    '# [Implementation] - supplied',
    '',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** SUPPLIED_PLAN_MARKER'
  ].join('\n');

  /** A generator that prefers the recorded planPath, like the real port. */
  function suppliedPlanGen(planPath: string): any {
    return {
      resolvePlanFile: (options: any) => ({
        planDir: options?.planDir ?? '/',
        planPath: options?.planPath ?? '/repo/README.md',
        planFileName: 'myplan.md'
      }),
      readPlanDocument: (path: string) => (path === planPath ? SUPPLIED_PLAN : BLANK_PLAN),
      readPlanPathCalls: [] as string[]
    };
  }

  function implementCheckpoint(planPath?: string | null): any {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.setWorktree(
      new WorktreeDescriptor({
        taskId: '41',
        worktreePath: '/repo/.worktrees/41',
        branch: 'task/41',
        baseBranch: 'main'
      })
    );
    sm.transition(STAGE_IMPLEMENT);
    if (planPath) sm.setPlanPath(planPath);
    return sm;
  }

  caseTest('finding 1: the IMPLEMENT blank-plan directive names only reachable commands', async () => {
    const sm = implementCheckpoint();
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    // This path reads back the BLANK document.
    const generator = suppliedPlanGen('/repo/blank-plan.md');
    const result = await new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      generator
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.role, 'planner');
    const text = `${result.description} ${result.humanSummary}`;
    // `IMPLEMENT -> APPROVAL` is rejected by the state machine.
    assert.doesNotMatch(text, /codeloop transition APPROVAL/);
    assert.match(text, /codeloop next/);

    // Every transition the directive DOES name must be legal from the stage the
    // operator is actually at.
    const targets = [...text.matchAll(/codeloop transition ([A-Z_]+)/g)].map((m) => m[1]);
    for (const target of targets) {
      assert.strictEqual(
        sm.canTransition(target),
        true,
        `the directive names 'transition ${target}', which is rejected from ${sm.currentStage}`
      );
    }
  });

  caseTest('finding 2: a recorded supplied plan wins over a blank sibling document', async () => {
    const suppliedPath = '/repo/myplan.md';
    const sm = implementCheckpoint(suppliedPath);
    const stateRepo = new MockStateRepo(sm.toSnapshot());
    const generator = suppliedPlanGen(suppliedPath);
    const result = await new GetNextActionUseCase(
      stateRepo,
      makeMockConfig(),
      generator
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.planBlank, false);
    assert.strictEqual(result.role, 'implementer');
    assert.ok(
      result.invocationPayload!.Subagents[0].Prompt.includes('/repo/myplan.md'),
      'the implementer prompt must name the supplied document'
    );
    assert.ok(result.humanSummary.includes('.worktrees/41'));
  });

  caseTest('advisory: a failed counter persist never fails the read-only query', async () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY);
    sm.setPlanDir('/repo/artifacts/plans/41-bug-probe');
    const stateRepo = {
      snapshot: sm.toSnapshot() as any,
      async load() {
        return this.snapshot;
      },
      async save() {
        throw new Error('StateStorageError: cross-worktree write refused');
      },
      async reset() {
        this.snapshot = null;
      },
      getStateFilePath() {
        return '/repo/.agyloop/tasks/41.json';
      }
    };

    const result = await new GetNextActionUseCase(
      stateRepo as any,
      makeMockConfig(),
      suppliedPlanGen('/repo/artifacts/plans/41-bug-probe/[Discovery] - probe.md')
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.discoveryDispatchCount, 1);
  });

  caseTest('advisory: a root-workspace descriptor still violates the invariant with a blank plan', async () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.setWorktree(
      new WorktreeDescriptor({
        taskId: '41',
        // The repo ROOT is never a legal task worktree.
        worktreePath: '/repo',
        branch: 'task/41',
        baseBranch: 'main'
      })
    );
    sm.transition(STAGE_IMPLEMENT);

    await assert.rejects(
      async () =>
        new GetNextActionUseCase(
          new MockStateRepo(sm.toSnapshot()),
          makeMockConfig(),
          suppliedPlanGen('/repo/README.md')
        ).execute({ workspaceDir: '/repo' }),
      /Zero Direct Root Mutation/
    );
  });
});

describe('Quality Gate evidence contract (issue #298)', () => {
  const PLAN_HEADER = '/repo/artifacts/plans/41-task/implementation_plan.md';

  function gateCheckpoint(configure?: (sm: any) => void): any {
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
        baseBranch: 'phase/1-bridge'
      })
    );
    if (configure) configure(sm);
    return sm;
  }

  function planWithTargets(commands: readonly string[]): string {
    return [
      '# Plan',
      '',
      '## 5. Quality Gate Targets',
      '',
      '```bash',
      ...commands,
      '```',
      ''
    ].join('\n');
  }

  function planWithSmoke(commands: readonly string[]): string {
    return [
      '# Plan',
      '',
      '## 5. Quality Gate Targets',
      '',
      '```bash',
      ...commands,
      '```',
      '',
      '## 6. Manual Smoke Test Protocol',
      '',
      '#### Check 1 — fixture require',
      '',
      '```bash',
      'node -e \'const m = require("fixture.js"); console.log(m);\'',
      '```',
      ''
    ].join('\n');
  }

  test('GNA-L1: the gate prompt carries every plan target in order and names the source', async () => {
    const commands = [
      'npm run build',
      'npm run typecheck',
      'npm run lint',
      'node --test tests/a.test.ts',
      'node --test tests/b.test.ts',
      'node --test tests/c.test.ts',
      'node --test tests/d.test.ts',
      'node --test tests/e.test.ts',
      'npm test'
    ];
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(commands);
    planGenerator.digest = 'digest-1';

    const sm = gateCheckpoint((machine: any) =>
      machine.recordApprovedPlan(PLAN_HEADER, 'digest-1')
    );
    const useCase = new GetNextActionUseCase(
      new MockStateRepo(sm.toSnapshot()),
      makeMockConfig(),
      planGenerator
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    assert.strictEqual(result.actionType, 'subagent');
    assert.ok(result.invocationPayload);
    const prompt: string = result.invocationPayload.Subagents[0].Prompt;

    let cursor = -1;
    for (const command of commands) {
      const index = prompt.indexOf(`\`${command}\``);
      assert.ok(index > cursor, `command '${command}' must appear in plan order`);
      cursor = index;
    }
    assert.match(prompt, /Command Source:\s*plan/i);
    assert.match(result.description, /source 'plan'/);
    assert.match(result.humanSummary, /source 'plan'/);
  });

  test('GNA-L2: lint is appended and reported when the plan omits it', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm run build', 'npm test']);
    planGenerator.digest = 'digest-1';

    const detector = new MockBuildDetector();
    detector.lintCommand = 'npm run lint';

    const sm = gateCheckpoint((machine: any) =>
      machine.recordApprovedPlan(PLAN_HEADER, 'digest-1')
    );
    const useCase = new GetNextActionUseCase(
      new MockStateRepo(sm.toSnapshot()),
      makeMockConfig(),
      planGenerator,
      undefined,
      undefined,
      undefined,
      detector
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    const prompt: string = result.invocationPayload.Subagents[0].Prompt;

    assert.ok(prompt.includes('npm run lint'));
    assert.ok(prompt.includes('Mandatory commands appended'));
    assert.match(prompt, /Lint Gate/);
    assert.match(prompt, /REQUIRED/);
  });

  test('GNA-C1: the prompt states the execution cwd and why it must not cd to the root', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm test']);
    planGenerator.digest = 'digest-1';

    const sm = gateCheckpoint((machine: any) =>
      machine.recordApprovedPlan(PLAN_HEADER, 'digest-1')
    );
    const useCase = new GetNextActionUseCase(
      new MockStateRepo(sm.toSnapshot()),
      makeMockConfig(),
      planGenerator
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });
    const prompt: string = result.invocationPayload.Subagents[0].Prompt;

    assert.ok(prompt.includes('### Execution Cwd'));
    assert.ok(prompt.includes('Execution Cwd: /repo/.worktrees/41'));
    assert.match(prompt, /Do not cd to the repository root/i);
    assert.ok(prompt.includes('/repo/.worktrees/41'));
  });

  test('GNA-S1: a non-executable smoke protocol blocks dispatch and names the check', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithSmoke(['npm test']);

    const sm = gateCheckpoint();
    const useCase = new GetNextActionUseCase(
      new MockStateRepo(sm.toSnapshot()),
      makeMockConfig(),
      planGenerator
    );

    const result = await useCase.execute({ workspaceDir: '/repo' });

    assert.strictEqual(result.actionType, 'human_gate');
    assert.ok(!result.invocationPayload, 'a failed protocol must not dispatch a gate');
    assert.match(result.description, /Quality Gate: FAILED/);
    assert.match(result.description, /bare-module-path/);
    assert.match(result.description, /Check 1/);
    assert.match(result.description, /plan line \d+/);
  });

  test('GNA-D1: a digest mismatch blocks dispatch and names both digests', async () => {
    const planGenerator = new MockPlanGenerator();
    planGenerator.content = planWithTargets(['npm test']);
    planGenerator.digest = 'actual-digest';

    const mismatched = gateCheckpoint((machine: any) =>
      machine.recordApprovedPlan(PLAN_HEADER, 'approved-digest')
    );
    const blocked = await new GetNextActionUseCase(
      new MockStateRepo(mismatched.toSnapshot()),
      makeMockConfig(),
      planGenerator
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(blocked.actionType, 'human_gate');
    assert.strictEqual(blocked.title, 'Plan Integrity Gate');
    assert.ok(!blocked.invocationPayload);
    assert.ok(blocked.description.includes('approved-digest'));
    assert.ok(blocked.description.includes('actual-digest'));

    const matching = gateCheckpoint((machine: any) =>
      machine.recordApprovedPlan(PLAN_HEADER, 'actual-digest')
    );
    const dispatched = await new GetNextActionUseCase(
      new MockStateRepo(matching.toSnapshot()),
      makeMockConfig(),
      planGenerator
    ).execute({ workspaceDir: '/repo' });

    assert.strictEqual(dispatched.actionType, 'subagent');
    assert.ok(dispatched.invocationPayload);
  });
});

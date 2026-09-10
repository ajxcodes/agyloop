const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  StartPlanningUseCase,
  TransitionStageUseCase,
  GetPipelineStatusUseCase,
  ResetPipelineUseCase,
  ResolveSubagentUseCase,
  ListModelsUseCase
} = require('../../dist/application');
const {
  STAGE_INITIALIZED,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  MODE_STANDARD,
  DEFAULT_GATE_TIMEOUT_SECONDS
} = require('../../dist/domain');

type StateRepository = import('../../src').StateRepository;
type StateMachineSnapshot = import('../../src').StateMachineSnapshot;
type GitHubGateway = import('../../src').GitHubGateway;
type GitHubIssueData = import('../../src').GitHubIssueData;
type ConfigRepository = import('../../src').ConfigRepository;
type AgyLoopConfig = import('../../src').AgyLoopConfig;
type PlanGeneratorPort = import('../../src').PlanGeneratorPort;
type ScaffoldParams = import('../../src').ScaffoldParams;
type ScaffoldResult = import('../../src').ScaffoldResult;
type SummaryUpdateData = import('../../src').SummaryUpdateData;
type ModelCatalogPort = import('../../src').ModelCatalogPort;
type DiscoveredModel = import('../../src').DiscoveredModel;
class MockStateRepository implements StateRepository {
  public snapshot: StateMachineSnapshot | null = null;
  public saveCallCount = 0;
  public resetCallCount = 0;

  public load(): StateMachineSnapshot | null {
    return this.snapshot;
  }

  public save(snapshot: StateMachineSnapshot): void {
    this.snapshot = snapshot;
    this.saveCallCount++;
  }

  public reset(): void {
    this.snapshot = null;
    this.resetCallCount++;
  }

  public getStateFilePath(): string {
    return '/mock/path/state.json';
  }
}

class MockGitHubGateway implements GitHubGateway {
  public issueToReturn: GitHubIssueData | null = null;

  public getCurrentRepo(): string | null {
    return 'ajxcodes/agyloop';
  }

  public fetchIssue(issueNumber: number): GitHubIssueData | null {
    if (this.issueToReturn) return this.issueToReturn;
    return {
      repo: 'ajxcodes/agyloop',
      number: issueNumber,
      title: `Issue #${issueNumber}`,
      body: 'Mock issue description',
      labels: ['feature'],
      comments: []
    };
  }
}

class MockConfigRepository implements ConfigRepository {
  public config: AgyLoopConfig = {
    models: {
      planner: 'pro',
      implementer: 'inherit',
      gate: 'flash_lite',
      reviewer: 'flash'
    },
    options: {
      commitAfter: false,
      gateTimeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
      autoApproveInYolo: true,
      enableMcpInPlanner: true
    }
  };

  public loadConfig(): AgyLoopConfig {
    return this.config;
  }

  public resolveModel(role: string) {
    return {
      role,
      configured: this.config.models[role] || 'inherit',
      tier: 'pro' as const,
      apiModel: 'gemini-2.5-pro'
    };
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  public lastScaffoldParams: ScaffoldParams | null = null;
  public summaryUpdates: SummaryUpdateData[] = [];

  public scaffoldPlanDirectory(params: ScaffoldParams): ScaffoldResult {
    this.lastScaffoldParams = params;
    return {
      planDir: '/mock/plans/1-test',
      folderName: '1-test',
      type: 'implementation',
      planPath: '/mock/plans/1-test/[Implementation] - Test.md',
      mirrorPath: '/mock/plans/1-test/implementation_plan.md',
      summaryPath: '/mock/plans/1-test/AgyLoop Summary.md'
    };
  }

  public generatePlan() {
    return { planPath: '', mirrorPath: null, content: '', created: true };
  }

  public generateSummaryLog() {
    return { summaryPath: '', content: '', created: true };
  }

  public updateSummaryLog(_file: string, data: SummaryUpdateData): boolean {
    this.summaryUpdates.push(data);
    return true;
  }

  public findPlanDirectory(): string | null {
    return '/mock/plans/1-test';
  }
}

class MockModelCatalog implements ModelCatalogPort {
  public async fetchModels(): Promise<readonly DiscoveredModel[]> {
    return [
      {
        id: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        description: 'Pro model',
        tier: 'pro'
      }
    ];
  }
}

describe('Application Layer Use Cases (with Mock Adapters)', () => {
  test('StartPlanningUseCase coordinates discovery, scaffolding, transitions to APPROVAL and saves state', async () => {
    const stateRepo = new MockStateRepository();
    const github = new MockGitHubGateway();
    const config = new MockConfigRepository();
    const planGen = new MockPlanGenerator();

    const useCase = new StartPlanningUseCase(stateRepo, github, config, planGen);
    const result = await useCase.execute({
      issue: 42,
      title: 'Build Payment Gateway'
    });

    assert.strictEqual(result.stateMachine.currentStage, STAGE_APPROVAL);
    assert.strictEqual(result.stateMachine.issue, 42);
    assert.strictEqual(stateRepo.saveCallCount, 1);
    assert.strictEqual(stateRepo.snapshot?.currentStage, STAGE_APPROVAL);
    assert.strictEqual(planGen.lastScaffoldParams?.issue, 42);
    assert.strictEqual(planGen.summaryUpdates.length, 2);
  });

  test('TransitionStageUseCase advances stage and persists snapshot', async () => {
    const stateRepo = new MockStateRepository();
    const transitionUseCase = new TransitionStageUseCase(stateRepo);

    const sm1 = await transitionUseCase.execute({
      targetStage: 'DISCOVERY',
      mode: MODE_STANDARD
    });
    assert.strictEqual(sm1.currentStage, 'DISCOVERY');
    assert.strictEqual(stateRepo.saveCallCount, 1);

    const sm2 = await transitionUseCase.execute({
      targetStage: 'PLAN'
    });
    assert.strictEqual(sm2.currentStage, 'PLAN');
    assert.strictEqual(stateRepo.saveCallCount, 2);
  });

  test('GetPipelineStatusUseCase retrieves state and history from repository', async () => {
    const stateRepo = new MockStateRepository();
    const getStatusUseCase = new GetPipelineStatusUseCase(stateRepo);

    const result = await getStatusUseCase.execute();
    assert.strictEqual(result.status.currentStage, STAGE_INITIALIZED);
    assert.strictEqual(result.history.length, 1);
    assert.strictEqual(result.stateFilePath, '/mock/path/state.json');
  });

  test('ResetPipelineUseCase clears state repository and returns fresh initial state', async () => {
    const stateRepo = new MockStateRepository();
    stateRepo.snapshot = {
      version: '1.0.0',
      currentStage: STAGE_QUALITY_GATE,
      mode: MODE_STANDARD,
      issue: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: []
    };

    const resetUseCase = new ResetPipelineUseCase(stateRepo);
    const sm = await resetUseCase.execute();

    assert.strictEqual(sm.currentStage, STAGE_INITIALIZED);
    assert.strictEqual(stateRepo.snapshot, null);
    assert.strictEqual(stateRepo.resetCallCount, 1);
  });

  test('ResolveSubagentUseCase resolves subagent definition with safety invariants', () => {
    const configRepo = new MockConfigRepository();
    const resolveUseCase = new ResolveSubagentUseCase(configRepo);

    const def = resolveUseCase.execute({ role: 'planner' });
    assert.strictEqual(def.name, 'planner');
    assert.strictEqual(def.capabilities.enable_write_tools, false);
    assert.strictEqual(def.capabilities.enable_subagent_tools, false);
    assert.strictEqual(def.tools.includes('view_file'), true);
    assert.strictEqual(def.tools.includes('run_command'), false);
  });

  test('ListModelsUseCase fetches candidate models via ModelCatalogPort', async () => {
    const modelCatalog = new MockModelCatalog();
    const listUseCase = new ListModelsUseCase(modelCatalog);

    const models = await listUseCase.execute();
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].id, 'gemini-2.5-pro');
    assert.strictEqual(models[0].tier, 'pro');
  });
});
